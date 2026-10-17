//! #231 P6a: the node's CONTACT identity and its address book — the pieces
//! that make "find a NODE on chain" work without a room key.
//!
//! * `contact.key` — the contact key `ck`: 32 random bytes, 0600, beside
//!   `iroh_node_id.key`. Whoever holds it can derive this node's presence hint
//!   for any era and open the records under it; nobody else can. Rotating it is
//!   deleting the file (the next start mints a new one and the old cards go
//!   stale). It is NOT derived from the iroh key: a reader of our presence must
//!   not be able to compute it from our public node id.
//! * the X25519 keys — a long-term CARD key (what a contact card carries, so a
//!   P6b knock can be sealed before any presence record was read) and a key
//!   PER ERA (what the presence record carries). Both are derived one way from
//!   the iroh secret with domain-separated contexts: no extra files, and a
//!   leaked knock key never reveals the identity key.
//! * the CONTACT CARD — `{node_id, ck, kx_pk, issued_at}` signed by the node
//!   key, the payload of the `contact` control frame a node sends to the
//!   members of a PRIVATE room once connected to them by any path (the legacy
//!   way `ck` travels until P6b carries cards in passes). Never in a room doc,
//!   never relayed to browsers, forced off for bundled/PUBLIC rooms (N8).
//! * `peers.json` — the address book, keyed by iroh node id: the peer's `ck`
//!   and card key, the rooms it was met in, and dial outcomes. 0600: other
//!   nodes' contact keys are secrets we keep for them.
//! * the inbound-verified ledger — per address family, the last time this node
//!   ACCEPTED an unsolicited direct connection from a non-LAN peer. Measured,
//!   never declared; it becomes the per-address flag in the presence record.
//!
//! Opt-outs (D4 shape, default on): `SSF_CHIA_SHARE_CARD=0` sends no cards;
//! `SSF_CHIA_FINDABLE=0` publishes no per-node presence (`chia_publish`).
#![cfg(feature = "chia-read")]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::chia_lane::{era_of, ERA_SECS, FLAG_INBOUND_VERIFIED};

pub const CONTACT_KEY_FILE: &str = "contact.key";
pub const PEERS_FILE: &str = "peers.json";
/// A peer this many failed hold windows in a row, none successful for a week,
/// is forgotten (its card may be stale; a new one arrives if we meet again).
pub const PRUNE_FAILED_WINDOWS: u32 = 3;
pub const PRUNE_AFTER_SECS: u64 = 7 * 24 * 3600;

/// A card dated further ahead than this is refused: `issued_at` is chosen by
/// the remote signer and decides newest-wins ordering and retention, so an
/// absurd future date would outrank every later rotation and never age out.
pub const MAX_CARD_FUTURE_SKEW_SECS: u64 = 2 * 3600;

const CTX_KX_CARD: &str = "ssf-chia-kx-card-v1";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // only the publisher derives era keys
const CTX_KX_ERA: &str = "ssf-chia-kx-era-v1";
const CARD_SIGN_PREFIX: &str = "ssf-contact-card:v1\n";

