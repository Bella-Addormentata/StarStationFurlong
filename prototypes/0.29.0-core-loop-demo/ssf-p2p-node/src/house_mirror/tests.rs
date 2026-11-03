//! The mirror against a real doc, built as the pages build it: the root
//! `casinoComputed` map, a nested map per session, records as plain values.

use super::*;
use crate::house::to_any;
use std::sync::Arc;
use yrs::{Any, MapPrelim, Transact};

const ROOM: &str = "room";
const T: &str = "t1";
const INC: &str = "r0123456789abcdef01234567";

fn obj(fields: Vec<(&str, CVal)>) -> CVal {
    CVal::Obj(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn s(v: &str) -> CVal {
    CVal::Str(v.into())
}

/// Fields in order: a doc keeps them in a hash map's, so what is read back
/// has no order of its own.
fn norm(v: CVal) -> CVal {
    match v {
        CVal::Obj(fields) => {
            let mut fields: Vec<(String, CVal)> = fields.into_iter().map(|(k, x)| (k, norm(x))).collect();
            fields.sort_by(|a, b| a.0.cmp(&b.0));
            CVal::Obj(fields)
        }
        CVal::Arr(items) => CVal::Arr(items.into_iter().map(norm).collect()),
        other => other,
    }
}

fn norm_taken(mut t: Taken) -> Taken {
    t.base = t.base.map(norm);
    t.changes = t.changes.into_iter().map(|(k, v)| (k, v.map(norm))).collect();
    t
}

fn ctx(t: &str) -> Ctx {
    Ctx { room: ROOM.into(), t: t.into(), inc: INC.into() }
}

/// A checkpoint the pages take (for a house table); `u` tells them apart.
fn cp(u: i64) -> CVal {
    norm(obj(vec![("v", CVal::Int(1)), ("b", s("g")), ("u", CVal::Int(u)), ("l", s(&"a".repeat(32))), ("n", obj(vec![])), ("k", s(&"K".repeat(43))), ("g", s(&"G".repeat(86)))]))
}

fn sum_of(t: &str) -> String {
    format!("sum:{t}:{INC}")
}

/// The live session of `t` over this base.
fn live_of(t: &str, base: Option<&CVal>) -> String {
    format!("ses:{t}:{INC}:{}", hb::next_sid(&ctx(t), base).unwrap())
}

fn live0() -> String {
    live_of(T, None)
}

/// A record key of round `r`, number `i`: the shape of a close's.
fn rk(r: i64, i: u32) -> String {
    format!("c:{r}:{i:032x}")
}

fn rv(r: i64, i: i64) -> CVal {
    norm(obj(vec![("r", CVal::Int(r)), ("i", CVal::Int(i))]))
}

struct Fix {
    doc: Doc,
    m: RoomMirror,
}

impl Fix {
    /// Mirror the table from an empty doc.
    fn empty() -> Fix {
        Fix::with(Limits::default())
    }

    fn with(limits: Limits) -> Fix {
        let doc = Doc::new();
        let mut m = RoomMirror::attach_with(&doc, ROOM, limits);
        m.want(&[(T.into(), INC.into())]);
        Fix { doc, m }
    }

    /// Mirror the table of a doc that already holds it.
    fn seeded(limits: Limits, fill: impl FnOnce(&Fix)) -> Fix {
        let doc = Doc::new();
        let m = RoomMirror::attach_with(&doc, ROOM, limits);
        let mut f = Fix { doc, m };
        fill(&f);
        f.m.want(&[(T.into(), INC.into())]);
        f
    }

    fn drain(&mut self) -> Drained {
        let txn = self.doc.transact();
        self.m.drain(&txn)
    }

    /// Drain until nothing is short or waiting, taking as it goes.
    fn settle(&mut self, model: &mut Model) -> usize {
        for n in 1..=5_000 {
            let d = self.drain();
            model.take(&mut self.m, T);
            if !d.short && self.m.current(T, INC) {
                return n;
            }
        }
        panic!("never settled");
    }

    fn put_top(&self, key: &str, v: &CVal) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, to_any(v));
    }

    fn put_any(&self, key: &str, v: Any) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, v);
    }

    fn remove_top(&self, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.remove(&mut txn, key);
    }

    /// A session map under `name`, replacing one there.
    fn session(&self, name: &str, records: &[(String, CVal)]) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let m = comp.insert(&mut txn, name, MapPrelim::default());
        for (k, v) in records {
            m.insert(&mut txn, k.as_str(), to_any(v));
        }
    }

    fn put(&self, ses: &str, key: &str, v: &CVal) {
        self.put_value(ses, key, to_any(v));
    }

    fn put_value(&self, ses: &str, key: &str, v: Any) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        m.insert(&mut txn, key, v);
    }

    fn puts(&self, ses: &str, records: &[(String, CVal)]) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        for (k, v) in records {
            m.insert(&mut txn, k.as_str(), to_any(v));
        }
    }

    fn remove(&self, ses: &str, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        m.remove(&mut txn, key);
    }

    fn has_session(&self, name: &str) -> bool {
        let txn = self.doc.transact();
        txn.get_map(COMPUTED_MAP).is_some_and(|c| matches!(c.get(&txn, name), Some(Out::YMap(_))))
    }

    fn state(&self) -> State<'_> {
        self.m.state(T, INC).unwrap()
    }

    fn take(&mut self) -> Taken {
        self.m.take(T, INC, usize::MAX).map(norm_taken).expect("the table is serving")
    }
}

