//! 🖥️ The desktop app's channel: the spawned node's own stdin and stdout
//! (docs: native-reveal design, decisions 2 to 5).
//!
//! The desktop app asks the node for the 24 words, and tells it they are
//! saved, over the pipes it spawned the node with. No other OS user can
//! open those pipes, so holding them is the authentication: no token in the
//! environment, argv or a nameable socket. A program of the player's own OS
//! user is the design's "same-user malware", which can read the identity
//! file itself; on Linux the node still makes itself not dumpable while the
//! channel is on ([`guard_pipes`]), so such a program cannot reopen the
//! node's ends of the pipes through `/proc/<pid>/fd`, and the channel stays
//! shut if that fails.
//!
//! The channel is on only when the app asks: `SSF_SHELL_CHANNEL` is exactly
//! `1` and neither stdin nor stdout is a terminal ([`started_of`]). The
//! desktop app removes the variable from every node it spawns and sets it
//! only on its own spawn, so a variable in the player's environment, or a
//! node started by hand in a terminal, never turns it on. Decided once at
//! startup ([`init`]) and sticky for the run ([`started`]): a node started
//! with the channel keeps refusing the page reveal after stdin closes.
//!
//! While it is on, stdout carries only frames: the crate's `println!`
//! (main.rs, before the first `mod`) writes to stderr instead.
//!
//! The wire, one line each way:
//! - Request on stdin: `{"v":1,"id":N,"op":"hello"|"reveal"|"saved"}`, and
//!   `saved` also carries `"key":K`, the key fingerprint the app got from its
//!   own last reveal (the same key the page's `?key=` names). `id` is the
//!   app's counter for the run, used only to match a reply to its request.
//!   At most [`MAX_LINE`] bytes before the newline.
//! - Reply on stdout: `ssf-shell/1 <id> <json>\n`, written whole under the
//!   stdout lock by the channel thread only. A refusal of a line whose id
//!   could not be read carries id 0.
//!
//! A line that is too long gets [`Refusal::TooLong`] and closes the channel:
//! nothing more is answered, and the rest of stdin is read and dropped until
//! EOF, so the app's writes never block on a full pipe. Bad JSON, another `v` or an unknown op get their own fixed refusal and the
//! channel reads on. EOF ends the thread and nothing else. A refusal frame is
//! a fixed sentence and never holds a word.

use std::ffi::OsStr;
use std::io::{IsTerminal, Read, Write};
use std::sync::OnceLock;

use zeroize::{Zeroize, Zeroizing};

/// The variable the desktop app sets on its own spawn.
pub const CHANNEL_ENV: &str = "SSF_SHELL_CHANNEL";

/// The longest request line, in bytes before its newline.
pub const MAX_LINE: usize = 1024;

/// The first word of every reply line.
pub const FRAME_TAG: &str = "ssf-shell/1";

/// The run's answer to [`started_of`], set once by [`init`].
static STARTED: OnceLock<bool> = OnceLock::new();

/// Whether [`guard_pipes`] held, set once by [`init`] while the channel is on.
static GUARDED: OnceLock<bool> = OnceLock::new();

/// Whether the channel is on, from the raw `SSF_SHELL_CHANNEL` and whether
/// stdin and stdout are terminals. Exactly `1` and two pipes (or files): a
/// terminal on either side is a person, not the app.
pub fn started_of(var: Option<&OsStr>, stdin_is_terminal: bool, stdout_is_terminal: bool) -> bool {
    var == Some(OsStr::new("1")) && !stdin_is_terminal && !stdout_is_terminal
}

/// Decide the channel for this run, once: main() calls it right after the
/// network is chosen and before anything else prints or the wallet loads.
/// Later calls return the first answer.
pub fn init() -> bool {
    let on = *STARTED.get_or_init(|| {
        started_of(
            std::env::var_os(CHANNEL_ENV).as_deref(),
            std::io::stdin().is_terminal(),
            std::io::stdout().is_terminal(),
        )
    });
    if on {
        GUARDED.get_or_init(guard_pipes);
    }
    on
}

/// Linux: make the node not dumpable (`prctl(PR_SET_DUMPABLE, 0)`, as
/// ssh-agent does), so `/proc/<pid>/fd` and ptrace refuse every process
/// without `CAP_SYS_PTRACE`, the player's own included: none of them can
/// reopen the node's stdin or stdout and ask for the words. True when it
/// held. Elsewhere there is no `/proc` to close, and it is true.
#[cfg(target_os = "linux")]
fn guard_pipes() -> bool {
    // SAFETY: PR_SET_DUMPABLE takes plain integers and no pointer.
    unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong, 0 as libc::c_ulong) == 0 }
}

