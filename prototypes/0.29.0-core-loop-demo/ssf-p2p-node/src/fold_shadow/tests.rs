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
    for why in [Skip::Past, Skip::Behind, Skip::Big, Skip::Unreadable, Skip::Pending, Skip::Parent, Skip::Stale, Skip::Inputs, Skip::Unanswered] {
        t.note(&Verdict::Skip(why));
    }
    assert_eq!(t, Tally { agree: 1, mismatch: 1, past: 1, behind: 1, big: 1, unreadable: 1, pending: 1, parent: 1, stale: 1, inputs: 1, unanswered: 1 });
    assert_eq!(t.skipped(), 9);
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
            view: Some(FoldView { tables: vec![(case.ctx.t.clone(), case.ctx.inc.clone())], houses: case.houses.clone(), pins: case.pins.clone(), settled: true, pins_epoch: 0, watch: None }),
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
    b.view = Some(FoldView { tables: vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())], houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true, pins_epoch: 0, watch: None });
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
    b.shadow.tally = Tally { agree: 1, mismatch: 2, past: 3, behind: 4, big: 5, unreadable: 6, pending: 7, parent: 8, stale: 9, inputs: 10, unanswered: 11 };
    b.shadow.gone = Counts { cold: 10, warm: 20, forgets: 30, results: 40, dirty: 11, lost: 12, busy: 50, too_big: 13, bad_results: 14 };
    let r = b.shadow.report();
    assert_eq!((r.shadow_agreed, r.shadow_mismatches), (1, 2));
    assert_eq!(r.shadow_skipped, 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11, "every kind of skip");
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
    b.view = Some(FoldView { tables: vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())], houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true, pins_epoch: 0, watch: None });
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
        report = tick_shadow(&shadow, vec![(ROOM.to_string(), room.doc.clone())], Instant::now(), |r| room.house.fold_plan(r));
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
    assert!(b.shadow.rooms[b.room()].confirmed.contains_key(&table), "(shown whole while it was followed)");
    b.view.as_mut().unwrap().tables.retain(|t| *t != table);
    b.until("compared", |b| b.shadow.tally.agree > 0);
    assert_eq!(b.shadow.rooms[b.room()].compared.len(), 1);
    b.until("the table is let go of", |b| b.forgets() == 1);
    assert!(b.shadow.rooms[b.room()].compared.is_empty(), "the room goes on with its other table, and remembers nothing of the one gone");
    assert!(!b.shadow.rooms[b.room()].confirmed.contains_key(&table), "nor of what was shown of it");
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
        let view = FoldView { tables, houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true, pins_epoch: 0, watch: None };
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
    let got = tick_shadow(&shadow, vec![(b.room().to_string(), b.doc.clone())], Instant::now(), |_| panic!("the house's plan went wrong"));
    assert!(got.is_none());
    // The shadow goes on (its lock was not held while the view was found).
    let got = tick_shadow(&shadow, vec![], Instant::now(), |_| None);
    assert_eq!(got.map(|r| r.rooms), Some(0));
}

// ── Review round 2 ───────────────────────────────────────────────────────────

use crate::house_mirror::Limits;

impl Bench {
    /// A page's checkpoint for table `t` of the room, as a trim (no session of the old one is left in the doc).
    fn put_checkpoint_for(&self, t: &str, cp: &CVal) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, format!("sum:{t}:{}", self.case.ctx.inc), to_any(cp));
    }

    /// The table `t` of the room with the records of the vector in its live session (they are the vector's, signed for
    /// another table: the fold counts none of them, and the mirror reads every one).
    fn big_table(&self, t: &str) {
        let mut c = self.case.ctx.clone();
        c.t = t.to_string();
        let live = format!("ses:{}:{}:{}", c.t, c.inc, crate::house_bytes::next_sid(&c, None).unwrap());
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let m = comp.insert(&mut txn, live.as_str(), MapPrelim::default());
        for batch in &self.case.warm {
            for (k, v) in batch {
                if let Some(v) = v {
                    m.insert(&mut txn, k.as_str(), to_any(v));
                }
            }
        }
    }

    /// Every record of the table `t` written again: changes for the mirror to read (and nothing for the fold to count).
    fn dirty(&self, t: &str) {
        let mut c = self.case.ctx.clone();
        c.t = t.to_string();
        let live = format!("ses:{}:{}:{}", c.t, c.inc, crate::house_bytes::next_sid(&c, None).unwrap());
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(yrs::Out::YMap(m)) = comp.get(&txn, &live) else { panic!("no session {live}") };
        for batch in &self.case.warm {
            for (k, v) in batch {
                if let Some(v) = v {
                    m.insert(&mut txn, k.as_str(), to_any(v));
                }
            }
        }
    }

    /// A wrong page's trim of the vector: the nets one off.
    fn wrong_trim(&self, sum: &FoldSummary) -> CVal {
        let u = last_decided(sum).unwrap();
        let mut n = nets_through(sum, u);
        let x: i128 = n[0].1.parse().unwrap();
        n[0].1 = (x + 1).to_string();
        page_cp(sum, u, n, true, true)
    }
}

/// Inputs not shown to be everything the room held while the session was in it, from the first tick.
#[test]
fn a_difference_is_not_counted_when_no_tick_showed_the_inputs_whole() {
    let mut b = Bench::new("house craps 3");
    b.view.as_mut().unwrap().settled = false;
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    b.put_checkpoint(&wrong);
    b.until("passed over", |b| b.shadow.tally.inputs > 0);
    assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_mismatches, 0);
}

