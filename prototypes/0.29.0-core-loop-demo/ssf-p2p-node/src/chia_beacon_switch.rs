//! 🔦 BEACON: the player's switch for this node's welcome-room beacon on one
//! Chia network (#231 D7, owner direction of 2026-11-12: every newcomer goes
//! through the welcome room, so the welcome room needs more doors than one).
//!
//! A beacon is a public entry point to the welcome room. Once an edition a
//! node that serves the welcome room and can be reached from outside writes
//! its node id in the clear under a hint anyone can compute, and a newcomer
//! whose node has nobody to dial for the welcome room reads those ids and
//! dials them (main.rs `beacon_fallback`). D7 keeps the role opt-in: the
//! hint is derivable by anyone, and a roster of every active node id would
//! be a public weekly directory. Until this switch the only way to opt in
//! was `SSF_CHIA_BEACON=1` in the node's environment, which a player of the
//! desktop app never sees, so nobody but whoever starts a node by hand
//! could be a door.
//!
//! The switch keeps D7's rule and moves the choice to where a player can
//! make it. It is off on every network until the player turns it on, in the
//! SpacePhone's Network settings, after a warning that says what a beacon
//! shows (`POST /api/chia/beacon`, main.rs, behind the wallet switch's gate,
//! chia_wallet_switch::local_page). It is kept per network, in
//! [`BEACON_FILE`] through `ChiaNet::path`, owner-only: a beacon lit on
//! testnet11 says nothing about mainnet. A file that is there but cannot be
//! read counts as off, and the node says so.
//!
//! The environment still decides first, as it does for the SSF wallet
//! (chia_wallet_switch.rs): `SSF_CHIA_BEACON=1` holds the beacon on for the
//! run whatever the switch says, as it always lit it; any other value that
//! is set holds it off, and the switch cannot light it; unset or empty, the
//! switch decides ([`EnvSwitch`]).
//!
//! An on is the player's word for one network on one node, the ones whose
//! warning stood on the page at CONFIRM, so it names both and only that
//! node on that network takes it ([`beacon_gate`]). An off names neither
//! and is always taken.
//!
//! A turn holds from the publisher's next tick, within the run
//! (chia_publish.rs `heartbeat_loop` asks [`BeaconSwitch::on`] at each
//! one). Turned off, no beacon is written from then on. A beacon already
//! sent this edition is not withdrawn: what is on the chain stays there,
//! and a spend handed to the peers and not yet confirmed may still be sent
//! to them again until it lands (the wallet lease's `Resend::Always`, as
//! before this switch). Readers look at this edition's beacons and the
//! last one's, so they stop finding a beacon once its edition and the next
//! have passed.
//!
//! The switch says whether the beacon's arm may write. Whether it does is
//! the arm's own rule, unchanged: only while the node took a connection
//! from outside this edition and serves the welcome room, once an edition,
//! from its slot, from the beacon's own key, which the lobby dish funds
//! (`beacon_arm_due`). And whether a publisher runs at all is another
//! question: with no SSF wallet on there is none, and the switch waits.
//!
//! Chia off on this computer (chia_strict.rs) wins over all of it: nothing
//! is read or written, and an on is refused until Chia is back.
//!
//! Every decision rests on a pure function or on a [`BeaconSwitch`], and a
//! test makes a switch of its own over a file of its own with the
//! environment's word as a value, so the tests never touch the process's
//! network, its environment or the node's file.
#![cfg_attr(not(feature = "chia-publish"), allow(dead_code))]

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::chia_network::ChiaNet;

/// The switch's file, one per network (`ChiaNet::path`): the bare name on
/// testnet11, `chia-mainnet/chia_beacon.json` on mainnet.
pub const BEACON_FILE: &str = "chia_beacon.json";

/// The environment variable that decides before the switch ([`EnvSwitch`]).
pub const BEACON_ENV: &str = "SSF_CHIA_BEACON";

/// The switch's file's contents.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct BeaconFile {
    pub on: bool,
    /// When the switch was turned, unix seconds (for the operator reading it).
    #[serde(default)]
    pub at: u64,
}

/// What the switch's file says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Saved {
    /// No file: the player never turned the switch on this network. Off.
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
    /// Whether the file lights the beacon: only the player's own on. No
    /// file is off on every network (D7: opt-in), and so is a file that
    /// cannot be read (fails closed).
    pub fn on(&self) -> bool {
        matches!(self, Saved::On)
    }

    /// Whether the player turned the switch on this network: a file the
    /// node can read.
    pub fn chosen(&self) -> bool {
        matches!(self, Saved::On | Saved::Off)
    }
}

/// Read the switch's file at `path` ([`Saved`]). Nothing at `path` is
/// unset. A link to nothing reads as missing through the link, so the entry
/// itself is looked at: anything there that does not read as a switch is
/// damaged, a folder too.
pub fn saved_of(path: &Path) -> Saved {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<BeaconFile>(&bytes) {
            Ok(file) if file.on => Saved::On,
            Ok(_) => Saved::Off,
            Err(e) => Saved::Damaged(format!("{} is not a beacon switch the node can read ({e})", path.display())),
        },
        Err(e) => match std::fs::symlink_metadata(path) {
            Err(gone) if e.kind() == std::io::ErrorKind::NotFound && gone.kind() == std::io::ErrorKind::NotFound => Saved::Unset,
            Ok(entry) if entry.is_dir() => Saved::Damaged(format!("{} is a folder, not a beacon switch the node can read", path.display())),
            _ => Saved::Damaged(format!("{} cannot be read ({e})", path.display())),
        },
    }
}

