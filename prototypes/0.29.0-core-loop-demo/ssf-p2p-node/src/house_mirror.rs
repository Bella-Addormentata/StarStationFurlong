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
//! The drain's time is looked at between actions, and within a scan of a
//! session's keys (the list, the count) every [`SCAN_CHECK_KEYS`] keys, when the
//! drain has done another action before it: a scan given up is made again from
//! its start by the next drain, which begins with it and so reads it to its end.
//! What a table holds is bounded too: a session of more than
//! [`MAX_SESSION_KEYS`] keys is FLOODED (held: no honest session is, it is
//! trimmed at 20 rounds or 96 KB), whatever the keys are and however it came
//! to have them: a cold read counts them as it lists them, and a change to a
//! key that is no record, or to a value under a record's key that is none,
//! has them counted afresh (charged a visit a key), as do records added to a
//! session known to hold such keys. The changes waiting to be taken stop at
//! [`MAX_PENDING_BYTES`]: past that, reads wait until the caller has taken
//! some (a record is reckoned at [`MAX_QUEUED_RECORD`] before it is read, so
//! the queue never passes its cap), so a stalled worker makes the node wait,
//! not grow; except for a
//! table that is held, from which nothing is taken: its queue is given up
//! then, nothing more is queued, and it starts over (a reset) when nothing
//! holds it. Of a record the mirror keeps its key and its weight; its value
//! is in the queue until taken, and a table that must be sent again is read
//! again from the doc.
//!
//! WHAT IT CANNOT SEE, AND TELLS. A page's history is not all in the doc: an update that made a block and deleted it
//! (a record written and written over, a session made and trimmed, a delegation made and withdrawn) arrives with no
//! trace of it but that something was made and deleted in it ([`made_and_deleted`]), not what or where, and a record
//! removed or replaced in a live session is a history a page that never saw it does not share. The mirror says so,
//! and decides nothing of it: [`Delegations`] (changes, `churned` for good, and `hidden`, the updates that may have
//! hidden one beside the keys they show), a session whose trim is read as `unread_at_trim` (records made and deleted in
//! it, or removed or replaced in it, or the session itself removed in such an update), and the signers of the slips a
//! session held ([`RoomMirror::take_ended_signers`], told once the session has ended), which the shadow reads against
//! the pins it was given.
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
use std::time::{Duration, Instant};

use yrs::types::{DeepObservable, EntryChange, Event, Events, PathSegment};
use yrs::{Doc, Map, MapRef, Out, ReadTxn, Subscription, TransactionMut};

use crate::house::{checkpoint_ok, parse_key, read_costed, Read, COMPUTED_MAP, MAX_KEY_BYTES, MAX_RECORD_BYTES, MAX_SESSION_KEYS, MAX_TOP_BYTES, READ_PER_TICK, VISIT_BYTES};
use crate::house_bytes::{self as hb, CVal, Ctx};

/// What a drain reads of a room, charged as the house's tick charges its own
/// reads ([`READ_PER_TICK`]): about the 20 ms the house may hold a doc for.
pub const DRAIN_BYTES: usize = READ_PER_TICK;
/// The changed paths (and cold-read keys) a drain looks at, whatever they weigh.
pub const DRAIN_PATHS: usize = 4_096;
/// How long a drain may hold the doc for the node's own pass ([`Limits::live`]): what is left waits for the next.
/// The weights above bound what a drain reads; this bounds the time it takes, whatever the doc's size makes of it, for
/// the house's tick waits for the doc's write lock behind a read held here, with the house's own lock held.
pub const DRAIN_TIME: Duration = Duration::from_millis(20);
/// The changed record keys of one live session the mirror lists between two
/// drains. Past it the session is read afresh. (Honest sessions change a
/// few dozen keys a tick.)
pub const MAX_DIRTY_KEYS: usize = 2_048;
/// The most a checkpoint weighs ([`hb::weigh`]) for the observer to tell it written again as it stands from another:
/// the observer runs in the commit of the doc, so what it compares is bounded, and a heavier one is another.
pub const ALIKE_SUM_BYTES: usize = 256 * 1024;
/// The most (player, signing key) pairs of a session's slips the mirror keeps for a table, to tell the shadow which keys
/// signed what a session held ([`RoomMirror::take_ended_signers`]): an honest table has a few, and a session of more
/// is not told, so that nothing counted of it is believed.
pub const MAX_SIGNERS: usize = 512;
/// The changes of a table waiting to be taken (their keys and weights) stop
/// being read at this; the caller's `take` makes room.
pub const MAX_PENDING_BYTES: usize = 16 * 1024 * 1024;
/// The most a record weighs in the queue, key and value as the mirror holds
/// them: a record the house reads weighs at most [`MAX_RECORD_BYTES`] as the
/// pages weigh it, and what a page reads as junk is held at 9 bytes where it
/// weighs 3 (a buffer in an array), so three times that, and a key.
pub const MAX_QUEUED_RECORD: usize = 3 * MAX_RECORD_BYTES + MAX_KEY_BYTES;

