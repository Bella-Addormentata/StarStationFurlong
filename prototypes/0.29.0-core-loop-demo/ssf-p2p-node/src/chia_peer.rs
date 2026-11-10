//! One connection to a Chia full node over the light-wallet peer protocol
//! (#231 D1; sovereign plan §6 and §14 "chain access posture"): the transport
//! the chain lane runs on since S‑0 step 2 replaced the HTTPS gateway.
//!
//! What one connection does:
//!   - TLS to `wss://<ip>:<port>/ws` with a certificate signed by the public
//!     Chia CA (`chia-ssl`), which every full node requires of a client and
//!     which authenticates nobody (the CA's private key ships in the Chia
//!     source). The node mints its certificate afresh for every process and
//!     never writes it to disk: there is no key file to protect, and two runs
//!     do not link by certificate hash (D5 pseudonymity). The full node's
//!     certificate is not verified either; peer TLS carries no trust here,
//!     which plan §14 (4) states outright.
//!   - the Chia handshake as a wallet (`NodeType::Wallet`, protocol 0.0.37,
//!     the mempool-update capability), refusing anything but a full node that
//!     names the configured network;
//!   - the NETWORK BINDING of plan §14 (4): block header 0 is requested and
//!     its previous-header hash compared with the configured genesis
//!     challenge, so a peer on another chain is refused whatever its handshake
//!     said (the `network_id` string is advisory);
//!   - request/response routing by message id with one timeout per request,
//!     and the peer's unsolicited `NewPeakWallet` kept as its latest peak;
//!   - a client-side rate gate under the full node's per-message limits, so
//!     the node is never banned for asking too fast.
//!
//! TLS is rustls on the `ring` provider iroh already uses: no second crypto
//! library and no OpenSSL, the outcome the §14 crate audit prefers. The
//! `tokio-tungstenite` websocket runs over a TLS stream this module opens
//! itself, so IPv6 peers work (the crate's own connector cannot name an IPv6
//! literal) and no part of the stack picks a crypto provider on its own.

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use chia_protocol::{
    Bytes32, ChiaProtocolMessage, Handshake, Message, NewPeakWallet, NodeType, ProtocolMessageTypes,
    RejectHeaderRequest, RequestBlockHeader, RespondBlockHeader,
};
use chia_traits::Streamable;
use crate::chia_network::ChiaNet;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, watch};
use tokio::task::JoinHandle;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tokio_tungstenite::WebSocketStream;

type Socket = WebSocketStream<TlsStream<TcpStream>>;
type Sink = SplitSink<Socket, WsMessage>;
type Stream = SplitStream<Socket>;

/// The wallet protocol version this node speaks (the one `chia-protocol` 0.36
/// encodes; a Chia release that moves it means a chia-crate bump, plan §14).
pub const PROTOCOL_VERSION: &str = "0.0.37";
/// One bound for the TLS handshake, the websocket upgrade and the Chia
/// handshake, each.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The bound for the TCP connect alone. Most addresses a full node gossips
/// take no connection at all (home nodes behind a router; on testnet11 about
/// ninety-nine in a hundred, live check 2026-11-10), and each such dial lasts
/// this long: five seconds leave room for a lost first packet and its
/// resend, and let a request try twice the addresses it could in ten.
pub const DIAL_TIMEOUT: Duration = Duration::from_secs(5);
/// How long one request may wait for its answer. A full node that stays
/// silent (it answers nothing for a transaction it does not hold, for one) is
/// `Unanswered` after this, never guessed at.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a fresh connection is given to announce its peak (the full node
/// sends `NewPeakWallet` right after the handshake and on every new block).
pub const PEAK_WAIT: Duration = Duration::from_secs(5);
/// One bound for writing a frame to a peer: a peer that stopped reading must
/// not hang its caller (which may hold the wallet lease) on a full socket.
pub const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a graceful websocket close may take before the socket is simply
/// dropped.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
/// A peak announcement older than this is not taken at its word: the peer is
/// first asked whether the chain has moved past it, so a stalled or half-open
/// connection cannot report an old height as the current one.
pub const PEAK_STALE: Duration = Duration::from_secs(600);

/// The chain the node binds to: its handshake name, its genesis challenge (the
/// §14 (4) binding), the full nodes' default port, the DNS introducers that
/// bootstrap peer discovery (the same class as the mesh's DHT bootstrap nodes;
/// see the External Infrastructure Register), and its consensus constants.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    pub id: String,
    pub genesis: Bytes32,
    pub port: u16,
    pub introducers: Vec<String>,
    /// The network's consensus constants ([`ChiaNet::constants`]): the lane
    /// runs a spend its peers serve under the rules the network's blocks
    /// run it by, the CLVM flags at its height and the block's cost limit
    /// (`chia_peer_lane::hints_made`).
    pub consensus: &'static chia_consensus::consensus_constants::ConsensusConstants,
}

impl Network {
    /// The peer network of `net`. The handshake id is the name Chia's own
    /// full nodes give their network (`selected_network` in their config):
    /// a peer that names another is refused at the handshake, and one whose
    /// block 0 descends from another genesis challenge after it. Each network
    /// has one introducer, the one the Chia project runs (the External
    /// Infrastructure Register: §3 for testnet11, §4 for mainnet).
    pub fn of(net: ChiaNet) -> Self {
        match net {
            ChiaNet::Testnet11 => Self {
                id: "testnet11".to_string(),
                genesis: chia_sdk_types::TESTNET11_CONSTANTS.genesis_challenge,
                port: 58444,
                introducers: vec!["dns-introducer-testnet11.chia.net".to_string()],
                consensus: net.constants(),
            },
            ChiaNet::Mainnet => Self {
                id: "mainnet".to_string(),
                genesis: chia_sdk_types::MAINNET_CONSTANTS.genesis_challenge,
                port: 8444,
                introducers: vec!["dns-introducer.chia.net".to_string()],
                consensus: net.constants(),
            },
        }
    }

    pub fn testnet11() -> Self {
        Self::of(ChiaNet::Testnet11)
    }

    /// Chia mainnet: real XCH. Selected only in a `chia-mainnet` build
    /// (chia_network.rs).
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn mainnet() -> Self {
        Self::of(ChiaNet::Mainnet)
    }
}

/// Where a peer's address came from (plan §14 (2)): an agreement needs two
/// peers from DISTINCT sources, one of them fresh (a pin, or the introducer
/// this run), so a poisoned peer store cannot make an eclipse sticky. An
/// address several sources name keeps every one of them ([`Sources`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// `SSF_CHIA_PEERS`: the operator's own full node, or one they trust.
    Pin,
    /// A DNS introducer answered with it this run.
    Introducer,
    /// Remembered from an earlier run (`chia_peers.json`).
    Store,
    /// Another peer named it in `RespondPeers`.
    Gossip,
}

impl Source {
    /// A fresh source is one this run reached out to itself: a pin, or the
    /// introducer. Store and gossip entries are what earlier peers told us.
    pub fn is_fresh(self) -> bool {
        matches!(self, Source::Pin | Source::Introducer)
    }

    pub fn label(self) -> &'static str {
        match self {
            Source::Pin => "pin",
            Source::Introducer => "introducer",
            Source::Store => "store",
            Source::Gossip => "gossip",
        }
    }

    pub const ALL: [Source; 4] = [Source::Pin, Source::Introducer, Source::Store, Source::Gossip];

    fn bit(self) -> u8 {
        1 << (self as u8)
    }
}

/// Every source that has named one address this run (plan §14 (2)): the one
/// the address is held under — the first to name it, or the fresher one it
/// was promoted to ([`Sources::promote`]), which the lane's per-source cap
/// counts it against and its logs label it by — and every other that has
/// named it since ([`Sources::add`]). An agreed pair needs two connections
/// standing for two distinct sources, one of them fresh; a connection two
/// sources named may stand for either, once
/// ([`crate::chia_peer_lane::pick_agreed`]), so a cold start whose peers
/// gossip only the introducer's own addresses still pairs, instead of holding
/// one source for as long as discovery answers alike (#271 review, round 20).
/// Which source a pair uses a connection for changes nothing about who vouched
/// for the address: the introducer named it, and so did a peer, and both
/// facts stand.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sources {
    under: Source,
    named: u8,
}

impl Sources {
    pub fn of(source: Source) -> Self {
        Self { under: source, named: source.bit() }
    }

    /// `self`, named by `source` too.
    pub fn with(mut self, source: Source) -> Self {
        self.add(source);
        self
    }

    /// The source the address is held and counted under.
    pub fn under(self) -> Source {
        self.under
    }

    pub fn named_by(self, source: Source) -> bool {
        self.named & source.bit() != 0
    }

    /// Record that `source` named the address as well. True when it had not.
    pub fn add(&mut self, source: Source) -> bool {
        let before = self.named;
        self.named |= source.bit();
        self.named != before
    }

    /// Hold the address under a fresher source: a stored or gossiped peer the
    /// introducer names this run counts as an introducer peer from then on,
    /// and a public connection to an address a pin resolves to counts as the
    /// pin. Nothing moves away from fresh except up to a pin, and a pin is
    /// never relabelled. The source it was held under stays among those that
    /// named it.
    pub fn promote(&mut self, to: Source) -> bool {
        let up = match to {
            Source::Pin => self.under != Source::Pin,
            Source::Introducer => !self.under.is_fresh(),
            Source::Store | Source::Gossip => false,
        };
        if up {
            self.under = to;
            self.named |= to.bit();
        }
        up
    }

    /// Every source that named the address, the one it is held under first.
    pub fn iter(self) -> impl Iterator<Item = Source> {
        std::iter::once(self.under).chain(Source::ALL.into_iter().filter(move |s| *s != self.under && self.named_by(*s)))
    }
}

impl From<Source> for Sources {
    fn from(source: Source) -> Self {
        Self::of(source)
    }
}

