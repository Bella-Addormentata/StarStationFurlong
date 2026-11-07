//! The mock chain's own tests (stage 4 design §12): each one goes through the
//! real lane over the wallet protocol, with keyless coins at the open puzzle,
//! so they build with chia-read alone. Each pins one behaviour the model
//! copies from a real full node (the module notes name where from), and ends
//! with no request left unanswered, since an unanswered one would make the
//! lane wait out its request timeout.

use super::*;
use crate::chia_chain::{ChainAccess, ChainError};
use crate::chia_peer::PeerConn;
use crate::chia_peer_lane::{refusal_is_final, PeerLane, Trust};
use crate::chia_strict::OFF_WORDS;

const NET: ChiaNet = ChiaNet::Testnet11;

/// A chain, its two nodes, and a lane on them at both trust levels.
struct Setup {
    chain: MockChain,
    a: MockNode,
    b: MockNode,
    lane: Arc<Lane>,
    money: PeerLane,
    carrier: PeerLane,
}

async fn setup() -> Setup {
    let chain = MockChain::new(NET);
    let (a, b) = chain.pair().await;
    let lane = chain.lane(&a, &b);
    let money = PeerLane::new(lane.clone(), Trust::Agreed);
    let carrier = PeerLane::new(lane.clone(), Trust::Carrier);
    Setup { chain, a, b, lane, money, carrier }
}

fn hint(n: u8) -> Bytes32 {
    Bytes32::new([n; 32])
}

fn memo(hint: Bytes32) -> Vec<Bytes> {
    vec![Bytes::new(hint.to_vec())]
}

/// A spend of `coin` back to the open puzzle at its full amount: fee 0.
fn pass_on(coin: Coin) -> SpendBundle {
    open_spend(coin, &[Cond::CreateCoin(open_puzzle_hash(), coin.amount, vec![])])
}

/// The coin [`pass_on`] creates.
fn passed(coin: Coin) -> Coin {
    Coin::new(coin.coin_id(), open_puzzle_hash(), coin.amount)
}

