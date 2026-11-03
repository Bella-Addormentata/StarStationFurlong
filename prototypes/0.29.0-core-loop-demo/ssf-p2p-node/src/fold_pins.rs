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
//! starts are read once, up to [`PIN_WALK_KEYS`] entries, in one pass: not a
//! scan that goes on from where the last stopped, for a map is walked from
//! its start whatever the cursor.
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
//!   started (not WALKED: the players past them are unknown).
//!
//! These last for as long as the node watches the room.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use yrs::types::{DeepObservable, EntryChange, Event, Events};
use yrs::{Any, Doc, Map, Out, ReadTxn, Subscription, Transact, TransactionMut};

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

/// The key a players entry holds, if the pages would pin it.
fn key_of(v: &Out) -> Option<&str> {
    match v {
        Out::Any(Any::Map(entry)) => match entry.get("keyB64") {
            Some(Any::String(k)) if key_pinnable(k) => Some(k),
            _ => None,
        },
        _ => None,
    }
}

#[derive(Default)]
struct PinState {
    pins: HashMap<String, String>,
    /// Moves with `pins`.
    version: u64,
    contested: bool,
    capped: bool,
}

impl PinState {
    /// A player's entry went from `old` to `new` (a key the pages would pin, or none).
    fn learn(&mut self, pid: &str, old: Option<&str>, new: Option<&str>) {
        if !pid_pinnable(pid) {
            return;
        }
        match self.pins.get(pid) {
            Some(pinned) => {
                if new.is_some_and(|n| n != pinned) {
                    self.contested = true;
                }
            }
            None => {
                // (A page that saw the old one pinned it; one that saw only the new one pinned that.)
                let Some(first) = old.or(new) else { return };
                if self.pins.len() >= MAX_FOLD_PINS {
                    self.capped = true;
                    return;
                }
                self.pins.insert(pid.to_string(), first.to_string());
                self.version += 1;
                if old.is_some() && new.is_some_and(|n| Some(n) != old) {
                    self.contested = true;
                }
            }
        }
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
    for event in events.iter() {
        let Event::Map(map) = event else { continue };
        if !map.path().is_empty() {
            continue;
        }
        for (pid, change) in map.keys(txn).iter() {
            match change {
                EntryChange::Inserted(new) => st.learn(pid, None, key_of(new)),
                EntryChange::Updated(old, new) => st.learn(pid, key_of(old), key_of(new)),
                // (A page keeps the pin of a player who goes.)
                EntryChange::Removed(_) => {}
            }
        }
    }
}

/// The players already in the map, read once: false if the map held more than
/// `limit` of them.
fn walk(doc: &Doc, shared: &Mutex<PinState>, limit: usize) -> bool {
    let txn = doc.transact();
    let Some(players) = txn.get_map("players") else { return true };
    let mut st = lock(shared);
    let mut visited = 0;
    for (pid, value) in players.iter(&txn) {
        if visited >= limit {
            return false;
        }
        visited += 1;
        st.learn(pid, None, key_of(&value));
    }
    true
}

/// One room's players, watched.
pub struct PlayerPins {
    shared: Arc<Mutex<PinState>>,
    _sub: Subscription,
    walked: bool,
    cache: Option<(u64, Vec<(String, String)>)>,
}

impl PlayerPins {
    /// Watch `doc`'s `players` map, and read what it holds up to `walk_limit`
    /// entries. Call it with no transaction open on `doc`.
    pub fn attach(doc: &Doc, walk_limit: usize) -> PlayerPins {
        let players = doc.get_or_insert_map("players");
        let shared = Arc::new(Mutex::new(PinState::default()));
        let cb = shared.clone();
        let sub = players.observe_deep(move |txn, events| note(&cb, txn, events));
        // (The observer first: a change from now on is noted whatever the walk sees of it.)
        let walked = walk(doc, &shared, walk_limit);
        PlayerPins { shared, _sub: sub, walked, cache: None }
    }

    /// The pins, `(pid, key)` sorted, and whether they are the whole story
    /// (no key was replaced, none went unpinned for want of room, the map
    /// was read to its end).
    pub fn view(&mut self) -> (Vec<(String, String)>, bool) {
        let st = lock(&self.shared);
        let settled = self.walked && !st.contested && !st.capped;
        if self.cache.as_ref().map(|c| c.0) != Some(st.version) {
            let mut pins: Vec<(String, String)> = st.pins.iter().map(|(p, k)| (p.clone(), k.clone())).collect();
            pins.sort();
            self.cache = Some((st.version, pins));
        }
        (self.cache.as_ref().map(|c| c.1.clone()).unwrap_or_default(), settled)
    }
}

#[cfg(test)]
mod tests;
