//! ChiaHub lane — the chain-independent half: record types, canonical signing,
//! room-key-derived encryption, epoch-rotated lookup hints and a startup
//! self-test. All of it runs and is unit-tested without touching a network.
//!
//! Two record generations live here. v1 (JSON, sealed under a ROOM key, daily
//! epoch hints) is what #238 shipped and stays readable for two eras. v2
//! (#231 P6a, the fixed-layout block below) is sealed under a per-NODE contact
//! key and filed by the chain's own clock, the seven-day era; the node's
//! presence moves there, and the room-keyed publish retires one release later.
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
/// for `SSF_CHIA_LANE=1` and a build with the `chia-publish` feature.
pub fn startup_status(secret: &iroh::SecretKey, live_addrs: &[String]) {
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
    let reads = if !cfg!(feature = "chia-read") {
        "not built"
    } else if std::env::var("SSF_CHIA_WATCH").ok().as_deref() == Some("0") {
        "rung-6 only (watcher off: SSF_CHIA_WATCH=0)"
    } else {
        "on (rung-6 resolve + beat watcher)"
    };
    let publish = if !cfg!(feature = "chia-publish") {
        "not built"
    } else if std::env::var("SSF_CHIA_LANE").ok().as_deref() == Some("1") {
        "on (SSF_CHIA_LANE=1; testnet11, faucet TXCH)"
    } else {
        "off (set SSF_CHIA_LANE=1 to publish presence)"
    };
    println!(
        "⛓️ ChiaHub lane: crypto self-test {} · chain reads {reads} · publishing {publish}",
        if ok { "PASSED" } else { "FAILED" },
    );
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
//     hint = blake3::derive_key("ssf-chia-ck-hint-v1", ck ‖ era_le)
//
// Readers scan the current era and the one before. A record is VALID only if
// the block that confirmed it lies inside the era it is filed under, so a hint
// pre-filled for a future era, or an old ciphertext replayed later, is
// worthless. Kind and era are SIGNED into every record (a presence record
// cannot be re-filed as a knock, nor under another era), the layout is FIXED
// at [`RECORD_V2_LEN`] bytes (one size class: no length leaks what a record
// holds), and the sealed blob binds kind ‖ era as associated data. Nothing on
// chain is keyed by a room.
//
// Three kinds share the header; this file ships the presence codec. The knock
// (joiner → host inbox, sealed to the host's `kx_pk`) and the opt-in beacon
// (D7) land with P6b, which also carries the cards in passes.

/// Blocks per era: seven days at testnet11's ~18.75 s block time.
pub const ERA_BLOCKS: u32 = 32_256;
/// An era's length in seconds, for the time-based fallbacks (`expires_at`,
/// an inbound-verified mark taken while the chain peak was unknown).
pub const ERA_SECS: u64 = 7 * 24 * 3600;
/// Record kinds, signed into the header. Knock and beacon are P6b's; their
/// values are fixed here so no later record can collide with presence.
pub const KIND_PRESENCE: u8 = 1;
#[allow(dead_code)]
pub const KIND_KNOCK: u8 = 2;
#[allow(dead_code)]
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

/// Lookup hint for a contact key in an era.
pub fn derive_ck_hint(ck: &[u8; 32], era: u64) -> [u8; 32] {
    let mut material = [0u8; 40];
    material[..32].copy_from_slice(ck);
    material[32..].copy_from_slice(&era.to_le_bytes());
    blake3::derive_key(CTX_CK_HINT, &material)
}

/// The sealing key for a contact key: whoever holds `ck` reads the records
/// under it, nobody else.
pub fn derive_ck_enc_key(ck: &[u8; 32]) -> [u8; 32] {
    blake3::derive_key(CTX_CK_ENC, ck)
}

fn v2_aad(kind: u8, era: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(V2_AAD_PREFIX.len() + 9);
    aad.extend_from_slice(V2_AAD_PREFIX);
    aad.push(kind);
    aad.extend_from_slice(&era.to_le_bytes());
    aad
}

/// Seal a v2 plaintext under `ck` for `kind` in `era`:
/// `[24B XNonce ‖ XChaCha20-Poly1305 ciphertext]`, kind ‖ era as associated data.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read-only build never seals
pub fn seal_v2(ck: &[u8; 32], kind: u8, era: u64, plaintext: &[u8]) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::Payload;
    let key = derive_ck_enc_key(ck);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let mut nonce = [0u8; 24];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
    let aad = v2_aad(kind, era);
    let ciphertext = cipher
        .encrypt(XNonce::from_slice(&nonce), Payload { msg: plaintext, aad: &aad })
        .map_err(|e| anyhow!("seal_v2 failed: {e:?}"))?;
    let mut out = Vec::with_capacity(24 + ciphertext.len());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Open a v2 blob sealed under `ck` for `kind` in `era`. Fails on a wrong key,
/// a tampered blob, or a blob sealed for another kind or era.
pub fn open_v2(ck: &[u8; 32], kind: u8, era: u64, sealed: &[u8]) -> Result<Vec<u8>> {
    use chacha20poly1305::aead::Payload;
    if sealed.len() < 24 {
        return Err(anyhow!("sealed v2 blob too short"));
    }
    let key = derive_ck_enc_key(ck);
    let cipher = XChaCha20Poly1305::new((&key).into());
    let aad = v2_aad(kind, era);
    cipher
        .decrypt(XNonce::from_slice(&sealed[..24]), Payload { msg: &sealed[24..], aad: &aad })
        .map_err(|e| anyhow!("open_v2 failed (wrong contact key, kind or era?): {e:?}"))
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
        let slot = &mut buf[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN];
        match entry.addr.ip() {
            std::net::IpAddr::V4(v4) => {
                slot[0] = 4;
                slot[1..5].copy_from_slice(&v4.octets());
            }
            std::net::IpAddr::V6(v6) => {
                slot[0] = 6;
                slot[1..17].copy_from_slice(&v6.octets());
            }
        }
        slot[17..19].copy_from_slice(&entry.addr.port().to_le_bytes());
        slot[19] = entry.flags;
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
        let slot = &bytes[OFF_ADDRS + i * ADDR_SLOT_LEN..OFF_ADDRS + (i + 1) * ADDR_SLOT_LEN];
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
        addrs.push(AddrEntry { addr: std::net::SocketAddr::new(ip, port), flags: slot[19] });
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

#[cfg(test)]
mod tests {
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
        let sealed = seal_v2(&ck, KIND_PRESENCE, 42, &plain).unwrap();
        assert_eq!(sealed.len(), 24 + RECORD_V2_LEN + 16, "one size class on chain: nonce + body + tag");
        let opened = open_v2(&ck, KIND_PRESENCE, 42, &sealed).unwrap();
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
        let sealed = seal_v2(&ck, KIND_PRESENCE, 42, &plain).unwrap();
        assert!(open_v2(&ck, KIND_PRESENCE, 43, &sealed).is_err(), "replayed under the next era's hint: refused");
        assert!(open_v2(&ck, KIND_KNOCK, 42, &sealed).is_err(), "re-filed as a knock: refused");
        assert!(open_v2(&[6u8; 32], KIND_PRESENCE, 42, &sealed).is_err(), "another contact key: refused");
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
        assert_ne!(derive_ck_hint(&ck_a, 100), derive_ck_hint(&ck_a, 101));
        assert_ne!(derive_ck_hint(&ck_a, 100), derive_ck_hint(&ck_b, 100));
        assert_eq!(derive_ck_hint(&ck_a, 100), derive_ck_hint(&ck_a, 100));
        assert_ne!(derive_ck_hint(&ck_a, 100), derive_hint(&ck_a, 100), "v2 hints never collide with v1 room hints");
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
