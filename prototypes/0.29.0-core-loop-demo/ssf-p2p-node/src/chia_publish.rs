//! ChiaHub C1 Slice 4: PUBLISH a room-key-sealed presence record as a
//! spend-to-self carrying `[hint, ciphertext]` memos on testnet11.
//!
//! Two keys, two roles (this is the whole design):
//!   - the IROH secret key SIGNS the presence record (identity + authorship — a
//!     resolver dials the `node_id` inside it), via the shipped `chia_lane` crypto;
//!   - the CHIA BLS secret key PAYS for the publish (spends one of the wallet's
//!     coins back to itself, carrying the sealed record as memos).
//!
//! The principal returns to the wallet (spend-to-self, amount − fee), so only the
//! fee leaves. Every SDK call is the source-verified 0.34 API (audit surfaces B/C/D).
//! Behind the `chia-publish` feature; runtime-gated by SSF_CHIA_LANE=1 at the caller.
//!
//! N8 (#231): a room that is public space (bundled seed or PUBLIC passage) is
//! never published under, armed or not — see [`publishable_rooms`].
#![cfg(feature = "chia-publish")]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use chia_bls::{aggregate, sign, PublicKey, SecretKey, Signature};
use chia_protocol::{Bytes, Bytes32, Coin, CoinSpend, SpendBundle};
use chia_puzzle_types::standard::StandardArgs;
use chia_puzzle_types::DeriveSynthetic;
use chia_sdk_coinset::{ChiaRpcClient, CoinsetClient};
use chia_sdk_driver::{SpendContext, StandardLayer};
use chia_sdk_signer::{AggSigConstants, RequiredSignature};
use chia_sdk_types::{Conditions, TESTNET11_CONSTANTS};
use clvmr::Allocator;

use crate::chia_lane::{self, ChiaPresenceRecord};
use crate::chia_rooms::ChiaRoomCap;

/// Fee (mojos) for a publish. 0 confirms when the mempool is quiet (the usual
/// testnet state); the spend-to-self recreates the coin at `amount − fee`, so at
/// fee 0 the principal is fully preserved. Bump under sustained congestion.
const PUBLISH_FEE: u64 = 0;

/// How long a published record advertises itself as fresh (seconds). Advisory —
/// the chain cannot delete; resolvers enforce freshness and writers heartbeat.
const RECORD_TTL_SECS: u64 = 3600;

/// The standard puzzle hash our coins are locked to (from the synthetic key).
pub fn our_puzzle_hash(chia_sk: &SecretKey) -> Bytes32 {
    let synthetic_pk: PublicKey = chia_sk.public_key().derive_synthetic();
    StandardArgs::curry_tree_hash(synthetic_pk).into()
}

/// A spend pushed a moment ago may not show on the gateway yet (its coins still
/// unspent, the mempool item not indexed): parked coins younger than this are
/// not asked about. Testnet11 confirms in about a block (18.75 s).
pub const RECONCILE_GRACE: Duration = Duration::from_secs(20);

/// Pages of `get_coin_records_by_names` a reconciliation follows (one HTTPS
/// call each). Parked coins number a handful; a listing still cut short after
/// this many pages is treated as INCOMPLETE and settles nothing it left out.
pub const MAX_RECONCILE_PAGES: usize = 8;

/// 🔒 Wallet spend lease (#245 review). Every spend from OUR wallet — the
/// presence heartbeat (`publish_presence`, also the startup publish hook), the
/// craps fairness hook's commit and reveal (`chia_craps_fair`), the faucet
/// dish's GIVE (`chia_faucet`) — selects its coins, builds and pushes while
/// holding `gate`, and parks the coin ids it consumes in `pending` BEFORE the
/// push leaves (see [`push_parked`]). Until a pushed spend confirms, the chain
/// still lists its coins as unspent, so a second spend started in that window
/// would pick the same coin and die in the mempool as a double-spend; with the
/// lease it skips them. (The heartbeat's one-publish-per-tick rule serialized
/// its own publishes; this covers every writer.)
///
/// Parked before, not after, the push (#245 review, round 9): a push that
/// fails on the TRANSPORT (a timeout above all) is indeterminate — the gateway
/// may hold the bundle — and a coin parked only on success would be free for
/// the next writer to select while its spend sits in the mempool. So the
/// inputs are parked first; an explicit REJECTION from the gateway (it holds
/// nothing of the spend) hands them back at once, a transport error leaves
/// them parked for the reconciliation below to settle.
///
/// A parked coin is released by what the chain and the mempool say, not by a
/// timer (#245 review, round 7: a zero-fee spend can wait in the mempool for
/// longer than any fixed window). [`WalletLease::reconcile`], run by every
/// writer under the lease before it selects and by the dish's status read,
/// releases a coin whose spend CONFIRMED (the chain lists it spent: it is
/// gone) or was DROPPED (still unspent on chain and no longer in the mempool:
/// it is free again), and keeps one whose spend still waits in the mempool,
/// however long that takes.
///
/// Coins are parked PER SPEND (#245 review, round 11): a spend bundle is
/// atomic — the chain confirms every one of its inputs or none, the mempool
/// holds all of them or none — so reconciliation asks the mempool ONCE per
/// spend, not once per coin. A GIVE paid from a wallet dusted into hundreds
/// of coins is then one lookup under the lease, not hundreds in a row.
///
/// The faucet dish's TAKE is the one spend INTO our wallet: it runs under
/// `gate` too (its "is my wallet empty" courtesy check, coin pick and push are
/// one critical section) and records in `incoming` the faucet coin its claim
/// spent. Until that claim confirms the chain still shows the wallet empty, so
/// without the marker a second TAKE in that window would pass the courtesy
/// check and draw another mojo from another ready coin (#245 review, round 3).
/// The gift reads as landing exactly while that coin is parked: confirmed, it
/// is in the wallet and the owned-coins check takes over; dropped, the wallet
/// is still empty and the dish may be asked again.
pub struct WalletLease {
    gate: tokio::sync::Mutex<()>,
    pending: std::sync::Mutex<HashMap<Bytes32, Parked>>,
    incoming: std::sync::Mutex<Option<Bytes32>>,
    /// Spend numbers handed out so far (see [`Parking`]).
    spends: std::sync::atomic::AtomicU64,
    /// The last spend a reconciliation asked the mempool about: the next pass
    /// starts its probe window after it (see [`mempool_probes`]).
    probe_cursor: std::sync::atomic::AtomicU64,
}

