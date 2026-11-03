//! The feed between a real mirror, a real supervisor and a worker that runs in
//! a thread of the test (the worker's own `serve`, over channels instead of
//! pipes): a stand-in that answers as told, and the fold engine itself.

use super::*;
use crate::fold_supervisor::{Link, QUEUE_BYTES};
use crate::fold_wire::MAX_FRAME;
use crate::house_mirror::Limits;
use crate::fold_worker::{serve, EngineFolder, Folder};
use crate::house::{checkpoint_ok, to_any};
use crate::house_bytes::CVal;
use crate::house_fold::tests::{cases, check_for, Case};
use crate::house_mirror::tests::{cp, live0, live_of, obj, rk, rv, s, sum_of};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use yrs::{Any, Doc, Map, MapPrelim, Out, Transact};

const ROOM: &str = "room";
const T: &str = "t1";
const INC: &str = "r0123456789abcdef01234567";

// ── A worker in a thread ─────────────────────────────────────────────────────

struct ChanReader {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
    at: usize,
}

impl Read for ChanReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if self.at >= self.buf.len() {
            match self.rx.recv() {
                Ok(v) => {
                    self.buf = v;
                    self.at = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.at);
        out[..n].copy_from_slice(&self.buf[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

struct ChanWriter(Sender<Vec<u8>>);

impl Write for ChanWriter {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        self.0.send(b.to_vec()).map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the worker has gone"))?;
        Ok(b.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// Makes a folder; called on the worker's own thread (the engine's runtime cannot move between threads).
type Maker = Arc<dyn Fn() -> Box<dyn Folder> + Send + Sync>;

impl Folder for Box<dyn Folder> {
    fn cold(&mut self, c: &Cold) -> Result<String, String> {
        (**self).cold(c)
    }
    fn warm(&mut self, w: &Warm) -> Result<String, String> {
        (**self).warm(w)
    }
    fn forget(&mut self, ctx: &Ctx) {
        (**self).forget(ctx)
    }
    fn recover(&mut self) -> bool {
        (**self).recover()
    }
}

/// Starts workers that are threads serving a folder made by `make`.
struct ThreadLaunch {
    make: Maker,
    launches: Arc<AtomicUsize>,
    /// Every request a worker was sent, in order, across workers.
    log: Arc<Mutex<Vec<Req>>>,
    /// Launches that fail, from the first.
    refuse: Arc<AtomicBool>,
}

impl Launch for ThreadLaunch {
    fn launch(&mut self) -> io::Result<Link> {
        if self.refuse.load(Ordering::SeqCst) {
            return Err(io::Error::other("no worker today"));
        }
        self.launches.fetch_add(1, Ordering::SeqCst);
        let (to_tx, to_rx) = channel::<Vec<u8>>();
        let (from_tx, from_rx) = channel::<Vec<u8>>();
        let make = self.make.clone();
        let done = Arc::new(AtomicBool::new(false));
        let ended = done.clone();
        let log = self.log.clone();
        thread::spawn(move || {
            let mut folder = make();
            // (The frames are read twice: once to note them for the test, once for the worker.)
            let mut input = ChanReader { rx: to_rx, buf: vec![], at: 0 };
            let mut tee = Tee { inner: &mut input, seen: vec![], log };
            let mut out = ChanWriter(from_tx);
            let _ = serve(&mut tee, &mut out, &mut folder);
            ended.store(true, Ordering::SeqCst);
        });
        Link::new(Box::new(ChanWriter(to_tx)), Box::new(ChanReader { rx: from_rx, buf: vec![], at: 0 }), Box::new(|| {}), Box::new(move || done.load(Ordering::SeqCst)))
    }
}

/// Reads what `serve` reads and notes every whole request in the log.
struct Tee<'a> {
    inner: &'a mut ChanReader,
    seen: Vec<u8>,
    log: Arc<Mutex<Vec<Req>>>,
}

impl Read for Tee<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(out)?;
        self.seen.extend_from_slice(&out[..n]);
        while self.seen.len() >= 4 {
            let len = u32::from_le_bytes([self.seen[0], self.seen[1], self.seen[2], self.seen[3]]) as usize;
            if self.seen.len() < 4 + len {
                break;
            }
            let body: Vec<u8> = self.seen.drain(..4 + len).skip(4).collect();
            if let Ok(req) = crate::fold_wire::decode_req(&body) {
                self.log.lock().unwrap().push(req);
            }
        }
        Ok(n)
    }
}

// ── Stand-in workers ─────────────────────────────────────────────────────────

/// A summary the feed can read (the first vector's).
fn canned() -> String {
    cases().remove(0).summary
}

/// Answers every frame with a summary, except as told.
#[derive(Clone, Default)]
struct Script {
    /// `Err(reason)` for the n-th request of the worker (1-based), counting cold and warm.
    dirty_at: Arc<Mutex<Vec<usize>>>,
    /// The n-th request ends the process (a panic nobody can recover from).
    crash_at: Arc<Mutex<Vec<usize>>>,
    /// The text to answer with, instead of a summary.
    text: Arc<Mutex<Option<String>>>,
    /// While set, the worker holds its answers back.
    gate: Arc<AtomicBool>,
}

struct Stand {
    script: Script,
    asked: usize,
    alive: bool,
}

impl Stand {
    fn answer(&mut self) -> Result<String, String> {
        self.asked += 1;
        while self.script.gate.load(Ordering::SeqCst) {
            thread::sleep(std::time::Duration::from_millis(1));
        }
        if self.script.crash_at.lock().unwrap().contains(&self.asked) {
            self.alive = false;
            panic!("the worker falls over");
        }
        if self.script.dirty_at.lock().unwrap().contains(&self.asked) {
            return Err("it is dirty".into());
        }
        Ok(self.script.text.lock().unwrap().clone().unwrap_or_else(canned))
    }
}

impl Folder for Stand {
    fn cold(&mut self, _c: &Cold) -> Result<String, String> {
        self.answer()
    }
    fn warm(&mut self, _w: &Warm) -> Result<String, String> {
        self.answer()
    }
    fn forget(&mut self, _ctx: &Ctx) {}
    fn recover(&mut self) -> bool {
        self.alive
    }
}

// ── The rig ──────────────────────────────────────────────────────────────────

struct Rig {
    doc: Doc,
    mirror: RoomMirror,
    feed: Feed,
    sup: Supervisor<ThreadLaunch>,
    now: Instant,
    inputs: Inputs,
    launches: Arc<AtomicUsize>,
    log: Arc<Mutex<Vec<Req>>>,
    refuse: Arc<AtomicBool>,
}

impl Rig {
    fn new(room: &str, make: Maker) -> Rig {
        Rig::with_limits(room, make, Limits::default())
    }

    fn with_limits(room: &str, make: Maker, limits: Limits) -> Rig {
        let doc = Doc::new();
        let mirror = RoomMirror::attach_with(&doc, room, limits);
        let launches = Arc::new(AtomicUsize::new(0));
        let log = Arc::new(Mutex::new(Vec::new()));
        let refuse = Arc::new(AtomicBool::new(false));
        let now = Instant::now();
        let sup = Supervisor::new(ThreadLaunch { make, launches: launches.clone(), log: log.clone(), refuse: refuse.clone() }, now);
        Rig { doc, mirror, feed: Feed::new(room), sup, now, inputs: Inputs::default(), launches, log, refuse }
    }

    fn want(&mut self, tables: &[(&str, &str)]) {
        let tables: Vec<(String, String)> = tables.iter().map(|(t, i)| (t.to_string(), i.to_string())).collect();
        self.mirror.want(&tables);
    }

    /// One tick of the node: the doc drained, the worker's answers taken, the changes sent.
    fn tick(&mut self) {
        {
            let txn = self.doc.transact();
            self.mirror.drain(&txn);
        }
        let events = self.sup.poll(self.now);
        self.feed.absorb(self.now, &events);
        self.feed.push(self.now, &mut self.mirror, &mut self.sup, &self.inputs);
    }

    /// Tick (in real time, for the worker's thread) until `done`.
    fn until(&mut self, what: &str, mut done: impl FnMut(&mut Self) -> bool) {
        for _ in 0..3_000 {
            self.tick();
            if done(self) {
                return;
            }
            thread::sleep(std::time::Duration::from_millis(2));
        }
        panic!("never: {what} ({:?}, {:?})", self.feed.counts(), self.sup.state());
    }

    fn caught_up(&mut self) -> bool {
        self.feed.caught_up(T, INC, &self.mirror, &self.sup)
    }

    /// What the worker has been sent, in order: once its thread has read all that was posted (the
    /// log is the worker's, filled as it reads).
    fn reqs(&self) -> Vec<Req> {
        let c = self.feed.counts();
        let posted = (c.cold + c.warm + c.forgets) as usize;
        for _ in 0..100 {
            if self.log.lock().unwrap().len() >= posted {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(2));
        }
        self.log.lock().unwrap().clone()
    }

    fn session(&self, name: &str, records: &[(String, CVal)]) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let m = comp.insert(&mut txn, name, MapPrelim::default());
        for (k, v) in records {
            m.insert(&mut txn, k.as_str(), to_any(v));
        }
    }

    fn put_top(&self, key: &str, v: &CVal) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, to_any(v));
    }

