//! `compare` against the fold engine's own vectors: a page's trim checkpoint
//! built the way computedTable's trim builds one (the nets, the close of the
//! last decided round, the commitment the next must name, a craps carry).

use super::*;
use crate::house_fold::tests::cases;

/// A vector's summary, as if its fold were finished: some vectors hold a signature unchecked for good,
/// so their folds are pending, and the tests that use this are of the fields.
fn finished(summary: &str) -> FoldSummary {
    let mut sum: FoldSummary = serde_json::from_str(summary).expect("a summary");
    sum.pending = false;
    sum
}

fn summary(name: &str) -> (FoldSummary, String) {
    let c = cases().into_iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no vector {name}"));
    (finished(&c.summary), c.ctx.inc)
}

fn obj(fields: Vec<(&str, CVal)>) -> CVal {
    CVal::Obj(fields.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

fn s(v: &str) -> CVal {
    CVal::Str(v.into())
}

/// The checkpoint a page that has decided rounds through `u` writes. `n`: the
/// nets it has; `craps`: whether the table's inc is a craps one.
fn page_cp(sum: &FoldSummary, u: i64, n: Vec<(String, String)>, last: bool, craps: bool) -> CVal {
    let close = sum.rounds.iter().find(|r| r.r == u).expect("a round").close.clone();
    let mut f = vec![
        ("v", CVal::Int(1)),
        ("b", s(&sum.base.sid)),
        ("u", CVal::Int(u)),
        ("l", s(&close)),
        ("n", obj(n.into_iter().map(|(p, x)| (leak(p), s(&x))).collect())),
        ("k", s(&"K".repeat(43))),
        ("g", s(&"G".repeat(86))),
    ];
    if last {
        if craps && !sum.carry.is_null() {
            f.push(("s", CVal::from_json(&sum.carry)));
        }
        if let Some(h) = &sum.required {
            f.push(("h", s(h)));
        }
    } else if craps {
        // (A craps checkpoint always carries something; what the fold had after an earlier round is not known here.)
        f.push(("s", obj(vec![("p", CVal::Int(0)), ("w", obj(vec![]))])));
    }
    obj(f)
}

fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

/// The nets after the decided rounds through `u`, zeros dropped.
fn nets_through(sum: &FoldSummary, u: i64) -> Vec<(String, String)> {
    let mut m: BTreeMap<String, i128> = BTreeMap::new();
    for (p, n) in &sum.base.n {
        *m.entry(p.clone()).or_default() += n.parse::<i128>().unwrap();
    }
    for r in sum.rounds.iter().filter(|r| r.r <= u && r.decided.is_some()) {
        for (p, d) in &r.deltas {
            *m.entry(p.clone()).or_default() += d.parse::<i128>().unwrap();
        }
    }
    m.into_iter().filter(|(_, n)| *n != 0).map(|(p, n)| (p, n.to_string())).collect()
}

fn last_decided(sum: &FoldSummary) -> Option<i64> {
    sum.rounds.iter().filter(|r| r.decided.is_some()).map(|r| r.r).max()
}

fn with_cp(cp: &CVal, field: &str, v: Option<CVal>) -> CVal {
    let CVal::Obj(fields) = cp else { panic!() };
    let mut f: Vec<(String, CVal)> = fields.iter().filter(|(k, _)| k != field).cloned().collect();
    if let Some(v) = v {
        f.push((field.to_string(), v));
    }
    CVal::Obj(f)
}

#[test]
fn a_pages_trim_at_the_last_round_the_fold_decided_is_the_folds_own_word() {
    let mut compared = 0;
    for c in cases() {
        let sum = finished(&c.summary);
        let Some(u) = last_decided(&sum) else { continue };
        // (The craps ones are told by the carry: roulette's is null.)
        let cp = page_cp(&sum, u, nets_through(&sum, u), true, !sum.carry.is_null());
        if !crate::house::checkpoint_ok(&cp, &c.ctx.inc) {
            continue;
        }
        assert_eq!(compare(&sum, &cp, &c.ctx.inc), Verdict::Agree, "{}", c.name);
        compared += 1;
    }
    assert!(compared >= 6, "{compared} vectors compared");
}

#[test]
fn a_net_that_differs_is_a_mismatch_in_n() {
    let (sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let mut n = nets_through(&sum, u);
    assert!(!n.is_empty());
    // One net off by one.
    let x: i128 = n[0].1.parse().unwrap();
    n[0].1 = (x + 1).to_string();
    let cp = page_cp(&sum, u, n.clone(), true, true);
    let Verdict::Mismatch(why) = compare(&sum, &cp, &inc) else { panic!("{:?}", compare(&sum, &cp, &inc)) };
    assert!(why.starts_with("n through round"), "{why}");
    // A player the fold has never seen.
    let mut n = nets_through(&sum, u);
    n.push(("zed".into(), "5".into()));
    let cp = page_cp(&sum, u, n, true, true);
    assert!(matches!(compare(&sum, &cp, &inc), Verdict::Mismatch(w) if w.starts_with("n ")));
    // A net the fold has and the checkpoint lacks.
    let mut n = nets_through(&sum, u);
    n.pop();
    let cp = page_cp(&sum, u, n, true, true);
    assert!(matches!(compare(&sum, &cp, &inc), Verdict::Mismatch(w) if w.starts_with("n ")));
}

#[test]
fn a_close_that_differs_is_a_mismatch_in_l() {
    let (sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, u, nets_through(&sum, u), true, true);
    let cp = with_cp(&cp, "l", Some(s(&"b".repeat(32))));
    assert!(matches!(compare(&sum, &cp, &inc), Verdict::Mismatch(w) if w.starts_with("l:")));
}

#[test]
fn the_commitment_and_the_carry_are_compared_when_the_checkpoint_is_at_the_last_round() {
    let (sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, u, nets_through(&sum, u), true, true);
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Agree);
    // A commitment the fold does not want (or none where it does, or one where it wants none).
    let h = with_cp(&cp, "h", Some(s(&"c".repeat(64))));
    assert!(matches!(compare(&sum, &h, &inc), Verdict::Mismatch(w) if w.starts_with("h:")), "{:?}", compare(&sum, &h, &inc));
    // A carry the fold does not hold.
    let other = obj(vec![("p", CVal::Int(4)), ("w", obj(vec![]))]);
    let c = with_cp(&cp, "s", Some(other));
    assert!(matches!(compare(&sum, &c, &inc), Verdict::Mismatch(w) if w.starts_with("s:")), "{:?}", compare(&sum, &c, &inc));
}

#[test]
fn a_commitment_none_where_the_fold_wants_one_is_a_mismatch() {
    // Find a vector whose fold wants a commitment after its last round.
    let mut seen = 0;
    for c in cases() {
        let sum = finished(&c.summary);
        let (Some(u), Some(_)) = (last_decided(&sum), sum.required.as_ref()) else { continue };
        let cp = page_cp(&sum, u, nets_through(&sum, u), true, !sum.carry.is_null());
        if !crate::house::checkpoint_ok(&cp, &c.ctx.inc) {
            continue;
        }
        let none = with_cp(&cp, "h", None);
        assert!(matches!(compare(&sum, &none, &c.ctx.inc), Verdict::Mismatch(w) if w.starts_with("h:")), "{}", c.name);
        seen += 1;
    }
    assert!(seen > 0, "no vector wants a commitment");
}

#[test]
fn a_trim_at_an_earlier_round_is_held_to_the_nets_and_the_close_only() {
    let (sum, inc) = summary("house craps 3");
    let last = last_decided(&sum).unwrap();
    assert!(last >= 2, "a vector with two decided rounds");
    let u = last - 1;
    // The nets through u, not through the last round.
    let cp = page_cp(&sum, u, nets_through(&sum, u), false, true);
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Agree);
    // What the last round did is not what the checkpoint says.
    let wrong = page_cp(&sum, u, nets_through(&sum, last), false, true);
    if nets_through(&sum, last) != nets_through(&sum, u) {
        assert!(matches!(compare(&sum, &wrong, &inc), Verdict::Mismatch(w) if w.starts_with("n ")));
    }
    // The commitment and the carry are the fold's after its LAST round: not asked of a checkpoint before it.
    let with_h = with_cp(&cp, "h", Some(s(&"d".repeat(64))));
    assert_eq!(compare(&sum, &with_h, &inc), Verdict::Agree);
}

#[test]
fn a_fold_that_has_not_got_there_is_skipped() {
    let (sum, inc) = summary("house craps 3");
    let last = last_decided(&sum).unwrap();
    // A round the fold has not decided.
    let mut ahead = sum.clone();
    ahead.rounds.push(crate::house_fold::RoundSummary {
        r: last + 1,
        close: "e".repeat(32),
        decided: None,
        counted: vec![],
        pocket: None,
        deltas: vec![],
        house: None,
        forfeit: None,
        abandon: None,
        copies: None,
        dice: None,
    });
    let cp = page_cp(&ahead, last + 1, nets_through(&sum, last), true, true);
    assert_eq!(compare(&ahead, &cp, &inc), Verdict::Skip(Skip::Behind), "undecided");
    // One that it does not have at all.
    let mut far = page_cp(&sum, last, nets_through(&sum, last), true, true);
    far = with_cp(&far, "u", Some(CVal::Int(last + 5)));
    assert_eq!(compare(&sum, &far, &inc), Verdict::Skip(Skip::Behind), "missing");
    // A hole in the middle.
    let mut holey = sum.clone();
    holey.rounds.retain(|r| r.r != 1);
    let cp = page_cp(&sum, last, nets_through(&sum, last), true, true);
    assert_eq!(compare(&holey, &cp, &inc), Verdict::Skip(Skip::Behind), "a round missing");
}

#[test]
fn a_checkpoint_at_or_before_the_folds_base_is_skipped() {
    let (mut sum, inc) = summary("house craps 3");
    let last = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, last, nets_through(&sum, last), true, true);
    // The fold's base is the checkpoint's round (it has seen it) or beyond.
    sum.base.u = last;
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Skip(Skip::Past));
    sum.base.u = last + 3;
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Skip(Skip::Past));
}

