//! 🧮🔍 The node's fold, in SHADOW: what it says of a table, held against what a
//! page's checkpoint says (PR 6b-1c-iii of "Computed casino tables").
//!
//! A page that trims a table writes a checkpoint (`sum:<t>:<inc>`) at the last
//! round `u` it decided: the nets after it (`n`), that round's close (`l`),
//! and, as the table needs them, the house commitment the next round must
//! name (`h`) and a craps table's carried state (`s`). The node folds the same
//! table with the same code (the fold bundle in the worker, fed by the mirror),
//! so what it had worked out before the checkpoint came should be what the
//! checkpoint says. [`compare`] says whether it is. It writes nothing to any
//! doc: this is how a release finds out, in the field, whether the node's fold
//! can be trusted to write a checkpoint of its own (PR 6b-2).
//!
//! THE FIELDS. The nets through round `u` are the base's nets plus the deltas
//! of the decided rounds after the base up to `u` (zeros dropped), whether or
//! not the node has decided rounds after `u` too. `l` is round `u`'s close.
//! `h` and `s` are the table's state after its LAST decided round, so they are
//! compared only when `u` is that round (and not at all in the checkpoint of a
//! table that ended, which carries neither).
//!
//! WHAT IS NOT A DISAGREEMENT. The node's fold may not have got there: it has
//! not decided every round up to `u` (it is behind the page that trimmed), or
//! its base is already at `u` or beyond (a checkpoint it has seen, or an older
//! one put back), or its fold is not finished (signatures left unchecked), or
//! the checkpoint trims another session than the one the fold holds (`b`), or
//! the answer in hand was not the table as the node had last read it when the
//! trim came (or the node had not read all a page wrote to the session before
//! it trimmed it), or the houses and pins it was given were not shown to be
//! everything the room held while the session was in it, or a checkpoint was
//! written over by another before the node read it. Those are skipped,
//! and counted by why.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::{Duration, Instant};

use yrs::{Doc, Transact};

use crate::fold_feed::{Counts, Feed, Inputs};
use crate::fold_pins::{PinWatch, PlayerPins, PIN_WALK_KEYS, PIN_WALK_TIME};
use crate::fold_supervisor::{Event, Launch, Supervisor};
use crate::house::{checkpoint_ok, HousePlan};
use crate::house_bytes::{self as hb, CVal};
use crate::house_fold::{rules_id, FoldSummary, FOLD_TABLES};
use crate::house_mirror::{Hold, Limits, RoomMirror};
use crate::HouseFoldReport;

/// Why a comparison was not made.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Skip {
    /// The fold's base is at the checkpoint's round or beyond.
    Past,
    /// The fold has not decided every round up to the checkpoint's.
    Behind,
    /// A number too big to add (more than the 38 digits the node adds).
    Big,
    /// The checkpoint is not one the pages read (the mirror does not keep one).
    Unreadable,
    /// The fold is not finished: signatures are left unchecked, so a round it
    /// shows may be missing or undecided for want of them.
    Pending,
    /// The checkpoint closes another session than the one the fold holds (a
    /// split, or a jump): its nets and closes are of another history.
    Parent,
    /// The answer in hand was not the table as the node had last read it when
    /// the trim came (a change was still to be folded), or the node had not
    /// read all a page wrote to the session before it trimmed it, so a
    /// difference could be the fold's lateness.
    Stale,
    /// The houses and pins the fold was given were not shown to be everything
    /// the room held while the session was in it, so it may have left out a
    /// close a page counts.
    Inputs,
    /// A page's trim was read and the fold had no answer from before it to
    /// hold it against: the worker was restarted since, or the table's first
    /// answer had not come. (The checkpoint a table is first read with is no
    /// trim, and is not counted.)
    Unanswered,
    /// A table the plan stopped naming (a page's removal ended it, or its switch went or names another incarnation) was
    /// let go of because the final checkpoint a page writes when it compacts it had not come in [`GONE_GRACE`] (no page
    /// was awake to compact it, or the pages took longer than that): what the fold worked out of the table is held
    /// against nothing.
    Expired,
    /// A checkpoint was written over by another before the node read it (a drain that had not got to the table, or took
    /// its time): the node never had it to compare, and says so, for each.
    Superseded,
    /// The checkpoint names a house (`h`) that the fold has none required of: a house that stepped down in the open
    /// round clears what the fold requires without deciding another round, and the trimming page may not have received
    /// the step-down. (Every checkpoint of a round with a house the fold has stepped down for, and no other: that the fold
    /// has cleared it by mistake is not told from it. The difference is not a disagreement.)
    StepDown,
}

