//! ⛓️ Chia off on this computer (stage 4 of the mainnet transition, design
//! §6): `SSF_NO_CHIA_LANE` in the node's environment, or the Chia switch in
//! the SpacePhone's Network settings ([`LANE_FILE`]).
//!
//! Off means no chain at all: no DNS introducer lookup, no full-node dial,
//! no read, no write and no SSF wallet.
//!
//! `SSF_NO_CHIA_LANE`: unset, empty or exactly `0` leaves Chia to the
//! in-game switch; any other value turns it off, so `true`, `yes` or a stray
//! space never leaves the lane on by mistake. It is read once per process,
//! as `SSF_CHIA_LANE` is (chia_wallet_switch.rs).
//!
//! The in-game switch is for players, who never set environment variables.
//! The SpacePhone's Network settings turn Chia off with
//! `POST /api/chia/lane?on=0` and back on with `on=1` (main.rs), behind the
//! wallet switch's gate (chia_wallet_switch::local_page). Off saves
//! [`LANE_FILE`] at the data root, owner-only, and closes the process's lane
//! at once; the route answers once the lane is closed. One file covers every
//! Chia network. On removes the file, and Chia comes back at the next start,
//! never in the middle of a run: the Bank's off in reverse. While
//! `SSF_NO_CHIA_LANE` is set, the in-game on is refused; an off is saved
//! then too, so it holds once the variable is gone. A file that is there but
//! cannot be read counts as off, and the startup line says so.
//!
//! For the process, Chia is off while `SSF_NO_CHIA_LANE` is set, when the
//! file said off (or could not be read) at the start, and from an in-game
//! off on ([`LaneSwitch`]). It never comes back on within a run.
//!
//! Off wins over `SSF_CHIA_LANE=1`, the Bank's remembered switch,
//! `SSF_CHIA_BEACON`, `SSF_CHIA_FINDABLE`, `SSF_CHIA_WATCH`, `SSF_CHIA_PEERS`
//! and the env test hooks. It does not touch iroh, the Mainline DHT, mDNS or
//! relays: they keep their own switches.
//!
//! It holds in three layers:
//!   1. the lane (chia_peer_lane.rs): off at the start, the process's one
//!      lane is built closed (`Lane::closed`: no pins, no peer store); the
//!      in-game off closes it while it runs (`Lane::close`: its connections
//!      are closed). A closed lane refuses every request before it dials,
//!      resolves or reads anything, so even a call site someone forgot
//!      cannot reach a peer;
//!   2. the tasks (main.rs, [`task_plan`]): off at the start, the watcher is
//!      not spawned and the wallet does not load (so no publisher and no
//!      test hook). The watcher and the publisher ask [`strict`] at every
//!      tick, and rung 6, the beacon fallback and the dish at every call, so
//!      after an in-game off they read and write nothing more; the dish
//!      answers off before it builds a chain client;
//!   3. the switches: the Bank's TURN ON is refused
//!      (chia_wallet_switch::turn_refusal), and a startup line says this
//!      switch wins over `SSF_CHIA_LANE=1` ([`wins_line`]).
//!
//! The loopback fingerprint carries [`LaneView`] (`chia_lane`) for the page.
//!
//! A wallet loaded before an in-game off stays loaded until the node stops,
//! and publishes nothing. Spends already parked by an earlier run stay
//! parked: off at the start, the wallet and its lease do not load, so
//! `wallet_lease.json` is left as it is, and the next start with Chia on
//! settles them.
//!
//! Every decision rests on a pure function or on a [`LaneSwitch`], and a
//! test makes a switch of its own over a file of its own, so the tests never
//! touch the process environment, the process's switch or the node's file.

use std::ffi::OsStr;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use serde::{Deserialize, Serialize};

/// What a closed lane answers, and the start of every refusal that follows
/// from it. A plain sentence: the player may read it.
#[cfg_attr(not(feature = "chia-read"), allow(dead_code))]
pub const OFF_WORDS: &str = "Chia is off on this computer";

/// Classify a raw `SSF_NO_CHIA_LANE` value: `true` turns the lane off.
/// Unset, empty or exactly `0` is not strict; anything else is (fails closed).
pub fn strict_of(raw: Option<&OsStr>) -> bool {
    match raw {
        None => false,
        Some(v) => !(v.is_empty() || v == OsStr::new("0")),
    }
}

/// The in-game switch's file, at the data root (the node's working
/// directory, beside `iroh_node_id.key`), on every network: one switch
/// covers every chain, so it is never opened through `ChiaNet::path`. There
/// while Chia is turned off in the SpacePhone's Network settings; no file
/// means on.
pub const LANE_FILE: &str = "chia_lane_off.json";

/// The in-game switch's file's contents.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct LaneFile {
    pub off: bool,
    /// When Chia was turned off, unix seconds (for the operator reading it).
    #[serde(default)]
    pub at: u64,
}

/// What the in-game switch's file says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Saved {
    /// No file, or one that says `"off": false`: Chia on.
    On,
    /// The file says `"off": true`.
    Off,
    /// The file is there but cannot be read, or is not a switch the node can
    /// read: counts as off. The reason, in the node's words.
    Damaged(String),
    /// A folder by the file's name: counts as off, like a damaged file, and
    /// the in-game on cannot remove it (it removes a file, never a folder),
    /// so only its removal by hand brings Chia back. The reason, in the
    /// node's words.
    Folder(String),
}

impl Saved {
    /// Whether this holds Chia off: off, a damaged file or a folder (fails
    /// closed).
    pub fn off(&self) -> bool {
        !matches!(self, Saved::On)
    }
}

/// Read the in-game switch's file at `path` ([`Saved`]).
pub fn saved_of(path: &Path) -> Saved {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<LaneFile>(&bytes) {
            Ok(file) if file.off => Saved::Off,
            Ok(_) => Saved::On,
            Err(e) => Saved::Damaged(format!("{} is not a Chia switch the node can read ({e})", path.display())),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Saved::On,
        Err(_) if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) => {
            Saved::Folder(format!("{} is a folder, not a Chia switch the node can read", path.display()))
        }
        Err(e) => Saved::Damaged(format!("{} cannot be read ({e})", path.display())),
    }
}

/// Save the in-game off at `path`: written whole (a temporary file renamed
/// over it, the directory synced), owner-only (private_file.rs).
pub fn save_off(path: &Path, now: u64) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&LaneFile { off: true, at: now }).map_err(std::io::Error::other)?;
    crate::private_file::write_private(path, &bytes)
}