/// Save the switch at `path`: written whole (a temporary file renamed over
/// it, the directory synced), owner-only (private_file.rs).
pub fn save(path: &Path, on: bool, now: u64) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&BeaconFile { on, at: now }).map_err(std::io::Error::other)?;
    crate::private_file::write_private(path, &bytes)
}

/// What the node's environment says about the beacon, read once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvSwitch {
    /// `SSF_CHIA_BEACON` unset or empty: the player's switch decides.
    Unset,
    /// `SSF_CHIA_BEACON=1`: on for this run, whatever the switch says.
    On,
    /// Any other value: off, and the switch cannot light it.
    Off,
}

/// Classify a raw `SSF_CHIA_BEACON` value. Exactly `1` is on, as it always
/// was. Anything else that is set (`0`, `true`, a stray space) is off, as it
/// always was too, and stays off whatever the switch says: whoever wrote it
/// in the environment said so on purpose.
pub fn env_switch_of(raw: Option<&OsStr>) -> EnvSwitch {
    match raw {
        None => EnvSwitch::Unset,
        Some(v) if v.is_empty() => EnvSwitch::Unset,
        Some(v) if v == OsStr::new("1") => EnvSwitch::On,
        Some(_) => EnvSwitch::Off,
    }
}

/// The process's `SSF_CHIA_BEACON`, read once: the startup line, the
/// publisher, the route and the fingerprint all see the same value.
pub fn env_switch() -> EnvSwitch {
    static ENV: std::sync::OnceLock<EnvSwitch> = std::sync::OnceLock::new();
    *ENV.get_or_init(|| env_switch_of(std::env::var_os(BEACON_ENV).as_deref()))
}

/// Whether the beacon's arm may write: the environment first, then the
/// player's switch.
pub fn lit(saved: &Saved, env: EnvSwitch) -> bool {
    match env {
        EnvSwitch::On => true,
        EnvSwitch::Off => false,
        EnvSwitch::Unset => saved.on(),
    }
}

/// What the publisher's last look at the beacon found (chia_publish.rs
/// `heartbeat_loop` writes it at each tick that reaches the beacon's arm,
/// and clears it once the beacon is off). It says why a lit beacon is or is
/// not written, so the page need not guess.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BeaconStatus {
    /// The edition (era) looked at.
    pub era: u64,
    /// This node took a direct connection from outside in this edition: the
    /// measured bit a beacon needs, since one that cannot be reached is
    /// noise.
    pub reachable: bool,
    /// This node serves the welcome room, which is where a beacon leads.
    pub serves_welcome: bool,
    /// This edition's beacon was handed to the peers by this node.
    pub sent: bool,
    /// And read back from the chain.
    pub confirmed: bool,
}

/// The fingerprint's `chia_beacon`, for the page:
///   - `on`: the beacon is lit on this node's network, by the player's
///     switch or by `SSF_CHIA_BEACON=1`, so its publisher may write it;
///   - `chosen`: the player turned the switch on this network (`false`:
///     never turned, or the file cannot be read);
///   - `held`, only when true: the node's environment decides and the
///     switch cannot change it. With `on`, `SSF_CHIA_BEACON=1` holds it on;
///     without, another value of the variable holds it off;
///   - `damaged`, only when true: the switch's file is there but cannot be
///     read, so it counts as off until it is turned again;
///   - `status`, only while the beacon is lit and a publisher has looked:
///     what it found ([`BeaconStatus`]).
///
/// Without `status` it says what the switch says, never whether anything
/// was written: with no SSF wallet on no publisher runs whatever this says.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct BeaconView {
    pub on: bool,
    pub chosen: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub damaged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<BeaconStatus>,
}

/// The view of the file as it reads now (`saved`) under the environment's
/// word (`env`), with no status: the caller that knows the publisher's
/// adds it ([`BeaconView::with`]).
pub fn view_of(saved: &Saved, env: EnvSwitch) -> BeaconView {
    BeaconView { on: lit(saved, env), chosen: saved.chosen(), held: env != EnvSwitch::Unset, damaged: matches!(saved, Saved::Damaged(_)), status: None }
}

impl BeaconView {
    /// This view with the publisher's last look, kept only while the beacon
    /// is lit: a status from before a turn to off says nothing of now.
    pub fn with(self, status: Option<BeaconStatus>) -> BeaconView {
        BeaconView { status: status.filter(|_| self.on), ..self }
    }
}

/// What the page asks of the route: the turn, and for which network and
/// which node its player confirmed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BeaconAsk<'a> {
    pub on: bool,
    /// `net=`: the network the page showed, by its id ([`ChiaNet::id`]).
    pub net: Option<&'a str>,
    /// `node=`: the node the page showed, by its iroh node id.
    pub node: Option<&'a str>,
}

/// The route's path.
pub const BEACON_ROUTE: &str = "/api/chia/beacon";

