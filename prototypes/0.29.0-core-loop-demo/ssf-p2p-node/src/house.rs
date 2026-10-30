//! 🏠 The house (PR 5 of "Computed casino tables"): this node, as its
//! owner's house, adds a seed of its own to each round of the owner's
//! players' tables, and reveals it last, so nobody at a table (a bettor alone
//! there included) knows a result before it is decided.
//!
//! Every [`TICK_MS`] the node's loop (main.rs `house_loop`) hands [`House`]
//! each room it serves. A room counts only once it holds a delegation of this
//! house's key (`hk:<pub>`) signed by the room's deed holder; in it, for each
//! players' table of the house kinds (`r…` roulette, `d…` craps:
//! computedFold houseRules) whose switch is on, the house:
//!
//! 1. **joins** a round that asks for no commitment, writing its commitment
//!    for it (`o:<r>:<h>`), unless it already has one for that round (its
//!    reveal of the round before carried it, or the checkpoint does), or has
//!    revealed that round or a later one;
//! 2. **watches** each close naming its commitment (signature checked, its
//!    signer one of the slips it froze, its parent a close of the round
//!    before or the session itself; after a round it revealed, the close it
//!    decided there), noting when it first saw it on its own clock, and when
//!    it first saw each frozen bettor's seed;
//! 3. **reveals** (`h:<r>:<h>`) once every seed of the best-ranked such close
//!    is in, or once the grace has run out (the pages' forfeit grace:
//!    computedTable graceOf): its seed, that close alone (a rival listed too
//!    would show a bettor both results, to carry on the one they liked), the
//!    slips of it whose seeds it saw first, and the commitment the next round
//!    must name. Records under its key count as its own only as it signed
//!    them.
//!    Never twice for a round (the highest round revealed is written to
//!    [`STATE_FILE`] before the reveal goes out); not for a close that, when
//!    it first saw it, already had an abandon or a later round on top of it;
//!    not later than [`REVEAL_CUTOFF_MS`] after it first saw the round's
//!    close (the pages void it at 15 s once the house goes unheard); not for
//!    a close it first saw in its first [`SETTLE_MS`] at the table (after a
//!    start or a restart it can't tell how long the pages have waited on a
//!    close already there, nor whether their void is on its way); and not
//!    at a round it joined where another close names something else (the
//!    cheat's free second look: see a Friendly close's result, then
//!    choose);
//! 4. **beats** (`hb:<pub>`) every [`HEARTBEAT_MS`] while a table of the
//!    room runs Fair, so the ⚙ card can say whether the house is online;
//! 5. **puts back** what it wrote, its delegation and the owner's newest
//!    Fair setting (`hf:<t>`), when a peer deletes or replaces them;
//! 6. **steps down** when the owner sets a table Friendly, and when it is
//!    told to stop ([`House::begin_step_down`]): a reveal listing no close
//!    (computedFold's STEP-DOWN) lifts the requirement its last commitment
//!    set, so the table carries on Friendly with no void. A round already
//!    closed on that commitment is revealed instead, without a next one
//!    (when stopping, only if every seed is in: a void hands every stake
//!    back, a reveal short of seeds would cost the late ones theirs).
//!
//! The rules are computedFold's (THE HOUSE) and the bytes house_bytes.rs's.
//! The node never decides a round: the pages' fold does, from the records.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use yrs::{Any, Doc, Map, MapRef, Out, ReadTxn, Transact};

use crate::house_bytes::{self as hb, CVal, Ctx, HouseKey};

/// How often the node's loop ticks the house.
pub const TICK_MS: u64 = 200;
/// computedHouse HEARTBEAT_MS.
pub const HEARTBEAT_MS: u64 = 5_000;
/// computedTable REPUT_MS: how often what was taken away is put back.
pub const REPUT_MS: u64 = 1_000;
/// The pages' forfeit grace (fairTableSeeds REVEAL_GRACE_MS, computedTable
/// GRACE_PAD_MS and GRACE_MAX_MS): 4 s, stretched to 1.5 s past each seed
/// seen inside it, 10 s at most.
pub const REVEAL_GRACE_MS: u64 = 4_000;
pub const GRACE_PAD_MS: u64 = 1_500;
pub const GRACE_MAX_MS: u64 = 10_000;
/// The latest after it first saw a round's close the house reveals it: a
/// page voids a Fair round 15 s after its close once the house is unheard
/// (computedTable abandonWait, HOUSE_HEARD_MS), and a reveal after that
/// would undo a void every page has shown.
pub const REVEAL_CUTOFF_MS: u64 = 14_000;
/// For this long after it first reads a table (its start, a restart, the
/// room's doc arriving) the house joins no round there and reveals no close
/// it first sees then: the doc may still be catching up, and a close it finds
/// may be one the pages have waited on for as long as the cutoff, or already
/// voided where it hasn't heard yet. A round closed on a commitment from
/// before goes void (30 s: the pages hear the house again); the next it joins.
pub const SETTLE_MS: u64 = 5_000;
/// computedFold MAX_CLOSES_PER_ROUND, MAX_HOUSE_COUNTED, MAX_FROZEN.
pub const MAX_CLOSES_PER_ROUND: usize = 32;
pub const MAX_HOUSE_COUNTED: usize = 64;
pub const MAX_FROZEN: usize = 31;
/// Number.MAX_SAFE_INTEGER: the highest count the pages take.
const MAX_SAFE: i64 = 9_007_199_254_740_991;
/// Records of one session the house reads (a session holds ~10 per bettor
/// and round, and is trimmed at 20 rounds or 96 KB).
pub const MAX_SESSION_KEYS: usize = 8_192;
/// The highest round of each table the house has revealed or stepped down,
/// beside the node's other state files.
pub const STATE_FILE: &str = "house-state.json";

const CASINO_MAP: &str = "casino";
const COMPUTED_MAP: &str = "casinoComputed";

// ── Shapes (computedFold / computedHouse guards, as far as the house reads) ──

fn hex_of(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn b64url_of(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn is_pub(s: &str) -> bool {
    b64url_of(s, 43)
}

fn is_sig(s: &str) -> bool {
    b64url_of(s, 86)
}

/// casinoDoc isPlayerKey: 1–256 UTF-16 units, not `__proto__`.
fn is_pid(s: &str) -> bool {
    let n = s.encode_utf16().count();
    n > 0 && n <= 256 && s != "__proto__"
}

fn is_round(v: Option<&CVal>) -> Option<i64> {
    v.and_then(CVal::as_int).filter(|r| *r >= 1)
}

fn str_of<'a>(v: &'a CVal, k: &str) -> Option<&'a str> {
    v.get(k).and_then(CVal::as_str)
}

