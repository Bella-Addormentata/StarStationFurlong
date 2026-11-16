//! 🔒 The keys of a room's FAIR ONLY records, as the house's walk at the games wants them (design-final section 8.5,
//! N1; the node's half of FAIR ONLY): kept from each update's changed keys, so a pass reads what a game holds without
//! going through every key of the room, and the value under each `hk:<house>` key read once, until it changes.
//!
//! WHY. The walk ([`crate::house::House`]'s, at the games) used to list the whole `casinoComputed` map each pass, a
//! visit charged for each key, and read every `hk:` value each pass. Some 60,000 keys of any name, or junk under some
//! 500 `hk:` names, then spent what a tick may read before any game was reached, and every game in the room went
//! without its joins and reveals for as long as they stood. Now a key that is no FAIR ONLY record's costs the walk
//! nothing at all, and one that is costs it once a change.
//!
//! HOW IT FOLLOWS THE DOC. One `observe_deep` on the room's `casinoComputed` map notes, inside the doc's commit, each
//! changed top-level key that parses as a FAIR ONLY game's record key (`ck:`, `xf:`, `fin:`, the pages' own
//! parseFairOnlyKey) or as a house's delegation key (`hk:` and a public key), and nothing else: a key of any other
//! name, or longer than any record's ([`MAX_KEY_BYTES`]), costs the callback its parse. Changes inside a value are no
//! change to it: a nested map or array under a record's key is no record (the house reads it as nothing there), and so
//! stays nothing whatever is written in it. The callback takes only the index's own lock, never the house's.
//!
//! WHAT A PASS READS ([`FairIndex::drain`]). The first lists the room's keys once (keys only: admitted when it comes,
//! and charged, so the tick may have nothing left for the games then), and each after looks at the keys noted since:
//! whether each is still there (a visit charged each), and the delegation key's value is to be read again. What a tick
//! cannot get to waits for the next, and until then the games wait ([`FairIndex::drain`] says so): a game read from an
//! index that is behind could miss its own record.
//!
//! A GAME THAT HAS NOTHING FOR THIS HOUSE ([`Quiet`]). A game the walk found over, or with no base, or under rules this
//! build does not know, stays so until one of its own records changes; and one whose rounds to come are none of this
//! house's stays so until then or until what stands under this house's own key changes (no other delegation names this
//! house). The walk does not read either again till then, so many games that have nothing for the house cost it once.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use yrs::types::{DeepObservable, Event, Events};
use yrs::{Doc, Map, MapRef, ReadTxn, Subscription, TransactionMut, Uuid};

use crate::house::{is_pub, COMPUTED_MAP, MAX_KEY_BYTES, VISIT_BYTES};
use crate::house_auth as ha;
use crate::house_bytes::{self as hb, CVal};

/// A FAIR ONLY record's kind, by its key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    Ck,
    Xf,
    Fin,
}

/// What a key the index follows is: a game's record, or a house's delegation key.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Of {
    Game(String, String, Kind),
    Hk,
}

/// The key's kind, when the index follows it.
fn of(key: &str) -> Option<Of> {
    if key.len() > MAX_KEY_BYTES || !hb::utf8(key) {
        return None;
    }
    if let Some(h) = key.strip_prefix("hk:") {
        return is_pub(h).then_some(Of::Hk);
    }
    let (t, inc, kind) = match ha::parse_fair_only_key(key)? {
        ha::FairOnlyKey::Ck { t, inc, .. } => (t, inc, Kind::Ck),
        ha::FairOnlyKey::Xf { t, inc, .. } => (t, inc, Kind::Xf),
        ha::FairOnlyKey::Fin { t, inc } => (t, inc, Kind::Fin),
        ha::FairOnlyKey::Do { .. } => return None,
    };
    Some(Of::Game(t.to_string(), inc.to_string(), kind))
}

/// What stands under a house's delegation key, as last read ([`FairIndex::hk`]).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Hk {
    /// Not read since it changed.
    Unread,
    /// A value every page reads alike that names the key's house (`h`): given to every game.
    Theirs(CVal),
    /// Nothing a game counts by: none there, junk, too heavy, or another house's.
    Nothing,
    /// A value a page may read otherwise that could be anything: the games wait while it stands.
    Unknown,
    /// One a page reads as the house does, or as junk, that is a delegation of the key's house as read: the games wait,
    /// and it goes back as read.
    Whole(CVal),
}

/// Why the walk need not read a game again ([`Game::quiet`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Quiet {
    /// Over, with no base, or under rules this build does not know: until its records change.
    Records,
    /// None of its rounds to come or in flight are this house's: until its records change, or what this house's own key
    /// holds (the hash of the delegation of this house there, if any).
    Mine(Option<String>),
}