#[cfg(not(target_os = "linux"))]
fn guard_pipes() -> bool {
    true
}

/// Whether the channel's thread may serve: the channel is on and
/// [`guard_pipes`] held. A channel that is on but unguarded answers
/// nothing, and still keeps the page from showing the words (fails closed).
pub fn serves(started: bool, guarded: bool) -> bool {
    started && guarded
}

/// Whether the desktop app's channel is on for this run. False until
/// [`init`] ran (tests never run it, so they never read the environment),
/// then the same answer for the rest of the run.
pub fn started() -> bool {
    STARTED.get().copied().unwrap_or(false)
}

/// One request's op.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    /// The node's network, wallet state, saved flag and address.
    Hello,
    /// The 24 words of the loaded wallet (the words route's reveal).
    Reveal,
    /// The words of this key fingerprint are saved (the words route's mark).
    Saved(u32),
}

/// The channel's own refusals, each a fixed sentence.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// A line longer than [`MAX_LINE`]: the channel closes after it.
    TooLong,
    /// Not a JSON object with a whole-number `id`.
    BadJson,
    /// `v` is not 1.
    BadVersion,
    /// `op` is not one this node knows.
    UnknownOp,
    /// `saved` without a key fingerprint that fits a u32.
    BadKey,
    /// An answer that cannot go in one line (never expected).
    Internal,
}

impl Refusal {
    /// The refusal's short name, for the app to match on.
    pub fn code(self) -> &'static str {
        match self {
            Refusal::TooLong => "too_long",
            Refusal::BadJson => "bad_json",
            Refusal::BadVersion => "bad_version",
            Refusal::UnknownOp => "unknown_op",
            Refusal::BadKey => "bad_key",
            Refusal::Internal => "internal",
        }
    }

    /// The refusal's sentence.
    pub fn error(self) -> &'static str {
        match self {
            Refusal::TooLong => "the request line is longer than 1 KiB, so the channel is closed",
            Refusal::BadJson => "the request is not a JSON object with a whole-number id",
            Refusal::BadVersion => "this node speaks version 1 of the channel only",
            Refusal::UnknownOp => "the op is not hello, reveal or saved",
            Refusal::BadKey => "saved needs the key fingerprint from the last reveal",
            Refusal::Internal => "the node could not put its answer in one line",
        }
    }

    /// The refusal's body: `{"ok":false,"refused":<code>,"error":<sentence>}`.
    pub fn body(self) -> Zeroizing<String> {
        Zeroizing::new(serde_json::json!({ "ok": false, "refused": self.code(), "error": self.error() }).to_string())
    }
}

/// What one request line asks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Parsed {
    /// A request to answer with the op's body.
    Ask { id: u64, op: Op },
    /// A request refused with a fixed frame (`id` 0 when none was read).
    Refuse { id: u64, why: Refusal },
}

/// Read one request line (its bytes before the newline).
pub fn parse(line: &[u8]) -> Parsed {
    use serde_json::Value;
    let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(line) else {
        return Parsed::Refuse { id: 0, why: Refusal::BadJson };
    };
    let Some(id) = map.get("id").and_then(Value::as_u64) else {
        return Parsed::Refuse { id: 0, why: Refusal::BadJson };
    };
    if map.get("v").and_then(Value::as_u64) != Some(1) {
        return Parsed::Refuse { id, why: Refusal::BadVersion };
    }
    let op = match map.get("op").and_then(Value::as_str) {
        Some("hello") => Op::Hello,
        Some("reveal") => Op::Reveal,
        Some("saved") => match map.get("key").and_then(Value::as_u64).and_then(|k| u32::try_from(k).ok()) {
            Some(key) => Op::Saved(key),
            None => return Parsed::Refuse { id, why: Refusal::BadKey },
        },
        _ => return Parsed::Refuse { id, why: Refusal::UnknownOp },
    };
    Parsed::Ask { id, op }
}

