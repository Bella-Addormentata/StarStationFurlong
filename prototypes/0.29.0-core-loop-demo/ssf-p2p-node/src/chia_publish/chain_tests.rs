//! The writers and readers on main, end to end on the mock chain (stage 4
//! design §12, §13 row 8, §14 (5)): each write is built by the builder the
//! writers use, pushed through the wallet lease, carried by the real lane to
//! two mock full nodes that answer from one model, and read back by the
//! resolver's own readers. The lease is reconciled at instants the test
//! moves forward by twice its grace, so nothing waits on the wall clock. A
//! write's standing is judged by [`write_standing_on`], the lookup behind the
//! knock and beacon verdicts, on the test's lease and network.
//!
//! The lease's three entry points that take a payer (stage 4 design §4.4)
//! are named in one helper each ([`push`], [`park`], [`restore`]), so a
//! change to their signatures changes those three bodies and nothing else.
//!
//! What has no seam on main is left for the stage 4 rows that add it, under
//! the names they will carry: a claim and write built as one spend
//! (`a_claim_and_write_lands_and_the_resolver_opens_the_record_through_the_ephemeral_parent`,
//! `a_reorg_that_gives_the_dish_coin_to_another_claimer_has_the_write_built_again_from_another_coin`,
//! `a_full_mempool_holds_a_claim_and_write_and_it_lands_once_cleared_with_no_fee_added`)
//! and the burner wallets
//! (`a_rewrite_spends_the_listing_burners_coin_and_the_next_era_writes_from_the_next_burner`,
//! `a_knock_from_its_own_burner_opens_for_the_host_only`,
//! `a_spend_of_our_burner_the_lease_never_parked_pauses_listing_for_two_hours`).
//! Here a claim and a write are aggregated by hand, which is what those rows
//! will build.

use super::*;
use std::sync::Arc;

use chia_protocol::Program;

use crate::chia_faucet::{claim_solution, FaucetParams, GAP_BLOCKS, GIFT_MOJOS};
use crate::chia_knock::SETTLED_DEPTH;
use crate::chia_peer::mock::chain::{MockChain, FAILED};
use crate::chia_peer::mock::MockNode;
use crate::chia_peer_lane::{Lane, PeerLane, Trust};
use crate::chia_resolve::{child_under_hint, extract_ciphertext, memo_digest, read_ck, read_inbox, spent_heights, unix_now, HintChild, WriteStanding};
use chia_protocol::ProtocolMessageTypes;

const NET: crate::chia_network::ChiaNet = crate::chia_network::ChiaNet::Testnet11;

/// The contact key the presence writes are sealed under.
const CK: [u8; 32] = [21; 32];

/// The room every knock here is for, and its key.
const ROOM: &str = "r";
const ROOM_KEY: [u8; 32] = [23; 32];

/// A chain, its two nodes, a lane on them at both trust levels, a wallet
/// lease with no file, and the instant the lease is next reconciled at.
struct Setup {
    chain: MockChain,
    a: MockNode,
    b: MockNode,
    lane: Arc<Lane>,
    money: PeerLane,
    carrier: PeerLane,
    lease: WalletLease,
    clock: Instant,
}

async fn setup() -> Setup {
    let chain = MockChain::new(NET);
    let (a, b) = chain.pair().await;
    let lane = chain.lane(&a, &b);
    let money = PeerLane::new(lane.clone(), Trust::Agreed);
    let carrier = PeerLane::new(lane.clone(), Trust::Carrier);
    Setup { chain, a, b, lane, money, carrier, lease: WalletLease::new(), clock: Instant::now() }
}

/// A write pushed as every writer pushes it ([`push_parked_with`]): its
/// inputs parked first, each with the height its coin was seen at, under the
/// payer `payer` is, the key that signs it.
async fn push(lease: &WalletLease, money: &PeerLane, payer: &SecretKey, bundle: &SpendBundle, inputs: &[(Bytes32, u32)]) -> Result<(), PushError> {
    push_parked_with(lease, money, Payer::of(payer), bundle.clone(), inputs.iter().copied()).await
}

/// A write parked with its bundle, as [`push_parked_with`] parks it, whose
/// push never left (a stop between the two).
fn park(lease: &WalletLease, payer: &SecretKey, bundle: &SpendBundle, inputs: &[(Bytes32, u32)]) {
    lease.park_with_bundle(inputs.iter().copied(), bundle, Payer::of(payer)).expect("the lease parks it");
}

/// The lease of the wallet `payer` is, restored from `path` as that wallet
/// loads.
fn restore(lease: &WalletLease, path: &std::path::Path, payer: &SecretKey) {
    lease.restore(path, Payer::of(payer));
}

/// A directory of the test's own, removed when it is dropped, a failed
/// assertion included.
struct Dir(std::path::PathBuf);

