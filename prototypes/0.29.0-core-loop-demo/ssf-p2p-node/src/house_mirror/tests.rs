//! The mirror against a real doc, built as the pages build it: the root
//! `casinoComputed` map, a nested map per session, records as plain values.

use super::*;
use crate::house::to_any;
use std::sync::Arc;
use yrs::{Any, MapPrelim, Transact};

const ROOM: &str = "room";
const T: &str = "t1";
const INC: &str = "r0123456789abcdef01234567";

pub(crate) fn obj(fields: Vec<(&str, CVal)>) -> CVal {
    CVal::Obj(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

pub(crate) fn s(v: &str) -> CVal {
    CVal::Str(v.into())
}

/// Fields in order: a doc keeps them in a hash map's, so what is read back
/// has no order of its own.
pub(crate) fn norm(v: CVal) -> CVal {
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

pub(crate) fn ctx(t: &str) -> Ctx {
    Ctx { room: ROOM.into(), t: t.into(), inc: INC.into() }
}

/// A checkpoint the pages take (for a house table); `u` tells them apart.
pub(crate) fn cp(u: i64) -> CVal {
    norm(obj(vec![("v", CVal::Int(1)), ("b", s("g")), ("u", CVal::Int(u)), ("l", s(&"a".repeat(32))), ("n", obj(vec![])), ("k", s(&"K".repeat(43))), ("g", s(&"G".repeat(86)))]))
}

pub(crate) fn sum_of(t: &str) -> String {
    format!("sum:{t}:{INC}")
}

/// The live session of `t` over this base.
pub(crate) fn live_of(t: &str, base: Option<&CVal>) -> String {
    format!("ses:{t}:{INC}:{}", hb::next_sid(&ctx(t), base).unwrap())
}

pub(crate) fn live0() -> String {
    live_of(T, None)
}

/// A record key of round `r`, number `i`: the shape of a close's.
pub(crate) fn rk(r: i64, i: u32) -> String {
    format!("c:{r}:{i:032x}")
}

pub(crate) fn rv(r: i64, i: i64) -> CVal {
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

    /// A shared type under a key of the session, where a record is a plain value.
    fn put_nested(&self, ses: &str, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        m.insert(&mut txn, key, MapPrelim::default());
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

impl Fix {
    /// A page's trim (writeCheckpointAndTrim): in one transaction the checkpoint, the session it
    /// trims gone, and the next session.
    fn page_trim(&self, old: &str, base: &CVal, next: &str, copies: &[(String, CVal)]) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, sum_of(T).as_str(), to_any(base));
        comp.remove(&mut txn, old);
        let m = comp.insert(&mut txn, next, MapPrelim::default());
        for (k, v) in copies {
            m.insert(&mut txn, k.as_str(), to_any(v));
        }
    }
}

/// A trim that finds the mirror up to date with the session it trims leaves nothing unread: the
/// session being gone is the trim, not a change to read.
#[test]
fn a_trim_of_a_session_read_to_its_end_leaves_nothing_unread() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10), (2, 20)])));
    assert!(!f.state().unread_at_trim, "(a table not read yet)");
    f.drain();
    f.take();
    assert!(!f.state().unread_at_trim, "(the first base is no trim)");
    let base = cp(2);
    let next = live_of(T, Some(&base));
    f.page_trim(&live0(), &base, &next, &[(rk(1, 3), rv(1, 30))]);
    f.drain();
    assert_eq!(f.state().live, Some(next.as_str()));
    assert!(!f.state().unread_at_trim);
}

/// What a page wrote to the session, and the mirror had noted and not read, when the trim came:
/// the worker was never sent it, though the checkpoint's page counted it.
#[test]
fn a_trim_that_comes_with_records_of_the_old_session_still_unread_says_so() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    f.take();
    // A close written, then the trim (the one drain finds both).
    f.put(&live0(), &rk(1, 2), &rv(1, 20));
    let base = cp(2);
    let next = live_of(T, Some(&base));
    f.page_trim(&live0(), &base, &next, &[]);
    let v = f.state().version;
    f.drain();
    assert_eq!(f.state().generation, 1 + 1, "(the base moved)");
    assert!(f.state().unread_at_trim);
    assert!(f.state().version > v);
    // The next trim, with the session read up, says it was not.
    f.take();
    f.drain();
    f.take();
    let base2 = cp(3);
    let next2 = live_of(T, Some(&base2));
    f.page_trim(&next, &base2, &next2, &[]);
    f.drain();
    assert_eq!(f.state().live, Some(next2.as_str()));
    assert!(!f.state().unread_at_trim);
}

/// The notes are the mirror's own: a record changed before an earlier drain that ran short of
/// the table is still unread at the trim.
#[test]
fn a_trim_that_comes_while_the_old_session_is_still_being_read_says_so() {
    let many: Vec<(String, CVal)> = (0..40).map(|i| (rk(1, i), rv(1, i as i64))).collect();
    let mut f = Fix::seeded(small(3_000, 4), |f| f.session(&live0(), &many));
    f.drain();
    assert!(f.state().reading, "the cold read is not finished");
    let base = cp(2);
    let next = live_of(T, Some(&base));
    f.page_trim(&live0(), &base, &next, &[]);
    f.drain();
    assert_eq!(f.state().live, Some(next.as_str()));
    assert!(f.state().unread_at_trim);
}

/// A session map put there again (not removed by the trim) is a change nobody read.
#[test]
fn a_trim_that_leaves_the_old_session_replaced_says_so() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    f.take();
    f.session(&live0(), &records(&[(1, 10), (2, 20)]));
    let base = cp(2);
    let next = live_of(T, Some(&base));
    f.put_top(&sum_of(T), &base);
    f.session(&next, &[]);
    f.drain();
    assert_eq!(f.state().live, Some(next.as_str()));
    assert!(f.state().unread_at_trim);
}

/// A checkpoint written again as it was changes no base: the flag stays as the last change left it.
#[test]
fn a_checkpoint_put_back_as_it_was_leaves_the_flag_as_it_was() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    f.take();
    f.put(&live0(), &rk(1, 2), &rv(1, 20));
    let base = cp(2);
    let next = live_of(T, Some(&base));
    f.page_trim(&live0(), &base, &next, &[]);
    f.drain();
    assert!(f.state().unread_at_trim);
    f.put_top(&sum_of(T), &base);
    f.drain();
    assert!(f.state().unread_at_trim);
}

#[test]
fn a_checkpoint_waiting_to_be_read_is_said_to_be() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    assert!(f.m.base_unread(T, INC), "a table not read yet");
    f.drain();
    assert!(!f.m.base_unread(T, INC));
    f.put(&live0(), &rk(1, 2), &rv(1, 20));
    assert!(!f.m.base_unread(T, INC), "(records are no checkpoint)");
    let base = cp(2);
    f.put_top(&sum_of(T), &base);
    assert!(f.m.base_unread(T, INC), "noted, not yet merged by a drain");
    // Short of the table: still unread after a drain that did not reach it.
    f.drain();
    assert!(!f.m.base_unread(T, INC));
    assert!(!f.m.base_unread("no-such-table", INC));
}

#[test]
fn a_table_let_go_of_and_wanted_again_is_another_whatever_its_generation() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    f.drain();
    let (born, generation) = (f.state().born, f.state().generation);
    // Starting over (a read afresh, a new checkpoint) is the same table.
    assert!(f.m.restart(T, INC));
    f.drain();
    assert_eq!(f.state().born, born);
    assert_eq!(f.state().generation, generation + 1);
    // Let go of and wanted again, with nothing between: another, with its generation back at the start.
    let other = ("t2".to_string(), INC.to_string());
    f.m.want(&[other.clone()]);
    assert!(f.m.state(T, INC).is_none());
    let second = f.m.state("t2", INC).unwrap().born;
    assert!(second > born);
    f.m.want(&[(T.into(), INC.into())]);
    f.drain();
    let again = f.state();
    assert!(again.born > second, "a count over the mirror, not over the table");
    assert!(again.generation <= generation, "its generation started over");
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

/// Keys that are in a session without being records the mirror keeps.
#[derive(Clone, Copy, Debug)]
enum Odd {
    /// A key no record goes under.
    Junk,
    /// A key longer than any record's.
    Overlong,
    /// A record's key, with a shared type under it.
    Nested,
    /// A record's key, with a value heavier than any the pages take.
    Heavy,
}

fn add_odd(f: &Fix, kind: Odd, batch: u32, n: u32) {
    for i in 0..n {
        let tag = batch * 100 + i;
        match kind {
            Odd::Junk => f.put(&live0(), &format!("junk{tag}"), &rv(1, tag as i64)),
            Odd::Overlong => f.put(&live0(), &format!("{}{tag}", "k".repeat(MAX_KEY_BYTES + 1)), &rv(1, tag as i64)),
            Odd::Nested => f.put_nested(&live0(), &rk(2, tag)),
            Odd::Heavy => f.put_value(&live0(), &rk(2, tag), Any::String(Arc::from("h".repeat(MAX_RECORD_BYTES + 1).as_str()))),
        }
    }
}

