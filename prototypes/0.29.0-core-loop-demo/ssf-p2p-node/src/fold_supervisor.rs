//! 🧮👀 The node's side of the fold worker: start it, feed it, watch it, and
//! start it again when it dies (PR 6b-1b of "Computed casino tables").
//!
//! NOTHING HERE BLOCKS. The node's tick posts what changed ([`Supervisor::post`]:
//! a frame is encoded and handed to a writer thread) and takes what has come
//! back ([`Supervisor::poll`]: a reader thread has put the answers in a channel),
//! and a worker that is slow, stuck or dead holds the fold up and nothing else:
//! the reveal path and the relay never wait on it (secure error 8).
//!
//! WHEN THE WORKER FAILS it is killed and the supervisor says so once, as an
//! [`Event::Crashed`] that names every table the worker held, so the node marks
//! each dirty and sends it again from scratch to the next worker. A failure is
//! any of: the process exited, a pipe broke, it sent something that is not a
//! frame it owes, or it gave no answer for [`ANSWER_TIMEOUT`] while a frame
//! waited for one. It starts again after a backoff (1 s, doubling to 60 s, for
//! failures that follow one another without an answer in between), and after
//! [`CRASH_LIMIT`] failures within [`CRASH_WINDOW`] the fold duties are off
//! until the node restarts: [`Supervisor::off`] says `"crashes"`, which
//! `/api/fingerprint` shows as `house.fold.off`. A worker that cannot be
//! started at all (the file gone) fails the same way.
//!
//! The worker starts when the first frame is posted, not with the node: a node
//! with no computed table never has one. Starting the process is the one step
//! `post` takes itself and waits for (a spawn of the node's own, already loaded
//! file: a few milliseconds, once for each start); killing a worker is only a
//! signal, and reaping it happens on a thread of its own.
//!
//! All time comes in as an argument (`now`), so the rules are tested in
//! virtual time.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::{HashSet, VecDeque};
use std::io::{self, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::fold_wire::{decode_resp, encode_req, read_frame, write_frame, Req, Resp, WireError};
use crate::house_bytes::Ctx;

/// A worker that gives no answer for this long while a frame waits for one is killed.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);
/// The wait after a first failure; it doubles for each that follows.
pub const BACKOFF_FIRST: Duration = Duration::from_secs(1);
/// The longest wait.
pub const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// Failures within [`CRASH_WINDOW`] that turn the fold duties off.
pub const CRASH_LIMIT: usize = 3;
pub const CRASH_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Bytes of frames that may wait for the worker to read them; a frame is refused
/// ([`Post::Busy`]) past that, unless nothing waits (so one big frame always goes).
pub const QUEUE_BYTES: usize = 16 << 20;
/// Answers the worker may owe at once; a frame is refused ([`Post::Busy`]) past that. With
/// [`QUEUE_BYTES`] this bounds what a slow worker costs the node, and the answers it may send
/// ahead of the node's reading them.
pub const MAX_OWED: usize = 256;
/// How long a worker's process may be gone before the supervisor stops waiting for its output
/// to say so: the reader thread sees the pipe end the moment the process does, and what the
/// worker wrote first reaches the node ahead of that, so this is only a backstop.
pub const EXIT_GRACE: Duration = Duration::from_secs(2);

// ── When to start again ─────────────────────────────────────────────────────

/// What to do after a failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restart {
    /// Start again after this wait.
    After(Duration),
    /// Too many failures: stay off until the node restarts.
    Off,
}

/// The restart rules, in time they are told.
#[derive(Debug, Default)]
pub struct RestartPolicy {
    /// When each failure of the last [`CRASH_WINDOW`] happened.
    failures: VecDeque<Instant>,
    /// Failures since a worker last answered.
    consecutive: u32,
}

impl RestartPolicy {
    pub fn on_failure(&mut self, now: Instant) -> Restart {
        while self.failures.front().is_some_and(|t| now.saturating_duration_since(*t) > CRASH_WINDOW) {
            self.failures.pop_front();
        }
        self.failures.push_back(now);
        self.consecutive = self.consecutive.saturating_add(1);
        if self.failures.len() >= CRASH_LIMIT {
            return Restart::Off;
        }
        Restart::After(backoff(self.consecutive))
    }

    /// A worker answered a frame: the next failure starts the backoff over.
    pub fn on_answer(&mut self) {
        self.consecutive = 0;
    }
}

/// The wait after the `n`th failure in a row (1-based): 1 s, 2 s, 4 s, ... 60 s.
pub fn backoff(n: u32) -> Duration {
    let shift = n.saturating_sub(1).min(16);
    BACKOFF_FIRST.saturating_mul(1u32 << shift).min(BACKOFF_MAX)
}

