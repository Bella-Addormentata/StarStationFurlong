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

use crate::chia_lane::{self, ChiaPresenceRecord};

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
/// or signed more than [`MAX_FUTURE_SKEW_V2_SECS`] ahead of our clock.
pub fn decode_v2_presence(
    ck: &[u8; 32],
    ciphertext: &[u8],
    era: u64,
    confirmed_height: u32,
    now: u64,
) -> Option<ChiaPresenceRecord> {
    if chia_lane::era_of(confirmed_height) != era {
        return None;
    }
    let plain = chia_lane::open_v2(ck, chia_lane::KIND_PRESENCE, era, ciphertext).ok()?;
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
/// beat after beat). A hint whose read fails has its cursor put back exactly
/// as it was, so nothing it examined counts as seen and the next beat re-reads
/// it; what the other hint found is returned all the same. Only when every
/// hint failed is the error returned.
pub async fn read_ck(
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
        let hint = chia_lane::derive_ck_hint(ck, era);
        let cursor = cursors.entry(hint).or_default();
        let before = cursor.clone();
        let opener = |ct: &[u8], _parent: Bytes32, height: u32| decode_v2_presence(ck, ct, era, height, now);
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
                *cursor = before;
                cursor.backlog = true;
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

/// The hints a v2 reader of `ck` has in play at `peak` (for cursor pruning).
pub fn live_ck_hints(ck: &[u8; 32], peak: u32) -> Vec<[u8; 32]> {
    scan_eras(peak).into_iter().map(|era| chia_lane::derive_ck_hint(ck, era)).collect()
}

// ── #231 P6b: the inbox (knocks sealed to us) and the public beacons ────────

/// Open one knock ciphertext read under our inbox hint for `era`: sealed to
/// our card key UNDER the coin that carried it (`carrier_parent`, the coin's
/// parent — a copy of the blob under another coin does not open, #272 review
/// round 3) and WITH the room's secret lane token (`lane`: a writer without the
/// room key cannot seal one, round 5), signed by its knocker, filed in its own era, not expired, not
/// from the far future, and naming `lane_id` (the room the hint was read for)
/// among its rooms. `None` for anything else.
pub fn decode_knock_for(
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
    let plain = chia_lane::open_with_kx(kx_secret, chia_lane::KIND_KNOCK, era, carrier_parent, lane, ciphertext).ok()?;
    let knock = chia_lane::decode_knock_v2(&plain, era).ok()?;
    if knock.expires_at < now || knock.issued_at > now.saturating_add(MAX_FUTURE_SKEW_V2_SECS) {
        return None;
    }
    knock.rooms.contains(lane_id).then_some(knock)
}

/// One incremental read of our INBOX for `room`'s lane: both scan eras' hints
/// under our contact key and the room's lane token, cursors kept by the caller
/// per hint, the same transactional failure rule as [`read_ck`].
pub async fn read_inbox(
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
        let hint = chia_lane::derive_inbox_hint(own_ck, &lane, era);
        let cursor = cursors.entry(hint).or_default();
        let before = cursor.clone();
        let opener = |ct: &[u8], parent: Bytes32, height: u32| decode_knock_for(kx_secret, ct, &parent.to_bytes(), &lane, era, height, now, &lane_id);
        match read_hint_items(client, Bytes32::new(hint), cursor, &opener).await {
            Ok(items) => {
                any_ok = true;
                found.extend(items);
            }
            Err(e) => {
                *cursor = before;
                cursor.backlog = true;
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

/// The inbox hints of `room` in play at `peak` (for cursor pruning).
pub fn live_inbox_hints(own_ck: &[u8; 32], room_key: &[u8; 32], peak: u32) -> Vec<[u8; 32]> {
    let lane = chia_lane::derive_lane_token(room_key);
    scan_eras(peak).into_iter().map(|era| chia_lane::derive_inbox_hint(own_ck, &lane, era)).collect()
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
/// budget bounds the read and the newest-first order keeps what matters.
pub async fn read_beacons(client: &impl ChainAccess, peak: u32, now: u64) -> Result<Vec<FoundItem<chia_lane::BeaconV2>>> {
    let mut all = Vec::new();
    let mut cursors: std::collections::HashMap<[u8; 32], HintCursor> = std::collections::HashMap::new();
    for round in 1..=ONE_SHOT_MAX_ROUNDS {
        for era in scan_eras(peak) {
            let hint = chia_lane::derive_beacon_hint(era);
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

/// #231 P6b: whether a write's own coin sits under `hint` — the coin a
/// spend-to-self creates names the coin it spent as its parent, so the child
/// under the hint whose `parent_coin_info` is the write's INPUT is the write
/// itself, confirmed where that child confirmed. The input's spent flag alone
/// says nothing of the write (#272 review): the mempool may have dropped the
/// write and a later spend of ours taken the same coin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HintChild {
    /// The write's own coin is under the hint, confirmed at this height.
    Confirmed(u32),
    /// The listing ran to its end and no coin under the hint names the input
    /// as its parent; judged at this height (`None`: the source gave none).
    Absent { judged_at: Option<u32> },
    /// The listing was cut short before its end: nothing can be said yet.
    Unknown,
}

/// Look for the write that spent `parent` among the coins under `hint`,
/// paging within the poll budget.
pub async fn child_under_hint(client: &impl ChainAccess, hint: Bytes32, parent: Bytes32) -> Result<HintChild> {
    let mut page: Option<String> = None;
    let mut judged_at: Option<u32> = None;
    let mut undated = false;
    for _ in 0..MAX_PAGES_PER_POLL {
        let listing = client
            .coin_records_by_hint(hint, None, true, page.take())
            .await
            .map_err(|e| anyhow!("hint lookup: {e}"))?;
        if let Some(rec) = listing.records.iter().find(|r| r.coin.parent_coin_info == parent) {
            return Ok(HintChild::Confirmed(rec.confirmed_block_index));
        }
        match listing.judged_at {
            Some(h) => judged_at = Some(judged_at.map_or(h, |lowest| lowest.min(h))),
            None => undated = true,
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
    /// by another that took the coin): the chain lookups say which.
    Spent,
    /// Released because every peer refused the bundle: the spend will never
    /// land. The one word that can call an unspent input DEAD.
    Dropped,
    /// Nothing known: not parked and no release remembered — a restart, a
    /// lease that was never restored (publishing off), a read-only build.
    Unknown,
}

/// Where a pending write stands (#231 P6b knocks and beacons, #272 review).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteStanding {
    /// On chain, confirmed at this height.
    Confirmed(u32),
    /// Never landed, for the reason given: the writer forgets it and may write again.
    Dead(&'static str),
    /// Not settled yet: left as it is, asked again next tick.
    Pending,
}

/// Judge a pending write from the chain's word: `child` is what sits under its
/// hint ([`child_under_hint`]), `spent_at` the height its input was spent at
/// when the chain lists it spent ([`spent_heights`]), `lease` the wallet
/// lease's word on the input ([`LeaseWord`], asked BEFORE the two lookups).
/// Only the write's OWN coin confirms it. An input spent with no child under
/// the hint went to ANOTHER spend of ours — but only on a listing judged at or
/// past that spend, since a source still behind it may not list the child yet.
/// An input unspent is dead only on the lease's word that the peers refused
/// the spend ([`LeaseWord::Dropped`]); still parked, released as spent (the
/// lookups lag the lease then) or unknown to this run, it stays pending —
/// silence never kills a write (#272 review round 2). Nothing here is decided
/// by the clock.
pub fn write_standing(child: &HintChild, spent_at: Option<u32>, lease: LeaseWord) -> WriteStanding {
    match child {
        HintChild::Confirmed(height) => WriteStanding::Confirmed(*height),
        HintChild::Unknown => WriteStanding::Pending,
        HintChild::Absent { judged_at } => match spent_at {
            Some(spent) if judged_at.is_some_and(|judged| judged >= spent) => {
                WriteStanding::Dead("its coin went to another spend of ours")
            }
            Some(_) => WriteStanding::Pending,
            None if lease == LeaseWord::Dropped => WriteStanding::Dead("the mempool dropped it"),
            None => WriteStanding::Pending,
        },
    }
}

/// A 32-byte id from its hex, as the node files write them.
pub fn parse_hex32(hex_id: &str) -> Option<Bytes32> {
    let bytes: [u8; 32] = hex::decode(hex_id).ok()?.try_into().ok()?;
    Some(Bytes32::new(bytes))
}

/// ONE-SHOT: the freshest presence record `node_id` published under its
/// contact key `ck` — the introduction lookup at dial exhaustion (rung 6) once
/// the target's card is known. Reads the chain peak first (the era is the
/// chain's clock), then both scan eras, round after round within the one-shot
/// budget. Records under the hint signed by any OTHER node are discarded
/// before ranking: a contact key is shared with every member of the rooms
/// that received the card, so it locates the hint but never vouches for the
/// signer; only the node's own signature does.
pub async fn resolve_presence_by_ck(ck: &[u8; 32], node_id: &str) -> Result<Option<ChiaPresenceRecord>> {
    let now = unix_now();
    let client = crate::chia_chain::connect_carrier();
    let peak = peak_height(&client).await.ok_or_else(|| anyhow!("chain peak unavailable"))?;
    let mut all = Vec::new();
    let mut cursors = std::collections::HashMap::new();
    for round in 1..=ONE_SHOT_MAX_ROUNDS {
        all.extend(read_ck(&client, ck, peak, now, &mut cursors).await?);
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
    for condition in conditions {
        let Some(create_coin) = condition.into_create_coin() else {
            continue;
        };
        let memos_ptr = match create_coin.memos {
            Memos::Some(ptr) => ptr,
            Memos::None => continue,
        };
        let memos = match Vec::<Bytes>::from_clvm(&allocator, memos_ptr) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if memos.len() >= 2 && memos[0].as_ref() == hint.as_ref() {
            return Ok(Some(memos[1].clone().into_inner()));
        }
    }
    Ok(None)
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
        };
        let plain = chia_lane::encode_knock_v2(&knock, &knocker).unwrap();
        let input = [5u8; 32];
        let sealed = chia_lane::seal_to_kx(&host_pk, chia_lane::KIND_KNOCK, era, &input, &lane_token, &plain).unwrap();
        assert_eq!(decode_knock_for(&host_sk, &sealed, &input, &lane_token, era, height, now, &lane), Some(knock), "under its own coin: the knock");
        assert_eq!(decode_knock_for(&host_sk, &sealed, &[6u8; 32], &lane_token, era, height, now, &lane), None, "the same blob under a copier's coin: nothing");
        assert_eq!(decode_knock_for(&host_sk, &sealed, &input, &lane_token, era, height + chia_lane::ERA_BLOCKS, now, &lane), None, "outside its era");
        assert_eq!(decode_knock_for(&host_sk, &sealed, &input, &lane_token, era, height, now, &chia_lane::room_lane_id("s")), None, "another room");
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
        };
        let plain = chia_lane::encode_knock_v2(&knock, &knocker).unwrap();
        let input = [5u8; 32];
        for stranger in [chia_lane::derive_lane_token(&[10u8; 32]), [0u8; 32]] {
            let forged = chia_lane::seal_to_kx(&host_pk, chia_lane::KIND_KNOCK, era, &input, &stranger, &plain).unwrap();
            assert_eq!(
                decode_knock_for(&host_sk, &forged, &input, &lane_token, era, height, now, &lane_id),
                None,
                "sealed with another room's lane, or none: not a knock on this room, under the right hint or not"
            );
        }
        let genuine = chia_lane::seal_to_kx(&host_pk, chia_lane::KIND_KNOCK, era, &input, &lane_token, &plain).unwrap();
        assert_eq!(decode_knock_for(&host_sk, &genuine, &input, &lane_token, era, height, now, &lane_id), Some(knock));
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
        let sealed = seal_v2(&ck, KIND_PRESENCE, era, &encode_presence_v2(&rec, &sk).unwrap()).unwrap();
        let inside = 12 * ERA_BLOCKS + 10;
        let got = decode_v2_presence(&ck, &sealed, era, inside, now).expect("confirmed inside its era");
        assert_eq!(got.v, 2);
        assert_eq!(got.node_id, sk.public().to_string());
        assert_eq!(got.addrs, vec!["198.51.100.7:4444".to_string()]);
        assert_eq!(got.addr_flags, vec![1]);
        assert!(decode_v2_presence(&ck, &sealed, era, 13 * ERA_BLOCKS, now).is_none(), "confirmed in the next era: a pre-fill or a late replay, refused");
        assert!(decode_v2_presence(&ck, &sealed, era, 12 * ERA_BLOCKS - 1, now).is_none(), "confirmed before its era: refused");
        assert!(decode_v2_presence(&ck, &sealed, era + 1, 13 * ERA_BLOCKS, now).is_none(), "read under the next era's hint: the seal refuses");
        assert!(decode_v2_presence(&[9u8; 32], &sealed, era, inside, now).is_none(), "another contact key");
        assert!(decode_v2_presence(&ck, &sealed, era, inside, now + 3601).is_none(), "expired");
        let future = PresenceV2 { issued_at: now + MAX_FUTURE_SKEW_V2_SECS + 1, expires_at: now + 10 * 3600, ..rec.clone() };
        let sealed = seal_v2(&ck, KIND_PRESENCE, era, &encode_presence_v2(&future, &sk).unwrap()).unwrap();
        assert!(decode_v2_presence(&ck, &sealed, era, inside, now).is_none(), "two hours ahead is too far");
    }

    #[test]
    fn v2_readers_scan_this_era_and_the_last() {
        use crate::chia_lane::ERA_BLOCKS;
        assert_eq!(scan_eras(0), vec![0]);
        assert_eq!(scan_eras(ERA_BLOCKS - 1), vec![0]);
        assert_eq!(scan_eras(ERA_BLOCKS), vec![1, 0]);
        assert_eq!(scan_eras(5 * ERA_BLOCKS + 7), vec![5, 4]);
        let ck = [3u8; 32];
        let hints = live_ck_hints(&ck, 5 * ERA_BLOCKS);
        assert_eq!(hints.len(), 2);
        assert_eq!(hints[0], chia_lane::derive_ck_hint(&ck, 5));
        assert_eq!(hints[1], chia_lane::derive_ck_hint(&ck, 4));
    }

    #[test]
    fn a_write_is_judged_by_its_own_coin_under_the_hint_not_by_its_spent_input() {
        use LeaseWord::{Dropped, Parked, Spent, Unknown};
        let absent = |judged_at| HintChild::Absent { judged_at };
        assert_eq!(write_standing(&HintChild::Confirmed(900), Some(900), Spent), WriteStanding::Confirmed(900));
        assert_eq!(write_standing(&HintChild::Confirmed(900), None, Parked), WriteStanding::Confirmed(900), "the child is the proof, whatever the input says");
        assert_eq!(write_standing(&HintChild::Unknown, Some(900), Dropped), WriteStanding::Pending, "a listing cut short decides nothing");
        assert_eq!(write_standing(&absent(Some(950)), Some(900), Parked), WriteStanding::Dead("its coin went to another spend of ours"));
        assert_eq!(write_standing(&absent(Some(900)), Some(900), Spent), WriteStanding::Dead("its coin went to another spend of ours"), "judged at the spend itself is enough");
        assert_eq!(write_standing(&absent(Some(899)), Some(900), Spent), WriteStanding::Pending, "a source behind the spend may not list the child yet");
        assert_eq!(write_standing(&absent(None), Some(900), Spent), WriteStanding::Pending, "an undated listing cannot say");
        assert_eq!(write_standing(&absent(Some(950)), None, Parked), WriteStanding::Pending, "unspent and still parked: the spend may be live in a mempool");
        assert_eq!(write_standing(&absent(Some(950)), None, Dropped), WriteStanding::Dead("the mempool dropped it"));
        assert_eq!(write_standing(&absent(None), None, Dropped), WriteStanding::Dead("the mempool dropped it"), "the lease's verdict needs no height");
        // The race (#272 review round 2): the write confirmed after the lease
        // reconciled (it released the input as spent) but the chain lookups,
        // made first, still showed the input unspent and no child — not dead.
        assert_eq!(write_standing(&absent(Some(950)), None, Spent), WriteStanding::Pending, "released as spent: the lookups lag the lease, the write is not dead");
        // A lease that knows nothing of the coin (a restart, publishing off, a
        // read-only build) never kills a write.
        assert_eq!(write_standing(&absent(Some(950)), None, Unknown), WriteStanding::Pending, "unknown to the lease: pending");
        assert_eq!(write_standing(&absent(None), None, Unknown), WriteStanding::Pending);
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
        // Two pages: the write's own coin is on the second.
        let chain = Scripted::new(vec![page(vec![rec(1, 100)], true, Some("c"), Some(120)), page(vec![rec(7, 101)], false, None, Some(120))]);
        assert_eq!(child_under_hint(&chain, hint, input).await.unwrap(), HintChild::Confirmed(101));
        // A listing run to its end without it, judged at the lowest height over its pages.
        let chain = Scripted::new(vec![page(vec![rec(1, 100)], true, Some("c"), Some(130)), page(vec![rec(2, 101)], false, None, Some(120))]);
        assert_eq!(child_under_hint(&chain, hint, input).await.unwrap(), HintChild::Absent { judged_at: Some(120) });
        // One undated page leaves the listing undated.
        let chain = Scripted::new(vec![page(vec![], true, Some("c"), Some(130)), page(vec![], false, None, None)]);
        assert_eq!(child_under_hint(&chain, hint, input).await.unwrap(), HintChild::Absent { judged_at: None });
        // Cut short with nowhere to go on: unknown.
        let chain = Scripted::new(vec![page(vec![rec(1, 100)], true, None, Some(130))]);
        assert_eq!(child_under_hint(&chain, hint, input).await.unwrap(), HintChild::Unknown);
        // Still cut short when the page budget is spent: unknown too.
        let pages: Vec<CoinListing> = (0..MAX_PAGES_PER_POLL + 1).map(|_| page(vec![], true, Some("c"), Some(130))).collect();
        let chain = Scripted::new(pages);
        assert_eq!(child_under_hint(&chain, hint, input).await.unwrap(), HintChild::Unknown);
        // A chain that does not answer is an error, not a verdict.
        assert!(child_under_hint(&crate::chia_chain::testing::Unanswering, hint, input).await.is_err());
        assert_eq!(parse_hex32(&hex::encode(input.to_bytes())), Some(input));
        assert_eq!(parse_hex32("zz"), None);
        assert_eq!(parse_hex32("0011"), None, "the wrong length is no id");
    }
}