    fn put(&self, ses: &str, key: &str, v: Any) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        m.insert(&mut txn, key, v);
    }

    fn remove(&self, ses: &str, key: &str) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        m.remove(&mut txn, key);
    }
}

fn stand_rig(script: &Script) -> Rig {
    let script = script.clone();
    let mut rig = Rig::new(ROOM, Arc::new(move || Box::new(Stand { script: script.clone(), asked: 0, alive: true })));
    rig.want(&[(T, INC)]);
    rig
}

fn recs(n: u32) -> Vec<(String, CVal)> {
    (0..n).map(|i| (rk(1, i), rv(1, i as i64))).collect()
}

fn val(i: i64) -> Any {
    to_any(&rv(1, i))
}

/// A record a page may read otherwise: it holds the table.
fn proto() -> Any {
    Any::Map(Arc::new(std::collections::HashMap::from([("r".to_string(), Any::Number(1.0)), ("__proto__".to_string(), Any::String(Arc::from("x")))])))
}

fn colds(reqs: &[Req]) -> Vec<&Cold> {
    reqs.iter().filter_map(|r| if let Req::Cold(c) = r { Some(c) } else { None }).collect()
}

fn warms(reqs: &[Req]) -> Vec<&Warm> {
    reqs.iter().filter_map(|r| if let Req::Warm(w) = r { Some(w) } else { None }).collect()
}

