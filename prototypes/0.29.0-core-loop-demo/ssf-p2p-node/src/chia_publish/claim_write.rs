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
//! gate (`super::burner_paths`: SSF_CHIA_BURNERS on a test network, §13
//! rows 9 and 10, and always off one; the beacon's writer where the
//! operator turned the beacon on, and the listing's and the knocks' while
//! the player's LIST ME is on, §4.5 (6)). Its tests run on each network
//! for that reason.
//!
//! The writer ([`burner_write_with`], and [`burner_write`] on the node's own
//! lease and chain) picks what a write spends under the gift rules of §5.2:
//! the burner's own coin when it holds one, and otherwise a gift from the
//! lobby dish, never a second while a bundle for the key is held, and never
//! past the node's fuse for the era ([`GiftFuse`]). A knock's key K(h) is the
//! exception: it writes once and is never spent again (§4.1, the knock row),
//! so the knock's writer ([`knock_write_with`]) reads a key that already
//! wrote as [`AlreadyKnocked`] and writes nothing. Waiting is not failing:
//! each reason to wait comes back typed ([`BurnerWait`]). An
//! [`AlreadyKnocked`] is no wait: it is the end of that knock. The listing's
//! key P(e) is the one key twins on the same words do not share (§3.3), so
//! the listing's writer ([`listing_write_with`]) compares what the key has
//! spent with the lease's records of its own spends, and stops for a coin
//! another copy of this station spent ([`ForeignSpend`], §10), which is
//! neither a wait nor a failure of the write: its caller pauses.
//!
//! Outside the tests the writer is called by the listing's writer from its
//! burner key P(e) (`publish_node_presence_with`, §13 row 10, PR 10b), by
//! the knock's writer from K(h) (`publish_knock_with`, PR 10c), by the
//! beacon's writer from its key B (`publish_beacon_with`, PR 10d), and by
//! [`claim_write_selftest`], the hook that makes one real claim-and-write on
//! a test network and reads it back through its ephemeral parent
//! (SSF_CHIA_CLAIM_WRITE_TEST=1 with SSF_CHIA_BURNERS=1).

use std::collections::HashMap;
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

use super::{push_parked_as, MemoWrite, ParkedInput, Payer, PushError, Resend, Spacing, WalletLease, WALLET_LEASE};
use crate::chia_burner::BurnerKey;
use crate::chia_chain::{ChainAccess, CoinRecord, PuzzleAndSolution};
use crate::chia_faucet::{claim_to, records_at, unspent_at, ClaimToError, CoinLookupFailed, DishClaim, FaucetCoin, FaucetParams, Unspent, FAUCET_MOD_HASH, GIFT_MOJOS, MAX_FAUCET_PAGES};
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
/// has no network refusal of its own: which network it is reached on is its
/// callers' gate (module doc).
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
    /// gift could be its second (fail closed). A knock's key waits as
    /// [`BurnerWait::KnockKeyUnread`] instead.
    ListingCutShort,
    /// A knock's key K(h) cannot be told unwritten from what the chain gave
    /// (§4.1, the knock row: K(h) writes once): the listing of its puzzle
    /// hash was cut short, whatever it showed, since a record past the cut
    /// could be its own write; or the lookup by id of its lone coins'
    /// parents was cut short with a parent left out, since that parent could
    /// be at the key ([`knock_write_with`]). Fail closed, but as a wait, not
    /// as [`AlreadyKnocked`], which would end the knock for the era on a read
    /// that was only incomplete: the next read may be whole.
    KnockKeyUnread,
    /// No peer answered the peak, so no lobby coin can be judged ready, or,
    /// for a burner that waits on another payer's landed spend, the block
    /// its wait ends at cannot be compared with the chain's
    /// ([`BurnerWait::Spaced`], fail closed).
    PeakUnavailable,
    /// No lobby coin is ready that the lease does not hold: a dry or griefed
    /// dish (§10).
    NoCoinReady,
    /// The burner holds no coin, and the lease still parks a spend paid for
    /// by the payer its writer was given to wait on: the SSF wallet, for the
    /// listing (§8.3, the crash window). The burner is not funded beside a
    /// spend of that payer's in flight, and its first write goes out once
    /// the spend lands. The wait alone does not keep one hint to one payer:
    /// if the spend is this era's listing, written by the SSF wallet under
    /// the same hint before a restart that lost its mark, it puts the
    /// burner's write off and no more. What holds the burner then is the
    /// listing's mark, which the heartbeat files again from the write the
    /// lease holds under the hint (`chia_publish::lost_listing_mark`), and
    /// the hint rule it brings. A rewrite, from the burner's own coin, never
    /// waits so. Only the listing names a payer to wait on here. A knock's
    /// key is kept off a hint the SSF wallet wrote under by
    /// [`BurnerWait::MoneyUnderHint`], and the beacon's names none, since the
    /// SSF wallet writes nothing under the beacon's hint. Every burner's
    /// write is spaced from a spend of the SSF wallet's besides, as from any
    /// other payer's ([`BurnerWait::Spaced`]).
    MoneyInFlight,
    /// A knock's key K(h) would write under an inbox hint the lease holds a
    /// write of the SSF wallet's under: one the SSF wallet paid for, or one
    /// with no payer filed, which counts as its (§8.3, the crash window: two
    /// payers under one hint join them). The knock arm's step files such a
    /// write as the knock's own before it asks for one
    /// (`chia_publish::lost_knock_entry`), so this is the writer's own check
    /// of it, made under the lease's gate as it writes, for a write the step
    /// did not see. The knock is tried again, and the step then files that
    /// write while the lease holds it. A write another burner paid for
    /// under the hint, such as another host's knock under a contact key two
    /// cards name, does not hold it.
    MoneyUnderHint,
    /// T4 (stage 4 design §4.3): two pushes from different payers of one
    /// node land at least 32 blocks apart, so nothing on the chain shows
    /// that a listing, a knock and a beacon written minutes apart are one
    /// station's. The burner would push while the lease shows another
    /// payer's spend still in flight, or landed fewer blocks ago than the
    /// wait drawn for it, 32 to 64 ([`WalletLease::spacing`]). The other
    /// payer is any but this burner: another burner of this node, or the
    /// SSF wallet. A spend this burner itself pays for is
    /// [`BurnerWait::Held`], and a rewrite from its own coin is never spaced
    /// from its own last write. It is a wait like the others, and no knock
    /// attempt; the arm that meets it tries again at its next tick, not on
    /// its retry cadence (`chia_publish::spaced`).
    Spaced,
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
            BurnerWait::KnockKeyUnread => {
                f.write_str("the chain's listing of this knock's own key, or of its coins' parents, was cut short, so it cannot tell whether the key already wrote")
            }
            BurnerWait::PeakUnavailable => f.write_str("chain peak unavailable (peers unreachable?)"),
            BurnerWait::NoCoinReady => f.write_str("no mojo in the lobby dish right now; it refills on the block clock"),
            BurnerWait::MoneyInFlight => {
                f.write_str("a spend the SSF wallet pays for is still in flight, so the burner is not funded beside it; its first write waits for the chain's verdict")
            }
            BurnerWait::MoneyUnderHint => {
                f.write_str("the wallet lease holds a knock the SSF wallet wrote under this knock's inbox hint, so the knock's own key does not write beside it; the next try files that knock")
            }
            BurnerWait::Spaced => f.write_str("another write of this station went out a few minutes ago or is still in flight; this one goes out in its turn, some minutes after it"),
            BurnerWait::FuseBlown { era } => write!(
                f,
                "{MAX_GIFTS_PER_ERA} gifts from the lobby dish in era {era}; no burner is funded again before era {}",
                era.saturating_add(1)
            ),
        }
    }
}

impl std::error::Error for BurnerWait {}

/// Why a knock was not written although nothing went wrong: its key K(h)
/// already wrote (stage 4 design §4.1, the knock row: K(h) is never spent
/// again; §9: a coin K(h) wrote means "already knocked"). It is a sibling of
/// [`BurnerWait`], not one of its waits: the same knock tried again finds
/// the same records under the same key, so the caller drops the request and
/// uses none of its attempts ([`knock_write_with`]). Its text names neither
/// the key nor its puzzle hash or address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AlreadyKnocked;

impl fmt::Display for AlreadyKnocked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a knock on this host for this room already went out this era from its own key, and a knock's key writes once")
    }
}

impl std::error::Error for AlreadyKnocked {}

/// Why the listing was not written although nothing went wrong on the chain:
/// its key P(e) spent a coin this station's lease never parked a spend of
/// (stage 4 design §10, "Burner spent elsewhere"). Only a holder of the key
/// can spend a coin at its puzzle hash, so another copy of this station did,
/// from a cloned folder or the same words. It is a sibling of
/// [`BurnerWait`], not one of its waits: the writer tells of each such coin
/// once ([`WalletLease::foreign_spends`]), so the same write tried again
/// goes on, and its caller pauses the listing, the knocks and the beacon
/// instead (`chia_publish`'s `ForeignPause`). `coin` is the one spent last
/// among the coins told of, what the pause counts the telling by. Neither
/// its text nor its `Debug` names the coin, the key, or the key's puzzle
/// hash or address.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct ForeignSpend {
    pub coin: Bytes32,
}

