use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use yrs::{
    encoding::write::Write,
    updates::decoder::Decode,
    updates::encoder::{Encoder, EncoderV1},
    Doc, StateVector, Transact, Update,
    ReadTxn,
};
use wtransport::{Connection, Endpoint as WtEndpoint, Identity, ServerConfig};
use iroh::{Endpoint as IrohEndpoint, EndpointAddr, PublicKey, RelayMap, RelayUrl, SecretKey};
use iroh::endpoint::presets::Minimal;

mod chia_lane;
// 📦 The blob lane (media plan §4 step 1): a member's file as a verified
// BLAKE3 blob, fetched on the local page's FETCH and played from this node.
mod blob_lane;
#[cfg(feature = "torrent")]
mod torrent_lane;
// S‑0 (#231 D1, TODO #13): the chain-access seam and the peer lane behind it.
// Every chain read and push below goes through the seam's trait; the lane
// reaches Chia full-node peers over the light-wallet protocol (no gateway).
#[cfg(feature = "chia-read")]
mod chia_chain;
#[cfg(feature = "chia-read")]
mod chia_peer;
#[cfg(feature = "chia-read")]
mod chia_peer_lane;
// Chain READS (#231 D3: in the default build): per-room caps, the generic hint
// reader and the P1 beat/hold watcher.
#[cfg(feature = "chia-read")]
mod chia_rooms;
// #231 P6a: the node's contact key, contact cards, the address book and the
// inbound-verified ledger — what finds a NODE on chain without a room key.
#[cfg(feature = "chia-read")]
mod chia_contact;
#[cfg(feature = "chia-read")]
mod chia_resolve;
#[cfg(feature = "chia-read")]
mod chia_watch;
/// #231 P6b: the knock book (knocks sent and read, the rendezvous schedule).
#[cfg(feature = "chia-read")]
mod chia_knock;
// The faucet dish's coin (#231 onboarding phase): per-room address, status,
// and — in a publish build — the keyless claim and the give spend.
#[cfg(feature = "chia-read")]
mod chia_faucet;
// 📌 #315: sealed room-board bundles any connected node carries and only the
// room's pass holders read (the ChiaHub seal and hint, reused).
#[cfg(feature = "chia-read")]
mod board_bundles;
// Chain WRITES (`chia-publish`, runtime-gated by SSF_CHIA_LANE=1): wallet seed,
// spend-to-self publish, craps fairness.
#[cfg(feature = "chia-publish")]
mod chia_wallet;
#[cfg(feature = "chia-publish")]
mod chia_publish;
#[cfg(feature = "chia-publish")]
mod chia_craps_fair;
// Treasury PR B: canonical contracts codec, golden-vector-matched against the
// browser's src/treasuryTypes.ts. Chain IO for it arrives with PR D's treasury
// module; gated with the publish half of the lane so CI compiles and tests it.
#[cfg(feature = "chia-publish")]
mod treasury_codec;

mod b64 {
    use base64::prelude::*;
    use serde::{de::Error, Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &Vec<u8>, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&BASE64_STANDARD.encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        BASE64_STANDARD.decode(String::deserialize(d)?).map_err(Error::custom)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SsfEnvelope {
    pub v: u32,
    pub room: String,
    pub kind: String, // tick | awareness | ysync | roomlog | asset | cap | faucet | ping | pong
    pub seq: u32,
    #[serde(with = "b64")]
    pub author: Vec<u8>,
    #[serde(with = "b64")]
    pub payload: Vec<u8>,
    pub sig: Option<String>,
    /// Carrying the sender's Iroh Node ID so peers know how to back-dial
    pub iroh_node_id: Option<String>,
    pub iroh_relay_urls: Option<Vec<String>>,
    pub iroh_direct_addrs: Option<Vec<String>>,
    /// M3: the browser's trust tier for the dial target carried by this envelope
    /// (direct=3 > room=2 > introduced=1 > unvetted=0). Advisory ORDERING only —
    /// the hard node-side gate is sig-Valid; a compromised browser could lie about
    /// tier but only about keys it could already dial. `None` ⇒ unvetted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust_tier: Option<u8>,
    /// M4: the FULL room roster's dial hints from the bootstrap (was only
    /// memberHints[0]). The node bootstrap-dials every member, so if the primary
    /// host is unreachable another reachable member still bootstraps us — and the
    /// node learns the whole roster instead of one host. `None`/absent on legacy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iroh_member_hints: Option<Vec<MemberHint>>,
}

/// One member's dial hints from the room bootstrap (M4). Field names match the
/// browser's camelCase `memberHints[]` shape so serde maps them directly.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MemberHint {
    #[serde(rename = "irohNodeId")]
    pub iroh_node_id: String,
    #[serde(rename = "irohRelayUrls", default)]
    pub iroh_relay_urls: Option<Vec<String>>,
    #[serde(rename = "irohDirectAddrs", default)]
    pub iroh_direct_addrs: Option<Vec<String>>,
}

// ── Slice 2: verify-before-apply seam (keyed identity) ───────────────────────

/// SSF_REQUIRE_SIG mode. Default `warn`: verify signed envelopes and LOG
/// mismatches but drop nothing (observe-then-enforce; the owner flips to
/// `reject` once the warn metric shows zero false drops). `off` skips checking.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum SigMode {
    Off,
    Warn,
    Reject,
}

static SIG_MODE: std::sync::OnceLock<SigMode> = std::sync::OnceLock::new();

fn sig_mode() -> SigMode {
    *SIG_MODE.get_or_init(|| {
        let m = match std::env::var("SSF_REQUIRE_SIG")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str()
        {
            "off" => SigMode::Off,
            "reject" => SigMode::Reject,
            _ => SigMode::Warn,
        };
        println!("🔒 SSF_REQUIRE_SIG mode: {:?} (Slice 2 verify-before-apply)", m);
        m
    })
}

/// Canonical envelope sign-bytes — MUST byte-match the browser (signBytes.ts):
/// blake3("ssf-env:v1\n{v}\n{room}\n{kind}\n{seq}\n" ‖ payload).
fn canonical_sign_bytes(v: u32, room: &str, kind: &str, seq: u32, payload: &[u8]) -> [u8; 32] {
    let header = format!("ssf-env:v1\n{}\n{}\n{}\n{}\n", v, room, kind, seq);
    let mut buf = Vec::with_capacity(header.len() + payload.len());
    buf.extend_from_slice(header.as_bytes());
    buf.extend_from_slice(payload);
    *blake3::hash(&buf).as_bytes()
}

#[derive(PartialEq, Eq)]
enum SigVerdict {
    Valid,
    Invalid,
    Unsigned,
}

/// Verify an envelope's Ed25519 signature over the canonical bytes. Missing sig,
/// or a non-32-byte / all-zero author (the Phase-1 dummy), is `Unsigned` (legacy,
/// always allowed); a present sig that fails to verify is `Invalid`.
fn verify_envelope_sig(env: &SsfEnvelope) -> SigVerdict {
    let sig_b64 = match &env.sig {
        Some(s) if !s.is_empty() => s,
        _ => return SigVerdict::Unsigned,
    };
    if env.author.len() != 32 || env.author.iter().all(|&b| b == 0) {
        return SigVerdict::Unsigned;
    }
    let pub_arr: [u8; 32] = match env.author.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return SigVerdict::Invalid,
    };
    let public = match PublicKey::from_bytes(&pub_arr) {
        Ok(p) => p,
        Err(_) => return SigVerdict::Invalid,
    };
    let sig_bytes = match base64::Engine::decode(&base64::prelude::BASE64_STANDARD, sig_b64) {
        Ok(b) => b,
        Err(_) => return SigVerdict::Invalid,
    };
    let sig_arr: [u8; 64] = match sig_bytes.as_slice().try_into() {
        Ok(a) => a,
        Err(_) => return SigVerdict::Invalid,
    };
    let sig = iroh::Signature::from_bytes(&sig_arr);
    let canonical = canonical_sign_bytes(env.v, &env.room, &env.kind, env.seq, &env.payload);
    match public.verify(&canonical, &sig) {
        Ok(()) => SigVerdict::Valid,
        Err(_) => SigVerdict::Invalid,
    }
}

