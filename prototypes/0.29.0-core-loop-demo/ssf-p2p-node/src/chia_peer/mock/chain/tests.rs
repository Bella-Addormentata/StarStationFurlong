//! The mock chain's own tests (stage 4 design §12): each one goes through the
//! real lane over the wallet protocol, with keyless coins at the open puzzle,
//! so they build with chia-read alone. Each pins one behaviour the model
//! copies from a real full node (the module notes name where from), and ends
//! with no request left unanswered, since an unanswered one would make the
//! lane wait out its request timeout.

use super::*;
use crate::chia_chain::{ChainAccess, ChainError};
use crate::chia_peer::PeerConn;
use crate::chia_peer_lane::{refusal_is_final, PeerLane, Trust, MAX_DISPUTED_COINS, MAX_DISPUTED_PARENTS, PEAK_GRACE, STATE_ROUNDS};
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

/// A wallet's socket to a node, driven by hand: the test says when it
/// handshakes and when it next reads (which is when its websocket sends the
/// pong for a ping it read).
type Raw = tokio_tungstenite::WebSocketStream<tokio_rustls::client::TlsStream<tokio::net::TcpStream>>;

/// TLS to `node` as the lane's client certificate.
async fn tls_to(node: &MockNode) -> tokio_rustls::client::TlsStream<tokio::net::TcpStream> {
    let tcp = tokio::net::TcpStream::connect(node.addr).await.unwrap();
    let name = rustls::pki_types::ServerName::IpAddress(node.addr.ip().into());
    tokio_rustls::TlsConnector::from(TLS.clone()).connect(name, tcp).await.unwrap()
}

/// TCP, TLS and the websocket upgrade a lane's dial makes, and nothing of
/// the Chia protocol yet. Once this returns, the node has accepted the
/// connection (its TLS answered), so the connection is listed.
async fn raw_socket(node: &MockNode) -> Raw {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let request = format!("wss://{}/ws", node.addr).into_client_request().unwrap();
    tokio_tungstenite::client_async(request, tls_to(node).await).await.unwrap().0
}

/// The next frame the node sends, `what` the test expects, read for at most
/// [`BARRIER`]: a frame the node never sends fails the test, naming it,
/// rather than hanging it, since the block or release the test holds pinned
/// is not polled meanwhile and its own [`BARRIER`] never runs out.
async fn next_frame(raw: &mut Raw, what: &str) -> WsMessage {
    match tokio::time::timeout(BARRIER, raw.next()).await {
        Ok(Some(frame)) => frame.expect("a frame"),
        Ok(None) => panic!("the node closed the socket before {what}"),
        Err(_) => panic!("no {what} within {BARRIER:?}"),
    }
}

/// The Chia handshake a wallet sends, and the node's greeting read: its
/// handshake, the peak it announces, and the ping after it, whose pong the
/// socket queues, to send when it is next read or flushed. Returns the peak
/// and the generation the ping carries.
async fn greet(raw: &mut Raw, network: &Network) -> (NewPeakWallet, u64) {
    let hello = Handshake::new(network.id.clone(), PROTOCOL_VERSION.to_string(), "0.0.0".to_string(), 0, NodeType::Wallet, vec![]);
    raw.send(binary(&reply(&hello))).await.unwrap();
    let mut messages = Vec::new();
    for kind in [ProtocolMessageTypes::Handshake, ProtocolMessageTypes::NewPeakWallet] {
        let WsMessage::Binary(bytes) = next_frame(raw, &format!("{kind:?}")).await else { panic!("expected a {kind:?}") };
        let message = Message::from_bytes(&bytes).unwrap();
        assert_eq!(message.msg_type, kind);
        messages.push(message);
    }
    let WsMessage::Ping(generation) = next_frame(raw, "ping after the peak").await else { panic!("expected the ping after the peak") };
    let generation = u64::from_be_bytes(generation.try_into().expect("a generation"));
    (NewPeakWallet::from_bytes(&messages[1].data).unwrap(), generation)
}

/// Every listed connection: its node and the generation it filed.
fn listed(chain: &MockChain) -> Vec<(usize, Option<u64>)> {
    chain.0.acks.borrow().values().copied().collect()
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

/// The barrier counts a connection from the moment its node accepts it, not
/// from its handshake. One past its TLS and websocket upgrade and short of
/// the Chia handshake holds a block back; handshaking while the block
/// waits, it is greeted with the new peak and a ping carrying the
/// announcement's generation, and the block waits on until the pong for
/// that ping arrives. No clock decides it: the lane has not dialled, so the
/// test's socket is the only connection, and the test's runtime runs one
/// task at a time, so a poll of the block straight after a frame is read
/// sees nothing the node did after sending it.
#[tokio::test]
async fn a_connection_accepted_before_a_block_holds_it_back_until_it_pongs_the_peak_its_handshake_is_greeted_with() {
    use futures_util::FutureExt;
    let s = setup().await;
    let mut raw = raw_socket(&s.a).await;
    assert_eq!(listed(&s.chain), vec![(0, None)], "listed once accepted, with nothing filed");

    let farming = s.chain.farm();
    tokio::pin!(farming);
    assert_eq!(farming.as_mut().now_or_never(), None, "the block waits on a connection not yet handshaken");
    let (peak, generation) = greet(&mut raw, &s.chain.network()).await;
    assert_eq!((peak.height, peak.header_hash, peak.fork_point_with_previous_peak), (1, s.chain.header_hash(1).unwrap(), 1));
    assert_eq!(generation, 1, "the block's announcement");
    assert_eq!(farming.as_mut().now_or_never(), None, "greeted, its pong not yet sent: the block still waits");
    assert_eq!(listed(&s.chain), vec![(0, None)], "the greeting files nothing");
    raw.flush().await.expect("the pong sent");
    assert_eq!(farming.await, 1);
    assert_eq!(listed(&s.chain), vec![(0, Some(1))]);

    drop(raw);
    assert_eq!(s.chain.farm().await, 2, "a closed connection holds no block back");
    assert_eq!(s.money.peak_height().await.unwrap(), 2);
    assert_eq!(s.lane.live_count().await, 2);
    assert!(s.chain.unanswered().is_empty());
}

/// A connection whose TLS or websocket handshake fails leaves the list as it
/// fails, though its client holds the socket open, so it holds no block
/// back. One to a node held is not waited for by a block that node is not
/// told of, and is waited for by the node's release, which tells it: until
/// it pongs the peak its handshake is greeted with.
#[tokio::test]
async fn a_connection_failing_its_tls_or_websocket_handshake_or_to_a_held_node_holds_no_block_back() {
    use futures_util::FutureExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let s = setup().await;
    // Not TLS: the node's TLS refuses it and closes the socket (the read
    // ends then), and the connection has left the list by then.
    let mut not_tls = tokio::net::TcpStream::connect(s.a.addr).await.unwrap();
    not_tls.write_all(b"GET /ws HTTP/1.1\r\nHost: mock\r\n\r\n").await.unwrap();
    let _ = not_tls.read_to_end(&mut Vec::new()).await;
    // TLS, then a request that asks for no websocket.
    let mut not_ws = tls_to(&s.a).await;
    not_ws.write_all(b"GET /ws HTTP/1.1\r\nHost: mock\r\n\r\n").await.unwrap();
    let _ = not_ws.read_to_end(&mut Vec::new()).await;
    assert!(listed(&s.chain).is_empty(), "both left the list as they failed");

    s.chain.hold(&s.b);
    let mut to_held = raw_socket(&s.b).await;
    assert_eq!(listed(&s.chain), vec![(1, None)]);
    assert_eq!(s.chain.farm().now_or_never(), Some(1), "the block is not held back by a node it is not told of");

    let releasing = s.chain.release(&s.b);
    tokio::pin!(releasing);
    assert_eq!(releasing.as_mut().now_or_never(), None, "the release waits on the connection to the node it tells");
    let (peak, generation) = greet(&mut to_held, &s.chain.network()).await;
    assert_eq!((peak.height, peak.header_hash, generation), (1, s.chain.header_hash(1).unwrap(), 2));
    assert_eq!(releasing.as_mut().now_or_never(), None);
    to_held.flush().await.expect("the pong sent");
    releasing.await;
    assert_eq!(listed(&s.chain), vec![(1, Some(2))]);

    drop((not_tls, not_ws, to_held));
    assert_eq!(s.money.peak_height().await.unwrap(), 1);
    assert_eq!(s.lane.live_count().await, 2);
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

/// A reorganisation takes each node through `new_peak`'s slow path: a new
/// mempool, and every old item tried again on the new chain. A bundle still
/// in both mempools whose input the new fork keeps (made below the fork) is
/// taken back by both, stays there through the reorganisation, and lands in
/// the next block, which spends the input and makes its child.
#[tokio::test]
async fn a_bundle_in_both_mempools_whose_input_survives_a_reorg_stays_in_both_and_lands_in_the_next_block() {
    let s = setup().await;
    let coin = s.chain.fund(open_puzzle_hash(), 1000, None);
    let created = s.chain.farm().await;
    s.chain.farm_blocks(2).await;
    let write = pass_on(coin);
    s.money.push_tx(write.clone()).await.unwrap();
    for node in [&s.a, &s.b] {
        assert_eq!(s.chain.mempool_on(node), vec![write.name()]);
    }

    let peak = s.chain.reorg(2).await;
    assert_eq!(peak, created + 3);
    assert_eq!(s.chain.record(coin.coin_id()), Some((coin, created, None)), "the input is below the fork, unspent");
    for node in [&s.a, &s.b] {
        assert_eq!(s.chain.mempool_on(node), vec![write.name()], "taken back on the new chain");
    }
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()), Some((coin, created, Some(h))), "the next block spends it");
    assert_eq!(s.chain.record(passed(coin).coin_id()), Some((passed(coin), h, None)));
    assert_eq!(s.chain.children(coin.coin_id()), vec![passed(coin)]);
    for node in [&s.a, &s.b] {
        assert!(s.chain.mempool_on(node).is_empty(), "it left with the block that carried it");
    }
    assert_eq!(s.chain.acks_for(write.name()), vec![(SUCCESS, None); 2], "pushed once, to both nodes");
    assert!(s.chain.unanswered().is_empty());
}

/// A bundle still in both mempools whose input a reorganisation drops (made
/// in a block above the fork, and made again by none of the new fork's) is
/// UNKNOWN_UNSPENT on the new chain: both nodes drop it from their mempools
/// and from their seen caches, so the next block carries nothing of it, and
/// pushed again it is refused UNKNOWN_UNSPENT, not final (a node behind the
/// input's block says the same of a live spend), rather than
/// ALREADY_INCLUDING_TRANSACTION.
#[tokio::test]
async fn a_bundle_in_both_mempools_whose_input_a_reorg_drops_leaves_both_lands_nowhere_and_is_unknown_unspent_when_pushed_again() {
    let s = setup().await;
    let coin = s.chain.fund(open_puzzle_hash(), 1000, None);
    let created = s.chain.farm().await;
    let write = pass_on(coin);
    s.money.push_tx(write.clone()).await.unwrap();
    for node in [&s.a, &s.b] {
        assert_eq!(s.chain.mempool_on(node), vec![write.name()]);
    }

    let peak = s.chain.reorg(1).await;
    assert_eq!(peak, created + 1);
    assert_eq!(s.chain.record(coin.coin_id()), None, "the block that made the input is gone, and nothing made it again");
    for node in [&s.a, &s.b] {
        assert!(s.chain.mempool_on(node).is_empty(), "dropped on the new chain");
    }
    let h = s.chain.farm().await;
    assert_eq!(h, peak + 1);
    assert_eq!(s.chain.record(passed(coin).coin_id()), None, "the next block carries nothing of it");
    assert!(s.chain.children(coin.coin_id()).is_empty());

    let why = refusal(s.money.push_tx(write.clone()).await);
    assert!(why.contains("UNKNOWN_UNSPENT") && !refusal_is_final(&why), "{why}");
    let unknown = (FAILED, Some("UNKNOWN_UNSPENT".to_string()));
    assert_eq!(s.chain.acks_for(write.name()), vec![(SUCCESS, None), (SUCCESS, None), unknown.clone(), unknown]);
    unanswered(s.money.spend_live(write).await);
    assert!(s.chain.unanswered().is_empty());
}

