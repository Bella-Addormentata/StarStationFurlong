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
    st.learn("carol", Key::Pin("A"), Key::Pin("B"));
    assert_eq!(st.pins.get("carol").map(String::as_str), Some("A"));
    assert!(st.contested);
    let mut st = PinState::default();
    st.learn("carol", Key::Pin("A"), Key::Pin("A"));
    assert!(!st.contested, "the same key again");
    let mut st = PinState::default();
    st.learn("carol", Key::None, Key::Pin("B"));
    st.learn("carol", Key::None, Key::Pin("B"));
    assert!(!st.contested);
}

/// A page that bound before keeps the pin of a player who goes, and one that binds after has none: the node keeps the pin
/// and cannot say which the pages used, and a key that comes back is compared with it.
#[test]
fn a_player_who_goes_keeps_the_pin_and_leaves_the_pins_unsettled_and_the_key_of_one_who_comes_back_is_compared_with_it() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put(&doc, "alice", "A");
    assert!(p.view().1);
    remove(&doc, "alice");
    assert_eq!(pins_of(&mut p)["alice"], "A", "(a page keeps the pin of a player who goes)");
    assert!(!p.view().1, "(and a page that binds after has none)");
    // It stays so, whatever she does after.
    put(&doc, "alice", "A");
    assert!(!p.view().1);
    assert_eq!(pins_of(&mut p)["alice"], "A");
}

/// The same when the entry stays and no longer gives a key the pages pin: dropped, emptied, too long for a page, or the
/// whole entry made another kind of value. And a player no page pins (a key none reads, an id past what a page keeps) who
/// goes is nothing.
#[test]
fn a_pinned_player_whose_entry_stops_supplying_the_key_leaves_the_pins_unsettled() {
    let keyless = || Any::Map(Arc::new(HashMap::from([("name".to_string(), Any::String("x".into()))])));
    let too_long = "k".repeat(MAX_PIN_KEY_UNITS + 1);
    let cases: Vec<(&str, Any)> = vec![
        ("the key dropped", keyless()),
        ("the key emptied", entry("")),
        ("the key too long", entry(&too_long)),
        ("the entry not a map", Any::String("gone".into())),
        ("the entry null", Any::Null),
    ];
    for (name, after) in cases {
        let doc = Doc::new();
        let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
        put(&doc, "alice", "A");
        assert!(p.view().1, "{name}");
        put_any(&doc, "alice", after);
        assert_eq!(pins_of(&mut p)["alice"], "A", "{name}: the pin is kept");
        assert!(!p.view().1, "{name}");
    }
    // A player the pages never pinned who goes: nothing. (A key none reads; an id past what a page keeps.)
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put(&doc, "bob", "");
    put(&doc, &"x".repeat(MAX_PIN_PID_UNITS + 1), "A");
    remove(&doc, "bob");
    remove(&doc, &"x".repeat(MAX_PIN_PID_UNITS + 1));
    assert!(pins_of(&mut p).is_empty());
    assert!(p.view().1, "nothing a page pins is in doubt");
    // The rule of the state, on its own: a key kept, a key gone, a key replaced.
    let mut st = PinState::default();
    st.learn("carol", Key::None, Key::Pin("C"));
    st.learn("carol", Key::Pin("C"), Key::Pin("C"));
    assert!(!st.contested, "the same key again");
    st.learn("carol", Key::Pin("C"), Key::None);
    assert!(st.contested, "the key gone");
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

// ── Review round 3 ───────────────────────────────────────────────────────────

/// An entry with a `__proto__` field, as a peer can write one: a page reads `v.keyB64` with a property
/// access, which a prototype the field sets can answer, and the node reads the entry's own fields.
fn entry_with_proto(key: &str) -> Any {
    let mut m = HashMap::new();
    m.insert("keyB64".to_string(), Any::String(key.into()));
    m.insert("__proto__".to_string(), Any::Map(Arc::new(HashMap::new())));
    Any::Map(Arc::new(m))
}

/// What a page makes of such an entry cannot be told from the doc, so the pins are not the whole story.
#[test]
fn an_entry_with_a_proto_field_leaves_the_pins_unsettled_whenever_the_node_sees_it() {
    // Coming after the watch ...
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put_any(&doc, "alice", entry_with_proto("A"));
    let (pins, settled) = p.view();
    assert!(!settled);
    assert!(pins.is_empty(), "(and no key is pinned from it)");
    put(&doc, "bob", "B");
    assert!(!p.view().1, "and it stays so");
    // ... there before ...
    let doc = Doc::new();
    put_any(&doc, "alice", entry_with_proto("A"));
    assert!(!PlayerPins::attach(&doc, PIN_WALK_KEYS).view().1);
    // ... a clean entry replaced by one ...
    let doc = Doc::new();
    put(&doc, "alice", "A");
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    assert!(p.view().1);
    put_any(&doc, "alice", entry_with_proto("A"));
    assert!(!p.view().1);
    // ... and one that has it replaced by a clean one.
    let doc = Doc::new();
    put_any(&doc, "alice", entry_with_proto("A"));
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put(&doc, "alice", "A");
    assert!(!p.view().1);
}

/// The ambiguity is a player's: a name the pages do not pin is nothing to doubt, and an entry with other
/// extra fields is a plain entry.
#[test]
fn only_a_proto_field_of_a_player_the_pages_pin_is_doubted() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put_any(&doc, "", entry_with_proto("A"));
    put_any(&doc, &"x".repeat(129), entry_with_proto("A"));
    assert!(p.view().1, "a name of no pin");
    let mut m = HashMap::new();
    m.insert("keyB64".to_string(), Any::String("B".into()));
    m.insert("name".to_string(), Any::String("n".into()));
    m.insert("_proto_".to_string(), Any::Null);
    put_any(&doc, "bob", Any::Map(Arc::new(m)));
    let (pins, settled) = p.view();
    assert!(settled);
    assert_eq!(pins, vec![("bob".to_string(), "B".to_string())]);
}