#[test]
fn a_checkpoint_the_pages_would_not_read_is_skipped_and_not_held_against_the_fold() {
    let (sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, u, nets_through(&sum, u), true, true);
    // A zero net is no net the pages write.
    let zero = with_cp(&cp, "n", Some(obj(vec![("alice", s("0"))])));
    assert_eq!(compare(&sum, &zero, &inc), Verdict::Skip(Skip::Unreadable));
    // No round.
    assert_eq!(compare(&sum, &with_cp(&cp, "u", None), &inc), Verdict::Skip(Skip::Unreadable));
    assert_eq!(compare(&sum, &CVal::Int(3), &inc), Verdict::Skip(Skip::Unreadable));
}

#[test]
fn a_fold_with_signatures_unchecked_is_skipped_and_not_held_against_it() {
    let (mut sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, u, nets_through(&sum, u), true, true);
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Agree);
    // Not finished: whatever it shows of the rounds may lack records it has not checked yet.
    sum.pending = true;
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Skip(Skip::Pending));
    let wrong = with_cp(&cp, "l", Some(s(&"b".repeat(32))));
    assert_eq!(compare(&sum, &wrong, &inc), Verdict::Skip(Skip::Pending), "not a mismatch");
}

#[test]
fn nets_too_big_to_add_are_skipped() {
    let (mut sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, u, nets_through(&sum, u), true, true);
    // 40 digits (the longest a net may be) do not fit an i128.
    let big = "9".repeat(40);
    sum.base.n.push(("big".into(), big));
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Skip(Skip::Big));
}

