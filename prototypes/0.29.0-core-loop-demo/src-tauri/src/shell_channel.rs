//! 🖥️ The app's end of the node's channel: the spawned node's own stdin and
//! stdout (native-reveal design, sections 3 and 4, "Shell: spawn and channel
//! client"). The node's end is ssf-p2p-node/src/shell_channel.rs.
//!
//! The app asks the node for the 24 words, and tells it they are saved, over
//! the pipes it spawned the node with. Holding the pipes is the
//! authentication. On Linux the app makes itself not dumpable before the
//! first spawn ([`guard_pipes`]), so no other program can reopen the app's
//! ends of the pipes through `/proc/<app pid>/fd`; if that fails the app
//! spawns the node without the channel, and the backup window stays off.
//!
//! The wire, one line each way:
//! - Request on the node's stdin: `{"v":1,"id":N,"op":"hello"|"reveal"|"saved"}`,
//!   and `saved` also carries `"key":K`, the key fingerprint of the app's own
//!   last reveal. `id` is the app's counter for the run.
//! - Reply on the node's stdout: `ssf-shell/1 <id> <json>\n`.
//!
//! One reader thread drains the node's stdout for the node's whole life. It
//! hands a frame to the one outstanding request only when the frame's id is
//! that request's id. Every other line (a stale or unknown id, a line that
//! is not a frame, a line longer than [`MAX_REPLY`], a late reply) is
//! dropped, wiped and counted: only "dropped a channel line" is logged, never
//! its text. Nothing read from the node's stdout is ever printed. One request
//! at a time, each with a [`TIMEOUT`]; a reply that comes later is dropped.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::de::{SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use zeroize::{Zeroize, Zeroizing};

/// The variable that turns the node's channel on (only the app's own spawn
/// sets it).
pub const CHANNEL_ENV: &str = "SSF_SHELL_CHANNEL";

/// The variable the node reads its Chia network from.
pub const NETWORK_ENV: &str = "SSF_CHIA_NETWORK";

/// The first word of every reply line.
pub const FRAME_TAG: &str = "ssf-shell/1";

/// The longest reply line the app takes, in bytes before its newline. The
/// node's longest answer (the saved mark's wallet view) is well under it.
pub const MAX_REPLY: usize = 16 * 1024;

/// How long one request waits for its reply.
pub const TIMEOUT: Duration = Duration::from_secs(15);

/// The number of words a reveal must carry.
pub const WORD_COUNT: usize = 24;

/// A Chia network as the node names it in its hello.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Net {
    /// The node's `SSF_CHIA_NETWORK` value and hello `net.id`.
    pub id: &'static str,
    /// The network's genesis challenge, 64 lowercase hex digits.
    pub genesis: &'static str,
    /// The network's name in the backup window.
    pub name: &'static str,
}

#[cfg_attr(feature = "chia-mainnet", allow(dead_code))]
pub const TESTNET11: Net = Net {
    id: "testnet11",
    genesis: "37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615",
    name: "testnet11",
};

pub const MAINNET: Net = Net {
    id: "mainnet",
    genesis: "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb",
    name: "Chia mainnet",
};

/// The app's network, fixed when it is built: testnet11, or Chia mainnet in
/// a development build with the `chia-mainnet` feature. The node's hello
/// must name the same network, or the backup window stays off.
#[cfg(not(feature = "chia-mainnet"))]
pub const SHELL_NET: Net = TESTNET11;
#[cfg(feature = "chia-mainnet")]
pub const SHELL_NET: Net = MAINNET;

/// The command that starts the node at `program`, for every spawn. It
/// removes `SSF_CHIA_NETWORK` and `SSF_SHELL_CHANNEL` from the child's
/// environment, so a variable in the player's environment can never move the
/// bundled node to another chain or turn its channel on. A `chia-mainnet`
/// build then sets the network to mainnet (the node must be a `chia-mainnet`
/// build too, or it exits and the hello fails). Only [`attach`] sets the
/// channel's variable.
pub fn node_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_remove(NETWORK_ENV);
    cmd.env_remove(CHANNEL_ENV);
    if cfg!(feature = "chia-mainnet") {
        cmd.env(NETWORK_ENV, MAINNET.id);
    }
    cmd
}