/// An earlier pass that missed a house, and a trim that removes its records: the pass after the
/// trim finds nothing unresolved, and says so, but the session it is asked about is gone.
#[test]
fn a_view_settled_only_after_the_trim_shows_nothing_of_the_session_the_trim_removed() {
    let mut b = Bench::new("house craps 3");
    b.view.as_mut().unwrap().settled = false;
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    b.put_checkpoint(&wrong);
    b.view.as_mut().unwrap().settled = true;
    b.until("passed over", |b| b.shadow.tally.inputs > 0);
    assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() });
}

/// What a settled view showed before is taken back by one that is not (a key replaced, a house not known).
#[test]
fn an_answer_shown_complete_is_taken_back_when_a_later_tick_is_unsettled() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    assert!(!b.shadow.rooms[b.room()].confirmed.is_empty(), "shown whole while the session was in the room");
    b.view.as_mut().unwrap().settled = false;
    b.tick();
    assert!(b.shadow.rooms[b.room()].confirmed.is_empty());
    let wrong = b.wrong_trim(&b.answer());
    b.put_checkpoint(&wrong);
    b.until("passed over", |b| b.shadow.tally.inputs > 0);
    assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() });
}

/// What was shown of an earlier answer is not shown of a later one: the inputs changed in a frame
/// whose answer no settled tick has seen yet when the trim comes.
#[test]
fn an_answer_to_a_later_frame_is_not_the_one_that_was_shown_whole() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let sum = b.answer();
    let wrong = b.wrong_trim(&sum);
    // A player's key is pinned: a frame with new inputs (no change to a record), and its answer is the same fold.
    let warm = b.shadow.counts().warm;
    b.view.as_mut().unwrap().pins.push(("zed".to_string(), "Z".repeat(43)));
    b.until("the new inputs sent", |b| b.shadow.counts().warm > warm);
    thread::sleep(Duration::from_millis(400));
    // The trim comes before the tick that takes the answer: the same tick reads it.
    b.put_checkpoint(&wrong);
    b.tick();
    assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_mismatches, 0);
}

/// What was shown of an earlier taking up of a table is not shown of this one: a table let go of and
/// taken again has its answers numbered afresh, and the number may come round to the same.
#[test]
fn an_answer_shown_whole_for_an_earlier_taking_up_of_the_table_is_not_the_one_compared() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    let room = b.room().to_string();
    let key = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    let shown = *b.shadow.rooms[&room].confirmed.get(&key).expect("shown whole by now");
    // (The same frame of the answer, as of the table's first taking up.)
    b.shadow.rooms.get_mut(&room).unwrap().confirmed.insert(key, Shown { born: shown.born.wrapping_add(1), ..shown });
    b.put_checkpoint(&wrong);
    b.tick();
    assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_mismatches, 0);
}

/// A page wrote to the session, and trimmed it, between two of the node's drains: the one drain
/// reads the base and drops the session unread.
#[test]
fn a_difference_is_stale_when_the_page_wrote_to_the_session_the_node_had_not_read_before_it_trimmed_it() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    // A competing close, say: a record changes, and the trim follows.
    b.remove_a_record();
    b.put_checkpoint(&wrong);
    b.until("passed over", |b| b.shadow.tally.stale > 0);
    assert_eq!(b.shadow.tally, Tally { stale: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_mismatches, 0);
}

/// With a drain that runs short of the table whose checkpoint ended it, the table is kept until
/// the drain gets to it: its checkpoint is compared, not forgotten.
#[test]
fn a_table_that_ended_is_kept_until_a_short_drain_has_read_its_last_checkpoint() {
    for extra in [0, 1] {
        let mut b = Bench::new("house roulette 3");
        b.shadow.limits = Limits { drain_paths: 3, ..Limits::default() };
        let inc = b.case.ctx.inc.clone();
        let table = (b.case.ctx.t.clone(), inc.clone());
        // (A table that sorts first and has more to read than a drain gives: the drains take turns.)
        b.big_table("0-big");
        b.view.as_mut().unwrap().tables.push(("0-big".to_string(), inc.clone()));
        b.until("both answered", |b| b.caught_up() && b.shadow.rooms[b.room()].feed.fold("0-big", &inc).is_some());
        let sum = b.answer();
        let u = last_decided(&sum).expect("a decided round");
        let cp = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
        assert!(checkpoint_ok(&cp, &inc));
        for _ in 0..extra {
            b.dirty("0-big");
            b.tick();
        }
        b.put_checkpoint(&cp);
        b.view.as_mut().unwrap().tables.retain(|t| *t != table);
        for _ in 0..30 {
            b.dirty("0-big");
            b.tick();
            thread::sleep(Duration::from_millis(2));
            if b.shadow.tally.agree > 0 {
                break;
            }
        }
        assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() }, "extra={extra}: compared, once");
        b.until("let go", |b| b.shadow.rooms[b.room()].mirror.state(&table.0, &table.1).is_none());
        assert_eq!(b.forgets(), 1, "extra={extra}: and then the worker was told");
    }
}

