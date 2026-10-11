//! ⛓️🥣 The faucet coin — the node side of the faucet dish (issue #231,
//! onboarding phase beside P8; design note ssf-p2p/faucet-dish-design.md).
//!
//! The "volunteer wallet" is a set of coins at ONE puzzle hash per room, locked
//! by `puzzles/faucet.clsp`. Nobody holds a key for it: the puzzle alone decides
//! how coins leave — exactly one GIFT per coin per GAP blocks, to whoever submits
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
//! from. Publish side (`chia-publish` with the wallet loaded, i.e.
//! `SSF_CHIA_LANE=1`): the CLAIM spend — keyless, puzzle reveal + solution and an
//! EMPTY aggregated signature, the faucet coin the spend's only input — and the
//! GIVE spend, our standard-puzzle coins paying into the faucet address. Both
//! run under the wallet spend lease (`chia_publish::WALLET_LEASE`): GIVE so it
//! never picks a coin another spend is consuming, CLAIM so the courtesy check,
//! the coin pick and the push are one critical section and a gift still
//! landing counts as a coin in the wallet. Testnet11 only until P8 (every gift
//! and donation links addresses on a public chain).
#![cfg(feature = "chia-read")]

use std::collections::HashMap;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use chia_protocol::{Bytes32, Coin};
use chia_sdk_coinset::{ChiaRpcClient, CoinsetClient};
use clvm_traits::{clvm_curried_args, clvm_list, ToClvm};
use clvm_utils::{CurriedProgram, ToTreeHash, TreeHash};
use clvmr::serde::node_from_bytes;
use clvmr::{Allocator, NodePtr};
use serde::{Deserialize, Serialize};

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
/// is one-way: a private room's address reveals nothing about its key.
const CTX_ROOM_TAG: &str = "ssf-faucet-room-tag-v1";

/// Testnet11 bech32m prefix for the address the dish shows (mainnet: `xch`).
const ADDRESS_HRP: &str = "txch";

/// What is curried into the faucet puzzle for one room.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FaucetParams {
    pub room_tag: Bytes32,
    pub gift: u64,
    pub gap: u32,
    pub max_fee: u64,
}

