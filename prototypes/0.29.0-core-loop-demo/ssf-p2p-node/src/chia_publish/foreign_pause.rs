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
//! This file is the clock alone ([`ForeignPause`]): it reads no chain and
//! no lease, and its time and era are its caller's. The heartbeat owns the
//! one the node runs by, loaded from [`FOREIGN_PAUSE_FILE`] with burner
//! keys on and kept in memory, never noted, with them off.

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
    seen: Vec<String>,
}

/// The pause's clock (see the module's own words): the era the spends by
/// another copy were counted in, how many, when the first one's two hours
/// end, and the coins they were learned by.
///
/// Kept per network in [`FOREIGN_PAUSE_FILE`] and saved at every count, so
/// a restart does not end a pause. A missing, unreadable or malformed file
/// starts with no pause, as the gift fuse's does. The count starts again
/// only at a later era: an earlier one than it counted in (a clock set
/// back) reads the stored count.
#[derive(Debug)]
pub struct ForeignPause {
    /// The era the spends in `times` were counted in.
    era: u64,
    /// Spends by another copy counted in `era`.
    times: u32,
    /// The unix time the two hours of the era's first one end.
    until: u64,
    /// The coins counted, oldest first ([`MAX_FOREIGN_SEEN`]).
    seen: Vec<Bytes32>,
    /// The pause the log last said ([`ForeignPause::say`]); this run's
    /// memory.
    said: Option<Paused>,
    /// Where it is saved; `None` keeps it in memory alone.
    path: Option<PathBuf>,
}

impl ForeignPause {
    /// No pause, kept in memory alone and saved nowhere: the heartbeat's
    /// with burner keys off, where nothing is ever counted, and the tests'
    /// own.
    pub fn in_memory() -> ForeignPause {
        ForeignPause { era: 0, times: 0, until: 0, seen: Vec::new(), said: None, path: None }
    }

    /// The pause saved at `path`, which every later count saves to.
    pub fn load(path: &Path) -> ForeignPause {
        let file = std::fs::read(path).ok().and_then(|bytes| {
            let _ = crate::chia_contact::tighten_private(path); // 0600 like every node file
            serde_json::from_slice::<PauseFile>(&bytes).ok()
        });
        let mut pause = ForeignPause::in_memory();
        pause.path = Some(path.to_path_buf());
        if let Some(f) = file {
            pause.era = f.era;
            pause.times = f.times;
            pause.until = f.until;
            pause.seen = f.seen.iter().filter_map(|hex| crate::chia_resolve::parse_hex32(hex)).collect();
        }
        pause
    }

    /// Count a spend by another copy of this station, learned by `coin` in
    /// era `era` at the unix time `now`, and save. `false` when `coin` was
    /// counted before, which changes nothing. The first one of an era
    /// starts its two hours at `now`; a later one of the same era starts
    /// no clock, since the era's end is what it waits for.
    pub fn note(&mut self, era: u64, now: u64, coin: Bytes32) -> bool {
        if self.seen.contains(&coin) {
            return false;
        }
        if era > self.era {
            self.era = era;
            self.times = 0;
        }
        self.times = self.times.saturating_add(1);
        if self.times == 1 {
            self.until = now.saturating_add(FOREIGN_PAUSE_SECS);
        }
        self.seen.push(coin);
        if self.seen.len() > MAX_FOREIGN_SEEN {
            self.seen.remove(0);
        }
        self.save_or_log();
        true
    }

