//! 🪞 What the node keeps of a room's computed tables for the fold (PR 6b-1c-i
//! of "Computed casino tables").
//!
//! The fold worker (fold_worker.rs) folds a table from its records, and the
//! records live in the room's doc. This is the node's side of that: for each
//! house table it was asked to mirror, which checkpoint the doc holds, which
//! session follows it, and the records of that session as every page reads
//! them, as a stream of CHANGES, so the worker is told what changed and the
//! node never copies the session again for a table it already folded. It
//! holds data only: no worker, no `House`, no keys. The caller says which
//! tables to mirror ([`RoomMirror::want`]) and what to do with the changes
//! ([`RoomMirror::take`]); fold_feed.rs and the node's tick do (PRs 6b-1c-ii
//! and iii).
//!
//! HOW IT FOLLOWS THE DOC. One `observe_deep` on the room's `casinoComputed`
//! map notes which paths changed, and nothing else: a watched top-level key
//! (a table's `sum:` and its live `ses:` name) and, under a watched live
//! session, the changed record keys. The callback runs inside the doc's
//! commit, so it does a hash lookup for each changed key and no more; what a
//! peer writes anywhere else (`hs:`, `hk:`, `hf:`, another table, a session
//! that is not the live one) costs it that lookup. A session with more
//! changed keys between two drains than [`MAX_DIRTY_KEYS`] is marked `Many`
//! instead of listing them: the table is read afresh. The drain
//! ([`RoomMirror::drain`], with a read transaction, once a tick) then reads
//! only what changed:
//!
//! - the base: `sum:<t>:<inc>`, kept only if [`checkpoint_ok`] (a checkpoint
//!   the pages throw out is no base: the table is followed from its first
//!   session, as `House::read_table` does); the live session's name is then
//!   `ses:<t>:<inc>:<next_sid>`, and none for an ended incarnation;
//! - the live session map, when it appeared, was replaced or removed: the
//!   table starts over (a RESET: the generation goes up, the queue is
//!   dropped, the whole session is read again, "cold");
//! - the records whose keys changed, each read as the house reads one
//!   ([`read_costed`]): a value every page reads alike goes into the queue,
//!   one heavier than any the pages take ([`MAX_RECORD_BYTES`]), or not a
//!   plain value at all, is junk on every page and so no record at all, and
//!   one a page may read otherwise ([`hb::Clarity`]) HOLDS the table until
//!   it is gone: the fold would be guessing.
//!
//! A table whose base changes starts over too, whatever else changed: the
//! worker's table is opened again from the new base (a trim, a new
//! incarnation).
//!
//! BOUNDED. Reads are charged as the house's are (key + [`VISIT_BYTES`] +
//! the value's weight, [`MAX_RECORD_BYTES`] for a heavy one) to a budget of
//! [`DRAIN_BYTES`] and [`DRAIN_PATHS`] a drain, and what it leaves unread
//! waits for the next drain (a cold read resumes where it stopped, dirty keys
//! stay listed). After a drain that ran short the next starts at the next
//! table, as the house's tick does, so a flood at one table holds the others'
//! no more than a drain in turn. An action bigger than a whole drain
//! (finding out a very heavy checkpoint, taking the key list of a session of
//! the most keys) is admitted when it comes first, and then costs the drain.
//! What a table holds is bounded too: a session of more than
//! [`MAX_SESSION_KEYS`] keys is FLOODED (held: no honest session is, it is
//! trimmed at 20 rounds or 96 KB), whatever the keys are and however it came
//! to have them: a cold read counts them as it lists them, and a change to a
//! key that is no record, or to a value under a record's key that is none,
//! has them counted afresh (charged a visit a key), as do records added to a
//! session known to hold such keys. The changes waiting to be taken stop at
//! [`MAX_PENDING_BYTES`]: past that, reads wait until the caller has taken
//! some, so a stalled worker makes the node wait, not grow; except for a
//! table that is held, from which nothing is taken: its queue is given up
//! then, nothing more is queued, and it starts over (a reset) when nothing
//! holds it. Of a record the mirror keeps its key and its weight; its value
//! is in the queue until taken, and a table that must be sent again is read
//! again from the doc.
//!
//! WHAT THE CALLER CAN RELY ON, after a drain that ran short of nothing (a
//! table that [`RoomMirror::current`]): the changes taken since the table's
//! last reset (the first take after it says so, with the base), applied to an
//! empty session, are the records of the live session as the doc holds them
//! at that drain, less the ones that are held or junk; and `version` is
//! higher than at any drain that saw something else. The mirror never decides
//! anything: whether a record counts, what a round came to, is the fold's.
//!
//! The room's doc is read only inside `drain`, with the transaction the
//! caller passes (the house tick's own, or another): [`RoomMirror::attach`]
//! is called with no transaction open on the doc.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use yrs::types::{DeepObservable, Event, Events, PathSegment};
use yrs::{Doc, Map, MapRef, Out, ReadTxn, Subscription, TransactionMut};

