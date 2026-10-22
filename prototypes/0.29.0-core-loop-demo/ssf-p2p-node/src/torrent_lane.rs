//! 🧲 The torrent lane — step 4 of the media lane (brainstorming/
//! smart-tv-arcade-media-plan.md §6), behind the `torrent` cargo feature: a
//! magnet the remote's holder PASTES on their own page is fetched by THEIR
//! node from the public swarm, and the one file the room will watch goes into
//! the blob lane (blob_lane.rs), which carries it to the room's other nodes.
//! A viewer never touches the swarm.
//!
//! The §6 rules, and where each one stands here:
//!
//! - **Started only from a local command**: `POST /api/torrent/add` behind the
//!   blob lane's gate (an allowed Origin and this launch's token), with a
//!   pasted magnet or a chosen .torrent file. Nothing in the room record
//!   starts a torrent; the record sees the blob, and the TV library keeps
//!   only the info hash and file number for a later GET AGAIN, which the
//!   holder's own page sends here like any paste.
//! - **Look before you download**: the file list (the torrent's own names
//!   and sizes, not a paste's `dn=`) waits in the status as `ready`, and no
//!   piece is asked for until the holder picks a file and confirms it
//!   (`POST /api/torrent/confirm`). A file this node could not hold is
//!   marked, and refused at confirm with the list left for another pick.
//! - **No tracker list, and no tracker from the paste**: a magnet is rebuilt
//!   from its info hash alone (`clean_magnet`), so `tr=`, `ws=` and `x.pe=`
//!   never reach the client; a .torrent from its `info` dictionary alone
//!   (`clean_torrent`), so its `announce`, `announce-list` and `url-list`
//!   never do either. The session runs with trackers off.
//!   The plan's operator setting for trackers needs the media proxy's
//!   destination gate on every announce, which librqbit cannot be made to
//!   use, so per §6 it stays off and is not offered.
//! - **DHT client-only, global unicast only**: the session's DHT is the
//!   forked `vendor/librqbit-dht` (SSF-FORK.md), which answers no query and
//!   talks to public addresses only. `SSF_NO_DHT=1` turns it off here too
//!   (and with no trackers, a magnet then finds nobody).
//! - **Peer dials go to global unicast only**: the session's blocklist is
//!   every range that is not (`nonglobal_ranges`), checked on every outgoing
//!   TCP and uTP connection for pieces. librqbit's metadata fetch (BEP 9)
//!   skips that check, so the peers it can be handed are filtered at their
//!   sources instead: the forked DHT drops non-global peers from its replies,
//!   and this lane from the ones it passes in. No LAN allowlist exists yet,
//!   so no LAN peer.
//! - **LSD off**, no UPnP, and no listener at all: this node dials out and
//!   accepts nobody, so nothing on the machine opens to the internet.
//! - **Limits**: one torrent at a time; one file of it (`pick_file`, mp4/webm
//!   first); a size cap (`SSF_TORRENT_MAX_MB`, default 4 GiB) and the blob
//!   lane's quota, reserved before the download starts; an upload ceiling
//!   (`SSF_TORRENT_UP_KBPS`, default 256) and an optional download one
//!   (`SSF_TORRENT_DOWN_KBPS`); 50 peers.
//! - **Seeding budget**: none past the download. BitTorrent uploads pieces to
//!   the swarm while it downloads (the remote says so before START); once the
//!   file is whole the torrent leaves the session and stops sharing. Seeding
//!   while the TV plays is a later step.
//! - **The cache**: `torrent-cache/`, emptied at every start and per torrent
//!   once its file is in the blob lane.

use anyhow::{anyhow, Context, Result};
use iroh_blobs::Hash;
use librqbit::api::TorrentIdOrHash;
use librqbit::limits::LimitsConfig;
use librqbit::{AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, Magnet, Session, SessionOptions};
use std::net::{Ipv4Addr, Ipv6Addr};
#[cfg(test)]
use std::net::IpAddr;
use std::num::NonZeroU32;
use std::ops::RangeInclusive;
use std::path::{Component, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncReadExt;

use crate::blob_lane::{constant_time_eq, err_json, reply, valid_room, BlobLane, Head};

const CACHE_DIR: &str = "torrent-cache";
const DEFAULT_MAX_MB: u64 = 4 * 1024;
const DEFAULT_UP_KBPS: u64 = 256;
const PEER_LIMIT: usize = 50;
/// A magnet whose metadata no peer sends in this long fails.
const METADATA_TIMEOUT: Duration = Duration::from_secs(180);
/// A download that moves no byte for this long has stalled, and fails.
const STALL_TIMEOUT: Duration = Duration::from_secs(300);
/// The longest pasted magnet the add route reads.
const MAX_MAGNET: usize = 8 * 1024;
/// The largest .torrent file the add route reads (a big one is ~1 MB).
const MAX_TORRENT_FILE: usize = 4 * 1024 * 1024;
/// A file list nobody confirms in this long is dropped.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(600);
/// The most playable files the confirm step lists.
const MAX_LISTED: usize = 200;
/// The longest name the status shows (the TV record's title is shorter).
const MAX_NAME: usize = 120;

/// Where the one torrent is.
#[derive(Clone, Debug, PartialEq)]
enum Phase {
    Metadata,
    /// The file list is here; waiting for the holder to pick and confirm.
    Ready,
    Downloading,
    Importing,
    Complete,
    Failed(String),
    Stopped,
}

struct Job {
    /// Moves with every add, so a stopped job's task cannot write over the next.
    seq: u64,
    info_hash: String,
    name: String,
    room: String,
    phase: Phase,
    have: u64,
    size: u64,
    peers: u32,
    uploaded: u64,
    /// The file's quota reservation in the blob lane while it downloads.
    reserved: Option<Hash>,
    /// The torrent's id in the session while it is there.
    torrent: Option<usize>,
    /// The blob, once the file is in the lane.
    blob: Option<(Hash, String)>,
    task: Option<tokio::task::AbortHandle>,
    /// Its torrent, reservation and cache directory are gone: only then may
    /// the next START replace it (a phase turns final before teardown runs).
    torn: bool,
    /// The playable files, once the list is here (index, path, size, type).
    files: Vec<Playable>,
    /// The file the confirm step offers first (a library's GET AGAIN names
    /// the one played before), then the one downloading.
    pick: Option<usize>,
    /// Hands the confirmed file to the waiting task.
    confirm: Option<tokio::sync::oneshot::Sender<usize>>,
}

/// What a holder pasted or chose: the client only ever sees it cleaned.
pub enum Added {
    /// A magnet rebuilt from its info hash alone (`clean_magnet`).
    Magnet(String),
    /// A .torrent rebuilt from its `info` dictionary alone (`clean_torrent`).
    Torrent(Vec<u8>),
}

/// One file of a torrent the TV can play.
#[derive(Clone, Debug, PartialEq)]
pub struct Playable {
    pub index: usize,
    pub path: PathBuf,
    pub size: u64,
    pub mime: &'static str,
}

/// How the lane runs: from the environment in the node, by hand in a test.
struct Settings {
    dir: PathBuf,
    max_size: u64,
    /// The session's blocklist is every non-global range (always, outside
    /// tests: a test seeds from loopback).
    block_nonglobal: bool,
    dht: bool,
    bootstrap: Option<Vec<String>>,
    up_kbps: u64,
    down_kbps: Option<u64>,
    metadata_timeout: Duration,
    /// Peers handed to every torrent before any lookup (a test's seeder).
    initial_peers: Vec<std::net::SocketAddr>,
}

impl Settings {
    fn from_env() -> Result<Self> {
        Ok(Self {
            dir: cache_dir()?,
            max_size: env_u64("SSF_TORRENT_MAX_MB").unwrap_or(DEFAULT_MAX_MB).saturating_mul(1024 * 1024),
            block_nonglobal: true,
            dht: !std::env::var("SSF_NO_DHT").is_ok_and(|v| v == "1"),
            bootstrap: std::env::var("SSF_TORRENT_DHT_BOOTSTRAP").ok().map(|v| {
                v.split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect::<Vec<_>>()
            }),
            up_kbps: env_u64("SSF_TORRENT_UP_KBPS").unwrap_or(DEFAULT_UP_KBPS),
            down_kbps: env_u64("SSF_TORRENT_DOWN_KBPS"),
            metadata_timeout: METADATA_TIMEOUT,
            initial_peers: Vec::new(),
        })
    }
}

fn kbps(k: u64) -> Option<NonZeroU32> {
    NonZeroU32::new((k.min(u32::MAX as u64 / 1024) as u32) * 1024)
}

pub struct TorrentLane {
    blobs: Arc<BlobLane>,
    dir: PathBuf,
    max_size: u64,
    settings: Settings,
    session: tokio::sync::OnceCell<Arc<Session>>,
    job: Mutex<Option<Job>>,
    seq: std::sync::atomic::AtomicU64,
}

static LANE: OnceLock<Arc<TorrentLane>> = OnceLock::new();

fn cache_dir() -> Result<PathBuf> {
    Ok(std::env::current_dir()?.join(CACHE_DIR))
}

/// Empty what a previous run left (main, at start).
pub fn wipe_cache() {
    if let Ok(dir) = cache_dir() {
        if dir.exists() {
            if let Err(e) = std::fs::remove_dir_all(&dir) {
                eprintln!("⚠️ torrent-cache/ could not be emptied: {e}");
            }
        }
    }
}

fn env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok().and_then(|v| v.trim().parse::<u64>().ok())
}