/// The worker's side: what applying the changes taken, in order, comes to.
#[derive(Default, Debug)]
struct Model {
    base: Option<CVal>,
    recs: BTreeMap<String, CVal>,
    resets: usize,
    taken: usize,
}

impl Model {
    /// Take what is waiting from table `t`, if it serves.
    fn take(&mut self, m: &mut RoomMirror, t: &str) {
        loop {
            let Some(got) = m.take(t, INC, 4_096) else { return };
            let more = got.more;
            self.absorb(got);
            if !more {
                return;
            }
        }
    }

    fn absorb(&mut self, got: Taken) {
        if got.reset {
            self.recs.clear();
            self.resets += 1;
        }
        let got = norm_taken(got);
        self.base = got.base;
        for (k, v) in got.changes {
            self.taken += 1;
            match v {
                Some(v) => {
                    self.recs.insert(k, v);
                }
                None => {
                    self.recs.remove(&k);
                }
            }
        }
    }
}

fn records(pairs: &[(u32, i64)]) -> Vec<(String, CVal)> {
    pairs.iter().map(|(i, v)| (rk(1, *i), rv(1, *v))).collect()
}

fn model_of(pairs: &[(u32, i64)]) -> BTreeMap<String, CVal> {
    records(pairs).into_iter().collect()
}

// ── A table already in the doc ───────────────────────────────────────────────

#[test]
fn reads_a_table_that_was_already_in_the_doc() {
    let base = cp(2);
    let live = live_of(T, Some(&base));
    let mut f = Fix::seeded(Limits::default(), |f| {
        f.put_top(&sum_of(T), &base);
        f.session(&live, &records(&[(1, 10), (2, 20), (3, 30)]));
    });
    assert!(!f.m.current(T, INC), "nothing read yet");
    let d = f.drain();
    assert!(!d.short);
    assert!(f.m.current(T, INC));
    let st = f.state();
    assert!(st.serving() && st.settled && st.present && !st.reading);
    assert_eq!(st.live, Some(live.as_str()));
    assert_eq!(st.base.cloned().map(norm), Some(base.clone()));
    assert_eq!(st.queued, 3);
    let got = f.take();
    assert!(got.reset && !got.more);
    assert_eq!(got.base, Some(base));
    assert_eq!(got.changes, records(&[(1, 10), (2, 20), (3, 30)]).into_iter().map(|(k, v)| (k, Some(v))).collect::<Vec<_>>());
    let again = f.take();
    assert!(!again.reset && again.changes.is_empty(), "the reset is said once");
}

#[test]
fn a_table_with_no_checkpoint_follows_the_first_session() {
    let mut f = Fix::seeded(Limits::default(), |f| {
        f.session(&live0(), &records(&[(1, 1)]));
        // (A "checkpoint" the pages throw out is none.)
        f.put_top(&sum_of(T), &obj(vec![("v", CVal::Int(1))]));
    });
    f.drain();
    assert_eq!(f.state().live, Some(live0().as_str()));
    assert_eq!(f.state().base, None);
    assert_eq!(f.take().changes.len(), 1);
}

// ── What changes after ───────────────────────────────────────────────────────

#[test]
fn follows_records_that_come_change_and_go() {
    let mut f = Fix::empty();
    f.drain();
    assert!(f.state().settled && !f.state().present && !f.state().serving(), "no session yet");
    assert!(f.m.take(T, INC, usize::MAX).is_none());

    f.session(&live0(), &[]);
    f.drain();
    assert!(f.state().serving());
    let first = f.take();
    assert!(first.reset && first.changes.is_empty());

    f.puts(&live0(), &records(&[(1, 10), (2, 20)]));
    f.drain();
    let v1 = f.state().version;
    let got = f.take();
    assert!(!got.reset);
    assert_eq!(got.changes.len(), 2);
    assert_eq!(got.version, v1);

    f.put(&live0(), &rk(1, 1), &rv(1, 11));
    f.remove(&live0(), &rk(1, 2));
    f.drain();
    assert!(f.state().version > v1);
    let got = f.take();
    assert_eq!(got.changes, vec![(rk(1, 1), Some(rv(1, 11))), (rk(1, 2), None)]);
    assert!(f.m.current(T, INC));
}

