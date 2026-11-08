//! The mock chain (stage 4 design §12, "Mock chain"; §13 row 8): one
//! in-memory coin set served by two or more mock full nodes over the real
//! light-wallet protocol, so the real lane, the real wallet lease and the
//! real readers run against a chain that keeps ephemeral coin records, has a
//! mempool that can be made full, reorganises on demand, and answers both of
//! an agreed lane's peers. Test-only: nothing here is compiled into the node.
//!
//! What a real full node does and the model copies, from chia-blockchain
//! 2.7.4 (`full_node_api.py`, `full_node.py`, `mempool_manager.py`,
//! `coin_store.py`, `hint_store.py`, `hint_management.py`,
//! `util/errors.py`), each pinned by a test in [`tests`]:
//!   - a coin set with created and spent heights per coin and the puzzle and
//!     solution of every spend, ephemeral coins (created and spent in one
//!     block) included;
//!   - a hint table PER NODE, as each full node has its own hint store: a
//!     (coin id, hint) row for each coin a block the node took created with
//!     a hint (the first memo of its `CREATE_COIN`, kept when it is 1 to 32
//!     bytes), added once and never removed, so it outlives a rewind and a
//!     reorganisation as a full node's does. A coin's id does not depend on
//!     its memo, so a coin a new fork makes again with another memo is
//!     listed under both hints; hinted coins are found through the coin
//!     records the node's chain holds, so a row whose coin is gone lists
//!     nothing;
//!   - `RequestPuzzleState` as `request_puzzle_state` answers it: anchored at
//!     the header the request names, ordered by the height a coin last
//!     changed, cut at the response-item limit without splitting a block,
//!     the cut page dated one block before the first block it leaves out;
//!   - a mempool PER NODE, as each full node has its own: its seen cache, its
//!     pending cache for height-locked spends and its conflict cache, and the
//!     order in which `add_transaction` and `validate_spend_bundle` judge a
//!     bundle and the `TransactionAck` each verdict gives;
//!   - a node too busy to validate a bundle in time
//!     ([`MockChain::set_busy`]): `pre_validate_spendbundle` raises a
//!     `ValueError` when the CLVM run and the signature check took longer
//!     than the node's `validation_timeout` (2 s by default), or longer than
//!     0.1 s at more than 5 × `validation_timeout` ns per unit of execution
//!     and condition cost (10 ns by default), which for a bundle under 10
//!     million cost (a standard spend is some 3 million) is any run over
//!     0.1 s; `add_transaction` answers either FAILED INVALID_SPEND_BUNDLE
//!     as a soft failure, the bundle left out
//!     of the seen cache and the mempool as it was. The refusal comes where
//!     that check does: after the mempool (SUCCESS) and the seen cache
//!     (ALREADY_INCLUDING_TRANSACTION) are looked in, and after the CLVM
//!     run and the signature check passed, since a bundle they refuse is
//!     refused by its own name however long they took;
//!   - each new block on the fast path of `new_peak` (the items it spent
//!     leave the mempool and the seen cache, then the caches are tried
//!     again), and a reorganisation on the slow path (a new mempool, the seen
//!     cache emptied, the old items tried again on the new chain);
//!   - `TransactionAck.error` as the full node spells it, `Err(code).name`,
//!     looked up by the code chia_rs gives ([`err_name`]).
//!
//! Left out, on purpose, since no test here needs it: the `ASSERT_BEFORE_*`
//! expiry of mempool items at a new peak, the `IMPOSSIBLE_*` constraint
//! checks, replacement by fee (a conflicting bundle always waits in the
//! conflict cache), the canonical-encoding check, fast-forward singleton
//! spends, `INVALID_FEE_LOW_FEE` (a full mempool here refuses only what is
//! under the nonzero minimum, which every fee-0 bundle is) and block cost
//! limits (a block carries every bundle that fits the chain). Blocks are all
//! transaction blocks, one every [`BLOCK_SECS`]. Also left out:
//!   - relay between nodes: a bundle is in the mempool of the nodes it was
//!     sent to and no other, and a block takes from the mempools of the
//!     nodes not held, so what only a held node took reaches no block (a
//!     real node passes what it takes on to its peers, and a farmer anywhere
//!     may include it);
//!   - subscriptions: `RequestCoinState.subscribe` and
//!     `subscribe_when_finished` are ignored, and no `CoinStateUpdate` is
//!     ever sent;
//!   - per-message rate limits;
//!   - a node that is syncing (`NO_TRANSACTIONS_WHILE_SYNCING`): every node
//!     is synced to the chain it serves.
//!
//! Every reorganisation reaches every node not held at once, behind the
//! barrier ([`MockChain::farm_blocks`]); real nodes take a fork seconds
//! apart, which a test stages with [`MockChain::hold`] and
//! [`MockChain::release`]. A change staged to come just as a node is to
//! answer a request of a kind (a reorganisation, [`MockChain::reorg_before`];
//! one block, [`MockChain::block_before`]; or a return to a chain saved
//! earlier, its blocks with the same hashes, and more,
//! [`MockChain::return_before`]) has no barrier: each connection hears of the
//! new peak when its announcement arrives, a moment after the answer, as a
//! real node's peers hear of one. Several can be staged, to come one after
//! the other. A node can also follow the chain while its announcements lag
//! ([`MockChain::quiet`]), as a full node's announcement to wallets follows
//! its post-processing of a block, or take a block before each header it
//! serves ([`MockChain::restless`]), or each request of another kind
//! ([`MockChain::restless_before`]).
//!
//! A node can also be made to say what its chain does not, which no node
//! here does on its own: leave a coin out of its listings
//! ([`MockChain::hide_on`]), list coins its chain never made
//! ([`MockChain::invent_on`]), deny one by id ([`MockChain::deny_on`]), serve
//! another spend than the chain's ([`MockChain::serve_spend_on`]), refuse
//! every lookup by id ([`MockChain::refuse_lookups_on`]) or echo none of the
//! ids a lookup asks ([`MockChain::echo_no_lookup_ids_on`]).
//! These stand for a lying peer, or one whose stores are short, beside an
//! honest one: what the lane's settling of the coins two peers' hinted
//! listings differ on is to tell apart from a stale hint row.

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Duration;

use chia_consensus::check_time_locks::check_time_locks;
use chia_consensus::flags::MEMPOOL_MODE;
use chia_consensus::owned_conditions::OwnedSpendBundleConditions;
use chia_consensus::spendbundle_conditions::run_spendbundle;
use chia_consensus::spendbundle_validation::{get_flags_for_height_and_constants, validate_clvm_and_signature};
use chia_consensus::validation_error::{ErrorCode, ValidationErr};
use chia_protocol::{
    Bytes, Bytes32, Coin, CoinRecord, CoinSpend, CoinState, Handshake, HeaderBlock, Message, NewPeakWallet, NodeType, Program,
    ProtocolMessageTypes, PuzzleSolutionResponse, RejectCoinState, RejectHeaderRequest, RejectPuzzleSolution, RejectPuzzleState,
    RejectStateReason, RequestBlockHeader, RequestChildren, RequestCoinState, RequestPuzzleSolution, RequestPuzzleState,
    RespondBlockHeader, RespondChildren, RespondCoinState, RespondPeers, RespondPuzzleSolution, RespondPuzzleState, SendTransaction,
    SpendBundle, TransactionAck,
};
use chia_traits::Streamable;
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::{acceptor, header_on, reply, MockNode};
use crate::chia_network::ChiaNet;
use crate::chia_peer::{tls_client_config, Network, Source, PROTOCOL_VERSION};
use crate::chia_peer_lane::Lane;

#[cfg(test)]
mod tests;

/// Block 1's timestamp, and the spacing of the rest: one block every 19
/// seconds, near the 18.75 seconds Chia targets. `check_time_locks` reads it.
const BASE_TIMESTAMP: u64 = 1_700_000_000;
const BLOCK_SECS: u64 = 19;
/// A full node's `seen_cache_size`: the bundle names it remembers having
/// judged, oldest forgotten first.
const SEEN_CACHE: usize = 10_000;
/// A full node's `nonzero_fee_minimum_fpc`: under a full mempool, the least
/// fee per unit of cost it takes. A fee-0 bundle is always under it.
const NONZERO_FEE_MINIMUM_FPC: u128 = 5;
/// The most coin states one answer carries: a full node's default
/// `max_subscribe_response_items` for a wallet peer.
const PAGE_LIMIT: usize = 100_000;
/// How long a new block waits for every connection to show it filed the
/// announcement ([`MockChain::farm_blocks`]); only a broken test waits it out
/// (one holding a connection accepted and idle short of its handshake, say).
const BARRIER: Duration = Duration::from_secs(5);

/// `MempoolInclusionStatus`, as `TransactionAck.status` carries it.
pub(crate) const SUCCESS: u8 = 1;
pub(crate) const PENDING: u8 = 2;
pub(crate) const FAILED: u8 = 3;

