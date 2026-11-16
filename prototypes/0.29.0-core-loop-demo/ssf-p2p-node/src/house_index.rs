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
//! index that is behind could miss its own record. (The listing is one pass over the names of the room's keys, once per
//! room and doc for the life of the process: some 0.4 s for a million keys in a debug build, less than what loading
//! them took. It cannot be cut into slices: a Yjs map's keys come in no order that holds between transactions.)
//!
//! A delegation key's value is kept as read ([`Hk`]): a delegation of the key's house with its hash, or nothing a game
//! goes by. A game is given this house's own as the room's, and another house's only where it asks of that house
//! ([`delegation_of`]), so the many a room may hold cost a pass no copies.
//!
//! A GAME THAT HAS NOTHING FOR THIS HOUSE ([`Quiet`]). A game the walk found over, or with no base, or under rules this
//! build does not know, stays so until one of its own records changes; and one whose rounds to come are none of this
//! house's stays so until then, or until this house's own key holds a delegation whose signature holds that a key
//! holding one of the game's rounds signed, other than the one it held when the game was passed by (no other
//! delegation of the room names this house, and no other could make the game its: [`FairIndex::mine_is`]). The walk
//! reads only the games awake ([`FairIndex::awake`]), from the one whose turn it is ([`FairIndex::order`]), so a game
//! that has nothing for the house costs a pass nothing, not even a look, till then; and a pass looks at no more of the
//! games, or of a game's keys, than it reads.

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
    // (The name's first bytes first: a key of any other name costs no more than that.)
    if !["ck:", "xf:", "fin:", "hk:"].iter().any(|p| key.starts_with(p)) || key.len() > MAX_KEY_BYTES || !hb::utf8(key) {
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
    /// A delegation every page reads alike that names the key's house (`h`), and its hash: the house's, for every game.
    Theirs(CVal, String),
    /// Nothing a game counts by: none there, junk (no delegation's shape), too heavy, or another house's.
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
    /// None of its rounds to come or in flight are this house's: until its records change, or this house's own key holds
    /// a delegation that one of these keys, the ones holding its rounds, signed ([`FairIndex::mine_is`]).
    Mine(BTreeSet<String>),
}

/// One game's record keys, and whether the walk may pass it by.
#[derive(Clone, Debug, Default)]
pub(crate) struct Game {
    pub keys: BTreeMap<String, Kind>,
    pub quiet: Option<Quiet>,
}

/// A game's name: its table and incarnation.
pub(crate) type GameKey = (String, String);

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
    pub games: BTreeMap<GameKey, Game>,
    /// The games the walk reads ([`Game::quiet`] none): the others cost a pass nothing, not even a look.
    pub awake: BTreeSet<GameKey>,
    /// The games passed by for none of their rounds being this house's ([`Quiet::Mine`]), under each key holding one of
    /// their rounds; and the hash of the delegation whose signature holds that this house's own key held when they were
    /// ([`FairIndex::mine_is`]).
    mine_quiet: BTreeMap<String, BTreeSet<GameKey>>,
    mine_at: Option<String>,
    /// The game whose turn it is, or the first after it (none: the first; [`FairIndex::order`]).
    turn_at: Option<GameKey>,
    /// The games whose last record went since a drain was last taken through ([`FairIndex::take_gone`]).
    gone: BTreeSet<GameKey>,
    pub hk: BTreeMap<String, Hk>,
}