/// The tables kept for their last checkpoint have their places in the worker: the view's are the
/// fewer by as many, so the worker never holds more than it has room for.
#[test]
fn the_places_of_the_tables_kept_for_a_last_checkpoint_are_not_given_to_others() {
    let mut b = Bench::new("house roulette 3");
    b.shadow.limits = Limits { drain_paths: 1, ..Limits::default() };
    let inc = b.case.ctx.inc.clone();
    let names: Vec<String> = (0..MAX_SHADOW_TABLES + 1).map(|i| format!("t{i:02}")).collect();
    for t in &names {
        b.empty_table(t);
    }
    b.view.as_mut().unwrap().tables = names.iter().take(MAX_SHADOW_TABLES).map(|t| (t.clone(), inc.clone())).collect();
    b.until("all answered", |b| b.shadow.counts().results >= MAX_SHADOW_TABLES as u64);
    b.ticks(10);
    assert_eq!(b.shadow.report().tables, MAX_SHADOW_TABLES as u64);
    // t00 ends (a page's final checkpoint) as t14 comes to the view.
    let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
    let u = last_decided(&sum).expect("a decided round");
    let cp = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    b.put_checkpoint_for("t00", &cp);
    b.view.as_mut().unwrap().tables = names.iter().skip(1).map(|t| (t.clone(), inc.clone())).collect();
    let mut most = 0;
    let mut compared = false;
    for _ in 0..400 {
        b.tick();
        most = most.max(b.shadow.rooms[b.room()].mirror.tables().count());
        let sh = &b.shadow;
        compared |= sh.tally.skipped() + sh.tally.agree + sh.tally.mismatch > 0;
        thread::sleep(Duration::from_millis(1));
        if compared && b.shadow.rooms[b.room()].mirror.state("t14", &inc).is_some() {
            break;
        }
    }
    assert!(most <= MAX_SHADOW_TABLES, "{most} tables held at once");
    assert!(compared, "the checkpoint of the table that ended was compared (or passed over and counted)");
    assert!(b.shadow.rooms[b.room()].mirror.state("t14", &inc).is_some(), "and the new table came when the old one was let go");
}

/// A table of the view whose checkpoint has not been read yet is followed, and is not also one that
/// is kept after the view lets it go: it takes one place, not two.
#[test]
fn a_followed_table_whose_trim_is_not_read_yet_takes_one_place_in_the_worker() {
    let mut b = Bench::new("house roulette 3");
    let inc = b.case.ctx.inc.clone();
    let names: Vec<String> = (0..MAX_SHADOW_TABLES).map(|i| format!("t{i:02}")).collect();
    for t in &names {
        b.empty_table(t);
    }
    b.view.as_mut().unwrap().tables = names.iter().map(|t| (t.clone(), inc.clone())).collect();
    b.until("all answered", |b| b.shadow.counts().results >= MAX_SHADOW_TABLES as u64);
    b.ticks(5);
    assert_eq!(b.shadow.report().tables, MAX_SHADOW_TABLES as u64);
    // A page trims t00, which the view still follows: the trim is noted, and read at the tick's drain.
    let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
    let u = last_decided(&sum).expect("a decided round");
    b.put_checkpoint_for("t00", &page_cp(&sum, u, nets_through(&sum, u), false, false));
    b.tick();
    let r = b.shadow.report();
    assert_eq!((r.tables, r.tables_over), (MAX_SHADOW_TABLES as u64, 0), "every table of the view is still followed");
}