use crate::house::{checkpoint_ok, parse_key, read_costed, Read, COMPUTED_MAP, MAX_KEY_BYTES, MAX_RECORD_BYTES, MAX_SESSION_KEYS, READ_PER_TICK, VISIT_BYTES};
use crate::house_bytes::{self as hb, CVal, Ctx};

/// What a drain reads of a room, charged as the house's tick charges its own
/// reads ([`READ_PER_TICK`]): about the 20 ms the house may hold a doc for.
pub const DRAIN_BYTES: usize = READ_PER_TICK;
/// The changed paths (and cold-read keys) a drain looks at, whatever they weigh.
pub const DRAIN_PATHS: usize = 4_096;
/// The changed record keys of one live session the mirror lists between two
/// drains. Past it the session is read afresh. (Honest sessions change a
/// few dozen keys a tick.)
pub const MAX_DIRTY_KEYS: usize = 2_048;
/// The changes of a table waiting to be taken (their keys and weights) stop
/// being read at this; the caller's `take` makes room.
pub const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;

/// The limits, apart so tests can make them small.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub drain_bytes: usize,
    pub drain_paths: usize,
    pub dirty_keys: usize,
    pub pending_bytes: usize,
    pub session_keys: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { drain_bytes: DRAIN_BYTES, drain_paths: DRAIN_PATHS, dirty_keys: MAX_DIRTY_KEYS, pending_bytes: MAX_PENDING_BYTES, session_keys: MAX_SESSION_KEYS }
    }
}

// ── What the observer notes ──────────────────────────────────────────────────

/// What stands in the changed keys for those too long to be copied: a key no
/// record goes under.
const ODD_KEY: &str = "\u{0}";

/// What changed since the last drain took it, by watched name.
#[derive(Default)]
struct Dirt {
    /// Watched top-level keys (`sum:` names, live `ses:` names).
    tops: BTreeSet<String>,
    /// Changed record keys of a watched live session.
    recs: BTreeMap<String, Recs>,
}

enum Recs {
    Keys(BTreeSet<String>),
    /// More than the limit: read the session afresh.
    Many,
}

impl Dirt {
    fn merge(&mut self, other: Dirt, limit: usize) {
        self.tops.extend(other.tops);
        for (name, recs) in other.recs {
            match (self.recs.get_mut(&name), recs) {
                (None, recs) => {
                    self.recs.insert(name, recs);
                }
                (Some(Recs::Many), _) => {}
                (Some(slot), Recs::Many) => *slot = Recs::Many,
                (Some(Recs::Keys(mine)), Recs::Keys(theirs)) => {
                    mine.extend(theirs);
                    if mine.len() > limit {
                        self.recs.insert(name, Recs::Many);
                    }
                }
            }
        }
    }
}

/// The names the observer watches, and what it has noted of them.
#[derive(Default)]
struct Watch {
    names: HashSet<String>,
    dirt: Dirt,
}