impl Skip {
    pub fn name(self) -> &'static str {
        match self {
            Skip::Past => "past",
            Skip::Behind => "behind",
            Skip::Big => "big",
            Skip::Unreadable => "unreadable",
            Skip::Pending => "pending",
            Skip::Parent => "parent",
            Skip::Stale => "stale",
            Skip::Inputs => "inputs",
            Skip::Unanswered => "unanswered",
            Skip::Expired => "expired",
            Skip::Superseded => "superseded",
            Skip::StepDown => "stepdown",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Verdict {
    Agree,
    /// The fold and the checkpoint differ: which field, and how.
    Mismatch(String),
    Skip(Skip),
}

/// A decimal net, as the pages write one (no `+`, no leading zero, `-` for a
/// loss). None for anything else, or too big for an i128.
fn net_of(s: &str) -> Option<i128> {
    s.parse::<i128>().ok()
}

fn nets_of(pairs: impl IntoIterator<Item = (String, String)>) -> Result<BTreeMap<String, i128>, Skip> {
    let mut m = BTreeMap::new();
    for (pid, d) in pairs {
        let n = net_of(&d).ok_or(Skip::Big)?;
        let at = m.entry(pid).or_insert(0i128);
        *at = at.checked_add(n).ok_or(Skip::Big)?;
    }
    m.retain(|_, n| *n != 0);
    Ok(m)
}

fn show(m: &BTreeMap<String, i128>) -> String {
    m.iter().map(|(p, n)| format!("{p}:{n}")).collect::<Vec<_>>().join(",")
}

/// How the nets differ, the first player to differ first: a line is kept to [`LOG_LINE_BYTES`], and the nets of every
/// player may take more than that before the one that differs. (A player the nets do not name has nothing, as in
/// both.)
fn nets_differ(u: i64, ours: &BTreeMap<String, i128>, theirs: &BTreeMap<String, i128>) -> String {
    let pids: BTreeSet<&String> = ours.keys().chain(theirs.keys()).filter(|p| ours.get(*p) != theirs.get(*p)).collect();
    let first = pids.iter().next().map_or(String::new(), |p| {
        let (a, b) = (ours.get(*p).copied().unwrap_or(0), theirs.get(*p).copied().unwrap_or(0));
        let more = if pids.len() > 1 { format!(" and {} more", pids.len() - 1) } else { String::new() };
        format!("{} has {a} in the fold and {b} in the checkpoint{more}; ", brief(p, 48))
    });
    format!("n through round {u}: {first}the fold has [{}], the checkpoint [{}]", show(ours), show(theirs))
}

/// The checkpoint `cp` (as the pages read one) against what the fold worked
/// out of the table before it, `summary`.
pub fn compare(summary: &FoldSummary, cp: &CVal, inc: &str) -> Verdict {
    if !checkpoint_ok(cp, inc) {
        return Verdict::Skip(Skip::Unreadable);
    }
    let Some(u) = cp.get("u").and_then(CVal::as_int) else { return Verdict::Skip(Skip::Unreadable) };
    if summary.pending {
        return Verdict::Skip(Skip::Pending);
    }
    let base = &summary.base;
    if u <= base.u {
        return Verdict::Skip(Skip::Past);
    }
    // A trim of the session the fold holds (the pages: a checkpoint trims the
    // session it names in `b`, which is the base's live session id).
    if cp.get("b").and_then(CVal::as_str) != Some(base.sid.as_str()) {
        return Verdict::Skip(Skip::Parent);
    }

    // The decided rounds after the base, up to u: each round's deltas added in
    // place (a round touches a few players, a base holds up to 4,096).
    let mut nets = match nets_of(base.n.iter().cloned()) {
        Ok(m) => m,
        Err(s) => return Verdict::Skip(s),
    };
    let mut at_u = None;
    for r in (base.u + 1)..=u {
        let Some(round) = summary.rounds.iter().find(|x| x.r == r).filter(|x| x.decided.is_some()) else {
            return Verdict::Skip(Skip::Behind);
        };
        for (pid, d) in &round.deltas {
            let Some(d) = net_of(d) else { return Verdict::Skip(Skip::Big) };
            let at = nets.entry(pid.clone()).or_insert(0i128);
            let Some(sum) = at.checked_add(d) else { return Verdict::Skip(Skip::Big) };
            *at = sum;
        }
        if r == u {
            at_u = Some(round);
        }
    }
    nets.retain(|_, n| *n != 0);
    let Some(round) = at_u else { return Verdict::Skip(Skip::Behind) };

    // The nets.
    let Some(entries) = cp.get("n").and_then(CVal::entries) else { return Verdict::Skip(Skip::Unreadable) };
    let theirs = match nets_of(entries.iter().filter_map(|(p, x)| x.as_str().map(|x| (p.clone(), x.to_string())))) {
        Ok(m) => m,
        Err(s) => return Verdict::Skip(s),
    };
    if theirs != nets {
        return Verdict::Mismatch(nets_differ(u, &nets, &theirs));
    }

    // The close of round u.
    if cp.get("l").and_then(CVal::as_str) != Some(round.close.as_str()) {
        return Verdict::Mismatch(format!("l: round {u} closed as {} in the fold, the checkpoint says {:?}", round.close, cp.get("l").and_then(CVal::as_str)));
    }

    // The state after the last round decided, when u is it.
    let later = summary.rounds.iter().any(|x| x.r > u && x.decided.is_some());
    let ended = cp.get("e").is_some();
    if !later && !ended {
        let h = cp.get("h").and_then(CVal::as_str);
        if h.is_some() && summary.required.is_none() {
            return Verdict::Skip(Skip::StepDown);
        }
        if h != summary.required.as_deref() {
            return Verdict::Mismatch(format!(
                "h: the fold wants {:?} named by round {}, the checkpoint says {:?}",
                summary.required,
                u + 1,
                cp.get("h").and_then(CVal::as_str)
            ));
        }
        let theirs = cp.get("s").and_then(hb::canon);
        let ours = if summary.carry.is_null() { None } else { hb::canon(&CVal::from_json(&summary.carry)) };
        if theirs != ours {
            return Verdict::Mismatch(format!("s: the fold carries {}, the checkpoint {}", summary.carry, cp.get("s").map_or("nothing".to_string(), |s| format!("{s:?}"))));
        }
    }
    Verdict::Agree
}

// ── The driver ───────────────────────────────────────────────────────────────

/// What the comparisons have found, over all rooms and tables.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub agree: u64,
    pub mismatch: u64,
    pub past: u64,
    pub behind: u64,
    pub big: u64,
    pub unreadable: u64,
    pub pending: u64,
    pub parent: u64,
    pub stale: u64,
    pub inputs: u64,
    pub unanswered: u64,
    pub expired: u64,
    pub superseded: u64,
    pub step_down: u64,
}

impl Tally {
    /// Every comparison not made.
    pub fn skipped(&self) -> u64 {
        self.past + self.behind + self.big + self.unreadable + self.pending + self.parent + self.stale + self.inputs + self.unanswered + self.expired + self.superseded + self.step_down
    }
}

impl Tally {
    fn note(&mut self, v: &Verdict) {
        match v {
            Verdict::Agree => self.agree += 1,
            Verdict::Mismatch(_) => self.mismatch += 1,
            Verdict::Skip(Skip::Past) => self.past += 1,
            Verdict::Skip(Skip::Behind) => self.behind += 1,
            Verdict::Skip(Skip::Big) => self.big += 1,
            Verdict::Skip(Skip::Unreadable) => self.unreadable += 1,
            Verdict::Skip(Skip::Pending) => self.pending += 1,
            Verdict::Skip(Skip::Parent) => self.parent += 1,
            Verdict::Skip(Skip::Stale) => self.stale += 1,
            Verdict::Skip(Skip::Inputs) => self.inputs += 1,
            Verdict::Skip(Skip::Unanswered) => self.unanswered += 1,
            Verdict::Skip(Skip::Expired) => self.expired += 1,
            Verdict::Skip(Skip::Superseded) => self.superseded += 1,
            Verdict::Skip(Skip::StepDown) => self.step_down += 1,
        }
    }
}

/// What the shadow needs of a room (from the house's plan and the players it
/// has watched): the house tables to follow `(t, inc)`, the keys of the houses
/// the fold counts, and the key pinned for each player `(pid, key)`.
#[derive(Clone, Debug, PartialEq)]
pub struct FoldView {
    pub tables: Vec<(String, String)>,
    pub houses: Vec<String>,
    pub pins: Vec<(String, String)>,
    /// The houses and pins are everything the room holds, as the pass that
    /// found the tables and the watch on the players show them: the pass read
    /// the whole room and held no table over a value a page may read
    /// otherwise, and the pins are the whole story (fold_pins.rs: no key
    /// replaced, none left unpinned, the players read to the end). The shadow
    /// asks it of every tick the session is followed in, not only the one a
    /// trim comes in.
    pub settled: bool,
    /// The epoch of the pins as this view saw them, and a way to ask where they are now
    /// (None: they never move, as in a view made by hand).
    pub pins_epoch: u64,
    pub watch: Option<PinWatch>,
}

/// How long a table that the plan stopped naming is kept for the final checkpoint a page writes when it compacts it. The
/// plan names the tables whose switch names a live incarnation, so one it stopped naming is one the pages count ended
/// (`computedEndedIncs`): removed (`gone:`), its switch gone, or its switch naming another incarnation; and a page
/// compacts each of them, in its turn, 10 s after it sees the end, or 60 s after if none of the slips in the table's
/// sessions are its own (`COMPACT_MS`, `COMPACT_FALLBACK_MS` of computedTable.ts). A page can see the end later than the
/// node, and a page that wakes starts the wait again. So twice the fallback: past it the table is let go of, checkpoint or
/// none, and the comparison not made is counted ([`Skip::Expired`]). (No page may be awake to compact it at all, so there
/// is no waiting for ever: the table would hold a place of the worker's 14 for good.)
pub const GONE_GRACE: Duration = Duration::from_secs(120);

/// How many checkpoints each table remembers having been compared with, or passed over and counted: a checkpoint is
/// compared once, whatever else the table goes through, and a page that puts back an older one (a rewind, and the
/// restore of what it rewound) must not have either counted again. The oldest is forgotten first. (A peer that writes
/// more distinct checkpoints than that in turn can have one counted again; each such write is a count of its own.)
pub const COMPARED_HISTORY: usize = 16;

/// How many lines of what the comparisons found the shadow keeps for `/api/fingerprint`: the last mismatches and the
/// last comparisons not made, each their own, so that a run of one cannot push out the other. (The node of the desktop
/// app has no console to print to.)
pub const LOG_LINES: usize = 32;
/// The most bytes of one such line: a mismatch names the nets of up to 4,096 players.
pub const LOG_LINE_BYTES: usize = 512;

/// The first `n` characters of `s`, and a … if there were more: a name a peer chose is not let take a line to itself.
fn brief(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

/// Which table a line is about: the room, the table and its incarnation (two rooms can have the same table).
fn tag(room: &str, t: &str, inc: &str) -> String {
    format!("{} {} {}", brief(room, 64), brief(t, 64), inc)
}

/// `line`, cut to [`LOG_LINE_BYTES`] at a character.
fn clip(mut line: String) -> String {
    if line.len() > LOG_LINE_BYTES {
        let mut cut = LOG_LINE_BYTES;
        while !line.is_char_boundary(cut) {
            cut -= 1;
        }
        line.truncate(cut);
        line.push('…');
    }
    line
}

/// What the comparisons said, kept (see [`LOG_LINES`]) as well as printed.
#[derive(Default)]
struct Log {
    mismatches: VecDeque<String>,
    skips: VecDeque<String>,
}

impl Log {
    fn push(&mut self, mismatch: bool, line: String) {
        let ring = if mismatch { &mut self.mismatches } else { &mut self.skips };
        if ring.len() >= LOG_LINES {
            ring.pop_front();
        }
        ring.push_back(clip(line));
    }
}

/// What a room's comparisons said since the shadow last took it: `(a mismatch, the line)`.
type Said = Vec<(bool, String)>;

/// Print `line` and keep it to be taken into the shadow's log (an agreement is printed only).
fn say(said: &mut Said, mismatch: bool, line: String) {
    eprintln!("🧮 fold-shadow {line}");
    said.push((mismatch, line));
}

/// The most tables the shadow follows at once, over all rooms: the worker's
/// engine holds FOLD_TABLES and lets the least recently used go, so more
/// followed than that would have the tables evict one another and ask again
/// for ever. Two are left free: a table that comes while another is still
/// being let go of is not one too many for a moment. The tables kept only
/// until their last checkpoint is read (see `RoomShadow::outgoing`) are among
/// them.
pub const MAX_SHADOW_TABLES: usize = FOLD_TABLES - 2;

type TableKey = (String, String);

/// What time it is, asked afresh where it matters (see [`tick_shadow_with`]); the tests give it a time of their own.
pub use crate::fold_supervisor::Clock;

/// What was shown of a table's answer: the answer (which taking up of the table, which frame of it), and where
/// the pins and the delegations stood then. The answer is believed at a trim only if they stand there still.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Shown {
    born: u64,
    frame: u64,
    pins: u64,
    delegations: u64,
}

/// One room the shadow follows: its mirror (an observer on the room's doc) and
/// its feed to the worker.
struct RoomShadow {
    mirror: RoomMirror,
    feed: Feed,
    /// The checkpoints (their canonical bytes' hash) each table was last compared with, or passed over, or was first
    /// read with, the last [`COMPARED_HISTORY`] of them: a checkpoint is compared once, whatever else starts the table
    /// over, or puts back one before it.
    compared: BTreeMap<TableKey, VecDeque<[u8; 32]>>,
    /// For each table, the answer that was shown to have been made with every house and pin the room held
    /// while the session was still in it: at a tick when the view was settled, no trim had been noted yet
    /// (so the pass behind the view saw the session), and the answer was of the last frame sent, with the
    /// view's houses and pins. A trim removes the session, so only what was shown before it can be shown;
    /// and a pin or a delegation that moved since (up to the doc the drain reads) takes it back.
    confirmed: BTreeMap<TableKey, Shown>,
    /// The houses and pins of the last tick, for the push.
    inputs: Inputs,
    /// How many delegations had changed, as of the last tick.
    seen_delegations: u64,
    /// Tables the plan stopped naming that the mirror still holds (the pages count them ended: removed, or their
    /// switch gone or naming another incarnation), and when each was first seen outside the view: kept for the final
    /// checkpoint a page writes when it compacts them, for [`GONE_GRACE`].
    gone: BTreeMap<TableKey, Instant>,
    /// The room is no longer followed: its tables are being let go of.
    leaving: bool,
    /// What its comparisons said, for the shadow's log.
    said: Said,
}

/// A checkpoint's identity: the hash of its canonical bytes.
fn identity(cp: &CVal) -> [u8; 32] {
    hb::sha256(hb::canon(cp).unwrap_or_default().as_bytes())
}

/// The identity of the checkpoint a table is held over (one the mirror keeps no copy of): which taking up of the table
/// it is, and how many times its base has changed.
fn held_identity(born: u64, trims: u64) -> [u8; 32] {
    hb::sha256(format!("held:{born}:{trims}").as_bytes())
}

#[cfg(test)]
thread_local! {
    /// How many rooms this thread's shadows have attached a mirror to.
    static ATTACHED: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

impl RoomShadow {
    fn attach(doc: &Doc, room: &str, limits: Limits) -> RoomShadow {
        #[cfg(test)]
        ATTACHED.with(|n| n.set(n.get() + 1));
        RoomShadow {
            mirror: RoomMirror::attach_with(doc, room, limits),
            feed: Feed::new(room),
            compared: BTreeMap::new(),
            confirmed: BTreeMap::new(),
            inputs: Inputs::default(),
            seen_delegations: 0,
            gone: BTreeMap::new(),
            leaving: false,
            said: Vec::new(),
        }
    }

    /// Whether the table `k`, which the view does not follow, is kept: its last checkpoint is not read yet, or
    /// the plan stopped naming it (the pages count it ended) and the checkpoint a page writes when it compacts it may
    /// yet come.
    fn kept(&self, k: &TableKey, now: Instant) -> bool {
        if self.mirror.base_unread(&k.0, &k.1) {
            return true;
        }
        let Some(since) = self.gone.get(k) else { return false };
        self.mirror.state(&k.0, &k.1).is_some_and(|st| !st.ended) && now.saturating_duration_since(*since) < GONE_GRACE
    }

    /// Note the tables the mirror holds that the view does not follow, when they are first seen so: the plan names the
    /// tables whose switch names a live incarnation, so one it does not is one the pages count ended (a removal, a switch
    /// that went, a switch that names another incarnation: a replacement), and the final checkpoint of any of them comes
    /// some time on, when a page compacts it. Before the tick counts the places it has, so that a table kept has its
    /// place from the tick it leaves the view. (One that is back in the plan is followed again, and nothing is kept
    /// of it: it is first seen outside afresh if it goes again.)
    fn note_gone(&mut self, view: &FoldView, now: Instant) {
        self.gone.retain(|k, _| !view.tables.contains(k));
        for c in self.mirror.tables() {
            let k = (c.t.clone(), c.inc.clone());
            if !view.tables.contains(&k) {
                self.gone.entry(k).or_insert(now);
            }
        }
    }

    /// The tables the mirror holds that the view does not follow and are kept (see `kept`): their last
    /// checkpoint is compared (or passed over and counted) before they are let go of, however many ticks the
    /// drains take to read it.
    fn outgoing(&self, view: &FoldView, now: Instant) -> BTreeSet<TableKey> {
        self.mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).filter(|k| !view.tables.contains(k) && self.kept(k, now)).collect()
    }

    /// The tables whose answer, as the tick begins, is the table as the mirror
    /// last read it, with the room's inputs as they are now ([`Feed::covers`]).
    fn covered<L: Launch>(&self, inputs: &Inputs, sup: &Supervisor<L>) -> BTreeSet<TableKey> {
        self.mirror.tables().filter(|c| self.feed.covers(&c.t, &c.inc, &self.mirror, sup, inputs)).map(|c| (c.t.clone(), c.inc.clone())).collect()
    }

    /// Note the tables whose answer was made with the houses and pins of a settled view, while
    /// the session was still in the room: before the drain, where no trim of the table has
    /// been noted.
    ///
    /// Only a table the plan names was read by the pass behind the view, which found the houses its records name. A
    /// table the plan stopped naming is read by no pass, so a late record of a house the plan has no word of is folded
    /// without it and nothing says so: nothing new is shown of such a table. What was shown of it before stays as it
    /// was (it holds against an answer of the same frame, made with the same houses and pins, and while the pins and
    /// the delegations stand where they stood), and any other answer is held against nothing.
    fn confirm<L: Launch>(&mut self, view: &FoldView, inputs: &Inputs, sup: &Supervisor<L>, pins: u64, delegations: u64) {
        let tables: Vec<TableKey> = self.mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).collect();
        for key in tables {
            // (A trim noted may have come before the pass behind the view, which then saw the room without the session.)
            if self.mirror.base_unread(&key.0, &key.1) {
                continue;
            }
            let Some(frame) = self.feed.answers(&key.0, &key.1, sup, inputs) else { continue };
            let Some(st) = self.mirror.state(&key.0, &key.1) else { continue };
            if view.tables.contains(&key) {
                self.confirmed.insert(key, Shown { born: st.born, frame, pins, delegations });
            }
        }
    }

