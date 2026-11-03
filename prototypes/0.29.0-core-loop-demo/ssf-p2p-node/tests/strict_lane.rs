//! ⛓️ Strict `SSF_NO_CHIA_LANE` through the real binary (stage 4 of the
//! mainnet transition, PR 3): `ssf-p2p-node` started as a child process in a
//! directory of its own, with `SSF_NO_CHIA_LANE=1` beside `SSF_CHIA_LANE=1`,
//! a remembered `chia_wallet.json` that says on, and one pinned full node,
//! which is a plain TCP listener on loopback. For three watcher ticks no
//! connection reaches the listener and no Chia file is written. A control
//! run, the same without `SSF_NO_CHIA_LANE`, reaches the listener, so the
//! strict run's zero is the switch's doing and not the test's.
//!
//! The in-game switch through the same binary (PR 4): once the control run's
//! node has dialled the pin, the page's `POST /api/chia/lane?on=0` answers
//! only once every connection the pin accepted is closed, well before the
//! dial's own timeout would close it, and saves `chia_lane_off.json`
//! owner-only. A third run starts in the control run's directory, with that
//! file and no `SSF_NO_CHIA_LANE`: its startup says the switch wins, builds
//! the lane closed and starts no watcher, and the page's `on=1` removes the
//! file while Chia stays off for the run. The third run waits for no tick:
//! the closed lane's startup line and the lane's own unit tests stand for
//! the strict run's three ticks.
//!
//! The runs are one test, one after the other: the node binds fixed ports
//! (HTTP on 127.0.0.1:8080 or 8081, WebTransport on UDP 4443), so two nodes
//! cannot run at once.
//!
//! The runs take about four minutes together, so this file runs once per CI
//! run, in the release feature set (`chia-publish,torrent`, what release.yml
//! builds and players get), which the cfg below names. The chia-publish,
//! mainnet and house-fold steps build without `torrent` and leave it out. The
//! Windows and macOS steps that build the release set run the wallet's tests
//! alone, by name, so they build this file and do not run it.
//!
//! The node is pointed at nothing but the listener: the pin alone
//! (`SSF_CHIA_PIN_ONLY=1`, so no introducer and no public peer), no Mainline
//! DHT, no mDNS, no public-address echo, no relay and a random iroh port.
//! iroh's port mapper stays on, since no `SSF_*` variable turns it off: when
//! the endpoint binds, it asks the local network's gateway for a mapping
//! (UPnP, NAT-PMP or PCP), and that never reaches the listener. The test's
//! own `SSF_*` variables are not passed on, so a developer's or CI's
//! `SSF_CHIA_NETWORK`, or any other, cannot change what is tested.
#![cfg(all(feature = "chia-publish", feature = "torrent"))]

use std::fs::File;
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const BIN: &str = env!("CARGO_BIN_EXE_ssf-p2p-node");

/// How often the beat watcher wakes, in seconds (`WATCH_TICK_SECS` in
/// src/chia_watch.rs). Its first read comes one tick after the start, and so
/// does the publisher's first read of the peak (`HEARTBEAT_TICK_SECS` in
/// src/chia_publish.rs, also 60 s); in the control run either may make the
/// first dial of the pin.
const WATCH_TICK_SECS: u64 = 60;

/// How long the strict run lasts: three watcher ticks, and a margin for the
/// start.
const STRICT_RUN: Duration = Duration::from_secs(3 * WATCH_TICK_SECS + 10);

/// How long the control run waits for its first connection at most: two
/// watcher ticks and a margin.
const CONTROL_BOUND: Duration = Duration::from_secs(2 * WATCH_TICK_SECS + 30);

/// How long the control run goes on once the first connection is in,
/// before the page turns Chia off.
const CONTROL_AFTER: Duration = Duration::from_secs(1);

/// The bound on each step of a dial to a full node (`CONNECT_TIMEOUT` in
/// src/chia_peer.rs): a dial of the mute pin gives up, and closes its
/// socket, this long after the connection is in. A socket closed sooner was
/// closed by the in-game off.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long the third run waits for its HTTP server at most.
const SETTING_BOUND: Duration = Duration::from_secs(60);

/// How often a run looks at the node and the listener.
const POLL: Duration = Duration::from_millis(250);

/// The Bank's remembered switch (`SWITCH_FILE` in src/chia_wallet_switch.rs).
const SWITCH_FILE: &str = "chia_wallet.json";