/// The worker holds so many tables: those to go are told of, in every room, before any room asks for a new one.
#[test]
fn every_table_to_go_is_let_go_of_in_every_room_before_a_new_one_is_asked_for() {
    let mut b = Bench::new("house roulette 3");
    let (inc, houses, pins, ctx) = (b.case.ctx.inc.clone(), b.case.houses.clone(), b.case.pins.clone(), b.case.ctx.clone());
    let docs: Vec<(String, Doc)> = ["room-a", "room-b"].iter().map(|r| (r.to_string(), Doc::new())).collect();
    let make = |doc: &Doc, room: &str, names: &[String]| {
        let mut c = ctx.clone();
        c.room = room.to_string();
        let comp = doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = doc.transact_mut();
        for t in names {
            c.t = t.clone();
            comp.insert(&mut txn, format!("ses:{t}:{inc}:{}", crate::house_bytes::next_sid(&c, None).unwrap()), MapPrelim::default());
        }
    };
    let names = |p: &str, from: usize, to: usize| -> Vec<String> { (from..to).map(|i| format!("{p}{i}")).collect() };
    let view = |ts: &[String]| FoldView { tables: ts.iter().map(|t| (t.clone(), inc.clone())).collect(), houses: houses.clone(), pins: pins.clone(), settled: true, pins_epoch: 0, watch: None };
    // Room a has 7 tables and room b 7: the worker is full.
    let (a1, b1) = (names("a", 0, 7), names("b", 0, 7));
    make(&docs[0].1, "room-a", &names("a", 0, 10));
    make(&docs[1].1, "room-b", &names("b", 0, 7));
    for _ in 0..300 {
        b.shadow.tick(b.now, vec![(docs[0].0.clone(), docs[0].1.clone(), Some(view(&a1))), (docs[1].0.clone(), docs[1].1.clone(), Some(view(&b1)))]);
        thread::sleep(Duration::from_millis(2));
        if b.shadow.counts().results >= 14 {
            break;
        }
    }
    assert_eq!(b.shadow.counts().results, 14);
    let posted = |b: &Bench| (b.shadow.counts().cold + b.shadow.counts().warm + b.shadow.counts().forgets) as usize;
    let before = posted(&b);
    for _ in 0..40 {
        thread::sleep(Duration::from_millis(1));
        if b.log.lock().unwrap().len() >= before {
            break;
        }
    }
    let seen = b.log.lock().unwrap().len();
    // Room a, which is told of first, takes three more; room b gives up three.
    let (a2, b2) = (names("a", 0, 10), names("b", 0, 4));
    for _ in 0..4 {
        b.shadow.tick(b.now, vec![(docs[0].0.clone(), docs[0].1.clone(), Some(view(&a2))), (docs[1].0.clone(), docs[1].1.clone(), Some(view(&b2)))]);
        thread::sleep(Duration::from_millis(2));
    }
    let after = posted(&b);
    for _ in 0..100 {
        if b.log.lock().unwrap().len() >= after {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    let log = b.log.lock().unwrap();
    let new: Vec<&Req> = log.iter().skip(seen).collect();
    let last_forget = new.iter().rposition(|r| matches!(r, Req::Forget { .. })).expect("room b's three were forgotten");
    let first_cold = new.iter().position(|r| matches!(r, Req::Cold(_))).expect("room a's three were asked for");
    assert!(last_forget < first_cold, "the forgets come first: {:?}", new.iter().map(|r| match r {
        Req::Cold(c) => format!("cold {}", c.ctx.t),
        Req::Warm(w) => format!("warm {}", w.ctx.t),
        Req::Forget { ctx } => format!("forget {}", ctx.t),
    }).collect::<Vec<_>>());
    assert_eq!(new.iter().filter(|r| matches!(r, Req::Forget { .. })).count(), 3);
    assert_eq!(new.iter().filter(|r| matches!(r, Req::Cold(_))).count(), 3);
}

/// A word to let go that the worker was too busy to take holds the new tables back, in every room.
#[test]
fn a_forget_the_worker_could_not_take_holds_back_the_new_tables_of_every_room() {
    let mut b = Bench::new("house roulette 3");
    let (inc, houses, pins, ctx) = (b.case.ctx.inc.clone(), b.case.houses.clone(), b.case.pins.clone(), b.case.ctx.clone());
    let long = "x".repeat(3_000);
    let docs: Vec<(String, Doc)> = ["room-a", "room-b"].iter().map(|r| (r.to_string(), Doc::new())).collect();
    let make = |doc: &Doc, room: &str, names: &[String]| {
        let mut c = ctx.clone();
        c.room = room.to_string();
        let comp = doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = doc.transact_mut();
        for t in names {
            c.t = t.clone();
            comp.insert(&mut txn, format!("ses:{t}:{inc}:{}", crate::house_bytes::next_sid(&c, None).unwrap()), MapPrelim::default());
        }
    };
    make(&docs[0].1, "room-a", &[long.clone()]);
    make(&docs[1].1, "room-b", &["b0".to_string(), "b1".to_string()]);
    let view = |ts: &[&str]| FoldView { tables: ts.iter().map(|t| (t.to_string(), inc.clone())).collect(), houses: houses.clone(), pins: pins.clone(), settled: true, pins_epoch: 0, watch: None };
    for _ in 0..300 {
        b.shadow.tick(b.now, vec![(docs[0].0.clone(), docs[0].1.clone(), Some(view(&[&long]))), (docs[1].0.clone(), docs[1].1.clone(), Some(view(&["b0"])))]);
        thread::sleep(Duration::from_millis(2));
        if b.shadow.counts().results >= 2 {
            break;
        }
    }
    assert_eq!(b.shadow.counts().results, 2);
    // The pipe has room for a small frame and not for the long table's word.
    b.shadow.sup.clog(QUEUE_BYTES - 2_000);
    let cold = b.shadow.counts().cold;
    for _ in 0..6 {
        b.shadow.tick(b.now, vec![(docs[0].0.clone(), docs[0].1.clone(), Some(view(&[]))), (docs[1].0.clone(), docs[1].1.clone(), Some(view(&["b0", "b1"])))]);
        thread::sleep(Duration::from_millis(2));
    }
    assert!(b.shadow.rooms["room-a"].feed.owes_forget(), "the word for the long table was refused");
    assert_eq!(b.shadow.counts().cold, cold, "and room b's new table waits for it");
    // The pipe clears: the word first, then the table.
    b.shadow.sup.unclog(QUEUE_BYTES - 2_000);
    for _ in 0..300 {
        b.shadow.tick(b.now, vec![(docs[0].0.clone(), docs[0].1.clone(), Some(view(&[]))), (docs[1].0.clone(), docs[1].1.clone(), Some(view(&["b0", "b1"])))]);
        thread::sleep(Duration::from_millis(2));
        if b.shadow.counts().cold == cold + 1 {
            break;
        }
    }
    assert_eq!(b.shadow.counts().cold, cold + 1);
    assert!(!b.shadow.rooms.get("room-a").is_some_and(|rs| rs.feed.owes_forget()));
    assert_eq!(b.forgets(), 1);
}

/// With the fold duties off for good, no room is asked about and no player is read.
#[test]
fn when_the_fold_duties_are_off_no_room_is_asked_what_it_holds() {
    let mut b = Bench::new("house roulette 3");
    b.refuse.store(true, Ordering::SeqCst);
    for _ in 0..8 {
        b.now += Duration::from_secs(70);
        b.tick();
        if b.shadow.sup.off().is_some() {
            break;
        }
    }
    assert!(b.shadow.is_off());
    let (doc, room) = (b.doc.clone(), b.room().to_string());
    let shadow = Mutex::new(b.shadow);
    let got = tick_shadow(&shadow, vec![(room, doc)], Instant::now(), |_| panic!("the house is asked about a room while the duties are off"));
    let report = got.expect("a report, and no panic");
    assert_eq!((report.off.as_deref(), report.rooms), (Some("crashes"), 0));
}

/// The shadow watches the players of the rooms the house has a plan for, from the first plan, and lets them go with the room.
#[test]
fn the_players_of_a_room_are_watched_from_its_first_plan_and_let_go_with_the_room() {
    let b = Bench::new("house roulette 3");
    let (doc, houses) = (b.doc.clone(), b.case.houses.clone());
    let shadow = Mutex::new(b.shadow);
    let plan = HousePlan { tables: vec![], houses, complete: true };
    let docs = |rooms: &[&str]| -> Vec<(String, Doc)> { rooms.iter().map(|r| (r.to_string(), doc.clone())).collect() };
    // A room with a plan and no table is watched; one with no plan is not.
    tick_shadow(&shadow, docs(&["with", "without"]), Instant::now(), |r| (r == "with").then(|| plan.clone())).unwrap();
    assert_eq!(shadow.lock().unwrap().pins.keys().cloned().collect::<Vec<_>>(), vec!["with".to_string()]);
    // A player who comes is pinned as the transaction showed it, and a key replaced makes the view unsettled for good.
    let players = doc.get_or_insert_map("players");
    {
        let mut txn = doc.transact_mut();
        players.insert(&mut txn, "alice", to_any(&obj(vec![("keyB64", s("A"))])));
    }
    assert_eq!(shadow.lock().unwrap().pins.get_mut("with").unwrap().view(), (vec![("alice".to_string(), "A".to_string())], true));
    {
        let mut txn = doc.transact_mut();
        players.insert(&mut txn, "alice", to_any(&obj(vec![("keyB64", s("B"))])));
    }
    assert!(!shadow.lock().unwrap().pins.get_mut("with").unwrap().view().1);
    // The room goes (the node no longer serves it): its watch goes with it.
    tick_shadow(&shadow, docs(&["without"]), Instant::now(), |_| None).unwrap();
    assert!(shadow.lock().unwrap().pins.is_empty());
}

/// The pins a view carries are the shadow's own watch of the players, and it is settled only with a
/// plan that is complete and pins that are.
#[test]
fn a_view_is_settled_only_with_a_plan_that_is_complete_and_pins_that_are() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let (room, doc, houses) = (b.room().to_string(), b.doc.clone(), b.case.houses.clone());
    let tables = vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())];
    // (The bench's own ticks stand for the house; from here the shadow is asked as the node asks it.)
    let wrong = b.wrong_trim(&b.answer());
    let shadow = Mutex::new(b.shadow);
    let go = |complete: bool| {
        let plan = HousePlan { tables: tables.clone(), houses: houses.clone(), complete };
        tick_shadow(&shadow, vec![(room.clone(), doc.clone())], Instant::now(), |_| Some(plan.clone())).unwrap();
    };
    let confirmed = || shadow.lock().unwrap().rooms[&room].confirmed.len();
    for _ in 0..40 {
        go(true);
        thread::sleep(Duration::from_millis(5));
        if confirmed() == 1 {
            break;
        }
    }
    assert_eq!(confirmed(), 1, "a complete plan and no player to doubt: shown whole");
    go(false);
    assert_eq!(confirmed(), 0, "an incomplete plan takes it back");
    for _ in 0..40 {
        go(true);
        thread::sleep(Duration::from_millis(5));
        if confirmed() == 1 {
            break;
        }
    }
    assert_eq!(confirmed(), 1, "and a complete one shows it again");
    // A key replaced: the pins are not settled, and the view stays unsettled with a complete plan.
    let players = doc.get_or_insert_map("players");
    for key in ["A", "B"] {
        let mut txn = doc.transact_mut();
        players.insert(&mut txn, "alice", to_any(&obj(vec![("keyB64", s(key))])));
    }
    go(true);
    assert_eq!(confirmed(), 0, "pins unsettled");
    go(true);
    assert_eq!(confirmed(), 0, "and they stay so");
    let _ = wrong;
}