impl FaucetParams {
    /// The room's faucet, v1 parameters. The welcome lobby's key ships in every
    /// build, so its address is the same for everyone — public by design.
    pub fn for_room(room_key: &[u8; 32]) -> Self {
        Self {
            room_tag: blake3::derive_key(CTX_ROOM_TAG, room_key).into(),
            gift: GIFT_MOJOS,
            gap: GAP_BLOCKS,
            max_fee: MAX_FEE_MOJOS,
        }
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

    /// The `txch1…` form of [`Self::puzzle_hash`] — what the dish prints so a
    /// donor can pay into it from any Chia wallet.
    pub fn address(&self) -> String {
        bech32m::encode(ADDRESS_HRP, &self.puzzle_hash())
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
    /// This snapshot's number: status reads are captured ONE AT A TIME (see
    /// `STATUS_TURN`) and numbered as they complete, so a higher number is a
    /// later look at the chain and the wallet whatever order the browser's
    /// requests were sent in. The browser keeps the highest it has seen. 0
    /// from `summarize` alone (a snapshot `status` has not numbered).
    pub snapshot: u64,
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
/// `partial` says the listing was cut short (see [`unspent_at`]).
pub fn summarize(params: &FaucetParams, peak: u32, coins: &[FaucetCoin], partial: bool) -> FaucetStatus {
    let claimable: Vec<&FaucetCoin> = coins.iter().filter(|c| c.claimable(params)).collect();
    let ready = claimable.iter().filter(|c| c.ready(params, peak)).count() as u32;
    let next_ready_in_blocks = claimable
        .iter()
        .filter(|c| !c.ready(params, peak))
        .map(|c| c.ready_at(params) - peak)
        .min();
    FaucetStatus {
        address: params.address(),
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
        snapshot: 0,
    }
}

/// Gateway pages followed per listing (one HTTPS call each). A faucet address is
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

/// The unspent coins at `puzzle_hash`, following the gateway's cursor.
pub async fn unspent_at(client: &CoinsetClient, puzzle_hash: Bytes32) -> Result<Unspent> {
    let mut coins = Vec::new();
    let mut cursor: Option<String> = None;
    let mut pages = 0usize;
    let partial = loop {
        let resp = client
            .get_coin_records_by_puzzle_hash(puzzle_hash, None, None, Some(false), cursor.take())
            .await
            .map_err(|e| anyhow!("coinset get_coin_records_by_puzzle_hash failed: {e}"))?;
        if !resp.success {
            return Err(anyhow!("coin lookup unsuccessful: {:?}", resp.error));
        }
        pages += 1;
        coins.extend(
            resp.coin_records
                .unwrap_or_default()
                .into_iter()
                .filter(|r| !r.spent)
                .map(|r| FaucetCoin { coin: r.coin, confirmed_height: r.confirmed_block_index }),
        );
        let truncated = resp.truncated.unwrap_or(false);
        match resp.next_cursor {
            Some(next) if truncated => {
                if pages >= MAX_FAUCET_PAGES {
                    break true;
                }
                cursor = Some(next);
            }
            _ => break truncated,
        }
    };
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
    /// The id of the coin a claim or gift spent, once the mempool accepted it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spent_coin: Option<String>,
}

impl FaucetReply {
    fn fail(op: &str, error: impl Into<String>) -> Self {
        Self { op: op.to_string(), ok: false, error: Some(error.into()), status: None, spent_coin: None }
    }
    /// A request the node will not serve at all (wrong source), op unknown.
    pub fn refused(error: impl Into<String>) -> Self {
        Self::fail("?", error)
    }
}

/// What a request needs from the node: the room caps (for the room key) and,
/// in a publish build, the wallet key when `SSF_CHIA_LANE=1` loaded one.
pub struct FaucetContext<'a> {
    pub rooms: &'a Mutex<HashMap<String, ChiaRoomCap>>,
    #[cfg(feature = "chia-publish")]
    pub wallet: Option<chia_bls::SecretKey>,
}

/// Serve one `faucet` request from the LOCAL browser for `room`.
pub async fn handle_request(ctx: &FaucetContext<'_>, room: &str, payload: &[u8]) -> FaucetReply {
    let req: FaucetRequest = match serde_json::from_slice(payload) {
        Ok(r) => r,
        Err(e) => return FaucetReply::fail("?", format!("malformed faucet request: {e}")),
    };
    let room_key = ctx.rooms.lock().unwrap().get(room).map(|cap| cap.room_key);
    let Some(room_key) = room_key else {
        return FaucetReply::fail(
            &req.op,
            "the node has no key for this room yet (the browser sends it when it connects); try again in a moment",
        );
    };
    let params = FaucetParams::for_room(&room_key);
    let client = CoinsetClient::testnet11();
    let result = match req.op.as_str() {
        "status" => status(ctx, &client, &params).await.map(|s| FaucetReply {
            op: "status".into(),
            ok: true,
            error: None,
            status: Some(s),
            spent_coin: None,
        }),
        "claim" => claim(ctx, &client, &params).await,
        "give" => give(ctx, &client, &params, req.amount).await,
        other => Err(anyhow!("unknown faucet op {other:?}")),
    };
    match result {
        Ok(reply) => reply,
        Err(e) => FaucetReply::fail(&req.op, format!("{e:#}")),
    }
}

async fn status(ctx: &FaucetContext<'_>, client: &CoinsetClient, params: &FaucetParams) -> Result<FaucetStatus> {
    // One snapshot at a time, numbered as it completes (see STATUS_TURN). Taken
    // before the wallet lease below, never after it: the writers take the lease
    // alone, so the two never wait on each other in a cycle.
    let _turn = STATUS_TURN.lock().await;
    let peak = crate::chia_resolve::peak_height(client)
        .await
        .ok_or_else(|| anyhow!("chain peak unavailable (gateway down?)"))?;
    let listing = unspent_at(client, params.puzzle_hash()).await?;
    let mut st = summarize(params, peak, &listing.coins, listing.partial);
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
                crate::chia_publish::WALLET_LEASE.reconcile(client).await;
                let wallet = wallet_view(client, sk).await?;
                st.wallet_mojos = Some(wallet.owned_mojos());
                st.wallet_spendable_mojos = Some(wallet.spendable_mojos());
                st.wallet_partial = wallet.partial;
                st.can_give = wallet.spendable_mojos() >= u128::from(params.gift);
                // The courtesy check reads what we OWN: a coin parked by a spend
                // in flight is still ours, so the wallet is not empty. A gift
                // from the dish that is still landing counts the same way (the
                // chain lists it only once the block confirms).
                let landing = crate::chia_publish::WALLET_LEASE.incoming_pending();
                st.can_claim = wallet.owned.is_empty() && !landing && st.ready > 0;
                st.note = if wallet.owned.is_empty() && landing {
                    "your mojo from the dish is on its way (about a minute); the wallet shows it when the block lands".into()
                } else if !wallet.owned.is_empty() && st.ready > 0 {
                    "the dish is for players with an empty wallet; yours already holds a coin".into()
                } else if wallet.owned.is_empty() && st.ready == 0 {
                    "no mojo in the dish yet; it refills on the block clock".into()
                } else if wallet.partial {
                    "your wallet holds more coins than the dish lists (cut short); giving uses the ones it read".into()
                } else if wallet.spendable_mojos() < wallet.owned_mojos() {
                    "a spend from your wallet is still confirming (about a minute); giving waits for it".into()
                } else {
                    String::new()
                };
            }
            None => {
                st.note = "this node has no wallet loaded (start it with SSF_CHIA_LANE=1 to take or give)".into();
            }
        }
    }
    #[cfg(not(feature = "chia-publish"))]
    {
        let _ = ctx;
        st.note = "this node was built without publishing; it can show the dish but not take or give".into();
    }
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
async fn wallet_view(client: &CoinsetClient, sk: &chia_bls::SecretKey) -> Result<WalletView> {
    let ph = crate::chia_publish::our_puzzle_hash(sk);
    let listing = unspent_at(client, ph).await?;
    let owned: Vec<Coin> = listing.coins.into_iter().map(|c| c.coin).collect();
    let spendable = owned
        .iter()
        .copied()
        .filter(|c| !crate::chia_publish::WALLET_LEASE.is_pending(&c.coin_id()))
        .collect();
    Ok(WalletView { owned, spendable, partial: listing.partial })
}