/// Turn the in-game switch back on: the file at `path` is removed (a missing
/// one counts as removed), the directory synced.
pub fn forget(path: &Path) -> std::io::Result<()> {
    crate::private_file::remove_private(path)
}

/// The time now, in unix seconds, for the file's `at`.
pub fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Why Chia is off, as the fingerprint says it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OffSource {
    /// `SSF_NO_CHIA_LANE` in the node's environment.
    Env,
    /// The Chia switch in the SpacePhone's Network settings: its file said
    /// off, or could not be read, at the start, or it was turned off this run.
    Setting,
}

/// What turns Chia off, from `env` (`SSF_NO_CHIA_LANE`) and `setting` (the
/// in-game switch holds it off this run): `None` while it is on. The
/// environment wins when both hold it off, since only it is beyond the
/// SpacePhone's reach.
pub fn off_source_of(env: bool, setting: bool) -> Option<OffSource> {
    if env {
        Some(OffSource::Env)
    } else if setting {
        Some(OffSource::Setting)
    } else {
        None
    }
}

/// What turned Chia off, in a log line's words: the lane's startup line
/// puts them in brackets after [`OFF_WORDS`].
pub fn source_words(source: OffSource) -> &'static str {
    match source {
        OffSource::Env => "SSF_NO_CHIA_LANE",
        OffSource::Setting => "the Chia switch in the SpacePhone's Network settings",
    }
}

/// What the in-game switch's file says now, as the fingerprint says it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Setting {
    /// No file: the next start reads Chia on, unless `SSF_NO_CHIA_LANE` is
    /// set there.
    #[default]
    On,
    /// The file says off, or cannot be read: the next start reads Chia off.
    Off,
}

/// The fingerprint's `chia_lane`, for the page:
///   - `off`: whether Chia is off on this computer now;
///   - `source`, only while it is: `env` for `SSF_NO_CHIA_LANE` (which wins
///     when both hold it off), `setting` for the in-game switch;
///   - `setting`: what the switch's file says now, which the next start
///     reads: `off` with `off` false shows only for the moment an in-game
///     off has saved the switch and not yet held Chia off, and `on` while
///     `off` is true with the source `setting` is "off now, on at the next
///     start";
///   - `damaged`, only when true: the file is there but cannot be read, so
///     it counts as off;
///   - `stuck`, only when true (with `damaged`): it is a folder, which the
///     in-game on cannot remove, so only its removal by hand brings Chia
///     back.
///
/// The node cannot know whether `SSF_NO_CHIA_LANE` is set at its next start,
/// so it says what the switch says and leaves the next start to the page's
/// words. A page that knows only `off` still reads it; an older node sends
/// `{"off": ...}` and a source alone, and parses back with `setting` on.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct LaneView {
    pub off: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<OffSource>,
    #[serde(default)]
    pub setting: Setting,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub damaged: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stuck: bool,
}

/// The view of `source` ([`off_source_of`]) and of the file as it reads now.
pub fn view_of(source: Option<OffSource>, saved: &Saved) -> LaneView {
    LaneView {
        off: source.is_some(),
        source,
        setting: if saved.off() { Setting::Off } else { Setting::On },
        damaged: matches!(saved, Saved::Damaged(_) | Saved::Folder(_)),
        stuck: matches!(saved, Saved::Folder(_)),
    }
}

/// The route's query: `/api/chia/lane?on=0` turns Chia off, `on=1` back on,
/// nothing else.
pub fn lane_asked(target: &str) -> Option<bool> {
    let (path, query) = target.split_once('?')?;
    if path != "/api/chia/lane" {
        return None;
    }
    match query {
        "on=1" => Some(true),
        "on=0" => Some(false),
        _ => None,
    }
}

/// The route's refusal for a request from anything but this computer's own
/// game page (chia_wallet_switch::local_page).
pub const PAGE_ONLY_WORDS: &str = "only this computer's own Star Station page can turn Chia off or on";

/// The route's refusal for a query it does not know.
pub const BAD_ASK_WORDS: &str = "ask with on=1 or on=0";

/// The route's gate and query: `Ok(on)` for a turn to make, or the refusal's
/// status and body. `local` is chia_wallet_switch::local_page, the wallet
/// switch's gate: an allowed loopback or desktop-app Origin, never a web
/// origin or none, sent to a loopback Host on the API's own port.
pub fn lane_gate(local: bool, target: &str) -> Result<bool, (&'static str, serde_json::Value)> {
    if !local {
        return Err(("403 Forbidden", serde_json::json!({ "ok": false, "error": PAGE_ONLY_WORDS })));
    }
    lane_asked(target).ok_or(("400 Bad Request", serde_json::json!({ "ok": false, "error": BAD_ASK_WORDS })))
}

/// The in-game on's refusal while `SSF_NO_CHIA_LANE` is set.
pub const ENV_HOLDS_WORDS: &str = "SSF_NO_CHIA_LANE in the node's environment holds Chia off on this computer, so the SpacePhone cannot turn it on; start the node without it";

/// What a turn of the in-game switch does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LanePlan {
    /// Save the off, hold Chia off for this run and close the lane.
    Off,
    /// Remove the file: Chia is on at the next start. `off_now`: it stays
    /// off until then.
    On { off_now: bool },
    /// Refused, with the words.
    Refused(&'static str),
}

/// The turn for `on`, with `env` (`SSF_NO_CHIA_LANE`) and whether Chia is
/// off now: an on is refused while the environment holds Chia off, since
/// the switch cannot change it; an off is always taken, under the
/// environment too, so it holds once the variable is gone.
pub fn lane_plan(env: bool, on: bool, off_now: bool) -> LanePlan {
    match (on, env) {
        (false, _) => LanePlan::Off,
        (true, true) => LanePlan::Refused(ENV_HOLDS_WORDS),
        (true, false) => LanePlan::On { off_now },
    }
}

