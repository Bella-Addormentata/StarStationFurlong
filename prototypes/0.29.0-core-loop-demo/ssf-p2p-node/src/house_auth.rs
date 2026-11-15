//! 🔒 FAIR ONLY tables: who holds a game, and which checkpoint it stands at
//! (the node's half of PR 6c of "Computed casino tables"; design-final.md
//! section 8.3 S0 to S5, S7 and S9).
//!
//! The twin of the pages' `src/computedFairOnly.ts` readers (`readCk`,
//! `asFin`, `asXf`, `asDeedOffer`, `weightOf`, `parseFairOnlyKey`) and of
//! `src/computedFairOnlyAuth.ts` (`resolveGame`, `tableGame`). A page and the
//! owner's node read the records of one game (`ck:`, `fin:`, `xf:`) and must
//! name the same holder, the same base and the same end order from them, or
//! the house would sign over a base no page counts from. Checked against
//! `test-vectors/computed-authority-v1.json`, which the TypeScript side
//! writes (src/computedFairOnlyAuthVectors.test.ts) and checks too.
//!
//! PURE, like the pages' resolver: no doc, no clock, no state. Signatures
//! come in through one check the caller gives ([`SigCheck`]): it owns the
//! cache and the budget, and answers `None` for one it has not checked yet.
//! Such an answer never decides anything: the pass is `pending` and the caller
//! asks again. The check must be the strict one ([`hb::verify`]).
//!
//! Nothing calls this yet: the house's walk at `p`/`q` (the next slice of the
//! node's half) does.
#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::house::{has_fields, hex_of, is_carry, is_pid, is_pub, is_sig};
use crate::house_bytes::{self as hb, CVal, Ctx};

// ── Constants (computedFairOnly.ts, computedFold.ts, computedFairOnlyAuth.ts) ─

/// The rules version this build plays (`FAIR_ONLY_RV`), and the only one it knows.
pub const FAIR_ONLY_RV: &str = "f1";
/// The heaviest checkpoint a reader takes ([`weight_of`]).
pub const MAX_CHECKPOINT_BYTES: usize = 1_572_864;
/// Transfers of authority one game may have.
pub const MAX_TRANSFERS: usize = 8;
/// How long before its game opened a deed offer may have been made.
pub const OFFER_SKEW_MS: i64 = 600_000;
/// UTF-16 units a deed offer's names may have.
pub const MAX_OFFER_TEXT: usize = 256;
/// The heaviest end order, transfer, deed offer or delegation a reader takes.
pub const MAX_SMALL_RECORD_BYTES: usize = 8 * 1024;
/// `l` of a checkpoint before any round.
pub const NO_CLOSE: &str = "00000000000000000000000000000000";
/// Players one game's checkpoint may name.
pub const MAX_TABLE_PIDS: usize = 4_000;
/// The highest round a record may name (2^48).
pub const U_MAX: i64 = 1 << 48;
/// Checkpoints looked at, by their signatures, in one pass.
pub const MAX_CK_CANDIDATES: usize = 8;
/// Forged transfers one resolution walks past.
pub const MAX_FORGED_XFS: usize = 64;
/// Nesting a record may have and still be weighed.
pub const MAX_WEIGHT_DEPTH: usize = 16;

fn is_known_rv(rv: &str) -> bool {
    rv == FAIR_ONLY_RV
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/// A top-level `casinoComputed` key's FAIR ONLY parts.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FairOnlyKey<'a> {
    Ck { t: &'a str, inc: &'a str, id: &'a str },
    Xf { t: &'a str, inc: &'a str, id: &'a str },
    Fin { t: &'a str, inc: &'a str },
    Do { nonce: &'a str },
}

/// `[pq]` and 24 hex: a FAIR ONLY incarnation's spelling.
pub fn is_fair_only_inc(inc: &str) -> bool {
    inc.len() == 25 && (inc.starts_with('p') || inc.starts_with('q')) && hex_of(&inc[1..], 24)
}

/// The last `n` bytes of `s` and what is before them, when `s` has more than
/// that and the cut is between characters.
fn cut_tail(s: &str, n: usize) -> Option<(&str, &str)> {
    (s.len() > n && s.is_char_boundary(s.len() - n)).then(|| s.split_at(s.len() - n))
}

/// The table id and the incarnation of `<t>:<inc>`: the table id may hold
/// `:`, so it parses from the right, where the incarnation has a fixed spelling.
fn t_inc(rest: &str) -> Option<(&str, &str)> {
    let (head, inc) = cut_tail(rest, 25)?;
    let t = head.strip_suffix(':')?;
    (!t.is_empty() && is_fair_only_inc(inc)).then_some((t, inc))
}

/// computedFairOnly parseFairOnlyKey: None for any other key.
pub fn parse_fair_only_key(key: &str) -> Option<FairOnlyKey<'_>> {
    for (prefix, ck) in [("ck:", true), ("xf:", false)] {
        if let Some(rest) = key.strip_prefix(prefix) {
            let (head, id) = cut_tail(rest, 32)?;
            let (t, inc) = t_inc(head.strip_suffix(':')?)?;
            if !hex_of(id, 32) {
                return None;
            }
            return Some(if ck { FairOnlyKey::Ck { t, inc, id } } else { FairOnlyKey::Xf { t, inc, id } });
        }
    }
    if let Some(rest) = key.strip_prefix("fin:") {
        return t_inc(rest).map(|(t, inc)| FairOnlyKey::Fin { t, inc });
    }
    let nonce = key.strip_prefix("do:")?;
    hex_of(nonce, 24).then_some(FairOnlyKey::Do { nonce })
}

// ── Weight ───────────────────────────────────────────────────────────────────

/// computedFairOnly weightOf, of a value as a page holds it: a string its
/// UTF-8 bytes and two quotes, anything that is no string, array or object 8,
/// an array two brackets and a comma for each member, an object two braces
/// and for each field its key's bytes and 4. An undefined field is charged 8
/// where it stands and takes no depth; an undefined member of an array is a
/// member like any. None past `cap` or [`MAX_WEIGHT_DEPTH`].
///
/// [`hb::weight`] weighs the Yjs value before it is read at all (and counts a
/// buffer by its length); this weighs what was read, and the parts of it a
/// reader weighs again (an end order, a transfer, a delegation inside a
/// checkpoint).
pub fn weight_of(v: &CVal, cap: usize) -> Option<usize> {
    fn walk(v: &CVal, depth: usize, cap: usize, total: &mut usize) -> bool {
        if depth > MAX_WEIGHT_DEPTH {
            return false;
        }
        match v {
            CVal::Str(s) => *total += s.len() + 2,
            CVal::Arr(a) => {
                *total += a.len() + 2;
                if *total > cap {
                    return false;
                }
                for x in a {
                    if !walk(x, depth + 1, cap, total) {
                        return false;
                    }
                }
            }
            CVal::Obj(fields) => {
                *total += 2;
                for (k, x) in fields {
                    *total += k.len() + 4;
                    if *x == CVal::Undef {
                        *total += 8;
                    }
                    if *total > cap {
                        return false;
                    }
                    if *x != CVal::Undef && !walk(x, depth + 1, cap, total) {
                        return false;
                    }
                }
            }
            CVal::Int(_) | CVal::Undef | CVal::Junk => *total += 8,
        }
        *total <= cap
    }
    let mut total = 0;
    walk(v, 0, cap, &mut total).then_some(total)
}

// ── Readers ──────────────────────────────────────────────────────────────────

fn str_of<'a>(v: &'a CVal, k: &str) -> Option<&'a str> {
    v.get(k).and_then(CVal::as_str)
}

