//! The players' pins as the pages pin them: what the watch notes of a players map, and when it
//! says it cannot know.

use super::*;
use yrs::MapPrelim;

fn entry(key: &str) -> Any {
    let mut m = HashMap::new();
    m.insert("keyB64".to_string(), Any::String(key.into()));
    Any::Map(Arc::new(m))
}

fn put(doc: &Doc, pid: &str, key: &str) {
    put_any(doc, pid, entry(key));
}

fn put_any(doc: &Doc, pid: &str, v: Any) {
    let players = doc.get_or_insert_map("players");
    let mut txn = doc.transact_mut();
    players.insert(&mut txn, pid, v);
}

fn remove(doc: &Doc, pid: &str) {
    let players = doc.get_or_insert_map("players");
    let mut txn = doc.transact_mut();
    players.remove(&mut txn, pid);
}

fn pins_of(p: &mut PlayerPins) -> BTreeMap<String, String> {
    p.view().0.into_iter().collect()
}

use std::collections::BTreeMap;
use std::sync::Arc;

/// A key the player has, by name.
fn key(n: &str) -> String {
    format!("key-of-{n}")
}

#[test]
fn the_players_already_in_the_map_are_pinned_at_once() {
    let doc = Doc::new();
    for n in ["alice", "bob"] {
        put(&doc, n, &key(n));
    }
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let (pins, settled) = p.view();
    assert_eq!(pins, vec![("alice".to_string(), key("alice")), ("bob".to_string(), key("bob"))]);
    assert!(settled);
}

#[test]
fn a_player_who_comes_is_pinned_as_the_transaction_that_brought_them_showed() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    assert_eq!(p.view(), (vec![], true), "an empty map is the whole story");
    put(&doc, "dave", &key("dave"));
    // (At once: the map is watched, not read every so often.)
    assert_eq!(pins_of(&mut p), BTreeMap::from([("dave".to_string(), key("dave"))]));
    assert!(p.view().1);
}

/// A key A that was written and then replaced by B between two looks at the map is the key the
/// pages that watched it pinned; a poll would have pinned B.
#[test]
fn the_first_key_of_a_player_is_the_one_the_map_first_showed_not_the_one_it_holds_when_looked_at() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put(&doc, "eve", "A");
    put(&doc, "eve", "B");
    assert_eq!(pins_of(&mut p)["eve"], "A");
}

/// The pages pin the first key they see: a key rewritten after it is one the fold does not count,
/// and one on which the pages may not agree (a page that saw both pinned the first; one that saw
/// only the second pinned that), so the view is not settled, and stays so.
#[test]
fn a_key_replaced_after_it_was_pinned_keeps_the_first_and_leaves_the_pins_unsettled() {
    let doc = Doc::new();
    put(&doc, "alice", "A");
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    assert!(p.view().1);
    put(&doc, "alice", "B");
    let (pins, settled) = p.view();
    assert_eq!(pins, vec![("alice".to_string(), "A".to_string())]);
    assert!(!settled);
    put(&doc, "bob", "C");
    assert!(!p.view().1, "and stays so");
    // The same key written again is no replacement.
    let doc = Doc::new();
    put(&doc, "alice", "A");
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put(&doc, "alice", "A");
    assert!(p.view().1);
}

/// A player first seen as a replaced key was pinned, by a page that saw it before, to the old one;
/// a page that saw only the new one pinned that: unsettled either way.
#[test]
fn a_player_first_seen_as_a_replacement_is_pinned_to_the_key_replaced_and_unsettled() {
    let doc = Doc::new();
    put(&doc, "alice", "A");
    put(&doc, "alice", "B");
    // (Both written before the watch: the walk sees B only.)
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    assert_eq!(pins_of(&mut p)["alice"], "B");
    assert!(p.view().1, "(a page that came after saw the same)");
    // A watch that sees the replacement as it happens:
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    {
        // One transaction inserts, another replaces: two events, the second an update.
        put(&doc, "bob", "A");
        put(&doc, "bob", "B");
    }
    assert_eq!(pins_of(&mut p)["bob"], "A");
    assert!(!p.view().1);
    // The state's own rule, with no first seen: the replaced key is the pin.
    let mut st = PinState::default();
    st.learn("carol", Some("A"), Some("B"));
    assert_eq!(st.pins.get("carol").map(String::as_str), Some("A"));
    assert!(st.contested);
    let mut st = PinState::default();
    st.learn("carol", Some("A"), Some("A"));
    assert!(!st.contested, "the same key again");
    let mut st = PinState::default();
    st.learn("carol", None, Some("B"));
    st.learn("carol", None, Some("B"));
    assert!(!st.contested);
}