#[test]
fn a_change_taken_late_is_the_latest_of_the_key() {
    let mut f = Fix::empty();
    f.session(&live0(), &[]);
    f.drain();
    f.take();
    f.puts(&live0(), &records(&[(1, 10)]));
    f.drain();
    f.put(&live0(), &rk(1, 1), &rv(1, 11));
    f.drain();
    f.remove(&live0(), &rk(1, 1));
    f.put(&live0(), &rk(1, 2), &rv(1, 2));
    f.drain();
    let got = f.take();
    assert_eq!(got.changes, vec![(rk(1, 1), None), (rk(1, 2), Some(rv(1, 2)))], "one change a key, the last");
}

#[test]
fn a_record_removed_that_was_never_a_record_is_no_change() {
    let mut f = Fix::empty();
    f.session(&live0(), &records(&[(1, 1)]));
    f.drain();
    f.take();
    let v = f.state().version;
    // A heavy value is no record (junk on every page): its going is no change.
    f.put_value(&live0(), &rk(1, 5), Any::String(Arc::from("x".repeat(MAX_RECORD_BYTES + 10))));
    f.drain();
    f.remove(&live0(), &rk(1, 5));
    f.remove(&live0(), &rk(1, 6));
    f.drain();
    assert_eq!(f.state().version, v);
    assert!(f.take().changes.is_empty());
}

#[test]
fn a_new_checkpoint_starts_the_table_over() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10), (2, 20)])));
    f.drain();
    f.take();
    let before = f.state().generation;

    let base = cp(2);
    let live = live_of(T, Some(&base));
    f.session(&live, &records(&[(3, 30)]));
    f.put_top(&sum_of(T), &base);
    f.drain();
    assert_eq!(f.state().generation, before + 1);
    assert_eq!(f.state().live, Some(live.as_str()));
    let got = f.take();
    assert!(got.reset);
    assert_eq!(got.base, Some(base));
    assert_eq!(got.changes, vec![(rk(1, 3), Some(rv(1, 30)))], "none of the old session's");

    // The old session is no concern now.
    let v = f.state().version;
    f.put(&live0(), &rk(1, 9), &rv(1, 9));
    let d = f.drain();
    assert_eq!((f.state().version, d.bytes), (v, 0));
}

#[test]
fn a_checkpoint_written_again_as_it_was_starts_nothing() {
    let base = cp(2);
    let live = live_of(T, Some(&base));
    let mut f = Fix::seeded(Limits::default(), |f| {
        f.put_top(&sum_of(T), &base);
        f.session(&live, &records(&[(1, 1)]));
    });
    f.drain();
    f.take();
    let (g, v) = (f.state().generation, f.state().version);
    f.put_top(&sum_of(T), &base);
    f.drain();
    assert_eq!((f.state().generation, f.state().version), (g, v));
    assert!(!f.take().reset);
}

#[test]
fn a_session_replaced_is_read_afresh() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10), (2, 20)])));
    f.drain();
    f.take();
    let g = f.state().generation;
    f.session(&live0(), &records(&[(2, 22), (3, 30)]));
    f.drain();
    assert_eq!(f.state().generation, g + 1);
    let got = f.take();
    assert!(got.reset);
    assert_eq!(got.changes, vec![(rk(1, 2), Some(rv(1, 22))), (rk(1, 3), Some(rv(1, 30)))], "the old session's first record is gone");
}

#[test]
fn a_session_removed_and_made_again() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    f.take();
    f.remove_top(&live0());
    f.drain();
    assert!(!f.state().present && !f.state().serving());
    assert!(f.m.take(T, INC, usize::MAX).is_none());
    assert!(f.m.current(T, INC), "nothing left to read");
    f.session(&live0(), &records(&[(1, 12)]));
    f.drain();
    let got = f.take();
    assert!(got.reset);
    assert_eq!(got.changes, vec![(rk(1, 1), Some(rv(1, 12)))]);
}

#[test]
fn an_ended_incarnation_is_not_followed() {
    let mut ended = cp(5);
    let CVal::Obj(fields) = &mut ended else { unreachable!() };
    fields.push(("e".into(), CVal::Int(1)));
    let mut f = Fix::seeded(Limits::default(), |f| {
        f.put_top(&sum_of(T), &ended);
        f.session(&live0(), &records(&[(1, 1)]));
    });
    f.drain();
    let st = f.state();
    assert!(st.ended && !st.serving() && st.live.is_none() && st.hold.is_none());
    assert!(f.m.take(T, INC, usize::MAX).is_none());
}

// ── What a peer writes elsewhere ─────────────────────────────────────────────