/// chia-blockchain's `Err` names by code (`util/errors.py`, 2.7.4): what a
/// full node writes in `TransactionAck.error` (`error.name`), and what
/// `chia_peer_lane::refusal_is_final` reads.
const ERR_NAMES: &[(u32, &str)] = &[
    (1, "UNKNOWN"), (2, "INVALID_BLOCK_SOLUTION"), (3, "INVALID_COIN_SOLUTION"), (4, "DUPLICATE_OUTPUT"), (5, "DOUBLE_SPEND"),
    (6, "UNKNOWN_UNSPENT"), (7, "BAD_AGGREGATE_SIGNATURE"), (8, "WRONG_PUZZLE_HASH"), (9, "BAD_FARMER_COIN_AMOUNT"),
    (10, "INVALID_CONDITION"), (11, "ASSERT_MY_COIN_ID_FAILED"), (12, "ASSERT_ANNOUNCE_CONSUMED_FAILED"),
    (13, "ASSERT_HEIGHT_RELATIVE_FAILED"), (14, "ASSERT_HEIGHT_ABSOLUTE_FAILED"), (15, "ASSERT_SECONDS_ABSOLUTE_FAILED"),
    (16, "COIN_AMOUNT_EXCEEDS_MAXIMUM"), (17, "SEXP_ERROR"), (18, "INVALID_FEE_LOW_FEE"), (19, "MEMPOOL_CONFLICT"), (20, "MINTING_COIN"),
    (21, "EXTENDS_UNKNOWN_BLOCK"), (22, "COINBASE_NOT_YET_SPENDABLE"), (23, "BLOCK_COST_EXCEEDS_MAX"), (24, "BAD_ADDITION_ROOT"),
    (25, "BAD_REMOVAL_ROOT"), (26, "INVALID_POSPACE_HASH"), (27, "INVALID_COINBASE_SIGNATURE"), (28, "INVALID_PLOT_SIGNATURE"),
    (29, "TIMESTAMP_TOO_FAR_IN_PAST"), (30, "TIMESTAMP_TOO_FAR_IN_FUTURE"), (31, "INVALID_TRANSACTIONS_FILTER_HASH"),
    (32, "INVALID_POSPACE_CHALLENGE"), (33, "INVALID_POSPACE"), (34, "INVALID_HEIGHT"), (35, "INVALID_COINBASE_AMOUNT"),
    (36, "INVALID_MERKLE_ROOT"), (37, "INVALID_BLOCK_FEE_AMOUNT"), (38, "INVALID_WEIGHT"), (39, "INVALID_TOTAL_ITERS"),
    (40, "BLOCK_IS_NOT_FINISHED"), (41, "INVALID_NUM_ITERATIONS"), (42, "INVALID_POT"), (43, "INVALID_POT_CHALLENGE"),
    (44, "INVALID_TRANSACTIONS_GENERATOR_HASH"), (45, "INVALID_POOL_TARGET"), (46, "INVALID_COINBASE_PARENT"),
    (47, "INVALID_FEES_COIN_PARENT"), (48, "RESERVE_FEE_CONDITION_FAILED"), (49, "NOT_BLOCK_BUT_HAS_DATA"),
    (50, "IS_TRANSACTION_BLOCK_BUT_NO_DATA"), (51, "INVALID_PREV_BLOCK_HASH"), (52, "INVALID_TRANSACTIONS_INFO_HASH"),
    (53, "INVALID_FOLIAGE_BLOCK_HASH"), (54, "INVALID_REWARD_COINS"), (55, "INVALID_BLOCK_COST"), (56, "NO_END_OF_SLOT_INFO"),
    (57, "INVALID_PREV_CHALLENGE_SLOT_HASH"), (58, "INVALID_SUB_EPOCH_SUMMARY_HASH"), (59, "NO_SUB_EPOCH_SUMMARY_HASH"),
    (60, "SHOULD_NOT_MAKE_CHALLENGE_BLOCK"), (61, "SHOULD_MAKE_CHALLENGE_BLOCK"), (62, "INVALID_CHALLENGE_CHAIN_DATA"),
    (65, "INVALID_CC_EOS_VDF"), (66, "INVALID_RC_EOS_VDF"), (67, "INVALID_CHALLENGE_SLOT_HASH_RC"), (68, "INVALID_PRIOR_POINT_RC"),
    (69, "INVALID_DEFICIT"), (70, "INVALID_SUB_EPOCH_SUMMARY"), (71, "INVALID_PREV_SUB_EPOCH_SUMMARY_HASH"),
    (72, "INVALID_REWARD_CHAIN_HASH"), (73, "INVALID_SUB_EPOCH_OVERFLOW"), (74, "INVALID_NEW_DIFFICULTY"),
    (75, "INVALID_NEW_SUB_SLOT_ITERS"), (76, "INVALID_CC_SP_VDF"), (77, "INVALID_RC_SP_VDF"), (78, "INVALID_CC_SIGNATURE"),
    (79, "INVALID_RC_SIGNATURE"), (80, "CANNOT_MAKE_CC_BLOCK"), (81, "INVALID_RC_SP_PREV_IP"), (82, "INVALID_RC_IP_PREV_IP"),
    (83, "INVALID_IS_TRANSACTION_BLOCK"), (84, "INVALID_URSB_HASH"), (85, "OLD_POOL_TARGET"), (86, "INVALID_POOL_SIGNATURE"),
    (87, "INVALID_FOLIAGE_BLOCK_PRESENCE"), (88, "INVALID_CC_IP_VDF"), (89, "INVALID_RC_IP_VDF"), (90, "IP_SHOULD_BE_NONE"),
    (91, "INVALID_REWARD_BLOCK_HASH"), (92, "INVALID_MADE_NON_OVERFLOW_INFUSIONS"), (93, "NO_OVERFLOWS_IN_FIRST_SUB_SLOT_NEW_EPOCH"),
    (94, "MEMPOOL_NOT_INITIALIZED"), (95, "SHOULD_NOT_HAVE_ICC"), (96, "SHOULD_HAVE_ICC"), (97, "INVALID_ICC_VDF"),
    (98, "INVALID_ICC_HASH_CC"), (99, "INVALID_ICC_HASH_RC"), (100, "INVALID_ICC_EOS_VDF"), (101, "INVALID_SP_INDEX"),
    (102, "TOO_MANY_BLOCKS"), (103, "INVALID_CC_CHALLENGE"), (104, "INVALID_PREFARM"), (105, "ASSERT_SECONDS_RELATIVE_FAILED"),
    (106, "BAD_COINBASE_SIGNATURE"), (108, "NO_TRANSACTIONS_WHILE_SYNCING"), (109, "ALREADY_INCLUDING_TRANSACTION"),
    (110, "INCOMPATIBLE_NETWORK_ID"), (111, "PRE_SOFT_FORK_MAX_GENERATOR_SIZE"), (112, "INVALID_REQUIRED_ITERS"),
    (113, "TOO_MANY_GENERATOR_REFS"), (114, "ASSERT_MY_PARENT_ID_FAILED"), (115, "ASSERT_MY_PUZZLEHASH_FAILED"),
    (116, "ASSERT_MY_AMOUNT_FAILED"), (117, "GENERATOR_RUNTIME_ERROR"), (118, "INVALID_COST_RESULT"),
    (119, "INVALID_TRANSACTIONS_GENERATOR_REFS_ROOT"), (120, "FUTURE_GENERATOR_REFS"), (121, "GENERATOR_REF_HAS_NO_GENERATOR"),
    (122, "DOUBLE_SPEND_IN_FORK"), (123, "INVALID_FEE_TOO_CLOSE_TO_ZERO"), (124, "COIN_AMOUNT_NEGATIVE"), (125, "INTERNAL_PROTOCOL_ERROR"),
    (126, "INVALID_SPEND_BUNDLE"), (127, "FAILED_GETTING_GENERATOR_MULTIPROCESSING"), (128, "ASSERT_BEFORE_SECONDS_ABSOLUTE_FAILED"),
    (129, "ASSERT_BEFORE_SECONDS_RELATIVE_FAILED"), (130, "ASSERT_BEFORE_HEIGHT_ABSOLUTE_FAILED"),
    (131, "ASSERT_BEFORE_HEIGHT_RELATIVE_FAILED"), (132, "ASSERT_CONCURRENT_SPEND_FAILED"), (133, "ASSERT_CONCURRENT_PUZZLE_FAILED"),
    (134, "IMPOSSIBLE_SECONDS_RELATIVE_CONSTRAINTS"), (135, "IMPOSSIBLE_SECONDS_ABSOLUTE_CONSTRAINTS"),
    (136, "IMPOSSIBLE_HEIGHT_RELATIVE_CONSTRAINTS"), (137, "IMPOSSIBLE_HEIGHT_ABSOLUTE_CONSTRAINTS"),
    (138, "ASSERT_MY_BIRTH_SECONDS_FAILED"), (139, "ASSERT_MY_BIRTH_HEIGHT_FAILED"), (140, "ASSERT_EPHEMERAL_FAILED"),
    (141, "EPHEMERAL_RELATIVE_CONDITION"), (142, "INVALID_SOFTFORK_CONDITION"), (143, "INVALID_SOFTFORK_COST"),
    (144, "TOO_MANY_ANNOUNCEMENTS"), (145, "INVALID_MESSAGE_MODE"), (146, "INVALID_COIN_ID"), (147, "MESSAGE_NOT_SENT_OR_RECEIVED"),
    (148, "INVALID_TRANSACTIONS_GENERATOR_ENCODING"), (149, "TOO_MANY_SPENDS"), (150, "INVALID_HEADER_MMR_ROOT"),
    (151, "INVALID_BLOCK_VERSION"),
];

/// The name a full node gives `code`. chia_rs folds several of its codes
/// into one of Chia's (every malformed condition is INVALID_CONDITION, both
/// announcement assertions are ASSERT_ANNOUNCE_CONSUMED_FAILED, running out
/// of cost is BLOCK_COST_EXCEEDS_MAX), so the name is found by the number
/// chia_rs converts the code to, never spelled from the Rust variant.
pub(crate) fn err_name(code: ErrorCode) -> String {
    let number = u32::from(code);
    ERR_NAMES
        .iter()
        .find(|(n, _)| *n == number)
        .map(|(_, name)| name.to_string())
        .unwrap_or_else(|| format!("UNNAMED_ERROR_{number}"))
}

/// The certificates the first two nodes of any chain present, minted once
/// per test binary (minting is the slow part of bringing a node up). Each
/// node of one chain presents its own, so a lane counts two identities.
static CERTS: LazyLock<[Arc<chia_ssl::ChiaCertificate>; 2]> = LazyLock::new(|| {
    [Arc::new(chia_ssl::ChiaCertificate::generate().unwrap()), Arc::new(chia_ssl::ChiaCertificate::generate().unwrap())]
});

/// The client side's certificate and TLS setup, minted once per binary, as
/// `chia_peer_lane`'s tests share theirs.
static TLS: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| tls_client_config().unwrap());

fn zero() -> Bytes32 {
    Bytes32::new([0u8; 32])
}

fn sha256(parts: &[&[u8]]) -> Bytes32 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    Bytes32::new(hasher.finalize().into())
}

/// The hint row a coin made with `hint` gives its block, if any: a full node
/// stores a hint that is not empty (`get_hints_and_subscription_coin_ids`),
/// and chia_rs gives one only for a first memo of at most 32 bytes.
fn hint_row(rows: &mut Vec<(Bytes32, Bytes)>, coin: Coin, hint: Option<Bytes>) {
    if let Some(hint) = hint.filter(|hint| !hint.is_empty()) {
        rows.push((coin.coin_id(), hint));
    }
}

fn timestamp(height: u32) -> u64 {
    BASE_TIMESTAMP + BLOCK_SECS * u64::from(height)
}

/// What a node's connections are told of its peak, and the generation of
/// the telling, which a connection's pong carries back ([`serve`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Announcement {
    generation: u64,
    height: u32,
    header_hash: Bytes32,
    /// The height below which the announced chain and the one announced
    /// before it are the same.
    fork_point: u32,
}

impl Announcement {
    /// The `NewPeakWallet` a full node sends: its weight grows with the
    /// height, so a reorganisation, which here always raises the peak, never
    /// lowers it.
    fn message(&self, fork_point: u32) -> Message {
        reply(&NewPeakWallet::new(self.header_hash, self.height, u128::from(self.height) + 1, fork_point))
    }

    /// What a connection is sent of it: the `NewPeakWallet`, then a
    /// websocket ping carrying the generation, whose pong shows the client
    /// filed the peak ([`serve`]). The handshake's greeting and every later
    /// announcement are sent alike.
    fn frames(&self, fork_point: u32) -> [WsMessage; 2] {
        [binary(&self.message(fork_point)), WsMessage::Ping(self.generation.to_be_bytes().to_vec())]
    }
}

#[derive(Clone)]
struct Block {
    header_hash: Bytes32,
    /// The salt of the fork the block was built on ([`header_on`]).
    salt: Bytes32,
    /// The coins the block spent, for the mempool's fast path.
    spent: Vec<Bytes32>,
    /// The (coin id, hint) rows of the coins it created, which each node
    /// that takes the block adds to its hint table, as
    /// `peak_post_processing` (and `ingest_batch` while syncing) hands
    /// `get_hints_and_subscription_coin_ids`'s rows to `add_hints`.
    hints: Vec<(Bytes32, Bytes)>,
}

#[derive(Clone)]
struct CoinRec {
    coin: Coin,
    created: u32,
    spent: Option<u32>,
    /// The puzzle reveal and solution of the spend, once spent.
    spend: Option<(Program, Program)>,
}

impl CoinRec {
    /// The height the coin last changed at, which listings are ordered and
    /// cut by.
    fn changed(&self) -> u32 {
        self.created.max(self.spent.unwrap_or(0))
    }

    fn state(&self) -> CoinState {
        CoinState::new(self.coin, self.spent, Some(self.created))
    }
}

/// One chain: its blocks and every coin it ever created, ephemeral ones
/// included. A node held back keeps a copy of its own ([`MockChain::hold`]).
#[derive(Clone)]
struct Chain {
    genesis: Bytes32,
    blocks: Vec<Block>,
    coins: HashMap<Bytes32, CoinRec>,
}

impl Chain {
    fn new(genesis: Bytes32) -> Self {
        // Block 0 is the one every mock node serves: on the genesis
        // challenge, unsalted, so the lane's network binding passes.
        let first = Block { header_hash: header_on(0, genesis, zero()).header_hash(), salt: zero(), spent: vec![], hints: vec![] };
        Self { genesis, blocks: vec![first], coins: HashMap::new() }
    }