/// The route's query: `/api/chia/beacon?on=0` puts the beacon out, and
/// `on=1&net=<network id>&node=<iroh node id>` lights it. Each key at most
/// once, in any order, and no other key.
pub fn beacon_asked(target: &str) -> Option<BeaconAsk<'_>> {
    let (path, query) = target.split_once('?')?;
    if path != BEACON_ROUTE {
        return None;
    }
    let (mut on, mut net, mut node) = (None, None, None);
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
            "net" => net.replace(value).is_some(),
            "node" => node.replace(value).is_some(),
            _ => return None,
        };
        if taken {
            return None;
        }
    }
    Some(BeaconAsk { on: on?, net, node })
}

/// The route's refusal for a request from anything but this computer's own
/// game page (chia_wallet_switch::local_page).
pub const PAGE_ONLY_WORDS: &str = "only this computer's own Star Station page can light the beacon or put it out";

/// The route's refusal for a query it does not know.
pub const BAD_ASK_WORDS: &str = "ask with on=0, or with on=1 and the net= and node= the beacon was confirmed for";

/// The route's refusal of an on confirmed for another network than this
/// node runs on.
pub fn other_network_words(net: ChiaNet) -> String {
    format!(
        "The beacon was not lit: it was confirmed for another network than the one this computer's node runs on now ({}). Look at the Network settings again",
        net.name()
    )
}

/// The route's refusal of an on confirmed for another node.
pub const OTHER_NODE_WORDS: &str =
    "The beacon was not lit: it was confirmed for another node than the one that answers now. Look at the Network settings again";

/// The route's refusal for a build that only reads the chain: it writes no
/// beacon, so it has no switch.
#[cfg_attr(feature = "chia-publish", allow(dead_code))]
pub const UNBUILT_WORDS: &str = "this build of the node only reads the chain, so it has no beacon to light";

/// An on's refusal while Chia is off on this computer: the switch would
/// promise writes the node does not make. An off is taken then too.
pub const CHIA_OFF_WORDS: &str = "Chia is off on this computer, so the beacon cannot be lit; turn Chia back on first";

/// An on's refusal where the node's environment holds the beacon off.
pub const HELD_OFF_WORDS: &str = "the beacon is switched off on this node by SSF_CHIA_BEACON in its environment; the switch here cannot light it";

/// An off's refusal where the node's environment holds the beacon on.
pub const HELD_ON_WORDS: &str = "SSF_CHIA_BEACON=1 in the node's environment holds the beacon on; start the node without it to put the beacon out here";

/// The route's gate and query: `Ok(on)` for a turn to make, or the
/// refusal's status and body. `local` is chia_wallet_switch::local_page, the
/// wallet switch's gate: an allowed loopback or desktop-app Origin, never a
/// web origin or none, sent to a loopback Host on the API's own port.
///
/// An on is the player's word for one network on one node, so it names
/// both, as the page showed them when its player tapped CONFIRM, and is
/// taken only by that node on that network (`net`, `node_id`: this node's
/// own). A node started on another network at the same port while a
/// confirmation stood open on the page is asked for the network the player
/// read, and refuses. An off names neither and is always taken here: it
/// only stops writes, on whichever network this node would make them.
pub fn beacon_gate(local: bool, target: &str, net: ChiaNet, node_id: &str) -> Result<bool, (&'static str, serde_json::Value)> {
    let refused = |status: &'static str, error: &str| Err((status, serde_json::json!({ "ok": false, "error": error })));
    if !local {
        return refused("403 Forbidden", PAGE_ONLY_WORDS);
    }
    let Some(ask) = beacon_asked(target) else {
        return refused("400 Bad Request", BAD_ASK_WORDS);
    };
    if !ask.on {
        return Ok(false);
    }
    match (ask.net, ask.node) {
        (Some(asked), Some(_)) if asked != net.id() => refused("409 Conflict", &other_network_words(net)),
        (Some(_), Some(asked)) if asked != node_id => refused("409 Conflict", OTHER_NODE_WORDS),
        (Some(_), Some(_)) => Ok(true),
        _ => refused("400 Bad Request", BAD_ASK_WORDS),
    }
}

/// What a lit beacon writes, for the node's lines.
const WHAT_IT_WRITES: &str = "With its SSF wallet on, this node writes its node id in the clear once an edition, while it can be reached from outside and serves the welcome room, from a key of its own that the lobby dish funds";

/// The startup line for the switch as it read (`saved`) on `net` under the
/// environment's word (`env`). `None` where the player never turned it and
/// the environment says nothing: no beacon, as on every node before the
/// switch, and nothing to say.
pub fn start_line(net: ChiaNet, saved: &Saved, env: EnvSwitch) -> Option<String> {
    let name = net.name();
    match (env, saved) {
        (EnvSwitch::On, _) => Some(format!(
            "🔦 Beacon: on for {name}, held on by SSF_CHIA_BEACON=1 in this node's environment. {WHAT_IT_WRITES}. The switch in the SpacePhone's Network settings cannot put it out while the variable is set."
        )),
        (EnvSwitch::Off, _) => Some(format!(
            "🔦 Beacon: off for {name}, held off by SSF_CHIA_BEACON in this node's environment. This node writes no beacon, and the switch in the SpacePhone's Network settings cannot light one while the variable is set."
        )),
        (EnvSwitch::Unset, Saved::Unset) => None,
        (EnvSwitch::Unset, Saved::On) => Some(format!(
            "🔦 Beacon: on for {name}, lit in the SpacePhone's Network settings. {WHAT_IT_WRITES}, until it is put out there."
        )),
        (EnvSwitch::Unset, Saved::Off) => Some(format!(
            "🔦 Beacon: off for {name}. This node writes no beacon there until its player lights one in the SpacePhone's Network settings."
        )),
        (EnvSwitch::Unset, Saved::Damaged(why)) => Some(format!(
            "⚠️  Beacon: {why}. A switch that cannot be read counts as off: this node writes no beacon on {name} until one is lit again in the SpacePhone's Network settings."
        )),
    }
}

