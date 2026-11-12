//! ChiaHub lane — the chain-independent half: record types, canonical signing,
//! room-key-derived encryption, epoch-rotated lookup hints and a startup
//! self-test. All of it runs and is unit-tested without touching a network.
//!
//! Two record generations live here. v1 (JSON, sealed under a ROOM key, daily
//! epoch hints) is what #238 shipped and stays readable for two eras. v2
//! (#231 P6a, the fixed-layout block below) is sealed under a per-NODE contact
//! key and filed by the chain's own clock, the seven-day era; the node's
//! presence moved there, and the room-keyed publish is retired: since stage 4
//! PR 12 nothing here writes a v1 record, on any network.
//!
//! The chain IO lives next door: `chia_resolve` (the generic hint reader, on by
//! default since #231 D3), `chia_watch` (the P1 beat/hold watcher), `chia_rooms`
//! (the per-room `cap` plumbing with the N8 public-room guard) and, behind the
//! `chia-publish` feature, `chia_wallet` + `chia_publish` (spend-to-self with
//! `[hint, ciphertext]` memos). Plan of record: issue #231 (phases P0–P10).

use anyhow::{anyhow, Result};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

use crate::chia_network::ChiaNet;

/// A member's presence record — the plaintext that gets signed, sealed, and
/// (in C1) published as coin-spend memos. Addresses come from the LIVE
/// endpoint view (v0.17.0 F3 rule: hints are live data, not constants).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ChiaPresenceRecord {
    pub v: u32,
    pub node_id: String,
    pub addrs: Vec<String>,
    pub relay_urls: Vec<String>,
    /// Unix seconds. `expires_at` is advisory — the chain cannot delete, so
    /// readers enforce freshness; writers heartbeat (~30–60 min) and on change.
    pub issued_at: u64,
    pub expires_at: u64,
    /// Record v2 (#231 P6a): the node's X25519 key for the record's era, hex —
    /// what a P6b knock is sealed to. Absent on v1 room-keyed records (and
    /// skipped when serializing, so v1 bytes are unchanged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kx_pk: Option<String>,
    /// Record v2: one flags byte per entry of `addrs` ([`FLAG_INBOUND_VERIFIED`]
    /// is bit 0). Empty on v1 records.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub addr_flags: Vec<u8>,
}

/// Signed wrapper as serialized inside the ciphertext.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignedRecord {
    /// Canonical JSON bytes of [`ChiaPresenceRecord`], base64.
    pub record_b64: String,
    /// ed25519 signature by the record's `node_id` key, hex.
    pub sig_hex: String,
}

/// Domain-separated key derivations — "the room is the key" extended to the
/// chain (ChiaHub review §3.2). Contexts are versioned; bumping them is a
/// lane-wide epoch break by design.
const CTX_ENC: &str = "ssf-chia-lane-enc-v1";
const CTX_HINT: &str = "ssf-chia-lane-hint-v1";

pub fn derive_enc_key(room_key: &[u8]) -> [u8; 32] {
    blake3::derive_key(CTX_ENC, room_key)
}

/// Epoch = UTC day number. Readers scan `epoch` and `epoch - 1` so records
/// straddling midnight stay findable; daily rotation stops a passive observer
/// who learned one day's hint from following the room forever.
pub fn epoch_now(unix_seconds: u64) -> u64 {
    unix_seconds / 86_400
}

/// 32-byte lookup hint for a room + epoch: what C1 puts first in the memo
/// list (ecosystem hint convention) and queries by.
pub fn derive_hint(room_key: &[u8], epoch: u64) -> [u8; 32] {
    let mut material = Vec::with_capacity(room_key.len() + 8);
    material.extend_from_slice(room_key);
    material.extend_from_slice(&epoch.to_le_bytes());
    blake3::derive_key(CTX_HINT, &material)
}

/// Sign a presence record with the node's iroh key and produce the plaintext
/// blob that gets sealed. (Same ed25519 identity as the swarm — one keypair.)
pub fn encode_signed(record: &ChiaPresenceRecord, secret: &iroh::SecretKey) -> Result<Vec<u8>> {
    let record_json = serde_json::to_vec(record)?;
    let sig = secret.sign(&record_json);
    let wrapper = SignedRecord {
        record_b64: base64::Engine::encode(&base64::prelude::BASE64_STANDARD, &record_json),
        sig_hex: hex::encode(sig.to_bytes()),
    };
    Ok(serde_json::to_vec(&wrapper)?)
}

/// Verify + decode the plaintext blob back into a record. Records signed by
/// keys the reader doesn't recognize as room members are the caller's problem
/// to filter — signature validity alone is not membership.
pub fn decode_signed(blob: &[u8]) -> Result<ChiaPresenceRecord> {
    let wrapper: SignedRecord = serde_json::from_slice(blob)?;
    let record_json = base64::Engine::decode(&base64::prelude::BASE64_STANDARD, &wrapper.record_b64)?;
    let record: ChiaPresenceRecord = serde_json::from_slice(&record_json)?;
    let public: iroh::PublicKey = record
        .node_id
        .parse()
        .map_err(|e| anyhow!("record node_id is not a valid iroh key: {e:?}"))?;
    let sig_bytes: [u8; 64] = hex::decode(&wrapper.sig_hex)?
        .try_into()
        .map_err(|_| anyhow!("signature is not 64 bytes"))?;
    let sig = iroh::Signature::from_bytes(&sig_bytes);
    public
        .verify(&record_json, &sig)
        .map_err(|e| anyhow!("record signature invalid: {e:?}"))?;
    Ok(record)
}

/// Seal a signed blob for the chain: `[24B XNonce ‖ XChaCha20-Poly1305 ciphertext]`.
/// Only room-key holders can read — an unreadable record stays meaningless
/// even though the chain keeps it forever (ChiaHub review §7 rule 1).
pub fn seal(room_key: &[u8], plaintext: &[u8]) -> Result<Vec<u8>> {
    let key = derive_enc_key(room_key);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), plaintext)
        .map_err(|e| anyhow!("seal failed: {e:?}"))?;
    let mut out = Vec::with_capacity(24 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn open(room_key: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < 24 {
        return Err(anyhow!("sealed blob too short"));
    }
    let key = derive_enc_key(room_key);
    let cipher = XChaCha20Poly1305::new((&key).into());
    cipher
        .decrypt(XNonce::from_slice(&sealed[..24]), &sealed[24..])
        .map_err(|e| anyhow!("open failed (wrong room key?): {e:?}"))
}

/// Startup self-test + status line. Proves the lane's crypto machinery on a
/// throwaway key and says what THIS build does with the chain: reads are on by
/// default (#231 D3, `SSF_CHIA_WATCH=0` turns the watcher off), publishing waits
/// for the SSF wallet (`wallet_on`: it loaded at this start, after the Bank's
/// switch or `SSF_CHIA_LANE=1` turned it on, chia_wallet_switch.rs) and a
/// build with the `chia-publish` feature, and the player's LIST ME for the
/// network (`listed`, chia_listing.rs: off where the coins are real money
/// until the player turns it on, stage 4 design §4.5 (6)). With LIST ME off
/// publishing is off whatever the wallet does, and the line says so. While
/// Chia is off at the start (`off` names what holds it off, chia_strict.rs)
/// reads and publishing are both off, and the line says why on every
/// network.
pub fn startup_status(
    secret: &iroh::SecretKey,
    live_addrs: &[String],
    wallet_on: bool,
    listed: bool,
    off: Option<crate::chia_strict::OffSource>,
) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let test_room_key = [7u8; 32];
    let record = ChiaPresenceRecord {
            kx_pk: None,
            addr_flags: vec![],
        v: 1,
        node_id: secret.public().to_string(),
        addrs: live_addrs.to_vec(),
        relay_urls: vec![],
        issued_at: now,
        expires_at: now + 3600,
    };
    let ok = encode_signed(&record, secret)
        .and_then(|blob| seal(&test_room_key, &blob))
        .and_then(|sealed| open(&test_room_key, &sealed))
        .and_then(|blob| decode_signed(&blob))
        .map(|round| round == record)
        .unwrap_or(false);
    let reads = match off {
        _ if !cfg!(feature = "chia-read") => "not built".to_string(),
        Some(source) => strict_status(source),
        None if std::env::var("SSF_CHIA_WATCH").ok().as_deref() == Some("0") => {
            "rung-6 only (watcher off: SSF_CHIA_WATCH=0)".to_string()
        }
        None => "on (rung-6 resolve + beat watcher)".to_string(),
    };
    let publish = match off {
        Some(source) if cfg!(feature = "chia-publish") => strict_status(source),
        _ => publish_status(cfg!(feature = "chia-publish"), listed, wallet_on, crate::chia_wallet_switch::env_switch()).to_string(),
    };
    println!(
        "⛓️ ChiaHub lane: crypto self-test {} · chain reads {reads} · publishing {publish}",
        if ok { "PASSED" } else { "FAILED" },
    );
}

/// The startup line's word on reads and on publishing while Chia is off,
/// with what holds it off (`source`).
fn strict_status(source: crate::chia_strict::OffSource) -> String {
    format!("off ({}: {})", crate::chia_strict::OFF_WORDS, crate::chia_strict::source_words(source))
}

/// The startup line's word on publishing: whether this build can, whether
/// LIST ME is on for this network (`listed`, chia_listing.rs), whether the
/// SSF wallet loaded, and what holds it off. With LIST ME off, turning the
/// wallet on in the Bank publishes nothing either, so the line sends no one
/// there: it names the switch, and what is not written while it is off, the
/// listing and the knocks (stage 4 design §4.5 (6)). It does not say the
/// lane only reads then: a beacon the operator turned on is written from a
/// key of its own. Who pays is not this line's: the lobby dish does, on
/// every network (stage 4 design §13 row 12).
pub fn publish_status(built: bool, listed: bool, wallet_on: bool, env: crate::chia_wallet_switch::EnvSwitch) -> &'static str {
    if !built {
        "not built"
    } else if wallet_on && listed {
        "on (the SSF wallet is on)"
    } else if env == crate::chia_wallet_switch::EnvSwitch::Off {
        "off (SSF_CHIA_LANE holds the SSF wallet off)"
    } else if !listed {
        "off (LIST ME is off for this network: no listing or knock is written until it is turned on in the SpacePhone's Network settings)"
    } else {
        "off until the SSF wallet is turned on in the SpacePhone's Bank (a headless node: start it with SSF_CHIA_LANE=1)"
    }
}

// ── #231 P6a: RECORD v2 — the per-node presence record ──────────────────────
//
// The NODE, not the room, is the unit on chain (second and third follow-ups on
// #231). A node is found by its CONTACT KEY `ck`: 32 random bytes that live in
// `contact.key` beside the iroh key and travel only as a node-signed contact
// card over the signed control plane (`chia_contact`), never in a room doc or
// a pass. Every record is filed under a hint derived from `ck` and the ERA it
// was written in; the chain is the clock:
//
//     era  = confirmation height / ERA_BLOCKS           (seven days of blocks)
//     hint = blake3::derive_key("ssf-chia-ck-hint-v1", ck ‖ era_le)        testnet11
//     hint = blake3::derive_key("ssf-chia-ck-hint-v1", ck ‖ era_le ‖ G)    mainnet
//
// G is mainnet's genesis challenge, the network tag of stage 4 design §3.5
// ([`network_tag`]): without it the same contact key would give the same hint
// bytes on both chains once their era numbers meet, and anyone could match a
// node's listings across them. testnet11 has no tag, so its bytes are the ones
// it always had.
//
// Readers scan the current era and the one before. A record is VALID only if
// the block that confirmed it lies inside the era it is filed under, so a hint
// pre-filled for a future era, or an old ciphertext replayed later, is
// worthless. Kind and era are SIGNED into every record (a presence record
// cannot be re-filed as a knock, nor under another era), the layout is FIXED
// at [`RECORD_V2_LEN`] bytes (one size class: no length leaks what a record
// holds), and the sealed blob binds kind ‖ era, and G on mainnet, as
// associated data, so a blob does not open on the other network either.
// Nothing on chain is keyed by a room.
//
// Three kinds share the header. The presence codec is P6a's; the knock (joiner
// → host inbox, sealed to the host's card key) and the opt-in beacon (D7) are
// P6b's, further down in this file.

