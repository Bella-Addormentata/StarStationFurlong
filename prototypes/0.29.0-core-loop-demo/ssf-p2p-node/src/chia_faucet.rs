//! ⛓️🥣 The faucet coin — the node side of the faucet dish (issue #231,
//! onboarding phase beside P8; design note ssf-p2p/faucet-dish-design.md).
//!
//! The "volunteer wallet" is a set of coins at ONE puzzle hash per room and
//! network (the room tag carries the network on mainnet, stage 4 design
//! §3.5: [`FaucetParams::for_room`]), locked by `puzzles/faucet.clsp`.
//! Nobody holds a key for it: the puzzle alone decides how coins leave —
//! exactly one GIFT per coin per GAP blocks, to whoever submits
//! the spend, the rest back to the same puzzle hash, and (for the lobby) no fee
//! at all: the claimer picks the fee and the claimer is anyone, so a fee cap
//! would be a per-window burn allowance. Chialisp cannot act on its own and
//! cannot read other coins, so the chain
//! neither pushes gifts nor checks that a claimer's wallet is empty: the
//! passer-by's node submits the claim (this module), and "only when my wallet is
//! empty" is this node's courtesy rule, not a chain rule.
//!
//! Read side (the default build): the room's faucet address, the coins sitting
//! at it, which of them are ready, and the status the browser draws the dish
//! from. Publish side (`chia-publish` with the wallet loaded, i.e. the SSF
//! wallet on, chia_wallet_switch.rs): the CLAIM spend — keyless, puzzle reveal + solution and an
//! EMPTY aggregated signature, the faucet coin the spend's only input — and the
//! GIVE spend, our standard-puzzle coins paying into the faucet address. Both
//! run under the wallet spend lease (`chia_publish::WALLET_LEASE`): GIVE so it
//! never picks a coin another spend is consuming, CLAIM so the courtesy check,
//! the coin pick and the push are one critical section and a gift still
//! landing counts as a coin in the wallet. testnet11 by default; on mainnet
//! only for development until P8 (every gift and donation links addresses on
//! a public chain). On mainnet the node never GIVEs: a gift would send real
//! XCH into a jar nobody holds a key for ([`MAINNET_NO_GIVE`]). Nor does it
//! TAKE there (stage 4 design §4.5): a mojo into the SSF wallet marks it as a
//! player's ([`MAINNET_NO_TAKE`]), and nobody claims from a room's own dish,
//! which would group its takers by room ([`MAINNET_NO_ROOM_DISH`]).
//!
//! The claim spend is built by [`claim_spend`] for TAKE and for the
//! claim-and-write alike (stage 4 design §5.1). The claim-and-write's
//! [`claim_to`] claims a random ready lobby coin to a burner and pushes
//! nothing: the burner's own write goes in the same bundle, and the lease,
//! not this module, parks it.
#![cfg(feature = "chia-read")]

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use chia_protocol::{Bytes32, Coin};
use crate::chia_chain::{ChainAccess, ChainError, PagedRecords};
use clvm_traits::{clvm_curried_args, clvm_list, ToClvm};
use clvm_utils::{CurriedProgram, ToTreeHash, TreeHash};
use clvmr::serde::node_from_bytes;
use clvmr::{Allocator, NodePtr};
use serde::{Deserialize, Serialize};

use crate::chia_network::ChiaNet;
use crate::chia_rooms::ChiaRoomCap;

/// `puzzles/faucet.clsp` compiled with clvm_tools `run` (clvm_tools_rs 0.4.0),
/// serialized with `opc`. Re-generate with the two commands in the .clsp header;
/// `mod_hash_is_pinned` fails if this hex and [`FAUCET_MOD_HASH`] ever drift.
pub const FAUCET_MOD_HEX: &str = "ff02ffff01ff02ffff03ffff22ffff20ffff15ff8202ffff2f8080ffff20ffff15ff80ff8202ff8080ffff20ffff15ffff10ff0bff8202ff80ff81bf8080ffff09ffff0dff82017f80ffff012080ffff21ffff09ffff11ff81bfffff10ff0bff8202ff8080ff8080ffff20ffff15ff0bffff11ff81bfffff10ff0bff8202ff808080808080ffff01ff02ffff03ffff15ffff11ff81bfffff10ff0bff8202ff8080ff8080ffff01ff04ffff04ff0effff04ff5fffff04ffff11ff81bfffff10ff0bff8202ff8080ff80808080ffff04ffff04ff0affff04ff5fff808080ffff04ffff04ff0cffff04ff81bfff808080ffff04ffff04ff08ffff04ff17ff808080ffff04ffff04ff0effff04ff82017fffff04ff0bff80808080ff808080808080ffff01ff04ffff04ff0affff04ff5fff808080ffff04ffff04ff0cffff04ff81bfff808080ffff04ffff04ff08ffff04ff17ff808080ffff04ffff04ff0effff04ff82017fffff04ff0bff80808080ff808080808080ff0180ffff01ff08ffff01946661756365743a2062616420736f6c7574696f6e8080ff0180ffff04ffff01ffff5249ff4833ff018080";

/// Tree hash of the uncurried faucet module (the "mod hash").
pub const FAUCET_MOD_HASH: TreeHash = TreeHash::new([
    0x2e, 0x17, 0xde, 0xb8, 0x72, 0xdd, 0xcb, 0xdf, 0xde, 0x5a, 0xf2, 0xeb, 0x1f, 0x24, 0x71, 0x40,
    0x7e, 0x55, 0x6a, 0xe2, 0xba, 0x3d, 0x5d, 0x3a, 0xfa, 0xd6, 0xfd, 0x5f, 0x5e, 0x30, 0x81, 0x6e,
]);

/// v1 lobby parameters (design note §4): a one-mojo join token — enough to
/// publish presence forever at fee 0 — once per coin every 32 blocks (~10 min),
/// and NO fee on a claim: the puzzle is keyless, so whatever fee it allowed, a
/// griefer could burn from every ready coin every window (#245 review). A
/// claim therefore waits for an uncongested mempool, which on testnet11 is the
/// normal state. Changing any of these changes every room's faucet address.
pub const GIFT_MOJOS: u64 = 1;
pub const GAP_BLOCKS: u32 = 32;
pub const MAX_FEE_MOJOS: u64 = 0;

/// Domain-separated derivation of the per-room tag curried into the puzzle. It
/// is one-way: a private room's address reveals nothing about its key. v1 is
/// testnet11's tag, of the room key alone, so every testnet11 dish keeps the
/// address it always had; v2 is mainnet's, of the room key and the network's
/// tag ([`FaucetParams::for_room`], stage 4 design §3.5).
const CTX_ROOM_TAG_V1: &str = "ssf-faucet-room-tag-v1";
const CTX_ROOM_TAG_V2: &str = "ssf-faucet-room-tag-v2";

/// GIVE's refusal on a network that is not a test network, and the
/// status's note there.
pub const MAINNET_NO_GIVE: &str = "On mainnet the dish does not take gifts from this node.";

/// 🛑 TAKE A MOJO's refusal off a test network (stage 4 design §4.5 (4)): a
/// claim into the SSF wallet would mark that wallet as a Star Station
/// player's for ever, since every SSF dish is known by its mod hash, and a
/// mojo there funds nothing now that no listing is paid from it.
pub const MAINNET_NO_TAKE: &str = "On mainnet the dish gives no mojo to this node's wallet.";

/// 🛑 The refusal of every claim at a room's own dish off a test network,
/// whoever it would pay (stage 4 design §4.5 (5)): that dish is one fixed
/// address per room, so its takers would be grouped by room for ever. Only
/// the lobby dish can be claimed from there.
pub const MAINNET_NO_ROOM_DISH: &str = "On mainnet nobody takes from a room's own dish, since that would tie its takers to the room.";

/// Why no claim may be made at this dish on `net`, whoever it pays: off a
/// test network, any dish but `net`'s own lobby dish ([`MAINNET_NO_ROOM_DISH`]).
pub fn dish_claim_refusal(net: ChiaNet, params: &FaucetParams) -> Option<&'static str> {
    (!net.is_test() && !params.is_lobby(net)).then_some(MAINNET_NO_ROOM_DISH)
}

/// Why TAKE A MOJO into the SSF wallet is refused at this dish on `net`:
/// the dish's own refusal first ([`dish_claim_refusal`]), then, off a test
/// network, the wallet's ([`MAINNET_NO_TAKE`]). `None` on a test network.
pub fn take_refusal(net: ChiaNet, params: &FaucetParams) -> Option<&'static str> {
    dish_claim_refusal(net, params).or((!net.is_test()).then_some(MAINNET_NO_TAKE))
}

/// What is curried into the faucet puzzle for one room.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FaucetParams {
    pub room_tag: Bytes32,
    pub gift: u64,
    pub gap: u32,
    pub max_fee: u64,
}

impl FaucetParams {
    /// The room's faucet on `net`, v1 parameters. The welcome lobby's key
    /// ships in every build, so its address on a network is the same for
    /// everyone — public by design — and each network has its own.
    pub fn for_room(net: ChiaNet, room_key: &[u8; 32]) -> Self {
        Self {
            room_tag: room_tag(net, room_key).into(),
            gift: GIFT_MOJOS,
            gap: GAP_BLOCKS,
            max_fee: MAX_FEE_MOJOS,
        }
    }

    /// The lobby dish of `net`, the one [`Self::is_lobby`] accepts: the
    /// welcome room's, whose key ships in every build
    /// (`chia_rooms::BUNDLED_ROOM_KEYS_B64`), at that network's address. It
    /// is the only dish a burner is funded from (stage 4 design §5.1, R6 in
    /// §4.2): a shared pool, so a claim there ties its taker to some Star
    /// Station node and to no room.
    #[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build claims nothing
    pub fn lobby(net: ChiaNet) -> FaucetParams {
        let key = crate::chia_rooms::decode_room_key(crate::chia_rooms::BUNDLED_ROOM_KEYS_B64[0])
            .expect("the bundled welcome key decodes");
        Self::for_room(net, &key)
    }

    /// The lobby dish of `net`: the one whose room key ships in every build
    /// (the welcome room, `chia_rooms::BUNDLED_ROOM_KEYS_B64`), at that
    /// network's address. Every other dish is a room's own, and so is the
    /// other network's lobby dish: its tag is the other network's.
    pub fn is_lobby(&self, net: ChiaNet) -> bool {
        crate::chia_rooms::BUNDLED_ROOM_KEYS_B64
            .iter()
            .filter_map(|b64| crate::chia_rooms::decode_room_key(b64))
            .any(|key| Self::for_room(net, &key) == *self)
    }

    /// Puzzle hash = address of this room's faucet (tree hash of the curried
    /// puzzle; computed from hashes alone, no allocator).
    pub fn puzzle_hash(&self) -> Bytes32 {
        CurriedProgram {
            program: FAUCET_MOD_HASH,
            args: clvm_curried_args!(self.room_tag, self.gift, self.gap, self.max_fee),
        }
        .tree_hash()
        .into()
    }

    /// The address form of [`Self::puzzle_hash`] on `net` (`txch1…` on
    /// testnet11): what the dish prints so a donor can pay into it from any
    /// Chia wallet. The prefix is the only part of the address `net` gives
    /// here; a room's puzzle hash already differs by network, through the
    /// tag [`Self::for_room`] curries in (stage 4 design §3.5).
    pub fn address(&self, net: ChiaNet) -> String {
        bech32m::encode(net.prefix(), &self.puzzle_hash())
    }

    /// The full curried puzzle (the spend's puzzle reveal).
    pub fn puzzle_reveal(&self, a: &mut Allocator) -> Result<NodePtr> {
        let module = mod_program(a)?;
        CurriedProgram {
            program: module,
            args: clvm_curried_args!(self.room_tag, self.gift, self.gap, self.max_fee),
        }
        .to_clvm(a)
        .map_err(|e| anyhow!("curry faucet puzzle: {e:?}"))
    }
}

/// The tag a room's dish curries in on `net` (stage 4 design §3.5). On
/// testnet11 it is `derive_key("ssf-faucet-room-tag-v1", room_key)`, as it
/// always was, so every testnet11 dish keeps its address. On mainnet it is
/// `derive_key("ssf-faucet-room-tag-v2", room_key ‖ G)`, G the network tag
/// (`chia_lane::network_tag`, mainnet's genesis challenge), so the lobby
/// dish of mainnet is not testnet11's: the dish's address is no longer the
/// same on every network, and a claim on one chain says nothing of the
/// other. Both fields are 32 bytes. The mod hash and the puzzle do not
/// change. Mainnet has no lobby coin yet (it waits for this tag, §13), so
/// no coin is left at the untagged address and no migration is owed.
fn room_tag(net: ChiaNet, room_key: &[u8; 32]) -> [u8; 32] {
    match crate::chia_lane::network_tag(net) {
        None => blake3::derive_key(CTX_ROOM_TAG_V1, room_key),
        Some(g) => {
            let mut material = [0u8; 64];
            material[..32].copy_from_slice(room_key);
            material[32..].copy_from_slice(&g);
            blake3::derive_key(CTX_ROOM_TAG_V2, &material)
        }
    }
}

/// The uncurried module as a CLVM node.
pub fn mod_program(a: &mut Allocator) -> Result<NodePtr> {
    let bytes = hex::decode(FAUCET_MOD_HEX).map_err(|e| anyhow!("faucet mod hex: {e}"))?;
    node_from_bytes(a, &bytes).map_err(|e| anyhow!("faucet mod deserialize: {e:?}"))
}

/// A claim's solution: `(my_puzzle_hash my_amount recipient_ph fee)`.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build only shows the dish
pub fn claim_solution(
    a: &mut Allocator,
    my_puzzle_hash: Bytes32,
    my_amount: u64,
    recipient: Bytes32,
    fee: u64,
) -> Result<NodePtr> {
    clvm_list!(my_puzzle_hash, my_amount, recipient, fee)
        .to_clvm(a)
        .map_err(|e| anyhow!("faucet solution: {e:?}"))
}

/// The claim of `coin` at `params`'s dish that pays the gift to
/// `recipient`, fee 0: the curried puzzle as its reveal and
/// [`claim_solution`] as its solution, run here first, so a solution the
/// puzzle rejects (a coin below the gift, say) never reaches the mempool.
/// No key signs it: the puzzle has no AGG_SIG condition, so a bundle of
/// claims alone aggregates the identity signature (stage 4 design §5.4).
/// TAKE sends it to the money address; the claim-and-write sends it to a
/// burner, beside the burner's spend of the gift in the same bundle
/// (§4.1, §5.1).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build claims nothing
pub fn claim_spend(params: &FaucetParams, coin: Coin, recipient: Bytes32) -> Result<chia_protocol::CoinSpend> {
    use chia_protocol::{CoinSpend, Program};
    use clvmr::serde::node_to_bytes;

    let mut a = Allocator::new();
    let puzzle = params.puzzle_reveal(&mut a)?;
    let solution = claim_solution(&mut a, params.puzzle_hash(), coin.amount, recipient, 0)?;
    chia_sdk_types::run_puzzle(&mut a, puzzle, solution)
        .map_err(|e| anyhow!("faucet puzzle rejected our claim locally: {e:?}"))?;
    Ok(CoinSpend::new(
        coin,
        Program::from(node_to_bytes(&a, puzzle).map_err(|e| anyhow!("serialize reveal: {e:?}"))?),
        Program::from(node_to_bytes(&a, solution).map_err(|e| anyhow!("serialize solution: {e:?}"))?),
    ))
}

/// One unspent coin at the faucet address, as the chain reports it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FaucetCoin {
    pub coin: Coin,
    pub confirmed_height: u32,
}