/// computedFold hasFields: exactly these fields (an undefined one is absent).
fn has_fields(v: &CVal, required: &[&str], optional: &[&str]) -> bool {
    let Some(fields) = v.fields() else { return false };
    fields.iter().all(|(k, _)| required.contains(&k.as_str()) || optional.contains(&k.as_str()))
        && required.iter().all(|k| v.get(k).is_some())
}

/// games/roulette.ts and games/craps.ts BET_TYPES; computedFold
/// MAX_SLIP_BETS, computedCraps MAX_CRAPS_SPOTS and MAX_FELT_STAKE, craps.ts
/// MAX_BET_AMOUNT (a roulette record's), POINT_NUMBERS and HARD_NUMBERS.
const ROULETTE_BETS: &[&str] = &["straight", "red", "black", "odd", "even", "low", "high", "dozen", "column"];
const CRAPS_BETS: &[&str] = &[
    "pass", "dontpass", "come", "dontcome", "field", "place", "big6", "big8", "hard", "anyseven", "anycraps", "two", "three", "yo",
    "twelve", "passodds", "dontpassodds", "comeodds", "dontcomeodds",
];
const MAX_SLIP_BETS: usize = 400;
const MAX_CRAPS_SPOTS: usize = 49;
const MAX_FELT_STAKE: i64 = 1_000_000_000_000;
const MAX_BET_AMOUNT: i64 = 1_000_000_000;
const POINT_NUMBERS: &[i64] = &[4, 5, 6, 8, 9, 10];
const HARD_NUMBERS: &[i64] = &[4, 6, 8, 10];

/// A slip's felt as the fold reads it (computedFold asSlip isFelt, asCrapsSlip
/// isCanonFelt): a close signed over a felt the pages throw out counts on no
/// page, so the house must not reveal it either.
fn felt_ok(craps: bool, b: &[CVal]) -> bool {
    if !craps {
        // Exactly {type, amount}, plus `pick` for the three that have one.
        return b.len() <= MAX_SLIP_BETS
            && b.iter().all(|e| {
                let (Some(t), Some(amount)) = (str_of(e, "type"), e.get("amount").and_then(CVal::as_int)) else { return false };
                if !ROULETTE_BETS.contains(&t) || amount < 1 || amount > MAX_BET_AMOUNT {
                    return false;
                }
                let pick = e.get("pick").and_then(CVal::as_int);
                match t {
                    "straight" => has_fields(e, &["type", "amount", "pick"], &[]) && pick.is_some_and(|p| (0..=36).contains(&p)),
                    "dozen" | "column" => has_fields(e, &["type", "amount", "pick"], &[]) && pick.is_some_and(|p| (0..=2).contains(&p)),
                    _ => has_fields(e, &["type", "amount"], &[]),
                }
            });
    }
    // Canonical: {type, amount} or {type, pick, amount}, the pick the type
    // allows, ascending by spot (`type:pick`), MAX_FELT_STAKE in all.
    if b.len() > MAX_CRAPS_SPOTS {
        return false;
    }
    let mut last = String::new();
    let mut sum: i64 = 0;
    for (i, e) in b.iter().enumerate() {
        if !has_fields(e, &["type", "amount"], &["pick"]) {
            return false;
        }
        let (Some(t), Some(amount)) = (str_of(e, "type"), e.get("amount").and_then(CVal::as_int)) else { return false };
        if !CRAPS_BETS.contains(&t) || amount < 1 || amount > MAX_FELT_STAKE {
            return false;
        }
        let pick = match e.get("pick") {
            None => None,
            Some(p) => match p.as_int() {
                Some(p) => Some(p),
                None => return false,
            },
        };
        let pick_ok = match t {
            "place" | "comeodds" | "dontcomeodds" => pick.is_some_and(|p| POINT_NUMBERS.contains(&p)),
            "hard" => pick.is_some_and(|p| HARD_NUMBERS.contains(&p)),
            "come" | "dontcome" => pick.is_none_or(|p| POINT_NUMBERS.contains(&p)),
            _ => pick.is_none(),
        };
        let spot = format!("{t}:{}", pick.map(|p| p.to_string()).unwrap_or_default());
        if !pick_ok || (i > 0 && spot <= last) {
            return false;
        }
        last = spot;
        sum += amount;
        if sum > MAX_FELT_STAKE {
            return false;
        }
    }
    true
}

/// The game of an incarnation (computedFold gameOfInc): `k…` and `d…` craps.
fn craps_inc(inc: &str) -> bool {
    inc.starts_with('k') || inc.starts_with('d')
}

/// computedFold houseRules: `r…` and `d…` are house tables.
fn house_inc(inc: &str) -> bool {
    (inc.starts_with('r') || inc.starts_with('d')) && inc.len() == 25 && hex_of(&inc[1..], 24)
}

/// A switch exactly as casinoDoc computedCfgInc reads it: {v: 1, inc}.
fn switch_inc(v: &CVal) -> Option<String> {
    if !has_fields(v, &["v", "inc"], &[]) || v.get("v").and_then(CVal::as_int) != Some(1) {
        return None;
    }
    let inc = str_of(v, "inc")?;
    let ok = inc.len() == 25 && matches!(inc.as_bytes()[0], b'c' | b'k' | b'r' | b'd') && hex_of(&inc[1..], 24);
    ok.then(|| inc.to_string())
}

/// A checkpoint as asCheckpointFor reads it, as far as the session id and
/// the house need: its shape (the carry only as an object).
fn checkpoint_ok(v: &CVal, inc: &str) -> bool {
    let craps = craps_inc(inc);
    let optional: &[&str] = if craps { &["e", "s", "h"] } else { &["e", "h"] };
    if !has_fields(v, &["v", "b", "u", "l", "n", "k", "g"], optional) || v.get("v").and_then(CVal::as_int) != Some(1) {
        return false;
    }
    let sid_ok = str_of(v, "b").is_some_and(|b| b == "g" || hex_of(b, 24));
    let ended = match v.get("e") {
        None => false,
        Some(CVal::Int(1)) => true,
        Some(_) => return false,
    };
    if !sid_ok || is_round(v.get("u")).is_none() || !str_of(v, "l").is_some_and(|l| hex_of(l, 32)) {
        return false;
    }
    if !str_of(v, "k").is_some_and(is_pub) || !str_of(v, "g").is_some_and(is_sig) {
        return false;
    }
    if let Some(h) = v.get("h") {
        if ended || !h.as_str().is_some_and(|h| hex_of(h, 64)) {
            return false;
        }
    }
    if craps && (ended != v.get("s").is_none() || v.get("s").is_some_and(|s| s.fields().is_none())) {
        return false;
    }
    let net = |s: &str| {
        let d = s.strip_prefix('-').unwrap_or(s);
        !d.is_empty() && d.len() <= 40 && !d.starts_with('0') && d.bytes().all(|b| b.is_ascii_digit())
    };
    match v.get("n").and_then(CVal::fields) {
        Some(n) => n.len() <= 4_096 && n.iter().all(|(pid, x)| is_pid(pid) && x.as_str().is_some_and(net)),
        None => false,
    }
}