/// The reply line for request `id`: `ssf-shell/1 <id> <body>\n`, built in a
/// buffer wiped when dropped and sized up front, so it never reallocates
/// (a reallocation would leave the old buffer unwiped). A body that is not
/// one line is replaced by [`Refusal::Internal`].
pub fn frame(id: u64, body: &str) -> Zeroizing<Vec<u8>> {
    let refused;
    let body = if body.bytes().any(|b| b == b'\n' || b == b'\r') {
        refused = Refusal::Internal.body();
        refused.as_str()
    } else {
        body
    };
    let id = id.to_string();
    let mut out = Zeroizing::new(Vec::with_capacity(FRAME_TAG.len() + 1 + id.len() + 1 + body.len() + 1));
    out.extend_from_slice(FRAME_TAG.as_bytes());
    out.push(b' ');
    out.extend_from_slice(id.as_bytes());
    out.push(b' ');
    out.extend_from_slice(body.as_bytes());
    out.push(b'\n');
    out
}

/// How the channel's loop ended.
#[derive(Debug, PartialEq, Eq)]
pub enum End {
    /// stdin closed (the app went away, or closed its end).
    Eof,
    /// stdin could not be read.
    ReadFailed,
    /// A line was too long: refused, and the channel closed.
    TooLong,
    /// A reply could not be written: the channel writes nothing more.
    WriteFailed,
}

/// One line read: whole, too long, or the end.
enum Line {
    Whole,
    TooLong,
    Eof,
}

