//! The worker: frames in, frames out, the pages' bytes in the answers, and a
//! table the worker cannot fold (or a worker that panics) costs the table and
//! nothing else.

use super::*;
use crate::fold_wire::{encode_req, encode_resp, MAX_CTX_FIELD, MAX_FRAME};
use crate::house_fold::tests::{cases, check_for, Case};
use crate::house_fold::FOLD_TABLES;
use std::io::Cursor;

fn engine_for(c: &Case) -> EngineFolder {
    let c = c.clone();
    EngineFolder::new(Box::new(move || check_for(&c))).expect("the engine starts")
}

/// Serve these requests and read the answers.
fn run<F: Folder>(f: &mut F, reqs: &[Req]) -> Vec<Resp> {
    let mut input = vec![];
    for r in reqs {
        input.extend(encode_req(r).unwrap());
    }
    let mut output = vec![];
    serve(&mut Cursor::new(input), &mut output, f).expect("serve ends at the end of the input");
    let mut pipe = Cursor::new(output);
    let mut got = vec![];
    while let Some(body) = read_frame(&mut pipe).unwrap() {
        got.push(decode_resp(&body).unwrap());
    }
    got
}

use crate::fold_wire::decode_resp;

fn cold(c: &Case, version: u64) -> Req {
    Req::Cold(Cold { ctx: c.ctx.clone(), version, base: c.cp.clone(), houses: c.houses.clone(), pins: c.pins.clone(), records: c.records.clone() })
}

fn text(r: &Resp) -> &str {
    match r {
        Resp::Result { text, .. } => text,
        other => panic!("not a result: {other:?}"),
    }
}

// ── The pages' bytes, through the wire ──────────────────────────────────────

#[test]
fn every_vector_folded_cold_through_the_wire_gives_the_pages_bytes() {
    let all = cases();
    assert!(all.len() >= 20);
    for c in &all {
        let got = run(&mut engine_for(c), &[cold(c, 41)]);
        assert_eq!(got.len(), 1, "{}", c.name);
        assert_eq!(got[0].version(), 41, "{}: the version comes back", c.name);
        assert_eq!(got[0].ctx(), &c.ctx, "{}: and the table", c.name);
        assert_eq!(text(&got[0]), c.summary, "{}: cold summary", c.name);
    }
}

#[test]
fn every_vector_folded_warm_through_the_wire_gives_the_pages_bytes() {
    for c in &cases() {
        let mut reqs = vec![Req::Cold(Cold { ctx: c.ctx.clone(), version: 1, base: c.cp.clone(), houses: c.houses.clone(), pins: c.pins.clone(), records: vec![] })];
        for (i, batch) in c.warm.iter().enumerate() {
            reqs.push(Req::Warm(Warm { ctx: c.ctx.clone(), version: 2 + i as u64, houses: c.houses.clone(), pins: c.pins.clone(), changes: batch.clone() }));
        }
        let got = run(&mut engine_for(c), &reqs);
        assert_eq!(got.len(), reqs.len(), "{}: one answer for each", c.name);
        for (i, g) in got.iter().enumerate() {
            assert_eq!(g.version(), 1 + i as u64, "{}: in order", c.name);
        }
        assert_eq!(text(got.last().unwrap()), c.summary, "{}: warm summary", c.name);
    }
}

#[test]
fn a_cold_read_split_over_frames_folds_as_one() {
    // The node reads a big session over several ticks: a Cold with the first of
    // the records and Warms with the rest.
    for c in &cases() {
        let half = c.records.len() / 2;
        let first = Req::Cold(Cold { ctx: c.ctx.clone(), version: 1, base: c.cp.clone(), houses: c.houses.clone(), pins: c.pins.clone(), records: c.records[..half].to_vec() });
        let rest = Req::Warm(Warm { ctx: c.ctx.clone(), version: 2, houses: c.houses.clone(), pins: c.pins.clone(), changes: c.records[half..].iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect() });
        let got = run(&mut engine_for(c), &[first, rest]);
        assert_eq!(text(&got[1]), c.summary, "{}", c.name);
    }
}

