//! 🔒 FAIR ONLY TABLES: the owner's switch for whether this node's house
//! serves the FAIR ONLY games at its owner's tables (PR 6c, node slice
//! n-5b-1).
//!
//! The house can serve them since n-2 (house.rs `serve_fair_only`), and trim,
//! sweep and end them since n-4c and n-5a, going by the fold in shadow's
//! answers. Until this switch nothing outside the tests turned that on, and
//! the fingerprint's `houseFold` said `letters: "rd"` whatever the house did,
//! so no page offered SET FAIR ONLY at all: a page offers it only where its
//! own node says it folds `p` and `q` at a rules version the page knows
//! (computedTable.ts `nodeRunsFairOnly`).
//!
//! It starts on ([`DEFAULT_ON`], the owner's word of 2026-11-17: on by
//! default in the release that carries it, for the first field run), so a
//! node serves the FAIR ONLY games at its owner's tables with nothing to
//! tap. The switch is where its player can turn that off and on again: the
//! SpacePhone's Network settings (`POST /api/house/fair-only`, main.rs,
//! behind the wallet switch's gate, chia_wallet_switch::local_page). A turn
//! is kept in [`FAIR_ONLY_FILE`] beside the house's own state, owner-only.
//! One file for the node, not one per Chia network: the house and its key
//! are the node's, on every network. A file that is there but cannot be read
//! counts as off, and the node says so.
//!
//! The environment decides first, as for the beacon (chia_beacon_switch.rs):
//! `SSF_FAIR_ONLY=1` holds it on for the run whatever the switch says; any
//! other value that is set holds it off; unset or empty, the switch decides
//! ([`EnvSwitch`]).
//!
//! On is a wish the node can fail to keep: the house serves the games only
//! while it has the fold in shadow to go by ([`Unable`]): a house (its state
//! file read), a build with the `house-fold` feature, the fold not turned off
//! in the environment (`SSF_HOUSE_FOLD=0`), and its worker not given up on
//! after failing too often. Short of any of those an on is refused, and one
//! saved before is kept but served by nobody: the fingerprint's view says
//! why ([`FairOnlyView::unable`]), and its `houseFold` names no `p` or `q`,
//! so no page offers a new game.
//!
//! Turned off, the house says its last word at the games from its next tick
//! (house.rs `games_last_word`), as at the node's stop: it reveals a close
//! whose seeds are in with no next commitment, lifts the commitment nobody
//! closed on, and then serves them no more. So no page closes a round on a
//! commitment nobody will reveal, though the room's beat goes on for a house
//! table beside. The page that holds a game, seeing its own node's switch off
//! in the fingerprint, writes the game's end order, and the end once the
//! table is quiet (computedTable.ts `fairOffDuty`, `fairEndDuty`). Turned on
//! again, the house settles at each game again before it answers, as after a
//! gap (not where its last word is still to come: it read them all along).
//! The fold stopping for good takes the house off the games the same way.
//!
//! A turn names the node it was confirmed for, an off too, and only that node
//! takes it ([`fair_only_gate`]): a node that took another's port since the
//! page armed CONFIRM refuses it.
//!
//! Every decision rests on a pure function or on a [`FairOnlySwitch`], and a
//! test makes a switch of its own over a file of its own with the
//! environment's word as a value, so the tests never touch the process's
//! environment or the node's file.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::HouseFoldReport;

/// The switch's file, in the node's folder beside the house's state.
pub const FAIR_ONLY_FILE: &str = "fair_only.json";

/// The environment variable that decides before the switch ([`EnvSwitch`]).
pub const FAIR_ONLY_ENV: &str = "SSF_FAIR_ONLY";

/// The switch where its player never turned it: on (the owner's word of
/// 2026-11-17, for the first field run of FAIR ONLY tables).
pub const DEFAULT_ON: bool = true;

/// The switch's file's contents.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct FairOnlyFile {
    pub on: bool,
    /// When the switch was turned, unix seconds (for the operator reading it).
    #[serde(default)]
    pub at: u64,
}

/// What the switch's file says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Saved {
    /// No file: never turned, so [`DEFAULT_ON`].
    Unset,
    /// The file says `"on": true`.
    On,
    /// The file says `"on": false`.
    Off,
    /// Something is there that is not a switch the node can read: counts as
    /// off. The reason, in the node's words.
    Damaged(String),
}

impl Saved {
    /// Whether the switch reads on: the player's word, [`DEFAULT_ON`] where
    /// it was never turned, and off for a file that cannot be read (fails
    /// closed).
    pub fn on(&self) -> bool {
        match self {
            Saved::Unset => DEFAULT_ON,
            Saved::On => true,
            Saved::Off | Saved::Damaged(_) => false,
        }
    }

    /// Whether the player turned the switch: a file the node can read.
    pub fn chosen(&self) -> bool {
        matches!(self, Saved::On | Saved::Off)
    }
}

/// Read the switch's file at `path` ([`Saved`]). Nothing at `path` is unset.
/// A link to nothing reads as missing through the link, so the entry itself
/// is looked at: anything there that does not read as a switch is damaged, a
/// folder too.
pub fn saved_of(path: &Path) -> Saved {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<FairOnlyFile>(&bytes) {
            Ok(file) if file.on => Saved::On,
            Ok(_) => Saved::Off,
            Err(e) => Saved::Damaged(format!("{} is not a FAIR ONLY switch the node can read ({e})", path.display())),
        },
        Err(e) => match std::fs::symlink_metadata(path) {
            Err(gone) if e.kind() == std::io::ErrorKind::NotFound && gone.kind() == std::io::ErrorKind::NotFound => Saved::Unset,
            Ok(entry) if entry.is_dir() => Saved::Damaged(format!("{} is a folder, not a FAIR ONLY switch the node can read", path.display())),
            _ => Saved::Damaged(format!("{} cannot be read ({e})", path.display())),
        },
    }
}