impl FaucetCoin {
    /// A coin below GIFT can never satisfy the puzzle: dust, not a slot.
    pub fn claimable(&self, params: &FaucetParams) -> bool {
        self.coin.amount >= params.gift
    }
    /// First height at which ASSERT_HEIGHT_RELATIVE lets this coin be spent.
    pub fn ready_at(&self, params: &FaucetParams) -> u32 {
        self.confirmed_height.saturating_add(params.gap)
    }
    pub fn ready(&self, params: &FaucetParams, peak: u32) -> bool {
        self.claimable(params) && peak >= self.ready_at(params)
    }
}

/// What the browser draws the dish from. Numbers are mojos and blocks; the
/// browser decides how to show them (the jar level is visual only in-room).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FaucetStatus {
    pub address: String,
    pub puzzle_hash: String,
    pub gift: u64,
    pub gap: u32,
    pub peak: u32,
    /// Mojos in claimable coins (dust below GIFT is not counted: it can never
    /// leave). A decimal STRING on the wire — see [`mojo_string`]. `u128`: one
    /// coin holds up to `u64::MAX` mojos and the address is permissionless, so
    /// a SUM of coins can pass `u64` (Chia's own supply does); a `u64` sum
    /// would panic in debug builds and wrap in release (#245 review, round 4).
    #[serde(with = "mojo_string")]
    pub total_mojos: u128,
    /// Claimable coins = gift slots per GAP.
    pub coins: u32,
    /// Coins past their GAP right now: mojos sitting in the dish.
    pub ready: u32,
    /// Blocks until the next coin becomes ready, when none is.
    pub next_ready_in_blocks: Option<u32>,
    /// This node can submit a claim: wallet loaded, wallet empty, a coin ready.
    pub can_claim: bool,
    /// This node can pay into the jar: wallet loaded and funded.
    pub can_give: bool,
    /// Mojos our wallet OWNS on chain, when a wallet is loaded (decimal string).
    #[serde(with = "opt_mojo_string")]
    pub wallet_mojos: Option<u128>,
    /// Of those, the mojos we may SPEND right now: owned minus coins a pushed
    /// spend already consumed but the chain has not confirmed yet (decimal
    /// string). GIVE is gated on this; the empty-wallet courtesy check on `wallet_mojos`.
    #[serde(with = "opt_mojo_string")]
    pub wallet_spendable_mojos: Option<u128>,
    /// The WALLET listing hit [`MAX_FAUCET_PAGES`]: our address is as
    /// permissionless as the faucet's, so a flood of outputs can cut it short,
    /// and then `wallet_mojos` / `wallet_spendable_mojos` are what the pages
    /// read hold (the wallet holds more) and GIVE spends from those coins
    /// (#245 review, round 5).
    pub wallet_partial: bool,
    /// The coin listing hit [`MAX_FAUCET_PAGES`]: `coins`, `ready` and
    /// `total_mojos` cover the pages read, the jar holds more.
    pub partial: bool,
    /// Why claim/give are off, in the dish's words.
    pub note: String,
    /// ⛓️ The Chia network the address and the coins are on: its id
    /// (`testnet11`, `mainnet`).
    pub network: ChiaNet,
    /// A spend FROM our wallet is still settling: the lease has a coin of ours
    /// parked by a push the chain and the mempool have not settled yet (see
    /// `chia_publish::WalletLease::outgoing_pending`; with burner keys on, a
    /// spend the wallet pays for, `chia_publish::wallet_spending`, so the
    /// listing's burner spend and the beacon's are not it). The browser keeps
    /// its GIVING… pending while this holds and clears it from a later
    /// snapshot that no longer says so, never on elapsed time (#245 review,
    /// round 11).
    /// Read from the lease, not inferred from the wallet listing, which a
    /// flood of outputs can cut short of the parked coin (round 16).
    pub spending: bool,
    /// A gift from the dish is still landing in our wallet (the faucet coin the
    /// claim spent is parked): same for the browser's TAKING….
    pub landing: bool,
    /// This snapshot's number: status reads are captured ONE AT A TIME (see
    /// `STATUS_TURN`) and numbered as they complete, so a higher number is a
    /// later look at the chain and the wallet whatever order the browser's
    /// requests were sent in. The browser keeps the highest it has seen. 0
    /// from `summarize` alone (a snapshot `status` has not numbered).
    pub snapshot: u64,
}

/// The network's word on the dish, after the wallet's: GIVE, TAKE and the
/// note. A test network keeps the wallet's. Off one neither GIVE nor TAKE
/// is offered, whatever the wallet holds, and the note is the network's
/// alone: why no mojo is taken at this dish ([`take_refusal`]), then that it
/// takes no gift ([`MAINNET_NO_GIVE`]). Every other hint is about TAKE or
/// GIVE, so none of them is said there (stage 4 design §4.5 (4) and (5)).
pub fn network_part(net: ChiaNet, params: &FaucetParams, can_give: bool, can_claim: bool, note: String) -> (bool, bool, String) {
    match take_refusal(net, params) {
        None => (can_give, can_claim, note),
        Some(take) => (false, false, format!("{take} {MAINNET_NO_GIVE}")),
    }
}

/// Status reads take turns, and each snapshot is numbered as it completes
/// (#245 review, round 9). The browser's polls and its post-action read run on
/// separate streams the node serves concurrently, so REQUEST order is not
/// capture order: a later request can reach the node first and read an older
/// view, and ordering replies by request number kept that older view. The
/// turn makes one snapshot's coin and wallet reads an indivisible look, and
/// the number taken under it orders the snapshots by when they were captured.
static STATUS_TURN: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));
static STATUS_SNAPSHOTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Mojo totals travel as DECIMAL STRINGS: a JSON number is a double in the
/// browser, exact only below 2^53 (about 9,007 XCH), and the screen promises
/// exact totals (#245 review). The browser parses them as `bigint`.
mod mojo_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &u128, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(v)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u128, D::Error> {
        String::deserialize(d)?.parse().map_err(serde::de::Error::custom)
    }
}

mod opt_mojo_string {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(v: &Option<u128>, s: S) -> Result<S::Ok, S::Error> {
        match v {
            Some(n) => s.collect_str(n),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u128>, D::Error> {
        Option::<String>::deserialize(d)?
            .map(|text| text.parse().map_err(serde::de::Error::custom))
            .transpose()
    }
}

/// Pure half of `status`: fold the coins at the address into the dish's view.
/// `partial` says the listing was cut short (see [`unspent_at`]). The address
/// is on `net`; the network's word on GIVE is added by `status`
/// ([`network_part`]).
pub fn summarize(net: ChiaNet, params: &FaucetParams, peak: u32, coins: &[FaucetCoin], partial: bool) -> FaucetStatus {
    let claimable: Vec<&FaucetCoin> = coins.iter().filter(|c| c.claimable(params)).collect();
    let ready = claimable.iter().filter(|c| c.ready(params, peak)).count() as u32;
    let next_ready_in_blocks = claimable
        .iter()
        .filter(|c| !c.ready(params, peak))
        .map(|c| c.ready_at(params) - peak)
        .min();
    FaucetStatus {
        address: params.address(net),
        puzzle_hash: hex::encode(params.puzzle_hash()),
        gift: params.gift,
        gap: params.gap,
        peak,
        total_mojos: claimable.iter().map(|c| u128::from(c.coin.amount)).sum(),
        coins: claimable.len() as u32,
        ready,
        next_ready_in_blocks,
        can_claim: false,
        can_give: false,
        wallet_mojos: None,
        wallet_spendable_mojos: None,
        wallet_partial: false,
        partial,
        note: String::new(),
        network: net,
        spending: false,
        landing: false,
        snapshot: 0,
    }
}

/// Listing pages followed per listing (one peer request each). A faucet address is
/// permissionless, so a flood of tiny outputs could stretch the listing past one
/// page; the pages are followed up to this bound (as `chia_resolve::read_hint`
/// does) and past it the status says so (`partial`) instead of silently
/// missing coins (#245 review).
pub const MAX_FAUCET_PAGES: usize = 8;

/// The unspent coins at an address, and whether the listing was cut short.
pub struct Unspent {
    pub coins: Vec<FaucetCoin>,
    pub partial: bool,
}

/// A coin listing the chain did not give ([`unspent_at`]): the chain's own
/// error for the page that failed, under the words the listing's callers
/// have always logged ("coin lookup: ..."). It is typed so that a caller
/// can tell a failed read, which a later try may get past, from a refusal:
/// with burner keys on (SSF_CHIA_BURNERS=1 on a test network), a knock that
/// could not read the chain waits and uses no attempt (stage 4 design §5.2,
/// `chia_publish::is_typed_wait`); with them off it uses one, as on main.
#[derive(Debug)]
pub struct CoinLookupFailed(pub ChainError);

impl std::fmt::Display for CoinLookupFailed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "coin lookup: {}", self.0)
    }
}

/// No source: the text already holds the chain's error, and an alternate
/// print (`{:#}`) would say it twice.
impl std::error::Error for CoinLookupFailed {}

/// The unspent coins at `puzzle_hash`, following the listing's cursor. Spent
/// coins are asked for as well: the chain pages by a coin's latest change, so
/// a coin listed unspent on one page comes again, spent, on a later one when
/// the chain moved on in between, and only that later record says so
/// ([`PagedRecords`]); the spent ones are dropped once every page is in. A
/// page the chain did not give fails the listing as [`CoinLookupFailed`].
pub async fn unspent_at(client: &impl ChainAccess, puzzle_hash: Bytes32) -> Result<Unspent> {
    let mut gathered = PagedRecords::default();
    let mut cursor: Option<String> = None;
    let mut pages = 0usize;
    let partial = loop {
        let listing = client
            .coin_records_by_puzzle_hash(puzzle_hash, true, cursor.take())
            .await
            .map_err(CoinLookupFailed)?;
        pages += 1;
        gathered.fold(listing.records);
        let truncated = listing.truncated;
        match listing.next_cursor {
            Some(next) if truncated => {
                if pages >= MAX_FAUCET_PAGES {
                    break true;
                }
                cursor = Some(next);
            }
            _ => break truncated,
        }
    };
    let coins = gathered
        .into_records()
        .into_iter()
        .filter(|r| !r.spent)
        .map(|r| FaucetCoin { coin: r.coin, confirmed_height: r.confirmed_block_index })
        .collect();
    Ok(Unspent { coins, partial })
}

// ── The browser lane: `faucet` envelopes ────────────────────────────────────

/// `{ "op": "status" | "claim" | "give", "amount": <mojos, give only> }`.
#[derive(Deserialize, Debug)]
struct FaucetRequest {
    op: String,
    #[serde(default)]
    amount: u64,
}

/// The answer, written back on the same stream the request came in on.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FaucetReply {
    pub op: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<FaucetStatus>,
    /// The id of the coin a claim or gift spent (with `unanswered` set: the coin
    /// its bundle spends, if the peers took it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spent_coin: Option<String>,
    /// On a claim or give that went out: the snapshot BARRIER, taken under
    /// `STATUS_TURN` once the spend was pushed, so every status numbered above
    /// it was captured after the push. Sent whether or not the status read
    /// right after it succeeds: the browser's TAKING…/GIVING… clears from a
    /// snapshot above the barrier that shows the spend settled, and a dropped
    /// spend must be able to clear even when that one read failed (#245
    /// review, round 13).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after_snapshot: Option<u64>,
    /// On a claim or give whose push the chain did not ANSWER (a timeout
    /// above all): why. The spend may be in the mempool all the same, so its
    /// inputs stay parked and the browser keeps its TAKING…/GIVING… until
    /// reconciliation settles the spend, exactly as after an accepted push;
    /// `ok` stays true. Only an explicit rejection, which proves nothing was
    /// spent, comes back as `ok: false` (#245 review, round 14).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unanswered: Option<String>,
}

impl FaucetReply {
    fn fail(op: &str, error: impl Into<String>) -> Self {
        Self {
            op: op.to_string(),
            ok: false,
            error: Some(error.into()),
            status: None,
            spent_coin: None,
            after_snapshot: None,
            unanswered: None,
        }
    }
    /// A request the node will not serve at all (wrong source), op unknown.
    pub fn refused(error: impl Into<String>) -> Self {
        Self::fail("?", error)
    }
}

/// What a request needs from the node: the room caps (for the room key) and,
/// in a publish build, the wallet key while the SSF wallet is on, what
/// `SSF_CHIA_LANE` says and whether the Bank can bring a wallet on (the
/// dish's words while no wallet is on), and the network the node runs on.
pub struct FaucetContext<'a> {
    pub net: ChiaNet,
    /// ⛓️ Chia is off on this computer (chia_strict.rs): every request is
    /// answered off before a chain client is built.
    pub chia_off: bool,
    pub rooms: &'a Mutex<HashMap<String, ChiaRoomCap>>,
    #[cfg(feature = "chia-publish")]
    pub wallet: Option<chia_bls::SecretKey>,
    #[cfg(feature = "chia-publish")]
    pub env: crate::chia_wallet_switch::EnvSwitch,
    /// chia_wallet_switch::bank_can_turn_on: false off a test network with
    /// no live desktop app channel and no wallet on disk, where the dish
    /// names the desktop app instead of the Bank.
    #[cfg(feature = "chia-publish")]
    pub turnable: bool,
    /// Burner keys on for this run (`chia_publish::burners_enabled`): the
    /// dish counts the wallet's own spends in flight only
    /// (`chia_publish::wallet_spending`, stage 4 design §4.4), since the
    /// listing's burner spend and the beacon's are not the wallet's.
    #[cfg(feature = "chia-publish")]
    pub burners: bool,
}

/// Serve one `faucet` request from the LOCAL browser for `room`.
pub async fn handle_request(ctx: &FaucetContext<'_>, room: &str, payload: &[u8]) -> FaucetReply {
    let req: FaucetRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => return FaucetReply::fail("?", format!("malformed faucet request: {e}")),
    };
    if ctx.chia_off {
        return FaucetReply::fail(&req.op, crate::chia_strict::OFF_WORDS);
    }
    let room_key = ctx.rooms.lock().unwrap().get(room).map(|cap| cap.room_key);
    let Some(room_key) = room_key else {
        return FaucetReply::fail(
            &req.op,
            "the node has no key for this room yet (the browser sends it when it connects); try again in a moment",
        );
    };
    let params = FaucetParams::for_room(ctx.net, &room_key);
    let client = crate::chia_chain::connect();
    let result = match req.op.as_str() {
        "status" => status(ctx, &client, &params).await.map(|s| FaucetReply {
            op: "status".into(),
            ok: true,
            error: None,
            status: Some(s),
            spent_coin: None,
            after_snapshot: None,
            unanswered: None,
        }),
        "claim" => claim(ctx, &client, &params).await,
        "give" => give(ctx, &client, &params, req.amount).await,
        other => Err(anyhow!("unknown faucet op {other:?}")),
    };
    match result {
        Ok(mut reply) => {
            // A TAKE or GIVE that went out carries the snapshot BARRIER and the
            // first look after its push (#245 review, rounds 11 and 13). Both are
            // taken under STATUS_TURN once the writer has let the wallet lease go:
            // every snapshot still in progress completes first, so any status
            // numbered above the barrier was captured after the push, and the
            // browser can tell a poll that predates the spend from one that
            // reflects it. Its TAKING…/GIVING… then clears only from a snapshot
            // above the barrier that shows the spend settled (or the gift
            // landed). The barrier goes out even when the read right after it
            // fails, so a later poll can settle a spend the chain dropped; the
            // polls bring the status. A push the chain did not answer went out
            // as well (`unanswered` set, round 14): its spend may be live, so the
            // browser keeps the action pending the same way.
            if reply.ok && matches!(reply.op.as_str(), "claim" | "give") {
                let _turn = STATUS_TURN.lock().await;
                reply.after_snapshot = Some(STATUS_SNAPSHOTS.load(std::sync::atomic::Ordering::SeqCst));
                match status_under_turn(ctx, &client, &params).await {
                    Ok(st) => reply.status = Some(st),
                    Err(e) => eprintln!("⛓️🥣 faucet: {} went out but the status read after it failed: {e:#}", reply.op),
                }
            }
            reply
        }
        Err(e) => FaucetReply::fail(&req.op, format!("{e:#}")),
    }
}

