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
//! everything the room held while the session was in it. Those are skipped,
//! and counted by why.

#![cfg(feature = "house-fold")]
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use yrs::{Doc, Transact};

use crate::fold_feed::{Counts, Feed, Inputs};
use crate::fold_pins::{PlayerPins, PIN_WALK_KEYS};
use crate::fold_supervisor::{Event, Launch, Supervisor};
use crate::house::{checkpoint_ok, HousePlan};
use crate::house_bytes::{self as hb, CVal};
use crate::house_fold::{rules_id, FoldSummary, FOLD_TABLES};
use crate::house_mirror::{Limits, RoomMirror};
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
    pub parent: u64,
    pub stale: u64,
    pub inputs: u64,
}

impl Tally {
    /// Every comparison not made.
    pub fn skipped(&self) -> u64 {
        self.past + self.behind + self.big + self.unreadable + self.pending + self.parent + self.stale + self.inputs
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

/// One room the shadow follows: its mirror (an observer on the room's doc) and
/// its feed to the worker.
struct RoomShadow {
    mirror: RoomMirror,
    feed: Feed,
    /// The checkpoint (its canonical bytes' hash) each table was last
    /// compared with, or passed over: a checkpoint is compared once, whatever
    /// else starts the table over.
    compared: BTreeMap<TableKey, [u8; 32]>,
    /// For each table, the answer (which taking up of the table, which frame)
    /// that was shown to have been made with every house and pin the room held
    /// while the session was still in it: at a tick when the view was
    /// settled, no trim had been noted yet (so the pass behind the view saw
    /// the session), and the answer was of the last frame sent, with the
    /// view's houses and pins. A trim removes the session, so only what was
    /// shown before it can be shown.
    confirmed: BTreeMap<TableKey, (u64, u64)>,
    /// The houses and pins of the last tick, for the push.
    inputs: Inputs,
    /// The room is no longer followed: its tables are being let go of.
    leaving: bool,
}

/// A checkpoint's identity: the hash of its canonical bytes.
fn identity(cp: &CVal) -> [u8; 32] {
    hb::sha256(hb::canon(cp).unwrap_or_default().as_bytes())
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
            leaving: false,
        }
    }