impl TorrentLane {
    /// The lane, made on first use beside the blob lane. No socket opens
    /// until a torrent is added: the session itself waits for that.
    fn get(blobs: &Arc<BlobLane>) -> Result<Arc<Self>> {
        if let Some(l) = LANE.get() {
            return Ok(l.clone());
        }
        let lane = Self::with_settings(blobs, Settings::from_env()?);
        Ok(LANE.get_or_init(|| lane).clone())
    }

    fn with_settings(blobs: &Arc<BlobLane>, settings: Settings) -> Arc<Self> {
        Arc::new(Self {
            blobs: blobs.clone(),
            dir: settings.dir.clone(),
            max_size: settings.max_size,
            settings,
            session: tokio::sync::OnceCell::new(),
            job: Mutex::new(None),
            seq: Default::default(),
        })
    }

    async fn session(&self) -> Result<Arc<Session>> {
        self.session
            .get_or_try_init(|| async {
                std::fs::create_dir_all(&self.dir)?;
                // librqbit takes its blocklist as a list to load; it is
                // written here from `nonglobal_ranges`, the one source.
                let set = &self.settings;
                let list_url = if set.block_nonglobal {
                    let list = self.dir.join("not-global-unicast.p2p");
                    std::fs::write(&list, blocklist_text())?;
                    Some(url::Url::from_file_path(&list).map_err(|_| anyhow!("blocklist path"))?.to_string())
                } else {
                    None
                };
                let opts = |ipv4_only: bool| SessionOptions {
                    dht: set.dht.then(|| DhtSessionConfig { bootstrap_addrs: set.bootstrap.clone(), port: None, persistence: None }),
                    ipv4_only,
                    disable_trackers: true,
                    fastresume: false,
                    persistence: None,
                    listen: None,
                    blocklist_url: list_url.clone(),
                    allowlist_url: None,
                    trackers: Default::default(),
                    peer_limit: Some(PEER_LIMIT),
                    disable_local_service_discovery: true,
                    ratelimits: LimitsConfig { upload_bps: kbps(set.up_kbps), download_bps: set.down_kbps.and_then(kbps) },
                    ..Default::default()
                };
                // Dual-stack first; a machine with IPv6 off cannot bind `[::]`,
                // and gets an IPv4-only session rather than none.
                let session = match Session::new_with_opts(self.dir.clone(), opts(false)).await {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("🧲 dual-stack torrent session failed ({e:#}); trying IPv4 only");
                        Session::new_with_opts(self.dir.clone(), opts(true)).await.context("the torrent session did not start")?
                    }
                };
                println!("🧲 Torrent session up (DHT client-only, no trackers, no LSD, no listener)");
                Ok(session)
            })
            .await
            .cloned()
    }

    fn update(&self, seq: u64, f: impl FnOnce(&mut Job)) {
        if let Some(j) = self.job.lock().unwrap().as_mut().filter(|j| j.seq == seq) {
            f(j);
        }
    }

    fn fail(&self, seq: u64, why: String) {
        eprintln!("🧲 torrent: {why}");
        self.update(seq, |j| {
            if !matches!(j.phase, Phase::Complete | Phase::Stopped) {
                j.phase = Phase::Failed(why);
            }
        });
    }

    /// Run one torrent from metadata to a blob. Every step re-checks `seq`, so
    /// a STOP (or the next add) leaves nothing of this one to write.
    async fn run(self: Arc<Self>, seq: u64, added: Added) {
        if let Err(e) = self.clone().run_inner(seq, added).await {
            self.fail(seq, format!("{e:#}"));
        }
        self.cleanup(seq).await;
    }

    async fn run_inner(self: Arc<Self>, seq: u64, added: Added) -> Result<()> {
        let session = self.session().await?;
        let base = || AddTorrentOptions { disable_trackers: true, overwrite: true, ..Default::default() };
        let timeout = self.settings.metadata_timeout;
        // librqbit dials these for the metadata WITHOUT its blocklist (the
        // DHT's own peers are filtered in the fork), so they are filtered here.
        let dialable = |peers: &mut dyn Iterator<Item = std::net::SocketAddr>| -> Option<Vec<std::net::SocketAddr>> {
            let v: Vec<_> = peers.filter(|a| !self.settings.block_nonglobal || librqbit::dht::is_global_unicast(a.ip())).collect();
            (!v.is_empty()).then_some(v)
        };
        let seed_peers = || dialable(&mut self.settings.initial_peers.iter().copied());
        // A .torrent carries its file list, so listing it touches no network;
        // a magnet's list comes from peers.
        let add = match added {
            Added::Magnet(m) => AddTorrent::from_url(m),
            Added::Torrent(t) => AddTorrent::from_bytes(t),
        };
        let listed = tokio::time::timeout(
            timeout,
            session.add_torrent(add, Some(AddTorrentOptions { list_only: true, initial_peers: seed_peers(), ..base() })),
        )
        .await
        .map_err(|_| anyhow!("no peer sent this torrent's file list in {} s", timeout.as_secs()))??;
        let AddTorrentResponse::ListOnly(listed) = listed else {
            return Err(anyhow!("the torrent session answered out of turn"));
        };
        if listed.info.info().private {
            return Err(anyhow!("this is a private torrent: it only works through its own tracker, which this node never contacts"));
        }
        let files: Vec<(PathBuf, u64)> = listed.info.iter_file_details().map(|d| (d.filename.to_pathbuf(), d.len)).collect();
        let playable: Vec<Playable> = playable_files(&files).into_iter().take(MAX_LISTED).collect();
        let Some(best) = pick_file(&files) else {
            return Err(anyhow!("no video or audio file this TV can play (mp4, webm, mkv, mp3…) in this torrent"));
        };
        // LOOK BEFORE YOU DOWNLOAD: the real name, the playable files and
        // their sizes go on the remote, and nothing is fetched until the
        // holder picks one and confirms. A magnet's `dn=` and a library
        // entry's title are anyone's words; this list is the torrent's own.
        let (tx, rx) = tokio::sync::oneshot::channel::<usize>();
        let mut live = false;
        self.update(seq, |j| {
            if j.phase == Phase::Metadata {
                live = true;
                j.phase = Phase::Ready;
                if let Some(n) = listed.info.name() {
                    j.name = clip(&n, MAX_NAME);
                }
                let wanted = j.pick.filter(|w| playable.iter().any(|p| p.index == *w));
                j.pick = Some(wanted.unwrap_or(best.0));
                j.files = playable.clone();
                j.confirm = Some(tx);
            }
        });
        if !live {
            return Ok(());
        }
        let chosen = tokio::time::timeout(CONFIRM_TIMEOUT, rx)
            .await
            .map_err(|_| anyhow!("nobody pressed DOWNLOAD in {} minutes", CONFIRM_TIMEOUT.as_secs() / 60))?
            .map_err(|_| anyhow!("the download was not confirmed"))?;
        let Some(Playable { index, path: rel, size: len, mime }) = playable.iter().find(|p| p.index == chosen).cloned() else {
            return Err(anyhow!("that file is not one this TV can play"));
        };
        if len > self.max_size {
            return Err(anyhow!("{}: {}", rel.display(), self.too_big(len).unwrap_or_default()));
        }
        let Some(reserved) = self.blobs.reserve(len, mime) else {
            return Err(anyhow!("not enough room in this node's blob quota for {} MB", len / (1024 * 1024)));
        };
        let out = self.dir.join(listed.info_hash.as_string());
        let path = out.join(&rel);
        let mut live = false;
        self.update(seq, |j| {
            if j.phase == Phase::Ready {
                live = true;
                j.phase = Phase::Downloading;
                j.size = len;
                j.pick = Some(index);
                j.reserved = Some(reserved);
            }
        });
        if !live {
            // STOPPED meanwhile: give the reservation back.
            self.blobs.unreserve(&reserved);
            return Ok(());
        }
        let added = session
            .add_torrent(
                AddTorrent::from_bytes(listed.torrent_bytes.clone()),
                Some(AddTorrentOptions {
                    only_files: Some(vec![index]),
                    output_folder: Some(out.to_string_lossy().into_owned()),
                    initial_peers: dialable(&mut listed.seen_peers.iter().copied().chain(self.settings.initial_peers.iter().copied())),
                    ..base()
                }),
            )
            .await?;
        let (id, handle) = match added {
            AddTorrentResponse::Added(id, h) | AddTorrentResponse::AlreadyManaged(id, h) => (id, h),
            AddTorrentResponse::ListOnly(_) => return Err(anyhow!("the torrent session answered out of turn")),
        };
        let mut live = false;
        self.update(seq, |j| {
            // Recorded even when STOP came meanwhile, so cleanup removes it.
            j.torrent = Some(id);
            live = j.phase == Phase::Downloading;
        });
        if !live {
            return Ok(());
        }
        let mut last_have = 0u64;
        let mut last_move = tokio::time::Instant::now();
        loop {
            tokio::time::sleep(Duration::from_secs(1)).await;
            let st = handle.stats();
            if let Some(e) = st.error {
                return Err(anyhow!("the torrent failed: {e}"));
            }
            let peers = st.live.as_ref().map(|l| l.snapshot.peer_stats.live).unwrap_or(0);
            self.update(seq, |j| {
                j.have = st.progress_bytes.min(len);
                j.peers = peers;
                j.uploaded = st.uploaded_bytes;
            });
            if st.finished {
                break;
            }
            if st.progress_bytes != last_have {
                last_have = st.progress_bytes;
                last_move = tokio::time::Instant::now();
            } else if last_move.elapsed() > STALL_TIMEOUT {
                return Err(anyhow!("no peer sent anything for {} minutes", STALL_TIMEOUT.as_secs() / 60));
            }
        }
        // Whole: the torrent leaves the session (no seeding past the
        // download), and the file goes into the blob lane.
        drop(handle);
        session.delete(TorrentIdOrHash::Id(id), false).await.ok();
        let mut live = false;
        self.update(seq, |j| {
            j.torrent = None;
            if j.phase == Phase::Downloading {
                live = true;
                j.phase = Phase::Importing;
            }
        });
        if !live {
            return Ok(());
        }
        let got = tokio::fs::metadata(&path).await.with_context(|| format!("{} is not where the torrent wrote it", rel.display()))?.len();
        if got != len {
            return Err(anyhow!("{} is {got} bytes, not the {len} the torrent said", rel.display()));
        }
        let (hash, _kept) = self.blobs.add_file(&path).await?;
        // The bytes are in the store now, so they are charged whatever came
        // meanwhile: the reservation becomes the blob's under the job's lock.
        // A STOP that already gave the reservation back leaves `settle` to
        // charge it afresh; a STOP after this finds no reservation to free.
        // Only a job still importing shows the blob as its result.
        let mut done = false;
        self.update(seq, |j| {
            j.reserved = None;
            self.blobs.settle(reserved, hash, len, j.room.clone(), mime.to_string());
            if j.phase == Phase::Importing {
                done = true;
                j.blob = Some((hash, mime.to_string()));
                j.phase = Phase::Complete;
            }
        });
        if done {
            println!("🧲 torrent {}: {} in the blob lane as {}", listed.info_hash.as_string(), rel.display(), hash.fmt_short());
        }
        Ok(())
    }

    /// Take the job's torrent out of the session and its files off the disk,
    /// and give back a reservation it still holds.
    async fn cleanup(&self, seq: u64) {
        let (torrent, reserved, info_hash) = {
            let mut job = self.job.lock().unwrap();
            match job.as_mut().filter(|j| j.seq == seq) {
                Some(j) => (j.torrent.take(), j.reserved.take(), j.info_hash.clone()),
                None => return,
            }
        };
        if let (Some(id), Some(session)) = (torrent, self.session.get()) {
            session.delete(TorrentIdOrHash::Id(id), true).await.ok();
        }
        if let Some(r) = reserved {
            self.blobs.unreserve(&r);
        }
        let _ = tokio::fs::remove_dir_all(self.dir.join(info_hash)).await;
        self.update(seq, |j| j.torn = true);
    }

    /// START, from this node's page: the pasted magnet, for `room`. The
    /// torrent's id, or the HTTP status and why not.
    /// `pick` is the file the confirm step offers first (a library entry's).
    fn start(self: &Arc<Self>, room: String, pasted: &str, pick: Option<usize>) -> std::result::Result<String, (&'static str, String)> {
        let (magnet, info_hash, name) = clean_magnet(pasted).map_err(|e| ("400 Bad Request", e.to_string()))?;
        self.start_with(room, Added::Magnet(magnet), info_hash, name, pick)
    }

    /// START with a .torrent file's bytes.
    fn start_file(self: &Arc<Self>, room: String, bytes: &[u8], pick: Option<usize>) -> std::result::Result<String, (&'static str, String)> {
        let (clean, info_hash, name) = clean_torrent(bytes).map_err(|e| ("400 Bad Request", e.to_string()))?;
        self.start_with(room, Added::Torrent(clean), info_hash, name, pick)
    }

    fn start_with(
        self: &Arc<Self>,
        room: String,
        added: Added,
        info_hash: String,
        name: String,
        pick: Option<usize>,
    ) -> std::result::Result<String, (&'static str, String)> {
        let seq = self.seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        {
            let mut job = self.job.lock().unwrap();
            if job.as_ref().is_some_and(|j| matches!(j.phase, Phase::Metadata | Phase::Ready | Phase::Downloading | Phase::Importing)) {
                return Err(("409 Conflict", "a torrent is already running on this node — STOP it first".into()));
            }
            if job.as_ref().is_some_and(|j| !j.torn) {
                return Err(("409 Conflict", "the last torrent is still being cleaned up — try again in a moment".into()));
            }
            *job = Some(Job {
                seq, info_hash: info_hash.clone(), name, room, phase: Phase::Metadata,
                have: 0, size: 0, peers: 0, uploaded: 0, reserved: None, torrent: None, blob: None, task: None, torn: false,
                files: Vec::new(), pick, confirm: None,
            });
        }
        let task = tokio::spawn(self.clone().run(seq, added));
        self.update(seq, |j| j.task = Some(task.abort_handle()));
        println!("🧲 torrent {info_hash}: started from this node's page");
        Ok(info_hash)
    }

    /// Why this node would not take a file of `len` bytes now, if it would not.
    fn too_big(&self, len: u64) -> Option<String> {
        if len > self.max_size {
            return Some(format!("that file is {} MB, over this node's {} MB torrent cap (SSF_TORRENT_MAX_MB)", len / (1024 * 1024), self.max_size / (1024 * 1024)));
        }
        (!self.blobs.fits(len)).then(|| format!("not enough room in this node's blob quota for {} MB", len.div_ceil(1024 * 1024)))
    }

    /// DOWNLOAD: the holder confirms `file` from the list. Why not, if not:
    /// a file too big for this node leaves the list waiting for another pick.
    fn confirm(&self, file: usize) -> std::result::Result<(), String> {
        let mut job = self.job.lock().unwrap();
        let Some(j) = job.as_mut().filter(|j| j.phase == Phase::Ready) else {
            return Err("there is no file list waiting for DOWNLOAD".into());
        };
        let Some(size) = j.files.iter().find(|p| p.index == file).map(|p| p.size) else {
            return Err("that file is not one this TV can play".into());
        };
        if let Some(why) = self.too_big(size) {
            return Err(why);
        }
        let tx = j.confirm.take().ok_or("that list was already confirmed")?;
        j.pick = Some(file);
        tx.send(file).map_err(|_| "the torrent is no longer waiting".into())
    }

    /// STOP: end a running torrent and take everything of it off the disk.
    async fn stop(&self) {
        let seq = {
            let mut job = self.job.lock().unwrap();
            match job.as_mut() {
                // While the file goes into the store the task is left to
                // finish: aborted there, bytes could land with no charge. It
                // sees the STOP, charges what it stored, and tears down.
                Some(j) if j.phase == Phase::Importing => {
                    j.phase = Phase::Stopped;
                    None
                }
                Some(j) if matches!(j.phase, Phase::Metadata | Phase::Ready | Phase::Downloading) => {
                    j.phase = Phase::Stopped;
                    if let Some(t) = j.task.take() {
                        t.abort();
                    }
                    Some(j.seq)
                }
                _ => None,
            }
        };
        if let Some(seq) = seq {
            self.cleanup(seq).await;
        }
        println!("🧲 torrent stopped from this node's page");
    }

    fn status_json(&self) -> String {
        let job = self.job.lock().unwrap();
        let Some(j) = job.as_ref() else {
            return r#"{"state":"none"}"#.to_string();
        };
        let (state, why) = match &j.phase {
            Phase::Metadata => ("metadata", ""),
            Phase::Ready => ("ready", ""),
            Phase::Downloading => ("downloading", ""),
            Phase::Importing => ("importing", ""),
            Phase::Complete => ("complete", ""),
            Phase::Failed(w) => ("failed", w.as_str()),
            Phase::Stopped => ("stopped", ""),
        };
        serde_json::json!({
            "state": state, "why": why, "id": j.info_hash, "name": j.name, "room": j.room,
            "have": j.have, "size": j.size, "peers": j.peers, "uploaded": j.uploaded,
            "hash": j.blob.as_ref().map(|b| b.0.to_hex().to_string()),
            "mime": j.blob.as_ref().map(|b| b.1.clone()),
            "pick": j.pick,
            "files": j.files.iter().map(|f| serde_json::json!({
                "index": f.index, "name": clip(&f.path.to_string_lossy(), MAX_NAME), "size": f.size,
                "fits": j.phase != Phase::Ready || self.too_big(f.size).is_none(),
            })).collect::<Vec<_>>(),
        })
        .to_string()
    }
}

