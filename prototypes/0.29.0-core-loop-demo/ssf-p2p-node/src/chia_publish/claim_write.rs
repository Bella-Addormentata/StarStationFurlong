//! The claim-and-write's bundle builder (stage 4 design §4.1, §4.2, §13 row
//! 9): one burner's write as one bundle, with the rules R1 to R7 of §4.2
//! checked over its final spends before anything is signed.
//!
//! A burner's first write under its slot spends a lobby dish coin F and the
//! gift g that F's claim makes at the burner, in the same bundle (§4.1, the
//! table's first row). F's remainder goes back to the dish, none when F held
//! exactly the gift; g is created and spent; and the burner's one coin of 1
//! mojo is made with the memos `[hint, body]`. g's id is known before the
//! push, so the write's coin names g as its parent, and the lease parks F,
//! the input the chain lists (§4.4). A later write under the slot spends
//! that 1-mojo coin to itself (the rewrite row). Either way the burner's key
//! signs one AGG_SIG_ME, over the coin it spends; the claim asks for no
//! signature (§5.4); and no fee is paid.
//!
//! This is the second memo builder beside `build_publish_bundle`, which
//! signs with the SSF wallet's keys. It signs with a [`BurnerKey`] alone,
//! never a money key, and has no network check of its own: the rules hold
//! on every network, and which callers reach it, on which network, is their
//! gate (SSF_CHIA_BURNERS on a test network until PR 10, §13 rows 9 and 10).
//! Its tests run on each network for that reason.
//!
//! The writer ([`burner_write_with`], and [`burner_write`] on the node's own
//! lease and chain) picks what a write spends under the gift rules of §5.2:
//! the burner's own coin when it holds one, and otherwise a gift from the
//! lobby dish, never a second while a bundle for the key is held, and never
//! past the node's fuse for the era ([`GiftFuse`]). Waiting is not failing:
//! each reason to wait comes back typed ([`BurnerWait`]).
//!
//! Until PR 10 the writer's one caller outside the tests is
//! [`claim_write_selftest`], the hook that makes one real claim-and-write on
//! a test network and reads it back through its ephemeral parent
//! (SSF_CHIA_CLAIM_WRITE_TEST=1 with SSF_CHIA_BURNERS=1).

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Result};
use chia_protocol::{Bytes, Bytes32, Coin, CoinSpend, Program, SpendBundle};
use chia_puzzle_types::DeriveSynthetic;
use chia_sdk_driver::{SpendContext, StandardLayer};
use chia_sdk_types::Conditions;
use clvm_traits::{FromClvm, ToClvm};
use clvm_utils::{tree_hash, CurriedProgram};
use clvmr::{Allocator, NodePtr};
use serde::{Deserialize, Serialize};

use super::{push_parked_with, MemoWrite, ParkedInput, Payer, PushError, WalletLease, WALLET_LEASE};
use crate::chia_burner::BurnerKey;
use crate::chia_chain::{ChainAccess, PuzzleAndSolution};
use crate::chia_faucet::{claim_to, unspent_at, ClaimToError, CoinLookupFailed, DishClaim, FaucetCoin, FaucetParams, Unspent, FAUCET_MOD_HASH, GIFT_MOJOS, MAX_FAUCET_PAGES};
use crate::chia_network::ChiaNet;
use crate::chia_resolve::{created_coins, memo_digest, CreatedCoin, WriteCoins};

/// A rule of stage 4 design §4.2 that a burner bundle breaks, as
/// [`check_burner_spends`] refuses it. Its text is the rule's own sentence;
/// each variant's doc says what the check finds when the rule is broken. A
/// refusal of the builder comes back as this type inside the `anyhow`
/// error, so a caller tells it from a failed chain read by downcasting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BurnerRule {
    /// The bundle's burner inputs, its coins at the burner's puzzle hash,
    /// number other than one.
    R1,
    /// An input is neither the burner's nor a dish's: a money coin, or any
    /// other coin.
    R2,
    /// An output is at a puzzle hash other than the burner's, other than a
    /// dish spend's remainder back to its own dish: a gift claimed to
    /// someone else, or a burner paying another address.
    R3,
    /// More than one dish coin is spent.
    R4,
    /// The burner's spend makes anything but one CREATE_COIN of 1 mojo at its
    /// own puzzle hash, or the bundle's outputs do not add up to its inputs
    /// (a fee, or a spend whose outputs cannot be read).
    R5,
    /// A dish coin other than the lobby dish of the bundle's network is
    /// spent: a room's own dish, or another network's lobby.
    R6,
    /// The burner's coin holds any amount but 1 mojo: a stray, which is
    /// never written from.
    R7,
}

impl fmt::Display for BurnerRule {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (rule, sentence) = match self {
            BurnerRule::R1 => ("R1", "a burner bundle has one burner input, and the lobby dish coin is the only other input allowed"),
            BurnerRule::R2 => ("R2", "no bundle that carries a memo includes a money coin"),
            BurnerRule::R3 => ("R3", "no burner pays another burner"),
            BurnerRule::R4 => ("R4", "a bundle funds at most one burner"),
            BurnerRule::R5 => ("R5", "a burner only pays itself: 1 mojo, fee 0"),
            BurnerRule::R6 => ("R6", "only the lobby dish funds a burner, never a private room's dish"),
            BurnerRule::R7 => ("R7", "a burner writes only from a 1-mojo coin"),
        };
        write!(f, "burner rule {rule} (stage 4 design §4.2): {sentence}")
    }
}

impl std::error::Error for BurnerRule {}

/// What an input of a burner bundle is, by its coin and its puzzle reveal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputKind {
    /// A coin at the burner's puzzle hash.
    Burner,
    /// A coin at the lobby dish of the bundle's network.
    Lobby,
    /// A coin whose puzzle is the faucet dish's module curried for another
    /// dish: a room's own, or another network's lobby.
    OtherDish,
    /// Anything else: a money coin, another burner's coin, a stranger's.
    Foreign,
}

impl InputKind {
    fn of(spend: &CoinSpend, burner_ph: Bytes32, lobby_ph: Bytes32) -> InputKind {
        if spend.coin.puzzle_hash == burner_ph {
            InputKind::Burner
        } else if spend.coin.puzzle_hash == lobby_ph {
            InputKind::Lobby
        } else if is_dish_puzzle(&spend.puzzle_reveal) {
            InputKind::OtherDish
        } else {
            InputKind::Foreign
        }
    }

    fn is_dish(self) -> bool {
        matches!(self, InputKind::Lobby | InputKind::OtherDish)
    }
}

/// Whether `reveal` is the faucet dish's module with some dish's arguments
/// curried in: it uncurries, and the tree hash of the module it uncurries to
/// is [`FAUCET_MOD_HASH`]. Every dish, of every room and network, has that
/// module, so this finds a dish the lobby's puzzle hash does not match.
fn is_dish_puzzle(reveal: &Program) -> bool {
    let mut a = Allocator::new();
    let Ok(node) = reveal.to_clvm(&mut a) else { return false };
    CurriedProgram::<NodePtr, NodePtr>::from_clvm(&a, node).is_ok_and(|curried| tree_hash(&a, curried.program) == FAUCET_MOD_HASH)
}

/// Every rule of stage 4 design §4.2 that `spends` break, for a bundle of
/// the burner at `burner_ph` on `net`, in the order [`check_burner_spends`]
/// names them: R2, R6 and R4 (what may be spent at all), R1 and R7 (the
/// burner's one coin), then R3 and R5 (where the money goes). Each rule is
/// judged on its own, so a bundle that breaks one rule because it breaks
/// another (a 2-mojo burner coin can only be spent at a fee, R7 and R5)
/// lists both, the cause first. Each spend is run as the readers run it
/// ([`created_coins`]); one that does not run has outputs nobody can vouch
/// for, so it breaks R3, and R5's sum with it.
fn broken_rules(net: ChiaNet, burner_ph: Bytes32, spends: &[CoinSpend]) -> Vec<BurnerRule> {
    let lobby_ph = FaucetParams::lobby(net).puzzle_hash();
    let inputs: Vec<(InputKind, &CoinSpend, Option<Vec<CreatedCoin>>)> = spends
        .iter()
        .map(|spend| {
            let run = PuzzleAndSolution { puzzle_reveal: spend.puzzle_reveal.clone(), solution: spend.solution.clone() };
            (InputKind::of(spend, burner_ph, lobby_ph), spend, created_coins(&run).ok())
        })
        .collect();
    let burners: Vec<_> = inputs.iter().filter(|(kind, ..)| *kind == InputKind::Burner).collect();
    let dishes = inputs.iter().filter(|(kind, ..)| kind.is_dish()).count();

    // R3: each output is at the burner, or a dish's remainder back to the
    // dish it came from.
    let pays_no_one_else = inputs.iter().all(|(kind, spend, outputs)| {
        outputs.as_ref().is_some_and(|outputs| {
            outputs.iter().all(|out| out.puzzle_hash == burner_ph || (kind.is_dish() && out.puzzle_hash == spend.coin.puzzle_hash))
        })
    });
    // R5: the burner's spend makes its one 1-mojo coin and nothing else, and
    // no amount is left over as a fee. Both sums are of u64 amounts in a
    // u128, which no bundle's number of spends can overflow; a spend whose
    // outputs cannot be read leaves the outputs' sum unknown.
    let pays_itself = burners.iter().all(|(_, _, outputs)| {
        matches!(outputs.as_deref(), Some([only]) if only.puzzle_hash == burner_ph && only.amount == 1)
    });
    let spent: u128 = inputs.iter().map(|(_, spend, _)| u128::from(spend.coin.amount)).sum();
    let made: Option<u128> = inputs
        .iter()
        .map(|(_, _, outputs)| outputs.as_ref().map(|outputs| outputs.iter().map(|out| u128::from(out.amount)).sum::<u128>()))
        .sum();

    [
        (BurnerRule::R2, inputs.iter().all(|(kind, ..)| *kind != InputKind::Foreign)),
        (BurnerRule::R6, inputs.iter().all(|(kind, ..)| *kind != InputKind::OtherDish)),
        (BurnerRule::R4, dishes <= 1),
        (BurnerRule::R1, burners.len() == 1),
        (BurnerRule::R7, burners.iter().all(|(_, spend, _)| spend.coin.amount == 1)),
        (BurnerRule::R3, pays_no_one_else),
        (BurnerRule::R5, pays_itself && made == Some(spent)),
    ]
    .into_iter()
    .filter_map(|(rule, holds)| (!holds).then_some(rule))
    .collect()
}