fn forgets(reqs: &[Req]) -> usize {
    reqs.iter().filter(|r| matches!(r, Req::Forget { .. })).count()
}

// ── Sending a table ──────────────────────────────────────────────────────────

#[test]
fn a_table_starts_with_a_cold_and_is_kept_up_with_warms() {
    let mut rig = stand_rig(&Script::default());
    rig.inputs = Inputs::new(vec!["h2".into(), "h1".into()], vec![("bob".into(), "kb".into()), ("alice".into(), "ka".into())]);
    rig.session(&live0(), &recs(3));
    rig.until("the first answer", |r| r.feed.fold(T, INC).is_some() && r.caught_up());
    let reqs = rig.reqs();
    assert_eq!(reqs.len(), 1);
    let cold = &colds(&reqs)[0];
    assert_eq!((cold.ctx.room.as_str(), cold.ctx.t.as_str(), cold.ctx.inc.as_str()), (ROOM, T, INC));
    assert_eq!(cold.base, None);
    assert_eq!(cold.records.len(), 3);
    assert_eq!(cold.houses, vec!["h1", "h2"], "sorted");
    assert_eq!(cold.pins, vec![("alice".to_string(), "ka".to_string()), ("bob".to_string(), "kb".to_string())]);
    let fold = rig.feed.fold(T, INC).unwrap();
    assert_eq!(fold.version, cold.version);

    // A record comes, one changes, one goes: one Warm each time they are seen.
    rig.put(&live0(), &rk(1, 7), val(7));
    rig.until("a warm", |r| warms(&r.reqs()).len() == 1 && r.caught_up());
    rig.put(&live0(), &rk(1, 0), val(100));
    rig.remove(&live0(), &rk(1, 1));
    rig.until("another warm", |r| warms(&r.reqs()).len() == 2 && r.caught_up());
    let reqs = rig.reqs();
    let w = warms(&reqs);
    assert_eq!(w[0].changes.len(), 1);
    assert_eq!(w[1].changes.len(), 2);
    assert!(w[1].changes.iter().any(|(k, v)| k == &rk(1, 1) && v.is_none()));
    assert_eq!(rig.feed.counts(), Counts { cold: 1, warm: 2, results: 3, ..Counts::default() });
    assert_eq!(rig.launches.load(Ordering::SeqCst), 1);
}

#[test]
fn a_table_with_a_checkpoint_starts_on_it() {
    let mut rig = stand_rig(&Script::default());
    let base = cp(4);
    rig.put_top(&sum_of(T), &base);
    rig.session(&live_of(T, Some(&base)), &recs(2));
    rig.until("the answer", |r| r.feed.fold(T, INC).is_some());
    let reqs = rig.reqs();
    let got = colds(&reqs)[0].base.clone().map(crate::house_mirror::tests::norm);
    assert_eq!(got, Some(base));
}

#[test]
fn nothing_is_sent_when_nothing_changed() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    for _ in 0..20 {
        rig.tick();
    }
    assert_eq!(rig.reqs().len(), 1);
    assert_eq!(rig.feed.counts(), Counts { cold: 1, results: 1, ..Counts::default() });
    // A change in the doc the mirror has not read yet: the answer is not for the table as it stands.
    rig.put(&live0(), &rk(1, 9), val(9));
    assert!(!rig.caught_up());
}

#[test]
fn a_big_read_goes_in_frames_one_a_tick() {
    // 100 records of some 60 KiB: some 6 MB, over a frame's 4 MiB.
    let filler = "x".repeat(60 * 1024);
    let mut rig = stand_rig(&Script::default());
    let records: Vec<(String, CVal)> = (0..100).map(|i| (rk(1, i), obj(vec![("r", CVal::Int(1)), ("i", CVal::Int(i as i64)), ("pad", s(&filler))]))).collect();
    rig.session(&live0(), &records);
    rig.until("all of it", |r| {
        let queued = r.mirror.state(T, INC).map_or(0, |st| st.queued);
        if r.feed.fold(T, INC).is_some() && queued > 0 {
            assert!(!r.caught_up(), "answered, but more waits to be sent");
        }
        r.caught_up()
    });
    let reqs = rig.reqs();
    assert!(reqs.len() >= 2, "{}", reqs.len());
    assert!(matches!(reqs[0], Req::Cold(_)), "a Cold first");
    assert!(reqs[1..].iter().all(|r| matches!(r, Req::Warm(_))), "Warms after");
    let total: usize = colds(&reqs).iter().map(|c| c.records.len()).sum::<usize>() + warms(&reqs).iter().map(|w| w.changes.len()).sum::<usize>();
    assert_eq!(total, 100, "every record once");
    assert!(colds(&reqs)[0].records.len() < 100);
}