/// Which of our coins pay a gift of `amount`: largest first until they cover it,
/// so a wallet split over several small coins can still give what the screen
/// enabled from its total (#245 review). `None` when the wallet cannot cover it;
/// otherwise the coins and the change.
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
    }
    None
}

/// CLAIM: spend the readiest faucet coin, GIFT to our own address, keyless.
#[cfg(feature = "chia-publish")]
async fn claim(ctx: &FaucetContext<'_>, client: &CoinsetClient, params: &FaucetParams) -> Result<FaucetReply> {
    use chia_protocol::{CoinSpend, Program, SpendBundle};
    use clvmr::serde::node_to_bytes;

    let sk = ctx
        .wallet
        .as_ref()
        .ok_or_else(|| anyhow!("no wallet loaded: start the node with SSF_CHIA_LANE=1 to take a mojo"))?;
    // One TAKE at a time, serialized with every other wallet writer: the
    // courtesy check, the coin pick and the push are one critical section, and
    // a gift still landing (its faucet coin parked until the chain or the
    // mempool settles the claim) counts as a coin in the wallet. Without this,
    // two loopback requests could both see an empty wallet before either gift
    // confirms and each draw a mojo from a different ready coin (#245 review,
    // round 3). The lease is held across the gateway reads, as the heartbeat
    // holds it across its own.
    let _lease = crate::chia_publish::WALLET_LEASE.lock().await;
    crate::chia_publish::WALLET_LEASE.reconcile(client).await;
    if crate::chia_publish::WALLET_LEASE.incoming_pending() {
        return Err(anyhow!(
            "your mojo from the dish is still on its way (about a minute); the wallet shows it when the block lands"
        ));
    }
    // Owned, not spendable: a coin parked by a spend in flight is still ours.
    if !wallet_view(client, sk).await?.owned.is_empty() {
        return Err(anyhow!("your wallet already holds a coin; the dish is for players with an empty wallet"));
    }
    let peak = crate::chia_resolve::peak_height(client)
        .await
        .ok_or_else(|| anyhow!("chain peak unavailable (gateway down?)"))?;
    let faucet_ph = params.puzzle_hash();
    let coins = unspent_at(client, faucet_ph).await?.coins;
    let Some(target) = coins
        .iter()
        .filter(|c| c.ready(params, peak))
        .filter(|c| !crate::chia_publish::WALLET_LEASE.is_pending(&c.coin.coin_id()))
        .max_by_key(|c| (c.coin.amount, std::cmp::Reverse(c.confirmed_height)))
    else {
        return Err(anyhow!("no mojo in the dish right now; it refills on the block clock"));
    };
    let recipient = crate::chia_publish::our_puzzle_hash(sk);

    let mut a = Allocator::new();
    let puzzle = params.puzzle_reveal(&mut a)?;
    let solution = claim_solution(&mut a, faucet_ph, target.coin.amount, recipient, 0)?;
    // Dry-run locally first: a solution the puzzle rejects never reaches the mempool.
    chia_sdk_types::run_puzzle(&mut a, puzzle, solution)
        .map_err(|e| anyhow!("faucet puzzle rejected our claim locally: {e:?}"))?;
    let coin_spend = CoinSpend::new(
        target.coin,
        Program::from(node_to_bytes(&a, puzzle).map_err(|e| anyhow!("serialize reveal: {e:?}"))?),
        Program::from(node_to_bytes(&a, solution).map_err(|e| anyhow!("serialize solution: {e:?}"))?),
    );
    // Keyless: no AGG_SIG condition anywhere, so the aggregate is the identity.
    let bundle = SpendBundle::new(vec![coin_spend], chia_bls::Signature::default());
    // Not our coin, but a second TAKE before this one confirms must not pick it,
    // and while it stays parked (until the chain or the mempool settles the
    // claim) our wallet counts as holding the gift. Both marks go on BEFORE the
    // push (round 9): a push that times out may still have landed, and a wallet
    // reading empty with no gift landing would let a second TAKE through.
    // push_parked parks the coin first and hands it back only on an outright
    // rejection — then the gift is not landing either (incoming_pending reads
    // the parking).
    crate::chia_publish::WALLET_LEASE.mark_incoming(target.coin.coin_id());
    crate::chia_publish::push_parked(client, bundle, [target.coin.coin_id()]).await?;
    println!(
        "⛓️🥣 faucet: claimed {} mojo(s) from coin {} at {} (height {peak})",
        params.gift,
        hex::encode(target.coin.coin_id()),
        params.address()
    );
    Ok(FaucetReply {
        op: "claim".into(),
        ok: true,
        error: None,
        status: None,
        spent_coin: Some(hex::encode(target.coin.coin_id())),
    })
}