/// The magnet as the client sees it: its v1 info hash and nothing else, so no
/// tracker, web seed or peer address a paste carried reaches the swarm code.
/// Also answers the `dn=` name, for the screen only.
pub fn clean_magnet(pasted: &str) -> Result<(String, String, String)> {
    let pasted = pasted.trim();
    if !pasted.starts_with("magnet:?") {
        return Err(anyhow!("that is not a magnet link (it should start with magnet:?)"));
    }
    let m = Magnet::parse(pasted).map_err(|e| anyhow!("that magnet link did not parse: {e}"))?;
    let id = m.as_id20().ok_or_else(|| anyhow!("that magnet has no v1 (btih) info hash"))?.as_string();
    let name = clip(m.name.as_deref().unwrap_or(""), MAX_NAME);
    Ok((format!("magnet:?xt=urn:btih:{id}"), id, name))
}

/// A .torrent as the client sees it: its `info` dictionary and nothing else,
/// so no `announce`, `announce-list`, web seed (`url-list`) or comment the
/// file carried reaches the swarm code. Also answers its v1 info hash (the
/// hash of exactly those bytes, so unchanged) and name.
pub fn clean_torrent(bytes: &[u8]) -> Result<(Vec<u8>, String, String)> {
    if bytes.len() > MAX_TORRENT_FILE {
        return Err(anyhow!("that .torrent file is over {} MB", MAX_TORRENT_FILE / (1024 * 1024)));
    }
    let t = librqbit::torrent_from_bytes(bytes).map_err(|e| anyhow!("that is not a .torrent file this node can read: {e}"))?;
    if t.info.data.private {
        return Err(anyhow!("this is a private torrent: it only works through its own tracker, which this node never contacts"));
    }
    let raw: &[u8] = t.info.raw_bytes.as_ref();
    let mut clean = Vec::with_capacity(raw.len() + 8);
    clean.extend_from_slice(b"d4:info");
    clean.extend_from_slice(raw);
    clean.push(b'e');
    let name = t.info.data.name.as_ref().map(|n| String::from_utf8_lossy(n.as_ref()).into_owned()).unwrap_or_default();
    Ok((clean, t.info_hash.as_string(), clip(&name, MAX_NAME)))
}

