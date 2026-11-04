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
    // A commitment the fold does not want: another than the one it wants is a mismatch, and one where it wants none is
    // not told from a step-down the page has not received.
    let h = with_cp(&cp, "h", Some(s(&"c".repeat(64))));
    if sum.required.is_some() {
        assert!(matches!(compare(&sum, &h, &inc), Verdict::Mismatch(w) if w.starts_with("h:")), "{:?}", compare(&sum, &h, &inc));
    } else {
        assert_eq!(compare(&sum, &h, &inc), Verdict::Skip(Skip::StepDown));
    }
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

/// A house that steps down in the open round clears what the fold requires without deciding another round, and the page
/// that trimmed may not have received the step-down: a checkpoint naming a commitment where the fold wants none is
/// inconclusive. (Any other difference in `h` is still a disagreement.)
#[test]
fn a_commitment_the_checkpoint_names_where_the_fold_wants_none_is_inconclusive_not_a_mismatch() {
    let mut seen = 0;
    for c in cases() {
        let sum = finished(&c.summary);
        let (Some(u), Some(_)) = (last_decided(&sum), sum.required.as_ref()) else { continue };
        let cp = page_cp(&sum, u, nets_through(&sum, u), true, !sum.carry.is_null());
        if !crate::house::checkpoint_ok(&cp, &c.ctx.inc) {
            continue;
        }
        assert_eq!(compare(&sum, &cp, &c.ctx.inc), Verdict::Agree, "{}: as it stands", c.name);
        // The fold has folded a step-down the page has not: it requires none, and the checkpoint still names one.
        let mut stepped = sum.clone();
        stepped.required = None;
        assert_eq!(compare(&stepped, &cp, &c.ctx.inc), Verdict::Skip(Skip::StepDown), "{}", c.name);
        // Nothing named by either is agreed, and the commitment the fold wants against another is still a mismatch.
        let none = with_cp(&cp, "h", None);
        assert_eq!(compare(&stepped, &none, &c.ctx.inc), Verdict::Agree, "{}: none and none", c.name);
        let other = with_cp(&cp, "h", Some(s(&"c".repeat(64))));
        assert!(matches!(compare(&sum, &other, &c.ctx.inc), Verdict::Mismatch(w) if w.starts_with("h:")), "{}: another named", c.name);
        // The nets and the close come first: a step-down does not hide what else differs.
        let mut n = nets_through(&sum, u);
        if let Some(first) = n.first_mut() {
            first.1 = (first.1.parse::<i128>().unwrap() + 1_000_003).to_string();
            let off = page_cp(&sum, u, n, true, !sum.carry.is_null());
            let got = compare(&stepped, &off, &c.ctx.inc);
            assert!(matches!(&got, Verdict::Mismatch(w) if w.starts_with("n ")), "{}: nets: {got:?}", c.name);
        }
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
    for why in [Skip::Past, Skip::Behind, Skip::Big, Skip::Unreadable, Skip::Pending, Skip::Parent, Skip::Stale, Skip::Inputs, Skip::Unanswered, Skip::Expired, Skip::Superseded, Skip::StepDown, Skip::Handover, Skip::Signer] {
        t.note(&Verdict::Skip(why));
    }
    assert_eq!(t, Tally { agree: 1, mismatch: 1, past: 1, behind: 1, big: 1, unreadable: 1, pending: 1, parent: 1, stale: 1, inputs: 1, unanswered: 1, expired: 1, superseded: 1, step_down: 1, handover: 1, signer: 1 });
    assert_eq!(t.skipped(), 14);
    t.note(&Verdict::Skip(Skip::Pending));
    assert_eq!(t.pending, 2);
}

/// Each kind of skip is said under a name of its own, since the log is all there is to tell them by.
#[test]
fn each_kind_of_skip_has_a_name_of_its_own() {
    let all = [Skip::Past, Skip::Behind, Skip::Big, Skip::Unreadable, Skip::Pending, Skip::Parent, Skip::Stale, Skip::Inputs, Skip::Unanswered, Skip::Expired, Skip::Superseded, Skip::StepDown, Skip::Handover, Skip::Signer];
    let names: BTreeSet<&str> = all.iter().map(|s| s.name()).collect();
    assert_eq!(names.len(), all.len(), "{names:?}");
    assert_eq!(Skip::StepDown.name(), "stepdown");
    assert_eq!(Skip::Handover.name(), "handover");
    assert_eq!(Skip::Signer.name(), "signer");
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

/// The deed holder of the benches' rooms (`roomInfo.owner`), whose houses the plans stand for.
const OWNER: &str = "owner";
/// The key the deed holder of the benches' rooms is pinned under (`players.owner.keyB64`): the plans name it.
const OWNER_KEY: &str = "owner-key";

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
            view: Some(FoldView { tables: vec![(case.ctx.t.clone(), case.ctx.inc.clone())], houses: case.houses.clone(), pins: case.pins.clone(), settled: true, pins_epoch: 0, watch: None, gapped: false }),
            case,
            now,
            log,
            refuse,
            listed: true,
        };
        bench.write_session();
        bench.set_owner(OWNER);
        bench.add_player(OWNER, OWNER_KEY);
        // (The players of the vector are in the room too, under the keys that signed their slips: a watch of the room's
        // players pins what the vector's own pins say.)
        for (pid, key) in &bench.case.pins {
            if pid != OWNER {
                bench.add_player(pid, key);
            }
        }
        bench
    }

    /// The deed of the room is held by `pid` (the room's `roomInfo.owner`).
    fn set_owner(&self, pid: &str) {
        let info = self.doc.get_or_insert_map("roomInfo");
        let mut txn = self.doc.transact_mut();
        info.insert(&mut txn, "owner", pid);
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

    /// A record no fold counts comes into the live session: the node's answer is a new one (a frame later), and nothing
    /// in the session was removed or replaced.
    fn add_a_record(&self) {
        let live = self.live(None);
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(yrs::Out::YMap(m)) = comp.get(&txn, &live) else { panic!("no live session") };
        m.insert(&mut txn, format!("x:9:nobody:{}", "7".repeat(32)).as_str(), to_any(&obj(vec![("p", s("nobody"))])));
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
        // The worker is never asked to hold more tables than it has places for, whatever the tick did.
        assert!(self.shadow.holds() <= self.shadow.places, "{} tables held, the worker has places for {}", self.shadow.holds(), self.shadow.places);
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
    b.view = Some(FoldView { tables: vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())], houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true, pins_epoch: 0, watch: None, gapped: false });
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
    // (The old table is kept for its grace, as any the plan stops naming; then it is let go of.)
    b.ticks(5);
    assert_eq!(b.forgets(), 0);
    b.now += GONE_GRACE + Duration::from_secs(1);
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
    b.shadow.tally = Tally { agree: 1, mismatch: 2, past: 3, behind: 4, big: 5, unreadable: 6, pending: 7, parent: 8, stale: 9, inputs: 10, unanswered: 11, expired: 12, superseded: 13, step_down: 14, handover: 15, signer: 16 };
    b.shadow.gone = Counts { cold: 10, warm: 20, forgets: 30, results: 40, dirty: 11, lost: 12, busy: 50, too_big: 13, bad_results: 14 };
    let r = b.shadow.report();
    assert_eq!((r.shadow_agreed, r.shadow_mismatches), (1, 2));
    assert_eq!(r.shadow_skipped, 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15 + 16, "every kind of skip");
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
    b.view = Some(FoldView { tables: vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())], houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true, pins_epoch: 0, watch: None, gapped: false });
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
    b.until("let go", |b| b.tables_held() == 0);
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

/// A room the house has a plan for is watched from the plan on, with a table to follow or none (what the mirror sees of
/// its delegations is the room's history, whatever tables come): nothing is read of it, and the worker is told nothing.
#[test]
fn a_room_with_a_plan_and_no_table_to_follow_is_watched_and_nothing_is_read_or_sent() {
    let mut b = Bench::new("house roulette 3");
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(10);
    assert_eq!(b.shadow.rooms.len(), 1, "the room is watched");
    assert_eq!(ATTACHED.with(|n| n.get()), 1);
    let r = b.shadow.report();
    assert_eq!((r.rooms, r.tables, r.tables_over, r.cold_folds), (1, 0, 0, 0));
    assert_eq!(b.shadow.counts(), Counts::default(), "and the worker is told nothing");
    assert_eq!(b.shadow.rooms[b.room()].mirror.resets(), 0, "and no table is read");
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
        let view = FoldView { tables, houses: b.case.houses.clone(), pins: b.case.pins.clone(), settled: true, pins_epoch: 0, watch: None, gapped: false };
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
    let view = |ts: &[String]| FoldView { tables: ts.iter().map(|t| (t.clone(), inc.clone())).collect(), houses: houses.clone(), pins: pins.clone(), settled: true, pins_epoch: 0, watch: None, gapped: false };
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
    let view = |ts: &[&str]| FoldView { tables: ts.iter().map(|t| (t.to_string(), inc.clone())).collect(), houses: houses.clone(), pins: pins.clone(), settled: true, pins_epoch: 0, watch: None, gapped: false };
    for _ in 0..300 {
        b.shadow.tick(b.now, vec![(docs[0].0.clone(), docs[0].1.clone(), Some(view(&[&long]))), (docs[1].0.clone(), docs[1].1.clone(), Some(view(&["b0"])))]);
        thread::sleep(Duration::from_millis(2));
        if b.shadow.counts().results >= 2 {
            break;
        }
    }
    assert_eq!(b.shadow.counts().results, 2);
    // The plan stops naming the long table (the pages count it ended), and its grace passes: it is to be let go of.
    b.shadow.tick(b.now, vec![(docs[0].0.clone(), docs[0].1.clone(), Some(view(&[]))), (docs[1].0.clone(), docs[1].1.clone(), Some(view(&["b0"])))]);
    b.now += GONE_GRACE + Duration::from_secs(1);
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
    // (The players of the vector are in the room, besides its owner.)
    let mut everyone: Vec<(String, String)> = vec![("alice".to_string(), "A".to_string()), (OWNER.to_string(), OWNER_KEY.to_string())];
    everyone.extend(b.case.pins.iter().filter(|(p, _)| p != OWNER).cloned());
    everyone.sort();
    let shadow = Mutex::new(b.shadow);
    let plan = HousePlan { owner: OWNER.to_string(), owner_key: OWNER_KEY.to_string(), tables: vec![], houses, complete: true, gapped: false };
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
    assert_eq!(shadow.lock().unwrap().pins.get_mut("with").unwrap().view(), (everyone, true));
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
        let plan = HousePlan { owner: OWNER.to_string(), owner_key: OWNER_KEY.to_string(), tables: tables.clone(), houses: houses.clone(), complete, gapped: false };
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

    /// The deed holder delegates to `house` (or does it again as it stands: that changes nothing).
    fn delegate(&self, house: &str) {
        self.delegate_by(house, "owner");
    }

    /// The record of a delegation written as `by` has it: another value is another record.
    fn delegate_by(&self, house: &str, by: &str) {
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        comp.insert(&mut txn, format!("hk:{house}"), to_any(&obj(vec![("by", s(by))])));
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

    /// The tables the room's mirror holds.
    fn tables_held(&self) -> usize {
        self.shadow.rooms.get(self.room()).map_or(0, |rs| rs.mirror.tables().count())
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
        let pinned = b.view.as_ref().unwrap().pins.clone();
        let inputs = Inputs::new(b.view.as_ref().unwrap().houses.clone(), pinned.clone());
        let FoldShadow { sup, rooms, .. } = &mut b.shadow;
        let rs = rooms.get_mut(&room).unwrap();
        let covered = rs.covered(&inputs, sup);
        {
            let txn = b.doc.transact();
            rs.mirror.drain(&txn);
        }
        let shown = rs.confirmed[&key];
        let mut tally = Tally::default();
        rs.compare(&mut tally, &covered, &BTreeSet::new(), shown.pins + pins_moved as u64, shown.delegations + delegations_moved as u64, false, &pinned);
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
            b.delegate_by("house-x", "owner-2");
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
    b.until("let go", |b| b.tables_held() == 0);
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
    b.until("let go", |b| b.tables_held() == 0);
    assert_eq!(b.forgets(), 1);
    assert_eq!(b.shadow.tally, Tally { expired: 1, ..Tally::default() }, "and the comparison not made is counted, once");
    assert_eq!(b.shadow.report().shadow_skipped, 1);
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
    b.now += GONE_GRACE - Duration::from_secs(20);
    b.ticks(5);
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_some(), "short of the grace after it left");
    b.now += Duration::from_secs(30);
    b.until("let go", |b| b.tables_held() == 0);
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
            let plan = HousePlan { owner: OWNER.to_string(), owner_key: OWNER_KEY.to_string(), tables: tables.clone(), houses: houses.clone(), complete: true, gapped: false };
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

/// A table that leaves the plan with no mark of a removal is kept as a removed one is: the plan names the tables whose
/// switch names a live incarnation, so one it stopped naming is one the pages count ended (its switch went), and a page
/// compacts it in its turn.
#[test]
fn a_table_that_left_the_plan_with_no_mark_of_a_removal_is_kept_for_the_final_checkpoint_all_the_same() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    let (t, inc) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let ended = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    b.view.as_mut().unwrap().tables.clear();
    for _ in 0..4 {
        b.now += Duration::from_secs(10);
        b.ticks(5);
    }
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_some(), "still held, 40 seconds on");
    assert_eq!(b.forgets(), 0);
    // The compaction's checkpoint comes, and is compared.
    b.put_checkpoint(&ended);
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
    b.until("let go", |b| b.tables_held() == 0);
    assert_eq!(b.forgets(), 1);
}

