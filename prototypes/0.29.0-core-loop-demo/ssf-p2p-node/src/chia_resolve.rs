//! The GENERIC HINT READER — the read side of the ChiaHub lane (#231 P1, on by
//! default since D3). Everything a node learns from the chain comes through
//! here: the room-keyed v1 presence records and, since P6a, the per-NODE v2
//! presence records filed under a contact key's era hints ([`read_ck`],
//! [`resolve_presence_by_ck`]). The inbox and beacon kinds of P6b will only
//! change the hint and the opener again ([`read_hint_with`]).
//!
//! Flow (source-verified chia-sdk 0.34 API):
//!   hint -> get_coin_records_by_hint (spent coins INCLUDED — every publish
//!   spends the previous record coin; pages followed via `next_cursor`) ->
//!   get_puzzle_and_solution on the PARENT coin -> run_puzzle -> the create_coin
//!   whose memos are `[hint, ciphertext]` -> chia_lane::open (room key) ->
//!   decode_signed -> freshness checks.
//!
//! Rules the reader lives by (third follow-up on #231, verified against the
//! full node's `hint_store`):
//!   * `include_spent_coins=true` always — the current record's coin is spent
//!     the moment its publisher republishes.
//!   * Reads are INCREMENTAL: a [`HintCursor`] remembers the highest confirmed
//!     height examined and resumes `CURSOR_OVERLAP_BLOCKS` below it; coins
//!     already examined are skipped by coin id. A listing longer than
//!     [`MAX_PAGES_PER_POLL`] is continued next poll from the listing's parked
//!     cursor, and the height only moves once a listing ended fully examined.
//!   * Parent fetches are capped per poll ([`MAX_PARENT_FETCHES_PER_POLL`]); a
//!     flooded hint costs a bounded number of calls, not a scan of 50,000 ids.
//!   * Records are RANKED by their signed `issued_at`, never by block height:
//!     the publisher signs the time, the block only proves "after". Replayed old
//!     ciphertexts therefore never outrank a fresh record.
//!   * Freshness: `expires_at` enforced (0 = never expires, P2 decides its
//!     future), and an `issued_at` more than [`MAX_FUTURE_SKEW_SECS`] ahead of
//!     the reader's clock is refused.
//!
//! The chain is the swarm's address book + metronome, never its pipe: a read
//! costs a few KB at ~19 s block latency and hands addresses to a dial.
#![cfg(feature = "chia-read")]

use std::collections::HashSet;

use anyhow::{anyhow, Result};
use chia_protocol::{Bytes, Bytes32};
use chia_puzzle_types::Memos;
use crate::chia_chain::{ChainAccess, PuzzleAndSolution};
use chia_sdk_types::{run_puzzle, Conditions};
use clvm_traits::{FromClvm, ToClvm};
use clvmr::{Allocator, NodePtr};
use sha2::{Digest, Sha256};

use crate::chia_lane::{self, ChiaPresenceRecord};
use crate::chia_network::ChiaNet;

/// Record v2 (P6a) refuses a signed `issued_at` more than two hours ahead of
/// the reader's clock (the third follow-up on #231); the era, not the clock,
/// is v2's rotation, so the skew bound can be tight.
pub const MAX_FUTURE_SKEW_V2_SECS: u64 = 2 * 3600;

/// Parent-spend fetches per hint per poll. Bounds the cost of a flooded hint.
pub const MAX_PARENT_FETCHES_PER_POLL: usize = 50;
/// Listing pages followed per hint per poll (each page is one peer request).
pub const MAX_PAGES_PER_POLL: usize = 8;
/// Blocks re-read below the cursor on every poll: a late-confirming spend or a
/// short reorg still gets seen.
pub const CURSOR_OVERLAP_BLOCKS: u32 = 32;
/// Signed `issued_at` further ahead than this is refused (publisher clock skew
/// bound; a day, matching the daily epoch rotation).
pub const MAX_FUTURE_SKEW_SECS: u64 = 86_400;
/// Flood bound on the per-hint set of examined coin ids. The set is NEVER
/// cleared mid-cycle (clearing made the reader revisit the newest coins and
/// starve everything past the first few hundred, since `last_height` cannot
/// move while coins stay unexamined); it empties only when a listing ends fully
/// examined and the height advances. At this many coins under ONE hint-epoch
/// the hint is a flood by a key holder: the reader stops examining it for the
/// cycle and says so, rather than forgetting what it has read. 16k ids are
/// 512 KB; a real room writes tens of records a day.
const SEEN_CAP: usize = 16_384;

/// A verified record plus where it sat on chain.
#[derive(Clone, Debug, PartialEq)]
pub struct FoundRecord {
    pub record: ChiaPresenceRecord,
    pub coin_id: Bytes32,
    pub confirmed_height: u32,
    pub hint: Bytes32,
}

/// #231 P6b: a decoded item of any record kind plus where it sat on chain —
/// what [`read_hint_items`] returns; [`FoundRecord`] is its presence shape.
#[derive(Clone, Debug, PartialEq)]
pub struct FoundItem<T> {
    pub item: T,
    pub coin_id: Bytes32,
    pub confirmed_height: u32,
    pub hint: Bytes32,
}

/// Per-hint read position for incremental polls.
#[derive(Clone, Debug, Default)]
pub struct HintCursor {
    /// Highest confirmed height fully examined (0 = never read: full scan).
    pub last_height: u32,
    /// Coin ids already examined (decoded or rejected) — skipped on re-reads
    /// inside the overlap window. Emptied when a listing cycle completes;
    /// bounded by `SEEN_CAP` as a flood stop, never cleared mid-cycle.
    pub seen: HashSet<[u8; 32]>,
    /// A listing the last poll could not finish inside `MAX_PAGES_PER_POLL`:
    /// the next poll continues it from the listing's cursor instead of starting
    /// over, and `last_height` never moves past pages nobody has fetched.
    pub pending: Option<PendingPage>,
    /// The last poll hit `MAX_PARENT_FETCHES_PER_POLL` and left listed coins
    /// unexamined; `last_height` stayed put, so the next poll re-lists them and
    /// takes the next batch. Together with `pending`, "there is more to read".
    pub backlog: bool,
}

/// Where a page-capped poll stopped, so the next poll continues the SAME
/// listing. A listing cursor is only meaningful for the query that produced
/// it, so the query's `start_height` travels with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPage {
    pub start_height: Option<u32>,
    /// The listing's `next_cursor` for the first page not yet fetched.
    pub next_cursor: String,
    /// Highest confirmed height on the pages fetched so far.
    pub max_height: u32,
    /// False once any poll of this listing left coins unexamined (parent-fetch
    /// cap): the listing then cannot advance `last_height` when it ends.
    pub examined_all: bool,
}

/// What one poll starts from: the query's `start_height`, the page cursor (None
/// = first page) and the listing's running `max_height` / `examined_all`.
struct Resume {
    start: Option<u32>,
    page: Option<String>,
    max_height: u32,
    examined_all: bool,
}

impl HintCursor {
    /// More to read under this hint: a parked listing or an unexamined backlog.
    pub fn has_more(&self) -> bool {
        self.pending.is_some() || self.backlog
    }

    /// `start_height` for the next FRESH query: resume a little below the last
    /// examined height; `None` means scan the hint from genesis.
    pub fn start_height(&self) -> Option<u32> {
        if self.last_height == 0 {
            None
        } else {
            Some(self.last_height.saturating_sub(CURSOR_OVERLAP_BLOCKS))
        }
    }

    /// Take the next poll's starting point: the pending listing if there is
    /// one (taken, so a cursor the peers no longer honour fails once and
    /// the poll after starts fresh), else a fresh listing from `start_height`.
    fn resume(&mut self) -> Resume {
        match self.pending.take() {
            Some(p) => Resume {
                start: p.start_height,
                page: Some(p.next_cursor),
                max_height: p.max_height,
                examined_all: p.examined_all,
            },
            None => Resume { start: self.start_height(), page: None, max_height: 0, examined_all: true },
        }
    }

    /// Remember an examined coin. Refuses (returns false) once the flood bound
    /// is reached; it never clears the set, see [`SEEN_CAP`].
    fn mark_seen(&mut self, coin_id: [u8; 32]) -> bool {
        if self.seen.len() >= SEEN_CAP {
            return false;
        }
        self.seen.insert(coin_id);
        true
    }

    /// The flood bound is reached: nothing more is examined under this hint
    /// until its listing cycle ends.
    pub fn seen_full(&self) -> bool {
        self.seen.len() >= SEEN_CAP
    }

    /// Put the cursor back as it was before a read that FAILED, so nothing that
    /// read examined counts as seen — minus any parked page cursor: `resume`
    /// took it so a cursor the peers no longer honour (a reorganization above
    /// it) fails ONCE; put back, it would be refused every beat and the hint
    /// never read again until it rotated out (#272 review round 7). The fresh
    /// listing starts below `last_height`, which never passed the pages nobody
    /// fetched, so nothing is skipped; `backlog` says there is more to read.
    pub fn roll_back(&mut self, before: HintCursor) {
        *self = before;
        self.pending = None;
        self.backlog = true;
    }
}

/// 🕳️ Whether room-keyed (v1) records are read on `net`: on a test network
/// only. This build writes none on any network (the writer went in stage 4
/// PR 12), and an older build wrote one on a test network only: its Chia
/// Mesh switch was not offered anywhere else, and the SSF wallet, which
/// paid for a v1 record, pays for no write off a test network
/// (`chia_publish::money_memo_refusal`). So off a test network a
/// read could find nothing a station wrote, and would show the full node
/// this station's private rooms as hints, in the very bytes it asks a test
/// network's node for: a v1 hint is the room key's and the day's alone and
/// carries no network tag (docs/TDD/ChiaLanePrivacy.md §3, and §6 (22)).
/// The watcher's beat and the dial that ran out of routes both ask this.
pub fn reads_v1(net: ChiaNet) -> bool {
    net.is_test()
}

/// The epochs a reader scans at `now`: next, current and previous. The next
/// one catches a publisher whose clock runs ahead of ours (invisible before
/// P1); the previous one keeps records straddling midnight findable.
pub fn scan_epochs(now: u64) -> [u64; 3] {
    let e = chia_lane::epoch_now(now);
    [e + 1, e, e.saturating_sub(1)]
}

/// Open + verify + freshness-check one ciphertext. `None` = not for us,
/// tampered, expired or from the future.
pub fn decode_blob(room_key: &[u8; 32], ciphertext: &[u8], now: u64) -> Option<ChiaPresenceRecord> {
    let blob = chia_lane::open(room_key, ciphertext).ok()?; // wrong room key / not for us
    let record = chia_lane::decode_signed(&blob).ok()?; // tampered / bad signature
    if record.expires_at != 0 && record.expires_at < now {
        return None; // stale — a newer heartbeat should exist
    }
    if record.issued_at > now.saturating_add(MAX_FUTURE_SKEW_SECS) {
        return None; // publisher clock absurdly ahead (or a forged time)
    }
    Some(record)
}

/// Rank newest-first by SIGNED `issued_at` and keep one record per node id (its
/// newest). Block height never enters the ranking.
pub fn rank_and_dedupe(mut found: Vec<FoundRecord>) -> Vec<FoundRecord> {
    found.sort_by(|a, b| {
        b.record
            .issued_at
            .cmp(&a.record.issued_at)
            .then_with(|| b.confirmed_height.cmp(&a.confirmed_height))
    });
    let mut seen_nodes: HashSet<String> = HashSet::new();
    found.retain(|f| seen_nodes.insert(f.record.node_id.clone()));
    found
}

/// Read every record under `hint` not yet examined by `cursor`. Follows listing
/// pages, reads spent coins, caps parent fetches, verifies and filters. The
/// cursor's `last_height` advances only when a listing ENDED (the peer sent
/// its last page) and every coin it listed was examined; a poll that spends its
/// page budget first parks the listing cursor in `pending` and the next poll
/// continues the same listing, so no page is ever skipped. A capped or failed
/// poll re-reads what it skipped next time.
pub async fn read_hint(
    client: &impl ChainAccess,
    hint: Bytes32,
    room_key: &[u8; 32],
    now: u64,
    cursor: &mut HintCursor,
) -> Result<Vec<FoundRecord>> {
    read_hint_with(client, hint, cursor, &|ciphertext, _parent, _height| decode_blob(room_key, ciphertext, now)).await
}

/// [`read_hint`] with the OPENER as a parameter: the listing, paging, parent
/// fetching, cursor and flood rules are the same for every record kind; only
/// how a ciphertext becomes a record differs. The opener gets the ciphertext,
/// the parent of the coin that carried it (the writer's input: what a knock's
/// sealing is bound to, #272 review round 3) and the height of the block that
/// confirmed the coin (v2's era rule).
pub async fn read_hint_with(
    client: &impl ChainAccess,
    hint: Bytes32,
    cursor: &mut HintCursor,
    opener: &(dyn Fn(&[u8], Bytes32, u32) -> Option<ChiaPresenceRecord> + Sync),
) -> Result<Vec<FoundRecord>> {
    Ok(read_hint_items(client, hint, cursor, opener)
        .await?
        .into_iter()
        .map(|f| FoundRecord { record: f.item, coin_id: f.coin_id, confirmed_height: f.confirmed_height, hint: f.hint })
        .collect())
}