    /// The pause that holds in era `era` at the unix time `now`, if one
    /// does. Two counted in an era hold through that era and any earlier
    /// one (a clock set back), and end with the next. One holds for its two
    /// hours, whatever the era, and so does the first of two once the era
    /// has turned. The two hours are never longer than that from `now`: a
    /// stored end further off was set by a clock that ran ahead, and holds
    /// nothing.
    pub fn holds(&self, era: u64, now: u64) -> Option<Paused> {
        if self.times >= 2 && era <= self.era {
            return Some(Paused::UntilNextEra);
        }
        let left = self.until.saturating_sub(now);
        (self.times >= 1 && left > 0 && left <= FOREIGN_PAUSE_SECS).then_some(Paused::TwoHours { until: self.until })
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
        let file = PauseFile { era: self.era, times: self.times, until: self.until, seen: self.seen.iter().map(hex::encode).collect() };
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

    #[test]
    fn nothing_holds_before_a_spend_by_another_copy_is_counted() {
        let mut pause = ForeignPause::in_memory();
        for era in [0, 7, u64::MAX] {
            for now in [0, T0, u64::MAX] {
                assert_eq!(pause.holds(era, now), None, "era {era} at {now}");
                assert_eq!(pause.say(era, now), None, "and the log owes no line");
            }
        }
    }

    #[test]
    fn the_first_spend_by_another_copy_in_an_era_pauses_for_two_hours() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let until = T0 + 2 * 3600;
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
    fn a_second_one_in_the_era_pauses_until_the_next_era() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let later = T0 + 3 * 3600;
        assert_eq!(pause.holds(7, later), None, "the first pause is over");
        assert!(pause.note(7, later, coin(2)));
        for now in [later, later + 2 * 3600, later + 6 * 24 * 3600] {
            assert_eq!(pause.holds(7, now), Some(Paused::UntilNextEra), "through the era, at {now}");
        }
        assert_eq!(pause.holds(6, later), Some(Paused::UntilNextEra), "an earlier era (a clock set back) is held too");
        assert_eq!(pause.holds(8, later + 6 * 24 * 3600), None, "the next era writes again");
        // A third in the era changes nothing.
        assert!(pause.note(7, later + 60, coin(3)));
        assert_eq!(pause.holds(7, later + 60), Some(Paused::UntilNextEra));
        assert_eq!(pause.holds(8, later + 60), None);
    }