impl Dir {
    fn new(tag: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("ssf-mock-chain-{tag}-{}-{}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        Self(dir)
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

impl Setup {
    /// Twice the grace past the last reconciliation: every spend parked
    /// before it, or parked again by it, is due.
    fn later(&mut self) -> Instant {
        self.clock += RECONCILE_GRACE * 2;
        self.clock
    }

    /// A write of `payer`'s pushed through the test's lease ([`push`]).
    async fn push(&self, payer: &SecretKey, bundle: &SpendBundle, input: (Bytes32, u32)) -> Result<(), PushError> {
        push(&self.lease, &self.money, payer, bundle, &[input]).await
    }

    async fn reconcile(&mut self) {
        let at = self.later();
        self.lease.reconcile_at(NET, &self.money, at).await;
    }

    /// A write's standing as the knock and beacon verdicts take it: the
    /// lease reconciled once the grace has passed, then [`write_standing_on`],
    /// the lookup [`presence_standing`] and [`beacon_standing`] make on the
    /// process-wide lease, here on the test's. Its own reconciliation runs on
    /// the wall clock, less than the grace after any spend here was parked (a
    /// test takes seconds), so it asks about no parked spend, and judges the
    /// settling ones by the same chain again.
    /// The write spends one coin, `input`, to itself, as every write of this
    /// build does ([`WriteCoins::one`]). Judged as a mark an older node saved
    /// is, with no memo digest: by its hint alone ([`Self::standing_with_memo`]
    /// for a mark this build saves).
    async fn standing(&mut self, hint: Bytes32, input: Bytes32, spend: u64) -> WriteStanding {
        self.judge(hint, input, None, spend).await
    }

    /// [`Self::standing`] of a write whose mark keeps `memo`, the digest of
    /// the memo it carried ([`memo_of`]), as every mark this build saves
    /// does: its coin under the hint confirms it only if it carries that memo.
    async fn standing_with_memo(&mut self, hint: Bytes32, input: Bytes32, memo: Bytes32, spend: u64) -> WriteStanding {
        self.judge(hint, input, Some(memo), spend).await
    }

    async fn judge(&mut self, hint: Bytes32, input: Bytes32, memo: Option<Bytes32>, spend: u64) -> WriteStanding {
        self.reconcile().await;
        let judged = write_standing_on(&self.lease, NET, &self.money, WriteCoins::one(input), hint, memo, Some(spend), 0, "test").await;
        judged.expect("the chain answered").0
    }

    /// A lane of its own on the same two nodes, as a node restarted would
    /// have: the old one's cool-downs run on the wall clock for
    /// [`crate::chia_peer_lane::RETRY_AFTER`].
    fn new_lane(&mut self) {
        self.lane = self.chain.lane(&self.a, &self.b);
        self.money = PeerLane::new(self.lane.clone(), Trust::Agreed);
        self.carrier = PeerLane::new(self.lane.clone(), Trust::Carrier);
    }

    /// The names of every bundle the nodes were sent, each once.
    fn sent(&self) -> HashSet<Bytes32> {
        self.chain.received().iter().map(SpendBundle::name).collect()
    }

    /// How many requests of `kind` the two nodes have read.
    fn asked(&self, kind: ProtocolMessageTypes) -> usize {
        [&self.a, &self.b].iter().map(|n| n.seen.lock().unwrap().iter().filter(|k| **k == kind).count()).sum()
    }

    fn asked_nothing(&self) -> bool {
        self.a.seen.lock().unwrap().is_empty() && self.b.seen.lock().unwrap().is_empty()
    }
}

/// A test wallet's key, from a seed no real wallet uses.
fn wallet(n: u8) -> SecretKey {
    SecretKey::from_seed(&[n; 32])
}

fn entries() -> Vec<AddrEntry> {
    vec![AddrEntry { addr: "198.51.100.7:4444".parse().unwrap(), flags: 1 }]
}

/// A presence write of `node` under `ck` for `era`, spending `coin` of
/// `payer`: its hint and its bundle, built as the presence writer builds
/// them ([`presence_memo`], [`memo_bundle`]). The digest the writer's mark
/// keeps is checked, for every write a test makes, to be the one a reader
/// takes from the bundle ([`our_memo`]), which the tests judge it by.
fn presence_write(payer: &SecretKey, node: &iroh::SecretKey, ck: &[u8; 32], coin: Coin, era: u64) -> (Bytes32, SpendBundle) {
    let (hint, memo) = presence_memo(NET, node, ck, era, &entries(), unix_now()).unwrap();
    (hint, our_memo(payer, coin, hint, memo))
}

/// A write of ours carrying `body` under `hint`, spending `coin` of `payer`,
/// built as every writer of ours builds it ([`memo_bundle`]): its bundle,
/// once the digest its mark would keep is shown to be [`memo_of`] it.
fn our_memo(payer: &SecretKey, coin: Coin, hint: Bytes32, body: Vec<u8>) -> SpendBundle {
    let (bundle, saved) = memo_bundle(NET, payer, coin, hint, body).unwrap();
    assert_eq!(saved, memo_of(&bundle, hint), "the digest the writer saves is the one its readers take from its spend");
    bundle
}

/// The coin a write of `payer`'s spending `coin` creates: back to the
/// wallet at the coin's full amount, since a write pays no fee.
fn written(payer: &SecretKey, coin: Coin) -> Coin {
    Coin::new(coin.coin_id(), our_puzzle_hash(payer), coin.amount)
}

/// The digest of the memo `bundle` carries under `hint` ([`memo_digest`]):
/// what the write's mark keeps of it, taken as a reader takes the memo
/// ([`extract_ciphertext`]) from the first of the bundle's spends carrying
/// one under the hint.
fn memo_of(bundle: &SpendBundle, hint: Bytes32) -> Bytes32 {
    let carried = bundle.coin_spends.iter().find_map(|cs| {
        let spend = crate::chia_chain::PuzzleAndSolution { puzzle_reveal: cs.puzzle_reveal.clone(), solution: cs.solution.clone() };
        extract_ciphertext(&spend, hint).expect("the spend runs")
    });
    memo_digest(&carried.expect("the bundle carries a memo under the hint"))
}

/// The dish's TAKE of `dish` to `recipient`, keyless and fee 0, as
/// `chia_faucet`'s claim builds it.
fn claim(params: &FaucetParams, dish: Coin, recipient: Bytes32) -> SpendBundle {
    let mut a = clvmr::Allocator::new();
    let puzzle = params.puzzle_reveal(&mut a).unwrap();
    let solution = claim_solution(&mut a, params.puzzle_hash(), dish.amount, recipient, 0).unwrap();
    let bytes = |node| Program::from(clvmr::serde::node_to_bytes(&a, node).unwrap());
    SpendBundle::new(vec![CoinSpend::new(dish, bytes(puzzle), bytes(solution))], Signature::default())
}

/// A presence write lands, the resolver's reader opens it under the
/// contact key's hint as its node's, and the lease, reconciled, holds the
/// spend settling until it is SETTLED_DEPTH deep and then lets it go. The
/// write pays no fee: its coin comes back to the wallet whole.
#[tokio::test]
async fn a_presence_write_lands_and_the_resolver_reads_it_back() {
    let mut s = setup().await;
    let (payer, node) = (wallet(1), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let memo = memo_of(&bundle, hint);
    assert_eq!(s.chain.fee_of(&bundle), 0, "a presence write pays no fee");
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).expect("parked under its spend");
    assert_eq!(s.chain.mempool(), vec![bundle.name()]);
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Pending, "in the mempool, the spend is live");
    assert!(s.lease.is_parked(&coin.coin_id()));

    let landed = s.chain.farm().await;
    assert_eq!(s.chain.children(coin.coin_id()), vec![written(&payer, coin)], "the coin came back whole");
    let peak = s.carrier.peak_height().await.unwrap();
    assert_eq!(peak, landed);
    let found = read_ck(NET, &s.carrier, &CK, peak, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].record.node_id, node.public().to_string());
    assert_eq!(found[0].record.addrs, vec!["198.51.100.7:4444".to_string()]);
    assert_eq!((found[0].coin_id, found[0].confirmed_height, found[0].hint), (written(&payer, coin).coin_id(), landed, hint));

    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.lease.lease_word(&coin.coin_id()), LeaseWord::Spent);
    assert!(s.lease.is_settling(&coin.coin_id()) && s.lease.holds_spend(spend), "spent, and kept until it settles");
    s.chain.farm_blocks(SETTLED_DEPTH - 1).await;
    s.reconcile().await;
    assert!(s.lease.holds_spend(spend), "one block short of settled");
    s.chain.farm().await;
    s.reconcile().await;
    assert!(!s.lease.is_settling(&coin.coin_id()) && !s.lease.holds_spend(spend), "settled: forgotten");
    assert_eq!(s.lease.lease_word(&coin.coin_id()), LeaseWord::Spent, "the word outlives the record for the run");
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "one write, sent and probed as itself");
    assert!(s.chain.unanswered().is_empty());
}

