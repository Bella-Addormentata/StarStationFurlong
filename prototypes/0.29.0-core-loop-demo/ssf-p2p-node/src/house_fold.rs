//! 🧮🦀 The pages' own fold, on the node (PR 6b-1a of "Computed casino tables").
//!
//! The node folds a computed table as every page does: it runs the pages'
//! TypeScript fold itself (`src/computedFold.ts`, bundled with
//! `src/foldEntry.ts` into `fold/fold.min.js`, checked in) in QuickJS-ng,
//! through `rquickjs`. So there is one fold, not a Rust port that drifts; the
//! TypeScript tests of it are the node's tests, and `fold-engine-v1.json`
//! (written by `src/foldEngineVectors.test.ts`) pins that the two engines give
//! the same bytes.
//!
//! This is the ENGINE only: a QuickJS runtime and a JS context for each table
//! it folds (`FOLD_TABLES` of them, least recently used out), the host
//! functions the bundle is given (sha256, TextEncoder, one signature check
//! behind a verdict cache and a budget per call) and the limits (memory,
//! stack, time). It is meant to run in the fold worker, a child process of the
//! node with no keys, no docs and no network (PR 6b-1b); nothing in the node
//! calls it yet. It is behind the `house-fold` cargo feature: a build without
//! it is the PR 5 house, exactly.
//!
//! ANY ERROR MAKES THE TABLE DIRTY. An exception (whose value may be null at
//! a tight memory limit), an interrupt, an out-of-memory, a result that does
//! not parse: the table's context is dropped, and the table is folded again
//! from scratch when the caller opens it again. The engine never answers from
//! a context that failed.
//!
//! Strings: a JS string may hold a lone surrogate (QuickJS keeps it as WTF-8),
//! which Rust's `String` conversions refuse, so the host reads strings that
//! matter (TextEncoder's) as bytes and turns each lone surrogate into U+FFFD,
//! as `TextEncoder.encode` does and as a Yjs reader sees it.

#![cfg(feature = "house-fold")]
// Nothing in the node calls the engine until the worker lands (PR 6b-1b).
#![allow(dead_code)]

use std::cell::RefCell;
use std::collections::HashMap;
use std::fmt;
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use rquickjs::object::Property;
use rquickjs::{Array, CatchResultExt, Context, Ctx as JsCtx, Function, Object, Runtime, TypedArray, Value};
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::house_bytes::{self as hb, CVal, Ctx};

/// The fold, as the pages run it: `src/foldEntry.ts` bundled (`npm run
/// build:fold`; `src/foldBundle.test.ts` fails CI while this file is stale).
const BUNDLE: &str = include_str!("../fold/fold.min.js");

/// Host functions' stand-ins for what QuickJS lacks: TextEncoder through
/// `__ssf_utf8`. (The bundle reaches the host by `__ssf_sha256` and
/// `__ssf_check` only; foldBundle.test.ts pins that.)
const PRELUDE: &str = "globalThis.TextEncoder = class TextEncoder { \
    get encoding() { return 'utf-8'; } \
    encode(s = '') { return __ssf_utf8(String(s)); } };";

/// The rule set each incarnation letter is folded by (`FOLD_RULES_ID` in
/// foldEntry.ts: a test pins that they agree). `None`: a letter this build
/// does not fold.
pub fn rules_id(inc: &str) -> Option<&'static str> {
    match inc.chars().next() {
        Some('c' | 'k') => Some("f1"),
        Some('r' | 'd') => Some("h1"),
        _ => None,
    }
}

/// Memory the whole runtime (every table's context) may use.
pub const MEMORY_LIMIT: usize = 64 << 20;
/// The JS stack.
pub const STACK_LIMIT: usize = 1 << 20;
/// The time a call that only adds to a fold already built may take.
pub const WARM_BUDGET: Duration = Duration::from_millis(200);
/// The time a cold fold (a table opened, or its session replaced) may take.
pub const COLD_BUDGET: Duration = Duration::from_secs(2);
/// Tables with a context at once; the least recently used goes first.
pub const FOLD_TABLES: usize = 16;
/// Signatures one call may check anew; the rest come back "not checked yet"
/// and are checked by the next call.
pub const MAX_NEW_CHECKS: usize = 1_024;
/// Verdicts kept, over all tables (a full cache is emptied: a verdict is
/// only a saved check).
pub const MAX_VERDICTS: usize = 50_000;