// ── Review round 3 ───────────────────────────────────────────────────────────

use crate::fold_pins::PIN_WALK_KEYS;

impl Bench {
    /// Watch the room's players as the node does, and have the bench's view carry the watch and the epoch it stands at.
    fn watch_pins(&mut self) -> PlayerPins {
        let mut pins = PlayerPins::attach(&self.doc, PIN_WALK_KEYS);
        self.sync_pins(&mut pins);
        pins
    }

    /// The view as a tick of the node would make it now: the epoch of the pins as they stand.
    fn sync_pins(&mut self, pins: &mut PlayerPins) {
        let (_, _, epoch) = pins.view_at();
        let view = self.view.as_mut().unwrap();
        view.watch = Some(pins.watch());
        view.pins_epoch = epoch;
    }

    /// A player comes into the room.
    fn add_player(&self, pid: &str, key: &str) {
        let players = self.doc.get_or_insert_map("players");
        let mut txn = self.doc.transact_mut();
        players.insert(&mut txn, pid, to_any(&obj(vec![("keyB64", s(key))])));
    }

    /// The deed holder delegates to `house` (or does it again: the same key written again is a replacement).
    fn delegate(&self, house: &str) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, format!("hk:{house}"), to_any(&obj(vec![("by", s("owner"))])));
    }

    fn withdraw(&self, house: &str) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.remove(&mut txn, format!("hk:{house}").as_str());
    }

    /// A page's removal of table `t`: the mark that it is gone (the switch goes with it; the sessions stay for the compaction).
    fn mark_gone(&self, t: &str) {
        let casino = self.doc.get_or_insert_map(crate::house::CASINO_MAP);
        let mut txn = self.doc.transact_mut();
        casino.insert(&mut txn, format!("gone:{t}:{}", self.case.ctx.inc), to_any(&CVal::Int(1)));
    }

    fn confirmed_count(&self) -> usize {
        self.shadow.rooms[self.room()].confirmed.len()
    }
}

/// The pins moved after the answer was shown whole, and before the tick that reads the trim: the answer was
/// made without the player, whom a page counted.
#[test]
fn a_difference_is_not_counted_when_a_player_was_pinned_after_the_answer_was_shown_whole() {
    for pinned in [true, false] {
        let mut b = Bench::new("house craps 3");
        let _pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "pinned={pinned}: shown whole");
        let wrong = b.wrong_trim(&b.answer());
        if pinned {
            b.add_player("zed", &"Z".repeat(43));
        }
        b.put_checkpoint(&wrong);
        b.tick();
        let expected = if pinned { Tally { inputs: 1, ..Tally::default() } } else { Tally { mismatch: 1, ..Tally::default() } };
        assert_eq!(b.shadow.tally, expected, "pinned={pinned}");
    }
}

