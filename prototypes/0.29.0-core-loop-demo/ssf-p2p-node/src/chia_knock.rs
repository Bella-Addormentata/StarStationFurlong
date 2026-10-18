//! #231 P6b: the KNOCK BOOK — what this node knocked for (the joiner's side),
//! what it read from its own inbox (the host's side) — and the rendezvous
//! schedule both sides dial on.
//!
//! A knock is a record (kind 2, `chia_lane::KnockV2`) a joiner J writes for a
//! host H it could not reach: after the direct dial ladder AND the hold on H's
//! own presence addresses failed, once per (J, H) per era. It rides sealed to
//! H's contact-card key under H's INBOX hint for the room's lane, so only H
//! learns that J wants in, and which room (named by a lane id, never by its
//! id). The chain is then the shared clock: the block that CONFIRMED the knock,
//! `h`, is read by both off the knock's own coin under H's inbox hint (J finds
//! it as the child of the coin it spent), and both dial at the same heights
//! after it — `h + 10n` for
//! n = 1..6 (twenty minutes of near-continuous holds, since a hold window is
//! about ten blocks long), then every tenth beat (320 blocks) for the rest of
//! two eras — so a hold started on one side meets a hold started on the other
//! and the two NATs are open at once. The first link ends the dance: a
//! connected target is never dialed. No further spend: the schedule is
//! derived from `h`, never written.
#![cfg(feature = "chia-read")]

use std::collections::VecDeque;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::chia_lane::{era_of, ERA_BLOCKS};
use crate::chia_watch::DEFAULT_BEAT_BLOCKS;

/// Beside the other node files, 0600 like them.
pub const KNOCKS_FILE: &str = "knocks.json";
/// The near-term rendezvous: a boundary every this many blocks after the
/// confirmation height, this many times (about twenty minutes).
pub const RENDEZVOUS_NEAR_STEP: u32 = 10;
pub const RENDEZVOUS_NEAR_COUNT: u32 = 6;
/// Then every tenth beat for the rest of the span.
pub const RENDEZVOUS_FAR_STEP: u32 = 10 * DEFAULT_BEAT_BLOCKS;
/// How long after its confirmation a knock is dialed on: two eras, the
/// record's own validity.
pub const RENDEZVOUS_SPAN: u32 = 2 * ERA_BLOCKS;
/// Entries kept per side, oldest first out.
pub const MAX_SENT: usize = 256;
pub const MAX_INBOX: usize = 256;
/// Knocks waiting for the publisher at once.
pub const MAX_QUEUE: usize = 64;

/// The first rendezvous boundary strictly above `after` for a knock confirmed
/// at `confirmed`, or `None` once the span is over.
pub fn next_boundary_after(confirmed: u32, after: u32) -> Option<u32> {
    if confirmed == 0 {
        return None;
    }
    let near_end = confirmed.saturating_add(RENDEZVOUS_NEAR_STEP * RENDEZVOUS_NEAR_COUNT);
    if after < near_end {
        let n = if after < confirmed { 1 } else { (after - confirmed) / RENDEZVOUS_NEAR_STEP + 1 };
        let b = confirmed.saturating_add(n * RENDEZVOUS_NEAR_STEP);
        if b <= near_end {
            return Some(b);
        }
    }
    let k = if after < near_end { 1 } else { (after - near_end) / RENDEZVOUS_FAR_STEP + 1 };
    let b = near_end.saturating_add(k * RENDEZVOUS_FAR_STEP);
    (b <= confirmed.saturating_add(RENDEZVOUS_SPAN)).then_some(b)
}

/// Is a boundary of a knock confirmed at `confirmed` inside `(last, peak]`?
pub fn rendezvous_due(confirmed: u32, last: u32, peak: u32) -> bool {
    peak > last && next_boundary_after(confirmed, last).is_some_and(|b| b <= peak)
}

/// A knock the dial ladder asked for, waiting for the publisher (RAM only: a
/// knock not yet sent is re-decided by the next dial anyway).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KnockRequest {
    pub room: String,
    /// The host's node id.
    pub host: String,
    pub ck_host: [u8; 32],
    /// The host's contact-card key the knock is sealed to.
    pub kx_host: [u8; 32],
    /// Failed attempts to send it so far (the publisher drops it after a few).
    pub attempts: u8,
}

