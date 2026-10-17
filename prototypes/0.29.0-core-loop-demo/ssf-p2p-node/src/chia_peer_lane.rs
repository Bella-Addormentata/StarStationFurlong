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
//!     default it must agree with one public peer from another network group;
//!     `SSF_CHIA_PIN_ONLY=1` makes the pin's verdict final alone (and dials no
//!     public peer at all). An unreachable pin is a non‑final verdict on money
//!     paths, never a silent fall‑back to public peers; the presence lane may
//!     still read from public peers meanwhile.
//!   - PUBLIC peers come from three sources: the DNS introducer (fresh this
//!     run; asked when the stored and gossiped candidates run out, at most
//!     every [`INTRODUCE_EVERY`], sooner only after a lookup that named
//!     nobody), `RequestPeers` gossip from a connected peer, and the store of
//!     known‑good peers kept in `chia_peers.json` across runs. Two agreeing
//!     peers must come from DISTINCT sources and distinct network groups
//!     (IPv4 /16, IPv6 /32; an IPv4‑mapped IPv6 address is its IPv4 address),
//!     and one of them must be fresh (a pin or the introducer), so a poisoned
//!     store cannot make an eclipse stick. One source holds at most
//!     [`PER_SOURCE_CAP`] of the [`MAX_CONNS`] connections, and a full pool
//!     that cannot form a pair lets a redundant connection go for a candidate
//!     from a source it lacks. A stored peer that disagrees with a verdict,
//!     or with a pin, is evicted; so is a public peer whose announced peak
//!     lags the furthest one by more than [`MAX_PEAK_LAG`] blocks.
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
use crate::chia_peer::{canonical, Group, Network, Peak, PeerConn, Source, CONNECT_TIMEOUT, PEAK_STALE, PEAK_WAIT};

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
/// Rounds of dialling one request may spend before it gives up.
pub const MAX_ROUNDS: usize = 4;
/// How long a public address that failed or disagreed is left alone.
pub const RETRY_AFTER: Duration = Duration::from_secs(600);
/// How long a pin that failed is left alone (its owner may be restarting it).
pub const PIN_RETRY_AFTER: Duration = Duration::from_secs(60);
/// How often the introducer is asked again while peers are wanted.
pub const INTRODUCE_EVERY: Duration = Duration::from_secs(1800);
/// How soon it is asked again after a lookup that named nobody (DNS down, the
/// machine offline): a first run has nothing else to try.
pub const INTRODUCE_RETRY: Duration = Duration::from_secs(60);
/// Connections one public source may hold at once: one slot always stays for
/// another source, so four introducer peers cannot fill the pool and shut
/// gossip and the store out of the agreed pair (§14 (2)).
pub const PER_SOURCE_CAP: usize = MAX_CONNS - 1;
/// Addresses taken from one introducer answer or one gossip answer.
pub const ADDRS_PER_ANSWER: usize = 32;
/// Pages one listing follows before it reports itself cut short with a cursor.
pub const PAGES_PER_LISTING: usize = 8;
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
    /// Connections already asked for gossip.
    gossiped: HashSet<SocketAddr>,
    store_loaded: bool,
    known: Vec<StoredPeer>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Candidate {
    addr: SocketAddr,
    source: Source,
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
                state.candidates.push_back(Candidate { addr: canonical(addr), source });
            }
        }
        self
    }

    /// Let the pins be dialled again at once (tests).
    #[cfg(test)]
    pub async fn expire_pin_cooldown(&self) {
        let mut state = self.state.lock().await;
        state.pin_retry_after = None;
        state.cooling.clear();
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
        state.conns.retain(|c| c.alive());
        state.conns.len()
    }

    /// The peers a `trust` verdict is taken from, dialling as needed.
    async fn peers_for(&self, trust: Trust) -> Result<Vec<Arc<PeerConn>>, ChainError> {
        let mut state = self.state.lock().await;
        state.conns.retain(|c| c.alive());
        let pinned = !self.pins.is_empty();
        for _ in 0..MAX_ROUNDS {
            // A pin is dialled BEFORE any public peer is accepted, and again
            // whenever its cooldown has passed: the carrier would otherwise
            // ride a public fallback for as long as that connection lives.
            let pin_up = |state: &LaneState| state.conns.iter().any(|c| c.source() == Source::Pin);
            if pinned && !pin_up(&state) && state.pin_retry_after.is_none_or(|at| Instant::now() >= at) {
                self.dial_pins(&mut state).await;
            }
            if trust == Trust::Agreed {
                self.let_laggards_go(&mut state);
            }
            if let Some(set) = self.choose(&state, trust) {
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
            if self.pin_only {
                // Nothing public is ever dialled in this mode.
                break;
            }
            self.refill(&mut state).await;
            if !self.dial(&mut state).await {
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
    /// than [`MAX_PEAK_LAG`] blocks behind the furthest one is let go: its
    /// answers describe an older chain state, so a match between it and a
    /// current peer would not mean what an agreement should. Pins stay; a
    /// lagging pin makes the verdict non-final in [`Lane::peak`] instead.
    fn let_laggards_go(&self, state: &mut LaneState) {
        let Some(top) = state.conns.iter().filter_map(|c| c.peak_now()).map(|p| p.height).max() else { return };
        let (lagging, kept): (Vec<Arc<PeerConn>>, Vec<Arc<PeerConn>>) = state
            .conns
            .drain(..)
            .partition(|c| c.source() != Source::Pin && c.peak_now().is_some_and(|p| p.height + MAX_PEAK_LAG < top));
        state.conns = kept;
        let until = Instant::now() + RETRY_AFTER;
        for peer in lagging {
            let behind = top - peer.peak_now().map(|p| p.height).unwrap_or(0);
            eprintln!("⛓️ chain peers: {} ({}) let go: lags {behind} blocks behind the furthest peer", peer.addr(), peer.source().label());
            state.gossiped.remove(&peer.addr());
            state.cooling.insert(peer.addr(), until);
            close_later(peer);
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

    /// Resolve and dial every pin not connected. A pin outranks any public
    /// connection for a slot; a pin that fails is left alone for
    /// [`PIN_RETRY_AFTER`] (its owner may be restarting it) and tried again.
    async fn dial_pins(&self, state: &mut LaneState) {
        let connected: HashSet<SocketAddr> = state.conns.iter().map(|c| c.addr()).collect();
        let now = Instant::now();
        let mut targets = Vec::new();
        for pin in &self.pins {
            for addr in resolve_pin(pin, self.net.port).await {
                if !connected.contains(&addr) && !state.cooling.get(&addr).is_some_and(|until| now < *until) {
                    targets.push(Candidate { addr, source: Source::Pin });
                }
            }
        }
        if targets.is_empty() {
            state.pin_retry_after = Some(now + PIN_RETRY_AFTER);
            return;
        }
        while state.conns.len() >= MAX_CONNS {
            let Some(i) = state.conns.iter().rposition(|c| c.source() != Source::Pin) else { break };
            let peer = state.conns.remove(i);
            eprintln!("⛓️ chain peers: {} ({}) let go: making room for a pin", peer.addr(), peer.source().label());
            state.gossiped.remove(&peer.addr());
            close_later(peer);
        }
        self.dial_batch(state, targets, PIN_RETRY_AFTER).await;
        state.pin_retry_after = if state.conns.iter().any(|c| c.source() == Source::Pin) { None } else { Some(Instant::now() + PIN_RETRY_AFTER) };
    }

    /// Top up the candidate queue: the store once, the introducer when due
    /// (its last answer used up and [`INTRODUCE_EVERY`] passed, or
    /// [`INTRODUCE_RETRY`] after an answer that named nobody), and gossip from
    /// every connection not yet asked. The interval holds across requests and
    /// dial rounds alike: while the introducer cools down, the queued, stored
    /// and gossiped candidates are what there is to try.
    async fn refill(&self, state: &mut LaneState) {
        if !state.store_loaded {
            state.store_loaded = true;
            state.known = self.store_path.as_deref().map(load_store).unwrap_or_default();
            let stored: Vec<Candidate> = state
                .known
                .iter()
                .filter_map(|p| p.addr.parse::<SocketAddr>().ok())
                .map(|addr| Candidate { addr, source: Source::Store })
                .collect();
            push_candidates(state, stored);
        }
        let introduce = !self.net.introducers.is_empty()
            && state.introduce_after.is_none_or(|at| Instant::now() >= at)
            && !state.candidates.iter().any(|c| c.source == Source::Introducer);
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
            push_candidates(state, found.into_iter().map(|addr| Candidate { addr, source: Source::Introducer }).collect());
            eprintln!("⛓️ chain peers: the introducer named {n} full nodes");
        }
        let unasked: Vec<Arc<PeerConn>> = state.conns.iter().filter(|c| !state.gossiped.contains(&c.addr())).cloned().collect();
        for conn in unasked {
            state.gossiped.insert(conn.addr());
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
                    push_candidates(state, addrs.into_iter().map(|addr| Candidate { addr, source: Source::Gossip }).collect());
                    eprintln!("⛓️ chain peers: {} gossiped {n} full nodes", conn.addr());
                }
                Err(e) => eprintln!("⛓️ chain peers: {} gossip: {e:#}", conn.addr()),
            }
        }
    }

    /// Dial the next few candidates, sources not yet connected first (fresh
    /// ones ahead), no source past [`PER_SOURCE_CAP`]. A full pool that cannot
    /// form an agreed pair first lets one redundant public connection go when
    /// a candidate from a source it lacks is waiting. `false` when there was
    /// nothing to dial.
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
        if state.conns.len() >= MAX_CONNS {
            let facts: Vec<(Source, Group)> = state.conns.iter().map(|c| (c.source(), c.group())).collect();
            let wanted = ready.iter().any(|c| !have.contains(&c.source));
            let spare = if wanted && self.choose(state, Trust::Agreed).is_none() { redundant(&facts) } else { None };
            match spare {
                Some(i) => {
                    let peer = state.conns.remove(i);
                    eprintln!(
                        "⛓️ chain peers: {} ({}) let go: making room for a peer from another source",
                        peer.addr(),
                        peer.source().label()
                    );
                    state.gossiped.remove(&peer.addr());
                    close_later(peer);
                }
                None => {
                    state.candidates = ready.into_iter().chain(later).collect();
                    return false;
                }
            }
        }
        ready.sort_by_key(|c| (have.contains(&c.source), !c.source.is_fresh()));
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
                    if state.conns.len() < MAX_CONNS {
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
                }
            }
        }
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

    /// Remember the public peers of an agreed verdict as known-good.
    async fn note_good(&self, peers: &[Arc<PeerConn>]) {
        let mut state = self.state.lock().await;
        let now = unix_now();
        let mut changed = false;
        for peer in peers.iter().filter(|p| p.source() != Source::Pin) {
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
            eprintln!("⛓️ chain peers: {} ({}) let go: {why}", peer.addr(), peer.source().label());
            state.conns.retain(|c| c.addr() != peer.addr());
            state.cooling.insert(peer.addr(), until);
            self.forget(&mut state, peer.addr());
            close_later(peer.clone());
        }
    }

    /// Drop one connection that stopped answering; it is dialled again later.
    async fn drop_conn(&self, peer: &Arc<PeerConn>) {
        let mut state = self.state.lock().await;
        state.conns.retain(|c| c.addr() != peer.addr());
        state.gossiped.remove(&peer.addr());
        close_later(peer.clone());
    }

    async fn live_conns(&self) -> Vec<Arc<PeerConn>> {
        let mut state = self.state.lock().await;
        state.conns.retain(|c| c.alive());
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
        let peers = self.peers_for(trust).await?;
        match trust {
            Trust::Carrier => {
                let first = peers[0].clone();
                match op(first.clone()).await {
                    Ok(v) => Ok(v),
                    Err(ChainError::Refused(why)) => Err(ChainError::Refused(why)),
                    Err(ChainError::Unanswered(e)) => {
                        self.drop_conn(&first).await;
                        let next = self.live_conns().await.into_iter().find(|c| c.addr() != first.addr());
                        match next {
                            Some(next) => op(next).await,
                            None => Err(ChainError::Unanswered(e)),
                        }
                    }
                }
            }
            Trust::Agreed => {
                let answers = join_all(peers.iter().cloned().map(|p| op(p))).await;
                self.verdict(what, &peers, answers).await
            }
        }
    }

    async fn verdict<T: PartialEq>(&self, what: &str, peers: &[Arc<PeerConn>], answers: Vec<Result<T, ChainError>>) -> Result<T, ChainError> {
        let mut oks: Vec<T> = Vec::new();
        let mut refusals: Vec<String> = Vec::new();
        let mut silences: Vec<String> = Vec::new();
        let mut silent: Vec<Arc<PeerConn>> = Vec::new();
        for (peer, answer) in peers.iter().zip(answers) {
            match answer {
                Ok(v) => oks.push(v),
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
            if oks.iter().all(|v| *v == oks[0]) {
                self.note_good(peers).await;
                return Ok(oks.swap_remove(0));
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
/// mempool again). Refused everywhere: dead only when a refusal is FINAL —
/// the bundle itself can never land — since a refusal for fee or load says
/// nothing about a copy an earlier peer may still hold; such a verdict stays
/// unknown and the coins stay parked (release only with evidence). Else
/// unknown.
pub(crate) fn live_verdict(outcomes: &[AckOutcome]) -> Result<bool, ChainError> {
    if outcomes.iter().any(|o| *o == AckOutcome::Accepted) {
        return Ok(true);
    }
    if outcomes.iter().all(|o| matches!(o, AckOutcome::Failed(_))) {
        if outcomes.iter().any(|o| matches!(o, AckOutcome::Failed(why) if refusal_is_final(why))) {
            return Ok(false);
        }
        return Err(unanswered(format!(
            "spend liveness: refused for policy or load, not on the bundle itself, so it may still be live elsewhere ({})",
            describe(outcomes)
        )));
    }
    Err(unanswered(format!("spend liveness: not every peer acked ({})", describe(outcomes))))
}

/// Whether a full node's reason for refusing a bundle says the bundle can
/// NEVER land (an input already spent, a condition that fails, a bad
/// signature, a malformed spend), as against its own policy or state (a fee
/// too low for a full mempool, "seen before", not synced). The names are
/// chia-blockchain's `Err` codes as `TransactionAck.error` spells them; an
/// unknown reason is not final.
pub(crate) fn refusal_is_final(reason: &str) -> bool {
    const FINAL: &[&str] = &[
        "DOUBLE_SPEND",
        "UNKNOWN_UNSPENT",
        "ASSERT_",
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
        let pin = peers.iter().position(|(s, _)| *s == Source::Pin)?;
        if pin_only {
            return Some(vec![pin]);
        }
        let public = peers.iter().position(|(s, g)| *s != Source::Pin && *g != peers[pin].1)?;
        return Some(vec![pin, public]);
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

/// Among connected peers, one whose source another connection shares (the
/// newest such public one), so letting it go loses the pool no source an
/// agreed pair could use. `None` when every source is held once, or only by
/// pins.
pub(crate) fn redundant(facts: &[(Source, Group)]) -> Option<usize> {
    let mut held: HashMap<Source, usize> = HashMap::new();
    for (source, _) in facts {
        *held.entry(*source).or_default() += 1;
    }
    facts.iter().rposition(|(source, _)| *source != Source::Pin && held[source] >= 2)
}

/// Close a connection off the lane's lock: the websocket close is bounded,
/// but no caller waits on a peer that stopped reading.
fn close_later(peer: Arc<PeerConn>) {
    tokio::spawn(async move { peer.close().await });
}

fn push_candidates(state: &mut LaneState, mut new: Vec<Candidate>) {
    for cand in &mut new {
        cand.addr = canonical(cand.addr);
    }
    let present: HashSet<SocketAddr> =
        state.candidates.iter().map(|c| c.addr).chain(state.conns.iter().map(|c| c.addr())).collect();
    new.retain(|c| !present.contains(&c.addr));
    for cand in new {
        if state.candidates.len() >= CANDIDATE_CAP {
            break;
        }
        state.candidates.push_back(cand);
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

/// One peer's listing under `keys` (puzzle hashes, read as hints too when
/// `hinted`): `RequestPuzzleState` from `cursor`, else from the block before
/// `min_height` (its header fetched first, so a watcher's incremental scan
/// asks only for what changed since; the peer rejecting that start as a
/// reorg sends the listing back to genesis), else from genesis; followed for
/// [`PAGES_PER_LISTING`] pages, then cut short with a cursor.
async fn listing_on(
    peer: Arc<PeerConn>,
    net: Network,
    keys: Vec<Bytes32>,
    hinted: bool,
    include_spent: bool,
    min_height: Option<u32>,
    cursor: Option<String>,
) -> Result<CoinListing, ChainError> {
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
    let filters = CoinStateFilters::new(include_spent, true, hinted, 0);
    let mut states: HashMap<Bytes32, CoinState> = HashMap::new();
    let mut pages = 0;
    while pages < PAGES_PER_LISTING {
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
        let page = match page {
            Ok(page) => page,
            Err(reject) if from_header && reject.reason == RejectStateReason::Reorg => {
                // The block before `min_height` is not on the peer's chain any
                // more: the listing starts over from genesis, once.
                from_header = false;
                previous = None;
                header_hash = net.genesis;
                states.clear();
                continue;
            }
            Err(reject) => return Err(ChainError::Refused(format!("coin listing rejected: {:?}", reject.reason))),
        };
        pages += 1;
        from_header = false;
        for state in page.coin_states {
            states.insert(state.coin.coin_id(), state);
        }
        previous = Some(page.height);
        header_hash = page.header_hash;
        if page.is_finished {
            return Ok(CoinListing {
                records: records_from(states.into_values().collect(), include_spent, min_height),
                truncated: false,
                next_cursor: None,
            });
        }
    }
    Ok(CoinListing {
        records: records_from(states.into_values().collect(), include_spent, min_height),
        truncated: true,
        next_cursor: Some(encode_cursor(previous.unwrap_or(0), header_hash)),
    })
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

/// One peer's states for the coins named.
async fn states_on(peer: Arc<PeerConn>, net: Network, names: Vec<Bytes32>, include_spent: bool) -> Result<CoinListing, ChainError> {
    let answer = peer
        .request_fallible::<RespondCoinState, RejectCoinState, _>(RequestCoinState::new(names, None, net.genesis, false))
        .await
        .map_err(ChainError::Unanswered)?;
    match answer {
        Ok(answer) => Ok(CoinListing { records: records_from(answer.coin_states, include_spent, None), truncated: false, next_cursor: None }),
        Err(reject) => Err(ChainError::Refused(format!("coin states rejected: {:?}", reject.reason))),
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
                .ask("coins by hint", self.trust, move |peer| {
                    listing_on(peer, net.clone(), vec![hint], true, include_spent, start_height, cursor.clone())
                })
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
                .ask("coins by puzzle hash", self.trust, move |peer| {
                    listing_on(peer, net.clone(), vec![puzzle_hash], false, include_spent, None, cursor.clone())
                })
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
                .ask("coins by id", self.trust, move |peer| states_on(peer, net.clone(), names.clone(), include_spent))
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
    use crate::chia_peer::mock::{header_at, reply, spawn, Handler, MockNode};
    use crate::chia_peer::{group_of, tls_client_config};
    use chia_protocol::{Coin, Message, NodeType, Program, PuzzleSolutionResponse, TimestampedPeerInfo};
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
    async fn a_public_peer_lagging_the_furthest_peak_is_let_go_before_an_agreed_listing() {
        let behind = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100))).await;
        let ahead = full_node(vec![state(1, 90, None)], (1, None), Some(peak_at(100 + MAX_PEAK_LAG + 1))).await;
        let lane = lane(vec![(behind.addr, Source::Introducer), (ahead.addr, Source::Gossip)], vec![], false, None);
        let money = PeerLane::new(lane.clone(), Trust::Agreed);
        let err = money.coin_records_by_names(vec![coin(1).coin_id()], true, None).await.unwrap_err();
        assert!(err.to_string().contains("fewer than two"), "{err}");
        let conns = lane.live_conns().await;
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0].addr(), ahead.addr, "the lagging peer was let go, the current one kept");
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
    fn a_redundant_connection_shares_its_source_and_is_never_a_pin() {
        let g = |n: u16| group_of(SocketAddr::from(([127, 0, 0, 1], n)));
        assert_eq!(redundant(&[(Source::Introducer, g(1)), (Source::Store, g(2))]), None);
        assert_eq!(redundant(&[(Source::Introducer, g(1)), (Source::Introducer, g(2)), (Source::Store, g(3))]), Some(1));
        assert_eq!(redundant(&[(Source::Pin, g(1)), (Source::Pin, g(2))]), None);
        assert_eq!(redundant(&[(Source::Gossip, g(1)), (Source::Pin, g(2)), (Source::Gossip, g(3))]), Some(2));
    }

    #[test]
    fn only_a_final_refusal_kills_a_spend() {
        assert!(refusal_is_final("203.0.113.5:58444: DOUBLE_SPEND"));
        assert!(refusal_is_final("x: ASSERT_MY_COIN_ID_FAILED"));
        assert!(refusal_is_final("x: BAD_AGGREGATE_SIGNATURE"));
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
        push_candidates(&mut state, vec![Candidate { addr: mapped, source: Source::Gossip }]);
        push_candidates(&mut state, vec![Candidate { addr: native, source: Source::Introducer }]);
        assert_eq!(state.candidates.len(), 1, "the mapped spelling and the native one are one address");
        assert_eq!(state.candidates[0].addr, native);
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
        assert_eq!(live_verdict(&[failed(), dead()]).unwrap(), false, "one final refusal settles it");
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
