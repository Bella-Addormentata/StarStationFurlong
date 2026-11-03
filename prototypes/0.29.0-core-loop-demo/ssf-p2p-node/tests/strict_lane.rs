//! ⛓️ Strict `SSF_NO_CHIA_LANE` through the real binary (stage 4 of the
//! mainnet transition, PR 3): `ssf-p2p-node` started as a child process in a
//! directory of its own, with `SSF_NO_CHIA_LANE=1` beside `SSF_CHIA_LANE=1`,
//! a remembered `chia_wallet.json` that says on, and one pinned full node,
//! which is a plain TCP listener on loopback. For three watcher ticks no
//! connection reaches the listener and no Chia file is written. A control
//! run, the same without `SSF_NO_CHIA_LANE`, reaches the listener, so the
//! strict run's zero is the switch's doing and not the test's.
//!
//! The two runs are one test, one after the other: the node binds fixed
//! ports (HTTP on 127.0.0.1:8080 or 8081, WebTransport on UDP 4443), so two
//! nodes cannot run at once.
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
use std::io::ErrorKind;
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::Arc;
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

/// How long the control run goes on once the first connection is in.
const CONTROL_AFTER: Duration = Duration::from_secs(3);

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

/// The startup line that says the strict switch wins (`WINS_WORDS`,
/// src/chia_strict.rs), and the start of the closed lane's line
/// (`Lane::describe`, src/chia_peer_lane.rs).
const WINS: &str = "SSF_NO_CHIA_LANE wins over SSF_CHIA_LANE=1";
const LANE_OFF: &str = "Chain lane: off";

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

/// The pinned "full node": a plain TCP listener on loopback that accepts
/// every connection, keeps its socket open, says nothing and counts it.
/// Stopped, its sockets closed, once dropped.
struct Pin {
    addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Pin {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a loopback port");
        listener.set_nonblocking(true).expect("a listener that does not block");
        let addr = listener.local_addr().expect("the listener's address");
        let accepted = Arc::new(AtomicUsize::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let thread = {
            let (accepted, stop) = (accepted.clone(), stop.clone());
            std::thread::spawn(move || {
                let mut held: Vec<TcpStream> = Vec::new();
                while !stop.load(SeqCst) {
                    match listener.accept() {
                        Ok((socket, _)) => {
                            held.push(socket);
                            accepted.fetch_add(1, SeqCst);
                        }
                        Err(e) if e.kind() == ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(20)),
                        Err(e) => panic!("the pin's listener: {e}"),
                    }
                }
            })
        };
        Self { addr, accepted, stop, thread: Some(thread) }
    }

    fn accepted(&self) -> usize {
        self.accepted.load(SeqCst)
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
/// within two ticks.
#[test]
fn the_strict_switch_keeps_the_pin_undialled_and_the_control_dials_it() {
    strict_run();
    control_run();
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
}

/// The same run without `SSF_NO_CHIA_LANE`: the watcher starts and the pin
/// is dialled within [`CONTROL_BOUND`]. The run ends [`CONTROL_AFTER`] past
/// the first connection. The wallet it mints, [`IDENTITY_FILE`], shows that
/// the node keeps its Chia files in the scratch directory, so the strict
/// run's missing files mean something. The file is looked for and never
/// read.
fn control_run() {
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
}
