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
pub(crate) type Maker = Arc<dyn Fn() -> Box<dyn Folder> + Send + Sync>;

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
pub(crate) struct ThreadLaunch {
    make: Maker,
    pub(crate) launches: Arc<AtomicUsize>,
    /// Every request a worker was sent, in order, across workers.
    pub(crate) log: Arc<Mutex<Vec<Req>>>,
    /// Launches that fail, from the first.
    pub(crate) refuse: Arc<AtomicBool>,
}

impl ThreadLaunch {
    pub(crate) fn new(make: Maker) -> ThreadLaunch {
        ThreadLaunch { make, launches: Arc::new(AtomicUsize::new(0)), log: Arc::new(Mutex::new(Vec::new())), refuse: Arc::new(AtomicBool::new(false)) }
    }
}

/// A worker's folder that is the fold engine, checking signatures as `case` does.
pub(crate) fn engine_maker(case: &Case) -> Maker {
    let case = case.clone();
    Arc::new(move || {
        let case = case.clone();
        Box::new(EngineFolder::new(Box::new(move || check_for(&case))).expect("the engine starts"))
    })
}

/// A folder that is `inner` until its `n`th request, which ends the worker (a panic nobody recovers from).
pub(crate) fn dying_at(inner: Maker, n: usize) -> Maker {
    Arc::new(move || Box::new(Dying { inner: inner(), asked: 0, n, alive: true }))
}

struct Dying {
    inner: Box<dyn Folder>,
    asked: usize,
    n: usize,
    alive: bool,
}

impl Dying {
    fn ask(&mut self) {
        self.asked += 1;
        if self.asked == self.n {
            self.alive = false;
            panic!("the worker falls over");
        }
    }
}

impl Folder for Dying {
    fn cold(&mut self, c: &Cold) -> Result<String, String> {
        self.ask();
        self.inner.cold(c)
    }
    fn warm(&mut self, w: &Warm) -> Result<String, String> {
        self.ask();
        self.inner.warm(w)
    }
    fn forget(&mut self, ctx: &Ctx) {
        self.inner.forget(ctx)
    }
    fn recover(&mut self) -> bool {
        self.alive && self.inner.recover()
    }
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
    cases().into_iter().map(|c| c.summary).find(|s| !s.contains("\"pending\":true")).expect("a vector whose fold is finished")
}