    #[test]
    fn a_second_one_inside_the_first_two_hours_holds_the_era_and_keeps_the_two_hours() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        assert!(pause.note(7, T0 + 60, coin(2)));
        let until = T0 + FOREIGN_PAUSE_SECS;
        assert_eq!(pause.holds(7, T0 + 61), Some(Paused::UntilNextEra));
        // The era turns inside the first one's two hours: those still run,
        // from the first count and not the second.
        assert_eq!(pause.holds(8, until - 1), Some(Paused::TwoHours { until }));
        assert_eq!(pause.holds(8, until), None);
    }

    #[test]
    fn a_new_era_counts_from_one_again() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        assert!(pause.note(7, T0 + 10, coin(2)));
        let next = T0 + 7 * 24 * 3600;
        assert_eq!(pause.holds(8, next), None);
        assert!(pause.note(8, next, coin(3)));
        assert_eq!(pause.holds(8, next), Some(Paused::TwoHours { until: next + FOREIGN_PAUSE_SECS }), "the first of era 8: two hours, not the era");
        assert_eq!(pause.holds(8, next + FOREIGN_PAUSE_SECS), None);
        assert!(pause.note(8, next + FOREIGN_PAUSE_SECS, coin(4)));
        assert_eq!(pause.holds(8, next + FOREIGN_PAUSE_SECS), Some(Paused::UntilNextEra));
        // A count for an earlier era (a clock set back) joins the era on
        // record: it never starts the count again.
        let mut back = ForeignPause::in_memory();
        assert!(back.note(7, T0, coin(1)));
        assert!(back.note(6, T0 + 3 * 3600, coin(2)));
        assert_eq!(back.holds(7, T0 + 3 * 3600), Some(Paused::UntilNextEra));
    }

    #[test]
    fn the_same_coin_is_counted_once() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        assert!(!pause.note(7, T0 + 3 * 3600, coin(1)), "told of again: nothing new");
        assert_eq!(pause.holds(7, T0 + 3 * 3600), None, "no second pause, and the first one's two hours are not started again");
        assert!(!pause.note(8, T0 + 8 * 24 * 3600, coin(1)), "in a later era too");
        assert_eq!(pause.holds(8, T0 + 8 * 24 * 3600), None);
        // Only the last MAX_FOREIGN_SEEN coins are remembered.
        let mut many = ForeignPause::in_memory();
        for n in 0..=MAX_FOREIGN_SEEN {
            assert!(many.note(7, T0, coin(u8::try_from(n).unwrap())));
        }
        assert_eq!(many.seen.len(), MAX_FOREIGN_SEEN);
        assert!(!many.note(7, T0, coin(1)), "one still remembered");
        assert!(many.note(7, T0, coin(0)), "the oldest was forgotten, so it counts again");
    }

    #[test]
    fn a_clock_that_ran_ahead_holds_nothing_past_two_hours_from_now() {
        let mut pause = ForeignPause::in_memory();
        // Counted while the clock stood a year ahead.
        let ahead = T0 + 365 * 24 * 3600;
        assert!(pause.note(7, ahead, coin(1)));
        assert_eq!(pause.holds(7, ahead), Some(Paused::TwoHours { until: ahead + FOREIGN_PAUSE_SECS }));
        assert_eq!(pause.holds(7, T0), None, "the clock is right again: an end a year off holds nothing");
        // Exactly two hours off is the longest that holds.
        assert_eq!(pause.holds(7, ahead - 1), None);
        // A count at the end of time does not overflow.
        let mut last = ForeignPause::in_memory();
        assert!(last.note(7, u64::MAX - 10, coin(2)));
        assert_eq!(last.holds(7, u64::MAX - 10), Some(Paused::TwoHours { until: u64::MAX }));
    }

    #[test]
    fn each_change_of_the_pause_is_said_once() {
        let mut pause = ForeignPause::in_memory();
        assert!(pause.note(7, T0, coin(1)));
        let started = pause.say(7, T0).expect("a pause starting is said");
        assert!(started.contains("for two hours") && started.contains("Stop the other copy"), "{started}");
        assert_eq!(pause.say(7, T0 + 60), None, "and not again while it holds");
        assert!(pause.note(7, T0 + 120, coin(2)));
        let era = pause.say(7, T0 + 120).expect("the era's second is said");
        assert!(era.contains("until the next era"), "{era}");
        assert_eq!(pause.say(7, T0 + 180), None);
        let over = pause.say(8, T0 + 7 * 24 * 3600).expect("its end is said");
        assert_eq!(over, PAUSE_OVER_LINE);
        assert_eq!(pause.say(8, T0 + 7 * 24 * 3600 + 60), None);
        // No line names a coin.
        for line in [&started, &era, &over] {
            assert!(!line.contains(&hex::encode(coin(1))) && !line.contains(&hex::encode(coin(2))), "{line}");
        }
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
        let mut pause = ForeignPause::load(&path);
        assert_eq!(pause.holds(7, T0), None, "no file: no pause");
        assert!(!path.exists(), "and none is written until something is counted");
        assert!(pause.note(7, T0, coin(1)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let mut again = ForeignPause::load(&path);
        assert_eq!(again.holds(7, T0 + 60), Some(Paused::TwoHours { until: T0 + FOREIGN_PAUSE_SECS }), "a restart does not end it");
        assert!(again.say(7, T0 + 60).is_some(), "and the new run says it holds");
        assert!(!again.note(7, T0 + 60, coin(1)), "the coin it was counted by is remembered across the restart");
        assert!(again.note(7, T0 + 60, coin(2)));
        assert_eq!(ForeignPause::load(&path).holds(7, T0 + 60), Some(Paused::UntilNextEra));
        // The file names the coins and nothing of a key.
        let text = std::fs::read_to_string(&path).unwrap();
        let json: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(json["era"], 7);
        assert_eq!(json["times"], 2);
        assert_eq!(json["until"], T0 + FOREIGN_PAUSE_SECS);
        assert_eq!(json["seen"], serde_json::json!([hex::encode(coin(1)), hex::encode(coin(2))]));
        assert_eq!(json.as_object().unwrap().len(), 4, "{text}");
        // Malformed, or of another shape: no pause, and the next count
        // writes a whole file over it.
        for bad in ["not json", "{\"era\": 7}", "[]"] {
            std::fs::write(&path, bad).unwrap();
            let mut fresh = ForeignPause::load(&path);
            assert_eq!(fresh.holds(7, T0), None, "{bad}");
            assert!(fresh.note(7, T0, coin(3)));
            assert_eq!(ForeignPause::load(&path).holds(7, T0), Some(Paused::TwoHours { until: T0 + FOREIGN_PAUSE_SECS }), "{bad}");
        }
        // A save that cannot be made holds in memory.
        let mut unsaved = ForeignPause::load(&dir.join("missing").join(FOREIGN_PAUSE_FILE));
        assert!(unsaved.note(7, T0, coin(4)));
        assert_eq!(unsaved.holds(7, T0), Some(Paused::TwoHours { until: T0 + FOREIGN_PAUSE_SECS }));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