/// Turn the channel on for this spawn: the variable, and piped stdin and
/// stdout. stderr stays the app's, so the node's log still shows.
pub fn attach(cmd: &mut Command) {
    cmd.env(CHANNEL_ENV, "1");
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::inherit());
}

/// Whether the app's ends of the pipes are guarded, decided once, before the
/// first spawn. Linux: `prctl(PR_SET_DUMPABLE, 0)`, as the node does for its
/// own ends, so `/proc/<app pid>/fd` and ptrace refuse every process without
/// `CAP_SYS_PTRACE`. Elsewhere there is no `/proc` to close, and it is true.
pub fn pipes_guarded() -> bool {
    static GUARDED: OnceLock<bool> = OnceLock::new();
    *GUARDED.get_or_init(guard_pipes)
}

#[cfg(target_os = "linux")]
fn guard_pipes() -> bool {
    // SAFETY: PR_SET_DUMPABLE takes plain integers and no pointer.
    let held = unsafe {
        libc::prctl(libc::PR_SET_DUMPABLE, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) == 0
    };
    if !held {
        eprintln!("🖥️ Desktop app channel: the app could not stop other programs from opening its pipes, so the node is started without the channel and the backup window stays off");
    }
    held
}

#[cfg(not(target_os = "linux"))]
fn guard_pipes() -> bool {
    true
}

/// One request's op.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Hello,
    Reveal,
    /// The words of this key fingerprint are saved.
    Saved(u32),
}

impl Op {
    /// The request line for request `id`, newline included.
    pub fn line(self, id: u64) -> String {
        match self {
            Op::Hello => format!("{{\"v\":1,\"id\":{id},\"op\":\"hello\"}}\n"),
            Op::Reveal => format!("{{\"v\":1,\"id\":{id},\"op\":\"reveal\"}}\n"),
            Op::Saved(key) => format!("{{\"v\":1,\"id\":{id},\"op\":\"saved\",\"key\":{key}}}\n"),
        }
    }
}

/// Why a request got no reply.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failed {
    /// The node's stdin or stdout is closed: it exited, or the app is
    /// stopping it.
    Closed,
    /// No reply with the request's id within the timeout.
    TimedOut,
}

/// The one outstanding request and what the reader found for it.
#[derive(Default)]
struct Slot {
    /// The id of the request waiting for its reply, if any.
    waiting: Option<u64>,
    /// Its reply's JSON, once the reader found it.
    reply: Option<Zeroizing<String>>,
    /// The node's stdout reached its end.
    closed: bool,
    /// Lines the reader dropped.
    dropped: u64,
}

struct Shared {
    slot: Mutex<Slot>,
    ready: Condvar,
}

/// The app's end of one spawned node's channel.
pub struct Channel {
    stdin: Mutex<Option<Box<dyn Write + Send>>>,
    shared: Arc<Shared>,
    /// Held for a whole request, so there is one at a time; holds the last id.
    turn: Mutex<u64>,
    timeout: Duration,
    /// A hello named another network: the backup window stays off for the
    /// run (the node's network does not change while it runs).
    other_network: AtomicBool,
}

impl Channel {
    /// The channel over a node's stdin and stdout, with its reader thread.
    pub fn start(stdin: impl Write + Send + 'static, stdout: impl Read + Send + 'static) -> Arc<Channel> {
        Channel::start_with(stdin, stdout, TIMEOUT)
    }