/// A peer's network group (plan §14 (2)): two agreeing peers must sit in
/// different ones. IPv4 groups by /16 and IPv6 by /32, as Chia's own peer
/// manager does; loopback groups by PORT, so two full nodes on this machine
/// (a drill, or the tests' mock nodes) count as distinct while one machine
/// running one node does not. An IPv4 address in IPv6 clothing is the IPv4
/// address it carries ([`embedded_ipv4`]: mapped `::ffff:a.b.c.d`, the
/// deprecated compatible `::a.b.c.d`, 6to4 `2002:AABB:CCDD::` and NAT64
/// `64:ff9b::a.b.c.d`, the forms `ipv6_is_public` admits as that IPv4), so
/// one peer cannot count twice under two spellings: a node reached at its
/// public IPv4 address and gossiped under the alias a NAT64 host or a 6to4
/// relay gives it would otherwise supply both of a money read's votes (#271
/// review, round 18).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Group([u8; 5]);

pub fn group_of(addr: SocketAddr) -> Group {
    let port = addr.port().to_be_bytes();
    match addr.ip().to_canonical() {
        IpAddr::V4(v4) if v4.is_loopback() => Group([0, 127, 0, port[0], port[1]]),
        IpAddr::V4(v4) => {
            let o = v4.octets();
            Group([4, o[0], o[1], 0, 0])
        }
        IpAddr::V6(v6) if v6.is_loopback() => Group([0, 127, 1, port[0], port[1]]),
        IpAddr::V6(v6) => match embedded_ipv4(v6) {
            Some(v4) => group_of(SocketAddr::new(IpAddr::V4(v4), addr.port())),
            None => {
                let o = v6.octets();
                Group([6, o[0], o[1], o[2], o[3]])
            }
        },
    }
}

/// The IPv4 address an IPv6 address carries, in the forms the public-address
/// judge (`ipv6_is_public`, main.rs) unwraps and judges as that IPv4: mapped
/// and compatible (after the loopback and unspecified checks, so `::1` and
/// `::` carry none), 6to4 (`2002::/16`) and the NAT64 well-known prefix
/// (`64:ff9b::/96`). The local-use translation prefix (`64:ff9b:1::/48`) and
/// Teredo carry none the lane would dial as that IPv4 and stay native. The
/// spelling is kept ([`canonical`] folds the mapped form alone): the alias
/// is how the host that gossiped it reaches the node.
pub(crate) fn embedded_ipv4(ip: Ipv6Addr) -> Option<Ipv4Addr> {
    if ip.is_loopback() || ip.is_unspecified() {
        return None;
    }
    if let Some(v4) = ip.to_ipv4() {
        return Some(v4);
    }
    let seg = ip.segments();
    let v4_of = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if seg[0] == 0x2002 {
        return Some(v4_of(seg[1], seg[2]));
    }
    if seg[0] == 0x0064 && seg[1] == 0xff9b && seg[2..6] == [0, 0, 0, 0] {
        return Some(v4_of(seg[6], seg[7]));
    }
    None
}

/// A socket address with an IPv4-mapped IPv6 address written as the IPv4
/// address it maps, so a peer has ONE spelling in the pool, the candidate
/// queue, the cooling list and the store. Any other address is left as it
/// is: a native IPv6 address keeps its scope id (`[fe80::1%3]:58444` names a
/// node on THAT link, and rebuilt without the scope it could not be reached).
pub fn canonical(addr: SocketAddr) -> SocketAddr {
    match addr {
        SocketAddr::V6(v6) => match v6.ip().to_ipv4_mapped() {
            Some(v4) => SocketAddr::new(IpAddr::V4(v4), v6.port()),
            None => addr,
        },
        SocketAddr::V4(_) => addr,
    }
}

/// Which full node a connection reached (plan §14 (2): one node, one vote):
/// the blake3 hash of the certificate the node presented in the TLS
/// handshake. A full node keeps one certificate however many addresses it
/// listens on, so a node reached at its IPv4 address and again at its IPv6
/// address, two network groups, shows one identity, and the lane holds one
/// connection per identity ([`crate::chia_peer_lane`], admission): a
/// dual-stack node, or a pin found again under a public alias, cannot cast
/// both votes of a money read (#271 review, round 21). Two nodes run under one
/// copied certificate look like one node and hold one connection; two nodes
/// of one operator under separate certificates are told apart only by their
/// network groups, as before.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Identity([u8; 32]);

impl Identity {
    fn of_certificate(der: &[u8]) -> Self {
        Self(*blake3::hash(der).as_bytes())
    }
}

impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Identity({:02x}{:02x}{:02x}{:02x}…)", self.0[0], self.0[1], self.0[2], self.0[3])
    }
}

/// A peer's latest announced peak.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Peak {
    pub height: u32,
    pub header_hash: Bytes32,
}

/// The TLS client configuration every peer connection uses: a fresh
/// Chia-CA-signed certificate for this process, rustls on `ring`, and NO
/// verification of the full node's certificate (Chia full nodes present
/// self-signed certificates under the same public CA; plan §14 (4) records
/// that peer TLS authenticates no one). Minting the RSA key takes a moment,
/// so the lane does this once and off the async threads.
pub fn tls_client_config() -> Result<Arc<rustls::ClientConfig>> {
    let cert = chia_ssl::ChiaCertificate::generate().context("minting the peer certificate")?;
    let (chain, key) = pem_identity(&cert)?;
    tls_client_config_for(chain, key)
}

/// [`tls_client_config`] presenting a given certificate chain and key (the
/// tests present one another CA signed, to see it turned away).
pub(crate) fn tls_client_config_for(chain: Vec<CertificateDer<'static>>, key: PrivateKeyDer<'static>) -> Result<Arc<rustls::ClientConfig>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .context("tls protocol versions")?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyServer(provider)))
        .with_client_auth_cert(chain, key)
        .context("tls client certificate")?;
    Ok(Arc::new(config))
}

/// A `chia-ssl` certificate as rustls wants it: the DER chain and the PKCS#8 key.
pub fn pem_identity(cert: &chia_ssl::ChiaCertificate) -> Result<(Vec<CertificateDer<'static>>, PrivateKeyDer<'static>)> {
    let chain: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut cert.cert_pem.as_bytes())
        .collect::<std::result::Result<_, _>>()
        .context("reading the minted certificate")?;
    let key = rustls_pemfile::pkcs8_private_keys(&mut cert.key_pem.as_bytes())
        .next()
        .ok_or_else(|| anyhow!("the minted certificate carries no PKCS#8 key"))?
        .context("reading the minted key")?;
    Ok((chain, PrivateKeyDer::Pkcs8(key)))
}

/// Accepts any server certificate (see [`tls_client_config`]); handshake
/// signatures are still checked, so the session is at least with whoever
/// holds the presented certificate's key.
#[derive(Debug)]
struct AnyServer(Arc<CryptoProvider>);

impl ServerCertVerifier for AnyServer {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// The requests in flight on one connection, by message id, and the one-off
/// slot for the peer's handshake (which arrives without an id).
#[derive(Default)]
struct Pending {
    waiting: HashMap<u16, oneshot::Sender<Message>>,
    handshake: Option<oneshot::Sender<Handshake>>,
}

/// One live connection to a full node. Cheap to share (`Arc`); dropped, it
/// stops its reader and the socket closes.
pub struct PeerConn {
    addr: SocketAddr,
    /// Every source that named the address, and the one it is held under,
    /// which may move to a fresher source ([`Self::promote`]) when the
    /// introducer or a pin names it this run.
    sources: Mutex<Sources>,
    group: Group,
    /// The node behind the address, by the certificate it presented.
    identity: Identity,
    sink: tokio::sync::Mutex<Sink>,
    pending: Arc<Mutex<Pending>>,
    next_id: AtomicU16,
    peak: watch::Receiver<Option<Peak>>,
    /// When the latest peak was announced (or last proved current).
    peak_at: Arc<Mutex<Option<Instant>>>,
    #[cfg(test)]
    peak_stale_for_test: AtomicBool,
    alive: Arc<AtomicBool>,
    gate: Mutex<RateGate>,
    reader: JoinHandle<()>,
    /// Ends (its sender, held by the reader task, dropped) once the reader
    /// task is gone, and its half of the socket with it, dropped first
    /// ([`ReaderHalf`], [`Self::reader_gone`]).
    reader_done: watch::Receiver<()>,
    /// Set once [`Self::close`] has closed the connection: a later call, or
    /// one made while it runs, waits for that close and writes nothing of
    /// its own.
    closed: tokio::sync::OnceCell<()>,
}

impl std::fmt::Debug for PeerConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PeerConn({} via {})", self.addr, self.source().label())
    }
}

impl Drop for PeerConn {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl PeerConn {
    /// [`Self::connect_until`] with nothing to stop it and no lane's count
    /// for its reader (tests).
    #[cfg(test)]
    pub async fn connect(addr: SocketAddr, sources: impl Into<Sources>, net: &Network, tls: Arc<rustls::ClientConfig>) -> Result<Arc<Self>> {
        Self::connect_until(addr, sources, net, tls, std::future::pending(), None)
            .await
            .unwrap_or_else(|| Err(anyhow!("a dial nothing stops was abandoned")))
    }

