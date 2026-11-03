//! 🧮🍽️ What the mirror takes from the room, sent to the fold worker (PR
//! 6b-1c-ii of "Computed casino tables").
//!
//! The mirror (house_mirror.rs) follows a room's computed tables as changes;
//! the supervisor (fold_supervisor.rs) runs the worker that folds them. A
//! [`Feed`], one for each room, is the step between: each tick it takes what
//! the worker has answered ([`Feed::absorb`], from the events of one
//! [`Supervisor::poll`]) and then sends what has changed ([`Feed::push`]). It
//! never blocks and writes nothing to any doc: the fold's answers are kept for
//! the node to compare with the pages' checkpoints (6b-1c-iii), nothing more.
//!
//! A TABLE'S FRAMES. A table the mirror serves is started with a `Cold` (the
//! base, the room's houses and pins, the first records), then kept up with
//! `Warm`s (the records that changed). A big read goes in several frames of
//! about [`FRAME_BYTES`], one a tick. At most ONE frame of a table is out at a
//! time: while the worker owes an answer for it ([`Supervisor::owes`]) its
//! next changes wait in the mirror and go together after. So an answer is
//! always for the last frame sent, and its `version` (the mirror's number for
//! the table when the frame was taken) says whether the table has moved on
//! since.
//!
//! WHEN THE WORKER LOSES A TABLE. An answer that says the table is dirty, a
//! crash that names it, a result the node cannot use: the table is no longer
//! the worker's, and the mirror starts it over ([`RoomMirror::restart`]: read
//! afresh from the doc, the next frame a `Cold`). A table that comes back
//! dirty is not tried again at once: 1 s, 2 s, 4 s, up to a minute, and the
//! count starts over with an answer. A result bigger than [`MAX_RESULT_BYTES`]
//! or that is not a fold summary is the worker's fault, not the table's luck:
//! the node gives up on the table's records as they stand (it forgets it and
//! sends nothing more until the mirror starts the table over for another
//! reason), and counts it. A frame a frame cannot hold is the same. While the
//! worker is down (its backoff after a crash) nothing is taken from the
//! mirror; when the fold duties are off ([`Supervisor::off`]) the feed lets
//! everything go.
//!
//! WHAT IT KEEPS is each table's latest answer ([`Feed::fold`]) and whether
//! it is the table as it stands now ([`Feed::caught_up`]): the worker has
//! answered the last frame sent, nothing waits to be sent, and the mirror has
//! read everything the doc holds and changed nothing since the frame was taken.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use crate::fold_supervisor::{backoff, Event, Launch, Post, State, Supervisor};
use crate::fold_wire::{is_result_too_big, Cold, Req, Resp, Warm};
use crate::house_bytes::{CVal, Ctx};
use crate::house_fold::FoldSummary;
use crate::house_mirror::RoomMirror;

/// About how much of a table's changes go in one frame (by the mirror's
/// weights: a little over the record that crosses it). A frame is at most
/// [`MAX_FRAME`](crate::fold_wire::MAX_FRAME), and the supervisor queues
/// [`QUEUE_BYTES`](crate::fold_supervisor::QUEUE_BYTES) of them.
pub const FRAME_BYTES: usize = 4 << 20;
/// The most of an answer's text the node parses. A fold summary of a table
/// that honest players made is some tens of KiB.
pub const MAX_RESULT_BYTES: usize = 4 << 20;
/// How many answers in a row that say the fold is PENDING (it checked as many signatures as one
/// call may, and more are left) the feed asks again for, with no changes, before it leaves the
/// table as it stands: at [`MAX_NEW_CHECKS`](crate::house_fold::MAX_NEW_CHECKS) a pass, some
/// 260,000 signatures, far more than a session the mirror keeps can hold.
pub const MAX_PENDING_PASSES: u32 = 256;

/// What the worker needs of the room for every table in it: the keys of the
/// houses, and the key pinned for each player, as (pid, key). Sorted here, so
/// a list that comes in another order is not a change.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Inputs {
    pub houses: Vec<String>,
    pub pins: Vec<(String, String)>,
}

impl Inputs {
    pub fn new(mut houses: Vec<String>, mut pins: Vec<(String, String)>) -> Inputs {
        houses.sort();
        houses.dedup();
        pins.sort();
        pins.dedup();
        Inputs { houses, pins }
    }
}