fn clip(s: &str, n: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(n).collect()
}

/// What the TV plays, best first: mp4/webm (what every webview plays), then
/// other video, then audio.
const TIERS: [&[(&str, &str)]; 3] = [
    &[("mp4", "video/mp4"), ("m4v", "video/mp4"), ("webm", "video/webm")],
    &[("mkv", "video/x-matroska"), ("mov", "video/quicktime"), ("ogv", "video/ogg")],
    &[("mp3", "audio/mpeg"), ("m4a", "audio/mp4"), ("ogg", "audio/ogg"), ("opus", "audio/ogg"), ("flac", "audio/flac"), ("wav", "audio/wav")],
];

fn playable_tier(p: &std::path::Path) -> Option<(usize, &'static str)> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    TIERS.iter().enumerate().find_map(|(t, tier)| tier.iter().find(|(e, _)| *e == ext).map(|(_, m)| (t, *m)))
}

/// Every file of a torrent the TV can play, in the torrent's order. A path
/// that is not a plain relative one, or an empty file, is never listed.
pub fn playable_files(files: &[(PathBuf, u64)]) -> Vec<Playable> {
    files
        .iter()
        .enumerate()
        .filter(|(_, (p, len))| *len > 0 && !p.as_os_str().is_empty() && p.components().all(|c| matches!(c, Component::Normal(_))))
        .filter_map(|(index, (p, len))| playable_tier(p).map(|(_, mime)| Playable { index, path: p.clone(), size: *len, mime }))
        .collect()
}

