//! The P1 WATCHER (#231): the symmetric trigger, the block beat and the hold
//! window — what turns "a record exists on chain" into "two nodes behind NATs
//! link", with zero new spends and no live infrastructure.
//!
//! Every node that holds a room key (any room the local browser opened that is
//! not public space, N8/D6) polls that room's hints on the BLOCK BEAT: a read
//! happens when the chain's peak crosses a multiple of `SSF_CHIA_BEAT_BLOCKS`
//! (default 32 blocks ≈ 10 min), four times less often while the room already
//! has a peer. Both sides therefore read within the same ~10 min window after a
//! new record confirms, and both dial — the SYMMETRIC TRIGGER: the host dials
//! the joiner back, so whichever side's NAT is the kinder one carries the link.
//!
//! Each unknown node id with public addresses gets a HOLD: a dial repeated every
//! `HOLD_PERIOD` for `HOLD_WINDOW` (15 s × 180 s), which rides out the other
//! side's own hold starting a few beats later and keeps both sides' NAT pinholes
//! warm. A hold that fails puts the target in a cooldown; a fresh own record
//! confirming on chain (the peer will see US at its next beat) clears the
//! room's cooldowns so the dance restarts in step.
//!
//! N5′ (#231 first follow-up): cached addresses are re-dialed first; the chain
//! is read only on the beat. `SSF_CHIA_WATCH=0` turns the watcher off.
//!
//! #231 P6a: the same beat and hold now serve the PER-NODE presence records
//! (record v2): every peer whose contact card sits in `peers.json` has its own
//! hints (this era and the last) read on the beat, and its freshest record is
//! planned into holds in the private rooms it was met in. Our own record is
//! read too, so seeing it confirm restarts the dance exactly as a room record
//! did. The watcher also publishes the chain peak it saw (`hub.chia_peak`:
//! height and read time as one snapshot), the era clock for the inbound marks
//! and the presence publisher.
//!
//! Pure pieces ([`BeatSchedule`], [`plan_holds`]) are unit-tested; the loop
//! itself is thin glue over them, the reader and `main::hold_dial`.
#![cfg(feature = "chia-read")]

use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chia_protocol::Bytes32;
use chia_sdk_coinset::CoinsetClient;

use crate::chia_lane::{self, ChiaPresenceRecord};
use crate::chia_resolve::{self, FoundRecord, HintCursor};

/// Blocks per beat: reads align to peak heights that are multiples of this.
/// 32 blocks ≈ 10 min at testnet11's ~18.75 s block time. `SSF_CHIA_BEAT_BLOCKS`.
pub const DEFAULT_BEAT_BLOCKS: u32 = 32;
/// A room that already has a peer reads this many times less often.
pub const CONNECTED_BEAT_MULTIPLIER: u32 = 4;
/// How often the loop wakes to check the beat and the cache (seconds).
pub const WATCH_TICK_SECS: u64 = 60;
/// Hold window: one dial attempt every `HOLD_PERIOD` for `HOLD_WINDOW`.
pub const HOLD_PERIOD: Duration = Duration::from_secs(15);
pub const HOLD_WINDOW: Duration = Duration::from_secs(180);
/// Concurrent holds per room (each is a dial task with open sockets).
pub const MAX_HOLDS_PER_ROOM: usize = 4;
/// A target whose hold failed is left alone this long (per room).
pub const TARGET_COOLDOWN: Duration = Duration::from_secs(10 * 60);
/// Distinct contact keys read per watcher tick, at most (two hint scans each).
/// The address book holds up to `MAX_PEERS` (512) peers — a private-room member
/// can leave one card per node identity it cycles through — so the gateway load
/// per tick is bounded here, well below the book's cap, and the keys take turns
/// through the whole book, the longest-waiting first.
pub const MAX_CK_READS_PER_TICK: usize = 8;

/// The block beat: when does a room read its hints?
#[derive(Debug, Default)]
pub struct BeatSchedule {
    beat_blocks: u32,
    /// Peak height at the last read, per room.
    last_read: HashMap<String, u32>,
}

impl BeatSchedule {
    pub fn new(beat_blocks: u32) -> Self {
        Self { beat_blocks: beat_blocks.max(1), last_read: HashMap::new() }
    }

    /// Blocks per beat from `SSF_CHIA_BEAT_BLOCKS`, else the default.
    pub fn from_env() -> Self {
        let blocks = std::env::var("SSF_CHIA_BEAT_BLOCKS")
            .ok()
            .and_then(|s| s.trim().parse::<u32>().ok())
            .filter(|b| *b > 0)
            .unwrap_or(DEFAULT_BEAT_BLOCKS);
        Self::new(blocks)
    }