    /// Open, handshake and bind one connection (see the module notes), unless
    /// `stop` comes first. `Some(Err)` names what the peer failed:
    /// unreachable, not a full node, another network, or block 0 not
    /// descending from the configured genesis. `None`: `stop` came first,
    /// and the dial was abandoned where it stood, sending nothing more,
    /// neither its Chia handshake nor its binding header request.
    ///
    /// Whatever the outcome short of a connection, nothing of the dial is
    /// left once this returns. Up to the websocket upgrade there is only the
    /// socket, dropped with the dial; from there on a reader task runs, so a
    /// dial refused or abandoned after it stops the reader and waits for it
    /// to go, its half of the socket with it, before the socket is dropped
    /// ([`Self::reader_gone`]).
    ///
    /// `readers`, a lane's ([`Readers`]), counts the reader from just before
    /// it starts until its half of the socket is gone, and stops it at the
    /// lane's close signal, whoever holds the connection by then. So a dial
    /// dropped where it stands (its caller gave up on it), which waits for
    /// nothing, leaves its reader to that count: aborted with the
    /// connection, the reader goes at its next turn, counted until then.
    /// With none (the tests' [`Self::connect`]) the reader is counted
    /// nowhere and stopped only by the connection.
    pub async fn connect_until(
        addr: SocketAddr,
        sources: impl Into<Sources>,
        net: &Network,
        tls: Arc<rustls::ClientConfig>,
        stop: impl Future<Output = ()>,
        readers: Option<&Readers>,
    ) -> Option<Result<Arc<Self>>> {
        tokio::pin!(stop);
        let opened = tokio::select! {
            biased;
            () = &mut stop => return None,
            opened = Self::open(addr, sources.into(), tls, readers) => opened,
        };
        let (conn, handshake) = match opened {
            Ok(opened) => opened,
            Err(e) => return Some(Err(e)),
        };
        let bound = tokio::select! {
            biased;
            () = &mut stop => None,
            bound = conn.bind(net, handshake) => Some(bound),
        };
        let outcome = match bound {
            Some(Ok(())) => return Some(Ok(conn)),
            Some(Err(e)) => Some(Err(e)),
            None => None,
        };
        conn.stop_reading();
        conn.reader_gone().await;
        drop(conn);
        outcome
    }

    /// TCP within [`DIAL_TIMEOUT`], TLS and the websocket upgrade each within
    /// [`CONNECT_TIMEOUT`];
    /// then the reader is started, counted in `readers` when there are any,
    /// and the connection is ready for the handshake ([`Self::bind`]), whose
    /// answer comes on the receiver.
    async fn open(
        addr: SocketAddr,
        sources: Sources,
        tls: Arc<rustls::ClientConfig>,
        readers: Option<&Readers>,
    ) -> Result<(Arc<Self>, oneshot::Receiver<Handshake>)> {
        let addr = canonical(addr);
        let tcp = tokio::time::timeout(DIAL_TIMEOUT, TcpStream::connect(addr))
            .await
            .map_err(|_| anyhow!("tcp connect timed out"))?
            .context("tcp connect")?;
        let _ = tcp.set_nodelay(true);
        let name = ServerName::IpAddress(addr.ip().into());
        let tls_stream = tokio::time::timeout(CONNECT_TIMEOUT, tokio_rustls::TlsConnector::from(tls).connect(name, tcp))
            .await
            .map_err(|_| anyhow!("tls handshake timed out"))?
            .context("tls handshake")?;
        let identity = {
            let (_, session) = tls_stream.get_ref();
            let cert = session.peer_certificates().and_then(|chain| chain.first()).ok_or_else(|| anyhow!("peer presented no certificate"))?;
            Identity::of_certificate(cert.as_ref())
        };
        let request = format!("wss://{addr}/ws").into_client_request().context("websocket request")?;
        let (ws, _response) = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::client_async(request, tls_stream))
            .await
            .map_err(|_| anyhow!("websocket upgrade timed out"))?
            .context("websocket upgrade")?;
        let (sink, stream) = ws.split();
        let (peak_tx, peak_rx) = watch::channel(None);
        let (handshake_tx, handshake_rx) = oneshot::channel();
        let pending = Arc::new(Mutex::new(Pending { waiting: HashMap::new(), handshake: Some(handshake_tx) }));
        let alive = Arc::new(AtomicBool::new(true));
        let peak_at = Arc::new(Mutex::new(None));
        let (done_tx, reader_done) = watch::channel(());
        // Nothing awaits from here to the connection's construction: once the
        // reader runs, the connection that stops it exists, and a lane that
        // counts its readers has counted it since before it was spawned.
        let half = ReaderHalf { stream, _done: done_tx, _counted: readers.map(Readers::count) };
        let closed = readers.map(|readers| readers.closed.clone());
        let reader = tokio::spawn(read_loop(half, closed, pending.clone(), peak_tx, peak_at.clone(), alive.clone()));
        let conn = Arc::new(Self {
            addr,
            sources: Mutex::new(sources),
            group: group_of(addr),
            identity,
            sink: tokio::sync::Mutex::new(sink),
            pending,
            next_id: AtomicU16::new(1),
            peak: peak_rx,
            peak_at,
            #[cfg(test)]
            peak_stale_for_test: AtomicBool::new(false),
            alive,
            gate: Mutex::new(RateGate::new()),
            reader,
            reader_done,
            closed: tokio::sync::OnceCell::new(),
        });
        Ok((conn, handshake_rx))
    }