#[cfg(not(feature = "chia-publish"))]
async fn claim(_ctx: &FaucetContext<'_>, _client: &CoinsetClient, _params: &FaucetParams) -> Result<FaucetReply> {
    Err(anyhow!("this node was built without publishing; it cannot take a mojo"))
}

/// GIVE: pay `amount` mojos from our wallet into the faucet address, from as
/// many of our coins (largest first) as it takes, under the wallet spend lease.
#[cfg(feature = "chia-publish")]
async fn give(
    ctx: &FaucetContext<'_>,
    client: &CoinsetClient,
    params: &FaucetParams,
    amount: u64,
) -> Result<FaucetReply> {
    use chia_puzzle_types::{DeriveSynthetic, Memos};
    use chia_sdk_driver::{SpendContext, StandardLayer};
    use chia_sdk_types::Conditions;

    let sk = ctx
        .wallet
        .as_ref()
        .ok_or_else(|| anyhow!("no wallet loaded: start the node with SSF_CHIA_LANE=1 to give"))?;
    if amount < params.gift {
        return Err(anyhow!("a gift below {} mojo(s) could never leave the jar", params.gift));
    }
    // Select, build and push under the lease: the heartbeat (or a second GIVE)
    // must not pick the same coins before this spend confirms.
    let _lease = crate::chia_publish::WALLET_LEASE.lock().await;
    crate::chia_publish::WALLET_LEASE.reconcile(client).await;
    let wallet = wallet_view(client, sk).await?;
    if wallet.owned.is_empty() {
        return Err(anyhow!("your wallet is empty; fund it first (the dish takes, it does not lend)"));
    }
    if wallet.spendable.is_empty() {
        return Err(anyhow!("a spend from your wallet is still confirming (about a minute); give again after it lands"));
    }
    let total = wallet.spendable_mojos();
    let Some((coins, change)) = pick_give_coins(wallet.spendable, amount) else {
        return Err(anyhow!("your wallet can spend {total} mojos right now; give at most that in one go"));
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
    let bundle = crate::chia_publish::sign_standard_spends(sk, ctx_spend.take())?;
    // Coins parked before the push leaves (round 9): see push_parked.
    crate::chia_publish::push_parked(client, bundle, coins.iter().map(|c| c.coin_id())).await?;
    println!(
        "⛓️🥣 faucet: gave {amount} mojo(s) into {} from {} coin(s), change {change}",
        params.address(),
        coins.len()
    );
    Ok(FaucetReply {
        op: "give".into(),
        ok: true,
        error: None,
        status: None,
        spent_coin: Some(hex::encode(coins[0].coin_id())),
    })
}

#[cfg(not(feature = "chia-publish"))]
async fn give(
    _ctx: &FaucetContext<'_>,
    _client: &CoinsetClient,
    _params: &FaucetParams,
    _amount: u64,
) -> Result<FaucetReply> {
    Err(anyhow!("this node was built without publishing; it cannot give"))
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

    /// The lobby's v1 parameters on a fixed room tag.
    fn test_params() -> FaucetParams {
        FaucetParams { room_tag: Bytes32::new([7u8; 32]), gift: GIFT_MOJOS, gap: GAP_BLOCKS, max_fee: MAX_FEE_MOJOS }
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
        assert_eq!(params.address(), "txch1llf6yk767gv5wmsh6zx2cme7yg7ksh5aq5n7y57smfxhn4zvwfyscfgx6a");
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
        let st = summarize(&params, 140, &coins, false);
        assert_eq!((st.coins, st.ready, st.total_mojos), (2, 1, 1005));
        assert_eq!(st.next_ready_in_blocks, Some(22));
        assert_eq!(st.address, params.address());
        assert!(!st.can_claim && !st.can_give && st.wallet_mojos.is_none() && !st.partial);
        assert!(st.wallet_spendable_mojos.is_none());
        // Everyone ready: no "next".
        let st = summarize(&params, 200, &coins, true);
        assert_eq!((st.ready, st.next_ready_in_blocks, st.partial), (2, None, true));
        // Empty jar.
        let st = summarize(&params, 200, &[], false);
        assert_eq!((st.coins, st.ready, st.total_mojos), (0, 0, 0));
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"nextReadyInBlocks\":null") && json.contains("\"canClaim\":false"));
        assert!(json.contains("\"partial\":false") && json.contains("\"walletPartial\":false"));
        // Numbered only by `status` itself, as the snapshot completes.
        assert!(json.contains("\"snapshot\":0"), "{json}");
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
        let mut st = summarize(&params, 100, &[coin(1, u64::MAX), coin(2, u64::MAX)], false);
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
    }

    #[test]
    fn handle_request_without_a_room_key_fails_closed() {
        let rooms = Mutex::new(HashMap::new());
        let ctx = FaucetContext {
            rooms: &rooms,
            #[cfg(feature = "chia-publish")]
            wallet: None,
        };
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let reply = rt.block_on(handle_request(&ctx, "home-abc", br#"{"op":"status"}"#));
        assert!(!reply.ok && reply.error.as_deref().unwrap_or("").contains("no key for this room"));
        let reply = rt.block_on(handle_request(&ctx, "home-abc", b"not json"));
        assert!(!reply.ok && reply.op == "?");
    }

    #[cfg(feature = "chia-publish")]
    #[test]
    fn address_matches_the_sdk_encoder_and_a_claim_bundle_is_keyless() {
        use chia_protocol::{CoinSpend, Program, SpendBundle};
        use chia_sdk_utils::Address;
        use clvmr::serde::node_to_bytes;

        let params = FaucetParams::for_room(&[3u8; 32]);
        let ph = params.puzzle_hash();
        assert_eq!(params.address(), Address::new(ph, "txch".to_string()).encode().unwrap());

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
}