impl fmt::Debug for ForeignSpend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ForeignSpend { .. }")
    }
}

impl fmt::Display for ForeignSpend {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("another copy of this station spent a coin of its listing's key, one this station's lease never parked a spend of")
    }
}

impl std::error::Error for ForeignSpend {}

/// The rule a burner's key writes its slot under (stage 4 design §4.1).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Slot {
    /// The beacon's and the self-test's: a later write spends the key's own
    /// 1-mojo coin to itself (the table's rewrite rows, R5).
    Rewritten,
    /// The listing's: rewritten as those are, and the one slot whose key
    /// twins do not share (§3.3: it comes from the words and this station's
    /// contact key), so a coin spent there that the lease has no record of
    /// was spent by another copy of this station, a cloned folder
    /// ([`ForeignSpend`], §10). Two machines on the same words derive the
    /// same beacon key and the same knock keys, so a spend of theirs by a
    /// twin is no fault and is not looked for.
    Listing,
    /// A knock's: K(h) writes once and is never spent again (the knock row),
    /// and never beside a write of the SSF wallet's, `money`, under its hint
    /// (§8.3).
    Once { money: Payer },
}

impl Slot {
    /// When a write under this rule may go to the peers again once it is
    /// parked ([`Resend`]): the listing's and a knock's only while the
    /// player's LIST ME is on (stage 4 design §4.5 (6)); the beacon's and
    /// the self-test's, which LIST ME does not govern, always.
    fn resend(self) -> Resend {
        match self {
            Slot::Rewritten => Resend::Always,
            Slot::Listing | Slot::Once { .. } => Resend::WhileListed,
        }
    }
}

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
/// which the burner writes from (R7; a knock's key writes from a lone one
/// once, [`knock_write_with`]), or a beacon key's coin of an earlier era.
/// That fails closed. A stray of any other amount is never written
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
/// 1 mojo, and then the burner writes from it and needs no gift, a knock's
/// key too, since a stranger's coin has its parent elsewhere.
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
/// them, which a knock's key writes from too, once, when it is a lone one
/// whose parent is elsewhere), or one another holder of its key spent
/// (§10). A 1-mojo coin that lands between the writer's two listings keeps
/// a dead gift counted once, which fails closed too.
///
/// It is not how the knock's slot asks whether its key already wrote
/// ([`knock_key_unwritten`]). That is read from the writer's own listing
/// before this is asked, so a knock's key that holds a spent record never
/// comes here. And a listing cut short, which keeps a gift counted here, as
/// the fuse needs, is a wait there, since it proves too little to end a
/// knock.
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
/// - T4 (§4.3): a spend another payer of this node paid for, still in
///   flight or landed fewer blocks ago than the wait drawn for it, is
///   [`BurnerWait::Spaced`] ([`WalletLease::spacing`]). It is asked before
///   the chain is asked for the burner's coins, so a spaced write asks the
///   peers nothing about the burner; the agreed peak is read only when a
///   wait in blocks is kept for the burner, and a peak the peers do not
///   give is [`BurnerWait::PeakUnavailable`], fail closed.
/// - A coin of exactly 1 mojo at the burner that the lease does not hold is
///   written from, the oldest first (the table's rewrite row). A coin of any
///   other amount is a stray and is never written from (R7).
/// - Holding none, the burner is funded by the claim of a random ready lobby
///   coin in the same bundle as the write (§5.1), under the gift rules
///   (§5.2): not while its listing was cut short
///   ([`BurnerWait::ListingCutShort`]), not while the lease holds a bundle
///   for it, parked or settling, by its payer or by its puzzle hash, or a
///   1-mojo coin of its ([`BurnerWait::Settling`], [`WalletLease::holds_for`],
///   [`WalletLease::holds_spend_at`]), not while the lease parks a spend
///   that `money` pays for, when the caller names one
///   ([`BurnerWait::MoneyInFlight`], [`WalletLease::outgoing_pending_for`]),
///   and not past the fuse ([`BurnerWait::FuseBlown`]). The listing names
///   the SSF wallet's payer there (§8.3, the crash window). The writer does
///   not read the hint a parked spend writes under, so the wait only puts
///   the burner's write off until that spend lands; the listing's hint rule
///   is its caller's, on the listing's mark (`chia_publish::hint_rule_holds`,
///   with a lost mark filed again by `chia_publish::lost_listing_mark`). A
///   rewrite never waits on it, since the burner then already holds the coin
///   its first write under the hint made. A gift the fuse counted for the burner is
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
/// under it, as `chia_publish::publish_memo_on` does. The bundle is built and checked
/// against R1 to R7 ([`build_burner_bundle`]; a broken rule is the
/// [`BurnerRule`] inside the error) and pushed with its on-chain input parked
/// under the burner as its payer ([`Payer::of_burner`]): F for a first
/// write, never g. The [`MemoWrite`] names that payer, for a first write and
/// a rewrite alike. An acknowledged or an unanswered push is a write, `acked`
/// true or false, as in `chia_publish::publish_memo_on`, and a first write's gift is
/// counted in the fuse; a refused one, or one the lease would not park, is
/// the [`PushError`] inside the error, and counts nothing.
///
/// The fuse is a std mutex, locked only for one statement at a time and
/// never across an await, so the future is `Send` and a spawned task can run
/// it.
///
/// This is the writer of a slot that is rewritten, the listing's and the
/// self-test's. A knock's key writes once, through [`knock_write_with`],
/// which shares this body and adds the knock slot's own checks. The
/// beacon's key is rewritten too, through [`beacon_write_with`], which is
/// this writer with the beacon's name and no payer to wait on.
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
    money: Option<Payer>,
) -> Result<MemoWrite> {
    write_slot(lease, fuse, net, client, now, key, era, hint, gate, body, rng, what, money, Slot::Rewritten).await
}

/// The listing's write from its key P(e) (stage 4 design §4.1, the two
/// listing rows), on a given lease, fuse, network, chain, instant and random
/// source, as [`burner_write_with`] takes them: that writer, with the
/// listing's name and the SSF wallet's payer `money` to wait on before a
/// first write (§8.3), and one step more, the listing's own (§10, "Burner
/// spent elsewhere"). After the `Held` checks and from the key's one listing
/// ([`records_at`]), when that listing is whole, every spent coin at the key
/// is compared with the lease's records of its own spends
/// ([`WalletLease::foreign_spends`]). A coin the records do not hold was
/// spent by another copy of this station, and the write stops there as
/// [`ForeignSpend`], before anything is claimed, parked, pushed or counted.
/// Each coin is told of once, so the next write goes on: from the key's
/// coin, whichever copy made it, or with a new gift under the fuse.
///
/// The first look under a lease file tells of nothing and only starts the
/// watch, since the records may be short of this station's earlier spends.
/// So does the first look after the two hours of a pause for another copy,
/// when the heartbeat starts the watch afresh (`WalletLease::watch_afresh`):
/// what that copy spent while the pause ran is what the pause was for.
/// A listing cut short is not compared at all: a rewrite from a coin it does
/// list goes on, and a first write waits as it always did
/// ([`BurnerWait::ListingCutShort`]).
///
/// What this does not see: a copy that spends after this station's last
/// write of the era is told to no one until one of the two writes again,
/// and it is the copy that writes next that is told. Two copies whose first
/// writes of an era are in flight together claim a dish coin each and see
/// nothing of each other until one writes again. A rewrite that loses its
/// coin to the other copy's in a race is told by the listing's verdict
/// instead (`chia_publish::listing_word`).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn listing_write_with<R: rand::Rng + ?Sized + Send>(
    lease: &WalletLease,
    fuse: &Mutex<GiftFuse>,
    net: ChiaNet,
    client: &impl ChainAccess,
    now: Instant,
    key: &BurnerKey,
    era: u64,
    hint: Bytes32,
    body: impl FnOnce(Bytes32) -> Result<Vec<u8>>,
    rng: &mut R,
    money: Payer,
) -> Result<MemoWrite> {
    write_slot(lease, fuse, net, client, now, key, era, hint, None, body, rng, "presence", Some(money), Slot::Listing).await
}

/// The beacon's write from its key B (stage 4 design §4.1, the two beacon
/// rows), on a given lease, fuse, network, chain, instant and random source,
/// as [`burner_write_with`] takes them: the writer of a slot that is
/// rewritten, whose lines name the write a "beacon". B's first write claims
/// a lobby dish coin in its own bundle, under the gift rules and the fuse
/// (§5.2), and every later one spends B's oldest 1-mojo coin the lease does
/// not hold to itself, with no gift. A coin of any other amount at B, such
/// as one an operator sent it while the beacon wallet was funded by hand, is
/// a stray and is never written from (R7).
///
/// It is spaced from every other payer's spend as every burner's write is
/// (§4.3 T4, [`BurnerWait::Spaced`]), which took the place of the hold it
/// had beside any parked spend of this node. It names no payer to wait on
/// before a first write ([`BurnerWait::MoneyInFlight`]): the SSF wallet
/// never writes under the beacon's hint.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn beacon_write_with<R: rand::Rng + ?Sized + Send>(
    lease: &WalletLease,
    fuse: &Mutex<GiftFuse>,
    net: ChiaNet,
    client: &impl ChainAccess,
    now: Instant,
    key: &BurnerKey,
    era: u64,
    hint: Bytes32,
    body: impl FnOnce(Bytes32) -> Result<Vec<u8>>,
    rng: &mut R,
) -> Result<MemoWrite> {
    write_slot(lease, fuse, net, client, now, key, era, hint, None, body, rng, "beacon", None, Slot::Rewritten).await
}

