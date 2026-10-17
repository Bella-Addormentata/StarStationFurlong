//! The chain-access seam (#231 P7 / TODO #13 — S‑0).
//!
//! Every chain read and every push the node makes goes through [`ChainAccess`]:
//! the presence reader and the beat watcher (`chia_resolve`, `chia_watch`), the
//! publisher and its wallet lease (`chia_publish`), the faucet dish
//! (`chia_faucet`) and the craps fairness records (`chia_craps_fair`). The one
//! place the node chooses HOW it reaches the chain is [`connect`] (money
//! paths) and [`connect_carrier`] (the presence lane).
//!
//! Since S‑0 step 2 the only implementation is the PEER LANE
//! ([`crate::chia_peer_lane::PeerLane`]): Chia full-node peers over the
//! light-wallet protocol, as plan §6 and §14 ratified (#231 D1). The testnet11
//! HTTPS gateway that step 1 put behind this trait is gone with it, and
//! `chia-sdk-coinset` has left `Cargo.toml` (Dorkmo, 2026‑10‑12: removed
//! outright, no fallback); nothing the shipped node runs can name coinset.org.
//!
//! The trait speaks the node's vocabulary, not a transport's:
//!   - a LISTING ([`CoinListing`]) is the records found plus whether the source
//!     cut it short and the cursor to continue it with — the two facts every
//!     caller already pages on; a listing cut short with no cursor stays
//!     visible as such (the wallet lease and the wallet read it as incomplete);
//!   - a failure is either [`ChainError::Unanswered`] (no authoritative answer:
//!     a transport failure, or peers that do not agree — the request may or
//!     may not have reached the chain, so a push may be live) or
//!     [`ChainError::Refused`] (the source answered and said no, with its
//!     reason, so a refused push spent nothing). `push_parked` keeps its two
//!     outcomes apart on exactly that distinction (#245 review, round 14).
//!
//! Two shapes changed with the peer lane, because the wallet protocol has them
//! differently: a spend comes back as its puzzle reveal and solution
//! ([`PuzzleAndSolution`]; the callers never read the coin), and the mempool
//! question is asked by handing the spend bundle over again
//! ([`ChainAccess::spend_live`]; plan §14 (6): there is no mempool query).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};

use chia_protocol::{Bytes32, Coin, Program, SpendBundle};

use crate::chia_peer::Network;
use crate::chia_peer_lane::{Lane, PeerLane, Trust};

/// One coin as the chain lists it: the coin, the height of the block that
/// confirmed it, and whether (and at which height) it was spent.
/// `spent_block_index` is 0 while the coin is unspent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoinRecord {
    pub coin: Coin,
    pub confirmed_block_index: u32,
    pub spent: bool,
    pub spent_block_index: u32,
}

/// One page of a coin listing. `truncated` says the source cut the listing
/// short; `next_cursor` is where it continues, when the source offers one. A
/// listing both cut short and without a cursor is incomplete with no way to go
/// on — each caller decides what that means for it (the wallet lease keeps its
/// coins parked, the wallet reports the listing partial, the resolver treats
/// the listing as ended and re-reads next beat).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoinListing {
    pub records: Vec<CoinRecord>,
    pub truncated: bool,
    pub next_cursor: Option<String>,
}

/// The records gathered across a listing's pages. The chain pages by a coin's
/// LATEST change, not by its creation: a coin listed unspent on an early page
/// comes again, spent, on a later one when the chain moved on between the two
/// requests. Folding each page in by coin id keeps the later record, so a
/// caller that follows a cursor neither holds a coin the chain has since
/// spent nor sees one coin twice. Spent coins must be asked for, or the later
/// record never arrives.
#[derive(Debug, Default)]
pub struct PagedRecords {
    by_id: HashMap<Bytes32, CoinRecord>,
}

impl PagedRecords {
    /// Fold one page in: a coin listed before is replaced by its later record.
    pub fn fold(&mut self, page: Vec<CoinRecord>) {
        for record in page {
            self.by_id.insert(record.coin.coin_id(), record);
        }
    }

    /// Every coin once, in the order a single page has: by confirming height,
    /// then id.
    pub fn into_records(self) -> Vec<CoinRecord> {
        let mut records: Vec<CoinRecord> = self.by_id.into_values().collect();
        records.sort_by(|a, b| (a.confirmed_block_index, a.coin.coin_id()).cmp(&(b.confirmed_block_index, b.coin.coin_id())));
        records
    }
}

/// A spend as the chain serves it: the puzzle that was revealed and the
/// solution it ran with. Everything the node reads out of a spend (the
/// `create_coin` memos) comes from running these two.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PuzzleAndSolution {
    pub puzzle_reveal: Program,
    pub solution: Program,
}