/// A record's key parts (computedFold parseKey): kind, round, pid (s and x), hash.
fn parse_key(key: &str) -> Option<(char, i64, Option<&str>, &str)> {
    let kind = key.chars().next()?;
    if !"scxfzho".contains(kind) || key.as_bytes().get(1) != Some(&b':') {
        return None;
    }
    let last = key.rfind(':')?;
    let second = 2 + key[2..].find(':')?;
    let h = &key[last + 1..];
    let r_text = &key[2..second];
    if !hex_of(h, 32) || r_text.is_empty() || r_text.starts_with('0') || !r_text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let r: i64 = r_text.parse().ok().filter(|r| *r <= MAX_SAFE)?;
    if kind == 's' || kind == 'x' {
        let pid = key.get(second + 1..last).filter(|_| second < last)?;
        is_pid(pid).then_some((kind, r, Some(pid), h))
    } else {
        (second == last).then_some((kind, r, None, h))
    }
}

// ── What the house reads of one table ────────────────────────────────────────

#[derive(Clone, Debug)]
struct Slip {
    r: i64,
    pid: String,
    c: String,
    k: String,
    /// Chips on it: only such a slip can sign a close.
    chips: bool,
    v: CVal,
}

#[derive(Clone, Debug)]
struct Close {
    hash: String,
    r: i64,
    q: String,
    /// pid → frozen slip hash.
    f: Vec<(String, String)>,
    k: String,
    h: Option<String>,
    rank: String,
}

#[derive(Clone, Debug)]
struct OwnReveal {
    r: i64,
    c: Option<String>,
    /// The close it decided (none: a step-down).
    x: Vec<String>,
}

/// One live table: its checkpoint's base, its live session's records.
struct TableRead {
    ctx: Ctx,
    base_u: i64,
    cp_h: Option<String>,
    ses_key: String,
    slips: HashMap<String, Slip>,
    /// (round, pid) → the seeds revealed.
    seeds: HashMap<(i64, String), Vec<String>>,
    /// Closes whose signature and signer hold and whose parent is the
    /// session or a close of the round before (after a round this house
    /// decided, the close it decided), by round.
    closes: Vec<Close>,
    /// close hash → it has a verified abandon.
    abandoned: HashSet<String>,
    /// Its own reveals and joins, as it signed them.
    own_reveals: Vec<OwnReveal>,
    /// Rounds this house has a join of, with its commitment.
    own_joins: Vec<(i64, String)>,
}

impl TableRead {
    fn closes_at(&self, r: i64) -> impl Iterator<Item = &Close> {
        self.closes.iter().filter(move |c| c.r == r)
    }

    /// The round after the last one closed: what the house joins.
    fn next_round(&self) -> i64 {
        self.closes.iter().map(|c| c.r).max().unwrap_or(self.base_u) + 1
    }
}

/// What a tick writes into a room, in one transaction.
#[derive(Clone, Debug, PartialEq)]
pub enum Write {
    /// A record into a session map (`ses:<t>:<inc>:<sid>`).
    Session { ses: String, key: String, value: CVal },
    /// A top-level casinoComputed key (a heartbeat, a put-back room record).
    Top { key: String, value: CVal },
}

// ── Memory ───────────────────────────────────────────────────────────────────

#[derive(Default)]
struct TableMem {
    /// When this house first saw each close naming its commitment.
    first_seen: HashMap<String, u64>,
    /// Closes it never reveals: when first seen, they already had an
    /// abandon or a later round on top.
    blocked: HashSet<String>,
    /// When it first saw a seed that opens each slip (by slip hash).
    seed_seen: HashMap<String, u64>,
    /// Rounds it gave up on (past the cutoff, or a rival close at a round
    /// it joined).
    refused: HashSet<i64>,
    /// Its own session records this run, to put back: (session key, key, value).
    written: Vec<(String, String, CVal)>,
    /// When it first read the table this run ([`SETTLE_MS`]).
    first_read: Option<u64>,
}

#[derive(Default)]
struct RoomMem {
    /// Each player's key as first seen (trust on first use, as the pages pin).
    pins: HashMap<String, String>,
    /// The delegation as first verified (pinned for the run, put back).
    delegation: Option<CVal>,
    /// The newest owner-signed Fair setting seen per table.
    fair: HashMap<String, CVal>,
    tables: HashMap<(String, String), TableMem>,
    last_beat: Option<u64>,
    beat_n: i64,
    last_reput: Option<u64>,
}

/// What the house last did at a table, on disk ([`STATE_FILE`]): the highest
/// round it revealed or stepped down, the close it decided there (none: a
/// step-down), and whether that reveal carried the next round's commitment.
/// The doc's copy of the reveal can be deleted; the line the next round must
/// carry on, and the commitment it must name, hold all the same.
#[derive(Clone, Debug, Default, PartialEq)]
struct Done {
    r: i64,
    x: Option<String>,
    c: bool,
}

/// The house of this node: its key, what it has revealed, what it has seen.
pub struct House {
    key: HouseKey,
    state_path: Option<PathBuf>,
    /// (room, t, inc) → what it last revealed or stepped down.
    done: HashMap<(String, String, String), Done>,
    rooms: HashMap<String, RoomMem>,
    /// Signature verdicts by kind, room, table, incarnation and record hash
    /// (the signed bytes are bound to each: a copy elsewhere is checked anew).
    verdicts: HashMap<(&'static str, [String; 3], String), bool>,
    stepping_down: bool,
    /// [`SETTLE_MS`] (tests set 0).
    settle_ms: u64,
}

/// What [`House::tick`] did in a room.
#[derive(Default, Debug, PartialEq)]
pub struct TickOut {
    /// The update to send (lib0 v1), when it wrote anything.
    pub update: Option<Vec<u8>>,
    /// How many records it wrote.
    pub wrote: usize,
}

impl House {
    /// The house of the node whose secret key is `node_secret`, keeping its
    /// state in `state_path` (None: memory only, for tests). Refused (Err)
    /// when the state file is there but unreadable: a house that forgot what
    /// it revealed could reveal a round twice.
    pub fn open(node_secret: &[u8; 32], state_path: Option<PathBuf>) -> Result<Self, String> {
        let mut done = HashMap::new();
        if let Some(path) = &state_path {
            match std::fs::read(path) {
                Ok(bytes) => done = parse_state(&bytes).ok_or_else(|| format!("{} is unreadable", path.display()))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("{}: {e}", path.display())),
            }
        }
        Ok(Self {
            key: HouseKey::from_node_secret(node_secret),
            state_path,
            done,
            rooms: HashMap::new(),
            verdicts: HashMap::new(),
            stepping_down: false,
            settle_ms: SETTLE_MS,
        })
    }