/// A player who went before the watch had read the map was seen by the pages, and pinned as they pinned
/// him: the key of the entry that goes is his pin. (The window is small: the watch is on before the walk;
/// but a player removed in it, or one past a walk that fell short, is learned from the removal.)
#[test]
fn a_player_removed_before_the_walk_reached_him_is_pinned_to_the_key_he_had() {
    let doc = Doc::new();
    put(&doc, "alice", "A");
    let mut p = PlayerPins::attach(&doc, 0);
    remove(&doc, "alice");
    assert_eq!(pins_of(&mut p), BTreeMap::from([("alice".to_string(), "A".to_string())]));
    // The state's own rule: the key of the entry that goes is the pin when there is none, and moves nothing when there is.
    let mut st = PinState::default();
    st.learn("bob", Key::Pin("B"), Key::None);
    assert_eq!(st.pins.get("bob").map(String::as_str), Some("B"));
    assert!(st.contested, "(a page that binds after pinned none: the pages differ)");
    let (version, epoch) = (st.version, st.epoch);
    st.learn("bob", Key::Pin("B"), Key::None);
    st.learn("bob", Key::None, Key::None);
    assert_eq!((st.version, st.epoch), (version, epoch), "learned once");
    // An entry that goes with no key a page would pin is nothing.
    let mut st = PinState::default();
    st.learn("carol", Key::None, Key::None);
    assert!(!st.pins.contains_key("carol"));
    assert!(!st.contested);
}