#[test]
fn a_player_who_goes_keeps_the_pin_and_the_key_of_one_who_comes_back_is_compared_with_it() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put(&doc, "alice", "A");
    remove(&doc, "alice");
    assert_eq!(pins_of(&mut p)["alice"], "A", "(a page keeps the pin of a player who goes)");
    assert!(p.view().1);
    put(&doc, "alice", "A");
    assert!(p.view().1, "the same key again");
    remove(&doc, "alice");
    put(&doc, "alice", "Z");
    assert_eq!(pins_of(&mut p)["alice"], "A");
    assert!(!p.view().1, "a different key after she went");
}

#[test]
fn the_pins_are_capped_whoever_fills_the_map_and_the_view_is_then_unsettled() {
    let flood: Vec<String> = (0..MAX_FOLD_PINS + 200).map(|i| format!("p{i:05}")).collect();
    // Players that come after the watch started ...
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    {
        let players = doc.get_or_insert_map("players");
        let mut txn = doc.transact_mut();
        for n in &flood {
            players.insert(&mut txn, n.as_str(), entry(&key(n)));
        }
    }
    let (pins, settled) = p.view();
    assert_eq!(pins.len(), MAX_FOLD_PINS);
    assert!(!settled, "which of them each page pinned depends on the order it saw them in");
    // ... and players that were there before.
    let doc = Doc::new();
    for n in &flood {
        put(&doc, n, &key(n));
    }
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let (pins, settled) = p.view();
    assert_eq!(pins.len(), MAX_FOLD_PINS);
    assert!(!settled);
    // Exactly the most is no flood.
    let doc = Doc::new();
    for n in flood.iter().take(MAX_FOLD_PINS) {
        put(&doc, n, &key(n));
    }
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    assert_eq!((p.view().0.len(), p.view().1), (MAX_FOLD_PINS, true));
}

/// The pages pin a player id of at most 128 UTF-16 units and a key of 1 to 128 (casinoDoc
/// pinPlayerKeys), however the units are made up; the pins are those and no more, for players
/// there before the watch and for players that come after.
#[test]
fn only_what_the_pages_pin_is_pinned_by_the_length_of_name_and_key() {
    for early in [true, false] {
        let doc = Doc::new();
        let key = "some-key";
        let astral = "\u{1F98A}"; // two UTF-16 units, four bytes
        let euro = "\u{20AC}"; // one unit, three bytes
        let names = [
            ("a".repeat(128), true),
            ("a".repeat(129), false),
            (astral.repeat(64), true),
            (astral.repeat(65), false),
            ("\u{E9}".repeat(128), true), // two bytes, one unit
            (euro.repeat(128), true),      // three bytes, one unit: the longest there is
            (euro.repeat(129), false),
            ("x".repeat(100_000), false),
            (String::new(), false),
        ];
        let keys = [
            ("k128", "k".repeat(128), true),
            ("k129", "k".repeat(129), false),
            ("kempty", String::new(), false),
            ("kastral", astral.repeat(64), true),
            ("kastral65", astral.repeat(65), false),
            ("keuro", euro.repeat(128), true),
            ("keuro129", euro.repeat(129), false),
            ("khuge", "k".repeat(100_000), false),
        ];
        let write = |doc: &Doc| {
            let players = doc.get_or_insert_map("players");
            let mut txn = doc.transact_mut();
            for (n, _) in &names {
                players.insert(&mut txn, n.as_str(), entry(key));
            }
            for (n, k, _) in &keys {
                players.insert(&mut txn, *n, entry(k));
            }
            // No key at all, and a key that is not a string.
            let mut m = HashMap::new();
            m.insert("name".to_string(), Any::String("x".into()));
            players.insert(&mut txn, "nokey", Any::Map(Arc::new(m)));
            let mut m = HashMap::new();
            m.insert("keyB64".to_string(), Any::BigInt(7));
            players.insert(&mut txn, "intkey", Any::Map(Arc::new(m)));
            players.insert(&mut txn, "notamap", Any::String("x".into()));
        };
        let mut p = if early {
            write(&doc);
            PlayerPins::attach(&doc, PIN_WALK_KEYS)
        } else {
            let p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
            write(&doc);
            p
        };
        let (pins, settled) = p.view();
        let pins: BTreeMap<String, String> = pins.into_iter().collect();
        for (n, ok) in &names {
            assert_eq!(pins.contains_key(n), *ok, "early={early}: a name of {} units, {} bytes", n.encode_utf16().count(), n.len());
        }
        for (n, _, ok) in &keys {
            assert_eq!(pins.contains_key(*n), *ok, "early={early}: {n}");
        }
        for n in ["nokey", "intkey", "notamap"] {
            assert!(!pins.contains_key(n), "early={early}: {n}");
        }
        assert!(settled, "early={early}: what the pages do not pin is nothing to settle");
    }
}