    /// The house key (base64url), for the fingerprint.
    pub fn public(&self) -> &str {
        &self.key.public
    }

    /// Stop joining, beating and carrying commitments: from the next tick
    /// on, each table's outstanding commitment is stepped down.
    pub fn begin_step_down(&mut self) {
        self.stepping_down = true;
    }

    pub fn stepping_down(&self) -> bool {
        self.stepping_down
    }

    /// Whether `g` is `k`'s signature of `bytes`, record `hash` of `kind` at
    /// `at` (room, table, incarnation; "" where the kind has none): checked
    /// once there.
    fn verified(&mut self, kind: &'static str, at: [&str; 3], hash: &str, k: &str, bytes: Option<[u8; 32]>, g: &str) -> bool {
        let id = (kind, at.map(str::to_string), hash.to_string());
        if let Some(v) = self.verdicts.get(&id) {
            return *v;
        }
        let ok = bytes.is_some_and(|b| hb::verify(k, &b, g));
        if self.verdicts.len() >= 50_000 {
            self.verdicts.clear();
        }
        self.verdicts.insert(id, ok);
        ok
    }

    /// Player `pid`'s key as this house first saw it in the room's players
    /// map (trust on first use, as the pages pin: casinoDoc computedPinOf).
    fn pin_of<T: ReadTxn>(&mut self, room: &str, txn: &T, pid: &str) -> Option<String> {
        let mem = self.rooms.get_mut(room)?;
        if let Some(k) = mem.pins.get(pid) {
            return Some(k.clone());
        }
        let k = txn.get_map("players").and_then(|m| match m.get(txn, pid) {
            Some(Out::Any(Any::Map(entry))) => match entry.get("keyB64") {
                Some(Any::String(k)) if !k.is_empty() && k.len() <= 128 => Some(k.to_string()),
                _ => None,
            },
            _ => None,
        })?;
        mem.pins.insert(pid.to_string(), k.clone());
        Some(k)
    }

    fn last_of(&self, ctx: &Ctx) -> Option<&Done> {
        self.done.get(&(ctx.room.clone(), ctx.t.clone(), ctx.inc.clone()))
    }

    fn done_of(&self, ctx: &Ctx) -> i64 {
        self.last_of(ctx).map_or(0, |d| d.r)
    }

    /// Note round r revealed (or stepped down), on disk first: false when it
    /// could not be written, and then nothing is revealed.
    fn mark_done(&mut self, ctx: &Ctx, done: Done) -> bool {
        let key = (ctx.room.clone(), ctx.t.clone(), ctx.inc.clone());
        let r = done.r;
        let was = self.done.insert(key.clone(), done);
        if let Some(path) = &self.state_path {
            if let Err(e) = write_state(path, &self.done) {
                eprintln!("🏠 house: cannot write {}: {e} — not revealing round {r} of {}", path.display(), ctx.t);
                match was {
                    Some(w) => self.done.insert(key, w),
                    None => self.done.remove(&key),
                };
                return false;
            }
        }
        true
    }

    fn commit(&self, ctx: &Ctx, r: i64) -> String {
        hb::house_commit(ctx, r, &self.key.seed(ctx, r))
    }

    fn signed(&self, kind: &str, ctx: &Ctx, body: Vec<(String, CVal)>) -> CVal {
        let body = CVal::Obj(body);
        let g = hb::sign_bytes(kind, ctx, &body).map(|b| self.key.sign(&b)).expect("the house's own records are canonical");
        let CVal::Obj(mut fields) = body else { unreachable!() };
        fields.push(("g".into(), CVal::Str(g)));
        CVal::Obj(fields)
    }

    /// One tick of the house in room `room` (its doc `doc`), at `now` on a
    /// monotonic clock (ms) and `wall` (ms since the epoch: the heartbeat's
    /// count). Writes what it decided into the doc, in one transaction.
    pub fn tick(&mut self, room: &str, doc: &Doc, now: u64, wall: u64) -> TickOut {
        let writes = self.plan(room, doc, now, wall);
        let wrote = writes.len();
        TickOut { update: apply(doc, &writes), wrote }
    }