/// A presence write sealed for era 0 that the chain confirms in era 1 (the
/// pre-fill the era rule is for) is listed under era 0's hint and its parent's
/// spend fetched, and then not read back; a write sealed for era 1 in the
/// same block is.
#[tokio::test]
async fn a_presence_write_confirmed_outside_the_era_it_was_sealed_for_is_listed_but_not_read_back() {
    let s = setup().await;
    let payer = wallet(2);
    let (early, late) = (iroh::SecretKey::generate(), iroh::SecretKey::generate());
    let ours = our_puzzle_hash(&payer);
    let (first, second) = (s.chain.fund(ours, 1000, None), s.chain.fund(ours, 2000, None));
    s.chain.farm_to(ERA_BLOCKS - 1).await;
    let (stale_hint, stale) = presence_write(&payer, &early, &CK, first, 0);
    let (_, fresh) = presence_write(&payer, &late, &CK, second, 1);
    s.push(&payer, &stale, (first.coin_id(), 1)).await.unwrap();
    s.push(&payer, &fresh, (second.coin_id(), 1)).await.unwrap();
    let landed = s.chain.farm().await;
    assert_eq!((landed, chia_lane::era_of(landed)), (ERA_BLOCKS, 1));
    let listed = s.money.coin_records_by_hint(stale_hint, None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(written(&payer, first), landed)]);

    let fetched = s.asked(ProtocolMessageTypes::RequestPuzzleSolution);
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(s.asked(ProtocolMessageTypes::RequestPuzzleSolution) - fetched, 2, "both writes were opened");
    assert_eq!(found.iter().map(|f| f.record.node_id.clone()).collect::<Vec<_>>(), vec![late.public().to_string()], "only era 1's write is read");
    assert!(s.chain.unanswered().is_empty());
}