    /// A read is due the first time a room is seen and whenever the peak has
    /// crossed into a new beat since the room's last read. A connected room's
    /// beats are `CONNECTED_BEAT_MULTIPLIER` times longer. Records the read.
    pub fn due(&mut self, room: &str, peak_height: u32, connected: bool) -> bool {
        let stride = self.beat_blocks * if connected { CONNECTED_BEAT_MULTIPLIER } else { 1 };
        let due = match self.last_read.get(room) {
            None => true,
            Some(&last) => peak_height > last && peak_height / stride != last / stride,
        };
        if due {
            self.last_read.insert(room.to_string(), peak_height);
        }
        due
    }

    pub fn forget(&mut self, room: &str) {
        self.last_read.remove(room);
    }

    /// Peak height at the last read of `key`, if it was ever read.
    pub fn last_read_of(&self, key: &str) -> Option<u32> {
        self.last_read.get(key).copied()
    }

    /// Drop every schedule entry `gone` says is gone (P6a: peers that left the
    /// address book, keyed `ck:<contact key hex>`).
    pub fn forget_where(&mut self, gone: impl Fn(&str) -> bool) {
        self.last_read.retain(|key, _| !gone(key));
    }
}

/// One hold to start: a node id and the public addresses to dial it at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoldCandidate {
    pub node_id: String,
    pub addrs: Vec<SocketAddr>,
}

/// What the planner knows about a room right now.
pub struct PlanContext<'a> {
    pub self_id: &'a str,
    /// Node ids already connected in this room.
    pub connected: &'a HashSet<String>,
    /// Node ids with a dial in flight (any path).
    pub dialing: &'a HashSet<String>,
    /// Node id -> instant its cooldown ends (this room).
    pub cooldown_until: &'a HashMap<String, Instant>,
    /// Holds currently running for this room.
    pub active_holds: usize,
    pub now_unix: u64,
    pub now: Instant,
}

/// The symmetric trigger's decision: which records in `records` (one per node,
/// freshest first) deserve a hold right now. Skips ourselves, connected peers,
/// in-flight dials, cooled-down targets, expired records and records with no
/// dialable public address; caps the result by the room's free hold slots.
pub fn plan_holds(
    records: &[ChiaPresenceRecord],
    ctx: &PlanContext<'_>,
    addr_filter: &dyn Fn(&[String]) -> Vec<SocketAddr>,
) -> Vec<HoldCandidate> {
    let free = MAX_HOLDS_PER_ROOM.saturating_sub(ctx.active_holds);
    let mut ranked: Vec<&ChiaPresenceRecord> = records.iter().collect();
    ranked.sort_by_key(|r| std::cmp::Reverse(r.issued_at));
    let mut out = Vec::new();
    let mut taken: HashSet<&str> = HashSet::new();
    for r in ranked {
        if out.len() >= free {
            break;
        }
        if r.node_id == ctx.self_id
            || ctx.connected.contains(&r.node_id)
            || ctx.dialing.contains(&r.node_id)
            || !taken.insert(r.node_id.as_str())
        {
            continue;
        }
        if r.expires_at != 0 && r.expires_at < ctx.now_unix {
            continue;
        }
        if ctx.cooldown_until.get(&r.node_id).is_some_and(|until| *until > ctx.now) {
            continue;
        }
        let addrs = addr_filter(&r.addrs);
        if addrs.is_empty() {
            continue;
        }
        out.push(HoldCandidate { node_id: r.node_id.clone(), addrs });
    }
    out
}

/// What a room remembers between beats.
#[derive(Default)]
struct RoomCache {
    /// Freshest verified record per node id (ours included).
    records: HashMap<String, FoundRecord>,
    /// Confirmed height of our own freshest record, to notice a NEW one.
    own_height: u32,
}

impl RoomCache {
    /// Merge a read's records: per node the newest signed time wins, and on an
    /// equal signed second the higher confirmation height — the same order as
    /// `rank_and_dedupe`, so a page that arrives late cannot put an older
    /// same-second record (and its stale addresses) back. Returns true when OUR
    /// OWN record appeared at a height not seen before — the signal that peers
    /// will see us at their next beat.
    fn merge(&mut self, found: Vec<FoundRecord>, self_id: &str) -> bool {
        let mut fresh_own = false;
        for f in chia_resolve::rank_and_dedupe(found) {
            if f.record.node_id == self_id && f.confirmed_height > self.own_height {
                self.own_height = f.confirmed_height;
                fresh_own = true;
            }
            let newer = match self.records.get(&f.record.node_id) {
                Some(prev) => {
                    (f.record.issued_at, f.confirmed_height) > (prev.record.issued_at, prev.confirmed_height)
                }
                None => true,
            };
            if newer {
                self.records.insert(f.record.node_id.clone(), f);
            }
        }
        fresh_own
    }

