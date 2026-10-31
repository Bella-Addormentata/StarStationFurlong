//! 📌 Sealed board bundles (#315, its second PR): a room's board notes,
//! sealed with the room's key, that ANY connected node carries and passes on,
//! while only nodes holding the room's pass can read them (Dorkmo 2026-10-31:
//! "spread the messages to anyone that is connected to a peer", sealed).
//!
//! Why: a note lives in the room's own doc, so it reaches the owner only when
//! the poster's copy of the room and the owner's meet. With bundles, the
//! poster's node seals the room's notes and hands them to whoever it is
//! connected to, in any room; they hand them on, and the owner's node picks
//! them up even if the poster and the owner are never online together.
//!
//! What a carrier sees: a 32-byte tag, a publish stamp and sealed bytes. The
//! tag is `chia_lane::derive_hint` over a board-only derivation of the room
//! key and the UTC day, so it changes daily and names no room; the seal is
//! `chia_lane::seal` (XChaCha20-Poly1305) under the same derivation, so a
//! board bundle can never be confused with a presence record sealed under the
//! room key itself. Both are the shipped ChiaHub primitives, reused.
//!
//! What a reader sees (a node with the room's key, from the browser's `cap`
//! lane): the room id, the publishing node, the stamp, the signed notes and
//! the signed take-downs (`boardDown`) as the room's doc held them. The node
//! never trusts either: it hands them to its own browser tab (local lane
//! `board`), which checks every signature and binding exactly as it checks
//! the doc's (boardDoc.ts) and merges only what is new and was never deleted
//! in its copy. Take-downs travel too, so a note its author or the owner
//! took down is not brought back by a bundle sealed before they did.
//!
//! Who publishes: every node that serves a room (it has the room's doc) and
//! holds its key, from its OWN copy of the doc, so the owner's machine keeps
//! publishing with the browser closed. A new bundle goes out when the notes
//! change, when the day (and so the tag) changes, and every six hours.
//!
//! Who carries: any node, for any room, keyed by nothing but the tag. Any
//! peer it is connected to, in any room, hears what it holds (`bb-have`),
//! asks for what it lacks (`bb-want`) and gets it (`bb`). All three are
//! node-signed control envelopes taken only from the connection's own peer,
//! so a relayed copy is dropped, never answered.
//!
//! Limits, all here: a bundle is at most 256 KB sealed, 128 notes and 256
//! take-downs (the oldest are left out until it fits); a
//! carrier keeps at most 8 bundles a tag (the newest), 512 bundles and 24 MB
//! in all, for 14 days, preferring to drop bundles of tags it can't read; a
//! peer may hand it 64 bundles every ten minutes and be served 64. A tag of
//! a room this node can read only takes bundles that open under the room's
//! key.
//!
//! Known limit: a carrier can't tell real bundles from junk, so someone who
//! floods one tag with junk can make carriers drop that tag's real bundles
//! (8 a tag). The room's own members' nodes check and keep the real ones, and
//! the doc itself still syncs as before; bundles only add a path.
#![cfg(feature = "chia-read")]

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::chia_lane;

/// Domain separation from every other use of a room key.
pub const CTX_BOARD: &str = "ssf-board-bundle-v1";
/// The carrier store's directory, beside `rooms/` and `blob-cache/`.
pub const BUNDLES_DIR: &str = "board-bundles";
pub const DAY: u64 = 86_400;
/// How long a carrier keeps a bundle after its stamp.
pub const TTL_SECS: u64 = 14 * DAY;
/// Days of tags a reader asks for (the TTL's worth).
pub const READ_EPOCHS: u64 = 14;
/// A stamp may run this far ahead of our clock.
pub const FUTURE_SKEW_SECS: u64 = 600;
/// Sealed bytes, at most (128 of the longest notes and 256 take-downs fit).
pub const MAX_SEALED: usize = 256 * 1024;
/// Notes a bundle carries, at most (the newest by stamp).
pub const MAX_NOTES: usize = 128;
/// Take-downs a bundle carries, at most (the newest by stamp).
pub const MAX_DOWN: usize = 256;
/// Keys of the doc's `boardNotes` map a publisher looks at (the map is
/// anyone's to pad).
pub const MAX_KEYS_SCANNED: usize = 1024;
/// Bundles a carrier keeps under one tag (the newest).
pub const PER_TAG: usize = 8;
pub const MAX_BUNDLES: usize = 512;
pub const MAX_BYTES: usize = 24 * 1024 * 1024;
/// Digests one advert names, at most.
pub const ADVERT_MAX: usize = 64;
/// Digests one want asks for, at most.
pub const WANT_MAX: usize = 32;
/// Bundles served for one want, at most.
pub const SERVE_MAX: usize = 16;
/// A publisher refreshes its bundle at least this often.
pub const REPUBLISH_SECS: u64 = 6 * 3600;
/// Bundles one peer may hand us per window, and we serve it per window.
pub const PEER_ADMIT_PER_WINDOW: u32 = 64;
pub const PEER_SERVE_PER_WINDOW: u32 = 64;
pub const PEER_WINDOW_SECS: u64 = 600;
/// Notes (and take-downs) a merged view hands the tab, at most.
pub const MAX_VIEW_NOTES: usize = 512;
pub const MAX_VIEW_DOWN: usize = 1024;
/// The loop's pace when nothing nudges it.
pub const TICK_SECS: u64 = 60;
/// Peers whose adverts we remember (what we told them), at most.
const MAX_TOLD_PER_PEER: usize = 4096;

pub type Digest = [u8; 32];
pub type Tag = [u8; 32];

/// The board-only key material derived from a room key.
pub fn board_material(room_key: &[u8]) -> [u8; 32] {
    blake3::derive_key(CTX_BOARD, room_key)
}

