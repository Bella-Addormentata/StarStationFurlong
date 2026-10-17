//! The chain-access seam (#231 P7 / TODO #13 phase 0 — S‑0 step 1).
//!
//! Every chain read and every push the node makes goes through [`ChainAccess`]:
//! the presence reader and the beat watcher (`chia_resolve`, `chia_watch`), the
//! publisher and its wallet lease (`chia_publish`), the faucet dish
//! (`chia_faucet`) and the craps fairness records (`chia_craps_fair`). The one
//! place the node chooses HOW it reaches the chain is [`connect`].
//!
//! Today the only implementation is the testnet11 HTTPS gateway, [`Gateway`]
//! over `chia-sdk-coinset`: the central infrastructure that plan §14 (5) and
//! the TODO item "Remove the coinset.org dependency from the chain lane"
//! retire. S‑0 step 2 adds the peer-protocol implementation behind this same
//! trait and proves it path by path (presence first, then publish, faucet and
//! craps-fair); step 3 deletes [`Gateway`] and `chia-sdk-coinset` leaves
//! `Cargo.toml` (Dorkmo, 2026‑10‑12: removed outright, no fallback). Nothing
//! outside this file names the gateway crate, so that removal touches this
//! file and `Cargo.toml` alone.
//!
//! The trait speaks the node's vocabulary, not the gateway's:
//!   - a LISTING ([`CoinListing`]) is the records found plus whether the source
//!     cut it short and the cursor to continue it with — the two facts every
//!     caller already pages on; a listing cut short with no cursor stays
//!     visible as such (the wallet lease and the wallet read it as incomplete);
//!   - a failure is either [`ChainError::Unanswered`] (transport: the request
//!     may or may not have reached the chain, so a push may be live) or
//!     [`ChainError::Refused`] (the source answered and said no, with its
//!     reason, so a refused push spent nothing). `push_parked` keeps its two
//!     outcomes apart on exactly that distinction (#245 review, round 14).
//!
//! The seam changes no behaviour: every request, parameter and error path maps
//! one to one onto what the call sites did against the gateway client. It only
//! moves the choice of transport into one place.

use std::future::Future;

use chia_protocol::{Bytes32, Coin, CoinSpend, SpendBundle};
use chia_sdk_coinset::{ChiaRpcClient, CoinsetClient, GetCoinRecordsResponse};

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

/// Why a chain request failed.
#[derive(Debug)]
pub enum ChainError {
    /// No answer: a transport failure (a timeout above all). The request may
    /// have reached the chain all the same — a push may be live in the mempool.
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
/// site does today; S‑0 step 2 adds coin-state subscription here when the peer
/// implementation replaces the mempool probe with `TransactionAck` plus a
/// subscription (plan §14 (6)). The write-side operations
/// (`coin_records_by_names`, `coin_in_mempool`, `push_tx`) have callers only in
/// a `chia-publish` build; the trait keeps one shape in both builds so an
/// implementation is written once.
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
    ) -> impl Future<Output = Result<Option<CoinSpend>, ChainError>> + Send;

    /// The height of the chain's current peak.
    fn peak_height(&self) -> impl Future<Output = Result<u32, ChainError>> + Send;

    /// Whether the mempool holds a spend bundle that consumes `coin_id`.
    fn coin_in_mempool(&self, coin_id: Bytes32) -> impl Future<Output = Result<bool, ChainError>> + Send;

    /// Hand `bundle` to the mempool. `Ok` means accepted; [`ChainError::Refused`]
    /// means the source said no and nothing was spent; [`ChainError::Unanswered`]
    /// means the outcome is unknown and the bundle may be live.
    fn push_tx(&self, bundle: SpendBundle) -> impl Future<Output = Result<(), ChainError>> + Send;
}

/// The chain the node reads and writes through today: the testnet11 HTTPS
/// gateway. This alias is what the call sites construct; when S‑0 step 2 lands
/// the peer implementation it points there and nothing else moves.
pub type Chain = Gateway;

/// The node's one construction site for chain access. No I/O happens here: the
/// gateway client opens its connections on the first request.
pub fn connect() -> Chain {
    Gateway { client: CoinsetClient::testnet11() }
}