/// Slice 2 gate: true = DROP this envelope (skip relay + merge). Only reject-mode
/// + a present-but-INVALID signature drops; unsigned (legacy) and valid proceed.
/// Logs invalids under warn/reject so the false-drop metric is observable.
fn sig_should_drop(env: &SsfEnvelope, path: &str) -> bool {
    let mode = sig_mode();
    if mode == SigMode::Off {
        return false;
    }
    match verify_envelope_sig(env) {
        SigVerdict::Valid | SigVerdict::Unsigned => false,
        SigVerdict::Invalid => match mode {
            SigMode::Reject => {
                eprintln!(
                    "🔒 reject: DROPPED invalid-sig {} (room {}, seq {}, path {})",
                    env.kind, env.room, env.seq, path
                );
                true
            }
            _ => {
                eprintln!(
                    "🔎 warn: invalid-sig {} would drop (room {}, seq {}, path {})",
                    env.kind, env.room, env.seq, path
                );
                false
            }
        },
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Fingerprint {
    pub hex: String,
    pub base64: String,
    pub port: u16,
    pub iroh_node_id: String, // expose our Iroh Node ID to the browser client!
    pub iroh_relay_urls: Vec<String>,
    pub iroh_direct_addrs: Vec<String>,
    /// R1 live reachability classification (recomputed per API request):
    /// "port-mapped" | "advertised" | "cgnat" | "local-only" — see
    /// [`classify_reachability`] for exact semantics and the provenance
    /// inference. "advertised" is honest about being UNVERIFIED: we cannot
    /// probe inbound UDP without external infra, so the browser copy carries
    /// the caveat.
    pub reachability: String,
    /// R1: the iroh IPv4 UDP port ACTUALLY bound — after the random-port
    /// fallback when the default pin (44442) was taken. This is the port a
    /// router forward must target, so the UI must show this one, never a
    /// hardcoded default.
    pub iroh_port: u16,
    /// #231 P6b (#272 review round 3): whether this node hands out its contact
    /// card at all (a durable contact key and `SSF_CHIA_SHARE_CARD` not `0`).
    /// The browser keeps the card the node once handed it, so without this a
    /// restart with sharing off would leave the cached card riding in every
    /// private-room pass. Read live per request.
    #[serde(default)]
    pub share_card: bool,
    /// ⛓️🏦 The node's testnet11 receive address (`txch1…`) while a wallet is
    /// loaded (the publish build with `SSF_CHIA_LANE=1`), so the SpacePhone's
    /// Bank app can show where to send TXCH — COPY and a QR code — the way the
    /// faucet dish shows the jar's address. Read live per request from the
    /// wallet the hub holds; absent while no wallet is loaded. The fingerprint
    /// is the loopback API's answer to this machine's own browser: the address
    /// never rides in a pass or a card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chia_address: Option<String>,
    /// 📖 Whether this node's latest public addresses are listed in the Phone
    /// Book (its per-node presence record on Chia, #231 P6a): the SpacePhone's
    /// top bar draws a phone book from it, green when the current addresses
    /// are confirmed on chain, grey when an older listing has gone stale.
    /// Mirrored by the presence publisher each tick (chia_publish.rs); absent
    /// while the node does not publish presence (a read-only build, no wallet,
    /// `SSF_CHIA_FINDABLE=0`, no durable contact key). Loopback only, like the
    /// address: it never rides in a pass or a card.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chia_presence: Option<ChiaPresence>,
    /// 📦 This launch's blob-lane capability token (blob_lane.rs): every
    /// `/blob` and `/api/blob/` route asks for it beside an allowed Origin.
    /// Only a page whose origin the API grants can read the answer, and it
    /// changes at every start. Absent while the lane is not running.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_cap: Option<String>,
    /// 🧲 This node was built with the `torrent` feature and its blob lane is
    /// running, so the TV's TORRENT tile can hand it a magnet
    /// (torrent_lane.rs). Absent (false) otherwise.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub torrent: bool,
}

/// 📖 The node's Phone Book listing as the browser sees it (`Fingerprint::
/// chia_presence`). Defined here, always compiled, because the fingerprint
/// carries it in every build while the publisher that fills it
/// (chia_publish.rs) exists only with the `chia-publish` feature.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ChiaPresence {
    pub state: ChiaPresenceState,
    /// The current era (edition) by the agreed chain peak, 0 while no peak is
    /// agreed yet.
    pub era: u64,
    /// The era of the listing on record, 0 when there is none.
    pub listed_era: u64,
    /// Unix seconds of the last write on record, 0 when there is none.
    pub last_at: u64,
    /// The watcher has read the listing on record back from the chain.
    pub confirmed: bool,
    /// The listing on record is for this era and carries the node's current
    /// public address set.
    pub current: bool,
    /// How many public addresses the node would list right now.
    pub public_addrs: u32,
    /// The last publish error, kept until a write succeeds (the unfunded
    /// wallet is the one the Bank app can fix).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 📖 The four looks of the phone book icon.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChiaPresenceState {
    /// This era's listing is confirmed on chain with the current addresses.
    Listed,
    /// This era's listing with the current addresses is out, awaiting the
    /// watcher's confirmation.
    Sent,
    /// A listing exists but is stale: an older era, other addresses, or no
    /// agreed peak to judge it by.
    Outdated,
    /// No listing of ours on record (or the first one failed).
    Unlisted,
}

// ── Mesh tuning (M3/M5.x — see brainstorming/m345-v029-build-plan.md §2) ──────
/// Target gossip degree; O(N·D) fan-out stays cheap for 3–8 node rooms while
/// surviving a single-neighbor loss.
pub const TARGET_DEGREE: usize = 6;
/// Graft when the live neighbor set drops below this; prune above `D_HIGH`. The
/// ±2 hysteresis band around D keeps a churn blip from thrashing graft↔prune.
pub const D_LOW: usize = 4;
pub const D_HIGH: usize = 8;
/// M5.2: initial tick TTL (down-counted per hop). A bounded-degree mesh of ≤8
/// nodes has diameter ~2–3; 4 gives one hop of margin without unbounded flood.
pub const TICK_TTL_INIT: u8 = 4;
/// M5.1: heartbeat cadence + miss count. Prune a silent neighbor after
/// `HEARTBEAT_MISS × HEARTBEAT_INTERVAL` (~15s) — long enough to absorb
/// transient datagram loss before an expensive re-dial.
pub const HEARTBEAT_INTERVAL_SECS: u64 = 5;
pub const HEARTBEAT_MISS: u32 = 3;
/// Node→node heartbeat datagram magic (distinct length + prefix so it can never
/// be confused with a 13/14/22-byte tick or enter the ysync path).
pub const HEARTBEAT_MAGIC: &[u8; 6] = b"ssfhb\0";

/// M3 trust tiers, mirrored from the browser peerStore ordering
/// (direct/friend > room > introduced > unvetted). The node cannot compute
/// trust itself (the web-of-trust lives in the browser), so it receives a tier
/// hint on the dial-bearing envelope and defaults conservatively to unvetted.
pub const TIER_DIRECT: u8 = 3;
pub const TIER_ROOM: u8 = 2;
pub const TIER_INTRODUCED: u8 = 1;
pub const TIER_UNVETTED: u8 = 0;

/// Dial hints for a peer we may (re)dial or advertise via PX.
#[derive(Clone, Default)]
pub struct PeerHints {
    pub relay_urls: Vec<String>,
    pub direct_addrs: Vec<String>,
}

/// A CONNECTED remote peer plus the liveness + trust metadata the mesh needs:
/// M5.1 `last_seen` pruning, M3 `tier` ordering, M5.3 `in_mesh` neighbor-set
/// membership. `conn` is the live iroh connection the old map stored directly.
pub struct MemberEntry {
    pub conn: iroh::endpoint::Connection,
    pub last_seen: std::time::Instant,
    pub tier: u8,
    pub in_mesh: bool,
    pub hints: PeerHints,
    /// #231 P6a: our contact card went out on this connection (once per
    /// connection and room; the maintenance loop sends it in private rooms).
    #[cfg(feature = "chia-read")]
    pub card_sent: bool,
}

impl MemberEntry {
    fn new(conn: iroh::endpoint::Connection, tier: u8, in_mesh: bool, hints: PeerHints) -> Self {
        Self {
            conn,
            last_seen: std::time::Instant::now(),
            tier,
            in_mesh,
            hints,
            #[cfg(feature = "chia-read")]
            card_sent: false,
        }
    }
}

/// A KNOWN peer we are NOT yet connected to (learned from member hints, gossip,
/// or a PX advert) — a trust-ranked graft candidate for M5.3 when the neighbor
/// set falls below `D_LOW`.
#[derive(Clone)]
pub struct Candidate {
    pub tier: u8,
    pub hints: PeerHints,
    /// M5.3 churn guard (review LOW): don't re-graft a candidate before this
    /// instant. A permanently-unreachable member that gossip keeps re-introducing
    /// (e.g. a CGNAT peer) would otherwise be re-dialed every maintenance cycle.
    pub cooldown_until: Option<std::time::Instant>,
}

/// M5.3 (review MEDIUM): cap known-but-unconnected candidates per room so a peer
/// spraying self-signed roster/px entries can't grow the map without bound
/// (memory DoS). Lowest-tier candidates are evicted first.
pub const CANDIDATE_CAP: usize = 256;
/// M5.3 (review LOW): a failed graft candidate waits this long before re-dial.
pub const GRAFT_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(60);

/// Insert a graft candidate under the bounded cap. An existing key is updated in
/// place; at cap, the weakest-tier candidate is evicted first (never displacing a
/// higher-tier one), and a newcomer that is itself the weakest at cap is dropped.
fn insert_candidate_bounded(room: &mut Room, key: PublicKey, cand: Candidate) {
    if room.candidates.contains_key(&key) {
        room.candidates.insert(key, cand);
        return;
    }
    if room.candidates.len() >= CANDIDATE_CAP {
        if let Some((weak_key, weak_tier)) =
            room.candidates.iter().map(|(k, c)| (*k, c.tier)).min_by_key(|(_, t)| *t)
        {
            if cand.tier < weak_tier {
                return; // newcomer is the weakest at cap — drop it
            }
            room.candidates.remove(&weak_key);
        }
    }
    room.candidates.insert(key, cand);
}

// Global server state
pub struct Room {
    pub doc: Doc,
    pub local_connections: HashMap<SocketAddr, Connection>,
    /// M5.1/M5.3: connected remote peers keyed by node id, each carrying
    /// liveness (`last_seen`), trust (`tier`) and neighbor-set (`in_mesh`) state.
    pub remote_peers: HashMap<PublicKey, MemberEntry>,
    /// M5.3: known-but-unconnected peers, trust-ranked graft candidates.
    pub candidates: HashMap<PublicKey, Candidate>,
    /// M5.4: recently-relayed reliable envelopes, retained to answer IWANT pulls.
    pub retained: RetainStore,
    /// C2 (room durability): a LOCAL browser participated in this room, so this
    /// node's doc is an authoritative-enough replica to ANSWER relayed SyncStep1s
    /// from remote peers — the room stays alive after the browser closes. A room
    /// this node only ever relayed for (visitor pass-through) stays un-served.
    pub served: bool,
}

pub struct HubState {
    pub rooms: Mutex<HashMap<String, Room>>,
    pub fingerprint: Mutex<Fingerprint>,
    pub port: u16,
    pub configured_relays: Vec<String>,
    /// Relay dedup (0.18.0 hub-relay): envelopes seen/forwarded recently, keyed by
    /// blake3(origin_node_id ‖ seq ‖ payload). Prevents echo storms once meshes form.
    pub seen_envelopes: Mutex<SeenCache>,
    /// M5.2: SECOND, tick-scoped dedup cache (own keyspace). The tick lane had NO
    /// dedup — it relied on the hop-1 cap alone. Lifting that cap to a TTL flood
    /// (multi-hop) requires this or the mesh echo-storms in any cycle.
    pub tick_seen: Mutex<SeenCache>,
    /// M5.0: the node's own iroh secret key, so the reader loops can node-sign
    /// roster / graft / prune / px / ihave / iwant control envelopes.
    pub secret_key: SecretKey,
    /// In-flight dial single-flight (issue #60): peer keys we are CURRENTLY
    /// dialing. `remote_peers` only records a peer AFTER a dial succeeds, so
    /// during a slow hole-punch every browser envelope carrying the target's
    /// node id would otherwise spawn a fresh dial task — a connection storm.
    /// A key is claimed here before spawning the dial and released when it
    /// resolves (success, exhaustion, or already-linked).
    pub dialing: Mutex<std::collections::HashSet<PublicKey>>,
    /// R1: live reachability posture — written by the auto echo loop (and the
    /// explicit SSF_EXTERNAL_ADDRS parser), read by the fingerprint API.
    pub reach: Arc<ReachState>,
    /// Per-room key + flags the LOCAL browser hands us over the `cap` lane
    /// (chia-mode = publish toggle, public-room = N8 guard), so the node can
    /// derive the room's chia lookup hint and seal presence records. Loopback +
    /// trust-safe (we already hold the plaintext room doc). Read side (#231 D3),
    /// so it is in the default build.
    #[cfg(feature = "chia-read")]
    pub chia_rooms: Mutex<HashMap<String, chia_rooms::ChiaRoomCap>>,
    /// #231 P6a: this node's CONTACT KEY (`contact.key`) — what its per-node
    /// presence is filed under; handed to private-room members as a signed card.
    #[cfg(feature = "chia-read")]
    pub contact_key: [u8; 32],
    /// #231 P6a: `contact.key` could be loaded or written. When it could not,
    /// the key above is for this run only and nothing advertises it: no card
    /// is shared and no per-node presence is published, since both would go
    /// stale at the next start and contradict the node's one-key identity.
    #[cfg(feature = "chia-read")]
    pub contact_key_durable: bool,
    /// #231 P6a: the address book (`peers.json`): the contact and card keys of
    /// the peers that handed us their card, and the rooms we met them in.
    #[cfg(feature = "chia-read")]
    pub peers: Mutex<chia_contact::PeerBook>,
    /// #231 P6a: when this node last ACCEPTED an unsolicited direct inbound
    /// connection, per address family — the measured half of the presence
    /// record's reachability flags. Written by `run_iroh_listener` only.
    #[cfg(feature = "chia-read")]
    pub inbound_verified: Mutex<chia_contact::InboundVerified>,
    /// #231 P6a: peers whose dial ended lately, and when, kept for
    /// [`DIAL_PINHOLE_GRACE`]: the NAT mapping our Initials opened outlives
    /// the dial task, so an inbound connection from one of them inside the
    /// grace is not unsolicited and proves nothing about reachability.
    /// Written and pruned by `release_dial`, read and pruned by `dialed_lately`.
    #[cfg(feature = "chia-read")]
    pub recent_dials: Mutex<HashMap<PublicKey, std::time::Instant>>,
    /// #231 P6a: serializes contact-card sends with room-posture changes. The
    /// maintenance loop holds it from reading a room's posture through ONE
    /// send (bounded by `CARD_SEND_TIMEOUT`), card by card; the local browser's
    /// cap lane takes it before a cap is accepted. A cap turning a room public
    /// therefore waits for one send at most, lands between two, and the next
    /// send's check sees it, so no card authorized by a posture since replaced
    /// can leave.
    #[cfg(feature = "chia-read")]
    pub card_gate: tokio::sync::Mutex<()>,
    /// #231 P6a: the chain peak the watcher (or the publisher) read last, with
    /// the time of the read, as one snapshot: the era clock for the inbound
    /// marks and the presence publisher. Both trust it only while it is younger
    /// than `chia_resolve::PEAK_MAX_AGE_SECS`; the publisher otherwise asks the
    /// chain itself before an era-sensitive write, and a mark falls back to
    /// elapsed time, so a stalled watcher never dates anything into an era
    /// that has ended.
    #[cfg(feature = "chia-read")]
    pub chia_peak: Mutex<chia_resolve::ChainPeak>,
    /// #231 P6a: the signed `issued_at` of the newest presence record of OUR
    /// OWN the watcher read back from the chain (0 = none yet). The publisher
    /// marks its write confirmed when this is the write's own issued_at (its
    /// mark's `last_at`); until then the write is pending and retried after a
    /// timeout. An older record re-read inside the cursor overlap confirms nothing.
    #[cfg(feature = "chia-read")]
    pub presence_confirmed_at: std::sync::atomic::AtomicU64,
    /// #231 P6a: the presence publisher is running and findable (raised by the
    /// heartbeat loop at start). While it is, the watcher reads our own
    /// contact key every beat even with no room or peer to read for, since
    /// that read is what confirms a write: without it a landed record would be
    /// re-written at every confirmation timeout until the era's budget is spent.
    #[cfg(feature = "chia-read")]
    pub presence_publishing: std::sync::atomic::AtomicBool,
    /// #231 P6b: knocks the dial ladder asked for, waiting for the publisher
    /// (one spend per tick): queued when the hold toward a contact failed,
    /// drained by the heartbeat loop. RAM only — a knock not yet sent is
    /// re-decided by the next dial anyway.
    #[cfg(feature = "chia-read")]
    pub knock_queue: Mutex<std::collections::VecDeque<chia_knock::KnockRequest>>,
    /// #231 P6b: the knock queue has a consumer — the heartbeat loop was
    /// spawned (the publish build, `SSF_CHIA_LANE=1`, a wallet loaded) — and
    /// the watcher runs (`SSF_CHIA_WATCH` not 0), which judges a sent knock
    /// and dials at its rendezvous (`chia_knock::knocks_available`, #272 review
    /// round 14). Without both a queued knock would never leave, or would
    /// spend a coin its sender never dials on, so rung 6 promises none and
    /// says what a chain knock needs instead (round 11). Raised once at
    /// startup, before any dial runs.
    #[cfg(feature = "chia-read")]
    pub knock_publishing: std::sync::atomic::AtomicBool,
    /// #231 P6b: the knock book (`knocks.json`): knocks we sent (one per host
    /// per era) and knocks read from our inbox, each with the confirmation
    /// height both sides dial by.
    #[cfg(feature = "chia-read")]
    pub knocks: Mutex<chia_knock::KnockBook>,
    /// ⛓️🥣 The wallet key `SSF_CHIA_LANE=1` loaded at startup (publish build),
    /// so the faucet dish can TAKE (claim to our address) and GIVE (pay from our
    /// coin) on the local browser's request. `None` while publishing is off.
    #[cfg(feature = "chia-publish")]
    pub chia_wallet: Mutex<Option<chia_bls::SecretKey>>,
    /// 📖 The Phone Book listing state the presence publisher mirrors here
    /// each tick for the loopback fingerprint (`None` until its first tick,
    /// or for good while the node does not publish presence).
    #[cfg(feature = "chia-publish")]
    pub presence_status: Mutex<Option<ChiaPresence>>,
    /// 📦 The blob lane, or None when its store could not be opened (the
    /// node runs on without it; its routes answer 503).
    pub blobs: Option<Arc<blob_lane::BlobLane>>,
    /// 📌 #315: the board-bundle lane: the bundles this node carries for
    /// anyone (`board-bundles/`), what it published, and each peer's budget.
    /// Locked briefly, never across an await, never inside another lock.
    #[cfg(feature = "chia-read")]
    pub board_bundles: Mutex<board_bundles::BoardLane>,
}

/// R1 live reachability posture. The auto public-IP echo loop writes here as
/// it advertises/withdraws addresses and detects CGNAT; the fingerprint API
/// reads it per request so the browser HUD always shows the CURRENT state.
pub struct ReachState {
    /// Public v4 sockets WE advertised ourselves — via the echo auto loop or
    /// explicit `SSF_EXTERNAL_ADDRS` entries. Needed to tell "iroh discovered
    /// a public v4 on its own" (portmapper/QAD) apart from "we merely claimed
    /// one" in [`classify_reachability`].
    pub self_advertised: Mutex<std::collections::HashSet<SocketAddr>>,
    /// The last echo answer was a CGNAT/private WAN address (100.64.0.0/10
    /// etc.) — a router port-forward cannot produce inbound reachability
    /// there, so the node refuses to advertise (unchanged since 0.22.0) and
    /// now also SURFACES the condition instead of logging console-only.
    pub cgnat_detected: std::sync::atomic::AtomicBool,
}

impl ReachState {
    pub fn new() -> Self {
        Self {
            self_advertised: Mutex::new(std::collections::HashSet::new()),
            cgnat_detected: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

/// Classifies current reachability for the fingerprint API (R1).
///
/// Priority: cgnat > port-mapped > advertised > local-only.
///
/// PROVENANCE INFERENCE (documented per R1): iroh 1.0.1 tags every direct
/// address internally with its origin (`DirectAddrType::{Local, Qad,
/// Portmapped, Qad4LocalPort, Config}`) but the typed set never crosses the
/// public API — `Endpoint::watch_addr()` maps `DirectAddr` down to bare
/// `SocketAddr`s and the typed `Socket::ip_addrs()` watcher is pub(crate).
/// So we infer: a PUBLIC IPv4 in the live direct-addr set that we did NOT
/// advertise ourselves must have been produced by iroh — the portmapper
/// (UPnP/NAT-PMP/PCP) or a QAD-observed reflexive address. Both mean iroh
/// derived/verified a public v4 route, so the inference ranks them above our
/// own unverified echo advert and reports "port-mapped". Known limit: if the
/// portmapper maps the exact ip:port we also echo-advertised, it is
/// indistinguishable from our own advert and reports "advertised"
/// (understated, never overstated).
pub fn classify_reachability(reach: &ReachState, live_direct_addrs: &[String]) -> String {
    if reach.cgnat_detected.load(std::sync::atomic::Ordering::Relaxed) {
        return "cgnat".to_string();
    }
    let advertised = reach.self_advertised.lock().unwrap().clone();
    for addr_str in live_direct_addrs {
        if let Ok(sock) = addr_str.parse::<SocketAddr>() {
            if let std::net::IpAddr::V4(v4) = sock.ip() {
                if ipv4_is_public(v4) && !advertised.contains(&sock) {
                    return "port-mapped".to_string();
                }
            }
        }
    }
    if !advertised.is_empty() {
        return "advertised".to_string();
    }
    "local-only".to_string()
}

/// Bounded recently-seen set for relay loop protection.
pub struct SeenCache {
    set: std::collections::HashSet<[u8; 16]>,
    order: std::collections::VecDeque<[u8; 16]>,
}

impl SeenCache {
    pub fn new() -> Self {
        Self { set: std::collections::HashSet::new(), order: std::collections::VecDeque::new() }
    }
    /// Returns true if this key is fresh (and records it); false if already seen.
    pub fn check_and_insert(&mut self, key: [u8; 16]) -> bool {
        if self.set.contains(&key) {
            return false;
        }
        self.set.insert(key);
        self.order.push_back(key);
        while self.order.len() > 4096 {
            if let Some(old) = self.order.pop_front() {
                self.set.remove(&old);
            }
        }
        true
    }
}

/// Relay-dedup key: origin identity + ROOM + sequence + payload bytes.
///
/// The `room` component is load-bearing (v0.29.6 fix): `hub.seen_envelopes` is
/// ONE cache shared across every room, so a room-blind key let two DIFFERENT
/// rooms' byte-identical frames alias. That is not hypothetical — every YjsSync
/// opens with `SyncStep1 = encodeStateVector(emptyDoc)`, and an empty Y.Doc's
/// state vector is a CONSTANT. A browser running a DM provider (opened at app
/// load) and a room provider (opened on JUMP) emits both openers from the SAME
/// iroh node id at the same starting seq with the same empty-doc payload → an
/// identical `(node,seq,payload)` key. The DM's opener won the slot first, so
/// the room's SyncStep1 hit `check_and_insert()==false` and was dropped BEFORE
/// delivery — the host never answered with the room's SyncStep2 (players /
/// roomInfo / furniture), while the separately-keyed tick lane kept flowing.
/// (A wiped localStorage after a reinstall makes both docs empty → the openers
/// become byte-identical → deterministic collision; persisted non-empty docs
/// had distinct state vectors, which is why the same path synced before.)
///
/// A 0x1f unit separator keeps the two variable-length string fields
/// (origin_node_id, room) from concat-aliasing across the boundary.
fn envelope_seen_key(origin_node_id: &str, room: &str, seq: u32, payload: &[u8]) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(origin_node_id.as_bytes());
    hasher.update(&[0x1f]);
    hasher.update(room.as_bytes());
    hasher.update(&[0x1f]);
    hasher.update(&seq.to_le_bytes());
    hasher.update(payload);
    let hash = hasher.finalize();
    let mut key = [0u8; 16];
    key.copy_from_slice(&hash.as_bytes()[..16]);
    key
}

/// M5.2 tick-dedup key: blake3(origin_lane_id[8B] ‖ full 13B tick)[..16]. The
/// FULL tick payload is folded in (not just the u16 seq) so a wrapped seq —
/// which recurs every 65536/20 ≈ 54.6 min per sender — can never alias a fresh
/// tick and false-drop it. This is the loop-kill for the multi-hop tick flood.
fn tick_seen_key(origin_lane_id: &[u8; 8], tick: &[u8]) -> [u8; 16] {
    let mut hasher = blake3::Hasher::new();
    hasher.update(origin_lane_id);
    hasher.update(tick);
    let mut key = [0u8; 16];
    key.copy_from_slice(&hasher.finalize().as_bytes()[..16]);
    key
}

/// M5.4 cap: retained envelopes per room. Covers rate×fanout×diameter for IWANT
/// service; per-room (not the shared dedup cache) so a busy room can't evict its
/// own recent ids.
pub const ENVELOPE_RETAIN_CAP: usize = 2048;

/// M5.4 message id: blake3(author ‖ seq ‖ payload)[..16]. NOT (origin_node_id,
/// seq): sibling tabs share a node id with independent seq counters, so that
/// would alias distinct payloads. Keying on author + payload is collision-safe.
pub type MsgId = [u8; 16];

fn envelope_msg_id(author: &[u8], seq: u32, payload: &[u8]) -> MsgId {
    let mut hasher = blake3::Hasher::new();
    hasher.update(author);
    hasher.update(&seq.to_le_bytes());
    hasher.update(payload);
    let mut id = [0u8; 16];
    id.copy_from_slice(&hasher.finalize().as_bytes()[..16]);
    id
}

/// M5.4: a bounded per-room LRU of recently-relayed reliable envelopes so a peer
/// that missed one (a dropped frame) can pull it via IWANT instead of forcing a
/// re-flood. Stores full serialized envelopes — the `SeenCache` holds only 16B
/// hashes and cannot serve a pull.
pub struct RetainStore {
    map: HashMap<MsgId, Vec<u8>>,
    order: std::collections::VecDeque<MsgId>,
}

impl RetainStore {
    pub fn new() -> Self {
        Self { map: HashMap::new(), order: std::collections::VecDeque::new() }
    }
    pub fn put(&mut self, id: MsgId, bytes: Vec<u8>) {
        if self.map.contains_key(&id) {
            return;
        }
        self.map.insert(id, bytes);
        self.order.push_back(id);
        while self.order.len() > ENVELOPE_RETAIN_CAP {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
    }
    pub fn get(&self, id: &MsgId) -> Option<Vec<u8>> {
        self.map.get(id).cloned()
    }
    /// The `n` most-recently-retained ids, newest first (for an IHAVE advert).
    pub fn recent_ids(&self, n: usize) -> Vec<MsgId> {
        self.order.iter().rev().take(n).cloned().collect()
    }
}

/// 8-byte tick-lane sender id (0.23.0 wire, issue #22): blake3 over the given
/// identity parts, truncated. Tags every movement tick the node delivers so
/// browsers can key remote players by real sender instead of fabricating ids.
fn tick_lane_id(parts: &[&[u8]]) -> [u8; 8] {
    let mut hasher = blake3::Hasher::new();
    for part in parts {
        hasher.update(part);
    }
    let mut id = [0u8; 8];
    id.copy_from_slice(&hasher.finalize().as_bytes()[..8]);
    id
}

pub type SharedHub = Arc<HubState>;

pub fn compute_fingerprint(
    identity: &Identity,
    port: u16,
    iroh_node_id: &str,
    iroh_relay_urls: Vec<String>,
    iroh_direct_addrs: Vec<String>,
    reachability: String,
    iroh_port: u16,
) -> Result<Fingerprint> {
    let chain = identity.certificate_chain();
    let certs = chain.as_slice();
    if certs.is_empty() {
        return Err(anyhow!("No certs in chain"));
    }
    let digest = certs[0].hash();
    let result: &[u8; 32] = digest.as_ref();
    let hex = hex::encode(result);
    let base64 = base64::Engine::encode(&base64::prelude::BASE64_STANDARD, result);
    Ok(Fingerprint {
        hex,
        base64,
        port,
        iroh_node_id: iroh_node_id.to_string(),
        iroh_relay_urls,
        iroh_direct_addrs,
        reachability,
        iroh_port,
        share_card: false,
        chia_address: None,
        chia_presence: None,
        blob_cap: None,
        torrent: false,
    })
}

#[cfg(test)]
mod fingerprint_json_tests {
    use super::Fingerprint;

    fn fp() -> Fingerprint {
        Fingerprint {
            hex: "00".repeat(32),
            base64: "A".repeat(43) + "=",
            port: 4443,
            iroh_node_id: String::new(),
            iroh_relay_urls: vec![],
            iroh_direct_addrs: vec![],
            reachability: "local-only".into(),
            iroh_port: 44442,
            share_card: false,
            chia_address: None,
            chia_presence: None,
            blob_cap: None,
            torrent: false,
        }
    }

    /// 🏦 The Bank app reads the address from the fingerprint: it rides only
    /// while a wallet is loaded, and an answer without it (a read-only node, an
    /// older one) parses back with none rather than an empty string.
    #[test]
    fn the_receive_address_rides_in_the_fingerprint_only_while_a_wallet_is_loaded() {
        let none = serde_json::to_string(&fp()).unwrap();
        assert!(!none.contains("chia_address"), "{none}");
        let mut some = fp();
        some.chia_address = Some("txch1qq".into());
        let json = serde_json::to_string(&some).unwrap();
        assert!(json.contains("\"chia_address\":\"txch1qq\""), "{json}");
        let back: Fingerprint = serde_json::from_str(&none).unwrap();
        assert_eq!(back.chia_address, None);
        let back: Fingerprint = serde_json::from_str(&json).unwrap();
        assert_eq!(back.chia_address.as_deref(), Some("txch1qq"));
    }

    /// 📖 The Phone Book listing rides the same way: absent while the node
    /// does not publish presence, otherwise with its state spelled in
    /// lowercase for the browser's parser, and the error only when there is
    /// one.
    #[test]
    fn the_phone_book_listing_rides_in_the_fingerprint_only_while_presence_publishes() {
        use super::{ChiaPresence, ChiaPresenceState};
        let none = serde_json::to_string(&fp()).unwrap();
        assert!(!none.contains("chia_presence"), "{none}");
        let back: Fingerprint = serde_json::from_str(&none).unwrap();
        assert_eq!(back.chia_presence, None);

        let mut some = fp();
        some.chia_presence = Some(ChiaPresence {
            state: ChiaPresenceState::Listed,
            era: 7,
            listed_era: 7,
            last_at: 1_700_000_000,
            confirmed: true,
            current: true,
            public_addrs: 2,
            error: None,
        });
        let json = serde_json::to_string(&some).unwrap();
        assert!(json.contains("\"chia_presence\":{\"state\":\"listed\",\"era\":7,\"listed_era\":7,\"last_at\":1700000000,\"confirmed\":true,\"current\":true,\"public_addrs\":2}"), "{json}");
        let back: Fingerprint = serde_json::from_str(&json).unwrap();
        assert_eq!(back.chia_presence, some.chia_presence);

        let mut failing = fp();
        failing.chia_presence = Some(ChiaPresence {
            state: ChiaPresenceState::Unlisted,
            era: 7,
            listed_era: 0,
            last_at: 0,
            confirmed: false,
            current: false,
            public_addrs: 1,
            error: Some("chia wallet unfunded".into()),
        });
        let json = serde_json::to_string(&failing).unwrap();
        assert!(json.contains("\"state\":\"unlisted\""), "{json}");
        assert!(json.contains("\"error\":\"chia wallet unfunded\""), "{json}");
        let back: Fingerprint = serde_json::from_str(&json).unwrap();
        assert_eq!(back.chia_presence, failing.chia_presence);
    }
}

fn load_configured_relays_from_env() -> Vec<String> {
    let Some(raw) = std::env::var("SSF_RELAYS").ok() else {
        return Vec::new();
    };

    raw.split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

// ── Room-doc disk persistence (durability plan §4.2 C4/B) ────────────────────
// SERVED rooms (a local browser participated — the C2 flag) persist their Yjs
// doc to `rooms/<hex-room-id>.bin` beside `iroh_node_id.key`, and load back at
// startup re-marked `served`. Combined with C2 this closes the next durability
// rung: a room now survives not just a closed browser but a NODE RESTART —
// the owner's machine reboots and visitors still get the room. Corrupt or
// unreadable files fail OPEN (fresh doc, logged), never fatal.

const ROOMS_DIR: &str = "rooms";

/// Room ids are user-influenced strings — hex-encode for a filesystem-safe,
/// reversible filename.
fn room_doc_path(room_id: &str) -> std::path::PathBuf {
    std::path::Path::new(ROOMS_DIR).join(format!("{}.bin", hex::encode(room_id.as_bytes())))
}

/// Write one room's full-state snapshot. Best-effort: failures log and drop.
fn persist_room_doc(room_id: &str, snapshot: &[u8]) {
    if let Err(e) = std::fs::create_dir_all(ROOMS_DIR) {
        eprintln!("💾 room persist: cannot create {ROOMS_DIR}/: {e}");
        return;
    }
    if let Err(e) = std::fs::write(room_doc_path(room_id), snapshot) {
        eprintln!("💾 room persist: write failed for {room_id}: {e}");
    }
}

/// Load every persisted room doc at startup → (room_id, snapshot) pairs.
/// Malformed filenames / unreadable files are skipped with a log line.
fn load_persisted_rooms() -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(ROOMS_DIR) {
        Ok(e) => e,
        Err(_) => return out, // no dir yet — first run
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(hex_id) = name.strip_suffix(".bin") else { continue };
        let room_id = match hex::decode(hex_id).ok().and_then(|b| String::from_utf8(b).ok()) {
            Some(id) if !id.is_empty() => id,
            _ => {
                eprintln!("💾 room persist: skipping malformed filename {name}");
                continue;
            }
        };
        match std::fs::read(entry.path()) {
            Ok(bytes) if !bytes.is_empty() => out.push((room_id, bytes)),
            Ok(_) => {}
            Err(e) => eprintln!("💾 room persist: unreadable {name}: {e}"),
        }
    }
    out
}

fn load_or_create_secret_key() -> Result<SecretKey> {
    let key_path = std::path::Path::new("iroh_node_id.key");
    if key_path.exists() {
        let bytes = std::fs::read(key_path)?;
        if bytes.len() == 32 {
            let arr: [u8; 32] = bytes.try_into().map_err(|_| anyhow!("Invalid key format"))?;
            return Ok(SecretKey::from_bytes(&arr));
        }
    }
    let sk = SecretKey::generate();
    std::fs::write(key_path, sk.to_bytes())?;
    Ok(sk)
}

/// Default public-IPv4 echo services for `SSF_EXTERNAL_ADDRS=auto` — queried
/// over plain HTTP/1.0. The response is only our own public IP: nothing secret
/// leaves the machine, and a poisoned answer can at worst add one dead dial
/// hint (iroh connections are authenticated by node key regardless).
/// Operators can substitute their own echo with `SSF_IP_ECHO=host1,host2`.
///
/// IMPORTANT — R1 POSTURE FLIP (deliberate owner decision, demo phase):
/// 0.22.0 shipped `auto` as OPT-IN — "no third-party calls unless an `auto`
/// entry is explicitly configured" (sovereignty posture, v006 §10.2). R1
/// flips this to OPT-OUT so internet connectivity works with ZERO terminal
/// setup: an UNSET `SSF_EXTERNAL_ADDRS` now behaves exactly like `auto`, and
/// these hosts ARE contacted by default. Full opt-out (today's old silence,
/// no echo calls at all): `SSF_EXTERNAL_ADDRS=off` (or `none` / `0`,
/// case-insensitive). `SSF_IP_ECHO` still overrides the echo hosts; CGNAT
/// detection/refusal is unchanged.
const DEFAULT_IP_ECHO_HOSTS: &[&str] = &["api.ipify.org", "checkip.amazonaws.com"];
/// How often `auto` re-checks the public IP (ISP rotations heal within this).
const AUTO_ADDR_RECHECK_SECS: u64 = 300;

/// True when the address is usable as an internet-facing dial hint — rejects
/// private/loopback/link-local/documentation ranges, CGNAT (100.64.0.0/10),
/// where a home-router port-forward cannot produce inbound reachability, and
/// the other special-purpose ranges that never route on the internet: this
/// network (0.0.0.0/8), IETF protocol assignments (192.0.0.0/24), benchmarking
/// (198.18.0.0/15), multicast (224.0.0.0/4), reserved (240.0.0.0/4) and the
/// deprecated 6to4 relay anycast block (192.88.99.0/24, RFC 7526). Since
/// #231 P6a the same judge decides what a presence record may carry, so a
/// non-global address is never written to the chain either.
fn ipv4_is_public(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    let cgnat = o[0] == 100 && (o[1] & 0b1100_0000) == 64; // 100.64.0.0/10
    let this_network = o[0] == 0; // 0.0.0.0/8
    let ietf_assignments = o[0] == 192 && o[1] == 0 && o[2] == 0; // 192.0.0.0/24
    let six_to_four_relay = o[0] == 192 && o[1] == 88 && o[2] == 99; // 192.88.99.0/24
    let benchmarking = o[0] == 198 && (o[1] & 0xfe) == 18; // 198.18.0.0/15
    let reserved = o[0] >= 240; // 240.0.0.0/4 (broadcast included)
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        || cgnat
        || this_network
        || ietf_assignments
        || six_to_four_relay
        || benchmarking
        || reserved)
}

/// v6 companion to [`ipv4_is_public`] (Slice 5b): rejects loopback/unspecified/
/// multicast, link-local (fe80::/10), the deprecated site-local (fec0::/10),
/// ULA (fc00::/7), documentation (2001:db8::/32 and 3fff::/20), benchmarking
/// (2001:2::/48), ORCHIDv2 (2001:20::/28), the discard-only 100::/64, the
/// local-use translation prefix 64:ff9b:1::/48 (RFC 8215) and the SRv6 SID
/// space 5f00::/16 (RFC 9602); keeps global unicast. An IPv4 wearing IPv6 clothing is
/// judged as THAT IPv4 — mapped `::ffff:a.b.c.d`, the deprecated compatible
/// `::a.b.c.d`, 6to4 `2002:AABB:CCDD::` and NAT64 `64:ff9b::a.b.c.d` — so
/// `[::ffff:192.168.1.1]` cannot smuggle a LAN address past the v4 checks and
/// make every watcher probe somebody's network (#238 review). Teredo
/// (2001:0::/32) is a relay tunnel, never a direct path: rejected.
#[cfg(feature = "chia-read")]
fn ipv6_is_public(ip: std::net::Ipv6Addr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() {
        return false;
    }
    // Mapped and compatible forms both unwrap here (after the loopback and
    // unspecified checks above, so `::1` and `::` never reach the v4 judge).
    if let Some(v4) = ip.to_ipv4() {
        return ipv4_is_public(v4);
    }
    let seg = ip.segments();
    let v4_of = |hi: u16, lo: u16| std::net::Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if seg[0] == 0x2002 {
        return ipv4_is_public(v4_of(seg[1], seg[2])); // 6to4
    }
    if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        return ipv4_is_public(v4_of(seg[6], seg[7])); // NAT64 well-known prefix
    }
    if seg[0] == 0x2001 && seg[1] == 0 {
        return false; // Teredo
    }
    !((seg[0] & 0xffc0) == 0xfe80       // fe80::/10 link-local
        || (seg[0] & 0xffc0) == 0xfec0  // fec0::/10 site-local (deprecated, never global)
        || (seg[0] & 0xfe00) == 0xfc00  // fc00::/7 unique-local
        || (seg[0] == 0x2001 && seg[1] == 0x0db8) // 2001:db8::/32 documentation
        || (seg[0] == 0x3fff && (seg[1] >> 12) == 0) // 3fff::/20 documentation
        || (seg[0] == 0x2001 && seg[1] == 0x0002 && seg[2] == 0) // 2001:2::/48 benchmarking
        || (seg[0] == 0x2001 && (seg[1] & 0xfff0) == 0x0020) // 2001:20::/28 ORCHIDv2
        || (seg[0] == 0x0100 && seg[1..4] == [0, 0, 0]) // 100::/64 discard-only
        || (seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2] == 0x0001) // 64:ff9b:1::/48 local-use translation
        || seg[0] == 0x5f00) // 5f00::/16 SRv6 SIDs
}

/// Slice 5b addr-trust filter: a chia-resolved record's addrs are SELF-declared,
/// so feed only PUBLIC, internet-routable ones into a dial and cap the count —
/// never probe our own LAN/loopback off a record (same-LAN peers are found by
/// mDNS at rung 2 anyway). The dial is node-id-authenticated, so even a spoofed
/// public addr yields only a failed handshake, never a completed link.
///
/// #231 P1: cap 8 (was 4) and IPv6 FIRST — a v6 pair is the direct path that
/// needs no NAT traversal at all, so it gets the first Initials of every hold.
#[cfg(feature = "chia-read")]
pub(crate) fn chia_public_dial_addrs(addrs: &[String]) -> Vec<SocketAddr> {
    const CAP: usize = 8;
    let mut kept = chia_public_addrs(addrs);
    kept.truncate(CAP);
    kept
}

/// Every public, internet-routable address among `addrs`, v6 first (stable:
/// publisher order within each family), with no cap: the presence publisher
/// canonicalizes and de-duplicates the whole set before it applies the
/// record's own cap, so a duplicate never costs a slot.
#[cfg(feature = "chia-read")]
pub(crate) fn chia_public_addrs(addrs: &[String]) -> Vec<SocketAddr> {
    let mut kept: Vec<SocketAddr> = addrs
        .iter()
        .filter_map(|s| s.parse::<SocketAddr>().ok())
        .filter(|sa| match sa.ip() {
            std::net::IpAddr::V4(v4) => ipv4_is_public(v4),
            std::net::IpAddr::V6(v6) => ipv6_is_public(v6),
        })
        .collect();
    kept.sort_by_key(|sa| sa.is_ipv4());
    kept
}

#[cfg(all(test, feature = "chia-read"))]
mod chia_addr_filter_tests {
    use super::*;

    #[test]
    fn public_filter_keeps_public_drops_nonroutable() {
        let addrs: Vec<String> = [
            "192.168.1.79:58827",                    // private v4 -> drop
            "127.0.0.1:1234",                        // loopback -> drop
            "100.64.1.1:1",                          // CGNAT 100.64/10 -> drop
            "169.254.5.5:1",                         // link-local v4 -> drop
            "[fe80::1]:1",                           // link-local v6 -> drop
            "[fc00::1]:1",                           // ULA v6 -> drop
            "203.0.113.9:44442",                     // TEST-NET-3 documentation -> drop
            "198.18.0.1:1",                          // benchmarking 198.18/15 -> drop
            "240.0.0.1:1",                           // reserved 240/4 -> drop
            "0.1.2.3:1",                             // this network 0/8 -> drop
            "224.0.0.1:1",                           // multicast -> drop
            "192.0.0.9:1",                           // IETF protocol assignments 192.0.0/24 -> drop
            "[fec0::1]:1",                           // site-local v6 (deprecated) -> drop
            "[100::1]:1",                            // discard-only v6 -> drop
            "[2001:2::1]:1",                         // benchmarking v6 -> drop
            "[2001:20::1]:1",                        // ORCHIDv2 -> drop
            "[3fff::1]:1",                           // documentation v6 (3fff::/20) -> drop
            "192.88.99.1:1",                         // deprecated 6to4 relay anycast -> drop
            "[64:ff9b:1::1]:1",                      // local-use IPv4/IPv6 translation -> drop
            "[5f00::1]:1",                           // SRv6 SID space -> drop
            "8.8.8.8:44442",                         // public v4 -> KEEP
            "[2600:1700:68a0:8ca0::29]:58828",       // public v6 -> KEEP
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let kept: Vec<String> = chia_public_dial_addrs(&addrs).iter().map(|s| s.to_string()).collect();
        assert_eq!(kept.len(), 2, "only the two public addrs survive, got {kept:?}");
        assert!(kept[0].contains("2600:1700"), "IPv6 is dialed first (P1), got {kept:?}");
        assert_eq!(kept[1], "8.8.8.8:44442");
        for bad in [
            "192.168", "127.0.0.1", "100.64", "169.254", "fe80", "fc00", "203.0.113", "198.18", "240.0", "0.1.2.3",
            "224.0", "192.0.0", "fec0", "100::", "2001:2:", "2001:20:", "3fff", "192.88.99", "64:ff9b:1:", "5f00",
        ] {
            assert!(!kept.iter().any(|s| s.contains(bad)), "{bad} should be filtered out");
        }
    }

    #[test]
    fn public_filter_judges_ipv4_hidden_in_ipv6_as_that_ipv4() {
        // A record could carry a LAN address in IPv6 clothing to make every
        // watcher probe somebody's network; each embedding is unwrapped and
        // judged as the IPv4 it carries (#238 review).
        let addrs: Vec<String> = [
            "[::ffff:192.168.1.1]:44442",   // mapped private -> drop
            "[::ffff:127.0.0.1]:1",         // mapped loopback -> drop
            "[::ffff:100.64.0.9]:1",        // mapped CGNAT -> drop
            "[::192.168.1.1]:1",            // compatible (deprecated) private -> drop
            "[2002:c0a8:0101::1]:1",        // 6to4 of 192.168.1.1 -> drop
            "[64:ff9b::c0a8:101]:1",        // NAT64 of 192.168.1.1 -> drop
            "[2001:0:1234::1]:1",           // Teredo relay -> drop
            "[2001:db8::1]:1",              // documentation -> drop
            "[::1]:1",                      // loopback -> drop
            "[::]:1",                       // unspecified -> drop
            "[::ffff:8.8.8.8]:1",           // mapped PUBLIC -> keep
            "[2002:0808:0808::1]:1",        // 6to4 of 8.8.8.8 -> keep
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let kept: Vec<String> = chia_public_dial_addrs(&addrs).iter().map(|s| s.to_string()).collect();
        assert_eq!(kept.len(), 2, "only the two public embeddings survive, got {kept:?}");
        assert!(kept.iter().any(|s| s.contains("8.8.8.8")), "mapped public v4 kept: {kept:?}");
        assert!(kept.iter().any(|s| s.contains("2002:808:808")), "6to4 of a public v4 kept: {kept:?}");
    }

    #[test]
    fn public_filter_caps_at_eight_keeping_v6_ahead_of_v4() {
        let addrs: Vec<String> = (1..=6)
            .map(|i| format!("8.8.8.{i}:1"))
            .chain((1..=6).map(|i| format!("[2600:1700::{i}]:1")))
            .collect();
        let kept = chia_public_dial_addrs(&addrs);
        assert_eq!(kept.len(), 8, "cap is 8 (was 4), got {}", kept.len());
        assert!(kept[..6].iter().all(|sa| sa.is_ipv6()), "all six v6 addrs come first: {kept:?}");
        assert!(kept[6..].iter().all(|sa| sa.is_ipv4()), "then the first two v4 addrs: {kept:?}");
    }
}

/// The publish toggle (#231 D3): `SSF_CHIA_LANE=1` turns PUBLISHING on in a
/// `chia-publish` build. Reads never consult it. P3/D4 give it a UI + default.
#[cfg(feature = "chia-publish")]
fn chia_publish_enabled() -> bool {
    std::env::var("SSF_CHIA_LANE").ok().as_deref() == Some("1")
}

/// Outcome of one public-IPv4 echo round. CGNAT is split out from plain
/// failure (R1) so the fingerprint can classify reachability honestly —
/// "the echo answered but the WAN is CGNAT" is actionable ("needs relay"),
/// "the echo never answered" is not.
enum PublicIpv4Outcome {
    /// A public IPv4 usable as an internet-facing dial hint.
    Public(std::net::Ipv4Addr),
    /// The echo answered with a CGNAT/private WAN address — advertising is
    /// refused (unchanged since 0.22.0): no router port-forward can produce
    /// inbound reachability from there.
    Cgnat(std::net::Ipv4Addr),
    /// No echo service produced a usable answer (offline, blocked, timeout).
    Failed(anyhow::Error),
}

/// Resolves the current public IPv4 via the first echo service that answers
/// with a public address. Tries `SSF_IP_ECHO` hosts (comma-separated) if set,
/// else the defaults; 10 s timeout per host.
async fn discover_public_ipv4() -> PublicIpv4Outcome {
    let hosts_env = std::env::var("SSF_IP_ECHO").ok();
    let hosts: Vec<&str> = match hosts_env.as_deref() {
        Some(raw) => raw.split(',').map(str::trim).filter(|s| !s.is_empty()).collect(),
        None => DEFAULT_IP_ECHO_HOSTS.to_vec(),
    };
    let mut cgnat_ip: Option<std::net::Ipv4Addr> = None;
    let mut last_err = anyhow!("no IP echo services configured");
    for host in hosts {
        match tokio::time::timeout(std::time::Duration::from_secs(10), query_ip_echo(host)).await {
            Ok(Ok(ip)) if ipv4_is_public(ip) => return PublicIpv4Outcome::Public(ip),
            Ok(Ok(ip)) => {
                cgnat_ip = Some(ip);
                last_err = anyhow!("{host} reports non-public address {ip} — this looks like CGNAT/private WAN; a router port-forward cannot make you reachable from there")
            }
            Ok(Err(e)) => last_err = e,
            Err(_) => last_err = anyhow!("{host}: timed out"),
        }
    }
    match cgnat_ip {
        Some(ip) => PublicIpv4Outcome::Cgnat(ip),
        None => PublicIpv4Outcome::Failed(last_err),
    }
}

/// Minimal plain-HTTP/1.0 GET returning the echoed IPv4 body (bounded read;
/// HTTP/1.0 + Connection: close sidesteps chunked encoding entirely).
async fn query_ip_echo(host: &str) -> Result<std::net::Ipv4Addr> {
    let mut stream = tokio::net::TcpStream::connect((host, 80)).await?;
    let req = format!("GET / HTTP/1.0\r\nHost: {host}\r\nUser-Agent: ssf-p2p-node\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await?;
    let mut resp = Vec::with_capacity(512);
    let mut limited = stream.take(4096);
    limited.read_to_end(&mut resp).await?;
    let text = String::from_utf8_lossy(&resp);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| anyhow!("{host}: malformed HTTP response"))?;
    let status_ok = head.lines().next().map(|l| l.contains(" 200 ")).unwrap_or(false);
    if !status_ok {
        return Err(anyhow!("{host}: non-200 echo response"));
    }
    body.trim()
        .parse::<std::net::Ipv4Addr>()
        .map_err(|e| anyhow!("{host}: echo body is not an IPv4 address: {e}"))
}

#[tokio::main]
async fn main() -> Result<()> {
    println!("🪐 StarStation Furlong — Standalone P2P Swarm Node");
    println!("📡 Initializing real-time networks...");

    // 🧲 The torrent feature brings a second rustls crypto backend into the
    // build (librqbit's reqwest uses aws-lc-rs), and with two compiled in
    // rustls has no process default: name ring, the one the node uses
    // everywhere else. And empty what the last run's torrents left.
    #[cfg(feature = "torrent")]
    {
        let _ = rustls::crypto::ring::default_provider().install_default();
        torrent_lane::wipe_cache();
    }

    // First load or generate persistent SecretKey (C1 fix)
    let secret_key = load_or_create_secret_key()?;
    let iroh_id = secret_key.public();
    println!("🔑 Unified Iroh Swarm ID (YOUR DIAL KEY): {}", iroh_id);

    // Build Endpoint incorporating ALPN "ssf" (B3 fix) and persistent SecretKey (C1 fix)
    let mut builder = IrohEndpoint::builder(Minimal)
        .secret_key(secret_key.clone())
        .alpns(vec![b"ssf".to_vec(), iroh_blobs::ALPN.to_vec()]); // Ensure B3 is resolved so we do not reject inbound ALPN; 📦 the blob lane's beside it

    // Configure relay map from SSF_RELAYS (comma-separated URLs).
    // Placeholder defaults are intentionally removed: operators provide real relays.
    let configured_relays = load_configured_relays_from_env();
    if !configured_relays.is_empty() {
            let relay_map = RelayMap::try_from_iter(configured_relays.iter().map(String::as_str))?;
         builder = builder.relay_mode(iroh::endpoint::RelayMode::Custom(relay_map));
         println!("🌐 SSF_RELAYS configured ({} relay URL(s))", configured_relays.len());
    } else {
         println!("🌐 SSF_RELAYS not set; no default relay URLs loaded.");
    }

    // 🕳️ Mainline DHT address lookup — sovereign zero-server discovery.
    // Publishes our ed25519-signed addresses to the BitTorrent Mainline DHT and
    // resolves remote node IDs the same way: no DNS, no registration, no n0 infra.
    // AddrFilter::unfiltered is REQUIRED: the default (relay_only) would publish
    // nothing at all in our relay-less posture.
    if std::env::var("SSF_NO_DHT").ok().as_deref() == Some("1") {
        println!("🕳️ Mainline DHT lookup DISABLED (SSF_NO_DHT=1)");
    } else {
        match iroh_mainline_address_lookup::DhtAddressLookup::builder()
            .secret_key(secret_key.clone())
            .addr_filter(iroh::endpoint_info::AddrFilter::unfiltered())
            .build()
        {
            Ok(dht) => {
                builder = builder.address_lookup(dht);
                println!("🕳️ Mainline DHT lookup ENABLED — publishing + resolving via BitTorrent Mainline (set SSF_NO_DHT=1 to disable)");
            }
            Err(e) => {
                eprintln!("⚠️ Mainline DHT init failed (continuing without DHT): {e}");
            }
        }
    }

    // 📌 Reachability rung 3 (§4.1.2), promoted in 0.19.0: the iroh UDP port is
    // PINNED BY DEFAULT to 44442 (IANA-unassigned for TCP+UDP, verified
    // 2026-07-10) so router port-forwards, firewall rules, and invite hints
    // survive restarts with zero configuration. SSF_IROH_PORT=<port> overrides
    // the pin; SSF_IROH_PORT=0 restores the pre-0.19.0 random per-launch bind.
    // IPv6 keeps its default bind either way.
    const DEFAULT_IROH_PORT: u16 = 44442;
    let (pinned_port, is_default_pin) = match std::env::var("SSF_IROH_PORT") {
        Ok(raw) => match raw.trim().parse::<u16>() {
            Ok(0) => (None, false),
            Ok(port) => (Some(port), false),
            Err(_) => {
                eprintln!("⚠️ Invalid SSF_IROH_PORT '{raw}' (want 0-65535); using default pin {DEFAULT_IROH_PORT}");
                (Some(DEFAULT_IROH_PORT), true)
            }
        },
        Err(_) => (Some(DEFAULT_IROH_PORT), true),
    };
    match pinned_port {
        Some(port) => {
            // Probe availability first so an auto-spawned node degrades to a
            // random port instead of dying when a foreign process already owns
            // the default port. An EXPLICIT pin still fails loudly.
            match std::net::UdpSocket::bind(("0.0.0.0", port)) {
                Ok(probe) => {
                    drop(probe);
                    builder = builder
                        .bind_addr(format!("0.0.0.0:{port}"))
                        .map_err(|e| anyhow!("Invalid iroh bind address 0.0.0.0:{port}: {e:?}"))?;
                    let origin = if is_default_pin { "default" } else { "SSF_IROH_PORT" };
                    println!("📌 iroh IPv4 socket pinned to UDP {port} ({origin}) — forward UDP {port} on your router for direct reachability");
                }
                Err(e) if is_default_pin => {
                    eprintln!("⚠️ Default iroh port UDP {DEFAULT_IROH_PORT} is unavailable ({e}); falling back to a random per-launch port — direct dials then need SSF_IROH_PORT + a matching forward, or the other reachability rungs");
                }
                Err(e) => {
                    return Err(anyhow!("SSF_IROH_PORT={port} requested but UDP {port} is unavailable: {e}"));
                }
            }
            // IPv6 pin: the v6 socket previously kept its DEFAULT bind = a RANDOM
            // ephemeral port every launch (the comment above used to admit "IPv6
            // keeps its default bind"), so an [v6]:44442 firewall allow-rule or
            // invite hint never matched v6 traffic. Pin it to the SAME port so a
            // member is STABLY dialable on IPv6 — the self-healing mesh's sovereign
            // path (no NAT, so a fixed [v6]:port is directly reachable). Probe first
            // and degrade to random on conflict, exactly like the IPv4 pin; a v6
            // failure is never fatal (IPv4 + relays/DHT still carry us).
            match std::net::UdpSocket::bind(("::", port)) {
                Ok(probe) => {
                    drop(probe);
                    builder = builder
                        .bind_addr(format!("[::]:{port}"))
                        .map_err(|e| anyhow!("Invalid iroh bind address [::]:{port}: {e:?}"))?;
                    println!("📌 iroh IPv6 socket pinned to UDP {port} — allow inbound UDP {port} on your IPv6 firewall for direct reachability");
                }
                Err(e) => {
                    eprintln!("⚠️ iroh IPv6 port UDP {port} unavailable ({e}); IPv6 falls back to a random per-launch port — direct v6 dials then need the other reachability rungs");
                }
            }
        }
        None => println!("📌 SSF_IROH_PORT=0 — iroh IPv4 socket uses a random per-launch port (not manually forwardable)"),
    }

    // 📌 External-address advertising: manually-known public addresses (e.g.
    // after a router port-forward) and `auto` / `auto:<port>` entries that
    // resolve the CURRENT public IPv4 via an HTTP echo (SSF_IP_ECHO overrides
    // the service list) and re-check every 5 minutes — dynamic-IP rotations
    // heal live, no restart, no stale invites.
    //
    // IMPORTANT — R1 POSTURE FLIP (deliberate owner decision, demo phase —
    // "as easy as possible"): the 0.22.0 opt-in echo posture is now OPT-OUT.
    // UNSET SSF_EXTERNAL_ADDRS behaves exactly like `auto`; the full opt-out
    // (no echo calls — the pre-R1 unset behavior) is SSF_EXTERNAL_ADDRS=off
    // (or `none` / `0`, case-insensitive). Explicit values keep their exact
    // 0.22.0 semantics. SSF_IP_ECHO still overrides the echo hosts; CGNAT
    // detection/refusal is unchanged.
    let reach = Arc::new(ReachState::new());
    let external_addrs_cfg: Option<String> = match std::env::var("SSF_EXTERNAL_ADDRS") {
        Err(_) => {
            println!("📌 SSF_EXTERNAL_ADDRS not set — public-IP auto-advertising is ON by default (R1); set SSF_EXTERNAL_ADDRS=off to opt out");
            Some("auto".to_string())
        }
        Ok(raw) if matches!(raw.trim().to_ascii_lowercase().as_str(), "off" | "none" | "0" | "") => {
            println!("📌 External-address advertising OFF (SSF_EXTERNAL_ADDRS={}) — no public-IP echo calls will be made", raw.trim());
            None
        }
        Ok(raw) => Some(raw),
    };
    let mut auto_ports: Vec<Option<u16>> = Vec::new();
    if let Some(raw) = external_addrs_cfg {
        for entry in raw.split(',').map(str::trim).filter(|s| !s.is_empty()) {
            let lower = entry.to_ascii_lowercase();
            if lower == "auto" {
                auto_ports.push(None);
            } else if let Some(port_str) = lower.strip_prefix("auto:") {
                match port_str.parse::<u16>() {
                    Ok(p) if p > 0 => auto_ports.push(Some(p)),
                    _ => eprintln!("⚠️ Ignoring invalid SSF_EXTERNAL_ADDRS entry '{entry}' (want auto:<1-65535>)"),
                }
            } else {
                match entry.parse::<SocketAddr>() {
                    Ok(sock) => {
                        builder = builder.external_addr(sock);
                        // R1: record explicit PUBLIC v4 entries as self-advertised so
                        // classify_reachability reports them "advertised" (unverified
                        // claim) instead of misinferring "port-mapped".
                        if let std::net::IpAddr::V4(v4) = sock.ip() {
                            if ipv4_is_public(v4) {
                                reach.self_advertised.lock().unwrap().insert(sock);
                            }
                        }
                        println!("📌 External address advertised: {sock}");
                    }
                    Err(e) => eprintln!("⚠️ Ignoring invalid SSF_EXTERNAL_ADDRS entry '{entry}': {e:?}"),
                }
            }
        }
    }

    let iroh_endpoint = builder.bind().await?;
    println!("   Bound Sockets: {:?}", iroh_endpoint.bound_sockets());

    // R1: the iroh IPv4 UDP port ACTUALLY bound — after any random-port
    // fallback above — is what a router forward must target. It feeds the
    // fingerprint (`iroh_port`, so the UI shows WHICH port to forward) and
    // the auto-advertise loop below.
    let bound_v4_port = iroh_endpoint
        .bound_sockets()
        .iter()
        .find(|s| s.is_ipv4())
        .map(|s| s.port())
        .unwrap_or(DEFAULT_IROH_PORT);

    // 🔄 Dynamic public-IP advertising (default `auto` since R1; also
    // auto:<port>): resolve now, then re-check every AUTO_ADDR_RECHECK_SECS.
    // On ISP rotation the stale address is swapped LIVE via
    // Endpoint::{add,remove}_external_addr — the DHT record and freshly-minted
    // invite hints follow automatically. Invites are durable across IP changes
    // anyway (room key + node ID; DHT re-resolves).
    if !auto_ports.is_empty() {
        for port_override in auto_ports {
            let port = port_override.unwrap_or(bound_v4_port);
            let ep = iroh_endpoint.clone();
            let reach_auto = reach.clone();
            tokio::spawn(async move {
                let mut announced: Option<SocketAddr> = None;
                loop {
                    match discover_public_ipv4().await {
                        PublicIpv4Outcome::Public(ip) => {
                            reach_auto.cgnat_detected.store(false, std::sync::atomic::Ordering::Relaxed);
                            let addr = SocketAddr::from((ip, port));
                            if announced != Some(addr) {
                                if let Some(old) = announced.take() {
                                    let _ = ep.remove_external_addr(&old).await;
                                    // Deliberately NOT removed from self_advertised: iroh's
                                    // live snapshot can report the old addr for a beat after
                                    // remove_external_addr, and a fingerprint request in that
                                    // window would misclassify it as "port-mapped" (green).
                                    // Stale set entries can only ever UNDERSTATE (R1 review L1).
                                    println!("🔄 Public IP changed — un-advertised stale external address {old}");
                                }
                                ep.add_external_addr(addr).await;
                                reach_auto.self_advertised.lock().unwrap().insert(addr);
                                announced = Some(addr);
                                println!("📌 External address advertised (auto): {addr} — re-checked every {AUTO_ADDR_RECHECK_SECS}s; router must forward UDP {port} here");
                            }
                        }
                        PublicIpv4Outcome::Cgnat(ip) => {
                            // CGNAT refusal unchanged since 0.22.0 — never advertise a
                            // CGNAT/private WAN address. R1 additionally SURFACES the
                            // condition (fingerprint reachability: "cgnat") instead of
                            // leaving it console-only.
                            reach_auto.cgnat_detected.store(true, std::sync::atomic::Ordering::Relaxed);
                            if let Some(old) = announced.take() {
                                let _ = ep.remove_external_addr(&old).await;
                                // Kept in self_advertised — same transient-window rationale
                                // as the rotation branch (R1 review L1); cgnat_detected
                                // dominates classification anyway.
                                println!("🔄 WAN fell behind CGNAT — un-advertised stale external address {old}");
                            }
                            eprintln!("⚠️ Public-IP echo reports CGNAT/private WAN address {ip} — refusing to advertise it (a router port-forward cannot make you reachable from there; direct inbound dials need a relay); re-checking in {AUTO_ADDR_RECHECK_SECS}s");
                        }
                        PublicIpv4Outcome::Failed(e) => eprintln!("⚠️ Public-IP auto-discovery failed (will retry in {AUTO_ADDR_RECHECK_SECS}s): {e}"),
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(AUTO_ADDR_RECHECK_SECS)).await;
                }
            });
        }
    }

    // 📡 mDNS same-LAN lookup: a bare room key + node id resolves on the local
    // network with zero hints, zero internet, zero servers (plan §4.5 lane 3).
    if std::env::var("SSF_NO_MDNS").ok().as_deref() == Some("1") {
        println!("📡 mDNS LAN lookup DISABLED (SSF_NO_MDNS=1)");
    } else {
        match iroh_mdns_address_lookup::MdnsAddressLookup::builder().build(iroh_endpoint.id()) {
            Ok(mdns) => match iroh_endpoint.address_lookup() {
                Ok(services) => {
                    services.add(mdns);
                    println!("📡 mDNS LAN lookup ENABLED — same-network peers resolve bare keys (set SSF_NO_MDNS=1 to disable)");
                }
                Err(e) => eprintln!("⚠️ mDNS init skipped: address-lookup services unavailable: {e:?}"),
            },
            Err(e) => eprintln!("⚠️ mDNS LAN lookup init failed (continuing without): {e:?}"),
        }
    }

    // Invite hints must be DIALABLE addresses, not bind addresses (🐛 fix 2026-07-08):
    // bound_sockets() yields the bind address (0.0.0.0:<port> — unspecified, useless to
    // a remote dialer). endpoint.addr() carries iroh's own view of reachable interface
    // (and later relay/observed) addresses — filter any unspecified leftovers.
    let iroh_direct_addrs: Vec<String> = iroh_endpoint
        .addr()
        .ip_addrs()
        .filter(|sock| !sock.ip().is_unspecified())
        .map(|sock| sock.to_string())
        .collect();
    println!("   Advertised direct-addr hints: {:?}", iroh_direct_addrs);

    // ⛓️ ChiaHub lane: crypto self-test + one status line saying what this build
    // does with the chain (reads on by default — #231 D3; publishing behind
    // SSF_CHIA_LANE=1 in a chia-publish build).
    chia_lane::startup_status(&secret_key, &iroh_direct_addrs);
    // S‑0 step 2: which full-node peers the chain lane will use, and the trust
    // posture money paths take (pins, pin-only, or two agreeing public peers).
    #[cfg(feature = "chia-read")]
    println!("⛓️ Chain lane: {}", chia_chain::describe());

    // ⛓️ ChiaHub lane C1 SLICE 2 (chia-publish feature): load/mint the node's
    // Chia BLS identity and print its testnet11 receive address to fund. ONLY
    // when publishing is switched on (SSF_CHIA_LANE=1): a read-only node never
    // mints `chia_identity.seed` (D3). The seed persists beside the iroh key
    // (bare CWD-relative path, same convention).
    // Slice 6 stash: the wallet key outlives this block so the heartbeat
    // publisher (spawned after HubState exists — it reads hub.chia_rooms)
    // can sign spends for ARMED rooms.
    #[cfg(feature = "chia-publish")]
    let mut chia_heartbeat_sk: Option<chia_bls::SecretKey> = None;
    #[cfg(feature = "chia-publish")]
    if chia_publish_enabled() {
        let seed_path = std::path::Path::new("chia_identity.seed");
        match chia_wallet::load_or_mint_bls_key(seed_path) {
            Ok(chia_sk) => {
                chia_wallet::log_receive_address(&chia_sk);
                // #231 P6b/D7: the beacon role pays from a wallet of its own.
                if chia_publish::beacon_enabled() {
                    println!(
                        "⛓️ ChiaHub beacon (D7, opt-in): on — it writes this node's id in the clear once per era while inbound-verified, paid from its own wallet; fund {} at a testnet11 faucet",
                        chia_wallet::testnet_address(&chia_publish::beacon_wallet_key(&chia_sk))
                    );
                }
                // The wallet lease's parking outlives the process (#245 review,
                // round 17): a zero-fee spend can still sit in the mempool after
                // a restart, and the restored parking keeps its inputs, and a
                // mojo still landing, from being taken again. Beside the seed,
                // same CWD-relative convention; before any writer runs. A file
                // that exists but cannot be read SEALS the lease (round 19):
                // the node then takes no spend until the operator fixes or
                // removes it and restarts; the startup log says so.
                chia_publish::WALLET_LEASE.restore(std::path::Path::new("wallet_lease.json"));
                chia_heartbeat_sk = Some(chia_sk.clone());
                // SLICE 4 test hook (SSF_CHIA_PUBLISH_TEST=1): once at startup, spend
                // a coin to publish a presence record under a FIXED test room key, so
                // the publish->resolve loop can be validated without a browser having
                // delivered a real room key. Spawned so it never blocks node startup;
                // logs the hint on success or the reason on failure (e.g. unfunded).
                let mut publish_test_task: Option<tokio::task::JoinHandle<()>> = None;
                if std::env::var("SSF_CHIA_PUBLISH_TEST").ok().as_deref() == Some("1") {
                    let iroh_sk = secret_key.clone();
                    let addrs = iroh_direct_addrs.clone();
                    let test_room_key = blake3::derive_key("ssf-chia-test-room-v1", b"slice4");
                    let chia_sk_pub = chia_sk.clone();
                    publish_test_task = Some(tokio::spawn(async move {
                        match chia_publish::publish_presence(&iroh_sk, &chia_sk_pub, &test_room_key, &addrs).await {
                            Ok(hint) => println!(
                                "⛓️ ChiaHub PUBLISH ok — testnet11 presence record written at hint {}",
                                hex::encode(&hint.to_bytes()[..8])
                            ),
                            Err(e) => eprintln!("⛓️ ChiaHub PUBLISH failed: {e:#}"),
                        }
                    }));
                }
                // 🎲⛓️ Craps fairness T1 hook (SSF_CHIA_CRAPS_FAIR_TEST=1, plan §12):
                // publish a commit + reveal for a throwaway (table, round) on
                // testnet11, then resolve + re-derive + verify the dice. Reuses the
                // presence spend-to-self primitive with a PUBLIC (plaintext) payload.
                // Spawned so it never blocks startup; logs each step + PASS/FAIL.
                if std::env::var("SSF_CHIA_CRAPS_FAIR_TEST").ok().as_deref() == Some("1") {
                    let chia_sk_fair = chia_sk.clone();
                    tokio::spawn(async move {
                        // Both test hooks spend from the SAME wallet — run
                        // strictly after the publish test (when enabled) so the
                        // two can't race coin selection into a mempool
                        // double-spend and fail for non-fairness reasons
                        // (#87 review).
                        if let Some(t) = publish_test_task {
                            let _ = t.await;
                        }
                        if let Err(e) = chia_craps_fair::craps_fair_selftest(&chia_sk_fair).await {
                            eprintln!("🎲⛓️ craps-fair selftest FAILED: {e:#}");
                        }
                    });
                }
            }
            Err(e) => eprintln!("⛓️ ChiaHub lane: could not load chia identity: {e:#}"),
        }
    }

    // SLICE 5 test hook (SSF_CHIA_RESOLVE_TEST=1): resolve a presence record from
    // testnet11 under the same fixed test room key the publish hook uses, and log
    // the recovered node_id + addrs — the READ side of mesh introduction. Read-only
    // (no wallet needed); spawned so it never blocks startup.
    #[cfg(feature = "chia-read")]
    if std::env::var("SSF_CHIA_RESOLVE_TEST").ok().as_deref() == Some("1") {
        let test_room_key = blake3::derive_key("ssf-chia-test-room-v1", b"slice4");
        tokio::spawn(async move {
            match chia_resolve::resolve_by_room_key(&test_room_key).await {
                Ok(Some(rec)) => println!(
                    "⛓️ ChiaHub RESOLVE ok — recovered node_id {} · addrs {:?} · expires_at {}",
                    rec.node_id, rec.addrs, rec.expires_at
                ),
                Ok(None) => println!("⛓️ ChiaHub RESOLVE — no fresh record found for the test room key yet"),
                Err(e) => eprintln!("⛓️ ChiaHub RESOLVE failed: {e:#}"),
            }
        });
    }

    // 2. Start WebTransport Server for local browser tab GUI connections
    let listen_port = 4443;
    let identity = Identity::self_signed(["localhost", "127.0.0.1"])
        .map_err(|e| anyhow!("Failed to generate self-signed identity: {:?}", e))?;
    
    // R1: seed the fingerprint with the reachability known NOW (usually
    // "local-only" — the first echo round is still in flight); the HTTP API
    // re-classifies per request, exactly like the direct-addr hint refresh.
    let initial_reachability = classify_reachability(&reach, &iroh_direct_addrs);
    let fingerprint = compute_fingerprint(
        &identity,
        listen_port,
        &iroh_id.to_string(),
        configured_relays.clone(),
        iroh_direct_addrs,
        initial_reachability,
        bound_v4_port,
    )?;
    
    let addr = SocketAddr::from(([0, 0, 0, 0], listen_port));
    let wt_config = ServerConfig::builder()
        .with_bind_address(addr)
        .with_identity(identity)
        .build();

    let wt_endpoint = WtEndpoint::server(wt_config)
        .map_err(|e| anyhow!("Failed to bind wtransport server: {:?}", e))?;

    // #231 P6a: the contact identity and the address book, loaded (or minted)
    // beside the iroh key, and the room caps persisted by earlier runs so the
    // watcher READS for served rooms before any browser returns (a restored cap
    // authorizes reads only; publishing and cards wait for a live cap).
    #[cfg(feature = "chia-read")]
    let (contact_key, contact_key_durable, peer_book, restored_caps) = {
        let (ck, durable) = match chia_contact::load_or_create_contact_key(std::path::Path::new(chia_contact::CONTACT_KEY_FILE)) {
            Ok(ck) => (ck, true),
            Err(e) => {
                // A key that cannot be stored would change every start and make
                // every card we hand out stale; say so and run with a key for
                // this process only — one that is neither shared nor published
                // under (the watcher still reads).
                eprintln!(
                    "⛓️ ChiaHub contact: cannot load or create {}: {e} — no card is shared and no presence is published this run",
                    chia_contact::CONTACT_KEY_FILE
                );
                let mut ck = [0u8; 32];
                rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut ck);
                (ck, false)
            }
        };
        let book = chia_contact::PeerBook::load(std::path::Path::new(chia_contact::PEERS_FILE));
        let caps: HashMap<String, chia_rooms::ChiaRoomCap> = chia_rooms::load_persisted_caps().into_iter().collect();
        println!(
            "⛓️ ChiaHub contact: key ready · {} peer card(s) in the address book · {} room cap(s) restored for reading (publishing and cards wait for a live cap) · cards {}",
            book.peers.len(),
            caps.len(),
            if !durable {
                "not shared (no durable contact key)"
            } else if chia_contact::share_card_enabled() {
                "shared in private rooms"
            } else {
                "not shared (SSF_CHIA_SHARE_CARD=0)"
            }
        );
        (ck, durable, book, caps)
    };

    // 📦 The blob lane's store, with the whole files kept from the last run
    // (blob_lane.rs; SSF_BLOB_KEEP=0 empties it at start). A store that
    // cannot open costs the lane, never the node.
    let blobs = match blob_lane::BlobLane::open().await {
        Ok(lane) => {
            println!("📦 Blob lane ready (cache in blob-cache/)");
            Some(lane)
        }
        Err(e) => {
            eprintln!("⚠️ Blob lane off — its store could not open: {e:?}");
            None
        }
    };
    let hub = Arc::new(HubState {
        rooms: Mutex::new(HashMap::new()),
        fingerprint: Mutex::new(fingerprint),
        port: listen_port,
        configured_relays,
        seen_envelopes: Mutex::new(SeenCache::new()),
        tick_seen: Mutex::new(SeenCache::new()),
        secret_key: secret_key.clone(),
        dialing: Mutex::new(std::collections::HashSet::new()),
        reach: reach.clone(),
        #[cfg(feature = "chia-read")]
        chia_rooms: Mutex::new(restored_caps),
        #[cfg(feature = "chia-read")]
        contact_key,
        #[cfg(feature = "chia-read")]
        contact_key_durable,
        #[cfg(feature = "chia-read")]
        peers: Mutex::new(peer_book),
        #[cfg(feature = "chia-read")]
        inbound_verified: Mutex::new(chia_contact::InboundVerified::default()),
        #[cfg(feature = "chia-read")]
        recent_dials: Mutex::new(HashMap::new()),
        #[cfg(feature = "chia-read")]
        card_gate: tokio::sync::Mutex::new(()),
        #[cfg(feature = "chia-read")]
        chia_peak: Mutex::new(chia_resolve::ChainPeak::default()),
        #[cfg(feature = "chia-read")]
        presence_confirmed_at: std::sync::atomic::AtomicU64::new(0),
        #[cfg(feature = "chia-read")]
        presence_publishing: std::sync::atomic::AtomicBool::new(false),
        #[cfg(feature = "chia-read")]
        knock_queue: Mutex::new(std::collections::VecDeque::new()),
        #[cfg(feature = "chia-read")]
        knock_publishing: std::sync::atomic::AtomicBool::new(false),
        #[cfg(feature = "chia-read")]
        knocks: Mutex::new(chia_knock::KnockBook::load(std::path::Path::new(chia_knock::KNOCKS_FILE))),
        #[cfg(feature = "chia-publish")]
        chia_wallet: Mutex::new(chia_heartbeat_sk.clone()),
        #[cfg(feature = "chia-publish")]
        presence_status: Mutex::new(None),
        blobs,
        #[cfg(feature = "chia-read")]
        board_bundles: Mutex::new(board_bundles::BoardLane::load(
            std::path::Path::new(board_bundles::BUNDLES_DIR),
            chia_resolve::unix_now(),
        )),
    });

    // 💾 C4/B restore: load persisted room docs and serve them from boot.
    // A visitor can cold-join a room whose owner's machine rebooted, as long
    // as this node is running — no browser required (C2 answers SyncStep1).
    {
        let restored = load_persisted_rooms();
        if !restored.is_empty() {
            let mut rooms = hub.rooms.lock().unwrap();
            let mut ok = 0usize;
            for (room_id, bytes) in restored {
                let doc = Doc::new();
                let applied = Update::decode_v1(&bytes)
                    .ok()
                    .and_then(|u| doc.transact_mut().apply_update(u).ok())
                    .is_some();
                if !applied {
                    eprintln!("💾 room persist: corrupt snapshot for {room_id} — starting fresh (file kept for inspection)");
                    continue;
                }
                rooms.entry(room_id.clone()).or_insert_with(|| Room {
                    doc,
                    local_connections: HashMap::new(),
                    remote_peers: HashMap::new(),
                    candidates: HashMap::new(),
                    retained: RetainStore::new(),
                    served: true, // a persisted room was served when saved — keep serving
                });
                ok += 1;
            }
            if ok > 0 {
                println!("💾 Restored {ok} persisted room doc(s) — serving from boot (rooms survive node restarts)");
            }
        }
    }

    // #231 P6a: a restored cap is kept only for a room whose doc restored too.
    // A cap written before the room's first 15 s snapshot, or left behind by a
    // corrupt or deleted doc, would otherwise have the watcher polling and the
    // publisher spending for a room this node does not serve.
    #[cfg(feature = "chia-read")]
    {
        let rooms = hub.rooms.lock().unwrap();
        let mut caps = hub.chia_rooms.lock().unwrap();
        let orphans: Vec<String> = caps.keys().filter(|room| !rooms.contains_key(*room)).cloned().collect();
        for room in &orphans {
            caps.remove(room);
            eprintln!("💾 cap persist: room {room} has a cap but no restored doc — cap not restored (the browser re-sends it)");
        }
    }

    // 💾 C4/B saver: every 15 s, snapshot each SERVED room's doc and write it
    // when its content actually changed (blake3 dedup — idle rooms cost one
    // encode, no IO). Encode happens under the rooms lock (cheap: docs are
    // small, chat is capped in-doc), file IO after dropping it.
    {
        let hub_persist = hub.clone();
        tokio::spawn(async move {
            let mut last_hash: HashMap<String, [u8; 32]> = HashMap::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(15)).await;
                let snapshots: Vec<(String, Vec<u8>)> = {
                    let rooms = hub_persist.rooms.lock().unwrap();
                    rooms
                        .iter()
                        .filter(|(_, room)| room.served)
                        .map(|(id, room)| {
                            let txn = room.doc.transact();
                            (id.clone(), txn.encode_diff_v1(&StateVector::default()))
                        })
                        .collect()
                };
                for (room_id, snapshot) in snapshots {
                    if snapshot.is_empty() {
                        continue; // never persist an empty doc over a good file
                    }
                    let hash = *blake3::hash(&snapshot).as_bytes();
                    if last_hash.get(&room_id) == Some(&hash) {
                        continue;
                    }
                    persist_room_doc(&room_id, &snapshot);
                    last_hash.insert(room_id, hash);
                }
            }
        });
    }

    // ⛓️ ChiaHub C1 SLICE 6 (chia-publish): the REAL-room heartbeat publisher.
    // Every armed room (browser delivered its room key with chia_mode=true via
    // the Slice 3/3b toggle) that is not public space (N8) gets presence
    // published under its REAL room key — within a minute of arming, every
    // ~30 min after, and on address change. Runtime toggle: SSF_CHIA_LANE=1.
    #[cfg(feature = "chia-publish")]
    if chia_publish_enabled() {
        if let Some(chia_sk) = chia_heartbeat_sk.clone() {
            // The knock queue has its consumer (#272 review round 11) — and
            // rung 6 queues a knock only while the watcher runs too (round
            // 14): the watcher judges a sent knock by the chain's word and
            // dials at its rendezvous; without it the knock spends a coin and
            // the host alone dials. `SSF_CHIA_WATCH=0` keeps knocks off.
            if chia_knock::knocks_available(true, chia_watch::watch_enabled()) {
                hub.knock_publishing.store(true, std::sync::atomic::Ordering::Relaxed);
            } else {
                println!(
                    "⛓️ ChiaHub knock: the watcher is off (SSF_CHIA_WATCH=0), so this node writes no knock — a knock needs the watcher to confirm it and to dial at its rendezvous; presence publishes as before"
                );
            }
            let hub_hb = hub.clone();
            let iroh_hb = iroh_endpoint.clone();
            let iroh_sk_hb = secret_key.clone();
            tokio::spawn(async move {
                chia_publish::heartbeat_loop(hub_hb, iroh_hb, iroh_sk_hb, chia_sk).await;
            });
        }
    }

    // ⛓️ #231 P1: the WATCHER — beat-aligned reads of every readable room's hints
    // and hold-dials toward the members they describe (the symmetric trigger:
    // the host dials the joiner back). On by default (D3: reads are free);
    // SSF_CHIA_WATCH=0 turns it off.
    #[cfg(feature = "chia-read")]
    if chia_watch::watch_enabled() {
        let hub_w = hub.clone();
        let iroh_w = iroh_endpoint.clone();
        tokio::spawn(async move {
            chia_watch::watch_loop(hub_w, iroh_w).await;
        });
    }

    // M5.1: the node's first-ever liveness — a heartbeat loop that pings mesh
    // neighbors, prunes silent ones, and (M5.3) rebalances the bounded neighbor
    // set. Spawned once, iterates every room each tick.
    let hub_heartbeat = hub.clone();
    let iroh_heartbeat = iroh_endpoint.clone();
    tokio::spawn(async move {
        mesh_maintenance_loop(hub_heartbeat, iroh_heartbeat).await;
    });

    // 📌 #315: the board-bundle lane — seal this node's rooms' boards, tell
    // every connected peer what we carry, hand our tabs what others sealed.
    // On by default; SSF_BOARD_BUNDLES=0 turns it off.
    #[cfg(feature = "chia-read")]
    if board_bundles::enabled() {
        let held = hub.board_bundles.lock().unwrap().store.len();
        println!("📌 Board bundles on — carrying {held} sealed bundle(s) from the last run (board-bundles/)");
        let hub_boards = hub.clone();
        tokio::spawn(async move {
            board_bundle_loop(hub_boards).await;
        });
    }

    // 📦🏠 The room's host keeps copies of what its rooms' TVs played
    // (blob_lane.rs): rooms its own page said it hosts, under a cap and a
    // daily budget.
    if let Some(lane) = hub.blobs.clone() {
        blob_lane::spawn_host_copier(lane, hub.clone(), iroh_endpoint.clone());
    }

    // Start background HTTP API for local certificate fingerprint requests.
    // The endpoint handle lets each request refresh direct-addr hints LIVE —
    // portmapper mappings, QAD-observed and external addresses appear minutes
    // after startup and must reach invites (🐛 0.16.0: hints were a stale
    // startup snapshot, so port-mapped public addresses never made it out).
    let hub_http = hub.clone();
    let iroh_http = iroh_endpoint.clone();
    tokio::spawn(async move {
        start_http_api_server(hub_http, iroh_http).await;
    });

    // Start background Iroh Inbound connection acceptance loop
    let hub_iroh = hub.clone();
    let iroh_clone = iroh_endpoint.clone();
    tokio::spawn(async move {
        if let Err(e) = run_iroh_listener(hub_iroh, iroh_clone).await {
            eprintln!("⚠️ Iroh listener closed with error: {:?}", e);
        }
    });

    // Start WebTransport listener
    println!("🌌 WebTransport active, awaiting local tab on port {}", listen_port);
    if let Err(e) = run_wt_listener(hub, wt_endpoint, iroh_endpoint).await {
        eprintln!("⚠️ WebTransport server error: {:?}", e);
    }

    Ok(())
}