/// One game's record keys, and whether the walk may pass it by.
#[derive(Clone, Debug, Default)]
pub(crate) struct Game {
    pub keys: BTreeMap<String, Kind>,
    pub quiet: Option<Quiet>,
}

/// The keys of one room's FAIR ONLY records (module docs).
pub(crate) struct FairIndex {
    doc: Uuid,
    /// The keys the observer noted since the last drain took them.
    noted: Arc<Mutex<BTreeSet<String>>>,
    _sub: Subscription,
    /// No pass has listed the room's keys yet.
    cold: bool,
    /// Noted keys a drain has not looked at yet.
    pending: BTreeSet<String>,
    pub games: BTreeMap<(String, String), Game>,
    pub hk: BTreeMap<String, Hk>,
}

impl FairIndex {
    /// Follow `doc`'s `casinoComputed` map. Call it with no transaction open on `doc`.
    pub fn attach(doc: &Doc) -> FairIndex {
        let comp = doc.get_or_insert_map(COMPUTED_MAP);
        let noted = Arc::new(Mutex::new(BTreeSet::new()));
        let cb = noted.clone();
        let sub = comp.observe_deep(move |txn, events| note(&cb, txn, events));
        FairIndex { doc: doc.guid(), noted, _sub: sub, cold: true, pending: BTreeSet::new(), games: BTreeMap::new(), hk: BTreeMap::new() }
    }

    /// Whether this index follows `doc`.
    pub fn follows(&self, doc: &Doc) -> bool {
        self.doc == doc.guid()
    }

    /// Bring the index up to what `comp` holds in `txn`: the room's keys listed on the first pass, then the keys noted
    /// since, a visit charged each to `charge` (`charge(n, false)` says whether the read may go on; `charge(n, true)`,
    /// for the listing, is charged whatever is left, and the keys are listed to their end). False when it could not get
    /// to all of them: they wait for the next pass, and so do the games.
    pub fn drain<T: ReadTxn>(&mut self, txn: &T, comp: &MapRef, charge: &mut dyn FnMut(usize, bool) -> bool) -> bool {
        let noted = std::mem::take(&mut *self.noted.lock().unwrap_or_else(|e| e.into_inner()));
        if self.cold {
            // (Every key there now is listed: what was noted before is in it. Nothing is pending yet: this is the first.)
            self.cold = false;
            for key in comp.keys(txn) {
                charge(key.len() + VISIT_BYTES, true);
                if let Some(of) = of(key) {
                    self.put(key, of);
                }
            }
            return true;
        }
        self.pending.extend(noted);
        while let Some(key) = self.pending.first() {
            if !charge(key.len() + VISIT_BYTES, false) {
                return false;
            }
            let key = self.pending.pop_first().unwrap();
            let Some(of) = of(&key) else { continue };
            if comp.get(txn, &key).is_some() {
                self.put(&key, of);
            } else {
                self.drop_key(&key, of);
            }
        }
        true
    }

    /// Key `key` there (again, or with another value).
    fn put(&mut self, key: &str, of: Of) {
        match of {
            Of::Game(t, inc, kind) => {
                let game = self.games.entry((t, inc)).or_default();
                game.keys.insert(key.to_string(), kind);
                game.quiet = None;
            }
            Of::Hk => {
                self.hk.insert(key.to_string(), Hk::Unread);
            }
        }
    }

    /// Key `key` gone.
    fn drop_key(&mut self, key: &str, of: Of) {
        match of {
            Of::Game(t, inc, _) => {
                let k = (t, inc);
                if let Some(game) = self.games.get_mut(&k) {
                    game.keys.remove(key);
                    game.quiet = None;
                    if game.keys.is_empty() {
                        self.games.remove(&k);
                    }
                }
            }
            Of::Hk => {
                self.hk.remove(key);
            }
        }
    }
}