#[test]
fn a_session_that_grows_by_keys_that_are_no_records_is_held_as_a_cold_read_would_hold_it() {
    for kind in [Odd::Junk, Odd::Overlong, Odd::Nested, Odd::Heavy] {
        let limits = Limits { session_keys: 8, dirty_keys: 4, ..Limits::default() };
        let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&[(0, 1), (1, 1)])));
        f.drain();
        f.take();
        // Three keys a drain, under what the mirror lists of a session's changes: 5, 8 keys…
        for batch in 0..2 {
            add_odd(&f, kind, batch, 3);
            f.drain();
            assert_eq!(f.state().hold, None, "{kind:?} {batch}: eight is the most");
            assert!(f.m.current(T, INC), "{kind:?} {batch}");
        }
        // …and 11.
        add_odd(&f, kind, 2, 3);
        let d = f.drain();
        assert_eq!(f.state().hold, Some(Hold::Flooded), "{kind:?}: more than the most");
        if matches!(kind, Odd::Junk) {
            // (Junk costs nothing to pass over: the count is all of it, the most and one keys.)
            assert_eq!(d.bytes, 9 * VISIT_BYTES);
        }
        assert!(f.m.take(T, INC, usize::MAX).is_none());
        // A mirror that starts now finds the same.
        let mut fresh = RoomMirror::attach_with(&f.doc, ROOM, limits);
        fresh.want(&[(T.into(), INC.into())]);
        {
            let txn = f.doc.transact();
            fresh.drain(&txn);
        }
        assert_eq!(fresh.state(T, INC).unwrap().hold, Some(Hold::Flooded), "{kind:?}: from the doc");
    }
}

#[test]
fn records_added_to_a_session_that_holds_other_keys_count_with_them() {
    let limits = Limits { session_keys: 8, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| {
        let mut all = records(&[(0, 1), (1, 1)]);
        all.extend((0..6).map(|i| (format!("junk{i}"), rv(1, i))));
        f.session(&live0(), &all);
    });
    f.drain();
    assert_eq!(f.state().hold, None, "eight keys is the most");
    f.take();
    // A record is a key, and the session is nine.
    f.put(&live0(), &rk(1, 2), &rv(1, 2));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded));
    // Not so when keys that were no records have gone meanwhile.
    f.session(&live0(), &records(&[(0, 1), (1, 1)]));
    f.drain();
    assert_eq!(f.state().hold, None);
    f.take();
    f.puts(&live0(), &records(&[(2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 1)]));
    add_odd(&f, Odd::Junk, 0, 1);
    f.remove(&live0(), "junk0");
    f.put(&live0(), &rk(1, 8), &rv(1, 8));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded), "nine records");
}

#[test]
fn values_that_are_no_records_count_among_the_keys_of_a_session_a_cold_read_found() {
    let limits = Limits { session_keys: 8, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| {
        f.session(&live0(), &records(&[(0, 1), (1, 1), (2, 1)]));
        add_odd(f, Odd::Heavy, 0, 2);
        add_odd(f, Odd::Nested, 1, 3);
    });
    f.drain();
    assert_eq!(f.state().hold, None, "eight keys is the most");
    f.take();
    f.put(&live0(), &rk(1, 3), &rv(1, 3));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded), "nine keys");
}

#[test]
fn a_count_the_drain_cannot_pay_waits_for_the_next() {
    let limits = Limits { session_keys: 100, drain_bytes: 1_000, ..Limits::default() };
    let all: Vec<(u32, i64)> = (0..40).map(|i| (i, 1)).collect();
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    let mut model = Model::default();
    f.settle(&mut model);
    f.put(&live0(), "junk", &rv(1, 1));
    f.put(&live0(), &rk(1, 50), &rv(1, 50));
    // The record's read leaves less than the count of 41 keys costs.
    let d = f.drain();
    assert!(d.short);
    assert!(!f.m.current(T, INC), "a count is owed");
    let d = f.drain();
    assert!(!d.short && f.m.current(T, INC));
}

#[test]
fn a_count_that_is_owed_is_made_before_the_changes_that_keep_coming() {
    // One path a drain, and a key that is no record comes before each: the
    // drain's one path is spent on the key, and the count, owed since the
    // drain before, would never be reached at the end of it.
    let limits = Limits { session_keys: 8, drain_paths: 1, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&[(0, 1), (1, 1)])));
    let mut model = Model::default();
    f.settle(&mut model);
    let mut held_at = None;
    for i in 0..40u32 {
        f.put(&live0(), &format!("junk{i}"), &rv(1, i as i64));
        f.drain();
        if f.state().hold == Some(Hold::Flooded) {
            held_at = Some(i);
            break;
        }
    }
    // Two records and a key that is none before each drain: the ninth key is the one found, at a
    // drain that counts (one in two, the others read).
    assert!(matches!(held_at, Some(6..=7)), "{held_at:?}");
    assert!(f.m.current(T, INC), "nothing is left waiting to be read of a table that is held");
    assert!(f.m.take(T, INC, usize::MAX).is_none());
}

#[test]
fn a_count_that_is_owed_is_made_before_the_changes_that_spend_the_bytes() {
    // The key that is no record is read first (it costs a path only), and
    // the records changed again each drain spend the bytes before the end.
    let limits = Limits { session_keys: 8, drain_bytes: 600, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&[(0, 1), (1, 1), (2, 1), (3, 1)])));
    let mut model = Model::default();
    f.settle(&mut model);
    let mut held_at = None;
    for i in 0..40u32 {
        f.put(&live0(), &format!("a{i}"), &rv(1, i as i64));
        f.puts(&live0(), &records(&[(0, 10 + i as i64), (1, 10 + i as i64), (2, 10 + i as i64), (3, 10 + i as i64)]));
        let d = f.drain();
        if f.state().hold == Some(Hold::Flooded) {
            held_at = Some(i);
            break;
        }
        assert!(d.short, "{i}: the bytes are spent before the end");
    }
    // Four records and a key that is none before each drain: the fifth is the ninth key.
    assert!(matches!(held_at, Some(4..=5)), "{held_at:?}");
    assert!(f.m.current(T, INC), "nothing is left waiting to be read of a table that is held");
}

#[test]
fn a_count_made_ahead_settles_on_what_the_drain_then_reads() {
    // Seven records and a key that is no record: eight keys, the most. A
    // count is owed (the drain before could not pay it), and in the next one
    // three records are removed and one made: the count made ahead (six
    // keys) is of a session the mirror has not read down to yet.
    let limits = Limits { session_keys: 8, drain_bytes: 600, ..Limits::default() };
    let seven: Vec<(u32, i64)> = (0..7).map(|i| (i, 1)).collect();
    let mut f = Fix::seeded(limits, |f| {
        f.session(&live0(), &records(&seven));
        f.put(&live0(), "a0", &rv(1, 0));
    });
    let mut model = Model::default();
    f.settle(&mut model);
    f.put(&live0(), "a0", &rv(1, 1));
    f.puts(&live0(), &records(&[(0, 5), (1, 5), (2, 5), (3, 5)]));
    let d = f.drain();
    assert!(d.short && !f.m.current(T, INC), "a count is owed");
    f.remove(&live0(), &rk(1, 4));
    f.remove(&live0(), &rk(1, 5));
    f.remove(&live0(), &rk(1, 6));
    f.put(&live0(), &rk(1, 7), &rv(1, 7));
    f.settle(&mut model);
    assert_eq!(f.state().hold, None, "six keys");
    // Five records and a key that is none: three more are nine.
    f.puts(&live0(), &records(&[(8, 1), (9, 1), (10, 1)]));
    for _ in 0..3 {
        f.drain();
    }
    assert_eq!(f.state().hold, Some(Hold::Flooded));
}

fn table_of(f: &Fix) -> &Table {
    f.m.tables.values().next().expect("one table")
}

#[test]
fn a_count_made_ahead_is_all_the_count_the_drain_makes() {
    // The drain that makes the count owed ahead of the reading, and gets to the end, pays the count once.
    let all: Vec<(u32, i64)> = (0..20).map(|i| (i, 1)).collect();
    let owed = |junk: bool, f: &mut Fix, model: &mut Model, round: i64| -> usize {
        if junk {
            f.put(&live0(), "a0", &rv(1, round));
        }
        let rewrites: Vec<(u32, i64)> = (0..10).map(|i| (i, 10 + round)).collect();
        f.puts(&live0(), &records(&rewrites));
        f.m.limits.drain_bytes = 400;
        let d = f.drain();
        assert!(d.short);
        f.m.limits.drain_bytes = DRAIN_BYTES;
        let d = f.drain();
        assert!(!d.short && f.m.current(T, INC), "junk {junk}, round {round}");
        model.take(&mut f.m, T);
        d.bytes
    };
    let mut with = Fix::seeded(Limits::default(), |f| {
        f.session(&live0(), &records(&all));
        f.put(&live0(), "a0", &rv(1, 0));
    });
    let mut without = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&all)));
    let (mut m1, mut m2) = (Model::default(), Model::default());
    with.settle(&mut m1);
    without.settle(&mut m2);
    // Twice: a count made ahead says nothing of the next one owed.
    for round in 1..=2 {
        let a = owed(true, &mut with, &mut m1, round);
        let b = owed(false, &mut without, &mut m2, round);
        assert_eq!(a, b + 21 * VISIT_BYTES, "round {round}: the keys counted once, 20 records and the one that is none");
        // A count made ahead does not outlive the count.
        with.drain();
        assert!(!table_of(&with).probed, "round {round}");
    }
}

