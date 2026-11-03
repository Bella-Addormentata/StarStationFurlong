//! The supervisor's rules, in virtual time, against workers the tests play by
//! hand over channels (and a few real child processes): lazy start, answers in
//! order, a worker that hangs up, breaks, lies or goes quiet, the wait before
//! it starts again, and the three strikes.

use super::*;
use crate::fold_wire::{encode_resp, Cold, Warm};
use crate::house_bytes::CVal;
use std::collections::VecDeque;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};

fn secs(s: u64) -> Duration {
    Duration::from_secs(s)
}

fn ctx(t: &str) -> Ctx {
    Ctx { room: "room".into(), t: t.into(), inc: "c0123456789abcdef01234567".into() }
}

fn cold(t: &str, version: u64) -> Req {
    Req::Cold(Cold { ctx: ctx(t), version, base: None, houses: vec![], pins: vec![], records: vec![] })
}

fn warm(t: &str, version: u64) -> Req {
    Req::Warm(Warm { ctx: ctx(t), version, houses: vec![], pins: vec![], changes: vec![] })
}

fn big_warm(t: &str, version: u64, mib: usize) -> Req {
    Req::Warm(Warm { ctx: ctx(t), version, houses: vec![], pins: vec![], changes: vec![("k".into(), Some(CVal::Str("x".repeat(mib << 20))))] })
}

fn result(t: &str, version: u64) -> Resp {
    Resp::Result { ctx: ctx(t), version, text: format!("{{\"table\":\"{t}\"}}") }
}

// ── Workers played by hand ──────────────────────────────────────────────────