async fn status(ctx: &FaucetContext<'_>, client: &impl ChainAccess, params: &FaucetParams) -> Result<FaucetStatus> {
    // One snapshot at a time, numbered as it completes (see STATUS_TURN). Taken
    // before the wallet lease below, never after it: the writers take the lease
    // alone, so the two never wait on each other in a cycle.
    let _turn = STATUS_TURN.lock().await;
    status_under_turn(ctx, client, params).await
}

/// The snapshot itself; the caller holds `STATUS_TURN`.
async fn status_under_turn(ctx: &FaucetContext<'_>, client: &impl ChainAccess, params: &FaucetParams) -> Result<FaucetStatus> {
    let peak = crate::chia_resolve::peak_height(client)
        .await
        .ok_or_else(|| anyhow!("chain peak unavailable (peers unreachable?)"))?;
    let listing = unspent_at(client, params.puzzle_hash()).await?;
    let mut st = summarize(ctx.net, params, peak, &listing.coins, listing.partial);
    #[cfg(feature = "chia-publish")]
    {
        match &ctx.wallet {
            Some(sk) => {
                // What the chain and the mempool say about parked coins decides
                // what reads as confirming or landing, not a timer. Under the
                // lease gate like every writer: a verdict formed here must not
                // land on a coin a writer parked again in the meantime, and the
                // wallet snapshot must match the markers it is read against.
                let _lease = crate::chia_publish::WALLET_LEASE.lock().await;
                // A sealed lease takes no spend: the buttons go off and the note
                // says why, whatever the balance (round 21; see wallet_part).
                let sealed = crate::chia_publish::WALLET_LEASE.ensure_open().err();
                crate::chia_publish::WALLET_LEASE.reconcile(client).await;
                let wallet = wallet_view(client, sk).await?;
                st.wallet_mojos = Some(wallet.owned_mojos());
                st.wallet_spendable_mojos = Some(wallet.spendable_mojos());
                st.wallet_partial = wallet.partial;
                let landing = crate::chia_publish::WALLET_LEASE.incoming_pending();
                // From the lease, not the listing: a parked coin the cut-short
                // listing never reached is still a spend in flight (round 16).
                // With burner keys on, the wallet's own spends alone (stage 4
                // design §4.4).
                st.spending = crate::chia_publish::wallet_spending(&crate::chia_publish::WALLET_LEASE, crate::chia_publish::Payer::of(sk), ctx.burners);
                st.landing = landing;
                let dish = Dish { gift: params.gift, ready: st.ready > 0, empty: st.coins == 0, gives: ctx.net.is_test() };
                let part = wallet_part(&wallet, landing, st.spending, sealed.as_ref(), dish);
                st.can_give = part.can_give;
                st.can_claim = part.can_claim;
                st.note = part.note;
            }
            None => {
                st.note = crate::chia_wallet_switch::no_wallet_words(
                    ctx.env,
                    ctx.net,
                    ctx.turnable,
                    if ctx.net.is_test() { "take or give" } else { "take a mojo" },
                );
            }
        }
    }
    #[cfg(not(feature = "chia-publish"))]
    {
        st.note = "this node was built without publishing; it can show the dish but not take or give".into();
    }
    (st.can_give, st.can_claim, st.note) = network_part(ctx.net, params, st.can_give, st.can_claim, std::mem::take(&mut st.note));
    st.snapshot = STATUS_SNAPSHOTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    Ok(st)
}

/// Our wallet as the dish needs it: what the chain says we OWN (the courtesy
/// "is my wallet empty" check, and the balance on the screen) and what we may
/// SPEND right now (owned minus coins a pushed spend already consumed, see
/// `chia_publish::WALLET_LEASE`). The two differ while a spend confirms, and the
/// empty-wallet check must read the owned view: a funded wallet with a heartbeat
/// in flight is not empty, and must not TAKE a mojo (#245 review, round 2).
#[cfg(feature = "chia-publish")]
struct WalletView {
    owned: Vec<Coin>,
    spendable: Vec<Coin>,
    /// The height each owned coin was seen confirmed at, by coin id: what the
    /// parking of the coins a GIVE spends records.
    seen_at: HashMap<Bytes32, u32>,
    /// The listing was cut short at [`MAX_FAUCET_PAGES`]: `owned` and
    /// `spendable` are what the pages read hold, not the whole wallet.
    partial: bool,
}

#[cfg(feature = "chia-publish")]
impl WalletView {
    /// Sums in `u128`: several `u64` coins can pass `u64` together.
    fn owned_mojos(&self) -> u128 {
        self.owned.iter().map(|c| u128::from(c.amount)).sum()
    }
    fn spendable_mojos(&self) -> u128 {
        self.spendable.iter().map(|c| u128::from(c.amount)).sum()
    }
}

#[cfg(feature = "chia-publish")]
async fn wallet_view(client: &impl ChainAccess, sk: &chia_bls::SecretKey) -> Result<WalletView> {
    let ph = crate::chia_publish::our_puzzle_hash(sk);
    let listing = unspent_at(client, ph).await?;
    let seen_at: HashMap<Bytes32, u32> = listing.coins.iter().map(|c| (c.coin.coin_id(), c.confirmed_height)).collect();
    let owned: Vec<Coin> = listing.coins.into_iter().map(|c| c.coin).collect();
    let spendable = owned
        .iter()
        .copied()
        .filter(|c| !crate::chia_publish::WALLET_LEASE.is_taken(&c.coin_id()))
        .collect();
    Ok(WalletView { owned, spendable, seen_at, partial: listing.partial })
}

/// One gift is paid from at most this many of our coins (#245 review, round
/// 21): a wallet dusted into many small outputs would otherwise have one click
/// build and sign hundreds of standard spends under the wallet lease, for a
/// bundle the mempool may refuse over its cost only after all that work. At a
/// generous 12 million cost per standard input, 64 inputs stay under a tenth
/// of a block's 11 billion.
#[cfg(feature = "chia-publish")]
pub const MAX_GIVE_INPUTS: usize = 64;

/// What one gift can draw on: the [`MAX_GIVE_INPUTS`] largest coins together
/// (the whole balance, for a wallet with no more coins than that).
#[cfg(feature = "chia-publish")]
pub fn give_reach(coins: &[Coin]) -> u128 {
    let mut amounts: Vec<u64> = coins.iter().map(|c| c.amount).collect();
    amounts.sort_unstable_by(|a, b| b.cmp(a));
    amounts.iter().take(MAX_GIVE_INPUTS).map(|a| u128::from(*a)).sum()
}

/// Which of our coins pay a gift of `amount`: largest first until they cover it,
/// so a wallet split over several small coins can still give what the screen
/// enabled from its total (#245 review), but never more than
/// [`MAX_GIVE_INPUTS`] of them. `None` when those cannot cover it; otherwise
/// the coins and the change.
#[cfg(feature = "chia-publish")]
pub fn pick_give_coins(mut coins: Vec<Coin>, amount: u64) -> Option<(Vec<Coin>, u64)> {
    coins.sort_by_key(|c| std::cmp::Reverse(c.amount));
    let mut chosen = Vec::new();
    // The running sum is `u128`: it may pass `u64::MAX` on the last coin taken.
    // The change never does: before that coin the sum was below `amount`, so
    // change < that coin's amount ≤ `u64::MAX`.
    let amount = u128::from(amount);
    let mut sum: u128 = 0;
    for coin in coins {
        sum += u128::from(coin.amount);
        chosen.push(coin);
        if sum >= amount {
            return Some((chosen, (sum - amount) as u64));
        }
        if chosen.len() == MAX_GIVE_INPUTS {
            break;
        }
    }
    None
}

/// The wallet's word on the dish for THIS node: TAKE and GIVE, and the note
/// explaining whichever is off (see [`status_under_turn`]). Pure, so it is
/// checked without a chain. A SEALED lease (see
/// [`crate::chia_publish::WalletLease::restore`]) takes no spend, so neither
/// button is offered whatever the balance and the note says why: a status poll
/// clears an earlier refusal from the screen, and would otherwise re-enable
/// buttons every click of which fails (#245 review, round 21).
#[cfg(feature = "chia-publish")]
#[derive(Debug)]
struct WalletPart {
    can_give: bool,
    can_claim: bool,
    note: String,
}

/// The dish as [`wallet_part`] reads it.
#[cfg(feature = "chia-publish")]
#[derive(Clone, Copy, Debug)]
struct Dish {
    /// The jar's gift: the least a GIVE may be.
    gift: u64,
    /// A coin is ready to take.
    ready: bool,
    /// The jar holds no claimable coin at all.
    empty: bool,
    /// This node may give to it: only on a test network ([`network_part`]
    /// turns GIVE off elsewhere, and adds [`MAINNET_NO_GIVE`]).
    gives: bool,
}

/// Off a test network the note never speaks of giving: the dish takes no
/// gift there, and [`network_part`] says so after it. So the hints that
/// are only about GIVE (split coins, a listing cut short, a spend still
/// confirming) are left out, and an empty jar is called empty, not one that
/// refills: no gift fills a mainnet jar from this node.
#[cfg(feature = "chia-publish")]
fn wallet_part(
    wallet: &WalletView,
    landing: bool,
    spending: bool,
    sealed: Option<&crate::chia_publish::LeaseError>,
    dish: Dish,
) -> WalletPart {
    let Dish { gift, ready: dish_ready, empty: jar_empty, gives } = dish;
    let open = sealed.is_none();
    let spendable = wallet.spendable_mojos();
    let reach = give_reach(&wallet.spendable);
    // The courtesy check reads what we OWN: a coin parked by a spend in flight
    // is still ours, so the wallet is not empty. A gift from the dish that is
    // still landing counts the same way (the chain lists it only once the
    // block confirms). A listing cut short lists coins, so it is never empty;
    // should one ever be, it proves nothing about the wallet: TAKE stays off
    // (fail closed, #245 review, round 16).
    let can_claim = open && wallet.owned.is_empty() && !wallet.partial && !landing && dish_ready;
    // GIVE draws on at most MAX_GIVE_INPUTS coins: what those reach, not the
    // whole balance, is what a gift can be.
    let can_give = open && reach >= u128::from(gift);
    let note = if let Some(why) = sealed {
        format!("this node takes no spend right now: {why}")
    } else if wallet.owned.is_empty() && landing {
        "your mojo from the dish is on its way (about a minute); the wallet shows it when the block lands".into()
    } else if gives && reach < spendable {
        // A giver's wallet (it holds coins), so the giving hint outranks the
        // note that the dish is for empty wallets.
        format!(
            "your wallet is split into many small coins: one gift is paid from at most {MAX_GIVE_INPUTS} of them ({reach} mojos); consolidate it to give more at once"
        )
    } else if !wallet.owned.is_empty() && dish_ready {
        "the dish is for players with an empty wallet; yours already holds a coin".into()
    } else if wallet.owned.is_empty() && !dish_ready && jar_empty && !gives {
        "the jar is empty, so there is no mojo to take".into()
    } else if wallet.owned.is_empty() && !dish_ready {
        "no mojo in the dish yet; it refills on the block clock".into()
    } else if !gives {
        String::new()
    } else if wallet.partial {
        "your wallet holds more coins than the dish lists (cut short); giving uses the ones it read".into()
    } else if spending {
        "a spend from your wallet is still confirming (about a minute); giving waits for it".into()
    } else {
        String::new()
    };
    WalletPart { can_give, can_claim, note }
}

/// The coin a claim spends: one picked at random among the coins ready now
/// (claimable and past their gap) that the lease does not hold (`taken`),
/// on every network (stage 4 design §5.2). The largest coin first, as
/// before, sent every node claiming on the same day to one coin, so all
/// but one lost the race; a random pick spreads them over every ready
/// coin. `None` when no coin is ready.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build only shows the dish
pub fn pick_ready_coin<'a, R: rand::Rng + ?Sized>(
    coins: &'a [FaucetCoin],
    params: &FaucetParams,
    peak: u32,
    taken: impl Fn(&Bytes32) -> bool,
    rng: &mut R,
) -> Option<&'a FaucetCoin> {
    use rand::seq::SliceRandom;
    let ready: Vec<&FaucetCoin> = coins.iter().filter(|c| c.ready(params, peak) && !taken(&c.coin.coin_id())).collect();
    ready.choose(rng).copied()
}

/// A claim of one dish coin to a recipient, built and not pushed
/// ([`dish_claim`]): the spend, and the two coins it creates, whose ids are
/// known before anything leaves (stage 4 design §4.1). `gift` is the gift at
/// the recipient: for a burner it is the ephemeral coin g, which the
/// burner's write spends in the same bundle. `remainder` is the rest of the
/// dish coin back at the dish, `None` when the coin held exactly the gift,
/// as `puzzles/faucet.clsp` creates it only when it is above 0.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build claims nothing
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DishClaim {
    pub params: FaucetParams,
    pub dish: FaucetCoin,
    pub spend: chia_protocol::CoinSpend,
    pub gift: Coin,
    pub remainder: Option<Coin>,
}

/// The claim of `dish` at `params`'s dish to `recipient` ([`claim_spend`]),
/// with the coins it creates. Pure, and for any dish: which dish may fund
/// whom is the caller's rule, not this one's. The spend is built and run
/// first, so a coin below the gift is the puzzle's refusal, never an
/// underflow here; fee 0, so the remainder is the coin less the gift.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build claims nothing
pub fn dish_claim(params: &FaucetParams, dish: FaucetCoin, recipient: Bytes32) -> Result<DishClaim> {
    let spend = claim_spend(params, dish.coin, recipient)?;
    let rest = dish.coin.amount.checked_sub(params.gift).ok_or_else(|| anyhow!("faucet: a coin below the gift"))?;
    let parent = dish.coin.coin_id();
    Ok(DishClaim {
        params: *params,
        gift: Coin::new(parent, recipient, params.gift),
        remainder: (rest > 0).then(|| Coin::new(parent, params.puzzle_hash(), rest)),
        dish,
        spend,
    })
}

/// Why [`claim_to`] built no claim, when it is a typed answer rather than a
/// failed read: a caller tells waiting for the dish from a failure by
/// downcasting the error to this. `NoCoinReady` is a dry or griefed dish
/// (stage 4 design §10): nothing went wrong, and the next tick tries again
/// with another random coin, so it is no knock attempt (§5.2).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build claims nothing
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimToError {
    /// No claim may be made at the lobby dish on this network
    /// ([`dish_claim_refusal`]).
    Refused(&'static str),
    /// No peer answered the peak, so no coin can be judged ready.
    PeakUnavailable,
    /// No coin at the lobby dish is ready that the caller does not hold.
    NoCoinReady,
}

impl std::fmt::Display for ClaimToError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ClaimToError::Refused(why) => f.write_str(why),
            ClaimToError::PeakUnavailable => f.write_str("chain peak unavailable (peers unreachable?)"),
            ClaimToError::NoCoinReady => f.write_str("no mojo in the dish right now; it refills on the block clock"),
        }
    }
}

impl std::error::Error for ClaimToError {}