/// Why a table went dirty.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FoldError {
    /// The table has no context: never opened, evicted, or dirty since.
    NoTable,
    /// A JS exception (message).
    Exception(String),
    /// The call ran past its time.
    Interrupted,
    /// QuickJS ran out of the memory it may use.
    OutOfMemory,
    /// The result did not parse as the fold's result.
    BadResult(String),
}

impl fmt::Display for FoldError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FoldError::NoTable => write!(f, "no fold for this table"),
            FoldError::Exception(m) => write!(f, "fold exception: {m}"),
            FoldError::Interrupted => write!(f, "fold interrupted"),
            FoldError::OutOfMemory => write!(f, "fold out of memory"),
            FoldError::BadResult(m) => write!(f, "fold result unreadable: {m}"),
        }
    }
}

impl std::error::Error for FoldError {}

/// One signature, asked of the host: the record's hash, its kind, the key
/// that signed it, the bytes it signed and the signature. `None`: not
/// checked yet (the pass is pending). The node's is [`strict_check`].
pub type CheckFn = Box<dyn FnMut(&str, &str, &str, &[u8], &str) -> Option<bool>>;

/// The node's signature check: the pages' strict rule (`hb::verify`).
pub fn strict_check() -> CheckFn {
    Box::new(|_hash, _kind, pub_key, bytes, sig| Some(hb::verify(pub_key, bytes, sig)))
}

/// What the host functions share with the engine.
struct HostState {
    check: CheckFn,
    /// (table's context id, record hash) → verdict.
    verdicts: HashMap<(u64, String), bool>,
    /// The table the running call is for.
    slot: u64,
    /// Signatures checked anew in the running call.
    new_checks: usize,
    max_new_checks: usize,
    /// Host calls made by the running call (tests).
    sha_calls: usize,
    check_calls: usize,
}

thread_local! {
    /// The state the host functions of the call now running on this thread read.
    static HOST: RefCell<Option<Rc<RefCell<HostState>>>> = const { RefCell::new(None) };
}

fn host() -> Rc<RefCell<HostState>> {
    HOST.with(|h| h.borrow().clone()).expect("the fold's host functions run only inside an engine call")
}