/// Save the switch at `path`: written whole (a temporary file renamed over
/// it, the directory synced), owner-only (private_file.rs).
pub fn save(path: &Path, on: bool, now: u64) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&FairOnlyFile { on, at: now }).map_err(std::io::Error::other)?;
    crate::private_file::write_private(path, &bytes)
}

/// What the node's environment says about the switch, read once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvSwitch {
    /// `SSF_FAIR_ONLY` unset or empty: the player's switch decides.
    Unset,
    /// `SSF_FAIR_ONLY=1`: on for this run, whatever the switch says.
    On,
    /// Any other value: off, and the switch cannot turn it on.
    Off,
}

/// Classify a raw `SSF_FAIR_ONLY` value: exactly `1` is on; anything else
/// that is set (`0`, `true`, a stray space) is off, whatever the switch says,
/// as for the node's other switches: whoever wrote it in the environment
/// said so on purpose.
pub fn env_switch_of(raw: Option<&OsStr>) -> EnvSwitch {
    match raw {
        None => EnvSwitch::Unset,
        Some(v) if v.is_empty() => EnvSwitch::Unset,
        Some(v) if v == OsStr::new("1") => EnvSwitch::On,
        Some(_) => EnvSwitch::Off,
    }
}

/// The process's `SSF_FAIR_ONLY`, read once.
pub fn env_switch() -> EnvSwitch {
    static ENV: std::sync::OnceLock<EnvSwitch> = std::sync::OnceLock::new();
    *ENV.get_or_init(|| env_switch_of(std::env::var_os(FAIR_ONLY_ENV).as_deref()))
}

/// Whether the switch is on: the environment first, then the player's word.
pub fn wanted(saved: &Saved, env: EnvSwitch) -> bool {
    match env {
        EnvSwitch::On => true,
        EnvSwitch::Off => false,
        EnvSwitch::Unset => saved.on(),
    }
}

/// Why this node cannot serve FAIR ONLY games now, whatever the switch says:
/// the house trims, sweeps and ends them by the fold in shadow's answers, so
/// without the fold a game it served would stop at its limit of rounds held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unable {
    /// A build without the `house-fold` feature: no fold at all.
    Unbuilt,
    /// No house: its state file could not be read (main.rs's start says so).
    NoHouse,
    /// The fold in shadow is turned off in the node's environment (`SSF_HOUSE_FOLD`).
    FoldOff,
    /// The fold's worker failed too often, and the fold is off until the node starts again.
    FoldDown,
}

impl Unable {
    /// Its id in the fingerprint's view, for the page.
    pub fn id(self) -> &'static str {
        match self {
            Unable::Unbuilt => "build",
            Unable::NoHouse => "house",
            Unable::FoldOff => "fold-env",
            Unable::FoldDown => "fold-down",
        }
    }

    /// Why, in the node's words.
    pub fn words(self) -> &'static str {
        match self {
            Unable::Unbuilt => "this build of the node has no fold of the tables (the house-fold feature), so its house cannot serve FAIR ONLY games",
            Unable::NoHouse => "this node's house is off (its state file could not be read), so it cannot serve FAIR ONLY games",
            Unable::FoldOff => "the fold of the tables is turned off by SSF_HOUSE_FOLD in this node's environment, so its house cannot serve FAIR ONLY games; start the node without it",
            Unable::FoldDown => "the fold of the tables stopped after its worker failed too often, so this node's house cannot serve FAIR ONLY games until the node starts again",
        }
    }
}

/// What is in the way, from what the node has: a build with the fold
/// (`built`), a house (`house`), the fold in shadow started (`fold`), and
/// whether the fold said at its last pass that it is off for good
/// (`fold_down`). The first missing one is the reason: a build without the
/// fold has no fold to start, and a node without a house starts none.
pub fn unable_of(built: bool, house: bool, fold: bool, fold_down: bool) -> Option<Unable> {
    if !built {
        Some(Unable::Unbuilt)
    } else if !house {
        Some(Unable::NoHouse)
    } else if !fold {
        Some(Unable::FoldOff)
    } else if fold_down {
        Some(Unable::FoldDown)
    } else {
        None
    }
}

/// Whether the house serves the games: the switch on, and nothing in the way.
pub fn serving(wanted: bool, unable: Option<Unable>) -> bool {
    wanted && unable.is_none()
}

/// The fingerprint's `fair_only`, for the page:
///   - `on`: the switch is on, by the player's word or by `SSF_FAIR_ONLY=1`;
///   - `chosen`: the player turned the switch (`false`: never turned, so
///     [`DEFAULT_ON`] unless the environment holds it, or the file cannot be
///     read);
///   - `held`, only when true: the node's environment decides and the switch
///     cannot change it;
///   - `damaged`, only when true: the switch's file is there but cannot be
///     read, so it counts as off until it is turned again;
///   - `unable`, only when there is a reason: why the house cannot serve the
///     games now whatever the switch says ([`Unable::id`]).
///
/// The house serves them exactly when `on` and no `unable`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct FairOnlyView {
    pub on: bool,
    pub chosen: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub damaged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unable: Option<String>,
}