/// The claim of a random ready lobby coin to `recipient`, built and not
/// pushed (stage 4 design §5.1): the claim-and-write puts it in one bundle
/// with the recipient burner's spend of the gift. Only the lobby dish of
/// `net` funds a burner ([`FaucetParams::lobby`]; R6 in §4.2), and it asks
/// the dish's own rule alone ([`dish_claim_refusal`], which admits the lobby
/// on every network), never TAKE's, which refuses any claim into the SSF
/// wallet off a test network: the recipient here is not the money address.
/// The coin is picked at random among the ready ones `taken` does not
/// name ([`pick_ready_coin`], §5.2): the caller names the coins the lease
/// holds, and the TAKE marker's. It neither pushes nor parks nor marks
/// anything, so calling it twice picks twice from the same coins.
/// `ClaimToError::PeakUnavailable` and `ClaimToError::NoCoinReady` come back
/// typed; a listing that failed is no `ClaimToError` but the listing's own
/// [`CoinLookupFailed`].
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))] // the read build claims nothing
pub async fn claim_to<R: rand::Rng + ?Sized>(
    net: ChiaNet,
    client: &impl ChainAccess,
    recipient: Bytes32,
    taken: impl Fn(&Bytes32) -> bool,
    rng: &mut R,
) -> Result<DishClaim> {
    let params = FaucetParams::lobby(net);
    if let Some(why) = dish_claim_refusal(net, &params) {
        return Err(ClaimToError::Refused(why).into());
    }
    let peak = crate::chia_resolve::peak_height(client).await.ok_or(ClaimToError::PeakUnavailable)?;
    let coins = unspent_at(client, params.puzzle_hash()).await?.coins;
    let picked = pick_ready_coin(&coins, &params, peak, taken, rng).ok_or(ClaimToError::NoCoinReady)?;
    dish_claim(&params, picked.clone(), recipient)
}

/// CLAIM: spend a ready faucet coin picked at random ([`pick_ready_coin`]),
/// GIFT to our own address, keyless. Refused first off a test network
/// ([`take_refusal`]), before the wallet or the chain is asked anything.
#[cfg(feature = "chia-publish")]
async fn claim(ctx: &FaucetContext<'_>, client: &impl ChainAccess, params: &FaucetParams) -> Result<FaucetReply> {
    use chia_protocol::SpendBundle;

    if let Some(why) = take_refusal(ctx.net, params) {
        return Err(anyhow!(why));
    }
    let sk = ctx
        .wallet
        .as_ref()
        .ok_or_else(|| anyhow!(crate::chia_wallet_switch::no_wallet_words(ctx.env, ctx.net, ctx.turnable, "take a mojo")))?;
    // One TAKE at a time, serialized with every other wallet writer: the
    // courtesy check, the coin pick and the push are one critical section, and
    // a gift still landing (its faucet coin parked until the chain or the
    // mempool settles the claim) counts as a coin in the wallet. Without this,
    // two loopback requests could both see an empty wallet before either gift
    // confirms and each draw a mojo from a different ready coin (#245 review,
    // round 3). The lease is held across the chain reads, as the heartbeat
    // holds it across its own.
    let _lease = crate::chia_publish::WALLET_LEASE.lock().await;
    // A sealed lease (its file from the last run unreadable) refuses here,
    // before any chain read, with the reason (#245 review, round 19).
    crate::chia_publish::WALLET_LEASE.ensure_open()?;
    crate::chia_publish::WALLET_LEASE.reconcile(client).await;
    if crate::chia_publish::WALLET_LEASE.incoming_pending() {
        return Err(anyhow!(
            "your mojo from the dish is still on its way (about a minute); the wallet shows it when the block lands"
        ));
    }
    // Owned, not spendable: a coin parked by a spend in flight is still ours.
    let wallet = wallet_view(client, sk).await?;
    if !wallet.owned.is_empty() {
        return Err(anyhow!("your wallet already holds a coin; the dish is for players with an empty wallet"));
    }
    // A listing cut short proves nothing about emptiness (it lists coins, so
    // this cannot happen; should it, fail closed — #245 review, round 16).
    if wallet.partial {
        return Err(anyhow!("your wallet listing was cut short, so the dish cannot tell that it is empty"));
    }
    let peak = crate::chia_resolve::peak_height(client)
        .await
        .ok_or_else(|| anyhow!("chain peak unavailable (peers unreachable?)"))?;
    let faucet_ph = params.puzzle_hash();
    let coins = unspent_at(client, faucet_ph).await?.coins;
    let taken = |id: &Bytes32| crate::chia_publish::WALLET_LEASE.is_taken(id);
    let Some(target) = pick_ready_coin(&coins, params, peak, taken, &mut rand::rngs::OsRng) else {
        return Err(anyhow!("no mojo in the dish right now; it refills on the block clock"));
    };
    let recipient = crate::chia_publish::our_puzzle_hash(sk);

    // Dry-run locally first (claim_spend): a solution the puzzle rejects never
    // reaches the mempool.
    let coin_spend = claim_spend(params, target.coin, recipient)?;
    // Keyless: no AGG_SIG condition anywhere, so the aggregate is the identity.
    let bundle = SpendBundle::new(vec![coin_spend], chia_bls::Signature::default());
    // Not our coin, but a second TAKE before this one confirms must not pick it,
    // and while it stays parked (until the chain or the mempool settles the
    // claim) our wallet counts as holding the gift. Both marks go on BEFORE the
    // push (round 9): a push that times out may still have landed, and a wallet
    // reading empty with no gift landing would let a second TAKE through.
    // push_parked parks the coin first and hands it back only on an outright
    // rejection — then the gift is not landing either (incoming_pending reads
    // the parking). A mark that cannot be SAVED stops the claim here, before
    // anything leaves: a restart would otherwise forget it (round 19).
    // The claim is parked under the money address it pays into (stage 4
    // design §4.4): no key signs it, and the TAKE is the wallet's own action
    // under the lease, so an older node's TAKE (no payer filed, the money
    // address's) and this one read alike, and the `incoming` marker keeps
    // both out of the wallet's own spending.
    crate::chia_publish::WALLET_LEASE.mark_incoming(target.coin.coin_id())?;
    let payer = crate::chia_publish::Payer::of(sk);
    let unanswered =
        pushed(crate::chia_publish::push_parked(client, payer, bundle, [(target.coin.coin_id(), target.confirmed_height)]).await)?;
    match &unanswered {
        None => println!(
            "⛓️🥣 faucet: claimed {} mojo(s) from coin {} at {} (height {peak})",
            params.gift,
            hex::encode(target.coin.coin_id()),
            params.address(ctx.net)
        ),
        Some(why) => eprintln!(
            "⛓️🥣 faucet: claim of coin {} at {} pushed but unanswered ({why}); the coin stays parked until the chain or the mempool settles it",
            hex::encode(target.coin.coin_id()),
            params.address(ctx.net)
        ),
    }
    Ok(FaucetReply {
        op: "claim".into(),
        ok: true,
        error: None,
        status: None,
        spent_coin: Some(hex::encode(target.coin.coin_id())),
        after_snapshot: None,
        unanswered,
    })
}

#[cfg(not(feature = "chia-publish"))]
async fn claim(ctx: &FaucetContext<'_>, _client: &impl ChainAccess, params: &FaucetParams) -> Result<FaucetReply> {
    if let Some(why) = take_refusal(ctx.net, params) {
        return Err(anyhow!(why));
    }
    Err(anyhow!("this node was built without publishing; it cannot take a mojo"))
}

/// GIVE: pay `amount` mojos from our wallet into the faucet address, from as
/// many of our coins (largest first) as it takes, under the wallet spend lease.
/// Refused first off a test network ([`MAINNET_NO_GIVE`]), before the wallet
/// or the chain is asked anything.
#[cfg(feature = "chia-publish")]
async fn give(
    ctx: &FaucetContext<'_>,
    client: &impl ChainAccess,
    params: &FaucetParams,
    amount: u64,
) -> Result<FaucetReply> {
    use chia_puzzle_types::{DeriveSynthetic, Memos};
    use chia_sdk_driver::{SpendContext, StandardLayer};
    use chia_sdk_types::Conditions;

    if !ctx.net.is_test() {
        return Err(anyhow!(MAINNET_NO_GIVE));
    }
    let sk = ctx
        .wallet
        .as_ref()
        .ok_or_else(|| anyhow!(crate::chia_wallet_switch::no_wallet_words(ctx.env, ctx.net, ctx.turnable, "give")))?;
    if amount < params.gift {
        return Err(anyhow!("a gift below {} mojo(s) could never leave the jar", params.gift));
    }
    // Select, build and push under the lease: the heartbeat (or a second GIVE)
    // must not pick the same coins before this spend confirms.
    let _lease = crate::chia_publish::WALLET_LEASE.lock().await;
    crate::chia_publish::WALLET_LEASE.ensure_open()?;
    crate::chia_publish::WALLET_LEASE.reconcile(client).await;
    let wallet = wallet_view(client, sk).await?;
    if wallet.owned.is_empty() {
        return Err(anyhow!("your wallet is empty; fund it first (the dish takes, it does not lend)"));
    }
    if wallet.spendable.is_empty() {
        return Err(anyhow!("a spend from your wallet is still confirming (about a minute); give again after it lands"));
    }
    let total = wallet.spendable_mojos();
    let reach = give_reach(&wallet.spendable);
    let Some((coins, change)) = pick_give_coins(wallet.spendable, amount) else {
        return Err(if u128::from(amount) <= total {
            // Covered by the balance, not by MAX_GIVE_INPUTS coins of it (round 21).
            anyhow!(
                "your wallet is split into many small coins: one gift is paid from at most {MAX_GIVE_INPUTS} of them ({reach} mojos); give at most that in one go, or consolidate the wallet first"
            )
        } else {
            anyhow!("your wallet can spend {total} mojos right now; give at most that in one go")
        });
    };
    let our_ph = crate::chia_publish::our_puzzle_hash(sk);
    let faucet_ph = params.puzzle_hash();
    let mut ctx_spend = SpendContext::new();
    let layer = StandardLayer::new(sk.public_key().derive_synthetic());
    for (i, coin) in coins.iter().enumerate() {
        // The first coin carries the outputs (gift + change, fee 0 like every
        // lane spend); the others are consumed into it.
        let mut conditions = Conditions::new();
        if i == 0 {
            conditions = conditions.create_coin(faucet_ph, amount, Memos::None);
            if change > 0 {
                conditions = conditions.create_coin(our_ph, change, Memos::None);
            }
        }
        layer
            .spend(&mut ctx_spend, *coin, conditions)
            .map_err(|e| anyhow!("standard-layer spend: {e:?}"))?;
    }
    let bundle = crate::chia_publish::sign_standard_spends(ctx.net, sk, ctx_spend.take())?;
    // Coins parked before the push leaves (round 9): see push_parked.
    let inputs = coins
        .iter()
        .map(|c| crate::chia_publish::ParkedInput { coin_id: c.coin_id(), seen_at: wallet.seen_at.get(&c.coin_id()).copied() });
    // Paid by the wallet's key: its payer, the money address (§4.4).
    let unanswered = pushed(crate::chia_publish::push_parked(client, crate::chia_publish::Payer::of(sk), bundle, inputs).await)?;
    match &unanswered {
        None => println!(
            "⛓️🥣 faucet: gave {amount} mojo(s) into {} from {} coin(s), change {change}",
            params.address(ctx.net),
            coins.len()
        ),
        Some(why) => eprintln!(
            "⛓️🥣 faucet: gift of {amount} mojo(s) into {} pushed but unanswered ({why}); its {} coin(s) stay parked until the chain or the mempool settles it",
            params.address(ctx.net),
            coins.len()
        ),
    }
    Ok(FaucetReply {
        op: "give".into(),
        ok: true,
        error: None,
        status: None,
        spent_coin: Some(hex::encode(coins[0].coin_id())),
        after_snapshot: None,
        unanswered,
    })
}

#[cfg(not(feature = "chia-publish"))]
async fn give(
    ctx: &FaucetContext<'_>,
    _client: &impl ChainAccess,
    _params: &FaucetParams,
    _amount: u64,
) -> Result<FaucetReply> {
    if !ctx.net.is_test() {
        return Err(anyhow!(MAINNET_NO_GIVE));
    }
    Err(anyhow!("this node was built without publishing; it cannot give"))
}

/// What a push leaves for the reply (#245 review, round 14): `Ok(None)` when the
/// peers accepted it; `Ok(Some(why))` when it did not ANSWER — the spend may
/// be live and its inputs stay parked, so the request is answered as SENT with
/// `unanswered` set, never as a refusal that would let the player spend again
/// from other coins; `Err` only for a rejection, which proves nothing was spent,
/// or for a spend the lease would not let leave (round 19), which never did.
#[cfg(feature = "chia-publish")]
fn pushed(outcome: Result<(), crate::chia_publish::PushError>) -> Result<Option<String>> {
    use crate::chia_publish::PushError;
    match outcome {
        Ok(()) => Ok(None),
        Err(PushError::Unanswered(e)) => Ok(Some(format!("{e:#}"))),
        Err(rejected @ PushError::Rejected(_)) => Err(rejected.into()),
        // Not sent: the lease would not park (sealed, or its file unwritable),
        // so nothing left and nothing is parked; refused like a rejection.
        Err(not_sent @ PushError::NotSent(_)) => Err(not_sent.into()),
    }
}

// ── bech32m (BIP-350), enough to print a Chia address ───────────────────────
//
// The read build has no chia-sdk-utils (that is wallet territory), and an
// address is 60 lines of arithmetic. The publish build cross-checks this
// encoder against `chia_sdk_utils::Address` in its tests.
pub mod bech32m {
    const CHARSET: &[u8; 32] = b"qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const BECH32M_CONST: u32 = 0x2bc8_30a3;
    const GEN: [u32; 5] = [0x3b6a_57b2, 0x2650_8e6d, 0x1ea1_19fa, 0x3d42_33dd, 0x2a14_62b3];

    fn polymod(values: impl IntoIterator<Item = u8>) -> u32 {
        let mut chk: u32 = 1;
        for v in values {
            let b = chk >> 25;
            chk = ((chk & 0x1ff_ffff) << 5) ^ u32::from(v);
            for (i, g) in GEN.iter().enumerate() {
                if (b >> i) & 1 == 1 {
                    chk ^= g;
                }
            }
        }
        chk
    }

    fn hrp_expand(hrp: &str) -> Vec<u8> {
        let mut out: Vec<u8> = hrp.bytes().map(|c| c >> 5).collect();
        out.push(0);
        out.extend(hrp.bytes().map(|c| c & 31));
        out
    }

    /// 8-bit bytes → 5-bit words, zero-padded (the address convention).
    pub fn to_words(bytes: &[u8]) -> Vec<u8> {
        let mut acc: u32 = 0;
        let mut bits = 0u32;
        let mut out = Vec::with_capacity(bytes.len() * 8 / 5 + 1);
        for &b in bytes {
            acc = (acc << 8) | u32::from(b);
            bits += 8;
            while bits >= 5 {
                bits -= 5;
                out.push(((acc >> bits) & 31) as u8);
            }
        }
        if bits > 0 {
            out.push(((acc << (5 - bits)) & 31) as u8);
        }
        out
    }

    /// Encode 5-bit `words` under `hrp` with a bech32m checksum.
    pub fn encode_words(hrp: &str, words: &[u8]) -> String {
        let mut values = hrp_expand(hrp);
        values.extend_from_slice(words);
        let pm = polymod(values.iter().copied().chain([0u8; 6])) ^ BECH32M_CONST;
        let checksum = (0..6).map(|i| ((pm >> (5 * (5 - i))) & 31) as u8);
        let mut s = String::with_capacity(hrp.len() + 1 + words.len() + 6);
        s.push_str(hrp);
        s.push('1');
        for w in words.iter().copied().chain(checksum) {
            s.push(CHARSET[w as usize] as char);
        }
        s
    }