/// The epoch moves with what a view says, and with nothing else: a table shown whole while the pins stood
/// at one epoch is not shown whole at another.
#[test]
fn the_epoch_moves_with_a_pin_and_with_the_pins_ceasing_to_be_the_whole_story_and_with_nothing_else() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let watch = p.watch();
    let e0 = watch.epoch();
    assert_eq!(p.view_at().2, e0);
    put(&doc, "alice", "A");
    let e1 = watch.epoch();
    assert!(e1 > e0, "a pin");
    assert_eq!(p.view_at().2, e1, "(the epoch of the view is the one the pins were read at)");
    put(&doc, "alice", "A");
    put(&doc, "bob", "");
    assert_eq!(watch.epoch(), e1, "the same key, a key no page pins: nothing the view says");
    put(&doc, "alice", "B");
    let e2 = watch.epoch();
    assert!(e2 > e1, "a key replaced");
    put(&doc, "alice", "C");
    assert_eq!(watch.epoch(), e2, "(unsettled already)");
    // A player who goes: the pages that bind after have no pin for him.
    let doc2 = Doc::new();
    let p2 = PlayerPins::attach(&doc2, PIN_WALK_KEYS);
    let watch2 = p2.watch();
    put(&doc2, "alice", "A");
    let f1 = watch2.epoch();
    remove(&doc2, "alice");
    let f2 = watch2.epoch();
    assert!(f2 > f1, "a pinned player who goes");
    put(&doc2, "alice", "A");
    remove(&doc2, "alice");
    assert_eq!(watch2.epoch(), f2, "(unsettled already)");
    // An entry that makes the pins doubtful, and the cap.
    let doc = Doc::new();
    let p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let watch = p.watch();
    let e0 = watch.epoch();
    put_any(&doc, "alice", entry_with_proto("A"));
    assert!(watch.epoch() > e0, "an entry that cannot be read as the pages read it");
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let watch = p.watch();
    for i in 0..MAX_FOLD_PINS {
        put(&doc, &format!("p{i:05}"), "k");
    }
    let before = watch.epoch();
    put(&doc, "one-too-many", "k");
    assert!(watch.epoch() > before, "the cap reached");
    let at_cap = watch.epoch();
    put(&doc, "another", "k");
    assert_eq!(watch.epoch(), at_cap);
    let _ = p.view();
}

/// The read of the players already in the map is held to a time as well as a count, when the node says so: a map that
/// takes longer is not WALKED, as one past the count is, and what the pages pinned of the rest is unknown.
#[test]
fn a_players_map_that_takes_longer_than_the_walk_time_is_unsettled() {
    let doc = Doc::new();
    for i in 0..200 {
        put(&doc, &format!("p{i:03}"), &key(&format!("{i}")));
    }
    let mut p = PlayerPins::attach_timed(&doc, PIN_WALK_KEYS, None);
    assert_eq!((p.view().0.len(), p.view().1), (200, true), "no time limit: all of it");
    let mut p = PlayerPins::attach_timed(&doc, PIN_WALK_KEYS, Some(Duration::from_secs(60)));
    assert_eq!((p.view().0.len(), p.view().1), (200, true), "a limit it does not reach");
    let mut p = PlayerPins::attach_timed(&doc, PIN_WALK_KEYS, Some(Duration::ZERO));
    let (pins, settled) = p.view();
    assert!(!settled, "no time at all: the walk stops where it first looks at the clock");
    assert!(pins.len() < 200 && pins.len() >= WALK_CLOCK_EVERY - 1, "{}", pins.len());
    // It stays unsettled, whatever comes after.
    put(&doc, "late", "late");
    assert!(!p.view().1);
    // A map shorter than the clock's look is read whole, whatever the time: the cost is bounded by the look.
    let small = Doc::new();
    for i in 0..(WALK_CLOCK_EVERY - 1) {
        put(&small, &format!("p{i:03}"), &key(&format!("{i}")));
    }
    let mut p = PlayerPins::attach_timed(&small, PIN_WALK_KEYS, Some(Duration::ZERO));
    assert_eq!((p.view().0.len(), p.view().1), (WALK_CLOCK_EVERY - 1, true));
    // The node's own watch carries the time.
    assert_eq!(PIN_WALK_TIME, Duration::from_millis(20));
}

// ── Review round 5 ───────────────────────────────────────────────────────────