/// The file the confirm step offers first: the largest of the best tier.
/// Its index, path inside the torrent, length and MIME type.
pub fn pick_file(files: &[(PathBuf, u64)]) -> Option<(usize, PathBuf, u64, &'static str)> {
    playable_files(files)
        .into_iter()
        .max_by_key(|p| (std::cmp::Reverse(playable_tier(&p.path).map(|t| t.0).unwrap_or(9)), p.size))
        .map(|p| (p.index, p.path, p.size, p.mime))
}

/// Every address range that is not global unicast, as the session's
/// blocklist: the same classes `librqbit::dht::is_global_unicast` refuses
/// (vendor/librqbit-dht), and all of IPv4-mapped space besides (a v4 peer
/// arrives as v4). Inclusive ranges.
pub fn nonglobal_ranges() -> (Vec<RangeInclusive<Ipv4Addr>>, Vec<RangeInclusive<Ipv6Addr>>) {
    fn v4(a: [u8; 4], prefix: u32) -> RangeInclusive<Ipv4Addr> {
        let start = u32::from_be_bytes(a);
        let span = if prefix == 0 { u32::MAX } else { (1u32 << (32 - prefix)) - 1 };
        Ipv4Addr::from(start)..=Ipv4Addr::from(start | span)
    }
    fn v6(a: &str, prefix: u32) -> RangeInclusive<Ipv6Addr> {
        let start = u128::from(a.parse::<Ipv6Addr>().unwrap());
        let span = if prefix == 0 { u128::MAX } else { (1u128 << (128 - prefix)) - 1 };
        Ipv6Addr::from(start)..=Ipv6Addr::from(start | span)
    }
    let v4s = vec![
        v4([0, 0, 0, 0], 8),
        v4([10, 0, 0, 0], 8),
        v4([100, 64, 0, 0], 10),
        v4([127, 0, 0, 0], 8),
        v4([169, 254, 0, 0], 16),
        v4([172, 16, 0, 0], 12),
        v4([192, 0, 0, 0], 24),
        v4([192, 0, 2, 0], 24),
        v4([192, 88, 99, 0], 24),
        v4([192, 168, 0, 0], 16),
        v4([198, 18, 0, 0], 15),
        v4([198, 51, 100, 0], 24),
        v4([203, 0, 113, 0], 24),
        v4([224, 0, 0, 0], 3), // 224.0.0.0 – 255.255.255.255
    ];
    let v6s = vec![
        v6("::", 3),     // below 2000::/3: ::, ::1, mapped, NAT64, …
        v6("4000::", 2), // 4000:: – 7fff:…
        v6("8000::", 1), // 8000:: – ffff:… (ULA, link-local, multicast among them)
        v6("2001::", 23),
        v6("2001:db8::", 32),
        v6("2002::", 16),
        v6("3fff::", 20),
    ];
    (v4s, v6s)
}

/// The blocklist in the P2P text format librqbit loads (`name:first-last`).
fn blocklist_text() -> String {
    let (v4s, v6s) = nonglobal_ranges();
    let mut out = String::from("# ssf-p2p-node: every range that is not global unicast (torrent_lane.rs)\n");
    for r in v4s {
        out.push_str(&format!("not-global:{}-{}\n", r.start(), r.end()));
    }
    for r in v6s {
        out.push_str(&format!("not-global:{}-{}\n", r.start(), r.end()));
    }
    out
}