/// A knock lands under the host's inbox hint and opens for the host, with
/// the knocker's contact key. Nobody else gets one: a copy of the blob
/// under a thief's coin does not open (the carrier binding), one sealed
/// without the room's key does not open (the lane token), and a stranger
/// who can derive the hint lists the coins and fetches their parents'
/// spends, and opens nothing with its own card key.
#[tokio::test]
async fn a_knock_opens_for_the_host_and_for_nobody_else() {
    let s = setup().await;
    let host = iroh::SecretKey::generate();
    let host_kx = crate::chia_contact::kx_card_secret(&host);
    let ck_host = [31u8; 32];
    let req = KnockRequest {
        room: ROOM.into(),
        host: host.public().to_string(),
        ck_host,
        kx_host: crate::chia_contact::kx_public(&host_kx),
        attempts: 0,
    };
    let hint = knock_hint(NET, &req, &ROOM_KEY, 0);
    let (knocker, thief, forger) = (wallet(3), wallet(4), wallet(5));
    let (knocker_node, forger_node) = (iroh::SecretKey::generate(), iroh::SecretKey::generate());
    let coins: Vec<Coin> = [&knocker, &thief, &forger].iter().map(|w| s.chain.fund(our_puzzle_hash(w), 1000, None)).collect();
    let funded = s.chain.farm().await;

    let ck_from = [41u8; 32];
    let memo = knock_memo(NET, &knocker_node, &req, &ROOM_KEY, 0, coins[0].coin_id(), Some(ck_from), unix_now()).unwrap();
    let knock = our_memo(&knocker, coins[0], hint, memo.clone());
    s.push(&knocker, &knock, (coins[0].coin_id(), funded)).await.unwrap();
    let replay = build_publish_bundle(NET, &thief, coins[1], hint, Bytes::new(memo)).unwrap();
    s.money.push_tx(replay).await.unwrap();
    let forged = knock_memo(NET, &forger_node, &req, &[24u8; 32], 0, coins[2].coin_id(), None, unix_now()).unwrap();
    s.money.push_tx(build_publish_bundle(NET, &forger, coins[2], hint, Bytes::new(forged)).unwrap()).await.unwrap();
    let landed = s.chain.farm().await;
    let listed = s.money.coin_records_by_hint(hint, None, true, None).await.unwrap();
    assert_eq!(listed.records.len(), 3, "all three are under the host's inbox hint");

    let opened = read_inbox(NET, &s.carrier, &host_kx, &ck_host, &ROOM_KEY, ROOM, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(opened.iter().map(|f| (f.item.from, f.item.ck_from)).collect::<Vec<_>>(), vec![(knocker_node.public(), Some(ck_from))]);
    assert_eq!((opened[0].coin_id, opened[0].confirmed_height), (written(&knocker, coins[0]).coin_id(), landed));

    let stranger = crate::chia_contact::kx_card_secret(&iroh::SecretKey::generate());
    let fetched = s.asked(ProtocolMessageTypes::RequestPuzzleSolution);
    let opened = read_inbox(NET, &s.carrier, &stranger, &ck_host, &ROOM_KEY, ROOM, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert!(opened.is_empty(), "{opened:?}");
    assert_eq!(s.asked(ProtocolMessageTypes::RequestPuzzleSolution) - fetched, 3, "the stranger fetched every parent's spend");
    assert!(s.chain.unanswered().is_empty());
}

/// A full mempool refuses a fresh fee-0 write with Chia's reason; the lease
/// hands its coin back, since the nodes hold nothing of it. Once the
/// mempool clears, the same bundle, with no fee added, is taken and lands.
#[tokio::test]
async fn a_full_mempool_refuses_a_fresh_fee_zero_write_and_takes_it_once_cleared_with_no_fee_added() {
    let mut s = setup().await;
    let (payer, node) = (wallet(6), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let memo = memo_of(&bundle, hint);
    s.chain.set_full(true);
    match s.push(&payer, &bundle, (coin.coin_id(), funded)).await {
        Err(PushError::Rejected(why)) => assert!(why.contains("INVALID_FEE_TOO_CLOSE_TO_ZERO"), "{why}"),
        other => panic!("expected a rejection, got {other:?}"),
    }
    assert!(!s.lease.is_taken(&coin.coin_id()), "a rejection hands the coin back");
    assert!(s.chain.mempool().is_empty());

    s.chain.set_full(false);
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(s.chain.fee_of(&bundle), 0);
    assert_eq!(s.chain.children(coin.coin_id()), vec![written(&payer, coin)]);
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.sent(), HashSet::from([bundle.name()]));
    assert!(s.chain.unanswered().is_empty());
}

/// A write evicted from a full mempool is still in every node's seen
/// cache, so the lease's probe hears ALREADY_INCLUDING_TRANSACTION, which
/// is no final word: the coin stays parked, while the mempool is full and
/// after it clears, until the nodes forget the name. The next probe is
/// then taken, and the write lands as it was built.
#[tokio::test]
async fn an_evicted_write_the_nodes_still_remember_stays_parked_until_they_forget_it_and_then_lands() {
    let mut s = setup().await;
    let (payer, node) = (wallet(7), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let memo = memo_of(&bundle, hint);
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    s.chain.evict_all();
    let remembered = (FAILED, Some("ALREADY_INCLUDING_TRANSACTION".to_string()));
    for full in [true, false] {
        s.chain.set_full(full);
        s.reconcile().await;
        assert!(s.lease.is_parked(&coin.coin_id()), "full {full}: no final word, so the coin stays parked");
        assert_eq!(s.chain.acks_for(bundle.name()).split_off(2), vec![remembered.clone(); if full { 2 } else { 4 }]);
        s.chain.farm().await;
        assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None, "full {full}: in no mempool, so in no block");
    }
    s.chain.forget_seen();
    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![bundle.name()], "the probe was taken");
    let landed = s.chain.farm().await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.chain.fee_of(&bundle), 0);
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "the saved bundle, never built again");
    assert!(s.chain.unanswered().is_empty());
}

/// A write the lease probed while it sat in the mempool (which takes its
/// name out of the seen cache, as a re-send of a mempool item does) and that
/// a full mempool then evicted is refused INVALID_FEE_TOO_CLOSE_TO_ZERO on
/// the next probe, no final word, so it stays parked; once the mempool
/// clears, the probe pushes the saved fee-0 bundle and it lands.
#[tokio::test]
async fn a_write_evicted_from_a_full_mempool_stays_parked_and_lands_once_the_mempool_clears() {
    let mut s = setup().await;
    let (payer, node) = (wallet(8), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let memo = memo_of(&bundle, hint);
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    s.reconcile().await;
    assert!(s.lease.is_parked(&coin.coin_id()), "live in the mempool");
    s.chain.evict_all();
    s.chain.set_full(true);
    s.reconcile().await;
    assert!(s.lease.is_parked(&coin.coin_id()), "a full mempool is no final word");
    let refused = (FAILED, Some("INVALID_FEE_TOO_CLOSE_TO_ZERO".to_string()));
    assert_eq!(s.chain.acks_for(bundle.name()).split_off(4), vec![refused; 2]);
    s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None);

    s.chain.set_full(false);
    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![bundle.name()]);
    let landed = s.chain.farm().await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.chain.fee_of(&bundle), 0, "no fee added");
    assert_eq!(s.sent(), HashSet::from([bundle.name()]));
    assert!(s.chain.unanswered().is_empty());
}