    fn plan(&mut self, room: &str, doc: &Doc, now: u64, wall: u64) -> Vec<Write> {
        let mut writes = Vec::new();
        let txn = doc.transact();
        let Some(comp) = txn.get_map(COMPUTED_MAP) else { return writes };
        let pub_key = self.key.public.clone();

        // The deed holder and their key, pinned on first sight.
        let owner = txn.get_map("roomInfo").and_then(|m| match m.get(&txn, "owner") {
            Some(Out::Any(Any::String(s))) if !s.is_empty() && &*s != "Local-Clone" => Some(s.to_string()),
            _ => None,
        });
        let Some(owner) = owner else { return writes };
        self.rooms.entry(room.to_string()).or_default();
        let Some(owner_key) = self.pin_of(room, &txn, &owner) else { return writes };

        // The delegation: this house's key, signed by the deed holder.
        let deleg_key = format!("hk:{pub_key}");
        let deleg_now = top_value(&comp, &txn, &deleg_key);
        let deleg_ok = |v: &CVal| {
            has_fields(v, &["v", "h", "k", "g"], &[])
                && v.get("v").and_then(CVal::as_int) == Some(1)
                && str_of(v, "h") == Some(pub_key.as_str())
                && str_of(v, "k") == Some(owner_key.as_str())
        };
        let held = self.rooms[room].delegation.clone().filter(|d| str_of(d, "k") == Some(owner_key.as_str()));
        let delegation = match (&held, &deleg_now) {
            (Some(d), _) => Some(d.clone()),
            (None, Some(v)) if deleg_ok(v) => {
                let hash = hb::rec_hash(v).unwrap_or_default();
                let bytes = hb::room_sign_bytes("hkey", room, "", v);
                let g = str_of(v, "g").unwrap_or("").to_string();
                self.verified("hkey", [room, "", ""], &hash, &owner_key, bytes, &g).then(|| v.clone())
            }
            _ => None,
        };
        let Some(delegation) = delegation else { return writes };
        self.rooms.get_mut(room).unwrap().delegation = Some(delegation.clone());

        // The owner's Fair settings, newest first seen (a new deed holder's
        // count afresh: the last one's settings go).
        self.rooms.get_mut(room).unwrap().fair.retain(|_, v| str_of(v, "k") == Some(owner_key.as_str()));
        for (key, out) in comp.iter(&txn) {
            let Some(t) = key.strip_prefix("hf:").filter(|t| !t.is_empty()) else { continue };
            let Out::Any(any) = out else { continue };
            let v = CVal::from_any(&any);
            if !has_fields(&v, &["v", "m", "s", "k", "g"], &[])
                || v.get("v").and_then(CVal::as_int) != Some(1)
                || !matches!(v.get("m").and_then(CVal::as_int), Some(0 | 1))
                || is_round(v.get("s")).is_none()
                || str_of(&v, "k") != Some(owner_key.as_str())
            {
                continue;
            }
            let s = v.get("s").and_then(CVal::as_int).unwrap();
            let seen = self.rooms[room].fair.get(t).and_then(|x| x.get("s").and_then(CVal::as_int));
            if seen.is_some_and(|was| was >= s) {
                continue;
            }
            let hash = hb::rec_hash(&v).unwrap_or_default();
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if self.verified("hfair", [room, t, ""], &hash, &owner_key, hb::room_sign_bytes("hfair", room, t, &v), &g) {
                self.rooms.get_mut(room).unwrap().fair.insert(t.to_string(), v);
            }
        }

        // The switched-on house tables, live.
        let casino = txn.get_map(CASINO_MAP);
        let mut tables: Vec<(String, String)> = Vec::new();
        if let Some(casino) = &casino {
            for (key, out) in casino.iter(&txn) {
                let Some(t) = key.strip_prefix("cfg:computed:") else { continue };
                let Out::Any(any) = out else { continue };
                let Some(inc) = switch_inc(&CVal::from_any(&any)) else { continue };
                if house_inc(&inc) && !casino.contains_key(&txn, &format!("gone:{t}:{inc}")) {
                    tables.push((t.to_string(), inc));
                }
            }
        }
        tables.sort();

        let mut fair_tables = 0;
        for (t, inc) in tables {
            let ctx = Ctx { room: room.to_string(), t: t.clone(), inc: inc.clone() };
            let Some(read) = self.read_table(&comp, &txn, ctx) else { continue };
            let friendly = self.rooms[room].fair.get(&t).and_then(|v| v.get("m").and_then(CVal::as_int)) == Some(1);
            if !friendly {
                fair_tables += 1;
            }
            self.table_duties(room, &read, friendly, now, &mut writes);
        }

        // The heartbeat, while a table runs Fair.
        let beat_due = self.rooms[room].last_beat.is_none_or(|at| now.saturating_sub(at) >= HEARTBEAT_MS);
        if fair_tables > 0 && !self.stepping_down && beat_due {
            let beat_key = format!("hb:{pub_key}");
            // It counts on from the doc's beat only as it signed it: a peer's
            // copy with a higher count would push its own past what the
            // pages take.
            let in_doc = top_value(&comp, &txn, &beat_key)
                .filter(|v| {
                    has_fields(v, &["v", "n", "k", "g"], &[])
                        && v.get("v").and_then(CVal::as_int) == Some(1)
                        && str_of(v, "k") == Some(pub_key.as_str())
                })
                .and_then(|v| {
                    let n = is_round(v.get("n")).filter(|n| *n <= MAX_SAFE)?;
                    let hash = hb::rec_hash(&v)?;
                    let g = str_of(&v, "g").unwrap_or("").to_string();
                    self.verified("hbeat", [room, "", ""], &hash, &pub_key, hb::room_sign_bytes("hbeat", room, "", &v), &g).then_some(n)
                })
                .unwrap_or(0);
            let mem = self.rooms.get_mut(room).unwrap();
            let n = (wall.min(MAX_SAFE as u64) as i64).max(in_doc + 1).max(mem.beat_n + 1).min(MAX_SAFE);
            let body = CVal::Obj(vec![("v".into(), CVal::Int(1)), ("n".into(), CVal::Int(n)), ("k".into(), CVal::Str(pub_key.clone()))]);
            if let Some(bytes) = hb::room_sign_bytes("hbeat", room, "", &body) {
                let CVal::Obj(mut fields) = body else { unreachable!() };
                fields.push(("g".into(), CVal::Str(self.key.sign(&bytes))));
                writes.push(Write::Top { key: beat_key, value: CVal::Obj(fields) });
                mem.beat_n = n;
                mem.last_beat = Some(now);
            }
        }

        // Put back what was taken away, every REPUT_MS.
        let mem = self.rooms.get_mut(room).unwrap();
        if mem.last_reput.is_none_or(|at| now.saturating_sub(at) >= REPUT_MS) {
            mem.last_reput = Some(now);
            let same = |a: &Option<CVal>, b: &CVal| a.as_ref().and_then(hb::rec_hash) == hb::rec_hash(b);
            if !same(&deleg_now, &delegation) {
                writes.push(Write::Top { key: deleg_key, value: delegation });
            }
            // Each table's setting is the newest the deed holder signed, as
            // read above: anything else in its place goes, a forged one
            // with a higher count included.
            for (t, rec) in &mem.fair {
                let key = format!("hf:{t}");
                if !same(&top_value(&comp, &txn, &key), rec) {
                    writes.push(Write::Top { key, value: rec.clone() });
                }
            }
            for table in mem.tables.values() {
                for (ses, key, value) in &table.written {
                    // There as it wrote it: junk under its key reads as
                    // nothing on every page, and goes too.
                    let present = match comp.get(&txn, ses) {
                        Some(Out::YMap(m)) => match m.get(&txn, key) {
                            Some(Out::Any(any)) => hb::rec_hash(&CVal::from_any(&any)) == hb::rec_hash(value),
                            _ => false,
                        },
                        _ => true,
                    };
                    let queued = writes.iter().any(|w| matches!(w, Write::Session { key: k, .. } if k == key));
                    if !present && !queued {
                        writes.push(Write::Session { ses: ses.clone(), key: key.clone(), value: value.clone() });
                    }
                }
            }
        }
        writes
    }

