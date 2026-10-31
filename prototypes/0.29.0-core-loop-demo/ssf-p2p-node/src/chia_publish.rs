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
use crate::chia_knock::{KnockRequest, SentKnock};
use crate::chia_resolve::LeaseWord;
use crate::chia_lane::{self, AddrEntry, BeaconV2, ChiaPresenceRecord, KnockV2, PresenceV2, ERA_BLOCKS, ERA_SECS, KIND_KNOCK, KIND_PRESENCE};
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
    /// Why a reconciliation released each coin (#231 P6b, #272 review round
    /// 2): the knock and beacon verdicts ask ([`WalletLease::lease_word`]),
    /// since an unspent input is dead only on the word that the peers refused
    /// its spend. This run's memory only — the file carries the parking, not
    /// the verdicts — and bounded ([`MAX_RELEASES_REMEMBERED`]).
    released: std::sync::Mutex<HashMap<Bytes32, LeaseWord>>,
    /// Spends released as SPENT that the chain has not yet settled
    /// [`crate::chia_knock::SETTLED_DEPTH`] deep (#272 review round 10), by
    /// spend number: their inputs, the height the chain listed them spent at,
    /// and the bundle. A reorganization can drop the block that confirmed a
    /// spend; its inputs then read unspent again and a knock or beacon it
    /// carried returns to PENDING — with the bundle forgotten at the release,
    /// nothing could push the spend again, the writer waited on it for the
    /// rest of the era, and a writer selecting the freed coin raced the spend
    /// the mempool took back. So a spend released as spent is SETTLING: not
    /// parked (its coins are spent, the wallet's next coin is the one it
    /// created), but kept with its bundle in the lease file, its coins never
    /// selected ([`WalletLease::is_taken`]), until a listing finds its inputs
    /// spent SETTLED_DEPTH deep at the listing's own judged height — and
    /// parked AGAIN, under its own number and bundle, the moment a listing
    /// judged at or past the spent height lists an input unspent, so the
    /// liveness probe pushes the spend again ([`mempool_probes`]) and the
    /// chain or the mempool settles it anew ([`settling_step`]). Bounded
    /// ([`MAX_SETTLING`]).
    settling: std::sync::Mutex<BTreeMap<u64, Settling>>,
}

/// A spend released as spent, kept until the chain settles it (see
/// [`WalletLease`]'s `settling`).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Settling {
    coins: Vec<ParkedInput>,
    /// The height the chain listed its inputs spent at (the latest, when they
    /// differ) as of the LAST listing: a listing that names another height
    /// moves it, and the depth is measured from there (round 11).
    spent_at: u32,
    bundle: SpendBundle,
}

/// Settling spends kept at most (#272 review round 10): past it the oldest
/// is forgotten, with a log line, as a release forgot every spend before —
/// a bound on the file, reached only if the chain cannot be read for as long
/// as it takes a node to make this many spends.
pub const MAX_SETTLING: usize = 64;

/// Release verdicts remembered at most; past it the memory starts afresh (a
/// forgotten verdict reads as [`LeaseWord::Unknown`], which kills nothing).
pub const MAX_RELEASES_REMEMBERED: usize = 4096;

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
    /// The spends released as spent and not yet settled SETTLED_DEPTH deep,
    /// with their bundles (#272 review round 10); absent in older files.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    settling: Vec<SettlingSpend>,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
struct SettlingSpend {
    spend: u64,
    /// The height the chain listed the inputs spent at.
    spent_at: u32,
    coins: Vec<SettlingCoin>,
    /// Hex of the bundle's wire bytes.
    bundle: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
struct SettlingCoin {
    coin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    seen_at: Option<u32>,
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
            released: std::sync::Mutex::new(HashMap::new()),
            settling: std::sync::Mutex::new(BTreeMap::new()),
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

    /// Is `coin` parked — consumed by a spend the chain and the mempool have
    /// not settled yet?
    pub fn is_parked(&self, coin: &Bytes32) -> bool {
        self.pending.lock().unwrap().contains_key(coin)
    }

    /// The lease's word on `coin` (#231 P6b, #272 review round 2): parked,
    /// spent and still settling (kept in the file, so this word outlives a
    /// restart; round 10), released as spent or as dropped by a reconciliation
    /// of THIS run, or unknown. A coin parked again by a later spend reads as
    /// parked, whatever an older release said.
    pub fn lease_word(&self, coin: &Bytes32) -> LeaseWord {
        if self.is_parked(coin) {
            return LeaseWord::Parked;
        }
        if self.is_settling(coin) {
            return LeaseWord::Spent;
        }
        self.released.lock().unwrap().get(coin).copied().unwrap_or(LeaseWord::Unknown)
    }

    /// Is `coin` an input of a spend released as spent that the chain has not
    /// settled SETTLED_DEPTH deep yet (#272 review round 10)?
    pub fn is_settling(&self, coin: &Bytes32) -> bool {
        self.settling.lock().unwrap().values().any(|s| s.coins.iter().any(|c| c.coin_id == *coin))
    }

    /// Does the lease still hold spend number `spend` — its inputs parked (the
    /// push in flight, or in a mempool) or settling (included, not yet
    /// SETTLED_DEPTH deep)? What a knock or beacon verdict asks before reading
    /// an input listed spent with no child under the hint as the coin's going
    /// to ANOTHER spend of ours (#272 review round 12): the two lookups behind
    /// that verdict are separate requests, and a reorganization between them
    /// lists the input spent by this very spend while the hint's listing, made
    /// on the new fork, lacks its child. The lease pushes such a spend again;
    /// a write forgotten meanwhile would lose its clock and be written again
    /// beside the first. Numbers outlive a restart with the file.
    pub fn holds_spend(&self, spend: u64) -> bool {
        self.pending.lock().unwrap().values().any(|p| p.spend == spend) || self.settling.lock().unwrap().contains_key(&spend)
    }

    /// The number of the spend `coin` is parked under, if any: what a writer
    /// keeps beside its write once the push left (round 12).
    pub fn spend_of(&self, coin: &Bytes32) -> Option<u64> {
        self.pending.lock().unwrap().get(coin).map(|p| p.spend)
    }

    /// Must a writer leave `coin` alone when selecting? Parked, or settling
    /// (round 10): a coin the chain listed spent can read unspent again after
    /// a reorganization, and then the spend that consumed it is parked again
    /// and pushed again by the lease — never taken by a new write, which would
    /// race it in the mempool.
    pub fn is_taken(&self, coin: &Bytes32) -> bool {
        self.is_pending(coin) || self.is_settling(coin)
    }