#[test]
fn the_checkpoint_of_a_table_that_ended_carries_no_commitment_or_carry() {
    let mut wanting = 0;
    let mut compared = 0;
    for c in cases() {
        let sum = finished(&c.summary);
        let Some(u) = last_decided(&sum) else { continue };
        let mut cp = page_cp(&sum, u, nets_through(&sum, u), false, false);
        cp = with_cp(&cp, "e", Some(CVal::Int(1)));
        if !checkpoint_ok(&cp, &c.ctx.inc) {
            continue;
        }
        // (Some fold wants a commitment named or carries a state: the ended checkpoint has neither.)
        if sum.required.is_some() || !sum.carry.is_null() {
            wanting += 1;
        }
        assert_eq!(compare(&sum, &cp, &c.ctx.inc), Verdict::Agree, "{}", c.name);
        compared += 1;
    }
    assert!(compared >= 6 && wanting >= 2, "{compared} compared, {wanting} that want a commitment or a carry");
}

#[test]
fn each_verdict_is_counted_under_its_own_name() {
    let mut t = Tally::default();
    t.note(&Verdict::Agree);
    t.note(&Verdict::Mismatch("x".into()));
    for why in [Skip::Past, Skip::Behind, Skip::Big, Skip::Unreadable, Skip::Pending, Skip::Parent, Skip::Stale, Skip::Inputs] {
        t.note(&Verdict::Skip(why));
    }
    assert_eq!(t, Tally { agree: 1, mismatch: 1, past: 1, behind: 1, big: 1, unreadable: 1, pending: 1, parent: 1, stale: 1, inputs: 1 });
    assert_eq!(t.skipped(), 8);
    t.note(&Verdict::Skip(Skip::Pending));
    assert_eq!(t.pending, 2);
}

#[test]
fn a_trim_of_another_session_than_the_one_the_fold_holds_is_skipped_not_held_against_it() {
    let (sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, u, nets_through(&sum, u), true, true);
    assert_eq!(compare(&sum, &cp, &inc), Verdict::Agree);
    // The checkpoint trims a session the fold does not hold (it names another in `b`): its nets
    // build on rounds the fold has not seen, so they are no word on this fold, right or wrong.
    let other = with_cp(&cp, "b", Some(s(&"a".repeat(24))));
    assert!(checkpoint_ok(&other, &inc));
    assert_eq!(compare(&sum, &other, &inc), Verdict::Skip(Skip::Parent));
    let wrong = with_cp(&other, "l", Some(s(&"b".repeat(32))));
    assert_eq!(compare(&sum, &wrong, &inc), Verdict::Skip(Skip::Parent), "not a mismatch either");
}

#[test]
fn nets_are_added_round_by_round_and_one_that_comes_back_to_zero_is_no_net() {
    let (sum, inc) = summary("house craps 3");
    let u = last_decided(&sum).unwrap();
    let cp = page_cp(&sum, u, nets_through(&sum, u), true, true);
    let first = sum.rounds.iter().find(|r| r.decided.is_some()).unwrap().r;
    assert!(first > sum.base.u);
    // A player the base holds 7 for loses 7 in the first round decided after it.
    let mut zero = sum.clone();
    zero.base.n.push(("zed".into(), "7".into()));
    zero.rounds.iter_mut().find(|r| r.r == first).unwrap().deltas.push(("zed".into(), "-7".into()));
    assert_eq!(compare(&zero, &cp, &inc), Verdict::Agree, "zed ends at nothing: the pages write no zero net");
    // And not if it ends at 7.
    let mut seven = sum.clone();
    seven.base.n.push(("zed".into(), "7".into()));
    assert!(matches!(compare(&seven, &cp, &inc), Verdict::Mismatch(w) if w.contains("zed:7")));
    // A net that gains more than a net can hold in a round is skipped, not wrapped round.
    let mut huge = sum.clone();
    // (38 nines fit an i128, two of them do not.)
    let nines = "9".repeat(38);
    assert!(nines.parse::<i128>().is_ok() && nines.parse::<i128>().unwrap().checked_add(nines.parse().unwrap()).is_none());
    huge.base.n.push(("zed".into(), nines.clone()));
    huge.rounds.iter_mut().find(|r| r.r == first).unwrap().deltas.push(("zed".into(), nines));
    assert_eq!(compare(&huge, &cp, &inc), Verdict::Skip(Skip::Big));
}