    /// The tables the mirror holds that the view does not follow and whose last checkpoint it
    /// has not read yet: a page ended them (or trimmed them) since the last drain. They are
    /// kept until a drain has read it, however many ticks that takes, so that their last
    /// checkpoint is compared (or passed over and counted) before they are let go of.
    fn outgoing(&self, view: &FoldView) -> BTreeSet<TableKey> {
        self.mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).filter(|k| !view.tables.contains(k) && self.mirror.base_unread(&k.0, &k.1)).collect()
    }

    /// The tables whose answer, as the tick begins, is the table as the mirror
    /// last read it, with the room's inputs as they are now ([`Feed::covers`]).
    fn covered<L: Launch>(&self, inputs: &Inputs, sup: &Supervisor<L>) -> BTreeSet<TableKey> {
        self.mirror.tables().filter(|c| self.feed.covers(&c.t, &c.inc, &self.mirror, sup, inputs)).map(|c| (c.t.clone(), c.inc.clone())).collect()
    }

    /// Note the tables whose answer was made with the houses and pins of a settled view, while
    /// the session was still in the room: before the drain, where no trim of the table has
    /// been noted.
    fn confirm<L: Launch>(&mut self, inputs: &Inputs, sup: &Supervisor<L>) {
        let tables: Vec<TableKey> = self.mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).collect();
        for key in tables {
            // (A trim noted may have come before the pass behind the view, which then saw the room without the session.)
            if self.mirror.base_unread(&key.0, &key.1) {
                continue;
            }
            let Some(frame) = self.feed.answers(&key.0, &key.1, sup, inputs) else { continue };
            let Some(st) = self.mirror.state(&key.0, &key.1) else { continue };
            self.confirmed.insert(key, (st.born, frame));
        }
    }

    /// The doc read, the worker's answers taken, the tables compared where a
    /// page's trim came. `keep`: the tables this room has that the view no longer
    /// follows and that are kept until their last checkpoint is read. Nothing is
    /// sent to the worker but the word to let go of what the mirror lets go of;
    /// [`RoomShadow::send`] sends the rest.
    fn follow<L: Launch>(&mut self, now: Instant, doc: &Doc, view: &FoldView, keep: &BTreeSet<TableKey>, events: &[Event], sup: &mut Supervisor<L>, tally: &mut Tally) {
        self.feed.absorb(now, events);
        let inputs = Inputs::new(view.houses.clone(), view.pins.clone());
        // What the answers in hand cover, and were made with, before this tick's drain brings what a page wrote since.
        let covered = self.covered(&inputs, sup);
        if view.settled {
            self.confirm(&inputs, sup);
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
        {
            let txn = doc.transact();
            self.mirror.drain(&txn);
        }
        self.compare(tally, &covered);
        // The view's tables, and those that left it whose checkpoint a short drain has not got to.
        let mut want: Vec<TableKey> = view.tables.clone();
        want.extend(keep.iter().filter(|k| self.mirror.base_unread(&k.0, &k.1)).cloned());
        want.sort();
        want.dedup();
        self.mirror.want(&want);
        self.feed.release(now, &self.mirror, sup);
        self.inputs = inputs;
        // (A room with no table left goes once the worker has been told of the last.)
        self.leaving = want.is_empty();
    }

    /// Let go of every table (the room is no longer followed).
    fn leave<L: Launch>(&mut self, now: Instant, events: &[Event], sup: &mut Supervisor<L>) {
        self.leaving = true;
        self.feed.absorb(now, events);
        self.mirror.want(&[]);
        self.feed.release(now, &self.mirror, sup);
        self.inputs = Inputs::default();
    }

    /// Send what has changed. `allow_new` false: the worker still owes a word of letting go
    /// somewhere, so a table it does not hold yet waits.
    fn send<L: Launch>(&mut self, now: Instant, sup: &mut Supervisor<L>, allow_new: bool) {
        self.feed.push_with(now, &mut self.mirror, sup, &self.inputs, allow_new);
    }

    /// For each table whose mirror has a checkpoint the table was not
    /// compared with yet, and whose answer in hand was made before the
    /// mirror started over on it: the answer against the checkpoint, once.
    /// The answer is the one made before the trim; it is replaced when the
    /// table's new start is answered. A difference is only counted when the
    /// answer was made with houses and pins shown to be all the room held
    /// (`confirmed`), covered the table as the node had last read it
    /// (`covered`), and the node had read all a page wrote to the session
    /// before the trim (`State::unread_at_trim`); otherwise it could be the
    /// fold's lateness, or its lack of an input.
    fn compare(&mut self, tally: &mut Tally, covered: &BTreeSet<TableKey>) {
        let RoomShadow { mirror, feed, compared, confirmed, .. } = self;
        let keys: Vec<TableKey> = mirror.tables().map(|c| (c.t.clone(), c.inc.clone())).collect();
        compared.retain(|k, _| keys.contains(k));
        confirmed.retain(|k, _| keys.contains(k));
        for key in keys {
            let (t, inc) = (&key.0, &key.1);
            let Some(st) = mirror.state(t, inc) else { continue };
            let Some(cp) = st.base else { continue };
            let Some(fold) = feed.fold(t, inc) else { continue };
            if fold.generation >= st.generation {
                continue;
            }
            let id = identity(cp);
            if compared.get(&key) == Some(&id) {
                continue;
            }
            compared.insert(key.clone(), id);
            let mut verdict = compare(fold.summary, cp, inc);
            if matches!(verdict, Verdict::Agree | Verdict::Mismatch(_)) {
                if confirmed.get(&key) != Some(&(st.born, fold.frame)) {
                    verdict = Verdict::Skip(Skip::Inputs);
                } else if st.unread_at_trim || !covered.contains(&key) {
                    verdict = Verdict::Skip(Skip::Stale);
                }
            }
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
/// (fold_feed.rs), and a watch on the room's players (fold_pins.rs). It writes
/// nothing to any doc.
pub struct FoldShadow<L: Launch> {
    sup: Supervisor<L>,
    rooms: BTreeMap<String, RoomShadow>,
    /// The players of each room the house has a plan for, watched from the first plan on.
    pins: BTreeMap<String, PlayerPins>,
    /// The most players read of a players map when its watch starts ([`PIN_WALK_KEYS`]; less in the tests).
    pin_walk: usize,
    /// What each room's mirror reads in a drain (the defaults; less in the tests).
    limits: Limits,
    tally: Tally,
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
            limits: Limits::default(),
            tally: Tally::default(),
            gone: Counts::default(),
            followed: 0,
            over: 0,
        }
    }

    /// The fold duties are off for good: nothing is followed or read.
    pub fn is_off(&self) -> bool {
        self.sup.off().is_some()
    }

    /// One tick, with every room the node serves: its doc, and what the house found there to
    /// follow (None: nothing, or it is no house there). The players of the rooms with a plan are
    /// watched here, under the shadow's own lock and not the house's.
    pub fn tick_plans(&mut self, now: Instant, plans: Vec<(String, Doc, Option<HousePlan>)>) {
        if self.is_off() {
            self.pins.clear();
            self.tick(now, Vec::new());
            return;
        }
        let listed: BTreeSet<&String> = plans.iter().map(|p| &p.0).collect();
        self.pins.retain(|room, _| listed.contains(room));
        let walk = self.pin_walk;
        let rooms: Vec<(String, Doc, Option<FoldView>)> = plans
            .into_iter()
            .map(|(room, doc, plan)| {
                let view = plan.map(|plan| {
                    let (pins, pins_settled) = self.pins.entry(room.clone()).or_insert_with(|| PlayerPins::attach(&doc, walk)).view();
                    FoldView { tables: plan.tables, houses: plan.houses, pins, settled: plan.complete && pins_settled }
                });
                (room, doc, view)
            })
            .collect();
        self.tick(now, rooms);
    }

    /// One tick, with every room the node serves: its doc, and what to follow there (None:
    /// nothing, or it is no house there).
    ///
    /// In two parts, so that the worker, which holds so many tables, is told to let go of the
    /// ones to go (of every room) before it is asked to take one that is new: first each room's
    /// answers are taken, its tables compared and the word to let go of tables sent; then each
    /// room's changes. A word the worker was too busy to take holds the new tables back.
    pub fn tick(&mut self, now: Instant, mut rooms: Vec<(String, Doc, Option<FoldView>)>) {
        if self.sup.off().is_some() {
            // The fold duties are off for good: nothing is followed (the worker is gone).
            for (_, rs) in std::mem::take(&mut self.rooms) {
                self.gone = self.gone.plus(rs.feed.counts());
            }
            self.followed = 0;
            return;
        }
        let events = self.sup.poll(now);
        rooms.sort_by(|a, b| a.0.cmp(&b.0));
        // The tables kept a while after the view lets them go (their last checkpoint not read yet)
        // keep their places in the worker.
        let mut keep: BTreeMap<String, BTreeSet<TableKey>> = BTreeMap::new();
        let mut reserved = 0usize;
        for (room, _, view) in &rooms {
            if let (Some(view), Some(rs)) = (view, self.rooms.get(room)) {
                let kept = rs.outgoing(view);
                reserved += kept.len();
                keep.insert(room.clone(), kept);
            }
        }
        // The worker holds MAX_SHADOW_TABLES: the first of the rest in room and table order are
        // followed, so the same tables are while the rooms stay as they are.
        let allowance = MAX_SHADOW_TABLES.saturating_sub(reserved);
        let (mut room_left, mut over) = (allowance, 0u64);
        for (_, _, view) in rooms.iter_mut() {
            if let Some(view) = view {
                let kept = view.tables.len().min(room_left);
                over += (view.tables.len() - kept) as u64;
                view.tables.truncate(kept);
                room_left -= kept;
            }
        }
        self.followed = (allowance - room_left) as u64;
        self.over = over;
        let none = BTreeSet::new();
        let mut listed = BTreeSet::new();
        for (room, doc, view) in rooms {
            listed.insert(room.clone());
            match view {
                // (A room with no table, and none followed, has nothing to read.)
                Some(view) if view.tables.is_empty() && !self.rooms.contains_key(&room) => {}
                Some(view) => {
                    let rs = self.rooms.entry(room.clone()).or_insert_with(|| RoomShadow::attach(&doc, &room, self.limits));
                    rs.follow(now, &doc, &view, keep.get(&room).unwrap_or(&none), &events, &mut self.sup, &mut self.tally);
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
        let allow_new = !self.rooms.values().any(|rs| rs.feed.owes_forget());
        for rs in self.rooms.values_mut() {
            rs.send(now, &mut self.sup, allow_new);
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
        }
    }
}

/// One tick of the shadow over `docs` (every room the node serves): what
/// `plan_of` finds for each room (under the house's lock: it copies, and reads
/// no doc), then the shadow's pass, which watches the players of those rooms
/// and reads the rest under its own. Its report, or None if it panicked (a
/// panic costs the shadow its tick and nothing else). With the fold duties off
/// for good nothing is asked of any room.
pub fn tick_shadow<L: Launch>(
    shadow: &std::sync::Mutex<FoldShadow<L>>,
    docs: Vec<(String, Doc)>,
    now: Instant,
    mut plan_of: impl FnMut(&str) -> Option<HousePlan>,
) -> Option<HouseFoldReport> {
    let lock = || shadow.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        {
            let mut off = lock();
            if off.is_off() {
                off.tick_plans(now, Vec::new());
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
        shadow.tick_plans(now, plans);
        shadow.report()
    }))
    .ok()
}

#[cfg(test)]
mod tests;