    /// A table the plan stopped naming that was kept for the final checkpoint a page writes when it compacts it, whose
    /// [`GONE_GRACE`] is over and whose checkpoint did not come: given up on, and
    /// the comparison not made counted, once. (A checkpoint a page has written and the mirror has not read keeps its
    /// table whatever the time: `kept`.)
    fn expire(&mut self, now: Instant, view: &FoldView, tally: &mut Tally) {
        let due: Vec<TableKey> = self.gone.iter().filter(|(k, since)| !view.tables.contains(*k) && now.saturating_duration_since(**since) >= GONE_GRACE).map(|(k, _)| k.clone()).collect();
        for k in due {
            if self.mirror.base_unread(&k.0, &k.1) {
                continue;
            }
            self.gone.remove(&k);
            if self.mirror.state(&k.0, &k.1).is_some_and(|st| !st.ended) {
                tally.note(&Verdict::Skip(Skip::Expired));
                say(&mut self.said, false, format!("{}: skipped (expired: no final checkpoint in {} s)", tag(self.mirror.room(), &k.0, &k.1), GONE_GRACE.as_secs()));
            }
        }
    }

    /// The doc read, the worker's answers taken, the tables compared where a
    /// page's trim came. `keep`: the tables of this room that the view does not follow
    /// (it left the plan, or the cap has no place for it) and that are kept while their last
    /// checkpoint is not read. Nothing is sent to the worker but the word to let go of what
    /// the mirror lets go of; [`RoomShadow::send`] sends the rest.
    fn follow<L: Launch>(&mut self, now: Instant, doc: &Doc, view: &FoldView, keep: &BTreeSet<TableKey>, events: &[Event], sup: &mut Supervisor<L>, tally: &mut Tally) {
        self.feed.absorb(now, events);
        let inputs = Inputs::new(view.houses.clone(), view.pins.clone());
        // What the answers in hand cover, and were made with, before this tick's drain brings what a page wrote since.
        let covered = self.covered(&inputs, sup);
        let delegations = self.mirror.delegations();
        // (A delegation that changed since the last tick may not be in the plan yet: the house has had no pass since.)
        let moved = delegations.changes != self.seen_delegations;
        self.seen_delegations = delegations.changes;
        if view.settled && !delegations.churned && !moved {
            self.confirm(view, &inputs, sup, view.pins_epoch, delegations.changes);
        } else {
            // (What was shown before may be taken back: a key replaced, or a house not known, can bear on a session that was
            // followed all along. A settled tick shows it again, if it can be shown.)
            self.confirmed.clear();
        }
        // A table that has left the view (the page ended it) is read once more, so the checkpoint
        // that ended it is compared before the table is let go of.
        let mut read: Vec<TableKey> = self.mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).collect();
        read.extend(view.tables.iter().cloned());
        read.sort();
        read.dedup();
        self.mirror.want(&read);
        // (A room with no table has nothing to read: its doc is not taken for it.)
        if !read.is_empty() {
            let txn = doc.transact();
            self.mirror.drain(&txn);
        }
        // The pins and the delegations as the doc the drain read shows them: what moved since a table was shown whole takes it back.
        let pins = view.watch.as_ref().map_or(view.pins_epoch, PinWatch::epoch);
        self.compare(tally, &covered, pins, self.mirror.delegations().changes);
        // (After the comparison: a final checkpoint that came with the drain is compared before its table is given up on.)
        self.expire(now, view, tally);
        // The view's tables, and those that left it and are kept.
        let mut want: Vec<TableKey> = view.tables.clone();
        let outside: Vec<TableKey> = self.mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).chain(keep.iter().cloned()).collect();
        want.extend(outside.into_iter().filter(|k| !view.tables.contains(k) && self.kept(k, now)));
        want.sort();
        want.dedup();
        self.mirror.want(&want);
        self.gone.retain(|k, _| want.contains(k));
        self.feed.release(now, &self.mirror, sup);
        self.inputs = inputs;
        // (A room the house has a plan for stays, with its tables or none: what its mirror has seen of the delegations
        // is the room's history for as long as the plan lasts, and a table that comes later is compared with it.)
        self.leaving = false;
    }

    /// Let go of every table (the room is no longer followed).
    fn leave<L: Launch>(&mut self, now: Instant, events: &[Event], sup: &mut Supervisor<L>) {
        self.leaving = true;
        self.feed.absorb(now, events);
        self.mirror.want(&[]);
        self.gone.clear();
        self.feed.release(now, &self.mirror, sup);
        self.inputs = Inputs::default();
    }

    /// Send what has changed. `room` is the number of tables the worker has a place for that it does not hold yet,
    /// over all rooms (0 while it still owes a word of letting go somewhere): each one started takes one, and a
    /// table that would take more waits.
    fn send<L: Launch>(&mut self, clock: Clock<'_>, sup: &mut Supervisor<L>, room: &mut usize) {
        self.feed.push_clocked(clock, &mut self.mirror, sup, &self.inputs, room);
    }

    /// For each table whose mirror has a checkpoint the table was not
    /// compared with yet, and whose answer in hand was made before the
    /// mirror started over on it: the answer against the checkpoint, once.
    /// The answer is the one made before the trim; it is replaced when the
    /// table's new start is answered. A difference is only counted when the
    /// answer was made with houses and pins shown to be all the room held
    /// (`confirmed`, and neither the pins nor a delegation moved since), covered
    /// the table as the node had last read it (`covered`), and the node had
    /// read all a page wrote to the session before the trim
    /// (`State::unread_at_trim`); otherwise it could be the fold's lateness, or
    /// its lack of an input. A trim read when the fold has no answer from before
    /// it is counted as a comparison not made.
    fn compare(&mut self, tally: &mut Tally, covered: &BTreeSet<TableKey>, pins: u64, delegations: u64) {
        let RoomShadow { mirror, feed, compared, confirmed, said, .. } = self;
        let room = mirror.room().to_string();
        let keys: Vec<TableKey> = mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).collect();
        compared.retain(|k, _| keys.contains(k));
        confirmed.retain(|k, _| keys.contains(k));
        for key in keys {
            let (t, inc) = (&key.0, &key.1);
            // (What a line says of which table: the room too, since two rooms can hold the same table.)
            let at = || tag(&room, t, inc);
            // Checkpoints a page wrote and another page wrote over before the mirror read the table: the node never had
            // them, and each is counted as a comparison not made.
            let lost = mirror.take_superseded(t, inc);
            for _ in 0..lost {
                tally.note(&Verdict::Skip(Skip::Superseded));
            }
            if lost > 0 {
                say(said, false, format!("{}: skipped (superseded: {lost} checkpoint(s) written over before the node read them)", at()));
            }
            let Some(st) = mirror.state(t, inc) else { continue };
            let Some(cp) = st.base else {
                // A checkpoint this node cannot read as a page does (one heavier than a drain reads, or one a page may read
                // otherwise) holds the table and the mirror keeps none: a trim that brought one is counted, once, as a
                // comparison not made. (The first checkpoint a table is read with is no trim.)
                if st.hold == Some(Hold::Base) && st.trims > 0 {
                    let id = held_identity(st.born, st.trims);
                    if !seen(compared, &key, &id) {
                        remember(compared, &key, id);
                        tally.note(&Verdict::Skip(Skip::Unreadable));
                        say(said, false, format!("{}: skipped (unreadable: the checkpoint cannot be read as a page reads it)", at()));
                    }
                }
                continue;
            };
            let id = identity(cp);
            // The checkpoint a table is first read with is no trim: nothing was held against it, and however the table
            // starts over after (its session replaced, the worker lost it), no answer from before is its answer. It is
            // not compared, nor counted; it is remembered, so that a page that puts it back later does not have it
            // counted either.
            if st.trims == 0 {
                remember(compared, &key, id);
                continue;
            }
            if seen(compared, &key, &id) {
                continue;
            }
            let u = cp.get("u").and_then(CVal::as_int).unwrap_or(-1);
            let Some(fold) = feed.fold(t, inc).filter(|f| f.generation < st.generation) else {
                remember(compared, &key, id);
                tally.note(&Verdict::Skip(Skip::Unanswered));
                say(said, false, format!("{} u={u}: skipped (unanswered)", at()));
                continue;
            };
            remember(compared, &key, id);
            let mut verdict = compare(fold.summary, cp, inc);
            if matches!(verdict, Verdict::Agree | Verdict::Mismatch(_)) {
                let shown = Shown { born: st.born, frame: fold.frame, pins, delegations };
                if confirmed.get(&key) != Some(&shown) {
                    verdict = Verdict::Skip(Skip::Inputs);
                } else if st.unread_at_trim || !covered.contains(&key) {
                    verdict = Verdict::Skip(Skip::Stale);
                }
            }
            tally.note(&verdict);
            match &verdict {
                Verdict::Agree => eprintln!("🧮 fold-shadow {} u={u}: agrees with the checkpoint", at()),
                Verdict::Mismatch(why) => say(said, true, format!("{} u={u}: MISMATCH — {why}", at())),
                Verdict::Skip(why) => say(said, false, format!("{} u={u}: skipped ({})", at(), why.name())),
            }
        }
    }
}