#[test]
fn what_a_peer_writes_elsewhere_costs_nothing() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    f.take();
    let v = f.state().version;
    {
        let comp = f.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = f.doc.transact_mut();
        for i in 0..5_000 {
            comp.insert(&mut txn, format!("hs:t{i}:{INC}"), to_any(&rv(1, i)));
            comp.insert(&mut txn, format!("hk:{i}"), to_any(&rv(1, i)));
        }
        // Another table's, and a session of this one that is not the live one.
        comp.insert(&mut txn, sum_of("other"), to_any(&cp(1)));
        let other = comp.insert(&mut txn, live_of("other", None), MapPrelim::default());
        other.insert(&mut txn, rk(1, 1), to_any(&rv(1, 1)));
        let old = comp.insert(&mut txn, format!("ses:{T}:{INC}:{}", "b".repeat(24)), MapPrelim::default());
        for i in 0..100 {
            old.insert(&mut txn, rk(1, i), to_any(&rv(1, 1)));
        }
    }
    {
        let w = lock(&f.m.shared);
        assert!(w.dirt.tops.is_empty() && w.dirt.recs.is_empty(), "the observer noted none of it");
    }
    let d = f.drain();
    assert_eq!((d.bytes, d.paths, d.short), (0, 0, false));
    assert_eq!(f.state().version, v);
    assert!(f.take().changes.is_empty());
}

// ── Records the fold can't read as a page does ───────────────────────────────

fn proto_value(r: i64) -> Any {
    // A map with a `__proto__` field that is no object: a page reads it
    // with the field, or without (Clarity::Proto).
    Any::Map(Arc::new(std::collections::HashMap::from([("r".to_string(), Any::Number(r as f64)), ("__proto__".to_string(), Any::String(Arc::from("x")))])))
}

#[test]
fn a_record_a_page_may_read_otherwise_holds_the_table() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    f.take();
    f.put_value(&live0(), &rk(1, 7), proto_value(1));
    f.put(&live0(), &rk(1, 8), &rv(1, 8));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Unclear));
    assert!(!f.state().serving());
    assert!(f.m.take(T, INC, usize::MAX).is_none(), "a held table hands over nothing");
    assert_eq!(f.state().queued, 1, "the clear record waits all the same");

    // It goes: the table is followed again, and the unclear one was never sent.
    f.remove(&live0(), &rk(1, 7));
    f.drain();
    assert_eq!(f.state().hold, None);
    assert_eq!(f.take().changes, vec![(rk(1, 8), Some(rv(1, 8)))]);
}

#[test]
fn a_record_that_turns_unclear_is_taken_back() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    f.take();
    // It turns unclear, then goes: the worker is told it is gone.
    f.put_value(&live0(), &rk(1, 1), proto_value(1));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Unclear));
    assert_eq!(f.state().queued, 1, "the worker is told the record it has is not one");
    f.remove(&live0(), &rk(1, 1));
    f.drain();
    assert_eq!(f.state().hold, None);
    assert_eq!(f.take().changes, vec![(rk(1, 1), None)]);
    // It turns unclear, then clear again: the latest of the key.
    f.put(&live0(), &rk(1, 2), &rv(1, 2));
    f.drain();
    f.take();
    f.put_value(&live0(), &rk(1, 2), proto_value(1));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Unclear));
    f.put(&live0(), &rk(1, 2), &rv(1, 99));
    f.drain();
    assert_eq!(f.state().hold, None);
    assert_eq!(f.take().changes, vec![(rk(1, 2), Some(rv(1, 99)))]);
}

#[test]
fn a_heavy_record_is_no_record_and_costs_its_cap() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &[]));
    f.drain();
    f.take();
    let heavy = Any::String(Arc::from("x".repeat(MAX_RECORD_BYTES + 10)));
    f.put_value(&live0(), &rk(1, 1), heavy.clone());
    let d = f.drain();
    assert!(d.bytes >= MAX_RECORD_BYTES && d.bytes < MAX_RECORD_BYTES + 256, "{}", d.bytes);
    assert!(f.take().changes.is_empty() && f.state().hold.is_none());
    // Light, then heavy again: it comes, and goes.
    f.put(&live0(), &rk(1, 1), &rv(1, 1));
    f.drain();
    assert_eq!(f.take().changes, vec![(rk(1, 1), Some(rv(1, 1)))]);
    f.put_value(&live0(), &rk(1, 1), heavy);
    f.drain();
    assert_eq!(f.take().changes, vec![(rk(1, 1), None)]);
}

