//! The pause on another copy of this station (stage 4 design §10, "Burner
//! spent elsewhere"; owner question 24).
//!
//! The listing's key P(e) comes from the wallet's words and this station's
//! contact key (§3.2), so only a cloned data folder, or someone holding
//! both, shares it (§3.3). Two copies writing one listing take each other's
//! coin in turn, and readers find whichever wrote last. The node cannot
//! stop the other copy. What it can do is stop adding to the churn and say
//! so: the first time in an era that it learns of a spend at P(e) that its
//! own lease never parked, its listing, its knocks and its beacon pause for
//! two hours; a second time in the era, they pause until the next era. No
//! money is at risk either way: a burner's coin is 1 mojo of the lobby
//! dish's.
//!
//! It learns of such a spend in two places, and each hands this module the
//! coin it learned it by. The listing's writer compares the spent coins at
//! the key with the lease's records of its own spends before it writes
//! (`claim_write::ForeignSpend`), and the listing's verdict reads a write
//! whose one coin went to a spend that was not ours
//! (`super::listing_word`). The coin is the evidence: told of the same coin
//! twice, as after a restart that lost the lease's last save, the pause
//! counts it once.
//!
//! The two hours are the owner's time to stop the other copy, so what that
//! copy spent before they ended is one time, not two. A coin told of while
//! they run counts nothing more ([`ForeignPause::note`]), and when they end
//! the heartbeat has the lease start its watch afresh
//! ([`ForeignPause::watch_due`], `WalletLease::watch_afresh`): the
//! listing's next write adopts what the key spent meanwhile and stops for
//! none of it. Only a spend the other copy makes after that write's look is
//! a second time.
//!
//! This file is the clock alone ([`ForeignPause`]): it reads no chain and
//! no lease, and its time and era are its caller's. The heartbeat owns the
//! one the node runs by, loaded from [`FOREIGN_PAUSE_FILE`] with burner
//! keys on and kept in memory, never noted, with them off. A pause is for
//! the listing keys it was counted under ([`ForeignPause::load`]): new
//! words or a new contact key make new listing keys, which no copy shares,
//! and a pause on record for the old ones holds nothing.
//!
//! What it cannot tell apart from another copy, each bounded to the pauses
//! above: a lease file put back from an earlier copy of itself (a restored
//! backup, or a save lost to a power cut), whose own later spends its
//! records no longer hold; a spend of this station's that was in a mempool
//! when its lease file was lost, or that an older build's lease let go as
//! dropped, and that landed after all; and a push every peer refused that
//! a peer relayed all the same.

use std::path::{Path, PathBuf};

use chia_protocol::Bytes32;
use serde::{Deserialize, Serialize};

/// Where the pause is kept, per network (`ChiaNet::path`), 0600 like every
/// node file.
pub const FOREIGN_PAUSE_FILE: &str = "foreign_pause.json";

/// How long the first spend by another copy in an era pauses this station
/// (stage 4 design §10): two hours.
pub const FOREIGN_PAUSE_SECS: u64 = 2 * 3600;

/// Evidence coins remembered at most; past it the oldest is forgotten. A
/// coin is told of again only after a restart that lost the lease's save
/// of the telling, and then it is the latest one.
pub const MAX_FOREIGN_SEEN: usize = 64;

/// The Phone Book's words while the first pause of an era holds: §10's own
/// sentences.
pub const PAUSED_TWO_HOURS_WORDS: &str =
    "Another copy of this station is writing its listing (the same words and contact key). Only one copy can. Stop the other one. This station tries again in two hours.";

/// The words once a second spend by another copy in the era holds the
/// station until the next era, which the Phone Book calls an edition.
pub const PAUSED_NEXT_EDITION_WORDS: &str =
    "Another copy of this station is writing its listing (the same words and contact key). Only one copy can. Stop the other one. This station tries again in the next edition.";

/// A pause that holds ([`ForeignPause::holds`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Paused {
    /// The first time in the era: until the unix time `until`.
    TwoHours { until: u64 },
    /// A second time in the era: until the era after it.
    UntilNextEra,
}

