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
use chia_traits::Streamable;
use chia_puzzle_types::standard::StandardArgs;
use chia_puzzle_types::DeriveSynthetic;
use crate::chia_chain::{ChainAccess, ChainError};
use chia_sdk_driver::{SpendContext, StandardLayer};
use chia_sdk_signer::{AggSigConstants, RequiredSignature};
use chia_sdk_types::{Conditions, TESTNET11_CONSTANTS};
use clvmr::Allocator;
use serde::{Deserialize, Serialize};

use crate::chia_contact::InboundVerified;
use crate::chia_lane::{self, AddrEntry, ChiaPresenceRecord, PresenceV2, ERA_BLOCKS, ERA_SECS, KIND_PRESENCE};
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

/// A spend pushed a moment ago may not show on the chain yet (its coins still
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
/// fails on the TRANSPORT (a timeout above all) is indeterminate — the chain
/// may hold the bundle — and a coin parked only on success would be free for
/// the next writer to select while its spend sits in the mempool. So the
/// inputs are parked first; an explicit REJECTION from the chain (it holds
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
/// however long that takes. A coin the listing does not mention at all is
/// released only when that listing is complete AND judged at a height the
/// coin was already seen confirmed at (#271 review, round 17): two peers
/// still syncing, standing below the coin's creation, know nothing of it,
/// and their silence must not free a coin whose spend may be live on the
/// chain ahead of them. So every parking records where its coins were seen
/// ([`ParkedInput`]).
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
///
/// The parking OUTLIVES the process (#245 review, round 17): every change is
/// written to `wallet_lease.json` beside the wallet seed, and the next run
/// takes it back before any writer selects a coin ([`WalletLease::restore`]).
/// A zero-fee spend can sit in the mempool across a restart while the chain
/// still lists its inputs unspent and the wallet empty; a lease that started
/// empty would let a writer reselect those inputs, or a second TAKE draw
/// another mojo while the first claim is still live. Restored spends are
/// reconciled like any other, after a fresh grace.
///
/// The file is AUTHORITATIVE, so the lease fails closed around it (#245
/// review, round 19): a lease file that exists but cannot be read SEALS the
/// lease (no spend leaves until the file is fixed or removed and the node
/// restarted, since the spends it described may still be live), and a
/// parking that cannot be written is taken back and its spend is not sent,
/// since a restart would forget it. The file is only ever over-parked, never
/// under: a release that fails to save is logged and the next change saves
/// it, and a restored coin the chain has long settled is released by the
/// first reconciliation.
pub struct WalletLease {
    gate: tokio::sync::Mutex<()>,
    pending: std::sync::Mutex<HashMap<Bytes32, Parked>>,
    /// The spend bundle each parked spend pushed, by spend number: what the
    /// liveness question hands the peers again (`ChainAccess::spend_live`),
    /// since the peer protocol has no mempool query (plan §14 (6)). Attached
    /// in the same write as the parking ([`WalletLease::park_with_bundle`]).
    bundles: std::sync::Mutex<HashMap<u64, SpendBundle>>,
    incoming: std::sync::Mutex<Option<Bytes32>>,
    /// Spend numbers handed out so far (see [`Parking`]).
    spends: std::sync::atomic::AtomicU64,
    /// The last spend a reconciliation asked the mempool about: the next pass
    /// starts its probe window after it (see [`mempool_probes`]).
    probe_cursor: std::sync::atomic::AtomicU64,
    /// Where the parking is written after every change, once
    /// [`WalletLease::restore`] named the file (none: in memory only, as in
    /// tests). Held across a snapshot and its write, so the file always holds
    /// the latest parking.
    store: std::sync::Mutex<Option<std::path::PathBuf>>,
    /// Why no spend may leave: the previous run's lease file exists but could
    /// not be read (see [`WalletLease::restore`]). Nothing parks, and nothing
    /// is written over the file.
    sealed: std::sync::Mutex<Option<String>>,
}

/// A parked coin: when, by which spend (see [`Parking`]), and the height it
/// was seen confirmed at when selected (`None`: unknown, as for a coin an
/// older node parked), which decides whether a listing that leaves it out
/// can free it ([`settle`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Parked {
    at: Instant,
    spend: u64,
    seen_at: Option<u32>,
}

/// An input a spend consumes, with the height its coin was seen confirmed at
/// as the listing that selected it reported (our wallet's coins, the faucet
/// coin a TAKE claims). A bare coin id parks with no height: such a coin is
/// never freed on a listing's silence alone (#271 review, round 17).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParkedInput {
    pub coin_id: Bytes32,
    pub seen_at: Option<u32>,
}

impl From<Bytes32> for ParkedInput {
    fn from(coin_id: Bytes32) -> Self {
        Self { coin_id, seen_at: None }
    }
}

impl From<(Bytes32, u32)> for ParkedInput {
    fn from((coin_id, seen_at): (Bytes32, u32)) -> Self {
        Self { coin_id, seen_at: Some(seen_at) }
    }
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

/// A parked spend old enough to ask the chain about, with the bundle it
/// pushed (none for a spend parked by an older node that kept no bundle: such
/// a spend is settled by the chain alone, never by the liveness question).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DueSpend {
    pub spend: u64,
    pub coins: Vec<ParkedInput>,
    pub bundle: Option<SpendBundle>,
}

/// The parking on disk (see [`WalletLease::restore`]): the parked coins with
/// their spend numbers, the spend counter, and the faucet coin a claim spent.
#[derive(serde::Serialize, serde::Deserialize, Debug, Default, PartialEq, Eq)]
struct LeaseFile {
    v: u32,
    spends: u64,
    parked: Vec<ParkedCoin>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    incoming: Option<String>,
    /// The bundles behind the parked spends (hex of their wire bytes), since
    /// S‑0 step 2; absent in files older nodes wrote.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    bundles: Vec<ParkedBundle>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
struct ParkedCoin {
    coin: String,
    spend: u64,
    /// The height the coin was seen confirmed at (since #271 review, round
    /// 17); absent in files older nodes wrote, whose coins a listing's
    /// silence then never frees.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seen_at: Option<u32>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
struct ParkedBundle {
    spend: u64,
    bundle: String,
}

/// Write `bytes` to `path` as a whole: into a temporary file beside it, then a
/// rename over the destination, which `std::fs::rename` replaces on every
/// platform (on Windows through `MOVEFILE_REPLACE_EXISTING`). Windows can still
/// refuse that rename while another process holds the destination open (a
/// sharing violation); then the file is rewritten in place rather than left
/// stale: a stale parking would silently forget live spends, a torn one is
/// unreadable and the startup log says so (#245 review, round 18).
fn write_replacing(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(path, bytes).map_err(|_| rename_err)
        }
    }
}

fn parse_coin_id(hex_id: &str) -> Option<Bytes32> {
    let bytes: [u8; 32] = hex::decode(hex_id).ok()?.try_into().ok()?;
    Some(Bytes32::new(bytes))
}

/// The process-wide lease: one wallet per node, so one lease.
pub static WALLET_LEASE: std::sync::LazyLock<WalletLease> = std::sync::LazyLock::new(WalletLease::new);