fn lock(m: &Mutex<Watch>) -> MutexGuard<'_, Watch> {
    // (A callback that panicked left it as it was: nothing in it is half-written.)
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The observer's callback. It runs inside the doc's commit: a lookup for
/// each key that changed, and a key kept only if it is watched.
fn note(shared: &Mutex<Watch>, limit: usize, txn: &TransactionMut, events: &Events) {
    let mut w = lock(shared);
    if w.names.is_empty() {
        return;
    }
    let Watch { names, dirt } = &mut *w;
    for event in events.iter() {
        let Event::Map(map) = event else { continue };
        let path = map.path();
        match path.len() {
            0 => {
                for (key, _) in map.keys(txn).iter() {
                    if names.contains(&**key) {
                        dirt.tops.insert(key.to_string());
                    }
                }
            }
            1 => {
                let Some(PathSegment::Key(name)) = path.front() else { continue };
                // (A record is a plain value: only a session map holds any.)
                if !name.starts_with("ses:") || !names.contains(&**name) {
                    continue;
                }
                let slot = dirt.recs.entry(name.to_string()).or_insert_with(|| Recs::Keys(BTreeSet::new()));
                let mut many = false;
                if let Recs::Keys(set) = slot {
                    for (key, _) in map.keys(txn).iter() {
                        // (A key longer than any record's is no record's, and
                        // is not copied: that one changed is noted, as a key
                        // that is no record's, so that the session's keys are
                        // counted.)
                        let key: &str = if key.len() > MAX_KEY_BYTES { ODD_KEY } else { key };
                        if set.len() >= limit && !set.contains(key) {
                            many = true;
                            break;
                        }
                        set.insert(key.to_string());
                    }
                }
                if many {
                    *slot = Recs::Many;
                }
            }
            _ => {}
        }
    }
}

// ── A drain's budget ─────────────────────────────────────────────────────────

struct Budget {
    bytes: usize,
    paths: usize,
    /// Nothing charged yet: the one case an action bigger than the whole
    /// budget is admitted (and then costs what is left).
    fresh: bool,
    spent: bool,
    used_bytes: usize,
    used_paths: usize,
}

impl Budget {
    fn new(bytes: usize, paths: usize) -> Budget {
        Budget { bytes, paths, fresh: true, spent: false, used_bytes: 0, used_paths: 0 }
    }

    fn charge(&mut self, n: usize) -> bool {
        if self.spent {
            return false;
        }
        if n <= self.bytes {
            self.bytes -= n;
            self.used_bytes = self.used_bytes.saturating_add(n);
            self.fresh = false;
            return true;
        }
        if self.fresh {
            self.used_bytes = self.used_bytes.saturating_add(self.bytes);
            self.bytes = 0;
            self.fresh = false;
            return true;
        }
        self.bytes = 0;
        self.spent = true;
        false
    }

    fn path(&mut self) -> bool {
        if self.spent {
            return false;
        }
        if self.paths == 0 {
            self.spent = true;
            return false;
        }
        self.paths -= 1;
        self.used_paths += 1;
        true
    }
}

// ── One table ────────────────────────────────────────────────────────────────

/// What `sum:` held, as the house reads it.
#[derive(Clone, Debug, PartialEq)]
enum Base {
    /// No checkpoint (none there, or one the pages throw out).
    Absent,
    Cp(CVal),
    /// One the node can't read as a page does (heavier than a drain reads, or
    /// one a page may read otherwise): the table waits.
    Held,
}

/// Whether two readings of `sum:` are the same checkpoint. A checkpoint is
/// written again as it was (a peer's page puts it back) and a doc keeps a
/// map's fields in no order, so two readings of one are compared by their
/// canonical bytes, not field by field in the order they came.
fn same_base(a: &Base, b: &Base) -> bool {
    match (a, b) {
        (Base::Absent, Base::Absent) | (Base::Held, Base::Held) => true,
        (Base::Cp(x), Base::Cp(y)) => matches!((hb::canon(x), hb::canon(y)), (Some(x), Some(y)) if x == y),
        _ => false,
    }
}

/// Why a table is not followed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hold {
    /// The checkpoint can't be read as a page reads it.
    Base,
    /// A record of the live session can't be read as a page reads it.
    Unclear,
    /// The live session holds more keys than any honest one.
    Flooded,
}

struct Cold {
    keys: Vec<String>,
    next: usize,
}