/// The limits, apart so tests can make them small.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub drain_bytes: usize,
    pub drain_paths: usize,
    pub dirty_keys: usize,
    pub pending_bytes: usize,
    pub session_keys: usize,
    /// A drain stops, as if it had spent its budget, once it has done something and this has passed
    /// (None: no limit of time, as in the tests, where a slow machine must not change what a drain does).
    pub drain_time: Option<Duration>,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits { drain_bytes: DRAIN_BYTES, drain_paths: DRAIN_PATHS, dirty_keys: MAX_DIRTY_KEYS, pending_bytes: MAX_PENDING_BYTES, session_keys: MAX_SESSION_KEYS, drain_time: None }
    }
}

impl Limits {
    /// The limits of the node itself: the defaults, and a drain that takes no longer than [`DRAIN_TIME`].
    pub fn live() -> Limits {
        Limits { drain_time: Some(DRAIN_TIME), ..Limits::default() }
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
    /// Checkpoints (`sum:` names) that changed in a transaction after which the doc held updates it could
    /// not apply yet, for want of something another peer wrote (a page's trim that deleted records this node
    /// has not been sent: what it deleted is more than this node has read, and may be more than it will), or in
    /// which something was made and deleted (records and the trim that deleted them, sent together).
    lagged: BTreeSet<String>,
    /// How many times each watched checkpoint (`sum:` name) was written (a value set that was not the one standing,
    /// as [`rewritten_alike`] tells) since the table last read it: all but the one the drain reads were written over
    /// before it could.
    writes: BTreeMap<String, u64>,
    /// Live sessions (`ses:` names) that something was made and deleted in, in one transaction: a record that came and
    /// went before the node could read it. Nothing says which record, or leaves one to read, and a page that saw it
    /// without its deletion counts it in the next checkpoint it writes: the table keeps this until that checkpoint
    /// ([`Table::suspect`]).
    suspect: BTreeSet<String>,
}

enum Recs {
    Keys(BTreeSet<String>),
    /// More than the limit: read the session afresh.
    Many,
}

impl Dirt {
    /// Record keys of the session `live` are noted.
    fn has_recs(&self, live: &str) -> bool {
        match self.recs.get(live) {
            Some(Recs::Many) => true,
            Some(Recs::Keys(keys)) => !keys.is_empty(),
            None => false,
        }
    }