impl WalletLease {
    pub fn new() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            pending: std::sync::Mutex::new(HashMap::new()),
            bundles: std::sync::Mutex::new(HashMap::new()),
            incoming: std::sync::Mutex::new(None),
            spends: std::sync::atomic::AtomicU64::new(0),
            probe_cursor: std::sync::atomic::AtomicU64::new(0),
            store: std::sync::Mutex::new(None),
            sealed: std::sync::Mutex::new(None),
        }
    }

    /// Hold the guard across select → build → push.
    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.gate.lock().await
    }

    /// Park the coins a spend is ABOUT to consume, before its push leaves (see
    /// [`push_parked`]). The returned [`Parking`] hands exactly this parking
    /// back on an explicit rejection; a transport error keeps it. `Err` means
    /// NOTHING is parked and the spend must not leave: the lease is sealed, or
    /// the parking could not be saved and a restart would forget the spend
    /// (#245 review, round 19). Pushes park through [`Self::park_with_bundle`],
    /// which saves the bundle in the same write; the bundle-less form serves
    /// the lease tests.
    #[cfg(test)]
    pub fn park<I: Into<ParkedInput>>(&self, coin_ids: impl IntoIterator<Item = I>) -> Result<Parking, LeaseError> {
        self.park_at(coin_ids, Instant::now())
    }

    #[cfg(test)]
    pub fn park_at<I: Into<ParkedInput>>(&self, coin_ids: impl IntoIterator<Item = I>, now: Instant) -> Result<Parking, LeaseError> {
        self.park_with_bundle_at(coin_ids, None, now)
    }

    /// Park the coins a spend is about to consume AND keep its bundle, in ONE
    /// write of the lease file, so reconciliation can ask the peers whether
    /// the spend is still live ([`ChainAccess::spend_live`]) after any
    /// restart. A parking saved before its bundle would, after a crash between
    /// the two writes, hold the wallet's coins with no bundle to ask about
    /// until an outside spend settled them. `Err` means nothing is parked or
    /// kept and the spend must not leave.
    pub fn park_with_bundle<I: Into<ParkedInput>>(&self, coin_ids: impl IntoIterator<Item = I>, bundle: &SpendBundle) -> Result<Parking, LeaseError> {
        self.park_with_bundle_at(coin_ids, Some(bundle), Instant::now())
    }

    fn park_with_bundle_at<I: Into<ParkedInput>>(
        &self,
        coin_ids: impl IntoIterator<Item = I>,
        bundle: Option<&SpendBundle>,
        now: Instant,
    ) -> Result<Parking, LeaseError> {
        self.ensure_open()?;
        let spend = self.spends.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
        let inputs: Vec<ParkedInput> = coin_ids.into_iter().map(Into::into).collect();
        let coins: Vec<Bytes32> = inputs.iter().map(|input| input.coin_id).collect();
        {
            let mut pending = self.pending.lock().unwrap();
            for input in &inputs {
                pending.insert(input.coin_id, Parked { at: now, spend, seen_at: input.seen_at });
            }
        }
        if let Some(bundle) = bundle {
            self.bundles.lock().unwrap().insert(spend, bundle.clone());
        }
        if let Err(e) = self.persist() {
            // Not saved, so not sent: take the parking and its bundle back whole
            // (by the spend number, as a rejection would) and let the caller
            // refuse the spend. The number is used up, so no later spend shares it.
            self.pending.lock().unwrap().retain(|_, parked| parked.spend != spend);
            self.bundles.lock().unwrap().remove(&spend);
            return Err(LeaseError::Unsaved(e));
        }
        Ok(Parking { spend, coins })
    }

    /// `Err` while the lease is sealed (see [`WalletLease::restore`]). Every
    /// writer checks this right after taking the gate, so it refuses before it
    /// reads the chain and names the reason at once; [`WalletLease::park`]
    /// checks it again, so nothing leaves regardless.
    pub fn ensure_open(&self) -> Result<(), LeaseError> {
        match self.sealed.lock().unwrap().as_ref() {
            Some(why) => Err(LeaseError::Sealed(why.clone())),
            None => Ok(()),
        }
    }

    /// The chain REJECTED the spend outright, so it holds nothing of it and
    /// the coins are free again (compare-and-release, see [`Parking`]).
    pub fn unpark(&self, parking: &Parking) {
        self.release(&[parking.spend]);
    }

    /// A coin some pushed spend consumed, as far as the chain and the mempool
    /// have told us (see [`WalletLease::reconcile`]): skip it when selecting.
    /// Only a verdict clears it, never the clock (#245 review, round 10): a
    /// zero-fee spend can wait in the mempool for hours, so an eviction on
    /// elapsed time would free a coin whose spend is still live — the very
    /// double-spend, or second gift, the lease exists to prevent. A chain
    /// that cannot be asked keeps the coin parked, fail closed; a chain that
    /// is down can take no spend either, so nothing is lost meanwhile.
    pub fn is_pending(&self, coin_id: &Bytes32) -> bool {
        self.pending.lock().unwrap().contains_key(coin_id)
    }

    /// Record the faucet coin a claim is ABOUT to spend: the gift INTO our
    /// wallet is landing for as long as that coin stays parked. `Err` means the
    /// marker is not set (the lease is sealed, or the marker could not be
    /// saved) and the claim must not leave, like a parking that failed.
    pub fn mark_incoming(&self, faucet_coin: Bytes32) -> Result<(), LeaseError> {
        self.ensure_open()?;
        let previous = self.incoming.lock().unwrap().replace(faucet_coin);
        if let Err(e) = self.persist() {
            *self.incoming.lock().unwrap() = previous;
            return Err(LeaseError::Unsaved(e));
        }
        Ok(())
    }

    /// A spend from OUR wallet is still settling: a coin is parked other than
    /// the faucet coin a claim spent (the dish's coin, not ours; that one is
    /// [`WalletLease::incoming_pending`]). Read from the lease, never inferred
    /// from a wallet listing: a flood of outputs can cut the listing short of
    /// the parked coin, and a GIVE would then read as settled while its spend
    /// is still live in the mempool (#245 review, round 16).
    pub fn outgoing_pending(&self) -> bool {
        let incoming = *self.incoming.lock().unwrap();
        self.pending.lock().unwrap().keys().any(|id| Some(*id) != incoming)
    }

    /// A gift to our wallet is still landing: the wallet is not empty even
    /// though the chain does not list the coin yet.
    pub fn incoming_pending(&self) -> bool {
        let coin = *self.incoming.lock().unwrap();
        match coin {
            Some(id) if self.is_pending(&id) => true,
            Some(_) => {
                *self.incoming.lock().unwrap() = None;
                self.persist_or_log("the gift settled");
                false
            }
            None => false,
        }
    }

    /// The parked spends old enough to ask the chain about, each with the
    /// coins it parked (sorted), oldest spend first.
    pub fn due_at(&self, now: Instant) -> Vec<DueSpend> {
        let pending = self.pending.lock().unwrap();
        let mut by_spend: BTreeMap<u64, Vec<ParkedInput>> = BTreeMap::new();
        for (id, parked) in pending.iter() {
            if now.duration_since(parked.at) >= RECONCILE_GRACE {
                by_spend.entry(parked.spend).or_default().push(ParkedInput { coin_id: *id, seen_at: parked.seen_at });
            }
        }
        let bundles = self.bundles.lock().unwrap();
        by_spend
            .into_iter()
            .map(|(spend, mut coins)| {
                coins.sort_by_key(|c| c.coin_id);
                DueSpend { spend, coins, bundle: bundles.get(&spend).cloned() }
            })
            .collect()
    }

    /// Forget the coins the given spends parked. A coin parked AGAIN by a later
    /// spend in the meantime (a new spend of a coin the chain had let go) carries
    /// that spend's number and stays, whatever a stale verdict says. A release
    /// the file cannot take is logged: it then over-parks a settled coin until
    /// the next change saves, or a restart reconciles it away; never under.
    pub fn release(&self, spends: &[u64]) {
        self.pending.lock().unwrap().retain(|_, parked| !spends.contains(&parked.spend));
        self.bundles.lock().unwrap().retain(|spend, _| !spends.contains(spend));
        self.persist_or_log("a release");
    }

    /// Take the parking the previous run left in `path`, and keep writing the
    /// parking there from now on (#245 review, round 17). Restored spends get
    /// a FRESH grace before reconciliation asks about them (round 18): a
    /// restart can fall inside the first grace, before the peers' mempool
    /// index has the spend, and a probe then would read its inputs unspent
    /// and absent and free them while the spend is live. The chain and the
    /// mempool then settle them exactly as they would have without the
    /// restart. The spend counter continues above the restored numbers, so a
    /// new spend never shares one with a restored verdict (compare-and-release
    /// stays sound).
    ///
    /// A missing file is a first run. A file that EXISTS but cannot be read or
    /// parsed SEALS the lease (round 19): the spends it described may still be
    /// live in the mempool, so a lease that started empty would let a writer
    /// reselect their inputs, or a second TAKE draw another mojo. Nothing
    /// parks until the operator fixes or removes the file and restarts the
    /// node, and nothing is written over it meanwhile (it is left for
    /// recovery); the log at startup says so.
    pub fn restore(&self, path: &std::path::Path) {
        let read = match std::fs::read(path) {
            Ok(bytes) => match serde_json::from_slice::<LeaseFile>(&bytes) {
                Ok(file) => self
                    .load(&file, Instant::now())
                    .map(|parked| (file.spends, parked))
                    .map_err(|e| format!("{} holds a {e}", path.display())),
                Err(e) => Err(format!("{} is unreadable ({e})", path.display())),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((0, 0)),
            Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        };
        match read {
            Ok((_, 0)) => {}
            Ok((spends, parked)) => println!(
                "⛓️ wallet lease: {parked} coin(s) still parked from the last run (spends up to #{spends}); the chain and the mempool settle them"
            ),
            Err(why) => {
                eprintln!(
                    "⛓️ wallet lease: {why}. SEALED: no spend leaves this node until the file is fixed or removed and the node restarted, since the spends it recorded may still be live"
                );
                *self.sealed.lock().unwrap() = Some(why);
                return;
            }
        }
        *self.store.lock().unwrap() = Some(path.to_path_buf());
    }

    /// Merge a stored parking into the lease (see [`WalletLease::restore`]):
    /// how many coins it parked. Checked WHOLE before anything is taken, so a
    /// file that fails any check leaves the lease untouched and seals it: what
    /// it recorded is unknown, not forgotten. The checks (#245 review, round
    /// 21): the version this node writes; every coin id well formed and listed
    /// once; every spend number in `1..=spends`, so the counter the lease
    /// continues from really is above every restored number — a file whose
    /// counter had fallen behind its entries would hand a new spend a restored
    /// number, and one verdict would then release both (compare-and-release
    /// relies on the numbers being distinct).
    fn load(&self, file: &LeaseFile, now: Instant) -> Result<usize, String> {
        if file.v != 1 {
            return Err(format!("version {} this node does not read (it writes version 1)", file.v));
        }
        let mut parked = Vec::with_capacity(file.parked.len());
        let mut seen = HashSet::with_capacity(file.parked.len());
        for entry in &file.parked {
            let id = parse_coin_id(&entry.coin).ok_or_else(|| format!("malformed parked coin id {:?}", entry.coin))?;
            if entry.spend == 0 || entry.spend > file.spends {
                return Err(format!(
                    "parked coin {:?} numbered #{} outside its spend counter #{} (spends run 1..=counter)",
                    entry.coin, entry.spend, file.spends
                ));
            }
            if !seen.insert(id) {
                return Err(format!("parked coin {:?} listed twice", entry.coin));
            }
            parked.push((id, entry.spend, entry.seen_at));
        }
        let incoming = match file.incoming.as_deref() {
            Some(hex_id) => Some(parse_coin_id(hex_id).ok_or_else(|| format!("malformed incoming coin id {hex_id:?}"))?),
            None => None,
        };
        let mut bundles = Vec::with_capacity(file.bundles.len());
        for entry in &file.bundles {
            if !parked.iter().any(|(_, spend, _)| *spend == entry.spend) {
                return Err(format!("bundle for spend #{} that parks no coin", entry.spend));
            }
            let bytes = hex::decode(&entry.bundle).map_err(|e| format!("malformed bundle for spend #{}: {e}", entry.spend))?;
            let bundle = SpendBundle::from_bytes(&bytes).map_err(|e| format!("unreadable bundle for spend #{}: {e}", entry.spend))?;
            bundles.push((entry.spend, bundle));
        }
        {
            let mut pending = self.pending.lock().unwrap();
            for (id, spend, seen_at) in &parked {
                pending.entry(*id).or_insert(Parked { at: now, spend: *spend, seen_at: *seen_at });
            }
            let mut kept = self.bundles.lock().unwrap();
            for (spend, bundle) in bundles {
                kept.entry(spend).or_insert(bundle);
            }
        }
        self.spends.fetch_max(file.spends, std::sync::atomic::Ordering::Relaxed);
        if let Some(incoming) = incoming {
            *self.incoming.lock().unwrap() = Some(incoming);
        }
        Ok(parked.len())
    }

    /// Write the parking to the store, if [`WalletLease::restore`] named one:
    /// after every change, synchronously, through a temporary file and a
    /// rename, so the file on disk is always a whole snapshot. In memory only
    /// (no store named, as in tests) there is nothing to do. The changes that
    /// ADD parking treat a failed write as fatal to their spend (see
    /// [`WalletLease::park`]); the ones that remove it log it
    /// ([`WalletLease::persist_or_log`]).
    fn persist(&self) -> std::io::Result<()> {
        let store = self.store.lock().unwrap();
        let Some(path) = store.as_ref() else { return Ok(()) };
        let bytes = serde_json::to_vec_pretty(&self.snapshot()).map_err(std::io::Error::other)?;
        write_replacing(path, &bytes)
    }

    /// Save after a change that only REMOVES parking: a failed write leaves the
    /// file over-parked (a coin the chain has settled), which the next change
    /// rewrites and a restart reconciles away. Never under-parked, so it is
    /// safe to log and carry on.
    fn persist_or_log(&self, change: &str) {
        if let Err(e) = self.persist() {
            eprintln!(
                "⛓️ wallet lease: could not save the parking after {change}: {e}; the file keeps the previous parking until the next change saves"
            );
        }
    }

    fn snapshot(&self) -> LeaseFile {
        let incoming = (*self.incoming.lock().unwrap()).map(hex::encode);
        let pending = self.pending.lock().unwrap();
        let mut parked: Vec<ParkedCoin> =
            pending.iter().map(|(id, p)| ParkedCoin { coin: hex::encode(id), spend: p.spend, seen_at: p.seen_at }).collect();
        parked.sort_by(|a, b| (a.spend, &a.coin).cmp(&(b.spend, &b.coin)));
        let mut bundles: Vec<ParkedBundle> = self
            .bundles
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(spend, bundle)| bundle.to_bytes().ok().map(|bytes| ParkedBundle { spend: *spend, bundle: hex::encode(bytes) }))
            .collect();
        bundles.sort_by_key(|b| b.spend);
        LeaseFile { v: 1, spends: self.spends.load(std::sync::atomic::Ordering::Relaxed), parked, incoming, bundles }
    }

    /// Settle the parked spends against the chain and the mempool: ask the
    /// chain about every spend past the grace, then release what [`settle`]
    /// says. Lookups that fail leave their spends parked, FAIL CLOSED: a coin
    /// stays parked until the chain gives an authoritative answer, however
    /// long that takes; nothing here is decided by the clock. Callers hold the
    /// lease gate (every writer does; the dish's status read takes it for
    /// this), and `release` is compare-and-release besides, so a verdict can
    /// never remove a marker parked after it was formed.
    pub async fn reconcile(&self, client: &impl ChainAccess) {
        let due = self.due_at(Instant::now());
        if due.is_empty() {
            return;
        }
        let coins: Vec<Bytes32> = due.iter().flat_map(|d| d.coins.iter().map(|c| c.coin_id)).collect();
        // One listing for every parked coin, paged like every chain listing:
        // follow the cursor, and if it is still cut short at the cap (or
        // truncated with no cursor), the listing is INCOMPLETE and a spend with
        // a coin it left out is kept. A complete listing settles the coins it
        // leaves out only from the height it was judged at (the lowest over
        // its pages; none, once a page came undated): see [`settle`].
        let mut records = Vec::new();
        let mut cursor: Option<String> = None;
        let mut pages = 0usize;
        let mut judged_at: Option<u32> = None;
        let mut undated = false;
        let complete = loop {
            let listing = match client.coin_records_by_names(coins.clone(), true, cursor.take()).await {
                Ok(listing) => listing,
                Err(e) => {
                    eprintln!("⛓️ wallet lease: coin lookup {e}; parked coins stay parked");
                    return;
                }
            };
            pages += 1;
            records.extend(listing.records);
            match listing.judged_at {
                Some(height) => judged_at = Some(judged_at.map_or(height, |lowest| lowest.min(height))),
                None => undated = true,
            }
            let truncated = listing.truncated;
            match listing.next_cursor {
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
        // One liveness question per spend the chain still lists unspent in
        // full (see `mempool_probes`): its bundle goes to the peers again, and
        // their acks say whether it is live (in a mempool, or taken back) or
        // dead (refused everywhere, so it will never land).
        let mut in_mempool: HashMap<u64, Option<bool>> = HashMap::new();
        let after = self.probe_cursor.load(std::sync::atomic::Ordering::Relaxed);
        let probes = mempool_probes(&due, &spent_on_chain, after);
        if let Some((last, _)) = probes.last() {
            self.probe_cursor.store(*last, std::sync::atomic::Ordering::Relaxed);
        }
        for (spend, bundle) in probes {
            let live = match client.spend_live(bundle).await {
                Ok(live) => Some(live),
                Err(e) => {
                    eprintln!("⛓️ wallet lease: liveness of spend #{spend} {e}; spend stays parked");
                    None
                }
            };
            in_mempool.insert(spend, live);
        }
        let judged_at = if complete && !undated { judged_at } else { None };
        let released = settle(&due, &spent_on_chain, &in_mempool, judged_at);
        if !released.is_empty() {
            self.release(&released);
        }
    }
}

/// Push `bundle`, which consumes `inputs`, with the inputs PARKED FIRST (#245
/// review, round 9). The three outcomes of a push, and what each leaves:
///   - accepted (`Ok`): the inputs stay parked until the chain or the mempool
///     settles the spend ([`WalletLease::reconcile`]);
///   - refused by the chain source ([`ChainError::Refused`], surfaced as
///     [`PushError::Rejected`]): it holds nothing of the spend, so the inputs
///     are handed back at once;
///   - a transport error (a timeout above all, [`ChainError::Unanswered`],
///     surfaced as [`PushError::Unanswered`]): INDETERMINATE — the request may
///     have reached the chain and the spend
///     may be in the mempool while the chain still lists the inputs unspent —
///     so the inputs stay parked and reconciliation settles them (dropped: free
///     again after the grace; landed: gone with the confirmation).
/// Parking only on success, as the writers first did, left the third case
/// free for the next writer to select and double-spend. The two errors are
/// told apart so a caller answering a user can say which happened: only a
/// rejection proves that nothing was spent (#245 review, round 14).
///
/// Callers hold the lease gate. For the dish's TAKE the input is the FAUCET
/// coin, not ours: parking it keeps a second TAKE off it the same way.
pub async fn push_parked<I: Into<ParkedInput>>(
    client: &impl ChainAccess,
    bundle: SpendBundle,
    inputs: impl IntoIterator<Item = I>,
) -> Result<(), PushError> {
    push_parked_with(&WALLET_LEASE, client, bundle, inputs).await
}

/// [`push_parked`] against a given lease (the process-wide one in production;
/// tests bring their own). The parking comes FIRST and must be saved: a lease
/// that cannot park (sealed, or its file unwritable) means the spend never
/// leaves, since a restart would forget it (#245 review, round 19). Each
/// input carries the height its coin was seen confirmed at when the caller
/// has it ([`ParkedInput`]); a bare coin id parks without one.
pub async fn push_parked_with<I: Into<ParkedInput>>(
    lease: &WalletLease,
    client: &impl ChainAccess,
    bundle: SpendBundle,
    inputs: impl IntoIterator<Item = I>,
) -> Result<(), PushError> {
    let parking = lease.park_with_bundle(inputs, &bundle).map_err(PushError::NotSent)?;
    match client.push_tx(bundle).await {
        Ok(()) => Ok(()),
        Err(ChainError::Refused(why)) => {
            lease.unpark(&parking);
            Err(PushError::Rejected(why))
        }
        Err(ChainError::Unanswered(e)) => Err(PushError::Unanswered(e)),
    }
}

/// How a push through [`push_parked`] failed, and what it left behind.
#[derive(Debug)]
pub enum PushError {
    /// The chain source refused the spend (its reason inside): it holds
    /// nothing of the spend, and the inputs were handed back. Nothing was
    /// spent, so the action can be refused outright and tried again.
    Rejected(String),
    /// The chain source did not answer (a timeout, a dropped connection): the bundle
    /// may be in the mempool all the same, so the inputs stay parked until
    /// reconciliation settles the spend. NOT a refusal: a caller that reported
    /// it as one would let its user spend again, from other coins, while the
    /// first spend is still live.
    Unanswered(anyhow::Error),
    /// The spend never left: the lease would not park its inputs (see
    /// [`LeaseError`]), so nothing is parked and nothing was pushed. Like a
    /// rejection, the action can be refused outright (#245 review, round 19).
    NotSent(LeaseError),
}

impl std::fmt::Display for PushError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Rejected(reason) => write!(f, "push_tx rejected: {reason}"),
            Self::Unanswered(e) => write!(
                f,
                "push_tx unanswered: {e:#} (the coins it spends stay parked until the chain or the mempool settles them)"
            ),
            Self::NotSent(e) => write!(f, "spend not sent: {e}"),
        }
    }
}