struct Table {
    ctx: Ctx,
    sum_name: String,
    /// The base is still to be read (a new table).
    read_base: bool,
    /// It has been read once.
    based: bool,
    base: Base,
    /// The live session's name, when the base lets one be named.
    live: Option<String>,
    /// The live session map is still to be looked for (and its keys listed).
    need_session: bool,
    present: bool,
    flooded: bool,
    /// The records of the live session that are, or will be once taken, in
    /// the worker's table: key → weight.
    keys: HashMap<String, usize>,
    /// Records a page may read otherwise.
    unclear: HashSet<String>,
    /// Changes not yet taken: the latest per key, and what each weighs.
    queue: BTreeMap<String, (Option<CVal>, usize)>,
    queue_bytes: usize,
    cold: Option<Cold>,
    /// Something in the live session that is no record changed (a key no
    /// record goes under, a value under a record's key that reads as nothing
    /// or too heavy), or the keys may be more than the most: its keys are to
    /// be counted afresh, as a cold read counts them, for the most.
    recount: bool,
    /// The keys of the live session that are not records the mirror keeps, as
    /// last counted (a count only grows by a change that sets `recount`, so
    /// the keys kept and these are never fewer than the session's, until a
    /// count says).
    extra: usize,
    /// The table was held and its queue full: nothing can be taken from a
    /// held table, so the queue was given up and no more kept. The table
    /// starts over when nothing holds it.
    stale: bool,
    /// Not yet said (by a `take`) that the table started over.
    announce: bool,
    generation: u64,
    version: u64,
}

fn cval_bytes(v: &CVal) -> usize {
    match v {
        CVal::Str(s) => s.len() + 2,
        CVal::Arr(a) => a.iter().fold(2, |n, x| n + 1 + cval_bytes(x)),
        CVal::Obj(f) => f.iter().fold(2, |n, (k, x)| n + k.len() + 4 + cval_bytes(x)),
        CVal::Int(_) | CVal::Undef | CVal::Junk => 8,
    }
}

impl Table {
    fn new(ctx: Ctx) -> Table {
        let sum_name = format!("sum:{}:{}", ctx.t, ctx.inc);
        Table {
            ctx,
            sum_name,
            read_base: true,
            based: false,
            base: Base::Absent,
            live: None,
            need_session: false,
            present: false,
            flooded: false,
            keys: HashMap::new(),
            unclear: HashSet::new(),
            queue: BTreeMap::new(),
            queue_bytes: 0,
            cold: None,
            recount: false,
            extra: 0,
            stale: false,
            announce: true,
            generation: 0,
            version: 0,
        }
    }

    fn ended(&self) -> bool {
        matches!(&self.base, Base::Cp(cp) if cp.get("e").is_some())
    }

    fn hold(&self) -> Option<Hold> {
        if self.base == Base::Held {
            Some(Hold::Base)
        } else if self.flooded {
            Some(Hold::Flooded)
        } else if !self.unclear.is_empty() {
            Some(Hold::Unclear)
        } else {
            None
        }
    }

    /// The table starts over: nothing of the session is known.
    fn reset(&mut self) {
        self.generation += 1;
        self.version += 1;
        self.keys.clear();
        self.unclear.clear();
        self.queue.clear();
        self.queue_bytes = 0;
        self.cold = None;
        self.present = false;
        self.flooded = false;
        self.recount = false;
        self.extra = 0;
        self.stale = false;
        self.need_session = self.live.is_some();
        self.announce = true;
    }

    fn set_base(&mut self, new: Base) {
        if self.based && same_base(&new, &self.base) {
            return;
        }
        self.based = true;
        self.base = new;
        self.live = match &self.base {
            Base::Absent => hb::next_sid(&self.ctx, None),
            Base::Cp(cp) if cp.get("e").is_none() => hb::next_sid(&self.ctx, Some(cp)),
            _ => None,
        }
        .map(|sid| format!("ses:{}:{}:{sid}", self.ctx.t, self.ctx.inc));
        self.reset();
    }

    /// Too many keys: held until the table starts over.
    fn flood(&mut self) {
        self.reset();
        self.flooded = true;
        self.need_session = false;
        self.present = true;
    }

    fn put(&mut self, key: &str, value: Option<CVal>) {
        let size = key.len() + value.as_ref().map_or(0, cval_bytes);
        match &value {
            Some(_) => {
                self.keys.insert(key.to_string(), size);
            }
            None => {
                self.keys.remove(key);
            }
        }
        self.version += 1;
        // (The table starts over before anything is taken: what is queued
        // would be read again.)
        if self.stale {
            return;
        }
        if let Some((_, old)) = self.queue.insert(key.to_string(), (value, size)) {
            self.queue_bytes -= old;
        }
        self.queue_bytes += size;
    }