/// Blocks per era: seven days at testnet11's ~18.75 s block time.
pub const ERA_BLOCKS: u32 = 32_256;
/// An era's length in seconds, for the time-based fallbacks (`expires_at`,
/// an inbound-verified mark taken while the chain peak was unknown).
pub const ERA_SECS: u64 = 7 * 24 * 3600;
/// Record kinds, signed into the header. Knock and beacon are P6b's; their
/// values are fixed here so no later record can collide with presence.
pub const KIND_PRESENCE: u8 = 1;
pub const KIND_KNOCK: u8 = 2;
pub const KIND_BEACON: u8 = 3;
/// The fixed plaintext size of every v2 record.
pub const RECORD_V2_LEN: usize = 320;
/// Addresses a presence record carries (public only, each with a flags byte).
pub const MAX_V2_ADDRS: usize = 8;
/// Per-address flags, bit 0: this node ACCEPTED an unsolicited direct
/// connection from a non-LAN peer on this address family during this era.
/// Measured, never declared (see `chia_contact::InboundVerified`).
pub const FLAG_INBOUND_VERIFIED: u8 = 0b0000_0001;

const RECORD_V2_VERSION: u8 = 2;
const CTX_CK_HINT: &str = "ssf-chia-ck-hint-v1";
const CTX_CK_ENC: &str = "ssf-chia-ck-enc-v1";
const V2_AAD_PREFIX: &[u8] = b"ssf-chia-record-v2";
// Fixed layout offsets (little-endian integers).
const OFF_VERSION: usize = 0;
const OFF_KIND: usize = 1;
const OFF_ERA: usize = 2;
const OFF_NODE_ID: usize = 10;
const OFF_KX_PK: usize = 42;
const OFF_ISSUED_AT: usize = 74;
const OFF_EXPIRES_AT: usize = 82;
const OFF_ADDR_COUNT: usize = 90;
const OFF_ADDRS: usize = 91;
const ADDR_SLOT_LEN: usize = 20;
const OFF_RESERVED: usize = OFF_ADDRS + MAX_V2_ADDRS * ADDR_SLOT_LEN; // 251
const OFF_SIG: usize = 256;

/// The era a block height belongs to.
pub fn era_of(height: u32) -> u64 {
    (height / ERA_BLOCKS) as u64
}

/// ⛓️ What a network adds to the lane's hints and associated data, and to
/// the dish's room tag (`chia_faucet::FaucetParams::for_room`): the network
/// tag of stage 4 design §3.5. testnet11 adds nothing, so every hint, AAD,
/// sealed record and dish address there stays byte for byte what it was
/// before the tag (`network_tag_tests` pins them to vectors origin/main's
/// own code produced). Mainnet adds its genesis challenge G
/// ([`ChiaNet::genesis`]), appended last, so the same contact key in the
/// same era gives unrelated hints on the two chains, and a keyless observer
/// cannot match a node's listings across them once their era numbers meet
/// (§2, the "testnet11 and mainnet" row; §7 item 13).
///
/// A match on each network, never on `is_test`: a network added later has
/// to choose its own tag here, where a test-network rule could hand it
/// testnet11's bytes and join the two.
///
/// Mainnet's bytes change with no migration: mainnet has no reader of the
/// lane yet, no lobby coin, and no SSF write (the SSF wallet pays for no
/// memo spend off a test network, `chia_publish::money_memo_refusal`, #371),
/// so nothing filed under the untagged bytes is left behind (§3.5, "Why
/// now"; §14 item 7).
pub fn network_tag(net: ChiaNet) -> Option<[u8; 32]> {
    match net {
        ChiaNet::Testnet11 => None,
        ChiaNet::Mainnet => Some(ChiaNet::Mainnet.genesis()),
    }
}

/// Append `net`'s tag ([`network_tag`]) to a hint's material or to an AAD.
/// Every field before it is fixed width (a 32-byte key, lane token or
/// parent, a 1-byte kind, an 8-byte era) and the tag is 32 bytes, appended
/// last, so within one network the bytes fix every field, and across the
/// two networks a material differs in length: no two inputs share bytes.
fn push_network_tag(net: ChiaNet, material: &mut Vec<u8>) {
    if let Some(g) = network_tag(net) {
        material.extend_from_slice(&g);
    }
}

/// Lookup hint for a contact key in an era on `net`: ck ‖ era_le, and the
/// network's tag on mainnet (§3.5), under `ssf-chia-ck-hint-v1`.
pub fn derive_ck_hint(net: ChiaNet, ck: &[u8; 32], era: u64) -> [u8; 32] {
    let mut material = Vec::with_capacity(32 + 8 + 32);
    material.extend_from_slice(ck);
    material.extend_from_slice(&era.to_le_bytes());
    push_network_tag(net, &mut material);
    blake3::derive_key(CTX_CK_HINT, &material)
}

/// The sealing key for a contact key: whoever holds `ck` reads the records
/// under it, nobody else. The same on every network: the network is bound
/// by the associated data instead ([`v2_aad`]).
pub fn derive_ck_enc_key(ck: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key(CTX_CK_ENC, ck)
}

/// The associated data of a v2 blob on `net`: the record prefix, kind ‖ era,
/// and the network's tag on mainnet (§3.5), so a blob sealed on one network
/// does not open on the other. [`kx_aad`] extends it, so both seals bind the
/// network.
fn v2_aad(net: ChiaNet, kind: u8, era: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(V2_AAD_PREFIX.len() + 9 + 32);
    aad.extend_from_slice(V2_AAD_PREFIX);
    aad.push(kind);
    aad.extend_from_slice(&era.to_le_bytes());
    push_network_tag(net, &mut aad);
    aad
}

/// The associated data of a blob sealed to a key: [`v2_aad`] (kind ‖ era, and
/// the network's tag on mainnet), then the PARENT of the coin that carries
/// it — the writer's input coin, known before the spend is built. A blob
/// copied under another coin (anyone who saw it on chain can re-issue the
/// same hint and memo) has another parent and does not open, so a knock
/// cannot be replayed into a second clock or a second inbox entry (#272
/// review round 3). And `lane`, the room's SECRET lane token
/// ([`derive_lane_token`], from the room key): the hint is public on chain and
/// the host's card key rides in every room's pass, so without it anyone holding
/// the host's card from another room could seal fresh knocks of its own under
/// an observed hint; with it a knock opens only for a writer who held the room
/// key (#272 review round 5).
#[cfg(feature = "chia-read")]
fn kx_aad(net: ChiaNet, kind: u8, era: u64, carrier_parent: &[u8; 32], lane: &[u8; 32]) -> Vec<u8> {
    let mut aad = v2_aad(net, kind, era);
    aad.extend_from_slice(carrier_parent);
    aad.extend_from_slice(lane);
    aad
}

/// Seal a v2 plaintext under `ck` for `kind` in `era` on `net`:
/// `[24B XNonce ‖ XChaCha20-Poly1305 ciphertext]`, [`v2_aad`] (kind ‖ era, and
/// the network's tag on mainnet) as associated data.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read-only build never seals
pub fn seal_v2(net: ChiaNet, ck: &[u8; 32], kind: u8, era: u64, plaintext: &[u8]) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::Payload;
    let key = derive_ck_enc_key(ck);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let aad = v2_aad(net, kind, era);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
        .map_err(|e| anyhow!("seal_v2 failed: {e:?}"))?;
    let mut out = Vec::with_capacity(24 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a v2 blob sealed under `ck` for `kind` in `era` on `net`. Fails on a
/// wrong key, a tampered blob, or a blob sealed for another kind, era or
/// network.
pub fn open_v2(net: ChiaNet, ck: &[u8; 32], kind: u8, era: u64, sealed: &[u8]) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::Payload;
    if sealed.len() < 24 {
        return Err(anyhow!("sealed v2 blob too short"));
    }
    let key = derive_ck_enc_key(ck);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let aad = v2_aad(net, kind, era);
    cipher
        .decrypt(XNonce::from_slice(&sealed[..24]), Payload { msg: &sealed[24..], aad: &aad })
        .map_err(|e| anyhow!("open_v2 failed (wrong contact key, kind, era or network?): {e:?}"))
}

/// One dialable address in a presence record: public only, with its flags byte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AddrEntry {
    pub addr: std::net::SocketAddr,
    pub flags: u8,
}

/// Canonical order for the address list: IPv6 first (the path that needs no
/// punch), then by address and port. The publisher sorts so that the same set
/// always signs to the same bytes (the "did my addresses change" test).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn sort_addr_entries(entries: &mut Vec<AddrEntry>) {
    entries.sort_by_key(|e| (e.addr.is_ipv4(), e.addr.ip(), e.addr.port(), e.flags));
    entries.dedup_by_key(|e| e.addr);
}

/// Write one address into its 20-byte slot: family, address, port, flags.
/// The slot is zero before the call, so an IPv4 address leaves the rest of
/// the address field zero (the canonical form [`read_addr_slot`] asks for).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
fn write_addr_slot(slot: &mut [u8], addr: &std::net::SocketAddr, flags: u8) {
    match addr.ip() {
        std::net::IpAddr::V4(v4) => {
            slot[0] = 4;
            slot[1..5].copy_from_slice(&v4.octets());
        }
        std::net::IpAddr::V6(v6) => {
            slot[0] = 6;
            slot[1..17].copy_from_slice(&v6.octets());
        }
    }
    slot[17..19].copy_from_slice(&addr.port().to_le_bytes());
    slot[19] = flags;
}

/// Read address slot `i` back: an unknown family and an IPv4 slot with bytes
/// set past its four octets are refused.
fn read_addr_slot(slot: &[u8], i: usize) -> Result<AddrEntry> {
    let port = u16::from_le_bytes([slot[17], slot[18]]);
    let ip: std::net::IpAddr = match slot[0] {
        4 => {
            if slot[5..17].iter().any(|&b| b != 0) {
                return Err(anyhow!("record IPv4 slot {i} is not canonical"));
            }
            std::net::Ipv4Addr::new(slot[1], slot[2], slot[3], slot[4]).into()
        }
        6 => std::net::Ipv6Addr::from(<[u8; 16]>::try_from(&slot[1..17]).unwrap()).into(),
        other => return Err(anyhow!("record address slot {i} has family {other}")),
    };
    Ok(AddrEntry { addr: std::net::SocketAddr::new(ip, port), flags: slot[19] })
}

/// The per-node presence record (kind 1): who, which era, the per-era key a
/// knock is sealed to, when, and up to eight public addresses with flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresenceV2 {
    pub era: u64,
    pub node_id: iroh::PublicKey,
    /// The node's X25519 key for this era (P6b seals knocks to it).
    pub kx_pk: [u8; 32],
    pub issued_at: u64,
    pub expires_at: u64,
    pub addrs: Vec<AddrEntry>,
}

impl PresenceV2 {
    /// The reader-side shape every consumer already speaks (watcher, planner,
    /// rung-6 dial): v1's record struct with the v2-only fields filled in.
    pub fn to_record(&self) -> ChiaPresenceRecord {
        ChiaPresenceRecord {
            v: 2,
            node_id: self.node_id.to_string(),
            addrs: self.addrs.iter().map(|e| e.addr.to_string()).collect(),
            relay_urls: vec![],
            issued_at: self.issued_at,
            expires_at: self.expires_at,
            kx_pk: Some(hex::encode(self.kx_pk)),
            addr_flags: self.addrs.iter().map(|e| e.flags).collect(),
        }
    }
}