/// Write a secret file readable by its owner only (0600 on Unix; elsewhere the
/// platform's default, as `iroh_node_id.key` already does), atomically: the
/// bytes go to a fresh 0600 temporary beside the destination, are synced, the
/// temporary is renamed over the destination and the directory is synced too
/// (on Unix), so the new name survives a power loss. A crash or short write thus
/// leaves the previous file intact — a half-written `contact.key` would
/// otherwise be read as damaged at the next start and silently replaced, making
/// every card handed out stale — and a destination left broader by an earlier
/// tool or run is replaced by the fresh 0600 file.
pub fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => Path::new(".").to_path_buf(),
    };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".to_string());
    let tmp = dir.join(format!(
        ".{name}.{}-{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let written = (|| -> std::io::Result<()> {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)?;
        // The rename is directory metadata: until the directory is synced, a
        // power loss can still lose the new name (a freshly minted
        // `contact.key` would then rotate the identity at the next start).
        // Windows has no directory handle to sync; NTFS journals the rename.
        #[cfg(unix)]
        std::fs::File::open(&dir)?.sync_all()?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

/// Reset an EXISTING secret file to 0600 without rewriting it (Unix; a no-op
/// elsewhere). The contact key is written once and then only read, so a copy
/// left broader than 0600 would otherwise stay readable for the life of the
/// node — `write_private` never gets a chance to tighten it.
pub fn tighten_private(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Load the contact key, or mint one. A file of the wrong size is replaced
/// (and said so): a half-written key would otherwise make every card we hand
/// out point at a hint we never publish under. A loaded key's file is
/// tightened to 0600 on the way, like every file this module writes.
pub fn load_or_create_contact_key(path: &Path) -> Result<[u8; 32]> {
    if path.exists() {
        let bytes = std::fs::read(path)?;
        if let Ok(arr) = <[u8; 32]>::try_from(bytes.as_slice()) {
            tighten_private(path)?;
            return Ok(arr);
        }
        eprintln!("⛓️ contact key: {} is not 32 bytes — minting a new one", path.display());
    }
    let mut ck = [0u8; 32];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut ck);
    write_private(path, &ck)?;
    Ok(ck)
}

/// The long-term X25519 secret a contact card advertises.
pub fn kx_card_secret(iroh_sk: &iroh::SecretKey) -> [u8; 32] {
    blake3::derive_key(CTX_KX_CARD, &iroh_sk.to_bytes())
}

/// The X25519 secret for one era (the presence record's `kx_pk`).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn kx_era_secret(iroh_sk: &iroh::SecretKey, era: u64) -> [u8; 32] {
    let mut material = [0u8; 40];
    material[..32].copy_from_slice(&iroh_sk.to_bytes());
    material[32..].copy_from_slice(&era.to_le_bytes());
    blake3::derive_key(CTX_KX_ERA, &material)
}

/// X25519 public key of a 32-byte secret (RFC 7748 base-point multiplication
/// with clamping, the same operation `x25519()` performs).
pub fn kx_public(secret: &[u8; 32]) -> [u8; 32] {
    curve25519_dalek::MontgomeryPoint::mul_base_clamped(*secret).to_bytes()
}

/// The node-signed contact card, as it rides the `contact` control frame
/// (camelCase so the browser can carry the same shape in P6b).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ContactCard {
    #[serde(rename = "nodeId")]
    pub node_id: String,
    /// The contact key, base64 (standard).
    pub ck: String,
    /// The long-term card X25519 key, hex.
    #[serde(rename = "kxPk")]
    pub kx_pk: String,
    #[serde(rename = "issuedAt")]
    pub issued_at: u64,
    /// Ed25519 signature by `node_id` over [`card_sign_bytes`], hex.
    pub sig: String,
}

/// A card whose signature verified, in decoded form.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCard {
    pub node_id: iroh::PublicKey,
    pub ck: [u8; 32],
    pub kx_pk: [u8; 32],
    pub issued_at: u64,
}

fn ck_b64(ck: &[u8; 32]) -> String {
    base64::Engine::encode(&base64::prelude::BASE64_STANDARD, ck)
}

/// blake3 over a domain prefix and the card's fields, newline-separated.
fn card_sign_bytes(node_id: &str, ck: &str, kx_pk: &str, issued_at: u64) -> [u8; 32] {
    let text = format!("{CARD_SIGN_PREFIX}{node_id}\n{ck}\n{kx_pk}\n{issued_at}");
    *blake3::hash(text.as_bytes()).as_bytes()
}

/// Our own card, signed now.
pub fn make_card(iroh_sk: &iroh::SecretKey, ck: &[u8; 32], issued_at: u64) -> ContactCard {
    let node_id = iroh_sk.public().to_string();
    let ck_s = ck_b64(ck);
    let kx_s = hex::encode(kx_public(&kx_card_secret(iroh_sk)));
    let sig = iroh_sk.sign(&card_sign_bytes(&node_id, &ck_s, &kx_s, issued_at));
    ContactCard { node_id, ck: ck_s, kx_pk: kx_s, issued_at, sig: hex::encode(sig.to_bytes()) }
}