/// Whether the table `key` has been compared with (or passed over, or first read with) the checkpoint `id`.
fn seen(compared: &BTreeMap<TableKey, VecDeque<[u8; 32]>>, key: &TableKey, id: &[u8; 32]) -> bool {
    compared.get(key).is_some_and(|ring| ring.contains(id))
}

/// Remember that the table `key` has been compared with the checkpoint `id`, the last [`COMPARED_HISTORY`] of them.
fn remember(compared: &mut BTreeMap<TableKey, VecDeque<[u8; 32]>>, key: &TableKey, id: [u8; 32]) {
    let ring = compared.entry(key.clone()).or_default();
    if ring.contains(&id) {
        return;
    }
    if ring.len() >= COMPARED_HISTORY {
        ring.pop_front();
    }
    ring.push_back(id);
}

/// The node's fold in shadow, over all the rooms it serves: one worker
/// (fold_supervisor.rs), and for each room it is a house of, a mirror of the
/// room's house tables (house_mirror.rs) and a feed to the worker
/// (fold_feed.rs), and a watch on the room's players (fold_pins.rs). It writes
/// nothing to any doc.
pub struct FoldShadow<L: Launch> {
    sup: Supervisor<L>,
    rooms: BTreeMap<String, RoomShadow>,
    /// The players of each room the house has a plan for, watched from the first plan on.
    pins: BTreeMap<String, PlayerPins>,
    /// The most players read of a players map when its watch starts ([`PIN_WALK_KEYS`]; less in the tests).
    pin_walk: usize,
    /// How long that read may hold the doc ([`PIN_WALK_TIME`]; no limit in the tests).
    pin_walk_time: Option<Duration>,
    /// What each room's mirror reads in a drain (the defaults; less in the tests).
    limits: Limits,
    /// The tables the worker holds ([`FOLD_TABLES`]; fewer in the tests).
    places: usize,
    tally: Tally,
    /// The last of what the comparisons said (the mismatches and the comparisons not made).
    log: Log,
    /// What the rooms let go of did.
    gone: Counts,
    /// Tables followed now, and tables the rooms have that are not followed
    /// because the worker has room for [`MAX_SHADOW_TABLES`] only.
    followed: u64,
    over: u64,
}