/// A table that is replaced by another incarnation of it (the plan names the new one, and the old has no mark of a
/// removal) is kept for its final checkpoint, and the new is followed.
#[test]
fn a_table_replaced_by_another_incarnation_is_kept_for_the_final_checkpoint_of_the_old() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    let (t, inc) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let ended = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    // The switch names another incarnation of the same table.
    let again = format!("{inc}-2");
    b.view.as_mut().unwrap().tables = vec![(t.clone(), again.clone())];
    b.ticks(10);
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_some(), "the old incarnation is kept");
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &again).is_some(), "and the new one followed");
    assert_eq!(b.forgets(), 0);
    // A page compacts the old one.
    b.put_checkpoint(&ended);
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
    b.until("the old one is let go", |b| b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_none());
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &again).is_some(), "the new one is not");
}

/// A table that was out of the plan for a while and is back in it is followed as any other: nothing is kept of the
/// time it was out, and if it goes again its grace counts from then.
#[test]
fn a_table_back_in_the_plan_is_followed_afresh_and_its_grace_starts_over_if_it_goes_again() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    let (t, inc) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    let table = (t.clone(), inc.clone());
    let view = b.view.clone().unwrap();
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    assert!(b.shadow.rooms[b.room()].gone.contains_key(&table));
    b.now += GONE_GRACE - Duration::from_secs(10);
    b.view = Some(view.clone());
    b.ticks(3);
    assert!(b.shadow.rooms[b.room()].gone.is_empty(), "back: nothing is kept of the time it was out");
    // It goes again, a long time after it first went: the grace is of this time.
    b.now += GONE_GRACE;
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    b.now += Duration::from_secs(30);
    b.ticks(5);
    assert!(b.shadow.rooms[b.room()].mirror.state(&t, &inc).is_some(), "30 s into its grace");
    assert_eq!(b.shadow.tally, Tally::default());
    b.now += GONE_GRACE;
    b.until("let go", |b| b.tables_held() == 0);
    assert_eq!(b.shadow.tally, Tally { expired: 1, ..Tally::default() });
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
    // (The players of the vector are in the room, besides its owner.)
    let others = b.case.pins.iter().filter(|(p, _)| p != OWNER).count();
    let mut shadow = b.shadow;
    let plan = || HousePlan { owner: OWNER.to_string(), owner_key: OWNER_KEY.to_string(), tables: vec![], houses: houses.clone(), complete: true, gapped: false };
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
    assert_eq!((second.pins_epoch, second.pins.len()), (watch.epoch(), 2 + others), "the owner, the players of the vector and the player who came");
    assert!(second.settled);
}

// ── Review round 4 ───────────────────────────────────────────────────────────

/// A worker's folder that waits for `go` before it folds anything: a worker that is slow, or hung.
fn gated(inner: crate::fold_feed::tests::Maker, go: Arc<std::sync::atomic::AtomicBool>) -> crate::fold_feed::tests::Maker {
    use crate::fold_worker::Folder;
    struct Gate {
        inner: Box<dyn Folder>,
        go: Arc<std::sync::atomic::AtomicBool>,
    }
    impl Gate {
        fn wait(&self) {
            while !self.go.load(Ordering::SeqCst) {
                thread::sleep(Duration::from_millis(1));
            }
        }
    }
    impl Folder for Gate {
        fn cold(&mut self, c: &crate::fold_wire::Cold) -> Result<String, String> {
            self.wait();
            self.inner.cold(c)
        }
        fn warm(&mut self, w: &crate::fold_wire::Warm) -> Result<String, String> {
            self.wait();
            self.inner.warm(w)
        }
        fn forget(&mut self, ctx: &crate::house_bytes::Ctx) {
            self.inner.forget(ctx)
        }
        fn recover(&mut self) -> bool {
            self.inner.recover()
        }
    }
    Arc::new(move || Box::new(Gate { inner: inner(), go: go.clone() }))
}

/// A checkpoint a page may read as it is and as it is not (a `__proto__` field), which the mirror keeps no copy of.
fn held(cp: &CVal) -> CVal {
    with_cp(cp, "__proto__", Some(s("x")))
}

/// A trim at or before the round the fold's own base is (the node started the table on a checkpoint of that round, and
/// another page writes one of its own) is counted as a comparison not made, and said in the log like any other.
#[test]
fn a_trim_at_or_before_the_folds_base_is_counted_and_said_not_passed_over_silently() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let cp = b.page_trim(&b.answer());
    b.put_checkpoint(&cp);
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    // (The table starts over on that checkpoint: its answer has the round for its base.)
    b.until("answered again", |b| b.caught_up());
    b.ticks(5);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
    // Another page's checkpoint of the same round (signed otherwise) is no news to the fold.
    b.put_checkpoint(&with_cp(&cp, "g", Some(s(&"H".repeat(86)))));
    b.until("skipped", |b| b.shadow.tally.past > 0);
    b.ticks(10);
    assert_eq!(b.shadow.tally, Tally { agree: 1, past: 1, ..Tally::default() });
    let r = b.shadow.report();
    assert_eq!((r.shadow_skipped, r.shadow_mismatches, r.shadow_agreed), (1, 0, 1));
    assert_eq!(r.recent_skips.len(), 1, "{:?}", r.recent_skips);
    assert!(r.recent_skips[0].starts_with(&tag_of(&b)) && r.recent_skips[0].contains("(past)"), "{:?}", r.recent_skips);
}

/// A page's trim the node cannot read as a page does holds the table with no checkpoint to compare: counted, once, as a
/// comparison not made, said in the log (the first checkpoint a table is read with is no trim).
#[test]
fn a_trim_the_node_cannot_read_as_a_page_does_is_counted_once_as_unreadable() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let plain = b.page_trim(&b.answer());
    assert!(checkpoint_ok(&plain, &b.case.ctx.inc), "(it is a checkpoint but for the field)");
    b.put_checkpoint(&held(&plain));
    b.until("counted", |b| b.shadow.tally.unreadable > 0);
    b.ticks(30);
    assert_eq!(b.shadow.tally, Tally { unreadable: 1, ..Tally::default() }, "once, however long it is held");
    let st = b.shadow.rooms[b.room()].mirror.state(&b.case.ctx.t, &b.case.ctx.inc).unwrap();
    assert!(st.base.is_none() && st.hold == Some(crate::house_mirror::Hold::Base) && st.trims == 1);
    let r = b.shadow.report();
    assert_eq!((r.shadow_skipped, r.shadow_mismatches, r.shadow_agreed), (1, 0, 0));
    assert_eq!(r.recent_skips.len(), 1);
    assert!(r.recent_skips[0].starts_with(&tag_of(&b)) && r.recent_skips[0].contains("unreadable"), "{:?}", r.recent_skips);
}

/// ... and the checkpoint a table is first read with is no trim, held or not.
#[test]
fn the_first_checkpoint_a_table_is_read_with_is_no_trim_when_the_node_cannot_read_it_either() {
    let mut b = Bench::new("house craps 3");
    let sum = finished(&b.case.summary);
    let cp = held(&b.page_trim(&sum));
    b.put_checkpoint(&cp);
    b.ticks(30);
    let st = b.shadow.rooms[b.room()].mirror.state(&b.case.ctx.t, &b.case.ctx.inc).unwrap();
    assert_eq!((st.hold, st.trims), (Some(crate::house_mirror::Hold::Base), 0));
    assert_eq!(b.shadow.tally, Tally::default());
    assert!(b.shadow.report().recent_skips.is_empty());
}

/// What the comparisons say is kept for `/api/fingerprint`, the mismatches and the comparisons not made each in a ring
/// of their own, an agreement not at all.
#[test]
fn what_the_comparisons_say_is_kept_for_the_report() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    let sum = b.answer();
    let u = last_decided(&sum).unwrap();
    let mut n = nets_through(&sum, u);
    let x: i128 = n[0].1.parse().unwrap();
    n[0].1 = (x + 1).to_string();
    b.put_checkpoint(&page_cp(&sum, u, n, true, true));
    b.until("compared", |b| b.shadow.tally.mismatch > 0);
    let r = b.shadow.report();
    assert_eq!(r.recent_mismatches.len(), 1);
    assert!(r.recent_mismatches[0].starts_with(&tag_of(&b)) && r.recent_mismatches[0].contains("MISMATCH"), "{:?}", r.recent_mismatches);
    assert!(r.recent_mismatches[0].contains(" has "), "(the player that differs is named first: {:?})", r.recent_mismatches);
    assert!(r.recent_skips.is_empty());
    let json = serde_json::to_value(&r).unwrap();
    assert_eq!(json["recentMismatches"].as_array().map(Vec::len), Some(1));
    assert!(json.get("recentSkips").is_none(), "an empty list is left out");
    // An agreement is not kept.
    let mut a = Bench::new("house craps 3");
    a.until("the first answer", |b| b.caught_up());
    let cp = a.page_trim(&a.answer());
    a.put_checkpoint(&cp);
    a.until("compared", |b| b.shadow.tally.agree > 0);
    let r = a.shadow.report();
    assert!(r.recent_mismatches.is_empty() && r.recent_skips.is_empty());
    let json = serde_json::to_value(&r).unwrap();
    assert!(json.get("recentMismatches").is_none() && json.get("recentSkips").is_none());
}