/// A bundle still in both mempools whose input the new fork spends another
/// way is a DOUBLE_SPEND on the new chain: both nodes drop it from their
/// mempools, the next block carries nothing of it (the input's one child is
/// the other spend's), and pushed again it is refused DOUBLE_SPEND, final.
#[tokio::test]
async fn a_bundle_in_both_mempools_whose_input_the_new_fork_spends_another_way_leaves_both_and_is_a_double_spend_when_pushed_again() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    let created = s.chain.farm().await;
    s.chain.farm().await;
    let ours = pass_on(coin);
    let theirs = open_spend(coin, &[Cond::CreateCoin(hint(6), coin.amount, vec![])]);
    s.money.push_tx(ours.clone()).await.unwrap();
    for node in [&s.a, &s.b] {
        assert_eq!(s.chain.mempool_on(node), vec![ours.name()]);
    }

    let peak = s.chain.reorg_including(1, vec![theirs]).await;
    let spent = created + 1;
    assert_eq!(peak, spent + 1, "the fork is at the input's block; the first new block carries the other spend");
    assert_eq!(s.chain.record(coin.coin_id()), Some((coin, created, Some(spent))));
    for node in [&s.a, &s.b] {
        assert!(s.chain.mempool_on(node).is_empty(), "dropped on the new chain");
    }
    s.chain.farm().await;
    assert_eq!(s.chain.record(passed(coin).coin_id()), None, "the next block carries nothing of ours");
    assert_eq!(s.chain.children(coin.coin_id()), vec![Coin::new(coin.coin_id(), hint(6), coin.amount)]);

    let why = refusal(s.money.push_tx(ours.clone()).await);
    assert!(why.contains("DOUBLE_SPEND") && refusal_is_final(&why), "{why}");
    assert!(!s.money.spend_live(ours).await.unwrap(), "both nodes call it a double spend");
    assert!(s.chain.unanswered().is_empty());
}

/// A full mempool keeps its items through a reorganisation: the new mempool
/// a full node makes holds only its old items, which fitted the old one
/// together, so it is short of capacity for each (`at_full_capacity`), and a
/// fee-0 bundle whose input survives is taken back by both nodes and lands.
/// Full again once they are back, each still refuses a fresh fee-0 bundle.
#[tokio::test]
async fn a_full_mempool_takes_its_own_fee_zero_bundle_back_at_a_reorg_and_still_refuses_a_fresh_one() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    let fresh = s.chain.fund(open, 1000, None);
    s.chain.farm_blocks(2).await;
    let write = pass_on(coin);
    s.money.push_tx(write.clone()).await.unwrap();
    s.chain.set_full(true);

    s.chain.reorg(1).await;
    for node in [&s.a, &s.b] {
        assert_eq!(s.chain.mempool_on(node), vec![write.name()], "taken back, fee 0, by a full mempool");
    }
    let why = refusal(s.money.push_tx(pass_on(fresh)).await);
    assert!(why.contains("INVALID_FEE_TOO_CLOSE_TO_ZERO") && !refusal_is_final(&why), "{why}");
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h));
    assert_eq!(s.chain.record(fresh.coin_id()).unwrap().2, None);
    s.chain.set_full(false);
    assert!(s.chain.unanswered().is_empty());
}

/// The caches a reorganisation tries after the old items meet the mempool
/// as full as it was: a fee-0 bundle waiting in the pending cache for a
/// height the new fork reaches is due at the new peak, where both full
/// mempools refuse it, INVALID_FEE_TOO_CLOSE_TO_ZERO, and it leaves the
/// pending cache (`new_peak` drains what is due). Pushed again while they
/// are full it is refused the same (nothing remembers it), no later block
/// tries it again, and once they are no longer full it is taken and lands.
#[tokio::test]
async fn a_full_mempool_refuses_a_fee_zero_bundle_the_pending_cache_holds_once_a_reorg_makes_it_due() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    let created = s.chain.farm().await;
    s.chain.farm().await;
    let locked = open_spend(coin, &[Cond::AssertHeightRelative(2), Cond::CreateCoin(open, coin.amount, vec![])]);
    s.money.push_tx(locked.clone()).await.expect("a height-locked bundle waits, accepted");
    let pending = (PENDING, Some("ASSERT_HEIGHT_RELATIVE_FAILED".to_string()));
    assert_eq!(s.chain.acks_for(locked.name()), vec![pending.clone(); 2]);
    s.chain.set_full(true);

    assert_eq!(s.chain.reorg(1).await, created + 2, "the new peak is the height its lock passes at");
    assert_eq!(s.chain.record(coin.coin_id()), Some((coin, created, None)), "the input is below the fork, unspent");
    for node in [&s.a, &s.b] {
        assert!(s.chain.mempool_on(node).is_empty(), "due at the new peak, and refused there by a full mempool");
    }
    let why = refusal(s.money.push_tx(locked.clone()).await);
    assert!(why.contains("INVALID_FEE_TOO_CLOSE_TO_ZERO") && !refusal_is_final(&why), "{why}");
    let too_low = (FAILED, Some("INVALID_FEE_TOO_CLOSE_TO_ZERO".to_string()));
    assert_eq!(s.chain.acks_for(locked.name()), vec![pending.clone(), pending, too_low.clone(), too_low]);

    s.chain.set_full(false);
    s.chain.farm().await;
    assert!(s.chain.mempool().is_empty(), "gone from the pending cache, so no block tries it again");
    s.money.push_tx(locked).await.unwrap();
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()), Some((coin, created, Some(h))));
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
    // Announcements none of the bundle's spends makes: Chia names either
    // failed assertion ASSERT_ANNOUNCE_CONSUMED_FAILED.
    let unannounced_coin = open_spend(coin, &[Cond::AssertCoinAnnouncement(hint(10)), Cond::CreateCoin(open, 1000, vec![])]);
    let unannounced_puzzle = open_spend(coin, &[Cond::AssertPuzzleAnnouncement(hint(11)), Cond::CreateCoin(open, 1000, vec![])]);
    let mut a = clvmr::Allocator::new();
    let huge = a.new_atom(&vec![0u8; 500_000]).unwrap();
    let huge = Program::from(clvmr::serde::node_to_bytes(&a, huge).unwrap());
    let too_costly = SpendBundle::new(vec![CoinSpend::new(coin, Program::from(vec![1u8]), huge)], chia_bls::Signature::default());

    for (bundle, name) in [
        (wrong_puzzle.clone(), "WRONG_PUZZLE_HASH"),
        (unsigned, "BAD_AGGREGATE_SIGNATURE"),
        (elsewhere, "ASSERT_MY_PUZZLEHASH_FAILED"),
        (unannounced_coin, "ASSERT_ANNOUNCE_CONSUMED_FAILED"),
        (unannounced_puzzle, "ASSERT_ANNOUNCE_CONSUMED_FAILED"),
        (too_costly, "BLOCK_COST_EXCEEDS_MAX"),
    ] {
        let why = refusal(s.money.push_tx(bundle.clone()).await);
        assert!(why.contains(name) && refusal_is_final(&why), "{name}: {why}");
        assert_eq!(s.chain.acks_for(bundle.name()), vec![(FAILED, Some(name.to_string())); 2]);
    }
    let why = refusal(s.money.push_tx(wrong_puzzle.clone()).await);
    assert!(why.contains("ALREADY_INCLUDING_TRANSACTION") && !refusal_is_final(&why), "{why}");
    unanswered(s.money.spend_live(wrong_puzzle).await);
    assert_eq!(
        err_name(ErrorCode::AssertCoinAnnouncementFailed),
        err_name(ErrorCode::AssertPuzzleAnnouncementFailed),
        "chia_rs folds both announcement assertions into Chia's code 12"
    );
    assert!(s.chain.unanswered().is_empty());
}

/// A bundle whose coin or puzzle announcement assertion fails is refused
/// ASSERT_ANNOUNCE_CONSUMED_FAILED by both nodes, a final word from each,
/// so the lane calls it dead: what the lease's probe of a bundle whose push
/// never left (a stop between the two) hears, freeing its coins. Sent again,
/// both remember it, ALREADY_INCLUDING_TRANSACTION, which is no verdict.
#[tokio::test]
async fn a_bundle_both_nodes_refuse_assert_announce_consumed_failed_is_dead_through_the_lane() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let refused = (FAILED, Some("ASSERT_ANNOUNCE_CONSUMED_FAILED".to_string()));
    for assertion in [Cond::AssertCoinAnnouncement(hint(10)), Cond::AssertPuzzleAnnouncement(hint(11))] {
        let bundle = open_spend(coin, &[assertion, Cond::CreateCoin(open, 1000, vec![])]);
        assert!(!s.money.spend_live(bundle.clone()).await.unwrap(), "both nodes' final word: dead");
        assert_eq!(s.chain.acks_for(bundle.name()), vec![refused.clone(); 2]);
        unanswered(s.money.spend_live(bundle).await);
    }
    assert!(s.chain.mempool().is_empty());
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, None);
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

/// A node too busy to validate a bundle in time refuses it
/// INVALID_SPEND_BUNDLE, `add_transaction`'s soft failure, which is no
/// final word and which the node does not remember. With both nodes busy a
/// fresh bundle is refused by both and its liveness has no verdict; it is
/// in neither seen cache, so once they are not busy it is taken (SUCCESS,
/// not ALREADY_INCLUDING_TRANSACTION) and lands. A bundle a node holds is
/// SUCCESS there before anything is validated, busy or not, so with both
/// busy it is live.
#[tokio::test]
async fn a_busy_node_refuses_a_good_bundle_with_invalid_spend_bundle_not_final_not_remembered_and_answers_one_it_holds_success() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    let later = s.chain.fund(open, 2000, None);
    s.chain.farm().await;
    let busy = (FAILED, Some("INVALID_SPEND_BUNDLE".to_string()));

    let write = pass_on(coin);
    s.chain.set_busy(&s.a, true);
    s.chain.set_busy(&s.b, true);
    let why = refusal(s.money.push_tx(write.clone()).await);
    assert!(why.contains("INVALID_SPEND_BUNDLE") && !refusal_is_final(&why), "{why}");
    unanswered(s.money.spend_live(write.clone()).await);
    assert_eq!(s.chain.acks_for(write.name()), vec![busy.clone(); 4], "the push and the probe, refused by both");
    assert!(s.chain.mempool().is_empty());
    assert!(!s.chain.lock().nodes.iter().any(|n| n.pool.seen(&write.name())), "in neither seen cache");
    s.chain.set_busy(&s.a, false);
    s.chain.set_busy(&s.b, false);
    s.money.push_tx(write.clone()).await.expect("judged afresh by both");
    assert_eq!(s.chain.acks_for(write.name()).split_off(4), vec![(SUCCESS, None); 2]);
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(coin.coin_id()).unwrap().2, Some(h));
    assert_eq!(s.chain.children(coin.coin_id()), vec![passed(coin)]);

    let held = pass_on(later);
    s.chain.set_busy(&s.b, true);
    s.money.push_tx(held.clone()).await.expect("one node took it");
    assert_eq!(s.chain.mempool_on(&s.a), vec![held.name()]);
    assert!(s.chain.mempool_on(&s.b).is_empty());
    s.chain.set_busy(&s.a, true);
    assert!(s.money.spend_live(held.clone()).await.unwrap(), "the node that holds it answers SUCCESS, busy or not");
    let mut probed = s.chain.acks_for(held.name()).split_off(2);
    probed.sort();
    assert_eq!(probed, vec![(SUCCESS, None), busy], "the holder's SUCCESS, the other's busy refusal");
    s.chain.set_busy(&s.a, false);
    s.chain.set_busy(&s.b, false);
    let h = s.chain.farm().await;
    assert_eq!(s.chain.record(later.coin_id()).unwrap().2, Some(h));
    assert!(s.chain.unanswered().is_empty());
}