    /// The Chia handshake, and the network binding of plan §14 (4), on a
    /// connection [`Self::open`] just opened.
    async fn bind(&self, net: &Network, handshake_rx: oneshot::Receiver<Handshake>) -> Result<()> {
        self.send(Handshake::new(
            net.id.clone(),
            PROTOCOL_VERSION.to_string(),
            "0.0.0".to_string(),
            0,
            NodeType::Wallet,
            vec![(1, "1".to_string()), (2, "1".to_string()), (3, "1".to_string())],
        ))
        .await
        .context("sending the handshake")?;
        let handshake = tokio::time::timeout(CONNECT_TIMEOUT, handshake_rx)
            .await
            .map_err(|_| anyhow!("no handshake within {}s", CONNECT_TIMEOUT.as_secs()))?
            .map_err(|_| anyhow!("connection closed before the handshake"))?;
        if handshake.node_type != NodeType::FullNode {
            bail!("peer is a {:?}, not a full node", handshake.node_type);
        }
        if handshake.network_id != net.id {
            bail!("peer is on network {:?}, not {}", handshake.network_id, net.id);
        }
        // §14 (4): the chain itself, not the handshake string, says which network this is.
        let header = self
            .request_fallible::<RespondBlockHeader, RejectHeaderRequest, _>(RequestBlockHeader::new(0))
            .await
            .context("requesting block header 0")?;
        match header {
            Ok(answer) => {
                let block = answer.header_block;
                if block.height() != 0 || block.prev_header_hash() != net.genesis {
                    bail!(
                        "peer's block 0 (height {}) descends from {}, not the {} genesis challenge {}",
                        block.height(),
                        block.prev_header_hash(),
                        net.id,
                        net.genesis
                    );
                }
            }
            Err(_) => bail!("peer would not serve block header 0"),
        }
        Ok(())
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// The source the address is held under ([`Sources::under`]).
    pub fn source(&self) -> Source {
        self.sources().under()
    }

    /// Every source that named the address ([`Sources`]).
    pub fn sources(&self) -> Sources {
        *self.sources.lock().unwrap()
    }

    /// [`Sources::promote`]: hold the address under a fresher source.
    pub fn promote(&self, to: Source) -> bool {
        self.sources.lock().unwrap().promote(to)
    }

    /// [`Sources::add`]: `source` named this address too. True when it had not.
    pub fn add_source(&self, source: Source) -> bool {
        self.sources.lock().unwrap().add(source)
    }

    pub fn group(&self) -> Group {
        self.group
    }

    /// The node behind the connection ([`Identity`]): two connections showing
    /// one identity reached one full node under two addresses.
    pub fn identity(&self) -> Identity {
        self.identity
    }

    /// Still connected, as far as the reader knows.
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    /// The peak, waiting up to `timeout` for a fresh connection's first
    /// announcement.
    pub async fn wait_peak(&self, timeout: Duration) -> Option<Peak> {
        let mut rx = self.peak.clone();
        if let Some(peak) = *rx.borrow_and_update() {
            return Some(peak);
        }
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return None,
                changed = rx.changed() => {
                    if changed.is_err() {
                        return None;
                    }
                    if let Some(peak) = *rx.borrow() {
                        return Some(peak);
                    }
                }
            }
        }
    }

    /// A peak announced above `height`, waiting up to `timeout` for one: the
    /// announcement a peer makes while its last one is being checked against
    /// the chain arrives before, or a moment after, its answer to that check
    /// (the lane's `prove_current`; #271 review, round 23).
    pub async fn wait_peak_past(&self, height: u32, timeout: Duration) -> Option<Peak> {
        let mut rx = self.peak.clone();
        if let Some(peak) = *rx.borrow_and_update() {
            if peak.height > height {
                return Some(peak);
            }
        }
        let deadline = tokio::time::sleep(timeout);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return None,
                changed = rx.changed() => {
                    if changed.is_err() {
                        return None;
                    }
                    if let Some(peak) = *rx.borrow() {
                        if peak.height > height {
                            return Some(peak);
                        }
                    }
                }
            }
        }
    }

    /// The latest announced peak, without waiting.
    pub fn peak_now(&self) -> Option<Peak> {
        *self.peak.borrow()
    }

    /// How long ago the peer announced its peak, or last proved it current
    /// ([`PeerConn::touch_peak`]); `None` before the first announcement.
    pub fn peak_age(&self) -> Option<Duration> {
        #[cfg(test)]
        if self.peak_stale_for_test.load(Ordering::Relaxed) {
            return Some(PEAK_STALE + Duration::from_secs(1));
        }
        self.peak_at.lock().unwrap().map(|at| at.elapsed())
    }

    /// The peer just proved the chain has not moved past its announced peak:
    /// count the announcement as fresh again.
    pub fn touch_peak(&self) {
        *self.peak_at.lock().unwrap() = Some(Instant::now());
        #[cfg(test)]
        self.peak_stale_for_test.store(false, Ordering::Relaxed);
    }

    /// Make the announced peak read as older than [`PEAK_STALE`] (tests).
    #[cfg(test)]
    pub(crate) fn mark_peak_stale(&self) {
        self.peak_stale_for_test.store(true, Ordering::Relaxed);
    }

    /// Make the announced peak read as made `by` ago (tests).
    #[cfg(test)]
    pub(crate) fn backdate_peak(&self, by: Duration) {
        *self.peak_at.lock().unwrap() = Some(Instant::now().checked_sub(by).unwrap_or_else(Instant::now));
    }

    /// Hold the sink, as a write stuck on a peer that stopped reading does:
    /// a close waits for it, up to [`CLOSE_TIMEOUT`] (tests).
    #[cfg(test)]
    pub(crate) async fn hold_sink(&self) -> tokio::sync::MutexGuard<'_, Sink> {
        self.sink.lock().await
    }

    /// Whether [`Self::close`] has run to its end, the reader gone (tests).
    #[cfg(test)]
    pub(crate) fn closed_for_test(&self) -> bool {
        self.closed.initialized()
    }

    /// The reader's done watch ([`Self::reader_done`]), which reads closed
    /// once the reader task is gone, so it can be read after the connection
    /// is (tests).
    #[cfg(test)]
    pub(crate) fn reader_done_for_test(&self) -> watch::Receiver<()> {
        self.reader_done.clone()
    }

    /// Send a message that expects no answer.
    pub async fn send<B>(&self, body: B) -> Result<()>
    where
        B: Streamable + ChiaProtocolMessage,
    {
        let data = body.to_bytes().context("encoding")?;
        self.send_message(Message::new(B::msg_type(), None, data.into())).await
    }

    /// Ask, and expect exactly `T` back.
    pub async fn request<T, B>(&self, body: B) -> Result<T>
    where
        T: Streamable + ChiaProtocolMessage,
        B: Streamable + ChiaProtocolMessage,
    {
        let answer = self.request_raw(body).await?;
        if answer.msg_type != T::msg_type() {
            bail!("{} answered {:?} where {:?} was expected", self.addr, answer.msg_type, T::msg_type());
        }
        T::from_bytes(&answer.data).context("decoding the answer")
    }

    /// Ask, and expect either `T` or the rejection `E` back.
    pub async fn request_fallible<T, E, B>(&self, body: B) -> Result<std::result::Result<T, E>>
    where
        T: Streamable + ChiaProtocolMessage,
        E: Streamable + ChiaProtocolMessage,
        B: Streamable + ChiaProtocolMessage,
    {
        let answer = self.request_raw(body).await?;
        if answer.msg_type == T::msg_type() {
            Ok(Ok(T::from_bytes(&answer.data).context("decoding the answer")?))
        } else if answer.msg_type == E::msg_type() {
            Ok(Err(E::from_bytes(&answer.data).context("decoding the rejection")?))
        } else {
            bail!(
                "{} answered {:?} where {:?} or {:?} was expected",
                self.addr,
                answer.msg_type,
                T::msg_type(),
                E::msg_type()
            )
        }
    }

    /// Ask, and take whatever comes back under the request's id.
    pub async fn request_raw<B>(&self, body: B) -> Result<Message>
    where
        B: Streamable + ChiaProtocolMessage,
    {
        if !self.alive() {
            bail!("connection to {} is closed", self.addr);
        }
        let kind = B::msg_type();
        let wait = self.gate.lock().unwrap().reserve(kind, Instant::now());
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }
        let data = body.to_bytes().context("encoding")?;
        let (tx, rx) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().unwrap().waiting.insert(id, tx);
        if let Err(e) = self.send_message(Message::new(kind, Some(id), data.into())).await {
            self.pending.lock().unwrap().waiting.remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => bail!("connection to {} closed while waiting for {kind:?}", self.addr),
            Err(_) => {
                self.pending.lock().unwrap().waiting.remove(&id);
                bail!("{kind:?} to {} unanswered after {}s", self.addr, REQUEST_TIMEOUT.as_secs())
            }
        }
    }

    /// Write one frame, within [`SEND_TIMEOUT`]. A write that fails or times
    /// out marks the connection dead: the socket is not coming back. A
    /// connection that reads dead once the sink is taken gets no frame, so
    /// nothing starts on one [`Self::close`] has begun closing, its websocket
    /// close given up or not.
    async fn send_message(&self, message: Message) -> Result<()> {
        let bytes = message.to_bytes().context("encoding")?;
        let sent = tokio::time::timeout(SEND_TIMEOUT, async {
            let mut sink = self.sink.lock().await;
            if !self.alive() {
                return None;
            }
            Some(sink.send(WsMessage::Binary(bytes)).await)
        })
        .await;
        match sent {
            Ok(None) => Err(anyhow!("connection to {} is closed", self.addr)),
            Ok(Some(Ok(()))) => Ok(()),
            Ok(Some(Err(e))) => {
                self.alive.store(false, Ordering::Relaxed);
                Err(anyhow!("send to {}: {e}", self.addr))
            }
            Err(_) => {
                self.alive.store(false, Ordering::Relaxed);
                Err(anyhow!("send to {} timed out after {}s", self.addr, SEND_TIMEOUT.as_secs()))
            }
        }
    }

    /// Close the connection: it reads dead at once, every waiting request
    /// learns it, the reader is stopped, and the websocket close frame is
    /// attempted for at most [`CLOSE_TIMEOUT`] before it is given up. This
    /// returns once the reader has gone too, its half of the socket with it
    /// ([`Self::reader_gone`]); the socket itself goes with the last handle on
    /// the connection. A peer that stopped reading cannot hold the caller
    /// here, and a request still waiting for the sink then writes nothing
    /// ([`Self::send_message`]). A connection is closed once: a call made
    /// while another closes it, or after, waits for that close and writes
    /// nothing of its own, so no close frame follows a write the first close
    /// gave up waiting for.
    pub async fn close(&self) {
        self.closed
            .get_or_init(|| async {
                self.stop_reading();
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
                    let mut sink = self.sink.lock().await;
                    let _ = sink.close().await;
                })
                .await;
                self.reader_gone().await;
            })
            .await;
    }

    /// The first, synchronous part of a close: the connection reads dead,
    /// every waiting request learns it, and the reader is aborted.
    fn stop_reading(&self) {
        self.alive.store(false, Ordering::Relaxed);
        {
            let mut pending = self.pending.lock().unwrap();
            pending.waiting.clear();
            pending.handshake = None;
        }
        self.reader.abort();
    }

    /// Until the reader task is gone, and its half of the socket with it:
    /// aborted ([`Self::stop_reading`]), it goes at its next turn, without
    /// reading, or answering a ping, again. Bounded by [`CLOSE_TIMEOUT`] all
    /// the same.
    async fn reader_gone(&self) {
        let mut done = self.reader_done.clone();
        // Never sent on: it returns once the reader task drops the sender,
        // after the stream ([`ReaderHalf`]).
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, done.changed()).await;
    }
}

/// The readers of the connections a lane dials ([`PeerConn::connect_until`]):
/// how many there are, each counted from just before it starts until its
/// half of the socket is gone, and the lane's close signal, at which each
/// stops by itself, whoever holds its connection. A lane that waits for
/// none to be left ([`Self::gone`]) after its close signal waits for every
/// reader it started, the readers of connections it no longer holds
/// included, and for nothing more than each one's next turn: an aborted
/// reader is dropped there, and a signalled one ends there.
pub struct Readers {
    running: watch::Sender<usize>,
    closed: watch::Receiver<bool>,
}

impl Readers {
    /// Readers that stop once `closed` reads true. A reader whose signal's
    /// sender is gone (its lane dropped, not closed) runs on as one with no
    /// lane does.
    pub fn new(closed: watch::Receiver<bool>) -> Self {
        Self { running: watch::Sender::new(0), closed }
    }

    /// Until no reader counted here is left, the half of the socket of each
    /// gone before its count ([`ReaderHalf`]).
    pub async fn gone(&self) {
        let mut running = self.running.subscribe();
        // Never closed: `self` holds the sender.
        let _ = running.wait_for(|running| *running == 0).await;
    }

    /// How many readers are counted (tests).
    #[cfg(test)]
    pub(crate) fn running(&self) -> usize {
        *self.running.borrow()
    }

    /// Count one reader, before it is spawned ([`PeerConn::open`]).
    fn count(&self) -> Counted {
        self.running.send_modify(|running| *running += 1);
        Counted(self.running.clone())
    }
}

/// One reader in a lane's count ([`Readers`]), from just before it is
/// spawned until it is dropped, last of its [`ReaderHalf`].
struct Counted(watch::Sender<usize>);

impl Drop for Counted {
    fn drop(&mut self) {
        self.0.send_modify(|running| *running -= 1);
    }
}

/// The reader's half of the socket, the sender whose drop says the reader
/// is gone ([`PeerConn::reader_gone`]), and the reader's place in its lane's
/// count, if it has one ([`Readers`]). Fields drop in the order they are
/// declared, so the stream goes before `_done`, and `_done` before
/// `_counted`, however the reader task ends: aborted before its first turn,
/// aborted while it waits, at its lane's close signal, or at the stream's
/// end. A lane that finds no reader counted thus finds every one's half of
/// the socket gone, and its done sender with it. Parameters would not do: a
/// future drops them in one order unpolled and in the other once it has run.
/// Keep `stream` first and `_counted` last, and never move either out.
struct ReaderHalf<S = Stream> {
    stream: S,
    _done: watch::Sender<()>,
    _counted: Option<Counted>,
}

/// Ready once `closed` reads true: a lane's close signal ([`Readers`]).
/// Never ready with none, or once the signal's sender is gone with `closed`
/// still false.
async fn close_signal(closed: Option<watch::Receiver<bool>>) {
    if let Some(mut closed) = closed {
        if closed.wait_for(|closed| *closed).await.is_ok() {
            return;
        }
    }
    std::future::pending::<()>().await;
}