    /// [`Channel::start`] with another timeout (the tests' shorter one).
    pub fn start_with(stdin: impl Write + Send + 'static, stdout: impl Read + Send + 'static, timeout: Duration) -> Arc<Channel> {
        let shared = Arc::new(Shared { slot: Mutex::new(Slot::default()), ready: Condvar::new() });
        let reader = shared.clone();
        let spawned = std::thread::Builder::new().name("ssf-shell-reader".into()).spawn(move || read_loop(stdout, &reader));
        if let Err(e) = spawned {
            eprintln!("🖥️ Desktop app channel: its reader could not start ({e}); the backup window stays off");
            let mut slot = shared.slot.lock().unwrap();
            slot.closed = true;
        }
        Arc::new(Channel {
            stdin: Mutex::new(Some(Box::new(stdin))),
            shared,
            turn: Mutex::new(0),
            timeout,
            other_network: AtomicBool::new(false),
        })
    }

    /// Send one request and wait for the reply whose id is its own, at most
    /// the timeout. The reply's JSON comes back in a buffer wiped when
    /// dropped. Blocking: the commands run it off the main thread.
    pub fn request(&self, op: Op) -> Result<Zeroizing<String>, Failed> {
        let mut last = self.turn.lock().unwrap_or_else(|e| e.into_inner());
        *last += 1;
        let id = *last;
        {
            let mut slot = self.shared.slot.lock().unwrap();
            if slot.closed {
                return Err(Failed::Closed);
            }
            slot.waiting = Some(id);
            slot.reply = None;
        }
        let sent = {
            let mut stdin = self.stdin.lock().unwrap();
            match stdin.as_mut() {
                None => false,
                Some(pipe) => {
                    let ok = pipe.write_all(op.line(id).as_bytes()).and_then(|()| pipe.flush()).is_ok();
                    if !ok {
                        // The node is gone: nothing more can be asked.
                        *stdin = None;
                    }
                    ok
                }
            }
        };
        let mut slot = self.shared.slot.lock().unwrap();
        if !sent {
            slot.waiting = None;
            return Err(Failed::Closed);
        }
        let deadline = Instant::now() + self.timeout;
        loop {
            if let Some(reply) = slot.reply.take() {
                slot.waiting = None;
                return Ok(reply);
            }
            if slot.closed {
                slot.waiting = None;
                return Err(Failed::Closed);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                // A reply that comes after this is dropped by the reader.
                slot.waiting = None;
                return Err(Failed::TimedOut);
            }
            slot = self.shared.ready.wait_timeout(slot, left).unwrap().0;
        }
    }

    /// The node's hello, read; a hello for another network than the app's
    /// turns the backup window off for the run.
    pub fn hello(&self) -> Result<Hello, Failed> {
        let body = self.request(Op::Hello)?;
        let hello = Hello::parse(&body).unwrap_or_default();
        if !hello.is_net(SHELL_NET) {
            self.other_network.store(true, Ordering::SeqCst);
        }
        Ok(hello)
    }

    /// Whether a hello in this run named another network than the app's.
    pub fn other_network(&self) -> bool {
        self.other_network.load(Ordering::SeqCst)
    }

    /// Close the node's stdin (the node sees EOF), first thing on exit.
    pub fn close_stdin(&self) {
        self.stdin.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    /// How many lines the reader dropped.
    #[cfg(test)]
    pub fn dropped(&self) -> u64 {
        self.shared.slot.lock().unwrap().dropped
    }
}

/// The reader thread's loop: read the node's stdout to its end, a chunk at a
/// time into a wiped buffer, and hand each whole line to [`deliver`]. A line
/// longer than [`MAX_REPLY`] is dropped whole (up to its newline); a line cut
/// by the end is dropped. The line buffer has its full capacity from the
/// start, so it never reallocates (which would leave the old one unwiped).
fn read_loop<R: Read>(mut input: R, shared: &Shared) {
    let mut chunk = Zeroizing::new([0u8; 512]);
    let mut line: Zeroizing<Vec<u8>> = Zeroizing::new(Vec::with_capacity(MAX_REPLY));
    let mut too_long = false;
    loop {
        let n = match input.read(&mut chunk[..]) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        };
        for &byte in &chunk[..n] {
            if byte == b'\n' {
                if too_long {
                    drop_line(shared);
                } else {
                    deliver(&line, shared);
                }
                line.zeroize();
                too_long = false;
            } else if too_long {
                // The rest of a line that is too long: skipped.
            } else if line.len() == MAX_REPLY {
                too_long = true;
                line.zeroize();
            } else {
                line.push(byte);
            }
        }
        chunk.zeroize();
    }
    if too_long || !line.is_empty() {
        drop_line(shared);
    }
    line.zeroize();
    let mut slot = shared.slot.lock().unwrap();
    slot.closed = true;
    shared.ready.notify_all();
}