/// A busy node's timeout is checked only once the CLVM run and the signature
/// check passed, so a bundle either refuses keeps that refusal's own name on
/// a busy node: with both busy, a bundle whose announcement assertion fails
/// and one whose signature is missing are each refused by name by both, a
/// final word, so dead. Each refusal is remembered, and the seen cache is
/// looked in before anything is validated, so sent again to the still-busy
/// nodes each is ALREADY_INCLUDING_TRANSACTION from both, not the busy
/// refusal.
#[tokio::test]
async fn a_busy_node_refuses_a_bad_bundle_by_its_own_name_and_one_it_remembers_already_including() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let key = Bytes::new(chia_bls::SecretKey::from_seed(&[9u8; 32]).public_key().to_bytes().to_vec());
    let unannounced = open_spend(coin, &[Cond::AssertCoinAnnouncement(hint(10)), Cond::CreateCoin(open, 1000, vec![])]);
    let unsigned = open_spend(coin, &[Cond::AggSigMe(key, Bytes::new(b"hello".to_vec())), Cond::CreateCoin(open, 1000, vec![])]);
    s.chain.set_busy(&s.a, true);
    s.chain.set_busy(&s.b, true);
    let seen = (FAILED, Some("ALREADY_INCLUDING_TRANSACTION".to_string()));
    for (bundle, name) in [(unannounced, "ASSERT_ANNOUNCE_CONSUMED_FAILED"), (unsigned, "BAD_AGGREGATE_SIGNATURE")] {
        assert!(!s.money.spend_live(bundle.clone()).await.unwrap(), "{name} from both, busy or not: dead");
        assert_eq!(s.chain.acks_for(bundle.name()), vec![(FAILED, Some(name.to_string())); 2]);
        let why = refusal(s.money.push_tx(bundle.clone()).await);
        assert!(why.contains("ALREADY_INCLUDING_TRANSACTION") && !why.contains("INVALID_SPEND_BUNDLE"), "{why}");
        assert_eq!(s.chain.acks_for(bundle.name()).split_off(2), vec![seen.clone(); 2], "remembered by both");
    }
    assert!(s.chain.mempool().is_empty());
    s.chain.set_busy(&s.a, false);
    s.chain.set_busy(&s.b, false);
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
/// old one only the node that took the old fork does, as only one of two
/// real nodes with those histories does. The agreed listing there asks
/// both for the coin by id and for its parent's spend, finds the spend made
/// it under the new hint, so the row stale, and lists nothing, letting
/// neither node go.
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
    let stale = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(stale.records.is_empty() && !stale.truncated, "the row only node a keeps is stale: {stale:?}");
    assert_eq!(stale.judged_at, Some(peak));
    assert_eq!(s.lane.live_count().await, 2, "neither node was let go");
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

/// How many requests of `kind` `node` has read.
fn asked(node: &MockNode, kind: ProtocolMessageTypes) -> usize {
    node.seen.lock().unwrap().iter().filter(|k| **k == kind).count()
}

/// The coin-state and spend requests each node has read, node a's first.
fn by_id_and_spends(s: &Setup) -> [(usize, usize); 2] {
    [&s.a, &s.b].map(|n| (asked(n, ProtocolMessageTypes::RequestCoinState), asked(n, ProtocolMessageTypes::RequestPuzzleSolution)))
}

/// The requests of [`by_id_and_spends`] each node has read since `before`.
fn asked_since(s: &Setup, before: [(usize, usize); 2]) -> [(usize, usize); 2] {
    let now = by_id_and_spends(s);
    [0, 1].map(|i| (now[i].0 - before[i].0, now[i].1 - before[i].1))
}

/// The nodes the lane still holds a connection to.
async fn live(s: &Setup) -> Vec<SocketAddr> {
    let mut addrs: Vec<SocketAddr> = s.lane.live_conns().await.iter().map(|c| c.addr()).collect();
    addrs.sort();
    addrs
}

/// A chain, its two nodes, and a lane on them at both trust levels with
/// node a pinned and node b its public peer.
async fn pinned() -> Setup {
    let chain = MockChain::new(NET);
    let (a, b) = chain.pair().await;
    let lane = chain.pinned_lane(&a, &b);
    let money = PeerLane::new(lane.clone(), Trust::Agreed);
    let carrier = PeerLane::new(lane.clone(), Trust::Carrier);
    Setup { chain, a, b, lane, money, carrier }
}

/// Whether the lane let `node` go ([`Lane::evict`]): left alone for longer
/// than a dropped connection waits, [`RETRY_AFTER`], and forgotten by the
/// store. A connection dropped (back to the queue) waits
/// [`RECONNECT_AFTER`] at most, and the store keeps it.
///
/// [`RETRY_AFTER`]: crate::chia_peer_lane::RETRY_AFTER
/// [`RECONNECT_AFTER`]: crate::chia_peer_lane::RECONNECT_AFTER
async fn let_go(s: &Setup, node: &MockNode) -> bool {
    let cooled = s.lane.cooling_for(node.addr).await.is_some_and(|left| left > crate::chia_peer_lane::RECONNECT_AFTER);
    if cooled {
        assert!(!s.lane.stores(node.addr).await, "a peer let go is forgotten by the store");
    }
    cooled
}

/// One agreed read both nodes answer alike, so the store keeps the public
/// peers among them as known-good.
async fn remembered(s: &Setup) {
    assert!(s.money.coin_records_by_hint(hint(99), None, true, None).await.unwrap().records.is_empty());
    for node in [&s.a, &s.b] {
        let pinned = s.lane.live_conns().await.iter().any(|c| c.addr() == node.addr && c.source() == Source::Pin);
        assert_eq!(s.lane.stores(node.addr).await, !pinned, "the store keeps the public peers, never a pin");
    }
}

/// How many header requests each node has read, node a's first.
fn headers(s: &Setup) -> [usize; 2] {
    [&s.a, &s.b].map(|n| asked(n, ProtocolMessageTypes::RequestBlockHeader))
}

/// How many times the lane has run `spend` to read the hints of what it
/// made ([`crate::chia_peer_lane::SPEND_RUNS`]).
fn runs_of(spend: &CoinSpend) -> usize {
    crate::chia_peer_lane::SPEND_RUNS.lock().unwrap().get(&spend.solution.to_vec()).copied().unwrap_or(0)
}

/// Any CLVM value as a program: a memos argument of any shape
/// ([`Cond::CreateCoinMemos`]).
fn program(value: impl clvm_traits::ToClvm<clvmr::Allocator>) -> Program {
    let mut a = clvmr::Allocator::new();
    let node = value.to_clvm(&mut a).expect("a CLVM value");
    Program::from(clvmr::serde::node_to_bytes(&a, node).expect("its bytes"))
}

/// Each of `parents` passed whole to the open puzzle under the memo `hint`:
/// the child [`passed`] names, made again under any other hint by the same
/// spend with that memo.
fn passing(parents: &[Coin], hint: Bytes32) -> Vec<CoinSpend> {
    parents.iter().map(|p| open_coin_spend(*p, &[Cond::CreateCoin(open_puzzle_hash(), p.amount, memo(hint))])).collect()
}

fn bundle(spends: Vec<CoinSpend>) -> SpendBundle {
    SpendBundle::new(spends, chia_bls::Signature::default())
}

/// Stale hint rows on node a alone, come by as two real nodes come by them:
/// node b is held while a block carrying `old` comes and goes, replaced by
/// a fork whose first block carries `new`, the same spends with other
/// memos, which make the same coins at the same height; then b is released
/// onto the new fork. Node a keeps the old block's rows beside the new
/// one's, and b has the new one's alone. Returns the peak; the coins are
/// made a block below it.
async fn stale_rows_on_a(s: &Setup, old: SpendBundle, new: SpendBundle) -> u32 {
    s.chain.hold(&s.b);
    s.chain.include_next(old);
    s.chain.farm().await;
    let peak = s.chain.reorg_including(1, vec![new]).await;
    s.chain.release(&s.b).await;
    peak
}

/// A stale row node a alone keeps is settled by the coin's id and its
/// parent's spend only when both nodes say the same of the coin. Node a,
/// which lists it under the old hint, denying it by id, or node b, which
/// leaves it out, denying it while a gives it, is a disagreement as any
/// other: the listing has no answer and both public peers are let go.
#[tokio::test]
async fn a_coin_one_node_lists_under_a_hint_and_either_node_denies_by_id_is_a_disagreement_and_both_nodes_are_let_go() {
    for denier in ["a, which lists it", "b, which leaves it out"] {
        let s = setup().await;
        let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
        s.chain.farm().await;
        stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
        let node = if denier.starts_with('a') { &s.a } else { &s.b };
        s.chain.deny_on(node, passed(parent).coin_id());
        let before = by_id_and_spends(&s);

        let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
        assert!(why.contains("disagree"), "{denier}: {why}");
        assert_eq!(s.lane.live_count().await, 0, "{denier}: both peers were let go");
        assert_eq!(asked_since(&s, before), [(1, 0); 2], "{denier}: one lookup of each node by id, and no spend once a node denied the coin");
        assert!(s.chain.unanswered().is_empty());
    }
}