impl FairIndex {
    /// Follow `doc`'s `casinoComputed` map. Call it with no transaction open on `doc`.
    pub fn attach(doc: &Doc) -> FairIndex {
        let comp = doc.get_or_insert_map(COMPUTED_MAP);
        let noted = Arc::new(Mutex::new(BTreeSet::new()));
        let cb = noted.clone();
        let sub = comp.observe_deep(move |txn, events| note(&cb, txn, events));
        FairIndex {
            doc: doc.guid(),
            noted,
            _sub: sub,
            cold: true,
            pending: BTreeSet::new(),
            games: BTreeMap::new(),
            awake: BTreeSet::new(),
            mine_quiet: BTreeMap::new(),
            mine_at: None,
            turn_at: None,
            gone: BTreeSet::new(),
            hk: BTreeMap::new(),
        }
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

    /// The games whose last record went since this was last asked (a drain taken through since then, or not).
    pub fn take_gone(&mut self) -> BTreeSet<GameKey> {
        std::mem::take(&mut self.gone)
    }

    /// The awake games, from the one whose turn it is round to the one before it.
    pub fn order(&self) -> impl Iterator<Item = &GameKey> + '_ {
        let (from, to) = match self.turn_at.as_ref() {
            Some(at) => (self.awake.range::<GameKey, _>(at..), Some(self.awake.range::<GameKey, _>(..at))),
            None => (self.awake.range::<GameKey, _>(..), None),
        };
        from.chain(to.into_iter().flatten())
    }

    /// The turn to the next awake game after the one whose turn it was (a tick whose read was short); after the last,
    /// to the first.
    pub fn pass_turn(&mut self) {
        let at = self.order().next().cloned();
        self.turn_at = at.and_then(|at| self.awake.range::<GameKey, _>((std::ops::Bound::Excluded(&at), std::ops::Bound::Unbounded)).next().cloned());
    }

    /// Game `key` passed by from now on, until what `quiet` says changes.
    pub fn hush(&mut self, key: &GameKey, quiet: Quiet) {
        let Some(game) = self.games.get_mut(key) else { return };
        unmine(&mut self.mine_quiet, key, game.quiet.take());
        if let Quiet::Mine(holders) = &quiet {
            for k in holders {
                self.mine_quiet.entry(k.clone()).or_default().insert(key.clone());
            }
        }
        game.quiet = Some(quiet);
        self.awake.remove(key);
    }

    /// What stands under this house's own key, as a pass found it: a delegation whose signature holds, by its hash and
    /// the key that signed it, or none (nothing there, or anything else). Once it is another such delegation, the games
    /// passed by for none of their rounds being this house's that its signer holds a round of are read again: no other
    /// delegation in the room names this house, and one a key holding none of a game's rounds signed makes none of
    /// them this house's ([`ha::Resolution::house_by`]). (One whose signature fails, however often it changes, or one
    /// a stranger signed, wakes none.)
    pub fn mine_is(&mut self, now: Option<(String, String)>) {
        let hash = now.as_ref().map(|(hash, _)| hash.clone());
        if hash == self.mine_at {
            return;
        }
        if let Some((_, signer)) = now {
            for key in self.mine_quiet.remove(&signer).unwrap_or_default() {
                self.wake(key);
            }
        }
        self.mine_at = hash;
    }

    /// Game `key` to be read again.
    fn wake(&mut self, key: GameKey) {
        if let Some(game) = self.games.get_mut(&key) {
            unmine(&mut self.mine_quiet, &key, game.quiet.take());
            self.awake.insert(key);
        }
    }

    /// Key `key` there (again, or with another value).
    fn put(&mut self, key: &str, of: Of) {
        match of {
            Of::Game(t, inc, kind) => {
                let k = (t, inc);
                self.games.entry(k.clone()).or_default().keys.insert(key.to_string(), kind);
                self.wake(k);
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
                let Some(game) = self.games.get_mut(&k) else { return };
                game.keys.remove(key);
                if game.keys.is_empty() {
                    let quiet = game.quiet.take();
                    unmine(&mut self.mine_quiet, &k, quiet);
                    self.games.remove(&k);
                    self.awake.remove(&k);
                    self.gone.insert(k);
                } else {
                    self.wake(k);
                }
            }
            Of::Hk => {
                self.hk.remove(key);
            }
        }
    }
}

/// Game `key`, passed by as `quiet` was, out of the games passed by under each key holding one of their rounds.
fn unmine(mine_quiet: &mut BTreeMap<String, BTreeSet<GameKey>>, key: &GameKey, quiet: Option<Quiet>) {
    let Some(Quiet::Mine(holders)) = quiet else { return };
    for k in holders {
        if let Some(games) = mine_quiet.get_mut(&k) {
            games.remove(key);
            if games.is_empty() {
                mine_quiet.remove(&k);
            }
        }
    }
}