impl Paused {
    /// The Phone Book's words for this pause.
    pub fn words(self) -> &'static str {
        match self {
            Paused::TwoHours { .. } => PAUSED_TWO_HOURS_WORDS,
            Paused::UntilNextEra => PAUSED_NEXT_EDITION_WORDS,
        }
    }

    /// The log's line when this pause starts, or is found holding at a
    /// start. It names no key, puzzle hash, address or coin.
    fn line(self) -> String {
        let how_long = match self {
            Paused::TwoHours { .. } => "for two hours",
            Paused::UntilNextEra => "until the next era",
        };
        format!(
            "⛓️ ChiaHub: another copy of this station is writing its listing (a cloned folder: the same words and contact key). Only one copy can, so this one pauses its listing, its knocks and its beacon {how_long}. Stop the other copy. No money is at risk."
        )
    }
}

/// The line the log gives when a pause ends.
const PAUSE_OVER_LINE: &str = "⛓️ ChiaHub: the pause for another copy of this station is over; its listing, knocks and beacon go out again";

/// The pause as its file keeps it.
#[derive(Serialize, Deserialize)]
struct PauseFile {
    era: u64,
    times: u32,
    until: u64,
    /// The lease's watch was started afresh after the two hours
    /// ([`ForeignPause::watch_renewed`]).
    #[serde(default)]
    renewed: bool,
    /// The listing keys the pause was counted under ([`ForeignPause::load`]).
    #[serde(default)]
    keys: String,
    seen: Vec<String>,
}

/// The pause's clock (see the module's own words): the era the spends by
/// another copy were counted in, how many, when the first one's two hours
/// end, and the coins they were learned by.
///
/// Kept per network in [`FOREIGN_PAUSE_FILE`] and saved at every count, so
/// a restart does not end a pause. A missing, unreadable or malformed file
/// starts with no pause, as the gift fuse's does, and so does one counted
/// under other listing keys. The count starts again at a later era. The
/// era just before the one it counted in (the peak stepping back over an
/// era's first block) reads the stored count; an era further back does
/// not, since no chain steps back that far: the stored era came from a
/// peak that was wrong, and holds nothing.
///
/// Its `Debug` gives the count and no coin.
pub struct ForeignPause {
    /// The era the spends in `times` were counted in.
    era: u64,
    /// Spends by another copy counted in `era`.
    times: u32,
    /// The unix time the two hours of the era's first one end.
    until: u64,
    /// Whether the lease's watch was started afresh once the two hours of
    /// the era's first one had ended ([`ForeignPause::watch_due`]).
    renewed: bool,
    /// The listing keys it counts under, as [`ForeignPause::load`] was given
    /// them; `None` in memory alone.
    keys: Option<String>,
    /// The coins told of, oldest first ([`MAX_FOREIGN_SEEN`]).
    seen: Vec<Bytes32>,
    /// The pause the log last said ([`ForeignPause::say`]); this run's
    /// memory.
    said: Option<Paused>,
    /// Where it is saved; `None` keeps it in memory alone.
    path: Option<PathBuf>,
}

impl std::fmt::Debug for ForeignPause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ForeignPause")
            .field("era", &self.era)
            .field("times", &self.times)
            .field("until", &self.until)
            .field("renewed", &self.renewed)
            .finish_non_exhaustive()
    }
}

impl ForeignPause {
    /// No pause, kept in memory alone and saved nowhere, and bound to no
    /// keys: the heartbeat's with burner keys off, where nothing is ever
    /// counted, and the tests' own.
    pub fn in_memory() -> ForeignPause {
        ForeignPause { era: 0, times: 0, until: 0, renewed: false, keys: None, seen: Vec::new(), said: None, path: None }
    }