/// What the feed has done, for `/api/fingerprint` and the log.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counts {
    /// `Cold` frames posted: a table's start, and each start over.
    pub cold: u64,
    pub warm: u64,
    pub forgets: u64,
    pub results: u64,
    /// Answers that said a table is dirty.
    pub dirty: u64,
    /// Tables lost to a crashed worker.
    pub lost: u64,
    /// Posts the worker was too busy for (kept, tried again).
    pub busy: u64,
    /// Frames a frame cannot hold.
    pub too_big: u64,
    /// Results the node could not use (past what it parses, no summary, or past what the
    /// worker could put in a frame).
    pub bad_results: u64,
}

impl Counts {
    /// The sum of two feeds' counts (a room let go keeps its count in the total).
    pub fn plus(self, o: Counts) -> Counts {
        Counts {
            cold: self.cold + o.cold,
            warm: self.warm + o.warm,
            forgets: self.forgets + o.forgets,
            results: self.results + o.results,
            dirty: self.dirty + o.dirty,
            lost: self.lost + o.lost,
            busy: self.busy + o.busy,
            too_big: self.too_big + o.too_big,
            bad_results: self.bad_results + o.bad_results,
        }
    }
}

/// A table's latest answer.
#[derive(Debug)]
pub struct Fold<'a> {
    pub summary: &'a FoldSummary,
    /// The mirror's version of the table when the frame it answers was taken.
    pub version: u64,
    /// The mirror's generation (starts over) then.
    pub generation: u64,
}

struct Answer {
    version: u64,
    generation: u64,
    summary: FoldSummary,
}

/// A frame taken from the mirror and not yet handed to the worker.
struct Unsent {
    req: Req,
    version: u64,
    generation: u64,
    /// The houses and pins it carries.
    given: Inputs,
}

struct Slot {
    /// The worker holds the table: a frame was posted and the table has not
    /// been lost since.
    open: bool,
    /// What the last posted frame was.
    generation: u64,
    sent_version: u64,
    /// The houses and pins as last posted.
    given: Inputs,
    unsent: Option<Unsent>,
    answer: Option<Answer>,
    /// Not before this (a table that came back dirty).
    retry_at: Option<Instant>,
    /// Answers in a row that said dirty.
    dirty_streak: u32,
    /// The generation the node gave up on.
    gave_up: Option<u64>,
    /// A `Forget` the worker was too busy for.
    forget_pending: bool,
    /// Which taking up of the table by the mirror this slot follows ([`State::born`]).
    born: u64,
    /// Answers in a row that said the fold is pending.
    pending_streak: u32,
}

impl Slot {
    fn new() -> Slot {
        Slot {
            open: false,
            generation: 0,
            sent_version: 0,
            given: Inputs::default(),
            unsent: None,
            answer: None,
            retry_at: None,
            dirty_streak: 0,
            gave_up: None,
            forget_pending: false,
            born: 0,
            pending_streak: 0,
        }
    }

    /// The worker no longer holds the table.
    fn lose(&mut self) {
        self.open = false;
        self.unsent = None;
        self.answer = None;
    }
}

pub struct Feed {
    room: String,
    slots: BTreeMap<(String, String), Slot>,
    counts: Counts,
    /// The houses and pins as of the last [`push`](Feed::push): what an answer has to have been
    /// folded with to be of the room as it stands.
    inputs: Option<Inputs>,
    /// [`MAX_PENDING_PASSES`] (a test asks for fewer).
    max_pending: u32,
}

fn key(ctx: &Ctx) -> (String, String) {
    (ctx.t.clone(), ctx.inc.clone())
}

impl Feed {
    pub fn new(room: &str) -> Feed {
        Feed { room: room.to_string(), slots: BTreeMap::new(), counts: Counts::default(), inputs: None, max_pending: MAX_PENDING_PASSES }
    }

    pub fn counts(&self) -> Counts {
        self.counts
    }