/// [`read_hint_with`] for ANY record kind (#231 P6b: knocks and beacons read
/// through the same listing, paging, parent-fetch, cursor and flood rules).
pub async fn read_hint_items<T: Send>(
    client: &impl ChainAccess,
    hint: Bytes32,
    cursor: &mut HintCursor,
    opener: &(dyn Fn(&[u8], Bytes32, u32) -> Option<T> + Sync),
) -> Result<Vec<FoundItem<T>>> {
    let Resume { start, mut page, mut max_height, mut examined_all } = cursor.resume();
    let mut coins = Vec::new();
    // `listed` = the peer reported the listing's last page this poll.
    let mut listed = false;
    for _ in 0..MAX_PAGES_PER_POLL {
        let listing = client
            .coin_records_by_hint(hint, start, true, page.clone())
            .await
            .map_err(|e| anyhow!("hint lookup: {e}"))?;
        coins.extend(listing.records);
        match (listing.truncated, listing.next_cursor) {
            (true, Some(next)) => page = Some(next),
            _ => {
                listed = true;
                break;
            }
        }
    }
    // Newest first, so a capped poll examines the freshest coins.
    coins.sort_by_key(|r| std::cmp::Reverse(r.confirmed_block_index));
    max_height = max_height.max(coins.iter().map(|r| r.confirmed_block_index).max().unwrap_or(0));

    let mut out = Vec::new();
    let mut fetched = 0usize;
    let mut capped = false;
    for rec in coins {
        let coin_id: [u8; 32] = rec.coin.coin_id().to_bytes();
        if cursor.seen.contains(&coin_id) {
            continue;
        }
        if fetched >= MAX_PARENT_FETCHES_PER_POLL {
            capped = true;
            break;
        }
        if cursor.seen_full() {
            // A flood under this hint: more distinct coins than any honest room
            // writes in an epoch. Stop here, keep what was read, say so once.
            eprintln!(
                "⛓️ ChiaHub resolve: hint {} holds more than {SEEN_CAP} coins this epoch — flooded; not examining further this cycle",
                hex::encode(&hint.to_bytes()[..8])
            );
            capped = true;
            break;
        }
        fetched += 1;
        // The memos live in the PARENT's spend (the create_coin that made this coin).
        let parent_spend =
            match fetch_coin_spend(client, rec.coin.parent_coin_info, rec.confirmed_block_index).await? {
                Some(cs) => cs,
                None => {
                    cursor.mark_seen(coin_id);
                    continue;
                }
            };
        cursor.mark_seen(coin_id);
        let ciphertext = match extract_ciphertext(&parent_spend, hint)? {
            Some(ct) => ct,
            None => continue,
        };
        if let Some(item) = opener(&ciphertext, rec.coin.parent_coin_info, rec.confirmed_block_index) {
            out.push(FoundItem { item, coin_id: Bytes32::new(coin_id), confirmed_height: rec.confirmed_block_index, hint });
        }
    }
    cursor.backlog = capped;
    if capped {
        examined_all = false;
    }
    if listed {
        if examined_all && max_height > cursor.last_height {
            // Cycle complete: everything listed from `start` is examined. The
            // height moves up and the next cycle lists only coins above it
            // (minus the overlap), so the examined-ids set can start afresh.
            cursor.last_height = max_height;
            cursor.seen.clear();
        }
    } else if let Some(next) = page {
        // Page budget spent before the listing ended: park the cursor so the
        // next poll fetches the pages after it, under the same start height.
        cursor.pending = Some(PendingPage { start_height: start, next_cursor: next, max_height, examined_all });
    }
    Ok(out)
}

// ── #231 P6a: per-node presence (record v2) ─────────────────────────────────

/// Open + verify + check one v2 presence ciphertext read under `ck`'s hint for
/// `era`. `None` when it is not for us, tampered, filed under the wrong era,
/// CONFIRMED OUTSIDE ITS ERA (the pre-fill/replay rule: a record is valid only
/// if the block that confirmed it lies in the era it is signed for), expired,
/// or signed more than [`MAX_FUTURE_SKEW_V2_SECS`] ahead of our clock. The
/// seal is `net`'s (stage 4 design §3.5): a record sealed on the other
/// network does not open.
pub fn decode_v2_presence(
    net: ChiaNet,
    ck: &[u8; 32],
    ciphertext: &[u8],
    era: u64,
    confirmed_height: u32,
    now: u64,
) -> Option<ChiaPresenceRecord> {
    if chia_lane::era_of(confirmed_height) != era {
        return None;
    }
    let plain = chia_lane::open_v2(net, ck, chia_lane::KIND_PRESENCE, era, ciphertext).ok()?;
    let record = chia_lane::decode_presence_v2(&plain, era).ok()?;
    if record.expires_at < now {
        return None;
    }
    if record.issued_at > now.saturating_add(MAX_FUTURE_SKEW_V2_SECS) {
        return None;
    }
    Some(record.to_record())
}

/// The eras a v2 reader scans at chain peak `peak`: the current one and the
/// one before (a record written late in an era stays findable through the
/// next). Genesis has no previous era.
pub fn scan_eras(peak: u32) -> Vec<u64> {
    let e = chia_lane::era_of(peak);
    if e == 0 { vec![0] } else { vec![e, e - 1] }
}

/// One incremental read of a contact key's presence: both scan eras' hints,
/// cursors kept by the caller per hint (so the watcher pays only for new coins
/// beat after beat). A hint whose read fails has its cursor put back as it
/// was, minus any parked page cursor ([`HintCursor::roll_back`]), so nothing
/// it examined counts as seen and the next beat re-reads it; what the other
/// hint found is returned all the same. Only when every
/// hint failed is the error returned. The hints and the seal are `net`'s.
pub async fn read_ck(
    net: ChiaNet,
    client: &impl ChainAccess,
    ck: &[u8; 32],
    peak: u32,
    now: u64,
    cursors: &mut std::collections::HashMap<[u8; 32], HintCursor>,
) -> Result<Vec<FoundRecord>> {
    let mut found = Vec::new();
    let mut first_error: Option<anyhow::Error> = None;
    let mut any_ok = false;
    for era in scan_eras(peak) {
        let hint = chia_lane::derive_ck_hint(net, ck, era);
        let cursor = cursors.entry(hint).or_default();
        let before = cursor.clone();
        let opener = |ct: &[u8], _parent: Bytes32, height: u32| decode_v2_presence(net, ck, ct, era, height, now);
        match read_hint_with(client, Bytes32::new(hint), cursor, &opener).await {
            Ok(records) => {
                any_ok = true;
                found.extend(records);
            }
            Err(e) => {
                // Transactional: a failed read examined nothing. The hint still
                // has everything to read, so it is marked as backlog: the
                // one-shot resolver then spends a retry round on it instead of
                // taking the other hint's clean finish for "all read"; the
                // watcher re-reads it next beat either way.
                cursor.roll_back(before);
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }
    match first_error {
        Some(e) if !any_ok => Err(e),
        Some(e) => {
            eprintln!("⛓️ ChiaHub resolve: one of a contact key's era hints failed and will be re-read next beat: {e:#}");
            Ok(found)
        }
        None => Ok(found),
    }
}

/// The hints a v2 reader of `ck` has in play at `peak` on `net` (for cursor
/// pruning).
pub fn live_ck_hints(net: ChiaNet, ck: &[u8; 32], peak: u32) -> Vec<[u8; 32]> {
    scan_eras(peak).into_iter().map(|era| chia_lane::derive_ck_hint(net, ck, era)).collect()
}

// ── #231 P6b: the inbox (knocks sealed to us) and the public beacons ────────

/// Open one knock ciphertext read under our inbox hint for `era`: sealed to
/// our card key UNDER the coin that carried it (`carrier_parent`, the coin's
/// parent — a copy of the blob under another coin does not open, #272 review
/// round 3) and WITH the room's secret lane token (`lane`: a writer without the
/// room key cannot seal one, round 5), signed by its knocker, filed in its own era, not expired, not
/// from the far future, and naming `lane_id` (the room the hint was read for)
/// among its rooms, and sealed on `net` (stage 4 design §3.5). `None` for
/// anything else.
pub fn decode_knock_for(
    net: ChiaNet,
    kx_secret: &[u8; 32],
    ciphertext: &[u8],
    carrier_parent: &[u8; 32],
    lane: &[u8; 32],
    era: u64,
    confirmed_height: u32,
    now: u64,
    lane_id: &[u8; chia_lane::ROOM_LANE_ID_LEN],
) -> Option<chia_lane::KnockV2> {
    if chia_lane::era_of(confirmed_height) != era {
        return None;
    }
    let plain = chia_lane::open_with_kx(net, kx_secret, chia_lane::KIND_KNOCK, era, carrier_parent, lane, ciphertext).ok()?;
    let knock = chia_lane::decode_knock_v2(&plain, era).ok()?;
    if knock.expires_at < now || knock.issued_at > now.saturating_add(MAX_FUTURE_SKEW_V2_SECS) {
        return None;
    }
    knock.rooms.contains(lane_id).then_some(knock)
}

/// One incremental read of our INBOX for `room`'s lane: both scan eras' hints
/// under our contact key and the room's lane token on `net`, cursors kept by
/// the caller per hint, the same transactional failure rule as [`read_ck`].
pub async fn read_inbox(
    net: ChiaNet,
    client: &impl ChainAccess,
    kx_secret: &[u8; 32],
    own_ck: &[u8; 32],
    room_key: &[u8; 32],
    room_id: &str,
    peak: u32,
    now: u64,
    cursors: &mut std::collections::HashMap<[u8; 32], HintCursor>,
) -> Result<Vec<FoundItem<chia_lane::KnockV2>>> {
    let lane = chia_lane::derive_lane_token(room_key);
    let lane_id = chia_lane::room_lane_id(room_id);
    let mut found = Vec::new();
    let mut first_error: Option<anyhow::Error> = None;
    let mut any_ok = false;
    for era in scan_eras(peak) {
        let hint = chia_lane::derive_inbox_hint(net, own_ck, &lane, era);
        let cursor = cursors.entry(hint).or_default();
        let before = cursor.clone();
        let opener = |ct: &[u8], parent: Bytes32, height: u32| decode_knock_for(net, kx_secret, ct, &parent.to_bytes(), &lane, era, height, now, &lane_id);
        match read_hint_items(client, Bytes32::new(hint), cursor, &opener).await {
            Ok(items) => {
                any_ok = true;
                found.extend(items);
            }
            Err(e) => {
                cursor.roll_back(before);
                if first_error.is_none() {
                    first_error = Some(e);
                }
            }
        }
    }
    match first_error {
        Some(e) if !any_ok => Err(e),
        Some(e) => {
            eprintln!("⛓️ ChiaHub inbox: one of a room's era hints failed and will be re-read next beat: {e:#}");
            Ok(found)
        }
        None => Ok(found),
    }
}

/// The inbox hints of `room` in play at `peak` on `net` (for cursor pruning).
pub fn live_inbox_hints(net: ChiaNet, own_ck: &[u8; 32], room_key: &[u8; 32], peak: u32) -> Vec<[u8; 32]> {
    let lane = chia_lane::derive_lane_token(room_key);
    scan_eras(peak).into_iter().map(|era| chia_lane::derive_inbox_hint(net, own_ck, &lane, era)).collect()
}

/// Beacons a reader keeps: the newest by signed time, one per node.
pub const BEACONS_KEPT: usize = 20;

/// One beacon record read under the era's public hint: signed, in its era,
/// not expired, not from the far future.
pub fn decode_beacon_for(ciphertext: &[u8], era: u64, confirmed_height: u32, now: u64) -> Option<chia_lane::BeaconV2> {
    if chia_lane::era_of(confirmed_height) != era {
        return None;
    }
    let beacon = chia_lane::decode_beacon_v2(ciphertext, era).ok()?;
    if beacon.expires_at < now || beacon.issued_at > now.saturating_add(MAX_FUTURE_SKEW_V2_SECS) {
        return None;
    }
    Some(beacon)
}

/// Newest first, one per node: the order beacon readers rank in.
pub fn rank_beacons(mut found: Vec<FoundItem<chia_lane::BeaconV2>>) -> Vec<FoundItem<chia_lane::BeaconV2>> {
    found.sort_by(|a, b| {
        b.item.issued_at.cmp(&a.item.issued_at).then_with(|| b.confirmed_height.cmp(&a.confirmed_height))
    });
    let mut seen: HashSet<iroh::PublicKey> = HashSet::new();
    found.retain(|f| seen.insert(f.item.node_id));
    found.truncate(BEACONS_KEPT);
    found
}

/// ONE-SHOT: the newest [`BEACONS_KEPT`] beacons of this era and the last —
/// the public entry points a newcomer with nobody to dial may try (D7). The
/// hint is derivable by anyone and may be flooded or pre-filled: the one-shot
/// budget bounds the read and the newest-first order keeps what matters. The
/// hints are `net`'s (stage 4 design §3.5).
pub async fn read_beacons(net: ChiaNet, client: &impl ChainAccess, peak: u32, now: u64) -> Result<Vec<FoundItem<chia_lane::BeaconV2>>> {
    let mut all = Vec::new();
    let mut cursors: std::collections::HashMap<[u8; 32], HintCursor> = std::collections::HashMap::new();
    for round in 1..=ONE_SHOT_MAX_ROUNDS {
        for era in scan_eras(peak) {
            let hint = chia_lane::derive_beacon_hint(net, era);
            let cursor = cursors.entry(hint).or_default();
            let opener = |ct: &[u8], _parent: Bytes32, height: u32| decode_beacon_for(ct, era, height, now);
            all.extend(read_hint_items(client, Bytes32::new(hint), cursor, &opener).await?);
        }
        if !cursors.values().any(|c| c.has_more()) {
            break;
        }
        if round == ONE_SHOT_MAX_ROUNDS {
            eprintln!("⛓️ ChiaHub beacons: the beacon hints still had more after {round} rounds — budget spent, taking the newest read");
        }
    }
    Ok(rank_beacons(all))
}

/// The heights at which the given coins were SPENT, for those the chain lists
/// as spent (#231 P6b: one input of a write's standing — a spent input alone
/// proves nothing about the write, see [`write_standing`]). Pages are followed
/// within the poll budget; a coin not yet spent, or not listed, is simply absent.
pub async fn spent_heights(client: &impl ChainAccess, coin_ids: Vec<Bytes32>) -> Result<Vec<(Bytes32, u32)>> {
    if coin_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES_PER_POLL {
        let listing = client
            .coin_records_by_names(coin_ids.clone(), true, page.clone())
            .await
            .map_err(|e| anyhow!("coin lookup by name: {e}"))?;
        out.extend(listing.records.iter().filter(|r| r.spent && r.spent_block_index > 0).map(|r| (r.coin.coin_id(), r.spent_block_index)));
        match (listing.truncated, listing.next_cursor) {
            (true, Some(next)) => page = Some(next),
            _ => break,
        }
    }
    Ok(out)
}

/// What a lookup by coin id found (#272 review rounds 7 and 9): each of the
/// coins asked for that is on the chain, with the height of the block that
/// holds it, and the height the listing was judged at — the lowest over its
/// pages, none once a page came undated. A coin the listing does not name is
/// gone only if the listing was judged at or past the height the coin was
/// last seen confirmed at ([`crate::chia_knock::coin_word`]): peers still
/// behind that block know nothing of it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CoinHeights {
    pub found: Vec<(Bytes32, u32)>,
    pub judged_at: Option<u32>,
}

/// #231 P6b (#272 review round 7): where the coins named by `coin_ids` stand
/// NOW — each one found, with the height of the block that holds it, and the
/// height the listing was judged at. A coin a listing run to its end does not
/// name is no longer on the chain (a reorganization took its block) — as far
/// as a listing judged at or past its block can tell (round 9); a listing cut
/// short says nothing of the coins it did not reach, so `None` comes back and
/// nothing is judged.
pub async fn coin_heights(client: &impl ChainAccess, coin_ids: Vec<Bytes32>) -> Result<Option<CoinHeights>> {
    if coin_ids.is_empty() {
        return Ok(Some(CoinHeights::default()));
    }
    let mut out = CoinHeights::default();
    let mut undated = false;
    let mut page: Option<String> = None;
    for _ in 0..MAX_PAGES_PER_POLL {
        let listing = client
            .coin_records_by_names(coin_ids.clone(), true, page.take())
            .await
            .map_err(|e| anyhow!("coin lookup by name: {e}"))?;
        out.found.extend(listing.records.iter().map(|r| (r.coin.coin_id(), r.confirmed_block_index)));
        match listing.judged_at {
            Some(h) => out.judged_at = Some(out.judged_at.map_or(h, |lowest| lowest.min(h))),
            None => undated = true,
        }
        match (listing.truncated, listing.next_cursor) {
            (true, Some(next)) => page = Some(next),
            (true, None) => return Ok(None),
            (false, _) => {
                if undated {
                    out.judged_at = None;
                }
                return Ok(Some(out));
            }
        }
    }
    Ok(None)
}

/// #231 P6b: whether a write's own coin sits under `hint` — the coin a
/// spend-to-self creates names the coin it spent as its parent, so the child
/// under the hint whose `parent_coin_info` is the write's INPUT, made by an
/// output that carries the write, is the write itself, confirmed where that
/// child confirmed. The input's spent flag alone says nothing of the write
/// (#272 review): the mempool may have dropped the write and a later spend of
/// ours taken the same coin. Nor does the child's id alone: every write of
/// ours from one input makes the same coin whatever its hint, and a full node
/// never deletes a hint row (a reorganization rolls back the coins, not the
/// hints), so a coin made again by another spend of the input can still be
/// listed under the hint an orphaned block gave it — as it is when two writes
/// of ours from one input under two hints meet across a fork, or one wallet
/// writes from two places. The verdict reads the parent's spend, as every
/// reader does ([`extract_ciphertext`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HintChild {
    /// The write's own coin is under the hint, confirmed at `height`, found
    /// by a lookup judged at `judged_at` (the lowest height over the pages
    /// read up to the one that held it; `None` once a page came undated). That
    /// is the height the answering peers stood at, and bounds how deep THEY
    /// saw the coin (#272 review round 10): a settlement is a lookup's word,
    /// so its depth is measured at the lookup's own height as well as the
    /// agreed peak, and an undated lookup settles nothing. Its parent's spend,
    /// read at `height`, makes it by an output whose first memo is the hint
    /// and which carries a second memo, the one a reader opens: of the digest
    /// the write's mark keeps ([`memo_digest`]), or, for an older node's mark
    /// that keeps none, any second memo — which tells a write under another
    /// hint apart, but not another write of ours under this one.
    Confirmed { height: u32, judged_at: Option<u32> },
    /// The listing ran to its end and no coin under the hint is the write's:
    /// none names the input as its parent, or the one that does was made by
    /// another spend of the input (a stale row), its output carrying another
    /// hint, no second memo, or — only when the write's mark keeps a digest —
    /// a second memo of another digest; judged at this height (`None`: the
    /// source gave none).
    Absent { judged_at: Option<u32> },
    /// The listing was cut short before its end, or the parent's spend at the
    /// child's height does not make the child (no spend there, or none with
    /// its output), or a later coin of the parent's is listed at another
    /// height than its spend was fetched at: the listing and the spend
    /// disagree, a reorganization between the requests, and nothing can be
    /// said yet.
    Unknown,
}