fn int_of(v: &CVal, k: &str) -> Option<i64> {
    v.get(k).and_then(CVal::as_int)
}

fn is_obj(v: &CVal) -> bool {
    matches!(v, CVal::Obj(_))
}

/// A count: a safe integer of 0 or more.
fn count_of(v: &CVal, k: &str) -> Option<i64> {
    int_of(v, k).filter(|n| *n >= 0)
}

/// A round a record names: 0 to [`U_MAX`].
fn round_of(v: &CVal, k: &str) -> Option<i64> {
    int_of(v, k).filter(|u| (0..=U_MAX).contains(u))
}

/// A deed offer's name: at most [`MAX_OFFER_TEXT`] UTF-16 units (a string the
/// node holds is well formed already).
fn is_text(s: &str) -> bool {
    s.encode_utf16().count() <= MAX_OFFER_TEXT
}

/// computedFold NET: `-?[1-9]\d{0,39}`.
fn is_net(s: &str) -> bool {
    let d = s.strip_prefix('-').unwrap_or(s);
    !d.is_empty() && d.len() <= 40 && !d.starts_with('0') && d.bytes().all(|b| b.is_ascii_digit())
}

/// A rules version's spelling: `[a-z][a-z0-9]{0,7}`.
fn is_rv(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=8).contains(&b.len()) && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// How a round was decided, as a checkpoint says: `[hz]:` and 32 hex.
fn is_ck_d(s: &str) -> bool {
    (s.starts_with("h:") || s.starts_with("z:")) && hex_of(&s[2..], 32)
}

/// computedFold isHouseSumOutcome: a pocket 0 to 36, or two dice.
fn is_outcome(o: &CVal, craps: bool) -> bool {
    if craps {
        return o.as_arr().is_some_and(|a| a.len() == 2 && a.iter().all(|d| d.as_int().is_some_and(|d| (1..=6).contains(&d))));
    }
    o.as_int().is_some_and(|p| (0..=36).contains(&p))
}

/// computedHouse asDelegation: `{v:1, h, k, g}`.
pub fn as_delegation(v: &CVal) -> bool {
    has_fields(v, &["v", "h", "k", "g"], &[])
        && int_of(v, "v") == Some(1)
        && str_of(v, "h").is_some_and(is_pub)
        && str_of(v, "k").is_some_and(is_pub)
        && str_of(v, "g").is_some_and(is_sig)
}

/// A delegation no heavier than a small record (a padded one is junk).
fn small_delegation(v: &CVal) -> bool {
    weight_of(v, MAX_SMALL_RECORD_BYTES).is_some() && as_delegation(v)
}

/// computedFairOnly asFin: an end order `{v:1, k, g}`. The signature is the
/// resolver's to check.
pub fn as_fin(v: &CVal) -> bool {
    is_obj(v)
        && weight_of(v, MAX_SMALL_RECORD_BYTES).is_some()
        && has_fields(v, &["v", "k", "g"], &[])
        && int_of(v, "v") == Some(1)
        && str_of(v, "k").is_some_and(is_pub)
        && str_of(v, "g").is_some_and(is_sig)
}

/// computedFairOnly asDeedOffer: a deed offer of `room` made out to a person.
/// Whether its maker signed it is the resolver's. (Weighed as the pages weigh
/// it, though the one caller here, [`as_xf`], has weighed the transfer around
/// it already: a reader of a `do:` record, when the node gets one, has not.)
pub fn as_deed_offer(v: &CVal, room: &str) -> bool {
    if !is_obj(v) || weight_of(v, MAX_SMALL_RECORD_BYTES).is_none() {
        return false;
    }
    if !has_fields(v, &["v", "kind", "asset", "makerPub", "makerName", "toPub", "price", "issuedAt", "expiresAt", "nonce", "sig"], &[]) {
        return false;
    }
    if int_of(v, "v") != Some(1) || str_of(v, "kind") != Some("transfer-offer") {
        return false;
    }
    let Some(a) = v.get("asset").filter(|a| has_fields(a, &["kind", "roomId", "roomName"], &[])) else { return false };
    if str_of(a, "kind") != Some("deed") || str_of(a, "roomId") != Some(room) || !str_of(a, "roomName").is_some_and(is_text) {
        return false;
    }
    if !str_of(v, "makerPub").is_some_and(is_pub)
        || !str_of(v, "makerName").is_some_and(is_text)
        || !str_of(v, "toPub").is_some_and(is_pub)
        || !str_of(v, "sig").is_some_and(is_sig)
    {
        return false;
    }
    if int_of(v, "price") != Some(0) || count_of(v, "issuedAt").is_none() || count_of(v, "expiresAt").is_none() {
        return false;
    }
    str_of(v, "nonce").is_some_and(|n| hex_of(n, 24))
}

/// computedFairOnly asXf: a transfer `{v:1, o, u, k, g}` whose deed offer is
/// made out to the buyer `k`. The signatures, and whether the offer is newer
/// than the game, are the resolver's.
pub fn as_xf(v: &CVal, room: &str) -> bool {
    if !is_obj(v) || weight_of(v, MAX_SMALL_RECORD_BYTES).is_none() || !has_fields(v, &["v", "o", "u", "k", "g"], &[]) {
        return false;
    }
    if int_of(v, "v") != Some(1) || !str_of(v, "g").is_some_and(is_sig) || round_of(v, "u").is_none() {
        return false;
    }
    let Some(o) = v.get("o").filter(|o| as_deed_offer(o, room)) else { return false };
    str_of(o, "toPub").is_some() && str_of(o, "toPub") == str_of(v, "k")
}

/// What reading a `ck:` key's value gives.
#[derive(Clone, Debug, PartialEq)]
pub enum CkRead {
    /// A checkpoint of the game `inc` at table `t`, whole: its shape is right
    /// and the key's id is the hash of the value.
    Ok { t: String, inc: String, id: String, ck: CVal },
    /// Well formed as far as the name goes, but of a rules version this build
    /// does not know: nothing of the game counts.
    Newer { t: String, inc: String, rv: String },
    Junk,
}