    /// Read table `ctx`'s live session (None when the doc holds none, or its
    /// incarnation has ended).
    fn read_table<T: ReadTxn>(&mut self, comp: &MapRef, txn: &T, ctx: Ctx) -> Option<TableRead> {
        let cp = top_value(comp, txn, &format!("sum:{}:{}", ctx.t, ctx.inc)).filter(|v| checkpoint_ok(v, &ctx.inc));
        if cp.as_ref().is_some_and(|v| v.get("e").is_some()) {
            return None;
        }
        let sid = hb::next_sid(&ctx, cp.as_ref())?;
        let ses_key = format!("ses:{}:{}:{sid}", ctx.t, ctx.inc);
        let Some(Out::YMap(ses)) = comp.get(txn, &ses_key) else { return None };
        let base_u = cp.as_ref().and_then(|v| v.get("u").and_then(CVal::as_int)).unwrap_or(0);
        let cp_h = cp.as_ref().and_then(|v| str_of(v, "h")).map(str::to_string);
        let craps = craps_inc(&ctx.inc);
        let pub_key = self.key.public.clone();

        let mut read = TableRead {
            ctx,
            base_u,
            cp_h,
            ses_key,
            slips: HashMap::new(),
            seeds: HashMap::new(),
            closes: Vec::new(),
            abandoned: HashSet::new(),
            own_reveals: Vec::new(),
            own_joins: Vec::new(),
        };
        let mut closes: Vec<(Close, CVal)> = Vec::new();
        let mut abandons: Vec<(String, String, CVal)> = Vec::new();
        let mut own: Vec<(char, i64, String, CVal)> = Vec::new();
        for (key, out) in ses.iter(txn).take(MAX_SESSION_KEYS) {
            let Some((kind, r, pid, h)) = parse_key(key) else { continue };
            let Out::Any(any) = out else { continue };
            let v = CVal::from_any(&any);
            // The key must be the body's own (its round, pid and hash).
            if is_round(v.get("r")) != Some(r) || hb::rec_hash(&v).as_deref() != Some(h) {
                continue;
            }
            if pid.is_some() && str_of(&v, "p") != pid {
                continue;
            }
            let k = str_of(&v, "k").filter(|k| is_pub(k)).map(str::to_string);
            let g_ok = str_of(&v, "g").is_some_and(is_sig);
            match kind {
                's' => {
                    let fields_ok = if craps {
                        has_fields(&v, &["r", "p", "v", "b", "o", "c", "k", "g"], &["t", "l"])
                            && str_of(&v, "o").is_some_and(|o| hex_of(o, 32))
                            && v.get("t").is_none_or(|t| t.as_int().is_some_and(|t| (1..=7).contains(&t)))
                            && v.get("l").is_none_or(|l| l.as_int() == Some(1))
                    } else {
                        has_fields(&v, &["r", "p", "v", "b", "c", "k", "g"], &[])
                    };
                    let c = str_of(&v, "c").filter(|c| hex_of(c, 64));
                    let felt = v.get("b").and_then(CVal::as_arr).filter(|b| felt_ok(craps, b));
                    if fields_ok && g_ok && is_round(v.get("v")).is_some() && pid.is_some_and(is_pid) {
                        if let (Some(c), Some(k), Some(b)) = (c, k, felt) {
                            let chips = !b.is_empty();
                            read.slips.insert(h.to_string(), Slip { r, pid: pid.unwrap().to_string(), c: c.to_string(), k, chips, v });
                        }
                    }
                }
                'x' => {
                    if let Some(s) = str_of(&v, "s").filter(|s| hex_of(s, 64) && has_fields(&v, &["r", "p", "s"], &[])) {
                        read.seeds.entry((r, pid.unwrap().to_string())).or_default().push(s.to_string());
                    }
                }
                'c' => {
                    if !has_fields(&v, &["r", "q", "f", "k", "g"], &["h"]) || !g_ok {
                        continue;
                    }
                    let q = str_of(&v, "q").filter(|q| *q == "g" || hex_of(q, 24) || hex_of(q, 32));
                    let ch = v.get("h").map(|x| x.as_str().filter(|x| hex_of(x, 64)));
                    let f: Option<Vec<(String, String)>> = v.get("f").and_then(CVal::fields).and_then(|fs| {
                        (!fs.is_empty() && fs.len() <= MAX_FROZEN)
                            .then(|| fs.iter().map(|(p, x)| x.as_str().filter(|x| is_pid(p) && hex_of(x, 32)).map(|x| (p.clone(), x.to_string()))).collect())
                            .flatten()
                    });
                    let (Some(q), Some(f), Some(k)) = (q, f, k) else { continue };
                    if ch == Some(None) {
                        continue;
                    }
                    let rank = hb::duty_rank("close", &read.ctx, r, &k);
                    let close = Close { hash: h.to_string(), r, q: q.to_string(), f, k, h: ch.flatten().map(str::to_string), rank };
                    closes.push((close, v));
                }
                'z' => {
                    if has_fields(&v, &["r", "x", "k", "g"], &[]) && g_ok {
                        if let (Some(x), Some(k)) = (str_of(&v, "x").filter(|x| hex_of(x, 32)), k) {
                            abandons.push((x.to_string(), k, v.clone()));
                        }
                    }
                }
                'h' | 'o' if k.as_deref() == Some(pub_key.as_str()) && g_ok => own.push((kind, r, h.to_string(), v)),
                _ => {}
            }
        }

        // Its own records count as it signed them: a peer's copy under its
        // key (a reveal of a high round, say) would stop it joining and
        // revealing.
        let at = [read.ctx.room.clone(), read.ctx.t.clone(), read.ctx.inc.clone()];
        let at = [at[0].as_str(), at[1].as_str(), at[2].as_str()];
        for (kind, r, hash, v) in own {
            let (signed, shape_ok) = if kind == 'h' {
                ("hreveal", has_fields(&v, &["r", "s", "x", "n", "k", "g"], &["c"]))
            } else {
                ("hcommit", has_fields(&v, &["r", "c", "k", "g"], &[]))
            };
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if !shape_ok || !self.verified(signed, at, &hash, &pub_key, hb::sign_bytes(signed, &read.ctx, &v), &g) {
                continue;
            }
            if kind == 'h' {
                let x = v.get("x").and_then(CVal::as_arr).map(|xs| xs.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                read.own_reveals.push(OwnReveal { r, c: str_of(&v, "c").map(str::to_string), x });
            } else if let Some(c) = str_of(&v, "c") {
                read.own_joins.push((r, c.to_string()));
            }
        }

        // A close counts when it is signed by one of the slips it freezes,
        // that slip as the pages take it (computedFold closeInfo): its
        // player's pinned key, its signature, chips on it. One the pages
        // throw out would only void the round's real close if revealed.
        let mut good: Vec<Close> = Vec::new();
        for (c, v) in closes {
            let mut signer = false;
            for (p, sh) in &c.f {
                let Some(s) = read.slips.get(sh) else { continue };
                if s.pid != *p || s.r != c.r || s.k != c.k || !s.chips || self.pin_of(&read.ctx.room, txn, p).as_deref() != Some(s.k.as_str()) {
                    continue;
                }
                let g = str_of(&s.v, "g").unwrap_or("").to_string();
                if self.verified("slip", at, sh, &s.k, hb::sign_bytes("slip", &read.ctx, &s.v), &g) {
                    signer = true;
                    break;
                }
            }
            if !signer {
                continue;
            }
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if self.verified("close", at, &c.hash, &c.k, hb::sign_bytes("close", &read.ctx, &v), &g) {
                good.push(c);
            }
        }
        // ...and its parent is the session (its first round) or a close
        // counted at the round before, no round skipped; after a round this
        // house decided, the close it decided: it reveals one close a round,
        // and carries on that line alone, so no rival gets a second look.
        good.sort_by_key(|c| c.r);
        let sid = read.ses_key.rsplit(':').next().unwrap_or("").to_string();
        let last = self.last_of(&read.ctx).cloned();
        let mut on_chain: HashMap<String, i64> = HashMap::new();
        for c in good {
            let parent_ok = if c.r == read.base_u + 1 { c.q == sid } else { c.r > read.base_u + 1 && on_chain.get(&c.q) == Some(&(c.r - 1)) };
            let mut decided: Vec<&String> = read.own_reveals.iter().filter(|h| h.r == c.r - 1).flat_map(|h| &h.x).collect();
            // (Its own memory too: a peer can delete the reveal from the doc.)
            if let Some(Done { r, x: Some(x), .. }) = &last {
                if *r == c.r - 1 && *r > read.base_u {
                    decided.push(x);
                }
            }
            if parent_ok && (decided.is_empty() || decided.iter().all(|x| **x == c.q)) {
                on_chain.insert(c.hash.clone(), c.r);
                read.closes.push(c);
            }
        }
        for (x, k, v) in abandons {
            if !on_chain.contains_key(&x) || read.abandoned.contains(&x) {
                continue;
            }
            let hash = hb::rec_hash(&v).unwrap_or_default();
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if self.verified("abandon", at, &hash, &k, hb::sign_bytes("abandon", &read.ctx, &v), &g) {
                read.abandoned.insert(x);
            }
        }
        Some(read)
    }

    /// One table's join, reveal and step-down.
    fn table_duties(&mut self, room: &str, read: &TableRead, friendly: bool, now: u64, writes: &mut Vec<Write>) {
        let ctx = &read.ctx;
        let done = read.own_reveals.iter().map(|h| h.r).fold(self.done_of(ctx), i64::max);
        let carried = |r: i64, me: &House| {
            let c = me.commit(ctx, r);
            read.own_reveals.iter().any(|h| h.r == r - 1 && h.c.as_deref() == Some(c.as_str()))
                || me.last_of(ctx).is_some_and(|d| d.r == r - 1 && d.c)
                || (r == read.base_u + 1 && read.cp_h.as_deref() == Some(c.as_str()))
        };
        let joined = |r: i64, me: &House| {
            let c = me.commit(ctx, r);
            read.own_joins.iter().any(|(jr, jc)| *jr == r && *jc == c)
        };

        let key = (ctx.t.clone(), ctx.inc.clone());
        let settle_ms = self.settle_ms;
        let mem = self.rooms.get_mut(room).unwrap().tables.entry(key.clone()).or_default();
        let settling = now.saturating_sub(*mem.first_read.get_or_insert(now)) < settle_ms;
        // A trim opened a new session: what was written into the old one is
        // the trim's to carry (its copies and the checkpoint's `h`).
        mem.written.retain(|(ses, _, _)| *ses == read.ses_key);
        // Seeds as they come: when each slip's seed was first seen.
        for (hash, slip) in &read.slips {
            if mem.seed_seen.contains_key(hash) {
                continue;
            }
            let opens = read.seeds.get(&(slip.r, slip.pid.clone())).is_some_and(|ss| {
                ss.iter().any(|s| hb::slip_commit(ctx, slip.r, &slip.pid, s) == slip.c)
            });
            if opens {
                mem.seed_seen.insert(hash.clone(), now);
            }
        }

        // The rounds with closes naming this house's commitment, lowest first.
        let mut rounds: Vec<i64> = read.closes.iter().map(|c| c.r).filter(|r| *r > done).collect();
        rounds.sort();
        rounds.dedup();
        let last_closed = read.closes.iter().map(|c| c.r).max().unwrap_or(0);
        let mut revealed_now: Option<i64> = None;
        for r in rounds {
            let commit = self.commit(ctx, r);
            let mem = self.rooms.get_mut(room).unwrap().tables.get_mut(&key).unwrap();
            let mut listed: Vec<&Close> = Vec::new();
            for c in read.closes_at(r).filter(|c| c.h.as_deref() == Some(commit.as_str())) {
                if !mem.first_seen.contains_key(&c.hash) {
                    mem.first_seen.insert(c.hash.clone(), now);
                    if settling || read.abandoned.contains(&c.hash) || last_closed > r {
                        mem.blocked.insert(c.hash.clone());
                    }
                }
                if !mem.blocked.contains(&c.hash) {
                    listed.push(c);
                }
            }
            if listed.is_empty() || mem.refused.contains(&r) {
                continue;
            }
            listed.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.hash.cmp(&b.hash)));
            listed.truncate(MAX_CLOSES_PER_ROUND);
            let joinable = !carried(r, self);
            let mem = self.rooms.get_mut(room).unwrap().tables.get_mut(&key).unwrap();
            // At a round it joined, a close naming anything else is a choice
            // the house won't hand out.
            if joinable && read.closes_at(r).any(|c| c.h.as_deref() != Some(commit.as_str())) {
                mem.refused.insert(r);
                continue;
            }
            let t0 = listed.iter().map(|c| mem.first_seen[&c.hash]).min().unwrap();
            if now.saturating_sub(t0) > REVEAL_CUTOFF_MS {
                mem.refused.insert(r);
                continue;
            }
            let best = listed[0];
            let all_in = best.f.iter().all(|(_, sh)| mem.seed_seen.contains_key(sh));
            let mut times: Vec<u64> = best.f.iter().filter_map(|(_, sh)| mem.seed_seen.get(sh).copied()).collect();
            let grace = grace_of(t0, &mut times);
            let due = all_in || now >= t0 + grace;
            // Stopping: reveal only a round whose seeds are all in (a void
            // costs nobody their stake; a reveal short of seeds would).
            if self.stepping_down && !all_in {
                break;
            }
            if !due {
                break;
            }
            // The best-ranked close alone, and the slips it froze whose seeds
            // it saw: listing a rival too would show both outcomes, and let
            // a bettor carry on the one they liked.
            let mut n: Vec<String> = best.f.iter().filter(|(_, sh)| mem.seed_seen.contains_key(sh)).map(|(_, sh)| sh.clone()).collect();
            n.sort();
            n.dedup();
            n.truncate(MAX_HOUSE_COUNTED);
            let x = vec![best.hash.clone()];
            let next = (!friendly && !self.stepping_down).then(|| self.commit(ctx, r + 1));
            if !self.mark_done(ctx, Done { r, x: Some(best.hash.clone()), c: next.is_some() }) {
                break;
            }
            let mut body = vec![
                ("r".to_string(), CVal::Int(r)),
                ("s".to_string(), CVal::Str(self.key.seed(ctx, r))),
                ("x".to_string(), CVal::Arr(x.into_iter().map(CVal::Str).collect())),
                ("n".to_string(), CVal::Arr(n.into_iter().map(CVal::Str).collect())),
            ];
            if let Some(c) = next {
                body.push(("c".to_string(), CVal::Str(c)));
            }
            body.push(("k".to_string(), CVal::Str(self.key.public.clone())));
            let rec = self.signed("hreveal", ctx, body);
            self.write_session(room, &key, &read.ses_key, 'h', r, rec, writes);
            revealed_now = Some(r);
            break;
        }
        let done = revealed_now.map_or(done, |r| r.max(done));

