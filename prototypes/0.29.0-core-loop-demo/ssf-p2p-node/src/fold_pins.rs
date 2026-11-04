//! 📌 The players' keys as the pages pin them, for the node's fold in shadow
//! (PR 6b-1c-iii of "Computed casino tables").
//!
//! A computed felt counts only under its player's pinned key: the first key
//! a page saw for the player in the room's `players` map (casinoDoc
//! `pinPlayerKeys`: at bind, then in the observer of each transaction that
//! changes the map, from the value the map holds when the transaction ends;
//! a player id of at most 128 UTF-16 units, a key of 1 to 128, 4,096 pins at
//! most). The fold has to be told the same keys, or what it counts differs
//! from the pages' for no fault of its own.
//!
//! HOW. An observer on the `players` map notes each change as it happens, so
//! the first key of a player is the first one that transaction showed, not
//! the one a poll finds later, and the work a change costs is a lookup. A
//! change that replaces a key carries the old one (`EntryChange::Updated`):
//! a player first seen as replaced is pinned to the old key, as a page that
//! saw it before pinned it. The players already in the map when the observer
//! starts are read once, up to [`PIN_WALK_KEYS`] entries and [`PIN_WALK_TIME`]
//! (the doc is held while it goes on), in one pass: not a scan that goes on from
//! where the last stopped, for a map is walked from its start whatever the cursor.
//!
//! WHEN IT CANNOT KNOW. What the pages pinned depends on which transactions
//! each of them saw, so some histories have no one answer, and then the pins
//! are not the whole story and the comparison is not made (the view is not
//! [`settled`](PlayerPins::view)):
//! - a player's key was replaced (CONTESTED: a page that saw both pinned the
//!   first, one that saw only the second pinned that);
//! - the players are more than [`MAX_FOLD_PINS`] (CAPPED: which of them each
//!   page pinned depends on the order it saw them in);
//! - the map held more than [`PIN_WALK_KEYS`] entries when the observer
//!   started, or took longer than [`PIN_WALK_TIME`] to read (not WALKED: the
//!   players past them are unknown);
//! - an entry carries a `__proto__` field (AMBIGUOUS: a page reads the key
//!   with a property access, which can come from the prototype the field sets,
//!   and the node reads the field itself);
//! - the map changed in an update in which something was made and deleted, or an update touched it and left no key to
//!   read (CONTESTED, as a key replaced is: the update may have written a key and written it over, or written another
//!   key and put the first back, or made a player and deleted him, and the node sees only the last, while a page that
//!   saw the middle one on its own, or bound while it stood, pinned that. The update does not say what was deleted or
//!   where, and the players it does show do not say that it deleted none of them: so any such update doubts the map,
//!   whichever players it changes, whether the node had a pin for them or not and whatever the entries hold after,
//!   and some that are harmless do too);
//! - a pinned player's key is gone (the entry removed, or its key dropped or made one the pages do not pin: CONTESTED:
//!   a page that binds after has no pin for the player, as one that bound before has the old one).
//!
//! These last for as long as the node watches the room.
//!
//! THE DEED HOLDER is watched with them. The houses a page counts are the ones the deed holder delegated
//! (`roomInfo.owner`; a delegation is signed by their key), so when the deed changes hands the houses every page counts
//! change with it, and a plan made under the last holder is not the room's houses. The watch notes the holder
//! ([`PlayerPins::deed`]) and moves the epoch when it changes, so that a plan is believed only while the doc still
//! names the holder it was made under, and an answer shown whole is taken back by a deed that changed after. It counts
//! the handovers too ([`PinWatch::deeds`]), a handover hidden in one update (the holder written, written over and put
//! back, so that the doc names the same holder as before) included: the epoch moves with it and the count says why, so
//! that the shadow can hold every session it follows in doubt until it is trimmed, for pages may have counted another
//! holder's houses while it ran. An update to the room's info in which something was made and deleted counts as one
//! whatever key it shows (the holder may have come and gone in it, and the doc cannot say it did not), and so does one
//! that leaves the info no key to read, which is how a block made and deleted in it shows.
//!
//! WHAT IT CANNOT SEE. A page that bound before the node began to watch may
//! have pinned a key the map no longer holds (replaced, or the player gone,
//! before the first look): that history is not in the doc, so the pins are
//! "as a page that bound at the first look pinned them", which is all a node
//! that came later can say. Two pages that bound at different times differ in
//! the same way; a difference the node counts on that ground is a case for
//! the log line, not for the gate on its own.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use yrs::types::map::MapEvent;
use yrs::types::{DeepObservable, EntryChange, Event, Events};
use yrs::{Any, Doc, Map, Observable, Out, ReadTxn, Subscription, Transact, TransactionMut};