/// Encode + sign a presence record into its fixed 320-byte plaintext. The
/// signature (by the record's own node key) covers every byte before it.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn encode_presence_v2(record: &PresenceV2, secret: &iroh::SecretKey) -> Result<[u8; RECORD_V2_LEN]> {
    if record.node_id != secret.public() {
        return Err(anyhow!("presence record node_id is not the signing key"));
    }
    if record.addrs.len() > MAX_V2_ADDRS {
        return Err(anyhow!("presence record carries {} addresses, max {MAX_V2_ADDRS}", record.addrs.len()));
    }
    let mut buf = [0u8; RECORD_V2_LEN];
    buf[OFF_VERSION] = RECORD_V2_VERSION;
    buf[OFF_KIND] = KIND_PRESENCE;
    buf[OFF_ERA..OFF_ERA + 8].copy_from_slice(&record.era.to_le_bytes());
    buf[OFF_NODE_ID..OFF_NODE_ID + 32].copy_from_slice(record.node_id.as_bytes());
    buf[OFF_KX_PK..OFF_KX_PK + 32].copy_from_slice(&record.kx_pk);
    buf[OFF_ISSUED_AT..OFF_ISSUED_AT + 8].copy_from_slice(&record.issued_at.to_le_bytes());
    buf[OFF_EXPIRES_AT..OFF_EXPIRES_AT + 8].copy_from_slice(&record.expires_at.to_le_bytes());
    buf[OFF_ADDR_COUNT] = record.addrs.len() as u8;
    for (i, entry) in record.addrs.iter().enumerate() {
        write_addr_slot(&mut buf[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN], &entry.addr, entry.flags);
    }
    let sig = secret.sign(&buf[..OFF_SIG]);
    buf[OFF_SIG..].copy_from_slice(&sig.to_bytes());
    Ok(buf)
}

/// Decode + verify a presence plaintext read under `expected_era`'s hint.
/// Rejects any other length, version, kind or era, a non-canonical body
/// (unused slots or reserved bytes not zero) and a bad signature. Freshness
/// (issued/expires against the clock) and the confirmation-height rule are the
/// reader's job (`chia_resolve::decode_v2_presence`).
pub fn decode_presence_v2(bytes: &[u8], expected_era: u64) -> Result<PresenceV2> {
    if bytes.len() != RECORD_V2_LEN {
        return Err(anyhow!("v2 record is {} bytes, expected {RECORD_V2_LEN}", bytes.len()));
    }
    if bytes[OFF_VERSION] != RECORD_V2_VERSION {
        return Err(anyhow!("v2 record version {} unsupported", bytes[OFF_VERSION]));
    }
    if bytes[OFF_KIND] != KIND_PRESENCE {
        return Err(anyhow!("record kind {} is not presence", bytes[OFF_KIND]));
    }
    let era = u64::from_le_bytes(bytes[OFF_ERA..OFF_ERA + 8].try_into().unwrap());
    if era != expected_era {
        return Err(anyhow!("record signed for era {era}, read under era {expected_era}"));
    }
    let node_bytes: [u8; 32] = bytes[OFF_NODE_ID..OFF_NODE_ID + 32].try_into().unwrap();
    let node_id = iroh::PublicKey::from_bytes(&node_bytes).map_err(|e| anyhow!("record node_id invalid: {e:?}"))?;
    let sig_bytes: [u8; 64] = bytes[OFF_SIG..].try_into().unwrap();
    node_id
        .verify(&bytes[..OFF_SIG], &iroh::Signature::from_bytes(&sig_bytes))
        .map_err(|e| anyhow!("record signature invalid: {e:?}"))?;
    let count = bytes[OFF_ADDR_COUNT] as usize;
    if count > MAX_V2_ADDRS {
        return Err(anyhow!("record lists {count} addresses, max {MAX_V2_ADDRS}"));
    }
    if bytes[OFF_ADDRS + count * ADDR_SLOT_LEN..OFF_RESERVED].iter().any(|&b| b != 0) {
        return Err(anyhow!("record body is not canonical (unused address slots set)"));
    }
    if bytes[OFF_RESERVED..OFF_SIG].iter().any(|&b| b != 0) {
        return Err(anyhow!("record body is not canonical (reserved bytes set)"));
    }
    let mut addrs = Vec::with_capacity(count);
    for i in 0..count {
        addrs.push(read_addr_slot(&bytes[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN], i)?);
    }
    Ok(PresenceV2 {
        era,
        node_id,
        kx_pk: bytes[OFF_KX_PK..OFF_KX_PK + 32].try_into().unwrap(),
        issued_at: u64::from_le_bytes(bytes[OFF_ISSUED_AT..OFF_ISSUED_AT + 8].try_into().unwrap()),
        expires_at: u64::from_le_bytes(bytes[OFF_EXPIRES_AT..OFF_EXPIRES_AT + 8].try_into().unwrap()),
        addrs,
    })
}

// ── #231 P6b: the knock (kind 2) and the beacon (kind 3) ────────────────────
//
// KNOCK — a joiner J that exhausted every dial to a host H whose contact card
// it holds writes ONE record into H's inbox: filed under
// `blake3("ssf-chia-inbox-hint-v1", ck_H ‖ lane ‖ era)`, with G appended on
// mainnet (the network tag, [`network_tag`]), where the LANE is
// derived from the room key J and H share ([`derive_lane_token`]), so a knock
// takes both H's card and membership of one of H's rooms; a leaked pass floods
// that one lane, and H keeps reading its other rooms' lanes (the third
// follow-up on #231 wrote "per issued pass"; P6b makes it per room, which needs
// no change to the card). The plaintext is SIGNED by J and then SEALED to H's
// long-term card key `kx_pk` ([`seal_to_kx`]): every holder of `ck_H` can find
// the hint, only H can read who knocked and for which rooms. Room ids ride
// inside the ciphertext as 16-byte lane ids ([`room_lane_id`]), never in the
// hint — nothing on chain is keyed by a room. J's own contact key rides along
// (the slot presence uses for `kx_pk`) where J's card may be handed out, so H
// can read J's presence; zeros otherwise. J's public addresses as the knock
// is written ride along too, in the address slots the rooms leave free (the
// REPLY addresses): a J on its first visit hands out no contact key (it
// cannot yet know the room is private), and without them H had only J's node
// id and the DHT to dial back by. They are inside the seal, so only H reads
// them, and they tell H what J's own dial to H shows it anyway.
//
// Both sides then rendezvous on the knock's CONFIRMATION HEIGHT, the one
// clock they share without talking (`chia_knock::rendezvous_due`).
//
// BEACON — an opt-in public entry point (D7) writes one record per era, in
// the CLEAR, under `blake3("ssf-chia-beacon-hint-v1", era)`, with G appended
// on mainnet: its node id and nothing else (no address, no key), while its
// own inbound bit is set. A newcomer with nobody to dial reads the newest
// beacons and dials them by node id for the welcome room. Beacons spend from
// a wallet key of their own, so a clear node id never shares coin lineage
// with a sealed record. The tag gives each network its own beacon hint; the
// node id in the clear is the same on any chain a node beacons on (stage 4
// design §7 item 13).

const CTX_INBOX_LANE: &str = "ssf-chia-inbox-lane-v1";
const CTX_INBOX_HINT: &str = "ssf-chia-inbox-hint-v1";
const CTX_BEACON_HINT: &str = "ssf-chia-beacon-hint-v1";
const CTX_KNOCK_ROOM: &str = "ssf-chia-knock-room-v1";
#[cfg(feature = "chia-read")] // the X25519 seal needs the curve the read build brings
const CTX_KNOCK_SEAL: &str = "ssf-chia-knock-seal-v1";
/// Rooms one knock may name (the address slots of the shared layout).
pub const MAX_KNOCK_ROOMS: usize = MAX_V2_ADDRS;
/// Reply addresses a knock for one room may carry: the slots that room
/// leaves free. A knock's rooms and reply addresses share the eight slots.
pub const MAX_KNOCK_REPLY_ADDRS: usize = MAX_V2_ADDRS - 1;
/// A knock's count byte: the number of rooms in its low four bits, the number
/// of reply addresses above them. A knock with no reply address is byte for
/// byte what it was before the reply addresses existed.
const KNOCK_ROOMS_MASK: usize = 0x0F;
const KNOCK_REPLY_SHIFT: u32 = 4;
/// A room's lane id inside a knock: the first bytes of a keyed hash of its id.
pub const ROOM_LANE_ID_LEN: usize = 16;

/// The inbox lane of a room: what a knocker needs besides the host's card.
pub fn derive_lane_token(room_key: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key(CTX_INBOX_LANE, room_key)
}

/// A host's inbox hint for one lane in one era on `net`: ck_host ‖ lane ‖
/// era_le, and the network's tag on mainnet (§3.5), under
/// `ssf-chia-inbox-hint-v1`.
pub fn derive_inbox_hint(net: ChiaNet, ck_host: &[u8; 32], lane: &[u8; 32], era: u64) -> [u8; 32] {
    let mut material = Vec::with_capacity(32 + 32 + 8 + 32);
    material.extend_from_slice(ck_host);
    material.extend_from_slice(lane);
    material.extend_from_slice(&era.to_le_bytes());
    push_network_tag(net, &mut material);
    blake3::derive_key(CTX_INBOX_HINT, &material)
}

/// The public beacon hint of an era on `net`: era_le, and the network's tag
/// on mainnet (§3.5), under `ssf-chia-beacon-hint-v1`. Derivable by anyone,
/// so it is only ever read additively behind a pass's own hints.
pub fn derive_beacon_hint(net: ChiaNet, era: u64) -> [u8; 32] {
    let mut material = Vec::with_capacity(8 + 32);
    material.extend_from_slice(&era.to_le_bytes());
    push_network_tag(net, &mut material);
    blake3::derive_key(CTX_BEACON_HINT, &material)
}

/// How a knock names a room without writing its id: a keyed hash, truncated.
/// The host compares against the rooms it holds; nobody else learns anything.
pub fn room_lane_id(room_id: &str) -> [u8; ROOM_LANE_ID_LEN] {
    let full = blake3::derive_key(CTX_KNOCK_ROOM, room_id.as_bytes());
    full[..ROOM_LANE_ID_LEN].try_into().unwrap()
}

/// The knock (kind 2): who knocked, in which era, for which of the host's
/// rooms, with the knocker's own contact key when it is findable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnockV2 {
    pub era: u64,
    pub from: iroh::PublicKey,
    /// The knocker's contact key, so the host can read its presence and dial
    /// it there; `None` when the knocker is not findable (the host dials by
    /// node id alone).
    pub ck_from: Option<[u8; 32]>,
    pub issued_at: u64,
    pub expires_at: u64,
    /// Lane ids of the rooms the knocker wants in, at most [`MAX_KNOCK_ROOMS`].
    pub rooms: Vec<[u8; ROOM_LANE_ID_LEN]>,
    /// Where the knocker can be dialed as the knock is written: its public
    /// addresses, so the host can dial back at the rendezvous with neither
    /// the knocker's contact key (a first visit carries none) nor the DHT.
    /// They take the address slots the rooms leave free; empty in a knock
    /// written before they existed.
    pub reply: Vec<std::net::SocketAddr>,
}

/// The beacon (kind 3): a node id in the clear, nothing else.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BeaconV2 {
    pub era: u64,
    pub node_id: iroh::PublicKey,
    pub issued_at: u64,
    pub expires_at: u64,
}