/// Queue a request, once per (room, host); bounded, the oldest dropped.
pub fn enqueue(queue: &mut VecDeque<KnockRequest>, req: KnockRequest) -> bool {
    if queue.iter().any(|q| q.room == req.room && q.host == req.host) {
        return false;
    }
    while queue.len() >= MAX_QUEUE {
        queue.pop_front();
    }
    queue.push_back(req);
    true
}

/// A knock this node wrote.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct SentKnock {
    pub host: String,
    pub room: String,
    pub era: u64,
    /// The inbox hint written under, hex (what the operator can look up).
    pub hint: String,
    /// The coin the knock spend consumed, hex: the knock's own coin names it
    /// as parent, which is how the knock is found again under the hint and
    /// judged ([`crate::chia_resolve::write_standing`]) — its spent flag alone
    /// proves nothing, since a dropped knock's coin goes to the next write.
    pub coin_id: String,
    pub pushed_at: u64,
    /// 0 until the spend confirmed.
    #[serde(default)]
    pub confirmed_height: u32,
    /// The peak at the last dial-back planned from this knock (the boundary
    /// clock resumes above it); set to the confirmation height on confirming.
    #[serde(default)]
    pub last_rendezvous: u32,
}

/// A knock read from this node's inbox.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct InboxKnock {
    /// The knocker's node id.
    pub from: String,
    pub room: String,
    pub era: u64,
    pub confirmed_height: u32,
    /// The coin that carried it, hex (dedupe).
    pub coin_id: String,
    #[serde(default)]
    pub last_rendezvous: u32,
}

/// Who a dial-back is for, and in which room.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DialBack {
    pub target: String,
    pub room: String,
    /// True when WE knocked (the target is the host), false when the target
    /// knocked on us.
    pub we_knocked: bool,
}

/// `knocks.json`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct KnockBook {
    #[serde(default)]
    pub sent: Vec<SentKnock>,
    #[serde(default)]
    pub inbox: Vec<InboxKnock>,
}

impl KnockBook {
    /// A missing file is an empty book; an unreadable one is logged and starts
    /// empty (one early knock at worst: the era budget is the host's to read).
    pub fn load(path: &Path) -> KnockBook {
        match std::fs::read(path) {
            Ok(bytes) => {
                if let Err(e) = crate::chia_contact::tighten_private(path) {
                    eprintln!("⛓️ knocks: could not tighten {}: {e}", path.display());
                }
                match serde_json::from_slice(&bytes) {
                    Ok(book) => book,
                    Err(e) => {
                        eprintln!("⛓️ knocks: {} is unreadable ({e}) — starting with an empty knock book", path.display());
                        KnockBook::default()
                    }
                }
            }
            Err(_) => KnockBook::default(),
        }
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(self).map_err(std::io::Error::other)?;
        crate::chia_contact::write_private(path, &bytes)
    }

    /// Did we already knock on `host` in `era` (any room)? One knock per
    /// (knocker, host) per era, whatever the rooms: the first one names the
    /// room, and a host that reads it dials us back there.
    pub fn knocked_this_era(&self, host: &str, era: u64) -> bool {
        self.sent.iter().any(|k| k.host == host && k.era == era)
    }

    /// Record a knock pushed; bounded, the oldest pushed first out.
    pub fn record_sent(&mut self, knock: SentKnock) {
        while self.sent.len() >= MAX_SENT {
            if let Some((i, _)) = self.sent.iter().enumerate().min_by_key(|(_, k)| k.pushed_at) {
                self.sent.remove(i);
            }
        }
        self.sent.push(knock);
    }

    /// The knocks whose standing is not known yet (neither confirmed nor dropped).
    pub fn pending_sent(&self) -> Vec<SentKnock> {
        self.sent.iter().filter(|k| k.confirmed_height == 0).cloned().collect()
    }

    /// The chain says the knock that spent `coin_id` confirmed at `height`;
    /// the rendezvous clock starts there. Returns true when something changed.
    pub fn confirm_sent(&mut self, coin_id: &str, height: u32) -> bool {
        let mut changed = false;
        for k in self.sent.iter_mut().filter(|k| k.coin_id == coin_id && k.confirmed_height == 0) {
            k.confirmed_height = height;
            k.last_rendezvous = height;
            changed = true;
        }
        changed
    }