/// A parked coin: when, and by which spend (see [`Parking`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Parked {
    at: Instant,
    spend: u64,
}

/// One spend's parking: its number, unique for the life of the process, and
/// the coins it consumes. The NUMBER is what a verdict or a rejection releases,
/// so a coin parked again by a later spend (a new number) keeps its marker
/// whatever an older verdict says — compare-and-release (#245 review, round 8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parking {
    spend: u64,
    coins: Vec<Bytes32>,
}

/// A parked spend old enough to ask the gateway about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueSpend {
    pub spend: u64,
    pub coins: Vec<Bytes32>,
}

/// The process-wide lease: one wallet per node, so one lease.
pub static WALLET_LEASE: std::sync::LazyLock<WalletLease> = std::sync::LazyLock::new(WalletLease::new);

impl WalletLease {
    pub fn new() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            pending: std::sync::Mutex::new(HashMap::new()),
            incoming: std::sync::Mutex::new(None),
            spends: std::sync::atomic::AtomicU64::new(0),
            probe_cursor: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Hold the guard across select → build → push.
    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    /// Park the coins a spend is ABOUT to consume, before its push leaves (see
    /// [`push_parked`]). The returned [`Parking`] hands exactly this parking
    /// back on an explicit rejection; a transport error keeps it.
    pub fn park(&self, coin_ids: impl IntoIterator<Item = Bytes32>) -> Parking {
        self.park_at(coin_ids, Instant::now())
    }

    pub fn park_at(&self, coin_ids: impl IntoIterator<Item = Bytes32>, now: Instant) -> Parking {
        let spend = self.spends.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let coins: Vec<Bytes32> = coin_ids.into_iter().collect();
        let mut pending = self.pending.lock().unwrap();
        for id in &coins {
            pending.insert(*id, Parked { at: now, spend });
        }
        Parking { spend, coins }
    }

    /// The gateway REJECTED the spend outright, so it holds nothing of it and
    /// the coins are free again (compare-and-release, see [`Parking`]).
    pub fn unpark(&self, parking: &Parking) {
        self.release(&[parking.spend]);
    }

    /// A coin some pushed spend consumed, as far as the chain and the mempool
    /// have told us (see [`WalletLease::reconcile`]): skip it when selecting.
    /// Only a verdict clears it, never the clock (#245 review, round 10): a
    /// zero-fee spend can wait in the mempool for hours, so an eviction on
    /// elapsed time would free a coin whose spend is still live — the very
    /// double-spend, or second gift, the lease exists to prevent. A gateway
    /// that cannot be asked keeps the coin parked, fail closed; a gateway that
    /// is down can take no spend either, so nothing is lost meanwhile.
    pub fn is_pending(&self, coin_id: &Bytes32) -> bool {
        self.pending.lock().unwrap().contains_key(coin_id)
    }

    /// Record the faucet coin a claim just spent: the gift INTO our wallet is
    /// landing for as long as that coin stays parked.
    pub fn mark_incoming(&self, faucet_coin: Bytes32) {
        *self.incoming.lock().unwrap() = Some(faucet_coin);
    }

    /// A gift to our wallet is still landing: the wallet is not empty even
    /// though the chain does not list the coin yet.
    pub fn incoming_pending(&self) -> bool {
        let coin = *self.incoming.lock().unwrap();
        match coin {
            Some(id) if self.is_pending(&id) => true,
            Some(_) => {
                *self.incoming.lock().unwrap() = None;
                false
            }
            None => false,
        }
    }

    /// The parked spends old enough to ask the gateway about, each with the
    /// coins it parked (sorted), oldest spend first.
    pub fn due_at(&self, now: Instant) -> Vec<DueSpend> {
        let pending = self.pending.lock().unwrap();
        let mut by_spend: BTreeMap<u64, Vec<Bytes32>> = BTreeMap::new();
        for (id, parked) in pending.iter() {
            if now.duration_since(parked.at) >= RECONCILE_GRACE {
                by_spend.entry(parked.spend).or_default().push(*id);
            }
        }
        by_spend
            .into_iter()
            .map(|(spend, mut coins)| {
                coins.sort();
                DueSpend { spend, coins }
            })
            .collect()
    }