impl<L: Launch> FoldShadow<L> {
    pub fn new(launch: L, now: Instant) -> FoldShadow<L> {
        FoldShadow {
            sup: Supervisor::new(launch, now),
            rooms: BTreeMap::new(),
            pins: BTreeMap::new(),
            pin_walk: PIN_WALK_KEYS,
            pin_walk_time: None,
            limits: Limits::default(),
            places: FOLD_TABLES,
            tally: Tally::default(),
            log: Log::default(),
            gone: Counts::default(),
            followed: 0,
            over: 0,
        }
    }

    /// The node's own: [`FoldShadow::new`], with what it reads of a doc held to the times the house can wait
    /// for ([`DRAIN_TIME`](crate::house_mirror::DRAIN_TIME), [`PIN_WALK_TIME`]).
    pub fn live(launch: L, now: Instant) -> FoldShadow<L> {
        let mut shadow = FoldShadow::new(launch, now);
        shadow.limits = Limits::live();
        shadow.pin_walk_time = Some(PIN_WALK_TIME);
        shadow
    }

    /// The fold duties are off for good: nothing is followed or read.
    pub fn is_off(&self) -> bool {
        self.sup.off().is_some()
    }

    /// One tick, with every room the node serves: its doc, and what the house found there to
    /// follow (None: nothing, or it is no house there). The players of the rooms with a plan are
    /// watched here, under the shadow's own lock and not the house's.
    pub fn tick_plans(&mut self, now: Instant, plans: Vec<(String, Doc, Option<HousePlan>)>) {
        self.tick_plans_with(&|| now, plans)
    }