impl HintChild {
    /// Does this word say a write CONFIRMED at `confirmed` is no longer there
    /// (#272 review round 9)? Only a listing run to its end, judged at or past
    /// that height, without the write. A listing judged below it — replacement
    /// peers still behind the block that holds the write — or one undated says
    /// nothing of it, nor does one cut short; and nothing is said of a write
    /// never confirmed (`confirmed` 0).
    pub fn gone_since(&self, confirmed: u32) -> bool {
        confirmed != 0 && matches!(self, HintChild::Absent { judged_at: Some(judged) } if *judged >= confirmed)
    }
}

/// Look for the write that spent `parent` among the coins under `hint`,
/// paging within the poll budget. A coin listed with `parent` as its parent
/// is the write's only if its parent's spend, fetched at the coin's height
/// ([`fetch_coin_spend`], one request per lookup however many listed coins
/// name the parent: every coin a spend makes confirms in its one block),
/// makes it by an output carrying the write ([`carries_write`]): the hint as
/// its first memo and, given `memo` (the digest the write's mark keeps,
/// [`memo_digest`]), a second memo of that digest — given none (an older
/// node's mark), any second memo, which still tells a write under another
/// hint apart. A listed coin whose output carries anything else is a stale
/// row, passed over: the listing goes on, and ends as it would without it.
/// No spend at the coin's height, a spend that does not make the coin, or a
/// later coin of the parent's listed at another height than the spend was
/// fetched at: the listing and the spend disagree, and nothing is judged
/// ([`HintChild::Unknown`]). A spend that cannot be fetched is an error, as
/// a listing that cannot be read is: no verdict this tick.
pub async fn child_under_hint(client: &impl ChainAccess, hint: Bytes32, parent: Bytes32, memo: Option<Bytes32>) -> Result<HintChild> {
    let mut page: Option<String> = None;
    let mut judged_at: Option<u32> = None;
    let mut undated = false;
    // The parent's spend once fetched, with the height it was fetched at.
    let mut spend: Option<(u32, PuzzleAndSolution)> = None;
    for _ in 0..MAX_PAGES_PER_POLL {
        let listing = client
            .coin_records_by_hint(hint, None, true, page.take())
            .await
            .map_err(|e| anyhow!("hint lookup: {e}"))?;
        match listing.judged_at {
            Some(h) => judged_at = Some(judged_at.map_or(h, |lowest| lowest.min(h))),
            None => undated = true,
        }
        for rec in listing.records.iter().filter(|r| r.coin.parent_coin_info == parent) {
            let height = rec.confirmed_block_index;
            let (fetched_at, parent_spend) = match spend.take() {
                Some((fetched_at, _)) if fetched_at != height => return Ok(HintChild::Unknown),
                Some(fetched) => fetched,
                None => match fetch_coin_spend(client, parent, height).await? {
                    Some(fetched) => (height, fetched),
                    None => return Ok(HintChild::Unknown),
                },
            };
            let carried = carries_write(&parent_spend, &rec.coin, hint, memo)?;
            spend = Some((fetched_at, parent_spend));
            match carried {
                Some(true) => return Ok(HintChild::Confirmed { height, judged_at: if undated { None } else { judged_at } }),
                Some(false) => continue,
                None => return Ok(HintChild::Unknown),
            }
        }
        match (listing.truncated, listing.next_cursor) {
            (true, Some(next)) => page = Some(next),
            (true, None) => return Ok(HintChild::Unknown),
            (false, _) => return Ok(HintChild::Absent { judged_at: if undated { None } else { judged_at } }),
        }
    }
    Ok(HintChild::Unknown)
}

/// The wallet lease's word on a write's input (#231 P6b, #272 review round 2):
/// what reconciliation decided about the spend that consumed it, as far as
/// THIS run knows. Asked before the chain is, so a write confirming between
/// the two is seen by the chain lookups and never mistaken for a dropped spend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LeaseWord {
    /// Still parked: the spend may be live in a mempool.
    Parked,
    /// Released because the chain listed the input spent (by this write, or
    /// by another that took the coin): the chain lookups say which. Kept in
    /// the lease file while the spend SETTLES (#272 review round 10), so the
    /// word outlives a restart until the input is spent SETTLED_DEPTH deep.
    Spent,
    /// Released because every peer refused the bundle: the spend will never
    /// land. The one word that can call an unspent input DEAD.
    Dropped,
    /// Nothing known: not parked and no release remembered — a restart, a
    /// lease that was never restored (publishing off), a read-only build.
    Unknown,
}

/// Why a write never landed, as [`WriteStanding::Dead`] names it. A reason
/// is told by its text alone, which the writers' lines and the Phone Book
/// print as it is, so each is one constant, compared and never typed again.
///
/// Every peer refused the spend for good, and its input is still unspent
/// ([`LeaseWord::Dropped`]).
pub const DEAD_DROPPED: &str = "the mempool dropped it";
/// The write's one coin was spent with no coin of the write's under its
/// hint. The same key signed that spend: another write of ours from the
/// coin, or the same words in another wallet.
pub const DEAD_OTHER_SPEND: &str = "its coin went to another spend of ours";
/// A burner's first write lost the lobby dish coin its bundle claimed
/// (stage 4 design §10, a lost race or a redirected claim): the claim is
/// keyless, so anyone's claim can take the coin, and the write is built
/// again from another one ([`WriteStanding::for_coins`]).
pub const DEAD_DISH_CLAIMED: &str = "its dish coin went to another claim";
/// The one coin a listing was written from, its own burner key's, went to a
/// spend that was not this station's: its wallet lease has recorded one
/// spend of the coin, the write's own (stage 4 design §10, a burner spent
/// elsewhere). Only a holder of the listing's key signs for the coin, and
/// two machines on the same words do not share that key (§3.3), so another
/// copy of this station made the spend
/// ([`WriteStanding::by_another_copy`]).
pub const DEAD_FOREIGN: &str = "another copy of this station spent its coin";

/// Where a pending write stands (#231 P6b knocks and beacons, #272 review).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteStanding {
    /// On chain, confirmed at `height`, by a lookup judged at `seen_at`
    /// (`None`: undated), carried through so a settlement is measured at the
    /// lookup's own height ([`crate::chia_knock::settled_by`], #272 review
    /// round 10).
    Confirmed { height: u32, seen_at: Option<u32> },
    /// Never landed, for the reason given: the writer forgets it and may write again.
    Dead(&'static str),
    /// Not settled yet: left as it is, asked again next tick.
    Pending,
}

impl WriteStanding {
    /// This standing as the write's `coins` tell it (stage 4 design §4.4,
    /// §10). A write found by one coin and parked at another is a burner's
    /// first write, the gift g and the dish coin F, and the coin that "went
    /// to another spend" is F: its claim is keyless, so the spend is another
    /// claim, a stranger's as likely as ours, and the death reads
    /// [`DEAD_DISH_CLAIMED`]. A write of one coin, and every other standing,
    /// is left as it is. The two readers that hold a write's coins tell it
    /// so (`chia_publish`'s mark readers and the watcher's knock verdicts).
    pub fn for_coins(self, coins: WriteCoins) -> WriteStanding {
        match self {
            WriteStanding::Dead(DEAD_OTHER_SPEND) if coins.parent != coins.parked => WriteStanding::Dead(DEAD_DISH_CLAIMED),
            other => other,
        }
    }

    /// This standing for a write whose one coin no spend of ours but the
    /// write's own ever consumed: a death by another spend of the coin
    /// ([`DEAD_OTHER_SPEND`]) is then another copy of this station's,
    /// [`DEAD_FOREIGN`] (stage 4 design §10). Every other standing, a lost
    /// dish coin among them, is left as it is. Its caller decides which
    /// writes are such, by the lease's records
    /// (`chia_publish::listing_word`).
    pub fn by_another_copy(self) -> WriteStanding {
        match self {
            WriteStanding::Dead(DEAD_OTHER_SPEND) => WriteStanding::Dead(DEAD_FOREIGN),
            other => other,
        }
    }

    /// Whether the write died to another copy of this station ([`DEAD_FOREIGN`]).
    pub fn is_foreign(&self) -> bool {
        matches!(self, WriteStanding::Dead(DEAD_FOREIGN))
    }
}

/// Judge a pending write from the chain's word: `child` is what sits under its
/// hint ([`child_under_hint`]), `spent_at` the height its input was spent at
/// when the chain lists it spent ([`spent_heights`]), `lease` the wallet
/// lease's word on the input ([`LeaseWord`], asked BEFORE the two lookups).
/// Only the write's OWN coin confirms it: the child its input's spend made by
/// an output carrying the write's hint and memo, what a reader opens (the
/// memo known by the digest the write's mark keeps; an older node's mark
/// keeps none, and any second memo is taken). The
/// same coin listed under the hint but made by another spend of the input (a
/// hint row an orphaned block left, or another write of ours from the input
/// under another hint) is no child of the write's: it reads [`HintChild::Absent`]
/// once the listing ends. An input spent with no child under
/// the hint went to ANOTHER spend of ours — but only on a listing judged at or
/// past that spend, since a source still behind it may not list the child yet.
/// An input unspent is dead only on the lease's word that the peers refused
/// the spend ([`LeaseWord::Dropped`]); still parked, released as spent (the
/// lookups lag the lease then) or unknown to this run, it stays pending —
/// silence never kills a write (#272 review round 2). `held` says whether the
/// lease still holds the write's OWN spend — parked, or settling (#272 review
/// round 12): the two lookups are separate requests, and a reorganization
/// between them can list the input spent by this very spend while the hint's
/// listing, made on the new fork, lacks its child; while the lease holds the
/// spend, the coin went to no other write of ours and the lease pushes the
/// spend again, so the write is pending, not dead. Nothing here is decided by
/// the clock. It is given the heights and the lease's word alone, not the
/// write's coins or who paid for it, so it names every such death
/// [`DEAD_OTHER_SPEND`]; a reader that holds the coins tells a burner's lost
/// dish coin from it ([`WriteStanding::for_coins`]).
pub fn write_standing(child: &HintChild, spent_at: Option<u32>, lease: LeaseWord, held: bool) -> WriteStanding {
    match child {
        HintChild::Confirmed { height, judged_at } => WriteStanding::Confirmed { height: *height, seen_at: *judged_at },
        HintChild::Unknown => WriteStanding::Pending,
        HintChild::Absent { judged_at } => match spent_at {
            Some(_) if held => WriteStanding::Pending,
            Some(spent) if judged_at.is_some_and(|judged| judged >= spent) => WriteStanding::Dead(DEAD_OTHER_SPEND),
            Some(_) => WriteStanding::Pending,
            None if lease == LeaseWord::Dropped => WriteStanding::Dead(DEAD_DROPPED),
            None => WriteStanding::Pending,
        },
    }
}

/// A 32-byte id from its hex, as the node files write them.
pub fn parse_hex32(hex_id: &str) -> Option<Bytes32> {
    let bytes: [u8; 32] = hex::decode(hex_id).ok()?.try_into().ok()?;
    Some(Bytes32::new(bytes))
}

/// The two coins a write is found and judged by (stage 4 design §4.4):
/// `parent`, the coin the write's own coin names as its parent under its
/// hint, which the hint lookup finds it by ([`child_under_hint`]); and
/// `parked`, the on-chain input the wallet lease parked for its spend, which
/// the spent-height lookup ([`spent_heights`]) and the lease's word
/// ([`LeaseWord`]) are about. They are one coin for a spend-to-self of one
/// coin, as every write paid by the SSF wallet's keys is, and a burner's
/// rewrite: the input it consumed, which its new coin names. A burner's
/// first write (`chia_publish`'s claim-and-write, stage 4 design §4.1) has
/// two: the gift g as its parent and the dish coin F as its parked input.
/// A mark or a knock entry files both, the parent as its `coin_id` and the
/// parked input beside it as its `parked` ([`WriteCoins::filed`]); one an
/// older node saved has no `parked`, and reads back as its one coin, as it
/// was judged before. Here, not in the publisher, since the knock verdicts
/// are judged in read-only builds too.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WriteCoins {
    pub parent: Bytes32,
    pub parked: Bytes32,
}