struct ChanReader {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl ChanReader {
    fn new(rx: Receiver<Vec<u8>>) -> ChanReader {
        ChanReader { rx, buf: vec![], pos: 0 }
    }
}

impl Read for ChanReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.pos == self.buf.len() {
            match self.rx.recv() {
                Ok(b) => {
                    self.buf = b;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// A pipe into the worker that lets the writer go on whenever it likes.
struct Free(Sender<Vec<u8>>);

impl Write for Free {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.send(b.to_vec()).map_err(|_| io::ErrorKind::BrokenPipe)?;
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A pipe into the worker that holds the writer until the worker reads (a worker that is slow to read).
struct Gated(SyncSender<Vec<u8>>);

impl Write for Gated {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.send(b.to_vec()).map_err(|_| io::ErrorKind::BrokenPipe)?;
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The test's end of a worker.
struct Manual {
    requests: ChanReader,
    replies: Option<Sender<Vec<u8>>>,
    kills: Arc<AtomicUsize>,
    gone: Arc<AtomicBool>,
}

impl Manual {
    /// The next frame the node sent.
    fn next_req(&mut self) -> Req {
        decode_req(&read_frame(&mut self.requests).unwrap().expect("a frame")).unwrap()
    }
    fn reply(&self, resp: &Resp) {
        self.raw(encode_resp(resp).unwrap());
    }
    fn raw(&self, bytes: Vec<u8>) {
        self.replies.as_ref().expect("the worker still has its output").send(bytes).unwrap();
    }
    /// The worker closes its output.
    fn hang_up(&mut self) {
        self.replies = None;
    }
    /// The worker's process is gone.
    fn exit(&self) {
        self.gone.store(true, Ordering::SeqCst);
    }
    fn kills(&self) -> usize {
        self.kills.load(Ordering::SeqCst)
    }
}

use crate::fold_wire::decode_req;

fn manual_link(gated: bool) -> (Link, Manual) {
    let (req_tx, req_rx) = channel::<Vec<u8>>();
    let (gate_tx, gate_rx) = sync_channel::<Vec<u8>>(0);
    let (resp_tx, resp_rx) = channel::<Vec<u8>>();
    let kills = Arc::new(AtomicUsize::new(0));
    let gone = Arc::new(AtomicBool::new(false));
    let (k, g) = (kills.clone(), gone.clone());
    let writer: Box<dyn Write + Send> = if gated { Box::new(Gated(gate_tx)) } else { Box::new(Free(req_tx)) };
    let link = Link::new(
        writer,
        Box::new(ChanReader::new(resp_rx)),
        Box::new(move || {
            k.fetch_add(1, Ordering::SeqCst);
        }),
        Box::new(move || g.load(Ordering::SeqCst)),
    );
    let requests = ChanReader::new(if gated { gate_rx } else { req_rx });
    (link, Manual { requests, replies: Some(resp_tx), kills, gone })
}

/// A reader that waits for a flag before it reads anything.
struct Slow {
    inner: ChanReader,
    go: Arc<AtomicBool>,
}

impl Read for Slow {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while !self.go.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(1));
        }
        self.inner.read(out)
    }
}

/// A worker whose output the node's reader thread does not read until the flag is set.
fn manual_link_with_slow_reader() -> (Link, Manual, Arc<AtomicBool>) {
    let (req_tx, req_rx) = channel::<Vec<u8>>();
    let (resp_tx, resp_rx) = channel::<Vec<u8>>();
    let kills = Arc::new(AtomicUsize::new(0));
    let gone = Arc::new(AtomicBool::new(false));
    let go = Arc::new(AtomicBool::new(false));
    let (k, g) = (kills.clone(), gone.clone());
    let link = Link::new(
        Box::new(Free(req_tx)),
        Box::new(Slow { inner: ChanReader::new(resp_rx), go: go.clone() }),
        Box::new(move || {
            k.fetch_add(1, Ordering::SeqCst);
        }),
        Box::new(move || g.load(Ordering::SeqCst)),
    );
    (link, Manual { requests: ChanReader::new(req_rx), replies: Some(resp_tx), kills, gone }, go)
}

/// Workers handed out one by one; a launch past the plan fails.
struct Plan {
    next: VecDeque<io::Result<Link>>,
    launched: Arc<AtomicUsize>,
}

impl Launch for Plan {
    fn launch(&mut self) -> io::Result<Link> {
        self.launched.fetch_add(1, Ordering::SeqCst);
        self.next.pop_front().unwrap_or_else(|| Err(io::Error::other("no worker left in the plan")))
    }
}

fn plan(items: Vec<io::Result<Link>>) -> (Plan, Arc<AtomicUsize>) {
    let launched = Arc::new(AtomicUsize::new(0));
    (Plan { next: items.into(), launched: launched.clone() }, launched)
}

/// A supervisor over one hand-played worker.
fn with_one_worker(t0: Instant) -> (Supervisor<Plan>, Manual, Arc<AtomicUsize>) {
    let (link, m) = manual_link(false);
    let (p, launched) = plan(vec![Ok(link)]);
    (Supervisor::new(p, t0), m, launched)
}

/// Poll (in real time, at virtual time `now`) until `n` events have come.
fn events<L: Launch>(s: &mut Supervisor<L>, now: Instant, n: usize) -> Vec<Event> {
    let mut got = vec![];
    let deadline = std::time::Instant::now() + secs(30);
    while got.len() < n {
        got.extend(s.poll(now));
        assert!(std::time::Instant::now() < deadline, "waited 30 s for {n} events, have {got:?}");
        if got.len() < n {
            std::thread::sleep(Duration::from_millis(2));
        }
    }
    got
}

fn crashed(e: &Event) -> (&str, &[Ctx], Option<Duration>) {
    match e {
        Event::Crashed { reason, tables, restart_in } => (reason, tables, *restart_in),
        other => panic!("not a crash: {other:?}"),
    }
}

// ── The rules of starting again ─────────────────────────────────────────────

#[test]
fn the_wait_doubles_from_one_second_to_a_minute() {
    let waits: Vec<u64> = (1..=9).map(|n| backoff(n).as_secs()).collect();
    assert_eq!(waits, vec![1, 2, 4, 8, 16, 32, 60, 60, 60]);
    assert_eq!(backoff(0), secs(1));
    assert_eq!(backoff(u32::MAX), secs(60));
}

#[test]
fn three_failures_within_ten_minutes_turn_the_fold_off() {
    let t0 = Instant::now();
    let mut p = RestartPolicy::default();
    assert_eq!(p.on_failure(t0), Restart::After(secs(1)));
    assert_eq!(p.on_failure(t0 + secs(1)), Restart::After(secs(2)));
    assert_eq!(p.on_failure(t0 + secs(3)), Restart::Off);
}

#[test]
fn the_window_is_ten_minutes_and_a_failure_exactly_that_old_still_counts() {
    let t0 = Instant::now();
    let mut p = RestartPolicy::default();
    p.on_failure(t0);
    p.on_failure(t0 + secs(300));
    assert_eq!(p.on_failure(t0 + secs(600)), Restart::Off, "the first is exactly ten minutes old");

    let mut p = RestartPolicy::default();
    p.on_failure(t0);
    p.on_failure(t0 + secs(300));
    assert_eq!(p.on_failure(t0 + secs(601)), Restart::After(secs(4)), "a second older, and it no longer counts");
}

#[test]
fn failures_far_apart_never_turn_it_off_but_the_wait_still_grows_until_a_worker_answers() {
    let t0 = Instant::now();
    let mut p = RestartPolicy::default();
    let mut waits = vec![];
    for i in 0..10 {
        match p.on_failure(t0 + secs(i * 700)) {
            Restart::After(w) => waits.push(w.as_secs()),
            Restart::Off => panic!("off after {i} failures, each more than ten minutes from the last"),
        }
    }
    assert_eq!(waits, vec![1, 2, 4, 8, 16, 32, 60, 60, 60, 60]);
    p.on_answer();
    assert_eq!(p.on_failure(t0 + secs(20_000)), Restart::After(secs(1)), "an answer starts the wait over");
}

#[test]
fn an_answer_does_not_wipe_the_strikes() {
    let t0 = Instant::now();
    let mut p = RestartPolicy::default();
    p.on_failure(t0);
    p.on_answer();
    p.on_failure(t0 + secs(10));
    p.on_answer();
    assert_eq!(p.on_failure(t0 + secs(20)), Restart::Off, "three within ten minutes, whatever came between");
}

// ── Starting ────────────────────────────────────────────────────────────────

#[test]
fn nothing_starts_until_the_first_frame() {
    let t0 = Instant::now();
    let (mut s, mut m, launched) = with_one_worker(t0);
    assert_eq!(s.state(), State::Idle);
    assert!(s.poll(t0 + secs(100)).is_empty());
    assert_eq!(launched.load(Ordering::SeqCst), 0);
    assert_eq!(s.off(), None);
    assert_eq!(s.post(t0, &cold("a", 1)), Post::Posted);
    assert_eq!(launched.load(Ordering::SeqCst), 1);
    assert!(s.is_up());
    assert_eq!(m.next_req(), cold("a", 1));
    assert_eq!(s.counts(), (1, 0));
}

#[test]
fn a_frame_too_big_to_send_is_refused_and_starts_nothing() {
    let t0 = Instant::now();
    let (mut s, _m, launched) = with_one_worker(t0);
    let huge = Req::Warm(Warm { ctx: ctx("a"), version: 1, houses: vec![], pins: vec![], changes: vec![("k".into(), Some(CVal::Str("x".repeat(crate::fold_wire::MAX_FRAME))))] });
    assert!(matches!(s.post(t0, &huge), Post::TooBig(WireError::BadSize(_))));
    assert_eq!(launched.load(Ordering::SeqCst), 0);
    assert_eq!(s.state(), State::Idle);
    assert_eq!(s.owed(), 0);
}

// ── Answers ─────────────────────────────────────────────────────────────────

#[test]
fn an_answer_comes_back_through_poll_and_clears_what_was_owed() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    assert_eq!(s.post(t0, &cold("a", 7)), Post::Posted);
    assert!(s.owes(&ctx("a")));
    assert!(!s.owes(&ctx("b")));
    assert_eq!(s.owed(), 1);
    assert_eq!(m.next_req(), cold("a", 7));
    m.reply(&result("a", 7));
    assert_eq!(events(&mut s, t0, 1), vec![Event::Answer(result("a", 7))]);
    assert!(!s.owes(&ctx("a")));
    assert_eq!(s.owed(), 0);
}

#[test]
fn answers_are_taken_in_the_order_they_were_owed() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    for (i, t) in ["a", "b", "a"].iter().enumerate() {
        let req = if i == 2 { warm(t, 3) } else { cold(t, i as u64 + 1) };
        assert_eq!(s.post(t0, &req), Post::Posted);
    }
    assert_eq!(s.owed(), 3);
    for _ in 0..3 {
        m.next_req();
    }
    m.reply(&result("a", 1));
    m.reply(&Resp::Dirty { ctx: ctx("b"), version: 2, reason: "no".into() });
    m.reply(&result("a", 3));
    let got = events(&mut s, t0, 3);
    assert_eq!(got[0], Event::Answer(result("a", 1)));
    assert!(matches!(&got[1], Event::Answer(Resp::Dirty { version: 2, .. })));
    assert_eq!(got[2], Event::Answer(result("a", 3)));
}

#[test]
fn a_forget_is_sent_and_is_not_owed_an_answer() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    s.post(t0, &Req::Forget { ctx: ctx("a") });
    assert_eq!(s.owed(), 1);
    assert_eq!(m.next_req(), cold("a", 1));
    assert_eq!(m.next_req(), Req::Forget { ctx: ctx("a") });
    // The table is not held any more, so it is not named when the worker fails.
    m.hang_up();
    let got = events(&mut s, t0, 1);
    assert!(crashed(&got[0]).1.is_empty(), "{got:?}");
}