/// A write the lease probed while it sat in both mempools (which takes its
/// name out of the seen caches) and that both then evicted meets two nodes
/// too busy to validate it in time: the next probe hears
/// INVALID_SPEND_BUNDLE from both, a soft failure and no final word, so the
/// coin stays parked under its own number and nothing is freed. Once the
/// nodes are no longer busy, the probe pushes the saved fee-0 bundle and it
/// lands.
#[tokio::test]
async fn a_write_both_busy_nodes_refuse_stays_parked_and_lands_once_they_are_not_busy() {
    let mut s = setup().await;
    let (payer, node) = (wallet(15), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    assert_eq!((s.chain.mempool_on(&s.a), s.chain.mempool_on(&s.b)), (vec![bundle.name()], vec![bundle.name()]));
    s.reconcile().await;
    assert!(s.lease.is_parked(&coin.coin_id()), "live in the mempool");
    s.chain.evict_all();
    s.chain.set_busy(&s.a, true);
    s.chain.set_busy(&s.b, true);
    s.reconcile().await;
    assert!(s.lease.is_parked(&coin.coin_id()), "a busy node's refusal is no final word");
    assert_eq!(s.lease.spend_of(&coin.coin_id()), Some(spend), "nothing freed: parked under its own number");
    let busy = (FAILED, Some("INVALID_SPEND_BUNDLE".to_string()));
    assert_eq!(s.chain.acks_for(bundle.name()).split_off(4), vec![busy; 2]);
    s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None);

    s.chain.set_busy(&s.a, false);
    s.chain.set_busy(&s.b, false);
    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![bundle.name()], "the probe pushed the saved bundle");
    let landed = s.chain.farm().await;
    assert_eq!(s.standing(hint, coin.coin_id(), spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.chain.fee_of(&bundle), 0, "no fee added");
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "the saved bundle, never built again");
    assert!(s.chain.unanswered().is_empty());
}

/// A reorganisation drops the block holding a write the lease had released
/// as spent and kept settling: the next reconciliation finds its input
/// unspent and parks the spend again, the write reads pending, and the
/// probe after the grace pushes the saved bundle, which lands on the new
/// fork. One bundle, never built again.
#[tokio::test]
async fn a_reorg_drops_the_write_and_the_lease_pushes_its_saved_bundle_again_until_it_lands() {
    let mut s = setup().await;
    let (payer, node) = (wallet(9), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let memo = memo_of(&bundle, hint);
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert!(s.lease.is_settling(&coin.coin_id()));

    let peak = s.chain.reorg(1).await;
    assert_eq!(peak, landed + 1);
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None, "the spend is undone");
    assert!(s.chain.children(coin.coin_id()).is_empty() && s.chain.mempool().is_empty());
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Pending);
    assert!(s.lease.is_parked(&coin.coin_id()) && s.lease.holds_spend(spend), "parked again under its own number");

    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![bundle.name()], "the probe pushed the saved bundle");
    let again = s.chain.farm().await;
    assert_eq!(again, landed + 2);
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: again, seen_at: Some(again) });
    assert_eq!(s.sent(), HashSet::from([bundle.name()]));
    assert!(s.chain.unanswered().is_empty());
}

/// A reorganisation that reaches one node before the other, as real ones
/// do, seconds apart (the barrier lands every other one here on both nodes
/// at once). While the two disagree the lane gives no verdict and lets both
/// go, so the lease keeps the dropped write settling under its own number,
/// sends nothing and builds nothing, and the writer's lookup has no answer
/// either. Once the late node has the new fork, a lane that is not cooling
/// its peers finds the input unspent, the lease parks the spend again, and
/// its probe pushes the saved bundle, which lands.
#[tokio::test]
async fn a_reorg_one_node_has_not_taken_yet_gives_no_verdict_and_the_lease_keeps_the_write_until_both_agree() {
    let mut s = setup().await;
    let (payer, node) = (wallet(14), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let memo = memo_of(&bundle, hint);
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert!(s.lease.is_settling(&coin.coin_id()));

    s.chain.hold(&s.b);
    s.chain.reorg(1).await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None, "the spend is undone on the new fork");
    let sends = s.chain.received().len();
    s.reconcile().await;
    assert!(s.lease.is_settling(&coin.coin_id()) && s.lease.holds_spend(spend), "no verdict: still settling under its own number");
    assert!(!s.lease.is_parked(&coin.coin_id()));
    assert_eq!(s.lane.live_count().await, 0, "the two disagree on the chain, so the lane let both go");
    let judged = write_standing_on(&s.lease, NET, &s.money, WriteCoins::one(coin.coin_id()), hint, Some(memo), Some(spend), landed, "test").await;
    assert_eq!(judged, None, "the writer's lookup has no answer either");
    assert!(s.lease.is_settling(&coin.coin_id()) && s.lease.holds_spend(spend));
    assert_eq!(s.chain.received().len(), sends, "nothing was sent while the two disagree");
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "nothing was built");

    s.chain.release(&s.b).await;
    s.new_lane();
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Pending);
    assert_eq!(s.lease.spend_of(&coin.coin_id()), Some(spend), "parked again under its own number");
    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![bundle.name()], "the probe pushed the saved bundle");
    let again = s.chain.farm().await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: again, seen_at: Some(again) });
    assert_eq!(s.chain.fee_of(&bundle), 0);
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "one bundle, never built again");
    assert!(s.chain.unanswered().is_empty());
}

/// A dish's TAKE and a write from the mojo it gives, sent as one bundle:
/// the gift is created and spent in one block, and every lookup the
/// resolver makes finds it. The reader opens the record through the gift,
/// its parent; the gift and the dish coin are listed spent where they
/// went; and the write is the child under the hint whose parent is the
/// gift.
#[tokio::test]
async fn an_ephemeral_coin_is_found_through_its_parent_by_every_lookup_the_resolver_makes() {
    let mut s = setup().await;
    let params = FaucetParams::for_room(NET, &ROOM_KEY);
    let dish = s.chain.fund(params.puzzle_hash(), 10, None);
    let filled = s.chain.farm().await;
    s.chain.farm_blocks(GAP_BLOCKS).await;
    let (payer, node) = (wallet(10), iroh::SecretKey::generate());
    let gift = Coin::new(dish.coin_id(), our_puzzle_hash(&payer), GIFT_MOJOS);
    let (hint, write) = presence_write(&payer, &node, &CK, gift, 0);
    let both = SpendBundle::aggregate(&[claim(&params, dish, our_puzzle_hash(&payer)), write]);
    assert_eq!(s.chain.fee_of(&both), 0);
    s.push(&payer, &both, (dish.coin_id(), filled)).await.unwrap();
    let spend = s.lease.spend_of(&dish.coin_id()).unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(s.chain.record(gift.coin_id()), Some((gift, landed, Some(landed))), "created and spent in one block");
    let rest = Coin::new(dish.coin_id(), params.puzzle_hash(), 10 - GIFT_MOJOS);
    let mut dished = vec![gift, rest];
    dished.sort_by_key(Coin::coin_id);
    assert_eq!(s.chain.children(dish.coin_id()), dished);

    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(found.iter().map(|f| (f.record.node_id.clone(), f.coin_id, f.confirmed_height)).collect::<Vec<_>>(), vec![(node.public().to_string(), written(&payer, gift).coin_id(), landed)]);
    let mut spent = spent_heights(&s.money, vec![dish.coin_id(), gift.coin_id()]).await.unwrap();
    spent.sort();
    let mut want = vec![(dish.coin_id(), landed), (gift.coin_id(), landed)];
    want.sort();
    assert_eq!(spent, want);
    assert_eq!(child_under_hint(&s.money, hint, gift.coin_id(), Some(memo_of(&both, hint))).await.unwrap(), HintChild::Confirmed { height: landed, judged_at: Some(landed) });
    s.reconcile().await;
    assert!(s.lease.is_settling(&dish.coin_id()) && s.lease.holds_spend(spend), "the TAKE's input settles as any spend's");
    assert!(s.chain.unanswered().is_empty());
}

