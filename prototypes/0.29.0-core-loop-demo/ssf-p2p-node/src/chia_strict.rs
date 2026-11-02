//! ⛓️ Strict `SSF_NO_CHIA_LANE`: Chia off on this computer (stage 4 of the
//! mainnet transition, design §6).
//!
//! Set, it means no chain at all: no DNS introducer lookup, no full-node
//! dial, no read, no write and no SSF wallet. Unset, empty or exactly `0`
//! leaves the lane as it was; any other value turns it off, so `true`, `yes`
//! or a stray space never leaves the lane on by mistake. It is read once per
//! process, as `SSF_CHIA_LANE` is (chia_wallet_switch.rs).
//!
//! It wins over `SSF_CHIA_LANE=1`, the Bank's remembered switch,
//! `SSF_CHIA_BEACON`, `SSF_CHIA_FINDABLE`, `SSF_CHIA_WATCH`, `SSF_CHIA_PEERS`
//! and the env test hooks. It does not touch iroh, the Mainline DHT, mDNS or
//! relays: they keep their own switches.
//!
//! It holds in three layers:
//!   1. the lane (chia_peer_lane.rs): the process's one lane is built closed
//!      ([`crate::chia_peer_lane::Lane::closed`]: no pins, no peer store), and
//!      a closed lane refuses every request before it dials, resolves or reads
//!      anything, so even a call site someone forgot cannot reach a peer;
//!   2. the tasks (main.rs, [`task_plan`]): the watcher is not spawned, the
//!      wallet does not load (so no publisher and no test hook), rung 6 and
//!      the beacon fallback return at once, and the dish answers off before
//!      it builds a chain client;
//!   3. the switches: the Bank's TURN ON is refused
//!      (chia_wallet_switch::turn_refusal), and a startup line says this
//!      switch wins over `SSF_CHIA_LANE=1` ([`wins_line`]).
//!
//! The loopback fingerprint carries [`LaneView`] (`chia_lane`) for the page.
//!
//! Spends already parked by an earlier run stay parked: the wallet and its
//! lease do not load, so `wallet_lease.json` is left as it is, and the next
//! start without this switch settles them.
//!
//! Everything a decision rests on is a pure function here, so the tests never
//! touch the process environment.

use std::ffi::OsStr;

use serde::{Deserialize, Serialize};

/// What a closed lane answers, and the start of every refusal that follows
/// from it. A plain sentence: the player may read it.
pub const OFF_WORDS: &str = "Chia is off on this computer";

/// Classify a raw `SSF_NO_CHIA_LANE` value: `true` turns the lane off.
/// Unset, empty or exactly `0` is not strict; anything else is (fails closed).
pub fn strict_of(raw: Option<&OsStr>) -> bool {
    match raw {
        None => false,
        Some(v) => !(v.is_empty() || v == OsStr::new("0")),
    }
}

/// The process's `SSF_NO_CHIA_LANE`, read once: the lane, the tasks, the
/// Bank's switch and the fingerprint all see the same value.
fn env_strict() -> bool {
    static ENV: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ENV.get_or_init(|| strict_of(std::env::var_os("SSF_NO_CHIA_LANE").as_deref()))
}

/// Why the lane is off, as the fingerprint says it. One word per source, so a
/// later source (the in-game switch) is one more word, not a new shape.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OffSource {
    /// `SSF_NO_CHIA_LANE` in the node's environment.
    Env,
}

/// What turns the lane off, from what the node read: `None` while it is on.
pub fn off_source_of(env: bool) -> Option<OffSource> {
    env.then_some(OffSource::Env)
}

/// What turns the lane off for this process, if anything.
pub fn off_source() -> Option<OffSource> {
    off_source_of(env_strict())
}

/// Whether Chia is off for this process.
pub fn strict() -> bool {
    off_source().is_some()
}

/// The fingerprint's `chia_lane`: `{"off": true, "source": "env"}` while
/// Chia is off, `{"off": false}` while it is on. `source` rides only with
/// `off`; a page that does not know a source still reads `off`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneView {
    pub off: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<OffSource>,
}