    /// A knock of ours that never counts — the chain confirmed it OUTSIDE its
    /// era (the host's reader rejects it, so nobody dials back), or its spend
    /// never landed ([`crate::chia_resolve::WriteStanding::Dead`]): forgotten,
    /// the next dial exhaustion knocks again. Returns true when one went.
    pub fn drop_sent(&mut self, coin_id: &str) -> bool {
        let before = self.sent.len();
        self.sent.retain(|k| k.coin_id != coin_id);
        before != self.sent.len()
    }

    /// File a knock read from the inbox. A copy of a knock under another coin
    /// never opens (its sealing binds the carrier's parent, #272 review round
    /// 3), so two knocks here from one knocker for one room in one era are two
    /// GENUINE writes — a knocker that lost its book and knocked again — and
    /// the knocker's own clock is its latest: a newer confirmation replaces
    /// the older entry, an older one listed later (the reader lists the newest
    /// coins first) is ignored, the same coin again is ignored. Bounded, the
    /// oldest confirmation first out. Returns true when the book changed.
    pub fn record_inbox(&mut self, knock: InboxKnock) -> bool {
        if self.inbox.iter().any(|k| k.coin_id == knock.coin_id) {
            return false;
        }
        if let Some(i) = self.inbox.iter().position(|k| k.from == knock.from && k.room == knock.room && k.era == knock.era) {
            if self.inbox[i].confirmed_height >= knock.confirmed_height {
                return false;
            }
            self.inbox[i] = knock;
            return true;
        }
        while self.inbox.len() >= MAX_INBOX {
            if let Some((i, _)) = self.inbox.iter().enumerate().min_by_key(|(_, k)| k.confirmed_height) {
                self.inbox.remove(i);
            }
        }
        self.inbox.push(knock);
        true
    }

    /// Forget what the chain no longer honours at `peak` (an AGREED peak: this
    /// forgets rendezvous state, #272 review round 2): every entry two eras
    /// past its own, the record's own validity. A knock of ours still pending
    /// when its era ended is KEPT within that window: the era's end proves
    /// nothing about its spend — it may have confirmed late in the era while
    /// the lookup lagged — and the chain's word settles it (the watcher drops
    /// a knock confirmed outside its era explicitly). It blocks no new knock,
    /// since the once-per-era rule is per era. Returns how many went.
    pub fn prune(&mut self, peak: u32) -> usize {
        let era = era_of(peak);
        let before = self.sent.len() + self.inbox.len();
        self.sent.retain(|k| k.era + 2 > era);
        self.inbox.retain(|k| k.era + 2 > era);
        before - self.sent.len() - self.inbox.len()
    }

    /// Every dial-back whose boundary fell since it was last planned, at chain
    /// peak `peak`, the longest-waiting first. The knocker dials the host, the
    /// host dials the knocker. Nothing is marked here: a boundary is planned
    /// with [`KnockBook::mark_dialed`] once its hold actually starts, so a
    /// dial-back the room had no hold slot for (#272 review) stays due and,
    /// having waited longest, comes first next tick.
    pub fn due_dialbacks(&self, peak: u32) -> Vec<DialBack> {
        let mut out: Vec<(u32, DialBack)> = Vec::new();
        for k in self.sent.iter().filter(|k| k.confirmed_height != 0) {
            if rendezvous_due(k.confirmed_height, k.last_rendezvous, peak) {
                out.push((k.last_rendezvous, DialBack { target: k.host.clone(), room: k.room.clone(), we_knocked: true }));
            }
        }
        for k in self.inbox.iter() {
            if rendezvous_due(k.confirmed_height, k.last_rendezvous, peak) {
                out.push((k.last_rendezvous, DialBack { target: k.from.clone(), room: k.room.clone(), we_knocked: false }));
            }
        }
        out.sort_by_key(|(last, _)| *last);
        out.into_iter().map(|(_, d)| d).collect()
    }