/// Another spend of the coin a write of ours holds (signed by the same
/// wallet, a write under another contact key) lands first. The write reads
/// pending while the lease still holds its spend, every node calls the write
/// a double spend, and once the coin is spent SETTLED_DEPTH deep the lease
/// forgets the spend and the write reads dead: its coin went to another
/// spend of ours.
#[tokio::test]
async fn a_foreign_spend_of_a_coin_our_write_holds_is_seen_as_another_spend_of_ours() {
    let mut s = setup().await;
    let (payer, node) = (wallet(11), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let memo = memo_of(&bundle, hint);
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    let (_, other) = presence_write(&payer, &iroh::SecretKey::generate(), &[22u8; 32], coin, 0);
    s.chain.include_next(other);
    let spent = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(spent));
    assert!(s.chain.mempool().is_empty(), "the block spent the write's coin, so the mempools let the write go");

    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Pending, "the lease still holds the spend");
    assert!(s.lease.is_settling(&coin.coin_id()));
    assert!(!s.money.spend_live(bundle.clone()).await.unwrap(), "a double spend everywhere: dead");
    assert_eq!(s.chain.acks_for(bundle.name()).split_off(2), vec![(FAILED, Some("DOUBLE_SPEND".to_string())); 2]);

    s.chain.farm_blocks(SETTLED_DEPTH).await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Dead("its coin went to another spend of ours"));
    assert!(!s.lease.holds_spend(spend));
    assert!(s.chain.unanswered().is_empty());
}

/// A write of ours lands and is confirmed, and then a reorganisation,
/// reaching one node late as real ones do, replaces its block by a fork whose
/// first block holds another write of ours from the same coin (the same
/// wallet, another contact key, so another hint). The new fork makes the
/// same coin at the same height, and a full node never deletes a hint row:
/// once both nodes have the fork, both list the coin under the old hint as
/// well as the new. The coin's parent spend is now the other write's, so a
/// reader opens nothing of ours under the old hint, and the writer's verdict
/// says so too: not confirmed — pending while the lease holds the spend, so
/// the Phone Book's green goes — for one agreed spend request more, and dead
/// once the coin is spent SETTLED_DEPTH deep, so the listing is written
/// again. The other write confirms under its own hint and memo. A node that
/// never took the old block has no stale row, and a lane on it and on one
/// that did settles the coin only the one lists by its id and its parent's
/// spend, which carries the other hint: the row is stale, the write absent,
/// and neither node is let go.
#[tokio::test]
async fn a_coin_made_again_under_another_hint_by_a_new_fork_does_not_confirm_the_write_the_old_fork_held() {
    let mut s = setup().await;
    let (payer, node) = (wallet(16), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&payer), 1000, None);
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, coin, 0);
    let (other_hint, other) = presence_write(&payer, &iroh::SecretKey::generate(), &[22u8; 32], coin, 0);
    assert_ne!(hint, other_hint);
    let (memo, other_memo) = (memo_of(&bundle, hint), memo_of(&other, other_hint));
    let ours = written(&payer, coin);

    // Our write lands, and its mark is saved seen on chain.
    s.push(&payer, &bundle, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    let write = MemoWrite { coins: WriteCoins::one(coin.coin_id()), acked: true, spend: Some(spend), memo };
    let made = NodePublishMark::written(0, 1, "a".into(), unix_now(), hint, &write, node.public().to_string());
    let word = presence_standing_on(&s.lease, NET, &s.money, &made).await;
    assert_eq!(word, Some((WriteStanding::Confirmed { height: landed, seen_at: Some(landed) }, false)));
    let PresenceStep::Save(mark) = presence_step(&made, word, 0, landed) else { panic!("confirmed: saved") };
    assert!(mark.chain_seen && mark.confirmed_height == landed && mark.memo == hex::encode(memo), "{mark:?}");

    // The new fork, staged as a real one: node b is held on the old one while
    // node a takes it, and the lane gives no verdict while the two disagree.
    s.chain.hold(&s.b);
    let peak = s.chain.reorg_including(1, vec![other.clone()]).await;
    assert_eq!(peak, landed + 1);
    assert_eq!(s.chain.record(ours.coin_id()), Some((ours, landed, None)), "the same coin at the same height, made by the other write");
    s.reconcile().await;
    assert_eq!(presence_standing_on(&s.lease, NET, &s.money, &mark).await, None, "the two nodes disagree: no verdict");
    s.chain.release(&s.b).await;
    s.new_lane();

    // The stale row: both nodes list the coin under the old hint as under the
    // new. Its parent's spend at that height is the other write's, so a
    // reader opens nothing of ours.
    for h in [hint, other_hint] {
        let listed = s.money.coin_records_by_hint(h, None, true, None).await.unwrap();
        assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(ours, landed)], "under {h}");
    }
    let served = s.money.puzzle_and_solution(coin.coin_id(), landed).await.unwrap().expect("the coin was spent at that height");
    assert_eq!(served.solution, other.coin_spends[0].solution, "the other write's spend");
    assert!(read_ck(NET, &s.carrier, &CK, peak, unix_now(), &mut HashMap::new()).await.unwrap().is_empty(), "nothing of ours to read");

    // The verdict: not confirmed. The lease still holds the spend (settling),
    // so the write is pending, and the listing judged past its block lacks
    // it: the mark goes back to pending, the green with it. One agreed spend
    // request, of each node once, is what the check costs.
    s.reconcile().await;
    let asked = s.asked(ProtocolMessageTypes::RequestPuzzleSolution);
    let word = presence_standing_on(&s.lease, NET, &s.money, &mark).await;
    assert_eq!(word, Some((WriteStanding::Pending, true)), "the coin under the hint carries the other write");
    assert_eq!(s.asked(ProtocolMessageTypes::RequestPuzzleSolution) - asked, 2, "the parent's spend, of each node once");
    let PresenceStep::Save(again) = presence_step(&mark, word, 0, peak) else { panic!("pending again: saved") };
    assert!(!again.chain_seen && again.confirmed_height == 0, "{again:?}");
    assert_eq!(s.standing(hint, coin.coin_id(), spend).await, WriteStanding::Pending, "an older node's mark, by the hint alone, is not confirmed either");
    assert_eq!(
        child_under_hint(&s.money, other_hint, coin.coin_id(), Some(other_memo)).await.unwrap(),
        HintChild::Confirmed { height: landed, judged_at: Some(peak) },
        "the other write is confirmed under its own hint and memo"
    );

    // Spent SETTLED_DEPTH deep, the lease lets the spend go: the write is
    // dead, and the listing is written again.
    s.chain.farm_blocks(SETTLED_DEPTH).await;
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), memo, spend).await, WriteStanding::Dead("its coin went to another spend of ours"));
    assert!(!s.lease.holds_spend(spend));

    // A node that never took the old block has the hint rows of the chain as
    // it stands, with no stale row: a lane on it and on node a settles the
    // coin only node a lists, by its id and its parent's spend.
    let late = s.chain.node().await;
    let fresh_lane = s.chain.lane(&s.a, &late);
    let fresh = PeerLane::new(fresh_lane.clone(), Trust::Agreed);
    let now = s.chain.peak();
    assert_eq!(
        child_under_hint(&fresh, hint, coin.coin_id(), Some(memo)).await.unwrap(),
        HintChild::Absent { judged_at: Some(now) },
        "one node lists the stale row, the other not: the spend carries the other hint, so the write is absent"
    );
    assert_eq!(fresh_lane.live_count().await, 2, "neither node was let go");
    assert!(s.chain.unanswered().is_empty());
}