/// A genuine hinted coin one node leaves out of its listing while it gives
/// the coin by id and serves the spend that made it, which carries the hint
/// as its first memo, is kept: the listing comes back whole, in height then
/// id order. A coin at the hint's own puzzle hash it leaves out is kept on
/// its record alone, its parent's spend never asked for (a funding coin's
/// parent was never spent, and no node could serve one). A full node files
/// a row for every coin its chain made under a hint, so the node that left
/// them out, a block below the peak its page is dated by, hid them: it is
/// let go, cooled and forgotten by the store, and never noted good after;
/// the node that listed them stays pooled, and this very read has the
/// store keep it, as the store held neither node before.
#[tokio::test]
async fn a_hinted_coin_one_node_leaves_out_but_gives_by_id_is_kept_and_the_node_that_hid_it_is_let_go_while_the_other_is_noted_good() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[parent], hint(1))));
    let both = s.chain.fund(open, 500, Some(hint(1)));
    let at_hint = s.chain.fund(hint(1), 700, None);
    let made = s.chain.farm().await;
    let peak = s.chain.farm().await;
    let child = passed(parent);
    s.chain.hide_on(&s.b, child.coin_id());
    s.chain.hide_on(&s.b, at_hint.coin_id());
    for node in [&s.a, &s.b] {
        assert!(!s.lane.stores(node.addr).await, "the store holds neither node yet");
    }
    let before = by_id_and_spends(&s);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    let mut want = vec![(both, made), (child, made), (at_hint, made)];
    want.sort_by_key(|(c, _)| c.coin_id());
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), want, "both coins b left out are kept");
    assert!(!listed.truncated && listed.judged_at == Some(peak));
    assert_eq!(asked_since(&s, before), [(1, 1); 2], "one lookup by id and one spend of each node; none for the coin at the hint");
    assert_eq!(live(&s).await, vec![s.a.addr], "node b, which hid them, is gone from the pool");
    assert!(let_go(&s, &s.b).await, "and let go, forgotten by the store: never noted good");
    assert!(!let_go(&s, &s.a).await && s.lane.stores(s.a.addr).await, "node a, which listed them, is noted good by this read");
    assert!(s.chain.unanswered().is_empty());
}

/// A coin is filed under the hint a full node reads in its output: the
/// first element of the CREATE_COIN's memos when that is an atom, whatever
/// follows it. Under memos `(hint (1))` or `(hint . 5)`, which read as no
/// list of atoms, both nodes file the coin under the hint, so node b
/// leaving those coins out, a block below its page's peak, is a peer
/// hiding them, and the lane keeps them, as it keeps any coin the chain
/// made under the hint, and lets b go.
#[tokio::test]
async fn a_coin_whose_memos_are_no_list_of_atoms_but_start_with_the_hint_is_kept_when_one_node_leaves_it_out() {
    use clvm_traits::clvm_list;
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let nested = program(clvm_list!(hint(1), clvm_list!(1)));
    let dotted = program((hint(1), 5));
    let spend = open_coin_spend(parent, &[Cond::CreateCoinMemos(open, 600, nested), Cond::CreateCoinMemos(open, 400, dotted)]);
    s.money.push_tx(bundle(vec![spend])).await.unwrap();
    let made = s.chain.farm().await;
    let peak = s.chain.farm().await;
    let children: Vec<Coin> = [600, 400].map(|amount| Coin::new(parent.coin_id(), open, amount)).to_vec();
    for child in &children {
        s.chain.hide_on(&s.b, child.coin_id());
    }

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    let mut want: Vec<(Coin, u32)> = children.iter().map(|c| (*c, made)).collect();
    want.sort_by_key(|(c, _)| c.coin_id());
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), want, "both coins b left out are kept");
    assert!(!listed.truncated && listed.judged_at == Some(peak));
    assert_eq!(live(&s).await, vec![s.a.addr], "node b, which hid them, is let go");
    assert!(let_go(&s, &s.b).await);
    assert!(s.chain.unanswered().is_empty());
}

/// A one-sided coin is judged by the output that makes it, not by its
/// siblings: the new fork's spend makes it under another hint beside a
/// sibling under the listed one, and its row is stale all the same, while
/// the sibling, which both nodes list, stays.
#[tokio::test]
async fn a_one_sided_coin_whose_parent_spend_makes_a_sibling_under_the_hint_is_still_a_stale_row() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let made = |first: Bytes32, second: Bytes32| {
        bundle(vec![open_coin_spend(parent, &[Cond::CreateCoin(open, 600, memo(first)), Cond::CreateCoin(open, 400, memo(second))])])
    };
    stale_rows_on_a(&s, made(hint(1), hint(2)), made(hint(2), hint(1))).await;

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| r.coin.amount).collect::<Vec<_>>(), vec![400], "the 600 row is stale: {listed:?}");
    assert_eq!(s.lane.live_count().await, 2, "neither node was let go");
    assert!(s.chain.unanswered().is_empty());
}

/// The hint as a later memo of the output, not its first, files no row: a
/// one-sided coin the new fork made with memos (other hint, listed hint) is
/// a stale row.
#[tokio::test]
async fn the_hint_as_a_later_memo_of_the_output_files_no_row_so_a_one_sided_coin_made_so_is_stale() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    let later = vec![Bytes::new(hint(2).to_vec()), Bytes::new(hint(1).to_vec())];
    let new = bundle(vec![open_coin_spend(parent, &[Cond::CreateCoin(open, 1000, later)])]);
    stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), new).await;

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated, "{listed:?}");
    assert_eq!(s.lane.live_count().await, 2, "neither node was let go");
    assert!(s.chain.unanswered().is_empty());
}

/// A kept coin is merged into the listing in height then id order: made a
/// block below a coin both nodes list, it comes first (and node b, which
/// hid it, is let go).
#[tokio::test]
async fn a_kept_coin_is_listed_in_height_order_among_the_coins_both_nodes_list() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    s.money.push_tx(bundle(passing(&[parent], hint(1)))).await.unwrap();
    let made = s.chain.farm().await;
    let later = s.chain.fund(open, 500, Some(hint(1)));
    let after = s.chain.farm().await;
    s.chain.hide_on(&s.b, passed(parent).coin_id());

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(passed(parent), made), (later, after)]);
    assert_eq!(live(&s).await, vec![s.a.addr], "node b, which hid the coin, is let go");
    assert!(s.chain.unanswered().is_empty());
}

/// Node a a block ahead, the one-sided coin spent in that block: a's
/// answer by id is taken as of the listing's height, where the coin stands
/// unspent as both pages give it, so the row is settled as stale, dated at
/// the lower height, and nobody is let go.
#[tokio::test]
async fn a_node_ahead_whose_one_sided_coin_was_spent_above_the_listing_gives_it_by_id_as_of_the_listing() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    s.chain.hold(&s.b);
    s.chain.include_next(pass_on(passed(parent)));
    assert_eq!(s.chain.farm().await, peak + 1);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated && listed.judged_at == Some(peak), "{listed:?}");
    assert_eq!(s.lane.live_count().await, 2, "neither node was let go");
    s.chain.release(&s.b).await;
    assert!(s.chain.unanswered().is_empty());
}

/// Only a hinted listing settles one-sided coins: a puzzle-hash listing one
/// node leaves a coin out of is a disagreement as before, both nodes let
/// go, nothing asked by id or for a spend.
#[tokio::test]
async fn a_puzzle_hash_listing_one_node_leaves_a_coin_out_of_is_a_disagreement_and_asks_nothing_by_id() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let coin = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    s.chain.hide_on(&s.b, coin.coin_id());
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_puzzle_hash(open, true, None).await);
    assert!(why.contains("disagree"), "{why}");
    assert_eq!(by_id_and_spends(&s), before, "nothing asked by id or for a spend");
    assert_eq!(s.lane.live_count().await, 0, "both peers were let go");
    assert!(s.chain.unanswered().is_empty());
}

/// Node a serves another spend of the parent than node b does: the old
/// fork's, which made the coin under the old hint, as a peer keeping its
/// stale row would have to. The two spends differ, which is a
/// disagreement: the listing has no answer and both are let go.
#[tokio::test]
async fn a_one_sided_coin_whose_parent_spend_the_nodes_serve_otherwise_is_a_disagreement_and_both_nodes_are_let_go() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    s.chain.serve_spend_on(&s.a, parent.coin_id(), passing(&[parent], hint(1)).pop());
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("disagree"), "{why}");
    assert_eq!(asked_since(&s, before), [(1, 1); 2], "both nodes asked by id and for the spend");
    assert_eq!(s.lane.live_count().await, 0, "both peers were let go");
    assert!(s.chain.unanswered().is_empty());
}

/// The spend that made a one-sided coin served by neither node: an honest
/// node lists a coin under a hint only once a spend on its chain made it so,
/// and serves that spend, so node a, whose page listed the coin, is at
/// fault. The coin is left out, the listing comes back without it, and a is
/// let go; node b stays pooled, and this very read has the store keep it,
/// as the store held neither node before.
#[tokio::test]
async fn a_one_sided_coin_whose_parent_spend_neither_node_serves_is_left_out_and_the_node_that_listed_it_is_let_go() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    for node in [&s.a, &s.b] {
        s.chain.serve_spend_on(node, parent.coin_id(), None);
        assert!(!s.lane.stores(node.addr).await, "the store holds neither node yet");
    }
    let before = by_id_and_spends(&s);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated && listed.judged_at == Some(peak), "the coin is left out: {listed:?}");
    assert_eq!(asked_since(&s, before), [(1, 1); 2]);
    assert_eq!(live(&s).await, vec![s.b.addr], "node a, which listed the coin, is gone from the pool");
    assert!(let_go(&s, &s.a).await, "and let go");
    assert!(!let_go(&s, &s.b).await && s.lane.stores(s.b.addr).await, "node b is noted good by this read");
    assert!(s.chain.unanswered().is_empty());
}

/// One-sided coins made by sixteen spends in one listing
/// ([`crate::chia_peer_lane::MAX_DISPUTED_PARENTS`]) are settled: every row
/// is stale and the listing empty, at one lookup by id and sixteen spend
/// requests of each node. Made by seventeen, the first sixteen spends and
/// their coins are settled as ever, the seventeenth's coin not even asked
/// for by id, so the read has no verdict. The
/// sixteen show nobody at fault (every row stale), and nothing tells which
/// node lists rows a fork left behind and which hides what the chain made:
/// both public nodes have their connections dropped, the lister's and the
/// other's alike, neither let go (cooled for a reconnect's wait at most,
/// kept by the store).
#[tokio::test]
async fn one_sided_coins_made_by_more_than_sixteen_spends_give_no_answer_and_with_nobody_at_fault_drop_both_public_nodes_unpunished() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let over: Vec<Coin> = (0..=MAX_DISPUTED_PARENTS as u64).map(|n| s.chain.fund(open, 1000 + n, None)).collect();
    let at: Vec<Coin> = (0..MAX_DISPUTED_PARENTS as u64).map(|n| s.chain.fund(open, 2000 + n, None)).collect();
    s.chain.farm().await;
    let old = [passing(&over, hint(1)), passing(&at, hint(3))].concat();
    let new = [passing(&over, hint(2)), passing(&at, hint(4))].concat();
    let peak = stale_rows_on_a(&s, bundle(old), bundle(new)).await;
    assert_eq!(s.chain.record(passed(over[0]).coin_id()), Some((passed(over[0]), peak - 1, None)));

    let before = by_id_and_spends(&s);
    let listed = s.money.coin_records_by_hint(hint(3), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated, "sixteen stale rows settled: {listed:?}");
    assert_eq!(asked_since(&s, before), [(1, MAX_DISPUTED_PARENTS); 2]);
    assert_eq!(s.lane.live_count().await, 2);

    let before = by_id_and_spends(&s);
    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("17 spends, more than the 16"), "{why}");
    assert_eq!(asked_since(&s, before), [(1, MAX_DISPUTED_PARENTS); 2], "the first sixteen spends' coins asked of each node by id, and those spends");
    assert!(live(&s).await.is_empty(), "both public nodes are dropped");
    for node in [&s.a, &s.b] {
        assert!(!let_go(&s, node).await && s.lane.stores(node.addr).await, "neither is let go");
    }
    assert!(s.chain.unanswered().is_empty());
}

