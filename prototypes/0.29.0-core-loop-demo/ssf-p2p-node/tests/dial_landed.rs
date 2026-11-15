//! 🎯 A dial that lands is told to every page of the room, through the real
//! binary: two `ssf-p2p-node` processes on this computer, the holder and the
//! newcomer, each in a directory of its own, and one stand-in page on each,
//! which is a WebTransport client that reads and asks as the game's page
//! does.
//!
//! What it guards: a page's question (a sync frame, SyncStep1) is what tells
//! a dialed node which room a new connection is for. Until a frame names the
//! room the dialed node says nothing on it, and the dialing node drops it as
//! silent after three missed heartbeats. The game's page asks when its node
//! tells it a dial landed (`connected`), and it hears that only on a stream
//! the NODE opens toward it: on the stream the page opened itself, the one
//! its envelope went out on, it reads sync frames and nothing else. A node
//! that wrote `connected` on the page's own stream alone was never heard, so
//! a dial that landed after the page had stopped asking by itself (it asks
//! every 2 s for its first 30 s in a room) connected the two nodes and never
//! linked the room: a dial opened by a DHT knock between two home routers
//! landed after 46 s and was dropped as silent 16 s later (2026-11-14).
//!
//! The newcomer's stand-in page asks once, which starts the dial, and then
//! only when it hears `connected` on a stream its node opened, which is the
//! game's page after its first 30 s. The test passes when:
//!
//! 1. that page hears `connected` for the holder on a stream its node opened;
//! 2. its next question reaches the holder's page, and the holder's node
//!    answers it from the room it keeps, so the link carries the room both
//!    ways;
//! 3. neither node has dropped the other as silent once the time a silent
//!    connection is given has passed.
//!
//! Nothing outside this computer is spoken to: no Chia (`SSF_NO_CHIA_LANE=1`),
//! no Mainline DHT, no mDNS, no public-address echo and no relay, and the
//! dial's one address is loopback. iroh's port mapper stays on, since no
//! `SSF_*` variable turns it off: when the endpoint binds, it asks the local
//! network's gateway for a mapping (UPnP, NAT-PMP or PCP). The test's own
//! `SSF_*` variables are not passed on to the nodes.
//!
//! The two nodes take the HTTP API's two ports (127.0.0.1:8080 and 8081), as
//! tests/strict_lane.rs's node takes the first of them: cargo runs one test
//! file at a time, and this file holds one test. It takes about half a
//! minute, most of it the wait of (3), so it runs once per CI run, in the
//! default feature set, which the cfg below names: what it guards is the
//! same code in every feature set.
#![cfg(not(any(feature = "chia-publish", feature = "torrent", feature = "house-fold")))]

use std::fs::File;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::prelude::*;
use serde_json::{json, Value};
use tokio::sync::mpsc;

const BIN: &str = env!("CARGO_BIN_EXE_ssf-p2p-node");

/// The line that names the node's HTTP port (src/main.rs).
const HTTP_LINE: &str = "Local HTTP API server listening on http://127.0.0.1:";

/// The origin of the page's requests: a loopback page (vite's).
const PAGE: &str = "http://localhost:5173";

/// The dialing node's line for a dial that landed, the dialed node's line for
/// a connection that came in, and the line for a connection dropped as silent
/// (src/main.rs).
const SECURED: &str = "Iroh connection secured to peer node";
const INBOUND: &str = "Inbound P2P Swarm handshake from peer";
const PRUNE: &str = "PRUNE peer";

/// The room both pages are in. No key and no pass: the nodes know nothing
/// of it but its name, as on a first visit before the door documents synced.
const ROOM: &str = "home-dial-landed-test";

/// How long a node may take to start its HTTP API.
const START_BOUND: Duration = Duration::from_secs(60);

/// How long a loopback dial may take to land and be told. The first attempt
/// lands in well under a second; the bound leaves room for a slow runner.
const DIAL_BOUND: Duration = Duration::from_secs(30);

/// Once the newcomer's page has heard `connected` on its own stream, how much
/// longer the same word may take on a stream its node opened. A node that
/// tells every page does so before it writes on the page's own stream.
const AFTER_OWN_STREAM: Duration = Duration::from_secs(5);

/// How long a question or its answer may take across a link that is up.
const LINK_BOUND: Duration = Duration::from_secs(15);

/// How long a silent connection is given, counted from the moment it landed:
/// three heartbeats of 5 s missed (`HEARTBEAT_MISS`, `HEARTBEAT_INTERVAL_SECS`
/// in src/main.rs), then up to one more 5 s tick for the check to come round,
/// and a margin.
const SILENT_BOUND: Duration = Duration::from_secs(3 * 5 + 5 + 3);