fn refusal<T: std::fmt::Debug>(result: Result<T, ChainError>) -> String {
    match result {
        Err(ChainError::Refused(why)) => why,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

fn unanswered<T: std::fmt::Debug>(result: Result<T, ChainError>) -> String {
    match result {
        Err(ChainError::Unanswered(why)) => format!("{why:#}"),
        other => panic!("expected no verdict, got {other:?}"),
    }
}

fn kinds(node: &MockNode) -> HashSet<ProtocolMessageTypes> {
    node.seen.lock().unwrap().iter().copied().collect()
}

/// One model answers both nodes, so an agreed read, which fails on any
/// disagreement between them, gets an answer from every method the lane
/// has, and both nodes are asked the same kinds of request.
#[tokio::test]
async fn two_nodes_on_one_chain_agree_on_every_answer_the_lane_asks_for() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let a = s.chain.fund(open, 1000, Some(hint(1)));
    let other = s.chain.fund(open, 500, None);
    s.chain.farm().await;
    let write = open_spend(a, &[Cond::CreateCoin(open, 400, memo(hint(1))), Cond::CreateCoin(hint(9), 600, vec![])]);
    s.money.push_tx(write.clone()).await.unwrap();
    let h = s.chain.farm().await;
    let child = Coin::new(a.coin_id(), open, 400);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    let ids: HashSet<Bytes32> = listed.records.iter().map(|r| r.coin.coin_id()).collect();
    assert_eq!(ids, HashSet::from([a.coin_id(), child.coin_id()]), "the funded coin and the child are both hinted");
    assert_eq!(listed.judged_at, Some(h));
    let at_open = s.money.coin_records_by_puzzle_hash(open, true, None).await.unwrap();
    assert_eq!(at_open.records.len(), 3, "the spent coin, the untouched one and the child");
    let unspent = s.money.coin_records_by_puzzle_hash(open, false, None).await.unwrap();
    assert!(unspent.records.iter().all(|r| !r.spent) && unspent.records.len() == 2);
    let named = s.money.coin_records_by_names(vec![a.coin_id(), other.coin_id(), hint(3)], true, None).await.unwrap();
    assert_eq!(named.records.len(), 2, "the unknown id is left out");
    let spent = named.records.iter().find(|r| r.coin == a).unwrap();
    assert!(spent.spent && spent.spent_block_index == h);
    let spend = s.money.puzzle_and_solution(a.coin_id(), h).await.unwrap().unwrap();
    assert_eq!(spend.solution, write.coin_spends[0].solution);
    assert_eq!(s.money.peak_height().await.unwrap(), h);
    assert!(!s.money.spend_live(write).await.unwrap(), "both nodes call it a double spend now");

    assert_eq!(s.lane.live_count().await, 2);
    assert_eq!(kinds(&s.a), kinds(&s.b), "both nodes were asked the same kinds of request");
    assert!(kinds(&s.a).contains(&ProtocolMessageTypes::SendTransaction));
    assert!(s.chain.unanswered().is_empty());
}

/// The barrier holds both connections to one peak after each block, each
/// stretch of blocks and each reorganisation, so an agreed read straight
/// after any of them agrees, and no peer is let go.
#[tokio::test]
async fn a_peak_both_nodes_announce_is_the_agreed_peak_after_every_block_and_every_reorg() {
    let s = setup().await;
    assert_eq!(s.money.peak_height().await.unwrap(), 0);
    for _ in 0..3 {
        let peak = s.chain.farm().await;
        assert_eq!(s.money.peak_height().await.unwrap(), peak);
        assert_eq!(s.lane.live_count().await, 2);
    }
    let peak = s.chain.farm_blocks(40).await;
    assert_eq!(peak, 43);
    assert_eq!(s.money.peak_height().await.unwrap(), 43);
    let replaced = s.chain.header_hash(41).unwrap();
    let peak = s.chain.reorg(3).await;
    assert_eq!(peak, 44, "a reorganisation of three blocks builds four");
    assert_ne!(s.chain.header_hash(41).unwrap(), replaced, "the blocks above the fork are new");
    assert_eq!(s.money.peak_height().await.unwrap(), 44);
    assert_eq!(s.carrier.peak_height().await.unwrap(), 44);
    assert_eq!(s.lane.live_count().await, 2, "neither node was let go");
    assert!(s.chain.unanswered().is_empty());
}

/// A coin a bundle creates and spends at once is kept, created and spent at
/// one height, and every lookup finds it: by id, at its puzzle hash, under
/// its hint, its spend at that height, and as its parent's child.
#[tokio::test]
async fn a_coin_created_and_spent_in_one_block_is_found_by_id_by_puzzle_hash_by_its_parent_and_by_its_spend() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let a = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let b = Coin::new(a.coin_id(), open, 1000);
    let c = Coin::new(b.coin_id(), open, 1000);
    let b_spend = open_coin_spend(b, &[Cond::CreateCoin(open, 1000, vec![])]);
    let bundle = SpendBundle::new(
        vec![open_coin_spend(a, &[Cond::CreateCoin(open, 1000, memo(hint(4)))]), b_spend.clone()],
        chia_bls::Signature::default(),
    );
    s.money.push_tx(bundle).await.unwrap();
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(b.coin_id()), Some((b, h, Some(h))));

    let named = s.money.coin_records_by_names(vec![b.coin_id()], true, None).await.unwrap();
    assert_eq!(named.records.len(), 1);
    assert_eq!((named.records[0].confirmed_block_index, named.records[0].spent_block_index), (h, h));
    let at_open = s.money.coin_records_by_puzzle_hash(open, true, None).await.unwrap();
    let ids: HashSet<Bytes32> = at_open.records.iter().map(|r| r.coin.coin_id()).collect();
    assert_eq!(ids, HashSet::from([a.coin_id(), b.coin_id(), c.coin_id()]));
    let hinted = s.money.coin_records_by_hint(hint(4), None, true, None).await.unwrap();
    assert_eq!(hinted.records.iter().map(|r| r.coin).collect::<Vec<_>>(), vec![b]);
    let spend = s.money.puzzle_and_solution(b.coin_id(), h).await.unwrap().expect("the ephemeral coin's spend");
    assert_eq!((spend.puzzle_reveal, spend.solution), (b_spend.puzzle_reveal, b_spend.solution));
    assert_eq!(s.money.puzzle_and_solution(b.coin_id(), h - 1).await.unwrap(), None, "no spend of it at another height");

    // No reader of the node's asks for a coin's children yet; a full node
    // answers it all the same, and so does the model.
    let conn = PeerConn::connect(s.a.addr, Source::Introducer, &s.chain.network(), TLS.clone()).await.unwrap();
    let children = conn.request::<RespondChildren, _>(RequestChildren::new(a.coin_id())).await.unwrap();
    assert_eq!(children.coin_states, vec![CoinState::new(b, Some(h), Some(h))]);
    assert_eq!(s.chain.children(a.coin_id()), vec![b]);
    assert!(s.chain.unanswered().is_empty());
}