#[test]
fn a_table_has_one_frame_out_at_a_time() {
    let script = Script::default();
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(1));
    rig.until("caught up", |r| r.caught_up());
    // The worker holds its answers back: changes pile up in the mirror, not in the worker's pipe.
    script.gate.store(true, Ordering::SeqCst);
    rig.put(&live0(), &rk(1, 5), val(5));
    rig.until("a warm out", |r| warms(&r.reqs()).len() == 1);
    for i in 6..9 {
        rig.put(&live0(), &rk(1, i), val(i as i64));
        for _ in 0..5 {
            rig.tick();
        }
    }
    assert_eq!(warms(&rig.reqs()).len(), 1, "no second frame while one is owed");
    script.gate.store(false, Ordering::SeqCst);
    rig.until("the rest, as one frame", |r| warms(&r.reqs()).len() == 2 && r.caught_up());
    let reqs = rig.reqs();
    assert_eq!(warms(&reqs)[1].changes.len(), 3);
}

#[test]
fn houses_and_pins_that_change_are_sent_and_the_same_in_another_order_is_not() {
    let mut rig = stand_rig(&Script::default());
    rig.inputs = Inputs::new(vec!["h1".into(), "h2".into()], vec![("alice".into(), "ka".into())]);
    rig.session(&live0(), &recs(1));
    rig.until("caught up", |r| r.caught_up());
    rig.inputs = Inputs::new(vec!["h2".into(), "h1".into()], vec![("alice".into(), "ka".into())]);
    for _ in 0..10 {
        rig.tick();
    }
    assert_eq!(rig.reqs().len(), 1, "an order is not a change");
    rig.inputs = Inputs::new(vec!["h1".into(), "h2".into()], vec![("alice".into(), "ka".into()), ("bob".into(), "kb".into())]);
    rig.until("a warm for the pin", |r| warms(&r.reqs()).len() == 1 && r.caught_up());
    let reqs = rig.reqs();
    let w = &warms(&reqs)[0];
    assert!(w.changes.is_empty() && w.pins.len() == 2);
}

// ── Losing a table ───────────────────────────────────────────────────────────

#[test]
fn a_table_that_comes_back_dirty_starts_over_after_a_wait_that_doubles() {
    let script = Script::default();
    script.dirty_at.lock().unwrap().extend([1, 2]);
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(2));
    rig.until("the first dirty", |r| r.feed.counts().dirty == 1);
    for _ in 0..10 {
        rig.tick();
    }
    assert_eq!(rig.feed.counts().cold, 1, "not at once");
    assert_eq!(colds(&rig.reqs()).len(), 1);
    // A second later (virtual): read afresh, sent again, and dirty again.
    rig.now += std::time::Duration::from_millis(1_100);
    rig.until("the second dirty", |r| r.feed.counts().dirty == 2);
    assert_eq!(colds(&rig.reqs()).len(), 2);
    assert_eq!(colds(&rig.reqs())[1].records.len(), 2, "all the records again");
    // The wait is two seconds now.
    rig.now += std::time::Duration::from_millis(1_500);
    for _ in 0..10 {
        rig.tick();
    }
    assert_eq!(rig.feed.counts().cold, 2, "not before two seconds");
    rig.now += std::time::Duration::from_millis(1_000);
    rig.until("a result at last", |r| r.feed.fold(T, INC).is_some());
    assert_eq!(colds(&rig.reqs()).len(), 3);
    assert_eq!(rig.feed.counts().dirty, 2);
    // And the streak is over: a table that goes dirty again waits a second.
    script.dirty_at.lock().unwrap().push(4); // (the fourth request of the worker: the warm)
    rig.put(&live0(), &rk(1, 9), val(9));
    rig.until("dirty once more", |r| r.feed.counts().dirty == 3);
    rig.now += std::time::Duration::from_millis(1_100);
    rig.until("and sent again", |r| colds(&r.reqs()).len() == 4);
}

#[test]
fn a_crash_loses_the_tables_and_the_next_worker_gets_them_from_scratch() {
    let script = Script::default();
    script.crash_at.lock().unwrap().push(2);
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(2));
    rig.until("running", |r| r.caught_up());
    rig.put(&live0(), &rk(1, 5), val(5));
    rig.until("the crash", |r| r.feed.counts().lost == 1);
    assert!(rig.feed.fold(T, INC).is_none(), "an answer from a worker that is gone is not kept");
    // Nothing is taken from the mirror, nor is it started over, while the worker waits to start again.
    let (before, resets) = (rig.feed.counts(), rig.mirror.resets());
    for _ in 0..10 {
        rig.tick();
    }
    assert_eq!((rig.feed.counts(), rig.mirror.resets()), (before, resets));
    rig.now += std::time::Duration::from_millis(1_100);
    rig.until("the new worker's answer", |r| r.feed.fold(T, INC).is_some() && r.caught_up());
    assert_eq!(rig.launches.load(Ordering::SeqCst), 2);
    let reqs = rig.reqs();
    let cold = colds(&reqs);
    assert_eq!(cold.len(), 2);
    assert_eq!(cold[1].records.len(), 3, "all the records, the new one too");
}