/// A player pinned before a settled tick is part of what that tick shows: the answer is believed again after it.
#[test]
fn a_player_pinned_before_the_tick_that_showed_the_answer_whole_is_part_of_what_it_showed() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    b.add_player("zed", &"Z".repeat(43));
    b.sync_pins(&mut pins);
    // (A frame with new inputs is sent, and its answer is shown whole by a later tick.)
    b.view.as_mut().unwrap().pins = pins.view().0;
    let warm = b.shadow.counts().warm;
    b.until("the new inputs sent", |b| b.shadow.counts().warm > warm);
    b.until("the answer to them", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    b.put_checkpoint(&wrong);
    b.tick();
    assert_eq!(b.shadow.tally, Tally { mismatch: 1, ..Tally::default() });
}

/// What `compare` holds an answer to: the pins and the delegations the doc the drain read shows, against those the
/// answer was shown whole at. (The tick cannot be made to move them between its first look and the drain; the
/// stamps are passed in, so here they are.)
#[test]
fn an_answer_is_believed_only_where_the_pins_and_the_delegations_stand_as_they_stood_when_it_was_shown_whole() {
    for (pins_moved, delegations_moved) in [(false, false), (true, false), (false, true), (true, true)] {
        let mut b = Bench::new("house craps 3");
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        let wrong = b.wrong_trim(&b.answer());
        let room = b.room().to_string();
        let key = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
        b.put_checkpoint(&wrong);
        let inputs = Inputs::new(b.view.as_ref().unwrap().houses.clone(), b.view.as_ref().unwrap().pins.clone());
        let FoldShadow { sup, rooms, .. } = &mut b.shadow;
        let rs = rooms.get_mut(&room).unwrap();
        let covered = rs.covered(&inputs, sup);
        {
            let txn = b.doc.transact();
            rs.mirror.drain(&txn);
        }
        let shown = rs.confirmed[&key];
        let mut tally = Tally::default();
        rs.compare(&mut tally, &covered, shown.pins + pins_moved as u64, shown.delegations + delegations_moved as u64);
        let expected = if pins_moved || delegations_moved { Tally { inputs: 1, ..Tally::default() } } else { Tally { mismatch: 1, ..Tally::default() } };
        assert_eq!(tally, expected, "pins moved {pins_moved}, delegations moved {delegations_moved}");
    }
}

/// A delegation that came or went since the last tick may not be in the plan yet (the house has had no pass since):
/// the tick that sees it shows nothing whole, and the next that finds nothing new shows it again.
#[test]
fn a_tick_that_sees_a_delegation_change_shows_nothing_whole_and_the_next_one_does() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    assert_eq!(b.confirmed_count(), 1);
    b.delegate("house-x");
    b.tick();
    assert_eq!(b.confirmed_count(), 0, "taken back");
    b.ticks(5);
    assert_eq!(b.confirmed_count(), 1, "and shown again, with the delegation counted");
    // Shown again, the delegation counted: a difference is a difference.
    let wrong = b.wrong_trim(&b.answer());
    let mut again = Bench::new("house craps 3");
    again.until("the first answer", |b| b.caught_up());
    again.ticks(5);
    again.delegate("house-x");
    again.ticks(5);
    again.put_checkpoint(&wrong);
    again.tick();
    assert_eq!(again.shadow.tally, Tally { mismatch: 1, ..Tally::default() });
    // A trim read in the tick that sees the change is passed over, not counted.
    b.delegate("house-y");
    b.put_checkpoint(&wrong);
    b.tick();
    assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() });
}

/// A delegation replaced or removed may have been counted by a page that saw it, and the node's plan learns
/// a delegation only from a record that names the house: nothing is shown whole after that, for as long as the room is watched.
#[test]
fn a_delegation_replaced_or_withdrawn_leaves_nothing_shown_whole() {
    for how in ["replaced", "withdrawn"] {
        let mut b = Bench::new("house craps 3");
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        b.delegate("house-x");
        b.ticks(3);
        assert_eq!(b.confirmed_count(), 1, "{how}: (a delegation that came is no churn)");
        if how == "replaced" {
            b.delegate("house-x");
        } else {
            b.withdraw("house-x");
        }
        b.ticks(10);
        assert_eq!(b.confirmed_count(), 0, "{how}");
        let wrong = b.wrong_trim(&b.answer());
        b.put_checkpoint(&wrong);
        b.until("passed over", |b| b.shadow.tally.inputs > 0);
        assert_eq!(b.shadow.tally, Tally { inputs: 1, ..Tally::default() }, "{how}");
    }
}

/// A page's trim read when the fold has no answer from before it to hold it against is counted, once, as a
/// comparison not made (and the first checkpoint a table is read with is none).
#[test]
fn a_trim_read_when_the_fold_has_no_answer_from_before_it_is_counted_once_as_unanswered() {
    let mut b = Bench::new("house craps 3");
    // The worker is sent nothing: the table is read, and has no answer.
    b.shadow.sup.clog(QUEUE_BYTES);
    b.ticks(5);
    let key = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    assert!(b.shadow.rooms[b.room()].feed.fold(&key.0, &key.1).is_none());
    assert_eq!(b.shadow.tally, Tally::default(), "(a table's first read is no trim)");
    let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
    b.put_checkpoint(&b.page_trim(&sum));
    b.ticks(5);
    assert_eq!(b.shadow.tally, Tally { unanswered: 1, ..Tally::default() });
    assert_eq!(b.shadow.report().shadow_skipped, 1, "it is a skip in the report");
    // The pipe clears, the table is answered, and nothing more is counted for the same checkpoint.
    b.shadow.sup.unclog(QUEUE_BYTES);
    b.until("answered", |b| b.shadow.rooms[b.room()].feed.fold(&key.0, &key.1).is_some());
    b.ticks(20);
    assert_eq!(b.shadow.tally, Tally { unanswered: 1, ..Tally::default() }, "once");
    assert_eq!(b.shadow.report().shadow_mismatches, 0);
}