    /// Forget the coins the given spends parked. A coin parked AGAIN by a later
    /// spend in the meantime (a new spend of a coin the chain had let go) carries
    /// that spend's number and stays, whatever a stale verdict says.
    pub fn release(&self, spends: &[u64]) {
        self.pending.lock().unwrap().retain(|_, parked| !spends.contains(&parked.spend));
    }

    /// Settle the parked spends against the chain and the mempool: ask the
    /// gateway about every spend past the grace, then release what [`settle`]
    /// says. Lookups that fail leave their spends parked, FAIL CLOSED: a coin
    /// stays parked until the gateway gives an authoritative answer, however
    /// long that takes; nothing here is decided by the clock. Callers hold the
    /// lease gate (every writer does; the dish's status read takes it for
    /// this), and `release` is compare-and-release besides, so a verdict can
    /// never remove a marker parked after it was formed.
    pub async fn reconcile(&self, client: &CoinsetClient) {
        let due = self.due_at(Instant::now());
        if due.is_empty() {
            return;
        }
        let coins: Vec<Bytes32> = due.iter().flat_map(|d| d.coins.iter().copied()).collect();
        // One listing for every parked coin, paged like every coinset listing:
        // follow the cursor, and if it is still cut short at the cap (or
        // truncated with no cursor), the listing is INCOMPLETE and a spend with
        // a coin it left out is kept.
        let mut records = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0usize;
        let complete = loop {
            let resp = match client
                .get_coin_records_by_names(coins.clone(), None, None, Some(true), cursor.take())
                .await
            {
                Ok(resp) if resp.success => resp,
                Ok(resp) => {
                    eprintln!("⛓️ wallet lease: coin lookup unsuccessful ({:?}); parked coins stay parked", resp.error);
                    return;
                }
                Err(e) => {
                    eprintln!("⛓️ wallet lease: coin lookup failed ({e}); parked coins stay parked");
                    return;
                }
            };
            pages += 1;
            records.extend(resp.coin_records.unwrap_or_default());
            let truncated = resp.truncated.unwrap_or(false);
            match resp.next_cursor {
                Some(next) if truncated => {
                    if pages >= MAX_RECONCILE_PAGES {
                        break false;
                    }
                    cursor = Some(next);
                }
                _ => break !truncated,
            }
        };
        let spent_on_chain: HashMap<Bytes32, bool> = records.iter().map(|r| (r.coin.coin_id(), r.spent)).collect();
        // One mempool question per spend the chain still lists unspent in full
        // (see `mempool_probes`): a bundle sits in the mempool with all of its
        // inputs or with none, so any one of them answers for the spend.
        let mut in_mempool: HashMap<u64, Option<bool>> = HashMap::new();
        let after = self.probe_cursor.load(std::sync::atomic::Ordering::Relaxed);
        let probes = mempool_probes(&due, &spent_on_chain, after);
        if let Some((last, _)) = probes.last() {
            self.probe_cursor.store(*last, std::sync::atomic::Ordering::Relaxed);
        }
        for (spend, coin) in probes {
            let seen = match client.get_mempool_items_by_coin_name(coin).await {
                Ok(resp) if resp.success => Some(resp.mempool_items.is_some_and(|items| !items.is_empty())),
                Ok(resp) => {
                    eprintln!("⛓️ wallet lease: mempool lookup unsuccessful ({:?}); spend stays parked", resp.error);
                    None
                }
                Err(e) => {
                    eprintln!("⛓️ wallet lease: mempool lookup failed ({e}); spend stays parked");
                    None
                }
            };
            in_mempool.insert(spend, seen);
        }
        let released = settle(&due, &spent_on_chain, &in_mempool, complete);
        if !released.is_empty() {
            self.release(&released);
        }
    }
}

/// Push `bundle`, which consumes `inputs`, with the inputs PARKED FIRST (#245
/// review, round 9). The three outcomes of a push, and what each leaves:
///   - accepted: the inputs stay parked until the chain or the mempool settles
///     the spend ([`WalletLease::reconcile`]);
///   - rejected by the gateway (an explicit `success: false`): it holds nothing
///     of the spend, so the inputs are handed back at once;
///   - a transport error (a timeout above all): INDETERMINATE — the request may
///     have reached the gateway and the spend may be in the mempool while the
///     chain still lists the inputs unspent — so the inputs stay parked and
///     reconciliation settles them (dropped: free again after the grace;
///     landed: gone with the confirmation).
/// Parking only on success, as the writers first did, left the third case
/// free for the next writer to select and double-spend.
///
/// Callers hold the lease gate. For the dish's TAKE the input is the FAUCET
/// coin, not ours: parking it keeps a second TAKE off it the same way.
pub async fn push_parked(
    client: &CoinsetClient,
    bundle: SpendBundle,
    inputs: impl IntoIterator<Item = Bytes32>,
) -> Result<()> {
    let parking = WALLET_LEASE.park(inputs);
    let resp = match client.push_tx(bundle).await {
        Ok(resp) => resp,
        Err(e) => {
            return Err(anyhow!(
                "coinset push_tx failed: {e} (the coins it spends stay parked until the chain or the mempool settles them)"
            ))
        }
    };
    if !resp.success {
        WALLET_LEASE.unpark(&parking);
        return Err(anyhow!("push_tx rejected: {:?}", resp.error));
    }
    Ok(())
}