/// The words for an off whose save failed with `err`, from the file read
/// back (`reread`), with `env` (`SSF_NO_CHIA_LANE`): a failed save does not
/// show what the file now holds (the rename can land and the directory sync
/// after it fail). Chia is off for this run either way. With no switch
/// saved, the next start brings Chia back only without `SSF_NO_CHIA_LANE`,
/// so under it the words say so.
pub fn after_failed_off(err: &str, reread: &Saved, env: bool) -> String {
    match reread {
        Saved::Off => format!("Chia is off now; the switch was written but not confirmed on disk ({err}), so Chia should stay off at the next start"),
        Saved::Damaged(why) | Saved::Folder(why) => format!("Chia is off now, but the switch could not be saved ({err}), and {why}, which counts as off, so Chia stays off at the next start"),
        Saved::On if env => format!("SSF_NO_CHIA_LANE in the node's environment holds Chia off now, but the switch could not be saved ({err}), so Chia comes back on at a start without SSF_NO_CHIA_LANE"),
        Saved::On => format!("Chia is off now, but the switch could not be saved ({err}), so Chia comes back on at the next start"),
    }
}

/// The words for an on whose removal failed with `err`, from the file read
/// back (`reread`), with `off_now` whether Chia is off for this run. A
/// folder is named, since only its removal by hand brings Chia back.
pub fn after_failed_on(err: &str, reread: &Saved, off_now: bool) -> String {
    match reread {
        Saved::On => format!(
            "the switch was turned back on but not confirmed on disk ({err}), so Chia should come back on at the next start{}",
            if off_now { "; it stays off until then" } else { "" }
        ),
        Saved::Off | Saved::Damaged(_) => format!("the switch could not be turned back on ({err}), so Chia stays off at the next start"),
        Saved::Folder(why) => format!(
            "the switch could not be turned back on ({err}): {why}, which the switch cannot remove, so Chia stays off at the next start until the folder is removed by hand"
        ),
    }
}

/// The note of a turn that was taken, for the page: `on`, `env`
/// (`SSF_NO_CHIA_LANE`) and whether Chia is off for this run.
pub fn turned_note(on: bool, env: bool, off_now: bool) -> &'static str {
    match (on, env, off_now) {
        (false, false, _) => "Chia is off on this computer now, and stays off at every start until it is turned back on here.",
        (false, true, _) => "Chia was already off (SSF_NO_CHIA_LANE in the node's environment); the switch is saved off too, so Chia stays off once that is gone.",
        (true, _, true) => "Chia comes back on at the next start of the node; it stays off until then.",
        (true, _, false) => "Chia is on.",
    }
}

/// The log line of a turn that was taken.
pub fn turned_line(on: bool, env: bool, off_now: bool) -> &'static str {
    match (on, env, off_now) {
        (false, false, _) => "⛓️ Chia: turned off in the SpacePhone's Network settings — every connection to a Chia full node is closed and none is made from now on, and Chia stays off at every start until it is turned back on there",
        (false, true, _) => "⛓️ Chia: turned off in the SpacePhone's Network settings and saved — SSF_NO_CHIA_LANE already holds it off, and the switch keeps it off at a start without it",
        (true, _, true) => "⛓️ Chia: turned back on in the SpacePhone's Network settings — it stays off until the node stops and is back on at the next start",
        (true, _, false) => "⛓️ Chia: kept on in the SpacePhone's Network settings",
    }
}

/// The answer of one turn of the in-game switch, and what the node says.
#[derive(Clone, Debug, PartialEq)]
pub struct LaneTurn {
    /// The route's status line: 200, or 409 for a refusal or a failed save.
    pub status: &'static str,
    /// `{"ok": true, "lane", "note"}` or `{"ok": false, "error", "lane"}`,
    /// with the switch's view after the turn as `lane` ([`LaneView`]).
    pub body: serde_json::Value,
    /// The log line, if any: none for a refusal.
    pub line: Option<String>,
    /// The line is a failure's, for stderr.
    pub failed: bool,
    /// This turn took Chia off: it was on for this run before it.
    pub turned_off: bool,
}

impl LaneTurn {
    fn taken(note: &str, view: LaneView, line: &str, turned_off: bool) -> Self {
        Self {
            status: "200 OK",
            body: serde_json::json!({ "ok": true, "lane": view, "note": note }),
            line: Some(line.to_string()),
            failed: false,
            turned_off,
        }
    }

    fn refused(error: &str, view: LaneView, line: Option<String>, turned_off: bool) -> Self {
        Self {
            status: "409 Conflict",
            body: serde_json::json!({ "ok": false, "error": error, "lane": view }),
            failed: line.is_some(),
            line,
            turned_off,
        }
    }
}

/// The in-game switch of one process, over its file, and what the
/// environment said: the process has one ([`process`]), and a test makes its
/// own over a file of its own.
pub struct LaneSwitch {
    path: PathBuf,
    /// `SSF_NO_CHIA_LANE`, as the process read it.
    env: bool,
    /// The file as it read at the start.
    at_start: Saved,
    /// Turned off this run (never cleared: Chia never comes back on within
    /// a run).
    hot_off: AtomicBool,
    /// The file as it reads now: the start's, then each turn's.
    saved: Mutex<Saved>,
    /// One turn at a time: an on never removes the file while an off is
    /// saving it or closing the lane.
    turning: tokio::sync::Mutex<()>,
}

impl LaneSwitch {
    /// The switch over `path`, read now, with `env` for `SSF_NO_CHIA_LANE`.
    pub fn read(env: bool, path: PathBuf) -> Self {
        let at_start = saved_of(&path);
        Self {
            path,
            env,
            saved: Mutex::new(at_start.clone()),
            at_start,
            hot_off: AtomicBool::new(false),
            turning: tokio::sync::Mutex::new(()),
        }
    }

    /// What held Chia off at the start, if anything: what the startup reads
    /// on purpose (the lane's build, the tasks, the wallet's start).
    pub fn source_at_start(&self) -> Option<OffSource> {
        off_source_of(self.env, self.at_start.off())
    }

    /// What holds Chia off now, if anything.
    pub fn off_source(&self) -> Option<OffSource> {
        off_source_of(self.env, self.at_start.off() || self.hot_off.load(Ordering::SeqCst))
    }

    /// Whether Chia is off now.
    pub fn strict(&self) -> bool {
        self.off_source().is_some()
    }

    /// What the file says now.
    pub fn saved(&self) -> Saved {
        self.saved.lock().unwrap().clone()
    }

    /// The fingerprint's view.
    pub fn view(&self) -> LaneView {
        view_of(self.off_source(), &self.saved())
    }