/// The rules of stage 4 design §4.2 over a burner bundle's final spends,
/// unsigned, for the burner at `burner_ph` on `net`: `Err` with the first
/// rule `spends` break, in the order R2, R6, R4, R1, R7, R3, R5, so a rule
/// broken only because an earlier one is (a stray amount leaves a fee) is
/// refused under its cause. Each input is the burner's (its coin at
/// `burner_ph`), the lobby dish's (at `FaucetParams::lobby(net)`), another
/// dish's (its puzzle reveal uncurries to the dish module), or foreign.
/// Every network's rules are the same, the lobby aside: the check has no
/// network refusal of its own.
pub fn check_burner_spends(net: ChiaNet, burner_ph: Bytes32, spends: &[CoinSpend]) -> Result<(), BurnerRule> {
    match broken_rules(net, burner_ph, spends).first() {
        Some(rule) => Err(*rule),
        None => Ok(()),
    }
}

/// What a burner writes from (stage 4 design §4.1): the claim of a lobby
/// dish coin F to the burner, whose gift g the write spends in the same
/// bundle (the first write under a slot), or the burner's own coin of 1 mojo
/// with the height it was seen confirmed at (a rewrite).
#[allow(clippy::large_enum_variant)] // one per write, passed by reference, so its size costs nothing
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BurnerInput {
    Claim(DishClaim),
    Own(FaucetCoin),
}

impl BurnerInput {
    /// The coin the write's own coin names as its parent: g for a claim, the
    /// burner's coin for a rewrite. Both ids are known before the push, so a
    /// knock seals this one as its carrier's parent (§4.1, the knock row).
    pub fn parent(&self) -> Bytes32 {
        self.spent().coin_id()
    }

    /// The coin the burner's own spend consumes: g, or its coin.
    fn spent(&self) -> Coin {
        match self {
            BurnerInput::Claim(claim) => claim.gift,
            BurnerInput::Own(own) => own.coin,
        }
    }

    /// The input the lease parks for the write, with the height its coin was
    /// seen confirmed at: F for a claim, the burner's coin for a rewrite.
    /// Never g: the lease asks the peers whether a parked spend is still
    /// live, and pushes it again, only while the chain lists every input it
    /// parked as unspent (`mempool_probes`), and g, made and spent in one
    /// block, is never listed so.
    fn parked(&self) -> ParkedInput {
        let on_chain = match self {
            BurnerInput::Claim(claim) => &claim.dish,
            BurnerInput::Own(own) => own,
        };
        ParkedInput::from((on_chain.coin.coin_id(), on_chain.confirmed_height))
    }
}

/// A burner's write, built and signed, and not pushed
/// ([`build_burner_bundle`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BurnerBundle {
    /// The signed bundle: F's claim and g's spend for a first write, in that
    /// order, or the one spend of the burner's coin for a rewrite.
    pub bundle: SpendBundle,
    /// The digest of the memo the write carries
    /// ([`crate::chia_resolve::memo_digest`] of its body), which its verdict
    /// asks of the coin it finds under the hint.
    pub memo: Bytes32,
    /// The coins it is found and judged by (§4.4): `parent` g and `parked` F
    /// for a first write, the burner's coin as both for a rewrite.
    pub coins: WriteCoins,
    /// What the lease parks for it: `coins.parked`, with its height.
    pub parked: ParkedInput,
    /// g, for a first write: the gift F's claim makes and the burner spends.
    pub gift: Option<Coin>,
    /// The burner's new coin of 1 mojo, which carries `[hint, body]`.
    pub written: Coin,
}

/// The burner's unsigned spends of `input` carrying `[hint, body]`: F's claim
/// as it was built, then the burner's standard spend of g, for a first write;
/// the burner's spend of its coin alone for a rewrite. The burner's spend
/// makes one coin of 1 mojo at its own puzzle hash with the memos as
/// `build_publish_bundle` lays them out (a proper two-element list), so the
/// readers open it and its memo digest is the one they take.
fn burner_spends(key: &BurnerKey, input: &BurnerInput, hint: Bytes32, body: Bytes) -> Result<Vec<CoinSpend>> {
    let mut ctx = SpendContext::new();
    let memos = ctx.memos(&(hint, (body, ()))).map_err(|e| anyhow!("alloc memos: {e:?}"))?;
    StandardLayer::new(key.public_key().derive_synthetic())
        .spend(&mut ctx, input.spent(), Conditions::new().create_coin(key.puzzle_hash(), 1, memos))
        .map_err(|e| anyhow!("standard-layer spend: {e:?}"))?;
    let own = ctx.take();
    Ok(match input {
        BurnerInput::Claim(claim) => std::iter::once(claim.spend.clone()).chain(own).collect(),
        BurnerInput::Own(_) => own,
    })
}

/// The bundle of `key`'s write of `body` under `hint` from `input`, on `net`
/// (stage 4 design §4.1): two spends, F's claim and g's, for a first write,
/// or one, the burner's coin's, for a rewrite; one signature, the burner's
/// AGG_SIG_ME over the coin it spends; no fee. The rules of §4.2 are checked
/// over the final spends before anything is signed ([`check_burner_spends`]),
/// and a broken one comes back as a [`BurnerRule`] inside the error. It never
/// asks `refuse_money_memo`, whose refusal is of the SSF wallet's keys, and
/// has no network refusal of its own: its callers' gate is the flag
/// (module doc).
pub fn build_burner_bundle(net: ChiaNet, key: &BurnerKey, input: &BurnerInput, hint: Bytes32, body: Vec<u8>) -> Result<BurnerBundle> {
    let burner_ph = key.puzzle_hash();
    let memo = memo_digest(&body);
    let spends = burner_spends(key, input, hint, Bytes::new(body))?;
    check_burner_spends(net, burner_ph, &spends)?;
    let bundle = key.sign_spends(net, spends)?;
    let parked = input.parked();
    let parent = input.parent();
    Ok(BurnerBundle {
        bundle,
        memo,
        coins: WriteCoins { parent, parked: parked.coin_id },
        parked,
        gift: match input {
            BurnerInput::Claim(claim) => Some(claim.gift),
            BurnerInput::Own(_) => None,
        },
        written: Coin::new(parent, burner_ph, 1),
    })
}

/// Why a burner's write did not go out this time although nothing went
/// wrong (stage 4 design §5.2, §10): the writer waits, and tries again on
/// its retry cadence. None of these is a refusal or a failed read, and none
/// is a knock attempt (§5.2), so a caller tells them from a failure by
/// downcasting the error to this type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BurnerWait {
    /// A spend the burner pays for is parked, its push in flight or in a
    /// mempool: a second write beside it would put two records of one payer
    /// on the chain (§4.4). The spend is known by the payer the lease filed
    /// for it, or by the burner's puzzle hash: its saved bundle spends a coin
    /// there, or the coin it parks is the burner's.
    Held,
    /// The burner holds no coin and the lease still holds a bundle it paid
    /// for, settling: the coin that bundle spent is listed spent, by our
    /// bundle or by another spend at the same height (a stranger's claim of
    /// the dish coin, §5.4), and a reorganization could bring our bundle
    /// back, so a gift now could be the key's second (§5.2, §10). The bundle
    /// is known by its payer or by a spend of it at the burner's puzzle hash;
    /// a 1-mojo coin of the burner's that the lease holds settling waits too.
    Settling,
    /// The burner holds no coin the listing showed, and the listing of its
    /// puzzle hash was cut short, so it cannot tell that it holds none: a
    /// gift could be its second (fail closed).
    ListingCutShort,
    /// No peer answered the peak, so no lobby coin can be judged ready.
    PeakUnavailable,
    /// No lobby coin is ready that the lease does not hold: a dry or griefed
    /// dish (§10).
    NoCoinReady,
    /// The fuse is blown: the lobby dish gave this node's burners
    /// [`MAX_GIFTS_PER_ERA`] gifts in `era`, the era the fuse counted them
    /// in ([`GiftFuse::allows`]).
    FuseBlown { era: u64 },
}

impl fmt::Display for BurnerWait {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BurnerWait::Held => f.write_str("a spend this burner pays for is still in flight; its next write waits for the chain's verdict"),
            BurnerWait::Settling => {
                f.write_str("this burner's last bundle is still settling and the burner holds no coin, so it is not funded again until the chain settles it")
            }
            BurnerWait::ListingCutShort => f.write_str("the burner's coin listing was cut short, so it cannot tell that the burner holds no coin"),
            BurnerWait::PeakUnavailable => f.write_str("chain peak unavailable (peers unreachable?)"),
            BurnerWait::NoCoinReady => f.write_str("no mojo in the lobby dish right now; it refills on the block clock"),
            BurnerWait::FuseBlown { era } => write!(
                f,
                "{MAX_GIFTS_PER_ERA} gifts from the lobby dish in era {era}; no burner is funded again before era {}",
                era.saturating_add(1)
            ),
        }
    }
}

impl std::error::Error for BurnerWait {}

/// The most gifts the lobby dish gives this node's burners in one era
/// (stage 4 design §5.2): one listing, the hosts knocked, a first beacon,
/// and losses.
pub const MAX_GIFTS_PER_ERA: u32 = 16;

/// Where the fuse is kept, per network ([`ChiaNet::path`]), 0600 like every
/// node file.
pub const GIFT_FUSE_FILE: &str = "gift_fuse.json";