/// How many spends one reconciliation asks the mempool about (one HTTPS call
/// each); the rest wait for the next pass. Spends in flight are one per writer
/// action, so the bound is rarely reached, and it keeps a pass under the lease
/// short whatever is parked (#245 review, round 11).
pub const MAX_MEMPOOL_PROBES: usize = 8;

/// Which due spends need the mempool's word, and the coin to ask with: a spend
/// EVERY input of which the chain still lists unspent. One with a spent input
/// is settled without the mempool (confirmed, or dead to another spend of that
/// coin); one with an input the listing left out is settled by whether the
/// listing was complete. One probe per spend, at most [`MAX_MEMPOOL_PROBES`].
///
/// The window ROTATES (#245 review, round 13): it opens at the first eligible
/// spend numbered above `after` — the last spend the previous pass asked about
/// — and wraps around to the oldest, so when more spends wait in the mempool
/// than one pass covers, every later spend is still reached on a later pass
/// and none is starved of the verdict that would release its coins.
pub fn mempool_probes(
    due: &[DueSpend],
    spent_on_chain: &HashMap<Bytes32, bool>,
    after: u64,
) -> Vec<(u64, Bytes32)> {
    let eligible: Vec<(u64, Bytes32)> = due
        .iter()
        .filter(|d| d.coins.iter().all(|c| spent_on_chain.get(c) == Some(&false)))
        .filter_map(|d| d.coins.first().map(|c| (d.spend, *c)))
        .collect();
    let start = eligible.iter().position(|(spend, _)| *spend > after).unwrap_or(0);
    eligible[start..]
        .iter()
        .chain(eligible[..start].iter())
        .copied()
        .take(MAX_MEMPOOL_PROBES)
        .collect()
}

/// Which parked spends to release, from what the chain and the mempool said.
/// Per spend: any input SPENT on chain → the spend confirmed (or lost that coin
/// to another spend, which kills ours), so it is released and its other coins
/// are free or gone. An input the listing does not mention → gone only if the
/// listing was COMPLETE (no such coin on chain, so no live spend of it and
/// nothing to double-spend): released then, kept when the listing was cut
/// short, which says nothing about what it left out. Every input UNSPENT → the
/// mempool decides: not there (`Some(false)`) → dropped, released; there, or
/// not asked (`None`) → stays parked.
pub fn settle(
    due: &[DueSpend],
    spent_on_chain: &HashMap<Bytes32, bool>,
    in_mempool: &HashMap<u64, Option<bool>>,
    complete: bool,
) -> Vec<u64> {
    due.iter()
        .filter(|d| {
            let states: Vec<Option<bool>> = d.coins.iter().map(|c| spent_on_chain.get(c).copied()).collect();
            if states.iter().any(|s| *s == Some(true)) {
                return true;
            }
            if states.iter().any(|s| s.is_none()) {
                return complete;
            }
            in_mempool.get(&d.spend).copied().flatten() == Some(false)
        })
        .map(|d| d.spend)
        .collect()
}

impl Default for WalletLease {
    fn default() -> Self {
        Self::new()
    }
}

/// Find our largest UNSPENT coin — the one to spend-to-self — skipping coins a
/// spend is already pending for (see [`WalletLease`]). `None` if unfunded.
///
/// Every page of the listing is read, up to the bound every wallet listing
/// shares (`chia_faucet::MAX_FAUCET_PAGES`): the first page can hold only
/// parked coins while a free one sits on the next, and a one-page read then
/// called a funded wallet unfunded (#245 review, round 9).
pub async fn find_spendable_coin(
    client: &CoinsetClient,
    puzzle_hash: Bytes32,
) -> Result<Option<Coin>> {
    let listing = crate::chia_faucet::unspent_at(client, puzzle_hash).await?;
    let mut coins: Vec<Coin> = listing
        .coins
        .into_iter()
        .map(|c| c.coin)
        .filter(|c| !WALLET_LEASE.is_pending(&c.coin_id()))
        .collect();
    if coins.is_empty() && listing.partial {
        eprintln!(
            "⛓️ wallet: no free coin in the first {} pages at {puzzle_hash}; the listing was cut short, so there may be one further on",
            crate::chia_faucet::MAX_FAUCET_PAGES
        );
    }
    // Largest first — the recreated coin keeps the most value for future republishes.
    coins.sort_by_key(|c| std::cmp::Reverse(c.amount));
    Ok(coins.into_iter().next())
}