use crate::house::deed_of;
use crate::house_mirror::made_and_deleted;

/// The most keys the fold pins in a room: the pages' own MAX_PINNED_KEYS
/// (past it new players go unpinned there too). The players map is any
/// peer's to fill, and a pin rides in every frame to the worker.
pub const MAX_FOLD_PINS: usize = 4_096;
/// The longest player id the pages pin (casinoDoc pinPlayerKeys: UTF-16
/// units), and the longest key.
const MAX_PIN_PID_UNITS: usize = 128;
const MAX_PIN_KEY_UNITS: usize = 128;
/// The most entries read of a players map that already holds some when the
/// node starts to watch it.
pub const PIN_WALK_KEYS: usize = 65_536;
/// How long the node's own watch ([`PlayerPins::attach_timed`]) may hold the doc for that first read: the house's
/// tick waits for the doc's write lock behind a read held here, with the house's own lock held. A map not read to its
/// end in this time is not WALKED, as one past [`PIN_WALK_KEYS`] is.
pub const PIN_WALK_TIME: Duration = Duration::from_millis(20);
/// How many entries the walk reads between looks at the clock.
const WALK_CLOCK_EVERY: usize = 64;

/// A player id the pages pin a key for: not empty, at most 128 UTF-16 units.
pub fn pid_pinnable(s: &str) -> bool {
    // (A string of more than 3 bytes a unit cannot be short enough: no need to count it.)
    !s.is_empty() && s.len() <= MAX_PIN_PID_UNITS * 3 && s.encode_utf16().count() <= MAX_PIN_PID_UNITS
}

/// A key the pages pin: not empty, at most 128 UTF-16 units (a peer's strings
/// are not counted past the most bytes such a string can have).
pub fn key_pinnable(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_PIN_KEY_UNITS * 3 && s.encode_utf16().count() <= MAX_PIN_KEY_UNITS
}

/// What a players entry says of its key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Key<'a> {
    /// No key the pages would pin.
    None,
    /// The key the pages pin.
    Pin(&'a str),
    /// The entry has a `__proto__` field: a page may read a key from it or not.
    Ambiguous,
}

impl<'a> Key<'a> {
    fn pin(self) -> Option<&'a str> {
        match self {
            Key::Pin(k) => Some(k),
            _ => None,
        }
    }
}

/// The key a players entry holds, if the pages would pin it.
fn key_of(v: &Out) -> Key<'_> {
    match v {
        Out::Any(Any::Map(entry)) => {
            // (casinoDoc entryKey reads `v.keyB64`: from the object, or from the prototype a `__proto__` field of the entry sets.)
            if entry.contains_key("__proto__") {
                return Key::Ambiguous;
            }
            match entry.get("keyB64") {
                Some(Any::String(k)) if key_pinnable(k) => Key::Pin(k),
                _ => Key::None,
            }
        }
        _ => Key::None,
    }
}

#[derive(Default)]
struct PinState {
    pins: HashMap<String, String>,
    /// Moves with `pins`.
    version: u64,
    contested: bool,
    capped: bool,
    /// Moves with anything that changes what [`PlayerPins::view`] says: a pin, the pins no longer being the
    /// whole story, or the deed changing hands.
    epoch: u64,
    /// The deed holder `roomInfo` names now (None: no one a house can stand under).
    owner: Option<String>,
    /// How many times the deed may have changed hands: moves with every change of holder and with every update to
    /// the holder's key in which something was made and deleted (the holder may have changed and changed back).
    deeds: u64,
}

impl PinState {
    fn contest(&mut self) {
        if !self.contested {
            self.contested = true;
            self.epoch += 1;
        }
    }

    /// A player's entry went from `old` to `new`.
    fn learn(&mut self, pid: &str, old: Key, new: Key) {
        if !pid_pinnable(pid) {
            return;
        }
        if old == Key::Ambiguous || new == Key::Ambiguous {
            self.contest();
        }
        let (old, new) = (old.pin(), new.pin());
        match self.pins.get(pid) {
            Some(pinned) => {
                // (A key replaced, or gone: a page that binds from now on pins the new one, or none at all, as a page
                // that bound before pinned the one it had.)
                if new != Some(pinned.as_str()) {
                    self.contest();
                }
            }
            None => {
                // (A page that saw the old one pinned it; one that saw only the new one pinned that.)
                let Some(first) = old.or(new) else { return };
                if self.pins.len() >= MAX_FOLD_PINS {
                    if !self.capped {
                        self.capped = true;
                        self.epoch += 1;
                    }
                    return;
                }
                self.pins.insert(pid.to_string(), first.to_string());
                self.version += 1;
                self.epoch += 1;
                if old.is_some() && new != old {
                    self.contest();
                }
            }
        }
    }
}