/// A stale row under a room's inbox hint on one node only, planted by a
/// third party, as anyone holding the hint can with one spend in a block
/// that happens to be orphaned: node b is held while a block carrying the
/// third party's write under the inbox hint comes and goes, and the fork
/// that replaces it carries the same spend under another hint, which makes
/// the same coin. Node a lists the coin under the inbox hint, b does not.
/// The host's agreed inbox read asks both for the coin by id and for its
/// parent's spend, finds the row stale, reads the room's real knock, and
/// lets neither node go; and the knock's own verdict, our write judged
/// under the same hint by [`write_standing_on`], still settles: confirmed.
#[tokio::test]
async fn a_stale_inbox_row_on_one_node_hides_no_knock_lets_no_peer_go_and_our_knock_still_settles() {
    let mut s = setup().await;
    let host = iroh::SecretKey::generate();
    let host_kx = crate::chia_contact::kx_card_secret(&host);
    let ck_host = [32u8; 32];
    let req = KnockRequest {
        room: ROOM.into(),
        host: host.public().to_string(),
        ck_host,
        kx_host: crate::chia_contact::kx_public(&host_kx),
        attempts: 0,
    };
    let hint = knock_hint(NET, &req, &ROOM_KEY, 0);
    let (knocker, planter) = (wallet(17), wallet(18));
    let knocker_node = iroh::SecretKey::generate();
    let coin = s.chain.fund(our_puzzle_hash(&knocker), 1000, None);
    let planted = s.chain.fund(our_puzzle_hash(&planter), 1000, None);
    let funded = s.chain.farm().await;

    // Our knock lands under the inbox hint, issued at a fixed time the
    // host reads it at.
    let issued = 1_700_000_000;
    let ck_from = [42u8; 32];
    let memo = knock_memo(NET, &knocker_node, &req, &ROOM_KEY, 0, coin.coin_id(), Some(ck_from), issued).unwrap();
    let knock = our_memo(&knocker, coin, hint, memo);
    let digest = memo_of(&knock, hint);
    s.push(&knocker, &knock, (coin.coin_id(), funded)).await.unwrap();
    let spend = s.lease.spend_of(&coin.coin_id()).unwrap();
    let landed = s.chain.farm().await;

    // The plant: node b is held through the orphaned block, so node a alone
    // keeps its row; the new fork makes the same coin under another hint.
    let body = Bytes::new(vec![7u8; 64]);
    let elsewhere = Bytes32::new([43u8; 32]);
    let under_inbox = build_publish_bundle(NET, &planter, planted, hint, body.clone()).unwrap();
    let under_elsewhere = build_publish_bundle(NET, &planter, planted, elsewhere, body).unwrap();
    s.chain.hold(&s.b);
    s.chain.include_next(under_inbox);
    s.chain.farm().await;
    let peak = s.chain.reorg_including(1, vec![under_elsewhere]).await;
    s.chain.release(&s.b).await;
    let stale = written(&planter, planted);
    assert_eq!(s.chain.record(stale.coin_id()), Some((stale, peak - 1, None)), "the same coin, made again by the new fork");

    // The host reads the room's knock, and only it; the coin only node a
    // lists under the hint is asked of each node by id, once.
    let by_id = |s: &Setup| [&s.a, &s.b].map(|n| n.seen.lock().unwrap().iter().filter(|k| **k == ProtocolMessageTypes::RequestCoinState).count());
    let before = by_id(&s);
    let opened = read_inbox(NET, &s.money, &host_kx, &ck_host, &ROOM_KEY, ROOM, peak, issued, &mut HashMap::new()).await.unwrap();
    assert_eq!(opened.iter().map(|f| (f.item.from, f.item.ck_from)).collect::<Vec<_>>(), vec![(knocker_node.public(), Some(ck_from))]);
    assert_eq!((opened[0].coin_id, opened[0].confirmed_height), (written(&knocker, coin).coin_id(), landed));
    let after = by_id(&s);
    assert_eq!([after[0] - before[0], after[1] - before[1]], [1, 1], "the one-sided coin, asked of each node by id, once");
    assert_eq!(s.lane.live_count().await, 2, "neither node was let go");
    let listed = s.money.coin_records_by_hint(hint, None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| r.coin).collect::<Vec<_>>(), vec![written(&knocker, coin)], "the lane itself leaves the stale row out");

    // Our knock's verdict, through the lookup behind it, settles.
    assert_eq!(s.standing_with_memo(hint, coin.coin_id(), digest, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(peak) });
    assert_eq!(s.lane.live_count().await, 2, "neither node was let go");
    assert!(s.chain.unanswered().is_empty());
}