/// The §12 switch: a full mempool refuses fee 0 as too close to zero (not a
/// final word: the bundle is fine), takes a bundle that pays, and takes the
/// same fee-0 bundle once it is no longer full. Nothing adds a fee.
#[tokio::test]
async fn a_full_mempool_refuses_fee_zero_and_takes_the_same_bundle_once_cleared() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    let rich = s.chain.fund(open, 1_000_000_000, None);
    s.chain.farm().await;
    let write = pass_on(coin);

    s.chain.set_full(true);
    let why = refusal(s.money.push_tx(write.clone()).await);
    assert!(why.contains("INVALID_FEE_TOO_CLOSE_TO_ZERO"), "{why}");
    assert!(!refusal_is_final(&why));
    unanswered(s.money.spend_live(write.clone()).await);
    assert!(s.chain.mempool().is_empty());
    let paying = open_spend(rich, &[Cond::CreateCoin(open, rich.amount - 500_000_000, vec![])]);
    s.money.push_tx(paying.clone()).await.expect("a bundle paying over the minimum is taken while full");

    s.chain.set_full(false);
    s.money.push_tx(write.clone()).await.unwrap();
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h));
    assert_eq!(s.chain.record(rich.coin_id()).unwrap().2, Some(h));
    for sent in s.chain.received() {
        if sent.name() == write.name() {
            assert_eq!(s.chain.fee_of(&sent), 0);
        } else {
            assert_eq!(sent.name(), paying.name());
            assert_eq!(s.chain.fee_of(&sent), 500_000_000);
        }
    }
    assert!(s.chain.unanswered().is_empty());
}

/// An input the chain does not know is UNKNOWN_UNSPENT, not final (a node
/// behind the input's block says so of a live spend); a spent one is a
/// DOUBLE_SPEND, final; a second bundle on a coin a mempool item spends
/// waits as a MEMPOOL_CONFLICT, accepted, and never lands at fee 0.
#[tokio::test]
async fn an_input_the_chain_does_not_know_is_unknown_unspent_and_a_spent_one_a_double_spend() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let stranger = Coin::new(hint(5), open, 10);
    let why = refusal(s.money.push_tx(pass_on(stranger)).await);
    assert!(why.contains("UNKNOWN_UNSPENT") && !refusal_is_final(&why), "{why}");
    unanswered(s.money.spend_live(pass_on(stranger)).await);

    let coin = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let first = pass_on(coin);
    let second = open_spend(coin, &[Cond::CreateCoin(hint(6), coin.amount, vec![])]);
    s.money.push_tx(first.clone()).await.unwrap();
    s.money.push_tx(second.clone()).await.expect("a conflicting bundle waits, accepted");
    assert_eq!(s.chain.acks_for(second.name()), vec![(PENDING, Some("MEMPOOL_CONFLICT".to_string())); 2]);
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(passed(coin).coin_id()).map(|r| r.1), Some(h));
    assert_eq!(s.chain.record(Coin::new(coin.coin_id(), hint(6), coin.amount).coin_id()), None, "the conflicting bundle did not land");

    let why = refusal(s.money.push_tx(second.clone()).await);
    assert!(why.contains("DOUBLE_SPEND") && refusal_is_final(&why), "{why}");
    assert!(!s.money.spend_live(second).await.unwrap());
    assert!(!s.money.spend_live(first).await.unwrap(), "a bundle that landed is a double spend if pushed again");
    assert!(s.chain.unanswered().is_empty());
}

/// A height lock not yet passed puts the bundle in the pending cache
/// (accepted), a second send while it waits is pending again rather than
/// already seen, an eviction from the mempool leaves the pending cache alone,
/// and the bundle enters the mempool at the block where its lock first
/// passes against the peak, and lands in the block after.
#[tokio::test]
async fn a_height_locked_spend_waits_in_the_pending_cache_and_lands_the_block_after_its_lock_passes() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    let created = s.chain.farm().await;
    let locked = open_spend(coin, &[Cond::AssertHeightRelative(5), Cond::CreateCoin(open, 1000, vec![])]);
    s.money.push_tx(locked.clone()).await.unwrap();
    s.money.push_tx(locked.clone()).await.unwrap();
    assert_eq!(s.chain.acks_for(locked.name()), vec![(PENDING, Some("ASSERT_HEIGHT_RELATIVE_FAILED".to_string())); 4]);
    s.chain.evict_all();

    s.chain.farm_to(created + 4).await;
    assert!(s.chain.mempool().is_empty(), "still pending at {}", s.chain.peak());
    s.chain.farm().await;
    assert_eq!(s.chain.mempool(), vec![locked.name()], "taken in once the peak is five blocks past the coin");
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None);
    let h = s.chain.farm().await;
    assert_eq!(h, created + 6);
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h));
    assert!(s.chain.unanswered().is_empty());
}