// ── The driver, with a real doc, mirror, feed, supervisor and engine ─────────

use crate::fold_feed::tests::{engine_maker, ThreadLaunch};
use crate::fold_supervisor::QUEUE_BYTES;
use crate::fold_wire::Req;
use crate::house::to_any;
use crate::house_fold::tests::Case;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use yrs::{Map, MapPrelim};

/// One vector's table in a doc, followed by a `FoldShadow` whose worker is the
/// real engine in a thread.
struct Bench {
    shadow: FoldShadow<ThreadLaunch>,
    doc: Doc,
    case: Case,
    view: Option<FoldView>,
    now: Instant,
    log: Arc<Mutex<Vec<Req>>>,
    refuse: Arc<std::sync::atomic::AtomicBool>,
    listed: bool,
}

impl Bench {
    /// `name`'s vector, its records written (as the pages write them) and the view of the room that follows it.
    fn new(name: &str) -> Bench {
        Bench::with_worker(name, |m| m)
    }

    /// As `new`, with the worker's folder made by `wrap` of the engine's.
    fn with_worker(name: &str, wrap: impl FnOnce(crate::fold_feed::tests::Maker) -> crate::fold_feed::tests::Maker) -> Bench {
        let mut case = cases().into_iter().find(|c| c.name == name).unwrap_or_else(|| panic!("no vector {name}"));
        assert!(case.cp.is_none(), "{name}: a table from its first session");
        // (A vector's hold keeps some signatures unchecked for good, so its fold would stay pending and never be compared:
        // here every signature is checked, and what the fold says is whatever it says, as the tests read it from the answer.)
        case.hold.clear();
        let launch = ThreadLaunch::new(wrap(engine_maker(&case)));
        let (log, refuse) = (launch.log.clone(), launch.refuse.clone());
        let now = Instant::now();
        let bench = Bench {
            shadow: FoldShadow::new(launch, now),
            doc: Doc::new(),
            view: Some(FoldView { tables: vec![(case.ctx.t.clone(), case.ctx.inc.clone())], houses: case.houses.clone(), pins: case.pins.clone(), settled: true }),
            case,
            now,
            log,
            refuse,
            listed: true,
        };
        bench.write_session();
        bench
    }

    fn room(&self) -> &str {
        &self.case.ctx.room
    }

    fn live(&self, base: Option<&CVal>) -> String {
        let c = &self.case.ctx;
        format!("ses:{}:{}:{}", c.t, c.inc, crate::house_bytes::next_sid(c, base).unwrap())
    }

    fn write_session(&self) {
        let live = self.live(None);
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let m = comp.insert(&mut txn, live.as_str(), MapPrelim::default());
        for batch in &self.case.warm {
            for (k, v) in batch {
                match v {
                    Some(v) => {
                        m.insert(&mut txn, k.as_str(), to_any(v));
                    }
                    None => {
                        m.remove(&mut txn, k.as_str());
                    }
                }
            }
        }
    }