    /// The pause saved at `path`, which every later count saves to, for the
    /// listing keys `keys` names: a text that is the same for the same
    /// wallet words and contact key and for no others (`super::pause_keys`).
    /// A pause on record under another text was counted for keys this
    /// station no longer writes from, and starts as none.
    pub fn load(path: &Path, keys: &str) -> ForeignPause {
        let file = std::fs::read(path).ok().and_then(|bytes| {
            let _ = crate::chia_contact::tighten_private(path); // 0600 like every node file
            serde_json::from_slice::<PauseFile>(&bytes).ok()
        });
        let mut pause = ForeignPause::in_memory();
        pause.path = Some(path.to_path_buf());
        pause.keys = Some(keys.to_owned());
        match file {
            Some(f) if f.keys == keys => {
                pause.era = f.era;
                pause.times = f.times;
                pause.until = f.until;
                pause.renewed = f.renewed;
                pause.seen = f.seen.iter().filter_map(|hex| crate::chia_resolve::parse_hex32(hex)).collect();
            }
            Some(f) if f.times > 0 => {
                eprintln!("⛓️ ChiaHub: the pause on record for another copy of this station was for other listing keys (other words or another contact key); it holds nothing now");
            }
            _ => {}
        }
        pause
    }

    /// Whether a count at `era` joins the one on record: `era` is the era
    /// on record, or the one just before it.
    fn joins(&self, era: u64) -> bool {
        era <= self.era && self.era - era <= 1
    }

    /// Whether the two hours of the era's first one still run at `now`.
    /// Their end is never more than four hours off: a clock set back by up
    /// to two hours since the count still holds them, without a gap, and an
    /// end further off than that was set by a clock that ran ahead, and
    /// holds nothing.
    fn two_hours_run(&self, now: u64) -> bool {
        let left = self.until.saturating_sub(now);
        self.times >= 1 && left > 0 && left <= 2 * FOREIGN_PAUSE_SECS
    }

    /// Take a spend by another copy of this station, learned by `coin` in
    /// era `era` at the unix time `now`, and save. `true` when it counts,
    /// as the era's first or a later one. `false`, with no count, when
    /// `coin` was told of before, and when it is told of while the two
    /// hours of the era's first one run: those are the owner's time to stop
    /// the other copy, and what it spent meanwhile is still the first time.
    /// The first one of an era starts its two hours at `now`; a later one
    /// starts no clock, since the era's end is what it waits for.
    pub fn note(&mut self, era: u64, now: u64, coin: Bytes32) -> bool {
        if self.seen.contains(&coin) {
            return false;
        }
        self.seen.push(coin);
        if self.seen.len() > MAX_FOREIGN_SEEN {
            self.seen.remove(0);
        }
        if !self.joins(era) {
            self.era = era;
            self.times = 0;
        }
        let counts = self.times == 0 || !self.two_hours_run(now);
        if counts {
            self.times = self.times.saturating_add(1);
            if self.times == 1 {
                self.until = now.saturating_add(FOREIGN_PAUSE_SECS);
                self.renewed = false;
            }
        }
        self.save_or_log();
        counts
    }

    /// The pause that holds in era `era` at the unix time `now`, if one
    /// does. Two counted in an era hold through that era, and the one just
    /// before it, and end with the next. One holds for its two hours,
    /// whatever the era, and so does the first of two once the era has
    /// turned.
    pub fn holds(&self, era: u64, now: u64) -> Option<Paused> {
        if self.times >= 2 && self.joins(era) {
            return Some(Paused::UntilNextEra);
        }
        self.two_hours_run(now).then_some(Paused::TwoHours { until: self.until })
    }

    /// Whether the lease's watch is to start afresh at `now`: the two hours
    /// of the era's first one have ended, no second one holds the era, and
    /// it was not done yet. Its caller starts the watch afresh and then
    /// says so ([`ForeignPause::watch_renewed`]), in that order, so a stop
    /// between the two does it again at the next start and never leaves it
    /// undone.
    pub fn watch_due(&self, now: u64) -> bool {
        self.times == 1 && !self.renewed && !self.two_hours_run(now)
    }

    /// The lease's watch was started afresh ([`ForeignPause::watch_due`]):
    /// saved, so it is done once for a pause.
    pub fn watch_renewed(&mut self) {
        self.renewed = true;
        self.save_or_log();
    }

    /// The line the log owes at era `era` and time `now`, if the pause that
    /// holds is not the one last said: a pause starting, found holding at a
    /// start, or going from two hours to the era's end says why
    /// ([`Paused::line`]), and one ending says so. `None` while nothing
    /// changed, so each is said once.
    pub fn say(&mut self, era: u64, now: u64) -> Option<String> {
        let holds = self.holds(era, now);
        if holds == self.said {
            return None;
        }
        self.said = holds;
        Some(match holds {
            Some(paused) => paused.line(),
            None => PAUSE_OVER_LINE.to_string(),
        })
    }

