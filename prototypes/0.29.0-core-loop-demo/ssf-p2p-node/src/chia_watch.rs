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
    /// Merge a read's records (newest signed time wins per node). Returns true
    /// when OUR OWN record appeared at a height not seen before — the signal
    /// that peers will see us at their next beat.
    fn merge(&mut self, found: Vec<FoundRecord>, self_id: &str) -> bool {
        let mut fresh_own = false;
        for f in chia_resolve::rank_and_dedupe(found) {
            if f.record.node_id == self_id && f.confirmed_height > self.own_height {
                self.own_height = f.confirmed_height;
                fresh_own = true;
            }
            let newer = match self.records.get(&f.record.node_id) {
                Some(prev) => f.record.issued_at >= prev.record.issued_at,
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
        if readable.is_empty() {
            continue;
        }

        // One peak-height call per tick drives every room's beat.
        let peak = match chia_resolve::peak_height(&client).await {
            Some(h) => {
                peak_failure_logged = false;
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
        for (room, room_key) in readable {
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
                let Ok(target_pub) = cand.node_id.parse::<iroh::PublicKey>() else { continue };
                // Claim the dial single-flight here (not inside the task) so the
                // same target cannot be planned twice before its task starts.
                if !hub.dialing.lock().unwrap().insert(target_pub) {
                    continue;
                }
                *shared.active.lock().unwrap().entry(room.clone()).or_insert(0) += 1;
                println!(
                    "⛓️ ChiaHub watcher: holding for {} in room {room} at {} public addr(s)",
                    &cand.node_id[..cand.node_id.len().min(16)],
                    cand.addrs.len()
                );
                let hub_h = hub.clone();
                let ep_h = iroh_ep.clone();
                let shared_h = shared.clone();
                let room_h = room.clone();
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
                    hub_h.dialing.lock().unwrap().remove(&target_pub);
                    if let Some(n) = shared_h.active.lock().unwrap().get_mut(&room_h) {
                        *n = n.saturating_sub(1);
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
        }
    }
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
        assert_eq!(c.live_records(0).len(), 2);
    }
}