/// The view of the file as it reads now (`saved`), under the environment's
/// word (`env`), with what is in the way (`unable`).
pub fn view_of(saved: &Saved, env: EnvSwitch, unable: Option<Unable>) -> FairOnlyView {
    FairOnlyView {
        on: wanted(saved, env),
        chosen: saved.chosen(),
        held: env != EnvSwitch::Unset,
        damaged: matches!(saved, Saved::Damaged(_)),
        unable: unable.map(|u| u.id().to_string()),
    }
}

/// The fingerprint's `houseFold` as the pages read it: the letters `p` and
/// `q`, and the rules versions the house serves them at (`rv`), exactly while
/// the house serves FAIR ONLY games and the fold runs. A page offers SET FAIR
/// ONLY only then (computedTable.ts `nodeRunsFairOnly`).
pub fn advertise(fold: &mut HouseFoldReport, serving: bool) {
    let serves = serving && fold.off.is_none();
    fold.letters.retain(|c| c != 'p' && c != 'q');
    fold.rv.clear();
    if serves {
        fold.letters.push_str("pq");
        fold.rv.push(crate::house_auth::FAIR_ONLY_RV.to_string());
    }
}

/// The route's path.
pub const FAIR_ONLY_ROUTE: &str = "/api/house/fair-only";

/// What the page asks of the route: the turn, and the node its player
/// confirmed it for, by its iroh node id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FairOnlyAsk<'a> {
    pub on: bool,
    pub node: &'a str,
}

/// The route's query: `on=1` or `on=0`, and `node=<iroh node id>`, the node
/// the CONFIRM was armed on. Each key once, in any order, and no other key.
/// Both turns name the node, an off too: an off ends the games the page holds
/// at that node's house (computedTable.ts `fairOffDuty`).
pub fn fair_only_asked(target: &str) -> Option<FairOnlyAsk<'_>> {
    let (path, query) = target.split_once('?')?;
    if path != FAIR_ONLY_ROUTE {
        return None;
    }
    let (mut on, mut node) = (None, None);
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        let taken = match key {
            "on" => on
                .replace(match value {
                    "1" => true,
                    "0" => false,
                    _ => return None,
                })
                .is_some(),
            "node" if !value.is_empty() => node.replace(value).is_some(),
            _ => return None,
        };
        if taken {
            return None;
        }
    }
    Some(FairOnlyAsk { on: on?, node: node? })
}

/// The route's refusal for a request from anything but this computer's own
/// game page (chia_wallet_switch::local_page).
pub const PAGE_ONLY_WORDS: &str = "only this computer's own Star Station page can turn FAIR ONLY tables on or off";

/// The route's refusal for a query it does not know.
pub const BAD_ASK_WORDS: &str = "ask with on=1 or on=0, and the node= the turn was confirmed for";

/// The route's refusal of a turn confirmed for another node than this one
/// (another took its port since the page armed it).
pub const OTHER_NODE_WORDS: &str =
    "FAIR ONLY tables were not turned: the turn was confirmed for another node than the one that answers now. Look at the Network settings again";

/// An on's refusal where the node's environment holds the switch off.
pub const HELD_OFF_WORDS: &str = "FAIR ONLY tables are switched off on this node by SSF_FAIR_ONLY in its environment; the switch here cannot turn them on";

/// An off's refusal where the node's environment holds the switch on.
pub const HELD_ON_WORDS: &str = "SSF_FAIR_ONLY=1 in the node's environment holds FAIR ONLY tables on; start the node without it to turn them off here";

/// The route's answer when the turn itself failed in the node (it panicked):
/// whether it was saved is not known, so the page reads the switch again.
pub const TURN_FAILED_WORDS: &str = "the node's turn of the FAIR ONLY switch failed; look at the Network settings again";

/// The route's gate and query: `Ok(on)` for a turn to make, or the refusal's
/// status and body. `local` is chia_wallet_switch::local_page, the wallet
/// switch's gate: an allowed loopback or desktop-app Origin, never a web
/// origin or none, sent to a loopback Host on the API's own port. A turn is
/// taken only by the node it was confirmed for (`node_id`, this node's iroh
/// node id), as the beacon's on is (chia_beacon_switch.rs `beacon_gate`).
pub fn fair_only_gate(local: bool, target: &str, node_id: &str) -> Result<bool, (&'static str, serde_json::Value)> {
    let refused = |status: &'static str, error: &str| Err((status, serde_json::json!({ "ok": false, "error": error })));
    if !local {
        return refused("403 Forbidden", PAGE_ONLY_WORDS);
    }
    match fair_only_asked(target) {
        Some(ask) if ask.node != node_id => refused("409 Conflict", OTHER_NODE_WORDS),
        Some(ask) => Ok(ask.on),
        None => refused("400 Bad Request", BAD_ASK_WORDS),
    }
}

/// What the house does while the switch is on, for the node's lines.
const WHAT_IT_DOES: &str = "This node's house serves the FAIR ONLY games at its owner's tables while it runs: it answers their turns, and trims, sweeps and ends them by the fold of the tables";

/// What a turn to off does to the games served, for the node's lines.
const WHAT_OFF_DOES: &str = "This node's house steps down at each FAIR ONLY game it serves at its next tick (it reveals a round whose seeds are in and lifts its next commitment), and the page that holds each game ends it once no round is in flight. The house serves none from then on";