    pub fn encode(hrp: &str, bytes: &[u8]) -> String {
        encode_words(hrp, &to_words(bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chia_sdk_types::{run_puzzle, Conditions};
    use clvm_traits::FromClvm;
    use clvm_utils::tree_hash;

    /// The network the existing tests run on.
    const T11: ChiaNet = ChiaNet::Testnet11;

    /// The lobby's v1 parameters on a fixed room tag.
    fn test_params() -> FaucetParams {
        FaucetParams { room_tag: Bytes32::new([7u8; 32]), gift: GIFT_MOJOS, gap: GAP_BLOCKS, max_fee: MAX_FEE_MOJOS }
    }

    /// The lobby dish itself on `net`: the welcome room's, whose key ships in
    /// every build ([`FaucetParams::lobby`], which
    /// `the_lobby_dish_is_the_bundled_welcome_rooms_on_each_network` checks
    /// against the key written out).
    fn lobby_params(net: ChiaNet) -> FaucetParams {
        FaucetParams::lobby(net)
    }

    /// The welcome room's key, the one `chia_rooms::BUNDLED_ROOM_KEYS_B64`
    /// ships.
    fn lobby_key() -> [u8; 32] {
        crate::chia_rooms::decode_room_key(crate::chia_rooms::BUNDLED_ROOM_KEYS_B64[0]).unwrap()
    }

    /// A private-room dish that allows a fee, to exercise the fee arithmetic.
    fn fee_params() -> FaucetParams {
        FaucetParams { max_fee: 50_000_000, ..test_params() }
    }

    /// Run the curried puzzle on a solution and return its conditions.
    fn run(params: &FaucetParams, solution: impl ToClvm<Allocator>) -> Result<Vec<String>> {
        let mut a = Allocator::new();
        let puzzle = params.puzzle_reveal(&mut a)?;
        let sol = solution.to_clvm(&mut a).map_err(|e| anyhow!("{e:?}"))?;
        let out = run_puzzle(&mut a, puzzle, sol).map_err(|e| anyhow!("raise: {e:?}"))?;
        let conditions = Conditions::<NodePtr>::from_clvm(&a, out).map_err(|e| anyhow!("{e:?}"))?;
        Ok(conditions
            .into_iter()
            .map(|c| {
                if let Some(cc) = c.clone().into_create_coin() {
                    format!("create_coin {} {}", hex::encode(cc.puzzle_hash), cc.amount)
                } else if let Some(p) = c.clone().into_assert_my_puzzle_hash() {
                    format!("assert_my_puzzle_hash {}", hex::encode(p.puzzle_hash))
                } else if let Some(m) = c.clone().into_assert_my_amount() {
                    format!("assert_my_amount {}", m.amount)
                } else if let Some(h) = c.clone().into_assert_height_relative() {
                    format!("assert_height_relative {}", h.height)
                } else {
                    format!("other {c:?}")
                }
            })
            .collect())
    }

    #[tokio::test]
    async fn a_coin_spent_between_two_pages_is_not_counted_unspent() {
        use crate::chia_chain::testing::Scripted;
        use crate::chia_chain::{CoinListing, CoinRecord};
        // Coin 1 is unspent on the first page and spent by the time the second
        // is read, where it comes again (the chain pages by latest change).
        let coin = |seed: u8| Coin::new(Bytes32::new([seed; 32]), Bytes32::new([9u8; 32]), u64::from(seed));
        let rec = |c: Coin, height: u32, spent: Option<u32>| CoinRecord { coin: c, confirmed_block_index: height, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) };
        let first = CoinListing {
            records: vec![rec(coin(1), 80, None), rec(coin(2), 85, None)],
            truncated: true,
            next_cursor: Some("page-2".into()),
            judged_at: None,
        };
        let second = CoinListing { records: vec![rec(coin(1), 80, Some(101)), rec(coin(3), 101, None)], truncated: false, next_cursor: None, judged_at: None };
        let chain = Scripted::new(vec![first, second]);
        let got = unspent_at(&chain, Bytes32::new([9u8; 32])).await.unwrap();
        assert_eq!(got.coins.iter().map(|c| c.coin.amount).collect::<Vec<_>>(), vec![2, 3], "coin 1, spent between the pages, is gone");
        assert!(!got.partial);
        assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true, true], "spent coins asked for, so the spend can be seen");
    }

    /// The mod hash is the one origin/main's code gave before the network
    /// tag (247bc685): the tag goes into the curried room tag alone, never
    /// into the module (stage 4 design §3.5).
    #[test]
    fn mod_hash_is_pinned() {
        let mut a = Allocator::new();
        let module = mod_program(&mut a).unwrap();
        assert_eq!(tree_hash(&a, module), FAUCET_MOD_HASH);
        assert_eq!(
            hex::encode(FAUCET_MOD_HASH),
            "2e17deb872ddcbdfde5af2eb1f2471407e556ae2ba3d5d3afad6fd5f5e30816e"
        );
    }

    #[test]
    fn curried_hash_and_address_match_the_reference_tooling() {
        // Computed independently with clvm_tools (curry + sha256 tree hash) and
        // the BIP-350 reference encoder — see the PR for the script.
        let params = test_params();
        assert_eq!(
            hex::encode(params.puzzle_hash()),
            "ffd3a25bdaf219476e17d08cac6f3e223d685e9d0527e253d0da4d79d44c7249"
        );
        assert_eq!(params.address(T11), "txch1llf6yk767gv5wmsh6zx2cme7yg7ksh5aq5n7y57smfxhn4zvwfyscfgx6a");
        // The fee cap is curried too: a dish that allows one is another address.
        assert_eq!(
            hex::encode(fee_params().puzzle_hash()),
            "d7beae5412414d3ba9acd402455efefb92f939011185b73796927b99b9cdc49b"
        );
        // The reveal we would put in a spend hashes to the same puzzle hash.
        let mut a = Allocator::new();
        let reveal = params.puzzle_reveal(&mut a).unwrap();
        assert_eq!(Bytes32::from(tree_hash(&a, reveal)), params.puzzle_hash());
        // Different room, different gift: different address.
        let other = FaucetParams { room_tag: Bytes32::new([8u8; 32]), ..params };
        assert_ne!(other.puzzle_hash(), params.puzzle_hash());
        assert_ne!(FaucetParams { gift: 2, ..params }.puzzle_hash(), params.puzzle_hash());
    }

    #[test]
    fn bech32m_matches_bip350_and_the_zero_hash() {
        let words: Vec<u8> = (0..32u8).rev().collect();
        assert_eq!(bech32m::encode_words("abcdef", &words), "abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx");
        assert_eq!(
            bech32m::encode("txch", &[0u8; 32]),
            "txch1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq8mkeh3"
        );
    }

    #[test]
    fn a_claim_yields_exactly_the_faucet_conditions() {
        let params = test_params();
        let ph = params.puzzle_hash();
        let recipient = Bytes32::new([9u8; 32]);
        let conds = run(&params, clvm_list!(ph, 1000u64, recipient, 0u64)).unwrap();
        assert_eq!(
            conds,
            vec![
                format!("create_coin {} 999", hex::encode(ph)),
                format!("assert_my_puzzle_hash {}", hex::encode(ph)),
                "assert_my_amount 1000".to_string(),
                "assert_height_relative 32".to_string(),
                format!("create_coin {} 1", hex::encode(recipient)),
            ]
        );
        // Where a dish allows a fee, it comes out of the remainder, never the gift.
        let fee = fee_params();
        let fph = fee.puzzle_hash();
        let conds = run(&fee, clvm_list!(fph, 1000u64, recipient, 7u64)).unwrap();
        assert_eq!(conds[0], format!("create_coin {} 992", hex::encode(fph)));
        assert_eq!(conds[4], format!("create_coin {} 1", hex::encode(recipient)));
        // The last mojo leaves no remainder coin behind.
        let conds = run(&params, clvm_list!(ph, 1u64, recipient, 0u64)).unwrap();
        assert_eq!(conds.len(), 4);
        assert_eq!(conds[3], format!("create_coin {} 1", hex::encode(recipient)));
    }

    #[test]
    fn the_puzzle_rejects_every_other_spend() {
        let params = test_params();
        let ph = params.puzzle_hash();
        let recipient = Bytes32::new([9u8; 32]);
        // The lobby allows NO fee: a keyless claimer could otherwise burn the cap
        // from every ready coin every window (#245 review).
        assert!(run(&params, clvm_list!(ph, 1000u64, recipient, 1u64)).is_err(), "lobby: any fee at all");
        assert!(run(&params, clvm_list!(ph, 1000u64, recipient, 0u64)).is_ok());
        let fee = fee_params();
        let fph = fee.puzzle_hash();
        assert!(run(&fee, clvm_list!(fph, 1000u64, recipient, 50_000_001u64)).is_err(), "fee over cap");
        assert!(run(&fee, clvm_list!(fph, 60_000_000u64, recipient, 50_000_000u64)).is_ok(), "fee at cap");
        assert!(run(&fee, clvm_list!(fph, 1000u64, recipient, 50_000_000u64)).is_err(), "fee larger than the coin");
        assert!(run(&params, clvm_list!(ph, 1000u64, recipient, -1i64)).is_err(), "negative fee");
        assert!(run(&params, clvm_list!(ph, 0u64, recipient, 0u64)).is_err(), "nothing to give");
        let short = chia_protocol::Bytes::new(vec![9u8; 31]);
        assert!(run(&params, clvm_list!(ph, 1000u64, short, 0u64)).is_err(), "31-byte recipient");
        // Leaving dust (0 < remainder < GIFT) is refused: that coin could never be claimed.
        let gift5 = FaucetParams { gift: 5, ..params };
        let ph5 = gift5.puzzle_hash();
        assert!(run(&gift5, clvm_list!(ph5, 7u64, recipient, 0u64)).is_err(), "dust remainder");
        assert!(run(&gift5, clvm_list!(ph5, 10u64, recipient, 0u64)).is_ok());
        assert!(run(&gift5, clvm_list!(ph5, 5u64, recipient, 0u64)).is_ok());
    }