    fn merge(&mut self, other: Dirt, limit: usize) {
        self.tops.extend(other.tops);
        self.lagged.extend(other.lagged);
        self.suspect.extend(other.suspect);
        for (name, n) in other.writes {
            let at = self.writes.entry(name).or_insert(0);
            *at = at.saturating_add(n);
        }
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
    delegations: Delegations,
}

/// What the observer has seen of the room's delegations (`hk:<house>`), whether or not a table is watched.
#[derive(Default, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Delegations {
    /// Moves with every change to one (and with every update to the map in which something was made and deleted:
    /// [`Delegations::hidden`]).
    pub changes: u64,
    /// One was replaced or removed: a page that had seen it may count a house this node's plan, which learns a
    /// delegation when a record names the house, cannot know of. (Also one made and deleted that the doc shows no
    /// trace of, in an update to the map that changed nothing the node could read.)
    pub churned: bool,
    /// How many updates to the map may have hidden a delegation made and deleted in them: one in which something was
    /// made and deleted (the transaction does not say what or where, and the keys it shows do not say that none was a
    /// delegation), or that left no key to read. A page that saw the delegation counted the house it names, in the
    /// sessions that were in the room then, and the node never will.
    pub hidden: u64,
}

fn lock(m: &Mutex<Watch>) -> MutexGuard<'_, Watch> {
    // (A callback that panicked left it as it was: nothing in it is half-written.)
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether this transaction deleted a block it also made: something that came to the doc and went in one
/// transaction, so that nothing was ever there for the node to read. A page's records of a live session and its trim,
/// which deletes them, can come in one update (the node was away, or the updates were merged on the way): all of it is
/// integrated, nothing is left waiting, and the records, made in a map that is deleted by the same update, leave no
/// event of their own. What the node never read of the session before the trim is told only by this.
pub(crate) fn made_and_deleted(txn: &TransactionMut) -> bool {
    let before = txn.before_state();
    txn.delete_set().iter().any(|(client, ranges)| {
        let seen = before.get(client);
        ranges.iter().any(|r| r.end > seen)
    })
}

/// Whether a change to a key is the value written again as it stands, which every page reads alike (a value of the
/// doc's plain kind, [`hb::Clarity::Clear`]): the same record under the same key moves nothing.
///
/// This runs in the doc's commit, on values a peer wrote: the new one is weighed first ([`hb::weigh`], up to `cap`), and
/// a value that weighs more, or that a page may read otherwise, is not compared at all and is another. (Two values of
/// one weight are compared at the cost of that weight: lengths first, then members, so the old one costs no more than
/// the new.)
fn rewritten_alike(change: &EntryChange, cap: usize) -> bool {
    let EntryChange::Updated(Out::Any(old), Out::Any(new)) = change else { return false };
    match hb::weigh(new, cap) {
        hb::Weighed::Light { scan, .. } => hb::clarity_within(new, scan, cap) == hb::Clarity::Clear && old == new,
        hb::Weighed::Heavy | hb::Weighed::Unsure => false,
    }
}

/// The observer's callback. It runs inside the doc's commit: a lookup for
/// each key that changed, and a key kept only if it is watched.
fn note(shared: &Mutex<Watch>, limit: usize, txn: &TransactionMut, events: &Events) {
    let mut w = lock(shared);
    let Watch { names, dirt, delegations } = &mut *w;
    // (After this transaction, did the doc lack something it was sent, or was something made and deleted in it? Asked
    // once, when a checkpoint changes.)
    let mut gap = None;
    // (And once, when a delegation is first written: was something made and deleted in this transaction?)
    let mut lost = None;
    for event in events.iter() {
        let Event::Map(map) = event else { continue };
        let path = map.path();
        match path.len() {
            0 => {
                let keys = map.keys(txn);
                // (An update that made a delegation and deleted it, or wrote one and wrote it over, shows no key of it,
                // or shows the last. The map's event has no key to read when that is all it holds (a block made and
                // deleted shows as no change in the map, and an event of the map with no change in it is always one):
                // a delegation may have come and gone, and a page that saw it counted the house it names for as long
                // as the deed holder holds the deed. Nor do the keys it does show say that the update hid none: it
                // says that something was made and deleted in it, and not what or where, and so it is doubted for the
                // sessions in the room, as one that left no key is, but not for good. Counted once for the event.)
                if keys.is_empty() {
                    delegations.changes += 1;
                    delegations.hidden += 1;
                    delegations.churned = true;
                } else if *lost.get_or_insert_with(|| made_and_deleted(txn)) {
                    delegations.changes += 1;
                    delegations.hidden += 1;
                }
                for (key, change) in keys.iter() {
                    // (A delegation written again as it stands, as two pages of the deed holder do when both run its duty
                    // at once, changes nothing: no house comes or goes, and every page reads it alike. One a page may read
                    // otherwise is churn all the same. And so is one that is the same as it was only in the doc this node
                    // is left with: written, written over and put back in one update, as when the node was away and the
                    // updates were merged, it was another on the way, and a page that had that one on its own counted the
                    // house it names. The transaction says that something was made and deleted in it, and not what: an
                    // identical rewrite in such a one is doubted.)
                    if key.starts_with("hk:") && !(rewritten_alike(change, MAX_TOP_BYTES) && !*lost.get_or_insert_with(|| made_and_deleted(txn))) {
                        delegations.changes += 1;
                        // (A delegation that is written and written over in one update, as when the node was away and
                        // the updates were merged, leaves only the last as an insert: a page that had the first
                        // separately may count a house the plan never knew. The transaction says that something was
                        // made and deleted in it, and not what: any insert in such a one is doubted.)
                        if !matches!(change, EntryChange::Inserted(_)) || *lost.get_or_insert_with(|| made_and_deleted(txn)) {
                            delegations.churned = true;
                        }
                    }
                    if names.contains(&**key) {
                        dirt.tops.insert(key.to_string());
                        // (A session made in an update that also made and deleted a record in it: the session is read
                        // afresh and has no trace of that record. And one removed in such an update: a session made
                        // under its name in it and deleted too leaves no trace but the removal of the one the node
                        // held, and a page that saw the one made counted its records. Only a session already watched is
                        // noted: the one a page's trim makes is not yet, and what the same update made and deleted was
                        // in the session it trims, whose removal is noted here, and which the base changing, in the
                        // drain, takes with it.)
                        if key.starts_with("ses:") && *lost.get_or_insert_with(|| made_and_deleted(txn)) {
                            dirt.suspect.insert(key.to_string());
                        }
                        // (A checkpoint set that was not the one standing: a removal is no checkpoint, and a page's put-back
                        // of one is no other.)
                        if key.starts_with("sum:") && !matches!(change, EntryChange::Removed(_)) && !rewritten_alike(change, ALIKE_SUM_BYTES) {
                            let at = dirt.writes.entry(key.to_string()).or_insert(0);
                            *at = at.saturating_add(1);
                        }
                        if key.starts_with("sum:") && *gap.get_or_insert_with(|| txn.store().pending_update().is_some() || txn.store().pending_ds().is_some() || made_and_deleted(txn)) {
                            dirt.lagged.insert(key.to_string());
                        }
                    }
                }
            }
            1 => {
                let Some(PathSegment::Key(name)) = path.front() else { continue };
                // (A record is a plain value: only a session map holds any.)
                if !name.starts_with("ses:") || !names.contains(&**name) {
                    continue;
                }
                // (A record that came and went in one update, as when the node was away and the updates were merged on the
                // way, is no change to this map and leaves no key to read. The transaction says that something was made and
                // deleted in it, and not what or where: the session is doubted.)
                if *lost.get_or_insert_with(|| made_and_deleted(txn)) {
                    dirt.suspect.insert(name.to_string());
                }
                // (A record removed, or replaced by another value under the same key: the keys are the records' hashes,
                // so no page does either, and one a page that has not seen it counts is a history the node does not
                // share: the page's next trim of the session is not held against what the node read. A record written
                // again as it stands is nothing.)
                for (_, change) in map.keys(txn).iter() {
                    let moved = match change {
                        EntryChange::Removed(_) => true,
                        EntryChange::Updated(Out::Any(old), Out::Any(new)) => old != new,
                        EntryChange::Updated(..) => true,
                        EntryChange::Inserted(_) => false,
                    };
                    if moved {
                        dirt.suspect.insert(name.to_string());
                        break;
                    }
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

/// How many keys of a session a scan goes through between looks at the clock.
const SCAN_CHECK_KEYS: usize = 256;

struct Budget {
    bytes: usize,
    paths: usize,
    /// When the drain must stop (once it has done something).
    deadline: Option<Instant>,
    /// Nothing charged yet: the one case an action bigger than the whole
    /// budget is admitted (and then costs what is left).
    fresh: bool,
    spent: bool,
    used_bytes: usize,
    used_paths: usize,
}

impl Budget {
    fn new(bytes: usize, paths: usize, time: Option<Duration>) -> Budget {
        Budget { bytes, paths, deadline: time.map(|t| Instant::now() + t), fresh: true, spent: false, used_bytes: 0, used_paths: 0 }
    }

    /// The time is up: the drain has begun an action before this one, and its deadline has passed. (Asked where an
    /// action begins, not within it, and not before the first: a drain slow to start is not one that never gets
    /// anywhere, and an action is read to its end.)
    fn late(&mut self) -> bool {
        let late = self.used_paths > 0 && self.deadline.is_some_and(|d| Instant::now() >= d);
        if late {
            self.spent = true;
        }
        late
    }

    /// The time is up in the middle of an action: one was done before it in this drain, and the deadline has passed.
    /// (Asked every [`SCAN_CHECK_KEYS`] keys of a scan of a session, which is given up then and begun again by the next
    /// drain; and not within the first action of a drain, which is read to its end, so that every drain gets somewhere.
    /// That one is bounded by the most keys a session may hold.)
    fn interrupt(&mut self) -> bool {
        let late = self.used_paths > 1 && self.deadline.is_some_and(|d| Instant::now() >= d);
        if late {
            self.spent = true;
        }
        late
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
        if self.spent || self.late() {
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
/// canonical bytes, not field by field in the order they came. (Two the node
/// cannot read tell nothing of themselves, so they pass for the same here:
/// [`Table::step`] takes one written since the last look for another.)
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
    /// The count owed was made ahead of the reading by the drain before: this
    /// drain reads, whatever the count cost the one before. (Meaningful only
    /// while a count is owed.)
    probed: bool,
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
    /// Which taking up of the table this is (the mirror's count): one let go of and taken up
    /// again is another table, whatever its generation.
    born: u64,
    generation: u64,
    version: u64,
    /// The base last changed (a page's trim, a new incarnation) while the live session it left
    /// still had changes to be read or listed, or while the doc lacked updates a page had (see
    /// [`Dirt::lagged`]).
    unread_at_trim: bool,
    /// Something was made and deleted in the live session in one update ([`Dirt::suspect`]) since the base last
    /// changed: a page may have counted it, and the next trim of the session is not held against what the node read.
    suspect: bool,
    /// How many times the base has changed since it was first read.
    trims: u64,
    /// Checkpoints written over before the table read them, not yet told to the caller ([`RoomMirror::take_superseded`]).
    superseded: u64,
    /// The (player, signing key) of every slip the live session has held since the table last started over, whether it
    /// still holds it or not, and whether there were more than [`MAX_SIGNERS`] (`signers_over`: the rest are not kept).
    signers: BTreeSet<(String, String)>,
    signers_over: bool,
    /// The same, of the sessions the table started over from since the caller last asked
    /// ([`RoomMirror::take_ended_signers`]): the session a page's trim ended is gone from the mirror when the checkpoint
    /// is read.
    ended_signers: BTreeSet<(String, String)>,
    ended_over: bool,
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
    fn new(ctx: Ctx, born: u64) -> Table {
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
            probed: false,
            extra: 0,
            stale: false,
            announce: true,
            born,
            generation: 0,
            version: 0,
            unread_at_trim: false,
            suspect: false,
            trims: 0,
            superseded: 0,
            signers: BTreeSet::new(),
            signers_over: false,
            ended_signers: BTreeSet::new(),
            ended_over: false,
        }
    }

    fn ended(&self) -> bool {
        matches!(&self.base, Base::Cp(cp) if cp.get("e").is_some())
    }

    /// The live session has changes the table has not read: records changed in it (noted, not
    /// read), or it is still being listed or read, or its map was made or replaced and is in the
    /// doc now. (A page's trim deletes the session it trims in the transaction that writes the
    /// checkpoint: a session map gone is not a change to read.)
    fn session_unread<T: ReadTxn>(&self, pending: &Dirt, comp: Option<&MapRef>, txn: &T) -> bool {
        if self.need_session || self.cold.is_some() {
            return true;
        }
        let Some(live) = &self.live else { return false };
        self.suspect || pending.suspect.contains(live) || pending.has_recs(live) || (pending.tops.contains(live) && comp.is_some_and(|c| matches!(c.get(txn, live), Some(Out::YMap(_)))))
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
        // (Who signed what the session held is told of the session that ended, once the caller asks.)
        let over = std::mem::take(&mut self.signers_over);
        for pair in std::mem::take(&mut self.signers) {
            self.keep_ended(pair);
        }
        self.ended_over |= over;
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

    /// `changed`: the base is not the one the table has (a first reading is a change).
    fn set_base(&mut self, new: Base, changed: bool) {
        if !changed {
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

    /// A pair of an ended session's signers, kept if there is room.
    fn keep_ended(&mut self, pair: (String, String)) {
        if self.ended_signers.len() >= MAX_SIGNERS && !self.ended_signers.contains(&pair) {
            self.ended_over = true;
        } else {
            self.ended_signers.insert(pair);
        }
    }

    /// Note who signed a slip the session holds: the key of the slip (`s:<round>:<player>:<hash>`) names the player, and
    /// its value the key it was signed with (`k`), which the fold counts only if it is the key pinned for the player.
    fn note_signer(&mut self, key: &str, value: &CVal) {
        let Some(('s', _, Some(pid), _)) = parse_key(key) else { return };
        let Some(k) = value.get("k").and_then(CVal::as_str) else { return };
        let pair = (pid.to_string(), k.to_string());
        if self.signers.len() >= MAX_SIGNERS && !self.signers.contains(&pair) {
            self.signers_over = true;
        } else {
            self.signers.insert(pair);
        }
    }

    fn put(&mut self, key: &str, value: Option<CVal>) {
        let size = key.len() + value.as_ref().map_or(0, cval_bytes);
        if let Some(v) = &value {
            self.note_signer(key, v);
        }
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
    fn record(&mut self, key: &str, read: Read, limits: &Limits) {
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
        // (Keys are read in key order, not in the order the doc changed them:
        // one swapped for another reads as both, and the session is over the
        // most for a moment that it never was. So past the most is for the
        // count to say; past what such a moment can come to, it is certain.)
        if kept > limits.session_keys.saturating_add(limits.dirty_keys) {
            self.flood();
            return;
        }
        // (Keys the mirror does not keep are in the session too.)
        if kept.saturating_add(self.extra) > limits.session_keys {
            self.recount = true;
        }
        if self.stale && self.unclear.is_empty() {
            // (Nothing holds the table now, and what it was sent was given up.)
            self.reset();
        }
    }

    fn room_for_a_record(&self, limits: &Limits) -> bool {
        // (An empty queue has room for one, whatever the cap: one smaller than a record would wait for ever.)
        self.queue.is_empty() || self.queue_bytes.saturating_add(MAX_QUEUED_RECORD) <= limits.pending_bytes
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
        self.record(key, read, limits);
        true
    }

    /// Count the live session's keys afresh, up to the most and one: more than
    /// the most holds the table, as a cold read's list does (and the count
    /// is owed no more). None when the budget is spent first; else the count
    /// (the most and one at the most), for [`Table::settle_count`] once what
    /// there is to read has been read.
    fn count_keys<T: ReadTxn>(&mut self, ses: &MapRef, txn: &T, b: &mut Budget, limits: &Limits) -> Option<usize> {
        if !b.path() {
            return None;
        }
        self.count_scan(ses, txn, b, limits)
    }

    /// [`Table::count_keys`] once the count has been begun (it looks at the clock as it goes: see [`Budget::interrupt`]).
    fn count_scan<T: ReadTxn>(&mut self, ses: &MapRef, txn: &T, b: &mut Budget, limits: &Limits) -> Option<usize> {
        let mut n = 0usize;
        for _ in ses.keys(txn).take(limits.session_keys.saturating_add(1)) {
            n += 1;
            if n % SCAN_CHECK_KEYS == 0 && b.interrupt() {
                return None;
            }
        }
        if !b.charge(n.saturating_mul(VISIT_BYTES)) {
            return None;
        }
        if n > limits.session_keys {
            self.flood();
        }
        Some(n)
    }

    /// The keys of the session were `n` in the doc this drain reads, and the
    /// table has read everything of it that changed: what it keeps is as the
    /// doc has it, and the rest of the keys are the ones it does not keep.
    fn settle_count(&mut self, n: usize) {
        self.recount = false;
        self.extra = n.saturating_sub(self.keys.len() + self.unclear.len());
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
            // (Nothing is kept until the list is made: a list given up is made again.)
            if seen % SCAN_CHECK_KEYS == 0 && b.interrupt() {
                return false;
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
            let present = out.is_some();
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
            let sets = pending.writes.remove(&self.sum_name).unwrap_or(0);
            self.read_base = false;
            // (The session the base leaves: what a page wrote to it before it trimmed it, and
            // this table has not read, is not in what the worker was sent.)
            let was_based = self.based;
            // (A checkpoint the node cannot read cannot be told from another it cannot read: one written since the last
            // look is another.)
            let same = was_based && same_base(&new, &self.base) && !(new == Base::Held && sets > 0);
            let changed = !same;
            // (Of the checkpoints written since the last look, the one standing is the one read; the others were written
            // over before the node could.)
            if was_based {
                self.superseded = self.superseded.saturating_add(sets.saturating_sub(u64::from(present)));
            }
            let lagged = pending.lagged.remove(&self.sum_name);
            let unread = changed && (lagged || self.session_unread(pending, comp, txn));
            let left = self.live.clone();
            self.set_base(new, changed);
            if changed {
                self.unread_at_trim = unread;
                // (What was made and deleted in the session the base leaves is not the next session's.)
                self.suspect = false;
                if let Some(left) = left {
                    pending.suspect.remove(&left);
                }
                if was_based {
                    self.trims += 1;
                }
            }
        }
        let Some(live) = self.live.clone() else { return true };
        self.suspect |= pending.suspect.remove(&live);

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
        // (No session: what changed in it is nothing to read. It is read
        // when there is one, which is a change of its own.)
        if ses.is_none() {
            pending.recs.remove(&live);
        }
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

        // A count owed from a drain that ran out before it is made first:
        // changes that come as fast as a drain reads them would else keep it
        // for ever from finding the session over the most. (If the end is
        // reached this drain, it settles on this count, not another. And one
        // drain in two: a count that takes the whole drain would else leave
        // nothing to read with. And not while the queue waits to be taken:
        // nothing is read then, so there is nothing to starve.)
        let mut counted = None;
        if !self.recount {
            self.probed = false;
        } else if self.room_for_a_record(limits) && !std::mem::take(&mut self.probed) {
            match self.count_keys(&ses, txn, b, limits) {
                None => return false,
                Some(_) if self.flooded => {
                    pending.recs.remove(&live);
                    return true;
                }
                n => {
                    counted = n;
                    self.probed = true;
                }
            }
        }

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
        // (With everything read: the keys kept are as the doc has them.)
        if self.recount {
            let n = match counted {
                Some(n) => Some(n),
                None => self.count_keys(&ses, txn, b, limits),
            };
            match n {
                None => return false,
                Some(n) => {
                    if !self.flooded {
                        self.settle_count(n);
                    }
                }
            }
        }
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
    /// The table started over and nothing has been taken since: the next
    /// [`RoomMirror::take`] says so (`Taken::reset`).
    pub announcing: bool,
    /// Which taking up of the table this is: a table let go of by [`RoomMirror::want`] and
    /// wanted again is another (its generation and version start over).
    pub born: u64,
    /// Goes up when the table starts over.
    pub generation: u64,
    /// Goes up with every change to the base, a record or the hold.
    pub version: u64,
    /// The base last changed (a page's trim, a new incarnation) while the session it left still
    /// had changes this mirror had not read: what the worker was sent of that session is not all
    /// of it, so an answer made before the trim is of less than the checkpoint's page saw.
    pub unread_at_trim: bool,
    /// How many times the base has changed since it was first read (a page's trims).
    pub trims: u64,
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
    /// Tables taken up since the start ([`State::born`]).
    births: u64,
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
        RoomMirror { room: room.to_string(), shared, _sub: sub, tables: BTreeMap::new(), pending: Dirt::default(), limits, turn: 0, resets: 0, births: 0 }
    }

    /// Mirror these tables, `(t, inc)`, and no others. The ones dropped are
    /// returned, for the worker to forget.
    pub fn want(&mut self, tables: &[(String, String)]) -> Vec<Ctx> {
        let keep: BTreeSet<&(String, String)> = tables.iter().collect();
        let gone: Vec<Ctx> = self.tables.iter().filter(|(k, _)| !keep.contains(k)).map(|(_, t)| t.ctx.clone()).collect();
        self.tables.retain(|k, _| keep.contains(k));
        for (t, inc) in tables {
            let (room, births) = (&self.room, &mut self.births);
            self.tables.entry((t.clone(), inc.clone())).or_insert_with(|| {
                *births += 1;
                Table::new(Ctx { room: room.clone(), t: t.clone(), inc: inc.clone() }, *births)
            });
        }
        self.sync_watch();
        self.sweep();
        gone
    }

    /// The room this mirror follows.
    pub fn room(&self) -> &str {
        &self.room
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
        let mut budget = Budget::new(self.limits.drain_bytes, self.limits.drain_paths, self.limits.drain_time);
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
        self.pending.lagged.retain(|n| names.contains(n));
        self.pending.writes.retain(|n, _| names.contains(n));
        self.pending.suspect.retain(|n| names.contains(n));
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
            announcing: tb.announce,
            born: tb.born,
            generation: tb.generation,
            version: tb.version,
            unread_at_trim: tb.unread_at_trim,
            trims: tb.trims,
        })
    }

    /// How many checkpoints of the table were written over, since this was last asked, before the table read them (a
    /// page wrote another while a drain had not got to the table, or one that was held for a time): each was a trim of the
    /// table that cannot be held against what the node had worked out, for the node never read it.
    pub fn take_superseded(&mut self, t: &str, inc: &str) -> u64 {
        self.tables.get_mut(&(t.to_string(), inc.to_string())).map_or(0, |tb| std::mem::take(&mut tb.superseded))
    }

    /// Who signed the slips of the session or sessions the table ended since this was last asked (its trims, or any
    /// other start over of it), as `(player, key)`, and whether there were more than the mirror keeps
    /// ([`MAX_SIGNERS`]: then the pairs are not all of them). A page counts a slip for the felt only if it is signed
    /// with the key pinned for the player (its own player's, the key it signs with), so a pair whose key is not the pin
    /// the node holds for the player is a slip the pages may count differently from the node.
    pub fn take_ended_signers(&mut self, t: &str, inc: &str) -> (BTreeSet<(String, String)>, bool) {
        match self.tables.get_mut(&(t.to_string(), inc.to_string())) {
            Some(tb) => (std::mem::take(&mut tb.ended_signers), std::mem::take(&mut tb.ended_over)),
            None => (BTreeSet::new(), false),
        }
    }

    /// What the observer has seen of the room's delegations since it began.
    pub fn delegations(&self) -> Delegations {
        lock(&self.shared).delegations
    }

    /// The table's checkpoint is waiting to be read: the table is new, or a change to `sum:` has
    /// been noted that no drain has read.
    pub fn base_unread(&self, t: &str, inc: &str) -> bool {
        let Some(tb) = self.tables.get(&(t.to_string(), inc.to_string())) else { return false };
        tb.read_base || self.pending.tops.contains(&tb.sum_name) || lock(&self.shared).dirt.tops.contains(&tb.sum_name)
    }

    /// Start a table over, to be sent again from scratch (the worker lost it):
    /// it is read afresh from the doc, and the next [`take`](RoomMirror::take)
    /// says `reset`. False for a table that is not mirrored.
    pub fn restart(&mut self, t: &str, inc: &str) -> bool {
        let Some(tb) = self.tables.get_mut(&(t.to_string(), inc.to_string())) else { return false };
        if tb.based && tb.live.is_some() {
            tb.reset();
            self.resets += 1;
        }
        true
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
pub(crate) mod tests;