/// The ring keeps the last lines of each kind, and a line is cut at a character, with a mark that it was.
#[test]
fn the_log_keeps_the_last_lines_of_each_kind_and_clips_a_long_one() {
    let mut log = Log::default();
    for i in 0..(LOG_LINES + 8) {
        log.push(true, format!("mismatch {i}"));
    }
    log.push(false, "one skip".into());
    assert_eq!(log.mismatches.len(), LOG_LINES, "the ring is full and no more");
    assert_eq!(log.mismatches.front().map(String::as_str), Some("mismatch 8"), "the oldest went");
    assert_eq!(log.mismatches.back().map(String::as_str), Some(format!("mismatch {}", LOG_LINES + 7).as_str()));
    assert_eq!(log.skips.len(), 1, "a run of mismatches does not push out the skips");
    for i in 0..(LOG_LINES + 1) {
        log.push(false, format!("skip {i}"));
    }
    assert_eq!(log.mismatches.len(), LOG_LINES, "nor the skips the mismatches");
    // A line over the most is cut, at a character, and marked.
    let long = format!("{}{}", "a".repeat(LOG_LINE_BYTES - 1), "é".repeat(50));
    let cut = clip(long.clone());
    assert!(cut.ends_with('…') && cut.len() <= LOG_LINE_BYTES + '…'.len_utf8(), "{} bytes", cut.len());
    assert!(long.starts_with(cut.trim_end_matches('…')), "what is left is the line's start");
    assert_eq!(clip("short".into()), "short");
    let exact = "b".repeat(LOG_LINE_BYTES);
    assert_eq!(clip(exact.clone()), exact, "a line of the most is whole");
    let mut log = Log::default();
    log.push(true, "x".repeat(10 * LOG_LINE_BYTES));
    assert!(log.mismatches[0].len() <= LOG_LINE_BYTES + 3);
}

/// A table let go of for want of a final checkpoint says so in the log, once.
#[test]
fn a_table_given_up_on_for_want_of_a_final_checkpoint_is_told_in_the_log() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.mark_gone(&b.case.ctx.t.clone());
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    assert!(b.shadow.report().recent_skips.is_empty(), "(not yet)");
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.until("let go", |b| b.tables_held() == 0);
    let r = b.shadow.report();
    assert_eq!(r.recent_skips.len(), 1, "{:?}", r.recent_skips);
    assert!(r.recent_skips[0].starts_with(&tag_of(&b)) && r.recent_skips[0].contains("expired"), "{:?}", r.recent_skips);
    assert_eq!(b.shadow.tally.expired, 1);
}

/// A table whose final checkpoint came in time is not given up on: compared, and not counted expired.
#[test]
fn a_table_whose_final_checkpoint_came_in_time_is_not_expired() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let ended = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    b.mark_gone(&b.case.ctx.t.clone());
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    // Past the fallback of a page's compaction, and short of the grace.
    b.now += Duration::from_secs(70);
    b.ticks(3);
    assert_eq!(b.shadow.tally, Tally::default());
    b.put_checkpoint(&ended);
    b.until("let go", |b| b.tables_held() == 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() }, "compared and not expired");
    // The grace past the removal, for a table already let go of, counts nothing more.
    b.now += GONE_GRACE * 2;
    b.ticks(3);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
}

/// The worker is sent a request at the time it is sent, not at the time the pass began or the time the tick took: a
/// pass can take longer than the worker's wait for an answer (a lock waited for, a plan, the drains), and the silence
/// is judged from the post.
#[test]
fn a_request_is_posted_at_the_time_it_is_sent_and_not_the_time_the_pass_began() {
    let go = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut b = Bench::with_worker("house roulette 3", |m| gated(m, go.clone()));
    let t0 = b.now;
    // A pass whose clock moves on 30 seconds with every reading: what it asks of the worker it asks at the end of it.
    let readings = std::cell::Cell::new(0u64);
    let last = std::cell::Cell::new(t0);
    let clock = || {
        readings.set(readings.get() + 1);
        let at = t0 + Duration::from_secs(30 * (readings.get() - 1));
        last.set(at);
        at
    };
    let rooms = |b: &Bench| vec![(b.room().to_string(), b.doc.clone(), b.view.clone())];
    let r = rooms(&b);
    b.shadow.tick_with(&clock, r);
    assert!(b.shadow.counts().cold >= 1, "the table was posted");
    let posted = last.get();
    assert!(posted >= t0 + Duration::from_secs(60), "(the last reading is the post's, well after the first two)");
    // Five seconds after the post, the worker has not answered: no more than five seconds of silence.
    let r = rooms(&b);
    b.shadow.tick_with(&|| posted + Duration::from_secs(5), r);
    assert!(b.shadow.sup.is_up(), "five seconds of silence is no failure");
    assert_eq!(b.shadow.sup.counts().1, 0);
    // Past the wait for an answer it is.
    let r = rooms(&b);
    b.shadow.tick_with(&|| posted + Duration::from_secs(11), r);
    assert_eq!(b.shadow.sup.counts().1, 1, "and eleven are");
    go.store(true, Ordering::SeqCst);
}

/// The node's own shadow holds what it reads of a doc to the times the house can wait for; the tests' does not.
#[test]
fn the_nodes_own_shadow_holds_its_reads_of_a_doc_to_a_time() {
    use crate::fold_pins::PIN_WALK_TIME;
    use crate::house_mirror::DRAIN_TIME;
    let b = Bench::new("house roulette 3");
    assert_eq!((b.shadow.limits.drain_time, b.shadow.pin_walk_time), (None, None));
    let live = FoldShadow::live(ThreadLaunch::new(Arc::new(|| panic!("no worker is wanted"))), Instant::now());
    assert_eq!((live.limits.drain_time, live.pin_walk_time), (Some(DRAIN_TIME), Some(PIN_WALK_TIME)));
    assert_eq!(live.limits.drain_bytes, Limits::default().drain_bytes);
}

/// A drain with no time at all does one action and stops, and the shadow still gets to the end of its work: the
/// table is answered and a page's trim compared.
#[test]
fn a_shadow_whose_drains_have_no_time_still_reads_a_table_and_compares_its_trim() {
    let mut b = Bench::new("house craps 3");
    b.shadow.limits = Limits { drain_time: Some(Duration::ZERO), ..Limits::default() };
    b.shadow.pin_walk_time = Some(Duration::ZERO);
    // (The rooms are attached after the limits are set.)
    b.until("the first answer", |b| b.caught_up());
    let cp = b.page_trim(&b.answer());
    b.put_checkpoint(&cp);
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
}

/// The shadow's own watch of a room's players is held to the walk time it is given: a map not read to its end in the
/// time leaves the pins unsettled, and so the view.
#[test]
fn the_watch_of_a_rooms_players_is_held_to_the_walk_time_the_shadow_has() {
    for timed in [false, true] {
        let b = Bench::new("house roulette 3");
        for i in 0..200 {
            b.add_player(&format!("p{i:03}"), &format!("key-{i}"));
        }
        let others = b.case.pins.iter().filter(|(p, _)| p != OWNER).count();
        let (room, doc, houses) = (b.room().to_string(), b.doc.clone(), b.case.houses.clone());
        let mut shadow = b.shadow;
        shadow.pin_walk_time = timed.then_some(Duration::ZERO);
        let plan = HousePlan { owner: OWNER.to_string(), owner_key: OWNER_KEY.to_string(), tables: vec![], houses, complete: true, gapped: false };
        let view = shadow.view_of(&room, &doc, plan, PIN_WALK_KEYS);
        assert_eq!(view.settled, !timed, "timed={timed}: the players are {}", if timed { "not all read" } else { "all read" });
        // (The 200 players, the owner and the players of the vector.)
        assert_eq!(view.pins.len() == 201 + others, !timed, "timed={timed}");
    }
}

/// The final checkpoint of a removed table that is first read in the tick its grace ends is compared, and the table is
/// not counted expired: the comparison comes before the giving up.
#[test]
fn a_final_checkpoint_first_read_as_the_grace_ends_is_compared_and_not_expired() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let ended = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    let t = b.case.ctx.t.clone();
    b.mark_gone(&t);
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    // The grace is over as the checkpoint is written: the next drain is the first to read it.
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.put_checkpoint(&ended);
    b.until("let go", |b| b.tables_held() == 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() }, "compared, and not given up on");
    assert_eq!(b.forgets(), 1);
}

/// A table whose grace is over and whose final checkpoint is written and not read (the drain was short) is kept for
/// it: given up on only when there is nothing left to read.
#[test]
fn a_table_whose_grace_is_over_with_its_final_checkpoint_written_and_unread_is_kept() {
    let mut b = Bench::new("house roulette 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let sum = b.answer();
    let u = last_decided(&sum).expect("a decided round");
    let ended = with_cp(&page_cp(&sum, u, nets_through(&sum, u), false, false), "e", Some(CVal::Int(1)));
    let (t, inc, room) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone(), b.room().to_string());
    b.mark_gone(&t);
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    b.put_checkpoint(&ended);
    assert!(b.shadow.rooms[&room].mirror.base_unread(&t, &inc), "(written, not read)");
    let later = b.now + GONE_GRACE + Duration::from_secs(1);
    let view = b.view.clone().unwrap();
    let rs = b.shadow.rooms.get_mut(&room).unwrap();
    let mut tally = Tally::default();
    rs.expire(later, &view, &mut tally);
    assert_eq!(tally, Tally::default(), "nothing is given up on");
    assert!(rs.gone.contains_key(&(t.clone(), inc.clone())), "and the removal is remembered");
    // The drain reads it, and it is compared.
    b.now = later;
    b.until("let go", |b| b.tables_held() == 0);
    assert_eq!(b.shadow.tally, Tally { agree: 1, ..Tally::default() });
}

/// A table with no checkpoint and held for another reason (a record a page may read otherwise) is no unreadable
/// checkpoint, though its base changed before: the skip is for the checkpoint the node cannot read.
#[test]
fn a_table_held_for_a_record_a_page_may_read_otherwise_is_no_unreadable_checkpoint() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let cp = b.page_trim(&b.answer());
    b.put_checkpoint(&cp);
    b.until("compared", |b| b.shadow.tally.agree + b.shadow.tally.mismatch > 0);
    let before = b.shadow.tally;
    b.ticks(5);
    // A page's junk where the checkpoint was: no checkpoint again, the table's first session read afresh, and a record
    // in it that a page may read otherwise.
    let (t, inc) = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    let first = b.live(None);
    let key = b.case.warm.iter().flatten().find(|(_, v)| v.is_some()).map(|(k, _)| k.clone()).expect("a record");
    {
        let comp = b.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = b.doc.transact_mut();
        comp.insert(&mut txn, format!("sum:{t}:{inc}"), to_any(&CVal::Int(5)));
        let Some(yrs::Out::YMap(m)) = comp.get(&txn, &first) else { panic!("no first session") };
        let proto = yrs::Any::Map(Arc::new(std::collections::HashMap::from([("r".to_string(), yrs::Any::Number(1.0)), ("__proto__".to_string(), yrs::Any::String(Arc::from("x")))])));
        m.insert(&mut txn, key.as_str(), proto);
    }
    b.ticks(20);
    let st = b.shadow.rooms[b.room()].mirror.state(&t, &inc).unwrap();
    assert!(st.base.is_none() && st.trims >= 2 && st.hold == Some(crate::house_mirror::Hold::Unclear), "the table is held for a record: {:?} trims {}", st.hold, st.trims);
    assert_eq!(b.shadow.tally, before, "and nothing is counted of a checkpoint that is none");
}

// ── Review round 5 ───────────────────────────────────────────────────────────