    /// Remember why coins were released, for [`WalletLease::lease_word`].
    fn remember(&self, words: &[(Bytes32, LeaseWord)]) {
        let mut released = self.released.lock().unwrap();
        if released.len() + words.len() > MAX_RELEASES_REMEMBERED {
            released.clear();
        }
        for (coin, word) in words {
            released.insert(*coin, *word);
        }
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
    /// The forget path — a rejection's hand-back ([`WalletLease::unpark`]) and
    /// the lease tests; a reconciliation retires through [`WalletLease::retire`],
    /// which keeps a spend released as SPENT settling (round 10).
    pub fn release(&self, spends: &[u64]) {
        self.retire(spends, Vec::new(), &[], &[], &[], Instant::now());
    }

    /// What a reconciliation decided, in ONE write of the file (#272 review
    /// round 10): `released` spends leave the parking (compare-and-release, as
    /// [`WalletLease::release`]); those among them released as spent with a
    /// bundle, `settling`, are kept settling under their numbers; `reparked`
    /// settling spends go back into the parking under theirs, with a fresh
    /// grace, never over a NEWER marker of the same coin (a coin a later spend
    /// took meanwhile keeps that spend's marker; a re-parked spend none of
    /// whose coins is free again is forgotten, its bundle with it, so no bundle
    /// parks no coin); `reclocked` settling spends take the height the chain
    /// now lists them spent at (round 11); `done` settling spends are forgotten.
    fn retire(&self, released: &[u64], settling: Vec<(u64, Settling)>, reparked: &[u64], reclocked: &[(u64, u32)], done: &[u64], now: Instant) {
        let back: Vec<(u64, Settling)> = {
            let mut kept = self.settling.lock().unwrap();
            for spend in done {
                kept.remove(spend);
            }
            for (spend, height) in reclocked {
                if let Some(s) = kept.get_mut(spend) {
                    s.spent_at = *height;
                }
            }
            let back = reparked.iter().filter_map(|spend| kept.remove(spend).map(|s| (*spend, s))).collect();
            kept.extend(settling);
            while kept.len() > MAX_SETTLING {
                if let Some((oldest, _)) = kept.pop_first() {
                    eprintln!(
                        "⛓️ wallet lease: more than {MAX_SETTLING} spends settling; the oldest, #{oldest}, is forgotten before the chain settled it"
                    );
                }
            }
            back
        };
        {
            let mut pending = self.pending.lock().unwrap();
            pending.retain(|_, parked| !released.contains(&parked.spend));
            let mut bundles = self.bundles.lock().unwrap();
            bundles.retain(|spend, _| !released.contains(spend));
            for (spend, s) in back {
                let mut parked_any = false;
                for c in &s.coins {
                    if let std::collections::hash_map::Entry::Vacant(slot) = pending.entry(c.coin_id) {
                        slot.insert(Parked { at: now, spend, seen_at: c.seen_at });
                        parked_any = true;
                    }
                }
                if parked_any {
                    bundles.insert(spend, s.bundle);
                }
            }
        }
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
                    .map(|counts| (file.spends, counts))
                    .map_err(|e| format!("{} holds a {e}", path.display())),
                Err(e) => Err(format!("{} is unreadable ({e})", path.display())),
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((0, (0, 0))),
            Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        };
        match read {
            Ok((_, (0, 0))) => {}
            Ok((spends, (parked, settling))) => println!(
                "⛓️ wallet lease: {parked} coin(s) still parked and {settling} spend(s) still settling from the last run (spends up to #{spends}); the chain and the mempool settle them"
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
    /// how many coins it parked and how many spends it had settling (round
    /// 10: each numbered inside the counter and neither parked nor listed
    /// twice, with inputs, a spent height and a readable bundle). Checked
    /// WHOLE before anything is taken, so a
    /// file that fails any check leaves the lease untouched and seals it: what
    /// it recorded is unknown, not forgotten. The checks (#245 review, round
    /// 21): the version this node writes; every coin id well formed and listed
    /// once; every spend number in `1..=spends`, so the counter the lease
    /// continues from really is above every restored number — a file whose
    /// counter had fallen behind its entries would hand a new spend a restored
    /// number, and one verdict would then release both (compare-and-release
    /// relies on the numbers being distinct).
    fn load(&self, file: &LeaseFile, now: Instant) -> Result<(usize, usize), String> {
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
        let mut settling: Vec<(u64, Settling)> = Vec::with_capacity(file.settling.len());
        for entry in &file.settling {
            if entry.spend == 0 || entry.spend > file.spends {
                return Err(format!(
                    "settling spend #{} outside its spend counter #{} (spends run 1..=counter)",
                    entry.spend, file.spends
                ));
            }
            if parked.iter().any(|(_, spend, _)| *spend == entry.spend) || settling.iter().any(|(spend, _)| *spend == entry.spend) {
                return Err(format!("settling spend #{} listed as parked too, or twice", entry.spend));
            }
            if entry.coins.is_empty() || entry.spent_at == 0 {
                return Err(format!("settling spend #{} with no inputs or no spent height", entry.spend));
            }
            let mut coins = Vec::with_capacity(entry.coins.len());
            for c in &entry.coins {
                let coin_id = parse_coin_id(&c.coin).ok_or_else(|| format!("malformed settling coin id {:?}", c.coin))?;
                coins.push(ParkedInput { coin_id, seen_at: c.seen_at });
            }
            let bytes = hex::decode(&entry.bundle).map_err(|e| format!("malformed bundle for settling spend #{}: {e}", entry.spend))?;
            let bundle = SpendBundle::from_bytes(&bytes).map_err(|e| format!("unreadable bundle for settling spend #{}: {e}", entry.spend))?;
            settling.push((entry.spend, Settling { coins, spent_at: entry.spent_at, bundle }));
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
        let settling_count = settling.len();
        {
            let mut kept = self.settling.lock().unwrap();
            for (spend, s) in settling {
                kept.entry(spend).or_insert(s);
            }
        }
        self.spends.fetch_max(file.spends, std::sync::atomic::Ordering::Relaxed);
        if let Some(incoming) = incoming {
            *self.incoming.lock().unwrap() = Some(incoming);
        }
        Ok((parked.len(), settling_count))
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
        let settling: Vec<SettlingSpend> = self
            .settling
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(spend, s)| {
                s.bundle.to_bytes().ok().map(|bytes| SettlingSpend {
                    spend: *spend,
                    spent_at: s.spent_at,
                    coins: s.coins.iter().map(|c| SettlingCoin { coin: hex::encode(c.coin_id), seen_at: c.seen_at }).collect(),
                    bundle: hex::encode(bytes),
                })
            })
            .collect();
        LeaseFile { v: 1, spends: self.spends.load(std::sync::atomic::Ordering::Relaxed), parked, incoming, bundles, settling }
    }

    /// Settle the parked spends against the chain and the mempool: ask the
    /// chain about every spend past the grace, then release what [`settle`]
    /// says — and judge the spends still SETTLING by the same listing
    /// ([`settling_step`], round 10). Lookups that fail leave their spends
    /// parked, FAIL CLOSED: a coin stays parked until the chain gives an
    /// authoritative answer, however long that takes; nothing here is decided
    /// by the clock. Callers hold the lease gate (every writer does; the
    /// dish's status read takes it for this), and `release` is
    /// compare-and-release besides, so a verdict can never remove a marker
    /// parked after it was formed.
    pub async fn reconcile(&self, client: &impl ChainAccess) {
        self.reconcile_at(client, Instant::now()).await
    }

    /// [`WalletLease::reconcile`] at a given instant (the tests' clock).
    async fn reconcile_at(&self, client: &impl ChainAccess, now: Instant) {
        let due = self.due_at(now);
        let settling: Vec<(u64, Settling)> = self.settling.lock().unwrap().iter().map(|(spend, s)| (*spend, s.clone())).collect();
        if due.is_empty() && settling.is_empty() {
            return;
        }
        // The settling spends' inputs ride the same listing.
        let mut coins: Vec<Bytes32> = due.iter().flat_map(|d| d.coins.iter().map(|c| c.coin_id)).collect();
        coins.extend(settling.iter().flat_map(|(_, s)| s.coins.iter().map(|c| c.coin_id)));
        coins.sort();
        coins.dedup();
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
        let spent_heights: HashMap<Bytes32, u32> =
            records.iter().filter(|r| r.spent).map(|r| (r.coin.coin_id(), r.spent_block_index)).collect();
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
        // The height the listing was judged at for a coin it NAMES (its spent
        // flag stands as of it, cut short or not), and for one it leaves out
        // (which says nothing unless the listing ran to its end).
        let judged = if undated { None } else { judged_at };
        let judged_complete = if complete { judged } else { None };
        let released = settle(&due, &spent_on_chain, &in_mempool, judged_complete);
        let mut words = release_words(&due, &released, &spent_on_chain, &in_mempool);
        // Round 10: a spend released as SPENT keeps its bundle SETTLING, under
        // the height the chain spent its inputs at, until a listing finds them
        // spent SETTLED_DEPTH deep; one released on the peers' refusal, or on
        // the listing's silence, or parked by an older node without a bundle,
        // is forgotten as before.
        let now_settling: Vec<(u64, Settling)> = due
            .iter()
            .filter(|d| released.contains(&d.spend))
            .filter_map(|d| {
                let bundle = d.bundle.clone()?;
                let spent_at = d.coins.iter().filter_map(|c| spent_heights.get(&c.coin_id).copied()).max()?;
                Some((d.spend, Settling { coins: d.coins.clone(), spent_at, bundle }))
            })
            .collect();
        let mut reparked = Vec::new();
        let mut reclocked: Vec<(u64, u32)> = Vec::new();
        let mut done = Vec::new();
        for (spend, s) in &settling {
            let inputs: Vec<(Option<bool>, Option<u32>)> =
                s.coins.iter().map(|c| (spent_on_chain.get(&c.coin_id).copied(), c.seen_at)).collect();
            // Where this listing says the spend stands now (round 11): the
            // latest height it names any input spent at.
            let current = s.coins.iter().filter_map(|c| spent_heights.get(&c.coin_id).copied()).max();
            match settling_step(s.spent_at, current, &inputs, judged, judged_complete) {
                SettlingStep::Keep => {}
                SettlingStep::Repark => {
                    println!(
                        "⛓️ wallet lease: the block that spent spend #{spend}'s coins at height {} is gone (a reorganization); parked again, to be pushed again",
                        s.spent_at
                    );
                    reparked.push(*spend);
                }
                SettlingStep::Reclock(height) => {
                    println!(
                        "⛓️ wallet lease: the chain moved the block that spent spend #{spend}'s coins from height {} to {height} (a reorganization); settling from there",
                        s.spent_at
                    );
                    reclocked.push((*spend, height));
                }
                SettlingStep::Done(spent) => {
                    if spent {
                        // Final: the word SPENT outlives the settling record for
                        // this run, as a release's word does.
                        words.extend(s.coins.iter().map(|c| (c.coin_id, LeaseWord::Spent)));
                    } else {
                        println!("⛓️ wallet lease: spend #{spend}'s coins are on no chain the peers know; forgotten");
                    }
                    done.push(*spend);
                }
            }
        }
        if !released.is_empty() || !reparked.is_empty() || !reclocked.is_empty() || !done.is_empty() {
            self.remember(&words);
            self.retire(&released, now_settling, &reparked, &reclocked, &done, now);
        }
    }
}

/// What a reconciliation does with a spend released as spent and not yet
/// settled (see [`WalletLease`]'s `settling`, #272 review round 10).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SettlingStep {
    /// Nothing decided: judged again next pass.
    Keep,
    /// An input reads UNSPENT on a listing judged at or past the height it
    /// was spent at: the block that held the spend is gone. The spend is
    /// parked again under its number and bundle, so the liveness probe pushes
    /// it again and no writer selects the coin meanwhile.
    Repark,
    /// The listing names the inputs spent at another height: a reorganization
    /// moved the block that holds the spend, with no tick in between seeing
    /// the inputs unspent (round 11). The record follows, and the depth is
    /// measured from the block that holds the spend now.
    Reclock(u32),
    /// Final — `true`: every input spent [`crate::chia_knock::SETTLED_DEPTH`]
    /// deep at the listing's judged height; `false`: the inputs are on no
    /// chain the peers know, absent from a complete listing judged at or past
    /// their own confirmation, so there is nothing to settle and nothing to
    /// push again.
    Done(bool),
}

/// Judge a settling spend, recorded spent at `spent_at`, by a listing:
/// `current` is the latest height the listing names any of its inputs spent
/// at (`None`: none spent), `inputs` each input's spent flag where the listing
/// names it (`None`: absent) with the height the coin was seen confirmed at
/// when selected; `judged` the height the listing was judged at (`None`:
/// undated), `judged_complete` the same only when the listing ran to its end.
/// A listing judged below the spent height, or undated, lists the inputs
/// unspent without proving the block gone (peers behind it); one cut short
/// says nothing of the coins it left out; a coin whose height is unknown is
/// never freed on silence. The depth is measured from the block the listing
/// says holds the spend NOW, never from the first inclusion (round 11: a
/// reorganization can move the block with no tick in between seeing the
/// inputs unspent). Nothing here is decided by the clock.
pub fn settling_step(
    spent_at: u32,
    current: Option<u32>,
    inputs: &[(Option<bool>, Option<u32>)],
    judged: Option<u32>,
    judged_complete: Option<u32>,
) -> SettlingStep {
    if judged.is_some_and(|j| j >= spent_at) && inputs.iter().any(|(spent, _)| *spent == Some(false)) {
        return SettlingStep::Repark;
    }
    let height = current.unwrap_or(spent_at);
    let final_word = |spent: Option<bool>, seen: Option<u32>| match spent {
        Some(true) => judged.is_some_and(|j| crate::chia_knock::settled(height, j)),
        Some(false) => false,
        None => judged_complete.is_some_and(|j| seen.is_some_and(|seen| j >= seen)),
    };
    if !inputs.is_empty() && inputs.iter().all(|(spent, seen)| final_word(*spent, *seen)) {
        return SettlingStep::Done(inputs.iter().all(|(spent, _)| *spent == Some(true)));
    }
    match current {
        Some(moved) if moved != spent_at => SettlingStep::Reclock(moved),
        _ => SettlingStep::Keep,
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

/// Why each coin of the spends [`settle`] released goes: SPENT when the chain
/// listed an input of its spend spent, DROPPED when every input was unspent and
/// the peers refused the bundle. A spend released on the listing's silence
/// alone (its coins absent at a height they were known at) gets no word — such
/// a coin reads as unknown, which kills nothing (#231 P6b, #272 review round 2).
pub fn release_words(
    due: &[DueSpend],
    released: &[u64],
    spent_on_chain: &HashMap<Bytes32, bool>,
    in_mempool: &HashMap<u64, Option<bool>>,
) -> Vec<(Bytes32, LeaseWord)> {
    let mut out = Vec::new();
    for d in due.iter().filter(|d| released.contains(&d.spend)) {
        let word = if d.coins.iter().any(|c| spent_on_chain.get(&c.coin_id) == Some(&true)) {
            LeaseWord::Spent
        } else if in_mempool.get(&d.spend).copied().flatten() == Some(false) {
            LeaseWord::Dropped
        } else {
            continue;
        };
        out.extend(d.coins.iter().map(|c| (c.coin_id, word)));
    }
    out
}

impl Default for WalletLease {
    fn default() -> Self {
        Self::new()
    }
}

/// Find our largest UNSPENT coin — the one to spend-to-self — skipping coins a
/// spend is already pending for, or settling ([`WalletLease::is_taken`]: a
/// coin the chain listed spent can read unspent again after a reorganization,
/// and the lease then parks and pushes its spend again rather than a writer
/// taking it), with the height it was seen confirmed at, which its parking
/// records. `None` if unfunded.
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
        listing.coins.into_iter().filter(|c| !WALLET_LEASE.is_taken(&c.coin.coin_id())).collect();
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
    /// 📖 The watcher read this exact write back from the chain. `confirmed`
    /// also ends the retries when no watcher runs (the peers' acceptance is
    /// all there is then); this flag is set by a chain read alone, and it is
    /// what the Phone Book's solid green stands for. A mark an older build
    /// saved reads as not yet seen until the watcher's next read of our key.
    #[serde(default)]
    pub chain_seen: bool,
    /// The input coin the presence spend consumed, hex: the record's own coin
    /// names it as parent, which is how the write is found again under the
    /// hint ([`crate::chia_resolve::child_under_hint`]). Empty in a mark an
    /// older node wrote: nothing to judge, the watcher's read alone confirms.
    #[serde(default)]
    pub coin_id: String,
    /// The height the record's coin was read back at, 0 while pending: a
    /// listing judged at or past it that lacks the coin says the block that
    /// held it is gone; one judged below it says nothing.
    #[serde(default)]
    pub confirmed_height: u32,
    /// A lookup on the agreed lane found the coin unmoved
    /// [`crate::chia_knock::SETTLED_DEPTH`] blocks deep: final, judged no more.
    /// Until then a seen mark is judged again each tick, as a beacon is (#272
    /// round 9): a shallow reorganization can drop the block that confirmed
    /// it, and the Phone Book's solid green would stand on a listing no longer
    /// on chain for the rest of the era.
    #[serde(default)]
    pub settled: bool,
    /// The wallet lease's number for the spend: while the lease holds it, an
    /// input listed spent with no coin under the hint is a fork between the
    /// two lookups, not another write of ours
    /// ([`crate::chia_resolve::write_standing`]). `None` in an older mark.
    #[serde(default)]
    pub spend: Option<u64>,
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

    /// Is this mark still to be judged by the chain's word: of this era, as
    /// this node id, not yet settled, and naming the coin to look up?
    pub fn unsettled_for(&self, era: u64, node_id: &str) -> bool {
        self.era == era && self.node_id.as_deref() == Some(node_id) && !self.settled && !self.coin_id.is_empty()
    }

    /// The mark after its write is void (the mempool dropped the spend, or it
    /// confirmed outside its era): nothing on chain, so pending from no time
    /// at all, which makes the next write due at once — but the era, its
    /// write count and the address signature stay, so the era's budget holds
    /// and a changed address set is still told from an unchanged one.
    pub fn voided(&self) -> Self {
        NodePublishMark {
            last_at: 0,
            confirmed: false,
            chain_seen: false,
            coin_id: String::new(),
            confirmed_height: 0,
            settled: false,
            spend: None,
            ..self.clone()
        }
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
/// still be pending or dropped. A mark the chain already showed back needs
/// nothing; one only the peers accepted (no watcher ran when it was written)
/// is still confirmed the first time the chain shows it.
pub fn mark_confirmed_by(mark: &NodePublishMark, seen_issued_at: u64) -> bool {
    !mark.chain_seen && seen_issued_at != 0 && seen_issued_at == mark.last_at
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

/// 📖 What the top bar's phone book shows: the listing on record (`mark`,
/// `ours` per [`mark_is_ours`]) judged against the agreed era (`None` while no
/// peak is agreed) and the live address signature. No listing of ours is
/// *unlisted*; one that names this era and these addresses is *listed* once the
/// watcher read it back from the chain (`chain_seen`), *sent* until then, the
/// peers' acceptance alone included (a node with the watcher off never gets
/// past *sent*); anything else of ours (an older era, other addresses, no era
/// to judge by) is *outdated*: the node once stood in the book, and the
/// publisher is on its way to the new listing.
pub fn presence_state(
    mark: Option<&NodePublishMark>,
    ours: bool,
    era: Option<u64>,
    addrs_sig: &str,
) -> crate::ChiaPresenceState {
    use crate::ChiaPresenceState::*;
    match (mark, era) {
        (None, _) => Unlisted,
        (Some(_), _) if !ours => Unlisted,
        (Some(_), None) => Outdated,
        (Some(m), Some(era)) if m.era == era && m.addrs_sig == addrs_sig => {
            if m.chain_seen {
                Listed
            } else {
                Sent
            }
        }
        (Some(_), Some(_)) => Outdated,
    }
}

/// 📖 The whole readout the fingerprint carries ([`crate::ChiaPresence`]):
/// [`presence_state`] with the figures the browser's tooltip names. A listing
/// is ours by its signer, and, when it names the agreed era, by this era's
/// `hint` too ([`mark_is_ours`]): the hint is era-bound, so last era's listing
/// can only be judged by who signed it, and it is exactly the stale listing
/// the grey book stands for. `error` is the last failed attempt's text, or why
/// nothing can be written right now.
pub fn presence_status(
    mark: Option<&NodePublishMark>,
    hint: Option<&str>,
    node_id: &str,
    era: Option<u64>,
    addrs_sig: &str,
    public_addrs: usize,
    error: Option<&str>,
) -> crate::ChiaPresence {
    let ours = mark.is_some_and(|m| match (hint, era) {
        (Some(h), Some(e)) if m.era == e => mark_is_ours(m, h, node_id),
        _ => m.node_id.as_deref() == Some(node_id),
    });
    let state = presence_state(mark, ours, era, addrs_sig);
    let on_record = mark.filter(|_| ours);
    crate::ChiaPresence {
        state,
        era: era.unwrap_or(0),
        listed_era: on_record.map_or(0, |m| m.era),
        last_at: on_record.map_or(0, |m| m.last_at),
        confirmed: on_record.is_some_and(|m| m.chain_seen),
        current: matches!(state, crate::ChiaPresenceState::Listed | crate::ChiaPresenceState::Sent),
        public_addrs: u32::try_from(public_addrs).unwrap_or(u32::MAX),
        error: error.map(str::to_owned),
    }
}

/// Publish this node's presence for `era` under its contact key: encode + sign
/// (iroh key), seal (ck), then the same lease / coin / spend-to-self / push
/// path as the room-keyed publish. Returns the hint written under and what
/// the write left behind ([`MemoWrite`]): an unanswered push is a write all
/// the same — its input is parked and the bundle may be in a mempool — so the
/// caller files it as pending and lets the chain's word settle it
/// ([`presence_step`]), as the knock and beacon writers do.
pub async fn publish_node_presence(
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    ck: &[u8; 32],
    era: u64,
    entries: &[AddrEntry],
    now: u64,
) -> Result<(Bytes32, MemoWrite)> {
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
    let write = publish_memo(chia_sk, hint, sealed, "presence").await?;
    Ok((hint, write))
}

/// What an era-bound write left behind: the INPUT coin its spend consumed and
/// whether the peers acknowledged the push. An unanswered push (`acked`
/// false) is a write all the same — its input is parked and the bundle may be
/// in a mempool — so the knock, beacon and presence writers file it as
/// pending, like an acknowledged one, and let the chain settle it (#272
/// review; the presence writer since the Phone Book icon's follow-up, which
/// gave its mark the coin to judge).
pub struct MemoWrite {
    pub coin: Bytes32,
    pub acked: bool,
    /// The lease's number for the spend (#272 review round 12), kept beside
    /// the write so its verdicts can ask whether the lease still holds it
    /// ([`WalletLease::holds_spend`]). `None` only if the input was not parked
    /// once the push returned, which the lease does not allow.
    pub spend: Option<u64>,
}

/// The shared tail of every era-bound write (presence, knock, beacon): under
/// the lease, reconcile, refuse while a spend of ours is still settling, pick
/// the payer's largest free coin, spend it to itself carrying `[hint, body]`,
/// push with the input parked. Returns what the write left behind
/// ([`MemoWrite`]): the INPUT coin's id — the write's own coin names it as
/// parent, which is how the write is found again under its hint and judged
/// ([`crate::chia_resolve::write_standing`]) — and whether the push was
/// acknowledged.
///
/// Refusing while a spend settles (#231 P6a): a wallet holding more coins
/// would spend ANOTHER one beside the pending write — two records landing for
/// one era, the era's write budget paid twice. The confirmation timeout is a
/// retry for a spend the mempool DROPPED, so a pending one waits for
/// reconciliation's verdict (the heartbeat tries again on its retry cadence).
async fn publish_memo(payer: &SecretKey, hint: Bytes32, body: Vec<u8>, what: &str) -> Result<MemoWrite> {
    publish_memo_with(payer, hint, None, move |_| Ok(body), what).await
}

/// [`publish_memo`] whose body is built once the INPUT coin is chosen: `body`
/// gets the input's id — the parent of the coin the memo will ride on — so a
/// knock can bind its sealing to it ([`chia_lane::seal_to_kx`], #272 review
/// round 3). With a `gate`, `body` runs and the spend is pushed UNDER it: a
/// knock's authorization is read again there, after the lease and coin
/// lookups, so a room's word that changed while the spend was prepared is seen
/// (`body` answers [`Withdrawn`]) and no cap can land between that check and
/// the push — the card gate's own contract (#272 review round 5).
async fn publish_memo_with(
    payer: &SecretKey,
    hint: Bytes32,
    gate: Option<&tokio::sync::Mutex<()>>,
    body: impl FnOnce(Bytes32) -> Result<Vec<u8>>,
    what: &str,
) -> Result<MemoWrite> {
    let _lease = WALLET_LEASE.lock().await;
    WALLET_LEASE.ensure_open()?;
    let client = crate::chia_chain::connect();
    WALLET_LEASE.reconcile(&client).await;
    if WALLET_LEASE.outgoing_pending() {
        return Err(anyhow!("a spend from this wallet is still settling — the {what} write waits for its verdict"));
    }
    let our_ph = our_puzzle_hash(payer);
    let coin = find_spendable_coin(&client, our_ph)
        .await?
        .ok_or_else(|| anyhow!("chia wallet unfunded — no unspent coin at puzzle hash {our_ph}"))?;
    let input = coin.coin.coin_id();
    let _gate = match gate {
        Some(gate) => Some(gate.lock().await),
        None => None,
    };
    let body = body(input)?;
    let bundle = build_publish_bundle(payer, coin.coin, hint, Bytes::new(body))?;
    match push_parked(&client, bundle, [(input, coin.confirmed_height)]).await {
        Ok(()) => Ok(MemoWrite { coin: input, acked: true, spend: WALLET_LEASE.spend_of(&input) }),
        // Indeterminate, not failed: the bundle may be in a mempool and the
        // input is parked. Reported as a write, so the caller files it as
        // pending and lets the chain's word settle it — filed as a failure it
        // would be written AGAIN beside the first once the lease frees the
        // coin (#272 review).
        Err(PushError::Unanswered(e)) => {
            eprintln!("⛓️ ChiaHub {what}: the push went unanswered ({e:#}) — filed as pending; the chain's word settles it");
            Ok(MemoWrite { coin: input, acked: false, spend: WALLET_LEASE.spend_of(&input) })
        }
        Err(e) => Err(e.into()),
    }
}

// ── #231 P6b: knocks and beacons ─────────────────────────────────────────────

/// D7: the beacon role is opt-in (`SSF_CHIA_BEACON=1`): a public entry point
/// that keeps the welcome room served and lets a newcomer with nobody to dial
/// find it. Off by default, since the beacon hint is derivable by anyone and a
/// roster of every active node id would be a public weekly directory.
pub fn beacon_enabled() -> bool {
    std::env::var("SSF_CHIA_BEACON").ok().as_deref() == Some("1")
}

/// #231 P6b/D7: a beacon is an entry point to the WELCOME room and nothing
/// else (#272 review round 3): a newcomer dialing it joins that room through
/// it, and a room this node does not serve has no doc to answer a sync with
/// and nobody to relay to. So the beacon is written only while this node
/// SERVES the welcome room — a local browser bound it, or it came back served
/// from disk — known here by the bundled key its cap carries.
pub fn serves_welcome_room(hub: &crate::SharedHub) -> bool {
    let welcome: Vec<String> = hub
        .chia_rooms
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, cap)| crate::chia_rooms::is_bundled_room_key(&cap.room_key))
        .map(|(room, _)| room.clone())
        .collect();
    let rooms = hub.rooms.lock().unwrap();
    welcome.iter().any(|room| rooms.get(room).is_some_and(|r| r.served))
}

const CTX_BEACON_WALLET: &str = "ssf-chia-beacon-wallet-v1";
/// Where the beacon's last write is remembered, 0600 like every node file.
pub const BEACON_MARK_FILE: &str = "beacon_mark.json";
/// Retries of a knock that failed to leave (an unfunded wallet, a spend still
/// settling) before the request is dropped; the next dial exhaustion queues
/// it again.
pub const MAX_KNOCK_ATTEMPTS: u8 = 3;

/// The beacon's own wallet key, derived from the main key so no second seed
/// file is minted, funded SEPARATELY (its address is printed at startup): a
/// clear-text node id must never share coin lineage with the sealed records.
pub fn beacon_wallet_key(chia_sk: &SecretKey) -> SecretKey {
    SecretKey::from_seed(&blake3::derive_key(CTX_BEACON_WALLET, &chia_sk.to_bytes()))
}

/// What the beacon last wrote.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct BeaconMark {
    pub era: u64,
    pub last_at: u64,
    pub hint: String,
    #[serde(default)]
    pub node_id: Option<String>,
    /// The input coin the beacon spend consumed, hex: the beacon's own coin
    /// names it as parent, which is how the write is found again under the
    /// hint ([`crate::chia_resolve::child_under_hint`]).
    #[serde(default)]
    pub coin_id: String,
    /// The beacon's own coin was read back under the era's hint. Until then
    /// the write is PENDING (#272 review): the peers' acceptance puts a spend
    /// in a mempool, and a zero-fee spend can still be dropped from it. A
    /// pending mark is settled by the chain's word — confirmed, or dead and
    /// then written again — never by the clock, and never written over.
    #[serde(default)]
    pub confirmed: bool,
    /// The height the beacon's own coin was read back at, 0 while pending
    /// (#272 review round 9): a listing judged at or past it that lacks the
    /// coin says the block that held it is gone; one judged below it says
    /// nothing. 0 too in a mark written before the height was kept: judged
    /// again from the start.
    #[serde(default)]
    pub confirmed_height: u32,
    /// A lookup on the agreed lane found the beacon's coin unmoved
    /// [`crate::chia_knock::SETTLED_DEPTH`] blocks deep: final, judged no more
    /// (round 9). Until then a confirmed mark is judged again each tick, as a
    /// knock is: a shallow reorganization can drop the block that confirmed
    /// it, and a mark final at its first inclusion would leave the node
    /// without a beacon for the rest of the era, restart or not.
    #[serde(default)]
    pub settled: bool,
    /// The wallet lease's number for the beacon's spend (#272 review round
    /// 12): while the lease holds it, an input listed spent with no coin under
    /// the hint is a fork between the two lookups, not another write of ours
    /// ([`crate::chia_resolve::write_standing`]). `None` in a mark an older
    /// node wrote.
    #[serde(default)]
    pub spend: Option<u64>,
}

impl BeaconMark {
    pub fn load(path: &std::path::Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        let _ = crate::chia_contact::tighten_private(path);
        serde_json::from_slice(&bytes).ok()
    }

    pub fn save(&self, path: &std::path::Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::chia_contact::write_private(path, &bytes)
    }

    /// Judged this tick (#272 review round 9): a mark of this era, as this
    /// identity, naming a coin, that no lookup has settled yet — pending, or
    /// confirmed and not yet found [`crate::chia_knock::SETTLED_DEPTH`] deep.
    pub fn unsettled_for(&self, era: u64, node_id: &str) -> bool {
        self.era == era && self.node_id.as_deref() == Some(node_id) && !self.settled && !self.coin_id.is_empty()
    }
}

/// Once per era, as this node id: a new era, no mark, or a mark another
/// identity left. A mark of this era and identity holds whether confirmed or
/// still pending — it is judged by [`beacon_step`] on the chain's word, and
/// the heartbeat clears it (so the beacon is due again) only on the word that
/// the write is dead, or confirmed outside its era.
pub fn beacon_due(mark: Option<&BeaconMark>, era: u64, node_id: &str) -> bool {
    match mark {
        None => true,
        Some(m) => m.era != era || m.node_id.as_deref() != Some(node_id),
    }
}

/// #231 P6b: the standing of a pending beacon mark — the lease's word on its
/// input FIRST (#272 review round 2: a beacon confirming after the chain was
/// read but before the lease reconciled read as dropped), then its own coin
/// under the era's hint and its input's spent flag
/// ([`crate::chia_resolve::write_standing`]), with whether a listing run to its
/// end and judged at or past the mark's confirmation lacked the coin
/// ([`crate::chia_resolve::HintChild::gone_since`], round 9: the block that
/// confirmed it is gone). `None` when the chain could not be asked this tick,
/// or the mark names no coin (nothing to judge). The lease is asked in the
/// same breath whether it still holds the mark's spend (round 12), so an
/// input listed spent with no coin under the hint by a fork between the two
/// lookups reads pending, not dead.
pub async fn beacon_standing(client: &impl ChainAccess, mark: &BeaconMark) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    write_standing_of(client, &mark.coin_id, &mark.hint, mark.spend, mark.confirmed_height, "beacon").await
}

/// 📖 The chain's word on this node's presence write ([`beacon_standing`] for
/// the listing the Phone Book's icon stands on): its standing, and whether a
/// listing judged past the height it was confirmed at lacks its coin.
pub async fn presence_standing(client: &impl ChainAccess, mark: &NodePublishMark) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    write_standing_of(client, &mark.coin_id, &mark.hint, mark.spend, mark.confirmed_height, "presence").await
}

/// The shared lookup behind [`beacon_standing`] and [`presence_standing`]: the
/// lease's word on the input `coin_id` and whether it still holds `spend`,
/// then the coin under `hint` and the input's spent height, judged together
/// by [`crate::chia_resolve::write_standing`]; `None` when the chain could
/// not be asked, or the mark names no coin or hint (nothing to judge).
async fn write_standing_of(
    client: &impl ChainAccess,
    coin_id: &str,
    hint: &str,
    spend: Option<u64>,
    confirmed_height: u32,
    what: &str,
) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    let coin = crate::chia_resolve::parse_hex32(coin_id)?;
    let hint = crate::chia_resolve::parse_hex32(hint)?;
    let spends: Vec<u64> = spend.into_iter().collect();
    let (words, held) = lease_standing(client, &[coin], &spends).await;
    let lease = words.get(&coin).copied().unwrap_or(LeaseWord::Unknown);
    let ours = spend.is_some_and(|s| held.contains(&s));
    let child = match crate::chia_resolve::child_under_hint(client, hint, coin).await {
        Ok(child) => child,
        Err(e) => {
            eprintln!("⛓️ ChiaHub {what}: could not read under the {what} hint: {e:#}");
            return None;
        }
    };
    let spent_at = match crate::chia_resolve::spent_heights(client, vec![coin]).await {
        Ok(spent) => spent.into_iter().find(|(c, _)| *c == coin).map(|(_, h)| h),
        Err(e) => {
            eprintln!("⛓️ ChiaHub {what}: could not read the {what}'s input: {e:#}");
            return None;
        }
    };
    Some((crate::chia_resolve::write_standing(&child, spent_at, lease, ours), child.gone_since(confirmed_height)))
}

/// 📖 What the heartbeat does with a judged presence mark ([`presence_step`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PresenceStep {
    /// Nothing new: judged again next tick.
    Keep,
    /// The mark changed — confirmed, moved, settled, or pending again: save it.
    Save(NodePublishMark),
    /// The write is void, for the reason given: the mark keeps its era, write
    /// count and addresses but forgets the write ([`NodePublishMark::voided`]),
    /// which makes the listing due again at once.
    Void(String),
}