/// The checks of design §8.3 S0 on a value whose name has been settled
/// (computedFairOnly ckBody): the fields, their forms, and the rules that tie
/// them together. Signatures, authority and the id are not here.
fn ck_body(v: &CVal, room: &str, craps: bool) -> bool {
    if !has_fields(v, &["v", "ok", "j", "rv", "ts", "b", "u", "l", "n", "k", "g"], &["w", "d", "o", "e", "f", "s", "h", "dl", "x"]) {
        return false;
    }
    if int_of(v, "v") != Some(1) || !str_of(v, "k").is_some_and(is_pub) || !str_of(v, "g").is_some_and(is_sig) {
        return false;
    }
    let Some(u) = round_of(v, "u") else { return false };
    // `b` names the session a checkpoint closes: 'g' only on the opening root.
    let root = str_of(v, "b") == Some("g");
    if if root { u != 0 } else { !str_of(v, "b").is_some_and(|b| hex_of(b, 24)) } {
        return false;
    }
    // `l` is the close of round u: none at u = 0, always one after.
    let l = str_of(v, "l");
    if if u == 0 { l != Some(NO_CLOSE) } else { !l.is_some_and(|l| hex_of(l, 32) && l != NO_CLOSE) } {
        return false;
    }
    let w = v.get("w");
    if w.is_some_and(|w| !w.as_int().is_some_and(|w| w >= 1)) {
        return false;
    }
    // `d` says how round u was decided, so it is there exactly after a round.
    let d = v.get("d");
    if if u == 0 { d.is_some() } else { !d.and_then(CVal::as_str).is_some_and(is_ck_d) } {
        return false;
    }
    if let Some(o) = v.get("o") {
        if !(d.and_then(CVal::as_str).is_some_and(|d| d.starts_with("h:")) && is_outcome(o, craps)) {
            return false;
        }
    }
    // The nets: since the incarnation opened, so none before a round. (A player whose net is
    // undefined is no player, as in the record's id.)
    let Some(n) = v.get("n").and_then(CVal::fields) else { return false };
    if n.len() > MAX_TABLE_PIDS || (u == 0 && !n.is_empty()) {
        return false;
    }
    if !n.iter().all(|(pid, net)| is_pid(pid) && net.as_str().is_some_and(is_net)) {
        return false;
    }
    // An end carries the authority's end order, and nothing a live game plays on.
    let ended = match v.get("e") {
        None => false,
        Some(CVal::Int(1)) => true,
        Some(_) => return false,
    };
    let f = v.get("f");
    if ended != f.is_some() || f.is_some_and(|f| !as_fin(f)) {
        return false;
    }
    let (s, h) = (v.get("s"), v.get("h"));
    if ended && (s.is_some() || h.is_some() || w.is_some()) {
        return false;
    }
    // The craps carry: there while live, only at craps, and the opening one at u = 0.
    if if craps && !ended { !s.is_some_and(is_carry) } else { s.is_some() } {
        return false;
    }
    if u == 0 && s.is_some_and(|s| hb::canon(s).as_deref() != Some(r#"{"p":0,"w":{}}"#)) {
        return false;
    }
    // The commitment the next round must name: none before the house has joined one.
    if h.is_some_and(|h| u == 0 || !h.as_str().is_some_and(|h| hex_of(h, 64))) {
        return false;
    }
    // Who delegated the signer. The root's names the owner's house; any other
    // record's names the signer itself, as a house.
    let dl = v.get("dl");
    if let Some(dl) = dl {
        if !small_delegation(dl) || if root { str_of(dl, "k") != str_of(v, "ok") } else { str_of(dl, "h") != str_of(v, "k") } {
            return false;
        }
    }
    // The transfers that brought the game to this record's authority.
    let x = v.get("x");
    if let Some(x) = x {
        if !x.as_arr().is_some_and(|x| (1..=MAX_TRANSFERS).contains(&x.len()) && x.iter().all(|xf| as_xf(xf, room))) {
            return false;
        }
    }
    if root {
        // The root: signed by the owner who opened the game, naming that owner's house.
        str_of(v, "k") == str_of(v, "ok") && dl.is_some() && w.is_none() && !ended && x.is_none()
    } else {
        // At u = 0 the only records after the root are a sweep of its session and an end.
        !(u == 0 && w.is_none() && !ended)
    }
}

/// computedFairOnly readCk: the value stored at a `ck:` key (design §8.3
/// S0). The key parses, the value is no heavier than
/// [`MAX_CHECKPOINT_BYTES`], its name inputs hash to the incarnation it sits
/// under (and this build knows its rules version), its fields have their
/// forms and agree with each other, and the key's id is the hash of the
/// value. The signatures and who may sign are the resolver's. Junk is never
/// deleted for failing this.
pub fn read_ck(room: &str, key: &str, value: &CVal) -> CkRead {
    let Some(FairOnlyKey::Ck { t, inc, id }) = parse_fair_only_key(key) else { return CkRead::Junk };
    if !is_obj(value) || weight_of(value, MAX_CHECKPOINT_BYTES).is_none() {
        return CkRead::Junk;
    }
    let (Some(ok), Some(j), Some(rv), Some(ts)) = (str_of(value, "ok"), str_of(value, "j"), str_of(value, "rv"), count_of(value, "ts")) else {
        return CkRead::Junk;
    };
    if !is_pub(ok) || !hex_of(j, 16) || !is_rv(rv) {
        return CkRead::Junk;
    }
    let letter = if inc.starts_with('q') { 'q' } else { 'p' };
    if hb::faironly_inc(letter, room, t, rv, ok, j, ts) != inc {
        return CkRead::Junk;
    }
    if !is_known_rv(rv) {
        return CkRead::Newer { t: t.to_string(), inc: inc.to_string(), rv: rv.to_string() };
    }
    if !ck_body(value, room, letter == 'q') || hb::ck_id(value).as_deref() != Some(id) {
        return CkRead::Junk;
    }
    CkRead::Ok { t: t.to_string(), inc: inc.to_string(), id: id.to_string(), ck: value.clone() }
}

// ── The resolver (computedFairOnlyAuth.ts) ───────────────────────────────────

/// A signature's verdict: `Some` once it is checked, `None` while the
/// caller's budget puts it off. Asked with the id the verdict is cached under
/// ([`sig_id`]), the key, the signed bytes (made only when the caller wants
/// them; `None` for a body that has none, which is a failed check) and the
/// signature.
pub type SigCheck<'a> = dyn FnMut(&str, &str, &dyn Fn() -> Option<Vec<u8>>, &str) -> Option<bool> + 'a;

/// computedFairOnlyAuth sigId: the id a verdict is cached under. `hash` is
/// the recHash of the signed record, signature included. A checkpoint's, an
/// end order's and a transfer's signature cover the table and the
/// incarnation; a deed offer's and a delegation's cover the room alone.
pub fn sig_id(kind: &str, t: &str, inc: &str, hash: &str) -> String {
    if kind == "offer" || kind == "hkey" {
        format!("{kind}|{hash}")
    } else {
        format!("{kind}|{t}|{inc}|{hash}")
    }
}

/// The records of ONE game as the doc holds them (the caller picks them out
/// by key), and the room's delegations.
#[derive(Default)]
pub struct AuthRecords<'a> {
    /// `ck:<t>:<inc>:*`: key and value.
    pub cks: Vec<(&'a str, &'a CVal)>,
    /// `xf:<t>:<inc>:*`: key and value.
    pub xfs: Vec<(&'a str, &'a CVal)>,
    /// The end orders to look at, in order: the doc's `fin:<t>:<inc>` first,
    /// then any the caller counted before and keeps.
    pub fins: Vec<&'a CVal>,
    /// The values of the room's `hk:` keys, then the caller's own.
    pub delegations: Vec<&'a CVal>,
}

/// The name's inputs of a game (computedFairOnly FairOnlyName).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Name {
    pub rv: String,
    pub ok: String,
    pub j: String,
    pub ts: i64,
}

/// A checkpoint that counts, with the key it is stored under.
#[derive(Clone, Debug, PartialEq)]
pub struct Counted {
    pub key: String,
    pub id: String,
    pub ck: CVal,
}

/// A transfer that counts. `key` is where the doc holds it (none for one
/// found only inside a checkpoint's `x`); `carriers` are the doc keys of the
/// checkpoints that carry it.
#[derive(Clone, Debug, PartialEq)]
pub struct Step {
    pub id: String,
    pub xf: CVal,
    pub key: Option<String>,
    pub carriers: Vec<String>,
}

/// One holder of the game, and the round it holds it from (0 for the opener).
#[derive(Clone, Debug, PartialEq)]
pub struct Holder {
    pub k: String,
    pub from: i64,
    pub step: Option<Step>,
}

/// Whether a key is a house of a round ([`Resolution::house_by`]).
#[derive(Clone, Debug, PartialEq)]
pub enum HouseBy {
    /// The delegation that makes it one, as it was given, with its hash.
    Yes { value: CVal, hash: String },
    No,
    /// One that could be it waits for its check.
    Pending,
}