#[test]
fn a_table_the_mirror_does_not_serve_is_forgotten_and_comes_back() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    // A record a page may read otherwise holds the table.
    rig.put(&live0(), &rk(1, 8), proto());
    rig.until("forgotten", |r| forgets(&r.reqs()) == 1);
    assert!(rig.feed.fold(T, INC).is_none());
    rig.remove(&live0(), &rk(1, 8));
    rig.until("sent again", |r| colds(&r.reqs()).len() == 2 && r.caught_up());
    assert_eq!(colds(&rig.reqs())[1].records.len(), 2);
}

#[test]
fn a_table_the_mirror_lets_go_is_forgotten() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(1));
    rig.until("caught up", |r| r.caught_up());
    rig.mirror.want(&[]);
    rig.until("forgotten", |r| forgets(&r.reqs()) == 1);
    assert!(rig.feed.fold(T, INC).is_none());
}

#[test]
fn a_result_nobody_can_read_gives_up_on_the_table_as_it_stands() {
    let script = Script::default();
    *script.text.lock().unwrap() = Some("this is not a summary".into());
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(2));
    rig.until("the bad result", |r| r.feed.counts().bad_results == 1);
    rig.until("forgotten", |r| forgets(&r.reqs()) == 1);
    for _ in 0..20 {
        rig.tick();
    }
    assert_eq!(rig.reqs().len(), 2, "a Cold and a Forget, nothing more");
    assert_eq!((rig.feed.counts().cold, rig.feed.counts().forgets), (1, 1));
    assert!(rig.feed.fold(T, INC).is_none());
    // The table starts over for another reason (a new checkpoint): it is tried again.
    *script.text.lock().unwrap() = None;
    let base = cp(3);
    rig.session(&live_of(T, Some(&base)), &recs(1));
    rig.put_top(&sum_of(T), &base);
    rig.until("tried again", |r| r.feed.fold(T, INC).is_some());
}

#[test]
fn a_result_too_big_to_parse_is_no_result() {
    let script = Script::default();
    *script.text.lock().unwrap() = Some("x".repeat(MAX_RESULT_BYTES + 1));
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(1));
    rig.until("the bad result", |r| r.feed.counts().bad_results == 1);
    assert!(rig.feed.fold(T, INC).is_none());
}

#[test]
fn a_worker_too_busy_is_given_the_frame_again_later() {
    // More tables than answers a worker may owe: the rest wait, kept.
    let script = Script::default();
    script.gate.store(true, Ordering::SeqCst);
    let sc = script.clone();
    let mut rig = Rig::new(ROOM, Arc::new(move || Box::new(Stand { script: sc.clone(), asked: 0, alive: true })));
    let n = crate::fold_supervisor::MAX_OWED + 4;
    let names: Vec<String> = (0..n).map(|i| format!("t{i:03}")).collect();
    for t in &names {
        rig.session(&live_of(t, None), &recs(1));
    }
    let tables: Vec<(&str, &str)> = names.iter().map(|t| (t.as_str(), INC)).collect();
    rig.want(&tables);
    rig.until("busy", |r| r.feed.counts().busy >= 1);
    assert_eq!(rig.sup.owed(), crate::fold_supervisor::MAX_OWED);
    script.gate.store(false, Ordering::SeqCst);
    rig.until("every table answered", |r| names.iter().all(|t| r.feed.fold(t, INC).is_some()));
    assert_eq!(rig.feed.counts().cold, n as u64);
    assert_eq!(rig.mirror.resets(), n as u64, "no table was read again: the frame was kept");
}

#[test]
fn when_the_fold_duties_are_off_the_feed_lets_everything_go() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(1));
    rig.until("caught up", |r| r.caught_up());
    // A worker that cannot start, three times: the supervisor turns the duties off.
    rig.refuse.store(true, Ordering::SeqCst);
    let crash = Script::default();
    crash.crash_at.lock().unwrap().push(1);
    let mut secs = 0;
    for _ in 0..12 {
        rig.put(&live0(), &rk(1, 50 + secs), val(1));
        secs += 1;
        rig.now += std::time::Duration::from_secs(70);
        rig.tick();
        if rig.sup.off().is_some() {
            break;
        }
        // (The worker that is up is killed by the next failure; one that is not just fails to start.)
        rig.sup.post(rig.now, &Req::Forget { ctx: Ctx { room: ROOM.into(), t: "none".into(), inc: INC.into() } });
    }
    for _ in 0..3 {
        rig.tick();
    }
    assert!(rig.sup.off().is_some());
    rig.now += std::time::Duration::from_secs(70);
    rig.tick();
    assert!(rig.feed.fold(T, INC).is_none() && !rig.caught_up());
    assert!(rig.feed.slots.is_empty(), "nothing is kept");
}

