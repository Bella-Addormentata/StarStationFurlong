//! The peer lane: the node's chain access over Chia full-node peers
//! (#231 D1; sovereign plan §6, §14 "chain access posture" conditions (1)–(6)).
//! S‑0 step 2: every chain read and push now goes here; the HTTPS gateway is
//! gone (step 3, same change — Dorkmo 2026‑10‑12: removed outright, no
//! fallback). One connection is [`crate::chia_peer::PeerConn`]; this module
//! chooses WHICH peers answer and what their answers are worth.
//!
//! Two trust levels, chosen per call site (§14 (5)):
//!   - [`Trust::Carrier`]: the first reachable peer. For the presence lane
//!     (the resolver and the watcher): its records are signed and sealed, so
//!     the chain is only their carrier and a lying peer can at most withhold.
//!   - [`Trust::Agreed`]: two peers must answer alike, or the verdict is
//!     NON‑FINAL (surfaced as [`ChainError::Unanswered`], which every money
//!     path already treats as "no answer, keep what you hold"). The publisher's
//!     wallet, the faucet and the craps fairness lane take this. Chia's own
//!     labels for it: a single peer is a trusted‑node claim, two agreeing
//!     peers a trusted‑set claim; nothing about what the chain CONTAINS is
//!     trustless here (§14 (3)).
//!
//! The peer set (§14 (1), (2)):
//!   - PINS, `SSF_CHIA_PEERS=host[:port],…`: the player's own full node, or one
//!     they trust. A pin is always consulted and counts toward the two; by
//!     default it must agree with one public peer from another network group
//!     (so at most three pin addresses connect, one place kept for that peer);
//!     `SSF_CHIA_PIN_ONLY=1` makes the pin's verdict final alone (and dials no
//!     public peer at all). An unreachable pin is a non‑final verdict on money
//!     paths, never a silent fall‑back to public peers; the presence lane may
//!     still read from public peers meanwhile. A pin that is down is dialled
//!     again after [`PIN_RETRY_AFTER`] whether or not another pin is up: the
//!     missing one may be the pin whose network group the pair needs. Two
//!     pins naming one node (a host and its address, say) are one pin, and a
//!     connection reached through public discovery to an address a pin
//!     resolves to counts as the pin from then on.
//!   - PUBLIC peers come from three sources: the DNS introducer (fresh this
//!     run; asked only when the stored and gossiped candidates fall short:
//!     nothing queued that the next dial could try (a queue the full pool
//!     holds no pair for counts as nothing), or a money request without a
//!     pin that has no fresh peer yet; at most every [`INTRODUCE_EVERY`],
//!     sooner only after a
//!     lookup that named nobody; a stored or gossiped peer it names this run
//!     counts as fresh from then on, up to the per-source cap below, so the
//!     pool keeps a second source), `RequestPeers` gossip from a connected
//!     peer (asked once; again after [`GOSSIP_RETRY`] if the request failed),
//!     and the store of known‑good peers kept in `chia_peers.json`
//!     across runs. Two agreeing
//!     peers must come from DISTINCT sources and distinct network groups
//!     (IPv4 /16, IPv6 /32; an IPv4‑mapped IPv6 address is its IPv4 address),
//!     and one of them must be fresh (a pin or the introducer), so a poisoned
//!     store cannot make an eclipse stick. Their listings are judged over
//!     the changes both have reached ([`settle_pages`]: taken as of the lower
//!     peak, cut to the changes between the request's start and the lower
//!     page boundary), so a peer a block ahead, or one that cut a page at its
//!     item limit, does not read as a disagreement; a coin only the peer
//!     ahead has seen, or one a peer has not got to yet (a page the peer
//!     ahead cut short, a capped coin-state lookup), is unknown rather than
//!     absent and leaves the lookup incomplete; a cursor goes out only once
//!     every peer has shown the header it names; and a page is dated by a
//!     peak that stood still across the request, header and height alike.
//!     One source holds at most
//!     [`PER_SOURCE_CAP`] of the [`MAX_CONNS`] connections, and a full pool
//!     that cannot form a pair lets a connection go (a redundant one first,
//!     never a pin) for a candidate whose source AND network group would
//!     complete one; a pool with room whose only dialable candidates are
//!     introducer peers kept out by that cap (three connected introducer
//!     peers that know nobody) lets one of them go, one already asked for
//!     gossip, so a waiting one can bring its own, and it rejoins the queue
//!     after [`RETRY_AFTER`]. A stored peer that disagrees with a verdict,
//!     or with a pin, is evicted; so is a public peer whose announced peak
//!     lags, by more
//!     than [`MAX_PEAK_LAG`] blocks, a height at least two other peers reach
//!     (one peer's announcement, inflated or not, evicts nobody), and the two
//!     peers of an agreed pair must be within that lag of each other. A peer that stops
//!     answering, or whose connection drops, returns to the queue and is
//!     dialled again after [`RECONNECT_AFTER`]; pins keep their own retry. An
//!     address that fails [`MAX_DIAL_FAILURES`] dials in a row is given up,
//!     and a full queue drops such an address for a newcomer, so dead
//!     addresses cannot shut fresh ones out.
//!   - Every connection passes the header‑0 genesis binding before it counts
//!     (`chia_peer.rs`, §14 (4)); a peak announced more than
//!     [`crate::chia_peer::PEAK_STALE`] ago is checked against the chain
//!     before it is reported.
//!
//! The mempool delta (§14 (6)): the wallet protocol has no mempool query, so
//! `spend_live` hands the parked spend bundle to the peers AGAIN and reads
//! their `TransactionAck`: accepted or pending means the spend is live (and in
//! the mempool once more if it had been dropped); refused by every peer means
//! it is dead and its coins come free ONLY when a refusal is final — the
//! bundle itself can never land ([`refusal_is_final`]) — since a refusal for
//! fee or load says nothing about a copy an earlier peer may still hold.
//! `push_tx` reads the same acks, once.
//!
//! What this lane does NOT do yet, by plan: weight‑proof light sync (header
//! trust stays trusted‑set), inclusion proofs (PR D), coin‑state subscriptions
//! in place of polling, and the per‑claim trust labels on the local API
//! (PR D). The two‑machine drill (#231 P4) is the first run against testnet11.

use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::anyhow;
use chia_protocol::{
    Bytes32, CoinState, CoinStateFilters, RejectCoinState, RejectHeaderRequest, RejectPuzzleSolution, RejectPuzzleState,
    RejectStateReason, RequestBlockHeader, RequestCoinState, RequestPeers, RequestPuzzleSolution, RequestPuzzleState,
    RespondBlockHeader, RespondCoinState, RespondPeers, RespondPuzzleSolution, RespondPuzzleState, SendTransaction,
    SpendBundle, TransactionAck,
};
use futures_util::future::join_all;
use rand::seq::SliceRandom;

use crate::chia_chain::{ChainAccess, ChainError, CoinListing, CoinRecord, PuzzleAndSolution};
use crate::chia_peer::{canonical, group_of, Group, Network, Peak, PeerConn, Source, CONNECT_TIMEOUT, PEAK_STALE, PEAK_WAIT};

/// Known-good public peers, kept across runs (beside the node's other files).
pub const STORE_FILE: &str = "chia_peers.json";
/// How many the store keeps (freshest success first).
pub const STORE_CAP: usize = 64;
/// Live connections the lane holds at most.
pub const MAX_CONNS: usize = 4;
/// Addresses queued to try, at most.
pub const CANDIDATE_CAP: usize = 256;
/// Candidates dialled at once.
pub const PARALLEL_DIALS: usize = 4;
/// Rounds of dialling one request may spend before it gives up (the peers the
/// last round reaches are still judged).
pub const MAX_ROUNDS: usize = 4;
/// How long a public address that failed or disagreed is left alone.
pub const RETRY_AFTER: Duration = Duration::from_secs(600);
/// How long a pin that failed is left alone (its owner may be restarting it).
pub const PIN_RETRY_AFTER: Duration = Duration::from_secs(60);
/// How long a public peer that stopped answering, or whose connection dropped,
/// waits in the queue before it is dialled again (a brief outage, not a fault).
pub const RECONNECT_AFTER: Duration = Duration::from_secs(30);
/// Failed dials in a row after which a public address is given up rather than
/// queued again (a pin is resolved and retried on its own schedule).
pub const MAX_DIAL_FAILURES: u8 = 3;
/// How often the introducer is asked again while peers are wanted.
pub const INTRODUCE_EVERY: Duration = Duration::from_secs(1800);
/// How soon it is asked again after a lookup that named nobody (DNS down, the
/// machine offline): a first run has nothing else to try.
pub const INTRODUCE_RETRY: Duration = Duration::from_secs(60);
/// How long a connection whose gossip request failed waits before it is asked
/// again (a request that failed says nothing about the peer's address book).
pub const GOSSIP_RETRY: Duration = Duration::from_secs(60);
/// Connections one public source may hold at once: one slot always stays for
/// another source, so four introducer peers cannot fill the pool and shut
/// gossip and the store out of the agreed pair (§14 (2)).
pub const PER_SOURCE_CAP: usize = MAX_CONNS - 1;
/// Addresses taken from one introducer answer or one gossip answer.
pub const ADDRS_PER_ANSWER: usize = 32;
/// Requests one coin-state lookup may spend when a peer answers for fewer ids
/// than it was asked (Chia caps a request at its response-item limit and
/// echoes the ids it took).
pub const STATE_ROUNDS: usize = 8;
/// Requests tried for a page or lookup that is dated by the peer's announced
/// peak, which must stand still across the request (an announcement landing
/// between the answer and its reading would date older states a block too
/// late), before the peer is reported unanswered.
pub const PEAK_SETTLE_ATTEMPTS: usize = 3;
/// A peer this many blocks or more behind another is lagging: its verdict is
/// non-final rather than agreed at the common height.
pub const MAX_PEAK_LAG: u32 = 6;

/// What a call site needs of a verdict (see the module notes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Trust {
    /// The first reachable peer: the presence lane.
    Carrier,
    /// Two agreeing peers (or the pin, in pin-only mode): money paths.
    Agreed,
}

/// A handle on the process's lane at one trust level. Cheap to clone; every
/// handle shares the connections.
#[derive(Clone)]
pub struct PeerLane {
    lane: Arc<Lane>,
    trust: Trust,
}

impl PeerLane {
    pub fn new(lane: Arc<Lane>, trust: Trust) -> Self {
        Self { lane, trust }
    }

    #[cfg(test)]
    pub fn trust(&self) -> Trust {
        self.trust
    }
}

/// The connections, the addresses still to try, and the store.
pub struct Lane {
    net: Network,
    pins: Vec<String>,
    pin_only: bool,
    store_path: Option<PathBuf>,
    tls: tokio::sync::OnceCell<Arc<rustls::ClientConfig>>,
    state: tokio::sync::Mutex<LaneState>,
}

#[derive(Default)]
struct LaneState {
    conns: Vec<Arc<PeerConn>>,
    candidates: VecDeque<Candidate>,
    /// Addresses not to dial before the instant.
    cooling: HashMap<SocketAddr, Instant>,
    /// When the introducer may be asked again (`None`: now).
    introduce_after: Option<Instant>,
    /// When the pins may be dialled again after failing (`None`: now).
    pin_retry_after: Option<Instant>,
    /// What the last pin dial learnt: how many pin connections the pins can
    /// give (their resolved addresses, up to the pins' share of the pool).
    /// `None` before the first dial, or while a pin does not resolve: the pins
    /// count as short then.
    pin_target: Option<usize>,
    /// Connections asked for gossip: `None`, it answered (not asked again);
    /// `Some(at)`, the request failed (asked again after `at`).
    gossiped: HashMap<SocketAddr, Option<Instant>>,
    store_loaded: bool,
    known: Vec<StoredPeer>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Candidate {
    addr: SocketAddr,
    source: Source,
    /// Dials that failed in a row; [`MAX_DIAL_FAILURES`] gives the address up.
    failures: u8,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq, Eq)]
struct StoredPeer {
    addr: String,
    last_ok: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Default)]
struct StoreFile {
    v: u32,
    peers: Vec<StoredPeer>,
}

/// `SSF_CHIA_PEERS=host[:port],…`: the operator's pinned full nodes.
pub fn pins_from_env() -> Vec<String> {
    std::env::var("SSF_CHIA_PEERS")
        .ok()
        .map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

/// `SSF_CHIA_PIN_ONLY=1`: the pins' verdict is final alone, and no public peer
/// is dialled.
pub fn pin_only_from_env() -> bool {
    std::env::var("SSF_CHIA_PIN_ONLY")
        .ok()
        .is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "on" | "yes"))
}