/// How often a wait looks again.
const POLL: Duration = Duration::from_millis(100);

/// A directory of the test's own under the system's temporary directory:
/// `node/`, the node's working directory, and `node.log` beside it. Removed,
/// with what is in it, once dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let root = std::env::temp_dir().join(format!("ssf-dial-landed-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(root.join("node")).expect("the scratch directory");
        Self(root)
    }

    fn cwd(&self) -> PathBuf {
        self.0.join("node")
    }

    fn log(&self) -> PathBuf {
        self.0.join("node.log")
    }

    /// The log, as text.
    fn text(&self) -> String {
        String::from_utf8_lossy(&std::fs::read(self.log()).unwrap_or_default()).into_owned()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The log's last lines, for a failure.
fn tail(log: &Path) -> String {
    let text = String::from_utf8_lossy(&std::fs::read(log).unwrap_or_default()).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(40)..].join("\n")
}

/// Two UDP ports free on every IPv4 address of this computer at this
/// moment, which is how a node binds them: one for its game socket and one
/// for its page socket. Both sockets are held until both numbers are read,
/// so the two differ.
fn free_udp_ports() -> (u16, u16) {
    let a = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("a free port");
    let b = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).expect("a second free port");
    (a.local_addr().expect("its address").port(), b.local_addr().expect("its address").port())
}

/// A node as a child process, its stdout and stderr in the scratch log.
/// Killed and waited for once dropped, so a failing assertion never leaves
/// one running.
struct Node {
    child: Option<Child>,
    who: &'static str,
    iroh_port: u16,
}