async fn run_wt_listener(
    hub: SharedHub,
    endpoint: WtEndpoint<wtransport::endpoint::endpoint_side::Server>,
    iroh_ep: IrohEndpoint,
) -> Result<()> {
    loop {
        let incoming = endpoint.accept().await;
        // A failed handshake is a per-CLIENT failure — log it and keep
        // accepting. `?` here killed the whole listener: one bad dial (the
        // classic case: a browser Retry carrying a pre-restart cert hash in
        // serverCertificateHashes) permanently deafened the node to every
        // future tab until the process was restarted.
        let request = match incoming.await {
            Ok(req) => req,
            Err(e) => {
                eprintln!("⚠️ WT session request failed (client handshake) — still accepting: {:?}", e);
                continue;
            }
        };
        let connection = match request.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("⚠️ WT accept failed mid-handshake — still accepting: {:?}", e);
                continue;
            }
        };
        let remote_addr = connection.remote_address();
        println!("🤝 Local browser session secured from {}", remote_addr);

        let hub_clone = hub.clone();
        let iroh_clone = iroh_ep.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_wt_connection(hub_clone, connection, iroh_clone).await {
                eprintln!("⚠️ Local peer connection closed with error ({}): {:?}", remote_addr, e);
            }
        });
    }
}

async fn handle_wt_connection(
    hub: SharedHub,
    connection: Connection,
    iroh_ep: IrohEndpoint,
) -> Result<()> {
    // Reclaim the connection on exit (issue #60 review): drop it from every
    // room's local_connections so the node doesn't accumulate dead browser
    // connections. Each staged-room-list prefetch is its own WT connection;
    // without this, room changes / reloads leak them for the node's lifetime
    // and dead entries draw doomed tick/ysync fan-out sends.
    let remote_addr = connection.remote_address();
    let result = handle_wt_connection_inner(hub.clone(), connection, iroh_ep).await;
    {
        let mut rooms = hub.rooms.lock().unwrap();
        for room in rooms.values_mut() {
            room.local_connections.remove(&remote_addr);
        }
    }
    result
}