// ── Failures ────────────────────────────────────────────────────────────────

#[test]
fn a_worker_that_hangs_up_is_a_crash_naming_every_table_it_held() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    s.post(t0, &cold("b", 1));
    s.post(t0, &cold("a", 2));
    s.post(t0, &warm("a", 3));
    m.next_req();
    m.reply(&result("b", 1));
    m.hang_up();
    let got = events(&mut s, t0, 2);
    assert_eq!(got[0], Event::Answer(result("b", 1)), "what it said before is taken");
    let (why, tables, restart) = crashed(&got[1]);
    assert!(why.contains("closed"), "{why}");
    assert_eq!(tables, &[ctx("a"), ctx("b")], "both, in order");
    assert_eq!(restart, Some(secs(1)));
    assert_eq!(s.state(), State::Backoff(t0 + secs(1)));
    assert!(!s.is_up());
    assert_eq!(m.kills(), 1, "and it is killed");
    assert_eq!(s.owed(), 0, "what it owed is forgotten");
    assert!(!s.owes(&ctx("a")));
    assert_eq!(s.counts(), (1, 1));
    assert!(s.poll(t0).is_empty(), "said once");
}

#[test]
fn a_process_that_is_gone_is_a_crash_once_its_output_has_had_its_moment_to_say_so() {
    let t0 = Instant::now();
    let (mut s, m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    m.exit();
    assert!(s.poll(t0).is_empty(), "seen gone; its output is given a moment");
    assert!(s.poll(t0 + Duration::from_millis(1_999)).is_empty());
    let got = s.poll(t0 + secs(2));
    let (why, tables, _) = crashed(&got[0]);
    assert!(why.contains("exited"), "{why}");
    assert_eq!(tables, &[ctx("a")]);
    assert_eq!(m.kills(), 1);
}

#[test]
fn an_answer_written_before_the_process_went_is_taken_even_if_the_reader_is_behind() {
    let t0 = Instant::now();
    let (link, mut m, hold) = manual_link_with_slow_reader();
    let (p, _) = plan(vec![Ok(link)]);
    let mut s = Supervisor::new(p, t0);
    s.post(t0, &cold("a", 1));
    m.next_req();
    // The worker answers and exits; the reader thread has not yet looked at the pipe.
    m.reply(&result("a", 1));
    m.exit();
    m.hang_up();
    assert!(s.poll(t0).is_empty());
    assert!(s.poll(t0 + Duration::from_millis(500)).is_empty(), "gone, but not yet failed");
    // Now the reader catches up: the answer first, then the pipe's end.
    hold.store(true, Ordering::SeqCst);
    let got = events(&mut s, t0 + Duration::from_millis(500), 2);
    assert_eq!(got[0], Event::Answer(result("a", 1)));
    let (why, tables, _) = crashed(&got[1]);
    assert!(why.contains("closed"), "{why}");
    assert_eq!(tables, &[ctx("a")]);
}

#[test]
fn after_the_wait_the_next_frame_starts_a_new_worker() {
    let t0 = Instant::now();
    let (l1, mut m1) = manual_link(false);
    let (l2, mut m2) = manual_link(false);
    let (p, launched) = plan(vec![Ok(l1), Ok(l2)]);
    let mut s = Supervisor::new(p, t0);
    s.post(t0, &cold("a", 1));
    m1.hang_up();
    events(&mut s, t0, 1);
    assert_eq!(s.post(t0 + Duration::from_millis(999), &cold("a", 2)), Post::Down, "still waiting");
    assert_eq!(launched.load(Ordering::SeqCst), 1);
    assert_eq!(s.post(t0 + secs(1), &cold("a", 2)), Post::Posted, "the wait is over");
    assert_eq!(launched.load(Ordering::SeqCst), 2);
    assert!(s.is_up());
    assert_eq!(m2.next_req(), cold("a", 2));
    m2.reply(&result("a", 2));
    assert_eq!(events(&mut s, t0 + secs(1), 1), vec![Event::Answer(result("a", 2))]);
}

#[test]
fn a_worker_that_gives_no_answer_for_ten_seconds_is_killed() {
    let t0 = Instant::now();
    let (mut s, m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    assert!(s.poll(t0 + secs(5)).is_empty());
    assert!(s.poll(t0 + Duration::from_millis(9_999)).is_empty());
    assert!(s.poll(t0 + secs(10)).is_empty(), "ten seconds is not more than ten seconds");
    let got = s.poll(t0 + Duration::from_millis(10_001));
    let (why, tables, restart) = crashed(&got[0]);
    assert_eq!(why, "no answer in 10 s");
    assert_eq!(tables, &[ctx("a")]);
    assert_eq!(restart, Some(secs(1)));
    assert_eq!(m.kills(), 1);
}

#[test]
fn the_wait_counts_from_the_last_answer_not_from_the_post() {
    // A burst of cold folds takes longer than ten seconds in all, and none of
    // them is stuck: each is answered within ten seconds of the one before.
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    s.post(t0, &cold("b", 2));
    m.next_req();
    m.next_req();
    m.reply(&result("a", 1));
    assert_eq!(events(&mut s, t0 + secs(9), 1), vec![Event::Answer(result("a", 1))]);
    assert!(s.poll(t0 + secs(18)).is_empty(), "b has waited 9 s since a was answered");
    assert!(s.is_up());
    let got = s.poll(t0 + Duration::from_millis(19_001));
    assert_eq!(crashed(&got[0]).0, "no answer in 10 s");
}

#[test]
fn a_worker_that_has_nothing_owed_is_never_timed_out() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    m.next_req();
    m.reply(&result("a", 1));
    events(&mut s, t0, 1);
    assert!(s.poll(t0 + secs(3_600)).is_empty());
    assert!(s.is_up());
    // And a frame sent after a long quiet is timed from its own post.
    assert_eq!(s.post(t0 + secs(3_600), &warm("a", 2)), Post::Posted);
    assert!(s.poll(t0 + secs(3_609)).is_empty());
    assert_eq!(crashed(&s.poll(t0 + Duration::from_millis(3_610_001))[0]).0, "no answer in 10 s");
}

#[test]
fn an_answer_for_something_not_owed_in_that_place_is_a_failure() {
    for wrong in [result("a", 2), result("b", 1), result("c", 9)] {
        let t0 = Instant::now();
        let (mut s, mut m, _) = with_one_worker(t0);
        s.post(t0, &cold("a", 1));
        m.next_req();
        m.reply(&wrong);
        let got = events(&mut s, t0, 1);
        assert_eq!(crashed(&got[0]).0, "the worker answered out of step", "{wrong:?}");
    }
    // An answer when nothing is owed.
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    s.post(t0, &Req::Forget { ctx: ctx("a") });
    m.next_req();
    m.reply(&result("a", 1));
    assert_eq!(crashed(&events(&mut s, t0, 1)[0]).0, "the worker sent an answer nobody asked for");
}

#[test]
fn a_flood_of_answers_is_stopped_at_the_reader_not_queued_in_the_node() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    m.next_req();
    // One answer was asked for; the worker sends a thousand.
    for _ in 0..1_000 {
        // The node's reader stops reading at the second, so later sends may find nobody there.
        let _ = m.replies.as_ref().unwrap().send(encode_resp(&result("a", 1)).unwrap());
    }
    let got = events(&mut s, t0, 2);
    assert_eq!(got[0], Event::Answer(result("a", 1)));
    assert_eq!(crashed(&got[1]).0, "the worker sent an answer nobody asked for");
    assert_eq!(m.kills(), 1);
    assert!(s.poll(t0).is_empty(), "the rest were never read into the node");
}