/// The reader: answers go to their requests by id; the handshake and the peak
/// announcements, which carry no id, go to their slots; everything else the
/// node does not subscribe to yet (coin-state and mempool updates) is
/// dropped. When the socket ends, or `closed` comes (its lane's close
/// signal, [`close_signal`]), every waiting request learns it and the
/// connection reads dead: the signal ends the loop as the stream's end does,
/// whoever holds the connection, and before a frame ready beside it.
async fn read_loop<S>(
    mut half: ReaderHalf<S>,
    closed: Option<watch::Receiver<bool>>,
    pending: Arc<Mutex<Pending>>,
    peak: watch::Sender<Option<Peak>>,
    peak_at: Arc<Mutex<Option<Instant>>>,
    alive: Arc<AtomicBool>,
) where
    S: futures_util::Stream<Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    let stop = close_signal(closed);
    tokio::pin!(stop);
    loop {
        let frame = tokio::select! {
            biased;
            () = &mut stop => break,
            frame = half.stream.next() => frame,
        };
        let Some(frame) = frame else { break };
        let frame = match frame {
            Ok(frame) => frame,
            Err(_) => break,
        };
        match frame {
            WsMessage::Binary(bytes) => {
                let Ok(message) = Message::from_bytes(&bytes) else { continue };
                if let Some(id) = message.id {
                    let waiting = pending.lock().unwrap().waiting.remove(&id);
                    if let Some(tx) = waiting {
                        let _ = tx.send(message);
                    }
                    continue;
                }
                match message.msg_type {
                    ProtocolMessageTypes::Handshake => {
                        if let Ok(handshake) = Handshake::from_bytes(&message.data) {
                            let slot = pending.lock().unwrap().handshake.take();
                            if let Some(tx) = slot {
                                let _ = tx.send(handshake);
                            }
                        }
                    }
                    ProtocolMessageTypes::NewPeakWallet => {
                        if let Ok(announced) = NewPeakWallet::from_bytes(&message.data) {
                            *peak_at.lock().unwrap() = Some(Instant::now());
                            peak.send_replace(Some(Peak { height: announced.height, header_hash: announced.header_hash }));
                        }
                    }
                    _ => {}
                }
            }
            WsMessage::Close(_) => break,
            // Pings are answered by the websocket layer; text frames are not Chia protocol.
            _ => {}
        }
    }
    alive.store(false, Ordering::Relaxed);
    let mut pending = pending.lock().unwrap();
    pending.waiting.clear();
    pending.handshake = None;
}

/// The window the full node counts requests over.
pub const RATE_WINDOW: Duration = Duration::from_secs(60);

/// How many requests of one kind this node lets itself send per window:
/// under the full node's own limits for wallet peers with room to spare, so
/// a burst waits here instead of earning a ban there.
pub fn rate_limit(kind: ProtocolMessageTypes) -> usize {
    match kind {
        ProtocolMessageTypes::RequestPuzzleState | ProtocolMessageTypes::RequestCoinState => 40,
        ProtocolMessageTypes::SendTransaction => 20,
        ProtocolMessageTypes::RequestTransaction => 60,
        _ => 100,
    }
}

/// Per-kind send times within the window (see [`rate_limit`]).
pub struct RateGate {
    sent: HashMap<ProtocolMessageTypes, VecDeque<Instant>>,
}

impl Default for RateGate {
    fn default() -> Self {
        Self::new()
    }
}

impl RateGate {
    pub fn new() -> Self {
        Self { sent: HashMap::new() }
    }

    /// How long a `kind` request must wait before it may leave at `now`; the
    /// send is recorded at that moment, so successive callers queue up.
    pub fn reserve(&mut self, kind: ProtocolMessageTypes, now: Instant) -> Duration {
        let limit = rate_limit(kind).max(1);
        let sent = self.sent.entry(kind).or_default();
        while sent.front().is_some_and(|t| now.saturating_duration_since(*t) >= RATE_WINDOW) {
            sent.pop_front();
        }
        let wait = if sent.len() < limit {
            Duration::ZERO
        } else {
            let frees_at = sent[sent.len() - limit] + RATE_WINDOW;
            frees_at.saturating_duration_since(now)
        };
        sent.push_back(now + wait);
        wait
    }
}

/// A full node for tests: a TLS websocket server speaking just enough of the
/// peer protocol — the handshake (as whatever node type and network the test
/// says), a `NewPeakWallet` after it when a peak is set, block header 0 with
/// the configured previous hash, and the test's own handler for every other
/// request (its replies are sent under the request's id). Nothing here is
/// compiled into the node.
/// An in-process full node for the tests. Its TLS server demands what a real
/// full node demands, a client certificate the Chia CA signed, and checks it
/// against the CA certificate `chia-ssl` ships ([`chia_ca_roots`]), so every
/// connection test proves the lane presents one; a client without it never
/// gets to the handshake.
#[cfg(test)]
pub(crate) mod mock {
    use super::*;
    use chia_protocol::{
        Bytes, Bytes100, ClassgroupElement, Foliage, FoliageBlockData, HeaderBlock, PoolTarget, ProofOfSpace,
        RewardChainBlock, VDFInfo, VDFProof,
    };

    pub(crate) type Handler = Arc<dyn Fn(&Message) -> Vec<Message> + Send + Sync>;

    /// An in-memory coin set behind two or more mock full nodes, with a
    /// mempool, reorganisations and the announcements a real node makes
    /// (stage 4 design §12, "Mock chain").
    pub(crate) mod chain;

    pub(crate) struct MockNode {
        pub addr: SocketAddr,
        /// The certificate the node presents; [`spawn_as`] brings up a second
        /// address of the same node.
        pub cert: Arc<chia_ssl::ChiaCertificate>,
        /// What the node announces after a handshake; set before clients connect.
        pub peak: Arc<Mutex<Option<Peak>>>,
        /// Every request type received, in order, across connections.
        pub seen: Arc<Mutex<Vec<ProtocolMessageTypes>>>,
        task: JoinHandle<()>,
    }

    impl Drop for MockNode {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    /// A reply body as a protocol message without an id (the server sets the
    /// request's id on handler replies).
    pub(crate) fn reply<T: Streamable + ChiaProtocolMessage>(body: &T) -> Message {
        Message::new(T::msg_type(), None, body.to_bytes().unwrap().into())
    }

    /// A header block at `height` whose previous-header hash is `prev` and
    /// everything else zero: enough for the binding check and for a
    /// deterministic `header_hash()` per height. It is [`header_on`] on the
    /// first fork, byte for byte.
    pub(crate) fn header_at(height: u32, prev: Bytes32) -> HeaderBlock {
        header_on(height, prev, Bytes32::new([0u8; 32]))
    }

    /// A header block at `height` whose previous-header hash is `prev`, with
    /// `fork` as its foliage's reward-block hash and everything else zero.
    /// The header hash covers the foliage alone, not the height, so a chain
    /// of these differs block by block only through `prev`, and a block built
    /// again on the same parent after a reorganisation differs from the one
    /// it replaces only through `fork` ([`chain`], stage 4 design §12).
    pub(crate) fn header_on(height: u32, prev: Bytes32, fork: Bytes32) -> HeaderBlock {
        let zero = Bytes32::new([0u8; 32]);
        let g1 = chia_bls::G1Element::default();
        let g2 = chia_bls::G2Element::default();
        let vdf = VDFInfo::new(zero, 0, ClassgroupElement::new(Bytes100::from([0u8; 100])));
        let proof = VDFProof::new(0, Bytes::new(vec![]), false);
        let pos = ProofOfSpace::new(zero, None, None, g1, 0, Bytes::new(vec![]));
        let reward = RewardChainBlock::new(
            0,
            height,
            0,
            0,
            zero,
            pos,
            None,
            g2.clone(),
            vdf.clone(),
            None,
            g2.clone(),
            vdf,
            None,
            None,
            false,
        );
        let data = FoliageBlockData::new(zero, PoolTarget::new(zero, 0), None, zero, zero);
        let foliage = Foliage::new(prev, fork, data, g2, None, None);
        HeaderBlock::new(vec![], reward, None, proof.clone(), None, proof, None, foliage, None, Bytes::new(vec![]), None)
    }

    /// The handler's replies stamped with the request's id, except an
    /// announcement (`NewPeakWallet`) a handler slips in, which stays
    /// unsolicited so the client files it as the peer's new peak.
    fn answers(handler: &Handler, message: &Message) -> Vec<Message> {
        handler(message)
            .into_iter()
            .map(|mut r| {
                if r.msg_type != ProtocolMessageTypes::NewPeakWallet {
                    r.id = message.id;
                }
                r
            })
            .collect()
    }

    /// The Chia CA certificate `chia-ssl` ships, as the one trust root a full
    /// node checks client certificates against.
    pub(crate) fn chia_ca_roots() -> rustls::RootCertStore {
        let mut roots = rustls::RootCertStore::empty();
        for cert in rustls_pemfile::certs(&mut chia_ssl::CHIA_CA_CRT.as_bytes()) {
            roots.add(cert.unwrap()).unwrap();
        }
        assert_eq!(roots.len(), 1, "the one Chia CA certificate");
        roots
    }

    pub(crate) async fn spawn(network_id: &str, node_type: NodeType, genesis_prev: Bytes32, peak: Option<Peak>, handler: Handler) -> MockNode {
        spawn_on("127.0.0.1:0".parse().unwrap(), network_id, node_type, genesis_prev, peak, handler).await
    }

    /// [`spawn`] on a given address (a test that brings a node up on an
    /// address a lane already knows).
    pub(crate) async fn spawn_on(
        bind: SocketAddr,
        network_id: &str,
        node_type: NodeType,
        genesis_prev: Bytes32,
        peak: Option<Peak>,
        handler: Handler,
    ) -> MockNode {
        spawn_as(bind, Arc::new(chia_ssl::ChiaCertificate::generate().unwrap()), network_id, node_type, genesis_prev, peak, handler).await
    }

