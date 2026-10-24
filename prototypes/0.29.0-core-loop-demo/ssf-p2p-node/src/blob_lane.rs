//! 📦 The blob lane — step 1 of the media lane (brainstorming/
//! smart-tv-arcade-media-plan.md §4): a file one player's node holds, sent
//! to the nodes of the room's other members as a BLAKE3 blob, verified as it
//! arrives, and played by each viewer's webview from its OWN node.
//!
//! What this slice is, and what it is not yet:
//!
//! - **IMPORT** (the holder's page, `POST /api/blob/import`): the page streams
//!   the file to its own node, which stores it and answers the hash. The page
//!   writes `{ kind: 'blob', hash, size, provider }` into the TV record.
//! - **FETCH** (a viewer's page, `POST /api/blob/fetch`): a command from the
//!   LOCAL page only — a node reading a hash in the room record fetches
//!   nothing (the record is peer-writable; plan §4 and §6). There is no
//!   automatic fetch at all in this slice, so no `autoFetchCap` /
//!   `autoFetchBudget` either: every transfer is one the viewer pressed FETCH
//!   for, run to the size the record declared and the button showed, under a
//!   disk quota the viewer's node sets.
//! - **WHO IS DIALLED**: only a provider this node holds an authenticated
//!   connection with in the room (`remote_peers`), or met there lately
//!   (below), by its id alone — no address from the record, no hint, and no
//!   lookup for an id this node never met in the room. A provider outside
//!   that set is not reachable from here, and the status says so — but a
//!   FETCH names every member WHERE said holds the file (below), so a copy
//!   on the room's host serves a visitor after the one who shared it has
//!   left.
//! - **WHO IS SERVED**: a peer is answered only for a blob it shares a room
//!   with — the room the blob was imported or fetched for — and only while it
//!   is a connected member of that room, or was one lately. Get-many and
//!   push are disabled; an observe (which would tell a stranger what this
//!   node holds) is held to the same rule as a get.
//! - **MET HERE LATELY** (a film in an empty room): every few seconds the
//!   node notes which nodes are connected members of each room a page on
//!   this machine joined, and keeps each for `MET_TTL` after it was last
//!   seen (in `library.json`, at most `MET_PER_ROOM` a room and `MET_ROOMS`
//!   rooms). Two nodes that met in a room still count as its members to
//!   each other for that room's files once either has gone to another room
//!   or module: a FETCH or WHERE dials the other by its id (found the way a
//!   room dial finds one, the DHT or the local network) wherever it is
//!   online now, and it serves what it would serve in the room. A member
//!   who left keeps what a member could take; nobody else gains anything.
//! - **PLAYBACK** (`GET /blob/<hash>`): the node serves a COMPLETE blob to
//!   its own webview with byte ranges, behind the per-launch capability token
//!   and an allowed `Origin`. Nothing is served while a fetch is still
//!   running: playback starts when the transfer ends (early start, from the
//!   in-order verified prefix, is a later step).
//! - **THE LIBRARY ON DISK**: one store under `blob-cache/`, under one disk
//!   quota (`SSF_BLOB_QUOTA_MB`, default 8 GiB). Whole files outlive the
//!   node's run, so the TV library's entries still play from this node after
//!   a restart: `library.json` beside the store names each one (its hash,
//!   size, type, the rooms it is served to, when it was last used), and at
//!   start only what it names AND the store holds whole comes back; the
//!   store's garbage collection removes the rest (partial fetches, files
//!   let go). When a new file does not fit, the files used longest ago go
//!   first, never one being read now nor one used in the last `IN_USE`
//!   (it may be playing).
//!   `POST /api/blob/forget` lets one go from the page. `SSF_BLOB_KEEP=0`
//!   empties the cache at every start instead, as before.
//! - **THE ROOM'S HOST KEEPS COPIES** (plan §4's hub prefetch): the page of
//!   a room this node hosts says so (`POST /api/blob/host`), and from then on
//!   the node copies each file the room's TV library names from the member
//!   who shared it — dialled by id, only while that member is connected to
//!   it, checked by hash like any fetch — so the file outlives its sharer's
//!   visit. The library is peer-written, so this automatic fetch runs under
//!   a per-file cap and a per-room daily budget in bytes and in files
//!   (`SSF_HOST_COPY_CAP_MB`, default 4 GiB; `SSF_HOST_COPY_DAY_MB`, 8 GiB;
//!   24 files), one copy per room at a time, and never shares a file with a
//!   room it was not copied for. The room's page can switch it off.
//! - **WHERE** (`GET /api/blob/where`, plan §4's `have`, asked rather than
//!   announced): which connected members of the room hold a file whole, and
//!   which of the few nodes met in it most lately (`WHERE_MAX_MET`) — asked
//!   of each over its own authenticated connection, with an observe its
//!   serving rule answers only for a member of a room the file is shared
//!   to, so a holder's word counts for itself alone, and the bytes are still
//!   checked against the hash.

use anyhow::{anyhow, Result};
use iroh::endpoint::Connection;
use iroh::{EndpointAddr, PublicKey};
use iroh_blobs::provider::events::{
    AbortReason, ConnectMode, EventMask, EventSender, ObserveMode, ProviderMessage, RequestMode, RequestUpdate, ThrottleMode,
};
use iroh_blobs::protocol::{ChunkRanges, ChunkRangesExt, GetRequest};
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::Hash;
use n0_future::StreamExt;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::SharedHub;

/// Is this peer a connected member of this room, as the hub sees it now.
type Members = Arc<dyn Fn(&str, &PublicKey) -> bool + Send + Sync>;

fn hub_members(hub: SharedHub) -> Members {
    Arc::new(move |room, peer| hub.rooms.lock().unwrap().get(room).is_some_and(|r| r.remote_peers.contains_key(peer)))
}

/// Where the store lives, beside `rooms/` in the node's working directory.
const CACHE_DIR: &str = "blob-cache";
/// The default disk quota for everything the lane holds, imports and fetches.
const DEFAULT_QUOTA_MB: u64 = 8 * 1024;
/// The list of whole files the node keeps across restarts, in the store's directory.
const LIBRARY_FILE: &str = "library.json";
/// A file used (served, imported, fetched) this recently may be playing: it
/// is never let go to make room.
const IN_USE: Duration = Duration::from_secs(30 * 60);
/// How often the store removes what no held file needs.
const GC_INTERVAL: Duration = Duration::from_secs(60);
/// `used` goes to disk at a read once the list was last written this long ago.
const USED_PERSIST: Duration = Duration::from_secs(10 * 60);
/// 🏠 The largest file the room's host copies without asking, and what it
/// copies per room in a day (`SSF_HOST_COPY_CAP_MB`, `SSF_HOST_COPY_DAY_MB`).
const HOST_COPY_CAP_MB: u64 = 4 * 1024;
const HOST_COPY_DAY_MB: u64 = 8 * 1024;
/// …and how many files a day, whatever their size.
const HOST_COPY_DAY_COUNT: usize = 24;
/// The least one copy is charged against the day's bytes: a thousand tiny
/// files still cost what checking and indexing them costs.
const HOST_COPY_MIN_CHARGE: u64 = 1024 * 1024;
const DAY_MS: u64 = 24 * 3600 * 1000;
/// How often the host looks at what its rooms played.
const HOST_SCAN: Duration = Duration::from_secs(10);
/// A file the host tried to copy is not tried again for this long.
const HOST_RETRY: Duration = Duration::from_secs(10 * 60);
/// The most library entries read per room and scan (the library keeps 200),
/// and the most keys of the peer-writable `tv` map looked at to find them.
const HOST_SCAN_ENTRIES: usize = 400;
const HOST_SCAN_KEYS: usize = 2_000;
/// The most rooms one node keeps copies for.
const MAX_HOST_ROOMS: usize = 64;
/// WHERE: the most files and members one ask covers, how long an answer
/// stays good, and how long a member gets to answer.
const WHERE_MAX_HASHES: usize = 16;
const WHERE_MAX_PEERS: usize = 8;
const WHERE_FRESH: Duration = Duration::from_secs(60);
const WHERE_TIMEOUT: Duration = Duration::from_secs(4);
/// 🤝 How long a node seen as a connected member of a room still counts as
/// one for that room's files, wherever it is online now; the most nodes
/// remembered a room, and rooms (the ones seen longest ago go first).
const MET_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const MET_PER_ROOM: usize = 32;
const MET_ROOMS: usize = 128;
/// A node new to the roster goes to `library.json` with the first look
/// once the list was last written this long ago (a later sight of one it
/// knows waits for `USED_PERSIST`).
const MET_PERSIST: Duration = Duration::from_secs(60);
/// WHERE asks at most this many nodes met in the room lately and not
/// connected now, besides the connected ones.
const WHERE_MAX_MET: usize = 4;
/// Transfers this node runs at once; a FETCH past it waits for a slot.
const MAX_FETCHES: usize = 2;
/// A dial to a connected provider that has not completed in this long fails.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// A transfer that moves no byte for this long has stalled, and fails.
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
/// What a blob of `size` bytes can take on disk, the most a fetch of it can
/// write: its data rounded up to whole 16 KiB chunk groups (a ranged request
/// is asked for in whole BLAKE3 chunks, and the store keeps groups), plus its
/// hash tree (64 bytes per group). Every charge against the quota is this,
/// never the bare size, so a declaration that rounds up cannot overrun it.
pub fn storage_bound(size: u64) -> u64 {
    const GROUP: u64 = 16 * 1024;
    let groups = size.div_ceil(GROUP).max(1);
    groups.saturating_mul(GROUP).saturating_add(groups.saturating_mul(64))
}

/// The longest room id a blob route accepts (the browser's are far shorter).
const MAX_ROOM_LEN: usize = 256;
/// The most hashes the held route lists (the TV library holds at most 200).
const MAX_HELD_LISTED: usize = 1000;
/// The longest request head the HTTP API reads before it gives up.
pub const MAX_HEAD: usize = 16 * 1024;

/// Where one blob is in this node's hands.
#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Importing,
    Queued,
    Fetching,
    Complete,
    Failed(String),
}

struct Held {
    /// The rooms this blob was imported or fetched for: the only rooms whose
    /// connected members this node serves it to.
    rooms: HashSet<String>,
    /// The declared size (a fetch) or the file's (an import).
    size: u64,
    /// Bytes received so far (a fetch), for the screen's progress.
    have: u64,
    /// What the webview is told it is: `video/*` or `audio/*`, else octet-stream.
    mime: String,
    phase: Phase,
    /// Bytes this blob holds against the quota. A fetch is charged its whole
    /// declaration from the moment it is queued and keeps that charge even
    /// when it fails: the request asks for no byte past the declaration, so
    /// that is the most it can have put on disk, and a failed transfer's
    /// bytes stay there until the next start empties the cache. A retry
    /// takes the charge over (raised to its own declaration if larger).
    charged: u64,
    /// Unix ms it was last imported, fetched or read: the oldest go first.
    used: u64,
    /// Reads of it running now (HTTP to the page, iroh to a member): a file
    /// being read is never let go to make room, however long the read.
    readers: u32,
}

/// A size the environment may set in MiB, in bytes.
fn env_mb(name: &str, default_mb: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(default_mb).saturating_mul(1024 * 1024)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A read of a whole file in progress (`BlobLane::reading`).
struct Reading {
    lane: Arc<BlobLane>,
    hash: Hash,
}

impl Drop for Reading {
    fn drop(&mut self) {
        if let Some(h) = self.lane.held.lock().unwrap().get_mut(&self.hash) {
            h.readers = h.readers.saturating_sub(1);
            h.used = now_ms();
        }
    }
}

/// Tests only: a pause before each file `restore` looks at.
#[cfg(test)]
static RESTORE_PAUSE_MS: AtomicU64 = AtomicU64::new(0);

/// What `library.json` holds: the kept files, the rooms this node hosts
/// (copies on or off), per hosted room the day's copies (unix ms, charge),
/// and the nodes met per room (node id → unix ms last seen).
#[derive(Default)]
struct Saved {
    files: Vec<KeptFile>,
    host: HashMap<String, bool>,
    spent: HashMap<String, Vec<(u64, u64)>>,
    met: HashMap<String, HashMap<String, u64>>,
}

/// One kept file in `library.json`.
#[derive(serde::Serialize, serde::Deserialize)]
struct KeptFile {
    hash: String,
    size: u64,
    mime: String,
    rooms: Vec<String>,
    used: u64,
}

/// 🏠 The rooms this node hosts, as their page said, and what it copied for them.
#[derive(Default)]
struct Hosting {
    /// Room → copies on (the default) or off, as the room's page set it.
    rooms: HashMap<String, bool>,
    /// Per room: when each copy of the last day started, and its charge.
    spent: HashMap<String, Vec<(u64, u64)>>,
    /// Files tried lately (unix ms): not tried again before `HOST_RETRY`.
    tried: HashMap<Hash, u64>,
    /// Per room: the file being copied now (one at a time).
    running: HashMap<String, Hash>,
}

/// 🤝 The nodes met as connected members of each room lately.
#[derive(Default)]
struct Met {
    /// Room → node → unix ms it was last seen a connected member there.
    rooms: HashMap<String, HashMap<PublicKey, u64>>,
    /// A node is here that `library.json` does not name yet.
    unsaved: bool,
}

impl Met {
    fn fresh(at: u64, now: u64) -> bool {
        now.saturating_sub(at) < MET_TTL.as_millis() as u64
    }

    /// Whether `peer` was a connected member of `room` within `MET_TTL`.
    fn knows(&self, room: &str, peer: &PublicKey, now: u64) -> bool {
        self.rooms.get(room).and_then(|n| n.get(peer)).is_some_and(|at| Self::fresh(*at, now))
    }

    /// The nodes met in `room` within `MET_TTL` that `skip` leaves, the
    /// most lately seen first.
    fn lately(&self, room: &str, skip: &dyn Fn(&PublicKey) -> bool, now: u64) -> Vec<PublicKey> {
        let Some(nodes) = self.rooms.get(room) else { return Vec::new() };
        let mut list: Vec<(u64, PublicKey)> = nodes.iter().filter(|(k, at)| Self::fresh(**at, now) && !skip(k)).map(|(k, at)| (*at, *k)).collect();
        list.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        list.into_iter().map(|(_, k)| k).collect()
    }

    /// Note who is a connected member of each room in `seen` at `now`, and
    /// let go of who was last seen `MET_TTL` ago, then of the nodes and
    /// rooms seen longest ago past the caps. Whether a sight moved.
    fn note(&mut self, seen: Vec<(String, Vec<PublicKey>)>, now: u64) -> bool {
        self.rooms.retain(|_, nodes| {
            nodes.retain(|_, at| Self::fresh(*at, now));
            !nodes.is_empty()
        });
        let mut moved = false;
        for (room, nodes) in seen {
            if nodes.is_empty() || !valid_room(&room) {
                continue;
            }
            let known = self.rooms.entry(room).or_default();
            for n in nodes {
                match known.insert(n, now) {
                    None => self.unsaved = true,
                    Some(at) => moved |= at != now,
                }
            }
        }
        self.cap();
        moved
    }

    fn cap(&mut self) {
        for nodes in self.rooms.values_mut() {
            if nodes.len() > MET_PER_ROOM {
                let mut by_age: Vec<(u64, PublicKey)> = nodes.iter().map(|(k, at)| (*at, *k)).collect();
                by_age.sort_unstable_by(|a, b| b.0.cmp(&a.0));
                for (_, k) in by_age.into_iter().skip(MET_PER_ROOM) {
                    nodes.remove(&k);
                }
            }
        }
        if self.rooms.len() > MET_ROOMS {
            let mut by_age: Vec<(u64, String)> = self.rooms.iter().map(|(r, n)| (n.values().copied().max().unwrap_or(0), r.clone())).collect();
            by_age.sort_unstable_by(|a, b| b.0.cmp(&a.0));
            for (_, r) in by_age.into_iter().skip(MET_ROOMS) {
                self.rooms.remove(&r);
            }
        }
    }

    /// The roster `library.json` named: valid rooms and ids, within
    /// `MET_TTL` (a sight dated after `now`, a clock set back, counts as
    /// now), under the caps.
    fn restored(saved: HashMap<String, HashMap<String, u64>>, now: u64) -> Self {
        let rooms = saved
            .into_iter()
            .filter(|(r, _)| valid_room(r))
            .map(|(r, nodes)| {
                let nodes: HashMap<PublicKey, u64> = nodes
                    .into_iter()
                    .filter_map(|(k, at)| Some((PublicKey::from_str(&k).ok()?, at.min(now))))
                    .filter(|(_, at)| Self::fresh(*at, now))
                    .collect();
                (r, nodes)
            })
            .filter(|(_, nodes)| !nodes.is_empty())
            .collect();
        let mut met = Self { rooms, unsaved: false };
        met.cap();
        met
    }
}

/// A file the room's TV library names, as the host reads it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LibBlob {
    pub hash: Hash,
    pub size: u64,
    pub provider: PublicKey,
    pub mime: String,
    /// Wall ms it was last played.
    pub played: u64,
}