        if friendly || self.stepping_down {
            // Step down: the outstanding commitment (the lowest round past
            // the last revealed that has one), unless a close names it (then
            // its reveal, above, carries none on).
            if revealed_now.is_some() {
                return;
            }
            let Some(r) = (done + 1..=read.next_round().max(done + 1)).find(|r| carried(*r, self) || joined(*r, self)) else { return };
            let commit = self.commit(ctx, r);
            if read.closes_at(r).any(|c| c.h.as_deref() == Some(commit.as_str())) {
                return;
            }
            if !self.mark_done(ctx, Done { r, x: None, c: false }) {
                return;
            }
            let body = vec![
                ("r".to_string(), CVal::Int(r)),
                ("s".to_string(), CVal::Str(self.key.seed(ctx, r))),
                ("x".to_string(), CVal::Arr(vec![])),
                ("n".to_string(), CVal::Arr(vec![])),
                ("k".to_string(), CVal::Str(self.key.public.clone())),
            ];
            let rec = self.signed("hreveal", ctx, body);
            self.write_session(room, &key, &read.ses_key, 'h', r, rec, writes);
            return;
        }

        // Join the next round, when it asks for no commitment of this house
        // (nor will: the round before is not one of its own still to reveal,
        // whose reveal carries the next commitment).
        let r = read.next_round();
        if settling || r <= done || revealed_now.is_some() || carried(r, self) || joined(r, self) {
            return;
        }
        let mem = &self.rooms[room].tables[&key];
        if mem.written.iter().any(|(_, k, _)| k.starts_with(&format!("o:{r}:"))) {
            return;
        }
        let before = self.commit(ctx, r - 1);
        let to_reveal = r - 1 > done
            && !mem.refused.contains(&(r - 1))
            && read.closes_at(r - 1).any(|c| c.h.as_deref() == Some(before.as_str()) && !mem.blocked.contains(&c.hash));
        if to_reveal {
            return;
        }
        let body = vec![
            ("r".to_string(), CVal::Int(r)),
            ("c".to_string(), CVal::Str(self.commit(ctx, r))),
            ("k".to_string(), CVal::Str(self.key.public.clone())),
        ];
        let rec = self.signed("hcommit", ctx, body);
        self.write_session(room, &key, &read.ses_key, 'o', r, rec, writes);
    }

    #[allow(clippy::too_many_arguments)]
    fn write_session(&mut self, room: &str, table: &(String, String), ses: &str, kind: char, r: i64, rec: CVal, writes: &mut Vec<Write>) {
        let hash = hb::rec_hash(&rec).expect("the house's own records are canonical");
        let key = format!("{kind}:{r}:{hash}");
        let mem = self.rooms.get_mut(room).unwrap().tables.get_mut(table).unwrap();
        mem.written.push((ses.to_string(), key.clone(), rec.clone()));
        writes.push(Write::Session { ses: ses.to_string(), key, value: rec });
    }
}

