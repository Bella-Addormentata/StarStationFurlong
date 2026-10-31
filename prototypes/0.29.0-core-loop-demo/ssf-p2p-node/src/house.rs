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
//!    revealed that round or a later one, or another house of the owner's
//!    has it (a join of that round, a reveal of the round before carrying
//!    one): one house to a round;
//! 2. **watches** each close naming its commitment that the pages' fold
//!    takes as eligible (computedFold compute, step 1: signature checked,
//!    its signer one of the slips it froze, under a parent decided at the
//!    round before or the session itself, naming what its round asks for,
//!    among the first [`MAX_CLOSES_PER_ROUND`] by rank), every delegated
//!    house's reveals, joins and step-downs counted as each signed them; and
//!    after a round a house decided, only the close it decided there has
//!    children (this house's own last decision held in [`STATE_FILE`], so a
//!    deleted reveal or a step-down forgets nothing). It notes when it first
//!    saw each close on its own clock, and when it first saw each frozen
//!    bettor's seed;
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
//!    at a round it joined where another close names nothing (the cheat's
//!    free second look: see a Friendly close's result, then choose), nor
//!    where another house's join is the one the pages name (the lowest);
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
//! Signatures cost: a tick checks at most [`VERIFY_PER_TICK`] it hasn't
//! checked before (the pages' 40 ms slices, casinoDoc computedCheck), and a
//! room or table whose read needed more does nothing that tick, the checks
//! carrying on at the next: a peer's flood of forged records in one room
//! holds the node's loop, and the rooms its lock serves, no longer than a
//! budget a tick. After a tick a read was short, the next starts at the
//! table after the one it started at: a flood at one table holds the
//! room's others back no more than a tick in turn. Only what a table's
//! records name is checked: another house's delegation as its records
//! come, the owner's setting of each house table switched on.
//!
//! The rules are computedFold's (THE HOUSE) and the bytes house_bytes.rs's.
//! The node never decides a round: the pages' fold does, from the records.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use yrs::{Any, Doc, Map, MapRef, Out, ReadTxn, Transact, TransactionMut, WriteTxn};

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
/// the last close it decided there and its reveals in the live session,
/// beside the node's other state files.
pub const STATE_FILE: &str = "house-state.json";
/// The most reveals of a session the state file keeps per table (a session
/// is trimmed at 20 rounds: a reveal and a step-down each, at most).
pub const MAX_KEPT: usize = 64;
/// Signatures a tick of a room checks that it hasn't before (about 15 ms of
/// strict ed25519): past it, what waits on them waits a tick.
pub const VERIFY_PER_TICK: usize = 256;
/// Verdicts kept, the oldest going first.
const MAX_VERDICTS: usize = 50_000;

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

