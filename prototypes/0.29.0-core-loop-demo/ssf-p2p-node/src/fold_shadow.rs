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
//! one put back), or its fold is not finished (signatures left unchecked).
//! Those are skipped, and counted by why.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use yrs::{Doc, Transact};

use crate::fold_feed::{Counts, Feed, Inputs};
use crate::fold_supervisor::{Event, Launch, Supervisor};
use crate::house::{checkpoint_ok, FoldView};
use crate::house_bytes::{self as hb, CVal};
use crate::house_fold::{rules_id, FoldSummary};
use crate::house_mirror::RoomMirror;
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
}

impl Skip {
    pub fn name(self) -> &'static str {
        match self {
            Skip::Past => "past",
            Skip::Behind => "behind",
            Skip::Big => "big",
            Skip::Unreadable => "unreadable",
            Skip::Pending => "pending",
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

    // The decided rounds after the base, up to u.
    let mut nets = match nets_of(base.n.iter().cloned()) {
        Ok(m) => m,
        Err(s) => return Verdict::Skip(s),
    };
    let mut at_u = None;
    for r in (base.u + 1)..=u {
        let Some(round) = summary.rounds.iter().find(|x| x.r == r).filter(|x| x.decided.is_some()) else {
            return Verdict::Skip(Skip::Behind);
        };
        match nets_of(nets.iter().map(|(p, n)| (p.clone(), n.to_string())).chain(round.deltas.iter().cloned())) {
            Ok(m) => nets = m,
            Err(s) => return Verdict::Skip(s),
        }
        if r == u {
            at_u = Some(round);
        }
    }
    let Some(round) = at_u else { return Verdict::Skip(Skip::Behind) };

    // The nets.
    let Some(entries) = cp.get("n").and_then(CVal::entries) else { return Verdict::Skip(Skip::Unreadable) };
    let theirs = match nets_of(entries.iter().filter_map(|(p, x)| x.as_str().map(|x| (p.clone(), x.to_string())))) {
        Ok(m) => m,
        Err(s) => return Verdict::Skip(s),
    };
    if theirs != nets {
        return Verdict::Mismatch(format!("n through round {u}: the fold has [{}], the checkpoint [{}]", show(&nets), show(&theirs)));
    }

    // The close of round u.
    if cp.get("l").and_then(CVal::as_str) != Some(round.close.as_str()) {
        return Verdict::Mismatch(format!("l: round {u} closed as {} in the fold, the checkpoint says {:?}", round.close, cp.get("l").and_then(CVal::as_str)));
    }

    // The state after the last round decided, when u is it.
    let later = summary.rounds.iter().any(|x| x.r > u && x.decided.is_some());
    let ended = cp.get("e").is_some();
    if !later && !ended {
        if cp.get("h").and_then(CVal::as_str) != summary.required.as_deref() {
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
        }
    }
}

/// One room the shadow follows: its mirror (an observer on the room's doc) and
/// its feed to the worker.
struct RoomShadow {
    mirror: RoomMirror,
    feed: Feed,
    /// The mirror generation each table was last compared at (or passed over:
    /// a comparison is made once for a start over).
    compared: BTreeMap<(String, String), u64>,
    /// The room is no longer followed: its tables are being let go of.
    leaving: bool,
}

impl RoomShadow {
    fn attach(doc: &Doc, room: &str) -> RoomShadow {
        RoomShadow { mirror: RoomMirror::attach(doc, room), feed: Feed::new(room), compared: BTreeMap::new(), leaving: false }
    }

    /// The doc read, the worker's answers taken, the tables compared where a
    /// page's trim came, the changes sent.
    fn follow<L: Launch>(&mut self, now: Instant, doc: &Doc, view: &FoldView, events: &[Event], sup: &mut Supervisor<L>, tally: &mut Tally) {
        self.leaving = false;
        self.feed.absorb(now, events);
        self.mirror.want(&view.tables);
        {
            let txn = doc.transact();
            self.mirror.drain(&txn);
        }
        self.compare(tally);
        self.feed.push(now, &mut self.mirror, sup, &Inputs::new(view.houses.clone(), view.pins.clone()));
    }

    /// Let go of every table (the room is no longer followed).
    fn leave<L: Launch>(&mut self, now: Instant, events: &[Event], sup: &mut Supervisor<L>) {
        self.leaving = true;
        self.feed.absorb(now, events);
        self.mirror.want(&[]);
        self.feed.push(now, &mut self.mirror, sup, &Inputs::default());
    }