/// computedFairOnlyAuth Resolution.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolution {
    pub t: String,
    pub inc: String,
    pub letter: char,
    /// The rules version is not one this build knows: nothing of the game counts.
    pub newer: bool,
    pub name: Option<Name>,
    /// The holders, in order: the first is the opener. Empty when nothing is readable.
    pub chain: Vec<Holder>,
    /// The key that holds the game now.
    pub holder: Option<String>,
    /// S3: the best checkpoint a key in range signed.
    pub base: Option<Counted>,
    /// S5: an end order standing at the base.
    pub fin: Option<CVal>,
    /// S7: there is a base and it is no end.
    pub live: bool,
    /// A checkpoint that would be the base were it good was not looked at for
    /// want of a place ([`MAX_CK_CANDIDATES`]).
    pub unlooked: bool,
    /// Doc keys of whole records whose signature fails under the key they
    /// claim (`ck:` and `xf:` only), sorted: delete them.
    pub invalid: Vec<String>,
    /// A check was put off and could still change this answer, or more forged
    /// transfers stand in the holder's way than a resolution walks past.
    pub pending: bool,
    /// The delegations this resolution was given (the room's, the caller's,
    /// and those the game's readable checkpoints carry, in that order), each
    /// once, with its hash.
    delegations: Vec<(CVal, String)>,
    room: String,
}

fn u_of(ck: &CVal) -> i64 {
    int_of(ck, "u").unwrap_or(0)
}

fn w_of(ck: &CVal) -> i64 {
    int_of(ck, "w").unwrap_or(0)
}

fn e_of(ck: &CVal) -> i64 {
    int_of(ck, "e").unwrap_or(0)
}

/// S3: the highest round, then an end, then the most sweeps, then the lowest id.
fn by_best(a: &Counted, b: &Counted) -> std::cmp::Ordering {
    u_of(&b.ck).cmp(&u_of(&a.ck)).then(e_of(&b.ck).cmp(&e_of(&a.ck))).then(w_of(&b.ck).cmp(&w_of(&a.ck))).then(a.id.cmp(&b.id))
}

/// The key whose authority a record speaks for: the key that delegated the
/// house that signed it, else the signer.
fn authority(ck: &CVal) -> &str {
    match ck.get("dl") {
        Some(dl) => str_of(dl, "k").unwrap_or(""),
        None => str_of(ck, "k").unwrap_or(""),
    }
}

fn x_of(ck: &CVal) -> &[CVal] {
    ck.get("x").and_then(CVal::as_arr).unwrap_or(&[])
}

/// Whether a record speaks for the buyer of the last transfer it carries:
/// only such a record's `x` is read. No signature is looked at.
fn claimed(ck: &CVal) -> bool {
    x_of(ck).last().is_some_and(|last| str_of(last, "k") == Some(authority(ck)))
}

/// Whether holder `i` of `chain` holds the game at round `u`: from the round
/// it took it to the round it gave it, both ends included (the last holder's
/// range is open).
fn in_range(chain: &[Holder], i: usize, u: i64) -> bool {
    chain[i].from <= u && (i + 1 == chain.len() || u <= chain[i + 1].from)
}

/// Whether an owner-level key `k` holds the game at round `u`.
fn holds(chain: &[Holder], k: &str, u: i64) -> bool {
    chain.iter().enumerate().any(|(i, h)| h.k == k && in_range(chain, i, u))
}

/// The bytes a deed offer's maker signed.
fn offer_bytes(o: &CVal) -> Option<Vec<u8>> {
    let a = o.get("asset")?;
    Some(hb::offer_sign_bytes(&hb::DeedOfferBytes {
        room_id: str_of(a, "roomId")?,
        room_name: str_of(a, "roomName")?,
        maker_pub: str_of(o, "makerPub")?,
        maker_name: str_of(o, "makerName")?,
        to_pub: str_of(o, "toPub"),
        to_venture_id: None,
        to_venture_name: None,
        price: int_of(o, "price")?,
        issued_at: int_of(o, "issuedAt")?,
        expires_at: int_of(o, "expiresAt")?,
        nonce: str_of(o, "nonce")?,
    }))
}

