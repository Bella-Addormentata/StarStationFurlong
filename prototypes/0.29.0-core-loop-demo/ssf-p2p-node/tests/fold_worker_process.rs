//! The real binary as the fold's worker (PR 6b-1b): `ssf-p2p-node
//! --fold-worker` started as a child process, spoken to over its pipes by a
//! second, independent writing of the frame layout (so a change to the layout
//! in the node must be a change here too). Runs where `house-fold` is on.
#![cfg(feature = "house-fold")]

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

const BIN: &str = env!("CARGO_BIN_EXE_ssf-p2p-node");
const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors/fold-engine-v1.json");

// ── The layout, written out again ───────────────────────────────────────────

fn put_u32(b: &mut Vec<u8>, n: usize) {
    b.extend_from_slice(&(n as u32).to_le_bytes());
}

fn put_str(b: &mut Vec<u8>, s: &str) {
    put_u32(b, s.len());
    b.extend_from_slice(s.as_bytes());
}

fn put_ctx(b: &mut Vec<u8>, ctx: &Value) {
    for f in ["room", "t", "inc"] {
        put_str(b, ctx[f].as_str().unwrap());
    }
}

/// A JSON value as a record value: string 0, integer 1, array 2, object 3, anything else 5 (junk).
fn put_val(b: &mut Vec<u8>, v: &Value) {
    match v {
        Value::String(s) => {
            b.push(0);
            put_str(b, s);
        }
        Value::Number(n) if n.as_i64().is_some_and(|i| i.unsigned_abs() <= 9_007_199_254_740_991) => {
            b.push(1);
            b.extend_from_slice(&n.as_i64().unwrap().to_le_bytes());
        }
        Value::Array(a) => {
            b.push(2);
            put_u32(b, a.len());
            for x in a {
                put_val(b, x);
            }
        }
        Value::Object(o) => {
            b.push(3);
            put_u32(b, o.len());
            for (k, x) in o {
                put_str(b, k);
                put_val(b, x);
            }
        }
        _ => b.push(5),
    }
}

fn frame(body: Vec<u8>) -> Vec<u8> {
    let mut f = (body.len() as u32).to_le_bytes().to_vec();
    f.extend(body);
    f
}

fn put_version(b: &mut Vec<u8>, version: u64) {
    b.extend_from_slice(&version.to_le_bytes());
}

fn cold_frame(c: &Value, version: u64) -> Vec<u8> {
    let mut b = vec![1];
    put_ctx(&mut b, &c["ctx"]);
    put_version(&mut b, version);
    if c["cp"].is_null() {
        b.push(0);
    } else {
        b.push(1);
        put_val(&mut b, &c["cp"]);
    }
    let houses = c["houses"].as_array().unwrap();
    put_u32(&mut b, houses.len());
    for h in houses {
        put_str(&mut b, h.as_str().unwrap());
    }
    let pins = c["pins"].as_array().unwrap();
    put_u32(&mut b, pins.len());
    for p in pins {
        put_str(&mut b, p[0].as_str().unwrap());
        put_str(&mut b, p[1].as_str().unwrap());
    }
    let records = c["records"].as_array().unwrap();
    put_u32(&mut b, records.len());
    for r in records {
        put_str(&mut b, r[0].as_str().unwrap());
        put_val(&mut b, &r[1]);
    }
    frame(b)
}

/// A Warm with nothing to change.
fn warm_frame(ctx: &Value, version: u64) -> Vec<u8> {
    let mut b = vec![2];
    put_ctx(&mut b, ctx);
    put_version(&mut b, version);
    put_u32(&mut b, 0);
    put_u32(&mut b, 0);
    put_u32(&mut b, 0);
    frame(b)
}

fn forget_frame(ctx: &Value) -> Vec<u8> {
    let mut b = vec![3];
    put_ctx(&mut b, ctx);
    frame(b)
}

/// An answer: (tag, version, text).
fn read_answer(out: &mut impl Read, ctx: &Value) -> (u8, u64, String) {
    let mut len = [0u8; 4];
    out.read_exact(&mut len).expect("an answer's byte count");
    let mut body = vec![0u8; u32::from_le_bytes(len) as usize];
    out.read_exact(&mut body).expect("an answer's body");
    let mut at = 1;
    let mut take_str = |at: &mut usize| {
        let n = u32::from_le_bytes(body[*at..*at + 4].try_into().unwrap()) as usize;
        let s = String::from_utf8(body[*at + 4..*at + 4 + n].to_vec()).unwrap();
        *at += 4 + n;
        s
    };
    for f in ["room", "t", "inc"] {
        assert_eq!(take_str(&mut at), ctx[f].as_str().unwrap(), "the answer names the table ({f})");
    }
    let version = u64::from_le_bytes(body[at..at + 8].try_into().unwrap());
    at += 8;
    let text = take_str(&mut at);
    assert_eq!(at, body.len(), "nothing after the text");
    (body[0], version, text)
}