#[test]
fn the_keys_of_a_session_that_are_no_records_are_what_a_count_finds_besides_those_kept() {
    // Fifty records, ten a page may read otherwise (the table is held, but its keys are the session's all the same), and one key that is no record.
    let mut f = Fix::seeded(Limits { session_keys: 100, ..Limits::default() }, |f| {
        let all: Vec<(u32, i64)> = (0..50).map(|i| (i, 1)).collect();
        f.session(&live0(), &records(&all));
        for i in 100..110 {
            f.put_value(&live0(), &rk(1, i), proto_value(1));
        }
        f.put(&live0(), "a0", &rv(1, 0));
    });
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Unclear));
    assert_eq!(table_of(&f).extra, 1, "listed");
    // The key that is none changes: the keys are counted.
    f.put(&live0(), "a0", &rv(1, 1));
    f.drain();
    assert_eq!(table_of(&f).extra, 1, "counted: 61 keys, 60 of them kept");
    assert!(f.m.current(T, INC));
}

#[test]
fn the_keys_of_a_session_are_counted_only_when_something_odd_changed_and_at_what_they_weigh() {
    let limits = Limits { session_keys: 100, ..Limits::default() };
    let all: Vec<(u32, i64)> = (0..50).map(|i| (i, 1)).collect();
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    f.drain();
    f.take();
    // Records that come and go cost their reads, not a count of the session.
    f.put(&live0(), &rk(1, 60), &rv(1, 60));
    f.remove(&live0(), &rk(1, 0));
    let d = f.drain();
    assert!(d.bytes < 50 * VISIT_BYTES, "{}", d.bytes);
    // A key that is no record: the keys are counted, 51 here, at a visit each.
    f.put(&live0(), "junk", &rv(1, 1));
    let d = f.drain();
    assert!(d.bytes >= 51 * VISIT_BYTES && d.bytes < 52 * VISIT_BYTES + 200, "{}", d.bytes);
    // And not again until something odd changes again.
    f.put(&live0(), &rk(1, 61), &rv(1, 61));
    let d = f.drain();
    assert!(d.bytes < 50 * VISIT_BYTES, "{}", d.bytes);
}

#[test]
fn a_held_table_whose_queue_fills_still_reads_the_record_that_holds_it() {
    let all: Vec<(u32, i64)> = (2..40).map(|i| (i, i as i64)).collect();
    let limits = Limits { pending_bytes: MAX_QUEUED_RECORD + 600, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| {
        f.session(&live0(), &records(&all));
        // Two records a page may read otherwise, read first.
        f.put_value(&live0(), &rk(1, 0), proto_value(1));
        f.put_value(&live0(), &rk(1, 1), proto_value(1));
    });
    for _ in 0..10 {
        f.drain();
    }
    assert_eq!(f.state().hold, Some(Hold::Unclear));
    assert!(f.m.current(T, INC), "all of it read");
    // Nobody can take from a held table: what was queued is given up, and no more is kept.
    assert_eq!((f.state().queued, f.state().queued_bytes), (0, 0));
    // One of the two goes: still held.
    f.remove(&live0(), &rk(1, 0));
    for _ in 0..10 {
        f.drain();
    }
    assert_eq!(f.state().hold, Some(Hold::Unclear));
    assert_eq!((f.state().queued, f.state().queued_bytes), (0, 0));
    // The other is corrected, among twenty records rewritten: the table is followed again,
    // from the start, and the rewrites that follow it are not read twice.
    let rewritten: Vec<(u32, i64)> = (2..22).map(|i| (i, 500 + i as i64)).collect();
    f.puts(&live0(), &records(&rewritten));
    f.put(&live0(), &rk(1, 1), &rv(1, 1));
    let d = f.drain();
    assert_eq!(f.state().hold, None);
    assert!(d.bytes < 400, "{}", d.bytes);
    let mut model = Model::default();
    f.settle(&mut model);
    assert_eq!(f.state().hold, None);
    let mut want = model_of(&all);
    want.extend(model_of(&rewritten));
    want.insert(rk(1, 1), rv(1, 1));
    assert_eq!(model.recs, want);
    assert!(model.resets >= 1, "the worker is told to start over");
}

#[test]
fn a_replacement_that_keeps_the_count_is_not_a_flood() {
    let limits = Limits { session_keys: 8, ..Limits::default() };
    let all: Vec<(u32, i64)> = (1..=8).map(|i| (i, 1)).collect();
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    f.drain();
    f.take();
    // Key 8 goes and key 0 comes: read in key order, the session is nine for a moment, and never was.
    f.remove(&live0(), &rk(1, 8));
    f.put(&live0(), &rk(1, 0), &rv(1, 0));
    f.drain();
    assert_eq!(f.state().hold, None);
    assert_eq!(f.take().changes, vec![(rk(1, 0), Some(rv(1, 0))), (rk(1, 8), None)]);
    // The count still holds a session that is over.
    f.put(&live0(), &rk(1, 9), &rv(1, 9));
    f.drain();
    assert_eq!(f.state().hold, Some(Hold::Flooded));
}

#[test]
fn a_session_removed_after_a_record_changed_leaves_nothing_to_read() {
    for how in 0..2 {
        let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(0, 1), (1, 1)])));
        f.drain();
        f.take();
        f.put(&live0(), &rk(1, 5), &rv(1, 5));
        if how == 0 {
            f.remove_top(&live0());
        } else {
            f.put_any(&live0(), Any::String(Arc::from("not a map")));
        }
        f.drain();
        assert!(f.m.current(T, INC), "{how}: nothing waits");
        assert!(!f.state().present, "{how}");
        // It comes back.
        f.session(&live0(), &records(&[(7, 7)]));
        f.drain();
        assert_eq!(f.take().changes, vec![(rk(1, 7), Some(rv(1, 7)))], "{how}");
    }
}

/// A record of the most the pages weigh, that is held at three times that: 20,000 empty buffers.
fn buffers() -> Any {
    Any::Array(Arc::from((0..20_000).map(|_| Any::Buffer(Arc::from(Vec::<u8>::new()))).collect::<Vec<Any>>()))
}

#[test]
fn the_queue_stays_within_its_cap_whatever_a_record_is_held_at() {
    let limits = Limits { pending_bytes: 300_000, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| {
        f.session(&live0(), &[]);
        for i in 0..6 {
            f.put_value(&live0(), &rk(1, i), buffers());
        }
    });
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
    assert!(f.m.current(T, INC));
    assert!(peak > 150_000 && peak <= limits.pending_bytes, "{peak}");
    assert_eq!(model.recs.len(), 6);
    assert_eq!(model.recs, doc_records(&f, &live0()));
}

#[test]
fn a_cap_smaller_than_a_record_still_lets_one_through() {
    let limits = Limits { pending_bytes: 100, ..Limits::default() };
    let all: Vec<(u32, i64)> = (0..5).map(|i| (i, i as i64)).collect();
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    let mut model = Model::default();
    f.settle(&mut model);
    assert_eq!(model.recs, model_of(&all));
}

#[test]
fn a_session_that_grows_while_its_dirty_keys_are_never_all_read_is_held() {
    // One path a drain: the changed keys are read one a drain, and one more comes with each, so the
    // list is never empty, never long enough to start over, and the count never reached.
    let limits = Limits { session_keys: 8, dirty_keys: 4, drain_paths: 1, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &[]));
    let mut model = Model::default();
    f.settle(&mut model);
    f.puts(&live0(), &records(&[(0, 1), (1, 1), (2, 1)]));
    let mut held_at = None;
    for i in 3..60u32 {
        f.puts(&live0(), &records(&[(i, 1)]));
        f.drain();
        if f.state().hold == Some(Hold::Flooded) {
            held_at = Some(i);
            break;
        }
    }
    let at = held_at.expect("held before long");
    assert!(at <= 8 + 4 + 4, "held at {at}");
}

#[test]
fn reads_wait_while_the_changes_are_not_taken() {
    let all: Vec<(u32, i64)> = (0..30).map(|i| (i, i as i64)).collect();
    let limits = Limits { pending_bytes: MAX_QUEUED_RECORD + 600, ..Limits::default() };
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
fn a_count_that_is_owed_waits_with_the_reads_while_the_changes_are_not_taken() {
    let limits = Limits { session_keys: 100, pending_bytes: MAX_QUEUED_RECORD + 600, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&[(0, 1)])));
    let mut model = Model::default();
    f.settle(&mut model);
    // A key that is no record is read first (it sorts before the records), then records fill the queue.
    f.put(&live0(), "a0", &rv(1, 0));
    let more: Vec<(u32, i64)> = (1..30).map(|i| (i, i as i64)).collect();
    f.puts(&live0(), &records(&more));
    let d = f.drain();
    assert!(!d.short, "waiting is not spending");
    assert!(f.state().queued > 0 && f.state().queued < 29);
    assert!(!f.m.current(T, INC), "a count is owed");
    // Nothing is read, and no count is made, until some is taken.
    let again = f.drain();
    assert_eq!(again.bytes, 0);
    assert_eq!(again.paths, 0);
    // And once it is, the count is made, and the table is as the doc has it.
    f.settle(&mut model);
    assert_eq!(f.state().hold, None);
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
            pending_bytes: MAX_QUEUED_RECORD + 400 + rng.next(4_000) as usize,
            session_keys: 64,
            drain_time: None,
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