/// computedTable graceOf: REVEAL_GRACE_MS, stretched by each seed seen
/// inside it to GRACE_PAD_MS past that seed, GRACE_MAX_MS at most.
fn grace_of(t0: u64, times: &mut [u64]) -> u64 {
    times.sort_unstable();
    let mut grace = REVEAL_GRACE_MS;
    for &at in times.iter() {
        let d = at.saturating_sub(t0);
        if d > grace {
            break;
        }
        grace = GRACE_MAX_MS.min(grace.max(d + GRACE_PAD_MS));
    }
    grace
}

fn top_value<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<CVal> {
    match map.get(txn, key) {
        Some(Out::Any(any)) => Some(CVal::from_any(&any)),
        _ => None,
    }
}

/// A record as Yjs holds it: numbers as numbers (never a bigint, which the
/// pages' canon refuses), objects as plain objects.
pub fn to_any(v: &CVal) -> Any {
    match v {
        CVal::Str(s) => Any::String(Arc::from(s.as_str())),
        CVal::Int(i) => Any::Number(*i as f64),
        CVal::Arr(items) => Any::Array(items.iter().map(to_any).collect::<Vec<_>>().into()),
        CVal::Obj(fields) => Any::Map(Arc::new(fields.iter().filter(|(_, v)| *v != CVal::Undef).map(|(k, v)| (k.clone(), to_any(v))).collect())),
        CVal::Undef => Any::Undefined,
        CVal::Junk => Any::Null,
    }
}

/// Write `writes` in one transaction; the update to send (None: nothing).
fn apply(doc: &Doc, writes: &[Write]) -> Option<Vec<u8>> {
    if writes.is_empty() {
        return None;
    }
    let comp = doc.get_or_insert_map(COMPUTED_MAP);
    let mut txn = doc.transact_mut();
    for w in writes {
        match w {
            Write::Top { key, value } => {
                comp.insert(&mut txn, key.as_str(), to_any(value));
            }
            Write::Session { ses, key, value } => {
                if let Some(Out::YMap(m)) = comp.get(&txn, ses) {
                    m.insert(&mut txn, key.as_str(), to_any(value));
                }
            }
        }
    }
    let update = txn.encode_update_v1();
    drop(txn);
    Some(update)
}

// ── The state file ───────────────────────────────────────────────────────────

/// The state file: `{"v": 2, "done": [[room, t, inc, r, x | null, c], …]}`
/// (v 1 rows, `[room, t, inc, r]`, read as having decided nothing to carry on).
fn parse_state(bytes: &[u8]) -> Option<HashMap<(String, String, String), Done>> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let version = v.get("v")?.as_u64()?;
    if version != 1 && version != 2 {
        return None;
    }
    let mut out = HashMap::new();
    for row in v.get("done")?.as_array()? {
        let row = row.as_array()?;
        let (room, t, inc, r) = (row.first()?.as_str()?, row.get(1)?.as_str()?, row.get(2)?.as_str()?, row.get(3)?.as_i64()?);
        let done = if version == 1 {
            (row.len() == 4).then_some(Done { r, x: None, c: false })?
        } else {
            let x = match row.get(4)? {
                serde_json::Value::Null => None,
                x => Some(x.as_str().filter(|x| hex_of(x, 32))?.to_string()),
            };
            (row.len() == 6).then_some(Done { r, x, c: row.get(5)?.as_bool()? })?
        };
        out.insert((room.to_string(), t.to_string(), inc.to_string()), done);
    }
    Some(out)
}

fn write_state(path: &std::path::Path, done: &HashMap<(String, String, String), Done>) -> std::io::Result<()> {
    let mut rows: Vec<_> = done.iter().map(|((room, t, inc), d)| serde_json::json!([room, t, inc, d.r, d.x, d.c])).collect();
    rows.sort_by_key(|row| row.to_string());
    let body = serde_json::to_vec(&serde_json::json!({ "v": 2, "done": rows }))?;
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests;