// ── A worker, as the supervisor sees it ─────────────────────────────────────

/// Something the reader or writer thread of a link has seen.
enum Incoming {
    Resp(Resp),
    /// The pipe ended or broke, or the worker sent what is not a frame.
    Closed(String),
}

/// A running worker: a thread that writes frames to it, a thread that reads
/// frames from it, and the means to kill it and to ask whether it is gone.
/// Dropping a link kills the worker.
pub struct Link {
    tx: Option<Sender<Vec<u8>>>,
    rx: Receiver<Incoming>,
    /// Bytes handed to the writer thread and not yet written.
    queued: Arc<AtomicUsize>,
    /// Answers the worker owes: counted up before a frame that wants one is handed over, down
    /// as each answer is read. An answer past that is nobody's, and ends the link.
    unanswered: Arc<AtomicUsize>,
    kill: Box<dyn FnMut() + Send>,
    exited: Box<dyn FnMut() -> bool + Send>,
}

impl Link {
    /// A link over a worker's input and output. `kill` must make both end (the
    /// threads then end too); `exited` says whether the worker is gone.
    pub fn new(mut to_worker: Box<dyn Write + Send>, mut from_worker: Box<dyn Read + Send>, kill: Box<dyn FnMut() + Send>, exited: Box<dyn FnMut() -> bool + Send>) -> Link {
        let (tx, frames) = channel::<Vec<u8>>();
        let (tell, rx) = channel::<Incoming>();
        let queued = Arc::new(AtomicUsize::new(0));
        let unanswered = Arc::new(AtomicUsize::new(0));
        let reader_unanswered = unanswered.clone();
        let writer_queued = queued.clone();
        let writer_tell = tell.clone();
        thread::Builder::new()
            .name("fold-writer".into())
            .spawn(move || {
                while let Ok(frame) = frames.recv() {
                    let n = frame.len();
                    let sent = write_frame(&mut to_worker, &frame);
                    writer_queued.fetch_sub(n, Ordering::Relaxed);
                    if let Err(e) = sent {
                        let _ = writer_tell.send(Incoming::Closed(format!("write to the worker: {e}")));
                        return;
                    }
                }
            })
            .expect("the fold writer thread starts");
        thread::Builder::new()
            .name("fold-reader".into())
            .spawn(move || loop {
                let said = match read_frame(&mut from_worker) {
                    Ok(Some(body)) => match decode_resp(&body) {
                        // A worker cannot queue answers in the node's memory faster than it was
                        // asked: one it was not asked for ends the link.
                        Ok(resp) if reader_unanswered.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1)).is_err() => {
                            drop(resp);
                            Incoming::Closed("the worker sent an answer nobody asked for".into())
                        }
                        Ok(resp) => Incoming::Resp(resp),
                        Err(e) => Incoming::Closed(format!("the worker sent a frame that is not an answer: {e}")),
                    },
                    Ok(None) => Incoming::Closed("the worker closed its output".into()),
                    Err(e) => Incoming::Closed(format!("read from the worker: {e}")),
                };
                let last = matches!(said, Incoming::Closed(_));
                if tell.send(said).is_err() || last {
                    return;
                }
            })
            .expect("the fold reader thread starts");
        Link { tx: Some(tx), rx, queued, unanswered, kill, exited }
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        // The writer thread ends when the sender goes; the worker, by the kill.
        self.tx = None;
        (self.kill)();
    }
}

/// How workers are started.
pub trait Launch {
    fn launch(&mut self) -> io::Result<Link>;
}

/// The real one: the node's own file, as `ssf-p2p-node --fold-worker`.
pub struct ChildLaunch {
    command: Box<dyn FnMut() -> io::Result<Command> + Send>,
}

impl ChildLaunch {
    pub fn new() -> ChildLaunch {
        ChildLaunch::with_command(Box::new(|| {
            let mut c = Command::new(std::env::current_exe()?);
            c.arg(crate::fold_worker::WORKER_ARG);
            Ok(c)
        }))
    }

    /// A different command (tests start stand-ins). Its stdin and stdout are piped here.
    pub fn with_command(command: Box<dyn FnMut() -> io::Result<Command> + Send>) -> ChildLaunch {
        ChildLaunch { command }
    }
}

impl Default for ChildLaunch {
    fn default() -> ChildLaunch {
        ChildLaunch::new()
    }
}