    /// [`FoldShadow::tick_plans`], at the time `clock` says each time it is asked (see [`Clock`]).
    pub fn tick_plans_with(&mut self, clock: Clock<'_>, plans: Vec<(String, Doc, Option<HousePlan>)>) {
        if self.is_off() {
            self.pins.clear();
            self.tick_with(clock, Vec::new());
            return;
        }
        let listed: BTreeSet<&String> = plans.iter().map(|p| &p.0).collect();
        self.pins.retain(|room, _| listed.contains(room));
        let walk = self.pin_walk;
        let rooms: Vec<(String, Doc, Option<FoldView>)> = plans
            .into_iter()
            .map(|(room, doc, plan)| {
                let view = plan.map(|plan| self.view_of(&room, &doc, plan, walk));
                (room, doc, view)
            })
            .collect();
        self.tick_with(clock, rooms);
    }

    /// The view of a room with a plan: the plan's tables and houses, the pins as the shadow's own watch of the
    /// players has them, the epoch they stand at, and the watch to ask where they stand later (the watch of a
    /// room starts with its first plan).
    fn view_of(&mut self, room: &str, doc: &Doc, plan: HousePlan, walk: usize) -> FoldView {
        let walk_time = self.pin_walk_time;
        let watched = self.pins.entry(room.to_string()).or_insert_with(|| PlayerPins::attach_timed(doc, walk, walk_time));
        let watch = watched.watch();
        let (pins, pins_settled, pins_epoch, deed) = watched.view_full();
        // (The houses of a plan are the ones its deed holder delegated: they are the room's houses only while the doc
        // names that holder. A holder who changed since the pass read the room, or since the epoch was read, shows
        // nothing whole; one who changes after moves the epoch.)
        // (And the key the watch has pinned for that holder is the key the pass pinned: the houses are the ones that
        // key delegated.)
        let held = deed.as_deref() == Some(plan.owner.as_str()) && pins.iter().any(|(pid, key)| *pid == plan.owner && *key == plan.owner_key);
        FoldView { tables: plan.tables, houses: plan.houses, pins, settled: plan.complete && pins_settled && held, pins_epoch, watch: Some(watch) }
    }