/// One-sided coins over the limit are asked by id as far as one settling
/// takes them, the coins of the first sixteen spends in (parent, height)
/// order: one of those a node denies, as it would a coin the other made
/// up, is a disagreement all the same, both nodes let go, no spend asked
/// for; the coin of the seventeenth spend is not asked for, so a node
/// denying it changes nothing: no verdict, both public nodes dropped,
/// neither let go.
#[tokio::test]
async fn one_sided_coins_over_the_limit_a_node_denies_by_id_are_a_disagreement_as_far_as_one_settling_takes_them() {
    for taken in [true, false] {
        let s = setup().await;
        let open = open_puzzle_hash();
        let mut over: Vec<Coin> = (0..=MAX_DISPUTED_PARENTS as u64).map(|n| s.chain.fund(open, 3000 + n, None)).collect();
        s.chain.farm().await;
        stale_rows_on_a(&s, bundle(passing(&over, hint(1))), bundle(passing(&over, hint(2)))).await;
        over.sort_by_key(|p| p.coin_id());
        let denied = if taken { over[0] } else { over[MAX_DISPUTED_PARENTS] };
        s.chain.deny_on(&s.b, passed(denied).coin_id());
        let before = by_id_and_spends(&s);

        let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
        if taken {
            assert!(why.contains("disagree"), "{why}");
            assert_eq!(asked_since(&s, before), [(1, 0); 2]);
            assert_eq!(s.lane.live_count().await, 0, "both peers were let go");
        } else {
            assert!(why.contains("17 spends, more than the 16") && why.contains("nobody at fault"), "{why}");
            assert_eq!(asked_since(&s, before), [(1, MAX_DISPUTED_PARENTS); 2]);
            assert_eq!(s.lane.live_count().await, 0, "both public nodes are dropped");
            for node in [&s.a, &s.b] {
                assert!(!let_go(&s, node).await, "and neither is let go");
            }
        }
        assert!(s.chain.unanswered().is_empty());
    }
}

/// A hinted listing both nodes agree on asks neither for a coin by id nor
/// for a spend, a stale row both keep included: the coin both list under
/// the old hint is listed, as two real nodes that took both forks list it
/// (whether its memo carries the hint is the readers' to judge).
#[tokio::test]
async fn a_hinted_listing_both_nodes_agree_on_asks_neither_for_a_coin_by_id_nor_for_a_spend() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[parent], hint(1))));
    s.chain.farm().await;
    let peak = s.chain.reorg_including(1, vec![bundle(passing(&[parent], hint(2)))]).await;
    let before = by_id_and_spends(&s);

    for h in [hint(1), hint(2)] {
        let listed = s.money.coin_records_by_hint(h, None, true, None).await.unwrap();
        assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(passed(parent), peak - 1)]);
    }
    assert!(s.money.coin_records_by_hint(hint(5), None, true, None).await.unwrap().records.is_empty());
    assert_eq!(by_id_and_spends(&s), before, "no request more than the listings");
    assert_eq!(s.lane.live_count().await, 2);
    assert!(s.chain.unanswered().is_empty());
}

/// Settling a page's one-sided coins costs one lookup by id of each node,
/// all the coins in it, one request of each node per spend that made them,
/// and one run of each spend: three stale rows, two of them children of one
/// parent, cost one lookup and two spend requests of each node, and each of
/// the two spends is run once.
#[tokio::test]
async fn settling_one_sided_coins_asks_each_node_once_by_id_and_once_per_spend_and_runs_each_spend_once() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let (twice, once) = (s.chain.fund(open, 1000, None), s.chain.fund(open, 503, None));
    s.chain.farm().await;
    let made = |h: Bytes32| {
        bundle(vec![
            open_coin_spend(twice, &[Cond::CreateCoin(open, 401, memo(h)), Cond::CreateCoin(open, 599, memo(h))]),
            open_coin_spend(once, &[Cond::CreateCoin(open, 503, memo(h))]),
        ])
    };
    let peak = stale_rows_on_a(&s, made(hint(1)), made(hint(2))).await;
    assert_eq!(s.chain.children(twice.coin_id()).len(), 2);
    let new = made(hint(2)).coin_spends;
    assert_eq!(new.iter().map(runs_of).collect::<Vec<_>>(), vec![0, 0]);
    let before = by_id_and_spends(&s);

    let stale = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(stale.records.is_empty() && !stale.truncated && stale.judged_at == Some(peak), "{stale:?}");
    assert_eq!(asked_since(&s, before), [(1, 2); 2], "one lookup by id, and the two parents' spends, of each node");
    assert_eq!(new.iter().map(runs_of).collect::<Vec<_>>(), vec![1, 1], "each spend run once, the one that made two coins too");
    let after = by_id_and_spends(&s);
    let listed = s.money.coin_records_by_hint(hint(2), None, true, None).await.unwrap();
    assert_eq!(listed.records.len(), 3, "all three under the new hint, which both nodes list");
    assert_eq!(by_id_and_spends(&s), after, "and nothing more asked for that");
    assert_eq!(s.lane.live_count().await, 2);
    assert!(s.chain.unanswered().is_empty());
}

/// A reorganisation between the listing and its lookup by id: the fork
/// drops the block that made the one-sided coin, so both nodes, answering
/// from the new chain, deny the coin a page listed, which would read as a
/// disagreement and let two honest nodes go. Both first show where they
/// stand: neither has the listing's block any more, so the read has no
/// verdict and nobody is let go (the public connections whose chain moved
/// dropped, back to the queue, cooled for a reconnect's wait at most, kept
/// by the store). Once they are dialled again, the next read, on the new
/// chain alone, agrees: the coin is gone.
#[tokio::test]
async fn a_reorg_between_the_listing_and_its_lookup_by_id_leaves_the_read_unanswered_and_lets_neither_node_go() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.reorg_before(ProtocolMessageTypes::RequestCoinState, 2, vec![]);
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("moved off the listing's block"), "{why}");
    assert!(!s.chain.reorg_staged(), "the fork came as the lookup was answered");
    assert_eq!(s.chain.record(passed(parent).coin_id()), None, "the coin is gone with it");
    // A lookup whose peak moved under it (the fork's announcement landing
    // meanwhile) is asked again (`states_on`).
    for (by_id, spends) in asked_since(&s, before) {
        assert!((1..=crate::chia_peer_lane::PEAK_SETTLE_ATTEMPTS).contains(&by_id) && spends == 0, "no spend asked once the lookup told the verdict");
    }
    for node in [&s.a, &s.b] {
        assert!(!let_go(&s, node).await && s.lane.stores(node.addr).await, "neither node is let go");
    }

    s.lane.expire_pin_cooldown().await;
    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated, "{listed:?}");
    assert_eq!(s.lane.live_count().await, 2);
    assert!(s.chain.unanswered().is_empty());
}

/// A reorganisation between the lookup by id and the spend round: the fork
/// drops the block that made the one-sided coin, so neither node serves
/// the spend that made it any more, which would read as node a listing a
/// coin nobody can show it was made, and let an honest node go. Both first
/// show where they stand: the fork's announcement lands inside the window
/// of each node's spends and headers, so each is asked for its spend again
/// in a window its peak stands still across, which shows the listing's
/// block gone: the read has no verdict and nobody is let go.
#[tokio::test]
async fn a_reorg_between_the_lookup_by_id_and_the_spend_round_leaves_the_read_unanswered_and_lets_neither_node_go() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.reorg_before(ProtocolMessageTypes::RequestPuzzleSolution, 2, vec![]);
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("moved off the listing's block"), "{why}");
    assert!(!s.chain.reorg_staged(), "the fork came as the spend was asked for");
    assert_eq!(asked_since(&s, before), [(1, 2); 2], "one lookup by id of each node, and its spend in two windows: the one the fork came in, and the next");
    for node in [&s.a, &s.b] {
        assert!(!let_go(&s, node).await && s.lane.stores(node.addr).await, "neither node is let go");
    }

    s.lane.expire_pin_cooldown().await;
    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated, "{listed:?}");
    assert_eq!(s.lane.live_count().await, 2);
    assert!(s.chain.unanswered().is_empty());
}

/// The coin made again at the same height under another memo by a fork
/// that comes between the rounds: its record by id is the same on both
/// chains, but the spend both nodes serve after the fork files it under
/// another hint. Node b hid the coin on the chain the listing was taken
/// from, where the chain made it under the hint; judged by the new fork's
/// spend beside the old fork's listing, the coin would be a stale row and
/// b would pass as honest. Both nodes first show where they stand: the
/// listing's block is gone, so nothing is judged, and nobody is let go.
/// The next read, on the new chain alone, finds the row stale, as it now is.
#[tokio::test]
async fn a_coin_made_again_at_the_same_height_under_another_memo_between_the_rounds_is_not_judged_by_the_new_forks_spend_beside_the_old_listing() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[parent], hint(1))));
    let made = s.chain.farm().await;
    let child = passed(parent);
    remembered(&s).await;
    s.chain.hide_on(&s.b, child.coin_id());
    s.chain.reorg_before(ProtocolMessageTypes::RequestPuzzleSolution, 1, vec![bundle(passing(&[parent], hint(2)))]);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("moved off the listing's block"), "{why}");
    assert!(!s.chain.reorg_staged());
    assert_eq!(s.chain.record(child.coin_id()), Some((child, made, None)), "the same coin, made again at the same height");
    for node in [&s.a, &s.b] {
        assert!(!let_go(&s, node).await && s.lane.stores(node.addr).await, "neither node is let go");
    }

    s.lane.expire_pin_cooldown().await;
    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated, "on the new chain the row is stale: {listed:?}");
    assert_eq!(s.lane.live_count().await, 2, "and nobody is let go for it");
    assert!(s.chain.unanswered().is_empty());
}

/// Two reorganisations inside one settling (#393 review): during the spend
/// round both nodes switch to a fork, B, which makes the one-sided coin
/// again (the same parent, puzzle hash and amount, so the same id, at the
/// same height) under another memo, and before they show their headers
/// they switch to a heavier extension of the listing's own chain, its
/// blocks back with the same hashes and two more. The headers at the
/// listing's height and at the lookup's peak are then the listing's again,
/// but the spends fetched came from B: judged by them, the coin node b hid
/// would be a stale row, left out of the listing, and b would pass as
/// honest. Each node is asked for its spends and shows its chain inside one
/// window its announced peak stands still across: B's announcement lands
/// inside the first window, so the spends are asked again, on the
/// listing's chain, and judged there. The coin is kept, and node b, which
/// hid it a block below its page's peak, is let go; node a stays.
#[tokio::test]
async fn a_fork_that_comes_during_the_spend_round_and_is_overtaken_by_the_listings_own_chain_before_the_headers_is_not_judged_by_its_spend() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[parent], hint(1))));
    let made = s.chain.farm().await;
    let peak = s.chain.farm().await;
    let child = passed(parent);
    remembered(&s).await;
    s.chain.hide_on(&s.b, child.coin_id());
    let listed_on = s.chain.save();
    let (at_made, at_peak) = (s.chain.header_hash(made), s.chain.header_hash(peak));
    // Fork B: the two blocks from `made` replaced by three, its first, at
    // `made`, making the child again under the other hint.
    s.chain.reorg_before(ProtocolMessageTypes::RequestPuzzleSolution, 2, vec![bundle(passing(&[parent], hint(2)))]);
    // Then the listing's chain again, two blocks above it: heavier than B.
    s.chain.return_before(ProtocolMessageTypes::RequestBlockHeader, &listed_on, 2);
    let before = by_id_and_spends(&s);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert_eq!(
        listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(),
        vec![(child, made)],
        "the coin the listing's chain made under the hint is kept: no spend of fork B is judged beside it"
    );
    assert!(!listed.truncated && listed.judged_at == Some(peak), "{listed:?}");
    assert!(!s.chain.reorg_staged(), "both forks came during the read");
    assert_eq!(s.chain.peak(), peak + 2, "the listing's chain, two blocks above the listing");
    assert_eq!((s.chain.header_hash(made), s.chain.header_hash(peak)), (at_made, at_peak), "its blocks as they were");
    assert_eq!(s.chain.record(child.coin_id()), Some((child, made, None)));
    for (by_id, spends) in asked_since(&s, before) {
        assert!(by_id == 1 && (2..=crate::chia_peer_lane::PEAK_SETTLE_ATTEMPTS).contains(&spends), "the spend asked again once B's peak landed: {by_id}, {spends}");
    }
    assert_eq!(live(&s).await, vec![s.a.addr], "node b, which hid the coin, is gone from the pool");
    assert!(let_go(&s, &s.b).await, "and let go: never passed as honest");
    assert!(!let_go(&s, &s.a).await && s.lane.stores(s.a.addr).await, "node a stays, noted good");
    assert!(s.chain.unanswered().is_empty());
}