    /// A page's trim: its checkpoint written at `sum:<t>:<inc>`, and the table's next session (empty).
    fn put_checkpoint(&self, cp: &CVal) {
        let live = self.live(Some(cp));
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, format!("sum:{}:{}", self.case.ctx.t, self.case.ctx.inc), to_any(cp));
        if comp.get(&txn, &live).is_none() {
            comp.insert(&mut txn, live.as_str(), MapPrelim::default());
        }
    }

    /// The table `t` of the room, with a live session of no records (a house table of the vectors' kind).
    fn empty_table(&self, t: &str) {
        let mut c = self.case.ctx.clone();
        c.t = t.to_string();
        let live = format!("ses:{}:{}:{}", c.t, c.inc, crate::house_bytes::next_sid(&c, None).unwrap());
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, live.as_str(), MapPrelim::default());
    }

    /// A record leaves the live session (a page's compaction, say): the node's answer is not the table as the doc holds it.
    fn remove_a_record(&self) {
        let live = self.live(None);
        let key = self.case.warm.iter().flatten().rev().find(|(_, v)| v.is_some()).map(|(k, _)| k.clone()).expect("a record");
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(yrs::Out::YMap(m)) = comp.get(&txn, &live) else { panic!("no live session") };
        m.remove(&mut txn, key.as_str());
    }

    fn tick(&mut self) {
        let rooms = if self.listed { vec![(self.room().to_string(), self.doc.clone(), self.view.clone())] } else { vec![] };
        self.shadow.tick(self.now, rooms);
    }

    fn until(&mut self, what: &str, mut done: impl FnMut(&mut Self) -> bool) {
        for _ in 0..3_000 {
            self.tick();
            if done(self) {
                return;
            }
            thread::sleep(Duration::from_millis(2));
        }
        panic!("never: {what} ({:?}, {:?})", self.shadow.tally, self.shadow.counts());
    }

    fn ticks(&mut self, n: usize) {
        for _ in 0..n {
            self.tick();
            thread::sleep(Duration::from_millis(1));
        }
    }

    fn caught_up(&self) -> bool {
        self.shadow.rooms.get(self.room()).is_some_and(|rs| rs.feed.caught_up(&self.case.ctx.t, &self.case.ctx.inc, &rs.mirror, &self.shadow.sup))
    }

    /// What the node folded of the table, as the worker answered.
    fn answer(&self) -> FoldSummary {
        let rs = &self.shadow.rooms[self.room()];
        rs.feed.fold(&self.case.ctx.t, &self.case.ctx.inc).expect("an answer").summary.clone()
    }

    /// The checkpoint a page that decided what the fold did writes.
    fn page_trim(&self, sum: &FoldSummary) -> CVal {
        let u = last_decided(sum).expect("a decided round");
        page_cp(sum, u, nets_through(sum, u), true, !sum.carry.is_null())
    }

    /// The Forgets the worker has been sent, once its thread has read all that was posted.
    fn forgets(&self) -> usize {
        let c = self.shadow.counts();
        let posted = (c.cold + c.warm + c.forgets) as usize;
        for _ in 0..100 {
            if self.log.lock().unwrap().len() >= posted {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        self.log.lock().unwrap().iter().filter(|r| matches!(r, Req::Forget { .. })).count()
    }
}

/// The house tables of the vectors that start from their first session.
fn house_vectors() -> Vec<String> {
    cases().into_iter().filter(|c| c.name.starts_with("house") && c.cp.is_none() && !c.warm.is_empty()).map(|c| c.name).collect()
}

#[test]
fn a_pages_trim_that_the_node_folded_alike_is_counted_as_agreed_once() {
    let mut met = 0;
    for name in house_vectors() {
        let name = name.as_str();
        let mut b = Bench::new(name);
        b.until("the first answer", |b| b.caught_up());
        let sum = b.answer();
        if last_decided(&sum).is_none() {
            continue;
        }
        met += 1;
        let cp = b.page_trim(&sum);
        assert!(crate::house::checkpoint_ok(&cp, &b.case.ctx.inc), "{name}");
        b.put_checkpoint(&cp);
        b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
        assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() }, "{name}");
        // The table starts over from the trim and is answered; nothing is counted again.
        b.until("the new start answered", |b| b.caught_up());
        b.ticks(20);
        assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() }, "{name}: once");
        // The same checkpoint written again starts nothing over.
        b.put_checkpoint(&cp);
        b.ticks(20);
        assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() }, "{name}: the same trim again");
    }
    assert!(met >= 2, "{met} of the vectors have a decided round");
}

#[test]
fn a_pages_trim_that_the_node_folded_otherwise_is_a_mismatch() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    let sum = b.answer();
    let u = last_decided(&sum).unwrap();
    let mut n = nets_through(&sum, u);
    let x: i128 = n[0].1.parse().unwrap();
    n[0].1 = (x + 1).to_string();
    b.put_checkpoint(&page_cp(&sum, u, n, true, true));
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    assert_eq!(b.shadow.tally, Tally { mismatch: 1, ..Tally::default() });
    let r = b.shadow.report();
    assert_eq!((r.shadow_agreed, r.shadow_mismatches, r.shadow_skipped), (0, 1, 0));
}

#[test]
fn a_trim_past_what_the_node_has_decided_is_skipped_not_held_against_it() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    let sum = b.answer();
    let u = last_decided(&sum).unwrap() + 3;
    let close = sum.rounds[0].close.clone();
    let cp = obj(vec![
        ("v", CVal::Int(1)),
        ("b", s("g")),
        ("u", CVal::Int(u)),
        ("l", s(&close)),
        ("n", obj(vec![])),
        ("s", obj(vec![("p", CVal::Int(0)), ("w", obj(vec![]))])),
        ("k", s(&"K".repeat(43))),
        ("g", s(&"G".repeat(86))),
    ]);
    assert!(crate::house::checkpoint_ok(&cp, &b.case.ctx.inc));
    b.put_checkpoint(&cp);
    b.until("skipped", |b| b.shadow.tally.behind > 0);
    assert_eq!(b.shadow.tally, Tally { behind: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_skipped, 1);
}

#[test]
fn a_trim_that_comes_before_the_node_has_an_answer_is_not_compared() {
    let mut b = Bench::new("house craps 3");
    // The checkpoint is in the doc before the first tick: the table starts on it.
    let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
    b.put_checkpoint(&b.page_trim(&sum));
    b.until("followed", |b| b.shadow.rooms.get(b.room()).is_some_and(|rs| rs.mirror.state(&b.case.ctx.t, &b.case.ctx.inc).is_some_and(|st| st.settled)));
    b.ticks(30);
    assert_eq!(b.shadow.tally, Tally::default());
}