/// The observer of `roomInfo`: the deed holder, when it changes. (A holder written again as it stands is no change.)
fn note_deed(shared: &Mutex<PinState>, txn: &TransactionMut, event: &MapEvent) {
    let mut st = lock(shared);
    let keys = event.keys(txn);
    // (A holder written, written over and put back in one update, as when the node was away and the updates were
    // merged on the way, is the same holder in the doc, and a page that saw the middle one counted that one's houses.
    // Nor does the doc show a holder made and deleted in one update: the pages that saw it had one, and then none. The
    // transaction says that something was made and deleted in it, and not what or where: any change to the room's info
    // in such a one is a handover, whichever keys it names, and so is a change to the map that leaves no key to read,
    // which is how a record made and deleted in a map shows (a block deleted that the doc held shows as a key removed
    // or replaced, so an event with no key is always one: `made_and_deleted` need not be asked). Counted once for the
    // event, whatever it holds.)
    let mut handover = keys.is_empty() || made_and_deleted(txn);
    for (key, change) in keys.iter() {
        if &**key != "owner" {
            continue;
        }
        let now = match change {
            EntryChange::Inserted(new) | EntryChange::Updated(_, new) => deed_of(Some(new.clone())),
            EntryChange::Removed(_) => None,
        };
        if st.owner != now {
            st.owner = now;
            handover = true;
        }
    }
    if handover {
        st.deeds += 1;
        st.epoch += 1;
    }
}

fn lock(m: &Mutex<PinState>) -> MutexGuard<'_, PinState> {
    // (A callback that panicked left it as it was: nothing in it is half-written.)
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The observer's callback. It runs inside the doc's commit: a lookup for
/// each key that changed.
fn note(shared: &Mutex<PinState>, txn: &TransactionMut, events: &Events) {
    let mut st = lock(shared);
    // (Asked once, and only for an event of the players map.)
    let mut lost = None;
    for event in events.iter() {
        let Event::Map(map) = event else { continue };
        if !map.path().is_empty() {
            continue;
        }
        let keys = map.keys(txn);
        // A player's key written and written over in one update (the node was away and the updates were merged on
        // the way) shows only the last, and a page that saw the middle one on its own pinned that, or one that
        // bound while it stood. A player made and deleted in one update shows nothing at all, and a page that saw it
        // pinned its key: the map's event has no key to read then (a block made and deleted shows as no change in
        // the map, and an event of the map with no change in it is always one), or has the keys of whatever else the
        // update changed beside it. The change does not say it, whatever it shows: an insert, an update to a key
        // that matches the pin or to none at all, a removal, a player no page pins, can all sit beside one. The
        // transaction says that something was made and deleted in it, and not what or where: the map is doubted, as
        // a key replaced is, whichever players the event names.
        if keys.is_empty() || *lost.get_or_insert_with(|| made_and_deleted(txn)) {
            st.contest();
        }
        for (pid, change) in keys.iter() {
            match change {
                EntryChange::Inserted(new) => st.learn(pid, Key::None, key_of(new)),
                EntryChange::Updated(old, new) => st.learn(pid, key_of(old), key_of(new)),
                // (A page that bound before keeps the pin of a player who goes, and one that binds after has none: the
                // view is doubted, `learn`. One who goes before this watch has read the map was seen by the pages, and
                // is pinned as they pinned him.)
                EntryChange::Removed(old) => st.learn(pid, key_of(old), Key::None),
            }
        }
    }
}

/// The players already in the map, read once: false if the map held more than
/// `limit` of them, or the read took longer than `time`.
fn walk(doc: &Doc, shared: &Mutex<PinState>, limit: usize, time: Option<Duration>) -> bool {
    let txn = doc.transact();
    // (The time is the doc's held for the read, not the wait for the lock that comes before it: a write that is
    // being committed holds that up, and a map that is quick to read is not made slow by it.)
    let started = Instant::now();
    let mut st = lock(shared);
    // (The doc as the read sees it is at least as new as any change the observer has noted: no epoch moves for this.)
    st.owner = txn.get_map("roomInfo").and_then(|m| deed_of(m.get(&txn, "owner")));
    let Some(players) = txn.get_map("players") else { return true };
    let mut visited = 0;
    for (pid, value) in players.iter(&txn) {
        if visited >= limit {
            return false;
        }
        if visited % WALK_CLOCK_EVERY == WALK_CLOCK_EVERY - 1 && time.is_some_and(|t| started.elapsed() >= t) {
            return false;
        }
        visited += 1;
        st.learn(pid, Key::None, key_of(&value));
    }
    true
}

