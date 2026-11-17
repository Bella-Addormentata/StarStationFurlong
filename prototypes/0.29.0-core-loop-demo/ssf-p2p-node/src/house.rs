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
//!    told to stop ([`step_down`]): a reveal listing no close
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
//! holds the node's loop no longer than a budget a tick. After a tick a
//! read was short, the next starts at the table after the one it started
//! at: a flood at one table holds the room's others back no more than a
//! tick in turn. Only what a table's records name is checked: another
//! house's delegation as its records come, the owner's setting of each house
//! table switched on. And none inside the doc's transaction: a tick reads
//! in passes ([`House::tick`]), each asking for the checks it lacks, which
//! are made with the doc let go, so a room's own sync waits on the house no
//! longer than a read, and another room's not at all (main.rs room_doc).
//!
//! Reading costs too, and a read holds the room's doc: a tick reads at most
//! [`READ_PER_TICK`] of a room, by weight ([`hb::weight`]), the reads past it
//! short as checks past the budget are, so however much junk a peer writes,
//! a tick holds the doc and the house for about that much reading. A record
//! heavier than any the pages take ([`MAX_RECORD_BYTES`], [`MAX_TOP_BYTES`])
//! is junk, found out at the cost of the cap, not of its size; unless what
//! makes it so heavy may be padding a page reads past (an undefined field,
//! a field a typed-array prototype keeps out): then a page may read it
//! light, and the house holds its table while it is there.
//!
//! Stopping ([`step_down`]) steps every room down within a tick's budget
//! first, each room's records sent as they are written, then the rooms
//! that were short of it with every check they need: a flood in one room
//! holds back no other room's step-down. A tick that panics is that room's
//! alone ([`tick_room`]): the other rooms, and the step-down, go on.
//!
//! The rules are computedFold's (THE HOUSE) and the bytes house_bytes.rs's.
//! The node never decides a round: the pages' fold does, from the records.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use yrs::{Any, Doc, Map, MapRef, Out, ReadTxn, Transact, TransactionMut, WriteTxn};

use crate::fold_summary::{GameAnswer, GameAnswers, RoundSummary};
use crate::house_auth as ha;
use crate::house_index::{delegation_of, FairIndex, GameKey, Hk, Kind, Quiet};
use crate::house_bytes::{self as hb, CVal, Ctx, HouseKey};

/// How often the node's loop ticks the house.
pub const TICK_MS: u64 = 200;
/// computedHouse HEARTBEAT_MS.
pub const HEARTBEAT_MS: u64 = 5_000;
/// computedTable REPUT_MS: how often what was taken away is put back.
pub const REPUT_MS: u64 = 1_000;

/// 🔒 casinoDoc FORGED_DELETE_MAX: how many forged records of FAIR ONLY games one pass deletes (a write is one
/// update, and a flood is thousands).
pub const FORGED_DELETE_MAX: usize = 256;
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
/// 🔒 How long a house goes unheard before the pages take it as away (computedHouse HOUSE_HEARD_MS): a house that
/// was not ticked in a room for that long settles at each FAIR ONLY game there again, so it reads before it reveals.
pub const HOUSE_HEARD_MS: u64 = 15_000;
/// 🔒 How far past its base a FAIR ONLY game's rounds may run (computedFold MAX_HELD_ROUNDS): a close past it is junk.
pub const MAX_HELD_ROUNDS: i64 = 40;
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
/// 🔒 The last checkpoint the house signed for each FAIR ONLY game, beside the state file (design-final section 8.5 N5):
/// put back while no checkpoint stands above it.
pub const ROWS_FILE: &str = "house-checkpoints.json";
/// 🔒 The trim of a FAIR ONLY game (design-final section 8.5 N3; computedSimHouse.ts, the pages' computedTable): after
/// the reveal or abandon that decided the round it trims to, inside the time a page would wait for a frozen slip a witness
/// puts back.
pub const HOUSE_TRIM_AFTER_MS: u64 = 2_500;
/// A decided round's frozen slip that is missing is waited for this long (the pages' MISSING_WAIT_MS), and so is a round
/// this house revealed that does not read as it decided it.
pub const MISSING_WAIT_MS: u64 = 30_000;
/// The pressures (computedTable TRIM_ROUNDS, TRIM_BYTES, ROOM_BYTES, ROOM_MIN_BYTES, the seven-out's least, idle):
/// a trim waits for one of them.
pub const HOUSE_TRIM_ROUNDS: i64 = 20;
pub const HOUSE_TRIM_BYTES: i64 = 96 * 1024;
pub const HOUSE_ROOM_BYTES: i64 = 384 * 1024;
pub const HOUSE_ROOM_MIN_BYTES: i64 = 24 * 1024;
pub const HOUSE_SEVEN_OUT_MIN: i64 = 8;
pub const HOUSE_IDLE_MS: u64 = 60_000;
/// …and junk (design-final section 8.9 SWEEP_BYTES): what the session weighs past what the fold kept.
pub const HOUSE_SWEEP_BYTES: i64 = 48 * 1024;
/// Signatures a tick of a room checks that it hasn't before (about 15 ms of
/// strict ed25519): past it, what waits on them waits a tick.
pub const VERIFY_PER_TICK: usize = 256;
/// A tick's passes: a slip, then a close it signed, then a forfeit of it,
/// then what the house does, all in a tick; anything deeper waits a tick.
pub const MAX_PASSES: usize = 4;
/// The step-down's last word reads on deeper than that ([`step_down`]).
const MAX_PASSES_STOPPING: usize = 64;
/// Verdicts kept, the oldest going first.
const MAX_VERDICTS: usize = 50_000;
/// The most a session's record may weigh ([`hb::weight`]) and be read:
/// past it, junk. The heaviest the pages take, a close freezing 31 slips
/// under 256-character ids, weighs some 26 KB (tests pin it).
pub const MAX_RECORD_BYTES: usize = 64 * 1024;
/// The same for a switch, a Fair setting, a delegation and a heartbeat (a
/// few hundred bytes each).
pub const MAX_TOP_BYTES: usize = 4 * 1024;
/// What a tick reads of a room, by weight ([`hb::weight`], and
/// [`VISIT_BYTES`] a key): the casino's keys and switches, the Fair
/// settings, each table's checkpoint and session, other houses'
/// delegations. Past it, what is left to read is short and waits a tick, as
/// checks past [`VERIFY_PER_TICK`] do: however big a peer's junk grows, a
/// tick holds the room's doc and the house for about this much reading
/// (some 20 ms), and the room's other tables have their turns. A checkpoint
/// weighing more is never read (the house does nothing at its table); the
/// pages trim a session at 96 KB.
pub const READ_PER_TICK: usize = 4 * 1024 * 1024;
/// What reading a key costs on top of its value's weight.
pub const VISIT_BYTES: usize = 64;
/// The longest key a session's record goes under (its kind, round, a pid
/// of 256 UTF-16 units, at most 3 bytes each, and hash: some 820 bytes):
/// a longer one is no record's, and nothing reads its bytes.
pub const MAX_KEY_BYTES: usize = 1_024;

pub(crate) const CASINO_MAP: &str = "casino";
pub(crate) const COMPUTED_MAP: &str = "casinoComputed";

// ── Shapes (computedFold / computedHouse guards, as far as the house reads) ──