#[test]
fn too_many_frames_waiting_for_answers_is_busy() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    for i in 0..MAX_OWED {
        assert_eq!(s.post(t0, &warm("a", i as u64)), Post::Posted, "frame {i}");
    }
    assert_eq!(s.owed(), MAX_OWED);
    assert_eq!(s.post(t0, &warm("a", 9_999)), Post::Busy);
    assert_eq!(s.post(t0, &Req::Forget { ctx: ctx("a") }), Post::Posted, "a Forget wants no answer, so it is not held back");
    // The worker answers one: room for one more.
    m.next_req();
    m.reply(&result("a", 0));
    assert_eq!(events(&mut s, t0, 1), vec![Event::Answer(result("a", 0))]);
    assert_eq!(s.post(t0, &warm("a", 10_000)), Post::Posted);
}

#[test]
fn bytes_that_are_not_a_frame_are_a_failure() {
    for junk in [vec![3, 0, 0, 0, 9, 9, 9], vec![0, 0, 0, 0], vec![0xff; 8], b"hello\n".to_vec()] {
        let t0 = Instant::now();
        let (mut s, mut m, _) = with_one_worker(t0);
        s.post(t0, &cold("a", 1));
        m.next_req();
        m.raw(junk.clone());
        m.hang_up();
        let got = events(&mut s, t0, 1);
        let (why, tables, _) = crashed(&got[0]);
        assert!(why.contains("not an answer") || why.contains("read from the worker"), "{junk:?}: {why}");
        assert_eq!(tables, &[ctx("a")]);
        assert_eq!(m.kills(), 1);
    }
}

