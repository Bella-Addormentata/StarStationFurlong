//! The node's fold, in QuickJS, against the pages' (V8): test-vectors/fold-engine-v1.json
//! is written by src/foldEngineVectors.test.ts from the TypeScript source, and
//! this folds every session in it with the checked-in bundle and wants the same
//! bytes. The rest are the engine's own: host functions, limits, dirty tables.

use super::*;
use base64::Engine as _;
use serde_json::Value;
use sha2::Sha512;
use std::cell::Cell;

const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors/fold-engine-v1.json");

struct Case {
    name: String,
    ctx: Ctx,
    cp: Option<CVal>,
    houses: Vec<String>,
    real: bool,
    hold: Vec<String>,
    records: Vec<(String, CVal)>,
    warm: Vec<Vec<(String, Option<CVal>)>>,
    summary: String,
    digest: String,
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

fn cases() -> Vec<Case> {
    let raw = std::fs::read_to_string(VECTORS).unwrap_or_else(|e| panic!("cannot read {VECTORS}: {e}"));
    let file: Value = serde_json::from_str(&raw).expect("vector file is valid JSON");
    assert_eq!(file["version"], 1);
    file["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| Case {
            name: c["name"].as_str().unwrap().to_string(),
            ctx: Ctx { room: c["ctx"]["room"].as_str().unwrap().into(), t: c["ctx"]["t"].as_str().unwrap().into(), inc: c["ctx"]["inc"].as_str().unwrap().into() },
            cp: if c["cp"].is_null() { None } else { Some(CVal::from_json(&c["cp"])) },
            houses: strs(&c["houses"]),
            real: c["sigs"] == "real",
            hold: strs(&c["hold"]),
            records: c["records"].as_array().unwrap().iter().map(|e| (e[0].as_str().unwrap().to_string(), CVal::from_json(&e[1]))).collect(),
            warm: c["warm"]
                .as_array()
                .unwrap()
                .iter()
                .map(|batch| batch.as_array().unwrap().iter().map(|e| (e[0].as_str().unwrap().to_string(), e.get(1).map(CVal::from_json))).collect())
                .collect(),
            summary: c["summary"].as_str().unwrap().to_string(),
            digest: c["digest"].as_str().unwrap().to_string(),
        })
        .collect()
}

/// What the TypeScript test says of each signature of a case (foldEngineVectors.test.ts checkFor).
fn check_for(c: &Case) -> CheckFn {
    let hold = c.hold.clone();
    let real = c.real;
    Box::new(move |hash, kind, pub_key, bytes, sig| {
        if hold.iter().any(|h| h == hash) {
            return None;
        }
        if real || kind == "hreveal" || kind == "hcommit" {
            return Some(hb::verify(pub_key, bytes, sig));
        }
        Some(sig == base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha512::digest(bytes)))
    })
}

fn open(e: &mut FoldEngine, c: &Case) {
    e.open(&c.ctx, c.cp.as_ref(), &c.houses).unwrap_or_else(|err| panic!("{}: open: {err}", c.name));
}

fn sha_hex(text: &str) -> String {
    hex::encode(Sha256::digest(text.as_bytes()))
}

fn ctx_n(n: usize) -> Ctx {
    Ctx { room: "room-fold-test".into(), t: format!("roulette-{n}"), inc: "c0123456789abcdef01234567".into() }
}

fn eval_str(e: &mut FoldEngine, ctx: &Ctx, src: &str) -> Result<String, FoldError> {
    e.call(&key_of(ctx), WARM_BUDGET, |js| js.eval::<String, _>(src))
}

/// An engine with one empty table open.
fn engine_with(ctx: &Ctx) -> FoldEngine {
    let mut e = FoldEngine::new(Box::new(|_, _, _, _, _| Some(true))).unwrap();
    e.open(ctx, None, &[]).unwrap();
    e
}

// ── The two engines agree ───────────────────────────────────────────────────

#[test]
fn every_vector_folds_cold_to_the_pages_bytes() {
    let all = cases();
    assert!(all.len() >= 20, "{} cases", all.len());
    for c in &all {
        let mut e = FoldEngine::new(check_for(c)).unwrap();
        open(&mut e, c);
        e.reset(&c.ctx, &c.records).unwrap_or_else(|err| panic!("{}: reset: {err}", c.name));
        let text = e.result_text(&c.ctx).unwrap_or_else(|err| panic!("{}: result: {err}", c.name));
        assert_eq!(text, c.summary, "{}: summary", c.name);
        let digest = e.digest(&c.ctx).unwrap();
        assert_eq!(sha_hex(&digest), c.digest, "{}: digest", c.name);
        // And the result reads as the shape the node uses.
        let s = e.result(&c.ctx).unwrap_or_else(|err| panic!("{}: parse: {err}", c.name));
        assert_eq!(s.v, 1, "{}", c.name);
        assert_eq!(s.rules.as_deref(), rules_id(&c.ctx.inc), "{}: rules", c.name);
    }
}