/// The files a room's TV library names: its `tv` map's `lib:blob:<hash>`
/// entries, as tvDoc.ts writes them — the file the key names, or the
/// smaller copy its sharer's machine made of it (a source whose `was` is
/// that file: tvShrink.ts). Peer-written, so each is only a candidate: a copy
/// still dials its provider by id, only while connected, under the cap and
/// budget, and checks every byte against the hash.
pub(crate) fn library_blobs(doc: &yrs::Doc) -> Vec<LibBlob> {
    use yrs::{Any, Map, Out, ReadTxn, Transact};
    let txn = doc.transact();
    let Some(tv) = txn.get_map("tv") else { return Vec::new() };
    let num = |v: Option<&Any>| match v {
        Some(Any::Number(n)) if n.is_finite() && *n >= 0.0 && n.fract() == 0.0 => Some(*n as u64),
        Some(Any::BigInt(n)) if *n >= 0 => Some(*n as u64),
        _ => None,
    };
    let mut out = Vec::new();
    // Every key looked at counts, kept or not: the map is anyone's to pad.
    for (key, value) in tv.iter(&txn).take(HOST_SCAN_KEYS) {
        let Some(id) = key.strip_prefix("lib:blob:") else { continue };
        if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            continue;
        }
        let Out::Any(Any::Map(entry)) = value else { continue };
        let Some(Any::Map(source)) = entry.get("source") else { continue };
        let text = |k: &str| match source.get(k) {
            Some(Any::String(s)) => Some(s.to_string()),
            _ => None,
        };
        let was = match source.get("was") {
            Some(Any::Map(was)) => match was.get("hash") {
                Some(Any::String(h)) => Some(h.to_string()),
                _ => None,
            },
            _ => None,
        };
        let Some(named) = text("hash") else { continue };
        if text("kind").as_deref() != Some("blob") || (named != id && was.as_deref() != Some(id)) {
            continue;
        }
        let Ok(hash) = Hash::from_str(&named) else { continue };
        let Some(size) = num(source.get("size")).filter(|s| *s > 0 && *s <= 1 << 40) else { continue };
        let Some(provider) = text("provider").and_then(|p| PublicKey::from_str(&p).ok()) else { continue };
        out.push(LibBlob { hash, size, provider, mime: text("mime").unwrap_or_default(), played: num(entry.get("playedAt")).unwrap_or(0) });
        if out.len() >= HOST_SCAN_ENTRIES {
            break;
        }
    }
    out
}

pub struct BlobLane {
    store: FsStore,
    dir: PathBuf,
    /// The per-launch capability token every blob route asks for: the node
    /// hands it to its own page in the fingerprint (readable only by an
    /// allowed origin), and it changes at every start.
    pub cap: String,
    quota: u64,
    /// Whole files outlive the run (`SSF_BLOB_KEEP`, on unless `0`).
    keep: bool,
    /// Shared with the store's garbage collection, which keeps what is here.
    held: Arc<Mutex<HashMap<Hash, Held>>>,
    /// One `library.json` write at a time (they share its temp file).
    writing: Mutex<()>,
    /// Unix ms `library.json` was last written: a read writes it again once
    /// this is `USED_PERSIST` old, so a file in steady use is saved as used.
    saved: AtomicU64,
    slots: tokio::sync::Semaphore,
    hosting: Mutex<Hosting>,
    /// The host's per-file cap and per-room daily budget, in bytes.
    host_cap: u64,
    host_day: u64,
    /// WHERE's answers lately: (room, file) → (unix ms, holders).
    seen: Mutex<HashMap<(String, Hash), (u64, Vec<PublicKey>)>>,
    /// One WHERE ask out at a time; another answers from `seen`.
    asking: tokio::sync::Mutex<()>,
    /// 🤝 Who this node met in each room lately (`MET_TTL`).
    met: Mutex<Met>,
}

impl BlobLane {
    /// Open the store, with the files kept from the last run (or emptied,
    /// with `SSF_BLOB_KEEP=0`). A failure leaves the node running without
    /// the lane; the routes then answer 503.
    pub async fn open() -> Result<Arc<Self>> {
        let quota = env_mb("SSF_BLOB_QUOTA_MB", DEFAULT_QUOTA_MB);
        let keep = !std::env::var("SSF_BLOB_KEEP").is_ok_and(|v| v.trim() == "0");
        let lane = Self::open_with(std::env::current_dir()?.join(CACHE_DIR), quota, keep, GC_INTERVAL).await?;
        if keep {
            let (n, bytes) = {
                let held = lane.held.lock().unwrap();
                (held.len(), Self::charged(&held))
            };
            println!("📦 Blob lane keeps its files across restarts: {n} kept ({} MB of {} MB; SSF_BLOB_KEEP=0 empties it at start)", bytes / (1024 * 1024), quota / (1024 * 1024));
        }
        Ok(lane)
    }

    /// A fresh, emptied store (the tests' default).
    #[cfg(test)]
    pub(crate) async fn open_at(dir: PathBuf, quota: u64) -> Result<Arc<Self>> {
        Self::open_with(dir, quota, false, GC_INTERVAL).await
    }

    pub(crate) async fn open_with(dir: PathBuf, quota: u64, keep: bool, gc_interval: Duration) -> Result<Arc<Self>> {
        if dir.exists() && !keep {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(&dir)?;
        // An import cut off by the last stop.
        for e in std::fs::read_dir(&dir)?.flatten() {
            if e.file_name().to_string_lossy().starts_with("import-") {
                let _ = std::fs::remove_file(e.path());
            }
        }
        let held: Arc<Mutex<HashMap<Hash, Held>>> = Arc::default();
        // Everything `library.json` names is kept until `restore` has looked
        // at it: a collection that ran while the list was half read would
        // take the files not reached yet.
        let saved = if keep { Self::read_library(&dir) } else { Saved::default() };
        let pending: Arc<Mutex<HashSet<Hash>>> = Arc::new(Mutex::new(saved.files.iter().filter_map(|k| Hash::from_str(&k.hash).ok()).collect()));
        // The store keeps exactly what `held` names (whole, on its way, or a
        // failed fetch's charged bytes) and, while one is written, its temp
        // tag; everything else goes at the next collection.
        let protect = held.clone();
        let protect_pending = pending.clone();
        let add_protected: iroh_blobs::store::ProtectCb = Arc::new(move |live| {
            live.extend(protect.lock().unwrap().keys().copied());
            live.extend(protect_pending.lock().unwrap().iter().copied());
            Box::pin(async { iroh_blobs::store::ProtectOutcome::Continue })
        });
        let mut options = iroh_blobs::store::fs::options::Options::new(&dir);
        options.gc = Some(iroh_blobs::store::GcConfig { interval: gc_interval, add_protected: Some(add_protected) });
        let store = FsStore::load_with_opts(dir.join("blobs.db"), options).await.map_err(|e| anyhow!("{e}"))?;
        // `held` decides what stays, not tags.
        store.tags().delete_all().await.map_err(|e| anyhow!("{e}"))?;
        let mut token = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut token);
        let lane = Arc::new(Self {
            store,
            dir,
            cap: hex::encode(token),
            quota,
            keep,
            held,
            writing: Mutex::new(()),
            saved: AtomicU64::new(0),
            slots: tokio::sync::Semaphore::new(MAX_FETCHES),
            hosting: Mutex::default(),
            host_cap: env_mb("SSF_HOST_COPY_CAP_MB", HOST_COPY_CAP_MB),
            host_day: env_mb("SSF_HOST_COPY_DAY_MB", HOST_COPY_DAY_MB),
            seen: Mutex::default(),
            asking: tokio::sync::Mutex::new(()),
            met: Mutex::default(),
        });
        if keep {
            lane.restore(saved).await;
        }
        pending.lock().unwrap().clear();
        Ok(lane)
    }