/// The walk's time is the doc's held for the read: a write being committed holds the read up, and the wait is not
/// counted. (A map of 200 is read in a moment; held up for far longer than the walk may take, it is still read whole.)
#[test]
fn the_walk_time_is_the_time_the_doc_is_read_for_and_not_the_wait_for_the_doc() {
    let doc = Doc::new();
    for i in 0..200 {
        put(&doc, &format!("p{i:03}"), &key(&format!("{i}")));
    }
    let shared = Arc::new(Mutex::new(PinState::default()));
    let (tx, rx) = std::sync::mpsc::channel();
    let writer = {
        let doc = doc.clone();
        std::thread::spawn(move || {
            let txn = doc.transact_mut();
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(400));
            drop(txn);
        })
    };
    rx.recv().unwrap();
    let began = Instant::now();
    let walked = walk(&doc, &shared, PIN_WALK_KEYS, Some(Duration::from_millis(100)));
    assert!(began.elapsed() > Duration::from_millis(200), "(the read did wait for the write: {:?})", began.elapsed());
    writer.join().unwrap();
    assert!(walked, "a wait for the doc is not a slow read of it");
    assert_eq!(lock(&shared).pins.len(), 200);
}

fn owner_map(doc: &Doc) -> yrs::MapRef {
    doc.get_or_insert_map("roomInfo")
}

fn set_owner(doc: &Doc, v: &str) {
    let info = owner_map(doc);
    let mut txn = doc.transact_mut();
    info.insert(&mut txn, "owner", v);
}

/// The deed holder is watched with the pins: read when the watch starts, and noted when it changes, and a change moves
/// the epoch (the houses every page counts are the holder's).
#[test]
fn the_deed_holder_is_watched_and_a_change_of_holder_moves_the_epoch() {
    let doc = Doc::new();
    set_owner(&doc, "alice");
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    assert_eq!(p.deed(), Some("alice".to_string()), "read when the watch starts");
    let epoch = p.view_at().2;
    assert_eq!(epoch, 0, "(and that moves nothing)");
    // The same holder written again is no change.
    set_owner(&doc, "alice");
    assert_eq!(p.view_at().2, epoch);
    // The deed changes hands.
    set_owner(&doc, "bob");
    let (_, settled, now, deed) = p.view_full();
    assert_eq!((deed, now), (Some("bob".to_string()), epoch + 1));
    assert!(settled, "(the pins are not doubted by it)");
    // A holder no house can stand under: none, an empty name, or the placeholder of a clone made on the spot.
    for (value, name) in [("", "empty"), ("Local-Clone", "a local clone")] {
        set_owner(&doc, "carol");
        let before = p.view_at().2;
        set_owner(&doc, value);
        assert_eq!(p.deed(), None, "{name}");
        assert_eq!(p.view_at().2, before + 1, "{name}");
    }
    {
        let info = owner_map(&doc);
        set_owner(&doc, "dave");
        let before = p.view_at().2;
        let mut txn = doc.transact_mut();
        info.remove(&mut txn, "owner");
        drop(txn);
        assert_eq!(p.deed(), None, "removed");
        assert_eq!(p.view_at().2, before + 1);
    }
    // Another key of the room's info is no concern.
    let before = p.view_at().2;
    {
        let info = owner_map(&doc);
        let mut txn = doc.transact_mut();
        info.insert(&mut txn, "name", "the room");
    }
    assert_eq!(p.view_at().2, before);
}

/// A room with no deed holder named yet, and one that gets it.
#[test]
fn a_room_that_names_no_deed_holder_at_first_is_told_when_it_does() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    assert_eq!(p.deed(), None);
    set_owner(&doc, "alice");
    assert_eq!(p.deed(), Some("alice".to_string()));
    assert_eq!(p.view_at().2, 1);
}

// ── Review round 6 ───────────────────────────────────────────────────────────

fn apply_update(doc: &Doc, update: &[u8]) {
    use yrs::updates::decoder::Decode;
    doc.transact_mut().apply_update(yrs::Update::decode_v1(update).unwrap()).unwrap();
}

/// All a peer's doc holds, as the one update a node away from the room may be sent.
fn everything(peer: &Doc) -> Vec<u8> {
    peer.transact().encode_diff_v1(&yrs::StateVector::default())
}

/// A key written and written over in one update (the node was away, or the updates were merged on the way) shows the node
/// only the last; a page that saw the first on its own pinned that. The update says that something was made and deleted in
/// it, and a player first pinned from it is doubted, as a key replaced is.
#[test]
fn a_player_first_pinned_from_an_update_in_which_something_was_made_and_deleted_is_doubted() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let peer = Doc::with_client_id(9);
    put(&peer, "eve", "A");
    put(&peer, "eve", "B");
    apply_update(&doc, &everything(&peer));
    assert_eq!(pins_of(&mut p)["eve"], "B", "the node sees the last");
    assert!(!p.view().1, "and cannot say what the first was");
    // It stays so, whatever comes after.
    put(&doc, "bob", &key("bob"));
    assert!(!p.view().1);
}