/// WTF-8 (what QuickJS hands out for a string with a lone surrogate) to UTF-8
/// as `TextEncoder.encode` does it: each lone surrogate becomes U+FFFD.
/// QuickJS has joined every valid pair, so a three-byte `ED A0..BF xx` left
/// is a lone surrogate.
fn wtf8_to_utf8(b: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == 0xED && i + 2 < b.len() && (0xA0..=0xBF).contains(&b[i + 1]) {
            out.extend_from_slice(&[0xEF, 0xBF, 0xBD]);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

/// The JS string as UTF-8 bytes, lone surrogates as U+FFFD.
fn js_utf8(s: &rquickjs::String) -> rquickjs::Result<Vec<u8>> {
    let cs = s.clone().to_cstring()?;
    // SAFETY: `cs` owns `len` bytes at `as_ptr`, alive for this borrow.
    let raw = unsafe { std::slice::from_raw_parts(cs.as_ptr() as *const u8, cs.len()) };
    Ok(wtf8_to_utf8(raw))
}

/// `__ssf_utf8(string)`: TextEncoder.encode. A COPY into QuickJS's own
/// memory (`TypedArray::new` would hand it the Rust `Vec` as an external
/// buffer, which the memory limit does not count: a fold that keeps encoded
/// strings could outgrow 64 MiB with no out-of-memory).
fn host_utf8<'js>(ctx: JsCtx<'js>, s: rquickjs::String<'js>) -> rquickjs::Result<TypedArray<'js, u8>> {
    TypedArray::new_copy(ctx, js_utf8(&s)?.as_slice())
}

/// `__ssf_sha256(Uint8Array | string)`: the SHA-256 of the bytes (a string's UTF-8).
fn host_sha256<'js>(ctx: JsCtx<'js>, v: Value<'js>) -> rquickjs::Result<TypedArray<'js, u8>> {
    host().borrow_mut().sha_calls += 1;
    let digest = if let Some(ta) = v.as_object().and_then(|o| o.as_typed_array::<u8>()) {
        // SAFETY: no JS runs while the slice is borrowed.
        Sha256::digest(unsafe { ta.as_slice() })
    } else if let Some(s) = v.as_string() {
        Sha256::digest(js_utf8(s)?)
    } else {
        return Err(rquickjs::Error::new_from_js("value", "Uint8Array"));
    };
    TypedArray::new_copy(ctx, digest.as_slice())
}

/// `__ssf_check(hash, kind, pub, bytes, sig)`: a record's signature. `bytes`
/// is a JS function that makes the signed bytes; it is called only when the
/// host has no verdict for `hash` and may check one more. true, false, or
/// undefined (not checked yet).
fn host_check<'js>(
    hash: rquickjs::String<'js>, kind: rquickjs::String<'js>, pub_key: rquickjs::String<'js>, bytes: Function<'js>, sig: rquickjs::String<'js>,
) -> rquickjs::Result<Option<bool>> {
    let state = host();
    state.borrow_mut().check_calls += 1;
    // Strings that are not UTF-8 are no key, hash or signature the pages accept.
    let (Ok(hash), Ok(kind), Ok(pub_key), Ok(sig)) = (hash.to_string(), kind.to_string(), pub_key.to_string(), sig.to_string()) else {
        return Ok(Some(false));
    };
    {
        let s = state.borrow();
        if let Some(v) = s.verdicts.get(&(s.slot, hash.clone())) {
            return Ok(Some(*v));
        }
        if s.new_checks >= s.max_new_checks {
            return Ok(None);
        }
    }
    // JS runs here (the signed bytes are hashed): no borrow is held.
    let made: TypedArray<u8> = bytes.call(())?;
    // SAFETY: no JS runs while the slice is borrowed.
    let signed: Vec<u8> = unsafe { made.as_slice() }.to_vec();
    let mut s = state.borrow_mut();
    let verdict = (s.check)(&hash, &kind, &pub_key, &signed, &sig);
    if let Some(v) = verdict {
        s.new_checks += 1;
        if s.verdicts.len() >= MAX_VERDICTS {
            s.verdicts.clear();
        }
        let slot = s.slot;
        s.verdicts.insert((slot, hash), v);
    }
    Ok(verdict)
}

/// A table's JS context.
struct Slot {
    ctx: Context,
    id: u64,
    used: u64,
    /// Opened or reset, with no result since: the next result is a cold fold.
    cold: bool,
}

/// One table: the room, its id and the incarnation.
type TableKey = (String, String, String);

fn key_of(ctx: &Ctx) -> TableKey {
    (ctx.room.clone(), ctx.t.clone(), ctx.inc.clone())
}

pub struct FoldEngine {
    rt: Runtime,
    /// An empty context, kept for the life of the engine. rquickjs keeps the
    /// prototype of the class its Rust functions are made of, in the FIRST
    /// context that makes one, for the life of the runtime, and with it that
    /// whole context: a table's, if it were the first, would never be freed
    /// (an out-of-memory table's garbage would stay, and every table after it
    /// would meet a runtime already full). So the first to make one is this.
    _primer: Context,
    slots: HashMap<TableKey, Slot>,
    host: Rc<RefCell<HostState>>,
    /// Interrupt deadline, ns after `epoch` (0: none).
    deadline: Arc<AtomicU64>,
    epoch: Instant,
    next_id: u64,
    tick: u64,
}

impl FoldEngine {
    /// An engine whose signatures are checked by `check` (the node's: [`strict_check`]).
    pub fn new(check: CheckFn) -> Result<FoldEngine, FoldError> {
        let rt = Runtime::new().map_err(|e| FoldError::Exception(e.to_string()))?;
        rt.set_memory_limit(MEMORY_LIMIT);
        rt.set_max_stack_size(STACK_LIMIT);
        let deadline = Arc::new(AtomicU64::new(0));
        let epoch = Instant::now();
        let d = deadline.clone();
        rt.set_interrupt_handler(Some(Box::new(move || {
            let at = d.load(Ordering::Relaxed);
            at != 0 && epoch.elapsed().as_nanos() as u64 > at
        })));
        let primer = Context::base(&rt).map_err(|e| FoldError::Exception(e.to_string()))?;
        primer
            .with(|js| rquickjs::Function::new(js.clone(), host_utf8).map(drop))
            .map_err(|e| FoldError::Exception(e.to_string()))?;
        let host = Rc::new(RefCell::new(HostState {
            check,
            verdicts: HashMap::new(),
            slot: 0,
            new_checks: 0,
            max_new_checks: MAX_NEW_CHECKS,
            sha_calls: 0,
            check_calls: 0,
        }));
        Ok(FoldEngine { rt, _primer: primer, slots: HashMap::new(), host, deadline, epoch, next_id: 1, tick: 0 })
    }

    /// Start folding a table: its checkpoint (the value `sum:` holds, or
    /// none), the keys that are the room's houses and the key pinned for each
    /// player, as (pid, key) (trust on first use, as the pages pin: a slip
    /// counts for a felt, and so for `held`, only if it is signed by its
    /// player's pin, and a player with none has no felt). A table already open
    /// is forgotten and folded afresh. Evicts the least recently used table
    /// when `FOLD_TABLES` are open.
    pub fn open(&mut self, ctx: &Ctx, cp: Option<&CVal>, houses: &[String], pins: &[(String, String)]) -> Result<(), FoldError> {
        let key = key_of(ctx);
        self.remove_slot(&key);
        if self.slots.len() >= FOLD_TABLES {
            let oldest = self.slots.iter().min_by_key(|(_, s)| s.used).map(|(k, _)| k.clone());
            if let Some(k) = oldest {
                self.remove_slot(&k);
            }
        }
        // Near the limit a context that was dropped may still be charged (its
        // cycles go with the collector): collect once and try again.
        let context = match Context::full(&self.rt) {
            Ok(c) => c,
            Err(_) => {
                self.rt.run_gc();
                Context::full(&self.rt).map_err(|e| FoldError::Exception(e.to_string()))?
            }
        };
        let id = self.next_id;
        self.next_id += 1;
        self.tick += 1;
        self.slots.insert(key.clone(), Slot { ctx: context, id, used: self.tick, cold: true });
        let (room, t, inc) = (ctx.room.as_str(), ctx.t.as_str(), ctx.inc.as_str());
        self.call(&key, COLD_BUDGET, |js| {
            let g = js.globals();
            g.set("__ssf_utf8", rquickjs::Function::new(js.clone(), host_utf8)?)?;
            g.set("__ssf_sha256", rquickjs::Function::new(js.clone(), host_sha256)?)?;
            g.set("__ssf_check", rquickjs::Function::new(js.clone(), host_check)?)?;
            js.eval::<(), _>(PRELUDE)?;
            js.eval::<(), _>(BUNDLE)?;
            let table = Object::new(js.clone())?;
            table.set("room", room)?;
            table.set("t", t)?;
            table.set("inc", inc)?;
            let cp = match cp {
                Some(v) => to_js(js, v)?,
                None => Value::new_null(js.clone()),
            };
            let keys = Array::new(js.clone())?;
            for (i, h) in houses.iter().enumerate() {
                keys.set(i, h.as_str())?;
            }
            entry(js, "open")?.call::<_, ()>((table, cp, keys, string_pairs(js, pins)?, "host"))
        })
    }

    /// The checkpoint the live session follows changed (none: no checkpoint).
    pub fn set_base(&mut self, ctx: &Ctx, cp: Option<&CVal>) -> Result<(), FoldError> {
        self.call(&key_of(ctx), COLD_BUDGET, |js| {
            let cp = match cp {
                Some(v) => to_js(js, v)?,
                None => Value::new_null(js.clone()),
            };
            entry(js, "setBase")?.call::<_, ()>((cp,))
        })?;
        self.mark_cold(ctx);
        Ok(())
    }

    /// The room's houses changed.
    pub fn set_houses(&mut self, ctx: &Ctx, houses: &[String]) -> Result<(), FoldError> {
        self.call(&key_of(ctx), WARM_BUDGET, |js| {
            let keys = Array::new(js.clone())?;
            for (i, h) in houses.iter().enumerate() {
                keys.set(i, h.as_str())?;
            }
            entry(js, "setHouses")?.call::<_, ()>((keys,))
        })
    }

    /// The keys pinned for the players changed (one showed up): all of them, as (pid, key).
    pub fn set_pins(&mut self, ctx: &Ctx, pins: &[(String, String)]) -> Result<(), FoldError> {
        self.call(&key_of(ctx), WARM_BUDGET, |js| entry(js, "setPins")?.call::<_, ()>((string_pairs(js, pins)?,)))
    }

    /// Replace the whole live session with these records.
    pub fn reset(&mut self, ctx: &Ctx, records: &[(String, CVal)]) -> Result<(), FoldError> {
        self.call(&key_of(ctx), COLD_BUDGET, |js| {
            let list = pairs(js, records.iter().map(|(k, v)| (k.as_str(), Some(v))))?;
            entry(js, "reset")?.call::<_, ()>((list,))
        })?;
        self.mark_cold(ctx);
        Ok(())
    }

    /// Records of the live session changed: a value of `None` is a deletion.
    pub fn apply(&mut self, ctx: &Ctx, changes: &[(String, Option<CVal>)]) -> Result<(), FoldError> {
        self.call(&key_of(ctx), WARM_BUDGET, |js| {
            let list = pairs(js, changes.iter().map(|(k, v)| (k.as_str(), v.as_ref())))?;
            entry(js, "apply")?.call::<_, ()>((list,))
        })
    }

    /// The fold's answer for the table, as it stands.
    pub fn result(&mut self, ctx: &Ctx) -> Result<FoldSummary, FoldError> {
        let text = self.result_text(ctx)?;
        serde_json::from_str(&text).map_err(|e| {
            self.remove_slot(&key_of(ctx));
            FoldError::BadResult(e.to_string())
        })
    }

    /// The same, as the JSON text the bundle made.
    pub fn result_text(&mut self, ctx: &Ctx) -> Result<String, FoldError> {
        let key = key_of(ctx);
        let budget = match self.slots.get(&key) {
            Some(s) if s.cold => COLD_BUDGET,
            _ => WARM_BUDGET,
        };
        let text = self.call(&key, budget, |js| entry(js, "result")?.call::<_, String>(()))?;
        if let Some(s) = self.slots.get_mut(&key) {
            s.cold = false;
        }
        Ok(text)
    }

    /// Every field of the last result as one string (the parity tests'; the node never asks).
    pub fn digest(&mut self, ctx: &Ctx) -> Result<String, FoldError> {
        self.call(&key_of(ctx), WARM_BUDGET, |js| entry(js, "digest")?.call::<_, String>(()))
    }

    /// Forget a table.
    pub fn forget(&mut self, ctx: &Ctx) {
        self.remove_slot(&key_of(ctx));
    }

    /// Whether the table has a context to fold in.
    pub fn is_open(&self, ctx: &Ctx) -> bool {
        self.slots.contains_key(&key_of(ctx))
    }

    /// How many signatures one call may check anew (tests lower it).
    pub fn set_max_new_checks(&mut self, n: usize) {
        self.host.borrow_mut().max_new_checks = n;
    }

    /// Host calls made so far: (sha256, check).
    pub fn host_calls(&self) -> (usize, usize) {
        let h = self.host.borrow();
        (h.sha_calls, h.check_calls)
    }

    fn mark_cold(&mut self, ctx: &Ctx) {
        if let Some(s) = self.slots.get_mut(&key_of(ctx)) {
            s.cold = true;
        }
    }

    /// Run `f` in the table's context within `budget`. Any failure drops the
    /// context: the table is dirty until it is opened again.
    fn call<R>(&mut self, key: &TableKey, budget: Duration, f: impl FnOnce(&JsCtx<'_>) -> rquickjs::Result<R>) -> Result<R, FoldError> {
        self.tick += 1;
        let tick = self.tick;
        let Some(slot) = self.slots.get_mut(key) else { return Err(FoldError::NoTable) };
        slot.used = tick;
        {
            let mut h = self.host.borrow_mut();
            h.slot = slot.id;
            h.new_checks = 0;
        }
        HOST.with(|h| *h.borrow_mut() = Some(self.host.clone()));
        self.deadline.store(self.epoch.elapsed().as_nanos() as u64 + budget.as_nanos() as u64, Ordering::Relaxed);
        let out = slot.ctx.with(|js| f(&js).catch(&js).map_err(|e| classify(&e.to_string())));
        self.deadline.store(0, Ordering::Relaxed);
        HOST.with(|h| *h.borrow_mut() = None);
        if out.is_err() {
            self.remove_slot(key);
        }
        out
    }

    /// Drop a table's context and the verdicts kept for it, and collect: a
    /// context is a cycle (its host functions hold it), which only the
    /// collector frees, and the next one must not meet a runtime still charged
    /// for this. (A table's replacement, an eviction, a forgotten table, a
    /// failed call and a result that would not parse all come through here.)
    fn remove_slot(&mut self, key: &TableKey) {
        if let Some(slot) = self.slots.remove(key) {
            self.host.borrow_mut().verdicts.retain(|(id, _), _| *id != slot.id);
            drop(slot);
            self.rt.run_gc();
        }
    }
}

/// What a caught JS error was.
fn classify(message: &str) -> FoldError {
    let lower = message.to_lowercase();
    if lower.contains("interrupted") {
        FoldError::Interrupted
    } else if lower.contains("out of memory") {
        FoldError::OutOfMemory
    } else {
        FoldError::Exception(message.to_string())
    }
}

/// A function the bundle exports.
fn entry<'js>(js: &JsCtx<'js>, name: &str) -> rquickjs::Result<Function<'js>> {
    let ssf: Object = js.globals().get("SSFFold")?;
    ssf.get(name)
}