/// The fuse as its file keeps it: the era its gifts were counted in, and one
/// entry per gift counted, the payer's puzzle hash in hex ([`Payer::hex`]).
#[derive(Serialize, Deserialize)]
struct FuseFile {
    era: u64,
    payers: Vec<String>,
}

/// The fuse on the lobby dish's gifts to this node's burners (stage 4
/// design §5.2): at most [`MAX_GIFTS_PER_ERA`] landed gifts per node per
/// era, so a bug, or a cloned data folder, cannot drain the dish through us.
/// Past it the node funds no burner before the next era, and says so once.
///
/// A gift is known to have landed only by the chain's verdict, SETTLED_DEPTH
/// deep. So the fuse counts a gift when its bundle leaves (the push
/// acknowledged or unanswered, [`burner_write_with`]), one entry for the
/// payer it funds, and gives the entry back only on the chain's word that
/// the bundle died: a later write for that payer finds the burner holding
/// no coin, the lease holding no bundle of its, and the burner's puzzle hash
/// never holding a coin of the gift's 1 mojo, spent ones included
/// ([`never_held_a_coin`], [`GiftFuse::refund`]). A gift that landed made
/// two such coins there, g and the burner's coin, whose records stay, so its
/// entry is never given back, even once that coin is spent somewhere other
/// than our lease (a cloned folder or a stolen W, §10) or a listing of
/// unspent coins misses it. Counted at the push, a gift is over-counted
/// while its bundle is in flight, and for good when a coin of 1 mojo has
/// been at its burner other than by a gift: a stray of exactly 1 mojo,
/// which the burner writes from (R7), or a beacon key's coin of an earlier
/// era. That fails closed. A stray of any other amount is never written
/// from and proves nothing, so it keeps no dead gift counted, however many
/// pages of them the listing must follow, up to [`MAX_FAUCET_PAGES`]: anyone
/// can pay one to a burner's puzzle hash, and if it kept the count, a peer
/// we push to, which can redirect our keyless claim for free (§5.4), could
/// fill the fuse with gifts that never landed. Strays past that many pages
/// cut the listing short, which keeps the count, fail closed; filling them
/// costs a stranger a spend per stray. It is under-counted only
/// where the lease let a bundle go as dead that lands after all, or the
/// fuse's file could not be saved (logged). Given back, a lost race or a
/// redirected claim delays a listing but never ends the era's funding
/// (§5.2): a stranger's stray keeps a dead gift counted only when it is of
/// 1 mojo, and then the burner writes from it and needs no gift.
///
/// It is kept per network in [`GIFT_FUSE_FILE`] and saved at every count and
/// refund, so a node restarting in a loop cannot draw a fresh fuse at each
/// start. A missing or malformed file, or one in an older format (no
/// `payers`), starts a fresh fuse, as the beacon's mark does
/// (`BeaconMark::load`). It resets only at a later era: an earlier era than
/// the one it counted (a clock set back) reads the stored count, fail
/// closed.
#[derive(Debug)]
pub struct GiftFuse {
    /// The era the gifts in `payers` were counted in.
    era: u64,
    /// One entry per gift counted in `era`: the hex of the payer it funded.
    payers: Vec<String>,
    /// The era whose blown fuse was last logged, so the line is said once
    /// per era in a run.
    said: Option<u64>,
    /// Where it is saved; `None` keeps it in memory alone.
    path: Option<PathBuf>,
}

impl GiftFuse {
    /// A fresh fuse kept in memory alone, saved nowhere: the tests' own.
    #[cfg(test)]
    pub(super) fn new() -> GiftFuse {
        GiftFuse { era: 0, payers: Vec::new(), said: None, path: None }
    }

    /// A fuse in memory alone that has counted a gift to each of `payers` in
    /// `era`, for the tests that start from a used or blown fuse.
    #[cfg(test)]
    pub(super) fn preset(era: u64, payers: impl IntoIterator<Item = Payer>) -> GiftFuse {
        GiftFuse { era, payers: payers.into_iter().map(|payer| payer.hex()).collect(), said: None, path: None }
    }

    /// The fuse saved at `path`, which every later count and refund saves to.
    /// A missing, unreadable or malformed file, an older format among them,
    /// gives a fresh fuse.
    pub fn load(path: &Path) -> GiftFuse {
        let file = std::fs::read(path).ok().and_then(|bytes| {
            let _ = crate::chia_contact::tighten_private(path); // 0600 like every node file
            serde_json::from_slice::<FuseFile>(&bytes).ok()
        });
        let (era, payers) = file.map_or((0, Vec::new()), |f| (f.era, f.payers));
        GiftFuse { era, payers, said: None, path: Some(path.to_path_buf()) }
    }

    /// The gifts counted that weigh on `era`: none for an era past the one
    /// the fuse counted, the stored count for that era or any earlier one.
    pub(super) fn gifts_in(&self, era: u64) -> u32 {
        if era > self.era {
            0
        } else {
            u32::try_from(self.payers.len()).unwrap_or(u32::MAX)
        }
    }

    /// Start the count again at `era` if it is past the one counted.
    fn roll(&mut self, era: u64) {
        if era > self.era {
            self.era = era;
            self.payers.clear();
        }
    }

    /// May a burner be funded in `era`? [`BurnerWait::FuseBlown`] once
    /// [`MAX_GIFTS_PER_ERA`] gifts weigh on it, the era named the one they
    /// were counted in; the first refusal for that era logs why.
    pub fn allows(&mut self, era: u64) -> Result<(), BurnerWait> {
        self.roll(era);
        if self.gifts_in(era) < MAX_GIFTS_PER_ERA {
            return Ok(());
        }
        if let Some(line) = self.say_blown() {
            eprintln!("{line}");
        }
        Err(BurnerWait::FuseBlown { era: self.era })
    }

    /// The line a blown fuse logs, the first time it is asked in its era;
    /// `None` after that.
    fn say_blown(&mut self) -> Option<String> {
        if self.said == Some(self.era) {
            return None;
        }
        self.said = Some(self.era);
        Some(format!(
            "⛓️ ChiaHub burners: {MAX_GIFTS_PER_ERA} gifts from the lobby dish this era; no burner is funded again before era {}",
            self.era.saturating_add(1)
        ))
    }

    /// Has a gift to `payer` been counted that weighs on `era`? What the
    /// writer asks before it asks the chain whether the gift landed
    /// ([`never_held_a_coin`]), so a burner the fuse holds nothing for costs
    /// no lookup. A later era holds none, as it has nothing to give back.
    pub(super) fn holds(&self, era: u64, payer: Payer) -> bool {
        era <= self.era && self.payers.contains(&payer.hex())
    }

    /// Count a gift to `payer` in `era`, its bundle gone to the peers, and
    /// save. A save that fails is logged, and the count holds in memory.
    pub fn count(&mut self, era: u64, payer: Payer) {
        self.roll(era);
        self.payers.push(payer.hex());
        self.save_or_log();
    }

    /// Give back one gift counted to `payer`, its bundle seen to have died
    /// (the burner holds no coin, the lease no bundle of its, and the chain
    /// no coin of 1 mojo it ever held: [`never_held_a_coin`]), and save:
    /// `true` if the fuse held one. A later era has nothing to give back.
    pub fn refund(&mut self, era: u64, payer: Payer) -> bool {
        self.roll(era);
        let hex = payer.hex();
        let Some(at) = self.payers.iter().position(|counted| *counted == hex) else { return false };
        self.payers.remove(at);
        self.save_or_log();
        true
    }

    /// Save the fuse to its file, if it has one, as `BeaconMark::save` does
    /// (`write_private`, 0600 and atomic); a failure is logged.
    fn save_or_log(&self) {
        let Some(path) = &self.path else { return };
        let file = FuseFile { era: self.era, payers: self.payers.clone() };
        let saved = serde_json::to_vec_pretty(&file)
            .map_err(std::io::Error::other)
            .and_then(|bytes| crate::chia_contact::write_private(path, &bytes));
        if let Err(e) = saved {
            eprintln!(
                "⛓️ ChiaHub burners: the gift fuse could not be saved to {} ({e}); it holds in memory until the node stops",
                path.display()
            );
        }
    }
}

/// The node's fuse ([`GiftFuse`]), loaded from its network's
/// [`GIFT_FUSE_FILE`] the first time a burner write asks it. Production
/// only: the tests bring a fuse of their own, since the network is the
/// process's.
pub static GIFT_FUSE: LazyLock<Mutex<GiftFuse>> = LazyLock::new(|| Mutex::new(GiftFuse::load(&crate::chia_network::net().path(GIFT_FUSE_FILE))));

/// Does the chain show that the burner at `burner_ph` never held a coin of
/// the gift's amount? Its listing, spent coins included, is whole and holds
/// no record of [`GIFT_MOJOS`], 1 mojo. It is the fuse's positive evidence
/// that a counted gift's bundle died (stage 4 design §5.2): a gift that
/// landed made g and the burner's coin there, both of 1 mojo, and their
/// records stay, spent or not, whatever became of the coin since, while a
/// bundle that died made nothing. It is asked only once the lease has let
/// the bundle go, on the chain's word, so the listing is judged past the
/// block that would have made them.
///
/// Only records of 1 mojo are judged. A coin of any other amount at the
/// burner is a stray that anyone can pay to its puzzle hash (§5.4), and the
/// burner never writes from it (R7), so it proves nothing about the gift.
/// Judged, it would keep every dead gift to that burner counted, and a peer
/// that redirects our keyless claims for free (§5.4) could blow the fuse
/// with gifts that never landed, though a lost race or a redirected claim
/// must never end the era's funding (§5.2). A record of 1 mojo keeps the
/// gift counted whoever paid it, fail closed. The writer asks this only
/// when the burner holds no unspent 1-mojo coin (one the lease does not
/// hold is written from, and one it holds makes the write wait), and only
/// the burner's key can spend a coin there. So a 1-mojo record is a landed
/// gift's, a coin the burner wrote from (a stray of exactly 1 mojo among
/// them), or one another holder of its key spent (§10). A 1-mojo coin that
/// lands between the writer's two listings keeps a dead gift counted once,
/// which fails closed too.
///
/// The listing is followed page by page, as [`unspent_at`] follows it, up to
/// [`MAX_FAUCET_PAGES`], and stops at the first record of 1 mojo. So strays
/// of other amounts that fill a page, or a peer that answers in short pages,
/// do not keep a dead gift counted. A listing still cut short past that
/// budget, or cut short with no cursor to follow, is `false`, since the
/// gift's records could lie past the cut: the gift is kept counted, fail
/// closed. A page the chain did not give is [`CoinLookupFailed`], a wait, so
/// the write is tried again rather than funded with the question open.
async fn never_held_a_coin(client: &impl ChainAccess, burner_ph: Bytes32) -> Result<bool> {
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_FAUCET_PAGES {
        let listing = client.coin_records_by_puzzle_hash(burner_ph, true, cursor.take()).await.map_err(CoinLookupFailed)?;
        if listing.records.iter().any(|r| r.coin.amount == GIFT_MOJOS) {
            return Ok(false);
        }
        match listing.next_cursor {
            Some(next) if listing.truncated => cursor = Some(next),
            _ => return Ok(!listing.truncated),
        }
    }
    Ok(false)
}