/// Count and log one dropped line (never its text).
fn drop_line(shared: &Shared) {
    let mut slot = shared.slot.lock().unwrap();
    slot.dropped += 1;
    eprintln!("🖥️ Desktop app channel: dropped a channel line");
}

/// A whole frame's id and JSON, or None for a line that is not a frame:
/// `ssf-shell/1 <id> <json>`, the id plain decimal digits, the JSON UTF-8.
fn frame_parts(line: &[u8]) -> Option<(u64, &str)> {
    let rest = line.strip_prefix(FRAME_TAG.as_bytes())?.strip_prefix(b" ")?;
    let space = rest.iter().position(|&b| b == b' ')?;
    let (digits, json) = (&rest[..space], &rest[space + 1..]);
    if digits.is_empty() || digits.len() > 20 || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let id: u64 = std::str::from_utf8(digits).ok()?.parse().ok()?;
    let json = std::str::from_utf8(json).ok()?;
    if json.is_empty() {
        return None;
    }
    Some((id, json))
}

/// Hand a frame to the outstanding request when its id is that request's;
/// drop anything else.
fn deliver(line: &[u8], shared: &Shared) {
    let Some((id, json)) = frame_parts(line) else {
        drop_line(shared);
        return;
    };
    let mut slot = shared.slot.lock().unwrap();
    if slot.waiting == Some(id) && slot.reply.is_none() {
        // Sized up front, so the copy never reallocates.
        let mut reply = Zeroizing::new(String::with_capacity(json.len()));
        reply.push_str(json);
        slot.reply = Some(reply);
        slot.waiting = None;
        shared.ready.notify_all();
    } else {
        drop(slot);
        drop_line(shared);
    }
}

/// The node's hello: its network, its wallet's state, whether its words are
/// marked saved, and its receive address. All public.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Hello {
    pub net_id: String,
    pub genesis: String,
    /// The wallet switch's state: "on" when a wallet is loaded.
    pub wallet: String,
    pub backed_up: bool,
    pub address: Option<String>,
}

impl Hello {
    /// Read a hello reply; None for a refusal or anything else.
    pub fn parse(body: &str) -> Option<Hello> {
        let v: serde_json::Value = serde_json::from_str(body).ok()?;
        if !v.get("ok")?.as_bool()? {
            return None;
        }
        let net = v.get("net")?;
        Some(Hello {
            net_id: net.get("id")?.as_str()?.to_string(),
            genesis: net.get("genesis")?.as_str()?.to_string(),
            wallet: v.get("wallet")?.as_str()?.to_string(),
            backed_up: v.get("backed_up")?.as_bool()?,
            address: v.get("address").and_then(|a| a.as_str()).map(str::to_string),
        })
    }

    /// Whether the node runs on `net`: its id and its genesis both match.
    pub fn is_net(&self, net: Net) -> bool {
        self.net_id == net.id && self.genesis == net.genesis
    }
}

/// The 24 words, each in a buffer wiped when dropped. Its Debug prints
/// `[24 words]`, and it has no Display, so it never reaches a log line. It
/// serializes as a list of strings, for the backup window only.
pub struct Words(Vec<Zeroizing<String>>);