    /// A record's key and what it reads as.
    fn record(&mut self, key: &str, read: Read, session_keys: usize) {
        match read {
            Read::Val(v) => {
                self.unclear.remove(key);
                self.put(key, Some(v));
            }
            Read::Unclear(..) => {
                let was = self.keys.contains_key(key);
                if was {
                    self.put(key, None);
                }
                if self.unclear.insert(key.to_string()) && !was {
                    self.version += 1;
                }
            }
            // (Junk on every page, or nothing there: no record.)
            Read::Absent | Read::Heavy => {
                let was_unclear = self.unclear.remove(key);
                if self.keys.contains_key(key) {
                    self.put(key, None);
                } else if was_unclear {
                    self.version += 1;
                }
            }
            Read::Spent => {}
        }
        let kept = self.keys.len() + self.unclear.len();
        if kept > session_keys {
            self.flood();
            return;
        }
        // (Keys the mirror does not keep are in the session too: past the
        // most with them, the count says.)
        if kept.saturating_add(self.extra) > session_keys {
            self.recount = true;
        }
        if self.stale && self.unclear.is_empty() {
            // (Nothing holds the table now, and what it was sent was given up.)
            self.reset();
        }
    }

    fn room_for_a_record(&self, limits: &Limits) -> bool {
        self.queue_bytes.saturating_add(MAX_RECORD_BYTES) <= limits.pending_bytes
    }

    /// Whether another record may be read. A full queue waits for the caller
    /// to take; but nothing is taken from a table that is held, and the record
    /// that holds it may be waiting to be read: the queue is given up then,
    /// and the table starts over once it is followed again.
    fn may_read(&mut self, limits: &Limits) -> bool {
        if self.stale || self.room_for_a_record(limits) {
            return true;
        }
        if self.hold().is_none() {
            return false;
        }
        self.queue.clear();
        self.queue_bytes = 0;
        self.stale = true;
        self.version += 1;
        true
    }

    /// Read one record of the live session, as the house reads one.
    /// False when the drain's budget is spent first.
    /// `changed`: the key is one the doc changed (not one listed by a cold
    /// read, whose keys are counted as they are listed).
    fn read_record<T: ReadTxn>(&mut self, ses: &MapRef, txn: &T, key: &str, changed: bool, b: &mut Budget, limits: &Limits) -> bool {
        // (A key no record goes under: nothing to read, and nothing to tell,
        // but it is a key of the session.)
        if key.len() > MAX_KEY_BYTES || !hb::utf8(key) || parse_key(key).is_none() {
            self.recount |= changed;
            return true;
        }
        let out = ses.get(txn, key);
        let there = out.is_some();
        let read = read_costed(|n| b.charge(n), key.len(), out, MAX_RECORD_BYTES);
        if matches!(read, Read::Spent) {
            return false;
        }
        // (A value that is no record is a key of the session as well.)
        if there && matches!(read, Read::Absent | Read::Heavy) {
            if changed {
                self.recount = true;
            } else {
                self.extra += 1;
            }
        }
        self.record(key, read, limits.session_keys);
        true
    }

    /// Count the live session's keys afresh, up to the most and one: more than
    /// the most holds it, as a cold read's list does. False when the budget
    /// is spent first.
    fn count_keys<T: ReadTxn>(&mut self, ses: &MapRef, txn: &T, b: &mut Budget, limits: &Limits) -> bool {
        if !b.path() {
            return false;
        }
        let n = ses.keys(txn).take(limits.session_keys.saturating_add(1)).count();
        if !b.charge(n.saturating_mul(VISIT_BYTES)) {
            return false;
        }
        self.recount = false;
        if n > limits.session_keys {
            self.flood();
        } else {
            self.extra = n.saturating_sub(self.keys.len() + self.unclear.len());
        }
        true
    }

    /// List the live session's keys (cold). False when the budget is spent.
    fn snapshot<T: ReadTxn>(&mut self, ses: &MapRef, txn: &T, b: &mut Budget, limits: &Limits) -> bool {
        let mut names = Vec::new();
        let mut cost = 0usize;
        let mut seen = 0usize;
        let mut flooded = false;
        for key in ses.keys(txn) {
            seen += 1;
            if seen > limits.session_keys {
                flooded = true;
                break;
            }
            cost = cost.saturating_add(VISIT_BYTES);
            if key.len() <= MAX_KEY_BYTES {
                cost = cost.saturating_add(key.len());
                if hb::utf8(key) && parse_key(key).is_some() {
                    names.push(key.to_string());
                }
            }
        }
        if !b.charge(cost) {
            return false;
        }
        if flooded {
            self.flood();
            return true;
        }
        names.sort();
        self.extra = seen - names.len();
        self.cold = Some(Cold { keys: names, next: 0 });
        self.present = true;
        self.need_session = false;
        true
    }