    /// Save the pause to its file, if it has one, as the gift fuse is saved
    /// (`write_private`, 0600 and atomic); a failure is logged.
    fn save_or_log(&self) {
        let Some(path) = &self.path else { return };
        let file = PauseFile {
            era: self.era,
            times: self.times,
            until: self.until,
            renewed: self.renewed,
            keys: self.keys.clone().unwrap_or_default(),
            seen: self.seen.iter().map(hex::encode).collect(),
        };
        let saved = serde_json::to_vec_pretty(&file)
            .map_err(std::io::Error::other)
            .and_then(|bytes| crate::chia_contact::write_private(path, &bytes));
        if let Err(e) = saved {
            eprintln!(
                "⛓️ ChiaHub: the pause for another copy of this station could not be saved to {} ({e}); it holds in memory until the node stops",
                path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn coin(n: u8) -> Bytes32 {
        Bytes32::new([n; 32])
    }

    const T0: u64 = 1_800_000_000;
    const HOUR: u64 = 3600;

    /// The listing keys the file tests count under.
    const KEYS: &str = "5c";

    #[test]
    fn nothing_holds_before_a_spend_by_another_copy_is_counted() {
        let mut pause = ForeignPause::in_memory();
        for era in [0, 7, u64::MAX] {
            for now in [0, T0, u64::MAX] {
                assert_eq!(pause.holds(era, now), None, "era {era} at {now}");
                assert_eq!(pause.say(era, now), None, "and the log owes no line");
                assert!(!pause.watch_due(now), "and the lease's watch is left as it is");
            }
        }
    }

    #[test]
    fn the_first_spend_by_another_copy_in_an_era_pauses_for_two_hours() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let until = T0 + 2 * HOUR;
        assert_eq!(FOREIGN_PAUSE_SECS, 7200, "§10: two hours");
        for now in [T0, T0 + 1, until - 1] {
            assert_eq!(pause.holds(7, now), Some(Paused::TwoHours { until }), "at {now}");
        }
        assert_eq!(pause.holds(7, until), None, "the two hours are over at their end");
        assert_eq!(pause.holds(7, until + 1), None);
        // Two hours are two hours, whatever the era turns to meanwhile.
        assert_eq!(pause.holds(8, until - 1), Some(Paused::TwoHours { until }));
        assert_eq!(pause.holds(8, until), None);
    }

    #[test]
    fn a_second_one_after_the_two_hours_pauses_until_the_next_era() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let later = T0 + 3 * HOUR;
        assert_eq!(pause.holds(7, later), None, "the first pause is over");
        assert!(pause.note(7, later, coin(2)));
        for now in [later, later + 2 * HOUR, later + 6 * 24 * HOUR] {
            assert_eq!(pause.holds(7, now), Some(Paused::UntilNextEra), "through the era, at {now}");
        }
        assert_eq!(pause.holds(8, later + 6 * 24 * HOUR), None, "the next era writes again");
        // A third in the era changes nothing.
        assert!(pause.note(7, later + 60, coin(3)));
        assert_eq!(pause.holds(7, later + 60), Some(Paused::UntilNextEra));
        assert_eq!(pause.holds(8, later + 60), None);
    }

    /// The two hours are the owner's time to stop the other copy: what it
    /// spent before they ended is still the first time.
    #[test]
    fn a_coin_told_of_while_the_two_hours_run_counts_nothing_more() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let until = T0 + FOREIGN_PAUSE_SECS;
        for (n, now) in [(2, T0), (3, T0 + 60), (4, until - 1)] {
            assert!(!pause.note(7, now, coin(n)), "told of at {now}: no second time");
            assert_eq!(pause.holds(7, now), Some(Paused::TwoHours { until }), "and the two hours run from the first");
        }
        assert_eq!(pause.holds(7, until), None, "they end when they would have");
        // Each was taken, so told of again it still counts nothing.
        assert!(!pause.note(7, until + 60, coin(3)));
        assert_eq!(pause.holds(7, until + 60), None);
        // A coin first told of once they have ended is the second time.
        assert!(pause.note(7, until, coin(5)));
        assert_eq!(pause.holds(7, until), Some(Paused::UntilNextEra));
    }