/// Every spend fetched is compared between the nodes before any is made
/// more of: one parent's spend served by neither node and another's that
/// one node serves otherwise than the other (the old fork's) is a
/// disagreement, both public nodes let go, whichever of the two parents
/// comes first in the order the spends are asked in, and whichever node
/// serves the old fork's spend (node a, the first peer asked, or node b).
#[tokio::test]
async fn spends_one_node_serves_otherwise_are_a_disagreement_beside_one_neither_serves_whatever_the_order_of_their_parents() {
    for (unserved_first, old_on_a) in [(true, true), (true, false), (false, true), (false, false)] {
        let s = setup().await;
        let open = open_puzzle_hash();
        let mut parents = vec![s.chain.fund(open, 1000, None), s.chain.fund(open, 2000, None)];
        s.chain.farm().await;
        stale_rows_on_a(&s, bundle(passing(&parents, hint(1))), bundle(passing(&parents, hint(2)))).await;
        parents.sort_by_key(|p| p.coin_id());
        let (unserved, otherwise) = if unserved_first { (parents[0], parents[1]) } else { (parents[1], parents[0]) };
        for node in [&s.a, &s.b] {
            s.chain.serve_spend_on(node, unserved.coin_id(), None);
        }
        let old = if old_on_a { &s.a } else { &s.b };
        s.chain.serve_spend_on(old, otherwise.coin_id(), passing(&[otherwise], hint(1)).pop());
        let before = by_id_and_spends(&s);

        let case = format!("unserved first: {unserved_first}, the old spend on node {}", if old_on_a { "a" } else { "b" });
        let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
        assert!(why.contains("disagree"), "{case}: {why}");
        assert_eq!(asked_since(&s, before), [(1, 2); 2], "{case}");
        assert_eq!(s.lane.live_count().await, 0, "{case}: both public nodes are let go");
        for node in [&s.a, &s.b] {
            assert!(let_go(&s, node).await, "{case}");
        }
        assert!(s.chain.unanswered().is_empty());
    }
}

/// Node b hides the real hinted coins seventeen parents made: the first
/// sixteen spends are settled, which shows b hid their coins, so b is let
/// go; the seventeenth is not, so the read has no verdict; and node a,
/// which listed them, stays pooled. A peer cannot veto every read of a
/// hint by hiding more coins than one read settles without being let go.
#[tokio::test]
async fn a_node_hiding_the_real_hinted_coins_of_seventeen_parents_is_let_go_and_the_read_stays_unanswered() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parents: Vec<Coin> = (0..=MAX_DISPUTED_PARENTS as u64).map(|n| s.chain.fund(open, 1000 + n, None)).collect();
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&parents, hint(1))));
    s.chain.farm_blocks(2).await;
    remembered(&s).await;
    for parent in &parents {
        s.chain.hide_on(&s.b, passed(*parent).coin_id());
    }
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("17 spends, more than the 16") && why.contains("at fault"), "{why}");
    assert_eq!(asked_since(&s, before), [(1, MAX_DISPUTED_PARENTS); 2]);
    assert_eq!(live(&s).await, vec![s.a.addr], "node a stays pooled");
    assert!(let_go(&s, &s.b).await, "node b, which hid the coins, is let go");
    assert!(!let_go(&s, &s.a).await && s.lane.stores(s.a.addr).await);
    assert!(s.chain.unanswered().is_empty());
}

/// Each node at fault: node a hid a coin the chain made under the hint a
/// block below its page's peak, which b lists, and node b listed a coin
/// whose making neither node serves, which a left out. Every peer of the pair is at fault, which is a
/// disagreement: no verdict, and both public nodes are let go.
#[tokio::test]
async fn when_each_node_hid_or_listed_a_coin_against_the_chains_answers_the_listing_is_a_disagreement_and_both_are_let_go() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let (hidden, unshown) = (s.chain.fund(open, 1000, None), s.chain.fund(open, 2000, None));
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[hidden, unshown], hint(1))));
    s.chain.farm_blocks(2).await;
    s.chain.hide_on(&s.a, passed(hidden).coin_id());
    s.chain.hide_on(&s.a, passed(unshown).coin_id());
    for node in [&s.a, &s.b] {
        s.chain.serve_spend_on(node, unshown.coin_id(), None);
    }

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("disagree"), "{why}");
    assert_eq!(s.lane.live_count().await, 0);
    for node in [&s.a, &s.b] {
        assert!(let_go(&s, node).await);
    }
    assert!(s.chain.unanswered().is_empty());
}

/// A pin with stale rows of seventeen parents, its public peer without
/// them: nobody is at fault among the sixteen spends settled, so the read
/// has no verdict and the public peer's connection is dropped, unpunished;
/// the pin keeps its place (a pin dropped would be dialled again at once,
/// into the same pair).
#[tokio::test]
async fn a_pin_with_stale_rows_past_the_cap_keeps_its_place_and_only_the_public_peer_is_dropped() {
    let s = pinned().await;
    let open = open_puzzle_hash();
    let over: Vec<Coin> = (0..=MAX_DISPUTED_PARENTS as u64).map(|n| s.chain.fund(open, 1000 + n, None)).collect();
    s.chain.farm().await;
    stale_rows_on_a(&s, bundle(passing(&over, hint(1))), bundle(passing(&over, hint(2)))).await;
    remembered(&s).await;

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("17 spends, more than the 16") && why.contains("nobody at fault"), "{why}");
    assert_eq!(live(&s).await, vec![s.a.addr], "the pin keeps its place");
    assert!(!let_go(&s, &s.b).await && s.lane.stores(s.b.addr).await, "the public peer is dropped, not let go");
    assert!(s.chain.unanswered().is_empty());
}

/// An honest pin beside a public peer that hides a coin the chain made
/// under the hint, a block below its page's peak: the coin is kept, the
/// public peer let go, the pin kept.
#[tokio::test]
async fn an_honest_pin_keeps_its_place_and_the_public_peer_that_hid_a_coin_is_let_go() {
    let s = pinned().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[parent], hint(1))));
    let made = s.chain.farm().await;
    s.chain.farm().await;
    remembered(&s).await;
    s.chain.hide_on(&s.b, passed(parent).coin_id());

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(passed(parent), made)]);
    assert_eq!(live(&s).await, vec![s.a.addr], "the pin keeps its place");
    assert!(let_go(&s, &s.b).await, "the public peer that hid the coin is let go");
    assert!(s.chain.unanswered().is_empty());
}

/// A pin that hides a coin the chain made under the hint, a block below
/// its page's peak, is at fault as any peer would be, and the coin is kept;
/// but a pin is never let go, and the public peer, which listed the coin,
/// is not at fault: both stay.
#[tokio::test]
async fn a_pin_that_hid_a_coin_is_never_let_go_and_the_coin_is_kept() {
    let s = pinned().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[parent], hint(1))));
    let made = s.chain.farm().await;
    s.chain.farm().await;
    s.chain.hide_on(&s.a, passed(parent).coin_id());

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(passed(parent), made)]);
    assert_eq!(live(&s).await, { let mut both = vec![s.a.addr, s.b.addr]; both.sort(); both });
    assert!(!let_go(&s, &s.b).await && s.lane.stores(s.b.addr).await);
    assert!(s.chain.unanswered().is_empty());
}

/// A pin whose chain moved between the rounds keeps its connection: the
/// read has no verdict, and only the public peer, whose chain moved too, is
/// dropped, unpunished.
#[tokio::test]
async fn a_pin_whose_chain_moved_between_the_rounds_keeps_its_connection_and_the_public_peer_is_dropped_unpunished() {
    let s = pinned().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.reorg_before(ProtocolMessageTypes::RequestPuzzleSolution, 2, vec![]);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("moved off the listing's block"), "{why}");
    assert_eq!(live(&s).await, vec![s.a.addr], "the pin keeps its connection");
    assert!(!let_go(&s, &s.b).await && s.lane.stores(s.b.addr).await, "the public peer is dropped, not let go");
    assert!(s.chain.unanswered().is_empty());
}

/// Every node refusing the lookup by id, which no honest node does: no
/// verdict, the public peer's connection dropped, unpunished, and the
/// pin's never.
#[tokio::test]
async fn every_node_refusing_the_lookup_by_id_drops_the_public_peer_and_never_the_pin() {
    let s = pinned().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    for node in [&s.a, &s.b] {
        s.chain.refuse_lookups_on(node);
    }
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("every peer refused"), "{why}");
    assert_eq!(asked_since(&s, before), [(1, 0); 2], "no spend asked once the lookup told the verdict");
    assert_eq!(live(&s).await, vec![s.a.addr], "the pin keeps its connection");
    assert!(!let_go(&s, &s.b).await && s.lane.stores(s.b.addr).await, "the public peer is dropped, not let go");
    assert!(s.chain.unanswered().is_empty());
}

/// On a chain that stands still, showing the listing's chain costs one
/// header request of each node: the header at the listing's height, the
/// peak each lookup was dated by being the peak still.
#[tokio::test]
async fn showing_the_listings_chain_on_a_chain_that_stands_still_costs_one_header_request_of_each_node() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    let agreed = headers(&s);
    assert_eq!(s.money.coin_records_by_hint(hint(2), None, true, None).await.unwrap().records.len(), 1);
    assert_eq!(headers(&s), agreed, "a listing the nodes agree on asks no header");

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty());
    assert_eq!(headers(&s), [agreed[0] + 1, agreed[1] + 1], "one header of each node for the one-sided coin");
    assert_eq!(s.lane.live_count().await, 2);
    assert!(s.chain.unanswered().is_empty());
}