#[test]
fn every_vector_folds_warm_to_the_same_bytes() {
    for c in &cases() {
        let mut e = FoldEngine::new(check_for(c)).unwrap();
        open(&mut e, c);
        for batch in &c.warm {
            e.apply(&c.ctx, batch).unwrap_or_else(|err| panic!("{}: apply: {err}", c.name));
            e.result_text(&c.ctx).unwrap_or_else(|err| panic!("{}: result: {err}", c.name));
        }
        assert_eq!(e.result_text(&c.ctx).unwrap(), c.summary, "{}: warm summary", c.name);
        assert_eq!(sha_hex(&e.digest(&c.ctx).unwrap()), c.digest, "{}: warm digest", c.name);
    }
}

/// The value with the fields of every object in the opposite order (a node
/// reads a map out of Yjs in a hash map's order; a page, in wire order).
fn reversed(v: &CVal) -> CVal {
    match v {
        CVal::Arr(a) => CVal::Arr(a.iter().map(reversed).collect()),
        CVal::Obj(f) => CVal::Obj(f.iter().rev().map(|(k, x)| (k.clone(), reversed(x))).collect()),
        other => other.clone(),
    }
}

#[test]
fn the_order_of_a_records_fields_changes_nothing() {
    for c in &cases() {
        let mut e = FoldEngine::new(check_for(c)).unwrap();
        let cp = c.cp.as_ref().map(reversed);
        e.open(&c.ctx, cp.as_ref(), &c.houses).unwrap();
        let flipped: Vec<(String, CVal)> = c.records.iter().map(|(k, v)| (k.clone(), reversed(v))).collect();
        e.reset(&c.ctx, &flipped).unwrap();
        assert_eq!(e.result_text(&c.ctx).unwrap(), c.summary, "{}: summary", c.name);
        assert_eq!(sha_hex(&e.digest(&c.ctx).unwrap()), c.digest, "{}: digest", c.name);
    }
}

#[test]
fn a_session_replaced_folds_as_a_new_one() {
    // reset() over a table that holds other records: what is left is the new session alone.
    let all = cases();
    let (a, b) = (&all[0], &all[3]);
    let mut e = FoldEngine::new(check_for(a)).unwrap();
    open(&mut e, a);
    e.reset(&a.ctx, &a.records).unwrap();
    e.result_text(&a.ctx).unwrap();
    // The same table, another session (the engine's check is a's; b is fake-signed too).
    let mut e2 = FoldEngine::new(check_for(b)).unwrap();
    e2.open(&a.ctx, b.cp.as_ref(), &b.houses).unwrap();
    e2.reset(&a.ctx, &a.records).unwrap();
    e2.reset(&a.ctx, &b.records).unwrap();
    let mut e3 = FoldEngine::new(check_for(b)).unwrap();
    e3.open(&a.ctx, b.cp.as_ref(), &b.houses).unwrap();
    e3.reset(&a.ctx, &b.records).unwrap();
    assert_eq!(e2.result_text(&a.ctx).unwrap(), e3.result_text(&a.ctx).unwrap());
}

#[test]
fn rule_ids_agree_with_the_bundle() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    for letter in ["c", "k", "r", "d", "p", "q", "x", ""] {
        let from_js = eval_str(&mut e, &ctx, &format!("String(SSFFold.rulesFor('{letter}0123'))")).unwrap();
        let from_rust = rules_id(&format!("{letter}0123")).map_or("null".to_string(), str::to_string);
        assert_eq!(from_js, from_rust, "letter {letter:?}");
    }
    assert_eq!(rules_id(""), None);
}

// ── The host functions ──────────────────────────────────────────────────────