impl std::error::Error for PushError {}

/// Why the lease would not take a parking (see [`WalletLease::park`]): either
/// way nothing is parked and the spend must not leave.
#[derive(Debug)]
pub enum LeaseError {
    /// The previous run's lease file exists but could not be read, so what it
    /// parked is unknown (see [`WalletLease::restore`]). Only the operator
    /// clears this: the file is the one record of spends that may still be
    /// live.
    Sealed(String),
    /// The parking could not be written to the lease file, so a restart would
    /// forget the spend. Nothing was parked; the spend is not sent.
    Unsaved(std::io::Error),
}

impl std::fmt::Display for LeaseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sealed(why) => write!(
                f,
                "the wallet lease is sealed ({why}); fix or remove wallet_lease.json and restart the node before it spends again"
            ),
            Self::Unsaved(e) => write!(f, "the wallet lease could not be saved ({e}), so the spend was not sent"),
        }
    }
}

impl std::error::Error for LeaseError {}

/// How many spends one reconciliation asks the peers about (one re-push
/// each); the rest wait for the next pass. Spends in flight are one per writer
/// action, so the bound is rarely reached, and it keeps a pass under the lease
/// short whatever is parked (#245 review, round 11).
pub const MAX_MEMPOOL_PROBES: usize = 8;