/// Build the SIGNED SpendBundle: spend `coin` back to our own puzzle hash at
/// `amount − fee`, carrying MEMOS = `( hint ciphertext )` (a proper 2-element
/// CLVM list). Signed for TESTNET11 with the synthetic BLS key.
pub fn build_publish_bundle(
    chia_sk: &SecretKey,
    coin: Coin,
    hint: Bytes32,
    ciphertext: Bytes,
) -> Result<SpendBundle> {
    let synthetic_sk: SecretKey = chia_sk.derive_synthetic();
    let synthetic_pk: PublicKey = synthetic_sk.public_key();
    let our_ph: Bytes32 = StandardArgs::curry_tree_hash(synthetic_pk).into();

    if coin.amount < PUBLISH_FEE {
        return Err(anyhow!("coin amount {} < fee {}", coin.amount, PUBLISH_FEE));
    }
    let out_amount = coin.amount - PUBLISH_FEE;

    let mut ctx = SpendContext::new();
    // MEMOS value = ( hint . ( ciphertext . () ) ) == proper list [hint, ciphertext].
    // The trailing `()` makes it a true 2-element list (not an improper cons pair).
    let memos = ctx
        .memos(&(hint, (ciphertext, ())))
        .map_err(|e| anyhow!("alloc memos: {e:?}"))?;
    let conditions = Conditions::new().create_coin(our_ph, out_amount, memos);
    StandardLayer::new(synthetic_pk)
        .spend(&mut ctx, coin, conditions)
        .map_err(|e| anyhow!("standard-layer spend: {e:?}"))?;
    sign_standard_spends(chia_sk, ctx.take())
}

/// Sign standard-puzzle coin spends with our SYNTHETIC key for testnet11
/// (agg_sig_me additional data == the testnet11 genesis challenge) and bundle
/// them. Shared by the presence publisher and the faucet dish's GIVE spend.
pub fn sign_standard_spends(chia_sk: &SecretKey, coin_spends: Vec<CoinSpend>) -> Result<SpendBundle> {
    let synthetic_sk: SecretKey = chia_sk.derive_synthetic();
    let synthetic_pk: PublicKey = synthetic_sk.public_key();
    let mut allocator = Allocator::new();
    let constants = AggSigConstants::from(&*TESTNET11_CONSTANTS);
    let required = RequiredSignature::from_coin_spends(&mut allocator, &coin_spends, &constants)
        .map_err(|e| anyhow!("required signatures: {e:?}"))?;
    let mut sigs: Vec<Signature> = Vec::new();
    for req in &required {
        match req {
            RequiredSignature::Bls(bls) => {
                // Standard-puzzle coins require the SYNTHETIC key; chia_bls::sign
                // augments with sk.public_key(), so sign with the synthetic sk.
                if bls.public_key != synthetic_pk {
                    return Err(anyhow!(
                        "spend requires an unexpected signer key {:?}",
                        bls.public_key
                    ));
                }
                sigs.push(sign(&synthetic_sk, bls.message()));
            }
            RequiredSignature::Secp(_) => {
                return Err(anyhow!("unexpected secp signature on a standard spend"));
            }
        }
    }
    let aggregated: Signature = aggregate(&sigs);
    Ok(SpendBundle::new(coin_spends, aggregated))
}

// ── Slice 6: heartbeat publisher for ARMED rooms ─────────────────────────────

/// Publish cadence once a room's last publish SUCCEEDED (the ~30–60 min
/// heartbeat from the ChiaHub plan §3.1; 30 min keeps records fresh well inside
/// resolvers' freshness window).
const HEARTBEAT_OK_SECS: u64 = 30 * 60;
/// Retry cadence after a FAILED publish (e.g. wallet unfunded) — frequent enough
/// to pick up a faucet funding within minutes, sparse enough not to spam logs.
const HEARTBEAT_RETRY_SECS: u64 = 5 * 60;
/// Loop tick — how often armed rooms are checked for due publishes.
const HEARTBEAT_TICK_SECS: u64 = 60;

/// Last publish attempt per room (loop-local; rebuilt on node restart, which just
/// causes one early republish — harmless, spend-to-self is idempotent in effect).
pub struct PublishMark {
    pub room_key: [u8; 32],
    pub addrs_sig: String,
    pub at: Instant,
    pub ok: bool,
}

/// N8 in one place: of the rooms the browser handed us, which may publish right
/// now (armed AND known private) and which are armed but refused — their key is
/// public space (bundled seed or PUBLIC passage), or the browser predates N8 and
/// never said which, and silence fails closed.
pub fn publishable_rooms(caps: &[(String, ChiaRoomCap)]) -> (Vec<(String, [u8; 32])>, Vec<String>) {
    let mut armed = Vec::new();
    let mut refused = Vec::new();
    for (room, cap) in caps {
        if cap.may_publish() {
            armed.push((room.clone(), cap.room_key));
        } else if cap.chia_mode {
            refused.push(room.clone());
        }
    }
    (armed, refused)
}

/// Is a publish due? Always for a room never published; otherwise on a room-key
/// change, an address change, or once the OK / retry cadence has elapsed.
pub fn publish_due(mark: Option<&PublishMark>, room_key: &[u8; 32], addrs_sig: &str, now: Instant) -> bool {
    match mark {
        None => true,
        Some(m) => {
            m.room_key != *room_key
                || m.addrs_sig != addrs_sig
                || now.saturating_duration_since(m.at)
                    >= Duration::from_secs(if m.ok { HEARTBEAT_OK_SECS } else { HEARTBEAT_RETRY_SECS })
        }
    }
}