    /// Bring the table up to the doc, as far as the budget goes. False when
    /// the budget is spent.
    fn step<T: ReadTxn>(&mut self, pending: &mut Dirt, comp: Option<&MapRef>, txn: &T, b: &mut Budget, limits: &Limits) -> bool {
        // The base.
        if self.read_base || pending.tops.contains(&self.sum_name) {
            if !b.path() {
                return false;
            }
            let out = comp.and_then(|c| c.get(txn, &self.sum_name));
            // (As the house reads it: a checkpoint is read up to what a tick may read.)
            let new = match read_costed(|n| b.charge(n), self.sum_name.len(), out, READ_PER_TICK) {
                Read::Spent => return false,
                Read::Val(v) if checkpoint_ok(&v, &self.ctx.inc) => Base::Cp(v),
                Read::Val(_) | Read::Absent => Base::Absent,
                // (One a page may take as read, or as junk: held if it is a
                // checkpoint as read, no base if it is none either way.)
                Read::Unclear(v, hb::Clarity::Proto) => {
                    if checkpoint_ok(&v, &self.ctx.inc) {
                        Base::Held
                    } else {
                        Base::Absent
                    }
                }
                Read::Unclear(..) | Read::Heavy => Base::Held,
            };
            pending.tops.remove(&self.sum_name);
            self.read_base = false;
            self.set_base(new);
        }
        let Some(live) = self.live.clone() else { return true };

        // The live session: made, replaced or removed.
        if pending.tops.remove(&live) && !self.need_session {
            self.reset();
        }
        // (A session found flooded stays so until it is replaced: what is
        // written to it meanwhile is not followed.)
        if self.flooded {
            pending.recs.remove(&live);
            return true;
        }
        if matches!(pending.recs.get(&live), Some(Recs::Many)) {
            pending.recs.remove(&live);
            if !self.need_session {
                self.reset();
            }
        }
        let ses = match comp.and_then(|c| c.get(txn, &live)) {
            Some(Out::YMap(m)) => Some(m),
            _ => None,
        };
        if self.need_session {
            if !b.path() {
                return false;
            }
            match &ses {
                None => self.need_session = false,
                Some(ses) => {
                    if !self.snapshot(ses, txn, b, limits) {
                        return false;
                    }
                    // (What changed before the list was taken, it holds.)
                    pending.recs.remove(&live);
                }
            }
        }
        let Some(ses) = ses.filter(|_| self.present && !self.flooded) else { return true };

        // The records that changed.
        let generation = self.generation;
        if let Some(Recs::Keys(set)) = pending.recs.get_mut(&live) {
            while let Some(key) = set.pop_first() {
                if !self.may_read(limits) {
                    set.insert(key);
                    return true;
                }
                if !b.path() || !self.read_record(&ses, txn, &key, true, b, limits) {
                    set.insert(key);
                    return false;
                }
                // (Flooded, or started over: the rest of what changed was of
                // the session before, and the session is listed afresh.)
                if self.flooded || self.generation != generation {
                    break;
                }
            }
            if set.is_empty() || self.flooded {
                pending.recs.remove(&live);
            }
        }
        if self.flooded {
            return true;
        }
        if self.recount && !self.count_keys(&ses, txn, b, limits) {
            return false;
        }
        if self.flooded {
            return true;
        }

        // The rest of the cold read.
        while let Some(key) = self.cold.as_ref().and_then(|c| c.keys.get(c.next).cloned()) {
            if !self.may_read(limits) {
                return true;
            }
            if !b.path() || !self.read_record(&ses, txn, &key, false, b, limits) {
                return false;
            }
            if self.flooded {
                return true;
            }
            if let Some(c) = self.cold.as_mut() {
                c.next += 1;
            }
        }
        self.cold = None;
        true
    }
}

// ── The room ─────────────────────────────────────────────────────────────────