/// How a line of the log names the table it is about: the room, the table and its incarnation.
fn tag_of(b: &Bench) -> String {
    format!("{} {} {}", b.room(), b.case.ctx.t, b.case.ctx.inc)
}

/// Every comparison counted, made or not.
fn counted(t: Tally) -> u64 {
    t.agree + t.mismatch + t.skipped()
}

/// A late record of a table the plan stopped naming is folded without the houses the plan has no word of: the
/// answer made after it is not shown whole, so a trim of the table is not held against the node.
#[test]
fn a_table_the_plan_stopped_naming_is_not_shown_whole_again_by_an_answer_made_after_it_left() {
    for named in [true, false] {
        let mut b = Bench::new("house craps 3");
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "named={named}: shown whole");
        let table = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
        if !named {
            b.view.as_mut().unwrap().tables.clear();
        }
        b.ticks(3);
        // A record comes into the session after: the node's answer is a new one.
        let frame = b.shadow.rooms[b.room()].feed.fold(&table.0, &table.1).unwrap().frame;
        b.add_a_record();
        b.until("answered afresh", |b| b.shadow.rooms[b.room()].feed.fold(&table.0, &table.1).is_some_and(|f| f.frame > frame) && b.caught_up());
        b.ticks(3);
        let stamped = b.shadow.rooms[b.room()].confirmed.get(&table).map(|s| s.frame).expect("what was shown before is kept");
        let now = b.shadow.rooms[b.room()].feed.fold(&table.0, &table.1).unwrap().frame;
        assert_eq!(stamped == now, named, "named={named}: shown whole by the answer made after (stamp {stamped}, answer {now})");
        // A page's trim that the answer made after the late record left does not agree with.
        let wrong = b.wrong_trim(&b.answer());
        b.put_checkpoint(&wrong);
        b.until("counted", |b| counted(b.shadow.tally) > 0);
        let expected = if named { Tally { mismatch: 1, ..Tally::default() } } else { Tally { inputs: 1, ..Tally::default() } };
        assert_eq!(b.shadow.tally, expected, "named={named}");
    }
}

/// ... but what was shown of it before it left holds against an answer that is that very one.
#[test]
fn what_was_shown_whole_of_a_table_before_the_plan_stopped_naming_it_holds_for_its_final_checkpoint() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    let table = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(5);
    assert!(b.shadow.rooms[b.room()].confirmed.contains_key(&table), "kept");
    b.put_checkpoint(&wrong);
    b.until("counted", |b| counted(b.shadow.tally) > 0);
    assert_eq!(b.shadow.tally, Tally { mismatch: 1, ..Tally::default() }, "a difference found in an answer shown whole is the node's");
}

/// The checkpoints a table has been compared with are remembered over a rewind and the restore of what it rewound.
#[test]
fn a_checkpoint_put_back_after_another_is_not_compared_again() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let sum = b.answer();
    let (a, other) = (b.page_trim(&sum), b.wrong_trim(&sum));
    b.put_checkpoint(&a);
    b.until("compared", |b| counted(b.shadow.tally) >= 1);
    b.ticks(5);
    let after_a = counted(b.shadow.tally);
    assert_eq!(after_a, 1);
    // A page rewinds the table to another checkpoint, and it is counted too.
    b.put_checkpoint(&other);
    b.until("the other counted", |b| counted(b.shadow.tally) >= 2);
    b.ticks(5);
    let after_other = counted(b.shadow.tally);
    assert_eq!(after_other, 2);
    // ... and the first is put back: it has been counted.
    b.put_checkpoint(&a);
    b.ticks(30);
    let st = b.shadow.rooms[b.room()].mirror.state(&b.case.ctx.t, &b.case.ctx.inc).unwrap().trims;
    assert_eq!(st, 3, "(the mirror did see it as a change)");
    assert_eq!(counted(b.shadow.tally), after_other, "and not counted again");
    // The history is bounded: the oldest is forgotten first.
    let rs = &b.shadow.rooms[b.room()];
    assert_eq!(rs.compared.values().map(VecDeque::len).sum::<usize>(), 2);
    let key = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    let mut compared = BTreeMap::new();
    for i in 0..(COMPARED_HISTORY + 4) {
        remember(&mut compared, &key, [i as u8; 32]);
    }
    assert_eq!(compared[&key].len(), COMPARED_HISTORY);
    assert!(!seen(&compared, &key, &[0u8; 32]) && seen(&compared, &key, &[(COMPARED_HISTORY + 3) as u8; 32]));
    remember(&mut compared, &key, [(COMPARED_HISTORY + 3) as u8; 32]);
    assert_eq!(compared[&key].len(), COMPARED_HISTORY, "one remembered again takes no second place");
    assert!(seen(&compared, &key, &[4u8; 32]), "and puts none out");
}

/// The checkpoint a table is first followed with is no trim: if the table starts over without one (its session is
/// replaced while the worker cannot be told), the answer from before is not held against it and nothing is counted.
#[test]
fn the_checkpoint_a_table_was_first_followed_with_is_not_counted_when_the_table_starts_over_without_a_trim() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let cp = b.page_trim(&b.answer());
    b.put_checkpoint(&cp);
    b.until("compared", |b| b.shadow.tally.agree > 0);
    // The room is let go of, and followed afresh with the checkpoint in the doc: the table's first.
    let view = b.view.take();
    b.until("let go", |b| b.shadow.rooms.is_empty());
    b.view = view;
    b.shadow.tally = Tally::default();
    b.until("answered", |b| b.caught_up());
    let st = b.shadow.rooms[b.room()].mirror.state(&b.case.ctx.t, &b.case.ctx.inc).unwrap().trims;
    assert_eq!(st, 0, "the first checkpoint the table is read with");
    // The session is replaced while the worker cannot be told: the table starts over, and the answer in hand is the old.
    b.shadow.sup.clog(QUEUE_BYTES);
    {
        let live = b.live(Some(&cp));
        let comp = b.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = b.doc.transact_mut();
        comp.insert(&mut txn, live.as_str(), MapPrelim::default());
    }
    b.ticks(15);
    let rs = &b.shadow.rooms[b.room()];
    let st = rs.mirror.state(&b.case.ctx.t, &b.case.ctx.inc).unwrap();
    assert!(rs.feed.fold(&b.case.ctx.t, &b.case.ctx.inc).is_some_and(|f| f.generation < st.generation), "(the answer in hand is from before the start over)");
    assert_eq!(b.shadow.tally, Tally::default(), "nothing is counted of the checkpoint it began with");
}

/// ... and it is remembered: a page that puts it back after another checkpoint does not have it counted.
#[test]
fn the_checkpoint_a_table_was_first_followed_with_is_not_counted_when_a_page_puts_it_back_after_another() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let sum = b.answer();
    let first = b.page_trim(&sum);
    b.put_checkpoint(&first);
    b.until("compared", |b| counted(b.shadow.tally) > 0);
    // The room is let go of, and followed afresh with the checkpoint in the doc: the table's first.
    let view = b.view.take();
    b.until("let go", |b| b.shadow.rooms.is_empty());
    b.view = view;
    b.shadow.tally = Tally::default();
    b.until("answered", |b| b.caught_up());
    assert_eq!(b.shadow.rooms[b.room()].mirror.state(&b.case.ctx.t, &b.case.ctx.inc).unwrap().trims, 0, "the first checkpoint the table is read with");
    // Another comes: a trim, and counted.
    let other = b.wrong_trim(&sum);
    b.put_checkpoint(&other);
    b.until("the other counted", |b| counted(b.shadow.tally) >= 1);
    b.ticks(5);
    let after_other = counted(b.shadow.tally);
    assert_eq!(after_other, 1);
    // The first is put back: it is no trim to be counted.
    b.put_checkpoint(&first);
    b.ticks(30);
    assert_eq!(b.shadow.rooms[b.room()].mirror.state(&b.case.ctx.t, &b.case.ctx.inc).unwrap().trims, 2, "(the mirror did see it as a change)");
    assert_eq!(counted(b.shadow.tally), after_other, "and not counted");
}

/// A room with no table has nothing to read: its doc is not taken, so that a write held open on it (a commit being
/// made) holds the shadow up for no reason.
#[test]
fn a_room_with_no_table_to_follow_does_not_wait_for_its_doc() {
    let mut b = Bench::new("house roulette 3");
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    assert_eq!(b.shadow.rooms.len(), 1, "the room is watched");
    let doc = b.doc.clone();
    let (held, held_rx) = std::sync::mpsc::channel::<()>();
    let (release, release_rx) = std::sync::mpsc::channel::<()>();
    // A write open on the doc until the tick is over (or five seconds, when it waits for it).
    let holder = thread::spawn(move || {
        let txn = doc.transact_mut();
        held.send(()).unwrap();
        let waited_for = release_rx.recv_timeout(Duration::from_secs(5)).is_err();
        drop(txn);
        waited_for
    });
    held_rx.recv().unwrap();
    b.tick();
    release.send(()).unwrap();
    assert!(!holder.join().unwrap(), "the tick of a room with no table waited for its doc");
}

/// What the mirror saw of a room's delegations is the room's history for as long as the house has a plan for it: a
/// table that comes after the last one went is read against it.
#[test]
fn a_delegation_replaced_before_the_last_table_went_is_still_churn_when_another_comes() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    b.delegate_by("house-a", "owner");
    b.ticks(2);
    b.delegate_by("house-a", "someone else");
    b.ticks(2);
    assert!(b.shadow.rooms[b.room()].mirror.delegations().churned);
    assert_eq!(b.confirmed_count(), 0, "nothing is shown whole in a room whose delegations were replaced");
    // The table ends and goes (the grace passes).
    let view = b.view.clone().unwrap();
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.until("the table is let go of", |b| b.tables_held() == 0);
    assert_eq!(b.shadow.rooms.len(), 1, "(the room stays, with no table)");
    assert!(b.shadow.rooms[b.room()].mirror.delegations().churned, "and so does what its mirror saw");
    // Another table comes: it is read against that.
    b.view = Some(view);
    b.until("answered", |b| b.caught_up());
    b.ticks(5);
    assert!(b.shadow.rooms[b.room()].mirror.delegations().churned);
    assert_eq!(b.confirmed_count(), 0, "still nothing shown whole");
}

/// A delegation replaced in a room that has a plan and no table yet is seen all the same.
#[test]
fn a_delegation_replaced_in_a_room_with_a_plan_and_no_table_yet_is_seen() {
    let mut b = Bench::new("house craps 3");
    let view = b.view.clone().unwrap();
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(3);
    b.delegate_by("house-a", "owner");
    b.delegate_by("house-a", "someone else");
    b.ticks(3);
    assert!(b.shadow.rooms[b.room()].mirror.delegations().churned);
    b.view = Some(view);
    b.until("answered", |b| b.caught_up());
    b.ticks(5);
    assert_eq!(b.confirmed_count(), 0);
}