    fn live_records(&self, now_unix: u64) -> Vec<ChiaPresenceRecord> {
        self.records
            .values()
            .filter(|f| f.record.expires_at == 0 || f.record.expires_at >= now_unix)
            .map(|f| f.record.clone())
            .collect()
    }
}

/// State shared with the hold tasks: cooldowns and the live hold count.
#[derive(Default)]
pub struct WatchShared {
    /// (room, node id) -> instant the cooldown ends.
    pub cooldowns: Mutex<HashMap<(String, String), Instant>>,
    /// room -> holds in flight.
    pub active: Mutex<HashMap<String, usize>>,
}

/// Is the watcher enabled? `SSF_CHIA_WATCH=0` is the kill switch.
pub fn watch_enabled() -> bool {
    std::env::var("SSF_CHIA_WATCH").ok().as_deref() != Some("0")
}

/// The watcher: beat-aligned reads for every readable room, then holds for
/// every unknown member the records describe. Never affects the mesh when the
/// gateway is unreachable — it just waits for the next tick.
pub async fn watch_loop(hub: crate::SharedHub, iroh_ep: iroh::Endpoint) {
    let self_id = iroh_ep.id().to_string();
    let client = CoinsetClient::testnet11();
    let mut sched = BeatSchedule::from_env();
    let mut cursors: HashMap<(String, [u8; 32]), HintCursor> = HashMap::new();
    let mut cache: HashMap<String, RoomCache> = HashMap::new();
    let shared = Arc::new(WatchShared::default());
    let mut peak_failure_logged = false;
    // #231 P6a: per-node presence state — cursors per contact-key hint, the
    // freshest record per peer, and the height our own record was last seen at.
    let mut ck_cursors: HashMap<[u8; 32], HintCursor> = HashMap::new();
    // Our own key's read keeps cursors of its own: a peer whose card claims OUR
    // contact key (a reuse the signer routing supports) is read under the same
    // hint by the grouped read, and a shared cursor would let the self-read
    // consume that peer's records first and leave the grouped read nothing.
    let mut self_cursors: HashMap<[u8; 32], HintCursor> = HashMap::new();
    // Per peer: the contact key the record was read under, and the record.
    let mut node_cache: HashMap<String, ([u8; 32], FoundRecord)> = HashMap::new();
    let mut own_ck_height: u32 = 0;
    println!(
        "⛓️ ChiaHub watcher on: reads every {} blocks per room (×{} while connected), hold {}s × {}s, {} holds/room",
        sched.beat_blocks,
        CONNECTED_BEAT_MULTIPLIER,
        HOLD_PERIOD.as_secs(),
        HOLD_WINDOW.as_secs(),
        MAX_HOLDS_PER_ROOM
    );
    loop {
        tokio::time::sleep(Duration::from_secs(WATCH_TICK_SECS)).await;

        // Rooms we may read: every cap that is not public space (N8/D6).
        let readable: Vec<(String, [u8; 32])> = hub
            .chia_rooms
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, cap)| cap.may_read())
            .map(|(room, cap)| (room.clone(), cap.room_key))
            .collect();
        let gone: Vec<String> = cache
            .keys()
            .filter(|room| !readable.iter().any(|(r, _)| r == *room))
            .cloned()
            .collect();
        for room in &gone {
            cache.remove(room);
            sched.forget(room);
        }
        // Keep only the cursors of hints still in play: this tick's three scan
        // epochs of each readable room. A hint that rotated out of
        // `scan_epochs` is never read again, so its cursor (and up to SEEN_CAP
        // coin ids) would otherwise sit in memory for the life of the node —
        // three more per room every day.
        let now_unix = chia_resolve::unix_now();
        let live_hints: HashSet<(String, [u8; 32])> = readable
            .iter()
            .flat_map(|(room, key)| {
                chia_resolve::scan_epochs(now_unix)
                    .into_iter()
                    .map(move |e| (room.clone(), chia_lane::derive_hint(key, e)))
            })
            .collect();
        cursors.retain(|k, _| live_hints.contains(k));
        // #231 P6a: the peers whose contact cards we hold (node id, ck, rooms met in).
        let peers = hub.peers.lock().unwrap().with_ck();
        // A record stays cached only while its peer is in the book under the
        // SAME contact key: a newer card that rotates the key evicts the old
        // key's record, so holds follow the key the peer now publishes under.
        node_cache.retain(|node, (ck, _)| peers.iter().any(|(n, k, _)| n == node && k == ck));
        // Distinct contact keys and the node ids that claim each (see below).
        let mut by_ck: HashMap<[u8; 32], Vec<String>> = HashMap::new();
        for (node_id, ck, _) in &peers {
            by_ck.entry(*ck).or_default().push(node_id.clone());
        }
        sched.forget_where(|key| {
            key.strip_prefix("ck:").is_some_and(|k| k != "self" && !by_ck.keys().any(|ck| ck_sched_key(ck) == key))
        });
        // Nothing to read for, unless the publisher may have written OUR record:
        // then the own-key read below must run every beat, since it is what
        // confirms the write (a fresh node has no rooms or cards yet, and an
        // unconfirmed write is retried every confirmation timeout).
        let self_publishing = hub.presence_publishing.load(std::sync::atomic::Ordering::Relaxed);
        if readable.is_empty() && peers.is_empty() && !self_publishing {
            continue;
        }

        // One peak-height call per tick drives every room's beat.
        let peak = match chia_resolve::peak_height(&client).await {
            Some(h) => {
                peak_failure_logged = false;
                *hub.chia_peak.lock().unwrap() = chia_resolve::ChainPeak::new(h, chia_resolve::unix_now());
                h
            }
            None => {
                if !peak_failure_logged {
                    eprintln!("⛓️ ChiaHub watcher: chain peak unavailable — keeping the last beat, dialing from cache only");
                    peak_failure_logged = true;
                }
                0
            }
        };
        for (room, room_key) in readable.iter().cloned() {
            let (connected, dialing) = snapshot_peers(&hub, &room);
            let rc = cache.entry(room.clone()).or_default();

            // Beat-aligned chain read (skipped when the peak is unknown).
            if peak > 0 && sched.due(&room, peak, !connected.is_empty()) {
                let mut found = Vec::new();
                for e in chia_resolve::scan_epochs(now_unix) {
                    let hint = chia_lane::derive_hint(&room_key, e);
                    let cursor = cursors.entry((room.clone(), hint)).or_default();
                    match chia_resolve::read_hint(&client, Bytes32::new(hint), &room_key, now_unix, cursor).await {
                        Ok(f) => found.extend(f),
                        Err(err) => eprintln!("⛓️ ChiaHub watcher: read for room {room} (epoch {e}) failed: {err:#}"),
                    }
                }
                let n = found.len();
                if rc.merge(found, &self_id) {
                    // Our own record just confirmed: peers see us at their next
                    // beat, so restart the dance with everyone in this room.
                    shared.cooldowns.lock().unwrap().retain(|(r, _), _| r != &room);
                    println!("⛓️ ChiaHub watcher: own presence confirmed for room {room} at height {} — cooldowns cleared", rc.own_height);
                }
                if n > 0 {
                    println!("⛓️ ChiaHub watcher: room {room} beat at height {peak} — {n} record(s) read, {} member(s) known", rc.records.len());
                }
            }

            // Plan from the cache every tick (N5′: cached addresses first).
            let records = rc.live_records(now_unix);
            if records.is_empty() {
                continue;
            }
            let cooldown_until: HashMap<String, Instant> = shared
                .cooldowns
                .lock()
                .unwrap()
                .iter()
                .filter(|((r, _), _)| r == &room)
                .map(|((_, node), until)| (node.clone(), *until))
                .collect();
            let active_holds = shared.active.lock().unwrap().get(&room).copied().unwrap_or(0);
            let ctx = PlanContext {
                self_id: &self_id,
                connected: &connected,
                dialing: &dialing,
                cooldown_until: &cooldown_until,
                active_holds,
                now_unix,
                now: Instant::now(),
            };
            for cand in plan_holds(&records, &ctx, &crate::chia_public_dial_addrs) {
                spawn_hold(&hub, &iroh_ep, &shared, &room, cand, "room record");
            }
        }

        // ── #231 P6a: per-node presence — the peers whose contact cards we hold ──
        // One read per DISTINCT contact key per beat (four times less often while
        // every node claiming it is connected somewhere), records routed to the
        // peer whose node id SIGNED them: a card never proves a key belongs to
        // one node alone (a member who learned another member's key can claim
        // it in its own card), so the key only locates the hint and the
        // signature decides whose record it is; two claimants of one key both
        // get their own records, neither can shadow the other. Our own record
        // goes first: seeing it confirm tells the publisher the write landed
        // and clears every cooldown, since the peers see us at their next beat.
        // Only the chain reads need the peak; the holds planned from the cached
        // records (further below) run without one, as the room records' do.
        if peak > 0 {
            let own_ck = hub.contact_key;
            if sched.due("ck:self", peak, false) {
                match chia_resolve::read_ck(&client, &own_ck, peak, now_unix, &mut self_cursors).await {
                    Ok(found) => {
                        if let Some(newest) = found
                            .iter()
                            .filter(|f| f.record.node_id == self_id)
                            .max_by_key(|f| (f.record.issued_at, f.confirmed_height))
                        {
                            // The exact write, not just its era: the publisher
                            // matches this against the push time in its mark.
                            hub.presence_confirmed_at.store(newest.record.issued_at, std::sync::atomic::Ordering::Relaxed);
                            if newest.confirmed_height > own_ck_height {
                                own_ck_height = newest.confirmed_height;
                                shared.cooldowns.lock().unwrap().clear();
                                println!(
                                    "⛓️ ChiaHub watcher: own presence confirmed at height {} (era {}) — cooldowns cleared",
                                    newest.confirmed_height,
                                    chia_lane::era_of(newest.confirmed_height)
                                );
                            }
                        }
                    }
                    Err(err) => eprintln!("⛓️ ChiaHub watcher: read of our own presence failed: {err:#}"),
                }
            }
            let mut live_ck_hints: HashSet<[u8; 32]> = chia_resolve::live_ck_hints(&own_ck, peak).into_iter().collect();
            for ck in by_ck.keys() {
                live_ck_hints.extend(chia_resolve::live_ck_hints(ck, peak));
            }
            // Bounded and fair: at most MAX_CK_READS_PER_TICK keys per tick, the
            // longest-waiting first. A key passed over keeps its turn (its beat
            // is not recorded) and comes before the others next tick.
            let mut reads = 0usize;
            for ck in ck_read_order(&by_ck, &sched) {
                if reads >= MAX_CK_READS_PER_TICK {
                    break;
                }
                let nodes = &by_ck[&ck];
                // The slower cadence only when EVERY claimant is connected
                // somewhere: a member who reuses another's key in its own card
                // and stays connected must not slow that node's reads.
                let connected_all = nodes.iter().all(|n| !rooms_connected_to(&hub, n).is_empty());
                if !sched.due(&ck_sched_key(&ck), peak, connected_all) {
                    continue;
                }
                reads += 1;
                match chia_resolve::read_ck(&client, &ck, peak, now_unix, &mut ck_cursors).await {
                    Ok(found) => {
                        for f in chia_resolve::rank_and_dedupe(found) {
                            // Routed by signer; a record signed by nobody who
                            // claims this key is noise under the hint.
                            let Some(node_id) = nodes.iter().find(|n| **n == f.record.node_id) else { continue };
                            let newer = node_cache
                                .get(node_id)
                                .map(|(_, p)| (f.record.issued_at, f.confirmed_height) > (p.record.issued_at, p.confirmed_height))
                                .unwrap_or(true);
                            if newer {
                                println!(
                                    "⛓️ ChiaHub watcher: presence of {} read — era record at height {}, {} public addr(s)",
                                    &node_id[..node_id.len().min(16)],
                                    f.confirmed_height,
                                    crate::chia_public_dial_addrs(&f.record.addrs).len()
                                );
                                node_cache.insert(node_id.clone(), (ck, f));
                            }
                        }
                    }
                    Err(err) => eprintln!(
                        "⛓️ ChiaHub watcher: read of a contact key's presence failed ({} claimant(s)): {err:#}",
                        nodes.len()
                    ),
                }
            }
            ck_cursors.retain(|hint, _| live_ck_hints.contains(hint));
            self_cursors.retain(|hint, _| live_ck_hints.contains(hint));
        }
        // Holds: each peer's freshest cached record, in the readable rooms it was
        // met in and is not connected to — with or without a chain peak this
        // tick, like the room records above: an outage stops the reads, not the
        // dialing from what was already read.
        for (node_id, _ck, met_in) in &peers {
            let Some((_, found)) = node_cache.get(node_id) else { continue };
            if found.record.expires_at != 0 && found.record.expires_at < now_unix {
                continue;
            }
            let connected_in = rooms_connected_to(&hub, node_id);
            let record = vec![found.record.clone()];
            for room in met_in {
                // Only a room this node still holds (served or relayed) and
                // may read: a hold is bound to a room, and one bound to a
                // room that is gone would end at once as "linked".
                let held = hub.rooms.lock().unwrap().contains_key(room);
                if !held || !readable.iter().any(|(r, _)| r == room) || connected_in.contains(room) {
                    continue;
                }
                let (connected, dialing) = snapshot_peers(&hub, room);
                let cooldown_until: HashMap<String, Instant> = shared
                    .cooldowns
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|((r, _), _)| r == room)
                    .map(|((_, node), until)| (node.clone(), *until))
                    .collect();
                let active_holds = shared.active.lock().unwrap().get(room).copied().unwrap_or(0);
                let ctx = PlanContext {
                    self_id: &self_id,
                    connected: &connected,
                    dialing: &dialing,
                    cooldown_until: &cooldown_until,
                    active_holds,
                    now_unix,
                    now: Instant::now(),
                };
                for cand in plan_holds(&record, &ctx, &crate::chia_public_dial_addrs) {
                    spawn_hold(&hub, &iroh_ep, &shared, room, cand, "contact key");
                }
            }
        }
        // Forget peers that failed three windows in a row with no success
        // for a week (their card is stale; a new one arrives if we meet).
        let pruned = {
            let mut book = hub.peers.lock().unwrap();
            let n = book.prune(now_unix);
            if n > 0 {
                let _ = book.save(std::path::Path::new(crate::chia_contact::PEERS_FILE));
            }
            n
        };
        if pruned > 0 {
            println!("⛓️ ChiaHub watcher: forgot {pruned} unreachable peer(s) from the address book");
        }
    }
}