/// The same, with the fold not finished (the signatures one call may check are used up).
fn canned_pending() -> String {
    let mut v: serde_json::Value = serde_json::from_str(&canned()).unwrap();
    v["pending"] = serde_json::Value::Bool(true);
    v.to_string()
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
    /// How many more answers say the fold is pending (signatures left unchecked).
    pending_for: Arc<AtomicUsize>,
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
        if self.script.pending_for.load(Ordering::SeqCst) > 0 {
            self.script.pending_for.fetch_sub(1, Ordering::SeqCst);
            return Ok(canned_pending());
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
        self.caught_up_of(T)
    }

    /// As `caught_up`, with the fold unfinished (pending) allowed.
    fn up_to_date_of(&self, t: &str) -> bool {
        self.feed.up_to_date(t, INC, &self.mirror, &self.sup)
    }

    fn caught_up_of(&self, t: &str) -> bool {
        self.feed.caught_up(t, INC, &self.mirror, &self.sup)
    }

    fn covers(&self, inputs: &Inputs) -> bool {
        self.feed.covers(T, INC, &self.mirror, &self.sup, inputs)
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
    let script = Script::default();
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(1));
    rig.until("caught up", |r| r.caught_up());
    // The worker's second request ends it, and no worker starts again: the supervisor turns the duties off.
    script.crash_at.lock().unwrap().push(2);
    rig.refuse.store(true, Ordering::SeqCst);
    let mut secs = 0;
    for _ in 0..12 {
        rig.put(&live0(), &rk(1, 50 + secs), val(1));
        secs += 1;
        rig.now += std::time::Duration::from_secs(70);
        rig.tick();
        // (The crash is the worker's own: its thread may not have got there yet.)
        thread::sleep(std::time::Duration::from_millis(5));
        if rig.sup.off().is_some() {
            break;
        }
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

#[test]
fn a_table_is_not_caught_up_while_it_waits_to_be_told_the_houses_and_pins_of_the_room_now() {
    let mut rig = Rig::new(ROOM, Arc::new(|| Box::new(Stand { script: Script::default(), asked: 0, alive: true })));
    rig.inputs = Inputs::new(vec!["h1".into()], vec![]);
    rig.session(&live0(), &recs(1));
    rig.session(&live_of("t2", None), &recs(1));
    rig.want(&[(T, INC), ("t2", INC)]);
    rig.until("both caught up", |r| r.caught_up_of(T) && r.caught_up_of("t2"));
    // The room's pins change while the worker's pipe is full: the first table's frame is refused,
    // and the second is not even tried. Neither has an answer folded with the keys of the room now.
    rig.sup.clog(QUEUE_BYTES);
    rig.inputs = Inputs::new(vec!["h1".into()], vec![("alice".into(), "ka".into())]);
    for _ in 0..4 {
        rig.tick();
    }
    assert!(rig.feed.counts().busy >= 1);
    assert!(!rig.caught_up_of(T) && !rig.caught_up_of("t2"), "answers folded with the old keys");
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("both told", |r| r.caught_up_of(T) && r.caught_up_of("t2"));
    let reqs = rig.reqs();
    let told: Vec<&Warm> = warms(&reqs).into_iter().filter(|w| w.pins.len() == 1).collect();
    assert_eq!(told.len(), 2, "each table was told the pin");
}

#[test]
fn an_answer_covers_the_table_as_the_node_last_sent_it_and_with_the_inputs_it_was_folded_with() {
    let mut rig = Rig::new(ROOM, Arc::new(|| Box::new(Stand { script: Script::default(), asked: 0, alive: true })));
    let inputs = Inputs::new(vec!["h1".into()], vec![]);
    rig.inputs = inputs.clone();
    rig.session(&live0(), &recs(1));
    rig.want(&[(T, INC)]);
    assert!(!rig.covers(&inputs), "no answer yet");
    rig.until("caught up", |r| r.caught_up());
    assert!(rig.covers(&inputs));
    // Another house, or another player's key, is another table to the fold.
    assert!(!rig.covers(&Inputs::new(vec!["h2".into()], vec![])));
    assert!(!rig.covers(&Inputs::new(vec!["h1".into()], vec![("alice".into(), "ka".into())])));
    // A record the node has not read yet (no tick has drained it) is not one the answer lacks: it covers
    // the table as the node last read it.
    rig.put(&live0(), &rk(1, 5), val(5));
    assert!(rig.covers(&inputs));
    // Read, and the worker's pipe is full: the node has the change and the worker does not.
    rig.sup.clog(QUEUE_BYTES);
    rig.tick();
    assert!(!rig.covers(&inputs), "the change is waiting to be sent");
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("told", |r| r.caught_up());
    assert!(rig.covers(&inputs));
}

/// A cold read that is not finished: what the worker was sent is a start of the session, and the
/// answer to it is not the table.
#[test]
fn an_answer_does_not_cover_a_table_whose_session_is_still_being_read() {
    let mut rig = Rig::with_limits(ROOM, Arc::new(|| Box::new(Stand { script: Script::default(), asked: 0, alive: true })), Limits { drain_paths: 6, ..Limits::default() });
    rig.session(&live0(), &recs(40));
    rig.want(&[(T, INC)]);
    rig.tick();
    assert!(rig.mirror.state(T, INC).unwrap().reading, "a drain of six paths does not read forty records");
    // The worker answers the first frame; the node takes the answer and has not drained since.
    for _ in 0..500 {
        thread::sleep(std::time::Duration::from_millis(2));
        let events = rig.sup.poll(rig.now);
        rig.feed.absorb(rig.now, &events);
        if rig.feed.fold(T, INC).is_some() {
            break;
        }
    }
    assert!(rig.feed.fold(T, INC).is_some());
    let st = rig.mirror.state(T, INC).unwrap();
    assert!(st.reading && st.serving() && !st.announcing && st.queued == 0, "nothing else says it is not the table");
    assert!(!rig.covers(&rig.inputs.clone()), "the session is not all read");
    // Read to its end, sent and answered: it is.
    rig.until("caught up", |r| r.caught_up());
    assert!(!rig.mirror.state(T, INC).unwrap().reading);
    assert!(rig.covers(&rig.inputs.clone()));
}

/// An answer is of one frame of the table's slot, and says which; a frame that changes only the inputs is another.
#[test]
fn an_answer_says_which_frame_it_is_of() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    let first = rig.feed.fold(T, INC).unwrap().frame;
    assert_eq!(first, 1);
    assert_eq!(rig.feed.answers(T, INC, &rig.sup, &rig.inputs), Some(first));
    // A record: the second frame.
    rig.put(&live0(), &rk(1, 9), val(9));
    rig.until("caught up", |r| r.caught_up());
    let second = rig.feed.fold(T, INC).unwrap().frame;
    assert_eq!(second, 2);
    assert_eq!(rig.feed.answers(T, INC, &rig.sup, &rig.inputs), Some(second));
    // The inputs change, the table does not: a frame with no change in it, the third.
    rig.inputs = Inputs::new(vec!["h9".into()], vec![]);
    assert_eq!(rig.feed.answers(T, INC, &rig.sup, &rig.inputs), None, "the answer was made with other inputs");
    rig.until("caught up", |r| r.caught_up());
    assert_eq!(rig.feed.fold(T, INC).unwrap().frame, 3);
    assert_eq!(rig.feed.answers(T, INC, &rig.sup, &rig.inputs), Some(3));
    // A frame out, or one waiting: no answer is of the last.
    rig.put(&live0(), &rk(1, 10), val(10));
    rig.sup.clog(QUEUE_BYTES);
    rig.tick();
    assert_eq!(rig.feed.answers(T, INC, &rig.sup, &rig.inputs), None, "the changes wait");
    rig.sup.unclog(QUEUE_BYTES);
    // A table let go of and taken up again starts its frames afresh.
    rig.until("caught up", |r| r.caught_up());
    assert_eq!(rig.feed.fold(T, INC).unwrap().frame, 4);
    assert_eq!(rig.feed.answers("nowhere", INC, &rig.sup, &rig.inputs), None);
}

/// The word to let go of a table, said apart from the changes to the others.
#[test]
fn release_tells_the_worker_of_the_tables_the_mirror_let_go_and_sends_nothing_else() {
    let mut rig = stand_rig(&Script::default());
    let t2 = live_of("t2", None);
    rig.session(&live0(), &recs(2));
    rig.session(&t2, &recs(2));
    rig.want(&[(T, INC), ("t2", INC)]);
    rig.until("both caught up", |r| r.caught_up_of(T) && r.caught_up_of("t2"));
    let before = rig.feed.counts();
    // One table goes; a record of the other is waiting to be sent.
    rig.want(&[("t2", INC)]);
    rig.put(&t2, &rk(1, 9), val(9));
    {
        let txn = rig.doc.transact();
        rig.mirror.drain(&txn);
    }
    rig.feed.release(rig.now, &rig.mirror, &mut rig.sup);
    let c = rig.feed.counts();
    assert_eq!((c.forgets, c.warm, c.cold), (before.forgets + 1, before.warm, before.cold), "the word, and no change");
    assert!(!rig.feed.owes_forget());
    assert_eq!(forgets(&rig.reqs()), 1);
    // Said once; and the push after has only the change to send.
    rig.feed.release(rig.now, &rig.mirror, &mut rig.sup);
    assert_eq!(rig.feed.counts().forgets, before.forgets + 1);
    rig.tick();
    assert_eq!(rig.feed.counts().warm, before.warm + 1);
    assert_eq!(rig.feed.counts().forgets, before.forgets + 1);
}

#[test]
fn a_word_the_worker_cannot_take_is_owed_and_said_when_it_can() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    assert!(!rig.feed.owes_forget());
    rig.sup.clog(QUEUE_BYTES);
    rig.want(&[]);
    rig.feed.release(rig.now, &rig.mirror, &mut rig.sup);
    assert!(rig.feed.owes_forget(), "refused: owed");
    assert!(!rig.feed.is_idle());
    rig.sup.unclog(QUEUE_BYTES);
    rig.feed.release(rig.now, &rig.mirror, &mut rig.sup);
    assert!(!rig.feed.owes_forget());
    assert!(rig.feed.is_idle());
    assert_eq!(forgets(&rig.reqs()), 1);
}