/// A view is settled only while the doc names the deed holder the plan was made under.
#[test]
fn a_view_is_settled_only_while_the_doc_names_the_deed_holder_the_plan_was_made_under() {
    let b = Bench::new("house craps 3");
    let (room, doc, houses) = (b.room().to_string(), b.doc.clone(), b.case.houses.clone());
    let plan = |owner: &str| HousePlan { owner: owner.to_string(), owner_key: OWNER_KEY.to_string(), tables: vec![], houses: houses.clone(), complete: true, gapped: false };
    let mut shadow = b.shadow;
    assert!(shadow.view_of(&room, &doc, plan(OWNER), PIN_WALK_KEYS).settled, "the holder the doc names");
    assert!(!shadow.view_of(&room, &doc, plan("someone else"), PIN_WALK_KEYS).settled, "a plan made under another");
    // The deed changes hands after the plan was made (the race of a house pass and the shadow's own).
    let info = doc.get_or_insert_map("roomInfo");
    {
        let mut txn = doc.transact_mut();
        info.insert(&mut txn, "owner", "heir");
    }
    assert!(!shadow.view_of(&room, &doc, plan(OWNER), PIN_WALK_KEYS).settled, "the old plan, the new holder");
    // (The heir is a player too, and the plan of the new holder names the key it was made with.)
    let players = doc.get_or_insert_map("players");
    {
        let mut txn = doc.transact_mut();
        players.insert(&mut txn, "heir", to_any(&obj(vec![("keyB64", s(OWNER_KEY))])));
    }
    assert!(shadow.view_of(&room, &doc, plan("heir"), PIN_WALK_KEYS).settled, "and the plan of the new holder");
    // A room with no holder named has no houses to be settled about.
    {
        let mut txn = doc.transact_mut();
        info.remove(&mut txn, "owner");
    }
    assert!(!shadow.view_of(&room, &doc, plan(OWNER), PIN_WALK_KEYS).settled);
}

/// The houses of a plan are the ones the key it names for the deed holder delegated: a view is settled only while the
/// watch has pinned that key for the holder (a key replaced between the pass and the watch is not the key of the plan).
#[test]
fn a_view_is_settled_only_while_the_watch_pins_the_key_the_plan_was_made_with_for_the_deed_holder() {
    let b = Bench::new("house craps 3");
    let (room, doc, houses) = (b.room().to_string(), b.doc.clone(), b.case.houses.clone());
    let plan = |owner: &str, key: &str| HousePlan { owner: owner.to_string(), owner_key: key.to_string(), tables: vec![], houses: houses.clone(), complete: true, gapped: false };
    let mut shadow = b.shadow;
    assert!(shadow.view_of(&room, &doc, plan(OWNER, OWNER_KEY), PIN_WALK_KEYS).settled, "the key the watch has pinned for the holder");
    assert!(!shadow.view_of(&room, &doc, plan(OWNER, "the key before"), PIN_WALK_KEYS).settled, "a plan made under another key of the holder");
    assert!(!shadow.view_of(&room, &doc, plan(OWNER, ""), PIN_WALK_KEYS).settled, "or under none");
    // The deed names a holder the room has no player for: there is no key pinned to agree with.
    let info = doc.get_or_insert_map("roomInfo");
    {
        let mut txn = doc.transact_mut();
        info.insert(&mut txn, "owner", "ghost");
    }
    assert!(!shadow.view_of(&room, &doc, plan("ghost", OWNER_KEY), PIN_WALK_KEYS).settled, "a holder nobody pinned");
}

/// A table kept after the plan stopped naming it, for the checkpoint a page writes when it compacts it, still takes a
/// place of the worker's, and the report of the tables followed says so.
#[test]
fn a_table_kept_for_its_final_checkpoint_is_still_among_the_tables_the_report_counts() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    assert_eq!(b.shadow.report().tables, 1);
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(5);
    assert_eq!((b.tables_held(), b.forgets()), (1, 0), "(kept for its grace)");
    assert_eq!(b.shadow.report().tables, 1, "and it holds a place of the worker's");
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.until("the table is let go of", |b| b.tables_held() == 0);
    b.tick();
    assert_eq!(b.shadow.report().tables, 0, "and the place is given back");
}

/// The deed changed hands between the view and the drain: the answer shown whole is taken back, and the session is held in
/// doubt for the handover (round 7: it was told by the epoch alone, which the holder coming back settles again).
#[test]
fn a_difference_is_not_counted_when_the_deed_changed_hands_after_the_answer_was_shown_whole() {
    for changed in [false, true] {
        let mut b = Bench::new("house craps 3");
        let _pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "changed={changed}: shown whole");
        let wrong = b.wrong_trim(&b.answer());
        if changed {
            b.set_owner("heir");
        }
        b.put_checkpoint(&wrong);
        b.tick();
        let expected = if changed { Tally { handover: 1, ..Tally::default() } } else { Tally { mismatch: 1, ..Tally::default() } };
        assert_eq!(b.shadow.tally, expected, "changed={changed}");
    }
}

/// The second checkpoint the node cannot read, where the first was the table's first, is the first trim and is counted.
#[test]
fn the_trim_after_a_first_checkpoint_the_node_cannot_read_is_counted_as_unreadable() {
    let mut b = Bench::new("house craps 3");
    let sum = finished(&b.case.summary);
    let plain = b.page_trim(&sum);
    b.put_checkpoint(&held(&plain));
    b.ticks(30);
    assert_eq!(b.shadow.tally, Tally::default(), "(the first is no trim)");
    // A page's next trim is one the node cannot read either, and not the same.
    b.put_checkpoint(&with_cp(&plain, "__proto__", Some(s("y"))));
    b.until("counted", |b| b.shadow.tally.unreadable > 0);
    b.ticks(30);
    assert_eq!(b.shadow.tally, Tally { unreadable: 1, ..Tally::default() }, "once, however long it is held");
    // And the next, again.
    b.put_checkpoint(&with_cp(&plain, "__proto__", Some(s("z"))));
    b.until("counted again", |b| b.shadow.tally.unreadable > 1);
    b.ticks(30);
    assert_eq!(b.shadow.tally, Tally { unreadable: 2, ..Tally::default() });
}

/// Checkpoints written one after another before a drain reaches the table: the table reads the last, and the node says
/// how many it never had.
#[test]
fn a_checkpoint_written_over_before_the_node_read_it_is_counted_as_superseded() {
    for same in [false, true] {
        let mut b = Bench::new("house craps 3");
        b.until("the first answer", |b| b.caught_up());
        b.ticks(3);
        let sum = b.answer();
        let (plain, other) = (b.page_trim(&sum), b.wrong_trim(&sum));
        // Two pages' trims, in two transactions, before the node looks.
        b.put_checkpoint(&plain);
        b.put_checkpoint(if same { &plain } else { &other });
        b.ticks(30);
        let t = b.shadow.tally;
        assert_eq!(t.superseded, if same { 0 } else { 1 }, "same={same}: {t:?}");
        assert_eq!(counted(t), if same { 1 } else { 2 }, "same={same}: the last is compared (or passed over), and the one before counted as not made");
        if !same {
            let r = b.shadow.report();
            assert!(r.recent_skips.iter().any(|l| l.starts_with(&tag_of(&b)) && l.contains("superseded")), "{:?}", r.recent_skips);
            assert_eq!(r.shadow_skipped, t.skipped());
        }
    }
}


// ── Review round 6 ───────────────────────────────────────────────────────────

/// A line is kept to 512 bytes, so the player that differs comes before the nets of everyone else.
#[test]
fn the_player_whose_net_differs_is_named_before_the_nets_of_all_the_others() {
    let ours: BTreeMap<String, i128> = (0..300).map(|i| (format!("player-{i:04}-{}", "x".repeat(40)), 1)).collect();
    let mut theirs = ours.clone();
    let last = ours.keys().last().unwrap().clone();
    theirs.insert(last.clone(), 7);
    let why = nets_differ(5, &ours, &theirs);
    let kept = clip(format!("room t inc u=5: MISMATCH — {why}"));
    assert!(kept.len() <= LOG_LINE_BYTES + '…'.len_utf8());
    let named = format!("{}…", &last[..48]);
    assert!(kept.contains(&named) && kept.contains("has 1 in the fold and 7 in the checkpoint"), "{kept}");
    // Two differ: the first, and how many more.
    theirs.insert(ours.keys().next().unwrap().clone(), 2);
    let why = nets_differ(5, &ours, &theirs);
    assert!(why.contains("player-0000") && why.contains("has 1 in the fold and 2 in the checkpoint and 1 more;"), "{why}");
    // A player one of them does not name has nothing there.
    let (a, b) = (BTreeMap::from([("p".to_string(), 3)]), BTreeMap::new());
    assert!(nets_differ(2, &a, &b).contains("p has 3 in the fold and 0 in the checkpoint;"));
    assert!(nets_differ(2, &b, &a).contains("p has 0 in the fold and 3 in the checkpoint;"));
    // A name a peer chose does not take the line.
    let long = "é".repeat(500);
    let why = nets_differ(2, &BTreeMap::from([(long.clone(), 1)]), &BTreeMap::new());
    assert!(why.starts_with(&format!("n through round 2: {}… has 1 in the fold", "é".repeat(48))), "{}", &why[..120]);
}

/// A line names the room, whatever the table: two rooms can have the same table and incarnation.
#[test]
fn a_line_names_the_room_as_well_as_the_table() {
    assert_eq!(tag("room-a", "craps-1", "inc"), "room-a craps-1 inc");
    assert_ne!(tag("room-a", "craps-1", "inc"), tag("room-b", "craps-1", "inc"));
    // A name is cut at 64 BYTES (the log clips by bytes): 32 two-byte characters, not 64.
    let long = "é".repeat(100);
    assert_eq!(tag(&long, "t", "i"), format!("{}… t i", "é".repeat(32)));
    // ... and at a character, whatever byte the cut falls on.
    let odd = format!("a{}", "é".repeat(100));
    assert_eq!(tag(&odd, "t", "i"), format!("a{}… t i", "é".repeat(31)));
    assert_eq!(brief("short", 64), "short");
    assert_eq!(brief(&"a".repeat(64), 64), "a".repeat(64), "of the most is whole");
    assert_eq!(brief_bytes(&"a".repeat(64), 64), "a".repeat(64), "of the most is whole");
    // The room, the table and the incarnation always fit a line, so the incarnation is never cut off by a name.
    let worst = tag(&"é".repeat(500), &"é".repeat(500), "inc-1");
    assert!(worst.len() < LOG_LINE_BYTES / 2 && worst.ends_with(" inc-1"), "{worst}");
}

/// The worker holds `places` tables, and a table it does not hold yet waits for a place, and takes it when one is let go of:
/// the shadow never asks it to hold more (`Bench::tick` holds it to that every time), whichever tables the cap meant to follow.
#[test]
fn a_table_the_worker_has_no_place_for_waits_for_one_and_takes_it_when_one_is_let_go_of() {
    let mut b = Bench::new("house roulette 3");
    b.shadow.places = 4;
    let inc = b.case.ctx.inc.clone();
    let names: Vec<String> = (0..6).map(|i| format!("t{i:02}")).collect();
    for t in &names {
        b.empty_table(t);
    }
    b.view.as_mut().unwrap().tables = names.iter().map(|t| (t.clone(), inc.clone())).collect();
    b.until("the four that have places are answered", |b| b.shadow.counts().results >= 4);
    b.ticks(10);
    assert_eq!((b.shadow.holds(), b.shadow.counts().cold), (4, 4), "the other two wait: {:?}", b.shadow.counts());
    // Two of the tables are let go of when the plan stops naming them and the grace is over: their places go to the two that wait.
    b.view.as_mut().unwrap().tables = names[2..].iter().map(|t| (t.clone(), inc.clone())).collect();
    b.ticks(3);
    assert_eq!((b.shadow.holds(), b.shadow.counts().cold), (4, 4), "(kept for the final checkpoint they may yet have)");
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.until("the tables that waited are started", |b| b.shadow.counts().cold >= 6);
    assert_eq!(b.shadow.counts().lost, 0, "{:?}", b.shadow.counts());
    assert!(b.shadow.holds() <= 4);
}

// ── Review round 7 ───────────────────────────────────────────────────────────