    /// The startup line for the file, and whether it is said on stderr (a
    /// damaged file): none while the file reads on.
    pub fn startup_line(&self) -> Option<(String, bool)> {
        startup_line_of(self.env, &self.at_start)
    }

    /// Turn Chia off (`on` false) or back on, one turn at a time. Off saves
    /// the file, holds Chia off for this run even if the save failed, then
    /// awaits `close` (the lane's close, once no wallet turn runs) and
    /// answers once it returned. On removes the file, unless
    /// `SSF_NO_CHIA_LANE` holds Chia off, and leaves this run as it is. A
    /// failed save or removal answers 409 with what the file now says, read
    /// back.
    pub async fn turn<C, F>(&self, on: bool, now: u64, close: C) -> LaneTurn
    where
        C: FnOnce() -> F,
        F: Future<Output = ()>,
    {
        let _one = self.turning.lock().await;
        let off_now = self.strict();
        match lane_plan(self.env, on, off_now) {
            LanePlan::Refused(why) => LaneTurn::refused(why, self.view(), None, false),
            LanePlan::Off => {
                let saved = save_off(&self.path, now);
                let reread = match &saved {
                    Ok(()) => Saved::Off,
                    Err(_) => saved_of(&self.path),
                };
                *self.saved.lock().unwrap() = reread.clone();
                self.hot_off.store(true, Ordering::SeqCst);
                close().await;
                let view = self.view();
                match saved {
                    Ok(()) => LaneTurn::taken(turned_note(false, self.env, true), view, turned_line(false, self.env, true), !off_now),
                    Err(e) => {
                        let why = after_failed_off(&e.to_string(), &reread, self.env);
                        LaneTurn::refused(&why, view, Some(format!("⛓️ Chia: {why}")), !off_now)
                    }
                }
            }
            LanePlan::On { off_now } => match forget(&self.path) {
                Ok(()) => {
                    *self.saved.lock().unwrap() = Saved::On;
                    LaneTurn::taken(turned_note(true, self.env, off_now), self.view(), turned_line(true, self.env, off_now), false)
                }
                Err(e) => {
                    let reread = saved_of(&self.path);
                    *self.saved.lock().unwrap() = reread.clone();
                    let why = after_failed_on(&e.to_string(), &reread, off_now);
                    LaneTurn::refused(&why, self.view(), Some(format!("⛓️ Chia: {why}")), false)
                }
            },
        }
    }
}

/// The startup line for the file as it read at the start (`saved`), with
/// `env` (`SSF_NO_CHIA_LANE`), and whether it is said on stderr: none while
/// the file reads on.
pub fn startup_line_of(env: bool, saved: &Saved) -> Option<(String, bool)> {
    match (saved, env) {
        (Saved::On, _) => None,
        (Saved::Off, false) => Some((
            format!("⛓️ Chia: off on this computer — turned off in the SpacePhone's Network settings ({LANE_FILE}). No Chia full node is asked and no SSF wallet loads; turning Chia back on there brings it back at the next start."),
            false,
        )),
        (Saved::Off, true) => Some((
            format!("⛓️ Chia: the Chia switch in the SpacePhone's Network settings is off too ({LANE_FILE}), so Chia stays off at a start without SSF_NO_CHIA_LANE until it is turned back on there."),
            false,
        )),
        (Saved::Damaged(why), false) => Some((
            format!("⛓️ Chia: {why}, so Chia counts as off on this computer. No Chia full node is asked and no SSF wallet loads; turning Chia on in the SpacePhone's Network settings removes the file, and Chia is back at the next start."),
            true,
        )),
        (Saved::Damaged(why), true) => Some((
            format!("⛓️ Chia: {why}, so it counts as off, and Chia stays off at a start without SSF_NO_CHIA_LANE until the file is removed or Chia is turned back on in the SpacePhone's Network settings."),
            true,
        )),
        (Saved::Folder(why), false) => Some((
            format!("⛓️ Chia: {why}, so Chia counts as off on this computer. No Chia full node is asked and no SSF wallet loads; the Chia switch in the SpacePhone's Network settings cannot remove a folder, so Chia is back at the next start once the folder is removed by hand."),
            true,
        )),
        (Saved::Folder(why), true) => Some((
            format!("⛓️ Chia: {why}, so it counts as off, and Chia stays off at a start without SSF_NO_CHIA_LANE until the folder is removed by hand: the Chia switch in the SpacePhone's Network settings cannot remove a folder."),
            true,
        )),
    }
}

/// The process's switch: `SSF_NO_CHIA_LANE` and [`LANE_FILE`] at the data
/// root, read once, by whichever caller comes first (main.rs reads it with
/// the first startup line, before anything else asks).
static PROCESS: LazyLock<LaneSwitch> =
    LazyLock::new(|| LaneSwitch::read(strict_of(std::env::var_os("SSF_NO_CHIA_LANE").as_deref()), PathBuf::from(LANE_FILE)));

/// The process's switch, for the route.
pub fn process() -> &'static LaneSwitch {
    &PROCESS
}

/// What held Chia off at the start of this process, if anything.
pub fn source_at_start() -> Option<OffSource> {
    PROCESS.source_at_start()
}

/// What holds Chia off for this process now, if anything.
#[cfg_attr(not(feature = "chia-read"), allow(dead_code))]
pub fn off_source() -> Option<OffSource> {
    PROCESS.off_source()
}

/// Whether Chia is off for this process now: at the start, or from an
/// in-game off on.
#[cfg_attr(not(feature = "chia-read"), allow(dead_code))]
pub fn strict() -> bool {
    PROCESS.strict()
}

/// This process's view, for the fingerprint.
pub fn view() -> LaneView {
    PROCESS.view()
}