fn unanswered(why: String) -> ChainError {
    ChainError::Unanswered(anyhow!("{why}"))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Lane {
    /// The node's lane: pins and pin-only mode from the environment, the store
    /// beside the node's other files.
    pub fn from_env(net: Network) -> Self {
        Self::new(net, pins_from_env(), pin_only_from_env(), Some(PathBuf::from(STORE_FILE)))
    }

    pub fn new(net: Network, pins: Vec<String>, pin_only: bool, store_path: Option<PathBuf>) -> Self {
        let pin_only = pin_only && !pins.is_empty();
        Self { net, pins, pin_only, store_path, tls: tokio::sync::OnceCell::new(), state: tokio::sync::Mutex::new(LaneState::default()) }
    }

    /// Seed addresses to try, each with its source (tests).
    #[cfg(test)]
    pub fn with_candidates(self, seeds: Vec<(SocketAddr, Source)>) -> Self {
        {
            let mut state = self.state.try_lock().expect("fresh lane");
            for (addr, source) in seeds {
                state.candidates.push_back(Candidate { addr: canonical(addr), source, failures: 0 });
            }
        }
        self
    }

    /// Let the pins, the cooling addresses and the failed gossip requests be
    /// tried again at once (tests).
    #[cfg(test)]
    pub async fn expire_pin_cooldown(&self) {
        let mut state = self.state.lock().await;
        state.pin_retry_after = None;
        state.cooling.clear();
        state.gossiped.retain(|_, retry| retry.is_none());
    }

    /// Reuse a TLS configuration (tests share one certificate).
    #[cfg(test)]
    pub fn with_tls(self, tls: Arc<rustls::ClientConfig>) -> Self {
        let _ = self.tls.set(tls);
        self
    }

    /// One line for the startup log.
    pub fn describe(&self) -> String {
        if self.pins.is_empty() {
            format!(
                "{} full nodes via {} and peer gossip; money paths need two agreeing peers",
                self.net.id,
                self.net.introducers.join(", ")
            )
        } else if self.pin_only {
            format!(
                "{} pinned full node(s) {} ONLY (SSF_CHIA_PIN_ONLY): their verdict is final alone, labelled trusted-node",
                self.net.id,
                self.pins.join(", ")
            )
        } else {
            format!(
                "{} pinned full node(s) {} plus one public peer; money paths need the pin and a public peer to agree",
                self.net.id,
                self.pins.join(", ")
            )
        }
    }

    async fn tls(&self) -> Result<Arc<rustls::ClientConfig>, ChainError> {
        self.tls
            .get_or_try_init(|| async {
                tokio::task::spawn_blocking(crate::chia_peer::tls_client_config)
                    .await
                    .map_err(|e| anyhow!("tls setup task: {e}"))?
            })
            .await
            .cloned()
            .map_err(|e| ChainError::Unanswered(anyhow!("peer tls: {e:#}")))
    }

    /// Live connections right now (tests).
    #[cfg(test)]
    pub async fn live_count(&self) -> usize {
        let mut state = self.state.lock().await;
        self.reap(&mut state);
        state.conns.len()
    }

    /// The peers a `trust` verdict is taken from, dialling as needed.
    async fn peers_for(&self, trust: Trust) -> Result<Vec<Arc<PeerConn>>, ChainError> {
        let mut state = self.state.lock().await;
        self.reap(&mut state);
        let pinned = !self.pins.is_empty();
        let pin_up = |state: &LaneState| state.conns.iter().any(|c| c.source() == Source::Pin);
        // One pass more than there are dial rounds: the peers the LAST round
        // reached are judged like any other before the request gives up.
        for round in 0..=MAX_ROUNDS {
            // Pins are dialled BEFORE any public peer is accepted, and again
            // whenever their cooldown has passed while one is missing. A live
            // pin does not stand in for a down one: the missing pin may be the
            // one whose network group the pair needs, and the carrier would
            // otherwise ride a public fallback for as long as that lives.
            if pinned && self.pins_short(&state) && state.pin_retry_after.is_none_or(|at| Instant::now() >= at) {
                self.dial_pins(&mut state).await;
            }
            if trust == Trust::Agreed {
                self.let_laggards_go(&mut state);
            }
            if let Some(set) = self.choose(&state, trust) {
                if trust == Trust::Agreed {
                    self.pair_in_step(&mut state, &set)?;
                }
                return Ok(set);
            }
            if pinned && !pin_up(&state) && trust == Trust::Agreed {
                // §14 (1): a pin that does not answer makes money paths non-final;
                // it is never quietly replaced by public peers.
                return Err(unanswered(format!(
                    "the pinned full node(s) {} are unreachable; money paths stay non-final until one answers",
                    self.pins.join(", ")
                )));
            }
            if self.pin_only || round == MAX_ROUNDS {
                // Nothing public is ever dialled in pin-only mode; otherwise
                // the dial rounds are spent.
                break;
            }
            self.refill(&mut state, trust).await;
            // A refill can change the pool without a dial (a connected stored
            // peer the introducer named is fresh now), so the round is spent
            // only when there was nothing to dial AND nothing new to choose.
            if !self.dial(&mut state).await && self.choose(&state, trust).is_none() {
                break;
            }
        }
        Err(unanswered(match trust {
            Trust::Carrier => "no full-node peer reachable".to_string(),
            Trust::Agreed => format!(
                "fewer than two agreeing full-node peers reachable ({} connected; two are needed, from distinct sources and networks, one of them a pin or the introducer)",
                state.conns.len()
            ),
        }))
    }

    /// Before an agreed verdict, a public peer whose announced peak is more
    /// than [`MAX_PEAK_LAG`] blocks behind the pool's reference height is let
    /// go: its answers describe an older chain state, so a match between it
    /// and a current peer would not mean what an agreement should. The
    /// reference is the SECOND-highest announced height, one at least two
    /// peers reach, so a single announcement, inflated or not, evicts nobody;
    /// with two announcements nothing is let go here and a gap inside the
    /// chosen pair is judged by [`Self::pair_in_step`]. Pins stay; a lagging
    /// pin makes the verdict non-final there and in [`Lane::peak`].
    fn let_laggards_go(&self, state: &mut LaneState) {
        let mut heights: Vec<u32> = state.conns.iter().filter_map(|c| c.peak_now()).map(|p| p.height).collect();
        heights.sort_unstable_by(|a, b| b.cmp(a));
        let Some(&reference) = heights.get(1) else { return };
        let lagging: Vec<Arc<PeerConn>> = state
            .conns
            .iter()
            .filter(|c| c.source() != Source::Pin && c.peak_now().is_some_and(|p| p.height + MAX_PEAK_LAG < reference))
            .cloned()
            .collect();
        for peer in lagging {
            let behind = reference - peer.peak_now().map(|p| p.height).unwrap_or(0);
            self.let_go(state, &peer, RETRY_AFTER, &format!("lags {behind} blocks behind the height the other peers reach"));
        }
    }

    /// The two peers of an agreed pair must announce peaks within
    /// [`MAX_PEAK_LAG`] of each other, or the verdict is non-final: a lagging
    /// public peer is let go (back in the queue after [`RECONNECT_AFTER`]), a
    /// lagging pin stays, as in [`Lane::peak`].
    fn pair_in_step(&self, state: &mut LaneState, pair: &[Arc<PeerConn>]) -> Result<(), ChainError> {
        let mut known: Vec<(&Arc<PeerConn>, u32)> = pair.iter().filter_map(|c| c.peak_now().map(|p| (c, p.height))).collect();
        if known.len() < 2 {
            return Ok(());
        }
        known.sort_by_key(|(_, height)| *height);
        let (low, low_height) = known[0];
        let (high, high_height) = known[known.len() - 1];
        let lag = high_height - low_height;
        if lag <= MAX_PEAK_LAG {
            return Ok(());
        }
        let fate = if low.source() == Source::Pin {
            "non-final until the pinned node catches up"
        } else {
            self.let_go(state, low, RECONNECT_AFTER, &format!("lags {lag} blocks behind {}", high.addr()));
            "non-final, the lagging peer is let go"
        };
        Err(unanswered(format!(
            "{} lags {lag} blocks behind {} (height {low_height} against {high_height}); {fate}",
            low.addr(),
            high.addr()
        )))
    }

    /// Take a public connection out of the pool: logged with `why`, cooling
    /// for `after`, back in the queue for a later dial, closed off the lock.
    fn let_go(&self, state: &mut LaneState, peer: &Arc<PeerConn>, after: Duration, why: &str) {
        if !unpool(state, peer) {
            close_later(peer.clone());
            return;
        }
        eprintln!("⛓️ chain peers: {} ({}) let go: {why}", peer.addr(), peer.source().label());
        requeue(state, peer, after);
        close_later(peer.clone());
    }

    /// Connections that died on their own (the peer closed, the reader
    /// failed) leave the pool and return to the queue, to be dialled again
    /// after [`RECONNECT_AFTER`].
    fn reap(&self, state: &mut LaneState) {
        let now = Instant::now();
        state.cooling.retain(|_, until| now < *until);
        let (alive, dead): (Vec<Arc<PeerConn>>, Vec<Arc<PeerConn>>) = state.conns.drain(..).partition(|c| c.alive());
        state.conns = alive;
        for peer in dead {
            state.gossiped.remove(&peer.addr());
            requeue(state, &peer, RECONNECT_AFTER);
        }
    }

    fn choose(&self, state: &LaneState, trust: Trust) -> Option<Vec<Arc<PeerConn>>> {
        let conns = &state.conns;
        match trust {
            Trust::Carrier => {
                let pin = conns.iter().find(|c| c.source() == Source::Pin);
                pin.or_else(|| conns.first()).map(|c| vec![c.clone()])
            }
            Trust::Agreed => {
                let facts: Vec<(Source, Group)> = conns.iter().map(|c| (c.source(), c.group())).collect();
                let picked = pick_agreed(&facts, !self.pins.is_empty(), self.pin_only)?;
                Some(picked.into_iter().map(|i| conns[i].clone()).collect())
            }
        }
    }

    /// Are fewer pin connections live than the pins can give? So before the
    /// first dial, and while a pin does not resolve.
    fn pins_short(&self, state: &LaneState) -> bool {
        let up = state.conns.iter().filter(|c| c.source() == Source::Pin).count();
        state.pin_target.is_none_or(|target| up < target)
    }

    /// Resolve and dial every pin not connected, up to the pins' share of the
    /// pool. A pin outranks any public connection for a slot (the public
    /// connections that make room go back in the queue, so a pin dial that
    /// fails costs the lane no peer); a pin that fails
    /// is left alone for [`PIN_RETRY_AFTER`] (its owner may be restarting it)
    /// and tried again, whether or not another pin is up.
    async fn dial_pins(&self, state: &mut LaneState) {
        let now = Instant::now();
        // Outside pin-only mode one place is kept for the public peer the
        // agreement needs, however many addresses the pins resolve to.
        let pin_cap = if self.pin_only { MAX_CONNS } else { MAX_CONNS - 1 };
        let mut pins_up = state.conns.iter().filter(|c| c.source() == Source::Pin).count();
        let mut resolved: HashSet<SocketAddr> = HashSet::new();
        let mut unresolved = 0;
        let mut targets = Vec::new();
        for pin in &self.pins {
            let addrs = resolve_pin(pin, self.net.port).await;
            if addrs.is_empty() {
                unresolved += 1;
            }
            for addr in addrs {
                if !resolved.insert(addr) {
                    // Two pins naming one node (a host and its address, say).
                    continue;
                }
                if let Some(conn) = state.conns.iter().find(|c| c.addr() == addr) {
                    // Reached through public discovery while the pin did not
                    // resolve: the operator's node all the same, so it counts
                    // as the pin from here on, within the pins' share.
                    if pins_up < pin_cap && conn.promote(Source::Pin) {
                        pins_up += 1;
                        eprintln!("⛓️ chain peers: {addr} now counts as a pin: {pin} resolves to it");
                    }
                    continue;
                }
                if !state.cooling.get(&addr).is_some_and(|until| now < *until) {
                    targets.push(Candidate { addr, source: Source::Pin, failures: 0 });
                }
            }
        }
        // What the pins can give; a pin that did not resolve keeps them short.
        state.pin_target = (unresolved == 0).then_some(pin_cap.min(resolved.len()));
        if targets.is_empty() {
            state.pin_retry_after = self.pins_short(state).then(|| now + PIN_RETRY_AFTER);
            return;
        }
        // The cap is on LIVE pin connections, not on the addresses tried: a
        // batch that fails is followed by the next, so a reachable address
        // listed behind unreachable ones is still reached in this call.
        let mut targets: VecDeque<Candidate> = targets.into();
        loop {
            let pins_up = state.conns.iter().filter(|c| c.source() == Source::Pin).count();
            let want = pin_cap.saturating_sub(pins_up).min(targets.len());
            if want == 0 {
                break;
            }
            let batch: Vec<Candidate> = targets.drain(..want).collect();
            while state.conns.len() + batch.len() > MAX_CONNS {
                // The newest public connection makes room and goes back in
                // the queue, cooling briefly: a pin dial that then fails has
                // not cost the lane a peer the pair may still need.
                let Some(peer) = state.conns.iter().rev().find(|c| c.source() != Source::Pin).cloned() else { break };
                self.let_go(state, &peer, RECONNECT_AFTER, "making room for a pin");
            }
            self.dial_batch(state, batch, PIN_RETRY_AFTER).await;
        }
        // Still short (an address failed, or a pin did not resolve): the next
        // try waits for the cooldown, a live pin or not.
        state.pin_retry_after = self.pins_short(state).then(|| Instant::now() + PIN_RETRY_AFTER);
    }

    /// Top up the candidate queue: the store once; the introducer only when
    /// the quieter sources fall short (nothing stored or gossiped left to
    /// dial, or a money request without a pin that has no fresh peer yet,
    /// which the store and gossip can never supply) and it is due (its last
    /// answer used up and [`INTRODUCE_EVERY`] passed, or [`INTRODUCE_RETRY`]
    /// after an answer that named nobody); and gossip from every connection
    /// not yet asked. The interval holds across requests and dial rounds
    /// alike: while the introducer cools down, the queued, stored and
    /// gossiped candidates are what there is to try.
    async fn refill(&self, state: &mut LaneState, trust: Trust) {
        if !state.store_loaded {
            state.store_loaded = true;
            state.known = self.store_path.as_deref().map(load_store).unwrap_or_default();
            let stored: Vec<Candidate> = state
                .known
                .iter()
                .filter_map(|p| p.addr.parse::<SocketAddr>().ok())
                .map(|addr| Candidate { addr, source: Source::Store, failures: 0 })
                .collect();
            push_candidates(state, stored);
        }
        let now = Instant::now();
        // "Ready" is a queued candidate the next dial could actually try: not
        // cooling, not connected, and one the pool has a place for (under its
        // source's cap or by rotation; in a full pool, one whose swap would
        // complete a pair). A queue the full pool holds no pair for (every
        // peer and candidate in one network group, say) is no reason to leave
        // the introducer unasked once it is due.
        let connected: HashSet<SocketAddr> = state.conns.iter().map(|c| c.addr()).collect();
        let pooled: Vec<(Source, Group, bool)> = state.conns.iter().map(|c| (c.source(), c.group(), state.gossiped.contains_key(&c.addr()))).collect();
        let pinned = !self.pins.is_empty();
        let ready = state.candidates.iter().any(|c| {
            !connected.contains(&c.addr)
                && !state.cooling.get(&c.addr).is_some_and(|until| now < *until)
                && tryable(&pooled, (c.source, group_of(c.addr)), pinned, self.pin_only)
        });
        let need_fresh = trust == Trust::Agreed && self.pins.is_empty() && !state.conns.iter().any(|c| c.source().is_fresh());
        // No veto for introducer candidates still queued: those are cooling
        // after failed dials, and only the deadline and the need decide.
        let introduce = !self.net.introducers.is_empty() && state.introduce_after.is_none_or(|at| now >= at) && (need_fresh || !ready);
        if introduce {
            let mut found = Vec::new();
            for name in &self.net.introducers {
                match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host(format!("{name}:{}", self.net.port))).await {
                    Ok(Ok(addrs)) => found.extend(addrs),
                    Ok(Err(e)) => eprintln!("⛓️ chain peers: introducer {name}: {e}"),
                    Err(_) => eprintln!("⛓️ chain peers: introducer {name}: lookup timed out"),
                }
            }
            found.shuffle(&mut rand::thread_rng());
            found.truncate(ADDRS_PER_ANSWER);
            let n = found.len();
            state.introduce_after = Some(Instant::now() + if n == 0 { INTRODUCE_RETRY } else { INTRODUCE_EVERY });
            push_candidates(state, found.into_iter().map(|addr| Candidate { addr, source: Source::Introducer, failures: 0 }).collect());
            eprintln!("⛓️ chain peers: the introducer named {n} full nodes");
        }
        let unasked: Vec<Arc<PeerConn>> = state
            .conns
            .iter()
            .filter(|c| !state.gossiped.get(&c.addr()).is_some_and(|retry| retry.is_none() || retry.is_some_and(|at| now < at)))
            .cloned()
            .collect();
        for conn in unasked {
            state.gossiped.insert(conn.addr(), None);
            match conn.request::<RespondPeers, _>(RequestPeers::new()).await {
                Ok(answer) => {
                    let mut addrs: Vec<SocketAddr> = answer
                        .peer_list
                        .iter()
                        .filter_map(|p| p.host.parse::<IpAddr>().ok().map(|ip| SocketAddr::new(ip, p.port)))
                        .filter(|a| !a.ip().is_unspecified() && a.port() != 0)
                        .collect();
                    addrs.shuffle(&mut rand::thread_rng());
                    addrs.truncate(ADDRS_PER_ANSWER);
                    let n = addrs.len();
                    push_candidates(state, addrs.into_iter().map(|addr| Candidate { addr, source: Source::Gossip, failures: 0 }).collect());
                    eprintln!("⛓️ chain peers: {} gossiped {n} full nodes", conn.addr());
                }
                Err(e) => {
                    state.gossiped.insert(conn.addr(), Some(Instant::now() + GOSSIP_RETRY));
                    eprintln!("⛓️ chain peers: {} gossip: {e:#} (asked again in {} s)", conn.addr(), GOSSIP_RETRY.as_secs());
                }
            }
        }
    }

    /// Dial the next few candidates, sources not yet connected first (fresh
    /// ones ahead), no source past [`PER_SOURCE_CAP`]. A full pool that cannot
    /// form an agreed pair first lets one redundant public connection go when
    /// a candidate from a source it lacks is waiting; a pool with room that
    /// cannot form one, whose only dialable candidates are introducer peers
    /// the cap keeps out, lets one connected introducer peer go for the first
    /// of them ([`Self::rotation`]). `false` when there was nothing to dial.
    async fn dial(&self, state: &mut LaneState) -> bool {
        let connected: HashSet<SocketAddr> = state.conns.iter().map(|c| c.addr()).collect();
        let now = Instant::now();
        let mut ready: Vec<Candidate> = Vec::new();
        let mut later: VecDeque<Candidate> = VecDeque::new();
        for cand in state.candidates.drain(..) {
            if connected.contains(&cand.addr) {
                continue;
            }
            if state.cooling.get(&cand.addr).is_some_and(|until| now < *until) {
                later.push_back(cand);
            } else {
                ready.push(cand);
            }
        }
        let have: HashSet<Source> = state.conns.iter().map(|c| c.source()).collect();
        let groups: HashSet<Group> = state.conns.iter().map(|c| c.group()).collect();
        let mut first: Option<Candidate> = None;
        if state.conns.len() >= MAX_CONNS {
            // A full pool that cannot form a pair makes room for the first
            // candidate that would complete one, by source AND network group,
            // letting go a connection the pair can spare (a redundant one
            // first, never a pin); that candidate is dialled first.
            let facts: Vec<(Source, Group)> = state.conns.iter().map(|c| (c.source(), c.group())).collect();
            let pinned = !self.pins.is_empty();
            let swap = if self.choose(state, Trust::Agreed).is_none() {
                ready.iter().enumerate().find_map(|(ci, c)| {
                    replaceable(&facts, (c.source, group_of(c.addr)), pinned, self.pin_only).map(|i| (ci, i))
                })
            } else {
                None
            };
            match swap {
                Some((ci, i)) => {
                    let peer = state.conns.remove(i);
                    eprintln!(
                        "⛓️ chain peers: {} ({}) let go: making room for a peer that completes a pair",
                        peer.addr(),
                        peer.source().label()
                    );
                    state.gossiped.remove(&peer.addr());
                    close_later(peer);
                    first = Some(ready.remove(ci));
                }
                None => {
                    state.candidates = ready.into_iter().chain(later).collect();
                    return false;
                }
            }
        }
        ready.sort_by_key(|c| (have.contains(&c.source), groups.contains(&group_of(c.addr)), !c.source.is_fresh()));
        if first.is_none() {
            if let Some(i) = self.rotation(state, &ready) {
                let peer = state.conns[i].clone();
                self.let_go(state, &peer, RETRY_AFTER, "making room for a waiting introducer peer and its gossip");
                // Queued again by `let_go`, cooling: it waits with the others.
                later.extend(state.candidates.drain(..));
            }
        }
        if let Some(cand) = first {
            ready.insert(0, cand);
        }
        let mut per_source: HashMap<Source, usize> = HashMap::new();
        for c in &state.conns {
            *per_source.entry(c.source()).or_default() += 1;
        }
        let room = MAX_CONNS - state.conns.len();
        let mut batch: Vec<Candidate> = Vec::new();
        let mut rest: Vec<Candidate> = Vec::new();
        for cand in ready {
            let held = per_source.entry(cand.source).or_default();
            if batch.len() < PARALLEL_DIALS.min(room) && *held < PER_SOURCE_CAP {
                *held += 1;
                batch.push(cand);
            } else {
                rest.push(cand);
            }
        }
        state.candidates = rest.into_iter().chain(later).collect();
        if batch.is_empty() {
            return false;
        }
        self.dial_batch(state, batch, RETRY_AFTER).await;
        true
    }

    async fn dial_batch(&self, state: &mut LaneState, batch: Vec<Candidate>, cool_for: Duration) {
        let tls = match self.tls().await {
            Ok(tls) => tls,
            Err(e) => {
                eprintln!("⛓️ chain peers: {e}");
                return;
            }
        };
        let net = self.net.clone();
        let dials = batch.into_iter().map(|cand| {
            let tls = tls.clone();
            let net = net.clone();
            async move {
                let result = PeerConn::connect(cand.addr, cand.source, &net, tls).await;
                (cand, result)
            }
        });
        let now = Instant::now();
        for (cand, result) in join_all(dials).await {
            match result {
                Ok(conn) => {
                    if state.conns.iter().any(|c| c.addr() == cand.addr) {
                        // One connection per address, whoever dialled it twice.
                        close_later(conn);
                    } else if state.conns.len() < MAX_CONNS {
                        eprintln!("⛓️ chain peers: {} ({}) connected", cand.addr, cand.source.label());
                        state.conns.push(conn);
                    } else {
                        close_later(conn);
                    }
                }
                Err(e) => {
                    eprintln!("⛓️ chain peers: {} ({}): {e:#}", cand.addr, cand.source.label());
                    state.cooling.insert(cand.addr, now + cool_for);
                    self.forget(state, cand.addr);
                    if cand.source == Source::Pin {
                        // Pins are resolved and retried on their own schedule.
                        continue;
                    }
                    // Kept for a later try once the cooldown passes, until the
                    // address has failed often enough to be given up.
                    let failures = cand.failures + 1;
                    if failures < MAX_DIAL_FAILURES {
                        push_candidates(state, vec![Candidate { failures, ..cand }]);
                    } else {
                        eprintln!("⛓️ chain peers: {} ({}) given up after {failures} failed dials", cand.addr, cand.source.label());
                    }
                }
            }
        }
    }

    /// In a pool with room that cannot form an agreed pair, whose every
    /// dialable candidate waits only on [`PER_SOURCE_CAP`], the connection to
    /// let go so the first waiting introducer peer can be dialled and asked
    /// for gossip: three connected introducer peers that know nobody would
    /// otherwise hold their cap for good, and the second source a pair needs
    /// would never be found. Among that source's connections, each already
    /// asked for gossip and never a pin, one whose network group another
    /// connection shares first, then the newest; one per dial round. `None`
    /// when nothing waits, when the pool could already pair, or when the
    /// waiting candidates are stored or gossiped peers: those cannot bring
    /// the fresh peer such a pool lacks, only the introducer can.
    fn rotation(&self, state: &LaneState, ready: &[Candidate]) -> Option<usize> {
        let cand = ready.first()?;
        if state.conns.len() >= MAX_CONNS || !cand.source.is_fresh() || self.choose(state, Trust::Agreed).is_some() {
            return None;
        }
        let held = state.conns.iter().filter(|c| c.source() == cand.source).count();
        if held < PER_SOURCE_CAP || ready.iter().any(|c| c.source != cand.source) {
            return None;
        }
        let mut groups: HashMap<Group, usize> = HashMap::new();
        for c in &state.conns {
            *groups.entry(c.group()).or_default() += 1;
        }
        state
            .conns
            .iter()
            .enumerate()
            .filter(|(_, c)| c.source() == cand.source && c.source() != Source::Pin && state.gossiped.contains_key(&c.addr()))
            .max_by_key(|(_, c)| groups[&c.group()])
            .map(|(i, _)| i)
    }

    fn forget(&self, state: &mut LaneState, addr: SocketAddr) {
        let before = state.known.len();
        state.known.retain(|p| p.addr != addr.to_string());
        if state.known.len() != before {
            self.save_store(state);
        }
    }

    fn save_store(&self, state: &LaneState) {
        let Some(path) = self.store_path.as_deref() else { return };
        let file = StoreFile { v: 1, peers: state.known.clone() };
        if let Err(e) = write_store(path, &file) {
            eprintln!("⛓️ chain peers: could not save {}: {e}", path.display());
        }
    }

    /// Remember the public peers of an agreed verdict as known-good: only the
    /// connections still in the pool, so a verdict that overlapped an eviction
    /// (another request found the same peers disagreeing) restores nothing.
    async fn note_good(&self, peers: &[Arc<PeerConn>]) {
        let mut state = self.state.lock().await;
        let now = unix_now();
        let mut changed = false;
        let pooled: Vec<Arc<PeerConn>> = peers
            .iter()
            .filter(|p| p.source() != Source::Pin && state.conns.iter().any(|c| Arc::ptr_eq(c, p)))
            .cloned()
            .collect();
        for peer in &pooled {
            let addr = peer.addr().to_string();
            match state.known.iter_mut().find(|p| p.addr == addr) {
                Some(entry) => {
                    if now.saturating_sub(entry.last_ok) >= 60 {
                        entry.last_ok = now;
                        changed = true;
                    }
                }
                None => {
                    state.known.push(StoredPeer { addr, last_ok: now });
                    changed = true;
                }
            }
        }
        if changed {
            state.known.sort_by_key(|p| std::cmp::Reverse(p.last_ok));
            state.known.truncate(STORE_CAP);
            self.save_store(&state);
        }
    }

    /// Let the public peers of a failed verdict go: closed, forgotten by the
    /// store, not dialled again for a while. Pins stay (§14 (2): a stored peer
    /// that disagrees with a pin is the one evicted).
    async fn evict(&self, peers: &[Arc<PeerConn>], why: &str) {
        let mut state = self.state.lock().await;
        let until = Instant::now() + RETRY_AFTER;
        for peer in peers.iter().filter(|p| p.source() != Source::Pin) {
            if !unpool(&mut state, peer) {
                // Gone from the pool already: a verdict on that connection says
                // nothing about whoever holds its address now.
                close_later(peer.clone());
                continue;
            }
            eprintln!("⛓️ chain peers: {} ({}) let go: {why}", peer.addr(), peer.source().label());
            state.cooling.insert(peer.addr(), until);
            self.forget(&mut state, peer.addr());
            close_later(peer.clone());
        }
    }

    /// Drop one connection that stopped answering; it returns to the queue
    /// and is dialled again after [`RECONNECT_AFTER`] (a pin on its own
    /// schedule).
    async fn drop_conn(&self, peer: &Arc<PeerConn>) {
        let mut state = self.state.lock().await;
        if unpool(&mut state, peer) {
            requeue(&mut state, peer, RECONNECT_AFTER);
        }
        close_later(peer.clone());
    }

    /// The connections still alive; one found dead here (the carrier looking
    /// for a stand-in, say) returns to the queue like any dropped peer.
    async fn live_conns(&self) -> Vec<Arc<PeerConn>> {
        let mut state = self.state.lock().await;
        self.reap(&mut state);
        state.conns.clone()
    }

    /// Run `op` on the peers `trust` names and judge the answers: the carrier
    /// takes the first answer (one retry on another peer when the first is
    /// silent); the agreed verdict needs every peer to answer alike.
    async fn ask<T, F, Fut>(&self, what: &str, trust: Trust, op: F) -> Result<T, ChainError>
    where
        T: PartialEq + Send,
        F: Fn(Arc<PeerConn>) -> Fut + Send + Sync,
        Fut: Future<Output = Result<T, ChainError>> + Send,
    {
        self.ask_by(what, trust, op, |answers: Vec<(Arc<PeerConn>, T)>| {
            let mut values: Vec<T> = answers.into_iter().map(|(_, v)| v).collect();
            let alike = values.iter().all(|v| *v == values[0]);
            std::future::ready(Ok::<_, ChainError>(alike.then(|| values.swap_remove(0))))
        })
        .await
    }

    /// [`Self::ask`] with its own notion of agreement: `settle` turns the
    /// peers' answers (one per peer, every one of them Ok, each with the peer
    /// that gave it, so it may ask the peers one more thing) into the verdict,
    /// `None` when they do not agree, or an error when that could not be told.
    /// A carrier's one answer is settled alone.
    async fn ask_by<T, U, F, Fut, S, SFut>(&self, what: &str, trust: Trust, op: F, settle: S) -> Result<U, ChainError>
    where
        T: Send,
        U: Send,
        F: Fn(Arc<PeerConn>) -> Fut + Send + Sync,
        Fut: Future<Output = Result<T, ChainError>> + Send,
        S: Fn(Vec<(Arc<PeerConn>, T)>) -> SFut + Send + Sync,
        SFut: Future<Output = Result<Option<U>, ChainError>> + Send,
    {
        let peers = self.peers_for(trust).await?;
        match trust {
            Trust::Carrier => {
                let first = peers[0].clone();
                let answered = match op(first.clone()).await {
                    Ok(v) => (first, v),
                    Err(ChainError::Refused(why)) => return Err(ChainError::Refused(why)),
                    Err(ChainError::Unanswered(e)) => {
                        self.drop_conn(&first).await;
                        let next = self.live_conns().await.into_iter().find(|c| c.addr() != first.addr());
                        match next {
                            Some(next) => {
                                let v = op(next.clone()).await?;
                                (next, v)
                            }
                            None => return Err(ChainError::Unanswered(e)),
                        }
                    }
                };
                settle(vec![answered]).await?.ok_or_else(|| unanswered(format!("{what}: the peer's answer could not be settled")))
            }
            Trust::Agreed => {
                let answers = join_all(peers.iter().cloned().map(|p| op(p))).await;
                self.verdict(what, &peers, answers, settle).await
            }
        }
    }

    async fn verdict<T: Send, U: Send, SFut>(
        &self,
        what: &str,
        peers: &[Arc<PeerConn>],
        answers: Vec<Result<T, ChainError>>,
        settle: impl FnOnce(Vec<(Arc<PeerConn>, T)>) -> SFut + Send,
    ) -> Result<U, ChainError>
    where
        SFut: Future<Output = Result<Option<U>, ChainError>> + Send,
    {
        let mut oks: Vec<(Arc<PeerConn>, T)> = Vec::new();
        let mut refusals: Vec<String> = Vec::new();
        let mut silences: Vec<String> = Vec::new();
        let mut silent: Vec<Arc<PeerConn>> = Vec::new();
        for (peer, answer) in peers.iter().zip(answers) {
            match answer {
                Ok(v) => oks.push((peer.clone(), v)),
                Err(ChainError::Refused(why)) => refusals.push(format!("{}: {why}", peer.addr())),
                Err(ChainError::Unanswered(e)) => {
                    silences.push(format!("{}: {e:#}", peer.addr()));
                    silent.push(peer.clone());
                }
            }
        }
        if !silences.is_empty() {
            for peer in &silent {
                self.drop_conn(peer).await;
            }
            return Err(unanswered(format!("{what}: {} of {} peers unanswered ({})", silences.len(), peers.len(), silences.join("; "))));
        }
        if oks.len() == peers.len() {
            if let Some(settled) = settle(oks).await? {
                self.note_good(peers).await;
                return Ok(settled);
            }
            self.evict(peers, "disagreed on a verdict").await;
            return Err(unanswered(format!(
                "{what}: the {} peers disagree, so the verdict is non-final; the public peers among them are let go",
                peers.len()
            )));
        }
        if refusals.len() == peers.len() {
            return Err(ChainError::Refused(refusals.join("; ")));
        }
        self.evict(peers, "split verdict").await;
        Err(unanswered(format!("{what}: split verdict, non-final ({} refused: {})", refusals.len(), refusals.join("; "))))
    }

    /// The peak as `trust` sees it. Agreed: every peer's announced peak must
    /// name one chain — at the lowest height among them, the peers ahead must
    /// serve the same header hash; a peer further behind than
    /// [`MAX_PEAK_LAG`] blocks makes the verdict non-final.
    async fn peak(&self, trust: Trust) -> Result<u32, ChainError> {
        let peers = self.peers_for(trust).await?;
        let mut peaks: Vec<(Arc<PeerConn>, Peak)> = Vec::new();
        for peer in &peers {
            match peer.wait_peak(PEAK_WAIT).await {
                Some(peak) => {
                    if peer.peak_age().is_some_and(|age| age > PEAK_STALE) {
                        self.prove_current(peer, peak).await?;
                    }
                    peaks.push((peer.clone(), peak));
                }
                None => {
                    self.drop_conn(peer).await;
                    return Err(unanswered(format!("{} announced no peak within {}s", peer.addr(), PEAK_WAIT.as_secs())));
                }
            }
        }
        let (low_peer, low) = peaks.iter().min_by_key(|(_, p)| p.height).cloned().expect("at least one peer");
        for (peer, peak) in &peaks {
            if peak.height == low.height {
                if peak.header_hash != low.header_hash {
                    self.evict(&peers, "disagreed on the peak header").await;
                    return Err(unanswered(format!("peers disagree on the header at height {}; non-final", low.height)));
                }
                continue;
            }
            let lag = peak.height - low.height;
            if lag > MAX_PEAK_LAG {
                // A pin is never let go: the operator's own node is syncing or
                // the public peer is ahead of the truth; either way, non-final
                // until the two agree. Anyone else lagging this far is dropped.
                let fate = if low_peer.source() == Source::Pin {
                    "non-final until the pinned node catches up"
                } else {
                    self.drop_conn(&low_peer).await;
                    "non-final, the lagging peer is let go"
                };
                return Err(unanswered(format!(
                    "{} lags {lag} blocks behind {} (height {} against {}); {fate}",
                    low_peer.addr(),
                    peer.addr(),
                    low.height,
                    peak.height
                )));
            }
            let header = peer
                .request_fallible::<RespondBlockHeader, RejectHeaderRequest, _>(RequestBlockHeader::new(low.height))
                .await;
            match header {
                Err(e) => {
                    self.drop_conn(peer).await;
                    return Err(unanswered(format!("{}: header at {}: {e:#}", peer.addr(), low.height)));
                }
                Ok(Err(_)) => return Err(unanswered(format!("{} would not serve the header at {}", peer.addr(), low.height))),
                Ok(Ok(answer)) => {
                    if answer.header_block.header_hash() != low.header_hash {
                        self.evict(&peers, "disagreed on the peak header").await;
                        return Err(unanswered(format!(
                            "peers disagree on the header at height {} ({} against {}); non-final",
                            low.height,
                            peer.addr(),
                            low_peer.addr()
                        )));
                    }
                }
            }
        }
        if peers.len() > 1 {
            self.note_good(&peers).await;
        }
        Ok(low.height)
    }

    /// A peak announced more than [`PEAK_STALE`] ago is checked before it
    /// counts: the peer is asked for the header one block above it. No such
    /// block means the chain really has not moved (a quiet stretch), and the
    /// announcement is fresh again; a header, or no answer, means the
    /// connection stopped relaying peaks (stalled, or half-open), so it is let
    /// go and the request is non-final until a live peer answers.
    async fn prove_current(&self, peer: &Arc<PeerConn>, peak: Peak) -> Result<(), ChainError> {
        let above = peer
            .request_fallible::<RespondBlockHeader, RejectHeaderRequest, _>(RequestBlockHeader::new(peak.height + 1))
            .await;
        match above {
            Ok(Err(_)) => {
                peer.touch_peak();
                Ok(())
            }
            Ok(Ok(_)) => {
                self.drop_conn(peer).await;
                Err(unanswered(format!(
                    "{}'s peak announcement (height {}) is stale: the chain has moved past it; the connection is let go",
                    peer.addr(),
                    peak.height
                )))
            }
            Err(e) => {
                self.drop_conn(peer).await;
                Err(unanswered(format!("{}: stale peak and no answer to a header request ({e:#}); the connection is let go", peer.addr())))
            }
        }
    }

    /// Hand `bundle` to the money peers and collect their acks.
    async fn acks(&self, bundle: SpendBundle) -> Result<Vec<AckOutcome>, ChainError> {
        let peers = self.peers_for(Trust::Agreed).await?;
        let sends = peers.iter().cloned().map(|peer| {
            let bundle = bundle.clone();
            async move {
                let ack = peer.request::<TransactionAck, _>(SendTransaction::new(bundle)).await;
                (peer, ack)
            }
        });
        let mut outcomes = Vec::new();
        for (peer, ack) in join_all(sends).await {
            match ack {
                Ok(ack) => outcomes.push(AckOutcome::from_ack(peer.addr(), &ack)),
                Err(e) => {
                    self.drop_conn(&peer).await;
                    outcomes.push(AckOutcome::Silent(format!("{}: {e:#}", peer.addr())));
                }
            }
        }
        Ok(outcomes)
    }
}

