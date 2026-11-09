//! The writers and readers on main, end to end on the mock chain (stage 4
//! design §12, §13 rows 8 and 9, §14 (5)): each write is built by the
//! builder the writers use, pushed through the wallet lease, carried by the
//! real lane to two mock full nodes that answer from one model, and read
//! back by the resolver's own readers. The lease is reconciled at instants
//! the test moves forward by twice its grace, so nothing waits on the wall
//! clock. A write's standing is judged by [`write_standing_on`], the lookup
//! behind the knock and beacon verdicts, on the test's lease and network.
//!
//! The lease's three entry points that take a payer (stage 4 design §4.4)
//! are named in one helper each ([`push_for`], [`park_for`], [`restore`]),
//! so a change to their signatures changes those three bodies and nothing
//! else.
//!
//! A burner's write goes through the burner writer's own seam,
//! `claim_write::burner_write_with`, on the test's lease, gift fuse,
//! network, chain, clock and seeded random source ([`Setup::burner_write`]),
//! under the gift rules of §5.2 and the failures of §10: a claim and write
//! built as one bundle lands and is read through its ephemeral parent
//! (`a_claim_and_write_lands_and_the_resolver_opens_the_record_through_the_ephemeral_parent`),
//! is built again from another dish coin when a reorganization gives its
//! coin to another claimer
//! (`a_reorg_that_gives_the_dish_coin_to_another_claimer_has_the_write_built_again_from_another_coin`),
//! and waits out a full mempool with no fee added
//! (`a_full_mempool_holds_a_claim_and_write_and_it_lands_once_cleared_with_no_fee_added`).
//!
//! A listing the SSF wallet pays for goes through the money writer's own
//! seam, [`publish_node_presence_on`], on the test's lease, network, chain
//! and clock ([`Setup::money_listing`]): it names the wallet as its payer
//! and the lease holds it for that wallet alone
//! (`a_money_presence_write_files_the_wallet_as_its_payer_and_the_lease_holds_it_for_the_wallet`),
//! and it keeps main's global check, waiting while any spend on its lease
//! is parked
//! (`a_money_presence_write_waits_while_any_spend_on_its_lease_is_parked_as_on_main`).
//!
//! The Phone Book listing written from the wallet's listing burner P(e), as
//! the heartbeat writes it with burner keys on, goes through its own seam,
//! [`publish_node_presence_with`], on the test's lease, gift fuse, network,
//! chain, clock and seeded random source ([`Setup::listing`]). It lands and
//! is read back (`a_burner_listing_lands_and_the_resolver_reads_it`), is
//! rewritten from P(e)'s coin and written from P(e+1) once the era turns
//! (`a_rewrite_spends_the_listing_burners_coin_and_the_next_era_writes_from_the_next_burner`),
//! waits out a dry dish and is written again after a lost race or a full
//! mempool (`a_burner_listing_that_finds_no_dish_coin_ready_waits_and_is_written_once_one_is_ready`,
//! `a_burner_listing_that_loses_the_race_for_its_dish_coin_is_written_again_from_another_coin`,
//! `a_burner_listing_refused_by_a_full_mempool_reads_as_the_chain_busy_and_lands_once_cleared`),
//! holds its era's first write while a spend the SSF wallet pays for is in
//! flight (`a_burner_listings_first_write_waits_while_a_spend_of_the_ssf_wallet_is_in_flight_and_goes_out_once_it_lands`),
//! and refuses a root of another network
//! (`a_listing_on_a_root_of_another_network_is_refused_and_sends_nothing`).
//! The hint rule (§8.3) holds a rewrite under an era's hint by the payer that
//! did not write the era's listing, judged by the listing steps on the marks
//! the two seams file and their reader confirms
//! (`a_burner_rewrite_after_a_money_paid_listing_of_this_era_is_held_by_the_hint_rule`,
//! `a_money_rewrite_after_a_burner_paid_listing_of_this_era_is_held_by_the_hint_rule`),
//! and on a mark a restart lost, filed again from the write the lease
//! still holds under the hint ([`lost_listing_mark`]), in either direction
//! (`a_listing_the_ssf_wallet_wrote_before_a_restart_that_lost_its_mark_is_filed_again_and_holds_the_burner`,
//! `a_listing_from_the_burner_whose_mark_a_restart_lost_is_filed_again_and_holds_the_ssf_wallet`).
//! The other wait and refusal words the listing gives are pinned beside
//! [`listing_failure_words`]; the tests here show that the words for each
//! failure the chain gives name no burner's puzzle hash or address.
//!
//! No test here calls the node's own writers, which run on the
//! process-wide lease (`claim_write::burner_write`, [`publish_burner_presence`],
//! [`publish_node_presence`] and [`publish_memo_with`]), the burner writer's
//! fuse (`GIFT_FUSE`) or the flag, and none reads the process's network, so
//! they run alike whatever network CI names.
//!
//! The presence mark, the beacon mark and a knock entry file a write whole
//! (§4.4): its parent as their coin id, its parked input beside it and its
//! payer. A burner's first write filed there is confirmed by the marks' own
//! readers on the test's lease and network, by g under the hint
//! (`a_burners_first_write_filed_in_its_mark_is_confirmed_by_its_gift_under_the_hint_and_its_rewrite_by_its_one_coin`),
//! and dies with F
//! (`a_burners_first_write_whose_dish_coin_a_stranger_claimed_reads_dead_from_its_mark_once_settled_and_pending_for_ever_without_its_parked_input`).
//!
//! What has no seam yet is left for the burner writers of §13 row 10, under
//! the names they will carry:
//! `a_knock_from_its_own_burner_opens_for_the_host_only` and
//! `a_spend_of_our_burner_the_lease_never_parked_pauses_listing_for_two_hours`.
//! The claim and write aggregated by hand stays, in
//! `an_ephemeral_coin_is_found_through_its_parent_by_every_lookup_the_resolver_makes`,
//! as the readers' own proof: it asks nothing of any writer.

use super::*;
use std::sync::Arc;

use super::claim_write::{build_burner_bundle, burner_write_with, BurnerInput, BurnerWait, GiftFuse};
use crate::chia_burner::{BurnerKey, BurnerRoot, MoneyKey};
use crate::chia_faucet::{claim_spend, claim_to, dish_claim, FaucetCoin, FaucetParams, GAP_BLOCKS, GIFT_MOJOS, MAX_FAUCET_PAGES};
use crate::chia_knock::{KnockBook, SETTLED_DEPTH};
use crate::chia_peer::mock::chain::{MockChain, FAILED};
use crate::chia_peer::mock::MockNode;
use crate::chia_peer_lane::{Lane, PeerLane, Trust};
use crate::chia_resolve::{child_under_hint, extract_ciphertext, memo_digest, read_ck, read_inbox, spent_heights, unix_now, HintChild, WriteStanding};
use chia_protocol::ProtocolMessageTypes;
use rand::{rngs::StdRng, SeedableRng};

const NET: crate::chia_network::ChiaNet = crate::chia_network::ChiaNet::Testnet11;

/// The contact key the presence writes are sealed under.
const CK: [u8; 32] = [21; 32];

/// The room every knock here is for, and its key.
const ROOM: &str = "r";
const ROOM_KEY: [u8; 32] = [23; 32];

/// A chain, its two nodes, a lane on them at both trust levels, a wallet
/// lease with no file, the gift fuse a burner's writes count their gifts in
/// (stage 4 design §5.2), kept in memory alone, and the instant the lease is
/// next reconciled at.
struct Setup {
    chain: MockChain,
    a: MockNode,
    b: MockNode,
    lane: Arc<Lane>,
    money: PeerLane,
    carrier: PeerLane,
    lease: WalletLease,
    fuse: std::sync::Mutex<GiftFuse>,
    clock: Instant,
}

async fn setup() -> Setup {
    let chain = MockChain::new(NET);
    let (a, b) = chain.pair().await;
    let lane = chain.lane(&a, &b);
    let money = PeerLane::new(lane.clone(), Trust::Agreed);
    let carrier = PeerLane::new(lane.clone(), Trust::Carrier);
    let fuse = std::sync::Mutex::new(GiftFuse::new());
    Setup { chain, a, b, lane, money, carrier, lease: WalletLease::new(), fuse, clock: Instant::now() }
}

/// [`push_for`] of a write the wallet key `payer` signs and pays for.
async fn push(lease: &WalletLease, money: &PeerLane, payer: &SecretKey, bundle: &SpendBundle, inputs: &[(Bytes32, u32)]) -> Result<(), PushError> {
    push_for(lease, money, Payer::of(payer), bundle, inputs).await
}

/// A write pushed as every writer pushes it ([`push_parked_with`]): its
/// inputs parked first, each with the height its coin was seen at, under
/// `payer`, who pays for it: the wallet key or the burner that signs it.
async fn push_for(lease: &WalletLease, money: &PeerLane, payer: Payer, bundle: &SpendBundle, inputs: &[(Bytes32, u32)]) -> Result<(), PushError> {
    push_parked_with(lease, money, payer, bundle.clone(), inputs.iter().copied()).await
}

/// [`park_for`] of a write the wallet key `payer` signs and pays for.
fn park(lease: &WalletLease, payer: &SecretKey, bundle: &SpendBundle, inputs: &[(Bytes32, u32)]) {
    park_for(lease, Payer::of(payer), bundle, inputs);
}