    /// What `library.json` in `dir` says (nothing, unreadable).
    fn read_library(dir: &std::path::Path) -> Saved {
        let saved: Option<serde_json::Value> = std::fs::read(dir.join(LIBRARY_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok());
        let field = |k: &str| saved.as_ref().and_then(|v| v.get(k).cloned());
        Saved {
            files: field("files").and_then(|f| serde_json::from_value(f).ok()).unwrap_or_default(),
            host: field("host").and_then(|h| serde_json::from_value(h).ok()).unwrap_or_default(),
            spent: field("hostSpent").and_then(|h| serde_json::from_value(h).ok()).unwrap_or_default(),
            met: field("met").and_then(|m| serde_json::from_value(m).ok()).unwrap_or_default(),
        }
    }

    /// Bring back what `library.json` names and the store holds whole, the
    /// most recently used first, as far as the quota goes; the rooms this
    /// node hosts, with the day's copy charges; and who it met where.
    async fn restore(&self, saved: Saved) {
        let Saved { files: listed, host, spent, met } = saved;
        *self.met.lock().unwrap() = Met::restored(met, now_ms());
        {
            let mut h = self.hosting.lock().unwrap();
            h.rooms = host.into_iter().filter(|(r, _)| valid_room(r)).take(MAX_HOST_ROOMS).collect();
            let (now, since) = (now_ms(), now_ms().saturating_sub(DAY_MS));
            h.spent = spent
                .into_iter()
                .filter(|(r, _)| h.rooms.contains_key(r))
                .map(|(r, list)| (r, list.into_iter().filter(|(at, _)| *at > since && *at <= now).take(HOST_COPY_DAY_COUNT).collect::<Vec<_>>()))
                .collect();
        }
        let mut listed: Vec<KeptFile> = listed.into_iter().filter(|k| k.size > 0).collect();
        listed.sort_by(|a, b| b.used.cmp(&a.used));
        let mut charged = 0u64;
        for k in listed {
            #[cfg(test)]
            {
                let pause = RESTORE_PAUSE_MS.load(Ordering::Relaxed);
                if pause > 0 {
                    tokio::time::sleep(Duration::from_millis(pause)).await;
                }
            }
            let Ok(hash) = Hash::from_str(&k.hash) else { continue };
            let whole = matches!(self.store.blobs().status(hash).await, Ok(iroh_blobs::api::proto::BlobStatus::Complete { size }) if size == k.size);
            let rooms: HashSet<String> = k.rooms.into_iter().filter(|r| valid_room(r)).take(64).collect();
            if !whole || rooms.is_empty() || charged + storage_bound(k.size) > self.quota {
                continue;
            }
            charged += storage_bound(k.size);
            self.held.lock().unwrap().insert(hash, Held {
                rooms, size: k.size, have: k.size, mime: safe_mime(&k.mime), phase: Phase::Complete, charged: storage_bound(k.size), used: k.used, readers: 0,
            });
        }
        self.persist();
    }

    /// Write the whole files to `library.json` (nothing, without `keep`).
    fn persist(&self) {
        if !self.keep {
            return;
        }
        // Taken before the snapshot, so an older one never lands last.
        let _one = self.writing.lock().unwrap();
        self.saved.store(now_ms(), Ordering::Relaxed);
        let files: Vec<KeptFile> = {
            let held = self.held.lock().unwrap();
            held.iter()
                .filter(|(_, h)| h.phase == Phase::Complete && !h.rooms.is_empty())
                .map(|(hash, h)| KeptFile { hash: hash.to_hex().to_string(), size: h.size, mime: h.mime.clone(), rooms: h.rooms.iter().cloned().collect(), used: h.used })
                .collect()
        };
        // The rooms hosted, and the day's copy charges: a restart neither
        // forgets a switch nor hands out a fresh day.
        let (host, spent) = {
            let h = self.hosting.lock().unwrap();
            let since = now_ms().saturating_sub(DAY_MS);
            let spent: HashMap<String, Vec<(u64, u64)>> = h
                .spent
                .iter()
                .map(|(r, list)| (r.clone(), list.iter().copied().filter(|(at, _)| *at > since).collect::<Vec<_>>()))
                .filter(|(_, list)| !list.is_empty())
                .collect();
            (h.rooms.clone(), spent)
        };
        let met: HashMap<String, HashMap<String, u64>> = {
            let mut m = self.met.lock().unwrap();
            m.unsaved = false;
            m.rooms.iter().map(|(r, nodes)| (r.clone(), nodes.iter().map(|(k, at)| (k.to_string(), *at)).collect())).collect()
        };
        let body = serde_json::json!({ "v": 1, "files": files, "host": host, "hostSpent": spent, "met": met }).to_string();
        let tmp = self.dir.join(format!("{LIBRARY_FILE}.tmp"));
        if let Err(e) = std::fs::write(&tmp, body).and_then(|_| std::fs::rename(&tmp, self.dir.join(LIBRARY_FILE))) {
            eprintln!("⚠️ blob-cache/{LIBRARY_FILE} could not be written: {e}");
        }
    }

    fn charged(held: &HashMap<Hash, Held>) -> u64 {
        held.values().map(|h| h.charged).sum()
    }

    /// Make room for `extra` more bytes of charge: let go of failed fetches,
    /// then the whole files used longest ago (never one being read, one
    /// used within `IN_USE`, nor `except`), until it fits. Nothing goes when
    /// even that would not be enough. Whether it fits now; the caller persists when
    /// something went.
    fn make_room(held: &mut HashMap<Hash, Held>, quota: u64, extra: u64, except: Option<&Hash>, now: u64) -> (bool, bool) {
        let charged = Self::charged(held);
        if charged + extra <= quota {
            return (true, false);
        }
        let recent = now.saturating_sub(IN_USE.as_millis() as u64);
        let mut victims: Vec<(u64, Hash, u64)> = held
            .iter()
            .filter(|(hash, h)| Some(*hash) != except && (matches!(h.phase, Phase::Failed(_)) || (h.phase == Phase::Complete && h.readers == 0 && h.used < recent)))
            .map(|(hash, h)| (if matches!(h.phase, Phase::Failed(_)) { 0 } else { h.used.max(1) }, *hash, h.charged))
            .collect();
        victims.sort();
        let freeable: u64 = victims.iter().map(|v| v.2).sum();
        if charged - freeable.min(charged) + extra > quota {
            return (false, false);
        }
        let mut now_charged = charged;
        for (_, hash, charge) in victims {
            if now_charged + extra <= quota {
                break;
            }
            held.remove(&hash);
            now_charged -= charge;
            println!("📦 blob {}: let go to make room (used longest ago)", hash.fmt_short());
        }
        (true, true)
    }

    /// Whether a file of `len` bytes would fit, letting go of what could go.
    #[cfg_attr(not(feature = "torrent"), allow(dead_code))]
    fn would_fit(held: &HashMap<Hash, Held>, quota: u64, extra: u64, now: u64) -> bool {
        let recent = now.saturating_sub(IN_USE.as_millis() as u64);
        let freeable: u64 = held
            .values()
            .filter(|h| matches!(h.phase, Phase::Failed(_)) || (h.phase == Phase::Complete && h.readers == 0 && h.used < recent))
            .map(|h| h.charged)
            .sum();
        Self::charged(held).saturating_sub(freeable) + extra <= quota
    }

    /// The page lets a whole file (or a failed fetch) go from this node.
    /// Why not, if not.
    pub(crate) fn forget(&self, hash: &Hash) -> std::result::Result<(), &'static str> {
        {
            let mut held = self.held.lock().unwrap();
            match held.get(hash) {
                None => return Err("this node does not have that file"),
                Some(h) if !matches!(h.phase, Phase::Complete | Phase::Failed(_)) => return Err("that file is still on its way — wait for it"),
                Some(_) => {
                    held.remove(hash);
                }
            }
        }
        self.persist();
        println!("📦 blob {}: let go from this node's page", hash.fmt_short());
        Ok(())
    }

    /// Note a read of `hash`: it is in use, and the last to go. The list on
    /// disk is written again once its last write is `USED_PERSIST` old.
    fn touch(&self, hash: &Hash) {
        let now = now_ms();
        let found = match self.held.lock().unwrap().get_mut(hash) {
            Some(h) => {
                h.used = now;
                true
            }
            None => false,
        };
        if found && now.saturating_sub(self.saved.load(Ordering::Relaxed)) > USED_PERSIST.as_millis() as u64 {
            self.persist();
        }
    }

    /// A read of `hash` starts: until the guard drops, the file is not let
    /// go to make room.
    fn reading(self: &Arc<Self>, hash: Hash) -> Reading {
        if let Some(h) = self.held.lock().unwrap().get_mut(&hash) {
            h.readers += 1;
        }
        Reading { lane: self.clone(), hash }
    }

    // ── 🏠 The room's host keeps copies ─────────────────────────────────────