impl Launch for ChildLaunch {
    fn launch(&mut self) -> io::Result<Link> {
        let mut child = (self.command)()?.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn()?;
        let stdin = child.stdin.take().ok_or_else(|| io::Error::other("no pipe to the worker"))?;
        let stdout = child.stdout.take().ok_or_else(|| io::Error::other("no pipe from the worker"))?;
        let child: Arc<Mutex<Child>> = Arc::new(Mutex::new(child));
        let for_kill = child.clone();
        let for_exit = child;
        Ok(Link::new(
            Box::new(stdin),
            Box::new(stdout),
            Box::new(move || {
                if let Ok(mut c) = for_kill.lock() {
                    let _ = c.kill();
                }
                // Reaped off the node's tick: waiting for a process that will not die (stuck in
                // the kernel) must not hold the reveal path. Its input is closed with the link, so a
                // worker that outlives the kill leaves by itself when it next reads.
                let reap = for_kill.clone();
                let _ = thread::Builder::new().name("fold-reaper".into()).spawn(move || {
                    if let Ok(mut c) = reap.lock() {
                        let _ = c.wait();
                    }
                });
            }),
            Box::new(move || for_exit.lock().map(|mut c| !matches!(c.try_wait(), Ok(None))).unwrap_or(true)),
        ))
    }
}

// ── The supervisor ──────────────────────────────────────────────────────────

/// Where the worker is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Not started yet: the first frame starts it.
    Idle,
    Up,
    /// Failed; may start again from this time.
    Backoff(Instant),
    /// Failed too often: off until the node restarts.
    Off,
}

/// What [`Supervisor::post`] did with a frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Post {
    /// Handed to the worker. Its answer comes through [`Supervisor::poll`].
    Posted,
    /// Too many bytes wait for the worker already: keep the changes, try later.
    Busy,
    /// There is no worker now (it failed and waits to start again, or is off, or would not start):
    /// every table is dirty, and sent from scratch when there is.
    Down,
    /// The frame is past what a frame may hold, or nests too deep: split it, or give up on the table.
    TooBig(WireError),
}

/// What [`Supervisor::poll`] found.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Answer(Resp),
    /// The worker failed. Every table it held is dirty; `restart_in` is the wait before
    /// a frame starts another (none: the fold duties are off).
    Crashed { reason: String, tables: Vec<Ctx>, restart_in: Option<Duration> },
}

/// A frame the worker owes an answer to.
struct Owed {
    ctx: Ctx,
    version: u64,
    posted: Instant,
}

pub struct Supervisor<L: Launch> {
    launch: L,
    link: Option<Link>,
    state: State,
    policy: RestartPolicy,
    /// Frames sent to the worker that it owes answers to, in the order it owes them.
    owed: VecDeque<Owed>,
    /// When the worker last answered (or started): the clock of the answer timeout.
    last_answer: Instant,
    /// The tables this worker has been sent.
    held: HashSet<Ctx>,
    started: u64,
    failures: u64,
    /// Failures found while posting, said by the next poll.
    unsaid: Vec<Event>,
    /// When the worker's process was first seen gone, while its output has not yet said so.
    exit_seen: Option<Instant>,
}

impl<L: Launch> Supervisor<L> {
    pub fn new(launch: L, now: Instant) -> Supervisor<L> {
        Supervisor { launch, link: None, state: State::Idle, policy: RestartPolicy::default(), owed: VecDeque::new(), last_answer: now, held: HashSet::new(), started: 0, failures: 0, unsaid: Vec::new(), exit_seen: None }
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// Whether a worker is running.
    pub fn is_up(&self) -> bool {
        self.state == State::Up
    }

    /// `/api/fingerprint`'s `house.fold.off`: why the fold duties are off, if they are.
    pub fn off(&self) -> Option<&'static str> {
        (self.state == State::Off).then_some("crashes")
    }

    /// Workers started so far, and failures so far.
    pub fn counts(&self) -> (u64, u64) {
        (self.started, self.failures)
    }

    /// Whether the worker owes an answer for this table: the node holds a
    /// table's next changes back while one waits, and sends them as one frame.
    pub fn owes(&self, ctx: &Ctx) -> bool {
        self.owed.iter().any(|o| &o.ctx == ctx)
    }

    /// How many answers the worker owes.
    pub fn owed(&self) -> usize {
        self.owed.len()
    }