/// The log line of a turn that was taken, on `net`.
pub fn turned_line(net: ChiaNet, on: bool) -> String {
    let name = net.name();
    if on {
        format!(
            "🔦 Beacon: lit for {name} in the SpacePhone's Network settings. {WHAT_IT_WRITES}, from the publisher's next round and at every start until it is put out."
        )
    } else {
        format!(
            "🔦 Beacon: put out for {name} in the SpacePhone's Network settings. This node writes no beacon there from now on, and none at any start until one is lit again. A beacon already sent this edition is not withdrawn: what is on the chain stays there, and a spend not yet confirmed may still be sent to the peers again until it lands."
        )
    }
}

/// The answer of one turn of the switch, and what the node says.
#[derive(Clone, Debug, PartialEq)]
pub struct BeaconTurn {
    /// The route's status line: 200, or 409 for a refusal or a failed save.
    pub status: &'static str,
    /// `{"ok": true, "beacon"}` or `{"ok": false, "error", "beacon"}`, with
    /// the switch's view after the turn as `beacon` ([`BeaconView`], with no
    /// status: the publisher has not looked since).
    pub body: serde_json::Value,
    /// The log line, if any: none for a refusal.
    pub line: Option<String>,
    /// The line is a failure's, for stderr.
    pub failed: bool,
    /// This turn lit a beacon that was not lit before it: the node then
    /// says the beacon's own lines (main.rs `turn_beacon`).
    pub newly_lit: bool,
}

impl BeaconTurn {
    fn taken(view: BeaconView, line: String, newly_lit: bool) -> Self {
        Self { status: "200 OK", body: serde_json::json!({ "ok": true, "beacon": view }), line: Some(line), failed: false, newly_lit }
    }

    fn refused(error: &str, view: BeaconView, line: Option<String>) -> Self {
        Self { status: "409 Conflict", body: serde_json::json!({ "ok": false, "error": error, "beacon": view }), failed: line.is_some(), line, newly_lit: false }
    }
}

/// The beacon switch of one process, for its network, over its file: the
/// process has one (main.rs, the hub's), and a test makes its own over a
/// file of its own.
pub struct BeaconSwitch {
    net: ChiaNet,
    path: PathBuf,
    /// `SSF_CHIA_BEACON`, as the process read it.
    env: EnvSwitch,
    /// The file as it reads now: the start's, then each turn's. An off whose
    /// save failed is kept here as off for the rest of the run.
    saved: Mutex<Saved>,
}

impl BeaconSwitch {
    /// The switch of `net` over `path` (`net.path(BEACON_FILE)` for the
    /// process's), read now, under the environment's word `env`
    /// ([`env_switch`] for the process's). Read whether or not Chia is off
    /// on this computer: it is a setting on this disk, not a read of the
    /// chain, and nothing is made from it.
    pub fn read(net: ChiaNet, path: PathBuf, env: EnvSwitch) -> Self {
        let saved = Mutex::new(saved_of(&path));
        Self { net, path, env, saved }
    }

    /// Whether the beacon is lit now: asked by the publisher at each tick,
    /// never kept.
    pub fn on(&self) -> bool {
        lit(&self.saved.lock().unwrap(), self.env)
    }

    /// The fingerprint's view of the switch now, with no status.
    pub fn view(&self) -> BeaconView {
        view_of(&self.saved.lock().unwrap(), self.env)
    }

    /// The startup line ([`start_line`]).
    pub fn start_line(&self) -> Option<String> {
        start_line(self.net, &self.saved.lock().unwrap(), self.env)
    }

    /// One turn of the switch at `now` (unix seconds), with whether Chia is
    /// off on this computer (`chia_off`).
    ///
    /// The environment decides first: where it holds the beacon off an on
    /// is refused, and where it holds it on an off is, each in words that
    /// name the variable; nothing is saved by a refused turn. An on while
    /// it is held on is taken and only remembered.
    ///
    /// An on is saved first and holds only once the file reads on: a switch
    /// the disk would not keep is not turned on, since the next start would
    /// read something else. A save can report a failure after the new file
    /// took its name (the folder's sync comes last, private_file.rs), so a
    /// failed save is judged by what the file reads then, which is what the
    /// next start reads: on, the turn is taken and the node's log says the
    /// save was not confirmed; anything else, it is refused. It is refused
    /// while Chia is off ([`CHIA_OFF_WORDS`]).
    ///
    /// An off holds from this call whatever the disk does: when its save
    /// fails, the beacon is out for the rest of the run and the answer says
    /// what the next start will read.
    pub fn turn(&self, on: bool, now: u64, chia_off: bool) -> BeaconTurn {
        self.turn_with(on, now, chia_off, save)
    }