    /// The page of a room this node hosts says so: copies go on for it,
    /// unless that page switched them off before. `on` sets it.
    pub(crate) fn host_room(&self, room: &str, on: Option<bool>) -> std::result::Result<(), &'static str> {
        {
            let mut h = self.hosting.lock().unwrap();
            let was = h.rooms.get(room).copied();
            if was.is_none() && h.rooms.len() >= MAX_HOST_ROOMS {
                return Err("this node keeps copies for too many rooms already");
            }
            let now = on.or(was).unwrap_or(true);
            if was == Some(now) {
                return Ok(());
            }
            h.rooms.insert(room.to_string(), now);
        }
        self.persist();
        Ok(())
    }

    /// The day's copies for `room`: bytes charged and files, the older gone.
    fn spent_today(h: &mut Hosting, room: &str, now: u64) -> (u64, usize) {
        let Some(list) = h.spent.get_mut(room) else { return (0, 0) };
        list.retain(|(at, _)| now.saturating_sub(*at) < DAY_MS);
        (list.iter().map(|(_, b)| b).sum(), list.len())
    }

    /// What the held route says of copies for `room`: null when its page
    /// never said this node hosts it.
    fn host_json(&self, room: &str) -> serde_json::Value {
        let mut h = self.hosting.lock().unwrap();
        let Some(&on) = h.rooms.get(room) else { return serde_json::Value::Null };
        let (spent, files) = Self::spent_today(&mut h, room, now_ms());
        serde_json::json!({ "on": on, "cap": self.host_cap, "day": self.host_day, "spent": spent, "files": files, "dayFiles": HOST_COPY_DAY_COUNT })
    }

    /// The next copy for `room`, queued and charged: the most recently
    /// played library file this node lacks, from a member `connected` now,
    /// under the cap, the day's budget and the quota. None while one is
    /// still on its way, or when nothing qualifies.
    fn next_copy(&self, room: &str, mut entries: Vec<LibBlob>, connected: &dyn Fn(&PublicKey) -> bool, me: &PublicKey, now: u64) -> Option<(Hash, u64, PublicKey)> {
        let mut evicted = false;
        let picked = {
            let mut h = self.hosting.lock().unwrap();
            if h.rooms.get(room) != Some(&true) {
                return None;
            }
            let mut held = self.held.lock().unwrap();
            if h.running.get(room).and_then(|r| held.get(r)).is_some_and(|x| matches!(x.phase, Phase::Queued | Phase::Fetching)) {
                return None;
            }
            h.tried.retain(|_, at| now.saturating_sub(*at) < HOST_RETRY.as_millis() as u64);
            entries.sort_by(|a, b| b.played.cmp(&a.played));
            let (spent, files) = Self::spent_today(&mut h, room, now);
            let mut picked = None;
            for e in entries {
                if held.get(&e.hash).is_some_and(|x| !matches!(x.phase, Phase::Failed(_)))
                    || h.tried.contains_key(&e.hash)
                    || e.size > self.host_cap
                    || e.provider == *me
                    || !connected(&e.provider)
                {
                    continue;
                }
                if files >= HOST_COPY_DAY_COUNT {
                    break; // the day's files: nothing more without asking
                }
                let charge = e.size.max(HOST_COPY_MIN_CHARGE);
                if spent + charge > self.host_day {
                    continue; // too big for what is left of the day; a smaller one may fit
                }
                // A failed try's bytes stay counted, as for a FETCH.
                let failed_charge = held.get(&e.hash).map(|x| x.charged).unwrap_or(0);
                let charged = storage_bound(e.size).max(failed_charge);
                let (fits, went) = Self::make_room(&mut held, self.quota, charged - failed_charge, Some(&e.hash), now);
                evicted |= went;
                if !fits {
                    continue;
                }
                held.insert(e.hash, Held {
                    rooms: HashSet::from([room.to_string()]), size: e.size, have: 0, mime: safe_mime(&e.mime), phase: Phase::Queued, charged, used: now, readers: 0,
                });
                h.tried.insert(e.hash, now);
                h.spent.entry(room.to_string()).or_default().push((now, charge));
                h.running.insert(room.to_string(), e.hash);
                picked = Some((e.hash, e.size, e.provider));
                break;
            }
            picked
        };
        // What went, and the charge, are on disk before the transfer starts.
        if evicted || picked.is_some() {
            self.persist();
        }
        picked
    }

    /// One look at every room this node keeps copies for: what its library
    /// names, who is connected, and the next copy started.
    fn copy_round(self: &Arc<Self>, hub: &SharedHub, endpoint: &iroh::Endpoint) {
        let rooms: Vec<String> = self.hosting.lock().unwrap().rooms.iter().filter(|(_, on)| **on).map(|(r, _)| r.clone()).collect();
        let me = endpoint.id();
        for room in rooms {
            let (entries, connected) = {
                let rooms = hub.rooms.lock().unwrap();
                let Some(r) = rooms.get(&room) else { continue };
                (library_blobs(&r.doc), r.remote_peers.keys().copied().collect::<HashSet<PublicKey>>())
            };
            if let Some((hash, size, provider)) = self.next_copy(&room, entries, &|p| connected.contains(p), &me, now_ms()) {
                println!("📦 blob {}: this room's host keeps a copy ({size} bytes, from {})", hash.fmt_short(), provider.fmt_short());
                tokio::spawn(self.clone().run_fetch(endpoint.clone(), hash, size, vec![provider]));
            }
        }
    }

    // ── 🤝 Met here lately ──────────────────────────────────────────────────

    /// One look at who is a connected member of each room a page on this
    /// machine joined (the hub's `served` rooms).
    fn met_round(&self, hub: &SharedHub) {
        let seen: Vec<(String, Vec<PublicKey>)> = hub
            .rooms
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, r)| r.served)
            .map(|(id, r)| (id.clone(), r.remote_peers.keys().copied().collect()))
            .collect();
        self.note_met(seen, now_ms());
    }

    /// Note who was seen where at `now`. `library.json` is written again
    /// for a node new to the roster once its last write is `MET_PERSIST`
    /// old, and for a later sight once it is `USED_PERSIST` old.
    fn note_met(&self, seen: Vec<(String, Vec<PublicKey>)>, now: u64) {
        let (moved, unsaved) = {
            let mut met = self.met.lock().unwrap();
            let moved = met.note(seen, now);
            (moved, met.unsaved)
        };
        let since = now.saturating_sub(self.saved.load(Ordering::Relaxed));
        if (unsaved && since >= MET_PERSIST.as_millis() as u64) || (moved && since >= USED_PERSIST.as_millis() as u64) {
            self.persist();
        }
    }

    /// Whether `peer` was a connected member of `room` within `MET_TTL`.
    fn met_in(&self, room: &str, peer: &PublicKey, now: u64) -> bool {
        self.met.lock().unwrap().knows(room, peer, now)
    }

    /// The nodes met in `room` within `MET_TTL` and not `connected` now,
    /// the most lately seen first.
    fn met_elsewhere(&self, room: &str, connected: &dyn Fn(&PublicKey) -> bool, now: u64) -> Vec<PublicKey> {
        self.met.lock().unwrap().lately(room, connected, now)
    }

    /// WHERE: which of `peers` (connected members of `room`) and `met`
    /// (nodes met in it lately, not connected now) hold each of `hashes`
    /// whole. Each is asked over its own connection, with an observe its
    /// serving rule answers only for a member of a room the file is shared
    /// to; answers are kept `WHERE_FRESH`, and while another ask is out,
    /// this one answers from them.
    pub(crate) async fn holders(&self, endpoint: &iroh::Endpoint, room: &str, peers: Vec<PublicKey>, met: Vec<PublicKey>, hashes: Vec<Hash>) -> HashMap<Hash, Vec<PublicKey>> {
        let now = now_ms();
        let fresh = |seen: &HashMap<(String, Hash), (u64, Vec<PublicKey>)>, h: &Hash| {
            seen.get(&(room.to_string(), *h)).filter(|(at, _)| now.saturating_sub(*at) < WHERE_FRESH.as_millis() as u64).map(|(_, ids)| ids.clone())
        };
        let mut out = HashMap::new();
        let mut ask = Vec::new();
        {
            let seen = self.seen.lock().unwrap();
            for h in hashes {
                match fresh(&seen, &h) {
                    Some(ids) => {
                        out.insert(h, ids);
                    }
                    None => ask.push(h),
                }
            }
        }
        if peers.is_empty() && met.is_empty() {
            // Nobody to ask: nobody here holds it. (Not kept: a member may connect.)
            for h in ask.drain(..) {
                out.insert(h, Vec::new());
            }
        }
        // While another ask is out, the files not answered lately are left
        // out of this answer (unknown, not "nobody").
        let busy = self.asking.try_lock();
        if let (false, Ok(_one)) = (ask.is_empty(), busy) {
            // One deadline per member for the dial and all its answers: a
            // member that never answers costs `WHERE_TIMEOUT`, once, and
            // what it did answer still counts.
            let asks = peers.iter().chain(met.iter()).map(|peer| {
                let (store, endpoint, ask, peer) = (self.store.clone(), endpoint.clone(), ask.clone(), *peer);
                async move {
                    let (mut has, mut answered) = (Vec::new(), Vec::new());
                    let probe = async {
                        let conn = endpoint.connect(EndpointAddr::new(peer), iroh_blobs::ALPN).await.ok()?;
                        for h in ask {
                            let mut bits = store.remote().observe(conn.clone(), iroh_blobs::protocol::ObserveRequest::new(h));
                            if let Some(Ok(b)) = bits.next().await {
                                if b.is_complete() {
                                    has.push(h);
                                }
                            }
                            // An observe refused (not shared to this room) is an answer too.
                            answered.push(h);
                        }
                        conn.close(0u32.into(), b"asked");
                        Some(())
                    };
                    let _ = tokio::time::timeout(WHERE_TIMEOUT, probe).await;
                    (peer, has, answered)
                }
            });
            let answers = n0_future::join_all(asks).await;
            let done = now_ms();
            let mut seen = self.seen.lock().unwrap();
            seen.retain(|_, (at, _)| done.saturating_sub(*at) < WHERE_FRESH.as_millis() as u64);
            for h in ask {
                let ids: Vec<PublicKey> = answers.iter().filter(|(_, has, _)| has.contains(&h)).map(|(p, _, _)| *p).collect();
                // Kept, and "nobody" said, only when every connected member
                // answered: a node met here lately that does not is most
                // likely offline, and is asked again once this is old.
                if answers.iter().filter(|(p, _, _)| peers.contains(p)).all(|(_, _, answered)| answered.contains(&h)) {
                    seen.insert((room.to_string(), h), (done, ids.clone()));
                } else if ids.is_empty() {
                    continue;
                }
                out.insert(h, ids);
            }
        }
        // Only the nodes asked now (an answer may be older than a leave).
        for ids in out.values_mut() {
            ids.retain(|p| peers.contains(p) || met.contains(p));
        }
        out
    }

    /// May `remote` be served `hash`: the blob is whole here, and `remote` is
    /// a connected member of a room it was imported or fetched for, or was
    /// one within `MET_TTL`. A get served counts as a use (`touch`); an
    /// observe (WHERE) does not.
    fn may_serve(&self, members: &Members, remote: &PublicKey, hash: &Hash, touch: bool) -> bool {
        let rooms: Vec<String> = {
            let held = self.held.lock().unwrap();
            match held.get(hash) {
                Some(h) if h.phase == Phase::Complete => h.rooms.iter().cloned().collect(),
                _ => return false,
            }
        };
        let now = now_ms();
        let ok = rooms.iter().any(|r| members(r, remote) || self.met_in(r, remote, now));
        if ok && touch {
            self.touch(hash);
        }
        ok
    }

    /// Answer one inbound blobs-ALPN connection under the serving rule.
    pub async fn serve_connection(self: Arc<Self>, hub: SharedHub, conn: Connection) {
        self.serve_with(hub_members(hub), conn).await
    }

    async fn serve_with(self: Arc<Self>, members: Members, conn: Connection) {
        let hub = members;
        let remote = conn.remote_id();
        let mask = EventMask {
            connected: ConnectMode::None,
            // The transfer's own events say when it ends (`Log`).
            get: RequestMode::InterceptLog,
            get_many: RequestMode::Disabled,
            push: RequestMode::Disabled,
            observe: ObserveMode::Intercept,
            throttle: ThrottleMode::None,
        };
        let (events, mut rx) = EventSender::channel(16, mask);
        let lane = self.clone();
        let gate = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                match msg {
                    ProviderMessage::GetRequestReceived(msg) => {
                        let ok = msg.request.ranges.is_blob() && lane.may_serve(&hub, &remote, &msg.request.hash, true);
                        // Kept from eviction while the transfer runs: until
                        // it completes, aborts, or its events stop.
                        let reading = ok.then(|| lane.reading(msg.request.hash));
                        msg.tx.send(if ok { Ok(()) } else { Err(AbortReason::Permission) }).await.ok();
                        if let Some(reading) = reading {
                            let mut updates = msg.rx;
                            tokio::spawn(async move {
                                let _reading = reading;
                                while let Ok(Some(u)) = updates.recv().await {
                                    if matches!(u, RequestUpdate::Completed(_) | RequestUpdate::Aborted(_)) {
                                        break;
                                    }
                                }
                            });
                        }
                    }
                    ProviderMessage::ObserveRequestReceived(msg) => {
                        let ok = lane.may_serve(&hub, &remote, &msg.request.hash, false);
                        msg.tx.send(if ok { Ok(()) } else { Err(AbortReason::Permission) }).await.ok();
                    }
                    _ => {}
                }
            }
        });
        iroh_blobs::provider::handle_connection(conn, (*self.store).clone(), events).await;
        gate.abort();
    }

    /// The JSON the status route answers for `hash`.
    pub(crate) fn status_json(&self, hash: &Hash) -> String {
        let held = self.held.lock().unwrap();
        let Some(h) = held.get(hash) else {
            return r#"{"state":"none"}"#.to_string();
        };
        let (state, why) = match &h.phase {
            Phase::Importing => ("importing", ""),
            Phase::Queued => ("queued", ""),
            Phase::Fetching => ("fetching", ""),
            Phase::Complete => ("complete", ""),
            Phase::Failed(why) => ("failed", why.as_str()),
        };
        serde_json::json!({ "state": state, "have": h.have, "size": h.size, "why": why }).to_string()
    }

    /// The JSON the held route answers: every whole blob this node serves to
    /// `room`'s members, and the members connected to it there now
    /// (`reachable`, each at most `MAX_HELD_LISTED`), so the TV library can
    /// say which entries play from this node, and whose node an entry names
    /// is still here, without asking one by one (one met in the room lately
    /// and online elsewhere, WHERE finds). `more`: the held list was cut, so
    /// a hash missing from it is not known to be missing.
    pub(crate) fn held_json(&self, room: &str, reachable: &[PublicKey]) -> String {
        let held = self.held.lock().unwrap();
        let mut whole: Vec<(&Hash, &Held)> = held.iter().filter(|(_, h)| h.phase == Phase::Complete && h.rooms.contains(room)).collect();
        let more = whole.len() > MAX_HELD_LISTED;
        if more {
            // Cut to the files used last: the ones a library shows first.
            whole.sort_unstable_by_key(|(_, h)| std::cmp::Reverse(h.used));
        }
        let hashes: Vec<String> = whole.iter().take(MAX_HELD_LISTED).map(|(hash, _)| hash.to_hex().to_string()).collect();
        let peers: Vec<String> = reachable.iter().take(MAX_HELD_LISTED).map(|p| p.to_string()).collect();
        let kept: u64 = held.values().filter(|h| h.phase == Phase::Complete).map(|h| h.charged).sum();
        drop(held);
        serde_json::json!({ "held": hashes, "more": more, "reachable": peers, "keep": self.keep, "kept": kept, "quota": self.quota, "host": self.host_json(room) }).to_string()
    }

    fn fail(&self, hash: &Hash, why: &str) {
        {
            let mut held = self.held.lock().unwrap();
            // Only a transfer still running can fail: an import of the same
            // file that completed meanwhile is whole, and stays so. The
            // charge stays (see `Held::charged`): what landed is on disk.
            if let Some(h) = held.get_mut(hash).filter(|h| matches!(h.phase, Phase::Queued | Phase::Fetching)) {
                h.phase = Phase::Failed(why.to_string());
            }
        }
        // A host copy that failed waits `HOST_RETRY` from now, however long
        // it ran before failing.
        let mut h = self.hosting.lock().unwrap();
        if h.running.values().any(|r| r == hash) {
            h.tried.insert(*hash, now_ms());
        }
        drop(h);
        eprintln!("📦 blob {}: {why}", hash.fmt_short());
    }

    /// Run one FETCH the local page asked for: dial a provider by id (one
    /// connected in the room, or met there lately), take the blob under its
    /// declared size, check what arrived.
    async fn run_fetch(self: Arc<Self>, endpoint: iroh::Endpoint, hash: Hash, size: u64, providers: Vec<PublicKey>) {
        let Ok(_slot) = self.slots.acquire().await else { return };
        {
            // An import of the same file may have landed while this waited:
            // the work is done, and must not be marked fetching again.
            let mut held = self.held.lock().unwrap();
            match held.get_mut(&hash) {
                Some(h) if h.phase == Phase::Queued => h.phase = Phase::Fetching,
                _ => return,
            }
        }
        let mut last_err = String::from("no provider answered");
        for provider in providers {
            let conn = match tokio::time::timeout(CONNECT_TIMEOUT, endpoint.connect(EndpointAddr::new(provider), iroh_blobs::ALPN)).await {
                Ok(Ok(c)) => c,
                Ok(Err(e)) => {
                    last_err = format!("could not reach {}: {e}", provider.fmt_short());
                    continue;
                }
                Err(_) => {
                    last_err = format!("{} did not answer in time", provider.fmt_short());
                    continue;
                }
            };
            // The ceiling is in the REQUEST: only the declared bytes are asked
            // for, so a provider holding a larger blob cannot write past the
            // declaration here — the transfer ends partial, and fails below.
            let request = GetRequest::blob_ranges(hash, ChunkRanges::bytes(0..size));
            let mut progress = self.store.remote().execute_get(conn.clone(), request).stream();
            let outcome: Result<(), String> = loop {
                match tokio::time::timeout(STALL_TIMEOUT, progress.next()).await {
                    Err(_) => break Err("the transfer stalled".into()),
                    Ok(None) => break Err("the transfer ended without a result".into()),
                    Ok(Some(iroh_blobs::api::remote::GetProgressItem::Progress(n))) => {
                        // The request already stops at the declaration; this
                        // is the second fence, should a provider send more.
                        if n > size {
                            break Err("the blob is larger than the room said".into());
                        }
                        if let Some(h) = self.held.lock().unwrap().get_mut(&hash).filter(|h| h.phase == Phase::Fetching) {
                            h.have = n;
                        }
                    }
                    Ok(Some(iroh_blobs::api::remote::GetProgressItem::Done(_))) => break Ok(()),
                    Ok(Some(iroh_blobs::api::remote::GetProgressItem::Error(e))) => break Err(format!("the provider failed the request: {e}")),
                }
            };
            drop(progress);
            conn.close(0u32.into(), b"done");
            match outcome {
                Ok(()) => {
                    match self.store.blobs().status(hash).await {
                        Ok(iroh_blobs::api::proto::BlobStatus::Complete { size: got }) if got == size => {
                            if let Some(h) = self.held.lock().unwrap().get_mut(&hash) {
                                h.have = got;
                                h.charged = storage_bound(got);
                                h.phase = Phase::Complete;
                                h.used = now_ms();
                            }
                            self.persist();
                            println!("📦 blob {}: fetched {got} bytes from {}", hash.fmt_short(), provider.fmt_short());
                            return;
                        }
                        Ok(iroh_blobs::api::proto::BlobStatus::Complete { size: got }) => {
                            // Verified bytes, but not the size the room declared:
                            // what played would not be what the button showed.
                            self.fail(&hash, &format!("the blob is {got} bytes, not the {size} the room said"));
                            return;
                        }
                        _ => last_err = "the transfer ended incomplete".into(),
                    }
                }
                Err(why) => last_err = why,
            }
        }
        self.fail(&hash, &last_err);
    }

    /// Reserve a file of `len` bytes against the quota before a byte of it
    /// is written, under a key of its own until the hash is known: a random
    /// one, so two imports at once are two reservations. None when it does
    /// not fit.
    pub(crate) fn reserve(&self, len: u64, mime: &str) -> Option<Hash> {
        let mut nonce = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
        let placeholder = Hash::new(nonce);
        let now = now_ms();
        let evicted = {
            let mut held = self.held.lock().unwrap();
            let (fits, evicted) = Self::make_room(&mut held, self.quota, storage_bound(len), None, now);
            if !fits {
                return None;
            }
            held.insert(placeholder, Held {
                rooms: HashSet::new(), size: len, have: 0, mime: mime.to_string(), phase: Phase::Importing, charged: storage_bound(len), used: now, readers: 0,
            });
            evicted
        };
        if evicted {
            self.persist();
        }
        Some(placeholder)
    }

    /// Whether a file of `len` bytes would fit in the quota now, letting go
    /// of what could go (a later `reserve` still decides).
    #[cfg_attr(not(feature = "torrent"), allow(dead_code))]
    pub(crate) fn fits(&self, len: u64) -> bool {
        Self::would_fit(&self.held.lock().unwrap(), self.quota, storage_bound(len), now_ms())
    }

    /// Give a reservation back (the import did not happen).
    pub(crate) fn unreserve(&self, placeholder: &Hash) {
        self.held.lock().unwrap().remove(placeholder);
    }

    /// The reservation becomes the imported blob's, for `room`, in one step:
    /// a moment with neither counted would let another import or FETCH take
    /// the same room in the quota.
    pub(crate) fn settle(&self, placeholder: Hash, hash: Hash, len: u64, room: String, mime: String) {
        {
            let mut held = self.held.lock().unwrap();
            held.remove(&placeholder);
            let h = held.entry(hash).or_insert(Held {
                rooms: HashSet::new(), size: len, have: len, mime: mime.clone(), phase: Phase::Complete, charged: storage_bound(len), used: 0, readers: 0,
            });
            h.rooms.insert(room);
            h.phase = Phase::Complete;
            h.have = len;
            h.size = len;
            h.charged = storage_bound(len);
            h.mime = mime;
            h.used = now_ms();
        }
        self.persist();
    }

    /// Store a file already on this machine's disk (the torrent lane's
    /// download): its hash, and the temp tag that keeps it from the store's
    /// collection until `settle` names it. The caller reserved it.
    #[cfg_attr(not(feature = "torrent"), allow(dead_code))]
    pub(crate) async fn add_file(&self, path: &std::path::Path) -> Result<(Hash, iroh_blobs::api::TempTag)> {
        let tag = self.store.blobs().add_path(path).temp_tag().await.map_err(|e| anyhow!("{e}"))?;
        Ok((tag.hash(), tag))
    }

    /// Stream `len` body bytes (the first `already` read with the head) into
    /// the store; the hash, or why not.
    async fn import(&self, socket: &mut tokio::net::TcpStream, already: &[u8], len: u64) -> Result<(Hash, iroh_blobs::api::TempTag)> {
        let mut nonce = [0u8; 8];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut nonce);
        let part = self.dir.join(format!("import-{}.part", hex::encode(nonce)));
        let result = async {
            let mut file = tokio::fs::File::create(&part).await?;
            let first = &already[..already.len().min(len as usize)];
            file.write_all(first).await?;
            let mut left = len - first.len() as u64;
            let mut buf = vec![0u8; 64 * 1024];
            while left > 0 {
                let want = buf.len().min(left as usize);
                let n = socket.read(&mut buf[..want]).await?;
                if n == 0 {
                    return Err(anyhow!("the upload ended early"));
                }
                file.write_all(&buf[..n]).await?;
                left -= n as u64;
            }
            file.flush().await?;
            drop(file);
            let tag = self.store.blobs().add_path(&part).temp_tag().await.map_err(|e| anyhow!("{e}"))?;
            Ok((tag.hash(), tag))
        }
        .await;
        let _ = tokio::fs::remove_file(&part).await;
        result
    }
}