// ── The process ─────────────────────────────────────────────────────────────

struct Worker {
    child: Arc<Mutex<Child>>,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    stderr: std::process::ChildStderr,
}

fn start() -> Worker {
    let mut child = Command::new(BIN).arg("--fold-worker").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("the node binary starts");
    let (stdin, stdout, stderr) = (child.stdin.take().unwrap(), child.stdout.take().unwrap(), child.stderr.take().unwrap());
    let child = Arc::new(Mutex::new(child));
    // A worker that hangs must not hang the test run.
    let watchdog = child.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(120));
        let _ = watchdog.lock().map(|mut c| c.kill());
    });
    Worker { child, stdin: Some(stdin), stdout, stderr }
}

impl Worker {
    fn send(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().expect("stdin is open");
        stdin.write_all(bytes).expect("the worker reads its input");
        stdin.flush().unwrap();
    }

    /// Close its input and wait for it: what it still wrote, what it said of itself, and how it ended.
    fn finish(mut self) -> (Vec<u8>, String, Option<i32>) {
        self.stdin = None;
        let mut out = vec![];
        self.stdout.read_to_end(&mut out).unwrap();
        let mut err = String::new();
        self.stderr.read_to_string(&mut err).unwrap();
        let status = self.child.lock().unwrap().wait().unwrap();
        (out, err, status.code())
    }
}

fn real_case() -> Value {
    let raw = std::fs::read_to_string(VECTORS).unwrap();
    let file: Value = serde_json::from_str(&raw).unwrap();
    file["cases"].as_array().unwrap().iter().find(|c| c["sigs"] == "real").expect("a case with real signatures").clone()
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[test]
fn fold_worker_process_folds_a_signed_table_to_the_pages_bytes_and_leaves_when_the_pipe_closes() {
    let c = real_case();
    let mut w = start();
    w.send(&cold_frame(&c, 17));
    let (tag, version, text) = read_answer(&mut w.stdout, &c["ctx"]);
    assert_eq!((tag, version), (0x81, 17), "a result, for the version it was asked");
    assert_eq!(text, c["summary"].as_str().unwrap(), "the bytes the pages' own fold made");

    // A table it does not hold is dirty; a forgotten one is too; and a Forget has no answer of its own.
    let mut other = c["ctx"].clone();
    other["t"] = Value::String("never-sent".into());
    w.send(&warm_frame(&other, 18));
    assert_eq!(read_answer(&mut w.stdout, &other).0, 0x82);
    w.send(&forget_frame(&c["ctx"]));
    w.send(&warm_frame(&c["ctx"], 19));
    let (tag, version, why) = read_answer(&mut w.stdout, &c["ctx"]);
    assert_eq!((tag, version), (0x82, 19));
    assert!(why.contains("no fold for this table"), "{why}");

    let (rest, err, code) = w.finish();
    assert!(rest.is_empty(), "nothing else on stdout, which is the frames' pipe: {rest:?}");
    assert_eq!(err, "", "and nothing on stderr");
    assert_eq!(code, Some(0), "a closed pipe is the node going, not a failure");
}

#[test]
fn fold_worker_process_with_its_input_closed_at_once_exits_cleanly() {
    let (out, err, code) = start().finish();
    assert!(out.is_empty());
    assert_eq!(err, "");
    assert_eq!(code, Some(0));
}

#[test]
fn fold_worker_process_given_what_is_not_a_frame_says_so_on_stderr_and_exits_nonzero() {
    for bad in [vec![0, 0, 0, 0], vec![2, 0, 0, 0, 0xee, 0], vec![0xff, 0xff, 0xff, 0xff], vec![9, 0, 0, 0, 3, 0, 0, 0], b"GET / HTTP/1.1\r\n\r\n".to_vec()] {
        let mut w = start();
        w.send(&bad);
        let (out, err, code) = w.finish();
        assert!(out.is_empty(), "{bad:?}: {out:?}");
        assert!(err.starts_with("fold worker: "), "{bad:?}: {err:?}");
        assert_eq!(code, Some(2), "{bad:?}");
    }
}

#[test]
fn fold_worker_process_does_not_start_the_node() {
    // Started as a worker the binary opens no file and binds no socket: the
    // node's first lines never come, on stdout or stderr.
    let mut w = start();
    let c = real_case();
    w.send(&cold_frame(&c, 1));
    read_answer(&mut w.stdout, &c["ctx"]);
    let (_, err, code) = w.finish();
    assert!(!err.contains("StarStation") && !err.contains("Swarm"), "{err}");
    assert_eq!(code, Some(0));
}