    /// The dial-back `d` was planned at `peak` (its hold started, or it was
    /// moot: the room gone, sharing no cards, or the two linked): the boundary
    /// clock of every entry it stands for — the same target, room and side,
    /// due at `peak` — moves up, so that boundary is not dialed twice. Returns
    /// true when something changed.
    pub fn mark_dialed(&mut self, d: &DialBack, peak: u32) -> bool {
        let mut changed = false;
        if d.we_knocked {
            for k in self.sent.iter_mut().filter(|k| k.confirmed_height != 0 && k.host == d.target && k.room == d.room) {
                if rendezvous_due(k.confirmed_height, k.last_rendezvous, peak) {
                    k.last_rendezvous = peak;
                    changed = true;
                }
            }
        } else {
            for k in self.inbox.iter_mut().filter(|k| k.from == d.target && k.room == d.room) {
                if rendezvous_due(k.confirmed_height, k.last_rendezvous, peak) {
                    k.last_rendezvous = peak;
                    changed = true;
                }
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendezvous_boundaries_run_near_then_far_then_stop() {
        let h = 1000;
        assert_eq!(next_boundary_after(h, h), Some(1010));
        assert_eq!(next_boundary_after(h, 995), Some(1010), "a reader behind the confirmation starts at the first");
        assert_eq!(next_boundary_after(h, 1010), Some(1020), "a boundary already reached is not due again");
        assert_eq!(next_boundary_after(h, 1055), Some(1060));
        assert_eq!(next_boundary_after(h, 1060), Some(1380), "after the sixth, every tenth beat");
        assert_eq!(next_boundary_after(h, 1380), Some(1700));
        let last = 1060 + 320 * ((RENDEZVOUS_SPAN - 60) / 320);
        assert_eq!(next_boundary_after(h, last - 1), Some(last));
        assert_eq!(next_boundary_after(h, last), None, "nothing after two eras");
        assert_eq!(next_boundary_after(0, 5), None, "no confirmation, no schedule");
        assert!(rendezvous_due(h, 1005, 1012));
        assert!(!rendezvous_due(h, 1010, 1019));
        assert!(rendezvous_due(h, 1010, 1020));
        assert!(!rendezvous_due(h, 1020, 1020), "an empty interval holds nothing");
        assert!(rendezvous_due(h, 1000, 1500), "a long gap still finds the boundaries it skipped");
    }

    fn sent(host: &str, era: u64, coin: &str, pushed_at: u64) -> SentKnock {
        SentKnock {
            host: host.into(),
            room: "r".into(),
            era,
            hint: "ab".into(),
            coin_id: coin.into(),
            pushed_at,
            confirmed_height: 0,
            last_rendezvous: 0,
        }
    }

    #[test]
    fn one_knock_per_host_per_era_and_confirmation_by_coin() {
        let mut book = KnockBook::default();
        assert!(!book.knocked_this_era("H", 3));
        book.record_sent(sent("H", 3, "c1", 100));
        assert!(book.knocked_this_era("H", 3));
        assert!(!book.knocked_this_era("H", 4), "a new era knocks again");
        assert!(!book.knocked_this_era("G", 3), "another host is another knock");
        assert_eq!(book.pending_sent().iter().map(|k| k.coin_id.as_str()).collect::<Vec<_>>(), vec!["c1"]);
        assert!(book.confirm_sent("c1", 96_800));
        assert!(!book.confirm_sent("c1", 96_900), "confirmed once");
        assert!(book.pending_sent().is_empty());
        assert_eq!(book.sent[0].last_rendezvous, 96_800, "the clock starts at the confirmation");
        assert!(book.drop_sent("c1"));
        assert!(!book.drop_sent("c1"));
        assert!(!book.knocked_this_era("H", 3), "a dropped knock may be knocked again");
    }

    #[test]
    fn dialbacks_come_due_on_the_schedule_once_each_for_both_sides() {
        let mut book = KnockBook::default();
        book.record_sent(sent("H", 3, "c1", 100));
        book.confirm_sent("c1", 1000);
        assert!(book.record_inbox(InboxKnock {
            from: "J".into(),
            room: "r".into(),
            era: 3,
            confirmed_height: 2000,
            coin_id: "k1".into(),
            last_rendezvous: 2000,
        }));
        assert!(!book.record_inbox(InboxKnock {
            from: "J".into(),
            room: "r".into(),
            era: 3,
            confirmed_height: 2000,
            coin_id: "k1".into(),
            last_rendezvous: 2000,
        }), "the same coin files once");
        assert!(book.due_dialbacks(1005).is_empty(), "before the first boundary");
        let due = book.due_dialbacks(1012);
        assert_eq!(due, vec![DialBack { target: "H".into(), room: "r".into(), we_knocked: true }]);
        assert_eq!(book.due_dialbacks(1012), due, "nothing is planned until its hold starts");
        assert!(book.mark_dialed(&due[0], 1012));
        assert!(!book.mark_dialed(&due[0], 1012), "planned once");
        assert!(book.due_dialbacks(1015).is_empty(), "the same boundary is not dialed twice");
        let due = book.due_dialbacks(2011);
        assert_eq!(due.len(), 2, "our knock's h+20 and the inbox knock's h+10 fall in this interval");
        assert!(due.iter().any(|d| d.target == "J" && !d.we_knocked));
        assert!(due.iter().any(|d| d.target == "H" && d.we_knocked));
        for d in &due {
            assert!(book.mark_dialed(d, 2011));
        }
        assert!(book.due_dialbacks(2015).is_empty());
    }

    #[test]
    fn a_dial_back_passed_over_stays_due_and_comes_first() {
        let mut book = KnockBook::default();
        book.record_sent(sent("H", 3, "c1", 100));
        book.confirm_sent("c1", 1000);
        book.record_inbox(InboxKnock { from: "J".into(), room: "r".into(), era: 3, confirmed_height: 1000, coin_id: "k1".into(), last_rendezvous: 1000 });
        let due = book.due_dialbacks(1012);
        assert_eq!(due.iter().map(|d| d.target.as_str()).collect::<Vec<_>>(), vec!["H", "J"], "equal waits keep the book's order");
        // The room had one hold slot: H's hold started, J's did not.
        assert!(book.mark_dialed(&due[0], 1012));
        let again = book.due_dialbacks(1013);
        assert_eq!(again, vec![DialBack { target: "J".into(), room: "r".into(), we_knocked: false }], "the boundary J was passed over for is still due");
        assert!(book.mark_dialed(&again[0], 1013));
        assert!(book.due_dialbacks(1015).is_empty());
        // At the next boundary the one planned longest ago comes first.
        let next = book.due_dialbacks(1022);
        assert_eq!(next.iter().map(|d| d.target.as_str()).collect::<Vec<_>>(), vec!["H", "J"]);
        book.inbox[0].last_rendezvous = 1011;
        let next = book.due_dialbacks(1022);
        assert_eq!(next.iter().map(|d| d.target.as_str()).collect::<Vec<_>>(), vec!["J", "H"], "the longest-waiting first");
        assert!(!book.mark_dialed(&DialBack { target: "X".into(), room: "r".into(), we_knocked: true }, 1022), "an unknown dial-back marks nothing");
        assert!(!book.mark_dialed(&DialBack { target: "J".into(), room: "r".into(), we_knocked: true }, 1022), "the side is part of the identity");
    }

    #[test]
    fn one_inbox_clock_per_knocker_per_room_per_era_and_it_is_the_newest() {
        // #272 review round 3: replayed copies never decode (chia_lane), so a
        // second knock from one knocker in one era is its own re-knock, and
        // its clock is the latest one.
        let mut book = KnockBook::default();
        let knock = |height: u32, coin: &str| InboxKnock {
            from: "J".into(),
            room: "r".into(),
            era: 3,
            confirmed_height: height,
            coin_id: coin.into(),
            last_rendezvous: height,
        };
        assert!(book.record_inbox(knock(3 * ERA_BLOCKS + 10, "k1")));
        assert!(!book.record_inbox(knock(3 * ERA_BLOCKS + 10, "k1")), "the same coin again");
        assert!(book.record_inbox(knock(3 * ERA_BLOCKS + 300, "k2")), "a later knock from the same knocker replaces the clock");
        assert_eq!(book.inbox.len(), 1);
        assert_eq!((book.inbox[0].confirmed_height, book.inbox[0].coin_id.as_str()), (3 * ERA_BLOCKS + 300, "k2"));
        assert!(!book.record_inbox(knock(3 * ERA_BLOCKS + 100, "k3")), "an older one listed later (the newest coins come first) is ignored");
        assert_eq!(book.inbox[0].coin_id, "k2");
        let mut other_room = knock(3 * ERA_BLOCKS + 400, "k4");
        other_room.room = "s".into();
        assert!(book.record_inbox(other_room), "another room is another intent");
        let mut other_era = knock(4 * ERA_BLOCKS + 1, "k5");
        other_era.era = 4;
        assert!(book.record_inbox(other_era), "another era is another intent");
        assert_eq!(book.inbox.len(), 3);
    }

    #[test]
    fn book_is_bounded_and_prunes_expired_and_stale_pending_knocks() {
        let mut book = KnockBook::default();
        for i in 0..MAX_SENT + 3 {
            book.record_sent(sent(&format!("H{i}"), 3, &format!("c{i}"), i as u64));
        }
        assert_eq!(book.sent.len(), MAX_SENT);
        assert!(!book.sent.iter().any(|k| k.host == "H0"), "the oldest pushed went first");
        for i in 0..MAX_INBOX + 2 {
            book.record_inbox(InboxKnock {
                from: format!("J{i}"),
                room: "r".into(),
                era: 3,
                confirmed_height: 100 + i as u32,
                coin_id: format!("k{i}"),
                last_rendezvous: 0,
            });
        }
        assert_eq!(book.inbox.len(), MAX_INBOX);
        assert!(!book.inbox.iter().any(|k| k.from == "J0"), "the oldest confirmation went first");

        let mut book = KnockBook::default();
        book.record_sent(sent("old", 1, "a", 1));
        book.confirm_sent("a", 40_000);
        book.record_sent(sent("pending-last-era", 2, "b", 2));
        book.record_sent(sent("pending-now", 3, "c", 3));
        book.record_sent(sent("confirmed-last-era", 2, "d", 4));
        book.confirm_sent("d", 70_000);
        book.record_inbox(InboxKnock { from: "x".into(), room: "r".into(), era: 1, confirmed_height: 40_001, coin_id: "k".into(), last_rendezvous: 0 });
        book.record_inbox(InboxKnock { from: "y".into(), room: "r".into(), era: 2, confirmed_height: 70_001, coin_id: "l".into(), last_rendezvous: 0 });
        let peak = 3 * ERA_BLOCKS + 5; // era 3
        assert_eq!(book.prune(peak), 2, "era 1 on both sides; the pending knock of era 2 is kept for the chain's word");
        let hosts: Vec<&str> = book.sent.iter().map(|k| k.host.as_str()).collect();
        assert_eq!(hosts, vec!["pending-last-era", "pending-now", "confirmed-last-era"]);
        assert!(!book.knocked_this_era("pending-last-era", 3), "a pending knock of the last era blocks no knock in this one");
        assert_eq!(book.inbox.len(), 1);
        assert_eq!(book.inbox[0].from, "y");
        assert_eq!(book.prune(4 * ERA_BLOCKS), 3, "two eras on: era 2 goes, pending or not");
        assert_eq!(book.sent.iter().map(|k| k.host.as_str()).collect::<Vec<_>>(), vec!["pending-now"]);
    }

    #[test]
    fn queue_takes_each_room_host_pair_once_and_stays_bounded() {
        let mut q = VecDeque::new();
        let req = |room: &str, host: &str| KnockRequest { room: room.into(), host: host.into(), ck_host: [1; 32], kx_host: [2; 32], attempts: 0 };
        assert!(enqueue(&mut q, req("r", "H")));
        assert!(!enqueue(&mut q, req("r", "H")), "queued once");
        assert!(enqueue(&mut q, req("s", "H")), "another room is another knock");
        for i in 0..MAX_QUEUE {
            enqueue(&mut q, req(&format!("t{i}"), "H"));
        }
        assert_eq!(q.len(), MAX_QUEUE);
        assert!(!q.iter().any(|k| k.room == "r"), "the oldest went first");
    }

    #[test]
    fn book_roundtrips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("ssf-knocks-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(KNOCKS_FILE);
        let _ = std::fs::remove_file(&path);
        assert_eq!(KnockBook::load(&path), KnockBook::default(), "no file, empty book");
        let mut book = KnockBook::default();
        book.record_sent(sent("H", 3, "c1", 100));
        book.confirm_sent("c1", 1000);
        book.record_inbox(InboxKnock { from: "J".into(), room: "r".into(), era: 3, confirmed_height: 2000, coin_id: "k1".into(), last_rendezvous: 2000 });
        book.save(&path).unwrap();
        assert_eq!(KnockBook::load(&path), book);
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(KnockBook::load(&path), KnockBook::default(), "an unreadable file starts empty");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