/// The shared v2 header: version, kind, era, signer, the 32-byte key slot and
/// the two times, written into a zeroed buffer.
fn write_v2_header(buf: &mut [u8; RECORD_V2_LEN], kind: u8, era: u64, node_id: &iroh::PublicKey, key_slot: &[u8; 32], issued_at: u64, expires_at: u64) {
    buf[OFF_VERSION] = RECORD_V2_VERSION;
    buf[OFF_KIND] = kind;
    buf[OFF_ERA..OFF_ERA + 8].copy_from_slice(&era.to_le_bytes());
    buf[OFF_NODE_ID..OFF_NODE_ID + 32].copy_from_slice(node_id.as_bytes());
    buf[OFF_KX_PK..OFF_KX_PK + 32].copy_from_slice(key_slot);
    buf[OFF_ISSUED_AT..OFF_ISSUED_AT + 8].copy_from_slice(&issued_at.to_le_bytes());
    buf[OFF_EXPIRES_AT..OFF_EXPIRES_AT + 8].copy_from_slice(&expires_at.to_le_bytes());
}

/// Sign the body with the record's own node key, into the signature slot.
fn sign_v2(buf: &mut [u8; RECORD_V2_LEN], secret: &iroh::SecretKey) {
    let sig = secret.sign(&buf[..OFF_SIG]);
    buf[OFF_SIG..].copy_from_slice(&sig.to_bytes());
}

/// What the shared header says, once length, version, kind, era, signature and
/// the reserved bytes checked out. The body's kind-specific part is the caller's.
struct V2Header {
    node_id: iroh::PublicKey,
    key_slot: [u8; 32],
    issued_at: u64,
    expires_at: u64,
    count: usize,
}

fn read_v2_header(bytes: &[u8], expected_kind: u8, expected_era: u64) -> Result<V2Header> {
    if bytes.len() != RECORD_V2_LEN {
        return Err(anyhow!("v2 record is {} bytes, expected {RECORD_V2_LEN}", bytes.len()));
    }
    if bytes[OFF_VERSION] != RECORD_V2_VERSION {
        return Err(anyhow!("v2 record version {} unsupported", bytes[OFF_VERSION]));
    }
    if bytes[OFF_KIND] != expected_kind {
        return Err(anyhow!("record kind {} is not kind {expected_kind}", bytes[OFF_KIND]));
    }
    let era = u64::from_le_bytes(bytes[OFF_ERA..OFF_ERA + 8].try_into().unwrap());
    if era != expected_era {
        return Err(anyhow!("record signed for era {era}, read under era {expected_era}"));
    }
    let node_bytes: [u8; 32] = bytes[OFF_NODE_ID..OFF_NODE_ID + 32].try_into().unwrap();
    let node_id = iroh::PublicKey::from_bytes(&node_bytes).map_err(|e| anyhow!("record node_id invalid: {e:?}"))?;
    let sig_bytes: [u8; 64] = bytes[OFF_SIG..].try_into().unwrap();
    node_id
        .verify(&bytes[..OFF_SIG], &iroh::Signature::from_bytes(&sig_bytes))
        .map_err(|e| anyhow!("record signature invalid: {e:?}"))?;
    if bytes[OFF_RESERVED..OFF_SIG].iter().any(|&b| b != 0) {
        return Err(anyhow!("record body is not canonical (reserved bytes set)"));
    }
    Ok(V2Header {
        node_id,
        key_slot: bytes[OFF_KX_PK..OFF_KX_PK + 32].try_into().unwrap(),
        issued_at: u64::from_le_bytes(bytes[OFF_ISSUED_AT..OFF_ISSUED_AT + 8].try_into().unwrap()),
        expires_at: u64::from_le_bytes(bytes[OFF_EXPIRES_AT..OFF_EXPIRES_AT + 8].try_into().unwrap()),
        count: bytes[OFF_ADDR_COUNT] as usize,
    })
}

/// Encode + sign a knock into its fixed 320-byte plaintext (sealed to the host
/// by [`seal_to_kx`] afterwards). The room lane ids take the first address
/// slots and the reply addresses the next ones, the knocker's contact key the
/// key slot (zeros when withheld).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn encode_knock_v2(knock: &KnockV2, secret: &iroh::SecretKey) -> Result<[u8; RECORD_V2_LEN]> {
    if knock.from != secret.public() {
        return Err(anyhow!("knock `from` is not the signing key"));
    }
    if knock.rooms.is_empty() || knock.rooms.len() > MAX_KNOCK_ROOMS {
        return Err(anyhow!("a knock names 1 to {MAX_KNOCK_ROOMS} rooms, not {}", knock.rooms.len()));
    }
    if knock.rooms.len() + knock.reply.len() > MAX_V2_ADDRS {
        return Err(anyhow!(
            "a knock's {} room(s) and {} reply address(es) do not fit its {MAX_V2_ADDRS} slots",
            knock.rooms.len(),
            knock.reply.len()
        ));
    }
    let mut buf = [0u8; RECORD_V2_LEN];
    write_v2_header(&mut buf, KIND_KNOCK, knock.era, &knock.from, &knock.ck_from.unwrap_or([0u8; 32]), knock.issued_at, knock.expires_at);
    buf[OFF_ADDR_COUNT] = (knock.rooms.len() | (knock.reply.len() << KNOCK_REPLY_SHIFT)) as u8;
    for (i, lane) in knock.rooms.iter().enumerate() {
        let slot = &mut buf[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN];
        slot[..ROOM_LANE_ID_LEN].copy_from_slice(lane);
    }
    for (j, addr) in knock.reply.iter().enumerate() {
        let i = knock.rooms.len() + j;
        write_addr_slot(&mut buf[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN], addr, 0);
    }
    sign_v2(&mut buf, secret);
    Ok(buf)
}

/// Decode + verify a knock plaintext read under an inbox hint of `expected_era`.
/// Rejects the wrong length, version, kind or era, a bad signature and a
/// non-canonical body. The knock's room list is the host's to match against
/// the rooms it holds; freshness is the reader's job, and so is which of the
/// reply addresses it will dial (they are the knocker's own word).
pub fn decode_knock_v2(bytes: &[u8], expected_era: u64) -> Result<KnockV2> {
    let h = read_v2_header(bytes, KIND_KNOCK, expected_era)?;
    let (room_count, reply_count) = (h.count & KNOCK_ROOMS_MASK, h.count >> KNOCK_REPLY_SHIFT);
    if room_count == 0 || room_count > MAX_KNOCK_ROOMS {
        return Err(anyhow!("knock names {room_count} rooms, expected 1 to {MAX_KNOCK_ROOMS}"));
    }
    let used = room_count + reply_count;
    if used > MAX_V2_ADDRS {
        return Err(anyhow!("knock's {room_count} room(s) and {reply_count} reply address(es) overrun its {MAX_V2_ADDRS} slots"));
    }
    if bytes[OFF_ADDRS + used * ADDR_SLOT_LEN..OFF_RESERVED].iter().any(|&b| b != 0) {
        return Err(anyhow!("knock body is not canonical (unused slots set)"));
    }
    let mut rooms = Vec::with_capacity(room_count);
    for i in 0..room_count {
        let slot = &bytes[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN];
        if slot[ROOM_LANE_ID_LEN..].iter().any(|&b| b != 0) {
            return Err(anyhow!("knock room slot {i} is not canonical"));
        }
        rooms.push(slot[..ROOM_LANE_ID_LEN].try_into().unwrap());
    }
    let mut reply = Vec::with_capacity(reply_count);
    for i in room_count..used {
        let entry = read_addr_slot(&bytes[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN], i)?;
        if entry.flags != 0 {
            return Err(anyhow!("knock reply slot {i} is not canonical (flags set)"));
        }
        reply.push(entry.addr);
    }
    let ck_from = if h.key_slot == [0u8; 32] { None } else { Some(h.key_slot) };
    Ok(KnockV2 { era: expected_era, from: h.node_id, ck_from, issued_at: h.issued_at, expires_at: h.expires_at, rooms, reply })
}

/// Encode + sign a beacon: the header alone, every slot zero.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn encode_beacon_v2(beacon: &BeaconV2, secret: &iroh::SecretKey) -> Result<[u8; RECORD_V2_LEN]> {
    if beacon.node_id != secret.public() {
        return Err(anyhow!("beacon node_id is not the signing key"));
    }
    let mut buf = [0u8; RECORD_V2_LEN];
    write_v2_header(&mut buf, KIND_BEACON, beacon.era, &beacon.node_id, &[0u8; 32], beacon.issued_at, beacon.expires_at);
    sign_v2(&mut buf, secret);
    Ok(buf)
}

/// Decode + verify a beacon read under the beacon hint of `expected_era`: a
/// beacon carries no key and no address, so every slot must be zero.
pub fn decode_beacon_v2(bytes: &[u8], expected_era: u64) -> Result<BeaconV2> {
    let h = read_v2_header(bytes, KIND_BEACON, expected_era)?;
    if h.count != 0 || h.key_slot != [0u8; 32] || bytes[OFF_ADDRS..OFF_RESERVED].iter().any(|&b| b != 0) {
        return Err(anyhow!("beacon body is not canonical (a beacon carries no key and no address)"));
    }
    Ok(BeaconV2 { era: expected_era, node_id: h.node_id, issued_at: h.issued_at, expires_at: h.expires_at })
}

/// Bytes a sealed-to-key blob adds to its plaintext: the ephemeral public
/// key, the nonce and the AEAD tag.
#[cfg(feature = "chia-read")]
pub const KX_SEAL_OVERHEAD: usize = 32 + 24 + 16;

/// Seal `plaintext` to the holder of the X25519 secret behind `recipient_pk`
/// (a host's card key): an ephemeral X25519 key agrees a shared secret, the
/// XChaCha20-Poly1305 key is derived from it together with both public keys,
/// and kind ‖ era (with `net`'s tag on mainnet) ‖ `carrier_parent` ‖ `lane`
/// bind as associated data ([`kx_aad`]: the parent of the coin the blob will
/// ride on, so a copy under another coin never opens, and the room's secret
/// lane token, so only a holder of the room key can have written it). Blob: `[32B ephemeral pk ‖ 24B nonce ‖
/// ciphertext]`. Every holder of the host's contact key can find the hint this
/// lands under; only the host opens it, only under the coin it was written by,
/// only for the room whose lane it was sealed with, and only on its network.
#[cfg(feature = "chia-read")]
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn seal_to_kx(
    net: ChiaNet,
    recipient_pk: &[u8; 32],
    kind: u8,
    era: u64,
    carrier_parent: &[u8; 32],
    lane: &[u8; 32],
    plaintext: &[u8],
) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::Payload;
    let mut e_sk = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut e_sk);
    let e_pk = curve25519_dalek::MontgomeryPoint::mul_base_clamped(e_sk).to_bytes();
    let key = kx_seal_key(&kx_shared(&e_sk, recipient_pk)?, &e_pk, recipient_pk);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let aad = kx_aad(net, kind, era, carrier_parent, lane);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
        .map_err(|e| anyhow!("seal_to_kx failed: {e:?}"))?;
    let mut out = Vec::with_capacity(KX_SEAL_OVERHEAD + plaintext.len());
    out.extend_from_slice(&e_pk);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a blob [`seal_to_kx`] made for the holder of `recipient_sk`, for
/// `kind` in `era` on `net`, read from a coin whose parent is `carrier_parent`,
/// for the room whose secret lane token is `lane`. Fails on another recipient,
/// a tampered blob, or a blob sealed for another kind, era, carrier (a copy
/// under a new coin, #272 review round 3), lane (a writer without the room key,
/// round 5) or network (§3.5).
#[cfg(feature = "chia-read")]
pub fn open_with_kx(
    net: ChiaNet,
    recipient_sk: &[u8; 32],
    kind: u8,
    era: u64,
    carrier_parent: &[u8; 32],
    lane: &[u8; 32],
    sealed: &[u8],
) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::Payload;
    if sealed.len() < KX_SEAL_OVERHEAD {
        return Err(anyhow!("sealed-to-key blob too short"));
    }
    let e_pk: [u8; 32] = sealed[..32].try_into().unwrap();
    let recipient_pk = curve25519_dalek::MontgomeryPoint::mul_base_clamped(*recipient_sk).to_bytes();
    let key = kx_seal_key(&kx_shared(recipient_sk, &e_pk)?, &e_pk, &recipient_pk);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let aad = kx_aad(net, kind, era, carrier_parent, lane);
    cipher
        .decrypt(XNonce::from_slice(&sealed[32..56]), Payload { msg: &sealed[56..], aad: &aad })
        .map_err(|e| anyhow!("open_with_kx failed (not sealed to this key, kind, era, carrier coin, room lane or network?): {e:?}"))
}