/// What one peer said to a spend bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AckOutcome {
    /// `SUCCESS` (in the mempool) or `PENDING` (queued until its inputs confirm).
    Accepted,
    /// `FAILED`, with the full node's reason.
    Failed(String),
    /// No ack.
    Silent(String),
}

impl AckOutcome {
    fn from_ack(addr: SocketAddr, ack: &TransactionAck) -> Self {
        match ack.status {
            1 | 2 => AckOutcome::Accepted,
            status => AckOutcome::Failed(format!(
                "{addr}: {}",
                ack.error.clone().unwrap_or_else(|| format!("status {status}"))
            )),
        }
    }
}

/// A push: accepted anywhere is accepted (the mempool spreads it); refused
/// everywhere is refused, with the reasons; anything else is unknown.
pub(crate) fn push_verdict(outcomes: &[AckOutcome]) -> Result<(), ChainError> {
    if outcomes.iter().any(|o| *o == AckOutcome::Accepted) {
        return Ok(());
    }
    let failed: Vec<&str> = outcomes.iter().filter_map(|o| if let AckOutcome::Failed(w) = o { Some(w.as_str()) } else { None }).collect();
    if failed.len() == outcomes.len() {
        return Err(ChainError::Refused(failed.join("; ")));
    }
    Err(unanswered(format!("push: {} of {} peers did not ack ({})", outcomes.len() - failed.len(), outcomes.len(), describe(outcomes))))
}

/// Is a spend pushed earlier still live? Accepted anywhere: yes (it is in a
/// mempool again). Refused everywhere: dead only when EVERY peer's refusal is
/// FINAL — the bundle itself can never land — since a refusal for fee or load
/// says nothing about a copy an earlier peer may still hold, and one peer's
/// final word against another's policy refusal is no evidence either (a
/// dishonest peer could claim a double spend). Such a verdict stays unknown
/// and the coins stay parked (release only with evidence). Else unknown.
pub(crate) fn live_verdict(outcomes: &[AckOutcome]) -> Result<bool, ChainError> {
    if outcomes.iter().any(|o| *o == AckOutcome::Accepted) {
        return Ok(true);
    }
    if outcomes.iter().all(|o| matches!(o, AckOutcome::Failed(_))) {
        if outcomes.iter().all(|o| matches!(o, AckOutcome::Failed(why) if refusal_is_final(why))) {
            return Ok(false);
        }
        return Err(unanswered(format!(
            "spend liveness: refused, but not by every peer for a reason final on the bundle itself, so it may still be live elsewhere ({})",
            describe(outcomes)
        )));
    }
    Err(unanswered(format!("spend liveness: not every peer acked ({})", describe(outcomes))))
}

/// Whether a full node's reason for refusing a bundle says the bundle can
/// NEVER land (an input already spent, a condition that fails, a bad
/// signature, a malformed spend), as against its own policy or state (a fee
/// too low for a full mempool, "seen before", not synced, a timelock not yet
/// reached). The names are chia-blockchain's `Err` codes as
/// `TransactionAck.error` spells them; an unknown reason is not final.
pub(crate) fn refusal_is_final(reason: &str) -> bool {
    const FINAL: &[&str] = &[
        "DOUBLE_SPEND",
        "UNKNOWN_UNSPENT",
        // Assertions on the spend's own coins and announcements fail for good.
        "ASSERT_MY_COIN_ID_FAILED",
        "ASSERT_MY_PARENT_ID_FAILED",
        "ASSERT_MY_PUZZLEHASH_FAILED",
        "ASSERT_MY_AMOUNT_FAILED",
        "ASSERT_MY_BIRTH_SECONDS_FAILED",
        "ASSERT_MY_BIRTH_HEIGHT_FAILED",
        "ASSERT_COIN_ANNOUNCEMENT_FAILED",
        "ASSERT_PUZZLE_ANNOUNCEMENT_FAILED",
        "ASSERT_CONCURRENT_SPEND_FAILED",
        "ASSERT_CONCURRENT_PUZZLE_FAILED",
        "ASSERT_EPHEMERAL_FAILED",
        // A "before" timelock that failed is past for good; a plain timelock
        // (ASSERT_SECONDS_*, ASSERT_HEIGHT_*) can still pass and is NOT here.
        "ASSERT_BEFORE_",
        "MINTING_COIN",
        "RESERVE_FEE_CONDITION_FAILED",
        "COIN_AMOUNT_",
        "DUPLICATE_OUTPUT",
        "BAD_AGGREGATE_SIGNATURE",
        "INVALID_CONDITION",
        "INVALID_SPEND_BUNDLE",
        "INVALID_COIN_SOLUTION",
        "GENERATOR_RUNTIME_ERROR",
        "WRONG_PUZZLE_HASH",
        "BLOCK_COST_EXCEEDS_MAX",
    ];
    FINAL.iter().any(|code| reason.contains(code))
}

fn describe(outcomes: &[AckOutcome]) -> String {
    outcomes
        .iter()
        .map(|o| match o {
            AckOutcome::Accepted => "accepted".to_string(),
            AckOutcome::Failed(w) => format!("failed {w}"),
            AckOutcome::Silent(w) => format!("silent {w}"),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Which connected peers may form an agreed verdict (plan §14 (1), (2)).
/// `peers` are (source, group) per connection. With pins: the pin alone in
/// pin-only mode, else the pin plus one public peer from another group.
/// Without: two peers from distinct sources and groups, the first of them
/// fresh (the introducer this run).
pub(crate) fn pick_agreed(peers: &[(Source, Group)], pinned: bool, pin_only: bool) -> Option<Vec<usize>> {
    if pinned {
        let mut pins = peers.iter().enumerate().filter(|(_, (s, _))| *s == Source::Pin).map(|(i, _)| i);
        let first = pins.next()?;
        if pin_only {
            return Some(vec![first]);
        }
        // Any live pin may pair with a public peer outside its own group.
        for pin in std::iter::once(first).chain(pins) {
            if let Some(public) = peers.iter().position(|(s, g)| *s != Source::Pin && *g != peers[pin].1) {
                return Some(vec![pin, public]);
            }
        }
        return None;
    }
    for (i, (sa, ga)) in peers.iter().enumerate() {
        if !sa.is_fresh() {
            continue;
        }
        for (j, (sb, gb)) in peers.iter().enumerate() {
            if i != j && sb != sa && gb != ga {
                return Some(vec![i, j]);
            }
        }
    }
    None
}

/// In a full pool that cannot form an agreed pair, the connection to let go
/// so that `cand`, once connected, completes one: among the connections that
/// are not pins, a redundant one first (its source held twice), newest
/// first, the first whose removal makes [`pick_agreed`] succeed with `cand` in
/// its place. `None` when no single swap would help.
pub(crate) fn replaceable(facts: &[(Source, Group)], cand: (Source, Group), pinned: bool, pin_only: bool) -> Option<usize> {
    let mut held: HashMap<Source, usize> = HashMap::new();
    for (source, _) in facts {
        *held.entry(*source).or_default() += 1;
    }
    let mut order: Vec<usize> = (0..facts.len()).rev().filter(|&i| facts[i].0 != Source::Pin).collect();
    order.sort_by_key(|&i| held[&facts[i].0] < 2);
    order.into_iter().find(|&i| {
        let mut trial: Vec<(Source, Group)> = facts.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, f)| *f).collect();
        trial.push(cand);
        pick_agreed(&trial, pinned, pin_only).is_some()
    })
}

/// Could the next dial try a candidate of `cand`'s source and network group,
/// against the connections `pooled` (source, group, asked for gossip yet)?
/// With room in the pool: when its source is under [`PER_SOURCE_CAP`], or a
/// rotation could make room (a fresh candidate, a connection of its source
/// already asked for gossip; [`Lane::rotation`]). In a full pool: only when
/// the pool cannot pair and the swap [`replaceable`] names would complete
/// one. [`Lane::refill`] asks the introducer when nothing queued passes: a
/// full pool and a queue all in one network group would otherwise keep it
/// unasked for good, however long ago it last answered.
pub(crate) fn tryable(pooled: &[(Source, Group, bool)], cand: (Source, Group), pinned: bool, pin_only: bool) -> bool {
    let facts: Vec<(Source, Group)> = pooled.iter().map(|(s, g, _)| (*s, *g)).collect();
    if facts.len() >= MAX_CONNS {
        return pick_agreed(&facts, pinned, pin_only).is_none() && replaceable(&facts, cand, pinned, pin_only).is_some();
    }
    let held = facts.iter().filter(|(s, _)| *s == cand.0).count();
    held < PER_SOURCE_CAP || (cand.0.is_fresh() && pooled.iter().any(|(s, _, asked)| *s == cand.0 && *s != Source::Pin && *asked))
}

/// Take exactly `peer` out of the pool, never a later connection to the same
/// address (a request that slept through a reconnect holds a stale handle),
/// clearing its gossip marker. False when it was not pooled any more.
fn unpool(state: &mut LaneState, peer: &Arc<PeerConn>) -> bool {
    let Some(i) = state.conns.iter().position(|c| Arc::ptr_eq(c, peer)) else { return false };
    state.conns.remove(i);
    state.gossiped.remove(&peer.addr());
    true
}

/// Put a public peer whose connection is gone back in the queue, not to be
/// dialled before `after`. Pins are resolved afresh on their own schedule.
fn requeue(state: &mut LaneState, peer: &PeerConn, after: Duration) {
    if peer.source() == Source::Pin {
        return;
    }
    state.cooling.insert(peer.addr(), Instant::now() + after);
    push_candidates(state, vec![Candidate { addr: peer.addr(), source: peer.source(), failures: 0 }]);
}

/// Close a connection off the lane's lock: the websocket close is bounded,
/// but no caller waits on a peer that stopped reading.
fn close_later(peer: Arc<PeerConn>) {
    tokio::spawn(async move { peer.close().await });
}

/// Queue candidates not yet known. An address already queued or connected is
/// not queued again (one address, one vote), but a fresh mention of it is
/// kept: a stored or gossiped peer the introducer names this run counts as an
/// introducer peer from then on, so a warm start whose store already holds
/// everything the introducer answers can still form an agreed pair; no more
/// of them than [`PER_SOURCE_CAP`], as with dials, so one connection keeps
/// its source and the pair has two to draw on. A full
/// queue admits a newcomer in place of the queued address that has failed the
/// most dials, so dead addresses cannot shut fresh ones out; a queue full of
/// addresses that never failed keeps what it has.
fn push_candidates(state: &mut LaneState, mut new: Vec<Candidate>) {
    for cand in &mut new {
        cand.addr = canonical(cand.addr);
    }
    for cand in new {
        if let Some(conn) = state.conns.iter().find(|c| c.addr() == cand.addr) {
            // Promotion respects the per-source cap like a dial does: were
            // every connection relabelled introducer, no pair (two sources)
            // could form, no swap would complete one, and a full pool would
            // hold still for good.
            let held = state.conns.iter().filter(|c| c.source() == cand.source).count();
            if held < PER_SOURCE_CAP && conn.promote(cand.source) {
                eprintln!("⛓️ chain peers: {} now counts as {}: the introducer named it this run", cand.addr, cand.source.label());
            }
            continue;
        }
        if let Some(queued) = state.candidates.iter_mut().find(|c| c.addr == cand.addr) {
            if cand.source == Source::Introducer && !queued.source.is_fresh() {
                queued.source = cand.source;
            }
            continue;
        }
        if state.candidates.len() < CANDIDATE_CAP {
            state.candidates.push_back(cand);
        } else if cand.failures == 0 {
            let worst = state.candidates.iter().map(|c| c.failures).max().filter(|f| *f > 0);
            if let Some(i) = worst.and_then(|w| state.candidates.iter().position(|c| c.failures == w)) {
                state.candidates.remove(i);
                state.candidates.push_back(cand);
            }
        }
    }
}

/// A pin as typed: `ip:port`, a bare IP (the network's port), or a host name
/// with or without a port.
pub(crate) async fn resolve_pin(pin: &str, port: u16) -> Vec<SocketAddr> {
    if let Ok(addr) = pin.parse::<SocketAddr>() {
        return vec![canonical(addr)];
    }
    if let Ok(ip) = pin.parse::<IpAddr>() {
        return vec![canonical(SocketAddr::new(ip, port))];
    }
    let has_port = pin.rsplit_once(':').is_some_and(|(host, p)| !host.contains(':') && p.parse::<u16>().is_ok());
    let target = if has_port { pin.to_string() } else { format!("{pin}:{port}") };
    match tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host(target)).await {
        Ok(Ok(addrs)) => addrs.map(canonical).collect(),
        Ok(Err(e)) => {
            eprintln!("⛓️ chain peers: pin {pin}: {e}");
            vec![]
        }
        Err(_) => {
            eprintln!("⛓️ chain peers: pin {pin}: lookup timed out");
            vec![]
        }
    }
}