    /// One tick, with every room the node serves: its doc, and what to follow there (None:
    /// nothing, or it is no house there).
    ///
    /// In two parts, so that the worker, which holds so many tables, is told to let go of the
    /// ones to go (of every room) before it is asked to take one that is new: first each room's
    /// answers are taken, its tables compared and the word to let go of tables sent; then each
    /// room's changes. A word the worker was too busy to take holds the new tables back.
    pub fn tick(&mut self, now: Instant, rooms: Vec<(String, Doc, Option<FoldView>)>) {
        self.tick_with(&|| now, rooms)
    }

    /// [`FoldShadow::tick`], at the time `clock` says each time it is asked (see [`Clock`]): the worker is polled
    /// at the time of the poll, and what is asked of it is posted at the time it is.
    pub fn tick_with(&mut self, clock: Clock<'_>, mut rooms: Vec<(String, Doc, Option<FoldView>)>) {
        if self.sup.off().is_some() {
            // The fold duties are off for good: nothing is followed (the worker is gone).
            for (_, rs) in std::mem::take(&mut self.rooms) {
                self.gone = self.gone.plus(rs.feed.counts());
            }
            self.followed = 0;
            return;
        }
        let events = self.sup.poll(clock());
        let now = clock();
        rooms.sort_by(|a, b| a.0.cmp(&b.0));
        // The tables kept after the view lets them go (their last checkpoint not read yet, or the plan stopped naming
        // them, which the pages count as ended, and the checkpoint of their compaction may yet come) keep their places
        // in the worker.
        let mut keep: BTreeMap<String, BTreeSet<TableKey>> = BTreeMap::new();
        for (room, _, view) in &rooms {
            if let (Some(view), Some(rs)) = (view, self.rooms.get_mut(room)) {
                rs.note_gone(view, now);
                keep.insert(room.clone(), rs.outgoing(view, now));
            }
        }
        // The worker holds MAX_SHADOW_TABLES: the first of the rest in room and table order are
        // followed, so the same tables are while the rooms stay as they are. A table the cap has no place
        // for and whose checkpoint a page has written and the mirror has not read is kept too, and its place
        // is taken from the others, which may put another out: until no more is. (`base_unread` is false for a
        // table the mirror does not hold: one never followed is not reserved.)
        let order: Vec<(String, TableKey)> = rooms.iter().flat_map(|(room, _, view)| view.iter().flat_map(move |v| v.tables.iter().map(move |k| (room.clone(), k.clone())))).collect();
        let mut reserved: usize = keep.values().map(BTreeSet::len).sum();
        let allowance = loop {
            let allowance = MAX_SHADOW_TABLES.saturating_sub(reserved);
            let mut grew = false;
            for (room, k) in order.iter().skip(allowance) {
                let Some(rs) = self.rooms.get(room) else { continue };
                if rs.mirror.base_unread(&k.0, &k.1) && keep.entry(room.clone()).or_default().insert(k.clone()) {
                    reserved += 1;
                    grew = true;
                }
            }
            if !grew {
                break allowance;
            }
        };
        let (mut room_left, mut over) = (allowance, 0u64);
        for (_, _, view) in rooms.iter_mut() {
            if let Some(view) = view {
                let kept = view.tables.len().min(room_left);
                over += (view.tables.len() - kept) as u64;
                view.tables.truncate(kept);
                room_left -= kept;
            }
        }
        self.over = over;
        let none = BTreeSet::new();
        let mut listed = BTreeSet::new();
        for (room, doc, view) in rooms {
            listed.insert(room.clone());
            match view {
                // (A room the house has a plan for is watched from its first plan, with a table or none: what its mirror
                // sees of the delegations is read against every table that comes.)
                Some(view) => {
                    let rs = self.rooms.entry(room.clone()).or_insert_with(|| RoomShadow::attach(&doc, &room, self.limits));
                    rs.follow(clock(), &doc, &view, keep.get(&room).unwrap_or(&none), &events, &mut self.sup, &mut self.tally);
                    for (mismatch, line) in std::mem::take(&mut rs.said) {
                        self.log.push(mismatch, line);
                    }
                }
                None => {
                    if let Some(rs) = self.rooms.get_mut(&room) {
                        rs.leave(clock(), &events, &mut self.sup);
                    }
                }
            }
        }
        for (room, rs) in self.rooms.iter_mut() {
            if !listed.contains(room) {
                rs.leave(clock(), &events, &mut self.sup);
            }
        }
        // The tables followed are the ones the mirrors hold now, after the follow and the release: those the plan names and
        // those kept for a checkpoint that may yet come (a place of the worker's each, whatever the plan says).
        self.followed = self.rooms.values().map(|rs| rs.mirror.tables().count() as u64).sum();
        // The worker holds `places` tables (FOLD_TABLES), whatever the shadow meant to follow: a table kept after the view let it go, because
        // its checkpoint came after the places were counted, is held all the same. A table it does not hold yet waits
        // for a place, and takes it when those are let go of (their checkpoints compared on a later tick).
        let held: usize = self.rooms.values().map(|rs| rs.feed.holds()).sum();
        let mut room = if self.rooms.values().any(|rs| rs.feed.owes_forget()) { 0 } else { self.places.saturating_sub(held) };
        for rs in self.rooms.values_mut() {
            rs.send(clock, &mut self.sup, &mut room);
        }
        // A room let go of goes once the worker has been told of every table.
        let done: Vec<String> = self.rooms.iter().filter(|(_, rs)| rs.leaving && rs.feed.is_idle()).map(|(r, _)| r.clone()).collect();
        for room in done {
            if let Some(rs) = self.rooms.remove(&room) {
                self.gone = self.gone.plus(rs.feed.counts());
            }
        }
    }