pub(crate) fn hex_of(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn b64url_of(s: &str, n: usize) -> bool {
    s.len() == n && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub(crate) fn is_pub(s: &str) -> bool {
    b64url_of(s, 43)
}

pub(crate) fn is_sig(s: &str) -> bool {
    b64url_of(s, 86)
}

/// casinoDoc isPlayerKey: 1–256 UTF-16 units, not `__proto__`.
pub(crate) fn is_pid(s: &str) -> bool {
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
pub(crate) fn has_fields(v: &CVal, required: &[&str], optional: &[&str]) -> bool {
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

/// The game of an incarnation (computedFold gameOfInc): `k…`, `d…` and 🔒 a FAIR ONLY game's `q…` craps.
fn craps_inc(inc: &str) -> bool {
    inc.starts_with('k') || inc.starts_with('d') || inc.starts_with('q')
}

/// computedFold houseRules: `r…` and `d…` are house tables.
fn house_inc(inc: &str) -> bool {
    (inc.starts_with('r') || inc.starts_with('d')) && inc.len() == HOUSE_INC_BYTES && hex_of(&inc[1..], 24)
}

/// A house table's `inc`: its letter and 24 hex digits.
const HOUSE_INC_BYTES: usize = 25;

/// A switch as casinoDoc computedCfgInc reads it: an object, not an
/// array, whose own keys (`Object.keys`, which lists an undefined one too)
/// are `v`, 1, and `inc`, a string, and nothing else. None, too, for one
/// holding a `__proto__` field, whatever it holds: a page's decoder makes
/// it an own key or not as the update had it (`o.__proto__ = x` sets the
/// prototype; after an earlier `__proto__: null` in the same map, it makes
/// a field), and the node, keeping one entry per key, can't tell. Such a
/// switch is no honest page's: the house serves nothing there, as where
/// the pages find `v` or `inc` through such a prototype, not their own
/// (TODO). It costs the same however big the switch is ([`SWITCH_BYTES`]):
/// it counts no keys and reads no string longer than a house's `inc`.
fn switch_of(v: &Any) -> Option<String> {
    let Any::Map(m) = v else { return None };
    if m.len() != 2 || !matches!(m.get("v"), Some(Any::Number(n)) if *n == 1.0) {
        return None;
    }
    // (UTF-8 before anything slices it; [`house_inc`] reads the rest.)
    match m.get("inc") {
        Some(Any::String(inc)) if inc.len() == HOUSE_INC_BYTES && hb::utf8(inc) => Some(inc.to_string()),
        _ => None,
    }
}

/// What reading a switch costs a tick, past its key (it weighs some 50).
const SWITCH_BYTES: usize = 64;

/// Whether Fair setting `a` stands over `b` (both of the owner's shape): a
/// higher `s`, or the same `s` and a higher record hash, as computedHouse
/// fairAfter orders them on every page. Two the owner signed with one
/// number (two pages of theirs) settle on the same one everywhere, and the
/// house puts back the one every page keeps.
fn fair_after(a: &CVal, b: &CVal) -> bool {
    let s = |v: &CVal| v.get("s").and_then(CVal::as_int).unwrap_or(0);
    (s(a), hb::rec_hash(a).unwrap_or_default()) > (s(b), hb::rec_hash(b).unwrap_or_default())
}

/// computedCraps CARRY_POINTS (0: no point), MAX_RIDERS and MAX_SHOOTER_PID.
const CARRY_POINTS: &[i64] = &[0, 4, 5, 6, 8, 9, 10];
const MAX_RIDERS: usize = 31;
const MAX_SHOOTER_PID: usize = 128;

/// computedFold isCarry: a craps checkpoint's carry, held to every rule
/// CrapsCarry states. The point one of CARRY_POINTS; at most MAX_RIDERS
/// riders, each a player id with a canonical felt that has chips on it
/// (every rider Object.keys lists: an undefined one has no felt); a shooter
/// `h` and a last shooter `a` that are player ids of at most
/// MAX_SHOOTER_PID UTF-16 units; `i` only as 1, and only with a shooter.
pub(crate) fn is_carry(v: &CVal) -> bool {
    if !has_fields(v, &["p", "w"], &["h", "a", "i"]) || !v.get("p").and_then(CVal::as_int).is_some_and(|p| CARRY_POINTS.contains(&p)) {
        return false;
    }
    let Some(w) = v.get("w").and_then(CVal::entries) else { return false };
    if w.len() > MAX_RIDERS || !w.iter().all(|(pid, f)| is_pid(pid) && f.as_arr().is_some_and(|f| !f.is_empty() && felt_ok(true, f))) {
        return false;
    }
    let shooter = |k: &str| match v.get(k) {
        None => true,
        Some(x) => x.as_str().is_some_and(|x| is_pid(x) && x.encode_utf16().count() <= MAX_SHOOTER_PID),
    };
    let i_ok = match v.get("i") {
        None => true,
        Some(i) => i.as_int() == Some(1) && v.get("h").is_some(),
    };
    shooter("h") && shooter("a") && i_ok
}

/// A checkpoint as computedFold asCheckpointFor reads it: its shape; a
/// house commitment `h` only on a live one at a house table; at craps the
/// carry `s` (isCarry) on a live one and none on an ended one; every net
/// Object.keys lists (an undefined one is no net). The house reads the
/// checkpoints the pages read, and no other: one they throw out is no base.
pub(crate) fn checkpoint_ok(v: &CVal, inc: &str) -> bool {
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
        if ended || !house_inc(inc) || !h.as_str().is_some_and(|h| hex_of(h, 64)) {
            return false;
        }
    }
    if craps && (ended != v.get("s").is_none() || v.get("s").is_some_and(|s| !is_carry(s))) {
        return false;
    }
    let net = |s: &str| {
        let d = s.strip_prefix('-').unwrap_or(s);
        !d.is_empty() && d.len() <= 40 && !d.starts_with('0') && d.bytes().all(|b| b.is_ascii_digit())
    };
    match v.get("n").and_then(CVal::entries) {
        Some(n) => n.len() <= 4_096 && n.iter().all(|(pid, x)| is_pid(pid) && x.as_str().is_some_and(net)),
        None => false,
    }
}

/// computedFold asForfeit's `n`: 1–MAX_FROZEN player ids, strictly
/// ascending as the pages compare strings, by UTF-16 code units (not by
/// bytes: an astral pid sorts below one in U+E000–U+FFFF there).
fn forfeit_ids(v: &CVal) -> Option<Vec<String>> {
    let ids: Vec<String> = v.get("n")?.as_arr()?.iter().map(|p| p.as_str().filter(|p| is_pid(p)).map(str::to_string)).collect::<Option<_>>()?;
    let ascending = ids.windows(2).all(|w| w[0].encode_utf16().cmp(w[1].encode_utf16()) == std::cmp::Ordering::Less);
    (!ids.is_empty() && ids.len() <= MAX_FROZEN && ascending).then_some(ids)
}

/// computedFold asClose's `f`: 1–MAX_FROZEN entries, each a player id and
/// the hash of the slip frozen (every entry Object.keys lists: an
/// undefined one is no hash).
fn close_frozen(v: &CVal) -> Option<Vec<(String, String)>> {
    let fs = v.get("f")?.entries()?;
    if fs.is_empty() || fs.len() > MAX_FROZEN {
        return None;
    }
    fs.iter().map(|(p, x)| x.as_str().filter(|x| is_pid(p) && hex_of(x, 32)).map(|x| (p.clone(), x.to_string()))).collect()
}

/// A record's key parts (computedFold parseKey): kind, round, pid (s and x), hash.
pub(crate) fn parse_key(key: &str) -> Option<(char, i64, Option<&str>, &str)> {
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

/// 🔒 A checkpoint's round and sweeps at it (`u`, `w`): the higher stands above.
fn uw_of(ck: &CVal) -> (i64, i64) {
    let int = |k: &str| ck.get(k).and_then(CVal::as_int).unwrap_or(0);
    (int("u"), int("w"))
}

/// A record's key is its body's own: the round, the player (where the key names one) and the hash it names are the
/// body's.
fn key_is_own(r: i64, pid: Option<&str>, h: &str, v: &CVal) -> bool {
    is_round(v.get("r")) == Some(r) && hb::rec_hash(v).as_deref() == Some(h) && pid.is_none_or(|pid| str_of(v, "p") == Some(pid))
}

/// 🔒 Whether `v`, under key `key` of a session, is a record there as the house reads one: a key a record goes under
/// ([`parse_key`]) that is the body's own. Anything else is junk on every page. (The mirror keeps the same, for the
/// digest an answer of the fold carries, `fold_summary::records_digest`.)
#[cfg_attr(not(feature = "house-fold"), allow(dead_code))]
pub(crate) fn own_record(key: &str, v: &CVal) -> bool {
    key.len() <= MAX_KEY_BYTES && hb::utf8(key) && parse_key(key).is_some_and(|(_, r, pid, h)| key_is_own(r, pid, h, v))
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
    /// (round, pid) → the commitments of slips there its seeds open: each
    /// seed hashed once, and only for a round and player a slip here has
    /// ([`TableRead::opens`]).
    opened: HashMap<(i64, String), HashSet<String>>,
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
    /// 🔒 At a FAIR ONLY game, the keys under which the session holds its own record ([`own_record`]), as read clear, and
    /// how many keys it holds in all: what the trim holds the fold's answer to ([`House::trim_duty`]).
    records: Vec<String>,
    keys: usize,
    /// This house's key.
    me: String,
}

impl TableRead {
    /// A read that stopped before it began (this tick's reads spent): the
    /// table does nothing with it.
    fn short(ctx: Ctx, me: String) -> Self {
        TableRead {
            ctx,
            base_u: 0,
            cp_h: None,
            ses_key: String::new(),
            slips: HashMap::new(),
            seeds: HashMap::new(),
            opened: HashMap::new(),
            closes: Vec::new(),
            top: 0,
            abandoned: HashSet::new(),
            reveals: Vec::new(),
            joins: Vec::new(),
            records: Vec::new(),
            keys: 0,
            me,
        }
    }

    /// Whether a seed here opens slip `s` (its round and player's).
    fn opens(&self, s: &Slip) -> bool {
        self.opened.get(&(s.r, s.pid.clone())).is_some_and(|cs| cs.contains(&s.c))
    }

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

    /// Whether some house's commitment is still outstanding at round `r`:
    /// the one a close of `r` must name, as the pages' fold takes it. After
    /// a reveal of round `r - 1` that carried one, it is that one, unless a
    /// step-down at `r` opened it. At the first round past a checkpoint it
    /// is the checkpoint's `h` and no reveal in the session: a trim copies
    /// round u's house reveal into the next session, but not a step-down at
    /// u + 1 that lifted the commitment the reveal carried, and then writes
    /// no `h`, so the copy would make a lifted commitment look outstanding
    /// (and one that a v0.50 trim did not copy, a missing one).
    fn outstanding(&self, r: i64) -> bool {
        if r == self.base_u + 1 {
            return self.cp_h.as_deref().is_some_and(|c| !self.stepped_down(r, c));
        }
        self.reveals.iter().any(|h| h.r == r - 1 && h.c.as_deref().is_some_and(|c| !self.stepped_down(r, c)))
    }

    /// Round r's joins that count (not stepped down), lowest hash first: the
    /// pages' close names the first (computedTable, `res.joins[0]`).
    fn joins_at(&self, r: i64) -> Vec<&Join> {
        let mut js: Vec<&Join> = self.joins.iter().filter(|o| o.r == r && !self.stepped_down(r, &o.c)).collect();
        js.sort_by(|a, b| a.hash.cmp(&b.hash));
        js
    }
}

/// What a pass found of the room's house tables ([`House::house_tables`]).
enum Tables {
    /// This house is none of the room's.
    None,
    /// The pass could not read the room: nothing more there this pass.
    Stop,
    Some(HouseTables),
}

/// The room's house tables as a pass served them: how many run Fair, and this house's delegation, as the doc holds
/// it under its key and as the house holds it.
struct HouseTables {
    fair: usize,
    deleg_now: Option<CVal>,
    deleg_clear: bool,
    delegation: CVal,
}

/// 🔒 The room's FAIR ONLY games as a pass served them: how many this house serves now, and at how many of those it
/// has settled (the ones it beats for).
#[derive(Default)]
struct GamesOut {
    settled: usize,
    serving: usize,
    /// 🔒 What the doc lost of the games the walk read, and their forged records: written at the put-back's turn of
    /// the same pass ([`REPUT_MS`]), else let go (the next walk finds them again).
    reput: Vec<Write>,
}

/// What a table's live session continues from: at a house table its `sum:` checkpoint (none: the incarnation's first
/// session), at a FAIR ONLY game the checkpoint its resolution chose.
struct Base {
    u: i64,
    h: Option<String>,
    sid: String,
}

/// Who the houses of a table are: at a house table every house the deed holder (their key) delegated, whatever the
/// round; at a FAIR ONLY game those its resolution gives, round by round (the key that holds the game for a round
/// delegated them).
enum Houses<'a> {
    Deed(&'a str),
    /// A FAIR ONLY game's resolution, and the room's delegations as its index holds them ([`delegation_of`]).
    Game(&'a ha::Resolution, &'a std::collections::BTreeMap<String, Hk>),
}

/// 🔒 What a FAIR ONLY game's resolution says of the rounds this house may act at, asked before anything is written
/// (a check put off in the middle of a reveal would leave out the commitment it carries).
struct GameView {
    /// The rounds this house decides: its delegator holds the game for them.
    mine: HashSet<i64>,
    /// The other houses that decide the round before the open one.
    houses_before: HashSet<String>,
    /// Whether the key that holds the game now delegated this house: only then does it join.
    joins: bool,
}

/// What a tick writes into a room, in one transaction.
#[derive(Clone, Debug, PartialEq)]
pub enum Write {
    /// A record into a session map (`ses:<t>:<inc>:<sid>`).
    Session { ses: String, key: String, value: CVal },
    /// A top-level casinoComputed key (a heartbeat, a put-back room record).
    Top { key: String, value: CVal },
    /// 🔒 A FAIR ONLY game's live session map (`ses:<t>:<inc>:<sid>`), empty, where the doc holds no map under its key:
    /// the doc lost it (design-final section 8.5 N5).
    NewSession { ses: String },
    /// 🔒 A top-level key deleted: a FAIR ONLY game's forged record (its own signature fails under the key it claims,
    /// design-final section 8.4 P7, as the pages delete them).
    Delete { key: String },
    /// 🔒 A FAIR ONLY game's trim (design-final section 8.5 N3), in one transaction: its checkpoint `key` (where nothing is
    /// under the key yet), every key in `gone` deleted but that one (the game's other checkpoints and its sessions), and
    /// the session the checkpoint opens, `ses`, made anew with `copies` in it.
    Trim { key: String, value: CVal, gone: Vec<String>, ses: String, copies: Vec<(String, CVal)> },
    /// 🔒 A FAIR ONLY game's last checkpoint this house signed, put back from its row (design-final section 8.5 N5): with
    /// `ck`, the checkpoint under `key`; and with `ses` (the session it opens, the session it closed, and what its trim
    /// carried), that session made, where the doc holds no map under its key, with each record its trim carried that the
    /// closed session holds still. The closed session is there only where the trim's deletes never landed: the doc lost
    /// the trim (the node stopped before it saved it, and no page had it, or a page put back only its checkpoint), and
    /// what the trim carried out of the closed session would else be left behind in it. Without `ck`: only the session,
    /// of a checkpoint the doc holds.
    Restore { key: String, value: CVal, ck: bool, ses: Option<(String, String, Vec<(String, CVal)>)> },
}

/// 🔒 A row of [`ROWS_FILE`]: the last checkpoint this house signed for a FAIR ONLY game, its key and value, and what
/// the trim that signed it carried into the session it opens ([`Write::Restore`]).
#[derive(Clone, Debug, PartialEq)]
struct Row {
    key: String,
    value: CVal,
    copies: Vec<(String, CVal)>,
}

// ── Memory ───────────────────────────────────────────────────────────────────

#[derive(Default)]
struct TableMem {
    /// When this house first saw each close naming its commitment, and
    /// when the ticks it held the table just before began, if it did (else
    /// the same): the grace runs from the first, [`REVEAL_CUTOFF_MS`] from
    /// the second ([`TableMem::held_since`]).
    first_seen: HashMap<String, (u64, u64)>,
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
    /// Whether its reveals from before a start ([`Done::kept`]) went into
    /// `written`: the first time it reads the table, or holds it
    /// ([`House::own_from_before`]).
    kept_in: bool,
    /// When it first read the table this run ([`SETTLE_MS`]). 🔒 At a FAIR ONLY game, when it first read the game's
    /// session after it was last away from it: cut off for [`HOUSE_HEARD_MS`], or not serving the games.
    first_read: Option<u64>,
    /// 🔒 At a FAIR ONLY game, as the last pass that knew whether this house serves it found it: whether it served
    /// it, and whether it had settled there (none: no pass of this run has; [`House::remembered`]).
    read_through: Option<(bool, bool)>,
    /// When the ticks it last held the table (a value there a page may read
    /// otherwise, [`House::unclear`]) began: a close it first sees once they
    /// are over counts as there since then for [`REVEAL_CUTOFF_MS`], which
    /// so still bounds how long a close it reveals has been there (the
    /// pages void it). Its grace still runs from when the house saw it: a
    /// hold never cuts a seed's time. 🔒 At a FAIR ONLY game, also when the spell it last served none of the game's
    /// rounds began, or the last spell its session's map was gone, or the last it found the game with no base (or over,
    /// or under rules this build does not know).
    held_since: Option<u64>,
    /// 🔒 At a FAIR ONLY game, the delegation it was last a house of the game by: given to the resolution after the
    /// room's, so it counts while the doc lacks it, as the pages hold the delegations a count goes by. For the run.
    deleg: Option<CVal>,
    /// 🔒 And the ones it was a house of the game by for its other holders, one each (the last it went by), while
    /// they are holders of the game: given to the resolution with it. After a hand-over at the round in flight, that
    /// round is still the seller's, and its reveal counts by the seller's delegation, which the doc's key may no
    /// longer hold (the buyer's is written over it) and the base need not carry; the pages keep both (casinoDoc
    /// keepHouses). At most one per holder the game has had. For the run.
    earlier: Vec<CVal>,
    /// 🔒 Whether that delegation wants this house's key (design-final section 8.5 N5): the game's base does not carry
    /// it, and the house served the game by it when a pass last found whether it serves the game at all. (Not when it
    /// found the game over, or that the house serves none of its rounds.)
    keyed: bool,
    /// 🔒 At a FAIR ONLY game, when each close was decided, as this house saw it: its own reveal, as it wrote it; an
    /// abandon, as its trim first read the close decided by one ([`HOUSE_TRIM_AFTER_MS`]). For the live session.
    decided_at: HashMap<String, u64>,
    /// 🔒 When it first read each thing a checkpoint waits for ([`House::waits_on`]).
    waits: HashMap<String, u64>,
    /// 🔒 How many keys the live session held as last read, and when one last came ([`HOUSE_IDLE_MS`]).
    keys: usize,
    last_new_key: Option<u64>,
    /// 🔒 The session's kept bytes as the fold last said (the room's pressure, [`HOUSE_ROOM_BYTES`]).
    kept: i64,
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
    /// 🔒 When the room was last ticked ([`HOUSE_HEARD_MS`]).
    last_tick: Option<u64>,
    /// Which table a tick reads first (in name order, from this one on):
    /// one on from the last after a tick a read was short.
    turn: usize,
    /// What the last pass found for the node's fold in shadow
    /// ([`House::fold_plan`]): None while the room has no verified delegation of
    /// this house. A pass that could not finish reading (its reads spent before
    /// every switch was seen, or a check put off) keeps the plan of the one
    /// before, not complete: it says nothing of the room, which is no word that
    /// the tables have gone.
    fold: Option<FoldPlan>,
    /// Some tick ended with the room having no plan while other houses were pinned in it: the deed holder was one
    /// that had not delegated this house (or its delegation was not verified), and nothing watched what the
    /// delegations did meanwhile. The houses pinned here stay pinned (as the pages pin them), and a page that binds
    /// afterwards counts only those whose delegation the doc holds then, so the houses of a plan that comes after
    /// ([`HousePlan::gapped`]) may be more than the ones a page counts. For the run.
    gapped: bool,
    /// 🔒 The keys of the room's FAIR ONLY records, kept from the doc's changes while this house serves the games
    /// (house_index.rs): what the walk reads them from.
    index: Option<FairIndex>,
    /// 🔒 The FAIR ONLY games whose memory says this house served them when a pass last found whether it does
    /// ([`TableMem::read_through`]), and the ones whose delegation wants this house's key ([`TableMem::keyed`]): kept as
    /// those are, so a pass counts the games for the room's beat, and picks what goes under the key, without going
    /// through every table it holds memory of (one for each game it ever held, junk among them).
    serving_games: BTreeSet<GameKey>,
    keyed_games: BTreeSet<GameKey>,
    /// 🔒 What the node's fold in shadow follows of each FAIR ONLY game this house serves ([`GamePlan`]), as the last
    /// pass that read the game's session through found it: kept while the passes after it cannot read the game (a check
    /// put off, a record a page may read otherwise, the tick's reads spent), and gone once a pass finds the game is not
    /// this house's, or has no base or no session to follow, or the doc holds no record of it.
    game_plans: BTreeMap<GameKey, GamePlan>,
}

impl RoomMem {
    /// 🔒 The house was away from the room's FAIR ONLY games (cut off for [`HOUSE_HEARD_MS`], or not serving them):
    /// it settles at each again from the next pass that reads its session, as what it reads until then it has not
    /// read since, and is settled there only once a pass reads it through.
    fn settle_games_again(&mut self) {
        for (key, table) in self.tables.iter_mut() {
            if ha::is_fair_only_inc(&key.1) {
                table.first_read = None;
                if let Some((_, settled)) = table.read_through.as_mut() {
                    *settled = false;
                }
            }
        }
    }
}

/// The house tables a pass found in a room it is delegated a house of, and
/// the deed holder's key they stand under.
#[derive(Clone, Debug, PartialEq)]
struct FoldPlan {
    /// The deed holder, as the room's `roomInfo` named them when the pass read it ([`deed_of`]), and the key they stand under.
    owner: String,
    owner_key: String,
    tables: Vec<(String, String)>,
    /// The tick that found it read everything it wanted of the room without
    /// waiting on a check or running out of reads (`TickOut::short` unset),
    /// and held no table of it over a value a page may read otherwise, nor
    /// found a house's delegation so: the houses it verified are then every
    /// one the room's records name.
    complete: bool,
}

/// What the house found in a room for the node's fold in shadow
/// (fold_shadow.rs): the house tables to follow `(t, inc)`, and the keys of
/// the houses the fold counts (this one, and every other the deed holder
/// delegated that this house has verified). The players' keys are not here:
/// the shadow watches the players itself (fold_pins.rs), so that following a
/// room reads no doc under the house's lock and writes nothing the house
/// decides by.
#[derive(Clone, Debug, PartialEq)]
pub struct HousePlan {
    /// The deed holder the houses stand under, as `roomInfo` named them when the pass read it: the pages count a house
    /// by the delegations of whoever holds the deed, so a plan is a plan of one holder's houses, and the shadow, which
    /// watches the deed itself (fold_pins.rs), holds it against a trim only while the doc names them still.
    pub owner: String,
    /// The key the pass pinned for that holder, whose delegations name the houses: the shadow holds the plan against a
    /// trim only while its own watch of the players has the same key pinned for them (a holder whose key was replaced
    /// between the pass's pin and the watch's, or a first key seen at different times, is another set of houses).
    pub owner_key: String,
    pub tables: Vec<(String, String)>,
    pub houses: Vec<String>,
    /// The houses are every one the room's records name: the pass that found
    /// the tables read the whole room, and held no table (nor found a
    /// delegation) over a value a page may read otherwise. A fold of a room
    /// whose houses are not all known can leave out a close a page counts, so
    /// it is not held against a checkpoint.
    pub complete: bool,
    /// The room had a stretch with no plan while other houses were pinned in it (`RoomMem::gapped`): a delegation
    /// may have been withdrawn in it, which nothing watched, and the houses here, which are pinned for the run, may be
    /// more than a page that binds now counts. The shadow takes the room's delegations as churned.
    pub gapped: bool,
    /// 🔒 The FAIR ONLY games this house serves, whoever holds the deed ([`GamePlan`]): followed by the fold, whose answer
    /// is kept for the house's trim (design-final section 8.5 N3; nothing is compared with the pages, nor signed, yet).
    pub games: Vec<GamePlan>,
}

/// 🔒 A FAIR ONLY game this house serves, as the fold in shadow follows it: the base the authority resolver chose, the
/// session that follows it, and who the game's houses are by round. A game's houses are no set of the room's: each is a
/// house of the rounds a holder of the game delegated it for (house_auth.rs `house_by`), and the fold is told so.
#[derive(Clone, Debug, PartialEq)]
pub struct GamePlan {
    pub t: String,
    pub inc: String,
    /// The rules version the game's name binds.
    pub rv: String,
    /// The base: the doc key of its checkpoint (`ck:<t>:<inc>:<id>`), and the checkpoint.
    pub base_key: String,
    pub base: CVal,
    /// The id of the session that follows the base (`ses:<t>:<inc>:<sid>`).
    pub sid: String,
    /// `(key, from, to)`: the key is a house of each round r with from < r <= to (no `to`: every round after `from`),
    /// for this house and every house whose join or reveal the session holds, as the pass found them.
    pub spans: Vec<(String, i64, Option<i64>)>,
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

/// 🔒 What the house did at FAIR ONLY games, for the fingerprint: trims written, trims its cross-check refused to sign
/// (the fold's answer disagreed with what the house knows of the round, or the checkpoint would not read as the game's
/// base), and its checkpoints put back.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GameCounts {
    pub trims: u64,
    pub cross_check_mismatches: u64,
    pub row_put_backs: u64,
}

/// 🔒 What a trim of a FAIR ONLY game goes by, of the walk's: its base, the delegation this house serves it by now, the
/// transfers its chain counts, the round its holder holds it from, the houses by round of this pass's plan, and what the
/// trim deletes (the game's checkpoints, and the sessions of each it read).
struct TrimOf<'a> {
    base: &'a ha::Counted,
    dl: &'a CVal,
    x: Vec<CVal>,
    from: i64,
    spans: &'a [(String, i64, Option<i64>)],
    gone: Vec<String>,
}

/// 🔒 What [`House::trim_duty`] came to: whether a check it asked for was put off (the game is read again).
#[derive(Debug, PartialEq, Eq)]
enum Trimmed {
    Done,
    Wait,
}

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
    /// Checks this tick may still ask for ([`VERIFY_PER_TICK`]; unbounded
    /// in the step-down's last word), and whether one was put off since
    /// `deferred` was last cleared.
    budget: usize,
    deferred: bool,
    /// What this tick may still read ([`READ_PER_TICK`]; unbounded in the
    /// step-down's last word), and whether a read found it spent.
    read_left: usize,
    read_out: bool,
    /// Whether the table being read holds a value a page may read otherwise
    /// than the house ([`hb::Clarity`]) where it would count: the house
    /// does nothing there that pass, and writes `heals`, each such value as
    /// read (its `__proto__` fields out), back under its key, so the next
    /// pass reads what every page does.
    unclear: bool,
    heals: Vec<Write>,
    /// Whether the table being read names a house whose delegation an
    /// earlier table of this pass put back (`unclear_houses`): it goes back
    /// for this table too.
    healing: bool,
    /// Houses whose delegation a page may read otherwise, found this pass,
    /// and whether it goes back (each table naming one waits; it goes back
    /// once).
    unclear_houses: HashMap<String, bool>,
    /// Whether this pass found the delegation under this house's own key (`hk:<this house>`) in the doc other than
    /// the one the house holds: gone, another record, or one a page may read otherwise. The house goes on as the
    /// delegate it verified, and puts the record back when it is due (REPUT_MS), but until it has, the pages may not
    /// count this house as the plan does.
    own_off: bool,
    /// A table held this pass with its values put back: the next pass reads
    /// it again, and it plays on in the same tick. (In the tick's last pass
    /// it is held: the next tick reads it.)
    reread: bool,
    /// Whether this pass is the tick's last.
    last_pass: bool,
    /// The checks this pass asked for (key, bytes, signature by verdict),
    /// made with the doc let go, and whether a read of this pass was short
    /// (a table's, the room's own).
    wanted: HashMap<VerdictId, (String, Option<Vec<u8>>, String)>,
    short: bool,
    /// The verdicts given this tick (the newest of `verdict_order`): none of
    /// them goes to make room while it runs, so a pass never asks again.
    fresh: usize,
    /// Each table this tick is through with (its duties done, or short of a
    /// check past the budget), whether it counts as running Fair, and
    /// whether it was short: a later pass reads only the others.
    through: HashMap<(String, String), (bool, bool)>,
    /// What the tick's passes saw of the doc between them ([`Looks`]).
    looks: Looks,
    /// The clients' id of this node's doc (its own writes are not what a peer sent).
    own_client: u64,
    /// Whether anything reads the plans ([`House::fold_plan`]): the fold in shadow. When nothing does, the passes of a tick
    /// take no look at the doc between them.
    watch_plans: bool,
    /// The tables held this tick: one whose own record the put-back writes
    /// again is read again ([`House::plan`]).
    held_now: HashSet<(String, String)>,
    stepping_down: bool,
    /// [`SETTLE_MS`] (tests set 0).
    settle_ms: u64,
    /// 🔒 Whether it serves FAIR ONLY games ([`House::serve_fair_only`]): off until the node can also checkpoint
    /// one, since a game with a house that reveals and never trims stops at [`MAX_HELD_ROUNDS`].
    serve_games: bool,
    /// 🔒 What this tick found of each FAIR ONLY game its walk got to: whether this house serves it now and whether it
    /// has settled there (None: the walk could not tell, [`House::games_count`]), and whether its read was short. A
    /// game in `through` too is one this tick is through with.
    games_through: HashMap<(String, String), (Option<(bool, bool)>, bool)>,
    /// 🔒 Where the fold in shadow puts its answers for the FAIR ONLY games ([`House::read_answers_from`]): what a trim goes
    /// by. None: no fold, and no trim.
    answers: Option<GameAnswers>,
    /// 🔒 The FAIR ONLY games whose trim checked an answer this tick ([`waits_on`]): the others forget what they waited
    /// for as the tick ends, whatever kept them from it.
    waits_noted: HashSet<(String, String)>,
    /// 🔒 `(room, t, inc)` → the last checkpoint it signed for a FAIR ONLY game, its key and value, and what its trim
    /// carried ([`ROWS_FILE`]).
    rows: BTreeMap<(String, String, String), Row>,
    rows_path: Option<PathBuf>,
    /// 🔒 What it did at FAIR ONLY games, for the fingerprint ([`House::game_counts`]).
    counts: GameCounts,
    /// Called with the room before each signature check (tests).
    #[cfg(test)]
    on_check: Option<Box<dyn FnMut(&str) + Send>>,
    /// Tables read (tests).
    #[cfg(test)]
    table_reads: usize,
    /// FAIR ONLY games a walk looked at, by table (tests).
    #[cfg(test)]
    games_looked: std::collections::BTreeMap<String, usize>,
    /// Commitments made (tests).
    #[cfg(test)]
    commits: std::cell::Cell<usize>,
    /// 🔒 Changes a trim's body before the cross-check sees it (tests: a fault planted in the fold's answer).
    #[cfg(test)]
    fault_trim: Option<Box<dyn FnMut(&mut Vec<(String, CVal)>) + Send>>,
}

/// A value [`House::read_charged`] read.
pub(crate) enum Read {
    Val(CVal),
    /// A value a page may read otherwise ([`hb::Clarity`]): as read, or
    /// as junk (`Proto`); or as anything (`Unknown`, never read: `Junk`).
    Unclear(CVal, hb::Clarity),
    /// None there, or not a value (a nested map, say).
    Absent,
    /// Heavier than the read allows by what a page reads of it: junk, or
    /// for a checkpoint, unread. (Past it with padding a page reads past:
    /// `Unknown`.)
    Heavy,
    /// This tick's reads are spent.
    Spent,
}

/// The value under a key of `key_len` bytes, read and charged to `charge`
/// (which says whether the read may go on): the key, and the value's weight,
/// or `cap` for one heavier, which is what finding that out costs; and the
/// `__proto__` strings that [`hb::clarity`] reads, which no weight counts,
/// unless they come to more than a tick reads: those it never reads, and the
/// value is Unknown. One past `cap` with padding a page reads past in it
/// ([`hb::Weighed::Unsure`]) is Unknown too, read no further. The house reads
/// with its tick's budget ([`House::charge`]) and the fold's mirror with its
/// own (house_mirror.rs), the same reading either way.
pub(crate) fn read_costed(charge: impl FnOnce(usize) -> bool, key_len: usize, out: Option<Out>, cap: usize) -> Read {
    let (weight, read) = match out {
        Some(Out::Any(any)) => {
            let weighed = hb::weigh(&any, cap);
            let weight = match weighed {
                hb::Weighed::Light { w, scan } => w.saturating_add(if scan > READ_PER_TICK { 0 } else { scan }),
                hb::Weighed::Heavy | hb::Weighed::Unsure => cap,
            };
            (weight, Some((any, weighed)))
        }
        _ => (0, None),
    };
    if !charge(key_len.saturating_add(VISIT_BYTES).saturating_add(weight)) {
        return Read::Spent;
    }
    match read {
        Some((any, hb::Weighed::Light { scan, .. })) => match hb::clarity_within(&any, scan, READ_PER_TICK) {
            hb::Clarity::Clear => Read::Val(CVal::from_any(&any)),
            hb::Clarity::Unknown => Read::Unclear(CVal::Junk, hb::Clarity::Unknown),
            c => Read::Unclear(CVal::from_any(&any), c),
        },
        Some((_, hb::Weighed::Unsure)) => Read::Unclear(CVal::Junk, hb::Clarity::Unknown),
        Some((_, hb::Weighed::Heavy)) => Read::Heavy,
        None => Read::Absent,
    }
}

/// What peers have sent to a doc, as two words whatever its history: how many clients other than this node's own have
/// written to it, and a sum of a scramble of each client and how far it has written. Equal at two looks if and only if a
/// peer sent nothing between them (but for a collision of the 64-bit sum, which a peer cannot aim at: clients are theirs,
/// but the scramble is not).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Seen {
    clients: u32,
    sum: u64,
}

fn scramble(x: u64) -> u64 {
    let x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

/// One walk of the doc's clients, with no sorting and nothing kept: the node takes it only between the passes of a tick
/// that has a table through and another pass to come ([`Looks`]), and not at all when no shadow reads the plan.
fn seen_of<T: ReadTxn>(txn: &T, own: u64) -> Seen {
    let mut seen = Seen::default();
    for (client, clock) in txn.state_vector().iter() {
        if client.get() == own {
            continue;
        }
        let h = scramble(scramble(client.get()).wrapping_add(u64::from(*clock)));
        seen.clients = seen.clients.wrapping_add(1);
        seen.sum = seen.sum.wrapping_add(h);
    }
    seen
}

/// What a tick's passes saw of the doc between them. The doc is let go between passes (the checks are made without it),
/// and a table that went through in a pass is not read again in the next: if a peer sent anything since, the table is
/// not as it was read, and a record of a house the pass would have learned may be in it. So a pass that leaves a table
/// through, with another to follow, takes a look as it ends ([`Looks::rest`]), and the next takes another as it begins
/// ([`Looks::resume`]) and compares. Nothing is looked at in a tick of one pass (the usual), in a pass that has nothing
/// through, or when nothing reads the plan.
#[derive(Default)]
struct Looks {
    /// The doc as the last pass left it, when a table had gone through and another pass was to follow.
    rested: Option<Seen>,
    /// A peer sent to the doc after a table went through, and it was not read again: the tick's plan is not complete.
    moved: bool,
    /// How many looks were taken (the tests count them).
    #[cfg(test)]
    taken: u32,
}

impl Looks {
    /// A pass ends with a table through and another to follow: the look is asked for only if it is wanted.
    fn rest(&mut self, seen: impl FnOnce() -> Seen) {
        if !self.moved {
            self.rested = Some(seen());
            #[cfg(test)]
            {
                self.taken += 1;
            }
        }
    }

    /// A pass begins: if the last left a look, a peer sent in between if the doc is other now. (The look is used up.)
    fn resume(&mut self, seen: impl FnOnce() -> Seen) {
        if let Some(then) = self.rested.take() {
            #[cfg(test)]
            {
                self.taken += 1;
            }
            if then != seen() {
                self.moved = true;
            }
        }
    }
}

/// What [`House::tick`] did in a room.
#[derive(Default, Debug, PartialEq)]
pub struct TickOut {
    /// The update to send (lib0 v1), when it wrote anything.
    pub update: Option<Vec<u8>>,
    /// How many records it wrote.
    pub wrote: usize,
    /// Whether a read was short of checks when it ended (the next tick, or
    /// the step-down's last word, carries on).
    pub short: bool,
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
        // 🔒 (The checkpoints it signed: unreadable, it goes without them, and puts none back, rather than not start. It
        // signs a game's next only once it has written the file again.)
        let rows_path = state_path.as_ref().map(|p| p.with_file_name(ROWS_FILE));
        let mut rows = BTreeMap::new();
        if let Some(path) = &rows_path {
            match std::fs::read(path) {
                Ok(bytes) => match parse_rows(&bytes) {
                    Some(r) => rows = r,
                    None => eprintln!("🏠 house: {} is unreadable: no checkpoint of it is put back", path.display()),
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => eprintln!("🏠 house: {}: {e}: no checkpoint of it is put back", path.display()),
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
            read_left: READ_PER_TICK,
            read_out: false,
            unclear: false,
            heals: Vec::new(),
            healing: false,
            unclear_houses: HashMap::new(),
            own_off: false,
            reread: false,
            last_pass: false,
            wanted: HashMap::new(),
            short: false,
            fresh: 0,
            through: HashMap::new(),
            looks: Looks::default(),
            own_client: 0,
            watch_plans: true,
            held_now: HashSet::new(),
            stepping_down: false,
            settle_ms: SETTLE_MS,
            serve_games: false,
            games_through: HashMap::new(),
            answers: None,
            waits_noted: HashSet::new(),
            rows,
            rows_path,
            counts: GameCounts::default(),
            #[cfg(test)]
            on_check: None,
            #[cfg(test)]
            table_reads: 0,
            #[cfg(test)]
            games_looked: std::collections::BTreeMap::new(),
            #[cfg(test)]
            commits: std::cell::Cell::new(0),
            #[cfg(test)]
            fault_trim: None,
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

    /// 🔒 Serve the FAIR ONLY games (letters `p`/`q`) this house is delegated a house of: join, reveal and step down
    /// there (design-final section 8.5, N1). Off unless told: the node says so once it also signs their checkpoints.
    pub fn serve_fair_only(&mut self, on: bool) {
        // 🔒 (On again after a spell off: it settles at each game again, as after a gap, for it read none of them.)
        if on && !self.serve_games {
            for mem in self.rooms.values_mut() {
                mem.settle_games_again();
            }
        }
        // (Off: no game is followed for it, and a pass that finds them again plans them afresh.)
        if !on {
            for mem in self.rooms.values_mut() {
                mem.game_plans.clear();
            }
        }
        self.serve_games = on;
    }

    pub fn stepping_down(&self) -> bool {
        self.stepping_down
    }

    /// Whether `g` is `k`'s signature of `bytes`, record `hash` of `kind` at
    /// `at` (room, table, incarnation; "" where the kind has none): checked
    /// once there. None (`deferred` set) when not checked yet: asked for
    /// while the budget lasts, and checked with the doc let go (a check
    /// inside the doc's transaction would hold the room's sync on it).
    fn verified(&mut self, kind: &'static str, at: [&str; 3], hash: &str, k: &str, bytes: Option<[u8; 32]>, g: &str) -> Option<bool> {
        let id = (kind, at.map(str::to_string), hash.to_string());
        if let Some(v) = self.verdicts.get(&id) {
            return Some(*v);
        }
        self.deferred = true;
        if self.budget > 0 && !self.wanted.contains_key(&id) {
            self.budget -= 1;
            self.wanted.insert(id, (k.to_string(), bytes.map(|b| b.to_vec()), g.to_string()));
        }
        None
    }

    /// 🔒 A check a FAIR ONLY game's resolution asks for (house_auth.rs [`ha::SigCheck`]): `id` names the record and
    /// its kind within the room ([`ha::sig_id`]), and the bytes, which are made only when the check is new, may be of
    /// any length (a deed offer's are its text). As [`House::verified`]: None while it waits.
    fn verified_auth(&mut self, room: &str, id: &str, k: &str, bytes: &dyn Fn() -> Option<Vec<u8>>, g: &str) -> Option<bool> {
        let id: VerdictId = ("auth", [room.to_string(), id.to_string(), String::new()], String::new());
        if let Some(v) = self.verdicts.get(&id) {
            return Some(*v);
        }
        self.deferred = true;
        if self.budget > 0 && !self.wanted.contains_key(&id) {
            self.budget -= 1;
            self.wanted.insert(id, (k.to_string(), bytes(), g.to_string()));
        }
        None
    }

    /// The checks the pass asked for, the doc let go.
    fn check_wanted(&mut self) {
        for (id, (k, bytes, g)) in std::mem::take(&mut self.wanted) {
            #[cfg(test)]
            if let Some(f) = self.on_check.as_mut() {
                f(&id.1[0]);
            }
            let ok = bytes.is_some_and(|b| hb::verify(&k, &b, &g));
            while self.verdicts.len() >= MAX_VERDICTS && self.verdict_order.len() > self.fresh {
                if let Some(old) = self.verdict_order.pop_front() {
                    self.verdicts.remove(&old);
                }
            }
            self.verdict_order.push_back(id.clone());
            self.verdicts.insert(id, ok);
            self.fresh += 1;
        }
    }

    /// Whether `k` is a house of room `room` under the deed holder's key
    /// `owner_key`: this one, one pinned so, or one whose delegation
    /// (`hk:<k>`) the doc holds signed by them (pinned from then on). None
    /// while its check waits ([`House::verified`]).
    fn house_of<T: ReadTxn>(&mut self, comp: &MapRef, txn: &T, room: &str, owner_key: &str, k: &str) -> Option<bool> {
        if k == self.key.public || self.rooms.get(room).and_then(|m| m.houses.get(k)).is_some_and(|o| o == owner_key) {
            return Some(true);
        }
        if let Some(&back) = self.unclear_houses.get(k) {
            self.unclear = true;
            self.healing |= back;
            return Some(false);
        }
        let key = format!("hk:{k}");
        let (v, clarity) = match self.read_charged(key.len(), comp.get(txn, &key), MAX_TOP_BYTES) {
            Read::Val(v) => (v, hb::Clarity::Clear),
            // (A page may hold something else there: k's delegation, maybe.)
            Read::Unclear(_, hb::Clarity::Unknown) => {
                self.unclear = true;
                self.unclear_houses.insert(k.to_string(), false);
                return Some(false);
            }
            Read::Unclear(v, c) => (v, c),
            Read::Spent => return None,
            Read::Absent | Read::Heavy => return Some(false),
        };
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
        // A page may not count k a house: the table waits, and the
        // delegation goes back as every page reads it.
        if ok && clarity != hb::Clarity::Clear {
            self.unclear = true;
            self.unclear_houses.insert(k.to_string(), true);
            self.heals.push(Write::Top { key, value: v });
            return Some(false);
        }
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

    /// A pass that could not read the room to say what it holds keeps the plan the last one found, not complete
    /// ([`House::fold_plan`]). (The end of the tick sets `complete` for every plan from whether the tick was short, and a
    /// tick that kept a plan was; saying it here as well is for whoever reads this alone.)
    fn keep_plan(&mut self, room: &str, prev: Option<FoldPlan>) {
        if let (Some(prev), Some(mem)) = (prev, self.rooms.get_mut(room)) {
            mem.fold = Some(FoldPlan { complete: false, ..prev });
        }
    }

    /// Whether the plans are read at all (the fold in shadow; on until told otherwise). When nothing reads them the
    /// passes of a tick take no look at the doc between them, which is work for the plan's `complete` and nothing else.
    pub fn watch_plans(&mut self, on: bool) {
        self.watch_plans = on;
    }

    /// What the node's fold in shadow follows in `room`: None unless the last
    /// pass found this house delegated (a pass that could not read the room to
    /// the end left the plan before it, which is not complete, so that tables
    /// the shadow is reading are not let go of on a pass that could not say).
    /// The tables may be none (the last one has ended: the shadow reads what it
    /// left and lets it go). Copied from what the pass found: no doc is read
    /// here, so the house's lock is held for a copy only.
    pub fn fold_plan(&self, room: &str) -> Option<HousePlan> {
        let mem = self.rooms.get(room)?;
        // 🔒 The FAIR ONLY games it serves, whoever holds the deed: in a room where it is no house of the deed holder's,
        // a plan of the games only.
        let games: Vec<GamePlan> = mem.game_plans.values().cloned().collect();
        let Some(plan) = mem.fold.as_ref() else {
            return (!games.is_empty()).then(|| HousePlan {
                owner: String::new(),
                owner_key: String::new(),
                tables: Vec::new(),
                houses: vec![self.key.public.clone()],
                complete: false,
                gapped: false,
                games,
            });
        };
        let mut houses: Vec<String> = mem.houses.iter().filter(|(_, owner)| **owner == plan.owner_key).map(|(k, _)| k.clone()).collect();
        houses.push(self.key.public.clone());
        houses.sort();
        houses.dedup();
        // (Only a plan that names a house besides this one has any pinned to be stale.)
        let gapped = mem.gapped && houses.len() > 1;
        Some(HousePlan { owner: plan.owner.clone(), owner_key: plan.owner_key.clone(), tables: plan.tables.clone(), houses, complete: plan.complete, gapped, games })
    }

    /// Charge `n` to this tick's reads ([`READ_PER_TICK`]): false once they
    /// are spent, and then the read is short (`deferred`), as is every read
    /// after it this tick.
    fn charge(&mut self, n: usize) -> bool {
        if self.read_left == usize::MAX {
            return true;
        }
        if self.read_out || n > self.read_left {
            self.read_left = 0;
            self.read_out = true;
            self.deferred = true;
            return false;
        }
        self.read_left -= n;
        true
    }

    /// Charge `n` to this tick's reads whatever is left of them: what it pays for is done all the same (the first listing
    /// of a room's keys, house_index.rs), and once it has spent them every read after it is short ([`charge`] finds
    /// nothing left).
    fn admit(&mut self, n: usize) {
        if self.read_left != usize::MAX {
            self.read_left = self.read_left.saturating_sub(n);
        }
    }

    /// The value under a key of `key_len` bytes, read and charged ([`charge`]:
    /// see [`read_costed`], which it is).
    ///
    /// [`charge`]: House::charge
    fn read_charged(&mut self, key_len: usize, out: Option<Out>, cap: usize) -> Read {
        read_costed(|n| self.charge(n), key_len, out, cap)
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
        #[cfg(test)]
        self.commits.set(self.commits.get() + 1);
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
    /// count), in passes. A pass reads the doc and writes what it decided in
    /// one transaction (nothing a peer sent comes between: the node lets the
    /// rooms lock go while it ticks, main.rs room_doc), asking for the checks
    /// it lacks; they are made with the doc let go, and the next pass reads
    /// the tables still short of them, [`MAX_PASSES`] at most and
    /// [`VERIFY_PER_TICK`] checks in all. Its update is every pass's.
    pub fn tick(&mut self, room: &str, doc: &Doc, now: u64, wall: u64) -> TickOut {
        self.tick_with(room, doc, now, wall, VERIFY_PER_TICK, MAX_PASSES)
    }

    /// A tick with every check it needs: the step-down's last word in a room
    /// whose tick was short ([`step_down`]).
    pub fn tick_unbounded(&mut self, room: &str, doc: &Doc, now: u64, wall: u64) -> TickOut {
        self.tick_with(room, doc, now, wall, usize::MAX, MAX_PASSES_STOPPING)
    }

    fn tick_with(&mut self, room: &str, doc: &Doc, now: u64, wall: u64, budget: usize, passes: usize) -> TickOut {
        self.budget = budget;
        self.read_left = if budget == usize::MAX { usize::MAX } else { READ_PER_TICK };
        self.read_out = false;
        self.fresh = 0;
        self.through.clear();
        self.looks = Looks::default();
        self.own_client = doc.client_id().get();
        self.held_now.clear();
        self.wanted.clear();
        self.games_through.clear();
        self.waits_noted.clear();
        // 🔒 Not ticked here for HOUSE_HEARD_MS (the node was cut off, or asleep): the pages took the house as away, and
        // it settles at each FAIR ONLY game again, reading before it reveals (design-final section 8.5, N1).
        if let Some(mem) = self.rooms.get_mut(room) {
            if mem.last_tick.is_some_and(|last| now.saturating_sub(last) >= HOUSE_HEARD_MS) {
                mem.settle_games_again();
            }
        }
        // 🔒 The index of the room's FAIR ONLY records follows the doc while it serves the games (attached with no
        // transaction open, and again for another doc of the room), and is let go of while it does not: it would only
        // grow then.
        if self.serve_games {
            let mem = self.rooms.entry(room.to_string()).or_default();
            if !mem.index.as_ref().is_some_and(|ix| ix.follows(doc)) {
                mem.index = Some(FairIndex::attach(doc));
            }
        } else if let Some(mem) = self.rooms.get_mut(room) {
            mem.index = None;
        }
        let mut out = TickOut::default();
        let mut updates = Vec::new();
        for pass in 1..=passes {
            self.deferred = false;
            self.short = false;
            self.reread = false;
            self.last_pass = pass == passes;
            {
                let mut txn = doc.transact_mut();
                let writes = self.plan(room, &txn, now, wall);
                out.wrote += writes.len();
                updates.extend(apply(&mut txn, &writes));
                // (Another pass is to follow and a table is through, which it will not read again: what the doc holds now is
                // what a peer may have added to by then. Nothing is looked at in the usual tick of one pass.)
                if self.watch_plans && pass < passes && (!self.wanted.is_empty() || self.reread) && !self.through.is_empty() {
                    let own = self.own_client;
                    self.looks.rest(|| seen_of(&txn, own));
                }
            }
            out.short = self.short;
            if self.wanted.is_empty() && !self.reread {
                break;
            }
            self.check_wanted();
            // (The last pass's checks too: the next tick reads them.)
            if pass == passes {
                out.short = true;
            }
        }
        self.through.clear();
        self.held_now.clear();
        self.games_through.clear();
        if let Some(mem) = self.rooms.get_mut(room) {
            mem.last_tick = Some(now);
            // 🔒 A game whose trim checked no answer this tick forgets what it waited for (the game held, its session
            // gone, the read short, no answer that is the game: whatever it was, a record it waited for could have come
            // back and gone again unseen, and a new loss waits afresh).
            for (key, table) in mem.tables.iter_mut() {
                if !self.waits_noted.contains(key) {
                    table.waits.clear();
                }
            }
        }
        self.waits_noted.clear();
        // (The plan the last pass made is complete when the tick got to read the room to its end,
        // and left no table of it waiting on a value a page may read otherwise, which would leave
        // out of the plan's houses one the table names: the live house's decisions are as they were.
        // A delegation a page may read otherwise holds the table that names it, so `waiting` says as
        // much as `houses_clear` does; both are kept, for the rule stands apart from how it is kept.)
        // (And this house's own delegation: the record the doc holds under its key is the one it holds, as every page
        // reads it, for the house goes on as the delegate it verified while the record is other, and the pages may not
        // count it, which `unclear_houses` does not say: it holds the other houses, which a table names.)
        // (And a peer sent nothing, between the passes, to a table that went through in an earlier one and was not read
        // again: a record of a house it names that the pass never learned would leave the plan's houses short.)
        let houses_clear = self.unclear_houses.is_empty() && !self.own_off;
        let moved_between = self.looks.moved;
        if let Some(mem) = self.rooms.get_mut(room) {
            let waiting = mem.fold.as_ref().is_some_and(|p| p.tables.iter().any(|k| mem.tables.get(k).is_some_and(|m| m.held_since.is_some())));
            if let Some(plan) = mem.fold.as_mut() {
                plan.complete = !out.short && houses_clear && !waiting && !moved_between;
            }
            // (A tick that ended with no plan, in a room that has houses pinned: nothing watches their delegations now.)
            if mem.fold.is_none() && !mem.houses.is_empty() {
                mem.gapped = true;
            }
        }
        while self.verdicts.len() > MAX_VERDICTS {
            if let Some(old) = self.verdict_order.pop_front() {
                self.verdicts.remove(&old);
            }
        }
        // After a tick a read was short, the next starts at the next table.
        if out.short {
            if let Some(mem) = self.rooms.get_mut(room) {
                mem.turn = mem.turn.wrapping_add(1);
                if let Some(ix) = mem.index.as_mut() {
                    ix.pass_turn();
                }
            }
        }
        out.update = match updates.len() {
            0 => None,
            1 => updates.pop(),
            _ => Some(yrs::merge_updates_v1(&updates).expect("the doc's own updates decode")),
        };
        out
    }

    fn plan<T: ReadTxn>(&mut self, room: &str, txn: &T, now: u64, wall: u64) -> Vec<Write> {
        let mut writes = Vec::new();
        // (What the doc holds as this pass begins, when the pass before it left a look: the doc was let go between them, and
        // a table that went through is not read again. This is before anything else, so a pass cut short compares too.)
        let own = self.own_client;
        self.looks.resume(|| seen_of(txn, own));
        self.unclear_houses.clear();
        self.own_off = false;
        // (The fold follows only what a pass that got this far found; a pass cut short keeps the last one's, not complete.)
        let prev = self.rooms.get_mut(room).and_then(|mem| mem.fold.take());
        let Some(comp) = txn.get_map(COMPUTED_MAP) else { return writes };
        let pub_key = self.key.public.clone();

        // 🔒 While it serves the games, half of what the tick may still read is theirs: a flood at a house table, or
        // among the casino's keys, leaves them their reads (as a flood at one game leaves the others their turns).
        let games_share = if self.serve_games && self.read_left != usize::MAX { self.read_left / 2 } else { 0 };
        self.read_left -= games_share;
        // The room's house tables (`r`/`d`), while the deed holder delegates this house. (🔒 A pass that cannot read
        // them still reads the games, which are whoever holds the deed's.)
        let rd = match self.house_tables(room, txn, &comp, now, prev, &mut writes) {
            Tables::Stop | Tables::None if !self.serve_games => return writes,
            Tables::Stop | Tables::None => None,
            Tables::Some(rd) => Some(rd),
        };
        // 🔒 The FAIR ONLY games it is a house of, whoever holds the deed. (The house tables' reads spent are theirs.)
        let mut fo = if self.serve_games {
            let tables_out = std::mem::replace(&mut self.read_out, false);
            self.read_left += games_share;
            self.rooms.entry(room.to_string()).or_default();
            let fo = self.games(room, txn, &comp, now, &mut writes);
            self.read_out |= tables_out;
            fo
        } else {
            GamesOut::default()
        };
        let fair_tables = rd.as_ref().map_or(0, |rd| rd.fair) + fo.settled;

        // The heartbeat, while a table runs Fair. 🔒 And not while it settles at a game it serves: the beat is the
        // room's, so a page at that game would hear it and close at once, and a close first read while settling is
        // never revealed for. (The other tables go without a beat for SETTLE_MS at most, well inside HOUSE_HEARD_MS.)
        let beat_due = self.rooms[room].last_beat.is_none_or(|at| now.saturating_sub(at) >= HEARTBEAT_MS);
        if fair_tables > 0 && fo.settled == fo.serving && !self.stepping_down && beat_due {
            let beat_key = format!("hb:{pub_key}");
            // It counts on from the doc's beat only as it signed it: a peer's
            // copy with a higher count would push its own past what the
            // pages take.
            // (Its check put off: the beat waits a pass.)
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

        // Put back what was taken away, every REPUT_MS; stepping down, every
        // pass (a table held over its own record waits on it, and the
        // step-down's last word may come before REPUT_MS is due).
        let stepping_down = self.stepping_down;
        let mem = self.rooms.get_mut(room).unwrap();
        if stepping_down || mem.last_reput.is_none_or(|at| now.saturating_sub(at) >= REPUT_MS) {
            mem.last_reput = Some(now);
            // (One a page may read otherwise is no copy: it goes too.)
            let same = |a: Option<(CVal, hb::Clarity)>, b: &CVal| a.is_some_and(|(a, c)| c == hb::Clarity::Clear && hb::rec_hash(&a) == hb::rec_hash(b));
            if let Some(rd) = &rd {
                if !rd.deleg_clear || !same(rd.deleg_now.clone().map(|v| (v, hb::Clarity::Clear)), &rd.delegation) {
                    writes.push(Write::Top { key: format!("hk:{pub_key}"), value: rd.delegation.clone() });
                }
            }
            // Each table's setting is the newest the deed holder signed, as
            // read above: anything else in its place goes, a forged one
            // with a higher count included; but for one a page may hold
            // otherwise entirely (maybe a newer one, which the table waits
            // on, as read above).
            for (t, rec) in mem.fair.iter().filter(|_| rd.is_some()) {
                let key = format!("hf:{t}");
                let queued = writes.iter().any(|w| matches!(w, Write::Top { key: k, .. } if *k == key));
                let there = top_read(&comp, txn, &key);
                let unknown = there.as_ref().is_some_and(|(_, c)| *c == hb::Clarity::Unknown);
                if !queued && !unknown && !same(there, rec) {
                    writes.push(Write::Top { key, value: rec.clone() });
                }
            }
            // 🔒 (A game's session map the walk puts back is there for its own records, which go into it in the same
            // write: a close put back into it by a page is read by the house beside its join, not before. One its row
            // puts back with its checkpoint too.)
            let (maps, game_reput): (Vec<Write>, Vec<Write>) = std::mem::take(&mut fo.reput).into_iter().partition(|w| matches!(w, Write::NewSession { .. } | Write::Restore { .. }));
            let new_maps: HashSet<String> = maps
                .iter()
                .filter_map(|w| match w {
                    Write::NewSession { ses } | Write::Restore { ses: Some((ses, _, _)), .. } => Some(ses.clone()),
                    _ => None,
                })
                .collect();
            // 🔒 (A checkpoint it signed, from its row.)
            self.counts.row_put_backs += maps.iter().filter(|w| matches!(w, Write::Restore { ck: true, .. })).count() as u64;
            writes.extend(maps);
            let mut restored: Vec<(String, String)> = Vec::new();
            for (tkey, table) in &mem.tables {
                // (A house table's, only while this house is the room's; a FAIR ONLY game's, only while it serves them.)
                let fo = ha::is_fair_only_inc(&tkey.1);
                if (rd.is_none() && !fo) || (fo && !self.serve_games) {
                    continue;
                }
                for (ses, key, value) in &table.written {
                    // There as it wrote it: junk under its key reads as
                    // nothing on every page, and goes too.
                    let present = match comp.get(txn, ses) {
                        Some(Out::YMap(m)) => match m.get(txn, key) {
                            Some(Out::Any(any)) => match hb::weigh(&any, MAX_RECORD_BYTES) {
                                hb::Weighed::Light { scan, .. } => {
                                    hb::clarity_within(&any, scan, MAX_RECORD_BYTES) == hb::Clarity::Clear
                                        && hb::rec_hash(&CVal::from_any(&any)) == hb::rec_hash(value)
                                }
                                hb::Weighed::Heavy | hb::Weighed::Unsure => false,
                            },
                            _ => false,
                        },
                        _ => !new_maps.contains(ses),
                    };
                    let queued = writes.iter().any(|w| matches!(w, Write::Session { key: k, .. } if k == key));
                    if !present && !queued {
                        writes.push(Write::Session { ses: ses.clone(), key: key.clone(), value: value.clone() });
                        restored.push(tkey.clone());
                    }
                }
            }
            // A table held this tick with its own record back now is read
            // again: the next pass, or (after the tick's last: tick_with)
            // the next tick, the tick short, so that a step-down's last
            // word reads it too and lifts its commitment.
            for tkey in restored {
                if self.held_now.remove(&tkey) {
                    self.through.remove(&tkey);
                    self.reread = true;
                }
            }
            // 🔒 What the FAIR ONLY games lost, as this pass's walk found it (design-final section 8.5 N5), and their
            // forged records. Not this house's delegation while it is a house of the room's house tables: that key is
            // theirs then (one value under `hk:<house>`, design-final 6c-4b-2a limit 4), and a game goes by the
            // delegation it holds ([`TableMem::deleg`]) or its checkpoint carries. At most FORGED_DELETE_MAX deletes a
            // pass, as on the pages.
            let mine = format!("hk:{pub_key}");
            let mut deletes = 0;
            for w in game_reput {
                let skip = match &w {
                    Write::Top { key, .. } => rd.is_some() && *key == mine,
                    Write::Delete { .. } => {
                        deletes += 1;
                        deletes > FORGED_DELETE_MAX
                    }
                    _ => false,
                };
                if !skip {
                    writes.push(w);
                }
            }
        }
        writes
    }

    /// The room's house tables (`r`/`d`), their joins, reveals and step-downs planned into `writes`: [`Tables::None`]
    /// while this house is none of the room's (no deed holder known, or no delegation of this house's key by them),
    /// [`Tables::Stop`] when the pass could not read the room (its reads spent, a setting's check put off): nothing
    /// more in the room this pass.
    fn house_tables<T: ReadTxn>(&mut self, room: &str, txn: &T, comp: &MapRef, now: u64, prev: Option<FoldPlan>, writes: &mut Vec<Write>) -> Tables {
        let pub_key = self.key.public.clone();

        // The deed holder and their key, pinned on first sight.
        let owner = txn.get_map("roomInfo").and_then(|m| deed_of(m.get(txn, "owner")));
        let Some(owner) = owner else { return Tables::None };
        self.rooms.entry(room.to_string()).or_default();
        let Some(owner_key) = self.pin_of(room, txn, &owner) else { return Tables::None };

        // The delegation: this house's key, signed by the deed holder.
        let deleg_key = format!("hk:{pub_key}");
        let (deleg_now, deleg_clear) = match top_read(comp, txn, &deleg_key) {
            Some((v, c)) => (Some(v), c == hb::Clarity::Clear),
            None => (None, true),
        };
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
        // (Its check put off: the next pass.)
        let Some(delegation) = delegation else {
            self.short |= self.deferred;
            // (A check put off is no word that there is no delegation.)
            if self.deferred {
                self.keep_plan(room, prev);
            }
            return Tables::None;
        };
        self.rooms.get_mut(room).unwrap().delegation = Some(delegation.clone());
        // (The record in the doc is the one held, and as a page reads it, or the pages may not count this house: the
        // plan is not complete until the put-back has written it again and a pass has read it so.)
        self.own_off = !(deleg_clear && deleg_now.as_ref().is_some_and(|v| hb::rec_hash(v) == hb::rec_hash(&delegation)));

        // Every house the deed holder delegated (another of their nodes is a
        // house of the room as this one is, and its records hold the line,
        // the joins and the step-downs as this one's do) counts as its
        // records come: read_table asks house_of.

        // The switched-on house tables, live.
        let casino = txn.get_map(CASINO_MAP);
        let mut tables: Vec<(String, String)> = Vec::new();
        if let Some(casino) = &casino {
            for (key, out) in casino.iter(txn) {
                let Some(t) = key.strip_prefix("cfg:computed:") else {
                    if !self.charge(key.len() + VISIT_BYTES) {
                        break;
                    }
                    continue;
                };
                if !self.charge(key.len() + VISIT_BYTES + SWITCH_BYTES) {
                    break;
                }
                let Some(inc) = (match out {
                    Out::Any(any) => switch_of(&any),
                    _ => None,
                }) else {
                    continue;
                };
                if house_inc(&inc) && !casino.contains_key(txn, &format!("gone:{t}:{inc}")) {
                    tables.push((t.to_string(), inc));
                }
            }
        }
        // (The switches not all read: nothing in the room, the next tick.)
        if self.read_out {
            self.short = true;
            self.keep_plan(room, prev);
            return Tables::Stop;
        }
        tables.sort();
        self.rooms.get_mut(room).unwrap().fold = Some(FoldPlan { owner: owner.clone(), owner_key: owner_key.clone(), tables: tables.clone(), complete: false });

        // The owner's Fair setting of each of them, the one standing over
        // every other seen (fair_after; a new deed holder's count afresh:
        // the last one's settings go).
        self.rooms.get_mut(room).unwrap().fair.retain(|_, v| str_of(v, "k") == Some(owner_key.as_str()));
        let mut unclear_at: HashSet<String> = HashSet::new();
        let mut unknown_at: HashSet<String> = HashSet::new();
        for (t, _) in &tables {
            let key = format!("hf:{t}");
            let (v, clarity) = match self.read_charged(key.len(), comp.get(txn, &key), MAX_TOP_BYTES) {
                Read::Val(v) => (v, hb::Clarity::Clear),
                // (A page may hold a setting there the house never read: one
                // standing over the one it holds, maybe.)
                Read::Unclear(_, hb::Clarity::Unknown) => {
                    unknown_at.insert(t.clone());
                    continue;
                }
                Read::Unclear(v, c) => (v, c),
                Read::Spent => break,
                Read::Absent | Read::Heavy => continue,
            };
            if !has_fields(&v, &["v", "m", "s", "k", "g"], &[])
                || v.get("v").and_then(CVal::as_int) != Some(1)
                || !matches!(v.get("m").and_then(CVal::as_int), Some(0 | 1))
                || is_round(v.get("s")).is_none()
                || str_of(&v, "k") != Some(owner_key.as_str())
            {
                continue;
            }
            // The setting it plays by, as a copy a page may read otherwise:
            // the table waits, and it goes back clean, on every pass the
            // doc holds it so (whatever put off the pass that first took
            // it: a check at another table, say).
            if self.rooms[room].fair.get(t.as_str()).is_some_and(|was| hb::rec_hash(was) == hb::rec_hash(&v)) {
                if clarity != hb::Clarity::Clear {
                    unclear_at.insert(t.clone());
                }
                continue;
            }
            if self.rooms[room].fair.get(t.as_str()).is_some_and(|was| !fair_after(&v, was)) {
                continue;
            }
            let hash = hb::rec_hash(&v).unwrap_or_default();
            let g = str_of(&v, "g").unwrap_or("").to_string();
            if self.verified("hfair", [room, t, ""], &hash, &owner_key, hb::room_sign_bytes("hfair", room, t, &v), &g) == Some(true) {
                // A newer setting a page may not take: the table waits.
                if clarity != hb::Clarity::Clear {
                    unclear_at.insert(t.clone());
                }
                self.rooms.get_mut(room).unwrap().fair.insert(t.to_string(), v);
            }
        }
        // (A setting not checked yet: nothing at any table, the next pass.)
        if self.deferred {
            self.short = true;
            return Tables::Stop;
        }

        let mut fair_tables = 0;
        if !tables.is_empty() {
            let turn = self.rooms[room].turn % tables.len();
            tables.rotate_left(turn);
        }
        for (t, inc) in tables {
            let key = (t.clone(), inc.clone());
            if let Some((fair, short)) = self.through.get(&key) {
                fair_tables += usize::from(*fair);
                self.short |= *short;
                continue;
            }
            // A setting a page may hold otherwise entirely: nothing at the
            // table while it is there, and nothing goes back over it (a
            // page keeps the newest setting it saw, which may stand over
            // the one the house holds: putting that back makes no page
            // agree with it).
            if unknown_at.contains(&t) {
                self.held(room, &key, now);
                continue;
            }
            // A newer setting a page may read as junk: nothing at the table
            // this pass, and it goes back clean (the next pass reads it).
            if unclear_at.contains(&t) {
                if let Some(rec) = self.rooms[room].fair.get(&t) {
                    writes.push(Write::Top { key: format!("hf:{t}"), value: rec.clone() });
                    if !self.last_pass {
                        // (Held from now, though the reread may come a
                        // tick later: the cutoff's origin stays.)
                        self.hold_began(room, &key, now);
                        self.reread = true;
                        continue;
                    }
                }
                self.held(room, &key, now);
                continue;
            }
            let ctx = Ctx { room: room.to_string(), t: t.clone(), inc: inc.clone() };
            self.deferred = false;
            let read = self.read_table(comp, txn, ctx, &owner_key);
            // A record there a page may read otherwise: nothing at the table
            // this pass, and each such record good as read goes back so, for
            // the next pass to read what every page does (with what the
            // house does there, in the same update).
            let healed = !self.heals.is_empty() || self.healing;
            writes.append(&mut self.heals);
            if self.unclear {
                if healed && !self.last_pass {
                    self.hold_began(room, &key, now);
                    self.reread = true;
                } else {
                    self.held(room, &key, now);
                }
                continue;
            }
            let Some(read) = read else {
                self.through.insert(key, (false, false));
                continue;
            };
            let friendly = self.rooms[room].fair.get(&t).and_then(|v| v.get("m").and_then(CVal::as_int)) == Some(1);
            if !friendly {
                fair_tables += 1;
            }
            // (Read short of a check: it does nothing there this pass; and
            // no pass of this tick reads it again once the budget is spent.)
            if self.deferred {
                self.short = true;
                if self.budget == 0 || self.read_out {
                    self.through.insert(key, (!friendly, true));
                }
            } else {
                self.table_duties(room, &read, friendly, now, writes, None);
                self.through.insert(key, (!friendly, false));
            }
        }

        Tables::Some(HouseTables { fair: fair_tables, deleg_now, deleg_clear, delegation })
    }


    /// 🔒 The FAIR ONLY games of the room this house is a house of (design-final section 8.5, N1; computedSimHouse
    /// games): each game's records resolved as a page resolves them (house_auth.rs), its live session read from the
    /// base the resolution chose, and served while this house's key is delegated by the key that holds the game for
    /// the rounds after the base, whoever holds the deed. Delegated by the game's holder now, it joins and reveals;
    /// delegated by a key the game has left, it reveals what is left of that key's rounds past the base (a round in
    /// flight as the game changed hands is the seller's house's to reveal), with no commitment for a round that is
    /// not its own, and joins nothing more. Under an end order it reveals with no next commitment, steps down and
    /// joins nothing.
    ///
    /// 🔒 The games come from the room's index of their records (house_index.rs), kept from the doc's changes, so a key
    /// of any other name costs the walk nothing, and the value under each house's key is read once after it changes. A
    /// game a pass found to have nothing for this house (over, with no base, under rules this build does not know, or
    /// with none of its rounds to come this house's) is not read again until a record of it changes, or for the last,
    /// what stands under this house's own key: many such games cost the walk once each.
    ///
    /// A game is read as a house table is: a record of it a page may read otherwise holds the game (and goes back as
    /// read when it is whole), a check put off leaves it short for the next pass, and one this tick is through with
    /// is not read again. The games take their turns as the house tables do: after a tick a read was short, the next
    /// starts at the next game, so a game with more under its keys than a tick reads (junk in its records or its
    /// session) holds none of the others back for good: each has its turn to be read first. `settled` counts the
    /// games it serves now and has settled at, which are the ones it beats for: a page that hears the house again
    /// closes its round at once, and a close the house first reads while it settles is one it never reveals. So it
    /// is heard at a game only once it is ready to reveal there, whether a pass reads the game or not
    /// ([`House::games_count`]).
    fn games<T: ReadTxn>(&mut self, room: &str, txn: &T, comp: &MapRef, now: u64, writes: &mut Vec<Write>) -> GamesOut {
        let mut reput = Vec::new();
        let read = self.walk_games(room, txn, comp, now, writes, &mut reput);
        GamesOut { reput, ..self.games_count(room, read) }
    }

    /// 🔒 The room's FAIR ONLY games for its beat: how many this house serves now, and at how many of those it has
    /// settled. Each as this tick found it, where the walk got that far; else (a check put off, a record a page may
    /// read otherwise, the tick's reads spent) as the last pass that knew whether it serves it found it. A game it
    /// serves and has not settled at holds the room's beat whether a pass reads it or not; one it has settled at does
    /// not, for a close it first reads later is not one it first read while settling (the block, B2), and a flood
    /// under one game's keys would stop the room's beat. The games it knows of (that it holds memory or state of, or
    /// read this tick): when the pass brought the room's index up to the doc (`read`), only the ones the doc holds
    /// records of. (A game it knows nothing of counts as none it serves, and so does one the index lets the walk pass
    /// by, which a pass found so.) Of the games it holds memory of, only the ones whose memory says it serves them can
    /// count ([`RoomMem::serving_games`]): a pass goes through no other.
    fn games_count(&self, room: &str, read: bool) -> GamesOut {
        let mem = self.rooms.get(room);
        // (In the tests, every count checks the sets against the memory they are kept beside.)
        #[cfg(test)]
        if let Some(mem) = mem {
            let serving: BTreeSet<&GameKey> = mem.tables.iter().filter(|(_, m)| m.read_through.is_some_and(|(s, _)| s)).map(|(k, _)| k).collect();
            assert_eq!(mem.serving_games.iter().collect::<BTreeSet<_>>(), serving, "serving_games");
            let keyed: BTreeSet<&GameKey> = mem.tables.iter().filter(|(_, m)| m.keyed).map(|(k, _)| k).collect();
            assert_eq!(mem.keyed_games.iter().collect::<BTreeSet<_>>(), keyed, "keyed_games");
        }
        let index = mem.and_then(|mem| mem.index.as_ref()).filter(|_| read);
        let games: BTreeSet<GameKey> = mem
            .into_iter()
            .flat_map(|mem| mem.serving_games.iter().cloned())
            .chain(self.done.keys().filter(|(r, _, _)| r == room).map(|(_, t, inc)| (t.clone(), inc.clone())))
            .chain(self.games_through.keys().cloned())
            .filter(|(_, inc)| ha::is_fair_only_inc(inc))
            .filter(|key| index.is_none_or(|ix| ix.games.contains_key(key)))
            .collect();
        let mut out = GamesOut::default();
        for key in games {
            let (serving, settled) = match self.games_through.get(&key).and_then(|(found, _)| *found) {
                Some(found) => found,
                None => self.remembered(room, &key),
            };
            out.serving += usize::from(serving);
            out.settled += usize::from(settled);
        }
        out
    }

    /// 🔒 FAIR ONLY game `key` as the last pass that knew whether this house serves it found it: whether it served
    /// it, and whether it had settled there. Known on no pass of this run: one it serves and has not settled at where
    /// its state holds that it joined, revealed or stepped down there before a start (a page may close on what it
    /// committed to), else one it does not serve.
    fn remembered(&self, room: &str, key: &(String, String)) -> (bool, bool) {
        let found = self.rooms.get(room).and_then(|mem| mem.tables.get(key)).and_then(|m| m.read_through);
        found.unwrap_or_else(|| (self.done.contains_key(&(room.to_string(), key.0.clone(), key.1.clone())), false))
    }

    /// 🔒 Keep what the fold in shadow is to follow of game `key` ([`GamePlan`]), or let it go (None).
    fn plan_game(&mut self, room: &str, key: &GameKey, plan: Option<GamePlan>) {
        let Some(mem) = self.rooms.get_mut(room) else { return };
        match plan {
            Some(plan) => {
                mem.game_plans.insert(key.clone(), plan);
            }
            None => {
                mem.game_plans.remove(key);
            }
        }
    }

    /// 🔒 Who the houses of a FAIR ONLY game are by round, for the fold: each of `keys` is a house of every round of a
    /// holder's stretch (after its `from`, up to the next holder's, or for good) that the holder delegated it for
    /// ([`ha::Resolution::house_by_with`], with the room's delegation of it, as the walk weighs a house's records: which
    /// goes by the round only through the holder that holds it), as `(key, from, to)`. A stretch that holds no round, or
    /// none after the base `base_u`, is left out. None while a check is put off (`deferred` set).
    fn spans_of(&mut self, room: &str, res: &ha::Resolution, keys: &BTreeSet<&str>, hk: &BTreeMap<String, Hk>, base_u: i64) -> Option<Vec<(String, i64, Option<i64>)>> {
        let mut spans = Vec::new();
        let mut waiting = false;
        for (i, holder) in res.chain.iter().enumerate() {
            let to = res.chain.get(i + 1).map(|next| next.from);
            if to.is_some_and(|to| to <= holder.from.max(base_u)) {
                continue;
            }
            for k in keys {
                match res.house_by_with(k, holder.from + 1, delegation_of(hk, k), &mut |id, key, bytes, g| self.verified_auth(room, id, key, bytes, g)) {
                    ha::HouseBy::Yes { .. } => spans.push((k.to_string(), holder.from, to)),
                    ha::HouseBy::No => {}
                    ha::HouseBy::Pending => waiting = true,
                }
            }
        }
        (!waiting).then_some(spans)
    }

    /// The walk of [`House::games`]: what it finds of each game goes into `games_through`, and what the doc lost of
    /// it into `reput`. Whether the pass brought the room's index of the games' records up to the doc
    /// (house_index.rs).
    fn walk_games<T: ReadTxn>(&mut self, room: &str, txn: &T, comp: &MapRef, now: u64, writes: &mut Vec<Write>, reput: &mut Vec<Write>) -> bool {
        // (Out of the room's memory while the walk reads it, and back after. No index, no games: tick_with attaches it.)
        let Some(mut ix) = self.rooms.get_mut(room).and_then(|mem| mem.index.take()) else {
            self.short = true;
            return false;
        };
        let read = self.walk_indexed(room, txn, comp, now, writes, reput, &mut ix);
        if let Some(mem) = self.rooms.get_mut(room) {
            mem.index = Some(ix);
        }
        read
    }

    /// [`House::walk_games`], from the room's index `ix`.
    #[allow(clippy::too_many_arguments)]
    fn walk_indexed<T: ReadTxn>(&mut self, room: &str, txn: &T, comp: &MapRef, now: u64, writes: &mut Vec<Write>, reput: &mut Vec<Write>, ix: &mut FairIndex) -> bool {
        #[derive(Default)]
        struct Recs {
            cks: Vec<(String, CVal)>,
            xfs: Vec<(String, CVal)>,
            fin: Option<CVal>,
            unclear: bool,
            heals: Vec<Write>,
        }
        let me = self.key.public.clone();
        // (Yjs keeps what came before the records it depends on until they come: the doc holds part of an update, and
        // what it lacks may be in the part to come.)
        let partial = txn.store().pending_update().is_some();
        // 🔒 The room's FAIR ONLY records, from its index (house_index.rs): brought up to what the doc holds, a visit
        // charged for each key noted since the last pass (and the room's keys listed, the first time: the listing
        // comes whatever it costs, and may leave this tick nothing for the games); each game's records read, and
        // charged, when its turn comes; and the room's delegations, read once each after it changed, which every game
        // reads. (A page takes one only under its house's key, casinoDoc fedDelegation: anything under another is
        // nothing to a game.) A key of any other name costs the walk nothing.
        let drained = ix.drain(txn, comp, now, &mut |n, admitted| {
            if admitted {
                self.admit(n);
                return true;
            }
            self.charge(n)
        });
        // 🔒 A game whose every record went, at a game it holds memory of: as one whose base is gone, a hold (below), from
        // the pass that found it so, though that pass, or this one, could not look at every change. And at the first
        // listing of the room's keys (another doc of the room, say), each game it holds memory of that the doc holds no
        // record of.
        if let Some(mem) = self.rooms.get_mut(room) {
            for (key, since) in ix.take_gone() {
                if let Some(table) = mem.tables.get_mut(&key) {
                    table.held_since = Some(table.held_since.map_or(since, |h| h.min(since)));
                }
            }
            if ix.take_listed() {
                for (_, table) in mem.tables.iter_mut().filter(|(key, _)| ha::is_fair_only_inc(&key.1) && !ix.games.contains_key(*key)) {
                    table.held_since.get_or_insert(now);
                }
            }
        }
        // (The keys noted not all looked at: nothing at its games this pass, for one may lack its own record.)
        if !drained {
            self.short = true;
            return false;
        }
        let mut hk_unclear = false;
        let mut hk_read = true;
        let mut hk_heals: Vec<Write> = Vec::new();
        // (What this house's own key holds, when it is a delegation of this house: given to each game as the room's. The
        // room's delegation of another house is weighed only where a game asks of that house, [`delegation_of`].)
        let my_hk = format!("hk:{me}");
        let mut mine: Option<CVal> = None;
        for (key, seen) in ix.hk.iter_mut() {
            if *seen == Hk::Unread {
                let theirs = |v: &CVal| ha::as_delegation(v) && str_of(v, "h") == key.strip_prefix("hk:");
                *seen = match self.read_charged(key.len(), comp.get(txn, key), ha::MAX_SMALL_RECORD_BYTES) {
                    Read::Val(v) if theirs(&v) => match hb::rec_hash(&v) {
                        Some(hash) => Hk::Theirs(v, hash),
                        None => Hk::Nothing,
                    },
                    Read::Val(_) => Hk::Nothing,
                    // (A page may hold anything there: the house's delegation, maybe.)
                    Read::Unclear(_, hb::Clarity::Unknown) => Hk::Unknown,
                    // One a page reads as the house does, or as junk: whole as read, a page might count by it or not, so
                    // the games wait and it goes back as read; junk either way is no matter.
                    Read::Unclear(v, _) if theirs(&v) => Hk::Whole(v),
                    Read::Unclear(..) => Hk::Nothing,
                    // (The tick's reads spent: so is each game's read, which is then short; the rest are read on the
                    // next. Short whether any game is read or not: the step-down's last word reads the room in full.)
                    Read::Spent => {
                        self.short = true;
                        hk_read = false;
                        break;
                    }
                    Read::Absent | Read::Heavy => Hk::Nothing,
                };
            }
            match seen {
                Hk::Theirs(v, _) if *key == my_hk => mine = Some(v.clone()),
                Hk::Unknown => hk_unclear = true,
                Hk::Whole(v) => {
                    hk_unclear = true;
                    hk_heals.push(Write::Top { key: key.clone(), value: v.clone() });
                }
                Hk::Theirs(..) | Hk::Nothing | Hk::Unread => {}
            }
        }
        // 🔒 What stands under this house's own key, which is the only one of the room's that can name it: a delegation
        // there whose signature holds wakes the games none of whose rounds were this house's that its signer holds a
        // round of after their base ([`FairIndex::mine_is`], [`Quiet::Mine`]), a visit of the tick's reads each, as many as
        // they cover (short while any is left). Its check put off: as it was until a pass has it, and short meanwhile,
        // for a game it would wake may be this house's. (Not read this pass: short already, and none.)
        let good = match ix.hk.get(&my_hk) {
            Some(Hk::Theirs(v, hash)) => self.room_delegation_good(room, v, hash).map(|good| good.then(|| (hash.clone(), str_of(v, "k").unwrap_or("").to_string()))),
            Some(Hk::Unread | Hk::Nothing | Hk::Unknown | Hk::Whole(_)) | None => Some(None),
        };
        match good {
            Some(now) => ix.mine_is(now),
            None => self.short = true,
        }
        if !ix.wake_queued(&mut || self.charge(VISIT_BYTES)) {
            self.short = true;
        }
        let hk_healed = !hk_heals.is_empty();
        writes.append(&mut hk_heals);
        // 🔒 The games to read, taking their turns: only the ones the index has awake, from the one whose turn it is
        // ([`FairIndex::order`]), each game's keys as its read gets to them. A game that has nothing for this house, as
        // a pass found it, with nothing changed since that could change that (house_index.rs), costs a pass nothing,
        // and counts as none it serves ([`House::games_count`]); and once the tick's reads are spent, so does every
        // game after. (One found so is passed by once the walk is through with the index.)
        let mut hushed: Vec<(GameKey, Quiet)> = Vec::new();
        for key in ix.order().cloned() {
            #[cfg(test)]
            {
                *self.games_looked.entry(key.0.clone()).or_default() += 1;
            }
            // (Counted as the tick found it, [`House::games_count`].)
            if self.through.contains_key(&key) {
                self.short |= self.games_through.get(&key).is_some_and(|(_, short)| *short);
                continue;
            }
            // Its records, each charged as it is read.
            let mut recs = Recs::default();
            let mut spent = false;
            let Some(game) = ix.games.get(&key) else { continue };
            for (k, kind) in &game.keys {
                let cap = if *kind == Kind::Ck { ha::MAX_CHECKPOINT_BYTES } else { ha::MAX_SMALL_RECORD_BYTES };
                let v = match self.read_charged(k.len(), comp.get(txn, k), cap) {
                    Read::Val(v) => v,
                    // (A page may hold anything there: a record the game counts by, maybe.)
                    Read::Unclear(_, hb::Clarity::Unknown) => {
                        recs.unclear = true;
                        continue;
                    }
                    // (As a delegation: whole as read, the game waits and it goes back as read.)
                    Read::Unclear(v, _) => {
                        let whole = match kind {
                            Kind::Ck => !matches!(ha::read_ck(room, k, &v), ha::CkRead::Junk),
                            Kind::Xf => ha::as_xf(&v, room),
                            Kind::Fin => ha::as_fin(&v),
                        };
                        if whole {
                            recs.unclear = true;
                            recs.heals.push(Write::Top { key: k.clone(), value: v });
                        }
                        continue;
                    }
                    Read::Spent => {
                        spent = true;
                        break;
                    }
                    Read::Absent | Read::Heavy => continue,
                };
                match kind {
                    Kind::Ck => recs.cks.push((k.clone(), v)),
                    Kind::Xf => recs.xfs.push((k.clone(), v)),
                    Kind::Fin => recs.fin = Some(v),
                }
            }
            // (The tick's reads spent on the way: the game waits for a tick that has them, which its turn gives it; and so
            // does every game after it, for none of the tick's reads are left.)
            if spent {
                self.short = true;
                break;
            }
            // A record of the game, or a delegation of the room, a page may read otherwise: nothing at the game this
            // pass (as at a house table, [`House::held`]).
            if hk_unclear || recs.unclear {
                let healed = hk_healed || !recs.heals.is_empty();
                writes.append(&mut recs.heals);
                if healed && !self.last_pass {
                    self.hold_began(room, &key, now);
                    self.reread = true;
                } else {
                    self.held(room, &key, now);
                }
                continue;
            }
            let (t, inc) = key.clone();
            // 🔒 What the fold in shadow is to follow of the game, once the walk has read its session through: a walk that
            // goes through the game short of that leaves it no plan; one cut short keeps the last.
            let mut planned: Option<GamePlan> = None;
            // (A game short of a check: nothing there this pass; and no pass of this tick reads it again once the
            // budget is spent. Whether it serves the game now, when the walk got that far: settled there, then, as
            // when a pass last read it through; and so it counts on the passes after that cannot read it, until one
            // reads further.)
            macro_rules! short {
                ($serving:expr) => {{
                    self.short = true;
                    let found: Option<(bool, bool)> = $serving.map(|serving: bool| (serving, serving && self.remembered(room, &key).1));
                    if let Some(found) = found {
                        self.note_read_through(room, &key, found);
                    }
                    self.games_through.insert(key.clone(), (found, true));
                    if self.budget == 0 || self.read_out {
                        self.through.insert(key.clone(), (false, true));
                    }
                    continue;
                }};
            }
            macro_rules! through {
                ($serving:expr, $settled:expr) => {{
                    let found: (bool, bool) = ($serving, $settled);
                    self.note_read_through(room, &key, found);
                    self.plan_game(room, &key, planned.take());
                    self.through.insert(key.clone(), (false, false));
                    self.games_through.insert(key.clone(), (Some(found), false));
                    continue;
                }};
            }
            self.deferred = false;
            // (The delegation this house was last a house of the game by, as the doc held it where the doc lacks it:
            // after the doc's, so one of the doc's goes first.)
            let held: Vec<CVal> = self.rooms[room].tables.get(&key).map(|m| m.deleg.iter().chain(&m.earlier).cloned().collect()).unwrap_or_default();
            // 🔒 (And the last checkpoint this house signed for the game, as its rows file has it, where the doc holds
            // something else under its key or nothing: a page counts it until it is gone, design-final section 8.5 N5.)
            let row = self.rows.get(&(room.to_string(), t.clone(), inc.clone())).cloned();
            let row_held = row.as_ref().is_some_and(|row| recs.cks.iter().any(|(k, v)| *k == row.key && hb::rec_hash(v) == hb::rec_hash(&row.value)));
            let res = {
                let rec = ha::AuthRecords {
                    cks: recs.cks.iter().map(|(k, v)| (k.as_str(), v)).chain(row.iter().filter(|_| !row_held).map(|row| (row.key.as_str(), &row.value))).collect(),
                    xfs: recs.xfs.iter().map(|(k, v)| (k.as_str(), v)).collect(),
                    fins: recs.fin.iter().collect(),
                    delegations: mine.iter().chain(held.iter()).collect(),
                };
                ha::resolve_game(room, &t, &inc, None, &rec, &mut |id, k, bytes, g| self.verified_auth(room, id, k, bytes, g))
            };
            // 🔒 Its forged records (a `ck:` or an `xf:` read whole, whose own signature fails under the key it claims,
            // and every checkpoint that carries such a transfer: they can never count), deleted at the put-back's turn
            // as the pages delete them (design-final section 8.4 P7), whether the resolution waits or not: a flood of
            // them is what holds it off. Not while the doc holds part of an update, as on the pages.
            if !partial {
                reput.extend(res.invalid.iter().map(|k| Write::Delete { key: k.clone() }));
            }
            // 🔒 N5: its last checkpoint, gone from the doc or with something else under its key, while no checkpoint
            // stands above it, goes back at the put-back's turn, with the session it opens; not while the doc holds part
            // of an update (it and its session may be in the part to come). One above it: the row has done its work.
            if let (Some(row), false) = (&row, res.pending) {
                match res.base.as_ref() {
                    Some(b) if b.key == row.key => {
                        if !row_held && !partial {
                            reput.push(restore_of(&Ctx { room: room.to_string(), t: t.clone(), inc: inc.clone() }, row, true));
                        }
                    }
                    Some(b) if uw_of(&b.ck) > uw_of(&row.value) => self.drop_row(room, &t, &inc),
                    _ => {}
                }
            }
            if res.pending {
                // (A check put off; or more forged transfers than a resolution walks past, which the pages delete.)
                if self.deferred {
                    short!(None);
                }
                through!(false, false);
            }
            // (A check put off that could not change the answer.)
            let put_off = std::mem::take(&mut self.deferred);
            // (Whether nothing it found here is left to do, should the game be one that has nothing for this house: no
            // forged record to delete, now or once the doc holds no part of an update, and no check put off, which may
            // find one: when it comes, it changes no record, so the index would not wake the game for it. What the rest
            // of an update brings is a change of the records, which the index notes.)
            let tidy = res.invalid.is_empty() && !put_off;
            let Some(base) = res.base.as_ref().filter(|_| !res.newer && res.live) else {
                if let Some(mem) = self.rooms.get_mut(room).filter(|mem| mem.tables.contains_key(&key)) {
                    let table = mem.tables.get_mut(&key).unwrap();
                    // (Over, or under rules this build does not know: its delegation wants no key. A game whose base the
                    // doc has lost is neither, and its put-back is the pages'.)
                    if res.base.is_some() {
                        table.keyed = false;
                        mem.keyed_games.remove(&key);
                    }
                    // 🔒 Meanwhile it reads no close of the game, so this is a hold, as when its session's map is gone: a
                    // close it first reads once it serves the game again counts as there since now, for the cutoff
                    // (only at a game it holds memory of: one it does not, it settles at, design B2).
                    table.held_since.get_or_insert(now);
                }
                // (None of which a delegation changes: it stays so until a record of the game does.)
                if tidy {
                    hushed.push((key.clone(), Quiet::Records));
                }
                through!(false, false)
            };
            let base_u = base.ck.get("u").and_then(CVal::as_int).unwrap_or(0);
            // Whose game (design-final sections 8.5 N1 and 8.7): this house is a house of the rounds its delegator
            // holds the game for.
            let last = res.chain.len() - 1;
            let by_now = res.house_by(&me, base_u.max(res.chain[last].from) + 1, &mut |id, k, bytes, g| self.verified_auth(room, id, k, bytes, g));
            let mut by = by_now.clone();
            // (A base at or past the round an earlier holder left at gives none: the first round past it is not theirs.)
            for i in (0..last).rev() {
                if by != ha::HouseBy::No {
                    break;
                }
                by = res.house_by(&me, base_u.max(res.chain[i].from) + 1, &mut |id, k, bytes, g| self.verified_auth(room, id, k, bytes, g));
            }
            // (Only a game it serves now counts for the room's beat: a game that has left its key never settles here.)
            let current = matches!(by_now, ha::HouseBy::Yes { .. });
            match by {
                // 🔒 A house of none of the game's rounds to come or in flight (handed on, or its delegation gone): it
                // reads no close made from now on as their house, so one it first reads once it serves the game again
                // counts as there since now, for the cutoff, as after a hold; a spell of a tick (a delegation deleted,
                // and put back) costs nothing. (Only at a game it holds memory of.)
                ha::HouseBy::No => {
                    if let Some(mem) = self.rooms.get_mut(room) {
                        if let Some(table) = mem.tables.get_mut(&key) {
                            table.held_since.get_or_insert(now);
                            table.keyed = false;
                            mem.keyed_games.remove(&key);
                        }
                    }
                    // (So until a record of the game changes, or this house's key holds a delegation whose signature holds
                    // that a key holding one of its rounds after its base signed: no other delegation of the room's names
                    // it, the ones its own records carry are its records, and one of any other key, an earlier holder's
                    // whose rounds are over among them, makes none of its rounds this house's.)
                    if tidy {
                        let holders = res.chain.iter().enumerate().filter(|(i, _)| res.chain.get(i + 1).is_none_or(|next| next.from > base_u));
                        hushed.push((key.clone(), Quiet::Mine(holders.map(|(_, h)| h.k.clone()).collect())));
                    }
                    through!(false, false)
                }
                ha::HouseBy::Pending => short!(None),
                ha::HouseBy::Yes { ref value, ref hash } => {
                    chain_put_backs(&t, &inc, &res, reput);
                    // (Not the one the base carries: a game needs no key for it, and the pages hold none such,
                    // casinoDoc keepHouses.)
                    let carried = res.base.as_ref().and_then(|b| b.ck.get("dl")).and_then(hb::rec_hash);
                    let keyed = carried.as_deref() != Some(hash.as_str());
                    let mem = self.rooms.get_mut(room).unwrap();
                    let table = mem.tables.entry(key.clone()).or_default();
                    table.keyed = keyed;
                    keep_earlier(table, value.clone(), &res.chain);
                    if keyed {
                        mem.keyed_games.insert(key.clone());
                    } else {
                        mem.keyed_games.remove(&key);
                    }
                }
            }
            let ctx = Ctx { room: room.to_string(), t, inc };
            let Some(sid) = hb::next_sid3(&ctx, &base.ck) else { through!(current, false) };
            // 🔒 The session's map gone: it goes back at the put-back's turn (design-final section 8.5 N5), but not
            // while the doc holds part of an update (the map may be in the part to come); and the records it lost go
            // back into it, its own from this house, the pages' from them. Meanwhile it reads no close of the game, so
            // this is a hold: a close it first reads once the map is back counts as there since now, for the cutoff
            // (the pages void one they saw that long). Nothing at the game meanwhile, and not settled there.
            let ses_key = format!("ses:{}:{}:{sid}", ctx.t, ctx.inc);
            if !matches!(comp.get(txn, &ses_key), Some(Out::YMap(_))) {
                // (Its reveals from before a start among them, [`House::own_from_before`].)
                self.hold_began(room, &key, now);
                // (Not where its checkpoint goes back with it in the same write: that one carries what goes into it. And
                // of its row's checkpoint, the doc holding it, as its row would put it back: with what its trim carried.)
                let restored = reput.iter().any(|w| matches!(w, Write::Restore { ses: Some((next, _, _)), .. } if *next == ses_key));
                if !partial && !restored {
                    let of_row = row.as_ref().filter(|row| row.key == base.key).map(|row| restore_of(&ctx, row, false));
                    reput.push(of_row.filter(|w| matches!(w, Write::Restore { ses: Some(_), .. })).unwrap_or(Write::NewSession { ses: ses_key }));
                }
                through!(current, false);
            }
            self.unclear = false;
            self.healing = false;
            self.heals.clear();
            let h = str_of(&base.ck, "h").map(str::to_string);
            #[cfg(test)]
            {
                self.table_reads += 1;
            }
            let read = self.read_session(comp, txn, ctx, Base { u: base_u, h, sid }, Houses::Game(&res, &ix.hk));
            let healed = !self.heals.is_empty() || self.healing;
            writes.append(&mut self.heals);
            if self.unclear {
                if healed && !self.last_pass {
                    self.hold_began(room, &key, now);
                    self.reread = true;
                } else {
                    self.held(room, &key, now);
                }
                continue;
            }
            let Some(read) = read else { through!(current, false) };
            if self.deferred {
                short!(Some(current));
            }
            // The rounds it may act at, asked before it writes anything.
            let done = read.own_reveals().map(|e| e.r).fold(self.done_of(&read.ctx), i64::max);
            let hi = read.next_round().max(done + 1) + 1;
            let lo = (done + 1).min(read.base_u + 1).max(hi - 2 * MAX_HELD_ROUNDS - 16);
            let mut view = GameView { mine: HashSet::new(), houses_before: HashSet::new(), joins: current };
            for r in lo..=hi {
                if res.house_at(&me, r, &mut |id, k, bytes, g| self.verified_auth(room, id, k, bytes, g)) == Some(true) {
                    view.mine.insert(r);
                }
            }
            let before = read.next_round() - 1;
            let others: HashSet<&str> = read.joins.iter().map(|o| o.k.as_str()).chain(read.reveals.iter().map(|e| e.k.as_str())).filter(|k| *k != me).collect();
            for k in others {
                if res.house_at_with(k, before, delegation_of(&ix.hk, k), &mut |id, key, bytes, g| self.verified_auth(room, id, key, bytes, g)) == Some(true) {
                    view.houses_before.insert(k.to_string());
                }
            }
            // 🔒 What the fold in shadow follows of the game: its base, the session that follows it, and who its houses
            // are by round, of this house and of every house whose join or reveal the session holds (a record of any
            // other key is no house's at its round, and the fold counts it so with no span of its key).
            let mut keys: BTreeSet<&str> = read.joins.iter().map(|o| o.k.as_str()).chain(read.reveals.iter().map(|e| e.k.as_str())).collect();
            keys.insert(me.as_str());
            if let (Some(spans), Some(name)) = (self.spans_of(room, &res, &keys, &ix.hk, read.base_u), res.name.as_ref()) {
                let sid = read.ses_key.rsplit(':').next().unwrap_or("").to_string();
                planned = Some(GamePlan { t: key.0.clone(), inc: key.1.clone(), rv: name.rv.clone(), base_key: base.key.clone(), base: base.ck.clone(), sid, spans });
            }
            if self.deferred {
                short!(Some(current));
            }
            self.table_duties(room, &read, res.fin.is_some(), now, writes, Some(&view));
            // 🔒 The trim (design-final section 8.5 N3), at a game it serves now, while no end order stands. Not from a doc
            // that holds part of an update: a close, or a frozen slip a page is putting back, may be in the part to come,
            // and a trim deletes the session it would land in. What it waits for it waits for afresh after.
            if let (true, None, ha::HouseBy::Yes { value: dl, .. }) = (current, res.fin.as_ref(), &by_now) {
                if partial {
                    if let Some(mem) = self.rooms.get_mut(room).and_then(|m| m.tables.get_mut(&key)) {
                        mem.waits.clear();
                    }
                } else if let Some(spans) = planned.as_ref().map(|p| p.spans.clone()) {
                    // (What it deletes: the game's checkpoints, and the sessions the ones it read open, the live one among them.)
                    let cks = ix.games.get(&key).map_or(vec![], |g| g.keys.iter().filter(|(_, k)| **k == Kind::Ck).map(|(k, _)| k.clone()).collect());
                    let sessions = recs.cks.iter().filter_map(|(_, v)| hb::next_sid3(&read.ctx, v)).map(|sid| format!("ses:{}:{}:{sid}", key.0, key.1));
                    let mut gone: Vec<String> = cks.into_iter().chain(sessions).chain([read.ses_key.clone()]).collect();
                    gone.sort();
                    gone.dedup();
                    let x: Vec<CVal> = res.chain.iter().skip(1).filter_map(|h| h.step.as_ref().map(|s| s.xf.clone())).collect();
                    let g = TrimOf { base, dl, x, from: res.chain[last].from, spans: &spans, gone };
                    if self.trim_duty(room, txn, comp, &read, &g, now, writes) == Trimmed::Wait {
                        short!(Some(current));
                    }
                }
            }
            let first_read = self.rooms[room].tables.get(&key).and_then(|m| m.first_read).unwrap_or(now);
            let settled = current && now.saturating_sub(first_read) >= self.settle_ms;
            through!(current, settled);
        }
        for (key, quiet) in hushed {
            ix.hush(&key, quiet);
        }
        // 🔒 (A game the doc holds no record of has no plan: the walk goes through it no more.)
        if let Some(mem) = self.rooms.get_mut(room) {
            mem.game_plans.retain(|k, _| ix.games.contains_key(k));
        }
        // 🔒 N5: a game the doc holds no record of any more, whose last checkpoint this house signed: it goes back, as the
        // best of the game with nothing else there.
        let lost: Vec<(GameKey, Row)> = self.rows.range((room.to_string(), String::new(), String::new())..).take_while(|((r, _, _), _)| r == room).filter(|((_, t, inc), _)| !ix.games.contains_key(&(t.clone(), inc.clone()))).map(|((_, t, inc), row)| ((t.clone(), inc.clone()), row.clone())).collect();
        for ((t, inc), row) in lost {
            let rec = ha::AuthRecords { cks: vec![(row.key.as_str(), &row.value)], xfs: vec![], fins: vec![], delegations: mine.iter().collect() };
            let res = ha::resolve_game(room, &t, &inc, None, &rec, &mut |id, k, bytes, g| self.verified_auth(room, id, k, bytes, g));
            if !partial && !res.pending && res.base.is_some_and(|b| b.key == row.key) {
                reput.push(restore_of(&Ctx { room: room.to_string(), t, inc }, &row, true));
            }
        }
        // 🔒 This house's key holds one value (`hk:<house>`), and each game it serves by a delegation that game's base
        // does not carry wants its own there. One goes back only over what no game can go by: nothing, junk, another
        // house's, or one of this house whose signature fails. A good delegation of this house stays, whoever signed
        // it: it may be a new holder's that a game this pass could not resolve goes by (an earlier holder's, or a
        // stranger's, the pages write over, casinoDoc hkOver). Of the ones wanted, the one of lowest hash, the same
        // whichever games a pass gets to, so two games handed to different holders never write over each other's; the
        // others go by the delegation the house holds for them ([`TableMem::deleg`]). (Only of the games the doc holds
        // records of; and only from a pass that read every delegation of the room, clear: until then the key may hold
        // one the pass could not tell.)
        if hk_read && !hk_unclear {
            let mem = &self.rooms[room];
            let wanted = mem.keyed_games.iter().filter(|k| ix.games.contains_key(*k)).filter_map(|k| mem.tables.get(k)?.deleg.as_ref());
            let best = wanted.filter_map(|d| Some((hb::rec_hash(d)?, d))).min_by(|a, b| a.0.cmp(&b.0)).map(|(_, d)| d.clone());
            if let Some(best) = best {
                // (Its check put off: the next pass.)
                let good = match mine.as_ref().filter(|m| ha::as_delegation(m)) {
                    Some(m) => self.room_delegation_good(room, m, &hb::rec_hash(m).unwrap_or_default()),
                    None => Some(false),
                };
                if good == Some(false) {
                    reput.push(Write::Top { key: my_hk, value: best });
                }
            }
        }
        true
    }

    /// 🔒 Whether delegation `d` (its hash `hash`), under a house's key in room `room`, is signed by the key it names, as
    /// each game checks it ([`ha::Resolution::house_by`]): None while its check waits ([`House::verified_auth`]).
    fn room_delegation_good(&mut self, room: &str, d: &CVal, hash: &str) -> Option<bool> {
        let g = str_of(d, "g").unwrap_or("");
        self.verified_auth(room, &ha::sig_id("hkey", "", "", hash), str_of(d, "k").unwrap_or(""), &|| hb::room_sign_bytes("hkey", room, "", d).map(|b| b.to_vec()), g)
    }

    /// 🔒 FAIR ONLY game `key` read through, or far enough to know whether this house serves it: whether it does and
    /// has settled there, for the passes that cannot read it ([`House::remembered`]). (Not kept where it is what the
    /// house would remember without it, a game it holds nothing of: junk under new names would only grow the memory.)
    fn note_read_through(&mut self, room: &str, key: &(String, String), found: (bool, bool)) {
        let before = self.done.contains_key(&(room.to_string(), key.0.clone(), key.1.clone()));
        let mem = self.rooms.get_mut(room).unwrap();
        if mem.tables.contains_key(key) || found != (before, false) {
            mem.tables.entry(key.clone()).or_default().read_through = Some(found);
            if found.0 {
                mem.serving_games.insert(key.clone());
            } else {
                mem.serving_games.remove(key);
            }
        }
    }

    /// Read table `ctx`'s live session (None when the doc holds none, or its
    /// incarnation has ended). `owner_key`: the deed holder's, whose
    /// delegations make the houses (house_of). A check put off on the way
    /// sets `deferred`: the read is short of it.
    fn read_table<T: ReadTxn>(&mut self, comp: &MapRef, txn: &T, ctx: Ctx, owner_key: &str) -> Option<TableRead> {
        // (This tick's reads spent, or a checkpoint heavier than a tick may
        // read: short, the table does nothing.)
        #[cfg(test)]
        {
            self.table_reads += 1;
        }
        self.unclear = false;
        self.healing = false;
        self.heals.clear();
        let cp_key = format!("sum:{}:{}", ctx.t, ctx.inc);
        let cp = match self.read_charged(cp_key.len(), comp.get(txn, &cp_key), READ_PER_TICK.max(self.read_left)) {
            Read::Val(v) => Some(v).filter(|v| checkpoint_ok(v, &ctx.inc)),
            // One a page may read otherwise: a page taking it counts from
            // it, one that doesn't from the first session. The table waits,
            // and it goes back as read (junk either way: no base).
            Read::Unclear(v, hb::Clarity::Proto) => {
                if !checkpoint_ok(&v, &ctx.inc) {
                    None
                } else {
                    self.unclear = true;
                    self.heals.push(Write::Top { key: cp_key, value: v });
                    return None;
                }
            }
            // (A page holds the checkpoint there before.)
            Read::Unclear(_, _) => {
                self.unclear = true;
                return None;
            }
            Read::Absent => None,
            Read::Heavy | Read::Spent => {
                self.deferred = true;
                return Some(TableRead::short(ctx, self.key.public.clone()));
            }
        };
        if cp.as_ref().is_some_and(|v| v.get("e").is_some()) {
            return None;
        }
        let sid = hb::next_sid(&ctx, cp.as_ref())?;
        let u = cp.as_ref().and_then(|v| v.get("u").and_then(CVal::as_int)).unwrap_or(0);
        let h = cp.as_ref().and_then(|v| str_of(v, "h")).map(str::to_string);
        self.read_session(comp, txn, ctx, Base { u, h, sid }, Houses::Deed(owner_key))
    }

    /// Table `ctx`'s live session, the one `base` opens (None when the doc holds none). 🔒 At a FAIR ONLY game the
    /// fold's rules there (computedFold S6): a close that names no commitment is junk (a), as is one more than
    /// [`MAX_HELD_ROUNDS`] past the base (b), and an abandon counts only from the key of a frozen slip of its close
    /// that is there and good (d). (Not (e), the cap on a game's players: the trim's fold has it, and a close past
    /// it is revealed for nothing.) The caller has cleared `unclear` and `heals`.
    fn read_session<T: ReadTxn>(&mut self, comp: &MapRef, txn: &T, ctx: Ctx, base: Base, houses: Houses) -> Option<TableRead> {
        let fo = ha::is_fair_only_inc(&ctx.inc);
        let Base { u: base_u, h: cp_h, sid } = base;
        let ses_key = format!("ses:{}:{}:{sid}", ctx.t, ctx.inc);
        let Some(Out::YMap(ses)) = comp.get(txn, &ses_key) else { return None };
        let craps = craps_inc(&ctx.inc);
        let me = self.key.public.clone();

        let mut read = TableRead {
            ctx,
            base_u,
            cp_h,
            ses_key,
            slips: HashMap::new(),
            seeds: HashMap::new(),
            opened: HashMap::new(),
            closes: Vec::new(),
            top: base_u,
            abandoned: HashSet::new(),
            reveals: Vec::new(),
            joins: Vec::new(),
            records: Vec::new(),
            keys: if fo { ses.len(txn) as usize } else { 0 },
            me,
        };
        let at = [read.ctx.room.clone(), read.ctx.t.clone(), read.ctx.inc.clone()];
        let at = [at[0].as_str(), at[1].as_str(), at[2].as_str()];
        let ses_name = read.ses_key.clone();
        // Each record a page may read otherwise ([`hb::Clarity::Proto`]): a
        // page reads it as the house does, or as junk. One that is junk
        // either way is no matter; one good as read, a page might count or
        // not, and the table waits ([`House::heal`]). Closes and seeds
        // carry their key here for that.
        let mut closes: Vec<(Close, CVal, Option<String>)> = Vec::new();
        let mut unclear_seeds: Vec<(i64, String, String, String, CVal)> = Vec::new();
        let mut abandons: Vec<(String, i64, String, CVal)> = Vec::new();
        let mut forfeits: Vec<Forfeit> = Vec::new();
        let mut house_recs: Vec<(char, i64, String, CVal, String, Option<String>)> = Vec::new();
        for (key, out) in ses.iter(txn).take(MAX_SESSION_KEYS) {
            // (This tick's reads spent: the read is short, `deferred` set. A
            // key that isn't UTF-8 no page holds: the update bringing it was
            // refused. One longer than any record's is read no further than
            // its length, which the tick is charged.)
            let parsed = if key.len() <= MAX_KEY_BYTES && hb::utf8(key) { parse_key(key) } else { None };
            let Some((kind, r, pid, h)) = parsed else {
                if !self.charge(key.len() + VISIT_BYTES) {
                    return Some(read);
                }
                continue;
            };
            let (v, clarity) = match self.read_charged(key.len(), Some(out), MAX_RECORD_BYTES) {
                Read::Val(v) => (v, hb::Clarity::Clear),
                // (A page holds what was under the key before: maybe the
                // record the key names.)
                Read::Unclear(_, hb::Clarity::Unknown) => {
                    self.unclear = true;
                    continue;
                }
                Read::Unclear(v, c) => (v, c),
                Read::Spent => return Some(read),
                Read::Absent | Read::Heavy => continue,
            };
            let clear = clarity == hb::Clarity::Clear;
            // The key must be the body's own (its round, pid and hash).
            if !key_is_own(r, pid, h, &v) {
                continue;
            }
            if fo && clear {
                read.records.push(key.to_string());
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
                            let slip = Slip { r, pid: pid.unwrap().to_string(), c: c.to_string(), k, chips, v };
                            if clear {
                                read.slips.insert(h.to_string(), slip);
                            } else if self.slip_ok(at, h, &slip, &read.ctx) {
                                self.heal(&ses_name, key, slip.v);
                            }
                        }
                    }
                }
                'x' => {
                    if let Some(s) = str_of(&v, "s").filter(|s| hex_of(s, 64) && has_fields(&v, &["r", "p", "s"], &[])) {
                        if clear {
                            read.seeds.entry((r, pid.unwrap().to_string())).or_default().push(s.to_string());
                        } else {
                            unclear_seeds.push((r, pid.unwrap().to_string(), s.to_string(), key.to_string(), v.clone()));
                        }
                    }
                }
                'c' => {
                    if !has_fields(&v, &["r", "q", "f", "k", "g"], &["h"]) || !g_ok {
                        continue;
                    }
                    let q = str_of(&v, "q").filter(|q| *q == "g" || hex_of(q, 24) || hex_of(q, 32));
                    let ch = v.get("h").map(|x| x.as_str().filter(|x| hex_of(x, 64)));
                    let f = close_frozen(&v);
                    let (Some(q), Some(f), Some(k)) = (q, f, k) else { continue };
                    if ch == Some(None) {
                        continue;
                    }
                    // 🔒 (S6 a, b.)
                    if fo && (ch.is_none() || r > base_u + MAX_HELD_ROUNDS) {
                        continue;
                    }
                    let rank = hb::duty_rank("close", &read.ctx, r, &k);
                    let close = Close { hash: h.to_string(), r, q: q.to_string(), f, k, h: ch.flatten().map(str::to_string), rank };
                    closes.push((close, v, (!clear).then(|| key.to_string())));
                }
                'f' => {
                    let n = forfeit_ids(&v);
                    if has_fields(&v, &["r", "x", "n", "k", "g"], &[]) && g_ok {
                        if let (Some(x), Some(n), Some(k)) = (str_of(&v, "x").filter(|x| hex_of(x, 32)), n, k) {
                            let f = Forfeit { hash: h.to_string(), r, x: x.to_string(), n, k, v };
                            if clear {
                                forfeits.push(f);
                            } else {
                                let g = str_of(&f.v, "g").unwrap_or("").to_string();
                                if self.verified("forfeit", at, h, &f.k, hb::sign_bytes("forfeit", &read.ctx, &f.v), &g) == Some(true) {
                                    self.heal(&ses_name, key, f.v);
                                }
                            }
                        }
                    }
                }
                'z' => {
                    if has_fields(&v, &["r", "x", "k", "g"], &[]) && g_ok {
                        if let (Some(x), Some(k)) = (str_of(&v, "x").filter(|x| hex_of(x, 32)), k) {
                            if clear {
                                abandons.push((x.to_string(), r, k, v));
                            } else if self.abandon_ok(at, &read.ctx, r, &k, &v) {
                                self.heal(&ses_name, key, v);
                            }
                        }
                    }
                }
                'h' | 'o' if g_ok => {
                    if let Some(k) = k {
                        let house = match &houses {
                            Houses::Deed(owner_key) => self.house_of(comp, txn, &read.ctx.room, owner_key, &k),
                            Houses::Game(res, hk) => {
                                let room = read.ctx.room.clone();
                                res.house_at_with(&k, r, delegation_of(hk, &k), &mut |id, key, bytes, g| self.verified_auth(&room, id, key, bytes, g))
                            }
                        };
                        if house == Some(true) {
                            house_recs.push((kind, r, h.to_string(), v, k, (!clear).then(|| key.to_string())));
                        }
                    }
                }
                _ => {}
            }
        }

        // Which slips the seeds here open: each seed hashed once, and only
        // for a round and player a slip here has (a peer's many slips and
        // seeds for one player cost a read their count, not its square).
        let wanted: HashSet<(i64, &str)> = read.slips.values().map(|s| (s.r, s.pid.as_str())).collect();
        let mut opened: HashMap<(i64, String), HashSet<String>> = HashMap::new();
        for ((r, pid), ss) in &read.seeds {
            if wanted.contains(&(*r, pid.as_str())) {
                opened.entry((*r, pid.clone())).or_default().extend(ss.iter().map(|x| hb::slip_commit(&read.ctx, *r, pid, x)));
            }
        }
        read.opened = opened;

        // The houses' records count as each signed them: a peer's copy under
        // this house's key (a reveal of a high round, say) would stop it
        // joining and revealing; under another's, change what a round may
        // name. Shapes as computedFold asHouseReveal and asHouseCommit.
        let hexes = |v: &CVal, key: &str, max: usize| -> Option<Vec<String>> {
            let xs: Option<Vec<String>> = v.get(key)?.as_arr()?.iter().map(|x| x.as_str().filter(|x| hex_of(x, 32)).map(str::to_string)).collect();
            xs.filter(|xs| xs.len() <= max && xs.windows(2).all(|w| w[0] < w[1]))
        };
        for (kind, r, hash, v, k, unclear) in house_recs {
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
                    if let Some(key) = &unclear {
                        self.heal(&ses_name, key, v.clone());
                        continue;
                    }
                    let commit = hb::house_commit(&read.ctx, r, s);
                    read.reveals.push(Reveal { k, r, hash, commit, x, n, c: c.flatten() });
                }
            } else if let Some(c) = str_of(&v, "c").filter(|c| hex_of(c, 64) && has_fields(&v, &["r", "c", "k", "g"], &[])) {
                let c = c.to_string();
                if self.verified("hcommit", at, &hash, &k, hb::sign_bytes("hcommit", &read.ctx, &v), &g) == Some(true) {
                    if let Some(key) = &unclear {
                        self.heal(&ses_name, key, v.clone());
                        continue;
                    }
                    read.joins.push(Join { k, r, hash, c });
                }
            }
        }

        // A close counts when it is signed by one of the slips it freezes,
        // that slip as the pages take it (computedFold closeInfo): its
        // signature good, chips on it. One the pages throw out would only
        // void the round's real close if revealed.
        let mut good: Vec<Close> = Vec::new();
        for (c, v, unclear) in closes {
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
                match unclear {
                    Some(key) => self.heal(&ses_name, &key, v),
                    None => good.push(c),
                }
            }
        }
        // A seed a page may not have: one opening a slip there.
        // (Each hashed once, its slips looked up.)
        let commits: HashSet<(i64, &str, &str)> = read.slips.values().map(|s| (s.r, s.pid.as_str(), s.c.as_str())).collect();
        for (r, pid, seed, key, v) in unclear_seeds {
            if commits.contains(&(r, pid.as_str(), hb::slip_commit(&read.ctx, r, &pid, &seed).as_str())) {
                self.heal(&ses_name, &key, v);
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
            // (Of its close's round: the fold counts no other, computedFold decide. 🔒 And at a FAIR ONLY game only
            // from a frozen bettor of the close, S6 d.)
            let Some(of) = read.closes.iter().find(|c| c.hash == x).cloned() else { continue };
            if of.r != r || (fo && !self.frozen_key(&read, &of, &k)) {
                continue;
            }
            if self.abandon_ok(at, &read.ctx, r, &k, &v) {
                read.abandoned.insert(x);
            }
        }
        Some(read)
    }

    /// Table `key` held this tick: nothing there, and closes it first sees
    /// once the hold is over count as seen when it began.
    fn held(&mut self, room: &str, key: &(String, String), now: u64) {
        self.through.insert(key.clone(), (false, false));
        self.held_now.insert(key.clone());
        self.hold_began(room, key, now);
    }

    /// Table `key` waits from `now` on, if it did not already: a close the
    /// house first sees once it reads the table again counts as there since
    /// then ([`TableMem::held_since`]), whether that is the next pass or,
    /// the tick's reading spent first, a later tick.
    fn hold_began(&mut self, room: &str, key: &(String, String), now: u64) {
        self.own_from_before(room, key);
        let mem = self.rooms.get_mut(room).unwrap().tables.entry(key.clone()).or_default();
        mem.held_since.get_or_insert(now);
    }

    /// After a start, its reveals at table `key` from before ([`Done::kept`])
    /// go back as this run's do: once, the first time it reads the table or
    /// holds it (held over its own record, a value a page may read
    /// otherwise, the table waits on the put-back to read it again).
    fn own_from_before(&mut self, room: &str, key: &(String, String)) {
        let done = self.done.get(&(room.to_string(), key.0.clone(), key.1.clone()));
        let mem = self.rooms.get_mut(room).unwrap().tables.entry(key.clone()).or_default();
        if mem.kept_in {
            return;
        }
        mem.kept_in = true;
        for k in done.map_or(&[][..], |d| &d.kept[..]) {
            if !mem.written.iter().any(|(_, key, _)| *key == k.key) {
                mem.written.push((k.ses.clone(), k.key.clone(), k.rec.clone()));
            }
        }
    }

    /// Record `key` of session `ses`, good as the house reads it, a page may
    /// count or not ([`hb::Clarity::Proto`]): the table waits this pass,
    /// and the record goes back under its key as read, which every page
    /// reads alike (the same record, if it counted it already).
    fn heal(&mut self, ses: &str, key: &str, v: CVal) {
        self.unclear = true;
        self.heals.push(Write::Session { ses: ses.to_string(), key: key.to_string(), value: v });
    }

    /// A slip's signature, checked once.
    fn slip_ok(&mut self, at: [&str; 3], hash: &str, s: &Slip, ctx: &Ctx) -> bool {
        let g = str_of(&s.v, "g").unwrap_or("").to_string();
        self.verified("slip", at, hash, &s.k, hb::sign_bytes("slip", ctx, &s.v), &g) == Some(true)
    }

    /// 🔒 Whether `k` signed a frozen slip of close `c` that is there and good (computedFold S6 d: only such a key's
    /// abandon counts at a FAIR ONLY game).
    fn frozen_key(&mut self, read: &TableRead, c: &Close, k: &str) -> bool {
        let ctx = &read.ctx;
        let at = [ctx.room.as_str(), ctx.t.as_str(), ctx.inc.as_str()];
        let craps = craps_inc(&ctx.inc);
        for (p, sh) in &c.f {
            let Some(s) = read.slips.get(sh) else { continue };
            if s.pid == *p && s.r == c.r && s.k == k && (craps || s.chips) && self.slip_ok(at, sh, s, ctx) {
                return true;
            }
        }
        false
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
        let seeded = |_: &str, s: &Slip| read.opens(s);
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
            let fo = ha::is_fair_only_inc(&ctx.inc);
            for (x, r, k, v) in abandons.iter().filter(|(x, r, _, _)| *x == c.hash && *r == c.r) {
                let _ = x;
                if (!fo || self.frozen_key(read, c, k)) && self.abandon_ok(at, ctx, *r, k, v) {
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
    /// 🔒 At a FAIR ONLY game (`game`): only at the rounds this house decides, `friendly` meaning an end order stands
    /// (it reveals with no next commitment, steps down and joins nothing).
    fn table_duties(&mut self, room: &str, read: &TableRead, friendly: bool, now: u64, writes: &mut Vec<Write>, game: Option<&GameView>) {
        let ctx = &read.ctx;
        let fo = game.is_some();
        let mine = |r: i64| game.is_none_or(|g| g.mine.contains(&r));
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
        self.own_from_before(room, &key);
        let mem = self.rooms.get_mut(room).unwrap().tables.entry(key.clone()).or_default();
        let settling = now.saturating_sub(*mem.first_read.get_or_insert(now)) < settle_ms;
        // (After a hold, a close first seen counts as there since it began,
        // for the cutoff.)
        let there_from = mem.held_since.take().map_or(now, |h| h.min(now));
        // A trim opened a new session: what was written into the old one is
        // the trim's to carry (its copies and the checkpoint's `h`).
        mem.written.retain(|(ses, _, _)| *ses == read.ses_key);
        // Seeds as they come: when each slip's seed was first seen.
        for (hash, slip) in &read.slips {
            if mem.seed_seen.contains_key(hash) {
                continue;
            }
            if read.opens(slip) {
                mem.seed_seen.insert(hash.clone(), now);
            }
        }

        // The rounds with closes naming this house's commitment, lowest first.
        let mut rounds: Vec<i64> = read.closes.iter().map(|c| c.r).filter(|r| *r > done).collect();
        rounds.sort();
        rounds.dedup();
        let mut revealed_now: Option<i64> = None;
        for r in rounds {
            // 🔒 (A round its delegator does not hold the game for is not this house's: no page would count its reveal.)
            if !mine(r) {
                continue;
            }
            let commit = self.commit(ctx, r);
            let mem = self.rooms.get_mut(room).unwrap().tables.get_mut(&key).unwrap();
            let mut listed: Vec<&Close> = Vec::new();
            for c in read.closes_at(r).filter(|c| c.h.as_deref() == Some(commit.as_str())) {
                if !mem.first_seen.contains_key(&c.hash) {
                    mem.first_seen.insert(c.hash.clone(), (now, there_from));
                    // 🔒 At a FAIR ONLY game only a close first seen while settling is blocked (design B2): an abandon, or
                    // a later close, would let anyone hold the house off a round, which there nobody else can decide.
                    if settling || (!fo && (read.abandoned.contains(&c.hash) || read.top > r)) {
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
            let t0 = listed.iter().map(|c| mem.first_seen[&c.hash].0).min().unwrap();
            let there = listed.iter().map(|c| mem.first_seen[&c.hash].1).min().unwrap();
            if now.saturating_sub(there) > REVEAL_CUTOFF_MS {
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
            // 🔒 (No commitment for a round that is not its own: the game has changed hands at this one.)
            let next = (!friendly && !self.stepping_down && mine(r + 1)).then(|| self.commit(ctx, r + 1));
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
            // 🔒 (When its reveal decided the close, for the trim's HOUSE_TRIM_AFTER_MS.)
            if fo {
                self.rooms.get_mut(room).unwrap().tables.get_mut(&key).unwrap().decided_at.insert(best.hash.clone(), now);
            }
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
            // (🔒 At a game, from past its base, whose rounds a checkpoint may run far ahead of this house's.)
            let from = if fo { (done + 1).max(read.base_u + 1) } else { done + 1 };
            let Some(r) = (from..=read.next_round().max(from)).find(|r| carried(*r, self) || joined(*r, self)) else { return };
            if !mine(r) {
                return;
            }
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
        if settling || r <= done || revealed_now.is_some() || carried(r, self) || joined(r, self) || !mine(r) || game.is_some_and(|g| !g.joins) {
            return;
        }
        // Nor when another of the owner's houses has: it joined the round,
        // or its reveal of the round before carried a commitment no
        // step-down has lifted (one house to a round: two would let a bettor
        // see both outcomes). Past a checkpoint, that is the checkpoint's
        // say ([`TableRead::outstanding`]). (Its own commitment, though, is
        // `carried` whatever the checkpoint says: a step-down a trim dropped
        // still opened the seed, and a house with no memory of it must not
        // join that round on the commitment again.)
        if !read.joins_at(r).is_empty() || read.outstanding(r) {
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
        // 🔒 Nor, at a FAIR ONLY game, while the round before waits on another house: a close of it names the
        // commitment of another house of that round, nobody abandoned a close of it, and no reveal of a close of it is
        // in. That house's reveal will carry its commitment for this round (and then this join would count for
        // nothing: a record a round, an unopened seed each); if it carries none, or the bettors void the close, the
        // join is the next tick's. (Not a commitment of no house of that round, a seller's house's left over at a
        // hand-over: nobody reveals that close, and the round after it wants a join now. Nor one whose house the
        // session does not tell: past a checkpoint, the reveal that carried it is the copy a trim keeps.)
        if let Some(g) = game {
            let whose = |h: &str| {
                read.joins.iter().find(|o| o.r == r - 1 && o.c == h).map(|o| o.k.as_str()).or_else(|| {
                    read.reveals.iter().find(|v| v.r == r - 2 && v.c.as_deref() == Some(h)).map(|v| v.k.as_str())
                })
            };
            let theirs = r - 1 > read.base_u
                && !read.closes_at(r - 1).any(|c| read.abandoned.contains(&c.hash))
                && !read.reveals.iter().any(|v| v.r == r - 1 && !v.x.is_empty())
                && read.closes_at(r - 1).any(|c| c.h.as_deref().and_then(whose).is_some_and(|k| k != read.me && g.houses_before.contains(k)));
            if theirs {
                return;
            }
        }
        // 🔒 At a FAIR ONLY game, its first join there goes into its state, on disk first, as a game it acts at (an
        // entry with no round decided yet): after a start the room's beat waits on the game until a pass reads it, as
        // where it revealed before ([`House::remembered`]), for a page may close on the commitment it joined with.
        if fo && self.last_of(ctx).is_none() && !self.mark_done(ctx, Done::default()) {
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

    /// 🔒 Read the fold's answers for the FAIR ONLY games from `from`, where the fold in shadow puts them
    /// (fold_shadow.rs `share_answers`): what the trims go by.
    pub fn read_answers_from(&mut self, from: GameAnswers) {
        self.answers = Some(from);
    }

    /// 🔒 A row a checkpoint above it stands over: no longer one to put back.
    fn drop_row(&mut self, room: &str, t: &str, inc: &str) {
        if self.rows.remove(&(room.to_string(), t.to_string(), inc.to_string())).is_none() {
            return;
        }
        if let Some(path) = &self.rows_path {
            if let Err(e) = write_rows(path, &self.rows) {
                eprintln!("🏠 house: cannot write {}: {e}", path.display());
            }
        }
    }

    /// 🔒 What it did at FAIR ONLY games ([`GameCounts`]).
    pub fn game_counts(&self) -> GameCounts {
        self.counts
    }

    /// 🔒 The fold's latest answer for game `(t, inc)` of `room`, if it is of the game as the house reads it now: on the
    /// base the walk chose, of the session that follows it, under the houses by round of this pass's plan, with the
    /// players' keys the room holds now (the watch of them stands where it stood when the fold was given them), and folded
    /// from the records the session holds now (the digest of their keys, [`own_record`]: the answer can be of a moment
    /// before the house's read, the fold running beside the tick). Not of a session past [`MAX_SESSION_KEYS`]: the read
    /// stops there, and a record past it is in neither the house's digest nor its sight (the fold's mirror holds such a
    /// session: no honest one is). (The digest is worked out only for an answer that is the rest of that.)
    fn answer_for(&self, room: &str, read: &TableRead, g: &TrimOf) -> Option<GameAnswer> {
        if read.keys > MAX_SESSION_KEYS {
            return None;
        }
        let answers = self.answers.as_ref()?.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let a = answers.get(&(room.to_string(), read.ctx.t.clone(), read.ctx.inc.clone()))?;
        let sid = read.ses_key.rsplit(':').next().unwrap_or("");
        if a.base_key != g.base.key || a.sid != sid || a.spans != g.spans || a.summary.pending {
            return None;
        }
        #[cfg(feature = "house-fold")]
        if !a.pins.as_ref().is_some_and(|(watch, at)| watch.epoch() == *at) {
            return None;
        }
        let mut keys: Vec<&str> = read.records.iter().map(String::as_str).collect();
        keys.sort_unstable();
        (a.digest == crate::fold_summary::records_digest(keys)).then(|| a.clone())
    }

    /// 🔒 The trim of FAIR ONLY game `read` (design-final section 8.5 N3, N4; computedSimHouse.ts `trimDuty`): with no
    /// close past the last decided round D, D past the base and at or after the round its holder holds the game from, and
    /// decided by this house's own reveal (as its state file has it) or by a bettor's abandon; every decided round's frozen
    /// slips in (or missing for [`MISSING_WAIT_MS`]); and [`HOUSE_TRIM_AFTER_MS`] since D was decided; under pressure: the
    /// session long, heavy, at craps a seven-out with the hand run long, the room's games heavy together, junk piled up, or
    /// idle. The checkpoint's content is the fold's ([`House::answer_for`]); what this house knows of round D without it
    /// (the session, the round, the close its reveal listed, that reveal and the commitment it carried) must agree, and
    /// the record must read as a page reads one, or it signs nothing (the cross-check). On disk first ([`ROWS_FILE`]),
    /// then [`Write::Trim`].
    #[allow(clippy::too_many_arguments)]
    fn trim_duty<T: ReadTxn>(&mut self, room: &str, txn: &T, comp: &MapRef, read: &TableRead, g: &TrimOf, now: u64, writes: &mut Vec<Write>) -> Trimmed {
        let ctx = &read.ctx;
        let key = (ctx.t.clone(), ctx.inc.clone());
        let base_u = read.base_u;
        {
            let Some(mem) = self.rooms.get_mut(room).and_then(|m| m.tables.get_mut(&key)) else { return Trimmed::Done };
            if mem.last_new_key.is_none() || read.keys != mem.keys {
                mem.keys = read.keys;
                mem.last_new_key = Some(now);
            }
        }
        // (Nothing of its own into the session it would close, this pass: the doc does not hold it yet.)
        if writes.iter().any(|w| matches!(w, Write::Session { ses, .. } if *ses == read.ses_key)) {
            return Trimmed::Done;
        }
        // (Nothing in the session: nothing to trim to.)
        if read.closes.is_empty() && read.keys == 0 {
            return Trimmed::Done;
        }
        // A tick that has no answer of the session as it reads it forgets what it waited for: it could not see it come
        // back and go again.
        let Some(answer) = self.answer_for(room, read, g) else {
            if let Some(mem) = self.rooms.get_mut(room).and_then(|m| m.tables.get_mut(&key)) {
                mem.waits.clear();
            }
            return Trimmed::Done;
        };
        let f = &answer.summary;
        let done = self.last_of(ctx).cloned();
        let room_mem = self.rooms.get_mut(room).unwrap();
        let mem = room_mem.tables.get_mut(&key).unwrap();
        mem.kept = f.kept.unwrap_or(0);
        // (Noted at every answer checked, a close of the open round in or not: a wait that began for one loss must not
        // stand in for the next.)
        let waits = waits_on(mem, done.as_ref(), base_u, &read.ses_key, &f.rounds, now);
        self.waits_noted.insert(key.clone());
        if f.tip.is_some() {
            return Trimmed::Done;
        }
        let Some(d) = f.rounds.iter().rev().find(|v| v.decided.is_some()) else { return Trimmed::Done };
        if waits || d.r <= base_u || d.r < g.from {
            return Trimmed::Done;
        }
        let mut own: Option<Kept> = None;
        if let Some(hash) = &d.house {
            let Some(done) = done.as_ref().filter(|done| done.d.as_ref() == Some(&(d.r, d.close.clone()))) else { return Trimmed::Done };
            let key = format!("h:{}:{hash}", d.r);
            own = done.kept.iter().find(|k| k.ses == read.ses_key && k.key == key).cloned();
            if own.is_none() {
                return Trimmed::Done;
            }
        } else if d.abandon.is_none() {
            return Trimmed::Done;
        }
        let at = *mem.decided_at.entry(d.close.clone()).or_insert(now);
        if now.saturating_sub(at) < HOUSE_TRIM_AFTER_MS {
            return Trimmed::Done;
        }
        let Some(kept) = f.kept else { return Trimmed::Done };
        let room_kept: i64 = room_mem.tables.iter().filter(|(k, _)| ha::is_fair_only_inc(&k.1)).map(|(_, m)| m.kept).sum();
        let idle = room_mem.tables[&key].last_new_key.is_some_and(|at| now.saturating_sub(at) >= HOUSE_IDLE_MS);
        let craps = craps_inc(&ctx.inc);
        let pressed = d.r - base_u >= HOUSE_TRIM_ROUNDS
            || kept >= HOUSE_TRIM_BYTES
            || (d.seven_out == Some(true) && d.r - base_u >= HOUSE_SEVEN_OUT_MIN)
            || (room_kept >= HOUSE_ROOM_BYTES && kept >= HOUSE_ROOM_MIN_BYTES)
            || f.raw_bytes - kept >= HOUSE_SWEEP_BYTES
            || idle;
        if !pressed {
            return Trimmed::Done;
        }
        #[cfg_attr(not(test), allow(unused_mut))]
        let mut body = trim_body(&g.base.ck, f, d, craps, g, &self.key.public);
        #[cfg(test)]
        if let Some(fault) = self.fault_trim.as_mut() {
            fault(&mut body);
        }
        // The cross-check, before it signs.
        let field = |k: &str| body.iter().find(|(f, _)| f == k).map(|(_, v)| v);
        let sid = read.ses_key.rsplit(':').next().unwrap_or("");
        let nets = match field("n") {
            Some(CVal::Obj(n)) => n.len(),
            _ => usize::MAX,
        };
        let mut agrees = field("b").and_then(CVal::as_str) == Some(sid) && field("u").and_then(CVal::as_int) == Some(d.r) && nets <= ha::MAX_TABLE_PIDS;
        if let (Some(own), Some(done)) = (&own, &done) {
            // (The commitment its reveal carried, unless it has stepped down since.)
            let carried = if done.r == d.r { str_of(&own.rec, "c") } else { None };
            let own_hash = hb::rec_hash(&own.rec).map(|h| format!("h:{h}"));
            agrees &= field("l").and_then(CVal::as_str) == done.d.as_ref().map(|(_, x)| x.as_str())
                && field("d").and_then(CVal::as_str) == own_hash.as_deref()
                && field("h").and_then(CVal::as_str) == carried;
        }
        let sealed = if agrees {
            match self.seal_as_base(room, ctx, g, body) {
                None => return Trimmed::Wait,
                Some(sealed) => sealed,
            }
        } else {
            None
        };
        let Some((ck_key, value)) = sealed else {
            self.counts.cross_check_mismatches += 1;
            return Trimmed::Done;
        };
        // What it carries into the session it opens (the L7 copies): the open round's felts whose seed is not out, the
        // houses' joins of it, and round D's decider with the reveals it counted.
        let Some(Out::YMap(ses)) = comp.get(txn, &read.ses_key) else { return Trimmed::Done };
        let wanted = f.carry_felts.iter().flatten().cloned().chain(f.joins.iter().map(|j| format!("o:{}:{j}", f.open))).chain(d.copies.iter().flatten().cloned());
        let mut copies: Vec<(String, CVal)> = Vec::new();
        for k in wanted {
            if copies.iter().any(|(c, _)| *c == k) {
                continue;
            }
            match self.read_charged(k.len(), ses.get(txn, &k), MAX_RECORD_BYTES) {
                Read::Val(v) => copies.push((k, v)),
                // (The tick's reads spent: the next pass.)
                Read::Spent => return Trimmed::Wait,
                _ => {}
            }
        }
        let Some(next) = hb::next_sid3(ctx, &value) else { return Trimmed::Done };
        // On disk first: a checkpoint it signed and lost is one it cannot put back.
        let row = (room.to_string(), ctx.t.clone(), ctx.inc.clone());
        let was = self.rows.insert(row.clone(), Row { key: ck_key.clone(), value: value.clone(), copies: copies.clone() });
        if let Some(path) = &self.rows_path {
            if let Err(e) = write_rows(path, &self.rows) {
                eprintln!("🏠 house: cannot write {}: {e} — not trimming {}", path.display(), ctx.t);
                match was {
                    Some(w) => self.rows.insert(row, w),
                    None => self.rows.remove(&row),
                };
                return Trimmed::Done;
            }
        }
        self.counts.trims += 1;
        if let Some(mem) = self.rooms.get_mut(room).and_then(|m| m.tables.get_mut(&key)) {
            mem.decided_at.clear();
            mem.waits.clear();
        }
        writes.push(Write::Trim { key: ck_key, value, gone: g.gone.clone(), ses: format!("ses:{}:{}:{next}", ctx.t, ctx.inc), copies });
        Trimmed::Done
    }

    /// 🔒 A checkpoint body signed, if it reads as a page reads one and is the best of the game with it in (else no page
    /// would count from it): its key and value. Some(None): refused. None: a check of it was put off.
    fn seal_as_base(&mut self, room: &str, ctx: &Ctx, g: &TrimOf, mut body: Vec<(String, CVal)>) -> Option<Option<(String, CVal)>> {
        body.retain(|(_, v)| *v != CVal::Undef);
        let Some(bytes) = hb::sign_bytes("ck", ctx, &CVal::Obj(body.clone())) else { return Some(None) };
        body.push(("g".to_string(), CVal::Str(self.key.sign(&bytes))));
        let value = CVal::Obj(body);
        let Some(id) = hb::ck_id(&value) else { return Some(None) };
        let key = format!("ck:{}:{}:{id}", ctx.t, ctx.inc);
        let rec = ha::AuthRecords { cks: vec![(g.base.key.as_str(), &g.base.ck), (key.as_str(), &value)], xfs: vec![], fins: vec![], delegations: vec![g.dl] };
        let res = ha::resolve_game(room, &ctx.t, &ctx.inc, None, &rec, &mut |id, k, bytes, sig| self.verified_auth(room, id, k, bytes, sig));
        if res.pending {
            return None;
        }
        Some(res.base.is_some_and(|b| b.key == key).then_some((key, value)))
    }
}

/// 🔒 The body of a FAIR ONLY game's trim to round `d`, from its base `b` and the fold's answer `f` (computedSimHouse.ts
/// `trimDuty`): the name's inputs from the base; the session it closes, the round, its close and how it was decided, its
/// outcome where a house reveal decided it, the nets, at craps the carry, the commitment the next round must name, the
/// delegation this house serves the game by, the chain's transfers, and this house's key. Unsigned.
fn trim_body(b: &CVal, f: &crate::fold_summary::FoldSummary, d: &RoundSummary, craps: bool, g: &TrimOf, me: &str) -> Vec<(String, CVal)> {
    let from_base = |k: &str| (k.to_string(), b.get(k).cloned().unwrap_or(CVal::Undef));
    let mut body = vec![("v".to_string(), CVal::Int(1)), from_base("ok"), from_base("j"), from_base("rv"), from_base("ts")];
    body.push(("b".to_string(), CVal::Str(f.base.sid.clone())));
    body.push(("u".to_string(), CVal::Int(d.r)));
    body.push(("l".to_string(), CVal::Str(d.close.clone())));
    let how = match (&d.house, &d.abandon) {
        (Some(h), _) => CVal::Str(format!("h:{h}")),
        (None, Some(z)) => CVal::Str(format!("z:{z}")),
        (None, None) => CVal::Undef,
    };
    body.push(("d".to_string(), how));
    // (A round a house reveal voided, counting nobody, has no outcome.)
    if d.decided.as_deref() == Some("house") {
        let o = if craps { d.dice.map(|[a, b]| CVal::Arr(vec![CVal::Int(a), CVal::Int(b)])) } else { d.pocket.map(CVal::Int) };
        body.push(("o".to_string(), o.unwrap_or(CVal::Undef)));
    }
    body.push(("n".to_string(), CVal::Obj(f.nets.iter().map(|(pid, net)| (pid.clone(), CVal::Str(net.clone()))).collect())));
    if craps {
        body.push(("s".to_string(), CVal::from_json(&f.carry)));
    }
    if let Some(h) = &f.required {
        body.push(("h".to_string(), CVal::Str(h.clone())));
    }
    body.push(("dl".to_string(), g.dl.clone()));
    if !g.x.is_empty() {
        body.push(("x".to_string(), CVal::Arr(g.x.clone())));
    }
    body.push(("k".to_string(), CVal::Str(me.to_string())));
    body
}

/// 🔒 Whether a checkpoint of a FAIR ONLY game's session, folded as `rounds`, must wait for a record that is gone
/// (computedSimHouse.ts `waitsOn`): for [`MISSING_WAIT_MS`] from when this house first read each thing so, one wait for
/// each, all kept in one place (`mem.waits`) and noted at every answer checked, a close of the open round in or not.
/// What it waits for:
/// - **its own round.** The round this house itself revealed in this session (its state file's last decided round, past
///   the base) does not read decided under the close its reveal listed. Records only come, so the round has lost a
///   record it rests on: a frozen slip its reveal counted, deleted by the bettor who lost the round. One wait for each
///   such reading: a new reading is a new loss.
/// - **a frozen slip missing** from a decided round: one wait for each slip, by its close and its bettor.
///
/// A thing no longer so is forgotten, so the same loss again waits afresh; and a tick that checked no answer of the game
/// forgets them all, whatever kept it from one ([`House::tick`]: a record could have come back and gone again unseen). The pages that showed the round put the record back in their turns (their witness
/// copies), within seconds; if nobody has by then, nobody is left who can, and the round is as the fold reads it.
fn waits_on(mem: &mut TableMem, done: Option<&Done>, base_u: i64, ses_key: &str, rounds: &[RoundSummary], now: u64) -> bool {
    let mut gone: BTreeSet<String> = BTreeSet::new();
    if let Some((r, close)) = done.and_then(|d| d.d.as_ref()) {
        let r = *r;
        if r > base_u && done.is_some_and(|d| d.kept.iter().any(|k| k.ses == ses_key && k.key.starts_with(&format!("h:{r}:")))) {
            let at = rounds.iter().find(|v| v.r == r);
            let decided = at.and_then(|v| v.decided.as_deref().map(|how| (how, v.close.as_str())));
            if decided.is_none_or(|(_, c)| c != close) {
                let reads = decided.map_or(String::new(), |(how, c)| format!("{how}:{c}"));
                gone.insert(format!("round:{r}:{reads}"));
            }
        }
    }
    for v in rounds.iter().filter(|v| v.decided.is_some()) {
        for pid in v.missing.iter().flatten() {
            gone.insert(format!("slip:{}:{pid}", v.close));
        }
    }
    mem.waits.retain(|id, _| gone.contains(id));
    let mut waits = false;
    for id in gone {
        let since = mem.waits.entry(id).or_insert(now);
        if *since > now {
            *since = now;
        }
        if now - *since < MISSING_WAIT_MS {
            waits = true;
        }
    }
    waits
}

/// The house, a tick that panicked while holding it notwithstanding: its
/// memory is at worst a round ahead of the doc (a reveal noted and never
/// written voids that round, as a crash there would), and a house that
/// stopped at one room's panic would leave every room's tables to void, its
/// step-down undone.
pub fn lock(house: &Mutex<House>) -> MutexGuard<'_, House> {
    house.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One tick of the house in one room (`unbounded`: the step-down's last
/// word, [`House::tick_unbounded`]), a panic in it that room's alone: logged,
/// nothing sent, and the other rooms ticked as ever.
pub fn tick_room(house: &Mutex<House>, room: &str, doc: &Doc, now: u64, wall: u64, unbounded: bool) -> TickOut {
    let ticked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut house = lock(house);
        if unbounded {
            house.tick_unbounded(room, doc, now, wall)
        } else {
            house.tick(room, doc, now, wall)
        }
    }));
    ticked.unwrap_or_else(|e| {
        let why = e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default();
        eprintln!("🏠 house: its tick in room {room} failed ({why}); the other rooms go on");
        TickOut::default()
    })
}

/// Step the house down in every room of `docs` (main.rs house_step_down),
/// handing each room's update to `sent` (room, update, records) as soon as
/// it is written: first every room within a tick's budget (the loop has
/// made most of the checks), then each room that was short of it with every
/// check it needs: a flood in one room holds back no other's step-down.
pub fn step_down(house: &Mutex<House>, docs: Vec<(String, Doc)>, now: u64, mut sent: impl FnMut(String, Vec<u8>, usize)) {
    lock(house).begin_step_down();
    let mut short = Vec::new();
    for (room, doc) in docs {
        let out = tick_room(house, &room, &doc, now, 0, false);
        if let Some(update) = out.update {
            sent(room.clone(), update, out.wrote);
        }
        if out.short {
            short.push((room, doc));
        }
    }
    for (room, doc) in short {
        let out = tick_room(house, &room, &doc, now, 0, true);
        if let Some(update) = out.update {
            sent(room, update, out.wrote);
        }
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

/// The deed holder a room's `roomInfo` map names under `owner`: a non-empty string that is not the placeholder of a
/// clone made on the spot (a room with no deed holder has no house).
pub(crate) fn deed_of(out: Option<Out>) -> Option<String> {
    match out {
        Some(Out::Any(Any::String(s))) if !s.is_empty() && &*s != "Local-Clone" => Some(s.to_string()),
        _ => None,
    }
}

/// Top-level record `key` (a delegation, a setting, a heartbeat): None as
/// well when it weighs more than [`MAX_TOP_BYTES`], which none of them does.
fn top_value<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<CVal> {
    top_value_within(map, txn, key, MAX_TOP_BYTES)
}

/// Top-level record `key` as [`top_value`] reads it, and how sure a page's
/// reading of it is to be that ([`hb::clarity`]).
fn top_read<T: ReadTxn>(map: &MapRef, txn: &T, key: &str) -> Option<(CVal, hb::Clarity)> {
    match map.get(txn, key) {
        Some(Out::Any(any)) => match hb::weigh(&any, MAX_TOP_BYTES) {
            hb::Weighed::Light { scan, .. } => match hb::clarity_within(&any, scan, MAX_TOP_BYTES) {
                hb::Clarity::Unknown => Some((CVal::Junk, hb::Clarity::Unknown)),
                c => Some((CVal::from_any(&any), c)),
            },
            // (A page may read it light.)
            hb::Weighed::Unsure => Some((CVal::Junk, hb::Clarity::Unknown)),
            hb::Weighed::Heavy => None,
        },
        _ => None,
    }
}

/// Top-level record `key`, when it weighs at most `cap` ([`hb::weight`]).
fn top_value_within<T: ReadTxn>(map: &MapRef, txn: &T, key: &str, cap: usize) -> Option<CVal> {
    match map.get(txn, key) {
        Some(Out::Any(any)) => CVal::from_any_within(&any, cap),
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
/// 🔒 The transfers of game `t`/`inc`'s chain that its resolution found only inside a checkpoint (`x`), into `reput`
/// under their keys for the put-back's turn (design-final section 8.5 N5), as the pages put back the ones they hold.
/// 🔒 What a game's memory keeps of this house's delegations: the one it serves the game by now (`now`), and the
/// one it went by before among the earlier ones ([`TableMem::earlier`]); of those, the ones whose signers are
/// holders of the game (`chain`), but for the signer of `now`. (So one each: none of the signer it goes by now, and
/// the one it went by before is of another, or goes.)
fn keep_earlier(table: &mut TableMem, now: CVal, chain: &[ha::Holder]) {
    let signer = |d: &CVal| str_of(d, "k").map(str::to_string);
    if let Some(was) = table.deleg.replace(now) {
        table.earlier.push(was);
    }
    let current = table.deleg.as_ref().and_then(signer);
    table.earlier.retain(|d| signer(d) != current && chain.iter().any(|h| signer(d).as_deref() == Some(h.k.as_str())));
}

fn chain_put_backs(t: &str, inc: &str, res: &ha::Resolution, reput: &mut Vec<Write>) {
    for holder in res.chain.iter().skip(1) {
        if let Some(step) = holder.step.as_ref().filter(|s| s.key.is_none()) {
            reput.push(Write::Top { key: format!("xf:{t}:{inc}:{}", step.id), value: step.xf.clone() });
        }
    }
}

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
            Write::NewSession { ses } => {
                if !matches!(comp.get(txn, ses), Some(Out::YMap(_))) {
                    comp.insert(txn, ses.as_str(), yrs::MapPrelim::default());
                }
            }
            Write::Delete { key } => {
                comp.remove(txn, key);
            }
            Write::Trim { key, value, gone, ses, copies } => {
                if comp.get(txn, key).is_none() {
                    comp.insert(txn, key.as_str(), to_any(value));
                }
                for k in gone.iter().filter(|k| *k != key) {
                    comp.remove(txn, k);
                }
                let next = comp.insert(txn, ses.as_str(), yrs::MapPrelim::default());
                for (k, v) in copies {
                    next.insert(txn, k.as_str(), to_any(v));
                }
            }
            Write::Restore { key, value, ck, ses } => {
                if *ck {
                    comp.insert(txn, key.as_str(), to_any(value));
                }
                if let Some((next, closed, copies)) = ses {
                    if !matches!(comp.get(txn, next), Some(Out::YMap(_))) {
                        let held: Vec<&(String, CVal)> = match comp.get(txn, closed) {
                            Some(Out::YMap(m)) => copies.iter().filter(|(k, _)| m.contains_key(txn, k)).collect(),
                            _ => vec![],
                        };
                        let made = comp.insert(txn, next.as_str(), yrs::MapPrelim::default());
                        for (k, v) in held {
                            made.insert(txn, k.as_str(), to_any(v));
                        }
                    }
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
/// carry on (v 1, `[room, t, inc, r]`), neither keeping a reveal. 🔒 A row of round 0 at a FAIR ONLY game is one it
/// joined and has decided nothing at yet.
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
    put_in_place(&tmp, path)
}

/// Put the file `tmp` (written and synced) in place of `path`, lastingly: the rename is a change of the directory, which
/// is synced too, or a crash after it could lose it and the house come back without what it said it had written. On
/// Unix the directory is opened and synced (`.` for a path with no directory part); a file system that cannot sync one
/// says so (`InvalidInput`, `Unsupported`), and the rename is as lasting as it makes it. Elsewhere the rename is all
/// there is (Windows opens no directory as a file).
fn put_in_place(tmp: &std::path::Path, path: &std::path::Path) -> std::io::Result<()> {
    std::fs::rename(tmp, path)?;
    #[cfg(unix)]
    {
        let dir = dir_of(path);
        if let Err(e) = std::fs::File::open(dir).and_then(|d| d.sync_all()) {
            if !matches!(e.kind(), std::io::ErrorKind::InvalidInput | std::io::ErrorKind::Unsupported) {
                return Err(e);
            }
        }
    }
    Ok(())
}

/// The directory a file `path` is in: `.` for a path with no directory part.
#[cfg_attr(not(unix), allow(dead_code))]
fn dir_of(path: &std::path::Path) -> &std::path::Path {
    match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => std::path::Path::new("."),
    }
}

/// 🔒 The write that puts `row` back ([`Write::Restore`]): its checkpoint (with `ck`), and the session it opens with what
/// its trim carried.
fn restore_of(ctx: &Ctx, row: &Row, ck: bool) -> Write {
    let ses = hb::next_sid3(ctx, &row.value).zip(str_of(&row.value, "b"));
    let ses = ses.map(|(next, closed)| (format!("ses:{}:{}:{next}", ctx.t, ctx.inc), format!("ses:{}:{}:{closed}", ctx.t, ctx.inc), row.copies.clone()));
    Write::Restore { key: row.key.clone(), value: row.value.clone(), ck, ses }
}

/// 🔒 The rows file ([`ROWS_FILE`]): `{"v": 2, "rows": [[room, t, inc, key, canon, [[k, canon], …]], …]}`, the last
/// checkpoint the house signed for each FAIR ONLY game, its doc key and its canonical bytes, and each record its trim
/// carried, its key and canonical bytes. A row of v 1 (`[room, t, inc, key, canon]`) carried nothing. A row whose key is
/// not its checkpoint's is none.
fn parse_rows(bytes: &[u8]) -> Option<BTreeMap<(String, String, String), Row>> {
    let v: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let version = v.get("v")?.as_u64()?;
    if !(1..=2).contains(&version) {
        return None;
    }
    let record = |c: &serde_json::Value| Some(CVal::from_json(&serde_json::from_str(c.as_str()?).ok()?));
    let mut out = BTreeMap::new();
    for row in v.get("rows")?.as_array()? {
        let row = row.as_array().filter(|r| r.len() == if version == 1 { 5 } else { 6 })?;
        let (room, t, inc, key) = (row[0].as_str()?, row[1].as_str()?, row[2].as_str()?, row[3].as_str()?);
        let value = record(&row[4])?;
        let copies = match row.get(5) {
            None => vec![],
            Some(copies) => copies.as_array()?.iter().map(|c| Some((c.get(0)?.as_str()?.to_string(), record(c.get(1)?)?))).collect::<Option<Vec<_>>>()?,
        };
        if hb::ck_id(&value).is_some_and(|id| key == format!("ck:{t}:{inc}:{id}")) {
            out.insert((room.to_string(), t.to_string(), inc.to_string()), Row { key: key.to_string(), value, copies });
        }
    }
    Some(out)
}

/// 🔒 Write the rows file whole, synced, then put in place (as [`write_state`], [`put_in_place`]).
fn write_rows(path: &std::path::Path, rows: &BTreeMap<(String, String, String), Row>) -> std::io::Result<()> {
    let rows: Vec<_> = rows
        .iter()
        .map(|((room, t, inc), row)| {
            let copies: Vec<_> = row.copies.iter().filter_map(|(k, v)| Some(serde_json::json!([k, hb::canon(v)?]))).collect();
            serde_json::json!([room, t, inc, row.key, hb::canon(&row.value), copies])
        })
        .collect();
    let body = serde_json::to_vec(&serde_json::json!({ "v": 2, "rows": rows }))?;
    let tmp = path.with_extension("json.tmp");
    {
        use std::io::Write as _;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&body)?;
        f.sync_all()?;
    }
    put_in_place(&tmp, path)
}

#[cfg(test)]
pub(crate) mod tests;

#[cfg(test)]
mod game_tests;