/// And the same player written once, or the update made and deleted nothing the doc did not hold, is no doubt.
#[test]
fn a_player_first_pinned_from_an_update_in_which_nothing_was_made_and_deleted_is_not() {
    // Written once.
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let peer = Doc::with_client_id(9);
    put(&peer, "eve", "A");
    apply_update(&doc, &everything(&peer));
    assert_eq!(pins_of(&mut p)["eve"], "A");
    assert!(p.view().1);
    // An update that deletes what the doc already had (a record elsewhere written over) and brings a new player.
    let other = peer.get_or_insert_map("elsewhere");
    {
        let mut txn = peer.transact_mut();
        other.insert(&mut txn, "k", 1);
    }
    apply_update(&doc, &everything(&peer));
    let before = doc.transact().state_vector();
    {
        let mut txn = peer.transact_mut();
        other.insert(&mut txn, "k", 2);
    }
    put(&peer, "bob", &key("bob"));
    let update = peer.transact().encode_diff_v1(&before);
    apply_update(&doc, &update);
    assert_eq!(pins_of(&mut p)["bob"], key("bob"));
    assert!(p.view().1, "the block deleted was one the doc had: nothing was made and deleted in the update");
}

/// A player the watch has pinned already, written again in such an update with the key it has, is doubted too: the
/// update may have put another key between, which a page that bound while it stood pinned, and the node sees the key it
/// has either way. (Round 7: it was a player first pinned that was doubted.)
#[test]
fn a_player_pinned_already_is_doubted_when_an_update_of_made_and_deleted_brings_the_same_key_back() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let peer = Doc::with_client_id(9);
    put(&peer, "eve", "A");
    apply_update(&doc, &everything(&peer));
    assert!(p.view().1, "(first seen plainly)");
    // The peer, with all the node has, writes another key and puts the first back: the node is sent the two together.
    apply_update(&peer, &everything(&doc));
    let before = doc.transact().state_vector();
    put(&peer, "eve", "B");
    put(&peer, "eve", "A");
    apply_update(&doc, &peer.transact().encode_diff_v1(&before));
    assert_eq!(pins_of(&mut p)["eve"], "A", "the key it holds and the key it pinned");
    assert!(!p.view().1, "and a page that bound while B stood pinned B");
}

/// Whatever the entry holds after: a key that is not the pin, none, or the entry gone.
#[test]
fn a_pinned_player_changed_in_an_update_of_made_and_deleted_is_doubted_whatever_the_entry_holds_after() {
    let keyless = || Any::Map(Arc::new(HashMap::from([("other".to_string(), Any::Number(1.0))])));
    // After the key stays (pinned A), what a merged update leaves of 'eve' as seen by the node: another key kept (an
    // update, not a replacement of a pin the node saw: the same case as a key replaced), none, the entry removed.
    let cases: Vec<(&str, Option<Any>)> = vec![("the same key", Some(entry("A"))), ("another key", Some(entry("Z"))), ("no key", Some(keyless())), ("removed", None)];
    for (name, after) in cases {
        let doc = Doc::new();
        let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
        let peer = Doc::with_client_id(9);
        put(&peer, "eve", "A");
        apply_update(&doc, &everything(&peer));
        assert!(p.view().1, "{name}");
        // The pins are contested by 'another key', 'no key' and 'removed' on their own: the case is what the rule adds
        // (and what the state says of the key is not asked: the transaction is).
        let before = doc.transact().state_vector();
        put(&peer, "eve", "B");
        match after {
            Some(v) => put_any(&peer, "eve", v),
            None => remove(&peer, "eve"),
        }
        apply_update(&doc, &peer.transact().encode_diff_v1(&before));
        assert!(!p.view().1, "{name}");
    }
}