async fn handle_wt_connection_inner(
    hub: SharedHub,
    connection: Connection,
    iroh_ep: IrohEndpoint,
) -> Result<()> {
    let remote_addr = connection.remote_address();
    let chosen_room: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    // 0.23.0 tick identity (issue #22): every movement tick this tab originates
    // is tagged with an 8-byte lane id (node id ‖ tab addr) so receiving
    // browsers key remote players correctly instead of aliasing them.
    let tab_lane_id = tick_lane_id(&[iroh_ep.id().as_bytes(), remote_addr.to_string().as_bytes()]);

    loop {
        tokio::select! {
            // UDP Datagram movement ticks routing over Iroh direct addresses
            dg = connection.receive_datagram() => {
                let datagram = dg?;
                if datagram.len() == 13 {
                    // M5.2: seed our OWN outgoing tick in the tick-dedup cache before
                    // it enters the mesh, so a multi-hop cycle can't echo it back into
                    // us as a phantom "remote" tick (or get re-relayed). Seeded here,
                    // before the rooms lock, so the two caches never nest.
                    hub.tick_seen
                        .lock()
                        .unwrap()
                        .check_and_insert(tick_seen_key(&tab_lane_id, &datagram));
                    let room_id_snapshot = chosen_room.lock().unwrap().clone();
                    if let Some(ref room_id) = room_id_snapshot {
                        let rooms = hub.rooms.lock().unwrap();
                        if let Some(room) = rooms.get(room_id) {
                            // Local clients get [8B sender lane id][13B tick] (0.23.0 wire)
                            let mut addressed = Vec::with_capacity(8 + datagram.len());
                            addressed.extend_from_slice(&tab_lane_id);
                            addressed.extend_from_slice(&datagram);
                            for (&addr, peer_conn) in &room.local_connections {
                                if addr != remote_addr {
                                    let _ = peer_conn.send_datagram(&addressed[..]);
                                }
                            }
                            // M5.2: inject the local tick into the mesh with a FULL TTL.
                            // node→node ticks carry [TTL][8B origin lane id][13B tick];
                            // each relay hop decrements TTL and the tick-dedup cache
                            // kills loops, so a spoke several nodes out finally sees us
                            // (was hop-1-capped). Fan out to the bounded NEIGHBOR set
                            // only (M5.3 in_mesh) — at N ≤ D_HIGH that is every peer.
                            for (_, member) in room.remote_peers.iter().filter(|(_, m)| m.in_mesh) {
                                let mut relayed = Vec::with_capacity(1 + 8 + datagram.len());
                                relayed.push(TICK_TTL_INIT);
                                relayed.extend_from_slice(&tab_lane_id);
                                relayed.extend_from_slice(&datagram);
                                let _ = member.conn.send_datagram(relayed.into());
                            }
                        }
                    }
                } else if datagram.starts_with(b"ping") {
                    let _ = connection.send_datagram(b"pong");
                }
            }
            // Bidirectional synchronisation streams
            stream = connection.accept_bi() => {
                let (send, mut recv) = stream?;
                let hub_clone = hub.clone();
                let remote_addr_inner = remote_addr;
                let mut room_id_inner = chosen_room.lock().unwrap().clone();
                let connection_clone = connection.clone();
                let chosen_room_inner = chosen_room.clone();
                let iroh_clone = iroh_ep.clone();

                tokio::spawn(async move {
                    // P1.2 (issue #60): the peer dial runs in its own retrying task
                    // (dial_peer_with_retry) so a slow hole-punch never blocks this
                    // ysync reader. That task and this loop BOTH write to the stream's
                    // `send` half (bridge status vs. SyncStep2 responses), so share it
                    // behind an async Mutex — each writer holds the lock across a whole
                    // framed message, so frames never interleave.
                    let send = std::sync::Arc::new(tokio::sync::Mutex::new(send));
                    let mut length_buf = [0u8; 4];
                    loop {
                        if let Err(_) = recv.read_exact(&mut length_buf).await {
                            break;
                        }
                        let len = u32::from_le_bytes(length_buf) as usize;
                        let mut payload_buf = vec![0u8; len];
                        if let Err(_) = recv.read_exact(&mut payload_buf).await {
                            break;
                        }

                        let envelope: SsfEnvelope = match serde_json::from_slice(&payload_buf) {
                            Ok(env) => env,
                            _ => break,
                        };

                        if room_id_inner.is_none() {
                            room_id_inner = Some(envelope.room.clone());
                            *chosen_room_inner.lock().unwrap() = room_id_inner.clone();
                            let mut rooms = hub_clone.rooms.lock().unwrap();
                            let room = rooms.entry(envelope.room.clone()).or_insert_with(|| {
                                println!("🎨 Registering new room document: {}", envelope.room);
                                Room {
                                    doc: Doc::new(),
                                    local_connections: HashMap::new(),
                                    remote_peers: HashMap::new(),
                                    candidates: HashMap::new(),
                                    retained: RetainStore::new(),
                                    served: false,
                                }
                            });
                            room.local_connections.insert(remote_addr_inner, connection_clone.clone());
                            // C2 (room durability): a LOCAL browser bound this room, so this
                            // node's replica may ANSWER relayed SyncStep1s — and keeps doing
                            // so after the browser closes (the "owner left the browser but
                            // not the machine" fix). Sticky by design.
                            room.served = true;
                        }

                        // ChiaHub C1 Slice 3: a `cap` envelope from the LOCAL browser
                        // carries this room's key + flags (chia-mode = publish toggle,
                        // public-room = N8 guard) so the node can derive the room's chia
                        // lookup hint and seal presence records. Consumed locally and
                        // NEVER relayed to remote peers (the room key must not leave this
                        // machine) — hence the early `continue`. Read side, so the
                        // default build ingests it with no runtime switch (#231 D3).
                        if envelope.kind == "cap" {
                            #[cfg(feature = "chia-read")]
                            {
                                // The WebTransport listener binds every interface (remote
                                // browsers dial nodes too), so "local" is checked, not
                                // assumed: a cap from anywhere but loopback is dropped. A
                                // remote session could otherwise hand us a key of ITS
                                // choosing marked private and armed, and have this node
                                // publish its addresses under it — or out-sequence the
                                // local browser's caps for a room.
                                if chia_rooms::cap_source_is_local(&remote_addr_inner) {
                                    // #231 P6a: the cap outlives the process, beside the room
                                    // doc — written while the room map is still locked, so two
                                    // caps on two streams land on disk in acceptance order and
                                    // a restart never restores the stale one.
                                    // Under the card gate: a card batch that read this
                                    // room's posture finishes its sends before the new
                                    // cap lands (see `HubState::card_gate`).
                                    let _gate = hub_clone.card_gate.lock().await;
                                    let accepted = chia_rooms::ingest_room_cap(
                                        &hub_clone.chia_rooms,
                                        &envelope.room,
                                        &envelope.payload,
                                        chia_rooms::persist_room_cap,
                                    );
                                    // 📌 A room key arrived: its board can be sealed and
                                    // its tabs handed what others sealed, now.
                                    if accepted.is_some() {
                                        board_bundles::nudge();
                                    }
                                    // #231 P6b: the cards the room's pass carries for its
                                    // members, filed like a card handed over a live
                                    // connection — only where the room's cards may be used
                                    // (`may_use_cards`: known private, or a first visit by
                                    // a private pass before the door docs synced), so a
                                    // public or bundled room's hints never fill the
                                    // address book.
                                    if accepted.as_ref().is_some_and(|cap| cap.may_use_cards()) {
                                        let filed = chia_rooms::file_member_cards(
                                            &hub_clone.peers,
                                            std::path::Path::new(chia_contact::PEERS_FILE),
                                            &iroh_clone.id(),
                                            &envelope.room,
                                            &envelope.payload,
                                            chia_resolve::unix_now(),
                                        );
                                        if filed > 0 {
                                            println!("📇 {filed} member card(s) from room {}'s pass filed — their presence is now findable by key", envelope.room);
                                        }
                                        // And ours to the tabs, so the browser can carry it
                                        // in this room's passes (P6b): a live private cap
                                        // is the browser saying the room may have it — a
                                        // pass's word alone is not (`may_share_card`).
                                        if accepted
                                            .as_ref()
                                            .is_some_and(|cap| cap.hands_out_own_card(hub_clone.contact_key_durable, chia_contact::share_card_enabled()))
                                        {
                                            broadcast_own_card(&hub_clone, &envelope.room).await;
                                        }
                                    }
                                } else {
                                    eprintln!(
                                        "⛓️ ChiaHub lane: ignoring a room cap from a non-loopback browser session ({remote_addr_inner}) — caps are the LOCAL browser's alone"
                                    );
                                }
                            }
                            continue;
                        }

                        // ⛓️🥣 A `faucet` request from the LOCAL browser (the dish's
                        // status / take / give). The browser opens one stream per
                        // request, like `cap`, so it is served inline here and answered
                        // on the same stream; never relayed. Loopback-only for the same
                        // reason as `cap`: a remote session could otherwise spend from
                        // THIS node's wallet or claim to its address.
                        if envelope.kind == "faucet" {
                            #[cfg(feature = "chia-read")]
                            {
                                let reply = if chia_rooms::cap_source_is_local(&remote_addr_inner) {
                                    let ctx = chia_faucet::FaucetContext {
                                        rooms: &hub_clone.chia_rooms,
                                        #[cfg(feature = "chia-publish")]
                                        wallet: hub_clone.chia_wallet.lock().unwrap().clone(),
                                    };
                                    chia_faucet::handle_request(&ctx, &envelope.room, &envelope.payload).await
                                } else {
                                    eprintln!(
                                        "⛓️🥣 faucet: refusing a request from a non-loopback browser session ({remote_addr_inner})"
                                    );
                                    chia_faucet::FaucetReply::refused("faucet requests are the LOCAL browser's alone")
                                };
                                let mut s = send.lock().await;
                                let _ = write_faucet_reply(&mut *s, &envelope.room, envelope.seq, &reply).await;
                                // One request per stream: FIN our side after the reply so the
                                // browser's reader ends cleanly; its own FIN ends this loop at the
                                // next read (it closes its writer after the single frame).
                                let _ = s.finish().await;
                            }
                            continue;
                        }

                        // Dial a newly-advertised peer OFF this reader loop (issue #60
                        // symptoms 2 + 4): a hole-punch can take minutes, and dialing
                        // inline stalled every following ysync frame on this stream —
                        // the joiner's document (owner/name/players) never converged
                        // while the dial hung. dial_peer_with_retry backs off, binds
                        // the room, and reports status through the channel above.
                        if let Some(ref target_node_id_str) = envelope.iroh_node_id {
                            if let Ok(target_pub_key) = target_node_id_str.parse::<PublicKey>() {
                                // Self-dial guard (item D): the browser may list our OWN node
                                // in its member hints; never spend a dial ladder on ourselves.
                                let needs_dial = target_pub_key != iroh_clone.id() && {
                                    let rooms = hub_clone.rooms.lock().unwrap();
                                    rooms
                                        .get(&envelope.room)
                                        .map(|room| !room.remote_peers.contains_key(&target_pub_key))
                                        .unwrap_or(false)
                                };

                                // Single-flight (issue #60): claim the dial before
                                // spawning. Without this, a slow hole-punch keeps
                                // needs_dial=true and every subsequent browser
                                // envelope carrying this target spawns another dial
                                // ladder — a connection storm + leaked peer loops.
                                let claimed_dial = needs_dial && {
                                    hub_clone.dialing.lock().unwrap().insert(target_pub_key)
                                };
                                if claimed_dial {
                                    println!("📡 Dispatching Iroh Dial to remote peer key: {}", target_node_id_str);
                                    let relay_hints = envelope
                                        .iroh_relay_urls
                                        .clone()
                                        .filter(|hints| !hints.is_empty())
                                        .unwrap_or_else(|| hub_clone.configured_relays.clone());
                                    let direct_hints = envelope.iroh_direct_addrs.clone().unwrap_or_default();
                                    let hub_dial = hub_clone.clone();
                                    let iroh_dial = iroh_clone.clone();
                                    let room_dial = envelope.room.clone();
                                    let target_dial = target_node_id_str.clone();
                                    let send_dial = send.clone();
                                    // M3: the local browser's trust tier for this target
                                    // (advisory ordering; the WT lane is our own machine so
                                    // the dial isn't sig-gated here — the untrusted gossip
                                    // path below is). None ⇒ unvetted.
                                    let dial_tier = envelope.trust_tier.unwrap_or(TIER_UNVETTED);
                                    tokio::spawn(async move {
                                        dial_peer_with_retry(
                                            hub_dial,
                                            iroh_dial,
                                            room_dial,
                                            target_pub_key,
                                            target_dial,
                                            relay_hints,
                                            direct_hints,
                                            dial_tier,
                                            Some(send_dial),
                                        )
                                        .await;
                                    });
                                }
                            }
                        }

                        // M4: bootstrap-dial EVERY OTHER member hint too — not just the
                        // primary iroh_node_id above. If the primary host is unreachable,
                        // another reachable member still bootstraps us, and the node learns
                        // the whole roster (was memberHints[0]-only, a single point of dial
                        // failure); transitive gossip then meshes the rest. Each dial is
                        // single-flight guarded and tiered as a room co-member (TIER_ROOM).
                        if let Some(member_hints) = envelope.iroh_member_hints.clone() {
                            for mh in member_hints {
                                let mk = match mh.iroh_node_id.parse::<PublicKey>() {
                                    Ok(k) if k != iroh_clone.id() => k,
                                    _ => continue,
                                };
                                let needs_dial = {
                                    let rooms = hub_clone.rooms.lock().unwrap();
                                    rooms.get(&envelope.room).map(|r| !r.remote_peers.contains_key(&mk)).unwrap_or(true)
                                };
                                let claimed = needs_dial && hub_clone.dialing.lock().unwrap().insert(mk);
                                if claimed {
                                    let hub_m = hub_clone.clone();
                                    let iroh_m = iroh_clone.clone();
                                    let room_m = envelope.room.clone();
                                    let target_m = mh.iroh_node_id.clone();
                                    let relay_m = mh.iroh_relay_urls.clone().unwrap_or_default();
                                    let direct_m = mh.iroh_direct_addrs.clone().unwrap_or_default();
                                    tokio::spawn(async move {
                                        dial_peer_with_retry(
                                            hub_m, iroh_m, room_m, mk, target_m, relay_m, direct_m, TIER_ROOM, None,
                                        )
                                        .await;
                                    });
                                }
                            }
                        }

                        // Slice 2 verify-before-apply: under SSF_REQUIRE_SIG=reject a forged
                        // (signed-but-invalid) ysync is dropped BEFORE relay + merge; warn
                        // only logs it. The dial above is reachability (gated by M5.0), not
                        // state, so it's left to run.
                        if envelope.kind == "ysync" && sig_should_drop(&envelope, "wt-in") {
                            continue;
                        }

                        // Relayer/Bridge Pipeline: Forward stream updates over Iroh P2P to
                        // the bounded NEIGHBOR set (M5.3 in_mesh) — was ALL remote_peers.
                        // At N ≤ D_HIGH every peer is in_mesh, so small rooms are unchanged.
                        let room_id = room_id_inner.as_ref().unwrap();
                        let peers: Vec<iroh::endpoint::Connection> = {
                            let rooms = hub_clone.rooms.lock().unwrap();
                            rooms
                                .get(room_id)
                                .map(|r| {
                                    r.remote_peers
                                        .values()
                                        .filter(|m| m.in_mesh)
                                        .map(|m| m.conn.clone())
                                        .collect()
                                })
                                .unwrap_or_default()
                        };
                        let local_direct_hints = {
                            let fp = hub_clone.fingerprint.lock().unwrap();
                            fp.iroh_direct_addrs.clone()
                        };
                        let local_relay_hints = hub_clone.configured_relays.clone();

                        // Record browser-originated envelopes in the relay-dedup cache so a
                        // mesh echo can never re-enter this node as "new" (0.18.0 hub relay).
                        let self_id_str = iroh_clone.id().to_string();
                        {
                            let key = envelope_seen_key(&self_id_str, room_id, envelope.seq, &envelope.payload);
                            hub_clone.seen_envelopes.lock().unwrap().check_and_insert(key);
                        }

                        // M5.4: retain browser-originated ysync too, so THIS origin node can
                        // answer an IWANT for its OWN updates — not only relayed ones.
                        if envelope.kind == "ysync" {
                            let id = envelope_msg_id(&envelope.author, envelope.seq, &envelope.payload);
                            if let Some(room) = hub_clone.rooms.lock().unwrap().get_mut(room_id) {
                                room.retained.put(id, payload_buf.clone());
                            }
                        }

                        for peer_conn in peers {
                            let mut env_copy = envelope.clone();
                            // Append our own node ID to make tracking back-and-forth handshakes seamless
                            env_copy.iroh_node_id = Some(self_id_str.clone());
                            env_copy.iroh_relay_urls = if local_relay_hints.is_empty() {
                                None
                            } else {
                                Some(local_relay_hints.clone())
                            };
                            env_copy.iroh_direct_addrs = if local_direct_hints.is_empty() {
                                None
                            } else {
                                Some(local_direct_hints.clone())
                            };
                            let payload_bytes = serde_json::to_vec(&env_copy).unwrap();
                            let l_bytes = (payload_bytes.len() as u32).to_le_bytes();

                            tokio::spawn(async move {
                                if let Ok((mut send_stream, _recv_stream)) = peer_conn.open_bi().await {
                                    let _ = send_stream.write_all(&l_bytes).await;
                                    let _ = send_stream.write_all(&payload_bytes).await;
                                    // finish() = graceful FIN. Without it, dropping the send stream
                                    // RESETs it and the peer's read can get the reset before the
                                    // frame — silently dropping relayed ysync state (the cross-
                                    // internet host->joiner furniture/roster sync bug). quinn
                                    // retains + delivers the finished stream's data after the drop.
                                    let _ = send_stream.finish();
                                }
                            });
                        }

                        // Fan out to SIBLING local tabs on this node (issue #60):
                        // the remote path already forwards to local browsers
                        // (handle_iroh_connection), but a browser-originated ysync
                        // UPDATE was only relayed to remote peers + merged into the
                        // node doc — never to other tabs on the SAME node. So two
                        // tabs / two players on one machine synced movement (the tick
                        // lane fans out to local_connections) but NOT room state
                        // (chat, players, games, furniture). Forward the ORIGINAL
                        // envelope to every local connection except the sender; the
                        // receiver applies it as a server-origin update and never
                        // re-emits, so there is no echo. Only UPDATE/SyncStep2 frames
                        // are forwarded — a SyncStep1 is a per-tab handshake request
                        // and forwarding it would make siblings answer it spuriously.
                        if envelope.kind == "ysync" && is_ysync_state_frame(&envelope.payload) {
                            let siblings: Vec<Connection> = {
                                let rooms = hub_clone.rooms.lock().unwrap();
                                rooms
                                    .get(room_id)
                                    .map(|r| {
                                        r.local_connections
                                            .iter()
                                            .filter(|(&addr, _)| addr != remote_addr_inner)
                                            .map(|(_, conn)| conn.clone())
                                            .collect()
                                    })
                                    .unwrap_or_default()
                            };
                            for wt_conn in siblings {
                                let payload_bytes = serde_json::to_vec(&envelope).unwrap();
                                let l_bytes = (payload_bytes.len() as u32).to_le_bytes();
                                tokio::spawn(async move {
                                    if let Ok(opening) = wt_conn.open_bi().await {
                                        if let Ok((mut send_stream, _recv_stream)) = opening.await {
                                            let _ = send_stream.write_all(&l_bytes).await;
                                            let _ = send_stream.write_all(&payload_bytes).await;
                                        }
                                    }
                                });
                            }
                        }

                        // Merge locally
                        if envelope.kind == "ysync" {
                            let mut s = send.lock().await;
                            let _ = handle_ysync_message(&hub_clone, room_id, &envelope, &mut *s).await;
                        }
                    }
                });
            }
        }
    }
}