#[test]
fn an_answer_that_comes_after_the_table_was_forgotten_is_not_kept() {
    let script = Script::default();
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    script.gate.store(true, Ordering::SeqCst);
    rig.put(&live0(), &rk(1, 5), val(5));
    rig.until("a warm out", |r| r.feed.counts().warm == 1);
    // A record a page may read otherwise holds the table: it is let go of while an answer is owed.
    rig.put(&live0(), &rk(1, 6), proto());
    rig.until("forgotten", |r| r.feed.counts().forgets == 1);
    script.gate.store(false, Ordering::SeqCst);
    for _ in 0..50 {
        rig.tick();
        thread::sleep(std::time::Duration::from_millis(2));
    }
    assert!(rig.feed.fold(T, INC).is_none(), "the answer to a frame sent before the Forget");
}

#[test]
fn what_is_said_of_another_rooms_tables_is_not_this_rooms() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    let other = Ctx { room: "elsewhere".into(), t: T.into(), inc: INC.into() };
    let now = rig.now;
    let before = rig.feed.counts();
    rig.feed.absorb(now, &[Event::Crashed { reason: "it fell over".into(), tables: vec![other.clone()], restart_in: None }]);
    rig.feed.absorb(now, &[Event::Answer(Resp::Dirty { ctx: other.clone(), version: 1, reason: "dirty".into() })]);
    rig.feed.absorb(now, &[Event::Answer(Resp::Result { ctx: other, version: 99, text: canned() })]);
    assert_eq!(rig.feed.counts(), before);
    assert!(rig.caught_up(), "this room's table is as it was");
}

#[test]
fn a_summary_over_the_most_is_no_result_either() {
    let script = Script::default();
    // (A summary, and white space after it.)
    *script.text.lock().unwrap() = Some(format!("{}{}", canned(), " ".repeat(MAX_RESULT_BYTES)));
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(1));
    rig.until("the bad result", |r| r.feed.counts().bad_results == 1);
    assert!(rig.feed.fold(T, INC).is_none());
}

#[test]
fn a_frame_that_cannot_be_sent_gives_up_on_the_table_until_it_starts_over_for_another_reason() {
    let mut rig = stand_rig(&Script::default());
    // (A pin of 32 MiB and a byte: no frame holds it.)
    rig.inputs = Inputs::new(vec![], vec![("p".into(), "k".repeat(MAX_FRAME + 1))]);
    rig.session(&live0(), &recs(1));
    rig.until("too big", |r| r.feed.counts().too_big == 1);
    let resets = rig.mirror.resets();
    for _ in 0..20 {
        rig.tick();
    }
    assert_eq!((rig.feed.counts().too_big, rig.feed.counts().cold, rig.mirror.resets()), (1, 0, resets), "not tried again");
    assert_eq!(rig.feed.counts().forgets, 0);
    assert!(rig.reqs().is_empty(), "the worker never held the table: it is told nothing");
    assert!(rig.feed.fold(T, INC).is_none());
    // A new checkpoint starts the table over; the pin is gone by then.
    rig.inputs = Inputs::default();
    let base = cp(3);
    rig.session(&live_of(T, Some(&base)), &recs(1));
    rig.put_top(&sum_of(T), &base);
    rig.until("tried again", |r| r.feed.fold(T, INC).is_some());
}

#[test]
fn a_frame_that_cannot_be_sent_to_a_table_the_worker_holds_has_the_worker_let_it_go() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(1));
    rig.until("caught up", |r| r.caught_up());
    // The table is held; then a pin comes that no frame holds.
    rig.inputs = Inputs::new(vec![], vec![("p".into(), "k".repeat(MAX_FRAME + 1))]);
    rig.until("too big", |r| r.feed.counts().too_big == 1);
    assert!(rig.feed.fold(T, INC).is_none() && !rig.caught_up(), "what the worker held is let go of here at once");
    rig.until("let go", |r| r.feed.counts().forgets == 1);
    let reqs = rig.reqs();
    assert_eq!((colds(&reqs).len(), warms(&reqs).len(), forgets(&reqs)), (1, 0, 1), "a Cold, then the word, not a context left behind");
    assert!(rig.feed.fold(T, INC).is_none() && !rig.caught_up());
    for _ in 0..20 {
        rig.tick();
    }
    assert_eq!((rig.feed.counts().too_big, rig.feed.counts().forgets, rig.feed.counts().cold), (1, 1, 1), "not tried again");
    // A new checkpoint starts the table over (and the pin is gone): sent from the start.
    rig.inputs = Inputs::default();
    let base = cp(3);
    rig.session(&live_of(T, Some(&base)), &recs(1));
    rig.put_top(&sum_of(T), &base);
    rig.until("tried again", |r| r.feed.fold(T, INC).is_some());
    assert_eq!(colds(&rig.reqs()).len(), 2);
}