/// [[a, b], …] of strings.
fn string_pairs<'js>(js: &JsCtx<'js>, items: &[(String, String)]) -> rquickjs::Result<Array<'js>> {
    let list = Array::new(js.clone())?;
    for (i, (a, b)) in items.iter().enumerate() {
        let pair = Array::new(js.clone())?;
        pair.set(0, a.as_str())?;
        pair.set(1, b.as_str())?;
        list.set(i, pair)?;
    }
    Ok(list)
}

/// [[key, value], …] for the fold: a `None` value is `undefined` (a deletion).
fn pairs<'a, 'js>(js: &JsCtx<'js>, items: impl Iterator<Item = (&'a str, Option<&'a CVal>)>) -> rquickjs::Result<Array<'js>> {
    let list = Array::new(js.clone())?;
    for (i, (key, value)) in items.enumerate() {
        let pair = Array::new(js.clone())?;
        pair.set(0, key)?;
        pair.set(1, match value {
            Some(v) => to_js(js, v)?,
            None => Value::new_undefined(js.clone()),
        })?;
        list.set(i, pair)?;
    }
    Ok(list)
}

/// A record value as a page's fold is handed it: a string, a safe integer,
/// an array, a plain object (own data properties in the order given, even one
/// named `__proto__`), `undefined`; and `Junk` (a float, a boolean, null, a
/// bigint, a buffer, a nested Yjs type, a string that is not UTF-8) as `null`,
/// which canon refuses as it refuses each of them, so the record is junk
/// there as it is on a page.
fn to_js<'js>(js: &JsCtx<'js>, v: &CVal) -> rquickjs::Result<Value<'js>> {
    Ok(match v {
        CVal::Str(s) => rquickjs::String::from_str(js.clone(), s)?.into_value(),
        CVal::Int(i) => {
            if let Ok(small) = i32::try_from(*i) {
                Value::new_int(js.clone(), small)
            } else {
                Value::new_float(js.clone(), *i as f64)
            }
        }
        CVal::Arr(a) => {
            let arr = Array::new(js.clone())?;
            for (i, x) in a.iter().enumerate() {
                arr.set(i, to_js(js, x)?)?;
            }
            arr.into_value()
        }
        CVal::Obj(fields) => {
            let obj = Object::new(js.clone())?;
            for (k, x) in fields {
                obj.prop(k.as_str(), Property::from(to_js(js, x)?).writable().enumerable().configurable())?;
            }
            obj.into_value()
        }
        CVal::Undef => Value::new_undefined(js.clone()),
        CVal::Junk => Value::new_null(js.clone()),
    })
}