/// Why a chain request failed.
#[derive(Debug)]
pub enum ChainError {
    /// No authoritative answer: a transport failure (a timeout above all), or
    /// peers that did not agree. The request may have reached the chain all
    /// the same — a push may be live in the mempool.
    Unanswered(anyhow::Error),
    /// The source answered and refused, with its reason. It holds nothing of
    /// the request: a refused push spent nothing.
    Refused(String),
}

impl std::fmt::Display for ChainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unanswered(e) => write!(f, "unanswered ({e:#})"),
            Self::Refused(why) => write!(f, "refused ({why})"),
        }
    }
}

impl std::error::Error for ChainError {}

/// What the node asks of the chain. Seven operations, one per thing a call
/// site does. The write-side operations (`coin_records_by_names`,
/// `spend_live`, `push_tx`) have callers only in a `chia-publish` build; the
/// trait keeps one shape in both builds so an implementation is written once.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub trait ChainAccess: Send + Sync {
    /// Coins whose creating spend carried `hint` as a memo, confirmed at
    /// `start_height` or later (every height when `None`), spent ones included
    /// when `include_spent`, continuing an earlier listing at `cursor`.
    fn coin_records_by_hint(
        &self,
        hint: Bytes32,
        start_height: Option<u32>,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send;

    /// Coins at `puzzle_hash`, spent ones included when `include_spent`,
    /// continuing an earlier listing at `cursor`.
    fn coin_records_by_puzzle_hash(
        &self,
        puzzle_hash: Bytes32,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send;

    /// The coins named by id, spent ones included when `include_spent`,
    /// continuing an earlier listing at `cursor`.
    fn coin_records_by_names(
        &self,
        names: Vec<Bytes32>,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send;

    /// The spend of `coin_id` in the block at `height`: its puzzle reveal and
    /// solution. `None` when the source has no such spend (an unknown coin, or
    /// one unspent at that height).
    fn puzzle_and_solution(
        &self,
        coin_id: Bytes32,
        height: u32,
    ) -> impl Future<Output = Result<Option<PuzzleAndSolution>, ChainError>> + Send;

    /// The height of the chain's current peak.
    fn peak_height(&self) -> impl Future<Output = Result<u32, ChainError>> + Send;

    /// Whether a spend pushed earlier is still live: `bundle` is handed to the
    /// mempool again (the wallet protocol has no mempool query; plan §14 (6)).
    /// `Ok(true)`: the mempool holds it, or took it back; `Ok(false)`: the
    /// mempool refuses it now, so the spend is dead — its inputs went to
    /// another spend, or the bundle no longer passes — and will never land.
    fn spend_live(&self, bundle: SpendBundle) -> impl Future<Output = Result<bool, ChainError>> + Send;

    /// Hand `bundle` to the mempool. `Ok` means accepted; [`ChainError::Refused`]
    /// means the source said no and nothing was spent; [`ChainError::Unanswered`]
    /// means the outcome is unknown and the bundle may be live.
    fn push_tx(&self, bundle: SpendBundle) -> impl Future<Output = Result<(), ChainError>> + Send;
}

/// The chain the node reads and writes through: the peer lane.
pub type Chain = PeerLane;

/// The process's one lane: its pins and mode come from the environment
/// (`SSF_CHIA_PEERS`, `SSF_CHIA_PIN_ONLY`), its known-good peers from
/// `chia_peers.json`. Connections open on the first request and are shared by
/// every handle.
static LANE: LazyLock<Arc<Lane>> = LazyLock::new(|| Arc::new(Lane::from_env(Network::testnet11())));

/// Chain access for MONEY paths (plan §14 (5)): two peers must agree, or the
/// pin decides in pin-only mode. The publisher's wallet and lease, the faucet
/// and the craps fairness lane construct this. No I/O happens here.
pub fn connect() -> Chain {
    PeerLane::new(LANE.clone(), Trust::Agreed)
}

/// Chain access for the PRESENCE lane (plan §14 (5)): the first reachable
/// peer. The resolver and the watcher construct this: their records are
/// signed and sealed, so the chain is only their carrier.
pub fn connect_carrier() -> Chain {
    PeerLane::new(LANE.clone(), Trust::Carrier)
}

/// One line for the startup log: which peers, which posture.
pub fn describe() -> String {
    LANE.describe()
}

/// Chains for tests: no socket is ever opened. [`testing::Unanswering`] answers
/// nothing (every request fails as [`ChainError::Unanswered`], what unreachable
/// peers produce). Tests run against this mock or the mock full node in
/// `chia_peer`, never a host.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A chain that never answers: every request is [`ChainError::Unanswered`].
    pub(crate) struct Unanswering;

    fn silence() -> ChainError {
        ChainError::Unanswered(anyhow::anyhow!("nothing listens (test chain)"))
    }

    impl ChainAccess for Unanswering {
        fn coin_records_by_hint(
            &self,
            _hint: Bytes32,
            _start_height: Option<u32>,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn coin_records_by_puzzle_hash(
            &self,
            _puzzle_hash: Bytes32,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn coin_records_by_names(
            &self,
            _names: Vec<Bytes32>,
            _include_spent: bool,
            _cursor: Option<String>,
        ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn puzzle_and_solution(
            &self,
            _coin_id: Bytes32,
            _height: u32,
        ) -> impl Future<Output = Result<Option<PuzzleAndSolution>, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn peak_height(&self) -> impl Future<Output = Result<u32, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn spend_live(&self, _bundle: SpendBundle) -> impl Future<Output = Result<bool, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn push_tx(&self, _bundle: SpendBundle) -> impl Future<Output = Result<(), ChainError>> + Send {
            async { Err(silence()) }
        }
    }

    /// A chain that answers listings from a script: the pages in order,
    /// whatever the key or cursor asked for, then nothing. It keeps whether
    /// each listing asked for spent coins. Everything else is unanswered.
    pub(crate) struct Scripted {
        pages: std::sync::Mutex<std::collections::VecDeque<CoinListing>>,
        pub(crate) asked_spent: std::sync::Mutex<Vec<bool>>,
    }

    impl Scripted {
        pub(crate) fn new(pages: Vec<CoinListing>) -> Self {
            Self { pages: std::sync::Mutex::new(pages.into()), asked_spent: std::sync::Mutex::new(Vec::new()) }
        }

        fn page(&self, include_spent: bool) -> Result<CoinListing, ChainError> {
            self.asked_spent.lock().unwrap().push(include_spent);
            self.pages.lock().unwrap().pop_front().ok_or_else(silence)
        }
    }

    impl ChainAccess for Scripted {
        fn coin_records_by_hint(
            &self,
            _hint: Bytes32,
            _start_height: Option<u32>,
            include_spent: bool,
            _cursor: Option<String>,
        ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
            let page = self.page(include_spent);
            async move { page }
        }

        fn coin_records_by_puzzle_hash(
            &self,
            _puzzle_hash: Bytes32,
            include_spent: bool,
            _cursor: Option<String>,
        ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
            let page = self.page(include_spent);
            async move { page }
        }

        fn coin_records_by_names(
            &self,
            _names: Vec<Bytes32>,
            include_spent: bool,
            _cursor: Option<String>,
        ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
            let page = self.page(include_spent);
            async move { page }
        }

        fn puzzle_and_solution(
            &self,
            _coin_id: Bytes32,
            _height: u32,
        ) -> impl Future<Output = Result<Option<PuzzleAndSolution>, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn peak_height(&self) -> impl Future<Output = Result<u32, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn spend_live(&self, _bundle: SpendBundle) -> impl Future<Output = Result<bool, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn push_tx(&self, _bundle: SpendBundle) -> impl Future<Output = Result<(), ChainError>> + Send {
            async { Err(silence()) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_coin_listed_again_on_a_later_page_keeps_its_later_record() {
        let coin = |seed: u8| Coin::new(Bytes32::new([seed; 32]), Bytes32::new([9u8; 32]), u64::from(seed));
        let rec = |c: Coin, height: u32, spent: Option<u32>| CoinRecord { coin: c, confirmed_block_index: height, spent: spent.is_some(), spent_block_index: spent.unwrap_or(0) };
        let mut gathered = PagedRecords::default();
        gathered.fold(vec![rec(coin(2), 85, None), rec(coin(1), 80, None)]);
        gathered.fold(vec![rec(coin(1), 80, Some(101)), rec(coin(3), 101, None)]);
        let records = gathered.into_records();
        assert_eq!(records.iter().map(|r| (r.coin.amount, r.spent)).collect::<Vec<_>>(), vec![(1, true), (2, false), (3, false)]);
    }

    #[test]
    fn the_two_failures_read_apart() {
        let unanswered = ChainError::Unanswered(anyhow::anyhow!("connection refused"));
        let refused = ChainError::Refused("fee too low".to_string());
        assert_eq!(unanswered.to_string(), "unanswered (connection refused)");
        assert_eq!(refused.to_string(), "refused (fee too low)");
    }

    #[tokio::test]
    async fn the_reader_takes_any_chain_and_treats_silence_as_a_miss() {
        // The call sites are generic over the seam: the resolver's two helpers
        // run against the test chain with no socket opened, and an unanswered
        // chain is a missed beat (`None`) or an error naming the silence.
        let chain = testing::Unanswering;
        assert_eq!(crate::chia_resolve::peak_height(&chain).await, None);
        let err = crate::chia_resolve::fetch_coin_spend(&chain, Bytes32::new([1u8; 32]), 7).await.unwrap_err();
        assert!(err.to_string().contains("unanswered"), "{err}");
    }

    #[test]
    fn the_two_handles_carry_their_trust_without_opening_anything() {
        assert_eq!(connect().trust(), Trust::Agreed);
        assert_eq!(connect_carrier().trust(), Trust::Carrier);
        assert!(describe().contains("testnet11"));
    }
}