    /// For each table whose mirror started over on a checkpoint (its base
    /// is the page's trim) since the answer in hand was made: the answer
    /// against the checkpoint, once. The answer is the one made before the
    /// trim; it is replaced when the table's new start is answered.
    fn compare(&mut self, tally: &mut Tally) {
        let RoomShadow { mirror, feed, compared, .. } = self;
        let keys: Vec<(String, String)> = mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).collect();
        compared.retain(|k, _| keys.contains(k));
        for key in keys {
            let (t, inc) = (&key.0, &key.1);
            let Some(st) = mirror.state(t, inc) else { continue };
            let Some(cp) = st.base else { continue };
            let Some(fold) = feed.fold(t, inc) else { continue };
            if fold.generation >= st.generation || compared.get(&key) == Some(&st.generation) {
                continue;
            }
            compared.insert(key.clone(), st.generation);
            let verdict = compare(fold.summary, cp, inc);
            tally.note(&verdict);
            let u = cp.get("u").and_then(CVal::as_int).unwrap_or(-1);
            match &verdict {
                Verdict::Agree => eprintln!("🧮 fold-shadow {t} {inc} u={u}: agrees with the checkpoint"),
                Verdict::Mismatch(why) => eprintln!("🧮 fold-shadow {t} {inc} u={u}: MISMATCH — {why}"),
                Verdict::Skip(Skip::Past) => {}
                Verdict::Skip(why) => eprintln!("🧮 fold-shadow {t} {inc} u={u}: skipped ({})", why.name()),
            }
        }
    }
}

/// The node's fold in shadow, over all the rooms it serves: one worker
/// (fold_supervisor.rs), and for each room it is a house of, a mirror of the
/// room's house tables (house_mirror.rs) and a feed to the worker
/// (fold_feed.rs). It writes nothing to any doc.
pub struct FoldShadow<L: Launch> {
    sup: Supervisor<L>,
    rooms: BTreeMap<String, RoomShadow>,
    tally: Tally,
    /// What the rooms let go of did.
    gone: Counts,
}

impl<L: Launch> FoldShadow<L> {
    pub fn new(launch: L, now: Instant) -> FoldShadow<L> {
        FoldShadow { sup: Supervisor::new(launch, now), rooms: BTreeMap::new(), tally: Tally::default(), gone: Counts::default() }
    }

    /// One tick, with every room the node serves: its doc, and what the house
    /// found there to follow (None: nothing, or it is no house there).
    pub fn tick(&mut self, now: Instant, rooms: Vec<(String, Doc, Option<FoldView>)>) {
        if self.sup.off().is_some() {
            // The fold duties are off for good: nothing is followed (the worker is gone).
            for (_, rs) in std::mem::take(&mut self.rooms) {
                self.gone = self.gone.plus(rs.feed.counts());
            }
            return;
        }
        let events = self.sup.poll(now);
        let mut listed = BTreeSet::new();
        for (room, doc, view) in rooms {
            listed.insert(room.clone());
            match view {
                Some(view) => {
                    let rs = self.rooms.entry(room.clone()).or_insert_with(|| RoomShadow::attach(&doc, &room));
                    rs.follow(now, &doc, &view, &events, &mut self.sup, &mut self.tally);
                }
                None => {
                    if let Some(rs) = self.rooms.get_mut(&room) {
                        rs.leave(now, &events, &mut self.sup);
                    }
                }
            }
        }
        for (room, rs) in self.rooms.iter_mut() {
            if !listed.contains(room) {
                rs.leave(now, &events, &mut self.sup);
            }
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
            shadow_skipped: self.tally.past + self.tally.behind + self.tally.big + self.tally.unreadable + self.tally.pending,
            cold_folds: c.cold,
            dirty: c.dirty,
            lost: c.lost,
            bad_results: c.bad_results + c.too_big,
            worker_starts: started,
            worker_restarts: started.saturating_sub(1),
            worker_failures: failures,
            rooms: self.rooms.len() as u64,
            off: self.sup.off().map(str::to_string),
        }
    }
}

/// One tick of the shadow over `docs` (every room the node serves): what
/// `view_of` finds for each room to follow, then the shadow's pass. Its report,
/// or None if it panicked (a panic costs the shadow its tick and nothing else).
pub fn tick_shadow<L: Launch>(
    shadow: &std::sync::Mutex<FoldShadow<L>>,
    docs: Vec<(String, Doc)>,
    now: Instant,
    mut view_of: impl FnMut(&str, &Doc) -> Option<FoldView>,
) -> Option<HouseFoldReport> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let rooms: Vec<(String, Doc, Option<FoldView>)> = docs
            .into_iter()
            .map(|(room, doc)| {
                let view = view_of(&room, &doc);
                (room, doc, view)
            })
            .collect();
        let mut shadow = shadow.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        shadow.tick(now, rooms);
        shadow.report()
    }))
    .ok()
}

#[cfg(test)]
mod tests;