/// The observer: the changed keys the index follows, noted.
fn note(noted: &Mutex<BTreeSet<String>>, txn: &TransactionMut, events: &Events) {
    let mut keys: Vec<String> = Vec::new();
    for event in events.iter() {
        let Event::Map(map) = event else { continue };
        // (A change inside a value: no change to it, module docs.)
        if !map.path().is_empty() {
            continue;
        }
        for key in map.keys(txn).keys() {
            if of(key).is_some() {
                keys.push(key.to_string());
            }
        }
    }
    if !keys.is_empty() {
        noted.lock().unwrap_or_else(|e| e.into_inner()).extend(keys);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Any, MapPrelim, Transact};

    const INC: &str = "p0123456789abcdef01234567";
    const PUB: &str = "euv_S3ReR1dkBdqpTMpTnB_569GNe5jB-cbKpohewP0";

    fn ck(t: &str, n: u8) -> String {
        format!("ck:{t}:{INC}:{:032x}", n)
    }

    fn put(doc: &Doc, key: &str, v: Any) {
        let comp = doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = doc.transact_mut();
        comp.insert(&mut txn, key, v);
    }

    fn delete(doc: &Doc, key: &str) {
        let comp = doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = doc.transact_mut();
        comp.remove(&mut txn, key);
    }

    /// A drain with every read allowed: whether it got through, and what it charged, listed and charged.
    fn drain(ix: &mut FairIndex, doc: &Doc) -> (bool, usize, usize) {
        let comp = doc.get_or_insert_map(COMPUTED_MAP);
        let txn = doc.transact();
        let (mut charged, mut admitted) = (0, 0);
        let done = ix.drain(&txn, &comp, &mut |n, listing| {
            *(if listing { &mut admitted } else { &mut charged }) += n;
            true
        });
        (done, charged, admitted)
    }

    fn keys_of(ix: &FairIndex, t: &str) -> Vec<String> {
        ix.games.get(&(t.to_string(), INC.to_string())).map(|g| g.keys.keys().cloned().collect()).unwrap_or_default()
    }

    #[test]
    fn the_first_pass_lists_the_rooms_keys_and_keeps_only_the_fair_only_ones() {
        let doc = Doc::new();
        put(&doc, &ck("t1", 1), Any::Bool(true));
        put(&doc, &format!("xf:t1:{INC}:{:032x}", 2), Any::Bool(true));
        put(&doc, &format!("fin:t1:{INC}"), Any::Bool(true));
        put(&doc, &format!("hk:{PUB}"), Any::Bool(true));
        for junk in ["hk:short", "ses:t1:p:1", "sum:t1:r1", "do:0123456789abcdef01234567", "zz"] {
            put(&doc, junk, Any::Bool(true));
        }
        put(&doc, &format!("ck:{}:{INC}:{:032x}", "t".repeat(MAX_KEY_BYTES), 3), Any::Bool(true));
        let mut ix = FairIndex::attach(&doc);
        let (done, charged, admitted) = drain(&mut ix, &doc);
        assert!(done);
        assert_eq!(charged, 0, "nothing noted is looked at: the listing has it");
        let all: usize = doc.transact().get_map(COMPUTED_MAP).unwrap().keys(&doc.transact()).map(|k| k.len() + VISIT_BYTES).sum();
        assert_eq!(admitted, all, "every key a visit");
        assert_eq!(ix.games.len(), 1);
        assert_eq!(keys_of(&ix, "t1").len(), 3);
        assert_eq!(ix.hk.keys().cloned().collect::<Vec<_>>(), vec![format!("hk:{PUB}")]);
        assert_eq!(ix.hk[&format!("hk:{PUB}")], Hk::Unread);
        // (And nothing listed again.)
        assert_eq!(drain(&mut ix, &doc), (true, 0, 0));
    }

    #[test]
    fn after_it_each_change_to_a_key_it_follows_is_looked_at_once_and_no_other_key_costs_a_thing() {
        let doc = Doc::new();
        let mut ix = FairIndex::attach(&doc);
        drain(&mut ix, &doc);
        for i in 0..1_000 {
            put(&doc, &format!("zz{i}"), Any::Bool(true));
        }
        put(&doc, &ck("t1", 1), Any::Bool(true));
        put(&doc, &ck("t1", 1), Any::Bool(false));
        assert_eq!(drain(&mut ix, &doc), (true, ck("t1", 1).len() + VISIT_BYTES, 0), "one look, at the one it follows");
        assert_eq!(keys_of(&ix, "t1"), vec![ck("t1", 1)]);
        // Gone: so is the game, with its last key.
        put(&doc, &ck("t1", 2), Any::Bool(true));
        delete(&doc, &ck("t1", 1));
        drain(&mut ix, &doc);
        assert_eq!(keys_of(&ix, "t1"), vec![ck("t1", 2)]);
        delete(&doc, &ck("t1", 2));
        drain(&mut ix, &doc);
        assert!(ix.games.is_empty());
        // (A key written and deleted before a pass: nothing there.)
        put(&doc, &ck("t2", 1), Any::Bool(true));
        delete(&doc, &ck("t2", 1));
        drain(&mut ix, &doc);
        assert!(ix.games.is_empty());
    }

    #[test]
    fn a_change_to_a_games_record_or_a_delegation_key_is_to_be_read_again() {
        let doc = Doc::new();
        let hk = format!("hk:{PUB}");
        put(&doc, &ck("t1", 1), Any::Bool(true));
        put(&doc, &ck("t2", 1), Any::Bool(true));
        put(&doc, &hk, Any::Bool(true));
        let mut ix = FairIndex::attach(&doc);
        drain(&mut ix, &doc);
        for g in ix.games.values_mut() {
            g.quiet = Some(Quiet::Records);
        }
        ix.hk.insert(hk.clone(), Hk::Nothing);
        put(&doc, &ck("t1", 1), Any::Bool(false));
        put(&doc, &hk, Any::Bool(false));
        drain(&mut ix, &doc);
        assert_eq!(ix.games[&("t1".to_string(), INC.to_string())].quiet, None, "its record changed");
        assert_eq!(ix.games[&("t2".to_string(), INC.to_string())].quiet, Some(Quiet::Records), "nothing of its own did");
        assert_eq!(ix.hk[&hk], Hk::Unread);
        // (A record added to it, or one deleted, too.)
        ix.games.get_mut(&("t2".to_string(), INC.to_string())).unwrap().quiet = Some(Quiet::Records);
        put(&doc, &ck("t2", 2), Any::Bool(true));
        drain(&mut ix, &doc);
        assert_eq!(ix.games[&("t2".to_string(), INC.to_string())].quiet, None);
        ix.games.get_mut(&("t2".to_string(), INC.to_string())).unwrap().quiet = Some(Quiet::Records);
        delete(&doc, &ck("t2", 2));
        drain(&mut ix, &doc);
        assert_eq!(ix.games[&("t2".to_string(), INC.to_string())].quiet, None);
        // (A delegation key gone is gone.)
        delete(&doc, &hk);
        drain(&mut ix, &doc);
        assert!(ix.hk.is_empty());
    }

    #[test]
    fn a_change_inside_a_value_is_none_to_it() {
        let doc = Doc::new();
        let key = ck("t1", 1);
        {
            let comp = doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = doc.transact_mut();
            comp.insert(&mut txn, key.as_str(), MapPrelim::default());
        }
        let mut ix = FairIndex::attach(&doc);
        drain(&mut ix, &doc);
        ix.games.get_mut(&("t1".to_string(), INC.to_string())).unwrap().quiet = Some(Quiet::Records);
        {
            let comp = doc.get_or_insert_map(COMPUTED_MAP);
            let mut txn = doc.transact_mut();
            let Some(yrs::Out::YMap(m)) = comp.get(&txn, &key) else { panic!() };
            m.insert(&mut txn, "u", Any::BigInt(1));
            // (A key inside it named as a record's, its own too: still no change of the room's keys.)
            m.insert(&mut txn, key.as_str(), Any::Bool(true));
        }
        assert_eq!(drain(&mut ix, &doc), (true, 0, 0));
        assert_eq!(ix.games[&("t1".to_string(), INC.to_string())].quiet, Some(Quiet::Records));
    }

    #[test]
    fn what_a_pass_cannot_get_to_waits_for_the_next() {
        let doc = Doc::new();
        let mut ix = FairIndex::attach(&doc);
        drain(&mut ix, &doc);
        for n in 0..10 {
            put(&doc, &ck("t1", n), Any::Bool(true));
        }
        let one = ck("t1", 0).len() + VISIT_BYTES;
        let comp = doc.get_or_insert_map(COMPUTED_MAP);
        {
            let txn = doc.transact();
            let mut left = 4 * one;
            let done = ix.drain(&txn, &comp, &mut |n, listing| {
                assert!(!listing, "no listing");
                if n > left {
                    return false;
                }
                left -= n;
                true
            });
            assert!(!done);
            assert_eq!(keys_of(&ix, "t1").len(), 4);
        }
        // (A key noted again meanwhile is looked at once.)
        put(&doc, &ck("t1", 9), Any::Bool(false));
        let (done, charged, _) = drain(&mut ix, &doc);
        assert!(done);
        assert_eq!(charged, 6 * one);
        assert_eq!(keys_of(&ix, "t1").len(), 10);
    }

    #[test]
    fn it_follows_its_own_doc() {
        let (a, b) = (Doc::new(), Doc::new());
        let ix = FairIndex::attach(&a);
        assert!(ix.follows(&a));
        assert!(!ix.follows(&b));
        assert!(ix.follows(&a.clone()));
    }
}