/// Verify a card: well-formed fields, a valid signature by its own node id,
/// and an `issued_at` no further than [`MAX_CARD_FUTURE_SKEW_SECS`] ahead of
/// `now` (the receiver's clock).
pub fn verify_card(card: &ContactCard, now: u64) -> Result<VerifiedCard> {
    if card.issued_at > now.saturating_add(MAX_CARD_FUTURE_SKEW_SECS) {
        return Err(anyhow!("card issued_at is more than {MAX_CARD_FUTURE_SKEW_SECS}s in the future"));
    }
    let node_id: iroh::PublicKey =
        card.node_id.parse().map_err(|e| anyhow!("card node_id is not an iroh key: {e:?}"))?;
    let ck: [u8; 32] = base64::Engine::decode(&base64::prelude::BASE64_STANDARD, &card.ck)?
        .try_into()
        .map_err(|_| anyhow!("card ck is not 32 bytes"))?;
    let kx_pk: [u8; 32] = hex::decode(&card.kx_pk)?.try_into().map_err(|_| anyhow!("card kx_pk is not 32 bytes"))?;
    let sig_bytes: [u8; 64] = hex::decode(&card.sig)?.try_into().map_err(|_| anyhow!("card sig is not 64 bytes"))?;
    node_id
        .verify(&card_sign_bytes(&card.node_id, &card.ck, &card.kx_pk, card.issued_at), &iroh::Signature::from_bytes(&sig_bytes))
        .map_err(|e| anyhow!("card signature invalid: {e:?}"))?;
    Ok(VerifiedCard { node_id, ck, kx_pk, issued_at: card.issued_at })
}

/// May this node hand its card to the members of private rooms? Default yes.
pub fn share_card_enabled() -> bool {
    std::env::var("SSF_CHIA_SHARE_CARD").ok().as_deref() != Some("0")
}

/// Peers the address book holds at most. A private-room member can hand us one
/// card per node identity it mints, and a key under which nothing is ever
/// published fails no hold, so pruning alone never forgets it; past this many,
/// the peer least recently in contact (a hold success, a card over a live
/// connection, or failing both its card's own date) makes room for a newcomer.
pub const MAX_PEERS: usize = 512;
/// Rooms remembered per peer. A connection names its own room, so one peer
/// could otherwise grow its entry (and `peers.json`) without bound by
/// reconnecting under ever new room ids; past the cap a new room is not
/// recorded, and holds for the peer stay bound to the rooms already known.
pub const MAX_ROOMS_PER_PEER: usize = 32;

/// One peer in the address book.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct PeerEntry {
    /// The peer's contact key, base64; absent until its card arrived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ck: Option<String>,
    /// The peer's card X25519 key, hex.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kx_pk: Option<String>,
    /// `issued_at` of the card held; an older card never replaces a newer one.
    #[serde(default)]
    pub card_issued_at: u64,
    /// Rooms this peer was met in (where a hold for it may be bound), at most
    /// [`MAX_ROOMS_PER_PEER`].
    #[serde(default)]
    pub rooms: BTreeSet<String>,
    /// Unix seconds of the last successful link to this peer, and of the last
    /// failed hold window; failures in a row since the last success.
    #[serde(default)]
    pub last_ok: u64,
    #[serde(default)]
    pub last_fail: u64,
    #[serde(default)]
    pub fail_count: u32,
}

/// `peers.json`: node id (hex) -> entry.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct PeerBook {
    #[serde(default)]
    pub peers: BTreeMap<String, PeerEntry>,
}