/// A table the worker does not hold yet waits for the word that lets go of others; those it holds go on.
#[test]
fn a_table_the_worker_does_not_hold_waits_when_new_ones_are_not_allowed_and_the_others_go_on() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    let t2 = live_of("t2", None);
    rig.session(&t2, &recs(2));
    rig.want(&[(T, INC), ("t2", INC)]);
    rig.put(&live0(), &rk(1, 9), val(9));
    for _ in 0..3 {
        {
            let txn = rig.doc.transact();
            rig.mirror.drain(&txn);
        }
        rig.feed.push_with(rig.now, &mut rig.mirror, &mut rig.sup, &rig.inputs, false);
    }
    let c = rig.feed.counts();
    assert_eq!((c.cold, c.warm), (1, 1), "the table the worker holds is kept up; the new one is not started");
    assert!(rig.feed.fold("t2", INC).is_none());
    // Allowed, it is started.
    {
        let txn = rig.doc.transact();
        rig.mirror.drain(&txn);
    }
    rig.feed.push_with(rig.now, &mut rig.mirror, &mut rig.sup, &rig.inputs, true);
    assert_eq!(rig.feed.counts().cold, 2);
    rig.until("both caught up", |r| r.caught_up_of(T) && r.caught_up_of("t2"));
}

/// A first frame the worker was too busy for is held back too, with the new ones.
#[test]
fn a_first_frame_taken_and_not_sent_waits_when_new_ones_are_not_allowed() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("the worker is started", |r| r.caught_up());
    let t2 = live_of("t2", None);
    rig.session(&t2, &recs(2));
    rig.want(&[(T, INC), ("t2", INC)]);
    rig.sup.clog(QUEUE_BYTES);
    rig.tick();
    assert_eq!(rig.feed.counts().busy, 1, "the Cold was taken and refused");
    rig.sup.unclog(QUEUE_BYTES);
    for _ in 0..3 {
        rig.feed.push_with(rig.now, &mut rig.mirror, &mut rig.sup, &rig.inputs, false);
    }
    assert_eq!(rig.feed.counts().cold, 1, "only the first table's");
    rig.feed.push_with(rig.now, &mut rig.mirror, &mut rig.sup, &rig.inputs, true);
    assert_eq!(rig.feed.counts().cold, 2);
}