/// A reorganisation undoes the blocks above the fork: the spend there is
/// undone, the coin it created is gone, the header at its height is new,
/// and its bundle is in no mempool; pushed again, the bundle lands on the
/// new fork.
#[tokio::test]
async fn a_reorg_drops_its_blocks_spends_and_coins_and_the_bundle_lands_when_pushed_again() {
    let s = setup().await;
    let coin = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let write = pass_on(coin);
    s.money.push_tx(write.clone()).await.unwrap();
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h));
    let old = s.chain.header_hash(h).unwrap();

    assert_eq!(s.chain.reorg(1).await, h + 1);
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None, "the spend is undone");
    assert_eq!(s.chain.record(passed(coin).coin_id()), None, "its child is gone");
    assert_ne!(s.chain.header_hash(h).unwrap(), old);
    assert!(s.chain.mempool().is_empty(), "no node gives the dropped bundle back to its mempool");
    let named = s.money.coin_records_by_names(vec![coin.coin_id(), passed(coin).coin_id()], true, None).await.unwrap();
    assert_eq!(named.records.len(), 1);
    assert!(!named.records[0].spent);
    assert_eq!(named.judged_at, Some(h + 1));

    s.money.push_tx(write).await.unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(landed, h + 2);
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h + 2));
    assert!(s.chain.unanswered().is_empty());
}

/// A listing's cursor carries the header its pages were judged under; once
/// a reorganisation replaced that header, the cursor is refused and the
/// listing starts over, and a fresh listing shows only what is left.
#[tokio::test]
async fn a_cursor_from_before_a_reorg_is_refused_and_the_listing_starts_over() {
    let s = setup().await;
    s.chain.set_page_limit(1);
    let mut coins = Vec::new();
    for amount in 1..=3 {
        coins.push(s.chain.fund(open_puzzle_hash(), amount, Some(hint(7))));
        s.chain.farm().await;
    }
    let first = s.money.coin_records_by_hint(hint(7), None, true, None).await.unwrap();
    assert!(first.truncated);
    assert_eq!(first.records.iter().map(|r| r.coin).collect::<Vec<_>>(), vec![coins[0]]);
    let cursor = first.next_cursor.expect("a cursor");

    s.chain.reorg(2).await;
    let why = refusal(s.money.coin_records_by_hint(hint(7), None, true, Some(cursor)).await);
    assert!(why.contains("reorganised"), "{why}");
    let again = s.money.coin_records_by_hint(hint(7), None, true, None).await.unwrap();
    assert!(!again.truncated);
    assert_eq!(again.records.iter().map(|r| r.coin).collect::<Vec<_>>(), vec![coins[0]]);
    assert!(s.chain.unanswered().is_empty());
}

/// A page holds at most the item limit and never part of a block: the
/// first stops at the last whole block, the cursor carries on, and the
/// listing ends with every coin, none twice. A coin-state lookup longer than
/// the limit is answered in rounds, the ids answered for echoed each time.
#[tokio::test]
async fn a_listing_longer_than_a_page_is_cut_at_a_block_and_continued_by_its_cursor() {
    let s = setup().await;
    s.chain.set_page_limit(3);
    let open = open_puzzle_hash();
    let mut coins = vec![s.chain.fund(open, 1, None), s.chain.fund(open, 2, None)];
    s.chain.farm().await;
    coins.extend([s.chain.fund(open, 3, None), s.chain.fund(open, 4, None), s.chain.fund(open, 5, None)]);
    s.chain.farm().await;

    let first = s.money.coin_records_by_puzzle_hash(open, true, None).await.unwrap();
    assert!(first.truncated);
    assert_eq!(first.records.len(), 2, "block 1 whole; block 2 would not fit beside it");
    assert!(first.records.iter().all(|r| r.confirmed_block_index == 1));
    let rest = s.money.coin_records_by_puzzle_hash(open, true, first.next_cursor.clone()).await.unwrap();
    assert!(!rest.truncated);
    assert_eq!(rest.records.len(), 3);
    let mut all: Vec<Coin> = first.records.iter().chain(&rest.records).map(|r| r.coin).collect();
    all.sort_by_key(|c| c.amount);
    assert_eq!(all, coins);

    let named = s.money.coin_records_by_names(coins.iter().map(Coin::coin_id).collect(), true, None).await.unwrap();
    assert!(!named.truncated);
    assert_eq!(named.records.len(), 5, "five ids at three a round");
    assert!(s.chain.unanswered().is_empty());
}