/// Start one hold for `cand` in `room`: claims the dial single-flight here (not
/// inside the task) so the same target cannot be planned twice before its task
/// starts, counts it against the room's hold slots, and on failure puts the
/// target in cooldown. The outcome is also noted in the address book when the
/// target is a peer whose card we hold (`source` names what found it, for the log).
fn spawn_hold(
    hub: &crate::SharedHub,
    iroh_ep: &iroh::Endpoint,
    shared: &Arc<WatchShared>,
    room: &str,
    cand: HoldCandidate,
    source: &str,
) {
    let Ok(target_pub) = cand.node_id.parse::<iroh::PublicKey>() else { return };
    if !hub.dialing.lock().unwrap().insert(target_pub) {
        return;
    }
    *shared.active.lock().unwrap().entry(room.to_string()).or_insert(0) += 1;
    println!(
        "⛓️ ChiaHub watcher: holding for {} in room {room} at {} public addr(s) ({source})",
        &cand.node_id[..cand.node_id.len().min(16)],
        cand.addrs.len()
    );
    let hub_h = hub.clone();
    let ep_h = iroh_ep.clone();
    let shared_h = shared.clone();
    let room_h = room.to_string();
    tokio::spawn(async move {
        let ok = crate::hold_dial(
            hub_h.clone(),
            ep_h,
            room_h.clone(),
            target_pub,
            cand.node_id.clone(),
            cand.addrs,
            crate::TIER_INTRODUCED,
            None,
        )
        .await;
        // Released the way every dial is: the claim goes, the pinhole grace stays.
        crate::release_dial(&hub_h, target_pub);
        if let Some(n) = shared_h.active.lock().unwrap().get_mut(&room_h) {
            *n = n.saturating_sub(1);
        }
        {
            let now = chia_resolve::unix_now();
            let mut book = hub_h.peers.lock().unwrap();
            if book.peers.contains_key(&cand.node_id) {
                if ok {
                    book.note_ok(&cand.node_id, now);
                } else {
                    book.note_fail(&cand.node_id, now);
                }
                let _ = book.save(std::path::Path::new(crate::chia_contact::PEERS_FILE));
            }
        }
        if !ok {
            shared_h
                .cooldowns
                .lock()
                .unwrap()
                .insert((room_h, cand.node_id), Instant::now() + TARGET_COOLDOWN);
        }
    });
}