    fn peak(&self) -> u32 {
        (self.blocks.len() - 1) as u32
    }

    fn hash(&self, height: u32) -> Option<Bytes32> {
        self.blocks.get(height as usize).map(|b| b.header_hash)
    }

    fn header(&self, height: u32) -> Option<HeaderBlock> {
        let block = self.blocks.get(height as usize)?;
        let prev = if height == 0 { self.genesis } else { self.blocks[height as usize - 1].header_hash };
        Some(header_on(height, prev, block.salt))
    }

    /// Whether a request's anchor is on this chain: no height and the
    /// genesis challenge, or a height and the header there.
    fn anchored(&self, previous: Option<u32>, header_hash: Bytes32) -> bool {
        match previous {
            None => header_hash == self.genesis,
            Some(height) => self.hash(height) == Some(header_hash),
        }
    }

    fn push(&mut self, salt: Bytes32, spent: Vec<Bytes32>, hints: Vec<(Bytes32, Bytes)>) -> u32 {
        let height = self.blocks.len() as u32;
        let prev = self.blocks[height as usize - 1].header_hash;
        self.blocks.push(Block { header_hash: header_on(height, prev, salt).header_hash(), salt, spent, hints });
        height
    }

    /// The hint rows of the blocks above `height`: what a node that takes
    /// them adds to its hint table.
    fn hints_above(&self, height: u32) -> impl Iterator<Item = (Bytes32, Bytes)> + '_ {
        self.blocks[height as usize + 1..].iter().flat_map(|block| block.hints.iter().cloned())
    }

    /// Undo every block above `to`: the coins they created are gone and the
    /// spends they made are undone, as `rollback_to_block` does. No node's
    /// hint table is touched: a full node rolls back its coin and block
    /// stores and never its hint store.
    fn rewind(&mut self, to: u32) {
        self.blocks.truncate(to as usize + 1);
        self.coins.retain(|_, rec| rec.created <= to);
        for rec in self.coins.values_mut() {
            if rec.spent.is_some_and(|spent| spent > to) {
                rec.spent = None;
                rec.spend = None;
            }
        }
    }

    /// A coin's record as the mempool and the time locks read it, its
    /// timestamp its block's.
    fn record(&self, id: &Bytes32) -> Option<CoinRecord> {
        self.coins.get(id).map(|rec| CoinRecord::new(rec.coin, rec.created, rec.spent.unwrap_or(0), false, timestamp(rec.created)))
    }

    /// The highest height at which `self` and `other` hold the same block.
    fn common(&self, other: &Chain) -> u32 {
        let mut height = self.peak().min(other.peak());
        while self.hash(height) != other.hash(height) {
            height -= 1;
        }
        height
    }
}

/// A bundle a node took, or put aside, with what pre-validation found.
#[derive(Clone)]
struct Item {
    bundle: SpendBundle,
    name: Bytes32,
    conds: OwnedSpendBundleConditions,
    /// When it first reached any node: the order blocks take bundles in.
    arrival: u64,
    /// The height from which its height locks pass (`compute_assert_height`).
    assert_height: u32,
}

impl Item {
    fn removals(&self) -> impl Iterator<Item = Bytes32> + '_ {
        self.conds.spends.iter().map(|spend| spend.coin_id)
    }
}

/// One node's mempool, its caches and its seen cache.
#[derive(Default)]
struct Pool {
    items: Vec<Item>,
    /// Height-locked bundles, tried again once their height comes.
    pending: Vec<Item>,
    /// Bundles spending a coin a mempool item spends, tried again at the
    /// next block.
    conflicts: Vec<Item>,
    seen: VecDeque<Bytes32>,
    /// The §12 switch: the mempool is at capacity, and takes nothing under
    /// the nonzero fee minimum, save its own items tried again at a
    /// reorganisation ([`new_peak_slow`]).
    full: bool,
}

impl Pool {
    fn holds(&self, name: &Bytes32) -> bool {
        self.items.iter().any(|item| item.name == *name)
    }

    fn spends(&self, coin: &Bytes32) -> bool {
        self.items.iter().any(|item| item.removals().any(|r| r == *coin))
    }

    fn seen(&self, name: &Bytes32) -> bool {
        self.seen.contains(name)
    }

    fn add_seen(&mut self, name: Bytes32) {
        if !self.seen.contains(&name) {
            self.seen.push_back(name);
            while self.seen.len() > SEEN_CACHE {
                self.seen.pop_front();
            }
        }
    }

    fn remove_seen(&mut self, name: &Bytes32) {
        self.seen.retain(|seen| seen != name);
    }

    /// Put a bundle aside in `pending` or `conflicts`, once by name.
    fn set_aside(cache: &mut Vec<Item>, item: Item) {
        if !cache.iter().any(|held| held.name == item.name) {
            cache.push(item);
        }
    }
}

/// How `validate_spend_bundle` judged a bundle.
enum Judged {
    Taken(Item),
    /// A height lock not yet passed: kept in the pending cache.
    Pending(ErrorCode, Item),
    /// A coin a mempool item already spends: kept in the conflict cache.
    Conflict(Item),
    Failed(ErrorCode),
}

/// `pre_validate_spendbundle`: the CLVM run, the puzzle hashes, the
/// conditions and the aggregate signature, with a transaction's cost cap
/// (half a block's) and the flags of the node's peak in mempool mode.
fn pre_validate(net: ChiaNet, peak: u32, bundle: &SpendBundle) -> Result<OwnedSpendBundleConditions, ErrorCode> {
    let constants = net.constants();
    let flags = get_flags_for_height_and_constants(peak, constants) | MEMPOOL_MODE;
    validate_clvm_and_signature(bundle, constants.max_block_cost_clvm / 2, constants, flags)
        .map(|(conds, _)| conds)
        .map_err(|ValidationErr(_, code)| code)
}

/// `compute_assert_height`: the height from which every height lock passes.
fn assert_height(records: &HashMap<Bytes32, CoinRecord>, conds: &OwnedSpendBundleConditions) -> u32 {
    let mut height = conds.height_absolute;
    for spend in &conds.spends {
        if let Some(relative) = spend.height_relative {
            height = height.max(records[&spend.coin_id].confirmed_block_index + relative);
        }
    }
    height
}

/// `validate_spend_bundle`, in its order, for a bundle pre-validation
/// passed, against `chain` and `pool` as one node sees them.
fn judge(net: ChiaNet, chain: &Chain, pool: &Pool, bundle: SpendBundle, conds: OwnedSpendBundleConditions, arrival: u64) -> Judged {
    let peak = chain.peak();
    let mut additions: HashMap<Bytes32, Coin> = HashMap::new();
    for spend in &conds.spends {
        for (puzzle_hash, amount, _) in &spend.create_coin {
            let coin = Coin::new(spend.coin_id, *puzzle_hash, *amount);
            additions.insert(coin.coin_id(), coin);
        }
    }
    let mut records: HashMap<Bytes32, CoinRecord> = HashMap::new();
    for spend in &conds.spends {
        let record = match additions.get(&spend.coin_id) {
            // A coin the bundle creates and spends is checked as if made in
            // the next block at the peak's timestamp: every spend of a bundle
            // happens at once.
            Some(coin) => CoinRecord::new(*coin, peak + 1, 0, false, timestamp(peak)),
            None => match chain.record(&spend.coin_id) {
                Some(record) => record,
                None => return Judged::Failed(ErrorCode::UnknownUnspent),
            },
        };
        records.insert(spend.coin_id, record);
    }
    let cost = conds.cost;
    if cost == 0 {
        return Judged::Failed(ErrorCode::Unknown);
    }
    if cost > net.constants().max_block_cost_clvm / 2 {
        return Judged::Failed(ErrorCode::CostExceeded);
    }
    let fees = conds.removal_amount.saturating_sub(conds.addition_amount);
    if pool.full && fees < NONZERO_FEE_MINIMUM_FPC * u128::from(cost) {
        return Judged::Failed(ErrorCode::InvalidFeeTooCloseToZero);
    }
    if records.values().any(|record| record.spent_block_index > 0) {
        return Judged::Failed(ErrorCode::DoubleSpend);
    }
    let conflict = conds.spends.iter().any(|spend| pool.spends(&spend.coin_id));
    if conds.spends.iter().any(|spend| spend.puzzle_hash != records[&spend.coin_id].coin.puzzle_hash) {
        return Judged::Failed(ErrorCode::WrongPuzzleHash);
    }
    let name = bundle.name();
    let locks = check_time_locks(&records, &conds, peak, timestamp(peak));
    let item = Item { assert_height: assert_height(&records, &conds), bundle, name, conds, arrival };
    match locks {
        Err(code @ (ErrorCode::AssertHeightAbsoluteFailed | ErrorCode::AssertHeightRelativeFailed)) => Judged::Pending(code, item),
        Err(code) => Judged::Failed(code),
        Ok(()) if conflict => Judged::Conflict(item),
        Ok(()) => Judged::Taken(item),
    }
}

/// Try a bundle again (`add_spend_bundle` from `new_peak`): taken into the
/// mempool, put aside again, or dropped. True when taken.
fn readmit(net: ChiaNet, chain: &Chain, pool: &mut Pool, item: Item) -> bool {
    match judge(net, chain, pool, item.bundle, item.conds, item.arrival) {
        Judged::Taken(item) => {
            pool.items.push(item);
            true
        }
        Judged::Pending(_, item) => {
            Pool::set_aside(&mut pool.pending, item);
            false
        }
        Judged::Conflict(item) => {
            Pool::set_aside(&mut pool.conflicts, item);
            false
        }
        Judged::Failed(_) => false,
    }
}

/// The end of `new_peak`: the pending bundles whose height has come and
/// every conflicting one, tried again.
fn retry_caches(net: ChiaNet, chain: &Chain, pool: &mut Pool) {
    let peak = chain.peak();
    let (due, waiting): (Vec<Item>, Vec<Item>) = std::mem::take(&mut pool.pending).into_iter().partition(|item| item.assert_height <= peak);
    pool.pending = waiting;
    let conflicts = std::mem::take(&mut pool.conflicts);
    for item in due.into_iter().chain(conflicts) {
        readmit(net, chain, pool, item);
    }
}

/// `new_peak` on its fast path, for blocks on top of the node's last peak:
/// every item spending a coin they spent leaves the mempool and the seen
/// cache, then the caches are tried again.
fn new_peak_fast(net: ChiaNet, chain: &Chain, pool: &mut Pool, spent: &HashSet<Bytes32>) {
    let gone: Vec<Bytes32> = pool.items.iter().filter(|item| item.removals().any(|r| spent.contains(&r))).map(|item| item.name).collect();
    pool.items.retain(|item| !gone.contains(&item.name));
    for name in &gone {
        pool.remove_seen(name);
    }
    retry_caches(net, chain, pool);
}

/// `new_peak` on its slow path, for a peak not on top of the last one: a new
/// mempool, the seen cache emptied, every old item tried again on the new
/// chain through `add_spend_bundle` (each one taken back into the seen cache;
/// one whose input the new chain lacks, UNKNOWN_UNSPENT, or has spent,
/// DOUBLE_SPEND, is dropped and forgotten; one now height-locked waits in
/// the pending cache), then the caches. The new mempool holds only old items,
/// which fitted the old one together, so none of them meets a full one (a
/// full node's `at_full_capacity` is false for each); the caches tried after
/// them do, as full as it was.
fn new_peak_slow(net: ChiaNet, chain: &Chain, pool: &mut Pool) {
    let old = std::mem::take(&mut pool.items);
    pool.seen.clear();
    let full = std::mem::replace(&mut pool.full, false);
    for item in old {
        let name = item.name;
        if readmit(net, chain, pool, item) {
            pool.add_seen(name);
        }
    }
    pool.full = full;
    retry_caches(net, chain, pool);
}