/// A look at whether a room's pins have moved, for whoever holds the view they made.
#[derive(Clone)]
pub struct PinWatch(Arc<Mutex<PinState>>);

impl std::fmt::Debug for PinWatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PinWatch(epoch {})", self.epoch())
    }
}

impl PartialEq for PinWatch {
    fn eq(&self, other: &PinWatch) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl PinWatch {
    /// Moves with anything that changes what the pins say or whether they are the whole story.
    pub fn epoch(&self) -> u64 {
        lock(&self.0).epoch
    }

    /// How many times the deed may have changed hands since the watch began (see [`PinState::deeds`]): it moves with
    /// every change of holder, and with a handover hidden in an update.
    pub fn deeds(&self) -> u64 {
        lock(&self.0).deeds
    }
}

/// One room's players, watched.
pub struct PlayerPins {
    shared: Arc<Mutex<PinState>>,
    _sub: Subscription,
    _deed_sub: Subscription,
    walked: bool,
    cache: Option<(u64, Vec<(String, String)>)>,
}

impl PlayerPins {
    /// Watch `doc`'s `players` map, and read what it holds up to `walk_limit`
    /// entries. Call it with no transaction open on `doc`.
    pub fn attach(doc: &Doc, walk_limit: usize) -> PlayerPins {
        PlayerPins::attach_timed(doc, walk_limit, None)
    }

    /// [`PlayerPins::attach`], with the read of the players already in the map held to `walk_time` (None: no limit
    /// of time): past it the map is not WALKED, as if it held more than `walk_limit`.
    pub fn attach_timed(doc: &Doc, walk_limit: usize, walk_time: Option<Duration>) -> PlayerPins {
        let players = doc.get_or_insert_map("players");
        let shared = Arc::new(Mutex::new(PinState::default()));
        let cb = shared.clone();
        let sub = players.observe_deep(move |txn, events| note(&cb, txn, events));
        let info = doc.get_or_insert_map("roomInfo");
        let cb = shared.clone();
        let deed_sub = info.observe(move |txn, event| note_deed(&cb, txn, event));
        // (The observers first: a change from now on is noted whatever the walk sees of it.)
        let walked = walk(doc, &shared, walk_limit, walk_time);
        PlayerPins { shared, _sub: sub, _deed_sub: deed_sub, walked, cache: None }
    }

    /// A handle to ask later whether the pins have moved since a view.
    pub fn watch(&self) -> PinWatch {
        PinWatch(self.shared.clone())
    }

    /// The pins, `(pid, key)` sorted, and whether they are the whole story (no
    /// key was replaced, none went unpinned for want of room, the map was
    /// read to its end).
    pub fn view(&mut self) -> (Vec<(String, String)>, bool) {
        let (pins, settled, _) = self.view_at();
        (pins, settled)
    }

    /// [`PlayerPins::view`], and the epoch it was made at (read in the same look).
    pub fn view_at(&mut self) -> (Vec<(String, String)>, bool, u64) {
        let (pins, settled, epoch, _) = self.view_full();
        (pins, settled, epoch)
    }

    /// The deed holder the doc names now (None: no one a house can stand under).
    pub fn deed(&self) -> Option<String> {
        lock(&self.shared).owner.clone()
    }

    /// [`PlayerPins::view_at`], and the deed holder as of the same look.
    pub fn view_full(&mut self) -> (Vec<(String, String)>, bool, u64, Option<String>) {
        let st = lock(&self.shared);
        let settled = self.walked && !st.contested && !st.capped;
        if self.cache.as_ref().map(|c| c.0) != Some(st.version) {
            let mut pins: Vec<(String, String)> = st.pins.iter().map(|(p, k)| (p.clone(), k.clone())).collect();
            pins.sort();
            self.cache = Some((st.version, pins));
        }
        (self.cache.as_ref().map(|c| c.1.clone()).unwrap_or_default(), settled, st.epoch, st.owner.clone())
    }
}

#[cfg(test)]
mod tests;