/// The beat-schedule key of a contact key (a hint prefix: the key itself never
/// appears in a log line).
/// The order contact keys are offered a read in this tick: never-read keys
/// first, then by the peak height of their last read (longest waiting first),
/// ties broken by the key bytes so the order is stable.
fn ck_read_order(by_ck: &HashMap<[u8; 32], Vec<String>>, sched: &BeatSchedule) -> Vec<[u8; 32]> {
    let mut keys: Vec<[u8; 32]> = by_ck.keys().copied().collect();
    keys.sort_by_key(|ck| {
        let last = sched.last_read_of(&ck_sched_key(ck));
        (last.is_some(), last.unwrap_or(0), *ck)
    });
    keys
}

/// The beat entry of a contact key: the WHOLE key, so two keys that share a
/// prefix (a member who knows another's key can mint one) never share an entry
/// and shadow each other's reads.
fn ck_sched_key(ck: &[u8; 32]) -> String {
    format!("ck:{}", hex::encode(ck))
}

/// The rooms `node_id` is connected in right now.
fn rooms_connected_to(hub: &crate::SharedHub, node_id: &str) -> HashSet<String> {
    let Ok(key) = node_id.parse::<iroh::PublicKey>() else { return HashSet::new() };
    hub.rooms
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, r)| r.remote_peers.contains_key(&key))
        .map(|(id, _)| id.clone())
        .collect()
}