    /// [`spawn_on`] presenting a given certificate: a second address of a node
    /// already running ([`MockNode::cert`]), as a dual-stack full node shows
    /// one certificate at both its addresses.
    pub(crate) async fn spawn_as(
        bind: SocketAddr,
        cert: Arc<chia_ssl::ChiaCertificate>,
        network_id: &str,
        node_type: NodeType,
        genesis_prev: Bytes32,
        peak: Option<Peak>,
        handler: Handler,
    ) -> MockNode {
        let listener = tokio::net::TcpListener::bind(bind).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let acceptor = acceptor(&cert);
        let peak = Arc::new(Mutex::new(peak));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let network_id = network_id.to_string();
        let (peak_shared, seen_shared) = (peak.clone(), seen.clone());
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { break };
                let acceptor = acceptor.clone();
                let network_id = network_id.clone();
                let handler = handler.clone();
                let peak = peak_shared.clone();
                let seen = seen_shared.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else { return };
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tls).await else { return };
                    while let Some(Ok(frame)) = ws.next().await {
                        let WsMessage::Binary(bytes) = frame else { continue };
                        let Ok(message) = Message::from_bytes(&bytes) else { continue };
                        seen.lock().unwrap().push(message.msg_type);
                        let replies: Vec<Message> = match message.msg_type {
                            ProtocolMessageTypes::Handshake => {
                                let mut out = vec![reply(&Handshake::new(
                                    network_id.clone(),
                                    PROTOCOL_VERSION.to_string(),
                                    "mock".to_string(),
                                    0,
                                    node_type,
                                    vec![],
                                ))];
                                let announced = *peak.lock().unwrap();
                                if let Some(p) = announced {
                                    out.push(reply(&NewPeakWallet::new(p.header_hash, p.height, 0, 0)));
                                }
                                out
                            }
                            ProtocolMessageTypes::RequestBlockHeader => {
                                let request = RequestBlockHeader::from_bytes(&message.data).unwrap();
                                if request.height == 0 {
                                    let mut r = reply(&RespondBlockHeader::new(header_at(0, genesis_prev)));
                                    r.id = message.id;
                                    vec![r]
                                } else {
                                    answers(&handler, &message)
                                }
                            }
                            _ => answers(&handler, &message),
                        };
                        for r in replies {
                            if ws.send(WsMessage::Binary(r.to_bytes().unwrap())).await.is_err() {
                                return;
                            }
                        }
                    }
                });
            }
        });
        MockNode { addr, cert, peak, seen, task }
    }

    /// The TLS server a full node runs: `cert` presented, a client
    /// certificate the Chia CA signed demanded.
    fn acceptor(cert: &chia_ssl::ChiaCertificate) -> tokio_rustls::TlsAcceptor {
        let (chain, key) = pem_identity(cert).unwrap();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let clients = rustls::server::WebPkiClientVerifier::builder_with_provider(Arc::new(chia_ca_roots()), provider.clone())
            .build()
            .unwrap();
        let config = rustls::ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_client_cert_verifier(clients)
            .with_single_cert(chain, key)
            .unwrap();
        tokio_rustls::TlsAcceptor::from(Arc::new(config))
    }

    /// A node that takes the TLS handshake and the websocket upgrade as a
    /// full node does, then reads every frame and answers none: a dial of it
    /// waits on the Chia handshake, its reader running. `seen` is what it
    /// read; each connection's task ends when its socket does.
    pub(crate) async fn spawn_mute() -> MockNode {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cert = Arc::new(chia_ssl::ChiaCertificate::generate().unwrap());
        let acceptor = acceptor(&cert);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_shared = seen.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else { break };
                let acceptor = acceptor.clone();
                let seen = seen_shared.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else { return };
                    let Ok(mut ws) = tokio_tungstenite::accept_async(tls).await else { return };
                    while let Some(Ok(frame)) = ws.next().await {
                        let WsMessage::Binary(bytes) = frame else { continue };
                        let Ok(message) = Message::from_bytes(&bytes) else { continue };
                        seen.lock().unwrap().push(message.msg_type);
                    }
                });
            }
        });
        MockNode { addr, cert, peak: Arc::new(Mutex::new(None)), seen, task }
    }
}

#[cfg(test)]
mod tests {
    use super::mock::{header_at, reply, spawn, Handler};
    use super::*;
    use chia_protocol::{CoinState, RequestPuzzleState, RespondPuzzleState};

    fn genesis() -> Bytes32 {
        Bytes32::new([7u8; 32])
    }

    fn net() -> Network {
        Network { id: "mocknet".to_string(), genesis: genesis(), port: 0, introducers: vec![], consensus: &chia_sdk_types::TESTNET11_CONSTANTS }
    }

    fn silent() -> Handler {
        Arc::new(|_| vec![])
    }

    fn tls() -> Arc<rustls::ClientConfig> {
        tls_client_config().unwrap()
    }

    /// A certificate chain a CA other than Chia's signed, as a stranger
    /// without `chia-ssl` would present.
    fn foreign_identity() -> (Vec<CertificateDer<'static>>, PrivateKeyDer<'static>) {
        let ca_key = rcgen::KeyPair::generate().unwrap();
        let mut ca = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        ca.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        ca.distinguished_name.push(rcgen::DnType::CommonName, "Not the Chia CA");
        let ca_cert = ca.self_signed(&ca_key).unwrap();
        let key = rcgen::KeyPair::generate().unwrap();
        let cert = rcgen::CertificateParams::new(vec!["chia.net".to_string()]).unwrap().signed_by(&key, &ca_cert, &ca_key).unwrap();
        (vec![cert.der().clone()], PrivateKeyDer::Pkcs8(key.serialize_der().into()))
    }

