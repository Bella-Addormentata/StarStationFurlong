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
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use chia_protocol::{
    Bytes32, ChiaProtocolMessage, Handshake, Message, NewPeakWallet, NodeType, ProtocolMessageTypes,
    RejectHeaderRequest, RequestBlockHeader, RespondBlockHeader,
};
use chia_traits::Streamable;
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
/// One bound for the TCP connect, the TLS handshake, the websocket upgrade and
/// the Chia handshake, each.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
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
/// §14 (4) binding), the full nodes' default port and the DNS introducers that
/// bootstrap peer discovery (the same class as the mesh's DHT bootstrap nodes;
/// see the External Infrastructure Register).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Network {
    pub id: String,
    pub genesis: Bytes32,
    pub port: u16,
    pub introducers: Vec<String>,
}

impl Network {
    pub fn testnet11() -> Self {
        Self {
            id: "testnet11".to_string(),
            genesis: chia_sdk_types::TESTNET11_CONSTANTS.genesis_challenge,
            port: 58444,
            introducers: vec!["dns-introducer-testnet11.chia.net".to_string()],
        }
    }
}

/// Where a peer's address came from (plan §14 (2)): an agreement needs two
/// peers from DISTINCT sources, one of them fresh (a pin, or the introducer
/// this run), so a poisoned peer store cannot make an eclipse sticky.
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
}

/// A peer's network group (plan §14 (2)): two agreeing peers must sit in
/// different ones. IPv4 groups by /16 and IPv6 by /32, as Chia's own peer
/// manager does; loopback groups by PORT, so two full nodes on this machine
/// (a drill, or the tests' mock nodes) count as distinct while one machine
/// running one node does not. An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`)
/// is the IPv4 address it maps, so one peer cannot count twice under its two
/// spellings.
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
        IpAddr::V6(v6) => {
            let o = v6.octets();
            Group([6, o[0], o[1], o[2], o[3]])
        }
    }
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
    /// Where the address came from; may move to a fresher source
    /// ([`Self::promote`]) when the introducer names it this run.
    source: Mutex<Source>,
    group: Group,
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
    /// Open, handshake and bind one connection (see the module notes). `Err`
    /// names what the peer failed: unreachable, not a full node, another
    /// network, or block 0 not descending from the configured genesis.
    pub async fn connect(addr: SocketAddr, source: Source, net: &Network, tls: Arc<rustls::ClientConfig>) -> Result<Arc<Self>> {
        let addr = canonical(addr);
        let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(addr))
            .await
            .map_err(|_| anyhow!("tcp connect timed out"))?
            .context("tcp connect")?;
        let _ = tcp.set_nodelay(true);
        let name = ServerName::IpAddress(addr.ip().into());
        let tls_stream = tokio::time::timeout(CONNECT_TIMEOUT, tokio_rustls::TlsConnector::from(tls).connect(name, tcp))
            .await
            .map_err(|_| anyhow!("tls handshake timed out"))?
            .context("tls handshake")?;
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
        let reader = tokio::spawn(read_loop(stream, pending.clone(), peak_tx, peak_at.clone(), alive.clone()));
        let conn = Arc::new(Self {
            addr,
            source: Mutex::new(source),
            group: group_of(addr),
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
        });
        conn.send(Handshake::new(
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
        let header = conn
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
        Ok(conn)
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    pub fn source(&self) -> Source {
        *self.source.lock().unwrap()
    }

    /// A fresher provenance for the same address: a stored or gossiped peer
    /// the introducer names this run counts as an introducer peer from then
    /// on, and a public connection to an address a pin resolves to counts as
    /// the pin. Nothing moves away from fresh except up to a pin, and a pin is
    /// never relabelled.
    pub fn promote(&self, to: Source) -> bool {
        let mut source = self.source.lock().unwrap();
        let up = match to {
            Source::Pin => *source != Source::Pin,
            Source::Introducer => !source.is_fresh(),
            Source::Store | Source::Gossip => false,
        };
        if up {
            *source = to;
        }
        up
    }

    pub fn group(&self) -> Group {
        self.group
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
    /// out marks the connection dead: the socket is not coming back.
    async fn send_message(&self, message: Message) -> Result<()> {
        let bytes = message.to_bytes().context("encoding")?;
        let sent = tokio::time::timeout(SEND_TIMEOUT, async {
            let mut sink = self.sink.lock().await;
            sink.send(WsMessage::Binary(bytes)).await
        })
        .await;
        match sent {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => {
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
    /// learns it, the reader stops, and the websocket close frame is attempted
    /// for at most [`CLOSE_TIMEOUT`] before the socket is simply dropped. A
    /// peer that stopped reading cannot hold the caller here.
    pub async fn close(&self) {
        self.alive.store(false, Ordering::Relaxed);
        {
            let mut pending = self.pending.lock().unwrap();
            pending.waiting.clear();
            pending.handshake = None;
        }
        self.reader.abort();
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
            let mut sink = self.sink.lock().await;
            let _ = sink.close().await;
        })
        .await;
    }
}

/// The reader: answers go to their requests by id; the handshake and the peak
/// announcements, which carry no id, go to their slots; everything else the
/// node does not subscribe to yet (coin-state and mempool updates) is
/// dropped. When the socket ends, every waiting request learns it.
async fn read_loop(
    mut stream: Stream,
    pending: Arc<Mutex<Pending>>,
    peak: watch::Sender<Option<Peak>>,
    peak_at: Arc<Mutex<Option<Instant>>>,
    alive: Arc<AtomicBool>,
) {
    while let Some(frame) = stream.next().await {
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
#[cfg(test)]
pub(crate) mod mock {
    use super::*;
    use chia_protocol::{
        Bytes, Bytes100, ClassgroupElement, Foliage, FoliageBlockData, HeaderBlock, PoolTarget, ProofOfSpace,
        RewardChainBlock, VDFInfo, VDFProof,
    };

    pub(crate) type Handler = Arc<dyn Fn(&Message) -> Vec<Message> + Send + Sync>;

    pub(crate) struct MockNode {
        pub addr: SocketAddr,
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
    /// deterministic `header_hash()` per height.
    pub(crate) fn header_at(height: u32, prev: Bytes32) -> HeaderBlock {
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
        let foliage = Foliage::new(prev, zero, data, g2, None, None);
        HeaderBlock::new(vec![], reward, None, proof.clone(), None, proof, None, foliage, None, Bytes::new(vec![]), None)
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
        let listener = tokio::net::TcpListener::bind(bind).await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cert = chia_ssl::ChiaCertificate::generate().unwrap();
        let (chain, key) = pem_identity(&cert).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(chain, key)
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
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
                                    handler(&message).into_iter().map(|mut r| { r.id = message.id; r }).collect()
                                }
                            }
                            _ => handler(&message).into_iter().map(|mut r| { r.id = message.id; r }).collect(),
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
        MockNode { addr, peak, seen, task }
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
        Network { id: "mocknet".to_string(), genesis: genesis(), port: 0, introducers: vec![] }
    }

    fn silent() -> Handler {
        Arc::new(|_| vec![])
    }

    fn tls() -> Arc<rustls::ClientConfig> {
        tls_client_config().unwrap()
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
    fn testnet11_is_what_the_lane_binds_to() {
        let net = Network::testnet11();
        assert_eq!(net.id, "testnet11");
        assert_eq!(net.port, 58444);
        assert_eq!(net.genesis.to_string(), "37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615");
        assert_eq!(net.introducers, vec!["dns-introducer-testnet11.chia.net"]);
    }
}