/// One parsed request head.
pub struct Head {
    pub method: String,
    pub path: String,
    pub query: HashMap<String, String>,
    pub headers: HashMap<String, String>,
}

/// Parse the head the HTTP API read (everything before the blank line).
pub fn parse_head(raw: &str) -> Option<Head> {
    let mut lines = raw.split("\r\n");
    let mut first = lines.next()?.split(' ');
    let method = first.next()?.to_string();
    let target = first.next()?;
    let (path, q) = target.split_once('?').unwrap_or((target, ""));
    let query = q
        .split('&')
        .filter(|kv| !kv.is_empty())
        .filter_map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            Some((percent_decode(k)?, percent_decode(v)?))
        })
        .collect();
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Some(Head { method, path: path.to_string(), query, headers })
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'%' if i + 2 < b.len() => {
                out.push(u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).ok()?, 16).ok()?);
                i += 3;
            }
            b'%' => return None,
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

/// A MIME type the webview is told: `video/*` or `audio/*` in plain
/// characters, else octet-stream (the element sniffs it).
pub fn safe_mime(m: &str) -> String {
    let ok = m.len() <= 80
        && (m.starts_with("video/") || m.starts_with("audio/"))
        && m.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'/' | b'.' | b'+' | b'-'));
    if ok { m.to_string() } else { "application/octet-stream".to_string() }
}

/// A single `bytes=a-b` / `bytes=a-` / `bytes=-n` range over `len` bytes, as
/// an inclusive `(start, end)`; None for no header, Err for one this cannot
/// satisfy (multi-range included: the webview never asks for one).
pub fn parse_range(h: Option<&String>, len: u64) -> std::result::Result<Option<(u64, u64)>, ()> {
    let Some(h) = h else { return Ok(None) };
    let spec = h.strip_prefix("bytes=").ok_or(())?.trim();
    if spec.contains(',') || len == 0 {
        return Err(());
    }
    let (a, b) = spec.split_once('-').ok_or(())?;
    let (start, end) = if a.is_empty() {
        let n: u64 = b.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        (len.saturating_sub(n), len - 1)
    } else {
        let s: u64 = a.parse().map_err(|_| ())?;
        let e: u64 = if b.is_empty() { len - 1 } else { b.parse::<u64>().map_err(|_| ())?.min(len - 1) };
        (s, e)
    };
    if start > end || start >= len {
        return Err(());
    }
    Ok(Some((start, end)))
}

pub(crate) fn valid_room(r: &str) -> bool {
    !r.is_empty() && r.len() <= MAX_ROOM_LEN && r.chars().all(|c| !c.is_control())
}

/// 🏠 The host's copier: every few seconds, who is connected in each room
/// a page here joined (`BlobLane::met_round`), and the next copy for each
/// room this node keeps copies for (`BlobLane::copy_round`).
pub fn spawn_host_copier(lane: Arc<BlobLane>, hub: SharedHub, endpoint: iroh::Endpoint) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(HOST_SCAN).await;
            lane.met_round(&hub);
            lane.copy_round(&hub, &endpoint);
        }
    });
}

/// Is this request one of the lane's routes.
pub fn is_blob_route(path: &str) -> bool {
    path.starts_with("/blob/") || path.starts_with("/api/blob/")
}

pub(crate) async fn reply(socket: &mut tokio::net::TcpStream, status: &str, cors: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n{cors}Cache-Control: private, no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = socket.write_all(resp.as_bytes()).await;
}

pub(crate) fn err_json(why: &str) -> String {
    serde_json::json!({ "error": why }).to_string()
}

/// Answer one of the lane's routes. `origin_ok` is the HTTP API's own origin
/// rule (a loopback page, the desktop shell, or `SSF_ALLOWED_ORIGINS`); `cors`
/// the headers that grant that origin the answer.
pub async fn handle_http(
    lane: Option<Arc<BlobLane>>,
    hub: SharedHub,
    endpoint: iroh::Endpoint,
    socket: &mut tokio::net::TcpStream,
    head: Head,
    body_start: &[u8],
    origin_ok: bool,
    cors: &str,
) {
    let Some(lane) = lane else {
        return reply(socket, "503 Service Unavailable", cors, &err_json("the blob lane is not running on this node")).await;
    };
    // The gate before any read of the store (plan §4): an allowed Origin AND
    // this launch's token. A hash is no secret once a room record carries it,
    // so the hash alone authorizes nothing.
    let cap_ok = head.query.get("cap").is_some_and(|c| constant_time_eq(c.as_bytes(), lane.cap.as_bytes()));
    if !origin_ok || !cap_ok {
        return reply(socket, "403 Forbidden", cors, &err_json("not this node's page")).await;
    }
    let hash_param = |head: &Head| head.query.get("hash").and_then(|h| Hash::from_str(h).ok());
    match (head.method.as_str(), head.path.as_str()) {
        ("POST", "/api/blob/import") => {
            let room = head.query.get("room").cloned().unwrap_or_default();
            if !valid_room(&room) {
                return reply(socket, "400 Bad Request", cors, &err_json("no room")).await;
            }
            let Some(len) = head.headers.get("content-length").and_then(|v| v.parse::<u64>().ok()) else {
                return reply(socket, "411 Length Required", cors, &err_json("the upload needs its length")).await;
            };
            let mime = safe_mime(head.query.get("mime").map(String::as_str).unwrap_or(""));
            let Some(placeholder) = lane.reserve(len, &mime) else {
                return reply(socket, "413 Payload Too Large", cors, &err_json("not enough room in this node's blob quota")).await;
            };
            let result = lane.import(socket, body_start, len).await;
            match result {
                Ok((hash, _tag)) => {
                    lane.settle(placeholder, hash, len, room, mime);
                    println!("📦 blob {}: imported {len} bytes", hash.fmt_short());
                    let body = serde_json::json!({ "hash": hash.to_hex(), "size": len }).to_string();
                    reply(socket, "200 OK", cors, &body).await;
                }
                Err(e) => {
                    lane.unreserve(&placeholder);
                    reply(socket, "500 Internal Server Error", cors, &err_json(&format!("import failed: {e}"))).await
                }
            }
        }
        ("POST", "/api/blob/fetch") => {
            let room = head.query.get("room").cloned().unwrap_or_default();
            let Some(hash) = hash_param(&head) else {
                return reply(socket, "400 Bad Request", cors, &err_json("no hash")).await;
            };
            let Some(size) = head.query.get("size").and_then(|s| s.parse::<u64>().ok()).filter(|s| *s > 0) else {
                return reply(socket, "400 Bad Request", cors, &err_json("no size")).await;
            };
            if !valid_room(&room) {
                return reply(socket, "400 Bad Request", cors, &err_json("no room")).await;
            }
            let mime = safe_mime(head.query.get("mime").map(String::as_str).unwrap_or(""));
            let wanted: Vec<PublicKey> = head
                .query
                .get("from")
                .map(|f| f.split(',').filter_map(|id| PublicKey::from_str(id.trim()).ok()).collect())
                .unwrap_or_default();
            // Only a provider this node holds an authenticated connection
            // with in THIS room, or met in it lately (`MET_TTL`), dialled by
            // id: never an address the record or anyone else supplied. The
            // connected ones first: they answer at once.
            let connected: HashSet<PublicKey> = hub.rooms.lock().unwrap().get(&room).map(|r| r.remote_peers.keys().copied().collect()).unwrap_or_default();
            let now = now_ms();
            let mut providers: Vec<PublicKey> = Vec::new();
            for p in wanted.iter().filter(|p| connected.contains(*p)).chain(wanted.iter().filter(|p| !connected.contains(*p) && lane.met_in(&room, p, now))) {
                if providers.len() < 4 && !providers.contains(p) {
                    providers.push(*p);
                }
            }
            enum Verdict { Already, NotConnected, NoRoom, Start }
            let mut evicted = false;
            let verdict = {
                let mut held = lane.held.lock().unwrap();
                let already = match held.get_mut(&hash) {
                    // Already here or on its way: the room it is for now
                    // shares it too.
                    Some(h) if !matches!(h.phase, Phase::Failed(_)) => {
                        h.rooms.insert(room.clone());
                        true
                    }
                    _ => false,
                };
                if already {
                    Verdict::Already
                } else {
                    // A failed attempt's partial bytes stay counted (they
                    // are on disk until the next start); a new FETCH takes
                    // over that charge, raised to the whole declaration.
                    let failed_charge = held.get(&hash).map(|h| h.charged).unwrap_or(0);
                    let extra = storage_bound(size).max(failed_charge) - failed_charge;
                    if providers.is_empty() {
                        Verdict::NotConnected
                    } else {
                        let (fits, went) = BlobLane::make_room(&mut held, lane.quota, extra, Some(&hash), now_ms());
                        evicted = went;
                        if !fits {
                            Verdict::NoRoom
                        } else {
                            held.insert(hash, Held {
                                rooms: HashSet::from([room]), size, have: 0, mime, phase: Phase::Queued, charged: storage_bound(size).max(failed_charge), used: now_ms(), readers: 0,
                            });
                            Verdict::Start
                        }
                    }
                }
            };
            if evicted || matches!(verdict, Verdict::Already) {
                lane.persist(); // what went, or the room it is shared to now
            }
            match verdict {
                Verdict::Already => reply(socket, "200 OK", cors, &serde_json::json!({ "ok": true }).to_string()).await,
                Verdict::NotConnected => {
                    reply(socket, "409 Conflict", cors, &err_json("the node holding this file is not connected to yours, and has not been in this room with it lately")).await
                }
                Verdict::NoRoom => reply(socket, "413 Payload Too Large", cors, &err_json("not enough room in this node's blob quota")).await,
                Verdict::Start => {
                    tokio::spawn(lane.clone().run_fetch(endpoint, hash, size, providers));
                    reply(socket, "202 Accepted", cors, &serde_json::json!({ "ok": true }).to_string()).await;
                }
            }
        }
        ("GET", "/api/blob/held") => {
            let room = head.query.get("room").cloned().unwrap_or_default();
            if !valid_room(&room) {
                return reply(socket, "400 Bad Request", cors, &err_json("no room")).await;
            }
            let reachable: Vec<PublicKey> = hub.rooms.lock().unwrap().get(&room).map(|r| r.remote_peers.keys().copied().collect()).unwrap_or_default();
            let body = lane.held_json(&room, &reachable);
            reply(socket, "200 OK", cors, &body).await;
        }
        ("POST", "/api/blob/host") => {
            let room = head.query.get("room").cloned().unwrap_or_default();
            if !valid_room(&room) {
                return reply(socket, "400 Bad Request", cors, &err_json("no room")).await;
            }
            let on = match head.query.get("on").map(String::as_str) {
                None => None,
                Some("1") => Some(true),
                Some("0") => Some(false),
                Some(_) => return reply(socket, "400 Bad Request", cors, &err_json("on is 0 or 1")).await,
            };
            match lane.host_room(&room, on) {
                Ok(()) => reply(socket, "200 OK", cors, &serde_json::json!({ "host": lane.host_json(&room) }).to_string()).await,
                Err(why) => reply(socket, "409 Conflict", cors, &err_json(why)).await,
            }
        }
        ("GET", "/api/blob/where") => {
            let room = head.query.get("room").cloned().unwrap_or_default();
            if !valid_room(&room) {
                return reply(socket, "400 Bad Request", cors, &err_json("no room")).await;
            }
            let mut hashes: Vec<Hash> = Vec::new();
            for h in head.query.get("hashes").map(|v| v.split(',').filter_map(|h| Hash::from_str(h.trim()).ok()).collect::<Vec<_>>()).unwrap_or_default() {
                if !hashes.contains(&h) && hashes.len() < WHERE_MAX_HASHES {
                    hashes.push(h);
                }
            }
            if hashes.is_empty() {
                return reply(socket, "400 Bad Request", cors, &err_json("no hashes")).await;
            }
            // Asked only of the members this node holds an authenticated
            // connection with in THIS room, and a few it met in it lately,
            // by id.
            let connected: Vec<PublicKey> = hub.rooms.lock().unwrap().get(&room).map(|r| r.remote_peers.keys().copied().collect()).unwrap_or_default();
            let met: Vec<PublicKey> = lane.met_elsewhere(&room, &|p| connected.contains(p), now_ms()).into_iter().take(WHERE_MAX_MET).collect();
            let peers: Vec<PublicKey> = connected.into_iter().take(WHERE_MAX_PEERS).collect();
            let found = lane.holders(&endpoint, &room, peers, met, hashes).await;
            let holders: serde_json::Map<String, serde_json::Value> = found
                .into_iter()
                .map(|(h, ids)| (h.to_hex().to_string(), serde_json::Value::from(ids.iter().map(|p| p.to_string()).collect::<Vec<_>>())))
                .collect();
            reply(socket, "200 OK", cors, &serde_json::json!({ "holders": holders }).to_string()).await;
        }
        ("POST", "/api/blob/forget") => {
            let Some(hash) = hash_param(&head) else {
                return reply(socket, "400 Bad Request", cors, &err_json("no hash")).await;
            };
            match lane.forget(&hash) {
                Ok(()) => reply(socket, "200 OK", cors, &serde_json::json!({ "ok": true }).to_string()).await,
                Err(why) => reply(socket, "409 Conflict", cors, &err_json(why)).await,
            }
        }
        ("GET", "/api/blob/status") => {
            let Some(hash) = hash_param(&head) else {
                return reply(socket, "400 Bad Request", cors, &err_json("no hash")).await;
            };
            let body = lane.status_json(&hash);
            reply(socket, "200 OK", cors, &body).await;
        }
        ("GET", p) | ("HEAD", p) if p.starts_with("/blob/") => {
            let Ok(hash) = Hash::from_str(&p["/blob/".len()..]) else {
                return reply(socket, "404 Not Found", cors, &err_json("no such blob")).await;
            };
            let found = {
                let held = lane.held.lock().unwrap();
                held.get(&hash).filter(|h| h.phase == Phase::Complete).map(|h| (h.size, h.mime.clone()))
            };
            let Some((len, mime)) = found else {
                return reply(socket, "404 Not Found", cors, &err_json("not on this node yet")).await;
            };
            lane.touch(&hash);
            let _reading = lane.reading(hash);
            if let Err(e) = serve_bytes(&lane, socket, &head, hash, len, &mime, cors).await {
                eprintln!("📦 blob {}: serving ended: {e}", hash.fmt_short());
            }
        }
        _ => reply(socket, "404 Not Found", cors, &err_json("no such route")).await,
    }
}