/// The startup line for the in-game switch's file, if any, and whether it
/// is said on stderr.
pub fn startup_line() -> Option<(String, bool)> {
    PROCESS.startup_line()
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

/// The startup line for `SSF_NO_CHIA_LANE` and `SSF_CHIA_LANE=1` set at once.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const WINS_WORDS: &str = "🏦 SSF wallet: SSF_NO_CHIA_LANE wins over SSF_CHIA_LANE=1. Chia is off on this computer, so the wallet stays off.";

/// The startup line for the in-game off and `SSF_CHIA_LANE=1` at once.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const SETTING_WINS_WORDS: &str = "🏦 SSF wallet: the Chia switch in the SpacePhone's Network settings wins over SSF_CHIA_LANE=1. Chia is off on this computer, so the wallet stays off.";

/// The startup line that says what holds Chia off (`source`) wins over
/// `SSF_CHIA_LANE=1` (`chia_lane_on`), when both are set.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn wins_line(source: Option<OffSource>, chia_lane_on: bool) -> Option<&'static str> {
    match source.filter(|_| chia_lane_on)? {
        OffSource::Env => Some(WINS_WORDS),
        OffSource::Setting => Some(SETTING_WINS_WORDS),
    }
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

    /// A folder of the test's own, removed when dropped.
    struct Dir(PathBuf);

    impl Dir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("ssf-lane-{tag}-{}-{}", std::process::id(), rand::random::<u64>()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self) -> PathBuf {
            self.0.join(LANE_FILE)
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// The file's reading: none is on, `"off": true` is off, `"off": false`
    /// is on, and anything the node cannot read, or read as a switch, is
    /// damaged, which counts as off.
    #[test]
    fn the_file_reads_on_when_missing_and_off_when_it_says_so_or_cannot_be_read() {
        let dir = Dir::new("read");
        let path = dir.file();
        assert_eq!(saved_of(&path), Saved::On, "no file");
        let cases: [(&[u8], bool, bool); 10] = [
            (br#"{"off":true,"at":1762150000}"#, true, false),
            (br#"{"off":true}"#, true, false),
            (br#"{"off": false, "at": 5}"#, false, false),
            (br#"{"off":true,"by":"someone"}"#, true, false),
            (b"", true, true),
            (b"{}", true, true),
            (br#"{"off":"yes"}"#, true, true),
            (br#"{"off":1}"#, true, true),
            (b"off", true, true),
            (b"\xff\xfe", true, true),
        ];
        for (bytes, saved_off, damaged) in cases {
            std::fs::write(&path, bytes).unwrap();
            let saved = saved_of(&path);
            let case = String::from_utf8_lossy(bytes).into_owned();
            assert_eq!(saved.off(), saved_off, "{case:?}: {saved:?}");
            assert_eq!(matches!(saved, Saved::Damaged(_)), damaged, "{case:?}: {saved:?}");
            if let Saved::Damaged(why) = &saved {
                assert!(why.contains(LANE_FILE) && why.contains("is not a Chia switch the node can read"), "{why}");
            }
        }
        // Something there that cannot be read at all: a folder by that name,
        // which counts as off and which the on cannot remove.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir_all(&path).unwrap();
        match saved_of(&path) {
            Saved::Folder(why) => assert!(why.contains(LANE_FILE) && why.contains("is a folder, not a Chia switch the node can read"), "{why}"),
            other => panic!("a folder is a folder, not {other:?}"),
        }
        assert!(saved_of(&path).off());
        assert!(forget(&path).is_err(), "the on removes a file, never a folder");
        // A link to a folder cannot be read either, but it is the link the on
        // removes: damaged, not a folder.
        #[cfg(unix)]
        {
            let link = dir.0.join("link-to-a-folder.json");
            std::os::unix::fs::symlink(&path, &link).unwrap();
            match saved_of(&link) {
                Saved::Damaged(why) => assert!(why.contains("cannot be read"), "{why}"),
                other => panic!("a link to a folder is damaged, not {other:?}"),
            }
            forget(&link).unwrap();
            assert!(!link.exists() && path.is_dir(), "the link is removed, the folder kept");
        }
    }

    /// The off is saved owner-only, with when, and reads back off; the on
    /// removes it, and a missing file counts as removed.
    #[test]
    fn the_off_is_saved_owner_only_and_the_on_removes_it() {
        let dir = Dir::new("save");
        let path = dir.file();
        save_off(&path, 1_762_150_000).unwrap();
        assert_eq!(saved_of(&path), Saved::Off);
        let file: LaneFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file, LaneFile { off: true, at: 1_762_150_000 });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600, "owner-only");
        }
        forget(&path).unwrap();
        assert!(!path.exists());
        assert_eq!(saved_of(&path), Saved::On);
        forget(&path).expect("a missing file counts as removed");
    }

    #[test]
    fn the_environment_wins_and_either_source_turns_chia_off() {
        assert_eq!(off_source_of(false, false), None);
        assert_eq!(off_source_of(true, false), Some(OffSource::Env));
        assert_eq!(off_source_of(false, true), Some(OffSource::Setting));
        assert_eq!(off_source_of(true, true), Some(OffSource::Env), "the environment wins: only it is beyond the SpacePhone");
        assert_eq!(source_words(OffSource::Env), "SSF_NO_CHIA_LANE");
        assert!(source_words(OffSource::Setting).contains("SpacePhone's Network settings"));
    }

    /// The fingerprint's field: off and why while off, what the file says
    /// always, and damaged only when it is. Additive: a view from an older
    /// node, with no setting, parses back with the setting on.
    #[test]
    fn the_fingerprint_says_off_why_and_what_the_switch_says() {
        let json = |source, saved: &Saved| serde_json::to_string(&view_of(source, saved)).unwrap();
        assert_eq!(json(None, &Saved::On), r#"{"off":false,"setting":"on"}"#);
        assert_eq!(json(Some(OffSource::Env), &Saved::On), r#"{"off":true,"source":"env","setting":"on"}"#);
        assert_eq!(json(Some(OffSource::Setting), &Saved::Off), r#"{"off":true,"source":"setting","setting":"off"}"#);
        assert_eq!(json(Some(OffSource::Env), &Saved::Off), r#"{"off":true,"source":"env","setting":"off"}"#);
        assert_eq!(
            json(Some(OffSource::Setting), &Saved::On),
            r#"{"off":true,"source":"setting","setting":"on"}"#,
            "off now, on at the next start"
        );
        assert_eq!(
            json(Some(OffSource::Setting), &Saved::Damaged("x".into())),
            r#"{"off":true,"source":"setting","setting":"off","damaged":true}"#
        );
        assert_eq!(
            json(Some(OffSource::Env), &Saved::Folder("x".into())),
            r#"{"off":true,"source":"env","setting":"off","damaged":true,"stuck":true}"#,
            "a folder the on cannot remove"
        );
        let older: LaneView = serde_json::from_str(r#"{"off":true,"source":"env"}"#).unwrap();
        assert_eq!(older, LaneView { off: true, source: Some(OffSource::Env), setting: Setting::On, damaged: false, stuck: false });
        let older: LaneView = serde_json::from_str(r#"{"off":false}"#).unwrap();
        assert_eq!(older, view_of(None, &Saved::On));
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
    fn one_line_says_what_holds_chia_off_wins_when_both_are_set() {
        assert_eq!(wins_line(Some(OffSource::Env), true), Some(WINS_WORDS));
        assert_eq!(wins_line(Some(OffSource::Setting), true), Some(SETTING_WINS_WORDS));
        for source in [Some(OffSource::Env), Some(OffSource::Setting)] {
            assert_eq!(wins_line(source, false), None, "nothing to win over");
        }
        assert_eq!(wins_line(None, true), None, "SSF_CHIA_LANE=1 alone holds the wallet on, as before");
        assert_eq!(wins_line(None, false), None);
        assert!(WINS_WORDS.contains(OFF_WORDS) && SETTING_WINS_WORDS.contains(OFF_WORDS));
        assert!(WINS_WORDS.contains("SSF_NO_CHIA_LANE wins over SSF_CHIA_LANE=1"), "the binary test's words");
        assert!(SETTING_WINS_WORDS.contains(source_words(OffSource::Setting)));
    }

    /// The route takes `on=0` or `on=1` on its own path, and nothing else;
    /// only this computer's own page passes its gate.
    #[test]
    fn the_route_takes_on_or_off_from_this_computers_page_and_nothing_else() {
        assert_eq!(lane_asked("/api/chia/lane?on=0"), Some(false));
        assert_eq!(lane_asked("/api/chia/lane?on=1"), Some(true));
        for target in [
            "/api/chia/lane",
            "/api/chia/lane?",
            "/api/chia/lane?on=2",
            "/api/chia/lane?on=",
            "/api/chia/lane?on=1&on=0",
            "/api/chia/lane?off=1",
            "/api/chia/lane/?on=0",
            "/api/chia/lanes?on=0",
            "/api/chia/wallet?on=0",
        ] {
            assert_eq!(lane_asked(target), None, "{target}");
        }
        assert_eq!(lane_gate(true, "/api/chia/lane?on=0"), Ok(false));
        assert_eq!(lane_gate(true, "/api/chia/lane?on=1"), Ok(true));
        let (status, body) = lane_gate(false, "/api/chia/lane?on=0").unwrap_err();
        assert_eq!(status, "403 Forbidden");
        assert_eq!(body, serde_json::json!({ "ok": false, "error": PAGE_ONLY_WORDS }));
        let (status, body) = lane_gate(true, "/api/chia/lane?on=yes").unwrap_err();
        assert_eq!(status, "400 Bad Request");
        assert_eq!(body, serde_json::json!({ "ok": false, "error": BAD_ASK_WORDS }));
        assert_eq!(lane_gate(false, "/api/chia/lane?on=yes").unwrap_err().0, "403 Forbidden", "the gate first");
    }

    /// An off is always taken; an on is refused while the environment holds
    /// Chia off, and otherwise says whether Chia stays off until the next
    /// start.
    #[test]
    fn the_plan_refuses_only_an_on_the_environment_holds_off() {
        for env in [false, true] {
            for off_now in [false, true] {
                assert_eq!(lane_plan(env, false, off_now), LanePlan::Off, "env {env}, off now {off_now}");
            }
        }
        assert_eq!(lane_plan(true, true, true), LanePlan::Refused(ENV_HOLDS_WORDS));
        assert_eq!(lane_plan(false, true, true), LanePlan::On { off_now: true });
        assert_eq!(lane_plan(false, true, false), LanePlan::On { off_now: false });
        assert!(ENV_HOLDS_WORDS.contains("SSF_NO_CHIA_LANE"));
    }

    /// A failed save says what the file now holds, read back, never what was
    /// asked; Chia is off now in every case of the off.
    #[test]
    fn a_failed_save_says_what_the_file_holds_not_what_was_asked() {
        let off = after_failed_off("dir sync failed", &Saved::Off, false);
        assert!(off.starts_with("Chia is off now") && off.contains("should stay off at the next start"), "{off}");
        let on = after_failed_off("disk full", &Saved::On, false);
        assert_eq!(on, "Chia is off now, but the switch could not be saved (disk full), so Chia comes back on at the next start");
        let damaged = after_failed_off("disk full", &Saved::Damaged("chia_lane_off.json cannot be read (x)".into()), false);
        assert!(damaged.contains("chia_lane_off.json cannot be read (x), which counts as off, so Chia stays off at the next start"), "{damaged}");
        let folder = after_failed_off("is a directory", &Saved::Folder("chia_lane_off.json is a folder".into()), false);
        assert!(folder.contains("chia_lane_off.json is a folder, which counts as off, so Chia stays off at the next start"), "{folder}");
        // Under SSF_NO_CHIA_LANE, with no switch saved, a next start that
        // still has the variable keeps Chia off: only one without it brings
        // Chia back.
        let env = after_failed_off("disk full", &Saved::On, true);
        assert_eq!(
            env,
            "SSF_NO_CHIA_LANE in the node's environment holds Chia off now, but the switch could not be saved (disk full), so Chia comes back on at a start without SSF_NO_CHIA_LANE"
        );
        assert!(!env.contains("comes back on at the next start"), "{env}");
        // A switch that reads off holds at every next start, with the variable or without.
        assert_eq!(after_failed_off("dir sync failed", &Saved::Off, true), off);
        assert_eq!(after_failed_off("disk full", &Saved::Damaged("chia_lane_off.json cannot be read (x)".into()), true), damaged);
        let back = after_failed_on("dir sync failed", &Saved::On, true);
        assert_eq!(back, "the switch was turned back on but not confirmed on disk (dir sync failed), so Chia should come back on at the next start; it stays off until then");
        assert!(!after_failed_on("x", &Saved::On, false).contains("until then"));
        for reread in [Saved::Off, Saved::Damaged("y".into())] {
            assert_eq!(after_failed_on("busy", &reread, true), "the switch could not be turned back on (busy), so Chia stays off at the next start");
        }
        assert_eq!(
            after_failed_on("is a directory", &Saved::Folder("chia_lane_off.json is a folder".into()), true),
            "the switch could not be turned back on (is a directory): chia_lane_off.json is a folder, which the switch cannot remove, so Chia stays off at the next start until the folder is removed by hand"
        );
    }

    /// A switch of its own: the file as it reads at the start decides the
    /// start, and the startup line says the file's off, or that it is
    /// damaged (on stderr), and nothing while it reads on.
    #[test]
    fn the_file_at_the_start_turns_chia_off_and_the_startup_line_says_so() {
        let dir = Dir::new("start");
        let path = dir.file();
        let on = LaneSwitch::read(false, path.clone());
        assert_eq!((on.source_at_start(), on.off_source()), (None, None));
        assert_eq!(on.startup_line(), None, "nothing said while the file reads on");
        assert_eq!(on.view(), view_of(None, &Saved::On));
        assert_eq!(LaneSwitch::read(true, path.clone()).source_at_start(), Some(OffSource::Env));
        assert_eq!(LaneSwitch::read(true, path.clone()).startup_line(), None, "the env's own lines say it");

        save_off(&path, 1).unwrap();
        let off = LaneSwitch::read(false, path.clone());
        assert_eq!(off.source_at_start(), Some(OffSource::Setting));
        assert!(off.strict());
        assert_eq!(off.view(), LaneView { off: true, source: Some(OffSource::Setting), setting: Setting::Off, damaged: false, stuck: false });
        let (line, err) = off.startup_line().unwrap();
        assert!(!err && line.contains("turned off in the SpacePhone's Network settings (chia_lane_off.json)"), "{line}");
        let (line, err) = LaneSwitch::read(true, path.clone()).startup_line().unwrap();
        assert!(!err && line.contains("off too") && line.contains("at a start without SSF_NO_CHIA_LANE"), "{line}");

        std::fs::write(&path, b"{").unwrap();
        let damaged = LaneSwitch::read(false, path.clone());
        assert_eq!(damaged.source_at_start(), Some(OffSource::Setting), "a damaged file counts as off");
        assert!(damaged.view().damaged && damaged.view().setting == Setting::Off);
        let (line, err) = damaged.startup_line().unwrap();
        assert!(err && line.contains("is not a Chia switch the node can read") && line.contains("so Chia counts as off"), "{line}");
        let (line, err) = LaneSwitch::read(true, path.clone()).startup_line().unwrap();
        assert!(err && line.contains("so it counts as off"), "{line}");

        // A folder by the file's name: off, and the line never promises that
        // the switch removes it, since it cannot.
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir_all(&path).unwrap();
        let folder = LaneSwitch::read(false, path.clone());
        assert_eq!(folder.source_at_start(), Some(OffSource::Setting), "a folder counts as off");
        assert_eq!(folder.view(), LaneView { off: true, source: Some(OffSource::Setting), setting: Setting::Off, damaged: true, stuck: true });
        let (line, err) = folder.startup_line().unwrap();
        assert!(err && line.contains("is a folder, not a Chia switch the node can read") && line.contains("so Chia counts as off"), "{line}");
        assert!(line.contains("cannot remove a folder") && line.contains("once the folder is removed by hand"), "{line}");
        let (env_line, err) = LaneSwitch::read(true, path.clone()).startup_line().unwrap();
        assert!(err && env_line.contains("until the folder is removed by hand") && env_line.contains("cannot remove a folder"), "{env_line}");
        for line in [&line, &env_line] {
            assert!(!line.contains("removes the file") && !line.contains("or Chia is turned back on"), "no promise the on cannot keep: {line}");
        }
        for (line, _) in [off.startup_line().unwrap(), damaged.startup_line().unwrap(), folder.startup_line().unwrap()] {
            assert!(!line.contains("SSF_NO_CHIA_LANE wins") && !line.contains("Chain lane: off"), "never the env's lines: {line}");
        }
    }

    /// The in-game off: the file is saved owner-only and Chia is off for
    /// this run before the lane is closed, the close is awaited once, and
    /// the answer comes after it. Chia never comes back on within the run:
    /// the on removes the file and says the next start brings it back.
    #[tokio::test]
    async fn the_off_saves_then_holds_chia_off_then_closes_and_the_on_waits_for_the_next_start() {
        let dir = Dir::new("turn");
        let path = dir.file();
        let switch = LaneSwitch::read(false, path.clone());
        let closes = std::cell::Cell::new(0);
        let off = switch
            .turn(false, 1_762_150_000, || {
                // Before the close: the file is saved and Chia is off.
                assert_eq!(saved_of(&path), Saved::Off, "saved before the close");
                assert_eq!(switch.off_source(), Some(OffSource::Setting), "off before the close");
                closes.set(closes.get() + 1);
                async {}
            })
            .await;
        assert_eq!(closes.get(), 1);
        assert_eq!(off.status, "200 OK");
        assert!(off.turned_off && !off.failed);
        assert_eq!(off.line.as_deref(), Some(turned_line(false, false, true)));
        let lane = LaneView { off: true, source: Some(OffSource::Setting), setting: Setting::Off, damaged: false, stuck: false };
        assert_eq!(off.body, serde_json::json!({ "ok": true, "lane": lane, "note": turned_note(false, false, true) }));
        let file: LaneFile = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(file, LaneFile { off: true, at: 1_762_150_000 });
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600, "owner-only");
        }
        assert_eq!(switch.source_at_start(), None, "the start's reading is kept");

        // A second off: taken, Chia was already off this run.
        let again = switch.turn(false, 1_762_150_100, || async {}).await;
        assert_eq!(again.status, "200 OK");
        assert!(!again.turned_off, "Chia was off before it");

        let on = switch.turn(true, 0, || -> std::future::Ready<()> { panic!("an on closes nothing") }).await;
        assert_eq!(on.status, "200 OK");
        assert!(!path.exists(), "the file is removed");
        assert!(switch.strict(), "Chia stays off until the node stops");
        let lane = LaneView { off: true, source: Some(OffSource::Setting), setting: Setting::On, damaged: false, stuck: false };
        assert_eq!(on.body, serde_json::json!({ "ok": true, "lane": lane, "note": turned_note(true, false, true) }));
        assert!(turned_note(true, false, true).contains("next start"));
        assert_eq!(on.line.as_deref(), Some(turned_line(true, false, true)));
        // The next start reads it on.
        assert_eq!(LaneSwitch::read(false, path.clone()).source_at_start(), None);

        // An on while Chia is on: the file stays away, and it says so.
        let fresh = LaneSwitch::read(false, path.clone());
        let kept = fresh.turn(true, 0, || async {}).await;
        assert_eq!(kept.status, "200 OK");
        assert_eq!(kept.body["note"], "Chia is on.");
        assert!(!fresh.strict() && !path.exists());
    }

    /// Under `SSF_NO_CHIA_LANE`: the on is refused with the reason and
    /// changes nothing; the off is taken and saved, so it holds once the
    /// variable is gone, and the environment stays the source.
    #[tokio::test]
    async fn under_the_environment_the_on_is_refused_and_the_off_is_saved() {
        let dir = Dir::new("env");
        let path = dir.file();
        let switch = LaneSwitch::read(true, path.clone());
        let on = switch.turn(true, 0, || -> std::future::Ready<()> { panic!("a refusal closes nothing") }).await;
        assert_eq!(on.status, "409 Conflict");
        assert_eq!(on.body["error"], ENV_HOLDS_WORDS);
        assert_eq!(on.body["lane"]["source"], "env");
        assert_eq!(on.line, None, "a refusal is not logged");
        assert!(!path.exists(), "nothing written");
        save_off(&path, 1).unwrap();
        let refused = LaneSwitch::read(true, path.clone()).turn(true, 0, || async {}).await;
        assert_eq!(refused.status, "409 Conflict");
        assert_eq!(saved_of(&path), Saved::Off, "nothing removed");
        std::fs::remove_file(&path).unwrap();

        let off = switch.turn(false, 7, || async {}).await;
        assert_eq!(off.status, "200 OK");
        assert!(!off.turned_off, "the environment held it off already");
        assert_eq!(saved_of(&path), Saved::Off, "saved for a start without the variable");
        assert_eq!(off.body["lane"], serde_json::json!({ "off": true, "source": "env", "setting": "off" }));
        assert_eq!(off.body["note"], turned_note(false, true, true));
        assert_eq!(LaneSwitch::read(false, path.clone()).source_at_start(), Some(OffSource::Setting), "a start without it reads the file off");
    }

    /// A save that fails still holds Chia off for this run and still closes
    /// the lane; the answer is 409 with what the file says, read back. A
    /// removal that fails leaves Chia off at the next start, and says so.
    #[tokio::test]
    async fn a_failed_turn_answers_with_what_the_file_now_says() {
        let dir = Dir::new("fail");
        let missing = dir.0.join("no-such-folder").join(LANE_FILE);
        let switch = LaneSwitch::read(false, missing.clone());
        let closes = std::cell::Cell::new(0);
        let off = switch
            .turn(false, 1, || {
                closes.set(closes.get() + 1);
                async {}
            })
            .await;
        assert_eq!(closes.get(), 1, "the lane is closed though the save failed");
        assert_eq!(off.status, "409 Conflict");
        assert!(off.failed && off.turned_off);
        assert!(switch.strict(), "Chia is off for this run");
        let error = off.body["error"].as_str().unwrap();
        assert!(error.starts_with("Chia is off now, but the switch could not be saved (") && error.ends_with("so Chia comes back on at the next start"), "{error}");
        assert_eq!(off.body["lane"], serde_json::json!({ "off": true, "source": "setting", "setting": "on" }));
        assert_eq!(off.line, Some(format!("⛓️ Chia: {error}")));

        // The same failure under SSF_NO_CHIA_LANE: the environment held Chia
        // off already, and the words name the start that brings it back.
        let env = LaneSwitch::read(true, missing.clone());
        let off = env.turn(false, 1, || async {}).await;
        assert_eq!(off.status, "409 Conflict");
        assert!(off.failed && !off.turned_off, "the environment held Chia off already");
        let error = off.body["error"].as_str().unwrap();
        assert!(
            error.starts_with("SSF_NO_CHIA_LANE in the node's environment holds Chia off now, but the switch could not be saved (")
                && error.ends_with("so Chia comes back on at a start without SSF_NO_CHIA_LANE"),
            "{error}"
        );
        assert_eq!(off.body["lane"], serde_json::json!({ "off": true, "source": "env", "setting": "on" }));
        assert_eq!(off.line, Some(format!("⛓️ Chia: {error}")));

        // A folder where the file should be: damaged at the start (off), and
        // the on cannot remove it.
        let path = dir.file();
        std::fs::create_dir_all(&path).unwrap();
        let switch = LaneSwitch::read(false, path.clone());
        assert_eq!(switch.source_at_start(), Some(OffSource::Setting));
        let on = switch.turn(true, 0, || async {}).await;
        assert_eq!(on.status, "409 Conflict");
        assert!(on.failed);
        let error = on.body["error"].as_str().unwrap();
        assert!(error.starts_with("the switch could not be turned back on (") && error.ends_with("so Chia stays off at the next start until the folder is removed by hand"), "{error}");
        assert!(error.contains(&format!("{} is a folder", path.display())), "the folder is named: {error}");
        assert_eq!(on.body["lane"], serde_json::json!({ "off": true, "source": "setting", "setting": "off", "damaged": true, "stuck": true }));
    }

    /// One turn at a time: an on asked while an off is closing the lane
    /// waits for it, so it never answers first, and it removes the file the
    /// off saved.
    #[tokio::test]
    async fn an_on_asked_while_an_off_closes_waits_for_it() {
        let dir = Dir::new("one");
        let path = dir.file();
        let switch = LaneSwitch::read(false, path.clone());
        let (release, closed) = tokio::sync::oneshot::channel::<()>();
        let order = std::sync::Mutex::new(Vec::new());
        let off = async {
            let turned = switch
                .turn(false, 1, || async {
                    let _ = closed.await;
                })
                .await;
            order.lock().unwrap().push("off");
            turned
        };
        let on = async {
            tokio::task::yield_now().await;
            let turned = switch.turn(true, 0, || async {}).await;
            order.lock().unwrap().push("on");
            turned
        };
        let releaser = async {
            for _ in 0..20 {
                tokio::task::yield_now().await;
            }
            assert!(order.lock().unwrap().is_empty(), "neither answered while the off closes");
            let _ = release.send(());
        };
        let (off, on, ()) = tokio::join!(off, on, releaser);
        assert_eq!(*order.lock().unwrap(), vec!["off", "on"]);
        assert_eq!((off.status, on.status), ("200 OK", "200 OK"));
        assert!(!path.exists(), "the on came second and removed the file");
        assert!(switch.strict());
    }
}