impl Bench {
    /// The tables of the room the pages may have folded with another holder's houses.
    fn handover_tables(&self) -> usize {
        self.shadow.rooms[self.room()].handover.len()
    }

    /// The deed goes to `heir` and comes back, with no tick between.
    fn flip_the_deed(&self) {
        self.set_owner("heir");
        self.set_owner(OWNER);
    }
}

/// The deed changed hands and came back between two ticks: the holder is the one the answer was made under, and the view
/// settles again, but a page may have folded the session with the houses of the other holder. A difference is not counted
/// for the session, however the ticks go after.
#[test]
fn a_difference_is_not_counted_when_the_deed_changed_hands_and_came_back_between_two_ticks() {
    for flips in [false, true] {
        let mut b = Bench::new("house craps 3");
        let mut pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "flips={flips}: shown whole");
        if flips {
            b.flip_the_deed();
        }
        // (The view of the next tick: the holder the plan names, the epoch moved.)
        b.sync_pins(&mut pins);
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "flips={flips}: and shown whole again");
        assert_eq!(b.handover_tables(), flips as usize, "flips={flips}");
        let wrong = b.wrong_trim(&b.answer());
        b.put_checkpoint(&wrong);
        b.tick();
        let expected = if flips { Tally { handover: 1, ..Tally::default() } } else { Tally { mismatch: 1, ..Tally::default() } };
        assert_eq!(b.shadow.tally, expected, "flips={flips}");
        assert_eq!(b.handover_tables(), 0, "flips={flips}: the session is over, and the doubt with it");
        if flips {
            let r = b.shadow.report();
            assert!(r.recent_skips.iter().any(|l| l.starts_with(&tag_of(&b)) && l.contains("handover")), "{:?}", r.recent_skips);
            assert!(r.recent_mismatches.is_empty());
        }
    }
}

/// A handover seen, one holder and then the other, is held the same.
#[test]
fn a_difference_is_not_counted_when_the_deed_changed_hands_and_the_ticks_saw_each_holder() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    for holder in ["heir", OWNER] {
        b.set_owner(holder);
        b.sync_pins(&mut pins);
        b.ticks(3);
    }
    assert_eq!(b.handover_tables(), 1);
    b.ticks(5);
    assert_eq!(b.confirmed_count(), 1, "(the holder is back and the view settled)");
    let wrong = b.wrong_trim(&b.answer());
    b.put_checkpoint(&wrong);
    b.tick();
    assert_eq!(b.shadow.tally, Tally { handover: 1, ..Tally::default() });
}

/// The deed changing hands in the very tick a trim is read may have come after the trim: the trim is skipped, and so is
/// the next, which the doubt is kept for.
#[test]
fn a_handover_in_the_tick_a_trim_is_read_in_is_held_against_the_next_trim_too() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.put_checkpoint(&wrong);
    b.tick();
    assert_eq!(b.shadow.tally, Tally { handover: 1, ..Tally::default() });
    assert_eq!(b.handover_tables(), 1, "(it may have come after the trim: the session after it is doubted too)");
    b.ticks(5);
    assert_eq!(b.handover_tables(), 1);
}

/// The watch of the first tick is no handover, however many the deed had before: there was no tick to compare with. And a
/// watch that is another watch is: the count it has is no count to hold against the last.
#[test]
fn the_first_look_is_no_handover_and_another_watch_is() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    assert_eq!(b.handover_tables(), 0, "(nothing was followed before the deed changed hands)");
    // Another watch of the same room, with the same count of handovers: it is another watch.
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    assert_eq!(b.handover_tables(), 0);
    let mut other = PlayerPins::attach(&b.doc, PIN_WALK_KEYS);
    b.sync_pins(&mut other);
    assert_eq!(other.watch().deeds(), pins.watch().deeds());
    b.ticks(3);
    assert_eq!(b.handover_tables(), 1);
    let _ = pins.view();
    // A view with no watch (made by hand) says nothing of the deed.
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.flip_the_deed();
    b.ticks(5);
    assert_eq!(b.handover_tables(), 0);
}

/// A trim the node cannot read is a trim of a session it cannot name: the doubt of a handover does not end with it (round 9;
/// it did, in round 8). One that names the session in doubt does, whatever the node made of it.
#[test]
fn the_doubt_of_a_handover_is_not_ended_by_a_trim_the_node_cannot_read() {
    // A trim of a checkpoint the node cannot read as a page does (held), the table's first trim.
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    let sum = finished(&b.case.summary);
    let plain = b.page_trim(&sum);
    b.put_checkpoint(&held(&plain));
    b.ticks(30);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(5);
    assert_eq!(b.handover_tables(), 1);
    b.put_checkpoint(&with_cp(&plain, "__proto__", Some(s("y"))));
    b.until("counted", |b| b.shadow.tally.unreadable > 0);
    assert_eq!(b.handover_tables(), 1, "the unreadable trim is of a session the node cannot name: the doubt stays");
    b.ticks(5);
    assert_eq!(b.handover_tables(), 1);
}

/// A table that comes in the tick the deed changed hands is held in doubt too: its history before the node looked is not
/// known, and the pages may have folded it with the other holder's houses.
#[test]
fn a_table_the_shadow_starts_to_read_in_the_tick_the_deed_changes_hands_is_held_in_doubt() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    assert_eq!(b.handover_tables(), 0);
    b.empty_table("a-second-table");
    let inc = b.case.ctx.inc.clone();
    b.view.as_mut().unwrap().tables.push(("a-second-table".to_string(), inc));
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.tick();
    assert_eq!(b.handover_tables(), 2, "the table that was followed and the one that is new");
}

/// A table let go of takes its doubt with it: the flag is not kept for a table the room no longer has.
#[test]
fn the_doubt_of_a_handover_goes_with_the_table_when_it_is_let_go_of() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(3);
    assert_eq!(b.handover_tables(), 1);
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(5);
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.until("the table is let go of", |b| b.tables_held() == 0);
    b.ticks(3);
    assert_eq!(b.handover_tables(), 0);
}

// ── Review round 8 ───────────────────────────────────────────────────────────

impl Bench {
    /// The players who signed a slip of the vector's session.
    fn slip_players(&self) -> BTreeSet<String> {
        self.case.warm.iter().flatten().filter_map(|(k, v)| v.as_ref().and_then(|_| crate::house::parse_key(k))).filter(|p| p.0 == 's').filter_map(|p| p.2.map(str::to_string)).collect()
    }

    /// A slip no fold counts for the vector's table (a round that is never open), signed by `pid` with `key`, comes into
    /// the live session.
    fn add_a_slip(&self, pid: &str, key: &str, n: u32) {
        let live = self.live(None);
        let comp = self.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
        let mut txn = self.doc.transact_mut();
        let Some(yrs::Out::YMap(m)) = comp.get(&txn, &live) else { panic!("no live session") };
        m.insert(&mut txn, format!("s:9999:{pid}:{n:032x}").as_str(), to_any(&obj(vec![("p", s(pid)), ("k", s(key))])));
    }

    /// The bench's view takes the player's pin from them (`None`), or gives them another key.
    fn repin(&mut self, pid: &str, key: Option<&str>) {
        let view = self.view.as_mut().unwrap();
        view.pins.retain(|(p, _)| p != pid);
        if let Some(key) = key {
            view.pins.push((pid.to_string(), key.to_string()));
        }
    }
}

/// A slip of the session signed with a key that is not the one the node has pinned for its player (or whose player the node
/// has no pin for) is one the node's fold does not count and the page whose slip it is may have: the trim is skipped. A
/// trim of a session whose slips are all under their pins is compared as it was.
#[test]
fn a_trim_of_a_session_with_a_slip_signed_under_another_key_than_the_pin_is_skipped_as_signer() {
    for how in ["pinned alike", "another key", "no pin"] {
        let mut b = Bench::new("house craps 3");
        let signers = b.slip_players();
        assert!(!signers.is_empty(), "(the vector's session holds slips)");
        let mut pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "{how}: shown whole");
        let signer = signers.iter().next().unwrap().clone();
        match how {
            "another key" => b.repin(&signer, Some("another-key")),
            "no pin" => b.repin(&signer, None),
            _ => {}
        }
        b.sync_pins(&mut pins);
        let cp = b.page_trim(&b.answer());
        b.put_checkpoint(&cp);
        b.tick();
        let expected = if matches!(how, "another key" | "no pin") { Tally { signer: 1, ..Tally::default() } } else { Tally { agree: 1, ..Tally::default() } };
        assert_eq!(b.shadow.tally, expected, "{how}");
        if expected.signer == 1 {
            let r = b.shadow.report();
            assert!(r.recent_skips.iter().any(|l| l.starts_with(&tag_of(&b)) && l.contains("signer")), "{:?}", r.recent_skips);
            assert_eq!(r.shadow_mismatches, 0);
        }
    }
}

/// A session of more signers than the mirror keeps is never believed, whatever the pins: the shadow cannot say that none was
/// unreconciled.
#[test]
fn a_session_of_more_signers_than_the_mirror_keeps_is_skipped_as_signer() {
    for many in [false, true] {
        let mut b = Bench::new("house craps 3");
        let n = if many { crate::house_mirror::MAX_SIGNERS as u32 + 8 } else { 6 };
        for i in 0..n {
            let (pid, key) = (format!("pidx-{i}"), format!("keyx-{i}"));
            b.add_a_slip(&pid, &key, i + 100);
            b.repin(&pid, Some(&key));
        }
        let mut pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "many={many}: shown whole");
        b.sync_pins(&mut pins);
        let cp = b.page_trim(&b.answer());
        b.put_checkpoint(&cp);
        b.tick();
        let expected = if many { Tally { signer: 1, ..Tally::default() } } else { Tally { agree: 1, ..Tally::default() } };
        assert_eq!(b.shadow.tally, expected, "many={many}");
    }
}

/// `unreconciled`: every (player, key) pair of the slips must be the pin of the player.
#[test]
fn a_set_of_signers_is_reconciled_only_when_every_pair_is_a_pin() {
    let pins = vec![("a".to_string(), "ka".to_string()), ("b".to_string(), "kb".to_string())];
    let set = |pairs: &[(&str, &str)]| -> BTreeSet<(String, String)> { pairs.iter().map(|(p, k)| (p.to_string(), k.to_string())).collect() };
    assert!(!unreconciled(&set(&[]), &pins), "no slips");
    assert!(!unreconciled(&set(&[]), &[]), "no slips, no pins");
    assert!(!unreconciled(&set(&[("a", "ka")]), &pins));
    assert!(!unreconciled(&set(&[("a", "ka"), ("b", "kb")]), &pins));
    assert!(unreconciled(&set(&[("a", "kb")]), &pins), "another player's key");
    assert!(unreconciled(&set(&[("a", "ka"), ("b", "other")]), &pins), "one pair of two");
    assert!(unreconciled(&set(&[("a", "ka"), ("a", "other")]), &pins), "a player with a second key");
    assert!(unreconciled(&set(&[("c", "kc")]), &pins), "no pin");
    assert!(unreconciled(&set(&[("a", "ka")]), &[]), "no pins at all");
}