/// Answer one of the lane's routes, behind the blob lane's gate.
pub async fn handle_http(
    blobs: Option<Arc<BlobLane>>,
    socket: &mut tokio::net::TcpStream,
    head: Head,
    body_start: &[u8],
    origin_ok: bool,
    cors: &str,
) {
    let Some(blobs) = blobs else {
        return reply(socket, "503 Service Unavailable", cors, &err_json("the blob lane is not running on this node")).await;
    };
    let cap_ok = head.query.get("cap").is_some_and(|c| constant_time_eq(c.as_bytes(), blobs.cap.as_bytes()));
    if !origin_ok || !cap_ok {
        return reply(socket, "403 Forbidden", cors, &err_json("not this node's page")).await;
    }
    let lane = match TorrentLane::get(&blobs) {
        Ok(l) => l,
        Err(e) => return reply(socket, "503 Service Unavailable", cors, &err_json(&format!("the torrent lane is off: {e}"))).await,
    };
    match (head.method.as_str(), head.path.as_str()) {
        ("POST", "/api/torrent/add") => {
            let room = head.query.get("room").cloned().unwrap_or_default();
            if !valid_room(&room) {
                return reply(socket, "400 Bad Request", cors, &err_json("no room")).await;
            }
            // The body is a pasted magnet, or with `kind=torrent` a .torrent
            // file's bytes. `file` names the one the confirm step offers first.
            let as_file = head.query.get("kind").is_some_and(|k| k == "torrent");
            let pick = head.query.get("file").and_then(|f| f.parse::<usize>().ok());
            let (max, what) = if as_file { (MAX_TORRENT_FILE, "a .torrent file over 4 MB") } else { (MAX_MAGNET, "paste one magnet link") };
            let Some(len) = head.headers.get("content-length").and_then(|v| v.parse::<usize>().ok()).filter(|l| *l > 0 && *l <= max) else {
                return reply(socket, "413 Payload Too Large", cors, &err_json(what)).await;
            };
            let mut body = body_start[..body_start.len().min(len)].to_vec();
            while body.len() < len {
                let mut buf = vec![0u8; (len - body.len()).min(64 * 1024)];
                match tokio::time::timeout(Duration::from_secs(10), socket.read(&mut buf)).await {
                    Ok(Ok(n)) if n > 0 => body.extend_from_slice(&buf[..n]),
                    _ => return reply(socket, "400 Bad Request", cors, &err_json("the upload ended early")).await,
                }
            }
            let started = if as_file { lane.start_file(room, &body, pick) } else { lane.start(room, &String::from_utf8_lossy(&body), pick) };
            match started {
                Ok(id) => reply(socket, "202 Accepted", cors, &serde_json::json!({ "ok": true, "id": id }).to_string()).await,
                Err((status, why)) => reply(socket, status, cors, &err_json(&why)).await,
            }
        }
        ("POST", "/api/torrent/confirm") => {
            let Some(file) = head.query.get("file").and_then(|f| f.parse::<usize>().ok()) else {
                return reply(socket, "400 Bad Request", cors, &err_json("no file named")).await;
            };
            match lane.confirm(file) {
                Ok(()) => reply(socket, "200 OK", cors, &serde_json::json!({ "ok": true }).to_string()).await,
                Err(why) => reply(socket, "409 Conflict", cors, &err_json(&why)).await,
            }
        }
        ("GET", "/api/torrent/status") => {
            let body = lane.status_json();
            reply(socket, "200 OK", cors, &body).await;
        }
        ("POST", "/api/torrent/stop") => {
            lane.stop().await;
            reply(socket, "200 OK", cors, &serde_json::json!({ "ok": true }).to_string()).await;
        }
        _ => reply(socket, "404 Not Found", cors, &err_json("no such route")).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blocked(ip: IpAddr) -> bool {
        let (v4s, v6s) = nonglobal_ranges();
        match ip {
            IpAddr::V4(a) => v4s.iter().any(|r| r.contains(&a)),
            IpAddr::V6(a) => v6s.iter().any(|r| r.contains(&a)),
        }
    }

    /// A lane fed by a seeder on this machine: `block_nonglobal` off (the
    /// seeder is on loopback), no DHT, the seeder handed in as a peer.
    struct Seeded {
        lane: Arc<TorrentLane>,
        blobs: Arc<BlobLane>,
        id: String,
        video: Vec<u8>,
        torrent: Vec<u8>,
        peer: std::net::SocketAddr,
        _seeder: Arc<Session>,
    }

    async fn lane_with_seeder(tmp: &std::path::Path, block_nonglobal: bool, quota: u64) -> Seeded {
        // The seeder: its own session, listening on loopback, holding a
        // complete two-file torrent (a video and a text file).
        let src = tmp.join("seed/Clip");
        std::fs::create_dir_all(&src).unwrap();
        let video: Vec<u8> = (0..300_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
        std::fs::write(src.join("clip.webm"), &video).unwrap();
        std::fs::write(src.join("readme.txt"), b"openly licensed test clip").unwrap();
        let made = librqbit::create_torrent(&src, librqbit::CreateTorrentOptions { name: Some("Clip"), trackers: vec![], piece_length: Some(16 * 1024) }, &librqbit::spawn_utils::BlockingSpawner::new(2))
            .await
            .unwrap();
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let seeder = Session::new_with_opts(
            tmp.join("seed"),
            SessionOptions {
                dht: None,
                disable_trackers: true,
                disable_local_service_discovery: true,
                ipv4_only: true,
                listen: Some(librqbit::ListenerOptions {
                    mode: librqbit::ListenerMode::TcpOnly,
                    listen_addr: ([127, 0, 0, 1], port).into(),
                    ipv4_only: true,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        seeder
            .add_torrent(
                AddTorrent::from_bytes(made.as_bytes().unwrap()),
                Some(AddTorrentOptions { output_folder: Some(src.to_string_lossy().into_owned()), overwrite: true, disable_trackers: true, ..Default::default() }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap()
            .wait_until_completed()
            .await
            .unwrap();
        let blobs = BlobLane::open_at(tmp.join("blob-cache"), quota).await.unwrap();
        let lane = TorrentLane::with_settings(&blobs, Settings {
            dir: tmp.join("torrent-cache"),
            max_size: 64 * 1024 * 1024,
            block_nonglobal,
            dht: false,
            bootstrap: None,
            up_kbps: 256,
            down_kbps: None,
            metadata_timeout: Duration::from_secs(if block_nonglobal { 8 } else { 60 }),
            initial_peers: vec![([127, 0, 0, 1], port).into()],
        });
        Seeded {
            lane, blobs, id: made.info_hash().as_string(), video, torrent: made.as_bytes().unwrap().to_vec(),
            peer: ([127, 0, 0, 1], port).into(), _seeder: seeder,
        }
    }

    /// A directory of the test's own, gone when the test ends.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(name: &str) -> Self {
            let d = std::env::temp_dir().join(format!("ssf-torrent-test-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn wait_for(lane: &TorrentLane, done: impl Fn(&serde_json::Value) -> bool) -> serde_json::Value {
        for _ in 0..600 {
            let st: serde_json::Value = serde_json::from_str(&lane.status_json()).unwrap();
            if done(&st) {
                return st;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("the torrent never got there: {}", lane.status_json());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_pasted_magnet_lands_in_the_blob_lane() {
        let tmp = TempDir::new("a_pasted_magnet_lands_in_the_blob_lane");
        let Seeded { lane, blobs, id, video, _seeder: _keep, .. } = lane_with_seeder(tmp.0.as_path(), false, 64 * 1024 * 1024).await;
        // Trackers and peer hints in the paste are dropped; the hash is all.
        let pasted = format!("magnet:?xt=urn:btih:{id}&dn=Clip&tr=udp%3A%2F%2F10.0.0.1%3A6969&x.pe=10.0.0.2:6881");
        assert_eq!(lane.start("room-1".into(), &pasted, None).unwrap(), id);
        assert_eq!(lane.start("room-1".into(), &pasted, None).unwrap_err().0, "409 Conflict");
        // LOOK BEFORE YOU DOWNLOAD: the list waits, nothing is fetched.
        let st = wait_for(&lane, |s| s["state"] != "metadata").await;
        assert_eq!(st["state"], "ready", "{st}");
        assert_eq!(st["name"], "Clip");
        assert_eq!(st["files"].as_array().unwrap().len(), 1, "only the playable file is listed: {st}");
        let pick = st["pick"].as_u64().unwrap() as usize;
        assert_eq!(st["files"][0]["index"], pick as u64);
        assert_eq!(st["files"][0]["size"], video.len() as u64);
        assert_eq!(st["files"][0]["fits"], true);
        assert!(st["files"][0]["name"].as_str().unwrap().ends_with("clip.webm"));
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(lane.status_json().contains(r#""state":"ready""#), true);
        assert_eq!(st["have"], 0);
        assert!(lane.confirm(pick + 1).is_err(), "the text file is not one to confirm");
        lane.confirm(pick).unwrap();
        assert!(lane.confirm(pick).is_err(), "confirmed twice");
        let st = wait_for(&lane, |s| matches!(s["state"].as_str(), Some("complete" | "failed"))).await;
        assert_eq!(st["state"], "complete", "{st}");
        assert_eq!(st["size"], video.len() as u64);
        assert_eq!(st["mime"], "video/webm");
        assert_eq!(st["room"], "room-1");
        // The blob is the clip, byte for byte, held for the room it came for.
        let hash = <Hash as std::str::FromStr>::from_str(st["hash"].as_str().unwrap()).unwrap();
        assert_eq!(hash, Hash::new(&video));
        assert!(blobs.status_json(&hash).contains(r#""state":"complete""#));
        // Nothing of the torrent is left in its cache, or in the session.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(!tmp.0.as_path().join("torrent-cache").join(&id).exists());
        assert!(lane.session.get().unwrap().with_torrents(|t| t.count()) == 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_loopback_seeder_is_refused_and_stop_cleans_up() {
        let tmp = TempDir::new("a_loopback_seeder_is_refused_and_stop_cleans_up");
        // The real blocklist: the seeder on 127.0.0.1 is never dialled.
        let Seeded { lane, id, torrent, peer, _seeder: _keep, .. } = lane_with_seeder(tmp.0.as_path(), true, 64 * 1024 * 1024).await;
        lane.start("room-1".into(), &format!("magnet:?xt=urn:btih:{id}"), None).unwrap();
        let st = wait_for(&lane, |s| s["state"] != "metadata").await;
        assert_eq!(st["state"], "failed", "{st}");
        assert_eq!(st["size"], 0, "the file list came from a loopback peer: {st}");
        // A new paste after a failure runs (once the failed one is torn
        // down); STOP ends it.
        wait_for(&lane, |_| lane.job.lock().unwrap().as_ref().is_some_and(|j| j.torn)).await;
        lane.start("room-1".into(), &format!("magnet:?xt=urn:btih:{id}"), None).unwrap();
        lane.stop().await;
        // With no dialable peer it may have failed on its own first; either
        // way it ends torn down.
        let st = wait_for(&lane, |_| lane.job.lock().unwrap().as_ref().is_some_and(|j| j.torn)).await;
        assert!(matches!(st["state"].as_str(), Some("stopped" | "failed")), "{st}");
        // And the session's blocklist holds for piece dials: handed the whole
        // .torrent and the seeder's address, it still takes nothing from it.
        let session = lane.session().await.unwrap();
        let h = session
            .add_torrent(
                AddTorrent::from_bytes(torrent),
                Some(AddTorrentOptions { initial_peers: Some(vec![peer]), output_folder: Some(tmp.0.join("direct").to_string_lossy().into_owned()), ..Default::default() }),
            )
            .await
            .unwrap()
            .into_handle()
            .unwrap();
        tokio::time::sleep(Duration::from_secs(3)).await;
        assert_eq!(h.stats().progress_bytes, 0, "a loopback peer was dialled for pieces");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_file_over_the_quota_is_refused_before_download() {
        let tmp = TempDir::new("a_file_over_the_quota_is_refused_before_download");
        let Seeded { lane, id, _seeder: _keep, .. } = lane_with_seeder(tmp.0.as_path(), false, 100_000).await;
        lane.start("room-1".into(), &format!("magnet:?xt=urn:btih:{id}"), None).unwrap();
        let st = wait_for(&lane, |s| s["state"] != "metadata").await;
        assert_eq!(st["state"], "ready", "{st}");
        // The list says it will not fit, DOWNLOAD says why, and the list
        // stays for another pick (or STOP).
        assert_eq!(st["files"][0]["fits"], false, "{st}");
        let why = lane.confirm(st["pick"].as_u64().unwrap() as usize).unwrap_err();
        assert!(why.contains("blob quota"), "{why}");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&lane.status_json()).unwrap()["state"], "ready");
        lane.stop().await;
        assert_eq!(serde_json::from_str::<serde_json::Value>(&lane.status_json()).unwrap()["state"], "stopped");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_torrent_file_lands_with_its_trackers_dropped() {
        let tmp = TempDir::new("a_torrent_file_lands_with_its_trackers_dropped");
        let Seeded { lane, id, video, torrent, _seeder: _keep, .. } = lane_with_seeder(tmp.0.as_path(), false, 64 * 1024 * 1024).await;
        // The file as a holder might have it: announce lists and a web seed.
        let carried = with_trackers(&torrent);
        assert_eq!(librqbit::torrent_from_bytes(&carried).unwrap().info_hash.as_string(), id);
        let (clean, hash, name) = clean_torrent(&carried).unwrap();
        assert_eq!((hash.as_str(), name.as_str()), (id.as_str(), "Clip"));
        let cleaned = librqbit::torrent_from_bytes(&clean).unwrap();
        assert_eq!(cleaned.info_hash.as_string(), id);
        assert!(cleaned.announce.is_none() && cleaned.announce_list.is_empty());
        assert!(!String::from_utf8_lossy(&clean).contains("tracker.example") && !String::from_utf8_lossy(&clean).contains("seed.example"));
        // A preselected file that is not playable falls back to the best one.
        assert_eq!(lane.start_file("room-1".into(), &carried, Some(99)).unwrap(), id);
        let st = wait_for(&lane, |s| s["state"] != "metadata").await;
        assert_eq!(st["state"], "ready", "{st}");
        let pick = st["pick"].as_u64().unwrap() as usize;
        assert_eq!(st["files"][0]["index"], pick as u64);
        lane.confirm(pick).unwrap();
        let st = wait_for(&lane, |s| matches!(s["state"].as_str(), Some("complete" | "failed"))).await;
        assert_eq!(st["state"], "complete", "{st}");
        assert_eq!(st["hash"].as_str().unwrap(), Hash::new(&video).to_hex().to_string());
    }

    /// `torrent`'s info with an announce, an announce-list, a comment and a
    /// url-list around it, keys in bencode's sorted order.
    fn with_trackers(torrent: &[u8]) -> Vec<u8> {
        let t = librqbit::torrent_from_bytes(torrent).unwrap();
        let s = |v: &str| format!("{}:{v}", v.len());
        let tr = s("udp://tracker.example:6969/announce");
        let mut out = format!("d{}{tr}{}ll{tr}ee{}{}4:info", s("announce"), s("announce-list"), s("comment"), s("from tracker.example")).into_bytes();
        out.extend_from_slice(t.info.raw_bytes.as_ref());
        out.extend_from_slice(format!("{}l{}ee", s("url-list"), s("https://seed.example/clip/")).as_bytes());
        out
    }

    #[test]
    fn a_torrent_file_is_read_with_care() {
        assert!(clean_torrent(b"not bencode").is_err());
        assert!(clean_torrent(&vec![b'd'; MAX_TORRENT_FILE + 1]).unwrap_err().to_string().contains("over 4 MB"));
        // A private torrent is refused before anything runs.
        let info = b"d6:lengthi5e4:name5:a.mp412:piece lengthi16384e6:pieces20:aaaaaaaaaaaaaaaaaaaa7:privatei1ee";
        let mut t = b"d4:info".to_vec();
        t.extend_from_slice(info);
        t.push(b'e');
        assert!(clean_torrent(&t).unwrap_err().to_string().contains("private"));
    }

    #[test]
    fn the_confirm_step_lists_only_playable_files() {
        let f = |v: &[(&str, u64)]| v.iter().map(|(p, l)| (PathBuf::from(p), *l)).collect::<Vec<_>>();
        let listed = playable_files(&f(&[("S/a.srt", 9), ("S/ep1.mkv", 5), ("S/../x.mp4", 5), ("S/ep2.mp4", 7), ("S/cover.jpg", 3), ("S/ep3.webm", 0)]));
        assert_eq!(listed.iter().map(|p| (p.index, p.mime)).collect::<Vec<_>>(), vec![(1, "video/x-matroska"), (3, "video/mp4")]);
    }

    #[test]
    fn a_magnet_keeps_only_its_hash() {
        let (m, id, name) = clean_magnet(
            " magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=udp%3A%2F%2Fexplodie.org%3A6969&ws=https%3A%2F%2Fexample.com%2F&x.pe=10.0.0.1:6881 ",
        )
        .unwrap();
        assert_eq!(m, "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10");
        assert_eq!(id, "08ada5a7a6183aae1e09d831df6748d566095a10");
        assert_eq!(name, "Sintel");
        assert!(clean_magnet("https://example.com/a.torrent").is_err());
        assert!(clean_magnet("magnet:?dn=nothing").is_err());
    }

    #[test]
    fn the_file_picked_is_one_a_webview_plays() {
        let f = |v: &[(&str, u64)]| v.iter().map(|(p, l)| (PathBuf::from(p), *l)).collect::<Vec<_>>();
        let files = f(&[("Sintel/Sintel.en.srt", 1_000), ("Sintel/poster.jpg", 50_000), ("Sintel/Sintel.mp4", 129_000_000), ("Sintel/Sintel.mkv", 900_000_000)]);
        let (i, p, len, mime) = pick_file(&files).unwrap();
        assert_eq!((i, len, mime), (2, 129_000_000, "video/mp4"));
        assert_eq!(p, PathBuf::from("Sintel/Sintel.mp4"));
        assert_eq!(pick_file(&f(&[("a.MKV", 5), ("b.mp3", 9)])).unwrap().3, "video/x-matroska");
        assert_eq!(pick_file(&f(&[("a.flac", 5), ("cover.png", 9)])).unwrap().3, "audio/flac");
        assert!(pick_file(&f(&[("../escape.mp4", 5), ("/abs.mp4", 5), ("empty.mp4", 0), ("notes.txt", 9)])).is_none());
    }

    #[test]
    fn the_blocklist_is_everything_not_global() {
        use librqbit::dht::is_global_unicast;
        let probes = [
            "0.0.0.0", "1.1.1.1", "9.255.255.255", "10.0.0.1", "11.0.0.1", "100.63.255.255", "100.64.0.0",
            "100.127.255.255", "100.128.0.0", "127.0.0.1", "169.254.169.254", "172.15.255.255", "172.16.0.1",
            "172.31.255.255", "172.32.0.0", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.255.255",
            "198.17.255.255", "198.18.0.0", "198.19.255.255", "198.20.0.0", "203.0.113.1", "223.255.255.255",
            "224.0.0.1", "255.255.255.255", "::", "::1", "64:ff9b::a9fe:a9fe", "1fff:ffff::1", "2000::1",
            "2001:0:1::1", "2001:200::1", "2001:db8::1", "2002::1", "2606:4700::1111", "3ffe::1", "3fff::1",
            "3fff:1000::1", "4000::1", "fc00::1", "fe80::1", "ff02::1",
        ];
        for p in probes {
            let ip: IpAddr = p.parse().unwrap();
            assert_eq!(blocked(ip), !is_global_unicast(ip), "{p}");
        }
        // Mapped space is blocked whole: a v4 peer arrives as v4.
        assert!(blocked("::ffff:1.1.1.1".parse().unwrap()));
        let text = blocklist_text();
        assert!(text.contains("not-global:10.0.0.0-10.255.255.255\n"));
        assert!(text.contains("not-global:224.0.0.0-255.255.255.255\n"));
        assert!(text.contains("not-global:8000::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff\n"));
    }
}