/// One mock full node: its address, what it last announced, its mempool,
/// its hint table, and the chain it is held at, if held. The requests it
/// read are its [`MockNode`]'s `seen`.
struct NodeState {
    addr: SocketAddr,
    announce: watch::Sender<Announcement>,
    pool: Pool,
    /// Its hint store (`hint_store.py`: `UNIQUE (coin_id, hint)`, rows added
    /// by `INSERT OR IGNORE` and never deleted): the rows of every block it
    /// took, kept through every rewind and reorganisation.
    hints: HashSet<(Bytes32, Bytes)>,
    held: Option<Chain>,
    /// Too busy to validate a bundle in time ([`MockChain::set_busy`]).
    busy: bool,
    /// Its announcements withheld while it follows the chain
    /// ([`MockChain::quiet`]), until it answers a request of the kind given
    /// and the time given has passed after that ([`MockChain::speak_after`]),
    /// if one is.
    quiet: Option<Option<(ProtocolMessageTypes, Duration)>>,
    /// The chain takes a block, announced, before it answers each request
    /// of this kind ([`MockChain::restless_before`]).
    restless: Option<ProtocolMessageTypes>,
    /// What it says against its chain (the module notes).
    lies: Lies,
}

/// What a node says against the chain it serves ([`MockChain::hide_on`],
/// [`MockChain::deny_on`], [`MockChain::serve_spend_on`]).
#[derive(Default)]
struct Lies {
    /// Coins its listings leave out, its hint rows and puzzle hashes
    /// notwithstanding.
    hidden: HashSet<Bytes32>,
    /// Coins its coin-state answers leave out, as a chain without them
    /// would; the ids are echoed all the same.
    denied: HashSet<Bytes32>,
    /// Spends it serves in place of the chain's, by the spent coin's id,
    /// whatever the height asked: a puzzle and solution, or `None` to
    /// refuse the request as for a coin not spent there.
    spends: HashMap<Bytes32, Option<(Program, Program)>>,
    /// Every `RequestCoinState` refused ([`MockChain::refuse_lookups_on`]).
    refuse_lookups: bool,
    /// Coins its chain never made, by id, which its listings give under the
    /// hint named and its lookups give by id ([`MockChain::invent_on`]).
    invented: HashMap<Bytes32, (Bytes32, CoinRec)>,
    /// Every `RespondCoinState` echoes none of the ids asked, and carries no
    /// state ([`MockChain::echo_no_lookup_ids_on`]).
    echo_none: bool,
}

/// One `TransactionAck` a node sent.
#[derive(Clone, Debug)]
struct Ack {
    name: Bytes32,
    status: u8,
    error: Option<String>,
}

/// A change of the chain staged to come just before a node answers a
/// request ([`Model::staged`]).
enum Staged {
    /// A reorganisation ([`Model::reorganise`]): its depth and the bundles
    /// its first block carries.
    Reorg(u32, Vec<SpendBundle>),
    /// One block ([`Model::grow`]).
    Block,
    /// The chain saved, every block of it as it was, and this many blocks
    /// more ([`Model::return_to`]).
    Return(Chain, u32),
}

struct Model {
    net: ChiaNet,
    network: Network,
    chain: Chain,
    nodes: Vec<NodeState>,
    /// The main chain's last announcement, which a node brought up later
    /// starts from.
    announced: Announcement,
    generation: u64,
    /// Coins funded, which the next block creates.
    next_coins: Vec<(Coin, Option<Bytes>)>,
    /// Bundles pushed elsewhere, which the next block carries first.
    next_first: Vec<SpendBundle>,
    /// The salt of the current fork, and how many forks there were.
    salt: Bytes32,
    forks: u64,
    funded: u64,
    arrivals: u64,
    page_limit: usize,
    /// The most ids one `RespondCoinState` takes ([`MockChain::set_lookup_limit`]).
    lookup_limit: usize,
    received: Vec<SpendBundle>,
    acks: Vec<Ack>,
    unanswered: Vec<ProtocolMessageTypes>,
    connections: usize,
    /// Changes of the chain to come, in order, each just before a node
    /// answers the first request of its kind once the one before it has come
    /// ([`MockChain::reorg_before`], [`MockChain::block_before`],
    /// [`MockChain::return_before`]).
    staged: VecDeque<(ProtocolMessageTypes, Staged)>,
    /// A quiet node to announce its peak once the time given has passed
    /// ([`MockChain::speak_after`]), for [`serve`] to schedule.
    speak_later: Option<(usize, Duration)>,
}

impl Model {
    fn index_of(&self, node: &MockNode) -> usize {
        self.nodes.iter().position(|n| n.addr == node.addr).expect("a node of this chain")
    }

    fn view(&self, node: usize) -> &Chain {
        self.nodes[node].held.as_ref().unwrap_or(&self.chain)
    }

    /// `send_transaction` and `add_transaction` on one node, in their order:
    /// a bundle in the mempool is SUCCESS and leaves the seen cache; one in
    /// the seen cache is ALREADY_INCLUDING_TRANSACTION; one pre-validation
    /// refuses stays in the seen cache, refused; one it passes on a busy node
    /// is refused INVALID_SPEND_BUNDLE and not remembered (pre-validation's
    /// timeout); else it enters the seen cache and is judged, and leaves it
    /// again unless it is taken.
    fn send_transaction(&mut self, node: usize, bundle: SpendBundle) -> (u8, Option<String>) {
        let name = bundle.name();
        let net = self.net;
        let Model { chain, nodes, arrivals, .. } = self;
        let NodeState { pool, held, busy, .. } = &mut nodes[node];
        let view = held.as_ref().unwrap_or(chain);
        if pool.holds(&name) {
            pool.remove_seen(&name);
            return (SUCCESS, None);
        }
        if pool.seen(&name) {
            return (FAILED, Some(err_name(ErrorCode::AlreadyIncludingTransaction)));
        }
        if bundle.coin_spends.is_empty() {
            pool.add_seen(name);
            return (FAILED, Some(err_name(ErrorCode::InvalidSpendBundle)));
        }
        let conds = match pre_validate(net, view.peak(), &bundle) {
            Ok(conds) => conds,
            Err(code) => {
                pool.add_seen(name);
                return (FAILED, Some(err_name(code)));
            }
        };
        if *busy {
            // Pre-validation ran too long (either of its two timeouts): a
            // soft failure (a `ValueError`), refused, not remembered, the
            // mempool as it was.
            return (FAILED, Some(err_name(ErrorCode::InvalidSpendBundle)));
        }
        if conds.execution_cost + conds.condition_cost == 0 {
            // A soft failure (a `ValueError`): refused, not remembered.
            return (FAILED, Some(err_name(ErrorCode::InvalidSpendBundle)));
        }
        pool.add_seen(name);
        *arrivals += 1;
        match judge(net, view, pool, bundle, conds, *arrivals) {
            Judged::Taken(item) => {
                pool.items.push(item);
                (SUCCESS, None)
            }
            Judged::Pending(code, item) => {
                Pool::set_aside(&mut pool.pending, item);
                pool.remove_seen(&name);
                (PENDING, Some(err_name(code)))
            }
            Judged::Conflict(item) => {
                Pool::set_aside(&mut pool.conflicts, item);
                pool.remove_seen(&name);
                (PENDING, Some(err_name(ErrorCode::MempoolConflict)))
            }
            Judged::Failed(code) => {
                pool.remove_seen(&name);
                (FAILED, Some(err_name(code)))
            }
        }
    }

    /// Whether a bundle fits block `height` as built so far: each coin it
    /// spends is unspent on the chain (coins earlier bundles of the block
    /// created count) or one it creates itself, and its time locks pass
    /// against the block before, a coin of this block timed at this block.
    fn fits(&self, bundle_conds: &OwnedSpendBundleConditions, height: u32) -> bool {
        let mut own: HashMap<Bytes32, Coin> = HashMap::new();
        for spend in &bundle_conds.spends {
            for (puzzle_hash, amount, _) in &spend.create_coin {
                let coin = Coin::new(spend.coin_id, *puzzle_hash, *amount);
                own.insert(coin.coin_id(), coin);
            }
        }
        let mut records: HashMap<Bytes32, CoinRecord> = HashMap::new();
        for spend in &bundle_conds.spends {
            let record = match (own.get(&spend.coin_id), self.chain.record(&spend.coin_id)) {
                (Some(coin), _) => CoinRecord::new(*coin, height, 0, false, timestamp(height)),
                (None, Some(record)) if record.spent_block_index == 0 => record,
                _ => return false,
            };
            records.insert(spend.coin_id, record);
        }
        check_time_locks(&records, bundle_conds, height - 1, timestamp(height - 1)).is_ok()
    }

    /// Put one bundle in block `height`: what it creates first, then what it
    /// spends, so a coin it creates and spends is created and spent at
    /// `height`, and kept. Each coin made with a hint gives the block a hint
    /// row.
    fn apply(
        &mut self,
        bundle: &SpendBundle,
        conds: &OwnedSpendBundleConditions,
        height: u32,
        spent: &mut Vec<Bytes32>,
        hints: &mut Vec<(Bytes32, Bytes)>,
    ) {
        for spend in &conds.spends {
            for (puzzle_hash, amount, hint) in &spend.create_coin {
                let coin = Coin::new(spend.coin_id, *puzzle_hash, *amount);
                self.chain.coins.insert(coin.coin_id(), CoinRec { coin, created: height, spent: None, spend: None });
                hint_row(hints, coin, hint.clone());
            }
        }
        for coin_spend in &bundle.coin_spends {
            let id = coin_spend.coin.coin_id();
            let rec = self.chain.coins.get_mut(&id).expect("a coin the block may spend");
            rec.spent = Some(height);
            rec.spend = Some((coin_spend.puzzle_reveal.clone(), coin_spend.solution.clone()));
            spent.push(id);
        }
    }

    /// Build the next block on the main chain: the funded coins, then
    /// `first` (bundles pushed elsewhere, which must fit), then, when
    /// `from_mempool`, every node's mempool items in the order they arrived,
    /// each that still fits. Returns its height.
    fn build_block(&mut self, first: Vec<SpendBundle>, from_mempool: bool) -> u32 {
        let height = self.chain.peak() + 1;
        let mut spent = Vec::new();
        let mut hints = Vec::new();
        for (coin, hint) in std::mem::take(&mut self.next_coins) {
            self.chain.coins.insert(coin.coin_id(), CoinRec { coin, created: height, spent: None, spend: None });
            hint_row(&mut hints, coin, hint);
        }
        for bundle in first {
            let conds = pre_validate(self.net, height - 1, &bundle)
                .unwrap_or_else(|code| panic!("a bundle the test has block {height} carry is invalid: {}", err_name(code)));
            assert!(self.fits(&conds, height), "a bundle the test has block {height} carry does not fit the chain");
            self.apply(&bundle, &conds, height, &mut spent, &mut hints);
        }
        if from_mempool {
            let mut items: Vec<Item> = self.nodes.iter().filter(|n| n.held.is_none()).flat_map(|n| n.pool.items.iter().cloned()).collect();
            items.sort_by_key(|item| item.arrival);
            let mut carried = HashSet::new();
            for item in items {
                if carried.contains(&item.name) || !self.fits(&item.conds, height) {
                    continue;
                }
                carried.insert(item.name);
                self.apply(&item.bundle, &item.conds, height, &mut spent, &mut hints);
            }
        }
        self.chain.push(self.salt, spent, hints)
    }