/// What is not followed, the same whichever way the session came to be as the doc has it: a mirror that has watched
/// the changes agrees with one that starts on the doc, except that a session found flooded stays so until replaced.
#[test]
fn how_a_table_stands_does_not_depend_on_the_changes_it_came_by() {
    for seed in 1..=24u64 {
        let mut rng = Rng(seed * 104_729);
        let limits = Limits {
            drain_bytes: 300 + rng.next(6_000) as usize,
            drain_paths: 1 + rng.next(30) as usize,
            dirty_keys: 2 + rng.next(12) as usize,
            pending_bytes: MAX_QUEUED_RECORD + 400 + rng.next(4_000) as usize,
            session_keys: 24,
            drain_time: None,
        };
        let big = Limits { drain_bytes: 1 << 30, drain_paths: 1 << 20, dirty_keys: 2_048, pending_bytes: 1 << 30, session_keys: 24, drain_time: None };
        let mut f = Fix::with(limits);
        let mut model = Model::default();
        let live = live0();
        let mut compared = 0;
        for step in 0..500 {
            match rng.next(16) {
                0..=2 => {
                    if f.has_session(&live) {
                        f.put(&live, &rk(1, rng.next(12) as u32), &rv(1, rng.next(1_000) as i64));
                    }
                }
                3 | 4 => {
                    if f.has_session(&live) {
                        f.remove(&live, &rk(1, rng.next(12) as u32));
                    }
                }
                5 => {
                    if f.has_session(&live) {
                        f.put(&live, &format!("junk{}", rng.next(20)), &rv(1, 1));
                    }
                }
                6 => {
                    if f.has_session(&live) {
                        f.remove(&live, &format!("junk{}", rng.next(20)));
                    }
                }
                7 => {
                    if f.has_session(&live) {
                        f.put_value(&live, &rk(1, rng.next(12) as u32), proto_value(1));
                    }
                }
                8 => {
                    if f.has_session(&live) {
                        f.put_nested(&live, &rk(2, rng.next(12) as u32));
                    }
                }
                9 => {
                    if f.has_session(&live) {
                        let heavy = Any::String(Arc::from("x".repeat(MAX_RECORD_BYTES + 1)));
                        f.put_value(&live, &rk(3, rng.next(12) as u32), heavy);
                    }
                }
                10 => {
                    if f.has_session(&live) {
                        f.put(&live, &format!("{}{}", "k".repeat(MAX_KEY_BYTES + 1), rng.next(8)), &rv(1, 1));
                    }
                }
                11 => {
                    let recs: Vec<(u32, i64)> = (0..rng.next(8) as u32).map(|i| (i, rng.next(100) as i64)).collect();
                    f.session(&live, &records(&recs));
                }
                12..=14 => {
                    f.drain();
                    model.take(&mut f.m, T);
                }
                _ => {
                    // Read all of it, and set it against a mirror that starts here.
                    f.settle(&mut model);
                    let mut fresh = RoomMirror::attach_with(&f.doc, ROOM, big);
                    fresh.want(&[(T.into(), INC.into())]);
                    for _ in 0..20 {
                        let txn = f.doc.transact();
                        fresh.drain(&txn);
                    }
                    assert!(fresh.current(T, INC), "seed {seed} step {step}");
                    let mut other = Model::default();
                    other.take(&mut fresh, T);
                    let (mine, theirs) = (f.state().hold, fresh.state(T, INC).unwrap().hold);
                    if theirs == Some(Hold::Flooded) {
                        assert_eq!(mine, theirs, "seed {seed} step {step}: a session over the most is held, however it grew");
                    } else if mine != Some(Hold::Flooded) {
                        assert_eq!(mine, theirs, "seed {seed} step {step}");
                        if mine.is_none() {
                            assert_eq!(model.recs, other.recs, "seed {seed} step {step}");
                            assert_eq!(model.recs, doc_records(&f, &live), "seed {seed} step {step}");
                        }
                    }
                    compared += 1;
                }
            }
        }
        assert!(compared > 10, "seed {seed}: {compared}");
    }
}

// ── Review round 3 ───────────────────────────────────────────────────────────

/// A doc built as a page builds its own, with a client id of its own, and the updates that carry its work to another.
struct Page {
    doc: Doc,
}

impl Page {
    fn new(client: u64) -> Page {
        Page { doc: Doc::with_client_id(client) }
    }

    /// Everything the page has done since `since`, as an update.
    fn diff_since(&self, since: &yrs::StateVector) -> Vec<u8> {
        self.doc.transact().encode_diff_v1(since)
    }

    fn state(&self) -> yrs::StateVector {
        self.doc.transact().state_vector()
    }

    fn apply(&self, update: &[u8]) {
        use yrs::updates::decoder::Decode;
        self.doc.transact_mut().apply_update(yrs::Update::decode_v1(update).unwrap()).unwrap();
    }

    fn session(&self, name: &str, records: &[(String, CVal)]) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let m = comp.insert(&mut txn, name, MapPrelim::default());
        for (k, v) in records {
            m.insert(&mut txn, k.as_str(), to_any(v));
        }
    }

    fn put(&self, ses: &str, key: &str, v: &CVal) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        m.insert(&mut txn, key, to_any(v));
    }

    fn trim(&self, old: &str, base: &CVal, next: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, sum_of(T).as_str(), to_any(base));
        comp.remove(&mut txn, old);
        comp.insert(&mut txn, next, MapPrelim::default());
    }
}

/// The page that wrote a record the node never got trims the session that holds it: the node is told to
/// delete what it was not sent, and what the page counted is more than it has read (and more than it will).
#[test]
fn a_trim_that_deletes_records_the_node_was_never_sent_says_it_is_unread() {
    for gap in [true, false] {
        let first = Page::new(1);
        first.session(&live0(), &records(&[(1, 10)]));
        let sent = first.diff_since(&yrs::StateVector::default());
        let mut f = Fix::empty();
        let second = Page::new(2);
        second.apply(&sent);
        {
            use yrs::updates::decoder::Decode;
            f.doc.transact_mut().apply_update(yrs::Update::decode_v1(&sent).unwrap()).unwrap();
        }
        f.drain();
        f.take();
        // The first page writes a close; the second reads it and trims the session.
        let before = first.state();
        first.put(&live0(), &rk(1, 2), &rv(1, 20));
        let close = first.diff_since(&before);
        second.apply(&close);
        if !gap {
            // (This time the node is sent it, and reads it, before the trim.)
            use yrs::updates::decoder::Decode;
            f.doc.transact_mut().apply_update(yrs::Update::decode_v1(&close).unwrap()).unwrap();
            f.drain();
            f.take();
        }
        let before = second.state();
        let base = cp(2);
        second.trim(&live0(), &base, &live_of(T, Some(&base)));
        let trim = second.diff_since(&before);
        {
            use yrs::updates::decoder::Decode;
            f.doc.transact_mut().apply_update(yrs::Update::decode_v1(&trim).unwrap()).unwrap();
        }
        let (update, delete_set) = {
            let txn = f.doc.transact();
            (txn.store().pending_update().is_some(), txn.store().pending_ds().is_some())
        };
        assert_eq!((update, delete_set), (false, gap), "gap={gap}: the doc waits for what the trim deleted exactly when it was not sent it, and for no update");
        f.drain();
        assert_eq!(f.state().generation, 1 + 1, "gap={gap}: (the base moved)");
        assert_eq!(f.state().unread_at_trim, gap, "gap={gap}");
        assert_eq!(f.state().trims, 1);
        // What was lacking comes, and the next trim is not marked by the last. (While the doc still lacks it, every trim is.)
        if gap {
            use yrs::updates::decoder::Decode;
            f.doc.transact_mut().apply_update(yrs::Update::decode_v1(&close).unwrap()).unwrap();
            assert!(f.doc.transact().store().pending_ds().is_none(), "the delete set is applied when the blocks it names come");
        }
        f.drain();
        f.take();
        let next = live_of(T, Some(&base));
        let base2 = cp(3);
        f.page_trim(&next, &base2, &live_of(T, Some(&base2)), &[]);
        f.drain();
        assert_eq!(f.state().trims, 2);
        assert!(!f.state().unread_at_trim, "gap={gap}: the lag of the first trim is not the second's");
    }
}