/// A room's board tag for a UTC day.
pub fn board_tag(room_key: &[u8], epoch: u64) -> Tag {
    chia_lane::derive_hint(&board_material(room_key), epoch)
}

pub fn epoch_of(at: u64) -> u64 {
    at / DAY
}

/// The tags a reader asks for: this day and the TTL's worth before it.
pub fn read_tags(room_key: &[u8], now: u64) -> Vec<Tag> {
    let today = epoch_of(now);
    (0..READ_EPOCHS).filter_map(|back| today.checked_sub(back)).map(|e| board_tag(room_key, e)).collect()
}

/// A bundle as carriers hold and pass it on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bundle {
    pub tag: Tag,
    /// The publisher's stamp (unix seconds), also inside the seal.
    pub at: u64,
    pub sealed: Vec<u8>,
}

/// The wire form of a [`Bundle`] (the `bb` control payload and the file a
/// carrier keeps).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WireBundle {
    pub tag: String,
    pub at: u64,
    pub sealed: String,
}

impl Bundle {
    /// Content address: what adverts and wants name.
    pub fn digest(&self) -> Digest {
        let mut h = blake3::Hasher::new();
        h.update(b"ssf-board-bundle-digest-v1");
        h.update(&self.tag);
        h.update(&self.at.to_le_bytes());
        h.update(&self.sealed);
        *h.finalize().as_bytes()
    }

    pub fn size(&self) -> usize {
        self.sealed.len() + 40
    }

    pub fn to_wire(&self) -> WireBundle {
        WireBundle {
            tag: hex::encode(self.tag),
            at: self.at,
            sealed: base64::Engine::encode(&base64::prelude::BASE64_STANDARD, &self.sealed),
        }
    }

    /// The `bb` control payload: `[tag 32][stamp u64 LE][sealed]`, raw (the
    /// envelope base64s its payload once already).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(40 + self.sealed.len());
        out.extend_from_slice(&self.tag);
        out.extend_from_slice(&self.at.to_le_bytes());
        out.extend_from_slice(&self.sealed);
        out
    }

    pub fn from_bytes(bytes: &[u8]) -> Option<Bundle> {
        if bytes.len() < 40 + 24 + 16 + 2 || bytes.len() > 40 + MAX_SEALED {
            return None;
        }
        let tag: Tag = bytes[..32].try_into().ok()?;
        let at = u64::from_le_bytes(bytes[32..40].try_into().ok()?);
        Some(Bundle { tag, at, sealed: bytes[40..].to_vec() })
    }

    /// Shape-checked: a 32-byte tag and sealed bytes of a possible size.
    pub fn from_wire(w: &WireBundle) -> Option<Bundle> {
        let tag: Tag = hex::decode(&w.tag).ok()?.try_into().ok()?;
        // Base64 of MAX_SEALED, rounded up: refuse before decoding a flood.
        if w.sealed.len() > (MAX_SEALED / 3 + 1) * 4 {
            return None;
        }
        let sealed = base64::Engine::decode(&base64::prelude::BASE64_STANDARD, &w.sealed).ok()?;
        // A nonce, a tag and at least a byte of JSON.
        if sealed.len() < 24 + 16 + 2 || sealed.len() > MAX_SEALED {
            return None;
        }
        Some(Bundle { tag, at: w.at, sealed })
    }
}

/// What only the room's pass holders read.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct BoardPlain {
    pub v: u32,
    pub room: String,
    /// The publishing node's id: a reader keeps each publisher's newest only.
    pub publisher: String,
    pub at: u64,
    /// `[key, note]` pairs exactly as the room doc's `boardNotes` held them.
    pub notes: Vec<(String, serde_json::Value)>,
    /// `[key, take-down]` pairs as its `boardDown` held them.
    #[serde(default)]
    pub down: Vec<(String, serde_json::Value)>,
}

/// What a publisher reads out of its doc, and what a reader hands its tab.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
pub struct BoardContent {
    pub notes: Vec<(String, serde_json::Value)>,
    pub down: Vec<(String, serde_json::Value)>,
}

impl BoardContent {
    pub fn is_empty(&self) -> bool {
        self.notes.is_empty() && self.down.is_empty()
    }

    pub fn hash(&self) -> [u8; 32] {
        *blake3::hash(&serde_json::to_vec(self).unwrap_or_default()).as_bytes()
    }
}

pub fn seal_bundle(room_key: &[u8], plain: &BoardPlain) -> Result<Bundle> {
    let bytes = serde_json::to_vec(plain)?;
    let sealed = chia_lane::seal(&board_material(room_key), &bytes)?;
    if sealed.len() > MAX_SEALED {
        return Err(anyhow!("board bundle too large ({} bytes sealed)", sealed.len()));
    }
    Ok(Bundle { tag: board_tag(room_key, epoch_of(plain.at)), at: plain.at, sealed })
}

/// Seal, leaving out the oldest notes and take-downs until the bundle fits
/// (both lists are newest first). None only if not even one entry fits.
pub fn seal_fitting(room_key: &[u8], mut plain: BoardPlain) -> Option<Bundle> {
    loop {
        if let Ok(b) = seal_bundle(room_key, &plain) {
            return Some(b);
        }
        if plain.notes.len() <= 1 && plain.down.len() <= 1 {
            return None;
        }
        plain.notes.truncate(plain.notes.len().div_ceil(2).max(1));
        plain.down.truncate(plain.down.len() / 2);
    }
}

/// Open a bundle as `room_id`'s: the seal must open under the room's key, the
/// plaintext must name the room, and its stamp and day must match the
/// bundle's own (a carrier can't re-stamp or re-file one).
pub fn open_bundle(room_key: &[u8], room_id: &str, b: &Bundle) -> Option<BoardPlain> {
    let bytes = chia_lane::open(&board_material(room_key), &b.sealed).ok()?;
    let plain: BoardPlain = serde_json::from_slice(&bytes).ok()?;
    let ok = plain.v == 1
        && plain.room == room_id
        && plain.at == b.at
        && b.tag == board_tag(room_key, epoch_of(plain.at))
        && plain.notes.len() <= MAX_NOTES
        && plain.down.len() <= MAX_DOWN;
    ok.then_some(plain)
}