/// The startup line for the switch as it read (`saved`) under the
/// environment's word (`env`), with what is in the way (`unable`) while it is
/// on. `None` only where the player never turned it, the environment says
/// nothing and it starts off ([`DEFAULT_ON`] false): nothing to say then.
pub fn start_line(saved: &Saved, env: EnvSwitch, unable: Option<Unable>) -> Option<String> {
    let line = match (env, saved) {
        (EnvSwitch::On, _) => format!(
            "🔒 FAIR ONLY tables: on, held on by SSF_FAIR_ONLY=1 in this node's environment. {WHAT_IT_DOES}. The switch in the SpacePhone's Network settings cannot turn them off while the variable is set."
        ),
        (EnvSwitch::Off, _) => "🔒 FAIR ONLY tables: off, held off by SSF_FAIR_ONLY in this node's environment. The switch in the SpacePhone's Network settings cannot turn them on while the variable is set.".to_string(),
        (EnvSwitch::Unset, Saved::Unset) if DEFAULT_ON => {
            format!("🔒 FAIR ONLY tables: on, as they start. {WHAT_IT_DOES}, until they are turned off in the SpacePhone's Network settings.")
        }
        (EnvSwitch::Unset, Saved::Unset) => return None,
        (EnvSwitch::Unset, Saved::On) => {
            format!("🔒 FAIR ONLY tables: on, turned on in the SpacePhone's Network settings. {WHAT_IT_DOES}, until they are turned off there.")
        }
        (EnvSwitch::Unset, Saved::Off) => "🔒 FAIR ONLY tables: off. This node's house serves no FAIR ONLY game until its player turns them on in the SpacePhone's Network settings.".to_string(),
        (EnvSwitch::Unset, Saved::Damaged(why)) => format!(
            "⚠️  FAIR ONLY tables: {why}. A switch that cannot be read counts as off: this node's house serves no FAIR ONLY game until they are turned on again in the SpacePhone's Network settings."
        ),
    };
    Some(match unable.filter(|_| wanted(saved, env)) {
        Some(u) => format!("{line}\n⚠️  FAIR ONLY tables: but {}.", u.words()),
        None => line,
    })
}

/// The log line of a turn that was taken.
pub fn turned_line(on: bool) -> String {
    if on {
        format!("🔒 FAIR ONLY tables: turned on in the SpacePhone's Network settings. {WHAT_IT_DOES}, from its next tick and at every start until they are turned off.")
    } else {
        format!("🔒 FAIR ONLY tables: turned off in the SpacePhone's Network settings. {WHAT_OFF_DOES}, and none at any start until they are turned on again.")
    }
}

/// The answer of one turn of the switch, and what the node says.
#[derive(Clone, Debug, PartialEq)]
pub struct FairOnlyTurn {
    /// The route's status line: 200, or 409 for a refusal or a failed save.
    pub status: &'static str,
    /// `{"ok": true, "fair_only"}` or `{"ok": false, "error", "fair_only"}`,
    /// with the switch's view after the turn as `fair_only` ([`FairOnlyView`]).
    pub body: serde_json::Value,
    /// The log line, if any: none for a refusal.
    pub line: Option<String>,
    /// The line is a failure's, for stderr.
    pub failed: bool,
}

impl FairOnlyTurn {
    fn taken(view: FairOnlyView, line: String) -> Self {
        Self { status: "200 OK", body: serde_json::json!({ "ok": true, "fair_only": view }), line: Some(line), failed: false }
    }

    fn refused(error: &str, view: FairOnlyView, line: Option<String>) -> Self {
        Self { status: "409 Conflict", body: serde_json::json!({ "ok": false, "error": error, "fair_only": view }), failed: line.is_some(), line }
    }
}

/// The FAIR ONLY switch of one process, over its file: the process has one
/// (main.rs, the hub's), and a test makes its own over a file of its own.
pub struct FairOnlySwitch {
    path: PathBuf,
    /// `SSF_FAIR_ONLY`, as the process read it.
    env: EnvSwitch,
    /// The file as it reads now: the start's, then each turn's. An off whose
    /// save failed is kept here as off for the rest of the run.
    saved: Mutex<Saved>,
}

impl FairOnlySwitch {
    /// The switch over `path` ([`FAIR_ONLY_FILE`] for the process's), read
    /// now, under the environment's word `env` ([`env_switch`] for the
    /// process's).
    pub fn read(path: PathBuf, env: EnvSwitch) -> Self {
        let saved = Mutex::new(saved_of(&path));
        Self { path, env, saved }
    }

    /// Whether the switch is on now (the house serves the games only with
    /// nothing in the way too: [`serving`]).
    pub fn wanted(&self) -> bool {
        wanted(&self.saved.lock().unwrap(), self.env)
    }

    /// The fingerprint's view of the switch now, with what is in the way.
    pub fn view(&self, unable: Option<Unable>) -> FairOnlyView {
        view_of(&self.saved.lock().unwrap(), self.env, unable)
    }

    /// The startup line ([`start_line`]).
    pub fn start_line(&self, unable: Option<Unable>) -> Option<String> {
        start_line(&self.saved.lock().unwrap(), self.env, unable)
    }