#[test]
fn text_encoder_turns_lone_surrogates_into_fffd() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    // 'a', a lone high surrogate, 'b', a pair (U+1F600), a lone low surrogate.
    let hex = eval_str(
        &mut e,
        &ctx,
        "Array.from(new TextEncoder().encode('a\\uD800b\\uD83D\\uDE00\\uDC00')).map(x => (x < 16 ? '0' : '') + x.toString(16)).join('')",
    )
    .unwrap();
    assert_eq!(hex, "61efbfbd62f09f9880efbfbd");
    assert_eq!(eval_str(&mut e, &ctx, "String(new TextEncoder().encode().length)").unwrap(), "0");
    assert_eq!(eval_str(&mut e, &ctx, "new TextEncoder().encoding").unwrap(), "utf-8");
    // Plain text, NUL included (a C string would stop there).
    let nul = eval_str(&mut e, &ctx, "Array.from(new TextEncoder().encode('a\\u0000é')).join(',')").unwrap();
    assert_eq!(nul, "97,0,195,169");
}

#[test]
fn wtf8_reads_like_text_encoder() {
    assert_eq!(wtf8_to_utf8(b"abc"), b"abc");
    assert_eq!(wtf8_to_utf8(&[0xED, 0xA0, 0x80]), [0xEF, 0xBF, 0xBD]); // U+D800
    assert_eq!(wtf8_to_utf8(&[0xED, 0xBF, 0xBF]), [0xEF, 0xBF, 0xBD]); // U+DFFF
    assert_eq!(wtf8_to_utf8(&[0xED, 0x9F, 0xBF]), [0xED, 0x9F, 0xBF]); // U+D7FF stays
    assert_eq!(wtf8_to_utf8(&[0xEE, 0x80, 0x80]), [0xEE, 0x80, 0x80]); // U+E000 stays
    assert_eq!(wtf8_to_utf8("😀é".as_bytes()), "😀é".as_bytes());
}

#[test]
fn sha256_is_the_hosts() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    let hexof = "(a) => Array.from(a).map(x => (x < 16 ? '0' : '') + x.toString(16)).join('')";
    let want = hex::encode(Sha256::digest(b"abc"));
    assert_eq!(eval_str(&mut e, &ctx, &format!("({hexof})(__ssf_sha256('abc'))")).unwrap(), want);
    assert_eq!(eval_str(&mut e, &ctx, &format!("({hexof})(__ssf_sha256(new Uint8Array([97, 98, 99])))")).unwrap(), want);
    // A string with a lone surrogate hashes as its U+FFFD spelling.
    let fffd = hex::encode(Sha256::digest([0xEF, 0xBF, 0xBD]));
    assert_eq!(eval_str(&mut e, &ctx, &format!("({hexof})(__ssf_sha256('\\uD800'))")).unwrap(), fffd);
    // The wrong type is an exception, which makes the table dirty.
    assert!(matches!(eval_str(&mut e, &ctx, "String(__ssf_sha256(5))"), Err(FoldError::Exception(_))));
    assert!(!e.is_open(&ctx));
}

#[test]
fn the_realm_has_only_what_the_host_gave() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    // No crypto, no timers, no network, no module loader: the bundle's lint keeps the bundle off them; this is the host.
    let got = eval_str(
        &mut e,
        &ctx,
        "['crypto', 'setTimeout', 'fetch', 'require', 'process', 'XMLHttpRequest', 'WebSocket', 'localStorage', 'document'].map(n => typeof globalThis[n]).join(',')",
    )
    .unwrap();
    assert_eq!(got, "undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined");
}

#[test]
fn a_signature_is_checked_once_and_a_budget_spreads_the_rest() {
    let all = cases();
    // A fake-signed case with nothing held and many signatures.
    let c = all.iter().find(|c| c.hold.is_empty() && !c.real && c.records.len() >= 25).expect("a big unheld case");
    let calls = Rc::new(Cell::new(0usize));
    let inner = check_for(c);
    let counter = calls.clone();
    let mut inner = inner;
    let mut e = FoldEngine::new(Box::new(move |h, k, p, b, s| {
        counter.set(counter.get() + 1);
        inner(h, k, p, b, s)
    }))
    .unwrap();
    open(&mut e, c);
    e.reset(&c.ctx, &c.records).unwrap();
    assert_eq!(e.result_text(&c.ctx).unwrap(), c.summary);
    let first = calls.get();
    assert!(first > 0);
    // The same records again: every verdict is remembered.
    e.reset(&c.ctx, &c.records).unwrap();
    assert_eq!(e.result_text(&c.ctx).unwrap(), c.summary);
    assert_eq!(calls.get(), first, "a verdict is asked for once");

    // A budget of three a call: the fold is pending until the checks are done, then it is the same fold.
    calls.set(0);
    let counter = calls.clone();
    let mut inner = check_for(c);
    let mut e = FoldEngine::new(Box::new(move |h, k, p, b, s| {
        counter.set(counter.get() + 1);
        inner(h, k, p, b, s)
    }))
    .unwrap();
    e.set_max_new_checks(3);
    open(&mut e, c);
    e.reset(&c.ctx, &c.records).unwrap();
    let mut rounds = 0;
    let text = loop {
        let before = calls.get();
        let text = e.result_text(&c.ctx).unwrap();
        rounds += 1;
        assert!(calls.get() - before <= 3, "{} checks in one call", calls.get() - before);
        if calls.get() == before || rounds > 200 {
            break text;
        }
    };
    assert!(rounds > 2, "the budget never bit ({rounds} calls, {} checks)", calls.get());
    assert_eq!(text, c.summary, "converged on the same fold");
    assert_eq!(calls.get(), first, "no signature is checked twice");
}