/// A table the mirror let go of holds its place of the worker's until the worker has been told so: a word the pipe was too
/// full to take is still owed, and the table is held.
#[test]
fn a_table_the_worker_is_still_to_be_told_to_let_go_of_is_still_held() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    assert_eq!((rig.feed.holds(), rig.feed.owes_forget()), (1, false));
    rig.sup.clog(QUEUE_BYTES);
    rig.want(&[]);
    for _ in 0..3 {
        rig.tick();
    }
    assert!(rig.feed.owes_forget(), "the word was refused: owed");
    assert_eq!(rig.feed.holds(), 1, "and the worker holds the table until it is told");
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("told", |r| !r.feed.owes_forget());
    assert_eq!(rig.feed.holds(), 0, "and then it does not");
}

/// A table the worker does not hold yet takes one of the places a room is given when it is started; a table it holds
/// takes none; and a place not given is not taken (the table waits).
#[test]
fn each_table_started_takes_one_of_the_places_the_room_is_given_and_a_table_held_takes_none() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    assert_eq!(rig.feed.holds(), 1);
    let mut want = vec![(T, INC)];
    for n in ["t2", "t3", "t4"] {
        rig.session(&live_of(n, None), &recs(2));
        want.push((n, INC));
    }
    rig.want(&want);
    rig.put(&live0(), &rk(1, 9), val(9));
    let now = rig.now;
    let push = |rig: &mut Rig, room: &mut usize| {
        {
            let txn = rig.doc.transact();
            rig.mirror.drain(&txn);
        }
        rig.feed.push_clocked(&|| now, &mut rig.mirror, &mut rig.sup, &rig.inputs, room);
    };
    // Two places: the table held is kept up (it takes none), two of the three new ones are started, the last waits.
    let mut room = 2usize;
    push(&mut rig, &mut room);
    let c = rig.feed.counts();
    assert_eq!((c.cold, c.warm, room), (3, 1, 0), "the held table's warm, and two new tables' colds, took two places");
    assert_eq!(rig.feed.holds(), 3);
    assert!(rig.feed.fold("t4", INC).is_none());
    // None: nothing more is started, however many times the pass is made.
    for _ in 0..3 {
        push(&mut rig, &mut room);
    }
    assert_eq!((rig.feed.counts().cold, rig.feed.holds()), (3, 3));
    // One more: the last is started, and takes it.
    room = 1;
    push(&mut rig, &mut room);
    assert_eq!((rig.feed.counts().cold, rig.feed.holds(), room), (4, 4, 0));
    // More than are wanted: what is left is what was not taken.
    room = 10;
    push(&mut rig, &mut room);
    assert_eq!((rig.feed.counts().cold, room), (4, 10), "nothing new was started, so no place is taken");
    rig.until("all caught up", |r| ["t2", "t3", "t4"].iter().all(|t| r.caught_up_of(t)) && r.caught_up_of(T));
    // A table that cannot be started (the worker was too busy) takes no place either.
    rig.sup.clog(QUEUE_BYTES);
    rig.session(&live_of("t5", None), &recs(2));
    want.push(("t5", INC));
    rig.want(&want);
    let mut room = 5usize;
    push(&mut rig, &mut room);
    assert_eq!((rig.feed.holds(), room), (4, 5), "refused: not held, and no place taken");
}