fn load_store(path: &Path) -> Vec<StoredPeer> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<StoreFile>(&bytes) {
            Ok(file) if file.v == 1 => file.peers,
            Ok(file) => {
                eprintln!("⛓️ chain peers: {} is version {}, which this node does not read; starting empty", path.display(), file.v);
                vec![]
            }
            Err(e) => {
                eprintln!("⛓️ chain peers: {} unreadable ({e}); starting empty", path.display());
                vec![]
            }
        },
        Err(_) => vec![],
    }
}

fn write_store(path: &Path, file: &StoreFile) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &bytes)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            let _ = std::fs::remove_file(&tmp);
            std::fs::write(path, &bytes).map_err(|_| rename_err)
        }
    }
}

/// A listing's continuation: the height and header hash the next
/// `RequestPuzzleState` resumes from (what the full node answered last).
pub(crate) fn encode_cursor(height: u32, header_hash: Bytes32) -> String {
    format!("{height}:{header_hash}")
}

pub(crate) fn decode_cursor(cursor: &str) -> Result<(u32, Bytes32), ChainError> {
    let parsed = cursor.split_once(':').and_then(|(h, hash)| {
        let height = h.parse::<u32>().ok()?;
        let bytes = hex::decode(hash).ok()?;
        let bytes: [u8; 32] = bytes.try_into().ok()?;
        Some((height, Bytes32::new(bytes)))
    });
    parsed.ok_or_else(|| ChainError::Refused(format!("listing cursor not understood: {cursor:?}")))
}

/// Coin states as the seam lists them: confirmed coins only, from
/// `min_height` up, spent ones when asked, in height then id order so two
/// peers' listings compare.
pub(crate) fn records_from(states: Vec<CoinState>, include_spent: bool, min_height: Option<u32>) -> Vec<CoinRecord> {
    let mut records: Vec<CoinRecord> = states
        .into_iter()
        .filter_map(|s| {
            let created = s.created_height?;
            if min_height.is_some_and(|min| created < min) || (!include_spent && s.spent_height.is_some()) {
                return None;
            }
            Some(CoinRecord {
                coin: s.coin,
                confirmed_block_index: created,
                spent: s.spent_height.is_some(),
                spent_block_index: s.spent_height.unwrap_or(0),
            })
        })
        .collect();
    records.sort_by(|a, b| (a.confirmed_block_index, a.coin.coin_id()).cmp(&(b.confirmed_block_index, b.coin.coin_id())));
    records.dedup_by(|a, b| a.coin == b.coin);
    records
}

/// One peer's raw answer to a listing, before the pair is judged: the coins
/// whose latest change lies in (`since`, `height`] (`height` its peak for a
/// finished listing, the page boundary otherwise; `since` the block the
/// request started after, `None` from genesis), the header hash there,
/// whether it has more to say, `knowledge`, the height the peer's view stood
/// at when it made the page (`height` for a finished page, its announced
/// peak, steady across the request, for one cut at the item limit), and for
/// a coin-state lookup `pending`, the ids the peer never got to.
#[derive(Debug, Clone)]
pub(crate) struct Page {
    pub states: Vec<CoinState>,
    pub height: u32,
    pub header_hash: Bytes32,
    pub finished: bool,
    pub knowledge: u32,
    pub since: Option<u32>,
    pub pending: Vec<Bytes32>,
}

/// What settling the peers' pages gives: the listing; the cursor's height
/// and header when it hands one out; and then the pages (by index) whose
/// peer stands above that height and has not shown the header there yet, to
/// be asked for it before the cursor is trusted.
pub(crate) struct Settled {
    pub listing: CoinListing,
    pub cursor_at: Option<(u32, Bytes32)>,
    pub unverified: Vec<usize>,
}

/// Judge the peers' pages of one listing together. Two honest peers need not
/// cut a listing at the same block, nor stand at the same peak: one hits its
/// response-item limit earlier, one is a block or two ahead, and a record in
/// either gap would read as a disagreement and evict a healthy peer. A page
/// holds the coins whose latest change lies in (since, height], as the peer
/// knew them at `knowledge`; so every page is first taken as of the LOWEST
/// knowledge (coins created above it left out, spends above it not yet seen)
/// and then cut to the changes after the latest start and up to the lowest
/// height (a change the lower peak undoes falls back before the start, where
/// an earlier page already told of the coin); what remains must match, coin
/// by coin. A coin missing from a page CUT SHORT by a peer that knows more
/// than the lowest knowledge is unknown there, not absent: that peer may
/// have seen it change above the cut and kept it for a later page. Such a
/// coin is left out and the listing comes back cut short with no cursor,
/// since a cursor past it would lose the coin on that peer's word alone. Any
/// other absence is a disagreement, as is a differing record or another
/// header at the lowest height; a page above that height is to show the
/// header there ([`Settled::unverified`]) before a cursor goes out. The
/// listing is complete when a page at the lowest height is finished and
/// nothing was left out above the lowest knowledge: a coin only the peer
/// ahead has seen leaves the listing INCOMPLETE (cut short, no cursor), not
/// absent, since the wallet lease takes a parked input absent from a complete
/// listing for gone. Otherwise the listing continues from the lowest height.
pub(crate) fn settle_pages(pages: &[Page], include_spent: bool, min_height: Option<u32>) -> Option<Settled> {
    let low = pages.iter().min_by_key(|p| p.height)?;
    let (height, header_hash) = (low.height, low.header_hash);
    if pages.iter().any(|p| p.height == height && p.header_hash != header_hash) {
        return None;
    }
    let knowledge = pages.iter().map(|p| p.knowledge).min()?;
    let since = pages.iter().filter_map(|p| p.since).max();
    let finished = pages.iter().any(|p| p.height == height && p.finished);
    let hidden = hides_a_coin(pages, knowledge);
    let lists: Vec<Vec<CoinRecord>> = pages
        .iter()
        .map(|p| {
            let states: Vec<CoinState> = as_of(p.states.clone(), knowledge)
                .into_iter()
                .filter(|s| changed_at(s) <= height && since.is_none_or(|from| changed_at(s) > from))
                .collect();
            records_from(states, include_spent, min_height)
        })
        .collect();
    let (records, unknown) = agreed(&lists, |i, _| !pages[i].finished && pages[i].knowledge > knowledge)?;
    if unknown {
        let listing = CoinListing { records, truncated: true, next_cursor: None };
        return Some(Settled { listing, cursor_at: None, unverified: vec![] });
    }
    if !finished {
        let unverified = pages.iter().enumerate().filter(|(_, p)| p.height > height).map(|(i, _)| i).collect();
        let listing = CoinListing { records, truncated: true, next_cursor: Some(encode_cursor(height, header_hash)) };
        return Some(Settled { listing, cursor_at: Some((height, header_hash)), unverified });
    }
    Some(Settled { listing: CoinListing { records, truncated: hidden, next_cursor: None }, cursor_at: None, unverified: vec![] })
}

/// [`settle_pages`] for coin-state lookups, which carry no cursor and whose
/// answers are the coins' states as the peer knew them at `knowledge`: judged
/// as of the lowest knowledge; a coin a peer never got to ([`Page::pending`],
/// its lookup capped) is unknown there, not absent, and left out; cut short
/// when any peer's lookup was, or when a coin created above that knowledge
/// had to be left out.
pub(crate) fn settle_states(pages: &[Page], include_spent: bool) -> Option<CoinListing> {
    let knowledge = pages.iter().map(|p| p.knowledge).min()?;
    let finished = pages.iter().all(|p| p.finished);
    let hidden = hides_a_coin(pages, knowledge);
    let lists: Vec<Vec<CoinRecord>> = pages.iter().map(|p| records_from(as_of(p.states.clone(), knowledge), include_spent, None)).collect();
    let (records, unknown) = agreed(&lists, |i, id| pages[i].pending.contains(id))?;
    Some(CoinListing { records, truncated: !finished || hidden || unknown, next_cursor: None })
}

/// The records every list gives alike, and whether any coin had to be left
/// out as unknown: a coin missing from list `i` is unknown when
/// `unknown(i, &id)` says so, else its absence is a difference. `None` on any
/// difference. The records keep the first list's (height, id) order.
fn agreed(lists: &[Vec<CoinRecord>], unknown: impl Fn(usize, &Bytes32) -> bool) -> Option<(Vec<CoinRecord>, bool)> {
    let first = lists.first()?;
    let by_id: Vec<HashMap<Bytes32, &CoinRecord>> = lists.iter().map(|l| l.iter().map(|r| (r.coin.coin_id(), r)).collect()).collect();
    let mut ids: Vec<Bytes32> = by_id.iter().flat_map(|m| m.keys().copied()).collect();
    ids.sort_unstable();
    ids.dedup();
    let mut left_out = false;
    let mut keep: HashSet<Bytes32> = HashSet::new();
    for id in ids {
        let mut seen: Option<&CoinRecord> = None;
        let mut everywhere = true;
        for (i, m) in by_id.iter().enumerate() {
            match m.get(&id) {
                Some(r) => match seen {
                    Some(s) if s != *r => return None,
                    _ => seen = Some(*r),
                },
                None if unknown(i, &id) => everywhere = false,
                None => return None,
            }
        }
        if everywhere {
            keep.insert(id);
        } else {
            left_out = true;
        }
    }
    Some((first.iter().filter(|r| keep.contains(&r.coin.coin_id())).cloned().collect(), left_out))
}

/// Does taking the pages as of `knowledge` leave a coin out that a peer has
/// seen created above it?
fn hides_a_coin(pages: &[Page], knowledge: u32) -> bool {
    pages.iter().any(|p| p.states.iter().any(|s| s.created_height.is_some_and(|h| h > knowledge)))
}

/// The height of a coin state's latest change: its spend, else its creation.
fn changed_at(s: &CoinState) -> u32 {
    s.created_height.unwrap_or(0).max(s.spent_height.unwrap_or(0))
}

/// The coin states as the chain stood at `height`: coins created above it
/// are not there yet, spends above it have not happened.
fn as_of(states: Vec<CoinState>, height: u32) -> Vec<CoinState> {
    states
        .into_iter()
        .filter(|s| !s.created_height.is_some_and(|h| h > height))
        .map(|mut s| {
            if s.spent_height.is_some_and(|h| h > height) {
                s.spent_height = None;
            }
            s
        })
        .collect()
}

/// Settle the peers' pages and, when a cursor goes out, have every peer that
/// stands above its height show the header there: a peer on another fork
/// with the same coins would otherwise hand the pair a cursor the other side
/// rejects as a reorg one request later. Another header, or none, is a
/// disagreement; a peer that does not answer leaves the verdict unanswered.
async fn settle_listing(answers: Vec<(Arc<PeerConn>, Page)>, include_spent: bool, min_height: Option<u32>) -> Result<Option<CoinListing>, ChainError> {
    let pages: Vec<Page> = answers.iter().map(|(_, p)| p.clone()).collect();
    let Some(settled) = settle_pages(&pages, include_spent, min_height) else { return Ok(None) };
    if let Some((height, hash)) = settled.cursor_at {
        for i in settled.unverified {
            let peer = &answers[i].0;
            match peer.request_fallible::<RespondBlockHeader, RejectHeaderRequest, _>(RequestBlockHeader::new(height)).await {
                Ok(Ok(answer)) if answer.header_block.header_hash() == hash => {}
                Ok(_) => {
                    eprintln!("⛓️ chain peers: {} does not have the header the listing cursor names at height {height}", peer.addr());
                    return Ok(None);
                }
                Err(e) => return Err(ChainError::Unanswered(e)),
            }
        }
    }
    Ok(Some(settled.listing))
}

/// One peer's listing under `keys` (puzzle hashes, read as hints too when
/// `hinted`): `RequestPuzzleState` from `cursor`, else from the block before
/// `min_height` (its header fetched first, so a watcher's incremental scan
/// asks only for what changed since; the peer rejecting that start as a
/// reorg sends the listing back to genesis), else from genesis. ONE protocol
/// page: a peer with more to say leaves the listing cut short with a cursor,
/// and the caller's page budget (`chia_resolve::MAX_PAGES_PER_POLL`,
/// `chia_faucet::MAX_FAUCET_PAGES`, `chia_publish::MAX_RECONCILE_PAGES`)
/// decides how far to follow; no second budget hides beneath it. The page
/// comes back raw, spent coins included: [`settle_pages`] judges the peers'
/// pages together and filters afterwards.
async fn listing_on(
    peer: Arc<PeerConn>,
    net: Network,
    keys: Vec<Bytes32>,
    hinted: bool,
    min_height: Option<u32>,
    cursor: Option<String>,
) -> Result<Page, ChainError> {
    let mut from_header = false;
    let (mut previous, mut header_hash) = match cursor {
        None => match min_height {
            Some(min) if min > 0 => match start_before(&peer, min).await {
                Some(start) => {
                    from_header = true;
                    start
                }
                None => (None, net.genesis),
            },
            _ => (None, net.genesis),
        },
        Some(cursor) => {
            let (height, hash) = decode_cursor(&cursor)?;
            (Some(height), hash)
        }
    };
    // Spent coins are always asked for: the pages are judged as of one
    // height, and a peer ahead of it would otherwise hide a coin spent in the
    // gap that the other peer still lists. The caller's choice is applied by
    // [`settle_pages`].
    let filters = CoinStateFilters::new(true, true, hinted, 0);
    let mut attempts = 0;
    let page = loop {
        let before = peer.peak_now();
        let page = peer
            .request_fallible::<RespondPuzzleState, RejectPuzzleState, _>(RequestPuzzleState::new(
                keys.clone(),
                previous,
                header_hash,
                filters.clone(),
                false,
            ))
            .await
            .map_err(ChainError::Unanswered)?;
        match page {
            Ok(page) if page.is_finished => {
                break Page {
                    knowledge: page.height,
                    states: page.coin_states,
                    height: page.height,
                    header_hash: page.header_hash,
                    finished: true,
                    since: previous,
                    pending: vec![],
                };
            }
            Ok(page) => {
                // A page cut at the item limit says nothing about how far the
                // peer's view reached; its announced peak does, if it stood
                // still across the request, header and height alike (an
                // announcement landing between the answer and this line would
                // date the page a block late; a new block at the same height
                // would mix two chains into one page).
                let after = peer.peak_now();
                match (before, after) {
                    (Some(b), Some(a)) if b == a => {
                        break Page {
                            states: page.coin_states,
                            height: page.height,
                            header_hash: page.header_hash,
                            finished: false,
                            knowledge: a.height,
                            since: previous,
                            pending: vec![],
                        };
                    }
                    (None, None) => return Err(unanswered(format!("{} announced no peak to date its listing by", peer.addr()))),
                    _ => {
                        attempts += 1;
                        if attempts >= PEAK_SETTLE_ATTEMPTS {
                            return Err(unanswered(format!("{}: its peak moved during each of {attempts} listing requests", peer.addr())));
                        }
                    }
                }
            }
            Err(reject) if from_header && reject.reason == RejectStateReason::Reorg => {
                // The block before `min_height` is not on the peer's chain any
                // more: the listing starts over from genesis, once.
                from_header = false;
                previous = None;
                header_hash = net.genesis;
            }
            Err(reject) => return Err(ChainError::Refused(format!("coin listing rejected: {:?}", reject.reason))),
        }
    };
    Ok(page)
}

/// Where an incremental listing starts: the block before `min_height` and its
/// header hash as the peer serves it, or `None` (start from genesis) when the
/// peer will not serve it.
async fn start_before(peer: &Arc<PeerConn>, min_height: u32) -> Option<(Option<u32>, Bytes32)> {
    let before = min_height.checked_sub(1)?;
    match peer.request_fallible::<RespondBlockHeader, RejectHeaderRequest, _>(RequestBlockHeader::new(before)).await {
        Ok(Ok(answer)) => Some((Some(before), answer.header_block.header_hash())),
        _ => None,
    }
}

/// One peer's states for the coins named. The peer echoes the ids it answered
/// for (a request is capped at its response-item limit); the rest are asked
/// again, and a lookup still short after [`STATE_ROUNDS`] requests, or one the
/// peer makes no progress on, is cut short with no cursor, which every caller
/// treats as incomplete (the wallet lease keeps its coins parked); the ids it
/// never got to travel as [`Page::pending`], unknown rather than absent when
/// the peers' answers are judged.
async fn states_on(peer: Arc<PeerConn>, net: Network, names: Vec<Bytes32>) -> Result<Page, ChainError> {
    let mut seen: HashSet<Bytes32> = HashSet::new();
    let names: Vec<Bytes32> = names.into_iter().filter(|id| seen.insert(*id)).collect();
    let mut attempts = 0;
    loop {
        // The answers are dated by the peer's announced peak, which must stand
        // still across the whole lookup, header and height alike: an
        // announcement landing between an answer and its reading would date
        // older states a block too late, and a new block at the same height
        // would mix two chains into one snapshot.
        let Some(before) = peer.peak_now() else {
            return Err(unanswered(format!("{} announced no peak to date its coin states by", peer.addr())));
        };
        let mut wanted = names.clone();
        let mut states: Vec<CoinState> = Vec::new();
        let mut finished = false;
        for _ in 0..STATE_ROUNDS {
            let answer = peer
                .request_fallible::<RespondCoinState, RejectCoinState, _>(RequestCoinState::new(wanted.clone(), None, net.genesis, false))
                .await
                .map_err(ChainError::Unanswered)?;
            let answer = match answer {
                Ok(answer) => answer,
                Err(reject) => return Err(ChainError::Refused(format!("coin states rejected: {:?}", reject.reason))),
            };
            let echoed: HashSet<Bytes32> = answer.coin_ids.iter().copied().collect();
            states.extend(answer.coin_states);
            let left = wanted.len();
            wanted.retain(|id| !echoed.contains(id));
            if wanted.is_empty() {
                finished = true;
                break;
            }
            if wanted.len() == left {
                // No progress: the peer answers for none of what is left.
                break;
            }
        }
        if peer.peak_now() == Some(before) {
            return Ok(Page { states, height: before.height, header_hash: before.header_hash, finished, knowledge: before.height, since: None, pending: wanted });
        }
        attempts += 1;
        if attempts >= PEAK_SETTLE_ATTEMPTS {
            return Err(unanswered(format!("{}: its peak moved during each of {attempts} coin-state lookups", peer.addr())));
        }
    }
}

/// One peer's puzzle reveal and solution for a spend.
async fn spend_on(peer: Arc<PeerConn>, coin_id: Bytes32, height: u32) -> Result<Option<PuzzleAndSolution>, ChainError> {
    let answer = peer
        .request_fallible::<RespondPuzzleSolution, RejectPuzzleSolution, _>(RequestPuzzleSolution::new(coin_id, height))
        .await
        .map_err(ChainError::Unanswered)?;
    Ok(answer.ok().map(|r| PuzzleAndSolution { puzzle_reveal: r.response.puzzle, solution: r.response.solution }))
}

impl ChainAccess for PeerLane {
    fn coin_records_by_hint(
        &self,
        hint: Bytes32,
        start_height: Option<u32>,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
        let net = self.lane.net.clone();
        async move {
            self.lane
                .ask_by(
                    "coins by hint",
                    self.trust,
                    move |peer| listing_on(peer, net.clone(), vec![hint], true, start_height, cursor.clone()),
                    move |answers| settle_listing(answers, include_spent, start_height),
                )
                .await
        }
    }