    /// Tell every node not held of the main chain's peak, and return the
    /// generation and the nodes told.
    fn announce(&mut self, fork_point: u32) -> (u64, Vec<usize>) {
        self.generation += 1;
        let height = self.chain.peak();
        let announced = Announcement {
            generation: self.generation,
            height,
            header_hash: self.chain.hash(height).expect("the peak"),
            fork_point,
        };
        self.announced = announced;
        let mut told = Vec::new();
        for (index, node) in self.nodes.iter().enumerate() {
            if node.held.is_none() && node.quiet.is_none() {
                node.announce.send_replace(announced);
                told.push(index);
            }
        }
        (self.generation, told)
    }

    /// A quiet node's withheld announcement ([`MockChain::quiet`]): the
    /// main chain's peak, with the fork point its last announcement, which
    /// the chain has only grown from since.
    fn speak(&mut self, node: usize) {
        self.nodes[node].quiet = None;
        self.generation += 1;
        let fork_point = self.nodes[node].announce.borrow().height;
        let announced = Announcement { generation: self.generation, fork_point, ..self.announced };
        self.nodes[node].announce.send_replace(announced);
    }

    /// [`MockChain::reorg_including`] on the model: the last `n` blocks
    /// replaced by `n + 1` others, every node not held taking the new chain
    /// and told of it. Returns the generation and the nodes told, for the
    /// barrier.
    fn reorganise(&mut self, n: u32, bundles: Vec<SpendBundle>) -> (u64, Vec<usize>) {
        let old = self.chain.peak();
        assert!(n >= 1 && n <= old, "a reorganisation of 1 to {old} blocks");
        let fork = old - n;
        self.chain.rewind(fork);
        self.forks += 1;
        self.salt = sha256(&[b"ssf mock chain fork", &self.forks.to_be_bytes()]);
        let mut first = std::mem::take(&mut self.next_first);
        first.extend(bundles);
        self.build_block(first, false);
        for _ in 0..n {
            self.build_block(vec![], false);
        }
        let Model { net, chain, nodes, .. } = &mut *self;
        for node in nodes.iter_mut().filter(|n| n.held.is_none()) {
            node.hints.extend(chain.hints_above(fork));
            new_peak_slow(*net, chain, &mut node.pool);
        }
        self.announce(fork)
    }

    /// [`MockChain::return_before`] on the model: the main chain made the
    /// one saved again, every block of it with the hashes it had, so the
    /// coins and spends it held, then `n` blocks more on a new fork, which
    /// carry nothing; every node not held takes it on the slow path, adds
    /// the hint rows of its blocks above the fork point to the ones it keeps,
    /// and is told of it. It must be heavier than the chain it replaces, as
    /// a full node takes no lighter one: its peak higher. Returns the
    /// generation and the nodes told.
    fn return_to(&mut self, saved: Chain, n: u32) -> (u64, Vec<usize>) {
        let now = self.chain.peak();
        assert!(saved.peak() + n > now, "a chain returned to is heavier than the one it replaces: its peak above {now}");
        let fork = self.chain.common(&saved);
        self.chain = saved;
        self.forks += 1;
        self.salt = sha256(&[b"ssf mock chain fork", &self.forks.to_be_bytes()]);
        for _ in 0..n {
            self.build_block(vec![], false);
        }
        let Model { net, chain, nodes, .. } = &mut *self;
        for node in nodes.iter_mut().filter(|n| n.held.is_none()) {
            node.hints.extend(chain.hints_above(fork));
            new_peak_slow(*net, chain, &mut node.pool);
        }
        self.announce(fork)
    }

    /// One block on the main chain, carrying the mempools' items, taken by
    /// every node not held on the fast path and announced, with no barrier.
    fn grow(&mut self) {
        let fork_point = self.chain.peak();
        let height = self.build_block(vec![], true);
        let spent: HashSet<Bytes32> = self.chain.blocks[height as usize].spent.iter().copied().collect();
        let Model { net, chain, nodes, .. } = &mut *self;
        for node in nodes.iter_mut().filter(|n| n.held.is_none()) {
            node.hints.extend(chain.hints_above(height - 1));
            new_peak_fast(*net, chain, &mut node.pool, &spent);
        }
        self.announce(fork_point);
    }

    /// Answer one request as a full node does, or `None` for a request it
    /// has no answer for. The next change staged, when it is staged for a
    /// request of this kind ([`Model::staged`]), comes first, then a
    /// restless node's block ([`MockChain::restless_before`]).
    fn answer(&mut self, node: usize, request: &Message) -> Option<Message> {
        if self.staged.front().is_some_and(|(kind, _)| *kind == request.msg_type) {
            let (_, change) = self.staged.pop_front().expect("a staged change");
            match change {
                Staged::Reorg(n, bundles) => {
                    self.reorganise(n, bundles);
                }
                Staged::Block => self.grow(),
                Staged::Return(saved, n) => {
                    self.return_to(saved, n);
                }
            }
        }
        if self.nodes[node].restless == Some(request.msg_type) {
            self.grow();
        }
        let answer = self.answer_now(node, request);
        if let Some(Some((kind, after))) = self.nodes[node].quiet {
            if kind == request.msg_type {
                self.nodes[node].quiet = Some(None);
                self.speak_later = Some((node, after));
            }
        }
        answer
    }

    fn answer_now(&mut self, node: usize, request: &Message) -> Option<Message> {
        match request.msg_type {
            ProtocolMessageTypes::RequestBlockHeader => {
                let asked = RequestBlockHeader::from_bytes(&request.data).ok()?;
                Some(match self.view(node).header(asked.height) {
                    Some(header) => reply(&RespondBlockHeader::new(header)),
                    None => reply(&RejectHeaderRequest::new(asked.height)),
                })
            }
            ProtocolMessageTypes::RequestPuzzleState => {
                let asked = RequestPuzzleState::from_bytes(&request.data).ok()?;
                Some(puzzle_state(self.view(node), &self.nodes[node].hints, &self.nodes[node].lies, self.page_limit, asked))
            }
            ProtocolMessageTypes::RequestCoinState => {
                let asked = RequestCoinState::from_bytes(&request.data).ok()?;
                if self.nodes[node].lies.refuse_lookups {
                    return Some(reply(&RejectCoinState::new(RejectStateReason::ExceededSubscriptionLimit)));
                }
                Some(coin_state(self.view(node), &self.nodes[node].lies, self.lookup_limit, asked))
            }
            ProtocolMessageTypes::RequestPuzzleSolution => {
                let asked = RequestPuzzleSolution::from_bytes(&request.data).ok()?;
                let found = self.view(node).coins.get(&asked.coin_name).filter(|rec| rec.spent == Some(asked.height));
                let served = match self.nodes[node].lies.spends.get(&asked.coin_name) {
                    Some(lie) => lie.clone(),
                    None => found.and_then(|rec| rec.spend.clone()),
                };
                Some(match served {
                    Some((puzzle, solution)) => {
                        reply(&RespondPuzzleSolution::new(PuzzleSolutionResponse::new(asked.coin_name, asked.height, puzzle, solution)))
                    }
                    None => reply(&RejectPuzzleSolution::new(asked.coin_name, asked.height)),
                })
            }
            ProtocolMessageTypes::SendTransaction => {
                let sent = SendTransaction::from_bytes(&request.data).ok()?;
                let name = sent.transaction.name();
                self.received.push(sent.transaction.clone());
                let (status, error) = self.send_transaction(node, sent.transaction);
                self.acks.push(Ack { name, status, error: error.clone() });
                Some(reply(&TransactionAck::new(name, status, error)))
            }
            // Gossip: no other peers to name, so the lane's pool stays at
            // the nodes it was given.
            ProtocolMessageTypes::RequestPeers => Some(reply(&RespondPeers::new(vec![]))),
            ProtocolMessageTypes::RequestChildren => {
                let asked = RequestChildren::from_bytes(&request.data).ok()?;
                let mut children: Vec<&CoinRec> = self.view(node).coins.values().filter(|rec| rec.coin.parent_coin_info == asked.coin_name).collect();
                children.sort_by_key(|rec| rec.coin.coin_id());
                Some(reply(&RespondChildren::new(children.into_iter().map(CoinRec::state).collect())))
            }
            _ => None,
        }
    }
}