    /// [`BeaconSwitch::turn`] with the save it makes (a test's can fail
    /// after it wrote the file).
    fn turn_with(&self, on: bool, now: u64, chia_off: bool, save: impl FnOnce(&Path, bool, u64) -> std::io::Result<()>) -> BeaconTurn {
        let mut saved = self.saved.lock().unwrap();
        let view = |saved: &Saved| view_of(saved, self.env);
        if on && chia_off {
            return BeaconTurn::refused(CHIA_OFF_WORDS, view(&saved), None);
        }
        match (on, self.env) {
            (true, EnvSwitch::Off) => return BeaconTurn::refused(HELD_OFF_WORDS, view(&saved), None),
            (false, EnvSwitch::On) => return BeaconTurn::refused(HELD_ON_WORDS, view(&saved), None),
            _ => {}
        }
        let was_lit = lit(&saved, self.env);
        let file = self.path.display();
        match (save(&self.path, on, now), on) {
            (Ok(()), _) => {
                *saved = if on { Saved::On } else { Saved::Off };
                BeaconTurn::taken(view(&saved), turned_line(self.net, on), on && !was_lit)
            }
            (Err(e), true) if matches!(saved_of(&self.path), Saved::On) => {
                *saved = Saved::On;
                let mut turn = BeaconTurn::taken(view(&saved), turned_line(self.net, true), !was_lit);
                if let Some(line) = turn.line.as_mut() {
                    line.push_str(&format!(
                        "\n⚠️  Beacon: {file} reads on, but its save was not confirmed ({e}): after a power cut it may read as it did before"
                    ));
                }
                turn
            }
            (Err(e), true) => BeaconTurn::refused(
                &format!("The beacon was not lit: its switch could not be saved ({e})"),
                view(&saved),
                Some(format!("⚠️  Beacon: {file} could not be saved ({e}), so it was not lit")),
            ),
            (Err(e), false) => {
                let next = if saved_of(&self.path).on() { "lit again" } else { "out" };
                *saved = Saved::Off;
                BeaconTurn::refused(
                    &format!("The beacon is out until this computer's node stops, but its switch could not be saved ({e}): at the node's next start it reads {next}"),
                    view(&saved),
                    Some(format!("⚠️  Beacon: put out for the rest of this run, but {file} could not be saved ({e}); the next start reads it {next}")),
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
        let dir = std::env::temp_dir().join(format!("ssf-chia-beacon-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const NODE: &str = "aa11";

    #[test]
    fn the_beacon_is_off_on_every_network_until_the_player_lights_it() {
        // #231 D7: opt-in. No file is off wherever the node runs, and a file
        // that cannot be read is off too.
        assert!(!Saved::Unset.on());
        assert!(Saved::On.on());
        assert!(!Saved::Off.on());
        assert!(!Saved::Damaged("x".into()).on());
        assert!(Saved::On.chosen() && Saved::Off.chosen());
        assert!(!Saved::Unset.chosen() && !Saved::Damaged("x".into()).chosen());
        for net in ChiaNet::ALL {
            let dir = temp_dir(&format!("default-{}", net.id()));
            let switch = BeaconSwitch::read(net, dir.join(BEACON_FILE), EnvSwitch::Unset);
            assert!(!switch.on(), "{net:?}: no file, no beacon");
            assert_eq!(switch.view(), BeaconView { on: false, chosen: false, held: false, damaged: false, status: None }, "{net:?}");
            assert_eq!(switch.start_line(), None, "{net:?}: and nothing to say, as before the switch");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn the_environment_decides_before_the_switch() {
        // Exactly `1` lights it, as it always did; unset or empty leaves it
        // to the switch; anything else that is set holds it off.
        assert_eq!(env_switch_of(None), EnvSwitch::Unset);
        assert_eq!(env_switch_of(Some(OsStr::new(""))), EnvSwitch::Unset);
        assert_eq!(env_switch_of(Some(OsStr::new("1"))), EnvSwitch::On);
        for other in ["0", "true", "on", " 1", "1 ", "yes", "2"] {
            assert_eq!(env_switch_of(Some(OsStr::new(other))), EnvSwitch::Off, "{other:?}");
        }
        for saved in [Saved::Unset, Saved::On, Saved::Off, Saved::Damaged("x".into())] {
            assert!(lit(&saved, EnvSwitch::On), "{saved:?}: SSF_CHIA_BEACON=1 needs no switch");
            assert!(!lit(&saved, EnvSwitch::Off), "{saved:?}: and another value overrides it");
            assert_eq!(lit(&saved, EnvSwitch::Unset), saved == Saved::On, "{saved:?}: unset, the player's on alone lights it");
        }
        // The view says who decides.
        assert_eq!(view_of(&Saved::Off, EnvSwitch::On), BeaconView { on: true, chosen: true, held: true, damaged: false, status: None });
        assert_eq!(view_of(&Saved::On, EnvSwitch::Off), BeaconView { on: false, chosen: true, held: true, damaged: false, status: None });
        assert_eq!(view_of(&Saved::On, EnvSwitch::Unset), BeaconView { on: true, chosen: true, held: false, damaged: false, status: None });
        assert_eq!(view_of(&Saved::Damaged("x".into()), EnvSwitch::Unset), BeaconView { on: false, chosen: false, held: false, damaged: true, status: None });
    }

    #[test]
    fn the_file_is_read_as_it_stands_and_one_that_cannot_be_read_is_damaged_not_guessed() {
        let dir = temp_dir("read");
        let path = dir.join(BEACON_FILE);
        assert_eq!(saved_of(&path), Saved::Unset, "nothing there");
        save(&path, true, 1_700_000_000).unwrap();
        assert_eq!(saved_of(&path), Saved::On);
        assert_eq!(serde_json::from_slice::<BeaconFile>(&std::fs::read(&path).unwrap()).unwrap(), BeaconFile { on: true, at: 1_700_000_000 });
        save(&path, false, 1_700_000_100).unwrap();
        assert_eq!(saved_of(&path), Saved::Off);
        // A hand-written file without the time still reads.
        std::fs::write(&path, br#"{"on":true}"#).unwrap();
        assert_eq!(saved_of(&path), Saved::On);
        // Only the file itself is left: no temporary beside it.
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, [BEACON_FILE]);
        for junk in [&b"not json"[..], b"{}", b"[]", br#"{"on":"yes"}"#, b""] {
            std::fs::write(&path, junk).unwrap();
            assert!(matches!(saved_of(&path), Saved::Damaged(_)), "{:?}", String::from_utf8_lossy(junk));
        }
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
        let path = dir.join(BEACON_FILE);
        save(&path, true, 1).unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_is_kept_per_network() {
        assert_eq!(ChiaNet::Testnet11.path(BEACON_FILE), Path::new("chia_beacon.json"));
        assert_eq!(ChiaNet::Mainnet.path(BEACON_FILE), Path::new("chia-mainnet").join("chia_beacon.json"));
        // A beacon lit on one network lights none on the other, in one folder.
        let dir = temp_dir("per-net");
        std::fs::create_dir_all(dir.join("chia-mainnet")).unwrap();
        let test = BeaconSwitch::read(ChiaNet::Testnet11, dir.join(ChiaNet::Testnet11.path(BEACON_FILE)), EnvSwitch::Unset);
        assert_eq!(test.turn(true, 5, false).status, "200 OK");
        let main = BeaconSwitch::read(ChiaNet::Mainnet, dir.join(ChiaNet::Mainnet.path(BEACON_FILE)), EnvSwitch::Unset);
        assert!(test.on() && !main.on());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_route_asks_for_one_turn_and_an_on_names_its_network_and_node() {
        assert_eq!(beacon_asked("/api/chia/beacon?on=0"), Some(BeaconAsk { on: false, net: None, node: None }));
        assert_eq!(beacon_asked("/api/chia/beacon?on=1&net=testnet11&node=aa11"), Some(BeaconAsk { on: true, net: Some("testnet11"), node: Some("aa11") }));
        assert_eq!(beacon_asked("/api/chia/beacon?node=aa11&net=mainnet&on=1"), Some(BeaconAsk { on: true, net: Some("mainnet"), node: Some("aa11") }));
        for bad in [
            "/api/chia/beacon",
            "/api/chia/beacon?",
            "/api/chia/beacon?on=2",
            "/api/chia/beacon?on=1&on=0",
            "/api/chia/beacon?on=1&net=a&net=b&node=c",
            "/api/chia/beacon?on=1&extra=1",
            "/api/chia/beacon?net=testnet11&node=aa11",
            "/api/chia/listing?on=0",
            "/api/chia/beacons?on=0",
        ] {
            assert_eq!(beacon_asked(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_gate_takes_an_on_only_from_this_computers_page_for_this_node_on_this_network() {
        for net in ChiaNet::ALL {
            let on = format!("/api/chia/beacon?on=1&net={}&node={NODE}", net.id());
            assert_eq!(beacon_gate(true, &on, net, NODE), Ok(true), "{net:?}");
            assert_eq!(beacon_gate(true, "/api/chia/beacon?on=0", net, NODE), Ok(false), "{net:?}: an off names nothing");
            // Not this computer's own page: nothing is taken, an off included.
            for target in [on.as_str(), "/api/chia/beacon?on=0"] {
                let (status, body) = beacon_gate(false, target, net, NODE).unwrap_err();
                assert_eq!((status, body["error"].as_str()), ("403 Forbidden", Some(PAGE_ONLY_WORDS)), "{net:?} {target}");
            }
            // Confirmed for the other network, or for another node.
            let other = ChiaNet::ALL.into_iter().find(|n| *n != net).unwrap();
            let elsewhere = format!("/api/chia/beacon?on=1&net={}&node={NODE}", other.id());
            let (status, body) = beacon_gate(true, &elsewhere, net, NODE).unwrap_err();
            assert_eq!(status, "409 Conflict");
            assert_eq!(body["error"].as_str(), Some(other_network_words(net).as_str()));
            let another = format!("/api/chia/beacon?on=1&net={}&node=bb22", net.id());
            let (status, body) = beacon_gate(true, &another, net, NODE).unwrap_err();
            assert_eq!((status, body["error"].as_str()), ("409 Conflict", Some(OTHER_NODE_WORDS)));
            // An on that names neither, or one of the two.
            for bare in ["/api/chia/beacon?on=1".to_string(), format!("/api/chia/beacon?on=1&net={}", net.id()), format!("/api/chia/beacon?on=1&node={NODE}"), "/api/chia/beacon?on=maybe".to_string()] {
                let (status, body) = beacon_gate(true, &bare, net, NODE).unwrap_err();
                assert_eq!((status, body["error"].as_str()), ("400 Bad Request", Some(BAD_ASK_WORDS)), "{bare}");
            }
        }
    }

    #[test]
    fn a_turn_holds_at_once_is_saved_and_says_whether_it_lit_a_beacon() {
        let dir = temp_dir("turn");
        let path = dir.join(BEACON_FILE);
        let switch = BeaconSwitch::read(ChiaNet::Testnet11, path.clone(), EnvSwitch::Unset);
        let lit_turn = switch.turn(true, 10, false);
        assert_eq!(lit_turn.status, "200 OK");
        assert_eq!(lit_turn.body, serde_json::json!({ "ok": true, "beacon": { "on": true, "chosen": true } }));
        assert!(lit_turn.newly_lit && !lit_turn.failed);
        assert_eq!(lit_turn.line.as_deref(), Some(turned_line(ChiaNet::Testnet11, true).as_str()));
        assert!(switch.on());
        assert_eq!(saved_of(&path), Saved::On, "and the next start reads it");
        // On again: taken, and no beacon is newly lit.
        let again = switch.turn(true, 11, false);
        assert!(again.status == "200 OK" && !again.newly_lit);
        let out = switch.turn(false, 12, false);
        assert_eq!(out.body, serde_json::json!({ "ok": true, "beacon": { "on": false, "chosen": true } }));
        assert!(!out.newly_lit && !switch.on());
        assert_eq!(out.line.as_deref(), Some(turned_line(ChiaNet::Testnet11, false).as_str()));
        assert_eq!(saved_of(&path), Saved::Off);
        // A later start reads what was saved.
        assert!(!BeaconSwitch::read(ChiaNet::Testnet11, path.clone(), EnvSwitch::Unset).on());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_on_is_refused_while_chia_is_off_and_an_off_is_taken() {
        let dir = temp_dir("strict");
        let path = dir.join(BEACON_FILE);
        let switch = BeaconSwitch::read(ChiaNet::Testnet11, path.clone(), EnvSwitch::Unset);
        let refused = switch.turn(true, 1, true);
        assert_eq!(refused.status, "409 Conflict");
        assert_eq!(refused.body["error"].as_str(), Some(CHIA_OFF_WORDS));
        assert!(refused.line.is_none() && !refused.failed && !refused.newly_lit);
        assert_eq!(saved_of(&path), Saved::Unset, "nothing was saved");
        save(&path, true, 2).unwrap();
        let switch = BeaconSwitch::read(ChiaNet::Testnet11, path.clone(), EnvSwitch::Unset);
        assert_eq!(switch.turn(false, 3, true).status, "200 OK");
        assert_eq!(saved_of(&path), Saved::Off);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_environment_refuses_the_turn_it_holds_against_and_saves_nothing() {
        let dir = temp_dir("held");
        let path = dir.join(BEACON_FILE);
        // Held off: an on is refused, an off is taken.
        let off = BeaconSwitch::read(ChiaNet::Testnet11, path.clone(), EnvSwitch::Off);
        let refused = off.turn(true, 1, false);
        assert_eq!((refused.status, refused.body["error"].as_str()), ("409 Conflict", Some(HELD_OFF_WORDS)));
        assert_eq!(refused.body["beacon"], serde_json::json!({ "on": false, "chosen": false, "held": true }));
        assert_eq!(saved_of(&path), Saved::Unset);
        assert!(!off.on());
        assert_eq!(off.turn(false, 2, false).status, "200 OK");
        // Held on: an off is refused, and the beacon stays lit; an on is
        // taken and only remembered, so it lights nothing new.
        std::fs::remove_file(&path).unwrap();
        let on = BeaconSwitch::read(ChiaNet::Testnet11, path.clone(), EnvSwitch::On);
        assert!(on.on());
        let refused = on.turn(false, 3, false);
        assert_eq!((refused.status, refused.body["error"].as_str()), ("409 Conflict", Some(HELD_ON_WORDS)));
        assert_eq!(saved_of(&path), Saved::Unset);
        assert!(on.on());
        let kept = on.turn(true, 4, false);
        assert!(kept.status == "200 OK" && !kept.newly_lit);
        assert_eq!(saved_of(&path), Saved::On);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_on_the_disk_would_not_keep_is_not_lit_and_an_off_holds_whatever_the_disk_does() {
        let dir = temp_dir("disk");
        let path = dir.join(BEACON_FILE);
        let fails = |_: &Path, _: bool, _: u64| -> std::io::Result<()> { Err(std::io::Error::other("disk full")) };
        let switch = BeaconSwitch::read(ChiaNet::Testnet11, path.clone(), EnvSwitch::Unset);
        // The save failed and nothing reads on: not lit.
        let refused = switch.turn_with(true, 1, false, fails);
        assert_eq!(refused.status, "409 Conflict");
        assert_eq!(refused.body["error"].as_str(), Some("The beacon was not lit: its switch could not be saved (disk full)"));
        assert!(refused.failed && !refused.newly_lit && !switch.on());
        // The save reported a failure after the file took its name: the
        // next start reads on, so the turn is taken and the log says so.
        let wrote_then_failed = |p: &Path, on: bool, now: u64| -> std::io::Result<()> {
            save(p, on, now)?;
            Err(std::io::Error::other("dir sync failed"))
        };
        let taken = switch.turn_with(true, 2, false, wrote_then_failed);
        assert_eq!(taken.status, "200 OK");
        assert!(taken.newly_lit && switch.on());
        assert!(taken.line.as_deref().unwrap().contains("its save was not confirmed (dir sync failed)"));
        // An off whose save failed: out for the rest of the run, and the
        // answer says what the next start reads (the file still says on).
        let off = switch.turn_with(false, 3, false, fails);
        assert_eq!(off.status, "409 Conflict");
        assert_eq!(
            off.body["error"].as_str(),
            Some("The beacon is out until this computer's node stops, but its switch could not be saved (disk full): at the node's next start it reads lit again")
        );
        assert!(!switch.on() && off.failed);
        assert_eq!(off.body["beacon"], serde_json::json!({ "on": false, "chosen": true }));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_status_rides_only_on_a_lit_beacons_view() {
        let status = BeaconStatus { era: 7, reachable: true, serves_welcome: false, sent: false, confirmed: false };
        let lit_view = view_of(&Saved::On, EnvSwitch::Unset).with(Some(status));
        assert_eq!(lit_view.status, Some(status));
        assert_eq!(
            serde_json::to_string(&lit_view).unwrap(),
            r#"{"on":true,"chosen":true,"status":{"era":7,"reachable":true,"serves_welcome":false,"sent":false,"confirmed":false}}"#
        );
        // Put out: the publisher's last look says nothing of now.
        assert_eq!(view_of(&Saved::Off, EnvSwitch::Unset).with(Some(status)).status, None);
        assert_eq!(serde_json::to_string(&view_of(&Saved::Off, EnvSwitch::Unset)).unwrap(), r#"{"on":false,"chosen":true}"#);
        let back: BeaconView = serde_json::from_str(r#"{"on":true,"chosen":false,"held":true}"#).unwrap();
        assert_eq!(back, BeaconView { on: true, chosen: false, held: true, damaged: false, status: None });
    }

    #[test]
    fn the_startup_line_says_who_decided_and_what_a_lit_beacon_writes() {
        for net in ChiaNet::ALL {
            let name = net.name();
            assert_eq!(start_line(net, &Saved::Unset, EnvSwitch::Unset), None);
            let lit_line = start_line(net, &Saved::On, EnvSwitch::Unset).unwrap();
            assert!(lit_line.starts_with(&format!("🔦 Beacon: on for {name}, lit in the SpacePhone's Network settings.")), "{lit_line}");
            assert!(lit_line.contains("writes its node id in the clear once an edition"), "{lit_line}");
            assert!(lit_line.contains("the lobby dish funds"), "{lit_line}");
            assert!(start_line(net, &Saved::Off, EnvSwitch::Unset).unwrap().starts_with(&format!("🔦 Beacon: off for {name}.")));
            let damaged = start_line(net, &Saved::Damaged("the file is odd".into()), EnvSwitch::Unset).unwrap();
            assert!(damaged.starts_with("⚠️  Beacon: the file is odd. A switch that cannot be read counts as off"), "{damaged}");
            // The environment's word is said whatever the file reads.
            for saved in [Saved::Unset, Saved::On, Saved::Off] {
                assert!(start_line(net, &saved, EnvSwitch::On).unwrap().contains("held on by SSF_CHIA_BEACON=1"), "{saved:?}");
                assert!(start_line(net, &saved, EnvSwitch::Off).unwrap().contains("held off by SSF_CHIA_BEACON"), "{saved:?}");
            }
            // No line names an address or asks for funding.
            for line in [turned_line(net, true), turned_line(net, false), lit_line] {
                assert!(!line.contains("txch1") && !line.contains("xch1") && !line.to_lowercase().contains("fund it"), "{line}");
            }
            assert!(turned_line(net, false).contains("is not withdrawn"));
        }
    }

    /// The variable is read in one place, once, and the publisher asks the
    /// hub's switch, not the environment.
    #[test]
    fn the_environment_is_read_here_alone() {
        let own = include_str!("chia_beacon_switch.rs").replace("\r\n", "\n");
        let own = own.split("\n#[cfg(test)]\nmod tests {").next().unwrap();
        let reads: Vec<&str> = own.lines().map(str::trim).filter(|l| !l.starts_with("//") && l.contains("var_os(")).collect();
        assert_eq!(reads, ["*ENV.get_or_init(|| env_switch_of(std::env::var_os(BEACON_ENV).as_deref()))"]);
        for (name, source) in [("chia_publish.rs", include_str!("chia_publish.rs")), ("main.rs", include_str!("main.rs"))] {
            let source = source.replace("\r\n", "\n");
            for line in source.lines().map(str::trim).filter(|l| !l.starts_with("//")) {
                assert!(!(line.contains("env::var") && line.contains("SSF_CHIA_BEACON")), "{name} reads the variable itself: {line}");
                assert!(!(line.contains("env::var") && line.contains("BEACON_ENV")), "{name} reads the variable itself: {line}");
            }
        }
    }
}