    /// One turn of the switch at `now` (unix seconds), with what is in the
    /// way of serving the games now (`unable`).
    ///
    /// An on is refused while something is in the way, in its words, and
    /// nothing is saved: a switch that says on while nobody serves the games
    /// would promise the player what the node does not do. The environment
    /// decides next: where it holds the switch off an on is refused, and where
    /// it holds it on an off is, each in words that name the variable; an on
    /// while it is held on is taken and only remembered.
    ///
    /// An on is saved first and holds only once the file reads on: a switch
    /// the disk would not keep is not turned on, since the next start would
    /// read something else. A save can report a failure after the new file
    /// took its name (the folder's sync comes last, private_file.rs), so a
    /// failed save is judged by what the file reads then, which is what the
    /// next start reads: on, the turn is taken and the node's log says the
    /// save was not confirmed; nothing there while the switch starts on
    /// ([`DEFAULT_ON`]), it is taken too, since the next start reads on with no
    /// file; anything else, it is refused.
    ///
    /// An off holds from this call whatever the disk does: when its save
    /// fails, the switch is off for the rest of the run and the answer says
    /// what the next start will read. An off is taken whatever is in the way.
    pub fn turn(&self, on: bool, now: u64, unable: Option<Unable>) -> FairOnlyTurn {
        self.turn_with(on, now, unable, save)
    }