/// The doc can lack more than what a trim deletes: an update it was sent and cannot apply yet, for
/// want of what its page had (here a record into a session of another table that the node was not sent).
#[test]
fn a_trim_that_comes_while_the_doc_waits_for_an_update_says_it_is_unread() {
    let maker = Page::new(6);
    maker.session("ses:other:x:y", &[]);
    let other = maker.diff_since(&yrs::StateVector::default());
    let writer = Page::new(5);
    writer.apply(&other);
    let before = writer.state();
    writer.put("ses:other:x:y", &rk(1, 1), &rv(1, 10));
    let orphan = writer.diff_since(&before);
    // The table's own page work, which needs nothing the node lacks.
    let first = Page::new(1);
    first.session(&live0(), &records(&[(1, 10)]));
    let session = first.diff_since(&yrs::StateVector::default());
    let trimmer = Page::new(3);
    trimmer.apply(&session);
    let before = trimmer.state();
    let base = cp(2);
    trimmer.trim(&live0(), &base, &live_of(T, Some(&base)));
    let trim = trimmer.diff_since(&before);
    for waits in [true, false] {
        use yrs::updates::decoder::Decode;
        let mut f = Fix::empty();
        {
            let mut txn = f.doc.transact_mut();
            txn.apply_update(yrs::Update::decode_v1(&session).unwrap()).unwrap();
            if waits {
                txn.apply_update(yrs::Update::decode_v1(&orphan).unwrap()).unwrap();
            }
        }
        f.drain();
        f.take();
        f.doc.transact_mut().apply_update(yrs::Update::decode_v1(&trim).unwrap()).unwrap();
        let (update, delete_set) = {
            let txn = f.doc.transact();
            (txn.store().pending_update().is_some(), txn.store().pending_ds().is_some())
        };
        assert_eq!((update, delete_set), (waits, false), "waits={waits}: the doc waits for an update, and not for anything the trim deleted");
        f.drain();
        assert_eq!(f.state().unread_at_trim, waits, "waits={waits}");
    }
}

/// A lag noted for a table that is no longer mirrored is forgotten: the table, mirrored again, is read afresh.
#[test]
fn the_lag_noted_for_a_table_no_longer_mirrored_is_not_held_against_it_when_it_comes_back() {
    use yrs::updates::decoder::Decode;
    let first = Page::new(1);
    first.session(&live0(), &records(&[(1, 10)]));
    let session = first.diff_since(&yrs::StateVector::default());
    let second = Page::new(2);
    second.apply(&session);
    let before = first.state();
    first.put(&live0(), &rk(1, 2), &rv(1, 20));
    second.apply(&first.diff_since(&before));
    let before = second.state();
    let base = cp(2);
    second.trim(&live0(), &base, &live_of(T, Some(&base)));
    let trim = second.diff_since(&before);
    let mut f = Fix::empty();
    f.doc.transact_mut().apply_update(yrs::Update::decode_v1(&session).unwrap()).unwrap();
    f.drain();
    f.take();
    // The trim comes (and the doc lacks what it deleted): the lag is noted, and the table is let go of before it is read.
    f.doc.transact_mut().apply_update(yrs::Update::decode_v1(&trim).unwrap()).unwrap();
    f.m.want(&[]);
    f.drain();
    f.m.want(&[(T.into(), INC.into())]);
    f.drain();
    assert!(f.state().settled);
    assert!(!f.state().unread_at_trim, "the table is read afresh, from a base that is its first");
}

/// A checkpoint that comes first to a table, or again as it was, is no trim; each one that changes the base is.
#[test]
fn the_trims_of_a_table_are_counted_from_the_second_base() {
    let mut f = Fix::seeded(Limits::default(), |f| f.session(&live0(), &records(&[(1, 10)])));
    assert_eq!(f.state().trims, 0);
    f.drain();
    f.take();
    assert_eq!(f.state().trims, 0, "(a table's first read is no trim)");
    let base = cp(2);
    let next = live_of(T, Some(&base));
    f.page_trim(&live0(), &base, &next, &[]);
    f.drain();
    assert_eq!(f.state().trims, 1);
    f.put_top(&sum_of(T), &base);
    f.drain();
    assert_eq!(f.state().trims, 1, "the same base again");
    let base2 = cp(3);
    f.page_trim(&next, &base2, &live_of(T, Some(&base2)), &[]);
    f.drain();
    assert_eq!(f.state().trims, 2);
    // A table first read with a checkpoint has had none.
    let base = cp(2);
    let g = Fix::seeded(Limits::default(), |f| {
        f.put_top(&sum_of(T), &base);
        f.session(&live_of(T, Some(&base)), &records(&[(1, 10)]));
    });
    let mut g = g;
    g.drain();
    assert_eq!(g.state().trims, 0);
}

/// The room's delegations (`hk:`) are counted as they change, whether or not a table is watched, and one
/// that is replaced or removed is churn: a page that had seen the first may count a house the node never learned of.
#[test]
fn the_delegations_of_a_room_are_counted_and_a_replacement_or_a_removal_is_churn() {
    let doc = Doc::new();
    let m = RoomMirror::attach_with(&doc, ROOM, Limits::default());
    let f = Fix { doc, m };
    assert_eq!(f.m.delegations(), Delegations::default());
    f.put_top("hk:house-a", &obj(vec![("x", CVal::Int(1))]));
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: false });
    f.put_top("sum:other:inc", &cp(2));
    f.put_top("hkx", &s("not a delegation"));
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: false }, "nothing but `hk:` keys");
    f.put_top("hk:house-b", &obj(vec![("x", CVal::Int(2))]));
    assert_eq!(f.m.delegations(), Delegations { changes: 2, churned: false });
    f.put_top("hk:house-a", &obj(vec![("x", CVal::Int(3))]));
    assert_eq!(f.m.delegations(), Delegations { changes: 3, churned: true }, "replaced");
    // One that is removed.
    let doc = Doc::new();
    let m = RoomMirror::attach_with(&doc, ROOM, Limits::default());
    let f = Fix { doc, m };
    f.put_top("hk:house-a", &s("a"));
    assert!(!f.m.delegations().churned);
    f.remove_top("hk:house-a");
    assert_eq!(f.m.delegations(), Delegations { changes: 2, churned: true }, "removed");
}

// ── Review round 4 ───────────────────────────────────────────────────────────

fn apply_to(doc: &Doc, update: &[u8]) {
    use yrs::updates::decoder::Decode;
    doc.transact_mut().apply_update(yrs::Update::decode_v1(update).unwrap()).unwrap();
}

/// A delegation written again as it stands is no change: no house comes or goes, and every page reads it alike
/// (two pages of the deed holder write the same record when both run its duty at once). One written otherwise is churn.
#[test]
fn a_delegation_written_again_as_it_stands_is_no_churn() {
    let doc = Doc::new();
    let m = RoomMirror::attach_with(&doc, ROOM, Limits::default());
    let f = Fix { doc, m };
    f.put_top("hk:house-a", &obj(vec![("x", CVal::Int(1))]));
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: false });
    f.put_top("hk:house-a", &obj(vec![("x", CVal::Int(1))]));
    f.put_top("hk:house-a", &obj(vec![("x", CVal::Int(1))]));
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: false }, "the same record, twice more");
    // A record of another delegation is another change all the same, and one that differs from the last is churn.
    f.put_top("hk:house-b", &obj(vec![("x", CVal::Int(1))]));
    assert_eq!(f.m.delegations(), Delegations { changes: 2, churned: false });
    f.put_top("hk:house-a", &obj(vec![("x", CVal::Int(2))]));
    assert_eq!(f.m.delegations(), Delegations { changes: 3, churned: true }, "a record that differs");
    // A removal is churn however the record read; and what is written after it is a new record.
    let doc = Doc::new();
    let m = RoomMirror::attach_with(&doc, ROOM, Limits::default());
    let f = Fix { doc, m };
    f.put_top("hk:house-a", &s("a"));
    f.remove_top("hk:house-a");
    f.put_top("hk:house-a", &s("a"));
    assert_eq!(f.m.delegations(), Delegations { changes: 3, churned: true }, "removed, and written again");
    // A record a page may read otherwise (a `__proto__` field) written again as it stands is churn all the same: what
    // a page reads of it is not what the node reads.
    let doc = Doc::new();
    let m = RoomMirror::attach_with(&doc, ROOM, Limits::default());
    let f = Fix { doc, m };
    let ambiguous = || Any::Map(Arc::new(std::collections::HashMap::from([("v".to_string(), Any::Number(1.0)), ("__proto__".to_string(), Any::String(Arc::from("x")))])));
    f.put_any("hk:house-p", ambiguous());
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: false });
    f.put_any("hk:house-p", ambiguous());
    assert_eq!(f.m.delegations(), Delegations { changes: 2, churned: true }, "the same record, and one a page may read otherwise");
}

/// The records a page wrote and the trim that deleted them can come to the node in one update: all of it is integrated,
/// nothing waits, and the records, made in a session the same update deletes, leave no event. The trim is of a session
/// read only as far as the node was sent, and says so.
#[test]
fn a_trim_that_comes_in_one_update_with_the_records_it_deletes_says_it_is_unread() {
    for together in [true, false] {
        let first = Page::new(1);
        first.session(&live0(), &records(&[(1, 10)]));
        let mut f = Fix::empty();
        apply_to(&f.doc, &first.diff_since(&yrs::StateVector::default()));
        f.drain();
        f.take();
        let before = first.state();
        first.put(&live0(), &rk(1, 2), &rv(1, 20));
        let mid = first.state();
        let close = first.diff_since(&before);
        let base = cp(2);
        first.trim(&live0(), &base, &live_of(T, Some(&base)));
        let trim = first.diff_since(&mid);
        if together {
            apply_to(&f.doc, &first.diff_since(&before));
        } else {
            apply_to(&f.doc, &close);
            f.drain();
            f.take();
            apply_to(&f.doc, &trim);
        }
        let (update, delete_set) = {
            let txn = f.doc.transact();
            (txn.store().pending_update().is_some(), txn.store().pending_ds().is_some())
        };
        assert_eq!((update, delete_set), (false, false), "together={together}: nothing waits: the doc was sent all of it");
        f.drain();
        assert_eq!(f.state().trims, 1, "together={together}");
        assert_eq!(f.state().unread_at_trim, together, "together={together}");
        // The next trim is not marked by the last.
        f.take();
        let next = live_of(T, Some(&base));
        let base2 = cp(3);
        f.page_trim(&next, &base2, &live_of(T, Some(&base2)), &[]);
        f.drain();
        assert_eq!(f.state().trims, 2);
        assert!(!f.state().unread_at_trim, "together={together}: the lag of the first trim is not the second's");
    }
}