/// A knock's write from its key K(h) (stage 4 design §4.1, the knock row:
/// K(h) is never spent again; §9: a coin K(h) wrote means "already
/// knocked"), against a given lease, fuse, network, chain, instant and
/// random source, as [`burner_write_with`] takes them. It is that writer
/// under the knock's write-once rule: under the lease's gate, after the same
/// `Held` checks and from the same one listing of the key ([`records_at`]),
/// the key's slot is judged ([`knock_key_unwritten`]) before anything is
/// claimed, parked, pushed or counted. It names no money payer to wait on,
/// so it never waits [`BurnerWait::MoneyInFlight`] on a spend of the SSF
/// wallet's elsewhere, and its lines name the write a "knock". `money` is
/// the SSF wallet's payer, which K(h) never writes beside under `hint`
/// (§8.3).
///
/// What the lease and the chain hold for K(h) gives, in this order:
/// - its spend parked, in flight or restored after a restart:
///   [`BurnerWait::Held`], while the lease pushes the saved bundle again;
/// - a write the lease holds under `hint`, parked with its saved bundle or
///   settling, that `money` paid for or that has no payer filed:
///   [`BurnerWait::MoneyUnderHint`]. The knock arm's step files such a
///   write before it asks for the knock (`chia_publish::lost_knock_entry`),
///   reading the lease under its gate and giving the gate back before this
///   writer takes it, so this is the check of the lease the write is made
///   under, for a write parked in between. One another burner paid for, as
///   another host's knock under a contact key two cards name, is written
///   beside;
/// - its listing cut short, or the lookup of its lone coins' parents cut
///   short with a parent left out: [`BurnerWait::KnockKeyUnread`];
/// - a spent record at its puzzle hash (the knock landed, settling or
///   settled, whether the lease's file is kept or lost), or an unspent
///   1-mojo coin there whose parent is at the key too or is not returned by
///   a whole lookup: [`AlreadyKnocked`]. Nothing is claimed, parked, sent or
///   counted, and the fuse is untouched, blown or not;
/// - a lone unspent 1-mojo coin whose parent is elsewhere, the lease not
///   holding it (our claim, lifted out of our bundle by a peer and pushed
///   alone, §5.4, or a stray of exactly 1 mojo): the knock is written from
///   it, once, as a rewrite is, with no gift, and the next knock reads its
///   spent record;
/// - no such coin and a bundle of its the lease holds settling (a lost race
///   the chain has not settled): [`BurnerWait::Settling`];
/// - that bundle judged dead: its gift is given back to the fuse and a new
///   claim is made, as for any first write.
///
/// A coin of any other amount there is a stray, never written from (R7),
/// and it neither stops the knock nor keeps a dead gift counted.
///
/// [`AlreadyKnocked`] is no [`BurnerWait`] and no wait: the same knock tried
/// again reads the same records, so its caller drops the request and uses
/// none of its attempts. No knock entry is rebuilt from the chain for it: a
/// knock whose entry the node lost is filed again only from the write the
/// lease still holds under its hint (`chia_publish::lost_knock_entry`).
///
/// K(h) is the knock's own key for its host, room and era
/// (`chia_publish::knock_burner`): its inbox hint bound to the host's node
/// id, so two hosts whose cards name one contact key, and so share the
/// hint, have a key each, and neither's knock makes the other's read as
/// [`AlreadyKnocked`].
///
/// Twins, the same words on two machines, derive the same K(h) for a host,
/// room and era (§3.3's twins property holds for P(e), not for K(h)). One
/// after the other, the second reads [`AlreadyKnocked`]. At the same time
/// neither sees the other's bundle and both can land: two gifts for one key
/// and two coins at K(h), each opening only for the host. That is accepted,
/// as §9 accepts one extra bundle.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn knock_write_with<R: rand::Rng + ?Sized + Send>(
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
    money: Payer,
) -> Result<MemoWrite> {
    write_slot(lease, fuse, net, client, now, key, era, hint, gate, body, rng, "knock", None, Slot::Once { money }).await
}

/// Has the knock key at `burner_ph` never written? The knock slot's own
/// question (stage 4 design §4.1, the knock row: K(h) writes once), asked
/// by the writer under the lease's gate after its `Held` checks, of the
/// key's one listing ([`records_at`]: `records`, cut short when `partial`)
/// and of `unheld`, its unspent 1-mojo coins the lease does not hold. `Ok`
/// when it never wrote, and the writer goes on as for any burner. Otherwise,
/// in this order:
///
/// - A listing cut short is [`BurnerWait::KnockKeyUnread`]: a record past
///   the cut could be the key's. A wait is as closed as a drop, since
///   nothing is written, and it can recover.
/// - A spent record there, of any amount, is [`AlreadyKnocked`]: only the
///   key can spend a coin at its puzzle hash, and a landed knock spends g
///   there in its own block. A settling knock reads so at once, before the
///   writer's `Settling` check.
/// - An unspent 1-mojo coin whose parent is at the key too is the key's own
///   write, and one whose parent a whole lookup does not return could be:
///   [`AlreadyKnocked`] both, fail closed. The parents are asked by id in
///   one lookup, its cursor followed as [`records_at`] follows one, up to
///   [`MAX_FAUCET_PAGES`] pages, and a lookup that fails is
///   [`CoinLookupFailed`], a wait.
/// - A lookup cut short (still truncated past that budget, or truncated
///   with no cursor, as the peer lane cuts a lookup by id it could not
///   finish) says nothing of the coins it left out, as every other reader
///   of one takes it (`chia_resolve::coin_heights`). A parent it left out is
///   [`BurnerWait::KnockKeyUnread`], a wait, not [`AlreadyKnocked`], which
///   would end the knock for the era on a read that was only incomplete. A
///   parent it did return at the key is [`AlreadyKnocked`] all the same.
///
/// What is left is a key that never spent a coin: no coin of 1 mojo, or lone
/// ones whose parents are elsewhere. A peer we push to sees the key's puzzle
/// hash in the clear, as the keyless claim's recipient, and can push our
/// claim alone or pay a coin of 1 mojo there (§5.4). Neither cancels the
/// knock: the writer writes from such a coin once. Only the key can make a
/// coin whose parent is at the key, so peers that hide the parent of a coin
/// at the key can at worst make the knock read as written, or wait. Peers
/// that agree on hiding every record at the key can get it written again,
/// as they can for any burner whose coins the agreed lane hides (§10, a
/// peer that lies about a burner coin). This question reads the chain
/// alone, and what holds the key then is not the chain but the knock book's
/// entry for the host (`chia_publish::knock_skipped`) and the lease's record
/// of the spend. A second write so is one more knock from the same key
/// under the same hint, opening only for the host, as §9 accepts one extra
/// bundle.
async fn knock_key_unwritten(client: &impl ChainAccess, burner_ph: Bytes32, records: &[CoinRecord], partial: bool, unheld: &[Coin]) -> Result<()> {
    if partial {
        return Err(BurnerWait::KnockKeyUnread.into());
    }
    if records.iter().any(|r| r.spent) {
        return Err(AlreadyKnocked.into());
    }
    let mut parents: Vec<Bytes32> = unheld.iter().map(|coin| coin.parent_coin_info).collect();
    parents.sort();
    parents.dedup();
    if parents.is_empty() {
        return Ok(());
    }
    // Where each coin the lookup returns sits, by its id, hashed once as its
    // page comes in, so each parent is one map lookup: the check stays
    // linear in the coins at the key, whose distinct parents anyone can
    // multiply by paying the key strays of 1 mojo, while it holds the lease's
    // gate. A coin's id hashes its puzzle hash in, so a coin returned twice
    // (on two pages) names the same place either time, as the first copy a
    // scan would find does.
    let mut found: HashMap<Bytes32, Bytes32> = HashMap::new();
    let mut cursor: Option<String> = None;
    let mut whole = false;
    for _ in 0..MAX_FAUCET_PAGES {
        let listing = client.coin_records_by_names(parents.clone(), true, cursor.take()).await.map_err(CoinLookupFailed)?;
        found.extend(listing.records.iter().map(|r| (r.coin.coin_id(), r.coin.puzzle_hash)));
        match listing.next_cursor {
            Some(next) if listing.truncated => cursor = Some(next),
            _ => {
                whole = !listing.truncated;
                break;
            }
        }
    }
    let parent_at = |parent: &Bytes32| found.get(parent).copied();
    if parents.iter().any(|parent| parent_at(parent) == Some(burner_ph)) {
        Err(AlreadyKnocked.into())
    } else if parents.iter().all(|parent| parent_at(parent).is_some()) {
        Ok(())
    } else if whole {
        Err(AlreadyKnocked.into())
    } else {
        Err(BurnerWait::KnockKeyUnread.into())
    }
}