/// A map longer than the walk that reads it when the watch starts: the players past it are
/// unknown, so the pins are not settled (a map of exactly the walk is).
#[test]
fn a_players_map_longer_than_the_walk_is_unsettled() {
    let doc = Doc::new();
    for n in ["a", "b", "c", "d", "e"] {
        put(&doc, n, n);
    }
    let mut p = PlayerPins::attach(&doc, 5);
    assert_eq!((p.view().0.len(), p.view().1), (5, true), "exactly the walk");
    let mut p = PlayerPins::attach(&doc, 4);
    let (pins, settled) = p.view();
    assert!(!settled);
    assert!(pins.len() <= 4);
    // A walk that is unsettled stays so, whatever comes after.
    put(&doc, "f", "f");
    assert!(!p.view().1);
}

/// What does not change a pin costs a lookup, and the view hands the same list back without sorting it again.
#[test]
fn the_view_is_rebuilt_only_when_a_pin_changed() {
    let doc = Doc::new();
    put(&doc, "alice", "A");
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let v0 = lock(&p.shared).version;
    p.view();
    assert_eq!(p.cache.as_ref().map(|c| c.0), Some(v0));
    put(&doc, "alice", "A");
    p.view();
    assert_eq!(lock(&p.shared).version, v0, "the same key again moves nothing");
    put(&doc, "bob", "B");
    assert_eq!(lock(&p.shared).version, v0 + 1);
    assert_eq!(p.view().0.len(), 2);
    assert_eq!(p.cache.as_ref().map(|c| c.0), Some(v0 + 1));
}

/// Entries of other maps in the doc (or nested in the players') are none of the watch's.
#[test]
fn nothing_but_the_players_map_is_watched() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let other = doc.get_or_insert_map("roomInfo");
    let players = doc.get_or_insert_map("players");
    let nested = {
        let mut txn = doc.transact_mut();
        other.insert(&mut txn, "alice", entry("A"));
        // A player whose value is a shared map, not a plain entry.
        players.insert(&mut txn, "nested", MapPrelim::default())
    };
    // (A later transaction: a map made in the transaction that fills it shows no event of its own.)
    {
        let mut txn = doc.transact_mut();
        nested.insert(&mut txn, "bob", entry("B"));
    }
    assert!(p.view().0.is_empty(), "a map inside the players map is not a player's entry");
    assert!(p.view().1);
}

#[test]
fn a_player_the_walk_did_not_reach_is_pinned_to_the_key_a_change_replaced() {
    // (Past the walk the pins are not the whole story. A change that replaces a key still shows the
    // key it replaced, which a page that had seen the player pinned.)
    let doc = Doc::new();
    put(&doc, "alice", "A");
    let mut p = PlayerPins::attach(&doc, 0);
    assert!(!p.view().1, "the map held more than the walk read");
    put(&doc, "alice", "B");
    assert_eq!(pins_of(&mut p), BTreeMap::from([("alice".to_string(), "A".to_string())]));
}

#[test]
fn a_callback_that_panicked_leaves_the_pins_as_they_were() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put(&doc, "alice", "A");
    let shared = p.shared.clone();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _g = shared.lock().unwrap();
        panic!("a callback went wrong");
    }));
    assert!(r.is_err());
    put(&doc, "bob", "B");
    assert_eq!(p.view().0.len(), 2, "the poisoned lock is used as it stands");
}