/// 📖 Judge a presence mark by the chain's word (`word`: [`presence_standing`]'s,
/// `None` when the chain could not be asked) against `era`, the current one,
/// and `peak`, the agreed peak — [`beacon_step`]'s rules for the listing the
/// Phone Book's icon stands on. A confirmed write is `chain_seen` (solid
/// green) and judged again until a lookup finds its coin
/// [`crate::chia_knock::SETTLED_DEPTH`] deep, at the agreed peak and at the
/// lookup's own judged height alike ([`crate::chia_knock::settled_by`]); the
/// chain moving its block moves the mark; a listing judged at or past its
/// block that lacks the coin returns it to pending — the green goes, the spend
/// may land again, and the clock's retry ([`node_publish_due`]) asks the lease,
/// which refuses while it still holds the spend; a listing judged below the
/// block, or undated, decides nothing. Dead on the lease's word, or confirmed
/// outside its era, the write is void and the listing due again, the era's
/// write budget kept. Nothing here is decided by the clock.
pub fn presence_step(
    mark: &NodePublishMark,
    word: Option<(crate::chia_resolve::WriteStanding, bool)>,
    era: u64,
    peak: u32,
) -> PresenceStep {
    use crate::chia_resolve::WriteStanding;
    match word {
        None => PresenceStep::Keep,
        Some((WriteStanding::Confirmed { height, .. }, _)) if chia_lane::era_of(height) != era => {
            PresenceStep::Void(format!("confirmed at height {height}, outside its era — readers will not take it"))
        }
        Some((WriteStanding::Confirmed { height, .. }, _)) if !mark.chain_seen || mark.confirmed_height != height => {
            PresenceStep::Save(NodePublishMark { confirmed: true, chain_seen: true, confirmed_height: height, settled: false, ..mark.clone() })
        }
        Some((WriteStanding::Confirmed { height, seen_at }, _)) if crate::chia_knock::settled_by(height, peak, seen_at) => {
            PresenceStep::Save(NodePublishMark { settled: true, ..mark.clone() })
        }
        Some((WriteStanding::Confirmed { .. }, _)) => PresenceStep::Keep,
        Some((WriteStanding::Dead(why), _)) => PresenceStep::Void(format!("never landed — {why}")),
        Some((WriteStanding::Pending, true)) if mark.chain_seen => {
            PresenceStep::Save(NodePublishMark { confirmed: false, chain_seen: false, confirmed_height: 0, settled: false, ..mark.clone() })
        }
        Some((WriteStanding::Pending, _)) => PresenceStep::Keep,
    }
}