/// A block holding more coins than a page is never split, so a full node
/// answers a page with none of it, dated by the block before: the listing
/// stays truncated and its cursor makes no progress. This is what a full
/// node does; the lane's readers bound their pages and stop there.
#[tokio::test]
async fn a_block_holding_more_coins_than_a_page_gives_a_page_that_makes_no_progress() {
    let s = setup().await;
    s.chain.set_page_limit(2);
    let open = open_puzzle_hash();
    for amount in 1..=3 {
        s.chain.fund(open, amount, None);
    }
    s.chain.farm().await;
    let first = s.money.coin_records_by_puzzle_hash(open, true, None).await.unwrap();
    assert!(first.truncated && first.records.is_empty(), "{first:?}");
    let next = s.money.coin_records_by_puzzle_hash(open, true, first.next_cursor.clone()).await.unwrap();
    assert!(next.truncated && next.records.is_empty(), "{next:?}");
    assert_eq!(next.next_cursor, first.next_cursor, "the cursor stands still");
    assert!(s.chain.unanswered().is_empty());
}

/// What pre-validation refuses is refused by the name a full node gives it,
/// each final; the bundle is then remembered as seen, so a second send of it
/// is ALREADY_INCLUDING_TRANSACTION, which is not final.
#[tokio::test]
async fn a_bundle_refused_before_it_is_judged_carries_its_chia_error_name_and_is_already_seen_after() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let solution = open_coin_spend(coin, &[Cond::CreateCoin(open, 1000, vec![])]).solution;

    // `(q)` runs to no conditions, and does not hash to the coin's puzzle.
    let wrong_puzzle = SpendBundle::new(vec![CoinSpend::new(coin, Program::from(vec![0xff, 0x01, 0x80]), solution)], chia_bls::Signature::default());
    let key = Bytes::new(chia_bls::SecretKey::from_seed(&[9u8; 32]).public_key().to_bytes().to_vec());
    let unsigned = open_spend(coin, &[Cond::AggSigMe(key, Bytes::new(b"hello".to_vec())), Cond::CreateCoin(open, 1000, vec![])]);
    let elsewhere = open_spend(coin, &[Cond::AssertMyPuzzleHash(hint(8)), Cond::CreateCoin(open, 1000, vec![])]);
    let mut a = clvmr::Allocator::new();
    let huge = a.new_atom(&vec![0u8; 500_000]).unwrap();
    let huge = Program::from(clvmr::serde::node_to_bytes(&a, huge).unwrap());
    let too_costly = SpendBundle::new(vec![CoinSpend::new(coin, Program::from(vec![1u8]), huge)], chia_bls::Signature::default());

    for (bundle, name) in [
        (wrong_puzzle.clone(), "WRONG_PUZZLE_HASH"),
        (unsigned, "BAD_AGGREGATE_SIGNATURE"),
        (elsewhere, "ASSERT_MY_PUZZLEHASH_FAILED"),
        (too_costly, "BLOCK_COST_EXCEEDS_MAX"),
    ] {
        let why = refusal(s.money.push_tx(bundle.clone()).await);
        assert!(why.contains(name) && refusal_is_final(&why), "{name}: {why}");
        assert_eq!(s.chain.acks_for(bundle.name()), vec![(FAILED, Some(name.to_string())); 2]);
    }
    let why = refusal(s.money.push_tx(wrong_puzzle.clone()).await);
    assert!(why.contains("ALREADY_INCLUDING_TRANSACTION") && !refusal_is_final(&why), "{why}");
    unanswered(s.money.spend_live(wrong_puzzle).await);
    // A gap on main, outside this test-only module: `refusal_is_final` lists
    // ASSERT_COIN_ANNOUNCEMENT_FAILED and ASSERT_PUZZLE_ANNOUNCEMENT_FAILED,
    // which no full node sends, and not ASSERT_ANNOUNCE_CONSUMED_FAILED, which
    // every one does. So a bundle whose announcement assertion fails reads as
    // no verdict, not dead, and the lease keeps probing it. Until a change to
    // the lane adds the real name (and makes this assert that it is final), a
    // writer that ties two spends by an announcement (PR 9's claim and write)
    // must not count on that refusal to kill a bundle built wrong.
    assert_eq!(
        err_name(ErrorCode::AssertCoinAnnouncementFailed),
        "ASSERT_ANNOUNCE_CONSUMED_FAILED",
        "chia_rs folds both announcement assertions into Chia's code 12"
    );
    assert!(s.chain.unanswered().is_empty());
}