    /// Take what the worker said. `events` are all of one poll's, whatever
    /// room they are about: this room's are used, and a crash loses this
    /// room's tables the worker held.
    pub fn absorb(&mut self, now: Instant, events: &[Event]) {
        for event in events {
            match event {
                Event::Answer(resp) if resp.ctx().room == self.room => self.answered(now, resp),
                Event::Answer(_) => {}
                Event::Crashed { tables, .. } => {
                    for ctx in tables.iter().filter(|c| c.room == self.room) {
                        if let Some(slot) = self.slots.get_mut(&key(ctx)) {
                            slot.lose();
                            self.counts.lost += 1;
                        }
                    }
                }
            }
        }
    }

    fn answered(&mut self, now: Instant, resp: &Resp) {
        // (A table let go since: nothing is waiting for the answer.)
        let Some(slot) = self.slots.get_mut(&key(resp.ctx())) else { return };
        // (Or one forgotten since: the answer to a frame it was sent before.)
        if !slot.open {
            return;
        }
        match resp {
            Resp::Result { ctx, version, text } => {
                let parsed = if text.len() > MAX_RESULT_BYTES {
                    Err(format!("a result of {} bytes", text.len()))
                } else {
                    serde_json::from_str::<FoldSummary>(text).map_err(|e| format!("a result that is no summary: {e}"))
                };
                match parsed {
                    Ok(summary) => {
                        if summary.pending {
                            slot.pending_streak = slot.pending_streak.saturating_add(1);
                            if slot.pending_streak == self.max_pending {
                                eprintln!("🧮 fold: {} of {} still has signatures unchecked after {} passes; leaving it as it stands", ctx.t, ctx.room, self.max_pending);
                            }
                        } else {
                            slot.pending_streak = 0;
                        }
                        slot.answer = Some(Answer { version: *version, generation: slot.generation, summary });
                        slot.dirty_streak = 0;
                        slot.retry_at = None;
                        self.counts.results += 1;
                    }
                    Err(why) => {
                        eprintln!("🧮 fold: {} of {}: {why}; giving up on it as it stands", ctx.t, ctx.room);
                        slot.gave_up = Some(slot.generation);
                        slot.lose();
                        slot.forget_pending = true;
                        self.counts.bad_results += 1;
                    }
                }
            }
            Resp::Dirty { ctx, reason, .. } => {
                eprintln!("🧮 fold: {} of {} is dirty: {reason}", ctx.t, ctx.room);
                slot.lose();
                if is_result_too_big(reason) {
                    // The worker has dropped the table (the word is its own), and a fold of the
                    // same records is as big again: give up on it as it stands, as for a result
                    // the node cannot take.
                    slot.gave_up = Some(slot.generation);
                    self.counts.bad_results += 1;
                } else {
                    slot.dirty_streak = slot.dirty_streak.saturating_add(1);
                    slot.retry_at = Some(now + backoff(slot.dirty_streak));
                }
                self.counts.dirty += 1;
            }
        }
    }