impl Node {
    /// Start a node in `scratch`'s directory on two free ports. The test's
    /// own `SSF_*` variables are removed first; the rest of its environment
    /// (PATH, HOME, TMPDIR and the like) is passed on.
    fn start(scratch: &Scratch, who: &'static str) -> Self {
        let (iroh_port, wt_port) = free_udp_ports();
        let log = File::create(scratch.log()).expect("the node's log");
        let mut command = Command::new(BIN);
        command
            .current_dir(scratch.cwd())
            .stdin(Stdio::null())
            .stdout(log.try_clone().expect("the log for stdout"))
            .stderr(log);
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().to_ascii_uppercase().starts_with("SSF_") {
                command.env_remove(&key);
            }
        }
        command
            .env("SSF_NO_CHIA_LANE", "1")
            .env("SSF_NO_DHT", "1")
            .env("SSF_NO_MDNS", "1")
            .env("SSF_EXTERNAL_ADDRS", "off")
            .env("SSF_IROH_PORT", iroh_port.to_string())
            .env("SSF_WT_PORT", wt_port.to_string());
        let child = command.spawn().expect("the node starts");
        Self { child: Some(child), who, iroh_port }
    }

    /// Fail, with the log's last lines, if the node has exited.
    fn must_run(&mut self, scratch: &Scratch) {
        let child = self.child.as_mut().expect("the node runs");
        if let Some(status) = child.try_wait().expect("the node's status") {
            panic!("{}: the node exited ({status}). Its log ends:\n{}", self.who, tail(&scratch.log()));
        }
    }

    /// Wait for the node's HTTP API and return its port, from the log line.
    fn http_port(&mut self, scratch: &Scratch) -> u16 {
        let started = Instant::now();
        loop {
            self.must_run(scratch);
            let log = scratch.text();
            if let Some(at) = log.find(HTTP_LINE) {
                let rest = &log[at + HTTP_LINE.len()..];
                if let Some(port) = rest.split(|c: char| !c.is_ascii_digit()).next().and_then(|digits| digits.parse().ok()) {
                    return port;
                }
            }
            assert!(
                started.elapsed() < START_BOUND,
                "{}: no HTTP API within {START_BOUND:?}. Its log ends:\n{}",
                self.who,
                tail(&scratch.log())
            );
            std::thread::sleep(POLL);
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// What a page needs of its node, as the game's page reads it from
/// `GET /api/fingerprint`: the node's id, the page port, and the SHA-256 of
/// the page port's certificate.
struct Fingerprint {
    node_id: String,
    wt_port: u16,
    cert: [u8; 32],
}

fn fingerprint(http_port: u16, who: &str) -> Fingerprint {
    let mut socket = TcpStream::connect(("127.0.0.1", http_port)).expect("the node's HTTP API");
    socket.set_read_timeout(Some(Duration::from_secs(30))).expect("a read timeout");
    let request = format!("GET /api/fingerprint HTTP/1.1\r\nHost: 127.0.0.1:{http_port}\r\nOrigin: {PAGE}\r\nConnection: close\r\n\r\n");
    socket.write_all(request.as_bytes()).expect("the request is sent");
    let mut answer = Vec::new();
    socket.read_to_end(&mut answer).expect("the answer");
    let answer = String::from_utf8_lossy(&answer).into_owned();
    let body = answer.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or_default();
    let fp: Value = serde_json::from_str(body).unwrap_or_else(|e| panic!("{who}: the fingerprint is not JSON ({e}): {answer}"));
    let node_id = fp["iroh_node_id"].as_str().unwrap_or_else(|| panic!("{who}: the fingerprint names no node id")).to_string();
    let wt_port = fp["port"].as_u64().and_then(|port| u16::try_from(port).ok()).unwrap_or_else(|| panic!("{who}: the fingerprint names no page port"));
    let cert = fp["base64"]
        .as_str()
        .and_then(|b64| BASE64_STANDARD.decode(b64).ok())
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .unwrap_or_else(|| panic!("{who}: the fingerprint names no certificate hash"));
    Fingerprint { node_id, wt_port, cert }
}

/// A sync frame's payload that asks for everything: message type 0 (sync),
/// subtype 0 (SyncStep1), and an empty state vector (length 1, no clients).
const SYNC_STEP_1: [u8; 4] = [0, 0, 1, 0];

/// One envelope a page heard from its node, and on which stream: the stream
/// the page opened itself (`own`), or one the node opened toward it.
#[derive(Debug)]
struct Heard {
    own: bool,
    envelope: Value,
}

impl Heard {
    fn kind(&self) -> &str {
        self.envelope["kind"].as_str().unwrap_or("")
    }

    /// The node the envelope came through or was built by.
    fn from_node(&self) -> &str {
        self.envelope["iroh_node_id"].as_str().unwrap_or("")
    }

    /// The envelope's payload, which the wire carries as base64.
    fn payload(&self) -> Vec<u8> {
        self.envelope["payload"].as_str().and_then(|b64| BASE64_STANDARD.decode(b64).ok()).unwrap_or_default()
    }

    /// A `bridge` envelope's dial status and the node it is about.
    fn dial_status(&self) -> Option<(String, String)> {
        if self.kind() != "bridge" {
            return None;
        }
        let body: Value = serde_json::from_slice(&self.payload()).ok()?;
        Some((body["status"].as_str()?.to_string(), body["target"].as_str().unwrap_or("").to_string()))
    }

    /// A sync frame's subtype: 0 a question (SyncStep1), 1 its answer
    /// (SyncStep2), 2 an update.
    fn sync_subtype(&self) -> Option<u8> {
        let payload = self.payload();
        (self.kind() == "ysync" && payload.first() == Some(&0)).then(|| payload.get(1).copied()).flatten()
    }

    /// One line for a failure message.
    fn line(&self) -> String {
        let stream = if self.own { "the page's own stream" } else { "a stream the node opened" };
        let what = match (self.dial_status(), self.sync_subtype()) {
            (Some((status, target)), _) => format!("bridge `{status}` for {}", short(&target)),
            (_, Some(subtype)) => format!("ysync subtype {subtype} through {}", short(self.from_node())),
            _ => self.kind().to_string(),
        };
        format!("{what}, on {stream}")
    }
}

fn short(node_id: &str) -> String {
    node_id.chars().take(8).collect()
}

/// A length-prefixed envelope, as both directions frame it.
fn framed(envelope: &Value) -> Vec<u8> {
    let bytes = serde_json::to_vec(envelope).expect("an envelope");
    let mut frame = (bytes.len() as u32).to_le_bytes().to_vec();
    frame.extend_from_slice(&bytes);
    frame
}

/// Read a stream's envelopes into `heard` until the stream ends.
async fn read_stream(mut recv: wtransport::RecvStream, own: bool, heard: mpsc::UnboundedSender<Heard>) {
    loop {
        let mut length = [0u8; 4];
        if recv.read_exact(&mut length).await.is_err() {
            return;
        }
        let mut bytes = vec![0u8; u32::from_le_bytes(length) as usize];
        if recv.read_exact(&mut bytes).await.is_err() {
            return;
        }
        let Ok(envelope) = serde_json::from_slice(&bytes) else { return };
        if heard.send(Heard { own, envelope }).is_err() {
            return;
        }
    }
}

/// A stand-in for the game's page: a WebTransport session to this computer's
/// node, one stream of its own that its questions go out on, and a reader on
/// that stream and on every stream the node opens.
struct Page {
    who: &'static str,
    _endpoint: wtransport::Endpoint<wtransport::endpoint::endpoint_side::Client>,
    _connection: wtransport::Connection,
    own: wtransport::SendStream,
    heard: mpsc::UnboundedReceiver<Heard>,
    /// What was heard and passed over while waiting for something else.
    passed: Vec<Heard>,
    seq: u32,
}

impl Page {
    async fn open(who: &'static str, node: &Fingerprint) -> Self {
        let config = wtransport::ClientConfig::builder()
            // IPv4 loopback, where the node is dialled: the default bind is an
            // IPv6 socket, which a computer without IPv6 does not have.
            .with_bind_address(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
            .with_server_certificate_hashes([wtransport::tls::Sha256Digest::new(node.cert)])
            .keep_alive_interval(Some(Duration::from_secs(3)))
            .build();
        let endpoint = wtransport::Endpoint::client(config).expect("the page's socket");
        let connection = endpoint
            .connect(format!("https://127.0.0.1:{}", node.wt_port))
            .await
            .unwrap_or_else(|e| panic!("{who}: no session with the node on UDP {}: {e}", node.wt_port));
        let (own, own_recv) = connection.open_bi().await.expect("a stream is asked for").await.expect("the page's own stream");
        let (tx, heard) = mpsc::unbounded_channel();
        tokio::spawn(read_stream(own_recv, true, tx.clone()));
        let accepting = connection.clone();
        tokio::spawn(async move {
            while let Ok((_send, recv)) = accepting.accept_bi().await {
                tokio::spawn(read_stream(recv, false, tx.clone()));
            }
        });
        Self { who, _endpoint: endpoint, _connection: connection, own, heard, passed: Vec::new(), seq: 0 }
    }

    /// Ask the room for its state (SyncStep1) on the page's own stream, with
    /// the dial hints of `toward` when given: its node id and one address,
    /// as an invite's member hints carry them.
    async fn ask(&mut self, toward: Option<(&str, String)>) {
        self.seq += 1;
        let mut envelope = json!({
            "v": 1,
            "room": ROOM,
            "kind": "ysync",
            "seq": self.seq,
            "author": BASE64_STANDARD.encode([0u8; 32]),
            "payload": BASE64_STANDARD.encode(SYNC_STEP_1),
        });
        if let Some((node_id, addr)) = toward {
            envelope["iroh_node_id"] = json!(node_id);
            envelope["iroh_direct_addrs"] = json!([addr]);
            envelope["iroh_member_hints"] = json!([{ "irohNodeId": node_id, "irohDirectAddrs": [addr] }]);
            envelope["trust_tier"] = json!(2);
        }
        self.own.write_all(&framed(&envelope)).await.unwrap_or_else(|e| panic!("{}: the question was not written: {e}", self.who));
    }

    /// The first envelope `wanted` takes, heard within `bound`; what is
    /// passed over on the way is kept for a failure's message.
    async fn hear(&mut self, bound: Duration, wanted: impl Fn(&Heard) -> bool) -> Option<Heard> {
        let until = tokio::time::Instant::now() + bound;
        loop {
            match tokio::time::timeout_at(until, self.heard.recv()).await {
                Ok(Some(heard)) if wanted(&heard) => return Some(heard),
                Ok(Some(heard)) => self.passed.push(heard),
                Ok(None) | Err(_) => return None,
            }
        }
    }

    /// What the page heard and passed over, one line each.
    fn passed(&self) -> String {
        if self.passed.is_empty() {
            return "  (nothing)".to_string();
        }
        self.passed.iter().map(|heard| format!("  {}", heard.line())).collect::<Vec<_>>().join("\n")
    }
}

#[test]
fn a_dial_that_lands_is_told_to_every_page_of_the_room() {
    let (holder_dir, newcomer_dir) = (Scratch::new("holder"), Scratch::new("newcomer"));
    // One after the other: the first takes the HTTP API's first port, the
    // second finds it taken and takes the next.
    let mut holder = Node::start(&holder_dir, "the holder");
    let holder_http = holder.http_port(&holder_dir);
    let mut newcomer = Node::start(&newcomer_dir, "the newcomer");
    let newcomer_http = newcomer.http_port(&newcomer_dir);
    let holder_fp = fingerprint(holder_http, "the holder");
    let newcomer_fp = fingerprint(newcomer_http, "the newcomer");
    assert_ne!(holder_fp.node_id, newcomer_fp.node_id, "two nodes, two ids");
    let holder_addr = format!("127.0.0.1:{}", holder.iroh_port);
    let failure = |what: &str, holder_dir: &Scratch, newcomer_dir: &Scratch| -> String {
        format!(
            "{what}\n── the newcomer's node, last lines ──\n{}\n── the holder's node, last lines ──\n{}",
            tail(&newcomer_dir.log()),
            tail(&holder_dir.log())
        )
    };

    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
    let landed = runtime.block_on(async {
        // The holder's page is in the room first: its question names the
        // room to its node, which keeps the room from then on.
        let mut holder_page = Page::open("the holder's page", &holder_fp).await;
        holder_page.ask(None).await;
        assert!(
            holder_page.hear(LINK_BOUND, |h| h.own && h.sync_subtype() == Some(1)).await.is_some(),
            "{}",
            failure("the holder's node did not answer its own page's question", &holder_dir, &newcomer_dir)
        );

        // The newcomer's page asks once, with the holder's dial hints. Its
        // node has no link yet, so the question goes to no one but the node,
        // and the node dials.
        let mut newcomer_page = Page::open("the newcomer's page", &newcomer_fp).await;
        newcomer_page.ask(Some((&holder_fp.node_id, holder_addr.clone()))).await;

        // (1) `connected`, on a stream the node opened. If it comes on the
        // page's own stream alone, the game's page never hears it.
        let connected = |h: &Heard| h.dial_status().is_some_and(|(status, target)| status == "connected" && target == holder_fp.node_id);
        let first = newcomer_page.hear(DIAL_BOUND, connected).await;
        let landed = Instant::now();
        let told = match first {
            Some(heard) if !heard.own => true,
            Some(heard) => {
                newcomer_page.passed.push(heard);
                newcomer_page.hear(AFTER_OWN_STREAM, |h| !h.own && connected(h)).await.is_some()
            }
            None => panic!(
                "{}",
                failure(
                    &format!("the newcomer's page heard no `connected` for the holder within {DIAL_BOUND:?}. It heard:\n{}", newcomer_page.passed()),
                    &holder_dir,
                    &newcomer_dir
                )
            ),
        };
        assert!(
            told,
            "{}",
            failure(
                &format!(
                    "the dial landed, and the newcomer's node said `connected` on the page's own stream alone, where the game's page reads sync frames only: \
                     no stream the node opened carried it within {AFTER_OWN_STREAM:?}, so the game's page would not have asked the room for its state. It heard:\n{}",
                    newcomer_page.passed()
                ),
                &holder_dir,
                &newcomer_dir
            )
        );

        // (2) Told, the page asks again, as the game's page does. The
        // question crosses the link: the holder's page hears it, and the
        // holder's node answers it from the room it keeps.
        newcomer_page.ask(None).await;
        assert!(
            holder_page.hear(LINK_BOUND, |h| !h.own && h.sync_subtype() == Some(0) && h.from_node() == newcomer_fp.node_id).await.is_some(),
            "{}",
            failure(
                &format!("the newcomer's question did not reach the holder's page within {LINK_BOUND:?}. The holder's page heard:\n{}", holder_page.passed()),
                &holder_dir,
                &newcomer_dir
            )
        );
        assert!(
            newcomer_page.hear(LINK_BOUND, |h| !h.own && h.sync_subtype() == Some(1) && h.from_node() == holder_fp.node_id).await.is_some(),
            "{}",
            failure(
                &format!("the holder's node did not answer the newcomer's question within {LINK_BOUND:?}. The newcomer's page heard:\n{}", newcomer_page.passed()),
                &holder_dir,
                &newcomer_dir
            )
        );

        // (3) The pages stay, saying nothing more, for as long as a silent
        // connection is given.
        tokio::time::sleep(SILENT_BOUND.saturating_sub(landed.elapsed())).await;
        landed
    });

    assert!(landed.elapsed() >= SILENT_BOUND);
    holder.must_run(&holder_dir);
    newcomer.must_run(&newcomer_dir);
    let (holder_log, newcomer_log) = (holder_dir.text(), newcomer_dir.text());
    assert!(newcomer_log.contains(SECURED), "{}", failure("the newcomer's node never said its dial landed", &holder_dir, &newcomer_dir));
    assert!(holder_log.contains(INBOUND), "{}", failure("the holder's node never said a connection came in", &holder_dir, &newcomer_dir));
    assert!(
        !newcomer_log.contains(PRUNE) && !holder_log.contains(PRUNE),
        "{}",
        failure(&format!("a node dropped the other as silent within {SILENT_BOUND:?} of the dial landing"), &holder_dir, &newcomer_dir)
    );
}