/// `key`'s write of `body` under `hint` in `era` (stage 4 design §4.1,
/// §5.2), against a given lease, fuse, network, chain, instant and random
/// source: the node's own in production ([`burner_write`]), the tests' own
/// on the mock chain. Under the lease's gate, after a reconciliation:
///
/// - A spend the burner pays for still parked is [`BurnerWait::Held`]: one
///   write in flight per payer (§4.4, [`WalletLease::outgoing_pending_for`]).
///   Since a payer the lease filed can be lost (a rollback, §8 (6)), it is
///   asked of the burner's puzzle hash as well, which no record loses: a
///   parked bundle that spends a coin there ([`WalletLease::parks_spend_at`]),
///   or a 1-mojo coin there the lease parks, is `Held` too.
/// - A coin of exactly 1 mojo at the burner that the lease does not hold is
///   written from, the oldest first (the table's rewrite row). A coin of any
///   other amount is a stray and is never written from (R7).
/// - Holding none, the burner is funded by the claim of a random ready lobby
///   coin in the same bundle as the write (§5.1), under the gift rules
///   (§5.2): not while its listing was cut short
///   ([`BurnerWait::ListingCutShort`]), not while the lease holds a bundle
///   for it, parked or settling, by its payer or by its puzzle hash, or a
///   1-mojo coin of its ([`BurnerWait::Settling`], [`WalletLease::holds_for`],
///   [`WalletLease::holds_spend_at`]), and not past the fuse
///   ([`BurnerWait::FuseBlown`]). A gift the fuse counted for the burner is
///   given back first if the chain shows the burner never held a coin of
///   the gift's 1 mojo, so its bundle died ([`never_held_a_coin`],
///   [`GiftFuse::refund`]); one that landed stays counted, and a stray of
///   another amount there changes neither. The coin is one the lease does
///   not hold and the TAKE marker does not name
///   ([`WalletLease::is_incoming_marker`]); a dry dish or an unanswered peak
///   is [`BurnerWait::NoCoinReady`] or [`BurnerWait::PeakUnavailable`].
///
/// `body` gets the id of the coin the write's own coin will name as its
/// parent, g for a first write and the burner's coin for a rewrite, so a
/// knock seals to it. With a `gate`, `body` runs and the bundle is pushed
/// under it, as `publish_memo_with` does. The bundle is built and checked
/// against R1 to R7 ([`build_burner_bundle`]; a broken rule is the
/// [`BurnerRule`] inside the error) and pushed with its on-chain input parked
/// under the burner as its payer ([`Payer::of_burner`]): F for a first
/// write, never g. The [`MemoWrite`] names that payer, for a first write and
/// a rewrite alike. An acknowledged or an unanswered push is a write, `acked`
/// true or false, as in `publish_memo_with`, and a first write's gift is
/// counted in the fuse; a refused one, or one the lease would not park, is
/// the [`PushError`] inside the error, and counts nothing.
///
/// The fuse is a std mutex, locked only for one statement at a time and
/// never across an await, so the future is `Send` and a spawned task can run
/// it.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn burner_write_with<R: rand::Rng + ?Sized + Send>(
    lease: &WalletLease,
    fuse: &Mutex<GiftFuse>,
    net: ChiaNet,
    client: &impl ChainAccess,
    now: Instant,
    key: &BurnerKey,
    era: u64,
    hint: Bytes32,
    gate: Option<&tokio::sync::Mutex<()>>,
    body: impl FnOnce(Bytes32) -> Result<Vec<u8>>,
    rng: &mut R,
    what: &str,
) -> Result<MemoWrite> {
    let _lease = lease.lock().await;
    lease.ensure_open()?;
    lease.reconcile_at(net, client, now).await;
    let payer = Payer::of_burner(key);
    let burner_ph = key.puzzle_hash();
    if lease.outgoing_pending_for(payer) || lease.parks_spend_at(burner_ph) {
        return Err(BurnerWait::Held.into());
    }
    let Unspent { coins, partial } = unspent_at(client, burner_ph).await?;
    let ones: Vec<FaucetCoin> = coins.into_iter().filter(|c| c.coin.amount == 1).collect();
    if ones.iter().any(|c| lease.is_parked(&c.coin.coin_id())) {
        return Err(BurnerWait::Held.into());
    }
    let own = ones.iter().filter(|c| !lease.is_taken(&c.coin.coin_id())).min_by_key(|c| (c.confirmed_height, c.coin.coin_id())).cloned();
    let input = match own {
        Some(own) => BurnerInput::Own(own),
        None => {
            if partial {
                return Err(BurnerWait::ListingCutShort.into());
            }
            // Every 1-mojo coin listed here is one the lease holds settling.
            // A settling spend keeps its bundle, which spends that coin at
            // the burner, so `holds_spend_at` already waits on it: the
            // `ones` arm is a second guard, kept as one.
            if !ones.is_empty() || lease.holds_for(payer) || lease.holds_spend_at(burner_ph) {
                return Err(BurnerWait::Settling.into());
            }
            let counted = fuse.lock().unwrap().holds(era, payer);
            if counted {
                if !never_held_a_coin(client, burner_ph).await? {
                    eprintln!("⛓️ ChiaHub {what}: the burner held a 1-mojo coin before, or its listing was cut short, so the fuse keeps its gift counted");
                } else if fuse.lock().unwrap().refund(era, payer) {
                    eprintln!("⛓️ ChiaHub {what}: the burner's last bundle died before it landed, so its gift goes back to the fuse");
                }
            }
            fuse.lock().unwrap().allows(era)?;
            let taken = |id: &Bytes32| lease.is_taken(id) || lease.is_incoming_marker(id);
            match claim_to(net, client, burner_ph, taken, rng).await {
                Ok(claim) => BurnerInput::Claim(claim),
                Err(e) => {
                    return Err(match e.downcast_ref::<ClaimToError>() {
                        Some(ClaimToError::NoCoinReady) => BurnerWait::NoCoinReady.into(),
                        Some(ClaimToError::PeakUnavailable) => BurnerWait::PeakUnavailable.into(),
                        _ => e,
                    })
                }
            }
        }
    };
    let _gate = match gate {
        Some(gate) => Some(gate.lock().await),
        None => None,
    };
    let built = build_burner_bundle(net, key, &input, hint, body(input.parent())?)?;
    let acked = match push_parked_with(lease, client, payer, built.bundle, [built.parked]).await {
        Ok(()) => true,
        // Indeterminate, not failed: the bundle may be in a mempool and its
        // input is parked, so it is a write, and its gift is counted.
        Err(PushError::Unanswered(e)) => {
            eprintln!("⛓️ ChiaHub {what}: the burner's push went unanswered ({e:#}) — filed as pending; the chain's word settles it");
            false
        }
        Err(e) => return Err(e.into()),
    };
    if built.gift.is_some() {
        fuse.lock().unwrap().count(era, payer);
    }
    Ok(MemoWrite { coins: built.coins, acked, spend: lease.spend_of(&built.coins.parked), memo: built.memo, payer })
}

/// [`burner_write_with`] on the node's own lease and fuse ([`WALLET_LEASE`],
/// [`GIFT_FUSE`]), its network, the money lane's chain
/// (`chia_chain::connect`: money paths need two agreeing peers, stage 4
/// design §10; a peer that lies about a burner coin risks at most a refused
/// push) and the OS random source.
///
/// Its [`MemoWrite`] files whole in `NodePublishMark`, `BeaconMark` or
/// `SentKnock` (§4.4): its parent as the mark's coin id (the gift g for a
/// first write), its parked input beside it (the dish coin F) and the
/// burner as its payer, and the mark's reader judges it by both coins
/// ([`WriteCoins::filed`]). Like the builder it has no network check of its
/// own: until PR 10's writers land, its one caller, the claim-and-write
/// self-test hook ([`claim_write_selftest`]), runs only with
/// SSF_CHIA_BURNERS=1 on a test network (§13 row 9), and keeps no mark.
pub async fn burner_write(
    key: &BurnerKey,
    era: u64,
    hint: Bytes32,
    gate: Option<&tokio::sync::Mutex<()>>,
    body: impl FnOnce(Bytes32) -> Result<Vec<u8>>,
    what: &str,
) -> Result<MemoWrite> {
    let client = crate::chia_chain::connect();
    let net = crate::chia_network::net();
    burner_write_with(&WALLET_LEASE, &GIFT_FUSE, net, &client, Instant::now(), key, era, hint, gate, body, &mut rand::rngs::OsRng, what).await
}

/// The blake3 `derive_key` context of the claim-and-write self-test's hint.
const CTX_CLAIM_WRITE_TEST: &str = "ssf-chia-claim-write-test-v1";