    /// The table's latest answer, if the worker has given one.
    pub fn fold(&self, t: &str, inc: &str) -> Option<Fold<'_>> {
        let a = self.slots.get(&(t.to_string(), inc.to_string()))?.answer.as_ref()?;
        Some(Fold { summary: &a.summary, version: a.version, generation: a.generation })
    }

    /// The latest answer is for the table as it stands: it answers the last
    /// frame sent, that frame left nothing behind, nothing has been taken or
    /// has changed since, the mirror has read all the doc holds, the table was
    /// folded with the houses and pins the room has now, and the fold is
    /// finished (no signature left unchecked).
    pub fn caught_up<L: Launch>(&self, t: &str, inc: &str, mirror: &RoomMirror, sup: &Supervisor<L>) -> bool {
        let finished = self.slots.get(&(t.to_string(), inc.to_string())).and_then(|s| s.answer.as_ref()).is_some_and(|a| !a.summary.pending);
        finished && self.up_to_date(t, inc, mirror, sup)
    }

    /// As [`caught_up`](Feed::caught_up), but the fold may be unfinished (pending).
    fn up_to_date<L: Launch>(&self, t: &str, inc: &str, mirror: &RoomMirror, sup: &Supervisor<L>) -> bool {
        self.inputs.as_ref().is_some_and(|inputs| self.covers(t, inc, mirror, sup, inputs)) && mirror.current(t, inc)
    }

    /// The latest answer covers everything the mirror had read as of its last
    /// drain, under `inputs` (the houses and pins asked of the room): it
    /// answers the last frame sent, that frame left nothing behind, nothing
    /// waits to be taken, and the table was folded with `inputs`. It does not
    /// ask whether the doc has changed since the drain (`current`), nor that
    /// the fold is finished: the shadow asks this before a drain that may
    /// bring a page's trim, to know whether the answer in hand is the table as
    /// the node last read it.
    pub fn covers<L: Launch>(&self, t: &str, inc: &str, mirror: &RoomMirror, sup: &Supervisor<L>, inputs: &Inputs) -> bool {
        let Some(slot) = self.slots.get(&(t.to_string(), inc.to_string())) else { return false };
        let Some(answer) = &slot.answer else { return false };
        let Some(st) = mirror.state(t, inc) else { return false };
        let ctx = Ctx { room: self.room.clone(), t: t.to_string(), inc: inc.to_string() };
        // (The two versions say it all in every state the tests can make, and the clauses between them
        // follow from them there: they are kept for the states the tests cannot, where a wrong "covered"
        // would count a lateness of the fold as the fold's disagreement.)
        slot.open
            && slot.given == *inputs
            && answer.version == slot.sent_version
            && slot.unsent.is_none()
            && !sup.owes(&ctx)
            && st.serving()
            && !st.announcing
            && st.queued == 0
            && st.version == slot.sent_version
    }

    /// The feed holds no table, and owes the worker no word.
    pub fn is_idle(&self) -> bool {
        self.slots.is_empty()
    }

    /// Let go of the worker's tables and forget the answers (the fold duties are off).
    fn drop_all(&mut self) {
        self.slots.clear();
        self.inputs = None;
    }

    /// Send what has changed, one frame at most for each table. Nothing is
    /// sent while the worker is down.
    pub fn push<L: Launch>(&mut self, now: Instant, mirror: &mut RoomMirror, sup: &mut Supervisor<L>, inputs: &Inputs) {
        if sup.off().is_some() {
            self.drop_all();
            return;
        }
        self.inputs = Some(inputs.clone());
        if matches!(sup.state(), State::Backoff(until) if now < until) {
            return;
        }
        let Feed { room, slots, counts, max_pending, .. } = self;
        let tables: Vec<Ctx> = mirror.tables().cloned().collect();
        let wanted: BTreeSet<(String, String)> = tables.iter().map(key).collect();

        // Tables the mirror lets go.
        let gone: Vec<(String, String)> = slots.keys().filter(|k| !wanted.contains(*k)).cloned().collect();
        for k in gone {
            let Some(slot) = slots.get_mut(&k) else { continue };
            if slot.open || slot.forget_pending {
                forget(counts, now, sup, &Ctx { room: room.clone(), t: k.0.clone(), inc: k.1.clone() }, slot);
            }
            // (One the worker was too busy to be told of is kept, and told on a later tick.)
            if !slot.open && !slot.forget_pending {
                slots.remove(&k);
            }
        }

        for ctx in tables {
            let slot = slots.entry(key(&ctx)).or_insert_with(Slot::new);
            let Some(st) = mirror.state(&ctx.t, &ctx.inc) else { continue };

            // Another table than the one this slot followed (let go of and taken up again since
            // the last push, as while the worker was down): nothing kept of the old one is of
            // this. The worker's, if it holds one, is let go of; this one starts with a `Cold`.
            if slot.born != st.born {
                slot.born = st.born;
                slot.unsent = None;
                slot.answer = None;
                slot.gave_up = None;
                slot.retry_at = None;
                slot.dirty_streak = 0;
                slot.pending_streak = 0;
                if slot.open || slot.forget_pending {
                    forget(counts, now, sup, &ctx, slot);
                }
            }

            // Not a table to follow: the worker is not to hold it.
            if !st.serving() || slot.gave_up == Some(st.generation) {
                slot.unsent = None;
                if slot.open || slot.forget_pending {
                    forget(counts, now, sup, &ctx, slot);
                }
                continue;
            }
            if sup.owes(&ctx) || slot.retry_at.is_some_and(|t| now < t) {
                continue;
            }
            if slot.forget_pending {
                forget(counts, now, sup, &ctx, slot);
                continue;
            }

            let frame = match slot.unsent.take() {
                // A frame taken before that the worker was too busy for.
                Some(u) => u,
                None => {
                    // Lost to the worker: read afresh, and send from the start.
                    if !slot.open && !st.announcing {
                        mirror.restart(&ctx.t, &ctx.inc);
                        continue;
                    }
                    // (A table that started over has nothing to say until its first
                    // records are read, unless the session is truly empty.)
                    if st.announcing && st.queued == 0 && st.reading {
                        continue;
                    }
                    // (Nor has one that is up to date, unless its version moved with no change to send,
                    // as when a record a page may read otherwise came and went while an earlier table
                    // kept the push from visiting this one: an empty Warm says the worker has the table
                    // as it stands now; or unless its fold is pending: a pass with no changes checks
                    // more of its signatures.)
                    let more_to_check = slot.pending_streak < *max_pending
                        && slot.answer.as_ref().is_some_and(|a| a.summary.pending && a.version == slot.sent_version);
                    if !st.announcing && st.queued == 0 && slot.given == *inputs && st.version == slot.sent_version && !more_to_check {
                        continue;
                    }
                    let Some(taken) = mirror.take(&ctx.t, &ctx.inc, FRAME_BYTES) else { continue };
                    let (version, generation) = (taken.version, taken.generation);
                    let req = if taken.reset {
                        // (A record that came and went before the first take is no record to start with.)
                        let records: Vec<(String, CVal)> = taken.changes.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).collect();
                        Req::Cold(Cold { ctx: ctx.clone(), version, base: taken.base, houses: inputs.houses.clone(), pins: inputs.pins.clone(), records })
                    } else {
                        Req::Warm(Warm { ctx: ctx.clone(), version, houses: inputs.houses.clone(), pins: inputs.pins.clone(), changes: taken.changes })
                    };
                    Unsent { req, version, generation, given: inputs.clone() }
                }
            };
            if let Sent::Stop = send(counts, now, sup, slot, &ctx, frame) {
                // The rest would be refused too, or the worker is gone.
                return;
            }
        }
    }
}