/// A drain that has taken its time stops, with what it was reading left for the next: the whole of it is read,
/// each record once, by drains each of which has done something.
#[test]
fn a_drain_that_has_taken_its_time_stops_and_the_next_goes_on() {
    let all: Vec<(u32, i64)> = (0..40).map(|i| (i, i as i64)).collect();
    // (No time at all: each drain does its first action and then no more.)
    let limits = Limits { drain_time: Some(Duration::ZERO), ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    let mut model = Model::default();
    let mut shorts = 0;
    let mut drains = 0;
    for _ in 0..500 {
        let d = f.drain();
        drains += 1;
        shorts += d.short as usize;
        assert!(d.paths > 0 || f.m.current(T, INC), "every drain that has work does some");
        model.take(&mut f.m, T);
        if f.m.current(T, INC) {
            break;
        }
    }
    assert!(f.m.current(T, INC), "it goes on to the end: {drains} drains");
    assert!(shorts >= 2, "the time stopped it: {shorts}");
    assert_eq!(model.recs, model_of(&all));
    assert_eq!(model.taken, 40, "each record once");
    // The same table with no limit of time is read in one drain.
    let mut g = Fix::seeded(Limits::default(), |g| g.session(&live0(), &records(&all)));
    assert!(!g.drain().short);
    assert!(g.m.current(T, INC));
    // The node's own limits carry the time.
    assert_eq!(Limits::live().drain_time, Some(DRAIN_TIME));
    assert_eq!(Limits::default().drain_time, None);
}

// ── Review round 5 ───────────────────────────────────────────────────────────

/// A value is told written again as it stands only within a weight (the observer runs in the doc's commit): a heavier
/// one is not compared, and is another; nor is one a page may read otherwise.
#[test]
fn a_value_is_told_written_again_only_within_a_weight() {
    let v = |n: usize| Any::String(Arc::from("x".repeat(n)));
    let again = |n: usize, cap: usize| rewritten_alike(&EntryChange::Updated(Out::Any(v(n)), Out::Any(v(n))), cap);
    assert!(again(100, 1_000));
    assert!(!again(2_000, 1_000), "heavier than the cap: another");
    assert!(!rewritten_alike(&EntryChange::Updated(Out::Any(v(10)), Out::Any(v(11))), 1_000), "a different value");
    assert!(!rewritten_alike(&EntryChange::Inserted(Out::Any(v(10))), 1_000), "an insert");
    assert!(!rewritten_alike(&EntryChange::Removed(Out::Any(v(10))), 1_000), "a removal");
    let proto = || Any::Map(Arc::new(std::collections::HashMap::from([("v".to_string(), Any::Number(1.0)), ("__proto__".to_string(), Any::String(Arc::from("x")))])));
    assert!(!rewritten_alike(&EntryChange::Updated(Out::Any(proto()), Out::Any(proto())), 1_000), "one a page may read otherwise");
    // A map of nested members, the same, within the weight.
    let nested = || Any::Map(Arc::new(std::collections::HashMap::from([("a".to_string(), Any::Array(vec![Any::Number(1.0), Any::String(Arc::from("y"))].into()))])));
    assert!(rewritten_alike(&EntryChange::Updated(Out::Any(nested()), Out::Any(nested())), 1_000));
    // Too deep to weigh: another.
    let mut deep = Any::Number(1.0);
    for _ in 0..(hb::MAX_DEPTH + 4) {
        deep = Any::Array(vec![deep].into());
    }
    assert!(!rewritten_alike(&EntryChange::Updated(Out::Any(deep.clone()), Out::Any(deep)), 1_000_000), "deeper than a record goes");
}

/// A delegation too heavy to be compared in the commit is not compared: written again as it stands, it is churn. One
/// within the weight is no churn (the test above of round 4).
#[test]
fn a_delegation_heavier_than_the_house_reads_is_churn_when_written_again() {
    for (weight, churn) in [(MAX_TOP_BYTES - 200, false), (MAX_TOP_BYTES + 200, true)] {
        let doc = Doc::new();
        let m = RoomMirror::attach_with(&doc, ROOM, Limits::default());
        let f = Fix { doc, m };
        let rec = || obj(vec![("x", s(&"y".repeat(weight)))]);
        f.put_top("hk:house-a", &rec());
        f.put_top("hk:house-a", &rec());
        assert_eq!(f.m.delegations(), Delegations { changes: if churn { 2 } else { 1 }, churned: churn }, "weight {weight}");
    }
}

fn heavy(tag: i64) -> CVal {
    obj(vec![("v", CVal::Int(1)), ("n", CVal::Int(tag)), ("x", s(&"c".repeat(READ_PER_TICK)))])
}

/// A checkpoint the node cannot read cannot be told from another it cannot read: one written since the last look is
/// another, so the trim counts, and a look at the same one again does not count it twice.
#[test]
fn a_checkpoint_the_node_cannot_read_replaced_by_another_it_cannot_read_is_a_trim() {
    let mut f = Fix::empty();
    f.put_top(&sum_of(T), &heavy(1));
    f.drain();
    assert_eq!((f.state().hold, f.state().trims), (Some(Hold::Base), 0), "(the first base is no trim)");
    f.drain();
    f.drain();
    assert_eq!(f.state().trims, 0, "nothing written, nothing changed");
    let (generation, version) = (f.state().generation, f.state().version);
    f.put_top(&sum_of(T), &heavy(2));
    f.drain();
    assert_eq!((f.state().hold, f.state().trims), (Some(Hold::Base), 1), "another it cannot read");
    assert!(f.state().generation > generation && f.state().version > version, "the table started over on it");
    f.put_top(&sum_of(T), &heavy(2));
    f.drain();
    assert_eq!(f.state().trims, 2, "(the node cannot tell the same one written again)");
    f.drain();
    assert_eq!(f.state().trims, 2, "and once");
    // The same of a checkpoint a page may read otherwise.
    let proto = |u: i64| {
        let CVal::Obj(fields) = cp(u) else { unreachable!() };
        let mut map: std::collections::HashMap<String, Any> = fields.iter().map(|(k, v)| (k.clone(), to_any(v))).collect();
        map.insert("__proto__".into(), Any::String(Arc::from("x")));
        Any::Map(Arc::new(map))
    };
    f.put_any(&sum_of(T), proto(5));
    f.drain();
    assert_eq!(f.state().trims, 3);
    f.put_any(&sum_of(T), proto(6));
    f.drain();
    assert_eq!((f.state().hold, f.state().trims), (Some(Hold::Base), 4));
    // And a checkpoint it can read after one it cannot is a trim, as before.
    f.put_top(&sum_of(T), &cp(7));
    f.drain();
    assert_eq!((f.state().hold, f.state().trims), (None, 5));
}

/// A second checkpoint the node cannot read, where the first was the table's first: that is the first trim.
#[test]
fn the_first_trim_after_a_first_checkpoint_the_node_cannot_read_is_counted() {
    let mut f = Fix::empty();
    f.put_top(&sum_of(T), &heavy(1));
    f.drain();
    assert_eq!(f.state().trims, 0);
    f.put_top(&sum_of(T), &heavy(2));
    f.drain();
    assert_eq!(f.state().trims, 1);
}

/// Checkpoints a page wrote and another page wrote over before the table was read: the table read the last, and
/// says how many it did not (each was a trim the node had nothing to hold anything against).
#[test]
fn checkpoints_written_over_before_the_table_read_them_are_counted_once_each() {
    let mut f = Fix::empty();
    f.put_top(&sum_of(T), &cp(1));
    f.session(&live_of(T, Some(&cp(1))), &[]);
    f.drain();
    assert_eq!((f.state().trims, f.m.take_superseded(T, INC)), (0, 0), "(the first base)");
    // Three written, one drain: the last is read; the two before it were written over.
    for u in [2, 3, 4] {
        f.put_top(&sum_of(T), &cp(u));
    }
    f.drain();
    assert_eq!(f.state().trims, 1);
    assert_eq!(f.m.take_superseded(T, INC), 2);
    assert_eq!(f.m.take_superseded(T, INC), 0, "told once");
    // One written between looks, each time: none.
    f.put_top(&sum_of(T), &cp(5));
    f.drain();
    f.put_top(&sum_of(T), &cp(6));
    f.drain();
    assert_eq!(f.m.take_superseded(T, INC), 0);
    // Two in two transactions with nothing read between, though they are the very same checkpoint: one write.
    f.put_top(&sum_of(T), &cp(7));
    f.put_top(&sum_of(T), &cp(7));
    f.drain();
    assert_eq!((f.state().trims, f.m.take_superseded(T, INC)), (4, 0), "a checkpoint written again as it stands is written over by nothing");
    // A table not mirrored has none to tell.
    assert_eq!(f.m.take_superseded("elsewhere", INC), 0);
}

/// A removal is no checkpoint; one that ends the run leaves the checkpoint before it unread.
#[test]
fn a_removal_is_no_checkpoint_written_over_and_one_that_comes_last_leaves_the_checkpoint_before_it_unread() {
    let mut f = Fix::empty();
    f.put_top(&sum_of(T), &cp(1));
    f.drain();
    // A checkpoint, its removal, another: the first was written over; the removal is nothing.
    f.put_top(&sum_of(T), &cp(2));
    f.remove_top(&sum_of(T));
    f.put_top(&sum_of(T), &cp(3));
    f.drain();
    assert_eq!(f.m.take_superseded(T, INC), 1);
    // A checkpoint and its removal: the checkpoint was never read.
    f.put_top(&sum_of(T), &cp(4));
    f.remove_top(&sum_of(T));
    f.drain();
    assert_eq!(f.m.take_superseded(T, INC), 1);
    assert!(f.state().base.is_none(), "(and the base is none)");
    // A removal alone: nothing was written over.
    f.put_top(&sum_of(T), &cp(5));
    f.drain();
    f.remove_top(&sum_of(T));
    f.drain();
    assert_eq!(f.m.take_superseded(T, INC), 0);
}

/// The count is the mirror's own: the first read of a table counts nothing, whatever was written before it; and what a
/// table counted before it was let go of is not told of when it comes back.
#[test]
fn the_checkpoints_written_before_the_first_look_and_those_of_a_table_let_go_of_are_not_counted() {
    let mut f = Fix::seeded(Limits::default(), |f| {
        f.put_top(&sum_of(T), &cp(1));
        f.put_top(&sum_of(T), &cp(2));
    });
    f.drain();
    assert_eq!((f.state().trims, f.m.take_superseded(T, INC)), (0, 0));
    f.put_top(&sum_of(T), &cp(3));
    f.put_top(&sum_of(T), &cp(4));
    f.m.want(&[]);
    f.m.want(&[(T.into(), INC.into())]);
    f.drain();
    assert_eq!(f.m.take_superseded(T, INC), 0, "(it is a table taken up afresh)");
}

/// A checkpoint of `players` nets of long ids: it weighs about `players * 200` bytes, and a page reads it.
fn cp_weighing(u: i64, players: usize) -> CVal {
    let CVal::Obj(mut fields) = cp(u) else { unreachable!() };
    let nets: Vec<(String, CVal)> = (0..players).map(|i| (format!("{i:0>200}"), s("1"))).collect();
    for f in fields.iter_mut() {
        if f.0 == "n" {
            f.1 = CVal::Obj(nets.clone());
        }
    }
    norm(CVal::Obj(fields))
}

/// A checkpoint written again as it stands is the same checkpoint: no trim, and written over by nothing, whatever its
/// weight up to what the house tells apart (the delegation's weight is no bound for it); past that weight a page's
/// put-back cannot be told from another checkpoint, and counts as one.
#[test]
fn a_checkpoint_written_again_as_it_stands_is_the_same_one_up_to_a_weight() {
    for (players, alike) in [(40usize, true), (1_600, false)] {
        let mut f = Fix::empty();
        f.put_top(&sum_of(T), &cp(1));
        f.session(&live_of(T, Some(&cp(1))), &[]);
        f.drain();
        let big = cp_weighing(2, players);
        let weight = hb::weight(&to_any(&big), usize::MAX).expect("it weighs");
        assert!(if alike { weight > MAX_TOP_BYTES && weight < ALIKE_SUM_BYTES } else { weight > ALIKE_SUM_BYTES && weight < READ_PER_TICK }, "players {players}: weighs {weight}");
        f.put_top(&sum_of(T), &big);
        f.drain();
        assert_eq!((f.state().trims, f.m.take_superseded(T, INC)), (1, 0), "players {players}");
        assert!(f.state().base.is_some(), "(a base the node reads)");
        // Written again, as it stands, between two looks: the same base.
        f.put_top(&sum_of(T), &big);
        f.drain();
        assert_eq!((f.state().trims, f.m.take_superseded(T, INC)), (1, 0), "players {players}: written again between looks");
        // ... and twice, with nothing read between.
        f.put_top(&sum_of(T), &cp_weighing(3, players));
        f.put_top(&sum_of(T), &cp_weighing(3, players));
        f.drain();
        assert_eq!(f.state().trims, 2, "players {players}");
        assert_eq!(f.m.take_superseded(T, INC), u64::from(!alike), "players {players}: the second of two alike is {}", if alike { "no checkpoint of its own" } else { "another, past the weight" });
    }
}

/// The writes of checkpoints are added over drains that do not reach the table, and forgotten with the table.
#[test]
fn the_checkpoints_written_across_short_drains_are_counted_all_and_those_of_a_table_let_go_of_are_not_kept() {
    let mut f = Fix::empty();
    f.put_top(&sum_of(T), &cp(1));
    f.session(&live_of(T, Some(&cp(1))), &[]);
    f.drain();
    f.m.limits.drain_paths = 0;
    f.put_top(&sum_of(T), &cp(2));
    f.drain();
    f.put_top(&sum_of(T), &cp(3));
    f.drain();
    f.put_top(&sum_of(T), &cp(4));
    f.drain();
    assert_eq!(f.state().trims, 0, "(nothing was read)");
    f.m.limits.drain_paths = DRAIN_PATHS;
    f.drain();
    assert_eq!(f.state().trims, 1);
    assert_eq!(f.m.take_superseded(T, INC), 2, "three written over three drains that read nothing, the last read");
    // The writes of a table let go of are not kept.
    f.put_top(&sum_of(T), &cp(5));
    f.put_top(&sum_of(T), &cp(6));
    f.m.want(&[]);
    f.drain();
    assert!(f.m.pending.writes.is_empty(), "{:?}", f.m.pending.writes);
}

// ── Review round 6 ───────────────────────────────────────────────────────────

impl Page {
    fn put_top(&self, key: &str, v: &CVal) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, key, to_any(v));
    }

    fn remove_top(&self, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.remove(&mut txn, key);
    }
}