/// What a drain did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Drained {
    /// Charged to the drain's budget (reads, by weight).
    pub bytes: usize,
    pub paths: usize,
    /// The budget ran out: something is left for the next drain.
    pub short: bool,
}

/// Where a table stands.
#[derive(Clone, Debug)]
pub struct State<'a> {
    /// The checkpoint the live session follows (None: no checkpoint).
    pub base: Option<&'a CVal>,
    /// The live session's name.
    pub live: Option<&'a str>,
    pub hold: Option<Hold>,
    pub ended: bool,
    /// The base has been read.
    pub settled: bool,
    /// The live session map is in the doc.
    pub present: bool,
    /// The session is still being read.
    pub reading: bool,
    /// Changes waiting to be taken, and their weight.
    pub queued: usize,
    pub queued_bytes: usize,
    /// Goes up when the table starts over.
    pub generation: u64,
    /// Goes up with every change to the base, a record or the hold.
    pub version: u64,
}

impl State<'_> {
    /// There is a live session to follow, and nothing holds it.
    pub fn serving(&self) -> bool {
        self.settled && self.present && !self.ended && self.hold.is_none()
    }
}

/// What [`RoomMirror::take`] hands over.
#[derive(Debug, PartialEq)]
pub struct Taken {
    /// The table started over since the last take: the worker's table is
    /// opened afresh on `base`, and `changes` (and those after) are all of
    /// its session.
    pub reset: bool,
    pub base: Option<CVal>,
    /// (record key, its value; None: gone), in key order.
    pub changes: Vec<(String, Option<CVal>)>,
    /// More is waiting (taken in the next call).
    pub more: bool,
    pub generation: u64,
    pub version: u64,
}

pub struct RoomMirror {
    room: String,
    shared: Arc<Mutex<Watch>>,
    _sub: Subscription,
    tables: BTreeMap<(String, String), Table>,
    /// Dirt the drains have not got to.
    pending: Dirt,
    limits: Limits,
    turn: usize,
    resets: u64,
}

impl RoomMirror {
    /// Watch `doc`'s `casinoComputed` map. No table is mirrored until
    /// [`want`](RoomMirror::want). Call it with no transaction open on `doc`.
    pub fn attach(doc: &Doc, room: &str) -> RoomMirror {
        RoomMirror::attach_with(doc, room, Limits::default())
    }

    pub fn attach_with(doc: &Doc, room: &str, limits: Limits) -> RoomMirror {
        let comp = doc.get_or_insert_map(COMPUTED_MAP);
        let shared = Arc::new(Mutex::new(Watch::default()));
        let cb = shared.clone();
        let dirty = limits.dirty_keys;
        let sub = comp.observe_deep(move |txn, events| note(&cb, dirty, txn, events));
        RoomMirror { room: room.to_string(), shared, _sub: sub, tables: BTreeMap::new(), pending: Dirt::default(), limits, turn: 0, resets: 0 }
    }

    /// Mirror these tables, `(t, inc)`, and no others. The ones dropped are
    /// returned, for the worker to forget.
    pub fn want(&mut self, tables: &[(String, String)]) -> Vec<Ctx> {
        let keep: BTreeSet<&(String, String)> = tables.iter().collect();
        let gone: Vec<Ctx> = self.tables.iter().filter(|(k, _)| !keep.contains(k)).map(|(_, t)| t.ctx.clone()).collect();
        self.tables.retain(|k, _| keep.contains(k));
        for (t, inc) in tables {
            let room = &self.room;
            self.tables.entry((t.clone(), inc.clone())).or_insert_with(|| Table::new(Ctx { room: room.clone(), t: t.clone(), inc: inc.clone() }));
        }
        self.sync_watch();
        self.sweep();
        gone
    }

    /// The tables mirrored.
    pub fn tables(&self) -> impl Iterator<Item = &Ctx> {
        self.tables.values().map(|t| &t.ctx)
    }