/// The prefix of the self-test's log lines, as the craps self-test has its own.
const SELFTEST: &str = "⛓️🧪 claim-write selftest";

/// How many times the self-test asks the writer while it only waits
/// ([`BurnerWait`]), and how long it waits between asks.
const SELFTEST_TRIES: u32 = 20;
const SELFTEST_RETRY: std::time::Duration = std::time::Duration::from_secs(60);

/// How often the self-test asks the chain's verdict on its write, and for how
/// long before it gives up.
const SELFTEST_VERDICT_EVERY: std::time::Duration = std::time::Duration::from_secs(20);
const SELFTEST_VERDICT_FOR: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// How many times the self-test reads its record back on the carrier lane,
/// one [`SELFTEST_VERDICT_EVERY`] apart, since the first reachable peer can
/// be a block behind the agreed ones that confirmed it.
const SELFTEST_READS: u32 = 9;

/// The hint the self-test writes under in `era`. It is derived from a
/// constant and the era alone, so it is public, and no listing, knock or
/// beacon is ever written under it.
fn claim_write_test_hint(era: u64) -> Bytes32 {
    Bytes32::new(blake3::derive_key(CTX_CLAIM_WRITE_TEST, &era.to_le_bytes()))
}

/// The era the self-test writes in: the agreed peak's, refused inside the
/// era's last [`super::ERA_GUARD_BLOCKS`], where a write could confirm in the
/// next era, as every era-bound write is.
async fn selftest_era(client: &impl ChainAccess) -> Result<u64> {
    let peak = crate::chia_resolve::peak_height(client).await.ok_or_else(|| anyhow!("chain peak unavailable (peers unreachable?)"))?;
    if super::era_guard(peak) {
        return Err(anyhow!("the era ends within {} blocks; run the test again in the new era", super::ERA_GUARD_BLOCKS));
    }
    Ok(crate::chia_lane::era_of(peak))
}