#[test]
fn a_room_that_is_no_longer_followed_has_its_tables_forgotten_and_goes() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    assert_eq!(b.shadow.rooms.len(), 1);
    let before = b.shadow.counts();
    assert!(before.cold >= 1);
    // The house finds nothing to follow there (its delegation is gone, say).
    b.view = None;
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1, "the worker was told");
    assert_eq!(b.shadow.counts().cold, before.cold, "what the room did stays counted");
    // It is followed afresh when there is something again.
    b.view = Some(FoldView { tables: vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())], houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true });
    b.until("followed again", |b| b.caught_up());
    assert_eq!(b.shadow.counts().cold, before.cold + 1);
}

#[test]
fn a_room_the_node_no_longer_serves_is_let_go_of_the_same_way() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.listed = false;
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1);
}

#[test]
fn a_view_with_other_tables_follows_them_and_lets_the_old_ones_go() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.view.as_mut().unwrap().tables = vec![("elsewhere".to_string(), b.case.ctx.inc.clone())];
    b.until("the table is forgotten", |b| b.forgets() == 1);
    let rs = &b.shadow.rooms[b.room()];
    assert!(rs.feed.fold(&b.case.ctx.t, &b.case.ctx.inc).is_none());
}

#[test]
fn when_the_fold_duties_are_off_for_good_nothing_is_followed_and_the_report_says_so() {
    let mut b = Bench::new("house roulette 3");
    assert_eq!(b.shadow.report().off, None);
    // A worker that will not start, three times within ten minutes.
    b.refuse.store(true, Ordering::SeqCst);
    for _ in 0..8 {
        b.now += Duration::from_secs(70);
        b.tick();
        if b.shadow.sup.off().is_some() {
            break;
        }
    }
    assert_eq!(b.shadow.sup.off(), Some("crashes"));
    b.tick();
    assert!(b.shadow.rooms.is_empty(), "nothing is followed");
    let r = b.shadow.report();
    assert_eq!((r.off.as_deref(), r.rooms), (Some("crashes"), 0));
    // (Ticks go on without a worker to start, a room, or anything to hold.)
    b.ticks(5);
    assert!(b.shadow.rooms.is_empty());
}

#[test]
fn the_report_adds_up_what_the_shadow_found_and_what_the_feeds_did() {
    let mut b = Bench::new("house roulette 3");
    b.shadow.tally = Tally { agree: 1, mismatch: 2, past: 3, behind: 4, big: 5, unreadable: 6, pending: 7, parent: 8, stale: 9, inputs: 10 };
    b.shadow.gone = Counts { cold: 10, warm: 20, forgets: 30, results: 40, dirty: 11, lost: 12, busy: 50, too_big: 13, bad_results: 14 };
    let r = b.shadow.report();
    assert_eq!((r.shadow_agreed, r.shadow_mismatches), (1, 2));
    assert_eq!(r.shadow_skipped, 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10, "every kind of skip");
    assert_eq!((r.cold_folds, r.dirty, r.lost), (10, 11, 12));
    assert_eq!(r.bad_results, 14 + 13, "a result and a frame nobody could use");
}

#[test]
fn what_the_rooms_did_stays_counted_when_the_fold_duties_go_off() {
    // The worker's second request ends it, and none starts again.
    let mut b = Bench::with_worker("house roulette 3", |m| crate::fold_feed::tests::dying_at(m, 2));
    b.until("the first answer", |b| b.caught_up());
    assert_eq!(b.shadow.report().cold_folds, 1);
    b.refuse.store(true, Ordering::SeqCst);
    let sum = b.answer();
    b.put_checkpoint(&b.page_trim(&sum));
    for _ in 0..12 {
        b.now += Duration::from_secs(70);
        b.tick();
        thread::sleep(Duration::from_millis(5));
        if b.shadow.sup.off().is_some() {
            break;
        }
    }
    assert_eq!(b.shadow.sup.off(), Some("crashes"));
    b.tick();
    assert!(b.shadow.rooms.is_empty());
    let r = b.shadow.report();
    assert_eq!((r.off.as_deref(), r.rooms), (Some("crashes"), 0));
    assert!(r.cold_folds >= 1, "the Cold the room sent before is still counted");
}

#[test]
fn a_room_is_not_let_go_of_before_the_worker_has_been_told_of_its_tables() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    // The pipe is full when the house finds nothing to follow there.
    b.shadow.sup.clog(QUEUE_BYTES);
    b.view = None;
    for _ in 0..5 {
        b.tick();
        assert_eq!(b.shadow.rooms.len(), 1, "the Forget waits for the pipe");
    }
    b.shadow.sup.unclog(QUEUE_BYTES);
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1);
}

#[test]
fn a_room_followed_again_before_it_was_let_go_of_is_kept() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.shadow.sup.clog(QUEUE_BYTES);
    b.view = None;
    b.ticks(3);
    // The house finds the room and its table again while the worker still has to be told.
    b.view = Some(FoldView { tables: vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())], houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true });
    b.shadow.sup.unclog(QUEUE_BYTES);
    for _ in 0..6 {
        b.tick();
        assert_eq!(b.shadow.rooms.len(), 1, "followed, so not let go of");
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(b.forgets(), 1, "(and the worker was told of the old table before the new start)");
    b.until("answered afresh", |b| b.caught_up());
}