    pub fn tally(&self) -> Tally {
        self.tally
    }

    /// The tables the worker holds (or is owed a word of letting go of), over all rooms: never more than it has
    /// places for.
    pub fn holds(&self) -> usize {
        self.rooms.values().map(|rs| rs.feed.holds()).sum()
    }

    /// The feed's counts over all rooms, those let go of included.
    pub fn counts(&self) -> Counts {
        self.rooms.values().fold(self.gone, |c, rs| c.plus(rs.feed.counts()))
    }

    /// `/api/fingerprint`'s `houseFold`.
    pub fn report(&self) -> HouseFoldReport {
        let c = self.counts();
        let (started, failures) = self.sup.counts();
        HouseFoldReport {
            rules: ["r", "d"].iter().filter_map(|l| rules_id(l).map(|r| (l.to_string(), r.to_string()))).collect(),
            letters: "rd".to_string(),
            attest: false,
            shadow_agreed: self.tally.agree,
            shadow_mismatches: self.tally.mismatch,
            shadow_skipped: self.tally.skipped(),
            cold_folds: c.cold,
            dirty: c.dirty,
            lost: c.lost,
            bad_results: c.bad_results + c.too_big,
            worker_starts: started,
            worker_restarts: started.saturating_sub(1),
            worker_failures: failures,
            rooms: self.rooms.len() as u64,
            tables: self.followed,
            tables_over: self.over,
            off: self.sup.off().map(str::to_string),
            recent_mismatches: self.log.mismatches.iter().cloned().collect(),
            recent_skips: self.log.skips.iter().cloned().collect(),
        }
    }
}

/// One tick of the shadow over `docs` (every room the node serves): what
/// `plan_of` finds for each room (under the house's lock: it copies, and reads
/// no doc), then the shadow's pass, which watches the players of those rooms
/// and reads the rest under its own. Its report, or None if it panicked (a
/// panic costs the shadow its tick and nothing else). With the fold duties off
/// for good nothing is asked of any room.
pub fn tick_shadow<L: Launch>(shadow: &std::sync::Mutex<FoldShadow<L>>, docs: Vec<(String, Doc)>, now: Instant, plan_of: impl FnMut(&str) -> Option<HousePlan>) -> Option<HouseFoldReport> {
    tick_shadow_with(shadow, docs, &|| now, plan_of)
}

/// [`tick_shadow`], at the time `clock` says each time it is asked: a pass can take longer than the worker's wait for an
/// answer (a lock waited for, a plan, the watch of a room's players, the drains), so the time it began is no time to
/// post a request by or to judge a silence by.
pub fn tick_shadow_with<L: Launch>(shadow: &std::sync::Mutex<FoldShadow<L>>, docs: Vec<(String, Doc)>, clock: Clock<'_>, mut plan_of: impl FnMut(&str) -> Option<HousePlan>) -> Option<HouseFoldReport> {
    let lock = || shadow.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        {
            let mut off = lock();
            if off.is_off() {
                off.tick_plans_with(clock, Vec::new());
                return off.report();
            }
        }
        let plans: Vec<(String, Doc, Option<HousePlan>)> = docs
            .into_iter()
            .map(|(room, doc)| {
                let plan = plan_of(&room);
                (room, doc, plan)
            })
            .collect();
        let mut shadow = lock();
        shadow.tick_plans_with(clock, plans);
        shadow.report()
    }))
    .ok()
}

#[cfg(test)]
mod tests;