#[test]
fn houses_and_pins_given_with_a_warm_are_applied() {
    // A table opened with no houses, then told who they are: the house-run
    // round that needed them decides as the pages decide it.
    let all = cases();
    let c = all.iter().find(|c| c.name.starts_with("real signatures")).expect("the real-signature case");
    assert!(!c.houses.is_empty());
    let open = Req::Cold(Cold { ctx: c.ctx.clone(), version: 1, base: c.cp.clone(), houses: vec![], pins: vec![], records: vec![] });
    let told = Req::Warm(Warm { ctx: c.ctx.clone(), version: 2, houses: c.houses.clone(), pins: c.pins.clone(), changes: c.records.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect() });
    let got = run(&mut engine_for(c), &[open, told]);
    assert_eq!(text(&got[1]), c.summary);
    // And the same records without the houses do not give that result.
    let open = Req::Cold(Cold { ctx: c.ctx.clone(), version: 1, base: c.cp.clone(), houses: vec![], pins: vec![], records: c.records.clone() });
    let got = run(&mut engine_for(c), &[open]);
    assert_ne!(text(&got[0]), c.summary, "the houses matter to this case, or the test proves nothing");
}

// ── A table the worker cannot fold ──────────────────────────────────────────

#[test]
fn a_warm_for_a_table_the_worker_does_not_hold_is_dirty_and_a_cold_mends_it() {
    let all = cases();
    let c = &all[0];
    let warm = Req::Warm(Warm { ctx: c.ctx.clone(), version: 5, houses: c.houses.clone(), pins: c.pins.clone(), changes: vec![] });
    let got = run(&mut engine_for(c), &[warm.clone(), cold(c, 6), warm]);
    assert!(matches!(&got[0], Resp::Dirty { version: 5, .. }), "{:?}", got[0]);
    assert_eq!(text(&got[1]), c.summary);
    assert!(matches!(&got[2], Resp::Result { version: 5, .. }));
}

#[test]
fn a_forgotten_table_is_gone_and_a_forget_has_no_answer() {
    let all = cases();
    let c = &all[0];
    let warm = Req::Warm(Warm { ctx: c.ctx.clone(), version: 3, houses: c.houses.clone(), pins: c.pins.clone(), changes: vec![] });
    let got = run(&mut engine_for(c), &[cold(c, 1), Req::Forget { ctx: c.ctx.clone() }, warm]);
    assert_eq!(got.len(), 2, "the Cold and the Warm are answered, the Forget is not");
    assert!(matches!(&got[1], Resp::Dirty { version: 3, .. }));
}

#[test]
fn a_table_the_engine_let_go_to_make_room_is_dirty_for_the_node_to_send_again() {
    let all = cases();
    let c = &all[0];
    let mut reqs = vec![];
    for n in 0..=FOLD_TABLES {
        let mut ctx = c.ctx.clone();
        ctx.t = format!("table-{n}");
        reqs.push(Req::Cold(Cold { ctx, version: n as u64, base: c.cp.clone(), houses: c.houses.clone(), pins: c.pins.clone(), records: vec![] }));
    }
    // The first table is the least recently used one, and is out.
    let mut first = c.ctx.clone();
    first.t = "table-0".into();
    reqs.push(Req::Warm(Warm { ctx: first.clone(), version: 99, houses: c.houses.clone(), pins: c.pins.clone(), changes: vec![] }));
    let mut last = c.ctx.clone();
    last.t = format!("table-{FOLD_TABLES}");
    reqs.push(Req::Warm(Warm { ctx: last, version: 100, houses: c.houses.clone(), pins: c.pins.clone(), changes: vec![] }));
    let got = run(&mut engine_for(c), &reqs);
    let n = got.len();
    assert!(matches!(&got[n - 2], Resp::Dirty { version: 99, .. }), "{:?}", got[n - 2]);
    assert!(matches!(&got[n - 1], Resp::Result { version: 100, .. }), "{:?}", got[n - 1]);
}