    /// The mock full node demands what a real one demands: a client
    /// certificate the Chia CA signed. The lane's is admitted; a client with
    /// no certificate, or with one another CA signed, is turned away before
    /// its handshake is read.
    #[tokio::test]
    async fn a_full_node_admits_only_a_client_certificate_the_chia_ca_signed() {
        let peak = Peak { height: 10, header_hash: header_at(10, genesis()).header_hash() };
        let node = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak), silent()).await;
        let conn = PeerConn::connect(node.addr, Source::Introducer, &net(), tls()).await.unwrap();
        assert!(conn.alive(), "the lane's Chia-CA certificate is admitted");
        assert_eq!(node.seen.lock().unwrap().len(), 2, "handshake and binding header read");
        drop(conn);

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let anonymous = rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AnyServer(provider)))
            .with_no_client_auth();
        let refused = PeerConn::connect(node.addr, Source::Introducer, &net(), Arc::new(anonymous)).await;
        assert!(refused.is_err(), "a client with no certificate is refused");
        assert_eq!(node.seen.lock().unwrap().len(), 2, "its handshake was never read");

        let (chain, key) = foreign_identity();
        let refused = PeerConn::connect(node.addr, Source::Introducer, &net(), tls_client_config_for(chain, key).unwrap()).await;
        assert!(refused.is_err(), "a certificate another CA signed is refused");
        assert_eq!(node.seen.lock().unwrap().len(), 2, "its handshake was never read");
    }

    #[tokio::test]
    async fn a_full_node_on_the_right_chain_is_accepted_and_its_peak_kept() {
        let peak = Peak { height: 4242, header_hash: header_at(4242, genesis()).header_hash() };
        let node = spawn("mocknet", NodeType::FullNode, genesis(), Some(peak), silent()).await;
        let conn = PeerConn::connect(node.addr, Source::Introducer, &net(), tls()).await.unwrap();
        assert!(conn.alive());
        assert_eq!(conn.wait_peak(Duration::from_secs(3)).await, Some(peak));
        assert_eq!(conn.source(), Source::Introducer);
        assert_eq!(conn.group(), group_of(node.addr));
        let seen = node.seen.lock().unwrap().clone();
        assert_eq!(seen, vec![ProtocolMessageTypes::Handshake, ProtocolMessageTypes::RequestBlockHeader]);
    }

    #[tokio::test]
    async fn a_peer_on_another_chain_is_refused_whatever_its_handshake_says() {
        let node = spawn("mocknet", NodeType::FullNode, Bytes32::new([8u8; 32]), None, silent()).await;
        let err = PeerConn::connect(node.addr, Source::Introducer, &net(), tls()).await.err().unwrap();
        assert!(err.to_string().contains("genesis challenge"), "{err:#}");
    }

    #[tokio::test]
    async fn a_peer_on_another_network_or_not_a_full_node_is_refused() {
        let other = spawn("mainnet", NodeType::FullNode, genesis(), None, silent()).await;
        let err = PeerConn::connect(other.addr, Source::Pin, &net(), tls()).await.err().unwrap();
        assert!(err.to_string().contains("network"), "{err:#}");
        let wallet = spawn("mocknet", NodeType::Wallet, genesis(), None, silent()).await;
        let err = PeerConn::connect(wallet.addr, Source::Pin, &net(), tls()).await.err().unwrap();
        assert!(err.to_string().contains("not a full node"), "{err:#}");
    }

    /// A mock full node on one of the two real networks: its handshake id
    /// and its block 0, as a real full node of that network would answer.
    async fn full_node_of(net: &Network) -> mock::MockNode {
        spawn(&net.id, NodeType::FullNode, net.genesis, None, silent()).await
    }

    /// A testnet11 full node is refused by a lane bound to mainnet, and a
    /// mainnet full node by a lane bound to testnet11, at the handshake; a
    /// peer that names the right network but serves the other chain's block 0
    /// is refused after it, at the genesis binding. The right pairs connect.
    #[tokio::test]
    async fn a_full_node_of_the_other_real_network_is_refused() {
        let (testnet, mainnet) = (Network::testnet11(), Network::mainnet());
        for (node_net, lane_net) in [(&testnet, &mainnet), (&mainnet, &testnet)] {
            let node = full_node_of(node_net).await;
            let err = PeerConn::connect(node.addr, Source::Introducer, lane_net, tls()).await.err().unwrap();
            assert_eq!(
                err.to_string(),
                format!("peer is on network {:?}, not {}", node_net.id, lane_net.id),
                "refused at the handshake"
            );
            assert_eq!(node.seen.lock().unwrap().clone(), vec![ProtocolMessageTypes::Handshake], "block 0 was never asked for");
            // The handshake alone is advisory: the other chain's block 0
            // under the right name is refused too.
            let liar = spawn(&lane_net.id, NodeType::FullNode, node_net.genesis, None, silent()).await;
            let err = PeerConn::connect(liar.addr, Source::Introducer, lane_net, tls()).await.err().unwrap();
            assert!(err.to_string().contains("genesis challenge"), "{err:#}");
            // The right pair connects.
            let own = full_node_of(lane_net).await;
            let conn = PeerConn::connect(own.addr, Source::Introducer, lane_net, tls()).await.unwrap();
            assert!(conn.alive(), "{}", lane_net.id);
        }
    }

    #[tokio::test]
    async fn answers_find_their_requests_by_id() {
        let handler: Handler = Arc::new(|m| {
            let request = RequestPuzzleState::from_bytes(&m.data).unwrap();
            // Echo the request's header hash back as the peak hash so the test can tell answers apart.
            vec![reply(&RespondPuzzleState::new(request.puzzle_hashes, 9, request.header_hash, true, Vec::<CoinState>::new()))]
        });
        let node = spawn("mocknet", NodeType::FullNode, genesis(), None, handler).await;
        let conn = PeerConn::connect(node.addr, Source::Gossip, &net(), tls()).await.unwrap();
        let filters = chia_protocol::CoinStateFilters::new(true, true, true, 0);
        let a = conn.request::<RespondPuzzleState, _>(RequestPuzzleState::new(vec![], None, Bytes32::new([1u8; 32]), filters.clone(), false));
        let b = conn.request::<RespondPuzzleState, _>(RequestPuzzleState::new(vec![], None, Bytes32::new([2u8; 32]), filters, false));
        let (a, b) = tokio::join!(a, b);
        assert_eq!(a.unwrap().header_hash, Bytes32::new([1u8; 32]));
        assert_eq!(b.unwrap().header_hash, Bytes32::new([2u8; 32]));
        // No peak was configured, so none is announced.
        assert_eq!(conn.wait_peak(Duration::from_millis(200)).await, None);
    }

    /// A request that found the connection alive, then waited for the sink
    /// while the connection closed, writes nothing: not even when the close
    /// gave its websocket close up after [`CLOSE_TIMEOUT`] (the test holds
    /// the sink past it, as a write stuck on a peer that stopped reading
    /// does). The request is told the connection is closed, at once, and
    /// the peer never reads it.
    #[tokio::test]
    async fn a_request_waiting_for_the_sink_when_the_connection_closes_writes_nothing() {
        let node = spawn("mocknet", NodeType::FullNode, genesis(), None, silent()).await;
        let conn = PeerConn::connect(node.addr, Source::Gossip, &net(), tls()).await.unwrap();
        let stuck = conn.sink.lock().await;
        let filters = chia_protocol::CoinStateFilters::new(true, true, true, 0);
        let asking = tokio::spawn({
            let conn = conn.clone();
            async move {
                conn.request::<RespondPuzzleState, _>(RequestPuzzleState::new(vec![], None, Bytes32::new([1u8; 32]), filters, false))
                    .await
            }
        });
        // Its id waits for an answer once it is past the alive check.
        let deadline = Instant::now() + Duration::from_secs(5);
        while conn.pending.lock().unwrap().waiting.is_empty() {
            assert!(Instant::now() < deadline, "the request reaches the sink");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        conn.close().await;
        assert!(!conn.alive());
        assert!(!asking.is_finished(), "the close returned while the request still waits for the sink");
        drop(stuck);
        let err = asking.await.unwrap().unwrap_err().to_string();
        assert!(err.contains("is closed"), "{err}");
        // Time for a frame that went out to reach the peer.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !node.seen.lock().unwrap().contains(&ProtocolMessageTypes::RequestPuzzleState),
            "the peer reads no request written after the close"
        );
    }

    /// A dial abandoned once its reader runs (here the node holds the Chia
    /// handshake) leaves nothing running: by the time `connect_until`
    /// returns, the reader task is gone and the socket dropped, so the node
    /// reads the socket's end, with nothing sent after the handshake. The
    /// runtime's live tasks count the reader (the test runtime is
    /// single-threaded: nothing else runs between the dial's end and the
    /// count).
    #[tokio::test]
    async fn a_dial_abandoned_during_the_handshake_leaves_nothing_running() {
        let node = mock::spawn_mute().await;
        let tasks = || tokio::runtime::Handle::current().metrics().num_alive_tasks();
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        let net = net();
        let dial = PeerConn::connect_until(
            node.addr,
            Source::Gossip,
            &net,
            tls(),
            async {
                let _ = stop_rx.await;
            },
            None,
        );
        let stop = async {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !node.seen.lock().unwrap().contains(&ProtocolMessageTypes::Handshake) {
                assert!(Instant::now() < deadline, "the dial sends its handshake");
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            // The node's listener and its side of the connection, and the reader.
            let running = tasks();
            let _ = stop_tx.send(());
            running
        };
        let (outcome, running) = tokio::join!(dial, stop);
        assert!(outcome.is_none(), "the dial was abandoned");
        assert_eq!(tasks(), running - 1, "the reader is gone once connect_until returns");
        let deadline = Instant::now() + Duration::from_secs(5);
        while tasks() > running - 2 {
            assert!(Instant::now() < deadline, "the node reads the socket's end");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(*node.seen.lock().unwrap(), vec![ProtocolMessageTypes::Handshake], "nothing sent after the handshake");
    }

    /// The reader's half of the socket goes before the reader reads as gone
    /// (#372 review), and before its lane counts it gone (round 4).
    /// [`PeerConn::reader_gone`] returns once the reader's sender drops, and
    /// a closer that returns then drops the last handle on the connection:
    /// a stream dropped after the sender would keep its half of the socket
    /// past close() on a runtime with other workers. The lane's close()
    /// returns once its count of readers is down to zero ([`Readers`]), so
    /// the count goes last. A probe stream records, as it drops, whether the
    /// sender is still there and the reader still counted, however the
    /// reader ends: never polled (aborted before its first turn), dropped
    /// while it waits, at its lane's close signal, or at the stream's end.
    /// At the signal and at the end, a request waiting on the connection
    /// learns it and the connection reads dead.
    #[tokio::test]
    async fn the_readers_half_of_the_socket_goes_before_the_reader_reads_gone() {
        use std::pin::Pin;
        use std::task::{Context, Poll};

        struct Probe {
            ends: bool,
            done: watch::Receiver<()>,
            counted: watch::Receiver<usize>,
            left: Arc<Mutex<Option<(bool, usize)>>>,
        }
        impl futures_util::Stream for Probe {
            type Item = Result<WsMessage, tokio_tungstenite::tungstenite::Error>;
            fn poll_next(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Option<Self::Item>> {
                if self.ends {
                    Poll::Ready(None)
                } else {
                    Poll::Pending
                }
            }
        }
        impl Drop for Probe {
            fn drop(&mut self) {
                *self.left.lock().unwrap() = Some((self.done.has_changed().is_ok(), *self.counted.borrow()));
            }
        }

        #[derive(Debug, PartialEq)]
        enum How {
            NeverPolled,
            DroppedWhileWaiting,
            Signalled,
            StreamEnded,
        }
        for how in [How::NeverPolled, How::DroppedWhileWaiting, How::Signalled, How::StreamEnded] {
            let (done_tx, done_rx) = watch::channel(());
            let (closed_tx, closed_rx) = watch::channel(false);
            let readers = Readers::new(closed_rx);
            let left = Arc::new(Mutex::new(None));
            let probe = Probe { ends: how == How::StreamEnded, done: done_rx, counted: readers.running.subscribe(), left: left.clone() };
            let (peak_tx, _peak_rx) = watch::channel(None);
            let (asked_tx, mut asked_rx) = oneshot::channel();
            let pending = Arc::new(Mutex::new(Pending { waiting: HashMap::from([(1, asked_tx)]), handshake: None }));
            let alive = Arc::new(AtomicBool::new(true));
            let half = ReaderHalf { stream: probe, _done: done_tx, _counted: Some(readers.count()) };
            let reader = read_loop(half, Some(readers.closed.clone()), pending, peak_tx, Arc::new(Mutex::new(None)), alive.clone());
            assert_eq!(readers.running(), 1, "{how:?}: counted from before the reader runs");
            match how {
                How::NeverPolled => drop(reader),
                How::DroppedWhileWaiting => assert!(futures_util::FutureExt::now_or_never(reader).is_none(), "the probe holds the reader"),
                How::Signalled => {
                    let mut reader = Box::pin(reader);
                    assert!(futures_util::FutureExt::now_or_never(&mut reader).is_none(), "the probe holds the reader");
                    closed_tx.send_replace(true);
                    reader.await;
                }
                How::StreamEnded => reader.await,
            }
            assert_eq!(*left.lock().unwrap(), Some((true, 1)), "{how:?}: the stream goes while the reader still reads as running, and counted");
            assert_eq!(readers.running(), 0, "{how:?}: once it is gone, its lane counts it gone");
            if matches!(how, How::Signalled | How::StreamEnded) {
                assert!(!alive.load(Ordering::Relaxed), "{how:?}: the connection reads dead");
                assert!(asked_rx.try_recv().is_err_and(|e| e == oneshot::error::TryRecvError::Closed), "{how:?}: the waiting request learns it");
            }
        }
    }

    /// [`PeerConn::close`] and [`Readers`] with workers in parallel (#372
    /// review). The tests above run on the test's single-threaded runtime;
    /// this runs on four workers, so the closes, the requests and the reader
    /// run at once and their order is the scheduler's. Each of twenty rounds
    /// dials a full node with its reader counted, puts four requests on the
    /// connection and closes it from three tasks at once, the readers' close
    /// signal sent before the closes, beside them or after them, by the
    /// round. Each close returns within its bound with the connection dead
    /// and closed and its reader gone, its done watch closed (read in the
    /// task that called it); every request ends; and the count is back to
    /// zero once [`Readers::gone`] returns. A pass shows the promises held in
    /// the orders these rounds happened to run; it is not one of the
    /// deterministic regressions, which stay as they are. Each round is
    /// bounded, so a hang fails the test.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn the_close_promises_hold_with_workers_in_parallel() {
        let handler: Handler = Arc::new(|m| match m.msg_type {
            ProtocolMessageTypes::RequestPuzzleState => {
                let request = RequestPuzzleState::from_bytes(&m.data).unwrap();
                vec![reply(&RespondPuzzleState::new(request.puzzle_hashes, 9, request.header_hash, true, Vec::<CoinState>::new()))]
            }
            _ => vec![],
        });
        let node = spawn("mocknet", NodeType::FullNode, genesis(), None, handler).await;
        let (net, tls) = (net(), tls());
        for round in 0..20u8 {
            let signal_at = round % 3;
            let ended = tokio::time::timeout(Duration::from_secs(30), async {
                let (signal, closed) = watch::channel(false);
                let readers = Readers::new(closed);
                let conn = PeerConn::connect_until(node.addr, Source::Gossip, &net, tls.clone(), std::future::pending::<()>(), Some(&readers))
                    .await
                    .expect("never stopped")
                    .expect("the dial connects");
                let requests: Vec<JoinHandle<()>> = (0..4u8)
                    .map(|i| {
                        let conn = conn.clone();
                        tokio::spawn(async move {
                            let filters = chia_protocol::CoinStateFilters::new(true, true, true, 0);
                            let ask = RequestPuzzleState::new(vec![], None, Bytes32::new([round.wrapping_mul(4).wrapping_add(i); 32]), filters, false);
                            let _ = conn.request::<RespondPuzzleState, _>(ask).await;
                        })
                    })
                    .collect();
                if signal_at == 0 {
                    signal.send_replace(true);
                }
                let closes: Vec<JoinHandle<(bool, bool, bool, bool)>> = (0..3)
                    .map(|_| {
                        let conn = conn.clone();
                        tokio::spawn(async move {
                            let returned = tokio::time::timeout(Duration::from_secs(10), conn.close()).await.is_ok();
                            (returned, conn.alive(), conn.closed_for_test(), conn.reader_done_for_test().has_changed().is_err())
                        })
                    })
                    .collect();
                if signal_at == 1 {
                    signal.send_replace(true);
                }
                for close in closes {
                    let (returned, alive, closed, gone) =
                        tokio::time::timeout(Duration::from_secs(15), close).await.expect("the close task ends").unwrap();
                    assert!(returned, "round {round}, signal {signal_at}: close() returns within its bound");
                    assert!(!alive && closed, "round {round}, signal {signal_at}: the connection is dead and closed once close() returns");
                    assert!(gone, "round {round}, signal {signal_at}: the reader is gone once close() returns");
                }
                if signal_at == 2 {
                    signal.send_replace(true);
                }
                for request in requests {
                    tokio::time::timeout(Duration::from_secs(15), request).await.expect("the request ends").unwrap();
                }
                tokio::time::timeout(Duration::from_secs(5), readers.gone()).await.expect("the count is back to zero");
                assert_eq!(readers.running(), 0, "round {round}, signal {signal_at}: no reader counted");
            })
            .await;
            assert!(ended.is_ok(), "round {round} ends within its bound");
        }
    }

    #[test]
    fn the_rate_gate_delays_the_request_past_the_limit_until_the_oldest_leaves_the_window() {
        let mut gate = RateGate::new();
        let t0 = Instant::now();
        let kind = ProtocolMessageTypes::SendTransaction;
        for i in 0..rate_limit(kind) {
            assert_eq!(gate.reserve(kind, t0 + Duration::from_secs(i as u64)), Duration::ZERO);
        }
        // The 21st at t0+20s waits until the first (t0) leaves the window at t0+60s.
        let at = t0 + Duration::from_secs(20);
        assert_eq!(gate.reserve(kind, at), Duration::from_secs(40));
        // Another kind has its own window.
        assert_eq!(gate.reserve(ProtocolMessageTypes::RequestPuzzleState, at), Duration::ZERO);
        // Past the window everything is free again.
        assert_eq!(gate.reserve(kind, t0 + Duration::from_secs(200)), Duration::ZERO);
    }

    #[test]
    fn groups_follow_the_prefix_and_loopback_follows_the_port() {
        let a: SocketAddr = "203.0.113.5:58444".parse().unwrap();
        let b: SocketAddr = "203.0.200.9:58444".parse().unwrap();
        let c: SocketAddr = "198.51.100.1:58444".parse().unwrap();
        assert_eq!(group_of(a), group_of(b), "same /16");
        assert_ne!(group_of(a), group_of(c));
        let v6a: SocketAddr = "[2001:db8:1::1]:58444".parse().unwrap();
        let v6b: SocketAddr = "[2001:db8:2::1]:58444".parse().unwrap();
        let v6c: SocketAddr = "[2001:db9::1]:58444".parse().unwrap();
        assert_eq!(group_of(v6a), group_of(v6b), "same /32");
        assert_ne!(group_of(v6a), group_of(v6c));
        let l1: SocketAddr = "127.0.0.1:1001".parse().unwrap();
        let l2: SocketAddr = "127.0.0.1:1002".parse().unwrap();
        assert_ne!(group_of(l1), group_of(l2), "two local full nodes count as distinct");
        assert_ne!(group_of(l1), group_of(a));
        // An IPv4-mapped IPv6 spelling is the IPv4 address it maps: one group, one address.
        let mapped: SocketAddr = "[::ffff:203.0.113.5]:58444".parse().unwrap();
        assert_eq!(group_of(mapped), group_of(a), "mapped and native forms share the /16 group");
        assert_eq!(canonical(mapped), a);
        assert_eq!(canonical(a), a);
        // A native IPv6 address keeps its scope id: the link is part of the address.
        let scoped = SocketAddr::V6(std::net::SocketAddrV6::new("fe80::1".parse().unwrap(), 58444, 0, 3));
        assert_eq!(canonical(scoped), scoped, "the scope id survives");
        assert_eq!(group_of(scoped), group_of("[fe80::2]:58444".parse().unwrap()), "and the /32 group ignores it");
        let mapped_loop: SocketAddr = "[::ffff:127.0.0.1]:1001".parse().unwrap();
        assert_eq!(group_of(mapped_loop), group_of(l1));
    }

    #[test]
    fn an_ipv4_in_ipv6_clothing_shares_its_ipv4_group() {
        // A node reached at a public IPv4 address may be gossiped under the
        // alias a NAT64 host, a 6to4 relay or the deprecated compatible form
        // gives it. The public-address judge admits each as that IPv4, and
        // the group follows, so one node never supplies both of a money
        // read's votes under two spellings. The spelling itself is kept: the
        // alias is how the host that gossiped it reaches the node.
        let v4: SocketAddr = "203.0.113.5:58444".parse().unwrap();
        let nat64: SocketAddr = "[64:ff9b::203.0.113.5]:58444".parse().unwrap();
        let six_to_four: SocketAddr = "[2002:cb00:7105::1]:58444".parse().unwrap();
        let compatible: SocketAddr = "[::203.0.113.5]:58444".parse().unwrap();
        for alias in [nat64, six_to_four, compatible] {
            assert_eq!(group_of(alias), group_of(v4), "{alias}");
            assert_eq!(canonical(alias), alias, "{alias}: the spelling is kept");
        }
        let elsewhere: SocketAddr = "[64:ff9b::198.51.100.1]:58444".parse().unwrap();
        assert_ne!(group_of(elsewhere), group_of(v4), "another IPv4 behind the same prefix is another group");
        // The local-use translation prefix and Teredo carry no address the
        // lane would dial as that IPv4: native /32 groups, as the judge has it.
        let local_use: SocketAddr = "[64:ff9b:1::203.0.113.5]:58444".parse().unwrap();
        let teredo: SocketAddr = "[2001:0:cb00:7105::1]:58444".parse().unwrap();
        assert_ne!(group_of(local_use), group_of(v4));
        assert_ne!(group_of(teredo), group_of(v4));
        assert_eq!(group_of(local_use), group_of("[64:ff9b:1:ffff::1]:58444".parse().unwrap()), "the /32");
        assert_eq!(embedded_ipv4("::1".parse().unwrap()), None);
        assert_eq!(embedded_ipv4("::".parse().unwrap()), None);
        assert_eq!(embedded_ipv4("::ffff:127.0.0.1".parse().unwrap()), Some(Ipv4Addr::LOCALHOST));
    }

    #[test]
    fn testnet11_is_what_the_lane_binds_to() {
        let net = Network::testnet11();
        assert_eq!(net.id, "testnet11");
        assert_eq!(net.port, 58444);
        assert_eq!(net.genesis.to_string(), "37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615");
        assert_eq!(net.introducers, vec!["dns-introducer-testnet11.chia.net"]);
    }

    /// The one literal test of mainnet's peer network: the handshake id
    /// Chia's mainnet full nodes send, the genesis challenge of
    /// MAINNET_CONSTANTS, port 8444 and Chia's own introducer, the only one.
    #[test]
    fn mainnet_is_chias_own_main_network() {
        let net = Network::mainnet();
        assert_eq!(net.id, "mainnet");
        assert_eq!(net.port, 8444);
        assert_eq!(net.genesis, chia_sdk_types::MAINNET_CONSTANTS.genesis_challenge);
        assert_eq!(net.genesis.to_string(), "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb");
        assert_eq!(net.introducers, vec!["dns-introducer.chia.net"], "Chia's own introducer and no third-party seeder");
        assert_ne!(net, Network::testnet11());
    }

    /// Each peer network agrees with its `ChiaNet`: the id, the port and
    /// the genesis the rest of the node uses.
    #[test]
    fn each_peer_network_matches_its_chia_net() {
        for chia_net in ChiaNet::ALL {
            let net = Network::of(chia_net);
            assert_eq!(net.id, chia_net.id(), "{chia_net:?}");
            assert_eq!(net.port, chia_net.port(), "{chia_net:?}");
            assert_eq!(net.genesis, chia_net.constants().genesis_challenge, "{chia_net:?}");
            assert_eq!(net.genesis.to_string(), chia_net.genesis_hex(), "{chia_net:?}");
            assert_eq!(net.introducers.len(), 1, "{chia_net:?}");
            assert!(std::ptr::eq(net.consensus, chia_net.constants()), "{chia_net:?}: its own consensus constants");
        }
        assert_eq!(Network::of(ChiaNet::Testnet11), Network::testnet11());
        assert_eq!(Network::of(ChiaNet::Mainnet), Network::mainnet());
    }
}