#[test]
fn keys_and_values_that_are_no_records_are_passed_over() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &[]));
    f.drain();
    f.take();
    let comp = f.doc.get_or_insert_map(COMPUTED_MAP);
    {
        let mut txn = f.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, &live0()) else { panic!() };
        m.insert(&mut txn, "not-a-record", to_any(&rv(1, 1)));
        m.insert(&mut txn, "k".repeat(MAX_KEY_BYTES + 1), to_any(&rv(1, 1)));
        // (A nested map under a record's key is no plain value.)
        m.insert(&mut txn, rk(1, 1), MapPrelim::default());
        m.insert(&mut txn, rk(1, 2), Any::Null);
    }
    let v = f.state().version;
    f.drain();
    let got = f.take();
    // (A null is a plain value that every page reads as junk: the fold gets it.)
    assert_eq!(got.changes, vec![(rk(1, 2), Some(CVal::Junk))]);
    assert!(f.state().version > v && f.state().hold.is_none());
}

// ── The checkpoint the node can't read as a page does ────────────────────────

#[test]
fn a_checkpoint_a_page_may_read_otherwise_holds_the_table() {
    let base = cp(1);
    // The checkpoint with a `__proto__` string: read with it or without it.
    let CVal::Obj(fields) = &base else { unreachable!() };
    let mut map: std::collections::HashMap<String, Any> = fields.iter().map(|(k, v)| (k.clone(), to_any(v))).collect();
    map.insert("__proto__".into(), Any::String(Arc::from("x")));
    let mut f = Fix::empty();
    f.put_any(&sum_of(T), Any::Map(Arc::new(map)));
    f.session(&live0(), &records(&[(1, 1)]));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Base));
    assert!(f.state().live.is_none() && f.m.take(T, INC, usize::MAX).is_none());

    // A page's checkpoint, once the table has one: followed from it.
    f.put_top(&sum_of(T), &base);
    f.session(&live_of(T, Some(&base)), &records(&[(2, 2)]));
    f.drain();
    assert_eq!(f.state().hold, None);
    assert_eq!(f.take().changes, vec![(rk(1, 2), Some(rv(1, 2)))]);
}

#[test]
fn an_unclear_value_that_is_no_checkpoint_either_way_is_no_base() {
    let mut f = Fix::empty();
    f.put_any(&sum_of(T), Any::Map(Arc::new(std::collections::HashMap::from([("v".to_string(), Any::Number(1.0)), ("__proto__".to_string(), Any::String(Arc::from("x")))]))));
    f.session(&live0(), &records(&[(1, 1)]));
    f.drain();
    assert_eq!(f.state().hold, None);
    assert_eq!(f.state().live, Some(live0().as_str()));
    assert_eq!(f.take().changes.len(), 1);
}

#[test]
fn a_checkpoint_heavier_than_a_tick_reads_holds_the_table() {
    let mut f = Fix::empty();
    f.put_top(&sum_of(T), &obj(vec![("v", CVal::Int(1)), ("x", s(&"c".repeat(READ_PER_TICK)))]));
    let d = f.drain();
    assert!(!d.short, "found out as the first thing a drain does");
    assert_eq!(f.state().hold, Some(Hold::Base));
    f.put_top(&sum_of(T), &cp(1));
    f.session(&live_of(T, Some(&cp(1))), &[]);
    f.drain();
    assert!(f.state().serving());
}

// ── Bounds ───────────────────────────────────────────────────────────────────

fn small(bytes: usize, paths: usize) -> Limits {
    Limits { drain_bytes: bytes, drain_paths: paths, ..Limits::default() }
}

#[test]
fn a_cold_read_goes_on_where_the_budget_ran_out() {
    let all: Vec<(u32, i64)> = (0..40).map(|i| (i, i as i64)).collect();
    let mut f = Fix::seeded(small(1_200, 4_096), |f| f.session(&live0(), &records(&all)));
    let mut model = Model::default();
    let mut shorts = 0;
    let mut reading = 0;
    for _ in 0..200 {
        let d = f.drain();
        shorts += d.short as usize;
        reading += f.state().reading as usize;
        model.take(&mut f.m, T);
        assert!(model.recs.len() <= 40);
        if f.m.current(T, INC) {
            break;
        }
    }
    assert!(shorts >= 3 && reading >= 3, "{shorts} {reading}");
    assert_eq!(model.recs, model_of(&all));
    assert_eq!(model.taken, 40, "each record once");
    assert_eq!(model.resets, 1);
}