/// Which due spends need the peers' word on liveness, and the bundle to ask
/// with: a spend EVERY input of which the chain still lists unspent, and whose
/// bundle the lease kept. One with a spent input is settled without the
/// question (confirmed, or dead to another spend of that coin); one with an
/// input the listing left out is settled by whether the listing was complete;
/// one without a bundle (parked by an older node) waits for the chain. One
/// probe per spend, at most [`MAX_MEMPOOL_PROBES`].
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
) -> Vec<(u64, SpendBundle)> {
    let eligible: Vec<(u64, SpendBundle)> = due
        .iter()
        .filter(|d| !d.coins.is_empty() && d.coins.iter().all(|c| spent_on_chain.get(&c.coin_id) == Some(&false)))
        .filter_map(|d| d.bundle.as_ref().map(|b| (d.spend, b.clone())))
        .collect();
    let start = eligible.iter().position(|(spend, _)| *spend > after).unwrap_or(0);
    eligible[start..]
        .iter()
        .chain(eligible[..start].iter())
        .cloned()
        .take(MAX_MEMPOOL_PROBES)
        .collect()
}

/// Which parked spends to release, from what the chain and the mempool said.
/// Per spend: any input SPENT on chain → the spend confirmed (or lost that coin
/// to another spend, which kills ours), so it is released and its other coins
/// are free or gone. An input the listing does not mention → gone only if the
/// listing was COMPLETE and judged at or above the height that input was seen
/// confirmed at (`judged_at`; `None` for a listing cut short or undated): the
/// chain, read where the coin was known to stand, has no such coin, so no live
/// spend of it and nothing to double-spend. Kept when the listing was cut
/// short, which says nothing about what it left out; when it was judged
/// below that height (two peers still syncing know nothing of a coin created
/// above their view, while its spend may be live on the chain ahead of them,
/// #271 review, round 17); or when the input's height is unknown (parked by
/// an older node). Every input UNSPENT → the peers decide: the spend is dead
/// (`Some(false)`) → released; live, or not asked (`None`) → stays parked.
pub fn settle(
    due: &[DueSpend],
    spent_on_chain: &HashMap<Bytes32, bool>,
    in_mempool: &HashMap<u64, Option<bool>>,
    judged_at: Option<u32>,
) -> Vec<u64> {
    due.iter()
        .filter(|d| {
            let states: Vec<(Option<bool>, Option<u32>)> =
                d.coins.iter().map(|c| (spent_on_chain.get(&c.coin_id).copied(), c.seen_at)).collect();
            if states.iter().any(|(s, _)| *s == Some(true)) {
                return true;
            }
            if states.iter().any(|(s, _)| s.is_none()) {
                let Some(judged) = judged_at else { return false };
                return states.iter().filter(|(s, _)| s.is_none()).all(|(_, seen)| seen.is_some_and(|seen| judged >= seen));
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
/// spend is already pending for (see [`WalletLease`]), with the height it was
/// seen confirmed at, which its parking records. `None` if unfunded.
///
/// Every page of the listing is read, up to the bound every wallet listing
/// shares (`chia_faucet::MAX_FAUCET_PAGES`): the first page can hold only
/// parked coins while a free one sits on the next, and a one-page read then
/// called a funded wallet unfunded (#245 review, round 9).
pub async fn find_spendable_coin(
    client: &impl ChainAccess,
    puzzle_hash: Bytes32,
) -> Result<Option<crate::chia_faucet::FaucetCoin>> {
    let listing = crate::chia_faucet::unspent_at(client, puzzle_hash).await?;
    let mut coins: Vec<crate::chia_faucet::FaucetCoin> =
        listing.coins.into_iter().filter(|c| !WALLET_LEASE.is_pending(&c.coin.coin_id())).collect();
    if coins.is_empty() && listing.partial {
        eprintln!(
            "⛓️ wallet: no free coin in the first {} pages at {puzzle_hash}; the listing was cut short, so there may be one further on",
            crate::chia_faucet::MAX_FAUCET_PAGES
        );
    }
    // Largest first — the recreated coin keeps the most value for future republishes.
    coins.sort_by_key(|c| std::cmp::Reverse(c.coin.amount));
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
        if cap.restored {
            continue; // read-only until the browser sends a live cap (posture may be stale)
        }
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

// ── #231 P6a: the PER-NODE presence publisher ────────────────────────────────
// One record per node per era, under the node's contact key, with the chain as
// the clock: written once when a new era begins (or the node comes online in
// it) and again when the PUBLIC address set or a reachability flag changes —
// debounced, at most MAX_NODE_WRITES_PER_ERA times an era. Idle writes nothing.
// The mark of what was written persists in `publish_marks.json` and is set only
// after the push succeeded, so a restart never doubles a write; a failed push
// (an unfunded wallet, the peers down) retries on the heartbeat's retry
// cadence. Presence has PRIORITY over the room-keyed v1 publishes in the same
// tick (one spend per tick, see the heartbeat's doc comment).

pub const NODE_MARK_FILE: &str = "publish_marks.json";
/// Address-change republishes an era may carry (the once-per-era write excluded).
pub const MAX_NODE_WRITES_PER_ERA: u32 = 8;
/// An address change republishes no sooner than this after the last write.
pub const ADDR_CHANGE_DEBOUNCE_SECS: u64 = 10 * 60;
/// No publish in the last blocks of an era: a spend pushed there could confirm
/// in the next era and be filed under a hint it is not valid for. The guard
/// budgets for how old the agreed height may be
/// ([`crate::chia_resolve::PEAK_MAX_AGE_SECS`], 90 s, about five blocks at
/// 18.75 s each, plus the announcement's own age, at most
/// [`crate::chia_peer_lane::PEAK_FRESH_AGREED`] for an agreed read: eight)
/// AND for how far it may trail the chain: an agreed height is the LOWER of
/// the pair's, up to [`crate::chia_peer_lane::MAX_PEAK_LAG`] blocks behind
/// the higher peer, so a cached height a minute old could otherwise still
/// pass the guard while the chain had entered the next era, and the write be
/// signed for the era before.
pub const ERA_GUARD_BLOCKS: u32 = 8 + crate::chia_peer_lane::MAX_PEAK_LAG;
/// A write the watcher has not seen confirmed on chain after this long is
/// tried again: the peers' acceptance puts a spend in the mempool, and a
/// zero-fee spend can still be dropped from it. The wallet lease keeps a
/// retry from touching a coin whose spend is still pending, so an early retry
/// fails harmlessly as "unfunded" rather than double-spending — and
/// [`publish_node_presence`] spends no OTHER coin beside a pending one either:
/// while any spend of ours is still settling, the retry waits.
pub const PRESENCE_CONFIRM_TIMEOUT_SECS: u64 = 30 * 60;

/// What the node last wrote for its own presence.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct NodePublishMark {
    pub era: u64,
    /// Writes in `era` so far (1 = the era's first).
    pub writes: u32,
    /// [`addrs_signature`] of the published address set.
    pub addrs_sig: String,
    /// Unix seconds of the last successful push.
    pub last_at: u64,
    /// The hint written under, hex (what the operator can look up).
    pub hint: String,
    /// The watcher read this write back from the chain (or no watcher runs,
    /// in which case the peers' acceptance is all there is). Until then
    /// the write is pending and is retried after [`PRESENCE_CONFIRM_TIMEOUT_SECS`].
    #[serde(default)]
    pub confirmed: bool,
    /// The node id (signer) the record was written as. With `hint` this binds
    /// the mark to the identity that produced it: a mark left by a replaced
    /// `contact.key` or `iroh_node_id.key` satisfies nothing, since readers
    /// look under the new hint and reject the old signer.
    #[serde(default)]
    pub node_id: Option<String>,
}

impl NodePublishMark {
    /// A missing or unreadable file is "never published" (one early republish
    /// at worst: spend-to-self is idempotent in effect).
    pub fn load(path: &std::path::Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        let _ = crate::chia_contact::tighten_private(path); // 0600 like every node file
        serde_json::from_slice(&bytes).ok()
    }

    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::chia_contact::write_private(path, &bytes)
    }
}

/// D4 shape: a publishing node is findable unless told otherwise.
pub fn findable_enabled() -> bool {
    std::env::var("SSF_CHIA_FINDABLE").ok().as_deref() != Some("0")
}

/// Inside the era's last [`ERA_GUARD_BLOCKS`]: wait for the new era.
pub fn era_guard(peak: u32) -> bool {
    peak % ERA_BLOCKS >= ERA_BLOCKS - ERA_GUARD_BLOCKS
}

/// Was `mark` written as the identity we are now: under this `hint` (contact
/// key + era) and signed by this `node_id`? A same-era mark from another
/// identity is as good as none — readers look under the new hint and reject
/// the old signer — so a replaced key publishes again at once.
pub fn mark_is_ours(mark: &NodePublishMark, hint: &str, node_id: &str) -> bool {
    mark.hint == hint && mark.node_id.as_deref() == Some(node_id)
}

/// Does the watcher's latest sighting of our own record (`seen_issued_at`: the
/// signed `issued_at` of the newest record of ours read back, 0 = none yet)
/// confirm this mark? Only the EXACT write counts: the mark's `last_at` is the
/// `issued_at` it was published with, so an older record of the same era,
/// re-read inside the cursor overlap, never confirms a newer write that may
/// still be pending or dropped.
pub fn mark_confirmed_by(mark: &NodePublishMark, seen_issued_at: u64) -> bool {
    !mark.confirmed && seen_issued_at != 0 && seen_issued_at == mark.last_at
}

/// Is a presence write due? Always for a new era (or none ever), and for a mark
/// another identity left ([`mark_is_ours`]). Within an era: when the last write
/// is still unconfirmed after [`PRESENCE_CONFIRM_TIMEOUT_SECS`] (the spend may
/// have been dropped), or when the signed address set changed and the debounce
/// has passed; either way only while the era's write budget is not spent.
pub fn node_publish_due(
    mark: Option<&NodePublishMark>,
    era: u64,
    addrs_sig: &str,
    now: u64,
    hint: &str,
    node_id: &str,
) -> bool {
    match mark {
        None => true,
        Some(m) if m.era != era => true,
        Some(m) if !mark_is_ours(m, hint, node_id) => true,
        Some(m) if m.writes >= 1 + MAX_NODE_WRITES_PER_ERA => false,
        Some(m) if !m.confirmed => now.saturating_sub(m.last_at) >= PRESENCE_CONFIRM_TIMEOUT_SECS
            || (m.addrs_sig != addrs_sig && now.saturating_sub(m.last_at) >= ADDR_CHANGE_DEBOUNCE_SECS),
        Some(m) => m.addrs_sig != addrs_sig && now.saturating_sub(m.last_at) >= ADDR_CHANGE_DEBOUNCE_SECS,
    }
}

/// The address set a presence record carries: the node's live addresses
/// filtered to PUBLIC, internet-routable ones (the same judge the dialer uses,
/// so a LAN or CGNAT address never leaves the machine), in canonical order,
/// at most eight, each with the measured flags of its family.
pub fn public_addr_entries(live_addrs: &[String], inbound: &InboundVerified, peak: u32, now: u64) -> Vec<AddrEntry> {
    // Every public address first, canonical order and duplicates removed, and
    // only then the record's cap: a duplicate or the endpoint's listing order
    // never costs a slot or shifts the signature.
    let mut entries: Vec<AddrEntry> = crate::chia_public_addrs(live_addrs)
        .into_iter()
        .map(|addr| AddrEntry { addr, flags: inbound.flags_for(addr.is_ipv6(), peak, now) })
        .collect();
    chia_lane::sort_addr_entries(&mut entries);
    entries.truncate(chia_lane::MAX_V2_ADDRS);
    entries
}

/// The "did anything change" fingerprint of an address set: addresses AND flags.
pub fn addrs_signature(entries: &[AddrEntry]) -> String {
    entries.iter().map(|e| format!("{}/{}", e.addr, e.flags)).collect::<Vec<_>>().join(",")
}

/// Publish this node's presence for `era` under its contact key: encode + sign
/// (iroh key), seal (ck), then the same lease / coin / spend-to-self / push
/// path as the room-keyed publish. Returns the hint written under.
pub async fn publish_node_presence(
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    ck: &[u8; 32],
    era: u64,
    entries: &[AddrEntry],
    now: u64,
) -> Result<Bytes32> {
    let record = PresenceV2 {
        era,
        node_id: iroh_sk.public(),
        kx_pk: crate::chia_contact::kx_public(&crate::chia_contact::kx_era_secret(iroh_sk, era)),
        issued_at: now,
        expires_at: now + 2 * ERA_SECS,
        addrs: entries.to_vec(),
    };
    let plain = chia_lane::encode_presence_v2(&record, iroh_sk)?;
    let sealed = chia_lane::seal_v2(ck, KIND_PRESENCE, era, &plain)?;
    let hint = Bytes32::new(chia_lane::derive_ck_hint(ck, era));
    let ciphertext = Bytes::new(sealed);

    let _lease = WALLET_LEASE.lock().await;
    WALLET_LEASE.ensure_open()?;
    let client = crate::chia_chain::connect();
    WALLET_LEASE.reconcile(&client).await;
    // A spend of ours still settling (the previous presence write, or a room
    // publish) keeps its coin parked — and a wallet holding more coins would
    // spend ANOTHER one beside it: two records landing for one era, the era's
    // write budget paid twice. The confirmation timeout is a retry for a spend
    // the mempool DROPPED, so a pending one waits for reconciliation's verdict
    // (the heartbeat tries again on its retry cadence).
    if WALLET_LEASE.outgoing_pending() {
        return Err(anyhow!("a spend from this wallet is still settling — the presence write waits for its verdict"));
    }
    let our_ph = our_puzzle_hash(chia_sk);
    let coin = find_spendable_coin(&client, our_ph)
        .await?
        .ok_or_else(|| anyhow!("chia wallet unfunded — no unspent coin at puzzle hash {our_ph}"))?;
    let bundle = build_publish_bundle(chia_sk, coin.coin, hint, ciphertext)?;
    push_parked(&client, bundle, [(coin.coin.coin_id(), coin.confirmed_height)]).await?;
    Ok(hint)
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
    // #231 P6a: the per-node presence state. The mark is what was WRITTEN (on
    // disk, set on push success); the attempt instant paces retries after a
    // failure; the guard flag logs the end-of-era pause once.
    let mark_path = std::path::Path::new(NODE_MARK_FILE);
    let mut node_mark: Option<NodePublishMark> = NodePublishMark::load(mark_path);
    let self_id = iroh_sk.public().to_string();
    let mut node_attempt: Option<Instant> = None;
    let mut era_guard_logged = false;
    let peak_client = crate::chia_chain::connect();
    // The era clock for a signed write is the AGREED peak (§14 (5)). The
    // watcher's peak in `hub.chia_peak` is one carrier peer's word: enough to
    // time reads and the inbound marks, not to pick the era a spend is filed
    // under, since a peer lying about the height would file the record where
    // no reader looks. Read within `PEAK_MAX_AGE_SECS`, it serves the next ticks.
    let mut agreed_peak = crate::chia_resolve::ChainPeak::default();
    // Without the watcher nothing ever reads our record back, so the peers'
    // acceptance is the only confirmation there is.
    let watcher_confirms = crate::chia_watch::watch_enabled();
    // Findable: told so (D4 default) AND holding a durable contact key — a key
    // for this run only is never published under, since the record would
    // outlive it and contradict the node's one-key identity.
    let findable = findable_enabled() && hub.contact_key_durable;
    if findable_enabled() && !hub.contact_key_durable {
        println!("⛓️ ChiaHub presence: no durable contact key — per-node presence is not published this run");
    }
    // Tell the watcher to read our own key every beat for as long as we may
    // write it, rooms and peers or not: that read is what confirms a write.
    hub.presence_publishing.store(findable, std::sync::atomic::Ordering::Relaxed);
    if let Some(m) = &node_mark {
        println!(
            "⛓️ ChiaHub presence: last written in era {} (write {}, hint {}, {})",
            m.era,
            m.writes,
            &m.hint[..m.hint.len().min(16)],
            if m.confirmed { "confirmed" } else { "awaiting confirmation" }
        );
    }
    loop {
        tokio::time::sleep(Duration::from_secs(HEARTBEAT_TICK_SECS)).await;
        // Live addresses (F3 rule: hints are live data, not a boot-time snapshot).
        let addrs: Vec<String> = iroh_ep
            .addr()
            .ip_addrs()
            .filter(|sock| !sock.ip().is_unspecified())
            .map(|sock| sock.to_string())
            .collect();
        // No early exit on an empty address list here: the per-node record may
        // carry ZERO addresses (the codec allows it), and a node that lost its
        // last address must say so, or its peers keep dialing the old ones until
        // the record expires. The room publisher below still skips an empty set.

        // ── #231 P6a: the node's OWN presence first (priority over room publishes) ──
        if findable {
            // The era is the chain's clock as the agreed lane sees it: the last
            // agreed peak while it is fresh, else one agreed read now, shared
            // back so the inbound marks and the watcher's next tick have it (an
            // agreed height serves them at least as well as a carrier's; the
            // carrier's never serves here). Height and read time travel as one
            // snapshot (`ChainPeak`), so a stale height is never judged by a
            // newer time. No agreed peak, no write.
            let now_unix = crate::chia_resolve::unix_now();
            let mut peak = agreed_peak.fresh(now_unix).unwrap_or(0);
            if peak == 0 {
                peak = crate::chia_resolve::peak_height(&peak_client).await.unwrap_or(0);
                if peak > 0 {
                    agreed_peak = crate::chia_resolve::ChainPeak::new(peak, now_unix);
                    *hub.chia_peak.lock().unwrap() = agreed_peak;
                }
            }
            if peak > 0 && era_guard(peak) {
                if !era_guard_logged {
                    println!("⛓️ ChiaHub presence: the era ends within {ERA_GUARD_BLOCKS} blocks — holding this write for the new era");
                    era_guard_logged = true;
                }
            } else if peak > 0 {
                era_guard_logged = false;
                let era = chia_lane::era_of(peak);
                let hint_now = hex::encode(chia_lane::derive_ck_hint(&hub.contact_key, era));
                // The watcher read THIS write back from the chain (the record's
                // signed issued_at is the mark's push time): confirmed, nothing
                // more to retry. An older record of ours re-read inside the
                // cursor overlap names another issued_at and confirms nothing.
                if let Some(m) = node_mark.as_mut() {
                    let seen_at = hub.presence_confirmed_at.load(std::sync::atomic::Ordering::Relaxed);
                    if mark_confirmed_by(m, seen_at) {
                        m.confirmed = true;
                        if let Err(e) = m.save(mark_path) {
                            eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                        }
                        println!("⛓️ ChiaHub presence: the era {} write is confirmed on chain", m.era);
                    }
                }
                let inbound = hub.inbound_verified.lock().unwrap().clone();
                let entries = public_addr_entries(&addrs, &inbound, peak, now_unix);
                let sig = addrs_signature(&entries);
                let retry_ok = node_attempt
                    .map(|t| t.elapsed() >= Duration::from_secs(HEARTBEAT_RETRY_SECS))
                    .unwrap_or(true);
                if node_publish_due(node_mark.as_ref(), era, &sig, now_unix, &hint_now, &self_id) && retry_ok {
                    node_attempt = Some(Instant::now());
                    match publish_node_presence(&iroh_sk, &chia_sk, &hub.contact_key, era, &entries, now_unix).await {
                        Ok(hint) => {
                            let writes = match &node_mark {
                                Some(m) if m.era == era && mark_is_ours(m, &hint_now, &self_id) => m.writes + 1,
                                _ => 1,
                            };
                            let mark = NodePublishMark {
                                era,
                                writes,
                                addrs_sig: sig,
                                last_at: now_unix,
                                hint: hex::encode(hint.to_bytes()),
                                confirmed: !watcher_confirms,
                                node_id: Some(self_id.clone()),
                            };
                            if let Err(e) = mark.save(mark_path) {
                                eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                            }
                            println!(
                                "⛓️ ChiaHub presence: published for era {era} (write {writes}) · {} public addr(s) · hint {}",
                                entries.len(),
                                &mark.hint[..16]
                            );
                            node_mark = Some(mark);
                        }
                        Err(e) => eprintln!(
                            "⛓️ ChiaHub presence: publish for era {era} failed: {e:#} (retry in {} min)",
                            HEARTBEAT_RETRY_SECS / 60
                        ),
                    }
                    continue; // one spend per tick — see the doc comment
                }
            }
        }

        if addrs.is_empty() {
            continue; // nothing routable to advertise under a room key yet
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
            kx_pk: None,
            addr_flags: vec![],
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
    // A sealed lease refuses before any chain read (push_parked would refuse
    // regardless; this spares the reads and names the reason at once).
    WALLET_LEASE.ensure_open()?;
    let client = crate::chia_chain::connect();
    WALLET_LEASE.reconcile(&client).await;
    let our_ph = our_puzzle_hash(chia_sk);
    let coin = find_spendable_coin(&client, our_ph)
        .await?
        .ok_or_else(|| anyhow!("chia wallet unfunded — no unspent coin at puzzle hash {our_ph}"))?;

    // 3. Build + sign the spend-to-self, then push to the mempool with the coin
    //    parked first (push_parked: a timed-out push may still have landed).
    let bundle = build_publish_bundle(chia_sk, coin.coin, hint, ciphertext)?;
    push_parked(&client, bundle, [(coin.coin.coin_id(), coin.confirmed_height)]).await?;
    Ok(hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(key: u8, chia_mode: bool, public_room: Option<bool>) -> ChiaRoomCap {
        ChiaRoomCap { room_key: [key; 32], chia_mode, public_room, seq: 0, restored: false }
    }

    #[test]
    fn node_presence_is_written_once_per_era_then_only_on_debounced_changes() {
        let now = 1_791_700_000u64;
        assert!(node_publish_due(None, 5, "a", now, "h", "n"), "never written: due");
        let mark = NodePublishMark {
            era: 5,
            writes: 1,
            addrs_sig: "a".into(),
            last_at: now,
            hint: "h".into(),
            confirmed: true,
            node_id: Some("n".into()),
        };
        assert!(!node_publish_due(Some(&mark), 5, "a", now + 3600, "h", "n"), "same era, same addresses: idle writes nothing");
        // A mark another identity left (a replaced contact or node key) satisfies
        // nothing: its record sits under another hint, or carries a signer readers reject.
        assert!(node_publish_due(Some(&mark), 5, "a", now + 1, "other-hint", "n"), "another contact key: due at once");
        assert!(node_publish_due(Some(&mark), 5, "a", now + 1, "h", "other-node"), "another node key: due at once");
        assert!(node_publish_due(Some(&mark), 6, "a", now + 1, "h", "n"), "a new era: due at once");
        assert!(!node_publish_due(Some(&mark), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS - 1, "h", "n"), "changed, but inside the debounce");
        assert!(node_publish_due(Some(&mark), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS, "h", "n"), "changed, debounce passed");
        let spent = NodePublishMark { writes: 1 + MAX_NODE_WRITES_PER_ERA, ..mark.clone() };
        assert!(!node_publish_due(Some(&spent), 5, "b", now + 3600, "h", "n"), "the era's change budget is spent");
        assert!(node_publish_due(Some(&spent), 6, "b", now + 3600, "h", "n"), "…until the next era");
        // A write the chain never showed back is retried after the timeout —
        // and not before, so a spend still waiting in the mempool is left alone.
        let pending = NodePublishMark { confirmed: false, ..mark.clone() };
        assert!(!node_publish_due(Some(&pending), 5, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS - 1, "h", "n"), "pending, inside the window");
        assert!(node_publish_due(Some(&pending), 5, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n"), "pending too long: retry");
        assert!(node_publish_due(Some(&pending), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS, "h", "n"), "pending, but the addresses changed: the change rule still applies");
        let pending_spent = NodePublishMark { confirmed: false, writes: 1 + MAX_NODE_WRITES_PER_ERA, ..mark.clone() };
        assert!(!node_publish_due(Some(&pending_spent), 5, "a", now + 2 * PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n"), "retries spend the same era budget");
        // Confirmation names the exact write: the record carrying the mark's own
        // issued_at, not any record of ours from the same era.
        assert!(mark_confirmed_by(&pending, now), "the record published at the mark's time confirms it");
        assert!(!mark_confirmed_by(&pending, now - 1), "an older record of ours (same era) confirms nothing");
        assert!(!mark_confirmed_by(&pending, 0), "nothing read back yet");
        assert!(!mark_confirmed_by(&mark, now), "a confirmed mark needs nothing");
        let legacy: NodePublishMark = serde_json::from_str(r#"{"era":5,"writes":1,"addrs_sig":"a","last_at":1,"hint":""}"#).unwrap();
        assert!(!legacy.confirmed, "a mark file without the field reads as unconfirmed");
        assert!(!mark_is_ours(&legacy, "", "n"), "a mark without a node id is nobody's");
    }

    #[test]
    fn era_guard_holds_the_last_blocks_of_an_era() {
        assert!(!era_guard(0));
        assert!(!era_guard(ERA_BLOCKS - ERA_GUARD_BLOCKS - 1));
        assert!(era_guard(ERA_BLOCKS - ERA_GUARD_BLOCKS));
        assert!(era_guard(ERA_BLOCKS - 1));
        assert!(!era_guard(ERA_BLOCKS));
        assert!(era_guard(3 * ERA_BLOCKS - 1));
    }

    #[test]
    fn a_stale_peak_stays_inside_the_era_guard() {
        // The publisher trusts a cached peak this old at most, the agreed read
        // behind it an announcement at most PEAK_FRESH_AGREED old, and that
        // peak is the lower of an agreed pair's, up to MAX_PEAK_LAG behind the
        // higher: those seconds of blocks and that lag together still leave
        // end-of-era guard blocks to spare. Peers at ERA-9 and ERA-3 give an
        // agreed height of ERA-9, inside the guard.
        let secs_per_block = ERA_SECS / u64::from(ERA_BLOCKS);
        let age_secs = crate::chia_resolve::PEAK_MAX_AGE_SECS + crate::chia_peer_lane::PEAK_FRESH_AGREED.as_secs();
        let cache_blocks = u32::try_from(age_secs.div_ceil(secs_per_block)).unwrap();
        let lag = crate::chia_peer_lane::MAX_PEAK_LAG;
        assert!(ERA_GUARD_BLOCKS > cache_blocks + lag, "{ERA_GUARD_BLOCKS} blocks against {cache_blocks} of cache age and {lag} of lag");
        assert!(era_guard(ERA_BLOCKS - 9), "an agreed height six behind a peer at ERA-3 is held");
    }

    #[test]
    fn public_addr_entries_keep_public_sorted_flagged_and_capped() {
        let now = 1_791_700_000u64;
        let peak = 10 * ERA_BLOCKS + 5;
        let mut inbound = InboundVerified::default();
        inbound.note(false, peak, now);
        // Real global unicast addresses: the public-address judge drops the
        // documentation ranges (TEST-NET, 2001:db8::/32) along with LAN ones.
        let live: Vec<String> = vec![
            "192.168.1.5:4444".into(),
            "8.8.8.8:4444".into(),
            "[fe80::1]:4444".into(),
            "[2001:4860:4860::8888]:4445".into(),
            "8.8.8.8:4444".into(),
            "203.0.113.9:4444".into(),
        ];
        let entries = public_addr_entries(&live, &inbound, peak, now);
        assert_eq!(entries.len(), 2, "LAN, link-local, TEST-NET and the duplicate are gone");
        assert!(entries[0].addr.is_ipv6(), "IPv6 first");
        assert_eq!(entries[0].flags, 0, "IPv6 never accepted an unsolicited inbound");
        assert_eq!(entries[1].flags, chia_lane::FLAG_INBOUND_VERIFIED, "IPv4 did, this era");
        let sig_a = addrs_signature(&entries);
        let later = public_addr_entries(&live, &inbound, 11 * ERA_BLOCKS, now);
        assert_ne!(addrs_signature(&later), sig_a, "a flag going stale in the next era is an address change");
        let many: Vec<String> = (0..12).map(|i| format!("1.1.1.{i}:1")).collect();
        assert_eq!(public_addr_entries(&many, &inbound, peak, now).len(), chia_lane::MAX_V2_ADDRS);
        // Duplicates never cost a slot: nine distinct addresses listed behind
        // eight copies of the first still fill all eight slots, all distinct.
        let mut padded: Vec<String> = vec!["1.1.1.0:1".to_string(); 8];
        padded.extend((0..9).map(|i| format!("1.1.1.{i}:1")));
        let filled = public_addr_entries(&padded, &inbound, peak, now);
        assert_eq!(filled.len(), chia_lane::MAX_V2_ADDRS);
        let distinct: std::collections::HashSet<_> = filled.iter().map(|e| e.addr).collect();
        assert_eq!(distinct.len(), chia_lane::MAX_V2_ADDRS, "canonicalized before the cap");
        assert_eq!(public_addr_entries(&["10.0.0.1:1".to_string()], &inbound, peak, now), vec![]);
    }

    #[test]
    fn wallet_lease_parks_spent_coins_until_the_chain_or_mempool_settles_them() {
        let lease = WalletLease::new();
        let a = Bytes32::new([1u8; 32]);
        let b = Bytes32::new([2u8; 32]);
        let t0 = Instant::now();
        assert!(!lease.is_pending(&a));
        let parking = lease.park_at([a], t0).unwrap();
        assert!(lease.is_pending(&a));
        assert!(!lease.is_pending(&b));
        // No timer releases it, however long the spend waits in the mempool:
        // only the chain/mempool verdict does (release).
        assert!(lease.due_at(t0 + Duration::from_secs(5)).is_empty(), "inside the grace: not asked yet");
        assert_eq!(lease.due_at(t0 + RECONCILE_GRACE), vec![DueSpend { spend: parking.spend, coins: vec![a.into()], bundle: None }]);
        lease.release(&[parking.spend]);
        assert!(!lease.is_pending(&a));
        lease.park_at([b], t0).unwrap();
        assert!(lease.is_pending(&b), "no eviction on elapsed time: parked until a verdict");
    }

    #[test]
    fn a_stale_verdict_cannot_release_a_coin_parked_again_since() {
        let lease = WalletLease::new();
        let a = Bytes32::new([1u8; 32]);
        let t0 = Instant::now();
        let first = lease.park_at([a], t0).unwrap();
        // A verdict formed for the first parking…
        let verdict: Vec<u64> = lease.due_at(t0 + RECONCILE_GRACE).iter().map(|d| d.spend).collect();
        assert_eq!(verdict, vec![first.spend]);
        // …while a writer saw the coin released and spent it again.
        lease.release(&[first.spend]);
        let second = lease.park_at([a], t0 + Duration::from_secs(30)).unwrap();
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
        let parking = lease.park_at([a, b], t0).unwrap();
        assert!(lease.is_pending(&a) && lease.is_pending(&b));
        // A transport error leaves the parking alone (push_parked calls nothing):
        // both coins stay parked and come due for reconciliation after the grace,
        // as ONE spend.
        let due = lease.due_at(t0 + RECONCILE_GRACE);
        assert_eq!(due, vec![DueSpend { spend: parking.spend, coins: vec![a.into(), b.into()], bundle: None }]);
        // An explicit rejection hands exactly this parking back.
        lease.unpark(&parking);
        assert!(!lease.is_pending(&a) && !lease.is_pending(&b));
        // …but never a NEWER parking of the same coin: a later writer's spend of
        // a coin the chain rejected the first time keeps its marker.
        let first = lease.park_at([a], t0).unwrap();
        lease.unpark(&first);
        let _second = lease.park_at([a], t0 + Duration::from_secs(1)).unwrap();
        lease.unpark(&first); // stale: the first spend's rejection, arriving late
        assert!(lease.is_pending(&a));
    }

    #[tokio::test]
    async fn an_unanswered_push_is_not_a_rejection_and_keeps_its_inputs_parked() {
        // The chain never answers (the test chain says so, as unreachable peers or
        // a timeout would): the outcome is INDETERMINATE, not a refusal.
        let client = crate::chia_chain::testing::Unanswering;
        let coin = Bytes32::new([42u8; 32]);
        let bundle = SpendBundle::new(vec![], chia_bls::Signature::default());
        let outcome = tokio::time::timeout(Duration::from_secs(20), push_parked(&client, bundle, [coin]))
            .await
            .expect("the test chain answers at once");
        assert!(matches!(outcome, Err(PushError::Unanswered(_))), "{outcome:?}");
        // The coin stays parked for reconciliation to settle, and the error says
        // so: it is what a caller passes on when it cannot tell its user that
        // nothing happened (#245 review, round 14).
        assert!(WALLET_LEASE.is_pending(&coin));
        let text = outcome.unwrap_err().to_string();
        assert!(text.contains("unanswered") && text.contains("stay parked"), "{text}");
    }

    #[test]
    fn a_parking_and_its_bundle_land_in_one_write() {
        let path = std::env::temp_dir().join(format!("ssf-lease-one-write-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let lease = WalletLease::new();
        lease.restore(&path);
        let ours = Bytes32::new([5u8; 32]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        let parking = lease.park_with_bundle([ours], &bundle).unwrap();
        let file: LeaseFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file.parked.len(), 1, "the coin is parked");
        assert_eq!(file.bundles.len(), 1, "and its bundle is in the same file, from the same write");
        assert_eq!(file.bundles[0].spend, parking.spend);
        // Restored after a crash, the spend still carries the bundle to ask the peers with.
        let again = WalletLease::new();
        again.restore(&path);
        let due = again.due_at(Instant::now() + RECONCILE_GRACE + Duration::from_secs(1));
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].bundle.as_ref().map(|b| b.name()), Some(bundle.name()));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn settle_releases_confirmed_and_dropped_spends_and_keeps_the_waiting_ones() {
        let id = |n: u8| Bytes32::new([n; 32]);
        // Every coin was seen confirmed at height 90 when selected, except
        // spend 8's, parked by an older node that recorded no height.
        let spend = |n: u64, coins: &[Bytes32]| DueSpend {
            spend: n,
            coins: coins.iter().map(|c| ParkedInput { coin_id: *c, seen_at: Some(90) }).collect(),
            bundle: Some(SpendBundle::new(vec![], Signature::default())),
        };
        // 1 confirmed (its input spent); 2 dropped (unspent, gone from the
        // mempool); 3 waiting (unspent, in the mempool); 4 unknown (unspent,
        // mempool not asked); 5 never existed (not listed); 6 a three-input
        // GIVE, all unspent and dropped; 7 one input unspent, one not listed;
        // 8 not listed, its height unknown.
        let mut due = vec![
            spend(1, &[id(1)]),
            spend(2, &[id(2)]),
            spend(3, &[id(3)]),
            spend(4, &[id(4)]),
            spend(5, &[id(5)]),
            spend(6, &[id(6), id(7), id(8)]),
            spend(7, &[id(9), id(10)]),
        ];
        let mut unknown_height = spend(8, &[id(11)]);
        unknown_height.coins[0].seen_at = None;
        due.push(unknown_height);
        let spent_on_chain: HashMap<Bytes32, bool> = [
            (id(1), true), (id(2), false), (id(3), false), (id(4), false),
            (id(6), false), (id(7), false), (id(8), false), (id(9), false),
        ]
        .into_iter()
        .collect();
        // One probe per spend whose inputs are all unspent, with its bundle;
        // the three-input spend is ONE question, not three.
        let probes = mempool_probes(&due, &spent_on_chain, 0);
        assert_eq!(probes.iter().map(|(n, _)| *n).collect::<Vec<u64>>(), vec![2, 3, 4, 6]);
        // A spend whose bundle the lease never kept is not asked about.
        let mut bare = due.clone();
        bare[1].bundle = None;
        assert_eq!(mempool_probes(&bare, &spent_on_chain, 0).iter().map(|(n, _)| *n).collect::<Vec<u64>>(), vec![3, 4, 6]);
        let in_mempool: HashMap<u64, Option<bool>> =
            [(2, Some(false)), (3, Some(true)), (4, None), (6, Some(false))].into_iter().collect();
        // A complete listing judged at 100, above where the missing coins were
        // seen confirmed: they are gone (5, 7). The coin of unknown height (8)
        // is never freed on silence alone.
        let mut released = settle(&due, &spent_on_chain, &in_mempool, Some(100));
        released.sort();
        assert_eq!(released, vec![1, 2, 5, 6, 7]);
        // A listing cut short says nothing about the coins it left out: a spend
        // with one of them stays.
        let mut released = settle(&due, &spent_on_chain, &in_mempool, None);
        released.sort();
        assert_eq!(released, vec![1, 2, 6]);
        // Complete, but judged below the height the coins were seen confirmed
        // at: a pair of peers still syncing knows nothing of them, so nothing
        // missing is freed. Judged exactly there, it is.
        let mut released = settle(&due, &spent_on_chain, &in_mempool, Some(80));
        released.sort();
        assert_eq!(released, vec![1, 2, 6]);
        let mut released = settle(&due, &spent_on_chain, &in_mempool, Some(90));
        released.sort();
        assert_eq!(released, vec![1, 2, 5, 6, 7]);
        // The probes are bounded per pass, and the window rotates: a pass opens
        // after the last spend the previous one asked about and wraps around, so
        // with more spends waiting than one pass covers, none is starved.
        let many: Vec<DueSpend> = (20..30u64).map(|n| spend(n, &[id(n as u8)])).collect();
        let all_unspent: HashMap<Bytes32, bool> = (20..30u8).map(|n| (id(n), false)).collect();
        let ids = |probes: Vec<(u64, SpendBundle)>| probes.into_iter().map(|(n, _)| n).collect::<Vec<u64>>();
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
        let claim = lease.park_at([faucet_coin], t0).unwrap();
        lease.mark_incoming(faucet_coin).unwrap();
        // A second TAKE sees it landing, however long the claim waits…
        assert!(lease.incoming_pending());
        // …until the chain or the mempool settles the claim (confirmed: the gift
        // is in the wallet; dropped: the wallet is still empty and may ask again).
        lease.release(&[claim.spend]);
        assert!(!lease.incoming_pending());
    }

    #[test]
    fn the_parking_outlives_a_restart() {
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let ours = Bytes32::new([5u8; 32]);
        let faucet_coin = Bytes32::new([6u8; 32]);
        // First run: nothing on disk yet; a give and a claim park their coins.
        let first = WalletLease::new();
        first.restore(&path);
        assert!(!path.exists() && first.ensure_open().is_ok());
        let on_disk = || std::fs::read_to_string(&path).unwrap();
        let give = first.park([ours]).unwrap();
        assert!(on_disk().contains(&hex::encode(ours)));
        // Every later change replaces the file, not only the first write.
        first.park([faucet_coin]).unwrap();
        first.mark_incoming(faucet_coin).unwrap();
        let disk = on_disk();
        assert!(disk.contains(&hex::encode(faucet_coin)) && disk.contains("\"incoming\""), "{disk}");
        // Second run (a restart): the lease starts empty and takes the parking back…
        let second = WalletLease::new();
        assert!(!second.is_pending(&ours));
        second.restore(&path);
        assert!(second.is_pending(&ours) && second.is_pending(&faucet_coin));
        assert!(second.outgoing_pending() && second.incoming_pending());
        // …due for reconciliation after a FRESH grace (a restart can fall inside
        // the first one, before the peers' mempool has the spend), under
        // their old spend numbers…
        assert!(second.due_at(Instant::now()).is_empty());
        let due: Vec<u64> = second.due_at(Instant::now() + RECONCILE_GRACE).iter().map(|d| d.spend).collect();
        assert_eq!(due, vec![give.spend, give.spend + 1]);
        // …and new spends are numbered above them, so no verdict is confused.
        let later = second.park([Bytes32::new([7u8; 32])]).unwrap();
        assert!(later.spend > give.spend + 1);
        // A verdict releases a restored spend and the file follows: a third run
        // no longer sees it, while the claim still landing is still there.
        second.release(&[give.spend]);
        assert!(!on_disk().contains(&hex::encode(ours)));
        let third = WalletLease::new();
        third.restore(&path);
        assert!(!third.is_pending(&ours) && third.is_pending(&faucet_coin) && third.incoming_pending());
        // A file that exists but cannot be read SEALS the lease (round 19): the
        // spends it held may be live, so nothing parks and no spend leaves, and
        // the file is left as it is for the operator, never written over.
        let one = hex::encode([1u8; 32]);
        let broken: Vec<String> = vec![
            "not json".to_string(),
            r#"{"v":1,"spends":3,"parked":[{"coin":"zz","spend":3}]}"#.to_string(),
            // Checked whole (round 21): a version this node does not write, a
            // spend numbered beyond the counter (a new spend would share it), a
            // zero spend number, a coin listed twice.
            r#"{"v":2,"spends":1,"parked":[]}"#.to_string(),
            format!(r#"{{"v":1,"spends":0,"parked":[{{"coin":"{one}","spend":1}}]}}"#),
            format!(r#"{{"v":1,"spends":2,"parked":[{{"coin":"{one}","spend":0}}]}}"#),
            format!(r#"{{"v":1,"spends":2,"parked":[{{"coin":"{one}","spend":1}},{{"coin":"{one}","spend":2}}]}}"#),
        ];
        for text in &broken {
            let bytes = text.as_bytes();
            std::fs::write(&path, bytes).unwrap();
            let sealed = WalletLease::new();
            sealed.restore(&path);
            assert!(matches!(sealed.ensure_open(), Err(LeaseError::Sealed(_))), "{}", String::from_utf8_lossy(bytes));
            assert!(!sealed.is_pending(&faucet_coin) && !sealed.incoming_pending());
            assert!(matches!(sealed.park([ours]), Err(LeaseError::Sealed(_))));
            assert!(matches!(sealed.mark_incoming(faucet_coin), Err(LeaseError::Sealed(_))));
            assert!(!sealed.is_pending(&ours) && !sealed.incoming_pending());
            assert_eq!(std::fs::read(&path).unwrap(), bytes, "the broken file is left for recovery");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_parking_that_cannot_be_saved_is_taken_back_and_its_spend_never_leaves() {
        // The store sits in a directory that does not exist, so every write fails.
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("wallet_lease.json");
        let lease = WalletLease::new();
        lease.restore(&path); // a missing file is a first run: the store is named, nothing is sealed
        assert!(lease.ensure_open().is_ok());
        let ours = Bytes32::new([8u8; 32]);
        let faucet_coin = Bytes32::new([9u8; 32]);
        assert!(matches!(lease.park([ours]), Err(LeaseError::Unsaved(_))));
        assert!(!lease.is_pending(&ours), "a parking that was not saved is not kept either");
        assert!(matches!(lease.mark_incoming(faucet_coin), Err(LeaseError::Unsaved(_))));
        assert!(!lease.incoming_pending());
        // Through push_parked the spend is NOT SENT: the chain is never asked
        // (had it been, the test chain would have read unanswered).
        let client = crate::chia_chain::testing::Unanswering;
        let bundle = SpendBundle::new(vec![], chia_bls::Signature::default());
        let outcome = push_parked_with(&lease, &client, bundle, [ours]).await;
        assert!(matches!(outcome, Err(PushError::NotSent(LeaseError::Unsaved(_)))), "{outcome:?}");
        assert!(!lease.is_pending(&ours));
        let text = outcome.unwrap_err().to_string();
        assert!(text.contains("not sent") && text.contains("could not be saved"), "{text}");
        // Once the directory exists the next parking saves, and goes through.
        std::fs::create_dir_all(&dir).unwrap();
        let parking = lease.park([ours]).unwrap();
        assert!(lease.is_pending(&ours) && std::fs::read_to_string(&path).unwrap().contains(&hex::encode(ours)));
        lease.unpark(&parking);
        assert!(!lease.is_pending(&ours));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn our_own_spends_read_as_spending_from_the_lease_not_from_a_listing() {
        let lease = WalletLease::new();
        let ours = Bytes32::new([3u8; 32]);
        let faucet_coin = Bytes32::new([4u8; 32]);
        let t0 = Instant::now();
        assert!(!lease.outgoing_pending());
        // A claim parks the dish's coin, not ours: landing, not spending.
        let claim = lease.park_at([faucet_coin], t0).unwrap();
        lease.mark_incoming(faucet_coin).unwrap();
        assert!(lease.incoming_pending() && !lease.outgoing_pending());
        // A give parks a coin of ours: spending, whatever a wallet listing shows
        // (one cut short may never reach the parked coin).
        let give = lease.park_at([ours], t0).unwrap();
        assert!(lease.outgoing_pending());
        lease.release(&[claim.spend]);
        assert!(lease.outgoing_pending() && !lease.incoming_pending());
        lease.release(&[give.spend]);
        assert!(!lease.outgoing_pending());
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