/// Read one line into `line` (cleared first, its capacity [`MAX_LINE`] so
/// it never reallocates), a byte at a time, each byte wiped after it is
/// copied. A line cut by EOF counts as EOF and is not answered.
fn read_line<R: Read>(input: &mut R, line: &mut Zeroizing<Vec<u8>>) -> std::io::Result<Line> {
    line.zeroize();
    let mut byte = Zeroizing::new([0u8; 1]);
    loop {
        match input.read(&mut byte[..]) {
            Ok(0) => return Ok(Line::Eof),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
        if byte[0] == b'\n' {
            return Ok(Line::Whole);
        }
        if line.len() == MAX_LINE {
            return Ok(Line::TooLong);
        }
        line.push(byte[0]);
    }
}

/// Read and drop the rest of `input` until EOF or a read error, wiping
/// each chunk: after a line that is too long the channel answers nothing
/// more, but it keeps reading, so the app's writes to the node's stdin never
/// block on a full pipe and its requests fail by its own timeout.
fn drain<R: Read>(input: &mut R) {
    let mut chunk = Zeroizing::new([0u8; 256]);
    loop {
        match input.read(&mut chunk[..]) {
            Ok(0) => return,
            Ok(_) => chunk.zeroize(),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}

/// Write one reply line whole, then flush.
fn send<W: Write>(out: &mut W, id: u64, body: &str) -> std::io::Result<()> {
    let frame = frame(id, body);
    out.write_all(&frame)?;
    out.flush()
}

/// The channel's loop: read a request line from `input`, answer it with
/// `answer` (the node's ops) or a fixed refusal, write the reply line to
/// `out`, until EOF, a read or write error, or a line that is too long.
/// Generic over the pipes so the tests run it over memory.
pub fn serve<R: Read, W: Write>(mut input: R, mut out: W, mut answer: impl FnMut(Op) -> Zeroizing<String>) -> End {
    let mut line = Zeroizing::new(Vec::with_capacity(MAX_LINE));
    loop {
        match read_line(&mut input, &mut line) {
            Ok(Line::Whole) => {}
            Ok(Line::Eof) => return End::Eof,
            Err(_) => return End::ReadFailed,
            Ok(Line::TooLong) => {
                let _ = send(&mut out, 0, &Refusal::TooLong.body());
                drain(&mut input);
                return End::TooLong;
            }
        }
        let parsed = parse(&line);
        line.zeroize();
        let (id, body) = match parsed {
            Parsed::Ask { id, op } => (id, answer(op)),
            Parsed::Refuse { id, why } => (id, why.body()),
        };
        if send(&mut out, id, &body).is_err() {
            return End::WriteFailed;
        }
    }
}

/// The process's stdout for frames: each `write_all` takes the stdout lock,
/// writes the whole frame and flushes it before letting go, so nothing else
/// that writes to stdout can land inside a frame.
struct StdoutFrames;

impl Write for StdoutFrames {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.write_all(buf).map(|()| buf.len())
    }

    fn write_all(&mut self, buf: &[u8]) -> std::io::Result<()> {
        let mut out = std::io::stdout().lock();
        out.write_all(buf)?;
        out.flush()
    }

    fn flush(&mut self) -> std::io::Result<()> {
        std::io::stdout().lock().flush()
    }
}

/// Start the channel's thread when the channel is on: a dedicated blocking
/// thread that reads stdin and is the only writer of frames. `answer` runs
/// on that thread, one request at a time. Nothing when it is off.
pub fn spawn(answer: impl FnMut(Op) -> Zeroizing<String> + Send + 'static) {
    if !started() {
        return;
    }
    if !serves(true, GUARDED.get().copied().unwrap_or(false)) {
        eprintln!("🖥️ Desktop app channel: the node could not stop other programs from opening its pipes, so the channel stays closed; the page still cannot show the 24 words");
        return;
    }
    let spawned = std::thread::Builder::new().name("ssf-shell-channel".into()).spawn(move || {
        match serve(std::io::stdin().lock(), StdoutFrames, answer) {
            End::Eof => eprintln!("🖥️ Desktop app channel: closed by the app; the node runs on, and the page still cannot show the 24 words"),
            End::ReadFailed => eprintln!("🖥️ Desktop app channel: stdin could not be read, so the channel is closed"),
            End::TooLong => eprintln!("🖥️ Desktop app channel: a request line was longer than 1 KiB, so the channel is closed"),
            End::WriteFailed => eprintln!("🖥️ Desktop app channel: a reply could not be written, so the channel writes nothing more"),
        }
    });
    match spawned {
        Ok(_) => eprintln!("🖥️ Desktop app channel: on. The node's log goes to stderr, and only the desktop app shows the 24 words"),
        Err(e) => eprintln!("🖥️ Desktop app channel: its thread could not start ({e}); the page still cannot show the 24 words"),
    }
}

/// The `hello` answer: the node's network, the wallet's state, whether its
/// words are marked saved, and its receive address (all public).
pub fn hello_body(
    net: crate::chia_network::ChiaNet,
    wallet: &crate::chia_wallet_switch::WalletSwitch,
    address: Option<&str>,
) -> Zeroizing<String> {
    Zeroizing::new(
        serde_json::json!({
            "ok": true,
            "net": { "id": net.id(), "genesis": net.genesis_hex() },
            "wallet": wallet.state,
            "backed_up": wallet.backed_up,
            "address": address,
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chia_network::ChiaNet;
    use crate::chia_wallet_switch::{Backup, WalletState, WalletSwitch};

    /// A fake 24 words: what a stub reveal answers, so the tests can look
    /// for it in every refusal (not a wallet's words).
    const STUB_WORDS: &str = "stubword";

    /// The three ops' stub: hello, a reveal whose body holds a "word", and a
    /// saved mark that echoes its key.
    fn stub(op: Op) -> Zeroizing<String> {
        Zeroizing::new(match op {
            Op::Hello => r#"{"ok":true,"hello":1}"#.to_string(),
            Op::Reveal => format!(r#"{{"ok":true,"words":["{STUB_WORDS}"],"key":7}}"#),
            Op::Saved(key) => format!(r#"{{"ok":true,"saved":{key}}}"#),
        })
    }

    /// Run the loop over `input`, with the stub, and return how it ended and
    /// the lines it wrote.
    fn run(input: &[u8]) -> (End, Vec<String>, Vec<Op>) {
        let mut out = Vec::new();
        let mut asked = Vec::new();
        let end = serve(input, &mut out, |op| {
            asked.push(op);
            stub(op)
        });
        let text = String::from_utf8(out).unwrap();
        assert!(text.is_empty() || text.ends_with('\n'), "every frame is a whole line");
        (end, text.lines().map(str::to_string).collect(), asked)
    }

    fn refusal_line(id: u64, why: Refusal) -> String {
        format!("ssf-shell/1 {id} {}", why.body().as_str())
    }

    #[test]
    fn the_channel_is_on_only_for_exactly_1_and_two_pipes() {
        let one = Some(OsStr::new("1"));
        assert!(started_of(one, false, false), "the app's spawn");
        assert!(!started_of(one, true, false), "stdin is a terminal: a person started it");
        assert!(!started_of(one, false, true), "stdout is a terminal");
        assert!(!started_of(one, true, true));
        assert!(!started_of(None, false, false), "unset: off");
        for off in ["", "0", "true", " 1", "1 ", "01", "yes", "on"] {
            assert!(!started_of(Some(OsStr::new(off)), false, false), "{off:?} is not exactly 1");
        }
    }

    /// The thread serves only a channel that is on and whose pipes are
    /// guarded; an unguarded one answers nothing (and the page stays
    /// refused, since [`started`] alone decides that).
    #[test]
    fn the_channel_serves_only_when_its_pipes_are_guarded() {
        assert!(serves(true, true));
        assert!(!serves(true, false), "on but unguarded: fails closed");
        assert!(!serves(false, true));
        assert!(!serves(false, false));
    }

    /// The tests never run [`init`], so the channel reads as off in every
    /// test and nothing here reads the environment.
    #[test]
    fn the_channel_is_off_until_init_runs() {
        assert!(!started());
    }

    /// The crate's `println!` (main.rs, before the first `mod`) is the one
    /// this out-of-line module sees: std's would not take the probe arm.
    #[test]
    fn the_crate_println_shadows_std_in_out_of_line_modules() {
        assert!(std::hint::black_box(println!(@ssf_shell_channel_probe)));
        // And with the channel off it prints as std's does (to the test's
        // captured stdout).
        println!("🖥️ a log line with the channel off: {}", 1);
        println!();
    }

    #[test]
    fn requests_parse_to_their_op_and_echo_their_id() {
        assert_eq!(parse(br#"{"v":1,"id":3,"op":"hello"}"#), Parsed::Ask { id: 3, op: Op::Hello });
        assert_eq!(parse(br#"{"v":1,"id":4,"op":"reveal"}"#), Parsed::Ask { id: 4, op: Op::Reveal });
        assert_eq!(parse(br#"{"v":1,"id":5,"op":"saved","key":4294967295}"#), Parsed::Ask { id: 5, op: Op::Saved(u32::MAX) });
        assert_eq!(parse(br#" {"op":"hello","id":18446744073709551615,"v":1,"x":[1]}"#), Parsed::Ask { id: u64::MAX, op: Op::Hello }, "order and extra fields do not matter");
        assert_eq!(parse(b"{\"v\":1,\"id\":6,\"op\":\"hello\"}\r"), Parsed::Ask { id: 6, op: Op::Hello }, "a CRLF line");

        for bad in [&b""[..], b"hello", b"[1]", b"{", b"null", br#"{"v":1,"op":"hello"}"#, br#"{"v":1,"id":-1,"op":"hello"}"#, br#"{"v":1,"id":1.5,"op":"hello"}"#, br#"{"v":1,"id":"1","op":"hello"}"#] {
            assert_eq!(parse(bad), Parsed::Refuse { id: 0, why: Refusal::BadJson }, "{:?}", String::from_utf8_lossy(bad));
        }
        for v in [r#""v":2,"#, r#""v":0,"#, r#""v":"1","#, r#""v":1.0,"#, ""] {
            let line = format!(r#"{{{v}"id":9,"op":"hello"}}"#);
            assert_eq!(parse(line.as_bytes()), Parsed::Refuse { id: 9, why: Refusal::BadVersion }, "{line}");
        }
        for op in [r#""op":"HELLO""#, r#""op":"words""#, r#""op":1"#, r#""x":1"#] {
            let line = format!(r#"{{"v":1,"id":9,{op}}}"#);
            assert_eq!(parse(line.as_bytes()), Parsed::Refuse { id: 9, why: Refusal::UnknownOp }, "{line}");
        }
        for key in ["", r#","key":-1"#, r#","key":4294967296"#, r#","key":"7""#, r#","key":7.5"#] {
            let line = format!(r#"{{"v":1,"id":9,"op":"saved"{key}}}"#);
            assert_eq!(parse(line.as_bytes()), Parsed::Refuse { id: 9, why: Refusal::BadKey }, "{line}");
        }
    }

    #[test]
    fn each_op_is_answered_in_one_frame_with_its_id() {
        let (end, lines, asked) = run(b"{\"v\":1,\"id\":1,\"op\":\"hello\"}\n{\"v\":1,\"id\":2,\"op\":\"reveal\"}\n{\"v\":1,\"id\":3,\"op\":\"saved\",\"key\":7}\n");
        assert_eq!(end, End::Eof, "EOF ends the loop");
        assert_eq!(asked, [Op::Hello, Op::Reveal, Op::Saved(7)]);
        assert_eq!(
            lines,
            [
                r#"ssf-shell/1 1 {"ok":true,"hello":1}"#.to_string(),
                format!(r#"ssf-shell/1 2 {{"ok":true,"words":["{STUB_WORDS}"],"key":7}}"#),
                r#"ssf-shell/1 3 {"ok":true,"saved":7}"#.to_string(),
            ]
        );
    }

    #[test]
    fn bad_lines_get_a_fixed_refusal_and_the_channel_reads_on() {
        let input = b"not json\n{\"v\":2,\"id\":5,\"op\":\"hello\"}\n{\"v\":1,\"id\":6,\"op\":\"words\"}\n{\"v\":1,\"id\":7,\"op\":\"saved\"}\n\n{\"v\":1,\"id\":8,\"op\":\"hello\"}\n";
        let (end, lines, asked) = run(input);
        assert_eq!(end, End::Eof);
        assert_eq!(asked, [Op::Hello], "no refused line reaches an op");
        assert_eq!(
            lines,
            [
                refusal_line(0, Refusal::BadJson),
                refusal_line(5, Refusal::BadVersion),
                refusal_line(6, Refusal::UnknownOp),
                refusal_line(7, Refusal::BadKey),
                refusal_line(0, Refusal::BadJson),
                r#"ssf-shell/1 8 {"ok":true,"hello":1}"#.to_string(),
            ]
        );
    }

    #[test]
    fn a_line_over_1_kib_is_refused_and_closes_the_channel() {
        // Exactly 1 KiB before the newline is a line; one byte more is not.
        let fits = format!(r#"{{"v":1,"id":1,"op":"hello","pad":"{}"}}"#, "x".repeat(MAX_LINE - 36));
        assert_eq!(fits.len(), MAX_LINE);
        let (end, lines, _) = run(format!("{fits}\n").as_bytes());
        assert_eq!(end, End::Eof);
        assert_eq!(lines, [r#"ssf-shell/1 1 {"ok":true,"hello":1}"#]);

        let long = format!(r#"{{"v":1,"id":1,"op":"hello","pad":"{}"}}"#, "x".repeat(MAX_LINE - 35));
        assert_eq!(long.len(), MAX_LINE + 1);
        let input = format!("{long}\n{{\"v\":1,\"id\":2,\"op\":\"reveal\"}}\n");
        let (end, lines, asked) = run(input.as_bytes());
        assert_eq!(end, End::TooLong);
        assert!(asked.is_empty(), "nothing after the long line is answered");
        assert_eq!(lines, [refusal_line(0, Refusal::TooLong)]);

        // The rest of stdin is still read to EOF, so the app's writes never
        // block on a full pipe; none of it gets an answer.
        let rest = "{\"v\":1,\"id\":3,\"op\":\"hello\"}\n".repeat(500);
        let mut input = std::io::Cursor::new(format!("{long}\n{rest}").into_bytes());
        let mut out = Vec::new();
        let end = serve(&mut input, &mut out, stub);
        assert_eq!(end, End::TooLong);
        assert_eq!(input.position(), input.get_ref().len() as u64, "read to EOF");
        assert_eq!(String::from_utf8(out).unwrap(), format!("{}\n", refusal_line(0, Refusal::TooLong)));

        // A long line with no newline at all is cut at the cap too.
        let (end, lines, _) = run(&vec![b'{'; 10 * MAX_LINE]);
        assert_eq!((end, lines), (End::TooLong, vec![refusal_line(0, Refusal::TooLong)]));
    }

    #[test]
    fn eof_ends_the_loop_and_answers_nothing_more() {
        assert_eq!(run(b""), (End::Eof, vec![], vec![]));
        let (end, lines, asked) = run(br#"{"v":1,"id":1,"op":"reveal"}"#);
        assert_eq!((end, lines, asked), (End::Eof, vec![], vec![]), "a line cut by EOF is not answered");
    }

    /// No refusal frame holds a word: each is a fixed sentence, whatever the
    /// line held.
    #[test]
    fn a_refusal_frame_never_holds_a_word() {
        let input = format!(
            "{STUB_WORDS}\n{{\"v\":2,\"id\":1,\"op\":\"reveal\",\"w\":\"{STUB_WORDS}\"}}\n{{\"v\":1,\"id\":2,\"op\":\"{STUB_WORDS}\"}}\n{{\"v\":1,\"id\":3,\"op\":\"saved\",\"key\":\"{STUB_WORDS}\"}}\n{}\n",
            STUB_WORDS.repeat(200)
        );
        let (end, lines, asked) = run(input.as_bytes());
        assert_eq!(end, End::TooLong);
        assert!(asked.is_empty());
        assert_eq!(lines.len(), 5);
        for line in &lines {
            assert!(!line.contains(STUB_WORDS), "{line}");
            assert!(line.contains(r#""ok":false"#), "{line}");
        }
        for why in [Refusal::TooLong, Refusal::BadJson, Refusal::BadVersion, Refusal::UnknownOp, Refusal::BadKey, Refusal::Internal] {
            let body = why.body();
            let v: serde_json::Value = serde_json::from_str(&body).unwrap();
            assert_eq!(v, serde_json::json!({ "ok": false, "refused": why.code(), "error": why.error() }));
            assert!(!why.error().contains('"') && !why.error().contains('\n'));
        }
    }

    /// A reply that is not one line never goes out as more than one.
    #[test]
    fn a_frame_is_always_one_line() {
        assert_eq!(&frame(7, r#"{"ok":true}"#)[..], b"ssf-shell/1 7 {\"ok\":true}\n");
        for bad in ["{\"a\":\n1}", "{\"a\":\r1}"] {
            let f = frame(9, bad);
            assert_eq!(String::from_utf8(f.to_vec()).unwrap(), format!("{}\n", refusal_line(9, Refusal::Internal)));
        }
    }

    /// A pipe whose reader went away.
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::from(std::io::ErrorKind::BrokenPipe))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_write_error_stops_the_writing_and_never_panics() {
        let mut asked = 0;
        let end = serve(&b"{\"v\":1,\"id\":1,\"op\":\"hello\"}\n{\"v\":1,\"id\":2,\"op\":\"hello\"}\n"[..], Broken, |op| {
            asked += 1;
            stub(op)
        });
        assert_eq!(end, End::WriteFailed);
        assert_eq!(asked, 1, "nothing more is answered once a reply cannot be written");
        assert_eq!(serve(&b"x\n"[..], Broken, stub), End::WriteFailed);
    }

    /// A stdin that fails.
    struct Unreadable;
    impl Read for Unreadable {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("gone"))
        }
    }

    #[test]
    fn a_read_error_ends_the_loop() {
        let mut out = Vec::new();
        assert_eq!(serve(Unreadable, &mut out, stub), End::ReadFailed);
        assert!(out.is_empty());
    }

    #[test]
    fn hello_names_the_network_the_state_the_saved_flag_and_the_address() {
        let wallet = WalletSwitch {
            state: WalletState::On,
            seed: false,
            legacy: false,
            stays: true,
            held: false,
            mnemonic: true,
            backed_up: true,
            reminted: false,
            at_rest: None,
            at_rest_next: None,
            rewrapped: false,
            error: Some("x".into()),
            backup: Backup::Native,
        };
        let body = hello_body(ChiaNet::Testnet11, &wallet, Some("txch1abc"));
        assert!(!body.contains('\n'), "one line");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "ok": true,
                "net": { "id": "testnet11", "genesis": "37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615" },
                "wallet": "on",
                "backed_up": true,
                "address": "txch1abc",
            }),
            "only public facts: no error, no key fingerprint, no flags beyond backed_up"
        );
        // Mainnet holds an SSF wallet now: the app's hello there names it as
        // on testnet11, Ready before it is made and On with its address.
        let ready = WalletSwitch { state: WalletState::Ready, backed_up: false, ..wallet.clone() };
        let v: serde_json::Value = serde_json::from_str(&hello_body(ChiaNet::Mainnet, &ready, None)).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "ok": true,
                "net": { "id": "mainnet", "genesis": ChiaNet::Mainnet.genesis_hex() },
                "wallet": "ready",
                "backed_up": false,
                "address": null,
            })
        );
        let on = WalletSwitch { backed_up: false, ..wallet };
        let v: serde_json::Value = serde_json::from_str(&hello_body(ChiaNet::Mainnet, &on, Some("xch1abc"))).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "ok": true,
                "net": { "id": "mainnet", "genesis": ChiaNet::Mainnet.genesis_hex() },
                "wallet": "on",
                "backed_up": false,
                "address": "xch1abc",
            })
        );
    }
}
