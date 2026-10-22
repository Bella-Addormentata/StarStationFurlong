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
//! - **WHO IS DIALLED**: only a provider this node already holds an
//!   authenticated room connection with (`remote_peers`), by its id alone —
//!   no address from the record, no hint, no discovery for an id nobody is
//!   connected to. A provider outside that set is not reachable from here,
//!   and the status says so; the hub prefetch and `have` announcements that
//!   reach a spoke's other spokes are the next slice.
//! - **WHO IS SERVED**: a peer is answered only for a blob it shares a room
//!   with — the room the blob was imported or fetched for — and only while it
//!   is a connected member of that room. Get-many and push are disabled; an
//!   observe (which would tell a stranger what this node holds) is held to
//!   the same rule as a get.
//! - **PLAYBACK** (`GET /blob/<hash>`): the node serves a COMPLETE blob to
//!   its own webview with byte ranges, behind the per-launch capability token
//!   and an allowed `Origin`. Nothing is served while a fetch is still
//!   running: playback starts when the transfer ends (early start, from the
//!   in-order verified prefix, is a later step).
//! - **THE CACHE**: one store under `blob-cache/`, emptied at every start, so
//!   nothing outlives the node's run (delete-on-leave is a node restart for
//!   now), under one disk quota (`SSF_BLOB_QUOTA_MB`, default 8 GiB).

use anyhow::{anyhow, Result};
use iroh::endpoint::Connection;
use iroh::{EndpointAddr, PublicKey};
use iroh_blobs::provider::events::{
    AbortReason, ConnectMode, EventMask, EventSender, ObserveMode, ProviderMessage, RequestMode, ThrottleMode,
};
use iroh_blobs::protocol::{ChunkRanges, ChunkRangesExt, GetRequest};
use iroh_blobs::store::fs::FsStore;
use iroh_blobs::Hash;
use n0_future::StreamExt;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::str::FromStr;
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
}

pub struct BlobLane {
    store: FsStore,
    dir: PathBuf,
    /// The per-launch capability token every blob route asks for: the node
    /// hands it to its own page in the fingerprint (readable only by an
    /// allowed origin), and it changes at every start.
    pub cap: String,
    quota: u64,
    held: Mutex<HashMap<Hash, Held>>,
    slots: tokio::sync::Semaphore,
}