/// A table a page's removal took out of the plan: the final checkpoint a page writes when it compacts it comes some
/// seconds on, and is compared; the table is let go of at once when it has been.
#[test]
fn a_table_a_page_removed_is_kept_for_the_final_checkpoint_its_compaction_writes() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let ended = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    assert!(checkpoint_ok(&ended, &b.case.ctx.inc));
    let (t, inc) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    // The removal: the mark, and the plan with no table.
    b.mark_gone(&t);
    b.view.as_mut().unwrap().tables.clear();
    for _ in 0..4 {
        b.now += Duration::from_secs(10);
        b.ticks(5);
    }
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_some(), "still held, 40 seconds on");
    assert_eq!(b.forgets(), 0, "and the worker was not told to let it go");
    assert_eq!(b.shadow.tally, Tally::default());
    // The compaction's checkpoint.
    b.put_checkpoint(&ended);
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1, "right after, though the grace was not over");
}

/// ... and where it never comes (the removal of a table whose sessions were already compacted, say) the table is let go of
/// when the grace is over, checkpoint or none.
#[test]
fn a_table_a_page_removed_is_let_go_of_when_the_grace_is_over_and_no_final_checkpoint_came() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    let (t, inc) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    b.mark_gone(&t);
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(5);
    b.now += GONE_GRACE - Duration::from_secs(1);
    b.ticks(5);
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_some(), "just short of the grace");
    b.now += Duration::from_secs(2);
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1);
    assert_eq!(b.shadow.tally, Tally::default());
}

/// The place of a table kept for its final checkpoint is not given to another.
#[test]
fn the_place_of_a_table_kept_for_its_final_checkpoint_is_not_given_to_another() {
    let mut b = Bench::new("house roulette 3");
    let inc = b.case.ctx.inc.clone();
    let names: Vec<String> = (0..MAX_SHADOW_TABLES + 1).map(|i| format!("t{i:02}")).collect();
    for t in &names {
        b.empty_table(t);
    }
    b.view.as_mut().unwrap().tables = names.iter().take(MAX_SHADOW_TABLES).map(|t| (t.clone(), inc.clone())).collect();
    b.until("all answered", |b| b.shadow.counts().results >= MAX_SHADOW_TABLES as u64);
    b.ticks(5);
    // t00 is removed as t14 comes to the plan.
    b.mark_gone("t00");
    b.view.as_mut().unwrap().tables = names.iter().skip(1).map(|t| (t.clone(), inc.clone())).collect();
    let mut most = 0;
    for _ in 0..40 {
        b.tick();
        most = most.max(b.shadow.rooms[b.room()].mirror.tables().count());
        thread::sleep(Duration::from_millis(1));
    }
    assert!(most <= MAX_SHADOW_TABLES, "{most} tables held at once");
    assert!(b.shadow.rooms[b.room()].mirror.state("t00", &inc).is_some(), "t00 is kept");
    assert!(b.shadow.rooms[b.room()].mirror.state("t14", &inc).is_none(), "and t14 waits for its place");
    assert_eq!(b.shadow.report().tables_over, 1);
    // The grace is over: t00 goes and t14 comes.
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.until("t14 comes", |b| b.shadow.rooms[b.room()].mirror.state("t14", &inc).is_some());
    assert!(b.shadow.rooms[b.room()].mirror.state("t00", &inc).is_none());
    assert!(b.shadow.rooms[b.room()].gone.is_empty(), "and nothing is remembered of the removal");
}

/// The grace counts from the tick the table is first seen outside the plan, not from the mark.
#[test]
fn the_grace_of_a_removed_table_counts_from_the_tick_it_left_the_plan() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    let (t, inc) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    b.mark_gone(&t);
    b.ticks(3);
    b.now += GONE_GRACE + Duration::from_secs(5);
    b.ticks(3);
    assert_eq!(b.shadow.report().tables, 1, "(still in the plan)");
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    b.now += Duration::from_secs(40);
    b.ticks(5);
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_some(), "40 seconds after it left");
    b.now += Duration::from_secs(30);
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1);
}

/// The stamps the node makes through its own watch of the players: a trim is held against the node when the
/// players stood as they stood when the answer was shown whole, whatever the epoch is.
#[test]
fn a_trim_is_held_against_the_node_through_its_own_watch_of_the_players() {
    for moved in [false, true] {
        let b = Bench::new("house craps 3");
        let (room, doc, houses) = (b.room().to_string(), b.doc.clone(), b.case.houses.clone());
        let tables = vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())];
        // The players of the vector are in the room from the start, and so the epoch is not zero.
        for (pid, key) in &b.case.pins {
            b.add_player(pid, key);
        }
        let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
        let wrong = b.wrong_trim(&sum);
        let live = format!("ses:{}:{}:{}", tables[0].0, tables[0].1, crate::house_bytes::next_sid(&b.case.ctx, Some(&wrong)).unwrap());
        let shadow = Mutex::new(b.shadow);
        let go = || {
            let plan = HousePlan { tables: tables.clone(), houses: houses.clone(), complete: true };
            tick_shadow(&shadow, vec![(room.clone(), doc.clone())], Instant::now(), |_| Some(plan.clone())).unwrap();
        };
        let confirmed = || shadow.lock().unwrap().rooms.get(&room).map_or(0, |rs| rs.confirmed.len());
        for _ in 0..200 {
            go();
            thread::sleep(Duration::from_millis(5));
            if confirmed() == 1 {
                break;
            }
        }
        assert_eq!(confirmed(), 1, "moved={moved}: shown whole");
        {
            let comp = doc.get_or_insert_map(crate::house::COMPUTED_MAP);
            let players = doc.get_or_insert_map("players");
            let mut txn = doc.transact_mut();
            if moved {
                players.insert(&mut txn, "zed", to_any(&obj(vec![("keyB64", s(&"Z".repeat(43)))])));
            }
            comp.insert(&mut txn, format!("sum:{}:{}", tables[0].0, tables[0].1), to_any(&wrong));
            comp.insert(&mut txn, live.as_str(), MapPrelim::default());
        }
        for _ in 0..80 {
            go();
            thread::sleep(Duration::from_millis(2));
            let t = shadow.lock().unwrap().tally;
            if t.mismatch + t.inputs + t.stale > 0 {
                break;
            }
        }
        let t = shadow.lock().unwrap().tally;
        let expected = if moved { Tally { inputs: 1, ..Tally::default() } } else { Tally { mismatch: 1, ..Tally::default() } };
        assert_eq!(t, expected, "moved={moved}");
    }
}