    fn coin_records_by_puzzle_hash(
        &self,
        puzzle_hash: Bytes32,
        include_spent: bool,
        cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
        let net = self.lane.net.clone();
        async move {
            self.lane
                .ask_by(
                    "coins by puzzle hash",
                    self.trust,
                    move |peer| listing_on(peer, net.clone(), vec![puzzle_hash], false, None, cursor.clone()),
                    move |answers| settle_listing(answers, include_spent, None),
                )
                .await
        }
    }

    fn coin_records_by_names(
        &self,
        names: Vec<Bytes32>,
        include_spent: bool,
        _cursor: Option<String>,
    ) -> impl Future<Output = Result<CoinListing, ChainError>> + Send {
        let net = self.lane.net.clone();
        async move {
            self.lane
                .ask_by(
                    "coins by id",
                    self.trust,
                    move |peer| states_on(peer, net.clone(), names.clone()),
                    move |answers: Vec<(Arc<PeerConn>, Page)>| {
                        let pages: Vec<Page> = answers.into_iter().map(|(_, p)| p).collect();
                        std::future::ready(Ok(settle_states(&pages, include_spent)))
                    },
                )
                .await
        }
    }

    fn puzzle_and_solution(
        &self,
        coin_id: Bytes32,
        height: u32,
    ) -> impl Future<Output = Result<Option<PuzzleAndSolution>, ChainError>> + Send {
        async move { self.lane.ask("puzzle and solution", self.trust, move |peer| spend_on(peer, coin_id, height)).await }
    }

    fn peak_height(&self) -> impl Future<Output = Result<u32, ChainError>> + Send {
        async move { self.lane.peak(self.trust).await }
    }

    fn spend_live(&self, bundle: SpendBundle) -> impl Future<Output = Result<bool, ChainError>> + Send {
        async move { live_verdict(&self.lane.acks(bundle).await?) }
    }