    #[test]
    fn summarize_counts_slots_ready_and_the_next_refill() {
        let params = test_params();
        let ph = params.puzzle_hash();
        let coin = |amount: u64, confirmed: u32| FaucetCoin {
            coin: Coin::new(Bytes32::new([1u8; 32]), ph, amount),
            confirmed_height: confirmed,
        };
        let coins = vec![coin(1000, 100), coin(5, 130), coin(0, 50)];
        let st = summarize(T11, &params, 140, &coins, false);
        assert_eq!((st.coins, st.ready, st.total_mojos), (2, 1, 1005));
        assert_eq!(st.next_ready_in_blocks, Some(22));
        assert_eq!(st.address, params.address(T11));
        assert!(!st.can_claim && !st.can_give && st.wallet_mojos.is_none() && !st.partial);
        assert!(st.wallet_spendable_mojos.is_none());
        // Everyone ready: no "next".
        let st = summarize(T11, &params, 200, &coins, true);
        assert_eq!((st.ready, st.next_ready_in_blocks, st.partial), (2, None, true));
        // Empty jar.
        let st = summarize(T11, &params, 200, &[], false);
        assert_eq!((st.coins, st.ready, st.total_mojos), (0, 0, 0));
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"nextReadyInBlocks\":null") && json.contains("\"canClaim\":false"));
        assert!(json.contains("\"partial\":false") && json.contains("\"walletPartial\":false"));
        // Numbered only by `status` itself, as the snapshot completes.
        assert!(json.contains("\"snapshot\":0"), "{json}");
        assert!(json.contains("\"spending\":false") && json.contains("\"landing\":false"), "{json}");
    }

    #[test]
    fn mojo_totals_travel_as_decimal_strings() {
        // Exact past 2^53 — a JSON number would round in the browser — and past
        // u64: two coins of u64::MAX each sum to 36893488147419103230.
        let params = test_params();
        let ph = params.puzzle_hash();
        let coin = |n: u8, amount: u64| FaucetCoin {
            coin: Coin::new(Bytes32::new([n; 32]), ph, amount),
            confirmed_height: 1,
        };
        let mut st = summarize(T11, &params, 100, &[coin(1, u64::MAX), coin(2, u64::MAX)], false);
        assert_eq!(st.total_mojos, 2 * u128::from(u64::MAX));
        st.wallet_mojos = Some(9_007_199_254_740_993);
        st.wallet_spendable_mojos = Some(9_007_199_254_740_000);
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"totalMojos\":\"36893488147419103230\""), "{json}");
        assert!(json.contains("\"walletMojos\":\"9007199254740993\""), "{json}");
        assert!(json.contains("\"walletSpendableMojos\":\"9007199254740000\""), "{json}");
        let back: FaucetStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, st);
        st.wallet_mojos = None;
        st.wallet_spendable_mojos = None;
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"walletMojos\":null"), "{json}");
        assert_eq!(serde_json::from_str::<FaucetStatus>(&json).unwrap(), st);
    }

    #[cfg(feature = "chia-publish")]
    #[test]
    fn give_takes_the_fewest_largest_coins_that_cover_the_gift() {
        let ph = Bytes32::new([5u8; 32]);
        let coin = |n: u8, amount: u64| Coin::new(Bytes32::new([n; 32]), ph, amount);
        // Two 600-mojo coins cover a 1,000-mojo gift together (the screen enables
        // the button from the 1,200 total), with 200 change.
        let (chosen, change) = pick_give_coins(vec![coin(1, 600), coin(2, 600)], 1000).unwrap();
        assert_eq!((chosen.len(), change), (2, 200));
        // Largest first, and no more coins than needed.
        let (chosen, change) = pick_give_coins(vec![coin(1, 10), coin(2, 5000), coin(3, 700)], 1000).unwrap();
        assert_eq!((chosen.len(), chosen[0].amount, change), (1, 5000, 4000));
        // An exact cover leaves no change; an uncoverable gift is refused.
        assert_eq!(pick_give_coins(vec![coin(1, 400), coin(2, 600)], 1000).unwrap().1, 0);
        // The running sum passes u64::MAX here; the change is still exact (a
        // saturating u64 sum reported 0 change for this pair).
        let (chosen, change) = pick_give_coins(vec![coin(1, u64::MAX - 1), coin(2, 2)], u64::MAX).unwrap();
        assert_eq!((chosen.len(), change), (2, 1));
        assert!(pick_give_coins(vec![coin(1, 400), coin(2, 500)], 1000).is_none());
        assert!(pick_give_coins(vec![], 1).is_none());
        // One gift is paid from at most MAX_GIVE_INPUTS coins (round 21): a
        // wallet dusted into 100 one-mojo coins reaches 64, covers 64, not 65.
        let dust: Vec<Coin> = (0..100u8).map(|n| coin(n, 1)).collect();
        assert_eq!(give_reach(&dust), MAX_GIVE_INPUTS as u128);
        let (chosen, change) = pick_give_coins(dust.clone(), MAX_GIVE_INPUTS as u64).unwrap();
        assert_eq!((chosen.len(), change), (MAX_GIVE_INPUTS, 0));
        assert!(pick_give_coins(dust, MAX_GIVE_INPUTS as u64 + 1).is_none());
    }

    #[cfg(feature = "chia-publish")]
    #[test]
    fn a_sealed_lease_offers_neither_take_nor_give_and_says_why() {
        use crate::chia_publish::LeaseError;
        let ph = Bytes32::new([5u8; 32]);
        let coin = |n: u8, amount: u64| Coin::new(Bytes32::new([n; 32]), ph, amount);
        let funded = WalletView { owned: vec![coin(1, 5_000)], spendable: vec![coin(1, 5_000)], seen_at: HashMap::new(), partial: false };
        let empty = WalletView { owned: vec![], spendable: vec![], seen_at: HashMap::new(), partial: false };
        // Open: a funded wallet gives, an empty one takes.
        let part = wallet_part(&funded, false, false, None, T11_READY);
        assert!(part.can_give && !part.can_claim, "{part:?}");
        let part = wallet_part(&empty, false, false, None, T11_READY);
        assert!(part.can_claim && !part.can_give && part.note.is_empty(), "{part:?}");
        // Sealed: neither, whatever the balance, and the note carries the reason,
        // so a poll clearing an earlier refusal does not re-enable the buttons.
        let sealed = LeaseError::Sealed("wallet_lease.json is unreadable".into());
        let part = wallet_part(&funded, false, false, Some(&sealed), T11_READY);
        assert!(!part.can_give && !part.can_claim, "{part:?}");
        assert!(part.note.contains("takes no spend") && part.note.contains("wallet_lease.json is unreadable"), "{}", part.note);
        let part = wallet_part(&empty, false, false, Some(&sealed), T11_READY);
        assert!(!part.can_claim && part.note.contains("sealed"), "{part:?}");
        // A wallet dusted into more coins than one gift may spend: GIVE stays on
        // for what the largest coins reach, and the note says to consolidate.
        let dust: Vec<Coin> = (0..100u8).map(|n| coin(n, 1)).collect();
        let dusted = WalletView { owned: dust.clone(), spendable: dust, seen_at: HashMap::new(), partial: false };
        let part = wallet_part(&dusted, false, false, None, T11_READY);
        assert!(part.can_give && part.note.contains("many small coins") && part.note.contains("(64 mojos)"), "{part:?}");
    }

    /// A ready testnet11 dish with a coin in it, for [`wallet_part`].
    #[cfg(feature = "chia-publish")]
    const T11_READY: Dish = Dish { gift: 1, ready: true, empty: false, gives: true };

    /// Mainnet holds an SSF wallet now, so the wallet's part of the note
    /// runs there: it keeps what is about TAKE and leaves out every hint
    /// about giving (split coins, a listing cut short, a spend still
    /// confirming), and calls an empty jar empty. Testnet11 keeps each of
    /// those hints. Since stage 4's §4.5 the dish takes no mojo there
    /// either, so [`network_part`] turns TAKE off and its word replaces the
    /// wallet's: the note never offers what the dish refuses.
    #[cfg(feature = "chia-publish")]
    #[test]
    fn off_a_test_network_the_wallet_note_never_speaks_of_giving() {
        let ph = Bytes32::new([5u8; 32]);
        let coin = |n: u8, amount: u64| Coin::new(Bytes32::new([n; 32]), ph, amount);
        let view = |coins: Vec<Coin>, partial: bool| WalletView { owned: coins.clone(), spendable: coins, seen_at: HashMap::new(), partial };
        let funded = view(vec![coin(1, 5_000)], false);
        let dusted = view((0..100u8).map(|n| coin(n, 1)).collect(), false);
        let cut_short = view(vec![coin(1, 5_000)], true);
        let empty = view(vec![], false);
        let main = |ready: bool, jar_empty: bool| Dish { gift: 1, ready, empty: jar_empty, gives: false };
        let t11 = |ready: bool, jar_empty: bool| Dish { gives: true, ..main(ready, jar_empty) };
        // (wallet, spending, ready, jar empty, testnet11's note, mainnet's note)
        let cases: [(&WalletView, bool, bool, bool, &str, &str); 7] = [
            (&funded, true, false, true, "a spend from your wallet is still confirming (about a minute); giving waits for it", ""),
            (&funded, false, false, true, "", ""),
            (&dusted, false, false, false, "consolidate it to give more at once", ""),
            (&dusted, false, true, false, "consolidate it to give more at once", "the dish is for players with an empty wallet; yours already holds a coin"),
            (&cut_short, false, false, false, "giving uses the ones it read", ""),
            (&empty, false, false, true, "no mojo in the dish yet; it refills on the block clock", "the jar is empty, so there is no mojo to take"),
            (&empty, false, false, false, "no mojo in the dish yet; it refills on the block clock", "no mojo in the dish yet; it refills on the block clock"),
        ];
        for (wallet, spending, ready, jar_empty, on_t11, on_main) in cases {
            let t = wallet_part(wallet, false, spending, None, t11(ready, jar_empty));
            assert!(t.note.contains(on_t11), "testnet11 keeps its hint: {t:?}");
            let m = wallet_part(wallet, false, spending, None, main(ready, jar_empty));
            assert_eq!(m.note, on_main, "{m:?}");
            assert_eq!(m.can_claim, t.can_claim, "the wallet's part reads TAKE alike on both networks");
            // Stage 4 design §4.5 (4) and (5): the network's part then turns
            // TAKE off too, and its word replaces the wallet's, at the
            // lobby's dish and at a room's own.
            for params in [lobby_params(ChiaNet::Mainnet), test_params()] {
                let (give, take, note) = network_part(ChiaNet::Mainnet, &params, m.can_give, m.can_claim, m.note.clone());
                assert!(!give && !take, "{note}");
                assert_eq!(note, format!("{} {MAINNET_NO_GIVE}", take_refusal(ChiaNet::Mainnet, &params).unwrap()));
            }
        }
        // A sealed lease and a mojo landing are about every spend and TAKE:
        // both networks say them.
        let sealed = crate::chia_publish::LeaseError::Sealed("wallet_lease.json is unreadable".into());
        assert!(wallet_part(&funded, false, false, Some(&sealed), main(true, false)).note.contains("takes no spend"));
        assert!(wallet_part(&empty, true, false, None, main(false, true)).note.contains("your mojo from the dish is on its way"));
    }

    #[test]
    fn an_unanswered_push_goes_out_as_sent_with_the_reason_never_as_a_refusal() {
        let sent = FaucetReply {
            op: "give".into(),
            ok: true,
            error: None,
            status: None,
            spent_coin: Some("ab".repeat(32)),
            after_snapshot: Some(7),
            unanswered: Some("operation timed out".into()),
        };
        let json = serde_json::to_string(&sent).unwrap();
        assert!(json.contains("\"ok\":true"), "{json}");
        assert!(json.contains("\"unanswered\":\"operation timed out\""), "{json}");
        assert!(json.contains("\"afterSnapshot\":7"), "{json}");
        // An accepted push sends no such field; a refusal is `ok: false` and never carries one.
        let accepted = serde_json::to_string(&FaucetReply { unanswered: None, ..sent.clone() }).unwrap();
        assert!(!accepted.contains("unanswered"), "{accepted}");
        let refused = serde_json::to_string(&FaucetReply::fail("give", "push_tx rejected: DOUBLE_SPEND")).unwrap();
        assert!(refused.contains("\"ok\":false") && !refused.contains("unanswered"), "{refused}");
    }

    #[cfg(feature = "chia-publish")]
    #[test]
    fn only_a_rejection_refuses_the_request() {
        use crate::chia_publish::PushError;
        assert_eq!(pushed(Ok(())).unwrap(), None);
        // Unanswered: the spend may be live; the request is answered as SENT with the reason.
        let unanswered = pushed(Err(PushError::Unanswered(anyhow!("operation timed out")))).unwrap();
        assert_eq!(unanswered.as_deref(), Some("operation timed out"));
        // Rejected: nothing was spent; the request is refused with the chain's reason.
        let refused = pushed(Err(PushError::Rejected("DOUBLE_SPEND".into()))).unwrap_err();
        assert!(refused.to_string().contains("DOUBLE_SPEND"), "{refused}");
        // Not sent: the lease could not save the parking, so nothing left; the
        // request is refused with that reason, never answered as sent.
        let unsaved = crate::chia_publish::LeaseError::Unsaved(std::io::Error::other("disk full"));
        let refused = pushed(Err(PushError::NotSent(unsaved))).unwrap_err().to_string();
        assert!(refused.contains("not sent") && refused.contains("disk full"), "{refused}");
    }

    #[test]
    fn handle_request_without_a_room_key_fails_closed() {
        let rooms = Mutex::new(HashMap::new());
        let ctx = FaucetContext {
            net: T11,
            rooms: &rooms,
            chia_off: false,
            #[cfg(feature = "chia-publish")]
            wallet: None,
            #[cfg(feature = "chia-publish")]
            env: crate::chia_wallet_switch::EnvSwitch::Unset,
            #[cfg(feature = "chia-publish")]
            turnable: true,
            #[cfg(feature = "chia-publish")]
            burners: false,
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let reply = rt.block_on(handle_request(&ctx, "home-abc", br#"{"op":"status"}"#));
        assert!(!reply.ok && reply.error.as_deref().unwrap_or("").contains("no key for this room"));
        let reply = rt.block_on(handle_request(&ctx, "home-abc", b"not json"));
        assert!(!reply.ok && reply.op == "?");
    }

    /// ⛓️ Chia off on this computer (chia_strict.rs): every op is answered
    /// off on either network, with the room's key held and a wallet on,
    /// before a chain client is built (the count of clients this thread built
    /// stays where it was).
    #[test]
    fn chia_off_answers_the_dish_before_a_chain_client_is_built() {
        use crate::chia_chain::CLIENTS_BUILT;
        let cap = ChiaRoomCap {
            room_key: [3; 32],
            chia_mode: true,
            share_card: true,
            public_room: Some(false),
            seq: 0,
            restored: false,
            pass_private: false,
            prefetch: false,
        };
        let rooms = Mutex::new(HashMap::from([("home-abc".to_string(), cap)]));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for net in ChiaNet::ALL {
            let ctx = FaucetContext {
                net,
                chia_off: true,
                rooms: &rooms,
                #[cfg(feature = "chia-publish")]
                wallet: Some(chia_bls::SecretKey::from_seed(&[5u8; 32])),
                #[cfg(feature = "chia-publish")]
                env: crate::chia_wallet_switch::EnvSwitch::On,
                #[cfg(feature = "chia-publish")]
                turnable: true,
                #[cfg(feature = "chia-publish")]
                burners: false,
            };
            let built = CLIENTS_BUILT.with(|n| n.get());
            for (payload, op) in [(&br#"{"op":"status"}"#[..], "status"), (br#"{"op":"claim"}"#, "claim"), (br#"{"op":"give","amount":5}"#, "give")] {
                let reply = rt.block_on(handle_request(&ctx, "home-abc", payload));
                assert!(!reply.ok, "{net:?} {op}");
                assert_eq!(reply.op, op);
                assert_eq!(reply.error.as_deref(), Some(crate::chia_strict::OFF_WORDS), "{net:?} {op}");
                assert!(reply.status.is_none() && reply.spent_coin.is_none() && reply.after_snapshot.is_none() && reply.unanswered.is_none());
            }
            assert_eq!(CLIENTS_BUILT.with(|n| n.get()), built, "{net:?}: no chain client was built");
        }
    }

    #[cfg(feature = "chia-publish")]
    #[test]
    fn address_matches_the_sdk_encoder_and_a_claim_bundle_is_keyless() {
        use chia_protocol::{CoinSpend, Program, SpendBundle};
        use chia_sdk_utils::Address;
        use clvmr::serde::node_to_bytes;

        let params = FaucetParams::for_room(T11, &[3u8; 32]);
        let ph = params.puzzle_hash();
        assert_eq!(params.address(T11), Address::new(ph, "txch".to_string()).encode().unwrap());

        let mut a = Allocator::new();
        let puzzle = params.puzzle_reveal(&mut a).unwrap();
        let recipient = Bytes32::new([4u8; 32]);
        let solution = claim_solution(&mut a, ph, 1000, recipient, 0).unwrap();
        let coin = Coin::new(Bytes32::new([2u8; 32]), ph, 1000);
        let spend = CoinSpend::new(
            coin,
            Program::from(node_to_bytes(&a, puzzle).unwrap()),
            Program::from(node_to_bytes(&a, solution).unwrap()),
        );
        let bundle = SpendBundle::new(vec![spend], chia_bls::Signature::default());
        // No signature is required anywhere in the bundle.
        let mut b = Allocator::new();
        let constants = chia_sdk_signer::AggSigConstants::from(&*chia_sdk_types::TESTNET11_CONSTANTS);
        let required = chia_sdk_signer::RequiredSignature::from_coin_spends(&mut b, &bundle.coin_spends, &constants).unwrap();
        assert!(required.is_empty());
        assert_eq!(bundle.coin_spends[0].coin.puzzle_hash, ph);
    }

    /// ⛓️ The dish's address on each network: the same puzzle hash under the
    /// network's own prefix, which the other network's decoder refuses.
    #[test]
    fn the_dish_address_takes_the_networks_prefix_over_one_puzzle_hash() {
        let params = test_params();
        let ph = params.puzzle_hash();
        assert_eq!(params.address(ChiaNet::Testnet11), "txch1llf6yk767gv5wmsh6zx2cme7yg7ksh5aq5n7y57smfxhn4zvwfyscfgx6a");
        for net in ChiaNet::ALL {
            let addr = params.address(net);
            assert!(addr.starts_with(&format!("{}1", net.prefix())), "{addr}");
            assert_eq!(addr, bech32m::encode(net.prefix(), &ph), "one puzzle hash under each prefix");
            #[cfg(feature = "chia-publish")]
            {
                use chia_sdk_utils::Address;
                let decoded = Address::decode(&addr).unwrap();
                assert_eq!(decoded.puzzle_hash, ph, "{net:?}");
                let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
                assert!(Address::decode(&addr).unwrap().expect_prefix(other.prefix()).is_err(), "{net:?}");
            }
        }
        assert_ne!(params.address(ChiaNet::Testnet11), params.address(ChiaNet::Mainnet));
    }

    #[test]
    fn the_status_names_its_network_and_mainnet_never_offers_give() {
        let params = test_params();
        for net in ChiaNet::ALL {
            let st = summarize(net, &params, 140, &[], false);
            assert_eq!(st.network, net);
            assert_eq!(st.address, params.address(net));
            let json = serde_json::to_value(&st).unwrap();
            assert_eq!(json["network"], net.id(), "the id the page reads");
            assert_eq!(json["address"], params.address(net));
            let back: FaucetStatus = serde_json::from_value(json).unwrap();
            assert_eq!(back, st);
        }
        // Testnet11 is as it was, at the lobby's dish and at a room's own.
        for dish in [lobby_params(T11), params] {
            assert_eq!(network_part(ChiaNet::Testnet11, &dish, true, true, String::new()), (true, true, String::new()));
            assert_eq!(network_part(ChiaNet::Testnet11, &dish, false, true, "x".into()), (false, true, "x".to_string()));
            assert_eq!(network_part(ChiaNet::Testnet11, &dish, true, false, "y".into()), (true, false, "y".to_string()));
        }
        // Mainnet offers neither, and says why in its own words, the
        // wallet's left out (stage 4 design §4.5 (4) and (5)).
        let (give, take, note) = network_part(ChiaNet::Mainnet, &lobby_params(ChiaNet::Mainnet), true, true, "no mojo in the dish yet".into());
        assert!(!give && !take);
        assert_eq!(note, "On mainnet the dish gives no mojo to this node's wallet. On mainnet the dish does not take gifts from this node.");
        let (give, take, note) = network_part(ChiaNet::Mainnet, &params, true, true, String::new());
        assert!(!give && !take);
        assert_eq!(
            note,
            "On mainnet nobody takes from a room's own dish, since that would tie its takers to the room. On mainnet the dish does not take gifts from this node."
        );
    }

    /// 🛑 Stage 4 design §4.5 (4) and (5), on both networks: TAKE into the
    /// SSF wallet is refused off a test network, and a claim at a room's own
    /// dish is refused there whoever it pays; only the network's own lobby
    /// dish is the lobby. A test network refuses neither.
    #[test]
    fn off_a_test_network_take_and_every_room_dish_claim_are_refused() {
        let room = test_params();
        for net in ChiaNet::ALL {
            let lobby = lobby_params(net);
            assert!(lobby.is_lobby(net), "{net:?}");
            assert!(!room.is_lobby(net) && !FaucetParams::for_room(net, &[3u8; 32]).is_lobby(net), "{net:?}");
            if net.is_test() {
                for dish in [&lobby, &room] {
                    assert_eq!(take_refusal(net, dish), None, "{net:?}");
                    assert_eq!(dish_claim_refusal(net, dish), None, "{net:?}");
                }
            } else {
                assert_eq!(dish_claim_refusal(net, &lobby), None, "the lobby's dish is not a room's own");
                assert_eq!(take_refusal(net, &lobby), Some(MAINNET_NO_TAKE));
                assert_eq!(dish_claim_refusal(net, &room), Some(MAINNET_NO_ROOM_DISH), "whoever the claim pays");
                assert_eq!(take_refusal(net, &room), Some(MAINNET_NO_ROOM_DISH), "the dish's refusal comes first");
                // testnet11's lobby dish is another address here (§3.5), so
                // it is no lobby of this network's: a room's own, refused.
                let other = lobby_params(ChiaNet::Testnet11);
                assert_eq!(dish_claim_refusal(net, &other), Some(MAINNET_NO_ROOM_DISH), "another network's lobby");
            }
        }
        for text in [MAINNET_NO_TAKE, MAINNET_NO_ROOM_DISH] {
            assert!(!text.contains('\u{2014}') && text.ends_with('.'), "{text}");
        }
    }

    /// TAKE on mainnet is refused before the wallet or the chain is asked,
    /// as GIVE is: the chain here answers nothing, so any read would fail
    /// otherwise, and with no wallet on the network is said first, never
    /// the Bank. Testnet11 gets past the network check.
    #[test]
    fn take_is_refused_on_mainnet_before_anything_is_read() {
        let rooms = Mutex::new(HashMap::new());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chain = crate::chia_chain::testing::Unanswering;
        let ctx = |net: ChiaNet, _held: bool| FaucetContext {
            net,
            chia_off: false,
            rooms: &rooms,
            #[cfg(feature = "chia-publish")]
            wallet: _held.then(|| chia_bls::SecretKey::from_seed(&[5u8; 32])),
            #[cfg(feature = "chia-publish")]
            env: crate::chia_wallet_switch::EnvSwitch::Unset,
            #[cfg(feature = "chia-publish")]
            turnable: true,
            #[cfg(feature = "chia-publish")]
            burners: false,
        };
        for held in [true, false] {
            let take = |dish: &FaucetParams| rt.block_on(claim(&ctx(ChiaNet::Mainnet, held), &chain, dish)).unwrap_err().to_string();
            assert_eq!(take(&lobby_params(ChiaNet::Mainnet)), MAINNET_NO_TAKE, "held {held}");
            assert_eq!(take(&test_params()), MAINNET_NO_ROOM_DISH, "held {held}");
        }
        // Testnet11, with no wallet on: past the network check, the wallet's
        // word comes next, and no lease or chain is asked.
        let err = rt.block_on(claim(&ctx(T11, false), &chain, &test_params())).unwrap_err().to_string();
        #[cfg(feature = "chia-publish")]
        assert_eq!(err, crate::chia_wallet_switch::no_wallet_words(crate::chia_wallet_switch::EnvSwitch::Unset, T11, true, "take a mojo"));
        #[cfg(not(feature = "chia-publish"))]
        assert_eq!(err, "this node was built without publishing; it cannot take a mojo");
    }

    /// Stage 4 design §5.2, on every network: a claim picks a ready coin at
    /// random among those the lease does not hold, never the largest first,
    /// and never a coin that is not ready (inside its gap, or dust below the
    /// gift) or that the lease holds.
    #[test]
    fn a_claim_picks_a_random_ready_coin_the_lease_does_not_hold() {
        use rand::SeedableRng;
        let params = test_params();
        let ph = params.puzzle_hash();
        let coin = |n: u8, amount: u64, height: u32| FaucetCoin { coin: Coin::new(Bytes32::new([n; 32]), ph, amount), confirmed_height: height };
        let peak = 200;
        let coins = vec![
            coin(1, 1_000_000, 100), // ready, the largest
            coin(2, 10, 120),        // ready
            coin(3, 1, 150),         // ready, exactly one gift
            coin(4, 5_000_000, 190), // inside its gap until 222
            coin(5, 0, 100),         // dust: below the gift
            coin(6, 7_000, 110),     // ready, but the lease holds it
        ];
        let held = coins[5].coin.coin_id();
        let taken = |id: &Bytes32| *id == held;
        let mut rng = rand::rngs::StdRng::seed_from_u64(0x55f0_d15b);
        let mut seen: HashMap<u8, u32> = HashMap::new();
        for _ in 0..600 {
            let pick = pick_ready_coin(&coins, &params, peak, taken, &mut rng).expect("three coins are ready");
            *seen.entry(pick.coin.parent_coin_info.as_ref()[0]).or_default() += 1;
        }
        let mut picked: Vec<u8> = seen.keys().copied().collect();
        picked.sort_unstable();
        assert_eq!(picked, vec![1, 2, 3], "every ready coin the lease does not hold, and no other: {seen:?}");
        assert!(seen.values().all(|n| *n >= 100), "spread over all three, not the largest first: {seen:?}");
        // Nothing ready: none, whatever the jar holds.
        assert!(pick_ready_coin(&coins, &params, 120, |_| false, &mut rng).is_none(), "below every gap");
        assert!(pick_ready_coin(&coins, &params, peak, |_| true, &mut rng).is_none(), "the lease holds them all");
        assert!(pick_ready_coin(&[], &params, peak, |_| false, &mut rng).is_none());
        // The coin past its gap joins the pick once it is ready.
        let later: Vec<u8> = (0..200)
            .filter_map(|_| pick_ready_coin(&coins, &params, 222, taken, &mut rng))
            .map(|c| c.coin.parent_coin_info.as_ref()[0])
            .collect();
        assert!(later.contains(&4), "{later:?}");
    }

    /// The status a mainnet node serves, end to end through `status`: a
    /// full jar on the chain, and still neither GIVE nor TAKE, with the
    /// network's note alone (stage 4 design §4.5 (4) and (5)): the dish
    /// takes no mojo into the SSF wallet there, so whatever holds the wallet
    /// off (the Bank, SSF_CHIA_LANE, a node only the desktop app can mint
    /// for) is not the reason and is not said. No wallet is held, so the
    /// wallet lease is never read, and `SSF_CHIA_LANE` comes from the
    /// context, never the environment. A room's own dish says that nobody
    /// takes from it there.
    #[test]
    fn a_mainnet_status_offers_no_take_or_give_and_says_why() {
        let rooms = Mutex::new(HashMap::new());
        let ctx = FaucetContext {
            net: ChiaNet::Mainnet,
            rooms: &rooms,
            chia_off: false,
            #[cfg(feature = "chia-publish")]
            wallet: None,
            #[cfg(feature = "chia-publish")]
            env: crate::chia_wallet_switch::EnvSwitch::Unset,
            #[cfg(feature = "chia-publish")]
            turnable: true,
            #[cfg(feature = "chia-publish")]
            burners: false,
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let lobby_note = "On mainnet the dish gives no mojo to this node's wallet. On mainnet the dish does not take gifts from this node.";
        let room_note = "On mainnet nobody takes from a room's own dish, since that would tie its takers to the room. On mainnet the dish does not take gifts from this node.";
        for (params, note) in [(lobby_params(ChiaNet::Mainnet), lobby_note), (test_params(), room_note)] {
            let coin = FaucetCoin { coin: Coin::new(Bytes32::new([1u8; 32]), params.puzzle_hash(), 1000), confirmed_height: 100 };
            let record = crate::chia_chain::CoinRecord { coin: coin.coin, confirmed_block_index: 100, spent: false, spent_block_index: 0 };
            let page = crate::chia_chain::CoinListing { records: vec![record], truncated: false, next_cursor: None, judged_at: None };
            let jar = || crate::chia_chain::testing::Scripted::new(vec![page.clone()]).with_peak(200);
            let st = rt.block_on(status(&ctx, &jar(), &params)).unwrap();
            assert_eq!((st.network, st.coins, st.ready, st.total_mojos), (ChiaNet::Mainnet, 1, 1, 1000), "the jar is read");
            assert_eq!(st.address, params.address(ChiaNet::Mainnet));
            assert!(st.address.starts_with("xch1"), "{}", st.address);
            assert!(!st.can_give && !st.can_claim, "{st:?}");
            assert_eq!(st.note, note);
            assert!(st.snapshot > 0, "numbered as it completed");
            #[cfg(feature = "chia-publish")]
            {
                // Held off by SSF_CHIA_LANE, or a node the Bank can bring no
                // wallet on: the same note, since neither is why.
                use crate::chia_wallet_switch::EnvSwitch;
                for (env, turnable) in [(EnvSwitch::Off, true), (EnvSwitch::Unset, false)] {
                    let held_off = FaucetContext { net: ChiaNet::Mainnet, chia_off: false, rooms: &rooms, wallet: None, env, turnable, burners: false };
                    let st = rt.block_on(status(&held_off, &jar(), &params)).unwrap();
                    assert!(!st.can_give && !st.can_claim, "{st:?}");
                    assert_eq!(st.note, note);
                }
            }
        }
    }

    /// The status a mainnet node with its SSF wallet on serves, end to end
    /// through `status`, at the lobby's dish: an empty jar (as every mainnet
    /// jar is until someone pays one) and then a funded wallet. Neither TAKE
    /// nor GIVE, and the network's note alone, whatever the wallet holds;
    /// the balance is read all the same. Nothing is parked in the wallet
    /// lease, so it reads no chain.
    #[cfg(feature = "chia-publish")]
    #[test]
    fn a_mainnet_status_with_a_wallet_on_offers_no_take_or_give() {
        let params = lobby_params(ChiaNet::Mainnet);
        let sk = chia_bls::SecretKey::from_seed(&[6u8; 32]);
        let listing = |records: Vec<crate::chia_chain::CoinRecord>| crate::chia_chain::CoinListing { records, truncated: false, next_cursor: None, judged_at: None };
        let ours = Coin::new(Bytes32::new([2u8; 32]), crate::chia_publish::our_puzzle_hash(&sk), 5_000);
        let funded = crate::chia_chain::CoinRecord { coin: ours, confirmed_block_index: 150, spent: false, spent_block_index: 0 };
        let rooms = Mutex::new(HashMap::new());
        let ctx = FaucetContext {
            net: ChiaNet::Mainnet,
            rooms: &rooms,
            chia_off: false,
            wallet: Some(sk),
            env: crate::chia_wallet_switch::EnvSwitch::Unset,
            turnable: true,
            burners: false,
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let note = format!("{MAINNET_NO_TAKE} {MAINNET_NO_GIVE}");
        // The jar's listing first, then the wallet's.
        let chain = crate::chia_chain::testing::Scripted::new(vec![listing(vec![]), listing(vec![])]).with_peak(200);
        let st = rt.block_on(status(&ctx, &chain, &params)).unwrap();
        assert_eq!((st.coins, st.wallet_mojos), (0, Some(0)), "{st:?}");
        assert!(!st.can_give && !st.can_claim, "an empty wallet takes nothing on mainnet: {st:?}");
        assert_eq!(st.note, note);
        let chain = crate::chia_chain::testing::Scripted::new(vec![listing(vec![]), listing(vec![funded])]).with_peak(200);
        let st = rt.block_on(status(&ctx, &chain, &params)).unwrap();
        assert_eq!(st.wallet_mojos, Some(5_000), "{st:?}");
        assert!(!st.can_give && !st.can_claim, "a funded wallet still gives nothing on mainnet: {st:?}");
        assert_eq!(st.note, note);
    }

    /// GIVE on mainnet is refused before the wallet or the chain is asked:
    /// the chain here answers nothing, so any read would fail otherwise.
    #[test]
    fn give_is_refused_on_mainnet_before_anything_is_read() {
        let rooms = Mutex::new(HashMap::new());
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let chain = crate::chia_chain::testing::Unanswering;
        let ctx = FaucetContext {
            net: ChiaNet::Mainnet,
            rooms: &rooms,
            chia_off: false,
            #[cfg(feature = "chia-publish")]
            wallet: Some(chia_bls::SecretKey::from_seed(&[5u8; 32])),
            #[cfg(feature = "chia-publish")]
            env: crate::chia_wallet_switch::EnvSwitch::Unset,
            #[cfg(feature = "chia-publish")]
            turnable: true,
            #[cfg(feature = "chia-publish")]
            burners: false,
        };
        let err = rt.block_on(give(&ctx, &chain, &test_params(), 1)).unwrap_err();
        assert_eq!(err.to_string(), MAINNET_NO_GIVE);
        // With no wallet on, too: the network is said first, never the Bank.
        let none = FaucetContext {
            net: ChiaNet::Mainnet,
            rooms: &rooms,
            chia_off: false,
            #[cfg(feature = "chia-publish")]
            wallet: None,
            #[cfg(feature = "chia-publish")]
            env: crate::chia_wallet_switch::EnvSwitch::Unset,
            #[cfg(feature = "chia-publish")]
            turnable: true,
            #[cfg(feature = "chia-publish")]
            burners: false,
        };
        assert_eq!(rt.block_on(give(&none, &chain, &test_params(), 1)).unwrap_err().to_string(), MAINNET_NO_GIVE);
        // Testnet11 gets past the network check: a gift too small to leave
        // the jar is refused next, before the chain is asked, and with a
        // wallet held no switch is read from the environment.
        let ctx = FaucetContext {
            net: T11,
            rooms: &rooms,
            chia_off: false,
            #[cfg(feature = "chia-publish")]
            wallet: Some(chia_bls::SecretKey::from_seed(&[5u8; 32])),
            #[cfg(feature = "chia-publish")]
            env: crate::chia_wallet_switch::EnvSwitch::Unset,
            #[cfg(feature = "chia-publish")]
            turnable: true,
            #[cfg(feature = "chia-publish")]
            burners: false,
        };
        let err = rt.block_on(give(&ctx, &chain, &test_params(), 0)).unwrap_err().to_string();
        #[cfg(feature = "chia-publish")]
        assert_eq!(err, "a gift below 1 mojo(s) could never leave the jar");
        #[cfg(not(feature = "chia-publish"))]
        assert_eq!(err, "this node was built without publishing; it cannot give");
    }

    // ── The network tag (stage 4 design §3.5; §12, "Network tag") ──────────

    /// The room key the dish vectors take besides the lobby's: test bytes,
    /// nobody's room.
    const ROOM_KEY: [u8; 32] = [0x33; 32];

    /// One dish on one network: the room tag curried in, the puzzle hash,
    /// and the address on that network.
    struct PinnedDish {
        net: ChiaNet,
        lobby: bool,
        tag: &'static str,
        puzzle_hash: &'static str,
        address: &'static str,
    }

    /// The lobby's dish and `ROOM_KEY`'s on each network. The testnet11 rows
    /// were printed by origin/main's own code (247bc685, the tree before the
    /// tag) by a test that was then removed, and copied here: they pin that
    /// the tag moved no testnet11 dish. The mainnet rows were printed by
    /// this file's code once the tag came in, and pin mainnet's dishes from
    /// here on; `mainnets_room_tag_is_the_v2_derivation_of_the_room_key_and_g`
    /// checks them against §3.5's line.
    const DISHES: [PinnedDish; 4] = [
        PinnedDish {
            net: ChiaNet::Testnet11,
            lobby: true,
            tag: "86db52c8cdda21832d9dfea1ebafca76e4778c32c9abc3c408cc47fe2d927f9b",
            puzzle_hash: "beff638c986f5ccf22f30373c7967c5255f27d51d549a1938f53554922a4395f",
            address: "txch1hmlk8rycdawv7ghnqdeu09nu2f2lyl2364y6ryu02d25jg4y890sxaqv8j",
        },
        PinnedDish {
            net: ChiaNet::Testnet11,
            lobby: false,
            tag: "bce8be46af5b3612eba7df170cd7999c559ffa75b180ac9ada9e836f67470290",
            puzzle_hash: "1164da9001df700fdc8e78edb17946f7a523a8b5e6a4eb7bd5cc08062b2fc3b8",
            address: "txch1z9jd4yqpmacqlhyw0rkmz72x77jj8294u6jwk774esyqv2e0cwuq2hy7hv",
        },
        PinnedDish {
            net: ChiaNet::Mainnet,
            lobby: true,
            tag: "50a1ca66900b25316c5a7ac9f932e4821ae043fc5016201102868fca5720bdc5",
            puzzle_hash: "cd0f2f4d727b9bbda146932688936f00539d45d7f985da56ae740cd07646c4d6",
            address: "xch1e58j7ntj0wdmmg2xjvng3ym0qpfe63whlxza544wwsxdqajxcntqwuzmp6",
        },
        PinnedDish {
            net: ChiaNet::Mainnet,
            lobby: false,
            tag: "c8c23fbf59e0dba22f286c9a68c1d5e27fcfeaa817429350403bc002069361ac",
            puzzle_hash: "f8b189fe85743d2533a6fbb86769213c1b923d4a7869d74dcf3886e5c0025caa",
            address: "xch1lzccnl59ws7j2vaxlwuxw6fp8sdey0220p5awnw08zrwtsqztj4qc8xd0e",
        },
    ];

    /// §12 Network tag: testnet11's lobby dish and a room's are where
    /// origin/main put them, and mainnet's are their own (see [`DISHES`] for
    /// where each row came from).
    #[test]
    fn each_networks_dishes_match_the_pinned_vectors() {
        assert_eq!(crate::chia_rooms::BUNDLED_ROOM_KEYS_B64.len(), 1, "one welcome room, whose dish is the lobby's");
        for d in &DISHES {
            let key = if d.lobby { lobby_key() } else { ROOM_KEY };
            let params = FaucetParams::for_room(d.net, &key);
            assert_eq!(hex::encode(params.room_tag), d.tag, "{:?} lobby={}: tag", d.net, d.lobby);
            assert_eq!(hex::encode(params.puzzle_hash()), d.puzzle_hash, "{:?} lobby={}: puzzle hash", d.net, d.lobby);
            assert_eq!(params.address(d.net), d.address, "{:?} lobby={}: address", d.net, d.lobby);
            assert_eq!((params.gift, params.gap, params.max_fee), (GIFT_MOJOS, GAP_BLOCKS, MAX_FEE_MOJOS), "only the tag is the network's");
        }
    }

    /// §3.5's line recomputed with blake3's incremental hasher and the
    /// contexts as the design writes them: on testnet11 the tag is
    /// `derive_key("ssf-faucet-room-tag-v1", room_key)`, on mainnet
    /// `derive_key("ssf-faucet-room-tag-v2", room_key ‖ G)`, for the lobby and
    /// a few other rooms. Mainnet's tag, and so its puzzle hash, differs from
    /// testnet11's for every one of them, no two dishes of the grid share an
    /// address, and the module is the same one: the curried reveal still
    /// hashes to the puzzle hash.
    #[test]
    fn mainnets_room_tag_is_the_v2_derivation_of_the_room_key_and_g() {
        let g = ChiaNet::Mainnet.genesis();
        let mut seen: HashMap<Bytes32, String> = HashMap::new();
        for room in [lobby_key(), ROOM_KEY, [0u8; 32], [0xff; 32]] {
            let t11 = FaucetParams::for_room(ChiaNet::Testnet11, &room);
            let main = FaucetParams::for_room(ChiaNet::Mainnet, &room);
            let v1: [u8; 32] = blake3::Hasher::new_derive_key("ssf-faucet-room-tag-v1").update(&room).finalize().into();
            let v2: [u8; 32] = blake3::Hasher::new_derive_key("ssf-faucet-room-tag-v2").update(&room).update(&g).finalize().into();
            assert_eq!(t11.room_tag, Bytes32::new(v1), "testnet11, room {:02x}", room[0]);
            assert_eq!(main.room_tag, Bytes32::new(v2), "mainnet, room {:02x}", room[0]);
            assert_ne!(main.room_tag, t11.room_tag, "room {:02x}", room[0]);
            for (net, params) in [(ChiaNet::Testnet11, t11), (ChiaNet::Mainnet, main)] {
                let name = format!("{net:?} room {:02x}", room[0]);
                if let Some(before) = seen.insert(params.puzzle_hash(), name.clone()) {
                    panic!("{name} and {before} share a dish");
                }
                let mut a = Allocator::new();
                let reveal = params.puzzle_reveal(&mut a).unwrap();
                assert_eq!(Bytes32::from(tree_hash(&a, reveal)), params.puzzle_hash(), "{name}");
            }
        }
        assert_eq!(hex::encode(FAUCET_MOD_HASH), "2e17deb872ddcbdfde5af2eb1f2471407e556ae2ba3d5d3afad6fd5f5e30816e", "the module is unchanged");
    }

    /// The lobby on each network is that network's own lobby dish; the other
    /// network's lobby dish, a room's dish and a fixed-tag dish are not, so
    /// mainnet's claim rule (`dish_claim_refusal`) admits mainnet's lobby
    /// dish alone.
    #[test]
    fn the_lobby_is_the_lobby_of_its_own_network_alone() {
        for net in ChiaNet::ALL {
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            assert!(lobby_params(net).is_lobby(net), "{net:?}");
            assert!(!lobby_params(other).is_lobby(net), "{net:?}: {other:?}'s lobby dish");
            assert!(!FaucetParams::for_room(net, &ROOM_KEY).is_lobby(net), "{net:?}: a room's own dish");
            assert!(!test_params().is_lobby(net), "{net:?}: a fixed tag");
            assert_ne!(lobby_params(net), lobby_params(other), "{net:?}: one lobby dish per network");
        }
    }

    /// Stage 4 design §5.1: the dish a burner is funded from is the welcome
    /// room's on each network, its key written out here rather than taken
    /// through the helpers, which call `FaucetParams::lobby` themselves. It
    /// is the dish `is_lobby` accepts, at the puzzle hash `DISHES` pins, each
    /// network's own, and the dish's claim rule admits a claim at it on every
    /// network.
    #[test]
    fn the_lobby_dish_is_the_bundled_welcome_rooms_on_each_network() {
        for net in ChiaNet::ALL {
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            let lobby = FaucetParams::lobby(net);
            let written_out = FaucetParams::for_room(
                net,
                &crate::chia_rooms::decode_room_key(crate::chia_rooms::BUNDLED_ROOM_KEYS_B64[0]).unwrap(),
            );
            assert_eq!(lobby, written_out, "{net:?}");
            assert!(lobby.is_lobby(net), "{net:?}");
            assert_ne!(lobby, FaucetParams::lobby(other), "{net:?}: each network has its own");
            let pinned = DISHES.iter().find(|d| d.net == net && d.lobby).expect("a pinned lobby row per network");
            assert_eq!(hex::encode(lobby.puzzle_hash()), pinned.puzzle_hash, "{net:?}");
            assert_eq!(dish_claim_refusal(net, &lobby), None, "{net:?}: the lobby admits a claim");
        }
    }

    /// The claim TAKE sends, now built by `claim_spend` for TAKE and the
    /// claim-and-write alike: the same spend as one built by hand the way
    /// `address_matches_the_sdk_encoder_and_a_claim_bundle_is_keyless` builds
    /// it, fee 0, and no signature is required of it (stage 4 design §5.4).
    #[cfg(feature = "chia-publish")]
    #[test]
    fn a_claim_spend_is_the_keyless_fee_zero_claim_take_sends() {
        use chia_protocol::{CoinSpend, Program};
        use clvmr::serde::node_to_bytes;

        for params in [FaucetParams::for_room(T11, &[3u8; 32]), FaucetParams::lobby(T11)] {
            let ph = params.puzzle_hash();
            let mut a = Allocator::new();
            let puzzle = params.puzzle_reveal(&mut a).unwrap();
            let recipient = Bytes32::new([4u8; 32]);
            let solution = claim_solution(&mut a, ph, 1000, recipient, 0).unwrap();
            let coin = Coin::new(Bytes32::new([2u8; 32]), ph, 1000);
            let by_hand = CoinSpend::new(
                coin,
                Program::from(node_to_bytes(&a, puzzle).unwrap()),
                Program::from(node_to_bytes(&a, solution).unwrap()),
            );
            let spend = claim_spend(&params, coin, recipient).unwrap();
            assert_eq!(spend, by_hand);
            let mut b = Allocator::new();
            let constants = chia_sdk_signer::AggSigConstants::from(&*chia_sdk_types::TESTNET11_CONSTANTS);
            let required = chia_sdk_signer::RequiredSignature::from_coin_spends(&mut b, &[spend], &constants).unwrap();
            assert!(required.is_empty(), "no key signs a claim");
        }
    }

    /// Stage 4 design §4.1: a dish claim names the coins its spend creates
    /// before anything leaves: the gift at the recipient, whose id is the
    /// hash of F's id, the recipient's puzzle hash and 1 (for a burner, g),
    /// and the rest back at the dish, none when F held exactly the gift. The
    /// readers' own condition walk finds those coins and no other, so the
    /// claim pays no fee. A coin below the gift is the puzzle's refusal, not
    /// an underflow.
    #[test]
    fn a_dish_claim_pays_the_gift_to_its_recipient_and_the_rest_back_to_the_dish() {
        let params = test_params();
        let ph = params.puzzle_hash();
        let recipient = Bytes32::new([9u8; 32]);
        let dish = |amount: u64| FaucetCoin { coin: Coin::new(Bytes32::new([5u8; 32]), ph, amount), confirmed_height: 100 };
        let created = |claim: &DishClaim| -> Vec<Coin> {
            let spend = crate::chia_chain::PuzzleAndSolution {
                puzzle_reveal: claim.spend.puzzle_reveal.clone(),
                solution: claim.spend.solution.clone(),
            };
            crate::chia_resolve::created_coins(&spend)
                .unwrap()
                .into_iter()
                .map(|c| Coin::new(claim.dish.coin.coin_id(), c.puzzle_hash, c.amount))
                .collect()
        };

        let f = dish(10);
        let claim = dish_claim(&params, f.clone(), recipient).unwrap();
        assert_eq!((claim.params, &claim.dish), (params, &f));
        assert_eq!(claim.spend, claim_spend(&params, f.coin, recipient).unwrap(), "the spend TAKE sends");
        assert_eq!(claim.gift.coin_id(), Coin::new(f.coin.coin_id(), recipient, 1).coin_id(), "g's id is known before the push");
        assert_eq!(claim.remainder, Some(Coin::new(f.coin.coin_id(), ph, 9)));
        assert_eq!(created(&claim), vec![claim.remainder.unwrap(), claim.gift], "what the spend creates, and no fee");
        assert_eq!(run(&params, claim.spend.solution.clone()).unwrap().len(), 5);

        let last = dish_claim(&params, dish(1), recipient).unwrap();
        assert_eq!(last.remainder, None, "the last mojo leaves nothing at the dish");
        assert_eq!(created(&last), vec![last.gift]);
        assert_eq!(run(&params, last.spend.solution.clone()).unwrap().len(), 4);

        let below = dish_claim(&params, dish(0), recipient).unwrap_err();
        assert!(below.to_string().contains("rejected our claim locally"), "{below}");
    }

    /// One listing page of the coins at the lobby dish of `net`, each
    /// `(parent byte, amount, confirmed height)`, all unspent.
    fn lobby_listing(net: ChiaNet, coins: &[(u8, u64, u32)]) -> crate::chia_chain::CoinListing {
        let ph = FaucetParams::lobby(net).puzzle_hash();
        crate::chia_chain::CoinListing {
            records: coins
                .iter()
                .map(|&(n, amount, height)| crate::chia_chain::CoinRecord {
                    coin: Coin::new(Bytes32::new([n; 32]), ph, amount),
                    confirmed_block_index: height,
                    spent: false,
                    spent_block_index: 0,
                })
                .collect(),
            truncated: false,
            next_cursor: None,
            judged_at: None,
        }
    }

    /// Stage 4 design §5.1 and §5.2: `claim_to` claims from the lobby dish
    /// alone, at random among its ready coins that it is not told are taken,
    /// and picks afresh on each call, since it pushes and marks nothing. A
    /// coin inside its gap, or one the caller holds, is never picked. Off a
    /// test network it asks the dish's own rule, which admits the lobby, not
    /// TAKE's, which refuses a claim into the SSF wallet there.
    #[tokio::test]
    async fn claim_to_picks_at_random_among_ready_lobby_coins_it_is_not_told_are_taken() {
        use crate::chia_chain::testing::Scripted;
        use rand::SeedableRng;
        let recipient = Bytes32::new([0xc1; 32]);
        let peak = 200;
        let coins = [
            (1, 10, 100), // ready
            (2, 1, 150),  // ready, exactly one gift
            (3, 7, 120),  // ready, but the caller holds it
            (4, 50, 190), // inside its gap until 222
        ];
        let held = Coin::new(Bytes32::new([3u8; 32]), FaucetParams::lobby(T11).puzzle_hash(), 7).coin_id();
        let taken = |id: &Bytes32| *id == held;
        let mut seen: HashMap<u8, u32> = HashMap::new();
        for seed in 0..64u64 {
            let chain = Scripted::new(vec![lobby_listing(T11, &coins)]).with_peak(peak);
            let claim = claim_to(T11, &chain, recipient, taken, &mut rand::rngs::StdRng::seed_from_u64(seed)).await.unwrap();
            assert_eq!(claim.params, FaucetParams::lobby(T11), "seed {seed}: the lobby dish alone");
            assert_eq!(claim.spend.coin, claim.dish.coin, "seed {seed}");
            assert_eq!(claim.gift, Coin::new(claim.dish.coin.coin_id(), recipient, GIFT_MOJOS), "seed {seed}");
            assert_eq!(*chain.asked_spent.lock().unwrap(), vec![true], "seed {seed}: one listing of the dish");
            *seen.entry(claim.dish.coin.parent_coin_info.as_ref()[0]).or_default() += 1;
        }
        let mut picked: Vec<u8> = seen.keys().copied().collect();
        picked.sort_unstable();
        assert_eq!(picked, vec![1, 2], "both free ready coins, never the held one or the one inside its gap: {seen:?}");
        let main = ChiaNet::Mainnet;
        let chain = Scripted::new(vec![lobby_listing(main, &coins)]).with_peak(peak);
        let claim = claim_to(main, &chain, recipient, |_| false, &mut rand::rngs::StdRng::seed_from_u64(7)).await.unwrap();
        assert_eq!(claim.params, FaucetParams::lobby(main), "mainnet's own lobby dish");
        assert!(take_refusal(main, &claim.params).is_some(), "where TAKE's rule refuses a claim into the SSF wallet");
    }

    /// Stage 4 design §5.2 and §10: a dish with no ready coin the caller does
    /// not hold is `ClaimToError::NoCoinReady`, a wait the caller tells from
    /// a failure by its type; with no peak answered it is `PeakUnavailable`,
    /// and the dish is not listed. A listing that fails is no wait for the
    /// dish but the listing's own failed read ([`CoinLookupFailed`]).
    #[tokio::test]
    async fn claim_to_says_no_coin_ready_as_its_own_error() {
        use crate::chia_chain::testing::Scripted;
        use rand::SeedableRng;
        let recipient = Bytes32::new([0xc1; 32]);
        let mut rng = rand::rngs::StdRng::seed_from_u64(1);
        let typed = |e: &anyhow::Error| e.downcast_ref::<ClaimToError>().copied();
        let ready = [(1, 10, 100)];
        for (why, coins, held) in [
            ("inside its gap, or dust", &[(1, 10, 190), (2, 0, 100)][..], false),
            ("every ready coin held", &ready[..], true),
            ("an empty dish", &[][..], false),
        ] {
            let chain = Scripted::new(vec![lobby_listing(T11, coins)]).with_peak(200);
            let err = claim_to(T11, &chain, recipient, |_| held, &mut rng).await.unwrap_err();
            assert_eq!(typed(&err), Some(ClaimToError::NoCoinReady), "{why}: {err}");
        }
        let chain = Scripted::new(vec![lobby_listing(T11, &ready)]);
        let err = claim_to(T11, &chain, recipient, |_| false, &mut rng).await.unwrap_err();
        assert_eq!(typed(&err), Some(ClaimToError::PeakUnavailable), "{err}");
        assert!(chain.asked_spent.lock().unwrap().is_empty(), "no listing without a peak");
        let chain = Scripted::new(vec![]).with_peak(200);
        let err = claim_to(T11, &chain, recipient, |_| false, &mut rng).await.unwrap_err();
        assert_eq!(typed(&err), None, "a failed listing is no wait for the dish: {err}");
        assert!(err.downcast_ref::<CoinLookupFailed>().is_some(), "but a failed read, typed: {err}");
        assert_eq!(err.to_string(), "coin lookup: unanswered (nothing listens (test chain))", "in the words the listing always said");
    }
}