/// The delegation of house `house` the room holds under its key, with its hash, as last read: what a game weighs for
/// that house besides its own ([`ha::Resolution::house_by_with`]).
pub(crate) fn delegation_of<'a>(hk: &'a BTreeMap<String, Hk>, house: &str) -> Option<(&'a CVal, &'a str)> {
    match hk.get(&format!("hk:{house}")) {
        Some(Hk::Theirs(v, hash)) => Some((v, hash.as_str())),
        _ => None,
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
        for k in ix.games.keys().cloned().collect::<Vec<_>>() {
            ix.hush(&k, Quiet::Records);
        }
        assert!(ix.awake.is_empty());
        ix.hk.insert(hk.clone(), Hk::Nothing);
        put(&doc, &ck("t1", 1), Any::Bool(false));
        put(&doc, &hk, Any::Bool(false));
        drain(&mut ix, &doc);
        assert_eq!(ix.games[&("t1".to_string(), INC.to_string())].quiet, None, "its record changed");
        assert_eq!(ix.games[&("t2".to_string(), INC.to_string())].quiet, Some(Quiet::Records), "nothing of its own did");
        assert_eq!(ix.awake.iter().cloned().collect::<Vec<_>>(), vec![("t1".to_string(), INC.to_string())]);
        assert_eq!(ix.hk[&hk], Hk::Unread);
        // (A record added to it, or one deleted, too.)
        let t2 = ("t2".to_string(), INC.to_string());
        let mine = || Quiet::Mine(BTreeSet::from(["ann".to_string()]));
        ix.hush(&t2, mine());
        put(&doc, &ck("t2", 2), Any::Bool(true));
        drain(&mut ix, &doc);
        assert_eq!(ix.games[&t2].quiet, None);
        assert!(ix.awake.contains(&t2));
        ix.hush(&t2, Quiet::Records);
        delete(&doc, &ck("t2", 2));
        drain(&mut ix, &doc);
        assert_eq!(ix.games[&t2].quiet, None);
        assert!(ix.awake.contains(&t2));
        // (And the last key of a game gone: the game is, from every set, and it is among those gone.)
        ix.hush(&t2, mine());
        assert!(ix.mine_quiet["ann"].contains(&t2));
        assert!(ix.take_gone().is_empty());
        delete(&doc, &ck("t2", 1));
        drain(&mut ix, &doc);
        assert!(!ix.games.contains_key(&t2) && !ix.awake.contains(&t2) && ix.mine_quiet.is_empty());
        assert_eq!(ix.take_gone(), BTreeSet::from([t2.clone()]));
        assert!(ix.take_gone().is_empty());
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
        ix.hush(&("t1".to_string(), INC.to_string()), Quiet::Records);
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
    fn games_none_of_whose_rounds_are_this_houses_wake_once_its_own_key_holds_another_good_delegation_their_holder_signed() {
        let doc = Doc::new();
        for t in ["t1", "t2", "t3", "t4"] {
            put(&doc, &ck(t, 1), Any::Bool(true));
        }
        let mut ix = FairIndex::attach(&doc);
        drain(&mut ix, &doc);
        let key = |t: &str| (t.to_string(), INC.to_string());
        let held = |ks: &[&str]| Quiet::Mine(ks.iter().map(|k| k.to_string()).collect());
        let good = |hash: &str, k: &str| Some((hash.to_string(), k.to_string()));
        let awake = |ix: &FairIndex| ix.awake.iter().map(|(t, _)| t.clone()).collect::<Vec<_>>();
        assert_eq!(ix.awake.len(), 4, "every game awake at first");
        ix.mine_is(good("a", "ann"));
        ix.hush(&key("t1"), held(&["ann", "bob"]));
        ix.hush(&key("t2"), Quiet::Records);
        ix.hush(&key("t4"), held(&["cat"]));
        assert_eq!(awake(&ix), ["t3"]);
        ix.mine_is(good("a", "ann"));
        assert_eq!(awake(&ix), ["t3"], "the same: nothing wakes");
        // (None there, or one whose signature fails: nothing wakes, however often it changes.)
        ix.mine_is(None);
        assert_eq!(awake(&ix), ["t3"]);
        // (Another, signed by a key holding none of their rounds: nothing wakes either.)
        ix.mine_is(good("d", "dan"));
        assert_eq!(awake(&ix), ["t3"]);
        // One a key holding one of t1's rounds signed: t1 wakes, and out from under every key it was passed by under.
        ix.mine_is(good("b", "bob"));
        assert_eq!(awake(&ix), ["t1", "t3"]);
        assert_eq!(ix.games[&key("t1")].quiet, None);
        assert_eq!(ix.games[&key("t2")].quiet, Some(Quiet::Records));
        assert_eq!(ix.games[&key("t4")].quiet, Some(held(&["cat"])));
        assert_eq!(ix.mine_quiet.keys().cloned().collect::<Vec<_>>(), ["cat"]);
        // (Passed by for its records now, it is no longer under the keys it was.)
        ix.hush(&key("t1"), held(&["ann"]));
        ix.hush(&key("t1"), Quiet::Records);
        assert_eq!(ix.mine_quiet.keys().cloned().collect::<Vec<_>>(), ["cat"]);
        put(&doc, &ck("t1", 1), Any::Bool(true));
        drain(&mut ix, &doc);
        // (Hushed again under it, it sleeps until the next change.)
        ix.hush(&key("t1"), held(&["bob"]));
        ix.mine_is(good("b", "bob"));
        assert_eq!(awake(&ix), ["t3"]);
        // (One woken by a record of its own is no longer among them: passed by after for its records, a change of the
        // key does not wake it.)
        put(&doc, &ck("t1", 1), Any::Bool(false));
        drain(&mut ix, &doc);
        assert!(!ix.mine_quiet.contains_key("bob"));
        ix.hush(&key("t1"), Quiet::Records);
        ix.mine_is(good("c", "bob"));
        assert_eq!(awake(&ix), ["t3"]);
        ix.mine_is(good("e", "cat"));
        assert_eq!(awake(&ix), ["t3", "t4"]);
        assert!(ix.mine_quiet.is_empty());
    }

    #[test]
    fn the_turn_goes_round_the_awake_games() {
        let doc = Doc::new();
        for t in ["t1", "t2", "t3"] {
            put(&doc, &ck(t, 1), Any::Bool(true));
        }
        let mut ix = FairIndex::attach(&doc);
        drain(&mut ix, &doc);
        let key = |t: &str| (t.to_string(), INC.to_string());
        let order = |ix: &FairIndex| ix.order().map(|(t, _)| t.clone()).collect::<Vec<_>>();
        assert_eq!(order(&ix), ["t1", "t2", "t3"]);
        ix.pass_turn();
        assert_eq!(order(&ix), ["t2", "t3", "t1"]);
        // (The game whose turn it is passed by: the turn is the next one's, and goes on from there.)
        ix.hush(&key("t2"), Quiet::Records);
        assert_eq!(order(&ix), ["t3", "t1"]);
        ix.pass_turn();
        assert_eq!(order(&ix), ["t1", "t3"]);
        ix.pass_turn();
        assert_eq!(order(&ix), ["t3", "t1"]);
        // (Woken, it takes its place.)
        put(&doc, &ck("t2", 1), Any::Bool(false));
        drain(&mut ix, &doc);
        assert_eq!(order(&ix), ["t3", "t1", "t2"]);
        // (None awake: none's turn.)
        for t in ["t1", "t2", "t3"] {
            ix.hush(&key(t), Quiet::Records);
        }
        ix.pass_turn();
        assert_eq!(ix.turn_at, None);
        assert_eq!(ix.order().count(), 0);
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