/// A delegation may have come and gone where the node saw nothing of it: the houses a page counted then are not the ones
/// the node's plan names. With a key beside it that the update shows, the tables in the room are held in doubt until their
/// next trim and the view is shown whole again; with none, the delegations are in doubt for good.
#[test]
fn a_delegation_that_may_have_come_and_gone_unseen_is_a_handover_to_the_tables_in_the_room() {
    for how in ["a key beside it", "no key at all", "an update that hides nothing"] {
        let mut b = Bench::new("house craps 3");
        let _pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!((b.confirmed_count(), b.handover_tables()), (1, 0), "{how}");
        {
            let comp = b.doc.get_or_insert_map(crate::house::COMPUTED_MAP);
            let mut txn = b.doc.transact_mut();
            match how {
                "a key beside it" => {
                    comp.insert(&mut txn, "other", 1);
                    comp.insert(&mut txn, "other", 2);
                }
                "no key at all" => {
                    comp.insert(&mut txn, "scratch", 1);
                    comp.remove(&mut txn, "scratch");
                }
                _ => {
                    comp.insert(&mut txn, "other", 1);
                }
            }
        }
        b.ticks(5);
        let doubted = how != "an update that hides nothing";
        assert_eq!(b.handover_tables(), doubted as usize, "{how}");
        assert_eq!(b.confirmed_count(), (how != "no key at all") as usize, "{how}: shown whole again unless the delegations are in doubt for good");
        let wrong = b.wrong_trim(&b.answer());
        b.put_checkpoint(&wrong);
        b.tick();
        let expected = if doubted { Tally { handover: 1, ..Tally::default() } } else { Tally { mismatch: 1, ..Tally::default() } };
        assert_eq!(b.shadow.tally, expected, "{how}");
        assert_eq!(b.handover_tables(), 0, "{how}: the session is over, and the doubt with it");
    }
}

/// A room let go of (the plan went) and followed again is a new shadow, and starts from what the last knew of the deed: a
/// deed that changed hands while it was gone is a handover to it, and the sessions that were in doubt still are.
#[test]
fn what_a_room_knew_of_the_deed_is_kept_while_the_room_is_let_go_of() {
    for how in ["the deed changed hands while it was gone", "the deed changed hands before", "nothing changed"] {
        let mut b = Bench::new("house craps 3");
        let mut pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        if how == "the deed changed hands before" {
            b.flip_the_deed();
            b.sync_pins(&mut pins);
            b.ticks(3);
            assert_eq!(b.handover_tables(), 1, "{how}");
        }
        // The plan goes: the room is let go of.
        let view = b.view.take().unwrap();
        b.until("the room is gone", |b| b.shadow.rooms.is_empty());
        if how == "the deed changed hands while it was gone" {
            b.flip_the_deed();
        }
        // And is back.
        b.view = Some(view);
        b.sync_pins(&mut pins);
        b.ticks(5);
        let doubted = how != "nothing changed";
        assert_eq!(b.handover_tables(), doubted as usize, "{how}");
    }
}

/// A room the node does not serve any more is not coming back with a plan of its own: what is remembered of it goes.
#[test]
fn what_is_remembered_of_a_room_is_forgotten_when_the_node_no_longer_serves_it() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let view = b.view.take().unwrap();
    b.until("the room is gone", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.shadow.remembered.len(), 1, "(for as long as the room is listed)");
    b.listed = false;
    b.ticks(2);
    assert!(b.shadow.remembered.is_empty());
    // Back, with the deed changed in between: a first look.
    b.flip_the_deed();
    b.listed = true;
    b.view = Some(view);
    b.sync_pins(&mut pins);
    b.ticks(5);
    assert_eq!(b.handover_tables(), 0, "a first look is no handover");
}

/// ... and when the fold duties go off for good, nothing is followed, and nothing is remembered of what was.
#[test]
fn what_is_remembered_of_a_room_goes_when_the_fold_duties_go_off() {
    let mut b = Bench::new("house craps 3");
    let _pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    let view = b.view.take().unwrap();
    b.until("the room is gone", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.shadow.remembered.len(), 1);
    b.shadow.sup.go_off();
    b.tick();
    assert!(b.shadow.remembered.is_empty());
    b.view = Some(view);
    b.ticks(3);
    assert!(b.shadow.rooms.is_empty() && b.shadow.remembered.is_empty());
}

// ── Review round 9 ───────────────────────────────────────────────────────────

impl Bench {
    /// The sessions of the vector's table that are in doubt of a handover.
    fn doubted_sessions(&self) -> Vec<String> {
        let key = (self.case.ctx.t.clone(), self.case.ctx.inc.clone());
        self.shadow.rooms[self.room()].handover.get(&key).map(|set| set.iter().cloned().collect()).unwrap_or_default()
    }

    /// The id of the live session of the vector's table, as the mirror has it.
    fn live_sid(&self) -> String {
        let rs = &self.shadow.rooms[self.room()];
        session_of(rs.mirror.state(&self.case.ctx.t, &self.case.ctx.inc).unwrap().live.expect("a live session")).to_string()
    }

    /// The names of `n` tables of no records, that sort before the vector's, and the view that follows them and then the
    /// vector's table: the cap (`MAX_SHADOW_TABLES`) has no place for the vector's.
    fn crowd_out_the_table(&mut self, n: usize) -> Vec<TableKey> {
        let inc = self.case.ctx.inc.clone();
        let crowd: Vec<TableKey> = (0..n).map(|i| (format!("0-{i:02}"), inc.clone())).collect();
        for (t, _) in &crowd {
            self.empty_table(t);
        }
        let mut tables = crowd.clone();
        tables.push((self.case.ctx.t.clone(), inc));
        self.view.as_mut().unwrap().tables = tables;
        crowd
    }
}

/// The delegations that churned before the room's shadow was let go of (the plan went) are churned for the one that replaces
/// it: the sessions in the room are no more known to have been folded with the houses the plan names for the room being
/// let go of. What the delegations did meanwhile is not known (nothing watches them).
#[test]
fn the_churn_of_the_delegations_is_kept_when_the_room_is_let_go_of_and_followed_again() {
    for churned in [false, true] {
        let mut b = Bench::new("house craps 3");
        let mut pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.ticks(5);
        assert_eq!(b.confirmed_count(), 1, "churned={churned}: shown whole");
        if churned {
            b.delegate("house-x");
            b.withdraw("house-x");
            b.ticks(3);
            assert!(b.shadow.rooms[b.room()].mirror.delegations().churned);
            assert_eq!(b.confirmed_count(), 0, "churned: nothing is shown whole");
        }
        let view = b.view.take().unwrap();
        b.until("the room is gone", |b| b.shadow.rooms.is_empty());
        assert_eq!(b.shadow.remembered[b.room()].churned, churned);
        b.view = Some(view);
        b.sync_pins(&mut pins);
        b.until("answered again", |b| b.caught_up());
        b.ticks(5);
        let rs = &b.shadow.rooms[b.room()];
        assert_eq!(rs.mirror.delegations().churned, churned, "churned={churned}: the new shadow knows what the last did");
        assert_eq!(b.confirmed_count(), (!churned) as usize, "churned={churned}: and shows nothing whole where they churned");
    }
}

/// A table the cap has no place for, but the plan names, keeps what is known of it: the checkpoints it was compared with
/// (a page that puts one back must not have it counted again) and the doubt of a handover. A table the plan stops naming
/// does not.
#[test]
fn a_table_the_cap_puts_out_keeps_its_history_while_the_plan_names_it() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let key = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    let first = b.page_trim(&b.answer());
    b.put_checkpoint(&first);
    b.until("compared", |b| counted(b.shadow.tally) > 0);
    b.ticks(3);
    assert_eq!(b.shadow.tally.agree, 1);
    assert_eq!(b.shadow.rooms[b.room()].compared[&key].len(), 1);
    // Fourteen other tables the plan names come before it: the cap (14) has no place for it, and it is let go of.
    let view_before = b.view.clone().unwrap();
    let crowd = b.crowd_out_the_table(MAX_SHADOW_TABLES);
    b.until("the crowd is answered", |b| b.shadow.counts().results > MAX_SHADOW_TABLES as u64);
    b.ticks(10);
    assert_eq!(b.shadow.report().tables_over, 1, "the cap put the vector's table out");
    assert!(b.shadow.rooms[b.room()].mirror.state(&key.0, &key.1).is_none() || b.shadow.rooms[b.room()].feed.fold(&key.0, &key.1).is_none());
    assert_eq!(b.shadow.rooms[b.room()].compared[&key].len(), 1, "what it was compared with is kept: the plan names it");
    // The deed changes hands meanwhile: a session the node cannot name is in doubt.
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(5);
    assert_eq!(b.doubted_sessions(), vec![ANY_SESSION.to_string()], "the table the cap put out is in doubt too");
    // The plan goes back to the one table: it is followed again, and what it was compared with is not forgotten.
    b.view.as_mut().unwrap().tables = view_before.tables.clone();
    b.sync_pins(&mut pins);
    b.ticks(3);
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.ticks(10);
    b.until("answered again", |b| b.caught_up());
    assert_eq!(b.shadow.rooms[b.room()].compared[&key].len(), 1);
    assert_eq!(b.doubted_sessions(), vec![ANY_SESSION.to_string()], "and so is the doubt, until a trim ends its session");
    // The checkpoint standing is put back after another: it is not counted again.
    b.shadow.tally = Tally::default();
    b.put_checkpoint(&first);
    b.ticks(10);
    assert_eq!(b.shadow.tally, Tally::default(), "the checkpoint it was compared with is not compared again");
    // A table the plan stops naming forgets it (and the others, which it never followed, have nothing).
    let _ = crowd;
    b.view.as_mut().unwrap().tables.clear();
    b.ticks(5);
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.until("let go of", |b| b.tables_held() == 0);
    b.ticks(3);
    assert!(!b.shadow.rooms[b.room()].compared.contains_key(&key) && !b.shadow.rooms[b.room()].handover.contains_key(&key));
}

/// A table the cap put out when the deed changed hands, followed again, has its next trim held in doubt (the doubt was not
/// cleared by anything else).
#[test]
fn the_doubt_of_a_table_the_cap_put_out_ends_with_the_trim_that_ends_its_session() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let view_before = b.view.clone().unwrap();
    b.crowd_out_the_table(MAX_SHADOW_TABLES);
    b.until("the crowd is answered", |b| b.shadow.counts().results > MAX_SHADOW_TABLES as u64);
    b.ticks(10);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(5);
    assert_eq!(b.doubted_sessions(), vec![ANY_SESSION.to_string()]);
    b.view.as_mut().unwrap().tables = view_before.tables.clone();
    b.sync_pins(&mut pins);
    b.ticks(3);
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.ticks(10);
    b.until("answered", |b| b.caught_up());
    b.ticks(5);
    let wrong = b.wrong_trim(&b.answer());
    b.put_checkpoint(&wrong);
    b.tick();
    // (The crowd's tables, which the plan stopped naming, were given up on: that is counted too.)
    assert_eq!(b.shadow.tally, Tally { handover: 1, expired: MAX_SHADOW_TABLES as u64, ..Tally::default() });
    assert_eq!(b.handover_tables(), 0, "the session is over, and the doubt with it");
}

/// The session in doubt is the one that was live when the deed changed hands: its trim (the checkpoint names it) ends the
/// doubt; a handover is not "any trim" (round 8 cleared it with whichever came first).
#[test]
fn the_doubt_of_a_handover_is_of_the_session_that_was_live_and_ends_with_its_trim() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let sid = b.live_sid();
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(3);
    assert_eq!(b.doubted_sessions(), vec![sid.clone()], "the session that was live");
    // A checkpoint that trims a session other than the one in doubt (a page that trims a session the node held in doubt
    // of nothing) does not end it, but the base moving takes the session in doubt out of the room: it is over.
    let wrong = b.wrong_trim(&b.answer());
    b.put_checkpoint(&wrong);
    b.tick();
    assert_eq!(b.shadow.tally, Tally { handover: 1, ..Tally::default() }, "its own trim is held in doubt");
    assert_eq!(b.doubted_sessions(), Vec::<String>::new());
}