/// The claim-and-write self-test (SSF_CHIA_CLAIM_WRITE_TEST=1 with
/// SSF_CHIA_BURNERS=1, on a test network: main.rs). It makes one real
/// claim-and-write from a burner on the network's lobby dish ([`burner_write`],
/// stage 4 design §4.1), waits for the chain's verdict on it, and reads the
/// record back through its ephemeral parent g on the carrier lane: the
/// inferred fetch of §4.1 and §14 (2), tried on real peers before PR 10
/// builds every writer on it (§13 row 9). It is not a row 9 item itself but
/// an addition beside them, so it is its own hook, off by default.
///
/// The burner is K(h_test) of the wallet's root on `net`, with h_test
/// [`claim_write_test_hint`] of the era: the knock kind's derivation used as
/// a test slot that no knock is ever written under. It claims a random ready
/// lobby coin F to itself and, in the same bundle, writes 64 random bytes
/// under h_test: two coin spends, the burner's one signature, no fee, parked
/// under the burner as its payer, holding F alone. The bytes carry no node
/// id and no address, and the write is filed in no mark.
///
/// A knock's key is never spent again (§4.1), so a second run in the same
/// era that finds the burner holding its coin says the test already ran and
/// writes nothing. Its coin can land in the moment between that check and the
/// writer's own listing, and the run then writes once from it; it is a test
/// slot, so nothing is lost but a mojo's move.
///
/// PASS needs a Confirmed verdict ([`super::write_standing_on`] by g and F,
/// which already fetches g's spend on the agreed lane) and then the record
/// found on the carrier lane with g as its parent. If the verdict is still
/// pending after 30 minutes while F reads spent, the likely cause is that
/// the peers do not serve g, and the FAIL says the §10 fallback is needed.
///
/// A bundle it parked outlives the run: like any spend in flight, it is
/// pushed again and settled on any later start on a test network, with
/// SSF_CHIA_BURNERS set or not, and until it settles the money writers'
/// settling check, which asks about every payer, holds them. Nothing new is
/// built without the flag.
pub async fn claim_write_selftest(net: ChiaNet, wallet: chia_bls::SecretKey) -> Result<()> {
    use crate::chia_burner::{BurnerRoot, MoneyKey};
    use crate::chia_resolve::{read_hint_items, spent_heights, HintCursor, WriteStanding};

    anyhow::ensure!(net.is_test(), "the claim-and-write self-test runs on a test network only");
    let client = crate::chia_chain::connect();
    let era = selftest_era(&client).await?;
    let hint = claim_write_test_hint(era);
    let key = BurnerRoot::of(&MoneyKey::new(wallet), net).knock(&hint.to_bytes(), era);
    let mut body = [0u8; 64];
    rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut body);
    println!("{SELFTEST} — {} era {era}, test hint {}", net.name(), hex::encode(&hint.to_bytes()[..8]));

    let mut tries = 0u32;
    let write = loop {
        if !unspent_at(&client, key.puzzle_hash()).await?.coins.is_empty() {
            println!("{SELFTEST}: already ran this era (its burner holds its coin); nothing is written");
            return Ok(());
        }
        match burner_write(&key, era, hint, None, |_| Ok(body.to_vec()), "claim-write test").await {
            Ok(write) => break write,
            Err(e) if e.downcast_ref::<BurnerWait>().is_some() && tries + 1 < SELFTEST_TRIES => {
                tries += 1;
                println!("{SELFTEST}: waits ({tries}/{SELFTEST_TRIES}): {e:#}; asks again in {} s", SELFTEST_RETRY.as_secs());
                tokio::time::sleep(SELFTEST_RETRY).await;
                if selftest_era(&client).await? != era {
                    return Err(anyhow!("the era turned while the test waited; run it again"));
                }
            }
            Err(e) => return Err(e.context("the claim-and-write did not go out")),
        }
    };
    let (g, f) = (write.coins.parent, write.coins.parked);
    if g == f {
        println!("{SELFTEST}: already ran this era (its burner's coin landed as this run asked, so it wrote from that coin)");
        return Ok(());
    }
    println!(
        "   ✅ claim and write {}: dish coin F {f}, gift g {g}, new coin {}",
        if write.acked { "pushed" } else { "pushed, unanswered (the chain's word settles it)" },
        Coin::new(g, key.puzzle_hash(), 1).coin_id()
    );

    let asked = Instant::now();
    let height = loop {
        let standing = super::write_standing_on(
            &WALLET_LEASE,
            net,
            &crate::chia_chain::connect(),
            write.coins,
            hint,
            Some(write.memo),
            write.spend,
            0,
            "claim-write test",
        )
        .await;
        match standing.map(|(standing, _)| standing) {
            Some(WriteStanding::Confirmed { height, .. }) => break height,
            Some(WriteStanding::Dead(why)) => return Err(anyhow!("the claim-and-write died: {why}")),
            _ if asked.elapsed() >= SELFTEST_VERDICT_FOR => {
                let f_spent = spent_heights(&client, vec![f]).await.is_ok_and(|spent| spent.iter().any(|(coin, _)| *coin == f));
                return Err(if f_spent {
                    anyhow!("F is spent but the write is still pending after 30 minutes: the ephemeral parent g was not served (design §10 fallback)")
                } else {
                    anyhow!("the bundle has not landed in 30 minutes (F is unspent); its spend stays parked and settles on a later run")
                });
            }
            _ => tokio::time::sleep(SELFTEST_VERDICT_EVERY).await,
        }
    };
    println!("   ✅ confirmed at height {height}, judged through g on the agreed lane");

    let opener = |ciphertext: &[u8], parent: Bytes32, _height: u32| (ciphertext == body.as_slice()).then_some(parent);
    let mut read = 0u32;
    loop {
        read += 1;
        let found = read_hint_items(&crate::chia_chain::connect_carrier(), hint, &mut HintCursor::default(), &opener).await;
        match found {
            Ok(found) if found.iter().any(|item| item.item == g) => {
                println!("{SELFTEST} PASS — the record was read back on the carrier lane through its ephemeral parent g (design §4.1)");
                return Ok(());
            }
            Ok(_) | Err(_) if read < SELFTEST_READS => tokio::time::sleep(SELFTEST_VERDICT_EVERY).await,
            Ok(found) => {
                return Err(anyhow!(
                    "confirmed, but the carrier lane's read under the hint found no record through g ({} other item(s)): the design §10 fallback is needed",
                    found.len()
                ))
            }
            Err(e) => return Err(e.context("confirmed, but the carrier lane's read under the hint failed")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use chia_bls::{PublicKey, SecretKey};
    use chia_puzzle_types::Memos;
    use chia_sdk_signer::{AggSigConstants, RequiredSignature};

    use crate::chia_burner::{BurnerRoot, MoneyKey};
    use crate::chia_faucet::dish_claim;
    use crate::chia_publish::our_puzzle_hash;
    use crate::chia_resolve::extract_ciphertext;

    use BurnerRule::*;

    /// The hint and body every write here carries: fixed test bytes.
    const HINT: [u8; 32] = [0x48; 32];
    const BODY: &[u8] = b"a sealed record, as far as the rules can tell";
    /// The height every coin here was seen confirmed at.
    const SEEN_AT: u32 = 100;

    /// The money key the test burners are derived from: a fixed test seed,
    /// never a wallet's.
    fn money() -> MoneyKey {
        MoneyKey::new(SecretKey::from_seed(&[7u8; 32]))
    }

    /// The `n`th test burner on `net`: the listing key of contact key
    /// `[n; 32]` in era 0, so each `n` is another burner.
    fn burner(net: ChiaNet, n: u8) -> BurnerKey {
        BurnerRoot::of(&money(), net).presence(&[n; 32], 0)
    }

    /// A coin at `puzzle_hash` of `amount`, its parent `[n; 32]`, seen at
    /// [`SEEN_AT`].
    fn coin_at(n: u8, puzzle_hash: Bytes32, amount: u64) -> FaucetCoin {
        FaucetCoin { coin: Coin::new(Bytes32::new([n; 32]), puzzle_hash, amount), confirmed_height: SEEN_AT }
    }

    /// The claim of a lobby coin of `amount` (parent `[n; 32]`) on `net` to
    /// `recipient`.
    fn lobby_claim(net: ChiaNet, n: u8, amount: u64, recipient: Bytes32) -> DishClaim {
        let lobby = FaucetParams::lobby(net);
        dish_claim(&lobby, coin_at(n, lobby.puzzle_hash(), amount), recipient).unwrap()
    }

    /// An unsigned standard spend of `coin`, the synthetic key of `pk`'s
    /// owner as its key, that makes the coins `outputs` with no memo: a
    /// spend built by hand, which the rules read as they read the builder's.
    fn spend_to(pk: PublicKey, coin: Coin, outputs: &[(Bytes32, u64)]) -> CoinSpend {
        let mut ctx = SpendContext::new();
        let conditions = outputs.iter().fold(Conditions::new(), |c, &(ph, amount)| c.create_coin(ph, amount, Memos::None));
        StandardLayer::new(pk.derive_synthetic()).spend(&mut ctx, coin, conditions).unwrap();
        let mut spends = ctx.take();
        assert_eq!(spends.len(), 1);
        spends.remove(0)
    }

    /// `spend`'s outputs as the readers run it: (puzzle hash, amount, memos).
    fn outputs(spend: &CoinSpend) -> Vec<(Bytes32, u64, Vec<Bytes>)> {
        let run = PuzzleAndSolution { puzzle_reveal: spend.puzzle_reveal.clone(), solution: spend.solution.clone() };
        created_coins(&run).unwrap().into_iter().map(|out| (out.puzzle_hash, out.amount, out.memos)).collect()
    }

    /// The memos a write carries, `[hint, body]`.
    fn write_memos() -> Vec<Bytes> {
        vec![Bytes::new(HINT.to_vec()), Bytes::new(BODY.to_vec())]
    }

    /// The bundle's fee: what its inputs hold less what its outputs make.
    fn fee(bundle: &SpendBundle) -> i128 {
        let spent: i128 = bundle.coin_spends.iter().map(|cs| i128::from(cs.coin.amount)).sum();
        let made: i128 = bundle.coin_spends.iter().flat_map(outputs).map(|(_, amount, _)| i128::from(amount)).sum();
        spent - made
    }

    /// The signatures `bundle` asks for on `net`, as (public key, AGG_SIG_ME
    /// coin, message): `None` as the coin for any other kind of AGG_SIG.
    fn signatures(net: ChiaNet, bundle: &SpendBundle) -> Vec<(PublicKey, Option<Vec<u8>>, Vec<u8>)> {
        let constants = AggSigConstants::from(net.constants());
        let mut a = Allocator::new();
        RequiredSignature::from_coin_spends(&mut a, &bundle.coin_spends, &constants)
            .unwrap()
            .into_iter()
            .map(|r| match r {
                RequiredSignature::Bls(bls) => {
                    let me = (bls.domain_string == Some(constants.me())).then(|| bls.appended_info.clone());
                    (bls.public_key, me, bls.message())
                }
                RequiredSignature::Secp(_) => panic!("no secp on a standard spend"),
            })
            .collect()
    }

    /// The bundle's one signature: the burner's own, an AGG_SIG_ME over
    /// `spent`, which the aggregate verifies. No other key, the money key
    /// least of all, is asked for one.
    fn assert_signed_by_the_burner_alone(net: ChiaNet, key: &BurnerKey, bundle: &SpendBundle, spent: Coin) {
        let signatures = signatures(net, bundle);
        assert_eq!(signatures.len(), 1, "{net:?}: one signature");
        let (pk, me, message) = signatures[0].clone();
        assert_eq!(pk, key.public_key().derive_synthetic(), "{net:?}: the burner's synthetic key");
        assert_ne!(pk, money().secret_key().public_key().derive_synthetic(), "{net:?}: never the money key");
        assert_eq!(me, Some(spent.coin_id().to_vec()), "{net:?}: an AGG_SIG_ME over the coin the burner spends");
        assert!(chia_bls::aggregate_verify(&bundle.aggregated_signature, vec![(pk, message)]), "{net:?}: the signature verifies");
    }

    /// `spends` break exactly `broken`, in that order, and the check refuses
    /// them under the first (or passes them when `broken` is empty).
    fn assert_breaks(net: ChiaNet, burner_ph: Bytes32, spends: &[CoinSpend], broken: &[BurnerRule], what: &str) {
        assert_eq!(broken_rules(net, burner_ph, spends), broken, "{net:?}: {what}");
        assert_eq!(check_burner_spends(net, burner_ph, spends), broken.first().map_or(Ok(()), |rule| Err(*rule)), "{net:?}: {what}");
    }

    /// The rule a refused build names, read as a caller reads it.
    fn refused_under(built: Result<BurnerBundle>) -> Option<BurnerRule> {
        built.unwrap_err().downcast_ref::<BurnerRule>().copied()
    }

    /// Stage 4 design §4.1, the table's first row: a first write is two
    /// spends, F's claim and then g's. F gives its remainder back to the
    /// dish and g to the burner, with no memo; g gives the burner's one coin
    /// of 1 mojo, with the memos `[hint, body]`. The one signature is the
    /// burner's AGG_SIG_ME over g, no fee is paid, no rule is broken, and
    /// the write is found by g and parked as F, at the height F was seen at.
    /// Its memo digest is the one a reader takes from the bundle.
    #[test]
    fn a_claim_and_write_is_two_spends_one_signature_the_burners_and_no_fee() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let lobby_ph = FaucetParams::lobby(net).puzzle_hash();
            let claim = lobby_claim(net, 5, 10, ph);
            let (f, g) = (claim.dish.coin, claim.gift);
            assert_eq!(g, Coin::new(f.coin_id(), ph, 1), "{net:?}: g");

            let built = build_burner_bundle(net, &key, &BurnerInput::Claim(claim.clone()), Bytes32::new(HINT), BODY.to_vec()).unwrap();
            let spends = &built.bundle.coin_spends;
            assert_eq!(spends.iter().map(|cs| cs.coin).collect::<Vec<_>>(), vec![f, g], "{net:?}: F's claim, then g's spend");
            assert_eq!(spends[0], claim.spend, "{net:?}: the claim as it was built");
            assert_eq!(outputs(&spends[0]), vec![(lobby_ph, 9, vec![]), (ph, 1, vec![])], "{net:?}: F's remainder and g");
            assert_eq!(outputs(&spends[1]), vec![(ph, 1, write_memos())], "{net:?}: the written coin");
            assert_signed_by_the_burner_alone(net, &key, &built.bundle, g);
            assert_eq!(fee(&built.bundle), 0, "{net:?}");
            assert_breaks(net, ph, spends, &[], "the claim-and-write");

            let carried = spends.iter().find_map(|cs| {
                let run = PuzzleAndSolution { puzzle_reveal: cs.puzzle_reveal.clone(), solution: cs.solution.clone() };
                extract_ciphertext(&run, Bytes32::new(HINT)).unwrap()
            });
            assert_eq!(built.memo, memo_digest(&carried.expect("a memo under the hint")), "{net:?}: the digest readers take");
            assert_eq!(built.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() }, "{net:?}");
            assert_eq!(built.parked, ParkedInput::from((f.coin_id(), SEEN_AT)), "{net:?}");
            assert_eq!(built.gift, Some(g), "{net:?}");
            assert_eq!(built.written, Coin::new(g.coin_id(), ph, 1), "{net:?}");
            assert_eq!(BurnerInput::Claim(claim).parent(), g.coin_id(), "{net:?}: the parent a knock seals to");
        }
    }

    /// Stage 4 design §4.1: a dish coin of exactly the gift has no
    /// remainder (`puzzles/faucet.clsp` makes one only above 0), so F's
    /// claim makes g alone. The write is still two spends, F's and g's, at
    /// fee 0.
    #[test]
    fn a_dish_coin_of_exactly_the_gift_leaves_no_remainder() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let claim = lobby_claim(net, 5, 1, ph);
            assert_eq!(claim.remainder, None, "{net:?}");
            let built = build_burner_bundle(net, &key, &BurnerInput::Claim(claim.clone()), Bytes32::new(HINT), BODY.to_vec()).unwrap();
            let spends = &built.bundle.coin_spends;
            assert_eq!(spends.iter().map(|cs| cs.coin).collect::<Vec<_>>(), vec![claim.dish.coin, claim.gift], "{net:?}");
            assert_eq!(outputs(&spends[0]), vec![(ph, 1, vec![])], "{net:?}: g alone");
            assert_eq!(outputs(&spends[1]), vec![(ph, 1, write_memos())], "{net:?}");
            assert_signed_by_the_burner_alone(net, &key, &built.bundle, claim.gift);
            assert_eq!(fee(&built.bundle), 0, "{net:?}");
        }
    }

    /// Stage 4 design §4.1, the rewrite row: a later write spends the
    /// burner's one coin C to a new 1-mojo coin at the burner with the
    /// memos. One spend, the burner's AGG_SIG_ME over C, no fee, and the
    /// write is found and parked by C alone.
    #[test]
    fn a_rewrite_spends_the_burners_one_coin_to_itself() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let own = coin_at(6, ph, 1);
            let c = own.coin;
            let built = build_burner_bundle(net, &key, &BurnerInput::Own(own.clone()), Bytes32::new(HINT), BODY.to_vec()).unwrap();
            let spends = &built.bundle.coin_spends;
            assert_eq!(spends.iter().map(|cs| cs.coin).collect::<Vec<_>>(), vec![c], "{net:?}: one spend");
            assert_eq!(outputs(&spends[0]), vec![(ph, 1, write_memos())], "{net:?}");
            assert_signed_by_the_burner_alone(net, &key, &built.bundle, c);
            assert_eq!(fee(&built.bundle), 0, "{net:?}");
            assert_breaks(net, ph, spends, &[], "the rewrite");
            assert_eq!(built.coins, WriteCoins::one(c.coin_id()), "{net:?}");
            assert_eq!(built.parked, ParkedInput::from((c.coin_id(), SEEN_AT)), "{net:?}");
            assert_eq!(built.gift, None, "{net:?}");
            assert_eq!(built.written, Coin::new(c.coin_id(), ph, 1), "{net:?}");
            assert_eq!(BurnerInput::Own(own).parent(), c.coin_id(), "{net:?}");
        }
    }

    /// R1: two 1-mojo coins of the burner, each spent to itself, are two
    /// burner inputs; a claim to the burner whose gift the bundle does not
    /// spend is none. Every other rule holds in both. No secret is needed to
    /// build them, only the burner's public key.
    #[test]
    fn r1_a_bundle_with_two_burner_inputs_is_refused() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let (c1, c2) = (coin_at(1, ph, 1).coin, coin_at(2, ph, 1).coin);
            let two = [spend_to(key.public_key(), c1, &[(ph, 1)]), spend_to(key.public_key(), c2, &[(ph, 1)])];
            assert_breaks(net, ph, &two, &[R1], "two burner coins");
            assert_breaks(net, ph, &two[..1], &[], "the control: one of them alone");

            let unspent_gift = [lobby_claim(net, 5, 10, ph).spend];
            assert_breaks(net, ph, &unspent_gift, &[R1], "a claim alone");
        }
    }

    /// R2: a money coin spent beside a claim-and-write is refused, though it
    /// pays the burner its whole amount, so no other rule breaks. Built
    /// through the builder, a claim to another address leaves a gift that is
    /// not the burner's coin: it is foreign (R2), the bundle has no burner
    /// input (R1), and F pays someone else (R3). The builder signs neither.
    #[test]
    fn r2_a_money_coin_in_a_burner_bundle_is_refused() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let hint = Bytes32::new(HINT);
            let claim = BurnerInput::Claim(lobby_claim(net, 5, 10, ph));
            let money = SecretKey::from_seed(&[9u8; 32]);
            let money_coin = coin_at(7, our_puzzle_hash(&money), 1).coin;
            let mut spends = burner_spends(&key, &claim, hint, Bytes::new(BODY.to_vec())).unwrap();
            assert_breaks(net, ph, &spends, &[], "the control: the claim-and-write alone");
            spends.push(spend_to(money.public_key(), money_coin, &[(ph, 1)]));
            assert_breaks(net, ph, &spends, &[R2], "a money coin beside it");

            let elsewhere = BurnerInput::Claim(lobby_claim(net, 5, 10, burner(net, 2).puzzle_hash()));
            let spends = burner_spends(&key, &elsewhere, hint, Bytes::new(BODY.to_vec())).unwrap();
            assert_breaks(net, ph, &spends, &[R2, R1, R3], "a claim to another burner");
            assert_eq!(refused_under(build_burner_bundle(net, &key, &elsewhere, hint, BODY.to_vec())), Some(R2), "{net:?}");
        }
    }

    /// R3: a burner bundle that pays another address is refused, in two
    /// ways. The burner's spend pays another burner's puzzle hash, so it
    /// does not pay itself either (R5). A lobby claim gifts another burner
    /// beside a rewrite of the burner's own coin, which breaks R3 alone.
    #[test]
    fn r3_a_burner_bundle_that_pays_another_address_is_refused() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let other = burner(net, 2).puzzle_hash();
            let c = coin_at(6, ph, 1).coin;
            assert_breaks(net, ph, &[spend_to(key.public_key(), c, &[(other, 1)])], &[R3, R5], "the burner pays another");

            let rewrite = spend_to(key.public_key(), c, &[(ph, 1)]);
            let gift_elsewhere = lobby_claim(net, 5, 10, other).spend;
            assert_breaks(net, ph, std::slice::from_ref(&rewrite), &[], "the control: the rewrite alone");
            assert_breaks(net, ph, &[gift_elsewhere, rewrite], &[R3], "a claim gifting another burner");
        }
    }

    /// R4: two lobby claims to the burner in one bundle are refused, though
    /// the burner spends only the first gift and every other rule holds.
    #[test]
    fn r4_a_bundle_claiming_two_dish_coins_is_refused() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let first = BurnerInput::Claim(lobby_claim(net, 5, 10, ph));
            let mut spends = burner_spends(&key, &first, Bytes32::new(HINT), Bytes::new(BODY.to_vec())).unwrap();
            spends.push(lobby_claim(net, 8, 10, ph).spend);
            assert_breaks(net, ph, &spends, &[R4], "two claims");
        }
    }

    /// R5: a burner spend that pays anything but one 1-mojo coin to itself
    /// is refused: its 1-mojo coin making a 0-mojo coin, a fee of 1, and the
    /// coin making two coins at itself, which leaves no fee.
    #[test]
    fn r5_a_burner_spend_that_pays_anything_but_one_mojo_to_itself_is_refused() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let c = coin_at(6, ph, 1).coin;
            assert_breaks(net, ph, &[spend_to(key.public_key(), c, &[(ph, 0)])], &[R5], "a fee of 1");
            assert_breaks(net, ph, &[spend_to(key.public_key(), c, &[(ph, 1), (ph, 0)])], &[R5], "two coins at itself");
        }
    }

    /// R6: a claim at a private room's dish, or at the other network's
    /// lobby, is refused on every network, though the claim and the write
    /// are otherwise the claim-and-write's own. The builder signs neither.
    #[test]
    fn r6_a_claim_at_a_private_rooms_dish_is_refused_on_every_network() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let hint = Bytes32::new(HINT);
            let other_net = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            for (what, dish) in [("a room's own dish", FaucetParams::for_room(net, &[0x33; 32])), ("the other network's lobby", FaucetParams::lobby(other_net))] {
                let claim = BurnerInput::Claim(dish_claim(&dish, coin_at(5, dish.puzzle_hash(), 10), ph).unwrap());
                let spends = burner_spends(&key, &claim, hint, Bytes::new(BODY.to_vec())).unwrap();
                assert_breaks(net, ph, &spends, &[R6], what);
                let built = build_burner_bundle(net, &key, &claim, hint, BODY.to_vec());
                assert_eq!(refused_under(built), Some(R6), "{net:?}: {what}");
            }
            assert!(R6.to_string().starts_with("burner rule R6 (stage 4 design §4.2): "), "{R6}");
        }
    }

    /// R7: a coin at the burner of any amount but 1 mojo is a stray and is
    /// never written from. Spending it to the burner's 1-mojo coin leaves a
    /// fee or makes mojos from nothing, so R5 breaks with it; the refusal
    /// names R7, the cause.
    #[test]
    fn r7_a_burner_coin_of_any_other_amount_is_never_written_from() {
        for net in ChiaNet::ALL {
            let key = burner(net, 1);
            let ph = key.puzzle_hash();
            let hint = Bytes32::new(HINT);
            for amount in [0, 2, 1_000] {
                let stray = BurnerInput::Own(coin_at(6, ph, amount));
                let spends = burner_spends(&key, &stray, hint, Bytes::new(BODY.to_vec())).unwrap();
                assert_breaks(net, ph, &spends, &[R7, R5], &format!("a stray of {amount}"));
                let built = build_burner_bundle(net, &key, &stray, hint, BODY.to_vec());
                assert_eq!(refused_under(built), Some(R7), "{net:?}: a stray of {amount}");
            }
        }
    }

    /// `n` payers, each another test burner's on testnet11.
    fn payers(n: u8) -> Vec<Payer> {
        (0..n).map(|i| Payer::of_burner(&burner(ChiaNet::Testnet11, i))).collect()
    }

    /// A directory of the test's own, removed when it is dropped, a failed
    /// assertion included.
    struct Dir(PathBuf);

    impl Dir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ssf-gift-fuse-{tag}-{}-{}", std::process::id(), rand::random::<u64>()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Stage 4 design §5.2: at most sixteen gifts per node per era. Each is
    /// let through and counted, the seventeenth is refused as a wait that
    /// names the era, and the next era opens the fuse again. An earlier era
    /// (a clock set back) reads the count of the era it counted, so it
    /// fails closed rather than starting a fresh count.
    #[test]
    fn the_fuse_lets_sixteen_gifts_through_an_era_and_opens_again_in_the_next() {
        let mut fuse = GiftFuse::new();
        let funded = payers(17);
        for (n, payer) in funded.iter().take(16).enumerate() {
            assert_eq!(fuse.allows(5), Ok(()), "gift {n}");
            fuse.count(5, *payer);
            assert_eq!(fuse.gifts_in(5), u32::try_from(n + 1).unwrap());
        }
        assert_eq!(fuse.allows(5), Err(BurnerWait::FuseBlown { era: 5 }), "the seventeenth");
        assert_eq!(fuse.allows(5), Err(BurnerWait::FuseBlown { era: 5 }), "and every one after it");
        assert_eq!(
            BurnerWait::FuseBlown { era: 5 }.to_string(),
            "16 gifts from the lobby dish in era 5; no burner is funded again before era 6"
        );
        assert_eq!((fuse.gifts_in(4), fuse.allows(4)), (16, Err(BurnerWait::FuseBlown { era: 5 })), "an earlier era fails closed");
        assert_eq!(fuse.gifts_in(6), 0);
        assert_eq!(fuse.allows(6), Ok(()), "the next era opens it");
        fuse.count(6, funded[16]);
        assert_eq!((fuse.gifts_in(6), fuse.gifts_in(5)), (1, 1), "the count is the new era's, and an earlier one reads it");
    }

    /// The blown fuse says why once per era: the first refusal of an era
    /// logs its line, which names the next era, and no later refusal of that
    /// era says it again. A later era that blows says its own.
    #[test]
    fn the_fuse_says_once_per_era_that_it_is_blown() {
        let mut fuse = GiftFuse::preset(3, payers(16));
        assert_eq!(
            fuse.say_blown().as_deref(),
            Some("⛓️ ChiaHub burners: 16 gifts from the lobby dish this era; no burner is funded again before era 4")
        );
        assert_eq!(fuse.say_blown(), None, "said once");

        let mut fuse = GiftFuse::preset(3, payers(16));
        assert_eq!(fuse.allows(3), Err(BurnerWait::FuseBlown { era: 3 }));
        assert_eq!(fuse.said, Some(3), "the first refusal said it");
        assert_eq!(fuse.say_blown(), None, "…so nothing says it again this era");
        assert_eq!(fuse.allows(3), Err(BurnerWait::FuseBlown { era: 3 }));
        assert_eq!(fuse.said, Some(3));

        assert_eq!(fuse.allows(4), Ok(()));
        for payer in payers(16) {
            fuse.count(4, payer);
        }
        assert_eq!(fuse.allows(4), Err(BurnerWait::FuseBlown { era: 4 }));
        assert_eq!(fuse.said, Some(4), "a later era says its own");
        assert_eq!(fuse.say_blown(), None);
    }

    /// Stage 4 design §5.2 and §5.4: a gift whose bundle died never landed
    /// through us, so the fuse gives it back: one entry of that payer's, and
    /// none of anyone else's. A payer it holds nothing for gets nothing back,
    /// and a blown fuse given a gift back lets the next one through. A later
    /// era has nothing to give back.
    #[test]
    fn the_fuse_gives_back_a_gift_whose_bundle_died_and_no_other() {
        let [a, b, c]: [Payer; 3] = payers(3).try_into().unwrap();
        let mut fuse = GiftFuse::new();
        fuse.count(2, a);
        fuse.count(2, b);
        fuse.count(2, a);
        assert!(fuse.holds(2, a) && fuse.holds(1, a) && !fuse.holds(2, c), "a counted, c not");
        assert!(!fuse.holds(3, a), "a later era holds nothing");
        assert!(fuse.refund(2, a), "one of a's");
        assert_eq!(fuse.gifts_in(2), 2);
        assert!(!fuse.refund(2, c), "c was funded nothing");
        assert_eq!(fuse.gifts_in(2), 2);
        assert!(fuse.refund(2, a), "a's other");
        assert!(!fuse.holds(2, a) && !fuse.refund(2, a), "a holds nothing more");
        assert_eq!(fuse.payers, vec![b.hex()], "b's stays");

        let mut blown = GiftFuse::preset(2, payers(16));
        assert_eq!(blown.allows(2), Err(BurnerWait::FuseBlown { era: 2 }));
        assert!(blown.refund(2, a));
        assert_eq!((blown.gifts_in(2), blown.allows(2)), (15, Ok(())), "given one back, the fuse lets one through");
        assert!(!blown.refund(3, b), "a later era has nothing to give back");
        assert_eq!(blown.gifts_in(3), 0);
    }

    /// Stage 4 design §5.2: with no peak to judge the lobby dish by, a
    /// burner's gift waits, typed, as the writer's other waits do. The
    /// burner holds no coin, the lease holds nothing and the fuse has room,
    /// so the write comes to its claim, which asks the peak before anything
    /// else; no peer answers it, the write is `BurnerWait::PeakUnavailable`,
    /// and only the burner's own listing was read, nothing pushed and no
    /// gift counted.
    #[tokio::test]
    async fn a_burner_gift_with_no_peak_to_judge_the_dish_by_waits_and_sends_nothing() {
        use crate::chia_chain::testing::Scripted;
        use rand::SeedableRng;
        let none = crate::chia_chain::CoinListing { records: vec![], truncated: false, next_cursor: None, judged_at: None };
        let chain = Scripted::new(vec![none]);
        let (lease, fuse) = (WalletLease::new(), Mutex::new(GiftFuse::new()));
        let net = ChiaNet::Testnet11;
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        let write = burner_write_with(&lease, &fuse, net, &chain, Instant::now(), &burner(net, 1), 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, "test").await;
        let e = write.err().expect("the write waits");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::PeakUnavailable), "{e:#}");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true], "the burner's listing alone was read");
        assert_eq!(chain.sent.load(std::sync::atomic::Ordering::Relaxed), 0, "nothing pushed");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0);
    }

    /// Stage 4 design §5.2, the fuse's refund failing closed on a listing
    /// cut short: a gift is counted for a burner that holds no coin, with
    /// nothing of its in the lease, so the writer asks the chain whether its
    /// puzzle hash ever held a coin of 1 mojo. The listing it gets back is
    /// cut short, empty or showing only a stray of 2 mojos, and the gift's
    /// coins could lie past the cut, so the gift stays counted. The write
    /// goes on to its claim, which waits for the peak it cannot read:
    /// nothing is pushed.
    #[tokio::test]
    async fn a_burner_listing_cut_short_keeps_a_counted_gift_counted() {
        use crate::chia_chain::testing::Scripted;
        use crate::chia_chain::{CoinListing, CoinRecord};
        use rand::SeedableRng;
        let net = ChiaNet::Testnet11;
        let key = burner(net, 1);
        let stray = CoinRecord { coin: coin_at(2, key.puzzle_hash(), 2).coin, confirmed_block_index: SEEN_AT, spent: false, spent_block_index: 0 };
        for shown in [vec![], vec![stray]] {
            let n = shown.len();
            let listing = |truncated: bool| CoinListing { records: shown.clone(), truncated, next_cursor: None, judged_at: None };
            let chain = Scripted::new(vec![listing(false), listing(true)]);
            let (lease, fuse) = (WalletLease::new(), Mutex::new(GiftFuse::preset(0, [Payer::of_burner(&key)])));
            let mut rng = rand::rngs::StdRng::seed_from_u64(1);
            let write = burner_write_with(&lease, &fuse, net, &chain, Instant::now(), &key, 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, "test").await;
            let e = write.err().expect("the write waits");
            assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::PeakUnavailable), "{n} shown: {e:#}");
            assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "{n} shown: the burner's listing, then the refund's");
            assert_eq!(fuse.lock().unwrap().gifts_in(0), 1, "{n} shown: the gift kept counted");
            assert_eq!(chain.sent.load(std::sync::atomic::Ordering::Relaxed), 0, "{n} shown: nothing pushed");
        }
    }

    /// Stage 4 design §5.2, the fuse's refund failing closed on a failed
    /// read: a gift is counted for a burner that holds no coin, with nothing
    /// of its in the lease, and the listing the refund asks for is not
    /// given. The write waits, typed as the failed read it is
    /// ([`CoinLookupFailed`]), which is no knock attempt; the gift stays
    /// counted, no claim is asked and nothing is pushed.
    #[tokio::test]
    async fn a_burner_listing_the_chain_does_not_give_keeps_a_counted_gift_counted_and_waits() {
        use crate::chia_chain::testing::Scripted;
        use rand::SeedableRng;
        let net = ChiaNet::Testnet11;
        let key = burner(net, 1);
        let none = crate::chia_chain::CoinListing { records: vec![], truncated: false, next_cursor: None, judged_at: None };
        let chain = Scripted::new(vec![none]);
        let (lease, fuse) = (WalletLease::new(), Mutex::new(GiftFuse::preset(0, [Payer::of_burner(&key)])));
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        let write = burner_write_with(&lease, &fuse, net, &chain, Instant::now(), &key, 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, "test").await;
        let e = write.err().expect("the write waits");
        assert!(e.downcast_ref::<CoinLookupFailed>().is_some(), "a failed read: {e:#}");
        assert!(!crate::chia_publish::knock_attempt_counts(true, &e), "a failed read is no knock attempt (§5.2)");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "the burner's listing, then the refund's, unanswered");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 1, "the gift kept counted");
        assert_eq!(chain.sent.load(std::sync::atomic::Ordering::Relaxed), 0, "nothing pushed");
    }

    /// The fuse is kept across a restart, per its file: what was counted and
    /// given back is what a load reads, the file written 0600. A missing
    /// file, one that is not the fuse's JSON, and one in an older format
    /// (a bare count, with no payers) start a fresh fuse, which saves to the
    /// same file at its first count.
    #[test]
    fn the_fuse_is_kept_across_a_restart_and_a_bad_file_starts_it_fresh() {
        let dir = Dir::new("restart");
        let path = dir.0.join(GIFT_FUSE_FILE);
        let [a, b]: [Payer; 2] = payers(2).try_into().unwrap();

        let mut fuse = GiftFuse::load(&path);
        assert_eq!((fuse.era, fuse.gifts_in(0), fuse.path.as_deref()), (0, 0, Some(path.as_path())), "missing: fresh");
        assert!(!path.exists(), "a load writes nothing");
        fuse.count(7, a);
        fuse.count(7, b);
        let again = GiftFuse::load(&path);
        assert_eq!((again.era, again.gifts_in(7), again.payers.clone()), (7, 2, vec![a.hex(), b.hex()]));
        let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved, serde_json::json!({ "era": 7, "payers": [a.hex(), b.hex()] }));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let mut again = again;
        assert!(again.refund(7, a));
        assert_eq!(GiftFuse::load(&path).payers, vec![b.hex()], "a gift given back is saved too");

        let mut blown = GiftFuse { path: Some(path.clone()), ..GiftFuse::preset(7, payers(15)) };
        blown.count(7, a);
        let mut fuse = GiftFuse::load(&path);
        assert_eq!(fuse.allows(7), Err(BurnerWait::FuseBlown { era: 7 }), "a blown fuse stays blown across a restart");
        assert_eq!(fuse.allows(8), Ok(()), "…until the next era");

        for bad in ["", "not json", "{\"era\": 7", "{\"era\": \"seven\", \"payers\": []}", "{\"era\": 7, \"gifts\": 16}", "[7, 16]"] {
            std::fs::write(&path, bad).unwrap();
            let mut fuse = GiftFuse::load(&path);
            assert_eq!((fuse.era, fuse.gifts_in(7)), (0, 0), "{bad:?}: fresh");
            assert_eq!(fuse.allows(7), Ok(()), "{bad:?}");
            fuse.count(7, a);
            assert_eq!(GiftFuse::load(&path).payers, vec![a.hex()], "{bad:?}: saved over at its first count");
        }
    }
}