// ── Limits, and dirty tables ────────────────────────────────────────────────

#[test]
fn a_loop_that_never_ends_is_interrupted_and_the_table_is_dirty() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    let started = Instant::now();
    let err = e.call(&key_of(&ctx), Duration::from_millis(100), |js| js.eval::<(), _>("for (;;) {}")).unwrap_err();
    assert_eq!(err, FoldError::Interrupted);
    assert!(started.elapsed() < Duration::from_secs(5), "took {:?}", started.elapsed());
    assert!(!e.is_open(&ctx));
    assert_eq!(e.result_text(&ctx).unwrap_err(), FoldError::NoTable);
    assert_eq!(e.apply(&ctx, &[]).unwrap_err(), FoldError::NoTable);
    // Opened again, it folds; and the deadline of the call that failed does not leak into this one.
    e.open(&ctx, None, &[]).unwrap();
    assert_eq!(e.result(&ctx).unwrap().rounds.len(), 0);
}

#[test]
fn a_cold_fold_may_take_longer_than_a_warm_one() {
    assert!(COLD_BUDGET >= WARM_BUDGET * 5);
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    // 300 ms of work: past the warm budget, within the cold one.
    let spin = "const t = Date.now(); while (Date.now() - t < 300) {} 'done'";
    assert_eq!(e.call(&key_of(&ctx), WARM_BUDGET, |js| js.eval::<String, _>(spin)).unwrap_err(), FoldError::Interrupted);
    let mut e = engine_with(&ctx);
    assert_eq!(e.call(&key_of(&ctx), COLD_BUDGET, |js| js.eval::<String, _>(spin)).unwrap(), "done");
}

#[test]
fn memory_past_the_limit_is_an_error_and_the_table_is_dirty() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    e.rt.set_memory_limit(24 << 20);
    let err = e
        .call(&key_of(&ctx), COLD_BUDGET, |js| js.eval::<(), _>("const keep = []; for (;;) keep.push(new Array(100000).fill(1));"))
        .unwrap_err();
    assert!(matches!(err, FoldError::OutOfMemory | FoldError::Exception(_)), "{err:?}");
    assert!(!e.is_open(&ctx));
    // The garbage went with the context: the engine works again at the limit it has.
    assert!(e.rt.memory_usage().malloc_size < (4 << 20), "{} bytes still held", e.rt.memory_usage().malloc_size);
    e.open(&ctx, None, &[]).unwrap();
    assert_eq!(e.result(&ctx).unwrap().bytes, 0);
}

#[test]
fn a_stack_that_runs_out_is_an_error_and_the_table_is_dirty() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    let err = e.call(&key_of(&ctx), COLD_BUDGET, |js| js.eval::<(), _>("function f(n) { return 1 + f(n + 1); } f(0)")).unwrap_err();
    assert!(matches!(err, FoldError::Exception(_)), "{err:?}");
    assert!(!e.is_open(&ctx));
}

#[test]
fn a_thrown_value_that_is_no_error_is_still_dirty() {
    for src in ["throw null", "throw undefined", "throw 5", "throw { toString() { throw 1; } }"] {
        let ctx = ctx_n(0);
        let mut e = engine_with(&ctx);
        assert!(e.call(&key_of(&ctx), WARM_BUDGET, |js| js.eval::<(), _>(src)).is_err(), "{src}");
        assert!(!e.is_open(&ctx), "{src}");
    }
}

#[test]
fn a_result_that_does_not_parse_is_dirty() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    // Make the bundle answer something else.
    e.call(&key_of(&ctx), WARM_BUDGET, |js| js.eval::<(), _>("globalThis.SSFFold = { result: () => '{\"v\":1}' }")).unwrap();
    assert!(matches!(e.result(&ctx), Err(FoldError::BadResult(_))));
    assert!(!e.is_open(&ctx));
}