/// A table that leaves the plan with no mark of a removal is let go of at once, as before.
#[test]
fn a_table_that_left_the_plan_with_no_mark_of_a_removal_is_let_go_of_at_once() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.view.as_mut().unwrap().tables.clear();
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.forgets(), 1);
}

/// The cap has no place for a table whose checkpoint a page has written and the mirror has not read: it is kept for
/// the checkpoint all the same, and its place is taken from the others, which may put others out.
#[test]
fn a_table_the_cap_puts_out_is_kept_for_a_checkpoint_a_page_has_written() {
    let mut b = Bench::new("house roulette 3");
    // (A drain that reads little, so that the checkpoint is not read in the tick that finds the table put out.)
    b.shadow.limits = Limits { drain_paths: 1, ..Limits::default() };
    let inc = b.case.ctx.inc.clone();
    let names: Vec<String> = (0..MAX_SHADOW_TABLES).map(|i| format!("t{i:02}")).collect();
    for t in &names {
        b.empty_table(t);
    }
    b.empty_table("a-new");
    b.empty_table("b-new");
    b.view.as_mut().unwrap().tables = names.iter().map(|t| (t.clone(), inc.clone())).collect();
    b.until("all answered", |b| b.shadow.counts().results >= MAX_SHADOW_TABLES as u64);
    b.ticks(5);
    // Two tables come first in the plan, which puts the last two out; and a page has trimmed the very last.
    let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
    let u = last_decided(&sum).expect("a decided round");
    let last = names.last().unwrap().clone();
    b.put_checkpoint_for(&last, &page_cp(&sum, u, nets_through(&sum, u), false, false));
    let mut tables: Vec<(String, String)> = vec![("a-new".to_string(), inc.clone()), ("b-new".to_string(), inc.clone())];
    tables.extend(names.iter().map(|t| (t.clone(), inc.clone())));
    b.view.as_mut().unwrap().tables = tables;
    b.tick();
    let r = b.shadow.report();
    assert_eq!((r.tables, r.tables_over), (MAX_SHADOW_TABLES as u64 - 1, 3), "the place of the table put out that has a checkpoint to read is taken from the others, and from no more than that");
    let mut most = 0;
    let mut compared = false;
    for _ in 0..400 {
        b.tick();
        most = most.max(b.shadow.rooms[b.room()].mirror.tables().count());
        let sh = &b.shadow;
        compared |= sh.tally.skipped() + sh.tally.agree + sh.tally.mismatch > 0;
        thread::sleep(Duration::from_millis(1));
        if compared && b.shadow.rooms[b.room()].mirror.state(&last, &inc).is_none() {
            break;
        }
    }
    assert!(most <= MAX_SHADOW_TABLES, "{most} tables held at once");
    assert!(compared, "the checkpoint of the table put out was compared (or passed over and counted)");
    assert!(b.shadow.rooms[b.room()].mirror.state(&last, &inc).is_none(), "and then the table was let go of");
    b.tick();
    let r = b.shadow.report();
    assert_eq!((r.tables, r.tables_over), (MAX_SHADOW_TABLES as u64, 2), "and the place is given back");
}

/// The view of a room with a plan is made with the shadow's own watch of the players, which is asked again later.
#[test]
fn the_view_of_a_room_carries_the_watch_of_its_players_and_the_epoch_they_stood_at() {
    let b = Bench::new("house craps 3");
    let (room, doc, houses) = (b.room().to_string(), b.doc.clone(), b.case.houses.clone());
    let mut shadow = b.shadow;
    let plan = || HousePlan { tables: vec![], houses: houses.clone(), complete: true };
    let first = shadow.view_of(&room, &doc, plan(), PIN_WALK_KEYS);
    let watch = first.watch.clone().expect("the watch of the players");
    assert_eq!(watch.epoch(), first.pins_epoch);
    // A player comes: the watch says so, and the next view stands at the new epoch.
    let players = doc.get_or_insert_map("players");
    {
        let mut txn = doc.transact_mut();
        players.insert(&mut txn, "zed", to_any(&obj(vec![("keyB64", s(&"Z".repeat(43)))])));
    }
    assert!(watch.epoch() > first.pins_epoch);
    let second = shadow.view_of(&room, &doc, plan(), PIN_WALK_KEYS);
    assert_eq!(second.watch, first.watch, "(the same watch: the room's)");
    assert_eq!((second.pins_epoch, second.pins.len()), (watch.epoch(), 1));
    assert!(second.settled);
}