async fn run_iroh_listener(hub: SharedHub, endpoint: IrohEndpoint) -> Result<()> {
    println!("🔑 Unified Iroh Swarm listener online!");
    loop {
        let incoming = endpoint.accept().await;
        let incoming_conn = match incoming {
            Some(inc) => inc,
            None => continue,
        };

        // #231 P6a: how this Initial arrived — straight from an IP, or via a
        // relay — and whether its source address was validated, read before
        // the accept consumes the Incoming. The measured "inbound verified"
        // flag below needs exactly these two facts.
        #[cfg(feature = "chia-read")]
        let inbound_path = (incoming_conn.remote_addr(), incoming_conn.remote_addr_validated());

        // Same per-client tolerance as run_wt_listener: a peer failing its
        // handshake must not tear down the swarm listener for everyone else.
        let accepting = match incoming_conn.accept() {
            Ok(acc) => acc,
            Err(e) => {
                eprintln!("⚠️ Iroh incoming accept failed — still listening: {:?}", e);
                continue;
            }
        };
        let connection = match accepting.await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("⚠️ Iroh handshake failed — still listening: {:?}", e);
                continue;
            }
        };
        let remote_id = connection.remote_id();
        println!("🚀 Inbound P2P Swarm handshake from peer: {}", remote_id);
        #[cfg(feature = "chia-read")]
        note_inbound_verified(&hub, remote_id, &inbound_path);

        // 📦 A blob-lane connection is answered by the lane, under its serving
        // rule (a connected member of the blob's room), and never enters the
        // room machinery below.
        if connection.alpn() == iroh_blobs::ALPN {
            match hub.blobs.clone() {
                Some(lane) => {
                    tokio::spawn(lane.serve_connection(hub.clone(), connection));
                }
                None => connection.close(0u32.into(), b"no blob lane"),
            }
            continue;
        }

        let hub_clone = hub.clone();
        let iroh_clone = endpoint.clone();
        tokio::spawn(async move {
            // Inbound-accepted: learn the room from the peer's first ysync stream.
            if let Err(e) = handle_iroh_connection(hub_clone, connection, iroh_clone, None).await {
                eprintln!("⚠️ Swarm connection error with peer ({}): {:?}", remote_id, e);
            }
        });
    }
}

/// #231 P6a: an accepted connection whose Initial came DIRECTLY (no relay) from
/// a PUBLIC address, with that address validated, from a peer we were not
/// dialing — nor had dialed within [`DIAL_PINHOLE_GRACE`] — is proof that this
/// node is reachable inbound on that address family — the only thing a
/// presence record's flag may claim. A connection that arrived through a relay,
/// from a LAN peer, or after our own dial Initials opened the pinhole (a dial
/// still running, or one that ended inside the grace: the NAT mapping it made
/// outlives the task, and the peer's own hole-punch Initials come through it)
/// proves nothing and sets nothing. The mark carries the chain peak the watcher
/// knows (0 when it has none, or none fresh enough to trust), so the publisher
/// can tell "this era" from "last era".
#[cfg(feature = "chia-read")]
fn note_inbound_verified(hub: &SharedHub, remote_id: PublicKey, path: &(iroh::endpoint::IncomingAddr, bool)) {
    let (addr, validated) = path;
    let iroh::endpoint::IncomingAddr::Ip(sa) = addr else { return };
    if !validated {
        return;
    }
    let public = match sa.ip() {
        std::net::IpAddr::V4(v4) => ipv4_is_public(v4),
        std::net::IpAddr::V6(v6) => ipv6_is_public(v6),
    };
    if !public || dialed_lately(hub, &remote_id, std::time::Instant::now()) {
        return;
    }
    let now = chia_resolve::unix_now();
    // A peak the watcher read too long ago (it or the peers down, maybe across
    // an era boundary) would date this mark into an era that has ended; an
    // unknown height makes the ledger judge by elapsed time instead.
    let height = hub.chia_peak.lock().unwrap().fresh(now).unwrap_or(0);
    let first_this_era = hub.inbound_verified.lock().unwrap().note(sa.is_ipv6(), height, now);
    if first_this_era {
        println!(
            "📡 inbound verified: an unsolicited direct {} connection from {} reached us — this era's presence record will say so",
            if sa.is_ipv6() { "IPv6" } else { "IPv4" },
            sa.ip()
        );
    }
}

/// How long after a dial task ends an inbound connection from its target still
/// counts as one we enabled: the UDP mapping our Initials opened in a NAT lives
/// on after the task (two minutes is the mapping lifetime RFC 4787 asks of a
/// NAT), and the peer's own Initials arrive through it. Only an inbound
/// connection from a peer we have not dialed in this long is unsolicited. A
/// reachable node that dialed the peer first is not misjudged, only measured
/// by a later peer instead.
#[cfg(feature = "chia-read")]
const DIAL_PINHOLE_GRACE: std::time::Duration = std::time::Duration::from_secs(120);

/// Did we dial `peer` lately: a dial in flight (`hub.dialing`), or one that
/// ended within [`DIAL_PINHOLE_GRACE`] (`hub.recent_dials`, pruned here and
/// in [`release_dial`])?
#[cfg(feature = "chia-read")]
fn dialed_lately(hub: &HubState, peer: &PublicKey, now: std::time::Instant) -> bool {
    if hub.dialing.lock().unwrap().contains(peer) {
        return true;
    }
    let mut recent = hub.recent_dials.lock().unwrap();
    recent.retain(|_, ended| now.duration_since(*ended) < DIAL_PINHOLE_GRACE);
    recent.contains_key(peer)
}

/// A contact-card send that has not finished in this long counts as not sent
/// (retried next tick) and lets go of the card gate, so a stalled peer cannot
/// hold up the browser's room caps.
#[cfg(feature = "chia-read")]
const CARD_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// How long one maintenance tick may spend on contact-card sends across all
/// its rooms; the rest wait for the next tick, so the loop's other duties
/// (heartbeats, prunes, grafts) run on time whatever the peers do.
#[cfg(feature = "chia-read")]
const CARD_BATCH_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);

/// Release a dial's single-flight claim once its task ended, however it ended,
/// remembering the dial for the pinhole grace FIRST: every path that claims a
/// dial (the browser's, the mesh's, the watcher's holds) releases it here, so
/// no inbound connection our own Initials enabled can pass as unsolicited, not
/// even in the instant between the two steps. Entries whose grace has run out
/// are dropped on every release, so the map holds the dials of the last two
/// minutes at most, however many unreachable peers a node tries in a row.
pub(crate) fn release_dial(hub: &HubState, peer: PublicKey) {
    #[cfg(feature = "chia-read")]
    {
        let now = std::time::Instant::now();
        let mut recent = hub.recent_dials.lock().unwrap();
        recent.retain(|_, ended| now.duration_since(*ended) < DIAL_PINHOLE_GRACE);
        recent.insert(peer, now);
    }
    hub.dialing.lock().unwrap().remove(&peer);
}

/// Is `peer` connected in `room_id` right now? Hold outcomes are recorded from
/// this, never from [`hold_dial`]'s return value alone: that is also `true` when
/// the room went away or another path linked first. A hold that ended with the
/// peer linked is contact, whichever path made the link; one that ended with no
/// link and no exhausted window (the room is gone) counts as nothing.
#[cfg(feature = "chia-read")]
pub(crate) fn linked_in_room(hub: &HubState, room_id: &str, peer: &PublicKey) -> bool {
    hub.rooms.lock().unwrap().get(room_id).is_some_and(|room| room.remote_peers.contains_key(peer))
}

// Issue #60 symptom 2: bounded, backing-off dial that runs OFF the browser's
// ysync reader loop so a multi-minute hole-punch never stalls document sync.
const MAX_DIAL_ATTEMPTS: u32 = 8;
const DIAL_BACKOFF_START_MS: u64 = 500;
const DIAL_BACKOFF_CAP_MS: u64 = 8000;

/// Dial a remote peer with bounded retry/backoff and ALWAYS release the
/// single-flight claim (`hub.dialing`) when done, however the dial ended —
/// success, exhaustion, or already-linked. The retry body has several early
/// returns, so the release lives here in the wrapper rather than at each exit.
async fn dial_peer_with_retry(
    hub: SharedHub,
    iroh_ep: IrohEndpoint,
    room_id: String,
    target_pub_key: PublicKey,
    target_str: String,
    relay_hints: Vec<String>,
    direct_hints: Vec<String>,
    dial_tier: u8,
    send: Option<std::sync::Arc<tokio::sync::Mutex<wtransport::SendStream>>>,
) {
    dial_peer_inner(
        hub.clone(),
        iroh_ep,
        room_id,
        target_pub_key,
        target_str,
        relay_hints,
        direct_hints,
        dial_tier,
        send,
    )
    .await;
    release_dial(&hub, target_pub_key);
}

/// Report a dial's status to the browser: to the specific `send` stream when the
/// dial was triggered by a local tab's envelope, or broadcast to every tab in the
/// room when it came from a node-side path (gossip/graft) with no single stream.
async fn report_dial_status(
    hub: &SharedHub,
    send: &Option<std::sync::Arc<tokio::sync::Mutex<wtransport::SendStream>>>,
    room_id: &str,
    target: &str,
    status: &str,
    detail: Option<&str>,
) {
    match send {
        Some(s) => {
            let mut g = s.lock().await;
            let _ = write_bridge_status(&mut *g, room_id, target, status, detail).await;
        }
        None => broadcast_bridge_status(hub, room_id, target, status, detail).await,
    }
}

/// Bind the connection to `room_id` (so its inbound ticks fan out — issue #60
/// symptom 4), report dialing/connected/failed to the browser, rebuild the
/// EndpointAddr from the hints each attempt, and re-check remote_peers before
/// every attempt so a peer another path already linked is left alone.
async fn dial_peer_inner(
    hub: SharedHub,
    iroh_ep: IrohEndpoint,
    room_id: String,
    target_pub_key: PublicKey,
    target_str: String,
    relay_hints: Vec<String>,
    direct_hints: Vec<String>,
    dial_tier: u8,
    send: Option<std::sync::Arc<tokio::sync::Mutex<wtransport::SendStream>>>,
) {
    report_dial_status(&hub, &send, &room_id, &target_str, "dialing", None).await;
    let mut delay = std::time::Duration::from_millis(DIAL_BACKOFF_START_MS);
    for attempt in 1..=MAX_DIAL_ATTEMPTS {
        let still_needs = {
            let rooms = hub.rooms.lock().unwrap();
            rooms
                .get(&room_id)
                .map(|room| !room.remote_peers.contains_key(&target_pub_key))
                .unwrap_or(false)
        };
        if !still_needs {
            return; // already linked by another path — nothing to do
        }

        let mut addr = EndpointAddr::new(target_pub_key);
        for relay_url_str in &relay_hints {
            match relay_url_str.parse::<RelayUrl>() {
                Ok(relay_url) => addr = addr.with_relay_url(relay_url),
                Err(e) => eprintln!("⚠️ Ignoring invalid relay hint '{}': {:?}", relay_url_str, e),
            }
        }
        for direct_addr_str in &direct_hints {
            match direct_addr_str.parse::<SocketAddr>() {
                Ok(socket_addr) => addr = addr.with_ip_addr(socket_addr),
                Err(e) => eprintln!("⚠️ Ignoring invalid direct hint '{}': {:?}", direct_addr_str, e),
            }
        }

        match iroh_ep.connect(addr, b"ssf").await {
            Ok(iroh_conn) => {
                println!(
                    "🎯 Iroh connection secured to peer node (attempt {}/{}).",
                    attempt, MAX_DIAL_ATTEMPTS
                );
                {
                    let mut rooms = hub.rooms.lock().unwrap();
                    if let Some(room) = rooms.get_mut(&room_id) {
                        let in_mesh = mesh_has_room_for(room, dial_tier);
                        room.remote_peers.insert(
                            target_pub_key,
                            MemberEntry::new(
                                iroh_conn.clone(),
                                dial_tier,
                                in_mesh,
                                PeerHints {
                                    relay_urls: relay_hints.clone(),
                                    direct_addrs: direct_hints.clone(),
                                },
                            ),
                        );
                        room.candidates.remove(&target_pub_key);
                    }
                }
                report_dial_status(&hub, &send, &room_id, &target_str, "connected", None).await;
                let hub_out = hub.clone();
                let iroh_out = iroh_ep.clone();
                let room_out = room_id.clone();
                tokio::spawn(async move {
                    if let Err(e) =
                        handle_iroh_connection(hub_out, iroh_conn, iroh_out, Some(room_out)).await
                    {
                        eprintln!("⚠️ Outbound P2P peer loop closed: {:?}", e);
                    }
                });
                return;
            }
            Err(e) => {
                eprintln!(
                    "⚠️ Dial attempt {}/{} to {} failed: {:?}",
                    attempt, MAX_DIAL_ATTEMPTS, target_str, e
                );
                if attempt < MAX_DIAL_ATTEMPTS {
                    tokio::time::sleep(delay).await;
                    delay = std::cmp::min(
                        delay * 2,
                        std::time::Duration::from_millis(DIAL_BACKOFF_CAP_MS),
                    );
                }
            }
        }
    }

    // [ChiaHub rung-6 fall-through] (Slice 5b, hold window since #231 P1). The
    // direct dial ladder is exhausted: rungs 1–4 (mDNS/DHT/hub/gossip/punch)
    // found no route. "Identity known, route unknown" is exactly the state the
    // chain makes recoverable with zero live infrastructure. If the browser
    // delivered this room's key (Slice 3) and the room is not public space
    // (N8/D6), resolve the target's CURRENT presence from testnet11 and HOLD the
    // dial on its public addrs: one attempt every 15 s for 3 min, so the other
    // side's own hold (its watcher sees us a beat later) finds our pinhole warm.
    // The resolve is a ~19s block query, so it runs OFF the `rooms` lock and only
    // after the fast ladder gave up — the chain is an address book, never a pipe.
    #[cfg(feature = "chia-read")]
    {
        // #231 P6a, FIRST: the target's PER-NODE presence, when its contact card
        // is in the address book (we met it in a private room before). Found by
        // the node's own key and the chain's era, whatever room this dial is
        // for. A hold that lands settles the dial; one that fails falls through
        // to the room-keyed v1 record below, which is tried only when it names
        // addresses the contact-key hold did not (v1 republishes on every
        // address change at once, the v2 record is debounced and capped).
        let mut held_by_ck: Option<Vec<SocketAddr>> = None;
        let target_ck = hub.peers.lock().unwrap().ck_of(&target_str);
        if let Some(ck) = target_ck {
            match chia_resolve::resolve_presence_by_ck(&ck, &target_str).await {
                Ok(Some(rec)) => {
                    let addrs = chia_public_dial_addrs(&rec.addrs);
                    if addrs.is_empty() {
                        println!("⛓️ ChiaHub rung-6: {target_str} found by contact key, but its presence record carries no public addr");
                    } else {
                        println!(
                            "⛓️ ChiaHub rung-6: {target_str} found by contact key — {} public addr(s), holding the dial for {}s",
                            addrs.len(),
                            chia_watch::HOLD_WINDOW.as_secs()
                        );
                        let ok = hold_dial(
                            hub.clone(),
                            iroh_ep.clone(),
                            room_id.clone(),
                            target_pub_key,
                            target_str.clone(),
                            addrs.clone(),
                            dial_tier,
                            send.clone(),
                        )
                        .await;
                        // Recorded from the link itself: `ok` is also true when the
                        // room went away mid-hold, which is neither contact nor failure.
                        let linked = linked_in_room(&hub, &room_id, &target_pub_key);
                        if linked || !ok {
                            let now = chia_resolve::unix_now();
                            let mut book = hub.peers.lock().unwrap();
                            if linked {
                                book.note_ok(&target_str, now);
                            } else {
                                book.note_fail(&target_str, now);
                            }
                            let _ = book.save(std::path::Path::new(chia_contact::PEERS_FILE));
                        }
                        if ok {
                            return;
                        }
                        let mut sorted = addrs;
                        sorted.sort();
                        held_by_ck = Some(sorted);
                    }
                }
                Ok(None) => println!("⛓️ ChiaHub rung-6: no presence record under {target_str}'s contact key this era or last"),
                Err(e) => eprintln!("⛓️ ChiaHub rung-6 contact-key resolve error: {e:#}"),
            }
        }
        let chia_cap = hub.chia_rooms.lock().unwrap().get(&room_id).cloned();
        if let Some(cap) = chia_cap {
            if cap.may_read() {
                match chia_resolve::resolve_target(&cap.room_key, &target_str).await {
                    Ok(Some(rec)) => {
                        let addrs = chia_public_dial_addrs(&rec.addrs);
                        let same_as_held = held_by_ck.as_ref().is_some_and(|held| {
                            let mut sorted = addrs.clone();
                            sorted.sort();
                            &sorted == held
                        });
                        if addrs.is_empty() {
                            println!("⛓️ ChiaHub rung-6: resolved {target_str} but no public addr survived the trust filter");
                        } else if same_as_held {
                            println!("⛓️ ChiaHub rung-6: the room record names the same addresses the contact-key hold just tried — not holding again");
                        } else {
                            println!(
                                "⛓️ ChiaHub rung-6: resolved {target_str} on-chain — {} public addr(s), holding the dial for {}s",
                                addrs.len(),
                                chia_watch::HOLD_WINDOW.as_secs()
                            );
                            // hold_dial reports its own outcome to the browser.
                            let ok = hold_dial(
                                hub.clone(),
                                iroh_ep.clone(),
                                room_id.clone(),
                                target_pub_key,
                                target_str.clone(),
                                addrs,
                                dial_tier,
                                send.clone(),
                            )
                            .await;
                            // The dial as a whole reached the peer (judged on the room,
                            // since a vanished room also ends the hold with `true`): the
                            // failure the contact-key leg noted above was a stale v2
                            // address, not an unreachable peer, and must not count
                            // toward pruning.
                            if held_by_ck.is_some() && linked_in_room(&hub, &room_id, &target_pub_key) {
                                let mut book = hub.peers.lock().unwrap();
                                if book.peers.contains_key(&target_str) {
                                    book.note_ok(&target_str, chia_resolve::unix_now());
                                    let _ = book.save(std::path::Path::new(chia_contact::PEERS_FILE));
                                }
                            }
                            // Settled only when the peer linked (or the room went
                            // away, which `ok` also says). A hold on stale v1
                            // addresses falls through to the knock below, as the
                            // contact-key hold does: returning here left a host
                            // with stale addresses never knocked on (#272 review).
                            if ok {
                                return;
                            }
                        }
                    }
                    Ok(None) => {}
                    Err(e) => eprintln!("⛓️ ChiaHub rung-6 resolve error: {e:#}"),
                }
            }
        }
    }

    // #231 P6b: the ladder AND the chain holds are exhausted. Two last resorts,
    // by the room's posture.
    #[cfg(feature = "chia-read")]
    {
        let cap = hub.chia_rooms.lock().unwrap().get(&room_id).cloned();
        match cap {
            // A private room whose host we hold a card for: KNOCK — one record
            // only the host can open, saying we want in; both sides then dial
            // on its confirmation height (`chia_knock`). Queued for the
            // publisher (one spend per tick, once per host per era) — only
            // while one runs, and the watcher with it: without the publish
            // build, `SSF_CHIA_LANE=1` and a wallet the queue has no consumer,
            // and without the watcher a sent knock is never judged or dialed
            // on, so no knock is queued or promised and the log says what one
            // needs (#272 review rounds 11 and 14); an unfunded wallet is the
            // publisher's to report.
            Some(cap) if cap.may_use_cards() => {
                let keys = hub.peers.lock().unwrap().card_keys_of(&target_str);
                if let Some((ck, kx)) = keys {
                    if !hub.knock_publishing.load(std::sync::atomic::Ordering::Relaxed) {
                        println!(
                            "⛓️ ChiaHub rung-6: {target_str} unreachable by every path — a knock through the chain would reach it, but this node cannot write one: a chain knock needs the publish build with SSF_CHIA_LANE=1, a wallet loaded and the watcher on (SSF_CHIA_WATCH not 0) (not queued)"
                        );
                        report_dial_status(&hub, &send, &room_id, &target_str, "failed", Some("no route; this node cannot knock (publishing or the watcher off)")).await;
                        return;
                    }
                    let req = chia_knock::KnockRequest {
                        room: room_id.clone(),
                        host: target_str.clone(),
                        ck_host: ck,
                        kx_host: kx,
                        attempts: 0,
                    };
                    if chia_knock::enqueue(&mut hub.knock_queue.lock().unwrap(), req) {
                        println!(
                            "⛓️ ChiaHub rung-6: {target_str} unreachable by every path — a knock is queued (written once per era; both sides dial on its confirmation height)"
                        );
                    }
                    report_dial_status(&hub, &send, &room_id, &target_str, "failed", Some("no route; knocking through the chain")).await;
                    return;
                }
            }
            // The WELCOME room (the bundled key): no inbox, no knock (N8). Dial
            // the newest BEACONS instead (D7): nodes that opted into being its
            // public entry points this era, by node id through the DHT, so the
            // room is reached through any of them and its relay — additive,
            // only after the pass's own hints failed, since the beacon hint is
            // anyone's to fill. A beacon advertises a node, not membership in
            // any other room: dialed for another public room it would open a
            // relay-only room with no doc and nobody in it (#272 review round
            // 3), so other public rooms get neither knock nor beacon.
            Some(cap) if cap.public_room == Some(true) && chia_rooms::is_bundled_room_key(&cap.room_key) => {
                beacon_fallback(&hub, &iroh_ep, &room_id, dial_tier).await;
            }
            _ => {}
        }
    }

    report_dial_status(
        &hub,
        &send,
        &room_id,
        &target_str,
        "failed",
        Some(&format!("no route after {} attempts", MAX_DIAL_ATTEMPTS)),
    )
    .await;
}

/// #231 P6b/D7: beacons dialed per fall-through in the welcome room, at most.
#[cfg(feature = "chia-read")]
pub const BEACON_DIALS: usize = 3;

/// #231 P6b/D7: when the welcome room's beacons were last read, per room id —
/// one read per [`chia_watch::TARGET_COOLDOWN`], since every exhausted dial in
/// the welcome room would otherwise read the hint again.
#[cfg(feature = "chia-read")]
static BEACON_READ_AT: std::sync::LazyLock<Mutex<HashMap<String, std::time::Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// #231 P6b/D7: the WELCOME room's last resort — read this era's (and the last
/// era's) beacons and hold-dial the newest few by node id, each on its own
/// single-flight claim, as unvetted members of `room_id` (the welcome room,
/// which every beacon serves: [`chia_publish::serves_welcome_room`]). Their
/// addresses come from the DHT (the shipped posture for a bare node id); a
/// beacon carries none.
#[cfg(feature = "chia-read")]
async fn beacon_fallback(hub: &SharedHub, iroh_ep: &IrohEndpoint, room_id: &str, dial_tier: u8) {
    {
        let mut last = BEACON_READ_AT.lock().unwrap();
        if last.get(room_id).is_some_and(|t| t.elapsed() < chia_watch::TARGET_COOLDOWN) {
            return;
        }
        last.insert(room_id.to_string(), std::time::Instant::now());
    }
    // A beacon is signed by the node it names and checked when decoded, so the
    // chain is only its carrier: the first reachable peer will do (plan §14 (5)),
    // as for the presence reader and the watcher.
    let client = chia_chain::connect_carrier();
    let now = chia_resolve::unix_now();
    let Some(peak) = chia_resolve::peak_height(&client).await else { return };
    let beacons = match chia_resolve::read_beacons(&client, peak, now).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("⛓️ ChiaHub beacons: read failed: {e:#}");
            return;
        }
    };
    if beacons.is_empty() {
        println!("⛓️ ChiaHub beacons: nobody beacons this era or last — room {room_id} stays unreached by the chain");
        return;
    }
    let self_id = iroh_ep.id();
    let mut started = 0usize;
    for b in beacons {
        if started >= BEACON_DIALS {
            break;
        }
        let pk = b.item.node_id;
        if pk == self_id || linked_in_room(hub, room_id, &pk) || !hub.dialing.lock().unwrap().insert(pk) {
            continue;
        }
        started += 1;
        let target = pk.to_string();
        println!(
            "⛓️ ChiaHub beacons: dialing beacon {} for room {room_id} (era {}, by node id through the DHT)",
            &target[..target.len().min(16)],
            b.item.era
        );
        let hub_b = hub.clone();
        let ep_b = iroh_ep.clone();
        let room_b = room_id.to_string();
        let tier = dial_tier.min(TIER_UNVETTED);
        tokio::spawn(async move {
            hold_dial(hub_b.clone(), ep_b, room_b, pk, target, vec![], tier, None).await;
            release_dial(&hub_b, pk);
        });
    }
}