/// `request_puzzle_state`: the coins at the puzzle hashes (or hinted to
/// them) changed after the anchor, oldest change first, at most `limit`;
/// when cut, never inside a block, and dated by the block before the first
/// one left out. A hinted coin is one whose id a row of the node's `hints`
/// lists under one of the puzzle hashes, found among the coin records of
/// `chain`, as `batch_coin_states_by_puzzle_hashes` takes the coin records
/// whose name is among the hint rows' coin ids: a coin made again on a new
/// fork with another hint is listed under both, once, as it stands now,
/// and a row whose coin is not on `chain` lists nothing. A coin the node
/// hides is left out whatever matches it ([`MockChain::hide_on`]), and a
/// coin it made up is listed under the hint it named
/// ([`MockChain::invent_on`]).
fn puzzle_state(chain: &Chain, hints: &HashSet<(Bytes32, Bytes)>, lies: &Lies, limit: usize, asked: RequestPuzzleState) -> Message {
    let mut keys = Vec::new();
    for key in asked.puzzle_hashes {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    if !chain.anchored(asked.previous_height, asked.header_hash) {
        return reply(&RejectPuzzleState::new(RejectStateReason::Reorg));
    }
    let since = asked.previous_height.map_or(0, |height| height + 1);
    let filters = &asked.filters;
    let hinted: HashSet<Bytes32> = if filters.include_hinted {
        hints.iter().filter(|(_, hint)| keys.iter().any(|key| key.as_ref() == hint.as_ref())).map(|(id, _)| *id).collect()
    } else {
        HashSet::new()
    };
    let invented = lies.invented.values().filter(|(hint, _)| filters.include_hinted && keys.contains(hint)).map(|(_, rec)| rec);
    let mut found: Vec<&CoinRec> = chain
        .coins
        .values()
        .filter(|rec| keys.contains(&rec.coin.puzzle_hash) || hinted.contains(&rec.coin.coin_id()))
        .chain(invented)
        .filter(|rec| !lies.hidden.contains(&rec.coin.coin_id()))
        .filter(|rec| rec.created >= since || rec.spent.is_some_and(|spent| spent >= since))
        .filter(|rec| if rec.spent.is_some() { filters.include_spent } else { filters.include_unspent })
        .filter(|rec| rec.coin.amount >= filters.min_amount)
        .collect();
    found.sort_by_key(|rec| (rec.changed(), rec.coin.coin_id()));
    let (height, finished) = if found.len() > limit {
        let next = found[limit].changed();
        found.truncate(limit);
        while found.last().is_some_and(|rec| rec.changed() == next) {
            found.pop();
        }
        (next - 1, false)
    } else {
        (chain.peak(), true)
    };
    let header_hash = chain.hash(height).expect("a height on the chain");
    reply(&RespondPuzzleState::new(keys, height, header_hash, finished, found.into_iter().map(CoinRec::state).collect()))
}

/// `request_coin_state`: the ids asked for, cut at `limit` and echoed, and
/// the states of the coins among them changed after the anchor. An id the
/// chain does not know is echoed with no state, as is one the node denies
/// ([`MockChain::deny_on`]); one it made up has the state it gave it
/// ([`MockChain::invent_on`]); and a node echoing no id gives nothing
/// ([`MockChain::echo_no_lookup_ids_on`]).
fn coin_state(chain: &Chain, lies: &Lies, limit: usize, asked: RequestCoinState) -> Message {
    if lies.echo_none {
        return reply(&RespondCoinState::new(vec![], vec![]));
    }
    let mut ids = Vec::new();
    for id in asked.coin_ids.into_iter().take(limit) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    if !chain.anchored(asked.previous_height, asked.header_hash) {
        return reply(&RejectCoinState::new(RejectStateReason::Reorg));
    }
    let since = asked.previous_height.map_or(0, |height| height + 1);
    let states = ids
        .iter()
        .filter(|id| !lies.denied.contains(*id))
        .filter_map(|id| chain.coins.get(id).or_else(|| lies.invented.get(id).map(|(_, rec)| rec)))
        .filter(|rec| rec.created >= since || rec.spent.is_some_and(|spent| spent >= since))
        .map(CoinRec::state)
        .collect();
    reply(&RespondCoinState::new(ids, states))
}

fn binary(message: &Message) -> WsMessage {
    WsMessage::Binary(message.to_bytes().expect("encoding a message"))
}

/// Per connection accepted and not yet ended: its node, and the generation
/// of the last announcement it showed it filed, `None` until it has shown
/// one ([`Shared::acks`]).
type Acks = HashMap<u64, (usize, Option<u64>)>;

struct Shared {
    model: Mutex<Model>,
    /// Every connection from the moment its node accepts it, before its TLS,
    /// until [`serve`] ends for it, whichever way: its node, and the last
    /// announcement it showed it filed, the generation its pong carried.
    /// `None` until its first pong, so a connection that has not handshaken
    /// yet, or has and not yet ponged the peak it was greeted with, has filed
    /// nothing (not even generation 0, block 0's announcement), and holds
    /// every barrier of its node ([`MockChain::barrier`]).
    acks: watch::Sender<Acks>,
    next_conn: AtomicU64,
}

impl Shared {
    /// The handshake's answer: the node's handshake, then its peak as
    /// announced now, the fork point the peak itself (a full node announces
    /// its peak right after a handshake), then the ping carrying that
    /// announcement's generation, as every later announcement is followed by
    /// one. Nothing is recorded as filed here: the connection, listed with
    /// nothing filed since it was accepted, files the greeting only by the
    /// pong for that ping. Read under one lock of the model, under which
    /// every announcement is made, so the peak it greets with is the node's
    /// announcement at one instant of the model and any announcement after
    /// that instant is a change its receiver has not seen, which [`serve`]
    /// pushes once the answer is out: a block announced meanwhile reaches the
    /// connection either way, and so does the barrier's ping.
    fn handshake(&self, announced: &mut watch::Receiver<Announcement>) -> Vec<WsMessage> {
        let model = self.model.lock().unwrap();
        let now = *announced.borrow_and_update();
        let handshake = Handshake::new(model.network.id.clone(), PROTOCOL_VERSION.to_string(), "mock".to_string(), 0, NodeType::FullNode, vec![]);
        let mut out = vec![binary(&reply(&handshake))];
        out.extend(now.frames(now.height));
        out
    }

    /// The node's answer to `request`. A restless node's new block
    /// ([`MockChain::restless_before`]) is announced on `announced`'s
    /// connection ahead of the answer, so the client has filed the new peak
    /// by the time it reads the answer.
    fn answer(&self, node: usize, request: &Message, announced: &mut watch::Receiver<Announcement>) -> Vec<WsMessage> {
        let mut model = self.model.lock().unwrap();
        let restless = model.nodes[node].restless == Some(request.msg_type);
        match model.answer(node, request) {
            Some(mut answer) => {
                answer.id = request.id;
                let mut out = Vec::new();
                if restless && announced.has_changed().unwrap_or(false) {
                    let now = *announced.borrow_and_update();
                    out.extend(now.frames(now.fork_point));
                }
                out.push(binary(&answer));
                out
            }
            None => {
                model.unanswered.push(request.msg_type);
                vec![]
            }
        }
    }
}

/// One accepted connection, listed in [`Shared::acks`] with nothing filed
/// since its node accepted it: the TLS a full node runs (a client
/// certificate the Chia CA signed demanded), the websocket, then requests
/// answered from the model and, once the client has handshaken,
/// announcements pushed as they come. The greeting the handshake is answered
/// with and each later announcement are followed by a websocket ping
/// carrying the announcement's generation ([`Announcement::frames`]). The
/// client's reader files a `NewPeakWallet` before it reads the next frame,
/// and its websocket sends the pong for a ping when it next reads, so a pong
/// for a generation shows the announcement was filed: the barrier of
/// [`MockChain::farm_blocks`]. However it ends (a TLS or websocket handshake
/// that fails, a close, a socket that errs or a send that does), the
/// connection leaves the list, so it holds no barrier after. One accepted
/// and left idle short of the Chia handshake holds every barrier of its node
/// until [`BARRIER`] runs out, and the barrier panics; no client here does
/// that, as the lane's dial runs TCP, TLS, the websocket upgrade and the
/// handshake straight through, or drops the socket where it stands
/// ([`PeerConn::connect_until`]).
///
/// [`PeerConn::connect_until`]: crate::chia_peer::PeerConn::connect_until
async fn serve(
    shared: Arc<Shared>,
    node: usize,
    requests: Arc<Mutex<Vec<ProtocolMessageTypes>>>,
    acceptor: tokio_rustls::TlsAcceptor,
    tcp: tokio::net::TcpStream,
    mut announced: watch::Receiver<Announcement>,
    conn: u64,
) {
    if let Ok(tls) = acceptor.accept(tcp).await {
        if let Ok(ws) = tokio_tungstenite::accept_async(tls).await {
            let (mut sink, mut stream) = ws.split();
            let mut registered = false;
            'talk: loop {
                let out: Vec<WsMessage> = tokio::select! {
                    biased;
                    changed = announced.changed(), if registered => {
                        if changed.is_err() {
                            break 'talk;
                        }
                        let now = *announced.borrow_and_update();
                        now.frames(now.fork_point).into()
                    }
                    frame = stream.next() => match frame {
                        Some(Ok(WsMessage::Binary(bytes))) => {
                            let Ok(message) = Message::from_bytes(&bytes) else { continue };
                            requests.lock().unwrap().push(message.msg_type);
                            if message.msg_type == ProtocolMessageTypes::Handshake {
                                registered = true;
                                shared.handshake(&mut announced)
                            } else {
                                let out = shared.answer(node, &message, &mut announced);
                                let later = shared.model.lock().unwrap().speak_later.take();
                                if let Some((quiet, after)) = later {
                                    let shared = shared.clone();
                                    tokio::spawn(async move {
                                        tokio::time::sleep(after).await;
                                        let mut model = shared.model.lock().unwrap();
                                        if model.nodes[quiet].quiet.is_some() {
                                            model.speak(quiet);
                                        }
                                    });
                                }
                                out
                            }
                        }
                        Some(Ok(WsMessage::Pong(data))) => {
                            if let Ok(generation) = <[u8; 8]>::try_from(data.as_slice()) {
                                let generation = u64::from_be_bytes(generation);
                                shared.acks.send_modify(|acks| {
                                    if let Some((_, filed)) = acks.get_mut(&conn) {
                                        *filed = Some(filed.map_or(generation, |filed| filed.max(generation)));
                                    }
                                });
                            }
                            continue;
                        }
                        Some(Ok(WsMessage::Close(_))) | Some(Err(_)) | None => break 'talk,
                        Some(Ok(_)) => continue,
                    },
                };
                for frame in out {
                    if sink.send(frame).await.is_err() {
                        break 'talk;
                    }
                }
            }
        }
    }
    shared.acks.send_modify(|acks| {
        acks.remove(&conn);
    });
}

/// The mock chain. Every clone is the same chain; its nodes answer from it
/// for as long as they run.
#[derive(Clone)]
pub(crate) struct MockChain(Arc<Shared>);

/// The main chain as it stood once ([`MockChain::save`]), to come back to
/// ([`MockChain::return_before`]).
pub(crate) struct Saved(Chain);

impl MockChain {
    /// Block 0 alone, on `net`'s genesis challenge.
    pub(crate) fn new(net: ChiaNet) -> Self {
        let network = Network { introducers: vec![], ..Network::of(net) };
        let chain = Chain::new(network.genesis);
        let announced = Announcement { generation: 0, height: 0, header_hash: chain.hash(0).expect("block 0"), fork_point: 0 };
        let model = Model {
            net,
            network,
            chain,
            nodes: Vec::new(),
            announced,
            generation: 0,
            next_coins: Vec::new(),
            next_first: Vec::new(),
            salt: zero(),
            forks: 0,
            funded: 0,
            arrivals: 0,
            page_limit: PAGE_LIMIT,
            lookup_limit: PAGE_LIMIT,
            received: Vec::new(),
            acks: Vec::new(),
            unanswered: Vec::new(),
            connections: 0,
            staged: VecDeque::new(),
            speak_later: None,
        };
        Self(Arc::new(Shared { model: Mutex::new(model), acks: watch::Sender::new(HashMap::new()), next_conn: AtomicU64::new(0) }))
    }