/// Whether Fair setting `a` stands over `b` (both of the owner's shape): a
/// higher `s`, or the same `s` and a higher record hash, as computedHouse
/// fairAfter orders them on every page. Two the owner signed with one
/// number (two pages of theirs) settle on the same one everywhere, and the
/// house puts back the one every page keeps.
fn fair_after(a: &CVal, b: &CVal) -> bool {
    let s = |v: &CVal| v.get("s").and_then(CVal::as_int).unwrap_or(0);
    (s(a), hb::rec_hash(a).unwrap_or_default()) > (s(b), hb::rec_hash(b).unwrap_or_default())
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

/// A house reveal (`h:`) of any house the deed holder delegated, as it
/// signed it: `commit` is the commitment its seed opens.
#[derive(Clone, Debug)]
struct Reveal {
    k: String,
    r: i64,
    hash: String,
    commit: String,
    /// The close it decided (none: a step-down).
    x: Vec<String>,
    n: Vec<String>,
    c: Option<String>,
}

/// A house join (`o:`) of any house the deed holder delegated.
#[derive(Clone, Debug)]
struct Join {
    k: String,
    r: i64,
    hash: String,
    c: String,
}

#[derive(Clone, Debug)]
struct Forfeit {
    hash: String,
    r: i64,
    x: String,
    n: Vec<String>,
    k: String,
    v: CVal,
}

/// How a close on the chain was decided (computedFold decide): by a house's
/// reveal (carrying the commitment the next round must name, if any), or
/// otherwise (a forfeit, every seed in, an abandon).
#[derive(Clone, Debug, PartialEq)]
enum Decision {
    House(Option<String>),
    Other,
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
    /// Closes the pages' fold takes as eligible (computedFold compute, step
    /// 1), by round: signed by one of the slips they freeze, under a parent
    /// decided at the round before (the session, for the first), naming
    /// what their round asks for. After a round a house decided, only the
    /// close it decided has children here: no rival gets a second look.
    closes: Vec<Close>,
    /// The latest round a signed close reaches on a line of them from the
    /// base (each on a close of the round before, decided or not): a round
    /// below it when the house first saw it may be one the pages have moved
    /// past, its void perhaps not here yet (a map's keys arrive in no order).
    top: i64,
    /// close hash → it has a verified abandon.
    abandoned: HashSet<String>,
    /// Every delegated house's reveals and joins, this one's among them.
    reveals: Vec<Reveal>,
    joins: Vec<Join>,
    /// This house's key.
    me: String,
}

impl TableRead {
    fn closes_at(&self, r: i64) -> impl Iterator<Item = &Close> {
        self.closes.iter().filter(move |c| c.r == r)
    }

    /// The round after the last one closed: what the house joins.
    fn next_round(&self) -> i64 {
        self.closes.iter().map(|c| c.r).max().unwrap_or(self.base_u) + 1
    }

    fn own_reveals(&self) -> impl Iterator<Item = &Reveal> {
        self.reveals.iter().filter(|h| h.k == self.me)
    }

    /// computedFold steppedDown: a house's step-down at round r opened `h`.
    fn stepped_down(&self, r: i64, h: &str) -> bool {
        self.reveals.iter().any(|e| e.r == r && e.x.is_empty() && e.commit == h)
    }

    /// Round r's joins that count (not stepped down), lowest hash first: the
    /// pages' close names the first (computedTable, `res.joins[0]`).
    fn joins_at(&self, r: i64) -> Vec<&Join> {
        let mut js: Vec<&Join> = self.joins.iter().filter(|o| o.r == r && !self.stepped_down(r, &o.c)).collect();
        js.sort_by(|a, b| a.hash.cmp(&b.hash));
        js
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
    /// Every house the deed holder delegated, with the key that signed its
    /// delegation, as first verified (pinned while that key holds the deed,
    /// as the pages pin them: casinoDoc housePinned).
    houses: HashMap<String, String>,
    /// The newest owner-signed Fair setting seen per table.
    fair: HashMap<String, CVal>,
    tables: HashMap<(String, String), TableMem>,
    last_beat: Option<u64>,
    beat_n: i64,
    last_reput: Option<u64>,
    /// Which table a tick reads first (in name order, from this one on):
    /// one on from the last after a tick a read was short.
    turn: usize,
}

/// What the house last did at a table, on disk ([`STATE_FILE`]): the highest
/// round it revealed or stepped down; the last round it decided and the
/// close it decided there (a step-down after it keeps them); whether the
/// reveal of round `r` carried the next round's commitment; and its reveals
/// in the live session, as it wrote them. The doc's copy of a reveal can be
/// deleted; the line the round after it must carry on, and the commitment
/// it must name, hold all the same, and after a restart it puts its reveals
/// back as it does during a run (the pages' witnesses do too, for a round
/// they bet in: this is for a round nobody else will).
#[derive(Clone, Debug, Default, PartialEq)]
struct Done {
    r: i64,
    d: Option<(i64, String)>,
    c: bool,
    kept: Vec<Kept>,
}

/// A record the house wrote, with the session it went into and its key.
#[derive(Clone, Debug, PartialEq)]
struct Kept {
    ses: String,
    key: String,
    rec: CVal,
}

type VerdictId = (&'static str, [String; 3], String);

/// The house of this node: its key, what it has revealed, what it has seen.
pub struct House {
    key: HouseKey,
    state_path: Option<PathBuf>,
    /// (room, t, inc) → what it last revealed or stepped down.
    done: HashMap<(String, String, String), Done>,
    rooms: HashMap<String, RoomMem>,
    /// Signature verdicts by kind, room, table, incarnation and record hash
    /// (the signed bytes are bound to each: a copy elsewhere is checked
    /// anew): the latest [`MAX_VERDICTS`], in the order they were given.
    verdicts: HashMap<VerdictId, bool>,
    verdict_order: VecDeque<VerdictId>,
    /// Checks this tick may still make ([`VERIFY_PER_TICK`]; unbounded while
    /// stepping down: the last tick must write what it owes), and whether
    /// one was put off since `deferred` was last cleared.
    budget: usize,
    deferred: bool,
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
            verdict_order: VecDeque::new(),
            budget: VERIFY_PER_TICK,
            deferred: false,
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
    /// once there. None when this tick's checks are spent (`deferred` set):
    /// not known yet.
    fn verified(&mut self, kind: &'static str, at: [&str; 3], hash: &str, k: &str, bytes: Option<[u8; 32]>, g: &str) -> Option<bool> {
        let id = (kind, at.map(str::to_string), hash.to_string());
        if let Some(v) = self.verdicts.get(&id) {
            return Some(*v);
        }
        if self.budget == 0 {
            self.deferred = true;
            return None;
        }
        self.budget -= 1;
        let ok = bytes.is_some_and(|b| hb::verify(k, &b, g));
        if self.verdicts.len() >= MAX_VERDICTS {
            if let Some(old) = self.verdict_order.pop_front() {
                self.verdicts.remove(&old);
            }
        }
        self.verdict_order.push_back(id.clone());
        self.verdicts.insert(id, ok);
        Some(ok)
    }

    /// Whether `k` is a house of room `room` under the deed holder's key
    /// `owner_key`: this one, one pinned so, or one whose delegation
    /// (`hk:<k>`) the doc holds signed by them (pinned from then on). None
    /// while its check waits ([`House::verified`]).
    fn house_of<T: ReadTxn>(&mut self, comp: &MapRef, txn: &T, room: &str, owner_key: &str, k: &str) -> Option<bool> {
        if k == self.key.public || self.rooms.get(room).and_then(|m| m.houses.get(k)).is_some_and(|o| o == owner_key) {
            return Some(true);
        }
        let Some(v) = top_value(comp, txn, &format!("hk:{k}")) else { return Some(false) };
        let shape_ok = has_fields(&v, &["v", "h", "k", "g"], &[])
            && v.get("v").and_then(CVal::as_int) == Some(1)
            && str_of(&v, "h") == Some(k)
            && str_of(&v, "k") == Some(owner_key);
        if !shape_ok {
            return Some(false);
        }
        let hash = hb::rec_hash(&v).unwrap_or_default();
        let g = str_of(&v, "g").unwrap_or("").to_string();
        let ok = self.verified("hkey", [room, "", ""], &hash, owner_key, hb::room_sign_bytes("hkey", room, "", &v), &g)?;
        if ok {
            self.rooms.entry(room.to_string()).or_default().houses.insert(k.to_string(), owner_key.to_string());
        }
        Some(ok)
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
    /// count). Reads the doc and writes what it decided in one transaction:
    /// nothing a peer sent comes between (the node lets the room's lock go
    /// while it ticks, main.rs served_docs).
    pub fn tick(&mut self, room: &str, doc: &Doc, now: u64, wall: u64) -> TickOut {
        self.budget = if self.stepping_down { usize::MAX } else { VERIFY_PER_TICK };
        self.deferred = false;
        let mut txn = doc.transact_mut();
        let writes = self.plan(room, &txn, now, wall);
        let wrote = writes.len();
        TickOut { update: apply(&mut txn, &writes), wrote }
    }

    fn plan<T: ReadTxn>(&mut self, room: &str, txn: &T, now: u64, wall: u64) -> Vec<Write> {
        let mut writes = Vec::new();
        let Some(comp) = txn.get_map(COMPUTED_MAP) else { return writes };
        let pub_key = self.key.public.clone();

        // The deed holder and their key, pinned on first sight.
        let owner = txn.get_map("roomInfo").and_then(|m| match m.get(txn, "owner") {
            Some(Out::Any(Any::String(s))) if !s.is_empty() && &*s != "Local-Clone" => Some(s.to_string()),
            _ => None,
        });
        let Some(owner) = owner else { return writes };
        self.rooms.entry(room.to_string()).or_default();
        let Some(owner_key) = self.pin_of(room, txn, &owner) else { return writes };

        // The delegation: this house's key, signed by the deed holder.
        let deleg_key = format!("hk:{pub_key}");
        let deleg_now = top_value(&comp, txn, &deleg_key);
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
                (self.verified("hkey", [room, "", ""], &hash, &owner_key, bytes, &g) == Some(true)).then(|| v.clone())
            }
            _ => None,
        };
        // (Its check put off: next tick.)
        let Some(delegation) = delegation else { return writes };
        self.rooms.get_mut(room).unwrap().delegation = Some(delegation.clone());

        // Every house the deed holder delegated (another of their nodes is a
        // house of the room as this one is, and its records hold the line,
        // the joins and the step-downs as this one's do) counts as its
        // records come: read_table asks house_of.

        // The switched-on house tables, live.
        let casino = txn.get_map(CASINO_MAP);
        let mut tables: Vec<(String, String)> = Vec::new();
        if let Some(casino) = &casino {
            for (key, out) in casino.iter(txn) {
                let Some(t) = key.strip_prefix("cfg:computed:") else { continue };
                let Out::Any(any) = out else { continue };
                let Some(inc) = switch_inc(&CVal::from_any(&any)) else { continue };
                if house_inc(&inc) && !casino.contains_key(txn, &format!("gone:{t}:{inc}")) {
                    tables.push((t.to_string(), inc));
                }
            }
        }
        tables.sort();

        // The owner's Fair setting of each of them, the one standing over
        // every other seen (fair_after; a new deed holder's count afresh:
        // the last one's settings go).
        self.rooms.get_mut(room).unwrap().fair.retain(|_, v| str_of(v, "k") == Some(owner_key.as_str()));
        for (t, _) in &tables {
            let Some(v) = top_value(&comp, txn, &format!("hf:{t}")) else { continue };
            if !has_fields(&v, &["v", "m", "s", "k", "g"], &[])
                || v.get("v").and_then(CVal::as_int) != Some(1)
                || !matches!(v.get("m").and_then(CVal::as_int), Some(0 | 1))
                || is_round(v.get("s")).is_none()
                || str_of(&v, "k") != Some(owner_key.as_str())
            {
                continue;
            }
            if self.rooms[room].fair.get(t.as_str()).is_some_and(|was| !fair_after(&v, was)) {
                continue;
            }
            let hash = hb::rec_hash(&v).unwrap_or_default();
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if self.verified("hfair", [room, t, ""], &hash, &owner_key, hb::room_sign_bytes("hfair", room, t, &v), &g) == Some(true) {
                self.rooms.get_mut(room).unwrap().fair.insert(t.to_string(), v);
            }
        }
        // (A setting not checked yet: nothing at any table, next tick.)
        if self.deferred {
            return writes;
        }

        let mut fair_tables = 0;
        let mut short = false;
        if !tables.is_empty() {
            let turn = self.rooms[room].turn % tables.len();
            tables.rotate_left(turn);
        }
        for (t, inc) in tables {
            let ctx = Ctx { room: room.to_string(), t: t.clone(), inc: inc.clone() };
            self.deferred = false;
            let Some(read) = self.read_table(&comp, txn, ctx, &owner_key) else { continue };
            let friendly = self.rooms[room].fair.get(&t).and_then(|v| v.get("m").and_then(CVal::as_int)) == Some(1);
            if !friendly {
                fair_tables += 1;
            }
            // (Read short of a check: it does nothing there this tick.)
            if self.deferred {
                short = true;
            } else {
                self.table_duties(room, &read, friendly, now, &mut writes);
            }
        }
        if short {
            let mem = self.rooms.get_mut(room).unwrap();
            mem.turn = mem.turn.wrapping_add(1);
        }

        // The heartbeat, while a table runs Fair.
        let beat_due = self.rooms[room].last_beat.is_none_or(|at| now.saturating_sub(at) >= HEARTBEAT_MS);
        if fair_tables > 0 && !self.stepping_down && beat_due {
            let beat_key = format!("hb:{pub_key}");
            // It counts on from the doc's beat only as it signed it: a peer's
            // copy with a higher count would push its own past what the
            // pages take.
            // (Its check put off: the beat waits a tick.)
            self.deferred = false;
            let in_doc = top_value(&comp, txn, &beat_key)
                .filter(|v| {
                    has_fields(v, &["v", "n", "k", "g"], &[])
                        && v.get("v").and_then(CVal::as_int) == Some(1)
                        && str_of(v, "k") == Some(pub_key.as_str())
                })
                .and_then(|v| {
                    let n = is_round(v.get("n")).filter(|n| *n <= MAX_SAFE)?;
                    let hash = hb::rec_hash(&v)?;
                    let g = str_of(&v, "g").unwrap_or("").to_string();
                    (self.verified("hbeat", [room, "", ""], &hash, &pub_key, hb::room_sign_bytes("hbeat", room, "", &v), &g) == Some(true)).then_some(n)
                })
                .unwrap_or(0);
            let mem = self.rooms.get_mut(room).unwrap();
            let n = (wall.min(MAX_SAFE as u64) as i64).max(in_doc + 1).max(mem.beat_n + 1).min(MAX_SAFE);
            let body = CVal::Obj(vec![("v".into(), CVal::Int(1)), ("n".into(), CVal::Int(n)), ("k".into(), CVal::Str(pub_key.clone()))]);
            if let Some(bytes) = hb::room_sign_bytes("hbeat", room, "", &body).filter(|_| !self.deferred) {
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
                if !same(&top_value(&comp, txn, &key), rec) {
                    writes.push(Write::Top { key, value: rec.clone() });
                }
            }
            for table in mem.tables.values() {
                for (ses, key, value) in &table.written {
                    // There as it wrote it: junk under its key reads as
                    // nothing on every page, and goes too.
                    let present = match comp.get(txn, ses) {
                        Some(Out::YMap(m)) => match m.get(txn, key) {
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
    /// incarnation has ended). `owner_key`: the deed holder's, whose
    /// delegations make the houses (house_of). A check put off on the way
    /// sets `deferred`: the read is short of it.
    fn read_table<T: ReadTxn>(&mut self, comp: &MapRef, txn: &T, ctx: Ctx, owner_key: &str) -> Option<TableRead> {
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
        let me = self.key.public.clone();

        let mut read = TableRead {
            ctx,
            base_u,
            cp_h,
            ses_key,
            slips: HashMap::new(),
            seeds: HashMap::new(),
            closes: Vec::new(),
            top: base_u,
            abandoned: HashSet::new(),
            reveals: Vec::new(),
            joins: Vec::new(),
            me,
        };
        let mut closes: Vec<(Close, CVal)> = Vec::new();
        let mut abandons: Vec<(String, i64, String, CVal)> = Vec::new();
        let mut forfeits: Vec<Forfeit> = Vec::new();
        let mut house_recs: Vec<(char, i64, String, CVal, String)> = Vec::new();
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
                'f' => {
                    // computedFold asForfeit: n sorted, unique, 1–MAX_FROZEN player ids.
                    let n: Option<Vec<String>> = v.get("n").and_then(CVal::as_arr).and_then(|n| {
                        let ids: Option<Vec<String>> = n.iter().map(|p| p.as_str().filter(|p| is_pid(p)).map(str::to_string)).collect();
                        ids.filter(|ids| !ids.is_empty() && ids.len() <= MAX_FROZEN && ids.windows(2).all(|w| w[0] < w[1]))
                    });
                    if has_fields(&v, &["r", "x", "n", "k", "g"], &[]) && g_ok {
                        if let (Some(x), Some(n), Some(k)) = (str_of(&v, "x").filter(|x| hex_of(x, 32)), n, k) {
                            forfeits.push(Forfeit { hash: h.to_string(), r, x: x.to_string(), n, k, v });
                        }
                    }
                }
                'z' => {
                    if has_fields(&v, &["r", "x", "k", "g"], &[]) && g_ok {
                        if let (Some(x), Some(k)) = (str_of(&v, "x").filter(|x| hex_of(x, 32)), k) {
                            abandons.push((x.to_string(), r, k, v));
                        }
                    }
                }
                'h' | 'o' if g_ok => {
                    if let Some(k) = k {
                        if self.house_of(comp, txn, &read.ctx.room, owner_key, &k) == Some(true) {
                            house_recs.push((kind, r, h.to_string(), v, k));
                        }
                    }
                }
                _ => {}
            }
        }

        // The houses' records count as each signed them: a peer's copy under
        // this house's key (a reveal of a high round, say) would stop it
        // joining and revealing; under another's, change what a round may
        // name. Shapes as computedFold asHouseReveal and asHouseCommit.
        let at = [read.ctx.room.clone(), read.ctx.t.clone(), read.ctx.inc.clone()];
        let at = [at[0].as_str(), at[1].as_str(), at[2].as_str()];
        let hexes = |v: &CVal, key: &str, max: usize| -> Option<Vec<String>> {
            let xs: Option<Vec<String>> = v.get(key)?.as_arr()?.iter().map(|x| x.as_str().filter(|x| hex_of(x, 32)).map(str::to_string)).collect();
            xs.filter(|xs| xs.len() <= max && xs.windows(2).all(|w| w[0] < w[1]))
        };
        for (kind, r, hash, v, k) in house_recs {
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if kind == 'h' {
                let (Some(s), Some(x), Some(n)) = (str_of(&v, "s").filter(|s| hex_of(s, 64)), hexes(&v, "x", MAX_CLOSES_PER_ROUND), hexes(&v, "n", MAX_HOUSE_COUNTED)) else {
                    continue;
                };
                let c = v.get("c").map(|c| c.as_str().filter(|c| hex_of(c, 64)).map(str::to_string));
                if !has_fields(&v, &["r", "s", "x", "n", "k", "g"], &["c"]) || c == Some(None) || (x.is_empty() && (!n.is_empty() || c.is_some())) {
                    continue;
                }
                if self.verified("hreveal", at, &hash, &k, hb::sign_bytes("hreveal", &read.ctx, &v), &g) == Some(true) {
                    let commit = hb::house_commit(&read.ctx, r, s);
                    read.reveals.push(Reveal { k, r, hash, commit, x, n, c: c.flatten() });
                }
            } else if let Some(c) = str_of(&v, "c").filter(|c| hex_of(c, 64) && has_fields(&v, &["r", "c", "k", "g"], &[])) {
                let c = c.to_string();
                if self.verified("hcommit", at, &hash, &k, hb::sign_bytes("hcommit", &read.ctx, &v), &g) == Some(true) {
                    read.joins.push(Join { k, r, hash, c });
                }
            }
        }

        // A close counts when it is signed by one of the slips it freezes,
        // that slip as the pages take it (computedFold closeInfo): its
        // signature good, chips on it. One the pages throw out would only
        // void the round's real close if revealed.
        let mut good: Vec<Close> = Vec::new();
        for (c, v) in closes {
            let mut signer = false;
            for (p, sh) in &c.f {
                let Some(s) = read.slips.get(sh) else { continue };
                if s.pid != *p || s.r != c.r || s.k != c.k || !s.chips {
                    continue;
                }
                if self.slip_ok(at, sh, s, &read.ctx) {
                    signer = true;
                    break;
                }
            }
            if !signer {
                continue;
            }
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if self.verified("close", at, &c.hash, &c.k, hb::sign_bytes("close", &read.ctx, &v), &g) == Some(true) {
                good.push(c);
            }
        }

        // The chain as the pages' fold walks it (computedFold compute, step
        // 1): round by round from the base, a close is eligible under a
        // parent decided at the round before (the session, for the first),
        // naming what its round asks for; the first round with nothing
        // decided ends it, and only the first MAX_CLOSES_PER_ROUND by rank
        // take a place. And the house's own rule on top: after a round a
        // house decided, only the close it decided has children (its own
        // memory of it too: a peer can delete the reveal), so no rival gets
        // a second look.
        good.sort_by(|a, b| a.rank.cmp(&b.rank).then_with(|| a.hash.cmp(&b.hash)));
        let sid = read.ses_key.rsplit(':').next().unwrap_or("").to_string();
        let mut line: HashSet<&str> = HashSet::from([sid.as_str()]);
        loop {
            let on: HashSet<&str> = good.iter().filter(|c| c.r == read.top + 1 && line.contains(c.q.as_str())).map(|c| c.hash.as_str()).collect();
            if on.is_empty() {
                break;
            }
            read.top += 1;
            line = on;
        }
        let remembered = self.last_of(&read.ctx).and_then(|d| d.d.clone());
        let mut before: HashMap<String, Decision> = HashMap::new();
        let mut r = read.base_u + 1;
        loop {
            let at_r: Vec<Close> = good.iter().filter(|c| c.r == r).cloned().collect();
            if at_r.is_empty() {
                break;
            }
            let first = r == read.base_u + 1;
            let house_line: Vec<String> = before.iter().filter(|(_, d)| matches!(d, Decision::House(_))).map(|(h, _)| h.clone()).collect();
            let mut here: HashMap<String, Decision> = HashMap::new();
            let mut considered = 0;
            for c in at_r {
                if (first && c.q != sid) || (!first && !before.contains_key(&c.q)) {
                    continue;
                }
                let req = if first {
                    read.cp_h.clone()
                } else {
                    match &before[&c.q] {
                        Decision::House(c) => c.clone(),
                        Decision::Other => None,
                    }
                };
                if !commit_ok(&read, &c, req.as_deref()) {
                    continue;
                }
                if considered >= MAX_CLOSES_PER_ROUND {
                    break;
                }
                considered += 1;
                if !house_line.is_empty() && !house_line.contains(&c.q) {
                    continue;
                }
                if remembered.as_ref().is_some_and(|(dr, x)| *dr == r - 1 && *dr > read.base_u && *x != c.q) {
                    continue;
                }
                if let Some(d) = self.decide(&read, &c, &forfeits, &abandons) {
                    here.insert(c.hash.clone(), d);
                }
                read.closes.push(c);
            }
            if here.is_empty() {
                break;
            }
            before = here;
            r += 1;
        }
        let eligible: HashSet<String> = read.closes.iter().map(|c| c.hash.clone()).collect();
        for (x, r, k, v) in abandons {
            if !eligible.contains(&x) || read.abandoned.contains(&x) {
                continue;
            }
            if self.abandon_ok(at, &read.ctx, r, &k, &v) {
                read.abandoned.insert(x);
            }
        }
        Some(read)
    }

    /// A slip's signature, checked once.
    fn slip_ok(&mut self, at: [&str; 3], hash: &str, s: &Slip, ctx: &Ctx) -> bool {
        let g = str_of(&s.v, "g").unwrap_or("").to_string();
        self.verified("slip", at, hash, &s.k, hb::sign_bytes("slip", ctx, &s.v), &g) == Some(true)
    }

    fn abandon_ok(&mut self, at: [&str; 3], ctx: &Ctx, _r: i64, k: &str, v: &CVal) -> bool {
        let hash = hb::rec_hash(v).unwrap_or_default();
        let g = str_of(v, "g").unwrap_or("").to_string();
        self.verified("abandon", at, &hash, k, hb::sign_bytes("abandon", ctx, v), &g) == Some(true)
    }

    /// Whether close c is decided, and how (computedFold decide): a Fair one
    /// by a house's reveal listing it once every seed it counts is in, a
    /// Friendly one by a forfeit, or by every frozen slip there with its seed;
    /// either by an abandon.
    fn decide(&mut self, read: &TableRead, c: &Close, forfeits: &[Forfeit], abandons: &[(String, i64, String, CVal)]) -> Option<Decision> {
        let ctx = &read.ctx;
        let at = [ctx.room.clone(), ctx.t.clone(), ctx.inc.clone()];
        let at = [at[0].as_str(), at[1].as_str(), at[2].as_str()];
        let craps = craps_inc(&ctx.inc);
        // P, the frozen slips there and good (at roulette with chips on:
        // computedFold frozenOk), and how many aren't (M).
        let mut present: Vec<(String, String, Slip)> = Vec::new();
        let mut missing = 0;
        for (p, sh) in &c.f {
            match read.slips.get(sh) {
                Some(s) if s.pid == *p && s.r == c.r && (craps || s.chips) && self.slip_ok(at, sh, s, ctx) => {
                    present.push((p.clone(), sh.clone(), s.clone()))
                }
                _ => missing += 1,
            }
        }
        let seeded = |p: &str, s: &Slip| read.seeds.get(&(c.r, p.to_string())).is_some_and(|ss| ss.iter().any(|x| hb::slip_commit(ctx, c.r, p, x) == s.c));
        let mut decided = None;
        if let Some(h) = &c.h {
            let mut cands: Vec<&Reveal> = read.reveals.iter().filter(|e| e.r == c.r && e.commit == *h && e.x.contains(&c.hash)).collect();
            cands.sort_by(|a, b| a.hash.cmp(&b.hash));
            if let Some(hr) = cands.first() {
                if present.iter().filter(|(_, sh, _)| hr.n.contains(sh)).all(|(p, _, s)| seeded(p, s)) {
                    decided = Some(Decision::House(hr.c.clone()));
                }
            }
        } else {
            for f in forfeits.iter().filter(|f| f.x == c.hash && f.r == c.r) {
                let in_p = |p: &String| present.iter().find(|(q, _, _)| q == p);
                if !f.n.iter().all(|p| in_p(p).is_some_and(|(q, _, s)| seeded(q, s))) || !f.n.iter().any(|p| in_p(p).is_some_and(|(_, _, s)| s.k == f.k)) {
                    continue;
                }
                let g = str_of(&f.v, "g").unwrap_or("").to_string();
                if self.verified("forfeit", at, &f.hash, &f.k, hb::sign_bytes("forfeit", ctx, &f.v), &g) == Some(true) {
                    decided = Some(Decision::Other);
                    break;
                }
            }
            if decided.is_none() && missing == 0 && present.iter().all(|(p, _, s)| seeded(p, s)) {
                decided = Some(Decision::Other);
            }
        }
        if decided.is_none() {
            for (x, r, k, v) in abandons.iter().filter(|(x, r, _, _)| *x == c.hash && *r == c.r) {
                let _ = x;
                if self.abandon_ok(at, ctx, *r, k, v) {
                    decided = Some(Decision::Other);
                    break;
                }
            }
        }
        decided
    }

    /// Its reveals at table `ctx` in session `ses` so far, and `rec`: the
    /// newest [`MAX_KEPT`].
    fn kept_with(&self, ctx: &Ctx, ses: &str, rec: &CVal) -> Vec<Kept> {
        let mut kept: Vec<Kept> = self.last_of(ctx).map_or(vec![], |d| d.kept.iter().filter(|k| k.ses == ses).cloned().collect());
        let r = rec.get("r").and_then(CVal::as_int).unwrap_or(0);
        let hash = hb::rec_hash(rec).expect("the house's own records are canonical");
        kept.push(Kept { ses: ses.to_string(), key: format!("h:{r}:{hash}"), rec: rec.clone() });
        let over = kept.len().saturating_sub(MAX_KEPT);
        kept.drain(..over);
        kept
    }

    /// One table's join, reveal and step-down.
    fn table_duties(&mut self, room: &str, read: &TableRead, friendly: bool, now: u64, writes: &mut Vec<Write>) {
        let ctx = &read.ctx;
        let done = read.own_reveals().map(|h| h.r).fold(self.done_of(ctx), i64::max);
        let carried = |r: i64, me: &House| {
            let c = me.commit(ctx, r);
            read.own_reveals().any(|h| h.r == r - 1 && h.c.as_deref() == Some(c.as_str()))
                || me.last_of(ctx).is_some_and(|d| d.r == r - 1 && d.c)
                || (r == read.base_u + 1 && read.cp_h.as_deref() == Some(c.as_str()))
        };
        let joined = |r: i64, me: &House| {
            let c = me.commit(ctx, r);
            read.joins.iter().any(|o| o.r == r && o.k == read.me && o.c == c)
        };

        let key = (ctx.t.clone(), ctx.inc.clone());
        let settle_ms = self.settle_ms;
        let kept = self.last_of(ctx).map(|d| d.kept.clone()).unwrap_or_default();
        let mem = self.rooms.get_mut(room).unwrap().tables.entry(key.clone()).or_default();
        if mem.first_read.is_none() {
            // After a start: its reveals from before go back as this run's do.
            for k in kept {
                if !mem.written.iter().any(|(_, key, _)| *key == k.key) {
                    mem.written.push((k.ses, k.key, k.rec));
                }
            }
        }
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
        let mut revealed_now: Option<i64> = None;
        for r in rounds {
            let commit = self.commit(ctx, r);
            let mem = self.rooms.get_mut(room).unwrap().tables.get_mut(&key).unwrap();
            let mut listed: Vec<&Close> = Vec::new();
            for c in read.closes_at(r).filter(|c| c.h.as_deref() == Some(commit.as_str())) {
                if !mem.first_seen.contains_key(&c.hash) {
                    mem.first_seen.insert(c.hash.clone(), now);
                    if settling || read.abandoned.contains(&c.hash) || read.top > r {
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
            // At a round it joined: a Friendly close beside is a choice the
            // house won't hand out (see that close's result, then choose);
            // and of several houses' joins the pages name the lowest, so the
            // round is that one's (no second house's outcome to choose).
            let first_join = read.joins_at(r).first().map(|o| o.c.as_str() == commit);
            if joinable && (read.closes_at(r).any(|c| c.h.is_none()) || first_join != Some(true)) {
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
            let carries = next.is_some();
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
            let kept = self.kept_with(ctx, &read.ses_key, &rec);
            if !self.mark_done(ctx, Done { r, d: Some((r, best.hash.clone())), c: carries, kept }) {
                break;
            }
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
            let body = vec![
                ("r".to_string(), CVal::Int(r)),
                ("s".to_string(), CVal::Str(self.key.seed(ctx, r))),
                ("x".to_string(), CVal::Arr(vec![])),
                ("n".to_string(), CVal::Arr(vec![])),
                ("k".to_string(), CVal::Str(self.key.public.clone())),
            ];
            let rec = self.signed("hreveal", ctx, body);
            // (The close it last decided stays: the round after it carries
            // on that line alone, whatever is deleted.)
            let d = self.last_of(ctx).and_then(|d| d.d.clone());
            let kept = self.kept_with(ctx, &read.ses_key, &rec);
            if !self.mark_done(ctx, Done { r, d, c: false, kept }) {
                return;
            }
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
        // Nor when another of the owner's houses has: it joined the round,
        // or its reveal of the round before carried a commitment no
        // step-down has lifted (one house to a round: two would let a bettor
        // see both outcomes).
        if !read.joins_at(r).is_empty() || read.reveals.iter().any(|h| h.r == r - 1 && h.c.as_deref().is_some_and(|c| !read.stepped_down(r, c))) {
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

/// computedFold commitState: whether close c names what its round asks for,
/// `req` being the commitment required after its parent: that one, unless a
/// step-down lifted it; else nothing, or a join's commitment no step-down
/// opened.
fn commit_ok(read: &TableRead, c: &Close, req: Option<&str>) -> bool {
    if let Some(req) = req.filter(|req| !read.stepped_down(c.r, req)) {
        return c.h.as_deref() == Some(req);
    }
    match &c.h {
        None => true,
        Some(h) => !read.stepped_down(c.r, h) && read.joins.iter().any(|o| o.r == c.r && o.c == *h),
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
fn apply(txn: &mut TransactionMut, writes: &[Write]) -> Option<Vec<u8>> {
    if writes.is_empty() {
        return None;
    }
    let comp = txn.get_or_insert_map(COMPUTED_MAP);
    for w in writes {
        match w {
            Write::Top { key, value } => {
                comp.insert(txn, key.as_str(), to_any(value));
            }
            Write::Session { ses, key, value } => {
                if let Some(Out::YMap(m)) = comp.get(txn, ses) {
                    m.insert(txn, key.as_str(), to_any(value));
                }
            }
        }
    }
    Some(txn.encode_update_v1())
}

// ── The state file ───────────────────────────────────────────────────────────

/// The state file: `{"v": 3, "done": [[room, t, inc, r, dr | null, x | null, c, kept], …]}`,
/// `dr` and `x` the last round decided and its close, `kept` its reveals in
/// the live session (`[ses, key, canon]` each). Older rows read as deciding what their
/// round revealed (v 2, `[room, t, inc, r, x | null, c]`) or nothing to
/// carry on (v 1, `[room, t, inc, r]`), neither keeping a reveal.
fn parse_state(bytes: &[u8]) -> Option<HashMap<(String, String, String), Done>> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let version = v.get("v")?.as_u64()?;
    if !(1..=3).contains(&version) {
        return None;
    }
    let hash = |x: &serde_json::Value| -> Option<Option<String>> {
        match x {
            serde_json::Value::Null => Some(None),
            x => Some(Some(x.as_str().filter(|x| hex_of(x, 32))?.to_string())),
        }
    };
    let kept = |k: &serde_json::Value| -> Option<Kept> {
        let k = k.as_array().filter(|k| k.len() == 3)?;
        let (ses, key) = (k[0].as_str()?, k[1].as_str()?);
        let rec = CVal::from_json(&serde_json::from_str(k[2].as_str()?).ok()?);
        let (kind, _, _, h) = parse_key(key)?;
        (kind == 'h' && ses.starts_with("ses:") && hb::rec_hash(&rec).as_deref() == Some(h)).then(|| Kept { ses: ses.to_string(), key: key.to_string(), rec })
    };
    let mut out = HashMap::new();
    for row in v.get("done")?.as_array()? {
        let row = row.as_array()?;
        let (room, t, inc, r) = (row.first()?.as_str()?, row.get(1)?.as_str()?, row.get(2)?.as_str()?, row.get(3)?.as_i64()?);
        let done = match version {
            1 => (row.len() == 4).then_some(Done { r, ..Done::default() })?,
            2 => {
                let x = hash(row.get(4)?)?;
                (row.len() == 6).then_some(Done { r, d: x.map(|x| (r, x)), c: row.get(5)?.as_bool()?, kept: vec![] })?
            }
            _ => {
                let d = match (row.get(4)?, hash(row.get(5)?)?) {
                    (serde_json::Value::Null, None) => None,
                    (dr, Some(x)) => Some((dr.as_i64().filter(|dr| (1..=r).contains(dr))?, x)),
                    _ => return None,
                };
                let kept: Vec<Kept> = row.get(7)?.as_array()?.iter().map(kept).collect::<Option<_>>()?;
                (row.len() == 8).then_some(Done { r, d, c: row.get(6)?.as_bool()?, kept })?
            }
        };
        out.insert((room.to_string(), t.to_string(), inc.to_string()), done);
    }
    Some(out)
}

fn write_state(path: &std::path::Path, done: &HashMap<(String, String, String), Done>) -> std::io::Result<()> {
    let mut rows: Vec<_> = done
        .iter()
        .map(|((room, t, inc), d)| {
            let (dr, x) = d.d.clone().map_or((None, None), |(dr, x)| (Some(dr), Some(x)));
            let kept: Vec<_> = d.kept.iter().map(|k| serde_json::json!([k.ses, k.key, hb::canon(&k.rec)])).collect();
            serde_json::json!([room, t, inc, d.r, dr, x, d.c, kept])
        })
        .collect();
    rows.sort_by_key(|row| row.to_string());
    let body = serde_json::to_vec(&serde_json::json!({ "v": 3, "done": rows }))?;
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