#[test]
fn changes_made_while_a_cold_read_waits_are_not_lost() {
    let all: Vec<(u32, i64)> = (0..30).map(|i| (i, i as i64)).collect();
    let mut f = Fix::seeded(small(1_000, 4_096), |f| f.session(&live0(), &records(&all)));
    let mut model = Model::default();
    for _ in 0..3 {
        f.drain();
        model.take(&mut f.m, T);
    }
    assert!(f.state().reading && !model.recs.is_empty() && model.recs.len() < 30, "some of it read: {}", model.recs.len());
    // A record read, one not yet, one new; and one that goes.
    f.put(&live0(), &rk(1, 0), &rv(1, 1_000));
    f.put(&live0(), &rk(1, 29), &rv(1, 2_000));
    f.put(&live0(), &rk(1, 100), &rv(1, 3_000));
    f.remove(&live0(), &rk(1, 15));
    f.settle(&mut model);
    let mut want = model_of(&all);
    want.insert(rk(1, 0), rv(1, 1_000));
    want.insert(rk(1, 29), rv(1, 2_000));
    want.insert(rk(1, 100), rv(1, 3_000));
    want.remove(&rk(1, 15));
    assert_eq!(model.recs, want);
}

#[test]
fn changed_keys_past_the_paths_left_wait_for_the_next_drain() {
    let mut f = Fix::seeded(small(DRAIN_BYTES, 3), |f| f.session(&live0(), &[]));
    let mut model = Model::default();
    f.settle(&mut model);
    let all: Vec<(u32, i64)> = (0..10).map(|i| (i, i as i64)).collect();
    f.puts(&live0(), &records(&all));
    let d = f.drain();
    assert!(d.short && d.paths == 3);
    assert!(!f.m.current(T, INC));
    let n = f.settle(&mut model);
    assert!(n >= 3, "{n}");
    assert_eq!(model.recs, model_of(&all), "none dropped");
}

#[test]
fn too_many_changed_keys_read_the_session_afresh() {
    let limits = Limits { dirty_keys: 4, ..Limits::default() };
    let all: Vec<(u32, i64)> = (0..10).map(|i| (i, i as i64)).collect();
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    let mut model = Model::default();
    f.settle(&mut model);
    let g = f.state().generation;

    // Four keys are listed...
    f.puts(&live0(), &records(&[(0, 100), (1, 101), (2, 102), (3, 103)]));
    f.settle(&mut model);
    assert_eq!(f.state().generation, g, "no reset");
    // ...five are too many: the session is read again.
    f.puts(&live0(), &records(&[(0, 200), (1, 201), (2, 202), (3, 203), (4, 204)]));
    f.settle(&mut model);
    assert_eq!(f.state().generation, g + 1);
    let mut want = model_of(&all);
    for (i, v) in [(0, 200), (1, 201), (2, 202), (3, 203), (4, 204)] {
        want.insert(rk(1, i), rv(1, v));
    }
    assert_eq!(model.recs, want);
    assert_eq!(model.resets, 2);
}

#[test]
fn the_keys_of_two_drains_add_up_to_too_many_too() {
    let limits = Limits { dirty_keys: 4, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &[]));
    let mut model = Model::default();
    f.settle(&mut model);
    let g = f.state().generation;
    // Short drains leave the keys pending; the next drain's add to them.
    f.m.limits.drain_paths = 0;
    f.puts(&live0(), &records(&[(0, 1), (1, 1), (2, 1)]));
    f.drain();
    f.puts(&live0(), &records(&[(3, 1), (4, 1), (5, 1)]));
    f.drain();
    f.m.limits.drain_paths = DRAIN_PATHS;
    f.settle(&mut model);
    assert_eq!(f.state().generation, g + 1, "six distinct keys over a limit of four");
    assert_eq!(model.recs.len(), 6);
}

#[test]
fn a_flood_over_a_few_changes_waiting_is_read_afresh_too() {
    let limits = Limits { dirty_keys: 4, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &[]));
    let mut model = Model::default();
    f.settle(&mut model);
    let g = f.state().generation;
    f.m.limits.drain_paths = 0;
    f.puts(&live0(), &records(&[(0, 1), (1, 1)]));
    f.drain();
    f.puts(&live0(), &records(&[(2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 1)]));
    f.drain();
    f.m.limits.drain_paths = DRAIN_PATHS;
    f.settle(&mut model);
    assert_eq!(f.state().generation, g + 1);
    assert_eq!(model.recs.len(), 8);
}

#[test]
fn a_session_of_too_many_keys_is_held_until_it_is_replaced() {
    let limits = Limits { session_keys: 8, dirty_keys: 4, ..Limits::default() };
    let all: Vec<(u32, i64)> = (0..9).map(|i| (i, 1)).collect();
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded));
    assert!(f.m.take(T, INC, usize::MAX).is_none());
    assert_eq!(f.state().queued, 0, "nothing of it is kept");
    let g = f.state().generation;
    // Keys going does not clear it: the changes meanwhile were not followed.
    for i in 0..6 {
        f.remove(&live0(), &rk(1, i));
    }
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded));
    // Nor are more changes than the mirror lists a reason to read it again.
    f.puts(&live0(), &records(&[(20, 1), (21, 1), (22, 1), (23, 1), (24, 1), (25, 1)]));
    f.drain();
    assert_eq!((f.state().hold, f.state().generation), (Some(Hold::Flooded), g));
    assert!(f.m.current(T, INC));
    // A new session is a new start.
    f.session(&live0(), &records(&[(1, 1), (2, 2)]));
    f.drain();
    assert_eq!(f.state().hold, None);
    assert_eq!(f.take().changes.len(), 2);
}