/// What a publisher seals: the doc's `boardNotes` and `boardDown` entries
/// that look like records (a `sig` string, a stamp no more than ten minutes
/// ahead), newest first, at most MAX_NOTES and MAX_DOWN. Signatures are the
/// reader's to check.
pub fn board_from_doc(doc: &yrs::Doc, now_ms: u64) -> BoardContent {
    BoardContent {
        notes: signed_entries(doc, "boardNotes", now_ms, MAX_NOTES),
        down: signed_entries(doc, "boardDown", now_ms, MAX_DOWN),
    }
}

fn signed_entries(doc: &yrs::Doc, name: &str, now_ms: u64, cap: usize) -> Vec<(String, serde_json::Value)> {
    use yrs::{Any, Map, Out, ReadTxn, Transact};
    let txn = doc.transact();
    let Some(map) = txn.get_map(name) else { return Vec::new() };
    let mut found: Vec<(u64, String, serde_json::Value)> = Vec::new();
    for (key, value) in map.iter(&txn).take(MAX_KEYS_SCANNED) {
        if key.len() > 200 || !key.contains('|') {
            continue;
        }
        let Out::Any(any) = value else { continue };
        let Any::Map(fields) = &any else { continue };
        if !matches!(fields.get("sig"), Some(Any::String(_))) {
            continue;
        }
        let ts = match fields.get("ts") {
            Some(Any::Number(n)) if n.is_finite() && *n >= 0.0 => *n as u64,
            Some(Any::BigInt(n)) if *n >= 0 => *n as u64,
            _ => continue,
        };
        if ts > now_ms + FUTURE_SKEW_SECS * 1000 {
            continue;
        }
        let Ok(json) = serde_json::to_value(&any) else { continue };
        found.push((ts, key.to_string(), json));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    found.truncate(cap);
    found.into_iter().map(|(_, k, v)| (k, v)).collect()
}

/// A room's board records as its readers' tab should see them: each
/// publisher's newest bundle only (a note gone from it was unpinned or
/// trimmed there), our own node's left out (its records are our doc's
/// already), then the union by key, newest publisher first. A take-down in
/// any publisher's bundle reaches the tab, which drops the note it names.
pub fn merge_view(mut plains: Vec<BoardPlain>, self_id: &str) -> BoardContent {
    plains.retain(|p| p.publisher != self_id);
    plains.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| a.publisher.cmp(&b.publisher)));
    let mut seen_publishers: HashSet<String> = HashSet::new();
    let mut note_keys: HashSet<String> = HashSet::new();
    let mut down_keys: HashSet<String> = HashSet::new();
    let mut out = BoardContent::default();
    for p in plains {
        if !seen_publishers.insert(p.publisher.clone()) {
            continue; // an older bundle of a publisher already taken
        }
        for (k, v) in p.notes {
            if out.notes.len() < MAX_VIEW_NOTES && note_keys.insert(k.clone()) {
                out.notes.push((k, v));
            }
        }
        for (k, v) in p.down {
            if out.down.len() < MAX_VIEW_DOWN && down_keys.insert(k.clone()) {
                out.down.push((k, v));
            }
        }
    }
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum Admit {
    New,
    Known,
    Refused(&'static str),
}

/// What a carrier keeps: bundles by digest, under the TTL and the caps.
pub struct BundleStore {
    items: HashMap<Digest, Bundle>,
    bytes: usize,
    dir: Option<PathBuf>,
}

impl BundleStore {
    pub fn new(dir: Option<PathBuf>) -> Self {
        BundleStore { items: HashMap::new(), bytes: 0, dir }
    }

    /// Load the bundles kept across a restart (files that no longer parse or
    /// have expired are removed).
    pub fn load(dir: &Path, now: u64) -> Self {
        let mut store = BundleStore::new(None);
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let kept = std::fs::read(&path)
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<WireBundle>(&bytes).ok())
                    .and_then(|w| Bundle::from_wire(&w))
                    .filter(|b| path.file_stem().and_then(|s| s.to_str()) == Some(hex::encode(b.digest()).as_str()))
                    .map(|b| store.admit(b, now, &HashSet::new()) == Admit::New)
                    .unwrap_or(false);
                if !kept {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        store.dir = Some(dir.to_path_buf());
        // Files evicted by the caps while loading are gone from the map, not
        // the disk: tidy up.
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                let held = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| hex::decode(s).ok())
                    .and_then(|d| <Digest>::try_from(d).ok())
                    .is_some_and(|d| store.items.contains_key(&d));
                if !held {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        store
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn has(&self, d: &Digest) -> bool {
        self.items.contains_key(d)
    }

    pub fn get(&self, d: &Digest) -> Option<&Bundle> {
        self.items.get(d)
    }

    fn file(&self, d: &Digest) -> Option<PathBuf> {
        self.dir.as_ref().map(|dir| dir.join(format!("{}.json", hex::encode(d))))
    }

    fn remove(&mut self, d: &Digest) {
        if let Some(b) = self.items.remove(d) {
            self.bytes -= b.size();
            if let Some(path) = self.file(d) {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    /// Would a bundle with this tag and stamp be kept? (Not expired, not from
    /// the future, and newer than the oldest of a full tag.)
    fn would_keep(&self, tag: &Tag, at: u64, now: u64) -> Result<(), &'static str> {
        if at > now + FUTURE_SKEW_SECS {
            return Err("stamped in the future");
        }
        if at + TTL_SECS < now {
            return Err("expired");
        }
        let same: Vec<u64> = self.items.values().filter(|b| &b.tag == tag).map(|b| b.at).collect();
        if same.len() >= PER_TAG && same.iter().all(|a| at <= *a) {
            return Err("older than every bundle kept under its tag");
        }
        Ok(())
    }

    /// Keep a bundle, within the caps. `protected` are the tags this node can
    /// read (its rooms'): dropped last when the store is full.
    pub fn admit(&mut self, b: Bundle, now: u64, protected: &HashSet<Tag>) -> Admit {
        if b.sealed.len() > MAX_SEALED {
            return Admit::Refused("too large");
        }
        let digest = b.digest();
        if self.items.contains_key(&digest) {
            return Admit::Known;
        }
        if let Err(why) = self.would_keep(&b.tag, b.at, now) {
            return Admit::Refused(why);
        }
        // A full tag gives up its oldest.
        let same: Vec<(Digest, u64)> =
            self.items.iter().filter(|(_, x)| x.tag == b.tag).map(|(d, x)| (*d, x.at)).collect();
        if same.len() >= PER_TAG {
            if let Some((oldest, _)) = same.iter().min_by_key(|(_, at)| *at) {
                let oldest = *oldest;
                self.remove(&oldest);
            }
        }
        if let Some(path) = self.file(&digest) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(json) = serde_json::to_vec(&b.to_wire()) {
                let _ = std::fs::write(&path, json);
            }
        }
        self.bytes += b.size();
        self.items.insert(digest, b);
        // Over the store's caps: drop the oldest bundle of a tag we can't read,
        // else the oldest of all. If that is the newcomer, it is refused.
        while self.items.len() > MAX_BUNDLES || self.bytes > MAX_BYTES {
            let victim = self
                .items
                .iter()
                .min_by_key(|(_, x)| (protected.contains(&x.tag), x.at))
                .map(|(d, _)| *d);
            let Some(victim) = victim else { break };
            self.remove(&victim);
            if victim == digest {
                return Admit::Refused("store full");
            }
        }
        Admit::New
    }

    /// Drop what has outlived the TTL.
    pub fn expire(&mut self, now: u64) {
        let old: Vec<Digest> =
            self.items.iter().filter(|(_, b)| b.at + TTL_SECS < now).map(|(d, _)| *d).collect();
        for d in old {
            self.remove(&d);
        }
    }

    /// The newest bundles, for an advert.
    pub fn recent(&self, n: usize) -> Vec<(Digest, Tag, u64)> {
        let mut all: Vec<(Digest, Tag, u64)> = self.items.iter().map(|(d, b)| (*d, b.tag, b.at)).collect();
        all.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        all.truncate(n);
        all
    }

    /// Bundles filed under any of these tags.
    pub fn under(&self, tags: &HashSet<Tag>) -> Vec<(Digest, &Bundle)> {
        let mut out: Vec<(Digest, &Bundle)> =
            self.items.iter().filter(|(_, b)| tags.contains(&b.tag)).map(|(d, b)| (*d, b)).collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// Which of an advert's bundles to ask for: ones we lack and would keep,
    /// our own rooms' first, then the newest, at most WANT_MAX.
    pub fn wanted(&self, offered: &[(Digest, Tag, u64)], protected: &HashSet<Tag>, now: u64) -> Vec<Digest> {
        let mut want: Vec<&(Digest, Tag, u64)> = offered
            .iter()
            .filter(|(d, tag, at)| !self.has(d) && self.would_keep(tag, *at, now).is_ok())
            .collect();
        want.sort_by(|a, b| protected.contains(&b.1).cmp(&protected.contains(&a.1)).then_with(|| b.2.cmp(&a.2)));
        let mut seen = HashSet::new();
        want.into_iter().filter(|(d, _, _)| seen.insert(*d)).take(WANT_MAX).map(|(d, _, _)| *d).collect()
    }
}

/// The node's whole board-bundle state: the store, what it published, what
/// it told each peer, each peer's budget, and what each room's tabs last got.
pub struct BoardLane {
    pub store: BundleStore,
    /// Room → (hash of the notes last sealed, the stamp).
    published: HashMap<String, ([u8; 32], u64)>,
    /// Room → fingerprint of the last view handed to its tabs.
    pushed: HashMap<String, [u8; 32]>,
    /// Peer → digests already advertised to (or received from) it.
    told: HashMap<String, HashSet<Digest>>,
    /// Peer → (window start, bundles admitted in it).
    budget: HashMap<String, (u64, u32)>,
    /// Peer → (window start, bundles served to it in it).
    served: HashMap<String, (u64, u32)>,
}

/// One more in a peer's window, if the window has room.
fn spend(window: &mut HashMap<String, (u64, u32)>, peer: &str, now: u64, cap: u32) -> bool {
    let (start, count) = window.entry(peer.to_string()).or_insert((now, 0));
    if now >= *start + PEER_WINDOW_SECS {
        *start = now;
        *count = 0;
    }
    if *count >= cap {
        return false;
    }
    *count += 1;
    true
}

impl BoardLane {
    pub fn new(store: BundleStore) -> Self {
        BoardLane {
            store,
            published: HashMap::new(),
            pushed: HashMap::new(),
            told: HashMap::new(),
            budget: HashMap::new(),
            served: HashMap::new(),
        }
    }

    pub fn load(dir: &Path, now: u64) -> Self {
        BoardLane::new(BundleStore::load(dir, now))
    }

    /// Should this room's bundle go out again? When its records changed, the
    /// day (so the tag) changed, or REPUBLISH_SECS passed. Never for an empty
    /// board that never had a bundle; an emptied one publishes once more, so
    /// readers learn its notes came down.
    pub fn publish_due(&self, room: &str, content: &BoardContent, now: u64) -> bool {
        match self.published.get(room) {
            None => !content.is_empty(),
            Some((hash, at)) => {
                let changed = *hash != content.hash();
                changed || (!content.is_empty() && (epoch_of(*at) != epoch_of(now) || now >= at + REPUBLISH_SECS))
            }
        }
    }

    /// The stamp for a new bundle: now, and always after this publisher's
    /// last one for the room (a reader keeps the newest per publisher).
    pub fn next_stamp(&self, room: &str, now: u64) -> u64 {
        match self.published.get(room) {
            Some((_, at)) if *at >= now => at + 1,
            _ => now,
        }
    }

    pub fn note_published(&mut self, room: &str, content: &BoardContent, at: u64) {
        self.published.insert(room.to_string(), (content.hash(), at));
    }

    /// A bundle handed to us by a peer: within its budget, then the store.
    pub fn admit_from_peer(&mut self, peer: &str, b: Bundle, now: u64, protected: &HashSet<Tag>) -> Admit {
        if !spend(&mut self.budget, peer, now, PEER_ADMIT_PER_WINDOW) {
            return Admit::Refused("the peer is over its budget");
        }
        let digest = b.digest();
        let verdict = self.store.admit(b, now, protected);
        // The peer has it: never advertise it back.
        self.mark_told(peer, digest);
        verdict
    }

    fn mark_told(&mut self, peer: &str, d: Digest) {
        let told = self.told.entry(peer.to_string()).or_default();
        if told.len() >= MAX_TOLD_PER_PEER {
            told.clear();
        }
        told.insert(d);
    }

    /// A peer said it holds these: never advertise them back to it.
    pub fn note_offered(&mut self, peer: &str, offered: &[(Digest, Tag, u64)]) {
        for (d, _, _) in offered {
            self.mark_told(peer, *d);
        }
    }

    /// The bundles a peer asked for that we hold, within what we serve it a
    /// window (a want is a few bytes; what it asks for is up to 4 MB).
    pub fn serve(&mut self, peer: &str, wanted: &[Digest], now: u64) -> Vec<Bundle> {
        let mut out = Vec::new();
        for d in wanted.iter().take(SERVE_MAX) {
            let Some(b) = self.store.get(d) else { continue };
            if !spend(&mut self.served, peer, now, PEER_SERVE_PER_WINDOW) {
                break;
            }
            out.push(b.clone());
        }
        out
    }

    /// The bundles to advertise to a peer: the newest it hasn't heard of.
    pub fn advert_for(&mut self, peer: &str) -> Vec<(Digest, Tag, u64)> {
        let recent = self.store.recent(ADVERT_MAX);
        let told = self.told.entry(peer.to_string()).or_default();
        let fresh: Vec<(Digest, Tag, u64)> = recent.into_iter().filter(|(d, _, _)| !told.contains(d)).collect();
        for (d, _, _) in &fresh {
            self.mark_told(peer, *d);
        }
        fresh
    }

    /// Forget the peers no longer connected.
    pub fn retain_peers(&mut self, connected: &HashSet<String>) {
        self.told.retain(|p, _| connected.contains(p));
        self.budget.retain(|p, _| connected.contains(p));
        self.served.retain(|p, _| connected.contains(p));
    }

    /// A room's view for its tabs, when it differs from the last one handed
    /// over (`tabs` fingerprints the tabs, so a new tab gets it too).
    pub fn tab_view(
        &mut self,
        room: &str,
        room_key: &[u8],
        self_id: &str,
        tabs: &[u8],
        now: u64,
    ) -> Option<BoardContent> {
        let tags: HashSet<Tag> = read_tags(room_key, now).into_iter().collect();
        let opened: Vec<(Digest, BoardPlain)> = self
            .store
            .under(&tags)
            .into_iter()
            .filter_map(|(d, b)| open_bundle(room_key, room, b).map(|p| (d, p)))
            .collect();
        let mut fp = blake3::Hasher::new();
        fp.update(tabs);
        for (d, _) in &opened {
            fp.update(d);
        }
        let fp = *fp.finalize().as_bytes();
        if self.pushed.get(room) == Some(&fp) {
            return None;
        }
        self.pushed.insert(room.to_string(), fp);
        let view = merge_view(opened.into_iter().map(|(_, p)| p).collect(), self_id);
        (!view.is_empty()).then_some(view)
    }
}

/// `bb-have`: the bundles a node holds, newest first.
#[derive(Serialize, Deserialize, Default)]
pub struct HavePayload {
    /// `[digest hex, tag hex, stamp]`.
    pub items: Vec<(String, String, u64)>,
}

/// `bb-want`: the digests a node asks for.
#[derive(Serialize, Deserialize, Default)]
pub struct WantPayload {
    pub ids: Vec<String>,
}

pub fn have_payload(items: &[(Digest, Tag, u64)]) -> HavePayload {
    HavePayload { items: items.iter().map(|(d, t, at)| (hex::encode(d), hex::encode(t), *at)).collect() }
}

pub fn parse_have(p: &HavePayload) -> Vec<(Digest, Tag, u64)> {
    p.items
        .iter()
        .take(ADVERT_MAX)
        .filter_map(|(d, t, at)| {
            let d: Digest = hex::decode(d).ok()?.try_into().ok()?;
            let t: Tag = hex::decode(t).ok()?.try_into().ok()?;
            Some((d, t, *at))
        })
        .collect()
}

pub fn parse_want(p: &WantPayload) -> Vec<Digest> {
    p.ids.iter().take(SERVE_MAX).filter_map(|d| hex::decode(d).ok()?.try_into().ok()).collect()
}

/// The lane is on unless `SSF_BOARD_BUNDLES=0` (read once).
pub fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("SSF_BOARD_BUNDLES").ok().as_deref() != Some("0"))
}

/// Wakes the board loop early (a new cap, a new bundle).
pub static NUDGE: std::sync::LazyLock<tokio::sync::Notify> = std::sync::LazyLock::new(tokio::sync::Notify::new);

pub fn nudge() {
    NUDGE.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [7u8; 32];
    const OTHER: [u8; 32] = [9u8; 32];
    const NOW: u64 = 1_800_000_000;

    fn note(ts: u64, text: &str) -> serde_json::Value {
        serde_json::json!({ "v": 1, "author": "A", "authorName": "Ada", "text": text, "colour": "yellow", "x": 0.083, "y": 0.125, "ts": ts as f64, "sig": "s" })
    }

    fn plain(publisher: &str, at: u64, notes: Vec<(&str, serde_json::Value)>) -> BoardPlain {
        BoardPlain {
            v: 1,
            room: "room-a".into(),
            publisher: publisher.into(),
            at,
            notes: notes.into_iter().map(|(k, v)| (k.to_string(), v)).collect(),
            down: Vec::new(),
        }
    }

    fn down(ts: u64) -> serde_json::Value {
        serde_json::json!({ "v": 1, "by": "A", "ts": ts as f64, "sig": "s" })
    }

    fn content(notes: Vec<(&str, serde_json::Value)>) -> BoardContent {
        BoardContent { notes: notes.into_iter().map(|(k, v)| (k.to_string(), v)).collect(), down: Vec::new() }
    }

    fn junk(tag: Tag, at: u64, fill: u8) -> Bundle {
        Bundle { tag, at, sealed: vec![fill; 64] }
    }

    #[test]
    fn tags_are_board_only_and_rotate_daily() {
        let e = epoch_of(NOW);
        assert_ne!(board_tag(&KEY, e), chia_lane::derive_hint(&KEY, e), "a board tag is never a presence hint");
        assert_ne!(board_tag(&KEY, e), board_tag(&KEY, e + 1));
        assert_ne!(board_tag(&KEY, e), board_tag(&OTHER, e));
        assert_eq!(read_tags(&KEY, NOW).len(), READ_EPOCHS as usize);
        assert_eq!(read_tags(&KEY, NOW)[0], board_tag(&KEY, e));
    }

    #[test]
    fn a_bundle_opens_only_as_its_room_under_its_key() {
        let p = plain("node-1", NOW, vec![("cork|abc", note(NOW * 1000, "hi"))]);
        let b = seal_bundle(&KEY, &p).unwrap();
        assert_eq!(b.tag, board_tag(&KEY, epoch_of(NOW)));
        assert_eq!(open_bundle(&KEY, "room-a", &b), Some(p.clone()));
        assert_eq!(open_bundle(&OTHER, "room-a", &b), None, "wrong key");
        assert_eq!(open_bundle(&KEY, "room-b", &b), None, "another room");
        // A presence-record seal under the bare room key doesn't open as a board.
        let presence = Bundle { sealed: chia_lane::seal(&KEY, &serde_json::to_vec(&p).unwrap()).unwrap(), ..b.clone() };
        assert_eq!(open_bundle(&KEY, "room-a", &presence), None);
        // A carrier can't re-stamp or re-file one.
        assert_eq!(open_bundle(&KEY, "room-a", &Bundle { at: NOW + 1, ..b.clone() }), None);
        assert_eq!(open_bundle(&KEY, "room-a", &Bundle { tag: board_tag(&KEY, epoch_of(NOW) - 1), ..b.clone() }), None);
    }

    #[test]
    fn the_wire_form_round_trips_and_refuses_bad_shapes() {
        let b = seal_bundle(&KEY, &plain("n", NOW, vec![("cork|a", note(1, "x"))])).unwrap();
        assert_eq!(Bundle::from_wire(&b.to_wire()), Some(b.clone()));
        let mut w = b.to_wire();
        w.tag = "00".into();
        assert_eq!(Bundle::from_wire(&w), None);
        let mut w = b.to_wire();
        w.sealed = "AAAA".into();
        assert_eq!(Bundle::from_wire(&w), None, "too short to be sealed");
        let mut w = b.to_wire();
        w.sealed = "A".repeat(MAX_SEALED * 2);
        assert_eq!(Bundle::from_wire(&w), None, "too long");
        // The `bb` payload: raw bytes.
        assert_eq!(Bundle::from_bytes(&b.to_bytes()), Some(b.clone()));
        assert_eq!(Bundle::from_bytes(&b.to_bytes()[..60]), None);
        assert_eq!(Bundle::from_bytes(&vec![0u8; 40 + MAX_SEALED + 1]), None);
    }

    #[test]
    fn an_oversized_board_seals_its_newest_records() {
        let long = "✨".repeat(800); // beyond the game's 280, so 128 of them overflow
        let notes: Vec<(String, serde_json::Value)> =
            (0..MAX_NOTES).map(|i| (format!("cork|{i:04}"), note(NOW * 1000 - i as u64, &long))).collect();
        let mut p = plain("n", NOW, vec![]);
        p.notes = notes.clone();
        p.down = (0..MAX_DOWN).map(|i| (format!("cork|d{i:04}"), down(NOW * 1000 - i as u64))).collect();
        let b = seal_fitting(&KEY, p.clone()).expect("fits once trimmed");
        let opened = open_bundle(&KEY, "room-a", &b).unwrap();
        assert!(opened.notes.len() < MAX_NOTES, "the oldest were left out");
        assert_eq!(opened.notes[0], notes[0], "the newest stayed");
        assert!(b.sealed.len() <= MAX_SEALED);
        // A small board goes whole.
        let small = plain("n", NOW, vec![("cork|a", note(1, "x"))]);
        assert_eq!(open_bundle(&KEY, "room-a", &seal_fitting(&KEY, small.clone()).unwrap()), Some(small));
    }

    #[test]
    fn the_store_keeps_the_newest_per_tag_and_refuses_the_rest() {
        let mut s = BundleStore::new(None);
        let none = HashSet::new();
        let tag = [1u8; 32];
        for i in 0..PER_TAG as u64 {
            assert_eq!(s.admit(junk(tag, NOW - 100 + i, i as u8), NOW, &none), Admit::New);
        }
        assert_eq!(s.admit(junk(tag, NOW - 100, 0), NOW, &none), Admit::Known);
        assert_eq!(s.admit(junk(tag, NOW - 200, 99), NOW, &none), Admit::Refused("older than every bundle kept under its tag"));
        assert_eq!(s.admit(junk(tag, NOW, 98), NOW, &none), Admit::New);
        assert_eq!(s.len(), PER_TAG);
        assert!(!s.has(&junk(tag, NOW - 100, 0).digest()), "the tag's oldest gave way");
    }

    #[test]
    fn the_store_refuses_the_future_and_the_expired_and_expires_by_ttl() {
        let mut s = BundleStore::new(None);
        let none = HashSet::new();
        assert_eq!(s.admit(junk([2; 32], NOW + FUTURE_SKEW_SECS + 1, 1), NOW, &none), Admit::Refused("stamped in the future"));
        assert_eq!(s.admit(junk([2; 32], NOW - TTL_SECS - 1, 1), NOW, &none), Admit::Refused("expired"));
        assert_eq!(s.admit(junk([2; 32], NOW - TTL_SECS + 10, 1), NOW, &none), Admit::New);
        s.expire(NOW + 11);
        assert_eq!(s.len(), 0);
        assert_eq!(s.bytes(), 0);
    }

    #[test]
    fn a_full_store_drops_unreadable_tags_first() {
        let mut s = BundleStore::new(None);
        let mine: Tag = [3; 32];
        let protected: HashSet<Tag> = [mine].into_iter().collect();
        // Our own room's bundle is the OLDEST in the store.
        assert_eq!(s.admit(junk(mine, NOW - 1000, 0), NOW, &protected), Admit::New);
        for i in 0..MAX_BUNDLES as u64 {
            let mut tag = [0u8; 32];
            tag[..8].copy_from_slice(&(i + 10).to_le_bytes());
            s.admit(junk(tag, NOW - 500 + i, 1), NOW, &protected);
        }
        assert_eq!(s.len(), MAX_BUNDLES);
        assert!(s.has(&junk(mine, NOW - 1000, 0).digest()), "our room's bundle outlives the strangers'");
    }

    #[test]
    fn a_want_asks_for_what_we_lack_our_rooms_first() {
        let mut s = BundleStore::new(None);
        let none = HashSet::new();
        let held = junk([4; 32], NOW, 1);
        s.admit(held.clone(), NOW, &none);
        let mine: Tag = [5; 32];
        let protected: HashSet<Tag> = [mine].into_iter().collect();
        let a = junk([6; 32], NOW, 2);
        let b = junk(mine, NOW - 50, 3);
        let offered = vec![
            (held.digest(), held.tag, held.at),
            (a.digest(), a.tag, a.at),
            (b.digest(), b.tag, b.at),
            (junk([7; 32], NOW + 10_000, 4).digest(), [7; 32], NOW + 10_000),
        ];
        assert_eq!(s.wanted(&offered, &protected, NOW), vec![b.digest(), a.digest()]);
    }

    #[test]
    fn a_reader_keeps_each_publishers_newest_and_skips_its_own() {
        let old = plain("node-b", NOW - 10, vec![("cork|1", note(1, "old")), ("cork|2", note(2, "unpinned since"))]);
        let new = plain("node-b", NOW, vec![("cork|1", note(1, "old"))]);
        let other = plain("node-c", NOW - 5, vec![("cork|3", note(3, "c's")), ("cork|1", note(1, "old"))]);
        let mine = plain("node-me", NOW + 1, vec![("cork|9", note(9, "ours"))]);
        let mut other = other;
        other.down = vec![("cork|2".to_string(), down(2))];
        let view = merge_view(vec![old, new, other, mine], "node-me");
        let keys: Vec<&str> = view.notes.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["cork|1", "cork|3"]);
        let downs: Vec<&str> = view.down.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(downs, vec!["cork|2"], "take-downs reach the tab from any publisher");
    }

    #[test]
    fn a_publisher_reads_note_shaped_entries_from_its_doc_newest_first() {
        use yrs::{Any, Map, Transact};
        let doc = yrs::Doc::new();
        let map = doc.get_or_insert_map("boardNotes");
        // Both maps before the write transaction: getting one inside it would
        // wait on the transaction itself.
        let downs = doc.get_or_insert_map("boardDown");
        {
            let mut txn = doc.transact_mut();
            let entry = |ts: f64, sig: bool| {
                let mut m = std::collections::HashMap::new();
                m.insert("ts".to_string(), Any::Number(ts));
                m.insert("text".to_string(), Any::from("hello ✨"));
                m.insert("x".to_string(), Any::Number(0.083));
                if sig {
                    m.insert("sig".to_string(), Any::from("sig"));
                }
                Any::from(m)
            };
            map.insert(&mut txn, "cork|old", entry(1_000.0, true));
            map.insert(&mut txn, "cork|new", entry(2_000.0, true));
            map.insert(&mut txn, "cork|unsigned", entry(3_000.0, false));
            map.insert(&mut txn, "nobar", entry(4_000.0, true));
            map.insert(&mut txn, "cork|future", entry(10_000_000.0, true));
            downs.insert(&mut txn, "cork|gone", entry(1_500.0, true));
            downs.insert(&mut txn, "cork|*", entry(2_500.0, true));
            downs.insert(&mut txn, "cork|unsigned", entry(2_600.0, false));
        }
        let read = board_from_doc(&doc, 5_000);
        let downs: Vec<&str> = read.down.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(downs, vec!["cork|*", "cork|gone"]);
        let notes = read.notes;
        let keys: Vec<&str> = notes.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(keys, vec!["cork|new", "cork|old"]);
        assert_eq!(notes[0].1["text"], "hello ✨");
        assert_eq!(notes[0].1["x"], 0.083);
        assert_eq!(notes[0].1["ts"], 2000.0);
    }

    #[test]
    fn a_publisher_republishes_on_change_new_day_or_after_six_hours() {
        let mut lane = BoardLane::new(BundleStore::new(None));
        let notes = content(vec![("cork|1", note(1, "a"))]);
        let empty = BoardContent::default();
        assert!(!lane.publish_due("r", &empty, NOW), "never an empty first bundle");
        assert!(lane.publish_due("r", &notes, NOW));
        lane.note_published("r", &notes, NOW);
        assert!(!lane.publish_due("r", &notes, NOW + 60));
        let changed = content(vec![("cork|1", note(1, "b"))]);
        assert!(lane.publish_due("r", &changed, NOW + 60));
        assert!(lane.publish_due("r", &notes, NOW + REPUBLISH_SECS));
        let next_day = (epoch_of(NOW) + 1) * DAY;
        assert!(lane.publish_due("r", &notes, next_day));
        assert_eq!(lane.next_stamp("r", NOW), NOW + 1, "stamps only move forward");
        assert_eq!(lane.next_stamp("r", NOW + 5), NOW + 5);
        // Emptied: once more, so readers see the notes came down, then quiet.
        assert!(lane.publish_due("r", &empty, NOW + 60));
        lane.note_published("r", &empty, NOW + 60);
        assert!(!lane.publish_due("r", &empty, NOW + REPUBLISH_SECS * 2));
    }

    #[test]
    fn a_peer_is_held_to_its_budget_and_never_told_what_it_sent() {
        let mut lane = BoardLane::new(BundleStore::new(None));
        let none = HashSet::new();
        for i in 0..PEER_ADMIT_PER_WINDOW as u64 {
            let mut tag = [0u8; 32];
            tag[..8].copy_from_slice(&i.to_le_bytes());
            assert_eq!(lane.admit_from_peer("p", junk(tag, NOW, 1), NOW, &none), Admit::New);
        }
        assert_eq!(lane.admit_from_peer("p", junk([200; 32], NOW, 1), NOW, &none), Admit::Refused("the peer is over its budget"));
        assert_eq!(lane.admit_from_peer("p", junk([200; 32], NOW, 1), NOW + PEER_WINDOW_SECS, &none), Admit::New);
        assert!(lane.advert_for("p").is_empty(), "everything came from p");
        assert_eq!(lane.advert_for("q").len(), ADVERT_MAX.min(lane.store.len()));
        assert!(lane.advert_for("q").is_empty(), "told once");
        // What a peer offers is never advertised back to it.
        let held = lane.store.recent(1);
        lane.note_offered("r", &held);
        assert!(!lane.advert_for("r").iter().any(|(d, _, _)| *d == held[0].0));
    }

    #[test]
    fn a_peer_is_served_within_its_window() {
        let mut lane = BoardLane::new(BundleStore::new(None));
        let none = HashSet::new();
        let mut ids = Vec::new();
        for i in 0..SERVE_MAX as u64 {
            let mut tag = [0u8; 32];
            tag[..8].copy_from_slice(&i.to_le_bytes());
            let b = junk(tag, NOW, 1);
            ids.push(b.digest());
            lane.store.admit(b, NOW, &none);
        }
        ids.push([0xee; 32]); // one we don't hold
        let mut served = 0;
        for _ in 0..10 {
            served += lane.serve("p", &ids, NOW).len();
        }
        assert_eq!(served, PEER_SERVE_PER_WINDOW as usize);
        assert_eq!(lane.serve("p", &ids, NOW + PEER_WINDOW_SECS).len(), SERVE_MAX);
        assert_eq!(lane.serve("q", &ids, NOW).len(), SERVE_MAX, "each peer has its own window");
    }

    #[test]
    fn tabs_get_a_view_once_per_change() {
        let mut lane = BoardLane::new(BundleStore::new(None));
        let mine: HashSet<Tag> = read_tags(&KEY, NOW).into_iter().collect();
        let b = seal_bundle(&KEY, &plain("node-b", NOW, vec![("cork|1", note(1, "hi"))])).unwrap();
        lane.store.admit(b, NOW, &mine);
        let first = lane.tab_view("room-a", &KEY, "node-me", b"tab-1", NOW).unwrap();
        assert_eq!(first.notes.len(), 1);
        assert_eq!(lane.tab_view("room-a", &KEY, "node-me", b"tab-1", NOW), None, "nothing new");
        assert!(lane.tab_view("room-a", &KEY, "node-me", b"tab-1|tab-2", NOW).is_some(), "a new tab gets it");
        assert_eq!(lane.tab_view("room-b", &OTHER, "node-me", b"tab-1", NOW), None, "another room's tags hold nothing");
    }

    #[test]
    fn the_store_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("ssf-board-bundles-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = BundleStore::load(&dir, NOW);
        let b = seal_bundle(&KEY, &plain("n", NOW, vec![("cork|a", note(1, "x"))])).unwrap();
        assert_eq!(s.admit(b.clone(), NOW, &HashSet::new()), Admit::New);
        std::fs::write(dir.join("garbage.json"), b"not json").unwrap();
        let again = BundleStore::load(&dir, NOW + 60);
        assert!(again.has(&b.digest()));
        assert_eq!(again.len(), 1);
        assert!(!dir.join("garbage.json").exists(), "junk files are cleared");
        let expired = BundleStore::load(&dir, NOW + TTL_SECS + 10);
        assert_eq!(expired.len(), 0);
        assert!(std::fs::read_dir(&dir).unwrap().next().is_none(), "expired files are cleared");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