/// A lane closed from the start and a seeded lane closed before its first
/// read both refuse every method with the off words, and neither node is
/// ever dialled or asked anything.
#[tokio::test]
async fn a_closed_lane_dials_neither_node_and_neither_sees_a_request() {
    let s = setup().await;
    let coin = s.chain.fund(open_puzzle_hash(), 1000, None);
    let off = Arc::new(Lane::closed(s.chain.network(), "the mock chain's test"));
    s.lane.close().await;
    for lane in [off, s.lane.clone()] {
        let money = PeerLane::new(lane, Trust::Agreed);
        assert!(refusal(money.coin_records_by_hint(hint(1), None, true, None).await).contains(OFF_WORDS));
        assert!(refusal(money.coin_records_by_puzzle_hash(open_puzzle_hash(), true, None).await).contains(OFF_WORDS));
        assert!(refusal(money.coin_records_by_names(vec![coin.coin_id()], true, None).await).contains(OFF_WORDS));
        assert!(refusal(money.puzzle_and_solution(coin.coin_id(), 1).await).contains(OFF_WORDS));
        assert!(refusal(money.peak_height().await).contains(OFF_WORDS));
        assert!(refusal(money.spend_live(pass_on(coin)).await).contains(OFF_WORDS));
        assert!(refusal(money.push_tx(pass_on(coin)).await).contains(OFF_WORDS));
    }
    assert!(refusal(s.carrier.peak_height().await).contains(OFF_WORDS));
    assert_eq!(s.chain.connections(), 0);
    assert!(s.a.seen.lock().unwrap().is_empty() && s.b.seen.lock().unwrap().is_empty());
    assert!(s.chain.received().is_empty());
}

/// A node held back while the chain reorganises announces the old fork's
/// header at a height where the other serves the new fork's: the lane
/// calls the peak non-final and lets both go, as it does real peers that
/// disagree.
#[tokio::test]
async fn a_node_held_back_through_a_reorg_disagrees_on_the_peak_header_and_the_lane_lets_both_go() {
    let s = setup().await;
    s.chain.farm_blocks(2).await;
    assert_eq!(s.money.peak_height().await.unwrap(), 2);
    s.chain.hold(&s.b);
    s.chain.reorg(1).await;
    let why = unanswered(s.money.peak_height().await);
    assert!(why.contains("disagree"), "{why}");
    assert_eq!(s.lane.live_count().await, 0, "both peers were let go");
    assert!(s.chain.unanswered().is_empty());
}

/// Two nodes judge a bundle each by its own mempool and its own view of the
/// chain. One refusing for load while the other takes it is accepted and
/// live; one calling it a double spend while the other, a block behind,
/// refuses it for load is no verdict at all; once both see the spend, it is
/// dead.
#[tokio::test]
async fn two_nodes_judge_a_bundle_apart_and_only_a_final_word_from_both_kills_it() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    let later = s.chain.fund(open, 2000, None);
    s.chain.farm().await;

    s.chain.set_full_on(&s.a, true);
    let write = pass_on(coin);
    s.money.push_tx(write.clone()).await.expect("one node took it");
    assert!(s.chain.mempool_on(&s.a).is_empty());
    assert_eq!(s.chain.mempool_on(&s.b), vec![write.name()]);
    assert!(s.money.spend_live(write.clone()).await.unwrap());
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h), "a block takes from every node's mempool");
    s.chain.set_full_on(&s.a, false);

    let ours = pass_on(later);
    s.chain.hold(&s.b);
    s.chain.include_next(open_spend(later, &[Cond::CreateCoin(hint(2), later.amount, vec![])]));
    s.chain.farm().await;
    s.chain.set_full_on(&s.b, true);
    unanswered(s.money.spend_live(ours.clone()).await);
    let acks = s.chain.acks_for(ours.name());
    assert!(acks.contains(&(FAILED, Some("DOUBLE_SPEND".to_string()))));
    assert!(acks.contains(&(FAILED, Some("INVALID_FEE_TOO_CLOSE_TO_ZERO".to_string()))));

    s.chain.release(&s.b).await;
    s.chain.set_full_on(&s.b, false);
    assert!(!s.money.spend_live(ours).await.unwrap(), "both see the other spend now");
    assert!(s.chain.unanswered().is_empty());
}

/// A node remembers a bundle it took after the mempool lets it go, and
/// answers it ALREADY_INCLUDING_TRANSACTION (not final) until the name
/// leaves its seen cache. A bundle sent again while in the mempool leaves the
/// seen cache there and then, so once evicted it is taken again at once.
#[tokio::test]
async fn the_seen_cache_answers_an_evicted_bundle_already_including_until_it_forgets_it() {
    let s = setup().await;
    let coin = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let write = pass_on(coin);
    s.money.push_tx(write.clone()).await.unwrap();
    s.chain.evict_all();
    let why = refusal(s.money.push_tx(write.clone()).await);
    assert!(why.contains("ALREADY_INCLUDING_TRANSACTION") && !refusal_is_final(&why), "{why}");
    unanswered(s.money.spend_live(write.clone()).await);

    s.chain.forget_seen();
    s.money.push_tx(write.clone()).await.unwrap();
    assert!(s.money.spend_live(write.clone()).await.unwrap(), "in the mempool: SUCCESS, and out of the seen cache");
    s.chain.evict_all();
    s.money.push_tx(write.clone()).await.expect("taken again: the seen cache let it go when it was sent again");
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h));
    assert_eq!(s.chain.children(coin.coin_id()).len(), 1);
    assert!(s.chain.unanswered().is_empty());
}