    fn lock(&self) -> MutexGuard<'_, Model> {
        self.0.model.lock().unwrap()
    }

    /// The network the nodes serve: `net`'s, with no introducer, so a lane
    /// on it looks nothing up.
    pub(crate) fn network(&self) -> Network {
        self.lock().network.clone()
    }

    /// One more full node on this chain, on a port of its own (loopback
    /// groups by port, so two nodes are two network groups), presenting a
    /// certificate of its own, with a mempool of its own and a hint table of
    /// its own, which starts with the rows of the chain's blocks, as a node
    /// syncing it adds them.
    pub(crate) async fn node(&self) -> MockNode {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let index = {
            let mut model = self.lock();
            let announce = watch::Sender::new(model.announced);
            let hints = model.chain.hints_above(0).collect();
            model.nodes.push(NodeState {
                addr,
                announce,
                pool: Pool::default(),
                hints,
                held: None,
                busy: false,
                quiet: None,
                restless: None,
                lies: Lies::default(),
            });
            model.nodes.len() - 1
        };
        let cert = CERTS.get(index).cloned().unwrap_or_else(|| Arc::new(chia_ssl::ChiaCertificate::generate().unwrap()));
        let acceptor = acceptor(&cert);
        let shared = self.0.clone();
        let node_requests = requests.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { break };
                let conn = shared.next_conn.fetch_add(1, Ordering::Relaxed);
                let announced = {
                    let mut model = shared.model.lock().unwrap();
                    model.connections += 1;
                    // Listed as it is accepted, before its TLS, with nothing
                    // filed; `serve` takes it off the list when it ends.
                    shared.acks.send_modify(|acks| {
                        acks.insert(conn, (index, None));
                    });
                    model.nodes[index].announce.subscribe()
                };
                tokio::spawn(serve(shared.clone(), index, node_requests.clone(), acceptor.clone(), tcp, announced, conn));
            }
        });
        MockNode { addr, cert, peak: Arc::new(Mutex::new(None)), seen: requests, task }
    }

    /// Two nodes on this chain: what an agreed lane needs.
    pub(crate) async fn pair(&self) -> (MockNode, MockNode) {
        (self.node().await, self.node().await)
    }

    /// A lane seeded with `a` (introducer, a fresh source) and `b`
    /// (gossip), sharing the binary's client certificate, with no pins and
    /// no peer store. Nothing is dialled until the first request.
    pub(crate) fn lane(&self, a: &MockNode, b: &MockNode) -> Arc<Lane> {
        Arc::new(
            Lane::new(self.network(), vec![], false, None)
                .with_candidates(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)])
                .with_tls(TLS.clone()),
        )
    }

    /// A lane with `pin` pinned (`SSF_CHIA_PEERS`, its address as typed)
    /// and `public` its one public peer (introducer), sharing the binary's
    /// client certificate, with no peer store: an agreed read takes the pin
    /// and the public peer, which stand in two network groups.
    pub(crate) fn pinned_lane(&self, pin: &MockNode, public: &MockNode) -> Arc<Lane> {
        Arc::new(
            Lane::new(self.network(), vec![pin.addr.to_string()], false, None)
                .with_candidates(vec![(public.addr, Source::Introducer)])
                .with_tls(TLS.clone()),
        )
    }

    /// A coin of `amount` at `puzzle_hash`, hinted to `hint` when given,
    /// which the next block creates.
    pub(crate) fn fund(&self, puzzle_hash: Bytes32, amount: u64, hint: Option<Bytes32>) -> Coin {
        let mut model = self.lock();
        model.funded += 1;
        let parent = sha256(&[b"ssf mock chain funding", &model.funded.to_be_bytes()]);
        let coin = Coin::new(parent, puzzle_hash, amount);
        model.next_coins.push((coin, hint.map(|h| Bytes::new(h.to_vec()))));
        coin
    }

    /// A bundle pushed to some other node: the next block carries it ahead
    /// of every mempool item, so a write of ours spending the same coin is
    /// left out.
    pub(crate) fn include_next(&self, bundle: SpendBundle) {
        self.lock().next_first.push(bundle);
    }

    /// One block. Returns the new peak once every connection of every node
    /// not held has filed it, one accepted and not yet handshaken included
    /// ([`Self::barrier`]).
    pub(crate) async fn farm(&self) -> u32 {
        self.farm_blocks(1).await
    }

    /// `n` blocks, announced once, at the top, as a node that took several
    /// blocks at once announces only its new peak. Each block goes through
    /// every node's mempool on the fast path.
    pub(crate) async fn farm_blocks(&self, n: u32) -> u32 {
        assert!(n > 0, "farm at least one block");
        let (generation, told, peak) = {
            let mut model = self.lock();
            let fork_point = model.chain.peak();
            for _ in 0..n {
                let first = std::mem::take(&mut model.next_first);
                let height = model.build_block(first, true);
                let spent: HashSet<Bytes32> = model.chain.blocks[height as usize].spent.iter().copied().collect();
                let Model { net, chain, nodes, .. } = &mut *model;
                for node in nodes.iter_mut().filter(|n| n.held.is_none()) {
                    node.hints.extend(chain.hints_above(height - 1));
                    new_peak_fast(*net, chain, &mut node.pool, &spent);
                }
            }
            let (generation, told) = model.announce(fork_point);
            (generation, told, model.chain.peak())
        };
        self.barrier(&told, generation).await;
        peak
    }

    /// Blocks up to `height`.
    pub(crate) async fn farm_to(&self, height: u32) -> u32 {
        let peak = self.peak();
        assert!(height > peak, "the chain is at {peak} already");
        self.farm_blocks(height - peak).await
    }

    /// [`Self::reorg_including`] with nothing on the new fork.
    pub(crate) async fn reorg(&self, n: u32) -> u32 {
        self.reorg_including(n, vec![]).await
    }

    /// The last `n` blocks replaced by `n + 1` others on a new fork, so the
    /// peak rises by one. The first new block carries `bundles` (after any
    /// [`Self::include_next`] bundles), and no new block takes from the
    /// mempools: the old blocks' bundles are not given back to them, as a
    /// full node gives back none. Every node not held then takes the new
    /// chain on the slow path, adds the new blocks' hint rows to the ones it
    /// keeps from the old, and is told the fork point.
    pub(crate) async fn reorg_including(&self, n: u32, bundles: Vec<SpendBundle>) -> u32 {
        let (generation, told, peak) = {
            let mut model = self.lock();
            let (generation, told) = model.reorganise(n, bundles);
            (generation, told, model.chain.peak())
        };
        self.barrier(&told, generation).await;
        peak
    }

    /// [`Self::reorg_including`] staged to come just as some node is to
    /// answer its next request of `kind`, which it then answers from the new
    /// chain, as does every node after it: a reorganisation between two
    /// rounds of a lane's request. Once, with no barrier: each connection
    /// hears of the new peak when its announcement arrives, a moment after
    /// the answer. Changes staged one after another come in that order, each
    /// at the first request of its kind once the one before it has come.
    pub(crate) fn reorg_before(&self, kind: ProtocolMessageTypes, n: u32, bundles: Vec<SpendBundle>) {
        self.lock().staged.push_back((kind, Staged::Reorg(n, bundles)));
    }

    /// One block staged as [`Self::reorg_before`] stages a reorganisation:
    /// carrying the mempools' items (not the bundles of
    /// [`Self::include_next`], which wait for the next block farmed), taken
    /// on the fast path by every node not held and told of just as some node
    /// is to answer its next request of `kind`, with no barrier.
    pub(crate) fn block_before(&self, kind: ProtocolMessageTypes) {
        self.lock().staged.push_back((kind, Staged::Block));
    }

    /// The main chain as it stands now, to come back to
    /// ([`Self::return_before`]).
    pub(crate) fn save(&self) -> Saved {
        Saved(self.lock().chain.clone())
    }

    /// A return to the chain `saved`, staged as [`Self::reorg_before`]
    /// stages a reorganisation: the main chain made that one again, every
    /// block of it with the hash it had, and `n` blocks more on a new fork,
    /// heavier than the chain it replaces (its peak higher), so a fork that
    /// came after the save is overtaken by the saved chain's own extension,
    /// as a full node takes the heavier chain back. Every node not held takes
    /// it on the slow path, adds the hint rows of its blocks above the fork
    /// point (it keeps those it had), and is told of the new peak.
    pub(crate) fn return_before(&self, kind: ProtocolMessageTypes, saved: &Saved, n: u32) {
        self.lock().staged.push_back((kind, Staged::Return(saved.0.clone(), n)));
    }

    /// Whether a change staged by [`Self::reorg_before`],
    /// [`Self::block_before`] or [`Self::return_before`] is still to come.
    pub(crate) fn reorg_staged(&self) -> bool {
        !self.lock().staged.is_empty()
    }

    /// Hold `node` where it is: from here it answers from the chain as it
    /// stands now, judges bundles against it, announces nothing and adds no
    /// hint row, while the other nodes follow every block and
    /// reorganisation. Two nodes then disagree as two real ones a block or a
    /// fork apart do. A held node is released before it is held again:
    /// holding it again would move its view to the chain now without the
    /// hint rows and mempool update of the blocks it skipped.
    pub(crate) fn hold(&self, node: &MockNode) {
        let mut model = self.lock();
        let index = model.index_of(node);
        assert!(model.nodes[index].held.is_none(), "the node is held already: release it first");
        let snapshot = model.chain.clone();
        model.nodes[index].held = Some(snapshot);
    }

    /// Let a held node catch up: on the fast path when the chain grew on the
    /// tip it held, else on the slow path, then announced the peak with the
    /// fork point it shares with the chain it held. It adds the hint rows of
    /// the blocks above that fork point to the ones it kept, as a full node
    /// taking the new peak adds those of the blocks since the fork: so it
    /// has the rows of the fork it held and of the chain now, and none of a
    /// block that came and went while it was held.
    pub(crate) async fn release(&self, node: &MockNode) {
        let (generation, told) = {
            let mut model = self.lock();
            let index = model.index_of(node);
            let held = model.nodes[index].held.take().expect("a held node");
            let common = model.chain.common(&held);
            let net = model.net;
            let Model { chain, nodes, .. } = &mut *model;
            let state = &mut nodes[index];
            state.hints.extend(chain.hints_above(common));
            let pool = &mut state.pool;
            if common == held.peak() {
                let spent: HashSet<Bytes32> = chain.blocks[common as usize + 1..].iter().flat_map(|b| b.spent.iter().copied()).collect();
                new_peak_fast(net, chain, pool, &spent);
            } else {
                new_peak_slow(net, chain, pool);
            }
            model.generation += 1;
            let announced = Announcement { generation: model.generation, fork_point: common, ..model.announced };
            model.nodes[index].announce.send_replace(announced);
            (model.generation, vec![index])
        };
        self.barrier(&told, generation).await;
    }

    /// Until every connection of the nodes `told` shows it filed
    /// `generation` (or has ended), for at most [`BARRIER`]. Every
    /// connection counts from the moment its node accepted it
    /// ([`Shared::acks`]): one still short of its handshake, or handshaking
    /// meanwhile, is greeted with the node's peak as announced at its
    /// handshake (this announcement or a later one) and counts as filed only
    /// once it pongs the ping that follows. A connection of a node not told
    /// (held) is not waited for. Without the barrier a lane could read one
    /// connection's new peak beside the other's old one, take the two for
    /// peers disagreeing on the chain, and cool both for ten minutes. Real
    /// nodes do disagree so after a reorganisation, for the seconds a fork
    /// takes to reach them all; a test stages that window with [`Self::hold`]
    /// and [`Self::release`].
    async fn barrier(&self, told: &[usize], generation: u64) {
        let filed = |filed: &Option<u64>| filed.is_some_and(|filed| filed >= generation);
        let current = |acks: &Acks| acks.values().all(|(node, acked)| !told.contains(node) || filed(acked));
        let mut acks = self.0.acks.subscribe();
        let done = tokio::time::timeout(BARRIER, acks.wait_for(current)).await.map(|seen| seen.is_ok());
        if done != Ok(true) {
            let late: Vec<(u64, (usize, Option<u64>))> =
                self.0.acks.borrow().iter().filter(|(_, (node, acked))| told.contains(node) && !filed(acked)).map(|(c, a)| (*c, *a)).collect();
            panic!("connections (id, (node, generation filed)) {late:?} did not file announcement {generation} within {BARRIER:?}");
        }
    }

    /// Every node's mempool made full (or not): from here it refuses a bundle
    /// under the nonzero fee minimum with INVALID_FEE_TOO_CLOSE_TO_ZERO. The
    /// items it holds keep their place, a reorganisation included.
    pub(crate) fn set_full(&self, full: bool) {
        for node in &mut self.lock().nodes {
            node.pool.full = full;
        }
    }

    /// One node's mempool made full (or not).
    pub(crate) fn set_full_on(&self, node: &MockNode, full: bool) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].pool.full = full;
    }

    /// One node made too busy to validate a bundle in time (or not), as a
    /// full node is whose `pre_validate_spendbundle` trips either of its
    /// timeouts: the CLVM run and the signature check took longer than its
    /// `validation_timeout` (`block_creation_timeout`, 2 seconds by
    /// default), or longer than 0.1 s at more than 5 × `validation_timeout`
    /// ns per unit of execution and condition cost (10 ns by default), which
    /// for a bundle under 10 million cost (a standard spend is some 3
    /// million) means any run over 0.1 s, the one a small bundle meets
    /// first. From here a bundle it is sent is refused FAILED
    /// INVALID_SPEND_BUNDLE, a soft failure: left out of its seen cache, its
    /// mempool as it was, so the next send is judged afresh. What
    /// `add_transaction` answers before that check answers as ever: a bundle
    /// in its mempool is SUCCESS, one in its seen cache
    /// ALREADY_INCLUDING_TRANSACTION, and one the CLVM run or the signature
    /// check refuses has that refusal's name. Only a send is refused: a
    /// block or a reorganisation tries the node's items again as ever.
    pub(crate) fn set_busy(&self, node: &MockNode, busy: bool) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].busy = busy;
    }

    /// `node`'s listings made to leave coin `id` out from here, its hint rows
    /// and the coin's puzzle hash notwithstanding, though it still answers
    /// for the coin by id and serves the spend that made it: a peer hiding
    /// a coin, or one whose hint store lacks its row.
    pub(crate) fn hide_on(&self, node: &MockNode, id: Bytes32) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].lies.hidden.insert(id);
    }

    /// `node` made to deny coin `id` from here: its coin-state answers echo
    /// the id with no state, as for a coin its chain does not know, though
    /// its listings still give it.
    pub(crate) fn deny_on(&self, node: &MockNode, id: Bytes32) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].lies.denied.insert(id);
    }

    /// `node` made to serve `spend` from here for the spend of coin `id`, at
    /// whatever height it is asked: its puzzle and solution, or `None` to
    /// refuse the request, as for a coin its chain did not spend there.
    pub(crate) fn serve_spend_on(&self, node: &MockNode, id: Bytes32, spend: Option<CoinSpend>) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].lies.spends.insert(id, spend.map(|cs| (cs.puzzle_reveal, cs.solution)));
    }

    /// `node` made to refuse every lookup by id from here
    /// (`RejectCoinState`), which no honest node does for a lookup that asks
    /// for no subscription.
    pub(crate) fn refuse_lookups_on(&self, node: &MockNode) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].lies.refuse_lookups = true;
    }

    /// `node` made to list `coins` from here, which its chain never made,
    /// under `hint` as coins created at `height` and unspent, and to give
    /// them so by id: a peer making coins up and keeping its story.
    pub(crate) fn invent_on(&self, node: &MockNode, hint: Bytes32, coins: &[Coin], height: u32) {
        let mut model = self.lock();
        let index = model.index_of(node);
        for coin in coins {
            let rec = CoinRec { coin: *coin, created: height, spent: None, spend: None };
            model.nodes[index].lies.invented.insert(coin.coin_id(), (hint, rec));
        }
    }

    /// `node` made to echo none of the ids a lookup by id asks from here,
    /// with no state either: a lookup that makes no progress.
    pub(crate) fn echo_no_lookup_ids_on(&self, node: &MockNode) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].lies.echo_none = true;
    }

    /// `node` made quiet: from here it follows every block as ever (its
    /// view, hint rows and mempool), but announces none, so its peak as its
    /// connections know it lags its own chain, as a full node's announcement
    /// to wallets lags its post-processing of a block. The barrier of a
    /// block does not wait for it. Only blocks may come while it is quiet,
    /// no reorganisation. [`Self::speak`] or [`Self::speak_after`] ends it.
    pub(crate) fn quiet(&self, node: &MockNode) {
        let mut model = self.lock();
        let index = model.index_of(node);
        assert!(model.nodes[index].held.is_none(), "a held node announces nothing anyway");
        model.nodes[index].quiet = Some(None);
    }

    /// A quiet node made to announce its peak `after` it has answered its
    /// next request of `kind`, with no barrier: a full node's announcement
    /// to wallets that follows its answers by that long, as it follows its
    /// post-processing of a block.
    pub(crate) fn speak_after(&self, node: &MockNode, kind: ProtocolMessageTypes, after: Duration) {
        let mut model = self.lock();
        let index = model.index_of(node);
        assert!(model.nodes[index].quiet.is_some(), "a quiet node");
        model.nodes[index].quiet = Some(Some((kind, after)));
    }

    /// Whether `node` is quiet still ([`Self::quiet`]).
    pub(crate) fn is_quiet(&self, node: &MockNode) -> bool {
        let model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].quiet.is_some()
    }

    /// A quiet node announces its peak now, and every connection of it
    /// files it ([`Self::barrier`]).
    pub(crate) async fn speak(&self, node: &MockNode) {
        let (generation, told) = {
            let mut model = self.lock();
            let index = model.index_of(node);
            model.speak(index);
            (model.generation, vec![index])
        };
        self.barrier(&told, generation).await;
    }

    /// `node` made restless: from here, before it serves each header, the
    /// chain takes a block, which every node not held takes and every one
    /// not quiet announces, `node` ahead of the header it serves; so a peak
    /// read before a header request of it and after differ, every time.
    pub(crate) fn restless(&self, node: &MockNode) {
        self.restless_before(node, ProtocolMessageTypes::RequestBlockHeader);
    }

    /// [`Self::restless`] before each request of `kind` `node` answers, in
    /// place of each header.
    pub(crate) fn restless_before(&self, node: &MockNode, kind: ProtocolMessageTypes) {
        let mut model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].restless = Some(kind);
    }

    /// Every node's mempool emptied, as a full mempool evicts what pays
    /// least. Eviction takes items out of the mempool and touches nothing
    /// else: the pending and conflict caches keep the bundles put aside in
    /// them, and the seen caches keep the names.
    pub(crate) fn evict_all(&self) {
        for node in &mut self.lock().nodes {
            node.pool.items.clear();
        }
    }

    /// Every node's seen cache emptied, as when ten thousand bundles have
    /// passed through since.
    pub(crate) fn forget_seen(&self) {
        for node in &mut self.lock().nodes {
            node.pool.seen.clear();
        }
    }

    /// The bundles in any node's mempool, by name, in the order they arrived.
    pub(crate) fn mempool(&self) -> Vec<Bytes32> {
        let model = self.lock();
        let mut items: Vec<&Item> = model.nodes.iter().flat_map(|n| n.pool.items.iter()).collect();
        items.sort_by_key(|item| item.arrival);
        let mut names = Vec::new();
        for item in items {
            if !names.contains(&item.name) {
                names.push(item.name);
            }
        }
        names
    }

    /// The bundles in `node`'s mempool, by name, in the order they arrived.
    pub(crate) fn mempool_on(&self, node: &MockNode) -> Vec<Bytes32> {
        let model = self.lock();
        let index = model.index_of(node);
        model.nodes[index].pool.items.iter().map(|item| item.name).collect()
    }

    pub(crate) fn peak(&self) -> u32 {
        self.lock().chain.peak()
    }

    /// The main chain's header hash at `height`.
    pub(crate) fn header_hash(&self, height: u32) -> Option<Bytes32> {
        self.lock().chain.hash(height)
    }

    /// A coin on the main chain: the coin, the height that created it and
    /// the height that spent it.
    pub(crate) fn record(&self, id: Bytes32) -> Option<(Coin, u32, Option<u32>)> {
        self.lock().chain.coins.get(&id).map(|rec| (rec.coin, rec.created, rec.spent))
    }

    /// The coins on the main chain whose parent is `parent`.
    pub(crate) fn children(&self, parent: Bytes32) -> Vec<Coin> {
        let model = self.lock();
        let mut children: Vec<Coin> = model.chain.coins.values().filter(|rec| rec.coin.parent_coin_info == parent).map(|rec| rec.coin).collect();
        children.sort_by_key(|coin| coin.coin_id());
        children
    }

    /// Every bundle any node was sent, in order.
    pub(crate) fn received(&self) -> Vec<SpendBundle> {
        self.lock().received.clone()
    }

    /// Every ack a node gave a bundle named `name`, in order: its status and
    /// its error.
    pub(crate) fn acks_for(&self, name: Bytes32) -> Vec<(u8, Option<String>)> {
        self.lock().acks.iter().filter(|ack| ack.name == name).map(|ack| (ack.status, ack.error.clone())).collect()
    }

    /// What `bundle` pays: what its spends remove less what they create,
    /// read from its conditions (its signature is not checked here).
    pub(crate) fn fee_of(&self, bundle: &SpendBundle) -> u64 {
        let model = self.lock();
        let constants = model.net.constants();
        let flags = get_flags_for_height_and_constants(model.chain.peak(), constants) | MEMPOOL_MODE;
        let mut a = clvmr::Allocator::new();
        let (conds, _) = run_spendbundle(&mut a, bundle, constants.max_block_cost_clvm / 2, flags, constants).expect("a bundle that runs");
        u64::try_from(conds.removal_amount - conds.addition_amount).expect("a fee in range")
    }

    /// The TCP connections every node of this chain accepted.
    pub(crate) fn connections(&self) -> usize {
        self.lock().connections
    }

    /// The requests a node had no answer for. A lane waits out its request
    /// timeout on each, so every test asserts there are none.
    pub(crate) fn unanswered(&self) -> Vec<ProtocolMessageTypes> {
        self.lock().unanswered.clone()
    }

    /// The most coin states (and coin ids) one answer carries, a listing's
    /// and a lookup's by id alike.
    pub(crate) fn set_page_limit(&self, limit: usize) {
        let mut model = self.lock();
        model.page_limit = limit;
        model.lookup_limit = limit;
    }

    /// The most ids one lookup by id takes and echoes, a listing's limit
    /// left as it is: a full node's `max_subscribe_response_items` caps the
    /// two alike, but a lying peer's listing is capped by nothing.
    pub(crate) fn set_lookup_limit(&self, limit: usize) {
        self.lock().lookup_limit = limit;
    }
}

