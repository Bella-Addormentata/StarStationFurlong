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
//! Behind the `chia-publish` feature; runtime-gated by the SSF wallet switch at the
//! caller (chia_wallet_switch.rs: the Bank's TURN ON, or `SSF_CHIA_LANE=1`).
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
use chia_sdk_types::Conditions;
use clvmr::Allocator;
use serde::{Deserialize, Serialize};

use crate::chia_contact::InboundVerified;
use crate::chia_knock::{KnockBook, KnockRequest, SentKnock};
use crate::chia_resolve::{LeaseWord, WriteCoins};
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
/// written to `wallet_lease.json` beside the wallet's identity, and the next run
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
///
/// Every parking records WHO PAYS for its spend (stage 4 design §4.4): its
/// [`Payer`], kept beside the spend's bundle and written with it. The wait
/// the lease imposes exists so that one payer never has two records for one
/// era in flight, and that reason holds per payer, not across them:
/// [`WalletLease::outgoing_pending_for`] asks it of one payer's spends. Every
/// writer of this build still asks the global
/// [`WalletLease::outgoing_pending`]; the burner writers (design §13, PRs 9
/// and 10) are the first to ask per payer.
pub struct WalletLease {
    gate: tokio::sync::Mutex<()>,
    pending: std::sync::Mutex<HashMap<Bytes32, Parked>>,
    /// The spend bundle each parked spend pushed, and who pays for it, by
    /// spend number: what the liveness question hands the peers again
    /// (`ChainAccess::spend_live`), since the peer protocol has no mempool
    /// query (plan §14 (6)). Attached in the same write as the parking
    /// ([`WalletLease::park_with_bundle`]).
    bundles: std::sync::Mutex<HashMap<u64, Pushed>>,
    incoming: std::sync::Mutex<Option<Bytes32>>,
    /// The money address's payer, as [`WalletLease::restore`] was told: whose
    /// a parking with no payer recorded is (stage 4 design §4.4). `None` until
    /// a restore names it; such a parking then counts for every payer.
    money: std::sync::Mutex<Option<Payer>>,
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
    /// Who pays for the spend, as it was parked ([`Pushed`]): it goes back
    /// into the parking with the bundle should the block go.
    payer: Option<Payer>,
}

/// Who pays for a spend the lease parks (stage 4 design §4.4): the puzzle
/// hash of the key that signs the spend and pays for it, the address that
/// key's coins are locked to ([`our_puzzle_hash`]). It is the key whose next
/// write must wait for this spend, not the address of an input: a TAKE's
/// input is the dish's coin and its payer the money address it pays into
/// (`chia_faucet`'s claim), and a burner's first write spends a dish coin
/// and the gift g with the burner as its payer ([`Payer::of_burner`]).
///
/// Outside this module a `Payer` comes from a key alone ([`Payer::of`] for
/// a wallet key, [`Payer::of_burner`] for a burner's):
/// there is no `Default`, no `From<Bytes32>` and no public constructor from
/// bytes, so a coin id or a hint, `Bytes32`s both, can never be passed as a
/// payer by mistake. The lease builds one from the hex its own file holds. It
/// holds a puzzle hash only, which is public, and its `Debug` shows that hash
/// and nothing else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Payer(Bytes32);

impl Payer {
    /// The payer `key` is: the standard puzzle hash of its synthetic key.
    pub fn of(key: &SecretKey) -> Payer {
        Payer(our_puzzle_hash(key))
    }

    /// The payer a burner is: its puzzle hash, the address its 1-mojo coin
    /// sits at, so its writes wait on its own spends alone (stage 4 design
    /// §4.4). It lives here, not in `chia_burner`, whose pin scan lists every
    /// line there that builds a key or reads its secret; this one asks the
    /// key for its public puzzle hash alone, so that list stays as it is.
    pub fn of_burner(key: &crate::chia_burner::BurnerKey) -> Payer {
        Payer(key.puzzle_hash())
    }

    /// The puzzle hash, hex, as the lease file writes it and the marks file
    /// it: the presence mark, the beacon mark and a knock entry name their
    /// write's payer by this text (stage 4 design §4.4); the hint rule (§8.3,
    /// PR 10) compares the presence mark's as text. Read-only on purpose: no mark parses
    /// it back into a `Payer`, since outside this module that would be a new
    /// constructor from bytes.
    pub fn hex(&self) -> String {
        hex::encode(self.0)
    }
}

/// What a parked spend pushed, and who pays for it (see [`WalletLease`]'s
/// `bundles`). One record, so the payer goes wherever the bundle goes: in
/// with the parking, out with its release, into settling and back. `payer`
/// is `None` for a spend an older node parked, whose file named none: such a
/// spend is the money address's (stage 4 design §4.4).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Pushed {
    bundle: SpendBundle,
    payer: Option<Payer>,
}

/// A write the lease holds under a hint ([`WalletLease::held_writes_under`]):
/// the coins it is judged by (stage 4 design §4.4), the lease's number for
/// its spend, the record its coin carries, the payer filed for the spend
/// (`None`: none was filed, which is the money address's), and the height
/// the chain listed its inputs spent at once it is settling (`None` while it
/// is parked).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HeldWrite {
    pub coins: WriteCoins,
    pub spend: u64,
    pub record: Vec<u8>,
    pub payer: Option<Payer>,
    pub spent_at: Option<u32>,
}

impl HeldWrite {
    /// The write spend number `spend` makes under `hint` with `bundle`, its
    /// parked inputs `inputs`, or `None` if no spend in the bundle makes a
    /// coin carrying the hint and a record. Its parent is the coin whose spend
    /// makes that coin, which the coin names; its parked input is the first
    /// coin the bundle spends that the lease holds for it: the same coin for
    /// a write from one coin, the dish coin F for a burner's first write,
    /// whose parent is the gift g (§4.1).
    fn of(spend: u64, inputs: &[Bytes32], bundle: &SpendBundle, payer: Option<Payer>, spent_at: Option<u32>, hint: Bytes32) -> Option<HeldWrite> {
        let (parent, record) = bundle.coin_spends.iter().find_map(|cs| {
            let run = crate::chia_chain::PuzzleAndSolution { puzzle_reveal: cs.puzzle_reveal.clone(), solution: cs.solution.clone() };
            let record = crate::chia_resolve::extract_ciphertext(&run, hint).ok().flatten()?;
            Some((cs.coin.coin_id(), record))
        })?;
        let parked = bundle.coin_spends.iter().map(|cs| cs.coin.coin_id()).find(|id| inputs.contains(id))?;
        Some(HeldWrite { coins: WriteCoins { parent, parked }, spend, record, payer, spent_at })
    }
}

/// Does `bundle` spend a coin at `puzzle_hash`? What
/// [`WalletLease::parks_spend_at`] asks of each saved bundle.
fn spends_at(bundle: &SpendBundle, puzzle_hash: Bytes32) -> bool {
    bundle.coin_spends.iter().any(|cs| cs.coin.puzzle_hash == puzzle_hash)
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
    /// Who pays for it, as parked (`None`: no payer recorded, as for every
    /// spend an older node parked): carried into settling with the bundle
    /// when the spend is released as spent, and read nowhere else.
    pub payer: Option<Payer>,
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
    /// Who pays for the spend, as on [`ParkedBundle`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payer: Option<String>,
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
    /// Who pays for the spend: its [`Payer`]'s puzzle hash, hex (stage 4
    /// design §4.4). Absent in files older nodes wrote, whose spends are the
    /// money address's. The file stays version 1: no record of it denies
    /// unknown fields, so an older node reads the file and skips this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    payer: Option<String>,
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

/// A payer as the lease file writes it ([`Payer::hex`]): `Ok(None)` when the
/// entry names none, as no entry an older node wrote does; `Err` with the
/// text when it is not 32 bytes of hex.
fn parse_payer(hex_payer: Option<&str>) -> Result<Option<Payer>, &str> {
    match hex_payer {
        None => Ok(None),
        Some(text) => parse_coin_id(text).map(|ph| Some(Payer(ph))).ok_or(text),
    }
}

/// The process-wide lease: one wallet per node, so one lease.
pub static WALLET_LEASE: std::sync::LazyLock<WalletLease> = std::sync::LazyLock::new(WalletLease::new);

/// Whether the lobby dish reads a spend from the SSF wallet as still
/// confirming (`chia_faucet::FaucetStatus::spending`, which keeps the
/// browser's GIVING… pending and words the note). With burner keys off
/// (`burners` false) it is any spend `lease` parks but a claim's
/// ([`WalletLease::outgoing_pending`]), as it always was. With them on
/// (stage 4 design §4.4) it is the spends the wallet's payer `money` pays
/// for ([`WalletLease::outgoing_pending_for`]), a spend with no payer
/// recorded among them. What decides is the payer, not the input: the
/// listing's spends from P(e) (its first write's lobby dish coin, its
/// rewrites' own coin), each knock's from its own key K(h) (the lobby dish
/// coin its one write claims, or a lone coin at K(h) it writes from), and
/// the beacon's from its own wallet B are not the wallet's, and a GIVE
/// spends the wallet's own free coins, picked under the lease, so giving
/// never waits on them.
pub fn wallet_spending(lease: &WalletLease, money: Payer, burners: bool) -> bool {
    if burners {
        lease.outgoing_pending_for(money)
    } else {
        lease.outgoing_pending()
    }
}

impl WalletLease {
    pub fn new() -> Self {
        Self {
            gate: tokio::sync::Mutex::new(()),
            pending: std::sync::Mutex::new(HashMap::new()),
            bundles: std::sync::Mutex::new(HashMap::new()),
            incoming: std::sync::Mutex::new(None),
            money: std::sync::Mutex::new(None),
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
    /// which saves the bundle and its payer in the same write; the
    /// bundle-less form, which records no payer either (an older node's
    /// parking), serves the lease tests.
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
    /// until an outside spend settled them. The spend's `payer` (stage 4
    /// design §4.4) goes into the same write, beside the bundle. `Err` means
    /// nothing is parked or kept and the spend must not leave.
    pub fn park_with_bundle<I: Into<ParkedInput>>(
        &self,
        coin_ids: impl IntoIterator<Item = I>,
        bundle: &SpendBundle,
        payer: Payer,
    ) -> Result<Parking, LeaseError> {
        self.park_with_bundle_at(coin_ids, Some((bundle, payer)), Instant::now())
    }

    /// [`WalletLease::park_with_bundle`] at a given instant; `pushed` is the
    /// bundle and its payer, which a parking keeps together or not at all
    /// (none: the tests' bare parking, an older node's).
    fn park_with_bundle_at<I: Into<ParkedInput>>(
        &self,
        coin_ids: impl IntoIterator<Item = I>,
        pushed: Option<(&SpendBundle, Payer)>,
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
        if let Some((bundle, payer)) = pushed {
            self.bundles.lock().unwrap().insert(spend, Pushed { bundle: bundle.clone(), payer: Some(payer) });
        }
        if let Err(e) = self.persist() {
            // Not saved, so not sent: take the parking and its bundle (with its
            // payer) back whole (by the spend number, as a rejection would) and
            // let the caller refuse the spend. The number is used up, so no
            // later spend shares it.
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

    /// Does the TAKE marker name `coin`, whether or not a spend still parks
    /// it? It only reads. [`WalletLease::incoming_pending`] is what clears
    /// the marker, and only when it next runs, so a TAKE the peers refused or
    /// the mempool dropped can leave the marker naming a dish coin that is
    /// free again, one [`WalletLease::is_taken`] no longer names. A burner
    /// that parked that coin would read to `incoming_pending` as the TAKE's
    /// gift still landing, and to [`WalletLease::outgoing_pending`] as no
    /// spend of ours. So the claim-and-write leaves the marker's coin alone,
    /// as it leaves a taken coin alone, and the marker stays as it is, for
    /// testnet TAKE (stage 4 design §4.4).
    pub fn is_incoming_marker(&self, coin: &Bytes32) -> bool {
        *self.incoming.lock().unwrap() == Some(*coin)
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

    /// A spend paid by `payer` is still settling: a coin is parked by a spend
    /// whose payer is `payer` (stage 4 design §4.4), the question of
    /// [`WalletLease::outgoing_pending`] asked of one payer's spends. A spend
    /// with no payer recorded (one an older node parked, or a test's bare
    /// parking) is the money address's, the one [`WalletLease::restore`]
    /// named; until a restore names it, such a spend counts for every payer,
    /// fail closed, as the global check counts it. A SETTLING spend counts no
    /// more than it does there: its coins are spent in a block and the payer's
    /// next coin is the one it created; a reorganization that drops the block
    /// parks it again, and then it counts.
    ///
    /// The faucet coin a claim spent (the `incoming` marker) is left out, as
    /// the global check leaves it out, but only while the spend parking it is
    /// the money address's or names no payer, as every TAKE's does (its payer
    /// is the money address it pays into). The marker is cleared only when
    /// [`WalletLease::incoming_pending`] next reads it, so once the peers
    /// refused a TAKE or the mempool dropped it, the marker can still name a
    /// dish coin that is free again, and a spend that parks that coin under
    /// another payer counts for that payer. With the money address named and
    /// every payer it or none, this is `outgoing_pending` exactly.
    ///
    /// It can under-report a payer whose record was lost. Coins are only ever
    /// over-parked, but a payer can be lost, and then the money address
    /// over-holds while the payer that really paid under-holds: an older node
    /// rewrote the file without payers (a rollback, design §8 (6)); a save
    /// left out a bundle the wire could not encode, and its payer with it
    /// ([`WalletLease::snapshot`]); or an older node parked the spend before
    /// payers were filed, as it parked every beacon spend. So it must never be
    /// a writer's only guard: the writer keeps a second one, its own mark's
    /// gating or a bundle of its own recognised by its outputs, and the coins
    /// [`WalletLease::is_taken`] holds stay out of its reach whatever this
    /// says. Callers hold the gate after a reconciliation, as
    /// [`publish_memo_on`] does around the global check.
    ///
    /// The claim-and-write's writer asks it of the burner it writes for
    /// (`claim_write::burner_write_with`, design §13 row 9): before any
    /// write, and through [`WalletLease::holds_for`] before a gift. The
    /// listing's writer from P(e) (row 10, [`publish_node_presence_with`])
    /// is that writer, and asks it of P(e) so, and of the SSF wallet's payer
    /// as well before P(e)'s first write (`claim_write::BurnerWait::MoneyInFlight`).
    /// The knock's writer from K(h) ([`publish_knock_with`],
    /// `claim_write::knock_write_with`) asks it of K(h)'s payer alone; the
    /// beacon writer of row 10 will ask it too. Its second guard is the
    /// burner's own puzzle hash, which no payer record can lose: a saved
    /// bundle that spends a coin there ([`WalletLease::parks_spend_at`],
    /// [`WalletLease::holds_spend_at`]), and a 1-mojo coin there that the
    /// lease holds. A stale marker is kept off a burner's parking, since
    /// `incoming_pending` reads the marker's coin alone and would read a
    /// burner's parking of it as a gift still landing: that writer never
    /// lets a burner claim the marker's coin
    /// ([`WalletLease::is_incoming_marker`]), so the lease file gains no
    /// field for it.
    pub fn outgoing_pending_for(&self, payer: Payer) -> bool {
        let incoming = *self.incoming.lock().unwrap();
        let money = *self.money.lock().unwrap();
        let pending = self.pending.lock().unwrap();
        let pushed = self.bundles.lock().unwrap();
        pending.iter().any(|(id, parked)| {
            let paid_by = pushed.get(&parked.spend).and_then(|p| p.payer).or(money);
            let landing = Some(*id) == incoming && (paid_by.is_none() || paid_by == money);
            !landing && paid_by.is_none_or(|recorded| recorded == payer)
        })
    }

    /// Does the lease hold a spend paid by `payer`, parked or settling? It is
    /// the gift rule's question (stage 4 design §5.2: a key is funded only
    /// while no bundle for it is held). Parked spends are asked through
    /// [`WalletLease::outgoing_pending_for`]. A settling spend counts when
    /// its payer is `payer`, and one with no payer recorded counts as a
    /// parked one does there: the money address's, or every payer's until a
    /// restore names it. A rewrite waits on parked spends alone, since a
    /// settling write's coin is the one it writes from next; a gift waits on
    /// settling ones too. If a stranger's claim of the dish coin lands where
    /// ours would have, the lease reads our bundle's input as spent and keeps
    /// the bundle settling, while the burner holds no coin. That bundle is
    /// judged dead only once the dish coin is settled SETTLED_DEPTH deep, and
    /// only then is the key funded again (§10, a lost race), never while a
    /// reorganization could still bring our bundle back.
    pub fn holds_for(&self, payer: Payer) -> bool {
        if self.outgoing_pending_for(payer) {
            return true;
        }
        let money = *self.money.lock().unwrap();
        self.settling.lock().unwrap().values().any(|s| s.payer.or(money).is_none_or(|recorded| recorded == payer))
    }

    /// Does a parked spend's saved bundle spend a coin at `puzzle_hash`? A
    /// burner's every bundle spends exactly one coin at the burner's puzzle
    /// hash (R1, stage 4 design §4.2): g for a first write, the burner's own
    /// coin for a rewrite. So this recognises a burner's write in flight by
    /// the bundle itself, whatever payer was filed for it or lost since
    /// ([`WalletLease::outgoing_pending_for`] names the ways one is lost),
    /// and the burner writer waits on it as on its payer's parked spends. A
    /// parked spend whose bundle was not saved is not seen here; its coins
    /// still are, by [`WalletLease::is_taken`].
    pub fn parks_spend_at(&self, puzzle_hash: Bytes32) -> bool {
        let pending = self.pending.lock().unwrap();
        let pushed = self.bundles.lock().unwrap();
        pending.values().any(|parked| pushed.get(&parked.spend).is_some_and(|p| spends_at(&p.bundle, puzzle_hash)))
    }

    /// [`WalletLease::parks_spend_at`], or a settling spend's bundle spends a
    /// coin at `puzzle_hash`: the gift rule's question asked of the burner's
    /// puzzle hash rather than of its payer (stage 4 design §5.2, a key is
    /// funded only while no bundle for it is held), as
    /// [`WalletLease::holds_for`] asks it of the payer. A settling spend
    /// always keeps its bundle, so none is missed.
    pub fn holds_spend_at(&self, puzzle_hash: Bytes32) -> bool {
        self.parks_spend_at(puzzle_hash) || self.settling.lock().unwrap().values().any(|s| spends_at(&s.bundle, puzzle_hash))
    }

    /// The writes the lease holds under `hint`, newest first, parked with
    /// their saved bundles or settling: the spends whose bundles make a coin
    /// carrying `hint` as its first memo and a record beside it, as every
    /// memo write does ([`crate::chia_resolve::extract_ciphertext`]). The
    /// lease saves a spend's bundle and payer in the same write as its
    /// parking, before the push, and keeps a settling spend's until the
    /// chain settles it [`crate::chia_knock::SETTLED_DEPTH`] deep, so a
    /// write is found here for that long whatever became of the mark or the
    /// knock entry that filed it ([`lost_listing_mark`], [`lost_knock_entry`]).
    /// A parked spend whose bundle was not saved is not seen, and neither is
    /// one the lease has forgotten. One inbox hint can hold more than one
    /// write: the knocks to two hosts whose cards name one contact key are
    /// written under one hint, each from a key of its own ([`knock_slot`]),
    /// so the knock's filing is given them all, files this host's own first
    /// on either path, and otherwise the newest of the other payer's it must
    /// not write beside ([`lost_knock_entry`]).
    ///
    /// They are read under the lease's gate ([`Self::lock`]), taken for the
    /// whole read and given back before it returns. The lease keeps a spend
    /// in one of two maps, the parking or the settling spends, and moves it
    /// from one to the other a map at a time: a reconciliation that finds a
    /// settling spend's block gone takes it out of the settling spends
    /// before it parks it again ([`Self::retire`]). The lobby dish's
    /// handlers reconcile on their own tasks beside the heartbeat, so a read
    /// of the two maps without the gate could fall between the two steps
    /// and miss a write the lease holds, and the writer it is asked for
    /// would then write beside it under the same hint (stage 4 design §8.3).
    /// Under the gate the read is one view of the lease, since every change
    /// to the parking while the node runs is made under it: every caller of
    /// [`push_parked_with`] but the lease's own tests parks and hands back
    /// under it, every reconciliation, and so every [`Self::retire`], runs
    /// under it, and the restore when the wallet is turned on takes it. The
    /// restore at startup does not, and runs before the heartbeat and the
    /// watcher are started. Once the gate is given back the view can only
    /// age, and for the callers here that is enough. Between this read and
    /// their writer taking the gate again, nothing parks a write under a
    /// listing's or a knock's hint but the heartbeat, which is the caller
    /// and writes one at a time, and a reconciliation only moves or forgets
    /// the spends the view saw. So no write the view missed is held when the
    /// writer is asked. The gate is a `tokio` mutex, which is not reentrant:
    /// a caller that already holds it would wait on itself here forever, so
    /// it reads through [`Self::held_writes_under_locked`] instead.
    pub(crate) async fn held_writes_under(&self, hint: Bytes32) -> Vec<HeldWrite> {
        let _gate = self.lock().await;
        self.held_writes_under_locked(hint)
    }

    /// The newest of the writes the lease holds under `hint`
    /// ([`Self::held_writes_under`]), read the same way, under the lease's
    /// gate, which the caller must not hold: the listing's lookup
    /// ([`lost_listing_mark`]), since only this node's listing writes under
    /// its hint.
    pub(crate) async fn held_write_under(&self, hint: Bytes32) -> Option<HeldWrite> {
        self.held_writes_under(hint).await.into_iter().next()
    }

    /// [`Self::held_writes_under`]'s read, for a caller that holds the
    /// lease's gate ([`Self::lock`]): the read is one view of the lease only
    /// under the gate, since it reads the parking and the settling spends
    /// one after the other.
    fn held_writes_under_locked(&self, hint: Bytes32) -> Vec<HeldWrite> {
        // A spend's number, the inputs the lease parks for it, its bundle,
        // its payer, and the height the chain spent it at once it settles.
        type Held = (u64, Vec<Bytes32>, SpendBundle, Option<Payer>, Option<u32>);
        let mut held: Vec<Held> = Vec::new();
        {
            let pending = self.pending.lock().unwrap();
            let pushed = self.bundles.lock().unwrap();
            for (spend, p) in pushed.iter() {
                let inputs: Vec<Bytes32> = pending.iter().filter(|(_, parked)| parked.spend == *spend).map(|(id, _)| *id).collect();
                if !inputs.is_empty() {
                    held.push((*spend, inputs, p.bundle.clone(), p.payer, None));
                }
            }
        }
        for (spend, s) in self.settling.lock().unwrap().iter() {
            held.push((*spend, s.coins.iter().map(|c| c.coin_id).collect(), s.bundle.clone(), s.payer, Some(s.spent_at)));
        }
        held.sort_by_key(|(spend, ..)| std::cmp::Reverse(*spend));
        held.into_iter().filter_map(|(spend, inputs, bundle, payer, spent_at)| HeldWrite::of(spend, &inputs, &bundle, payer, spent_at, hint)).collect()
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
                let pushed = bundles.get(&spend);
                DueSpend { spend, coins, bundle: pushed.map(|p| p.bundle.clone()), payer: pushed.and_then(|p| p.payer) }
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
    /// grace and their bundle and payer, never over a NEWER marker of the same
    /// coin (a coin a later spend took meanwhile keeps that spend's marker; a
    /// re-parked spend none of whose coins is free again is forgotten, its
    /// bundle and payer with it, so no bundle parks no coin and no payer
    /// outlives its spend); `reclocked` settling spends take the height the chain
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
                    bundles.insert(spend, Pushed { bundle: s.bundle, payer: s.payer });
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
    ///
    /// `money` is the payer of the wallet this file belongs to (stage 4
    /// design §4.4): the file lives beside that wallet's identity and is
    /// restored as the wallet loads, so a parking it holds with no payer
    /// recorded, as every parking an older node wrote, is that wallet's. It
    /// is a puzzle hash, public, and it is named before the file is read, so
    /// a lease the file seals knows it too.
    pub fn restore(&self, path: &std::path::Path, money: Payer) {
        *self.money.lock().unwrap() = Some(money);
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
    /// relies on the numbers being distinct). Every payer a bundle or a
    /// settling spend names is well formed too (stage 4 design §4.4), parsed
    /// in the same check; one that names none is the money address's.
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
            let payer = parse_payer(entry.payer.as_deref()).map_err(|bad| format!("malformed payer {bad:?} for spend #{}", entry.spend))?;
            bundles.push((entry.spend, Pushed { bundle, payer }));
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
            let payer =
                parse_payer(entry.payer.as_deref()).map_err(|bad| format!("malformed payer {bad:?} for settling spend #{}", entry.spend))?;
            settling.push((entry.spend, Settling { coins, spent_at: entry.spent_at, bundle, payer }));
        }
        {
            let mut pending = self.pending.lock().unwrap();
            for (id, spend, seen_at) in &parked {
                pending.entry(*id).or_insert(Parked { at: now, spend: *spend, seen_at: *seen_at });
            }
            let mut kept = self.bundles.lock().unwrap();
            for (spend, pushed) in bundles {
                kept.entry(spend).or_insert(pushed);
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
        // A bundle the wire cannot encode is left out, and its payer with it:
        // its coins stay parked, and after a restart its spend counts as the
        // money address's (see `outgoing_pending_for`, on a payer lost).
        let mut bundles: Vec<ParkedBundle> = self
            .bundles
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(spend, pushed)| {
                pushed.bundle.to_bytes().ok().map(|bytes| ParkedBundle {
                    spend: *spend,
                    bundle: hex::encode(bytes),
                    payer: pushed.payer.map(|p| p.hex()),
                })
            })
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
                    payer: s.payer.map(|p| p.hex()),
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
        self.reconcile_at(crate::chia_network::net(), client, Instant::now()).await
    }

    /// [`WalletLease::reconcile`] on `net` at a given instant (the tests'
    /// network and clock).
    async fn reconcile_at(&self, net: crate::chia_network::ChiaNet, client: &impl ChainAccess, now: Instant) {
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
        //
        // 🛑 Off a test network no saved bundle goes out again (stage 4
        // design §4.5): every spend a lease there can hold is one this build
        // no longer sends, parked by an older build: a memo spend the SSF
        // wallet paid (§4.5 (1)) or a TAKE into it (§4.5 (4), (5)). Its coins
        // stay parked until the chain lists one spent or gone, as for any
        // spend the peers are not asked about.
        let mut in_mempool: HashMap<u64, Option<bool>> = HashMap::new();
        let after = self.probe_cursor.load(std::sync::atomic::Ordering::Relaxed);
        let probes = if net.is_test() { mempool_probes(&due, &spent_on_chain, after) } else { Vec::new() };
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
                Some((d.spend, Settling { coins: d.coins.clone(), spent_at, bundle, payer: d.payer }))
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
                        "⛓️ wallet lease: the block that spent spend #{spend}'s coins at height {} is gone (a reorganization); parked again, {}",
                        s.spent_at,
                        if net.is_test() { "to be pushed again" } else { "for the chain to settle (no spend is sent again here)" }
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
///
/// `payer` is who pays for the spend ([`Payer`], stage 4 design §4.4),
/// parked with it in the same write: the key that signs it, or for the
/// dish's TAKE, which no key signs, the money address it pays into. A
/// required argument with no default, on every way to park outside the
/// tests, so no caller parks a spend without saying whose it is.
pub async fn push_parked<I: Into<ParkedInput>>(
    client: &impl ChainAccess,
    payer: Payer,
    bundle: SpendBundle,
    inputs: impl IntoIterator<Item = I>,
) -> Result<(), PushError> {
    push_parked_with(&WALLET_LEASE, client, payer, bundle, inputs).await
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
    payer: Payer,
    bundle: SpendBundle,
    inputs: impl IntoIterator<Item = I>,
) -> Result<(), PushError> {
    let parking = lease.park_with_bundle(inputs, &bundle, payer).map_err(PushError::NotSent)?;
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
    find_spendable_coin_on(&WALLET_LEASE, client, puzzle_hash).await
}

/// [`find_spendable_coin`] against a given lease: the process-wide one in
/// production, a test's own on the mock chain. The coins skipped are the
/// ones `lease` holds, so a writer on that lease never takes a coin its own
/// spends still hold.
pub async fn find_spendable_coin_on(
    lease: &WalletLease,
    client: &impl ChainAccess,
    puzzle_hash: Bytes32,
) -> Result<Option<crate::chia_faucet::FaucetCoin>> {
    let listing = crate::chia_faucet::unspent_at(client, puzzle_hash).await?;
    let mut coins: Vec<crate::chia_faucet::FaucetCoin> =
        listing.coins.into_iter().filter(|c| !lease.is_taken(&c.coin.coin_id())).collect();
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

/// 🛑 Why the SSF wallet pays for no spend that carries a memo on `net`, or
/// `None` on a test network (stage 4 design §4.5 (1)). A memo spend paid by
/// the wallet makes the money coin the parent of the record, so whoever
/// paid RECEIVE is tied to every listing, knock and beacon it pays for. Off
/// a test network that waits for burner keys funded by the lobby dish; until
/// they land, a mainnet node writes nothing. The text is the player's: the
/// Phone Book row says it after its state, whichever it is (a listing an
/// older build wrote can still be listed, sent or outdated), so it says
/// what this node no longer writes, never whether it is listed.
pub fn money_memo_refusal(net: crate::chia_network::ChiaNet) -> Option<String> {
    (!net.is_test()).then(|| format!("on {} the SSF wallet pays for no Phone Book write, so this node writes no new listing there yet", net.name()))
}

/// The log line for [`money_memo_refusal`], said once per process
/// ([`refuse_money_memo`]).
pub fn money_memo_line(net: crate::chia_network::ChiaNet) -> Option<String> {
    (!net.is_test()).then(|| {
        format!(
            "⛓️ ChiaHub: on {} the SSF wallet pays for no chain write, so this node writes no listing, knock, beacon or room record there until burner keys land. It still reads the chain.",
            net.name()
        )
    })
}

/// What the log says follows a listing the chain voided or a beacon it
/// forgot: written again where the SSF wallet pays for it, nothing off a
/// test network ([`money_memo_refusal`]), where the mark an older build left
/// is still judged.
fn write_again_words(net: crate::chia_network::ChiaNet) -> String {
    match money_memo_refusal(net) {
        None => "writing it again".to_string(),
        Some(_) => format!("nothing is written again on {} (the SSF wallet pays for no chain write there)", net.name()),
    }
}

/// A memo spend refused off a test network: its text is
/// [`money_memo_refusal`]'s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MoneyMemoRefused(pub String);

impl std::fmt::Display for MoneyMemoRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for MoneyMemoRefused {}

/// [`money_memo_refusal`] at a write: `Err` off a test network, and the
/// first refusal in the process logs [`money_memo_line`]. Every spend that
/// carries a memo and is paid by the SSF wallet's keys is built by
/// [`build_publish_bundle`], which asks this first, so none leaves those
/// keys off a test network: presence and knocks (the money key), the beacon
/// (its key comes from the money key), v1 room records and both env test
/// hooks. The second memo builder, a burner's
/// (`claim_write::build_burner_bundle`, stage 4 design §4.2), does not ask
/// it: it signs with a `BurnerKey` alone and has no network check of its
/// own, and nothing reaches it but behind SSF_CHIA_BURNERS=1 on a test
/// network: the claim-and-write's self-test hook and, since PR 10b, the
/// listing written from P(e) (§13 rows 9 and 10). The heartbeat asks it once
/// at its start, so a mainnet node plans no write that would be refused,
/// looks up no coin for one, and says why on the Phone Book row.
pub fn refuse_money_memo(net: crate::chia_network::ChiaNet) -> Result<(), MoneyMemoRefused> {
    static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(why) = money_memo_refusal(net) else { return Ok(()) };
    if !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
        if let Some(line) = money_memo_line(net) {
            println!("{line}");
        }
    }
    Err(MoneyMemoRefused(why))
}

/// Build the SIGNED SpendBundle: spend `coin` back to our own puzzle hash at
/// `amount − fee`, carrying MEMOS = `( hint ciphertext )` (a proper 2-element
/// CLVM list). Signed for `net` with the synthetic BLS key. The builder of
/// every memo spend the SSF wallet's keys pay for, so off a test network it
/// refuses ([`refuse_money_memo`]) before it signs anything. The other memo
/// builder is a burner's (`claim_write::build_burner_bundle`), which signs
/// with a `BurnerKey` only and lays its memos out as this one does.
pub fn build_publish_bundle(
    net: crate::chia_network::ChiaNet,
    chia_sk: &SecretKey,
    coin: Coin,
    hint: Bytes32,
    ciphertext: Bytes,
) -> Result<SpendBundle> {
    refuse_money_memo(net)?;
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
    sign_standard_spends(net, chia_sk, ctx.take())
}

/// A write's bundle carrying `body` under `hint`, built by
/// [`build_publish_bundle`], and the digest its mark keeps of the memo it
/// carries ([`crate::chia_resolve::memo_digest`]): `body` is the spend's
/// second memo byte for byte, the one a reader opens and the writer's verdict
/// checks ([`crate::chia_resolve::child_under_hint`]). The two are made in
/// one place so the digest saved is the one the chain serves
/// (`a_writes_memo_digest_is_the_one_its_readers_take_from_its_spend`): a
/// digest of anything else would make each write of ours a stale row to its
/// own verdict, and have it written again and again.
pub fn memo_bundle(net: crate::chia_network::ChiaNet, chia_sk: &SecretKey, coin: Coin, hint: Bytes32, body: Vec<u8>) -> Result<(SpendBundle, Bytes32)> {
    let memo = crate::chia_resolve::memo_digest(&body);
    let bundle = build_publish_bundle(net, chia_sk, coin, hint, Bytes::new(body))?;
    Ok((bundle, memo))
}

/// Sign standard-puzzle coin spends with our SYNTHETIC key for `net` (its
/// consensus constants give the AGG_SIG additional data, so a spend signed
/// for one network is not valid on another) and bundle them. Shared by the
/// presence publisher and the faucet dish's GIVE spend.
pub fn sign_standard_spends(net: crate::chia_network::ChiaNet, chia_sk: &SecretKey, coin_spends: Vec<CoinSpend>) -> Result<SpendBundle> {
    let synthetic_sk: SecretKey = chia_sk.derive_synthetic();
    let synthetic_pk: PublicKey = synthetic_sk.public_key();
    let mut allocator = Allocator::new();
    let constants = AggSigConstants::from(net.constants());
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
///
/// Off a test network nothing at all (stage 4 design §4.5 (2)): a v1 record's
/// hint is per room per day and its body carries every live address, so
/// it is written on a test network only, and the page shows the Chia Mesh
/// switch that arms it there only.
pub fn publishable_rooms(net: crate::chia_network::ChiaNet, caps: &[(String, ChiaRoomCap)]) -> (Vec<(String, [u8; 32])>, Vec<String>) {
    let mut armed = Vec::new();
    let mut refused = Vec::new();
    if !net.is_test() {
        return (armed, refused);
    }
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
// That is the SSF wallet's clock (node_publish_due, money_listing_step). A
// listing written from burner keys keeps the budget and the debounce, but its
// era's first write goes out at the era's secret slot, after a late start, or
// at once for a station not listed last era, and a change after a jitter
// (stage 4 design §4.3, burner_listing_step).
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
/// T2 of stage 4 design §4.3, coming online late: a run whose first agreed
/// peak in an era is already at or past the listing's slot writes the era's
/// first listing after a delay of 0 to this many blocks, about an hour at
/// 18.75 s a block, drawn once for the era ([`ListingClock`]). Burner path
/// only.
pub const LATE_START_MAX_BLOCKS: u32 = 192;
/// T3 of §4.3, an address or flag change: once the debounce has passed
/// ([`ADDR_CHANGE_DEBOUNCE_SECS`], counted from the last write as the SSF
/// wallet's clock counts it), the change is written after a further 0 to
/// this many blocks, about ten minutes, drawn once for each new address set
/// ([`ListingClock`]). Burner path only.
pub const CHANGE_JITTER_MAX_BLOCKS: u32 = 32;
/// How many blocks before the era guard ([`ERA_GUARD_BLOCKS`]) a late start
/// (T2) ends at the latest ([`late_due_at`]). A delay drawn near the era's
/// end would otherwise fall in the guard, where nothing is written, and the
/// era would go without its listing; cut to end here, the write still has
/// this many blocks, about ten heartbeat ticks of a minute each, to go out.
pub const LATE_GUARD_MARGIN_BLOCKS: u32 = 32;

/// The Phone Book's words while the era's first listing from a burner key
/// waits for its slot (T1, stage 4 design §4.3), which falls in the era's
/// first day ([`crate::chia_burner::SLOT_BLOCKS`]). Last era's listing is
/// still read then, and the readout shows it listed ([`listing_readout`])
/// once the chain has read it back with the live addresses
/// ([`presence_state_with`]); one the peers accepted but the chain never
/// showed reads outdated beside these words.
const LISTING_SLOT_WORDS: &str = "this edition's listing goes out at a random time in its first day";
/// The words while it waits a late start (T2), at most
/// [`LATE_START_MAX_BLOCKS`] blocks, about an hour.
const LISTING_LATE_WORDS: &str = "this edition's listing goes out at a random time within about an hour";
/// The words while a change waits (T3): the debounce, at most ten minutes
/// from now, then at most [`CHANGE_JITTER_MAX_BLOCKS`] blocks, about ten
/// more.
const LISTING_CHANGE_WORDS: &str = "the new listing goes out at a random time within about 20 minutes";
/// Why the readout gives no new listing although the address set changed,
/// with the SSF wallet paying for the listing: the era's write budget
/// ([`MAX_NODE_WRITES_PER_ERA`]) is spent. The text the readout always gave.
const BUDGET_SPENT_WORDS: &str = "this era's write budget is spent; the next listing goes out with the new era";
/// The same with the listing written from burner keys, whose next era's
/// first write goes out at its slot, not as the era begins (§4.3).
const BURNER_BUDGET_SPENT_WORDS: &str = "this edition's write budget is spent; the next listing goes out in the next edition";
/// Why a listing pending past its timeout is not written again, with the SSF
/// wallet paying for the listing: the lease still holds its spend
/// ([`node_publish_due`]). The text the readout always gave.
const SPEND_LIVE_WORDS: &str = "the wallet still holds the listing's spend, so it is not written again; the chain settles it";
/// The same with the listing written from burner keys. It names no payer:
/// the spend held may be the burner's or, in the era the burner path was
/// turned on, the SSF wallet's (§8.3).
const BURNER_SPEND_LIVE_WORDS: &str = "the listing's last spend is still in flight, so it is not written again; the chain settles it";

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
    /// The parent of the record's own coin, hex: the coin whose spend made the
    /// coin carrying the record under the hint, which is how the write is
    /// found again ([`crate::chia_resolve::child_under_hint`]). For a write
    /// the SSF wallet pays for, and for a burner's rewrite, it is also the
    /// input the spend consumed; for a burner's first write it is the gift g,
    /// and `parked` names the dish coin F the spend consumed (stage 4 design
    /// §4.1, §4.4). Empty in a mark an older node wrote: nothing to judge,
    /// the watcher's read alone confirms.
    #[serde(default)]
    pub coin_id: String,
    /// The digest of the memo the write carried, hex
    /// ([`crate::chia_resolve::memo_digest`] of its ciphertext): the coin
    /// under the hint confirms the write only if its output carries that
    /// memo ([`crate::chia_resolve::child_under_hint`]), so the same coin
    /// made again by another write of ours from the input is told apart. A
    /// digest of public chain data: it holds no key material. Empty in a mark
    /// an older node wrote, which is judged by its hint alone.
    #[serde(default)]
    pub memo: String,
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
    /// The on-chain input the wallet lease parked for the write's spend, hex,
    /// which the input's spent height and the lease's word are read at
    /// ([`WriteCoins::filed`]): the dish coin F for a burner's first write,
    /// whose `coin_id` is the gift g, and the same coin as `coin_id` for every
    /// other write (stage 4 design §4.1, §4.4). Empty in a mark an older node
    /// wrote, whose one coin is both.
    #[serde(default)]
    pub parked: String,
    /// Who paid for the write, as the lease parked its spend: the payer's
    /// [`Payer::hex`] text, the paying key's ([`Payer::of`]) for a write the
    /// SSF wallet pays for and the burner's ([`Payer::of_burner`]) for a
    /// burner's, for the hint rule to compare as text and never parse back
    /// (stage 4 design §4.4, §8.3, PR 10). Every write this build files names
    /// one. `None` in a mark an older node wrote, which counts as paid by the
    /// money address.
    #[serde(default)]
    pub payer: Option<String>,
}

impl NodePublishMark {
    /// The mark a presence write leaves once its push returned: pending until
    /// the chain's own word — the mark's lookup confirms it (or voids it),
    /// with or without the watcher, which only ever read back the marks of
    /// older nodes — and naming what that lookup judges it by: its coins (its
    /// parent and its parked input, stage 4 design §4.4), its hint, the
    /// digest of its memo and the lease's number for its spend; and its
    /// payer, the one the lease parked the spend under.
    pub fn written(era: u64, writes: u32, addrs_sig: String, last_at: u64, hint: Bytes32, write: &MemoWrite, node_id: String) -> Self {
        NodePublishMark {
            era,
            writes,
            addrs_sig,
            last_at,
            hint: hex::encode(hint.to_bytes()),
            confirmed: false,
            chain_seen: false,
            coin_id: hex::encode(write.coins.parent.to_bytes()),
            memo: hex::encode(write.memo.to_bytes()),
            confirmed_height: 0,
            settled: false,
            spend: write.spend,
            node_id: Some(node_id),
            parked: hex::encode(write.coins.parked.to_bytes()),
            payer: Some(write.payer.hex()),
        }
    }

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

    /// Is this the mark of a void write ([`NodePublishMark::voided`]): no
    /// coin and no spend to judge, pending from no time at all, never
    /// confirmed? Nothing of its era stands on chain for it. A mark an older
    /// node saved names no coin either, but dates its write.
    pub fn is_void(&self) -> bool {
        self.coin_id.is_empty() && self.spend.is_none() && self.last_at == 0 && !self.confirmed && !self.chain_seen
    }

    /// The mark after its write is void (the mempool dropped the spend, or it
    /// confirmed outside its era): nothing on chain, so pending from no time
    /// at all, which makes the next write due at once — but the era, its
    /// write count and the address signature stay, so the era's budget holds
    /// and a changed address set is still told from an unchanged one. Its
    /// coins go with the write, its parked input as well as its coin id; its
    /// payer stays, as its hint does: the hint rule (stage 4 design §8.3)
    /// must still see who wrote under this era's hint once that write died.
    pub fn voided(&self) -> Self {
        NodePublishMark {
            last_at: 0,
            confirmed: false,
            chain_seen: false,
            coin_id: String::new(),
            memo: String::new(),
            confirmed_height: 0,
            settled: false,
            spend: None,
            parked: String::new(),
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
/// is still confirmed the first time the chain shows it. 📖 A mark that names
/// its coin is never confirmed here: its own lookup ([`presence_standing`],
/// judged by [`presence_step`]) confirms it, with the height the Phone Book's
/// green then stands on. The watcher's sighting is of the write, not of the
/// chain's current word, so once a reorganization returned such a mark to
/// pending it would set the green back at height 0, which no later absence
/// could take down ([`crate::chia_resolve::HintChild::gone_since`] says nothing
/// of a height 0), and the clock's retry would be stopped with it.
pub fn mark_confirmed_by(mark: &NodePublishMark, seen_issued_at: u64) -> bool {
    mark.coin_id.is_empty() && !mark.chain_seen && seen_issued_at != 0 && seen_issued_at == mark.last_at
}

/// Is a presence write due, on the SSF wallet's clock ([`money_listing_step`])?
/// Always for a new era (or none ever), and for a mark
/// another identity left ([`mark_is_ours`]). Within an era: when the last write
/// is still unconfirmed after [`PRESENCE_CONFIRM_TIMEOUT_SECS`] (the spend may
/// have been dropped) — unless the wallet lease still holds that write's spend
/// (`spend_held`: its input parked, or included and settling), since the spend
/// is then live, pushed again by the lease or settled by the chain, and a
/// second listing would stand beside the first for a write of the era's budget
/// (📖 #334 review: a listing a reorganization returned to pending past the
/// window, its spend still settling on the lease's view of the chain; the
/// publish gate alone lets a settling spend's listing be written again, since
/// it refuses only while a coin is parked) — or when the signed address set
/// changed and the debounce has passed, a new listing whatever the lease
/// holds; either way only while the era's write budget is not spent. A
/// listing written from burner keys does not go out at once for a new era:
/// [`burner_listing_step`] times the era's first write by its slot (stage 4
/// design §4.3).
pub fn node_publish_due(
    mark: Option<&NodePublishMark>,
    era: u64,
    addrs_sig: &str,
    now: u64,
    hint: &str,
    node_id: &str,
    spend_held: bool,
) -> bool {
    node_publish_why(mark, era, addrs_sig, now, hint, node_id, spend_held).is_some()
}

/// Why a presence write is due ([`node_publish_why`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PresenceDue {
    /// No write of ours in this era yet: no mark, a mark of another era, or
    /// one another identity left ([`mark_is_ours`]).
    FirstOfEra,
    /// This era's write is still unconfirmed after
    /// [`PRESENCE_CONFIRM_TIMEOUT_SECS`], and the lease no longer holds its
    /// spend: the mempool may have dropped it.
    Retry,
    /// The signed address set changed and the debounce
    /// ([`ADDR_CHANGE_DEBOUNCE_SECS`]) has passed since the last write.
    Change,
}

/// [`node_publish_due`]'s rule, arm for arm, naming which arm makes the
/// write due, or `None` when none does. An unconfirmed write past its
/// timeout is a [`PresenceDue::Retry`] even when the address set changed
/// too, since the retry writes the live set all the same. The burner path's
/// gates ([`burner_listing_step`]) keep the SSF wallet's budget, timeout and
/// debounce by asking this, and time each reason in their own way.
pub fn node_publish_why(
    mark: Option<&NodePublishMark>,
    era: u64,
    addrs_sig: &str,
    now: u64,
    hint: &str,
    node_id: &str,
    spend_held: bool,
) -> Option<PresenceDue> {
    let changed = |m: &NodePublishMark| m.addrs_sig != addrs_sig && now.saturating_sub(m.last_at) >= ADDR_CHANGE_DEBOUNCE_SECS;
    match mark {
        None => Some(PresenceDue::FirstOfEra),
        Some(m) if m.era != era => Some(PresenceDue::FirstOfEra),
        Some(m) if !mark_is_ours(m, hint, node_id) => Some(PresenceDue::FirstOfEra),
        Some(m) if m.writes >= 1 + MAX_NODE_WRITES_PER_ERA => None,
        Some(m) if !m.confirmed && !spend_held && now.saturating_sub(m.last_at) >= PRESENCE_CONFIRM_TIMEOUT_SECS => Some(PresenceDue::Retry),
        Some(m) => changed(m).then_some(PresenceDue::Change),
    }
}

/// The first block of era `era`.
fn era_start(era: u64) -> u64 {
    era.saturating_mul(u64::from(ERA_BLOCKS))
}

/// The era the heartbeat judges the listing on record by this tick
/// ([`presence_step`]), or `None` when it judges nothing: this era's while
/// it is unsettled ([`NodePublishMark::unsettled_for`]), and, on the burner
/// path (`burner_path`), last era's while it is unsettled, since it reads
/// listed while this era's first write waits for its slot or its late start
/// ([`ListingHold::LastEra`], stage 4 design §4.3): a shallow
/// reorganization that drops it after the era turned takes the green with
/// it, and a station whose listing readers no longer find writes at once
/// ([`has_last_era_listing`]). With the SSF wallet paying, last era's
/// listing is not judged once the era turns, as on main: it never reads
/// listed then.
pub(crate) fn listing_judged_era(mark: Option<&NodePublishMark>, era: u64, node_id: &str, burner_path: bool) -> Option<u64> {
    let m = mark?;
    if m.unsettled_for(era, node_id) {
        return Some(era);
    }
    let last = era.checked_sub(1).filter(|_| burner_path)?;
    m.unsettled_for(last, node_id).then_some(last)
}

/// Was this station listed last era, as the newcomer exception of stage 4
/// design §4.3 (T1) asks: is `mark` a write of era `era - 1`, ours under
/// that era's hint `last_hint` and as `node_id` ([`mark_is_ours`]), and
/// confirmed or read back from the chain? Readers scan the current era and
/// the one before, so such a listing is still found while this era's waits
/// for its slot. Anything else, era 0 among it, is a station with no listing
/// a reader would find, which writes at once. The marks file keeps one mark,
/// so a lost or unreadable file reads as not listed.
fn has_last_era_listing(mark: Option<&NodePublishMark>, era: u64, last_hint: &str, node_id: &str) -> bool {
    mark.is_some_and(|m| era.checked_sub(1) == Some(m.era) && mark_is_ours(m, last_hint, node_id) && (m.confirmed || m.chain_seen))
}

/// Does last era's listing still work, as the burner path's failure words
/// say of it ([`listing_failure_words`], stage 4 design §10)? It does while
/// the mark on record is that listing ([`has_last_era_listing`]) and it
/// carries the live address set `sig`, up to the inbound flag a new era
/// clears ([`sig_without_inbound`]), as the held *listed* readout asks
/// ([`presence_state_with`]). After a change of address, last era's listing
/// is still read, but it sends readers to where the station no longer is.
fn last_week_still_works(mark: Option<&NodePublishMark>, era: u64, last_hint: &str, node_id: &str, sig: &str) -> bool {
    has_last_era_listing(mark, era, last_hint, node_id) && mark.is_some_and(|m| sig_without_inbound(&m.addrs_sig) == sig_without_inbound(sig))
}

/// Who paid for a listing, as the hint rule (stage 4 design §8.3) and its
/// words tell payers apart. A mark names its payer as [`Payer::hex`] text,
/// which is compared as text and never parsed back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PaidBy {
    /// The SSF wallet: a mark naming the money key's payer text, or naming
    /// none, as a mark an older node saved does (§8.3: it counts as paid by
    /// the money address).
    Money,
    /// This wallet's listing burner for the era, P(e) (§3.2).
    Burner,
    /// Any other key: a wallet's that is no longer this node's, or a burner
    /// of another root.
    Other,
}

/// The class of a mark's `payer` text, against the money key's text `money`
/// and this era's listing burner's text `burner` (`None` where it was not
/// derived).
fn paid_by(payer: Option<&str>, money: &str, burner: Option<&str>) -> PaidBy {
    match payer {
        None => PaidBy::Money,
        Some(p) if p == money => PaidBy::Money,
        Some(p) if burner == Some(p) => PaidBy::Burner,
        Some(_) => PaidBy::Other,
    }
}

/// The hint rule (stage 4 design §8.3): one hint never has two payers, so a
/// listing is not written under this era's hint `era_hint` by a payer other
/// than the one that already wrote under it this era. It is keyed on the era,
/// the hint and the payer alone, never the node id: P(e) is derived from the
/// hint, so a mark another node id left under the same hint (a replaced
/// `iroh_node_id.key`, the contact key kept) joins the two payers as well.
/// It gives the class of the payer that holds the write, or `None` when the
/// write may go out.
///
/// On the burner path (`burner_path`, the writer this era's listing burner
/// `burner`) any mark of another payer holds it: the SSF wallet's, an older
/// node's that names none, or another key's. On the SSF wallet's path it is
/// held only by a mark that this wallet's own listing burner for the era
/// paid for (`burner`, derived only in that case,
/// [`money_path_burner_payer`]), which is the burner path turned off in the
/// middle of an era. A mark another wallet paid for (a wallet swapped mid-era)
/// does not hold it, so that path writes as it always did. Either way the
/// hold lasts until the next era, whose new hint has no payer yet.
pub(crate) fn hint_rule_holds(
    mark: Option<&NodePublishMark>,
    era: u64,
    era_hint: &str,
    burner_path: bool,
    money: &str,
    burner: Option<&str>,
) -> Option<PaidBy> {
    let m = mark.filter(|m| m.era == era && m.hint == era_hint)?;
    let by = paid_by(m.payer.as_deref(), money, burner);
    let holds = if burner_path { by != PaidBy::Burner } else { by == PaidBy::Burner };
    holds.then_some(by)
}

/// What the listing arm does this tick ([`burner_listing_step`],
/// [`money_listing_step`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ListingStep {
    /// Write the listing now.
    Write,
    /// Nothing is due.
    Idle,
    /// A write is due later, at the time the reason gives.
    Wait(ListingWait),
    /// A write would be due, but the hint rule ([`hint_rule_holds`]) holds
    /// it until the next era: this era's listing was paid by this payer.
    HeldByHint(PaidBy),
}

/// What a listing written from burner keys waits for (stage 4 design §4.3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ListingWait {
    /// T1: the era's slot, while last era's listing is still read.
    Slot,
    /// T2: a late start, drawn because this run first saw the era at or past
    /// its slot.
    LateStart,
    /// T3: an address or flag change, waiting its debounce and jitter.
    Change,
}

/// What the listing's readout holds the Phone Book's state to
/// ([`listing_readout`], [`presence_state_with`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListingHold {
    /// Nothing: the state is the listing on record's own ([`presence_state`]).
    Nothing,
    /// Last era's listing stands in for this era's while the era's first
    /// write from a burner key waits for its slot or its late start (stage 4
    /// design §4.3, T1 and T2).
    LastEra,
    /// The hint rule holds the next write (§8.3), and this era's listing on
    /// record is void ([`NodePublishMark::is_void`]): no listing of this era
    /// stands, so it is not *sent*, and none is coming before the next era.
    Unlanded,
}

/// The SSF wallet's listing step: [`node_publish_due`] as it always was,
/// except that the hint rule ([`hint_rule_holds`], §8.3) holds a write due
/// under a hint this wallet's own listing burner already wrote under this
/// era. `burner` is that burner's payer text, which the heartbeat derives
/// only when the mark names a payer that is neither none nor the money key's
/// (`money`) ([`money_path_burner_payer`]). For a mark the SSF wallet paid
/// for, or an older node's, this is `Write` exactly when `node_publish_due`
/// is true, and `Idle` otherwise.
#[allow(clippy::too_many_arguments)]
pub(crate) fn money_listing_step(
    mark: Option<&NodePublishMark>,
    era: u64,
    addrs_sig: &str,
    now: u64,
    hint: &str,
    node_id: &str,
    spend_held: bool,
    money: &str,
    burner: Option<&str>,
) -> ListingStep {
    if !node_publish_due(mark, era, addrs_sig, now, hint, node_id, spend_held) {
        return ListingStep::Idle;
    }
    match hint_rule_holds(mark, era, hint, false, money, burner) {
        Some(by) => ListingStep::HeldByHint(by),
        None => ListingStep::Write,
    }
}

/// The payer text of this wallet's listing burner for era `era`, P(e), when
/// the SSF wallet's step needs it ([`money_listing_step`]): on a test network
/// (`net`) only, and only for a mark of `era` under `era_hint` whose payer is
/// neither none nor the money key's text `money`. Every other mark leaves
/// the step as it always was, so no root is made for it. The root is made
/// from the wallet key `wallet` on `net` (§3.2) and dropped at once; the
/// text is a puzzle hash, which no log line prints.
pub(crate) fn money_path_burner_payer(
    mark: Option<&NodePublishMark>,
    era: u64,
    era_hint: &str,
    money: &str,
    net: crate::chia_network::ChiaNet,
    wallet: &SecretKey,
    ck: &[u8; 32],
) -> Option<String> {
    use crate::chia_burner::{BurnerRoot, MoneyKey};
    let m = mark.filter(|m| net.is_test() && m.era == era && m.hint == era_hint)?;
    m.payer.as_deref().filter(|p| *p != money)?;
    let root = BurnerRoot::of(&MoneyKey::new(wallet.clone()), net);
    Some(Payer::of_burner(&root.presence(ck, era)).hex())
}

/// This era's listing as its mark would have filed it, rebuilt from the
/// write the lease still holds under the era's hint, when the mark on record
/// does not name it and the hint rule (stage 4 design §8.3) would hold the
/// listing's next write on it. The heartbeat files it in place of the mark
/// on record.
///
/// The heartbeat files a listing's mark once its push returns, and the lease
/// parks the write's spend, with its bundle and payer, before the push. A
/// node that stops between the two, or whose marks file is lost or cannot
/// be read, keeps the write in its lease (parked, then settling until the
/// chain settles it [`crate::chia_knock::SETTLED_DEPTH`] deep,
/// [`WalletLease::held_write_under`]) and an older mark, or none, or this
/// era's mark of an earlier write that died ([`NodePublishMark::is_void`]),
/// which names no write at all. Started
/// again on the other path (burner keys turned on or off in the middle of
/// the era), its next write would go out under the same hint from the
/// other payer, the link the hint rule is there to prevent, and a wait for
/// the spend to land would only put that write off. So the lost mark is
/// filed again: the era, the hint and the payer the lease parked the spend
/// under (`None` when none was filed, which counts as the SSF wallet's),
/// the coins, the record's digest and the spend's number, and the address
/// set, the date and the node id the record itself carries, opened under
/// `ck` ([`chia_lane::open_v2`]). The era's write count goes on from a void
/// mark of this era on record, which keeps it ([`NodePublishMark::voided`]),
/// as the writer counted it: the void mark's count and this write, when the
/// void mark names the record's node id. Otherwise it is the floor, 1,
/// since a lost mark's count is not on chain. The mark's reader then judges
/// the write as any other ([`presence_step`]), and the hint rule holds the
/// other payer's write until the next era. A mark of this era under this
/// hint that names a write is the one on record, and nothing is filed over
/// it. Over a void one, a write the chain spent in a block of another era
/// is not filed: it is the write the mark was voided for, confirmed outside
/// its era ([`presence_step`]), still settling, and filing it again would
/// only void it again. With no mark of this era it is filed all the same,
/// and voided: its coin is on chain under the hint, so the void mark's
/// payer keeps the hint rule.
///
/// `burner_path`, `money` and `burner` are the hint rule's
/// ([`hint_rule_holds`]): `burner` gives this wallet's listing burner's
/// payer text for the rebuilt mark, asked only once a write is found. A
/// write the rule would not hold on is left alone, so the step is the one
/// it always was: the burner's own, on the burner path, and the SSF
/// wallet's on its own path, as on main. Off a test network nothing is
/// rebuilt; no memo write is made there from the SSF wallet (§4.5) or,
/// until burner keys reach it, from a burner. A write the lease has
/// forgotten, or whose bundle was not saved, is not found: a marks file
/// lost after the chain settled the era's write leaves nothing to rebuild
/// from here.
///
/// The lease is read under its gate ([`WalletLease::held_write_under`]),
/// so the caller must not hold it. Off a test network, and with a mark of
/// this era on record that names a write, nothing is read, and the step
/// returns at once without waiting on the gate.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn lost_listing_mark(
    lease: &WalletLease,
    mark: Option<&NodePublishMark>,
    net: crate::chia_network::ChiaNet,
    ck: &[u8; 32],
    era: u64,
    burner_path: bool,
    money: &str,
    burner: impl FnOnce(&NodePublishMark) -> Option<String>,
) -> Option<NodePublishMark> {
    let hint = Bytes32::new(chia_lane::derive_ck_hint(net, ck, era));
    let era_hint = hex::encode(hint.to_bytes());
    let on_record = mark.filter(|m| m.era == era && m.hint == era_hint);
    if !net.is_test() || on_record.is_some_and(|m| !m.is_void()) {
        return None;
    }
    let held = lease.held_write_under(hint).await?;
    if on_record.is_some() && held.spent_at.is_some_and(|h| chia_lane::era_of(h) != era) {
        return None;
    }
    let plain = chia_lane::open_v2(net, ck, KIND_PRESENCE, era, &held.record).ok()?;
    let record = chia_lane::decode_presence_v2(&plain, era).ok()?;
    let node_id = record.node_id.to_string();
    let writes = on_record.filter(|m| m.node_id.as_deref() == Some(node_id.as_str())).map_or(1, |m| m.writes.saturating_add(1));
    let found = NodePublishMark {
        era,
        writes,
        addrs_sig: addrs_signature(&record.addrs),
        last_at: record.issued_at,
        hint: era_hint,
        confirmed: false,
        chain_seen: false,
        coin_id: hex::encode(held.coins.parent.to_bytes()),
        memo: hex::encode(crate::chia_resolve::memo_digest(&held.record).to_bytes()),
        confirmed_height: 0,
        settled: false,
        spend: Some(held.spend),
        node_id: Some(node_id),
        parked: hex::encode(held.coins.parked.to_bytes()),
        payer: held.payer.map(|p| p.hex()),
    };
    let burner = burner(&found);
    hint_rule_holds(Some(&found), era, &found.hint, burner_path, money, burner.as_deref()).map(|_| found)
}

/// T2's due block (stage 4 design §4.3): `d` blocks after `first_peak`, the
/// first agreed peak this run saw in era `era`, but no later than
/// [`LATE_GUARD_MARGIN_BLOCKS`] before the era guard ([`ERA_GUARD_BLOCKS`]),
/// so that a late start drawn near the era's end still leaves the write a
/// window of several ticks. A first peak already that close to the guard is
/// due at once; inside the guard nothing is written that era, as on the SSF
/// wallet's clock ([`era_guard`]).
fn late_due_at(first_peak: u32, d: u32, era: u64) -> u64 {
    let guard_start = era_start(era) + u64::from(ERA_BLOCKS - ERA_GUARD_BLOCKS);
    let first = u64::from(first_peak);
    let latest = guard_start.saturating_sub(u64::from(LATE_GUARD_MARGIN_BLOCKS)).max(first);
    (first + u64::from(d)).min(latest)
}

/// The first agreed peak this run saw in an era, and the late start drawn
/// for it (T2), if it was at or past the era's slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FirstPeak {
    era: u64,
    peak: u32,
    late: Option<u32>,
}

/// A change waiting its jitter (T3): the address set it is for (with the
/// inbound flag cleared before the era's first write, [`sig_without_inbound`]),
/// the era, the first peak at which it was due, and the jitter drawn then.
#[derive(Clone, Debug, PartialEq, Eq)]
struct ChangeSeen {
    era: u64,
    sig: String,
    due_peak: u32,
    jitter: u32,
}

/// This era's listing burner's payer text, kept for the era and the hint it
/// was derived for.
struct BurnerPayerText {
    era: u64,
    hint: String,
    payer: String,
}

/// What the burner path's listing gates remember between ticks
/// ([`burner_listing_step`]): the first agreed peak this run saw in the era
/// and its late start (T2), the change waiting its jitter (T3), and the era's
/// listing burner's payer text, so that P(e) is derived once an era. It lives
/// in memory for one run: a restart draws again. Only the slot survives a
/// restart, since it is derived from the root (stage 4 design §4.3). It has
/// no `Debug`, since it holds P(e)'s payer text, a puzzle hash no log line
/// prints.
#[derive(Default)]
pub(crate) struct ListingClock {
    first: Option<FirstPeak>,
    change: Option<ChangeSeen>,
    burner: Option<BurnerPayerText>,
}

impl ListingClock {
    /// Notes `peak`, an agreed peak in era `era`, whose listing's slot is
    /// `slot` blocks into the era. The first one this run sees in an era is
    /// kept, with a late start drawn for it if it is at or past the slot
    /// (T2); later peaks of the era change nothing. A new era also drops a
    /// change of another era, so a change pending at the boundary does not
    /// fire on the new era's first tick.
    fn see_peak<R: rand::Rng + ?Sized>(&mut self, era: u64, peak: u32, slot: u64, rng: &mut R) {
        if self.change.as_ref().is_some_and(|c| c.era != era) {
            self.change = None;
        }
        if self.first.is_some_and(|f| f.era == era) {
            return;
        }
        let into = u64::from(peak).saturating_sub(era_start(era));
        let late = (into >= slot).then(|| rng.gen_range(0..=LATE_START_MAX_BLOCKS));
        self.first = Some(FirstPeak { era, peak, late });
    }

    /// What the era's first write still waits for at `peak` (T1, T2), or
    /// `None` once it is due: the slot, `slot` blocks into era `era`, unless
    /// a late start was drawn for the era ([`late_due_at`]).
    fn slot_wait(&self, era: u64, peak: u32, slot: u64) -> Option<ListingWait> {
        let peak = u64::from(peak);
        match self.first.filter(|f| f.era == era) {
            Some(FirstPeak { peak: first, late: Some(d), .. }) => (peak < late_due_at(first, d, era)).then_some(ListingWait::LateStart),
            _ => (peak < era_start(era).saturating_add(slot)).then_some(ListingWait::Slot),
        }
    }

    /// Whether the change to the address set `changed` (`None`: no change)
    /// goes out at `peak` (T3). `due` says the debounce has passed and the
    /// budget allows a write. The jitter is drawn at the first peak at which
    /// a change to this set is due, and the change goes out that many blocks
    /// later; a change to another set, or in another era, draws again. No
    /// change, or one not yet due, forgets the clock.
    fn change_due<R: rand::Rng + ?Sized>(&mut self, era: u64, changed: Option<&str>, due: bool, peak: u32, rng: &mut R) -> bool {
        let Some(sig) = changed.filter(|_| due) else {
            self.change = None;
            return false;
        };
        let seen = match self.change.take() {
            Some(c) if c.era == era && c.sig == sig => c,
            _ => ChangeSeen { era, sig: sig.to_owned(), due_peak: peak, jitter: rng.gen_range(0..=CHANGE_JITTER_MAX_BLOCKS) },
        };
        let go = u64::from(peak) >= u64::from(seen.due_peak) + u64::from(seen.jitter);
        self.change = Some(seen);
        go
    }

    /// The payer text of `root`'s listing burner for era `era` under the
    /// contact key `ck`, P(e) (§3.2), derived once for the era and its hint
    /// `hint` and kept for later ticks; a new era or hint derives it again.
    fn burner_payer(&mut self, root: &crate::chia_burner::BurnerRoot, ck: &[u8; 32], era: u64, hint: &str) -> String {
        match &self.burner {
            Some(b) if b.era == era && b.hint == hint => b.payer.clone(),
            _ => {
                let payer = Payer::of_burner(&root.presence(ck, era)).hex();
                self.burner = Some(BurnerPayerText { era, hint: hint.to_owned(), payer: payer.clone() });
                payer
            }
        }
    }
}

/// What the burner path's listing step is judged by, one tick's worth: the
/// mark on record, the agreed era and peak, the time, the live address set,
/// this era's and last era's hints, our node id, whether the lease still
/// holds the mark's spend, the money key's payer text, and the root and
/// contact key the era's slot and listing burner come from.
pub(crate) struct ListingFacts<'a> {
    mark: Option<&'a NodePublishMark>,
    era: u64,
    peak: u32,
    now: u64,
    sig: &'a str,
    hint: &'a str,
    /// Era `era - 1`'s hint (any text in era 0, which has no era before it).
    last_hint: &'a str,
    node_id: &'a str,
    spend_held: bool,
    money: &'a str,
    root: &'a crate::chia_burner::BurnerRoot,
    ck: &'a [u8; 32],
}

/// The listing step on the burner path (stage 4 design §4.3, §8.3), at most
/// one random draw for the era's late start and one for each new address
/// set, from `rng`:
/// 1. The era's slot is `root.slot(KIND_PRESENCE, era)` blocks into the era
///    (T1), and the era's listing burner P(e) is the root's
///    ([`ListingClock`] derives it once an era).
/// 2. With this era's listing of ours on record, the SSF wallet's rule
///    decides ([`node_publish_why`]): a retry goes out at once, and a change
///    once its debounce has passed and then its jitter (T3); a changed set
///    still inside the debounce waits.
/// 3. Otherwise this is the era's first write. A station not listed last era
///    ([`has_last_era_listing`]) writes at once, the newcomer exception of T1.
/// 4. A station listed last era writes at its slot, or after a late start if
///    this run first saw the era at or past the slot (T2). A real change to
///    its address set before then takes the slot's place: last era's set and
///    the live one are compared with the inbound flag cleared
///    ([`sig_without_inbound`]), since a new era clears it (T3).
///
/// Last, the hint rule ([`hint_rule_holds`]) holds any write, and any
/// change waiting, under a hint another payer already wrote under this era.
pub(crate) fn burner_listing_step<R: rand::Rng + ?Sized>(clock: &mut ListingClock, f: &ListingFacts<'_>, rng: &mut R) -> ListingStep {
    let slot = f.root.slot(KIND_PRESENCE, f.era);
    let burner = clock.burner_payer(f.root, f.ck, f.era, f.hint);
    clock.see_peak(f.era, f.peak, slot, rng);
    let step = match f.mark {
        Some(m) if m.era == f.era && mark_is_ours(m, f.hint, f.node_id) => {
            match node_publish_why(f.mark, f.era, f.sig, f.now, f.hint, f.node_id, f.spend_held) {
                Some(PresenceDue::Change) => {
                    if clock.change_due(f.era, Some(f.sig), true, f.peak, rng) {
                        ListingStep::Write
                    } else {
                        ListingStep::Wait(ListingWait::Change)
                    }
                }
                Some(PresenceDue::Retry | PresenceDue::FirstOfEra) => ListingStep::Write,
                None => {
                    clock.change = None;
                    if m.addrs_sig != f.sig && m.writes < 1 + MAX_NODE_WRITES_PER_ERA {
                        ListingStep::Wait(ListingWait::Change)
                    } else {
                        ListingStep::Idle
                    }
                }
            }
        }
        Some(m) if has_last_era_listing(f.mark, f.era, f.last_hint, f.node_id) => {
            let live = sig_without_inbound(f.sig);
            let changed = (sig_without_inbound(&m.addrs_sig) != live).then_some(live);
            let due = changed.is_some() && f.now.saturating_sub(m.last_at) >= ADDR_CHANGE_DEBOUNCE_SECS;
            if clock.change_due(f.era, changed.as_deref(), due, f.peak, rng) {
                ListingStep::Write
            } else {
                match clock.slot_wait(f.era, f.peak, slot) {
                    None => ListingStep::Write,
                    Some(_) if changed.is_some() => ListingStep::Wait(ListingWait::Change),
                    Some(wait) => ListingStep::Wait(wait),
                }
            }
        }
        _ => ListingStep::Write,
    };
    match step {
        ListingStep::Write | ListingStep::Wait(ListingWait::Change) => match hint_rule_holds(f.mark, f.era, f.hint, true, f.money, Some(&burner)) {
            Some(by) => ListingStep::HeldByHint(by),
            None => step,
        },
        other => other,
    }
}

/// The Phone Book's words for a listing step that waits or is held, or
/// `None` for one that writes or has nothing due. A hold names the class of
/// the payer that holds it and nothing it has not checked (§8.3): on the
/// burner path (`burner_path`) the next era's listing goes out from its own
/// key, on the SSF wallet's path the wallet writes it.
fn listing_wait_words(step: ListingStep, burner_path: bool) -> Option<&'static str> {
    match step {
        ListingStep::Wait(ListingWait::Slot) => Some(LISTING_SLOT_WORDS),
        ListingStep::Wait(ListingWait::LateStart) => Some(LISTING_LATE_WORDS),
        ListingStep::Wait(ListingWait::Change) => Some(LISTING_CHANGE_WORDS),
        ListingStep::HeldByHint(by) => Some(match (burner_path, by) {
            (true, PaidBy::Money) => {
                "this edition's listing was paid by the SSF wallet and stays as it is: one hint never has two payers; the next edition's listing goes out from its own key"
            }
            (true, PaidBy::Burner | PaidBy::Other) => {
                "this edition's listing was paid by another key and stays as it is: one hint never has two payers; the next edition's listing goes out from its own key"
            }
            (false, PaidBy::Money) => "this edition's listing was paid by the SSF wallet and stays as it is: one hint never has two payers; the SSF wallet writes the next edition's",
            (false, PaidBy::Burner | PaidBy::Other) => {
                "this edition's listing was paid by another key and stays as it is: one hint never has two payers; the SSF wallet writes the next edition's"
            }
        }),
        ListingStep::Write | ListingStep::Idle => None,
    }
}

/// The Phone Book's words for a hold (§8.3) while this era's listing on
/// record is void ([`NodePublishMark::is_void`]): the mempool dropped its
/// write, or it confirmed outside its era, so it is not in the book, and the
/// hint rule still keeps this path's payer off the era's hint. Like the
/// hold's words ([`listing_wait_words`]) they name the class of the payer
/// that holds it and nothing they have not checked.
fn unlanded_hold_words(by: PaidBy, burner_path: bool) -> &'static str {
    match (burner_path, by) {
        (true, PaidBy::Money) => {
            "this edition's listing, paid by the SSF wallet, did not make it into the book; one hint never has two payers, so the next edition's goes out from its own key"
        }
        (true, PaidBy::Burner | PaidBy::Other) => {
            "this edition's listing, paid by another key, did not make it into the book; one hint never has two payers, so the next edition's goes out from its own key"
        }
        (false, PaidBy::Money) => {
            "this edition's listing, paid by the SSF wallet, did not make it into the book; one hint never has two payers, so the SSF wallet writes the next edition's"
        }
        (false, PaidBy::Burner | PaidBy::Other) => {
            "this edition's listing, paid by another key, did not make it into the book; one hint never has two payers, so the SSF wallet writes the next edition's"
        }
    }
}

/// The Phone Book's readout of the listing arm: the one text the readout
/// gives beside the state, and what it holds the state to
/// ([`ListingHold`]). The text is the first that applies: why no memo can
/// be written on this network at all (`money_refused`), why the step waits
/// or is held ([`listing_wait_words`], or [`unlanded_hold_words`] for a hold
/// on a void listing, `void`), the last failed attempt's words
/// (`node_last_error`), the era's write budget spent although the address
/// set changed (`budget_spent`), and the lease still holding the spend of a
/// listing pending past its timeout (`spend_live`). With the SSF wallet
/// paying (`burner_path` false) and a step that writes or has nothing due,
/// that is the readout's chain as it always was, word for word, and it holds
/// nothing.
///
/// Last era's listing reads as listed ([`ListingHold::LastEra`]) only on the
/// burner path, while the era's first write waits for its slot or its late
/// start (T1, T2). The step waits for either only when last era's listing is
/// ours and confirmed or read back ([`has_last_era_listing`]), and readers
/// still find it then, since they scan the current era and the one before.
/// Once the write is due, a failing write reads as outdated, with the words
/// of the failure ([`listing_failure_words`], which say so where last week's
/// listing still works). A hold by the hint rule on this era's listing on
/// record that is void (`void`, [`NodePublishMark::is_void`]) reads as
/// outdated, not sent ([`ListingHold::Unlanded`]): no write of this era
/// stands, and the hold keeps one from going out before the next era.
pub(crate) fn listing_readout(
    money_refused: Option<&str>,
    step: ListingStep,
    burner_path: bool,
    void: bool,
    node_last_error: Option<&str>,
    budget_spent: bool,
    spend_live: bool,
) -> (Option<String>, ListingHold) {
    let (budget, live) = if burner_path { (BURNER_BUDGET_SPENT_WORDS, BURNER_SPEND_LIVE_WORDS) } else { (BUDGET_SPENT_WORDS, SPEND_LIVE_WORDS) };
    let wait = match step {
        ListingStep::HeldByHint(by) if void => Some(unlanded_hold_words(by, burner_path)),
        _ => listing_wait_words(step, burner_path),
    };
    let why_not = money_refused.or(wait).or(node_last_error).or(budget_spent.then_some(budget)).or(spend_live.then_some(live));
    let hold = match step {
        _ if money_refused.is_some() => ListingHold::Nothing,
        ListingStep::Wait(ListingWait::Slot | ListingWait::LateStart) if burner_path => ListingHold::LastEra,
        ListingStep::HeldByHint(_) if void => ListingHold::Unlanded,
        _ => ListingHold::Nothing,
    };
    (why_not.map(str::to_owned), hold)
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

/// `sig`, an [`addrs_signature`], with [`chia_lane::FLAG_INBOUND_VERIFIED`]
/// cleared on every address. The flag is measured within an era, so a new
/// era clears it until an inbound connection is seen again; before the era's
/// first listing from a burner key, last era's address set is compared with
/// the live one this way, so that the flag the new era cleared is no change
/// and the slot still decides (stage 4 design §4.3, T1 and T3). An item that
/// does not parse as an address and its flags is kept as it is.
pub fn sig_without_inbound(sig: &str) -> String {
    if sig.is_empty() {
        return String::new();
    }
    sig.split(',')
        .map(|item| match item.rsplit_once('/').and_then(|(addr, flags)| Some((addr, flags.parse::<u8>().ok()?))) {
            Some((addr, flags)) => format!("{addr}/{}", flags & !chia_lane::FLAG_INBOUND_VERIFIED),
            None => item.to_owned(),
        })
        .collect::<Vec<_>>()
        .join(",")
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

/// 📖 [`presence_state`], held as the listing's readout says (`hold`,
/// [`listing_readout`]). With [`ListingHold::LastEra`], which the readout
/// gives only on the burner path while the era's first write from a burner
/// key waits for its slot or its late start (stage 4 design §4.3, T1 and
/// T2), a mark of ours from the era before that the watcher read back from
/// the chain (`chain_seen`), with the live address set up to the inbound
/// flag a new era clears ([`sig_without_inbound`]), is *listed*: readers
/// scan the current era and the one before, so it is the listing they find.
/// The heartbeat judges it by its own era until it settles
/// ([`listing_judged_era`]), so a reorganization that drops it clears its
/// `chain_seen`, and it is no longer held.
/// One the peers accepted but the watcher never read back is not held:
/// *listed* is the chain's word alone, as it is for this era's. With
/// [`ListingHold::Unlanded`], which the readout gives while the hint rule
/// holds the next write and this era's listing on record is void, a mark
/// that would read *sent* is *outdated*: no write of this era stands, and
/// none is coming before the next era. Anything else is [`presence_state`]'s
/// word, and so is everything with [`ListingHold::Nothing`], which is all the
/// readout gives with the SSF wallet paying but under the hint rule after
/// burner keys were turned off in the middle of an era: there the readout is
/// as it always was.
pub fn presence_state_with(
    mark: Option<&NodePublishMark>,
    ours: bool,
    era: Option<u64>,
    addrs_sig: &str,
    hold: ListingHold,
) -> crate::ChiaPresenceState {
    use crate::ChiaPresenceState::*;
    match (mark, era) {
        (Some(m), Some(era))
            if hold == ListingHold::LastEra
                && ours
                && era.checked_sub(1) == Some(m.era)
                && m.chain_seen
                && sig_without_inbound(&m.addrs_sig) == sig_without_inbound(addrs_sig) =>
        {
            Listed
        }
        _ => match (hold, presence_state(mark, ours, era, addrs_sig)) {
            (ListingHold::Unlanded, Sent) => Outdated,
            (_, state) => state,
        },
    }
}

/// 📖 [`presence_status_with`] holding nothing ([`ListingHold::Nothing`]):
/// the readout as it was before burner keys, which the SSF wallet's path
/// still gives. Only the tests call it, to pin that readout and that a hold
/// changes nothing else.
#[cfg(test)]
pub fn presence_status(
    mark: Option<&NodePublishMark>,
    hint: Option<&str>,
    node_id: &str,
    era: Option<u64>,
    addrs_sig: &str,
    public_addrs: usize,
    error: Option<&str>,
) -> crate::ChiaPresence {
    presence_status_with(mark, hint, node_id, era, addrs_sig, public_addrs, error, ListingHold::Nothing)
}

/// 📖 The whole readout the fingerprint carries ([`crate::ChiaPresence`]):
/// [`presence_state_with`] with the figures the browser's tooltip names. A
/// listing is ours by its signer, and, when it names the agreed era, by this
/// era's `hint` too ([`mark_is_ours`]): the hint is era-bound, so last era's
/// listing can only be judged by who signed it, and it is exactly the stale
/// listing the grey book stands for. `error` is the last failed attempt's
/// text, or why nothing can be written right now ([`listing_readout`]).
///
/// On the burner path, with [`ListingHold::LastEra`], last era's listing
/// read back from the chain is *listed* while this era's waits for its slot
/// or its late start (stage 4 design §4.3). That listing is ours by its
/// signer, as any listing of an era before the agreed one is, and the
/// figures are its own: `listed_era` is the era before, `confirmed` is the
/// chain's read, and `current` holds, since it is the listing in force. With
/// [`ListingHold::Unlanded`] a void listing of this era held by the hint
/// rule is *outdated*, and not `current`, and where it would otherwise read
/// *sent* (this era's, with the live address set) the readout says so
/// (`unlanded`), so that the page does not read an outdated listing of this
/// era as a change of address. With [`ListingHold::Nothing`] the
/// readout is the one it always was, word for word ([`presence_state`]'s
/// state).
#[allow(clippy::too_many_arguments)]
pub fn presence_status_with(
    mark: Option<&NodePublishMark>,
    hint: Option<&str>,
    node_id: &str,
    era: Option<u64>,
    addrs_sig: &str,
    public_addrs: usize,
    error: Option<&str>,
    hold: ListingHold,
) -> crate::ChiaPresence {
    let ours = mark.is_some_and(|m| match (hint, era) {
        (Some(h), Some(e)) if m.era == e => mark_is_ours(m, h, node_id),
        _ => m.node_id.as_deref() == Some(node_id),
    });
    let state = presence_state_with(mark, ours, era, addrs_sig, hold);
    let unlanded = hold == ListingHold::Unlanded && presence_state(mark, ours, era, addrs_sig) == crate::ChiaPresenceState::Sent;
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
        unlanded,
    }
}

/// Publish this node's presence for `era` under its contact key: encode + sign
/// (iroh key), seal (ck), then the same lease / coin / spend-to-self / push
/// path as the room-keyed publish. Returns the hint written under and what
/// the write left behind ([`MemoWrite`]): an unanswered push is a write all
/// the same — its input is parked and the bundle may be in a mempool — so the
/// caller files it as pending and lets the chain's word settle it
/// ([`presence_step`]), as the knock and beacon writers do. The hint and the
/// seal are `net`'s ([`presence_memo`]).
///
/// It runs [`publish_node_presence_on`] on the process-wide lease, the
/// process's money lane and the wall clock, read where the lease is
/// reconciled, as it always was. Building the lane's handle first reads
/// nothing ([`crate::chia_chain::connect`] does no I/O), so the lease's
/// checks, their order and their errors are the same as before.
pub async fn publish_node_presence(
    net: crate::chia_network::ChiaNet,
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    ck: &[u8; 32],
    era: u64,
    entries: &[AddrEntry],
    now: u64,
) -> Result<(Bytes32, MemoWrite)> {
    let client = crate::chia_chain::connect();
    publish_node_presence_on(&WALLET_LEASE, net, &client, Instant::now, iroh_sk, chia_sk, ck, era, entries, now).await
}

/// [`publish_node_presence`] on a given lease, network, chain and clock (the
/// tests' own on the mock chain): the record sealed for `era` on `net`
/// ([`presence_memo`]), then written by [`publish_memo_on`], paid for by the
/// wallet key `chia_sk`, which the write names as its payer
/// ([`Payer::of`], stage 4 design §4.4). `now` is read once, where the lease
/// is reconciled. `now_unix` dates the record.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn publish_node_presence_on(
    lease: &WalletLease,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    now: impl FnOnce() -> Instant,
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    ck: &[u8; 32],
    era: u64,
    entries: &[AddrEntry],
    now_unix: u64,
) -> Result<(Bytes32, MemoWrite)> {
    let (hint, sealed) = presence_memo(net, iroh_sk, ck, era, entries, now_unix)?;
    let write = publish_memo_on(lease, net, client, now, chia_sk, hint, None, move |_| Ok(sealed), "presence").await?;
    Ok((hint, write))
}

/// The listing for `era` written from this wallet's listing burner P(e)
/// (stage 4 design §3.2, §4.1), on a given lease, gift fuse, network, chain,
/// instant and random source (the tests' own on the mock chain): the record
/// sealed for `era` on `net` ([`presence_memo`]), written by the burner's
/// writer (`claim_write::burner_write_with`) under the gift rules and the
/// fuse (§5.2). The era's first write claims a lobby dish coin in its own
/// bundle, which funds P(e) with the gift g; a rewrite spends P(e)'s one
/// coin. Either way the write names P(e) as its payer ([`Payer::of_burner`]),
/// which the mark files for the hint rule (§8.3), and the money key pays for
/// nothing.
///
/// `root` must be `net`'s ([`crate::chia_burner::BurnerRoot::net`]): P(e)
/// is derived under the listing hint of the root's network and the record is
/// written under `net`'s, and the two are the same hint only on the same
/// network (§3.5). A root of another network is refused before the lease or
/// the chain is asked anything, so nothing is parked or sent.
///
/// `money` is the SSF wallet's payer ([`Payer::of`] its key). While the lease
/// parks a spend it pays for, the era's first write from P(e) waits
/// (`claim_write::BurnerWait::MoneyInFlight`), and goes out once that spend
/// lands; a rewrite from P(e)'s own coin does not wait on it. The wait does
/// not decide the hint: a spend in flight that is this era's listing,
/// pushed by the SSF wallet just before a restart that never saved its
/// mark, would still have P(e) write beside it once it lands, two payers
/// under one hint (§8.3). The heartbeat keeps that from happening before it
/// asks for a write, by filing the lost mark again from the write the lease
/// holds under the hint ([`lost_listing_mark`]), on which the hint rule
/// holds the step ([`burner_listing_step`]).
#[allow(clippy::too_many_arguments)]
async fn publish_node_presence_with<R: rand::Rng + ?Sized + Send>(
    lease: &WalletLease,
    fuse: &std::sync::Mutex<claim_write::GiftFuse>,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    at: Instant,
    root: &crate::chia_burner::BurnerRoot,
    money: Payer,
    iroh_sk: &iroh::SecretKey,
    ck: &[u8; 32],
    era: u64,
    entries: &[AddrEntry],
    now_unix: u64,
    rng: &mut R,
) -> Result<(Bytes32, MemoWrite)> {
    anyhow::ensure!(
        root.net() == net,
        "the listing's burner root is for {} and this write is on {}; nothing is written",
        root.net().name(),
        net.name()
    );
    let (hint, sealed) = presence_memo(net, iroh_sk, ck, era, entries, now_unix)?;
    let key = root.presence(ck, era);
    let write = claim_write::burner_write_with(lease, fuse, net, client, at, &key, era, hint, None, move |_| Ok(sealed), rng, "presence", Some(money)).await?;
    Ok((hint, write))
}

/// [`publish_node_presence_with`] on the node's own lease and gift fuse
/// ([`WALLET_LEASE`], `claim_write::GIFT_FUSE`), the money lane's chain
/// ([`crate::chia_chain::connect`], two agreeing peers, as the burner's
/// writer takes it: stage 4 design §10), the wall clock and the OS random
/// source: the listing the heartbeat writes from P(e) with burner keys on
/// (§4.3, §13 row 10). No test calls it: its lease, fuse and chain are the
/// process's.
#[allow(clippy::too_many_arguments)]
async fn publish_burner_presence(
    net: crate::chia_network::ChiaNet,
    root: &crate::chia_burner::BurnerRoot,
    money: Payer,
    iroh_sk: &iroh::SecretKey,
    ck: &[u8; 32],
    era: u64,
    entries: &[AddrEntry],
    now_unix: u64,
) -> Result<(Bytes32, MemoWrite)> {
    let client = crate::chia_chain::connect();
    publish_node_presence_with(&WALLET_LEASE, &claim_write::GIFT_FUSE, net, &client, Instant::now(), root, money, iroh_sk, ck, era, entries, now_unix, &mut rand::rngs::OsRng)
        .await
}

/// What a presence write files for `era` on `net`: the hint, `ck`'s listing
/// hint on `net`, and the memo, the record encoded, signed (iroh key) and
/// sealed under `ck` on `net`. Both are `net`'s (stage 4 design §3.5:
/// mainnet's carry the network tag). It touches no chain, so chia_resolve's
/// tests file what it gives in a mock chain and read it back on each
/// network.
pub fn presence_memo(
    net: crate::chia_network::ChiaNet,
    iroh_sk: &iroh::SecretKey,
    ck: &[u8; 32],
    era: u64,
    entries: &[AddrEntry],
    now: u64,
) -> Result<(Bytes32, Vec<u8>)> {
    let record = PresenceV2 {
        era,
        node_id: iroh_sk.public(),
        kx_pk: crate::chia_contact::kx_public(&crate::chia_contact::kx_era_secret(iroh_sk, era)),
        issued_at: now,
        expires_at: now + 2 * ERA_SECS,
        addrs: entries.to_vec(),
    };
    let plain = chia_lane::encode_presence_v2(&record, iroh_sk)?;
    let sealed = chia_lane::seal_v2(net, ck, KIND_PRESENCE, era, &plain)?;
    Ok((Bytes32::new(chia_lane::derive_ck_hint(net, ck, era)), sealed))
}

/// What an era-bound write left behind: the coins it is found and judged by,
/// whether the peers acknowledged the push, and the payer its spend was
/// parked under. An unanswered push (`acked` false) is a write all the same
/// — its input is parked and the bundle may be in a mempool — so the knock,
/// beacon and presence writers file it as pending, like an acknowledged one,
/// and let the chain settle it (#272 review; the presence writer since the
/// Phone Book icon's follow-up, which gave its mark the coin to judge).
pub struct MemoWrite {
    /// The coins the write is found and judged by (stage 4 design §4.4): its
    /// `parent`, which the write's own coin names under its hint and which a
    /// mark files as its `coin_id`, and its `parked` input, which the lease
    /// holds, the mark files beside it, and the verdict's spent-height and
    /// lease lookups ask about. One coin for a spend-to-self of one coin
    /// ([`WriteCoins::one`]): the INPUT it consumed. A burner's first write
    /// (`claim_write::build_burner_bundle`) has two: the gift g as its parent
    /// and the dish coin F as its parked input.
    pub coins: WriteCoins,
    pub acked: bool,
    /// The lease's number for the spend (#272 review round 12), kept beside
    /// the write so its verdicts can ask whether the lease still holds it
    /// ([`WalletLease::holds_spend`]). `None` only if the input was not parked
    /// once the push returned, which the lease does not allow.
    pub spend: Option<u64>,
    /// The digest of the memo the write carries
    /// ([`crate::chia_resolve::memo_digest`] of its body, the ciphertext that
    /// is its coin's second memo, made with its bundle by [`memo_bundle`]),
    /// kept on its mark so the verdict confirms
    /// the write only by a coin whose output carries it — not by the same
    /// coin made again by another write of ours from the input. A digest of
    /// public chain data: it holds no key material.
    pub memo: Bytes32,
    /// The payer the lease parked the spend under, whose next write waits on
    /// this one (stage 4 design §4.4). For a write the SSF wallet's keys pay
    /// for it is [`Payer::of`] the paying key: the wallet's for presence and
    /// knocks, the beacon wallet's for the beacon. For a burner's write it is
    /// [`Payer::of_burner`] its key, a first write's too, although the dish
    /// coin F it parked is not at the burner's address. Every write names
    /// one. The marks file its hex ([`Payer::hex`]) beside the coins, for the
    /// hint rule to read (design §8.3).
    pub payer: Payer,
}

/// The shared tail of every era-bound write a wallet key pays for
/// (presence, knock, beacon; with burner keys on, the listing and the knocks
/// have the burner's writer instead, `claim_write`): under
/// the lease, reconcile, refuse while a spend of ours is still settling, pick
/// the payer's largest free coin, spend it to itself carrying `[hint, body]`,
/// push with the input parked under its payer ([`Payer::of`] the key that
/// pays: the wallet's for presence and knocks, the beacon's own for the
/// beacon). Returns what the write left behind ([`MemoWrite`]): the INPUT
/// coin's id as both of its coins — the write's own coin names it as parent,
/// which is how the write is found again under its hint and judged
/// ([`crate::chia_resolve::write_standing`]), and the lease parked it — its
/// payer, the one the lease parked it under, and whether the push was
/// acknowledged.
///
/// Refusing while a spend settles (#231 P6a): a wallet holding more coins
/// would spend ANOTHER one beside the pending write — two records landing for
/// one era, the era's write budget paid twice. The confirmation timeout is a
/// retry for a spend the mempool DROPPED, so a pending one waits for
/// reconciliation's verdict (the heartbeat tries again on its retry cadence).
/// The check is the global one, whatever the pending spend's payer: a pending
/// beacon spend holds a listing and a knock the SSF wallet pays for, and any
/// pending listing or knock holds the beacon, a burner's among them, which
/// is why the beacon lands just after the listing (stage 4 design §2, §4.3
/// T5). Asking per payer ([`WalletLease::outgoing_pending_for`]) is the
/// burner writers' (design §13, PR 10): the knocks' from K(h)
/// (`claim_write::knock_write_with`) wait on K(h)'s spends alone, and the
/// listing's from P(e) (`claim_write::burner_write_with`) on P(e)'s and,
/// before its first write, on the SSF wallet's own
/// (`claim_write::BurnerWait::MoneyInFlight`). Neither waits on the
/// beacon, which B pays for. The spacing that keeps two payers' pushes
/// apart (§4.3 T4) is still to come.
async fn publish_memo(payer: &SecretKey, hint: Bytes32, body: Vec<u8>, what: &str) -> Result<MemoWrite> {
    publish_memo_with(payer, hint, None, move |_| Ok(body), what).await
}

/// [`publish_memo`] whose body is built once the INPUT coin is chosen: `body`
/// gets the id of the coin the carrier will name as its PARENT — here the
/// input, which a spend-to-self's new coin names (a burner's first write
/// passes the gift g instead, `claim_write::burner_write_with`, stage 4
/// design §4.1) — so a write can bind its sealing to it
/// ([`chia_lane::seal_to_kx`], #272 review round 3). With a `gate`, `body`
/// runs and the spend is pushed UNDER it, as [`publish_memo_on`] does. Its
/// one caller is [`publish_memo`], the beacon's, with no gate: the knock,
/// whose authorization is read again under the card gate (#272 review round
/// 5), reaches [`publish_memo_on`] through its own seam
/// ([`publish_knock_on`]), on the network its caller names.
///
/// It runs [`publish_memo_on`] on the process-wide lease, the process's
/// network and money lane, and the wall clock, read where the lease is
/// reconciled, as it always was. Building the lane's handle before the
/// lease's gate reads nothing ([`crate::chia_chain::connect`] does no I/O),
/// so the lease's checks, their order and their errors are the same as
/// before.
async fn publish_memo_with(
    payer: &SecretKey,
    hint: Bytes32,
    gate: Option<&tokio::sync::Mutex<()>>,
    body: impl FnOnce(Bytes32) -> Result<Vec<u8>>,
    what: &str,
) -> Result<MemoWrite> {
    let client = crate::chia_chain::connect();
    publish_memo_on(&WALLET_LEASE, crate::chia_network::net(), &client, Instant::now, payer, hint, gate, body, what).await
}

/// [`publish_memo_with`] on a given lease, network, chain and clock: the
/// process-wide ones in production, a test's own on the mock chain. `now`
/// is read once, when the lease is reconciled
/// ([`WalletLease::reconcile_at`]). The checks are the money writer's, in
/// its order: the lease's gate, the lease open, the reconciliation, the
/// global check that no spend on `lease` is still settling, whatever its
/// payer ([`WalletLease::outgoing_pending`], kept on purpose until the
/// burner writers space their payers, stage 4 design §4.3 T4), then the
/// payer's largest coin `lease` does not hold ([`find_spendable_coin_on`]).
/// With a `gate`, `body` runs and the spend is pushed UNDER it: a knock's
/// authorization is read again there ([`publish_knock_on`]), after the lease
/// and coin lookups, so a room's word that changed while the spend was
/// prepared is seen (`body` answers [`Withdrawn`]) and no cap can land
/// between that check and the push — the card gate's own contract (#272
/// review round 5). The spend is parked on `lease` under [`Payer::of`]
/// `payer`, which the write names (§4.4).
#[allow(clippy::too_many_arguments)]
async fn publish_memo_on(
    lease: &WalletLease,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    now: impl FnOnce() -> Instant,
    payer: &SecretKey,
    hint: Bytes32,
    gate: Option<&tokio::sync::Mutex<()>>,
    body: impl FnOnce(Bytes32) -> Result<Vec<u8>>,
    what: &str,
) -> Result<MemoWrite> {
    let _lease = lease.lock().await;
    lease.ensure_open()?;
    lease.reconcile_at(net, client, now()).await;
    if lease.outgoing_pending() {
        return Err(MemoWait::Settling(what.to_string()).into());
    }
    let our_ph = our_puzzle_hash(payer);
    let coin = find_spendable_coin_on(lease, client, our_ph).await?.ok_or(MemoWait::Unfunded(our_ph))?;
    let input = coin.coin.coin_id();
    let _gate = match gate {
        Some(gate) => Some(gate.lock().await),
        None => None,
    };
    let (bundle, memo) = memo_bundle(net, payer, coin.coin, hint, body(input)?)?;
    // The spend's number is the lease's for its PARKED input, the coin it holds.
    let coins = WriteCoins::one(input);
    // The payer the input is parked under is the one the write names.
    let paid_by = Payer::of(payer);
    match push_parked_with(lease, client, paid_by, bundle, [(input, coin.confirmed_height)]).await {
        Ok(()) => Ok(MemoWrite { coins, acked: true, spend: lease.spend_of(&coins.parked), memo, payer: paid_by }),
        // Indeterminate, not failed: the bundle may be in a mempool and the
        // input is parked. Reported as a write, so the caller files it as
        // pending and lets the chain's word settle it — filed as a failure it
        // would be written AGAIN beside the first once the lease frees the
        // coin (#272 review).
        Err(PushError::Unanswered(e)) => {
            eprintln!("⛓️ ChiaHub {what}: the push went unanswered ({e:#}) — filed as pending; the chain's word settles it");
            Ok(MemoWrite { coins, acked: false, spend: lease.spend_of(&coins.parked), memo, payer: paid_by })
        }
        Err(e) => Err(e.into()),
    }
}

/// Why a write the SSF wallet pays for ([`publish_memo_with`]) did not go
/// out this time although nothing about it is wrong: it waits, and the
/// heartbeat tries again on its retry cadence. The text is the one the log
/// has always said; the type lets the knock arm tell a wait from a failure
/// by downcasting ([`is_typed_wait`], stage 4 design §5.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MemoWait {
    /// A spend of ours is still settling ([`WalletLease::outgoing_pending`]),
    /// so the write it names waits for its verdict (#231 P6a).
    Settling(String),
    /// The wallet holds no free coin at its puzzle hash, the one named.
    Unfunded(Bytes32),
}

impl std::fmt::Display for MemoWait {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemoWait::Settling(what) => write!(f, "a spend from this wallet is still settling — the {what} write waits for its verdict"),
            MemoWait::Unfunded(puzzle_hash) => write!(f, "chia wallet unfunded — no unspent coin at puzzle hash {puzzle_hash}"),
        }
    }
}

impl std::error::Error for MemoWait {}

// ── #231 P6b: knocks and beacons ─────────────────────────────────────────────

/// D7: the beacon role is opt-in (`SSF_CHIA_BEACON=1`): a public entry point
/// that keeps the welcome room served and lets a newcomer with nobody to dial
/// find it. Off by default, since the beacon hint is derivable by anyone and a
/// roster of every active node id would be a public weekly directory.
pub fn beacon_enabled() -> bool {
    std::env::var("SSF_CHIA_BEACON").ok().as_deref() == Some("1")
}

/// The variable that turns burner keys on for a run (stage 4 design §8 (2),
/// §13 row 9): `SSF_CHIA_BURNERS=1`, on a test network only.
pub const BURNERS_ENV: &str = "SSF_CHIA_BURNERS";

/// Whether [`BURNERS_ENV`] set to `raw` turns burner keys on for `net`, and
/// the line said once a wallet loads (stage 4 design §8 (2)). Exactly `1` on
/// a test network turns them on, and the line says what that does in this
/// build: the Phone Book listing written from the wallet's listing burner
/// P(e), funded by the lobby dish, at its slot, after a late start or at
/// once for a newcomer (§4.3, [`burner_listing_step`]); each knock written
/// from its own burner key K(h), funded the same way, once per host and
/// room per edition, since K(h) is one key per host and inbox hint, the
/// host's for one room's lane in one era ([`knock_burner`]), and it writes
/// once (§3.2, §4.1, the knock row, [`publish_knock_with`]); the knock rule of §5.2
/// ([`knock_attempt_counts`]), under which a knock that only waits, for a
/// dish coin, for the fuse once the edition's
/// `claim_write::MAX_GIFTS_PER_ERA` gifts are given, for a spend still
/// settling or for an unread chain, uses none of its attempts; and the
/// claim-and-write self-test hook it opens ([`claim_write_selftest`]), with
/// the beacon paid as before. The line names no busy chain among the waits:
/// a push refused for its fee still uses an attempt (§10). Exactly `1` off
/// a test network is ignored with a line: there no memo spend leaves the
/// money key ([`refuse_money_memo`]), and nothing exits or changes. Any
/// other value (unset, empty, `0`, `true`, a stray space, not UTF-8) is off
/// and says nothing, whatever the network, as a hook's does (main.rs
/// `test_hook`). It reads no environment, so its tests ask it every value
/// on every network.
pub fn burners_of(net: crate::chia_network::ChiaNet, raw: Option<&std::ffi::OsStr>) -> (bool, Option<String>) {
    if raw != Some(std::ffi::OsStr::new("1")) {
        return (false, None);
    }
    if !net.is_test() {
        return (false, Some(format!("⛓️ ChiaHub: {BURNERS_ENV}=1 is ignored on {}. Burner keys are tried on a test network only.", net.name())));
    }
    let line = format!(
        "⛓️ ChiaHub burners ({BURNERS_ENV}=1): on for {}. The Phone Book listing is written from a burner key the lobby dish funds, and goes out in each edition's first day, within about an hour of coming online after it, or at once for a station not listed last edition. Each knock is written from a burner key of its own, funded the same way, once per host and room per edition: a knock's key that has written is never written again. A knock that only waits (no mojo ready in the lobby dish, the edition's {} gifts given, a spend still settling, the chain unread) uses none of its {MAX_KNOCK_ATTEMPTS} attempts and is tried again in {} minutes. SSF_CHIA_CLAIM_WRITE_TEST=1 runs one claim-and-write from the lobby dish at startup. The beacon is still paid as before.",
        net.name(),
        claim_write::MAX_GIFTS_PER_ERA,
        HEARTBEAT_RETRY_SECS / 60
    );
    (true, Some(line))
}

/// The process's [`BURNERS_ENV`] on its network ([`burners_of`]), read once,
/// as `chia_wallet_switch::env_switch` reads `SSF_CHIA_LANE`: the startup
/// line, the heartbeat's listing and knock paths and its knock rule, the
/// dish's count of the wallet's spends in flight ([`wallet_spending`]) and
/// the self-test hook see the same value. The network is settled before
/// anything asks.
pub fn burners() -> &'static (bool, Option<String>) {
    static BURNERS: std::sync::OnceLock<(bool, Option<String>)> = std::sync::OnceLock::new();
    BURNERS.get_or_init(|| burners_of(crate::chia_network::net(), std::env::var_os(BURNERS_ENV).as_deref()))
}

/// Whether burner keys are on for this run ([`burners`]).
pub fn burners_enabled() -> bool {
    burners().0
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
/// Attempts of a knock that failed to leave before the request is dropped;
/// the next dial exhaustion queues it again. With burner keys off every
/// failure is one, as it always was. With them on ([`burners_enabled`],
/// stage 4 design §5.2) a knock is written from its own burner key K(h),
/// and one that only waits ([`is_typed_wait`]: K(h)'s spend in flight or
/// settling, its listing cut short, no dish coin ready, the edition's gifts
/// all given, the lease not parking, the chain unread) is none, and the
/// knock arm tries again after [`HEARTBEAT_RETRY_SECS`] ([`knock_paced`]);
/// every other failure, a push the peers refused among them, is one
/// ([`knock_attempt_counts`]). A push refused because the chain is busy
/// ([`chain_busy`]) is such a refusal, and uses one (§10: a first push
/// refused for its fee is a rejection). A knock
/// withdrawn at spend time ([`Withdrawn`]), or found already written by its
/// own key (`claim_write::AlreadyKnocked`, §4.1, the knock row), uses none
/// either way: it is dropped with one line, not tried again
/// ([`knock_not_written`]).
pub const MAX_KNOCK_ATTEMPTS: u8 = 3;

/// Whether `e` is a wait rather than a failure (stage 4 design §5.2, §10):
/// somewhere in its chain is one of the typed reasons a write did not go
/// out although nothing about the write is wrong, so the same write tried
/// later can go out. They are:
/// - [`MemoWait`]: the SSF wallet still settling a spend, or unfunded;
/// - `claim_write::BurnerWait`: a burner's every wait (its spend in flight
///   or settling, its listing cut short, no peak, no dish coin ready, the
///   fuse blown, and for the listing's first write a spend of the SSF
///   wallet's in flight);
/// - `chia_faucet::ClaimToError::NoCoinReady` and `PeakUnavailable`: a dry
///   or griefed dish, or no peak to judge it by;
/// - [`LeaseError`] and [`PushError::NotSent`]: the lease sealed, or not
///   parking the spend, so nothing left;
/// - a failed chain read: a [`ChainError`], or a coin listing that failed
///   (`chia_faucet::CoinLookupFailed`).
///
/// Nothing else is a wait: a push every peer refused
/// ([`PushError::Rejected`], a lost race among them), a body that could not
/// be built or sealed, a builder's error or a broken burner rule
/// (`claim_write::BurnerRule`), a refused claim, and anything untyped. Nor
/// is a knock whose own key already wrote (`claim_write::AlreadyKnocked`,
/// §4.1, the knock row), which is no `BurnerWait`: tried again, it reads the
/// same records under the same key. It never reaches [`knock_failed`], which
/// would count it as an attempt and queue it again: [`knock_not_written`]
/// drops it first.
fn is_typed_wait(e: &anyhow::Error) -> bool {
    use crate::chia_faucet::{ClaimToError, CoinLookupFailed};
    e.chain().any(|cause| {
        cause.is::<MemoWait>()
            || cause.is::<claim_write::BurnerWait>()
            || matches!(cause.downcast_ref::<ClaimToError>(), Some(ClaimToError::NoCoinReady | ClaimToError::PeakUnavailable))
            || cause.is::<LeaseError>()
            || matches!(cause.downcast_ref::<PushError>(), Some(PushError::NotSent(_)))
            || cause.is::<ChainError>()
            || cause.is::<CoinLookupFailed>()
    })
}

/// The name a full node gives a bundle whose fee its full mempool will not
/// take: every SSF write pays a fee of 0, so this is what a busy chain
/// answers it (stage 4 design §10, Mempool full; that a full mempool refuses
/// fee 0 is the design's inference). The mock chain's full mempool answers
/// it too (`MockChain::set_full`).
const FEE_TOO_CLOSE_TO_ZERO: &str = "INVALID_FEE_TOO_CLOSE_TO_ZERO";

/// Whether a push every peer refused with `reason` was refused only because
/// the chain is busy (stage 4 design §10, Mempool full). `reason` is the
/// peers' reasons as the lane joins them, one per peer, separated by "; "
/// (`chia_peer_lane::push_verdict`). It is busy only when every peer's
/// reason names [`FEE_TOO_CLOSE_TO_ZERO`]: a peer that gave any other
/// reason, a final one such as a lost race's DOUBLE_SPEND or a policy one
/// such as UNKNOWN_UNSPENT, says the push may fail for more than the chain
/// being busy, and the refusal is read as it always was, by its own text.
/// Another fee code is not read as busy either.
fn refusal_is_chain_busy(reason: &str) -> bool {
    reason.split("; ").all(|peer| peer.contains(FEE_TOO_CLOSE_TO_ZERO))
}

/// Whether `e` is a push every peer refused because the chain is busy
/// ([`refusal_is_chain_busy`]): somewhere in its chain is a
/// [`PushError::Rejected`] for that reason alone. It is still a refusal, and
/// so no wait ([`is_typed_wait`]): a first push refused for its fee is a
/// rejection (stage 4 design §10), its input handed back, and a knock it
/// refuses uses an attempt (§5.2). Only the words change, with burner keys
/// on ([`knock_failure_words`], [`beacon_failure_line`]).
fn chain_busy(e: &anyhow::Error) -> bool {
    e.chain().any(|cause| matches!(cause.downcast_ref::<PushError>(), Some(PushError::Rejected(why)) if refusal_is_chain_busy(why)))
}

/// How a log line names a push refused because the chain is busy
/// ([`chain_busy`]), in place of the peers' own reasons. It names no key,
/// hash or address.
const CHAIN_BUSY_WORDS: &str = "the chain is busy (a full mempool refused its zero fee)";

/// Why a knock failed with `e`, in the knock arm's failure line
/// ([`knock_failed`]): with burner keys on (`burners`), a push refused
/// because the chain is busy reads [`CHAIN_BUSY_WORDS`] (stage 4 design
/// §10), and it still uses an attempt (§5.2). Every other failure, and
/// every failure with burner keys off, reads `e`'s own text, as on main.
fn knock_failure_words(burners: bool, e: &anyhow::Error) -> String {
    if burners && chain_busy(e) {
        CHAIN_BUSY_WORDS.to_string()
    } else {
        format!("{e:#}")
    }
}

/// The beacon arm's line for the era `era` beacon's write that failed with
/// `e`. With burner keys on (`burners`), a push refused because the chain
/// is busy ([`chain_busy`]) says the beacon waits and that waiting costs
/// nothing (stage 4 design §10, Mempool full): the refused push paid
/// nothing, and the arm tries again on its retry cadence, as after every
/// failure. Every other failure, and every failure with burner keys off,
/// gets the line it always had, word for word.
fn beacon_failure_line(burners: bool, era: u64, e: &anyhow::Error) -> String {
    if burners && chain_busy(e) {
        format!(
            "⛓️ ChiaHub beacon: the era {era} beacon waits — {CHAIN_BUSY_WORDS}; waiting costs nothing (retry in {} min)",
            HEARTBEAT_RETRY_SECS / 60
        )
    } else {
        format!(
            "⛓️ ChiaHub beacon: publish for era {era} failed: {e:#} (retry in {} min; the beacon wallet is funded separately)",
            HEARTBEAT_RETRY_SECS / 60
        )
    }
}

/// Whether `e` says the lobby dish had no coin ready for a burner's gift
/// (stage 4 design §10, Dish dry or griefed): somewhere in its chain is
/// `claim_write::BurnerWait::NoCoinReady`, as the burner's writer gives it,
/// or the claim's own `chia_faucet::ClaimToError::NoCoinReady`.
fn dish_dry(e: &anyhow::Error) -> bool {
    use crate::chia_faucet::ClaimToError;
    e.chain().any(|cause| {
        matches!(cause.downcast_ref::<claim_write::BurnerWait>(), Some(claim_write::BurnerWait::NoCoinReady))
            || matches!(cause.downcast_ref::<ClaimToError>(), Some(ClaimToError::NoCoinReady))
    })
}

/// Whether `e` says the era's first listing from P(e) waits on a spend the
/// SSF wallet pays for, still parked (stage 4 design §8.3, the crash window):
/// somewhere in its chain is `claim_write::BurnerWait::MoneyInFlight`.
fn money_in_flight(e: &anyhow::Error) -> bool {
    e.chain().any(|cause| matches!(cause.downcast_ref::<claim_write::BurnerWait>(), Some(claim_write::BurnerWait::MoneyInFlight)))
}

/// The Phone Book's words for a listing from a burner key that failed with
/// `e` (stage 4 design §10). A dry dish ([`dish_dry`]) and a busy chain
/// ([`chain_busy`]) get §10's own sentences, which say that the station
/// tries again and, where `last_week` says last era's listing is still read,
/// that it still works. A first write waiting on a spend of the SSF wallet's
/// ([`money_in_flight`], §8.3) says it goes out once that spend lands, in
/// the same way. Every other failure reads as its own text (`{e:#}`), as the
/// readout always gave it: a lost race's refusal, another wait of the
/// burner's, the lease's errors. None of the sentences names a key, a hash
/// or an address.
fn listing_failure_words(e: &anyhow::Error, last_week: bool) -> String {
    if dish_dry(e) {
        let still = if last_week { " Last week's listing still works." } else { "" };
        format!("The lobby dish has no mojo ready. Your station tries again every few minutes.{still}")
    } else if chain_busy(e) {
        if last_week {
            "The chain is busy. Your listing waits for room. Waiting costs nothing, and last week's listing still works.".to_string()
        } else {
            "The chain is busy. Your listing waits for room. Waiting costs nothing.".to_string()
        }
    } else if money_in_flight(e) {
        let still = if last_week { " Last week's listing still works." } else { "" };
        format!("A spend from the SSF wallet is still on its way. Your listing goes out once it lands.{still}")
    } else {
        format!("{e:#}")
    }
}

/// The listing arm's log line for the era `era` listing's write that failed
/// with `e`. With the SSF wallet paying (`burner_path` false) it is the line
/// it always was, word for word. On the burner path a wait
/// ([`is_typed_wait`]) says the listing waits, and a push refused because
/// the chain is busy ([`chain_busy`]) says so in [`CHAIN_BUSY_WORDS`] and
/// that waiting costs nothing (stage 4 design §10, Mempool full): it is a
/// refusal, which paid nothing, and the arm tries again on its retry cadence,
/// as after every failure. Anything else failed, in its own text. The
/// burner's waits, the lane's refusals and the lease's errors name no key,
/// puzzle hash or address of the burner, so neither does the line.
fn listing_failure_line(burner_path: bool, era: u64, e: &anyhow::Error) -> String {
    let retry = HEARTBEAT_RETRY_SECS / 60;
    if !burner_path {
        format!("⛓️ ChiaHub presence: publish for era {era} failed: {e:#} (retry in {retry} min)")
    } else if chain_busy(e) {
        format!("⛓️ ChiaHub presence: the era {era} listing waits — {CHAIN_BUSY_WORDS}; waiting costs nothing (retry in {retry} min)")
    } else {
        let verb = if is_typed_wait(e) { "waits" } else { "failed" };
        format!("⛓️ ChiaHub presence: the era {era} listing {verb}: {e:#} (retry in {retry} min)")
    }
}

/// Whether a knock that failed with `e` uses one of its
/// [`MAX_KNOCK_ATTEMPTS`]. With burner keys off (`burners` false) every
/// failure does, so the knock arm is today's. With them on, a wait
/// ([`is_typed_wait`]) does not, and every other failure does. That is how
/// this node reads "only a push the peers refused counts" (stage 4 design
/// §5.2): a dry dish, an unfunded wallet or an unread chain never ends a
/// knock, while a request that can never leave, such as one to a host card
/// whose key cannot be sealed to, is still dropped after its attempts, as on
/// main, instead of being tried for ever.
fn knock_attempt_counts(burners: bool, e: &anyhow::Error) -> bool {
    !burners || !is_typed_wait(e)
}

/// Whether the knock arm may try at `now`, the last knock that waited having
/// waited at `wait` ([`knock_attempt_counts`]): at once if none did, and
/// otherwise once [`HEARTBEAT_RETRY_SECS`] have passed, so a wait does not
/// take every tick from the beacon and the rooms (stage 4 design §5.2:
/// attempts are paced by the retry).
fn knock_paced(wait: Option<Instant>, now: Instant) -> bool {
    wait.is_none_or(|at| now.duration_since(at) >= Duration::from_secs(HEARTBEAT_RETRY_SECS))
}

/// What the knock arm does with `req` once its knock failed with `e` at
/// `now`, on the heartbeat's own `queue` and `wait` (stage 4 design §5.2).
/// With burner keys on (`burners`), a wait ([`knock_attempt_counts`]) keeps
/// its attempts and goes back in the queue, and the arm rests from `now`
/// (`wait`, which [`knock_paced`] reads). Every other failure, and every
/// failure with them off, uses an attempt: the request goes back in the
/// queue while it has attempts left and is dropped after its
/// [`MAX_KNOCK_ATTEMPTS`]th, `wait` left as it was, so with burner keys off
/// the arm is main's. Each case says so in the log, a failure in
/// [`knock_failure_words`]: with burner keys on, a push refused because the
/// chain is busy is named so, and uses an attempt like any refusal.
fn knock_failed(burners: bool, mut req: KnockRequest, e: &anyhow::Error, now: Instant, queue: &mut std::collections::VecDeque<KnockRequest>, wait: &mut Option<Instant>) {
    if !knock_attempt_counts(burners, e) {
        *wait = Some(now);
        eprintln!(
            "⛓️ ChiaHub knock: knock on {} for room {} waits: {e:#} — not an attempt; tried again in {} min",
            short(&req.host),
            req.room,
            HEARTBEAT_RETRY_SECS / 60
        );
        queue.push_back(req);
        return;
    }
    req.attempts = req.attempts.saturating_add(1);
    let why = knock_failure_words(burners, e);
    if req.attempts < MAX_KNOCK_ATTEMPTS {
        eprintln!("⛓️ ChiaHub knock: knock on {} for room {} failed: {why} (retry next tick)", short(&req.host), req.room);
        queue.push_back(req);
    } else {
        eprintln!(
            "⛓️ ChiaHub knock: knock on {} for room {} failed {} times: {why} — dropped; the next dial exhaustion asks again",
            short(&req.host),
            req.room,
            req.attempts
        );
    }
}

/// The first `claim_write::AlreadyKnocked` in `e`'s chain, if any: a knock
/// whose own key K(h) already wrote this era (stage 4 design §4.1, the knock
/// row: K(h) is never spent again). It is read through the whole chain, so
/// a writer's context around it still finds it.
fn already_knocked(e: &anyhow::Error) -> Option<&claim_write::AlreadyKnocked> {
    e.chain().find_map(|cause| cause.downcast_ref::<claim_write::AlreadyKnocked>())
}

/// The one line the knock arm prints for a knock that is not written and is
/// not tried again, or `None` for every other error, which goes to
/// [`knock_failed`] ([`knock_not_written`]). There are two such knocks:
/// - one [`Withdrawn`] at spend time (#272 review round 5): the room's word
///   changed while the spend was prepared. Its line is the one the knock arm
///   always gave it, word for word, and it is read as the arm always read
///   it, from the error itself;
/// - one whose own key K(h) already wrote this era
///   (`claim_write::AlreadyKnocked`, stage 4 design §4.1, the knock row; §9:
///   a coin K(h) wrote means "already knocked"). It uses no attempt, and this
///   run does not knock on that host again this era ([`ChainKnocked`]); a
///   restart reads the key's coins again and gets the same answer.
///
/// Each line names the host by its shortened node id ([`short`]) and the
/// room, and no key, puzzle hash or address: `AlreadyKnocked`'s text names
/// none.
fn knock_dropped_line(req: &KnockRequest, e: &anyhow::Error) -> Option<String> {
    if e.downcast_ref::<Withdrawn>().is_some() {
        return Some(format!(
            "⛓️ ChiaHub knock: not knocking on {} for room {} — {e} (the room's word changed while the spend was prepared)",
            short(&req.host),
            req.room
        ));
    }
    already_knocked(e).map(|already| {
        format!(
            "⛓️ ChiaHub knock: not knocking on {} for room {} — {already} (no attempt used; this host is not knocked on again this era by this run)",
            short(&req.host),
            req.room
        )
    })
}

/// The hosts this run found its own knock already written to in one era
/// (`claim_write::AlreadyKnocked`, stage 4 design §9), so that the knock arm
/// skips them for the rest of that era ([`knock_skipped`]): the next dial
/// exhaustion queues the knock again, and without this each one would read
/// K(h)'s coins again only to find the same answer. It is per host,
/// whatever the room, as the knock book's rule of one knock per host per era
/// is (`KnockBook::knocked_this_era`, §5.2). RAM only, like the queue: a
/// restart reads the key's coins once more. It holds one era at a time, and
/// a note for another era forgets the one before. A note is not judged again
/// within the era: a reorganization that later takes away the records that
/// answered (§10, Reorg) does not bring the host back before the era ends.
#[derive(Debug, Default, PartialEq, Eq)]
struct ChainKnocked {
    era: u64,
    hosts: HashSet<String>,
}

impl ChainKnocked {
    /// Note that `host`'s knock in `era` was already written by its own key.
    /// A note for another era than the one held forgets that era's hosts.
    fn note(&mut self, host: &str, era: u64) {
        if era != self.era {
            self.era = era;
            self.hosts.clear();
        }
        self.hosts.insert(host.to_string());
    }

    /// Whether `host` was noted in `era`.
    fn holds(&self, host: &str, era: u64) -> bool {
        self.era == era && self.hosts.contains(host)
    }
}

/// Whether the knock arm skips a queued request to `host` in `era` without
/// trying it: the knock book holds a knock on that host this era
/// (`KnockBook::knocked_this_era`, one knock per host per era, stage 4
/// design §5.2), or this run found that host's knock already written by its
/// own key ([`ChainKnocked`]). Either way it is per host, whatever the room.
fn knock_skipped(book: &KnockBook, found: &ChainKnocked, host: &str, era: u64) -> bool {
    book.knocked_this_era(host, era) || found.holds(host, era)
}

/// What the knock arm does with `req` once its knock in `era` was not
/// written, with `e`, at `now`, on the heartbeat's own `queue`, `wait` and
/// `found` (stage 4 design §5.2). A knock withdrawn at spend time, or one
/// whose own key already wrote ([`knock_dropped_line`]), is dropped with its
/// one line: it is not queued again, it uses no attempt, and the arm's rest
/// (`wait`) is left as it was. One already written also notes its host in
/// `found`, so the arm skips that host for the rest of the era
/// ([`knock_skipped`]). Every other error goes to [`knock_failed`], exactly
/// as before.
///
/// `claim_write::AlreadyKnocked` is no typed wait ([`is_typed_wait`]), and
/// [`knock_failed`] would count it as an attempt and queue it again, to read
/// the same records under the same key: so it is caught here, before
/// [`knock_failed`].
#[allow(clippy::too_many_arguments)]
fn knock_not_written(
    burners: bool,
    req: KnockRequest,
    e: &anyhow::Error,
    era: u64,
    now: Instant,
    queue: &mut std::collections::VecDeque<KnockRequest>,
    wait: &mut Option<Instant>,
    found: &mut ChainKnocked,
) {
    let Some(line) = knock_dropped_line(&req, e) else {
        knock_failed(burners, req, e, now, queue, wait);
        return;
    };
    if already_knocked(e).is_some() {
        found.note(&req.host, era);
    }
    println!("{line}");
}

/// The line the knock arm prints once a knock for `host` in `room` is
/// written in `era` under `hint`, its push acknowledged (`acked`) or
/// unanswered. With burner keys off it is the line the arm always gave,
/// word for word. Written from its own burner key K(h) (`from_burner`, the
/// burner path: stage 4 design §4.1, the knock row), it says so at its end,
/// as the listing's line names its edition's key. It names the host by its
/// shortened node id ([`short`]) and the hint by its first 16 hex digits,
/// and no key, puzzle hash or address: who paid is said by kind alone.
fn knock_sent_line(acked: bool, host: &str, room: &str, era: u64, hint: Bytes32, from_burner: bool) -> String {
    let hint_hex = hex::encode(hint.to_bytes());
    format!(
        "⛓️ ChiaHub knock: {} on {} for room {room} in era {era} · inbox hint {} — both sides dial on the confirmation height{}",
        if acked { "knocked" } else { "knock pushed, unanswered (filed as pending; the chain's word settles it)" },
        short(host),
        &hint_hex[..16],
        if from_burner { " · from its own burner key" } else { "" }
    )
}

/// The beacon's own wallet key, funded SEPARATELY (its address is printed at
/// startup): a clear-text node id must never share coin lineage with the
/// sealed records (D7). It is blake3 of the WALLET key (m/12381/8444/2/0,
/// chia_wallet.rs) then `from_seed`, so no second secret is kept, and
/// deliberately off every m/12381/8444/2/* path, so Sage and the Chia wallet
/// restoring the node's 24 words never see or co-spend beacon coins (only
/// Star Station brings the beacon back from the words). Its address changes
/// with every re-mint.
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
    /// The parent of the beacon's own coin, hex: the coin whose spend made the
    /// coin carrying the beacon under the hint, which is how the write is
    /// found again ([`crate::chia_resolve::child_under_hint`]). For a beacon
    /// the beacon wallet pays for, and for a burner's rewrite, it is also the
    /// input the spend consumed; for a burner's first write it is the gift g,
    /// and `parked` names the dish coin F the spend consumed (stage 4 design
    /// §4.1, §4.4).
    #[serde(default)]
    pub coin_id: String,
    /// The digest of the memo the beacon carried, hex
    /// ([`crate::chia_resolve::memo_digest`]): only a coin whose output
    /// carries it confirms the beacon, not the same coin made again by
    /// another write of ours from its input. A digest of public chain data:
    /// it holds no key material. Empty in a mark an older node wrote, which
    /// is judged by its hint alone.
    #[serde(default)]
    pub memo: String,
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
    /// The on-chain input the wallet lease parked for the beacon's spend,
    /// hex, as the presence mark files it ([`NodePublishMark::parked`]): the
    /// same coin as `coin_id` for every write but a burner's first, whose
    /// `coin_id` is the gift g and whose parked input is the dish coin F.
    /// Empty in a mark an older node wrote, whose one coin is both.
    #[serde(default)]
    pub parked: String,
    /// Who paid for the beacon, as the lease parked its spend: the payer's
    /// [`Payer::hex`] text, the beacon wallet's ([`Payer::of`] its key) for a
    /// beacon it pays for and the burner's for a burner's, filed to be
    /// compared as text and never parsed back (stage 4 design §4.4, PR 10).
    /// Every beacon this build files names one. `None` in a mark an older
    /// node wrote, whose beacon the beacon wallet paid for.
    #[serde(default)]
    pub payer: Option<String>,
}

impl BeaconMark {
    /// The mark a beacon write leaves once its push returned: pending until
    /// the chain's word, naming what its lookup judges it by — its coins (its
    /// parent and its parked input, stage 4 design §4.4), its hint, the
    /// digest of its memo and the lease's number for its spend — and its
    /// payer, the one the lease parked the spend under.
    pub fn written(era: u64, last_at: u64, hint: Bytes32, write: &MemoWrite, node_id: String) -> Self {
        BeaconMark {
            era,
            last_at,
            hint: hex::encode(hint.to_bytes()),
            node_id: Some(node_id),
            coin_id: hex::encode(write.coins.parent.to_bytes()),
            memo: hex::encode(write.memo.to_bytes()),
            confirmed: false,
            confirmed_height: 0,
            settled: false,
            spend: write.spend,
            parked: hex::encode(write.coins.parked.to_bytes()),
            payer: Some(write.payer.hex()),
        }
    }

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
/// lookups reads pending, not dead. The coin under the hint confirms the
/// beacon only if its output carries the memo whose digest the mark keeps
/// (an older node's mark keeps none: its hint alone).
pub async fn beacon_standing(client: &impl ChainAccess, mark: &BeaconMark) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    beacon_standing_on(&WALLET_LEASE, crate::chia_network::net(), client, mark).await
}

/// [`beacon_standing`] against a given lease on `net` (the tests' own). The
/// mark's coins ([`WriteCoins::filed`]: its `coin_id` and the `parked` input
/// beside it, one coin in a mark an older node saved) and its hint are
/// parsed first, so a mark that names no coin, or a malformed coin, parked
/// input or hint, is `None` (nothing to judge) before the lease or the chain
/// is asked; a memo digest it does not keep, or keeps malformed, is none, and
/// the coin is judged by its hint alone.
async fn beacon_standing_on(
    lease: &WalletLease,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    mark: &BeaconMark,
) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    let coins = WriteCoins::filed(&mark.coin_id, &mark.parked)?;
    let hint = crate::chia_resolve::parse_hex32(&mark.hint)?;
    let memo = crate::chia_resolve::parse_hex32(&mark.memo);
    write_standing_on(lease, net, client, coins, hint, memo, mark.spend, mark.confirmed_height, "beacon").await
}

/// 📖 The chain's word on this node's presence write ([`beacon_standing`] for
/// the listing the Phone Book's icon stands on): its standing, and whether a
/// listing judged past the height it was confirmed at lacks its coin.
pub async fn presence_standing(client: &impl ChainAccess, mark: &NodePublishMark) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    presence_standing_on(&WALLET_LEASE, crate::chia_network::net(), client, mark).await
}

/// [`presence_standing`] against a given lease on `net` (the tests' own),
/// the mark read as [`beacon_standing_on`] reads a beacon's.
async fn presence_standing_on(
    lease: &WalletLease,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    mark: &NodePublishMark,
) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    let coins = WriteCoins::filed(&mark.coin_id, &mark.parked)?;
    let hint = crate::chia_resolve::parse_hex32(&mark.hint)?;
    let memo = crate::chia_resolve::parse_hex32(&mark.memo);
    write_standing_on(lease, net, client, coins, hint, memo, mark.spend, mark.confirmed_height, "presence").await
}

/// A write's standing against `lease` on `net` (the process-wide ones in
/// production; tests bring their own, and read no environment): the lease's
/// word on the write's input and whether it still holds `spend`, then the
/// write's own coin under `hint` — carrying the memo of digest `memo`, when
/// the mark keeps one ([`crate::chia_resolve::child_under_hint`]) — and the
/// input's spent height, judged
/// together by [`crate::chia_resolve::write_standing`], with whether a
/// listing judged past `confirmed_height` lacks the coin; `None` when the
/// chain could not be asked. Each lookup asks about its own coin of the write
/// (stage 4 design §4.4): the lease's word and the spent height about
/// `coins.parked`, the input the lease parked for the spend, and the hint
/// lookup about `coins.parent`, which the write's own coin names as its
/// parent. For a spend-to-self of one coin ([`WriteCoins::one`]) the two
/// are that coin, so every lookup is the one it always was, in the order it
/// always ran: the lease first (#272 review round 2), then the hint, then
/// the input. For a burner's first write (`claim_write::build_burner_bundle`)
/// the hint lookup asks about the gift g and the other two about the dish
/// coin F, in the same order.
#[allow(clippy::too_many_arguments)]
async fn write_standing_on(
    lease: &WalletLease,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    coins: WriteCoins,
    hint: Bytes32,
    memo: Option<Bytes32>,
    spend: Option<u64>,
    confirmed_height: u32,
    what: &str,
) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
    let spends: Vec<u64> = spend.into_iter().collect();
    let (words, held) = lease_standing_on(lease, net, client, &[coins.parked], &spends).await;
    let word = words.get(&coins.parked).copied().unwrap_or(LeaseWord::Unknown);
    let ours = spend.is_some_and(|s| held.contains(&s));
    let child = match crate::chia_resolve::child_under_hint(client, hint, coins.parent, memo).await {
        Ok(child) => child,
        Err(e) => {
            eprintln!("⛓️ ChiaHub {what}: could not read under the {what} hint: {e:#}");
            return None;
        }
    };
    let spent_at = match crate::chia_resolve::spent_heights(client, vec![coins.parked]).await {
        Ok(spent) => spent.into_iter().find(|(c, _)| *c == coins.parked).map(|(_, h)| h),
        Err(e) => {
            eprintln!("⛓️ ChiaHub {what}: could not read the {what}'s input: {e:#}");
            return None;
        }
    };
    Some((crate::chia_resolve::write_standing(&child, spent_at, word, ours), child.gone_since(confirmed_height)))
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
    lease_standing_on(&WALLET_LEASE, crate::chia_network::net(), client, coins, spends).await
}

/// [`lease_standing`] against a given lease on `net` (the tests' lease and
/// network): the gate held across the reconciliation and the two reads, as
/// [`WalletLease::reconcile`] runs it.
async fn lease_standing_on(
    lease: &WalletLease,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    coins: &[Bytes32],
    spends: &[u64],
) -> (HashMap<Bytes32, LeaseWord>, HashSet<u64>) {
    let _gate = lease.lock().await;
    lease.reconcile_at(net, client, Instant::now()).await;
    (
        coins.iter().map(|c| (*c, lease.lease_word(c))).collect(),
        spends.iter().copied().filter(|s| lease.holds_spend(*s)).collect(),
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
/// room's word at spend time, and [`Withdrawn`] writes nothing. Returns what
/// the knock arm made of the request ([`KnockDone`]): the hint and the write
/// ([`MemoWrite`]: the input coin the knock is found again by), or the entry
/// of a knock the lease still holds under the hint, filed again. The hint
/// and the seal are `net`'s ([`knock_hint`], [`knock_memo`]).
///
/// It runs [`knock_on_path`] on the process-wide lease and gift fuse
/// ([`WALLET_LEASE`], `claim_write::GIFT_FUSE`), the process's money lane
/// (two agreeing peers, as the burner's writer takes it: stage 4 design
/// §10), the wall clock and the OS random source: the knock the heartbeat
/// writes (§13 row 10), from its own burner key K(h) once with a burner
/// root (`root`, burner keys on), and paid for by the SSF wallet's key
/// `chia_sk` with none, its clock read where the lease is reconciled, as it
/// always was. Its one caller passes the process's network, which the lease
/// and the bundle were always written on. Building the lane's handle first
/// reads nothing ([`crate::chia_chain::connect`] does no I/O), so the
/// lease's checks, their order and their errors are the same as before. No
/// test calls it: its lease, fuse and chain are the process's.
#[allow(clippy::too_many_arguments)]
pub async fn publish_knock(
    net: crate::chia_network::ChiaNet,
    root: Option<&crate::chia_burner::BurnerRoot>,
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    gate: &tokio::sync::Mutex<()>,
    leave: impl FnOnce() -> Result<Option<[u8; 32]>, Withdrawn>,
    req: &KnockRequest,
    room_key: &[u8; 32],
    era: u64,
    now: u64,
) -> Result<KnockDone> {
    let client = crate::chia_chain::connect();
    knock_on_path(&WALLET_LEASE, &claim_write::GIFT_FUSE, net, &client, Instant::now, root, iroh_sk, chia_sk, gate, leave, req, room_key, era, now, &mut rand::rngs::OsRng).await
}

/// What the knock arm made of a request it tried ([`knock_on_path`]).
pub(crate) enum KnockDone {
    /// A knock the lease still holds under the request's inbox hint, written
    /// before a stop that lost its entry, filed again from the lease
    /// ([`lost_knock_entry`]): the knock book's entry for it. Nothing was
    /// written.
    Refiled(SentKnock),
    /// The knock was written under `hint`: `write`, from its own burner key
    /// K(h) when `from_burner` (the burner path), and paid for by the SSF
    /// wallet otherwise.
    Written { hint: Bytes32, write: MemoWrite, from_burner: bool },
}

/// What the knock arm makes of `req` in `era`, a request it did not skip
/// ([`knock_skipped`]), on a given lease, gift fuse, network, chain, clock
/// and random source (the tests' own on the mock chain): every step the arm
/// takes from the request to the write, so the heartbeat decides nothing
/// between them (stage 4 design §13 row 10). The path is `root`: a burner
/// root on the burner path (burner keys on, SSF_CHIA_BURNERS=1 on a test
/// network), none on the money path, as the listing's path is chosen.
///
/// First, on a test network (the only one knocks are written on), the
/// writes the lease still holds under the knock's inbox hint
/// ([`knock_hint`], [`WalletLease::held_writes_under`]) are asked of
/// [`lost_knock_entry`], with the payer of this host's own K(h)
/// ([`knock_burner`]) and the SSF wallet's. K(h) is the burner root's on
/// the burner path. On the money path the root is made from `chia_sk` on
/// `net`, as the burner path makes it, only when the lease holds a write a
/// burner paid for under the hint, and it is dropped at once. The lease is
/// read under its gate, so a spend a reconciliation is moving meanwhile is
/// not missed, and the gate is given back before the writer takes it. An
/// entry it files is [`KnockDone::Refiled`], and nothing is written under
/// the hint, so the SSF wallet and a burner never both write under it
/// while the lease holds the first write (§8.3, the crash window).
/// Otherwise the path's own writer writes the knock: from K(h), once, on
/// the burner path
/// ([`publish_knock_with`], at the instant `now` gives when it is called),
/// and paid for by `chia_sk` on the money path, as on main
/// ([`publish_knock_on`], `now` read where the lease is reconciled). The
/// write comes back with the path it was written on (`from_burner`), the
/// flag the arm's success line reads ([`knock_sent_line`]), so the line
/// names the writer that wrote. An error comes back as the writer gave it,
/// for [`knock_not_written`].
#[allow(clippy::too_many_arguments)]
async fn knock_on_path<R: rand::Rng + ?Sized + Send>(
    lease: &WalletLease,
    fuse: &std::sync::Mutex<claim_write::GiftFuse>,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    now: impl FnOnce() -> Instant,
    root: Option<&crate::chia_burner::BurnerRoot>,
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    gate: &tokio::sync::Mutex<()>,
    leave: impl FnOnce() -> Result<Option<[u8; 32]>, Withdrawn>,
    req: &KnockRequest,
    room_key: &[u8; 32],
    era: u64,
    now_unix: u64,
    rng: &mut R,
) -> Result<KnockDone> {
    if net.is_test() {
        let hint = knock_hint(net, req, room_key, era);
        let money = Payer::of(chia_sk);
        // Read under the lease's gate and given back here, before the
        // writer below takes the gate again (a `tokio` mutex, not
        // reentrant).
        let held = lease.held_writes_under(hint).await;
        let own = || {
            let key = match root {
                Some(root) => knock_burner(root, net, req, room_key, era),
                None => {
                    use crate::chia_burner::{BurnerRoot, MoneyKey};
                    knock_burner(&BurnerRoot::of(&MoneyKey::new(chia_sk.clone()), net), net, req, room_key, era)
                }
            };
            Payer::of_burner(&key)
        };
        if let Some(entry) = lost_knock_entry(held, own, &money, root.is_some(), req, hint, era, now_unix) {
            return Ok(KnockDone::Refiled(entry));
        }
    }
    let (hint, write) = match root {
        Some(root) => publish_knock_with(lease, fuse, net, client, now(), root, iroh_sk, gate, leave, req, room_key, era, now_unix, rng).await?,
        None => publish_knock_on(lease, net, client, now, iroh_sk, chia_sk, gate, leave, req, room_key, era, now_unix).await?,
    };
    Ok(KnockDone::Written { hint, write, from_burner: root.is_some() })
}

/// The knock [`publish_knock`] writes on the money path (no burner root,
/// [`knock_on_path`]), on a given lease, network, chain and clock (the
/// tests' own on the mock chain): the knock sealed for `era` on `net` once its
/// input coin is known ([`knock_memo`]), then written by [`publish_memo_on`]
/// under `gate`, paid for by the wallet key `chia_sk`, which the write names
/// as its payer ([`Payer::of`], stage 4 design §4.4). It keeps the money
/// writer's checks in their order, the global one among them: while any
/// spend on `lease` is parked, whatever its payer (a burner's knock or
/// listing included), the knock waits ([`MemoWait::Settling`]). A knock the
/// SSF wallet pays for has no write-once rule of its key's: the knock
/// book's one knock per host per era (`KnockBook::knocked_this_era`) is its
/// rule, as on main. `now` is read once, where the lease is reconciled.
/// `now_unix` dates the knock.
#[allow(clippy::too_many_arguments)]
async fn publish_knock_on(
    lease: &WalletLease,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    now: impl FnOnce() -> Instant,
    iroh_sk: &iroh::SecretKey,
    chia_sk: &SecretKey,
    gate: &tokio::sync::Mutex<()>,
    leave: impl FnOnce() -> Result<Option<[u8; 32]>, Withdrawn>,
    req: &KnockRequest,
    room_key: &[u8; 32],
    era: u64,
    now_unix: u64,
) -> Result<(Bytes32, MemoWrite)> {
    let hint = knock_hint(net, req, room_key, era);
    // Built and sealed once the input coin is known: its id is the parent of
    // the coin the knock rides on, and the sealing binds it (so the host opens
    // the knock under that coin alone — a copy under another never decodes,
    // #272 review round 3) and the lane token (so only a holder of the room
    // key can have written it, round 5).
    let write = publish_memo_on(
        lease,
        net,
        client,
        now,
        chia_sk,
        hint,
        Some(gate),
        move |input| {
            let ck_from = leave()?;
            knock_memo(net, iroh_sk, req, room_key, era, input, ck_from, now_unix)
        },
        "knock",
    )
    .await?;
    Ok((hint, write))
}

/// The knock for `req` in `era` written from its own burner key K(h) (stage
/// 4 design §3.2, §4.1, the knock row), on a given lease, gift fuse,
/// network, chain, instant and random source (the tests' own on the mock
/// chain): K(h) is `root`'s knock key for the knock's inbox hint h
/// ([`knock_hint`]) bound to the host's node id ([`knock_burner`],
/// [`knock_slot`]), so two hosts whose cards name one contact key, and so
/// share h, each get a knock from a key of their own, and the knock is
/// written under h by the knock's writer (`claim_write::knock_write_with`)
/// under the gift rules and the fuse (§5.2). K(h) writes once: its one
/// write claims a lobby dish coin F in its own bundle, which funds it with
/// the gift g, and the knock is sealed to g, its coin's parent. Or, when
/// K(h) already holds a lone 1-mojo coin whose parent is elsewhere (our
/// claim lifted out of our bundle by a peer, or a stray of exactly 1 mojo,
/// §5.4), it is written from that coin with no claim and no gift, and sealed
/// to it (`claim_write::knock_write_with`). The seal is made under `gate`,
/// after the lease and coin lookups (#272 review round 5), with `leave`
/// asked there as [`publish_knock_on`] asks it. A key that already wrote is
/// `claim_write::AlreadyKnocked`, and nothing is written. The write names
/// K(h) as its payer ([`Payer::of_burner`]), which the knock book files
/// beside its coins ([`sent_knock_of`]), and the money key pays for
/// nothing: no money payer is named, so the knock never waits on a spend
/// of the SSF wallet's.
///
/// `root` must be `net`'s ([`crate::chia_burner::BurnerRoot::net`]): K(h)
/// is derived from the inbox hint of the root's network and the knock is
/// written under `net`'s, and the two are the same hint only on the same
/// network (§3.5). A root of another network is refused before the lease or
/// the chain is asked anything, so nothing is parked or sent.
///
/// The writer does not read the hint a parked spend writes under. A knock
/// the SSF wallet wrote under the same hint before a restart that lost its
/// entry (§8.3, the crash window) is kept from a burner beside it by the
/// knock arm's step before it asks for a write ([`knock_on_path`]), which
/// files the entry again from the write the lease holds under the hint
/// ([`lost_knock_entry`]).
#[allow(clippy::too_many_arguments)]
async fn publish_knock_with<R: rand::Rng + ?Sized + Send>(
    lease: &WalletLease,
    fuse: &std::sync::Mutex<claim_write::GiftFuse>,
    net: crate::chia_network::ChiaNet,
    client: &impl ChainAccess,
    at: Instant,
    root: &crate::chia_burner::BurnerRoot,
    iroh_sk: &iroh::SecretKey,
    gate: &tokio::sync::Mutex<()>,
    leave: impl FnOnce() -> Result<Option<[u8; 32]>, Withdrawn>,
    req: &KnockRequest,
    room_key: &[u8; 32],
    era: u64,
    now_unix: u64,
    rng: &mut R,
) -> Result<(Bytes32, MemoWrite)> {
    anyhow::ensure!(
        root.net() == net,
        "the knock's burner root is for {} and this write is on {}; nothing is written",
        root.net().name(),
        net.name()
    );
    let hint = knock_hint(net, req, room_key, era);
    let key = knock_burner(root, net, req, room_key, era);
    let write = claim_write::knock_write_with(
        lease,
        fuse,
        net,
        client,
        at,
        &key,
        era,
        hint,
        Some(gate),
        move |parent| {
            let ck_from = leave()?;
            knock_memo(net, iroh_sk, req, room_key, era, parent, ck_from, now_unix)
        },
        rng,
    )
    .await?;
    Ok((hint, write))
}

/// The hint a knock for `req` is filed under in `era` on `net`: the host's
/// inbox hint for the lane of `room_key`, on `net` (stage 4 design §3.5:
/// mainnet's carries the network tag).
pub fn knock_hint(net: crate::chia_network::ChiaNet, req: &KnockRequest, room_key: &[u8; 32], era: u64) -> Bytes32 {
    let lane = chia_lane::derive_lane_token(room_key);
    Bytes32::new(chia_lane::derive_inbox_hint(net, &req.ck_host, &lane, era))
}

/// The blake3 `derive_key` context of a knock's slot ([`knock_slot`]).
const KNOCK_SLOT_CONTEXT: &str = "ssf-chia-knock-slot-v1";

/// The slot a knock's burner key is derived from ([`knock_burner`]): the
/// knock's inbox hint `hint` ([`knock_hint`]) bound to `host`, the node id
/// of the host it is for (`KnockRequest::host`, the text the knock book and
/// `ChainKnocked` key by), as `blake3::derive_key("ssf-chia-knock-slot-v1",
/// hint ‖ host)`. The hint is a fixed 32 bytes, so the host's text follows
/// it with no length before it and no two pairs give the same message.
///
/// Stage 4 design §3.2 derives K(h) from the hint alone, which §3.1's Slots
/// table justifies as one key per host per era. But the hint comes from the
/// host's contact key, and a card never proves that key belongs to one node
/// alone (`chia_watch`, P6a): two signed cards, two node ids, can name one
/// contact key, and neither may shadow the other. With one key per hint, a
/// knock to one of them would make the other's read as already knocked
/// (`claim_write::AlreadyKnocked`), its key having written once. Bound to
/// the node id, each host has a key of its own under the shared hint, as
/// each had a knock of its own from the SSF wallet on main, while the
/// knock is still written under the hint itself, so readers are unchanged.
/// The slot is public material, as the hint is: it goes into the root's
/// keyed hash as the hint did, and a reader who cannot derive the root
/// learns nothing from it. Two burners of ours under one inbox hint read on
/// chain as two knockers, which is what the hint already shows of anyone
/// who knocks there; what §8.3 forbids is the SSF wallet beside a burner,
/// and [`lost_knock_entry`] keeps it so while the lease holds the first
/// write.
pub(crate) fn knock_slot(hint: Bytes32, host: &str) -> [u8; 32] {
    let mut material = Vec::with_capacity(32 + host.len());
    material.extend_from_slice(&hint.to_bytes());
    material.extend_from_slice(host.as_bytes());
    blake3::derive_key(KNOCK_SLOT_CONTEXT, &material)
}

/// K(h), the burner key the knock for `req` in `era` on `net` is written
/// from (stage 4 design §3.2, §4.1's knock row): `root`'s knock key
/// ([`crate::chia_burner::BurnerRoot::knock`]) for the knock's slot, its
/// inbox hint bound to the host's node id ([`knock_slot`]), so one key per
/// host and room per era. Every knock key is derived here: the knock's
/// writer ([`publish_knock_with`]) and the knock arm's step, whose
/// crash-window filing tells this host's own held write by it
/// ([`knock_on_path`], [`lost_knock_entry`]), so the two can never drift
/// apart.
pub(crate) fn knock_burner(
    root: &crate::chia_burner::BurnerRoot,
    net: crate::chia_network::ChiaNet,
    req: &KnockRequest,
    room_key: &[u8; 32],
    era: u64,
) -> crate::chia_burner::BurnerKey {
    root.knock(&knock_slot(knock_hint(net, req, room_key, era), &req.host), era)
}

/// The knock book's entry for a knock written for `req` in `era` under
/// `hint`, pushed at `pushed_at`: pending, its clock not started, naming what
/// the watcher's lookup judges it by — its coins (its parent as its coin id,
/// which with the hint names the entry in the book, and its parked input
/// beside it: stage 4 design §4.4), its hint, the digest of its memo and the
/// lease's number for its spend — and its payer, the one the lease parked
/// the spend under.
pub fn sent_knock_of(req: &KnockRequest, era: u64, hint: Bytes32, write: &MemoWrite, pushed_at: u64) -> SentKnock {
    SentKnock {
        host: req.host.clone(),
        room: req.room.clone(),
        era,
        hint: hex::encode(hint.to_bytes()),
        coin_id: hex::encode(write.coins.parent.to_bytes()),
        memo: hex::encode(write.memo.to_bytes()),
        pushed_at,
        confirmed_height: 0,
        last_rendezvous: 0,
        settled: false,
        spend: write.spend,
        parked: hex::encode(write.coins.parked.to_bytes()),
        payer: Some(write.payer.hex()),
    }
}

/// The knock book's entry for a knock the lease still holds under `hint`,
/// the inbox hint of `req` in `era` ([`knock_hint`]), whose entry a stop
/// lost: `held` is every write the lease holds under it, newest first
/// ([`WalletLease::held_writes_under`]), parked with its saved bundle or
/// settling, and none when it holds none. The heartbeat saves
/// `knocks.json` after the push returns, while the lease parks the spend and
/// saves its bundle before the push (stage 4 design §4.4), so a node that
/// stops in between restarts with the knock in its lease and not in its
/// book. Started again on the other path (burner keys turned on or off in
/// the middle of the era), the next knock to that host would go out from
/// the other payer under the same inbox hint, the link §8.3 forbids. On the
/// burner path K(h)'s own knock would read as already written
/// (`claim_write::AlreadyKnocked`) and never be filed, so this node would
/// never dial the host at its confirmation height. So the entry is filed
/// again, exactly as [`sent_knock_of`] files a write: the request's
/// host and room, the era and the hint, the write's parent as its coin id
/// and its parked input beside it (the gift g and the dish coin F for a
/// burner's first write, §4.1), the digest of the record its coin carries,
/// the lease's number for its spend, the payer the lease parked it under
/// (`None` when none was filed, which counts as the SSF wallet's), and
/// `now_unix` as the time it was pushed. The arm then writes nothing for
/// the request, uses none of its attempts, and the book's rule of one knock
/// per host per era holds the host from then on.
///
/// `own` gives the payer of this host's own knock key K(h)
/// ([`knock_burner`]), and `money` is the SSF wallet's. `own` is asked only
/// when a write it could tell apart is held: on the burner path
/// (`burner_path`) when any write is, and on the money path when one a
/// burner paid for is, so the money path makes no burner root for a lease
/// that holds none. On either path the newest held write K(h) paid for is
/// filed before any other: it is this host's own knock, whose dial-back the
/// entry keeps, and its key would only read `claim_write::AlreadyKnocked`
/// once it lands.
///
/// Otherwise, on the burner path, the newest held write `money` paid for or
/// with no payer filed (the SSF wallet's too) is filed, from before burner
/// keys were turned on: K(h) must not write beside the SSF wallet (§8.3). A
/// held write another payer paid for is not filed, and this host's own
/// knock is written beside it: under an inbox hint two hosts share, since
/// their cards name one contact key, it is the other host's knock, from
/// that host's own key ([`knock_slot`]), and the two stand side by side as
/// any two knockers' under one hint do. It is told by its payer alone, so a
/// payer the lease filed that is neither K(h) nor `money`, such as the SSF
/// wallet of another identity whose lease file was kept, is taken for
/// another host's burner, and K(h) writes beside it.
///
/// Otherwise, on the money path, the newest held write any other burner
/// paid for is filed (burner keys turned off after a stop): the SSF wallet
/// must not write beside any burner (§8.3), whichever host that burner's
/// knock went to. One `money` paid for, or one with no payer filed, is left
/// to main's rule, as on main, where the global check holds the knock while
/// the spend is parked and the book's "one early knock at worst" stands
/// (`KnockBook::load`).
///
/// A knock is sealed to the host it is for, which the lease cannot read. So
/// under an inbox hint two hosts share, a held write the SSF wallet paid
/// for is filed on the burner path for each of them the arm asks for while
/// the lease holds it, whichever host it went to, since neither host's K(h)
/// may write beside it; and on the money path another host's burner knock
/// is filed for this host when this host's own is not held. Such an entry
/// dials the host at the other knock's height. A write the lease has
/// forgotten, or whose bundle was not saved, is not found, and nothing is
/// filed: the window is closed for as long as the lease remembers the spend,
/// until the chain settles it [`crate::chia_knock::SETTLED_DEPTH`] deep.
///
/// The knock arm's step asks it ([`knock_on_path`]) only on a test network,
/// where knocks are written, and only for a request the arm does not skip
/// ([`knock_skipped`]): a host the book holds a knock on this era already
/// has its entry.
#[allow(clippy::too_many_arguments)]
pub(crate) fn lost_knock_entry(
    held: impl IntoIterator<Item = HeldWrite>,
    own: impl FnOnce() -> Payer,
    money: &Payer,
    burner_path: bool,
    req: &KnockRequest,
    hint: Bytes32,
    era: u64,
    now_unix: u64,
) -> Option<SentKnock> {
    let held: Vec<HeldWrite> = held.into_iter().collect();
    let by_burner = |w: &&HeldWrite| w.payer.is_some_and(|paid_by| paid_by != *money);
    if !held.iter().any(|w| burner_path || by_burner(&w)) {
        return None;
    }
    let own = Some(own());
    let otherwise = |w: &&HeldWrite| if burner_path { w.payer.is_none_or(|paid_by| paid_by == *money) } else { by_burner(w) };
    let held = held.iter().find(|w| w.payer == own).or_else(|| held.iter().find(otherwise))?;
    Some(SentKnock {
        host: req.host.clone(),
        room: req.room.clone(),
        era,
        hint: hex::encode(hint.to_bytes()),
        coin_id: hex::encode(held.coins.parent.to_bytes()),
        memo: hex::encode(crate::chia_resolve::memo_digest(&held.record).to_bytes()),
        pushed_at: now_unix,
        confirmed_height: 0,
        last_rendezvous: 0,
        settled: false,
        spend: Some(held.spend),
        parked: hex::encode(held.coins.parked.to_bytes()),
        payer: held.payer.map(|p| p.hex()),
    })
}

/// The line the knock arm prints when it files `req`'s knock in `era` again
/// from the write the lease still holds under its inbox hint
/// ([`lost_knock_entry`], stage 4 design §8.3). It names the host by its
/// shortened node id ([`short`]), the room and the era, and neither who
/// paid nor any key, puzzle hash or address, as the listing's line for a
/// lost mark names no payer.
fn lost_knock_line(req: &KnockRequest, era: u64) -> String {
    format!(
        "⛓️ ChiaHub knock: the wallet lease still holds the era {era} knock on {} for room {}, written before a restart that lost its entry — filed again; one inbox hint never has two payers, so nothing new is written under it (no attempt used)",
        short(&req.host),
        req.room
    )
}

/// The memo a knock for `req` carries on `net` once its input coin `input`
/// is known: the knock naming the room's lane id and `ck_from`, signed (iroh
/// key), and sealed to the host's card key on `net` with `input` as the
/// carrier's parent and the room's lane token (stage 4 design §3.5). It
/// touches no chain, so chia_resolve's tests file what it gives under
/// [`knock_hint`] in a mock chain and read it back on each network.
#[allow(clippy::too_many_arguments)]
pub fn knock_memo(
    net: crate::chia_network::ChiaNet,
    iroh_sk: &iroh::SecretKey,
    req: &KnockRequest,
    room_key: &[u8; 32],
    era: u64,
    input: Bytes32,
    ck_from: Option<[u8; 32]>,
    now: u64,
) -> Result<Vec<u8>> {
    let lane = chia_lane::derive_lane_token(room_key);
    let rooms = vec![chia_lane::room_lane_id(&req.room)];
    let knock = KnockV2 { era, from: iroh_sk.public(), ck_from, issued_at: now, expires_at: now + 2 * ERA_SECS, rooms };
    let plain = chia_lane::encode_knock_v2(&knock, iroh_sk)?;
    chia_lane::seal_to_kx(net, &req.kx_host, KIND_KNOCK, era, &input.to_bytes(), &lane, &plain)
}

/// Write this era's beacon from the beacon wallet: the node id in the clear
/// under the era's public hint on `net`, nothing else ([`beacon_memo`]).
/// Returns the hint and the write ([`MemoWrite`]: the input coin the beacon
/// is found again by).
pub async fn publish_beacon(net: crate::chia_network::ChiaNet, iroh_sk: &iroh::SecretKey, beacon_sk: &SecretKey, era: u64, now: u64) -> Result<(Bytes32, MemoWrite)> {
    let (hint, plain) = beacon_memo(net, iroh_sk, era, now)?;
    let write = publish_memo(beacon_sk, hint, plain, "beacon").await?;
    Ok((hint, write))
}

/// What a beacon write files for `era` on `net`: the hint, the era's public
/// beacon hint on `net` (stage 4 design §3.5: mainnet's carries the network
/// tag), and the memo, the beacon signed (iroh key) and in the clear. It
/// touches no chain, so chia_resolve's tests file what it gives in a mock
/// chain and read it back on each network.
pub fn beacon_memo(net: crate::chia_network::ChiaNet, iroh_sk: &iroh::SecretKey, era: u64, now: u64) -> Result<(Bytes32, Vec<u8>)> {
    let beacon = BeaconV2 { era, node_id: iroh_sk.public(), issued_at: now, expires_at: now + 2 * ERA_SECS };
    let plain = chia_lane::encode_beacon_v2(&beacon, iroh_sk)?;
    Ok((Bytes32::new(chia_lane::derive_beacon_hint(net, era)), plain.to_vec()))
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
    // ⛓️ Chia off on this computer (chia_strict.rs) is asked first: no
    // wallet loads then and the Bank's TURN ON is refused, so this loop is
    // started only by a turn that was under way when Chia was turned off in
    // the game, and then it says and reads nothing, not even the money line
    // below (which says the node still reads the chain). Each tick asks
    // again, for a wallet loaded before an in-game off.
    if crate::chia_strict::strict() {
        return;
    }
    let net = crate::chia_network::net();
    // 🛑 Off a test network the SSF wallet pays for no memo spend (stage 4
    // design §4.5 (1)): asked once here, which logs it once, so the loop
    // writes no listing, knock or beacon, looks up no coin for one, and the
    // Phone Book row says why. It still reads the agreed peak, which dates
    // the row's edition, and judges a write an older build left; the
    // watcher is not told to read this node's own listing for it.
    let money_refused: Option<String> = refuse_money_memo(net).err().map(|e| e.0);
    // Burner keys on for this run (SSF_CHIA_BURNERS=1 on a test network): in
    // the heartbeat they write the listing from this wallet's listing burner
    // P(e) at its slot (stage 4 design §4.3, [`burner_listing_step`]) and
    // each knock from its own burner key K(h), once (§4.1, the knock row),
    // and change the knock rule (§5.2) and the words the knock and beacon
    // lines give a busy chain (§10). The listing and each knock are written
    // from their own burner keys; the beacon is still paid as before.
    let burners = burners_enabled();
    // The root the listing's burners and their slots come from, and the
    // knocks' keys (§3.2), made once from the wallet key, on the burner path
    // alone. Off a test network burner keys are never on ([`burners_of`]),
    // so no root is made there, and with the flag off the listing arm and
    // the knock arm are the SSF wallet's, as on main
    // ([`money_listing_step`], [`publish_knock`] with no root).
    let listing_root = burners.then(|| crate::chia_burner::BurnerRoot::of(&crate::chia_burner::MoneyKey::new(chia_sk.clone()), net));
    // The SSF wallet's payer text, as the marks file it, for the hint rule
    // (§8.3) on either path.
    let money_payer = Payer::of(&chia_sk).hex();
    // What the burner path's gates remember between ticks: the era's first
    // peak and its late start, a change waiting its jitter, and P(e)'s payer
    // text. No line prints it or anything in it.
    let mut listing_clock = ListingClock::default();
    let mut marks: HashMap<String, PublishMark> = HashMap::new();
    // N8: public-space rooms that are armed, already told about once.
    let mut refused_logged: HashSet<String> = HashSet::new();
    // #231 P6a: the per-node presence state. The mark is what was WRITTEN (on
    // disk, set on push success); the attempt instant paces retries after a
    // failure; the guard flag logs the end-of-era pause once.
    let mark_file = crate::chia_network::net().path(NODE_MARK_FILE);
    let mark_path = mark_file.as_path();
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
    // Findable: told so (D4 default) AND holding a durable contact key — a key
    // for this run only is never published under, since the record would
    // outlive it and contradict the node's one-key identity.
    let findable = findable_enabled() && hub.contact_key_durable;
    if findable_enabled() && !hub.contact_key_durable {
        println!("⛓️ ChiaHub presence: no durable contact key — per-node presence is not published this run");
    }
    // Tell the watcher to read our own key every beat for as long as we may
    // write it, rooms and peers or not: that read is what confirms a write.
    // Off a test network this node writes none (`money_refused`).
    hub.presence_publishing.store(findable && money_refused.is_none(), std::sync::atomic::Ordering::Relaxed);
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
    let beacon_mark_file = crate::chia_network::net().path(BEACON_MARK_FILE);
    let beacon_mark_path = beacon_mark_file.as_path();
    let mut beacon_mark: Option<BeaconMark> = beacon_sk.as_ref().and_then(|_| BeaconMark::load(beacon_mark_path));
    let mut beacon_attempt: Option<Instant> = None;
    // When the last knock only waited (burners on, `knock_failed`): the
    // knock arm rests for the retry cadence from then (`knock_paced`).
    // With burners off it is never set, and the arm is today's.
    let mut knock_wait: Option<Instant> = None;
    // The hosts this run found its knock already written to this era by the
    // knock's own key (`ChainKnocked`, `knock_not_written`), skipped for the
    // rest of the era. Only the burner path writes a knock from its own key,
    // so with burners off it stays empty.
    let mut chain_knocked = ChainKnocked::default();
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
    let knocks_file = crate::chia_network::net().path(crate::chia_knock::KNOCKS_FILE);
    let knocks_path = knocks_file.as_path();
    loop {
        tokio::time::sleep(Duration::from_secs(HEARTBEAT_TICK_SECS)).await;
        // ⛓️ Chia off on this computer (chia_strict.rs): no read or write
        // this tick.
        if crate::chia_strict::strict() {
            continue;
        }
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
        // Every era-bound write of this tick (presence, knock, beacon) is
        // signed for the era of that peak, and the era guard's budget
        // ([`ERA_GUARD_BLOCKS`]) counts the peak's age from its read; the
        // tick's lookups (a mark's standing, the lease's reconciliation) run
        // several requests between the read and a write. So right before each
        // write the peak's age is read again: aged out meanwhile, the write
        // could be signed for an era the chain has left, and is held for the
        // next tick, which reads the peak anew (#334 review).
        let peak_aged = |what: &str| -> bool {
            let aged = agreed_peak.fresh(crate::chia_resolve::unix_now()).is_none();
            if aged {
                println!("⛓️ ChiaHub {what}: the agreed peak aged out during this tick's lookups — holding this write for the next tick");
            }
            aged
        };

        // ── #231 P6a: the node's OWN presence first (priority over room publishes) ──
        if findable {
            // The watcher read THIS write back from the chain (the record's
            // signed issued_at is the mark's push time): confirmed, nothing
            // more to retry, and seen on chain, which is what the top bar's
            // phone book turns solid green on (the peers' acceptance alone is
            // not). An older record of ours re-read inside the cursor overlap
            // names another issued_at and confirms nothing. A read of the
            // chain, not a write, so it is recorded whatever the peak says.
            // 📖 Only a mark an older node wrote, naming no coin, is confirmed
            // this way: one that names its coin is judged by its own lookup
            // below, which also records the height the green stands on
            // ([`mark_confirmed_by`] says why the watcher must not).
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
            // dropped would show green for the rest of the era. On the burner
            // path last era's listing is judged by its own era too, until it
            // settles, while it stands in for this era's
            // ([`listing_judged_era`]).
            if let Some(now) = era_now {
                let judged = listing_judged_era(node_mark.as_ref(), now, &self_id, listing_root.is_some());
                if let (Some(era), Some(m)) = (judged, node_mark.clone()) {
                    match presence_step(&m, presence_standing(&peak_client, &m).await, era, peak) {
                        PresenceStep::Keep => {}
                        PresenceStep::Void(why) => {
                            let next = if era == now {
                                write_again_words(net)
                            } else {
                                "this edition's listing is due at once, as for a station not listed last edition".to_string()
                            };
                            println!("⛓️ ChiaHub presence: the era {era} listing {why}; {next}");
                            let void = m.voided();
                            if let Err(e) = void.save(mark_path) {
                                eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                            }
                            node_mark = Some(void);
                            // The write is due at once, so the retry cadence
                            // of the attempt it followed does not hold it: the
                            // era guard and the write budget still do.
                            node_attempt = None;
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
            // The hint this era's listing is filed under on this network
            // (§3.5), for the mark and the Phone Book's row alike.
            let hint_now = era_now.map(|era| hex::encode(chia_lane::derive_ck_hint(net, &hub.contact_key, era)));
            let inbound = hub.inbound_verified.lock().unwrap().clone();
            let entries = public_addr_entries(&addrs, &inbound, peak, now_unix);
            let sig = addrs_signature(&entries);
            // This era's listing, written by the other path's payer before a
            // restart that lost its mark (the mark on record is older, void,
            // or none), filed again from the write the lease still holds
            // under the era's hint ([`lost_listing_mark`]),
            // so that the hint rule (§8.3) holds this path's write for the
            // rest of the era. The write is found parked or settling alike.
            // The line names no payer.
            if let Some(era) = era_now {
                let found = lost_listing_mark(&WALLET_LEASE, node_mark.as_ref(), net, &hub.contact_key, era, listing_root.is_some(), &money_payer, |m| match &listing_root {
                    Some(root) => Some(listing_clock.burner_payer(root, &hub.contact_key, era, &m.hint)),
                    None => money_path_burner_payer(Some(m), era, &m.hint, &money_payer, net, &chia_sk, &hub.contact_key),
                })
                .await;
                if let Some(mark) = found {
                    println!(
                        "⛓️ ChiaHub presence: the wallet lease still holds the era {era} listing, written before a restart that lost its mark — filed again; one hint never has two payers, so this edition's listing stays as it is"
                    );
                    if let Err(e) = mark.save(mark_path) {
                        eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                    }
                    node_mark = Some(mark);
                }
            }
            // The listing's spend still on the lease (its input parked, or
            // included and settling): live, so the clock's retry writes
            // nothing beside it ([`node_publish_due`]). Read after the lookup
            // above reconciled the lease.
            let spend_held = node_mark.as_ref().and_then(|m| m.spend).is_some_and(|s| WALLET_LEASE.holds_spend(s));
            // Last era's hint (§3.5), on the burner path alone: the newcomer
            // exception (T1) and the failure words ask whether last era's
            // listing was ours. Era 0 has no era before it, and no listing
            // of last era matches the empty text.
            let last_hint = match (&listing_root, era_now) {
                (Some(_), Some(era)) => era
                    .checked_sub(1)
                    .map(|last| hex::encode(chia_lane::derive_ck_hint(net, &hub.contact_key, last)))
                    .unwrap_or_default(),
                _ => String::new(),
            };
            // What the listing arm does this tick ([`ListingStep`]), for the
            // write below and the Phone Book's readout. Nothing is due
            // inside the era guard or with no era agreed, where the readout
            // gives no wait words and holds no listing ([`listing_readout`]):
            // with the SSF wallet paying, the one it always was.
            let mut step = ListingStep::Idle;
            let mut spent_this_tick = false;
            if peak > 0 && era_guard(peak) {
                if !era_guard_logged {
                    println!("⛓️ ChiaHub presence: the era ends within {ERA_GUARD_BLOCKS} blocks — holding this write for the new era");
                    era_guard_logged = true;
                }
            } else if let (Some(era), Some(era_hint)) = (era_now, hint_now.as_deref()) {
                era_guard_logged = false;
                step = match &listing_root {
                    // The burner path's gates (§4.3, §8.3), asked every
                    // tick, whatever the retry cadence says, so the clock
                    // sees the first peak this run sees in the era.
                    Some(root) => burner_listing_step(
                        &mut listing_clock,
                        &ListingFacts {
                            mark: node_mark.as_ref(),
                            era,
                            peak,
                            now: now_unix,
                            sig: &sig,
                            hint: era_hint,
                            last_hint: &last_hint,
                            node_id: &self_id,
                            spend_held,
                            money: &money_payer,
                            root,
                            ck: &hub.contact_key,
                        },
                        &mut rand::rngs::OsRng,
                    ),
                    // The SSF wallet's clock, as on main, save the hint rule
                    // after a listing this wallet's own P(e) paid for this
                    // era (the flag turned off mid-era). This wallet's P(e)
                    // is derived here only for a mark of this era under this
                    // hint whose payer is neither none nor the SSF wallet's
                    // ([`money_path_burner_payer`]): its own P(e)'s, or
                    // another wallet's after a swap mid-era, which the
                    // text then tells apart.
                    None => money_listing_step(
                        node_mark.as_ref(),
                        era,
                        &sig,
                        now_unix,
                        era_hint,
                        &self_id,
                        spend_held,
                        &money_payer,
                        money_path_burner_payer(node_mark.as_ref(), era, era_hint, &money_payer, net, &chia_sk, &hub.contact_key).as_deref(),
                    ),
                };
                let retry_ok = node_attempt
                    .map(|t| t.elapsed() >= Duration::from_secs(HEARTBEAT_RETRY_SECS))
                    .unwrap_or(true);
                let due = money_refused.is_none() && step == ListingStep::Write && retry_ok;
                // Due, and the peak not aged out during the lookups above.
                if due && !peak_aged("presence") {
                    node_attempt = Some(Instant::now());
                    let written = match &listing_root {
                        Some(root) => publish_burner_presence(net, root, Payer::of(&chia_sk), &iroh_sk, &hub.contact_key, era, &entries, now_unix).await,
                        None => publish_node_presence(net, &iroh_sk, &chia_sk, &hub.contact_key, era, &entries, now_unix).await,
                    };
                    match written {
                        Ok((hint, write)) => {
                            let writes = match &node_mark {
                                Some(m) if m.era == era && mark_is_ours(m, era_hint, &self_id) => m.writes + 1,
                                _ => 1,
                            };
                            // 📖 Pending until the chain's own word.
                            let mark = NodePublishMark::written(era, writes, sig.clone(), now_unix, hint, &write, self_id.clone());
                            if let Err(e) = mark.save(mark_path) {
                                eprintln!("⛓️ ChiaHub presence: could not save {NODE_MARK_FILE}: {e}");
                            }
                            // The line names who paid by kind alone: no key,
                            // puzzle hash or address of the burner.
                            println!(
                                "⛓️ ChiaHub presence: {} for era {era} (write {writes}) · {} public addr(s) · hint {} — pending until its own coin is read back{}",
                                if write.acked { "published" } else { "pushed, unanswered" },
                                entries.len(),
                                &mark.hint[..16],
                                if listing_root.is_some() { " · from this edition's burner key" } else { "" }
                            );
                            node_mark = Some(mark);
                            node_last_error = None;
                        }
                        Err(e) => {
                            eprintln!("{}", listing_failure_line(listing_root.is_some(), era, &e));
                            node_last_error = Some(match &listing_root {
                                // §10's words. Last week's listing still works
                                // only while the mark on record is last era's
                                // listing of ours with the live addresses:
                                // once this era's is written, the file no
                                // longer says, and after a change of address
                                // it sends readers to the old ones.
                                Some(_) => listing_failure_words(&e, last_week_still_works(node_mark.as_ref(), era, &last_hint, &self_id, &sig)),
                                None => format!("{e:#}"),
                            });
                        }
                    }
                    spent_this_tick = true;
                }
            }
            // 📖 Mirror the readout for the loopback fingerprint, whichever
            // branch ran: the SpacePhone's top bar polls it each minute. The
            // text beside it is why the step waits or is held, the last failed
            // attempt's, or the one reason a stale listing stays stale with no
            // attempt at all: the era's write budget is spent (the browser
            // words the missing peak itself).
            let budget_spent = era_now.is_some_and(|era| {
                node_mark.as_ref().is_some_and(|m| {
                    m.era == era && m.writes >= 1 + MAX_NODE_WRITES_PER_ERA && (m.addrs_sig != sig || !m.confirmed)
                })
            });
            // …or the lease still holds the spend of a listing pending past
            // the clock's window, which is why it is not written again.
            let spend_live = spend_held
                && era_now.is_some_and(|era| {
                    node_mark.as_ref().is_some_and(|m| m.era == era && !m.confirmed && now_unix.saturating_sub(m.last_at) >= PRESENCE_CONFIRM_TIMEOUT_SECS)
                });
            // This era's listing on record is void: its write was dropped,
            // or it confirmed outside its era. Under a hold by the hint rule
            // it reads outdated (§8.3).
            let void = era_now.is_some_and(|era| node_mark.as_ref().is_some_and(|m| m.era == era && m.is_void()));
            // The text and the held state come from the listing's readout
            // ([`listing_readout`]): with the SSF wallet paying, the chain as
            // it always was.
            let (why_not, hold) =
                listing_readout(money_refused.as_deref(), step, listing_root.is_some(), void, node_last_error.as_deref(), budget_spent, spend_live);
            let status = presence_status_with(
                node_mark.as_ref(),
                hint_now.as_deref(),
                &self_id,
                era_now,
                &sig,
                entries.len(),
                why_not.as_deref(),
                hold,
            );
            *hub.presence_status.lock().unwrap() = Some(status);
            if spent_this_tick {
                continue; // one spend per tick — see the doc comment
            }
        }

        // ── #231 P6b: one KNOCK per tick, after presence and before the room
        // publishes (priority presence > knock > beacon). A queued request is
        // still honoured only if its room still allows cards (the toggle may
        // have flipped, the browser may have declared the room public), the
        // host was not knocked on this era already (the book's word, or this
        // run's finding that the knock's own key wrote: `knock_skipped`), and
        // the two are not linked meanwhile (a link by any path cancels the
        // knock). Era-bound like presence: no write without a peak, inside
        // the era's guard blocks, or on a peak the presence lookups above let
        // age out.
        if knock_waiting && money_refused.is_none() && peak > 0 && !era_guard(peak) && knock_paced(knock_wait, Instant::now()) && !peak_aged("knock") {
            let era = chia_lane::era_of(peak);
            let next = loop {
                let Some(req) = hub.knock_queue.lock().unwrap().pop_front() else { break None };
                let cap = hub.chia_rooms.lock().unwrap().get(&req.room).cloned();
                let Some(cap) = cap.filter(|c| c.may_use_cards()) else {
                    println!("⛓️ ChiaHub knock: not knocking on {} for room {} — the room no longer uses cards", short(&req.host), req.room);
                    continue;
                };
                if knock_skipped(&hub.knocks.lock().unwrap(), &chain_knocked, &req.host, era) {
                    continue;
                }
                if req.host.parse::<iroh::PublicKey>().is_ok_and(|pk| crate::linked_in_room(&hub, &req.room, &pk)) {
                    continue;
                }
                break Some((req, cap.room_key));
            };
            if let Some((req, room_key)) = next {
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
                // The arm's whole step from here to the write is one seam
                // (`knock_on_path`), chosen by the path as the listing's is,
                // never by which key paid. A knock under this request's inbox
                // hint that the lease still holds, written before a stop that
                // lost its entry (stage 4 design §8.3, the crash window), is
                // filed again from the lease, with no attempt used and
                // nothing new written under the hint, and its line names no
                // key. Otherwise, on the burner path, the knock is written
                // from its own key K(h), once (§4.1, the knock row: a key
                // that already wrote is `claim_write::AlreadyKnocked`), paid
                // for by no key of the wallet's; with burner keys off it is
                // the SSF wallet's write, as on main.
                match publish_knock(net, listing_root.as_ref(), &iroh_sk, &chia_sk, &hub.card_gate, leave, &req, &room_key, era, now_unix).await {
                    Ok(KnockDone::Refiled(entry)) => {
                        println!("{}", lost_knock_line(&req, era));
                        let mut book = hub.knocks.lock().unwrap();
                        book.record_sent(entry);
                        if let Err(e) = book.save(knocks_path) {
                            eprintln!("⛓️ ChiaHub knock: could not save {}: {e}", crate::chia_knock::KNOCKS_FILE);
                        }
                    }
                    Ok(KnockDone::Written { hint, write, from_burner }) => {
                        knock_wait = None;
                        println!("{}", knock_sent_line(write.acked, &req.host, &req.room, era, hint, from_burner));
                        // Filed whether or not the push was answered: an
                        // unanswered knock may be in a mempool with its coin
                        // parked, and only a filed knock gets its confirmation
                        // clock, or is forgotten on the chain's word that it
                        // died — unfiled, it would be knocked again beside the
                        // first (#272 review).
                        let mut book = hub.knocks.lock().unwrap();
                        book.record_sent(sent_knock_of(&req, era, hint, &write, now_unix));
                        if let Err(e) = book.save(knocks_path) {
                            eprintln!("⛓️ ChiaHub knock: could not save {}: {e}", crate::chia_knock::KNOCKS_FILE);
                        }
                    }
                    // A knock withdrawn at spend time, or already written by
                    // its own key, is dropped with its line; every other
                    // error is a wait (burners on) or an attempt used, back
                    // in the queue or dropped, as `knock_failed` says
                    // (`knock_not_written`).
                    Err(e) => knock_not_written(burners, req, &e, era, Instant::now(), &mut hub.knock_queue.lock().unwrap(), &mut knock_wait, &mut chain_knocked),
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
                            println!("⛓️ ChiaHub beacon: the era {era} beacon {why}; {}", write_again_words(net));
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
                let due = money_refused.is_none() && reachable && serves_welcome && retry_ok && beacon_due(beacon_mark.as_ref(), era, &self_id);
                // Due, and the peak not aged out during the lookups above.
                if due && !peak_aged("beacon") {
                    beacon_attempt = Some(Instant::now());
                    match publish_beacon(net, &iroh_sk, beacon_sk, era, now_unix).await {
                        Ok((hint, write)) => {
                            let mark = BeaconMark::written(era, now_unix, hint, &write, self_id.clone());
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
                        // With burner keys off, the line it always had.
                        Err(e) => eprintln!("{}", beacon_failure_line(burners, era, &e)),
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
        let (armed, refused) = publishable_rooms(net, &caps);
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
/// `[hint, ciphertext]` memos, and push to the node's network. Returns the published hint.
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
    let bundle = build_publish_bundle(crate::chia_network::net(), chia_sk, coin.coin, hint, ciphertext)?;
    push_parked(&client, Payer::of(chia_sk), bundle, [(coin.coin.coin_id(), coin.confirmed_height)]).await?;
    Ok(hint)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The network the lease tests reconcile on, unless they name another.
    const T11: crate::chia_network::ChiaNet = crate::chia_network::ChiaNet::Testnet11;

    /// The payers the lease tests park under (stage 4 design §4.4): the
    /// money address a lease is restored with, the beacon's (a key of the
    /// node's own that is not the wallet's), and a burner's. Fixed puzzle
    /// hashes: no key is made.
    fn money() -> Payer {
        Payer(Bytes32::new([0xa0; 32]))
    }

    fn beacon() -> Payer {
        Payer(Bytes32::new([0xb0; 32]))
    }

    fn burner() -> Payer {
        Payer(Bytes32::new([0xc0; 32]))
    }

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
        assert!(node_publish_due(None, 5, "a", now, "h", "n", false), "never written: due");
        let mark = NodePublishMark {
            era: 5,
            writes: 1,
            addrs_sig: "a".into(),
            last_at: now,
            hint: "h".into(),
            confirmed: true,
            chain_seen: true,
            coin_id: String::new(),
            memo: String::new(),
            confirmed_height: 0,
            settled: false,
            spend: None,
            node_id: Some("n".into()),
            parked: String::new(),
            payer: None,
        };
        assert!(!node_publish_due(Some(&mark), 5, "a", now + 3600, "h", "n", false), "same era, same addresses: idle writes nothing");
        // A mark another identity left (a replaced contact or node key) satisfies
        // nothing: its record sits under another hint, or carries a signer readers reject.
        assert!(node_publish_due(Some(&mark), 5, "a", now + 1, "other-hint", "n", false), "another contact key: due at once");
        assert!(node_publish_due(Some(&mark), 5, "a", now + 1, "h", "other-node", false), "another node key: due at once");
        assert!(node_publish_due(Some(&mark), 6, "a", now + 1, "h", "n", false), "a new era: due at once");
        assert!(!node_publish_due(Some(&mark), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS - 1, "h", "n", false), "changed, but inside the debounce");
        assert!(node_publish_due(Some(&mark), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS, "h", "n", false), "changed, debounce passed");
        let spent = NodePublishMark { writes: 1 + MAX_NODE_WRITES_PER_ERA, ..mark.clone() };
        assert!(!node_publish_due(Some(&spent), 5, "b", now + 3600, "h", "n", false), "the era's change budget is spent");
        assert!(node_publish_due(Some(&spent), 6, "b", now + 3600, "h", "n", false), "…until the next era");
        // A write the chain never showed back is retried after the timeout —
        // and not before, so a spend still waiting in the mempool is left alone.
        let pending = NodePublishMark { confirmed: false, chain_seen: false, ..mark.clone() };
        assert!(!node_publish_due(Some(&pending), 5, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS - 1, "h", "n", false), "pending, inside the window");
        assert!(node_publish_due(Some(&pending), 5, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n", false), "pending too long: retry");
        assert!(node_publish_due(Some(&pending), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS, "h", "n", false), "pending, but the addresses changed: the change rule still applies");
        let pending_spent = NodePublishMark { confirmed: false, chain_seen: false, writes: 1 + MAX_NODE_WRITES_PER_ERA, ..mark.clone() };
        assert!(!node_publish_due(Some(&pending_spent), 5, "a", now + 2 * PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n", false), "retries spend the same era budget");
        // 📖 The clock's retry writes nothing while the lease still holds the
        // write's spend (parked, or included and settling): the spend is live,
        // and a second listing would stand beside the first for a write of the
        // era's budget. Changed addresses, or a new era, are a new listing all
        // the same.
        assert!(!node_publish_due(Some(&pending), 5, "a", now + 2 * PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n", true), "pending past the window, spend held: the lease pushes it again or the chain settles it");
        assert!(node_publish_due(Some(&pending), 5, "b", now + ADDR_CHANGE_DEBOUNCE_SECS, "h", "n", true), "…but changed addresses are listed anew");
        assert!(node_publish_due(Some(&pending), 6, "a", now + 1, "h", "n", true), "…and a new era is a new listing");
        assert!(!node_publish_due(Some(&mark), 5, "a", now + 3600, "h", "n", true), "a confirmed listing's settling spend changes nothing");
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
        // 📖 A mark that names its coin is confirmed by its own lookup, never
        // by the watcher's sighting of the write.
        assert!(!mark_confirmed_by(&NodePublishMark { coin_id: "c".into(), ..pending.clone() }, now), "coin-backed: the lookup confirms it");
        assert!(!node_publish_due(Some(&accepted), 5, "a", now + 2 * PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n", false), "…and it is not retried meanwhile");
        let legacy: NodePublishMark = serde_json::from_str(r#"{"era":5,"writes":1,"addrs_sig":"a","last_at":1,"hint":""}"#).unwrap();
        assert!(!legacy.confirmed, "a mark file without the field reads as unconfirmed");
        assert!(!legacy.chain_seen, "…and as not yet seen on chain");
        assert!(!mark_is_ours(&legacy, "", "n"), "a mark without a node id is nobody's");
    }

    /// One call of [`node_publish_due`] in
    /// `node_presence_is_written_once_per_era_then_only_on_debounced_changes`,
    /// with the reason it is due (`why`, `None` when it is not).
    struct DueCase {
        what: &'static str,
        mark: Option<NodePublishMark>,
        era: u64,
        sig: &'static str,
        now: u64,
        hint: &'static str,
        node: &'static str,
        held: bool,
        why: Option<PresenceDue>,
    }

    /// Every case of `node_presence_is_written_once_per_era_then_only_on_debounced_changes`
    /// that asks [`node_publish_due`], in its order, and one more: a pending
    /// write past its timeout whose addresses also changed is a retry.
    fn node_publish_cases() -> Vec<DueCase> {
        use PresenceDue::*;
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
            memo: String::new(),
            confirmed_height: 0,
            settled: false,
            spend: None,
            node_id: Some("n".into()),
            parked: String::new(),
            payer: None,
        };
        let spent = NodePublishMark { writes: 1 + MAX_NODE_WRITES_PER_ERA, ..mark.clone() };
        let pending = NodePublishMark { confirmed: false, chain_seen: false, ..mark.clone() };
        let pending_spent = NodePublishMark { confirmed: false, chain_seen: false, writes: 1 + MAX_NODE_WRITES_PER_ERA, ..mark.clone() };
        let accepted = NodePublishMark { chain_seen: false, ..mark.clone() };
        let (debounce, timeout) = (ADDR_CHANGE_DEBOUNCE_SECS, PRESENCE_CONFIRM_TIMEOUT_SECS);
        let case = |what, mark: Option<&NodePublishMark>, era, sig, now, hint, node, held, why| DueCase { what, mark: mark.cloned(), era, sig, now, hint, node, held, why };
        vec![
            case("never written", None, 5, "a", now, "h", "n", false, Some(FirstOfEra)),
            case("same era, same addresses", Some(&mark), 5, "a", now + 3600, "h", "n", false, None),
            case("another contact key", Some(&mark), 5, "a", now + 1, "other-hint", "n", false, Some(FirstOfEra)),
            case("another node key", Some(&mark), 5, "a", now + 1, "h", "other-node", false, Some(FirstOfEra)),
            case("a new era", Some(&mark), 6, "a", now + 1, "h", "n", false, Some(FirstOfEra)),
            case("changed, inside the debounce", Some(&mark), 5, "b", now + debounce - 1, "h", "n", false, None),
            case("changed, debounce passed", Some(&mark), 5, "b", now + debounce, "h", "n", false, Some(Change)),
            case("the budget spent", Some(&spent), 5, "b", now + 3600, "h", "n", false, None),
            case("the budget spent, the next era", Some(&spent), 6, "b", now + 3600, "h", "n", false, Some(FirstOfEra)),
            case("pending, inside the window", Some(&pending), 5, "a", now + timeout - 1, "h", "n", false, None),
            case("pending too long", Some(&pending), 5, "a", now + timeout, "h", "n", false, Some(Retry)),
            case("pending, changed", Some(&pending), 5, "b", now + debounce, "h", "n", false, Some(Change)),
            case("pending, the budget spent", Some(&pending_spent), 5, "a", now + 2 * timeout, "h", "n", false, None),
            case("pending past the window, spend held", Some(&pending), 5, "a", now + 2 * timeout, "h", "n", true, None),
            case("pending, spend held, changed", Some(&pending), 5, "b", now + debounce, "h", "n", true, Some(Change)),
            case("pending, spend held, a new era", Some(&pending), 6, "a", now + 1, "h", "n", true, Some(FirstOfEra)),
            case("confirmed, spend held", Some(&mark), 5, "a", now + 3600, "h", "n", true, None),
            case("accepted by the peers alone", Some(&accepted), 5, "a", now + 2 * timeout, "h", "n", false, None),
            case("pending too long, changed", Some(&pending), 5, "b", now + timeout, "h", "n", false, Some(Retry)),
        ]
    }

    /// [`node_publish_why`] is [`node_publish_due`] arm for arm: due exactly
    /// when it names a reason, and the reason is the arm's.
    #[test]
    fn node_publish_why_gives_the_reason_node_publish_due_gives() {
        for c in node_publish_cases() {
            let why = node_publish_why(c.mark.as_ref(), c.era, c.sig, c.now, c.hint, c.node, c.held);
            assert_eq!(why, c.why, "{}", c.what);
            assert_eq!(node_publish_due(c.mark.as_ref(), c.era, c.sig, c.now, c.hint, c.node, c.held), why.is_some(), "{}", c.what);
        }
    }

    /// The SSF wallet's step is [`node_publish_due`] apart from the hint rule
    /// (stage 4 design §8.3): for every case of its test, with the mark's
    /// payer none (an older node's) or the money key's, it writes exactly when
    /// that is due and is idle otherwise, whether or not the heartbeat
    /// derived a burner's text.
    #[test]
    fn the_ssf_wallets_listing_step_writes_exactly_when_node_publish_due_does_for_a_listing_the_wallet_paid_for() {
        let (money, burner) = ("a0".repeat(32), "c0".repeat(32));
        for c in node_publish_cases() {
            for payer in [None, Some(money.clone())] {
                let mark = c.mark.clone().map(|m| NodePublishMark { payer: payer.clone(), ..m });
                let due = node_publish_due(mark.as_ref(), c.era, c.sig, c.now, c.hint, c.node, c.held);
                for derived in [None, Some(burner.as_str())] {
                    let step = money_listing_step(mark.as_ref(), c.era, c.sig, c.now, c.hint, c.node, c.held, &money, derived);
                    assert_eq!(step, if due { ListingStep::Write } else { ListingStep::Idle }, "{}, payer {payer:?}", c.what);
                }
            }
        }
    }

    /// The inbound flag (bit 0 of an address's flags) is cleared on every
    /// address and nothing else changes: other bits stay, and an item that
    /// does not parse is kept as it is.
    #[test]
    fn sig_without_inbound_clears_only_the_inbound_flag() {
        for (sig, want) in [
            ("", ""),
            ("198.51.100.7:4444/1", "198.51.100.7:4444/0"),
            ("198.51.100.7:4444/0", "198.51.100.7:4444/0"),
            ("[2001:db8::1]:4444/3", "[2001:db8::1]:4444/2"),
            ("a:1/1,b:2/0", "a:1/0,b:2/0"),
            ("a:1/255", "a:1/254"),
            ("garbage", "garbage"),
            ("x/notanumber", "x/notanumber"),
            ("x/256", "x/256"),
        ] {
            assert_eq!(sig_without_inbound(sig), want, "{sig:?}");
        }
        let entry = |addr: &str, flags| AddrEntry { addr: addr.parse().unwrap(), flags };
        let flagged = [entry("[2001:db8::1]:4444", chia_lane::FLAG_INBOUND_VERIFIED), entry("198.51.100.7:4444", 0)];
        let cleared = [entry("[2001:db8::1]:4444", 0), entry("198.51.100.7:4444", 0)];
        assert_eq!(sig_without_inbound(&addrs_signature(&flagged)), addrs_signature(&cleared), "what addrs_signature writes");
    }

    /// The burner path's listing gates (stage 4 design §4.3, §8.3) for one
    /// wallet on testnet11: its root, a contact key, and the payer texts of
    /// its money key and listing burners. The keys are made from fixed seeds;
    /// nothing reads the process's network or environment.
    struct Gates {
        wallet: SecretKey,
        root: crate::chia_burner::BurnerRoot,
        ck: [u8; 32],
        money: String,
    }

    /// The node id the gate tests' marks are written as.
    const GATE_NODE: &str = "our-node";
    /// The time the gate tests start at.
    const GATE_NOW: u64 = 1_791_700_000;

    impl Gates {
        fn new() -> Gates {
            use crate::chia_burner::{BurnerRoot, MoneyKey};
            let wallet = SecretKey::from_seed(&[61u8; 32]);
            let root = BurnerRoot::of(&MoneyKey::new(wallet.clone()), T11);
            let money = Payer::of(&wallet).hex();
            Gates { wallet, root, ck: [62u8; 32], money }
        }

        /// Era `era`'s listing hint, hex, as the heartbeat gives it.
        fn hint(&self, era: u64) -> String {
            hex::encode(chia_lane::derive_ck_hint(T11, &self.ck, era))
        }

        /// The payer text of era `era`'s listing burner, P(e).
        fn burner(&self, era: u64) -> String {
            Payer::of_burner(&self.root.presence(&self.ck, era)).hex()
        }

        /// Era `era`'s listing slot, in blocks into the era.
        fn slot(&self, era: u64) -> u64 {
            self.root.slot(KIND_PRESENCE, era)
        }

        /// The first era from `from` whose slot and the next era's are at
        /// least `min` blocks from either end of the first day, so that a
        /// test can stand before and after each.
        fn era_with_slots(&self, from: u64, min: u64) -> u64 {
            let fits = |era: u64| (min..crate::chia_burner::SLOT_BLOCKS - min).contains(&self.slot(era));
            (from..).find(|&era| fits(era) && fits(era + 1)).unwrap()
        }

        /// A listing of ours for `era` with the address set `sig`, written at
        /// `last_at`, confirmed and read back, paid by `payer`.
        fn mark(&self, era: u64, sig: &str, last_at: u64, payer: Option<String>) -> NodePublishMark {
            NodePublishMark {
                era,
                writes: 1,
                addrs_sig: sig.into(),
                last_at,
                hint: self.hint(era),
                confirmed: true,
                chain_seen: true,
                coin_id: String::new(),
                memo: String::new(),
                confirmed_height: 0,
                settled: false,
                spend: None,
                node_id: Some(GATE_NODE.into()),
                parked: String::new(),
                payer,
            }
        }

        /// One tick of the burner path's step at `peak`, in the era it falls
        /// in, at `now`, with the live address set `sig` and the lease
        /// holding no spend of the mark's.
        fn step(&self, clock: &mut ListingClock, mark: Option<&NodePublishMark>, peak: u32, now: u64, sig: &str, rng: &mut StdRng) -> ListingStep {
            self.tick(clock, mark, (peak, now, sig, false), rng)
        }

        /// [`Gates::step`], with `spend_held` saying whether the lease still
        /// holds the mark's spend.
        fn tick(&self, clock: &mut ListingClock, mark: Option<&NodePublishMark>, (peak, now, sig, spend_held): (u32, u64, &str, bool), rng: &mut StdRng) -> ListingStep {
            let era = chia_lane::era_of(peak);
            let hint = self.hint(era);
            let last_hint = era.checked_sub(1).map(|e| self.hint(e)).unwrap_or_default();
            let facts = ListingFacts {
                mark,
                era,
                peak,
                now,
                sig,
                hint: &hint,
                last_hint: &last_hint,
                node_id: GATE_NODE,
                spend_held,
                money: &self.money,
                root: &self.root,
                ck: &self.ck,
            };
            burner_listing_step(clock, &facts, rng)
        }
    }

    /// Block `into` of era `era`.
    fn block(era: u64, into: u64) -> u32 {
        u32::try_from(era_start(era) + into).unwrap()
    }

    fn seeded(seed: u64) -> StdRng {
        use rand::SeedableRng;
        StdRng::seed_from_u64(seed)
    }

    use rand::rngs::StdRng;

    /// T1's exception for a newcomer (stage 4 design §4.3): a station with no
    /// listing of its own last era that a reader would find writes at its
    /// next tick, whatever its slot, and draws no late start. That is no
    /// mark, last era's write unconfirmed and unread, or written as another
    /// node id or under another hint, a write of the era before last, and
    /// any station in era 0. A station listed last era waits.
    #[test]
    fn a_station_with_no_listing_of_its_own_last_edition_writes_at_once_whatever_its_slot() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (peak, sig) = (block(e, 1), "198.51.100.7:4444/0");
        let last = g.mark(e - 1, sig, GATE_NOW - 3600, Some(g.burner(e - 1)));
        let rows = [
            ("no mark at all", None),
            ("last era's write neither confirmed nor read back", Some(NodePublishMark { confirmed: false, chain_seen: false, ..last.clone() })),
            ("last era's write as another node id", Some(NodePublishMark { node_id: Some("old-node".into()), ..last.clone() })),
            ("last era's write under another hint (the contact key replaced)", Some(NodePublishMark { hint: "another contact key's hint".into(), ..last.clone() })),
            ("a confirmed write of the era before last", Some(g.mark(e - 2, sig, GATE_NOW - 3600, Some(g.burner(e - 2))))),
        ];
        for (what, mark) in &rows {
            let mut clock = ListingClock::default();
            assert_eq!(g.step(&mut clock, mark.as_ref(), peak, GATE_NOW, sig, &mut seeded(1)), ListingStep::Write, "{what}");
            assert_eq!(clock.first.map(|f| f.late), Some(None), "{what}: before the slot, no late start is drawn");
        }
        assert_eq!(g.step(&mut ListingClock::default(), None, 0, GATE_NOW, sig, &mut seeded(1)), ListingStep::Write, "era 0 has no era before it");
        for (what, listed) in [
            ("confirmed and read back", last.clone()),
            ("read back only", NodePublishMark { confirmed: false, ..last.clone() }),
            ("confirmed only", NodePublishMark { chain_seen: false, ..last.clone() }),
        ] {
            assert_eq!(g.step(&mut ListingClock::default(), Some(&listed), peak, GATE_NOW, sig, &mut seeded(1)), ListingStep::Wait(ListingWait::Slot), "listed last era, {what}: the slot");
        }
    }

    /// T1 (stage 4 design §4.3): a station listed last era writes the era's
    /// first listing at its slot, `root.slot(KIND_PRESENCE, era)` blocks into
    /// the era, and not before; a run that first sees the era before the slot
    /// draws no late start.
    #[test]
    fn a_station_listed_last_edition_waits_for_its_slot_and_writes_at_it() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (slot, sig) = (g.slot(e), "198.51.100.7:4444/0");
        // A step that took another kind's slot or another era's would be
        // told by these.
        assert_ne!(slot, g.root.slot(chia_lane::KIND_BEACON, e), "the beacon's slot is another");
        assert_ne!(slot, g.slot(e - 1), "last era's slot is another");
        let last = g.mark(e - 1, sig, GATE_NOW - 3600, Some(g.burner(e - 1)));
        let (mut clock, mut rng) = (ListingClock::default(), seeded(2));
        for into in [10, slot - 1] {
            assert_eq!(g.step(&mut clock, Some(&last), block(e, into), GATE_NOW, sig, &mut rng), ListingStep::Wait(ListingWait::Slot), "{into} blocks in");
        }
        for into in [slot, slot + 500] {
            assert_eq!(g.step(&mut clock, Some(&last), block(e, into), GATE_NOW, sig, &mut rng), ListingStep::Write, "{into} blocks in");
        }
        assert_eq!(clock.first, Some(FirstPeak { era: e, peak: block(e, 10), late: None }), "the first peak this run saw in the era is kept");
    }

    /// T2 (stage 4 design §4.3): a run whose first agreed peak in the era is
    /// past the slot draws a late start of at most [`LATE_START_MAX_BLOCKS`]
    /// once for the era, and writes when it has passed. Another tick, with
    /// another source of randomness, keeps the draw; the next era draws again,
    /// and so does a restart, whose clock is new.
    #[test]
    fn a_run_that_first_sees_an_edition_past_its_slot_waits_a_late_start_of_at_most_192_blocks_drawn_once() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (slot, sig) = (g.slot(e), "198.51.100.7:4444/0");
        let last = g.mark(e - 1, sig, GATE_NOW - 3600, Some(g.burner(e - 1)));
        let first = block(e, slot + 50);
        let draws: Vec<u32> = (0..200)
            .map(|seed| {
                let mut clock = ListingClock::default();
                g.step(&mut clock, Some(&last), first, GATE_NOW, sig, &mut seeded(seed));
                clock.first.and_then(|f| f.late).expect("a late start is drawn")
            })
            .collect();
        assert!(draws.iter().all(|&d| d <= LATE_START_MAX_BLOCKS), "{draws:?}");
        assert!(draws.iter().any(|&d| d != draws[0]), "the draws differ");
        let seed = (0..200u64).find(|&s| draws[s as usize] > 0).unwrap();
        let d = draws[seed as usize];
        let mut clock = ListingClock::default();
        assert_eq!(g.step(&mut clock, Some(&last), first, GATE_NOW, sig, &mut seeded(seed)), ListingStep::Wait(ListingWait::LateStart));
        let mut other = seeded(999);
        assert_eq!(g.step(&mut clock, Some(&last), first + d - 1, GATE_NOW, sig, &mut other), ListingStep::Wait(ListingWait::LateStart), "the block before");
        assert_eq!(g.step(&mut clock, Some(&last), first + d, GATE_NOW, sig, &mut other), ListingStep::Write, "{d} blocks after the first peak");
        assert_eq!(clock.first.and_then(|f| f.late), Some(d), "another source of randomness keeps the draw");

        let this = g.mark(e, sig, GATE_NOW, Some(g.burner(e)));
        let next_first = block(e + 1, g.slot(e + 1) + 50);
        g.step(&mut clock, Some(&this), next_first, GATE_NOW + ERA_SECS, sig, &mut other);
        let next = clock.first.unwrap();
        assert_eq!((next.era, next.peak), (e + 1, next_first), "the next era's first peak");
        assert!(next.late.is_some_and(|d| d <= LATE_START_MAX_BLOCKS), "drawn again for the next era: {next:?}");
        let mut early = ListingClock::default();
        assert_eq!(g.step(&mut early, Some(&this), block(e + 1, 10), GATE_NOW + ERA_SECS, sig, &mut other), ListingStep::Wait(ListingWait::Slot));
        assert_eq!(early.first.and_then(|f| f.late), None, "first seen before its slot: none drawn");

        let mut restarted = ListingClock::default();
        g.step(&mut restarted, Some(&last), first + d, GATE_NOW, sig, &mut seeded(seed + 1));
        assert!(restarted.first.and_then(|f| f.late).is_some_and(|d| d <= LATE_START_MAX_BLOCKS), "a restart draws again");
    }

    /// T2's late start ends [`LATE_GUARD_MARGIN_BLOCKS`] before the era guard
    /// at the latest, so the write keeps a window of several ticks outside
    /// it, and a first peak already that close to the guard is due at once.
    #[test]
    fn a_late_start_ends_a_margin_before_the_era_guard_and_is_due_at_once_inside_that_margin() {
        let e = 8;
        let guard = era_start(e) + u64::from(ERA_BLOCKS - ERA_GUARD_BLOCKS);
        let latest = guard - u64::from(LATE_GUARD_MARGIN_BLOCKS);
        let peak = |b: u64| u32::try_from(b).unwrap();
        let early = block(e, 100);
        assert_eq!(late_due_at(early, 0, e), u64::from(early));
        assert_eq!(late_due_at(early, LATE_START_MAX_BLOCKS, e), u64::from(early) + 192, "a delay that ends well before the guard is kept");
        let before = peak(latest - 100);
        assert_eq!(late_due_at(before, 50, e), latest - 50);
        assert_eq!(late_due_at(before, LATE_START_MAX_BLOCKS, e), latest, "cut to end the margin before the guard");
        assert_eq!(late_due_at(peak(latest), LATE_START_MAX_BLOCKS, e), latest, "at the margin: due at once");
        let near = peak(guard - 20);
        assert_eq!(late_due_at(near, LATE_START_MAX_BLOCKS, e), u64::from(near), "inside the margin: due at once");
        assert!(!era_guard(peak(latest)) && !era_guard(peak(guard - 1)) && era_guard(peak(guard)), "a window of the margin outside the guard");
        let clock = ListingClock { first: Some(FirstPeak { era: e, peak: before, late: Some(LATE_START_MAX_BLOCKS) }), ..ListingClock::default() };
        assert_eq!(clock.slot_wait(e, peak(latest - 1), 0), Some(ListingWait::LateStart));
        assert_eq!(clock.slot_wait(e, peak(latest), 0), None, "the clock reads the cut due block");
    }

    /// T3 (stage 4 design §4.3) after the era's first write: a changed
    /// address set waits the SSF wallet's debounce, counted from the last
    /// write, and then a jitter of at most [`CHANGE_JITTER_MAX_BLOCKS`],
    /// drawn at the first peak at which it is due. A newer set draws again
    /// from its own first due peak, and the mark's own set back is nothing to
    /// write, the clock forgotten.
    #[test]
    fn an_address_change_waits_the_debounce_and_a_jitter_of_at_most_32_blocks_drawn_once_per_new_address_set() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (old, new, newer) = ("198.51.100.7:4444/0", "203.0.113.9:4444/0", "203.0.113.10:4444/0");
        let mark = g.mark(e, old, GATE_NOW, Some(g.burner(e)));
        let (p, due) = (block(e, 3000), GATE_NOW + ADDR_CHANGE_DEBOUNCE_SECS);
        let mut clock = ListingClock::default();
        assert_eq!(g.step(&mut clock, Some(&mark), p, due - 1, new, &mut seeded(3)), ListingStep::Wait(ListingWait::Change), "inside the debounce");
        assert!(clock.change.is_none(), "no jitter is drawn before the change is due");
        let jitters: Vec<u32> = (0..200)
            .map(|seed| {
                let mut clock = ListingClock::default();
                g.step(&mut clock, Some(&mark), p, due, new, &mut seeded(seed));
                clock.change.expect("a jitter is drawn once the change is due").jitter
            })
            .collect();
        assert!(jitters.iter().all(|&j| j <= CHANGE_JITTER_MAX_BLOCKS), "{jitters:?}");
        assert!(jitters.iter().any(|&j| j != jitters[0]), "the jitters differ");
        let seed = (0..200u64).find(|&s| jitters[s as usize] > 0).unwrap();
        let j = jitters[seed as usize];
        let mut clock = ListingClock::default();
        assert_eq!(g.step(&mut clock, Some(&mark), p, due, new, &mut seeded(seed)), ListingStep::Wait(ListingWait::Change), "due, the jitter ahead");
        let mut other = seeded(999);
        assert_eq!(g.step(&mut clock, Some(&mark), p + j - 1, due + 600, new, &mut other), ListingStep::Wait(ListingWait::Change), "the block before");
        assert_eq!(g.step(&mut clock, Some(&mark), p + j, due + 600, new, &mut other), ListingStep::Write, "{j} blocks after it was due");
        let q = p + j;
        g.step(&mut clock, Some(&mark), q, due + 900, newer, &mut other);
        assert_eq!(clock.change.as_ref().map(|c| (c.sig.as_str(), c.due_peak)), Some((newer, q)), "a newer set: drawn again from its own first due peak");
        assert_eq!(g.step(&mut clock, Some(&mark), q + 1, due + 960, old, &mut other), ListingStep::Idle, "the mark's own set: nothing to write");
        assert!(clock.change.is_none(), "…and the clock forgotten");
    }

    /// T3's clock belongs to its era (stage 4 design §4.3): a change still
    /// waiting its jitter as an era ends is not carried into the next. At a
    /// tick of the new era the mark is last era's listing, and the same
    /// changed set is a change before the slot, drawn again from that tick,
    /// so it does not go out on the old era's draw.
    #[test]
    fn a_change_still_waiting_its_jitter_as_the_edition_ends_is_drawn_again_in_the_next() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (old, new) = ("198.51.100.7:4444/0", "203.0.113.9:4444/0");
        let mark = g.mark(e, old, GATE_NOW, Some(g.burner(e)));
        let p = block(e, u64::from(ERA_BLOCKS - ERA_GUARD_BLOCKS) - 3);
        let due = GATE_NOW + ADDR_CHANGE_DEBOUNCE_SECS;
        let left = u32::try_from(era_start(e + 1) - u64::from(p)).unwrap();
        let seed = (0..200u64)
            .find(|&s| {
                let mut clock = ListingClock::default();
                g.step(&mut clock, Some(&mark), p, due, new, &mut seeded(s));
                clock.change.is_some_and(|c| c.jitter > left)
            })
            .expect("a jitter that outlasts the era");
        let mut clock = ListingClock::default();
        assert_eq!(g.step(&mut clock, Some(&mark), p, due, new, &mut seeded(seed)), ListingStep::Wait(ListingWait::Change), "drawn, and waiting as the era ends");
        let j = clock.change.as_ref().map(|c| c.jitter).unwrap();
        let q = block(e + 1, 40);
        assert!(u64::from(q) >= u64::from(p) + u64::from(j), "the old draw would be due by then");
        let step = g.step(&mut clock, Some(&mark), q, due + 3600, new, &mut seeded(seed + 1));
        let seen = clock.change.as_ref().expect("the change is due: a jitter is drawn");
        assert_eq!((seen.era, seen.due_peak), (e + 1, q), "the new era's own draw, from its own tick");
        assert_eq!(step, if seen.jitter == 0 { ListingStep::Write } else { ListingStep::Wait(ListingWait::Change) });
    }

    /// Stage 4 design §4.3: on the burner path last era's listing reads
    /// listed while this era's first write waits for its slot, so the
    /// heartbeat judges it by its own era until it settles, as it does this
    /// era's; with the SSF wallet paying it is not judged once the era
    /// turns, as on main.
    #[test]
    fn last_weeks_listing_is_judged_by_its_own_era_until_it_settles_only_on_the_burner_path() {
        let mark = NodePublishMark {
            era: 7,
            writes: 1,
            addrs_sig: "a:1/0".into(),
            last_at: 1_791_700_000,
            hint: "h7".into(),
            coin_id: "11".repeat(32),
            confirmed: true,
            chain_seen: true,
            spend: Some(3),
            node_id: Some("n".into()),
            ..NodePublishMark::default()
        };
        assert_eq!(listing_judged_era(Some(&mark), 7, "n", false), Some(7), "this era's, on either path");
        assert_eq!(listing_judged_era(Some(&mark), 7, "n", true), Some(7));
        assert_eq!(listing_judged_era(Some(&mark), 8, "n", true), Some(7), "last era's, on the burner path, by its own era");
        assert_eq!(listing_judged_era(Some(&mark), 8, "n", false), None, "with the SSF wallet paying, as on main");
        assert_eq!(listing_judged_era(Some(&mark), 9, "n", true), None, "two eras back: not read, not judged");
        assert_eq!(listing_judged_era(Some(&mark), 8, "another", true), None, "another node id's");
        assert_eq!(listing_judged_era(Some(&NodePublishMark { settled: true, ..mark.clone() }), 8, "n", true), None, "settled");
        assert_eq!(listing_judged_era(Some(&mark.voided()), 8, "n", true), None, "void: nothing to judge");
        assert_eq!(listing_judged_era(Some(&NodePublishMark { era: 0, ..mark.clone() }), 0, "n", true), Some(0));
        assert_eq!(listing_judged_era(None, 8, "n", true), None);
    }

    /// Stage 4 design §10: the burner path's failure words say that last
    /// week's listing still works only while the mark on record is last
    /// era's listing of ours, confirmed or read back, with the live address
    /// set, the inbound flag a new era clears aside. After a change of
    /// address that listing is still read, but it sends readers to the old
    /// addresses.
    #[test]
    fn last_weeks_listing_still_works_only_while_it_carries_the_live_addresses() {
        let g = Gates::new();
        let e = 8;
        let (sig, cleared, moved) = ("198.51.100.7:4444/1", "198.51.100.7:4444/0", "203.0.113.9:4444/0");
        let last_hint = g.hint(e - 1);
        let last = g.mark(e - 1, sig, GATE_NOW - 3600, Some(g.burner(e - 1)));
        let works = |mark: &NodePublishMark, live: &str| last_week_still_works(Some(mark), e, &last_hint, GATE_NODE, live);
        assert!(works(&last, sig), "the same set");
        assert!(works(&last, cleared), "the inbound flag the new era cleared");
        assert!(!works(&last, moved), "a changed set: it sends readers to the old address");
        assert!(has_last_era_listing(Some(&last), e, &last_hint, GATE_NODE), "though it is still last era's listing");
        assert!(!works(&NodePublishMark { confirmed: false, chain_seen: false, ..last.clone() }, sig), "never confirmed nor read back");
        assert!(!works(&g.mark(e, sig, GATE_NOW, Some(g.burner(e))), sig), "this era's listing on record");
        assert!(!last_week_still_works(None, e, &last_hint, GATE_NODE, sig), "nothing on record");
    }

    /// Before the era's first write, last era's address set and the live one
    /// are compared with the inbound flag cleared (stage 4 design §4.3): the
    /// flag the new era cleared is no change, and the slot decides. A real
    /// change takes the slot's place once its debounce and jitter have
    /// passed, and the flag turning on again on the changed set is the same
    /// change, not a new draw. A change still inside its debounce waits as a
    /// change.
    #[test]
    fn before_the_slot_the_inbound_flag_the_new_edition_cleared_is_no_change_and_a_real_change_takes_the_slots_place() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let slot = g.slot(e);
        let last = g.mark(e - 1, "198.51.100.7:4444/1", GATE_NOW - 3600, Some(g.burner(e - 1)));
        let p = block(e, 5);
        let (mut clock, mut rng) = (ListingClock::default(), seeded(4));
        assert_eq!(g.step(&mut clock, Some(&last), p, GATE_NOW, "198.51.100.7:4444/0", &mut rng), ListingStep::Wait(ListingWait::Slot), "only the flag the new era cleared");
        assert!(clock.change.is_none());
        let moved = "203.0.113.9:4444/0";
        let at_first = g.step(&mut clock, Some(&last), p, GATE_NOW, moved, &mut rng);
        let j = clock.change.as_ref().map(|c| c.jitter).expect("an hour since the last write: due, a jitter drawn");
        assert_eq!(at_first, if j == 0 { ListingStep::Write } else { ListingStep::Wait(ListingWait::Change) });
        g.step(&mut clock, Some(&last), p, GATE_NOW + 60, "203.0.113.9:4444/1", &mut rng);
        assert_eq!(clock.change.as_ref().map(|c| (c.due_peak, c.jitter)), Some((p, j)), "the flag on again on the changed set: the same change");
        assert_eq!(g.step(&mut clock, Some(&last), p + j, GATE_NOW + 120, moved, &mut rng), ListingStep::Write, "after its jitter");
        assert!(u64::from(p + j) < era_start(e) + slot, "well before the slot");
        // Last era's write ten minutes less a minute ago: the change waits
        // the rest of the debounce, counted from that write, before any
        // jitter is drawn, at a peak past every jitter as well.
        let recent = NodePublishMark { last_at: GATE_NOW - 60, ..last.clone() };
        let mut clock = ListingClock::default();
        assert_eq!(g.step(&mut clock, Some(&recent), p, GATE_NOW, moved, &mut rng), ListingStep::Wait(ListingWait::Change), "inside the debounce");
        assert!(clock.change.is_none(), "no jitter is drawn inside the debounce");
        let later = p + CHANGE_JITTER_MAX_BLOCKS + 1;
        assert_eq!(g.step(&mut clock, Some(&recent), later, GATE_NOW + ADDR_CHANGE_DEBOUNCE_SECS - 61, moved, &mut rng), ListingStep::Wait(ListingWait::Change), "still inside it");
        assert!(clock.change.is_none());
        g.step(&mut clock, Some(&recent), later, GATE_NOW + ADDR_CHANGE_DEBOUNCE_SECS - 60, moved, &mut rng);
        assert_eq!(clock.change.as_ref().map(|c| c.due_peak), Some(later), "due once the debounce has passed, drawn there");
    }

    /// Stage 4 design §12, Migration: a listing of this era that the SSF
    /// wallet paid for, or an older node's that names no payer, holds the
    /// burner's rewrites, a change and a retry alike, until the next era,
    /// and a change waiting is shown held as well. In the next era the same
    /// mark is last era's listing: the era's first write waits for its slot
    /// with the same address set (or one differing only in the inbound flag),
    /// and goes out as a change after its jitter with a changed one.
    #[test]
    fn a_burner_rewrite_after_a_money_paid_listing_of_this_edition_is_held_until_the_next_edition() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (old, flagged, new) = ("198.51.100.7:4444/0", "198.51.100.7:4444/1", "203.0.113.9:4444/0");
        let held = ListingStep::HeldByHint(PaidBy::Money);
        let mut rng = seeded(5);
        for (what, payer) in [("an older node's mark, naming no payer", None), ("the SSF wallet's", Some(g.money.clone()))] {
            let mark = g.mark(e, old, GATE_NOW, payer);
            let p = block(e, 3000);
            assert_eq!(g.step(&mut ListingClock::default(), Some(&mark), p, GATE_NOW + ADDR_CHANGE_DEBOUNCE_SECS, new, &mut rng), held, "{what}: a debounced change");
            assert_eq!(g.step(&mut ListingClock::default(), Some(&mark), p, GATE_NOW + 1, new, &mut rng), held, "{what}: a change inside its debounce");
            let pending = NodePublishMark { confirmed: false, chain_seen: false, ..mark.clone() };
            assert_eq!(g.step(&mut ListingClock::default(), Some(&pending), p, GATE_NOW + PRESENCE_CONFIRM_TIMEOUT_SECS, old, &mut rng), held, "{what}: the timeout's retry");
            assert_eq!(hint_rule_holds(Some(&mark), e, &g.hint(e), true, &g.money, Some(&g.burner(e))), Some(PaidBy::Money), "{what}");
            assert_eq!(g.step(&mut ListingClock::default(), Some(&mark), p, GATE_NOW + 3600, old, &mut rng), ListingStep::Idle, "{what}: nothing due");

            let (next, slot) = (e + 1, g.slot(e + 1));
            let later = GATE_NOW + ERA_SECS;
            for sig in [old, flagged] {
                let mut clock = ListingClock::default();
                assert_eq!(g.step(&mut clock, Some(&mark), block(next, slot - 1), later, sig, &mut rng), ListingStep::Wait(ListingWait::Slot), "{what}, {sig}: the next era's slot");
                assert_eq!(g.step(&mut clock, Some(&mark), block(next, slot), later, sig, &mut rng), ListingStep::Write, "{what}, {sig}: written at it");
            }
            let mut clock = ListingClock::default();
            let first = g.step(&mut clock, Some(&mark), block(next, 5), later, new, &mut rng);
            let j = clock.change.as_ref().map(|c| u64::from(c.jitter)).unwrap();
            assert_eq!(first, if j == 0 { ListingStep::Write } else { ListingStep::Wait(ListingWait::Change) }, "{what}: a changed set");
            assert_eq!(g.step(&mut clock, Some(&mark), block(next, 5 + j), later, new, &mut rng), ListingStep::Write, "{what}: after its jitter");
        }
    }

    /// The reverse direction of the hint rule (stage 4 design §8.3), on the
    /// SSF wallet's path with burner keys off: a listing of this era that
    /// this wallet's own listing burner paid for, whatever node id wrote it,
    /// holds a rewrite until the next era. One the wallet paid for, an older
    /// node's, or one another wallet paid for (a wallet swapped mid-era) does
    /// not, so the step is the SSF wallet's as it always was. Last era's
    /// listing paid by a burner holds nothing, and nothing due is idle.
    #[test]
    fn a_money_rewrite_after_a_burner_paid_listing_of_this_edition_is_held_until_the_next_edition() {
        let g = Gates::new();
        let e = 8;
        let (hint, burner) = (g.hint(e), g.burner(e));
        let swapped = Payer::of(&SecretKey::from_seed(&[63u8; 32])).hex();
        let changed = GATE_NOW + ADDR_CHANGE_DEBOUNCE_SECS;
        let step = |mark: &NodePublishMark, now: u64, sig: &str| {
            let derived = money_path_burner_payer(Some(mark), e, &hint, &g.money, T11, &g.wallet, &g.ck);
            money_listing_step(Some(mark), e, sig, now, &hint, GATE_NODE, false, &g.money, derived.as_deref())
        };
        let ours = g.mark(e, "a", GATE_NOW, Some(burner.clone()));
        assert_eq!(step(&ours, changed, "b"), ListingStep::HeldByHint(PaidBy::Burner), "this wallet's listing burner paid for it");
        let other_node = NodePublishMark { node_id: Some("old-node".into()), ..ours.clone() };
        assert_eq!(step(&other_node, GATE_NOW + 1, "a"), ListingStep::HeldByHint(PaidBy::Burner), "as another node id under the same hint");
        for (what, payer) in [("an older node's", None), ("the SSF wallet's", Some(g.money.clone())), ("another wallet's", Some(swapped))] {
            assert_eq!(step(&g.mark(e, "a", GATE_NOW, payer), changed, "b"), ListingStep::Write, "{what}: written as on main");
        }
        let last = g.mark(e - 1, "a", GATE_NOW - 3600, Some(g.burner(e - 1)));
        assert_eq!(step(&last, GATE_NOW, "a"), ListingStep::Write, "last era's burner-paid listing: a new era, due at once");
        assert_eq!(step(&ours, GATE_NOW + 3600, "a"), ListingStep::Idle, "nothing due");
    }

    /// The hint rule is keyed on the era, the hint and the payer, never the
    /// node id (stage 4 design §8.3): on the burner path, a listing of this
    /// era under this hint that another node id wrote (the node key replaced,
    /// the contact key kept) holds the era's first write if another payer
    /// paid for it, and does not if this wallet's own listing burner did. One
    /// under another hint (the contact key replaced) holds nothing.
    #[test]
    fn the_hint_rule_holds_by_the_era_the_hint_and_the_payer_never_by_the_node_id() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (peak, sig) = (block(e, 5), "198.51.100.7:4444/0");
        let swapped = Payer::of(&SecretKey::from_seed(&[63u8; 32])).hex();
        let another = |payer: Option<String>| NodePublishMark { node_id: Some("old-node".into()), ..g.mark(e, sig, GATE_NOW - 60, payer) };
        let mut rng = seeded(6);
        for (what, payer, step) in [
            ("an older node's mark, naming no payer", None, ListingStep::HeldByHint(PaidBy::Money)),
            ("the SSF wallet's", Some(g.money.clone()), ListingStep::HeldByHint(PaidBy::Money)),
            ("another wallet's", Some(swapped), ListingStep::HeldByHint(PaidBy::Other)),
            ("this wallet's own listing burner's", Some(g.burner(e)), ListingStep::Write),
        ] {
            assert_eq!(g.step(&mut ListingClock::default(), Some(&another(payer)), peak, GATE_NOW, sig, &mut rng), step, "another node id, {what}");
        }
        let replaced = NodePublishMark { hint: "another contact key's hint".into(), ..another(None) };
        assert_eq!(g.step(&mut ListingClock::default(), Some(&replaced), peak, GATE_NOW, sig, &mut rng), ListingStep::Write, "under another hint: at once");
    }

    /// The burner path's step keeps the SSF wallet's budget, timeout and
    /// voided-write rules: a changed set with the era's budget spent is
    /// nothing to write, and forgets the change clock; a pending listing
    /// whose spend the lease holds waits for the chain; a voided write of
    /// this era is written again at once if this era's listing burner paid
    /// for it, and held if the SSF wallet did. Before the slot, a change
    /// still inside its debounce gives way to the slot when the slot comes
    /// first.
    #[test]
    fn the_burner_listing_step_keeps_the_budget_the_held_spend_and_the_voided_retry_and_the_slot_can_come_before_a_change() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let (old, new) = ("198.51.100.7:4444/0", "203.0.113.9:4444/0");
        let p = block(e, 3000);
        let mut rng = seeded(7);
        let spent = NodePublishMark { writes: 1 + MAX_NODE_WRITES_PER_ERA, ..g.mark(e, old, GATE_NOW, Some(g.burner(e))) };
        let mut clock = ListingClock { change: Some(ChangeSeen { era: e, sig: new.into(), due_peak: p, jitter: 3 }), ..ListingClock::default() };
        assert_eq!(g.step(&mut clock, Some(&spent), p + 10, GATE_NOW + 3600, new, &mut rng), ListingStep::Idle, "the budget spent");
        assert!(clock.change.is_none(), "…and the change clock forgotten");

        let pending = NodePublishMark { confirmed: false, chain_seen: false, spend: Some(4), ..g.mark(e, old, GATE_NOW, Some(g.burner(e))) };
        let late = GATE_NOW + 2 * PRESENCE_CONFIRM_TIMEOUT_SECS;
        assert_eq!(g.tick(&mut ListingClock::default(), Some(&pending), (p, late, old, true), &mut rng), ListingStep::Idle, "the lease holds its spend");
        assert_eq!(g.tick(&mut ListingClock::default(), Some(&pending), (p, late, old, false), &mut rng), ListingStep::Write, "…and once it no longer does, a retry");

        let voided = g.mark(e, old, GATE_NOW, Some(g.burner(e))).voided();
        assert_eq!(g.step(&mut ListingClock::default(), Some(&voided), p, GATE_NOW + 60, old, &mut rng), ListingStep::Write, "voided, this era's burner's");
        let voided_money = g.mark(e, old, GATE_NOW, Some(g.money.clone())).voided();
        assert_eq!(g.step(&mut ListingClock::default(), Some(&voided_money), p, GATE_NOW + 60, old, &mut rng), ListingStep::HeldByHint(PaidBy::Money), "voided, the SSF wallet's");

        let slot = g.slot(e);
        let recent = g.mark(e - 1, old, GATE_NOW - 60, Some(g.burner(e - 1)));
        let mut clock = ListingClock::default();
        assert_eq!(g.step(&mut clock, Some(&recent), block(e, slot - 1), GATE_NOW, new, &mut rng), ListingStep::Wait(ListingWait::Change), "a change inside its debounce");
        assert!(clock.change.is_none(), "no jitter is drawn inside the debounce");
        assert_eq!(g.step(&mut clock, Some(&recent), block(e, slot), GATE_NOW + 60, new, &mut rng), ListingStep::Write, "the slot comes first");
        assert!(clock.change.is_none(), "…and still none drawn");
    }

    /// The era's listing burner's payer text is derived once an era and
    /// served from the clock after that (stage 4 design §3.2), and derived
    /// again for a new era or a new hint. The step compares the mark's payer
    /// with this era's text: a clock that had derived last era's would hold
    /// this era's own burner's listing.
    #[test]
    fn the_listing_clock_derives_each_editions_listing_burner_once_and_again_for_the_next() {
        let g = Gates::new();
        let e = g.era_with_slots(8, 100);
        let mut clock = ListingClock::default();
        assert_eq!(clock.burner_payer(&g.root, &g.ck, e, &g.hint(e)), g.burner(e));
        clock.burner.as_mut().unwrap().payer = "kept".into();
        assert_eq!(clock.burner_payer(&g.root, &g.ck, e, &g.hint(e)), "kept", "served from the clock for the era");
        assert_eq!(clock.burner_payer(&g.root, &g.ck, e + 1, &g.hint(e + 1)), g.burner(e + 1), "derived again for the next era");
        assert_ne!(g.burner(e), g.burner(e + 1));
        let ck = [64u8; 32];
        let other_hint = hex::encode(chia_lane::derive_ck_hint(T11, &ck, e + 1));
        assert_eq!(clock.burner_payer(&g.root, &ck, e + 1, &other_hint), Payer::of_burner(&g.root.presence(&ck, e + 1)).hex(), "derived again for a new hint");

        let sig = "198.51.100.7:4444/0";
        let mut clock = ListingClock::default();
        let mut rng = seeded(8);
        g.step(&mut clock, None, block(e - 1, 10), GATE_NOW - ERA_SECS, sig, &mut rng);
        let voided = g.mark(e, sig, GATE_NOW, Some(g.burner(e))).voided();
        assert_eq!(g.step(&mut clock, Some(&voided), block(e, 3000), GATE_NOW, sig, &mut rng), ListingStep::Write, "this era's burner, not last era's");
        let stale = g.mark(e, sig, GATE_NOW, Some(g.burner(e - 1))).voided();
        assert_eq!(g.step(&mut clock, Some(&stale), block(e, 3000), GATE_NOW, sig, &mut rng), ListingStep::HeldByHint(PaidBy::Other), "last era's burner is another key");
    }

    /// The SSF wallet's step gets this wallet's listing burner's text only
    /// where the hint rule could hold on it (stage 4 design §8.3): on a test
    /// network, for a mark of this era under this hint whose payer is
    /// neither none nor the money key's. Every other mark, and every mark
    /// off a test network, makes no root at all.
    #[test]
    fn the_ssf_wallets_step_derives_its_listing_burner_only_for_a_mark_another_payer_wrote_on_a_test_network() {
        let g = Gates::new();
        let e = 8;
        let hint = g.hint(e);
        let swapped = Payer::of(&SecretKey::from_seed(&[63u8; 32])).hex();
        let derived = |mark: &NodePublishMark, net| money_path_burner_payer(Some(mark), e, &hint, &g.money, net, &g.wallet, &g.ck);
        for (what, payer) in [("this wallet's burner's", g.burner(e)), ("another wallet's", swapped.clone())] {
            assert_eq!(derived(&g.mark(e, "a", GATE_NOW, Some(payer)), T11), Some(g.burner(e)), "{what}");
        }
        for (what, mark) in [
            ("an older node's", g.mark(e, "a", GATE_NOW, None)),
            ("the SSF wallet's", g.mark(e, "a", GATE_NOW, Some(g.money.clone()))),
            ("last era's", g.mark(e - 1, "a", GATE_NOW, Some(g.burner(e - 1)))),
            ("under another hint", NodePublishMark { hint: "another".into(), ..g.mark(e, "a", GATE_NOW, Some(swapped.clone())) }),
        ] {
            assert_eq!(derived(&mark, T11), None, "{what}");
        }
        assert_eq!(derived(&g.mark(e, "a", GATE_NOW, Some(g.burner(e))), crate::chia_network::ChiaNet::Mainnet), None, "off a test network");
        assert_eq!(money_path_burner_payer(None, e, &hint, &g.money, T11, &g.wallet, &g.ck), None, "no mark");
    }

    /// Stage 4 design §10's Phone Book sentences for a listing from a
    /// burner key: a dry dish and a busy chain, and the first write's wait on
    /// a spend of the SSF wallet's (§8.3), each with and without the word
    /// that last era's listing still works. Every other failure reads as its
    /// own text, a lost race and the burner's other waits among them. None of
    /// them sends the page to the Bank, whose cue is "unfunded".
    #[test]
    fn the_listings_failures_say_what_section_10_says() {
        use super::claim_write::BurnerWait;
        use crate::chia_faucet::ClaimToError;
        let dry = "The lobby dish has no mojo ready. Your station tries again every few minutes.";
        let mut said = Vec::new();
        for e in [anyhow::Error::from(BurnerWait::NoCoinReady), ClaimToError::NoCoinReady.into(), anyhow::Error::from(BurnerWait::NoCoinReady).context("presence")] {
            assert_eq!(listing_failure_words(&e, true), format!("{dry} Last week's listing still works."), "{e:#}");
            assert_eq!(listing_failure_words(&e, false), dry, "{e:#}");
            said.extend([listing_failure_words(&e, true), listing_failure_words(&e, false)]);
        }
        let full = anyhow::Error::from(PushError::Rejected("a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into())).context("presence");
        assert_eq!(listing_failure_words(&full, true), "The chain is busy. Your listing waits for room. Waiting costs nothing, and last week's listing still works.");
        assert_eq!(listing_failure_words(&full, false), "The chain is busy. Your listing waits for room. Waiting costs nothing.");
        said.extend([listing_failure_words(&full, true), listing_failure_words(&full, false)]);
        let landing = "A spend from the SSF wallet is still on its way. Your listing goes out once it lands.";
        for e in [anyhow::Error::from(BurnerWait::MoneyInFlight), anyhow::Error::from(BurnerWait::MoneyInFlight).context("presence")] {
            assert_eq!(listing_failure_words(&e, true), format!("{landing} Last week's listing still works."), "{e:#}");
            assert_eq!(listing_failure_words(&e, false), landing, "{e:#}");
            said.extend([listing_failure_words(&e, true), listing_failure_words(&e, false)]);
        }
        let others: Vec<anyhow::Error> = vec![
            anyhow::Error::from(PushError::Rejected("a: DOUBLE_SPEND".into())).context("presence"),
            PushError::Rejected("a: DOUBLE_SPEND; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into()).into(),
            BurnerWait::Held.into(),
            BurnerWait::PeakUnavailable.into(),
            BurnerWait::FuseBlown { era: 8 }.into(),
            ClaimToError::PeakUnavailable.into(),
        ];
        for e in &others {
            for last_week in [true, false] {
                assert_eq!(listing_failure_words(e, last_week), format!("{e:#}"), "its own text");
            }
        }
        assert_eq!(listing_failure_words(&BurnerWait::Held.into(), false), BurnerWait::Held.to_string());
        for words in &said {
            assert!(!words.to_lowercase().contains("unfunded") && words.chars().count() < 160, "{words}");
        }
    }

    /// Every wait and hold of the listing step has its Phone Book words, and
    /// a write or nothing due has none. A hold names the class of the payer
    /// that holds it, and says who writes the next era's listing on each
    /// path; none of the words says the next one goes out as the new era
    /// starts on the burner path. Every text fits the page's 160 characters
    /// and none sends it to the Bank.
    #[test]
    fn every_listing_wait_has_its_words_and_a_write_has_none() {
        use ListingStep::*;
        assert_eq!(listing_wait_words(Wait(ListingWait::Slot), true), Some(LISTING_SLOT_WORDS));
        assert_eq!(listing_wait_words(Wait(ListingWait::LateStart), true), Some(LISTING_LATE_WORDS));
        assert_eq!(listing_wait_words(Wait(ListingWait::Change), true), Some(LISTING_CHANGE_WORDS));
        for burner_path in [true, false] {
            assert_eq!(listing_wait_words(Write, burner_path), None);
            assert_eq!(listing_wait_words(Idle, burner_path), None);
        }
        let held = |burner_path, by| listing_wait_words(HeldByHint(by), burner_path).unwrap();
        assert!(held(true, PaidBy::Money).contains("paid by the SSF wallet") && held(true, PaidBy::Money).ends_with("the next edition's listing goes out from its own key"));
        for by in [PaidBy::Other, PaidBy::Burner] {
            assert!(held(true, by).contains("paid by another key") && held(true, by).ends_with("the next edition's listing goes out from its own key"), "{by:?}");
            assert!(held(false, by).contains("paid by another key") && held(false, by).ends_with("the SSF wallet writes the next edition's"), "{by:?}");
        }
        assert!(held(false, PaidBy::Money).contains("paid by the SSF wallet"));
        let mut all = vec![LISTING_SLOT_WORDS, LISTING_LATE_WORDS, LISTING_CHANGE_WORDS, BUDGET_SPENT_WORDS, BURNER_BUDGET_SPENT_WORDS, SPEND_LIVE_WORDS, BURNER_SPEND_LIVE_WORDS];
        for burner_path in [true, false] {
            all.extend([PaidBy::Money, PaidBy::Burner, PaidBy::Other].map(|by| held(burner_path, by)));
        }
        for words in all {
            assert!(words.chars().count() < 160, "{words}");
            assert!(!words.to_lowercase().contains("unfunded"), "{words}");
            assert!(!words.contains("when the new edition starts"), "{words}");
        }
    }

    /// The Phone Book's readout of the listing arm. With the SSF wallet
    /// paying and a step that writes or has nothing due, it is the chain the
    /// heartbeat always gave, word for word, and never holds last era's
    /// listing as listed. A wait's or a hold's words come after a refusal and
    /// before the last error; the burner path names its budget and its held
    /// spend in its own words. Last era's listing reads as listed only on the
    /// burner path while the step waits for its slot or its late start.
    #[test]
    fn the_listing_readout_is_the_ssf_wallets_word_for_word_and_holds_last_editions_listing_only_while_a_burner_waits_its_slot() {
        use ListingStep::*;
        let main = |refused: Option<&str>, error: Option<&str>, budget: bool, live: bool| {
            refused
                .or(error)
                .or(budget.then_some("this era's write budget is spent; the next listing goes out with the new era"))
                .or(live.then_some("the wallet still holds the listing's spend, so it is not written again; the chain settles it"))
                .map(str::to_owned)
        };
        for refused in [None, Some("no memo spend from the SSF wallet here")] {
            for error in [None, Some("push_tx rejected")] {
                for (budget, live) in [(false, false), (true, false), (false, true), (true, true)] {
                    for (step, void) in [(Write, false), (Idle, false), (Write, true), (Idle, true)] {
                        assert_eq!(
                            listing_readout(refused, step, false, void, error, budget, live),
                            (main(refused, error, budget, live), ListingHold::Nothing),
                            "{refused:?} {error:?} {budget} {live} {step:?} {void}"
                        );
                    }
                }
            }
        }
        let held = HeldByHint(PaidBy::Burner);
        let held_words = listing_wait_words(held, false).map(str::to_owned);
        assert_eq!(listing_readout(None, held, false, false, Some("push_tx rejected"), true, true), (held_words, ListingHold::Nothing), "the SSF wallet held: its words first");
        assert_eq!(listing_readout(Some("refused"), held, false, false, None, false, false), (Some("refused".into()), ListingHold::Nothing), "…after a refusal");

        for (step, words, holds) in [
            (Wait(ListingWait::Slot), LISTING_SLOT_WORDS, true),
            (Wait(ListingWait::LateStart), LISTING_LATE_WORDS, true),
            (Wait(ListingWait::Change), LISTING_CHANGE_WORDS, false),
        ] {
            let hold = if holds { ListingHold::LastEra } else { ListingHold::Nothing };
            for void in [false, true] {
                assert_eq!(listing_readout(None, step, true, void, Some("push_tx rejected"), true, true), (Some(words.into()), hold), "{step:?} {void}");
                assert_eq!(listing_readout(Some("refused"), step, true, void, None, false, false), (Some("refused".into()), ListingHold::Nothing), "{step:?} after a refusal");
            }
        }
        let burner_held = HeldByHint(PaidBy::Money);
        assert_eq!(listing_readout(None, burner_held, true, false, None, false, false), (listing_wait_words(burner_held, true).map(str::to_owned), ListingHold::Nothing));
        for step in [Write, Idle] {
            assert_eq!(listing_readout(None, step, true, false, Some("push_tx rejected"), true, true), (Some("push_tx rejected".into()), ListingHold::Nothing), "{step:?}");
            assert_eq!(listing_readout(None, step, true, false, None, true, true), (Some(BURNER_BUDGET_SPENT_WORDS.into()), ListingHold::Nothing), "{step:?}");
            assert_eq!(listing_readout(None, step, true, false, None, false, true), (Some(BURNER_SPEND_LIVE_WORDS.into()), ListingHold::Nothing), "{step:?}");
            assert_eq!(listing_readout(None, step, true, true, None, false, false), (None, ListingHold::Nothing), "{step:?}");
        }

        // A hold on a void listing of this era: its own words, which claim
        // nothing stays, and the state held to outdated (§8.3).
        for (burner_path, by) in [(true, PaidBy::Money), (true, PaidBy::Other), (false, PaidBy::Burner), (false, PaidBy::Other)] {
            let held = HeldByHint(by);
            let words = unlanded_hold_words(by, burner_path);
            assert!(words.contains("did not make it into the book") && !words.contains("stays as it is"), "{words}");
            assert_eq!(words.contains("paid by the SSF wallet"), by == PaidBy::Money, "{words}");
            assert!(words.chars().count() < 160 && !words.to_lowercase().contains("unfunded"), "fits the page's 160 characters: {words}");
            assert_eq!(
                listing_readout(None, held, burner_path, true, Some("push_tx rejected"), true, true),
                (Some(words.into()), ListingHold::Unlanded),
                "{burner_path} {by:?}"
            );
            assert_eq!(listing_readout(None, held, burner_path, false, None, false, false), (listing_wait_words(held, burner_path).map(str::to_owned), ListingHold::Nothing));
            assert_eq!(listing_readout(Some("refused"), held, burner_path, true, None, false, false), (Some("refused".into()), ListingHold::Nothing), "after a refusal");
        }
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
            memo: String::new(),
            confirmed_height: 0,
            settled: false,
            spend: None,
            node_id: Some("n".into()),
            parked: String::new(),
            payer: None,
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
            crate::ChiaPresence { state: Listed, era: 5, listed_era: 5, last_at: now, confirmed: true, current: true, public_addrs: 2, error: None, unlanded: false }
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

    /// 📖 With burner keys on, last edition's listing read back from the
    /// chain still reads as listed, with its own figures, while this
    /// edition's waits for its slot or its late start (stage 4 design §4.3):
    /// the inbound flag the new edition cleared is no change. A real change of
    /// addresses, a listing never read back, an older one, another identity's
    /// or no edition to judge by reads as before, and without the hold every
    /// readout is the SSF wallet's, word for word.
    #[test]
    fn last_editions_listing_reads_listed_while_this_editions_waits_for_its_slot_and_outdated_otherwise() {
        use crate::ChiaPresenceState::*;
        let now = 1_791_700_000u64;
        let last = NodePublishMark {
            era: 7,
            writes: 1,
            addrs_sig: "a:1/1".into(),
            last_at: now,
            hint: "h7".into(),
            confirmed: true,
            chain_seen: true,
            node_id: Some("n".into()),
            ..NodePublishMark::default()
        };
        let busy = Some("the chain is busy");
        let held = presence_status_with(Some(&last), Some("h8"), "n", Some(8), "a:1/0", 2, busy, ListingHold::LastEra);
        assert_eq!(
            held,
            crate::ChiaPresence {
                state: Listed,
                era: 8,
                listed_era: 7,
                last_at: now,
                confirmed: true,
                current: true,
                public_addrs: 2,
                error: busy.map(str::to_owned),
                unlanded: false,
            },
            "last edition's listing is the one in force, and the text beside it is carried as given"
        );
        let unheld = presence_status_with(Some(&last), Some("h8"), "n", Some(8), "a:1/0", 2, busy, ListingHold::Nothing);
        assert_eq!((unheld.state, unheld.listed_era, unheld.confirmed, unheld.current), (Outdated, 7, true, false), "no hold: last edition's listing is stale");
        assert_eq!(unheld, presence_status(Some(&last), Some("h8"), "n", Some(8), "a:1/0", 2, busy), "no hold: the readout as it always was");
        assert_eq!(presence_state_with(Some(&last), false, Some(8), "a:1/0", ListingHold::LastEra), Unlisted, "a mark that is not ours is held for nobody");
        assert_eq!(presence_state_with(None, false, Some(8), "a:1/0", ListingHold::LastEra), Unlisted, "nothing on record");

        let accepted = NodePublishMark { chain_seen: false, ..last.clone() };
        let pending = NodePublishMark { confirmed: false, chain_seen: false, ..last.clone() };
        let older = NodePublishMark { era: 6, hint: "h6".into(), ..last.clone() };
        let sent = NodePublishMark { era: 8, hint: "h8".into(), addrs_sig: "a:1/0".into(), confirmed: false, chain_seen: false, ..last.clone() };
        for (mark, node, era, sig, want, why) in [
            (&last, "n", Some(8), "a:1/1", Listed, "the inbound flag already measured again this edition"),
            (&last, "n", Some(8), "b:2/0", Outdated, "a real change of address set"),
            (&last, "n", Some(8), "a:1/2", Outdated, "a flag other than the inbound one changed"),
            (&accepted, "n", Some(8), "a:1/0", Outdated, "accepted by the peers but never read back from the chain"),
            (&pending, "n", Some(8), "a:1/0", Outdated, "never confirmed at all"),
            (&older, "n", Some(8), "a:1/0", Outdated, "two editions old: readers no longer scan it"),
            (&last, "other-node", Some(8), "a:1/0", Unlisted, "another identity's listing"),
            (&last, "n", None, "a:1/0", Outdated, "no agreed peak to judge the edition by"),
            (&last, "n", Some(7), "a:1/1", Listed, "its own edition: listed as always"),
            (&last, "n", Some(7), "a:1/0", Outdated, "its own edition: the hold relaxes no compare of this edition's listing"),
            (&sent, "n", Some(8), "a:1/0", Sent, "this edition's own listing is judged as always"),
        ] {
            let hint = era.map(|e| format!("h{e}"));
            let status = presence_status_with(Some(mark), hint.as_deref(), node, era, sig, 2, None, ListingHold::LastEra);
            assert_eq!(status.state, want, "{why}");
            assert_eq!(status.current, matches!(want, Listed | Sent), "{why}");
            assert_eq!(
                presence_status_with(Some(mark), hint.as_deref(), node, era, sig, 2, None, ListingHold::Nothing),
                presence_status(Some(mark), hint.as_deref(), node, era, sig, 2, None),
                "{why}: no hold, the readout as it always was"
            );
        }
    }

    /// 📖 Stage 4 design §8.3: a void listing of this era that the hint rule
    /// holds reads as outdated, not sent, since no write of the era stands
    /// and none is coming before the next era; its figures are its own.
    /// Without the hold it reads sent, as it always did, and the hold
    /// changes no state but *sent*. A mark an older node saved, which names
    /// no coin but dates its write, is not void.
    #[test]
    fn a_void_listing_held_by_the_hint_rule_reads_outdated_not_sent() {
        use crate::ChiaPresenceState::*;
        let written = NodePublishMark {
            era: 8,
            writes: 1,
            addrs_sig: "a:1/0".into(),
            last_at: 1_791_700_000,
            hint: "h8".into(),
            coin_id: "11".repeat(32),
            spend: Some(3),
            node_id: Some("n".into()),
            payer: Some("the SSF wallet's".into()),
            ..NodePublishMark::default()
        };
        let void = written.voided();
        assert!(void.is_void() && !written.is_void());
        assert!(!NodePublishMark { coin_id: String::new(), spend: None, ..written.clone() }.is_void(), "an older node's mark dates its write");
        let held = presence_status_with(Some(&void), Some("h8"), "n", Some(8), "a:1/0", 2, None, ListingHold::Unlanded);
        assert_eq!((held.state, held.current, held.listed_era, held.confirmed), (Outdated, false, 8, false), "{held:?}");
        assert!(held.unlanded, "the readout says why a listing of this edition with these addresses is outdated");
        let moved = presence_status_with(Some(&void), Some("h8"), "n", Some(8), "b:2/0", 2, None, ListingHold::Unlanded);
        assert_eq!((moved.state, moved.unlanded), (Outdated, false), "the addresses changed too: that is the page's reason, and it is true");
        let unheld = presence_status_with(Some(&void), Some("h8"), "n", Some(8), "a:1/0", 2, None, ListingHold::Nothing);
        assert_eq!((unheld.state, unheld.current, unheld.unlanded), (Sent, true, false), "no hold: sent, as always");
        for hold in [ListingHold::Nothing, ListingHold::LastEra] {
            assert!(!presence_status_with(Some(&written), Some("h8"), "n", Some(8), "a:1/0", 2, None, hold).unlanded, "{hold:?}");
        }
        let theirs = presence_status_with(Some(&void), Some("h8"), "another", Some(8), "a:1/0", 2, None, ListingHold::Unlanded);
        assert_eq!((theirs.state, theirs.unlanded), (Unlisted, false), "not ours: nothing of ours to say did not land");
        assert_eq!(unheld, presence_status(Some(&void), Some("h8"), "n", Some(8), "a:1/0", 2, None));
        let seen = NodePublishMark { confirmed: true, chain_seen: true, ..written.clone() };
        assert_eq!(presence_state_with(Some(&seen), true, Some(8), "a:1/0", ListingHold::Unlanded), Listed, "only sent is changed");
        assert_eq!(presence_state_with(Some(&void), true, Some(8), "b:2/0", ListingHold::Unlanded), Outdated);
        assert_eq!(presence_state_with(Some(&void), false, Some(8), "a:1/0", ListingHold::Unlanded), Unlisted);
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
            memo: "m".into(),
            confirmed_height: 0,
            settled: false,
            spend: Some(7),
            node_id: Some("n".into()),
            parked: String::new(),
            payer: None,
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
        assert!(!node_publish_due(Some(&confirmed), era, "a", now + 3600, "h", "n", false));
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
        assert!(node_publish_due(Some(&again), era, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n", false), "pending again past the window, spend released: written again on the clock");
        assert!(!node_publish_due(Some(&again), era, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n", true), "…but not while the lease still holds the spend: it lands again or dies, and the chain's word decides");
        // The next heartbeats: the watcher's sighting of the write (its
        // issued_at is still the mark's last_at) does not set the green back —
        // at height 0 no later absence could take it down, and the clock's
        // retry would stop with it; the lookup alone confirms, with its height.
        assert!(!mark_confirmed_by(&again, now), "a stale sighting resurrects nothing");
        assert!(!mark_confirmed_by(&pending, now), "nor does a fresh one confirm a coin-backed mark: its lookup does");
        assert_eq!(presence_step(&again, Some((Pending, true)), era, h0 + 101), PresenceStep::Keep, "still absent: still pending");
        assert!(node_publish_due(Some(&again), era, "a", now + PRESENCE_CONFIRM_TIMEOUT_SECS, "h", "n", false), "…and still due on the clock once the lease lets the spend go");
        let PresenceStep::Save(back) = presence_step(&again, Some((found(h0 + 60, Some(h0 + 102)), false)), era, h0 + 102) else { panic!("landed again: saved") };
        assert_eq!((back.chain_seen, back.confirmed_height), (true, h0 + 60), "landed again: green, at the new height");
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
        assert_eq!((confirmed.memo.as_str(), void.memo.as_str()), ("m", ""), "the write's memo digest goes with the write");
        assert!(!void.unsettled_for(era, "n"), "nothing left to judge");
        assert!(node_publish_due(Some(&void), era, "a", now, "h", "n", false), "void: due at once");
        let spent_void = NodePublishMark { writes: 1 + MAX_NODE_WRITES_PER_ERA, ..void.clone() };
        assert!(!node_publish_due(Some(&spent_void), era, "a", now, "h", "n", false), "…unless the era's budget is spent");
        assert_eq!(presence_state(Some(&void), true, Some(era), "a"), crate::ChiaPresenceState::Sent, "void but ours and current: on its way again");
        // Across a restart: the file keeps the coin, the height and the
        // settlement; a mark written before they were kept names no coin and
        // is left to the watcher's read, as before.
        let kept: NodePublishMark = serde_json::from_slice(&serde_json::to_vec(&confirmed).unwrap()).unwrap();
        assert_eq!(kept, confirmed);
        let old: NodePublishMark = serde_json::from_str(r#"{"era":5,"writes":1,"addrs_sig":"a","last_at":1,"hint":"h","confirmed":true,"chain_seen":true,"node_id":"n"}"#).unwrap();
        assert!(old.coin_id.is_empty() && old.memo.is_empty() && old.confirmed_height == 0 && !old.settled && old.spend.is_none());
        assert!(!old.unsettled_for(era, "n"), "no coin to look up: not judged");
        assert!(mark_confirmed_by(&NodePublishMark { chain_seen: false, ..old.clone() }, 1), "…the watcher's read confirms it, as before");
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
            DueSpend { spend: 1, coins: vec![coin(1).into(), coin(2).into()], bundle: None, payer: None },
            DueSpend { spend: 2, coins: vec![coin(3).into()], bundle: None, payer: None },
            DueSpend { spend: 3, coins: vec![(coin(4), 50).into()], bundle: None, payer: None },
            DueSpend { spend: 4, coins: vec![coin(5).into()], bundle: None, payer: None },
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
        let parking = lease.park_with_bundle([coin(9)], &bundle, money()).unwrap();
        lease.remember(&words);
        assert_eq!(lease.lease_word(&coin(9)), LeaseWord::Parked);
        assert_eq!(lease.lease_word(&coin(1)), LeaseWord::Spent);
        assert_eq!(lease.lease_word(&coin(2)), LeaseWord::Spent, "every coin of a confirmed spend is spent to the lease");
        assert_eq!(lease.lease_word(&coin(3)), LeaseWord::Dropped);
        assert_eq!(lease.lease_word(&coin(4)), LeaseWord::Unknown, "released on silence: unknown");
        assert_eq!(lease.lease_word(&coin(5)), LeaseWord::Unknown, "still due, never parked here: unknown");
        // A coin parked again by a later spend reads as parked over its old word.
        let _again = lease.park_with_bundle([coin(3)], &bundle, money()).unwrap();
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
        let pending = BeaconMark { era: 5, last_at: 1, hint: "h".into(), node_id: Some("n".into()), coin_id: "c".into(), memo: "m".into(), confirmed: false, confirmed_height: 0, settled: false, spend: None, parked: String::new(), payer: None };
        assert!(!beacon_due(Some(&pending), 5, "n"), "pending: the chain's word settles it, not a second write");
        let confirmed = BeaconMark { confirmed: true, ..pending.clone() };
        assert!(!beacon_due(Some(&confirmed), 5, "n"));
        assert!(beacon_due(Some(&confirmed), 6, "n"), "a new era");
        assert!(beacon_due(Some(&confirmed), 5, "other"), "another identity's mark");
        // A mark file from before the fields reads as pending with no coin to judge.
        let legacy: BeaconMark = serde_json::from_str(r#"{"era":5,"last_at":1,"hint":"h","node_id":"n"}"#).unwrap();
        assert!(!legacy.confirmed);
        assert!(legacy.coin_id.is_empty());
        assert!(legacy.memo.is_empty(), "no memo digest: judged by its hint alone");
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
        let pending = BeaconMark { era, last_at: 1, hint: "h".into(), node_id: Some("n".into()), coin_id: "c".into(), memo: "m".into(), confirmed: false, confirmed_height: 0, settled: false, spend: None, parked: String::new(), payer: None };
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
        assert_eq!(lease.due_at(t0 + RECONCILE_GRACE), vec![DueSpend { spend: parking.spend, coins: vec![a.into()], bundle: None, payer: None }]);
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
        assert_eq!(due, vec![DueSpend { spend: parking.spend, coins: vec![a.into(), b.into()], bundle: None, payer: None }]);
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
        let outcome = tokio::time::timeout(Duration::from_secs(20), push_parked(&client, money(), bundle, [coin]))
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
        lease.restore(&path, money());
        let ours = Bytes32::new([5u8; 32]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        let parking = lease.park_with_bundle([ours], &bundle, money()).unwrap();
        let file: LeaseFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file.parked.len(), 1, "the coin is parked");
        assert_eq!(file.bundles.len(), 1, "and its bundle is in the same file, from the same write");
        assert_eq!(file.bundles[0].spend, parking.spend);
        // Restored after a crash, the spend still carries the bundle to ask the peers with.
        let again = WalletLease::new();
        again.restore(&path, money());
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
            payer: None,
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
        first.restore(&path, money());
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
        second.restore(&path, money());
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
        third.restore(&path, money());
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
            // Stage 4 design §4.4: a malformed payer on a parked spend's
            // bundle, and on a settling spend.
            format!(r#"{{"v":1,"spends":1,"parked":[{{"coin":"{one}","spend":1}}],"bundles":[{{"spend":1,"bundle":"{empty_bundle}","payer":"zz"}}]}}"#),
            format!(r#"{{"v":1,"spends":1,"parked":[],"settling":[{{"spend":1,"spent_at":5,"coins":[{{"coin":"{one}"}}],"bundle":"{empty_bundle}","payer":"zz"}}]}}"#),
        ];
        for text in &broken {
            let bytes = text.as_bytes();
            std::fs::write(&path, bytes).unwrap();
            let sealed = WalletLease::new();
            sealed.restore(&path, money());
            assert!(matches!(sealed.ensure_open(), Err(LeaseError::Sealed(_))), "{}", String::from_utf8_lossy(bytes));
            assert!(!sealed.is_pending(&faucet_coin) && !sealed.incoming_pending());
            // Checked whole before anything is taken (round 21): the broken
            // file's own coin and spend are not half restored either.
            assert!(!sealed.is_taken(&Bytes32::new([1u8; 32])) && !sealed.holds_spend(1), "{}", String::from_utf8_lossy(bytes));
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
        lease.restore(&path, money()); // a missing file is a first run: the store is named, nothing is sealed
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
        let outcome = push_parked_with(&lease, &client, money(), bundle, [ours]).await;
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
        lease.restore(&path, money());
        assert!(!lease.holds_spend(1) && lease.spend_of(&id).is_none(), "nothing parked: no spend is held");
        let parking = lease.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap();
        let n = parking.spend;
        assert_eq!(lease.spend_of(&id), Some(n), "the writer learns its spend's number from the parking");
        assert!(lease.holds_spend(n) && !lease.holds_spend(n + 1));
        // Included: released as spent, settling — still held.
        let t1 = t0 + RECONCILE_GRACE;
        lease.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
        assert!(lease.is_settling(&id) && lease.holds_spend(n));
        assert_eq!(lease.spend_of(&id), None, "settling is not parked");
        // Across a restart, by the same number.
        let again = WalletLease::new();
        again.restore(&path, money());
        assert!(again.holds_spend(n), "the number outlives the restart with the settling record");
        // The block gone: parked again under its number — held.
        again.reconcile_at(T11, &listing(None, Some(1000)), t1).await;
        assert!(again.is_parked(&id) && again.holds_spend(n));
        assert_eq!(again.spend_of(&id), Some(n));
        // Landed anew and settled SETTLED_DEPTH deep: forgotten — held no more.
        let t2 = t1 + RECONCILE_GRACE;
        again.reconcile_at(T11, &listing(Some(1005), Some(1006)), t2).await;
        assert!(again.holds_spend(n));
        again.reconcile_at(T11, &listing(Some(1005), Some(1005 + SETTLED_DEPTH)), t2).await;
        assert!(!again.holds_spend(n) && !again.is_taken(&id));
        // A spend released on the peers' refusal is held no more either.
        let other = WalletLease::new();
        let p = other.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap();
        assert!(other.holds_spend(p.spend));
        other.release(&[p.spend]);
        assert!(!other.holds_spend(p.spend) && other.spend_of(&id).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_spend_parked_before_chia_was_turned_off_stays_parked_until_the_next_normal_start() {
        // ⛓️ Design §6: with Chia off (SSF_NO_CHIA_LANE) no wallet loads, so
        // no lease is restored, and the lane is closed: a lookup made against
        // it is refused before any peer is asked, which keeps the coin parked
        // and leaves the lease file as the last run wrote it. The next start
        // without the switch restores the parking and the chain settles it.
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use crate::chia_peer_lane::{Lane, PeerLane, Trust};
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-chia-off-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let ours = Coin::new(Bytes32::new([6u8; 32]), Bytes32::new([2u8; 32]), 7);
        let id = ours.coin_id();
        let bundle = SpendBundle::new(vec![], Signature::default());
        // A normal run parks a spend and stops before it settles.
        let before = WalletLease::new();
        before.restore(&path, money());
        before.park_with_bundle_at([(id, 900)], Some((&bundle, money())), Instant::now()).unwrap();
        let written = std::fs::read(&path).unwrap();
        // Chia off: the parking, asked about against the closed lane past
        // every grace, stays as it was, on disk too.
        let off = WalletLease::new();
        off.restore(&path, money());
        let later = Instant::now() + RECONCILE_GRACE * 3;
        assert_eq!(off.due_at(later).len(), 1, "the spend is due a lookup, so the lane is asked");
        let closed = PeerLane::new(std::sync::Arc::new(Lane::closed(crate::chia_peer::Network::testnet11(), "SSF_NO_CHIA_LANE")), Trust::Agreed);
        off.reconcile_at(T11, &closed, later).await;
        assert!(off.is_parked(&id) && off.outgoing_pending(), "still parked: a refused lookup decides nothing");
        assert_eq!(std::fs::read(&path).unwrap(), written, "the lease file is as the last normal run left it");
        // The next normal start: restored, the chain lists the input spent.
        let next = WalletLease::new();
        next.restore(&path, money());
        assert!(next.is_parked(&id));
        let spent = Scripted::new(vec![CoinListing {
            records: vec![CoinRecord { coin: ours, confirmed_block_index: 900, spent: true, spent_block_index: 1000 }],
            truncated: false,
            next_cursor: None,
            judged_at: Some(1001),
        }]);
        next.reconcile_at(T11, &spent, Instant::now() + RECONCILE_GRACE * 3).await;
        assert!(!next.is_parked(&id) && next.is_settling(&id), "settled by the chain's word");
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
        lease.restore(&path, money());
        let parking = lease.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap();
        assert!(lease.is_taken(&id));
        // Past the grace the chain lists the input spent at 1000: the spend is
        // released as spent — its coin no longer parked, the wallet not
        // spending — but kept SETTLING with its bundle, in the file, and its
        // coin is no writer's to take.
        let t1 = t0 + RECONCILE_GRACE;
        lease.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
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
        again.restore(&path, money());
        assert!(again.is_settling(&id) && !again.is_parked(&id) && again.is_taken(&id));
        assert_eq!(again.lease_word(&id), LeaseWord::Spent, "the word outlives the restart");
        // Peers behind the spend list the input unspent, an undated listing
        // lists it so, a listing finds it spent but not deep enough, a listing
        // cut short leaves it out: nothing is decided by any of them.
        again.reconcile_at(T11, &listing(None, Some(999)), t1).await;
        again.reconcile_at(T11, &listing(None, None), t1).await;
        again.reconcile_at(T11, &listing(Some(1000), Some(1000 + SETTLED_DEPTH - 1)), t1).await;
        again.reconcile_at(T11, &empty(true, Some(5000)), t1).await;
        assert!(again.is_settling(&id) && !again.is_parked(&id));
        // Unspent on a listing judged at the spend: the block is gone. The
        // spend is parked again under its own number, with its bundle, due
        // after a fresh grace for the liveness probe to push it again; the
        // coin stays no writer's to take.
        again.reconcile_at(T11, &listing(None, Some(1000)), t1).await;
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
        again.reconcile_at(T11, &listing(Some(1005), Some(1006)), t2).await;
        assert!(again.is_settling(&id) && !again.is_parked(&id));
        assert_eq!(on_disk().settling[0].spent_at, 1005);
        // … moved to yet another block by a reorganization no tick saw the
        // input unspent in between (round 11): the record follows, in the file
        // too, and a listing deep enough from the OLD height settles nothing …
        again.reconcile_at(T11, &listing(Some(1020), Some(1021)), t2).await;
        assert!(again.is_settling(&id) && !again.is_parked(&id));
        assert_eq!(on_disk().settling[0].spent_at, 1020, "re-clocked to the block that holds it now");
        again.reconcile_at(T11, &listing(Some(1020), Some(1005 + SETTLED_DEPTH)), t2).await;
        assert!(again.is_settling(&id), "deep from the first inclusion, shallow from the block that holds it: still settling");
        // … across a restart …
        let third = WalletLease::new();
        third.restore(&path, money());
        assert!(third.is_settling(&id) && !third.is_parked(&id));
        assert_eq!(third.lease_word(&id), LeaseWord::Spent);
        // … and found spent SETTLED_DEPTH deep from there, at the listing's own height: final.
        third.reconcile_at(T11, &listing(Some(1020), Some(1020 + SETTLED_DEPTH)), t2).await;
        assert!(!third.is_settling(&id) && !third.is_parked(&id) && !third.is_taken(&id));
        assert_eq!(third.lease_word(&id), LeaseWord::Spent, "this run remembers the settlement");
        assert!(on_disk().settling.is_empty());
        // A settling spend whose input is on no chain the peers know — absent
        // from a complete listing judged past the coin's own confirmation — has
        // nothing left to settle or to push: forgotten.
        let other = WalletLease::new();
        other.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap();
        other.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
        assert!(other.is_settling(&id));
        other.reconcile_at(T11, &empty(false, Some(899)), t1).await;
        assert!(other.is_settling(&id), "absent below its confirmation: peers behind it");
        other.reconcile_at(T11, &empty(false, Some(950)), t1).await;
        assert!(!other.is_settling(&id) && !other.is_parked(&id));
        // A spend released as spent WITHOUT a bundle (parked by an older node)
        // has nothing to push again: forgotten at the release, as before.
        let bare = WalletLease::new();
        bare.park_at([(id, 900)], t0).unwrap();
        bare.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
        assert!(!bare.is_settling(&id) && !bare.is_parked(&id));
        assert_eq!(bare.lease_word(&id), LeaseWord::Spent);
        // A coin a LATER spend took meanwhile keeps that spend's marker when
        // the older spend is parked again (compare-and-release); an older
        // spend none of whose coins is free again is forgotten, bundle and all.
        let raced = WalletLease::new();
        let old = raced.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap();
        raced.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
        let newer = raced.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t1).unwrap();
        assert!(raced.is_parked(&id) && raced.is_settling(&id));
        raced.reconcile_at(T11, &listing(None, Some(1000)), t1).await;
        assert!(raced.is_parked(&id) && !raced.is_settling(&id));
        let due = raced.due_at(t1 + RECONCILE_GRACE);
        assert_eq!(due.iter().map(|d| d.spend).collect::<Vec<u64>>(), vec![newer.spend], "the newer marker stands");
        assert!(old.spend < newer.spend && !raced.snapshot().bundles.iter().any(|b| b.spend == old.spend), "no bundle parks no coin");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 🛑 Stage 4 design §4.5 (1): off a test network no saved bundle goes
    /// out again. A mainnet node that an older build left with a memo spend
    /// parked (a listing, knock or beacon the SSF wallet paid for) restarts
    /// on this one: reconciliation asks the chain and never hands the bundle
    /// to a peer, neither as the liveness question nor once its block is gone
    /// and the spend is parked again. The coin stays parked until the chain
    /// lists it spent. A test network asks the peers as before.
    #[tokio::test]
    async fn off_a_test_network_the_lease_sends_no_saved_bundle_again() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use crate::chia_network::ChiaNet;
        use std::sync::atomic::Ordering::Relaxed;
        let sk = SecretKey::from_seed(&[12u8; 32]);
        let ours = Coin::new(Bytes32::new([6u8; 32]), our_puzzle_hash(&sk), 1000);
        let id = ours.coin_id();
        // The memo spend as an older build pushed it: built here on
        // testnet11, since mainnet's builder refuses it now, and signed for
        // each network.
        let memo = build_publish_bundle(ChiaNet::Testnet11, &sk, ours, Bytes32::new([4u8; 32]), Bytes::new(vec![1, 2, 3])).unwrap();
        let listing = |spent: Option<u32>, judged_at: u32| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: ours, confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at: Some(judged_at),
            }])
        };
        for net in ChiaNet::ALL {
            let bundle = sign_standard_spends(net, &sk, memo.coin_spends.clone()).unwrap();
            let asks = usize::from(net.is_test());
            let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-resend-{net:?}-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("wallet_lease.json");
            let _ = std::fs::remove_file(&path);
            // The older build parked the spend with its bundle, and stopped.
            let before = WalletLease::new();
            before.restore(&path, money());
            before.park_with_bundle([(id, 900)], &bundle, money()).unwrap();
            // This build takes the parking back; past the grace the chain
            // lists the input unspent.
            let lease = WalletLease::new();
            lease.restore(&path, money());
            let t1 = Instant::now() + RECONCILE_GRACE;
            let chain = listing(None, 1000);
            lease.reconcile_at(net, &chain, t1).await;
            assert_eq!(chain.sent.load(Relaxed), asks, "{net:?}: the liveness question");
            assert!(lease.is_parked(&id), "{net:?}: asked and unanswered, or not asked, the coin stays parked");
            // Included, then its block gone: parked again, and still sent
            // again on a test network only.
            lease.reconcile_at(net, &listing(Some(1000), 1001), t1).await;
            assert!(lease.is_settling(&id), "{net:?}");
            lease.reconcile_at(net, &listing(None, 1000), t1).await;
            assert!(lease.is_parked(&id), "{net:?}: parked again");
            let t2 = t1 + RECONCILE_GRACE;
            let chain = listing(None, 1000);
            lease.reconcile_at(net, &chain, t2).await;
            assert_eq!(chain.sent.load(Relaxed), asks, "{net:?}: the spend parked again");
            assert!(lease.is_parked(&id), "{net:?}");
            // The chain's word still settles it.
            lease.reconcile_at(net, &listing(Some(1005), 1006), t2).await;
            assert!(!lease.is_parked(&id) && lease.is_settling(&id), "{net:?}");
            let _ = std::fs::remove_dir_all(&dir);
        }
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

    /// Stage 4 design §4.4: a spend's payer is the key that pays for it, by
    /// the puzzle hash its coins are locked to.
    #[test]
    fn a_payer_is_the_puzzle_hash_its_key_pays_from() {
        let sk = SecretKey::from_seed(&[21u8; 32]);
        assert_eq!(Payer::of(&sk), Payer(our_puzzle_hash(&sk)));
        assert_eq!(Payer::of(&sk).hex(), hex::encode(our_puzzle_hash(&sk)), "the file names it by that hash");
        assert_ne!(Payer::of(&beacon_wallet_key(&sk)), Payer::of(&sk), "the beacon pays from a key of its own (D7): another payer");
        assert_ne!(Payer::of(&SecretKey::from_seed(&[22u8; 32])), Payer::of(&sk));
    }

    /// Stage 4 design §4.4: the payer lands in the parking's one write, beside
    /// its bundle, in a file that stays version 1, and a restart takes it back
    /// with the parking.
    #[test]
    fn a_payer_is_saved_with_its_parking_and_restored_after_a_restart() {
        let path = std::env::temp_dir().join(format!("ssf-lease-payer-saved-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let lease = WalletLease::new();
        lease.restore(&path, money());
        let id = Bytes32::new([31u8; 32]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        let parking = lease.park_with_bundle([(id, 900)], &bundle, beacon()).unwrap();
        let file: LeaseFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file.v, 1, "the field is additive: still version 1");
        assert_eq!((file.parked.len(), file.bundles.len()), (1, 1));
        assert_eq!(
            (file.bundles[0].spend, file.bundles[0].payer.clone()),
            (parking.spend, Some(beacon().hex())),
            "the payer is in the same write as the coin and its bundle"
        );
        assert!(lease.outgoing_pending_for(beacon()) && !lease.outgoing_pending_for(money()));
        // Restored after a restart: the spend still holds its own payer's
        // writes, and no other payer's.
        let again = WalletLease::new();
        again.restore(&path, money());
        assert!(again.outgoing_pending_for(beacon()), "the payer outlives the restart with its parking");
        assert!(!again.outgoing_pending_for(money()) && !again.outgoing_pending_for(burner()));
        assert!(again.outgoing_pending(), "the global check counts it whatever its payer");
        let due = again.due_at(Instant::now() + RECONCILE_GRACE + Duration::from_secs(1));
        assert_eq!(due.iter().map(|d| (d.spend, d.payer)).collect::<Vec<_>>(), vec![(parking.spend, Some(beacon()))]);
        let _ = std::fs::remove_file(&path);
    }

    /// Stage 4 design §4.4 with #272 review round 10: the payer goes wherever
    /// the bundle goes — settling when the spend is included, back into the
    /// parking when its block goes, forgotten with the spend once it is
    /// settled — and a re-parked spend none of whose coins is free leaves
    /// neither.
    #[tokio::test]
    async fn a_payer_rides_its_spend_through_settling_and_parking_again() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use crate::chia_knock::SETTLED_DEPTH;
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-payer-rides-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let ours = Coin::new(Bytes32::new([32u8; 32]), Bytes32::new([2u8; 32]), 1);
        let id = ours.coin_id();
        let listing = |spent: Option<u32>, judged_at: Option<u32>| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: ours, confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at,
            }])
        };
        let on_disk = || serde_json::from_slice::<LeaseFile>(&std::fs::read(&path).unwrap()).unwrap();
        let bundle = SpendBundle::new(vec![], Signature::default());
        let t0 = Instant::now();
        let lease = WalletLease::new();
        lease.restore(&path, money());
        let parking = lease.park_with_bundle_at([(id, 900)], Some((&bundle, beacon())), t0).unwrap();
        // Included: settling with its bundle and its payer, in the file too.
        let t1 = t0 + RECONCILE_GRACE;
        lease.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
        assert!(lease.is_settling(&id));
        assert!(!lease.outgoing_pending_for(beacon()), "settling is not spending, for its payer as for the global check");
        let file = on_disk();
        assert!(file.bundles.is_empty());
        assert_eq!((file.settling.len(), file.settling[0].payer.clone()), (1, Some(beacon().hex())), "the payer is kept settling with its bundle");
        // Across a restart, the block gone: parked again under its own number,
        // bundle and payer.
        let again = WalletLease::new();
        again.restore(&path, money());
        again.reconcile_at(T11, &listing(None, Some(1000)), t1).await;
        assert!(again.is_parked(&id));
        assert!(again.outgoing_pending_for(beacon()) && !again.outgoing_pending_for(money()), "parked again, it holds its own payer's writes alone");
        let file = on_disk();
        assert_eq!(
            file.bundles.iter().map(|b| (b.spend, b.payer.clone())).collect::<Vec<_>>(),
            vec![(parking.spend, Some(beacon().hex()))],
            "the payer goes back into the parking with the bundle"
        );
        // Landed again: settling anew, the payer carried from the parking …
        let t2 = t1 + RECONCILE_GRACE;
        again.reconcile_at(T11, &listing(Some(1005), Some(1006)), t2).await;
        assert!(again.is_settling(&id));
        assert_eq!(on_disk().settling[0].payer, Some(beacon().hex()));
        // … and settled SETTLED_DEPTH deep: forgotten, its payer with it.
        again.reconcile_at(T11, &listing(Some(1005), Some(1005 + SETTLED_DEPTH)), t2).await;
        assert!(!again.is_taken(&id) && !again.outgoing_pending_for(beacon()));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("payer"), "no payer outlives its spend: {text}");
        // A newer spend, of another payer, took the coin meanwhile: the old
        // spend parked again finds no coin free, and leaves neither bundle nor
        // payer (no bundle parks no coin, round 10).
        let raced = WalletLease::new();
        raced.park_with_bundle_at([(id, 900)], Some((&bundle, beacon())), t0).unwrap();
        raced.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
        let newer = raced.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t1).unwrap();
        raced.reconcile_at(T11, &listing(None, Some(1000)), t1).await;
        assert!(raced.is_parked(&id) && !raced.is_settling(&id));
        assert_eq!(
            raced.snapshot().bundles.iter().map(|b| (b.spend, b.payer.clone())).collect::<Vec<_>>(),
            vec![(newer.spend, Some(money().hex()))],
            "the newer marker stands with its own payer"
        );
        assert!(raced.outgoing_pending_for(money()) && !raced.outgoing_pending_for(beacon()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stage 4 design §4.4: "a parking without the field counts as the money
    /// address". The file an older node wrote — a spend parked with its
    /// bundle (S-0 step 2), one parked before bundles were kept (no bundle,
    /// no height), a TAKE with the marker, a settling spend — loads, and
    /// every spend in it is the wallet's own, the one the restore named; no
    /// save fills a payer in.
    #[tokio::test]
    async fn a_lease_file_without_payers_loads_and_its_spends_count_as_the_money_address() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-no-payers-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let (give, old, take) = (Bytes32::new([41u8; 32]), Bytes32::new([42u8; 32]), Bytes32::new([43u8; 32]));
        let settled = Coin::new(Bytes32::new([44u8; 32]), Bytes32::new([2u8; 32]), 1);
        let bundle = hex::encode(SpendBundle::new(vec![], Signature::default()).to_bytes().unwrap());
        let (give_hex, old_hex, take_hex, settled_hex) = (hex::encode(give), hex::encode(old), hex::encode(take), hex::encode(settled.coin_id()));
        let text = format!(
            r#"{{"v":1,"spends":4,"parked":[{{"coin":"{give_hex}","spend":1,"seen_at":900}},{{"coin":"{old_hex}","spend":2}},{{"coin":"{take_hex}","spend":3,"seen_at":900}}],"incoming":"{take_hex}","bundles":[{{"spend":1,"bundle":"{bundle}"}},{{"spend":3,"bundle":"{bundle}"}}],"settling":[{{"spend":4,"spent_at":1000,"coins":[{{"coin":"{settled_hex}","seen_at":900}}],"bundle":"{bundle}"}}]}}"#
        );
        std::fs::write(&path, &text).unwrap();
        let on_disk = || std::fs::read_to_string(&path).unwrap();
        let lease = WalletLease::new();
        lease.restore(&path, money());
        assert!(lease.ensure_open().is_ok(), "a file without payers loads");
        assert!(lease.is_parked(&give) && lease.is_parked(&old) && lease.is_parked(&take) && lease.is_settling(&settled.coin_id()));
        assert!(lease.incoming_pending(), "the TAKE still lands");
        assert!(lease.outgoing_pending());
        assert!(lease.outgoing_pending_for(money()), "its spends are the money address's");
        assert!(!lease.outgoing_pending_for(beacon()) && !lease.outgoing_pending_for(burner()), "…and no other payer's");
        // A change saves the file, and no payer is filled in: the file
        // round-trips as the older node wrote it.
        lease.release(&[1]);
        assert!(!on_disk().contains("payer"), "{}", on_disk());
        assert!(lease.outgoing_pending_for(money()), "the spend parked with no bundle, so with no payer, is the money address's");
        assert!(!lease.outgoing_pending_for(beacon()));
        // Its block gone, the settling spend is parked again: still the
        // money address's.
        let gone = Scripted::new(vec![CoinListing {
            records: vec![CoinRecord { coin: settled, confirmed_block_index: 900, spent: false, spent_block_index: 0 }],
            truncated: false,
            next_cursor: None,
            judged_at: Some(1000),
        }]);
        lease.reconcile_at(T11, &gone, Instant::now()).await;
        assert!(lease.is_parked(&settled.coin_id()), "parked again");
        lease.release(&[2]);
        assert!(lease.outgoing_pending_for(money()) && !lease.outgoing_pending_for(beacon()), "parked again, it is the money address's");
        assert!(!on_disk().contains("payer"), "{}", on_disk());
        // With only the TAKE left parked, it is left out by the global check
        // and by the money address's own alike.
        lease.release(&[4]);
        assert!(lease.is_parked(&take) && lease.incoming_pending());
        assert!(!lease.outgoing_pending() && !lease.outgoing_pending_for(money()) && !lease.outgoing_pending_for(beacon()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stage 4 design §4.4: the field is additive and the file stays version
    /// 1; any other version still seals, as it always did (round 21), payers
    /// or not.
    #[test]
    fn the_lease_file_stays_version_1_and_a_version_2_file_still_seals() {
        let path = std::env::temp_dir().join(format!("ssf-lease-payer-v1-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let id = Bytes32::new([51u8; 32]);
        let lease = WalletLease::new();
        lease.restore(&path, money());
        lease.park_with_bundle([id], &SpendBundle::new(vec![], Signature::default()), beacon()).unwrap();
        let snapshot = lease.snapshot();
        assert_eq!((snapshot.v, snapshot.bundles[0].payer.clone()), (1, Some(beacon().hex())));
        let mut v2 = serde_json::to_value(&snapshot).unwrap();
        v2["v"] = serde_json::Value::from(2);
        let bytes = serde_json::to_vec(&v2).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        let sealed = WalletLease::new();
        sealed.restore(&path, money());
        assert!(matches!(sealed.ensure_open(), Err(LeaseError::Sealed(why)) if why.contains("version 2")));
        assert!(!sealed.is_taken(&id) && !sealed.outgoing_pending_for(beacon()));
        assert_eq!(std::fs::read(&path).unwrap(), bytes, "left for recovery");
        let _ = std::fs::remove_file(&path);
    }

    /// Stage 4 design §4.4 with #245 review rounds 19 and 21: a payer that is
    /// not 32 bytes of hex, on a parked spend's bundle or on a settling spend,
    /// seals the lease, checked with the rest of the file before anything is
    /// taken, and the file is left for recovery. The control: the same file
    /// with a well-formed payer loads.
    #[test]
    fn a_malformed_payer_seals_the_lease() {
        let path = std::env::temp_dir().join(format!("ssf-lease-payer-malformed-{}.json", std::process::id()));
        let one = Bytes32::new([1u8; 32]);
        let coin = hex::encode(one);
        let bundle = hex::encode(SpendBundle::new(vec![], Signature::default()).to_bytes().unwrap());
        let parked = |payer: &str| {
            format!(r#"{{"v":1,"spends":1,"parked":[{{"coin":"{coin}","spend":1}}],"bundles":[{{"spend":1,"bundle":"{bundle}","payer":"{payer}"}}]}}"#)
        };
        let settling = |payer: &str| {
            format!(r#"{{"v":1,"spends":1,"parked":[],"settling":[{{"spend":1,"spent_at":5,"coins":[{{"coin":"{coin}"}}],"bundle":"{bundle}","payer":"{payer}"}}]}}"#)
        };
        // A file shape: the file's text around a payer, and where the seal names it.
        type Shape<'a> = (&'a dyn Fn(&str) -> String, &'a str);
        let shapes: [Shape<'_>; 2] = [(&parked, "for spend #1"), (&settling, "for settling spend #1")];
        let too_long = hex::encode([0xa0u8; 33]);
        for (file, what) in shapes {
            for bad in ["zz", "a0a0", too_long.as_str()] {
                let text = file(bad);
                std::fs::write(&path, &text).unwrap();
                let sealed = WalletLease::new();
                sealed.restore(&path, money());
                let Err(LeaseError::Sealed(why)) = sealed.ensure_open() else { panic!("{text}: not sealed") };
                assert!(why.contains("malformed payer") && why.contains(what), "{why}");
                assert!(!sealed.is_taken(&one) && !sealed.holds_spend(1), "nothing of the file is taken: {text}");
                assert!(matches!(sealed.park([one]), Err(LeaseError::Sealed(_))));
                assert_eq!(std::fs::read_to_string(&path).unwrap(), text, "left for recovery");
            }
            std::fs::write(&path, file(&beacon().hex())).unwrap();
            let open = WalletLease::new();
            open.restore(&path, money());
            assert!(open.ensure_open().is_ok() && open.holds_spend(1), "{what}: a well-formed payer loads");
        }
        let _ = std::fs::remove_file(&path);
    }

    /// The lease file's records as they stood before payers were filed
    /// (origin/main at 2dd11e34, before stage 4 PR 7): the same serde
    /// attributes, and no `payer`. An older node reads this build's file into
    /// these, and writes them back.
    mod before_payers {
        #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
        pub(super) struct LeaseFile {
            pub(super) v: u32,
            pub(super) spends: u64,
            pub(super) parked: Vec<ParkedCoin>,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub(super) incoming: Option<String>,
            #[serde(default, skip_serializing_if = "Vec::is_empty")]
            pub(super) bundles: Vec<ParkedBundle>,
            #[serde(default, skip_serializing_if = "Vec::is_empty")]
            pub(super) settling: Vec<SettlingSpend>,
        }

        #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
        pub(super) struct SettlingSpend {
            pub(super) spend: u64,
            pub(super) spent_at: u32,
            pub(super) coins: Vec<SettlingCoin>,
            pub(super) bundle: String,
        }

        #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
        pub(super) struct SettlingCoin {
            pub(super) coin: String,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub(super) seen_at: Option<u32>,
        }

        #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
        pub(super) struct ParkedCoin {
            pub(super) coin: String,
            pub(super) spend: u64,
            #[serde(default, skip_serializing_if = "Option::is_none")]
            pub(super) seen_at: Option<u32>,
        }

        #[derive(serde::Serialize, serde::Deserialize, Debug, PartialEq, Eq)]
        pub(super) struct ParkedBundle {
            pub(super) spend: u64,
            pub(super) bundle: String,
        }
    }

    /// What an older node keeps of a lease file this build wrote: everything
    /// but the payers.
    fn without_payers(file: &LeaseFile) -> before_payers::LeaseFile {
        use before_payers as old;
        old::LeaseFile {
            v: file.v,
            spends: file.spends,
            parked: file.parked.iter().map(|c| old::ParkedCoin { coin: c.coin.clone(), spend: c.spend, seen_at: c.seen_at }).collect(),
            incoming: file.incoming.clone(),
            bundles: file.bundles.iter().map(|b| old::ParkedBundle { spend: b.spend, bundle: b.bundle.clone() }).collect(),
            settling: file
                .settling
                .iter()
                .map(|s| old::SettlingSpend {
                    spend: s.spend,
                    spent_at: s.spent_at,
                    coins: s.coins.iter().map(|c| old::SettlingCoin { coin: c.coin.clone(), seen_at: c.seen_at }).collect(),
                    bundle: s.bundle.clone(),
                })
                .collect(),
        }
    }

    /// Stage 4 design §4.4 and §8 (6): an older node reads a file this build
    /// wrote — it denies no unknown field — with every coin, spend number,
    /// bundle, settling spend, the counter and the marker, and what it writes
    /// back has no payer. Restored by this build after such a rollback, every
    /// coin is still held (nothing under-parked) and every spend is the money
    /// address's: the beacon's spend among them, whose payer was lost.
    #[tokio::test]
    async fn an_older_node_reads_a_lease_file_with_payers_and_loses_nothing_it_knew() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-older-reader-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let settles = Coin::new(Bytes32::new([61u8; 32]), Bytes32::new([2u8; 32]), 1);
        let (beacons, wallets, take) = (Bytes32::new([62u8; 32]), Bytes32::new([63u8; 32]), Bytes32::new([64u8; 32]));
        let bundle = SpendBundle::new(vec![], Signature::default());
        let t0 = Instant::now();
        let lease = WalletLease::new();
        lease.restore(&path, money());
        lease.park_with_bundle_at([(settles.coin_id(), 900)], Some((&bundle, beacon())), t0).unwrap();
        let included = Scripted::new(vec![CoinListing {
            records: vec![CoinRecord { coin: settles, confirmed_block_index: 900, spent: true, spent_block_index: 1000 }],
            truncated: false,
            next_cursor: None,
            judged_at: Some(1001),
        }]);
        lease.reconcile_at(T11, &included, t0 + RECONCILE_GRACE).await;
        assert!(lease.is_settling(&settles.coin_id()));
        lease.park_with_bundle([(beacons, 900)], &bundle, beacon()).unwrap();
        lease.park_with_bundle([wallets], &bundle, money()).unwrap();
        lease.park_with_bundle([take], &bundle, money()).unwrap();
        lease.mark_incoming(take).unwrap();
        let written = std::fs::read(&path).unwrap();
        let ours: LeaseFile = serde_json::from_slice(&written).unwrap();
        assert!(ours.bundles.iter().all(|b| b.payer.is_some()) && ours.settling.iter().all(|s| s.payer.is_some()), "this build names every payer");
        let theirs: before_payers::LeaseFile = serde_json::from_slice(&written).unwrap();
        assert_eq!(theirs, without_payers(&ours), "an older node reads all it knew");
        assert_eq!((theirs.parked.len(), theirs.bundles.len(), theirs.settling.len(), theirs.incoming.is_some()), (3, 3, 1, true));
        let rolled_back = serde_json::to_vec_pretty(&theirs).unwrap();
        assert!(!String::from_utf8_lossy(&rolled_back).contains("payer"), "what it writes back names no payer");
        std::fs::write(&path, &rolled_back).unwrap();
        let again = WalletLease::new();
        again.restore(&path, money());
        assert!(again.ensure_open().is_ok());
        for coin in [settles.coin_id(), beacons, wallets, take] {
            assert!(again.is_taken(&coin), "every coin is still held after the rollback");
        }
        assert!(again.outgoing_pending_for(money()));
        assert!(!again.outgoing_pending_for(beacon()), "the payer lost in the rollback: the beacon's spend reads as the money address's");
        assert_eq!(again.outgoing_pending(), lease.outgoing_pending(), "the global check is the same either side of the rollback");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Forward compatibility, which the payer itself relies on: no record of
    /// the lease file denies unknown fields, so a field a later build adds, at
    /// the top or in any entry, is skipped and the file loads with every spend
    /// and payer it holds.
    #[test]
    fn a_lease_file_field_this_node_does_not_know_is_ignored() {
        let path = std::env::temp_dir().join(format!("ssf-lease-later-field-{}.json", std::process::id()));
        let (parked, settles) = (Bytes32::new([71u8; 32]), Bytes32::new([72u8; 32]));
        let (parked_hex, settles_hex, payer) = (hex::encode(parked), hex::encode(settles), beacon().hex());
        let bundle = hex::encode(SpendBundle::new(vec![], Signature::default()).to_bytes().unwrap());
        let text = format!(
            r#"{{"v":1,"spends":2,"later":1,"parked":[{{"coin":"{parked_hex}","spend":1,"later":1}}],"bundles":[{{"spend":1,"bundle":"{bundle}","payer":"{payer}","later":1}}],"settling":[{{"spend":2,"spent_at":5,"coins":[{{"coin":"{settles_hex}","later":1}}],"bundle":"{bundle}","payer":"{payer}","later":1}}]}}"#
        );
        std::fs::write(&path, &text).unwrap();
        let lease = WalletLease::new();
        lease.restore(&path, money());
        assert!(lease.ensure_open().is_ok(), "an unknown field seals nothing");
        assert!(lease.is_parked(&parked) && lease.is_settling(&settles) && lease.holds_spend(1) && lease.holds_spend(2));
        assert!(lease.outgoing_pending_for(beacon()) && !lease.outgoing_pending_for(money()));
        let snapshot = lease.snapshot();
        assert_eq!((snapshot.bundles[0].payer.clone(), snapshot.settling[0].payer.clone()), (Some(payer.clone()), Some(payer)));
        let _ = std::fs::remove_file(&path);
    }

    /// Stage 4 design §4.4: "two records for one era from one payer" holds per
    /// payer. Each payer waits on its own parked spends; a spend with no payer
    /// recorded is the money address's; the TAKE is nobody's to wait for; a
    /// settling spend holds nobody until its block goes; and a lease no
    /// restore told the money address holds every payer on a payer-less
    /// parking, fail closed.
    #[tokio::test]
    async fn outgoing_pending_for_holds_each_payer_on_its_own_parked_spends() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-per-payer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let beacons = Coin::new(Bytes32::new([81u8; 32]), Bytes32::new([2u8; 32]), 1);
        let a = beacons.coin_id();
        let (m, l, t) = (Bytes32::new([82u8; 32]), Bytes32::new([83u8; 32]), Bytes32::new([84u8; 32]));
        let listing = |spent: Option<u32>, judged_at: u32| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: beacons, confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at: Some(judged_at),
            }])
        };
        let bundle = SpendBundle::new(vec![], Signature::default());
        let t0 = Instant::now();
        let t1 = t0 + RECONCILE_GRACE;
        let lease = WalletLease::new();
        lease.restore(&path, money());
        // Parked at once: the beacon's spend (the only one due at t1), the
        // wallet's, one an older node parked with no payer, and a TAKE.
        lease.park_with_bundle_at([(a, 900)], Some((&bundle, beacon())), t0).unwrap();
        let wallets = lease.park_with_bundle_at([m], Some((&bundle, money())), t1).unwrap();
        let older = lease.park_at([l], t1).unwrap();
        lease.park_with_bundle_at([t], Some((&bundle, money())), t1).unwrap();
        lease.mark_incoming(t).unwrap();
        assert!(lease.outgoing_pending_for(beacon()) && lease.outgoing_pending_for(money()) && lease.outgoing_pending());
        assert!(!lease.outgoing_pending_for(burner()), "a payer with nothing parked waits for nothing");
        lease.release(&[wallets.spend]);
        assert!(lease.outgoing_pending_for(money()), "the spend with no payer recorded is the money address's");
        lease.release(&[older.spend]);
        assert!(!lease.outgoing_pending_for(money()), "the TAKE is left out, as the global check leaves it out");
        assert!(lease.outgoing_pending() && lease.outgoing_pending_for(beacon()), "the beacon's spend still holds the global check and its own payer");
        // The beacon's spend included: settling, which holds nobody.
        lease.reconcile_at(T11, &listing(Some(1000), 1001), t1).await;
        assert!(lease.is_settling(&a));
        assert!(!lease.outgoing_pending_for(beacon()) && !lease.outgoing_pending());
        // Its block gone: parked again, under its payer, across a restart too.
        lease.reconcile_at(T11, &listing(None, 1000), t1).await;
        assert!(lease.is_parked(&a) && lease.outgoing_pending_for(beacon()) && !lease.outgoing_pending_for(money()));
        let again = WalletLease::new();
        again.restore(&path, money());
        assert!(again.outgoing_pending_for(beacon()) && !again.outgoing_pending_for(money()) && !again.outgoing_pending_for(burner()));
        // Never restored: a parking with no payer recorded holds every payer,
        // and one that names its payer holds that payer alone.
        let unnamed = WalletLease::new();
        unnamed.park_at([l], t0).unwrap();
        assert!(unnamed.outgoing_pending_for(beacon()) && unnamed.outgoing_pending_for(burner()) && unnamed.outgoing_pending_for(money()));
        let named = WalletLease::new();
        named.park_with_bundle_at([m], Some((&bundle, beacon())), t0).unwrap();
        assert!(named.outgoing_pending_for(beacon()) && !named.outgoing_pending_for(burner()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stage 4 design §4.4 at the lobby dish: with burner keys on, the dish
    /// reads as still confirming only a spend the SSF wallet pays for (or
    /// one with no payer recorded, an older node's), never a burner's or the
    /// beacon's; with them off, every spend but a claim's, as it always did.
    #[test]
    fn wallet_spending_counts_the_wallets_own_spends_with_burners_on_and_every_spend_as_before_with_them_off() {
        let dir = std::env::temp_dir().join(format!("ssf-wallet-spending-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bundle = SpendBundle::new(vec![], Signature::default());
        let both = |lease: &WalletLease| (wallet_spending(lease, money(), true), wallet_spending(lease, money(), false));
        let empty = restored_in(&dir, "empty");
        assert_eq!(both(&empty), (false, false), "nothing parked");
        for (name, payer, on) in [("burner", burner(), false), ("beacon", beacon(), false), ("money", money(), true)] {
            let lease = restored_in(&dir, name);
            lease.park_with_bundle_at([Bytes32::new([0x91; 32])], Some((&bundle, payer)), Instant::now()).unwrap();
            assert_eq!(both(&lease), (on, true), "a spend the {name} pays for");
        }
        let older = restored_in(&dir, "older");
        older.park_at([Bytes32::new([0x92; 32])], Instant::now()).unwrap();
        assert_eq!(both(&older), (true, true), "a spend with no payer recorded is the wallet's");
        let claim = restored_in(&dir, "claim");
        let gift = Bytes32::new([0x93; 32]);
        claim.park_with_bundle_at([gift], Some((&bundle, money())), Instant::now()).unwrap();
        claim.mark_incoming(gift).unwrap();
        assert_eq!(both(&claim), (false, false), "a claim's coin is the dish's, landing, not a spend of ours");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A lease restored from a file of its own in `dir`, the money address
    /// named.
    fn restored_in(dir: &std::path::Path, name: &str) -> WalletLease {
        let path = dir.join(format!("{name}.json"));
        let _ = std::fs::remove_file(&path);
        let lease = WalletLease::new();
        lease.restore(&path, money());
        lease
    }

    /// Stage 4 design §13 row 7, "changes behaviour: none yet": the global
    /// check every writer of this build asks is today's whatever the payers,
    /// and with the money address named and every payer it or none, the
    /// money address's own check gives that same answer in every state the
    /// lease can be in. A beacon-paid spend is where the two part: the global
    /// check still holds the wallet's writes on it, as today.
    #[tokio::test]
    async fn outgoing_pending_still_counts_every_parked_spend_whatever_its_payer() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ours = Coin::new(Bytes32::new([91u8; 32]), Bytes32::new([2u8; 32]), 1);
        let id = ours.coin_id();
        let faucet = Bytes32::new([92u8; 32]);
        let listing = |spent: Option<u32>, judged_at: u32| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: ours, confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at: Some(judged_at),
            }])
        };
        let bundle = SpendBundle::new(vec![], Signature::default());
        let t0 = Instant::now();
        let row = |name: &'static str, lease: &WalletLease| (name, lease.outgoing_pending(), lease.outgoing_pending_for(money()));
        let mut rows = Vec::new();
        rows.push(row("empty", &restored_in(&dir, "empty")));
        let legacy = restored_in(&dir, "legacy");
        legacy.park_at([id], t0).unwrap();
        rows.push(row("legacy", &legacy));
        let paid = restored_in(&dir, "paid");
        paid.park_with_bundle_at([id], Some((&bundle, money())), t0).unwrap();
        rows.push(row("money-paid", &paid));
        let take = restored_in(&dir, "take");
        take.park_with_bundle_at([faucet], Some((&bundle, money())), t0).unwrap();
        take.mark_incoming(faucet).unwrap();
        rows.push(row("take", &take));
        let legacy_take = restored_in(&dir, "legacy-take");
        legacy_take.park_at([faucet], t0).unwrap();
        legacy_take.mark_incoming(faucet).unwrap();
        rows.push(row("legacy take", &legacy_take));
        take.park_with_bundle_at([id], Some((&bundle, money())), t0).unwrap();
        rows.push(row("take and give", &take));
        let settling = restored_in(&dir, "settling");
        settling.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap();
        settling.reconcile_at(T11, &listing(Some(1000), 1001), t0 + RECONCILE_GRACE).await;
        assert!(settling.is_settling(&id));
        rows.push(row("settling", &settling));
        settling.reconcile_at(T11, &listing(None, 1000), t0 + RECONCILE_GRACE).await;
        assert!(settling.is_parked(&id));
        rows.push(row("re-parked", &settling));
        let beacons = restored_in(&dir, "beacon");
        beacons.park_with_bundle_at([id], Some((&bundle, beacon())), t0).unwrap();
        rows.push(row("beacon-paid", &beacons));
        assert_eq!(
            rows,
            vec![
                ("empty", false, false),
                ("legacy", true, true),
                ("money-paid", true, true),
                ("take", false, false),
                ("legacy take", false, false),
                ("take and give", true, true),
                ("settling", false, false),
                ("re-parked", true, true),
                ("beacon-paid", true, false),
            ]
        );
        for (name, global, own) in &rows {
            if *name != "beacon-paid" {
                assert_eq!(global, own, "{name}: every payer the money address's or none, the two checks agree");
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The gift landing (#245 review round 3) is no payer's to wait for: a
    /// TAKE of this build, parked under the money address it pays into, and
    /// one an older node parked with no payer read alike.
    #[test]
    fn a_landing_gift_counts_for_no_payers_writes() {
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-landing-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let faucet = Bytes32::new([93u8; 32]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        for (name, payer) in [("this build's TAKE", Some(money())), ("an older node's TAKE", None)] {
            let lease = restored_in(&dir, name);
            match payer {
                Some(payer) => lease.park_with_bundle([faucet], &bundle, payer).map(|_| ()),
                None => lease.park([faucet]).map(|_| ()),
            }
            .unwrap();
            lease.mark_incoming(faucet).unwrap();
            assert!(lease.incoming_pending(), "{name}: the gift is landing");
            assert!(!lease.outgoing_pending() && !lease.outgoing_pending_for(money()), "{name}: not the wallet spending");
            assert!(!lease.outgoing_pending_for(beacon()) && !lease.outgoing_pending_for(burner()), "{name}: nor any other payer");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The TAKE marker is cleared only when `incoming_pending` next reads it
    /// (the dish's claim and status read do), so a TAKE the mempool dropped,
    /// or the peers refused, can leave it naming a dish coin that is free
    /// again. Stage 4 design §4.4: a spend that then parks that coin under
    /// ANOTHER payer is that payer's to wait for, marker or not.
    #[test]
    fn a_stale_take_marker_leaves_out_no_other_payers_spend() {
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-stale-marker-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let faucet = Bytes32::new([95u8; 32]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        let lease = restored_in(&dir, "lease");
        let take = lease.park_with_bundle([faucet], &bundle, money()).unwrap();
        lease.mark_incoming(faucet).unwrap();
        lease.release(&[take.spend]);
        assert_eq!(*lease.incoming.lock().unwrap(), Some(faucet), "nothing read the marker since: it still names the coin");
        let first_write = lease.park_with_bundle([faucet], &bundle, burner()).unwrap();
        assert!(lease.outgoing_pending_for(burner()), "the burner's parked spend holds the burner's writes");
        assert!(!lease.outgoing_pending_for(money()) && !lease.outgoing_pending_for(beacon()), "…and nobody else's");
        // The global check and the landing read are today's: they read the
        // marker's coin alone, whoever parked it, which is why the
        // claim-and-write (PR 9) keeps the marker off a burner's parking.
        assert!(!lease.outgoing_pending() && lease.incoming_pending());
        lease.release(&[first_write.spend]);
        assert!(!lease.outgoing_pending_for(burner()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stage 4 design §4.4: a burner pays for its own writes, by its puzzle
    /// hash: a payer of its own, not the money address's, and each slot's
    /// burner another payer.
    #[test]
    fn a_burners_payer_is_its_puzzle_hash_and_not_the_moneys() {
        use crate::chia_burner::{BurnerRoot, MoneyKey};
        let wallet = SecretKey::from_seed(&[1u8; 32]);
        let root = BurnerRoot::of(&MoneyKey::new(wallet.clone()), T11);
        let key = root.presence(&[2u8; 32], 0);
        assert_eq!(Payer::of_burner(&key), Payer(key.puzzle_hash()));
        assert_eq!(Payer::of_burner(&key).hex(), hex::encode(key.puzzle_hash()), "the file names it by that hash");
        assert_ne!(Payer::of_burner(&key), Payer::of(&wallet), "a burner is not the money address");
        assert_ne!(Payer::of_burner(&key), Payer::of_burner(&root.presence(&[2u8; 32], 1)), "the next era's burner");
        assert_ne!(Payer::of_burner(&key), Payer::of_burner(&root.knock(&[2u8; 32], 0)), "a knock's burner");
    }

    /// Stage 4 design §4.4 and §13 row 9: the TAKE marker can outlive its
    /// TAKE's parking and name a dish coin that is free again, and the
    /// claim-and-write keeps that coin from every burner's claim, since its
    /// pick leaves out what `is_taken` or `is_incoming_marker` names.
    /// Reading the marker clears nothing; once `incoming_pending` clears it,
    /// the coin is a dish coin like any other.
    #[test]
    fn a_stale_take_marker_keeps_its_dish_coin_from_any_burners_claim() {
        use crate::chia_faucet::{pick_ready_coin, FaucetCoin, FaucetParams};
        use rand::SeedableRng;
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-stale-marker-claim-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let params = FaucetParams::lobby(T11);
        let dish = |n: u8| FaucetCoin { coin: Coin::new(Bytes32::new([n; 32]), params.puzzle_hash(), 10), confirmed_height: 100 };
        let (marked, free) = (dish(98), dish(99));
        let faucet = marked.coin.coin_id();
        let bundle = SpendBundle::new(vec![], Signature::default());
        let lease = restored_in(&dir, "lease");
        let take = lease.park_with_bundle([faucet], &bundle, money()).unwrap();
        lease.mark_incoming(faucet).unwrap();
        assert!(lease.is_taken(&faucet) && lease.is_incoming_marker(&faucet), "while the TAKE is parked, both name its coin");
        lease.release(&[take.spend]);
        assert!(lease.is_incoming_marker(&faucet), "the TAKE gone, the marker still names its coin");
        assert!(!lease.is_taken(&faucet), "…which the lease no longer holds");
        assert!(!lease.is_incoming_marker(&free.coin.coin_id()));
        assert_eq!(*lease.incoming.lock().unwrap(), Some(faucet), "a read clears nothing");
        let taken = |id: &Bytes32| lease.is_taken(id) || lease.is_incoming_marker(id);
        let coins = [marked, free.clone()];
        let mut rng = rand::rngs::StdRng::seed_from_u64(9);
        for _ in 0..64 {
            assert_eq!(pick_ready_coin(&coins, &params, 200, taken, &mut rng), Some(&free), "never the marker's coin");
        }
        assert!(!lease.incoming_pending(), "nothing parks it, so no gift is landing, and this read clears the marker");
        assert!(!lease.is_incoming_marker(&faucet) && !lease.is_taken(&faucet));
        let picked: HashSet<Bytes32> =
            (0..64).filter_map(|_| pick_ready_coin(&coins, &params, 200, taken, &mut rng)).map(|c| c.coin.coin_id()).collect();
        assert!(picked.contains(&faucet), "cleared, it is a dish coin like any other");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stage 4 design §5.2 and §10: a key is funded only while no bundle for
    /// it is held, parked or settling. A burner's spend held settling (its
    /// dish coin listed spent, whether by our bundle or by a stranger's claim
    /// at the same height) holds the burner's next gift, though not a
    /// rewrite (`outgoing_pending_for`), and holds no other payer's; settled
    /// SETTLED_DEPTH deep, it holds nothing. A settling spend that names no
    /// payer is the money address's once a restore names it, and every
    /// payer's until then, as a parked one is.
    #[tokio::test]
    async fn a_payers_settling_spend_holds_its_next_gift_and_no_one_elses() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use crate::chia_knock::SETTLED_DEPTH;
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-holds-for-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dish = Coin::new(Bytes32::new([96u8; 32]), Bytes32::new([2u8; 32]), 10);
        let id = dish.coin_id();
        let listing = |spent: Option<u32>, judged_at: Option<u32>| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: dish, confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at,
            }])
        };
        let bundle = SpendBundle::new(vec![], Signature::default());
        let t0 = Instant::now();
        let lease = restored_in(&dir, "lease");
        lease.park_with_bundle_at([(id, 900)], Some((&bundle, burner())), t0).unwrap();
        assert!(lease.holds_for(burner()) && lease.outgoing_pending_for(burner()), "parked: it holds the gift and the rewrite");
        assert!(!lease.holds_for(beacon()) && !lease.holds_for(money()));
        let t1 = t0 + RECONCILE_GRACE;
        lease.reconcile_at(T11, &listing(Some(1000), Some(1001)), t1).await;
        assert!(lease.is_settling(&id));
        assert!(lease.holds_for(burner()), "settling: the burner's next gift waits on it");
        assert!(!lease.outgoing_pending_for(burner()), "…and a rewrite does not");
        assert!(!lease.holds_for(beacon()) && !lease.holds_for(money()), "nobody else's");
        lease.reconcile_at(T11, &listing(Some(1000), Some(1000 + SETTLED_DEPTH - 1)), t1).await;
        assert!(lease.holds_for(burner()), "not yet SETTLED_DEPTH deep");
        lease.reconcile_at(T11, &listing(Some(1000), Some(1000 + SETTLED_DEPTH)), t1).await;
        assert!(!lease.is_taken(&id) && !lease.holds_for(burner()), "settled: the key may be funded again");

        // A settling spend an older node filed, with no payer.
        let settled = Coin::new(Bytes32::new([97u8; 32]), Bytes32::new([2u8; 32]), 1);
        let text = format!(
            r#"{{"v":1,"spends":1,"parked":[],"settling":[{{"spend":1,"spent_at":1000,"coins":[{{"coin":"{}","seen_at":900}}],"bundle":"{}"}}]}}"#,
            hex::encode(settled.coin_id()),
            hex::encode(bundle.to_bytes().unwrap())
        );
        let unnamed = WalletLease::new();
        unnamed.load(&serde_json::from_str(&text).unwrap(), t0).unwrap();
        assert!(unnamed.is_settling(&settled.coin_id()));
        for payer in [money(), beacon(), burner()] {
            assert!(unnamed.holds_for(payer), "{payer:?}: no money address named, so it holds every payer, fail closed");
            assert!(!unnamed.outgoing_pending_for(payer), "{payer:?}");
        }
        let path = dir.join("older.json");
        std::fs::write(&path, &text).unwrap();
        let named = WalletLease::new();
        named.restore(&path, money());
        assert!(named.is_settling(&settled.coin_id()) && named.holds_for(money()), "the money address's, once a restore names it");
        assert!(!named.holds_for(beacon()) && !named.holds_for(burner()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stage 4 design §8.3, the crash window's lookup
    /// ([`WalletLease::held_write_under`]): the write the lease holds under
    /// a hint is read under the lease's gate, as its holder leaves the
    /// lease. A memo write is parked, then settling. While the gate is held
    /// the read does not return, and the holder reconciles the lease against
    /// a chain that lost the write's block, so the spend goes back into the
    /// parking ([`WalletLease::retire`], which takes it out of the settling
    /// spends before it parks it again). Once the gate is given back the read
    /// returns the write, parked again. A read that did not wait on the gate
    /// could fall between those two steps and find no write at all.
    #[tokio::test]
    async fn the_write_held_under_a_hint_is_read_under_the_leases_gate() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        let sk = SecretKey::from_seed(&[0x5c; 32]);
        let ours = Coin::new(Bytes32::new([0x5d; 32]), our_puzzle_hash(&sk), 1000);
        let (id, hint) = (ours.coin_id(), Bytes32::new([0x5e; 32]));
        let bundle = build_publish_bundle(T11, &sk, ours, hint, Bytes::new(vec![1, 2, 3])).unwrap();
        let listing = |spent: Option<u32>, judged_at: u32| {
            Scripted::new(vec![CoinListing {
                records: vec![CoinRecord { coin: ours, confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) }],
                truncated: false,
                next_cursor: None,
                judged_at: Some(judged_at),
            }])
        };
        let lease = WalletLease::new();
        let t0 = Instant::now();
        lease.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap();
        let t1 = t0 + RECONCILE_GRACE;
        lease.reconcile_at(T11, &listing(Some(1000), 1001), t1).await;
        assert!(lease.is_settling(&id));
        let settling = lease.held_write_under(hint).await.expect("held while it settles");
        assert_eq!((settling.coins, settling.payer, settling.spent_at), (WriteCoins::one(id), Some(money()), Some(1000)));

        let gate = lease.lock().await;
        let mut read = std::pin::pin!(lease.held_write_under(hint));
        assert!(tokio::time::timeout(Duration::from_millis(100), &mut read).await.is_err(), "the read waits while the gate is held");
        lease.reconcile_at(T11, &listing(None, 1000), t1).await;
        assert!(lease.is_parked(&id), "the write's block gone: parked again");
        drop(gate);
        let parked = tokio::time::timeout(Duration::from_secs(5), read).await.expect("the gate given back, the read returns");
        assert_eq!(parked, Some(HeldWrite { spent_at: None, ..settling }), "the write as the gate's holder left it: parked again");
    }

    /// Stage 4 design §8.3, the crash window's lookup
    /// ([`WalletLease::held_writes_under`]): the lease's gate is held for the
    /// whole read, through the parking and the settling spends both, not
    /// only taken before it. A thread beside the reads moves a settling memo
    /// write back into the parking and out to settling again, over and over
    /// ([`WalletLease::retire`], as a reconciliation does that finds the
    /// write's block gone and then finds it again), and only while it holds
    /// the gate, so whenever the gate is free the write is settling. A read
    /// that holds the gate throughout never misses it. One that gave the gate
    /// back between the two maps could read the parking before a move and
    /// the settling spends during one, and find no write at all. The thread
    /// spins on the gate, so it takes it as soon as it is free, and keeps the
    /// write parked a while each time. The reads, on a runtime of two
    /// threads of its own, go on until the thread has moved the write many
    /// times between them. The check is one-sided: the write moves only
    /// under the gate, so a read that holds it can never miss, however the
    /// threads are scheduled.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_write_held_under_a_hint_is_read_whole_under_the_leases_gate_while_another_thread_moves_it() {
        use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
        let sk = SecretKey::from_seed(&[0x68; 32]);
        let ours = Coin::new(Bytes32::new([0x69; 32]), our_puzzle_hash(&sk), 1000);
        let (id, hint) = (ours.coin_id(), Bytes32::new([0x6a; 32]));
        let bundle = build_publish_bundle(T11, &sk, ours, hint, Bytes::new(vec![1, 2, 3])).unwrap();
        let settling = move |bundle: &SpendBundle| Settling { coins: vec![ParkedInput { coin_id: id, seen_at: Some(900) }], spent_at: 1000, bundle: bundle.clone(), payer: Some(money()) };
        let lease = std::sync::Arc::new(WalletLease::new());
        let t0 = Instant::now();
        let spend = lease.park_with_bundle_at([(id, 900)], Some((&bundle, money())), t0).unwrap().spend;
        lease.retire(&[spend], vec![(spend, settling(&bundle))], &[], &[], &[], t0);
        assert!(lease.is_settling(&id) && !lease.is_parked(&id), "settling while the gate is free");

        let (stop, moves) = (std::sync::Arc::new(AtomicBool::new(false)), std::sync::Arc::new(AtomicU64::new(0)));
        let mover = {
            let (lease, stop, moves) = (lease.clone(), stop.clone(), moves.clone());
            std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let Ok(gate) = lease.gate.try_lock() else {
                        std::hint::spin_loop();
                        continue;
                    };
                    lease.retire(&[], Vec::new(), &[spend], &[], &[], t0);
                    // Parked again a while, under the gate.
                    std::thread::sleep(Duration::from_micros(20));
                    lease.retire(&[spend], vec![(spend, settling(&bundle))], &[], &[], &[], t0);
                    drop(gate);
                    moves.fetch_add(1, Ordering::Relaxed);
                    std::thread::yield_now();
                }
            })
        };
        let (mut reads, mut missed) = (0u32, 0u32);
        while reads < 2_000 || (moves.load(Ordering::Relaxed) < 500 && reads < 200_000) {
            let held = lease.held_writes_under(hint).await;
            if !held.iter().any(|w| w.spend == spend) {
                missed += 1;
            }
            reads += 1;
        }
        stop.store(true, Ordering::Relaxed);
        mover.join().expect("the mover ends");
        let moves = moves.load(Ordering::Relaxed);
        assert!(moves >= 500, "the write was moved {moves} times in {reads} reads");
        assert_eq!(missed, 0, "{missed} of {reads} reads found no write while it was moved {moves} times");
        assert!(lease.is_settling(&id), "settling once the mover gave the gate back");
    }

    /// The writes the lease holds under one hint come newest first, by the
    /// lease's number for their spends, parked or settling alike
    /// ([`WalletLease::held_writes_under`]), and the one write the
    /// listing's lookup takes is the newest ([`WalletLease::held_write_under`]):
    /// a listing written twice under its hint in one era, its first write
    /// settling, rebuilds its lost mark from the second ([`lost_listing_mark`]),
    /// and a knock's filing goes through them newest first
    /// ([`lost_knock_entry`]). Three memo writes under one hint, the middle
    /// one settling, are listed newest first, though the lease keeps the
    /// parked and the settling ones apart; a write under another hint is not
    /// listed.
    #[tokio::test]
    async fn the_writes_held_under_a_hint_are_listed_newest_first_parked_or_settling() {
        let sk = SecretKey::from_seed(&[0x6b; 32]);
        let hint = Bytes32::new([0x6c; 32]);
        let coins: Vec<Coin> = [0x6d, 0x6e, 0x71, 0x72].iter().map(|&b| Coin::new(Bytes32::new([b; 32]), our_puzzle_hash(&sk), 1000)).collect();
        let lease = WalletLease::new();
        let t0 = Instant::now();
        let mut spends = Vec::new();
        for (n, coin) in coins.iter().enumerate() {
            let under = if n == 3 { Bytes32::new([0x73; 32]) } else { hint };
            let bundle = build_publish_bundle(T11, &sk, *coin, under, Bytes::new(vec![n as u8])).unwrap();
            let spend = lease.park_with_bundle_at([(coin.coin_id(), 900)], Some((&bundle, money())), t0).unwrap().spend;
            if n == 1 {
                let settling = Settling { coins: vec![ParkedInput { coin_id: coin.coin_id(), seen_at: Some(900) }], spent_at: 1000, bundle, payer: Some(money()) };
                lease.retire(&[spend], vec![(spend, settling)], &[], &[], &[], t0);
            }
            spends.push(spend);
        }
        assert!(spends.windows(2).all(|w| w[0] < w[1]), "numbered in the order parked: {spends:?}");
        assert!(lease.is_parked(&coins[0].coin_id()) && lease.is_settling(&coins[1].coin_id()) && lease.is_parked(&coins[2].coin_id()));

        let held = lease.held_writes_under(hint).await;
        assert_eq!(held.iter().map(|w| w.spend).collect::<Vec<_>>(), vec![spends[2], spends[1], spends[0]], "newest first, the settling one among them");
        assert_eq!(held.iter().map(|w| w.spent_at).collect::<Vec<_>>(), vec![None, Some(1000), None]);
        assert_eq!(held.iter().map(|w| w.record.clone()).collect::<Vec<_>>(), vec![vec![2], vec![1], vec![0]], "each its own record");
        let newest = lease.held_write_under(hint).await.expect("held");
        assert_eq!(newest, held[0], "the newest");
    }

    /// Stage 4 design §4.4: a push parks its spend under the payer it names,
    /// before the push leaves (round 9) and in the parking's one write; a
    /// parking the file cannot take parks nothing for that payer either.
    #[tokio::test]
    async fn a_push_parks_its_spend_under_the_payer_it_names() {
        use crate::chia_chain::testing::Unanswering;
        let dir = std::env::temp_dir().join(format!("ssf-wallet-lease-push-payer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wallet_lease.json");
        let _ = std::fs::remove_file(&path);
        let coin = Bytes32::new([94u8; 32]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        let lease = WalletLease::new();
        lease.restore(&path, money());
        let outcome = push_parked_with(&lease, &Unanswering, beacon(), bundle.clone(), [coin]).await;
        assert!(matches!(outcome, Err(PushError::Unanswered(_))), "{outcome:?}");
        assert!(lease.is_parked(&coin) && lease.outgoing_pending_for(beacon()) && !lease.outgoing_pending_for(money()));
        let file: LeaseFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file.bundles.iter().map(|b| b.payer.clone()).collect::<Vec<_>>(), vec![Some(beacon().hex())], "the file names the payer the push named");
        let unsaved = WalletLease::new();
        unsaved.restore(&dir.join("missing").join("wallet_lease.json"), money());
        let outcome = push_parked_with(&unsaved, &Unanswering, beacon(), bundle, [coin]).await;
        assert!(matches!(outcome, Err(PushError::NotSent(LeaseError::Unsaved(_)))), "{outcome:?}");
        assert!(!unsaved.is_taken(&coin) && !unsaved.outgoing_pending_for(beacon()));
        assert!(unsaved.snapshot().bundles.is_empty(), "the bundle and its payer were taken back with the parking");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A listing of one page, run to its end, judged at `judged_at`.
    fn page_of(records: Vec<crate::chia_chain::CoinRecord>, judged_at: Option<u32>) -> crate::chia_chain::CoinListing {
        crate::chia_chain::CoinListing { records, truncated: false, next_cursor: None, judged_at }
    }

    /// The memo every write [`standing`] judges carries: its mark keeps the
    /// digest, and its parent's spend makes its coin with it
    /// ([`written_by`]).
    const WRITE_MEMO: &[u8] = b"the write";

    /// The spend of `child`'s parent that made `child` under `hint` carrying
    /// [`WRITE_MEMO`].
    fn written_by(child: &Coin, hint: Bytes32) -> crate::chia_chain::PuzzleAndSolution {
        crate::chia_chain::testing::memo_spend(child, hint, WRITE_MEMO)
    }

    /// The standing [`write_standing_on`] gives on testnet11 against `chain`
    /// for a write under `hint` carrying [`WRITE_MEMO`], confirmed at
    /// `confirmed` (0: pending).
    async fn standing(
        lease: &WalletLease,
        chain: &crate::chia_chain::testing::Scripted,
        coins: WriteCoins,
        hint: Bytes32,
        spend: Option<u64>,
        confirmed: u32,
    ) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
        let memo = Some(crate::chia_resolve::memo_digest(WRITE_MEMO));
        write_standing_on(lease, T11, chain, coins, hint, memo, spend, confirmed, "test").await
    }

    /// The standing exactly as `write_standing_of` gave it before the verdict
    /// split (stage 4 PR 7), against a given lease: one coin asked of the
    /// lease, the hint and the names listing alike, in that order — the hint
    /// lookup taking the memo digest it takes since ([`WRITE_MEMO`]'s).
    async fn standing_before_the_split(
        lease: &WalletLease,
        chain: &crate::chia_chain::testing::Scripted,
        coin: Bytes32,
        hint: Bytes32,
        spend: Option<u64>,
        confirmed: u32,
    ) -> Option<(crate::chia_resolve::WriteStanding, bool)> {
        let spends: Vec<u64> = spend.into_iter().collect();
        let (word, held): (LeaseWord, HashSet<u64>) = {
            let _gate = lease.lock().await;
            lease.reconcile_at(T11, chain, Instant::now()).await;
            (lease.lease_word(&coin), spends.iter().copied().filter(|s| lease.holds_spend(*s)).collect())
        };
        let ours = spend.is_some_and(|s| held.contains(&s));
        let child = crate::chia_resolve::child_under_hint(chain, hint, coin, Some(crate::chia_resolve::memo_digest(WRITE_MEMO))).await.ok()?;
        let spent_at = crate::chia_resolve::spent_heights(chain, vec![coin]).await.ok()?.into_iter().find(|(c, _)| *c == coin).map(|(_, h)| h);
        Some((crate::chia_resolve::write_standing(&child, spent_at, word, ours), child.gone_since(confirmed)))
    }

    /// Stage 4 design §4.4: a write is FOUND under its hint by its parent, the
    /// coin its own coin names, and JUDGED by its parked input, the coin the
    /// lease holds: the spent height and the lease's word are that input's,
    /// never the parent's. One coin for a spend-to-self of one coin; a
    /// burner's first write (`claim_write`'s) has the gift g as its parent
    /// and the dish coin as its parked input, as here.
    #[tokio::test]
    async fn a_write_is_found_by_its_parent_and_judged_by_its_parked_input() {
        use crate::chia_chain::{testing::Scripted, CoinRecord};
        use crate::chia_resolve::WriteStanding::{Confirmed, Dead, Pending};
        let gift = Coin::new(Bytes32::new([101u8; 32]), Bytes32::new([2u8; 32]), 1);
        let dish = Coin::new(Bytes32::new([102u8; 32]), Bytes32::new([3u8; 32]), 1);
        let split = WriteCoins { parent: gift.coin_id(), parked: dish.coin_id() };
        let (parent, parked) = (split.parent, split.parked);
        let hint = Bytes32::new([103u8; 32]);
        let child_of = |parent: Bytes32| CoinRecord { coin: Coin::new(parent, Bytes32::new([4u8; 32]), 1), confirmed_block_index: 1000, spent: false, spent_block_index: 0 };
        let input = |coin: Coin, spent: Option<u32>| CoinRecord { coin, confirmed_block_index: 900, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) };
        let bundle = SpendBundle::new(vec![], Signature::default());
        // Found by its parent: the child under the hint names the gift, whose
        // spend made it carrying the write.
        let by_gift = written_by(&child_of(parent).coin, hint);
        let chain = Scripted::new(vec![page_of(vec![child_of(parent)], Some(1001)), page_of(vec![], Some(1001))]).with_spend(parent, by_gift.clone());
        assert_eq!(standing(&WalletLease::new(), &chain, split, hint, None, 0).await, Some((Confirmed { height: 1000, seen_at: Some(1001) }, false)));
        assert_eq!(*chain.asked_spends.lock().unwrap(), vec![(parent, 1000)], "the gift's spend, at the child's height");
        let chain = Scripted::new(vec![page_of(vec![child_of(parent)], Some(1001)), page_of(vec![], Some(1001))]);
        assert_eq!(
            standing(&WalletLease::new(), &chain, WriteCoins::one(parked), hint, None, 0).await,
            Some((Pending, false)),
            "looked for by the dish coin, the gift's child is not found"
        );
        // The spent height is the parked input's, and the names listing asks
        // for it alone.
        let chain = Scripted::new(vec![page_of(vec![], Some(1001)), page_of(vec![input(dish, Some(1000))], Some(1001))]);
        assert_eq!(standing(&WalletLease::new(), &chain, split, hint, None, 0).await, Some((Dead("its coin went to another spend of ours"), false)));
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![parked]], "the names listing asks about the parked input");
        let chain = Scripted::new(vec![page_of(vec![], Some(1001)), page_of(vec![input(gift, Some(1000)), input(dish, None)], Some(1001))]);
        assert_eq!(
            standing(&WalletLease::new(), &chain, split, hint, None, 0).await,
            Some((Pending, false)),
            "the gift spent says nothing of the write: every first write spends it"
        );
        // The lease's word is the parked input's.
        let dropped = WalletLease::new();
        dropped.remember(&[(parked, LeaseWord::Dropped)]);
        let chain = Scripted::new(vec![page_of(vec![], Some(1001)), page_of(vec![], Some(1001))]);
        assert_eq!(standing(&dropped, &chain, split, hint, None, 0).await, Some((Dead("the mempool dropped it"), false)));
        let elsewhere = WalletLease::new();
        elsewhere.remember(&[(parent, LeaseWord::Dropped)]);
        let chain = Scripted::new(vec![page_of(vec![], Some(1001)), page_of(vec![], Some(1001))]);
        assert_eq!(standing(&elsewhere, &chain, split, hint, None, 0).await, Some((Pending, false)), "a word on the gift is no word on the write");
        // The lease holding the write's own spend still counts (round 12).
        let held = WalletLease::new();
        let parking = held.park_with_bundle([(parked, 900)], &bundle, burner()).unwrap();
        let chain = Scripted::new(vec![page_of(vec![], Some(1001)), page_of(vec![input(dish, Some(1000))], Some(1001))]);
        assert_eq!(
            standing(&held, &chain, split, hint, Some(parking.spend), 0).await,
            Some((Pending, false)),
            "spent with no child while the lease holds the spend: a fork between the lookups"
        );
        // In the order the lookups always ran (round 2): the lease's
        // reconciliation first — a settling spend is asked about on every
        // pass — then the hint, then the names listing. Asked in another
        // order, a page lands in another lookup and the verdict changes.
        let t0 = Instant::now();
        let settling = WalletLease::new();
        let parking = settling.park_with_bundle_at([(parked, 900)], Some((&bundle, burner())), t0).unwrap();
        settling.reconcile_at(T11, &Scripted::new(vec![page_of(vec![input(dish, Some(1000))], Some(1001))]), t0 + RECONCILE_GRACE).await;
        assert!(settling.is_settling(&parked));
        let chain = Scripted::new(vec![
            page_of(vec![input(dish, Some(1000))], Some(1001)),
            page_of(vec![child_of(parent)], Some(1001)),
            page_of(vec![input(dish, Some(1000))], Some(1001)),
        ])
        .with_spend(parent, by_gift);
        assert_eq!(
            standing(&settling, &chain, split, hint, Some(parking.spend), 0).await,
            Some((Confirmed { height: 1000, seen_at: Some(1001) }, false))
        );
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![parked], vec![parked]], "the lease's listing, then the input's, both of the parked input");
        assert!(settling.is_settling(&parked), "asked first, the lease decided nothing new");
    }

    /// Stage 4 design §13 row 7, "changes behaviour: none yet": for a write
    /// of one coin, as every write is but a burner's first, the verdict is
    /// the one the lookup gave before the split, through every branch of
    /// `write_standing`, `gone_since`, and a failed lookup.
    #[tokio::test]
    async fn a_write_of_one_coin_is_judged_exactly_as_before() {
        use crate::chia_chain::{testing::Scripted, CoinListing, CoinRecord};
        use crate::chia_resolve::WriteStanding::{self, Confirmed, Dead, Pending};
        /// How the lease stands before the lookups: knowing nothing of the
        /// coin, holding its spend (parked a moment ago, so not yet due a
        /// lookup of its own), or having released it as dropped.
        #[derive(Clone, Copy)]
        enum Before {
            Fresh,
            Holding,
            Released,
        }
        let ours = Coin::new(Bytes32::new([111u8; 32]), Bytes32::new([2u8; 32]), 1);
        let c = ours.coin_id();
        let hint = Bytes32::new([112u8; 32]);
        let bundle = SpendBundle::new(vec![], Signature::default());
        let child = CoinRecord { coin: Coin::new(c, Bytes32::new([4u8; 32]), 1), confirmed_block_index: 1000, spent: false, spent_block_index: 0 };
        let spent = CoinRecord { coin: ours, confirmed_block_index: 900, spent: true, spent_block_index: 1000 };
        // The write's own spend, which made the child carrying it: on both
        // sides, so the row that lists the child confirms it either side.
        let by_ours = written_by(&child.coin, hint);
        let chain_of = |pages: Vec<CoinListing>| Scripted::new(pages).with_spend(c, by_ours.clone());
        let cut = CoinListing { records: vec![], truncated: true, next_cursor: None, judged_at: Some(1001) };
        let empty = |judged_at: u32| page_of(vec![], Some(judged_at));
        // A row: its name, the lease before the lookups, the pages, the height
        // the write stood confirmed at, and the verdict it gets either side of
        // the split.
        type Row = (&'static str, Before, Vec<CoinListing>, u32, Option<(WriteStanding, bool)>);
        let rows: Vec<Row> = vec![
            ("found", Before::Fresh, vec![page_of(vec![child], Some(1001)), page_of(vec![spent.clone()], Some(1001))], 0, Some((Confirmed { height: 1000, seen_at: Some(1001) }, false))),
            ("cut short", Before::Fresh, vec![cut, empty(1001)], 0, Some((Pending, false))),
            ("absent, spent and held", Before::Holding, vec![empty(1001), page_of(vec![spent.clone()], Some(1001))], 0, Some((Pending, false))),
            ("absent, spent, judged at the spend", Before::Fresh, vec![empty(1000), page_of(vec![spent.clone()], Some(1001))], 0, Some((Dead("its coin went to another spend of ours"), false))),
            ("absent, spent, judged below it", Before::Fresh, vec![empty(999), page_of(vec![spent], Some(999))], 0, Some((Pending, false))),
            ("absent and dropped", Before::Released, vec![empty(1001), empty(1001)], 0, Some((Dead("the mempool dropped it"), false))),
            ("absent and parked", Before::Holding, vec![empty(1001), empty(1001)], 0, Some((Pending, false))),
            ("absent and unknown", Before::Fresh, vec![empty(1001), empty(1001)], 0, Some((Pending, false))),
            ("gone since its confirmation", Before::Fresh, vec![empty(1001), empty(1001)], 1000, Some((Pending, true))),
            ("absent below its confirmation", Before::Fresh, vec![empty(999), empty(999)], 1000, Some((Pending, false))),
            ("the names lookup fails", Before::Fresh, vec![empty(1001)], 0, None),
            ("the hint lookup fails", Before::Fresh, vec![], 0, None),
        ];
        for (name, before, pages, confirmed, want) in rows {
            let lease_as = || {
                let lease = WalletLease::new();
                let spend = match before {
                    Before::Fresh => None,
                    Before::Holding => Some(lease.park_with_bundle([(c, 900)], &bundle, money()).unwrap().spend),
                    Before::Released => {
                        lease.remember(&[(c, LeaseWord::Dropped)]);
                        None
                    }
                };
                (lease, spend)
            };
            let (now_lease, now_spend) = lease_as();
            let now = standing(&now_lease, &chain_of(pages.clone()), WriteCoins::one(c), hint, now_spend, confirmed).await;
            let (then_lease, then_spend) = lease_as();
            let then = standing_before_the_split(&then_lease, &chain_of(pages), c, hint, then_spend, confirmed).await;
            assert_eq!(now, then, "{name}: as before the split");
            assert_eq!(now, want, "{name}");
        }
    }

    /// The memo check at the beacon and presence verdicts: each reads the
    /// digest its mark keeps, and its coin under the hint confirms it only if
    /// the input's spend made that coin carrying the hint and that memo. The
    /// coin made again by another write of ours from the input — under
    /// another hint, or under the same with another memo — still listed under
    /// the mark's hint (a row an orphaned block left) is a stale row: not
    /// confirmed, and, its input spent and the lease holding no spend of it,
    /// its coin went to another spend of ours. A mark an older node saved
    /// keeps no digest, and is judged by its hint alone; a malformed digest
    /// is none.
    #[tokio::test]
    async fn the_beacon_and_presence_verdicts_confirm_a_write_only_by_the_memo_its_mark_keeps() {
        use crate::chia_chain::{testing::Scripted, CoinRecord};
        use crate::chia_resolve::WriteStanding::{Confirmed, Dead};
        let input = Coin::new(Bytes32::new([141u8; 32]), Bytes32::new([2u8; 32]), 1);
        let (hint, other_hint) = (Bytes32::new([142u8; 32]), Bytes32::new([143u8; 32]));
        let made = Coin::new(input.coin_id(), Bytes32::new([4u8; 32]), 1);
        let payer = Payer::of(&SecretKey::from_seed(&[144u8; 32]));
        let write = MemoWrite { coins: WriteCoins::one(input.coin_id()), acked: true, spend: None, memo: crate::chia_resolve::memo_digest(b"our write"), payer };
        // The coin listed under the hint, then the input spent at its height;
        // the input's spend carried `carried` under `carried_hint`.
        let chain = |carried_hint: Bytes32, carried: &[u8]| {
            Scripted::new(vec![
                page_of(vec![CoinRecord { coin: made, confirmed_block_index: 1000, spent: false, spent_block_index: 0 }], Some(1001)),
                page_of(vec![CoinRecord { coin: input, confirmed_block_index: 900, spent: true, spent_block_index: 1000 }], Some(1001)),
            ])
            .with_spend(input.coin_id(), crate::chia_chain::testing::memo_spend(&made, carried_hint, carried))
        };
        let confirmed = Some((Confirmed { height: 1000, seen_at: Some(1001) }, false));
        let elsewhere = Some((Dead("its coin went to another spend of ours"), false));
        let beacon = BeaconMark::written(5, 1, hint, &write, "n".into());
        let presence = NodePublishMark::written(5, 1, "a".into(), 1, hint, &write, "n".into());
        let ours = beacon.memo.clone();
        assert_eq!(presence.memo, ours);
        let rows: Vec<(String, Bytes32, &[u8], _, &str)> = vec![
            (ours.clone(), hint, &b"our write"[..], confirmed.clone(), "its own memo"),
            (ours.clone(), other_hint, &b"our write"[..], elsewhere.clone(), "the coin made again under another hint"),
            (ours, hint, &b"another write"[..], elsewhere.clone(), "the coin made again under this hint with another memo"),
            (String::new(), hint, &b"another write"[..], confirmed.clone(), "an older node's mark: the hint alone"),
            (String::new(), other_hint, &b"our write"[..], elsewhere, "an older node's mark still tells another hint apart"),
            ("zz".into(), hint, &b"another write"[..], confirmed, "a malformed digest is none"),
        ];
        for (memo, carried_hint, carried, want, why) in rows {
            let on = chain(carried_hint, carried);
            assert_eq!(beacon_standing_on(&WalletLease::new(), T11, &on, &BeaconMark { memo: memo.clone(), ..beacon.clone() }).await, want, "beacon: {why}");
            assert_eq!(*on.asked_spends.lock().unwrap(), vec![(input.coin_id(), 1000)], "beacon: {why}");
            let on = chain(carried_hint, carried);
            assert_eq!(presence_standing_on(&WalletLease::new(), T11, &on, &NodePublishMark { memo, ..presence.clone() }).await, want, "presence: {why}");
        }
    }

    /// The digest a write's mark keeps, made with its bundle ([`memo_bundle`],
    /// the one place a writer the SSF wallet's keys pay for makes it; the
    /// burner builder makes its own the same way,
    /// `claim_write::build_burner_bundle`), is the digest of the memo its
    /// readers take from its spend ([`crate::chia_resolve::extract_ciphertext`])
    /// and of the second memo of the output the writer's verdict reads
    /// ([`crate::chia_resolve::output_memos`] of the coin the write makes). A
    /// digest of anything else, or a memo laid out otherwise by the builder,
    /// would have every write the SSF wallet's keys pay for judged a stale
    /// row of its own coin, and written again.
    #[test]
    fn a_writes_memo_digest_is_the_one_its_readers_take_from_its_spend() {
        use crate::chia_network::ChiaNet;
        let sk = SecretKey::from_seed(&[14u8; 32]);
        let coin = Coin::new(Bytes32::new([153u8; 32]), our_puzzle_hash(&sk), 1000);
        let hint = Bytes32::new([154u8; 32]);
        let body = b"a sealed write".to_vec();
        let (bundle, memo) = memo_bundle(ChiaNet::Testnet11, &sk, coin, hint, body.clone()).unwrap();
        assert_eq!(bundle, build_publish_bundle(ChiaNet::Testnet11, &sk, coin, hint, Bytes::new(body)).unwrap(), "the one builder's bundle");
        assert_eq!(bundle.coin_spends.len(), 1);
        let spend = crate::chia_chain::PuzzleAndSolution {
            puzzle_reveal: bundle.coin_spends[0].puzzle_reveal.clone(),
            solution: bundle.coin_spends[0].solution.clone(),
        };
        let read = crate::chia_resolve::extract_ciphertext(&spend, hint).unwrap().expect("a reader opens the memo under the hint");
        assert_eq!(memo, crate::chia_resolve::memo_digest(&read), "the digest of what a reader opens");
        let ours = Coin::new(coin.coin_id(), our_puzzle_hash(&sk), coin.amount - PUBLISH_FEE);
        let memos = crate::chia_resolve::output_memos(&spend, ours.puzzle_hash, ours.amount).unwrap().expect("the spend makes the write's coin");
        assert_eq!(memos.len(), 2, "[hint, memo]");
        assert_eq!(memos[0].as_ref(), hint.as_ref());
        assert_eq!(memo, crate::chia_resolve::memo_digest(memos[1].as_ref()), "the digest of the memo the verdict reads");
        assert!(ChiaNet::ALL.iter().filter(|net| !net.is_test()).all(|net| memo_bundle(*net, &sk, coin, hint, vec![1]).is_err()), "off a test network, refused as the builder refuses");
    }

    /// A mark keeps the digest of its write's memo from the moment the write
    /// files it — presence, beacon and sent knock alike, beside its coins, its
    /// payer and the lease's number for the spend — and keeps it across a
    /// restart; a void presence mark forgets it with the write, its coins
    /// with it, and keeps its payer (stage 4 design §4.4, §8.3). A write the
    /// SSF wallet's keys pay for files its one coin as its parked input too,
    /// and the paying key as its payer, never none.
    #[test]
    fn each_mark_keeps_its_writes_memo_digest_and_a_void_one_forgets_it() {
        let payer = Payer::of(&SecretKey::from_seed(&[150u8; 32]));
        let write = MemoWrite { coins: WriteCoins::one(Bytes32::new([151u8; 32])), acked: false, spend: Some(9), memo: crate::chia_resolve::memo_digest(b"memo"), payer };
        let (hint, coin, digest) = (Bytes32::new([152u8; 32]), hex::encode([151u8; 32]), hex::encode(write.memo));
        let presence = NodePublishMark::written(5, 2, "a".into(), 100, hint, &write, "n".into());
        assert_eq!(
            presence,
            NodePublishMark {
                era: 5,
                writes: 2,
                addrs_sig: "a".into(),
                last_at: 100,
                hint: hex::encode(hint),
                confirmed: false,
                chain_seen: false,
                coin_id: coin.clone(),
                memo: digest.clone(),
                confirmed_height: 0,
                settled: false,
                spend: Some(9),
                node_id: Some("n".into()),
                parked: coin.clone(),
                payer: Some(payer.hex()),
            }
        );
        let void = presence.voided();
        assert_eq!(
            (void.memo.as_str(), void.coin_id.as_str(), void.parked.as_str(), void.spend),
            ("", "", "", None),
            "void: the write forgotten, its memo digest and its coins with it"
        );
        assert_eq!(void.hint, presence.hint, "the hint stays, as the era and the addresses do");
        assert_eq!(void.payer, Some(payer.hex()), "…and so does the payer, for the hint rule");
        let beacon = BeaconMark::written(5, 100, hint, &write, "n".into());
        assert_eq!(
            beacon,
            BeaconMark {
                era: 5,
                last_at: 100,
                hint: hex::encode(hint),
                node_id: Some("n".into()),
                coin_id: coin.clone(),
                memo: digest.clone(),
                confirmed: false,
                confirmed_height: 0,
                settled: false,
                spend: Some(9),
                parked: coin.clone(),
                payer: Some(payer.hex()),
            }
        );
        let req = KnockRequest { room: "r".into(), host: "H".into(), ck_host: [1u8; 32], kx_host: [2u8; 32], attempts: 1 };
        let knock = sent_knock_of(&req, 5, hint, &write, 100);
        assert_eq!(
            knock,
            SentKnock {
                host: "H".into(),
                room: "r".into(),
                era: 5,
                hint: hex::encode(hint),
                coin_id: coin.clone(),
                memo: digest,
                pushed_at: 100,
                confirmed_height: 0,
                last_rendezvous: 0,
                settled: false,
                spend: Some(9),
                parked: coin,
                payer: Some(payer.hex()),
            }
        );
        // Across a restart, each file keeps it.
        assert_eq!(serde_json::from_slice::<NodePublishMark>(&serde_json::to_vec(&presence).unwrap()).unwrap(), presence);
        assert_eq!(serde_json::from_slice::<BeaconMark>(&serde_json::to_vec(&beacon).unwrap()).unwrap(), beacon);
        assert_eq!(serde_json::from_slice::<SentKnock>(&serde_json::to_vec(&knock).unwrap()).unwrap(), knock);
    }

    /// Stage 4 design §4.1 and §4.4: a burner's first write is filed by its
    /// gift g as the coin, its dish coin F as the parked input and the burner
    /// as the payer — presence, beacon and sent knock alike — and each mark
    /// reads back as exactly the coins the write is judged by, across a
    /// restart too. The burner is another payer than the money address. A
    /// void presence mark forgets g and F with the write, and keeps the
    /// burner as its payer.
    #[test]
    fn each_mark_files_a_burners_first_write_by_its_gift_its_dish_coin_and_the_burner_as_payer() {
        use crate::chia_burner::{BurnerRoot, MoneyKey};
        let wallet = SecretKey::from_seed(&[16u8; 32]);
        let key = BurnerRoot::of(&MoneyKey::new(wallet.clone()), T11).presence(&[17u8; 32], 5);
        let (g, f) = (Bytes32::new([155u8; 32]), Bytes32::new([156u8; 32]));
        let write = MemoWrite { coins: WriteCoins { parent: g, parked: f }, acked: true, spend: Some(11), memo: crate::chia_resolve::memo_digest(b"a burner's write"), payer: Payer::of_burner(&key) };
        let (hint, gift, dish, burner) = (Bytes32::new([157u8; 32]), hex::encode(g), hex::encode(f), Payer::of_burner(&key).hex());
        assert_ne!(burner, Payer::of(&wallet).hex(), "the burner, not the money address");
        let presence = NodePublishMark::written(5, 1, "a".into(), 100, hint, &write, "n".into());
        let beacon = BeaconMark::written(5, 100, hint, &write, "n".into());
        let req = KnockRequest { room: "r".into(), host: "H".into(), ck_host: [1u8; 32], kx_host: [2u8; 32], attempts: 1 };
        let knock = sent_knock_of(&req, 5, hint, &write, 100);
        let filed = [
            ("presence", &presence.coin_id, &presence.parked, &presence.payer),
            ("beacon", &beacon.coin_id, &beacon.parked, &beacon.payer),
            ("knock", &knock.coin_id, &knock.parked, &knock.payer),
        ];
        for (what, coin_id, parked, payer) in filed {
            assert_eq!((coin_id.as_str(), parked.as_str(), payer.as_deref()), (gift.as_str(), dish.as_str(), Some(burner.as_str())), "{what}");
            assert_eq!(WriteCoins::filed(coin_id, parked), Some(write.coins), "{what}: read back as the coins the write is judged by");
        }
        // Across a restart, each file keeps both.
        assert_eq!(serde_json::from_slice::<NodePublishMark>(&serde_json::to_vec(&presence).unwrap()).unwrap(), presence);
        assert_eq!(serde_json::from_slice::<BeaconMark>(&serde_json::to_vec(&beacon).unwrap()).unwrap(), beacon);
        assert_eq!(serde_json::from_slice::<SentKnock>(&serde_json::to_vec(&knock).unwrap()).unwrap(), knock);
        // Void: the write's coins go, its payer stays.
        let void = presence.voided();
        assert_eq!((void.coin_id.as_str(), void.parked.as_str()), ("", ""), "void: g and F forgotten with the write");
        assert_eq!(void.payer.as_deref(), Some(burner.as_str()), "the burner stays as its payer");
        assert_eq!(WriteCoins::filed(&void.coin_id, &void.parked), None, "nothing left to judge");
    }

    /// Stage 4 design §4.4 and §8 (3), (6): a `publish_marks.json` and a
    /// `beacon_mark.json` in the shape the build before this one writes
    /// (its coin, no parked input, no payer) load, with no parked input and
    /// no payer, and read back as their one coin, the parent and the parked
    /// input alike, so they are judged exactly as before.
    #[test]
    fn a_mark_an_older_node_saved_has_no_parked_input_or_payer_and_is_read_back_as_its_one_coin() {
        let dir = std::env::temp_dir().join(format!("ssf-older-marks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let coin = Bytes32::new([158u8; 32]);
        let (coin_id, hint, memo) = (hex::encode(coin), "9f".repeat(32), "a0".repeat(32));
        let presence_path = dir.join(NODE_MARK_FILE);
        let presence_file = format!(
            r#"{{
  "era": 5,
  "writes": 2,
  "addrs_sig": "a",
  "last_at": 100,
  "hint": "{hint}",
  "confirmed": false,
  "chain_seen": false,
  "coin_id": "{coin_id}",
  "memo": "{memo}",
  "confirmed_height": 0,
  "settled": false,
  "spend": 9,
  "node_id": "n"
}}"#
        );
        std::fs::write(&presence_path, presence_file).unwrap();
        let presence = NodePublishMark::load(&presence_path).expect("an older node's presence mark loads");
        assert_eq!(
            presence,
            NodePublishMark {
                era: 5,
                writes: 2,
                addrs_sig: "a".into(),
                last_at: 100,
                hint: hint.clone(),
                confirmed: false,
                chain_seen: false,
                coin_id: coin_id.clone(),
                memo: memo.clone(),
                confirmed_height: 0,
                settled: false,
                spend: Some(9),
                node_id: Some("n".into()),
                parked: String::new(),
                payer: None,
            }
        );
        assert_eq!(WriteCoins::filed(&presence.coin_id, &presence.parked), Some(WriteCoins::one(coin)), "presence: its one coin is both");
        let beacon_path = dir.join(BEACON_MARK_FILE);
        let beacon_file = format!(
            r#"{{
  "era": 5,
  "last_at": 100,
  "hint": "{hint}",
  "node_id": "n",
  "coin_id": "{coin_id}",
  "memo": "{memo}",
  "confirmed": true,
  "confirmed_height": 1000,
  "settled": false,
  "spend": 9
}}"#
        );
        std::fs::write(&beacon_path, beacon_file).unwrap();
        let beacon = BeaconMark::load(&beacon_path).expect("an older node's beacon mark loads");
        assert_eq!(
            beacon,
            BeaconMark {
                era: 5,
                last_at: 100,
                hint,
                node_id: Some("n".into()),
                coin_id,
                memo,
                confirmed: true,
                confirmed_height: 1000,
                settled: false,
                spend: Some(9),
                parked: String::new(),
                payer: None,
            }
        );
        assert_eq!(WriteCoins::filed(&beacon.coin_id, &beacon.parked), Some(WriteCoins::one(coin)), "beacon: its one coin is both");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Stage 4 design §4.4: a mark whose parked input is malformed has
    /// nothing to judge, as one whose coin is malformed: the presence and
    /// beacon verdicts are `None` before the lease or the chain is asked, and
    /// never fall back to the one coin: for a burner's first write that never
    /// lands, the lease and the spent height would then be asked about a gift
    /// the lease never parked and no chain holds, and the write would read
    /// pending for ever instead of dead. Filed whole, the same marks are
    /// looked up.
    #[tokio::test]
    async fn a_mark_whose_parked_input_is_malformed_is_not_judged_and_the_chain_is_not_asked() {
        use crate::chia_chain::testing::Scripted;
        let payer = Payer::of(&SecretKey::from_seed(&[159u8; 32]));
        let coins = WriteCoins { parent: Bytes32::new([160u8; 32]), parked: Bytes32::new([161u8; 32]) };
        let write = MemoWrite { coins, acked: true, spend: Some(3), memo: crate::chia_resolve::memo_digest(b"memo"), payer };
        let hint = Bytes32::new([162u8; 32]);
        let presence = NodePublishMark::written(5, 1, "a".into(), 100, hint, &write, "n".into());
        let beacon = BeaconMark::written(5, 100, hint, &write, "n".into());
        let asked = |chain: &Scripted| (chain.asked_spent.lock().unwrap().len(), chain.asked_names.lock().unwrap().len(), chain.asked_spends.lock().unwrap().len());
        for parked in ["zz", "0011"] {
            let chain = Scripted::new(vec![]);
            assert_eq!(presence_standing_on(&WalletLease::new(), T11, &chain, &NodePublishMark { parked: parked.into(), ..presence.clone() }).await, None, "presence: {parked}");
            assert_eq!(beacon_standing_on(&WalletLease::new(), T11, &chain, &BeaconMark { parked: parked.into(), ..beacon.clone() }).await, None, "beacon: {parked}");
            assert_eq!(asked(&chain), (0, 0, 0), "{parked}: the chain is not asked");
        }
        // Filed whole, each is looked up: a chain that answers nothing gives
        // no verdict this tick, once it was asked.
        let chain = Scripted::new(vec![]);
        assert_eq!(presence_standing_on(&WalletLease::new(), T11, &chain, &presence).await, None);
        assert_ne!(asked(&chain), (0, 0, 0), "presence: looked up");
        let chain = Scripted::new(vec![]);
        assert_eq!(beacon_standing_on(&WalletLease::new(), T11, &chain, &beacon).await, None);
        assert_ne!(asked(&chain), (0, 0, 0), "beacon: looked up");
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
        let (armed, refused) = publishable_rooms(crate::chia_network::ChiaNet::Testnet11, &caps);
        assert_eq!(armed, vec![("private-armed".to_string(), [1u8; 32])]);
        assert_eq!(
            refused,
            vec!["public-armed".to_string(), "unknown-armed".to_string()],
            "armed rooms that are public, or whose posture an old browser never sent, are named so the operator learns why nothing publishes"
        );
    }

    /// 🛑 Stage 4 design §4.5 (2): off a test network no room publishes a v1
    /// record, armed and known private or not; a test network keeps N8's
    /// answer.
    #[test]
    fn off_a_test_network_no_room_publishes_a_v1_record() {
        use crate::chia_network::ChiaNet;
        let caps = vec![
            ("private-armed".to_string(), cap(1, true, Some(false))),
            ("public-armed".to_string(), cap(3, true, Some(true))),
        ];
        for net in ChiaNet::ALL {
            let (armed, refused) = publishable_rooms(net, &caps);
            if net.is_test() {
                assert_eq!(armed, vec![("private-armed".to_string(), [1u8; 32])], "{net:?}");
                assert_eq!(refused, vec!["public-armed".to_string()], "{net:?}");
            } else {
                assert!(armed.is_empty() && refused.is_empty(), "{net:?}: {armed:?} {refused:?}");
            }
        }
    }

    /// 🛑 Stage 4 design §4.5 (1): the builder of every memo spend the SSF
    /// wallet's keys pay for refuses off a test network, before it signs,
    /// whichever of them pays (the money key, or the beacon key made from
    /// it). The burner builder, `claim_write::build_burner_bundle`, signs
    /// with a burner key alone and has no such refusal: its callers' gate is
    /// SSF_CHIA_BURNERS on a test network (§13 rows 9 and 10). A test network builds
    /// the spend as before. The refusal says why in the player's words, and
    /// the log line names every write that stops.
    #[test]
    fn off_a_test_network_the_ssf_wallet_pays_for_no_memo_spend() {
        use crate::chia_network::ChiaNet;
        let money = SecretKey::from_seed(&[12u8; 32]);
        let beacon = beacon_wallet_key(&money);
        let hint = Bytes32::new([4u8; 32]);
        for net in ChiaNet::ALL {
            for sk in [&money, &beacon] {
                let coin = Coin::new(Bytes32::new([3u8; 32]), our_puzzle_hash(sk), 1000);
                let built = build_publish_bundle(net, sk, coin, hint, Bytes::new(vec![1, 2, 3]));
                if net.is_test() {
                    let bundle = built.unwrap();
                    assert_eq!(bundle.coin_spends.len(), 1, "{net:?}");
                    assert_eq!(money_memo_refusal(net), None);
                    assert_eq!(money_memo_line(net), None);
                    assert!(refuse_money_memo(net).is_ok());
                } else {
                    let err = built.unwrap_err();
                    let refused = err.downcast_ref::<MoneyMemoRefused>().expect("refused by the rule, not by a failed build");
                    // Since review: a listing an older build wrote can still
                    // be listed, sent or outdated, and the row says this
                    // after each, so it says what stops, not "not listed".
                    assert_eq!(refused.0, "on Chia mainnet the SSF wallet pays for no Phone Book write, so this node writes no new listing there yet");
                    assert_eq!(err.to_string(), refused.0);
                    assert_eq!(refuse_money_memo(net), Err(refused.clone()), "asked again, the same answer");
                }
            }
        }
        assert_eq!(
            money_memo_line(ChiaNet::Mainnet).unwrap(),
            "⛓️ ChiaHub: on Chia mainnet the SSF wallet pays for no chain write, so this node writes no listing, knock, beacon or room record there until burner keys land. It still reads the chain."
        );
        // The Phone Book row repeats it whole: the page cuts a node's text
        // past 160 characters (phoneBook.ts ERROR_MAX). It follows every
        // state's words (phoneBook.test.ts), "Not in the Phone Book yet:"
        // among them, so it neither repeats nor denies a listing.
        let why = money_memo_refusal(ChiaNet::Mainnet).unwrap();
        assert!(why.chars().count() <= 160 && !why.contains('\u{2014}'), "{why}");
        assert!(!why.contains("not listed") && !why.contains("Phone Book yet"), "{why}");
    }

    /// A voided listing or a forgotten beacon is written again on a test
    /// network only: off one the line says nothing follows, since the SSF
    /// wallet pays for no chain write there.
    #[test]
    fn a_voided_write_is_written_again_on_a_test_network_only() {
        use crate::chia_network::ChiaNet;
        assert_eq!(write_again_words(ChiaNet::Testnet11), "writing it again");
        assert_eq!(
            write_again_words(ChiaNet::Mainnet),
            "nothing is written again on Chia mainnet (the SSF wallet pays for no chain write there)"
        );
        for net in ChiaNet::ALL {
            assert_eq!(write_again_words(net) == "writing it again", money_memo_refusal(net).is_none(), "{net:?}");
        }
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

    /// ⛓️ A spend signed for one network is signed over that network's
    /// AGG_SIG data: it verifies under its own constants and fails the
    /// RequiredSignature check under the other's.
    #[test]
    fn a_spend_signed_for_one_network_fails_under_the_others_constants() {
        use crate::chia_network::ChiaNet;
        let sk = SecretKey::from_seed(&[11u8; 32]);
        let coin = Coin::new(Bytes32::new([3u8; 32]), our_puzzle_hash(&sk), 1000);
        let hint = Bytes32::new([4u8; 32]);
        let verifies = |bundle: &SpendBundle, under: ChiaNet| {
            let mut a = Allocator::new();
            let constants = AggSigConstants::from(under.constants());
            let required = RequiredSignature::from_coin_spends(&mut a, &bundle.coin_spends, &constants).unwrap();
            assert!(!required.is_empty(), "a standard spend asks for a signature");
            let pairs: Vec<(PublicKey, Vec<u8>)> = required
                .iter()
                .map(|r| match r {
                    RequiredSignature::Bls(bls) => (bls.public_key, bls.message()),
                    RequiredSignature::Secp(_) => panic!("no secp on a standard spend"),
                })
                .collect();
            chia_bls::aggregate_verify(&bundle.aggregated_signature, pairs)
        };
        // The memo spend is built on testnet11 only (mainnet refuses it,
        // `off_a_test_network_the_ssf_wallet_pays_for_no_memo_spend`), so its
        // coin spends are signed for each network by the shared signer, the
        // part that takes the network.
        let t11 = build_publish_bundle(ChiaNet::Testnet11, &sk, coin, hint, Bytes::new(vec![1, 2, 3])).unwrap();
        for signed in ChiaNet::ALL {
            let bundle = sign_standard_spends(signed, &sk, t11.coin_spends.clone()).unwrap();
            for under in ChiaNet::ALL {
                assert_eq!(verifies(&bundle, under), signed == under, "signed for {signed:?}, checked under {under:?}");
            }
        }
        assert_eq!(sign_standard_spends(ChiaNet::Testnet11, &sk, t11.coin_spends.clone()).unwrap(), t11, "the builder signs as the signer does");
        let main = sign_standard_spends(ChiaNet::Mainnet, &sk, t11.coin_spends.clone()).unwrap();
        assert_eq!(t11.coin_spends, main.coin_spends, "the same spend; only the signature differs");
        assert_ne!(t11.aggregated_signature, main.aggregated_signature);
    }

    /// Stage 4 design §8 (2): `SSF_CHIA_BURNERS` is on with exactly `1` on a
    /// test network, and its line says what it does in this build: the
    /// listing and each knock written from burner keys of their own, a knock
    /// once per host and room per edition, the waits that use no attempt,
    /// and the beacon paid as before. It names no busy chain among the
    /// waits, since a push refused for its fee still uses an attempt (§10).
    /// `1` off a test network is ignored, with one line; any other value is
    /// off and says nothing, on every network. No environment is read.
    #[test]
    fn ssf_chia_burners_is_on_with_exactly_1_on_a_test_network_and_ignored_with_a_line_off_one() {
        use crate::chia_network::ChiaNet;
        use std::ffi::OsStr;
        for net in ChiaNet::ALL {
            assert_eq!(burners_of(net, None), (false, None), "unset on {net:?}");
            for raw in ["", "0", "true", "yes", " 1", "1 ", "11", "01"] {
                assert_eq!(burners_of(net, Some(OsStr::new(raw))), (false, None), "{raw:?} on {net:?}");
            }
            #[cfg(unix)]
            {
                use std::os::unix::ffi::OsStrExt;
                for raw in [&[0xffu8][..], &[b'1', 0xff][..]] {
                    assert_eq!(burners_of(net, Some(OsStr::from_bytes(raw))), (false, None), "not UTF-8 ({raw:?}) on {net:?}");
                }
            }
            let (on, line) = burners_of(net, Some(OsStr::new("1")));
            assert_eq!(on, net.is_test(), "{net:?}");
            assert!(line.is_some(), "1 is said on {net:?}");
            assert!(!line.unwrap_or_default().contains("busy"), "no busy chain among the waits on {net:?}");
        }
        assert_eq!(
            burners_of(ChiaNet::Testnet11, Some(OsStr::new("1"))).1.as_deref(),
            Some(
                "⛓️ ChiaHub burners (SSF_CHIA_BURNERS=1): on for testnet11. The Phone Book listing is written from a burner key the lobby dish funds, and goes out in each edition's first day, within about an hour of coming online after it, or at once for a station not listed last edition. Each knock is written from a burner key of its own, funded the same way, once per host and room per edition: a knock's key that has written is never written again. A knock that only waits (no mojo ready in the lobby dish, the edition's 16 gifts given, a spend still settling, the chain unread) uses none of its 3 attempts and is tried again in 5 minutes. SSF_CHIA_CLAIM_WRITE_TEST=1 runs one claim-and-write from the lobby dish at startup. The beacon is still paid as before."
            )
        );
        assert_eq!(
            burners_of(ChiaNet::Mainnet, Some(OsStr::new("1"))).1.as_deref(),
            Some("⛓️ ChiaHub: SSF_CHIA_BURNERS=1 is ignored on Chia mainnet. Burner keys are tried on a test network only.")
        );
    }

    /// The reasons a money-paid write waits are typed now, and say what the
    /// log always said: the text is the one `publish_memo_with` gave as a
    /// plain error before, so the presence, knock and beacon lines read the
    /// same (stage 4 design §5.2).
    #[test]
    fn a_money_writes_waits_are_typed_and_read_as_they_always_did() {
        let what = "knock";
        let settling: anyhow::Error = MemoWait::Settling(what.to_string()).into();
        assert_eq!(format!("{settling:#}"), format!("a spend from this wallet is still settling — the {what} write waits for its verdict"));
        let our_ph = Bytes32::new([0xa1; 32]);
        let unfunded: anyhow::Error = MemoWait::Unfunded(our_ph).into();
        assert_eq!(format!("{unfunded:#}"), format!("chia wallet unfunded — no unspent coin at puzzle hash {our_ph}"));
        assert_eq!(unfunded.to_string(), format!("{unfunded:#}"), "one line either way");
    }

    /// The [`knock_failures`] row of a push every peer refused for its fee
    /// alone: the chain busy ([`chain_busy`]), and still a failure.
    const BUSY: &str = "a push every peer refused for its fee, the chain busy";

    /// Real errors of each kind a knock can fail with, as the code that
    /// fails makes them where a test can reach it: the waits of stage 4
    /// design §5.2 first, then the failures. The chain's are read from a
    /// chain that answers nothing, the lease's from a lease sealed by an
    /// unreadable file and one whose file cannot be saved, the dish's from
    /// `claim_to`, and the seal's from a host card whose key is a low-order
    /// point. The burner writer's waits and a push the peers refused are
    /// their own values, of the types its seam returns them as: chain_tests
    /// drives the seam to every wait but `PeakUnavailable`, which
    /// claim_write's own tests reach on a chain with no peak, and to a push
    /// every peer refused. A broken burner rule is the rule checker's own
    /// refusal (`check_burner_spends`), since the seam builds only from
    /// inputs that keep the rules. Two of the pushes refused carry two
    /// peers' reasons, joined as the lane joins them: both for the fee,
    /// which is the chain being busy ([`BUSY`], §10), and one for each of a
    /// lost race and the fee.
    ///
    /// Last come the drops: the knocks that are not written and are never
    /// tried again ([`knock_not_written`]). One is a room's word withdrawn at
    /// spend time, as [`knock_leave`] gives it for a room with no cap
    /// ([`Withdrawn`]). The other is a knock whose own key already wrote this
    /// era, the knock writer's own value (`claim_write::AlreadyKnocked`, of
    /// the type its seam returns it as), which claim_write's own tests drive
    /// the writer to.
    async fn knock_failures(test: &str) -> (KnockErrors, KnockErrors, KnockErrors) {
        use super::claim_write::{check_burner_spends, AlreadyKnocked, BurnerRule, BurnerWait};
        use crate::chia_chain::testing::{Scripted, Unanswering};
        use crate::chia_faucet::{claim_to, ClaimToError};
        use rand::SeedableRng;
        let nobody = Bytes32::new([0xc1; 32]);
        let mut rng = rand::rngs::StdRng::seed_from_u64(9);
        let dir = std::env::temp_dir().join(format!("ssf-knock-attempts-{test}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sealed = WalletLease::new();
        std::fs::write(dir.join("sealed.json"), b"not a lease").unwrap();
        sealed.restore(&dir.join("sealed.json"), money());
        let unsaved = WalletLease::new();
        unsaved.restore(&dir.join("missing").join("wallet_lease.json"), money());
        let empty = || SpendBundle::new(vec![], chia_bls::Signature::default());
        let coin = Bytes32::new([0xc2; 32]);
        let empty_dish = crate::chia_chain::CoinListing { records: vec![], truncated: false, next_cursor: None, judged_at: None };
        let host = KnockRequest { room: "r".into(), host: "H".into(), ck_host: [1u8; 32], kx_host: [0u8; 32], attempts: 0 };
        let iroh_sk = iroh::SecretKey::from_bytes(&[5u8; 32]);

        let waits: Vec<(&'static str, anyhow::Error)> = vec![
            ("the wallet still settling", MemoWait::Settling("knock".into()).into()),
            ("the wallet unfunded", MemoWait::Unfunded(Bytes32::new([0xa1; 32])).into()),
            ("a burner's spend in flight", BurnerWait::Held.into()),
            ("a burner's bundle settling", BurnerWait::Settling.into()),
            ("a burner's listing cut short", BurnerWait::ListingCutShort.into()),
            ("a knock's key unread, its listing or its parents' lookup cut short", BurnerWait::KnockKeyUnread.into()),
            ("no peak for a burner's gift", BurnerWait::PeakUnavailable.into()),
            ("no lobby coin for a burner", BurnerWait::NoCoinReady.into()),
            ("the fuse blown", BurnerWait::FuseBlown { era: 3 }.into()),
            ("a burner's first write behind the SSF wallet's spend", BurnerWait::MoneyInFlight.into()),
            ("no dish coin ready", claim_to(T11, &Scripted::new(vec![empty_dish]).with_peak(200), nobody, |_| false, &mut rng).await.unwrap_err()),
            ("no peak for the dish", claim_to(T11, &Unanswering, nobody, |_| false, &mut rng).await.unwrap_err()),
            ("the dish's listing unread", claim_to(T11, &Scripted::new(vec![]).with_peak(200), nobody, |_| false, &mut rng).await.unwrap_err()),
            ("the lease sealed", sealed.ensure_open().unwrap_err().into()),
            ("the lease sealed, at the push", push_parked_with(&sealed, &Unanswering, money(), empty(), [coin]).await.unwrap_err().into()),
            ("the lease unsaved, at the push", push_parked_with(&unsaved, &Unanswering, money(), empty(), [coin]).await.unwrap_err().into()),
            ("the wallet's listing unread", find_spendable_coin_on(&WalletLease::new(), &Unanswering, Bytes32::new([0xa1; 32])).await.unwrap_err()),
            ("the peak unread", Unanswering.peak_height().await.unwrap_err().into()),
            ("a wait under a context", anyhow::Error::from(MemoWait::Unfunded(Bytes32::new([0xa1; 32]))).context("knock on H")),
        ];
        let failures: Vec<(&'static str, anyhow::Error)> = vec![
            ("a push every peer refused, a lost race", PushError::Rejected("addr: DOUBLE_SPEND".into()).into()),
            (BUSY, PushError::Rejected("a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into()).into()),
            ("a push one peer refused as spent and one for its fee", PushError::Rejected("a: DOUBLE_SPEND; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into()).into()),
            ("a host card whose key cannot be sealed to", knock_memo(T11, &iroh_sk, &host, &[6u8; 32], 0, coin, None, 1_791_700_000).unwrap_err()),
            ("a burner rule the bundle breaks", check_burner_spends(T11, nobody, &[]).unwrap_err().into()),
            ("a burner paying more than itself", BurnerRule::R5.into()),
            ("a claim the dish refuses", ClaimToError::Refused("no claim here").into()),
            ("an untyped error", anyhow!("memo alloc failed")),
        ];
        let drops: Vec<(&'static str, anyhow::Error)> = vec![
            (WITHDRAWN, anyhow::Error::from(knock_leave(None, false, true, true, &[0; 32]).unwrap_err())),
            (ALREADY_KNOCKED, AlreadyKnocked.into()),
        ];
        let _ = std::fs::remove_dir_all(&dir);
        (waits, failures, drops)
    }

    /// One list of [`knock_failures`]: each row names what failed, and holds
    /// the error.
    type KnockErrors = Vec<(&'static str, anyhow::Error)>;

    /// The [`knock_failures`] drop of a room's word withdrawn at spend time.
    const WITHDRAWN: &str = "a room's word withdrawn at spend time";

    /// The [`knock_failures`] drop of a knock whose own key already wrote
    /// this era.
    const ALREADY_KNOCKED: &str = "a knock's key that already wrote this era";

    /// Stage 4 design §5.2 with burner keys on: a knock that only waits (the
    /// wallet unfunded or settling, no dish coin, the lease not parking, the
    /// chain unread) uses no attempt, and every other failure uses one, a
    /// push every peer refused and a host card that can never be sealed to
    /// among them, so a request that can never leave is still dropped after
    /// its attempts. A push refused because the chain is busy is such a
    /// refusal (§10: a first push refused for its fee is a rejection): it
    /// uses an attempt, and only its words say the chain is busy. No other
    /// row reads as busy, the push one peer refused as spent among them. A
    /// knock withdrawn at spend time, or whose own key already wrote, is
    /// neither a wait nor the chain busy: it is dropped with its own line,
    /// and no wait or failure is.
    #[tokio::test]
    async fn with_burners_on_a_knock_that_only_waits_uses_no_attempt_and_every_other_failure_uses_one() {
        let (waits, failures, drops) = knock_failures("on").await;
        let host = KnockRequest { room: "r".into(), host: "H".into(), ck_host: [1u8; 32], kx_host: [0u8; 32], attempts: 0 };
        let named = |list: &[(&str, anyhow::Error)], name: &str| list.iter().find(|(what, _)| *what == name).map(|(_, e)| format!("{e:#}")).unwrap();
        assert!(named(&failures, "a host card whose key cannot be sealed to").contains("low-order point"), "the seal's own error");
        assert!(named(&waits, "the dish's listing unread").starts_with("coin lookup: unanswered"), "the listing's own error");
        assert!(failures.iter().any(|(what, _)| *what == BUSY), "the busy row is among the failures");
        for (what, e) in &waits {
            assert!(is_typed_wait(e), "{what} is a wait: {e:#}");
            assert!(!knock_attempt_counts(true, e), "{what} uses no attempt: {e:#}");
            assert!(!chain_busy(e), "{what} is not the chain busy: {e:#}");
        }
        for (what, e) in &failures {
            assert!(!is_typed_wait(e), "{what} is no wait: {e:#}");
            assert!(knock_attempt_counts(true, e), "{what} uses an attempt: {e:#}");
            assert_eq!(chain_busy(e), *what == BUSY, "{what}: {e:#}");
            let words = if *what == BUSY { CHAIN_BUSY_WORDS.to_string() } else { format!("{e:#}") };
            assert_eq!(knock_failure_words(true, e), words, "{what}");
        }
        for (what, e) in &drops {
            assert!(!is_typed_wait(e), "{what} is no wait: {e:#}");
            assert!(!chain_busy(e), "{what} is not the chain busy: {e:#}");
            assert!(knock_dropped_line(&host, e).is_some(), "{what} is dropped with its line: {e:#}");
        }
        for (what, e) in waits.iter().chain(&failures) {
            assert_eq!(knock_dropped_line(&host, e), None, "{what} is not dropped: {e:#}");
        }
    }

    /// With burner keys off, every knock failure uses an attempt, waits and
    /// all, as it always did, and its line gives the error's own text, a
    /// busy chain's included: the knock arm is main's.
    #[tokio::test]
    async fn with_burners_off_every_knock_failure_uses_an_attempt_as_before() {
        let (waits, failures, _) = knock_failures("off").await;
        for (what, e) in waits.iter().chain(&failures) {
            assert!(knock_attempt_counts(false, e), "{what}: {e:#}");
            assert_eq!(knock_failure_words(false, e), format!("{e:#}"), "{what}");
        }
    }

    /// Stage 4 design §10, Mempool full: a push every peer refused with
    /// INVALID_FEE_TOO_CLOSE_TO_ZERO, the fee-0 refusal of a full mempool, is
    /// the chain busy, one peer's or two peers' reasons as the lane joins
    /// them, and under a writer's context. A refusal in which any peer gave
    /// another reason is not: a lost race's DOUBLE_SPEND, a peer behind the
    /// input's block, a mempool conflict, another fee code, or no reason at
    /// all. Nor is anything but a refusal: a wait, a push unanswered or not
    /// sent, or a dry dish.
    #[test]
    fn a_full_mempools_fee_refusal_is_the_chain_busy_and_nothing_else_is() {
        use super::claim_write::BurnerWait;
        assert!(refusal_is_chain_busy("203.0.113.5:58444: INVALID_FEE_TOO_CLOSE_TO_ZERO"));
        assert!(refusal_is_chain_busy("a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: INVALID_FEE_TOO_CLOSE_TO_ZERO"), "both peers' mempools full");
        for not_busy in [
            "a: DOUBLE_SPEND; b: INVALID_FEE_TOO_CLOSE_TO_ZERO",
            "a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: DOUBLE_SPEND",
            "a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: UNKNOWN_UNSPENT",
            "a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: MEMPOOL_CONFLICT",
            "x: INVALID_FEE_LOW_FEE",
            "x: UNKNOWN_UNSPENT",
            "x: DOUBLE_SPEND",
            "",
        ] {
            assert!(!refusal_is_chain_busy(not_busy), "{not_busy:?} is not the chain busy");
        }

        let busy = || anyhow::Error::from(PushError::Rejected("a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into()));
        assert!(chain_busy(&busy()));
        assert!(chain_busy(&busy().context("presence")), "read through a writer's context");
        assert!(!is_typed_wait(&busy()), "a refusal, not a wait (§10: a first push refused for its fee is a rejection)");
        let lost = anyhow::Error::from(PushError::Rejected("a: DOUBLE_SPEND; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into()));
        assert!(!chain_busy(&lost));
        let others: Vec<(&str, anyhow::Error)> = vec![
            ("the wallet still settling", MemoWait::Settling("presence".into()).into()),
            ("a push unanswered", PushError::Unanswered(anyhow!("timed out")).into()),
            ("a push not sent", PushError::NotSent(LeaseError::Sealed("unreadable".into())).into()),
            ("no lobby coin for a burner", BurnerWait::NoCoinReady.into()),
            ("an untyped error naming the code", anyhow!("x: INVALID_FEE_TOO_CLOSE_TO_ZERO")),
        ];
        for (what, e) in &others {
            assert!(!chain_busy(e), "{what}: {e:#}");
        }
    }

    /// The beacon arm's failure line (stage 4 design §10): with burner keys
    /// on, a push refused because the chain is busy says the beacon waits and
    /// that waiting costs nothing, and names no peer's reason; any other
    /// failure, and every failure with burner keys off, gets the line the
    /// beacon always had, word for word.
    #[test]
    fn the_beacon_line_says_the_chain_is_busy_only_with_burner_keys_on() {
        let busy = anyhow::Error::from(PushError::Rejected("a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into())).context("beacon");
        let lost = anyhow::Error::from(PushError::Rejected("a: DOUBLE_SPEND; b: DOUBLE_SPEND".into())).context("beacon");
        let main = |e: &anyhow::Error| format!("⛓️ ChiaHub beacon: publish for era 7 failed: {e:#} (retry in 5 min; the beacon wallet is funded separately)");
        assert_eq!(
            beacon_failure_line(true, 7, &busy),
            "⛓️ ChiaHub beacon: the era 7 beacon waits — the chain is busy (a full mempool refused its zero fee); waiting costs nothing (retry in 5 min)"
        );
        assert_eq!(beacon_failure_line(false, 7, &busy), main(&busy), "burner keys off: main's line");
        assert_eq!(beacon_failure_line(true, 7, &lost), main(&lost), "a lost race: main's line");
        assert_eq!(beacon_failure_line(false, 7, &lost), main(&lost));
        assert!(main(&busy).contains("INVALID_FEE_TOO_CLOSE_TO_ZERO"), "main's line gives the peers' reasons");
    }

    /// The listing arm's failure line. With the SSF wallet paying, it is the
    /// line the listing always had, word for word, whatever failed. On the
    /// burner path a wait says the listing waits, a push refused because the
    /// chain is busy says so and that waiting costs nothing, naming no peer's
    /// reason (stage 4 design §10), and anything else failed, in its own text.
    #[test]
    fn the_listing_line_says_a_burner_listing_waits_or_failed_and_is_the_ssf_wallets_line_as_it_was() {
        use super::claim_write::BurnerWait;
        let busy = anyhow::Error::from(PushError::Rejected("a: INVALID_FEE_TOO_CLOSE_TO_ZERO; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into())).context("presence");
        let lost = anyhow::Error::from(PushError::Rejected("a: DOUBLE_SPEND; b: INVALID_FEE_TOO_CLOSE_TO_ZERO".into())).context("presence");
        let dry = anyhow::Error::from(BurnerWait::NoCoinReady).context("presence");
        let behind = anyhow::Error::from(BurnerWait::MoneyInFlight);
        let untyped = anyhow!("memo alloc failed");
        let main = |e: &anyhow::Error| format!("⛓️ ChiaHub presence: publish for era 7 failed: {e:#} (retry in 5 min)");
        for e in [&busy, &lost, &dry, &behind, &untyped] {
            assert_eq!(listing_failure_line(false, 7, e), main(e), "the SSF wallet's line: {e:#}");
        }
        assert_eq!(
            listing_failure_line(true, 7, &busy),
            "⛓️ ChiaHub presence: the era 7 listing waits — the chain is busy (a full mempool refused its zero fee); waiting costs nothing (retry in 5 min)"
        );
        assert!(!is_typed_wait(&busy), "a busy chain is a refusal, worded as a wait");
        for e in [&dry, &behind] {
            assert!(is_typed_wait(e));
            assert_eq!(listing_failure_line(true, 7, e), format!("⛓️ ChiaHub presence: the era 7 listing waits: {e:#} (retry in 5 min)"));
        }
        for e in [&lost, &untyped] {
            assert_eq!(listing_failure_line(true, 7, e), format!("⛓️ ChiaHub presence: the era 7 listing failed: {e:#} (retry in 5 min)"));
        }
    }

    /// A knock that waited rests the knock arm for the retry cadence, not a
    /// tick (stage 4 design §5.2): the beacon and the rooms keep their ticks.
    #[test]
    fn a_knock_that_waits_is_paced_by_the_retry_cadence() {
        let t0 = Instant::now();
        assert!(knock_paced(None, t0), "no knock waited: the arm runs");
        assert!(!knock_paced(Some(t0), t0), "just waited");
        assert!(!knock_paced(Some(t0), t0 + Duration::from_secs(HEARTBEAT_RETRY_SECS - 1)));
        assert!(knock_paced(Some(t0), t0 + Duration::from_secs(HEARTBEAT_RETRY_SECS)), "the retry cadence has passed");
        assert_eq!(HEARTBEAT_RETRY_SECS, 300);
    }

    /// The knock arm's handling of a failed knock (stage 4 design §5.2), as
    /// the heartbeat applies it to its queue and its pacing: with burner keys
    /// on, a wait goes back in the queue with its attempts as they were and
    /// rests the arm from now; every other failure uses an attempt, goes back
    /// while it has attempts left, is dropped after its last, and leaves the
    /// arm's rest as it was. With burner keys off every failure, waits and
    /// all, is an attempt, exactly as on main.
    #[tokio::test]
    async fn a_failed_knock_waits_in_the_queue_with_burners_on_and_uses_its_attempts_as_on_main_with_them_off() {
        use std::collections::VecDeque;
        let (waits, failures, _) = knock_failures("arm").await;
        let req = |attempts: u8| KnockRequest { room: "r".into(), host: "H".into(), ck_host: [1u8; 32], kx_host: [0u8; 32], attempts };
        let (rested, now) = (Instant::now(), Instant::now() + Duration::from_secs(1));
        let last = MAX_KNOCK_ATTEMPTS - 1;
        let after = |burners: bool, attempts: u8, e: &anyhow::Error, wait: Option<Instant>| {
            let (mut queue, mut wait) = (VecDeque::new(), wait);
            knock_failed(burners, req(attempts), e, now, &mut queue, &mut wait);
            (queue, wait)
        };
        for (what, e) in &waits {
            assert_eq!(after(true, last, e, None), (VecDeque::from([req(last)]), Some(now)), "{what}, burners on: back in the queue, its attempts kept, the arm resting");
            assert_eq!(after(false, 0, e, Some(rested)), (VecDeque::from([req(1)]), Some(rested)), "{what}, burners off: an attempt, as on main");
            assert_eq!(after(false, last, e, None), (VecDeque::new(), None), "{what}, burners off: dropped after its last attempt, as on main");
        }
        for (what, e) in &failures {
            for burners in [true, false] {
                assert_eq!(after(burners, 0, e, Some(rested)), (VecDeque::from([req(1)]), Some(rested)), "{what}, burners {burners}: an attempt");
                assert_eq!(after(burners, last, e, None), (VecDeque::new(), None), "{what}, burners {burners}: dropped after its last attempt");
            }
        }
    }

    /// Stage 4 design §5.2 and §4.1's knock row: a knock withdrawn at spend
    /// time, or one whose own key already wrote this era, is dropped with
    /// one line. It uses no attempt, leaves the arm's rest and the rest of
    /// the queue as they were, and is never queued again, with burner keys
    /// on or off, on its first attempt or its last. Only the one already
    /// written notes its host for the era, and a writer's context around it
    /// still finds it. Neither is a wait. The withdrawn line is the one the
    /// knock arm always printed, word for word, and neither line names more
    /// than the host's shortened node id and the room.
    #[tokio::test]
    async fn a_knock_withdrawn_or_already_written_is_dropped_with_one_line_uses_no_attempt_and_is_never_queued_again() {
        use std::collections::VecDeque;
        let (_, _, drops) = knock_failures("dropped").await;
        assert_eq!(drops.iter().map(|(what, _)| *what).collect::<Vec<_>>(), [WITHDRAWN, ALREADY_KNOCKED]);
        let host = "0123456789abcdef0123";
        let req = |attempts: u8| KnockRequest { room: "r".into(), host: host.into(), ck_host: [1u8; 32], kx_host: [0u8; 32], attempts };
        let other = KnockRequest { room: "s".into(), host: "G".into(), ck_host: [2u8; 32], kx_host: [0u8; 32], attempts: 1 };
        let (rested, now) = (Instant::now(), Instant::now() + Duration::from_secs(1));
        let withdrawn = "⛓️ ChiaHub knock: not knocking on 0123456789abcdef for room r — the room no longer uses cards (the room's word changed while the spend was prepared)";
        let written = "⛓️ ChiaHub knock: not knocking on 0123456789abcdef for room r — a knock on this host for this room already went out this era from its own key, and a knock's key writes once (no attempt used; this host is not knocked on again this era by this run)";
        let wrapped = anyhow::Error::from(super::claim_write::AlreadyKnocked).context("x");
        let rows = [(WITHDRAWN, &drops[0].1, withdrawn, false), (ALREADY_KNOCKED, &drops[1].1, written, true), ("already written, under a context", &wrapped, written, true)];
        for (what, e, line, noted) in rows {
            assert!(!is_typed_wait(e), "{what} is no wait: {e:#}");
            assert_eq!(knock_dropped_line(&req(0), e).as_deref(), Some(line), "{what}");
            for burners in [true, false] {
                for attempts in [0, MAX_KNOCK_ATTEMPTS - 1] {
                    for wait in [None, Some(rested)] {
                        let (mut queue, mut rest, mut found) = (VecDeque::from([other.clone()]), wait, ChainKnocked::default());
                        knock_not_written(burners, req(attempts), e, 4, now, &mut queue, &mut rest, &mut found);
                        let case = format!("{what}, burners {burners}, attempts {attempts}, wait {wait:?}");
                        assert_eq!(queue, VecDeque::from([other.clone()]), "{case}: not queued again, the rest of the queue as it was");
                        assert_eq!(rest, wait, "{case}: the arm's rest as it was");
                        assert_eq!(found.holds(host, 4), noted, "{case}: noted only if already written");
                        assert!(!found.holds(host, 5) && !found.holds("G", 4), "{case}: that host, that era");
                    }
                }
            }
        }
    }

    /// Every other error a knock fails with goes to [`knock_failed`] exactly
    /// as before (stage 4 design §5.2): no drop line, the same queue, with
    /// the same attempts, and the same rest of the arm as `knock_failed`
    /// leaves on its own, waits and failures alike, burner keys on or off,
    /// on a first attempt or a last. No host is noted.
    #[tokio::test]
    async fn every_other_knock_error_goes_to_knock_failed_exactly_as_before() {
        use std::collections::VecDeque;
        let (waits, failures, _) = knock_failures("failed").await;
        let req = |attempts: u8| KnockRequest { room: "r".into(), host: "H".into(), ck_host: [1u8; 32], kx_host: [0u8; 32], attempts };
        let other = KnockRequest { room: "s".into(), host: "G".into(), ck_host: [2u8; 32], kx_host: [0u8; 32], attempts: 1 };
        let (rested, now) = (Instant::now(), Instant::now() + Duration::from_secs(1));
        for (what, e) in waits.iter().chain(&failures) {
            assert_eq!(knock_dropped_line(&req(0), e), None, "{what}: {e:#}");
            for burners in [true, false] {
                for attempts in [0, MAX_KNOCK_ATTEMPTS - 1] {
                    for wait in [None, Some(rested)] {
                        let (mut queue, mut rest, mut found) = (VecDeque::from([other.clone()]), wait, ChainKnocked::default());
                        knock_not_written(burners, req(attempts), e, 4, now, &mut queue, &mut rest, &mut found);
                        let (mut alone, mut alone_rest) = (VecDeque::from([other.clone()]), wait);
                        knock_failed(burners, req(attempts), e, now, &mut alone, &mut alone_rest);
                        let case = format!("{what}, burners {burners}, attempts {attempts}, wait {wait:?}");
                        assert_eq!((queue, rest), (alone, alone_rest), "{case}: as knock_failed leaves it");
                        assert_eq!(found, ChainKnocked::default(), "{case}: no host noted");
                    }
                }
            }
        }
    }

    /// Stage 4 design §8.3, the crash window, for knocks
    /// ([`lost_knock_entry`]): with no write held under the knock's hint
    /// nothing is filed. On the burner path a held write is filed when the
    /// SSF wallet paid for it, when no payer was filed (the SSF wallet's
    /// too), or when this host's own K(h) did, and one another burner paid
    /// for (another host's knock, under a hint the two hosts share) is not:
    /// this host's own knock is written beside it. On the SSF wallet's path
    /// only a burner's is filed, and the wallet's own, or one with no payer
    /// filed, is left to main's rule. On either path this host's own K(h)'s
    /// write is filed before any other under the hint, and on the SSF
    /// wallet's path K(h) is not asked for, so no burner root is made, unless
    /// a burner's write is held. A write held settling is filed as a
    /// parked one is. An entry filed is the write whole, as `sent_knock_of`
    /// files one: the request's host and room, the era and the hint, the
    /// parent as its coin id and the parked input beside it, the digest of
    /// the record, the lease's number for the spend, the payer as the lease
    /// filed it, the time given, and a clock not started.
    #[test]
    fn a_knock_the_lease_holds_under_its_hint_is_filed_again_on_the_burner_path_unless_another_burner_paid_and_on_the_money_path_only_from_a_burner() {
        let req = KnockRequest { room: "r".into(), host: "H".into(), ck_host: [1u8; 32], kx_host: [0u8; 32], attempts: 0 };
        let (hint, now_unix) = (Bytes32::new([5; 32]), 1_700_000_000);
        let wallet = SecretKey::from_seed(&[9; 32]);
        let money = Payer::of(&wallet);
        let root = crate::chia_burner::BurnerRoot::of(&crate::chia_burner::MoneyKey::new(wallet.clone()), crate::chia_network::ChiaNet::Testnet11);
        let knock = Payer::of_burner(&root.knock(&knock_slot(hint, "H"), 4));
        let theirs = Payer::of_burner(&root.knock(&knock_slot(hint, "G"), 4));
        let held = |payer: Option<Payer>, spent_at: Option<u32>| HeldWrite {
            coins: WriteCoins { parent: Bytes32::new([2; 32]), parked: Bytes32::new([3; 32]) },
            spend: 7,
            record: b"a sealed knock".to_vec(),
            payer,
            spent_at,
        };
        let filed = |payer: Option<Payer>| SentKnock {
            host: "H".into(),
            room: "r".into(),
            era: 4,
            hint: hex::encode([5u8; 32]),
            coin_id: hex::encode([2u8; 32]),
            memo: hex::encode(crate::chia_resolve::memo_digest(b"a sealed knock").to_bytes()),
            pushed_at: now_unix,
            confirmed_height: 0,
            last_rendezvous: 0,
            settled: false,
            spend: Some(7),
            parked: hex::encode([3u8; 32]),
            payer: payer.map(|p| p.hex()),
        };
        // This host's own K(h), when the filing may ask for it.
        let own = |may: bool| {
            move || {
                assert!(may, "K(h) asked for, and on the SSF wallet's path a burner root made, with no write it could tell apart held");
                knock
            }
        };
        for burner_path in [true, false] {
            assert_eq!(lost_knock_entry(None, own(false), &money, burner_path, &req, hint, 4, now_unix), None, "nothing held, burner path {burner_path}");
            assert_eq!(lost_knock_entry(Vec::new(), own(false), &money, burner_path, &req, hint, 4, now_unix), None, "nothing held, burner path {burner_path}");
        }
        let rows = [
            (true, Some(money), "the SSF wallet", true),
            (true, None, "no payer filed", true),
            (true, Some(knock), "this host's K(h)", true),
            (true, Some(theirs), "another host's K(h)", false),
            (false, Some(money), "the SSF wallet", false),
            (false, None, "no payer filed", false),
            (false, Some(knock), "a burner", true),
            (false, Some(theirs), "a burner", true),
        ];
        for (burner_path, paid_by, who, files) in rows {
            let may = burner_path || paid_by.is_some_and(|p| p != money);
            for spent_at in [None, Some(12)] {
                let got = lost_knock_entry(Some(held(paid_by, spent_at)), own(may), &money, burner_path, &req, hint, 4, now_unix);
                assert_eq!(got, files.then(|| filed(paid_by)), "burner path {burner_path}, paid by {who}, spent at {spent_at:?}");
            }
        }

        // Several writes under one hint, newest first. On the burner path
        // this host's own is found behind a newer one another host's key
        // paid for (a stop lost the older entry, and the other host's knock
        // went out meanwhile), and is filed before one the SSF wallet paid
        // for; with no own write, the SSF wallet's is found behind another
        // host's. On the SSF wallet's path a burner's is found behind the
        // wallet's own, and this host's own K(h)'s behind another host's
        // (burner keys turned off after a stop that lost its entry), so the
        // entry dials this host at its own knock's height.
        let newer = |payer: Option<Payer>| HeldWrite { spend: 9, coins: WriteCoins { parent: Bytes32::new([8; 32]), parked: Bytes32::new([8; 32]) }, ..held(payer, None) };
        let stack = [
            (true, vec![newer(Some(theirs)), held(Some(knock), None)], Some(knock), "its own, behind another host's"),
            (true, vec![newer(Some(money)), held(Some(knock), None)], Some(knock), "its own, before the SSF wallet's"),
            (true, vec![newer(Some(theirs)), held(Some(money), None)], Some(money), "the SSF wallet's, behind another host's"),
            (true, vec![newer(Some(theirs)), held(None, None)], None, "no payer filed, behind another host's"),
            (false, vec![newer(Some(money)), held(Some(theirs), None)], Some(theirs), "a burner's, behind the SSF wallet's"),
            (false, vec![newer(Some(theirs)), held(Some(knock), None)], Some(knock), "its own, behind another host's"),
            (false, vec![newer(Some(money)), held(Some(knock), None)], Some(knock), "its own, behind the SSF wallet's"),
        ];
        for (burner_path, writes, paid_by, what) in stack {
            let got = lost_knock_entry(writes, own(true), &money, burner_path, &req, hint, 4, now_unix);
            assert_eq!(got, Some(filed(paid_by)), "burner path {burner_path}: {what}");
        }
        for burner_path in [true, false] {
            let others = vec![newer(Some(if burner_path { theirs } else { money })), held(if burner_path { Some(theirs) } else { None }, None)];
            assert_eq!(lost_knock_entry(others, own(burner_path), &money, burner_path, &req, hint, 4, now_unix), None, "none of its own to file, burner path {burner_path}");
        }
    }

    /// The slot a knock's burner key is derived from ([`knock_slot`],
    /// [`knock_burner`]): the inbox hint bound to the host's node id, so two
    /// hosts under one hint have two slots and two keys, one host has the
    /// same slot and key again, and another hint gives another. It is
    /// `blake3::derive_key("ssf-chia-knock-slot-v1", hint ‖ host)`, pinned
    /// here as a vector, and so is the key K the zero-entropy mnemonic's
    /// testnet11 root derives for a knock end to end, from the request to
    /// the key ([`knock_hint`], then the slot): a change to the slot's
    /// context, its order or its encoding of the host moves every knock key.
    #[test]
    fn a_knocks_slot_binds_its_inbox_hint_to_the_hosts_node_id() {
        use crate::chia_burner::{BurnerRoot, MoneyKey};
        let (hint, other_hint) = (Bytes32::new([0x51; 32]), Bytes32::new([0x52; 32]));
        let (a, b) = ("host-a", "host-b");
        assert_eq!(knock_slot(hint, a), knock_slot(hint, a), "one host, one slot");
        assert_ne!(knock_slot(hint, a), knock_slot(hint, b), "two hosts under one hint");
        assert_ne!(knock_slot(hint, a), knock_slot(other_hint, a), "one host under two hints");
        assert_ne!(knock_slot(hint, a), hint.to_bytes(), "not the hint itself");
        let mut message = hint.to_bytes().to_vec();
        message.extend_from_slice(a.as_bytes());
        assert_eq!(knock_slot(hint, a), blake3::derive_key("ssf-chia-knock-slot-v1", &message), "the hint, then the host's text");
        assert_eq!(
            hex::encode(knock_slot(Bytes32::new([0u8; 32]), "H")),
            "caf5704dbd04c8432272aaf7475251c7c82a100cb3ef5f90332f6e40596e7ccf",
            "the pinned slot of the zero hint and the host \"H\""
        );

        let words = bip39::Mnemonic::from_entropy(&[0u8; 32]).expect("32 bytes of entropy make 24 words");
        let money = MoneyKey::new(crate::chia_wallet::keys_from_mnemonic(&words).wallet);
        let root = BurnerRoot::of(&money, crate::chia_network::ChiaNet::Testnet11);
        let net = crate::chia_network::ChiaNet::Testnet11;
        let req = |host: &str| KnockRequest { room: "r".into(), host: host.into(), ck_host: [0x22; 32], kx_host: [0u8; 32], attempts: 0 };
        let (to_a, to_b) = (req(a), req(b));
        let room_key = [0x33; 32];
        assert_eq!(knock_hint(net, &to_a, &room_key, 0), knock_hint(net, &to_b, &room_key, 0), "one contact key, one inbox hint");
        let (k_a, k_b) = (knock_burner(&root, net, &to_a, &room_key, 0), knock_burner(&root, net, &to_b, &room_key, 0));
        assert_ne!(k_a.public_key(), k_b.public_key(), "a key each");
        assert_ne!(k_a.puzzle_hash(), k_b.puzzle_hash());
        assert_eq!(k_a.public_key(), knock_burner(&root, net, &to_a, &room_key, 0).public_key(), "the same key again");
        assert_eq!(k_a.public_key(), root.knock(&knock_slot(knock_hint(net, &to_a, &room_key, 0), a), 0).public_key(), "the root's knock key of the slot");
        assert_ne!(k_a.public_key(), root.knock(&knock_hint(net, &to_a, &room_key, 0).to_bytes(), 0).public_key(), "not the key of the hint alone");
        assert_ne!(k_a.public_key(), knock_burner(&root, net, &to_a, &room_key, 1).public_key(), "another era");
        assert_eq!(
            hex::encode(k_a.public_key().to_bytes()),
            "808ab6289b5951c2969f6c3a08e8d5aced7dd28d84998021fac5120fbfea542ed596e63375bc6280fc78c06db5876f35",
            "the pinned K of the zero mnemonic for host-a, contact key 0x22.., room key 0x33.., era 0, on testnet11"
        );
    }

    /// The line a knock written is said in ([`knock_sent_line`]): with
    /// burner keys off it is the knock arm's line as it always was, word for
    /// word, acknowledged or unanswered, and written from its own burner key
    /// K(h) it is the same line saying so at its end (stage 4 design §4.1,
    /// the knock row). Either way it names the host by its shortened node id
    /// alone and the hint by its first 16 hex digits alone.
    #[test]
    fn a_sent_knocks_line_is_mains_without_burner_keys_and_says_its_own_key_with_them() {
        let host = "0123456789abcdef0123";
        let hint = Bytes32::new(std::array::from_fn(|i| i as u8));
        let mains = [
            (true, "⛓️ ChiaHub knock: knocked on 0123456789abcdef for room r in era 4 · inbox hint 0001020304050607 — both sides dial on the confirmation height"),
            (
                false,
                "⛓️ ChiaHub knock: knock pushed, unanswered (filed as pending; the chain's word settles it) on 0123456789abcdef for room r in era 4 · inbox hint 0001020304050607 — both sides dial on the confirmation height",
            ),
        ];
        for (acked, main) in mains {
            assert_eq!(knock_sent_line(acked, host, "r", 4, hint, false), main, "acked {acked}, burner keys off");
            let from_burner = knock_sent_line(acked, host, "r", 4, hint, true);
            assert_eq!(from_burner, format!("{main} · from its own burner key"), "acked {acked}, from its own burner key");
            for line in [main.to_string(), from_burner] {
                assert!(!line.contains(host), "acked {acked}: the host's node id beyond its first 16 characters: {line}");
                assert!(!line.contains(&hex::encode(&hint.to_bytes()[..9])), "acked {acked}: the hint beyond its first 16 hex digits: {line}");
            }
        }
    }

    /// The line a knock filed again from the lease is said in
    /// ([`lost_knock_line`], stage 4 design §8.3): one line naming the
    /// host's shortened node id, the room and the era, and neither who paid
    /// nor anything of the write's.
    #[test]
    fn a_knock_filed_again_from_the_lease_is_said_in_one_line_that_names_no_payer() {
        let req = KnockRequest { room: "r".into(), host: "0123456789abcdef0123".into(), ck_host: [1u8; 32], kx_host: [0u8; 32], attempts: 0 };
        let line = lost_knock_line(&req, 4);
        assert_eq!(
            line,
            "⛓️ ChiaHub knock: the wallet lease still holds the era 4 knock on 0123456789abcdef for room r, written before a restart that lost its entry — filed again; one inbox hint never has two payers, so nothing new is written under it (no attempt used)"
        );
        assert!(!line.contains('\n'), "one line");
        assert!(!line.contains(&req.host), "the host's node id beyond its first 16 characters");
    }

    /// A host this run found its knock already written to is skipped for
    /// the rest of that era, and only that host and that era: a note in a
    /// new era forgets the one before (stage 4 design §9; RAM only).
    #[test]
    fn a_host_the_chain_shows_knocked_is_skipped_for_the_rest_of_that_era_only() {
        let mut found = ChainKnocked::default();
        assert!(!found.holds("H", 0), "nothing noted");
        found.note("H", 4);
        assert!(found.holds("H", 4));
        assert!(!found.holds("G", 4), "another host");
        assert!(!found.holds("H", 5), "another era");
        assert!(!found.holds("H", 3), "an era before");
        found.note("G", 4);
        assert!(found.holds("H", 4) && found.holds("G", 4), "two hosts in one era");
        found.note("X", 5);
        assert!(found.holds("X", 5));
        assert!(!found.holds("H", 4) && !found.holds("G", 4), "the new era forgot the old one");
        assert!(!found.holds("H", 5), "a host of the old era is not carried into the new one");
    }

    /// The knock arm skips a queued request when the knock book holds a
    /// knock on that host this era, or this run found that host's knock
    /// already written by its own key, in any room (stage 4 design §5.2,
    /// §9). Another host, or another era, is not skipped.
    #[test]
    fn a_queued_knock_is_skipped_for_a_host_the_book_or_this_run_shows_knocked_this_era() {
        let sent = SentKnock {
            host: "B".into(),
            room: "r".into(),
            era: 4,
            hint: "00".into(),
            coin_id: "00".into(),
            memo: String::new(),
            pushed_at: 1,
            confirmed_height: 0,
            last_rendezvous: 0,
            settled: false,
            spend: None,
            parked: String::new(),
            payer: None,
        };
        let empty = KnockBook::default();
        let booked = KnockBook { sent: vec![sent], inbox: vec![] };
        let none = ChainKnocked::default();
        let mut found = ChainKnocked::default();
        found.note("C", 4);
        let rows: [(&str, &KnockBook, &ChainKnocked, &str, u64, bool); 8] = [
            ("nothing known", &empty, &none, "C", 4, false),
            ("the chain's word alone", &empty, &found, "C", 4, true),
            ("the chain's word, another era", &empty, &found, "C", 5, false),
            ("the chain's word, another host", &empty, &found, "D", 4, false),
            ("the book's word alone", &booked, &none, "B", 4, true),
            ("the book's word, another era", &booked, &none, "B", 5, false),
            ("the book's word, another host", &booked, &none, "D", 4, false),
            ("the chain's word beside the book's", &booked, &found, "C", 4, true),
        ];
        for (what, book, chain, host, era, skipped) in rows {
            assert_eq!(knock_skipped(book, chain, host, era), skipped, "{what}: {host} in era {era}");
        }
    }
}

/// The claim-and-write's bundle builder, the rules R1 to R7 it checks over
/// a burner's spends, the writer that pushes it under the gift rules and
/// the fuse, and its self-test on a real test network (stage 4 design §4.1,
/// §4.2, §5.2, §13 row 9).
mod claim_write;
pub(crate) use claim_write::claim_write_selftest;

/// The writers and readers above, end to end through the real lane on the
/// mock chain (stage 4 design §12).
#[cfg(test)]
mod chain_tests;