#[test]
fn a_table_whose_version_moved_without_a_change_is_acknowledged_when_the_pipe_clears() {
    let mut rig = Rig::new(ROOM, Arc::new(|| Box::new(Stand { script: Script::default(), asked: 0, alive: true })));
    rig.session(&live0(), &recs(1));
    let t2 = live_of("t2", None);
    rig.session(&t2, &recs(1));
    rig.want(&[(T, INC), ("t2", INC)]);
    rig.until("both caught up", |r| r.caught_up_of(T) && r.caught_up_of("t2"));
    // The pipe is full: the first table's change is refused, and the second is not even visited ...
    rig.sup.clog(QUEUE_BYTES);
    rig.put(&live0(), &rk(1, 5), val(5));
    rig.put(&t2, &rk(1, 6), proto());
    rig.tick();
    // ... while a record a page may read otherwise comes and goes there: the table is held and let go of,
    // with nothing to send, and its version has moved on.
    rig.remove(&t2, &rk(1, 6));
    rig.tick();
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("both caught up again", |r| r.caught_up_of(T) && r.caught_up_of("t2"));
}

#[test]
fn a_fold_that_is_pending_is_asked_again_with_no_changes_until_it_is_finished() {
    let script = Script::default();
    script.pending_for.store(3, Ordering::SeqCst);
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(2));
    rig.until("finished", |r| {
        if r.caught_up() {
            assert!(!r.feed.fold(T, INC).unwrap().summary.pending, "an unfinished fold is not the table as it stands");
            return true;
        }
        false
    });
    let reqs = rig.reqs();
    assert_eq!(colds(&reqs).len(), 1);
    let again = warms(&reqs);
    assert_eq!(again.len(), 3, "a pass for each answer that said pending");
    assert!(again.iter().all(|w| w.changes.is_empty()));
    // And then it is left alone.
    for _ in 0..10 {
        rig.tick();
    }
    assert_eq!(rig.reqs().len(), 4);
}