    #[test]
    fn a_new_era_counts_from_one_again() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        assert!(pause.note(7, T0 + 3 * HOUR, coin(2)));
        let next = T0 + 7 * 24 * HOUR;
        assert_eq!(pause.holds(8, next), None);
        assert!(pause.note(8, next, coin(3)));
        assert_eq!(pause.holds(8, next), Some(Paused::TwoHours { until: next + FOREIGN_PAUSE_SECS }), "the first of era 8: two hours, not the era");
        assert_eq!(pause.holds(8, next + FOREIGN_PAUSE_SECS), None);
        assert!(pause.note(8, next + FOREIGN_PAUSE_SECS, coin(4)));
        assert_eq!(pause.holds(8, next + FOREIGN_PAUSE_SECS), Some(Paused::UntilNextEra));
    }

    /// The peak can step back over an era's first block, so the era just
    /// before the one on record reads and joins its count. No chain steps
    /// back further: an era on record that far ahead came from a wrong
    /// peak, holds nothing, and is counted over.
    #[test]
    fn the_era_before_the_one_on_record_joins_its_count_and_an_earlier_one_does_not() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let later = T0 + 3 * HOUR;
        assert!(pause.note(6, later, coin(2)), "counted for the era before: it joins era 7's");
        assert_eq!(pause.holds(7, later), Some(Paused::UntilNextEra));
        assert_eq!(pause.holds(6, later), Some(Paused::UntilNextEra), "and holds there too");
        for era in [5, 0] {
            assert_eq!(pause.holds(era, later), None, "era {era} is too far back for era 7 to be the chain's");
        }
        // Counted at an era far behind the one on record: the count starts
        // again there, at one.
        let at = later + HOUR;
        assert!(pause.note(3, at, coin(3)));
        assert_eq!(pause.holds(3, at), Some(Paused::TwoHours { until: at + FOREIGN_PAUSE_SECS }), "the first of era 3");
        assert_eq!(pause.holds(7, at + FOREIGN_PAUSE_SECS), None, "era 7's count is gone");
    }

    #[test]
    fn the_same_coin_is_counted_once() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        assert!(!pause.note(7, T0 + 3 * HOUR, coin(1)), "told of again: nothing new");
        assert_eq!(pause.holds(7, T0 + 3 * HOUR), None, "no second pause, and the first one's two hours are not started again");
        assert!(!pause.note(8, T0 + 8 * 24 * HOUR, coin(1)), "in a later era too");
        assert_eq!(pause.holds(8, T0 + 8 * 24 * HOUR), None);
        // Only the last MAX_FOREIGN_SEEN coins are remembered.
        let mut many = ForeignPause::in_memory();
        let at = |n: usize| T0 + 3 * HOUR * u64::try_from(n).unwrap();
        for n in 0..=MAX_FOREIGN_SEEN {
            assert!(many.note(7, at(n), coin(u8::try_from(n).unwrap())));
        }
        assert_eq!(many.seen.len(), MAX_FOREIGN_SEEN);
        let end = at(MAX_FOREIGN_SEEN + 1);
        assert!(!many.note(7, end, coin(1)), "one still remembered");
        assert!(many.note(7, end, coin(0)), "the oldest was forgotten, so it counts again");
    }

    #[test]
    fn a_clock_that_ran_ahead_holds_nothing_and_one_set_back_two_hours_leaves_no_gap() {
        let mut pause = ForeignPause::in_memory();
        // Counted while the clock stood a year ahead.
        let ahead = T0 + 365 * 24 * HOUR;
        assert!(pause.note(7, ahead, coin(1)));
        assert_eq!(pause.holds(7, ahead), Some(Paused::TwoHours { until: ahead + FOREIGN_PAUSE_SECS }));
        assert_eq!(pause.holds(7, T0), None, "the clock is right again: an end a year off holds nothing");
        assert!(pause.watch_due(T0), "and the watch starts afresh, as after any pause that ended");
        // A clock set back by up to two hours since the count still holds,
        // from there to the end on record; set back further, nothing holds.
        let held = Some(Paused::TwoHours { until: ahead + FOREIGN_PAUSE_SECS });
        assert_eq!(pause.holds(7, ahead - 1), held);
        assert_eq!(pause.holds(7, ahead - FOREIGN_PAUSE_SECS), held);
        assert_eq!(pause.holds(7, ahead - FOREIGN_PAUSE_SECS - 1), None);
        // A count at the end of time does not overflow.
        let mut last = ForeignPause::in_memory();
        assert!(last.note(7, u64::MAX - 10, coin(2)));
        assert_eq!(last.holds(7, u64::MAX - 10), Some(Paused::TwoHours { until: u64::MAX }));
    }

    /// When the two hours end the lease's watch is to start afresh, once
    /// for a pause, and a restart remembers that it was done.
    #[test]
    fn the_watch_is_due_afresh_once_when_the_two_hours_end() {
        let dir = std::env::temp_dir().join(format!("ssf-foreign-watch-{}-{}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FOREIGN_PAUSE_FILE);
        let mut pause = ForeignPause::load(&path, KEYS);
        assert!(pause.note(7, T0, coin(1)));
        let until = T0 + FOREIGN_PAUSE_SECS;
        assert!(!pause.watch_due(T0) && !pause.watch_due(until - 1), "not while the two hours run");
        assert!(pause.watch_due(until) && pause.watch_due(until + 60), "due from their end, until it is done");
        assert!(ForeignPause::load(&path, KEYS).watch_due(until), "a restart before it was done finds it due");
        pause.watch_renewed();
        assert!(!pause.watch_due(until + 60), "done once");
        assert!(!ForeignPause::load(&path, KEYS).watch_due(until + 60), "and a restart knows");
        // A second one holds the era: nothing is renewed for it.
        assert!(pause.note(7, until + 120, coin(2)));
        assert!(!pause.watch_due(until + 120) && !pause.watch_due(until + 30 * 24 * HOUR));
        // The next era's first one is due its own.
        let next = T0 + 7 * 24 * HOUR;
        assert!(pause.note(8, next, coin(3)));
        assert!(!pause.watch_due(next) && pause.watch_due(next + FOREIGN_PAUSE_SECS));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn each_change_of_the_pause_is_said_once() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let started = pause.say(7, T0).expect("a pause starting is said");
        assert!(started.contains("for two hours") && started.contains("Stop the other copy"), "{started}");
        assert_eq!(pause.say(7, T0 + 60), None, "and not again while it holds");
        let ended = T0 + FOREIGN_PAUSE_SECS;
        assert_eq!(pause.say(7, ended).as_deref(), Some(PAUSE_OVER_LINE), "its end is said");
        assert_eq!(pause.say(7, ended + 60), None);
        assert!(pause.note(7, ended + 120, coin(2)));
        let era = pause.say(7, ended + 120).expect("the era's second is said");
        assert!(era.contains("until the next era"), "{era}");
        assert_eq!(pause.say(7, ended + 180), None);
        let over = pause.say(8, T0 + 7 * 24 * HOUR).expect("its end is said");
        assert_eq!(over, PAUSE_OVER_LINE);
        assert_eq!(pause.say(8, T0 + 7 * 24 * HOUR + 60), None);
        // No line names a coin, and neither does the pause's Debug.
        let debug = format!("{pause:?}");
        for text in [&started, &era, &over, &debug] {
            assert!(!text.contains(&hex::encode(coin(1))) && !text.contains(&hex::encode(coin(2))), "{text}");
        }
        assert!(debug.contains("times: 2"), "{debug}");
    }

    #[test]
    fn the_words_are_the_designs_and_differ_only_in_when_it_tries_again() {
        let two = Paused::TwoHours { until: 0 }.words();
        let era = Paused::UntilNextEra.words();
        // §10, word for word.
        assert_eq!(
            two,
            "Another copy of this station is writing its listing (the same words and contact key). Only one copy can. Stop the other one. This station tries again in two hours."
        );
        let stem = "Another copy of this station is writing its listing (the same words and contact key). Only one copy can. Stop the other one. ";
        assert_eq!(era.strip_prefix(stem), Some("This station tries again in the next edition."));
    }

    #[test]
    fn the_pause_outlives_a_restart_and_a_bad_file_starts_with_none() {
        let dir = std::env::temp_dir().join(format!("ssf-foreign-pause-{}-{}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FOREIGN_PAUSE_FILE);
        let mut pause = ForeignPause::load(&path, KEYS);
        assert_eq!(pause.holds(7, T0), None, "no file: no pause");
        assert!(!path.exists(), "and none is written until something is counted");
        assert!(pause.note(7, T0, coin(1)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let mut again = ForeignPause::load(&path, KEYS);
        assert_eq!(again.holds(7, T0 + 60), Some(Paused::TwoHours { until: T0 + FOREIGN_PAUSE_SECS }), "a restart does not end it");
        assert!(again.say(7, T0 + 60).is_some(), "and the new run says it holds");
        assert!(!again.note(7, T0 + 60, coin(1)), "the coin it was counted by is remembered across the restart");
        let later = T0 + 3 * HOUR;
        assert!(again.note(7, later, coin(2)));
        assert_eq!(ForeignPause::load(&path, KEYS).holds(7, later), Some(Paused::UntilNextEra));
        // The file names the coins and nothing of a key but the text it was
        // given.
        let text = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["era"], 7);
        assert_eq!(json["times"], 2);
        assert_eq!(json["until"], T0 + FOREIGN_PAUSE_SECS);
        assert_eq!(json["renewed"], false);
        assert_eq!(json["keys"], KEYS);
        assert_eq!(json["seen"], serde_json::json!([hex::encode(coin(1)), hex::encode(coin(2))]));
        assert_eq!(json.as_object().unwrap().len(), 6, "{text}");
        // Malformed, or of another shape: no pause, and the next count
        // writes a whole file over it.
        for bad in ["not json", "{\"era\": 7}", "[]"] {
            std::fs::write(&path, bad).unwrap();
            let mut fresh = ForeignPause::load(&path, KEYS);
            assert_eq!(fresh.holds(7, T0), None, "{bad}");
            assert!(fresh.note(7, T0, coin(3)));
            assert_eq!(ForeignPause::load(&path, KEYS).holds(7, T0), Some(Paused::TwoHours { until: T0 + FOREIGN_PAUSE_SECS }), "{bad}");
        }
        // A save that cannot be made holds in memory.
        let mut unsaved = ForeignPause::load(&dir.join("missing").join(FOREIGN_PAUSE_FILE), KEYS);
        assert!(unsaved.note(7, T0, coin(4)));
        assert_eq!(unsaved.holds(7, T0), Some(Paused::TwoHours { until: T0 + FOREIGN_PAUSE_SECS }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pause is for the listing keys it was counted under: under other
    /// words or another contact key the station writes from keys no copy
    /// shares, so a pause on record for the old ones holds nothing, and its
    /// coins are forgotten with it.
    #[test]
    fn a_pause_counted_under_other_listing_keys_holds_nothing() {
        let dir = std::env::temp_dir().join(format!("ssf-foreign-keys-{}-{}", std::process::id(), rand::random::<u64>()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FOREIGN_PAUSE_FILE);
        let later = T0 + 3 * HOUR;
        let mut old = ForeignPause::load(&path, "0a");
        assert!(old.note(7, T0, coin(1)) && old.note(7, later, coin(2)));
        assert_eq!(ForeignPause::load(&path, "0a").holds(7, later), Some(Paused::UntilNextEra), "the same keys: held");
        let mut new = ForeignPause::load(&path, "0b");
        assert_eq!(new.holds(7, later), None, "other keys: nothing holds");
        assert!(!new.watch_due(later));
        assert!(new.note(7, later, coin(1)), "and a coin the old count held counts as new");
        assert_eq!(new.holds(7, later), Some(Paused::TwoHours { until: later + FOREIGN_PAUSE_SECS }), "the first under these keys");
        assert_eq!(ForeignPause::load(&path, "0a").holds(7, later), None, "the file is the new keys' now");
        // A file of this build's earliest shape, with no keys, is no pause
        // for any keys.
        std::fs::write(&path, format!(r#"{{"era":7,"times":2,"until":{},"seen":[]}}"#, T0 + FOREIGN_PAUSE_SECS)).unwrap();
        assert_eq!(ForeignPause::load(&path, "0a").holds(7, later), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