/// A write parked with its bundle under `payer`, as [`push_parked_with`]
/// parks it, whose push never left (a stop between the two): its parking,
/// which a test can hand back as a rejection would.
fn park_for(lease: &WalletLease, payer: Payer, bundle: &SpendBundle, inputs: &[(Bytes32, u32)]) -> Parking {
    lease.park_with_bundle(inputs.iter().copied(), bundle, payer).expect("the lease parks it")
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
    /// The write spends one coin, `input`, to itself ([`WriteCoins::one`]),
    /// as every write but a burner's first does: that one is found by the
    /// gift g and parked as the dish coin F (`claim_write`'s builder, stage 4
    /// design §4.4). Judged as a mark an older node saved
    /// is, with no memo digest: by its hint alone ([`Self::standing_with_memo`]
    /// for a mark this build saves).
    async fn standing(&mut self, hint: Bytes32, input: Bytes32, spend: u64) -> WriteStanding {
        self.judge(hint, WriteCoins::one(input), None, Some(spend)).await
    }

    /// [`Self::standing`] of a write whose mark keeps `memo`, the digest of
    /// the memo it carried ([`memo_of`]), as every mark this build saves
    /// does: its coin under the hint confirms it only if it carries that memo.
    async fn standing_with_memo(&mut self, hint: Bytes32, input: Bytes32, memo: Bytes32, spend: u64) -> WriteStanding {
        self.judge(hint, WriteCoins::one(input), Some(memo), Some(spend)).await
    }

    /// [`Self::standing_with_memo`] of a burner's write, by the two coins it
    /// is found and judged by (stage 4 design §4.4): for a first write, the
    /// gift g its coin names as its parent, which the hint lookup asks
    /// about, and the dish coin F the lease parked, which the lease's word
    /// and the spent-height lookup ask about; for a rewrite, its one coin as
    /// both. `spend` is the number the writer kept beside the write, if any.
    async fn judge_split(&mut self, hint: Bytes32, coins: WriteCoins, memo: Bytes32, spend: Option<u64>) -> WriteStanding {
        self.judge(hint, coins, Some(memo), spend).await
    }

    async fn judge(&mut self, hint: Bytes32, coins: WriteCoins, memo: Option<Bytes32>, spend: Option<u64>) -> WriteStanding {
        self.reconcile().await;
        let judged = write_standing_on(&self.lease, NET, &self.money, coins, hint, memo, spend, 0, "test").await;
        judged.expect("the chain answered").0
    }

    /// `key`'s write in `era` of what `body` makes under `hint`, through the
    /// burner writer's own seam ([`burner_write_with`]) on the test's lease,
    /// fuse, network and chain, at the next instant ([`Self::later`]), with
    /// the random source seeded by `seed`, so a test picks the same dish
    /// coin on every run. Its future is checked to be `Send`, as a spawned
    /// task needs it to be.
    async fn burner_write(
        &mut self,
        key: &BurnerKey,
        era: u64,
        hint: Bytes32,
        gate: Option<&tokio::sync::Mutex<()>>,
        body: impl FnOnce(Bytes32) -> Result<Vec<u8>> + Send,
        seed: u64,
    ) -> Result<MemoWrite> {
        let at = self.later();
        let mut rng = StdRng::seed_from_u64(seed);
        sendable(burner_write_with(&self.lease, &self.fuse, NET, &self.money, at, key, era, hint, gate, body, &mut rng, "test", None)).await
    }

    /// `node`'s listing for `era`, sealed under [`CK`] with `entries` and
    /// dated `now_unix`, written by the money writer's own seam
    /// ([`publish_node_presence_on`]) on the test's lease, network and
    /// chain, at the next instant ([`Self::later`]), and paid for by the
    /// wallet key `payer`: the write the SSF wallet pays for, as the
    /// heartbeat writes it with burner keys off. Its future is checked to be
    /// `Send`, as the heartbeat's task needs it to be.
    async fn money_listing(&mut self, payer: &SecretKey, node: &iroh::SecretKey, era: u64, entries: &[AddrEntry], now_unix: u64) -> Result<(Bytes32, MemoWrite)> {
        let at = self.later();
        sendable(publish_node_presence_on(&self.lease, NET, &self.money, move || at, node, payer, &CK, era, entries, now_unix)).await
    }

    /// `node`'s listing for `era`, sealed under [`CK`] with `entries` and
    /// dated `now_unix`, written from the listing burner P(era) of the wallet
    /// key `wallet` by the listing's own seam
    /// ([`publish_node_presence_with`]) on the test's lease, fuse, network
    /// and chain, at the next instant ([`Self::later`]), with the random
    /// source seeded by `seed`: the write the heartbeat makes with burner
    /// keys on. The root is `wallet`'s on the test's network ([`root`]), and
    /// `wallet` is the SSF wallet whose spend in flight holds the era's first
    /// write, as the heartbeat names its own. Its future is checked to be
    /// `Send`, as the heartbeat's task needs it to be.
    async fn listing(&mut self, wallet: &SecretKey, node: &iroh::SecretKey, era: u64, entries: &[AddrEntry], now_unix: u64, seed: u64) -> Result<(Bytes32, MemoWrite)> {
        let at = self.later();
        let root = BurnerRoot::of(&MoneyKey::new(wallet.clone()), NET);
        let mut rng = StdRng::seed_from_u64(seed);
        let money = Payer::of(wallet);
        sendable(publish_node_presence_with(&self.lease, &self.fuse, NET, &self.money, at, &root, money, node, &CK, era, entries, now_unix, &mut rng)).await
    }

    /// The gifts the test's fuse counts against `era` ([`GiftFuse`]).
    fn gifts(&self, era: u64) -> u32 {
        self.fuse.lock().unwrap().gifts_in(era)
    }

    /// The test's fuse replaced by one that has counted a gift to each of
    /// `payers` in `era`: a fuse other burners have used, or blown.
    fn preset_fuse(&mut self, era: u64, payers: impl IntoIterator<Item = Payer>) {
        self.fuse = std::sync::Mutex::new(GiftFuse::preset(era, payers));
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
/// built as every writer the SSF wallet's keys pay for builds it
/// ([`memo_bundle`]): its bundle,
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

/// The dish's TAKE of `dish` to `recipient`, keyless and fee 0, built by
/// the builder `chia_faucet`'s claim uses ([`claim_spend`]).
fn claim(params: &FaucetParams, dish: Coin, recipient: Bytes32) -> SpendBundle {
    SpendBundle::new(vec![claim_spend(params, dish, recipient).unwrap()], Signature::default())
}

/// The lobby dish of the test's network, the one dish that funds a burner
/// (stage 4 design §5.1, R6 in §4.2).
fn lobby() -> FaucetParams {
    FaucetParams::lobby(NET)
}

/// The listing burner of test wallet `n` for `era`, under the contact key
/// [`CK`] (stage 4 design §3.2): each `n` is another node's burner.
fn burner(n: u8, era: u64) -> BurnerKey {
    BurnerRoot::of(&MoneyKey::new(wallet(n)), NET).presence(&CK, era)
}

/// Test wallet `n`'s burner root on the test's network (stage 4 design §3.2),
/// the one its listing burners and slots come from.
fn root(n: u8) -> BurnerRoot {
    BurnerRoot::of(&MoneyKey::new(wallet(n)), NET)
}

/// A listing's entries of the one address `addr`, with `flags`.
fn entries_of(addr: &str, flags: u8) -> Vec<AddrEntry> {
    vec![AddrEntry { addr: addr.parse().unwrap(), flags }]
}

/// One tick of the burner path's listing step ([`burner_listing_step`]) for
/// `node`'s listing from the wallet key `wallet`'s burners, at `peak`, in the
/// era it falls in, at `now`, with the live address set `sig` and the lease
/// holding no spend of the mark's: the facts the heartbeat gives the step,
/// built as it builds them, with `wallet` as the SSF wallet.
fn burner_step(clock: &mut ListingClock, wallet: &SecretKey, mark: Option<&NodePublishMark>, node: &iroh::SecretKey, (peak, now, sig): (u32, u64, &str), rng: &mut StdRng) -> ListingStep {
    let era = chia_lane::era_of(peak);
    let hint_of = |era: u64| hex::encode(chia_lane::derive_ck_hint(NET, &CK, era));
    let (hint, last_hint) = (hint_of(era), era.checked_sub(1).map(hint_of).unwrap_or_default());
    let root = BurnerRoot::of(&MoneyKey::new(wallet.clone()), NET);
    let (money, node_id) = (Payer::of(wallet).hex(), node.public().to_string());
    let facts = ListingFacts {
        mark,
        era,
        peak,
        now,
        sig,
        hint: &hint,
        last_hint: &last_hint,
        node_id: &node_id,
        spend_held: false,
        money: &money,
        root: &root,
        ck: &CK,
    };
    burner_listing_step(clock, &facts, rng)
}

/// That neither the Phone Book's words for the listing's failure `e`
/// ([`listing_failure_words`], with last week's listing working or not), the
/// heartbeat's log line for it on the burner path ([`listing_failure_line`])
/// nor the log's text of it (`{e:#}`) names the listing burner `key`: not
/// its payer text, the hex of its puzzle hash, and not its address on any
/// network. A log or a screen that named it would tie the listing's coin to
/// this station for whoever reads it, the link stage 4 design §2 closes.
fn names_no_burner(e: &anyhow::Error, key: &BurnerKey) {
    let hex = Payer::of_burner(key).hex();
    let addresses: Vec<String> =
        crate::chia_network::ChiaNet::ALL.iter().map(|net| chia_sdk_utils::Address::new(key.puzzle_hash(), net.prefix().to_string()).encode().unwrap()).collect();
    for text in [listing_failure_words(e, true), listing_failure_words(e, false), listing_failure_line(true, 0, e), format!("{e:#}")] {
        assert!(!text.contains(&hex), "{text}");
        assert!(addresses.iter().all(|a| !text.contains(a.as_str())), "{text}");
    }
}

/// `n` payers of burners no test writes for, from test wallets 100 up: what
/// a used fuse has counted.
fn strangers(n: u8) -> Vec<Payer> {
    (0..n).map(|i| Payer::of_burner(&burner(100 + i, 0))).collect()
}

/// Lobby dish coins of `amounts`, made in one block and then [`GAP_BLOCKS`]
/// blocks old, so each is ready to claim: the coins, and the height that
/// made them.
async fn ready_dishes(s: &Setup, amounts: &[u64]) -> (Vec<Coin>, u32) {
    let coins = amounts.iter().map(|amount| s.chain.fund(lobby().puzzle_hash(), *amount, None)).collect();
    let made = s.chain.farm().await;
    s.chain.farm_blocks(GAP_BLOCKS).await;
    (coins, made)
}

/// [`ready_dishes`] of one coin.
async fn ready_dish(s: &Setup, amount: u64) -> (Coin, u32) {
    let (coins, made) = ready_dishes(s, &[amount]).await;
    (coins[0], made)
}

/// The gift g the claim of `dish` makes at `key`, which the burner's write
/// spends in the same bundle (stage 4 design §4.1): its id is known before
/// anything is pushed.
fn gift(key: &BurnerKey, dish: Coin) -> Coin {
    Coin::new(dish.coin_id(), key.puzzle_hash(), lobby().gift)
}

/// The coin a write of `key`'s spending `parent` makes: 1 mojo at the
/// burner, the burner's one coin (R5, R7 in §4.2).
fn burner_coin(key: &BurnerKey, parent: Bytes32) -> Coin {
    Coin::new(parent, key.puzzle_hash(), 1)
}

/// Why a burner's write waited, if it did ([`BurnerWait`]), read as a
/// caller reads it, by downcasting.
fn waited(write: &Result<MemoWrite>) -> Option<BurnerWait> {
    write.as_ref().err().and_then(|e| e.downcast_ref::<BurnerWait>().copied())
}

/// The peers' reasons, if every peer refused a burner's push
/// ([`PushError::Rejected`]).
fn refused(write: &Result<MemoWrite>) -> Option<String> {
    match write.as_ref().err().and_then(|e| e.downcast_ref::<PushError>()) {
        Some(PushError::Rejected(why)) => Some(why.clone()),
        _ => None,
    }
}

/// The signatures `bundle` asks for, as (public key, the coin an AGG_SIG_ME
/// is over; `None` for any other kind): what the nodes checked its aggregate
/// against before they took it.
fn signatures(bundle: &SpendBundle) -> Vec<(PublicKey, Option<Vec<u8>>)> {
    let constants = AggSigConstants::from(NET.constants());
    let mut a = Allocator::new();
    RequiredSignature::from_coin_spends(&mut a, &bundle.coin_spends, &constants)
        .unwrap()
        .into_iter()
        .map(|required| match required {
            RequiredSignature::Bls(bls) => {
                let me = (bls.domain_string == Some(constants.me())).then(|| bls.appended_info.clone());
                (bls.public_key, me)
            }
            RequiredSignature::Secp(_) => panic!("no secp on a standard spend"),
        })
        .collect()
}

/// The one signature a burner's bundle asks for: `key`'s own AGG_SIG_ME over
/// `spent`, the coin its spend consumes (g for a first write), and no other
/// key's (stage 4 design §4.1).
fn signed_by_the_burner_alone(key: &BurnerKey, spent: Coin) -> Vec<(PublicKey, Option<Vec<u8>>)> {
    vec![(key.public_key().derive_synthetic(), Some(spent.coin_id().to_vec()))]
}

/// `future`, once the compiler has checked it is `Send`.
fn sendable<F: std::future::Future + Send>(future: F) -> F {
    future
}

/// The test's money lane, but a push it hands on comes back unanswered: the
/// bundle reached the nodes and the answer was lost, as on a timeout after
/// the send. Every other request is the lane's own.
struct Unacked<'a>(&'a PeerLane);

impl ChainAccess for Unacked<'_> {
    fn coin_records_by_hint(
        &self,
        hint: Bytes32,
        start_height: Option<u32>,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, ChainError>> + Send {
        self.0.coin_records_by_hint(hint, start_height, include_spent, cursor)
    }

    fn coin_records_by_puzzle_hash(
        &self,
        puzzle_hash: Bytes32,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, ChainError>> + Send {
        self.0.coin_records_by_puzzle_hash(puzzle_hash, include_spent, cursor)
    }

    fn coin_records_by_names(
        &self,
        names: Vec<Bytes32>,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl std::future::Future<Output = Result<crate::chia_chain::CoinListing, ChainError>> + Send {
        self.0.coin_records_by_names(names, include_spent, cursor)
    }

    fn puzzle_and_solution(
        &self,
        coin_id: Bytes32,
        height: u32,
    ) -> impl std::future::Future<Output = Result<Option<crate::chia_chain::PuzzleAndSolution>, ChainError>> + Send {
        self.0.puzzle_and_solution(coin_id, height)
    }

    fn peak_height(&self) -> impl std::future::Future<Output = Result<u32, ChainError>> + Send {
        self.0.peak_height()
    }

    fn spend_live(&self, bundle: SpendBundle) -> impl std::future::Future<Output = Result<bool, ChainError>> + Send {
        self.0.spend_live(bundle)
    }

    fn push_tx(&self, bundle: SpendBundle) -> impl std::future::Future<Output = Result<(), ChainError>> + Send {
        let pushed = self.0.push_tx(bundle);
        async move {
            pushed.await?;
            Err(ChainError::Unanswered(anyhow!("the answer was lost after the send (test chain)")))
        }
    }
}

/// The lease file at `path` as a build older than stage 4's payers rewrites
/// it, every `payer` gone from its bundles and settling spends (a rollback,
/// stage 4 design §8 (6)), and the test's lease restored from it again for
/// the money wallet `money`, as this build loads it on its next start: each
/// spend the file kept now reads as the money address's.
fn roll_back(s: &mut Setup, path: &std::path::Path, money: &SecretKey) {
    let mut file: serde_json::Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    for list in ["bundles", "settling"] {
        for entry in file.get_mut(list).and_then(serde_json::Value::as_array_mut).into_iter().flatten() {
            entry.as_object_mut().expect("an entry is an object").remove("payer");
        }
    }
    std::fs::write(path, serde_json::to_vec(&file).unwrap()).unwrap();
    s.lease = WalletLease::new();
    restore(&s.lease, path, money);
}

/// A spend of `coin`, the burner's, by a holder of `key` that is not this
/// lease (a cloned folder, or a stolen W: stage 4 design §10), sending its 1
/// mojo to `elsewhere`, signed and not parked.
fn spent_elsewhere(key: &BurnerKey, coin: Coin, elsewhere: Bytes32) -> SpendBundle {
    let mut ctx = SpendContext::new();
    let conditions = Conditions::new().create_coin(elsewhere, coin.amount, chia_puzzle_types::Memos::None);
    StandardLayer::new(key.public_key().derive_synthetic()).spend(&mut ctx, coin, conditions).unwrap();
    key.sign_spends(NET, ctx.take()).unwrap()
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
/// and neither node is let go. The write's mark files its one coin as its
/// parked input too, and the wallet as its payer (stage 4 design §4.4); the
/// same mark as an older node saved it, with neither, is judged the same at
/// every step.
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
    let write = MemoWrite { coins: WriteCoins::one(coin.coin_id()), acked: true, spend: Some(spend), memo, payer: Payer::of(&payer) };
    let made = NodePublishMark::written(0, 1, "a".into(), unix_now(), hint, &write, node.public().to_string());
    // The mark files the write's one coin as its parked input too, and the
    // wallet that paid as its payer (stage 4 design §4.4). The same mark as
    // an older node saved it, with neither, is judged the same at every step.
    let one = hex::encode(coin.coin_id());
    assert_eq!((made.coin_id.as_str(), made.parked.as_str(), made.payer.clone()), (one.as_str(), one.as_str(), Some(Payer::of(&payer).hex())));
    let older = |mark: &NodePublishMark| NodePublishMark { parked: String::new(), payer: None, ..mark.clone() };
    let word = presence_standing_on(&s.lease, NET, &s.money, &made).await;
    assert_eq!(word, Some((WriteStanding::Confirmed { height: landed, seen_at: Some(landed) }, false)));
    assert_eq!(presence_standing_on(&s.lease, NET, &s.money, &older(&made)).await, word, "an older node's mark of it, judged as before");
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
    assert_eq!(presence_standing_on(&s.lease, NET, &s.money, &older(&mark)).await, word, "an older node's mark of it, judged as before");
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
    let word = presence_standing_on(&s.lease, NET, &s.money, &again).await;
    assert_eq!(word, Some((WriteStanding::Dead("its coin went to another spend of ours"), false)), "the mark's own reader says so too");
    assert_eq!(presence_standing_on(&s.lease, NET, &s.money, &older(&again)).await, word, "an older node's mark of it, judged as before");
    assert_eq!(presence_step(&again, word, 0, s.chain.peak()), PresenceStep::Void("never landed — its coin went to another spend of ours".into()));

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

/// Stage 4 design §4.1, §5.1 and §5.2, the table's first row: a burner
/// holding no coin is funded by the claim of the one ready lobby coin F in
/// its write's own bundle. The bundle is two spends, F's claim and the gift
/// g's, with one signature, the burner's over g, and no fee; the body is
/// sealed knowing g, its coin's parent; F is parked under the burner as its
/// payer, never g, and the write names that payer; and the gift is counted
/// once in the fuse. While F is parked, the burner's next write waits and
/// nothing more is built. Once it lands, g is made and spent in one block,
/// F's remainder is back at the dish, and the resolver's reader opens the
/// record through g, its parent.
/// The write's verdict, by g under the hint and by F as its input, is
/// confirmed. The lease keeps F settling as the burner's spend, which holds
/// back a second gift (`holds_for`) and not the burner's own writes, whose
/// next one spends the coin this one made
/// (`a_burner_holding_its_coin_writes_from_it_and_is_given_no_second_gift`).
#[tokio::test]
async fn a_claim_and_write_lands_and_the_resolver_opens_the_record_through_the_ephemeral_parent() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 10).await;
    let (key, node) = (burner(30, 0), iroh::SecretKey::generate());
    let payer = Payer::of_burner(&key);
    let g = gift(&key, f);
    let written = burner_coin(&key, g.coin_id());
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let mut handed = None;
    let body = |parent: Bytes32| -> Result<Vec<u8>> {
        handed = Some(parent);
        Ok(memo)
    };
    let write = s.burner_write(&key, 0, hint, None, body, 1).await.unwrap();
    assert_eq!(handed, Some(g.coin_id()), "the body is sealed knowing g, its coin's parent");
    assert_eq!(write.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() });
    assert!(write.acked);
    assert!(write.spend.is_some() && write.spend == s.lease.spend_of(&f.coin_id()), "F parked, under the write's spend");
    assert!(!s.lease.is_parked(&g.coin_id()), "never g");
    assert_eq!(write.payer, payer, "the write names the burner as its payer, the one F is parked under");
    let bundle = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(bundle.coin_spends.iter().map(|cs| cs.coin).collect::<Vec<_>>(), vec![f, g], "two spends: F's claim, then g's");
    assert_eq!(s.chain.fee_of(&bundle), 0);
    assert_eq!(signatures(&bundle), signed_by_the_burner_alone(&key, g));
    assert_eq!(write.memo, memo_of(&bundle, hint), "the digest the write keeps is the one its readers take");
    assert_eq!(s.gifts(0), 1, "one gift counted");

    assert!(s.lease.outgoing_pending_for(payer));
    let again = s.burner_write(&key, 0, hint, None, |_| Ok(b"a second record".to_vec()), 2).await;
    assert_eq!(waited(&again), Some(BurnerWait::Held), "F still parked: the burner's next write waits");
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "nothing more built");
    assert_eq!(s.gifts(0), 1);

    let landed = s.chain.farm().await;
    assert_eq!(s.chain.record(g.coin_id()), Some((g, landed, Some(landed))), "g made and spent in one block");
    let mut dished = vec![g, Coin::new(f.coin_id(), lobby().puzzle_hash(), 9)];
    dished.sort_by_key(Coin::coin_id);
    assert_eq!(s.chain.children(f.coin_id()), dished, "g, and F's remainder back at the dish");
    assert_eq!(s.chain.children(g.coin_id()), vec![written]);
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(
        found.iter().map(|r| (r.record.node_id.clone(), r.coin_id, r.confirmed_height, r.hint)).collect::<Vec<_>>(),
        vec![(node.public().to_string(), written.coin_id(), landed, hint)],
        "the record, opened through its parent g"
    );
    assert_eq!(
        child_under_hint(&s.money, hint, g.coin_id(), Some(write.memo)).await.unwrap(),
        HintChild::Confirmed { height: landed, judged_at: Some(landed) }
    );
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert!(
        s.lease.is_settling(&f.coin_id()) && s.lease.holds_for(payer) && !s.lease.outgoing_pending_for(payer),
        "F settling as the burner's: no gift while it settles, and the burner's own writes go"
    );
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, the reorg row: a claim and write lands and is
/// confirmed, and a reorganization replaces its block by a fork whose first
/// block holds a stranger's claim of the dish coin F1 (and makes another
/// lobby coin, F2). The saved bundle is dead, a double spend at every node.
/// The write reads pending while the lease keeps its bundle settling, and
/// the burner, holding no coin, is not funded again meanwhile (§5.2): the
/// fork could still go and bring the bundle back. Once F1 is spent
/// SETTLED_DEPTH deep the write reads dead, in today's words (PR 10 tells a
/// stranger's claim from a spend of ours), and the burner's next write is
/// built again from F2, its body sealed knowing the new gift g2. It lands
/// and is read through g2. The fuse gave the dead bundle's gift back, so
/// the burner has one gift counted, as it has one landed.
#[tokio::test]
async fn a_reorg_that_gives_the_dish_coin_to_another_claimer_has_the_write_built_again_from_another_coin() {
    let mut s = setup().await;
    // One mojo, so the claim leaves no remainder that could come to be ready.
    let (f1, _) = ready_dish(&s, 1).await;
    let (key, node) = (burner(31, 0), iroh::SecretKey::generate());
    let payer = Payer::of_burner(&key);
    let g1 = gift(&key, f1);
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(memo), 1).await.unwrap();
    let saved = s.chain.received().last().cloned().expect("the write was sent");
    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert!(s.lease.is_settling(&f1.coin_id()));

    let f2 = s.chain.fund(lobby().puzzle_hash(), 1, None);
    let stranger = Bytes32::new([0x57; 32]);
    let peak = s.chain.reorg_including(1, vec![claim(&lobby(), f1, stranger)]).await;
    assert_eq!(peak, landed + 1);
    assert_eq!(s.chain.record(f1.coin_id()).unwrap().2, Some(landed), "F1 spent at the same height, by the stranger's claim");
    assert_eq!(s.chain.children(f1.coin_id()), vec![Coin::new(f1.coin_id(), stranger, 1)]);
    assert_eq!(s.chain.record(g1.coin_id()), None, "g1 is on no chain");
    assert_eq!(s.chain.record(f2.coin_id()), Some((f2, landed, None)));
    let acks = s.chain.acks_for(saved.name()).len();
    assert!(!s.money.spend_live(saved.clone()).await.unwrap(), "a double spend everywhere: dead");
    assert_eq!(s.chain.acks_for(saved.name()).split_off(acks), vec![(FAILED, Some("DOUBLE_SPEND".to_string())); 2]);

    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Pending, "the lease still holds the bundle");
    assert!(s.lease.is_settling(&f1.coin_id()) && s.lease.holds_for(payer));
    let waiting = s.burner_write(&key, 0, hint, None, |_| Ok(b"not yet".to_vec()), 2).await;
    assert_eq!(waited(&waiting), Some(BurnerWait::Settling), "no coin, and a bundle of its settling: no second gift yet");
    assert_eq!(s.gifts(0), 1);

    s.chain.farm_blocks(SETTLED_DEPTH).await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Dead("its coin went to another spend of ours"));
    assert!(!s.lease.holds_for(payer));

    let (again_hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    assert_eq!(again_hint, hint);
    let mut handed = None;
    let body = |parent: Bytes32| -> Result<Vec<u8>> {
        handed = Some(parent);
        Ok(memo)
    };
    let second = s.burner_write(&key, 0, hint, None, body, 3).await.unwrap();
    let g2 = gift(&key, f2);
    assert_ne!(g2, g1);
    assert_eq!(handed, Some(g2.coin_id()), "sealed again, to the new gift");
    assert_eq!(second.coins, WriteCoins { parent: g2.coin_id(), parked: f2.coin_id() });
    assert_eq!(s.gifts(0), 1, "the dead bundle's gift given back, the new one counted");
    let rebuilt = s.chain.received().last().cloned().expect("the write was sent");
    let again = s.chain.farm().await;
    let found = read_ck(NET, &s.carrier, &CK, again, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(
        found.iter().map(|r| (r.record.node_id.clone(), r.coin_id, r.confirmed_height)).collect::<Vec<_>>(),
        vec![(node.public().to_string(), burner_coin(&key, g2.coin_id()).coin_id(), again)],
        "the record, through g2"
    );
    assert_eq!(s.judge_split(hint, second.coins, second.memo, second.spend).await, WriteStanding::Confirmed { height: again, seen_at: Some(again) });
    assert_eq!(s.sent(), HashSet::from([saved.name(), rebuilt.name()]));
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, the reorg row, and §14 (5): a claim and write lands
/// and is confirmed, and a reorganization drops its block, F still on the
/// chain. F and g read as they were before the claim (F unspent, g on no
/// chain), the write reads pending, and the lease parks the bundle again
/// under its own number, F the one input it lists, so its probe pushes the
/// saved two-spend bundle again, one signature and no fee, as built. The
/// burner's next write meanwhile waits, and no second gift is counted. The
/// bundle lands on the new fork, with the same g, and is confirmed and read
/// there.
#[tokio::test]
async fn a_reorg_drops_a_claim_and_write_and_the_lease_pushes_its_saved_two_spend_bundle_again_until_it_lands() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 10).await;
    let (key, node) = (burner(32, 0), iroh::SecretKey::generate());
    let g = gift(&key, f);
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let write = s.burner_write(&key, 0, hint, None, |_| Ok(memo), 1).await.unwrap();
    let spend = write.spend.expect("parked under a spend");
    let bundle = s.chain.received().last().cloned().expect("the write was sent");
    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert!(s.lease.is_settling(&f.coin_id()));

    let peak = s.chain.reorg(1).await;
    assert_eq!(peak, landed + 1);
    assert_eq!(s.chain.record(f.coin_id()).unwrap().2, None, "F's claim is undone");
    assert_eq!(s.chain.record(g.coin_id()), None, "g is on no chain");
    assert!(s.chain.children(f.coin_id()).is_empty() && s.chain.mempool().is_empty());
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Pending);
    assert!(s.lease.is_parked(&f.coin_id()) && s.lease.holds_spend(spend), "parked again under its own number");
    assert!(!s.lease.is_parked(&g.coin_id()));

    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![bundle.name()], "the probe pushed the saved bundle");
    let waiting = s.burner_write(&key, 0, hint, None, |_| Ok(b"not yet".to_vec()), 2).await;
    assert_eq!(waited(&waiting), Some(BurnerWait::Held));
    assert_eq!(s.gifts(0), 1, "no second gift");

    let again = s.chain.farm().await;
    assert_eq!(again, landed + 2);
    assert_eq!(s.chain.record(g.coin_id()), Some((g, again, Some(again))), "the same g, made and spent on the new fork");
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: again, seen_at: Some(again) });
    let found = read_ck(NET, &s.carrier, &CK, again, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(found.iter().map(|r| (r.coin_id, r.confirmed_height)).collect::<Vec<_>>(), vec![(burner_coin(&key, g.coin_id()).coin_id(), again)]);
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "one bundle, never built again");
    assert_eq!(bundle.coin_spends.len(), 2);
    assert_eq!(signatures(&bundle), signed_by_the_burner_alone(&key, g));
    assert_eq!(s.chain.fee_of(&bundle), 0);
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, the mempool-full row, for a claim and write. A full
/// mempool refuses its fee-0 bundle, which reads as the chain busy
/// ([`chain_busy`]) and is a refusal, not a wait: F is handed back and no
/// gift is counted. Once it clears, the write is built again, the same
/// bundle with no fee added, and lands. A second burner's claim and write
/// is taken, probed while it waits in the mempool, and then evicted from a
/// full one, whose refusal is no final word: its dish coin stays parked,
/// and the burner's next write waits. Once the mempool clears, the probe
/// pushes the saved two-spend bundle, which lands as built.
#[tokio::test]
async fn a_full_mempool_holds_a_claim_and_write_and_it_lands_once_cleared_with_no_fee_added() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let key = burner(33, 0);
    let g = gift(&key, f);
    let hint = Bytes32::new([0x52; 32]);
    let body = b"a first record, held by a full mempool".to_vec();
    s.chain.set_full(true);
    let first = body.clone();
    let turned_away = s.burner_write(&key, 0, hint, None, move |_| Ok(first), 1).await;
    let why = refused(&turned_away).expect("every peer refused the push");
    assert!(why.contains("INVALID_FEE_TOO_CLOSE_TO_ZERO"), "{why}");
    let e = turned_away.as_ref().err().expect("refused");
    assert!(chain_busy(e), "the nodes' own refusal reads as the chain busy: {e:#}");
    assert!(!is_typed_wait(e), "and is a refusal, not a wait (§10)");
    assert!(!s.lease.is_taken(&f.coin_id()), "a refusal hands F back");
    assert_eq!(s.gifts(0), 0, "a refused push counts no gift");
    assert!(s.chain.mempool().is_empty());

    s.chain.set_full(false);
    let write = s.burner_write(&key, 0, hint, None, move |_| Ok(body), 2).await.unwrap();
    let bundle = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "built again, the same bundle: no fee added");
    assert_eq!(bundle.coin_spends.len(), 2);
    let landed = s.chain.farm().await;
    assert_eq!(s.chain.fee_of(&bundle), 0);
    assert_eq!(s.chain.children(g.coin_id()), vec![burner_coin(&key, g.coin_id())]);
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.gifts(0), 1);

    let (f2, _) = ready_dish(&s, 1).await;
    let other = burner(34, 0);
    let held = s.burner_write(&other, 0, hint, None, |_| Ok(b"a second burner's record".to_vec()), 3).await.unwrap();
    assert_eq!(held.coins.parked, f2.coin_id());
    let second = s.chain.received().last().cloned().expect("the write was sent");
    s.reconcile().await;
    assert!(s.lease.is_parked(&f2.coin_id()), "live in the mempool");
    s.chain.evict_all();
    s.chain.set_full(true);
    s.reconcile().await;
    assert!(s.lease.is_parked(&f2.coin_id()), "a full mempool is no final word");
    let full = (FAILED, Some("INVALID_FEE_TOO_CLOSE_TO_ZERO".to_string()));
    assert_eq!(s.chain.acks_for(second.name()).split_off(4), vec![full; 2]);
    s.chain.farm().await;
    assert_eq!(s.chain.record(f2.coin_id()).unwrap().2, None);
    let waiting = s.burner_write(&other, 0, hint, None, |_| Ok(b"not yet".to_vec()), 4).await;
    assert_eq!(waited(&waiting), Some(BurnerWait::Held), "its dish coin is still parked");
    assert_eq!(s.gifts(0), 2, "one gift per burner");

    s.chain.set_full(false);
    s.reconcile().await;
    assert_eq!(s.chain.mempool(), vec![second.name()], "the probe pushed the saved bundle");
    let again = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, held.coins, held.memo, held.spend).await, WriteStanding::Confirmed { height: again, seen_at: Some(again) });
    assert_eq!((second.coin_spends.len(), s.chain.fee_of(&second)), (2, 0), "two spends, no fee added");
    assert_eq!(s.sent(), HashSet::from([bundle.name(), second.name()]), "the saved bundle, never built again");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §5.2, one landed gift per key, and §4.1, the rewrite row:
/// a burner holding its 1-mojo coin writes from it and is never given a
/// second gift. Right after its first write lands, while the lease still
/// keeps F settling, its next write spends the coin the first one made: one
/// spend, its own signature over that coin, the burner named as its payer,
/// no lobby coin spent and no gift counted. Settled SETTLED_DEPTH deep, with
/// the lease holding nothing of the burner's, a lobby coin ready and the fuse
/// blown for the era, its next write is a rewrite again.
#[tokio::test]
async fn a_burner_holding_its_coin_writes_from_it_and_is_given_no_second_gift() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let key = burner(35, 0);
    let payer = Payer::of_burner(&key);
    let hint = Bytes32::new([0x53; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a first record".to_vec()), 1).await.unwrap();
    let written = burner_coin(&key, gift(&key, f).coin_id());
    let spare = s.chain.fund(lobby().puzzle_hash(), 10, None);
    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert!(s.lease.is_settling(&f.coin_id()) && s.lease.holds_for(payer));

    let mut handed = None;
    let body = |parent: Bytes32| -> Result<Vec<u8>> {
        handed = Some(parent);
        Ok(b"a rewrite".to_vec())
    };
    let rewrite = s.burner_write(&key, 0, hint, None, body, 2).await.unwrap();
    assert_eq!(handed, Some(written.coin_id()), "the body is sealed knowing the coin it spends");
    assert_eq!(rewrite.coins, WriteCoins::one(written.coin_id()), "written from the burner's own coin");
    assert_eq!(rewrite.spend, s.lease.spend_of(&written.coin_id()));
    assert_eq!(rewrite.payer, payer, "the rewrite names the burner as its payer");
    let bundle = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(bundle.coin_spends.iter().map(|cs| cs.coin).collect::<Vec<_>>(), vec![written], "one spend, of the burner's own coin");
    assert_eq!(signatures(&bundle), signed_by_the_burner_alone(&key, written));
    assert_eq!(s.gifts(0), 1, "no second gift");
    let next = burner_coin(&key, written.coin_id());
    let rewritten = s.chain.farm().await;
    assert_eq!(s.chain.children(written.coin_id()), vec![next]);
    assert_eq!(s.chain.fee_of(&bundle), 0);
    assert_eq!(s.judge_split(hint, rewrite.coins, rewrite.memo, rewrite.spend).await, WriteStanding::Confirmed { height: rewritten, seen_at: Some(rewritten) });

    s.chain.farm_blocks(SETTLED_DEPTH).await;
    s.reconcile().await;
    assert!(!s.lease.holds_for(payer), "settled: the lease holds nothing of the burner's");
    s.preset_fuse(0, strangers(16));
    let again = s.burner_write(&key, 0, hint, None, |_| Ok(b"a rewrite past a blown fuse".to_vec()), 3).await.unwrap();
    assert_eq!(again.coins, WriteCoins::one(next.coin_id()), "the fuse holds back gifts, never a rewrite");
    assert_eq!(s.gifts(0), 16);
    let last = s.chain.farm().await;
    assert_eq!(s.chain.children(next.coin_id()), vec![burner_coin(&key, next.coin_id())]);
    assert_eq!(s.chain.record(spare.coin_id()), Some((spare, landed, None)), "the ready lobby coin, never spent");
    assert_eq!(s.chain.record(f.coin_id()).unwrap().2, Some(landed));
    assert_eq!(s.judge_split(hint, again.coins, again.memo, again.spend).await, WriteStanding::Confirmed { height: last, seen_at: Some(last) });
    assert_eq!(s.sent().len(), 3, "three writes, one gift");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, the crash row, for a claim and write: a stop between
/// the parking and the push. The bundle was built and parked under the
/// burner as its payer and never sent; the next run restores the lease with
/// the money wallet, reads the burner back as the payer of the spend that
/// parks F, and so holds the burner's next write. Its reconciliation pushes
/// the saved two-spend bundle, which lands once: F gives one gift, and the
/// one bundle sent is the one built before the stop.
#[tokio::test]
async fn a_restart_mid_claim_and_write_pushes_the_saved_two_spend_bundle_and_funds_the_burner_once() {
    let mut s = setup().await;
    let dir = Dir::new("restart-claim");
    let path = dir.0.join("wallet_lease.json");
    let money = wallet(36);
    let (key, node) = (burner(36, 0), iroh::SecretKey::generate());
    let payer = Payer::of_burner(&key);
    let (f, made) = ready_dish(&s, 10).await;
    let g = gift(&key, f);
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let claimed = dish_claim(&lobby(), FaucetCoin { coin: f, confirmed_height: made }, key.puzzle_hash()).unwrap();
    let built = build_burner_bundle(NET, &key, &BurnerInput::Claim(claimed), hint, memo).unwrap();

    let before = WalletLease::new();
    restore(&before, &path, &money);
    park_for(&before, payer, &built.bundle, &[(f.coin_id(), made)]);
    drop(before);
    assert!(s.chain.received().is_empty(), "the push never left");

    s.lease = WalletLease::new();
    restore(&s.lease, &path, &money);
    assert!(s.lease.is_parked(&f.coin_id()) && !s.lease.is_parked(&g.coin_id()));
    assert!(s.lease.outgoing_pending_for(payer) && !s.lease.outgoing_pending_for(Payer::of(&money)), "the burner, read back from the file as the payer");
    let waiting = s.burner_write(&key, 0, hint, None, |_| Ok(b"not yet".to_vec()), 1).await;
    assert_eq!(waited(&waiting), Some(BurnerWait::Held), "the restored spend holds the burner's writes");
    assert_eq!(s.chain.mempool(), vec![built.bundle.name()], "its reconciliation pushed the saved bundle");

    let landed = s.chain.farm().await;
    let mut dished = vec![g, Coin::new(f.coin_id(), lobby().puzzle_hash(), 9)];
    dished.sort_by_key(Coin::coin_id);
    assert_eq!(s.chain.children(f.coin_id()), dished, "one gift");
    assert_eq!(s.chain.children(g.coin_id()), vec![built.written]);
    let spend = s.lease.spend_of(&f.coin_id());
    assert!(spend.is_some());
    assert_eq!(s.judge_split(hint, built.coins, built.memo, spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.sent(), HashSet::from([built.bundle.name()]), "the saved bundle, never built again");
    assert!(s.lease.is_settling(&f.coin_id()));
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.1, the knock row: the burner writer hands its body g's
/// id, the parent its coin will name, so a knock sealed in the body binds
/// the carrier it lands as. The knock, written from its own burner K(h)
/// under the gate (held while its body is sealed, let go after), opens for
/// the host, with the knocker's contact key. A control knock built by hand
/// from another dish coin, sealed to that dish coin's id (the input the
/// lease parks) rather than to its gift, lands under the same hint and does
/// not open. The knock book's entry for the write (§4.4) files g as its coin
/// id, F as its parked input and the knock burner as its payer: its coins
/// read back as the write's and are confirmed at the height it landed, and
/// the book confirms the entry by g under the hint.
#[tokio::test]
async fn a_claim_and_write_hands_its_body_the_gift_so_a_knock_sealed_in_it_opens_for_the_host() {
    let mut s = setup().await;
    let host = iroh::SecretKey::generate();
    let host_kx = crate::chia_contact::kx_card_secret(&host);
    let ck_host = [33u8; 32];
    let req = KnockRequest {
        room: ROOM.into(),
        host: host.public().to_string(),
        ck_host,
        kx_host: crate::chia_contact::kx_public(&host_kx),
        attempts: 0,
    };
    let hint = knock_hint(NET, &req, &ROOM_KEY, 0);
    let (knocker_node, forger_node) = (iroh::SecretKey::generate(), iroh::SecretKey::generate());
    let key = BurnerRoot::of(&MoneyKey::new(wallet(37)), NET).knock(&hint.to_bytes(), 0);
    let control_key = BurnerRoot::of(&MoneyKey::new(wallet(38)), NET).knock(&hint.to_bytes(), 0);
    let (coins, made) = ready_dishes(&s, &[10, 10]).await;
    let (f, f2) = (coins[0], coins[1]);
    let issued = unix_now();
    let ck_from = [43u8; 32];

    let control_claim = dish_claim(&lobby(), FaucetCoin { coin: f2, confirmed_height: made }, control_key.puzzle_hash()).unwrap();
    let sealed_to_f2 = knock_memo(NET, &forger_node, &req, &ROOM_KEY, 0, f2.coin_id(), None, issued).unwrap();
    let control = build_burner_bundle(NET, &control_key, &BurnerInput::Claim(control_claim), hint, sealed_to_f2).unwrap();
    push_for(&s.lease, &s.money, Payer::of_burner(&control_key), &control.bundle, &[(f2.coin_id(), made)]).await.unwrap();

    let gate = tokio::sync::Mutex::new(());
    let body = |parent: Bytes32| {
        assert!(gate.try_lock().is_err(), "the body is sealed under the gate");
        knock_memo(NET, &knocker_node, &req, &ROOM_KEY, 0, parent, Some(ck_from), issued)
    };
    let write = s.burner_write(&key, 0, hint, Some(&gate), body, 1).await.unwrap();
    let g = gift(&key, f);
    assert_eq!(write.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() }, "the dish coin the control left");
    assert!(gate.try_lock().is_ok(), "the gate is let go");
    let landed = s.chain.farm().await;
    let listed = s.money.coin_records_by_hint(hint, None, true, None).await.unwrap();
    assert_eq!(listed.records.len(), 2, "both knocks are under the host's inbox hint");

    let opened = read_inbox(NET, &s.carrier, &host_kx, &ck_host, &ROOM_KEY, ROOM, landed, issued, &mut HashMap::new()).await.unwrap();
    assert_eq!(opened.iter().map(|o| (o.item.from, o.item.ck_from)).collect::<Vec<_>>(), vec![(knocker_node.public(), Some(ck_from))]);
    assert_eq!((opened[0].coin_id, opened[0].confirmed_height), (burner_coin(&key, g.coin_id()).coin_id(), landed));
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });

    // The knock book's entry files the write whole (§4.4): g as its coin id,
    // F as its parked input and the knock burner as its payer. Read back, its
    // coins are the write's, its verdict is the write's, and the book
    // confirms it by g under the hint, never by F.
    let entry = sent_knock_of(&req, 0, hint, &write, issued);
    let (g_hex, f_hex, hint_hex) = (hex::encode(g.coin_id()), hex::encode(f.coin_id()), hex::encode(hint));
    assert_eq!(
        (entry.coin_id.as_str(), entry.parked.as_str(), entry.payer.clone()),
        (g_hex.as_str(), f_hex.as_str(), Some(Payer::of_burner(&key).hex())),
        "the entry files g, F and the knock burner"
    );
    let filed = WriteCoins::filed(&entry.coin_id, &entry.parked);
    assert_eq!(filed, Some(write.coins), "the entry's coins read back as the write's");
    let digest = crate::chia_resolve::parse_hex32(&entry.memo).expect("the entry keeps its memo's digest");
    assert_eq!(s.judge_split(hint, filed.unwrap(), digest, entry.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    let mut book = KnockBook::default();
    book.record_sent(entry);
    assert!(book.knocked_this_era(&req.host, 0));
    assert!(!book.confirm_sent(&f_hex, &hint_hex, landed), "the book names the entry by g, not by its dish coin");
    assert!(book.confirm_sent(&g_hex, &hint_hex, landed), "confirmed by g under the hint");
    assert_eq!(book.sent.iter().map(|k| k.confirmed_height).collect::<Vec<_>>(), vec![landed]);
    assert!(book.pending_sent().is_empty());
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.1 and §4.4, the marks: a burner's first write filed in
/// the presence mark and the beacon mark names its two coins and its payer,
/// the gift g as its coin id, the dish coin F as its parked input and the
/// burner. Each mark's own reader judges it: pending in the mempool, then
/// confirmed at the height it landed, by its coin under the hint, which
/// names g as its parent. The presence step saves it as seen on chain and the
/// beacon step as confirmed, both coins and the payer kept. A landed write
/// reads confirmed whatever its parked input says; that the readers ask
/// about F is shown by a write that dies, in the stranger-claim test below. The burner's rewrite, from the coin the first write made,
/// is filed with that one coin as both and is confirmed at its own height.
#[tokio::test]
async fn a_burners_first_write_filed_in_its_mark_is_confirmed_by_its_gift_under_the_hint_and_its_rewrite_by_its_one_coin() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 10).await;
    let (key, node) = (burner(54, 0), iroh::SecretKey::generate());
    let payer = Payer::of_burner(&key).hex();
    let g = gift(&key, f);
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let write = s.burner_write(&key, 0, hint, None, |_| Ok(memo), 1).await.unwrap();
    assert_eq!(write.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() });

    // One write filed in both marks under its hint, so that each reader
    // judges the coins and the hint its own mark names. The beacon's own
    // writer moves to a burner in a later PR (§13 row 10).
    let mark = NodePublishMark::written(0, 1, "a".into(), unix_now(), hint, &write, node.public().to_string());
    let beacon = BeaconMark::written(0, unix_now(), hint, &write, node.public().to_string());
    let (g_hex, f_hex) = (hex::encode(g.coin_id()), hex::encode(f.coin_id()));
    let filed = (g_hex.as_str(), f_hex.as_str(), Some(payer.as_str()));
    assert_eq!((mark.coin_id.as_str(), mark.parked.as_str(), mark.payer.as_deref()), filed, "the presence mark files g, F and the burner");
    assert_eq!((beacon.coin_id.as_str(), beacon.parked.as_str(), beacon.payer.as_deref()), filed, "and so does the beacon mark");
    s.reconcile().await;
    let pending = Some((WriteStanding::Pending, false));
    assert_eq!(presence_standing_on(&s.lease, NET, &s.money, &mark).await, pending, "in the mempool, F parked");
    assert_eq!(beacon_standing_on(&s.lease, NET, &s.money, &beacon).await, pending);

    let landed = s.chain.farm().await;
    s.reconcile().await;
    let confirmed = Some((WriteStanding::Confirmed { height: landed, seen_at: Some(landed) }, false));
    let word = presence_standing_on(&s.lease, NET, &s.money, &mark).await;
    assert_eq!(word, confirmed, "g under the hint: confirmed");
    let PresenceStep::Save(seen) = presence_step(&mark, word, 0, landed) else { panic!("confirmed: saved") };
    assert!(seen.chain_seen && seen.confirmed_height == landed, "{seen:?}");
    assert_eq!((seen.coin_id.as_str(), seen.parked.as_str(), seen.payer.as_deref()), filed, "saved with its coins and its payer");
    let word = beacon_standing_on(&s.lease, NET, &s.money, &beacon).await;
    assert_eq!(word, confirmed);
    let BeaconStep::Save(saved) = beacon_step(&beacon, word, 0, landed) else { panic!("confirmed: saved") };
    assert!(saved.confirmed && saved.confirmed_height == landed, "{saved:?}");
    assert_eq!((saved.coin_id.as_str(), saved.parked.as_str(), saved.payer.as_deref()), filed, "saved with its coins and its payer");

    // The rewrite spends the coin the first write made, and its mark files
    // that one coin as both.
    let written = burner_coin(&key, g.coin_id());
    let (again_hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    assert_eq!(again_hint, hint);
    let rewrite = s.burner_write(&key, 0, hint, None, |_| Ok(memo), 2).await.unwrap();
    assert_eq!(rewrite.coins, WriteCoins::one(written.coin_id()), "written from the burner's own coin");
    let rewritten_mark = NodePublishMark::written(0, 2, "a".into(), unix_now(), hint, &rewrite, node.public().to_string());
    let one = hex::encode(written.coin_id());
    assert_eq!(
        (rewritten_mark.coin_id.as_str(), rewritten_mark.parked.as_str(), rewritten_mark.payer.as_deref()),
        (one.as_str(), one.as_str(), Some(payer.as_str())),
        "the rewrite's mark files its one coin as both, and the burner"
    );
    let rewritten = s.chain.farm().await;
    assert!(rewritten > landed);
    s.reconcile().await;
    let word = presence_standing_on(&s.lease, NET, &s.money, &rewritten_mark).await;
    assert_eq!(word, Some((WriteStanding::Confirmed { height: rewritten, seen_at: Some(rewritten) }, false)));
    let PresenceStep::Save(seen) = presence_step(&rewritten_mark, word, 0, rewritten) else { panic!("confirmed: saved") };
    assert!(seen.chain_seen && seen.confirmed_height == rewritten && seen.writes == 2, "{seen:?}");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.4 and §10, a lost race read through the marks: our
/// claim and write is filed in the presence mark and the beacon mark, and a
/// stranger's claim of its dish coin F lands first. Both readers say pending
/// while the lease keeps the bundle settling, and once F is spent
/// SETTLED_DEPTH deep, dead, in today's words (PR 10 tells a stranger's
/// claim from a spend of ours): the presence step voids its mark and the
/// beacon step forgets its own, so each is due again. The same marks
/// without their parked input, one coin read back as both, read pending for
/// ever and are kept, which would block the beacon for the era: g is on no
/// chain and the lease never parked it, so nothing the chain or the lease
/// says of it can ever settle the write. That is why a mark files F.
#[tokio::test]
async fn a_burners_first_write_whose_dish_coin_a_stranger_claimed_reads_dead_from_its_mark_once_settled_and_pending_for_ever_without_its_parked_input() {
    let mut s = setup().await;
    // One mojo, so the stranger's claim leaves no remainder at the dish.
    let (f, _) = ready_dish(&s, 1).await;
    let (key, node) = (burner(55, 0), iroh::SecretKey::generate());
    let payer = Payer::of_burner(&key);
    let g = gift(&key, f);
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let write = s.burner_write(&key, 0, hint, None, |_| Ok(memo), 1).await.unwrap();
    // One write filed in both marks, as in the test before: each reader
    // judges the coins and the hint its own mark names.
    let mark = NodePublishMark::written(0, 1, "a".into(), unix_now(), hint, &write, node.public().to_string());
    let beacon = BeaconMark::written(0, unix_now(), hint, &write, node.public().to_string());
    let (g_hex, f_hex) = (hex::encode(g.coin_id()), hex::encode(f.coin_id()));
    assert_eq!((mark.coin_id.as_str(), mark.parked.as_str()), (g_hex.as_str(), f_hex.as_str()));
    assert_eq!((beacon.coin_id.as_str(), beacon.parked.as_str()), (g_hex.as_str(), f_hex.as_str()));
    let one_coin = NodePublishMark { parked: String::new(), ..mark.clone() };
    let one_coin_beacon = BeaconMark { parked: String::new(), ..beacon.clone() };

    let stranger = Bytes32::new([0x65; 32]);
    s.chain.include_next(claim(&lobby(), f, stranger));
    s.chain.farm().await;
    assert_eq!(s.chain.children(f.coin_id()), vec![Coin::new(f.coin_id(), stranger, 1)], "the stranger's claim took F");
    assert!(s.chain.mempool().is_empty(), "the block spent F, so the mempools let our bundle go");
    assert_eq!(s.chain.record(g.coin_id()), None, "g is on no chain");
    s.reconcile().await;
    let pending = Some((WriteStanding::Pending, false));
    assert_eq!(presence_standing_on(&s.lease, NET, &s.money, &mark).await, pending, "the lease still holds the bundle");
    assert_eq!(beacon_standing_on(&s.lease, NET, &s.money, &beacon).await, pending);
    assert!(s.lease.is_settling(&f.coin_id()) && s.lease.holds_for(payer));

    s.chain.farm_blocks(SETTLED_DEPTH).await;
    s.reconcile().await;
    assert!(!s.lease.holds_for(payer), "settled: the lease let the bundle go");
    let peak = s.chain.peak();
    let dead = Some((WriteStanding::Dead("its coin went to another spend of ours"), false));
    let never_landed = "never landed — its coin went to another spend of ours".to_string();
    let word = presence_standing_on(&s.lease, NET, &s.money, &mark).await;
    assert_eq!(word, dead, "F spent with no coin of ours under the hint");
    assert_eq!(presence_step(&mark, word, 0, peak), PresenceStep::Void(never_landed.clone()), "void: the listing is due again");
    let word = beacon_standing_on(&s.lease, NET, &s.money, &beacon).await;
    assert_eq!(word, dead);
    assert_eq!(beacon_step(&beacon, word, 0, peak), BeaconStep::Forget(never_landed), "forgotten: the beacon is due again");

    // Without F: g unspent and unknown to the lease, so pending, and kept so,
    // however deep the chain grows.
    for _ in 0..2 {
        let word = presence_standing_on(&s.lease, NET, &s.money, &one_coin).await;
        assert_eq!(word, pending, "judged at g alone, the write never settles");
        assert_eq!(presence_step(&one_coin, word, 0, s.chain.peak()), PresenceStep::Keep);
        let word = beacon_standing_on(&s.lease, NET, &s.money, &one_coin_beacon).await;
        assert_eq!(word, pending);
        assert_eq!(beacon_step(&one_coin_beacon, word, 0, s.chain.peak()), BeaconStep::Keep);
        s.chain.farm_blocks(SETTLED_DEPTH).await;
        s.reconcile().await;
    }
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.4, a write the SSF wallet pays for, through the money
/// writer's own seam: wallet W's listing spends W's one coin to itself, fee
/// 0, and names W as its payer, the payer the lease parked it under. Its
/// mark files W's hex as the payer and the coin as both of its coins. While
/// the bundle is in the mempool the lease holds it for W, as a parked spend
/// and for a gift, and for no other wallet; once it lands it still holds it
/// for W's gift while it settles, but not for W's next write. The resolver
/// reads the record back under the era's hint, and the mark's own reader
/// confirms it.
#[tokio::test]
async fn a_money_presence_write_files_the_wallet_as_its_payer_and_the_lease_holds_it_for_the_wallet() {
    let mut s = setup().await;
    let (w, node) = (wallet(70), iroh::SecretKey::generate());
    let (paid_by, other) = (Payer::of(&w), Payer::of(&wallet(71)));
    let coin = s.chain.fund(our_puzzle_hash(&w), 1000, None);
    s.chain.farm().await;
    let at = unix_now();
    let (hint, write) = s.money_listing(&w, &node, 0, &entries(), at).await.unwrap();
    assert_eq!(hint, Bytes32::new(chia_lane::derive_ck_hint(NET, &CK, 0)), "the era's listing hint under the contact key");
    assert_eq!(write.payer, paid_by, "the wallet pays");
    assert_eq!(write.coins, WriteCoins::one(coin.coin_id()), "its one coin, spent to itself");
    assert!(write.acked);
    assert_eq!(write.spend, s.lease.spend_of(&coin.coin_id()));
    let bundle = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(s.chain.mempool(), vec![bundle.name()]);
    assert_eq!(s.chain.fee_of(&bundle), 0, "a listing pays no fee");
    assert_eq!(write.memo, memo_of(&bundle, hint));

    let mark = NodePublishMark::written(0, 1, "a".into(), at, hint, &write, node.public().to_string());
    let (one, w_hex) = (hex::encode(coin.coin_id()), paid_by.hex());
    assert_eq!(
        (mark.coin_id.as_str(), mark.parked.as_str(), mark.payer.as_deref()),
        (one.as_str(), one.as_str(), Some(w_hex.as_str())),
        "the mark files the one coin as both, and the wallet as its payer"
    );
    assert!(s.lease.outgoing_pending_for(paid_by) && s.lease.holds_for(paid_by), "parked for the wallet");
    assert!(!s.lease.outgoing_pending_for(other) && !s.lease.holds_for(other), "and for no other wallet");

    let landed = s.chain.farm().await;
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].record.node_id, node.public().to_string());
    assert_eq!((found[0].coin_id, found[0].confirmed_height, found[0].hint), (written(&w, coin).coin_id(), landed, hint));
    s.reconcile().await;
    let word = presence_standing_on(&s.lease, NET, &s.money, &mark).await;
    assert_eq!(word, Some((WriteStanding::Confirmed { height: landed, seen_at: Some(landed) }, false)), "its mark's reader confirms it");
    assert!(s.lease.is_settling(&coin.coin_id()));
    assert!(s.lease.holds_for(paid_by) && !s.lease.outgoing_pending_for(paid_by), "settling: held for a gift, not for the next write");
    assert!(!s.lease.holds_for(other));
    assert_eq!(s.sent(), HashSet::from([bundle.name()]), "one write");
    assert!(s.chain.unanswered().is_empty());
}

/// The money writer keeps main's global check on the lease it is given: a
/// spend of any payer still parked holds a write the SSF wallet pays for
/// (`publish_memo_on`, stage 4 design §4.3 T4 for the spacing that will
/// replace it). A burner's claim and write is live in the mempool, its dish
/// coin parked under the burner. Wallet W's listing then waits, as the
/// settling wallet's write always did: nothing new is sent, since the
/// reconciliation's probe pushes the burner's own bundle again, and W's
/// coin is not taken. Once the burner's write lands, W's listing goes out.
#[tokio::test]
async fn a_money_presence_write_waits_while_any_spend_on_its_lease_is_parked_as_on_main() {
    let mut s = setup().await;
    let (w, node) = (wallet(70), iroh::SecretKey::generate());
    let coin = s.chain.fund(our_puzzle_hash(&w), 1000, None);
    let (f, _) = ready_dish(&s, 1).await;
    let key = burner(72, 0);
    let hint = Bytes32::new([0x5a; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a burner's record, live in the mempool".to_vec()), 1).await.unwrap();
    assert_eq!(first.coins.parked, f.coin_id());
    let live = s.chain.received().last().cloned().expect("the burner's write was sent");
    assert_eq!(s.chain.mempool(), vec![live.name()]);
    assert!(!s.lease.outgoing_pending_for(Payer::of(&w)), "nothing of the wallet's is parked");
    let pushes = s.chain.acks_for(live.name()).len();

    let held = s.money_listing(&w, &node, 0, &entries(), unix_now()).await.err().expect("the listing waits");
    assert_eq!(held.downcast_ref::<MemoWait>(), Some(&MemoWait::Settling("presence".into())), "{held:#}");
    assert!(is_typed_wait(&held));
    assert!(s.chain.acks_for(live.name()).len() > pushes, "the probe pushed the burner's bundle again");
    assert_eq!(s.sent(), HashSet::from([live.name()]), "nothing new sent");
    assert_eq!(s.chain.mempool(), vec![live.name()]);
    assert!(s.lease.is_parked(&f.coin_id()), "the burner's spend is live, parked");
    assert!(!s.lease.is_taken(&coin.coin_id()), "the wallet's coin is not taken");
    assert_eq!(s.chain.record(coin.coin_id()).map(|r| r.2), Some(None), "and is unspent");

    s.chain.farm().await;
    let (_, write) = s.money_listing(&w, &node, 0, &entries(), unix_now()).await.unwrap();
    assert_eq!((write.coins, write.payer), (WriteCoins::one(coin.coin_id()), Payer::of(&w)), "the burner's spend landed: the listing goes out");
    assert_eq!(s.sent().len(), 2);
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.4 and §5.2: the TAKE marker can outlive its TAKE and
/// name a dish coin F1 the lease holds no more, and no burner ever claims
/// that coin. Over sixteen seeds the claim picks F2, the other ready lobby
/// coin, every time, though the same seeds pick F1 too when the marker is
/// not asked. A burner's write then parks F2, and with F1 the only coin no
/// spend holds, another burner's write finds no coin ready. The marker
/// stays as it was, for testnet TAKE.
#[tokio::test]
async fn a_stale_take_marker_never_lets_a_burner_claim_its_dish_coin() {
    let mut s = setup().await;
    let (coins, made) = ready_dishes(&s, &[10, 10]).await;
    let (f1, f2) = (coins[0], coins[1]);
    let money = wallet(39);
    let take = claim(&lobby(), f1, our_puzzle_hash(&money));
    let parking = park_for(&s.lease, Payer::of(&money), &take, &[(f1.coin_id(), made)]);
    s.lease.mark_incoming(f1.coin_id()).unwrap();
    s.lease.unpark(&parking);
    assert!(s.lease.is_incoming_marker(&f1.coin_id()) && !s.lease.is_taken(&f1.coin_id()), "the TAKE gone, its marker left");

    let key = burner(40, 0);
    let ph = key.puzzle_hash();
    let marked_or_taken = |id: &Bytes32| s.lease.is_taken(id) || s.lease.is_incoming_marker(id);
    let mut unmarked = HashSet::new();
    for seed in 0..16 {
        let picked = claim_to(NET, &s.money, ph, marked_or_taken, &mut StdRng::seed_from_u64(seed)).await.unwrap();
        assert_eq!(picked.dish.coin, f2, "seed {seed}: never the marker's coin");
        let control = claim_to(NET, &s.money, ph, |id: &Bytes32| s.lease.is_taken(id), &mut StdRng::seed_from_u64(seed)).await.unwrap();
        unmarked.insert(control.dish.coin);
    }
    assert_eq!(unmarked, HashSet::from([f1, f2]), "unasked, the marker's coin is picked too");
    assert!(s.chain.received().is_empty(), "a claim is built, never pushed");

    let write = s.burner_write(&key, 0, Bytes32::new([0x54; 32]), None, |_| Ok(b"a record".to_vec()), 1).await.unwrap();
    assert_eq!(write.coins.parked, f2.coin_id());
    let other = s.burner_write(&burner(41, 0), 0, Bytes32::new([0x55; 32]), None, |_| Ok(b"another record".to_vec()), 2).await;
    assert_eq!(waited(&other), Some(BurnerWait::NoCoinReady), "F1 marked and F2 parked: no coin ready");
    assert!(!knock_attempt_counts(true, other.as_ref().err().unwrap()), "a dry dish is no knock attempt (§5.2)");
    assert!(s.lease.is_incoming_marker(&f1.coin_id()) && !s.lease.is_taken(&f1.coin_id()), "the marker stays as it was");
    assert_eq!(s.chain.received().iter().map(SpendBundle::name).collect::<HashSet<_>>().len(), 1, "one bundle sent");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §5.2, the fuse: with sixteen gifts counted in era 0, a
/// write for a burner holding no coin waits, naming the era, though a lobby
/// coin is ready; nothing is sent and no lobby coin parked. The fuse counts
/// per era, so in era 1 the next era's burner is funded.
#[tokio::test]
async fn the_fuse_stops_a_seventeenth_gift_and_sends_nothing() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 10).await;
    s.preset_fuse(0, strangers(16));
    let hint = Bytes32::new([0x56; 32]);
    let blown = s.burner_write(&burner(42, 0), 0, hint, None, |_| Ok(b"a seventeenth gift".to_vec()), 1).await;
    assert_eq!(waited(&blown), Some(BurnerWait::FuseBlown { era: 0 }));
    assert!(!knock_attempt_counts(true, blown.as_ref().err().unwrap()), "a blown fuse is no knock attempt (§5.2)");
    assert!(s.chain.received().is_empty(), "nothing sent");
    assert!(!s.lease.is_taken(&f.coin_id()), "no lobby coin parked");
    assert_eq!(s.gifts(0), 16);

    let next_era = s.burner_write(&burner(42, 1), 1, hint, None, |_| Ok(b"the next era's first gift".to_vec()), 2).await.unwrap();
    assert_eq!(next_era.coins.parked, f.coin_id(), "a new era opens the fuse");
    assert_eq!((s.gifts(1), s.chain.received().iter().map(SpendBundle::name).collect::<HashSet<_>>().len()), (1, 1));
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, a lost race whose two bundles both reached a mempool,
/// and §5.2, the fuse: our claim and write is taken, and a stranger's claim
/// of its dish coin F lands first, so our bundle never lands. Its gift was
/// counted when it left, the sixteenth of the era, which blows the fuse for
/// every other burner. While the lease keeps the bundle settling, the
/// burner holding no coin is not funded again. Once F is spent
/// SETTLED_DEPTH deep, the bundle reads dead and the lease lets it go, and
/// the burner's next write gives its gift back to the fuse and is funded
/// from another coin, F2, counted once: the fuse is at sixteen again, and
/// the other burners still wait.
#[tokio::test]
async fn a_claim_and_write_a_strangers_claim_beat_gives_its_gift_back_to_the_fuse_and_its_burner_is_funded_again() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    s.preset_fuse(0, strangers(15));
    let key = burner(43, 0);
    let payer = Payer::of_burner(&key);
    let hint = Bytes32::new([0x58; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record that never lands".to_vec()), 1).await.unwrap();
    let lost = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(s.gifts(0), 16, "counted as it left: the sixteenth");
    let fresh = burner(44, 0);
    let blown = s.burner_write(&fresh, 0, hint, None, |_| Ok(b"another burner".to_vec()), 2).await;
    assert_eq!(waited(&blown), Some(BurnerWait::FuseBlown { era: 0 }));

    let f2 = s.chain.fund(lobby().puzzle_hash(), 1, None);
    let stranger = Bytes32::new([0x59; 32]);
    s.chain.include_next(claim(&lobby(), f, stranger));
    let beaten = s.chain.farm().await;
    assert_eq!(s.chain.children(f.coin_id()), vec![Coin::new(f.coin_id(), stranger, 1)], "the stranger's claim took F");
    assert!(s.chain.mempool().is_empty(), "the block spent F, so the mempools let our bundle go");
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Pending, "the lease still holds the bundle");
    assert!(s.lease.is_settling(&f.coin_id()));
    let settling = s.burner_write(&key, 0, hint, None, |_| Ok(b"not yet".to_vec()), 3).await;
    assert_eq!(waited(&settling), Some(BurnerWait::Settling));
    assert_eq!(s.gifts(0), 16, "nothing given back while the bundle could still land");

    s.chain.farm_blocks(SETTLED_DEPTH).await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Dead("its coin went to another spend of ours"));
    assert!(!s.lease.holds_for(payer));
    let mut handed = None;
    let body = |parent: Bytes32| -> Result<Vec<u8>> {
        handed = Some(parent);
        Ok(b"a record from F2".to_vec())
    };
    let second = s.burner_write(&key, 0, hint, None, body, 4).await.unwrap();
    let g2 = gift(&key, f2);
    assert_eq!(handed, Some(g2.coin_id()));
    assert_eq!(second.coins, WriteCoins { parent: g2.coin_id(), parked: f2.coin_id() });
    assert_eq!(s.gifts(0), 16, "the dead bundle's gift given back, the new one counted");
    let still = s.burner_write(&fresh, 0, hint, None, |_| Ok(b"another burner".to_vec()), 5).await;
    assert_eq!(waited(&still), Some(BurnerWait::FuseBlown { era: 0 }), "the fuse is full again");

    let landed = s.chain.farm().await;
    assert!(landed > beaten);
    assert_eq!(s.chain.children(g2.coin_id()), vec![burner_coin(&key, g2.coin_id())]);
    assert_eq!(s.judge_split(hint, second.coins, second.memo, second.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    let rebuilt = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(s.sent(), HashSet::from([lost.name(), rebuilt.name()]));
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §5.2 and §5.4, a stray beside a redirected claim: a peer
/// we push to reads the burner's puzzle hash in our bundle, pays strays of
/// 2 mojos and of 0 there, and has F's claim, re-solved to its own address,
/// land first, which costs it nothing. Our claim and write dies on a spent
/// F, its gift counted as it left. Neither stray is a coin the burner writes from
/// (R7), nor a sign that its gift landed, which would have left coins of 1
/// mojo there. So once F is spent SETTLED_DEPTH deep and the lease lets the
/// bundle go, the burner's next write gives the dead gift back and is
/// funded from F2, and the era has one gift counted, not two: a peer that
/// redirects our claims again and again delays the listing but never fills
/// the fuse, however many pages of strays it pays there up to
/// [`MAX_FAUCET_PAGES`] (the next test). The strays are never spent.
#[tokio::test]
async fn a_stray_at_a_burner_keeps_no_dead_gift_counted_once_a_redirected_claim_kills_its_bundle() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let key = burner(52, 0);
    let payer = Payer::of_burner(&key);
    let hint = Bytes32::new([0x61; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record a peer redirects".to_vec()), 1).await.unwrap();
    let lost = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(s.gifts(0), 1, "counted as it left");

    let mut strays = vec![s.chain.fund(key.puzzle_hash(), 2, None), s.chain.fund(key.puzzle_hash(), 0, None)];
    strays.sort_by_key(Coin::coin_id);
    let f2 = s.chain.fund(lobby().puzzle_hash(), 1, None);
    let peer = Bytes32::new([0x62; 32]);
    s.chain.include_next(claim(&lobby(), f, peer));
    let redirected = s.chain.farm().await;
    assert_eq!(s.chain.children(f.coin_id()), vec![Coin::new(f.coin_id(), peer, 1)], "F's claim went to the peer");
    let listed = s.money.coin_records_by_puzzle_hash(key.puzzle_hash(), true, None).await.unwrap();
    let mut at_burner: Vec<(Coin, bool)> = listed.records.iter().map(|r| (r.coin, r.spent)).collect();
    at_burner.sort_by_key(|(coin, _)| coin.coin_id());
    assert_eq!(at_burner, strays.iter().map(|stray| (*stray, false)).collect::<Vec<_>>(), "the burner's whole listing: the two strays");
    assert!(!listed.truncated);
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Pending, "the lease still holds the bundle");
    let settling = s.burner_write(&key, 0, hint, None, |_| Ok(b"not yet".to_vec()), 2).await;
    assert_eq!(waited(&settling), Some(BurnerWait::Settling), "the strays are no coin it writes from, and its bundle still settles");
    assert_eq!(s.gifts(0), 1);

    s.chain.farm_blocks(SETTLED_DEPTH).await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Dead("its coin went to another spend of ours"));
    assert!(!s.lease.holds_for(payer) && !s.lease.holds_spend_at(key.puzzle_hash()), "the lease let the bundle go");
    let second = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record from F2".to_vec()), 3).await.unwrap();
    let g2 = gift(&key, f2);
    assert_eq!(second.coins, WriteCoins { parent: g2.coin_id(), parked: f2.coin_id() }, "funded again from F2, beside the strays");
    assert_eq!(s.gifts(0), 1, "the dead gift given back and the new one counted: one, not two");

    let landed = s.chain.farm().await;
    assert_eq!(s.chain.children(g2.coin_id()), vec![burner_coin(&key, g2.coin_id())]);
    assert_eq!(s.judge_split(hint, second.coins, second.memo, second.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    for stray in strays {
        assert_eq!(s.chain.record(stray.coin_id()), Some((stray, redirected, None)), "a stray, never spent");
    }
    let rebuilt = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(s.sent(), HashSet::from([lost.name(), rebuilt.name()]));
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §5.2 and §5.4, strays past one page: the redirect of the
/// test before, with four strays of 2 mojos and of 0 paid to the burner in
/// blocks of their own, and nodes that answer two coins a page, as a full
/// node with a low `max_subscribe_response_items` or the redirecting peer
/// itself may. The burner's listing then comes in two pages, the first cut
/// short with a cursor. The fuse's check follows the cursor, as the writer's
/// own listing does, and finds no coin of 1 mojo, so the dead gift is given
/// back: the next write is funded from F2 and the era has one gift counted,
/// not two.
#[tokio::test]
async fn strays_past_one_page_at_a_burner_keep_no_dead_gift_counted() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let key = burner(57, 0);
    let payer = Payer::of_burner(&key);
    let hint = Bytes32::new([0x63; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record a peer redirects".to_vec()), 1).await.unwrap();
    assert_eq!(s.gifts(0), 1, "counted as it left");

    let f2 = s.chain.fund(lobby().puzzle_hash(), 1, None);
    let peer = Bytes32::new([0x64; 32]);
    s.chain.include_next(claim(&lobby(), f, peer));
    s.chain.farm().await;
    assert_eq!(s.chain.children(f.coin_id()), vec![Coin::new(f.coin_id(), peer, 1)], "F's claim went to the peer");
    let mut strays = Vec::new();
    for amount in [2, 0, 2, 0] {
        strays.push(s.chain.fund(key.puzzle_hash(), amount, None));
        s.chain.farm().await;
    }
    s.chain.farm_blocks(SETTLED_DEPTH).await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Dead("its coin went to another spend of ours"));
    assert!(!s.lease.holds_for(payer) && !s.lease.holds_spend_at(key.puzzle_hash()), "the lease let the bundle go");

    s.chain.set_page_limit(2);
    let page = s.money.coin_records_by_puzzle_hash(key.puzzle_hash(), true, None).await.unwrap();
    assert!(page.truncated && page.next_cursor.is_some(), "the burner's first page is cut short, with a cursor");
    assert!(page.records.iter().all(|r| r.coin.amount != GIFT_MOJOS), "and holds strays only");
    let second = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record from F2".to_vec()), 2).await.unwrap();
    let g2 = gift(&key, f2);
    assert_eq!(second.coins, WriteCoins { parent: g2.coin_id(), parked: f2.coin_id() }, "funded again from F2, beside the strays");
    assert_eq!(s.gifts(0), 1, "the dead gift given back past the page and the new one counted: one, not two");

    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, second.coins, second.memo, second.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    for stray in strays {
        let (coin, _, spent) = s.chain.record(stray.coin_id()).expect("the stray is on chain");
        assert_eq!((coin, spent), (stray, None), "a stray, never spent");
    }
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, the lost race whose loser is refused: a stranger's
/// claim of the dish coin F waits in the mempools, and a block that carries
/// it comes just as our claim and write is sent, so every node refuses ours
/// as a double spend. The refusal hands F back, and no gift is counted. The
/// burner's next write claims another lobby coin, F2, which has come to be
/// ready, and lands.
#[tokio::test]
async fn a_claim_and_write_that_loses_the_race_for_its_dish_coin_is_refused_handed_back_and_written_again_from_another_coin() {
    let mut s = setup().await;
    let f = s.chain.fund(lobby().puzzle_hash(), 10, None);
    s.chain.farm().await;
    // F2 one block younger, so it is ready one block after F.
    let f2 = s.chain.fund(lobby().puzzle_hash(), 10, None);
    s.chain.farm().await;
    s.chain.farm_blocks(GAP_BLOCKS - 1).await;
    let key = burner(45, 0);
    let hint = Bytes32::new([0x5a; 32]);
    let stranger = Bytes32::new([0x5b; 32]);
    s.money.push_tx(claim(&lobby(), f, stranger)).await.unwrap();
    s.chain.block_before(ProtocolMessageTypes::SendTransaction);

    let lost = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record that loses the race".to_vec()), 1).await;
    assert!(!s.chain.reorg_staged(), "the block came as our bundle was sent");
    let why = refused(&lost).expect("every peer refused the push");
    assert_eq!(why.matches("DOUBLE_SPEND").count(), 2, "{why}");
    assert!(knock_attempt_counts(true, lost.as_ref().err().unwrap()), "a push every peer refused is a knock attempt (§5.2)");
    assert!(!s.lease.is_taken(&f.coin_id()), "a refusal hands F back");
    assert!(!s.lease.outgoing_pending_for(Payer::of_burner(&key)));
    assert_eq!(s.gifts(0), 0, "a refused push counts no gift");
    let mut taken = vec![Coin::new(f.coin_id(), stranger, 1), Coin::new(f.coin_id(), lobby().puzzle_hash(), 9)];
    taken.sort_by_key(Coin::coin_id);
    assert_eq!(s.chain.children(f.coin_id()), taken, "the stranger's claim took F");
    let lost_name = s.chain.received().last().map(SpendBundle::name).expect("the write was sent");

    // A block every connection has filed, so the lane's peak is the chain's.
    s.chain.farm().await;
    let write = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record from F2".to_vec()), 2).await.unwrap();
    let g2 = gift(&key, f2);
    assert_eq!(write.coins, WriteCoins { parent: g2.coin_id(), parked: f2.coin_id() }, "another coin");
    assert_eq!(s.gifts(0), 1);
    let landed = s.chain.farm().await;
    assert_eq!(s.chain.children(g2.coin_id()), vec![burner_coin(&key, g2.coin_id())]);
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    let landed_name = s.chain.received().last().map(SpendBundle::name).expect("the write was sent");
    assert_eq!(s.sent(), HashSet::from([claim(&lobby(), f, stranger).name(), lost_name, landed_name]), "the stranger's claim, and our two");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, an ephemeral parent not served, the inferred risk of
/// §4.1: a claim and write lands, and then neither node serves g's spend.
/// F reads spent, the write's verdict stays pending (the coin under the hint
/// names g, whose spend nobody shows), and the reader opens nothing: the
/// failure the claim-and-write self-test and the drill's step 3 look for,
/// which §10's fallback (PR 10) would answer. Once the nodes serve g's spend
/// again, the same lookups confirm the write and open its record.
#[tokio::test]
async fn a_claim_and_write_whose_ephemeral_parent_no_node_serves_reads_pending_and_opens_nothing() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 10).await;
    let (key, node) = (burner(46, 0), iroh::SecretKey::generate());
    let g = gift(&key, f);
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let write = s.burner_write(&key, 0, hint, None, |_| Ok(memo), 1).await.unwrap();
    let bundle = s.chain.received().last().cloned().expect("the write was sent");
    let landed = s.chain.farm().await;
    for n in [&s.a, &s.b] {
        s.chain.serve_spend_on(n, g.coin_id(), None);
    }

    assert_eq!(spent_heights(&s.money, vec![f.coin_id()]).await.unwrap(), vec![(f.coin_id(), landed)], "F reads spent");
    assert_eq!(child_under_hint(&s.money, hint, g.coin_id(), Some(write.memo)).await.unwrap(), HintChild::Unknown);
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Pending);
    assert!(read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap().is_empty(), "nothing opens");

    let g_spend = bundle.coin_spends.iter().find(|cs| cs.coin == g).cloned().expect("the bundle spends g");
    for n in [&s.a, &s.b] {
        s.chain.serve_spend_on(n, g.coin_id(), Some(g_spend.clone()));
    }
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(found.iter().map(|r| (r.record.node_id.clone(), r.coin_id)).collect::<Vec<_>>(), vec![(node.public().to_string(), burner_coin(&key, g.coin_id()).coin_id())]);
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §5.2, the fuse, and §10, a burner spent elsewhere: a gift
/// that landed is never given back. A burner's claim and write lands and
/// settles, and then its coin is spent to another puzzle hash by a holder of
/// its key that is not this lease (a cloned folder, or a stolen W). The
/// burner now holds no coin and the lease nothing of its, so it is funded
/// again (§5.2; PR 10's foreign-spend pause is what stops a thief), but its
/// puzzle hash held coins of 1 mojo, so the first gift stays counted: two
/// gifts landed through us, two counted. Only a burner that never held a
/// coin of 1 mojo, as in the lost-race tests, has its gift given back,
/// whatever strays of other amounts it holds
/// (`a_stray_at_a_burner_keeps_no_dead_gift_counted_once_a_redirected_claim_kills_its_bundle`).
#[tokio::test]
async fn a_landed_gift_stays_counted_when_its_burners_coin_is_later_spent_elsewhere() {
    let mut s = setup().await;
    let (coins, _) = ready_dishes(&s, &[1, 1]).await;
    let key = burner(47, 0);
    let payer = Payer::of_burner(&key);
    let hint = Bytes32::new([0x5c; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a first record".to_vec()), 1).await.unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    s.chain.farm_blocks(SETTLED_DEPTH).await;
    s.reconcile().await;
    assert!(!s.lease.holds_for(payer), "settled: the lease holds nothing of the burner's");
    assert_eq!(s.gifts(0), 1);

    let written = burner_coin(&key, first.coins.parent);
    let elsewhere = Bytes32::new([0x5d; 32]);
    s.money.push_tx(spent_elsewhere(&key, written, elsewhere)).await.unwrap();
    let gone = s.chain.farm().await;
    assert_eq!(s.chain.record(written.coin_id()).unwrap().2, Some(gone), "the burner's coin spent outside the lease");
    assert_eq!(s.chain.children(written.coin_id()), vec![Coin::new(written.coin_id(), elsewhere, 1)]);
    assert!(!s.lease.is_taken(&written.coin_id()));

    let second = s.burner_write(&key, 0, hint, None, |_| Ok(b"funded again".to_vec()), 2).await.unwrap();
    let spare = coins.into_iter().find(|c| c.coin_id() != first.coins.parked).expect("the other lobby coin");
    assert_eq!(second.coins, WriteCoins { parent: gift(&key, spare).coin_id(), parked: spare.coin_id() }, "funded again, from the other coin");
    assert_eq!(s.gifts(0), 2, "the landed gift is not given back: two gifts, two counted");
    let again = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, second.coins, second.memo, second.spend).await, WriteStanding::Confirmed { height: again, seen_at: Some(again) });
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.4 and §5.2, the gift rule's second guard: the payer the
/// lease filed for a spend can be lost (a rollback rewrites
/// wallet_lease.json without `payer`, §8 (6)), and the spend then reads as
/// the money address's. The burner writer still knows its burner's bundles
/// by their spends at the burner's puzzle hash, and its coins by their own
/// ids. A claim and write parked, its payer lost, holds the burner's next
/// write though a second lobby coin is ready. Once it lands the burner
/// writes from its coin, and that rewrite parked, its payer lost too, holds
/// the next write, though the coin it parks is no longer the burner's own
/// to write from. No second gift is ever built.
#[tokio::test]
async fn a_burner_bundle_whose_payer_a_rollback_lost_still_holds_the_burners_next_write() {
    let mut s = setup().await;
    let dir = Dir::new("rollback-payer");
    let path = dir.0.join("wallet_lease.json");
    let money = wallet(48);
    restore(&s.lease, &path, &money);
    let (coins, _) = ready_dishes(&s, &[1, 1]).await;
    let key = burner(48, 0);
    let payer = Payer::of_burner(&key);
    let hint = Bytes32::new([0x5e; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a first record".to_vec()), 1).await.unwrap();
    let pushed = s.chain.received().last().cloned().expect("the write was sent");
    let spare = coins.into_iter().find(|c| c.coin_id() != first.coins.parked).expect("the other lobby coin");

    roll_back(&mut s, &path, &money);
    assert!(s.lease.is_parked(&first.coins.parked));
    assert!(!s.lease.outgoing_pending_for(payer) && !s.lease.holds_for(payer), "the payer lost: no payer record holds the burner");
    assert!(s.lease.outgoing_pending_for(Payer::of(&money)), "the money address's, as the file now reads");
    assert!(s.lease.parks_spend_at(key.puzzle_hash()), "the saved bundle spends g, at the burner");
    let held = s.burner_write(&key, 0, hint, None, |_| Ok(b"a second gift".to_vec()), 2).await;
    assert_eq!(waited(&held), Some(BurnerWait::Held), "the burner's bundle, known by its spend");
    assert!(!s.lease.is_taken(&spare.coin_id()), "the spare lobby coin never claimed");
    assert_eq!(s.sent(), HashSet::from([pushed.name()]), "no second gift built");
    assert_eq!(s.gifts(0), 1);

    let landed = s.chain.farm().await;
    let written = burner_coin(&key, first.coins.parent);
    assert_eq!(s.chain.record(written.coin_id()), Some((written, landed, None)));
    let rewrite = s.burner_write(&key, 0, hint, None, |_| Ok(b"a rewrite".to_vec()), 3).await.unwrap();
    assert_eq!(rewrite.coins, WriteCoins::one(written.coin_id()), "the burner writes from its coin");
    let rewritten = s.chain.received().last().cloned().expect("the rewrite was sent");

    roll_back(&mut s, &path, &money);
    assert!(s.lease.is_parked(&written.coin_id()) && !s.lease.holds_for(payer), "the rewrite's payer lost too");
    let held = s.burner_write(&key, 0, hint, None, |_| Ok(b"a gift beside its coin".to_vec()), 4).await;
    assert_eq!(waited(&held), Some(BurnerWait::Held), "its parked coin holds the burner");
    assert!(!s.lease.is_taken(&spare.coin_id()), "the spare lobby coin never claimed");
    assert_eq!(s.sent(), HashSet::from([pushed.name(), rewritten.name()]), "no gift built beside the rewrite");
    assert_eq!(s.gifts(0), 1);

    s.chain.farm().await;
    assert_eq!(s.chain.children(written.coin_id()), vec![burner_coin(&key, written.coin_id())], "the rewrite lands, one coin at the burner");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.4 and §5.2, the gift rule's second guard on a SETTLING
/// bundle: a stranger's claim of the dish coin F lands first, so our claim
/// and write never lands, and the lease keeps it settling while a
/// reorganization could still bring it back (§10). A rollback then loses
/// its payer (§8 (6)), and the spend reads as the money address's, so no
/// payer record holds the burner. The burner holds no coin, and its puzzle
/// hash never held one, so the fuse would give its gift back and a second
/// gift would follow; but the settling bundle still spends g at the
/// burner's puzzle hash, so the burner's next write waits as settling,
/// though a spare lobby coin is ready: nothing new is sent and the fuse is
/// unchanged. Once F is spent SETTLED_DEPTH deep the lease lets the bundle
/// go, and the next write gives the dead gift back and is funded from the
/// spare coin, one gift counted.
#[tokio::test]
async fn a_settling_burner_bundle_whose_payer_a_rollback_lost_still_holds_back_a_second_gift() {
    let mut s = setup().await;
    let dir = Dir::new("rollback-settling");
    let path = dir.0.join("wallet_lease.json");
    let money = wallet(53);
    restore(&s.lease, &path, &money);
    let (coins, _) = ready_dishes(&s, &[1, 1]).await;
    let key = burner(53, 0);
    let payer = Payer::of_burner(&key);
    let hint = Bytes32::new([0x63; 32]);
    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record that never lands".to_vec()), 1).await.unwrap();
    let lost = s.chain.received().last().cloned().expect("the write was sent");
    let f = coins.iter().copied().find(|c| c.coin_id() == first.coins.parked).expect("F, a lobby coin");
    let spare = coins.iter().copied().find(|c| c.coin_id() != f.coin_id()).expect("the other lobby coin");
    assert_eq!(s.gifts(0), 1);

    let stranger = Bytes32::new([0x64; 32]);
    s.chain.include_next(claim(&lobby(), f, stranger));
    s.chain.farm().await;
    assert_eq!(s.chain.children(f.coin_id()), vec![Coin::new(f.coin_id(), stranger, 1)], "the stranger's claim took F");
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Pending, "the lease still holds the bundle");
    assert!(s.lease.is_settling(&f.coin_id()) && s.lease.holds_for(payer));

    roll_back(&mut s, &path, &money);
    assert!(s.lease.is_settling(&f.coin_id()), "still settling, as the file kept it");
    assert!(!s.lease.holds_for(payer), "the payer lost: no payer record holds the burner");
    assert!(s.lease.holds_for(Payer::of(&money)), "the money address's, as the file now reads");
    assert!(
        !s.lease.parks_spend_at(key.puzzle_hash()) && s.lease.holds_spend_at(key.puzzle_hash()),
        "nothing parked, and the settling bundle spends g, at the burner"
    );
    let held = s.burner_write(&key, 0, hint, None, |_| Ok(b"a second gift".to_vec()), 2).await;
    assert_eq!(waited(&held), Some(BurnerWait::Settling), "the burner's settling bundle, known by its spend");
    assert!(!s.lease.is_taken(&spare.coin_id()), "the spare lobby coin never claimed");
    assert_eq!(s.sent(), HashSet::from([lost.name()]), "no second gift built");
    assert_eq!(s.gifts(0), 1, "the fuse unchanged");

    s.chain.farm_blocks(SETTLED_DEPTH).await;
    s.reconcile().await;
    assert!(!s.lease.is_settling(&f.coin_id()) && !s.lease.holds_spend_at(key.puzzle_hash()), "settled: the lease let the bundle go");
    let second = s.burner_write(&key, 0, hint, None, |_| Ok(b"a record from the spare coin".to_vec()), 3).await.unwrap();
    assert_eq!(second.coins, WriteCoins { parent: gift(&key, spare).coin_id(), parked: spare.coin_id() }, "funded again, from the spare coin");
    assert_eq!(s.gifts(0), 1, "the dead gift given back, the new one counted");
    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, second.coins, second.memo, second.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    let rebuilt = s.chain.received().last().cloned().expect("the write was sent");
    assert_eq!(s.sent(), HashSet::from([lost.name(), rebuilt.name()]));
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §5.2, failing closed: a burner whose coin listing is cut
/// short cannot tell that it holds no coin, so it is not funded. Strays of 2
/// mojos paid to its puzzle hash (anyone can, §5.4) fill the listing past
/// [`MAX_FAUCET_PAGES`] pages of one coin each, and none is a coin it writes
/// from. The write waits, typed, which is no knock attempt; nothing is sent,
/// the ready lobby coin is left alone and no gift is counted.
#[tokio::test]
async fn a_burner_whose_coin_listing_is_cut_short_is_not_funded() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 10).await;
    let key = burner(49, 0);
    for _ in 0..=MAX_FAUCET_PAGES {
        s.chain.fund(key.puzzle_hash(), 2, None);
    }
    s.chain.farm().await;
    s.chain.set_page_limit(1);
    let cut = s.burner_write(&key, 0, Bytes32::new([0x5f; 32]), None, |_| Ok(b"a record".to_vec()), 1).await;
    assert_eq!(waited(&cut), Some(BurnerWait::ListingCutShort));
    assert!(!knock_attempt_counts(true, cut.as_ref().err().unwrap()), "a listing cut short is no knock attempt (§5.2)");
    assert!(s.chain.received().is_empty(), "nothing sent");
    assert!(!s.lease.is_taken(&f.coin_id()), "no lobby coin parked");
    assert_eq!(s.gifts(0), 0);
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §5.2 and §10: a claim and write whose push goes
/// unanswered may be in a mempool, so it is a write, `acked` false, with F
/// parked under the burner, and its gift is counted as it left, as an
/// acknowledged one's is. The burner's next write waits for it. The push
/// had reached the nodes, so the next block carries it, and the write is
/// confirmed and read back: one bundle, one gift.
#[tokio::test]
async fn an_unanswered_claim_and_write_is_a_write_parked_and_counted_and_it_lands() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 10).await;
    let (key, node) = (burner(50, 0), iroh::SecretKey::generate());
    let payer = Payer::of_burner(&key);
    let g = gift(&key, f);
    let (hint, memo) = presence_memo(NET, &node, &CK, 0, &entries(), unix_now()).unwrap();
    let at = s.later();
    let mut rng = StdRng::seed_from_u64(1);
    let unacked = Unacked(&s.money);
    let write = sendable(burner_write_with(&s.lease, &s.fuse, NET, &unacked, at, &key, 0, hint, None, |_| Ok(memo), &mut rng, "test", None))
        .await
        .expect("an unanswered push is a write");
    assert!(!write.acked, "unanswered");
    assert_eq!(write.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() });
    assert!(s.lease.is_parked(&f.coin_id()) && s.lease.outgoing_pending_for(payer), "F parked under the burner");
    assert!(write.spend.is_some() && write.spend == s.lease.spend_of(&f.coin_id()));
    assert_eq!(s.gifts(0), 1, "counted as it left");

    let waiting = s.burner_write(&key, 0, hint, None, |_| Ok(b"not yet".to_vec()), 2).await;
    assert_eq!(waited(&waiting), Some(BurnerWait::Held), "the unanswered write holds the burner's next");
    assert_eq!(s.gifts(0), 1);
    let landed = s.chain.farm().await;
    assert_eq!(s.chain.children(g.coin_id()), vec![burner_coin(&key, g.coin_id())]);
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(found.iter().map(|r| (r.record.node_id.clone(), r.coin_id)).collect::<Vec<_>>(), vec![(node.public().to_string(), burner_coin(&key, g.coin_id()).coin_id())]);
    assert_eq!(s.sent().len(), 1, "one bundle");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.2, R7, and §5.4: anyone can pay a burner's public
/// puzzle hash, and what they pay is never written from unless it is a
/// coin of exactly 1 mojo. A burner holding only a stray of 2 mojos is
/// funded as if it held nothing, the stray left alone; beside the coin its
/// first write made, the older stray is passed over again and the rewrite
/// spends that coin; and with a second 1-mojo coin paid to it later, the
/// next rewrite spends the older of the two. One gift in all.
#[tokio::test]
async fn a_burner_writes_only_from_a_one_mojo_coin_the_oldest_first_and_never_from_a_stray() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let key = burner(51, 0);
    let hint = Bytes32::new([0x60; 32]);
    let stray = s.chain.fund(key.puzzle_hash(), 2, None);
    let paid = s.chain.farm().await;

    let first = s.burner_write(&key, 0, hint, None, |_| Ok(b"a first record".to_vec()), 1).await.unwrap();
    assert_eq!(first.coins, WriteCoins { parent: gift(&key, f).coin_id(), parked: f.coin_id() }, "funded as if it held nothing");
    let landed = s.chain.farm().await;
    let written = burner_coin(&key, first.coins.parent);
    assert_eq!(s.chain.record(written.coin_id()), Some((written, landed, None)));

    let rewrite = s.burner_write(&key, 0, hint, None, |_| Ok(b"a rewrite".to_vec()), 2).await.unwrap();
    assert_eq!(rewrite.coins, WriteCoins::one(written.coin_id()), "the 1-mojo coin, not the older stray");
    s.chain.farm().await;
    let next = burner_coin(&key, written.coin_id());

    let later = s.chain.fund(key.puzzle_hash(), 1, None);
    let paid_later = s.chain.farm().await;
    let oldest = s.burner_write(&key, 0, hint, None, |_| Ok(b"another rewrite".to_vec()), 3).await.unwrap();
    assert_eq!(oldest.coins, WriteCoins::one(next.coin_id()), "the older of two 1-mojo coins");
    s.chain.farm().await;
    assert_eq!(s.chain.children(next.coin_id()), vec![burner_coin(&key, next.coin_id())]);
    assert_eq!(s.chain.record(stray.coin_id()), Some((stray, paid, None)), "the stray, never spent");
    assert_eq!(s.chain.record(later.coin_id()), Some((later, paid_later, None)), "the younger coin, not spent yet");
    assert_eq!(s.gifts(0), 1, "one gift");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.1, the table's first row, for the listing the heartbeat
/// writes with burner keys on: wallet W's listing for era 0 goes out from
/// W's listing burner P(0) through the listing's own seam, though W holds no
/// coin at all. The era's first write claims the one ready lobby coin F in
/// its own bundle: two spends, F's claim and the gift g's, one signature,
/// P(0)'s over g, and no fee. It is written under era 0's listing hint under
/// the contact key, names P(0) as its payer, files g and F as its coins, and
/// counts one gift; the lease parks F for P(0), not for W. Once it lands,
/// the resolver opens the record through g under that hint as this node's,
/// at P(0)'s new coin, and the write's verdict by g and F is confirmed.
#[tokio::test]
async fn a_burner_listing_lands_and_the_resolver_reads_it() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let (w, node) = (wallet(60), iroh::SecretKey::generate());
    let key = burner(60, 0);
    let (payer, g) = (Payer::of_burner(&key), gift(&key, f));
    let (hint, write) = s.listing(&w, &node, 0, &entries(), unix_now(), 1).await.unwrap();
    assert_eq!(hint, Bytes32::new(chia_lane::derive_ck_hint(NET, &CK, 0)), "era 0's listing hint under the contact key");
    assert_eq!(write.payer, payer, "P(0) pays");
    assert_ne!(write.payer, Payer::of(&w), "never the money key");
    assert_eq!(write.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() }, "g as its parent, F parked");
    assert!(write.acked);
    assert!(write.spend.is_some() && write.spend == s.lease.spend_of(&f.coin_id()));
    let bundle = s.chain.received().last().cloned().expect("the listing was sent");
    assert_eq!(bundle.coin_spends.iter().map(|cs| cs.coin).collect::<Vec<_>>(), vec![f, g], "two spends: F's claim, then g's");
    assert_eq!(signatures(&bundle), signed_by_the_burner_alone(&key, g));
    assert_eq!(s.chain.fee_of(&bundle), 0, "a listing pays no fee");
    assert_eq!(write.memo, memo_of(&bundle, hint));
    assert_eq!(s.gifts(0), 1, "one gift counted");
    assert!(s.lease.outgoing_pending_for(payer) && !s.lease.outgoing_pending_for(Payer::of(&w)), "parked for P(0), not for W");

    let landed = s.chain.farm().await;
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].record.node_id, node.public().to_string());
    assert_eq!(found[0].record.addrs, vec!["198.51.100.7:4444".to_string()]);
    assert_eq!((found[0].coin_id, found[0].confirmed_height, found[0].hint), (burner_coin(&key, g.coin_id()).coin_id(), landed, hint));
    assert_eq!(s.judge_split(hint, write.coins, write.memo, write.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §4.1, the rewrite row, and §3.1, a new era brings a new
/// key. Era 0's listing from P(0) lands, its gift claimed from one of two
/// ready lobby coins, F_a, and one gift is counted in era 0. An address
/// change in the same era is rewritten under the same hint from P(0)'s one
/// coin: one spend, P(0)'s own, no second gift, and the other lobby coin F_b
/// left unspent. Once the era turns, era 1's listing comes from P(1),
/// another payer, whose first write claims F_b and counts era 1's first
/// gift, while P(0)'s last coin stays unspent. The resolver reads the era 1
/// record, with the changed address, under era 1's hint.
#[tokio::test]
async fn a_rewrite_spends_the_listing_burners_coin_and_the_next_era_writes_from_the_next_burner() {
    let mut s = setup().await;
    let (dish, _) = ready_dishes(&s, &[1, 1]).await;
    let (w, node) = (wallet(61), iroh::SecretKey::generate());
    let (p0, p1) = (burner(61, 0), burner(61, 1));
    let t = unix_now();
    let (hint0, first) = s.listing(&w, &node, 0, &entries(), t, 1).await.unwrap();
    let f_a = *dish.iter().find(|c| c.coin_id() == first.coins.parked).expect("a ready lobby coin, parked");
    let f_b = *dish.iter().find(|c| c.coin_id() != f_a.coin_id()).unwrap();
    let g0 = gift(&p0, f_a);
    assert_eq!(first.coins.parent, g0.coin_id());
    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint0, first.coins, first.memo, first.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });
    assert_eq!(s.gifts(0), 1, "era 0's one gift");

    let c0 = burner_coin(&p0, g0.coin_id());
    let moved = entries_of("203.0.113.9:4444", 0);
    let (again, rewrite) = s.listing(&w, &node, 0, &moved, t + 700, 2).await.unwrap();
    assert_eq!(again, hint0, "the same hint");
    assert_eq!(rewrite.coins, WriteCoins::one(c0.coin_id()), "written from P(0)'s one coin");
    assert_eq!(rewrite.payer, Payer::of_burner(&p0));
    let bundle = s.chain.received().last().cloned().expect("the rewrite was sent");
    assert_eq!(bundle.coin_spends.iter().map(|cs| cs.coin).collect::<Vec<_>>(), vec![c0], "one spend, of P(0)'s own coin");
    assert_eq!(signatures(&bundle), signed_by_the_burner_alone(&p0, c0));
    assert_eq!(s.gifts(0), 1, "no second gift");
    let rewritten = s.chain.farm().await;
    let c1 = burner_coin(&p0, c0.coin_id());
    assert_eq!(s.chain.children(c0.coin_id()), vec![c1]);
    assert_eq!(s.judge_split(hint0, rewrite.coins, rewrite.memo, rewrite.spend).await, WriteStanding::Confirmed { height: rewritten, seen_at: Some(rewritten) });
    assert_eq!(s.chain.record(f_b.coin_id()).map(|r| r.2), Some(None), "F_b unspent");

    s.chain.farm_to(ERA_BLOCKS).await;
    let (hint1, next) = s.listing(&w, &node, 1, &moved, t + 1_400, 3).await.unwrap();
    assert_eq!(hint1, Bytes32::new(chia_lane::derive_ck_hint(NET, &CK, 1)));
    assert_ne!(hint1, hint0, "a new era, a new hint");
    assert_ne!(Payer::of_burner(&p1), Payer::of_burner(&p0), "and a new payer");
    assert_eq!(next.payer, Payer::of_burner(&p1), "era 1's listing comes from P(1)");
    let g1 = gift(&p1, f_b);
    assert_eq!(next.coins, WriteCoins { parent: g1.coin_id(), parked: f_b.coin_id() }, "P(1)'s first write claims F_b");
    assert_eq!(s.gifts(1), 1, "era 1's first gift");
    let landed = s.chain.farm().await;
    assert_eq!(chia_lane::era_of(landed), 1);
    assert_eq!(s.chain.record(c1.coin_id()).map(|r| r.2), Some(None), "P(0)'s last coin, never spent again");
    let found = read_ck(NET, &s.carrier, &CK, landed, t + 1_400, &mut HashMap::new()).await.unwrap();
    let era1: Vec<_> = found.iter().filter(|r| r.hint == hint1).collect();
    assert_eq!(era1.len(), 1, "{found:?}");
    assert_eq!(era1[0].record.node_id, node.public().to_string());
    assert_eq!(era1[0].record.addrs, vec!["203.0.113.9:4444".to_string()], "the changed address");
    assert_eq!((era1[0].coin_id, era1[0].confirmed_height), (burner_coin(&p1, g1.coin_id()).coin_id(), landed));
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §8.3, the hint rule, burner keys turned on in the middle
/// of an era: wallet W's listing of era 0 lands through the money writer's
/// own seam, and its mark, filed and then confirmed by the mark's own
/// reader, names W as its payer. The burner path's step then holds every
/// rewrite under era 0's hint from W's own listing burner, a changed
/// address set past its debounce and its jitter among them: one hint never
/// has two payers. In era 1, under a new hint, the step waits for the slot
/// with the mark's own address set, the inbound flag cleared as a new era
/// clears it, and writes at the slot; a changed set there takes the slot's
/// place once its debounce and jitter have passed. The step is given era 1's
/// peaks; nothing is farmed for them.
#[tokio::test]
async fn a_burner_rewrite_after_a_money_paid_listing_of_this_era_is_held_by_the_hint_rule() {
    let mut s = setup().await;
    let (w, node) = (wallet(62), iroh::SecretKey::generate());
    let slot = root(62).slot(KIND_PRESENCE, 1);
    assert!((100..crate::chia_burner::SLOT_BLOCKS).contains(&slot), "the seed's era 1 slot leaves room before it: {slot}");
    s.chain.fund(our_puzzle_hash(&w), 1000, None);
    s.chain.farm().await;
    let at = unix_now();
    let (hint, write) = s.money_listing(&w, &node, 0, &entries(), at).await.unwrap();
    let sig = addrs_signature(&entries());
    let filed = NodePublishMark::written(0, 1, sig.clone(), at, hint, &write, node.public().to_string());
    assert_eq!(filed.payer, Some(Payer::of(&w).hex()), "the mark names W");
    let landed = s.chain.farm().await;
    s.reconcile().await;
    let word = presence_standing_on(&s.lease, NET, &s.money, &filed).await;
    assert_eq!(word, Some((WriteStanding::Confirmed { height: landed, seen_at: Some(landed) }, false)));
    let PresenceStep::Save(mark) = presence_step(&filed, word, 0, landed) else { panic!("confirmed: saved") };
    assert!(mark.chain_seen && mark.confirmed && mark.payer == filed.payer, "{mark:?}");

    let moved = addrs_signature(&entries_of("203.0.113.9:4444", 0));
    let debounced = at + ADDR_CHANGE_DEBOUNCE_SECS;
    let mut rng = StdRng::seed_from_u64(1);
    let mut clock = ListingClock::default();
    for peak in [landed, landed + 1, landed + 1 + CHANGE_JITTER_MAX_BLOCKS] {
        assert_eq!(burner_step(&mut clock, &w, Some(&mark), &node, (peak, debounced, &moved), &mut rng), ListingStep::HeldByHint(PaidBy::Money), "at {peak}");
    }

    let start = ERA_BLOCKS;
    let at_slot = start + u32::try_from(slot).unwrap();
    let cleared = addrs_signature(&entries_of("198.51.100.7:4444", 0));
    assert_eq!(sig_without_inbound(&sig), cleared, "the mark's set, its inbound flag cleared");
    for live in [&sig, &cleared] {
        let mut clock = ListingClock::default();
        for peak in [start, at_slot - 1] {
            assert_eq!(burner_step(&mut clock, &w, Some(&mark), &node, (peak, debounced, live), &mut rng), ListingStep::Wait(ListingWait::Slot), "{live} at {peak}");
        }
        assert_eq!(burner_step(&mut clock, &w, Some(&mark), &node, (at_slot, debounced, live), &mut rng), ListingStep::Write, "{live} at its slot");
    }
    let mut clock = ListingClock::default();
    assert_eq!(burner_step(&mut clock, &w, Some(&mark), &node, (start, at + 1, &moved), &mut rng), ListingStep::Wait(ListingWait::Change), "inside the debounce");
    assert!(clock.change.is_none(), "no jitter is drawn inside the debounce, counted from W's write");
    // Past the debounce the change is due, and its jitter is drawn here.
    burner_step(&mut clock, &w, Some(&mark), &node, (start + 1, debounced, &moved), &mut rng);
    let jittered = start + 1 + CHANGE_JITTER_MAX_BLOCKS;
    assert!(jittered < at_slot);
    assert_eq!(burner_step(&mut clock, &w, Some(&mark), &node, (jittered, debounced, &moved), &mut rng), ListingStep::Write, "the change, before the slot");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §8.3, the hint rule the other way, burner keys turned off
/// in the middle of an era: wallet W's era 0 listing from its listing
/// burner P(0) lands through the listing's own seam, and its mark, filed and
/// then confirmed by the mark's own reader, names P(0) as its payer. With
/// burner keys off, the SSF wallet's step would write a changed address set
/// past its debounce, as main does, but the hint rule holds it: the step is
/// given P(0)'s payer text, which the heartbeat derives for this mark alone
/// (`money_path_burner_payer`), since the mark names neither none nor W. In
/// era 1, under a new hint, nothing is derived and the SSF wallet writes as
/// it always did.
#[tokio::test]
async fn a_money_rewrite_after_a_burner_paid_listing_of_this_era_is_held_by_the_hint_rule() {
    let mut s = setup().await;
    ready_dish(&s, 1).await;
    let (w, node) = (wallet(63), iroh::SecretKey::generate());
    let at = unix_now();
    let (hint, write) = s.listing(&w, &node, 0, &entries(), at, 1).await.unwrap();
    let sig = addrs_signature(&entries());
    let id = node.public().to_string();
    let filed = NodePublishMark::written(0, 1, sig.clone(), at, hint, &write, id.clone());
    let p0 = Payer::of_burner(&burner(63, 0)).hex();
    assert_eq!(filed.payer.as_deref(), Some(p0.as_str()), "the mark names P(0)");
    let landed = s.chain.farm().await;
    s.reconcile().await;
    let word = presence_standing_on(&s.lease, NET, &s.money, &filed).await;
    assert_eq!(word, Some((WriteStanding::Confirmed { height: landed, seen_at: Some(landed) }, false)));
    let PresenceStep::Save(mark) = presence_step(&filed, word, 0, landed) else { panic!("confirmed: saved") };
    assert!(mark.chain_seen && mark.confirmed && mark.payer == filed.payer, "{mark:?}");

    let money = Payer::of(&w).hex();
    let hint0 = hex::encode(hint);
    let moved = addrs_signature(&entries_of("203.0.113.9:4444", 0));
    let debounced = at + ADDR_CHANGE_DEBOUNCE_SECS;
    assert!(node_publish_due(Some(&mark), 0, &moved, debounced, &hint0, &id, false), "main's rule writes the change");
    let derived = money_path_burner_payer(Some(&mark), 0, &hint0, &money, NET, &w, &CK);
    assert_eq!(derived.as_deref(), Some(p0.as_str()), "derived for this mark: W's own P(0)");
    let step = money_listing_step(Some(&mark), 0, &moved, debounced, &hint0, &id, false, &money, derived.as_deref());
    assert_eq!(step, ListingStep::HeldByHint(PaidBy::Burner));

    let hint1 = hex::encode(chia_lane::derive_ck_hint(NET, &CK, 1));
    let derived = money_path_burner_payer(Some(&mark), 1, &hint1, &money, NET, &w, &CK);
    assert_eq!(derived, None, "a mark of another era derives nothing");
    for live in [&sig, &moved] {
        assert_eq!(money_listing_step(Some(&mark), 1, live, debounced, &hint1, &id, false, &money, None), ListingStep::Write, "{live}: a new era");
    }
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, Dish dry or griefed, for the listing: with no lobby
/// coin ready, the listing from P(0) waits (`BurnerWait::NoCoinReady`), a
/// wait and not a failure. It sends nothing, parks nothing and counts no
/// gift, and the Phone Book says §10's sentence; neither the words nor the
/// log's text names P(0). Nothing was filed, so the station's next tick is
/// still due to write. Once a lobby coin is ready, the next listing claims it
/// and lands, and the resolver reads it.
#[tokio::test]
async fn a_burner_listing_that_finds_no_dish_coin_ready_waits_and_is_written_once_one_is_ready() {
    let mut s = setup().await;
    let (w, node) = (wallet(64), iroh::SecretKey::generate());
    let key = burner(64, 0);
    let peak = s.chain.farm().await;
    let at = unix_now();
    let dry = s.listing(&w, &node, 0, &entries(), at, 1).await.map(|(_, write)| write);
    assert_eq!(waited(&dry), Some(BurnerWait::NoCoinReady));
    let e = dry.as_ref().err().expect("it waited");
    assert!(is_typed_wait(e), "a wait, not a failure");
    assert_eq!(listing_failure_words(e, false), "The lobby dish has no mojo ready. Your station tries again every few minutes.");
    names_no_burner(e, &key);
    assert!(s.chain.received().is_empty(), "nothing sent");
    assert!(!s.lease.outgoing_pending(), "nothing parked");
    assert_eq!(s.gifts(0), 0, "no gift counted");
    let sig = addrs_signature(&entries());
    let mut clock = ListingClock::default();
    let mut rng = StdRng::seed_from_u64(1);
    assert_eq!(burner_step(&mut clock, &w, None, &node, (peak, at, &sig), &mut rng), ListingStep::Write, "nothing filed: still due");

    let (f, _) = ready_dish(&s, 1).await;
    let (hint, write) = s.listing(&w, &node, 0, &entries(), at, 2).await.unwrap();
    let g = gift(&key, f);
    assert_eq!(write.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() }, "the ready coin, claimed");
    assert_eq!(s.gifts(0), 1);
    let landed = s.chain.farm().await;
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(
        found.iter().map(|r| (r.record.node_id.clone(), r.coin_id, r.hint)).collect::<Vec<_>>(),
        vec![(node.public().to_string(), burner_coin(&key, g.coin_id()).coin_id(), hint)]
    );
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, the lost race whose loser is refused, for the
/// listing: a stranger's claim of the dish coin F waits in the mempools, and
/// a block that carries it comes just as the listing from P(0) is sent, so
/// every node refuses it as a double spend. That is a refusal, not a busy
/// chain and not a wait, and its words are its own text, which names no
/// burner. F is handed back and no gift is counted. The next listing claims
/// another lobby coin, F2, which has come to be ready, lands, and is read.
#[tokio::test]
async fn a_burner_listing_that_loses_the_race_for_its_dish_coin_is_written_again_from_another_coin() {
    let mut s = setup().await;
    let f = s.chain.fund(lobby().puzzle_hash(), 10, None);
    s.chain.farm().await;
    // F2 one block younger, so it is ready one block after F.
    let f2 = s.chain.fund(lobby().puzzle_hash(), 10, None);
    s.chain.farm().await;
    s.chain.farm_blocks(GAP_BLOCKS - 1).await;
    let (w, node) = (wallet(65), iroh::SecretKey::generate());
    let key = burner(65, 0);
    let stranger = Bytes32::new([0x66; 32]);
    s.money.push_tx(claim(&lobby(), f, stranger)).await.unwrap();
    s.chain.block_before(ProtocolMessageTypes::SendTransaction);

    let at = unix_now();
    let lost = s.listing(&w, &node, 0, &entries(), at, 1).await.map(|(_, write)| write);
    assert!(!s.chain.reorg_staged(), "the block came as the listing was sent");
    let why = refused(&lost).expect("every peer refused the push");
    assert_eq!(why.matches("DOUBLE_SPEND").count(), 2, "{why}");
    let e = lost.as_ref().err().expect("refused");
    assert!(!chain_busy(e) && !is_typed_wait(e), "a lost race: a refusal, not a busy chain or a wait");
    for last_week in [true, false] {
        assert_eq!(listing_failure_words(e, last_week), format!("{e:#}"), "its own text");
    }
    names_no_burner(e, &key);
    assert!(!s.lease.is_taken(&f.coin_id()), "a refusal hands F back");
    assert_eq!(s.gifts(0), 0, "a refused push counts no gift");

    // A block every connection has filed, so the lane's peak is the chain's.
    s.chain.farm().await;
    let (hint, write) = s.listing(&w, &node, 0, &entries(), at, 2).await.unwrap();
    let g2 = gift(&key, f2);
    assert_eq!(write.coins, WriteCoins { parent: g2.coin_id(), parked: f2.coin_id() }, "another coin");
    assert_eq!(s.gifts(0), 1);
    let landed = s.chain.farm().await;
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(
        found.iter().map(|r| (r.record.node_id.clone(), r.coin_id, r.hint)).collect::<Vec<_>>(),
        vec![(node.public().to_string(), burner_coin(&key, g2.coin_id()).coin_id(), hint)]
    );
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §10, Mempool full, for the listing: every node's full
/// mempool refuses the listing from P(0) for its zero fee. That reads as the
/// chain being busy, and is still a refusal, not a wait: F is handed back,
/// no gift is counted, and nothing waits in a mempool. The Phone Book says
/// §10's sentence, that waiting costs nothing and last week's listing still
/// works, and neither it nor the log's text names P(0). Once the mempools
/// clear, the next listing lands with no fee added and is read.
#[tokio::test]
async fn a_burner_listing_refused_by_a_full_mempool_reads_as_the_chain_busy_and_lands_once_cleared() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let (w, node) = (wallet(66), iroh::SecretKey::generate());
    let key = burner(66, 0);
    s.chain.set_full(true);
    let at = unix_now();
    let turned_away = s.listing(&w, &node, 0, &entries(), at, 1).await.map(|(_, write)| write);
    let why = refused(&turned_away).expect("every peer refused the push");
    assert!(why.contains("INVALID_FEE_TOO_CLOSE_TO_ZERO"), "{why}");
    let e = turned_away.as_ref().err().expect("refused");
    assert!(chain_busy(e), "the chain busy: {e:#}");
    assert!(!is_typed_wait(e), "and a refusal, not a wait (§10)");
    assert_eq!(listing_failure_words(e, true), "The chain is busy. Your listing waits for room. Waiting costs nothing, and last week's listing still works.");
    names_no_burner(e, &key);
    assert!(!s.lease.is_taken(&f.coin_id()), "a refusal hands F back");
    assert_eq!(s.gifts(0), 0, "a refused push counts no gift");
    assert!(s.chain.mempool().is_empty());

    s.chain.set_full(false);
    let (hint, write) = s.listing(&w, &node, 0, &entries(), at, 2).await.unwrap();
    let g = gift(&key, f);
    assert_eq!(write.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() });
    let bundle = s.chain.received().last().cloned().expect("the listing was sent");
    assert_eq!(s.chain.fee_of(&bundle), 0, "no fee added");
    let landed = s.chain.farm().await;
    let found = read_ck(NET, &s.carrier, &CK, landed, unix_now(), &mut HashMap::new()).await.unwrap();
    assert_eq!(
        found.iter().map(|r| (r.record.node_id.clone(), r.coin_id, r.hint)).collect::<Vec<_>>(),
        vec![(node.public().to_string(), burner_coin(&key, g.coin_id()).coin_id(), hint)]
    );
    assert_eq!(s.gifts(0), 1);
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §3.5: the listing's seam refuses a root made for mainnet
/// on the test's network before it asks anything, with an error that names
/// both networks and no burner. No node is asked anything, nothing is sent
/// or parked, the ready lobby coin is not taken and no gift is counted. The
/// same wallet's root for the test's network writes.
#[tokio::test]
async fn a_listing_on_a_root_of_another_network_is_refused_and_sends_nothing() {
    let mut s = setup().await;
    let (f, _) = ready_dish(&s, 1).await;
    let (w, node) = (wallet(67), iroh::SecretKey::generate());
    let mainnet = crate::chia_network::ChiaNet::Mainnet;
    let other = BurnerRoot::of(&MoneyKey::new(w.clone()), mainnet);
    let at = s.later();
    let mut rng = StdRng::seed_from_u64(1);
    let refused = publish_node_presence_with(&s.lease, &s.fuse, NET, &s.money, at, &other, Payer::of(&w), &node, &CK, 0, &entries(), unix_now(), &mut rng)
        .await
        .err()
        .expect("a root of another network is refused");
    let text = format!("{refused:#}");
    assert!(text.contains(mainnet.name()) && text.contains(NET.name()), "{text}");
    names_no_burner(&refused, &other.presence(&CK, 0));
    names_no_burner(&refused, &burner(67, 0));
    assert!(s.asked_nothing(), "no node was asked anything");
    assert!(s.chain.received().is_empty(), "nothing sent");
    assert!(!s.lease.is_taken(&f.coin_id()) && !s.lease.outgoing_pending(), "nothing parked");
    assert_eq!(s.gifts(0), 0, "no gift counted");

    let (_, write) = s.listing(&w, &node, 0, &entries(), unix_now(), 2).await.unwrap();
    assert_eq!(write.coins.parked, f.coin_id(), "the test network's root writes");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §8.3, the crash window's wait, and §4.4, per payer: a
/// spend the SSF wallet W pays for is in flight, here a knock of W's under
/// another hint, live in the mempools, and the listing's first write from
/// W's listing burner P(0) waits (`BurnerWait::MoneyInFlight`), a wait and
/// not a failure: nothing new is sent, since the reconciliation's probe
/// pushes W's own bundle again, no lobby coin is parked and no gift is
/// counted. The Phone Book says the listing goes out once that spend lands,
/// and neither its words nor the log's text names P(0). Once W's spend
/// lands, P(0)'s first write goes out. The wait is the SSF wallet's alone:
/// a live claim and write of another burner holds no wallet's first write,
/// and a later spend of W's in flight holds no rewrite from P(0)'s own
/// coin. A spend in flight that is this era's listing does not end with the
/// wait: the next tests show its lost mark filed again, holding P(0) for the
/// era.
#[tokio::test]
async fn a_burner_listings_first_write_waits_while_a_spend_of_the_ssf_wallet_is_in_flight_and_goes_out_once_it_lands() {
    let mut s = setup().await;
    let (w, v, node) = (wallet(68), wallet(69), iroh::SecretKey::generate());
    let key = burner(68, 0);
    let (dish, _) = ready_dishes(&s, &[1, 1, 1]).await;

    // Another burner's claim and write, live: wallet V's first listing
    // write is not held by it.
    let stranger = burner(98, 0);
    s.burner_write(&stranger, 0, Bytes32::new([0x5d; 32]), None, |_| Ok(b"another burner's record, live".to_vec()), 1).await.unwrap();
    let theirs = s.chain.received().last().cloned().expect("the other burner's write was sent");
    assert_eq!(s.chain.mempool(), vec![theirs.name()]);
    assert!(s.lease.outgoing_pending_for(Payer::of_burner(&stranger)) && !s.lease.outgoing_pending_for(Payer::of(&v)));
    let (_, vs) = s.listing(&v, &node, 0, &entries(), unix_now(), 2).await.expect("not held by another payer's spend");
    assert_eq!(vs.payer, Payer::of_burner(&burner(69, 0)), "V's P(0) writes");
    let v_listing = s.chain.received().last().cloned().expect("V's listing was sent");
    s.chain.farm().await;

    let coin = s.chain.fund(our_puzzle_hash(&w), 1000, None);
    let funded = s.chain.farm().await;
    let knock = our_memo(&w, coin, Bytes32::new([0x5b; 32]), b"a knock of W's, in flight".to_vec());
    s.push(&w, &knock, (coin.coin_id(), funded)).await.unwrap();
    assert!(s.lease.outgoing_pending_for(Payer::of(&w)), "W's knock parked, live");
    let at = unix_now();
    let held = s.listing(&w, &node, 0, &entries(), at, 3).await.map(|(_, write)| write);
    assert_eq!(waited(&held), Some(BurnerWait::MoneyInFlight));
    let e = held.as_ref().err().expect("it waited");
    assert!(is_typed_wait(e), "a wait, not a failure");
    assert_eq!(listing_failure_words(e, false), "A spend from the SSF wallet is still on its way. Your listing goes out once it lands.");
    names_no_burner(e, &key);
    assert_eq!(s.sent(), HashSet::from([theirs.name(), v_listing.name(), knock.name()]), "nothing new sent");
    assert_eq!(s.chain.mempool(), vec![knock.name()], "W's knock, live");
    let free = |s: &Setup| dish.iter().filter(|c| !s.lease.is_taken(&c.coin_id()) && s.chain.record(c.coin_id()).is_some_and(|r| r.2.is_none())).count();
    assert_eq!(free(&s), 1, "no lobby coin parked for P(0)");
    assert_eq!(s.gifts(0), 2, "no gift counted for P(0): the other burner's and V's");

    s.chain.farm().await;
    let (hint, first) = s.listing(&w, &node, 0, &entries(), at, 4).await.unwrap();
    let f = *dish.iter().find(|c| c.coin_id() == first.coins.parked).expect("a lobby coin, parked");
    let g = gift(&key, f);
    assert_eq!(first.coins, WriteCoins { parent: g.coin_id(), parked: f.coin_id() }, "W's knock landed: P(0)'s first write goes out");
    assert_eq!(first.payer, Payer::of_burner(&key));
    assert_eq!(s.gifts(0), 3);
    let landed = s.chain.farm().await;
    assert_eq!(s.judge_split(hint, first.coins, first.memo, first.spend).await, WriteStanding::Confirmed { height: landed, seen_at: Some(landed) });

    let coin = s.chain.fund(our_puzzle_hash(&w), 500, None);
    let funded = s.chain.farm().await;
    let knock = our_memo(&w, coin, Bytes32::new([0x5c; 32]), b"another knock of W's, in flight".to_vec());
    s.push(&w, &knock, (coin.coin_id(), funded)).await.unwrap();
    assert!(s.lease.outgoing_pending_for(Payer::of(&w)), "W's knock parked, live");
    let written = burner_coin(&key, g.coin_id());
    let (_, rewrite) = s.listing(&w, &node, 0, &entries_of("203.0.113.9:4444", 0), at + 700, 5).await.unwrap();
    assert_eq!(rewrite.coins, WriteCoins::one(written.coin_id()), "a rewrite from P(0)'s own coin does not wait on it");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §8.3, the crash window: wallet W's listing for era 0 goes
/// out through the money writer's own seam, and the node stops before its
/// mark is saved, so it has none on record. It restarts with burner keys on,
/// its lease restored from the file with W's spend still parked, live in the
/// mempools. The lost mark is filed again from the write the lease holds
/// under the era's hint ([`lost_listing_mark`]): exactly the mark the
/// heartbeat would have saved, naming W as its payer, with the listing's
/// coins, record digest and spend, and the address set, date and node id
/// its record carries. With it, the burner path's step holds P(0)'s write
/// by the hint rule where, with no mark, P(0) would write at once; the
/// seam's own wait holds P(0)'s first write while W's spend is parked. Once
/// W's spend lands it is still found while it settles, and the mark's reader
/// confirms the write. The step goes on holding P(0) for the era, and P(0)
/// never writes. A mark that names the write is not filed again, and on the
/// SSF wallet's own path W's write is not filed again either: its step is
/// main's. A lease that has forgotten the write rebuilds nothing.
#[tokio::test]
async fn a_listing_the_ssf_wallet_wrote_before_a_restart_that_lost_its_mark_is_filed_again_and_holds_the_burner() {
    let mut s = setup().await;
    let dir = Dir::new("lost-money-mark");
    let path = dir.0.join("wallet_lease.json");
    let (w, node) = (wallet(70), iroh::SecretKey::generate());
    let (money, p0, id) = (Payer::of(&w).hex(), Payer::of_burner(&burner(70, 0)).hex(), node.public().to_string());
    s.chain.fund(our_puzzle_hash(&w), 1000, None);
    let (f, _) = ready_dish(&s, 1).await;
    s.lease = WalletLease::new();
    restore(&s.lease, &path, &w);
    let at = unix_now();
    let (hint, write) = s.money_listing(&w, &node, 0, &entries(), at).await.unwrap();
    let theirs = s.chain.received().last().cloned().expect("W's listing was sent");
    let sig = addrs_signature(&entries());
    let saved = NodePublishMark::written(0, 1, sig.clone(), at, hint, &write, id.clone());

    s.lease = WalletLease::new();
    restore(&s.lease, &path, &w);
    assert!(s.lease.outgoing_pending_for(Payer::of(&w)), "W's spend restored, parked");
    let burner_path = |lease: &WalletLease, mark: Option<&NodePublishMark>| lost_listing_mark(lease, mark, NET, &CK, 0, true, &money, |_| Some(p0.clone()));
    let lost = burner_path(&s.lease, None).expect("W's listing, filed again");
    assert_eq!(lost, saved, "the mark the heartbeat would have saved");
    assert_eq!(lost.payer.as_deref(), Some(money.as_str()), "naming W");
    // A mark on record that names no write of this era's under its hint is
    // lost all the same: another edition's (the one file is saved over each
    // edition, so a stop loses only this edition's save), this edition's
    // under another hint (the contact key replaced), and this edition's
    // void one, which names no write at all. Over the void one the era's
    // write count goes on, as the writer counted it, so the era's budget
    // holds: W's listing was the era's second write.
    let hint_of = |ck: &[u8; 32], era: u64| hex::encode(chia_lane::derive_ck_hint(NET, ck, era));
    let other_era = NodePublishMark { era: 1, hint: hint_of(&CK, 1), ..saved.clone() };
    let other_hint = NodePublishMark { hint: hint_of(&[0x77; 32], 0), ..saved.clone() };
    for (on_record, what) in [(&other_era, "another edition's mark"), (&other_hint, "a mark under another hint")] {
        assert_eq!(burner_path(&s.lease, Some(on_record)), Some(saved.clone()), "{what}");
    }
    let void = saved.voided();
    let second = NodePublishMark { writes: 2, ..saved.clone() };
    assert_eq!(burner_path(&s.lease, Some(&void)), Some(second.clone()), "this edition's void mark");
    // Another node id's void mark counts nothing of this node's, and a mark
    // of another edition keeps the floor.
    let counted = NodePublishMark { writes: 5, ..void.clone() };
    assert_eq!(burner_path(&s.lease, Some(&counted)), Some(NodePublishMark { writes: 6, ..saved.clone() }), "the count goes on");
    let another = NodePublishMark { node_id: Some("another node".into()), ..counted.clone() };
    assert_eq!(burner_path(&s.lease, Some(&another)).map(|m| m.writes), Some(1), "another node id's");
    assert_eq!(burner_path(&s.lease, Some(&NodePublishMark { writes: 5, ..other_era.clone() })).map(|m| m.writes), Some(1), "another edition's");

    let (peak, moved) = (s.chain.peak(), addrs_signature(&entries_of("203.0.113.9:4444", 0)));
    let mut rng = StdRng::seed_from_u64(1);
    assert_eq!(burner_step(&mut ListingClock::default(), &w, None, &node, (peak, at + 60, &sig), &mut rng), ListingStep::Write, "with no mark P(0) would write at once");
    for (now, live) in [(at + PRESENCE_CONFIRM_TIMEOUT_SECS, &sig), (at + ADDR_CHANGE_DEBOUNCE_SECS, &moved)] {
        let step = burner_step(&mut ListingClock::default(), &w, Some(&lost), &node, (peak + 1 + CHANGE_JITTER_MAX_BLOCKS, now, live), &mut rng);
        assert_eq!(step, ListingStep::HeldByHint(PaidBy::Money), "{live} at {now}");
    }
    let parked = s.listing(&w, &node, 0, &entries(), at, 1).await.map(|(_, write)| write);
    assert_eq!(waited(&parked), Some(BurnerWait::MoneyInFlight), "the seam's own wait, while W's spend is parked");

    let landed = s.chain.farm().await;
    s.reconcile().await;
    assert!(!s.lease.outgoing_pending_for(Payer::of(&w)) && s.lease.holds_for(Payer::of(&w)), "W's spend settling");
    assert_eq!(burner_path(&s.lease, None), Some(saved.clone()), "still found while it settles");
    assert_eq!(burner_path(&s.lease, Some(&void)), Some(second), "…over a void mark too, spent in its own era");
    assert_eq!(burner_path(&s.lease, Some(&lost)), None, "a mark that names it is not filed again");
    let word = presence_standing_on(&s.lease, NET, &s.money, &lost).await;
    assert_eq!(word, Some((WriteStanding::Confirmed { height: landed, seen_at: Some(landed) }, false)), "the mark's reader confirms W's write");
    let PresenceStep::Save(mark) = presence_step(&lost, word, 0, landed) else { panic!("confirmed: saved") };
    let step = burner_step(&mut ListingClock::default(), &w, Some(&mark), &node, (landed + 1 + CHANGE_JITTER_MAX_BLOCKS, at + ADDR_CHANGE_DEBOUNCE_SECS, &moved), &mut rng);
    assert_eq!(step, ListingStep::HeldByHint(PaidBy::Money), "held for the era");

    let derive = |m: &NodePublishMark| money_path_burner_payer(Some(m), 0, &m.hint, &money, NET, &w, &CK);
    assert_eq!(lost_listing_mark(&s.lease, None, NET, &CK, 0, false, &money, derive), None, "on the SSF wallet's path its own write is left to main's rule");
    assert_eq!(burner_path(&WalletLease::new(), None), None, "a lease that has forgotten the write rebuilds nothing");
    assert_eq!(s.sent(), HashSet::from([theirs.name()]), "P(0) never wrote");
    assert!(!s.lease.is_taken(&f.coin_id()), "no lobby coin parked");
    assert_eq!(s.gifts(0), 0, "no gift counted");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §8.3, the crash window the other way: wallet W's listing
/// for era 0 goes out from its listing burner P(0) through the listing's own
/// seam, and the node stops before its mark is saved. It restarts with
/// burner keys off, its lease restored with P(0)'s claim and write parked.
/// On the SSF wallet's path the lost mark is filed again, naming P(0), the
/// burner the heartbeat derives for it (`money_path_burner_payer`), and the
/// SSF wallet's step is held by the hint rule where, with no mark, main's
/// rule writes at once. On the burner path P(0)'s own write is not filed
/// again: the burner's own rules judge it, as they did.
#[tokio::test]
async fn a_listing_from_the_burner_whose_mark_a_restart_lost_is_filed_again_and_holds_the_ssf_wallet() {
    let mut s = setup().await;
    let dir = Dir::new("lost-burner-mark");
    let path = dir.0.join("wallet_lease.json");
    let (w, node) = (wallet(71), iroh::SecretKey::generate());
    let (money, p0, id) = (Payer::of(&w).hex(), Payer::of_burner(&burner(71, 0)).hex(), node.public().to_string());
    ready_dish(&s, 1).await;
    s.lease = WalletLease::new();
    restore(&s.lease, &path, &w);
    let at = unix_now();
    let (hint, write) = s.listing(&w, &node, 0, &entries(), at, 1).await.unwrap();
    let sig = addrs_signature(&entries());

    s.lease = WalletLease::new();
    restore(&s.lease, &path, &w);
    assert!(s.lease.outgoing_pending_for(Payer::of_burner(&burner(71, 0))), "P(0)'s spend restored, parked");
    let derive = |m: &NodePublishMark| money_path_burner_payer(Some(m), 0, &m.hint, &money, NET, &w, &CK);
    let lost = lost_listing_mark(&s.lease, None, NET, &CK, 0, false, &money, derive).expect("P(0)'s listing, filed again");
    let saved = NodePublishMark::written(0, 1, sig.clone(), at, hint, &write, id.clone());
    assert_eq!(lost, saved, "the mark the heartbeat would have saved");
    assert_eq!(lost.payer.as_deref(), Some(p0.as_str()), "naming P(0)");
    assert_eq!(lost.parked, hex::encode(write.coins.parked), "its dish coin parked, its gift the parent");
    // Another edition's mark on record, or this edition's under another
    // hint or void, names no write of this era's under its hint; over the
    // void one the era's write count goes on.
    let hint_of = |ck: &[u8; 32], era: u64| hex::encode(chia_lane::derive_ck_hint(NET, ck, era));
    let other_era = NodePublishMark { era: 1, hint: hint_of(&CK, 1), ..saved.clone() };
    let other_hint = NodePublishMark { hint: hint_of(&[0x77; 32], 0), ..saved.clone() };
    for on_record in [&other_era, &other_hint] {
        assert_eq!(lost_listing_mark(&s.lease, Some(on_record), NET, &CK, 0, false, &money, derive), Some(saved.clone()), "{on_record:?}");
    }
    let second = NodePublishMark { writes: 2, ..saved.clone() };
    assert_eq!(lost_listing_mark(&s.lease, Some(&saved.voided()), NET, &CK, 0, false, &money, derive), Some(second), "the era's count goes on over a void mark");
    assert_eq!(lost_listing_mark(&s.lease, Some(&saved), NET, &CK, 0, false, &money, derive), None, "a mark that names it is not filed again");

    let (hint0, moved) = (hex::encode(hint), addrs_signature(&entries_of("203.0.113.9:4444", 0)));
    let changed = at + ADDR_CHANGE_DEBOUNCE_SECS;
    assert_eq!(money_listing_step(None, 0, &sig, at, &hint0, &id, false, &money, None), ListingStep::Write, "with no mark main's rule writes at once");
    let derived = money_path_burner_payer(Some(&lost), 0, &hint0, &money, NET, &w, &CK);
    assert_eq!(derived.as_deref(), Some(p0.as_str()));
    assert_eq!(money_listing_step(Some(&lost), 0, &moved, changed, &hint0, &id, false, &money, derived.as_deref()), ListingStep::HeldByHint(PaidBy::Burner));

    assert_eq!(lost_listing_mark(&s.lease, None, NET, &CK, 0, true, &money, |_| Some(p0.clone())), None, "on the burner path its own write is left to the burner's rules");
    assert!(s.chain.unanswered().is_empty());
}

/// Stage 4 design §8.3, a lost mark's write that the chain put in a block of
/// the next era: wallet W's listing for era 0 goes out in the era's last
/// block and lands in era 1's first, and the node stops before its mark is
/// saved. Filed again from the lease while the spend settles, the mark is
/// voided at once (confirmed outside its era, so readers will not take it),
/// and its payer stays, so the hint rule still holds P(0): W's coin is on
/// chain under era 0's hint. Over that void mark the same write is not filed
/// again, so the heartbeat does not file it and void it on every tick.
#[tokio::test]
async fn a_lost_marks_write_confirmed_outside_its_era_is_filed_and_voided_once() {
    let mut s = setup().await;
    let dir = Dir::new("lost-mark-outside-era");
    let path = dir.0.join("wallet_lease.json");
    let (w, node) = (wallet(72), iroh::SecretKey::generate());
    let (money, p0) = (Payer::of(&w).hex(), Payer::of_burner(&burner(72, 0)).hex());
    s.chain.fund(our_puzzle_hash(&w), 1000, None);
    s.chain.farm_to(ERA_BLOCKS - 1).await;
    s.lease = WalletLease::new();
    restore(&s.lease, &path, &w);
    let (hint, _) = s.money_listing(&w, &node, 0, &entries(), unix_now()).await.unwrap();
    let landed = s.chain.farm().await;
    assert_eq!(chia_lane::era_of(landed), 1, "in era 1's first block");
    s.reconcile().await;
    assert!(s.lease.holds_for(Payer::of(&w)) && !s.lease.outgoing_pending_for(Payer::of(&w)), "W's spend settling");

    let burner_path = |mark: Option<&NodePublishMark>| lost_listing_mark(&s.lease, mark, NET, &CK, 0, true, &money, |_| Some(p0.clone()));
    let lost = burner_path(None).expect("W's listing, filed again");
    let word = presence_standing_on(&s.lease, NET, &s.money, &lost).await;
    let PresenceStep::Void(why) = presence_step(&lost, word, 0, landed) else { panic!("confirmed outside its era: void") };
    assert!(why.contains("outside its era"), "{why}");
    let void = lost.voided();
    assert_eq!((void.payer.as_deref(), void.hint.as_str()), (Some(money.as_str()), hex::encode(hint).as_str()), "the payer and the hint stay");
    assert_eq!(hint_rule_holds(Some(&void), 0, &void.hint, true, &money, Some(&p0)), Some(PaidBy::Money), "so the hint rule holds P(0)");
    assert_eq!(burner_path(Some(&void)), None, "not filed again over its own void mark");
    assert!(s.chain.unanswered().is_empty());
}