/// X25519: our secret × their public point. An all-zero result (their point
/// was of low order) is refused rather than used as a key.
#[cfg(feature = "chia-read")]
fn kx_shared(our_sk: &[u8; 32], their_pk: &[u8; 32]) -> Result<[u8; 32]> {
    let shared = curve25519_dalek::MontgomeryPoint(*their_pk).mul_clamped(*our_sk).to_bytes();
    if shared == [0u8; 32] {
        return Err(anyhow!("X25519 agreement with a low-order point refused"));
    }
    Ok(shared)
}

/// The sealing key: the shared secret bound to both public keys, so a blob
/// cannot be re-addressed.
#[cfg(feature = "chia-read")]
fn kx_seal_key(shared: &[u8; 32], e_pk: &[u8; 32], recipient_pk: &[u8; 32]) -> [u8; 32] {
    let mut material = [0u8; 96];
    material[..32].copy_from_slice(shared);
    material[32..64].copy_from_slice(e_pk);
    material[64..].copy_from_slice(recipient_pk);
    blake3::derive_key(CTX_KNOCK_SEAL, &material)
}

#[cfg(test)]
mod p6b_tests {
    use super::*;

    fn knock(sk: &iroh::SecretKey, ck: Option<[u8; 32]>, rooms: &[&str]) -> KnockV2 {
        KnockV2 {
            era: 7,
            from: sk.public(),
            ck_from: ck,
            issued_at: 1_791_700_000,
            expires_at: 1_791_700_000 + 2 * ERA_SECS,
            rooms: rooms.iter().map(|r| room_lane_id(r)).collect(),
            reply: vec![],
        }
    }

    #[test]
    fn knock_roundtrips_and_names_rooms_by_lane_id_only() {
        let sk = iroh::SecretKey::generate();
        let k = knock(&sk, Some([5u8; 32]), &["lobby", "workshop"]);
        let bytes = encode_knock_v2(&k, &sk).unwrap();
        assert_eq!(bytes.len(), RECORD_V2_LEN);
        assert_eq!(bytes[OFF_KIND], KIND_KNOCK);
        assert!(!bytes.windows(5).any(|w| w == b"lobby"), "no room id in the clear");
        let back = decode_knock_v2(&bytes, 7).unwrap();
        assert_eq!(back, k);
        assert!(back.rooms.contains(&room_lane_id("lobby")) && !back.rooms.contains(&room_lane_id("cellar")));
        // Withheld contact key: zeros on the wire, None back.
        let quiet = knock(&sk, None, &["lobby"]);
        let back = decode_knock_v2(&encode_knock_v2(&quiet, &sk).unwrap(), 7).unwrap();
        assert_eq!(back.ck_from, None);
    }

    #[test]
    fn knock_rejects_wrong_era_kind_signer_and_non_canonical_bodies() {
        let sk = iroh::SecretKey::generate();
        let k = knock(&sk, None, &["lobby"]);
        let bytes = encode_knock_v2(&k, &sk).unwrap();
        assert!(decode_knock_v2(&bytes, 8).is_err(), "read under another era's hint");
        assert!(decode_beacon_v2(&bytes, 7).is_err(), "a knock is not a beacon");
        assert!(decode_presence_v2(&bytes, 7).is_err(), "a knock is not presence");
        let mut flipped = bytes;
        flipped[OFF_ADDRS] ^= 1;
        assert!(decode_knock_v2(&flipped, 7).is_err(), "a changed room fails the signature");
        let mut padded = k.clone();
        padded.rooms = vec![];
        assert!(encode_knock_v2(&padded, &sk).is_err(), "a knock names at least one room");
        padded.rooms = vec![[1u8; ROOM_LANE_ID_LEN]; MAX_KNOCK_ROOMS + 1];
        assert!(encode_knock_v2(&padded, &sk).is_err());
        let other = iroh::SecretKey::generate();
        assert!(encode_knock_v2(&k, &other).is_err(), "signed by the knocker alone");
        // A canonical body re-signed with stray bytes in an unused slot fails.
        let mut dirty = [0u8; RECORD_V2_LEN];
        dirty.copy_from_slice(&encode_knock_v2(&k, &sk).unwrap());
        dirty[OFF_ADDRS + ADDR_SLOT_LEN + 3] = 9;
        sign_v2(&mut dirty, &sk);
        assert!(decode_knock_v2(&dirty, 7).is_err(), "unused room slots must be zero");
        let mut tail = [0u8; RECORD_V2_LEN];
        tail.copy_from_slice(&encode_knock_v2(&k, &sk).unwrap());
        tail[OFF_ADDRS + ROOM_LANE_ID_LEN] = 1;
        sign_v2(&mut tail, &sk);
        assert!(decode_knock_v2(&tail, 7).is_err(), "the bytes after a lane id must be zero");
    }

    /// The reply addresses: a knock tells its host where to dial back, in the
    /// slots its rooms leave free, and a knock written without them is byte
    /// for byte the knock of before.
    #[test]
    fn knock_carries_reply_addresses_in_the_slots_its_rooms_leave_free() {
        let sk = iroh::SecretKey::generate();
        let v6: std::net::SocketAddr = "[2001:4860:4860::8888]:44442".parse().unwrap();
        let v4: std::net::SocketAddr = "8.8.8.8:44442".parse().unwrap();
        let mut k = knock(&sk, None, &["lobby"]);
        let bare = encode_knock_v2(&k, &sk).unwrap();
        assert_eq!(bare[OFF_ADDR_COUNT], 1, "no reply address: the count byte of before");
        assert!(bare[OFF_ADDRS + ADDR_SLOT_LEN..OFF_RESERVED].iter().all(|&b| b == 0), "and every other slot zero, as before");
        k.reply = vec![v6, v4];
        let bytes = encode_knock_v2(&k, &sk).unwrap();
        assert_eq!(bytes.len(), RECORD_V2_LEN, "the same fixed size, so the sealed knock is no longer on chain");
        assert_eq!(bytes[OFF_ADDR_COUNT], 1 | (2 << 4), "one room in the low bits, two reply addresses above");
        let back = decode_knock_v2(&bytes, 7).unwrap();
        assert_eq!(back, k);
        assert_eq!(back.reply, vec![v6, v4], "in the order written");
        // With a contact key too, and beside two rooms.
        let mut both = knock(&sk, Some([5u8; 32]), &["lobby", "workshop"]);
        both.reply = vec![v4];
        assert_eq!(decode_knock_v2(&encode_knock_v2(&both, &sk).unwrap(), 7).unwrap(), both);
        // The slots are shared: one room leaves seven.
        let mut full = knock(&sk, None, &["lobby"]);
        full.reply = vec![v4; MAX_KNOCK_REPLY_ADDRS];
        assert_eq!(decode_knock_v2(&encode_knock_v2(&full, &sk).unwrap(), 7).unwrap().reply.len(), MAX_KNOCK_REPLY_ADDRS);
        full.reply.push(v4);
        assert!(encode_knock_v2(&full, &sk).is_err(), "eight reply addresses beside a room do not fit");
        // Non-canonical bodies, signed again by the knocker: none decodes.
        let dirty = |change: &dyn Fn(&mut [u8; RECORD_V2_LEN])| {
            let mut b = [0u8; RECORD_V2_LEN];
            b.copy_from_slice(&bytes);
            change(&mut b);
            sign_v2(&mut b, &sk);
            decode_knock_v2(&b, 7)
        };
        let slot = |i: usize| OFF_ADDRS + i * ADDR_SLOT_LEN;
        assert!(dirty(&|_| {}).is_ok(), "signed again unchanged, it decodes");
        assert!(dirty(&|b| b[slot(1) + 19] = 1).is_err(), "a reply slot carries no flags");
        assert!(dirty(&|b| b[slot(1)] = 5).is_err(), "an unknown address family");
        assert!(dirty(&|b| b[slot(2) + 9] = 1).is_err(), "an IPv4 slot with bytes past its four octets");
        assert!(dirty(&|b| b[OFF_ADDR_COUNT] = 1 | (8 << 4)).is_err(), "more reply addresses than the slots left");
        assert!(dirty(&|b| b[OFF_ADDR_COUNT] = 1 | (1 << 4)).is_err(), "a slot past the count must be zero");
        assert!(dirty(&|b| b[OFF_ADDR_COUNT] = 2 << 4).is_err(), "a knock names at least one room");
    }

    #[test]
    fn beacon_roundtrips_and_carries_nothing_but_a_node_id() {
        let sk = iroh::SecretKey::generate();
        let b = BeaconV2 { era: 3, node_id: sk.public(), issued_at: 100, expires_at: 100 + 2 * ERA_SECS };
        let bytes = encode_beacon_v2(&b, &sk).unwrap();
        assert_eq!(decode_beacon_v2(&bytes, 3).unwrap(), b);
        assert!(bytes[OFF_KX_PK..OFF_KX_PK + 32].iter().all(|&x| x == 0), "no key");
        assert!(bytes[OFF_ADDR_COUNT..OFF_SIG].iter().all(|&x| x == 0), "no address");
        assert!(decode_beacon_v2(&bytes, 4).is_err());
        assert!(decode_knock_v2(&bytes, 3).is_err(), "a beacon is not a knock");
        let mut keyed = [0u8; RECORD_V2_LEN];
        keyed.copy_from_slice(&bytes);
        keyed[OFF_KX_PK] = 7;
        sign_v2(&mut keyed, &sk);
        assert!(decode_beacon_v2(&keyed, 3).is_err(), "a beacon with a key is not canonical");
        assert!(encode_beacon_v2(&b, &iroh::SecretKey::generate()).is_err());
    }

    /// On each network: the knock's seal opens for its recipient alone, under
    /// its own kind, era, carrier coin, lane and network (the network's
    /// half is `network_tag_tests::a_blob_sealed_on_one_network_opens_on_that_network_alone`).
    #[test]
    #[cfg(feature = "chia-read")]
    fn sealed_to_key_opens_for_the_recipient_alone() {
        let host_sk = [11u8; 32];
        let host_pk = curve25519_dalek::MontgomeryPoint::mul_base_clamped(host_sk).to_bytes();
        let plain = [0x42u8; RECORD_V2_LEN];
        let carrier = [5u8; 32]; // the writer's input coin: the parent of the coin the blob rides on
        let lane = derive_lane_token(&[3u8; 32]); // the room's secret lane token
        for net in ChiaNet::ALL {
            let blob = seal_to_kx(net, &host_pk, KIND_KNOCK, 7, &carrier, &lane, &plain).unwrap();
            assert_eq!(blob.len(), RECORD_V2_LEN + KX_SEAL_OVERHEAD, "{net:?}: the tag is bound, never carried");
            assert_eq!(open_with_kx(net, &host_sk, KIND_KNOCK, 7, &carrier, &lane, &blob).unwrap(), plain.to_vec(), "{net:?}");
            assert!(open_with_kx(net, &[12u8; 32], KIND_KNOCK, 7, &carrier, &lane, &blob).is_err(), "{net:?}: another key");
            assert!(open_with_kx(net, &host_sk, KIND_KNOCK, 8, &carrier, &lane, &blob).is_err(), "{net:?}: another era");
            assert!(open_with_kx(net, &host_sk, KIND_BEACON, 7, &carrier, &lane, &blob).is_err(), "{net:?}: another kind");
            let mut tampered = blob.clone();
            *tampered.last_mut().unwrap() ^= 1;
            assert!(open_with_kx(net, &host_sk, KIND_KNOCK, 7, &carrier, &lane, &tampered).is_err(), "{net:?}");
            let mut readdressed = blob.clone();
            readdressed[0] ^= 1;
            assert!(open_with_kx(net, &host_sk, KIND_KNOCK, 7, &carrier, &lane, &readdressed).is_err(), "{net:?}: the ephemeral key is bound in");
            assert!(
                open_with_kx(net, &host_sk, KIND_KNOCK, 7, &[6u8; 32], &lane, &blob).is_err(),
                "{net:?}: another carrier: the same blob copied under a coin with another parent does not open (#272 review round 3)"
            );
            assert!(
                open_with_kx(net, &host_sk, KIND_KNOCK, 7, &carrier, &derive_lane_token(&[4u8; 32]), &blob).is_err(),
                "{net:?}: another room's lane: a blob sealed without this room's key does not open (#272 review round 5)"
            );
            assert_ne!(seal_to_kx(net, &host_pk, KIND_KNOCK, 7, &carrier, &lane, &plain).unwrap(), blob, "{net:?}: fresh key and nonce every time");
            assert!(open_with_kx(net, &host_sk, KIND_KNOCK, 7, &carrier, &lane, &blob[..KX_SEAL_OVERHEAD - 1]).is_err(), "{net:?}: too short");
            assert!(seal_to_kx(net, &[0u8; 32], KIND_KNOCK, 7, &carrier, &lane, &plain).is_err(), "{net:?}: a low-order recipient point is refused");
        }
    }