/// A restart mid-write: one write parked and pushed, another parked whose
/// push never left (a stop between the two). The next run restores both
/// with their bundles; its first reconciliation asks the nodes about each,
/// which keeps the first in the mempool and puts the second there, and each
/// lands once, as built.
#[tokio::test]
async fn a_restart_mid_write_pushes_the_saved_bundle_and_writes_once() {
    let mut s = setup().await;
    let dir = Dir::new("restart");
    let path = dir.0.join("wallet_lease.json");
    let (payer, node) = (wallet(12), iroh::SecretKey::generate());
    let ours = our_puzzle_hash(&payer);
    let (first, second) = (s.chain.fund(ours, 1000, None), s.chain.fund(ours, 2000, None));
    let funded = s.chain.farm().await;
    let (hint, pushed) = presence_write(&payer, &node, &CK, first, 0);
    let (_, parked) = presence_write(&payer, &node, &CK, second, 0);

    let before = WalletLease::new();
    restore(&before, &path, &payer);
    push(&before, &s.money, &payer, &pushed, &[(first.coin_id(), funded)]).await.unwrap();
    park(&before, &payer, &parked, &[(second.coin_id(), funded)]);
    drop(before);
    assert_eq!(s.sent(), HashSet::from([pushed.name()]), "the second push never left");

    s.lease = WalletLease::new();
    restore(&s.lease, &path, &payer);
    assert!(s.lease.is_parked(&first.coin_id()) && s.lease.is_parked(&second.coin_id()));
    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![pushed.name(), parked.name()]);
    let landed = s.chain.farm().await;
    let listed = s.money.coin_records_by_hint(hint, None, true, None).await.unwrap();
    let mut under: Vec<(Coin, u32)> = listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect();
    under.sort_by_key(|(c, _)| c.coin_id());
    let mut want = vec![(written(&payer, first), landed), (written(&payer, second), landed)];
    want.sort_by_key(|(c, _)| c.coin_id());
    assert_eq!(under, want, "each write once");
    assert_eq!(s.sent(), HashSet::from([pushed.name(), parked.name()]), "the saved bundles, never built again");
    s.reconcile().await;
    assert!(s.lease.is_settling(&first.coin_id()) && s.lease.is_settling(&second.coin_id()));
    assert!(s.chain.unanswered().is_empty());
}

/// A lane closed before its first request (Chia off) refuses the write,
/// which hands its coin back; a spend parked earlier stays parked through a
/// reconciliation; and every reader is refused. Neither node is dialled or
/// sent anything.
#[tokio::test]
async fn a_closed_lane_makes_no_connection_and_the_mock_chain_sees_nothing() {
    let mut s = setup().await;
    s.lane.close().await;
    let (payer, node) = (wallet(13), iroh::SecretKey::generate());
    let ours = our_puzzle_hash(&payer);
    let (first, second) = (s.chain.fund(ours, 1000, None), s.chain.fund(ours, 2000, None));
    let funded = s.chain.farm().await;
    let (hint, bundle) = presence_write(&payer, &node, &CK, first, 0);
    match s.push(&payer, &bundle, (first.coin_id(), funded)).await {
        Err(PushError::Rejected(why)) => assert!(why.contains(crate::chia_strict::OFF_WORDS), "{why}"),
        other => panic!("expected a rejection, got {other:?}"),
    }
    assert!(!s.lease.is_taken(&first.coin_id()));
    let (_, earlier) = presence_write(&payer, &node, &CK, second, 0);
    park(&s.lease, &payer, &earlier, &[(second.coin_id(), funded)]);
    s.reconcile().await;
    assert!(s.lease.is_parked(&second.coin_id()), "a refused lookup decides nothing");

    assert!(read_ck(NET, &s.carrier, &CK, funded, unix_now(), &mut HashMap::new()).await.is_err());
    let kx = crate::chia_contact::kx_card_secret(&node);
    assert!(read_inbox(NET, &s.carrier, &kx, &CK, &ROOM_KEY, ROOM, funded, unix_now(), &mut HashMap::new()).await.is_err());
    assert!(spent_heights(&s.money, vec![first.coin_id()]).await.is_err());
    assert!(child_under_hint(&s.money, hint, first.coin_id(), Some(memo_of(&bundle, hint))).await.is_err());
    assert!(s.carrier.peak_height().await.is_err());
    assert_eq!(s.chain.connections(), 0);
    assert!(s.asked_nothing());
    assert!(s.chain.received().is_empty());
}