/// A node ahead of the listing's block whose lookup by id was dated by a
/// peak the chain then leaves, the listing's block surviving: the header
/// there alone does not show the lookup was answered from a chain that
/// holds it, so the node shows the lookup's peak too, which is gone, and
/// the read has no verdict. Node a, whose chain moved, is dropped, not let
/// go; node b, held at the listing's block, stays.
#[tokio::test]
async fn a_lookup_dated_by_a_peak_the_chain_then_leaves_leaves_the_read_unanswered_though_the_listings_block_survives() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.hold(&s.b);
    assert_eq!(s.chain.farm().await, peak + 1, "node a a block ahead");
    let listed_at = s.chain.header_hash(peak);
    s.chain.reorg_before(ProtocolMessageTypes::RequestPuzzleSolution, 1, vec![]);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("moved off the listing's block") && why.contains(&format!("height {}", peak + 1)), "{why}");
    assert!(!s.chain.reorg_staged());
    assert_eq!(s.chain.header_hash(peak), listed_at, "the listing's block survives");
    assert_eq!(live(&s).await, vec![s.b.addr], "node a, whose chain moved, is dropped; node b stays");
    assert!(!let_go(&s, &s.a).await && s.lane.stores(s.a.addr).await, "and not let go");
    s.chain.release(&s.b).await;
    assert!(s.chain.unanswered().is_empty());
}

/// The same node a block ahead, its peak swapped during the spend round for
/// another at the same height, the listing's block surviving: the peak its
/// lookup was dated by is gone, though the peak's height stands. The first
/// window, begun on the lookup's peak, asks only the header at the
/// listing's height, which a still has; read by its height alone, a's peak
/// would stand still across it, and the read would settle on a lookup
/// answered from a chain a has left. The peak's hash moved: a's spend and
/// headers are asked again, in a window begun on another peak than the
/// lookup's, so the lookup peak's header is asked too and shows a's chain
/// moved; the read has no verdict, a is dropped, not let go, and node b,
/// held at the listing's block, shows its chain in one window and stays.
#[tokio::test]
async fn a_lookups_peak_swapped_for_another_at_the_same_height_during_the_spend_round_leaves_the_read_unanswered() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.hold(&s.b);
    assert_eq!(s.chain.farm().await, peak + 1, "node a a block ahead");
    let (listed_at, looked_up_at) = (s.chain.header_hash(peak), s.chain.header_hash(peak + 1));
    s.chain.swap_before(ProtocolMessageTypes::RequestPuzzleSolution, 1);
    let (before, shown) = (by_id_and_spends(&s), headers(&s));

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("moved off the listing's block") && why.contains(&format!("header at height {} it stood on", peak + 1)), "{why}");
    assert!(!s.chain.reorg_staged(), "the swap came as a spend was asked for");
    assert_eq!(s.chain.peak(), peak + 1, "the peak's height kept");
    assert_ne!(s.chain.header_hash(peak + 1), looked_up_at, "under another hash");
    assert_eq!(s.chain.header_hash(peak), listed_at, "the listing's block survives");
    assert_eq!(asked_since(&s, before), [(1, 2), (1, 1)], "node a's spend asked again once its peak's hash moved; node b's in one window");
    let now = headers(&s);
    assert_eq!(
        [now[0] - shown[0], now[1] - shown[1]],
        [4, 1],
        "node a: the listing's header as its page is confirmed against b's, then in the first window, then the listing's and the lookup peak's \
         in the second; node b: the listing's"
    );
    assert_eq!(live(&s).await, vec![s.b.addr], "node a, whose chain moved, is dropped; node b stays");
    assert!(!let_go(&s, &s.a).await && s.lane.stores(s.a.addr).await, "and not let go");
    s.chain.release(&s.b).await;
    assert!(s.chain.unanswered().is_empty());
}

/// A 2.7.4 node files a block's hint rows only after it has committed the
/// block and moved its peak, and reads that peak after it has queried its
/// coins, so its finished page can lack the coins of the very block it is
/// dated by. Node b leaves out a coin of the block at its page's peak, a
/// child made under the hint or a coin at the hint's own puzzle hash: the
/// coin is kept, as the chain made it under the hint, but b is not held to
/// it, and nobody is let go.
#[tokio::test]
async fn a_coin_of_the_block_a_page_is_dated_by_left_out_of_it_is_kept_and_nobody_is_let_go() {
    for at_hint in [false, true] {
        let s = setup().await;
        let open = open_puzzle_hash();
        let parent = s.chain.fund(open, 1000, None);
        s.chain.farm().await;
        s.chain.include_next(bundle(passing(&[parent], hint(1))));
        let funded = s.chain.fund(hint(1), 700, None);
        let made = s.chain.farm().await;
        let left_out = if at_hint { funded } else { passed(parent) };
        s.chain.hide_on(&s.b, left_out.coin_id());

        let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
        let mut want = vec![(passed(parent), made), (funded, made)];
        want.sort_by_key(|(c, _)| c.coin_id());
        assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), want, "at the hint: {at_hint}");
        assert!(!listed.truncated && listed.judged_at == Some(made));
        assert_eq!(s.lane.live_count().await, 2, "at the hint: {at_hint}: nobody is let go");
        for node in [&s.a, &s.b] {
            assert!(!let_go(&s, node).await && s.lane.stores(node.addr).await, "at the hint: {at_hint}");
        }
        assert!(s.chain.unanswered().is_empty());
    }
}

/// A page cut short is dated by its node's announcement, which follows the
/// block's post-processing, while its coins are the coin store's: node b
/// has taken a block that spends a hinted coin and not announced it, so
/// the coin, its latest change in that block, has moved past b's cut,
/// while node a, held a block behind, lists it unspent where b's page
/// would hold it. The coin is kept, but b, whose own lookup gives it spent
/// above the height its page is dated by, is not held to it, and nobody is
/// let go.
#[tokio::test]
async fn a_cut_page_dated_by_an_announcement_behind_its_nodes_coins_is_not_held_to_a_coin_spent_in_the_block_it_has_not_announced() {
    let s = setup().await;
    let open = open_puzzle_hash();
    let parent = s.chain.fund(open, 1000, None);
    s.chain.farm().await;
    s.chain.include_next(bundle(passing(&[parent], hint(1))));
    let made = s.chain.farm().await;
    // A coin of the block above, which cuts node a's one-coin page after
    // the child.
    s.chain.fund(open, 500, Some(hint(1)));
    let peak = s.chain.farm().await;
    let child = passed(parent);
    s.chain.hold(&s.a);
    s.chain.quiet(&s.b);
    s.chain.include_next(pass_on(child));
    assert_eq!(s.chain.farm().await, peak + 1);
    assert_eq!(s.chain.record(child.coin_id()), Some((child, made, Some(peak + 1))), "b's chain spends it a block above its announcement");
    s.chain.set_page_limit(1);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index, r.spent)).collect::<Vec<_>>(), vec![(child, made, false)]);
    assert!(listed.truncated && listed.next_cursor.is_some() && listed.judged_at == Some(peak), "{listed:?}");
    assert_eq!(s.lane.live_count().await, 2, "nobody is let go");
    for node in [&s.a, &s.b] {
        assert!(!let_go(&s, node).await, "neither node is let go");
    }
    s.chain.release(&s.a).await;
    s.chain.speak(&s.b).await;
    assert!(s.chain.unanswered().is_empty());
}

/// The lookup by id asks for no more coins than one settling takes, those
/// of the first sixteen spends: the other node's page sets how many coins
/// are one-sided. Public node b lists forty coins under the hint that it
/// made up, each of another parent, and gives them by id, beside the
/// honest pin a, which answers two ids a lookup request. Asked for all
/// forty, the pin would have ids left unanswered after eight requests and
/// be dropped as silent on every read of the hint, while b answered at
/// once. Asked for the sixteen taken, the pin answers them in eight
/// requests and denies them, a disagreement: b is let go, and the pin keeps
/// its place.
#[tokio::test]
async fn a_node_listing_more_made_up_coins_than_a_lookup_takes_is_let_go_and_the_honest_pin_keeps_its_place() {
    let s = pinned().await;
    let open = open_puzzle_hash();
    let peak = s.chain.farm().await;
    let made_up: Vec<Coin> = (0..40u8).map(|n| Coin::new(hint(100 + n), open, 5000 + u64::from(n))).collect();
    s.chain.invent_on(&s.b, hint(1), &made_up, peak);
    s.chain.set_lookup_limit(2);
    assert!(made_up.len() > STATE_ROUNDS * 2 && MAX_DISPUTED_PARENTS <= STATE_ROUNDS * 2);
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("disagree"), "{why}");
    assert_eq!(asked_since(&s, before), [(MAX_DISPUTED_PARENTS / 2, 0); 2], "the sixteen coins taken, two a request");
    assert_eq!(live(&s).await, vec![s.a.addr], "the pin keeps its place");
    assert!(let_go(&s, &s.b).await, "node b, which made the coins up, is let go");
    assert!(s.chain.unanswered().is_empty());
}

/// The same for the coins of one spend: node b makes up one coin more than
/// one settling takes ([`MAX_DISPUTED_COINS`]), all of one parent, beside
/// the honest pin a, which answers an eighth of the coins taken a request.
/// The pin answers the coins taken in eight requests and denies them: b is
/// let go, and the pin keeps its place.
#[tokio::test]
async fn a_node_listing_more_made_up_coins_of_one_spend_than_one_settling_takes_is_let_go_and_the_honest_pin_keeps_its_place() {
    let s = pinned().await;
    let open = open_puzzle_hash();
    let peak = s.chain.farm().await;
    let made_up: Vec<Coin> = (0..=MAX_DISPUTED_COINS as u64).map(|n| Coin::new(hint(200), open, 5000 + n)).collect();
    s.chain.invent_on(&s.b, hint(1), &made_up, peak);
    s.chain.set_lookup_limit(MAX_DISPUTED_COINS / STATE_ROUNDS);
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("disagree"), "{why}");
    assert_eq!(asked_since(&s, before), [(STATE_ROUNDS, 0); 2], "the coins taken, an eighth a request");
    assert_eq!(live(&s).await, vec![s.a.addr], "the pin keeps its place");
    assert!(let_go(&s, &s.b).await, "node b, which made the coins up, is let go");
    assert!(s.chain.unanswered().is_empty());
}

/// A node that leaves ids of the lookup by id unanswered, after
/// [`STATE_ROUNDS`] requests or at the first request that answers none of
/// those left, here one that echoes none of the ids it is asked for and so
/// is asked once, is silent, as no honest node is for
/// the coins one settling takes: the read has no verdict, that node's
/// connection is dropped, a pin's too, as a silent peer's of any request
/// is, nobody is let go, and the other node stays.
#[tokio::test]
async fn a_node_echoing_none_of_the_ids_asked_by_id_is_silent_and_dropped_a_pin_too_and_nobody_is_let_go() {
    for pin in [false, true] {
        let s = if pin { pinned().await } else { setup().await };
        let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
        s.chain.farm().await;
        stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
        remembered(&s).await;
        let (silent, other) = if pin { (&s.a, &s.b) } else { (&s.b, &s.a) };
        s.chain.echo_no_lookup_ids_on(silent);
        let before = by_id_and_spends(&s);

        let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
        assert!(why.contains(&format!("{} answered for 0 of the 1 coins asked by id", silent.addr)), "pin: {pin}: {why}");
        assert_eq!(asked_since(&s, before), [(1, 0); 2], "pin: {pin}");
        assert_eq!(live(&s).await, vec![other.addr], "pin: {pin}: the silent node is dropped");
        for node in [&s.a, &s.b] {
            assert!(!let_go(&s, node).await, "pin: {pin}: nobody is let go");
        }
        if !pin {
            assert!(s.lane.stores(silent.addr).await, "the store keeps the public node dropped");
        }
        assert!(s.chain.unanswered().is_empty());
    }
}

