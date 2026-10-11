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

use std::collections::{HashMap, HashSet};
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
    pending: std::sync::Mutex<HashMap<Bytes32, Instant>>,
    incoming: std::sync::Mutex<Option<Bytes32>>,
}

/// The process-wide lease: one wallet per node, so one lease.
pub static WALLET_LEASE: std::sync::LazyLock<WalletLease> = std::sync::LazyLock::new(WalletLease::new);

impl WalletLease {
    pub fn new() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            pending: std::sync::Mutex::new(HashMap::new()),
            incoming: std::sync::Mutex::new(None),
        }
    }

    /// Hold the guard across select → build → push.
    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    /// Park `coin_ids` as of `now`: the primitive under [`WalletLease::park_at`].
    pub fn mark_spent_at(&self, coin_ids: impl IntoIterator<Item = Bytes32>, now: Instant) {
        let mut pending = self.pending.lock().unwrap();
        for id in coin_ids {
            pending.insert(id, now);
        }
    }

    /// Park the coins a spend is ABOUT to consume, before its push leaves (see
    /// [`push_parked`]). The returned [`Parking`] hands exactly this parking
    /// back on an explicit rejection; a transport error keeps it.
    pub fn park(&self, coin_ids: impl IntoIterator<Item = Bytes32>) -> Parking {
        self.park_at(coin_ids, Instant::now())
    }

    pub fn park_at(&self, coin_ids: impl IntoIterator<Item = Bytes32>, now: Instant) -> Parking {
        let ids: Vec<(Bytes32, Instant)> = coin_ids.into_iter().map(|id| (id, now)).collect();
        self.mark_spent_at(ids.iter().map(|(id, _)| *id), now);
        Parking(ids)
    }

    /// The gateway REJECTED the spend outright, so it holds nothing of it and
    /// the coins are free again. Compare-and-release like [`WalletLease::release`]:
    /// a coin a later writer parked again since keeps its newer marker.
    pub fn unpark(&self, parking: &Parking) {
        self.release(&parking.0);
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

    /// The parked coins old enough to ask the gateway about, each with the
    /// instant it was parked: a verdict releases exactly that parking (see
    /// [`WalletLease::release`]).
    pub fn due_at(&self, now: Instant) -> Vec<(Bytes32, Instant)> {
        self.pending
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, at)| now.duration_since(**at) >= RECONCILE_GRACE)
            .map(|(id, at)| (*id, *at))
            .collect()
    }

    /// Forget parked coins the chain or the mempool settled. Compare-and-
    /// release: an entry is removed only while it still carries the instant
    /// the verdict was formed for, so a coin released and parked AGAIN by a
    /// writer in the meantime (a new spend of a coin the chain had let go)
    /// keeps its fresh marker whatever a stale verdict says (#245 review,
    /// round 8).
    pub fn release(&self, settled: &[(Bytes32, Instant)]) {
        let mut pending = self.pending.lock().unwrap();
        for (id, at) in settled {
            if pending.get(id) == Some(at) {
                pending.remove(id);
            }
        }
    }

    /// Settle the parked coins against the chain and the mempool: ask the
    /// gateway about every coin past the grace, then release what [`settle`]
    /// says. Lookups that fail leave their coins parked, FAIL CLOSED: a coin
    /// stays parked until the gateway gives an authoritative answer, however
    /// long that takes; nothing here is decided by the clock. Callers hold the
    /// lease gate (every writer does; the dish's status read takes it for
    /// this), and `release` is compare-and-release besides, so a verdict can
    /// never remove a marker parked after it was formed.
    pub async fn reconcile(&self, client: &CoinsetClient) {
        let parked = self.due_at(Instant::now());
        if parked.is_empty() {
            return;
        }
        let due: Vec<Bytes32> = parked.iter().map(|(id, _)| *id).collect();
        // The listing is paged like every coinset listing: follow the cursor,
        // and if it is still cut short at the cap (or truncated with no
        // cursor), the listing is INCOMPLETE and a coin it left out is kept.
        let mut records = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0usize;
        let complete = loop {
            let resp = match client
                .get_coin_records_by_names(due.clone(), None, None, Some(true), cursor.take())
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
        // Only a coin the chain still lists unspent needs the mempool's word.
        let mut in_mempool: HashMap<Bytes32, Option<bool>> = HashMap::new();
        for id in due.iter().filter(|id| spent_on_chain.get(*id) == Some(&false)) {
            let seen = match client.get_mempool_items_by_coin_name(*id).await {
                Ok(resp) if resp.success => Some(resp.mempool_items.is_some_and(|items| !items.is_empty())),
                Ok(resp) => {
                    eprintln!("⛓️ wallet lease: mempool lookup unsuccessful ({:?}); coin stays parked", resp.error);
                    None
                }
                Err(e) => {
                    eprintln!("⛓️ wallet lease: mempool lookup failed ({e}); coin stays parked");
                    None
                }
            };
            in_mempool.insert(*id, seen);
        }
        let released = settle(&due, &spent_on_chain, &in_mempool, complete);
        if !released.is_empty() {
            let settled: Vec<(Bytes32, Instant)> =
                parked.into_iter().filter(|(id, _)| released.contains(id)).collect();
            self.release(&settled);
        }
    }
}