impl WriteCoins {
    /// A write whose parked input is its own coin's parent: a spend-to-self
    /// of one coin, as every write is but a burner's first.
    pub fn one(coin: Bytes32) -> Self {
        Self { parent: coin, parked: coin }
    }

    /// The coins a mark or a knock entry filed (stage 4 design §4.4): its
    /// `coin_id` (hex) as the parent and its `parked` (hex) as the parked
    /// input. An empty `parked` is a mark or an entry an older node saved,
    /// whose one coin is both, so it is judged as it was before. `None` when
    /// either is malformed, as [`parse_hex32`] says, an empty `coin_id`
    /// included: a mark then has nothing to judge, and a knock entry is dead
    /// as malformed. A malformed `parked` never falls back to the one coin:
    /// a burner's first write filed so would have its input's spent height
    /// and the lease's word read at its gift g, which the lease never parked.
    /// One that never lands (its dish coin F taken by another spend, or its
    /// spend dropped) leaves g on no chain, so it would read pending for ever
    /// instead of dead; one that lands is still confirmed, by its own coin
    /// under the hint, which names g as its parent.
    pub fn filed(coin_id: &str, parked: &str) -> Option<Self> {
        let parent = parse_hex32(coin_id)?;
        if parked.is_empty() {
            return Some(Self::one(parent));
        }
        Some(Self { parent, parked: parse_hex32(parked)? })
    }
}

/// ONE-SHOT: the freshest presence record `node_id` published under its
/// contact key `ck` — the introduction lookup at dial exhaustion (rung 6) once
/// the target's card is known. Reads the chain peak first (the era is the
/// chain's clock), then both scan eras, round after round within the one-shot
/// budget. Records under the hint signed by any OTHER node are discarded
/// before ranking: a contact key is shared with every member of the rooms
/// that received the card, so it locates the hint but never vouches for the
/// signer; only the node's own signature does. The hints and the seal are
/// `net`'s, the network the node runs on.
pub async fn resolve_presence_by_ck(net: ChiaNet, ck: &[u8; 32], node_id: &str) -> Result<Option<ChiaPresenceRecord>> {
    let now = unix_now();
    let client = crate::chia_chain::connect_carrier();
    let peak = peak_height(&client).await.ok_or_else(|| anyhow!("chain peak unavailable"))?;
    let mut all = Vec::new();
    let mut cursors = std::collections::HashMap::new();
    for round in 1..=ONE_SHOT_MAX_ROUNDS {
        all.extend(read_ck(net, &client, ck, peak, now, &mut cursors).await?);
        if !cursors.values().any(|c| c.has_more()) {
            break;
        }
        if round == ONE_SHOT_MAX_ROUNDS {
            eprintln!("⛓️ ChiaHub resolve: a contact key's hints still had more after {round} rounds — budget spent, result may be partial");
        }
    }
    all.retain(|f| f.record.node_id == node_id);
    Ok(rank_and_dedupe(all).into_iter().next().map(|f| f.record))
}

/// How many `read_hint` rounds a ONE-SHOT lookup ([`resolve_all`]) spends per
/// epoch hint when a listing runs past one round's page or parent budget. The
/// watcher carries its cursors from beat to beat and needs no such loop; the
/// one-shot has no next beat, so it keeps reading until the hint is examined
/// or this bound is spent (≤ 32 pages and ≤ 200 parent fetches per hint).
pub const ONE_SHOT_MAX_ROUNDS: usize = 4;

/// Every member's freshest record under `room_key` (P1 `resolve_all`): one
/// full read of the three scan epochs, ranked and de-duplicated. A hint whose
/// listing outruns one round's budget is read on, round after round, until it
/// is examined or [`ONE_SHOT_MAX_ROUNDS`] is spent — never left at page 8.
pub async fn resolve_all(room_key: &[u8; 32]) -> Result<Vec<FoundRecord>> {
    let now = unix_now();
    let client = crate::chia_chain::connect_carrier();
    let mut all = Vec::new();
    for e in scan_epochs(now) {
        let hint = Bytes32::new(chia_lane::derive_hint(room_key, e));
        let mut cursor = HintCursor::default();
        for round in 1..=ONE_SHOT_MAX_ROUNDS {
            all.extend(read_hint(&client, hint, room_key, now, &mut cursor).await?);
            if !cursor.has_more() {
                break;
            }
            if round == ONE_SHOT_MAX_ROUNDS {
                eprintln!(
                    "⛓️ ChiaHub resolve: hint {} still had more after {round} rounds — budget spent, result may be partial",
                    hex::encode(&hint.to_bytes()[..8])
                );
            }
        }
    }
    Ok(rank_and_dedupe(all))
}

/// The freshest record for a SPECIFIC peer (`target_node_id`, the iroh node-id
/// hex) — the introduction lookup at dial-exhaustion (rung 6).
pub async fn resolve_target(
    room_key: &[u8; 32],
    target_node_id: &str,
) -> Result<Option<ChiaPresenceRecord>> {
    Ok(resolve_all(room_key)
        .await?
        .into_iter()
        .find(|f| f.record.node_id == target_node_id)
        .map(|f| f.record))
}

/// The freshest record any member published under `room_key`.
pub async fn resolve_by_room_key(room_key: &[u8; 32]) -> Result<Option<ChiaPresenceRecord>> {
    Ok(resolve_all(room_key).await?.into_iter().next().map(|f| f.record))
}

/// The chain's current peak height, or `None` when the call fails (the caller
/// logs and keeps its last beat).
pub async fn peak_height(client: &impl ChainAccess) -> Option<u32> {
    match client.peak_height().await {
        Ok(height) => Some(height),
        Err(e) => {
            eprintln!("⛓️ ChiaHub reader: peak height {e}");
            None
        }
    }
}

pub(crate) fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(crate) async fn fetch_coin_spend(
    client: &impl ChainAccess,
    coin_id: Bytes32,
    height: u32,
) -> Result<Option<PuzzleAndSolution>> {
    client
        .puzzle_and_solution(coin_id, height)
        .await
        .map_err(|e| anyhow!("puzzle and solution: {e}"))
}

/// Run the parent spend and return the ciphertext (2nd memo) of the create_coin
/// whose FIRST memo is our `hint` — the ecosystem hint convention we published with.
pub(crate) fn extract_ciphertext(coin_spend: &PuzzleAndSolution, hint: Bytes32) -> Result<Option<Vec<u8>>> {
    Ok(created_coins(coin_spend)?
        .into_iter()
        .find(|out| out.memos.len() >= 2 && out.memos[0].as_ref() == hint.as_ref())
        .map(|out| out.memos[1].clone().into_inner()))
}

/// One output of a spend: a CREATE_COIN's puzzle hash and amount, which with
/// the spent coin name the coin it makes, and its memos — empty when it has
/// none, or when they do not read as a list of atoms (no reader takes those).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CreatedCoin {
    pub puzzle_hash: Bytes32,
    pub amount: u64,
    pub memos: Vec<Bytes>,
}

/// THE condition walk over a spend: run its puzzle with its solution and list
/// every CREATE_COIN its conditions hold, in order ([`CreatedCoin`]). The
/// readers take a ciphertext through it ([`extract_ciphertext`]), and the
/// writer's verdict the memos of the output that made its coin
/// ([`output_memos`]). `Err` when the spend does not run, or its result is no
/// list of conditions.
pub(crate) fn created_coins(coin_spend: &PuzzleAndSolution) -> Result<Vec<CreatedCoin>> {
    let mut allocator = Allocator::new();
    let puzzle: NodePtr = coin_spend
        .puzzle_reveal
        .to_clvm(&mut allocator)
        .map_err(|e| anyhow!("puzzle_reveal to_clvm: {e:?}"))?;
    let solution: NodePtr = coin_spend
        .solution
        .to_clvm(&mut allocator)
        .map_err(|e| anyhow!("solution to_clvm: {e:?}"))?;
    let output = run_puzzle(&mut allocator, puzzle, solution)
        .map_err(|e| anyhow!("run_puzzle: {e:?}"))?;
    let conditions = Conditions::<NodePtr>::from_clvm(&allocator, output)
        .map_err(|e| anyhow!("conditions from_clvm: {e:?}"))?;
    let mut created = Vec::new();
    for condition in conditions {
        let Some(create_coin) = condition.into_create_coin() else {
            continue;
        };
        let memos = match create_coin.memos {
            Memos::Some(ptr) => Vec::<Bytes>::from_clvm(&allocator, ptr).unwrap_or_default(),
            Memos::None => Vec::new(),
        };
        created.push(CreatedCoin { puzzle_hash: create_coin.puzzle_hash, amount: create_coin.amount, memos });
    }
    Ok(created)
}

/// The memos of the CREATE_COIN in `coin_spend` that makes the coin of
/// `puzzle_hash` and `amount` — a coin is its parent, puzzle hash and amount,
/// so in its parent's spend the two name its output, and the chain refuses a
/// spend that makes one coin twice — or `None` when the spend makes no such
/// coin ([`created_coins`]).
pub(crate) fn output_memos(coin_spend: &PuzzleAndSolution, puzzle_hash: Bytes32, amount: u64) -> Result<Option<Vec<Bytes>>> {
    Ok(created_coins(coin_spend)?.into_iter().find(|out| out.puzzle_hash == puzzle_hash && out.amount == amount).map(|out| out.memos))
}

/// Does the output of `parent_spend` that makes `coin` carry a write under
/// `hint`: the hint as its first memo, and a second memo beside it, the one a
/// reader opens — of digest `memo`, when one is given ([`memo_digest`])?
/// `None` when the spend makes no such coin ([`output_memos`]).
fn carries_write(parent_spend: &PuzzleAndSolution, coin: &chia_protocol::Coin, hint: Bytes32, memo: Option<Bytes32>) -> Result<Option<bool>> {
    Ok(output_memos(parent_spend, coin.puzzle_hash, coin.amount)?.map(|memos| {
        memos.len() >= 2 && memos[0].as_ref() == hint.as_ref() && memo.is_none_or(|digest| memo_digest(memos[1].as_ref()) == digest)
    }))
}

/// The digest a write's mark keeps of the memo the write carries: SHA-256 of
/// its ciphertext, the second memo of its output, byte for byte as the chain
/// serves it to every reader. So the writer's verdict tells its own output
/// from another write's on the same coin ([`child_under_hint`]) without
/// keeping the bytes. A digest of public chain data: it holds no key
/// material.
pub fn memo_digest(memo: &[u8]) -> Bytes32 {
    Bytes32::new(Sha256::digest(memo).into())
}

/// How old a cached chain peak may be before it is as good as none. The watcher
/// reads the peak once per tick, but a long or stalled scan — or the peers
/// down — can leave it blocks, or an era, behind: a publisher signing by it
/// would write for an era that has ended, and an inbound mark stamped with it
/// would name one. Kept well inside the publisher's eight end-of-era guard
/// blocks (about 150 s of blocks), so a stale peak never walks a write past
/// the guard either.
pub const PEAK_MAX_AGE_SECS: u64 = 90;

/// The chain peak as last read, and when (unix seconds), as ONE value: a reader
/// never pairs an old height with a newer time. `Default` is "none yet".
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChainPeak {
    pub height: u32,
    pub seen_at: u64,
}

impl ChainPeak {
    pub fn new(height: u32, seen_at: u64) -> Self {
        Self { height, seen_at }
    }