#[test]
fn a_fold_that_stays_pending_is_asked_for_a_bounded_number_of_passes() {
    let script = Script::default();
    script.pending_for.store(usize::MAX, Ordering::SeqCst);
    let mut rig = stand_rig(&script);
    assert_eq!(rig.feed.max_pending, MAX_PENDING_PASSES, "the default");
    // (Fewer than the default: a pass is a round trip to a thread, and a loaded machine makes it slow.)
    rig.feed.max_pending = 24;
    rig.session(&live0(), &recs(2));
    let passes = 24u64;
    rig.until("the passes are spent", |r| r.feed.counts().results == passes);
    for _ in 0..20 {
        rig.tick();
        thread::sleep(std::time::Duration::from_millis(2));
    }
    let c = rig.feed.counts();
    assert_eq!((c.cold, c.warm, c.results), (1, passes - 1, passes), "no more asked for");
    assert!(!rig.caught_up());
    // A change is still sent, and an answer that finishes starts the count over.
    script.pending_for.store(0, Ordering::SeqCst);
    rig.put(&live0(), &rk(1, 9), val(9));
    rig.until("finished", |r| r.caught_up());
    assert_eq!(rig.feed.counts().warm, passes);
}

#[test]
fn an_answer_that_finishes_the_fold_starts_the_count_of_passes_over() {
    let script = Script::default();
    // Two answers that say pending, then a finished one: with three passes allowed in a row.
    script.pending_for.store(2, Ordering::SeqCst);
    let mut rig = stand_rig(&script);
    rig.feed.max_pending = 3;
    rig.session(&live0(), &recs(2));
    rig.until("finished", |r| r.caught_up());
    // The same again for a change: the two before did not count against it.
    script.pending_for.store(2, Ordering::SeqCst);
    rig.put(&live0(), &rk(1, 9), val(9));
    rig.until("finished again", |r| r.caught_up());
    let c = rig.feed.counts();
    assert_eq!((c.cold, c.warm), (1, 5), "1 + 1 passes, the change, 1 more pass");
}

#[test]
fn a_table_that_starts_over_has_its_passes_counted_from_the_start() {
    let script = Script::default();
    script.pending_for.store(usize::MAX, Ordering::SeqCst);
    let mut rig = stand_rig(&script);
    rig.feed.max_pending = 3;
    rig.session(&live0(), &recs(2));
    rig.until("the passes are spent", |r| r.feed.counts().results == 3);
    for _ in 0..10 {
        rig.tick();
        thread::sleep(std::time::Duration::from_millis(2));
    }
    let c = rig.feed.counts();
    assert_eq!((c.cold, c.warm), (1, 2));
    // A new checkpoint starts the table over: a Cold, and the passes again.
    let base = cp(3);
    rig.session(&live_of(T, Some(&base)), &recs(2));
    rig.put_top(&sum_of(T), &base);
    rig.until("the passes are spent again", |r| r.feed.counts().results == 6);
    for _ in 0..10 {
        rig.tick();
        thread::sleep(std::time::Duration::from_millis(2));
    }
    let c = rig.feed.counts();
    assert_eq!((c.cold, c.warm), (2, 4), "the second Cold got its passes");
}