#[test]
fn a_result_too_big_for_a_frame_gives_up_on_the_table_and_is_not_asked_for_again() {
    let script = Script::default();
    // (A summary the worker cannot put in a frame; it drops the table itself and says it is dirty.)
    *script.text.lock().unwrap() = Some("x".repeat(MAX_FRAME + 1));
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(2));
    rig.until("said dirty", |r| r.feed.counts().dirty == 1);
    assert_eq!((rig.feed.counts().bad_results, rig.feed.counts().cold), (1, 1));
    assert!(rig.feed.fold(T, INC).is_none());
    // Well past any wait for a table that went dirty: no second Cold, and no Forget (the worker has none to drop).
    for _ in 0..10 {
        rig.now += std::time::Duration::from_secs(120);
        rig.tick();
    }
    assert_eq!((rig.feed.counts().cold, rig.feed.counts().dirty, rig.feed.counts().forgets), (1, 1, 0), "not asked for again");
    assert_eq!(rig.reqs().len(), 1);
    // A table that is dirty for another reason is asked for again (the waits are the ones for dirty tables).
    // And this one starts over for another reason (a new checkpoint): it is tried again.
    *script.text.lock().unwrap() = None;
    let base = cp(3);
    rig.session(&live_of(T, Some(&base)), &recs(1));
    rig.put_top(&sum_of(T), &base);
    rig.until("tried again", |r| r.feed.fold(T, INC).is_some());
}

#[test]
fn a_first_frame_has_records_when_the_mirror_reads_a_session_in_pieces() {
    let limits = Limits { drain_bytes: 500, drain_paths: 3, ..Limits::default() };
    let sc = Script::default();
    let mut rig = Rig::with_limits(ROOM, Arc::new(move || Box::new(Stand { script: sc.clone(), asked: 0, alive: true })), limits);
    rig.want(&[(T, INC)]);
    rig.session(&live0(), &recs(30));
    rig.until("all of it", |r| r.caught_up());
    let reqs = rig.reqs();
    assert!(!colds(&reqs)[0].records.is_empty(), "a Cold with something to say");
    let total: usize = colds(&reqs).iter().map(|c| c.records.len()).sum::<usize>() + warms(&reqs).iter().map(|w| w.changes.len()).sum::<usize>();
    assert_eq!(total, 30);
}

#[test]
fn a_forget_the_worker_is_too_busy_for_is_sent_later() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    // The worker's pipe is full: the table is let go of, and the word waits.
    rig.sup.clog(QUEUE_BYTES);
    rig.mirror.want(&[]);
    for _ in 0..5 {
        rig.tick();
    }
    assert_eq!(rig.feed.counts().forgets, 0);
    let slot = &rig.feed.slots[&(T.to_string(), INC.to_string())];
    assert!(!slot.open && slot.forget_pending, "let go of here at once, the word kept until the worker is told");
    assert!(rig.feed.fold(T, INC).is_none() && !rig.caught_up());
    rig.sup.unclog(QUEUE_BYTES);
    rig.tick();
    assert_eq!(rig.feed.counts().forgets, 1);
    assert!(rig.feed.slots.is_empty());
}

#[test]
fn a_table_let_go_of_while_the_worker_is_busy_is_not_built_on_when_it_comes_back() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    // The pipe is full: a change is taken and kept for later ...
    rig.sup.clog(QUEUE_BYTES);
    rig.put(&live0(), &rk(1, 5), val(5));
    rig.until("the frame is kept", |r| r.feed.counts().busy >= 1);
    // ... then a record a page may read otherwise holds the table, and the Forget has to wait ...
    rig.put(&live0(), &rk(1, 8), proto());
    for _ in 0..3 {
        rig.tick();
    }
    assert_eq!(rig.feed.counts().forgets, 0);
    // ... and the table is served again before the worker could be told.
    rig.remove(&live0(), &rk(1, 8));
    for _ in 0..3 {
        rig.tick();
    }
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("sent again", |r| colds(&r.reqs()).len() == 2 && r.caught_up());
    let reqs = rig.reqs();
    let kinds: Vec<&str> = reqs.iter().map(|r| match r {
        Req::Cold(_) => "cold",
        Req::Warm(_) => "warm",
        Req::Forget { .. } => "forget",
    }).collect();
    assert_eq!(kinds, ["cold", "forget", "cold"], "told first, then sent from the start, never a Warm on what the worker may have missed");
    assert_eq!(colds(&reqs)[1].records.len(), 3, "every record, the one whose frame was kept too");
}