/// The view of `source` ([`off_source_of`]).
pub fn view_of(source: Option<OffSource>) -> LaneView {
    LaneView { off: source.is_some(), source }
}

/// This process's view, for the fingerprint.
pub fn view() -> LaneView {
    view_of(off_source())
}

/// The Chia tasks a node starts at startup.
#[cfg_attr(not(feature = "chia-read"), allow(dead_code))]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskPlan {
    /// The beat watcher (`SSF_CHIA_WATCH` not `0`).
    pub watcher: bool,
    /// The SSF wallet (the Bank's switch or `SSF_CHIA_LANE=1`), and with it
    /// the publisher and the two env test hooks that spend from it.
    pub wallet: bool,
    /// The read-only `SSF_CHIA_RESOLVE_TEST=1` hook.
    pub resolve_hook: bool,
}

/// The tasks to start: what the node's switches ask for, or none at all
/// while Chia is off.
#[cfg_attr(not(feature = "chia-read"), allow(dead_code))]
pub fn task_plan(strict: bool, asked: TaskPlan) -> TaskPlan {
    if strict {
        TaskPlan::default()
    } else {
        asked
    }
}

/// The startup line for both switches set at once.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const WINS_WORDS: &str = "🏦 SSF wallet: SSF_NO_CHIA_LANE wins over SSF_CHIA_LANE=1. Chia is off on this computer, so the wallet stays off.";

/// The startup line that says this switch wins over `SSF_CHIA_LANE=1`
/// (`chia_lane_on`), when both are set.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn wins_line(strict: bool, chia_lane_on: bool) -> Option<&'static str> {
    (strict && chia_lane_on).then_some(WINS_WORDS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_empty_or_zero_leave_chia_on_and_anything_else_turns_it_off() {
        let os = |s: &'static str| Some(OsStr::new(s));
        for (raw, off) in [
            (None, false),
            (os(""), false),
            (os("0"), false),
            (os("1"), true),
            (os("true"), true),
            (os(" "), true),
            (os("yes"), true),
            (os("no"), true),
            (os("00"), true),
            (os(" 0"), true),
            (os("0 "), true),
            (os("false"), true),
        ] {
            assert_eq!(strict_of(raw), off, "{raw:?}");
        }
    }

    #[test]
    fn the_fingerprint_says_off_and_why_and_nothing_more_while_on() {
        assert_eq!(serde_json::to_string(&view_of(off_source_of(true))).unwrap(), r#"{"off":true,"source":"env"}"#);
        assert_eq!(serde_json::to_string(&view_of(off_source_of(false))).unwrap(), r#"{"off":false}"#);
        let back: LaneView = serde_json::from_str(r#"{"off":false}"#).unwrap();
        assert_eq!(back, LaneView { off: false, source: None });
    }

    #[test]
    fn the_task_plan_is_empty_while_chia_is_off() {
        let all = TaskPlan { watcher: true, wallet: true, resolve_hook: true };
        assert_eq!(task_plan(true, all), TaskPlan::default(), "nothing starts");
        assert_eq!(task_plan(true, TaskPlan::default()), TaskPlan::default());
        assert_eq!(task_plan(false, all), all, "otherwise the switches decide, as before");
        let some = TaskPlan { watcher: true, wallet: false, resolve_hook: false };
        assert_eq!(task_plan(false, some), some);
    }

    #[test]
    fn one_line_says_the_off_switch_wins_when_both_are_set() {
        assert_eq!(wins_line(true, true), Some(WINS_WORDS));
        assert_eq!(wins_line(true, false), None, "nothing to win over");
        assert_eq!(wins_line(false, true), None, "SSF_CHIA_LANE=1 alone holds the wallet on, as before");
        assert_eq!(wins_line(false, false), None);
        assert!(WINS_WORDS.contains(OFF_WORDS));
    }
}