/// The testnet11 HTTPS gateway (`https://testnet11.api.coinset.org`, pinned in
/// `chia-sdk-coinset`): the implementation S‑0 step 3 deletes. Every method
/// maps the gateway's answer onto the seam's types: a transport error is
/// [`ChainError::Unanswered`], `success: false` is [`ChainError::Refused`] with
/// the gateway's reason (or "no reason given"), except for a puzzle-and-solution
/// lookup, where the gateway says `success: false` for a coin it has no spend
/// for and the answer is `None`.
pub struct Gateway {
    client: CoinsetClient,
}

fn unanswered<E: std::error::Error + Send + Sync + 'static>(e: E) -> ChainError {
    ChainError::Unanswered(anyhow::Error::new(e))
}

fn reason(error: Option<String>) -> String {
    error.unwrap_or_else(|| "no reason given".to_string())
}

fn listing(resp: GetCoinRecordsResponse) -> Result<CoinListing, ChainError> {
    if !resp.success {
        return Err(ChainError::Refused(reason(resp.error)));
    }
    Ok(CoinListing {
        records: resp
            .coin_records
            .unwrap_or_default()
            .into_iter()
            .map(|r| CoinRecord {
                coin: r.coin,
                confirmed_block_index: r.confirmed_block_index,
                spent: r.spent,
                spent_block_index: r.spent_block_index,
            })
            .collect(),
        truncated: resp.truncated.unwrap_or(false),
        next_cursor: resp.next_cursor,
    })
}

impl ChainAccess for Gateway {
    fn coin_records_by_hint(
        &self,
        hint: Bytes32,
        start_height: Option<u32>,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
        async move {
            let resp = self
                .client
                .get_coin_records_by_hint(hint, start_height, None, Some(include_spent), cursor)
                .await
                .map_err(unanswered)?;
            listing(resp)
        }
    }

    fn coin_records_by_puzzle_hash(
        &self,
        puzzle_hash: Bytes32,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
        async move {
            let resp = self
                .client
                .get_coin_records_by_puzzle_hash(puzzle_hash, None, None, Some(include_spent), cursor)
                .await
                .map_err(unanswered)?;
            listing(resp)
        }
    }

    fn coin_records_by_names(
        &self,
        names: Vec<Bytes32>,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
        async move {
            let resp = self
                .client
                .get_coin_records_by_names(names, None, None, Some(include_spent), cursor)
                .await
                .map_err(unanswered)?;
            listing(resp)
        }
    }

    fn puzzle_and_solution(
        &self,
        coin_id: Bytes32,
        height: u32,
    ) -> impl Future<Output = Result<Option<CoinSpend>, ChainError>> + Send {
        async move {
            let resp = self
                .client
                .get_puzzle_and_solution(coin_id, Some(height))
                .await
                .map_err(unanswered)?;
            Ok(if resp.success { resp.coin_solution } else { None })
        }
    }

    fn peak_height(&self) -> impl Future<Output = Result<u32, ChainError>> + Send {
        async move {
            let resp = self.client.get_blockchain_state().await.map_err(unanswered)?;
            if !resp.success {
                return Err(ChainError::Refused(reason(resp.error)));
            }
            resp.blockchain_state
                .map(|s| s.peak.height)
                .ok_or_else(|| ChainError::Refused("a successful answer carried no blockchain state".to_string()))
        }
    }

    fn coin_in_mempool(&self, coin_id: Bytes32) -> impl Future<Output = Result<bool, ChainError>> + Send {
        async move {
            let resp = self
                .client
                .get_mempool_items_by_coin_name(coin_id)
                .await
                .map_err(unanswered)?;
            if !resp.success {
                return Err(ChainError::Refused(reason(resp.error)));
            }
            Ok(resp.mempool_items.is_some_and(|items| !items.is_empty()))
        }
    }

    fn push_tx(&self, bundle: SpendBundle) -> impl Future<Output = Result<(), ChainError>> + Send {
        async move {
            let resp = self.client.push_tx(bundle).await.map_err(unanswered)?;
            if !resp.success {
                return Err(ChainError::Refused(reason(resp.error)));
            }
            Ok(())
        }
    }
}