    /// Send a frame to the worker, starting one if there is none and the wait
    /// after the last failure is over. Never blocks.
    pub fn post(&mut self, now: Instant, req: &Req) -> Post {
        let frame = match encode_req(req) {
            Ok(f) => f,
            Err(e) => return Post::TooBig(e),
        };
        if self.link.is_none() && !self.start(now) {
            return Post::Down;
        }
        let link = self.link.as_ref().expect("a link after start");
        let wants_answer = !matches!(req, Req::Forget { .. });
        if wants_answer && self.owed.len() >= MAX_OWED {
            return Post::Busy;
        }
        let waiting = link.queued.load(Ordering::Relaxed);
        if waiting > 0 && waiting + frame.len() > QUEUE_BYTES {
            return Post::Busy;
        }
        link.queued.fetch_add(frame.len(), Ordering::Relaxed);
        if wants_answer {
            // Before the frame goes: an answer can be read before this thread runs again.
            link.unanswered.fetch_add(1, Ordering::SeqCst);
        }
        let sent = link.tx.as_ref().is_some_and(|tx| tx.send(frame).is_ok());
        if !sent {
            self.fail(now, "the worker's writer has ended".into());
            return Post::Down;
        }
        match req {
            Req::Cold(c) => {
                self.held.insert(c.ctx.clone());
                self.owed.push_back(Owed { ctx: c.ctx.clone(), version: c.version, posted: now });
            }
            Req::Warm(w) => {
                self.held.insert(w.ctx.clone());
                self.owed.push_back(Owed { ctx: w.ctx.clone(), version: w.version, posted: now });
            }
            Req::Forget { ctx } => {
                self.held.remove(ctx);
            }
        }
        Post::Posted
    }

    /// What has come back, and a look at how the worker is: gone, broken, or
    /// silent too long. Never blocks.
    pub fn poll(&mut self, now: Instant) -> Vec<Event> {
        let mut events = std::mem::take(&mut self.unsaid);
        loop {
            let Some(link) = self.link.as_ref() else { return events };
            match link.rx.try_recv() {
                Ok(Incoming::Resp(resp)) => {
                    let in_step = self.owed.front().is_some_and(|o| &o.ctx == resp.ctx() && o.version == resp.version());
                    if !in_step {
                        self.fail_into(now, "the worker answered out of step".into(), &mut events);
                        return events;
                    }
                    self.owed.pop_front();
                    self.last_answer = now;
                    self.policy.on_answer();
                    events.push(Event::Answer(resp));
                }
                Ok(Incoming::Closed(why)) => {
                    self.fail_into(now, why, &mut events);
                    return events;
                }
                Err(_) => break,
            }
        }
        // A process that is gone closes its output, and the reader tells us in order, after
        // every answer it wrote: that is how a failure is normally found. A process seen gone
        // whose output has not yet said so (the reader is behind) is given a moment to, so what
        // it wrote last is not thrown away with it.
        let gone = self.link.as_mut().is_some_and(|l| (l.exited)());
        if gone {
            let since = *self.exit_seen.get_or_insert(now);
            if now.saturating_duration_since(since) >= EXIT_GRACE {
                self.fail_into(now, "the worker exited".into(), &mut events);
                return events;
            }
        }
        if let Some(head) = self.owed.front() {
            // The wait counts from when the frame could first be read: not before
            // the answer to the one ahead of it.
            let since = head.posted.max(self.last_answer);
            if now.saturating_duration_since(since) > ANSWER_TIMEOUT {
                self.fail_into(now, format!("no answer in {} s", ANSWER_TIMEOUT.as_secs()), &mut events);
            }
        }
        events
    }

    /// Start a worker if the rules allow. `false`: there is none.
    fn start(&mut self, now: Instant) -> bool {
        match self.state {
            State::Off => return false,
            State::Backoff(until) if now < until => return false,
            _ => {}
        }
        match self.launch.launch() {
            Ok(link) => {
                self.link = Some(link);
                self.state = State::Up;
                self.last_answer = now;
                self.started += 1;
                true
            }
            Err(e) => {
                self.fail(now, format!("the worker would not start: {e}"));
                false
            }
        }
    }

    /// A failure found while posting, with no poll to tell it to: kept for the next poll.
    fn fail(&mut self, now: Instant, reason: String) {
        let mut events = Vec::new();
        self.fail_into(now, reason, &mut events);
        self.unsaid.extend(events);
    }

    /// The worker failed: kill it, forget what it owed, and decide when (or whether) to start another.
    fn fail_into(&mut self, now: Instant, reason: String, events: &mut Vec<Event>) {
        // Dropping the link kills the worker and ends its threads.
        self.link = None;
        self.exit_seen = None;
        self.owed.clear();
        let mut tables: Vec<Ctx> = self.held.drain().collect();
        tables.sort_by(|a, b| (&a.room, &a.t, &a.inc).cmp(&(&b.room, &b.t, &b.inc)));
        self.failures += 1;
        let restart_in = match self.policy.on_failure(now) {
            Restart::After(wait) => {
                self.state = State::Backoff(now + wait);
                Some(wait)
            }
            Restart::Off => {
                self.state = State::Off;
                None
            }
        };
        events.push(Event::Crashed { reason, tables, restart_in });
    }
}

#[cfg(test)]
mod tests;
