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
//! full node's `hint_store` and the coinset gateway):
//!   * `include_spent_coins=true` always — the current record's coin is spent
//!     the moment its publisher republishes.
//!   * Reads are INCREMENTAL: a [`HintCursor`] remembers the highest confirmed
//!     height examined and resumes `CURSOR_OVERLAP_BLOCKS` below it; coins
//!     already examined are skipped by coin id. A listing longer than
//!     [`MAX_PAGES_PER_POLL`] is continued next poll from the gateway's parked
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
use chia_protocol::{Bytes, Bytes32, CoinSpend};
use chia_puzzle_types::Memos;
use chia_sdk_coinset::{ChiaRpcClient, CoinsetClient};
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
/// Gateway pages followed per hint per poll (each page is one HTTPS call).
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
    /// the next poll continues it from the gateway's cursor instead of starting
    /// over, and `last_height` never moves past pages nobody has fetched.
    pub pending: Option<PendingPage>,
    /// The last poll hit `MAX_PARENT_FETCHES_PER_POLL` and left listed coins
    /// unexamined; `last_height` stayed put, so the next poll re-lists them and
    /// takes the next batch. Together with `pending`, "there is more to read".
    pub backlog: bool,
}

/// Where a page-capped poll stopped, so the next poll continues the SAME
/// listing. A gateway cursor is only meaningful for the query that produced
/// it, so the query's `start_height` travels with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingPage {
    pub start_height: Option<u32>,
    /// The gateway's `next_cursor` for the first page not yet fetched.
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
    /// one (taken, so a cursor the gateway no longer honours fails once and
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

/// Read every record under `hint` not yet examined by `cursor`. Follows gateway
/// pages, reads spent coins, caps parent fetches, verifies and filters. The
/// cursor's `last_height` advances only when a listing ENDED (the gateway sent
/// its last page) and every coin it listed was examined; a poll that spends its
/// page budget first parks the gateway cursor in `pending` and the next poll
/// continues the same listing, so no page is ever skipped. A capped or failed
/// poll re-reads what it skipped next time.
pub async fn read_hint(
    client: &CoinsetClient,
    hint: Bytes32,
    room_key: &[u8; 32],
    now: u64,
    cursor: &mut HintCursor,
) -> Result<Vec<FoundRecord>> {
    read_hint_with(client, hint, cursor, &|ciphertext, _height| decode_blob(room_key, ciphertext, now)).await
}

/// [`read_hint`] with the OPENER as a parameter: the listing, paging, parent
/// fetching, cursor and flood rules are the same for every record kind; only
/// how a ciphertext becomes a record differs. The opener gets the ciphertext
/// and the height of the block that confirmed the coin (v2's era rule).
pub async fn read_hint_with(
    client: &CoinsetClient,
    hint: Bytes32,
    cursor: &mut HintCursor,
    opener: &(dyn Fn(&[u8], u32) -> Option<ChiaPresenceRecord> + Sync),
) -> Result<Vec<FoundRecord>> {
    let Resume { start, mut page, mut max_height, mut examined_all } = cursor.resume();
    let mut coins = Vec::new();
    // `listed` = the gateway reported the listing's last page this poll.
    let mut listed = false;
    for _ in 0..MAX_PAGES_PER_POLL {
        let resp = client
            .get_coin_records_by_hint(hint, start, None, Some(true), page.clone())
            .await
            .map_err(|e| anyhow!("get_coin_records_by_hint: {e}"))?;
        if !resp.success {
            return Err(anyhow!("hint lookup unsuccessful: {:?}", resp.error));
        }
        coins.extend(resp.coin_records.unwrap_or_default());
        match (resp.truncated, resp.next_cursor) {
            (Some(true), Some(next)) => page = Some(next),
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
        if let Some(record) = opener(&ciphertext, rec.confirmed_block_index) {
            out.push(FoundRecord {
                record,
                coin_id: Bytes32::new(coin_id),
                confirmed_height: rec.confirmed_block_index,
                hint,
            });
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
    client: &CoinsetClient,
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
        let opener = |ct: &[u8], height: u32| decode_v2_presence(ck, ct, era, height, now);
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
    let client = CoinsetClient::testnet11();
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
    let client = CoinsetClient::testnet11();
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

/// The chain's current peak height from the gateway, or `None` when the call
/// fails (the caller logs and keeps its last beat).
pub async fn peak_height(client: &CoinsetClient) -> Option<u32> {
    match client.get_blockchain_state().await {
        Ok(resp) if resp.success => resp.blockchain_state.map(|s| s.peak.height),
        Ok(resp) => {
            eprintln!("⛓️ ChiaHub reader: get_blockchain_state unsuccessful: {:?}", resp.error);
            None
        }
        Err(e) => {
            eprintln!("⛓️ ChiaHub reader: get_blockchain_state failed: {e}");
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
    client: &CoinsetClient,
    coin_id: Bytes32,
    height: u32,
) -> Result<Option<CoinSpend>> {
    let resp = client
        .get_puzzle_and_solution(coin_id, Some(height))
        .await
        .map_err(|e| anyhow!("get_puzzle_and_solution: {e}"))?;
    if !resp.success {
        return Ok(None);
    }
    Ok(resp.coin_solution)
}

/// Run the parent spend and return the ciphertext (2nd memo) of the create_coin
/// whose FIRST memo is our `hint` — the ecosystem hint convention we published with.
pub(crate) fn extract_ciphertext(coin_spend: &CoinSpend, hint: Bytes32) -> Result<Option<Vec<u8>>> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(c.pending.is_none(), "taken: a cursor the gateway refuses fails once, then we start fresh");
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
}