/// A player whose entry has no key, removed in an update where something was made and deleted: a key may have been
/// written between, which a page that saw it pinned, and a removal leaves the node nothing of it.
#[test]
fn a_player_with_no_key_who_goes_in_an_update_of_made_and_deleted_is_doubted() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let peer = Doc::with_client_id(9);
    let keyless = || Any::Map(Arc::new(HashMap::from([("other".to_string(), Any::Number(1.0))])));
    put_any(&peer, "eve", keyless());
    apply_update(&doc, &everything(&peer));
    assert!(p.view().1, "(a player with no key is nothing)");
    let before = doc.transact().state_vector();
    put(&peer, "eve", "A");
    remove(&peer, "eve");
    apply_update(&doc, &peer.transact().encode_diff_v1(&before));
    assert!(pins_of(&mut p).is_empty());
    assert!(!p.view().1, "a page that saw the key pinned it");
    // A removal of the same player in a plain update is nothing.
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    put_any(&doc, "eve", keyless());
    remove(&doc, "eve");
    assert!(p.view().1);
}

/// A merged update that brings or changes a player no page would pin is nothing: an id past what a page keeps.
#[test]
fn a_player_no_page_pins_is_not_doubted_for_an_update_of_made_and_deleted() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let peer = Doc::with_client_id(9);
    let long = "x".repeat(MAX_PIN_PID_UNITS + 1);
    put(&peer, &long, "A");
    put(&peer, &long, "B");
    put(&peer, "", "A");
    put(&peer, "", "B");
    apply_update(&doc, &everything(&peer));
    assert!(pins_of(&mut p).is_empty(), "{:?}", pins_of(&mut p));
    assert!(p.view().1, "nothing a page pins is in doubt");
}

/// A pinnable player with no key at all is doubted by such an update: a merged update may have hidden a key between.
#[test]
fn a_player_with_no_key_in_an_update_of_made_and_deleted_is_doubted() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let peer = Doc::with_client_id(9);
    let keyless = || Any::Map(Arc::new(HashMap::from([("other".to_string(), Any::Number(1.0))])));
    put(&peer, "eve", "A");
    put_any(&peer, "eve", keyless());
    apply_update(&doc, &everything(&peer));
    assert!(pins_of(&mut p).is_empty());
    assert!(!p.view().1, "a page that saw the key between pinned it");
}

/// An update in which something else was made and deleted doubts a player it brings once, because it cannot be told
/// what was deleted (the harmless ones are doubted too).
#[test]
fn a_player_brought_by_an_update_in_which_something_else_was_made_and_deleted_is_doubted_too() {
    let doc = Doc::new();
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let peer = Doc::with_client_id(9);
    let other = peer.get_or_insert_map("elsewhere");
    {
        let mut txn = peer.transact_mut();
        other.insert(&mut txn, "k", 1);
        other.insert(&mut txn, "k", 2);
    }
    put(&peer, "eve", "A");
    apply_update(&doc, &everything(&peer));
    assert_eq!(pins_of(&mut p)["eve"], "A");
    assert!(!p.view().1);
}

// ── Review round 7 ───────────────────────────────────────────────────────────

fn remove_owner(doc: &Doc) {
    let info = owner_map(doc);
    let mut txn = doc.transact_mut();
    info.remove(&mut txn, "owner");
}

/// The deed changing hands is counted, as the epoch moves with it: every change of holder, and nothing else (the holder
/// written again as it stands, another key of the room's info, the walk that reads the holder when the watch starts).
#[test]
fn the_handovers_of_the_deed_are_counted() {
    let doc = Doc::new();
    set_owner(&doc, "alice");
    let p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let watch = p.watch();
    assert_eq!(watch.deeds(), 0, "(the holder read when the watch starts is no handover)");
    set_owner(&doc, "alice");
    assert_eq!(watch.deeds(), 0, "the same holder again");
    set_owner(&doc, "bob");
    assert_eq!(watch.deeds(), 1);
    set_owner(&doc, "alice");
    assert_eq!(watch.deeds(), 2, "and back: two handovers");
    remove_owner(&doc);
    assert_eq!(watch.deeds(), 3, "no holder");
    {
        let info = owner_map(&doc);
        let mut txn = doc.transact_mut();
        info.insert(&mut txn, "name", "the room");
    }
    assert_eq!(watch.deeds(), 3, "another key of the room's info");
    put(&doc, "alice", "A");
    assert_eq!(watch.deeds(), 3, "a player");
}