#[test]
fn a_table_let_go_of_and_taken_up_again_between_two_pushes_is_forgotten_at_the_worker_and_sent_afresh() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(2));
    rig.until("caught up", |r| r.caught_up());
    // (The feed never sees the table gone.)
    rig.mirror.want(&[]);
    rig.want(&[(T, INC)]);
    rig.tick();
    assert!(rig.feed.fold(T, INC).is_none() || !rig.caught_up(), "the old table's answer is not the new one's");
    rig.until("sent afresh", |r| colds(&r.reqs()).len() == 2 && r.caught_up());
    let reqs = rig.reqs();
    let kinds: Vec<&str> = reqs.iter().map(|r| match r {
        Req::Cold(_) => "cold",
        Req::Warm(_) => "warm",
        Req::Forget { .. } => "forget",
    }).collect();
    assert_eq!(kinds, ["cold", "forget", "cold"], "the old table is let go of at the worker first");
}

#[test]
fn a_frame_kept_for_a_table_before_the_worker_held_it_is_not_sent_for_the_one_that_comes_after() {
    let mut rig = stand_rig(&Script::default());
    rig.session(&live0(), &recs(1));
    rig.until("caught up", |r| r.caught_up());
    // A second table, sent when the pipe is full: its first Cold is taken and kept.
    rig.sup.clog(QUEUE_BYTES);
    rig.session(&live_of("t2", None), &recs(2));
    rig.want(&[(T, INC), ("t2", INC)]);
    rig.until("the first Cold is kept", |r| r.feed.counts().busy >= 1);
    // The mirror lets that table go and takes it up again between two pushes.
    rig.want(&[(T, INC)]);
    rig.want(&[(T, INC), ("t2", INC)]);
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("sent", |r| r.caught_up_of("t2"));
    let reqs = rig.reqs();
    assert_eq!(colds(&reqs).iter().filter(|c| c.ctx.t == "t2").count(), 1, "one Cold, taken from the table as it is");
}

#[test]
fn a_table_given_up_on_that_is_let_go_of_and_wanted_again_is_sent_afresh() {
    let script = Script::default();
    *script.text.lock().unwrap() = Some("this is not a summary".into());
    script.gate.store(true, Ordering::SeqCst);
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(1));
    rig.until("the Cold is out", |r| r.feed.counts().cold == 1);
    // The bad result: given up on, and the Forget waits for a full pipe.
    rig.sup.clog(QUEUE_BYTES);
    script.gate.store(false, Ordering::SeqCst);
    rig.until("the bad result", |r| r.feed.counts().bad_results == 1);
    // The mirror lets the table go and takes it up again: its generation is back where the one given up on was.
    *script.text.lock().unwrap() = None;
    rig.mirror.want(&[]);
    for _ in 0..3 {
        rig.tick();
    }
    rig.want(&[(T, INC)]);
    rig.sup.unclog(QUEUE_BYTES);
    rig.until("sent afresh", |r| r.caught_up());
    let reqs = rig.reqs();
    let kinds: Vec<&str> = reqs.iter().map(|r| match r {
        Req::Cold(_) => "cold",
        Req::Warm(_) => "warm",
        Req::Forget { .. } => "forget",
    }).collect();
    assert_eq!(kinds, ["cold", "forget", "cold"]);
}

#[test]
fn a_table_let_go_of_and_wanted_again_between_two_pushes_is_not_the_one_given_up_on() {
    let script = Script::default();
    *script.text.lock().unwrap() = Some("this is not a summary".into());
    let mut rig = stand_rig(&script);
    rig.session(&live0(), &recs(1));
    rig.until("the bad result", |r| r.feed.counts().bad_results == 1);
    rig.until("the worker was told", |r| r.feed.counts().forgets == 1);
    *script.text.lock().unwrap() = None;
    // (As when the worker was down and nothing was pushed: the feed never sees the table gone.)
    rig.mirror.want(&[]);
    rig.want(&[(T, INC)]);
    rig.until("sent afresh", |r| r.caught_up());
    assert_eq!(rig.feed.counts().cold, 2);
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
        // (A vector whose hold keeps signatures unchecked for good is pending for good: one answer is all it has.)
        rig.feed.max_pending = 1;
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
            rig.until(&format!("{}: a batch answered", c.name), |r| r.feed.up_to_date(&t, &inc, &r.mirror, &r.sup));
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