/// The body of [`burner_write_with`], [`listing_write_with`],
/// [`beacon_write_with`] and [`knock_write_with`]: every step their docs
/// give, with `slot` the rule the key writes under. Every slot is spaced
/// from the other payers' spends after the first `Held` check
/// ([`BurnerWait::Spaced`]). The knock's slot ([`Slot::Once`]) adds two
/// steps between the `Held` checks and the choice of what to write from: no
/// write of the SSF wallet's held under its hint
/// ([`BurnerWait::MoneyUnderHint`]), then its own question
/// ([`knock_key_unwritten`]). The listing's ([`Slot::Listing`]) adds one
/// there: the spent coins of a whole listing against the lease's records of
/// its own spends ([`ForeignSpend`]). A rewritten slot ([`Slot::Rewritten`])
/// reads the key's listing exactly as [`unspent_at`] gives it
/// ([`Unspent::of`]) and never looks at its spent records.
#[allow(clippy::too_many_arguments)]
async fn write_slot<R: rand::Rng + ?Sized + Send>(
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
    money: Option<Payer>,
    slot: Slot,
) -> Result<MemoWrite> {
    let _lease = lease.lock().await;
    lease.ensure_open()?;
    lease.reconcile_at(net, client, now).await;
    let payer = Payer::of_burner(key);
    let burner_ph = key.puzzle_hash();
    if lease.outgoing_pending_for(payer) || lease.parks_spend_at(burner_ph) {
        return Err(BurnerWait::Held.into());
    }
    match lease.spacing(payer, burner_ph, now, rng) {
        Spacing::Clear => {}
        Spacing::InFlight => return Err(BurnerWait::Spaced.into()),
        Spacing::Due(block) => {
            let peak = client.peak_height().await.map_err(|_| BurnerWait::PeakUnavailable)?;
            if peak < block {
                return Err(BurnerWait::Spaced.into());
            }
            // Met: the key's later writes are not asked the peak for this
            // wait again.
            lease.spacing_met(payer, block);
        }
    }
    let (records, partial) = records_at(client, burner_ph).await?;
    let coins = Unspent::of(&records, partial).coins;
    let ones: Vec<FaucetCoin> = coins.into_iter().filter(|c| c.coin.amount == 1).collect();
    if ones.iter().any(|c| lease.is_parked(&c.coin.coin_id())) {
        return Err(BurnerWait::Held.into());
    }
    if slot == Slot::Listing && !partial {
        // Every spend of ours at this key is in the lease's records by now:
        // one still parked was waited on above, and the records are written
        // with the parking. A listing cut short is not compared, since the
        // first look adopts what it is shown and must be shown everything.
        let spent: Vec<&CoinRecord> = records.iter().filter(|r| r.spent).collect();
        let ids: Vec<Bytes32> = spent.iter().map(|r| r.coin.coin_id()).collect();
        let foreign = lease.foreign_spends(&ids);
        let last = spent
            .iter()
            .map(|r| (r.spent_block_index, r.coin.coin_id()))
            .filter(|(_, id)| foreign.contains(id))
            .max();
        if let Some((_, coin)) = last {
            return Err(ForeignSpend { coin }.into());
        }
    }
    if let Slot::Once { money: wallet } = slot {
        // The lease as this write is made, under the gate taken above, so
        // read through the form for a holder of the gate:
        // `WalletLease::held_writes_under` would wait on it forever.
        if lease.held_writes_under_locked(hint).iter().any(|w| w.payer.is_none_or(|paid_by| paid_by == wallet)) {
            return Err(BurnerWait::MoneyUnderHint.into());
        }
        let unheld: Vec<Coin> = ones.iter().filter(|c| !lease.is_taken(&c.coin.coin_id())).map(|c| c.coin).collect();
        knock_key_unwritten(client, burner_ph, &records, partial, &unheld).await?;
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
            if money.is_some_and(|money| lease.outgoing_pending_for(money)) {
                return Err(BurnerWait::MoneyInFlight.into());
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
    let acked = match push_parked_as(lease, client, payer, slot.resend(), built.bundle, [built.parked]).await {
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
/// own: its one caller, the claim-and-write self-test hook
/// ([`claim_write_selftest`]), runs only with SSF_CHIA_BURNERS=1 on a test
/// network (§13 row 9), and keeps no mark. The listing does not come
/// through here: it reaches [`burner_write_with`] through its own wrapper
/// (`chia_publish::publish_burner_presence`, §13 row 10), and the heartbeat
/// files its write in the presence mark. Neither does a knock: its key
/// writes once, through [`knock_write_with`] (`chia_publish::publish_knock_with`),
/// and the heartbeat files its write in `knocks.json`. Nor does the beacon:
/// its key B writes through [`beacon_write_with`]
/// (`chia_publish::publish_beacon_with`), and the heartbeat files its write
/// in the beacon mark. This writes a slot that is rewritten.
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
    burner_write_with(&WALLET_LEASE, &GIFT_FUSE, net, &client, Instant::now(), key, era, hint, gate, body, &mut rand::rngs::OsRng, what, None).await
}

/// The blake3 `derive_key` context of the claim-and-write self-test's hint.
const CTX_CLAIM_WRITE_TEST: &str = "ssf-chia-claim-write-test-v1";

/// The prefix of the self-test's log lines, as the craps self-test has its own.
const SELFTEST: &str = "⛓️🧪 claim-write selftest";

/// How many times the self-test asks the writer while it only waits
/// ([`BurnerWait`]), and how long it waits between asks: 44 minutes of
/// waiting in all, past the longest T4 holds a burner behind ONE spend of
/// another payer's, 20 minutes while it is in flight and 64 blocks, about
/// 20 minutes more, once it has landed
/// (`chia_publish::SPACING_IN_FLIGHT_HOLD`,
/// `chia_publish::SPACING_MAX_BLOCKS`). A node whose other keys keep
/// writing meanwhile can hold it longer, and the test then gives up with
/// its last wait; it is run again.
const SELFTEST_TRIES: u32 = 45;
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
/// It writes through [`burner_write`], the rewrite slot, and not the knock's
/// write-once slot ([`knock_write_with`]). h_test is no knock's hint, so no
/// host could be knocked twice, and a rerun in the same era must still
/// exercise the write path: an earlier run's write that lands in that
/// moment would end the rerun on the write-once slot in [`AlreadyKnocked`],
/// an error that is no wait, where this one writes from its coin and says
/// the test already ran.
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
    // 🔎 Under the audit switch alone (stage 4 design §11): the address of
    // the test's key, which the lobby dish's history shows as a recipient.
    if super::audit::audit_enabled() {
        println!("{}", super::audit::audit_line(net, super::audit::AuditKey::SelfTest { era }, Payer::of_burner(&key)));
    }

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
        let write = burner_write_with(&lease, &fuse, net, &chain, Instant::now(), &burner(net, 1), 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, "test", None).await;
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
            let write = burner_write_with(&lease, &fuse, net, &chain, Instant::now(), &key, 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, "test", None).await;
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
        let write = burner_write_with(&lease, &fuse, net, &chain, Instant::now(), &key, 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, "test", None).await;
        let e = write.err().expect("the write waits");
        assert!(e.downcast_ref::<CoinLookupFailed>().is_some(), "a failed read: {e:#}");
        assert!(!crate::chia_publish::knock_attempt_counts(true, &e), "a failed read is no knock attempt (§5.2)");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "the burner's listing, then the refund's, unanswered");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 1, "the gift kept counted");
        assert_eq!(chain.sent.load(std::sync::atomic::Ordering::Relaxed), 0, "nothing pushed");
    }

    /// The `n`th test knock key on `net`: the root's knock key of the 32
    /// bytes `[n; 32]` in era 0, so each `n` is another knock.
    fn knock(net: ChiaNet, n: u8) -> BurnerKey {
        BurnerRoot::of(&money(), net).knock(&[n; 32], 0)
    }

    /// `coin`'s record, confirmed at [`SEEN_AT`], and spent a block later
    /// when `spent`.
    fn record(coin: Coin, spent: bool) -> CoinRecord {
        CoinRecord { coin, confirmed_block_index: SEEN_AT, spent, spent_block_index: if spent { SEEN_AT + 1 } else { 0 } }
    }

    /// One page of `records`, whole, or cut short with no cursor to follow
    /// when `truncated`.
    fn page(records: Vec<CoinRecord>, truncated: bool) -> crate::chia_chain::CoinListing {
        crate::chia_chain::CoinListing { records, truncated, next_cursor: None, judged_at: None }
    }

    /// The bundles handed to `chain`.
    fn sent(chain: &crate::chia_chain::testing::Scripted) -> usize {
        chain.sent.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// The SSF wallet's payer: the address of the money key the test
    /// burners are derived from ([`money`]).
    fn ssf_wallet() -> Payer {
        Payer::of(&SecretKey::from_seed(&[7u8; 32]))
    }

    /// `key`'s knock on `chain` on testnet11 in era 0, with a fresh lease,
    /// `fuse`, the test hint and body, a seeded random source and the SSF
    /// wallet's payer.
    async fn knock_on(chain: &crate::chia_chain::testing::Scripted, fuse: &Mutex<GiftFuse>, key: &BurnerKey) -> Result<MemoWrite> {
        knock_on_lease(&WalletLease::new(), chain, fuse, key).await
    }

    /// [`knock_on`] on a given lease.
    async fn knock_on_lease(lease: &WalletLease, chain: &crate::chia_chain::testing::Scripted, fuse: &Mutex<GiftFuse>, key: &BurnerKey) -> Result<MemoWrite> {
        knock_on_lease_at(lease, chain, fuse, key, Instant::now()).await
    }

    /// [`knock_on_lease`] at a given instant.
    async fn knock_on_lease_at(lease: &WalletLease, chain: &crate::chia_chain::testing::Scripted, fuse: &Mutex<GiftFuse>, key: &BurnerKey, now: Instant) -> Result<MemoWrite> {
        use rand::SeedableRng;
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        knock_write_with(lease, fuse, ChiaNet::Testnet11, chain, now, key, 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, ssf_wallet()).await
    }

    /// The instant a spend parked now has been in flight for as long as T4
    /// holds another payer behind it (stage 4 design §4.3,
    /// `SPACING_IN_FLIGHT_HOLD`): from then on the checks past T4's are
    /// reached. The spend is long due for the lease's reconciliation by
    /// then, which asks the chain for its coin before the writer asks
    /// anything: a test scripts that answer first ([`unjudged`]).
    fn past_the_hold() -> Instant {
        Instant::now() + crate::chia_publish::SPACING_IN_FLIGHT_HOLD
    }

    /// The reconciliation's answer that says nothing of a parked coin: a
    /// page that names no coin and is not dated, so the spend stays parked
    /// and no liveness question is put.
    fn unjudged() -> crate::chia_chain::CoinListing {
        page(vec![], false)
    }

    /// The self-test waits past the longest T4 holds its burner behind
    /// another payer's spend (stage 4 design §4.3): the hold on one in
    /// flight, then the most blocks after it landed, at the chain's 18.75 s
    /// a block. Its waits are one fewer than its tries.
    #[test]
    fn the_self_test_waits_out_the_longest_spacing_between_payers() {
        use crate::chia_publish::{SPACING_IN_FLIGHT_HOLD, SPACING_MAX_BLOCKS};
        let longest = SPACING_IN_FLIGHT_HOLD + std::time::Duration::from_millis(18_750) * SPACING_MAX_BLOCKS;
        assert_eq!(longest, std::time::Duration::from_secs(40 * 60));
        assert!(SELFTEST_RETRY * (SELFTEST_TRIES - 1) >= longest, "{SELFTEST_TRIES} tries, {} s apart", SELFTEST_RETRY.as_secs());
        assert!(SELFTEST_RETRY * (SELFTEST_TRIES - 1) < longest + std::time::Duration::from_secs(10 * 60), "and not much longer");
    }

    /// A fuse that has counted one gift to `key` in era 0, and `strangers`
    /// more to other burners.
    fn fuse_holding(key: &BurnerKey, strangers: u8) -> Mutex<GiftFuse> {
        Mutex::new(GiftFuse::preset(0, std::iter::once(Payer::of_burner(key)).chain(payers(strangers))))
    }

    /// Stage 4 design §4.1, the knock row: K(h) is never spent again. One
    /// listing shows the key's coin of 1 mojo, unspent, and the lookup of its
    /// parent shows the parent at the key too (g, spent, its record missing
    /// from the listing): the coin is the key's own write. The rewrite slot
    /// writes from it, one push from that coin with no parent asked, as the
    /// listing's key does; the knock slot reads the key as already knocked,
    /// after one listing and one lookup by id, and sends nothing and counts
    /// no gift. The error is no wait, and its text names neither the key's
    /// payer, its puzzle hash nor its address.
    #[tokio::test]
    async fn a_knock_key_holding_its_own_write_is_already_knocked_where_a_rewritten_slot_would_write_from_it() {
        use crate::chia_chain::testing::Scripted;
        use rand::SeedableRng;
        let net = ChiaNet::Testnet11;
        let key = knock(net, 1);
        let ph = key.puzzle_hash();
        let g = Coin::new(Bytes32::new([3; 32]), ph, 1);
        let written = Coin::new(g.coin_id(), ph, 1);

        let chain = Scripted::new(vec![page(vec![record(written, false)], false)]);
        let (lease, fuse) = (WalletLease::new(), Mutex::new(GiftFuse::new()));
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        let write = burner_write_with(&lease, &fuse, net, &chain, Instant::now(), &key, 0, Bytes32::new(HINT), None, |_| Ok(BODY.to_vec()), &mut rng, "test", None).await;
        let write = write.expect("the rewritten slot writes from its coin");
        assert_eq!(write.coins, WriteCoins::one(written.coin_id()), "from the key's own coin");
        assert_eq!(sent(&chain), 1, "one push");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true], "the key's listing alone");
        assert!(chain.asked_names.lock().unwrap().is_empty(), "no parent asked");

        let chain = Scripted::new(vec![page(vec![record(written, false)], false), page(vec![record(g, true)], false)]);
        let fuse = Mutex::new(GiftFuse::new());
        let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<AlreadyKnocked>(), Some(&AlreadyKnocked), "{e:#}");
        assert!(e.downcast_ref::<BurnerWait>().is_none(), "no wait: {e:#}");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "one listing, then one lookup by id");
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![g.coin_id()]], "the coin's parent");
        assert_eq!(sent(&chain), 0, "nothing sent");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");

        assert_eq!(e.to_string(), "a knock on this host for this room already went out this era from its own key, and a knock's key writes once");
        let text = format!("{e:#} {e:?}");
        let address = crate::chia_faucet::bech32m::encode(net.prefix(), ph.as_ref());
        for named in [Payer::of_burner(&key).hex(), hex::encode(ph), address] {
            assert!(!text.contains(&named), "{text}");
        }
    }

    /// Stage 4 design §4.1, the knock row, and §5.2: a key that spent any
    /// coin has written, since only its key can spend at its puzzle hash. A
    /// landed knock (g spent, its written coin unspent), the same with that
    /// coin since spent elsewhere (a cloned folder, §10), and a spent stray
    /// of 2 mojos each read as already knocked from the key's one listing:
    /// no parent is asked and nothing is sent. The fuse is never asked: a
    /// gift it counted for the key stays counted, with no refund, and a
    /// blown fuse (the key's gift and fifteen strangers') is not the answer.
    #[tokio::test]
    async fn a_knock_key_that_spent_any_coin_is_already_knocked_from_one_listing_past_a_counted_gift_or_a_blown_fuse() {
        use crate::chia_chain::testing::Scripted;
        let key = knock(ChiaNet::Testnet11, 1);
        let ph = key.puzzle_hash();
        let g = Coin::new(Bytes32::new([3; 32]), ph, 1);
        let written = Coin::new(g.coin_id(), ph, 1);
        let stray = Coin::new(Bytes32::new([4; 32]), ph, 2);
        let rows = [
            ("a landed knock", vec![record(g, true), record(written, false)]),
            ("its coin spent elsewhere", vec![record(g, true), record(written, true)]),
            ("a spent stray of 2 mojos", vec![record(stray, true)]),
        ];
        for (what, records) in rows {
            for (strangers, gifts) in [(0, 1), (15, 16)] {
                let chain = Scripted::new(vec![page(records.clone(), false)]);
                let fuse = fuse_holding(&key, strangers);
                let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock is not written");
                assert_eq!(e.downcast_ref::<AlreadyKnocked>(), Some(&AlreadyKnocked), "{what}, {gifts} gifts: {e:#}");
                assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true], "{what}, {gifts} gifts: one listing");
                assert!(chain.asked_names.lock().unwrap().is_empty(), "{what}, {gifts} gifts: no parent asked");
                assert_eq!(sent(&chain), 0, "{what}, {gifts} gifts: nothing sent");
                assert_eq!(fuse.lock().unwrap().gifts_in(0), gifts, "{what}: the counted gifts stay counted");
            }
        }
    }

    /// A knock key's listing cut short (truncated with no cursor) cannot say
    /// the key never wrote: a record past the cut could be its. The knock
    /// waits, typed as [`BurnerWait::KnockKeyUnread`], which is no knock
    /// attempt, whatever the cut listing shows: nothing, a spent record of 1
    /// mojo, or a lone coin of 1 mojo. Only the one listing is read, no
    /// parent is asked, nothing is sent, and a gift counted for the key stays
    /// counted.
    #[tokio::test]
    async fn a_knock_key_whose_listing_is_cut_short_waits_typed_and_asks_nothing_more() {
        use crate::chia_chain::testing::Scripted;
        let key = knock(ChiaNet::Testnet11, 1);
        let ph = key.puzzle_hash();
        let g = Coin::new(Bytes32::new([3; 32]), ph, 1);
        let rows = [("nothing", vec![]), ("a spent record of 1 mojo", vec![record(g, true)]), ("a lone coin of 1 mojo", vec![record(g, false)])];
        for (what, records) in rows {
            let chain = Scripted::new(vec![page(records, true)]);
            let fuse = fuse_holding(&key, 0);
            let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock waits");
            assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::KnockKeyUnread), "{what}: {e:#}");
            assert!(crate::chia_publish::is_typed_wait(&e), "{what}: a wait");
            assert!(!crate::chia_publish::knock_attempt_counts(true, &e), "{what}: no knock attempt (§5.2)");
            assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true], "{what}: the one listing");
            assert!(chain.asked_names.lock().unwrap().is_empty(), "{what}: no parent asked");
            assert_eq!(sent(&chain), 0, "{what}: nothing sent");
            assert_eq!(fuse.lock().unwrap().gifts_in(0), 1, "{what}: the gift kept counted");
        }
    }

    /// Stage 4 design §5.4: the peers we push a knock to see its key's
    /// puzzle hash in the clear, as the keyless claim's recipient, so one can
    /// push our claim of F alone (g lands unspent at the key) or pay a coin
    /// of exactly 1 mojo there. Neither cancels the knock. A lone 1-mojo coin
    /// whose parent the lookup by id shows elsewhere (F at the lobby dish) is
    /// written from, once, as a rewrite is: one push from that coin, and no
    /// gift counted. A parent at the key itself is the key's own write, and
    /// a parent the lookup does not return could be; both read as already
    /// knocked and send nothing, and so does a second lone coin whose parent
    /// is at the key beside one whose parent is elsewhere.
    #[tokio::test]
    async fn a_lone_one_mojo_coin_at_a_knock_key_is_written_from_once_unless_a_parent_is_the_key_or_not_returned() {
        use crate::chia_chain::testing::Scripted;
        let net = ChiaNet::Testnet11;
        let key = knock(net, 1);
        let ph = key.puzzle_hash();
        let f = Coin::new(Bytes32::new([5; 32]), FaucetParams::lobby(net).puzzle_hash(), 10);
        let lifted = Coin::new(f.coin_id(), ph, 1);
        let at_key = Coin::new(Bytes32::new([3; 32]), ph, 1);
        let written = Coin::new(at_key.coin_id(), ph, 1);

        let chain = Scripted::new(vec![page(vec![record(lifted, false)], false), page(vec![record(f, true)], false)]);
        let fuse = Mutex::new(GiftFuse::new());
        let write = knock_on(&chain, &fuse, &key).await.expect("written from the lone coin");
        assert_eq!(write.coins, WriteCoins::one(lifted.coin_id()), "from that coin, as a rewrite is");
        assert_eq!(write.payer, Payer::of_burner(&key));
        assert!(!write.acked, "the test chain leaves the push unanswered");
        assert_eq!(sent(&chain), 1, "one push");
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![f.coin_id()]], "its parent, by id");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");

        let rows = [
            ("a parent at the key", vec![record(written, false)], vec![record(at_key, true)]),
            ("a parent not returned", vec![record(lifted, false)], vec![]),
            ("one parent elsewhere, one at the key", vec![record(lifted, false), record(written, false)], vec![record(f, true), record(at_key, true)]),
        ];
        for (what, listed, parents) in rows {
            let chain = Scripted::new(vec![page(listed, false), page(parents, false)]);
            let fuse = Mutex::new(GiftFuse::new());
            let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock is not written");
            assert_eq!(e.downcast_ref::<AlreadyKnocked>(), Some(&AlreadyKnocked), "{what}: {e:#}");
            assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "{what}: one listing, one lookup by id");
            assert_eq!(sent(&chain), 0, "{what}: nothing sent");
            assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "{what}: no gift counted");
        }
    }

    /// A lookup by id cut short says nothing of the coins it left out, as
    /// every reader of one takes it (`chia_resolve::coin_heights`). A lone
    /// 1-mojo coin at a knock key whose parent the lookup left out, cut short
    /// with no cursor (the peer lane's cut), is a wait typed as
    /// [`BurnerWait::KnockKeyUnread`], no knock attempt and not
    /// [`AlreadyKnocked`], so the knock arm queues it again and does not
    /// note the host: nothing is sent or counted. A parent the cut lookup
    /// did return at the key is already knocked all the same, and a cursor
    /// the lookup gives is followed, so a parent elsewhere on its second
    /// page lets the knock go out from the coin, with no gift. Every page's
    /// coins count: two lone coins whose parents come on two pages are both
    /// judged, and a parent at the key on a first page is already knocked
    /// though the second page is cut short.
    #[tokio::test]
    async fn a_lone_coins_parent_left_out_of_a_lookup_cut_short_is_a_wait_and_one_past_its_cursor_is_read() {
        use crate::chia_chain::testing::Scripted;
        let net = ChiaNet::Testnet11;
        let key = knock(net, 1);
        let ph = key.puzzle_hash();
        let f = Coin::new(Bytes32::new([5; 32]), FaucetParams::lobby(net).puzzle_hash(), 10);
        let lifted = Coin::new(f.coin_id(), ph, 1);
        let at_key = Coin::new(Bytes32::new([3; 32]), ph, 1);
        let written = Coin::new(at_key.coin_id(), ph, 1);

        let chain = Scripted::new(vec![page(vec![record(lifted, false)], false), page(vec![], true)]);
        let fuse = Mutex::new(GiftFuse::new());
        let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock waits");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::KnockKeyUnread), "{e:#}");
        assert!(crate::chia_publish::already_knocked(&e).is_none(), "not read as knocked, so the host is not noted: {e:#}");
        assert!(crate::chia_publish::is_typed_wait(&e), "a wait");
        assert!(!crate::chia_publish::knock_attempt_counts(true, &e), "no knock attempt (§5.2)");
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![f.coin_id()]], "its parent, by id, once");
        assert_eq!(sent(&chain), 0, "nothing sent");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");

        let listed = vec![record(lifted, false), record(written, false)];
        let chain = Scripted::new(vec![page(listed, false), page(vec![record(at_key, true)], true)]);
        let fuse = Mutex::new(GiftFuse::new());
        let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<AlreadyKnocked>(), Some(&AlreadyKnocked), "a parent at the key, though the lookup was cut short: {e:#}");
        assert_eq!(sent(&chain), 0, "nothing sent");

        let first = crate::chia_chain::CoinListing { records: vec![], truncated: true, next_cursor: Some("page-2".into()), judged_at: None };
        let chain = Scripted::new(vec![page(vec![record(lifted, false)], false), first, page(vec![record(f, true)], false)]);
        let fuse = Mutex::new(GiftFuse::new());
        let write = knock_on(&chain, &fuse, &key).await.expect("written from the lone coin");
        assert_eq!(write.coins, WriteCoins::one(lifted.coin_id()), "from that coin, as a rewrite is");
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![f.coin_id()], vec![f.coin_id()]], "the lookup's second page");
        assert_eq!(sent(&chain), 1, "one push");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");

        // Every page's coins are kept as the lookup goes on. Two lone coins
        // whose parents are elsewhere, one parent on each of two pages, are
        // both judged, and the knock goes out from one of them; a parent at
        // the key on the first page is already knocked, though the second
        // page is cut short.
        let to_page_2 = |records| crate::chia_chain::CoinListing { records, truncated: true, next_cursor: Some("page-2".into()), judged_at: None };
        let g = Coin::new(Bytes32::new([6; 32]), FaucetParams::lobby(net).puzzle_hash(), 10);
        let lifted_too = Coin::new(g.coin_id(), ph, 1);
        let mut parents = vec![f.coin_id(), g.coin_id()];
        parents.sort();
        let listed = vec![record(lifted, false), record(lifted_too, false)];
        let chain = Scripted::new(vec![page(listed, false), to_page_2(vec![record(f, true)]), page(vec![record(g, true)], false)]);
        let fuse = Mutex::new(GiftFuse::new());
        let write = knock_on(&chain, &fuse, &key).await.expect("written from a lone coin");
        assert_eq!(write.coins, WriteCoins::one(lifted.coin_id().min(lifted_too.coin_id())), "from the first of the two, as a rewrite picks");
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![parents.clone(), parents], "both parents, over two pages");
        assert_eq!(sent(&chain), 1, "one push");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");

        let chain = Scripted::new(vec![page(vec![record(written, false)], false), to_page_2(vec![record(at_key, true)]), page(vec![], true)]);
        let fuse = Mutex::new(GiftFuse::new());
        let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<AlreadyKnocked>(), Some(&AlreadyKnocked), "a parent at the key on the first page, the second cut short: {e:#}");
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![at_key.coin_id()], vec![at_key.coin_id()]], "the lookup's second page");
        assert_eq!(sent(&chain), 0, "nothing sent");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");
    }

    /// A knock that the lease holds in flight waits [`BurnerWait::Held`]
    /// before anything else is judged, as every burner write does. A spend
    /// parked under the key as its payer holds it before the key's listing is
    /// read, and before T4 is asked. A 1-mojo coin at the key that the lease
    /// parks under another payer's record, with a bundle that spends no coin
    /// there (a payer the lease filed can be lost, §8 (6)), reads to T4 as
    /// another payer's spend in flight: the knock waits its turn
    /// ([`BurnerWait::Spaced`]) with the key's listing unread, and once T4
    /// holds it no longer the coin holds it, as soon as the listing shows
    /// the coin, with no parent asked of it.
    #[tokio::test]
    async fn a_knock_the_lease_holds_in_flight_is_held_before_its_key_is_judged() {
        use crate::chia_chain::testing::Scripted;
        let net = ChiaNet::Testnet11;
        let key = knock(net, 1);
        let coin = Coin::new(Bytes32::new([3; 32]), key.puzzle_hash(), 1);
        let bundle = SpendBundle::new(vec![], chia_bls::Signature::default());
        let other = Payer::of_burner(&burner(net, 2));

        let chain = Scripted::new(vec![page(vec![record(coin, false)], false)]);
        let (lease, fuse) = (WalletLease::new(), Mutex::new(GiftFuse::new()));
        lease.park_with_bundle([Bytes32::new([5; 32])], &bundle, Payer::of_burner(&key)).unwrap();
        let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("the knock is held");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::Held), "its own spend: {e:#}");
        assert!(chain.asked_spent.lock().unwrap().is_empty() && chain.asked_names.lock().unwrap().is_empty(), "held before the key's listing is read");
        assert_eq!(sent(&chain), 0);

        let chain = Scripted::new(vec![unjudged(), page(vec![record(coin, false)], false)]);
        let (lease, fuse) = (WalletLease::new(), Mutex::new(GiftFuse::new()));
        lease.park_with_bundle([coin.coin_id()], &bundle, other).unwrap();
        let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("the knock waits its turn");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::Spaced), "its coin under another payer, parked a moment ago: {e:#}");
        assert!(chain.asked_spent.lock().unwrap().is_empty(), "spaced before the key's listing is read");
        let e = knock_on_lease_at(&lease, &chain, &fuse, &key, past_the_hold()).await.err().expect("the knock is held");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::Held), "its coin under another payer, once T4 holds it no longer: {e:#}");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "the lease's parked coin, then the key's listing");
        assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![coin.coin_id()]], "the lease's own question: no parent asked");
        assert_eq!(sent(&chain), 0);
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");
    }

    /// Stage 4 design §8.3: a knock's key never writes beside a write of the
    /// SSF wallet's under its hint. A memo write the lease holds under the
    /// knock's hint that the SSF wallet paid for, parked or settling, or one
    /// with no payer filed, holds the knock as [`BurnerWait::MoneyUnderHint`],
    /// a wait, once the key's listing is read: no parent is asked, and
    /// nothing is claimed, sent or counted. Such a write is another payer's
    /// spend too, so while it is in flight, or landed fewer blocks ago than
    /// the wait drawn for it, T4 holds the knock first
    /// ([`BurnerWait::Spaced`], §4.3), with the key's listing unread; this
    /// check is what holds it after that, for as long as the lease holds
    /// the write. A write another burner paid for
    /// under the hint (another host's knock, under a contact key two cards
    /// name), or one of the SSF wallet's under another hint, does not hold
    /// it: the knock goes on to its claim, which waits for the peak it
    /// cannot read.
    #[tokio::test]
    async fn a_knocks_key_does_not_write_beside_a_write_of_the_ssf_wallets_under_its_hint() {
        use crate::chia_chain::testing::Scripted;
        use crate::chia_chain::CoinListing;
        let net = ChiaNet::Testnet11;
        let key = knock(net, 1);
        let sk = SecretKey::from_seed(&[0x74; 32]);
        let coin = Coin::new(Bytes32::new([0x75; 32]), our_puzzle_hash(&sk), 1000);
        let other = Payer::of_burner(&burner(net, 2));
        let rows = [
            ("the SSF wallet's, parked", HINT, Some(ssf_wallet()), false, true),
            ("the SSF wallet's, settling", HINT, Some(ssf_wallet()), true, true),
            ("one with no payer filed, settling", HINT, None, true, true),
            ("another burner's, parked", HINT, Some(other), false, false),
            ("the SSF wallet's under another hint", [0x73; 32], Some(ssf_wallet()), false, false),
        ];
        // Each is another payer's spend to the knock's key, so T4 is asked
        // first (§4.3, `BurnerWait::Spaced`): these rows are read once T4
        // holds the knock no longer, a parked spend 20 minutes on and a
        // settling one with the peak past the longest wait. The lease's
        // reconciliation asks for its coin first, parked or settling.
        let spent_at = SEEN_AT + 1;
        for (what, under, payer, settling, holds) in rows {
            let bundle = crate::chia_publish::build_publish_bundle(net, &sk, coin, Bytes32::new(under), Bytes::new(BODY.to_vec())).unwrap();
            let lease = WalletLease::new();
            let chain = if settling {
                let input = ParkedInput { coin_id: coin.coin_id(), seen_at: Some(SEEN_AT) };
                lease.retire(&[], vec![(1, super::super::Settling { coins: vec![input], spent_at, bundle, payer })], &[], &[], &[], Instant::now());
                // It finds the settling coin spent where the lease holds it.
                let spent = CoinRecord { coin, confirmed_block_index: SEEN_AT, spent: true, spent_block_index: spent_at };
                let found = CoinListing { records: vec![spent], truncated: false, next_cursor: None, judged_at: Some(spent_at + 1) };
                Scripted::new(vec![found, page(vec![], false)]).with_peak(spent_at + crate::chia_publish::SPACING_MAX_BLOCKS)
            } else {
                lease.park_with_bundle([coin.coin_id()], &bundle, payer.expect("a parking names its payer")).unwrap();
                Scripted::new(vec![unjudged(), page(vec![], false)])
            };
            let fuse = Mutex::new(GiftFuse::new());
            let e = knock_on_lease_at(&lease, &chain, &fuse, &key, past_the_hold()).await.err().expect("the knock is not written");
            let expected = if holds { BurnerWait::MoneyUnderHint } else { BurnerWait::PeakUnavailable };
            assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&expected), "{what}: {e:#}");
            assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "{what}: the lease's coin, then the key's listing, once");
            assert_eq!(*chain.asked_names.lock().unwrap(), vec![vec![coin.coin_id()]], "{what}: the lease's own question, and no parent asked");
            assert_eq!(sent(&chain), 0, "{what}: nothing sent");
            assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "{what}: no gift counted");
            assert_eq!((lease.is_settling(&coin.coin_id()), lease.is_parked(&coin.coin_id())), (settling, !settling), "{what}: the lease as it was");
        }

        // Before that, T4 holds the knock, with the key's listing unread: a
        // spend parked a moment ago is in flight; one that landed a block
        // ago holds it until the block drawn, and with no peak to compare
        // that block with the knock waits, fail closed.
        let under_hint = || crate::chia_publish::build_publish_bundle(net, &sk, coin, Bytes32::new(HINT), Bytes::new(BODY.to_vec())).unwrap();
        let landed = || {
            let lease = WalletLease::new();
            let input = ParkedInput { coin_id: coin.coin_id(), seen_at: Some(SEEN_AT) };
            lease.retire(&[], vec![(1, super::super::Settling { coins: vec![input], spent_at, bundle: under_hint(), payer: Some(ssf_wallet()) })], &[], &[], &[], Instant::now());
            let spent = CoinRecord { coin, confirmed_block_index: SEEN_AT, spent: true, spent_block_index: spent_at };
            (lease, CoinListing { records: vec![spent], truncated: false, next_cursor: None, judged_at: Some(spent_at + 1) })
        };
        let fuse = Mutex::new(GiftFuse::new());
        let (lease, chain) = (WalletLease::new(), Scripted::new(vec![page(vec![], false)]));
        lease.park_with_bundle([coin.coin_id()], &under_hint(), ssf_wallet()).unwrap();
        let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::Spaced), "the SSF wallet's, parked a moment ago: {e:#}");
        assert!(chain.asked_spent.lock().unwrap().is_empty(), "the key's listing unread");
        for (what, peak, expected) in [
            ("no peak", None, BurnerWait::PeakUnavailable),
            ("31 blocks on", Some(spent_at + crate::chia_publish::SPACING_MIN_BLOCKS - 1), BurnerWait::Spaced),
        ] {
            let (lease, found) = landed();
            let chain = Scripted::new(vec![found, page(vec![], false)]);
            let chain = match peak {
                Some(peak) => chain.with_peak(peak),
                None => chain,
            };
            let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("the knock is not written");
            assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&expected), "the SSF wallet's, landed a block ago, {what}: {e:#}");
            assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true], "{what}: the lease's settling coin alone, the key's listing unread");
            assert_eq!(sent(&chain), 0, "{what}: nothing sent");
        }
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");

        // The order of the knock's checks (`knock_write_with`'s doc). With
        // the SSF wallet's write held under the hint, a key whose own write
        // the chain lists, a spent record at the key, waits on the wallet's
        // write and is not read as already knocked, which would end the
        // knock for the era before the arm's step filed the wallet's write.
        // Without the wallet's write the same listing is already knocked.
        // And a spend the lease holds for the key itself is held before
        // either is asked, with the key's listing unread.
        let wrote = || page(vec![record(Coin::new(Bytes32::new([4; 32]), key.puzzle_hash(), 1), true)], false);
        let fuse = Mutex::new(GiftFuse::new());
        let (lease, chain) = (WalletLease::new(), Scripted::new(vec![unjudged(), wrote()]));
        lease.park_with_bundle([coin.coin_id()], &under_hint(), ssf_wallet()).unwrap();
        let e = knock_on_lease_at(&lease, &chain, &fuse, &key, past_the_hold()).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::MoneyUnderHint), "the wallet's write is asked of before the key's own: {e:#}");
        assert_eq!(e.downcast_ref::<AlreadyKnocked>(), None, "a wait, not a drop: {e:#}");
        let chain = Scripted::new(vec![wrote()]);
        let e = knock_on_lease(&WalletLease::new(), &chain, &fuse, &key).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<AlreadyKnocked>(), Some(&AlreadyKnocked), "with no write of the wallet's held: {e:#}");
        let (lease, chain) = (WalletLease::new(), Scripted::new(vec![wrote()]));
        lease.park_with_bundle([coin.coin_id()], &under_hint(), ssf_wallet()).unwrap();
        lease.park_with_bundle([Bytes32::new([5; 32])], &SpendBundle::new(vec![], chia_bls::Signature::default()), Payer::of_burner(&key)).unwrap();
        let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("the knock is held");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::Held), "the key's own spend first: {e:#}");
        assert!(chain.asked_spent.lock().unwrap().is_empty(), "held before the key's listing is read");
        assert_eq!(sent(&chain), 0, "nothing sent");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");
    }

    /// T4's wait, once met, is not asked of the peak again (stage 4 design
    /// §4.3). Another burner's spend landed a block ago. With the agreed
    /// peak at the latest block a wait can be drawn to, the knock's writer
    /// goes on past T4, and the lease keeps the wait as met. The key's next
    /// write, on a chain that gives no peak, is then not failed by T4 with
    /// the key's listing unread, as a wait still owed is, fail closed: it
    /// reads its listing and goes on to its claim, which waits for the peak
    /// it cannot read.
    #[tokio::test]
    async fn a_knock_whose_wait_the_peak_met_is_not_asked_the_peak_for_it_again() {
        use crate::chia_chain::testing::Scripted;
        use crate::chia_chain::CoinListing;
        use crate::chia_publish::SPACING_MAX_BLOCKS;
        use rand::SeedableRng;
        let net = ChiaNet::Testnet11;
        let key = knock(net, 1);
        let payer = Payer::of_burner(&key);
        let other = burner(net, 2);
        let coin = Coin::new(Bytes32::new([0x76; 32]), other.puzzle_hash(), 1);
        let spent_at = SEEN_AT + 1;
        let lease = WalletLease::new();
        let input = ParkedInput { coin_id: coin.coin_id(), seen_at: Some(SEEN_AT) };
        let bundle = SpendBundle::new(vec![], chia_bls::Signature::default());
        lease.retire(&[], vec![(1, super::super::Settling { coins: vec![input], spent_at, bundle, payer: Some(Payer::of_burner(&other)) })], &[], &[], &[], Instant::now());
        let found = || {
            let spent = CoinRecord { coin, confirmed_block_index: SEEN_AT, spent: true, spent_block_index: spent_at };
            CoinListing { records: vec![spent], truncated: false, next_cursor: None, judged_at: Some(spent_at + 1) }
        };
        let fuse = Mutex::new(GiftFuse::new());
        let ask = |lease: &WalletLease| lease.spacing(payer, key.puzzle_hash(), Instant::now(), &mut rand::rngs::StdRng::seed_from_u64(9));

        // Still owed, and no peak to compare its block with: T4 fails
        // closed, the key's listing unread.
        let chain = Scripted::new(vec![found(), page(vec![], false)]);
        let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::PeakUnavailable), "{e:#}");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true], "the lease's settling coin alone");
        assert!(matches!(ask(&lease), Spacing::Due(block) if block <= spent_at + SPACING_MAX_BLOCKS), "a wait is kept, not met");

        // The peak at the latest block it can be due at: past T4, to the
        // key's listing and on.
        let chain = Scripted::new(vec![found(), page(vec![], false)]).with_peak(spent_at + SPACING_MAX_BLOCKS);
        let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("no dish is scripted, so nothing is written");
        assert_ne!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::Spaced), "{e:#}");
        assert!(chain.asked_spent.lock().unwrap().len() >= 2, "the key's listing was read");
        assert_eq!(ask(&lease), Spacing::Clear, "the wait is met");
        assert!(lease.is_settling(&coin.coin_id()), "with the landing still on the lease");

        // No peak now: T4 asks for none, so the key's listing is read, and
        // the claim is what waits for the peak.
        let chain = Scripted::new(vec![found(), page(vec![], false)]);
        let e = knock_on_lease(&lease, &chain, &fuse, &key).await.err().expect("the knock is not written");
        assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::PeakUnavailable), "{e:#}");
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "the lease's coin, then the key's listing: T4 let it by");
        assert_eq!(sent(&chain), 0, "nothing sent");
        assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "no gift counted");
    }

    /// R7 at a knock's key: a coin of any amount but 1 mojo is a stray,
    /// never written from, and anyone can pay one there, so it does not stop
    /// the knock. With only an unspent stray listed, no parent is asked and
    /// the knock goes on to its claim, which waits for the peak it cannot
    /// read: nothing is built from the stray or sent. A gift counted for the
    /// key is given back, since the refund's own listing shows only the
    /// stray, no coin of 1 mojo.
    #[tokio::test]
    async fn a_stray_of_another_amount_at_a_knock_key_is_no_knock_and_never_written_from() {
        use crate::chia_chain::testing::Scripted;
        let key = knock(ChiaNet::Testnet11, 1);
        for amount in [0, 2, 1_000] {
            let stray = vec![record(Coin::new(Bytes32::new([4; 32]), key.puzzle_hash(), amount), false)];
            for (counted, listings) in [(false, vec![true]), (true, vec![true, true])] {
                let chain = Scripted::new(vec![page(stray.clone(), false), page(stray.clone(), false)]);
                let fuse = if counted { fuse_holding(&key, 0) } else { Mutex::new(GiftFuse::new()) };
                let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock waits");
                let what = format!("a stray of {amount}, a gift counted: {counted}");
                assert_eq!(e.downcast_ref::<BurnerWait>(), Some(&BurnerWait::PeakUnavailable), "{what}: {e:#}");
                assert_eq!(*chain.asked_spent.lock().unwrap(), listings, "{what}: the key's listing, and the refund's for a counted gift");
                assert!(chain.asked_names.lock().unwrap().is_empty(), "{what}: no parent asked");
                assert_eq!(sent(&chain), 0, "{what}: nothing sent");
                assert_eq!(fuse.lock().unwrap().gifts_in(0), 0, "{what}: no gift counted, or the counted one given back");
            }
        }
    }

    /// Stage 4 design §5.2: a knock that cannot read the chain waits and
    /// uses no attempt. The lookup of a lone coin's parent is not given, or,
    /// with no coin there and a gift counted for the key, the refund's
    /// listing is not: either way the knock waits, typed as the failed read
    /// it is ([`CoinLookupFailed`]), which the knock arm re-queues as a wait
    /// and counts as no attempt. It is not read as already knocked, nothing
    /// is sent, and the counted gift stays counted.
    #[tokio::test]
    async fn a_knock_key_whose_parent_or_refund_lookup_the_chain_does_not_give_waits_typed_as_a_failed_read() {
        use crate::chia_chain::testing::Scripted;
        let key = knock(ChiaNet::Testnet11, 1);
        let lone = Coin::new(Bytes32::new([3; 32]), key.puzzle_hash(), 1);
        let rows = [("the parent's lookup", vec![record(lone, false)], vec![vec![lone.parent_coin_info]]), ("the refund's listing", vec![], vec![])];
        for (what, listed, names) in rows {
            let chain = Scripted::new(vec![page(listed, false)]);
            let fuse = fuse_holding(&key, 0);
            let e = knock_on(&chain, &fuse, &key).await.err().expect("the knock waits");
            assert!(e.downcast_ref::<CoinLookupFailed>().is_some(), "{what}: a failed read: {e:#}");
            assert!(e.downcast_ref::<AlreadyKnocked>().is_none(), "{what}: not read as knocked");
            assert!(crate::chia_publish::is_typed_wait(&e), "{what}: a wait");
            assert!(!crate::chia_publish::knock_attempt_counts(true, &e), "{what}: no knock attempt (§5.2)");
            assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "{what}: the key's listing, then the unanswered read");
            assert_eq!(*chain.asked_names.lock().unwrap(), names, "{what}");
            assert_eq!(sent(&chain), 0, "{what}: nothing sent");
            assert_eq!(fuse.lock().unwrap().gifts_in(0), 1, "{what}: the gift kept counted");
        }
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