/// Node ids connected in `room`, and node ids with a dial in flight (global).
fn snapshot_peers(hub: &crate::SharedHub, room: &str) -> (HashSet<String>, HashSet<String>) {
    let connected = hub
        .rooms
        .lock()
        .unwrap()
        .get(room)
        .map(|r| r.remote_peers.keys().map(|k| k.to_string()).collect())
        .unwrap_or_default();
    let dialing = hub.dialing.lock().unwrap().iter().map(|k| k.to_string()).collect();
    (connected, dialing)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(node: &str, issued_at: u64, expires_at: u64, addrs: &[&str]) -> ChiaPresenceRecord {
        ChiaPresenceRecord {
            kx_pk: None,
            addr_flags: vec![],
            v: 1,
            node_id: node.to_string(),
            addrs: addrs.iter().map(|s| s.to_string()).collect(),
            relay_urls: vec![],
            issued_at,
            expires_at,
        }
    }

    fn parse_all(addrs: &[String]) -> Vec<SocketAddr> {
        addrs.iter().filter_map(|s| s.parse().ok()).collect()
    }

    #[test]
    fn beat_is_due_on_first_sight_then_once_per_beat() {
        let mut s = BeatSchedule::new(32);
        assert!(s.due("r", 1_000, false), "first sight reads");
        assert!(!s.due("r", 1_010, false), "same beat: no read");
        assert!(!s.due("r", 1_023, false));
        assert!(s.due("r", 1_024, false), "peak crossed 32·32 = 1024");
        assert!(!s.due("r", 1_024, false), "already read at this beat");
        assert!(!s.due("r", 1_000, false), "a peak that went backwards never triggers");
    }

    #[test]
    fn connected_rooms_read_four_times_less_often() {
        let mut s = BeatSchedule::new(32);
        assert!(s.due("r", 1_024, true));
        assert!(!s.due("r", 1_056, true), "32 blocks later: still inside the 128-block connected beat");
        assert!(!s.due("r", 1_120, true));
        assert!(s.due("r", 1_152, true), "128-block boundary crossed");
        let mut other = BeatSchedule::new(32);
        assert!(other.due("x", 1_024, false));
        assert!(other.due("x", 1_056, false), "the same gap reads when unconnected");
    }

    #[test]
    fn contact_keys_take_turns_never_read_first_then_longest_waiting() {
        let mut sched = BeatSchedule::new(32);
        let (a, b, c) = ([1u8; 32], [2u8; 32], [3u8; 32]);
        let by_ck: HashMap<[u8; 32], Vec<String>> = [a, b, c].into_iter().map(|k| (k, vec![format!("n{}", k[0])])).collect();
        assert!(sched.due(&ck_sched_key(&a), 1000, false));
        assert!(sched.due(&ck_sched_key(&b), 500, false));
        assert_eq!(ck_read_order(&by_ck, &sched), vec![c, b, a], "never read first, then the longest waiting");
        assert!(MAX_CK_READS_PER_TICK >= 1);
        let mut twin = a;
        twin[31] ^= 1;
        assert_ne!(ck_sched_key(&a), ck_sched_key(&twin), "a key sharing a's first bytes has its own beat entry");
    }

    #[test]
    fn env_beat_falls_back_to_default() {
        let s = BeatSchedule::new(0);
        assert_eq!(s.beat_blocks, 1, "zero is clamped, never a division by zero");
        assert_eq!(BeatSchedule::new(DEFAULT_BEAT_BLOCKS).beat_blocks, 32);
    }

    #[test]
    fn planner_skips_self_connected_dialing_cooled_expired_and_addressless() {
        let now = Instant::now();
        let now_unix = 1_000_000u64;
        let connected: HashSet<String> = ["bob".to_string()].into_iter().collect();
        let dialing: HashSet<String> = ["carol".to_string()].into_iter().collect();
        let cooldown: HashMap<String, Instant> = [("dave".to_string(), now + Duration::from_secs(60))].into_iter().collect();
        let records = vec![
            rec("me", 900_000, 0, &["198.51.100.1:1"]),
            rec("bob", 900_000, 0, &["198.51.100.2:1"]),
            rec("carol", 900_000, 0, &["198.51.100.3:1"]),
            rec("dave", 900_000, 0, &["198.51.100.4:1"]),
            rec("erin", 900_000, now_unix - 1, &["198.51.100.5:1"]),
            rec("frank", 900_000, 0, &[]),
            rec("grace", 950_000, 0, &["[2001:db8::7]:1", "198.51.100.7:1"]),
            rec("heidi", 910_000, 0, &["198.51.100.8:1"]),
        ];
        let ctx = PlanContext {
            self_id: "me",
            connected: &connected,
            dialing: &dialing,
            cooldown_until: &cooldown,
            active_holds: 0,
            now_unix,
            now,
        };
        let plan = plan_holds(&records, &ctx, &parse_all);
        let ids: Vec<&str> = plan.iter().map(|c| c.node_id.as_str()).collect();
        assert_eq!(ids, vec!["grace", "heidi"], "freshest signed time first, everyone else skipped");
        assert_eq!(plan[0].addrs.len(), 2);
    }

    #[test]
    fn planner_respects_free_hold_slots_and_expired_cooldowns() {
        let now = Instant::now();
        let empty: HashSet<String> = HashSet::new();
        // Six records, "f" the freshest. Its cooldown EXPIRED a second ago.
        let expired: HashMap<String, Instant> = [("f".to_string(), now - Duration::from_secs(1))].into_iter().collect();
        let records: Vec<ChiaPresenceRecord> = (0..6)
            .map(|i| rec(&format!("{}", (b'a' + i) as char), 1_000 + i as u64, 0, &["198.51.100.9:1"]))
            .collect();
        let ctx = PlanContext {
            self_id: "me",
            connected: &empty,
            dialing: &empty,
            cooldown_until: &expired,
            active_holds: MAX_HOLDS_PER_ROOM - 1,
            now_unix: 5,
            now,
        };
        let plan = plan_holds(&records, &ctx, &parse_all);
        assert_eq!(plan.len(), 1, "one free slot -> one hold");
        assert_eq!(plan[0].node_id, "f", "an expired cooldown no longer blocks the freshest record");
        // The same target still COOLING is skipped and the next freshest takes the slot.
        let cooling: HashMap<String, Instant> = [("f".to_string(), now + Duration::from_secs(60))].into_iter().collect();
        let ctx_cooling = PlanContext { cooldown_until: &cooling, ..ctx };
        let plan = plan_holds(&records, &ctx_cooling, &parse_all);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].node_id, "e", "a live cooldown skips 'f'; 'e' is next");
        // No free slot: nothing, whatever the records say. All slots free: the cap holds.
        let ctx_full = PlanContext { active_holds: MAX_HOLDS_PER_ROOM, ..ctx };
        assert!(plan_holds(&records, &ctx_full, &parse_all).is_empty());
        let ctx_free = PlanContext { active_holds: 0, ..ctx_full };
        let ids: Vec<String> = plan_holds(&records, &ctx_free, &parse_all).into_iter().map(|c| c.node_id).collect();
        assert_eq!(ids.len(), MAX_HOLDS_PER_ROOM, "never more holds than the per-room cap");
        assert_eq!(ids[0], "f", "freshest first, its expired cooldown ignored");
    }

    #[test]
    fn cache_merge_keeps_newest_signed_time_and_flags_fresh_own_record() {
        let mk = |node: &str, issued: u64, height: u32| FoundRecord {
            record: rec(node, issued, 0, &["198.51.100.1:1"]),
            coin_id: Bytes32::new([height as u8; 32]),
            confirmed_height: height,
            hint: Bytes32::new([0u8; 32]),
        };
        let mut c = RoomCache::default();
        assert!(c.merge(vec![mk("me", 10, 100), mk("bob", 10, 100)], "me"), "first own record is fresh");
        assert!(!c.merge(vec![mk("me", 10, 100)], "me"), "same own record again is not");
        assert!(c.merge(vec![mk("me", 20, 140)], "me"), "a newer own record is");
        c.merge(vec![mk("bob", 5, 200)], "me");
        assert_eq!(c.records["bob"].record.issued_at, 10, "an older signed time never replaces a newer one, whatever its height");
        c.merge(vec![mk("bob", 30, 90)], "me");
        assert_eq!(c.records["bob"].record.issued_at, 30);
        // Same signed second: the higher confirmation height wins, as in
        // rank_and_dedupe — a page arriving late cannot restore stale addresses.
        c.merge(vec![mk("bob", 30, 80)], "me");
        assert_eq!(c.records["bob"].confirmed_height, 90, "same second, lower height: the cached one stays");
        c.merge(vec![mk("bob", 30, 95)], "me");
        assert_eq!(c.records["bob"].confirmed_height, 95, "same second, higher height: replaced");
        assert_eq!(c.live_records(0).len(), 2);
    }
}