    /// On each network: an inbox hint is its host's, its room's and its era's
    /// own, and never a presence hint of the same network.
    #[test]
    fn inbox_lane_and_hints_separate_rooms_hosts_and_eras() {
        let ck_a = [1u8; 32];
        let ck_b = [2u8; 32];
        let lane_x = derive_lane_token(&[3u8; 32]);
        let lane_y = derive_lane_token(&[4u8; 32]);
        assert_ne!(lane_x, lane_y);
        assert_ne!(lane_x, [3u8; 32], "a lane is not the room key");
        for net in ChiaNet::ALL {
            let h = derive_inbox_hint(net, &ck_a, &lane_x, 7);
            assert_ne!(h, derive_inbox_hint(net, &ck_b, &lane_x, 7), "{net:?}: another host");
            assert_ne!(h, derive_inbox_hint(net, &ck_a, &lane_y, 7), "{net:?}: another room");
            assert_ne!(h, derive_inbox_hint(net, &ck_a, &lane_x, 8), "{net:?}: another era");
            assert_ne!(h, derive_ck_hint(net, &ck_a, 7), "{net:?}: never the presence hint");
            assert_eq!(h, derive_inbox_hint(net, &ck_a, &lane_x, 7), "{net:?}: deterministic");
            assert_ne!(derive_beacon_hint(net, 7), derive_beacon_hint(net, 8), "{net:?}");
        }
        assert_eq!(room_lane_id("lobby"), room_lane_id("lobby"));
        assert_ne!(room_lane_id("lobby"), room_lane_id("lobbz"));
    }

    /// The startup line's word on publishing. With LIST ME on (where a
    /// test network starts, stage 4 design §4.5 (6)) every text is the one
    /// testnet11 had. With LIST ME off (where a network of real coins
    /// starts) publishing is off, wallet on or not, and the line sends no
    /// one to the Bank for it: it names the switch and what is not written
    /// while it is off, the listing and the knocks, and does not say the
    /// lane only reads the chain.
    #[test]
    fn the_publish_status_says_publishing_is_on_only_where_list_me_is() {
        use crate::chia_wallet_switch::EnvSwitch::{Off, On, Unset};
        const ON: &str = "on (the SSF wallet is on)";
        const HELD_OFF: &str = "off (SSF_CHIA_LANE holds the SSF wallet off)";
        const BANK: &str = "off until the SSF wallet is turned on in the SpacePhone's Bank (a headless node: start it with SSF_CHIA_LANE=1)";
        const UNLISTED: &str = "off (LIST ME is off for this network: no listing or knock is written until it is turned on in the SpacePhone's Network settings)";
        assert!(!UNLISTED.contains("only reads"), "a beacon the operator turned on is written from a key of its own");
        for env in [Unset, On, Off] {
            assert_eq!(publish_status(true, true, true, env), ON, "{env:?}");
            assert_eq!(publish_status(true, true, false, env), if env == Off { HELD_OFF } else { BANK }, "{env:?}");
            for wallet_on in [false, true] {
                let line = publish_status(true, false, wallet_on, env);
                assert_eq!(line, if env == Off { HELD_OFF } else { UNLISTED }, "{env:?} wallet_on={wallet_on}");
                assert!(!line.contains("Bank"), "{line}");
            }
        }
        for listed in [false, true] {
            for wallet_on in [false, true] {
                assert_eq!(publish_status(false, listed, wallet_on, Unset), "not built", "a read-only build says only that");
            }
        }
        // The switch starts where the line's two halves say: on for a test
        // network, off where the coins are real.
        for net in crate::chia_network::ChiaNet::ALL {
            assert_eq!(crate::chia_listing::default_on(net), net.is_test(), "{net:?}");
        }
    }
}

#[cfg(test)]
mod tests {
    /// ⛓️ The startup line's word while Chia is off names what holds it off:
    /// the environment's words as before, or the in-game switch.
    #[test]
    fn the_status_word_while_chia_is_off_says_why() {
        use crate::chia_strict::OffSource;
        assert_eq!(super::strict_status(OffSource::Env), "off (Chia is off on this computer: SSF_NO_CHIA_LANE)");
        assert_eq!(
            super::strict_status(OffSource::Setting),
            "off (Chia is off on this computer: the Chia switch in the SpacePhone's Network settings)"
        );
    }

    use super::*;

    #[test]
    fn record_roundtrip_sign_seal_open_verify() {
        let secret = iroh::SecretKey::generate();
        let room_key = [42u8; 32];
        let record = ChiaPresenceRecord {
            kx_pk: None,
            addr_flags: vec![],
            v: 1,
            node_id: secret.public().to_string(),
            addrs: vec!["192.0.2.1:4444".into(), "[2001:db8::1]:4445".into()],
            relay_urls: vec![],
            issued_at: 1_783_600_000,
            expires_at: 1_783_603_600,
        };
        let blob = encode_signed(&record, &secret).unwrap();
        let sealed = seal(&room_key, &blob).unwrap();
        let opened = open(&room_key, &sealed).unwrap();
        let decoded = decode_signed(&opened).unwrap();
        assert_eq!(decoded, record);
    }

    #[test]
    fn wrong_room_key_cannot_open() {
        let secret = iroh::SecretKey::generate();
        let record = ChiaPresenceRecord {
            kx_pk: None,
            addr_flags: vec![],
            v: 1,
            node_id: secret.public().to_string(),
            addrs: vec![],
            relay_urls: vec![],
            issued_at: 0,
            expires_at: 0,
        };
        let blob = encode_signed(&record, &secret).unwrap();
        let sealed = seal(&[1u8; 32], &blob).unwrap();
        assert!(open(&[2u8; 32], &sealed).is_err());
    }

    #[test]
    fn tampered_record_fails_signature() {
        let secret = iroh::SecretKey::generate();
        let record = ChiaPresenceRecord {
            kx_pk: None,
            addr_flags: vec![],
            v: 1,
            node_id: secret.public().to_string(),
            addrs: vec!["192.0.2.1:4444".into()],
            relay_urls: vec![],
            issued_at: 10,
            expires_at: 20,
        };
        let blob = encode_signed(&record, &secret).unwrap();
        let mut wrapper: SignedRecord = serde_json::from_slice(&blob).unwrap();
        // Swap in a different record body, keep the old signature.
        let forged = ChiaPresenceRecord { addrs: vec!["203.0.113.9:1".into()], ..record };
        wrapper.record_b64 =
            base64::Engine::encode(&base64::prelude::BASE64_STANDARD, serde_json::to_vec(&forged).unwrap());
        let forged_blob = serde_json::to_vec(&wrapper).unwrap();
        assert!(decode_signed(&forged_blob).is_err());
    }

    #[test]
    fn hints_rotate_by_epoch_and_room() {
        let room_a = [1u8; 32];
        let room_b = [2u8; 32];
        assert_ne!(derive_hint(&room_a, 100), derive_hint(&room_a, 101));
        assert_ne!(derive_hint(&room_a, 100), derive_hint(&room_b, 100));
        assert_eq!(derive_hint(&room_a, 100), derive_hint(&room_a, 100));
    }

    // ── record v2 (#231 P6a) ────────────────────────────────────────────────

    fn v2_record(secret: &iroh::SecretKey, era: u64) -> PresenceV2 {
        let mut addrs = vec![
            AddrEntry { addr: "198.51.100.7:4444".parse().unwrap(), flags: FLAG_INBOUND_VERIFIED },
            AddrEntry { addr: "[2001:db8::1]:4445".parse().unwrap(), flags: 0 },
        ];
        sort_addr_entries(&mut addrs);
        PresenceV2 {
            era,
            node_id: secret.public(),
            kx_pk: [0xAB; 32],
            issued_at: 1_791_700_000,
            expires_at: 1_791_700_000 + 2 * ERA_SECS,
            addrs,
        }
    }

    #[test]
    fn v2_presence_roundtrip_is_fixed_size_sealed_under_the_contact_key() {
        let secret = iroh::SecretKey::generate();
        let ck = [5u8; 32];
        let record = v2_record(&secret, 42);
        let plain = encode_presence_v2(&record, &secret).unwrap();
        assert_eq!(plain.len(), RECORD_V2_LEN);
        assert_eq!(OFF_RESERVED, 251, "layout: 8 slots of 20 bytes after the 91-byte header");
        for net in ChiaNet::ALL {
            let sealed = seal_v2(net, &ck, KIND_PRESENCE, 42, &plain).unwrap();
            assert_eq!(sealed.len(), 24 + RECORD_V2_LEN + 16, "{net:?}: one size class on chain: nonce + body + tag");
            let opened = open_v2(net, &ck, KIND_PRESENCE, 42, &sealed).unwrap();
            assert_eq!(opened, plain.to_vec(), "{net:?}");
        }
        let sealed = seal_v2(ChiaNet::Testnet11, &ck, KIND_PRESENCE, 42, &plain).unwrap();
        let opened = open_v2(ChiaNet::Testnet11, &ck, KIND_PRESENCE, 42, &sealed).unwrap();
        let decoded = decode_presence_v2(&opened, 42).unwrap();
        assert_eq!(decoded, record);
        assert!(decoded.addrs[0].addr.is_ipv6(), "canonical order puts IPv6 first");
        assert_eq!(decoded.addrs[1].flags, FLAG_INBOUND_VERIFIED);
        let as_v1 = decoded.to_record();
        assert_eq!(as_v1.v, 2);
        assert_eq!(as_v1.addrs, vec!["[2001:db8::1]:4445".to_string(), "198.51.100.7:4444".to_string()]);
        assert_eq!(as_v1.addr_flags, vec![0, FLAG_INBOUND_VERIFIED]);
        assert_eq!(as_v1.kx_pk.as_deref(), Some(hex::encode([0xAB; 32]).as_str()));
        // A record with no public address still encodes (presence + kx_pk alone).
        let bare = PresenceV2 { addrs: vec![], ..record.clone() };
        let plain = encode_presence_v2(&bare, &secret).unwrap();
        assert_eq!(decode_presence_v2(&plain, 42).unwrap().addrs.len(), 0);
    }