// ── The result ──────────────────────────────────────────────────────────────

/// What the bundle's `result()` says of a table (foldEntry.ts `result`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct FoldSummary {
    pub v: i64,
    /// The rule set the table was folded by ([`rules_id`]).
    pub rules: Option<String>,
    pub base: BaseSummary,
    pub rounds: Vec<RoundSummary>,
    /// The round of the undecided chosen close, if any.
    pub tip: Option<i64>,
    pub open: i64,
    pub parent: String,
    #[serde(rename = "houseTable")]
    pub house_table: bool,
    /// The house commitment a close of the open round must name.
    pub required: Option<String>,
    pub joins: Vec<String>,
    /// pid → net, decimal, sorted by pid.
    pub nets: Vec<(String, String)>,
    pub held: Vec<(String, String)>,
    /// The game's carried state after the last decided round (null at roulette).
    pub carry: serde_json::Value,
    pub pending: bool,
    pub records: i64,
    pub bytes: i64,
    #[serde(rename = "rawBytes")]
    pub raw_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct BaseSummary {
    pub sid: String,
    pub u: i64,
    pub l: Option<String>,
    pub n: Vec<(String, String)>,
    pub ended: bool,
    pub h: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RoundSummary {
    pub r: i64,
    pub close: String,
    /// "reveals", "forfeit", "house" or "void"; null while undecided.
    pub decided: Option<String>,
    pub counted: Vec<String>,
    pub pocket: Option<i64>,
    pub deltas: Vec<(String, String)>,
    pub house: Option<String>,
    pub forfeit: Option<String>,
    pub abandon: Option<String>,
    pub copies: Option<Vec<String>>,
    pub dice: Option<[i64; 2]>,
}

#[cfg(test)]
pub(crate) mod tests;