#[test]
fn a_fold_that_errs_is_dropped_and_the_others_go_on() {
    let all = cases();
    let a = &all[0];
    let other = ctx_n(7);
    let mut e = FoldEngine::new(check_for(a)).unwrap();
    open(&mut e, a);
    e.open(&other, None, &[]).unwrap();
    e.reset(&a.ctx, &a.records).unwrap();
    assert!(e.call(&key_of(&a.ctx), Duration::from_millis(50), |js| js.eval::<(), _>("for (;;) {}")).is_err());
    assert!(!e.is_open(&a.ctx));
    // The other table is untouched, and the one that failed folds again when it is opened again.
    assert!(e.is_open(&other));
    assert!(e.result_text(&other).is_ok());
    open(&mut e, a);
    e.reset(&a.ctx, &a.records).unwrap();
    assert_eq!(e.result_text(&a.ctx).unwrap(), a.summary);
}

#[test]
fn tables_in_an_engine_do_not_see_each_other() {
    let (c0, c1) = (ctx_n(0), ctx_n(1));
    let mut e = FoldEngine::new(Box::new(|_, _, _, _, _| Some(true))).unwrap();
    e.open(&c0, None, &[]).unwrap();
    e.open(&c1, None, &[]).unwrap();
    e.call(&key_of(&c0), WARM_BUDGET, |js| js.eval::<(), _>("globalThis.mine = 1")).unwrap();
    assert_eq!(eval_str(&mut e, &c1, "typeof globalThis.mine").unwrap(), "undefined");
    assert_eq!(eval_str(&mut e, &c0, "typeof globalThis.mine").unwrap(), "number");
}

#[test]
fn only_sixteen_tables_are_kept_the_least_recently_used_goes() {
    let mut e = FoldEngine::new(Box::new(|_, _, _, _, _| Some(true))).unwrap();
    for n in 0..FOLD_TABLES {
        e.open(&ctx_n(n), None, &[]).unwrap();
    }
    assert_eq!(e.slots.len(), FOLD_TABLES);
    // Table 0 is the oldest; touching it makes table 1 the oldest.
    e.result_text(&ctx_n(0)).unwrap();
    e.open(&ctx_n(FOLD_TABLES), None, &[]).unwrap();
    assert_eq!(e.slots.len(), FOLD_TABLES);
    assert!(e.is_open(&ctx_n(0)));
    assert!(!e.is_open(&ctx_n(1)), "the least recently used table is the one that goes");
    assert!(e.is_open(&ctx_n(FOLD_TABLES)));
    assert_eq!(e.result_text(&ctx_n(1)).unwrap_err(), FoldError::NoTable);
    // Opening a table that is open again keeps the count (it is replaced, nothing else is evicted).
    e.open(&ctx_n(2), None, &[]).unwrap();
    assert_eq!(e.slots.len(), FOLD_TABLES);
    assert!(e.is_open(&ctx_n(0)) && e.is_open(&ctx_n(FOLD_TABLES)));
}

#[test]
fn a_table_forgotten_takes_its_verdicts_with_it() {
    let all = cases();
    let c = all.iter().find(|c| c.hold.is_empty() && !c.real && c.records.len() >= 10).unwrap();
    let mut e = FoldEngine::new(check_for(c)).unwrap();
    open(&mut e, c);
    e.reset(&c.ctx, &c.records).unwrap();
    e.result_text(&c.ctx).unwrap();
    assert!(!e.host.borrow().verdicts.is_empty());
    e.forget(&c.ctx);
    assert!(e.host.borrow().verdicts.is_empty());
    // A table that fails loses them too.
    open(&mut e, c);
    e.reset(&c.ctx, &c.records).unwrap();
    e.result_text(&c.ctx).unwrap();
    assert!(e.call(&key_of(&c.ctx), WARM_BUDGET, |js| js.eval::<(), _>("throw 1")).is_err());
    assert!(e.host.borrow().verdicts.is_empty());
}