impl Words {
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// 24 words, each 3 to 8 letters a to z (the BIP39 English list).
    pub fn well_formed(&self) -> bool {
        self.0.len() == WORD_COUNT && self.0.iter().all(|w| (3..=8).contains(&w.len()) && w.bytes().all(|b| b.is_ascii_lowercase()))
    }
}

impl std::fmt::Debug for Words {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[24 words]")
    }
}

impl Serialize for Words {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.collect_seq(self.0.iter().map(|w| w.as_str()))
    }
}

/// One word, copied straight into a wiped buffer.
struct Word(Zeroizing<String>);

impl<'de> Deserialize<'de> for Word {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Word;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a word")
            }
            fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<Word, E> {
                let mut w = Zeroizing::new(String::with_capacity(s.len()));
                w.push_str(s);
                Ok(Word(w))
            }
        }
        d.deserialize_str(V)
    }
}

impl<'de> Deserialize<'de> for Words {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = Words;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a list of words")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Words, A::Error> {
                // Room for every word up front: a reallocation moves only the
                // buffers' handles, but it is one fewer copy to think about.
                let mut words = Vec::with_capacity(WORD_COUNT);
                while let Some(Word(w)) = seq.next_element()? {
                    if words.len() == WORD_COUNT * 2 {
                        return Err(serde::de::Error::custom("too many words"));
                    }
                    words.push(w);
                }
                Ok(Words(words))
            }
        }
        d.deserialize_seq(V)
    }
}

/// The node's answer to `reveal` or `saved`, read. Unknown fields (the
/// node's error sentence, the wallet view) are ignored.
#[derive(Deserialize)]
pub struct Answer {
    pub ok: bool,
    #[serde(default)]
    pub words: Option<Words>,
    #[serde(default)]
    pub key: Option<u32>,
    #[serde(default)]
    pub address: Option<String>,
    /// A refusal because the words are marked saved already.
    #[serde(default)]
    pub saved: bool,
}

impl Answer {
    /// Read an answer; None when it is not one.
    pub fn parse(body: &str) -> Option<Answer> {
        serde_json::from_str(body).ok()
    }
}