/// One spend's parking: the coins it consumes, each with the instant it was
/// parked, as [`WalletLease::park`] recorded them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parking(Vec<(Bytes32, Instant)>);

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

/// Which parked coins to release, from what the chain and the mempool said:
/// SPENT on chain, the spend confirmed and the coin is gone; UNSPENT and not in
/// the mempool, the spend was dropped and the coin is free again; unspent and
/// still in the mempool (or the mempool could not be asked, `None`), it stays
/// parked. A coin the listing does not mention is released only when the
/// listing was COMPLETE (then there is no such coin on chain, nothing to
/// double-spend); a listing cut short says nothing about what it left out.
pub fn settle(
    due: &[Bytes32],
    spent_on_chain: &HashMap<Bytes32, bool>,
    in_mempool: &HashMap<Bytes32, Option<bool>>,
    complete: bool,
) -> Vec<Bytes32> {
    due.iter()
        .copied()
        .filter(|id| match spent_on_chain.get(id) {
            Some(true) => true,
            Some(false) => in_mempool.get(id).copied().flatten() == Some(false),
            None => complete,
        })
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
        lease.mark_spent_at([a], t0);
        assert!(lease.is_pending(&a));
        assert!(!lease.is_pending(&b));
        // No timer releases it, however long the spend waits in the mempool:
        // only the chain/mempool verdict does (release).
        assert!(lease.due_at(t0 + Duration::from_secs(5)).is_empty(), "inside the grace: not asked yet");
        assert_eq!(lease.due_at(t0 + RECONCILE_GRACE), vec![(a, t0)]);
        lease.release(&[(a, t0)]);
        assert!(!lease.is_pending(&a));
        lease.mark_spent_at([b], t0);
        assert!(lease.is_pending(&b), "no eviction on elapsed time: parked until a verdict");
    }

    #[test]
    fn a_stale_verdict_cannot_release_a_coin_parked_again_since() {
        let lease = WalletLease::new();
        let a = Bytes32::new([1u8; 32]);
        let t0 = Instant::now();
        lease.mark_spent_at([a], t0);
        let verdict = lease.due_at(t0 + RECONCILE_GRACE); // formed for the t0 parking
        // Meanwhile a writer saw the coin released and spent it again.
        let t1 = t0 + Duration::from_secs(30);
        lease.release(&[(a, t0)]);
        lease.mark_spent_at([a], t1);
        // The stale verdict lands: the fresh marker stays.
        lease.release(&verdict);
        assert!(lease.is_pending(&a));
        // The verdict formed for the new parking does release it.
        lease.release(&lease.due_at(t1 + RECONCILE_GRACE));
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
        // both coins stay parked and come due for reconciliation after the grace.
        assert_eq!(lease.due_at(t0 + RECONCILE_GRACE).len(), 2);
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
        let (confirmed, dropped, waiting, unknown, never_existed) = (id(1), id(2), id(3), id(4), id(5));
        let due = vec![confirmed, dropped, waiting, unknown, never_existed];
        let spent_on_chain: HashMap<Bytes32, bool> =
            [(confirmed, true), (dropped, false), (waiting, false), (unknown, false)].into_iter().collect();
        let in_mempool: HashMap<Bytes32, Option<bool>> =
            [(dropped, Some(false)), (waiting, Some(true)), (unknown, None)].into_iter().collect();
        let mut released = settle(&due, &spent_on_chain, &in_mempool, true);
        released.sort();
        let mut expected = vec![confirmed, dropped, never_existed];
        expected.sort();
        assert_eq!(released, expected);
        // A listing cut short says nothing about the coins it left out: they stay.
        let mut released = settle(&due, &spent_on_chain, &in_mempool, false);
        released.sort();
        let mut expected = vec![confirmed, dropped];
        expected.sort();
        assert_eq!(released, expected);
    }

    #[test]
    fn a_landing_gift_reads_as_pending_while_its_faucet_coin_is_parked() {
        let lease = WalletLease::new();
        let faucet_coin = Bytes32::new([9u8; 32]);
        let t0 = Instant::now();
        assert!(!lease.incoming_pending());
        lease.mark_spent_at([faucet_coin], t0);
        lease.mark_incoming(faucet_coin);
        // A second TAKE sees it landing, however long the claim waits…
        assert!(lease.incoming_pending());
        // …until the chain or the mempool settles the claim (confirmed: the gift
        // is in the wallet; dropped: the wallet is still empty and may ask again).
        lease.release(&[(faucet_coin, t0)]);
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