impl PeerBook {
    /// Load the book; a missing file is an empty book, an unreadable one is
    /// logged and starts empty (fail open: it only slows re-introduction).
    pub fn load(path: &Path) -> PeerBook {
        match std::fs::read(path) {
            Ok(bytes) => {
                // The book holds other nodes' contact keys: a file left broader
                // than 0600 is tightened on load, like `contact.key`, since a
                // quiet node may not save it again for a long time.
                if let Err(e) = tighten_private(path) {
                    eprintln!("⛓️ peers: could not tighten {}: {e}", path.display());
                }
                match serde_json::from_slice(&bytes) {
                    Ok(book) => book,
                    Err(e) => {
                        eprintln!("⛓️ peers: {} is unreadable ({e}) — starting with an empty address book", path.display());
                        PeerBook::default()
                    }
                }
            }
            Err(_) => PeerBook::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        write_private(path, &bytes)
    }

    /// Record a verified card met in `room`. Returns true when the book changed
    /// (a new peer, a newer card, or a new room for a known peer).
    pub fn record_card(&mut self, card: &VerifiedCard, room: &str) -> bool {
        let node = card.node_id.to_string();
        if !self.peers.contains_key(&node) && self.peers.len() >= MAX_PEERS {
            // Full: the peer least recently in contact goes (ties by node id,
            // so the choice is the same on every node).
            let evict = self
                .peers
                .iter()
                .min_by_key(|(id, e)| (e.last_ok.max(e.card_issued_at), (*id).clone()))
                .map(|(id, _)| id.clone());
            if let Some(id) = evict {
                self.peers.remove(&id);
            }
        }
        let entry = self.peers.entry(node).or_default();
        let room_known = entry.rooms.contains(room);
        let mut changed = !room_known && entry.rooms.len() < MAX_ROOMS_PER_PEER && entry.rooms.insert(room.to_string());
        if card.issued_at >= entry.card_issued_at {
            let ck = ck_b64(&card.ck);
            let kx = hex::encode(card.kx_pk);
            if entry.ck.as_deref() != Some(ck.as_str())
                || entry.kx_pk.as_deref() != Some(kx.as_str())
                || entry.card_issued_at != card.issued_at
            {
                entry.ck = Some(ck);
                entry.kx_pk = Some(kx);
                entry.card_issued_at = card.issued_at;
                changed = true;
            }
        }
        changed
    }

    /// #231 P6b: a knock from `node_id` carried its contact key, signed by the
    /// knocker itself: filed under `room` so its presence is read by key and
    /// the dial-back has addresses. A card already held keeps its own key (the
    /// card also names the kx key; a knock does not), so the knock's key lands
    /// only where no card has. Returns true when the book changed.
    pub fn record_knock(&mut self, node_id: &str, ck: &[u8; 32], room: &str) -> bool {
        if !self.peers.contains_key(node_id) && self.peers.len() >= MAX_PEERS {
            let evict = self
                .peers
                .iter()
                .min_by_key(|(id, e)| (e.last_ok.max(e.card_issued_at), (*id).clone()))
                .map(|(id, _)| id.clone());
            if let Some(id) = evict {
                self.peers.remove(&id);
            }
        }
        let entry = self.peers.entry(node_id.to_string()).or_default();
        let mut changed = !entry.rooms.contains(room) && entry.rooms.len() < MAX_ROOMS_PER_PEER && entry.rooms.insert(room.to_string());
        if entry.card_issued_at == 0 {
            let ck_s = ck_b64(ck);
            if entry.ck.as_deref() != Some(ck_s.as_str()) {
                entry.ck = Some(ck_s);
                changed = true;
            }
        }
        changed
    }

    /// The contact key held for a node id, if any.
    pub fn ck_of(&self, node_id: &str) -> Option<[u8; 32]> {
        let ck = self.peers.get(node_id)?.ck.as_deref()?;
        base64::Engine::decode(&base64::prelude::BASE64_STANDARD, ck).ok()?.try_into().ok()
    }

    /// #231 P6b: the contact key AND the card key held for a node id — what a
    /// knock to it needs (the hint by the first, the seal to the second).
    pub fn card_keys_of(&self, node_id: &str) -> Option<([u8; 32], [u8; 32])> {
        let entry = self.peers.get(node_id)?;
        let ck = self.ck_of(node_id)?;
        let kx: [u8; 32] = hex::decode(entry.kx_pk.as_deref()?).ok()?.try_into().ok()?;
        Some((ck, kx))
    }

    /// Every peer with a contact key: (node id, ck, rooms met in).
    pub fn with_ck(&self) -> Vec<(String, [u8; 32], BTreeSet<String>)> {
        self.peers
            .keys()
            .filter_map(|node| self.ck_of(node).map(|ck| (node.clone(), ck, self.peers[node].rooms.clone())))
            .collect()
    }

    pub fn note_ok(&mut self, node_id: &str, now: u64) {
        if let Some(e) = self.peers.get_mut(node_id) {
            e.last_ok = now;
            e.fail_count = 0;
        }
    }

    pub fn note_fail(&mut self, node_id: &str, now: u64) {
        if let Some(e) = self.peers.get_mut(node_id) {
            e.last_fail = now;
            e.fail_count = e.fail_count.saturating_add(1);
        }
    }

    /// Forget peers that failed [`PRUNE_FAILED_WINDOWS`] holds in a row with no
    /// success (and no fresh card) for [`PRUNE_AFTER_SECS`]. Returns how many.
    pub fn prune(&mut self, now: u64) -> usize {
        let before = self.peers.len();
        self.peers.retain(|_, e| {
            let newest = e.last_ok.max(e.card_issued_at);
            !(e.fail_count >= PRUNE_FAILED_WINDOWS && now.saturating_sub(newest) >= PRUNE_AFTER_SECS)
        });
        before - self.peers.len()
    }
}

/// When an unsolicited direct inbound connection was last accepted on one
/// address family: the chain peak known at the time (0 = unknown) and the
/// clock.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct InboundSeen {
    pub height: u32,
    pub unix: u64,
}