/// #231 P6b: hand this node's own contact card to the local tabs of `room_id`
/// (kind `card`, node-local lane), so the browser can carry it in the room's
/// passes. Sent whenever a live private cap for the room is accepted.
#[cfg(feature = "chia-read")]
async fn broadcast_own_card(hub: &SharedHub, room_id: &str) {
    let card = chia_contact::make_card(&hub.secret_key, &hub.contact_key, chia_resolve::unix_now());
    let Ok(payload) = serde_json::to_vec(&card) else { return };
    broadcast_loopback_envelope(hub, room_id, "card", payload).await;
}

/// #231 P1 HOLD WINDOW: dial `target` at `addrs` every `HOLD_PERIOD` for up to
/// `HOLD_WINDOW` (15 s × 180 s), until the connection lands or another path
/// links the peer first. The repeated Initials keep OUR NAT pinhole warm while
/// the other side's own hold — started a few beats later by its watcher, the
/// symmetric trigger — does the same, so two NATed nodes meet with no live
/// introducer. `addrs` arrive public-only from [`chia_public_dial_addrs`]; the
/// first attempt tries the IPv6 ones alone (see below), later attempts all of
/// them. The CALLER owns the `hub.dialing` single-flight claim. Reports
/// dialing/connected/failed to the browser; returns true on link, and also when
/// the hold became moot (another path linked first, or the room is gone), so
/// callers judge contact by [`linked_in_room`], not by the return value.
#[cfg(feature = "chia-read")]
pub(crate) async fn hold_dial(
    hub: SharedHub,
    iroh_ep: IrohEndpoint,
    room_id: String,
    target_pub_key: PublicKey,
    target_str: String,
    addrs: Vec<SocketAddr>,
    dial_tier: u8,
    send: Option<std::sync::Arc<tokio::sync::Mutex<wtransport::SendStream>>>,
) -> bool {
    use chia_watch::{HOLD_PERIOD, HOLD_WINDOW};
    let started_hold = std::time::Instant::now();
    let deadline = started_hold + HOLD_WINDOW;
    report_dial_status(&hub, &send, &room_id, &target_str, "dialing", Some("chain hold")).await;
    // IPv6 FIRST, for real: iroh keeps an endpoint's addresses in a set, so the
    // order we add them in says nothing about the order it probes them. The
    // first attempt therefore carries the IPv6 addresses ALONE when there are
    // any (a v6 path needs no punch and lands or fails fast); every later
    // attempt carries both families, which iroh probes together.
    let v6_only: Vec<SocketAddr> = addrs.iter().copied().filter(|sa| sa.is_ipv6()).collect();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let still_needs = {
            let rooms = hub.rooms.lock().unwrap();
            rooms
                .get(&room_id)
                .map(|room| !room.remote_peers.contains_key(&target_pub_key))
                .unwrap_or(false)
        };
        if !still_needs {
            return true; // linked by another path (or the room is gone) — nothing to do
        }
        let this_attempt: &[SocketAddr] =
            if attempt == 1 && !v6_only.is_empty() && v6_only.len() < addrs.len() { &v6_only } else { &addrs };
        let mut addr = EndpointAddr::new(target_pub_key);
        for sa in this_attempt {
            addr = addr.with_ip_addr(*sa);
        }
        let attempt_started = std::time::Instant::now();
        // Each attempt is bounded by ONE period, so a hung attempt (the NAT
        // drops every Initial, the usual failure) never stretches the cadence:
        // the next Initial leaves on the 15 s beat whatever happened to the
        // last one. A handshake that needs longer than 15 s has already lost.
        match tokio::time::timeout(HOLD_PERIOD, iroh_ep.connect(addr, b"ssf")).await {
            Ok(Ok(iroh_conn)) => {
                println!(
                    "🎯 ChiaHub hold: connection secured to {target_str} on attempt {attempt} after {}s",
                    started_hold.elapsed().as_secs()
                );
                {
                    let mut rooms = hub.rooms.lock().unwrap();
                    if let Some(room) = rooms.get_mut(&room_id) {
                        let in_mesh = mesh_has_room_for(room, dial_tier);
                        room.remote_peers.insert(
                            target_pub_key,
                            MemberEntry::new(
                                iroh_conn.clone(),
                                dial_tier,
                                in_mesh,
                                PeerHints {
                                    relay_urls: vec![],
                                    direct_addrs: addrs.iter().map(|s| s.to_string()).collect(),
                                },
                            ),
                        );
                        room.candidates.remove(&target_pub_key);
                    }
                }
                report_dial_status(&hub, &send, &room_id, &target_str, "connected", None).await;
                let hub_out = hub.clone();
                let iroh_out = iroh_ep.clone();
                let room_out = room_id.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_iroh_connection(hub_out, iroh_conn, iroh_out, Some(room_out)).await {
                        eprintln!("⚠️ ChiaHub-introduced peer loop closed: {:?}", e);
                    }
                });
                return true;
            }
            Ok(Err(e)) => {
                if attempt == 1 || attempt % 4 == 0 {
                    eprintln!("⛓️ ChiaHub hold: attempt {attempt} to {target_str} failed: {e:?}");
                }
            }
            Err(_) => {
                if attempt == 1 || attempt % 4 == 0 {
                    eprintln!("⛓️ ChiaHub hold: attempt {attempt} to {target_str} timed out");
                }
            }
        }
        let now = std::time::Instant::now();
        if now >= deadline {
            break;
        }
        let elapsed = now.saturating_duration_since(attempt_started);
        if elapsed < HOLD_PERIOD {
            tokio::time::sleep(std::cmp::min(HOLD_PERIOD - elapsed, deadline.saturating_duration_since(now))).await;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    report_dial_status(
        &hub,
        &send,
        &room_id,
        &target_str,
        "failed",
        Some(&format!("chain hold: no link after {attempt} attempts in {}s", HOLD_WINDOW.as_secs())),
    )
    .await;
    false
}