/// A delegation written and written over in one update (the node was away, or the updates were merged on the way) shows the
/// node only the last, as an insert: a page that had the first by itself may have counted a house the plan never knew. The
/// update says that something was made and deleted in it, and not what, and the delegation is churn.
#[test]
fn a_delegation_written_and_written_over_in_one_update_is_churn_though_it_shows_as_an_insert() {
    let page = Page::new(7);
    page.put_top("hk:house-a", &s("a"));
    page.put_top("hk:house-a", &s("b"));
    let f = Fix::empty();
    apply_to(&f.doc, &page.diff_since(&yrs::StateVector::default()));
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: true });
}

/// One written once is not, nor is one in an update that deletes only what the doc already had.
#[test]
fn a_delegation_written_once_is_no_churn_even_in_an_update_that_deletes_what_the_doc_had() {
    let page = Page::new(7);
    page.put_top("hk:house-a", &s("a"));
    let f = Fix::empty();
    apply_to(&f.doc, &page.diff_since(&yrs::StateVector::default()));
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: false });
    // A key the doc held goes, and another delegation comes, in one update.
    page.put_top("elsewhere", &s("x"));
    let held = f.doc.transact().state_vector();
    apply_to(&f.doc, &page.diff_since(&held));
    let before = f.doc.transact().state_vector();
    page.remove_top("elsewhere");
    page.put_top("hk:house-b", &s("b"));
    apply_to(&f.doc, &page.diff_since(&before));
    assert_eq!(f.m.delegations(), Delegations { changes: 2, churned: false }, "the block deleted was one the doc held");
}

/// An update in which something else was made and deleted doubts a delegation it brings once too: what was deleted cannot
/// be told (some harmless updates are doubted).
#[test]
fn a_delegation_brought_with_something_else_made_and_deleted_is_churn_too() {
    let page = Page::new(7);
    page.put_top("other", &s("1"));
    page.put_top("other", &s("2"));
    page.put_top("hk:house-a", &s("a"));
    let f = Fix::empty();
    apply_to(&f.doc, &page.diff_since(&yrs::StateVector::default()));
    assert_eq!(f.m.delegations(), Delegations { changes: 1, churned: true });
}