/// `doubted` and `close_doubt`: the sessions a trim ends.
#[test]
fn a_trim_ends_the_session_it_names_and_an_unnamed_one_only_if_it_closes_the_session_the_fold_holds() {
    let key: TableKey = ("t".to_string(), "i".to_string());
    let mut h = BTreeMap::new();
    doubt(&mut h, &key, Some("s1"));
    doubt(&mut h, &key, None);
    assert_eq!(h[&key].iter().cloned().collect::<Vec<_>>(), vec!["*".to_string(), "s1".to_string()]);
    // A checkpoint of another session that does not close the fold's (a past or parent one, or one not readable) ends none.
    assert!(!doubted(h.get(&key), Some("s9"), false));
    assert!(!doubted(h.get(&key), None, false));
    close_doubt(&mut h, &key, Some("s9"), false, false);
    assert_eq!(h[&key].len(), 2);
    // The one it names is ended.
    assert!(doubted(h.get(&key), Some("s1"), false));
    close_doubt(&mut h, &key, Some("s1"), false, false);
    assert_eq!(h[&key].iter().cloned().collect::<Vec<_>>(), vec!["*".to_string()]);
    // An unnamed one is ended by a checkpoint that closes the session the fold holds.
    assert!(doubted(h.get(&key), Some("s9"), true));
    assert!(doubted(h.get(&key), None, true));
    close_doubt(&mut h, &key, Some("s9"), true, false);
    assert!(h.is_empty(), "nothing in doubt: the table has no entry");
    // ... and if the deed changed hands in that very tick, the session after is in doubt, not named.
    doubt(&mut h, &key, Some("s1"));
    close_doubt(&mut h, &key, Some("s1"), true, true);
    assert_eq!(h[&key].iter().cloned().collect::<Vec<_>>(), vec!["*".to_string()]);
    // A table with no doubt has none made by a trim.
    close_doubt(&mut h, &("u".to_string(), "i".to_string()), Some("s1"), true, true);
    assert_eq!(h.len(), 1);
    assert_eq!(session_of("ses:a:b:c:0123"), "0123");
    assert_eq!(session_of("plain"), "plain");
}

/// The deed changing hands in the very tick a trim the node cannot read is read in: the trim may have come before it, and
/// the session after it is in doubt, though the node can name none (it has no live session of a table held over a base it
/// cannot read).
#[test]
fn a_handover_in_the_tick_an_unreadable_trim_is_read_in_leaves_the_session_after_it_in_doubt() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let plain = b.page_trim(&b.answer());
    b.put_checkpoint(&plain);
    b.until("compared", |b| counted(b.shadow.tally) > 0);
    b.ticks(5);
    assert_eq!(b.handover_tables(), 0);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.put_checkpoint(&held(&with_cp(&plain, "u", Some(CVal::Int(99)))));
    b.tick();
    assert_eq!(b.shadow.tally.unreadable, 1, "{:?}", b.shadow.tally);
    assert!(b.doubted_sessions().contains(&ANY_SESSION.to_string()), "{:?}", b.doubted_sessions());
}

/// A trim the fold has no answer for still ends the session it names: the doubt of a handover in that session goes with it.
#[test]
fn a_trim_the_fold_has_no_answer_for_ends_the_doubt_of_the_session_it_names() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    // The worker is sent nothing: the table is read, and has no answer.
    b.shadow.sup.clog(QUEUE_BYTES);
    b.ticks(5);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(3);
    let sid = b.live_sid();
    assert_eq!(b.doubted_sessions(), vec![sid], "the session that was live");
    let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
    b.put_checkpoint(&b.page_trim(&sum));
    b.ticks(5);
    assert_eq!(b.shadow.tally, Tally { unanswered: 1, ..Tally::default() });
    assert_eq!(b.handover_tables(), 0, "the session is over, and the doubt with it");
}

/// A doubt does not outlast its session: when the table's base moves to a checkpoint of another one, the session that was
/// live is not, and no checkpoint will name it.
#[test]
fn the_doubt_of_a_session_goes_when_the_table_moves_to_another_session() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(3);
    assert_eq!(b.doubted_sessions().len(), 1);
    let elsewhere = with_cp(&b.page_trim(&b.answer()), "b", Some(s("0123456789abcdef01234567")));
    b.put_checkpoint(&elsewhere);
    b.ticks(5);
    assert_eq!(b.shadow.tally, Tally { parent: 1, ..Tally::default() }, "(a trim of another session)");
    assert_eq!(b.handover_tables(), 0);
}

/// A trim that is not of the session the fold holds (a past one, or one of another session) does not end the doubt of a
/// session the node could not name.
#[test]
fn a_trim_of_another_session_does_not_end_the_doubt_of_a_session_the_node_could_not_name() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let view_before = b.view.clone().unwrap();
    b.crowd_out_the_table(MAX_SHADOW_TABLES);
    b.until("the crowd is answered", |b| b.shadow.counts().results > MAX_SHADOW_TABLES as u64);
    b.ticks(10);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(5);
    assert_eq!(b.doubted_sessions(), vec![ANY_SESSION.to_string()]);
    b.view.as_mut().unwrap().tables = view_before.tables.clone();
    b.sync_pins(&mut pins);
    b.ticks(3);
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.ticks(10);
    b.until("answered", |b| b.caught_up());
    b.ticks(5);
    let elsewhere = with_cp(&b.page_trim(&b.answer()), "b", Some(s("0123456789abcdef01234567")));
    b.put_checkpoint(&elsewhere);
    b.ticks(5);
    assert_eq!(b.shadow.tally.parent, 1, "{:?}", b.shadow.tally);
    assert_eq!(b.doubted_sessions(), vec![ANY_SESSION.to_string()], "it is not the session the node could not name that was trimmed");
}

/// The checkpoints a table was compared with are kept while its room is let go of (the plan went) and followed again: a
/// page that puts one back is not counted a second time.
#[test]
fn what_a_table_was_compared_with_is_kept_while_its_room_is_let_go_of() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let sum = b.answer();
    let (a, other) = (b.page_trim(&sum), b.wrong_trim(&sum));
    b.put_checkpoint(&a);
    b.until("compared", |b| counted(b.shadow.tally) >= 1);
    b.put_checkpoint(&other);
    b.until("the other counted", |b| counted(b.shadow.tally) >= 2);
    b.ticks(5);
    let counted_before = counted(b.shadow.tally);
    assert_eq!(counted_before, 2);
    // The room is let go of, and followed afresh with the second checkpoint in the doc: the table's first.
    let view = b.view.take();
    b.until("let go", |b| b.shadow.rooms.is_empty());
    assert_eq!(b.shadow.remembered[b.room()].compared.values().map(VecDeque::len).sum::<usize>(), 2);
    b.view = view;
    b.until("answered", |b| b.caught_up());
    b.ticks(5);
    assert_eq!(counted(b.shadow.tally), counted_before, "(a first checkpoint is no trim)");
    // ... and the first is put back: it has been counted.
    b.put_checkpoint(&a);
    b.ticks(30);
    assert_eq!(counted(b.shadow.tally), counted_before, "and not counted again");
}

/// A trim the fold has no answer for does not end the doubt of a session the node could not name: it is not known to be
/// the session the fold holds.
#[test]
fn a_trim_the_fold_has_no_answer_for_does_not_end_the_doubt_of_a_session_the_node_could_not_name() {
    let mut b = Bench::new("house craps 3");
    let mut pins = b.watch_pins();
    b.until("the first answer", |b| b.caught_up());
    b.ticks(3);
    let view_before = b.view.clone().unwrap();
    b.crowd_out_the_table(MAX_SHADOW_TABLES);
    b.until("the crowd is answered", |b| b.shadow.counts().results > MAX_SHADOW_TABLES as u64);
    b.ticks(10);
    b.flip_the_deed();
    b.sync_pins(&mut pins);
    b.ticks(5);
    assert_eq!(b.doubted_sessions(), vec![ANY_SESSION.to_string()]);
    // The plan goes back to the one table, and the worker is sent nothing: the table is read, and has no answer.
    b.view.as_mut().unwrap().tables = view_before.tables.clone();
    b.sync_pins(&mut pins);
    b.ticks(3);
    b.shadow.sup.clog(QUEUE_BYTES);
    b.now += GONE_GRACE + Duration::from_secs(1);
    b.ticks(10);
    let key = (b.case.ctx.t.clone(), b.case.ctx.inc.clone());
    assert!(b.shadow.rooms[b.room()].mirror.state(&key.0, &key.1).is_some(), "(read)");
    assert!(b.shadow.rooms[b.room()].feed.fold(&key.0, &key.1).is_none(), "(and unanswered)");
    let sum: FoldSummary = serde_json::from_str(&b.case.summary).unwrap();
    b.put_checkpoint(&b.page_trim(&sum));
    b.ticks(5);
    assert_eq!(b.shadow.tally.unanswered, 1, "{:?}", b.shadow.tally);
    assert_eq!(b.doubted_sessions(), vec![ANY_SESSION.to_string()], "it is not known to be the session the node could not name");
}

/// Houses pinned before a stretch in which the room had no plan (the plan says `gapped`) are taken as delegations that
/// churned: nothing is shown whole from them, as for a delegation seen to be withdrawn.
#[test]
fn the_houses_of_a_plan_that_came_back_after_a_gap_are_not_shown_whole() {
    for gapped in [false, true] {
        let mut b = Bench::new("house craps 3");
        let _pins = b.watch_pins();
        b.until("the first answer", |b| b.caught_up());
        b.view.as_mut().unwrap().gapped = gapped;
        b.ticks(5);
        let rs = &b.shadow.rooms[b.room()];
        assert_eq!(rs.mirror.delegations().churned, gapped, "gapped={gapped}");
        assert_eq!(b.confirmed_count(), (!gapped) as usize, "gapped={gapped}");
    }
}

/// The plan the house hands the shadow carries the gap to the room's shadow: a plan that says it came back after one is
/// not shown whole, however complete it is.
#[test]
fn a_plan_that_says_it_came_back_after_a_gap_is_not_shown_whole() {
    let mut b = Bench::new("house craps 3");
    b.until("the first answer", |b| b.caught_up());
    b.ticks(5);
    let (room, doc, houses) = (b.room().to_string(), b.doc.clone(), b.case.houses.clone());
    let tables = vec![(b.case.ctx.t.clone(), b.case.ctx.inc.clone())];
    let shadow = Mutex::new(b.shadow);
    let go = |gapped: bool| {
        let plan = HousePlan { owner: OWNER.to_string(), owner_key: OWNER_KEY.to_string(), tables: tables.clone(), houses: houses.clone(), complete: true, gapped };
        tick_shadow(&shadow, vec![(room.clone(), doc.clone())], Instant::now(), |_| Some(plan.clone())).unwrap();
    };
    let confirmed = || shadow.lock().unwrap().rooms[&room].confirmed.len();
    for _ in 0..40 {
        go(false);
        thread::sleep(Duration::from_millis(5));
        if confirmed() == 1 {
            break;
        }
    }
    assert_eq!(confirmed(), 1, "a complete plan: shown whole");
    go(true);
    assert_eq!(confirmed(), 0, "one that came back after a gap takes it back");
    assert!(shadow.lock().unwrap().rooms[&room].mirror.delegations().churned);
    for _ in 0..5 {
        go(false);
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(confirmed(), 0, "and the delegations stay churned for good");
}