/// A node that gives no answer the lane can read to a spend request (here
/// one that answers it with a message of another kind, which the lane
/// takes as it takes a request left unanswered) is silent, as no honest
/// node is: its window ends there, with no header asked, and the read has
/// no verdict. Were its silence taken for a spend it does not serve, the
/// node that served the spend would read as disagreeing with it, or the
/// listers as listing a coin nobody made, and honest nodes would be let
/// go. Its connection is dropped, a pin's too, as a silent peer's of any
/// request is; nobody is let go; and the other node, its spend served and
/// its chain shown in one window, stays.
#[tokio::test]
async fn a_node_giving_no_answer_to_a_spend_request_is_silent_and_dropped_a_pin_too_and_nobody_is_let_go() {
    for pin in [false, true] {
        let s = if pin { pinned().await } else { setup().await };
        let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
        s.chain.farm().await;
        stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
        remembered(&s).await;
        let (silent, other) = if pin { (&s.a, &s.b) } else { (&s.b, &s.a) };
        s.chain.answer_spends_amiss_on(silent);
        let (before, shown) = (by_id_and_spends(&s), headers(&s));

        let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
        assert!(
            why.contains(&format!("1 of 2 peers did not show their chain, or the spends on it ({}: it gave no answer to the spends", silent.addr)),
            "pin: {pin}: {why}"
        );
        assert!(!why.contains("moved off"), "pin: {pin}: the other node's window stood: {why}");
        assert_eq!(asked_since(&s, before), [(1, 1); 2], "pin: {pin}: one lookup by id of each node, and its spend in one window");
        let (now, (i, j)) = (headers(&s), if pin { (0, 1) } else { (1, 0) });
        assert_eq!((now[i] - shown[i], now[j] - shown[j]), (0, 1), "pin: {pin}: no header asked of the silent node, the listing's of the other");
        assert_eq!(live(&s).await, vec![other.addr], "pin: {pin}: the silent node is dropped");
        for node in [&s.a, &s.b] {
            assert!(!let_go(&s, node).await, "pin: {pin}: nobody is let go");
        }
        if !pin {
            assert!(s.lane.stores(silent.addr).await, "the store keeps the public node dropped");
        }
        assert!(s.chain.unanswered().is_empty());
    }
}

/// A 2.7.4 node dates a finished page by its chain's peak, and announces
/// that peak to wallets only once the block is post-processed: node b's
/// page, and so the listing, is dated by a block b has not announced, and
/// its lookup by id, dated by its announcement, stands below the listing's
/// block. It is asked again once b announces a peak that high, which b
/// does not do within [`PEAK_GRACE`] here: b cannot show its view reached
/// the listing's block, so the read has no verdict, b's connection is
/// dropped, and nobody is let go; node a stays.
#[tokio::test]
async fn a_lookup_a_node_dates_below_the_listing_by_an_announcement_that_does_not_catch_up_drops_it_unpunished() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.quiet(&s.b);
    assert_eq!(s.chain.farm().await, peak + 1);
    let before = by_id_and_spends(&s);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    assert!(why.contains("moved off the listing's block") && why.contains(&format!("is dated at height {peak}, below it")), "{why}");
    assert_eq!(asked_since(&s, before), [(1, 0); 2], "no lookup asked again with no announcement, and no spend");
    assert_eq!(live(&s).await, vec![s.a.addr], "node b is dropped");
    assert!(!let_go(&s, &s.b).await && s.lane.stores(s.b.addr).await, "and not let go");
    s.chain.speak(&s.b).await;
    assert!(s.chain.unanswered().is_empty());
}

/// The same lag, node b's announcement of the listing's block coming a
/// moment after it answers its lookup by id, within [`PEAK_GRACE`]: the
/// lookup is asked again once it comes, dated at the listing's block, and
/// the read settles, the row stale and nobody dropped.
#[tokio::test]
async fn a_lookup_dated_below_the_listing_by_a_late_announcement_is_asked_again_once_it_comes_and_the_read_settles() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    s.chain.quiet(&s.b);
    s.chain.speak_after(&s.b, ProtocolMessageTypes::RequestCoinState, PEAK_GRACE / 4);
    assert_eq!(s.chain.farm().await, peak + 1);
    let before = by_id_and_spends(&s);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated && listed.judged_at == Some(peak + 1), "{listed:?}");
    assert!(!s.chain.is_quiet(&s.b));
    assert_eq!(asked_since(&s, before), [(1, 1), (2, 1)], "node b's lookup asked again once it announced the listing's block");
    assert_eq!(s.lane.live_count().await, 2);
    assert!(s.chain.unanswered().is_empty());
}

/// A node whose announced peak moves during every check of its chain (the
/// chain takes a block before each header it serves) cannot show where it
/// stands within [`PEAK_SETTLE_ATTEMPTS`] brackets: it is silent, its
/// connection dropped, a pin's too, as a silent peer's of any request is;
/// the read has no verdict and nobody is let go; node b, held where the
/// listing was taken, shows its chain and stays.
///
/// [`PEAK_SETTLE_ATTEMPTS`]: crate::chia_peer_lane::PEAK_SETTLE_ATTEMPTS
#[tokio::test]
async fn a_pin_whose_peak_moves_during_every_check_of_its_chain_is_silent_and_dropped_and_nobody_is_let_go() {
    let s = pinned().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.hold(&s.b);
    s.chain.restless(&s.a);

    let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
    let attempts = crate::chia_peer_lane::PEAK_SETTLE_ATTEMPTS;
    assert!(why.contains("did not show their chain") && why.contains(&format!("moved during each of {attempts} checks")), "{why}");
    assert!(s.chain.peak() > peak, "the chain moved during the checks");
    assert_eq!(live(&s).await, vec![s.b.addr], "the pin, silent, is dropped; node b stays");
    assert!(!let_go(&s, &s.b).await && s.lane.stores(s.b.addr).await);
    s.chain.release(&s.b).await;
    assert!(s.chain.unanswered().is_empty());
}

/// One block announced during the spend round, the listing's block kept:
/// its announcement lands inside the window of each node's spends and
/// headers, so neither window stands, and each node is asked for its spends
/// and its headers again, in a window its peak stands still across. The
/// read settles, the row stale, nobody dropped: one lookup by id of each
/// node, its spend asked twice, and three headers, the listing's in the
/// first window, and in the second the listing's and the lookup's peak's,
/// the peak it now announces being another.
#[tokio::test]
async fn a_block_announced_during_the_spend_round_has_each_node_asked_for_its_spends_again_and_the_read_settles() {
    let s = setup().await;
    let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
    s.chain.farm().await;
    let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
    remembered(&s).await;
    s.chain.block_before(ProtocolMessageTypes::RequestPuzzleSolution);
    let (before, shown) = (by_id_and_spends(&s), headers(&s));

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert!(listed.records.is_empty() && !listed.truncated && listed.judged_at == Some(peak), "the row is stale: {listed:?}");
    assert!(!s.chain.reorg_staged(), "the block came as a spend was asked for");
    assert_eq!(s.chain.peak(), peak + 1);
    assert_eq!(asked_since(&s, before), [(1, 2); 2], "each node's spend asked in two windows: the one the block came in, and the next");
    let now = headers(&s);
    assert_eq!([now[0] - shown[0], now[1] - shown[1]], [3, 3], "one header of each node in the first window, two in the second");
    assert_eq!(s.lane.live_count().await, 2, "nobody is dropped");
    for node in [&s.a, &s.b] {
        assert!(!let_go(&s, node).await && s.lane.stores(node.addr).await);
    }
    assert!(s.chain.unanswered().is_empty());
}

/// A node whose announced peak moves during every window of its spends and
/// its chain (the chain takes a block before each spend it serves, which it
/// announces ahead of the spend) cannot show the spends came from the chain
/// its headers show within [`PEAK_SETTLE_ATTEMPTS`] windows: it is silent,
/// its connection dropped, a pin's too, as a silent peer's of any request
/// is; the read has no verdict and nobody is let go; node b, held where the
/// listing was taken, serves its spend and shows its chain in one window,
/// and stays.
///
/// [`PEAK_SETTLE_ATTEMPTS`]: crate::chia_peer_lane::PEAK_SETTLE_ATTEMPTS
#[tokio::test]
async fn a_node_whose_peak_moves_during_every_window_of_its_spends_and_its_chain_is_silent_and_dropped_a_pin_too_and_nobody_is_let_go() {
    let attempts = crate::chia_peer_lane::PEAK_SETTLE_ATTEMPTS;
    for pin in [false, true] {
        let s = if pin { pinned().await } else { setup().await };
        let parent = s.chain.fund(open_puzzle_hash(), 1000, None);
        s.chain.farm().await;
        let peak = stale_rows_on_a(&s, bundle(passing(&[parent], hint(1))), bundle(passing(&[parent], hint(2)))).await;
        remembered(&s).await;
        s.chain.hold(&s.b);
        s.chain.restless_before(&s.a, ProtocolMessageTypes::RequestPuzzleSolution);
        let before = by_id_and_spends(&s);

        let why = unanswered(s.money.coin_records_by_hint(hint(1), None, true, None).await);
        assert!(
            why.contains("did not show their chain") && why.contains(&format!("moved during each of {attempts} checks of its spends and its chain")),
            "pin: {pin}: {why}"
        );
        assert_eq!(s.chain.peak(), peak + attempts as u32, "pin: {pin}: a block before each spend node a served");
        assert_eq!(asked_since(&s, before), [(1, attempts), (1, 1)], "pin: {pin}: node a's spend asked once a window, node b's in one");
        assert_eq!(live(&s).await, vec![s.b.addr], "pin: {pin}: node a, silent, is dropped; node b stays");
        for node in [&s.a, &s.b] {
            assert!(!let_go(&s, node).await, "pin: {pin}: nobody is let go");
        }
        if !pin {
            assert!(s.lane.stores(s.a.addr).await, "the store keeps the public node dropped");
        }
        s.chain.release(&s.b).await;
        assert!(s.chain.unanswered().is_empty());
    }
}

/// A coin at the hint's own puzzle hash, which a listing lists with no
/// spend, left out by node b a block below its page's peak, and nothing
/// else: the coin is kept on its record alone, no spend asked for; b, which
/// hid it, is let go and not stored; node a is noted good by this read.
#[tokio::test]
async fn a_node_hiding_only_a_coin_at_the_hints_own_puzzle_hash_is_let_go_and_the_coin_is_kept() {
    let s = setup().await;
    let at_hint = s.chain.fund(hint(1), 700, None);
    let made = s.chain.farm().await;
    let peak = s.chain.farm().await;
    s.chain.hide_on(&s.b, at_hint.coin_id());
    for node in [&s.a, &s.b] {
        assert!(!s.lane.stores(node.addr).await, "the store holds neither node yet");
    }
    let before = by_id_and_spends(&s);

    let listed = s.money.coin_records_by_hint(hint(1), None, true, None).await.unwrap();
    assert_eq!(listed.records.iter().map(|r| (r.coin, r.confirmed_block_index)).collect::<Vec<_>>(), vec![(at_hint, made)]);
    assert!(!listed.truncated && listed.judged_at == Some(peak));
    assert_eq!(asked_since(&s, before), [(1, 0); 2], "one lookup by id of each node, and no spend for a coin at the hint");
    assert_eq!(live(&s).await, vec![s.a.addr], "node b, which hid it, is gone from the pool");
    assert!(let_go(&s, &s.b).await, "and let go, never noted good");
    assert!(!let_go(&s, &s.a).await && s.lane.stores(s.a.addr).await, "node a is noted good");
    assert!(s.chain.unanswered().is_empty());
}