/// A coin's id is its parent, puzzle hash and amount, not its memo, so a new
/// fork that spends the parent the same way with another memo makes the same
/// coin with another hint. A full node keeps every hint row it ever added
/// (`hint_store.py` deletes none, and a reorganisation rolls back only the
/// coin and block stores), and finds hinted coins through the coin records
/// (`batch_coin_states_by_puzzle_hashes`): the coin is listed under both
/// hints, once each, as the new fork made it, and a row whose coin the
/// reorganisation dropped and nothing made again lists nothing.
#[tokio::test]
async fn a_coin_made_again_on_a_new_fork_with_another_hint_is_listed_under_both_as_a_full_node_lists_it() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    let other = s.chain.fund(open, 500, None);
    s.chain.farm_blocks(2).await;
    let child = Coin::new(parent.coin_id(), open, 1000);
    let dropped = Coin::new(other.coin_id(), open, 500);
    let old = SpendBundle::new(
        vec![
            open_coin_spend(parent, &[Cond::CreateCoin(open, 1000, memo(hint(1)))]),
            open_coin_spend(other, &[Cond::CreateCoin(open, 500, memo(hint(3)))]),
        ],
        chia_bls::Signature::default(),
    );
    s.money.push_tx(old.clone()).await.unwrap();
    let first = s.chain.farm().await;
    assert_eq!(s.chain.children(parent.coin_id()), vec![child]);
    for (h, coin) in [(hint(1), child), (hint(3), dropped)] {
        let listed = s.money.coin_records_by_hint(h, None, true, None).await.unwrap();
        assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(coin, first)]);
    }

    // The new fork starts a block lower, so the coin is made at another height.
    let again = open_spend(parent, &[Cond::CreateCoin(open, 1000, memo(hint(2)))]);
    let peak = s.chain.reorg_including(2, vec![again.clone()]).await;
    let made = first - 1;
    assert_eq!(peak, first + 1);
    assert_eq!(s.chain.children(parent.coin_id()), vec![child], "the same coin id, made again");
    assert_eq!(s.chain.record(child.coin_id()), Some((child, made, None)));
    assert_eq!(s.chain.record(dropped.coin_id()), None, "nothing made the other child again");
    for (h, which) in [(hint(1), "the old fork's hint"), (hint(2), "the new fork's hint")] {
        let listed = s.money.coin_records_by_hint(h, None, true, None).await.unwrap();
        let found: Vec<(Coin, u32, bool)> = listed.records.iter().map(|r| (r.coin, r.confirmed_block_index, r.spent)).collect();
        assert_eq!(found, vec![(child, made, false)], "under {which}: once, as the new fork made it");
        assert!(!listed.truncated);
        assert_eq!(listed.judged_at, Some(peak));
    }
    let spend = s.money.puzzle_and_solution(parent.coin_id(), made).await.unwrap().expect("the new fork's spend");
    assert_eq!(spend.solution, again.coin_spends[0].solution, "the parent's spend carries the new memo");
    assert_ne!(spend.solution, old.coin_spends[0].solution);
    assert_eq!(s.money.puzzle_and_solution(parent.coin_id(), first).await.unwrap(), None, "no spend at the old fork's height");
    let gone = s.money.coin_records_by_hint(hint(3), None, true, None).await.unwrap();
    assert!(gone.records.is_empty() && !gone.truncated, "a hint row whose coin is off the chain lists nothing: {gone:?}");

    assert_eq!(s.lane.live_count().await, 2, "both nodes agreed on every answer");
    assert_eq!(kinds(&s.a), kinds(&s.b));
    assert!(s.chain.unanswered().is_empty());
}