/// The measured half of the reachability flags: nothing here is set by
/// configuration, only by `run_iroh_listener` accepting a connection whose
/// Initial arrived DIRECTLY (not via a relay) from a public address we were
/// not dialing, nor had dialed within the pinhole grace (`DIAL_PINHOLE_GRACE`
/// in main.rs: the NAT mapping a dial opens outlives its task), with the
/// sender's address validated.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InboundVerified {
    pub v4: Option<InboundSeen>,
    pub v6: Option<InboundSeen>,
}

impl InboundVerified {
    /// Record an accepted unsolicited inbound on a family. Returns true when
    /// this is the first such mark of the current era (worth a log line and,
    /// through the publisher's address signature, a republish).
    pub fn note(&mut self, ipv6: bool, height: u32, unix: u64) -> bool {
        let slot = if ipv6 { &mut self.v6 } else { &mut self.v4 };
        let was_fresh = slot.is_some_and(|s| Self::fresh(&s, height, unix));
        *slot = Some(InboundSeen { height, unix });
        !was_fresh
    }

    /// Is a mark still "this era"? By era when the peak was known at both ends,
    /// else by elapsed time against the era's length.
    fn fresh(seen: &InboundSeen, now_height: u32, now_unix: u64) -> bool {
        if seen.height != 0 && now_height != 0 {
            era_of(seen.height) == era_of(now_height)
        } else {
            now_unix.saturating_sub(seen.unix) < ERA_SECS
        }
    }