/// What the remembered switch says: on, turned on at a fixed time.
const SWITCH: &[u8] = br#"{"on": true, "at": 1762150000}"#;

/// The SSF wallet (`IDENTITY_FILE` in src/chia_wallet_switch.rs).
const IDENTITY_FILE: &str = "chia_identity.json";

/// The Chia files a node keeps in its directory on testnet11, by the names
/// their modules give them. None may appear while Chia is off.
const CHIA_FILES: &[&str] = &[
    // The peer store (`STORE_FILE`, src/chia_peer_lane.rs). It is written only
    // for a public peer that answered (`note_good` skips pins) or when a
    // stored peer is forgotten. With a mute pin, pin-only and no store on
    // disk, neither run can write it, so its absence is checked here but this
    // setup cannot prove it; the unit tests in src/chia_peer_lane.rs cover the
    // closed lane's store.
    "chia_peers.json",
    // The SSF wallet, its legacy seed file, whether its words were saved and
    // its lease (`IDENTITY_FILE`, `LEGACY_SEED_FILE`, `SAVED_FILE`,
    // `LEASE_FILE`, src/chia_wallet_switch.rs).
    IDENTITY_FILE,
    "chia_identity.seed",
    "chia_words_saved.json",
    "wallet_lease.json",
    // The knock book (`KNOCKS_FILE`, src/chia_knock.rs).
    "knocks.json",
    // The publisher's and the beacon's marks (`NODE_MARK_FILE`,
    // `BEACON_MARK_FILE`, src/chia_publish.rs).
    "publish_marks.json",
    "beacon_mark.json",
];

/// Mainnet's own folder of state files (`MAINNET_DIR`, src/chia_network.rs).
const MAINNET_DIR: &str = "chia-mainnet";

/// The in-game switch's file (`LANE_FILE`, src/chia_strict.rs).
const LANE_FILE: &str = "chia_lane_off.json";

/// The startup line that says the strict switch wins (`WINS_WORDS`,
/// src/chia_strict.rs), and the start of the closed lane's line
/// (`Lane::describe`, src/chia_peer_lane.rs).
const WINS: &str = "SSF_NO_CHIA_LANE wins over SSF_CHIA_LANE=1";
const LANE_OFF: &str = "Chain lane: off";

/// The same two lines for the in-game switch (`SETTING_WINS_WORDS` and
/// `source_words`, src/chia_strict.rs), and the line its file prints at the
/// start (`startup_line_of`).
const SETTING_WINS: &str = "the Chia switch in the SpacePhone's Network settings wins over SSF_CHIA_LANE=1";
const LANE_OFF_SETTING: &str = "Chain lane: off. Chia is off on this computer (the Chia switch in the SpacePhone's Network settings)";
const SETTING_START: &str = "turned off in the SpacePhone's Network settings (chia_lane_off.json)";

/// The line of the in-game off (`turned_line`, src/chia_strict.rs), and the
/// one for the wallet it leaves loaded (`HOT_OFF_WALLET_WORDS`,
/// src/chia_wallet_switch.rs).
const HOT_OFF: &str = "⛓️ Chia: turned off in the SpacePhone's Network settings — every connection to a Chia full node is closed";
const HOT_OFF_WALLET: &str = "the wallet publishes nothing; it stays loaded until the node stops";

/// The wallet's at-rest line on a computer with no store to lock its file
/// with (`policy_line`, src/chia_at_rest.rs): Linux. Never said while Chia is
/// off at the start, when no wallet loads.
const AT_REST: &str = "this computer has no store the node locks the wallet's file with yet";

/// The line that names the node's HTTP port (src/main.rs).
const HTTP_LINE: &str = "Local HTTP API server listening on http://127.0.0.1:";

/// The origin of the page's requests: a loopback page (vite's), which the
/// route's gate takes (`local_page`, src/chia_wallet_switch.rs).
const PAGE: &str = "http://localhost:5173";

/// The line the beat watcher prints as it starts (src/chia_watch.rs).
const WATCHER_ON: &str = "ChiaHub watcher on";

