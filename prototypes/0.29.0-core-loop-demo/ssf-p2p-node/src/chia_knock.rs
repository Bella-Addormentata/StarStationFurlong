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
//! `h`, is read by J off its own spent coin and by H off the coin under its
//! inbox hint, and both dial at the same heights after it — `h + 10n` for
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
    /// The coin the knock spend consumed, hex: the chain's `spent_block_index`
    /// for it is the knock's confirmation height.
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

    /// The input coin ids (hex) of knocks whose confirmation is not known yet.
    pub fn pending_sent(&self) -> Vec<String> {
        self.sent.iter().filter(|k| k.confirmed_height == 0).map(|k| k.coin_id.clone()).collect()
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

    /// File a knock read from the inbox, once per coin; bounded, the oldest
    /// confirmation first out. Returns true when it is new.
    pub fn record_inbox(&mut self, knock: InboxKnock) -> bool {
        if self.inbox.iter().any(|k| k.coin_id == knock.coin_id) {
            return false;
        }
        while self.inbox.len() >= MAX_INBOX {
            if let Some((i, _)) = self.inbox.iter().enumerate().min_by_key(|(_, k)| k.confirmed_height) {
                self.inbox.remove(i);
            }
        }
        self.inbox.push(knock);
        true
    }

    /// Forget what the chain no longer honours at `peak`: every entry two eras
    /// past its own (the record expired), and a knock of ours still pending
    /// from an era that ended (a knock confirmed outside its era is noise to
    /// the host; the next dial exhaustion knocks again in the new era).
    /// Returns how many went.
    pub fn prune(&mut self, peak: u32) -> usize {
        let era = era_of(peak);
        let before = self.sent.len() + self.inbox.len();
        self.sent.retain(|k| k.era + 2 > era && (k.confirmed_height != 0 || k.era == era));
        self.inbox.retain(|k| k.era + 2 > era);
        before - self.sent.len() - self.inbox.len()
    }

    /// Every dial-back whose boundary fell since it was last planned, at chain
    /// peak `peak`; each is marked planned at `peak` so a boundary is dialed
    /// once. The knocker dials the host, the host dials the knocker.
    pub fn due_dialbacks(&mut self, peak: u32) -> Vec<DialBack> {
        let mut out = Vec::new();
        for k in self.sent.iter_mut().filter(|k| k.confirmed_height != 0) {
            if rendezvous_due(k.confirmed_height, k.last_rendezvous, peak) {
                k.last_rendezvous = peak;
                out.push(DialBack { target: k.host.clone(), room: k.room.clone(), we_knocked: true });
            }
        }
        for k in self.inbox.iter_mut() {
            if rendezvous_due(k.confirmed_height, k.last_rendezvous, peak) {
                k.last_rendezvous = peak;
                out.push(DialBack { target: k.from.clone(), room: k.room.clone(), we_knocked: false });
            }
        }
        out
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
        assert_eq!(book.pending_sent(), vec!["c1".to_string()]);
        assert!(book.confirm_sent("c1", 96_800));
        assert!(!book.confirm_sent("c1", 96_900), "confirmed once");
        assert!(book.pending_sent().is_empty());
        assert_eq!(book.sent[0].last_rendezvous, 96_800, "the clock starts at the confirmation");
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
        assert!(book.due_dialbacks(1015).is_empty(), "the same boundary is not dialed twice");
        let due = book.due_dialbacks(2011);
        assert_eq!(due.len(), 2, "our knock's h+20 and the inbox knock's h+10 fall in this interval");
        assert!(due.iter().any(|d| d.target == "J" && !d.we_knocked));
        assert!(due.iter().any(|d| d.target == "H" && d.we_knocked));
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
        assert_eq!(book.prune(peak), 3, "era 1 on both sides and the pending knock of era 2");
        let hosts: Vec<&str> = book.sent.iter().map(|k| k.host.as_str()).collect();
        assert_eq!(hosts, vec!["pending-now", "confirmed-last-era"]);
        assert_eq!(book.inbox.len(), 1);
        assert_eq!(book.inbox[0].from, "y");
    }

    #[test]
    fn queue_takes_each_room_host_pair_once_and_stays_bounded() {
        let mut q = VecDeque::new();
        let req = |room: &str, host: &str| KnockRequest { room: room.into(), host: host.into(), ck_host: [1; 32], kx_host: [2; 32] };
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