/// Slice 6: the REAL-room publisher — what makes the lane operate beyond the
/// fixed-test-key SLICE 4 hook. Every armed room (its browser delivered the room
/// key with chia_mode=true — the "advanced Chia mesh mode" toggle) gets a
/// presence record sealed under its REAL room key published: within one tick of
/// arming, every ~30 min thereafter, immediately on address change, and on a
/// 5-min retry after failures (e.g. unfunded wallet — the log tells the operator
/// to fund).
///
/// At most ONE room publishes per tick: sequential spends inside one ~19 s block
/// window would double-spend the same wallet coin (the recreated coin only
/// becomes findable once its block confirms), so due rooms drain one per minute —
/// far faster than the 30-min cadence needs. Every failure is log-and-continue;
/// the lane never affects the mesh.
pub async fn heartbeat_loop(
    hub: crate::SharedHub,
    iroh_ep: iroh::Endpoint,
    iroh_sk: iroh::SecretKey,
    chia_sk: SecretKey,
) {
    let mut marks: HashMap<String, PublishMark> = HashMap::new();
    // N8: public-space rooms that are armed, already told about once.
    let mut refused_logged: HashSet<String> = HashSet::new();
    loop {
        tokio::time::sleep(Duration::from_secs(HEARTBEAT_TICK_SECS)).await;
        // Live addresses (F3 rule: hints are live data, not a boot-time snapshot).
        let addrs: Vec<String> = iroh_ep
            .addr()
            .ip_addrs()
            .filter(|sock| !sock.ip().is_unspecified())
            .map(|sock| sock.to_string())
            .collect();
        if addrs.is_empty() {
            continue; // nothing routable to advertise yet
        }
        let addrs_sig = addrs.join(",");
        let caps: Vec<(String, ChiaRoomCap)> = hub
            .chia_rooms
            .lock()
            .unwrap()
            .iter()
            .map(|(room, cap)| (room.clone(), cap.clone()))
            .collect();
        let (armed, refused) = publishable_rooms(&caps);
        refused_logged.retain(|room| refused.contains(room));
        for room in &refused {
            if refused_logged.insert(room.clone()) {
                println!(
                    "⛓️ ChiaHub heartbeat: room {room} is armed but N8 refuses it — its key is public space (bundled seed or PUBLIC passage), or the browser predates N8 and never said; no address is published under its key until the browser says private"
                );
            }
        }
        // Forget rooms no longer armed (toggle flipped off / cap replaced).
        marks.retain(|room, _| armed.iter().any(|(r, _)| r == room));
        for (room, room_key) in armed {
            let due = publish_due(marks.get(&room), &room_key, &addrs_sig, Instant::now());
            if !due {
                continue;
            }
            let ok = match publish_presence(&iroh_sk, &chia_sk, &room_key, &addrs).await {
                Ok(hint) => {
                    println!(
                        "⛓️ ChiaHub heartbeat: presence published for room {room} · hint {}",
                        hex::encode(&hint.to_bytes()[..8])
                    );
                    true
                }
                Err(e) => {
                    eprintln!(
                        "⛓️ ChiaHub heartbeat: publish for room {room} failed: {e:#} (retry in {} min)",
                        HEARTBEAT_RETRY_SECS / 60
                    );
                    false
                }
            };
            marks.insert(
                room,
                PublishMark { room_key, addrs_sig: addrs_sig.clone(), at: Instant::now(), ok },
            );
            break; // one publish per tick — see doc comment (mempool double-spend)
        }
    }
}