    /// The flags byte for an address of this family right now.
    pub fn flags_for(&self, ipv6: bool, now_height: u32, now_unix: u64) -> u8 {
        let slot = if ipv6 { &self.v6 } else { &self.v4 };
        if slot.is_some_and(|s| Self::fresh(&s, now_height, now_unix)) {
            FLAG_INBOUND_VERIFIED
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chia_lane::ERA_BLOCKS;

    #[test]
    fn contact_key_is_minted_once_and_reloaded() {
        let dir = std::env::temp_dir().join(format!("ssf-ck-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CONTACT_KEY_FILE);
        let a = load_or_create_contact_key(&path).unwrap();
        let b = load_or_create_contact_key(&path).unwrap();
        assert_eq!(a, b, "the same key comes back");
        assert_ne!(a, [0u8; 32]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            // A valid key file left broader (copied in, or an older run) is
            // tightened when it is LOADED, since it is never rewritten.
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            let loaded = load_or_create_contact_key(&path).unwrap();
            assert_eq!(loaded, a, "the broader file still holds the same key");
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600,
                "loading an existing, broader key file tightens it to 0600"
            );
        }
        std::fs::write(&path, b"short").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let c = load_or_create_contact_key(&path).unwrap();
        assert_ne!(c, a, "a damaged file is replaced by a fresh key");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600,
                "rewriting an existing, broader file tightens it to 0600"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_private_replaces_the_file_whole_and_leaves_no_temporary() {
        let dir = std::env::temp_dir().join(format!("ssf-wp-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("state.json");
        write_private(&path, b"first").unwrap();
        write_private(&path, b"second, longer").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"second, longer");
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n != "state.json")
            .collect();
        assert!(leftovers.is_empty(), "no temporary survives a write: {leftovers:?}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn peer_book_file_is_tightened_on_load() {
        let dir = std::env::temp_dir().join(format!("ssf-pb-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PEERS_FILE);
        std::fs::write(&path, serde_json::to_vec(&PeerBook::default()).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        assert_eq!(PeerBook::load(&path), PeerBook::default());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600,
                "loading an existing, broader address book tightens it to 0600"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn kx_keys_are_per_era_and_never_the_identity_key() {
        let sk = iroh::SecretKey::generate();
        let card = kx_public(&kx_card_secret(&sk));
        let e1 = kx_public(&kx_era_secret(&sk, 1));
        let e2 = kx_public(&kx_era_secret(&sk, 2));
        assert_ne!(card, e1);
        assert_ne!(e1, e2);
        assert_eq!(e1, kx_public(&kx_era_secret(&sk, 1)), "deterministic: no file needed");
        assert_ne!(card, *sk.public().as_bytes());
        assert_ne!(kx_card_secret(&sk), sk.to_bytes());
        // RFC 7748 test vector: the public key of the all-zero-but-one scalar
        // is the base point's multiple, never the base point itself.
        let base = kx_public(&[9u8; 32]);
        assert_ne!(base, [9u8; 32]);
    }

    #[test]
    fn contact_card_signs_and_verifies_and_rejects_tampering() {
        let sk = iroh::SecretKey::generate();
        let ck = [3u8; 32];
        let now = 1_791_700_000u64;
        let card = make_card(&sk, &ck, now);
        let v = verify_card(&card, now).unwrap();
        assert_eq!(v.node_id, sk.public());
        assert_eq!(v.ck, ck);
        assert_eq!(v.kx_pk, kx_public(&kx_card_secret(&sk)));
        assert_eq!(v.issued_at, 1_791_700_000);
        let mut other_ck = card.clone();
        other_ck.ck = ck_b64(&[4u8; 32]);
        assert!(verify_card(&other_ck, now).is_err(), "a swapped contact key fails the signature");
        let mut other_node = card.clone();
        other_node.node_id = iroh::SecretKey::generate().public().to_string();
        assert!(verify_card(&other_node, now).is_err(), "a card re-attributed to another node fails");
        let mut later = card.clone();
        later.issued_at += 1;
        assert!(verify_card(&later, now).is_err());
        // A validly signed card from the far future is refused: its date would
        // outrank every later rotation and never age out of the book.
        let far = make_card(&sk, &ck, now + MAX_CARD_FUTURE_SKEW_SECS + 1);
        assert!(verify_card(&far, now).is_err(), "two hours ahead is too far");
        assert!(verify_card(&make_card(&sk, &ck, now + MAX_CARD_FUTURE_SKEW_SECS), now).is_ok(), "the bound itself passes");
        assert!(verify_card(&make_card(&sk, &ck, u64::MAX), now).is_err(), "u64::MAX never gets in");
        let json = serde_json::to_vec(&card).unwrap();
        assert!(String::from_utf8_lossy(&json).contains("\"nodeId\""), "camelCase on the wire");
        let back: ContactCard = serde_json::from_slice(&json).unwrap();
        assert_eq!(back, card);
    }

    #[test]
    fn peer_book_records_cards_newest_wins_and_prunes_dead_peers() {
        let sk = iroh::SecretKey::generate();
        let node = sk.public().to_string();
        let now = 1_791_700_000u64;
        let mut book = PeerBook::default();
        let v1 = verify_card(&make_card(&sk, &[1u8; 32], now - 100), now).unwrap();
        assert!(book.record_card(&v1, "room-a"));
        assert!(!book.record_card(&v1, "room-a"), "the same card again changes nothing");
        assert!(book.record_card(&v1, "room-b"), "a new room is a change");
        assert_eq!(book.ck_of(&node), Some([1u8; 32]));
        let older = verify_card(&make_card(&sk, &[2u8; 32], now - 150), now).unwrap();
        assert!(!book.record_card(&older, "room-a"), "an older card never replaces the held one");
        assert_eq!(book.ck_of(&node), Some([1u8; 32]));
        let newer = verify_card(&make_card(&sk, &[2u8; 32], now), now).unwrap();
        assert!(book.record_card(&newer, "room-a"));
        assert_eq!(book.ck_of(&node), Some([2u8; 32]));
        assert_eq!(book.with_ck().len(), 1);
        assert_eq!(book.with_ck()[0].2.len(), 2, "both rooms remembered");
        assert_eq!(book.ck_of("nobody"), None);

        // Outcomes and pruning.
        book.note_fail(&node, now);
        book.note_fail(&node, now + 1);
        book.note_fail(&node, now + 2);
        assert_eq!(book.peers[&node].fail_count, 3);
        assert_eq!(book.prune(now + 3), 0, "three failures but the card is fresh: kept");
        assert_eq!(book.prune(now + PRUNE_AFTER_SECS + 200), 1, "a week with no success and no new card: gone");
        assert!(book.peers.is_empty());
        book.record_card(&newer, "room-a");
        book.note_fail(&node, now);
        book.note_ok(&node, now + 10);
        assert_eq!(book.peers[&node].fail_count, 0, "a success resets the count");
        book.note_fail(&node, now + 20);
        book.note_fail(&node, now + 30);
        book.note_fail(&node, now + 40);
        assert_eq!(book.prune(now + 50 + PRUNE_AFTER_SECS), 1, "last_ok a week ago, three failures since: gone");
    }

    #[test]
    fn peer_book_is_bounded_and_forgets_the_least_recent_contact_first() {
        let now = 1_791_700_000u64;
        let mut book = PeerBook::default();
        let mut first = String::new();
        for i in 0..MAX_PEERS {
            let sk = iroh::SecretKey::generate();
            let card = verify_card(&make_card(&sk, &[7u8; 32], now - 10_000 + i as u64), now).unwrap();
            assert!(book.record_card(&card, "r"));
            if i == 0 {
                first = sk.public().to_string();
            }
        }
        assert_eq!(book.peers.len(), MAX_PEERS);
        // A hold success is contact: the oldest card is no longer the least recent.
        book.note_ok(&first, now);
        let sk = iroh::SecretKey::generate();
        let newcomer = verify_card(&make_card(&sk, &[8u8; 32], now), now).unwrap();
        assert!(book.record_card(&newcomer, "r"));
        assert_eq!(book.peers.len(), MAX_PEERS, "the book stays at its cap");
        assert!(book.peers.contains_key(&first), "the peer heard from most recently is kept");
        assert!(book.peers.contains_key(&sk.public().to_string()), "the newcomer is in");
    }

    #[test]
    fn rooms_per_peer_are_bounded() {
        let now = 1_791_700_000u64;
        let mut book = PeerBook::default();
        let sk = iroh::SecretKey::generate();
        let card = verify_card(&make_card(&sk, &[7u8; 32], now), now).unwrap();
        for i in 0..MAX_ROOMS_PER_PEER {
            assert!(book.record_card(&card, &format!("room-{i}")), "a new room is recorded");
        }
        let node = sk.public().to_string();
        assert_eq!(book.peers[&node].rooms.len(), MAX_ROOMS_PER_PEER);
        assert!(!book.record_card(&card, "room-overflow"), "past the cap a new room changes nothing");
        assert!(!book.record_card(&card, "room-0"), "a room already known changes nothing either");
        let rooms = &book.peers[&node].rooms;
        assert_eq!(rooms.len(), MAX_ROOMS_PER_PEER, "the set stays at its cap");
        assert!(rooms.contains("room-0") && !rooms.contains("room-overflow"));
    }

    #[test]
    fn a_knock_files_the_knocker_key_only_where_no_card_has() {
        let mut book = PeerBook::default();
        assert!(book.record_knock("j", &[5u8; 32], "r"));
        assert_eq!(book.ck_of("j"), Some([5u8; 32]));
        assert!(book.peers["j"].kx_pk.is_none(), "a knock names no card key");
        assert!(book.peers["j"].rooms.contains("r"));
        assert!(!book.record_knock("j", &[5u8; 32], "r"), "nothing new");
        assert!(book.record_knock("j", &[6u8; 32], "s"), "a new key or a new room changes the book");
        assert_eq!(book.ck_of("j"), Some([6u8; 32]), "no card yet: the knock's key stands");
        let sk = iroh::SecretKey::generate();
        let card = verify_card(&make_card(&sk, &[7u8; 32], 100), 100).unwrap();
        let node = sk.public().to_string();
        book.record_card(&card, "r");
        assert!(!book.record_knock(&node, &[8u8; 32], "r"), "a card already held keeps its key");
        assert_eq!(book.ck_of(&node), Some([7u8; 32]));
        assert_eq!(book.with_ck().len(), 2, "both are read by key");
        assert_eq!(book.card_keys_of(&node), Some(([7u8; 32], card.kx_pk)), "a card gives both keys a knock needs");
        assert_eq!(book.card_keys_of("j"), None, "a knock's key alone cannot be knocked back to");
    }

    #[test]
    fn peer_book_roundtrips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("ssf-peers-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(PEERS_FILE);
        assert_eq!(PeerBook::load(&path), PeerBook::default(), "no file: empty book");
        let sk = iroh::SecretKey::generate();
        let mut book = PeerBook::default();
        book.record_card(&verify_card(&make_card(&sk, &[7u8; 32], 5), 5).unwrap(), "r");
        book.save(&path).unwrap();
        assert_eq!(PeerBook::load(&path), book);
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(PeerBook::load(&path), PeerBook::default(), "a damaged file starts empty, never panics");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn inbound_verified_is_per_family_and_per_era() {
        let mut iv = InboundVerified::default();
        let h = 10 * ERA_BLOCKS + 100;
        let t = 1_791_700_000u64;
        assert_eq!(iv.flags_for(false, h, t), 0);
        assert!(iv.note(false, h, t), "first mark of the era");
        assert!(!iv.note(false, h + 5, t + 60), "a second inbound in the same era is not news");
        assert_eq!(iv.flags_for(false, h + 5, t), FLAG_INBOUND_VERIFIED);
        assert_eq!(iv.flags_for(true, h + 5, t), 0, "IPv6 was never verified");
        assert_eq!(iv.flags_for(false, 11 * ERA_BLOCKS, t), 0, "the next era starts unverified");
        assert!(iv.note(false, 11 * ERA_BLOCKS, t + 1), "…so a mark there is news again");
        // Peak unknown on either side: the clock decides, against the era length.
        let mut by_time = InboundVerified::default();
        by_time.note(true, 0, t);
        assert_eq!(by_time.flags_for(true, 0, t + ERA_SECS - 1), FLAG_INBOUND_VERIFIED);
        assert_eq!(by_time.flags_for(true, 0, t + ERA_SECS), 0);
        assert_eq!(by_time.flags_for(true, h, t + 10), FLAG_INBOUND_VERIFIED, "a mark without a height still counts by time");
    }
}