impl std::fmt::Debug for Answer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The words print as their count only (their own Debug).
        write!(f, "Answer {{ ok: {}, words: {:?}, key: {:?}, saved: {} }}", self.ok, self.words, self.key, self.saved)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};

    /// Made-up words for the tests (from the BIP39 list, but not a wallet's).
    const TEST_WORDS: [&str; 24] = [
        "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident",
        "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual",
    ];

    fn reveal_json(key: u32, address: &str) -> String {
        let words = serde_json::to_string(&TEST_WORDS).unwrap();
        format!(r#"{{"ok":true,"words":{words},"key":{key},"address":"{address}"}}"#)
    }

    /// A fake node over real pipes: the test reads the app's requests on
    /// `requests` and writes whatever it likes to `replies`.
    struct FakeNode {
        channel: Arc<Channel>,
        requests: BufReader<std::io::PipeReader>,
        replies: std::io::PipeWriter,
    }

    fn fake_node(timeout: Duration) -> FakeNode {
        let (req_read, req_write) = std::io::pipe().unwrap();
        let (rep_read, rep_write) = std::io::pipe().unwrap();
        FakeNode { channel: Channel::start_with(req_write, rep_read, timeout), requests: BufReader::new(req_read), replies: rep_write }
    }

    impl FakeNode {
        /// Read one request line and return its id and op.
        fn next_request(&mut self) -> (u64, String) {
            let mut line = String::new();
            self.requests.read_line(&mut line).unwrap();
            let v: serde_json::Value = serde_json::from_str(line.trim_end()).unwrap();
            assert_eq!(v["v"], 1);
            (v["id"].as_u64().unwrap(), v["op"].as_str().unwrap().to_string())
        }

        fn write(&mut self, bytes: &[u8]) {
            self.replies.write_all(bytes).unwrap();
            self.replies.flush().unwrap();
        }
    }

    /// Run `request` on its own thread, as the commands do.
    fn ask(channel: &Arc<Channel>, op: Op) -> std::thread::JoinHandle<Result<Zeroizing<String>, Failed>> {
        let channel = channel.clone();
        std::thread::spawn(move || channel.request(op))
    }

    #[test]
    fn request_lines_are_the_nodes_wire() {
        assert_eq!(Op::Hello.line(1), "{\"v\":1,\"id\":1,\"op\":\"hello\"}\n");
        assert_eq!(Op::Reveal.line(2), "{\"v\":1,\"id\":2,\"op\":\"reveal\"}\n");
        assert_eq!(Op::Saved(4_294_967_295).line(3), "{\"v\":1,\"id\":3,\"op\":\"saved\",\"key\":4294967295}\n");
    }

    #[test]
    fn a_frame_reaches_only_the_request_with_its_id() {
        let mut node = fake_node(Duration::from_secs(10));
        let waiting = ask(&node.channel, Op::Hello);
        let (id, op) = node.next_request();
        assert_eq!((id, op.as_str()), (1, "hello"));
        // A stale id, an unknown id, a frame with no JSON, lines that are
        // not frames: all dropped, none answers the request.
        node.write(b"ssf-shell/1 0 {\"ok\":false}\n");
        node.write(b"ssf-shell/1 2 {\"ok\":true,\"x\":1}\n");
        node.write(b"ssf-shell/1 1 \n");
        node.write(b"ssf-shell/1 1\n");
        node.write(b"ssf-shell/1 +1 {}\n");
        node.write(b"ssf-shell/2 1 {}\n");
        node.write(b"a log line on stdout\n");
        node.write(b"\n");
        node.write(b"ssf-shell/1 1 {\"ok\":true,\"mine\":1}\n");
        let reply = waiting.join().unwrap().unwrap();
        assert_eq!(reply.as_str(), "{\"ok\":true,\"mine\":1}");
        assert_eq!(node.channel.dropped(), 8);

        // A second frame for the same id, after the request was answered, is
        // dropped too.
        node.write(b"ssf-shell/1 1 {\"ok\":true,\"again\":1}\n");
        let waiting = ask(&node.channel, Op::Reveal);
        let (id, op) = node.next_request();
        assert_eq!((id, op.as_str()), (2, "reveal"));
        node.write(b"ssf-shell/1 2 {\"ok\":true,\"second\":1}\n");
        assert_eq!(waiting.join().unwrap().unwrap().as_str(), "{\"ok\":true,\"second\":1}");
        assert_eq!(node.channel.dropped(), 9);
    }

    #[test]
    fn a_line_over_the_cap_is_dropped_whole() {
        let mut node = fake_node(Duration::from_secs(10));
        let waiting = ask(&node.channel, Op::Hello);
        let (id, _) = node.next_request();
        // A frame for the right id, but too long: dropped, and the rest of
        // that line too (its tail is not read as a line of its own).
        let long = format!("ssf-shell/1 {id} {{\"pad\":\"{}\"}}\n", "x".repeat(MAX_REPLY));
        node.write(long.as_bytes());
        // Exactly the cap is still a line.
        let head = format!("ssf-shell/1 {id} ");
        let fits = format!("{head}{{\"pad\":\"{}\"}}", "y".repeat(MAX_REPLY - head.len() - 10));
        assert_eq!(fits.len(), MAX_REPLY);
        node.write(format!("{fits}\n").as_bytes());
        let reply = waiting.join().unwrap().unwrap();
        assert!(reply.starts_with("{\"pad\":\"yyy"));
        assert_eq!(node.channel.dropped(), 1);
    }

    #[test]
    fn the_timeout_fires_and_a_late_reply_is_dropped() {
        let mut node = fake_node(Duration::from_millis(200));
        let started = Instant::now();
        let waiting = ask(&node.channel, Op::Reveal);
        let (id, _) = node.next_request();
        assert_eq!(waiting.join().unwrap().unwrap_err(), Failed::TimedOut);
        assert!(started.elapsed() >= Duration::from_millis(200));
        // The late reply finds no request waiting.
        node.write(format!("ssf-shell/1 {id} {{\"ok\":true}}\n").as_bytes());
        // The next request has the next id, and the late frame never answers it.
        let waiting = ask(&node.channel, Op::Hello);
        let (next, _) = node.next_request();
        assert_eq!(next, id + 1);
        node.write(format!("ssf-shell/1 {next} {{\"ok\":true,\"n\":2}}\n").as_bytes());
        assert_eq!(waiting.join().unwrap().unwrap().as_str(), "{\"ok\":true,\"n\":2}");
        assert_eq!(node.channel.dropped(), 1);
    }

    #[test]
    fn a_node_that_exits_closes_the_channel() {
        let mut node = fake_node(Duration::from_secs(10));
        let waiting = ask(&node.channel, Op::Hello);
        let _ = node.next_request();
        node.write(b"ssf-shell/1 1 {\"ok\":tr");
        drop(node.replies);
        assert_eq!(waiting.join().unwrap().unwrap_err(), Failed::Closed);
        assert_eq!(node.channel.dropped(), 1, "a line cut by the end is dropped");
        assert_eq!(node.channel.request(Op::Hello).unwrap_err(), Failed::Closed);
    }

    #[test]
    fn closing_stdin_gives_the_node_eof_and_ends_the_asking() {
        let mut node = fake_node(Duration::from_secs(10));
        node.channel.close_stdin();
        let mut rest = String::new();
        assert_eq!(node.requests.read_to_string(&mut rest).unwrap(), 0, "EOF");
        assert_eq!(node.channel.request(Op::Hello).unwrap_err(), Failed::Closed);
    }

    fn hello_json(net: Net, wallet: &str, backed_up: bool, address: Option<&str>) -> String {
        let Net { id, genesis, .. } = net;
        serde_json::json!({ "ok": true, "net": { "id": id, "genesis": genesis }, "wallet": wallet, "backed_up": backed_up, "address": address }).to_string()
    }

    #[test]
    fn a_hello_for_another_network_turns_the_window_off() {
        let other = if SHELL_NET == TESTNET11 { MAINNET } else { TESTNET11 };
        let mut node = fake_node(Duration::from_secs(10));

        let channel = node.channel.clone();
        let waiting = std::thread::spawn(move || channel.hello());
        let (id, op) = node.next_request();
        assert_eq!(op, "hello");
        node.write(format!("ssf-shell/1 {id} {}\n", hello_json(SHELL_NET, "on", false, Some("txch1abc"))).as_bytes());
        let hello = waiting.join().unwrap().unwrap();
        assert!(hello.is_net(SHELL_NET));
        assert_eq!(hello.address.as_deref(), Some("txch1abc"));
        assert!(!node.channel.other_network());

        let channel = node.channel.clone();
        let waiting = std::thread::spawn(move || channel.hello());
        let (id, _) = node.next_request();
        node.write(format!("ssf-shell/1 {id} {}\n", hello_json(other, "on", false, None)).as_bytes());
        let _ = waiting.join().unwrap().unwrap();
        assert!(node.channel.other_network(), "another network: off, for the run");

        // The same id with the other genesis is another network too.
        let forged = Hello { net_id: SHELL_NET.id.into(), genesis: other.genesis.into(), ..Hello::default() };
        assert!(!forged.is_net(SHELL_NET));
        let forged = Hello { net_id: other.id.into(), genesis: SHELL_NET.genesis.into(), ..Hello::default() };
        assert!(!forged.is_net(SHELL_NET));
        // A refusal or garbage reads as no network at all.
        assert_eq!(Hello::parse(r#"{"ok":false,"refused":"bad_json","error":"x"}"#), None);
        assert_eq!(Hello::parse("not json"), None);
        assert!(!Hello::default().is_net(SHELL_NET));
    }

    #[test]
    fn hello_reads_the_nodes_answer() {
        let h = Hello::parse(&hello_json(TESTNET11, "ready", true, None)).unwrap();
        let want = Hello {
            net_id: "testnet11".into(),
            genesis: TESTNET11.genesis.into(),
            wallet: "ready".into(),
            backed_up: true,
            address: None,
        };
        assert_eq!(h, want);
    }

    #[test]
    fn the_shell_network_follows_the_feature() {
        if cfg!(feature = "chia-mainnet") {
            assert_eq!(SHELL_NET, MAINNET);
        } else {
            assert_eq!(SHELL_NET, TESTNET11);
        }
    }

    #[test]
    fn the_words_debug_prints_only_a_count() {
        let a = Answer::parse(&reveal_json(7, "txch1abc")).unwrap();
        let words = a.words.as_ref().unwrap();
        assert_eq!(format!("{words:?}"), "[24 words]");
        assert_eq!(format!("{words:#?}"), "[24 words]");
        let debug = format!("{a:?}");
        assert!(!debug.contains(TEST_WORDS[0]), "the answer's Debug holds no word either");
        assert!(words.well_formed());
        assert_eq!((a.ok, a.key, a.address.as_deref(), a.saved), (true, Some(7), Some("txch1abc"), false));
        // It serializes as the plain list, for the window.
        let back: Vec<String> = serde_json::from_str(&serde_json::to_string(words).unwrap()).unwrap();
        assert_eq!(back, TEST_WORDS);
    }

    #[test]
    fn answers_read_refusals_and_ill_formed_words() {
        let a = Answer::parse(r#"{"ok":false,"saved":true,"error":"these words were marked saved"}"#).unwrap();
        assert!(!a.ok && a.saved && a.words.is_none());
        let a = Answer::parse(r#"{"ok":true,"wallet":{"state":"on"}}"#).unwrap();
        assert!(a.ok && a.words.is_none());
        for bad in [r#"["a"]"#, r#"["abandon"]"#, r#"["ABANDON"]"#] {
            let a = Answer::parse(&format!(r#"{{"ok":true,"words":{bad},"key":1}}"#)).unwrap();
            assert!(!a.words.unwrap().well_formed());
        }
        assert!(Answer::parse("garbage").is_none());
    }

    /// The commands' own `node_command` test lives in main.rs; this one
    /// checks what [`attach`] adds (nothing is spawned, and nothing is read
    /// from this process's environment).
    #[test]
    fn attach_sets_only_the_channel_variable() {
        let mut cmd = node_command("ssf-p2p-node");
        attach(&mut cmd);
        let envs: std::collections::BTreeMap<_, _> = cmd.get_envs().collect();
        assert_eq!(envs.get(std::ffi::OsStr::new(CHANNEL_ENV)), Some(&Some(std::ffi::OsStr::new("1"))));
        let net = if cfg!(feature = "chia-mainnet") { Some(std::ffi::OsStr::new("mainnet")) } else { None };
        assert_eq!(envs.get(std::ffi::OsStr::new(NETWORK_ENV)), Some(&net));
        assert_eq!(envs.len(), 2);
    }

    /// On Linux the guard is the real prctl: once it says the pipes are
    /// guarded, this process is not dumpable. (Making the test process not
    /// dumpable is harmless.)
    #[cfg(target_os = "linux")]
    #[test]
    fn the_pipes_are_guarded_only_by_a_prctl_that_held() {
        assert!(pipes_guarded(), "prctl(PR_SET_DUMPABLE, 0) holds in a plain process");
        // SAFETY: PR_GET_DUMPABLE takes plain integers and no pointer.
        let dumpable = unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) };
        assert_eq!(dumpable, 0, "not dumpable once guarded");
        assert!(pipes_guarded(), "decided once");
    }
}