/// Full publish: seal the presence record, find our coin, spend-to-self with the
/// `[hint, ciphertext]` memos, and push to testnet11. Returns the published hint.
///
/// `iroh_sk` signs the record (identity); `chia_sk` pays (spends the coin).
/// `live_addrs` are the node's current direct addresses (F3 rule: live data).
pub async fn publish_presence(
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    room_key: &[u8; 32],
    live_addrs: &[String],
) -> Result<Bytes32> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // 1. Build + sign (iroh key) + seal (room key) the presence record — all the
    //    shipped, unit-tested chia_lane crypto.
    let record = ChiaPresenceRecord {
        v: 1,
        node_id: iroh_sk.public().to_string(),
        addrs: live_addrs.to_vec(),
        relay_urls: vec![],
        issued_at: now,
        expires_at: now + RECORD_TTL_SECS,
    };
    let blob = chia_lane::encode_signed(&record, iroh_sk)?;
    let sealed = chia_lane::seal(room_key, &blob)?;
    let hint = Bytes32::new(chia_lane::derive_hint(room_key, chia_lane::epoch_now(now)));
    let ciphertext = Bytes::new(sealed);

    // 2. Find our fundable coin (pays for the spend) — under the wallet lease,
    //    so no other writer picks the same coin before this spend confirms.
    let _lease = WALLET_LEASE.lock().await;
    let client = CoinsetClient::testnet11();
    WALLET_LEASE.reconcile(&client).await;
    let our_ph = our_puzzle_hash(chia_sk);
    let coin = find_spendable_coin(&client, our_ph)
        .await?
        .ok_or_else(|| anyhow!("chia wallet unfunded — no unspent coin at puzzle hash {our_ph}"))?;

    // 3. Build + sign the spend-to-self, then push to the mempool with the coin
    //    parked first (push_parked: a timed-out push may still have landed).
    let bundle = build_publish_bundle(chia_sk, coin, hint, ciphertext)?;
    push_parked(&client, bundle, [coin.coin_id()]).await?;
    Ok(hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(key: u8, chia_mode: bool, public_room: Option<bool>) -> ChiaRoomCap {
        ChiaRoomCap { room_key: [key; 32], chia_mode, public_room, seq: 0 }
    }

    #[test]
    fn wallet_lease_parks_spent_coins_until_the_chain_or_mempool_settles_them() {
        let lease = WalletLease::new();
        let a = Bytes32::new([1u8; 32]);
        let b = Bytes32::new([2u8; 32]);
        let t0 = Instant::now();
        assert!(!lease.is_pending(&a));
        let parking = lease.park_at([a], t0);
        assert!(lease.is_pending(&a));
        assert!(!lease.is_pending(&b));
        // No timer releases it, however long the spend waits in the mempool:
        // only the chain/mempool verdict does (release).
        assert!(lease.due_at(t0 + Duration::from_secs(5)).is_empty(), "inside the grace: not asked yet");
        assert_eq!(lease.due_at(t0 + RECONCILE_GRACE), vec![DueSpend { spend: parking.spend, coins: vec![a] }]);
        lease.release(&[parking.spend]);
        assert!(!lease.is_pending(&a));
        lease.park_at([b], t0);
        assert!(lease.is_pending(&b), "no eviction on elapsed time: parked until a verdict");
    }

    #[test]
    fn a_stale_verdict_cannot_release_a_coin_parked_again_since() {
        let lease = WalletLease::new();
        let a = Bytes32::new([1u8; 32]);
        let t0 = Instant::now();
        let first = lease.park_at([a], t0);
        // A verdict formed for the first parking…
        let verdict: Vec<u64> = lease.due_at(t0 + RECONCILE_GRACE).iter().map(|d| d.spend).collect();
        assert_eq!(verdict, vec![first.spend]);
        // …while a writer saw the coin released and spent it again.
        lease.release(&[first.spend]);
        let second = lease.park_at([a], t0 + Duration::from_secs(30));
        // The stale verdict lands: the fresh marker stays.
        lease.release(&verdict);
        assert!(lease.is_pending(&a));
        // The verdict formed for the new parking does release it.
        let later: Vec<u64> = lease.due_at(t0 + Duration::from_secs(60)).iter().map(|d| d.spend).collect();
        assert_eq!(later, vec![second.spend]);
        lease.release(&later);
        assert!(!lease.is_pending(&a));
    }

    #[test]
    fn inputs_are_parked_before_dispatch_and_only_an_explicit_rejection_frees_them() {
        let lease = WalletLease::new();
        let a = Bytes32::new([7u8; 32]);
        let b = Bytes32::new([8u8; 32]);
        let t0 = Instant::now();
        // Parked the moment the writer commits to the spend, before any push.
        let parking = lease.park_at([a, b], t0);
        assert!(lease.is_pending(&a) && lease.is_pending(&b));
        // A transport error leaves the parking alone (push_parked calls nothing):
        // both coins stay parked and come due for reconciliation after the grace,
        // as ONE spend.
        let due = lease.due_at(t0 + RECONCILE_GRACE);
        assert_eq!(due, vec![DueSpend { spend: parking.spend, coins: vec![a, b] }]);
        // An explicit rejection hands exactly this parking back.
        lease.unpark(&parking);
        assert!(!lease.is_pending(&a) && !lease.is_pending(&b));
        // …but never a NEWER parking of the same coin: a later writer's spend of
        // a coin the gateway rejected the first time keeps its marker.
        let first = lease.park_at([a], t0);
        lease.unpark(&first);
        let _second = lease.park_at([a], t0 + Duration::from_secs(1));
        lease.unpark(&first); // stale: the first spend's rejection, arriving late
        assert!(lease.is_pending(&a));
    }

    #[test]
    fn settle_releases_confirmed_and_dropped_spends_and_keeps_the_waiting_ones() {
        let id = |n: u8| Bytes32::new([n; 32]);
        let spend = |n: u64, coins: &[Bytes32]| DueSpend { spend: n, coins: coins.to_vec() };
        // 1 confirmed (its input spent); 2 dropped (unspent, gone from the
        // mempool); 3 waiting (unspent, in the mempool); 4 unknown (unspent,
        // mempool not asked); 5 never existed (not listed); 6 a three-input
        // GIVE, all unspent and dropped; 7 one input unspent, one not listed.
        let due = vec![
            spend(1, &[id(1)]),
            spend(2, &[id(2)]),
            spend(3, &[id(3)]),
            spend(4, &[id(4)]),
            spend(5, &[id(5)]),
            spend(6, &[id(6), id(7), id(8)]),
            spend(7, &[id(9), id(10)]),
        ];
        let spent_on_chain: HashMap<Bytes32, bool> = [
            (id(1), true), (id(2), false), (id(3), false), (id(4), false),
            (id(6), false), (id(7), false), (id(8), false), (id(9), false),
        ]
        .into_iter()
        .collect();
        // One probe per spend whose inputs are all unspent, with its first coin;
        // the three-input spend is ONE question, not three.
        let probes = mempool_probes(&due, &spent_on_chain, 0);
        assert_eq!(probes, vec![(2, id(2)), (3, id(3)), (4, id(4)), (6, id(6))]);
        let in_mempool: HashMap<u64, Option<bool>> =
            [(2, Some(false)), (3, Some(true)), (4, None), (6, Some(false))].into_iter().collect();
        let mut released = settle(&due, &spent_on_chain, &in_mempool, true);
        released.sort();
        assert_eq!(released, vec![1, 2, 5, 6, 7]);
        // A listing cut short says nothing about the coins it left out: a spend
        // with one of them stays.
        let mut released = settle(&due, &spent_on_chain, &in_mempool, false);
        released.sort();
        assert_eq!(released, vec![1, 2, 6]);
        // The probes are bounded per pass, and the window rotates: a pass opens
        // after the last spend the previous one asked about and wraps around, so
        // with more spends waiting than one pass covers, none is starved.
        let many: Vec<DueSpend> = (20..30u64).map(|n| spend(n, &[id(n as u8)])).collect();
        let all_unspent: HashMap<Bytes32, bool> = (20..30u8).map(|n| (id(n), false)).collect();
        let ids = |probes: Vec<(u64, Bytes32)>| probes.into_iter().map(|(n, _)| n).collect::<Vec<u64>>();
        let first = ids(mempool_probes(&many, &all_unspent, 0));
        assert_eq!(first, (20..28).collect::<Vec<u64>>());
        let second = ids(mempool_probes(&many, &all_unspent, 27));
        assert_eq!(second, vec![28, 29, 20, 21, 22, 23, 24, 25]);
        assert_eq!(ids(mempool_probes(&many, &all_unspent, 29))[0], 20, "past the last: wraps to the oldest");
        // A spend that needs no probe is skipped by the rotation as well.
        let mut one_spent = all_unspent.clone();
        one_spent.insert(id(28), true);
        assert_eq!(ids(mempool_probes(&many, &one_spent, 27)), vec![29, 20, 21, 22, 23, 24, 25, 26]);
    }

    #[test]
    fn a_landing_gift_reads_as_pending_while_its_faucet_coin_is_parked() {
        let lease = WalletLease::new();
        let faucet_coin = Bytes32::new([9u8; 32]);
        let t0 = Instant::now();
        assert!(!lease.incoming_pending());
        let claim = lease.park_at([faucet_coin], t0);
        lease.mark_incoming(faucet_coin);
        // A second TAKE sees it landing, however long the claim waits…
        assert!(lease.incoming_pending());
        // …until the chain or the mempool settles the claim (confirmed: the gift
        // is in the wallet; dropped: the wallet is still empty and may ask again).
        lease.release(&[claim.spend]);
        assert!(!lease.incoming_pending());
    }

    #[test]
    fn n8_only_armed_known_private_rooms_publish() {
        let caps = vec![
            ("private-armed".to_string(), cap(1, true, Some(false))),
            ("private-off".to_string(), cap(2, false, Some(false))),
            ("public-armed".to_string(), cap(3, true, Some(true))),
            ("public-off".to_string(), cap(4, false, Some(true))),
            ("unknown-armed".to_string(), cap(5, true, None)),
            ("unknown-off".to_string(), cap(6, false, None)),
        ];
        let (armed, refused) = publishable_rooms(&caps);
        assert_eq!(armed, vec![("private-armed".to_string(), [1u8; 32])]);
        assert_eq!(
            refused,
            vec!["public-armed".to_string(), "unknown-armed".to_string()],
            "armed rooms that are public, or whose posture an old browser never sent, are named so the operator learns why nothing publishes"
        );
    }

    #[test]
    fn publish_due_on_first_change_and_cadence() {
        let key = [7u8; 32];
        let t0 = Instant::now();
        assert!(publish_due(None, &key, "a", t0), "never published -> due");
        let ok = PublishMark { room_key: key, addrs_sig: "a".into(), at: t0, ok: true };
        assert!(!publish_due(Some(&ok), &key, "a", t0 + Duration::from_secs(60)), "fresh OK publish is not due");
        assert!(publish_due(Some(&ok), &key, "a,b", t0 + Duration::from_secs(1)), "address change republishes at once");
        assert!(publish_due(Some(&ok), &[8u8; 32], "a", t0 + Duration::from_secs(1)), "room key change republishes at once");
        assert!(publish_due(Some(&ok), &key, "a", t0 + Duration::from_secs(HEARTBEAT_OK_SECS)), "heartbeat cadence");
        let failed = PublishMark { ok: false, ..PublishMark { room_key: key, addrs_sig: "a".into(), at: t0, ok: false } };
        assert!(!publish_due(Some(&failed), &key, "a", t0 + Duration::from_secs(HEARTBEAT_RETRY_SECS - 1)));
        assert!(publish_due(Some(&failed), &key, "a", t0 + Duration::from_secs(HEARTBEAT_RETRY_SECS)), "retry cadence after a failure");
    }
}