#[test]
fn a_session_of_too_many_keys_that_are_no_records_is_held_too() {
    // (However many keys it lists, a cold read stops at the most.)
    let limits = Limits { session_keys: 8, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| {
        let junk: Vec<(String, CVal)> = (0..9).map(|i| (format!("junk{i}"), rv(1, i))).collect();
        f.session(&live0(), &junk);
    });
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded));
}

#[test]
fn a_session_that_grows_past_the_most_is_held() {
    let limits = Limits { session_keys: 8, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&[(0, 1), (1, 1), (2, 1), (3, 1), (4, 1)])));
    f.drain();
    f.take();
    f.puts(&live0(), &records(&[(5, 1), (6, 1), (7, 1)]));
    f.drain();
    assert_eq!(f.state().hold, None, "eight is the most");
    f.puts(&live0(), &records(&[(8, 1)]));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded));
    assert!(f.state().queued == 0 && f.m.take(T, INC, usize::MAX).is_none());
}

#[test]
fn reads_wait_while_the_changes_are_not_taken() {
    let all: Vec<(u32, i64)> = (0..30).map(|i| (i, i as i64)).collect();
    let limits = Limits { pending_bytes: MAX_RECORD_BYTES + 600, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    let d = f.drain();
    assert!(!d.short, "waiting is not spending");
    let queued = f.state().queued;
    assert!(queued > 0 && queued < 30, "{queued}");
    assert!(f.state().queued_bytes <= 900);
    assert!(!f.m.current(T, INC));
    // Nothing more is read until some is taken.
    let again = f.drain();
    assert_eq!(f.state().queued, queued);
    assert_eq!(again.bytes, 0);
    let mut model = Model::default();
    let mut peak = 0;
    for _ in 0..100 {
        f.drain();
        peak = peak.max(f.state().queued_bytes);
        model.take(&mut f.m, T);
        if f.m.current(T, INC) {
            break;
        }
    }
    assert_eq!(model.recs, model_of(&all));
    assert!(peak <= 900, "{peak}");
}

#[test]
fn takes_in_pieces() {
    let all: Vec<(u32, i64)> = (0..5).map(|i| (i, i as i64)).collect();
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&all)));
    f.drain();
    let none = f.m.take(T, INC, 0).unwrap();
    assert!(none.reset);
    assert_eq!(none.changes.len(), 1, "a take always makes progress");
    let first = f.m.take(T, INC, 1).unwrap();
    assert!(!first.reset && first.more && first.changes.len() == 1, "the first change always goes");
    let mut seen = first.changes.len() + none.changes.len();
    loop {
        let next = f.m.take(T, INC, 1).unwrap();
        assert!(!next.reset);
        seen += next.changes.len();
        if !next.more {
            break;
        }
    }
    assert_eq!(seen, 5);
}

#[test]
fn tables_take_turns_when_a_drain_is_short() {
    let all: Vec<(u32, i64)> = (0..30).map(|i| (i, i as i64)).collect();
    let mut f = Fix::seeded(small(4_000, DRAIN_PATHS), |f| {
        for t in ["t1", "t2", "t3"] {
            f.session(&live_of(t, None), &records(&all));
        }
    });
    f.m.want(&[("t1".into(), INC.into()), ("t2".into(), INC.into()), ("t3".into(), INC.into())]);
    for _ in 0..3 {
        assert!(f.drain().short);
    }
    for t in ["t1", "t2", "t3"] {
        assert!(f.m.state(t, INC).unwrap().queued > 0, "{t} had its turn");
    }
}

#[test]
fn a_table_not_wanted_any_more_is_let_go() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 1)])));
    f.drain();
    assert!(lock(&f.m.shared).names.contains(&live0()));
    // Changes the drains have not got to go with it.
    f.m.limits.drain_paths = 0;
    f.put(&live0(), &rk(1, 5), &rv(1, 5));
    f.put_top(&sum_of(T), &cp(9));
    f.drain();
    assert!(!f.m.pending.tops.is_empty() && !f.m.pending.recs.is_empty());
    let gone = f.m.want(&[]);
    assert!(f.m.pending.tops.is_empty() && f.m.pending.recs.is_empty());
    f.m.limits.drain_paths = DRAIN_PATHS;
    f.remove_top(&sum_of(T));
    assert_eq!(gone, vec![ctx(T)]);
    assert!(f.m.state(T, INC).is_none() && f.m.take(T, INC, 1).is_none());
    assert!(lock(&f.m.shared).names.is_empty(), "the observer watches nothing");
    f.put(&live0(), &rk(1, 2), &rv(1, 2));
    {
        let w = lock(&f.m.shared);
        assert!(w.dirt.recs.is_empty());
    }
    // Wanted again: read afresh.
    assert!(f.m.want(&[(T.into(), INC.into())]).is_empty());
    f.drain();
    assert_eq!(f.take().changes.len(), 3, "all three records of the session, though two came while it was let go");
}