/// Each node keeps the hint table of the blocks it took. A node held while
/// the old fork's block came and went, then released onto the new fork,
/// adds the rows of the blocks above the fork point, as a full node taking
/// the new peak adds those of the blocks since the fork, and never the old
/// fork's. Under the new hint both nodes list the coin and agree; under the
/// old one only the node that took the old fork does, so an agreed listing
/// there has no answer, as one from two real nodes with those histories has
/// none.
#[tokio::test]
async fn a_node_held_through_the_old_fork_never_gets_its_hint_row_so_only_the_other_lists_the_coin_under_it() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let child = Coin::new(parent.coin_id(), open, 1000);
    s.chain.hold(&s.b);
    s.chain.include_next(open_spend(parent, &[Cond::CreateCoin(open, 1000, memo(hint(1)))]));
    s.chain.farm().await;
    let peak = s.chain.reorg_including(1, vec![open_spend(parent, &[Cond::CreateCoin(open, 1000, memo(hint(2)))])]).await;
    s.chain.release(&s.b).await;
    let made = peak - 1;
    assert_eq!(s.chain.record(child.coin_id()), Some((child, made, None)));

    let network = s.chain.network();
    let filters = chia_protocol::CoinStateFilters::new(true, true, true, 0);
    for (node, under_old) in [(&s.a, vec![CoinState::new(child, None, Some(made))]), (&s.b, vec![])] {
        let conn = PeerConn::connect(node.addr, Source::Introducer, &network, TLS.clone()).await.unwrap();
        for (h, expected) in [(hint(2), vec![CoinState::new(child, None, Some(made))]), (hint(1), under_old.clone())] {
            let asked = RequestPuzzleState::new(vec![h], None, network.genesis, filters.clone(), false);
            let answer = conn.request::<RespondPuzzleState, _>(asked).await.unwrap();
            assert_eq!((answer.coin_states, answer.height, answer.is_finished), (expected, peak, true));
        }
    }

    let listed = s.money.coin_records_by_hint(hint(2), None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| r.coin).collect::<Vec<_>>(), vec![child], "both nodes list it under the new hint");
    unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(s.chain.unanswered().is_empty());
}

/// A node held after it took the old fork's block keeps that block's hint
/// row when it is released onto the new fork (on the slow path, from the
/// fork point it shares with the chain it held) and adds the new fork's
/// beside it: like the node never held, it lists the coin under both hints,
/// as the new fork made it, so an agreed listing under either has an
/// answer. A node brought up now takes the rows of the chain as it stands,
/// as a node syncing it does, so it lists the coin under the new hint
/// alone; and a request that leaves hinted coins out lists none under
/// either.
#[tokio::test]
async fn a_node_held_after_it_took_the_old_fork_keeps_its_hint_row_when_released_onto_the_new_one() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm_blocks(2).await;
    let child = Coin::new(parent.coin_id(), open, 1000);
    s.chain.include_next(open_spend(parent, &[Cond::CreateCoin(open, 1000, memo(hint(1)))]));
    let first = s.chain.farm().await;
    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    let found: Vec<(Coin, u32)> = listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect();
    assert_eq!(found, vec![(child, first)], "both nodes took the old fork's block");

    s.chain.hold(&s.b);
    let peak = s.chain.reorg_including(2, vec![open_spend(parent, &[Cond::CreateCoin(open, 1000, memo(hint(2)))])]).await;
    s.chain.release(&s.b).await;
    let made = first - 1;
    assert_eq!(peak, first + 1);
    assert_eq!(s.chain.record(child.coin_id()), Some((child, made, None)), "the same coin, made again lower");

    for (h, which) in [(hint(1), "the old fork's hint"), (hint(2), "the new fork's hint")] {
        let listed = s.money.coin_records_by_hint(h, None, true, None).await.unwrap();
        let found: Vec<(Coin, u32, bool)> = listed.records.iter().map(|r| (r.coin, r.confirmed_block_index, r.spent)).collect();
        assert_eq!(found, vec![(child, made, false)], "under {which}: both nodes list it, as the new fork made it");
        assert_eq!(listed.judged_at, Some(peak));
    }
    assert_eq!(s.lane.live_count().await, 2, "both nodes agreed on every answer");

    let network = s.chain.network();
    let late = s.chain.node().await;
    let now = vec![CoinState::new(child, None, Some(made))];
    let hinted = chia_protocol::CoinStateFilters::new(true, true, true, 0);
    let unhinted = chia_protocol::CoinStateFilters::new(true, true, false, 0);
    for (node, under_old, which) in [(&s.a, now.clone(), "a, never held"), (&s.b, now.clone(), "b, held and released"), (&late, vec![], "a node brought up now")] {
        let conn = PeerConn::connect(node.addr, Source::Introducer, &network, TLS.clone()).await.unwrap();
        for (h, filters, expected) in
            [(hint(2), &hinted, now.clone()), (hint(1), &hinted, under_old), (hint(2), &unhinted, vec![]), (hint(1), &unhinted, vec![])]
        {
            let asked = RequestPuzzleState::new(vec![h], None, network.genesis, filters.clone(), false);
            let answer = conn.request::<RespondPuzzleState, _>(asked).await.unwrap();
            assert_eq!((answer.coin_states, answer.height, answer.is_finished), (expected, peak, true), "{which}, {filters:?}");
        }
    }
    assert!(s.chain.unanswered().is_empty());
}