    /// [`FairOnlySwitch::turn`] with the save it makes (a test's can fail
    /// after it wrote the file).
    fn turn_with(&self, on: bool, now: u64, unable: Option<Unable>, save: impl FnOnce(&Path, bool, u64) -> std::io::Result<()>) -> FairOnlyTurn {
        let mut saved = self.saved.lock().unwrap();
        let view = |saved: &Saved| view_of(saved, self.env, unable);
        if let Some(u) = unable.filter(|_| on) {
            return FairOnlyTurn::refused(&format!("FAIR ONLY tables were not turned on: {}", u.words()), view(&saved), None);
        }
        match (on, self.env) {
            (true, EnvSwitch::Off) => return FairOnlyTurn::refused(HELD_OFF_WORDS, view(&saved), None),
            (false, EnvSwitch::On) => return FairOnlyTurn::refused(HELD_ON_WORDS, view(&saved), None),
            _ => {}
        }
        let file = self.path.display();
        match (save(&self.path, on, now), on) {
            (Ok(()), _) => {
                *saved = if on { Saved::On } else { Saved::Off };
                FairOnlyTurn::taken(view(&saved), turned_line(on))
            }
            (Err(e), true) if saved_of(&self.path) == Saved::On => {
                *saved = Saved::On;
                let mut line = turned_line(true);
                line.push_str(&format!("\n⚠️  FAIR ONLY tables: {file} reads on, but its save was not confirmed ({e}): after a power cut it may read as it did before"));
                FairOnlyTurn::taken(view(&saved), line)
            }
            // Nothing is there and the switch starts on: on now and at the next start with no file at all.
            (Err(e), true) if DEFAULT_ON && saved_of(&self.path) == Saved::Unset => {
                *saved = Saved::Unset;
                let mut line = turned_line(true);
                line.push_str(&format!("\n⚠️  FAIR ONLY tables: {file} could not be saved ({e}); they are on all the same, as they start"));
                FairOnlyTurn::taken(view(&saved), line)
            }
            (Err(e), true) => FairOnlyTurn::refused(
                &format!("FAIR ONLY tables were not turned on: their switch could not be saved ({e})"),
                view(&saved),
                Some(format!("⚠️  FAIR ONLY tables: {file} could not be saved ({e}), so they were not turned on")),
            ),
            (Err(e), false) => {
                let next = if saved_of(&self.path).on() { "on again" } else { "off" };
                *saved = Saved::Off;
                FairOnlyTurn::refused(
                    &format!("FAIR ONLY tables are off until this computer's node stops, but their switch could not be saved ({e}): at the node's next start it reads {next}"),
                    view(&saved),
                    Some(format!("⚠️  FAIR ONLY tables: turned off for the rest of this run, but {file} could not be saved ({e}); the next start reads it {next}")),
                )
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own for one test's switch file.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ssf-fair-only-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn view(on: bool, chosen: bool, held: bool, damaged: bool, unable: Option<&str>) -> FairOnlyView {
        FairOnlyView { on, chosen, held, damaged, unable: unable.map(str::to_string) }
    }

    #[test]
    fn the_switch_starts_on_and_a_turn_is_the_players_word_at_every_start() {
        // The owner's word of 2026-11-17: on by default for the first field run.
        assert!(DEFAULT_ON);
        assert!(Saved::Unset.on() && Saved::On.on() && !Saved::Off.on() && !Saved::Damaged("x".into()).on());
        assert!(Saved::On.chosen() && Saved::Off.chosen() && !Saved::Unset.chosen() && !Saved::Damaged("x".into()).chosen());
        let dir = temp_dir("default");
        let path = dir.join(FAIR_ONLY_FILE);
        let switch = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset);
        assert!(switch.wanted());
        assert_eq!(switch.view(None), view(true, false, false, false, None));
        assert_eq!(serde_json::to_value(switch.view(None)).unwrap(), serde_json::json!({ "on": true, "chosen": false }));
        let line = switch.start_line(None).unwrap();
        assert!(line.starts_with("🔒 FAIR ONLY tables: on, as they start."), "{line}");
        assert!(line.ends_with("until they are turned off in the SpacePhone's Network settings."), "{line}");
        assert!(!line.contains('\n'), "{line}");
        // On with something in the way, the start says so.
        let line = switch.start_line(Some(Unable::FoldOff)).unwrap();
        assert!(line.ends_with(&format!("\n⚠️  FAIR ONLY tables: but {}.", Unable::FoldOff.words())), "{line}");
        assert_eq!(saved_of(&path), Saved::Unset, "a default writes no file");
        // Turned off, it is the player's word, at this start and the next.
        let off = switch.turn(false, 6, None);
        assert_eq!(off.body, serde_json::json!({ "ok": true, "fair_only": { "on": false, "chosen": true } }));
        assert!(!switch.wanted() && !FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).wanted());
        // Turned on again, the same.
        let on = switch.turn(true, 7, None);
        assert_eq!(on.status, "200 OK");
        assert_eq!(on.body, serde_json::json!({ "ok": true, "fair_only": { "on": true, "chosen": true } }));
        assert_eq!(on.line.as_deref(), Some(turned_line(true).as_str()));
        assert!(!on.failed);
        assert!(switch.wanted() && FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).wanted());
        let line = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).start_line(None).unwrap();
        assert!(line.starts_with("🔒 FAIR ONLY tables: on, turned on in the SpacePhone's Network settings."), "{line}");
        assert!(line.contains("trims, sweeps and ends them"), "{line}");
        // And off again, the same.
        let off = switch.turn(false, 8, None);
        assert_eq!(off.body, serde_json::json!({ "ok": true, "fair_only": { "on": false, "chosen": true } }));
        assert!(off.line.as_deref().unwrap().contains("steps down at each FAIR ONLY game it serves at its next tick"));
        assert!(off.line.as_deref().unwrap().contains("the page that holds each game ends it once no round is in flight"));
        assert!(!switch.wanted() && !FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).wanted());
        assert!(FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).start_line(None).unwrap().starts_with("🔒 FAIR ONLY tables: off."));
        assert_eq!(serde_json::from_slice::<FairOnlyFile>(&std::fs::read(&path).unwrap()).unwrap(), FairOnlyFile { on: false, at: 8 });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_environment_decides_before_the_switch() {
        assert_eq!(env_switch_of(None), EnvSwitch::Unset);
        assert_eq!(env_switch_of(Some(OsStr::new(""))), EnvSwitch::Unset);
        assert_eq!(env_switch_of(Some(OsStr::new("1"))), EnvSwitch::On);
        for other in ["0", "true", "on", " 1", "1 ", "yes", "2"] {
            assert_eq!(env_switch_of(Some(OsStr::new(other))), EnvSwitch::Off, "{other:?}");
        }
        for saved in [Saved::Unset, Saved::On, Saved::Off, Saved::Damaged("x".into())] {
            assert!(wanted(&saved, EnvSwitch::On), "{saved:?}: SSF_FAIR_ONLY=1 needs no switch");
            assert!(!wanted(&saved, EnvSwitch::Off), "{saved:?}: another value overrides it");
            assert_eq!(wanted(&saved, EnvSwitch::Unset), matches!(saved, Saved::On | Saved::Unset), "{saved:?}: unset, the switch decides, on where never turned");
        }
        assert_eq!(view_of(&Saved::Off, EnvSwitch::On, None), view(true, true, true, false, None));
        assert_eq!(view_of(&Saved::On, EnvSwitch::Off, None), view(false, true, true, false, None));
        assert_eq!(view_of(&Saved::Unset, EnvSwitch::Off, None), view(false, false, true, false, None));
        assert_eq!(view_of(&Saved::Damaged("x".into()), EnvSwitch::Unset, None), view(false, false, false, true, None));
        // Held, a turn the other way is refused in words that name the variable, and nothing is saved.
        let dir = temp_dir("env");
        let path = dir.join(FAIR_ONLY_FILE);
        let held_off = FairOnlySwitch::read(path.clone(), EnvSwitch::Off);
        let t = held_off.turn(true, 1, None);
        assert_eq!((t.status, t.line.clone(), t.failed), ("409 Conflict", None, false));
        assert_eq!(t.body, serde_json::json!({ "ok": false, "error": HELD_OFF_WORDS, "fair_only": { "on": false, "chosen": false, "held": true } }));
        assert_eq!(saved_of(&path), Saved::Unset);
        let held_on = FairOnlySwitch::read(path.clone(), EnvSwitch::On);
        let t = held_on.turn(false, 1, None);
        assert_eq!(t.body, serde_json::json!({ "ok": false, "error": HELD_ON_WORDS, "fair_only": { "on": true, "chosen": false, "held": true } }));
        assert_eq!(saved_of(&path), Saved::Unset);
        assert!(held_on.start_line(None).unwrap().contains("held on by SSF_FAIR_ONLY=1"));
        assert!(held_off.start_line(None).unwrap().contains("held off by SSF_FAIR_ONLY"));
        // The same way as the variable: taken and remembered.
        let t = held_on.turn(true, 2, None);
        assert_eq!(t.status, "200 OK");
        assert_eq!(saved_of(&path), Saved::On);
        let t = held_off.turn(false, 3, None);
        assert_eq!(t.status, "200 OK");
        assert_eq!(saved_of(&path), Saved::Off);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_on_is_refused_while_something_is_in_the_way_and_an_off_is_not() {
        let dir = temp_dir("unable");
        let path = dir.join(FAIR_ONLY_FILE);
        let switch = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset);
        for u in [Unable::Unbuilt, Unable::NoHouse, Unable::FoldOff, Unable::FoldDown] {
            let t = switch.turn(true, 1, Some(u));
            assert_eq!((t.status, t.line.clone()), ("409 Conflict", None), "{u:?}");
            assert_eq!(t.body["error"], serde_json::json!(format!("FAIR ONLY tables were not turned on: {}", u.words())), "{u:?}");
            assert_eq!(t.body["fair_only"], serde_json::json!({ "on": true, "chosen": false, "unable": u.id() }), "{u:?}: on as it starts, served by nobody");
            assert_eq!(saved_of(&path), Saved::Unset, "{u:?}: nothing saved");
            assert!(!serving(true, Some(u)) && !serving(false, Some(u)), "{u:?}");
        }
        assert!(serving(true, None) && !serving(false, None));
        // The first thing missing is the reason.
        assert_eq!(unable_of(true, true, true, false), None);
        assert_eq!(unable_of(true, true, true, true), Some(Unable::FoldDown));
        assert_eq!(unable_of(true, true, false, false), Some(Unable::FoldOff));
        assert_eq!(unable_of(true, true, false, true), Some(Unable::FoldOff));
        assert_eq!(unable_of(true, false, false, false), Some(Unable::NoHouse));
        assert_eq!(unable_of(true, false, true, true), Some(Unable::NoHouse));
        for (house, fold, down) in [(false, false, false), (true, true, true), (true, false, false), (false, true, false)] {
            assert_eq!(unable_of(false, house, fold, down), Some(Unable::Unbuilt), "{house} {fold} {down}");
        }
        // Even refused by the environment first, something in the way is said first.
        let held = FairOnlySwitch::read(path.clone(), EnvSwitch::Off);
        assert!(held.turn(true, 1, Some(Unable::NoHouse)).body["error"].as_str().unwrap().contains("house is off"));
        // An on saved before is kept, and the start says why nobody serves it.
        switch.turn(true, 2, None);
        let line = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).start_line(Some(Unable::FoldOff)).unwrap();
        assert!(line.ends_with(&format!("\n⚠️  FAIR ONLY tables: but {}.", Unable::FoldOff.words())), "{line}");
        assert_eq!(switch.view(Some(Unable::FoldDown)), view(true, true, false, false, Some("fold-down")));
        // An off is taken whatever is in the way.
        let t = switch.turn(false, 3, Some(Unable::FoldDown));
        assert_eq!(t.status, "200 OK");
        assert_eq!(t.body["fair_only"], serde_json::json!({ "on": false, "chosen": true, "unable": "fold-down" }));
        assert_eq!(saved_of(&path), Saved::Off);
        // Off, nothing is in its way: the start says it is off, and no more.
        let line = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).start_line(Some(Unable::FoldOff)).unwrap();
        assert!(line.starts_with("🔒 FAIR ONLY tables: off.") && !line.contains('\n'), "{line}");
        assert!(!FairOnlySwitch::read(path.clone(), EnvSwitch::Off).start_line(Some(Unable::NoHouse)).unwrap().contains("but"));
        let ids: Vec<_> = [Unable::Unbuilt, Unable::NoHouse, Unable::FoldOff, Unable::FoldDown].map(Unable::id).into();
        assert_eq!(ids, ["build", "house", "fold-env", "fold-down"], "the page's ids (fairOnlySwitch.ts)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_save_holds_an_on_only_where_the_next_start_reads_on_and_an_off_always() {
        let dir = temp_dir("save");
        let path = dir.join(FAIR_ONLY_FILE);
        let fail = |_: &Path, _: bool, _: u64| Err(std::io::Error::other("disk full"));
        // No file, nothing written: on all the same, as it starts, and the node says the choice was not saved.
        let switch = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset);
        let t = switch.turn_with(true, 0, None, fail);
        assert_eq!(t.status, "200 OK");
        assert!(!t.failed && t.line.as_deref().unwrap().ends_with("could not be saved (disk full); they are on all the same, as they start"), "{:?}", t.line);
        assert_eq!(t.body["fair_only"], serde_json::json!({ "on": true, "chosen": false }));
        assert!(switch.wanted());
        assert_eq!(saved_of(&path), Saved::Unset);
        // Off on the disk, nothing written: refused, and the node says why.
        save(&path, false, 0).unwrap();
        let switch = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset);
        let t = switch.turn_with(true, 1, None, fail);
        assert_eq!(t.status, "409 Conflict");
        assert!(t.failed && t.line.as_deref().unwrap().contains("could not be saved (disk full), so they were not turned on"));
        assert_eq!(t.body["fair_only"], serde_json::json!({ "on": false, "chosen": true }));
        assert!(!switch.wanted());
        // Written, then the folder's sync failed: the file reads on, so it is taken, with a warning.
        let t = switch.turn_with(true, 2, None, |p: &Path, on, now| {
            save(p, on, now)?;
            Err(std::io::Error::other("sync failed"))
        });
        assert_eq!(t.status, "200 OK");
        assert!(!t.failed && t.line.as_deref().unwrap().contains("reads on, but its save was not confirmed (sync failed)"));
        assert!(switch.wanted());
        // An off that cannot be saved holds for the run, and says the next start reads on again.
        let t = switch.turn_with(false, 3, None, fail);
        assert_eq!(t.status, "409 Conflict");
        assert!(t.failed);
        assert!(t.body["error"].as_str().unwrap().ends_with("at the node's next start it reads on again"), "{}", t.body);
        assert_eq!(t.body["fair_only"], serde_json::json!({ "on": false, "chosen": true }));
        assert!(!switch.wanted());
        assert!(FairOnlySwitch::read(path.clone(), EnvSwitch::Unset).wanted(), "the disk still says on");
        // With the file off already, the next start reads off.
        save(&path, false, 4).unwrap();
        let switch = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset);
        assert!(switch.turn_with(false, 5, None, fail).line.unwrap().ends_with("the next start reads it off"));
        // With no file at all, it starts on again.
        std::fs::remove_file(&path).unwrap();
        let switch = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset);
        let t = switch.turn_with(false, 6, None, fail);
        assert!(t.body["error"].as_str().unwrap().ends_with("at the node's next start it reads on again"), "{}", t.body);
        assert!(!switch.wanted(), "off for the rest of the run");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_is_read_as_it_stands_and_one_that_cannot_be_read_is_damaged_not_guessed() {
        let dir = temp_dir("read");
        let path = dir.join(FAIR_ONLY_FILE);
        assert_eq!(saved_of(&path), Saved::Unset);
        save(&path, true, 1_700_000_000).unwrap();
        assert_eq!(saved_of(&path), Saved::On);
        save(&path, false, 1_700_000_100).unwrap();
        assert_eq!(saved_of(&path), Saved::Off);
        std::fs::write(&path, br#"{"on":true}"#).unwrap();
        assert_eq!(saved_of(&path), Saved::On, "a hand-written file without the time still reads");
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [FAIR_ONLY_FILE], "no temporary left beside it");
        for junk in [&b"not json"[..], b"{}", b"[]", br#"{"on":"yes"}"#, b""] {
            std::fs::write(&path, junk).unwrap();
            assert!(matches!(saved_of(&path), Saved::Damaged(_)), "{:?}", String::from_utf8_lossy(junk));
        }
        let damaged = FairOnlySwitch::read(path.clone(), EnvSwitch::Unset);
        assert!(!damaged.wanted());
        assert!(damaged.start_line(None).unwrap().starts_with("⚠️  FAIR ONLY tables: "));
        // Turned again, it reads again.
        assert_eq!(damaged.turn(true, 9, None).status, "200 OK");
        assert_eq!(saved_of(&path), Saved::On);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let Saved::Damaged(why) = saved_of(&path) else { panic!("a folder is not a switch") };
        assert!(why.contains("is a folder"), "{why}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn the_switchs_file_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("mode");
        let path = dir.join(FAIR_ONLY_FILE);
        save(&path, true, 1).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_route_takes_on_and_off_from_this_computers_page_only_for_the_node_it_was_confirmed_for() {
        const ME: &str = "node-a";
        assert_eq!(fair_only_gate(true, "/api/house/fair-only?on=1&node=node-a", ME), Ok(true));
        assert_eq!(fair_only_gate(true, "/api/house/fair-only?on=0&node=node-a", ME), Ok(false));
        assert_eq!(fair_only_gate(true, "/api/house/fair-only?node=node-a&on=0", ME), Ok(false), "in any order");
        let (status, body) = fair_only_gate(false, "/api/house/fair-only?on=1&node=node-a", ME).unwrap_err();
        assert_eq!((status, body), ("403 Forbidden", serde_json::json!({ "ok": false, "error": PAGE_ONLY_WORDS })));
        // Confirmed for another node: neither turn is taken.
        for on in ["1", "0"] {
            let asked = format!("/api/house/fair-only?on={on}&node=node-b");
            assert_eq!(fair_only_gate(true, &asked, ME), Err(("409 Conflict", serde_json::json!({ "ok": false, "error": OTHER_NODE_WORDS }))), "{asked}");
        }
        for bad in [
            "/api/house/fair-only",
            "/api/house/fair-only?",
            "/api/house/fair-only?on=1",
            "/api/house/fair-only?on=0",
            "/api/house/fair-only?node=node-a",
            "/api/house/fair-only?on=1&node=",
            "/api/house/fair-only?on=2&node=node-a",
            "/api/house/fair-only?on=1&on=0&node=node-a",
            "/api/house/fair-only?on=1&node=node-a&node=node-a",
            "/api/house/fair-only?on=1&node=node-a&x=1",
            "/api/house/fair-only?on=1&node",
            "/api/house/fair-onlyx?on=1&node=node-a",
            "/api/chia/beacon?on=1&node=node-a",
            "/api/house/fair-only?ON=1&node=node-a",
        ] {
            assert_eq!(fair_only_gate(true, bad, ME), Err(("400 Bad Request", serde_json::json!({ "ok": false, "error": BAD_ASK_WORDS }))), "{bad}");
        }
    }

    #[test]
    fn the_fold_names_p_and_q_exactly_while_the_house_serves_the_games_and_the_fold_runs() {
        let fold = |letters: &str, off: Option<&str>| HouseFoldReport { letters: letters.to_string(), off: off.map(str::to_string), ..HouseFoldReport::default() };
        let mut f = fold("rd", None);
        advertise(&mut f, true);
        assert_eq!((f.letters.as_str(), f.rv.clone()), ("rdpq", vec!["f1".to_string()]));
        // Again: the same, not twice.
        advertise(&mut f, true);
        assert_eq!((f.letters.as_str(), f.rv.clone()), ("rdpq", vec!["f1".to_string()]));
        advertise(&mut f, false);
        assert_eq!((f.letters.as_str(), f.rv.len()), ("rd", 0));
        let mut down = fold("rdpq", Some("crashes"));
        down.rv = vec!["f1".to_string()];
        advertise(&mut down, true);
        assert_eq!((down.letters.as_str(), down.rv.len()), ("rd", 0), "a fold that is off serves nothing");
        // As the page reads it: rv only when there is one.
        let json = serde_json::to_value(fold("rd", None)).unwrap();
        assert!(json.get("rv").is_none(), "{json}");
        let mut f = fold("rd", None);
        advertise(&mut f, true);
        assert_eq!(serde_json::to_value(&f).unwrap()["rv"], serde_json::json!(["f1"]));
        assert_eq!(crate::house_auth::FAIR_ONLY_RV, "f1", "the page's FAIR_ONLY_RV (computedFairOnly.ts)");
    }
}