/// Chains for tests: no socket is ever opened. [`testing::Unanswering`] answers
/// nothing (every request fails as [`ChainError::Unanswered`], what a dead
/// gateway or a timeout produces), the shape S‑0 step 3 keeps when the gateway
/// goes: tests run against a mock or the peer simulator, never a host.
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
        ) -> impl Future<Output = Result<Option<CoinSpend>, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn peak_height(&self) -> impl Future<Output = Result<u32, ChainError>> + Send {
            async { Err(silence()) }
        }

        fn coin_in_mempool(&self, _coin_id: Bytes32) -> impl Future<Output = Result<bool, ChainError>> + Send {
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
    use chia_sdk_coinset::{CoinRecord as GatewayRecord, GetMempoolItemsResponse, GetPuzzleAndSolutionResponse, PushTxResponse};

    fn coin(seed: u8) -> Coin {
        Coin::new(Bytes32::new([seed; 32]), Bytes32::new([seed.wrapping_add(1); 32]), u64::from(seed))
    }

    fn gateway_record(seed: u8, confirmed: u32, spent_at: Option<u32>) -> GatewayRecord {
        GatewayRecord {
            coin: coin(seed),
            coinbase: false,
            confirmed_block_index: confirmed,
            spent: spent_at.is_some(),
            spent_block_index: spent_at.unwrap_or(0),
            timestamp: 1_791_700_000,
        }
    }

    #[test]
    fn a_listing_keeps_the_records_the_cut_and_the_cursor() {
        let resp = GetCoinRecordsResponse {
            coin_records: Some(vec![gateway_record(1, 100, None), gateway_record(2, 90, Some(95))]),
            error: None,
            success: true,
            truncated: Some(true),
            next_cursor: Some("page-2".to_string()),
        };
        let got = listing(resp).unwrap();
        assert_eq!(
            got,
            CoinListing {
                records: vec![
                    CoinRecord { coin: coin(1), confirmed_block_index: 100, spent: false, spent_block_index: 0 },
                    CoinRecord { coin: coin(2), confirmed_block_index: 90, spent: true, spent_block_index: 95 },
                ],
                truncated: true,
                next_cursor: Some("page-2".to_string()),
            }
        );
    }

    #[test]
    fn a_listing_without_records_or_flags_is_complete_and_empty() {
        // A Chia full node answers without `truncated` or a cursor; the gateway
        // leaves `coin_records` out when nothing matched. Both read as a
        // complete, empty listing — what every caller did with the raw answer.
        let resp = GetCoinRecordsResponse { coin_records: None, error: None, success: true, truncated: None, next_cursor: None };
        assert_eq!(listing(resp).unwrap(), CoinListing::default());
    }

    #[test]
    fn a_refusal_carries_the_reason_or_says_none_was_given() {
        let refused = GetCoinRecordsResponse {
            coin_records: None,
            error: Some("hint store unavailable".to_string()),
            success: false,
            truncated: None,
            next_cursor: None,
        };
        match listing(refused) {
            Err(ChainError::Refused(why)) => assert_eq!(why, "hint store unavailable"),
            other => panic!("{other:?}"),
        }
        let silent = GetCoinRecordsResponse { coin_records: None, error: None, success: false, truncated: None, next_cursor: None };
        match listing(silent) {
            Err(ChainError::Refused(why)) => assert_eq!(why, "no reason given"),
            other => panic!("{other:?}"),
        }
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
    fn gateway_answer_shapes_the_seam_relies_on_still_exist() {
        // The three one-field answers the gateway implementation reads: a push,
        // a mempool probe and a puzzle-and-solution lookup. Constructing them
        // here pins the field names the crate exposes.
        let push = PushTxResponse { status: Some("SUCCESS".to_string()), error: None, success: true };
        assert!(push.success);
        let probe = GetMempoolItemsResponse { mempool_items: Some(vec![]), error: None, success: true };
        assert!(!probe.mempool_items.is_some_and(|items| !items.is_empty()), "an empty item list is not 'in the mempool'");
        let spend = GetPuzzleAndSolutionResponse { coin_solution: None, error: Some("not spent".to_string()), success: false };
        assert!(!spend.success && spend.coin_solution.is_none());
    }
}