#[test]
fn a_frame_kept_for_a_table_is_not_sent_after_the_table_was_let_go_of_and_comes_back() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    // The pipe is full: a change is taken and kept for later.
    rig.sup.clog(QUEUE_BYTES);
    rig.put(&live0(), &rk(1, 5), val(5));
    rig.until("the frame is kept", |r| r.feed.counts().busy >= 1);
    // The mirror lets the table go (the Forget waits for the pipe) and takes it up again.
    rig.mirror.want(&[]);
    for _ in 0..3 {
        rig.tick();
    }
    rig.want(&[(T, INC)]);
    for _ in 0..3 {
        rig.tick();
    }
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("sent again", |r| colds(&r.reqs()).len() == 2 && r.caught_up());
    let reqs = rig.reqs();
    let kinds: Vec<&str> = reqs.iter().map(|r| match r {
        Req::Cold(_) => "cold",
        Req::Warm(_) => "warm",
        Req::Forget { .. } => "forget",
    }).collect();
    assert_eq!(kinds, ["cold", "forget", "cold"], "no frame from before the Forget goes after it");
    assert_eq!(colds(&reqs)[1].records.len(), 3);
}

#[test]
fn a_forget_that_waits_goes_before_the_table_is_sent_again() {
    let script = Script::default();
    *script.text.lock().unwrap() = Some("this is not a summary".into());
    script.gate.store(true, Ordering::SeqCst);
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(1));
    rig.until("the Cold is out", |r| r.feed.counts().cold == 1);
    // The answer comes with the worker's pipe full: the node gives up on the table, and the Forget waits.
    rig.sup.clog(QUEUE_BYTES);
    script.gate.store(false, Ordering::SeqCst);
    rig.until("the bad result", |r| r.feed.counts().bad_results == 1);
    for _ in 0..3 {
        rig.tick();
    }
    assert_eq!(rig.feed.counts().forgets, 0);
    // The table starts over for another reason (a new checkpoint), the worker still has not been told.
    *script.text.lock().unwrap() = None;
    let base = cp(3);
    rig.session(&live_of(T, Some(&base)), &recs(1));
    rig.put_top(&sum_of(T), &base);
    for _ in 0..3 {
        rig.tick();
    }
    assert_eq!((rig.feed.counts().forgets, rig.feed.counts().cold), (0, 1), "nothing goes while the pipe is full");
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("tried again", |r| r.feed.fold(T, INC).is_some());
    let reqs = rig.reqs();
    let kinds: Vec<&str> = reqs.iter().map(|r| match r {
        Req::Cold(_) => "cold",
        Req::Warm(_) => "warm",
        Req::Forget { .. } => "forget",
    }).collect();
    assert_eq!(kinds, ["cold", "forget", "cold"]);
}

// ── The fold itself, through all of it ───────────────────────────────────────

/// The vectors' tables, written into a doc as the pages write them (the
/// records in batches, as the vectors' warm steps have them), watched by the
/// mirror, sent by the feed to the real engine in a thread: the summary that
/// comes back is the one the pages' fold gave.
#[test]
fn every_vector_table_comes_back_from_the_doc_as_the_pages_fold_it() {
    let mut served = 0;
    for c in cases() {
        // The tables the mirror follows: a checkpoint the pages take, or none, and a live session.
        let base_ok = c.cp.as_ref().is_none_or(|b| checkpoint_ok(b, &c.ctx.inc) && b.get("e").is_none());
        if !base_ok {
            continue;
        }
        served += 1;
        let case: Case = c.clone();
        let mut rig = Rig::new(&c.ctx.room, Arc::new(move || {
            let case = case.clone();
            Box::new(EngineFolder::new(Box::new(move || check_for(&case))).expect("the engine starts"))
        }));
        rig.inputs = Inputs::new(c.houses.clone(), c.pins.clone());
        rig.mirror.want(&[(c.ctx.t.clone(), c.ctx.inc.clone())]);
        if let Some(b) = &c.cp {
            rig.put_top(&format!("sum:{}:{}", c.ctx.t, c.ctx.inc), b);
        }
        let live = format!("ses:{}:{}:{}", c.ctx.t, c.ctx.inc, crate::house_bytes::next_sid(&c.ctx, c.cp.as_ref()).unwrap());
        rig.session(&live, &[]);
        for batch in &c.warm {
            for (k, v) in batch {
                match v {
                    Some(v) => rig.put(&live, k, to_any(v)),
                    None => rig.remove(&live, k),
                }
            }
            // Each batch is seen and answered before the next is written.
            let (t, inc) = (c.ctx.t.clone(), c.ctx.inc.clone());
            rig.until(&format!("{}: a batch answered", c.name), |r| r.feed.caught_up(&t, &inc, &r.mirror, &r.sup));
        }
        let fold = rig.feed.fold(&c.ctx.t, &c.ctx.inc).unwrap_or_else(|| panic!("{}: no answer", c.name));
        let mut want: FoldSummary = serde_json::from_str(&c.summary).unwrap();
        // `rawBytes` weighs junk as the page's JSON has it (a float 1.5 is three bytes); the mirror hands the node junk it
        // cannot hold as nothing, so it weighs the same or less. Everything else is the page's.
        assert!(fold.summary.raw_bytes <= want.raw_bytes && fold.summary.raw_bytes >= want.bytes, "{}: the weight of the session", c.name);
        want.raw_bytes = fold.summary.raw_bytes;
        assert_eq!(fold.summary, &want, "{}: the fold of the doc", c.name);
    }
    assert!(served >= 15, "{served} of the vectors are tables the mirror follows");
}