impl Page {
    fn remove_rec(&self, ses: &str, key: &str) {
        let comp = self.doc.get_or_insert_map(COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(Out::YMap(m)) = comp.get(&txn, ses) else { panic!("no session {ses}") };
        m.remove(&mut txn, key);
    }
}

impl Fix {
    /// What is waiting to be taken, taken and dropped (the table may not be serving yet).
    fn skim(&mut self) {
        let _ = self.m.take(T, INC, usize::MAX);
    }
}

/// A node that was sent a record of the live session and its deletion in one update never had the record to read; the page
/// that saw the record and not its deletion counts it in the trim it writes after. What the node was sent, `how`:
///
/// - "merged": the record and its deletion in one update;
/// - "separate": the record in one update, its deletion in the next (the node read it);
/// - "never": no record at all;
/// - "elsewhere": the record made and deleted in a session no table follows;
/// - "new session": the session itself comes in the update that made and deleted the record;
/// - "merged undrained": as "merged", and the trim is sent before the node has drained.
///
/// The node has then been sent the page's trim, and has drained it.
fn trimmed_after(how: &str) -> Fix {
    let ses = if how == "elsewhere" { "ses:elsewhere:x".to_string() } else { live0() };
    let mut f = Fix::empty();
    f.drain();
    f.skim();
    let first = Page::new(1);
    first.session(&live0(), &records(&[(1, 10)]));
    if how == "elsewhere" {
        first.session(&ses, &records(&[(1, 1)]));
    }
    let base = first.diff_since(&yrs::StateVector::default());
    let after_session = first.state();
    if how != "new session" {
        apply_to(&f.doc, &base);
        f.drain();
        f.skim();
    }
    let record = rk(1, 2);
    if how != "never" {
        first.put(&ses, &record, &rv(1, 20));
    }
    let put = first.diff_since(&after_session);
    match how {
        "never" => {}
        "separate" => {
            apply_to(&f.doc, &put);
            f.drain();
            f.skim();
            let mid = first.state();
            first.remove_rec(&ses, &record);
            apply_to(&f.doc, &first.diff_since(&mid));
        }
        _ => {
            first.remove_rec(&ses, &record);
            let since = if how == "new session" { yrs::StateVector::default() } else { after_session };
            apply_to(&f.doc, &first.diff_since(&since));
        }
    }
    // ("undrained": the node is sent the trim before it has looked at the update that made and deleted the record.)
    if how != "merged undrained" {
        f.drain();
        f.skim();
    }
    // The page that trims has the session and the record, and not its deletion.
    let second = Page::new(2);
    second.apply(&base);
    if how != "never" {
        second.apply(&put);
    }
    let before = second.state();
    let base_cp = cp(2);
    second.trim(&live0(), &base_cp, &live_of(T, Some(&base_cp)));
    apply_to(&f.doc, &second.diff_since(&before));
    f.drain();
    f
}

#[test]
fn a_record_made_and_deleted_in_one_update_makes_the_next_trim_of_its_session_unread() {
    for (how, unread) in [("merged", true), ("merged undrained", true), ("new session", true), ("separate", false), ("never", false), ("elsewhere", false)] {
        let mut f = trimmed_after(how);
        assert_eq!((f.state().trims, f.state().unread_at_trim), (1, unread), "{how}");
        // The doubt is of the session the trim leaves: it is not carried to the next.
        f.skim();
        let next = live_of(T, Some(&cp(2)));
        let base2 = cp(3);
        f.page_trim(&next, &base2, &live_of(T, Some(&base2)), &[]);
        f.drain();
        assert_eq!((f.state().trims, f.state().unread_at_trim), (2, false), "{how}: the next trim");
    }
}

/// ... and it is kept through drains and resets of the table until the trim: a drain that read other things in between
/// does not lose it.
#[test]
fn what_was_made_and_deleted_in_a_session_is_kept_until_the_trim_of_it() {
    let first = Page::new(1);
    first.session(&live0(), &records(&[(1, 10)]));
    let mut f = Fix::empty();
    f.drain();
    f.skim();
    let base = first.diff_since(&yrs::StateVector::default());
    apply_to(&f.doc, &base);
    f.drain();
    f.skim();
    let after_session = first.state();
    first.put(&live0(), &rk(1, 2), &rv(1, 20));
    let put = first.diff_since(&after_session);
    first.remove_rec(&live0(), &rk(1, 2));
    apply_to(&f.doc, &first.diff_since(&after_session));
    // Drains, and other records coming and going, one at a time, as the room goes on.
    for i in 3..12u32 {
        f.drain();
        f.skim();
        let mid = first.state();
        first.put(&live0(), &rk(1, i), &rv(1, i as i64));
        apply_to(&f.doc, &first.diff_since(&mid));
    }
    f.drain();
    f.skim();
    let second = Page::new(2);
    second.apply(&base);
    second.apply(&put);
    let before = second.state();
    let base_cp = cp(2);
    second.trim(&live0(), &base_cp, &live_of(T, Some(&base_cp)));
    apply_to(&f.doc, &second.diff_since(&before));
    f.drain();
    assert_eq!((f.state().trims, f.state().unread_at_trim), (1, true));
}

/// A table whose base has been read and whose session map has not been listed: the state a drain that ran out of paths
/// leaves it in.
fn awaiting_its_session(all: &[(u32, i64)]) -> Fix {
    let limits = Limits { drain_paths: 1, ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(all)));
    assert!(f.drain().short, "(the base was all that was read)");
    assert!(f.m.tables.values().all(|t| t.need_session && t.live.is_some()));
    f
}

/// A budget with its time already up, that has done `used` actions.
fn late_budget(used: usize) -> Budget {
    Budget { bytes: usize::MAX / 2, paths: 100, deadline: Some(Instant::now()), fresh: used == 0, spent: false, used_bytes: 0, used_paths: used }
}

/// The scan that lists a session's keys looks at the clock as it goes: a drain with its time up that has done something
/// already gives it up, whole (nothing is kept of a list not made), and the next drain makes it. The first thing a
/// drain does is read to its end.
#[test]
fn the_listing_of_a_big_session_is_given_up_when_the_time_is_up_and_made_again_by_the_next_drain() {
    let all: Vec<(u32, i64)> = (0..1_000).map(|i| (i, i as i64)).collect();
    for (used, finished) in [(1usize, true), (2, false), (7, false)] {
        let mut f = awaiting_its_session(&all);
        let limits = f.m.limits;
        let txn = f.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(ses)) = comp.get(&txn, &live0()) else { panic!("the session") };
        let table = f.m.tables.get_mut(&(T.to_string(), INC.to_string())).unwrap();
        let mut b = late_budget(used);
        assert_eq!(table.snapshot(&ses, &txn, &mut b, &limits), finished, "used={used}");
        if finished {
            assert!(table.cold.is_some() && table.present && !table.need_session);
        } else {
            assert!(b.spent, "the drain is over");
            assert!(table.cold.is_none() && !table.present && table.need_session, "used={used}: nothing of the list is kept");
        }
    }
}

/// ... and the count of a session's keys is the same.
#[test]
fn the_count_of_a_big_sessions_keys_is_given_up_when_the_time_is_up() {
    let all: Vec<(u32, i64)> = (0..1_000).map(|i| (i, i as i64)).collect();
    // (The count is begun, which is an action of the drain: `used` is the actions done with it.)
    for (used, count) in [(1usize, Some(1_000)), (2, None), (7, None)] {
        let mut f = awaiting_its_session(&all);
        let limits = f.m.limits;
        let txn = f.doc.transact();
        let comp = txn.get_map(COMPUTED_MAP).unwrap();
        let Some(Out::YMap(ses)) = comp.get(&txn, &live0()) else { panic!("the session") };
        let table = f.m.tables.get_mut(&(T.to_string(), INC.to_string())).unwrap();
        let mut b = late_budget(used);
        assert_eq!(table.count_scan(&ses, &txn, &mut b, &limits), count, "used={used}");
        assert_eq!(b.spent, count.is_none(), "used={used}");
    }
}

/// A session of fewer keys than the scans look at the clock after is read whole, whatever the time.
#[test]
fn a_small_session_is_listed_whole_though_the_time_is_up() {
    const KEYS: u32 = 255;
    assert!((KEYS as usize) < SCAN_CHECK_KEYS, "(a session of fewer keys than the scans look at the clock after)");
    let all: Vec<(u32, i64)> = (0..KEYS).map(|i| (i, i as i64)).collect();
    let mut f = awaiting_its_session(&all);
    let limits = f.m.limits;
    let txn = f.doc.transact();
    let comp = txn.get_map(COMPUTED_MAP).unwrap();
    let Some(Out::YMap(ses)) = comp.get(&txn, &live0()) else { panic!("the session") };
    let table = f.m.tables.get_mut(&(T.to_string(), INC.to_string())).unwrap();
    assert!(table.snapshot(&ses, &txn, &mut late_budget(5), &limits));
}

/// Drains with no time at all still read a session too big to be listed between two looks at the clock: the first thing a
/// drain does is read to its end, and so every drain gets somewhere.
#[test]
fn drains_with_no_time_at_all_still_read_a_big_session_to_its_end() {
    let all: Vec<(u32, i64)> = (0..1_000).map(|i| (i, i as i64)).collect();
    let limits = Limits { drain_time: Some(Duration::ZERO), ..Limits::default() };
    let mut f = Fix::seeded(limits, |f| f.session(&live0(), &records(&all)));
    let mut model = Model::default();
    let mut drains = 0;
    for _ in 0..5_000 {
        let d = f.drain();
        drains += 1;
        assert!(d.paths > 0 || f.m.current(T, INC), "every drain that has work does some");
        model.take(&mut f.m, T);
        if f.m.current(T, INC) {
            break;
        }
    }
    assert!(f.m.current(T, INC), "it goes on to the end: {drains} drains");
    assert_eq!(model.recs, model_of(&all));
}