/// What the heartbeat does with a judged beacon mark (#272 review round 9).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BeaconStep {
    /// Nothing new: judged again next tick.
    Keep,
    /// The mark changed — confirmed, moved, settled, or pending again: save it.
    Save(BeaconMark),
    /// The write is void, for the reason given: forget the mark, the beacon is
    /// due again.
    Forget(String),
}

/// Judge a beacon mark by the chain's word (`word`: [`beacon_standing`]'s,
/// `None` when the chain could not be asked) against `era`, the current one,
/// and `peak`, the agreed peak. A confirmed mark is judged again until a
/// lookup finds its coin unmoved [`crate::chia_knock::SETTLED_DEPTH`] deep —
/// at the agreed peak and at the lookup's own judged height alike, an undated
/// lookup settling nothing ([`crate::chia_knock::settled_by`], round 10) — as
/// a knock is ([`crate::chia_knock::coin_word`]): the chain moving the block
/// that holds it moves the mark; a listing judged at or past its block that
/// lacks the coin returns the mark to PENDING — the spend may land again, and
/// the wallet lease pushes a bundle it still holds parked again when its input
/// reads unspent — and only the lease's word that the spend is dead, or its
/// coin gone to another write of ours, frees the era for a replacement
/// ([`crate::chia_resolve::write_standing`]); a listing judged below the block,
/// or undated, decides nothing. A beacon confirmed outside its era is void.
/// Nothing here is decided by the clock.
pub fn beacon_step(mark: &BeaconMark, word: Option<(crate::chia_resolve::WriteStanding, bool)>, era: u64, peak: u32) -> BeaconStep {
    use crate::chia_resolve::WriteStanding;
    match word {
        None => BeaconStep::Keep,
        Some((WriteStanding::Confirmed { height, .. }, _)) if chia_lane::era_of(height) != era => {
            BeaconStep::Forget(format!("confirmed at height {height}, outside its era — readers will not take it"))
        }
        Some((WriteStanding::Confirmed { height, .. }, _)) if !mark.confirmed || mark.confirmed_height != height => {
            BeaconStep::Save(BeaconMark { confirmed: true, confirmed_height: height, settled: false, ..mark.clone() })
        }
        Some((WriteStanding::Confirmed { height, seen_at }, _)) if crate::chia_knock::settled_by(height, peak, seen_at) => {
            BeaconStep::Save(BeaconMark { settled: true, ..mark.clone() })
        }
        Some((WriteStanding::Confirmed { .. }, _)) => BeaconStep::Keep,
        Some((WriteStanding::Dead(why), _)) => BeaconStep::Forget(format!("never landed — {why}")),
        Some((WriteStanding::Pending, true)) if mark.confirmed => {
            BeaconStep::Save(BeaconMark { confirmed: false, confirmed_height: 0, settled: false, ..mark.clone() })
        }
        Some((WriteStanding::Pending, _)) => BeaconStep::Keep,
    }
}

/// Settle the lease's parked spends against the chain now (under the gate),
/// then give the lease's word on each of `coins` ([`WalletLease::lease_word`])
/// and which of `spends` it still holds — parked or settling
/// ([`WalletLease::holds_spend`], #272 review round 12) — read in the same
/// breath, so the two answers describe one state. For the knock and beacon
/// verdicts, which would otherwise wait for the next writer to reconcile;
/// asked BEFORE the chain lookups, so a write confirming in between is seen
/// by them (#272 review round 2).
pub async fn lease_standing(client: &impl ChainAccess, coins: &[Bytes32], spends: &[u64]) -> (HashMap<Bytes32, LeaseWord>, HashSet<u64>) {
    let _gate = WALLET_LEASE.lock().await;
    WALLET_LEASE.reconcile(client).await;
    (
        coins.iter().map(|c| (*c, WALLET_LEASE.lease_word(c))).collect(),
        spends.iter().copied().filter(|s| WALLET_LEASE.holds_spend(*s)).collect(),
    )
}

/// Why a knock was not written after all (#272 review round 5): what allowed
/// it when it was queued no longer holds at SPEND time. Told apart from a
/// failure by the publisher, which drops the request instead of retrying it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Withdrawn(pub &'static str);

impl std::fmt::Display for Withdrawn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for Withdrawn {}

/// What a knock on a room's host may leave with, decided at SPEND time from
/// the room's LIVE cap (#272 review round 5): nothing, when the room no longer
/// uses cards (gone public, its switch off, the cap gone) or the two linked
/// meanwhile; otherwise a knock, carrying our contact key only where our card
/// may be handed out at all ([`ChiaRoomCap::hands_out_own_card`]).
pub fn knock_leave(
    cap: Option<&ChiaRoomCap>,
    linked: bool,
    key_durable: bool,
    share_enabled: bool,
    contact_key: &[u8; 32],
) -> Result<Option<[u8; 32]>, Withdrawn> {
    let Some(cap) = cap.filter(|c| c.may_use_cards()) else {
        return Err(Withdrawn("the room no longer uses cards"));
    };
    if linked {
        return Err(Withdrawn("the two are linked meanwhile"));
    }
    Ok(cap.hands_out_own_card(key_durable, share_enabled).then_some(*contact_key))
}

/// Write one knock for `req`: the knocker's node id, its contact key when
/// `leave` hands one out (so the host can read its presence and dial it there)
/// and the room's lane id, signed (iroh key), sealed to the host's card key
/// WITH the room's secret lane token, filed under the host's inbox hint for
/// that lane. `leave` is asked under `gate` once the input coin is chosen,
/// after the lease and coin lookups (#272 review round 5): its answer is the
/// room's word at spend time, and [`Withdrawn`] writes nothing. Returns the
/// hint and the write ([`MemoWrite`]: the input coin the knock is found again
/// by).
pub async fn publish_knock(
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    gate: &tokio::sync::Mutex<()>,
    leave: impl FnOnce() -> Result<Option<[u8; 32]>, Withdrawn>,
    req: &KnockRequest,
    room_key: &[u8; 32],
    era: u64,
    now: u64,
) -> Result<(Bytes32, MemoWrite)> {
    let lane = chia_lane::derive_lane_token(room_key);
    let hint = Bytes32::new(chia_lane::derive_inbox_hint(&req.ck_host, &lane, era));
    let lane_id = chia_lane::room_lane_id(&req.room);
    let from = iroh_sk.public();
    // Built and sealed once the input coin is known: its id is the parent of
    // the coin the knock rides on, and the sealing binds it (so the host opens
    // the knock under that coin alone — a copy under another never decodes,
    // #272 review round 3) and the lane token (so only a holder of the room
    // key can have written it, round 5).
    let kx_host = req.kx_host;
    let write = publish_memo_with(
        chia_sk,
        hint,
        Some(gate),
        move |input| {
            let ck_from = leave()?;
            let knock = KnockV2 { era, from, ck_from, issued_at: now, expires_at: now + 2 * ERA_SECS, rooms: vec![lane_id] };
            let plain = chia_lane::encode_knock_v2(&knock, iroh_sk)?;
            chia_lane::seal_to_kx(&kx_host, KIND_KNOCK, era, &input.to_bytes(), &lane, &plain)
        },
        "knock",
    )
    .await?;
    Ok((hint, write))
}