enum Sent {
    Next,
    Stop,
}

fn send<L: Launch>(counts: &mut Counts, now: Instant, sup: &mut Supervisor<L>, slot: &mut Slot, ctx: &Ctx, frame: Unsent) -> Sent {
    let was_cold = matches!(frame.req, Req::Cold(_));
    match sup.post(now, &frame.req) {
        Post::Posted => {
            slot.open = true;
            slot.generation = frame.generation;
            slot.sent_version = frame.version;
            slot.given = frame.given;
            if was_cold {
                slot.pending_streak = 0;
                counts.cold += 1;
            } else {
                counts.warm += 1;
            }
            Sent::Next
        }
        Post::Busy => {
            counts.busy += 1;
            slot.unsent = Some(frame);
            Sent::Stop
        }
        // The worker would not start: the supervisor says so (a crash event for the tables it
        // held, none for this), and this table is read afresh when there is one.
        Post::Down => {
            slot.lose();
            Sent::Stop
        }
        Post::TooBig(why) => {
            eprintln!("🧮 fold: {} of {}: a frame the worker cannot be sent ({why}); giving up on it as it stands", ctx.t, ctx.room);
            slot.gave_up = Some(frame.generation);
            // (A table the worker held still holds it, as of the frames before this one.)
            let held = slot.open;
            slot.lose();
            slot.forget_pending |= held;
            counts.too_big += 1;
            Sent::Next
        }
    }
}

/// Tell the worker to let go of a table. The slot lets go of it here and now (what
/// it held is no longer to be built on: a later frame is a `Cold`); one the worker is
/// too busy to be told of owes the word ([`Slot::forget_pending`]), told on a later tick.
fn forget<L: Launch>(counts: &mut Counts, now: Instant, sup: &mut Supervisor<L>, ctx: &Ctx, slot: &mut Slot) {
    slot.open = false;
    slot.answer = None;
    slot.unsent = None;
    slot.forget_pending = matches!(sup.post(now, &Req::Forget { ctx: ctx.clone() }), Post::Busy);
    if !slot.forget_pending {
        counts.forgets += 1;
    }
}

#[cfg(test)]
pub(crate) mod tests;