#[test]
fn the_mirror_can_go_to_another_thread() {
    fn send<X: Send>() {}
    send::<RoomMirror>();
}

// ── The whole of it: a stream of changes is the doc ──────────────────────────

struct Rng(u64);

impl Rng {
    fn next(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (self.0 >> 33) % n
    }
}

/// What the live session of the doc holds, as the fold should be given it:
/// the records under keys that are records', but for the heavy ones.
fn doc_records(f: &Fix, live: &str) -> BTreeMap<String, CVal> {
    let comp = f.doc.get_or_insert_map(COMPUTED_MAP);
    let txn = f.doc.transact();
    let Some(Out::YMap(ses)) = comp.get(&txn, live) else { return BTreeMap::new() };
    ses.iter(&txn)
        .filter_map(|(k, out)| {
            let Out::Any(any) = out else { return None };
            parse_key(k)?;
            hb::weight(&any, MAX_RECORD_BYTES)?;
            Some((k.to_string(), norm(CVal::from_any(&any))))
        })
        .collect()
}

#[test]
fn applying_what_is_taken_gives_the_doc_whatever_the_budgets() {
    for seed in 1..=12u64 {
        let mut rng = Rng(seed * 7919);
        let limits = Limits {
            drain_bytes: 300 + rng.next(6_000) as usize,
            drain_paths: 1 + rng.next(30) as usize,
            dirty_keys: 2 + rng.next(12) as usize,
            pending_bytes: MAX_RECORD_BYTES + 400 + rng.next(4_000) as usize,
            session_keys: 64,
        };
        let mut f = Fix::with(limits);
        let mut model = Model::default();
        let mut base: Option<CVal> = None;
        let mut next_u = 1;
        let mut gen = 0;
        for _ in 0..400 {
            let live = f.m.state(T, INC).and_then(|s| s.live.map(str::to_string)).unwrap_or_else(live0);
            match rng.next(12) {
                0..=3 => {
                    if f.has_session(&live) {
                        let k = rk(1 + rng.next(2) as i64, rng.next(12) as u32);
                        f.put(&live, &k, &rv(1, rng.next(1_000) as i64));
                    }
                }
                4 | 5 => {
                    if f.has_session(&live) {
                        f.remove(&live, &rk(1 + rng.next(2) as i64, rng.next(12) as u32));
                    }
                }
                6 => {
                    let recs: Vec<(u32, i64)> = (0..rng.next(6) as u32).map(|i| (i, rng.next(100) as i64)).collect();
                    f.session(&live, &records(&recs));
                }
                7 => {
                    next_u += 1;
                    let b = cp(next_u);
                    let recs: Vec<(u32, i64)> = (0..rng.next(5) as u32).map(|i| (i, rng.next(100) as i64)).collect();
                    // (The records may come before the checkpoint, or after.)
                    if rng.next(2) == 0 {
                        f.session(&live_of(T, Some(&b)), &records(&recs));
                        f.put_top(&sum_of(T), &b);
                    } else {
                        f.put_top(&sum_of(T), &b);
                        f.session(&live_of(T, Some(&b)), &records(&recs));
                    }
                    base = Some(b);
                }
                8 => {
                    let heavy = Any::String(Arc::from("x".repeat(MAX_RECORD_BYTES + 1)));
                    if f.has_session(&live) {
                        f.put_value(&live, &rk(1, rng.next(12) as u32), heavy);
                    }
                }
                9 => f.put_top(&format!("hs:{}", rng.next(5)), &rv(1, 1)),
                _ => {
                    f.drain();
                    model.take(&mut f.m, T);
                    let g = f.m.state(T, INC).unwrap().generation;
                    assert!(g >= gen, "generations never go back");
                    gen = g;
                }
            }
        }
        // End with a session to follow, and let it all be read.
        f.drain();
        let live = f.m.state(T, INC).and_then(|s| s.live.map(str::to_string)).unwrap_or_else(live0);
        if !f.has_session(&live) {
            f.session(&live, &[]);
        }
        f.settle(&mut model);
        let st = f.state();
        assert!(st.serving(), "seed {seed}");
        assert_eq!(st.live, Some(live.as_str()), "seed {seed}");
        assert_eq!(model.base, base, "seed {seed}");
        assert_eq!(model.recs, doc_records(&f, &live), "seed {seed}");
    }
}