#[test]
fn the_report_names_the_rules_and_letters_and_does_not_attest() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    let r = b.shadow.report();
    assert_eq!(r.letters, "rd");
    assert_eq!(r.rules.get("r").map(String::as_str), Some("h1"));
    assert_eq!(r.rules.get("d").map(String::as_str), Some("h1"));
    assert!(!r.attest);
    assert_eq!((r.rooms, r.cold_folds, r.dirty, r.worker_starts, r.worker_restarts, r.worker_failures), (1, 1, 0, 1, 0, 0));
    assert_eq!(r.off, None);
    let json = serde_json::to_value(&r).unwrap();
    for field in ["rules", "letters", "attest", "shadowAgreed", "shadowMismatches", "shadowSkipped", "coldFolds", "dirty", "workerRestarts"] {
        assert!(json.get(field).is_some(), "{field}");
    }
}

#[test]
fn the_houses_own_tick_and_the_shadow_follow_a_delegated_room_together() {
    use crate::fold_worker::EngineFolder;
    use crate::house::tests::{Room, INC, ROOM, T};
    let mut room = Room::new("shadow-whole", true);
    let launch = ThreadLaunch::new(Arc::new(|| Box::new(EngineFolder::strict().expect("the engine starts"))));
    let shadow = Mutex::new(FoldShadow::new(launch, Instant::now()));
    let mut report = None;
    for _ in 0..3_000 {
        // The house's tick (it joins round 1 with a record of its own), then the shadow's.
        room.tick(200);
        report = tick_shadow(&shadow, vec![(ROOM.to_string(), room.doc.clone())], Instant::now(), |r, doc| room.house.fold_view(r, doc, room.now));
        let answered = {
            let sh = shadow.lock().unwrap();
            sh.rooms.get(ROOM).is_some_and(|rs| rs.feed.fold(T, INC).is_some())
        };
        if answered {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    let report = report.expect("a report");
    assert_eq!((report.rooms, report.cold_folds, report.dirty, report.off.as_deref()), (1, 1, 0, None));
    assert_eq!(report.shadow_mismatches, 0);
    let sh = shadow.lock().unwrap();
    let fold = sh.rooms[ROOM].feed.fold(T, INC).unwrap();
    assert!(fold.summary.house_table, "the table is folded by the house rules");
    assert!(fold.summary.records >= 1, "the house's own join is in what the node folded");
    assert_eq!(room.records("o:1:").len(), 1);
}

#[test]
fn the_checkpoint_that_ended_a_table_is_compared_before_the_table_is_let_go_of() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let cp = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    assert!(checkpoint_ok(&cp, &b.case.ctx.inc));
    b.put_checkpoint(&cp);
    // The table has ended: the house follows it no longer, as the same pass finds the page's checkpoint.
    b.view.as_mut().unwrap().tables.clear();
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() }, "once");
}

#[test]
fn nothing_is_remembered_of_the_checkpoint_of_a_table_that_has_gone_from_a_room_that_goes_on() {
    let mut b = Bench::new("house roulette 3");
    let inc = b.case.ctx.inc.clone();
    b.empty_table("other");
    b.view.as_mut().unwrap().tables.push(("other".to_string(), inc.clone()));
    b.until("both answered", |b| b.caught_up() && b.shadow.rooms[b.room()].feed.fold("other", &inc).is_some());
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let cp = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    b.put_checkpoint(&cp);
    let table = (b.case.ctx.t.clone(), inc.clone());
    b.view.as_mut().unwrap().tables.retain(|t| *t != table);
    b.until("compared", |b| b.shadow.tally.agree > 0);
    assert_eq!(b.shadow.rooms[b.room()].compared.len(), 1);
    b.until("the table is let go of", |b| b.forgets() == 1);
    assert!(b.shadow.rooms[b.room()].compared.is_empty(), "the room goes on with its other table, and remembers nothing of the one gone");
}

#[test]
fn a_difference_found_while_the_answer_was_not_the_table_as_the_node_reads_it_is_stale_not_a_mismatch() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    let sum = b.answer();
    let u = last_decided(&sum).unwrap();
    let mut n = nets_through(&sum, u);
    let x: i128 = n[0].1.parse().unwrap();
    n[0].1 = (x + 1).to_string();
    let wrong = page_cp(&sum, u, n, true, true);
    // The pipe to the worker is full when a record leaves the room: the node has read the change and
    // has not been able to tell the worker, so the answer in hand is of the table as it was.
    b.shadow.sup.clog(QUEUE_BYTES);
    b.remove_a_record();
    b.ticks(3);
    assert!(!b.caught_up());
    b.put_checkpoint(&wrong);
    b.until("passed over", |b| b.shadow.tally.stale > 0);
    assert_eq!(b.shadow.tally, Tally { stale: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_mismatches, 0);
    // The pipe clears and the table is answered afresh: the same checkpoint is not compared again.
    b.shadow.sup.unclog(QUEUE_BYTES);
    b.until("answered afresh", |b| b.caught_up());
    b.ticks(20);
    assert_eq!(b.shadow.tally, Tally { stale: 1, ..Tally::default() }, "once");
}