    /// Bring every table up to the doc, as far as this drain's budget goes.
    pub fn drain<T: ReadTxn>(&mut self, txn: &T) -> Drained {
        let noted = std::mem::take(&mut lock(&self.shared).dirt);
        self.pending.merge(noted, self.limits.dirty_keys);
        let comp = txn.get_map(COMPUTED_MAP);
        let mut budget = Budget::new(self.limits.drain_bytes, self.limits.drain_paths);
        let keys: Vec<(String, String)> = self.tables.keys().cloned().collect();
        let mut short = false;
        let mut resets = 0;
        for i in 0..keys.len() {
            let key = &keys[self.turn.wrapping_add(i) % keys.len()];
            let Some(table) = self.tables.get_mut(key) else { continue };
            let was = table.generation;
            let done = table.step(&mut self.pending, comp.as_ref(), txn, &mut budget, &self.limits);
            resets += (table.generation - was) as usize;
            if !done {
                short = true;
                break;
            }
        }
        self.resets += resets as u64;
        if short {
            self.turn = self.turn.wrapping_add(1);
        }
        self.sync_watch();
        self.sweep();
        Drained { bytes: budget.used_bytes, paths: budget.used_paths, short }
    }

    /// Resets of tables since the start (a table's first read counts).
    pub fn resets(&self) -> u64 {
        self.resets
    }

    /// The names the observer watches: each table's `sum:`, and its live session.
    fn sync_watch(&mut self) {
        let names: HashSet<String> = self.tables.values().flat_map(|t| [Some(t.sum_name.clone()), t.live.clone()]).flatten().collect();
        lock(&self.shared).names = names;
    }

    /// Forget dirt that names nothing watched any more.
    fn sweep(&mut self) {
        let names = lock(&self.shared).names.clone();
        self.pending.tops.retain(|n| names.contains(n));
        self.pending.recs.retain(|n, _| names.contains(n));
    }

    pub fn state(&self, t: &str, inc: &str) -> Option<State<'_>> {
        let tb = self.tables.get(&(t.to_string(), inc.to_string()))?;
        Some(State {
            base: match &tb.base {
                Base::Cp(cp) => Some(cp),
                _ => None,
            },
            live: tb.live.as_deref(),
            hold: tb.hold(),
            ended: tb.ended(),
            settled: tb.based,
            present: tb.present,
            reading: tb.cold.is_some() || tb.need_session,
            queued: tb.queue.len(),
            queued_bytes: tb.queue_bytes,
            generation: tb.generation,
            version: tb.version,
        })
    }

    /// The mirror has read everything of the table that the doc has changed
    /// (as of the last drain): nothing of it is waiting to be read.
    pub fn current(&self, t: &str, inc: &str) -> bool {
        let Some(tb) = self.tables.get(&(t.to_string(), inc.to_string())) else { return false };
        if !tb.based || tb.read_base || tb.need_session || tb.cold.is_some() || tb.recount || self.pending.tops.contains(&tb.sum_name) {
            return false;
        }
        match &tb.live {
            Some(live) => !self.pending.tops.contains(live) && !self.pending.recs.contains_key(live) && lock(&self.shared).dirt.is_clear_of(live, &tb.sum_name),
            None => lock(&self.shared).dirt.is_clear_of("", &tb.sum_name),
        }
    }

    /// Hand over the changes of a table that is [`State::serving`], about
    /// `max_bytes` of them at most (the first change always goes). None for
    /// a table that is not mirrored or is not serving.
    pub fn take(&mut self, t: &str, inc: &str, max_bytes: usize) -> Option<Taken> {
        let tb = self.tables.get_mut(&(t.to_string(), inc.to_string()))?;
        if !(tb.based && tb.present && !tb.ended() && tb.hold().is_none()) {
            return None;
        }
        let mut changes = Vec::new();
        let mut bytes = 0usize;
        while let Some((key, (value, size))) = tb.queue.pop_first() {
            tb.queue_bytes -= size;
            bytes = bytes.saturating_add(size);
            changes.push((key, value));
            if bytes >= max_bytes {
                break;
            }
        }
        let reset = std::mem::take(&mut tb.announce);
        let base = match &tb.base {
            Base::Cp(cp) => Some(cp.clone()),
            _ => None,
        };
        Some(Taken { reset, base, changes, more: !tb.queue.is_empty(), generation: tb.generation, version: tb.version })
    }
}

impl Dirt {
    /// Nothing is noted of these names.
    fn is_clear_of(&self, live: &str, sum: &str) -> bool {
        !self.tops.contains(sum) && !self.tops.contains(live) && !self.recs.contains_key(live)
    }
}

#[cfg(test)]
mod tests;