    #[test]
    fn v2_kind_and_era_are_bound_into_the_seal_and_the_signature() {
        let secret = iroh::SecretKey::generate();
        let ck = [5u8; 32];
        let plain = encode_presence_v2(&v2_record(&secret, 42), &secret).unwrap();
        for net in ChiaNet::ALL {
            let sealed = seal_v2(net, &ck, KIND_PRESENCE, 42, &plain).unwrap();
            assert!(open_v2(net, &ck, KIND_PRESENCE, 43, &sealed).is_err(), "{net:?}: replayed under the next era's hint: refused");
            assert!(open_v2(net, &ck, KIND_KNOCK, 42, &sealed).is_err(), "{net:?}: re-filed as a knock: refused");
            assert!(open_v2(net, &[6u8; 32], KIND_PRESENCE, 42, &sealed).is_err(), "{net:?}: another contact key: refused");
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            assert!(open_v2(other, &ck, KIND_PRESENCE, 42, &sealed).is_err(), "{net:?}: read on {other:?}: refused");
        }
        assert!(decode_presence_v2(&plain, 43).is_err(), "the plaintext era is checked too");
        let mut forged = plain;
        forged[OFF_ERA] ^= 1;
        assert!(decode_presence_v2(&forged, 43).is_err(), "an era flipped after signing fails the signature");
        let mut forged = plain;
        forged[OFF_KIND] = KIND_BEACON;
        assert!(decode_presence_v2(&forged, 42).is_err(), "a kind flipped after signing is not presence");
    }

    #[test]
    fn v2_decoder_rejects_tampering_padding_and_wrong_sizes() {
        let secret = iroh::SecretKey::generate();
        let plain = encode_presence_v2(&v2_record(&secret, 7), &secret).unwrap();
        let mut forged = plain;
        forged[OFF_ADDRS + 1] ^= 0x40; // first octet of the first address
        assert!(decode_presence_v2(&forged, 7).is_err(), "an address changed after signing");
        let mut forged = plain;
        forged[OFF_ADDRS + 19] ^= FLAG_INBOUND_VERIFIED; // flags of the first address
        assert!(decode_presence_v2(&forged, 7).is_err(), "a flag flipped after signing");
        let mut forged = plain;
        forged[OFF_RESERVED] = 1;
        assert!(decode_presence_v2(&forged, 7).is_err(), "reserved bytes must stay zero");
        assert!(decode_presence_v2(&plain[..RECORD_V2_LEN - 1], 7).is_err(), "short");
        let mut long = plain.to_vec();
        long.push(0);
        assert!(decode_presence_v2(&long, 7).is_err(), "long");
        let other = iroh::SecretKey::generate();
        let mut wrong_signer = v2_record(&secret, 7);
        wrong_signer.node_id = other.public();
        assert!(encode_presence_v2(&wrong_signer, &secret).is_err(), "a record names its own signer");
        let mut too_many = v2_record(&secret, 7);
        too_many.addrs = (0..9)
            .map(|i| AddrEntry { addr: format!("198.51.100.{i}:1").parse().unwrap(), flags: 0 })
            .collect();
        assert!(encode_presence_v2(&too_many, &secret).is_err(), "nine addresses do not fit");
    }

    #[test]
    fn era_math_and_contact_key_hints() {
        assert_eq!(era_of(0), 0);
        assert_eq!(era_of(ERA_BLOCKS - 1), 0);
        assert_eq!(era_of(ERA_BLOCKS), 1);
        assert_eq!(era_of(10 * ERA_BLOCKS + 5), 10);
        let ck_a = [1u8; 32];
        let ck_b = [2u8; 32];
        for net in ChiaNet::ALL {
            assert_ne!(derive_ck_hint(net, &ck_a, 100), derive_ck_hint(net, &ck_a, 101), "{net:?}");
            assert_ne!(derive_ck_hint(net, &ck_a, 100), derive_ck_hint(net, &ck_b, 100), "{net:?}");
            assert_eq!(derive_ck_hint(net, &ck_a, 100), derive_ck_hint(net, &ck_a, 100), "{net:?}");
            assert_ne!(derive_ck_hint(net, &ck_a, 100), derive_hint(&ck_a, 100), "{net:?}: v2 hints never collide with v1 room hints");
        }
        assert_ne!(derive_ck_enc_key(&ck_a), derive_enc_key(&ck_a), "nor the sealing keys");
    }

    #[test]
    fn addr_entries_sort_canonically_and_dedupe() {
        let mut entries = vec![
            AddrEntry { addr: "198.51.100.9:2".parse().unwrap(), flags: 0 },
            AddrEntry { addr: "198.51.100.9:1".parse().unwrap(), flags: 0 },
            AddrEntry { addr: "[2001:db8::2]:1".parse().unwrap(), flags: 1 },
            AddrEntry { addr: "198.51.100.9:1".parse().unwrap(), flags: 0 },
            AddrEntry { addr: "[2001:db8::1]:9".parse().unwrap(), flags: 0 },
        ];
        sort_addr_entries(&mut entries);
        let shown: Vec<String> = entries.iter().map(|e| e.addr.to_string()).collect();
        assert_eq!(shown, vec!["[2001:db8::1]:9", "[2001:db8::2]:1", "198.51.100.9:1", "198.51.100.9:2"]);
    }
}

/// ⛓️ The network tag (stage 4 design §3.5; §12, "Network tag"): testnet11's
/// hints, associated data and sealed records are the bytes origin/main made,
/// mainnet's carry its genesis challenge, and a blob sealed on one network
/// opens on that network alone. Pure: every test names its network or runs
/// over `ChiaNet::ALL`, and none reads the environment.
#[cfg(test)]
mod network_tag_tests {
    use super::*;
    use std::collections::HashMap;

    /// The fixed public test inputs the vectors are taken at, nobody's keys:
    /// a contact key, a host's contact key, a room key (whose lane token the
    /// inbox hint and the knock's seal take), the parent of a carrier coin,
    /// and two eras: 0, and 2,917, whose little-endian bytes differ from its
    /// big-endian ones, so an era written in the other order fails a row.
    const CK: [u8; 32] = [0x11; 32];
    const CK_HOST: [u8; 32] = [0x22; 32];
    const ROOM_KEY: [u8; 32] = [0x33; 32];
    const PARENT: [u8; 32] = [0x44; 32];
    const ERAS: [u64; 2] = [0, 2_917];
    const KINDS: [u8; 3] = [KIND_PRESENCE, KIND_KNOCK, KIND_BEACON];
    /// Mainnet's genesis challenge, as chia_network.rs pins it against the
    /// consensus constants: G, written out so the AAD rows below are
    /// literals end to end.
    const MAINNET_G_HEX: &str = "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb";

    fn lane() -> [u8; 32] {
        derive_lane_token(&ROOM_KEY)
    }