#[test]
fn memory_is_given_back_when_tables_are_forgotten() {
    let mut e = FoldEngine::new(Box::new(|_, _, _, _, _| Some(true))).unwrap();
    e.rt.run_gc();
    let idle = e.rt.memory_usage().malloc_size;
    for round in 0..3 {
        for n in 0..FOLD_TABLES {
            e.open(&ctx_n(n), None, &[]).unwrap();
        }
        // The first table is as freeable as the others (see `_primer`): a big one, forgotten.
        e.call(&key_of(&ctx_n(0)), COLD_BUDGET, |js| js.eval::<(), _>("globalThis.big = new Array(500000).fill(1)")).unwrap();
        for n in 0..FOLD_TABLES {
            e.forget(&ctx_n(n));
        }
        assert!(e.slots.is_empty(), "round {round}");
        e.rt.run_gc();
        let now = e.rt.memory_usage().malloc_size;
        assert!(now < idle + (1 << 20), "round {round}: {now} bytes held after the tables went, {idle} before");
    }
    // 48 contexts have come and gone under one 64 MiB limit.
    e.open(&ctx_n(0), None, &[]).unwrap();
    assert!(e.result(&ctx_n(0)).is_ok());
}

// ── Values handed to the fold ───────────────────────────────────────────────

#[test]
fn record_values_reach_the_fold_as_a_page_reads_them() {
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    let mut src = |e: &mut FoldEngine, v: &CVal| -> String {
        e.call(&key_of(&ctx), WARM_BUDGET, |js| {
            let v = to_js(js, v)?;
            js.globals().set("x", v)?;
            js.eval::<String, _>(
                "(function () { \
                   const own = (o) => Object.getOwnPropertyNames(o).join(','); \
                   if (x === undefined) return 'undefined'; \
                   if (x === null) return 'null'; \
                   if (typeof x === 'number') return 'number:' + x + ':' + Number.isSafeInteger(x); \
                   if (typeof x === 'string') return 'string:' + x.length; \
                   if (Array.isArray(x)) return 'array:' + x.length + ':' + x.map((y) => y === undefined ? 'u' : y === null ? 'n' : typeof y).join(); \
                   return 'object:' + own(x) + ':' + (Object.getPrototypeOf(x) === Object.prototype); \
                 })()",
            )
        })
        .unwrap()
    };
    assert_eq!(src(&mut e, &CVal::Junk), "null");
    assert_eq!(src(&mut e, &CVal::Undef), "undefined");
    assert_eq!(src(&mut e, &CVal::Int(0)), "number:0:true");
    assert_eq!(src(&mut e, &CVal::Int(-7)), "number:-7:true");
    assert_eq!(src(&mut e, &CVal::Int(2_147_483_647)), "number:2147483647:true");
    assert_eq!(src(&mut e, &CVal::Int(2_147_483_648)), "number:2147483648:true");
    assert_eq!(src(&mut e, &CVal::Int(-2_147_483_649)), "number:-2147483649:true");
    assert_eq!(src(&mut e, &CVal::Int(9_007_199_254_740_991)), "number:9007199254740991:true");
    assert_eq!(src(&mut e, &CVal::Str("héllo 😀".into())), "string:8"); // 7 chars + one astral pair
    assert_eq!(src(&mut e, &CVal::Arr(vec![CVal::Int(1), CVal::Junk, CVal::Undef, CVal::Str("a".into())])), "array:4:number,n,u,string");
    // A plain object, fields in the order given, a `__proto__` one an own field (a page's JSON.parse makes it so).
    let obj = CVal::Obj(vec![
        ("b".into(), CVal::Int(1)),
        ("__proto__".into(), CVal::Obj(vec![("polluted".into(), CVal::Int(1))])),
        ("a".into(), CVal::Undef),
    ]);
    assert_eq!(src(&mut e, &obj), "object:b,__proto__,a:true");
    // And nothing leaked into Object.prototype.
    assert_eq!(eval_str(&mut e, &ctx, "String({}.polluted)").unwrap(), "undefined");
    // A key that is a number, and one that is empty.
    assert_eq!(src(&mut e, &CVal::Obj(vec![("2".into(), CVal::Int(1)), ("".into(), CVal::Int(2)), ("1".into(), CVal::Int(3))])), "object:1,2,:true");
}

#[test]
fn a_string_that_is_not_text_is_junk_from_the_node_not_a_crash() {
    // Rust Strings are UTF-8 already; the node reads a Yjs string that is not UTF-8 as Junk (house_bytes), which the fold sees as null.
    let ctx = ctx_n(0);
    let mut e = engine_with(&ctx);
    e.apply(&ctx, &[("s:1:erin:x".into(), Some(CVal::Junk)), ("s:1:erin:y".into(), None)]).unwrap();
    assert_eq!(e.result(&ctx).unwrap().records, 0);
}