/// A directory of the test's own under the system's temporary directory:
/// `node/`, the node's working directory, where it keeps its files on
/// testnet11, and `node.log` beside it. Removed, with what is in it, once
/// dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let root = std::env::temp_dir().join(format!("ssf-strict-lane-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(root.join("node")).expect("the scratch directory");
        let scratch = Self(root);
        std::fs::write(scratch.cwd().join(SWITCH_FILE), SWITCH).expect("the remembered switch");
        scratch
    }

    fn cwd(&self) -> PathBuf {
        self.0.join("node")
    }

    fn log(&self) -> PathBuf {
        self.0.join("node.log")
    }

    /// The names in the node's directory, sorted. Names only: nothing of
    /// what a file holds.
    fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(self.cwd())
            .expect("the node's directory")
            .map(|entry| entry.expect("an entry").file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// When the pin accepted a connection, and when it saw the node close it.
#[derive(Clone, Copy, Debug)]
struct Seen {
    accepted: Instant,
    closed: Option<Instant>,
}

/// The pinned "full node": a plain TCP listener on loopback that accepts
/// every connection, keeps its socket open, says nothing and counts it. It
/// reads what the node sends (the start of a TLS handshake) and drops it,
/// and notes when the node closes the connection. Stopped, its sockets
/// closed, once dropped.
struct Pin {
    addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<Seen>>>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Pin {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        listener.set_nonblocking(true).expect("a listener that does not block");
        let addr = listener.local_addr().expect("the listener's address");
        let accepted = Arc::new(AtomicUsize::new(0));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (accepted, seen, stop) = (accepted.clone(), seen.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut held: Vec<(TcpStream, usize)> = Vec::new();
                let mut buf = [0u8; 4096];
                while !stop.load(SeqCst) {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            socket.set_nonblocking(true).expect("a socket that does not block");
                            let mut seen = seen.lock().unwrap();
                            seen.push(Seen { accepted: Instant::now(), closed: None });
                            held.push((socket, seen.len() - 1));
                            accepted.fetch_add(1, SeqCst);
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {}
                        Err(e) => panic!("the pin's listener: {e}"),
                    }
                    held.retain_mut(|(socket, at)| loop {
                        match socket.read(&mut buf) {
                            Ok(0) => {}
                            Ok(_) => continue,
                            Err(e) if e.kind() == ErrorKind::WouldBlock => return true,
                            Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                            Err(_) => {}
                        }
                        seen.lock().unwrap()[*at].closed = Some(Instant::now());
                        return false;
                    });
                    std::thread::sleep(Duration::from_millis(20));
                }
            })
        };
        Self { addr, accepted, seen, stop, thread: Some(thread) }
    }

    fn accepted(&self) -> usize {
        self.accepted.load(SeqCst)
    }

    /// Every connection so far, as the pin saw it.
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// Wait up to `bound` for the node to have closed every connection the
    /// pin accepted, and return them.
    fn all_closed_within(&self, bound: Duration) -> Vec<Seen> {
        let start = Instant::now();
        loop {
            let seen = self.seen();
            if seen.iter().all(|s| s.closed.is_some()) || start.elapsed() >= bound {
                return seen;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Pin {
    fn drop(&mut self) {
        self.stop.store(true, SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The node as a child process, its stdout and stderr in the scratch log.
/// Killed and waited for once dropped, so a failing assertion never leaves
/// one running.
struct Node {
    child: Option<Child>,
    started: Instant,
}

impl Node {
    /// Start the node in `scratch`'s directory, `pin` its one full node, with
    /// `SSF_NO_CHIA_LANE=1` when `strict`. The test's own `SSF_*` variables
    /// are removed first; the rest of its environment (PATH, HOME, TMPDIR and
    /// the like) is passed on.
    fn start(scratch: &Scratch, pin: SocketAddr, strict: bool) -> Self {
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
            .env("SSF_CHIA_LANE", "1")
            .env("SSF_CHIA_PEERS", pin.to_string())
            .env("SSF_CHIA_PIN_ONLY", "1")
            .env("SSF_NO_DHT", "1")
            .env("SSF_NO_MDNS", "1")
            .env("SSF_EXTERNAL_ADDRS", "off")
            .env("SSF_IROH_PORT", "0");
        if strict {
            command.env("SSF_NO_CHIA_LANE", "1");
        }
        let child = command.spawn().expect("the node starts");
        Self { child: Some(child), started: Instant::now() }
    }

    /// Look at the node every [`POLL`] until `done` says so (given the time
    /// since the start) or `bound` has passed, and return the time since the
    /// start. Fails at once, with the log's last lines, if the node exits.
    fn run_until(&mut self, scratch: &Scratch, run: &str, bound: Duration, mut done: impl FnMut(Duration) -> bool) -> Duration {
        let child = self.child.as_mut().expect("the node runs");
        loop {
            if let Some(status) = child.try_wait().expect("the node's status") {
                panic!("{run}: the node exited {:?} after its start ({status}). Its log ends:\n{}", self.started.elapsed(), tail(&scratch.log()));
            }
            let elapsed = self.started.elapsed();
            if done(elapsed) || elapsed >= bound {
                return elapsed;
            }
            std::thread::sleep(POLL);
        }
    }

    /// Kill the node by its handle and wait for it.
    fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The log, as text.
fn log_of(scratch: &Scratch) -> String {
    String::from_utf8_lossy(&std::fs::read(scratch.log()).unwrap_or_default()).into_owned()
}

/// The node's HTTP port, from its log line.
fn http_port(log: &str) -> Option<u16> {
    let rest = &log[log.find(HTTP_LINE)? + HTTP_LINE.len()..];
    rest.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()
}

/// One request to the node's HTTP API as this computer's own page sends it
/// (a loopback Origin, a loopback Host on the API's port), and the answer:
/// its status code and its body.
fn ask(port: u16, method: &str, target: &str) -> (u16, String) {
    let mut socket = TcpStream::connect(("127.0.0.1", port)).expect("the node's HTTP API");
    socket.set_read_timeout(Some(Duration::from_secs(30))).expect("a read timeout");
    let request = format!("{method} {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {PAGE}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    socket.write_all(request.as_bytes()).expect("the request is sent");
    let mut answer = Vec::new();
    socket.read_to_end(&mut answer).expect("the answer");
    let answer = String::from_utf8_lossy(&answer).into_owned();
    let status = answer.split_whitespace().nth(1).and_then(|code| code.parse().ok()).unwrap_or(0);
    let body = answer.split_once("\r\n\r\n").map(|(_, body)| body.to_string()).unwrap_or_default();
    (status, body)
}

/// The fingerprint's `chia_lane` object, as text, and nothing else of it:
/// the fingerprint also names the wallet's address, which the test never
/// prints.
fn chia_lane_of(port: u16) -> String {
    let (status, body) = ask(port, "GET", "/api/fingerprint");
    assert_eq!(status, 200, "the fingerprint");
    let Some(at) = body.find("\"chia_lane\":") else { return "none".to_string() };
    let rest = &body[at..];
    rest[..rest.find('}').map(|end| end + 1).unwrap_or(rest.len())].to_string()
}

/// The log's last lines, for a failure. A line that names a key
/// fingerprint or an address is left out: the control run mints a wallet,
/// and the test prints nothing of it.
fn tail(log: &Path) -> String {
    let text = String::from_utf8_lossy(&std::fs::read(log).unwrap_or_default()).into_owned();
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(40)..]
        .iter()
        .map(|line| if line.contains("fingerprint") || line.contains("xch1") { "[a wallet line, left out]" } else { line })
        .collect::<Vec<_>>()
        .join("\n")
}

/// ⛓️ With `SSF_NO_CHIA_LANE=1` the node dials nothing for three watcher
/// ticks, though `SSF_CHIA_LANE=1`, the remembered switch and a pin all ask
/// for Chia, and writes no Chia file; without it the same node dials the pin
/// within two ticks. The page's in-game off then closes those connections
/// before it answers, and the file it saves holds Chia off at the next
/// start, until the page turns it back on.
#[test]
fn the_strict_switch_keeps_the_pin_undialled_and_the_control_dials_it() {
    strict_run();
    let scratch = control_run();
    setting_run(scratch);
}

/// `SSF_NO_CHIA_LANE=1`: for three watcher ticks no connection reaches the
/// pin, no Chia file is written, the remembered switch is left byte for byte
/// as it was, the node says the switch wins and the lane is off, and no
/// watcher starts.
fn strict_run() {
    let scratch = Scratch::new("strict");
    let pin = Pin::start();
    let mut node = Node::start(&scratch, pin.addr, true);
    // A connection fails the run at once; otherwise it lasts its length.
    let ran = node.run_until(&scratch, "strict", STRICT_RUN, |_| pin.accepted() > 0);
    node.stop();
    let accepted = pin.accepted();
    let names = scratch.names();
    println!("strict: {accepted} connection(s) to the pin in {}s; the node's directory holds {names:?}", ran.as_secs());
    assert_eq!(accepted, 0, "strict: the pin was dialled within {ran:?} of the start. The log ends:\n{}", tail(&scratch.log()));
    assert!(ran >= STRICT_RUN, "strict: the run lasted {ran:?}");
    let cwd = scratch.cwd();
    for file in CHIA_FILES {
        assert!(!cwd.join(file).exists(), "strict: {file} was written");
    }
    assert!(!cwd.join(MAINNET_DIR).exists(), "strict: {MAINNET_DIR}/ was made");
    let others: Vec<&String> = names.iter().filter(|name| name.starts_with("chia") && *name != SWITCH_FILE).collect();
    assert!(others.is_empty(), "strict: Chia files beside the switch: {others:?}");
    assert_eq!(std::fs::read(cwd.join(SWITCH_FILE)).expect("the switch is still there"), SWITCH, "strict: the switch is left as it was");
    let log = log_of(&scratch);
    for line in [WINS, LANE_OFF] {
        assert!(log.contains(line), "strict: the log has no {line:?}. It ends:\n{}", tail(&scratch.log()));
    }
    assert!(!log.contains(WATCHER_ON), "strict: the watcher started");
    assert!(!log.contains(AT_REST), "strict: the wallet's at-rest line was said, though no wallet loads");
}

/// The same run without `SSF_NO_CHIA_LANE`: the watcher starts and the pin
/// is dialled within [`CONTROL_BOUND`]. [`CONTROL_AFTER`] past the first
/// connection, the page turns Chia off ([`hot_off`]), and the run ends. The
/// wallet it mints, [`IDENTITY_FILE`], shows that the node keeps its Chia
/// files in the scratch directory, so the strict run's missing files mean
/// something. The file is looked for and never read. The directory is
/// handed on to the third run.
fn control_run() -> Scratch {
    let scratch = Scratch::new("control");
    let pin = Pin::start();
    let mut node = Node::start(&scratch, pin.addr, false);
    let mut first: Option<Duration> = None;
    let ran = node.run_until(&scratch, "control", CONTROL_BOUND, |elapsed| {
        if pin.accepted() == 0 {
            return false;
        }
        elapsed >= *first.get_or_insert(elapsed) + CONTROL_AFTER
    });
    if pin.accepted() >= 1 {
        hot_off(&scratch, &pin);
    }
    node.stop();
    let accepted = pin.accepted();
    let first = first.map(|at| format!("{}s", at.as_secs())).unwrap_or_else(|| "never".to_string());
    println!(
        "control: {accepted} connection(s) to the pin in {}s, the first at {first}; the node's directory holds {:?}",
        ran.as_secs(),
        scratch.names()
    );
    assert!(accepted >= 1, "control: no connection reached the pin within {CONTROL_BOUND:?}. The log ends:\n{}", tail(&scratch.log()));
    let log = log_of(&scratch);
    assert!(log.contains(WATCHER_ON), "control: the watcher did not start. The log ends:\n{}", tail(&scratch.log()));
    for line in [WINS, LANE_OFF] {
        assert!(!log.contains(line), "control: the log has {line:?}");
    }
    assert!(scratch.cwd().join(IDENTITY_FILE).exists(), "control: no {IDENTITY_FILE} in the node's directory, so the strict run's missing files prove nothing");
    // The strict runs' missing at-rest line means something where the
    // control says it: on a computer with no store to lock the file with.
    #[cfg(target_os = "linux")]
    assert!(log.contains(AT_REST), "control: no at-rest line, so the strict runs' missing one proves nothing");
    scratch
}

/// ⛓️ The in-game off on the control run's node, while the pin's
/// connections are open: the page's `on=0` answers 200 only once the node
/// closed every connection the pin accepted, each well before the dial's
/// own [`CONNECT_TIMEOUT`] would have closed it; no connection comes after
/// the answer; the switch's file is saved owner-only and says off; the
/// fingerprint says Chia is off by the switch; and the log says so, and
/// that the loaded wallet publishes nothing.
fn hot_off(scratch: &Scratch, pin: &Pin) {
    let log = log_of(scratch);
    let port = http_port(&log).unwrap_or_else(|| panic!("control: no HTTP port in the log. It ends:\n{}", tail(&scratch.log())));
    let (status, body) = ask(port, "POST", "/api/chia/lane?on=0");
    let answered = Instant::now();
    assert_eq!(status, 200, "control: the off answered {status} {body}");
    assert!(body.contains(r#""ok":true"#), "control: {body}");
    let accepted = pin.accepted();
    // The pin's thread looks at its sockets every 20 ms.
    let seen = pin.all_closed_within(Duration::from_secs(1));
    let longest = seen.iter().filter_map(|s| s.closed.map(|closed| closed - s.accepted)).max().unwrap_or_default();
    println!("control: the off answered with {} connection(s) to the pin, each closed within {longest:?} of coming in", seen.len());
    for (i, s) in seen.iter().enumerate() {
        let closed = s.closed.unwrap_or_else(|| panic!("control: connection {i} to the pin is still open after the off answered"));
        assert!(closed <= answered + Duration::from_millis(500), "control: connection {i} was closed {:?} after the off answered", closed - answered);
        assert!(
            closed < s.accepted + CONNECT_TIMEOUT - Duration::from_secs(2),
            "control: connection {i} was closed {:?} after it came in, which the dial's own timeout would do",
            closed - s.accepted
        );
    }
    std::thread::sleep(Duration::from_secs(1));
    assert_eq!(pin.accepted(), accepted, "control: a connection came after the off answered");
    let file = scratch.cwd().join(LANE_FILE);
    let saved = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("control: {LANE_FILE}: {e}"));
    assert!(saved.contains(r#""off":true"#), "control: {LANE_FILE} holds {saved}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).expect("the switch's file").permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "control: {LANE_FILE} is not owner-only");
    }
    let lane = chia_lane_of(port);
    assert_eq!(lane, r#""chia_lane":{"off":true,"source":"setting","setting":"off"}"#, "control: the fingerprint");
    let log = log_of(scratch);
    for line in [HOT_OFF, HOT_OFF_WALLET] {
        assert!(log.contains(line), "control: the log has no {line:?}. It ends:\n{}", tail(&scratch.log()));
    }
}

/// ⛓️ The in-game switch's file at the start: the control run's directory,
/// where the page's off saved `chia_lane_off.json`, started again without
/// `SSF_NO_CHIA_LANE` and with `SSF_CHIA_LANE=1`, the remembered switch, the
/// wallet the control run minted and a pin. The node says the switch wins,
/// builds the lane closed and starts no watcher, and neither the wallet's
/// at-rest line nor the env switch's lines are said; the fingerprint says
/// Chia is off by the switch. The page's `on=1` then removes the file, and
/// Chia stays off for the run. Nothing connects to the pin.
fn setting_run(scratch: Scratch) {
    assert!(scratch.cwd().join(LANE_FILE).exists(), "setting: the control run left no {LANE_FILE}");
    let pin = Pin::start();
    let mut node = Node::start(&scratch, pin.addr, false);
    let ran = node.run_until(&scratch, "setting", SETTING_BOUND, |_| log_of(&scratch).contains(HTTP_LINE));
    let log = log_of(&scratch);
    let port = http_port(&log).unwrap_or_else(|| panic!("setting: no HTTP port within {ran:?}. The log ends:\n{}", tail(&scratch.log())));
    for line in [SETTING_START, SETTING_WINS, LANE_OFF_SETTING] {
        assert!(log.contains(line), "setting: the log has no {line:?}. It ends:\n{}", tail(&scratch.log()));
    }
    for line in [WATCHER_ON, AT_REST, WINS] {
        assert!(!log.contains(line), "setting: the log has {line:?}");
    }
    assert_eq!(chia_lane_of(port), r#""chia_lane":{"off":true,"source":"setting","setting":"off"}"#, "setting: the fingerprint");
    let (status, body) = ask(port, "POST", "/api/chia/lane?on=1");
    assert_eq!(status, 200, "setting: the on answered {status} {body}");
    assert!(body.contains("next start"), "setting: {body}");
    assert!(!scratch.cwd().join(LANE_FILE).exists(), "setting: the on left {LANE_FILE}");
    assert_eq!(chia_lane_of(port), r#""chia_lane":{"off":true,"source":"setting","setting":"on"}"#, "setting: Chia stays off for the run");
    node.stop();
    println!("setting: {} connection(s) to the pin in {}s", pin.accepted(), ran.as_secs());
    assert_eq!(pin.accepted(), 0, "setting: the pin was dialled");
}