#[test]
fn a_worker_that_broke_its_input_is_a_failure_found_at_the_next_post() {
    let t0 = Instant::now();
    let (mut s, mut m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    m.next_req();
    // The worker's end of its input is gone; the writer finds out at the next write.
    drop(m.requests);
    std::thread::sleep(Duration::from_millis(20));
    let mut posted = Post::Posted;
    for i in 0..200 {
        posted = s.post(t0, &warm("a", 2 + i));
        if posted != Post::Posted {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let got = events(&mut s, t0, 1);
    let (why, tables, _) = crashed(&got[0]);
    assert!(why.contains("write to the worker") || why.contains("writer has ended"), "{why}");
    assert_eq!(tables, &[ctx("a")]);
    let _ = posted;
}

// ── Starting that fails, and three strikes ──────────────────────────────────

#[test]
fn a_worker_that_will_not_start_is_a_failure_that_tries_again_later() {
    let t0 = Instant::now();
    let (link, mut m) = manual_link(false);
    let (p, launched) = plan(vec![Err(io::Error::other("no such file")), Ok(link)]);
    let mut s = Supervisor::new(p, t0);
    assert_eq!(s.post(t0, &cold("a", 1)), Post::Down);
    let got = s.poll(t0);
    let (why, tables, restart) = crashed(&got[0]);
    assert!(why.contains("would not start") && why.contains("no such file"), "{why}");
    assert!(tables.is_empty());
    assert_eq!(restart, Some(secs(1)));
    assert_eq!(s.post(t0 + Duration::from_millis(500), &cold("a", 1)), Post::Down);
    assert_eq!(launched.load(Ordering::SeqCst), 1, "not tried before the wait is over");
    assert_eq!(s.post(t0 + secs(1), &cold("a", 1)), Post::Posted);
    assert_eq!(m.next_req(), cold("a", 1));
}

#[test]
fn three_failures_turn_the_duties_off_until_the_node_restarts() {
    let t0 = Instant::now();
    let (p, launched) = plan(vec![]);
    let mut s = Supervisor::new(p, t0);
    assert_eq!(s.post(t0, &cold("a", 1)), Post::Down);
    assert_eq!(s.post(t0 + secs(1), &cold("a", 1)), Post::Down);
    assert_eq!(s.off(), None);
    assert_eq!(s.post(t0 + secs(3), &cold("a", 1)), Post::Down);
    assert_eq!(s.off(), Some("crashes"));
    assert_eq!(s.state(), State::Off);
    let waits: Vec<Option<Duration>> = s.poll(t0 + secs(3)).iter().map(|e| crashed(e).2).collect();
    assert_eq!(waits, vec![Some(secs(1)), Some(secs(2)), None]);
    // Hours later it is still off, and nothing is tried.
    assert_eq!(s.post(t0 + secs(7_200), &cold("a", 1)), Post::Down);
    assert_eq!(launched.load(Ordering::SeqCst), 3);
    assert!(s.poll(t0 + secs(7_200)).is_empty());
    assert_eq!(s.counts(), (0, 3));
}

#[test]
fn a_worker_that_answered_starts_the_wait_over_but_not_the_strikes() {
    let t0 = Instant::now();
    let (l1, mut m1) = manual_link(false);
    let (l2, mut m2) = manual_link(false);
    let (l3, mut m3) = manual_link(false);
    let (p, _) = plan(vec![Ok(l1), Ok(l2), Ok(l3)]);
    let mut s = Supervisor::new(p, t0);
    // The first worker dies without a word: the wait is 1 s.
    s.post(t0, &cold("a", 1));
    m1.hang_up();
    assert_eq!(crashed(&events(&mut s, t0, 1)[0]).2, Some(secs(1)));
    // The second answers, then dies: the wait starts over at 1 s, not 2 s.
    let t1 = t0 + secs(1);
    assert_eq!(s.post(t1, &cold("a", 2)), Post::Posted);
    m2.next_req();
    m2.reply(&result("a", 2));
    m2.hang_up();
    let got = events(&mut s, t1, 2);
    assert_eq!(crashed(&got[1]).2, Some(secs(1)));
    // And the third, though it answered nothing of the first's debt, is the third strike.
    let t2 = t1 + secs(1);
    assert_eq!(s.post(t2, &cold("a", 3)), Post::Posted);
    m3.hang_up();
    let got = events(&mut s, t2, 1);
    assert_eq!(crashed(&got[0]).2, None);
    assert_eq!(s.off(), Some("crashes"));
}

#[test]
fn crashes_of_running_workers_count_for_the_strikes_too() {
    let t0 = Instant::now();
    let mut links = vec![];
    let mut manuals = vec![];
    for _ in 0..3 {
        let (l, m) = manual_link(false);
        links.push(Ok(l));
        manuals.push(m);
    }
    let (p, _) = plan(links);
    let mut s = Supervisor::new(p, t0);
    let mut now = t0;
    for (i, m) in manuals.iter_mut().enumerate() {
        assert_eq!(s.post(now, &cold("a", i as u64)), Post::Posted, "worker {i}");
        m.next_req();
        // This one answers, then hangs up: the strike stands.
        m.reply(&result("a", i as u64));
        m.hang_up();
        let got = events(&mut s, now, 2);
        assert!(matches!(got[0], Event::Answer(_)));
        assert_eq!(crashed(&got[1]).2.is_some(), i < 2, "off at the third");
        now += secs(5);
    }
    assert_eq!(s.off(), Some("crashes"));
}

// ── Backlog, drop ───────────────────────────────────────────────────────────

#[test]
fn a_backlog_the_worker_has_not_read_is_busy_until_it_reads() {
    let t0 = Instant::now();
    let (link, mut m) = manual_link(true);
    let (p, _) = plan(vec![Ok(link)]);
    let mut s = Supervisor::new(p, t0);
    // The first frame always goes, however big, and the writer holds it: the worker has not read.
    assert_eq!(s.post(t0, &big_warm("a", 1, 10)), Post::Posted);
    assert_eq!(s.post(t0, &big_warm("a", 2, 10)), Post::Busy, "10 + 10 MiB would pass 16 MiB");
    assert_eq!(s.post(t0, &warm("a", 3)), Post::Posted, "a small one still fits");
    assert_eq!(s.owed(), 2, "a Busy frame is not owed");
    // The worker reads: the backlog drains and a big frame goes again.
    assert!(matches!(m.next_req(), Req::Warm(w) if w.version == 1));
    assert!(matches!(m.next_req(), Req::Warm(w) if w.version == 3));
    let deadline = std::time::Instant::now() + secs(30);
    loop {
        match s.post(t0, &big_warm("a", 4, 10)) {
            Post::Posted => break,
            Post::Busy => {
                assert!(std::time::Instant::now() < deadline, "the backlog never drained");
                std::thread::sleep(Duration::from_millis(2));
            }
            other => panic!("{other:?}"),
        }
    }
    assert!(matches!(m.next_req(), Req::Warm(w) if w.version == 4));
}

#[test]
fn dropping_the_supervisor_kills_the_worker() {
    let t0 = Instant::now();
    let (mut s, m, _) = with_one_worker(t0);
    s.post(t0, &cold("a", 1));
    assert_eq!(m.kills(), 0);
    drop(s);
    assert_eq!(m.kills(), 1);
}

// ── Real child processes ────────────────────────────────────────────────────

/// Poll in real time until a crash comes.
fn crash_of<L: Launch>(s: &mut Supervisor<L>, now: Instant) -> Event {
    events(s, now, 1).remove(0)
}

#[test]
fn a_file_that_is_not_there_is_a_worker_that_will_not_start() {
    let t0 = Instant::now();
    let launch = ChildLaunch::with_command(Box::new(|| Ok(Command::new("/no/such/dir/ssf-fold-worker"))));
    let mut s = Supervisor::new(launch, t0);
    assert_eq!(s.post(t0, &cold("a", 1)), Post::Down);
    assert!(crashed(&crash_of(&mut s, t0)).0.contains("would not start"));
}

#[test]
fn a_child_that_exits_at_once_is_a_failure() {
    // A process that says nothing and goes, which a worker must never do.
    let t0 = Instant::now();
    let launch = ChildLaunch::with_command(Box::new(|| {
        #[cfg(unix)]
        let c = Command::new("true");
        #[cfg(windows)]
        let c = {
            let mut c = Command::new("cmd");
            c.args(["/C", "exit", "0"]);
            c
        };
        Ok(c)
    }));
    let mut s = Supervisor::new(launch, t0);
    let posted = s.post(t0, &cold("a", 1));
    assert!(matches!(posted, Post::Posted | Post::Down), "{posted:?}");
    let e = crash_of(&mut s, t0);
    let (why, _, restart) = crashed(&e);
    assert!(why.contains("closed") || why.contains("exited") || why.contains("write") || why.contains("read from the worker"), "{why}");
    assert_eq!(restart, Some(secs(1)));
    assert!(!s.is_up());
}

#[cfg(unix)]
#[test]
fn a_child_that_never_answers_is_killed_and_reaped_at_the_timeout() {
    let t0 = Instant::now();
    let launch = ChildLaunch::with_command(Box::new(|| {
        let mut c = Command::new("sleep");
        c.arg("600");
        Ok(c)
    }));
    let mut s = Supervisor::new(launch, t0);
    assert_eq!(s.post(t0, &cold("a", 1)), Post::Posted);
    assert!(s.poll(t0 + secs(9)).is_empty());
    let began = std::time::Instant::now();
    let got = s.poll(t0 + secs(11));
    assert_eq!(crashed(&got[0]).0, "no answer in 10 s");
    assert!(began.elapsed() < secs(10), "killing and reaping it does not wait for it");
    assert!(!s.is_up());
}