    fn push_tx(&self, bundle: SpendBundle) -> impl Future<Output = Result<(), ChainError>> + Send {
        async move { push_verdict(&self.lane.acks(bundle).await?) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chia_peer::mock::{header_at, reply, spawn, spawn_on, Handler, MockNode};
    use crate::chia_peer::tls_client_config;
    use chia_protocol::{Coin, Message, NewPeakWallet, NodeType, Program, PuzzleSolutionResponse, TimestampedPeerInfo};
    use chia_traits::Streamable;
    use std::sync::{LazyLock, Mutex};

    fn genesis() -> Bytes32 {
        Bytes32::new([7u8; 32])
    }

    fn net() -> Network {
        Network { id: "mocknet".to_string(), genesis: genesis(), port: 0, introducers: vec![] }
    }

    static TLS: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| tls_client_config().unwrap());

    fn coin(seed: u8) -> Coin {
        Coin::new(Bytes32::new([seed; 32]), Bytes32::new([seed.wrapping_add(1); 32]), u64::from(seed))
    }

    fn state(seed: u8, created: u32, spent: Option<u32>) -> CoinState {
        CoinState::new(coin(seed), spent, Some(created))
    }

    /// A full node answering listings with `states`, spends with a fixed
    /// reveal, pushes with `ack` (status, error), headers above 0 with the
    /// deterministic header at that height, and gossip with `gossip`.
    fn node(states: Vec<CoinState>, ack: (u8, Option<&'static str>), gossip: Vec<SocketAddr>) -> Handler {
        Arc::new(move |m: &Message| match m.msg_type {
            chia_protocol::ProtocolMessageTypes::RequestPuzzleState => {
                let req = RequestPuzzleState::from_bytes(&m.data).unwrap();
                vec![reply(&RespondPuzzleState::new(req.puzzle_hashes, 100, header_at(100, genesis()).header_hash(), true, states.clone()))]
            }
            chia_protocol::ProtocolMessageTypes::RequestCoinState => {
                let req = RequestCoinState::from_bytes(&m.data).unwrap();
                let named: Vec<CoinState> = states.iter().filter(|s| req.coin_ids.contains(&s.coin.coin_id())).cloned().collect();
                vec![reply(&RespondCoinState::new(req.coin_ids, named))]
            }
            chia_protocol::ProtocolMessageTypes::RequestPuzzleSolution => {
                let req = RequestPuzzleSolution::from_bytes(&m.data).unwrap();
                vec![reply(&RespondPuzzleSolution::new(PuzzleSolutionResponse::new(
                    req.coin_name,
                    req.height,
                    Program::from(vec![0x80u8]),
                    Program::from(vec![0x80u8]),
                )))]
            }
            chia_protocol::ProtocolMessageTypes::SendTransaction => {
                let tx = SendTransaction::from_bytes(&m.data).unwrap();
                vec![reply(&TransactionAck::new(tx.transaction.name(), ack.0, ack.1.map(String::from)))]
            }
            chia_protocol::ProtocolMessageTypes::RequestBlockHeader => {
                let req = RequestBlockHeader::from_bytes(&m.data).unwrap();
                vec![reply(&RespondBlockHeader::new(header_at(req.height, genesis())))]
            }
            chia_protocol::ProtocolMessageTypes::RequestPeers => vec![reply(&RespondPeers::new(
                gossip.iter().map(|a| TimestampedPeerInfo::new(a.ip().to_string(), a.port(), 1)).collect(),
            ))],
            _ => vec![],
        })
    }

    async fn full_node(states: Vec<CoinState>, ack: (u8, Option<&'static str>), peak: Option<Peak>) -> MockNode {
        spawn("mocknet", NodeType::FullNode, genesis(), peak, node(states, ack, vec![])).await
    }

    fn peak_at(height: u32) -> Peak {
        Peak { height, header_hash: header_at(height, genesis()).header_hash() }
    }

    /// A full node that honours `previous_height`: the coins changed after
    /// it, cut at `boundary` while that lies ahead (an unfinished page, named
    /// by `boundary_hash` when given: a node on another fork), else through
    /// height 100, finished.
    fn paged(states: Vec<CoinState>, boundary: Option<u32>, boundary_hash: Option<Bytes32>) -> Handler {
        paged_to(states, 100, boundary, boundary_hash)
    }

    /// [`paged`] for a node whose chain ends at `top`.
    fn paged_to(states: Vec<CoinState>, top: u32, boundary: Option<u32>, boundary_hash: Option<Bytes32>) -> Handler {
        let base = node(states.clone(), (1, None), vec![]);
        Arc::new(move |m: &Message| {
            if m.msg_type != chia_protocol::ProtocolMessageTypes::RequestPuzzleState {
                return base(m);
            }
            let req = RequestPuzzleState::from_bytes(&m.data).unwrap();
            let since = req.previous_height.unwrap_or(0);
            let changed = |s: &CoinState| s.created_height.unwrap_or(0).max(s.spent_height.unwrap_or(0));
            let cut = boundary.filter(|b| *b > since).unwrap_or(top);
            let page: Vec<CoinState> = states.iter().filter(|s| changed(s) > since && changed(s) <= cut).cloned().collect();
            let hash = boundary_hash.filter(|_| Some(cut) == boundary).unwrap_or_else(|| header_at(cut, genesis()).header_hash());
            vec![reply(&RespondPuzzleState::new(req.puzzle_hashes, cut, hash, cut == top, page))]
        })
    }

    /// A full node answering a coin-state request for its first `cap` ids only.
    fn capped(states: Vec<CoinState>, cap: usize) -> Handler {
        let base = node(states.clone(), (1, None), vec![]);
        Arc::new(move |m: &Message| {
            if m.msg_type != chia_protocol::ProtocolMessageTypes::RequestCoinState {
                return base(m);
            }
            let req = RequestCoinState::from_bytes(&m.data).unwrap();
            let ids: Vec<Bytes32> = req.coin_ids.iter().take(cap).copied().collect();
            let named: Vec<CoinState> = states.iter().filter(|s| ids.contains(&s.coin.coin_id())).cloned().collect();
            vec![reply(&RespondCoinState::new(ids, named))]
        })
    }

    fn lane(seeds: Vec<(SocketAddr, Source)>, pins: Vec<String>, pin_only: bool, store: Option<PathBuf>) -> Arc<Lane> {
        Arc::new(Lane::new(net(), pins, pin_only, store).with_candidates(seeds).with_tls(TLS.clone()))
    }

    fn temp_store(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ssf-chia-peers-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(STORE_FILE)
    }

    fn bundle() -> SpendBundle {
        SpendBundle::new(vec![], chia_bls::G2Element::default())
    }

    /// A loopback address nothing listens on.
    async fn closed() -> SocketAddr {
        tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap()
    }

    #[tokio::test]
    async fn two_agreeing_peers_make_a_final_listing_and_are_remembered() {
        let states = vec![state(1, 90, None), state(2, 80, Some(85)), state(3, 95, None)];
        let a = full_node(states.clone(), (1, None), Some(peak_at(100))).await;
        let b = full_node(states, (1, None), Some(peak_at(100))).await;
        let store = temp_store("agree");
        let _ = std::fs::remove_file(&store);
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, Some(store.clone()));
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let got = money.coin_records_by_hint(Bytes32::new([9u8; 32]), Some(85), true, None).await.unwrap();
        assert_eq!(
            got.records.iter().map(|r| (r.coin.amount, r.confirmed_block_index, r.spent)).collect::<Vec<_>>(),
            vec![(1, 90, false), (3, 95, false)],
            "from height 85 up, in height order; the coin confirmed at 80 is left out"
        );
        assert!(!got.truncated && got.next_cursor.is_none());
        // Spent ones out when not asked for.
        let unspent = money.coin_records_by_puzzle_hash(Bytes32::new([9u8; 32]), false, None).await.unwrap();
        assert_eq!(unspent.records.iter().map(|r| r.coin.amount).collect::<Vec<_>>(), vec![1, 3]);
        let by_id = money.coin_records_by_names(vec![coin(2).coin_id()], true, None).await.unwrap();
        assert_eq!(by_id.records.len(), 1);
        assert!(by_id.records[0].spent && by_id.records[0].spent_block_index == 85);
        assert_eq!(money.peak_height().await.unwrap(), 100);
        assert!(money.puzzle_and_solution(coin(1).coin_id(), 90).await.unwrap().is_some());
        // Both public peers are now known-good.
        let saved: StoreFile = serde_json::from_slice(&std::fs::read(&store).unwrap()).unwrap();
        let mut addrs: Vec<String> = saved.peers.iter().map(|p| p.addr.clone()).collect();
        addrs.sort();
        let mut want = vec![a.addr.to_string(), b.addr.to_string()];
        want.sort();
        assert_eq!(addrs, want);
        assert_eq!(lane.live_count().await, 2);
        let _ = std::fs::remove_file(&store);
    }

    #[tokio::test]
    async fn disagreeing_peers_are_non_final_and_let_go() {
        let a = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![state(1, 90, Some(99))], (1, None), Some(peak_at(100))).await;
        let store = temp_store("disagree");
        let _ = std::fs::remove_file(&store);
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Store)], vec![], false, Some(store.clone()));
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let err = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap_err();
        assert!(matches!(&err, ChainError::Unanswered(e) if e.to_string().contains("disagree")), "{err}");
        assert_eq!(lane.live_count().await, 0, "both public peers were let go");
        assert!(!store.exists() || serde_json::from_slice::<StoreFile>(&std::fs::read(&store).unwrap()).unwrap().peers.is_empty());
        // The carrier does not mind: the first reachable peer answers.
        let carrier = PeerLane::new(lane.clone(), Trust::Carrier);
        let _ = std::fs::remove_file(&store);
        // Cooling keeps the two addresses off the dial list, so the carrier has nobody.
        let err = carrier.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap_err();
        assert!(err.to_string().contains("no full-node peer"), "{err}");
    }

    #[tokio::test]
    async fn the_carrier_takes_one_peer_where_money_paths_need_two() {
        let a = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let lane = lane(vec![(a.addr, Source::Introducer)], vec![], false, None);
        let carrier = PeerLane::new(lane.clone(), Trust::Carrier);
        assert_eq!(carrier.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(), 1);
        assert_eq!(carrier.peak_height().await.unwrap(), 100);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let err = money.peak_height().await.unwrap_err();
        assert!(err.to_string().contains("fewer than two"), "{err}");
    }

    #[tokio::test]
    async fn two_peers_from_one_source_do_not_agree_but_gossip_brings_a_second_source() {
        // A and B both came from the introducer: one source, so no verdict —
        // until A gossips C, a second source in another group.
        let c = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), node(vec![state(4, 50, None)], (1, None), vec![c.addr])).await;
        let b = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Introducer)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let got = money.coin_records_by_names(vec![coin(4).coin_id()], true, None).await.unwrap();
        assert_eq!(got.records.len(), 1);
        assert!(lane.live_count().await >= 2);
        assert!(c.seen.lock().unwrap().contains(&chia_protocol::ProtocolMessageTypes::RequestCoinState), "the gossiped peer took part");
    }

    #[tokio::test]
    async fn a_pin_decides_alone_in_pin_only_mode_and_an_unreachable_pin_blocks_money_paths() {
        let pin = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let only = lane(vec![], vec![pin.addr.to_string()], true, None);
        let money = PeerLane::new(only.clone(), Trust::Agreed);
        assert_eq!(money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(), 1);
        assert_eq!(only.live_count().await, 1, "no public peer is dialled in pin-only mode");

        // A pin nobody listens on: money paths are non-final, whatever public peers exist.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        let public = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let pinned = lane(vec![(public.addr, Source::Introducer)], vec![closed.to_string()], false, None);
        let err = PeerLane::new(pinned.clone(), Trust::Agreed).peak_height().await.unwrap_err();
        assert!(err.to_string().contains("pinned"), "{err}");
        // The presence lane may still read from the public peer meanwhile.
        assert_eq!(PeerLane::new(pinned.clone(), Trust::Carrier).peak_height().await.unwrap(), 100);
    }

    #[tokio::test]
    async fn a_pin_and_a_public_peer_agree_from_different_groups() {
        let pin = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let public = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let lane = lane(vec![(public.addr, Source::Introducer)], vec![pin.addr.to_string()], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert_eq!(money.peak_height().await.unwrap(), 100);
        let seen_pin = pin.seen.lock().unwrap().clone();
        assert!(seen_pin.contains(&chia_protocol::ProtocolMessageTypes::Handshake));
    }

    #[tokio::test]
    async fn the_peak_settles_on_the_common_header_or_stays_non_final() {
        // B is one block ahead and serves A's peak header at 100: agreed at 100.
        let a = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![], (1, None), Some(peak_at(101))).await;
        let lane_ab = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        assert_eq!(PeerLane::new(lane_ab.clone(), Trust::Agreed).peak_height().await.unwrap(), 100);
        assert!(b.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestBlockHeader).count() >= 2);

        // C is far ahead of the pinned A: a pin is never let go, so the lag
        // itself is the verdict, non-final. (A lagging public peer is let go
        // instead; see the laggard test below.)
        let c = full_node(vec![], (1, None), Some(peak_at(100 + MAX_PEAK_LAG + 1))).await;
        let a2 = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let lane_ac = lane(vec![(c.addr, Source::Gossip)], vec![a2.addr.to_string()], false, None);
        let err = PeerLane::new(lane_ac.clone(), Trust::Agreed).peak_height().await.unwrap_err();
        assert!(err.to_string().contains("lags"), "{err}");
        assert_eq!(lane_ac.live_count().await, 2, "the pin stays whatever its peak");

        // D claims height 100 under another header hash: disagreement.
        let d = full_node(vec![], (1, None), Some(Peak { height: 100, header_hash: Bytes32::new([3u8; 32]) })).await;
        let a3 = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let lane_ad = lane(vec![(a3.addr, Source::Introducer), (d.addr, Source::Gossip)], vec![], false, None);
        let err = PeerLane::new(lane_ad.clone(), Trust::Agreed).peak_height().await.unwrap_err();
        assert!(err.to_string().contains("disagree"), "{err}");
        assert_eq!(lane_ad.live_count().await, 0);
    }

    #[tokio::test]
    async fn pushes_and_liveness_follow_the_acks() {
        let ok_a = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let ok_b = full_node(vec![], (2, None), Some(peak_at(100))).await;
        let accepted = PeerLane::new(lane(vec![(ok_a.addr, Source::Introducer), (ok_b.addr, Source::Gossip)], vec![], false, None), Trust::Agreed);
        accepted.push_tx(bundle()).await.unwrap();
        assert!(accepted.spend_live(bundle()).await.unwrap());

        let no_a = full_node(vec![], (3, Some("DOUBLE_SPEND")), Some(peak_at(100))).await;
        let no_b = full_node(vec![], (3, Some("DOUBLE_SPEND")), Some(peak_at(100))).await;
        let refused = PeerLane::new(lane(vec![(no_a.addr, Source::Introducer), (no_b.addr, Source::Gossip)], vec![], false, None), Trust::Agreed);
        match refused.push_tx(bundle()).await {
            Err(ChainError::Refused(why)) => assert!(why.contains("DOUBLE_SPEND"), "{why}"),
            other => panic!("{other:?}"),
        }
        assert!(!refused.spend_live(bundle()).await.unwrap(), "refused everywhere: the spend is dead");

        let mixed = PeerLane::new(lane(vec![(ok_a.addr, Source::Introducer), (no_b.addr, Source::Gossip)], vec![], false, None), Trust::Agreed);
        mixed.push_tx(bundle()).await.unwrap();
        assert!(mixed.spend_live(bundle()).await.unwrap(), "accepted anywhere: live");
    }

    #[tokio::test]
    async fn four_introducer_peers_leave_room_for_a_gossiped_second_source() {
        // Four peers from one source would fill the pool and never agree; the
        // per-source cap keeps a slot, and A's gossip brings C, another source.
        let c = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), node(vec![state(4, 50, None)], (1, None), vec![c.addr])).await;
        let b = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let d = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let e = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let seeds = vec![(a.addr, Source::Introducer), (b.addr, Source::Introducer), (d.addr, Source::Introducer), (e.addr, Source::Introducer)];
        let lane = lane(seeds, vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let got = money.coin_records_by_names(vec![coin(4).coin_id()], true, None).await.unwrap();
        assert_eq!(got.records.len(), 1);
        let conns = lane.live_conns().await;
        assert!(conns.len() <= MAX_CONNS);
        assert!(conns.iter().filter(|c| c.source() == Source::Introducer).count() <= PER_SOURCE_CAP, "one source never holds the whole pool");
        assert!(conns.iter().any(|c| c.source() == Source::Gossip), "the gossiped peer got a slot");
        assert!(c.seen.lock().unwrap().contains(&chia_protocol::ProtocolMessageTypes::RequestCoinState), "and took part in the verdict");
    }

    #[tokio::test]
    async fn three_introducer_peers_that_know_nobody_make_room_for_one_that_gossips_a_second_source() {
        // A, B and D came from the introducer and gossip nobody; E, from the
        // introducer too, waits behind the per-source cap and would gossip C,
        // the second source the pair needs. Without rotation the three would
        // hold their cap for good and every money request would fail.
        let c = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let a = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let d = full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await;
        let e = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), node(vec![state(4, 50, None)], (1, None), vec![c.addr])).await;
        let seeds = vec![(a.addr, Source::Introducer), (b.addr, Source::Introducer), (d.addr, Source::Introducer), (e.addr, Source::Introducer)];
        let lane = lane(seeds, vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let got = money.coin_records_by_names(vec![coin(4).coin_id()], true, None).await.unwrap();
        assert_eq!(got.records.len(), 1);
        let conns = lane.live_conns().await;
        assert!(conns.len() <= MAX_CONNS);
        assert!(conns.iter().filter(|p| p.source() == Source::Introducer).count() <= PER_SOURCE_CAP, "the cap holds");
        assert!(conns.iter().any(|p| p.addr() == e.addr), "the waiting introducer peer got a slot");
        assert!(conns.iter().any(|p| p.addr() == c.addr && p.source() == Source::Gossip), "and its gossip brought the second source");
        assert!(c.seen.lock().unwrap().contains(&chia_protocol::ProtocolMessageTypes::RequestCoinState), "which took part in the verdict");
        let gone: Vec<SocketAddr> = [a.addr, b.addr, d.addr].into_iter().filter(|x| !conns.iter().any(|p| p.addr() == *x)).collect();
        assert_eq!(gone.len(), 1, "exactly one of the three that knew nobody was let go: {gone:?}");
        let state = lane.state.lock().await;
        assert!(state.cooling.contains_key(&gone[0]), "it cools before another dial");
        assert!(state.candidates.iter().any(|q| q.addr == gone[0]), "and waits in the queue, to be asked for gossip again");
    }

    #[tokio::test]
    async fn peers_cutting_a_listing_at_different_blocks_still_agree() {
        // The same history on both: A serves it in one page through height
        // 100; B hits its item limit at 92 and finishes on a second request.
        // Coin 4 was created at 80 and spent at 95: its latest change is past
        // the cut, so B's first page leaves it out while A's page has it
        // spent; judged over the changes up to 92 the pages agree, A shows the
        // header the cursor names, and the second request brings the rest.
        // Nobody is evicted.
        let history = vec![state(1, 90, None), state(2, 80, Some(85)), state(3, 95, None), state(4, 80, Some(95))];
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), paged(history.clone(), None, None)).await;
        let b = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), paged(history, Some(92), None)).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let first = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap();
        assert_eq!(
            first.records.iter().map(|r| (r.coin.amount, r.confirmed_block_index, r.spent)).collect::<Vec<_>>(),
            vec![(2, 80, true), (1, 90, false)],
            "as of height 92: the coin confirmed at 95 is not there yet"
        );
        assert!(first.truncated);
        assert_eq!(decode_cursor(first.next_cursor.as_deref().unwrap()).unwrap(), (92, header_at(92, genesis()).header_hash()));
        assert!(a.seen.lock().unwrap().contains(&chia_protocol::ProtocolMessageTypes::RequestBlockHeader), "A was asked for the header at 92");
        let rest = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, first.next_cursor).await.unwrap();
        assert_eq!(
            rest.records.iter().map(|r| (r.coin.amount, r.confirmed_block_index, r.spent)).collect::<Vec<_>>(),
            vec![(4, 80, true), (3, 95, false)],
            "the changes past 92: the spend of coin 4 and the new coin 3"
        );
        assert!(!rest.truncated && rest.next_cursor.is_none());
        assert_eq!(lane.live_count().await, 2, "two honest peers, both kept");
    }

    #[tokio::test]
    async fn a_cursor_goes_out_only_when_every_peer_shows_its_header() {
        // B cuts its page at 92 on another fork: same coins, another header
        // there. A, asked for the header at 92, shows the real one, so the
        // pair disagrees now rather than handing out a cursor A would reject
        // as a reorg one request later.
        let history = vec![state(1, 90, None), state(2, 80, Some(85)), state(3, 95, None)];
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), paged(history.clone(), None, None)).await;
        let fork = Bytes32::new([0xAB; 32]);
        let b = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), paged(history, Some(92), Some(fork))).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let err = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap_err();
        assert!(err.to_string().contains("disagree"), "{err}");
        assert!(a.seen.lock().unwrap().contains(&chia_protocol::ProtocolMessageTypes::RequestBlockHeader), "A was asked for the header at 92");
        assert_eq!(lane.live_count().await, 0, "both public peers let go");
    }

    #[tokio::test]
    async fn a_coin_only_the_peer_ahead_has_seen_leaves_the_lookup_incomplete() {
        // A stands at 100 and lists the coin created there; B stands at 99
        // and has never seen it. Taken as of 99 both answers are empty, but
        // the lookup is cut short rather than complete, so the wallet lease
        // keeps a spend of that coin parked instead of taking the coin for gone.
        let a = full_node(vec![state(7, 100, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![], (1, None), Some(peak_at(99))).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let got = money.coin_records_by_names(vec![coin(7).coin_id()], true, None).await.unwrap();
        assert!(got.records.is_empty(), "nothing both peers have seen");
        assert!(got.truncated && got.next_cursor.is_none(), "incomplete, not complete-and-absent");
        assert_eq!(lane.live_count().await, 2, "neither peer is at fault");
    }

    #[tokio::test]
    async fn a_peak_that_moves_during_a_lookup_dates_it_again_or_leaves_it_unanswered() {
        // A announces a new peak together with its first coin-state answer:
        // read after the answer, that peak would date states computed a block
        // earlier a block late. The lookup is asked again and dated by a peak
        // that stood still; a peer whose peak moves on every try is reported
        // unanswered rather than judged.
        let bump = |every: bool| -> Handler {
            let base = node(vec![state(1, 90, None)], (1, None), vec![]);
            let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
            Arc::new(move |m: &Message| {
                let mut out = Vec::new();
                if m.msg_type == chia_protocol::ProtocolMessageTypes::RequestCoinState {
                    let n = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if every || n == 0 {
                        let height = 101 + n;
                        out.push(reply(&NewPeakWallet::new(header_at(height, genesis()).header_hash(), height, 0, 0)));
                    }
                }
                out.extend(base(m));
                out
            })
        };
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), bump(false)).await;
        let b = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let settled_lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(settled_lane.clone(), Trust::Agreed);
        let got = money.coin_records_by_names(vec![coin(1).coin_id()], true, None).await.unwrap();
        assert_eq!(got.records.len(), 1);
        let asked = a.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestCoinState).count();
        assert_eq!(asked, 2, "asked again once the peak had moved");
        assert_eq!(settled_lane.live_count().await, 2);

        let restless = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), bump(true)).await;
        let d = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let restless_lane = lane(vec![(restless.addr, Source::Introducer), (d.addr, Source::Gossip)], vec![], false, None);
        let restless_money = PeerLane::new(restless_lane.clone(), Trust::Agreed);
        let err = restless_money.coin_records_by_names(vec![coin(1).coin_id()], true, None).await.unwrap_err();
        assert!(err.to_string().contains("moved"), "{err}");
        let asked = restless.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestCoinState).count();
        assert_eq!(asked, PEAK_SETTLE_ATTEMPTS, "every try was spent");
    }

    #[test]
    fn pages_are_judged_over_the_changes_both_peers_have_reached() {
        let hash = |h: u32| header_at(h, genesis()).header_hash();
        let page = |states: Vec<CoinState>, height: u32, finished: bool, knowledge: u32| Page {
            states,
            height,
            header_hash: hash(height),
            finished,
            knowledge,
            since: None,
            pending: vec![],
        };
        let amounts = |l: &CoinListing| l.records.iter().map(|r| (r.coin.amount, r.spent)).collect::<Vec<_>>();
        // One peer a block ahead sees a spend the other does not yet: taken as
        // of 100 both agree, and the listing is complete.
        let behind = page(vec![state(1, 90, None), state(2, 80, None)], 100, true, 100);
        let ahead = page(vec![state(1, 90, None), state(2, 80, Some(101))], 101, true, 101);
        let settled = settle_pages(&[behind.clone(), ahead], true, None).unwrap();
        assert_eq!(amounts(&settled.listing), vec![(2, false), (1, false)]);
        assert!(!settled.listing.truncated && settled.listing.next_cursor.is_none());
        // A coin only the peer ahead has seen: the listing is cut short, not complete without it.
        let newer = page(vec![state(1, 90, None), state(2, 80, None), state(3, 101, None)], 101, true, 101);
        let settled = settle_pages(&[behind.clone(), newer], true, None).unwrap();
        assert_eq!(amounts(&settled.listing), vec![(2, false), (1, false)]);
        assert!(settled.listing.truncated && settled.listing.next_cursor.is_none(), "incomplete, no cursor");
        // A page cut at 92 by a peer that knows the whole history (coin 4 was
        // spent at 95, so its latest change is past the cut and it is not on
        // the page) against a finished page through 100: the changes up to 92
        // agree, the listing continues from 92, and the finished peer must
        // show the header there before the cursor goes out.
        let whole = page(vec![state(1, 90, None), state(2, 80, Some(85)), state(3, 95, None), state(4, 80, Some(95))], 100, true, 100);
        let cut = page(vec![state(1, 90, None), state(2, 80, Some(85))], 92, false, 100);
        let settled = settle_pages(&[whole.clone(), cut.clone()], true, None).unwrap();
        assert_eq!(amounts(&settled.listing), vec![(2, true), (1, false)]);
        assert!(settled.listing.truncated);
        assert_eq!(settled.cursor_at, Some((92, hash(92))));
        assert_eq!(settled.unverified, vec![0], "the finished peer stands above 92");
        // The same cut by a peer whose view stopped at 93, before the spend:
        // it lists coin 4 unspent, and the whole page, taken as of 93, agrees.
        let lagging_cut = page(vec![state(1, 90, None), state(2, 80, Some(85)), state(4, 80, None)], 92, false, 93);
        let settled = settle_pages(&[whole.clone(), lagging_cut], true, None).unwrap();
        let mut got: Vec<u64> = settled.listing.records.iter().map(|r| r.coin.amount).collect();
        got.sort_unstable();
        assert_eq!(got, vec![1, 2, 4]);
        // Two pages cut at 92 naming different headers there: no verdict.
        let fork = Page { header_hash: Bytes32::new([0xAB; 32]), ..cut.clone() };
        assert!(settle_pages(&[cut.clone(), fork], true, None).is_none());
        // A real difference below the common height is still no verdict.
        let other = page(vec![state(1, 90, None), state(2, 81, None)], 100, true, 100);
        assert!(settle_pages(&[behind, other], true, None).is_none());
        // Coin-state lookups: a coin created above the lower peak is hidden, so the lookup is cut short.
        let seen = page(vec![state(7, 100, None)], 100, true, 100);
        let unseen = page(vec![], 99, true, 99);
        let states = settle_states(&[seen, unseen], true).unwrap();
        assert!(states.records.is_empty() && states.truncated && states.next_cursor.is_none());
        // A continuation after 92 judged with a peer a block behind: the peer
        // at 100 lists coin 5 (created at 90, spent at 100); the peer at 99
        // does not, the latest change it knows of (90) lying before the start.
        // Taken as of 99 the spend is undone and the coin falls back before
        // 92, where an earlier page told of it: left out, the pages agree.
        let ahead = Page { since: Some(92), ..page(vec![state(5, 90, Some(100))], 100, true, 100) };
        let behind_too = Page { since: Some(92), ..page(vec![], 99, true, 99) };
        let settled = settle_pages(&[ahead, behind_too], true, None).unwrap();
        assert!(settled.listing.records.is_empty() && !settled.listing.truncated, "nothing changed in (92, 99]");
        // The peer ahead cut its page at 92 and keeps coin 6, spent at 100 on
        // its chain, for a later page; the peer behind, finished at 99, lists
        // it unspent. Unknown on the cut page, not absent: left out, the
        // listing cut short with no cursor, and no verdict against either.
        let finished_behind = page(vec![state(6, 80, None)], 99, true, 99);
        let cut_ahead = page(vec![], 92, false, 100);
        let settled = settle_pages(&[finished_behind.clone(), cut_ahead], true, None).unwrap();
        assert!(settled.listing.records.is_empty() && settled.listing.truncated && settled.listing.next_cursor.is_none());
        // The same cut page from a peer that knows no more than the other:
        // the coin would be on it, so its absence is a disagreement.
        let cut_level = page(vec![], 92, false, 99);
        assert!(settle_pages(&[finished_behind, cut_level], true, None).is_none());
        // Coin-state lookups: a coin a capped lookup never got to is unknown
        // there and the lookup is cut short, not disagreed; a finished lookup
        // that lacks it disagrees.
        let all = page(vec![state(1, 90, None), state(2, 80, None)], 100, true, 100);
        let capped = Page { pending: vec![coin(2).coin_id()], ..page(vec![state(1, 90, None)], 100, false, 100) };
        let states = settle_states(&[all.clone(), capped], true).unwrap();
        assert_eq!(amounts(&states), vec![(1, false)]);
        assert!(states.truncated);
        let short = page(vec![state(1, 90, None)], 100, true, 100);
        assert!(settle_states(&[all, short], true).is_none());
    }

    #[tokio::test]
    async fn a_continuation_judged_with_a_peer_a_block_behind_leaves_out_what_an_earlier_page_told() {
        // From the cursor at 92: A, at 100, lists coin 5 (created at 90, spent
        // at 100); B, at 99, has nothing to say, the coin's latest change it
        // knows of (90) lying before the start. Taken as of 99 the spend is
        // undone and the coin falls back before 92, so the pages agree on an
        // empty continuation and both peers stay.
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), paged(vec![state(5, 90, Some(100))], None, None)).await;
        let b = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(99)), paged_to(vec![state(5, 90, None)], 99, None, None)).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let cursor = encode_cursor(92, header_at(92, genesis()).header_hash());
        let rest = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, Some(cursor)).await.unwrap();
        assert!(rest.records.is_empty(), "{:?}", rest.records);
        assert!(!rest.truncated && rest.next_cursor.is_none());
        assert_eq!(lane.live_count().await, 2, "both honest peers kept");
    }

    #[tokio::test]
    async fn a_coin_the_peer_ahead_keeps_for_a_later_page_is_unknown_not_absent() {
        // A, finished at 99, lists coin 6 unspent. B, at 100, saw it spent
        // there and cuts its first page at 92, so the coin is not on it: B
        // keeps it for the page after. Neither peer is wrong; the coin is
        // unknown on B's page, the listing comes back cut short with no
        // cursor, and both peers stay.
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(99)), paged_to(vec![state(6, 80, None)], 99, None, None)).await;
        let b = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), paged(vec![state(6, 80, Some(100))], Some(92), None)).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let got = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap();
        assert!(got.records.is_empty(), "{:?}", got.records);
        assert!(got.truncated && got.next_cursor.is_none(), "incomplete, no cursor");
        assert_eq!(lane.live_count().await, 2, "no verdict against either peer");
    }

    #[tokio::test]
    async fn a_capped_coin_state_lookup_leaves_the_rest_unknown_not_disagreed() {
        // Nine coins asked for: A answers for all nine at once; B answers for
        // one id per request and runs out of rounds with one to go. The ninth
        // is unknown on B's side, not absent: the eight both answered for come
        // back, the lookup is cut short, and nobody is evicted.
        let history: Vec<CoinState> = (1u8..=9).map(|n| state(n, 50 + u32::from(n), None)).collect();
        let a = full_node(history.clone(), (1, None), Some(peak_at(100))).await;
        let b = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), capped(history.clone(), 1)).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let names: Vec<Bytes32> = history.iter().map(|s| s.coin.coin_id()).collect();
        let got = money.coin_records_by_names(names, true, None).await.unwrap();
        assert_eq!(got.records.len(), STATE_ROUNDS, "one id per round");
        assert!(got.truncated && got.next_cursor.is_none());
        assert_eq!(lane.live_count().await, 2);
    }

    #[tokio::test]
    async fn a_peak_renamed_at_the_same_height_during_a_lookup_is_asked_again() {
        // A's first answer comes with a new peak at the SAME height on another
        // header: a same-height reorg between the two readings. Height alone
        // would pass it; the lookup is asked again and dated by a peak that
        // stood still, header and all. The same for a listing page cut at its
        // item limit.
        let renamed = |kind: chia_protocol::ProtocolMessageTypes, base: Handler| -> Handler {
            let calls = Arc::new(std::sync::atomic::AtomicU32::new(0));
            Arc::new(move |m: &Message| {
                let mut out = Vec::new();
                if m.msg_type == kind && calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    out.push(reply(&NewPeakWallet::new(Bytes32::new([0xAB; 32]), 100, 0, 0)));
                }
                out.extend(base(m));
                out
            })
        };
        let one = vec![state(1, 90, None)];
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), renamed(chia_protocol::ProtocolMessageTypes::RequestCoinState, node(one.clone(), (1, None), vec![]))).await;
        let b = full_node(one, (1, None), Some(peak_at(100))).await;
        let lane_ab = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane_ab.clone(), Trust::Agreed);
        let got = money.coin_records_by_names(vec![coin(1).coin_id()], true, None).await.unwrap();
        assert_eq!(got.records.len(), 1);
        let asked = a.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestCoinState).count();
        assert_eq!(asked, 2, "asked again once the peak had changed header");
        assert_eq!(lane_ab.live_count().await, 2);

        let history = vec![state(1, 90, None), state(2, 80, Some(85)), state(3, 95, None)];
        let c = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), renamed(chia_protocol::ProtocolMessageTypes::RequestPuzzleState, paged(history.clone(), Some(92), None))).await;
        let d = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), paged(history, None, None)).await;
        let lane_cd = lane(vec![(c.addr, Source::Introducer), (d.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane_cd.clone(), Trust::Agreed);
        let first = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap();
        assert!(first.truncated && first.next_cursor.is_some());
        let asked = c.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestPuzzleState).count();
        assert_eq!(asked, 2, "the cut page was asked for again");
        assert_eq!(lane_cd.live_count().await, 2);
    }

    #[tokio::test]
    async fn the_introducer_naming_every_pooled_peer_promotes_no_more_than_the_cap() {
        // A warm start after a failed introducer lookup: three stored peers
        // and one gossiped fill the pool, none fresh, so no pair forms. The
        // introducer then names all four. Were all four relabelled, the pool
        // would hold one source only and no swap could pair it; the cap holds
        // for promotions as for dials, one connection keeps its source, and
        // the next request is answered.
        let mut nodes = Vec::new();
        for _ in 0..4 {
            nodes.push(full_node(vec![state(4, 50, None)], (1, None), Some(peak_at(100))).await);
        }
        let seeds = vec![(nodes[0].addr, Source::Store), (nodes[1].addr, Source::Store), (nodes[2].addr, Source::Store), (nodes[3].addr, Source::Gossip)];
        let lane = lane(seeds, vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert!(money.coin_records_by_names(vec![coin(4).coin_id()], true, None).await.is_err(), "no fresh peer: no pair");
        assert_eq!(lane.live_count().await, 4, "the four connected all the same");
        {
            let mut state = lane.state.lock().await;
            let named = nodes.iter().map(|n| Candidate { addr: n.addr, source: Source::Introducer, failures: 0 }).collect();
            push_candidates(&mut state, named);
        }
        let conns = lane.live_conns().await;
        assert_eq!(conns.iter().filter(|p| p.source() == Source::Introducer).count(), PER_SOURCE_CAP, "promoted up to the cap");
        assert_eq!(conns.iter().filter(|p| p.source() != Source::Introducer).count(), 1, "one keeps its source");
        let got = money.coin_records_by_names(vec![coin(4).coin_id()], true, None).await.unwrap();
        assert_eq!(got.records.len(), 1);
    }

    #[test]
    fn a_candidate_the_pool_is_full_against_does_not_count_as_ready() {
        // Four connections and a candidate all in one /16: no swap completes
        // a pair, so nothing queued can be tried and the introducer is due.
        let g = |a: &str| group_of(a.parse().unwrap());
        let one = g("203.0.113.1:58444");
        let full = vec![(Source::Introducer, one, true), (Source::Introducer, one, true), (Source::Introducer, one, true), (Source::Gossip, one, true)];
        assert!(!tryable(&full, (Source::Introducer, one), false, false), "same group: the swap would not pair");
        assert!(tryable(&full, (Source::Introducer, g("198.51.100.1:58444")), false, false), "another group: swapped in, it pairs with the gossiped peer");
        // With room, the source cap decides; a rotation counts as room for an introducer peer.
        let three = vec![(Source::Introducer, one, true); 3];
        assert!(tryable(&three, (Source::Introducer, one), false, false), "an introducer peer asked for gossip can rotate out");
        assert!(tryable(&three, (Source::Gossip, one), false, false), "a gossiped peer has the free place");
        let unasked = vec![(Source::Introducer, one, false); 3];
        assert!(!tryable(&unasked, (Source::Introducer, one), false, false), "nothing to rotate yet");
        let stored = vec![(Source::Store, one, true); 3];
        assert!(!tryable(&stored, (Source::Store, one), false, false), "no rotation among stored peers: only the introducer brings a fresh one");
    }

    #[tokio::test]
    async fn public_peers_displaced_for_a_pin_retry_are_queued_again() {
        // One live pin, two pins that do not answer, three public peers: the
        // retry of the two dead pins makes room for them and fails. The two
        // public peers it displaced are queued again, and when the last
        // public peer is gone they are the ones that give the pin its pair.
        let live = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let (dead1, dead2) = (closed().await, closed().await);
        let a = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let c = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let seeds = vec![(a.addr, Source::Introducer), (b.addr, Source::Introducer), (c.addr, Source::Introducer)];
        let lane = lane(seeds, vec![live.addr.to_string(), dead1.to_string(), dead2.to_string()], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert_eq!(money.peak_height().await.unwrap(), 100);
        assert_eq!(lane.live_count().await, 4, "the pin and three public peers");
        lane.expire_pin_cooldown().await;
        assert_eq!(money.peak_height().await.unwrap(), 100, "the pin retry fails; the pair stands");
        let conns = lane.live_conns().await;
        assert_eq!(conns.len(), 2, "two public peers made room for the two pin dials");
        let displaced: Vec<SocketAddr> = [a.addr, b.addr, c.addr].into_iter().filter(|x| !conns.iter().any(|p| p.addr() == *x)).collect();
        assert_eq!(displaced.len(), 2);
        {
            let state = lane.state.lock().await;
            for addr in &displaced {
                assert!(state.candidates.iter().any(|q| q.addr == *addr), "{addr} is queued again");
                assert!(state.cooling.contains_key(addr), "{addr} cools before it is dialled again");
            }
        }
        // The remaining public peer goes; the displaced ones are what is left to pair with.
        let last = conns.into_iter().find(|p| p.source() != Source::Pin).unwrap();
        lane.drop_conn(&last).await;
        lane.expire_pin_cooldown().await;
        assert_eq!(money.peak_height().await.unwrap(), 100);
        let conns = lane.live_conns().await;
        assert!(conns.iter().any(|p| displaced.contains(&p.addr())), "a displaced peer is back in the pool");
    }

    #[tokio::test]
    async fn a_public_peer_lagging_the_furthest_peak_is_let_go_before_an_agreed_listing() {
        let behind = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let ahead = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100 + MAX_PEAK_LAG + 1))).await;
        let lane = lane(vec![(behind.addr, Source::Introducer), (ahead.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let err = money.coin_records_by_names(vec![coin(1).coin_id()], true, None).await.unwrap_err();
        assert!(err.to_string().contains("lags"), "{err}");
        let conns = lane.live_conns().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].addr(), ahead.addr, "the lagging peer was let go, the current one kept");
    }

    #[tokio::test]
    async fn an_inflated_peak_from_a_third_peer_evicts_nobody() {
        // Two honest peers agree at 100; a third announces a height far above.
        // One peer's word is no reference: the honest pair stays and settles.
        let a = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let liar = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100 + MAX_PEAK_LAG + 1))).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip), (liar.addr, Source::Store)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert_eq!(money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(), 1);
        let conns = lane.live_conns().await;
        assert!(conns.iter().any(|c| c.addr() == a.addr) && conns.iter().any(|c| c.addr() == b.addr), "both honest peers stay");
    }

    #[tokio::test]
    async fn a_cooling_introducer_candidate_does_not_block_the_next_lookup() {
        // The introducer's earlier answer named only a dead address, cooling in
        // the queue; its interval has passed, and "127.0.0.1" (standing in for
        // the introducer) now names a live replacement.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        let fresh = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let net = Network { introducers: vec!["127.0.0.1".to_string()], port: fresh.addr.port(), ..net() };
        let lane = Arc::new(
            Lane::new(net, vec![], false, None)
                .with_candidates(vec![(closed, Source::Introducer), (b.addr, Source::Gossip)])
                .with_tls(TLS.clone()),
        );
        {
            let mut state = lane.state.lock().await;
            state.cooling.insert(closed, Instant::now() + RETRY_AFTER);
            state.introduce_after = Some(Instant::now());
        }
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert_eq!(money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(), 1);
        let conns = lane.live_conns().await;
        assert!(conns.iter().any(|c| c.addr() == fresh.addr && c.source() == Source::Introducer), "the replacement the lookup named was dialled");
    }

    #[tokio::test]
    async fn a_stale_peak_is_checked_against_the_chain_before_it_counts() {
        // The default mock serves any header: asked for the block above its
        // announced peak it answers, so the announcement was stale.
        let moved = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let lane_m = lane(vec![(moved.addr, Source::Introducer)], vec![], false, None);
        let carrier = PeerLane::new(lane_m.clone(), Trust::Carrier);
        assert_eq!(carrier.peak_height().await.unwrap(), 100);
        for conn in lane_m.live_conns().await {
            conn.mark_peak_stale();
        }
        let err = carrier.peak_height().await.unwrap_err();
        assert!(err.to_string().contains("stale"), "{err}");
        assert_eq!(lane_m.live_count().await, 0, "the stalled connection is let go");

        // A quiet chain: no block above the peak, so the announcement is fresh again.
        let quiet_handler: Handler = Arc::new(|m: &Message| match m.msg_type {
            chia_protocol::ProtocolMessageTypes::RequestBlockHeader => {
                let req = RequestBlockHeader::from_bytes(&m.data).unwrap();
                if req.height > 100 {
                    vec![reply(&RejectHeaderRequest::new(req.height))]
                } else {
                    vec![reply(&RespondBlockHeader::new(header_at(req.height, genesis())))]
                }
            }
            _ => vec![],
        });
        let quiet = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), quiet_handler).await;
        let lane_q = lane(vec![(quiet.addr, Source::Introducer)], vec![], false, None);
        let carrier_q = PeerLane::new(lane_q.clone(), Trust::Carrier);
        assert_eq!(carrier_q.peak_height().await.unwrap(), 100);
        for conn in lane_q.live_conns().await {
            conn.mark_peak_stale();
        }
        assert_eq!(carrier_q.peak_height().await.unwrap(), 100, "a quiet chain keeps its peak");
        let conns = lane_q.live_conns().await;
        assert_eq!(conns.len(), 1);
        assert!(conns[0].peak_age().is_some_and(|age| age < PEAK_STALE), "the announcement counts as fresh again");
    }

    #[tokio::test]
    async fn an_unreachable_pin_is_dialled_again_once_its_cooldown_passes() {
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        let public = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let lane = lane(vec![(public.addr, Source::Introducer)], vec![closed.to_string()], false, None);
        let carrier = PeerLane::new(lane.clone(), Trust::Carrier);
        assert_eq!(carrier.peak_height().await.unwrap(), 100, "the carrier reads from the public peer while the pin is down");
        // The pin comes up on its address. Until its cooldown passes the public
        // connection keeps serving and the pin is left alone...
        let pin = crate::chia_peer::mock::spawn_on(closed, "mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), node(vec![], (1, None), vec![])).await;
        assert_eq!(carrier.peak_height().await.unwrap(), 100);
        assert!(!pin.seen.lock().unwrap().contains(&chia_protocol::ProtocolMessageTypes::Handshake), "not dialled while cooling down");
        // ...and once it has, the pin is dialled before the public peer is used again.
        lane.expire_pin_cooldown().await;
        assert_eq!(carrier.peak_height().await.unwrap(), 100);
        assert!(pin.seen.lock().unwrap().contains(&chia_protocol::ProtocolMessageTypes::Handshake), "the recovered pin was dialled");
        assert!(lane.live_conns().await.iter().any(|c| c.source() == Source::Pin));
    }

    #[tokio::test]
    async fn an_incremental_listing_starts_at_the_block_before_the_minimum() {
        let starts: Arc<Mutex<Vec<Option<u32>>>> = Arc::new(Mutex::new(vec![]));
        let seen_starts = starts.clone();
        let handler: Handler = Arc::new(move |m: &Message| match m.msg_type {
            chia_protocol::ProtocolMessageTypes::RequestPuzzleState => {
                let req = RequestPuzzleState::from_bytes(&m.data).unwrap();
                seen_starts.lock().unwrap().push(req.previous_height);
                vec![reply(&RespondPuzzleState::new(
                    req.puzzle_hashes,
                    100,
                    header_at(100, genesis()).header_hash(),
                    true,
                    vec![state(1, 90, None)],
                ))]
            }
            chia_protocol::ProtocolMessageTypes::RequestBlockHeader => {
                let req = RequestBlockHeader::from_bytes(&m.data).unwrap();
                vec![reply(&RespondBlockHeader::new(header_at(req.height, genesis())))]
            }
            _ => vec![],
        });
        let n = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), handler).await;
        let carrier = PeerLane::new(lane(vec![(n.addr, Source::Introducer)], vec![], false, None), Trust::Carrier);
        let hint = Bytes32::new([9u8; 32]);
        assert_eq!(carrier.coin_records_by_hint(hint, Some(85), true, None).await.unwrap().records.len(), 1);
        assert_eq!(carrier.coin_records_by_hint(hint, None, true, None).await.unwrap().records.len(), 1);
        assert_eq!(carrier.coin_records_by_hint(hint, Some(0), true, None).await.unwrap().records.len(), 1);
        assert_eq!(
            *starts.lock().unwrap(),
            vec![Some(84), None, None],
            "from height 85 the request names block 84; no minimum, or 0, starts at genesis"
        );
    }

    #[test]
    fn a_full_pool_makes_room_for_the_candidate_that_completes_a_pair() {
        use Source::{Gossip as G, Introducer as I, Pin as P, Store as S};
        // Distinct IPv4 /16s.
        let g = |n: u8| group_of(SocketAddr::from(([10, n, 0, 1], 58444)));
        // Three introducer peers and a gossip peer in one /16: a gossip peer
        // from another /16 completes a pair once a redundant introducer goes.
        let one_group = [(I, g(1)), (I, g(1)), (I, g(1)), (G, g(1))];
        assert_eq!(replaceable(&one_group, (G, g(2)), false, false), Some(2), "the newest redundant introducer");
        assert_eq!(replaceable(&one_group, (I, g(2)), false, false), Some(2), "an introducer from another group pairs with the gossip peer");
        assert_eq!(replaceable(&one_group, (G, g(1)), false, false), None, "the same group helps nobody");
        // A pin and three introducer peers in its /16: room for one elsewhere.
        let pinned = [(P, g(1)), (I, g(1)), (I, g(1)), (I, g(1))];
        assert_eq!(replaceable(&pinned, (I, g(2)), true, false), Some(3));
        assert_eq!(replaceable(&pinned, (S, g(1)), true, false), None);
        // Every source once, all in one group: the newest public peer goes.
        let spread = [(P, g(1)), (I, g(1)), (G, g(1)), (S, g(1))];
        assert_eq!(replaceable(&spread, (G, g(2)), true, false), Some(3));
        // Pins are never the ones let go.
        assert_eq!(replaceable(&[(P, g(1)), (P, g(2))], (I, g(3)), true, false), None);
    }

    #[tokio::test]
    async fn pins_behind_unreachable_addresses_are_still_reached() {
        let mut pins = Vec::new();
        for _ in 0..3 {
            pins.push(tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().to_string());
        }
        let healthy = full_node(vec![], (1, None), Some(peak_at(100))).await;
        pins.push(healthy.addr.to_string());
        let public = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let mixed = lane(vec![(public.addr, Source::Introducer)], pins.clone(), false, None);
        assert_eq!(PeerLane::new(mixed.clone(), Trust::Agreed).peak_height().await.unwrap(), 100, "the fourth pin address is reached in the same call");
        assert_eq!(mixed.live_conns().await.iter().filter(|c| c.source() == Source::Pin).count(), 1);
        // Pin-only mode with the reachable address fifth in the list.
        let mut five = pins;
        five.insert(0, tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap().to_string());
        let only = lane(vec![], five, true, None);
        assert_eq!(PeerLane::new(only.clone(), Trust::Agreed).peak_height().await.unwrap(), 100);
        assert_eq!(only.live_conns().await.len(), 1);
    }

    #[tokio::test]
    async fn peers_that_drop_out_are_dialled_again_after_a_cooldown() {
        // Two peers answer, then their connections die, as in a brief outage.
        // With nothing left to discover the lane still finds them again once
        // the cooldown passes, because dropped peers return to the queue.
        let a = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let lane = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert_eq!(money.peak_height().await.unwrap(), 100);
        for conn in lane.live_conns().await {
            conn.close().await;
        }
        let err = money.peak_height().await.unwrap_err();
        assert!(err.to_string().contains("fewer than two"), "{err}");
        {
            let state = lane.state.lock().await;
            assert_eq!(state.candidates.len(), 2, "both peers are queued again");
            assert!(state.candidates.iter().all(|c| state.cooling.contains_key(&c.addr)), "and cooling");
        }
        lane.expire_pin_cooldown().await;
        assert_eq!(money.peak_height().await.unwrap(), 100, "dialled again once the cooldown passed");
        assert_eq!(lane.live_conns().await.len(), 2);
    }

    #[tokio::test]
    async fn a_peer_that_refused_the_dial_keeps_its_place_in_the_queue() {
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
        let b = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let lane = lane(vec![(closed, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert!(money.peak_height().await.is_err());
        assert!(lane.state.lock().await.candidates.iter().any(|c| c.addr == closed), "the failed dial keeps its place");
        let _late = crate::chia_peer::mock::spawn_on(closed, "mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), node(vec![], (1, None), vec![])).await;
        lane.expire_pin_cooldown().await;
        assert_eq!(money.peak_height().await.unwrap(), 100, "dialled again once it came up");
    }

    #[test]
    fn only_a_final_refusal_kills_a_spend() {
        assert!(refusal_is_final("203.0.113.5:58444: DOUBLE_SPEND"));
        assert!(refusal_is_final("x: ASSERT_MY_COIN_ID_FAILED"));
        assert!(refusal_is_final("x: ASSERT_COIN_ANNOUNCEMENT_FAILED"));
        assert!(refusal_is_final("x: ASSERT_BEFORE_HEIGHT_ABSOLUTE_FAILED"), "a 'before' timelock that failed is past for good");
        assert!(refusal_is_final("x: BAD_AGGREGATE_SIGNATURE"));
        assert!(!refusal_is_final("x: ASSERT_HEIGHT_RELATIVE_FAILED"), "a timelock can still pass");
        assert!(!refusal_is_final("x: ASSERT_SECONDS_ABSOLUTE_FAILED"));
        assert!(!refusal_is_final("x: INVALID_FEE_TOO_CLOSE_TO_ZERO"));
        assert!(!refusal_is_final("x: ALREADY_INCLUDING_TRANSACTION"));
        assert!(!refusal_is_final("x: MEMPOOL_CONFLICT"));
        assert!(!refusal_is_final("x: status 3"));
    }

    #[test]
    fn candidates_are_kept_under_one_spelling() {
        let mut state = LaneState::default();
        let native: SocketAddr = "203.0.113.5:58444".parse().unwrap();
        let mapped: SocketAddr = "[::ffff:203.0.113.5]:58444".parse().unwrap();
        push_candidates(&mut state, vec![Candidate { addr: mapped, source: Source::Gossip, failures: 0 }]);
        push_candidates(&mut state, vec![Candidate { addr: native, source: Source::Introducer, failures: 0 }]);
        assert_eq!(state.candidates.len(), 1, "the mapped spelling and the native one are one address");
        assert_eq!(state.candidates[0].addr, native);
    }

    #[tokio::test]
    async fn four_reachable_pins_leave_a_place_for_the_public_peer() {
        let mut pins = Vec::new();
        let mut nodes = Vec::new();
        for _ in 0..4 {
            let node = full_node(vec![], (1, None), Some(peak_at(100))).await;
            pins.push(node.addr.to_string());
            nodes.push(node);
        }
        let public = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let lane = lane(vec![(public.addr, Source::Introducer)], pins, false, None);
        assert_eq!(PeerLane::new(lane.clone(), Trust::Agreed).peak_height().await.unwrap(), 100);
        let conns = lane.live_conns().await;
        assert!(conns.len() <= MAX_CONNS);
        assert_eq!(conns.iter().filter(|c| c.source() == Source::Pin).count(), MAX_CONNS - 1, "one place is kept for a public peer");
        assert!(conns.iter().any(|c| c.addr() == public.addr), "and the public peer took it");
    }

    #[tokio::test]
    async fn a_warm_start_dials_the_store_first_and_asks_the_introducer_only_for_a_fresh_peer() {
        // The store knows A and B; "127.0.0.1" stands in for the introducer and
        // names A again (the network's port is A's). A presence read is served
        // from the store without a lookup; a money read needs a fresh peer, so
        // the introducer is asked, and A, named this run, counts as fresh
        // although the store queued it first.
        let a = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let store = temp_store("warm");
        let now = unix_now();
        let known = vec![StoredPeer { addr: a.addr.to_string(), last_ok: now }, StoredPeer { addr: b.addr.to_string(), last_ok: now }];
        write_store(&store, &StoreFile { v: 1, peers: known }).unwrap();
        let net = Network { introducers: vec!["127.0.0.1".to_string()], port: a.addr.port(), ..net() };
        let lane = Arc::new(Lane::new(net, vec![], false, Some(store)).with_tls(TLS.clone()));

        assert_eq!(PeerLane::new(lane.clone(), Trust::Carrier).peak_height().await.unwrap(), 100);
        assert!(lane.state.lock().await.introduce_after.is_none(), "the store served the presence read; the introducer was not asked");

        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        assert_eq!(money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(), 1);
        assert!(lane.state.lock().await.introduce_after.is_some(), "a money read without a pin needs a fresh peer: the introducer was asked");
        let conns = lane.live_conns().await;
        let source_of = |addr: SocketAddr| conns.iter().find(|c| c.addr() == addr).map(|c| c.source());
        assert_eq!(source_of(a.addr), Some(Source::Introducer), "named by the introducer this run, A counts as fresh");
        assert_eq!(source_of(b.addr), Some(Source::Store));
    }

    #[tokio::test]
    async fn a_pin_and_a_stored_peer_settle_a_money_read_without_the_introducer() {
        let pin = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let stored = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let store = temp_store("pinned-warm");
        write_store(&store, &StoreFile { v: 1, peers: vec![StoredPeer { addr: stored.addr.to_string(), last_ok: unix_now() }] }).unwrap();
        // Port 1 is nobody's: an introducer answer would be dialled and fail,
        // and the lookup would leave its mark on `introduce_after`.
        let net = Network { introducers: vec!["127.0.0.1".to_string()], port: 1, ..net() };
        let lane = Arc::new(Lane::new(net, vec![pin.addr.to_string()], false, Some(store)).with_tls(TLS.clone()));
        assert_eq!(PeerLane::new(lane.clone(), Trust::Agreed).peak_height().await.unwrap(), 100);
        assert!(lane.state.lock().await.introduce_after.is_none(), "the pin and the stored peer agreed; the introducer was not asked");
    }

    #[test]
    fn a_queued_stored_candidate_the_introducer_names_becomes_fresh() {
        let mut state = LaneState::default();
        let addr: SocketAddr = "203.0.113.5:58444".parse().unwrap();
        push_candidates(&mut state, vec![Candidate { addr, source: Source::Store, failures: 0 }]);
        push_candidates(&mut state, vec![Candidate { addr, source: Source::Introducer, failures: 0 }]);
        assert_eq!(state.candidates.len(), 1, "one address, one vote");
        assert_eq!(state.candidates[0].source, Source::Introducer);
        // Nothing moves away from fresh: a later gossiped mention changes nothing.
        push_candidates(&mut state, vec![Candidate { addr, source: Source::Gossip, failures: 0 }]);
        assert_eq!(state.candidates.len(), 1);
        assert_eq!(state.candidates[0].source, Source::Introducer);
    }

    #[test]
    fn verdicts_on_acks_without_a_socket() {
        let failed = || AckOutcome::Failed("x: INVALID_FEE_TOO_CLOSE_TO_ZERO".to_string());
        let dead = || AckOutcome::Failed("x: DOUBLE_SPEND".to_string());
        let silent = || AckOutcome::Silent("y: timed out".to_string());
        assert!(push_verdict(&[AckOutcome::Accepted, silent()]).is_ok());
        assert!(matches!(push_verdict(&[failed(), failed()]), Err(ChainError::Refused(w)) if w.contains("INVALID_FEE")));
        assert!(matches!(push_verdict(&[failed(), silent()]), Err(ChainError::Unanswered(_))));
        assert_eq!(live_verdict(&[AckOutcome::Accepted, failed()]).unwrap(), true);
        assert_eq!(live_verdict(&[dead(), dead()]).unwrap(), false);
        assert!(live_verdict(&[failed(), dead()]).is_err(), "a final refusal from one peer alone does not settle it");
        assert!(live_verdict(&[dead(), silent()]).is_err());
        assert!(live_verdict(&[failed(), failed()]).is_err(), "policy refusals alone leave the spend parked");
        assert!(live_verdict(&[failed(), silent()]).is_err());
        assert!(live_verdict(&[silent()]).is_err());
    }

    #[test]
    fn the_agreed_pair_needs_distinct_sources_and_groups_and_one_fresh_peer() {
        let g = |n: u16| group_of(SocketAddr::from(([127, 0, 0, 1], n)));
        // Two introducer peers: one source, no verdict.
        assert_eq!(pick_agreed(&[(Source::Introducer, g(1)), (Source::Introducer, g(2))], false, false), None);
        // Introducer + store, different groups: the pair.
        assert_eq!(pick_agreed(&[(Source::Store, g(1)), (Source::Introducer, g(2))], false, false), Some(vec![1, 0]));
        // Same group: no.
        assert_eq!(pick_agreed(&[(Source::Store, g(1)), (Source::Introducer, g(1))], false, false), None);
        // Store + gossip without anything fresh: no.
        assert_eq!(pick_agreed(&[(Source::Store, g(1)), (Source::Gossip, g(2))], false, false), None);
        // Pinned: the pin plus a public peer from another group; pin-only: the pin alone.
        let peers = [(Source::Gossip, g(1)), (Source::Pin, g(2)), (Source::Store, g(2))];
        assert_eq!(pick_agreed(&peers, true, false), Some(vec![1, 0]));
        assert_eq!(pick_agreed(&peers, true, true), Some(vec![1]));
        assert_eq!(pick_agreed(&[(Source::Gossip, g(1)), (Source::Introducer, g(2))], true, false), None, "pinned but the pin is not connected");
        assert_eq!(pick_agreed(&[(Source::Pin, g(2)), (Source::Store, g(2))], true, false), None, "the public peer shares the pin's group");
        // Two pins: the public peer shares the first pin's group, the second pin pairs with it.
        assert_eq!(pick_agreed(&[(Source::Pin, g(1)), (Source::Pin, g(2)), (Source::Introducer, g(1))], true, false), Some(vec![1, 2]));
        assert_eq!(pick_agreed(&[(Source::Pin, g(1)), (Source::Pin, g(2)), (Source::Introducer, g(1))], true, true), Some(vec![0]), "pin-only: the first pin alone");
    }

    #[test]
    fn cursors_round_trip_and_bad_ones_are_refused() {
        let hash = Bytes32::new([0xabu8; 32]);
        let cursor = encode_cursor(4242, hash);
        assert_eq!(decode_cursor(&cursor).unwrap(), (4242, hash));
        for bad in ["", "4242", "x:ab", "4242:abcd", "4242:zz"] {
            assert!(matches!(decode_cursor(bad), Err(ChainError::Refused(_))), "{bad:?}");
        }
    }

    #[test]
    fn records_keep_confirmed_coins_from_the_height_up_in_order_and_once() {
        let states = vec![state(3, 95, None), state(1, 90, None), state(2, 80, Some(85)), CoinState::new(coin(5), None, None), state(1, 90, None)];
        let all = records_from(states.clone(), true, None);
        assert_eq!(all.iter().map(|r| r.coin.amount).collect::<Vec<_>>(), vec![2, 1, 3], "height order, the unconfirmed one out, duplicates once");
        let from_90 = records_from(states.clone(), true, Some(90));
        assert_eq!(from_90.iter().map(|r| r.coin.amount).collect::<Vec<_>>(), vec![1, 3]);
        let unspent = records_from(states, false, None);
        assert_eq!(unspent.iter().map(|r| r.coin.amount).collect::<Vec<_>>(), vec![1, 3]);
    }

    #[tokio::test]
    async fn a_missing_pin_is_dialled_again_while_another_pin_is_live() {
        // Two pins, one down. A money read settles on the live pin and the
        // public peer, but the missing pin is still wanted: it is dialled again
        // once its cooldown passes, not before, although a pin is up (the one
        // that is down may be the pin whose network group a pair needs).
        let first = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let public = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let second_addr = closed().await;
        let pinned = lane(vec![(public.addr, Source::Introducer)], vec![first.addr.to_string(), second_addr.to_string()], false, None);
        let money = PeerLane::new(pinned.clone(), Trust::Agreed);
        let pins_up = |conns: Vec<Arc<PeerConn>>| conns.iter().filter(|c| c.source() == Source::Pin).count();
        assert_eq!(money.peak_height().await.unwrap(), 100);
        assert_eq!(pins_up(pinned.live_conns().await), 1);
        let _second = spawn_on(second_addr, "mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), node(vec![], (1, None), vec![])).await;
        assert_eq!(money.peak_height().await.unwrap(), 100);
        assert_eq!(pins_up(pinned.live_conns().await), 1, "the cooldown holds: a live pin is no reason to hurry");
        pinned.expire_pin_cooldown().await;
        assert_eq!(money.peak_height().await.unwrap(), 100);
        assert_eq!(pins_up(pinned.live_conns().await), 2, "the missing pin is dialled again once the cooldown passes");
    }

    #[tokio::test]
    async fn a_peer_reached_in_the_last_dial_round_is_used() {
        // Dead addresses ahead of one live peer, enough that the live one is
        // dialled only in the last round: the request still uses it rather
        // than reporting nobody reachable with a connection open.
        let live = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let mut seeds = Vec::new();
        for _ in 0..PER_SOURCE_CAP * (MAX_ROUNDS - 1) {
            seeds.push((closed().await, Source::Gossip));
        }
        seeds.push((live.addr, Source::Gossip));
        let queue = lane(seeds, vec![], false, None);
        assert_eq!(PeerLane::new(queue.clone(), Trust::Carrier).peak_height().await.unwrap(), 100);
        assert_eq!(queue.live_conns().await.len(), 1);
    }

    #[tokio::test]
    async fn a_peer_evicted_for_disagreeing_is_asked_for_gossip_again_when_it_returns() {
        // The introducer names A; A gossips B; B contradicts A once, so both
        // are let go. Named by the introducer again, A answers alike now and
        // must be asked for gossip again, or B is never found and no pair forms.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let agreeing = node(vec![state(1, 90, None)], (1, None), vec![]);
        let contradicting = node(vec![state(1, 90, Some(99))], (1, None), vec![]);
        let once: Handler = Arc::new(move |m: &Message| {
            if m.msg_type == chia_protocol::ProtocolMessageTypes::RequestPuzzleState && calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                contradicting(m)
            } else {
                agreeing(m)
            }
        });
        let b = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), once).await;
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), node(vec![state(1, 90, None)], (1, None), vec![b.addr])).await;
        let net = Network { introducers: vec!["127.0.0.1".to_string()], port: a.addr.port(), ..net() };
        let found = Arc::new(Lane::new(net, vec![], false, None).with_tls(TLS.clone()));
        let money = PeerLane::new(found.clone(), Trust::Agreed);
        let err = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap_err();
        assert!(err.to_string().contains("disagree"), "{err}");
        assert_eq!(found.live_conns().await.len(), 0);
        found.state.lock().await.introduce_after = None;
        found.expire_pin_cooldown().await;
        assert_eq!(
            money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(),
            1,
            "A's gossip brought B back for the pair"
        );
        assert_eq!(found.live_conns().await.len(), 2);
    }

    #[tokio::test]
    async fn a_dead_connection_the_carrier_fallback_finds_is_queued_again() {
        // Two peers are up and one connection dies. The carrier's search for a
        // stand-in finds it dead, and the peer returns to the queue for a later
        // dial like any dropped peer, rather than vanishing from the lane.
        let a = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let pool = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None);
        assert_eq!(PeerLane::new(pool.clone(), Trust::Agreed).peak_height().await.unwrap(), 100);
        let conns = pool.live_conns().await;
        assert_eq!(conns.len(), 2);
        let dead = conns.iter().find(|c| c.addr() == b.addr).unwrap().clone();
        dead.close().await;
        for _ in 0..100 {
            if !dead.alive() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!dead.alive());
        assert_eq!(pool.live_conns().await.len(), 1);
        let state = pool.state.lock().await;
        assert!(state.candidates.iter().any(|c| c.addr == b.addr), "found dead, the peer is queued again");
        assert!(state.cooling.contains_key(&b.addr), "and cooling");
    }

    #[tokio::test]
    async fn an_address_that_keeps_failing_the_dial_is_given_up() {
        let dead = closed().await;
        let stubborn = lane(vec![(dead, Source::Gossip)], vec![], false, None);
        let carrier = PeerLane::new(stubborn.clone(), Trust::Carrier);
        for failures in 1..=MAX_DIAL_FAILURES {
            assert!(carrier.peak_height().await.is_err());
            {
                let state = stubborn.state.lock().await;
                if failures < MAX_DIAL_FAILURES {
                    assert_eq!(state.candidates.front().map(|c| c.failures), Some(failures), "queued again, its failures counted");
                } else {
                    assert!(state.candidates.is_empty(), "given up after {MAX_DIAL_FAILURES} failed dials");
                }
            }
            stubborn.expire_pin_cooldown().await;
        }
    }

    #[tokio::test]
    async fn a_full_queue_of_failed_addresses_makes_room_for_a_newcomer() {
        // The queue is full of addresses cooling after a failed dial. A
        // newcomer takes one of their places (a queue full of addresses that
        // never failed keeps what it has), and the next request reaches it.
        let live = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let crowded = lane(vec![], vec![], false, None);
        {
            let mut state = crowded.state.lock().await;
            let until = Instant::now() + RETRY_AFTER;
            for n in 0..CANDIDATE_CAP {
                let addr = SocketAddr::from(([10, 0, (n / 256) as u8, (n % 256) as u8], 58444));
                state.candidates.push_back(Candidate { addr, source: Source::Gossip, failures: 0 });
                state.cooling.insert(addr, until);
            }
            let late = SocketAddr::from(([10, 1, 0, 1], 58444));
            push_candidates(&mut state, vec![Candidate { addr: late, source: Source::Gossip, failures: 0 }]);
            assert!(!state.candidates.iter().any(|c| c.addr == late), "nothing queued has failed, so nothing makes room");
            for c in state.candidates.iter_mut() {
                c.failures = 1;
            }
            push_candidates(&mut state, vec![Candidate { addr: live.addr, source: Source::Gossip, failures: 0 }]);
            assert_eq!(state.candidates.len(), CANDIDATE_CAP, "the queue stays at its cap");
            assert!(state.candidates.iter().any(|c| c.addr == live.addr), "the newcomer took a failed address's place");
        }
        assert_eq!(PeerLane::new(crowded.clone(), Trust::Carrier).peak_height().await.unwrap(), 100);
    }

    #[tokio::test]
    async fn pins_naming_one_node_twice_count_once() {
        // Three spellings of one node ahead of a distinct pin: the node is
        // dialled once and the distinct pin still gets its place, so the pins'
        // share of the pool is not spent on one node.
        let one = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let other = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let public = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let mapped = format!("[::ffff:{}]:{}", one.addr.ip(), one.addr.port());
        let pins = vec![one.addr.to_string(), mapped, one.addr.to_string(), other.addr.to_string()];
        let twice = lane(vec![(public.addr, Source::Introducer)], pins, false, None);
        assert_eq!(PeerLane::new(twice.clone(), Trust::Agreed).peak_height().await.unwrap(), 100);
        let conns = twice.live_conns().await;
        let pin_addrs: Vec<SocketAddr> = conns.iter().filter(|c| c.source() == Source::Pin).map(|c| c.addr()).collect();
        assert_eq!(pin_addrs.len(), 2, "one connection per node: {pin_addrs:?}");
        assert!(pin_addrs.contains(&one.addr) && pin_addrs.contains(&other.addr));
        assert_eq!(twice.state.lock().await.pin_target, Some(2));
    }

    #[tokio::test]
    async fn a_pin_reached_through_public_discovery_counts_as_the_pin_once_it_resolves() {
        // The pin did not resolve at first (the state a failed lookup leaves:
        // no pin target, a retry pending) and the carrier reached the same
        // node through gossip. When the pin resolves to that live connection,
        // the connection counts as the pin: money reads have their pin, and
        // no second connection to the node is opened.
        let own = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let public = full_node(vec![], (1, None), Some(peak_at(100))).await;
        let recovered = lane(vec![(own.addr, Source::Gossip), (public.addr, Source::Introducer)], vec![own.addr.to_string()], false, None);
        {
            let mut state = recovered.state.lock().await;
            state.pin_target = None;
            state.pin_retry_after = Some(Instant::now() + PIN_RETRY_AFTER);
        }
        assert_eq!(PeerLane::new(recovered.clone(), Trust::Carrier).peak_height().await.unwrap(), 100);
        let money = PeerLane::new(recovered.clone(), Trust::Agreed);
        let err = money.peak_height().await.unwrap_err();
        assert!(err.to_string().contains("unreachable"), "{err}");
        recovered.expire_pin_cooldown().await;
        assert_eq!(money.peak_height().await.unwrap(), 100);
        let conns = recovered.live_conns().await;
        assert_eq!(conns.len(), 2, "no second connection to the node");
        assert!(conns.iter().any(|c| c.addr() == own.addr && c.source() == Source::Pin), "the gossiped connection is the pin now");
    }

    #[tokio::test]
    async fn a_failed_gossip_request_is_asked_again_later() {
        // A's first answer to RequestPeers is not a peer list, so a money read
        // finds no second source. A is not asked again at once, but once the
        // retry delay has passed it gossips B and the pair forms.
        let b = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let base = node(vec![state(1, 90, None)], (1, None), vec![b.addr]);
        let flaky: Handler = Arc::new(move |m: &Message| {
            if m.msg_type == chia_protocol::ProtocolMessageTypes::RequestPeers && calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                vec![reply(&RespondBlockHeader::new(header_at(1, genesis())))]
            } else {
                base(m)
            }
        });
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), flaky).await;
        let retrying = lane(vec![(a.addr, Source::Introducer)], vec![], false, None);
        let money = PeerLane::new(retrying.clone(), Trust::Agreed);
        let asked = || a.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestPeers).count();
        let err = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap_err();
        assert!(err.to_string().contains("fewer than two"), "{err}");
        assert!(matches!(retrying.state.lock().await.gossiped.get(&a.addr), Some(Some(_))), "marked to ask again later, not never");
        let err = money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap_err();
        assert!(err.to_string().contains("fewer than two"), "{err}");
        assert_eq!(asked(), 1, "not asked again before the delay");
        retrying.expire_pin_cooldown().await;
        assert_eq!(money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(), 1, "asked again, A's gossip brought B");
        assert_eq!(asked(), 2);
    }

    #[tokio::test]
    async fn a_capped_coin_state_reply_is_followed_until_every_id_is_answered() {
        // Chia caps a coin-state request at its response-item limit and echoes
        // the ids it took. A peer answering one id per request is asked again
        // for the rest until every id is answered; a peer answering none of
        // what is left leaves the listing cut short with no cursor, which the
        // wallet lease treats as incomplete (its coins stay parked).
        let states = vec![state(1, 90, None), state(2, 80, Some(85)), state(3, 95, None)];
        let capped = |cap: usize| -> Handler {
            let states = states.clone();
            let base = node(states.clone(), (1, None), vec![]);
            Arc::new(move |m: &Message| {
                if m.msg_type == chia_protocol::ProtocolMessageTypes::RequestCoinState {
                    let req = RequestCoinState::from_bytes(&m.data).unwrap();
                    let taken: Vec<Bytes32> = req.coin_ids.iter().take(cap).copied().collect();
                    let named: Vec<CoinState> = states.iter().filter(|s| taken.contains(&s.coin.coin_id())).cloned().collect();
                    vec![reply(&RespondCoinState::new(taken, named))]
                } else {
                    base(m)
                }
            })
        };
        let names: Vec<Bytes32> = states.iter().map(|s| s.coin.coin_id()).collect();
        let asked = |n: &MockNode| n.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestCoinState).count();
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), capped(1)).await;
        let b = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), capped(1)).await;
        let money = PeerLane::new(lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, None), Trust::Agreed);
        let listing = money.coin_records_by_names(names.clone(), true, None).await.unwrap();
        assert_eq!(listing.records.len(), 3);
        assert!(!listing.truncated);
        assert_eq!((asked(&a), asked(&b)), (3, 3), "one request per id the peers took");
        let mute = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), capped(0)).await;
        let mute_too = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), capped(0)).await;
        let money = PeerLane::new(lane(vec![(mute.addr, Source::Introducer), (mute_too.addr, Source::Gossip)], vec![], false, None), Trust::Agreed);
        let listing = money.coin_records_by_names(names, true, None).await.unwrap();
        assert!(listing.records.is_empty() && listing.truncated && listing.next_cursor.is_none(), "cut short with no way to go on");
        assert_eq!(asked(&mute), 1, "no progress, no second request");
    }

    #[tokio::test]
    async fn a_listing_is_one_protocol_page_with_a_cursor_for_the_rest() {
        // A peer with more to say ends its page unfinished: the listing is one
        // page, cut short with a cursor at the page's height and header, and
        // the caller's page budget decides how far to follow.
        let states = vec![state(1, 90, None)];
        let unfinished: Handler = {
            let states = states.clone();
            let base = node(states.clone(), (1, None), vec![]);
            Arc::new(move |m: &Message| {
                if m.msg_type == chia_protocol::ProtocolMessageTypes::RequestPuzzleState {
                    let req = RequestPuzzleState::from_bytes(&m.data).unwrap();
                    vec![reply(&RespondPuzzleState::new(req.puzzle_hashes, 100, header_at(100, genesis()).header_hash(), false, states.clone()))]
                } else {
                    base(m)
                }
            })
        };
        let a = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak_at(100)), unfinished).await;
        let carrier = PeerLane::new(lane(vec![(a.addr, Source::Introducer)], vec![], false, None), Trust::Carrier);
        let listing = carrier.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap();
        assert_eq!(listing.records.len(), 1);
        assert!(listing.truncated);
        assert_eq!(decode_cursor(listing.next_cursor.as_ref().unwrap()).unwrap(), (100, header_at(100, genesis()).header_hash()));
        assert_eq!(
            a.seen.lock().unwrap().iter().filter(|t| **t == chia_protocol::ProtocolMessageTypes::RequestPuzzleState).count(),
            1,
            "one page per listing"
        );
    }

    #[tokio::test]
    async fn a_late_success_cannot_restore_an_evicted_peer() {
        // Two requests overlap: one evicts the public peers for disagreeing,
        // the other had matching answers and records its success afterwards.
        // Only connections still in the pool are remembered, so the store
        // stays empty.
        let a = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let store = temp_store("late-success");
        let _ = std::fs::remove_file(&store);
        let pool = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, Some(store.clone()));
        let money = PeerLane::new(pool.clone(), Trust::Agreed);
        assert_eq!(money.coin_records_by_hint(Bytes32::new([9u8; 32]), None, true, None).await.unwrap().records.len(), 1);
        let conns = pool.live_conns().await;
        assert_eq!(pool.state.lock().await.known.len(), 2, "both remembered");
        pool.evict(&conns, "disagreed (test)").await;
        pool.note_good(&conns).await;
        assert!(pool.state.lock().await.known.is_empty(), "a late success restores nothing");
        assert!(!store.exists() || serde_json::from_slice::<StoreFile>(&std::fs::read(&store).unwrap()).unwrap().peers.is_empty());
    }

    #[tokio::test]
    async fn a_stale_handle_cannot_drop_a_replacement_connection() {
        // A request that slept through a reconnect still holds the old
        // connection; dropping or evicting through that handle must not touch
        // the replacement now holding the address.
        let a = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let b = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let store = temp_store("stale-handle");
        let _ = std::fs::remove_file(&store);
        let pool = lane(vec![(a.addr, Source::Introducer), (b.addr, Source::Gossip)], vec![], false, Some(store.clone()));
        let money = PeerLane::new(pool.clone(), Trust::Agreed);
        assert_eq!(money.peak_height().await.unwrap(), 100);
        let old = pool.live_conns().await.into_iter().find(|c| c.addr() == a.addr).unwrap();
        pool.drop_conn(&old).await;
        pool.expire_pin_cooldown().await;
        assert_eq!(money.peak_height().await.unwrap(), 100, "dialled again");
        let new = pool.live_conns().await.into_iter().find(|c| c.addr() == a.addr).unwrap();
        assert!(!Arc::ptr_eq(&old, &new));
        pool.drop_conn(&old).await;
        pool.evict(&[old.clone()], "stale verdict (test)").await;
        assert!(pool.live_conns().await.iter().any(|c| Arc::ptr_eq(c, &new)), "the replacement stays pooled");
        let state = pool.state.lock().await;
        assert!(!state.cooling.contains_key(&a.addr), "and its address is not cooling");
        assert!(state.known.iter().any(|p| p.addr == a.addr.to_string()), "nor forgotten");
    }

    #[tokio::test]
    async fn pins_are_read_as_typed() {
        assert_eq!(resolve_pin("203.0.113.5:8444", 58444).await, vec!["203.0.113.5:8444".parse().unwrap()]);
        assert_eq!(resolve_pin("203.0.113.5", 58444).await, vec!["203.0.113.5:58444".parse().unwrap()]);
        assert_eq!(resolve_pin("2001:db8::1", 58444).await, vec!["[2001:db8::1]:58444".parse().unwrap()]);
        assert_eq!(resolve_pin("[2001:db8::1]:8444", 58444).await, vec!["[2001:db8::1]:8444".parse().unwrap()]);
        let local = resolve_pin("localhost:1234", 58444).await;
        assert!(local.iter().all(|a| a.port() == 1234 && a.ip().is_loopback()), "{local:?}");
    }

    #[test]
    fn the_lane_describes_its_posture() {
        let public = Lane::new(Network::testnet11(), vec![], false, None);
        assert!(public.describe().contains("two agreeing peers"));
        let pinned = Lane::new(Network::testnet11(), vec!["10.0.0.2".to_string()], false, None);
        assert!(pinned.describe().contains("plus one public peer"));
        let only = Lane::new(Network::testnet11(), vec!["10.0.0.2".to_string()], true, None);
        assert!(only.describe().contains("ONLY"));
        // Pin-only without a pin is just the public posture.
        let none = Lane::new(Network::testnet11(), vec![], true, None);
        assert!(!none.pin_only);
        let _ = Mutex::new(());
    }
}