    /// One network's hints at [`ERAS`]: the listing hint of `CK`, the inbox
    /// hint of `CK_HOST` for `ROOM_KEY`'s lane, and the beacon hint.
    struct Hints {
        net: ChiaNet,
        ck: [&'static str; 2],
        inbox: [&'static str; 2],
        beacon: [&'static str; 2],
    }

    /// testnet11's row was printed by origin/main's own code (247bc685, the
    /// tree before the tag) from the inputs above, by a test that was then
    /// removed, and copied here: it pins that the tag changed no testnet11
    /// hint. Mainnet's row was printed by this file's code once the tag came
    /// in, from the same inputs, and pins mainnet's bytes from here on; that
    /// they are G appended to testnet11's material is checked from the parts
    /// in `every_material_and_aad_is_the_designs_with_g_appended_on_mainnet_alone`.
    const HINTS: [Hints; 2] = [
        Hints {
            net: ChiaNet::Testnet11,
            ck: [
                "b9fa257280923f7d663097ff3319a04237eb76e0a413bc9e125f9edaef2d756b",
                "cca80e5c8202aa539beff719941e7bcd72f5ea12ba0613dc8bc1bdf0ff5e1e37",
            ],
            inbox: [
                "3a3d6c8a97d2d7b9d4d5a7759d05704d890df8be1dfd39b2d6ce41289d800dc7",
                "ff81776361adc62a5526c9b3060c8b30ce5b08152d44ad37d744d1292154ee83",
            ],
            beacon: [
                "97052f887e08732ed000b3d153b6f4d66693c832c03de85849bf6f62fe1f05e0",
                "488ca45f8625d6e4c8cf7799c7c38db52809f56049be004ca49ffac6e0796f11",
            ],
        },
        Hints {
            net: ChiaNet::Mainnet,
            ck: [
                "c683258f0dd065b86c73877be9636687dd32453657b676afdf94220e1aaa434e",
                "07910dcce4eade3b761983c151a2b558cb9981c7fdb82146d86e3db5362cce0a",
            ],
            inbox: [
                "bbf0a46d2063df8aa9e23e8e04705be0cbfc641b9d3c71c72fa55a25e6e8a51a",
                "d167c1a12dda25f87350c64b573bc6b1423afa4fd4a175c0981bb2759b7c63e6",
            ],
            beacon: [
                "d72c8f91b0fc04621042d80493d8956df57479742bf95f331f6f433dd682ee51",
                "6ca76f688aaf2b8d8e630ca14e1ac95c375376ad7323e25141ce91ed1fcc613e",
            ],
        },
    ];

    /// testnet11's `v2_aad` for each kind (presence, knock, beacon) at each of
    /// [`ERAS`], printed by origin/main's own code (247bc685) as `HINTS`'s
    /// testnet11 row was: the record prefix, the kind and the era, no tag.
    const TESTNET11_V2_AAD: [[&str; 3]; 2] = [
        [
            "7373662d636869612d7265636f72642d7632010000000000000000",
            "7373662d636869612d7265636f72642d7632020000000000000000",
            "7373662d636869612d7265636f72642d7632030000000000000000",
        ],
        [
            "7373662d636869612d7265636f72642d763201650b000000000000",
            "7373662d636869612d7265636f72642d763202650b000000000000",
            "7373662d636869612d7265636f72642d763203650b000000000000",
        ],
    ];

    /// testnet11's `kx_aad` for `KIND_KNOCK` at each of [`ERAS`], with
    /// `PARENT` and `ROOM_KEY`'s lane, printed by origin/main's own code
    /// (247bc685): its `v2_aad`, then the parent, then the lane. The other two
    /// kinds' rows that run printed differ only in the kind byte, which
    /// `TESTNET11_V2_AAD` pins, and are checked through it below.
    #[cfg(feature = "chia-read")]
    const TESTNET11_KX_AAD_KNOCK: [&str; 2] = [
        "7373662d636869612d7265636f72642d763202000000000000000044444444444444444444444444444444444444444444444444444444444444448ed62acafecb71900f604a7d4a9e33cfabbe0e895442851c1e4ee61881c47c0d",
        "7373662d636869612d7265636f72642d763202650b00000000000044444444444444444444444444444444444444444444444444444444444444448ed62acafecb71900f604a7d4a9e33cfabbe0e895442851c1e4ee61881c47c0d",
    ];

    /// A record origin/main's own code sealed (247bc685): `[0x66; 32]` sealed
    /// under `CK` for `KIND_PRESENCE` in era 2,917, nonce and all, by the same
    /// removed test. A testnet11 reader with the tag still opens it, which is
    /// what "the sealed records stay byte for byte" means for a reader: every
    /// testnet11 record already on chain still reads.
    const TESTNET11_SEALED_V2: &str = "58a1eadea7e1b1650b579f75046964b3b94722db4d3d4c109dee5a7493f2292ad9f63135b206939c40fdd4fc499988a802f1a8604e9c9fb581c05c0f0ba9660e631b59b1c0564c80";
    /// The X25519 secret the knock below was sealed to (its public key is the
    /// host card key `mul_base_clamped([0x77; 32])`): test bytes, nobody's.
    #[cfg(feature = "chia-read")]
    const KX_HOST_SK: [u8; 32] = [0x77; 32];
    /// A knock origin/main's own code sealed (247bc685): `[0x66; 32]` sealed to
    /// `KX_HOST_SK`'s public key for `KIND_KNOCK` in era 2,917, carried under
    /// `PARENT`, for `ROOM_KEY`'s lane, ephemeral key and nonce and all.
    #[cfg(feature = "chia-read")]
    const TESTNET11_SEALED_KX: &str = "d92a8c1975c0677fe84316f63c722e0c4dcfc91201a8349bfd3bad513aaa1131035a1f98969c870475d0c5269517a110ba031de53f747cb431f151813ba7c1d25fa4c6a6b899d0b19d9675aa54a73a5f5fc4e2e804250aa8b520c08b4215f9aa9947db06e2a980bc";
    const SEALED_PLAIN: [u8; 32] = [0x66; 32];

    /// The tag is a match on each network: nothing on testnet11, mainnet's
    /// genesis challenge on mainnet. The match here is exhaustive too, so a
    /// network added later fails to compile this test until its tag is
    /// chosen and pinned.
    #[test]
    fn the_network_tag_is_nothing_on_testnet11_and_the_genesis_on_mainnet() {
        for net in ChiaNet::ALL {
            match net {
                ChiaNet::Testnet11 => assert_eq!(network_tag(net), None),
                ChiaNet::Mainnet => {
                    assert_eq!(network_tag(net), Some(net.genesis()));
                    assert_eq!(hex::encode(network_tag(net).unwrap()), MAINNET_G_HEX);
                }
            }
        }
        assert_ne!(network_tag(ChiaNet::Mainnet), Some(ChiaNet::Testnet11.genesis()), "never the other network's genesis");
    }

    /// §12 Network tag: testnet11's hints are origin/main's bytes, and
    /// mainnet's are its own pinned bytes (see [`HINTS`] for where each row
    /// came from).
    #[test]
    fn each_networks_hints_match_the_pinned_vectors() {
        assert_eq!(HINTS.map(|h| h.net), ChiaNet::ALL, "one row per network");
        assert_eq!(hex::encode(lane()), "8ed62acafecb71900f604a7d4a9e33cfabbe0e895442851c1e4ee61881c47c0d", "the lane token, as origin/main made it");
        for h in &HINTS {
            for (i, era) in ERAS.into_iter().enumerate() {
                assert_eq!(hex::encode(derive_ck_hint(h.net, &CK, era)), h.ck[i], "{:?}: listing hint, era {era}", h.net);
                assert_eq!(hex::encode(derive_inbox_hint(h.net, &CK_HOST, &lane(), era)), h.inbox[i], "{:?}: inbox hint, era {era}", h.net);
                assert_eq!(hex::encode(derive_beacon_hint(h.net, era)), h.beacon[i], "{:?}: beacon hint, era {era}", h.net);
            }
        }
    }

    /// §12 Network tag: testnet11's associated data is origin/main's bytes
    /// for every kind and era, and mainnet's is those bytes with G appended
    /// (the kx AAD: testnet11's `v2_aad`, then G, then the parent and the
    /// lane), all from literals.
    #[test]
    fn each_networks_aads_match_the_pinned_vectors() {
        for (i, era) in ERAS.into_iter().enumerate() {
            for (k, kind) in KINDS.into_iter().enumerate() {
                let t11 = TESTNET11_V2_AAD[i][k];
                assert_eq!(hex::encode(v2_aad(ChiaNet::Testnet11, kind, era)), t11, "testnet11: kind {kind}, era {era}");
                assert_eq!(hex::encode(v2_aad(ChiaNet::Mainnet, kind, era)), format!("{t11}{MAINNET_G_HEX}"), "mainnet: kind {kind}, era {era}");
                #[cfg(feature = "chia-read")]
                {
                    let tail = format!("{}{}", hex::encode(PARENT), hex::encode(lane()));
                    if kind == KIND_KNOCK {
                        assert_eq!(format!("{t11}{tail}"), TESTNET11_KX_AAD_KNOCK[i], "the pinned knock row is the v2 row, the parent and the lane");
                    }
                    assert_eq!(hex::encode(kx_aad(ChiaNet::Testnet11, kind, era, &PARENT, &lane())), format!("{t11}{tail}"), "testnet11 kx: kind {kind}, era {era}");
                    assert_eq!(
                        hex::encode(kx_aad(ChiaNet::Mainnet, kind, era, &PARENT, &lane())),
                        format!("{t11}{MAINNET_G_HEX}{tail}"),
                        "mainnet kx: kind {kind}, era {era}"
                    );
                }
            }
        }
    }

    /// §3.5 recomputed from its parts, with blake3's incremental hasher and
    /// the contexts as the design and the code name them, not this file's
    /// constants or buffers: each hint's material is its fixed-width fields,
    /// with G appended on mainnet alone, and the v2 AAD is the prefix, the
    /// kind and the era, G appended on mainnet alone. The tag here is a
    /// match of this test's own, so a slip in `network_tag` or in one
    /// derivation's call to it fails here as well as against the vectors.
    #[test]
    fn every_material_and_aad_is_the_designs_with_g_appended_on_mainnet_alone() {
        let derive = |context: &str, parts: &[&[u8]]| -> [u8; 32] {
            let mut h = blake3::Hasher::new_derive_key(context);
            for p in parts {
                h.update(p);
            }
            h.finalize().into()
        };
        let g = ChiaNet::Mainnet.genesis();
        for net in ChiaNet::ALL {
            let tag: &[u8] = match net {
                ChiaNet::Testnet11 => &[],
                ChiaNet::Mainnet => &g,
            };
            for era in [0u64, 1, 2_917, 1 << 40, u64::MAX] {
                let e = era.to_le_bytes();
                for ck in [CK, [0x12; 32], [0u8; 32]] {
                    assert_eq!(derive_ck_hint(net, &ck, era), derive("ssf-chia-ck-hint-v1", &[&ck, &e, tag]), "{net:?}: listing hint, era {era}");
                }
                for room in [ROOM_KEY, [0x34; 32]] {
                    let lane = derive_lane_token(&room);
                    assert_eq!(
                        derive_inbox_hint(net, &CK_HOST, &lane, era),
                        derive("ssf-chia-inbox-hint-v1", &[&CK_HOST, &lane, &e, tag]),
                        "{net:?}: inbox hint, era {era}"
                    );
                }
                assert_eq!(derive_beacon_hint(net, era), derive("ssf-chia-beacon-hint-v1", &[&e, tag]), "{net:?}: beacon hint, era {era}");
                for kind in KINDS {
                    let want = [b"ssf-chia-record-v2".as_slice(), &[kind], &e, tag].concat();
                    assert_eq!(v2_aad(net, kind, era), want, "{net:?}: v2 AAD, kind {kind}, era {era}");
                    #[cfg(feature = "chia-read")]
                    assert_eq!(kx_aad(net, kind, era, &PARENT, &lane()), [want.as_slice(), &PARENT, &lane()].concat(), "{net:?}: kx AAD, kind {kind}, era {era}");
                }
            }
        }
    }

    /// §12 Network tag, "mainnet different": over a small grid of contact
    /// keys, hosts, rooms and eras, no hint of either network is any other
    /// hint of either network, nor a v1 room hint of the same bytes. So
    /// mainnet differs from testnet11 for every derivation and input here,
    /// and on each network the hints still differ per contact key, host,
    /// room and era, an inbox hint is never a listing hint, and v2 hints
    /// never collide with v1's. The associated data differs per network
    /// for every kind and era too.
    #[test]
    fn no_hint_of_one_network_is_a_hint_of_the_other_or_of_its_own_other_inputs() {
        let eras = [0u64, 1, 2_917, u64::MAX];
        let cks = [CK, [0x12; 32], [0u8; 32]];
        let mut seen: HashMap<[u8; 32], String> = HashMap::new();
        let mut add = |hint: [u8; 32], name: String| {
            if let Some(before) = seen.insert(hint, name.clone()) {
                panic!("{name} and {before} share a hint");
            }
        };
        for net in ChiaNet::ALL {
            for era in eras {
                for ck in cks {
                    add(derive_ck_hint(net, &ck, era), format!("{net:?} listing(ck {:02x}, era {era})", ck[0]));
                }
                for host in [CK_HOST, CK] {
                    for room in [ROOM_KEY, [0x34; 32]] {
                        let name = format!("{net:?} inbox(host {:02x}, room {:02x}, era {era})", host[0], room[0]);
                        add(derive_inbox_hint(net, &host, &derive_lane_token(&room), era), name);
                    }
                }
                add(derive_beacon_hint(net, era), format!("{net:?} beacon(era {era})"));
            }
        }
        for era in eras {
            for ck in cks {
                add(derive_hint(&ck, era), format!("v1 room hint(key {:02x}, epoch {era})", ck[0]));
            }
        }
        assert_eq!(seen.len(), 2 * eras.len() * (3 + 4 + 1) + eras.len() * 3, "every hint of the grid is its own");
        for era in eras {
            for kind in KINDS {
                assert_ne!(v2_aad(ChiaNet::Testnet11, kind, era), v2_aad(ChiaNet::Mainnet, kind, era), "kind {kind}, era {era}");
                #[cfg(feature = "chia-read")]
                assert_ne!(
                    kx_aad(ChiaNet::Testnet11, kind, era, &PARENT, &lane()),
                    kx_aad(ChiaNet::Mainnet, kind, era, &PARENT, &lane()),
                    "kind {kind}, era {era}"
                );
            }
        }
    }

    /// Records origin/main sealed still open on testnet11 with the tag in
    /// place, and do not open on mainnet: a testnet11 reader loses nothing
    /// already on chain, and mainnet reads none of it.
    #[test]
    fn testnet11_blobs_sealed_by_origin_main_still_open_on_testnet11_alone() {
        let sealed = hex::decode(TESTNET11_SEALED_V2).unwrap();
        assert_eq!(open_v2(ChiaNet::Testnet11, &CK, KIND_PRESENCE, 2_917, &sealed).unwrap(), SEALED_PLAIN.to_vec());
        assert!(open_v2(ChiaNet::Mainnet, &CK, KIND_PRESENCE, 2_917, &sealed).is_err(), "mainnet's AAD carries G");
        #[cfg(feature = "chia-read")]
        {
            let sealed = hex::decode(TESTNET11_SEALED_KX).unwrap();
            let open = |net| open_with_kx(net, &KX_HOST_SK, KIND_KNOCK, 2_917, &PARENT, &lane(), &sealed);
            assert_eq!(open(ChiaNet::Testnet11).unwrap(), SEALED_PLAIN.to_vec());
            assert!(open(ChiaNet::Mainnet).is_err(), "mainnet's kx AAD carries G");
        }
    }

    /// §3.5, "That covers both seals": a blob sealed under a contact key, or
    /// sealed to a card key, on one network opens on that network and is
    /// refused on the other, for every kind and era; within one network it
    /// still round-trips.
    #[test]
    fn a_blob_sealed_on_one_network_opens_on_that_network_alone() {
        #[cfg(feature = "chia-read")]
        let host_pk = curve25519_dalek::MontgomeryPoint::mul_base_clamped(KX_HOST_SK).to_bytes();
        for net in ChiaNet::ALL {
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            for era in ERAS {
                for kind in KINDS {
                    let blob = seal_v2(net, &CK, kind, era, &SEALED_PLAIN).unwrap();
                    assert_eq!(open_v2(net, &CK, kind, era, &blob).unwrap(), SEALED_PLAIN.to_vec(), "{net:?}: kind {kind}, era {era}");
                    assert!(open_v2(other, &CK, kind, era, &blob).is_err(), "sealed on {net:?}, read on {other:?}: kind {kind}, era {era}");
                    #[cfg(feature = "chia-read")]
                    {
                        let blob = seal_to_kx(net, &host_pk, kind, era, &PARENT, &lane(), &SEALED_PLAIN).unwrap();
                        let open = |on| open_with_kx(on, &KX_HOST_SK, kind, era, &PARENT, &lane(), &blob);
                        assert_eq!(open(net).unwrap(), SEALED_PLAIN.to_vec(), "{net:?}: kx, kind {kind}, era {era}");
                        assert!(open(other).is_err(), "kx sealed on {net:?}, read on {other:?}: kind {kind}, era {era}");
                    }
                }
            }
        }
    }
}