/// The puzzle `1`, whose solution is its conditions: a coin anyone can
/// spend, so the model tests need no key and build with chia-read alone.
pub(crate) fn open_puzzle_hash() -> Bytes32 {
    clvm_utils::tree_hash_atom(&[1]).into()
}

/// One condition of an open spend ([`open_coin_spend`]).
pub(crate) enum Cond {
    /// `CREATE_COIN` puzzle hash, amount and memos (none: no memo list).
    CreateCoin(Bytes32, u64, Vec<Bytes>),
    /// `CREATE_COIN` puzzle hash and amount, with its memos argument given
    /// whole: any CLVM, a list of atoms or not.
    CreateCoinMemos(Bytes32, u64, Program),
    AssertHeightRelative(u32),
    /// `AGG_SIG_ME` public key (48 bytes) and message.
    AggSigMe(Bytes, Bytes),
    AssertMyPuzzleHash(Bytes32),
    /// `ASSERT_COIN_ANNOUNCEMENT` of an announcement id.
    AssertCoinAnnouncement(Bytes32),
    /// `ASSERT_PUZZLE_ANNOUNCEMENT` of an announcement id.
    AssertPuzzleAnnouncement(Bytes32),
}

/// A spend of `coin`, at [`open_puzzle_hash`], making `conditions`.
pub(crate) fn open_coin_spend(coin: Coin, conditions: &[Cond]) -> CoinSpend {
    use clvm_traits::{clvm_list, ToClvm};
    let mut a = clvmr::Allocator::new();
    let mut list = Vec::new();
    for condition in conditions {
        let node = match condition {
            Cond::CreateCoin(puzzle_hash, amount, memos) if memos.is_empty() => clvm_list!(51, *puzzle_hash, *amount).to_clvm(&mut a),
            Cond::CreateCoin(puzzle_hash, amount, memos) => clvm_list!(51, *puzzle_hash, *amount, memos.clone()).to_clvm(&mut a),
            Cond::CreateCoinMemos(puzzle_hash, amount, memos) => clvm_list!(51, *puzzle_hash, *amount, memos.clone()).to_clvm(&mut a),
            Cond::AssertHeightRelative(blocks) => clvm_list!(82, *blocks).to_clvm(&mut a),
            Cond::AggSigMe(key, message) => clvm_list!(50, key.clone(), message.clone()).to_clvm(&mut a),
            Cond::AssertMyPuzzleHash(puzzle_hash) => clvm_list!(72, *puzzle_hash).to_clvm(&mut a),
            Cond::AssertCoinAnnouncement(id) => clvm_list!(61, *id).to_clvm(&mut a),
            Cond::AssertPuzzleAnnouncement(id) => clvm_list!(63, *id).to_clvm(&mut a),
        };
        list.push(node.expect("a condition"));
    }
    let solution = list.to_clvm(&mut a).expect("a condition list");
    let solution = clvmr::serde::node_to_bytes(&a, solution).expect("a solution");
    CoinSpend::new(coin, Program::from(vec![1u8]), Program::from(solution))
}

/// A bundle of one open spend, with no signature (none is asked for unless a
/// condition asks for one).
pub(crate) fn open_spend(coin: Coin, conditions: &[Cond]) -> SpendBundle {
    SpendBundle::new(vec![open_coin_spend(coin, conditions)], chia_bls::Signature::default())
}