async fn serve_bytes(
    lane: &BlobLane,
    socket: &mut tokio::net::TcpStream,
    head: &Head,
    hash: Hash,
    len: u64,
    mime: &str,
    cors: &str,
) -> Result<()> {
    let range = match parse_range(head.headers.get("range"), len) {
        Ok(r) => r,
        Err(()) => {
            let resp = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\n{cors}Content-Range: bytes */{len}\r\nCache-Control: private, no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            socket.write_all(resp.as_bytes()).await?;
            return Ok(());
        }
    };
    let (status, start, end) = match range {
        Some((s, e)) => ("206 Partial Content", s, e),
        None => ("200 OK", 0, len.saturating_sub(1)),
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    let content_range = if range.is_some() { format!("Content-Range: bytes {start}-{end}/{len}\r\n") } else { String::new() };
    // `no-store`: the webview's HTTP cache would otherwise keep a second,
    // unquotaed copy of what the node's store is the only home of.
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\n{cors}Accept-Ranges: bytes\r\n{content_range}Cache-Control: private, no-store\r\nContent-Length: {count}\r\nConnection: close\r\n\r\n"
    );
    socket.write_all(resp.as_bytes()).await?;
    if head.method == "HEAD" || count == 0 {
        return Ok(());
    }
    let mut reader = lane.store.blobs().reader(hash);
    reader.seek(std::io::SeekFrom::Start(start)).await?;
    let mut left = count;
    let mut buf = vec![0u8; 64 * 1024];
    while left > 0 {
        let want = buf.len().min(left as usize);
        let n = reader.read(&mut buf[..want]).await?;
        if n == 0 {
            return Err(anyhow!("the store ended early"));
        }
        socket.write_all(&buf[..n]).await?;
        left -= n as u64;
    }
    Ok(())
}

pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        let h = |s: &str| Some(s.to_string());
        assert_eq!(parse_range(None, 100), Ok(None));
        assert_eq!(parse_range(h("bytes=0-").as_ref(), 100), Ok(Some((0, 99))));
        assert_eq!(parse_range(h("bytes=10-19").as_ref(), 100), Ok(Some((10, 19))));
        assert_eq!(parse_range(h("bytes=90-500").as_ref(), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(h("bytes=-10").as_ref(), 100), Ok(Some((90, 99))));
        assert_eq!(parse_range(h("bytes=100-").as_ref(), 100), Err(()));
        assert_eq!(parse_range(h("bytes=0-1,5-6").as_ref(), 100), Err(()));
        assert_eq!(parse_range(h("items=0-1").as_ref(), 100), Err(()));
        assert_eq!(parse_range(h("bytes=5-2").as_ref(), 100), Err(()));
    }

    #[test]
    fn mimes() {
        assert_eq!(safe_mime("video/mp4"), "video/mp4");
        assert_eq!(safe_mime("audio/ogg"), "audio/ogg");
        assert_eq!(safe_mime("text/html"), "application/octet-stream");
        assert_eq!(safe_mime("video/mp4\r\nX-Evil: 1"), "application/octet-stream");
        assert_eq!(safe_mime("video/mp4; codecs=avc1"), "application/octet-stream");
    }

    #[test]
    fn heads() {
        let h = parse_head("GET /blob/abc?cap=x%20y&room=r+1 HTTP/1.1\r\nRange: bytes=0-\r\nOrigin: http://localhost:5173").unwrap();
        assert_eq!(h.method, "GET");
        assert_eq!(h.path, "/blob/abc");
        assert_eq!(h.query.get("cap").unwrap(), "x y");
        assert_eq!(h.query.get("room").unwrap(), "r 1");
        assert_eq!(h.headers.get("range").unwrap(), "bytes=0-");
        assert!(percent_decode("%zz").is_none());
        assert!(percent_decode("%4").is_none());
        assert_eq!(percent_decode("a%2Cb").unwrap(), "a,b");
    }

    /// Two nodes in one process: a member of the blob's room fetches it whole
    /// and verified; a peer that is no member is refused; a blob larger than
    /// its declaration is cut off at the declaration.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_member_fetches_and_a_stranger_does_not() {
        use iroh::address_lookup::memory::MemoryLookup;
        let tmp = std::env::temp_dir().join(format!("ssf-blob-test-{}", std::process::id()));
        let lane_a = BlobLane::open_at(tmp.join("a"), 1 << 30).await.unwrap();
        let lane_b = BlobLane::open_at(tmp.join("b"), 1 << 30).await.unwrap();
        let lane_c = BlobLane::open_at(tmp.join("c"), 1 << 30).await.unwrap();
        let bind = || async {
            iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .relay_mode(iroh::endpoint::RelayMode::Disabled)
                .alpns(vec![iroh_blobs::ALPN.to_vec()])
                .bind()
                .await
                .unwrap()
        };
        let (ep_a, ep_b, ep_c) = (bind().await, bind().await, bind().await);
        for ep in [&ep_b, &ep_c] {
            let lookup = MemoryLookup::new();
            lookup.add_endpoint_info(ep_a.addr());
            ep.address_lookup().unwrap().add(lookup);
        }
        // B is a member of room "r"; C is not.
        let b_id = ep_b.id();
        let members: Members = Arc::new(move |room, peer| room == "r" && *peer == b_id);
        {
            let (lane, ep, members) = (lane_a.clone(), ep_a.clone(), members.clone());
            tokio::spawn(async move {
                while let Some(inc) = ep.accept().await {
                    let Ok(conn) = inc.await else { continue };
                    tokio::spawn(lane.clone().serve_with(members.clone(), conn));
                }
            });
        }
        let data: Vec<u8> = (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let tag = lane_a.store.blobs().add_slice(&data).await.unwrap();
        let size = data.len() as u64;
        lane_a.held.lock().unwrap().insert(tag.hash, Held {
            rooms: HashSet::from(["r".to_string()]), size, have: size, mime: "video/mp4".into(), phase: Phase::Complete, charged: size, used: 0, readers: 0,
        });
        assert_eq!(
            lane_a.held_json("r", &[b_id]),
            serde_json::json!({ "held": [tag.hash.to_hex().to_string()], "host": null, "keep": false, "kept": size, "more": false, "quota": 1u64 << 30, "reachable": [b_id.to_string()] }).to_string()
        );
        assert!(lane_a.held_json("elsewhere", &[]).starts_with(r#"{"held":[],"#));
        let queue = |lane: &Arc<BlobLane>, declared: u64| {
            lane.held.lock().unwrap().insert(tag.hash, Held {
                rooms: HashSet::from(["r".to_string()]), size: declared, have: 0, mime: String::new(), phase: Phase::Queued, charged: declared, used: 0, readers: 0,
            });
        };

        queue(&lane_b, size);
        lane_b.clone().run_fetch(ep_b.clone(), tag.hash, size, vec![ep_a.id()]).await;
        assert_eq!(lane_b.held.lock().unwrap()[&tag.hash].phase, Phase::Complete);
        let mut got = Vec::new();
        lane_b.store.blobs().reader(tag.hash).read_to_end(&mut got).await.unwrap();
        assert_eq!(got, data);
        // A's side held the file as being read until the transfer ended.
        let read_over = |lane: &Arc<BlobLane>| {
            let h = &lane.held.lock().unwrap()[&tag.hash];
            h.readers == 0 && h.used > 0
        };
        for _ in 0..50 {
            if read_over(&lane_a) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(read_over(&lane_a), "the served read never ended");

        queue(&lane_c, size);
        lane_c.clone().run_fetch(ep_c.clone(), tag.hash, size, vec![ep_a.id()]).await;
        assert!(matches!(lane_c.held.lock().unwrap()[&tag.hash].phase, Phase::Failed(_)));
        assert!(!lane_c.store.blobs().has(tag.hash).await.unwrap());

        // A declaration smaller than the blob: B (a member) asks again under
        // a fresh store, and the transfer stops at the declared size.
        let lane_b2 = BlobLane::open_at(tmp.join("b2"), 1 << 30).await.unwrap();
        queue(&lane_b2, 1000);
        lane_b2.clone().run_fetch(ep_b.clone(), tag.hash, 1000, vec![ep_a.id()]).await;
        assert!(matches!(lane_b2.held.lock().unwrap()[&tag.hash].phase, Phase::Failed(_)));
        for _ in 0..100 {
            if lane_a.held.lock().unwrap()[&tag.hash].readers == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert_eq!(lane_a.held.lock().unwrap()[&tag.hash].readers, 0, "a read cut off at its declaration never ended");
        // …and asked for no more than it declared: the store holds a partial
        // blob of about the declared size, never the whole 300 KB.
        match lane_b2.store.blobs().status(tag.hash).await.unwrap() {
            iroh_blobs::api::proto::BlobStatus::Partial { .. } | iroh_blobs::api::proto::BlobStatus::NotFound => {}
            other => panic!("expected a partial blob, got {other:?}"),
        }
        let mut stored = 0u64;
        for e in walk(&tmp.join("b2")) {
            stored += std::fs::metadata(e).map(|m| m.len()).unwrap_or(0);
        }
        assert!(stored <= storage_bound(1000), "the store took {stored} bytes for a 1000-byte declaration, over its charge of {}", storage_bound(1000));

        // An import of the same file landing while a FETCH waited for its
        // slot: the queued fetch does nothing, and nothing marks it failed.
        let lane_d = BlobLane::open_at(tmp.join("d"), 1 << 30).await.unwrap();
        queue(&lane_d, size);
        lane_d.held.lock().unwrap().get_mut(&tag.hash).unwrap().phase = Phase::Complete;
        lane_d.clone().run_fetch(ep_c.clone(), tag.hash, size, vec![ep_a.id()]).await;
        assert_eq!(lane_d.held.lock().unwrap()[&tag.hash].phase, Phase::Complete);
        lane_d.fail(&tag.hash, "a late failure");
        assert_eq!(lane_d.held.lock().unwrap()[&tag.hash].phase, Phase::Complete);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() { out.extend(walk(&p)); } else if p.extension().is_none_or(|x| x != "db") { out.push(p); }
        }
        out
    }

    /// Put `data` in the lane as an import for room `r` would.
    async fn import_bytes(lane: &BlobLane, data: &[u8], name: &str) -> Hash {
        let path = lane.dir.join(format!("{name}.src"));
        std::fs::write(&path, data).unwrap();
        let placeholder = lane.reserve(data.len() as u64, "video/webm").expect("room for it");
        let (hash, _tag) = lane.add_file(&path).await.unwrap();
        lane.settle(placeholder, hash, data.len() as u64, "r".into(), "video/webm".into());
        std::fs::remove_file(&path).unwrap();
        hash
    }

    async fn whole(lane: &BlobLane, hash: Hash) -> bool {
        matches!(lane.store.blobs().status(hash).await, Ok(iroh_blobs::api::proto::BlobStatus::Complete { .. }))
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn kept_files_come_back_after_a_restart() {
        let dir = std::env::temp_dir().join(format!("ssf-blob-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let gc = Duration::from_millis(100);
        let data: Vec<u8> = (0..200_000u32).map(|i| (i * 13 % 251) as u8).collect();
        let lane = BlobLane::open_with(dir.clone(), 1 << 30, true, gc).await.unwrap();
        let hash = import_bytes(&lane, &data, "a").await;
        // A file the list names but the store does not hold whole is not brought back.
        let listed = std::fs::read_to_string(dir.join(LIBRARY_FILE)).unwrap();
        assert!(listed.contains(&hash.to_hex().to_string()));
        let ghost = Hash::new(b"never stored");
        let with_ghost = listed.replace(r#""files":["#, &format!(r#""files":[{{"hash":"{}","size":5,"mime":"video/mp4","rooms":["r"],"used":9}},"#, ghost.to_hex()));
        std::fs::write(dir.join(LIBRARY_FILE), with_ghost).unwrap();
        lane.store.shutdown().await.unwrap();
        drop(lane);

        let lane = BlobLane::open_with(dir.clone(), 1 << 30, true, gc).await.unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await; // a collection ran
        assert!(lane.status_json(&hash).contains(r#""state":"complete""#), "{}", lane.status_json(&hash));
        assert_eq!(lane.status_json(&ghost), r#"{"state":"none"}"#);
        assert!(lane.held_json("r", &[]).contains(&hash.to_hex().to_string()));
        assert!(lane.held_json("r", &[]).contains(r#""keep":true"#));
        let mut got = Vec::new();
        lane.store.blobs().reader(hash).read_to_end(&mut got).await.unwrap();
        assert_eq!(got, data, "the kept file survived the collection");
        assert!(!std::fs::read_to_string(dir.join(LIBRARY_FILE)).unwrap().contains(&ghost.to_hex().to_string()));
        lane.store.shutdown().await.unwrap();
        drop(lane);

        // SSF_BLOB_KEEP=0: emptied at start, as before.
        let lane = BlobLane::open_with(dir.clone(), 1 << 30, false, gc).await.unwrap();
        assert_eq!(lane.status_json(&hash), r#"{"state":"none"}"#);
        assert!(!whole(&lane, hash).await);
        lane.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_files_used_longest_ago_go_first_to_make_room() {
        let dir = std::env::temp_dir().join(format!("ssf-blob-room-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = |seed: u32| (0..100_000u32).map(|i| (i.wrapping_mul(seed) % 251) as u8).collect::<Vec<u8>>();
        // Room for two files, not three.
        let lane = BlobLane::open_with(dir.clone(), storage_bound(100_000) * 2 + 1000, true, Duration::from_millis(100)).await.unwrap();
        let a = import_bytes(&lane, &file(7), "a").await;
        let b = import_bytes(&lane, &file(11), "b").await;
        let hour = 3_600_000;
        lane.held.lock().unwrap().get_mut(&a).unwrap().used = now_ms() - 2 * hour;
        lane.held.lock().unwrap().get_mut(&b).unwrap().used = now_ms() - hour;
        assert!(lane.fits(100_000));
        let c = import_bytes(&lane, &file(13), "c").await;
        // A, used longest ago, went; B stayed.
        assert_eq!(lane.status_json(&a), r#"{"state":"none"}"#);
        assert!(lane.status_json(&b).contains("complete") && lane.status_json(&c).contains("complete"));
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!whole(&lane, a).await, "the store let A go");
        assert!(whole(&lane, b).await && whole(&lane, c).await);
        // A file in use (read just now) never goes: then nothing fits.
        lane.touch(&b);
        assert!(!lane.fits(100_000));
        assert!(lane.reserve(100_000, "video/webm").is_none());
        // FORGET from the page lets one go.
        assert!(lane.forget(&Hash::new(b"nothing")).is_err());
        lane.forget(&b).unwrap();
        assert!(lane.fits(100_000));
        assert!(!std::fs::read_to_string(dir.join(LIBRARY_FILE)).unwrap().contains(&b.to_hex().to_string()));
        lane.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A room doc whose TV library names `entries` (key, source fields, playedAt).
    fn library_doc(entries: &[(String, Vec<(&str, yrs::Any)>, f64)]) -> yrs::Doc {
        use yrs::{Map, Transact};
        let doc = yrs::Doc::new();
        let tv = doc.get_or_insert_map("tv");
        let mut txn = doc.transact_mut();
        for (key, source, played) in entries {
            let source: HashMap<String, yrs::Any> = source.iter().map(|(k, v)| (k.to_string(), v.clone())).collect();
            let entry: HashMap<String, yrs::Any> = HashMap::from([
                ("source".to_string(), yrs::Any::from(source)),
                ("title".to_string(), yrs::Any::from("a film")),
                ("playedAt".to_string(), yrs::Any::Number(*played)),
            ]);
            tv.insert(&mut txn, key.as_str(), yrs::Any::from(entry));
        }
        tv.insert(&mut txn, "tv:set-1", yrs::Any::from("not a library entry"));
        drop(txn);
        doc
    }

    fn blob_source(hash: &str, size: f64, provider: &str) -> Vec<(&'static str, yrs::Any)> {
        vec![
            ("kind", yrs::Any::from("blob")),
            ("hash", yrs::Any::from(hash)),
            ("size", yrs::Any::Number(size)),
            ("provider", yrs::Any::from(provider)),
            ("mime", yrs::Any::from("video/webm")),
        ]
    }

    #[test]
    fn the_library_is_read_with_care() {
        let me = iroh::SecretKey::generate().public().to_string();
        let a = Hash::new(b"a").to_hex().to_string();
        let b = Hash::new(b"b").to_hex().to_string();
        let f = Hash::new(b"f").to_hex().to_string();
        let small = Hash::new(b"f small").to_hex().to_string();
        let shrunk = |hash: &str, size: f64, provider: &str, was: &str| {
            let mut source = blob_source(hash, size, provider);
            source.push(("was", yrs::Any::from(HashMap::from([("hash".to_string(), yrs::Any::from(was)), ("size".to_string(), yrs::Any::Number(5000.0))]))));
            source
        };
        let doc = library_doc(&[
            (format!("lib:blob:{a}"), blob_source(&a, 5000.0, &me), 2000.0),
            // A key that names another file than its source.
            (format!("lib:blob:{b}"), blob_source(&a, 5000.0, &me), 3000.0),
            // No size, a fractional size, a provider that is no key.
            (format!("lib:blob:{}", Hash::new(b"c").to_hex()), blob_source(&Hash::new(b"c").to_hex(), 0.0, &me), 1.0),
            (format!("lib:blob:{}", Hash::new(b"d").to_hex()), blob_source(&Hash::new(b"d").to_hex(), 1.5, &me), 1.0),
            (format!("lib:blob:{}", Hash::new(b"e").to_hex()), blob_source(&Hash::new(b"e").to_hex(), 10.0, "nobody"), 1.0),
            ("lib:url:https://example.org/a.mp4".to_string(), vec![("kind", yrs::Any::from("url"))], 1.0),
            // 🗜 The smaller copy of the file the key names…
            (format!("lib:blob:{f}"), shrunk(&small, 900.0, &me, &f), 4000.0),
            // …and one that names another file as what it was.
            (format!("lib:blob:{}", Hash::new(b"g").to_hex()), shrunk(&small, 900.0, &me, &f), 1.0),
        ]);
        let got = library_blobs(&doc);
        assert_eq!(got.len(), 2, "{got:?}");
        let by = |h: &str| got.iter().find(|g| g.hash.to_hex().to_string() == h).unwrap();
        assert_eq!((by(&a).size, by(&a).played, by(&a).mime.as_str()), (5000, 2000, "video/webm"));
        assert_eq!((by(&small).size, by(&small).played), (900, 4000), "the copy is what a host keeps");
        assert_eq!(library_blobs(&yrs::Doc::new()), vec![]);
    }

    /// The room's host copies what its library names from the member who
    /// shared it, under the cap and the day's budget; a later visitor's WHERE
    /// finds the copy on the host, and only there.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_host_keeps_a_copy_a_visitor_can_find() {
        use iroh::address_lookup::memory::MemoryLookup;
        let tmp = std::env::temp_dir().join(format!("ssf-blob-host-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let mut host = BlobLane::open_with(tmp.join("host"), 1 << 30, true, GC_INTERVAL).await.unwrap();
        Arc::get_mut(&mut host).unwrap().host_cap = 250_000;
        let sharer = BlobLane::open_at(tmp.join("sharer"), 1 << 30).await.unwrap();
        let visitor = BlobLane::open_at(tmp.join("visitor"), 1 << 30).await.unwrap();
        let bind = || async {
            iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .relay_mode(iroh::endpoint::RelayMode::Disabled)
                .alpns(vec![iroh_blobs::ALPN.to_vec()])
                .bind()
                .await
                .unwrap()
        };
        let (ep_h, ep_s, ep_v) = (bind().await, bind().await, bind().await);
        for (ep, others) in [(&ep_h, [&ep_s, &ep_v]), (&ep_s, [&ep_h, &ep_v]), (&ep_v, [&ep_h, &ep_s])] {
            let lookup = MemoryLookup::new();
            for o in others {
                lookup.add_endpoint_info(o.addr());
            }
            ep.address_lookup().unwrap().add(lookup);
        }
        let (h_id, s_id, v_id) = (ep_h.id(), ep_s.id(), ep_v.id());
        // Everyone is a member of room "r" (the host serves the visitor; the sharer serves the host).
        let members: Members = Arc::new(move |room, peer| room == "r" && [h_id, s_id, v_id].contains(peer));
        for (lane, ep) in [(host.clone(), ep_h.clone()), (sharer.clone(), ep_s.clone())] {
            let members = members.clone();
            tokio::spawn(async move {
                while let Some(inc) = ep.accept().await {
                    let Ok(conn) = inc.await else { continue };
                    tokio::spawn(lane.clone().serve_with(members.clone(), conn));
                }
            });
        }
        let film: Vec<u8> = (0..200_000u32).map(|i| (i * 17 % 251) as u8).collect();
        let big: Vec<u8> = vec![7u8; 300_000];
        let film_hash = import_bytes(&sharer, &film, "film").await;
        let big_hash = import_bytes(&sharer, &big, "big").await;
        let s_hex = s_id.to_string();
        let doc = library_doc(&[
            (format!("lib:blob:{}", film_hash.to_hex()), blob_source(&film_hash.to_hex(), film.len() as f64, &s_hex), 2.0),
            // Over the host's cap (250 KB here): never copied without asking.
            (format!("lib:blob:{}", big_hash.to_hex()), blob_source(&big_hash.to_hex(), big.len() as f64, &s_hex), 3.0),
        ]);
        let now = now_ms();
        let connected = |p: &PublicKey| *p == s_id;

        // Not a room the host's page said it hosts: nothing.
        assert_eq!(host.next_copy("r", library_blobs(&doc), &connected, &h_id, now), None);
        assert_eq!(host.host_json("r"), serde_json::Value::Null);
        host.host_room("r", None).unwrap();
        assert_eq!(host.host_json("r")["on"], true);
        // The sharer is not connected: nothing.
        assert_eq!(host.next_copy("r", library_blobs(&doc), &|_| false, &h_id, now), None);

        let (hash, size, from) = host.next_copy("r", library_blobs(&doc), &connected, &h_id, now).expect("a copy");
        assert_eq!((hash, size, from), (film_hash, film.len() as u64, s_id));
        // One at a time per room.
        assert_eq!(host.next_copy("r", library_blobs(&doc), &connected, &h_id, now), None);
        host.clone().run_fetch(ep_h.clone(), hash, size, vec![from]).await;
        assert!(host.status_json(&film_hash).contains(r#""state":"complete""#), "{}", host.status_json(&film_hash));
        assert!(host.held_json("r", &[]).contains(&film_hash.to_hex().to_string()));
        let mut got = Vec::new();
        host.store.blobs().reader(film_hash).read_to_end(&mut got).await.unwrap();
        assert_eq!(got, film);
        // Charged to the day, and nothing more qualifies (the big one is over the cap).
        assert_eq!(host.host_json("r")["files"], 1);
        assert_eq!(host.next_copy("r", library_blobs(&doc), &connected, &h_id, now), None);

        // A later visitor asks the room's connected members who has it: the host.
        let found = visitor.holders(&ep_v, "r", vec![h_id, s_id], vec![], vec![film_hash, big_hash]).await;
        assert_eq!(found[&film_hash].len(), 2, "the host and the sharer both hold the film");
        assert!(found[&film_hash].contains(&h_id));
        assert_eq!(found[&big_hash], vec![s_id], "the host never copied the big one");
        // Once the sharer has left, the answer names only those still connected.
        let found = visitor.holders(&ep_v, "r", vec![h_id], vec![], vec![film_hash]).await;
        assert_eq!(found[&film_hash], vec![h_id]);
        // …and the visitor fetches from the host.
        visitor.held.lock().unwrap().insert(film_hash, Held {
            rooms: HashSet::from(["r".to_string()]), size, have: 0, mime: String::new(), phase: Phase::Queued, charged: size, used: 0, readers: 0,
        });
        visitor.clone().run_fetch(ep_v.clone(), film_hash, size, vec![h_id]).await;
        assert_eq!(visitor.held.lock().unwrap()[&film_hash].phase, Phase::Complete);
        // A room the file was not copied for learns nothing from the host.
        let other = BlobLane::open_at(tmp.join("other"), 1 << 30).await.unwrap();
        let found = other.holders(&ep_v, "elsewhere", vec![h_id], vec![], vec![Hash::new(b"never held")]).await;
        assert_eq!(found[&Hash::new(b"never held")], vec![]);

        // Switched off by the room's page: no more copies, and it lasts a restart.
        host.host_room("r", Some(false)).unwrap();
        host.host_room("r", None).unwrap(); // the page binding again does not switch it back on
        assert_eq!(host.host_json("r")["on"], false);
        host.store.shutdown().await.unwrap();
        drop(host);
        let host = BlobLane::open_with(tmp.join("host"), 1 << 30, true, GC_INTERVAL).await.unwrap();
        assert_eq!(host.host_json("r")["on"], false);
        assert!(host.status_json(&film_hash).contains("complete"), "the copy is kept across the restart");
        host.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 🤝 Two nodes that met in a room, one of them in another room or
    /// module now: the one still there finds the other by WHERE and fetches
    /// from it by id; a node never met in the room, or met longer ago than
    /// `MET_TTL`, is refused.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_node_met_in_the_room_is_served_from_elsewhere() {
        use iroh::address_lookup::memory::MemoryLookup;
        let tmp = std::env::temp_dir().join(format!("ssf-blob-met-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let sharer = BlobLane::open_at(tmp.join("sharer"), 1 << 30).await.unwrap();
        let viewer = BlobLane::open_at(tmp.join("viewer"), 1 << 30).await.unwrap();
        let stranger = BlobLane::open_at(tmp.join("stranger"), 1 << 30).await.unwrap();
        let bind = || async {
            iroh::Endpoint::builder(iroh::endpoint::presets::Minimal)
                .relay_mode(iroh::endpoint::RelayMode::Disabled)
                .alpns(vec![iroh_blobs::ALPN.to_vec()])
                .bind()
                .await
                .unwrap()
        };
        let (ep_s, ep_v, ep_x) = (bind().await, bind().await, bind().await);
        // Found by id, as the DHT or the local network would find it.
        for ep in [&ep_v, &ep_x] {
            let lookup = MemoryLookup::new();
            lookup.add_endpoint_info(ep_s.addr());
            ep.address_lookup().unwrap().add(lookup);
        }
        // The sharer is a connected member of no room the film is in: it went elsewhere.
        let nobody: Members = Arc::new(|_, _| false);
        {
            let (lane, ep) = (sharer.clone(), ep_s.clone());
            tokio::spawn(async move {
                while let Some(inc) = ep.accept().await {
                    let Ok(conn) = inc.await else { continue };
                    tokio::spawn(lane.clone().serve_with(nobody.clone(), conn));
                }
            });
        }
        let film: Vec<u8> = (0..200_000u32).map(|i| (i * 19 % 251) as u8).collect();
        let hash = import_bytes(&sharer, &film, "film").await;
        let size = film.len() as u64;
        let (s_id, v_id, x_id) = (ep_s.id(), ep_v.id(), ep_x.id());
        // An hour ago the viewer was in room "r" with the sharer; the stranger only met it in another room.
        sharer.note_met(vec![("r".into(), vec![v_id]), ("elsewhere".into(), vec![x_id])], now_ms() - 3_600_000);

        assert_eq!(viewer.holders(&ep_v, "r", vec![], vec![s_id], vec![hash]).await[&hash], vec![s_id]);
        assert_eq!(stranger.holders(&ep_x, "r", vec![], vec![s_id], vec![hash]).await[&hash], vec![], "an observe from a node never met in the room is refused");
        let queue = |lane: &Arc<BlobLane>| {
            lane.held.lock().unwrap().insert(hash, Held {
                rooms: HashSet::from(["r".to_string()]), size, have: 0, mime: String::new(), phase: Phase::Queued, charged: size, used: 0, readers: 0,
            });
        };
        queue(&viewer);
        viewer.clone().run_fetch(ep_v.clone(), hash, size, vec![s_id]).await;
        assert_eq!(viewer.held.lock().unwrap()[&hash].phase, Phase::Complete);
        let mut got = Vec::new();
        viewer.store.blobs().reader(hash).read_to_end(&mut got).await.unwrap();
        assert_eq!(got, film);
        queue(&stranger);
        stranger.clone().run_fetch(ep_x.clone(), hash, size, vec![s_id]).await;
        assert!(matches!(stranger.held.lock().unwrap()[&hash].phase, Phase::Failed(_)));

        // Met longer ago than MET_TTL: a member no more.
        let late = BlobLane::open_at(tmp.join("late"), 1 << 30).await.unwrap();
        sharer.met.lock().unwrap().rooms.get_mut("r").unwrap().insert(v_id, now_ms() - MET_TTL.as_millis() as u64 - 1);
        queue(&late);
        late.clone().run_fetch(ep_v.clone(), hash, size, vec![s_id]).await;
        assert!(matches!(late.held.lock().unwrap()[&hash].phase, Phase::Failed(_)));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_nodes_met_are_bounded_and_outlive_a_restart() {
        let dir = std::env::temp_dir().join(format!("ssf-blob-met-keep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let quiet = Duration::from_secs(3600);
        let lane = BlobLane::open_with(dir.clone(), 1 << 30, true, quiet).await.unwrap();
        let key = || iroh::SecretKey::generate().public();
        let (a, b, old) = (key(), key(), key());
        let now = now_ms();
        let ttl = MET_TTL.as_millis() as u64;
        lane.note_met(vec![("r".into(), vec![old])], now - ttl + 60_000);
        lane.note_met(vec![("r".into(), vec![a]), ("q".into(), vec![b])], now - 1_000);
        lane.note_met(vec![("r".into(), vec![b])], now);
        // The most lately seen first, the connected left out.
        assert_eq!(lane.met_elsewhere("r", &|_| false, now), vec![b, a, old]);
        assert_eq!(lane.met_elsewhere("r", &|p| *p == b, now), vec![a, old]);
        assert!(lane.met_in("q", &b, now) && !lane.met_in("q", &a, now));
        assert!(!lane.met_in("r", &old, now + 120_000), "gone once MET_TTL has passed");
        // A node new to the roster goes to disk once the last write is MET_PERSIST old.
        let listed = || std::fs::read_to_string(dir.join(LIBRARY_FILE)).unwrap();
        assert!(!listed().contains(&a.to_string()), "written just now at the start: not again yet");
        lane.saved.store(now - MET_PERSIST.as_millis() as u64, Ordering::Relaxed);
        lane.note_met(vec![("r".into(), vec![b])], now);
        assert!(listed().contains(&a.to_string()) && listed().contains(&old.to_string()));
        lane.store.shutdown().await.unwrap();
        drop(lane);

        let lane = BlobLane::open_with(dir.clone(), 1 << 30, true, quiet).await.unwrap();
        assert_eq!(lane.met_elsewhere("r", &|_| false, now_ms()), vec![b, a, old]);
        // At most MET_PER_ROOM a room: the ones seen longest ago go.
        let t0 = now_ms();
        let many: Vec<PublicKey> = (0..MET_PER_ROOM + 5).map(|_| key()).collect();
        for (i, k) in many.iter().enumerate() {
            lane.note_met(vec![("r".into(), vec![*k])], t0 + i as u64);
        }
        assert_eq!(lane.met_elsewhere("r", &|_| false, t0 + 100), many.iter().rev().take(MET_PER_ROOM).copied().collect::<Vec<_>>());
        // At most MET_ROOMS rooms: the ones whose last sight is oldest go.
        for i in 0..MET_ROOMS {
            lane.note_met(vec![(format!("room-{i}"), vec![a])], t0 + 1_000 + i as u64);
        }
        assert_eq!(lane.met.lock().unwrap().rooms.len(), MET_ROOMS);
        assert!(!lane.met_in("r", &many[MET_PER_ROOM + 4], t0 + 5_000) && !lane.met_in("q", &b, t0 + 5_000));
        assert!(lane.met_in("room-0", &a, t0 + 5_000));
        lane.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        // What the list names is read with care: no id, no room, a sight
        // dated after now (a clock set back) counts as now.
        let saved = HashMap::from([
            ("r".to_string(), HashMap::from([("not an id".to_string(), 5u64), (a.to_string(), u64::MAX)])),
            ("bad\nroom".to_string(), HashMap::from([(b.to_string(), 900u64)])),
        ]);
        let met = Met::restored(saved, 1_000);
        assert_eq!(met.rooms.len(), 1);
        assert_eq!(met.rooms["r"], HashMap::from([(a, 1_000u64)]));
    }

    #[test]
    fn the_hosts_day_is_bounded_in_bytes_and_files() {
        let mut h = Hosting::default();
        let now = 10 * DAY_MS;
        h.spent.insert("r".into(), vec![(now - DAY_MS - 1, 5), (now - 10, 7), (now, 1)]);
        assert_eq!(BlobLane::spent_today(&mut h, "r", now), (8, 2));
        assert_eq!(BlobLane::spent_today(&mut h, "elsewhere", now), (0, 0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_hosts_day_outlives_a_restart_and_a_big_file_does_not_block_a_small_one() {
        let dir = std::env::temp_dir().join(format!("ssf-blob-host-day-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let quiet = Duration::from_secs(3600);
        let lane = BlobLane::open_with(dir.clone(), 1 << 40, true, quiet).await.unwrap();
        lane.host_room("r", Some(true)).unwrap();
        let now = now_ms();
        lane.hosting.lock().unwrap().spent.insert("r".into(), vec![(now - 1_000, 5 << 30)]);
        let (sharer, me) = (iroh::SecretKey::generate().public(), iroh::SecretKey::generate().public());
        let lib = |hash: Hash, size: u64, played: u64| LibBlob { hash, size, provider: sharer, mime: "video/mp4".into(), played };
        let (big, small) = (Hash::new(b"big"), Hash::new(b"small"));
        // 5 GiB of 8 spent: the newer 4 GiB file waits, the older 1 GiB one goes.
        let entries = || vec![lib(big, 4 << 30, 2_000), lib(small, 1 << 30, 1_000)];
        assert_eq!(lane.next_copy("r", entries(), &|_| true, &me, now).map(|c| c.0), Some(small));
        // A copy that ran past the retry time and then failed waits from its failure.
        lane.hosting.lock().unwrap().tried.insert(small, now - HOST_RETRY.as_millis() as u64 - 1);
        lane.fail(&small, "the sharer left");
        assert_eq!(lane.next_copy("r", entries(), &|_| true, &me, now_ms()), None);
        lane.store.shutdown().await.unwrap();
        drop(lane);
        // The day's charges were on disk before the transfer: a restart grants no fresh day.
        let lane = BlobLane::open_with(dir.clone(), 1 << 40, true, quiet).await.unwrap();
        let spent = BlobLane::spent_today(&mut lane.hosting.lock().unwrap(), "r", now_ms());
        assert_eq!(spent, ((5u64 << 30) + (1 << 30), 2));
        assert_eq!(lane.hosting.lock().unwrap().rooms.get("r"), Some(&true));
        lane.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_collection_during_restore_takes_nothing_it_has_not_reached() {
        let dir = std::env::temp_dir().join(format!("ssf-blob-restore-gc-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let gc = Duration::from_millis(20);
        let file = |seed: u32| (0..50_000u32).map(|i| (i.wrapping_mul(seed) % 251) as u8).collect::<Vec<u8>>();
        let lane = BlobLane::open_with(dir.clone(), 1 << 30, true, gc).await.unwrap();
        let a = import_bytes(&lane, &file(7), "a").await;
        let b = import_bytes(&lane, &file(11), "b").await;
        lane.store.shutdown().await.unwrap();
        drop(lane);
        // A slow restore: collections run every 20 ms while it looks at each file.
        RESTORE_PAUSE_MS.store(300, Ordering::Relaxed);
        let lane = BlobLane::open_with(dir.clone(), 1 << 30, true, gc).await.unwrap();
        RESTORE_PAUSE_MS.store(0, Ordering::Relaxed);
        for h in [a, b] {
            assert!(lane.status_json(&h).contains(r#""state":"complete""#), "{}", lane.status_json(&h));
            assert!(whole(&lane, h).await);
        }
        lane.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_file_being_read_stays_and_its_use_is_saved() {
        let dir = std::env::temp_dir().join(format!("ssf-blob-reading-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = |seed: u32| (0..100_000u32).map(|i| (i.wrapping_mul(seed) % 251) as u8).collect::<Vec<u8>>();
        // Room for two files, not three.
        let lane = BlobLane::open_with(dir.clone(), storage_bound(100_000) * 2 + 1000, true, Duration::from_millis(100)).await.unwrap();
        let a = import_bytes(&lane, &file(7), "a").await;
        let b = import_bytes(&lane, &file(11), "b").await;
        let hour = 3_600_000;
        lane.held.lock().unwrap().get_mut(&a).unwrap().used = now_ms() - 2 * hour;
        lane.held.lock().unwrap().get_mut(&b).unwrap().used = now_ms() - hour;
        // A read of A that has run for hours: A stays, B goes instead.
        let reading = lane.reading(a);
        let c = import_bytes(&lane, &file(13), "c").await;
        assert!(lane.status_json(&a).contains("complete"), "the file being read was let go");
        assert_eq!(lane.status_json(&b), r#"{"state":"none"}"#);
        assert!(!lane.fits(100_000), "nothing can go: one is being read, one was just used");
        drop(reading);
        assert!(lane.held.lock().unwrap()[&a].used > now_ms() - 60_000, "the read's end counts as a use");
        assert!(lane.held.lock().unwrap()[&a].readers == 0 && lane.held.lock().unwrap()[&c].readers == 0);

        // Use goes to disk once the list's last WRITE is old, however
        // recent the last read: steady reads are saved, not skipped.
        let saved_used = |h: Hash| -> u64 {
            let v: serde_json::Value = serde_json::from_slice(&std::fs::read(dir.join(LIBRARY_FILE)).unwrap()).unwrap();
            v["files"].as_array().unwrap().iter().find(|f| f["hash"] == h.to_hex().to_string()).unwrap()["used"].as_u64().unwrap()
        };
        lane.held.lock().unwrap().get_mut(&a).unwrap().used = 5;
        lane.persist();
        lane.touch(&a); // read just after a write: kept in memory only
        assert_eq!(saved_used(a), 5);
        lane.touch(&a);
        let quiet = now_ms() - USED_PERSIST.as_millis() as u64 - 1_000;
        lane.saved.store(quiet, Ordering::Relaxed); // the last write was long ago; the last read was not
        lane.touch(&a);
        assert!(saved_used(a) > now_ms() - 60_000, "a read in steady use was not saved");
        lane.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_cut_held_list_names_the_files_used_last() {
        let dir = std::env::temp_dir().join(format!("ssf-blob-cut-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lane = BlobLane::open_with(dir.clone(), 1 << 30, false, Duration::from_secs(3600)).await.unwrap();
        let hash = |i: u64| Hash::new(i.to_le_bytes());
        for i in 0..=MAX_HELD_LISTED as u64 {
            lane.held.lock().unwrap().insert(hash(i), Held {
                rooms: HashSet::from(["r".to_string()]), size: 1, have: 1, mime: String::new(), phase: Phase::Complete, charged: 1, used: i, readers: 0,
            });
        }
        let got: serde_json::Value = serde_json::from_str(&lane.held_json("r", &[])).unwrap();
        assert_eq!(got["more"], true);
        let listed: Vec<&str> = got["held"].as_array().unwrap().iter().map(|h| h.as_str().unwrap()).collect();
        assert_eq!(listed.len(), MAX_HELD_LISTED);
        assert!(listed.contains(&hash(MAX_HELD_LISTED as u64).to_hex().as_str()));
        assert!(!listed.contains(&hash(0).to_hex().as_str()), "the one used longest ago is the one cut");
        lane.store.shutdown().await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn storage_bounds() {
        assert_eq!(storage_bound(0), 16 * 1024 + 64);
        assert_eq!(storage_bound(1), 16 * 1024 + 64);
        assert_eq!(storage_bound(16 * 1024), 16 * 1024 + 64);
        assert_eq!(storage_bound(16 * 1024 + 1), 2 * (16 * 1024 + 64));
        assert!(storage_bound(u64::MAX) >= u64::MAX / 2);
    }

    #[test]
    fn rooms() {
        assert!(valid_room("room-1"));
        assert!(!valid_room(""));
        assert!(!valid_room("a\r\nb"));
        assert!(!valid_room(&"x".repeat(MAX_ROOM_LEN + 1)));
    }
}