/// Write this era's beacon from the beacon wallet: the node id in the clear
/// under the era's public hint, nothing else. Returns the hint and the write
/// ([`MemoWrite`]: the input coin the beacon is found again by).
pub async fn publish_beacon(iroh_sk: &iroh::SecretKey, beacon_sk: &SecretKey, era: u64, now: u64) -> Result<(Bytes32, MemoWrite)> {
    let beacon = BeaconV2 { era, node_id: iroh_sk.public(), issued_at: now, expires_at: now + 2 * ERA_SECS };
    let plain = chia_lane::encode_beacon_v2(&beacon, iroh_sk)?;
    let hint = Bytes32::new(chia_lane::derive_beacon_hint(era));
    let write = publish_memo(beacon_sk, hint, plain.to_vec(), "beacon").await?;
    Ok((hint, write))
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
    // 📖 The last failed attempt's text, for the top bar's phone book; cleared
    // by the next successful write.
    let mut node_last_error: Option<String> = None;
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
            if m.chain_seen {
                "read back from the chain"
            } else if m.confirmed {
                "accepted by the peers"
            } else {
                "awaiting confirmation"
            }
        );
    }
    // #231 P6b/D7: the beacon role, when opted into — its own payer, its own mark.
    let beacon_sk = beacon_enabled().then(|| beacon_wallet_key(&chia_sk));
    let beacon_mark_path = std::path::Path::new(BEACON_MARK_FILE);
    let mut beacon_mark: Option<BeaconMark> = beacon_sk.as_ref().and_then(|_| BeaconMark::load(beacon_mark_path));
    let mut beacon_attempt: Option<Instant> = None;
    let mut welcome_warned = false;
    if let (Some(_), Some(m)) = (&beacon_sk, &beacon_mark) {
        println!(
            "⛓️ ChiaHub beacon: last written in era {} (hint {}, {})",
            m.era,
            &m.hint[..m.hint.len().min(16)],
            if m.settled {
                "settled"
            } else if m.confirmed {
                "confirmed, judged again until a lookup finds it settled"
            } else {
                "awaiting confirmation"
            }
        );
    }
    let knocks_path = std::path::Path::new(crate::chia_knock::KNOCKS_FILE);
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

        // The era is the chain's clock as the agreed lane sees it: the last
        // agreed peak while it is fresh, else one agreed read now, shared back
        // so the inbound marks and the watcher's next tick have it (an agreed
        // height serves them at least as well as a carrier's; the carrier's
        // never serves here). Height and read time travel as one snapshot
        // (`ChainPeak`), so a stale height is never judged by a newer time. No
        // agreed peak, no write. Read only when something era-bound may be
        // written this tick.
        let now_unix = crate::chia_resolve::unix_now();
        let knock_waiting = !hub.knock_queue.lock().unwrap().is_empty();
        let mut peak = agreed_peak.fresh(now_unix).unwrap_or(0);
        if peak == 0 && (findable || knock_waiting || beacon_sk.is_some()) {
            peak = crate::chia_resolve::peak_height(&peak_client).await.unwrap_or(0);
            if peak > 0 {
                agreed_peak = crate::chia_resolve::ChainPeak::new(peak, now_unix);
                *hub.chia_peak.lock().unwrap() = agreed_peak;
            }
        }

        // ── #231 P6a: the node's OWN presence first (priority over room publishes) ──
        if findable {
            // The watcher read THIS write back from the chain (the record's
            // signed issued_at is the mark's push time): confirmed, nothing
            // more to retry, and seen on chain, which is what the top bar's
            // phone book turns solid green on (the peers' acceptance alone,
            // all a node with the watcher off ever gets, is not). An older
            // record of ours re-read inside the cursor overlap names another
            // issued_at and confirms nothing. A read of the chain, not a
            // write, so it is recorded whatever the peak says.
            if let Some(m) = node_mark.as_mut() {
                let seen_at = hub.presence_confirmed_at.load(std::sync::atomic::Ordering::Relaxed);
                if mark_confirmed_by(m, seen_at) {
                    let first_word = !m.confirmed;
                    m.confirmed = true;
                    m.chain_seen = true;
                    if let Err(e) = m.save(mark_path) {
                        eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                    }
                    println!(
                        "⛓️ ChiaHub presence: the era {} write is {} on chain",
                        m.era,
                        if first_word { "confirmed" } else { "read back" }
                    );
                }
            }
            // The era and hint of a write this tick, when a peak is agreed; the
            // live address set either way, since the phone book's readout
            // judges the listing on record against it.
            let era_now = (peak > 0).then(|| chia_lane::era_of(peak));
            // 📖 The chain's own word on the listing, as for a beacon (#272
            // round 9): a mark of this era not yet settled is judged each tick
            // — pending, it is confirmed (solid green) or dead (void, written
            // again); confirmed, it is judged until a lookup finds its coin
            // SETTLED_DEPTH deep, and a listing judged past its block that
            // lacks the coin returns it to pending, the green with it. Marked
            // final at its first sighting, a listing a shallow reorganization
            // dropped would show green for the rest of the era.
            if let Some(era) = era_now {
                if let Some(m) = node_mark.as_ref().filter(|m| m.unsettled_for(era, &self_id)).cloned() {
                    match presence_step(&m, presence_standing(&peak_client, &m).await, era, peak) {
                        PresenceStep::Keep => {}
                        PresenceStep::Void(why) => {
                            println!("⛓️ ChiaHub presence: the era {era} listing {why}; writing it again");
                            let void = m.voided();
                            if let Err(e) = void.save(mark_path) {
                                eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                            }
                            node_mark = Some(void);
                        }
                        PresenceStep::Save(mark) => {
                            if mark.settled {
                                println!(
                                    "⛓️ ChiaHub presence: the era {era} listing stands at height {} — found unmoved {} blocks deep, final",
                                    mark.confirmed_height,
                                    crate::chia_knock::SETTLED_DEPTH
                                );
                            } else if !mark.chain_seen {
                                println!(
                                    "⛓️ ChiaHub presence: the block that confirmed the era {era} listing at height {} is gone (a reorganization) — waiting for the chain's word again",
                                    m.confirmed_height
                                );
                            } else if m.chain_seen && m.confirmed_height != 0 {
                                println!(
                                    "⛓️ ChiaHub presence: the chain moved the era {era} listing from height {} to {} (a reorganization)",
                                    m.confirmed_height, mark.confirmed_height
                                );
                            } else {
                                println!(
                                    "⛓️ ChiaHub presence: the era {era} listing is confirmed on chain at height {} — judged again until a lookup finds it {} blocks deep",
                                    mark.confirmed_height,
                                    crate::chia_knock::SETTLED_DEPTH
                                );
                            }
                            if let Err(e) = mark.save(mark_path) {
                                eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                            }
                            node_mark = Some(mark);
                        }
                    }
                }
            }
            let hint_now = era_now.map(|era| hex::encode(chia_lane::derive_ck_hint(&hub.contact_key, era)));
            let inbound = hub.inbound_verified.lock().unwrap().clone();
            let entries = public_addr_entries(&addrs, &inbound, peak, now_unix);
            let sig = addrs_signature(&entries);
            let mut spent_this_tick = false;
            if peak > 0 && era_guard(peak) {
                if !era_guard_logged {
                    println!("⛓️ ChiaHub presence: the era ends within {ERA_GUARD_BLOCKS} blocks — holding this write for the new era");
                    era_guard_logged = true;
                }
            } else if let (Some(era), Some(era_hint)) = (era_now, hint_now.as_deref()) {
                era_guard_logged = false;
                let retry_ok = node_attempt
                    .map(|t| t.elapsed() >= Duration::from_secs(HEARTBEAT_RETRY_SECS))
                    .unwrap_or(true);
                if node_publish_due(node_mark.as_ref(), era, &sig, now_unix, era_hint, &self_id) && retry_ok {
                    node_attempt = Some(Instant::now());
                    match publish_node_presence(&iroh_sk, &chia_sk, &hub.contact_key, era, &entries, now_unix).await {
                        Ok((hint, write)) => {
                            let writes = match &node_mark {
                                Some(m) if m.era == era && mark_is_ours(m, era_hint, &self_id) => m.writes + 1,
                                _ => 1,
                            };
                            let mark = NodePublishMark {
                                era,
                                writes,
                                addrs_sig: sig.clone(),
                                last_at: now_unix,
                                hint: hex::encode(hint.to_bytes()),
                                confirmed: !watcher_confirms,
                                chain_seen: false,
                                coin_id: hex::encode(write.coin.to_bytes()),
                                confirmed_height: 0,
                                settled: false,
                                spend: write.spend,
                                node_id: Some(self_id.clone()),
                            };
                            if let Err(e) = mark.save(mark_path) {
                                eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                            }
                            println!(
                                "⛓️ ChiaHub presence: {} for era {era} (write {writes}) · {} public addr(s) · hint {} — pending until its own coin is read back",
                                if write.acked { "published" } else { "pushed, unanswered" },
                                entries.len(),
                                &mark.hint[..16]
                            );
                            node_mark = Some(mark);
                            node_last_error = None;
                        }
                        Err(e) => {
                            eprintln!(
                                "⛓️ ChiaHub presence: publish for era {era} failed: {e:#} (retry in {} min)",
                                HEARTBEAT_RETRY_SECS / 60
                            );
                            node_last_error = Some(format!("{e:#}"));
                        }
                    }
                    spent_this_tick = true;
                }
            }
            // 📖 Mirror the readout for the loopback fingerprint, whichever
            // branch ran: the SpacePhone's top bar polls it each minute. The
            // text beside it is the last failed attempt's, or the one reason a
            // stale listing stays stale with no attempt at all: the era's write
            // budget is spent (the browser words the missing peak itself).
            let budget_spent = era_now.is_some_and(|era| {
                node_mark.as_ref().is_some_and(|m| {
                    m.era == era && m.writes >= 1 + MAX_NODE_WRITES_PER_ERA && (m.addrs_sig != sig || !m.confirmed)
                })
            });
            let why_not = node_last_error
                .as_deref()
                .or(budget_spent.then_some("this era's write budget is spent; the next listing goes out with the new era"));
            let mut status = presence_status(node_mark.as_ref(), hint_now.as_deref(), &self_id, era_now, &sig, entries.len(), why_not);
            if !watcher_confirms && status.error.is_none() && status.state == crate::ChiaPresenceState::Sent {
                status.error = Some("the chain watcher is off (SSF_CHIA_WATCH=0), so the listing is never read back".into());
            }
            *hub.presence_status.lock().unwrap() = Some(status);
            if spent_this_tick {
                continue; // one spend per tick — see the doc comment
            }
        }

        // ── #231 P6b: one KNOCK per tick, after presence and before the room
        // publishes (priority presence > knock > beacon). A queued request is
        // still honoured only if its room still allows cards (the toggle may
        // have flipped, the browser may have declared the room public), the
        // host was not knocked on this era already, and the two are not linked
        // meanwhile (a link by any path cancels the knock). Era-bound like
        // presence: no write without a peak or inside the era's guard blocks.
        if knock_waiting && peak > 0 && !era_guard(peak) {
            let era = chia_lane::era_of(peak);
            let next = loop {
                let Some(req) = hub.knock_queue.lock().unwrap().pop_front() else { break None };
                let cap = hub.chia_rooms.lock().unwrap().get(&req.room).cloned();
                let Some(cap) = cap.filter(|c| c.may_use_cards()) else {
                    println!("⛓️ ChiaHub knock: not knocking on {} for room {} — the room no longer uses cards", short(&req.host), req.room);
                    continue;
                };
                if hub.knocks.lock().unwrap().knocked_this_era(&req.host, era) {
                    continue;
                }
                if req.host.parse::<iroh::PublicKey>().is_ok_and(|pk| crate::linked_in_room(&hub, &req.room, &pk)) {
                    continue;
                }
                break Some((req, cap.room_key));
            };
            if let Some((mut req, room_key)) = next {
                // The room's word is read AGAIN at spend time, under the card
                // gate, after the lease and coin lookups (#272 review round 5):
                // a cap turning the room public or its switch off meanwhile
                // withdraws the knock, and our contact key rides in it only
                // where our card may be handed out at all (round 4: the node's
                // own Share Card switch on, a durable key, the room KNOWN
                // private — a private pass's word admits its cards, not ours).
                // A bare knock still names our node id, which the host dials
                // back through the DHT.
                let leave = {
                    let hub = hub.clone();
                    let (room, host) = (req.room.clone(), req.host.clone());
                    move || {
                        let cap = hub.chia_rooms.lock().unwrap().get(&room).cloned();
                        let linked = host.parse::<iroh::PublicKey>().is_ok_and(|pk| crate::linked_in_room(&hub, &room, &pk));
                        knock_leave(cap.as_ref(), linked, hub.contact_key_durable, crate::chia_contact::share_card_enabled(), &hub.contact_key)
                    }
                };
                match publish_knock(&iroh_sk, &chia_sk, &hub.card_gate, leave, &req, &room_key, era, now_unix).await {
                    Ok((hint, write)) => {
                        let hint_hex = hex::encode(hint.to_bytes());
                        println!(
                            "⛓️ ChiaHub knock: {} on {} for room {} in era {era} · inbox hint {} — both sides dial on the confirmation height",
                            if write.acked { "knocked" } else { "knock pushed, unanswered (filed as pending; the chain's word settles it)" },
                            short(&req.host),
                            req.room,
                            &hint_hex[..16]
                        );
                        // Filed whether or not the push was answered: an
                        // unanswered knock may be in a mempool with its coin
                        // parked, and only a filed knock gets its confirmation
                        // clock, or is forgotten on the chain's word that it
                        // died — unfiled, it would be knocked again beside the
                        // first (#272 review).
                        let mut book = hub.knocks.lock().unwrap();
                        book.record_sent(SentKnock {
                            host: req.host.clone(),
                            room: req.room.clone(),
                            era,
                            hint: hint_hex,
                            coin_id: hex::encode(write.coin.to_bytes()),
                            pushed_at: now_unix,
                            confirmed_height: 0,
                            last_rendezvous: 0,
                            settled: false,
                            spend: write.spend,
                        });
                        if let Err(e) = book.save(knocks_path) {
                            eprintln!("⛓️ ChiaHub knock: could not save {}: {e}", crate::chia_knock::KNOCKS_FILE);
                        }
                    }
                    Err(e) if e.downcast_ref::<Withdrawn>().is_some() => {
                        println!(
                            "⛓️ ChiaHub knock: not knocking on {} for room {} — {e} (the room's word changed while the spend was prepared)",
                            short(&req.host),
                            req.room
                        );
                    }
                    Err(e) => {
                        req.attempts = req.attempts.saturating_add(1);
                        if req.attempts < MAX_KNOCK_ATTEMPTS {
                            eprintln!("⛓️ ChiaHub knock: knock on {} for room {} failed: {e:#} (retry next tick)", short(&req.host), req.room);
                            hub.knock_queue.lock().unwrap().push_back(req);
                        } else {
                            eprintln!(
                                "⛓️ ChiaHub knock: knock on {} for room {} failed {} times: {e:#} — dropped; the next dial exhaustion asks again",
                                short(&req.host),
                                req.room,
                                req.attempts
                            );
                        }
                    }
                }
                continue; // one spend per tick
            }
        }

        // ── #231 P6b/D7: the BEACON, once per era, only while this node has
        // accepted an unsolicited direct inbound connection this era (the
        // measured bit: a beacon that cannot be reached is noise), paid by its
        // own wallet.
        if let Some(beacon_sk) = &beacon_sk {
            if peak > 0 && !era_guard(peak) {
                let era = chia_lane::era_of(peak);
                // A mark of this era not yet settled is judged by the chain's
                // word first (#272 review rounds 1 and 9): pending, it is
                // confirmed, or dead (the mempool dropped the spend, or its
                // coin went to another write) and the beacon due again;
                // confirmed, it is judged until a lookup finds its coin
                // SETTLED_DEPTH deep — the chain moving its block moves the
                // mark, and a listing judged past its block that lacks the
                // coin returns it to pending, with no replacement until the
                // lease's word that the spend is dead. Marked final at the
                // peers' acceptance, or at its first inclusion, a dropped
                // beacon would leave this node undiscoverable for the rest of
                // the era, restart or not.
                if let Some(m) = beacon_mark.as_ref().filter(|m| m.unsettled_for(era, &self_id)).cloned() {
                    match beacon_step(&m, beacon_standing(&peak_client, &m).await, era, peak) {
                        BeaconStep::Keep => {}
                        BeaconStep::Forget(why) => {
                            println!("⛓️ ChiaHub beacon: the era {era} beacon {why}; writing it again");
                            beacon_mark = None;
                            let _ = std::fs::remove_file(beacon_mark_path);
                        }
                        BeaconStep::Save(mark) => {
                            if mark.settled {
                                println!(
                                    "⛓️ ChiaHub beacon: the era {era} beacon stands at height {} — found unmoved {} blocks deep, final",
                                    mark.confirmed_height,
                                    crate::chia_knock::SETTLED_DEPTH
                                );
                            } else if !mark.confirmed {
                                println!(
                                    "⛓️ ChiaHub beacon: the block that confirmed the era {era} beacon at height {} is gone (a reorganization) — waiting for the chain's word again",
                                    m.confirmed_height
                                );
                            } else if m.confirmed && m.confirmed_height != 0 {
                                println!(
                                    "⛓️ ChiaHub beacon: the chain moved the era {era} beacon from height {} to {} (a reorganization)",
                                    m.confirmed_height, mark.confirmed_height
                                );
                            } else {
                                println!(
                                    "⛓️ ChiaHub beacon: the era {era} beacon is confirmed on chain at height {} — judged again until a lookup finds it {} blocks deep",
                                    mark.confirmed_height,
                                    crate::chia_knock::SETTLED_DEPTH
                                );
                            }
                            if let Err(e) = mark.save(beacon_mark_path) {
                                eprintln!("⛓️ ChiaHub beacon: could not save {BEACON_MARK_FILE}: {e}");
                            }
                            beacon_mark = Some(mark);
                        }
                    }
                }
                let inbound = hub.inbound_verified.lock().unwrap().clone();
                let reachable = inbound.flags_for(false, peak, now_unix) != 0 || inbound.flags_for(true, peak, now_unix) != 0;
                let retry_ok = beacon_attempt
                    .map(|t| t.elapsed() >= Duration::from_secs(HEARTBEAT_RETRY_SECS))
                    .unwrap_or(true);
                // A beacon leads to the welcome room: none is written while
                // this node does not serve it (#272 review round 3).
                let serves_welcome = serves_welcome_room(&hub);
                if !serves_welcome && !welcome_warned {
                    eprintln!(
                        "⛓️ ChiaHub beacon: not advertising — this node does not serve the welcome room (a beacon is an entry point to it; open the welcome room in the local browser once and the node keeps it)"
                    );
                    welcome_warned = true;
                }
                if reachable && serves_welcome && retry_ok && beacon_due(beacon_mark.as_ref(), era, &self_id) {
                    beacon_attempt = Some(Instant::now());
                    match publish_beacon(&iroh_sk, beacon_sk, era, now_unix).await {
                        Ok((hint, write)) => {
                            let mark = BeaconMark {
                                era,
                                last_at: now_unix,
                                hint: hex::encode(hint.to_bytes()),
                                node_id: Some(self_id.clone()),
                                coin_id: hex::encode(write.coin.to_bytes()),
                                confirmed: false,
                                confirmed_height: 0,
                                settled: false,
                                spend: write.spend,
                            };
                            if let Err(e) = mark.save(beacon_mark_path) {
                                eprintln!("⛓️ ChiaHub beacon: could not save {BEACON_MARK_FILE}: {e}");
                            }
                            println!(
                                "⛓️ ChiaHub beacon: {} for era {era} · hint {} — pending until its own coin is read back",
                                if write.acked { "published" } else { "pushed, unanswered" },
                                &mark.hint[..16]
                            );
                            beacon_mark = Some(mark);
                        }
                        Err(e) => eprintln!(
                            "⛓️ ChiaHub beacon: publish for era {era} failed: {e:#} (retry in {} min; the beacon wallet is funded separately)",
                            HEARTBEAT_RETRY_SECS / 60
                        ),
                    }
                    continue; // one spend per tick
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

/// The first characters of a node id, for the log.
fn short(node_id: &str) -> &str {
    &node_id[..node_id.len().min(16)]
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
        ChiaRoomCap { room_key: [key; 32], chia_mode, share_card: true, public_room, seq: 0, restored: false, pass_private: false, prefetch: false }
    }

    #[test]
    fn a_knock_leaves_on_the_rooms_word_at_spend_time() {
        // #272 review round 5: the word read when the knock was queued may be
        // stale by the time the lease and coin lookups are done; the spend
        // asks again, and a withdrawn knock is not a failed one.
        let ck = [7u8; 32];
        let private = cap(1, false, Some(false));
        assert_eq!(knock_leave(Some(&private), false, true, true, &ck), Ok(Some(ck)), "known private, sharing: the key rides");
        assert_eq!(knock_leave(Some(&private), false, false, true, &ck), Ok(None), "a key not kept across restarts: a bare knock");
        assert_eq!(knock_leave(Some(&private), false, true, false, &ck), Ok(None), "the node's own switch off: a bare knock");
        let first_visit = ChiaRoomCap { public_room: None, pass_private: true, ..private.clone() };
        assert_eq!(knock_leave(Some(&first_visit), false, true, true, &ck), Ok(None), "a private pass admits its cards, not ours: bare");
        let gone = Err(Withdrawn("the room no longer uses cards"));
        assert_eq!(knock_leave(Some(&ChiaRoomCap { public_room: Some(true), ..private.clone() }), false, true, true, &ck), gone, "gone public meanwhile");
        assert_eq!(knock_leave(Some(&ChiaRoomCap { share_card: false, ..private.clone() }), false, true, true, &ck), gone, "its switch turned off meanwhile");
        assert_eq!(knock_leave(None, false, true, true, &ck), gone, "the cap gone");
        assert_eq!(knock_leave(Some(&private), true, true, true, &ck), Err(Withdrawn("the two are linked meanwhile")));
        let err: anyhow::Error = Withdrawn("x").into();
        assert!(err.downcast_ref::<Withdrawn>().is_some(), "the publisher tells a withdrawn knock from a failed one");
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
            chain_seen: true,
            coin_id: String::new(),
            confirmed_height: 0,
            settled: false,
            spend: None,
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
        let pending = NodePublishMark { confirmed: false, chain_seen: false, ..mark.clone() };
        assert!(!node_publish_due(Some(&pending), 5, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS - 1, "h", "n"), "pending, inside the window");
        assert!(node_publish_due(Some(&pending), 5, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n"), "pending too long: retry");
        assert!(node_publish_due(Some(&pending), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS, "h", "n"), "pending, but the addresses changed: the change rule still applies");
        let pending_spent = NodePublishMark { confirmed: false, chain_seen: false, writes: 1 + MAX_NODE_WRITES_PER_ERA, ..mark.clone() };
        assert!(!node_publish_due(Some(&pending_spent), 5, "a", now + 2 * PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n"), "retries spend the same era budget");
        // Confirmation names the exact write: the record carrying the mark's own
        // issued_at, not any record of ours from the same era.
        assert!(mark_confirmed_by(&pending, now), "the record published at the mark's time confirms it");
        assert!(!mark_confirmed_by(&pending, now - 1), "an older record of ours (same era) confirms nothing");
        assert!(!mark_confirmed_by(&pending, 0), "nothing read back yet");
        assert!(!mark_confirmed_by(&mark, now), "a mark the chain showed back needs nothing");
        // No watcher ran when the write went out: the peers' acceptance ended
        // the retries (confirmed) but the chain never showed it (not seen), so
        // the first read that does still counts.
        let accepted = NodePublishMark { chain_seen: false, ..mark.clone() };
        assert!(mark_confirmed_by(&accepted, now), "accepted by the peers alone: the chain's first word still confirms it");
        assert!(!node_publish_due(Some(&accepted), 5, "a", now + 2 * PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n"), "…and it is not retried meanwhile");
        let legacy: NodePublishMark = serde_json::from_str(r#"{"era":5,"writes":1,"addrs_sig":"a","last_at":1,"hint":""}"#).unwrap();
        assert!(!legacy.confirmed, "a mark file without the field reads as unconfirmed");
        assert!(!legacy.chain_seen, "…and as not yet seen on chain");
        assert!(!mark_is_ours(&legacy, "", "n"), "a mark without a node id is nobody's");
    }

    /// 📖 The phone book in the top bar: green while this era's listing with
    /// these addresses is confirmed, green outline while it is only sent, grey
    /// once a listing of ours has gone stale, nothing while none is ours.
    #[test]
    fn the_phone_book_readout_follows_the_listing_on_record() {
        use crate::ChiaPresenceState::*;
        let now = 1_791_700_000u64;
        let mark = NodePublishMark {
            era: 5,
            writes: 1,
            addrs_sig: "a".into(),
            last_at: now,
            hint: "h".into(),
            confirmed: true,
            chain_seen: true,
            coin_id: String::new(),
            confirmed_height: 0,
            settled: false,
            spend: None,
            node_id: Some("n".into()),
        };
        assert_eq!(presence_state(None, false, Some(5), "a"), Unlisted, "never written");
        assert_eq!(presence_state(Some(&mark), true, Some(5), "a"), Listed, "this era, these addresses, read back from the chain");
        let pending = NodePublishMark { confirmed: false, chain_seen: false, ..mark.clone() };
        assert_eq!(presence_state(Some(&pending), true, Some(5), "a"), Sent, "pushed, not read back yet");
        let accepted = NodePublishMark { chain_seen: false, ..mark.clone() };
        assert_eq!(presence_state(Some(&accepted), true, Some(5), "a"), Sent, "the peers' acceptance alone (the watcher off) is sent, not listed");
        let accepted_status = presence_status(Some(&accepted), Some("h"), "n", Some(5), "a", 2, None);
        assert_eq!((accepted_status.state, accepted_status.confirmed, accepted_status.current), (Sent, false, true));
        assert_eq!(presence_state(Some(&mark), true, Some(6), "a"), Outdated, "a new era: the listing is last week's");
        assert_eq!(presence_state(Some(&mark), true, Some(5), "b"), Outdated, "the addresses changed");
        assert_eq!(presence_state(Some(&mark), true, None, "a"), Outdated, "no agreed peak to judge the era by");
        assert_eq!(presence_state(Some(&mark), false, Some(5), "a"), Unlisted, "another identity's mark is nobody's listing");

        // The whole readout: the figures the tooltip names, and who the mark belongs to.
        let listed = presence_status(Some(&mark), Some("h"), "n", Some(5), "a", 2, None);
        assert_eq!(
            listed,
            crate::ChiaPresence { state: Listed, era: 5, listed_era: 5, last_at: now, confirmed: true, current: true, public_addrs: 2, error: None }
        );
        let stale = presence_status(Some(&mark), Some("h6"), "n", Some(6), "a", 2, None);
        assert_eq!(stale.state, Outdated, "a new era brings a new hint, so last era's listing is ours by its signer: the grey book");
        assert_eq!((stale.era, stale.listed_era, stale.current), (6, 5, false));
        let replaced = presence_status(Some(&mark), Some("other-hint"), "n", Some(5), "a", 2, None);
        assert_eq!(replaced.state, Unlisted, "same era, another contact key: that mark sits under a hint nobody looks under");
        let stale = presence_status(Some(&mark), None, "n", None, "", 1, Some("no agreed chain peak yet"));
        assert_eq!(stale.state, Outdated, "without an era (no peak) the signer alone says it is ours");
        assert_eq!((stale.era, stale.listed_era, stale.last_at, stale.confirmed, stale.current), (0, 5, now, true, false));
        assert_eq!(stale.error.as_deref(), Some("no agreed chain peak yet"));
        let other = presence_status(Some(&mark), Some("h"), "other-node", Some(5), "a", 2, Some("chia wallet unfunded"));
        assert_eq!(other.state, Unlisted);
        assert_eq!((other.listed_era, other.last_at, other.confirmed), (0, 0, false), "another identity's figures are not reported as ours");
        assert_eq!(other.error.as_deref(), Some("chia wallet unfunded"));
        let changed = presence_status(Some(&pending), Some("h"), "n", Some(5), "b", 3, None);
        assert_eq!((changed.state, changed.current, changed.confirmed, changed.public_addrs), (Outdated, false, false, 3));
    }

    /// 📖 The listing the Phone Book's icon stands on follows the chain's word
    /// as a beacon does: confirmed and judged again until settled, pending
    /// again when its block goes, void and written again when it never landed;
    /// the era's write budget survives a void.
    #[test]
    fn a_listing_is_judged_until_a_lookup_settles_it_and_pending_again_when_its_block_goes() {
        use crate::chia_knock::SETTLED_DEPTH;
        use crate::chia_resolve::WriteStanding::{Confirmed, Dead, Pending};
        let era = 5u64;
        let h0 = 5 * ERA_BLOCKS;
        let now = 1_791_700_000u64;
        let found = |height: u32, seen_at: Option<u32>| Confirmed { height, seen_at };
        let pending = NodePublishMark {
            era,
            writes: 3,
            addrs_sig: "a".into(),
            last_at: now,
            hint: "h".into(),
            confirmed: false,
            chain_seen: false,
            coin_id: "c".into(),
            confirmed_height: 0,
            settled: false,
            spend: Some(7),
            node_id: Some("n".into()),
        };
        assert!(pending.unsettled_for(era, "n"));
        assert!(!pending.unsettled_for(era, "other") && !pending.unsettled_for(era + 1, "n"));
        assert!(!NodePublishMark { coin_id: String::new(), ..pending.clone() }.unsettled_for(era, "n"), "no coin: nothing to judge");
        // No word from the chain, or a pending write still pending: nothing.
        assert_eq!(presence_step(&pending, None, era, h0 + 50), PresenceStep::Keep);
        assert_eq!(presence_step(&pending, Some((Pending, false)), era, h0 + 50), PresenceStep::Keep);
        assert_eq!(presence_state(Some(&pending), true, Some(era), "a"), crate::ChiaPresenceState::Sent, "pending: a green outline");
        // Confirmed: seen on chain (solid green), the height kept, judged again.
        let PresenceStep::Save(confirmed) = presence_step(&pending, Some((found(h0 + 40, Some(h0 + 50)), false)), era, h0 + 50) else { panic!("confirmed: saved") };
        assert_eq!((confirmed.confirmed, confirmed.chain_seen, confirmed.confirmed_height, confirmed.settled), (true, true, h0 + 40, false));
        assert_eq!(presence_state(Some(&confirmed), true, Some(era), "a"), crate::ChiaPresenceState::Listed);
        assert!(confirmed.unsettled_for(era, "n"), "young: judged again");
        assert!(!node_publish_due(Some(&confirmed), era, "a", now + 3600, "h", "n"));
        // Found where the mark says, young: nothing yet; deep enough: settled, final.
        assert_eq!(presence_step(&confirmed, Some((found(h0 + 40, Some(h0 + 40 + SETTLED_DEPTH - 1)), false)), era, h0 + 40 + SETTLED_DEPTH - 1), PresenceStep::Keep);
        let PresenceStep::Save(settled) = presence_step(&confirmed, Some((found(h0 + 40, Some(h0 + 40 + SETTLED_DEPTH)), false)), era, h0 + 40 + SETTLED_DEPTH) else { panic!("settled: saved") };
        assert!(settled.settled && settled.chain_seen && !settled.unsettled_for(era, "n"));
        assert_eq!(presence_step(&confirmed, Some((found(h0 + 40, Some(h0 + 40 + SETTLED_DEPTH - 1)), false)), era, h0 + 40 + SETTLED_DEPTH), PresenceStep::Keep, "the peak is deep enough, the peers answering were not");
        assert_eq!(presence_step(&confirmed, Some((found(h0 + 40, None), false)), era, h0 + 100), PresenceStep::Keep, "undated: no depth is proved");
        // Moved by a reorganization: the mark follows, unsettled again.
        let PresenceStep::Save(moved) = presence_step(&confirmed, Some((found(h0 + 42, Some(h0 + 100)), false)), era, h0 + 100) else { panic!("moved: saved") };
        assert_eq!((moved.confirmed_height, moved.settled, moved.chain_seen), (h0 + 42, false, true));
        // The block is gone, by a listing judged past it: pending again — the
        // green goes, the spend may land again, and the clock's retry asks the
        // lease (which refuses while it still holds the spend) …
        let PresenceStep::Save(again) = presence_step(&confirmed, Some((Pending, true)), era, h0 + 100) else { panic!("gone: saved") };
        assert_eq!((again.confirmed, again.chain_seen, again.confirmed_height, again.settled), (false, false, 0, false));
        assert_eq!(presence_state(Some(&again), true, Some(era), "a"), crate::ChiaPresenceState::Sent, "no longer on chain: no longer solid green");
        assert!(again.unsettled_for(era, "n"));
        assert!(node_publish_due(Some(&again), era, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n"), "pending again past the window: the clock asks the lease");
        // … but a listing judged below the block, or undated, is no such word.
        assert_eq!(presence_step(&confirmed, Some((Pending, false)), era, h0 + 100), PresenceStep::Keep, "peers behind the confirmation: nothing is decided");
        // Dead on the lease's word, or confirmed outside its era: the write is
        // void — the listing is due at once, the era's budget kept.
        let PresenceStep::Void(why) = presence_step(&again, Some((Dead("the mempool dropped it"), false)), era, h0 + 100) else { panic!("dead: void") };
        assert!(why.contains("the mempool dropped it"), "{why}");
        assert!(matches!(presence_step(&pending, Some((found(h0 - 1, Some(h0 + 100)), false)), era, h0 + 100), PresenceStep::Void(why) if why.contains("outside its era")));
        let void = confirmed.voided();
        assert_eq!((void.era, void.writes, void.addrs_sig.as_str(), void.hint.as_str()), (era, 3, "a", "h"), "the era, its write count and the addresses stay");
        assert_eq!((void.last_at, void.confirmed, void.chain_seen, void.coin_id.as_str(), void.confirmed_height, void.settled, void.spend), (0, false, false, "", 0, false, None));
        assert!(!void.unsettled_for(era, "n"), "nothing left to judge");
        assert!(node_publish_due(Some(&void), era, "a", now, "h", "n"), "void: due at once");
        let spent_void = NodePublishMark { writes: 1 + MAX_NODE_WRITES_PER_ERA, ..void.clone() };
        assert!(!node_publish_due(Some(&spent_void), era, "a", now, "h", "n"), "…unless the era's budget is spent");
        assert_eq!(presence_state(Some(&void), true, Some(era), "a"), crate::ChiaPresenceState::Sent, "void but ours and current: on its way again");
        // Across a restart: the file keeps the coin, the height and the
        // settlement; a mark written before they were kept names no coin and
        // is left to the watcher's read, as before.
        let kept: NodePublishMark = serde_json::from_slice(&serde_json::to_vec(&confirmed).unwrap()).unwrap();
        assert_eq!(kept, confirmed);
        let old: NodePublishMark = serde_json::from_str(r#"{"era":5,"writes":1,"addrs_sig":"a","last_at":1,"hint":"h","confirmed":true,"chain_seen":true,"node_id":"n"}"#).unwrap();
        assert!(old.coin_id.is_empty() && old.confirmed_height == 0 && !old.settled && old.spend.is_none());
        assert!(!old.unsettled_for(era, "n"), "no coin to look up: not judged");
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
    fn a_release_remembers_why_and_the_lease_answers_parked_spent_dropped_or_unknown() {
        let coin = |seed: u8| Bytes32::new([seed; 32]);
        let due = vec![
            DueSpend { spend: 1, coins: vec![coin(1).into(), coin(2).into()], bundle: None },
            DueSpend { spend: 2, coins: vec![coin(3).into()], bundle: None },
            DueSpend { spend: 3, coins: vec![(coin(4), 50).into()], bundle: None },
            DueSpend { spend: 4, coins: vec![coin(5).into()], bundle: None },
        ];
        let spent: HashMap<Bytes32, bool> = [(coin(1), true), (coin(2), false), (coin(3), false), (coin(5), false)].into_iter().collect();
        let mempool: HashMap<u64, Option<bool>> = [(2, Some(false)), (4, Some(true))].into_iter().collect();
        // Spend 1 confirmed (one input spent), spend 2 was refused everywhere,
        // spend 3's coin is absent at a height it was known at, spend 4 is live.
        let released = settle(&due, &spent, &mempool, Some(60));
        assert_eq!(released, vec![1, 2, 3]);
        let words = release_words(&due, &released, &spent, &mempool);
        assert_eq!(
            words,
            vec![(coin(1), LeaseWord::Spent), (coin(2), LeaseWord::Spent), (coin(3), LeaseWord::Dropped)],
            "the silent release of spend 3 gets no word"
        );
        let lease = WalletLease::new();
        let bundle = SpendBundle::new(vec![], chia_bls::Signature::default());
        let parking = lease.park_with_bundle([coin(9)], &bundle).unwrap();
        lease.remember(&words);
        assert_eq!(lease.lease_word(&coin(9)), LeaseWord::Parked);
        assert_eq!(lease.lease_word(&coin(1)), LeaseWord::Spent);
        assert_eq!(lease.lease_word(&coin(2)), LeaseWord::Spent, "every coin of a confirmed spend is spent to the lease");
        assert_eq!(lease.lease_word(&coin(3)), LeaseWord::Dropped);
        assert_eq!(lease.lease_word(&coin(4)), LeaseWord::Unknown, "released on silence: unknown");
        assert_eq!(lease.lease_word(&coin(5)), LeaseWord::Unknown, "still due, never parked here: unknown");
        // A coin parked again by a later spend reads as parked over its old word.
        let _again = lease.park_with_bundle([coin(3)], &bundle).unwrap();
        assert_eq!(lease.lease_word(&coin(3)), LeaseWord::Parked);
        lease.unpark(&parking);
        assert_eq!(lease.lease_word(&coin(9)), LeaseWord::Unknown, "handed back by a rejection: no verdict, unknown");
        // The memory is bounded: past the cap it starts afresh.
        let many: Vec<(Bytes32, LeaseWord)> = (0..MAX_RELEASES_REMEMBERED).map(|i| (Bytes32::new([(i % 251) as u8, (i / 251) as u8, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), LeaseWord::Dropped)).collect();
        lease.remember(&many);
        assert_eq!(lease.lease_word(&coin(1)), LeaseWord::Unknown, "the old verdicts went with the reset");
        assert_eq!(lease.lease_word(&many[0].0), LeaseWord::Dropped);
    }

    #[test]
    fn a_pending_beacon_mark_holds_until_the_chain_settles_it() {
        assert!(beacon_due(None, 5, "n"), "never written: due");
        let pending = BeaconMark { era: 5, last_at: 1, hint: "h".into(), node_id: Some("n".into()), coin_id: "c".into(), confirmed: false, confirmed_height: 0, settled: false, spend: None };
        assert!(!beacon_due(Some(&pending), 5, "n"), "pending: the chain's word settles it, not a second write");
        let confirmed = BeaconMark { confirmed: true, ..pending.clone() };
        assert!(!beacon_due(Some(&confirmed), 5, "n"));
        assert!(beacon_due(Some(&confirmed), 6, "n"), "a new era");
        assert!(beacon_due(Some(&confirmed), 5, "other"), "another identity's mark");
        // A mark file from before the fields reads as pending with no coin to judge.
        let legacy: BeaconMark = serde_json::from_str(r#"{"era":5,"last_at":1,"hint":"h","node_id":"n"}"#).unwrap();
        assert!(!legacy.confirmed);
        assert!(legacy.coin_id.is_empty());
        let round: BeaconMark = serde_json::from_slice(&serde_json::to_vec(&pending).unwrap()).unwrap();
        assert_eq!(round, pending);
    }

    #[test]
    fn a_beacon_is_judged_until_a_lookup_settles_it_and_pending_again_when_its_block_goes() {
        // #272 review round 9: a mark final at its first inclusion left the
        // node without a beacon for the rest of the era when a shallow
        // reorganization dropped that block. The mark now follows the chain's
        // word as a knock does, keeps what it learned across a restart, and
        // frees the era for a replacement only on the word that the spend is
        // dead.
        use crate::chia_knock::SETTLED_DEPTH;
        use crate::chia_resolve::WriteStanding::{Confirmed, Dead, Pending};
        let era = 5u64;
        let h0 = 5 * ERA_BLOCKS;
        let found = |height: u32, seen_at: Option<u32>| Confirmed { height, seen_at };
        let pending = BeaconMark { era, last_at: 1, hint: "h".into(), node_id: Some("n".into()), coin_id: "c".into(), confirmed: false, confirmed_height: 0, settled: false, spend: None };
        assert!(pending.unsettled_for(era, "n"));
        assert!(!pending.unsettled_for(era, "other") && !pending.unsettled_for(era + 1, "n"));
        assert!(!BeaconMark { coin_id: String::new(), ..pending.clone() }.unsettled_for(era, "n"), "no coin: nothing to judge");
        // No word from the chain, or a pending write still pending: nothing.
        assert_eq!(beacon_step(&pending, None, era, h0 + 50), BeaconStep::Keep);
        assert_eq!(beacon_step(&pending, Some((Pending, false)), era, h0 + 50), BeaconStep::Keep);
        // Confirmed: the height is kept, the mark judged again.
        let BeaconStep::Save(confirmed) = beacon_step(&pending, Some((found(h0 + 40, Some(h0 + 50)), false)), era, h0 + 50) else { panic!("confirmed: saved") };
        assert_eq!((confirmed.confirmed, confirmed.confirmed_height, confirmed.settled), (true, h0 + 40, false));
        assert!(confirmed.unsettled_for(era, "n"), "young: judged again");
        assert!(!beacon_due(Some(&confirmed), era, "n"));
        // Found where the mark says, young: nothing yet; deep enough: settled, final.
        assert_eq!(beacon_step(&confirmed, Some((found(h0 + 40, Some(h0 + 40 + SETTLED_DEPTH - 1)), false)), era, h0 + 40 + SETTLED_DEPTH - 1), BeaconStep::Keep);
        let BeaconStep::Save(settled) = beacon_step(&confirmed, Some((found(h0 + 40, Some(h0 + 40 + SETTLED_DEPTH)), false)), era, h0 + 40 + SETTLED_DEPTH) else { panic!("settled: saved") };
        assert!(settled.settled && !settled.unsettled_for(era, "n"));
        // Round 10: the lookup's word reaches only as deep as the peers that
        // gave it stood; the agreed peak alone proves nothing of the coin.
        assert_eq!(beacon_step(&confirmed, Some((found(h0 + 40, Some(h0 + 40 + SETTLED_DEPTH - 1)), false)), era, h0 + 40 + SETTLED_DEPTH), BeaconStep::Keep, "the peak is deep enough, the peers answering are not");
        assert_eq!(beacon_step(&confirmed, Some((found(h0 + 40, None), false)), era, h0 + 100), BeaconStep::Keep, "undated: no depth is proved");
        // Moved by a reorganization: the mark follows, unsettled again.
        let BeaconStep::Save(moved) = beacon_step(&confirmed, Some((found(h0 + 42, Some(h0 + 100)), false)), era, h0 + 100) else { panic!("moved: saved") };
        assert_eq!((moved.confirmed_height, moved.settled), (h0 + 42, false));
        // The block is gone, by a listing judged past it: pending again — no
        // replacement is written, the spend may land again …
        let BeaconStep::Save(again) = beacon_step(&confirmed, Some((Pending, true)), era, h0 + 100) else { panic!("gone: saved") };
        assert_eq!((again.confirmed, again.confirmed_height, again.settled), (false, 0, false));
        assert!(!beacon_due(Some(&again), era, "n"), "pending again: the era is not free for a replacement");
        assert!(again.unsettled_for(era, "n"));
        // … but a listing judged below the block, or undated, is no such word.
        assert_eq!(beacon_step(&confirmed, Some((Pending, false)), era, h0 + 100), BeaconStep::Keep, "peers behind the confirmation: nothing is decided");
        // Dead on the lease's word, or confirmed outside its era: the mark
        // goes and the beacon is due again.
        assert!(matches!(beacon_step(&again, Some((Dead("the mempool dropped it"), false)), era, h0 + 100), BeaconStep::Forget(why) if why.contains("the mempool dropped it")));
        assert!(matches!(beacon_step(&pending, Some((found(h0 - 1, Some(h0 + 100)), false)), era, h0 + 100), BeaconStep::Forget(why) if why.contains("outside its era")));
        // Across a restart: the file keeps the height and the settlement, and a
        // mark written before they were kept (round 1's shape) is judged again.
        let kept: BeaconMark = serde_json::from_slice(&serde_json::to_vec(&confirmed).unwrap()).unwrap();
        assert_eq!(kept, confirmed);
        assert!(kept.unsettled_for(era, "n"));
        let old: BeaconMark = serde_json::from_str(r#"{"era":5,"last_at":1,"hint":"h","node_id":"n","coin_id":"c","confirmed":true}"#).unwrap();
        assert!(old.confirmed && old.confirmed_height == 0 && !old.settled && old.unsettled_for(era, "n"), "final at its first inclusion no more: judged again");
        let BeaconStep::Save(learned) = beacon_step(&old, Some((found(h0 + 40, Some(h0 + 50)), false)), era, h0 + 50) else { panic!("the height is learned") };
        assert_eq!(learned.confirmed_height, h0 + 40);
        assert_eq!(beacon_step(&old, Some((Pending, false)), era, h0 + 50), BeaconStep::Keep, "with no height kept, no listing can say its block is gone");
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
        let empty_bundle = hex::encode(SpendBundle::new(vec![], Signature::default()).to_bytes().unwrap());
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
            // Round 10: a settling spend outside the counter, one parked too,
            // one with no inputs, one with no spent height, one with an
            // unreadable bundle.
            format!(r#"{{"v":1,"spends":1,"parked":[],"settling":[{{"spend":2,"spent_at":5,"coins":[{{"coin":"{one}"}}],"bundle":"{empty_bundle}"}}]}}"#),
            format!(r#"{{"v":1,"spends":1,"parked":[{{"coin":"{one}","spend":1}}],"settling":[{{"spend":1,"spent_at":5,"coins":[{{"coin":"{one}"}}],"bundle":"{empty_bundle}"}}]}}"#),
            format!(r#"{{"v":1,"spends":1,"parked":[],"settling":[{{"spend":1,"spent_at":5,"coins":[],"bundle":"{empty_bundle}"}}]}}"#),
            format!(r#"{{"v":1,"spends":1,"parked":[],"settling":[{{"spend":1,"spent_at":0,"coins":[{{"coin":"{one}"}}],"bundle":"{empty_bundle}"}}]}}"#),
            format!(r#"{{"v":1,"spends":1,"parked":[],"settling":[{{"spend":1,"spent_at":5,"coins":[{{"coin":"{one}"}}],"bundle":"zz"}}]}}"#),
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
    fn a_settling_spend_is_parked_again_or_settled_by_the_listings_judged_height() {
        // #272 review round 10: the pure judgment behind the lease's settling set.
        use crate::chia_knock::SETTLED_DEPTH;
        use SettlingStep::*;
        let d = SETTLED_DEPTH;
        let one = |spent: Option<bool>| vec![(spent, Some(900u32))];
        let spent_at = |h: u32| (Some(h), one(Some(true)));
        // Unspent again.
        assert_eq!(settling_step(1000, None, &one(Some(false)), Some(1000), Some(1000)), Repark, "unspent, judged at the spend itself: the block is gone");
        assert_eq!(settling_step(1000, None, &one(Some(false)), Some(1000), None), Repark, "cut short or not: the coin is named");
        assert_eq!(settling_step(1000, None, &one(Some(false)), Some(999), Some(999)), Keep, "peers behind the spend list it unspent and prove nothing");
        assert_eq!(settling_step(1000, None, &one(Some(false)), None, None), Keep, "undated: nothing is said");
        // Spent where the record says.
        let (cur, inputs) = spent_at(1000);
        assert_eq!(settling_step(1000, cur, &inputs, Some(1000 + d - 1), None), Keep, "spent, not deep enough");
        assert_eq!(settling_step(1000, cur, &inputs, Some(1000 + d), None), Done(true), "spent SETTLED_DEPTH deep at the judged height: final, cut short or not");
        assert_eq!(settling_step(1000, cur, &inputs, None, None), Keep, "undated: no depth is proved");
        // Spent in ANOTHER block (round 11): a reorganization moved the spend
        // with no tick in between seeing the inputs unspent. The record moves,
        // and the depth is measured from the block that holds the spend now.
        let (cur, inputs) = spent_at(1031);
        assert_eq!(settling_step(1000, cur, &inputs, Some(1032), Some(1032)), Reclock(1031), "deep from the first inclusion, one block from the new: moved, not settled");
        assert_eq!(settling_step(1000, cur, &inputs, Some(1031 + d - 1), None), Reclock(1031));
        assert_eq!(settling_step(1000, cur, &inputs, Some(1031 + d), None), Done(true), "deep from the block that holds it now");
        assert_eq!(settling_step(1031, cur, &inputs, Some(1031 + d - 1), None), Keep, "already re-clocked: nothing new");
        // Absent.
        assert_eq!(settling_step(1000, None, &one(None), Some(950), Some(950)), Done(false), "on no chain the peers know, past the coin's own confirmation");
        assert_eq!(settling_step(1000, None, &one(None), Some(950), None), Keep, "absent from a listing cut short: nothing is said");
        assert_eq!(settling_step(1000, None, &one(None), Some(899), Some(899)), Keep, "absent below its confirmation: peers behind it");
        assert_eq!(settling_step(1000, None, &[(None, None)], Some(5000), Some(5000)), Keep, "no height known for the coin: never freed on silence");
        // Several inputs.
        assert_eq!(settling_step(1000, Some(1000), &[(Some(true), Some(900)), (Some(false), Some(900))], Some(1000), Some(1000)), Repark, "one input back unspent: parked again, the probe decides");
        assert_eq!(settling_step(1000, Some(1005), &[(Some(true), Some(900)), (Some(false), Some(900))], Some(5000), Some(5000)), Repark, "however deep the other stands, and wherever it moved");
        assert_eq!(settling_step(1000, Some(1000), &[(Some(true), Some(900)), (None, Some(900))], Some(1000 + d), Some(1000 + d)), Done(false), "one spent deep, one on no chain: nothing left to settle");
        assert_eq!(settling_step(1000, Some(1000), &[(Some(true), Some(900)), (None, Some(900))], Some(1000 + d), None), Keep, "the absent one unjudged by a listing cut short");
        assert_eq!(settling_step(1000, None, &[], Some(5000), Some(5000)), Keep, "no inputs: nothing to judge");
    }

    #[tokio::test]
    async fn the_lease_holds_a_spend_by_number_while_parked_or_settling() {
        // #272 review round 12: a knock or beacon verdict reads its input
        // spent with no child under the hint as the coin's going to ANOTHER
        // spend of ours — but the two lookups behind it are separate requests,
        // and a reorganization between them lists the input spent by the
        // write's OWN spend while the hint's listing, on the new fork, lacks
        // its child. The writer keeps the lease's number for its spend, and
        // while the lease holds that number (parked, or settling) the write is
        // pending, never dead: the lease pushes the spend again.
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use crate::chia_knock::SETTLED_DEPTH;
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-holds-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let ours = Coin::new(Bytes32::new([4u8; 32]), Bytes32::new([2u8; 32]), 7);
        let id = ours.coin_id();
        let listing = |spent: Option<u32>, judged_at: Option<u32>| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: ours.clone(), confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at,
            }])
        };
        let bundle = SpendBundle::new(vec![], Signature::default());
        let t0 = Instant::now();
        let lease = WalletLease::new();
        lease.restore(&path);
        assert!(!lease.holds_spend(1) && lease.spend_of(&id).is_none(), "nothing parked: no spend is held");
        let parking = lease.park_with_bundle_at([(id, 900)], Some(&bundle), t0).unwrap();
        let n = parking.spend;
        assert_eq!(lease.spend_of(&id), Some(n), "the writer learns its spend's number from the parking");
        assert!(lease.holds_spend(n) && !lease.holds_spend(n + 1));
        // Included: released as spent, settling — still held.
        let t1 = t0 + RECONCILE_GRACE;
        lease.reconcile_at(&listing(Some(1000), Some(1001)), t1).await;
        assert!(lease.is_settling(&id) && lease.holds_spend(n));
        assert_eq!(lease.spend_of(&id), None, "settling is not parked");
        // Across a restart, by the same number.
        let again = WalletLease::new();
        again.restore(&path);
        assert!(again.holds_spend(n), "the number outlives the restart with the settling record");
        // The block gone: parked again under its number — held.
        again.reconcile_at(&listing(None, Some(1000)), t1).await;
        assert!(again.is_parked(&id) && again.holds_spend(n));
        assert_eq!(again.spend_of(&id), Some(n));
        // Landed anew and settled SETTLED_DEPTH deep: forgotten — held no more.
        let t2 = t1 + RECONCILE_GRACE;
        again.reconcile_at(&listing(Some(1005), Some(1006)), t2).await;
        assert!(again.holds_spend(n));
        again.reconcile_at(&listing(Some(1005), Some(1005 + SETTLED_DEPTH)), t2).await;
        assert!(!again.holds_spend(n) && !again.is_taken(&id));
        // A spend released on the peers' refusal is held no more either.
        let other = WalletLease::new();
        let p = other.park_with_bundle_at([(id, 900)], Some(&bundle), t0).unwrap();
        assert!(other.holds_spend(p.spend));
        other.release(&[p.spend]);
        assert!(!other.holds_spend(p.spend) && other.spend_of(&id).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_spent_spend_keeps_its_bundle_settling_and_is_parked_again_when_its_block_goes() {
        // #272 review round 10: the chain listed a knock's input spent, the
        // lease released the spend and forgot its bundle; a reorganization
        // then dropped the block, the knock returned to pending with nothing
        // left to push it again, and the freed coin was the next writer's to
        // take while the mempool may have taken the spend back.
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use crate::chia_knock::SETTLED_DEPTH;
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-settling-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let ours = Coin::new(Bytes32::new([1u8; 32]), Bytes32::new([2u8; 32]), 7);
        let id = ours.coin_id();
        let listing = |spent: Option<u32>, judged_at: Option<u32>| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: ours.clone(), confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at,
            }])
        };
        let empty = |truncated: bool, judged_at: Option<u32>| Scripted::new(vec![CoinListing { records: vec![], truncated, next_cursor: None, judged_at }]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        let t0 = Instant::now();
        let lease = WalletLease::new();
        lease.restore(&path);
        let parking = lease.park_with_bundle_at([(id, 900)], Some(&bundle), t0).unwrap();
        assert!(lease.is_taken(&id));
        // Past the grace the chain lists the input spent at 1000: the spend is
        // released as spent — its coin no longer parked, the wallet not
        // spending — but kept SETTLING with its bundle, in the file, and its
        // coin is no writer's to take.
        let t1 = t0 + RECONCILE_GRACE;
        lease.reconcile_at(&listing(Some(1000), Some(1001)), t1).await;
        assert!(!lease.is_parked(&id) && lease.is_settling(&id) && lease.is_taken(&id));
        assert_eq!(lease.lease_word(&id), LeaseWord::Spent);
        assert!(!lease.outgoing_pending(), "settling is not spending: the wallet's next coin is the one the spend created");
        let on_disk = || serde_json::from_slice::<LeaseFile>(&std::fs::read(&path).unwrap()).unwrap();
        let file = on_disk();
        assert!(file.parked.is_empty() && file.bundles.is_empty());
        assert_eq!(file.settling.len(), 1);
        assert_eq!((file.settling[0].spend, file.settling[0].spent_at, file.settling[0].coins[0].seen_at), (parking.spend, 1000, Some(900)));
        // Across a restart the settlement is still open, with the word.
        let again = WalletLease::new();
        again.restore(&path);
        assert!(again.is_settling(&id) && !again.is_parked(&id) && again.is_taken(&id));
        assert_eq!(again.lease_word(&id), LeaseWord::Spent, "the word outlives the restart");
        // Peers behind the spend list the input unspent, an undated listing
        // lists it so, a listing finds it spent but not deep enough, a listing
        // cut short leaves it out: nothing is decided by any of them.
        again.reconcile_at(&listing(None, Some(999)), t1).await;
        again.reconcile_at(&listing(None, None), t1).await;
        again.reconcile_at(&listing(Some(1000), Some(1000 + SETTLED_DEPTH - 1)), t1).await;
        again.reconcile_at(&empty(true, Some(5000)), t1).await;
        assert!(again.is_settling(&id) && !again.is_parked(&id));
        // Unspent on a listing judged at the spend: the block is gone. The
        // spend is parked again under its own number, with its bundle, due
        // after a fresh grace for the liveness probe to push it again; the
        // coin stays no writer's to take.
        again.reconcile_at(&listing(None, Some(1000)), t1).await;
        assert!(again.is_parked(&id) && !again.is_settling(&id) && again.is_taken(&id));
        assert_eq!(again.lease_word(&id), LeaseWord::Parked);
        assert!(again.outgoing_pending());
        assert!(again.due_at(t1).is_empty(), "a fresh grace");
        let due = again.due_at(t1 + RECONCILE_GRACE);
        assert_eq!(due.len(), 1);
        assert_eq!((due[0].spend, due[0].bundle.as_ref().map(|b| b.name())), (parking.spend, Some(bundle.name())));
        let file = on_disk();
        assert_eq!((file.parked.len(), file.bundles.len(), file.settling.len()), (1, 1, 0));
        assert_eq!((file.parked[0].spend, file.bundles[0].spend), (parking.spend, parking.spend));
        // Landed again, in another block: settling anew from that height …
        let t2 = t1 + RECONCILE_GRACE;
        again.reconcile_at(&listing(Some(1005), Some(1006)), t2).await;
        assert!(again.is_settling(&id) && !again.is_parked(&id));
        assert_eq!(on_disk().settling[0].spent_at, 1005);
        // … moved to yet another block by a reorganization no tick saw the
        // input unspent in between (round 11): the record follows, in the file
        // too, and a listing deep enough from the OLD height settles nothing …
        again.reconcile_at(&listing(Some(1020), Some(1021)), t2).await;
        assert!(again.is_settling(&id) && !again.is_parked(&id));
        assert_eq!(on_disk().settling[0].spent_at, 1020, "re-clocked to the block that holds it now");
        again.reconcile_at(&listing(Some(1020), Some(1005 + SETTLED_DEPTH)), t2).await;
        assert!(again.is_settling(&id), "deep from the first inclusion, shallow from the block that holds it: still settling");
        // … across a restart …
        let third = WalletLease::new();
        third.restore(&path);
        assert!(third.is_settling(&id) && !third.is_parked(&id));
        assert_eq!(third.lease_word(&id), LeaseWord::Spent);
        // … and found spent SETTLED_DEPTH deep from there, at the listing's own height: final.
        third.reconcile_at(&listing(Some(1020), Some(1020 + SETTLED_DEPTH)), t2).await;
        assert!(!third.is_settling(&id) && !third.is_parked(&id) && !third.is_taken(&id));
        assert_eq!(third.lease_word(&id), LeaseWord::Spent, "this run remembers the settlement");
        assert!(on_disk().settling.is_empty());
        // A settling spend whose input is on no chain the peers know — absent
        // from a complete listing judged past the coin's own confirmation — has
        // nothing left to settle or to push: forgotten.
        let other = WalletLease::new();
        other.park_with_bundle_at([(id, 900)], Some(&bundle), t0).unwrap();
        other.reconcile_at(&listing(Some(1000), Some(1001)), t1).await;
        assert!(other.is_settling(&id));
        other.reconcile_at(&empty(false, Some(899)), t1).await;
        assert!(other.is_settling(&id), "absent below its confirmation: peers behind it");
        other.reconcile_at(&empty(false, Some(950)), t1).await;
        assert!(!other.is_settling(&id) && !other.is_parked(&id));
        // A spend released as spent WITHOUT a bundle (parked by an older node)
        // has nothing to push again: forgotten at the release, as before.
        let bare = WalletLease::new();
        bare.park_at([(id, 900)], t0).unwrap();
        bare.reconcile_at(&listing(Some(1000), Some(1001)), t1).await;
        assert!(!bare.is_settling(&id) && !bare.is_parked(&id));
        assert_eq!(bare.lease_word(&id), LeaseWord::Spent);
        // A coin a LATER spend took meanwhile keeps that spend's marker when
        // the older spend is parked again (compare-and-release); an older
        // spend none of whose coins is free again is forgotten, bundle and all.
        let raced = WalletLease::new();
        let old = raced.park_with_bundle_at([(id, 900)], Some(&bundle), t0).unwrap();
        raced.reconcile_at(&listing(Some(1000), Some(1001)), t1).await;
        let newer = raced.park_with_bundle_at([(id, 900)], Some(&bundle), t1).unwrap();
        assert!(raced.is_parked(&id) && raced.is_settling(&id));
        raced.reconcile_at(&listing(None, Some(1000)), t1).await;
        assert!(raced.is_parked(&id) && !raced.is_settling(&id));
        let due = raced.due_at(t1 + RECONCILE_GRACE);
        assert_eq!(due.iter().map(|d| d.spend).collect::<Vec<u64>>(), vec![newer.spend], "the newer marker stands");
        assert!(old.spend < newer.spend && !raced.snapshot().bundles.iter().any(|b| b.spend == old.spend), "no bundle parks no coin");
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
