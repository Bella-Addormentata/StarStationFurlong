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

use std::fmt;

use anyhow::{anyhow, Result};
use chia_protocol::{Bytes, Bytes32, Coin, CoinSpend, Program, SpendBundle};
use chia_puzzle_types::DeriveSynthetic;
use chia_sdk_driver::{SpendContext, StandardLayer};
use chia_sdk_types::Conditions;
use clvm_traits::{FromClvm, ToClvm};
use clvm_utils::{tree_hash, CurriedProgram};
use clvmr::{Allocator, NodePtr};

use super::ParkedInput;
use crate::chia_burner::BurnerKey;
use crate::chia_chain::PuzzleAndSolution;
use crate::chia_faucet::{DishClaim, FaucetCoin, FaucetParams, FAUCET_MOD_HASH};
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
#[cfg_attr(not(test), allow(dead_code))] // nothing calls it outside the tests until the burner writer (stage 4 design §13 row 9)
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
#[cfg_attr(not(test), allow(dead_code))] // nothing calls it outside the tests until the burner writer (stage 4 design §13 row 9)
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
#[cfg_attr(not(test), allow(dead_code))] // nothing calls it outside the tests until the burner writer (stage 4 design §13 row 9)
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
}