#[test]
fn a_panic_inside_the_real_engine_is_a_dirty_table_and_then_a_fresh_engine() {
    // The signature check is called by the fold, through QuickJS; a panic there
    // crosses the engine's C frames and is caught at the worker's loop.
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    let all = cases();
    let c = all.iter().find(|c| c.name.starts_with("real signatures")).expect("the real-signature case").clone();
    let panic_once = Arc::new(AtomicBool::new(true));
    let mut f = {
        let (flag, c) = (panic_once.clone(), c.clone());
        EngineFolder::new(Box::new(move || {
            let (flag, inner) = (flag.clone(), check_for(&c));
            let mut inner = inner;
            Box::new(move |h: &str, k: &str, p: &str, b: &[u8], s: &str| {
                if flag.swap(false, Ordering::SeqCst) {
                    panic!("the check fell over");
                }
                inner(h, k, p, b, s)
            })
        }))
        .unwrap()
    };
    let mut other = c.clone();
    other.ctx.t = "an-empty-neighbour".into();
    other.records = vec![];
    let got = run(&mut f, &[cold(&c, 1), cold(&other, 2), cold(&c, 3)]);
    match &got[0] {
        Resp::Dirty { version: 1, reason, .. } => assert!(reason.contains("the check fell over"), "{reason}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(&got[1], Resp::Result { version: 2, .. }), "{:?}", got[1]);
    assert_eq!(text(&got[2]), c.summary, "the fresh engine folds it as the pages do");
}

// ── The loop ────────────────────────────────────────────────────────────────

/// A folder that counts, answers `ok:<n>`, and panics for a table called "boom".
struct Stub {
    asked: usize,
    recovered: usize,
    can_recover: bool,
    forgotten: Vec<String>,
}

impl Stub {
    fn new() -> Stub {
        Stub { asked: 0, recovered: 0, can_recover: true, forgotten: vec![] }
    }
}

impl Folder for Stub {
    fn cold(&mut self, c: &Cold) -> Result<String, String> {
        self.asked += 1;
        match c.ctx.t.as_str() {
            "boom" => panic!("the fold fell over"),
            "huge" => Ok("x".repeat(MAX_FRAME)),
            "sick" => Err("sick".into()),
            "wordy" => Err("€".repeat(2_000)),
            _ => Ok(format!("ok:{}", self.asked)),
        }
    }
    fn warm(&mut self, w: &Warm) -> Result<String, String> {
        self.asked += 1;
        if w.ctx.t == "boom" {
            std::panic::panic_any(String::from("a String panic"));
        }
        Ok(format!("ok:{}", self.asked))
    }
    fn forget(&mut self, ctx: &Ctx) {
        if ctx.t == "boom" {
            panic!("forget fell over");
        }
        self.forgotten.push(ctx.t.clone());
    }
    fn recover(&mut self) -> bool {
        self.recovered += 1;
        self.can_recover
    }
}

fn ctx(t: &str) -> Ctx {
    Ctx { room: "room".into(), t: t.into(), inc: "c0123456789abcdef01234567".into() }
}

fn cold_of(t: &str, version: u64) -> Req {
    Req::Cold(Cold { ctx: ctx(t), version, base: None, houses: vec![], pins: vec![], records: vec![] })
}

fn warm_of(t: &str, version: u64) -> Req {
    Req::Warm(Warm { ctx: ctx(t), version, houses: vec![], pins: vec![], changes: vec![] })
}

#[test]
fn the_node_closing_the_pipe_ends_the_worker_cleanly() {
    let mut f = Stub::new();
    assert_eq!(run(&mut f, &[]), vec![]);
    assert_eq!(f.asked, 0);
}

#[test]
fn each_cold_and_warm_gets_one_answer_in_order() {
    let mut f = Stub::new();
    let got = run(&mut f, &[cold_of("a", 1), warm_of("a", 2), cold_of("b", 3), Req::Forget { ctx: ctx("a") }, warm_of("b", 4)]);
    let seen: Vec<(String, u64)> = got.iter().map(|g| (g.ctx().t.clone(), g.version())).collect();
    assert_eq!(seen, vec![("a".to_string(), 1), ("a".to_string(), 2), ("b".to_string(), 3), ("b".to_string(), 4)]);
    assert_eq!(f.forgotten, vec!["a"]);
}

#[test]
fn a_folder_that_says_no_makes_the_table_dirty_with_its_reason() {
    let got = run(&mut Stub::new(), &[cold_of("sick", 8)]);
    assert_eq!(got, vec![Resp::Dirty { ctx: ctx("sick"), version: 8, reason: "sick".into() }]);
}

#[test]
fn a_panic_makes_the_table_dirty_and_the_worker_starts_over() {
    let mut f = Stub::new();
    let got = run(&mut f, &[cold_of("a", 1), cold_of("boom", 2), warm_of("boom", 3), cold_of("a", 4)]);
    assert!(matches!(&got[0], Resp::Result { version: 1, .. }));
    match &got[1] {
        Resp::Dirty { version: 2, reason, .. } => assert!(reason.contains("the fold fell over"), "{reason}"),
        other => panic!("{other:?}"),
    }
    match &got[2] {
        Resp::Dirty { version: 3, reason, .. } => assert!(reason.contains("a String panic"), "{reason}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(&got[3], Resp::Result { version: 4, .. }), "and the worker goes on");
    assert_eq!(f.recovered, 2);
}

#[test]
fn a_panic_while_forgetting_starts_over_too() {
    let mut f = Stub::new();
    let got = run(&mut f, &[Req::Forget { ctx: ctx("boom") }, cold_of("a", 1)]);
    assert_eq!(got.len(), 1);
    assert_eq!(f.recovered, 1);
}

#[test]
fn a_worker_that_cannot_start_over_after_a_panic_ends() {
    let mut f = Stub::new();
    f.can_recover = false;
    let mut input = vec![];
    input.extend(encode_req(&cold_of("boom", 1)).unwrap());
    input.extend(encode_req(&cold_of("a", 2)).unwrap());
    let mut output = vec![];
    let e = serve(&mut Cursor::new(input), &mut output, &mut f).unwrap_err();
    assert!(e.to_string().contains("cannot start its engine again"), "{e}");
    assert!(output.is_empty(), "nothing is answered from an engine that is gone");
    assert_eq!(f.asked, 1, "and the next request is not read");
}

#[test]
fn a_result_too_big_for_a_frame_is_dirty_not_a_dead_worker() {
    let mut f = Stub::new();
    let got = run(&mut f, &[cold_of("huge", 1), cold_of("a", 2)]);
    assert_eq!(f.forgotten, vec!["huge"], "and the table is dropped: Dirty means no context is held");
    match &got[0] {
        Resp::Dirty { version: 1, reason, .. } => assert!(reason.contains("too big for a frame"), "{reason}"),
        other => panic!("{other:?}"),
    }
    assert!(matches!(&got[1], Resp::Result { version: 2, .. }));
}

#[test]
fn a_long_reason_is_cut_at_a_character_so_a_dirty_answer_stays_small() {
    let got = run(&mut Stub::new(), &[cold_of("wordy", 1)]);
    match &got[0] {
        Resp::Dirty { reason, .. } => {
            // 1,024 bytes would end inside a euro sign: back to the one before, and the mark.
            assert_eq!(reason.len(), 1_023 + '…'.len_utf8(), "{} bytes", reason.len());
            assert!(reason.starts_with("€€€") && reason.ends_with('…'));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn the_largest_dirty_answer_is_a_few_kib_so_it_always_fits_a_frame() {
    let c = Ctx { room: "r".repeat(MAX_CTX_FIELD), t: "t".repeat(MAX_CTX_FIELD), inc: "i".repeat(MAX_CTX_FIELD) };
    let reason = short_reason("x".repeat(1 << 20));
    let frame = encode_resp(&Resp::Dirty { ctx: c, version: u64::MAX, reason }).unwrap();
    assert!(frame.len() < 16 << 10, "{} bytes", frame.len());
}

#[test]
fn what_is_not_a_frame_ends_the_worker_with_an_error() {
    let mut f = Stub::new();
    for bad in [
        vec![0, 0, 0, 0],                                       // a frame of no bytes
        vec![2, 0, 0, 0, 0xee, 0],                              // a tag that names nothing
        vec![1, 0, 0, 0, 0x81],                                 // an answer, sent to the worker
        vec![9, 0, 0, 0, 3, 0, 0, 0],                           // cut inside the body
        vec![0xff, 0xff, 0xff, 0xff],                           // past the limit
    ] {
        let mut output = vec![];
        assert!(serve(&mut Cursor::new(bad.clone()), &mut output, &mut f).is_err(), "{bad:?}");
        assert!(output.is_empty());
    }
    assert_eq!(f.asked, 0);
}

#[test]
fn a_frame_that_leaves_bytes_over_is_refused() {
    let mut frame = encode_req(&Req::Forget { ctx: ctx("a") }).unwrap();
    frame.push(0);
    frame[0] += 1;
    let mut output = vec![];
    assert!(serve(&mut Cursor::new(frame), &mut output, &mut Stub::new()).is_err());
}

#[test]
fn a_write_that_fails_ends_the_worker_with_an_error() {
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let input = encode_req(&cold_of("a", 1)).unwrap();
    let e = serve(&mut Cursor::new(input), &mut Broken, &mut Stub::new()).unwrap_err();
    assert_eq!(e.kind(), io::ErrorKind::BrokenPipe);
}

#[test]
fn the_worker_argument_is_the_second_word_of_the_command() {
    // The test harness is started with other words, so it is not a worker.
    assert!(!is_worker_invocation());
    assert_eq!(WORKER_ARG, "--fold-worker");
}

#[test]
fn what_was_given_for_a_table_the_engine_let_go_is_let_go_too() {
    let all = cases();
    let c = &all[0];
    let mut f = engine_for(c);
    for n in 0..FOLD_TABLES + 9 {
        let mut ctx = c.ctx.clone();
        ctx.t = format!("table-{n}");
        let r = f.cold(&Cold { ctx, version: n as u64, base: c.cp.clone(), houses: c.houses.clone(), pins: c.pins.clone(), records: vec![] });
        assert!(r.is_ok());
        assert!(f.given.len() <= FOLD_TABLES, "{} remembered after {} tables", f.given.len(), n + 1);
    }
    assert_eq!(f.given.len(), FOLD_TABLES);
    // And a table that failed to open, having put another out, is not remembered either.
    let mut bad = c.ctx.clone();
    bad.t = "bad".into();
    bad.inc = "z-not-an-incarnation".into();
    let _ = f.cold(&Cold { ctx: bad.clone(), version: 1, base: None, houses: vec![], pins: vec![], records: vec![] });
    assert!(f.given.len() <= FOLD_TABLES);
    assert!(!f.given.contains_key(&key(&bad)) || f.engine.is_open(&bad));
}

#[test]
fn after_a_panic_the_real_engine_is_new_and_holds_no_tables() {
    let all = cases();
    let c = &all[0];
    let mut f = engine_for(c);
    assert!(f.cold(&Cold { ctx: c.ctx.clone(), version: 1, base: c.cp.clone(), houses: c.houses.clone(), pins: c.pins.clone(), records: c.records.clone() }).is_ok());
    assert!(f.recover());
    let warm = Warm { ctx: c.ctx.clone(), version: 2, houses: c.houses.clone(), pins: c.pins.clone(), changes: vec![] };
    assert!(f.warm(&warm).is_err(), "the table went with the old engine");
    assert!(f.cold(&Cold { ctx: c.ctx.clone(), version: 3, base: c.cp.clone(), houses: c.houses.clone(), pins: c.pins.clone(), records: c.records.clone() }).is_ok());
}