/// The game of `inc` at table `t` of `room`, from its records (design
/// section 8.3; computedFairOnlyAuth resolveGame). `live_sid` is the session
/// the caller folds now, if it has one: a checkpoint that closes it is looked
/// at first.
pub fn resolve_game(room: &str, t: &str, inc: &str, live_sid: Option<&str>, rec: &AuthRecords, sig: &mut SigCheck) -> Resolution {
    let letter = if inc.starts_with('q') { 'q' } else { 'p' };
    let ctx = Ctx { room: room.to_string(), t: t.to_string(), inc: inc.to_string() };
    let mut invalid: BTreeSet<String> = BTreeSet::new();
    let mut pending = false;

    // S0: what is readable. A name binds its table, so `inc` is all a record has to match.
    let mut readable: Vec<Counted> = Vec::new();
    let mut newer = false;
    for (key, value) in &rec.cks {
        match read_ck(room, key, value) {
            CkRead::Ok { inc: i, id, ck, .. } if i == inc => readable.push(Counted { key: key.to_string(), id, ck }),
            CkRead::Newer { inc: i, .. } if i == inc => newer = true,
            _ => {}
        }
    }
    let name = readable.first().map(|c| Name {
        rv: str_of(&c.ck, "rv").unwrap_or("").to_string(),
        ok: str_of(&c.ck, "ok").unwrap_or("").to_string(),
        j: str_of(&c.ck, "j").unwrap_or("").to_string(),
        ts: int_of(&c.ck, "ts").unwrap_or(0),
    });
    let Some(name) = name else {
        return Resolution {
            t: t.to_string(),
            inc: inc.to_string(),
            letter,
            newer,
            name: None,
            chain: Vec::new(),
            holder: None,
            base: None,
            fin: None,
            live: false,
            unlooked: false,
            invalid: Vec::new(),
            pending: false,
            delegations: Vec::new(),
            room: room.to_string(),
        };
    };

    // S2: the transfers that can move this game: those it was written with (`xf:`), and those a
    // checkpoint whose signer could hold the game carries. (The ones under their keys come first,
    // so a copy that has a key keeps it.)
    let mut found: Vec<Step> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut take = |xf: &CVal, id: String, key: Option<&str>, carrier: Option<&str>| {
        // Made before the game opened: a replay.
        if xf.get("o").and_then(|o| int_of(o, "issuedAt")).unwrap_or(0) < name.ts - OFFER_SKEW_MS {
            return;
        }
        let i = *at.entry(id.clone()).or_insert_with(|| {
            found.push(Step { id, xf: xf.clone(), key: key.map(str::to_string), carriers: Vec::new() });
            found.len() - 1
        });
        if let Some(c) = carrier {
            found[i].carriers.push(c.to_string());
        }
    };
    for (key, value) in &rec.xfs {
        let Some(FairOnlyKey::Xf { t: kt, inc: ki, id }) = parse_fair_only_key(key) else { continue };
        if kt == t && ki == inc && as_xf(value, room) && hb::xf_id(value).as_deref() == Some(id) {
            take(value, id.to_string(), Some(key), None);
        }
    }
    for c in &readable {
        if claimed(&c.ck) {
            for xf in x_of(&c.ck) {
                // (read_ck took it as a transfer already: only its id is worked out.)
                if let Some(id) = hb::xf_id(xf) {
                    take(xf, id, None, Some(&c.key));
                }
            }
        }
    }

    // The chain: from the opener, the next holder is the lowest-round transfer made by the holder,
    // at or after the round it took the game, with an offer not used before.
    let mut chain: Vec<Holder> = vec![Holder { k: name.ok.clone(), from: 0, step: None }];
    let mut used: HashSet<String> = HashSet::new();
    let checked_xf = |s: &Step, sig: &mut SigCheck| -> Option<bool> {
        let Some(o) = s.xf.get("o") else { return Some(false) };
        let Some(oh) = hb::rec_hash(o) else { return Some(false) };
        let maker = sig(&sig_id("offer", t, inc, &oh), str_of(o, "makerPub").unwrap_or(""), &|| offer_bytes(o), str_of(o, "sig").unwrap_or(""));
        if maker != Some(true) {
            return maker;
        }
        let Some(xh) = hb::rec_hash(&s.xf) else { return Some(false) };
        sig(&sig_id("xf", t, inc, &xh), str_of(&s.xf, "k").unwrap_or(""), &|| hb::sign_bytes("xf", &ctx, &s.xf).map(|b| b.to_vec()), str_of(&s.xf, "g").unwrap_or(""))
    };
    let maker_of = |s: &Step| s.xf.get("o").and_then(|o| str_of(o, "makerPub")).unwrap_or("").to_string();
    let nonce_of = |s: &Step| s.xf.get("o").and_then(|o| str_of(o, "nonce")).unwrap_or("").to_string();
    let mut chain_pending = false;
    let mut forged = 0;
    while chain.len() <= MAX_TRANSFERS && !chain_pending {
        let last = &chain[chain.len() - 1];
        let mut next: Vec<&Step> = found.iter().filter(|s| maker_of(s) == last.k && u_of(&s.xf) >= last.from && !used.contains(&nonce_of(s))).collect();
        next.sort_by(|a, b| u_of(&a.xf).cmp(&u_of(&b.xf)).then(a.id.cmp(&b.id)));
        let mut taken: Option<&Step> = None;
        for s in next {
            match checked_xf(s, sig) {
                Some(true) => {
                    taken = Some(s);
                    break;
                }
                None => {
                    chain_pending = true;
                    break;
                }
                Some(false) => {
                    // Forged: its key goes, and every checkpoint that carries it, which no chain can ever bear out.
                    invalid.extend(s.key.iter().cloned());
                    invalid.extend(s.carriers.iter().cloned());
                    // One more forged than the resolution walks past: the holder is not known until they are gone.
                    forged += 1;
                    if forged > MAX_FORGED_XFS {
                        chain_pending = true;
                        break;
                    }
                }
            }
        }
        let Some(s) = taken else { break };
        used.insert(nonce_of(s));
        chain.push(Holder { k: str_of(&s.xf, "k").unwrap_or("").to_string(), from: u_of(&s.xf), step: Some(s.clone()) });
    }
    if chain_pending {
        pending = true;
    }

    // S1: the checkpoints whose signer could hold the game, best first to look at. A record speaks
    // for the chain's holder `i` when `i` steps are in its `x` and the holder is the buyer of the last.
    let mut plausible: Vec<&Counted> = readable
        .iter()
        .filter(|c| {
            let x = x_of(&c.ck);
            let i = x.len();
            if chain.get(i).map(|h| h.k.as_str()) != Some(authority(&c.ck)) || !in_range(&chain, i, u_of(&c.ck)) {
                return false;
            }
            if (0..i).any(|j| hb::xf_id(&x[j]).as_deref() != chain[j + 1].step.as_ref().map(|s| s.id.as_str())) {
                return false;
            }
            // An end order must be an owner-level key's, holding the game at the round it ends.
            c.ck.get("f").is_none_or(|f| holds(&chain, str_of(f, "k").unwrap_or(""), u_of(&c.ck)))
        })
        .collect();
    let closes_live = |c: &Counted| live_sid.is_some() && str_of(&c.ck, "b") == live_sid;
    plausible.sort_by(|a, b| {
        closes_live(b)
            .cmp(&closes_live(a))
            .then(u_of(&b.ck).cmp(&u_of(&a.ck)))
            .then(w_of(&b.ck).cmp(&w_of(&a.ck)))
            .then(e_of(&b.ck).cmp(&e_of(&a.ck)))
            .then(a.id.cmp(&b.id))
    });

    let checked_ck = |cd: &Counted, sig: &mut SigCheck| -> Option<bool> {
        let c = &cd.ck;
        let Some(h) = hb::rec_hash(c) else { return Some(false) };
        // Every signature is looked at (a later one that fails makes the record invalid however the
        // earlier ones stand), and one put off leaves the verdict open.
        let mut open = false;
        let mut fails = |v: Option<bool>| {
            open |= v.is_none();
            v == Some(false)
        };
        if fails(sig(&sig_id("ck", t, inc, &h), str_of(c, "k").unwrap_or(""), &|| hb::sign_bytes("ck", &ctx, c).map(|b| b.to_vec()), str_of(c, "g").unwrap_or(""))) {
            return Some(false);
        }
        if let Some(dl) = c.get("dl") {
            let Some(dh) = hb::rec_hash(dl) else { return Some(false) };
            let v = sig(&sig_id("hkey", t, inc, &dh), str_of(dl, "k").unwrap_or(""), &|| hb::room_sign_bytes("hkey", room, "", dl).map(|b| b.to_vec()), str_of(dl, "g").unwrap_or(""));
            if fails(v) {
                return Some(false);
            }
        }
        if let Some(f) = c.get("f") {
            let Some(fh) = hb::rec_hash(f) else { return Some(false) };
            let v = sig(&sig_id("fin", t, inc, &fh), str_of(f, "k").unwrap_or(""), &|| hb::sign_bytes("fin", &ctx, f).map(|b| b.to_vec()), str_of(f, "g").unwrap_or(""));
            if fails(v) {
                return Some(false);
            }
        }
        if open { None } else { Some(true) }
    };

    let mut valid: Vec<&Counted> = Vec::new();
    let mut waiting: Vec<&Counted> = Vec::new();
    let mut looked = 0;
    // Where the looking stopped for want of a place, if it did.
    let mut cut = plausible.len();
    for (i, cd) in plausible.iter().enumerate() {
        if looked >= MAX_CK_CANDIDATES {
            cut = i;
            break;
        }
        // Anything below a checkpoint already found valid can't be the base.
        if valid.first().is_some_and(|best| u_of(&cd.ck) < u_of(&best.ck)) {
            continue;
        }
        match checked_ck(cd, sig) {
            Some(false) => {
                invalid.insert(cd.key.clone());
            }
            v => {
                looked += 1;
                if v.is_none() {
                    waiting.push(cd);
                } else {
                    valid.push(cd);
                    valid.sort_by(|a, b| by_best(a, b));
                }
            }
        }
    }
    let base: Option<&Counted> = valid.first().copied();
    // A checkpoint holds the pass if it would be the base were it good, by S3's whole order: one put
    // off, and (while any is put off) one left unlooked at for want of a place.
    let beats = |cd: &Counted| base.is_none_or(|b| by_best(cd, b) == std::cmp::Ordering::Less);
    let unlooked = plausible[cut..].iter().any(|cd| beats(cd));
    if !waiting.is_empty() && (waiting.iter().any(|cd| beats(cd)) || unlooked) {
        pending = true;
    }

    // S5: the end order that stands: one the game's holder now signed, or, of a game that has ended,
    // one a key that held it at the round it ended signed (the order its end carries).
    let mut fin: Option<CVal> = None;
    if let Some(base) = base {
        let ended = e_of(&base.ck) == 1;
        let candidates = base.ck.get("f").into_iter().chain(rec.fins.iter().copied().filter(|f| as_fin(f)));
        for f in candidates {
            let k = str_of(f, "k").unwrap_or("");
            if k != chain[chain.len() - 1].k && !(ended && holds(&chain, k, u_of(&base.ck))) {
                continue;
            }
            let Some(fh) = hb::rec_hash(f) else { continue };
            match sig(&sig_id("fin", t, inc, &fh), k, &|| hb::sign_bytes("fin", &ctx, f).map(|b| b.to_vec()), str_of(f, "g").unwrap_or("")) {
                Some(true) => {
                    fin = Some(f.clone());
                    break;
                }
                None => pending = true,
                Some(false) => {}
            }
        }
    }

    // The houses: delegations the room holds and those the game's checkpoints carry. (A delegation is
    // a few short fields: one padded past that is junk, as a padded transfer is.)
    let mut delegations: Vec<(CVal, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let given = rec.delegations.iter().copied().chain(readable.iter().filter_map(|c| c.ck.get("dl")));
    for d in given {
        if !small_delegation(d) {
            continue;
        }
        if let Some(hash) = hb::rec_hash(d) {
            if seen.insert(hash.clone()) {
                delegations.push((d.clone(), hash));
            }
        }
    }

    let base = base.cloned();
    Resolution {
        t: t.to_string(),
        inc: inc.to_string(),
        letter,
        newer: false,
        name: Some(name),
        holder: Some(chain[chain.len() - 1].k.clone()),
        live: base.as_ref().is_some_and(|b| e_of(&b.ck) != 1),
        chain,
        base,
        fin,
        unlooked,
        invalid: invalid.into_iter().collect(),
        pending,
        delegations,
        room: room.to_string(),
    }
}

impl Resolution {
    /// The delegation that makes `house` a house of round `round`: the first of
    /// those this resolution was given that the key holding the game for
    /// `round` signed and whose check passes. A key holds the game for a
    /// round after the round it took the game, up to the round it gave it.
    pub fn house_by(&self, house: &str, round: i64, sig: &mut SigCheck) -> HouseBy {
        let mut waiting = false;
        for (d, hash) in &self.delegations {
            if str_of(d, "h") != Some(house) {
                continue;
            }
            let k = str_of(d, "k").unwrap_or("");
            let chain = &self.chain;
            let holder = chain.iter().enumerate().any(|(i, h)| h.k == k && h.from < round && (i + 1 == chain.len() || round <= chain[i + 1].from));
            if !holder {
                continue;
            }
            match sig(&sig_id("hkey", &self.t, &self.inc, hash), k, &|| hb::room_sign_bytes("hkey", &self.room, "", d).map(|b| b.to_vec()), str_of(d, "g").unwrap_or("")) {
                Some(true) => return HouseBy::Yes { value: d.clone(), hash: hash.clone() },
                None => waiting = true,
                Some(false) => {}
            }
        }
        if waiting { HouseBy::Pending } else { HouseBy::No }
    }

    /// Whether `house` decides round `round` of this game; None while the
    /// delegation's check is put off.
    pub fn house_at(&self, house: &str, round: i64, sig: &mut SigCheck) -> Option<bool> {
        match self.house_by(house, round, sig) {
            HouseBy::Yes { .. } => Some(true),
            HouseBy::No => Some(false),
            HouseBy::Pending => None,
        }
    }
}

// ── S9: the table's game ─────────────────────────────────────────────────────

/// computedFairOnlyAuth tableGame: of the live games of one table, the one
/// pages play: the only one whose holder is `deed_holder`; else the one the
/// switch names; else the lowest name. It decides where new bets go, never
/// what anyone's nets are or whether a game ends.
pub fn table_game<'a>(games: &'a [Resolution], deed_holder: Option<&str>, switch_inc: Option<&str>) -> Option<&'a Resolution> {
    let live: Vec<&Resolution> = games.iter().filter(|g| g.live).collect();
    let theirs: Vec<&&Resolution> = live.iter().filter(|g| deed_holder.is_some() && g.holder.as_deref() == deed_holder).collect();
    if theirs.len() == 1 {
        return Some(*theirs[0]);
    }
    if let Some(named) = live.iter().find(|g| Some(g.inc.as_str()) == switch_inc) {
        return Some(*named);
    }
    live.into_iter().min_by(|a, b| a.inc.cmp(&b.inc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors/computed-authority-v1.json");
    const CK_VECTORS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../test-vectors/computed-checkpoint-v1.json");

    fn load(path: &str) -> Value {
        let raw = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
        serde_json::from_str(&raw).expect("vector file is valid JSON")
    }

    /// A value as the file holds it, made what it stands for (the marks the
    /// TypeScript side's `realize` reads).
    fn real(v: &Value) -> CVal {
        match v {
            Value::Array(a) => CVal::Arr(a.iter().map(real).collect()),
            Value::Object(o) => {
                if o.len() == 1 {
                    let (k, x) = o.iter().next().unwrap();
                    match (k.as_str(), x) {
                        ("$undefined", Value::Bool(true)) => return CVal::Undef,
                        ("$repeat", Value::Array(a)) => return CVal::Str(a[0].as_str().unwrap().repeat(a[1].as_u64().unwrap() as usize)),
                        ("$nets", Value::Number(n)) => {
                            return CVal::Obj((0..n.as_u64().unwrap()).map(|i| (format!("p{i}"), CVal::Str("1".into()))).collect());
                        }
                        ("$pid", Value::Array(a)) => {
                            return CVal::Obj(vec![(a[0].as_str().unwrap().repeat(a[1].as_u64().unwrap() as usize), CVal::Str("1".into()))]);
                        }
                        ("$padded", Value::Array(a)) => {
                            let CVal::Obj(mut fields) = real(&a[0]) else { panic!("padding of a value that is no object") };
                            fields.push(("a".repeat(a[1].as_u64().unwrap() as usize), CVal::Undef));
                            return CVal::Obj(fields);
                        }
                        _ => {}
                    }
                }
                CVal::Obj(o.iter().map(|(k, x)| (k.clone(), real(x))).collect())
            }
            other => CVal::from_json(other),
        }
    }

    /// `base` with `odd` at `path` (dots go into objects); `{$absent: true}` takes the field out.
    fn patched(base: &CVal, path: &str, odd: &Value) -> CVal {
        let (head, rest) = match path.split_once('.') {
            Some((h, r)) => (h, Some(r)),
            None => (path, None),
        };
        let CVal::Obj(fields) = base else { panic!("{path} of a value that is no object") };
        let mut out: Vec<(String, CVal)> = fields.iter().filter(|(k, _)| k != head).cloned().collect();
        match rest {
            Some(rest) => out.push((head.to_string(), patched(base.get(head).unwrap(), rest, odd))),
            None if odd.get("$absent") == Some(&Value::Bool(true)) => {}
            None => out.push((head.to_string(), real(odd))),
        }
        CVal::Obj(out)
    }

    fn code(r: &CkRead) -> char {
        match r {
            CkRead::Ok { .. } => 'o',
            CkRead::Newer { .. } => 'n',
            CkRead::Junk => 'j',
        }
    }

    fn s<'a>(v: &'a Value, k: &str) -> &'a str {
        v[k].as_str().unwrap_or_else(|| panic!("no string {k} in {v}"))
    }

    #[test]
    fn checkpoints_read_as_the_pages_read_them() {
        let v = load(VECTORS);
        let room = s(&v, "room");
        let odd = v["odd"].as_array().unwrap();
        let reads = v["reads"].as_array().unwrap();
        assert!(reads.len() >= 22 && odd.len() >= 70);
        let mut seen = [0usize; 3];
        for r in reads {
            let (name, t, inc) = (s(r, "name"), s(r, "t"), s(r, "inc"));
            let base = real(&r["value"]);
            let key_of = |x: &CVal| format!("ck:{t}:{inc}:{}", hb::ck_id(x).unwrap_or_else(|| "0".repeat(32)));
            assert_eq!(code(&read_ck(room, &key_of(&base), &base)).to_string(), s(r, "whole"), "{name}");
            for (f, codes) in r["fields"].as_object().unwrap() {
                let codes: Vec<char> = codes.as_str().unwrap().chars().collect();
                assert_eq!(codes.len(), odd.len());
                for (i, want) in codes.iter().enumerate() {
                    let x = patched(&base, f, &odd[i]);
                    let got = code(&read_ck(room, &key_of(&x), &x));
                    assert_eq!(got, *want, "{name}: {f} = {}", odd[i]);
                    seen["onj".find(got).unwrap()] += 1;
                }
            }
        }
        assert!(seen.iter().all(|n| *n > 200), "the vectors hold each answer: {seen:?}");
    }

    #[test]
    fn checkpoints_no_one_change_makes_read_as_the_pages_read_them() {
        let v = load(VECTORS);
        let room = s(&v, "room");
        let cases = v["specials"].as_array().unwrap();
        assert!(cases.len() >= 20);
        let mut seen = [0usize; 3];
        for c in cases {
            let x = real(&c["value"]);
            let key = format!("ck:{}:{}:{}", s(c, "t"), s(c, "inc"), hb::ck_id(&x).unwrap_or_else(|| "0".repeat(32)));
            let got = code(&read_ck(room, &key, &x));
            assert_eq!(got.to_string(), s(c, "read"), "{}", s(c, "name"));
            seen["onj".find(got).unwrap()] += 1;
        }
        assert!(seen.iter().all(|n| *n > 0), "the vectors hold each answer: {seen:?}");
    }

    #[test]
    fn keys_parse_as_the_pages_parse_them() {
        let v = load(VECTORS);
        let room = s(&v, "room");
        let trim = real(&v["pools"]["p"]["cks"]["t3"]["value"]);
        let keys = v["keys"].as_array().unwrap();
        assert!(keys.len() >= 30);
        let mut parsed = 0;
        for k in keys {
            let key = s(k, "key");
            let want = &k["parsed"];
            let got = match parse_fair_only_key(key) {
                None => Value::Null,
                Some(FairOnlyKey::Ck { t, inc, id }) => serde_json::json!({ "kind": "ck", "t": t, "inc": inc, "id": id }),
                Some(FairOnlyKey::Xf { t, inc, id }) => serde_json::json!({ "kind": "xf", "t": t, "inc": inc, "id": id }),
                Some(FairOnlyKey::Fin { t, inc }) => serde_json::json!({ "kind": "fin", "t": t, "inc": inc }),
                Some(FairOnlyKey::Do { nonce }) => serde_json::json!({ "kind": "do", "nonce": nonce }),
            };
            assert_eq!(&got, want, "{key:?}");
            parsed += !want.is_null() as usize;
            assert_eq!(code(&read_ck(room, key, &trim)).to_string(), s(k, "read"), "a whole checkpoint under {key:?}");
        }
        assert!(parsed >= 5);
    }

    #[test]
    fn small_records_read_as_the_pages_read_them() {
        let v = load(VECTORS);
        let room = s(&v, "room");
        let odd = v["odd"].as_array().unwrap();
        let readers: [(&str, &dyn Fn(&CVal) -> bool); 3] = [("xf", &|x| as_xf(x, room)), ("fin", &as_fin), ("dl", &small_delegation)];
        for (kind, takes) in readers {
            let case = &v["small"][kind];
            let base = real(&case["value"]);
            assert!(takes(&base), "{kind} as it is");
            let (mut yes, mut no) = (0, 0);
            for (f, bits) in case["fields"].as_object().unwrap() {
                for (i, want) in bits.as_str().unwrap().chars().enumerate() {
                    let got = takes(&patched(&base, f, &odd[i]));
                    assert_eq!(got, want == '1', "{kind}: {f} = {}", odd[i]);
                    if got { yes += 1 } else { no += 1 }
                }
            }
            assert!(yes >= 2 && no >= 100, "{kind}: {yes} taken, {no} refused");
        }
    }

    #[test]
    fn weights_match_the_pages() {
        let v = load(CK_VECTORS);
        let cases = v["weights"].as_array().unwrap();
        assert!(cases.len() >= 20);
        let mut heavy = 0;
        for c in cases {
            let cap = c["cap"].as_u64().unwrap() as usize;
            let want = c["weight"].as_u64().map(|w| w as usize);
            heavy += want.is_none() as usize;
            assert_eq!(weight_of(&real(&c["value"]), cap), want, "weight of {} within {cap}", c["value"]);
        }
        assert!(heavy >= 5, "the vectors hold values past their cap");
    }

    #[test]
    fn check_ids_match_the_pages() {
        let v = load(VECTORS);
        let ids = v["sigIds"].as_array().unwrap();
        assert_eq!(ids.len(), 5);
        for c in ids {
            assert_eq!(sig_id(s(c, "kind"), s(c, "t"), s(c, "inc"), s(c, "hash")), s(c, "id"));
        }
    }

    /// A doc key, short: its kind and the start of its id.
    fn short(key: &str) -> String {
        format!("{}|{}", &key[..2], &key[key.len() - 32..key.len() - 20])
    }

    /// The pool's records a game case names, as values.
    struct Game {
        inc: String,
        live_sid: Option<String>,
        cks: Vec<(String, CVal)>,
        xfs: Vec<(String, CVal)>,
        fins: Vec<CVal>,
        dls: Vec<CVal>,
        hold: HashSet<String>,
    }

    fn game_of(v: &Value, c: &Value) -> Game {
        let pool = &v["pools"][s(c, "letter")];
        let names = |k: &str| c[k].as_array().unwrap().iter().map(|n| n.as_str().unwrap().to_string()).collect::<Vec<_>>();
        let entries = |k: &str| names(k).iter().map(|n| (s(&pool[k][n], "key").to_string(), real(&pool[k][n]["value"]))).collect::<Vec<_>>();
        Game {
            inc: s(c, "inc").to_string(),
            live_sid: c.get("liveSid").and_then(Value::as_str).map(str::to_string),
            cks: entries("cks"),
            xfs: entries("xfs"),
            fins: names("fins").iter().map(|n| real(&pool["fins"][n])).collect(),
            dls: names("dls").iter().map(|n| real(&pool["dls"][n])).collect(),
            hold: names("hold").into_iter().collect(),
        }
    }

    /// The game resolved with the strict check, every check asked noted as its
    /// kind and the start of its record's hash; the hashes in `hold` read as
    /// not checked yet.
    fn resolved(room: &str, t: &str, g: &Game, asked: &mut Vec<String>) -> Resolution {
        let rec = AuthRecords {
            cks: g.cks.iter().map(|(k, x)| (k.as_str(), x)).collect(),
            xfs: g.xfs.iter().map(|(k, x)| (k.as_str(), x)).collect(),
            fins: g.fins.iter().collect(),
            delegations: g.dls.iter().collect(),
        };
        resolve_game(room, t, &g.inc, g.live_sid.as_deref(), &rec, &mut check(&g.hold, asked))
    }

    fn check<'a>(hold: &'a HashSet<String>, asked: &'a mut Vec<String>) -> impl FnMut(&str, &str, &dyn Fn() -> Option<Vec<u8>>, &str) -> Option<bool> + 'a {
        move |id, key, bytes, sig| {
            let hash = id.rsplit('|').next().unwrap();
            asked.push(format!("{}|{}", id.split('|').next().unwrap(), &hash[..12]));
            if hold.contains(hash) {
                return None;
            }
            Some(verified(id, key, bytes, sig))
        }
    }

    /// The strict check, each signed thing verified once for the whole run
    /// (by its id, the key and the signature: the games share their records).
    fn verified(id: &str, key: &str, bytes: &dyn Fn() -> Option<Vec<u8>>, sig: &str) -> bool {
        static SEEN: std::sync::Mutex<Option<HashMap<String, bool>>> = std::sync::Mutex::new(None);
        let at = format!("{id}|{key}|{sig}");
        if let Some(v) = SEEN.lock().unwrap().get_or_insert_with(HashMap::new).get(&at) {
            return *v;
        }
        let v = bytes().is_some_and(|b| hb::verify(key, &b, sig));
        SEEN.lock().unwrap().get_or_insert_with(HashMap::new).insert(at, v);
        v
    }

    #[test]
    fn games_resolve_as_the_pages_resolve_them() {
        let v = load(VECTORS);
        let (room, t) = (s(&v, "room"), s(&v, "t"));
        let houses: Vec<&str> = v["houses"].as_array().unwrap().iter().map(|h| h.as_str().unwrap()).collect();
        let rounds: Vec<i64> = v["houseRounds"].as_array().unwrap().iter().map(|r| r.as_i64().unwrap()).collect();
        let name = Name { rv: s(&v["name"], "rv").into(), ok: s(&v["name"], "ok").into(), j: s(&v["name"], "j").into(), ts: v["name"]["ts"].as_i64().unwrap() };
        let games = v["games"].as_array().unwrap();
        assert!(games.len() >= 190);
        let (mut pending, mut invalid, mut moved, mut ended, mut unlooked) = (0, 0, 0, 0, 0);
        for c in games {
            let label = s(c, "name");
            let g = game_of(&v, c);
            let mut asked = Vec::new();
            let res = resolved(room, t, &g, &mut asked);
            let want = &c["want"];
            assert_eq!(res.newer, want["newer"].as_bool().unwrap(), "{label}: newer");
            assert_eq!(res.name, want["named"].as_bool().unwrap().then(|| name.clone()), "{label}: the name");
            let chain: Vec<Value> = res
                .chain
                .iter()
                .map(|h| {
                    let step = h.step.as_ref();
                    serde_json::json!({
                        "k": h.k, "from": h.from, "step": step.map(|x| x.id[..12].to_string()), "key": step.and_then(|x| x.key.as_deref().map(short)),
                        "carriers": step.map(|x| x.carriers.iter().map(|k| short(k)).collect::<Vec<_>>()).unwrap_or_default(),
                    })
                })
                .collect();
            assert_eq!(Value::Array(chain), want["chain"], "{label}: the chain");
            assert_eq!(res.holder.as_deref(), want["holder"].as_str(), "{label}: the holder");
            assert_eq!(res.base.as_ref().map(|b| short(&b.key)).as_deref(), want["base"].as_str(), "{label}: the base");
            assert_eq!(res.fin.as_ref().and_then(hb::rec_hash).as_deref(), want["fin"].as_str(), "{label}: the end order");
            assert_eq!(res.live, want["live"].as_bool().unwrap(), "{label}: live");
            assert_eq!(res.unlooked, want["unlooked"].as_bool().unwrap(), "{label}: unlooked");
            assert_eq!(serde_json::json!(res.invalid.iter().map(|k| short(k)).collect::<Vec<_>>()), want["invalid"], "{label}: invalid");
            assert_eq!(res.pending, want["pending"].as_bool().unwrap(), "{label}: pending");
            let mut by: Vec<Value> = Vec::new();
            for h in &houses {
                for r in &rounds {
                    let got = res.house_by(h, *r, &mut check(&g.hold, &mut asked));
                    assert_eq!(res.house_at(h, *r, &mut check(&g.hold, &mut Vec::new())),
                        match got { HouseBy::Yes { .. } => Some(true), HouseBy::No => Some(false), HouseBy::Pending => None }, "{label}: house_at");
                    by.push(match got {
                        HouseBy::Yes { value, hash } => {
                            assert_eq!(hb::rec_hash(&value).as_deref(), Some(hash.as_str()));
                            Value::String(hash[..12].to_string())
                        }
                        HouseBy::No => Value::Null,
                        HouseBy::Pending => Value::String("pending".into()),
                    });
                }
            }
            assert_eq!(Value::Array(by), want["houses"], "{label}: the houses");
            assert_eq!(serde_json::json!(asked), want["asked"], "{label}: the checks asked, in order");
            pending += res.pending as usize;
            invalid += !res.invalid.is_empty() as usize;
            moved += (res.chain.len() > 1) as usize;
            ended += (res.base.is_some() && !res.live) as usize;
            unlooked += res.unlooked as usize;
        }
        assert!(pending > 20 && invalid > 40 && moved > 60 && ended > 20 && unlooked > 1, "{pending} {invalid} {moved} {ended} {unlooked}");
    }

    #[test]
    fn a_newer_rules_version_reads_as_newer() {
        let v = load(VECTORS);
        let n = &v["newer"];
        let value = real(&n["value"]);
        let rec = AuthRecords { cks: vec![(s(n, "key"), &value)], ..Default::default() };
        let res = resolve_game(s(&v, "room"), s(&v, "t"), s(n, "inc"), None, &rec, &mut |_, _, _, _| Some(true));
        assert!(res.newer && n["newer"].as_bool().unwrap());
        assert_eq!((res.name, res.holder, res.base, res.live), (None, None, None, false));
        // The same record asked about under another game's name is nothing there.
        let other = v["games"][0]["inc"].as_str().unwrap();
        let res = resolve_game(s(&v, "room"), s(&v, "t"), other, None, &rec, &mut |_, _, _, _| Some(true));
        assert!(!res.newer && res.name.is_none());
    }

    #[test]
    fn the_table_plays_the_game_the_pages_play() {
        let v = load(VECTORS);
        let (room, t) = (s(&v, "room"), s(&v, "t"));
        let games = v["games"].as_array().unwrap();
        let tables = v["tables"].as_array().unwrap();
        assert!(tables.len() >= 40);
        let mut places = HashSet::new();
        for case in tables {
            let names: Vec<&str> = case["games"].as_array().unwrap().iter().map(|n| n.as_str().unwrap()).collect();
            // (The games of one table have a name each; here they share one, so each is told apart by where it stands.)
            let marked: Vec<Resolution> = names
                .iter()
                .enumerate()
                .map(|(i, n)| {
                    let c = games.iter().find(|c| s(c, "name") == *n && s(c, "letter") == "p").unwrap();
                    let mut res = resolved(room, t, &game_of(&v, c), &mut Vec::new());
                    res.inc = format!("{}{i:024x}", res.letter);
                    res
                })
                .collect();
            let switch = case["switchAt"].as_u64().map(|i| marked[i as usize].inc.clone());
            let got = table_game(&marked, case["deedHolder"].as_str(), switch.as_deref());
            let place = got.map(|g| marked.iter().position(|m| m.inc == g.inc).unwrap() as u64);
            assert_eq!(place, case["want"].as_u64(), "{case}");
            places.insert(place);
        }
        assert!(places.len() >= 4);
    }
}