    /// The height, when known and read within [`PEAK_MAX_AGE_SECS`] of `now`;
    /// `None` is "ask the chain" (or, for a mark, "judge by elapsed time").
    pub fn fresh(&self, now: u64) -> Option<u32> {
        // A read dated after `now` means the wall clock was set back since: how
        // old the height really is cannot be told, so it is stale (the chain is
        // asked again), not fresh until the clock catches up.
        let age = now.checked_sub(self.seen_at)?;
        (self.height != 0 && age <= PEAK_MAX_AGE_SECS).then_some(self.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_knock_opens_only_under_the_coin_it_was_written_by() {
        // #272 review round 3: a chain observer can copy an inbox hint and its
        // sealed memo into a coin of its own. The sealing binds the carrier's
        // parent (the knocker's input coin), so the copy never decodes.
        let knocker = iroh::SecretKey::generate();
        let host_sk = [11u8; 32];
        let host_pk = curve25519_dalek::MontgomeryPoint::mul_base_clamped(host_sk).to_bytes();
        let era = 7u64;
        let height = 7 * chia_lane::ERA_BLOCKS + 5;
        let now = 1_000u64;
        let lane = chia_lane::room_lane_id("r");
        let lane_token = chia_lane::derive_lane_token(&[9u8; 32]); // the room's secret lane token
        let knock = chia_lane::KnockV2 {
            era,
            from: knocker.public(),
            ck_from: Some([3u8; 32]),
            issued_at: now,
            expires_at: now + 2 * chia_lane::ERA_SECS,
            rooms: vec![lane],
            reply: vec![],
        };
        let plain = chia_lane::encode_knock_v2(&knock, &knocker).unwrap();
        let input = [5u8; 32];
        for net in ChiaNet::ALL {
            let sealed = chia_lane::seal_to_kx(net, &host_pk, chia_lane::KIND_KNOCK, era, &input, &lane_token, &plain).unwrap();
            assert_eq!(decode_knock_for(net, &host_sk, &sealed, &input, &lane_token, era, height, now, &lane), Some(knock.clone()), "{net:?}: under its own coin: the knock");
            assert_eq!(decode_knock_for(net, &host_sk, &sealed, &[6u8; 32], &lane_token, era, height, now, &lane), None, "{net:?}: the same blob under a copier's coin: nothing");
            assert_eq!(decode_knock_for(net, &host_sk, &sealed, &input, &lane_token, era, height + chia_lane::ERA_BLOCKS, now, &lane), None, "{net:?}: outside its era");
            assert_eq!(decode_knock_for(net, &host_sk, &sealed, &input, &lane_token, era, height, now, &chia_lane::room_lane_id("s")), None, "{net:?}: another room");
            // Stage 4 design §3.5: the network's tag is in the seal's
            // associated data, so the knock read on the other network is
            // nothing too.
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            assert_eq!(decode_knock_for(other, &host_sk, &sealed, &input, &lane_token, era, height, now, &lane), None, "{net:?}: read on {other:?}");
        }
    }

    #[test]
    fn a_knock_sealed_without_the_rooms_key_does_not_open_under_its_hint() {
        // #272 review round 5: the inbox hint is public on chain and the host's
        // card key rides in every room's pass, so a holder of the host's card
        // from ANOTHER room, knowing this room's id, could seal fresh knocks of
        // its own under an observed hint. The sealing binds the room's secret
        // lane token (derived from the room key), which that writer lacks.
        let knocker = iroh::SecretKey::generate();
        let host_sk = [11u8; 32];
        let host_pk = curve25519_dalek::MontgomeryPoint::mul_base_clamped(host_sk).to_bytes();
        let era = 7u64;
        let height = 7 * chia_lane::ERA_BLOCKS + 5;
        let now = 1_000u64;
        let lane_id = chia_lane::room_lane_id("r");
        let lane_token = chia_lane::derive_lane_token(&[9u8; 32]);
        let knock = chia_lane::KnockV2 {
            era,
            from: knocker.public(),
            ck_from: None,
            issued_at: now,
            expires_at: now + 2 * chia_lane::ERA_SECS,
            rooms: vec![lane_id],
            reply: vec![],
        };
        let plain = chia_lane::encode_knock_v2(&knock, &knocker).unwrap();
        let input = [5u8; 32];
        for net in ChiaNet::ALL {
            for stranger in [chia_lane::derive_lane_token(&[10u8; 32]), [0u8; 32]] {
                let forged = chia_lane::seal_to_kx(net, &host_pk, chia_lane::KIND_KNOCK, era, &input, &stranger, &plain).unwrap();
                assert_eq!(
                    decode_knock_for(net, &host_sk, &forged, &input, &lane_token, era, height, now, &lane_id),
                    None,
                    "{net:?}: sealed with another room's lane, or none: not a knock on this room, under the right hint or not"
                );
            }
            let genuine = chia_lane::seal_to_kx(net, &host_pk, chia_lane::KIND_KNOCK, era, &input, &lane_token, &plain).unwrap();
            assert_eq!(decode_knock_for(net, &host_sk, &genuine, &input, &lane_token, era, height, now, &lane_id), Some(knock.clone()), "{net:?}");
        }
    }

    fn sealed_record(room_key: &[u8; 32], sk: &iroh::SecretKey, issued_at: u64, expires_at: u64) -> Vec<u8> {
        let record = ChiaPresenceRecord {
            kx_pk: None,
            addr_flags: vec![],
            v: 1,
            node_id: sk.public().to_string(),
            addrs: vec!["[2001:db8::1]:4445".into(), "198.51.100.7:4444".into()],
            relay_urls: vec![],
            issued_at,
            expires_at,
        };
        let blob = chia_lane::encode_signed(&record, sk).unwrap();
        chia_lane::seal(room_key, &blob).unwrap()
    }

    fn found(node: &str, issued_at: u64, height: u32) -> FoundRecord {
        FoundRecord {
            record: ChiaPresenceRecord {
            kx_pk: None,
            addr_flags: vec![],
                v: 1,
                node_id: node.to_string(),
                addrs: vec![],
                relay_urls: vec![],
                issued_at,
                expires_at: 0,
            },
            coin_id: Bytes32::new([height as u8; 32]),
            confirmed_height: height,
            hint: Bytes32::new([1u8; 32]),
        }
    }

    #[test]
    fn a_cached_peak_is_the_era_clock_only_while_fresh() {
        let now = 1_700_000_000u64;
        assert_eq!(ChainPeak::default().fresh(now), None, "no peak read yet");
        assert_eq!(ChainPeak::new(100, now).fresh(now), Some(100), "just read");
        assert_eq!(ChainPeak::new(100, now - PEAK_MAX_AGE_SECS).fresh(now), Some(100), "at the bound: still the clock");
        assert_eq!(ChainPeak::new(100, now - PEAK_MAX_AGE_SECS - 1).fresh(now), None, "older: ask the chain");
        assert_eq!(ChainPeak::new(100, now + 5).fresh(now), None, "a read dated in the future (clock set back) is stale, not fresh forever");
    }

    /// Room-keyed (v1) records are read on a test network only: off one no
    /// station writes them, and their hints carry no network tag.
    #[test]
    fn v1_room_records_are_read_on_a_test_network_only() {
        assert!(reads_v1(ChiaNet::Testnet11));
        assert!(!reads_v1(ChiaNet::Mainnet));
        for net in ChiaNet::ALL {
            assert_eq!(reads_v1(net), net.is_test(), "{net:?}");
        }
        // The dial that ran out of routes asks the rule before its one
        // lookup of a room's v1 record (`main.rs`; the watcher's own test
        // covers its beat). Read from the source, and joined here so that
        // these lines are not counted.
        let main = include_str!("main.rs");
        let gate = ["if cap.may_read() && chia_resolve::reads_v1", "chia_network::net()) {"].join("(");
        let lookup = ["chia_resolve::resolve_target", "&cap.room_key, &target_str)"].join("(");
        assert_eq!(main.matches(&["resolve_target", ""].join("(")).count(), 1, "one v1 lookup at a dial's end");
        assert_eq!((main.matches(&gate).count(), main.matches(&lookup).count()), (1, 1));
        let (g, l) = (main.find(&gate).unwrap(), main.find(&lookup).unwrap());
        assert!(g < l && !main[g..l].contains('}'), "the lookup is inside the rule's block");
    }

    #[test]
    fn scan_epochs_covers_next_current_previous() {
        let now = 1_791_700_000; // 2026-10-11
        let e = chia_lane::epoch_now(now);
        assert_eq!(scan_epochs(now), [e + 1, e, e - 1]);
        assert_eq!(scan_epochs(0), [1, 0, 0], "no underflow at genesis");
    }

    #[test]
    fn cursor_resumes_below_last_height_and_bounds_seen_set() {
        let mut c = HintCursor::default();
        assert_eq!(c.start_height(), None, "first read scans the whole hint");
        c.last_height = 10;
        assert_eq!(c.start_height(), Some(0), "overlap saturates at genesis");
        c.last_height = 5_000;
        assert_eq!(c.start_height(), Some(5_000 - CURSOR_OVERLAP_BLOCKS));
        let id = |i: u32| {
            let mut b = [0u8; 32];
            b[..4].copy_from_slice(&i.to_le_bytes());
            b
        };
        for i in 0..(SEEN_CAP as u32) {
            assert!(c.mark_seen(id(i)), "under the bound every id is remembered");
        }
        assert!(c.seen_full());
        assert!(!c.mark_seen(id(u32::MAX)), "at the bound nothing more is remembered…");
        assert_eq!(c.seen.len(), SEEN_CAP, "…and nothing already remembered is forgotten");
        assert!(c.seen.contains(&id(0)), "the oldest examined coin is still known: no clearing");
    }

    #[test]
    fn cursor_continues_a_parked_listing_once_then_starts_fresh() {
        let mut c = HintCursor { last_height: 5_000, ..Default::default() };
        // Nothing parked: a fresh listing from the overlap start, first page.
        let fresh = c.resume();
        assert_eq!(fresh.start, Some(5_000 - CURSOR_OVERLAP_BLOCKS));
        assert_eq!(fresh.page, None);
        assert!(fresh.examined_all);
        assert_eq!(fresh.max_height, 0);

        // A poll that ran out of pages parks where it stopped, under ITS start.
        c.pending = Some(PendingPage {
            start_height: Some(4_968),
            next_cursor: "page-9".into(),
            max_height: 5_300,
            examined_all: false,
        });
        let resumed = c.resume();
        assert_eq!(resumed.start, Some(4_968), "a cursor is only valid for the query that made it");
        assert_eq!(resumed.page.as_deref(), Some("page-9"));
        assert_eq!(resumed.max_height, 5_300);
        assert!(!resumed.examined_all, "an earlier parent-capped poll taints the whole listing");
        assert!(c.pending.is_none(), "taken: a cursor the peers refuse fails once, then we start fresh");
        assert_eq!(c.last_height, 5_000, "resuming alone never advances the height");
        assert!(!c.has_more(), "nothing parked and no backlog: the hint is examined");
        c.backlog = true;
        assert!(c.has_more(), "an unexamined backlog is 'more to read' for the one-shot loop");
    }

    #[test]
    fn decode_blob_accepts_fresh_rejects_expired_future_and_foreign() {
        let room = [42u8; 32];
        let sk = iroh::SecretKey::generate();
        let now = 1_791_700_000u64;
        let fresh = sealed_record(&room, &sk, now - 60, now + 3600);
        let rec = decode_blob(&room, &fresh, now).expect("fresh record decodes");
        assert_eq!(rec.node_id, sk.public().to_string());
        assert_eq!(rec.addrs.len(), 2);

        let expired = sealed_record(&room, &sk, now - 7200, now - 1);
        assert!(decode_blob(&room, &expired, now).is_none(), "expired record is dropped");

        let never_expires = sealed_record(&room, &sk, now - 60, 0);
        assert!(decode_blob(&room, &never_expires, now).is_some(), "expires_at == 0 means never (until P2 decides)");

        let future = sealed_record(&room, &sk, now + MAX_FUTURE_SKEW_SECS + 1, now + MAX_FUTURE_SKEW_SECS + 3600);
        assert!(decode_blob(&room, &future, now).is_none(), "a record from the far future is refused");

        assert!(decode_blob(&[7u8; 32], &fresh, now).is_none(), "another room's key cannot open it");
    }

    #[test]
    fn ranking_is_by_signed_time_not_height_and_one_per_node() {
        // Replayed old ciphertext confirmed LATER (height 900) must lose to the
        // record whose signed time is newer (height 100).
        let ranked = rank_and_dedupe(vec![
            found("alice", 1_000, 900),
            found("alice", 2_000, 100),
            found("bob", 1_500, 500),
            found("bob", 1_500, 400),
        ]);
        assert_eq!(ranked.len(), 2);
        assert_eq!(ranked[0].record.node_id, "alice");
        assert_eq!(ranked[0].record.issued_at, 2_000);
        assert_eq!(ranked[0].confirmed_height, 100);
        assert_eq!(ranked[1].record.node_id, "bob");
        assert_eq!(ranked[1].confirmed_height, 500, "equal times: the later-confirmed copy wins");
    }

    #[test]
    fn v2_opener_enforces_the_era_rule_and_the_tight_skew() {
        use crate::chia_lane::{encode_presence_v2, seal_v2, AddrEntry, PresenceV2, ERA_BLOCKS, KIND_PRESENCE};
        let sk = iroh::SecretKey::generate();
        let ck = [8u8; 32];
        let now = 1_791_700_000u64;
        let era = 12u64;
        let rec = PresenceV2 {
            era,
            node_id: sk.public(),
            kx_pk: [1u8; 32],
            issued_at: now - 60,
            expires_at: now + 3600,
            addrs: vec![AddrEntry { addr: "198.51.100.7:4444".parse().unwrap(), flags: 1 }],
        };
        let inside = 12 * ERA_BLOCKS + 10;
        for net in ChiaNet::ALL {
            let sealed = seal_v2(net, &ck, KIND_PRESENCE, era, &encode_presence_v2(&rec, &sk).unwrap()).unwrap();
            let got = decode_v2_presence(net, &ck, &sealed, era, inside, now).expect("confirmed inside its era");
            assert_eq!(got.v, 2);
            assert_eq!(got.node_id, sk.public().to_string());
            assert_eq!(got.addrs, vec!["198.51.100.7:4444".to_string()]);
            assert_eq!(got.addr_flags, vec![1]);
            assert!(decode_v2_presence(net, &ck, &sealed, era, 13 * ERA_BLOCKS, now).is_none(), "{net:?}: confirmed in the next era: a pre-fill or a late replay, refused");
            assert!(decode_v2_presence(net, &ck, &sealed, era, 12 * ERA_BLOCKS - 1, now).is_none(), "{net:?}: confirmed before its era: refused");
            assert!(decode_v2_presence(net, &ck, &sealed, era + 1, 13 * ERA_BLOCKS, now).is_none(), "{net:?}: read under the next era's hint: the seal refuses");
            assert!(decode_v2_presence(net, &[9u8; 32], &sealed, era, inside, now).is_none(), "{net:?}: another contact key");
            assert!(decode_v2_presence(net, &ck, &sealed, era, inside, now + 3601).is_none(), "{net:?}: expired");
            // Stage 4 design §3.5: sealed on one network, refused on the other.
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            assert!(decode_v2_presence(other, &ck, &sealed, era, inside, now).is_none(), "{net:?}: read on {other:?}");
            let future = PresenceV2 { issued_at: now + MAX_FUTURE_SKEW_V2_SECS + 1, expires_at: now + 10 * 3600, ..rec.clone() };
            let sealed = seal_v2(net, &ck, KIND_PRESENCE, era, &encode_presence_v2(&future, &sk).unwrap()).unwrap();
            assert!(decode_v2_presence(net, &ck, &sealed, era, inside, now).is_none(), "{net:?}: two hours ahead is too far");
        }
    }

    #[test]
    fn v2_readers_scan_this_era_and_the_last() {
        use crate::chia_lane::ERA_BLOCKS;
        assert_eq!(scan_eras(0), vec![0]);
        assert_eq!(scan_eras(ERA_BLOCKS - 1), vec![0]);
        assert_eq!(scan_eras(ERA_BLOCKS), vec![1, 0]);
        assert_eq!(scan_eras(5 * ERA_BLOCKS + 7), vec![5, 4]);
        let ck = [3u8; 32];
        for net in ChiaNet::ALL {
            let hints = live_ck_hints(net, &ck, 5 * ERA_BLOCKS);
            assert_eq!(hints.len(), 2);
            assert_eq!(hints[0], chia_lane::derive_ck_hint(net, &ck, 5), "{net:?}");
            assert_eq!(hints[1], chia_lane::derive_ck_hint(net, &ck, 4), "{net:?}");
        }
    }

    #[test]
    fn a_write_is_judged_by_its_own_coin_under_the_hint_not_by_its_spent_input() {
        use LeaseWord::{Dropped, Parked, Spent, Unknown};
        let absent = |judged_at| HintChild::Absent { judged_at };
        let found = |judged_at| HintChild::Confirmed { height: 900, judged_at };
        assert_eq!(write_standing(&found(Some(950)), Some(900), Spent, false), WriteStanding::Confirmed { height: 900, seen_at: Some(950) });
        assert_eq!(write_standing(&found(None), None, Parked, false), WriteStanding::Confirmed { height: 900, seen_at: None }, "the child is the proof, whatever the input says; the lookup's own height rides along (round 10)");
        assert_eq!(write_standing(&HintChild::Unknown, Some(900), Dropped, false), WriteStanding::Pending, "a listing cut short decides nothing");
        assert_eq!(write_standing(&absent(Some(950)), Some(900), Parked, false), WriteStanding::Dead("its coin went to another spend of ours"));
        assert_eq!(write_standing(&absent(Some(900)), Some(900), Spent, false), WriteStanding::Dead("its coin went to another spend of ours"), "judged at the spend itself is enough");
        assert_eq!(write_standing(&absent(Some(899)), Some(900), Spent, false), WriteStanding::Pending, "a source behind the spend may not list the child yet");
        assert_eq!(write_standing(&absent(None), Some(900), Spent, false), WriteStanding::Pending, "an undated listing cannot say");
        assert_eq!(write_standing(&absent(Some(950)), None, Parked, false), WriteStanding::Pending, "unspent and still parked: the spend may be live in a mempool");
        assert_eq!(write_standing(&absent(Some(950)), None, Dropped, false), WriteStanding::Dead("the mempool dropped it"));
        assert_eq!(write_standing(&absent(None), None, Dropped, false), WriteStanding::Dead("the mempool dropped it"), "the lease's verdict needs no height");
        // The race (#272 review round 2): the write confirmed after the lease
        // reconciled (it released the input as spent) but the chain lookups,
        // made first, still showed the input unspent and no child — not dead.
        assert_eq!(write_standing(&absent(Some(950)), None, Spent, false), WriteStanding::Pending, "released as spent: the lookups lag the lease, the write is not dead");
        // A lease that knows nothing of the coin (a restart, publishing off, a
        // read-only build) never kills a write.
        assert_eq!(write_standing(&absent(Some(950)), None, Unknown, false), WriteStanding::Pending, "unknown to the lease: pending");
        assert_eq!(write_standing(&absent(None), None, Unknown, false), WriteStanding::Pending);
        // A fork between the two lookups (#272 review round 12): the input
        // lookup listed the coin spent at 1000 — by THIS write's spend — and a
        // reorganization dropped that block before the hint lookup, judged at
        // 1006 on the new fork, found no child. While the lease still holds
        // the spend (settling, or parked again already) the coin went to no
        // other write of ours: pending — the lease pushes the spend again, and
        // the write is found under its hint anew or dies on the lease's word.
        assert_eq!(write_standing(&absent(Some(1006)), Some(1000), Spent, true), WriteStanding::Pending, "settling: a fork between the lookups, not another spend");
        assert_eq!(write_standing(&absent(Some(1006)), Some(1000), Parked, true), WriteStanding::Pending, "parked again already: the lease pushes it again");
        assert_eq!(write_standing(&absent(Some(1006)), Some(1000), Spent, false), WriteStanding::Dead("its coin went to another spend of ours"), "the lease holds no such spend: the coin did go to another write");
        assert_eq!(write_standing(&absent(Some(1006)), Some(1000), Unknown, false), WriteStanding::Dead("its coin went to another spend of ours"), "an older entry with no number is judged as before");
        assert_eq!(write_standing(&found(Some(1006)), Some(1000), Spent, true), WriteStanding::Confirmed { height: 900, seen_at: Some(1006) }, "the child found: confirmed, held or not");
        assert_eq!(write_standing(&absent(Some(1006)), None, Parked, true), WriteStanding::Pending, "unspent and held: live in a mempool");
    }

    /// Stage 4 design §10: a death by another spend of the write's coin is
    /// told by the coins the write is judged by, and for a listing by whose
    /// spend took its coin. Every other standing passes through both
    /// untouched, and the four reasons keep their texts.
    #[test]
    fn a_dead_write_is_told_by_its_coins_and_a_listings_by_who_took_its_coin() {
        use WriteStanding::{Confirmed, Dead, Pending};
        assert_eq!(DEAD_DROPPED, "the mempool dropped it");
        assert_eq!(DEAD_OTHER_SPEND, "its coin went to another spend of ours");
        assert_eq!(DEAD_DISH_CLAIMED, "its dish coin went to another claim");
        assert_eq!(DEAD_FOREIGN, "another copy of this station spent its coin");
        let (a, b) = (Bytes32::new([1u8; 32]), Bytes32::new([2u8; 32]));
        let one = WriteCoins::one(a);
        let split = WriteCoins { parent: a, parked: b };
        let every = [
            Confirmed { height: 900, seen_at: Some(950) },
            Confirmed { height: 900, seen_at: None },
            Pending,
            Dead(DEAD_DROPPED),
            Dead(DEAD_OTHER_SPEND),
            Dead(DEAD_DISH_CLAIMED),
            Dead(DEAD_FOREIGN),
        ];
        for standing in every {
            let other_spend = standing == Dead(DEAD_OTHER_SPEND);
            assert_eq!(standing.clone().for_coins(one), standing, "one coin: as it was");
            let lost_dish = if other_spend { Dead(DEAD_DISH_CLAIMED) } else { standing.clone() };
            assert_eq!(standing.clone().for_coins(split), lost_dish, "two coins: the parked one is the dish's");
            let foreign = if other_spend { Dead(DEAD_FOREIGN) } else { standing.clone() };
            assert_eq!(standing.clone().by_another_copy(), foreign);
            assert_eq!(standing.is_foreign(), standing == Dead(DEAD_FOREIGN), "{standing:?}");
        }
        // A burner's first write that lost its dish coin is never another
        // copy's doing: told by its coins first, it is no longer the death
        // the listing's verdict retells.
        assert_eq!(Dead(DEAD_OTHER_SPEND).for_coins(split).by_another_copy(), Dead(DEAD_DISH_CLAIMED));
        assert_eq!(Dead(DEAD_OTHER_SPEND).for_coins(one).by_another_copy(), Dead(DEAD_FOREIGN));
    }

    /// A chain whose listings refuse every page cursor (as full nodes do once
    /// a reorganization passed the cursor's position) and answer a fresh
    /// listing from a script of pages; everything else unanswered.
    struct CursorRefusing {
        pages: std::sync::Mutex<std::collections::VecDeque<crate::chia_chain::CoinListing>>,
        fresh_listings: std::sync::Mutex<usize>,
    }

    fn unanswered() -> crate::chia_chain::ChainError {
        crate::chia_chain::ChainError::Unanswered(anyhow!("test chain"))
    }

    impl crate::chia_chain::ChainAccess for CursorRefusing {
        fn coin_records_by_hint(
            &self,
            _hint: Bytes32,
            _start_height: Option<u32>,
            _include_spent: bool,
            cursor: Option<String>,
        ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, crate::chia_chain::ChainError>> + Send {
            let answer = if cursor.is_some() {
                Err(crate::chia_chain::ChainError::Unanswered(anyhow!("cursor refused (test chain)")))
            } else {
                *self.fresh_listings.lock().unwrap() += 1;
                self.pages.lock().unwrap().pop_front().ok_or_else(unanswered)
            };
            async move { answer }
        }

        fn coin_records_by_puzzle_hash(
            &self,
            _puzzle_hash: Bytes32,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn coin_records_by_names(
            &self,
            _names: Vec<Bytes32>,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn puzzle_and_solution(
            &self,
            _coin_id: Bytes32,
            _height: u32,
        ) -> impl std::future::Future<Output = Result<Option<PuzzleAndSolution>, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn peak_height(&self) -> impl std::future::Future<Output = Result<u32, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn spend_live(&self, _bundle: chia_protocol::SpendBundle) -> impl std::future::Future<Output = Result<bool, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn push_tx(&self, _bundle: chia_protocol::SpendBundle) -> impl std::future::Future<Output = Result<(), crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }
    }

    #[tokio::test]
    async fn a_refused_page_cursor_is_dropped_so_the_next_inbox_read_starts_fresh() {
        // #272 review round 7: a listing parked mid-way (page budget spent)
        // resumes from the peers' cursor; after a reorganization the peers
        // refuse that cursor. `resume` takes it so the refusal happens once —
        // but the failed read's rollback put it back, so the hint was refused
        // every beat and never read again until it rotated out.
        use crate::chia_chain::CoinListing;
        let empty = || CoinListing { records: vec![], truncated: false, next_cursor: None, judged_at: Some(10 * chia_lane::ERA_BLOCKS) };
        // On each network: the hints are its own (stage 4 design §3.5).
        for net in ChiaNet::ALL {
            let chain = CursorRefusing { pages: std::sync::Mutex::new(vec![empty(), empty(), empty(), empty()].into()), fresh_listings: std::sync::Mutex::new(0) };
            let (kx_secret, own_ck, room_key) = ([11u8; 32], [12u8; 32], [13u8; 32]);
            let peak = 10 * chia_lane::ERA_BLOCKS + 5;
            let lane = chia_lane::derive_lane_token(&room_key);
            let parked = chia_lane::derive_inbox_hint(net, &own_ck, &lane, chia_lane::era_of(peak));
            let mut cursors = std::collections::HashMap::new();
            cursors.insert(
                parked,
                HintCursor {
                    last_height: peak - 100,
                    pending: Some(PendingPage { start_height: Some(peak - 200), next_cursor: "stale".into(), max_height: peak - 100, examined_all: true }),
                    ..Default::default()
                },
            );
            // Beat 1: the parked hint's cursor is refused (the other era's hint reads fine).
            assert!(read_inbox(net, &chain, &kx_secret, &own_ck, &room_key, "r", peak, 1_000, &mut cursors).await.unwrap().is_empty());
            let after = &cursors[&parked];
            assert_eq!(after.pending, None, "the refused cursor is not kept");
            assert!(after.backlog, "there is still something to read");
            assert_eq!(after.last_height, peak - 100, "nothing examined moved");
            assert_eq!(*chain.fresh_listings.lock().unwrap(), 1, "the other era listed fresh");
            // Beat 2: a fresh listing for the hint, accepted, instead of the same refusal.
            assert!(read_inbox(net, &chain, &kx_secret, &own_ck, &room_key, "r", peak, 1_000, &mut cursors).await.unwrap().is_empty());
            assert_eq!(*chain.fresh_listings.lock().unwrap(), 3, "both eras listed fresh");
            let after = &cursors[&parked];
            assert_eq!(after.pending, None);
            assert!(!after.backlog, "the listing ran to its end");
        }
    }

    // ── The network tag at the readers and writers (stage 4 design §3.5) ──

    /// A chain that holds memos filed under hints: a listing of a hint
    /// answers every coin filed under it on one page, whatever its start
    /// height or cursor; the parent spend of each such coin makes it with
    /// `[hint, memo]` as its memos; and each hint a listing asked for is
    /// kept, in order. Everything else is unanswered.
    #[derive(Default)]
    struct MemoChain {
        filed: std::collections::HashMap<Bytes32, Vec<crate::chia_chain::CoinRecord>>,
        spends: std::collections::HashMap<Bytes32, PuzzleAndSolution>,
        asked: std::sync::Mutex<Vec<[u8; 32]>>,
    }

    impl MemoChain {
        /// File `memo` under `hint` in a coin confirmed at `height`, made by
        /// the spend of the coin `parent` (the writer's input coin, which a
        /// knock's seal binds). The parent's puzzle is `1`, which returns its
        /// solution: one CREATE_COIN (opcode 51) whose memos are `[hint, memo]`
        /// ([`crate::chia_chain::testing::memo_spend`]).
        fn file(&mut self, hint: Bytes32, memo: Vec<u8>, parent: [u8; 32], height: u32) {
            let parent = Bytes32::new(parent);
            let coin = chia_protocol::Coin::new(parent, Bytes32::new([0x5a; 32]), 1);
            self.spends.insert(parent, crate::chia_chain::testing::memo_spend(&coin, hint, &memo));
            let record = crate::chia_chain::CoinRecord { coin, confirmed_block_index: height, spent: false, spent_block_index: 0 };
            self.filed.entry(hint).or_default().push(record);
        }

        /// The hints listed since the last call, in the order asked.
        fn asked(&self) -> Vec<[u8; 32]> {
            std::mem::take(&mut *self.asked.lock().unwrap())
        }
    }

    impl crate::chia_chain::ChainAccess for MemoChain {
        fn coin_records_by_hint(
            &self,
            hint: Bytes32,
            _start_height: Option<u32>,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, crate::chia_chain::ChainError>> + Send {
            self.asked.lock().unwrap().push(hint.to_bytes());
            let records = self.filed.get(&hint).cloned().unwrap_or_default();
            async move { Ok(crate::chia_chain::CoinListing { records, truncated: false, next_cursor: None, judged_at: None }) }
        }

        fn coin_records_by_puzzle_hash(
            &self,
            _puzzle_hash: Bytes32,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn coin_records_by_names(
            &self,
            _names: Vec<Bytes32>,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn puzzle_and_solution(
            &self,
            coin_id: Bytes32,
            _height: u32,
        ) -> impl std::future::Future<Output = Result<Option<PuzzleAndSolution>, crate::chia_chain::ChainError>> + Send {
            let spend = self.spends.get(&coin_id).cloned();
            async move { Ok(spend) }
        }

        fn peak_height(&self) -> impl std::future::Future<Output = Result<u32, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn spend_live(&self, _bundle: chia_protocol::SpendBundle) -> impl std::future::Future<Output = Result<bool, crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }

        fn push_tx(&self, _bundle: chia_protocol::SpendBundle) -> impl std::future::Future<Output = Result<(), crate::chia_chain::ChainError>> + Send {
            async { Err(unanswered()) }
        }
    }

    /// Stage 4 design §3.5 at the readers: on each network, `read_ck`,
    /// `read_inbox` and `read_beacons` ask the chain for that network's hints
    /// of both scan eras and for no other, and the hints the watcher keeps
    /// cursors for (`live_ck_hints`, `live_inbox_hints`) are the ones those
    /// reads ask for, so it never prunes a cursor a read still uses. The
    /// readers take the network as an argument and never read the
    /// environment, so CI's mainnet step cannot see one that drops it; this
    /// test does.
    #[tokio::test]
    async fn each_reader_asks_the_chain_for_its_own_networks_hints_alone() {
        let (ck, kx_secret, room_key) = ([21u8; 32], [22u8; 32], [23u8; 32]);
        let lane = chia_lane::derive_lane_token(&room_key);
        let peak = 12 * chia_lane::ERA_BLOCKS + 50;
        let eras = scan_eras(peak);
        assert_eq!(eras, vec![12, 11]);
        let chain = MemoChain::default();
        for net in ChiaNet::ALL {
            assert!(read_ck(net, &chain, &ck, peak, 1_000, &mut std::collections::HashMap::new()).await.unwrap().is_empty());
            let want: Vec<[u8; 32]> = eras.iter().map(|e| chia_lane::derive_ck_hint(net, &ck, *e)).collect();
            assert_eq!(chain.asked(), want, "{net:?}: read_ck");
            assert_eq!(live_ck_hints(net, &ck, peak), want, "{net:?}: the contact-key cursors kept");

            let read = read_inbox(net, &chain, &kx_secret, &ck, &room_key, "r", peak, 1_000, &mut std::collections::HashMap::new()).await.unwrap();
            assert!(read.is_empty());
            let want: Vec<[u8; 32]> = eras.iter().map(|e| chia_lane::derive_inbox_hint(net, &ck, &lane, *e)).collect();
            assert_eq!(chain.asked(), want, "{net:?}: read_inbox");
            assert_eq!(live_inbox_hints(net, &ck, &room_key, peak), want, "{net:?}: the inbox cursors kept");

            assert!(read_beacons(net, &chain, peak, 1_000).await.unwrap().is_empty());
            let want: Vec<[u8; 32]> = eras.iter().map(|e| chia_lane::derive_beacon_hint(net, *e)).collect();
            assert_eq!(chain.asked(), want, "{net:?}: read_beacons, one round");
        }
    }

    /// Stage 4 design §3.5 end to end at the readers: with each network's
    /// listing, knock and beacon filed in one chain under that network's
    /// hints and sealed on that network, each by a node of its own, a read on
    /// a network returns that network's node alone. A reader that took the
    /// other network's hint finds only the other network's records, which
    /// its seal refuses (the beacon, in the clear, would name the other
    /// node), and one that opened with the other network's seal refuses its
    /// own: either way it fails here.
    #[tokio::test]
    async fn a_record_filed_on_one_network_is_read_on_that_network_alone() {
        use crate::chia_lane::{AddrEntry, BeaconV2, KnockV2, PresenceV2, ERA_BLOCKS, KIND_KNOCK, KIND_PRESENCE};
        let (ck, kx_secret, room_key) = ([21u8; 32], [22u8; 32], [23u8; 32]);
        let kx_public = curve25519_dalek::MontgomeryPoint::mul_base_clamped(kx_secret).to_bytes();
        let lane = chia_lane::derive_lane_token(&room_key);
        let (now, era) = (1_791_700_000u64, 12u64);
        let (height, peak) = (12 * ERA_BLOCKS + 10, 12 * ERA_BLOCKS + 50);
        let nodes = ChiaNet::ALL.map(|_| iroh::SecretKey::generate());
        let mut chain = MemoChain::default();
        for (i, (net, sk)) in (0u8..).zip(ChiaNet::ALL.into_iter().zip(&nodes)) {
            let addrs = vec![AddrEntry { addr: "198.51.100.7:4444".parse().unwrap(), flags: 1 }];
            let listing = PresenceV2 { era, node_id: sk.public(), kx_pk: [1u8; 32], issued_at: now - 60, expires_at: now + 3600, addrs };
            let sealed = chia_lane::seal_v2(net, &ck, KIND_PRESENCE, era, &chia_lane::encode_presence_v2(&listing, sk).unwrap()).unwrap();
            chain.file(Bytes32::new(chia_lane::derive_ck_hint(net, &ck, era)), sealed, [0x30 + i; 32], height);
            let knock = KnockV2 { era, from: sk.public(), ck_from: None, issued_at: now - 60, expires_at: now + 3600, rooms: vec![chia_lane::room_lane_id("r")], reply: vec![] };
            let input = [0x40 + i; 32];
            let sealed = chia_lane::seal_to_kx(net, &kx_public, KIND_KNOCK, era, &input, &lane, &chia_lane::encode_knock_v2(&knock, sk).unwrap()).unwrap();
            chain.file(Bytes32::new(chia_lane::derive_inbox_hint(net, &ck, &lane, era)), sealed, input, height);
            let beacon = BeaconV2 { era, node_id: sk.public(), issued_at: now - 60, expires_at: now + 3600 };
            let plain = chia_lane::encode_beacon_v2(&beacon, sk).unwrap().to_vec();
            chain.file(Bytes32::new(chia_lane::derive_beacon_hint(net, era)), plain, [0x50 + i; 32], height);
        }
        for (net, sk) in ChiaNet::ALL.into_iter().zip(&nodes) {
            let listings = read_ck(net, &chain, &ck, peak, now, &mut std::collections::HashMap::new()).await.unwrap();
            assert_eq!(listings.iter().map(|f| f.record.node_id.clone()).collect::<Vec<_>>(), vec![sk.public().to_string()], "{net:?}: the listing");
            let knocks = read_inbox(net, &chain, &kx_secret, &ck, &room_key, "r", peak, now, &mut std::collections::HashMap::new()).await.unwrap();
            assert_eq!(knocks.iter().map(|f| f.item.from).collect::<Vec<_>>(), vec![sk.public()], "{net:?}: the knock");
            let beacons = read_beacons(net, &chain, peak, now).await.unwrap();
            assert_eq!(beacons.iter().map(|f| f.item.node_id).collect::<Vec<_>>(), vec![sk.public()], "{net:?}: the beacon");
        }
    }

    /// Stage 4 design §3.5 from writer to reader: what the presence, knock
    /// and beacon writers file on a network (their steps that touch no
    /// chain: `chia_publish::presence_memo`, `knock_hint` with `knock_memo`,
    /// and `beacon_memo`), filed under the hint each gives, is read back on
    /// that network as its writer's and on the other network not at all. A
    /// writer that filed under the other network's hint, or sealed on the
    /// other network, fails here; the writers take the network as an
    /// argument, so CI's mainnet step cannot see that.
    #[cfg(feature = "chia-publish")]
    #[tokio::test]
    async fn what_each_writer_files_on_a_network_is_read_on_that_network_alone() {
        use crate::chia_lane::{AddrEntry, ERA_BLOCKS};
        let (ck, kx_secret, room_key) = ([21u8; 32], [22u8; 32], [23u8; 32]);
        let kx_host = curve25519_dalek::MontgomeryPoint::mul_base_clamped(kx_secret).to_bytes();
        let req = crate::chia_knock::KnockRequest { room: "r".into(), host: "host".into(), ck_host: ck, kx_host, attempts: 0 };
        let (now, era) = (1_791_700_000u64, 12u64);
        let (height, peak) = (12 * ERA_BLOCKS + 10, 12 * ERA_BLOCKS + 50);
        let entries = [AddrEntry { addr: "198.51.100.7:4444".parse().unwrap(), flags: 1 }];
        for net in ChiaNet::ALL {
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            let sk = iroh::SecretKey::generate();
            let mut chain = MemoChain::default();
            let (hint, memo) = crate::chia_publish::presence_memo(net, &sk, &ck, era, &entries, now).unwrap();
            chain.file(hint, memo, [0x30; 32], height);
            let input = Bytes32::new([0x40; 32]);
            let memo = crate::chia_publish::knock_memo(net, &sk, &req, &room_key, era, input, None, now).unwrap();
            chain.file(crate::chia_publish::knock_hint(net, &req, &room_key, era), memo, input.to_bytes(), height);
            let (hint, memo) = crate::chia_publish::beacon_memo(net, &sk, era, now).unwrap();
            chain.file(hint, memo, [0x50; 32], height);
            for (on, want) in [(net, vec![sk.public()]), (other, vec![])] {
                let listings = read_ck(on, &chain, &ck, peak, now, &mut std::collections::HashMap::new()).await.unwrap();
                let names: Vec<String> = want.iter().map(|k| k.to_string()).collect();
                assert_eq!(listings.iter().map(|f| f.record.node_id.clone()).collect::<Vec<_>>(), names, "written on {net:?}, read on {on:?}: the listing");
                let knocks = read_inbox(on, &chain, &kx_secret, &ck, &room_key, "r", peak, now, &mut std::collections::HashMap::new()).await.unwrap();
                assert_eq!(knocks.iter().map(|f| f.item.from).collect::<Vec<_>>(), want, "written on {net:?}, read on {on:?}: the knock");
                let beacons = read_beacons(on, &chain, peak, now).await.unwrap();
                assert_eq!(beacons.iter().map(|f| f.item.node_id).collect::<Vec<_>>(), want, "written on {net:?}, read on {on:?}: the beacon");
            }
        }
    }

    /// The reply addresses from writer to reader: a knock written with them
    /// (`chia_publish::knock_memo_with`, the knock arm's own step) is read
    /// from the host's inbox with the same addresses in the same order, on
    /// each network, and a knock written without any reads back with none.
    /// The first is a first visit's knock: no contact key, so the addresses
    /// are all the host has to dial back by.
    #[cfg(feature = "chia-publish")]
    #[tokio::test]
    async fn a_knocks_reply_addresses_reach_the_host_that_reads_its_inbox() {
        use crate::chia_lane::ERA_BLOCKS;
        use crate::chia_publish::KnockCarry;
        let (ck, kx_secret, room_key) = ([21u8; 32], [22u8; 32], [23u8; 32]);
        let kx_host = curve25519_dalek::MontgomeryPoint::mul_base_clamped(kx_secret).to_bytes();
        let req = crate::chia_knock::KnockRequest { room: "r".into(), host: "host".into(), ck_host: ck, kx_host, attempts: 0 };
        let (now, era) = (1_791_700_000u64, 12u64);
        let (height, peak) = (12 * ERA_BLOCKS + 10, 12 * ERA_BLOCKS + 50);
        let reply: Vec<std::net::SocketAddr> = vec!["[2001:4860:4860::8888]:44442".parse().unwrap(), "8.8.8.8:44442".parse().unwrap()];
        for net in ChiaNet::ALL {
            let (first_visit, bare) = (iroh::SecretKey::generate(), iroh::SecretKey::generate());
            let mut chain = MemoChain::default();
            let hint = crate::chia_publish::knock_hint(net, &req, &room_key, era);
            let input = Bytes32::new([0x40; 32]);
            let carry = KnockCarry { ck: None, reply: reply.clone() };
            let memo = crate::chia_publish::knock_memo_with(net, &first_visit, &req, &room_key, era, input, &carry, now).unwrap();
            chain.file(hint, memo, input.to_bytes(), height);
            let input = Bytes32::new([0x41; 32]);
            let memo = crate::chia_publish::knock_memo(net, &bare, &req, &room_key, era, input, None, now).unwrap();
            chain.file(hint, memo, input.to_bytes(), height);
            let knocks = read_inbox(net, &chain, &kx_secret, &ck, &room_key, "r", peak, now, &mut std::collections::HashMap::new()).await.unwrap();
            let of = |sk: &iroh::SecretKey| knocks.iter().find(|f| f.item.from == sk.public()).map(|f| (f.item.ck_from, f.item.reply.clone()));
            assert_eq!(of(&first_visit), Some((None, reply.clone())), "{net:?}: no contact key, and the addresses to dial back");
            assert_eq!(of(&bare), Some((None, vec![])), "{net:?}: a knock written without them names its node id alone");
        }
    }

    #[tokio::test]
    async fn young_knock_coins_are_looked_up_again_and_a_cut_listing_judges_none() {
        // #272 review round 7: the coins that carried the knocks read, looked
        // up again while their confirmation is young — one that left the
        // chain is on no page of a listing run to its end.
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use chia_protocol::Coin;
        let rec = |parent: u8, height: u32| CoinRecord {
            coin: Coin::new(Bytes32::new([parent; 32]), Bytes32::new([1u8; 32]), 1),
            confirmed_block_index: height,
            spent: false,
            spent_block_index: 0,
        };
        let (a, b) = (rec(1, 100), rec(2, 105));
        let ids = vec![a.coin.coin_id(), b.coin.coin_id(), Bytes32::new([9u8; 32])];
        let page = |records: Vec<CoinRecord>, truncated: bool, next: Option<&str>, judged_at: Option<u32>| CoinListing { records, truncated, next_cursor: next.map(str::to_string), judged_at };
        let found = vec![(a.coin.coin_id(), 100), (b.coin.coin_id(), 105)];
        let chain = Scripted::new(vec![page(vec![a.clone()], true, Some("c"), Some(120)), page(vec![b.clone()], false, None, Some(118))]);
        assert_eq!(
            coin_heights(&chain, ids.clone()).await.unwrap(),
            Some(CoinHeights { found: found.clone(), judged_at: Some(118) }),
            "the third coin is on no page: it left the chain, as far as a listing judged at 118 (the lowest page) can tell (round 9)"
        );
        let chain = Scripted::new(vec![page(vec![a.clone()], true, Some("c"), Some(120)), page(vec![b.clone()], false, None, None)]);
        assert_eq!(
            coin_heights(&chain, ids.clone()).await.unwrap(),
            Some(CoinHeights { found, judged_at: None }),
            "a page undated: the listing is undated, and says nothing of the coins it lacks"
        );
        let chain = Scripted::new(vec![page(vec![a.clone()], true, None, Some(120))]);
        assert_eq!(coin_heights(&chain, ids.clone()).await.unwrap(), None, "cut short with nowhere to go on: nothing is said");
        let pages: Vec<CoinListing> = (0..MAX_PAGES_PER_POLL + 1).map(|_| page(vec![], true, Some("c"), Some(120))).collect();
        assert_eq!(coin_heights(&Scripted::new(pages), ids.clone()).await.unwrap(), None, "the page budget spent: nothing is said");
        assert_eq!(coin_heights(&chain, vec![]).await.unwrap(), Some(CoinHeights::default()), "no coins, no lookup");
        assert!(coin_heights(&crate::chia_chain::testing::Unanswering, ids).await.is_err());
    }

    #[test]
    fn a_missing_write_is_gone_only_on_a_listing_judged_past_its_confirmation() {
        // #272 review round 9: replacement peers answering below the block
        // that confirmed a write do not list it, and prove nothing by that.
        let absent = |judged_at| HintChild::Absent { judged_at };
        assert!(absent(Some(100)).gone_since(100), "judged at the confirmation itself: the block would be listed");
        assert!(absent(Some(150)).gone_since(100));
        assert!(!absent(Some(99)).gone_since(100), "peers behind the confirmation know nothing of it");
        assert!(!absent(None).gone_since(100), "undated: nothing is said");
        assert!(!HintChild::Unknown.gone_since(100), "cut short: nothing is said");
        assert!(!HintChild::Confirmed { height: 100, judged_at: Some(100) }.gone_since(100));
        assert!(!absent(Some(150)).gone_since(0), "a write never confirmed has no block to lose");
    }

    #[tokio::test]
    async fn the_child_under_the_hint_is_found_by_its_parent_through_the_pages() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use chia_protocol::Coin;
        let input = Bytes32::new([7u8; 32]);
        let hint = Bytes32::new([8u8; 32]);
        let rec = |parent: u8, height: u32| CoinRecord {
            coin: Coin::new(Bytes32::new([parent; 32]), Bytes32::new([1u8; 32]), 1),
            confirmed_block_index: height,
            spent: false,
            spent_block_index: 0,
        };
        let page = |records: Vec<CoinRecord>, truncated: bool, next: Option<&str>, judged_at: Option<u32>| CoinListing {
            records,
            truncated,
            next_cursor: next.map(str::to_string),
            judged_at,
        };
        // The write's own spend: it made the coin under the hint carrying the
        // write's memo. Scripted on every chain below, so a listing that names
        // the coin confirms it, and one that does not never asks for it.
        let memo = b"the write".to_vec();
        let digest = Some(memo_digest(&memo));
        let ours = |pages: Vec<CoinListing>| Scripted::new(pages).with_spend(input, crate::chia_chain::testing::memo_spend(&rec(7, 101).coin, hint, &memo));
        // Two pages: the write's own coin is on the second, found by a lookup
        // judged at the lowest height over the pages read (round 10).
        let chain = ours(vec![page(vec![rec(1, 100)], true, Some("c"), Some(130)), page(vec![rec(7, 101)], false, None, Some(120))]);
        assert_eq!(child_under_hint(&chain, hint, input, digest).await.unwrap(), HintChild::Confirmed { height: 101, judged_at: Some(120) });
        assert_eq!(*chain.asked_spends.lock().unwrap(), vec![(input, 101)], "the parent's spend, at the coin's height, once");
        let chain = ours(vec![page(vec![rec(1, 100)], true, Some("c"), Some(120)), page(vec![rec(7, 101)], true, Some("d"), Some(130))]);
        assert_eq!(child_under_hint(&chain, hint, input, digest).await.unwrap(), HintChild::Confirmed { height: 101, judged_at: Some(120) }, "the lowest page so far, not the one that held it");
        // Found after an undated page: the height the peers stood at is
        // unknown, and no settlement can be measured by it.
        let chain = ours(vec![page(vec![], true, Some("c"), None), page(vec![rec(7, 101)], false, None, Some(130))]);
        assert_eq!(child_under_hint(&chain, hint, input, digest).await.unwrap(), HintChild::Confirmed { height: 101, judged_at: None });
        // A listing run to its end without it, judged at the lowest height over its pages.
        let chain = ours(vec![page(vec![rec(1, 100)], true, Some("c"), Some(130)), page(vec![rec(2, 101)], false, None, Some(120))]);
        assert_eq!(child_under_hint(&chain, hint, input, digest).await.unwrap(), HintChild::Absent { judged_at: Some(120) });
        assert!(chain.asked_spends.lock().unwrap().is_empty(), "no child of the input listed: no spend asked for");
        // One undated page leaves the listing undated.
        let chain = ours(vec![page(vec![], true, Some("c"), Some(130)), page(vec![], false, None, None)]);
        assert_eq!(child_under_hint(&chain, hint, input, digest).await.unwrap(), HintChild::Absent { judged_at: None });
        // Cut short with nowhere to go on: unknown.
        let chain = ours(vec![page(vec![rec(1, 100)], true, None, Some(130))]);
        assert_eq!(child_under_hint(&chain, hint, input, digest).await.unwrap(), HintChild::Unknown);
        // Still cut short when the page budget is spent: unknown too.
        let pages: Vec<CoinListing> = (0..MAX_PAGES_PER_POLL + 1).map(|_| page(vec![], true, Some("c"), Some(130))).collect();
        let chain = ours(pages);
        assert_eq!(child_under_hint(&chain, hint, input, digest).await.unwrap(), HintChild::Unknown);
        // A chain that does not answer is an error, not a verdict.
        assert!(child_under_hint(&crate::chia_chain::testing::Unanswering, hint, input, digest).await.is_err());
        assert_eq!(parse_hex32(&hex::encode(input.to_bytes())), Some(input));
        assert_eq!(parse_hex32("zz"), None);
        assert_eq!(parse_hex32("0011"), None, "the wrong length is no id");
    }

    /// The memo check: a coin listed under the hint with the write's input as
    /// its parent is the write's only when the input's spend, fetched at the
    /// coin's height, makes it by an output carrying the hint and the write's
    /// memo. Every write from one input makes the same coin whatever its
    /// hint, and a full node keeps the hint rows of an orphaned block, so the
    /// coin made again by another write — under another hint, or under the
    /// same one with another memo — can still be listed under ours: a stale
    /// row, passed over, and the listing ends as it would without it.
    #[tokio::test]
    async fn the_child_under_the_hint_is_the_write_only_when_its_parents_spend_carries_the_hint_and_the_memo() {
        use crate::chia_chain::testing::{memo_spend, spend_creating, Scripted};
        use crate::chia_chain::{CoinListing, CoinRecord};
        use chia_protocol::Coin;
        let input = Bytes32::new([7u8; 32]);
        let (hint, other_hint) = (Bytes32::new([8u8; 32]), Bytes32::new([9u8; 32]));
        let (memo, other_memo) = (b"our write".to_vec(), b"another write".to_vec());
        let digest = memo_digest(&memo);
        let child = Coin::new(input, Bytes32::new([1u8; 32]), 1);
        let rec = |coin: Coin, height: u32| CoinRecord { coin, confirmed_block_index: height, spent: false, spent_block_index: 0 };
        let page = |records: Vec<CoinRecord>, truncated: bool, next: Option<&str>| CoinListing { records, truncated, next_cursor: next.map(str::to_string), judged_at: Some(120) };
        let ended = |records: Vec<CoinRecord>| page(records, false, None);
        let listed = || Scripted::new(vec![ended(vec![rec(child, 101)])]);
        // The verdict, and the spends asked for on the way to it.
        let judge = |chain: Scripted, memo: Option<Bytes32>| async move {
            let verdict = child_under_hint(&chain, hint, input, memo).await.map_err(|e| e.to_string());
            let asked = chain.asked_spends.lock().unwrap().clone();
            (verdict, asked)
        };
        let once = vec![(input, 101)];
        let confirmed = Ok(HintChild::Confirmed { height: 101, judged_at: Some(120) });
        let absent = Ok(HintChild::Absent { judged_at: Some(120) });
        let unknown = Ok(HintChild::Unknown);
        // The write's own output: confirmed by the digest, or by the hint
        // alone for a mark an older node saved, which keeps no digest.
        for given in [Some(digest), None] {
            let chain = listed().with_spend(input, memo_spend(&child, hint, &memo));
            assert_eq!(judge(chain, given).await, (confirmed.clone(), once.clone()), "{given:?}");
        }
        // The coin made again by a write under another hint (the row an
        // orphaned block left): stale, digest or none. Run to its end the
        // listing is absent; cut short with nowhere to go on, unknown.
        for given in [Some(digest), None] {
            let chain = listed().with_spend(input, memo_spend(&child, other_hint, &memo));
            assert_eq!(judge(chain, given).await, (absent.clone(), once.clone()), "another hint, {given:?}");
        }
        let chain = Scripted::new(vec![page(vec![rec(child, 101)], true, None)]).with_spend(input, memo_spend(&child, other_hint, &memo));
        assert_eq!(judge(chain, Some(digest)).await, (unknown.clone(), once.clone()), "cut short");
        // The same hint and another memo (another write of ours under it, one
        // wallet writing from two places): stale by the digest; with no
        // digest, the hint alone takes it.
        let chain = listed().with_spend(input, memo_spend(&child, hint, &other_memo));
        assert_eq!(judge(chain, Some(digest)).await, (absent.clone(), once.clone()), "another memo");
        let chain = listed().with_spend(input, memo_spend(&child, hint, &other_memo));
        assert_eq!(judge(chain, None).await, (confirmed.clone(), once.clone()), "another memo, no digest: the hint alone");
        // An output with the hint and no second memo carries nothing a reader opens.
        let bare = spend_creating(&[(child.puzzle_hash, child.amount, vec![Bytes::new(hint.to_vec())])]);
        assert_eq!(judge(listed().with_spend(input, bare), None).await, (absent.clone(), once.clone()), "the hint alone, no memo");
        // The output carrying the write makes another coin (another puzzle
        // hash, another amount): the spend does not make the coin listed, so
        // the listing and the spend disagree, and nothing is judged.
        for other in [Coin::new(input, Bytes32::new([2u8; 32]), 1), Coin::new(input, child.puzzle_hash, 2)] {
            let chain = listed().with_spend(input, memo_spend(&other, hint, &memo));
            assert_eq!(judge(chain, Some(digest)).await, (unknown.clone(), once.clone()), "{other:?}");
        }
        // No spend of the input at the coin's height: unknown. A spend not
        // answered: an error, so no verdict this tick.
        assert_eq!(judge(listed().with_no_spend(input), Some(digest)).await, (unknown.clone(), once.clone()), "no spend");
        let (unanswered, asked) = judge(listed(), Some(digest)).await;
        assert!(unanswered.is_err(), "{unanswered:?}");
        assert_eq!(asked, once);
        // One fetch per parent however many listed coins name it: another
        // coin of the one spend under another hint (a stale row), then, on
        // the next page, the write's own coin.
        let stale = Coin::new(input, Bytes32::new([3u8; 32]), 1);
        let memos = |hint: Bytes32, memo: &[u8]| vec![Bytes::new(hint.to_vec()), Bytes::new(memo.to_vec())];
        let two = |ours: &[u8]| spend_creating(&[(stale.puzzle_hash, stale.amount, memos(other_hint, &other_memo)), (child.puzzle_hash, child.amount, memos(hint, ours))]);
        let pages = || vec![page(vec![rec(stale, 101)], true, Some("c")), ended(vec![rec(child, 101)])];
        assert_eq!(judge(Scripted::new(pages()).with_spend(input, two(&memo)), Some(digest)).await, (confirmed.clone(), once.clone()), "read on past a stale row");
        assert_eq!(judge(Scripted::new(pages()).with_spend(input, two(&other_memo)), Some(digest)).await, (absent.clone(), once.clone()), "two stale rows");
        let chain = Scripted::new(vec![ended(vec![rec(stale, 101), rec(child, 101)])]).with_spend(input, two(&memo));
        assert_eq!(judge(chain, Some(digest)).await, (confirmed.clone(), once.clone()), "on one page");
        // A later coin of the input's at another height than the spend was
        // fetched at: the pages straddle a reorganization, nothing is judged.
        let chain = Scripted::new(vec![page(vec![rec(stale, 101)], true, Some("c")), ended(vec![rec(child, 102)])]).with_spend(input, two(&memo));
        assert_eq!(judge(chain, Some(digest)).await, (unknown, once), "another height");
    }

    /// The one condition walk ([`created_coins`]) lists every output of a
    /// spend in order, with its memos; the writer's verdict takes the output
    /// that makes a given coin ([`output_memos`]), and a reader still takes
    /// the first output under its hint ([`extract_ciphertext`]), as before.
    #[test]
    fn the_shared_walk_lists_every_output_and_each_side_takes_its_own() {
        use crate::chia_chain::testing::spend_creating;
        let (hint, other_hint) = (Bytes32::new([8u8; 32]), Bytes32::new([9u8; 32]));
        let ph = |n: u8| Bytes32::new([n; 32]);
        let memos = |hint: Bytes32, memo: &[u8]| vec![Bytes::new(hint.to_vec()), Bytes::new(memo.to_vec())];
        let spend = spend_creating(&[(ph(1), 1, memos(other_hint, b"a")), (ph(2), 5, vec![]), (ph(3), 1, memos(hint, b"b")), (ph(4), 1, memos(hint, b"c"))]);
        let created = created_coins(&spend).unwrap();
        assert_eq!(
            created.iter().map(|c| (c.puzzle_hash, c.amount, c.memos.len())).collect::<Vec<_>>(),
            vec![(ph(1), 1, 2), (ph(2), 5, 0), (ph(3), 1, 2), (ph(4), 1, 2)]
        );
        assert_eq!(extract_ciphertext(&spend, hint).unwrap(), Some(b"b".to_vec()), "a reader takes the first output under its hint");
        assert_eq!(extract_ciphertext(&spend, Bytes32::new([10u8; 32])).unwrap(), None);
        assert_eq!(output_memos(&spend, ph(4), 1).unwrap(), Some(memos(hint, b"c")), "the output that makes the coin");
        assert_eq!(output_memos(&spend, ph(2), 5).unwrap(), Some(vec![]), "an output with no memos");
        assert_eq!(output_memos(&spend, ph(4), 2).unwrap(), None, "no output makes that coin");
        assert_eq!(hex::encode(memo_digest(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "SHA-256");
        // A spend that raises is an error for both sides.
        let raises = PuzzleAndSolution { puzzle_reveal: chia_protocol::Program::from(vec![0xff, 0x08, 0x80]), solution: chia_protocol::Program::from(vec![0x80]) };
        assert!(created_coins(&raises).is_err() && extract_ciphertext(&raises, hint).is_err());
    }

    /// Stage 4 design §4.4: a mark or a knock entry files its write's parent
    /// as `coin_id` and its parked input as `parked`. One an older node saved
    /// files no parked input and reads back as its one coin, the parent and
    /// the parked input alike, as it was judged before; a write the SSF
    /// wallet's keys pay for files its one coin twice and reads back the
    /// same; a burner's first write reads back as its gift and its dish coin.
    /// A malformed coin id or parked input files nothing, and neither does a
    /// parked input with no coin beside it.
    #[test]
    fn a_filed_coin_with_no_parked_input_reads_back_as_one_coin_and_a_filed_pair_as_its_parent_and_parked_input() {
        let coin = Bytes32::new([7u8; 32]);
        let (g, f) = (Bytes32::new([8u8; 32]), Bytes32::new([9u8; 32]));
        let hex_of = |id: Bytes32| hex::encode(id.to_bytes());
        let one = WriteCoins::one(coin);
        let pair = WriteCoins { parent: g, parked: f };
        assert_eq!((one.parent, one.parked), (coin, coin));
        assert_eq!(WriteCoins::filed(&hex_of(coin), ""), Some(one), "a mark an older node saved: its one coin is both");
        assert_eq!(WriteCoins::filed(&hex_of(coin), &hex_of(coin)), Some(one), "one coin filed twice");
        assert_eq!(WriteCoins::filed(&hex_of(g), &hex_of(f)), Some(pair), "the gift as the parent, the dish coin as the parked input");
        assert_eq!(WriteCoins::filed(&hex_of(g).to_uppercase(), &hex_of(f).to_uppercase()), Some(pair), "read as parse_hex32 reads them");
        assert_eq!(WriteCoins::filed("zz", ""), None);
        assert_eq!(WriteCoins::filed("0011", ""), None, "the wrong length files nothing");
        assert_eq!(WriteCoins::filed("", ""), None, "a mark an older node wrote names no coin");
        assert_eq!(WriteCoins::filed(&hex_of(coin), "zz"), None, "a malformed parked input files nothing, not the one coin");
        assert_eq!(WriteCoins::filed(&hex_of(coin), "0011"), None, "nor one of the wrong length");
        assert_eq!(WriteCoins::filed("", &hex_of(f)), None, "no coin: nothing to judge");
    }
}