impl BlobLane {
    /// Empty the cache and open a fresh store. A failure leaves the node
    /// running without the lane; the routes then answer 503.
    pub async fn open() -> Result<Arc<Self>> {
        let quota = std::env::var("SSF_BLOB_QUOTA_MB")
            .ok()
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_QUOTA_MB)
            .saturating_mul(1024 * 1024);
        Self::open_at(std::env::current_dir()?.join(CACHE_DIR), quota).await
    }

    pub(crate) async fn open_at(dir: PathBuf, quota: u64) -> Result<Arc<Self>> {
        if dir.exists() {
            std::fs::remove_dir_all(&dir)?;
        }
        std::fs::create_dir_all(&dir)?;
        let store = FsStore::load(&dir).await.map_err(|e| anyhow!("{e}"))?;
        let mut token = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut token);
        Ok(Arc::new(Self {
            store,
            dir,
            cap: hex::encode(token),
            quota,
            held: Mutex::new(HashMap::new()),
            slots: tokio::sync::Semaphore::new(MAX_FETCHES),
        }))
    }

    fn charged(held: &HashMap<Hash, Held>) -> u64 {
        held.values().map(|h| h.charged).sum()
    }

    /// May `remote` be served `hash`: the blob is whole here, and `remote` is
    /// a connected member of a room it was imported or fetched for.
    fn may_serve(&self, members: &Members, remote: &PublicKey, hash: &Hash) -> bool {
        let rooms: Vec<String> = {
            let held = self.held.lock().unwrap();
            match held.get(hash) {
                Some(h) if h.phase == Phase::Complete => h.rooms.iter().cloned().collect(),
                _ => return false,
            }
        };
        rooms.iter().any(|r| members(r, remote))
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
            get: RequestMode::Intercept,
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
                        let ok = msg.request.ranges.is_blob() && lane.may_serve(&hub, &remote, &msg.request.hash);
                        msg.tx.send(if ok { Ok(()) } else { Err(AbortReason::Permission) }).await.ok();
                    }
                    ProviderMessage::ObserveRequestReceived(msg) => {
                        let ok = lane.may_serve(&hub, &remote, &msg.request.hash);
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
    /// `room`'s members, and the members a FETCH from here could dial now
    /// (`reachable`, each at most `MAX_HELD_LISTED`), so the TV library can
    /// say which entries play from this node, and whose node an entry names
    /// is still here, without asking one by one.
    pub(crate) fn held_json(&self, room: &str, reachable: &[PublicKey]) -> String {
        let held = self.held.lock().unwrap();
        let hashes: Vec<String> = held
            .iter()
            .filter(|(_, h)| h.phase == Phase::Complete && h.rooms.contains(room))
            .take(MAX_HELD_LISTED)
            .map(|(hash, _)| hash.to_hex().to_string())
            .collect();
        let peers: Vec<String> = reachable.iter().take(MAX_HELD_LISTED).map(|p| p.to_string()).collect();
        serde_json::json!({ "held": hashes, "reachable": peers }).to_string()
    }

    fn fail(&self, hash: &Hash, why: &str) {
        let mut held = self.held.lock().unwrap();
        // Only a transfer still running can fail: an import of the same file
        // that completed meanwhile is whole, and stays so. The charge stays
        // (see `Held::charged`): what landed is on disk.
        if let Some(h) = held.get_mut(hash).filter(|h| matches!(h.phase, Phase::Queued | Phase::Fetching)) {
            h.phase = Phase::Failed(why.to_string());
        }
        eprintln!("📦 blob {}: {why}", hash.fmt_short());
    }

    /// Run one FETCH the local page asked for: dial a connected provider by
    /// id, take the blob under its declared size, check what arrived.
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
                            let mut held = self.held.lock().unwrap();
                            if let Some(h) = held.get_mut(&hash) {
                                h.have = got;
                                h.charged = storage_bound(got);
                                h.phase = Phase::Complete;
                            }
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
        let mut held = self.held.lock().unwrap();
        if Self::charged(&held) + storage_bound(len) > self.quota {
            return None;
        }
        held.insert(placeholder, Held {
            rooms: HashSet::new(), size: len, have: 0, mime: mime.to_string(), phase: Phase::Importing, charged: storage_bound(len),
        });
        Some(placeholder)
    }

    /// Whether a file of `len` bytes would fit in the quota now (a later
    /// `reserve` still decides).
    pub(crate) fn fits(&self, len: u64) -> bool {
        Self::charged(&self.held.lock().unwrap()) + storage_bound(len) <= self.quota
    }

    /// Give a reservation back (the import did not happen).
    pub(crate) fn unreserve(&self, placeholder: &Hash) {
        self.held.lock().unwrap().remove(placeholder);
    }

    /// The reservation becomes the imported blob's, for `room`, in one step:
    /// a moment with neither counted would let another import or FETCH take
    /// the same room in the quota.
    pub(crate) fn settle(&self, placeholder: Hash, hash: Hash, len: u64, room: String, mime: String) {
        let mut held = self.held.lock().unwrap();
        held.remove(&placeholder);
        let h = held.entry(hash).or_insert(Held {
            rooms: HashSet::new(), size: len, have: len, mime: mime.clone(), phase: Phase::Complete, charged: storage_bound(len),
        });
        h.rooms.insert(room);
        h.phase = Phase::Complete;
        h.have = len;
        h.size = len;
        h.charged = storage_bound(len);
        h.mime = mime;
    }

    /// Store a file already on this machine's disk (the torrent lane's
    /// download); its hash, or why not. The caller reserved it.
    #[cfg_attr(not(feature = "torrent"), allow(dead_code))]
    pub(crate) async fn add_file(&self, path: &std::path::Path) -> Result<Hash> {
        let tag = self.store.blobs().add_path(path).await.map_err(|e| anyhow!("{e}"))?;
        Ok(tag.hash)
    }

    /// Stream `len` body bytes (the first `already` read with the head) into
    /// the store; the hash, or why not.
    async fn import(&self, socket: &mut tokio::net::TcpStream, already: &[u8], len: u64) -> Result<Hash> {
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
            let tag = self.store.blobs().add_path(&part).await.map_err(|e| anyhow!("{e}"))?;
            Ok(tag.hash)
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
                Ok(hash) => {
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
            // with in THIS room, dialled by id: never an address the record
            // or anyone else supplied.
            let providers: Vec<PublicKey> = {
                let rooms = hub.rooms.lock().unwrap();
                match rooms.get(&room) {
                    Some(r) => wanted.into_iter().filter(|p| r.remote_peers.contains_key(p)).take(4).collect(),
                    None => Vec::new(),
                }
            };
            enum Verdict { Already, NotConnected, NoRoom, Start }
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
                    if providers.is_empty() {
                        Verdict::NotConnected
                    } else if BlobLane::charged(&held) - failed_charge + storage_bound(size).max(failed_charge) > lane.quota {
                        Verdict::NoRoom
                    } else {
                        held.insert(hash, Held {
                            rooms: HashSet::from([room]), size, have: 0, mime, phase: Phase::Queued, charged: storage_bound(size).max(failed_charge),
                        });
                        Verdict::Start
                    }
                }
            };
            match verdict {
                Verdict::Already => reply(socket, "200 OK", cors, &serde_json::json!({ "ok": true }).to_string()).await,
                Verdict::NotConnected => {
                    reply(socket, "409 Conflict", cors, &err_json("the node holding this file is not connected to yours")).await
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
            rooms: HashSet::from(["r".to_string()]), size, have: size, mime: "video/mp4".into(), phase: Phase::Complete, charged: size,
        });
        assert_eq!(
            lane_a.held_json("r", &[b_id]),
            serde_json::json!({ "held": [tag.hash.to_hex().to_string()], "reachable": [b_id.to_string()] }).to_string()
        );
        assert_eq!(lane_a.held_json("elsewhere", &[]), r#"{"held":[],"reachable":[]}"#);
        let queue = |lane: &Arc<BlobLane>, declared: u64| {
            lane.held.lock().unwrap().insert(tag.hash, Held {
                rooms: HashSet::from(["r".to_string()]), size: declared, have: 0, mime: String::new(), phase: Phase::Queued, charged: declared,
            });
        };

        queue(&lane_b, size);
        lane_b.clone().run_fetch(ep_b.clone(), tag.hash, size, vec![ep_a.id()]).await;
        assert_eq!(lane_b.held.lock().unwrap()[&tag.hash].phase, Phase::Complete);
        let mut got = Vec::new();
        lane_b.store.blobs().reader(tag.hash).read_to_end(&mut got).await.unwrap();
        assert_eq!(got, data);

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