#[test]
fn a_checkpoint_already_compared_is_not_compared_again_when_the_table_starts_over_for_another_reason() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    let sum = b.answer();
    let cp = b.page_trim(&sum);
    b.put_checkpoint(&cp);
    b.until("compared", |b| b.shadow.tally.agree > 0);
    b.until("the new start answered", |b| b.caught_up());
    // The table starts over again with the same checkpoint (its live session is replaced), while the
    // worker cannot be told: the answer in hand is the one made before the trim, and still older than the table.
    b.shadow.sup.clog(QUEUE_BYTES);
    {
        let live = b.live(Some(&cp));
        let comp = b.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = b.doc.transact_mut();
        comp.insert(&mut txn, live.as_str(), MapPrelim::default());
    }
    b.ticks(10);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
}

#[test]
fn a_difference_is_not_counted_while_the_rooms_players_are_not_all_pinned_yet() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    let sum = b.answer();
    let u = last_decided(&sum).unwrap();
    let mut n = nets_through(&sum, u);
    let x: i128 = n[0].1.parse().unwrap();
    n[0].1 = (x + 1).to_string();
    b.view.as_mut().unwrap().settled = false;
    b.put_checkpoint(&page_cp(&sum, u, n, true, true));
    b.until("passed over", |b| b.shadow.tally.inputs > 0);
    assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_mismatches, 0);
}

#[test]
fn a_room_with_no_table_to_follow_is_not_attached_to() {
    let mut b = Bench::new("house roulette 3");
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(10);
    assert!(b.shadow.rooms.is_empty(), "no mirror on a room with nothing in it to fold");
    assert_eq!(ATTACHED.with(|n| n.get()), 0, "not even for a tick");
    let r = b.shadow.report();
    assert_eq!((r.rooms, r.tables, r.tables_over, r.cold_folds), (0, 0, 0, 0));
}

#[test]
fn a_room_with_more_house_tables_than_the_worker_holds_follows_the_first_and_says_how_many_it_did_not() {
    let mut b = Bench::new("house roulette 3");
    let inc = b.case.ctx.inc.clone();
    let tables: Vec<(String, String)> = (0..20).map(|i| (format!("t{i:02}"), inc.clone())).collect();
    for (t, _) in &tables {
        b.empty_table(t);
    }
    b.view.as_mut().unwrap().tables = tables;
    b.until("the followed are answered", |b| b.shadow.counts().results >= MAX_SHADOW_TABLES as u64);
    b.ticks(40);
    let r = b.shadow.report();
    assert_eq!((r.tables, r.tables_over), (MAX_SHADOW_TABLES as u64, 6));
    assert_eq!((r.cold_folds, r.dirty, r.lost), (MAX_SHADOW_TABLES as u64, 0, 0), "no table evicts another");
    // The tables followed are the first the view lists, whatever happens to the rest.
    let rs = &b.shadow.rooms[b.room()];
    assert!(rs.feed.fold("t00", &inc).is_some() && rs.feed.fold(&format!("t{:02}", MAX_SHADOW_TABLES - 1), &inc).is_some());
    assert!(rs.feed.fold(&format!("t{:02}", MAX_SHADOW_TABLES), &inc).is_none());
}

#[test]
fn the_tables_a_worker_can_hold_are_shared_between_the_rooms_in_room_order() {
    let mut b = Bench::new("house roulette 3");
    let inc = b.case.ctx.inc.clone();
    let mut docs = Vec::new();
    for room in ["room-b", "room-a"] {
        let mut c = b.case.ctx.clone();
        c.room = room.to_string();
        let doc = Doc::new();
        let tables: Vec<(String, String)> = (0..10).map(|i| (format!("t{i}"), inc.clone())).collect();
        {
            let comp = doc.get_or_insert_map(crate::house::COMPUTED_MAP);
            let mut txn = doc.transact_mut();
            for (t, _) in &tables {
                c.t = t.clone();
                comp.insert(&mut txn, format!("ses:{t}:{inc}:{}", crate::house_bytes::next_sid(&c, None).unwrap()), MapPrelim::default());
            }
        }
        let view = FoldView { tables, houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true };
        docs.push((room.to_string(), doc, Some(view)));
    }
    for _ in 0..200 {
        b.shadow.tick(b.now, docs.clone());
        thread::sleep(Duration::from_millis(2));
    }
    let r = b.shadow.report();
    assert_eq!((r.tables, r.tables_over), (MAX_SHADOW_TABLES as u64, 20 - MAX_SHADOW_TABLES as u64));
    // (Room order, not the order the node listed them: room-a has all of its ten, room-b the rest.)
    let followed = |room: &str| b.shadow.rooms[room].mirror.tables().count();
    assert_eq!((followed("room-a"), followed("room-b")), (10, MAX_SHADOW_TABLES - 10));
}

#[test]
fn a_tick_that_panics_costs_the_shadow_its_tick_and_nothing_else() {
    let b = Bench::new("house roulette 3");
    let shadow = Mutex::new(FoldShadow::new(ThreadLaunch::new(engine_maker(&b.case)), Instant::now()));
    let got = tick_shadow(&shadow, vec![(b.room().to_string(), b.doc.clone())], Instant::now(), |_, _| panic!("the house's view went wrong"));
    assert!(got.is_none());
    // The shadow goes on (its lock was not held while the view was found).
    let got = tick_shadow(&shadow, vec![], Instant::now(), |_, _| None);
    assert_eq!(got.map(|r| r.rooms), Some(0));
}