/// Handles one node↔node iroh connection. Returns a BOXED future because the
/// gossip mesh-upgrade path spawns this function recursively — a plain
/// `async fn` cannot name its own future type (E0283 cycle).
fn handle_iroh_connection(
    hub: SharedHub,
    connection: iroh::endpoint::Connection,
    iroh_ep: IrohEndpoint,
    preset_room: Option<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send>> {
    Box::pin(async move {
    let remote_id = connection.remote_id();
    let self_id = iroh_ep.id();
    // Room binding (issue #60 symptom 4): a connection we DIALED already knows
    // its room, so pre-seed it. Without this, chosen_room stayed None on the
    // dialing side and its inbound-datagram gate (below) silently dropped every
    // tick the remote peer sent — the joiner saw the host's ticks vanish while
    // the accepting side (whose chosen_room gets set by the peer's first bi
    // stream) still saw the joiner. Inbound-accepted conns still pass None and
    // learn their room from the first ysync stream, exactly as before.
    let chosen_room: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(preset_room));

    // Split the two lanes into INDEPENDENT tasks. Racing them in one
    // tokio::select! starved the reliable ysync lane: a peer streaming 20Hz
    // movement ticks kept read_datagram() perpetually ready, so accept_bi() was
    // cancelled every loop iteration before it could accept a single stream — the
    // joiner received the host's TICKS (avatar spawned) but never its ysync STATE
    // (players map, chat, roomInfo). Separate loops let both lanes make progress.
    {
        let connection = connection.clone();
        let hub = hub.clone();
        let chosen_room = chosen_room.clone();
        tokio::spawn(async move {
            // Unreliable Datagram lane routing incoming ticks directly to browser WebTransport
            loop {
                let datagram = match connection.read_datagram().await {
                    Ok(d) => d,
                    Err(_) => break,
                };
                // M5.1: ANY inbound datagram from this peer proves liveness — a tick
                // OR the 6-byte heartbeat (which then falls through the tick parse
                // below as a non-tick and is harmlessly ignored). Brief lock, dropped
                // at once; never nested with the tick-dedup cache.
                {
                    let room_id_snapshot = chosen_room.lock().unwrap().clone();
                    if let Some(ref room_id) = room_id_snapshot {
                        if let Some(room) = hub.rooms.lock().unwrap().get_mut(room_id) {
                            match room.remote_peers.get_mut(&remote_id) {
                                Some(m) => m.last_seen = std::time::Instant::now(),
                                // Re-admit a pruned-but-LIVE peer (review HIGH): a transient
                                // heartbeat gap can prune a peer whose QUIC connection + this
                                // reader are still alive; without re-admission that hardens into
                                // a permanent one-way partition (we'd never relay to it again).
                                None => {
                                    let in_mesh = mesh_has_room_for(room, TIER_UNVETTED);
                                    room.remote_peers.insert(
                                        remote_id,
                                        MemberEntry::new(connection.clone(), TIER_UNVETTED, in_mesh, PeerHints::default()),
                                    );
                                }
                            }
                        }
                    }
                }
                // M5.2: byte[0] is now a decrementing TTL, not a 0/1 hop flag.
                // 22B = [TTL][8B origin lane id][13B tick]; 14B = [TTL][13B tick]
                // (legacy, no sender id); 13B = bare legacy tick (no TTL → deliver
                // locally, never relay). Legacy ticks synthesize a per-node lane id
                // from the sender key — never aliased across nodes. origin_lane_id
                // keys the dedup cache.
                let (tick, ttl, origin_lane_id): (&[u8], u8, [u8; 8]) = if datagram.len() == 22 {
                    (&datagram[9..], datagram[0], datagram[1..9].try_into().unwrap())
                } else if datagram.len() == 14 {
                    // Legacy pre-M5.2 frame: byte[0] is an OLD 0/1 hop flag, NOT a
                    // TTL. Reading it AS a ttl made a version-mismatched peer's ticks
                    // parse as ttl 0/1 and get gated out of the relay below — so a
                    // joiner on an older node was invisible to sibling joiners' MOVEMENT
                    // (its chat still relayed, since ysync has no TTL). Grant a full
                    // flood budget instead; the dedup cache still kills loops.
                    (&datagram[1..], TICK_TTL_INIT, tick_lane_id(&[remote_id.as_bytes()]))
                } else if datagram.len() == 13 {
                    // Bare legacy tick, no TTL byte at all — same fix: full budget so a
                    // version-skewed joiner still reaches the rest of the room.
                    (&datagram[..], TICK_TTL_INIT, tick_lane_id(&[remote_id.as_bytes()]))
                } else {
                    (&datagram[..0], 0u8, [0u8; 8])
                };
                if tick.len() != 13 {
                    continue;
                }
                // M5.2 loop-kill — dedup BEFORE both local delivery and relay. The
                // key folds in the full 13B payload, so a wrapped u16 seq (recurs
                // every ~55 min per sender) can never alias a fresh tick and
                // false-drop it. Lifting the hop cap without this echo-storms in any
                // cycle: this is the hard constraint that makes the TTL flood safe.
                if !hub
                    .tick_seen
                    .lock()
                    .unwrap()
                    .check_and_insert(tick_seen_key(&origin_lane_id, tick))
                {
                    continue;
                }
                let room_id_snapshot = chosen_room.lock().unwrap().clone();
                if let Some(ref room_id) = room_id_snapshot {
                    let rooms = hub.rooms.lock().unwrap();
                    if let Some(room) = rooms.get(room_id) {
                        // Down to local browser tabs as [8B origin lane id][13B tick]
                        let mut addressed = Vec::with_capacity(8 + tick.len());
                        addressed.extend_from_slice(&origin_lane_id);
                        addressed.extend_from_slice(tick);
                        for (_, wt_conn) in &room.local_connections {
                            let _ = wt_conn.send_datagram(&addressed[..]);
                        }
                        // [M5.5-STUB: per-tick authorship — DEFERRED] origin_lane_id is
                        // minted by the unauthenticated tick_lane_id() and relayed VERBATIM
                        // below, so an admitted/compromised neighbor can forge any foreign
                        // origin_lane_id and flood it within its TTL budget. Closing this
                        // needs a periodic SIGNED epoch key binding origin_lane_id → a
                        // trusted pubkey, carried on the RELIABLE lane (a 64B Ed25519 sig
                        // can't fit the 13/22B datagram budget — it must be amortized
                        // per-epoch, not per-tick) and verified here before relay. The
                        // browser can't participate (it holds no tick-lane key), so this is
                        // a node-only seam. Deferred per m345-v029-build-plan §M5.5: for the
                        // 3–8 node trusted rooms this release targets, spoof resistance rests
                        // on neighbor-trust + TTL + dedup, which is an acceptable interim.
                        //
                        // M5.2 multi-hop flood: while TTL allows, relay the tick with a
                        // decremented TTL to the bounded NEIGHBOR set (M5.3 in_mesh),
                        // except the peer we received it from. The dedup above (not the
                        // back-edge filter alone) is what kills 3rd-node return loops.
                        // Relay while any budget remains (was `ttl > 1`): the DEDUP
                        // cache above — not the TTL — is what kills return loops (M5.2
                        // note), so a ttl==1 frame should still get its single hop out
                        // to the neighbor set instead of dying one node short. A
                        // genuinely exhausted frame (ttl 0) still stops here.
                        if ttl >= 1 {
                            let mut relayed = Vec::with_capacity(1 + 8 + tick.len());
                            relayed.push(ttl.saturating_sub(1));
                            relayed.extend_from_slice(&origin_lane_id);
                            relayed.extend_from_slice(tick);
                            for (peer_id, member) in room.remote_peers.iter().filter(|(_, m)| m.in_mesh) {
                                if *peer_id != remote_id {
                                    let _ = member.conn.send_datagram(relayed.clone().into());
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    // ── ysync (reliable bi-stream) lane — its OWN loop so ticks can't starve it ──
    // Multi-channel streams incoming from remote Iroh peers
    loop {
                let (mut _send, mut recv) = match connection.accept_bi().await {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let hub_clone = hub.clone();
                let mut room_id_inner = chosen_room.lock().unwrap().clone();
                let connection_clone = connection.clone();
                let chosen_room_inner = chosen_room.clone();
                let iroh_clone = iroh_ep.clone();
                let self_id_inner = self_id;
                
                tokio::spawn(async move {
                    let mut length_buf = [0u8; 4];
                    loop {
                        if let Err(_) = recv.read_exact(&mut length_buf).await {
                            break;
                        }
                        let len = u32::from_le_bytes(length_buf) as usize;
                        let mut payload_buf = vec![0u8; len];
                        if let Err(_) = recv.read_exact(&mut payload_buf).await {
                            break;
                        }

                        let envelope: SsfEnvelope = match serde_json::from_slice(&payload_buf) {
                            Ok(env) => env,
                            _ => break,
                        };

                        if room_id_inner.is_none() {
                            room_id_inner = Some(envelope.room.clone());
                            *chosen_room_inner.lock().unwrap() = room_id_inner.clone();
                            let mut rooms = hub_clone.rooms.lock().unwrap();
                            let room = rooms.entry(envelope.room.clone()).or_insert_with(|| {
                                Room {
                                    doc: Doc::new(),
                                    local_connections: HashMap::new(),
                                    remote_peers: HashMap::new(),
                                    candidates: HashMap::new(),
                                    retained: RetainStore::new(),
                                    // iroh-created room: relay-only until a local browser binds it.
                                    served: false,
                                }
                            });
                            let in_mesh = mesh_has_room_for(room, TIER_UNVETTED);
                            room.remote_peers.insert(
                                remote_id,
                                MemberEntry::new(connection_clone.clone(), TIER_UNVETTED, in_mesh, PeerHints::default()),
                            );
                            room.candidates.remove(&remote_id);
                        }

                        let room_id = room_id_inner.as_ref().unwrap();

                        // M5.1: a reliable frame from this peer proves liveness too, so an
                        // idle-but-connected neighbor (sends no ticks) isn't falsely pruned —
                        // and re-admits a pruned-but-live peer on its existing connection
                        // (review HIGH) so a transient prune can't become a permanent partition.
                        {
                            let mut rooms = hub_clone.rooms.lock().unwrap();
                            if let Some(room) = rooms.get_mut(room_id) {
                                match room.remote_peers.get_mut(&remote_id) {
                                    Some(m) => m.last_seen = std::time::Instant::now(),
                                    None => {
                                        let in_mesh = mesh_has_room_for(room, TIER_UNVETTED);
                                        room.remote_peers.insert(
                                            remote_id,
                                            MemberEntry::new(connection_clone.clone(), TIER_UNVETTED, in_mesh, PeerHints::default()),
                                        );
                                    }
                                }
                            }
                        }

                        // M5.0: the signed CONTROL plane (roster/graft/prune/px/ihave/iwant),
                        // handled BEFORE the ysync dedup + relay so control messages (a) are
                        // never blind-flooded to the whole room — the amplifier the gossip
                        // mesh must never become — and (b) an IWANT is never swallowed by the
                        // dedup cache. Admission is STRICT and independent of SIG_MODE: a
                        // control envelope must be sig-Valid (not merely Unsigned, which
                        // warn-mode would wave through) or it is dropped, so a forged/unsigned
                        // roster entry can't hijack routing.
                        // ⛓️ Node-local lanes never arrive from a peer. `cap` (the room
                        // key + flags) and `faucet` (the dish's request and reply) are
                        // spoken only between this node and ITS loopback browser, and
                        // `bridge` only by this node to its tabs; none is ever relayed,
                        // so one coming in over iroh is a forgery. Dropped here, before
                        // dedup, the tab forward and the hub relay: forwarded, a peer's
                        // `faucet` envelope would reach the local tabs as if this node
                        // had answered, and a spoofed status could put an attacker's
                        // address under the dish's COPY button (#245 review, round 3).
                        if is_local_lane_kind(&envelope.kind) {
                            eprintln!(
                                "🔒 LANE-DROP {} from remote peer {} (node-local kind, never relayed)",
                                envelope.kind, remote_id
                            );
                            continue;
                        }

                        if is_control_kind(&envelope.kind) {
                            if control_should_admit(&envelope) {
                                dispatch_control(&hub_clone, room_id, remote_id, &envelope).await;
                            } else {
                                eprintln!(
                                    "🔒 CTRL-DROP {} (unsigned/invalid sig) from {}",
                                    envelope.kind, remote_id
                                );
                            }
                            continue;
                        }

                        // 🌐 Relay-dedup gate (0.18.0): drop envelopes we've already seen so
                        // hub relaying can never echo-storm once meshes form. The origin
                        // identity travels in iroh_node_id (stamped by the origin node).
                        let origin_id_str = envelope
                            .iroh_node_id
                            .clone()
                            .unwrap_or_else(|| remote_id.to_string());
                        {
                            let key = envelope_seen_key(&origin_id_str, room_id, envelope.seq, &envelope.payload);
                            if !hub_clone.seen_envelopes.lock().unwrap().check_and_insert(key) {
                                continue;
                            }
                        }

                        // Slice 2 verify-before-apply (iroh path): under SSF_REQUIRE_SIG=reject
                        // a forged (signed-but-invalid) ysync is dropped BEFORE the gossip-dial,
                        // relay and merge — we act on nothing a bad signature carries; warn logs.
                        if envelope.kind == "ysync" && sig_should_drop(&envelope, "iroh-in") {
                            continue;
                        }

                        // M5.4: retain state-bearing envelopes (keyed by author+seq+payload,
                        // NOT origin+seq — sibling tabs share a node id) so a neighbor that
                        // missed this frame can pull it back via IWANT instead of a re-flood.
                        if envelope.kind == "ysync" {
                            let id = envelope_msg_id(&envelope.author, envelope.seq, &envelope.payload);
                            if let Some(room) = hub_clone.rooms.lock().unwrap().get_mut(room_id) {
                                room.retained.put(id, payload_buf.clone());
                            }
                        }

                        // 📇 Membership gossip → M5.0 SIGNED mesh-upgrade dial. A relayed
                        // envelope may introduce a THIRD party (origin ≠ this connection's
                        // peer). We still learn it and, if the smaller-id rule elects us, dial
                        // it — but the old inline `iroh_ep.connect()` here was the amplifier:
                        // it (a) dialed off ANY relayed bytes with no signature check, (b)
                        // bypassed the `hub.dialing` single-flight so a gossip burst for one
                        // peer stormed dials, and (c) ran the connect INLINE, stalling this
                        // ysync reader for the whole hole-punch. M5.0 closes all three:
                        //   • require the carrying envelope to be sig-Valid (never blind-dial
                        //     an unsigned/forged origin — a bad browser can still lie about a
                        //     key it could already reach, but not inject arbitrary targets);
                        //   • claim `hub.dialing` before dispatching;
                        //   • route through dial_peer_with_retry (bounded backoff, room-bind,
                        //     bridge status via broadcast since there's no single tab stream).
                        // The gossip-learned peer is also recorded as an INTRODUCED-tier graft
                        // candidate (M5.3) whether or not we dial right now.
                        if let Ok(origin_key) = origin_id_str.parse::<PublicKey>() {
                            // IPv6 self-healing mesh: BOTH sides dial (the old
                            // `self_id < origin_key` smaller-id rule elected only ONE
                            // dialer to avoid glare). But a stateful IPv6 firewall only
                            // opens for a flow the device itself started — so a one-
                            // sided dial is dropped as unsolicited inbound and never
                            // connects two firewalled spokes. Both peers dialing (each
                            // sends an outbound probe to the DHT-resolved node route)
                            // opens BOTH pinholes; iroh dedups the resulting connection
                            // by node id, and hub.dialing single-flights each side, so
                            // the double-dial is bounded, not a storm. Still node-id
                            // ONLY with EMPTY hints (below) — the DHT resolves the
                            // route, no relay can aim the handshake (reflection stays
                            // closed).
                            if origin_key != self_id_inner
                                && origin_key != remote_id
                                && verify_envelope_sig(&envelope) == SigVerdict::Valid
                            {
                                // SECURITY (review HIGH): the signature covers the payload +
                                // author, NOT the iroh_node_id / direct_addrs — a relaying node
                                // can swap those. So a gossip-learned peer is dialed by NODE ID
                                // ONLY, with EMPTY address hints: iroh resolves the real route
                                // via the sovereign Mainline DHT + mDNS. This denies a malicious
                                // relay the ability to aim our QUIC handshake at an arbitrary IP
                                // (reflection/amplification). The trusted, browser-supplied
                                // roster (M4 member hints on the WT lane) still carries addrs —
                                // that path is our own machine, not a relayed third party.
                                let hints = PeerHints::default();
                                let needs_dial = {
                                    let mut rooms = hub_clone.rooms.lock().unwrap();
                                    match rooms.get_mut(room_id) {
                                        Some(room) if !room.remote_peers.contains_key(&origin_key) => {
                                            insert_candidate_bounded(
                                                room,
                                                origin_key,
                                                Candidate { tier: TIER_INTRODUCED, hints: hints.clone(), cooldown_until: None },
                                            );
                                            true
                                        }
                                        _ => false,
                                    }
                                };
                                let claimed = needs_dial
                                    && hub_clone.dialing.lock().unwrap().insert(origin_key);
                                if claimed {
                                    println!("📇 Gossip-learned peer {} — signed mesh-upgrade dial", origin_id_str);
                                    let hub_g = hub_clone.clone();
                                    let iroh_g = iroh_clone.clone();
                                    let room_g = room_id.clone();
                                    let target_g = origin_id_str.clone();
                                    tokio::spawn(async move {
                                        dial_peer_with_retry(
                                            hub_g,
                                            iroh_g,
                                            room_g,
                                            origin_key,
                                            target_g,
                                            hints.relay_urls,
                                            hints.direct_addrs,
                                            TIER_INTRODUCED,
                                            None,
                                        )
                                        .await;
                                    });
                                }
                            }
                        }

                        // Relayer/Bridge Pipeline: Forward stream updates down to local browser tab
                        let clients: Vec<Connection> = {
                            let rooms = hub_clone.rooms.lock().unwrap();
                            rooms.get(room_id).map(|r| r.local_connections.values().cloned().collect()).unwrap_or_default()
                        };

                        for wt_conn in clients {
                            let payload_bytes = serde_json::to_vec(&envelope).unwrap();
                            let l_bytes = (payload_bytes.len() as u32).to_le_bytes();

                            tokio::spawn(async move {
                                if let Ok(opening) = wt_conn.open_bi().await {
                                    if let Ok((mut send_stream, _recv_stream)) = opening.await {
                                        let _ = send_stream.write_all(&l_bytes).await;
                                        let _ = send_stream.write_all(&payload_bytes).await;
                                    }
                                }
                            });
                        }

                        // 🌐 Hub relay (0.18.0): forward to the room's OTHER remote peers so
                        // spokes see each other through a reachable member. The envelope is
                        // relayed UNCHANGED — the origin's identity and dial hints survive
                        // (that's the membership gossip). Dedup above stops echo loops.
                        let relay_targets: Vec<(PublicKey, iroh::endpoint::Connection)> = {
                            let rooms = hub_clone.rooms.lock().unwrap();
                            rooms
                                .get(room_id)
                                .map(|r| {
                                    r.remote_peers
                                        .iter()
                                        // M5.3: eager-forward only to the bounded NEIGHBOR set
                                        // (in_mesh), never the sender or the origin. At N ≤
                                        // D_HIGH every peer is in_mesh (unchanged); above it,
                                        // only D_HIGH trust-ranked neighbors carry eager copies.
                                        .filter(|(peer_id, m)| {
                                            m.in_mesh
                                                && **peer_id != remote_id
                                                && peer_id.to_string() != origin_id_str
                                        })
                                        .map(|(id, m)| (*id, m.conn.clone()))
                                        .collect()
                                })
                                .unwrap_or_default()
                        };
                        for (_, peer_conn) in relay_targets {
                            let payload_bytes = serde_json::to_vec(&envelope).unwrap();
                            let l_bytes = (payload_bytes.len() as u32).to_le_bytes();
                            tokio::spawn(async move {
                                if let Ok((mut send_stream, _recv_stream)) = peer_conn.open_bi().await {
                                    let _ = send_stream.write_all(&l_bytes).await;
                                    let _ = send_stream.write_all(&payload_bytes).await;
                                    let _ = send_stream.finish();       // graceful FIN, not RESET (host->joiner fix)
                                }
                            });
                        }

                        // Sync natively — C2 (room durability): parse the y-sync SUB-TYPE
                        // instead of blind-decoding everything as an Update. A relayed
                        // SyncStep1 (subtype 0) used to fail Update::decode and be SILENTLY
                        // DROPPED — the single asymmetry that made a room die once its
                        // browsers closed even though this node still held the doc. A room a
                        // local browser participated in (`served`) now ANSWERS it with
                        // SyncStep2 built from the node's own doc (mirror of
                        // handle_ysync_message), sent point-to-point back down the RECEIVING
                        // connection — never the relay fan-out (echo risk). Un-served rooms
                        // and state frames behave exactly as before (also fixes the old
                        // `.unwrap()` panic on malformed ysync payloads).
                        if envelope.kind == "ysync" {
                            let sub = read_var_uint(&envelope.payload, 0).ok().and_then(|(mt, n1)| {
                                read_var_uint(&envelope.payload, n1)
                                    .ok()
                                    .map(|(st, n2)| (mt, st, n1 + n2))
                            });
                            match sub {
                                Some((0, 0, cursor)) => {
                                    // Relayed SyncStep1: answer from our doc when served.
                                    // Diff built under the lock, sent after dropping it.
                                    let diff = {
                                        let rooms = hub_clone.rooms.lock().unwrap();
                                        match rooms.get(room_id) {
                                            Some(room) if room.served => {
                                                read_length_and_buf(&envelope.payload, cursor)
                                                    .ok()
                                                    .and_then(|(sv_bytes, _)| StateVector::decode_v1(&sv_bytes).ok())
                                                    .map(|client_sv| room.doc.transact().encode_diff_v1(&client_sv))
                                            }
                                            _ => None,
                                        }
                                    };
                                    if let Some(diff) = diff {
                                        let mut encoder = EncoderV1::new();
                                        encoder.write_var(0u32); // messageType = Sync
                                        encoder.write_var(1u32); // syncSubType = SyncStep2
                                        encoder.write_buf(&diff);
                                        let reply_env = SsfEnvelope {
                                            v: 1,
                                            room: room_id.clone(),
                                            kind: "ysync".to_string(),
                                            seq: envelope.seq + 1,
                                            author: vec![],
                                            payload: encoder.to_vec(),
                                            sig: None,
                                            iroh_node_id: Some(self_id_inner.to_string()),
                                            iroh_relay_urls: None,
                                            iroh_direct_addrs: None,
                                            trust_tier: None,
                                            iroh_member_hints: None,
                                        };
                                        if let Ok(bytes) = serde_json::to_vec(&reply_env) {
                                            let reply_conn = connection_clone.clone();
                                            tokio::spawn(async move {
                                                send_framed(&reply_conn, &bytes).await;
                                            });
                                        }
                                    }
                                }
                                Some((0, 1, cursor)) | Some((0, 2, cursor)) => {
                                    // SyncStep2 / Update: merge into our replica (as before).
                                    if let Ok((update_bytes, _)) = read_length_and_buf(&envelope.payload, cursor) {
                                        if let Ok(update) = Update::decode_v1(&update_bytes) {
                                            let rooms = hub_clone.rooms.lock().unwrap();
                                            if let Some(room) = rooms.get(room_id) {
                                                let mut txn = room.doc.transact_mut();
                                                let _ = txn.apply_update(update);
                                            }
                                        }
                                    }
                                }
                                _ => {} // unknown framing — ignore, never panic
                            }
                        }
                    }
                });
    }
    Ok(())
    })
}

/// Push a bridge-status envelope to EVERY local browser in a room (used from
/// contexts that don't hold a specific browser stream, e.g. gossip mesh dials).
async fn broadcast_bridge_status(
    hub: &SharedHub,
    room_id: &str,
    target_node_id: &str,
    status: &str,
    detail: Option<&str>,
) {
    let body = serde_json::json!({
        "target": target_node_id,
        "status": status,
        "detail": detail,
    });
    broadcast_local_envelope(hub, room_id, "bridge", body.to_string().into_bytes()).await;
}

/// Push one node-authored envelope of a node-local `kind` (see
/// [`is_local_lane_kind`]) to EVERY browser connected to this node in a room.
async fn broadcast_local_envelope(hub: &SharedHub, room_id: &str, kind: &str, payload: Vec<u8>) {
    broadcast_tab_envelope(hub, room_id, kind, payload, |_| true).await;
}

/// [`broadcast_local_envelope`] to the LOOPBACK tabs alone (#272 review round
/// 3): `local_connections` also holds browsers that dialed this node from other
/// machines (the listener binds every interface), registered under whatever
/// room their first envelope named, so a frame that must stay on this machine
/// — the node's own contact card — picks its recipients by address, the test a
/// `cap` must pass to be believed.
#[cfg(feature = "chia-read")]
async fn broadcast_loopback_envelope(hub: &SharedHub, room_id: &str, kind: &str, payload: Vec<u8>) {
    broadcast_tab_envelope(hub, room_id, kind, payload, chia_rooms::cap_source_is_local).await;
}

async fn broadcast_tab_envelope(hub: &SharedHub, room_id: &str, kind: &str, payload: Vec<u8>, admit: impl Fn(&SocketAddr) -> bool) {
    let env = SsfEnvelope {
        v: 1,
        room: room_id.to_string(),
        kind: kind.to_string(),
        seq: 0,
        author: vec![],
        payload,
        sig: None,
        iroh_node_id: None,
        iroh_relay_urls: None,
        iroh_direct_addrs: None,
        trust_tier: None,
        iroh_member_hints: None,
    };
    let Ok(bytes) = serde_json::to_vec(&env) else { return };
    let len_bytes = (bytes.len() as u32).to_le_bytes();
    let clients: Vec<Connection> = {
        let rooms = hub.rooms.lock().unwrap();
        rooms
            .get(room_id)
            .map(|r| r.local_connections.iter().filter(|(addr, _)| admit(addr)).map(|(_, c)| c.clone()).collect())
            .unwrap_or_default()
    };
    for wt_conn in clients {
        let bytes = bytes.clone();
        tokio::spawn(async move {
            if let Ok(opening) = wt_conn.open_bi().await {
                if let Ok((mut send_stream, _recv_stream)) = opening.await {
                    let _ = send_stream.write_all(&len_bytes).await;
                    let _ = send_stream.write_all(&bytes).await;
                }
            }
        });
    }
}

/// ⛓️🥣 Answer a `faucet` request on the stream it came in on (same framing as
/// every browser lane message: `[u32-LE len][JSON SsfEnvelope]`, JSON payload).
/// The request's `seq` is echoed so the browser can drop a status answered
/// out of order (its polls run on independent streams).
#[cfg(feature = "chia-read")]
async fn write_faucet_reply<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    room_id: &str,
    seq: u32,
    reply: &chia_faucet::FaucetReply,
) -> Result<()> {
    let env = SsfEnvelope {
        v: 1,
        room: room_id.to_string(),
        kind: "faucet".to_string(),
        seq,
        author: vec![],
        payload: serde_json::to_vec(reply)?,
        sig: None,
        iroh_node_id: None,
        iroh_relay_urls: None,
        iroh_direct_addrs: None,
        trust_tier: None,
        iroh_member_hints: None,
    };
    let bytes = serde_json::to_vec(&env)?;
    writer.write_all(&(bytes.len() as u32).to_le_bytes()).await?;
    writer.write_all(&bytes).await?;
    Ok(())
}

/// Push a `bridge` status envelope to the local browser so the UI can show
/// whether the cross-machine dial is in flight / connected / failed instead
/// of failing silently (🐛 0.16.0: dial failures were console-only).
async fn write_bridge_status<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    room_id: &str,
    target_node_id: &str,
    status: &str,
    detail: Option<&str>,
) -> Result<()> {
    let body = serde_json::json!({
        "target": target_node_id,
        "status": status,
        "detail": detail,
    });
    let env = SsfEnvelope {
        v: 1,
        room: room_id.to_string(),
        kind: "bridge".to_string(),
        seq: 0,
        author: vec![],
        payload: body.to_string().into_bytes(),
        sig: None,
        iroh_node_id: None,
        iroh_relay_urls: None,
        iroh_direct_addrs: None,
        trust_tier: None,
        iroh_member_hints: None,
    };
    let bytes = serde_json::to_vec(&env)?;
    let len_bytes = (bytes.len() as u32).to_le_bytes();
    writer.write_all(&len_bytes).await?;
    writer.write_all(&bytes).await?;
    Ok(())
}

// ── Mesh control plane (M5.0/M5.1/M5.3/M5.4) ─────────────────────────────────

/// A member/candidate advertised in a `roster` / `px` / `mesh-join` control
/// payload: the peer's node id + trust tier + dial hints.
#[derive(Serialize, Deserialize)]
struct RosterMember {
    #[serde(rename = "pub")]
    pubkey: String,
    #[serde(default)]
    tier: u8,
    #[serde(default)]
    relay_urls: Vec<String>,
    #[serde(default)]
    direct_addrs: Vec<String>,
}
#[derive(Serialize, Deserialize, Default)]
struct RosterPayload {
    members: Vec<RosterMember>,
}
/// `ihave` / `iwant` payload: hex-encoded `MsgId`s.
#[derive(Serialize, Deserialize, Default)]
struct IdsPayload {
    ids: Vec<String>,
}

/// M5.0: control kinds ride the reliable lane and are handled (never blind-
/// flooded, never merged) BEFORE the ysync relay. Kept as a single predicate so
/// the reader loop's branch and any future sender agree on the set.
fn is_control_kind(kind: &str) -> bool {
    matches!(
        kind,
        "roster" | "mesh-join" | "graft" | "prune" | "px" | "ihave" | "iwant" | "contact" | "bb-have" | "bb-want" | "bb"
    )
}

/// Kinds this node speaks only with its own browser tabs (`cap` and `faucet`
/// in from the loopback browser, `faucet` and `bridge` out to the tabs). They
/// are consumed or authored locally and never relayed, so one arriving from a
/// remote peer is dropped at the iroh ingress before it can be forwarded to
/// the tabs as if the node had said it.
fn is_local_lane_kind(kind: &str) -> bool {
    matches!(kind, "cap" | "faucet" | "bridge" | "card" | "board")
}

/// M5.0 STRICT admission: a control envelope must be sig-Valid. Unlike
/// `sig_should_drop` (which honours SIG_MODE and passes Unsigned so legacy ysync
/// still merges), no/invalid signature is ALWAYS rejected here — the control
/// plane can never be opened to forgeries, regardless of SSF_REQUIRE_SIG.
fn control_should_admit(env: &SsfEnvelope) -> bool {
    verify_envelope_sig(env) == SigVerdict::Valid
}

/// M5.4 lazy-pull (IHAVE/IWANT adverts) is opt-in; default off ships the deduped
/// flood alone. Read once — env is stable for the process lifetime.
fn lazypull_enabled() -> bool {
    static LAZY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *LAZY.get_or_init(|| std::env::var("SSF_MESH_LAZYPULL").ok().as_deref() == Some("1"))
}

/// SSF_MESH_DEBUG=1 prints a per-room mesh-state line each maintenance tick so a
/// multi-machine test can SEE the topology (who is connected to whom) — e.g. the
/// A–B–C line where C shows only B yet renders A's movement (multi-hop proof).
fn mesh_debug_enabled() -> bool {
    static DBG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *DBG.get_or_init(|| std::env::var("SSF_MESH_DEBUG").ok().as_deref() == Some("1"))
}

/// M5.3: may a newly-connected peer of `tier` join the bounded gossip neighbor
/// set? Yes while under `D_HIGH`; at capacity, only if it out-ranks the weakest
/// current neighbor (the maintenance loop then demotes that one). At N ≤ D_HIGH —
/// the 3–8 node target rooms — this is always true, so the mesh stays complete.
fn mesh_has_room_for(room: &Room, tier: u8) -> bool {
    let neighbors = room.remote_peers.values().filter(|m| m.in_mesh).count();
    if neighbors < D_HIGH {
        return true;
    }
    room.remote_peers
        .values()
        .filter(|m| m.in_mesh)
        .map(|m| m.tier)
        .min()
        .map(|weakest| tier > weakest)
        .unwrap_or(true)
}

fn msg_id_hex(id: &MsgId) -> String {
    hex::encode(id)
}
fn parse_msg_id(s: &str) -> Option<MsgId> {
    hex::decode(s).ok()?.as_slice().try_into().ok()
}

/// Build a node-signed control envelope: author = this node's iroh pubkey, sig
/// over the same canonical bytes the browser + Slice-2 verifier use. A receiver
/// runs `control_should_admit` → sig-Valid, so a forged roster can't be admitted.
fn node_signed_control(hub: &SharedHub, room: &str, kind: &str, seq: u32, payload: Vec<u8>) -> SsfEnvelope {
    let author = hub.secret_key.public().as_bytes().to_vec();
    let canonical = canonical_sign_bytes(1, room, kind, seq, &payload);
    let sig = hub.secret_key.sign(&canonical);
    let sig_b64 = base64::Engine::encode(&base64::prelude::BASE64_STANDARD, sig.to_bytes());
    SsfEnvelope {
        v: 1,
        room: room.to_string(),
        kind: kind.to_string(),
        seq,
        author,
        payload,
        sig: Some(sig_b64),
        iroh_node_id: Some(hub.secret_key.public().to_string()),
        iroh_relay_urls: None,
        iroh_direct_addrs: None,
        trust_tier: None,
        iroh_member_hints: None,
    }
}

/// Send raw framed bytes ([len:u32 LE][bytes]) on a fresh bi-stream, with the
/// finish() the host→joiner fix requires (a dropped stream RESETs and the frame
/// is silently lost). Returns whether the whole frame was written and finished;
/// callers that must retry a lost frame (#231 P6a's contact card) look at it,
/// the fire-and-forget senders ignore it as before.
async fn send_framed(conn: &iroh::endpoint::Connection, bytes: &[u8]) -> bool {
    let Ok((mut send_stream, _recv)) = conn.open_bi().await else { return false };
    let l = (bytes.len() as u32).to_le_bytes();
    if send_stream.write_all(&l).await.is_err() || send_stream.write_all(bytes).await.is_err() {
        return false;
    }
    send_stream.finish().is_ok()
}

/// Build + node-sign a control envelope and send it on `conn`. True when the
/// frame went out whole.
async fn send_control(
    hub: &SharedHub,
    conn: &iroh::endpoint::Connection,
    room: &str,
    kind: &str,
    seq: u32,
    payload: Vec<u8>,
) -> bool {
    let env = node_signed_control(hub, room, kind, seq, payload);
    match serde_json::to_vec(&env) {
        Ok(bytes) => send_framed(conn, &bytes).await,
        Err(_) => false,
    }
}

/// M5.4: cap ids served per IWANT so one request can't drain the whole retained
/// store (a compromised admitted neighbor is the residual risk; the deduped flood
/// stays correct regardless — lazy-pull is an efficiency layer).
const IWANT_MAX_SERVE: usize = 64;

/// M5.0 dispatch for an ADMITTED (sig-Valid) control envelope. Locks are taken
/// briefly and DROPPED before any `.await` (send) — the classic lock-across-await
/// deadlock is the sharpest hazard on these new paths.
async fn dispatch_control(hub: &SharedHub, room_id: &str, remote_id: PublicKey, env: &SsfEnvelope) {
    match env.kind.as_str() {
        // M5.3 candidate learning. A roster/px/join member is only a HINT: it is
        // recorded as a graft candidate (tier capped at introduced — a claim can't
        // mint direct trust) and must still re-pass the sig-Valid dial gate before
        // we ever connect to it.
        "roster" | "px" | "mesh-join" => {
            if let Ok(p) = serde_json::from_slice::<RosterPayload>(&env.payload) {
                let mut rooms = hub.rooms.lock().unwrap();
                if let Some(room) = rooms.get_mut(room_id) {
                    for m in p.members {
                        if let Ok(k) = m.pubkey.parse::<PublicKey>() {
                            if k != hub.secret_key.public() && !room.remote_peers.contains_key(&k) {
                                insert_candidate_bounded(
                                    room,
                                    k,
                                    Candidate {
                                        tier: m.tier.min(TIER_INTRODUCED),
                                        hints: PeerHints {
                                            relay_urls: m.relay_urls,
                                            direct_addrs: m.direct_addrs,
                                        },
                                        cooldown_until: None,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
        // #231 P6a: a peer's CONTACT CARD — its own, signed by its own key. The
        // envelope author must be the connection peer (as for graft/prune:
        // nobody hands out somebody else's card) and the card must name that
        // same peer. Filed in the address book under this room; never relayed,
        // never forwarded to the tabs (control kinds stop here).
        #[cfg(feature = "chia-read")]
        "contact" => {
            // Filed only where the room's cards are used (`may_use_cards`): a room
            // this process holds a live private cap for, or a private pass's word
            // on one whose posture is not yet known — never a public or bundled
            // room, not one restored from disk before the browser is back, and
            // not a room we hold no cap for at all (the first
            // envelope on a connection picks the room, so a peer can name any).
            // Without that, any visitor of a public room could file self-signed
            // identities until MAX_PEERS evicted the contacts that matter. Judged
            // before the signature, so a flood costs no verification; a card
            // dropped here comes again with the peer's next connection.
            let admitted = hub.chia_rooms.lock().unwrap().get(room_id).is_some_and(|cap| cap.may_use_cards());
            if env.author.as_slice() != remote_id.as_bytes() {
                eprintln!("🔒 CONTACT-DROP: card envelope not authored by the connection peer {remote_id}");
            } else if !admitted {
                eprintln!("🔒 CONTACT-DROP: card from {remote_id} in room {room_id}, which has no live private cap here");
            } else if let Ok(card) = serde_json::from_slice::<chia_contact::ContactCard>(&env.payload) {
                match chia_contact::verify_card(&card, chia_resolve::unix_now()) {
                    Ok(verified) if verified.node_id == remote_id => {
                        let changed = {
                            let mut book = hub.peers.lock().unwrap();
                            let changed = book.record_card(&verified, room_id);
                            // The card came over a live connection from this very
                            // peer: contact in itself, so the hold failures counted
                            // against it are forgiven — they would otherwise prune a
                            // peer we are talking to, a week after its card.
                            book.note_ok(&remote_id.to_string(), chia_resolve::unix_now());
                            if let Err(e) = book.save(std::path::Path::new(chia_contact::PEERS_FILE)) {
                                eprintln!("⛓️ ChiaHub contact: could not save {}: {e}", chia_contact::PEERS_FILE);
                            }
                            changed
                        };
                        if changed {
                            println!(
                                "📇 contact card from {} filed for room {room_id} — its presence is now findable by key",
                                remote_id.to_string().chars().take(16).collect::<String>()
                            );
                        }
                    }
                    Ok(_) => eprintln!("🔒 CONTACT-DROP: card from {remote_id} names another node"),
                    Err(e) => eprintln!("🔒 CONTACT-DROP from {remote_id}: {e}"),
                }
            } else {
                eprintln!("🔒 CONTACT-DROP: malformed card from {remote_id}");
            }
        }
        // M5.3 link-state: graft/prune are about THIS direct link, so require the
        // signer to be the connection peer (a relay can't toggle someone else's
        // membership). Local in_mesh is authoritative for who WE eager-forward to.
        "graft" | "prune" => {
            if env.author.as_slice() == remote_id.as_bytes() {
                let want = env.kind == "graft";
                let mut rooms = hub.rooms.lock().unwrap();
                if let Some(room) = rooms.get_mut(room_id) {
                    if let Some(m) = room.remote_peers.get_mut(&remote_id) {
                        m.in_mesh = want;
                    }
                }
            }
        }
        // M5.4 lazy-pull. IHAVE → reply IWANT for ids we lack; IWANT → serve the
        // retained envelopes. Collect under the lock, send after dropping it.
        // Gated OFF by default (review MEDIUM): with the sender opt-in, the
        // RESPONDER must be gated too or an admitted peer could still drive
        // unbounded IWANT serves (pull-amplification) against a default node.
        "ihave" if lazypull_enabled() => {
            let want: Vec<String> = {
                let rooms = hub.rooms.lock().unwrap();
                match rooms.get(room_id) {
                    Some(room) => serde_json::from_slice::<IdsPayload>(&env.payload)
                        .map(|p| {
                            p.ids
                                .into_iter()
                                .filter(|hex| {
                                    parse_msg_id(hex)
                                        .map(|id| room.retained.get(&id).is_none())
                                        .unwrap_or(false)
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                    None => return,
                }
            };
            if want.is_empty() {
                return;
            }
            let conn = {
                let rooms = hub.rooms.lock().unwrap();
                rooms.get(room_id).and_then(|r| r.remote_peers.get(&remote_id)).map(|m| m.conn.clone())
            };
            if let Some(conn) = conn {
                let payload = serde_json::to_vec(&IdsPayload { ids: want }).unwrap_or_default();
                send_control(hub, &conn, room_id, "iwant", 0, payload).await;
            }
        }
        "iwant" if lazypull_enabled() => {
            let (conn, bodies): (Option<iroh::endpoint::Connection>, Vec<Vec<u8>>) = {
                let rooms = hub.rooms.lock().unwrap();
                match rooms.get(room_id) {
                    Some(room) => {
                        let conn = room.remote_peers.get(&remote_id).map(|m| m.conn.clone());
                        let bodies = serde_json::from_slice::<IdsPayload>(&env.payload)
                            .map(|p| {
                                p.ids
                                    .iter()
                                    .take(IWANT_MAX_SERVE)
                                    .filter_map(|hex| parse_msg_id(hex).and_then(|id| room.retained.get(&id)))
                                    .collect()
                            })
                            .unwrap_or_default();
                        (conn, bodies)
                    }
                    None => return,
                }
            };
            if let Some(conn) = conn {
                for body in bodies {
                    send_framed(&conn, &body).await;
                }
            }
        }
        // 📌 #315 board bundles. Only ever between the two ends of a link: a
        // relayed copy (an older node forwards kinds it doesn't know) is
        // dropped, never answered, so nobody can aim our serves elsewhere.
        #[cfg(feature = "chia-read")]
        "bb-have" | "bb-want" | "bb" if board_bundles::enabled() => {
            if env.author.as_slice() == remote_id.as_bytes() {
                board_control(hub, room_id, remote_id, env).await;
            }
        }
        _ => {}
    }
}

/// 📌 #315: the rooms this node holds a key for, grouped by key: rooms can
/// share one (a legacy pass takes the home room's, #336 review), and so
/// their tags. Sorted, so a log names the same room each time.
#[cfg(feature = "chia-read")]
fn board_rooms_by_key(hub: &SharedHub) -> Vec<([u8; 32], Vec<String>)> {
    let mut by_key: HashMap<[u8; 32], Vec<String>> = HashMap::new();
    for (room, cap) in hub.chia_rooms.lock().unwrap().iter() {
        by_key.entry(cap.room_key).or_default().push(room.clone());
    }
    let mut out: Vec<([u8; 32], Vec<String>)> = by_key.into_iter().collect();
    for (_, rooms) in out.iter_mut() {
        rooms.sort();
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    out
}

/// 📌 #315: every tag this node can read (each key it holds, over the TTL's
/// days), and the key and rooms it opens as.
#[cfg(feature = "chia-read")]
fn board_tag_index(hub: &SharedHub, now: u64) -> HashMap<board_bundles::Tag, ([u8; 32], Vec<String>)> {
    let mut index = HashMap::new();
    for (key, rooms) in board_rooms_by_key(hub) {
        for tag in board_bundles::read_tags(&key, now) {
            index.insert(tag, (key, rooms.clone()));
        }
    }
    index
}

/// 📌 #315: one board-bundle control envelope from the connection's own peer.
#[cfg(feature = "chia-read")]
async fn board_control(hub: &SharedHub, room_id: &str, remote_id: PublicKey, env: &SsfEnvelope) {
    let now = chia_resolve::unix_now();
    let peer = remote_id.to_string();
    let conn = || {
        let rooms = hub.rooms.lock().unwrap();
        rooms.get(room_id).and_then(|r| r.remote_peers.get(&remote_id)).map(|m| m.conn.clone())
    };
    match env.kind.as_str() {
        // What the peer carries: ask for what we lack and would keep.
        "bb-have" => {
            let Ok(p) = serde_json::from_slice::<board_bundles::HavePayload>(&env.payload) else { return };
            let offered = board_bundles::parse_have(&p);
            let protected: std::collections::HashSet<board_bundles::Tag> = board_tag_index(hub, now).into_keys().collect();
            let want = {
                let mut lane = hub.board_bundles.lock().unwrap();
                lane.note_offered(&peer, &offered);
                lane.store.wanted(&offered, &protected, now)
            };
            if want.is_empty() {
                return;
            }
            if let Some(c) = conn() {
                let payload = board_bundles::WantPayload { ids: want.iter().map(hex::encode).collect() };
                send_control(hub, &c, room_id, "bb-want", 0, serde_json::to_vec(&payload).unwrap_or_default()).await;
            }
        }
        // What the peer asks for: serve it, within its window.
        "bb-want" => {
            let Ok(p) = serde_json::from_slice::<board_bundles::WantPayload>(&env.payload) else { return };
            let ids = board_bundles::parse_want(&p);
            let bundles = hub.board_bundles.lock().unwrap().serve(&peer, &ids, now);
            if bundles.is_empty() {
                return;
            }
            if let Some(c) = conn() {
                for b in bundles {
                    send_control(hub, &c, room_id, "bb", 0, b.to_bytes()).await;
                }
            }
        }
        // A bundle. Under a tag we can read, it must open as that room's.
        "bb" => {
            let Some(b) = board_bundles::Bundle::from_bytes(&env.payload) else {
                eprintln!("📌 BOARD-DROP: malformed bundle from {remote_id}");
                return;
            };
            // Charged before any work on it, so a bundle that won't open
            // costs its sender too (#332 review).
            if !hub.board_bundles.lock().unwrap().charge_peer(&peer, now) {
                eprintln!("📌 BOARD-DROP: bundle from {remote_id}: the peer is over its budget");
                return;
            }
            let index = board_tag_index(hub, now);
            // The room it opens as, under a tag we can read.
            let ours = match index.get(&b.tag) {
                Some((key, rooms)) => match rooms.iter().find(|room| board_bundles::open_bundle(key, room, &b).is_some()) {
                    Some(room) => Some(room.clone()),
                    None => {
                        eprintln!(
                            "📌 BOARD-DROP: a bundle from {remote_id} under room {}'s tag doesn't open as that room's",
                            rooms.join(", ")
                        );
                        return;
                    }
                },
                None => None,
            };
            let protected = index.into_keys().collect();
            let verdict = hub.board_bundles.lock().unwrap().admit_charged(&peer, b, now, &protected);
            match verdict {
                board_bundles::Admit::New => {
                    if let Some(room) = ours {
                        println!("📌 board bundle for room {room} from {}", peer.chars().take(16).collect::<String>());
                        board_bundles::nudge();
                    }
                }
                board_bundles::Admit::Known => {}
                board_bundles::Admit::Refused(why) => eprintln!("📌 BOARD-DROP: bundle from {remote_id}: {why}"),
            }
        }
        _ => {}
    }
}

/// 📌 #315: the board-bundle loop. Every minute, or soon after a nudge (a new
/// room key, a new bundle for one of our rooms), never twice in two seconds.
#[cfg(feature = "chia-read")]
async fn board_bundle_loop(hub: SharedHub) {
    let min_gap = std::time::Duration::from_secs(2);
    // The first pass waits for the browser's caps (or a nudge).
    let mut wait = std::time::Duration::from_secs(15);
    let mut last: Option<std::time::Instant> = None;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = board_bundles::NUDGE.notified() => {}
        }
        wait = std::time::Duration::from_secs(board_bundles::TICK_SECS);
        if let Some(since) = last.map(|t| t.elapsed()) {
            if since < min_gap {
                tokio::time::sleep(min_gap - since).await;
            }
        }
        last = Some(std::time::Instant::now());
        board_bundle_tick(&hub).await;
    }
}

/// 📌 #315: one pass: expire, publish what changed, advertise, feed the tabs.
#[cfg(feature = "chia-read")]
async fn board_bundle_tick(hub: &SharedHub) {
    use board_bundles::{BoardPlain, Tag};
    let now = chia_resolve::unix_now();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(now * 1000);
    let self_id = hub.secret_key.public().to_string();
    let caps: Vec<(String, [u8; 32])> =
        hub.chia_rooms.lock().unwrap().iter().map(|(room, cap)| (room.clone(), cap.room_key)).collect();
    let rooms_by_key = board_rooms_by_key(hub);
    let protected: std::collections::HashSet<Tag> =
        caps.iter().flat_map(|(_, key)| board_bundles::read_tags(key, now)).collect();

    // Under the rooms lock: each served room's board as our copy holds it,
    // one link per connected peer (any room), and the rooms' loopback tabs.
    let (contents, peers, tabs) = {
        let rooms = hub.rooms.lock().unwrap();
        let contents: Vec<(String, [u8; 32], board_bundles::BoardContent)> = caps
            .iter()
            .filter_map(|(room, key)| {
                let r = rooms.get(room)?;
                r.served.then(|| (room.clone(), *key, board_bundles::board_from_doc(&r.doc, room, now_ms)))
            })
            .collect();
        let mut peers: HashMap<PublicKey, (String, iroh::endpoint::Connection)> = HashMap::new();
        for (room_id, r) in rooms.iter() {
            for (k, m) in r.remote_peers.iter() {
                peers.entry(*k).or_insert_with(|| (room_id.clone(), m.conn.clone()));
            }
        }
        let tabs: HashMap<String, Vec<u8>> = caps
            .iter()
            .filter_map(|(room, _)| {
                let r = rooms.get(room)?;
                let mut addrs: Vec<String> = r
                    .local_connections
                    .keys()
                    .filter(|a| chia_rooms::cap_source_is_local(a))
                    .map(|a| a.to_string())
                    .collect();
                if addrs.is_empty() {
                    return None;
                }
                addrs.sort();
                Some((room.clone(), addrs.join("|").into_bytes()))
            })
            .collect();
        (contents, peers, tabs)
    };

    // Publish: a room's bundle goes out when its board changed, the day
    // turned, or six hours passed.
    {
        let mut lane = hub.board_bundles.lock().unwrap();
        lane.store.expire(now);
        // Junk carried under a room's tag before this node had its key goes
        // now, before our own bundle needs the room under that tag.
        for (key, rooms) in &rooms_by_key {
            let gone = lane.evict_unreadable(rooms, key, now);
            if gone > 0 {
                eprintln!("📌 dropped {gone} bundle(s) under room {}'s tags that don't open as its own", rooms.join(", "));
            }
        }
        for (room, key, content) in contents {
            if !lane.publish_due(&room, &content, now) {
                continue;
            }
            let at = lane.next_stamp(&room, now);
            let plain = BoardPlain {
                v: 1,
                room: room.clone(),
                publisher: self_id.clone(),
                at,
                notes: content.notes.clone(),
                down: content.down.clone(),
            };
            // Published only once the store keeps it (#332 review): a bundle
            // the store refuses (its tag full of bundles stamped ahead of
            // ours) or one that can't be sealed stays due for the next tick.
            match board_bundles::seal_fitting(&key, plain, &hub.secret_key) {
                Some(b) => match lane.store.admit(b, now, &protected) {
                    board_bundles::Admit::Refused(why) => {
                        eprintln!("📌 board bundle for room {room} not kept ({why}); trying again next tick");
                    }
                    _ => {
                        println!(
                            "📌 board bundle sealed for room {room}: {} note(s), {} take-down(s)",
                            content.notes.len(),
                            content.down.len()
                        );
                        lane.note_published(&room, &content, at);
                    }
                },
                None => eprintln!("📌 board bundle for room {room} could not be sealed; trying again next tick"),
            }
        }
    }

    // Advertise to every connected peer what it hasn't heard of yet.
    let connected: std::collections::HashSet<String> = peers.keys().map(|k| k.to_string()).collect();
    let adverts: Vec<(String, iroh::endpoint::Connection, Vec<u8>)> = {
        let mut lane = hub.board_bundles.lock().unwrap();
        lane.retain_peers(&connected);
        peers
            .into_iter()
            .filter_map(|(k, (room, conn))| {
                let items = lane.advert_for(&k.to_string(), now);
                (!items.is_empty())
                    .then(|| (room, conn, serde_json::to_vec(&board_bundles::have_payload(&items)).unwrap_or_default()))
            })
            .collect()
    };
    for (room, conn, payload) in adverts {
        let hub = hub.clone();
        tokio::spawn(async move {
            send_control(&hub, &conn, &room, "bb-have", 0, payload).await;
        });
    }

    // Our rooms' tabs: what other publishers sealed, when it changed.
    for (room, key) in &caps {
        let Some(fp) = tabs.get(room) else { continue };
        let view = hub.board_bundles.lock().unwrap().tab_view(room, key, &self_id, fp, now);
        if let Some(view) = view {
            let body = serde_json::json!({ "room": room, "notes": view.notes, "down": view.down });
            broadcast_loopback_envelope(hub, room, "board", body.to_string().into_bytes()).await;
        }
    }
}

/// M5.1 + M5.3 + M5.4: the node's periodic mesh maintenance — its first-ever
/// liveness. Every `HEARTBEAT_INTERVAL_SECS` it: prunes peers silent past the
/// miss window; rebalances the bounded neighbor set (demote weakest over D_HIGH,
/// promote/graft toward the target under D_LOW); heartbeats + IHAVE-adverts to
/// neighbors. All room mutation happens under the lock; every send/dial runs
/// AFTER the guard is dropped (no lock across await).
async fn mesh_maintenance_loop(hub: SharedHub, iroh_ep: IrohEndpoint) {
    let mut ticker = tokio::time::interval(std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
    let stale = std::time::Duration::from_secs(HEARTBEAT_INTERVAL_SECS * HEARTBEAT_MISS as u64);

    struct RoomWork {
        room: String,
        /// ALL connected peers — heartbeated for liveness so a connected-but-not-
        /// in-mesh peer isn't falsely pruned (liveness ≠ mesh membership).
        heartbeat_conns: Vec<iroh::endpoint::Connection>,
        /// in_mesh neighbors only — the bounded set that gets IHAVE adverts.
        neighbors: Vec<iroh::endpoint::Connection>,
        ihave_ids: Vec<MsgId>,
        graft: Vec<(PublicKey, PeerHints, u8)>,
        /// #231 P6a: connected peers that have not had our contact card yet.
        #[cfg(feature = "chia-read")]
        cards: Vec<(PublicKey, iroh::endpoint::Connection)>,
    }

    loop {
        ticker.tick().await;
        let mut work: Vec<RoomWork> = Vec::new();
        // #231 P6a: the rooms whose connected peers get our contact card — those
        // KNOWN private (never a bundled or PUBLIC room, N8). Snapshotted before
        // the rooms lock so the two locks are never nested.
        #[cfg(feature = "chia-read")]
        let sharing: std::collections::HashSet<String> = if chia_contact::share_card_enabled() && hub.contact_key_durable {
            hub.chia_rooms
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, cap)| cap.may_share_card())
                .map(|(room, _)| room.clone())
                .collect()
        } else {
            std::collections::HashSet::new()
        };
        {
            let now = std::time::Instant::now();
            let mut rooms = hub.rooms.lock().unwrap();
            for (room_id, room) in rooms.iter_mut() {
                // M5.1 prune silent peers (drops the Connection → stops doomed sends).
                let dead: Vec<PublicKey> = room
                    .remote_peers
                    .iter()
                    .filter(|(_, m)| now.duration_since(m.last_seen) > stale)
                    .map(|(k, _)| *k)
                    .collect();
                for k in &dead {
                    room.remote_peers.remove(k);
                    println!("💀 PRUNE peer {} (silent > {}s) in room {}", k, stale.as_secs(), room_id);
                }

                // M5.3 rebalance the bounded neighbor set.
                let mut neighbor_keys: Vec<PublicKey> =
                    room.remote_peers.iter().filter(|(_, m)| m.in_mesh).map(|(k, _)| *k).collect();
                // Demote the weakest-tier neighbors while over D_HIGH.
                while neighbor_keys.len() > D_HIGH {
                    if let Some(weak) = neighbor_keys
                        .iter()
                        .min_by_key(|k| room.remote_peers.get(*k).map(|m| m.tier).unwrap_or(0))
                        .copied()
                    {
                        if let Some(m) = room.remote_peers.get_mut(&weak) {
                            m.in_mesh = false;
                        }
                        neighbor_keys.retain(|k| *k != weak);
                    } else {
                        break;
                    }
                }
                // Promote connected-but-idle peers (highest tier first) toward target.
                if neighbor_keys.len() < TARGET_DEGREE {
                    let mut promotable: Vec<PublicKey> =
                        room.remote_peers.iter().filter(|(_, m)| !m.in_mesh).map(|(k, _)| *k).collect();
                    promotable.sort_by_key(|k| std::cmp::Reverse(room.remote_peers.get(k).map(|m| m.tier).unwrap_or(0)));
                    for k in promotable {
                        if neighbor_keys.len() >= TARGET_DEGREE {
                            break;
                        }
                        if let Some(m) = room.remote_peers.get_mut(&k) {
                            m.in_mesh = true;
                        }
                        neighbor_keys.push(k);
                    }
                }
                // Graft: still under D_LOW → dial trust-ranked candidates that are
                // NOT in dial cooldown (review LOW: a permanently-unreachable member
                // gossip keeps re-introducing must not be re-dialed every cycle).
                let mut graft = Vec::new();
                if neighbor_keys.len() < D_LOW {
                    let mut cands: Vec<(PublicKey, Candidate)> = room
                        .candidates
                        .iter()
                        .filter(|(_, c)| c.cooldown_until.map(|t| now >= t).unwrap_or(true))
                        .map(|(k, c)| (*k, c.clone()))
                        .collect();
                    cands.sort_by_key(|(_, c)| std::cmp::Reverse(c.tier));
                    for (k, c) in cands.into_iter().take(D_LOW - neighbor_keys.len()) {
                        if let Some(entry) = room.candidates.get_mut(&k) {
                            entry.cooldown_until = Some(now + GRAFT_COOLDOWN);
                        }
                        graft.push((k, c.hints, c.tier));
                    }
                }

                // #231 P6a: our card goes to every connected peer of a private room
                // that has not had it yet; the entry is marked only once the send
                // succeeded (below), so a frame lost to a stream error is retried
                // next tick. This loop is the only sender, one tick at a time.
                #[cfg(feature = "chia-read")]
                let cards: Vec<(PublicKey, iroh::endpoint::Connection)> = if sharing.contains(room_id) {
                    room.remote_peers
                        .iter()
                        .filter(|(_, m)| !m.card_sent)
                        .map(|(k, m)| (*k, m.conn.clone()))
                        .collect()
                } else {
                    Vec::new()
                };
                let heartbeat_conns: Vec<iroh::endpoint::Connection> =
                    room.remote_peers.values().map(|m| m.conn.clone()).collect();
                let neighbors: Vec<iroh::endpoint::Connection> =
                    room.remote_peers.values().filter(|m| m.in_mesh).map(|m| m.conn.clone()).collect();
                let ihave_ids = room.retained.recent_ids(32);
                if mesh_debug_enabled() {
                    let ids: Vec<String> = room
                        .remote_peers
                        .keys()
                        .map(|k| k.to_string().chars().take(4).collect::<String>())
                        .collect();
                    let in_mesh_n = room.remote_peers.values().filter(|m| m.in_mesh).count();
                    println!(
                        "🕸️ MESH room={} peers=[{}] in_mesh={} candidates={}",
                        room_id,
                        ids.join(","),
                        in_mesh_n,
                        room.candidates.len(),
                    );
                }
                work.push(RoomWork {
                    room: room_id.clone(),
                    heartbeat_conns,
                    neighbors,
                    ihave_ids,
                    graft,
                    #[cfg(feature = "chia-read")]
                    cards,
                });
            }
        }

        // Off-lock: heartbeats (datagram), IHAVE adverts (control), graft dials.
        #[cfg(feature = "chia-read")]
        let cards_started = std::time::Instant::now();
        for w in work {
            for conn in &w.heartbeat_conns {
                let _ = conn.send_datagram(HEARTBEAT_MAGIC.to_vec().into());
            }
            // #231 P6a: the contact card, node-signed like every control frame.
            // Only a peer whose frame went out whole, on the connection it still
            // holds, is marked as having it.
            #[cfg(feature = "chia-read")]
            if !w.cards.is_empty() {
                let card = chia_contact::make_card(&hub.secret_key, &hub.contact_key, chia_resolve::unix_now());
                if let Ok(payload) = serde_json::to_vec(&card) {
                    let mut delivered: Vec<(PublicKey, usize)> = Vec::new();
                    for (peer, conn) in &w.cards {
                        // The tick's card budget: `remote_peers` is not capped (only
                        // the mesh neighbors are) and a stalled send costs a whole
                        // `CARD_SEND_TIMEOUT`, so a room full of stalled connections
                        // must not keep every other room's heartbeats and prunes
                        // waiting. Unsent peers stay unmarked and get the card next tick.
                        if cards_started.elapsed() >= CARD_BATCH_BUDGET {
                            println!("📇 room {}: this tick's card budget is spent — the remaining contact cards go next tick", w.room);
                            break;
                        }
                        // Posture and ONE send under the gate: a cap turning this
                        // room public waits at most for the send in flight (bounded
                        // by `CARD_SEND_TIMEOUT`), lands between two sends, and the
                        // next check sees it — so no card authorized by a posture
                        // since replaced can leave, and the browser's caps never
                        // wait for a whole batch.
                        let sent = {
                            let _gate = hub.card_gate.lock().await;
                            let still_sharing =
                                hub.chia_rooms.lock().unwrap().get(&w.room).is_some_and(|cap| cap.may_share_card());
                            if !still_sharing {
                                println!("📇 room {} is no longer private — the remaining contact cards are not sent", w.room);
                                break;
                            }
                            tokio::time::timeout(
                                CARD_SEND_TIMEOUT,
                                send_control(&hub, conn, &w.room, "contact", 0, payload.clone()),
                            )
                            .await
                            .unwrap_or(false)
                        };
                        if sent {
                            delivered.push((*peer, conn.stable_id()));
                        } else {
                            eprintln!("📇 contact card to {peer} in room {} did not go out — retrying next tick", w.room);
                        }
                    }
                    if !delivered.is_empty() {
                        let mut rooms = hub.rooms.lock().unwrap();
                        if let Some(room) = rooms.get_mut(&w.room) {
                            for (peer, sent_on) in &delivered {
                                // The card went out on THAT connection. A peer that
                                // reconnected meanwhile holds a new entry (a new
                                // connection) that never saw it: left unmarked, it
                                // gets the card next tick.
                                if let Some(m) =
                                    room.remote_peers.get_mut(peer).filter(|m| m.conn.stable_id() == *sent_on)
                                {
                                    m.card_sent = true;
                                }
                            }
                        }
                        println!("📇 contact card sent to {} peer(s) in room {}", delivered.len(), w.room);
                    }
                }
            }
            // M5.4 lazy-pull adverts are OPT-IN (SSF_MESH_LAZYPULL=1). The deduped
            // TTL flood already converges state correctly on its own (the plan's
            // §5 confirms lazy-pull is an efficiency layer, not a correctness one);
            // shipping the pull sender OFF by default keeps the release to the
            // paths the two-machine test can actually exercise, while the retain
            // store + ihave/iwant handlers stay wired so flipping the flag Just Works.
            if lazypull_enabled() && !w.ihave_ids.is_empty() {
                let ids: Vec<String> = w.ihave_ids.iter().map(msg_id_hex).collect();
                if let Ok(payload) = serde_json::to_vec(&IdsPayload { ids }) {
                    for conn in &w.neighbors {
                        send_control(&hub, conn, &w.room, "ihave", 0, payload.clone()).await;
                    }
                }
            }
            for (k, hints, tier) in w.graft {
                let claimed = hub.dialing.lock().unwrap().insert(k);
                if claimed {
                    println!("🌿 GRAFT dial to candidate {} (tier {}) in room {}", k, tier, w.room);
                    let hub_g = hub.clone();
                    let iroh_g = iroh_ep.clone();
                    let room_g = w.room.clone();
                    let target = k.to_string();
                    tokio::spawn(async move {
                        dial_peer_with_retry(
                            hub_g, iroh_g, room_g, k, target, hints.relay_urls, hints.direct_addrs, tier, None,
                        )
                        .await;
                    });
                }
            }
        }
    }
}

/// True when a ysync payload is a STATE-bearing frame (SyncStep2 or Update) —
/// it carries doc changes to apply — versus a SyncStep1 handshake request.
/// Used to decide which browser-originated frames to fan out to sibling tabs.
fn is_ysync_state_frame(payload: &[u8]) -> bool {
    if let Ok((msg_type, n1)) = read_var_uint(payload, 0) {
        if msg_type == 0 {
            if let Ok((sub_type, _)) = read_var_uint(payload, n1) {
                return sub_type == 1 || sub_type == 2;
            }
        }
    }
    false
}

async fn handle_ysync_message<W: AsyncWriteExt + Unpin>(
    hub: &SharedHub,
    room_id: &str,
    envelope: &SsfEnvelope,
    writer: &mut W,
) -> Result<()> {    let payload = &envelope.payload;
    if payload.is_empty() {
        return Ok(());
    }

    let mut cursor = 0;
    let (msg_type, bytes_read) = read_var_uint(payload, cursor)?;
    cursor += bytes_read;

    if msg_type == 0 {
        let (sync_sub_type, bytes_read) = read_var_uint(payload, cursor)?;
        cursor += bytes_read;

        if sync_sub_type == 0 {
            let (client_sv_bytes, _) = read_length_and_buf(payload, cursor)?;
            let client_sv = StateVector::decode_v1(&client_sv_bytes)
                .map_err(|e| anyhow!("Failed decoding client state vector: {:?}", e))?;

            let mut encoder = EncoderV1::new();
            encoder.write_var(0u32); // messageType = Sync
            encoder.write_var(1u32); // syncSubType = SyncStep2

            let missing_diff = {
                let rooms = hub.rooms.lock().unwrap();
                let room = rooms.get(room_id).unwrap();
                let txn = room.doc.transact();
                txn.encode_diff_v1(&client_sv)
            };
            encoder.write_buf(&missing_diff);

            let reply_env = SsfEnvelope {
                v: 1,
                room: room_id.to_string(),
                kind: "ysync".to_string(),
                seq: envelope.seq + 1,
                author: vec![],
                payload: encoder.to_vec(),
                sig: None,
                iroh_node_id: None,
                iroh_relay_urls: None,
                iroh_direct_addrs: None,
                trust_tier: None,
                iroh_member_hints: None,
            };

            let reply_bytes = serde_json::to_vec(&reply_env)?;
            let len_bytes = (reply_bytes.len() as u32).to_le_bytes();
            writer.write_all(&len_bytes).await?;
            writer.write_all(&reply_bytes).await?;

        } else if sync_sub_type == 1 || sync_sub_type == 2 {
            let (update_bytes, _) = read_length_and_buf(payload, cursor)?;
            let update = Update::decode_v1(&update_bytes)
                .map_err(|e| anyhow!("Failed decoding update block: {:?}", e))?;

            {
                let rooms = hub.rooms.lock().unwrap();
                let room = rooms.get(room_id).unwrap();
                let mut txn = room.doc.transact_mut();
                txn.apply_update(update)
                    .map_err(|e| anyhow!("Failed to apply browser update: {:?}", e))?;
            }
        }
    }

    Ok(())
}

fn read_var_uint(bytes: &[u8], mut cursor: usize) -> Result<(u32, usize)> {
    let mut value: u32 = 0;
    let mut shift = 0;
    let start = cursor;
    loop {
        if cursor >= bytes.len() {
            return Err(anyhow!("Unexpected EOF parsing varint"));
        }
        let byte = bytes[cursor];
        cursor += 1;
        value |= ((byte & 0x7f) as u32) << shift;
        if byte & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 32 {
            return Err(anyhow!("Varint too long"));
        }
    }
    Ok((value, cursor - start))
}

fn read_length_and_buf(bytes: &[u8], mut cursor: usize) -> Result<(Vec<u8>, usize)> {
    let (len, bytes_read) = read_var_uint(bytes, cursor)?;
    cursor += bytes_read;
    let len = len as usize;
    if cursor + len > bytes.len() {
        return Err(anyhow!("Unexpected EOF reading buffer payload with size {}", len));
    }
    let buf = bytes[cursor..cursor + len].to_vec();
    Ok((buf, bytes_read + len))
}

async fn start_http_api_server(hub: SharedHub, iroh_endpoint: IrohEndpoint) {
    let mut port = 8080;
    let mut listener = None;
    while port <= 8081 {
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        match tokio::net::TcpListener::bind(addr).await {
            Ok(l) => {
                listener = Some((l, port));
                break;
            }
            Err(e) => {
                eprintln!("⚠️ Failed to bind HTTP API server on port {}: {:?}", port, e);
                port += 1;
            }
        }
    }
    
    let (listener, bound_port) = match listener {
        Some((l, p)) => (l, p),
        None => {
            eprintln!("⚠️ Failed to bind HTTP API server on both 8080 and 8081.");
            return;
        }
    };

    println!("🌍 Local HTTP API server listening on http://127.0.0.1:{}", bound_port);
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => continue,
        };
        let hub_clone = hub.clone();
        let iroh_snapshot = iroh_endpoint.clone();
        tokio::spawn(async move {
            // The whole request head, up to its blank line: a blob URL's
            // query and an upload's headers can outgrow one small read. What
            // follows the head is the start of an upload's body.
            let mut buf = Vec::with_capacity(1024);
            let mut chunk = [0u8; 4096];
            let head_end = loop {
                if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break i;
                }
                if buf.len() >= blob_lane::MAX_HEAD {
                    return;
                }
                match tokio::time::timeout(std::time::Duration::from_secs(10), socket.read(&mut chunk)).await {
                    Ok(Ok(n)) if n > 0 => buf.extend_from_slice(&chunk[..n]),
                    _ => return,
                }
            };
            let req = String::from_utf8_lossy(&buf[..head_end]).into_owned();
            let body_start: Vec<u8> = buf.get(head_end + 4..).map(<[u8]>::to_vec).unwrap_or_default();
            
            let req_lines: Vec<&str> = req.lines().collect();
            let mut origin_header = None;
            for line in req_lines {
                if line.to_ascii_lowercase().starts_with("origin:") {
                    origin_header = Some(line["origin:".len()..].trim().to_string());
                    break;
                }
            }

            // S1 CORS allowlist v2 (2026-07-08): any LOOPBACK page origin is allowed on
            // ANY port — a remote website can never present a loopback Origin, and dev
            // servers drift ports (Vite 5173→5174…). Non-loopback origins (public /
            // staging web lane) come from the SSF_ALLOWED_ORIGINS env (comma-separated),
            // never from code. Tauri WebView origins covered on all platforms
            // (tauri://localhost on macOS/Linux, http(s)://tauri.localhost on Windows).
            let origin_allowed = |origin: &str| -> bool {
                if origin.eq_ignore_ascii_case("tauri://localhost") {
                    return true;
                }
                let host = origin
                    .strip_prefix("http://")
                    .or_else(|| origin.strip_prefix("https://"))
                    .map(|rest| rest.split('/').next().unwrap_or(rest))
                    .map(|host_port| {
                        if let Some(v6) = host_port.strip_prefix('[') {
                            v6.split(']').next().unwrap_or(v6).to_string()
                        } else {
                            host_port.split(':').next().unwrap_or(host_port).to_string()
                        }
                    });
                if let Some(host) = host {
                    if host.eq_ignore_ascii_case("localhost")
                        || host == "127.0.0.1"
                        || host == "::1"
                        || host.eq_ignore_ascii_case("tauri.localhost")
                    {
                        return true;
                    }
                }
                std::env::var("SSF_ALLOWED_ORIGINS")
                    .map(|raw| raw.split(',').map(str::trim).any(|o| o.eq_ignore_ascii_case(origin)))
                    .unwrap_or(false)
            };

            let origin_ok = origin_header.as_deref().is_some_and(origin_allowed);
            let cors_origin = match origin_header {
                Some(ref o) if origin_allowed(o) => {
                    format!("Access-Control-Allow-Origin: {}\r\nVary: Origin\r\n", o)
                }
                _ => String::new(),
            };

            // 📦 The blob lane's routes (blob_lane.rs) — its gate is its own:
            // an allowed Origin AND this launch's token.
            if let Some(head) = blob_lane::parse_head(&req) {
                if head.method != "OPTIONS" && blob_lane::is_blob_route(&head.path) {
                    blob_lane::handle_http(
                        hub_clone.blobs.clone(), hub_clone.clone(), iroh_snapshot.clone(),
                        &mut socket, head, &body_start, origin_ok, &cors_origin,
                    ).await;
                    return;
                }
                // 🧲 The torrent lane's routes (torrent_lane.rs), behind the
                // same gate; a node built without the feature says so.
                if head.method != "OPTIONS" && head.path.starts_with("/api/torrent/") {
                    #[cfg(feature = "torrent")]
                    torrent_lane::handle_http(hub_clone.blobs.clone(), &mut socket, head, &body_start, origin_ok, &cors_origin).await;
                    #[cfg(not(feature = "torrent"))]
                    blob_lane::reply(
                        &mut socket, "501 Not Implemented", &cors_origin,
                        &blob_lane::err_json("this node was built without the torrent feature"),
                    ).await;
                    return;
                }
            }

            if req.starts_with("GET /api/fingerprint") {
                let fp_json = {
                    // 🐛 0.16.0 fix: refresh direct-addr hints from the LIVE endpoint
                    // view on every request. Portmapper mappings, QAD-observed and
                    // external addresses appear AFTER startup; a boot-time snapshot
                    // meant invites never carried the public-reachable addresses.
                    let live_direct_addrs: Vec<String> = iroh_snapshot
                        .addr()
                        .ip_addrs()
                        .filter(|sock| !sock.ip().is_unspecified())
                        .map(|sock| sock.to_string())
                        .collect();
                    let mut fp = hub_clone.fingerprint.lock().unwrap();
                    if !live_direct_addrs.is_empty() {
                        fp.iroh_direct_addrs = live_direct_addrs;
                    }
                    // R1: reachability is classified LIVE per request too —
                    // the echo loop and the portmapper both change state
                    // minutes after startup.
                    fp.reachability = classify_reachability(&hub_clone.reach, &fp.iroh_direct_addrs);
                    // #231 P6b: whether this node hands out its card, live too
                    // — the browser keeps the card it was handed, and must not
                    // carry it after a restart with sharing off (#272 review
                    // round 3).
                    #[cfg(feature = "chia-read")]
                    {
                        fp.share_card = hub_clone.contact_key_durable && chia_contact::share_card_enabled();
                    }
                    // ⛓️🏦 The wallet's receive address, live too: a wallet is
                    // loaded at startup or not at all, but the Bank app reads
                    // the fingerprint, and this is the one place the browser
                    // learns where its node is paid (never a pass, never a card).
                    #[cfg(feature = "chia-publish")]
                    {
                        fp.chia_address = hub_clone.chia_wallet.lock().unwrap().as_ref().map(chia_wallet::testnet_address);
                        // 📖 And the Phone Book listing state the publisher
                        // mirrored on its last tick, for the top bar's icon.
                        fp.chia_presence = hub_clone.presence_status.lock().unwrap().clone();
                    }
                    // 📦 The blob lane's token, for this machine's own page
                    // only: an origin the API does not grant cannot read the
                    // answer (no Access-Control-Allow-Origin for it), and a
                    // request with no Origin at all is a local process, not a
                    // web page.
                    fp.blob_cap = hub_clone.blobs.as_ref().map(|b| b.cap.clone());
                    fp.torrent = cfg!(feature = "torrent") && hub_clone.blobs.is_some();
                    serde_json::to_string(&*fp).unwrap()
                };
                let response = format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: application/json\r\n\
                     {}Access-Control-Allow-Methods: GET, OPTIONS\r\n\
                     Access-Control-Allow-Headers: *\r\n\
                     Content-Length: {}\r\n\
                     Connection: close\r\n\r\n\
                     {}",
                    cors_origin,
                    fp_json.len(),
                    fp_json
                );
                let _ = socket.write_all(response.as_bytes()).await;
            } else if req.starts_with("OPTIONS ") {
                // Access-Control-Allow-Private-Network answers Chromium PNA/LNA
                // preflights when a public-origin page dials this loopback API
                // (harmless for loopback-origin pages, which skip the gate).
                let response = format!(
                    "HTTP/1.1 204 No Content\r\n\
                     {}Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS\r\n\
                     Access-Control-Allow-Headers: *\r\n\
                     Access-Control-Allow-Private-Network: true\r\n\
                     Connection: close\r\n\r\n",
                    cors_origin
                );
                let _ = socket.write_all(response.as_bytes()).await;
            } else {
                let response = "HTTP/1.1 404 No Found\r\n\
                                Connection: close\r\n\r\n";
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });
    }
}