/// The same holder in the doc after an update that gave the deed to another and gave it back: the doc does not say it
/// changed hands, and a page that saw the middle holder counted that one's houses. The epoch and the count move, though
/// the holder is the one the watch had.
#[test]
fn a_handover_hidden_in_one_update_is_counted_though_the_doc_names_the_same_holder() {
    let doc = Doc::new();
    let peer = Doc::with_client_id(9);
    set_owner(&peer, "alice");
    apply_update(&doc, &everything(&peer));
    let mut p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let watch = p.watch();
    let (deeds, epoch) = (watch.deeds(), watch.epoch());
    apply_update(&peer, &everything(&doc));
    let before = doc.transact().state_vector();
    set_owner(&peer, "bob");
    set_owner(&peer, "alice");
    apply_update(&doc, &peer.transact().encode_diff_v1(&before));
    assert_eq!(p.deed(), Some("alice".to_string()), "(the holder the doc names)");
    assert_eq!((watch.deeds(), watch.epoch()), (deeds + 1, epoch + 1));
    // The same, seen as two updates: two handovers, as the doc shows them.
    set_owner(&doc, "bob");
    set_owner(&doc, "alice");
    assert_eq!(watch.deeds(), deeds + 3);
    let _ = p.view();
}

/// An update that writes the holder once, and made and deleted something elsewhere, is doubted too (it cannot be told
/// what was deleted); one that deletes only what the node had is a plain rewrite, and no handover.
#[test]
fn a_holder_written_in_an_update_is_doubted_only_when_something_in_it_was_made_and_deleted() {
    let doc = Doc::new();
    let peer = Doc::with_client_id(9);
    set_owner(&peer, "alice");
    apply_update(&doc, &everything(&peer));
    let p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let watch = p.watch();
    // The holder written again, deleting the block the node had.
    let before = doc.transact().state_vector();
    apply_update(&peer, &everything(&doc));
    set_owner(&peer, "alice");
    apply_update(&doc, &peer.transact().encode_diff_v1(&before));
    assert_eq!(watch.deeds(), 0, "a plain rewrite");
    // And with something made and deleted beside it.
    let before = doc.transact().state_vector();
    let other = peer.get_or_insert_map("elsewhere");
    {
        let mut txn = peer.transact_mut();
        other.insert(&mut txn, "k", 1);
    }
    {
        let mut txn = peer.transact_mut();
        other.insert(&mut txn, "k", 2);
    }
    set_owner(&peer, "alice");
    apply_update(&doc, &peer.transact().encode_diff_v1(&before));
    assert_eq!(watch.deeds(), 1, "(it cannot be told that nothing came and went in the holder's key)");
}

/// A record made and deleted in the room's info leaves no key to read: if the holder was it, the doc names no holder
/// before or after and a page that saw one counted that one's houses.
#[test]
fn a_change_to_the_room_info_that_leaves_no_key_is_a_handover_when_something_was_made_and_deleted() {
    let doc = Doc::new();
    let peer = Doc::with_client_id(9);
    set_owner(&peer, "alice");
    set_owner(&peer, "alice");
    apply_update(&doc, &everything(&peer));
    let p = PlayerPins::attach(&doc, PIN_WALK_KEYS);
    let watch = p.watch();
    apply_update(&peer, &everything(&doc));
    let before = doc.transact().state_vector();
    for _ in 0..2 {
        let info = owner_map(&peer);
        let mut txn = peer.transact_mut();
        info.insert(&mut txn, "scratch", 1);
    }
    {
        let info = owner_map(&peer);
        let mut txn = peer.transact_mut();
        info.remove(&mut txn, "scratch");
    }
    let epoch = watch.epoch();
    apply_update(&doc, &peer.transact().encode_diff_v1(&before));
    assert_eq!((watch.deeds(), watch.epoch()), (1, epoch + 1), "(and what the views of the pins say moves with it)");
}
