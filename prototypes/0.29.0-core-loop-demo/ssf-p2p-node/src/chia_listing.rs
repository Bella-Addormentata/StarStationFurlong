//! 📖 LIST ME: the player's switch for this station's Phone Book writes on
//! one Chia network (stage 4 of the mainnet transition, design §4.5 (6)).
//!
//! A station writes two things into the Phone Book: its listing, once an
//! edition, and a knock on a host it holds a card for and cannot reach. On a
//! network whose coins are real money neither is paid by the SSF wallet and
//! neither names it (chia_publish.rs `burner_paths`). Even so a write shows
//! that some Star Station node wrote, and when, and the Chia full nodes the
//! station talks to see its IP address. So there the station writes neither
//! until its player says so, with LIST ME. On a test network the switch
//! starts on, as it always was (#231 D4: a publishing node is findable
//! unless told otherwise), and the player can turn it off.
//!
//! The switch is kept per network, in [`LISTING_FILE`] through
//! `ChiaNet::path`, owner-only: a LIST ME on testnet11 says nothing about
//! mainnet. No file means the network's default ([`default_on`]). A file
//! that is there but cannot be read counts as off on every network, and the
//! node says so.
//!
//! The SpacePhone's Network settings turn it with `POST /api/chia/listing`
//! (main.rs), behind the wallet switch's gate
//! (chia_wallet_switch::local_page): `on=0` for off, and
//! `on=1&net=<network id>&node=<iroh node id>` for on. An on is the
//! player's word for one network on one station node, the ones whose
//! warning stood on the page at CONFIRM, so it names both and only that
//! node on that network takes it ([`listing_gate`]): a node started on
//! another network at the same port meanwhile refuses. An off names
//! neither and is always taken.
//!
//! A turn holds from the publisher's next tick, within the run: turned on,
//! the listing goes out as a station's first in an edition does; turned
//! off, nothing more is written, the knocks waiting to be written are
//! dropped, and a write already sent is not sent again: the wallet lease
//! asks this switch before a saved bundle of a listing's or a knock's goes
//! to the peers once more (chia_publish.rs `Resend`). What is on the chain
//! already stays there: readers stop finding a listing once its edition
//! and the next have passed.
//!
//! `SSF_CHIA_FINDABLE=0` still wins for the listing: with it the station
//! writes none, whatever the switch says ([`ListingView::held`]). The knocks
//! follow the switch alone, as they never followed that variable. Chia off
//! on this computer (chia_strict.rs) wins over all of it: nothing is read or
//! written, and an on is refused until Chia is back.
//!
//! The switch says whether the listing's and the knocks' arms may write.
//! Whose key pays is another question (`burner_paths`), and whether a
//! publisher runs at all a third: with no SSF wallet on there is none, and
//! the switch waits for it.
//!
//! The listing's and the knocks' writers are handed the switch's word as a
//! value ([`Listed`]) that only a switch that is on gives out, so no call
//! reaches them that did not ask it.
//!
//! Every decision rests on a pure function or on a [`ListMe`], and a test
//! makes a switch of its own over a file of its own, so the tests never
//! touch the process's network, its environment or the node's file.
#![cfg_attr(not(feature = "chia-publish"), allow(dead_code))]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::chia_network::ChiaNet;

/// The switch's file, one per network (`ChiaNet::path`): the bare name on
/// testnet11, `chia-mainnet/chia_listing.json` on mainnet.
pub const LISTING_FILE: &str = "chia_listing.json";

/// The switch's file's contents.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct ListingFile {
    pub on: bool,
    /// When the switch was turned, unix seconds (for the operator reading it).
    #[serde(default)]
    pub at: u64,
}

/// What the switch's file says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Saved {
    /// No file: the player never turned the switch on this network, and its
    /// default stands ([`default_on`]).
    Unset,
    /// The file says `"on": true`.
    On,
    /// The file says `"on": false`.
    Off,
    /// Something is there that is not a switch the node can read: counts as
    /// off, on every network. The reason, in the node's words.
    Damaged(String),
}

impl Saved {
    /// Whether this is LIST ME on, on `net`: the player's word, the
    /// network's default where there is none, and off for a file that
    /// cannot be read (fails closed).
    pub fn on(&self, net: ChiaNet) -> bool {
        match self {
            Saved::Unset => default_on(net),
            Saved::On => true,
            Saved::Off | Saved::Damaged(_) => false,
        }
    }

    /// Whether the player turned the switch on this network: a file the
    /// node can read.
    pub fn chosen(&self) -> bool {
        matches!(self, Saved::On | Saved::Off)
    }
}

/// The switch where the player never turned it: on for a test network, as
/// the listing always was there (#231 D4), and off where the coins are real
/// money (stage 4 design §4.5 (6)).
pub fn default_on(net: ChiaNet) -> bool {
    net.is_test()
}

/// Read the switch's file at `path` ([`Saved`]). Nothing at `path` is
/// unset. A link to nothing reads as missing through the link, so the entry
/// itself is looked at: anything there that does not read as a switch is
/// damaged, a folder too.
pub fn saved_of(path: &Path) -> Saved {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<ListingFile>(&bytes) {
            Ok(file) if file.on => Saved::On,
            Ok(_) => Saved::Off,
            Err(e) => Saved::Damaged(format!("{} is not a LIST ME switch the node can read ({e})", path.display())),
        },
        Err(e) => match std::fs::symlink_metadata(path) {
            Err(gone) if e.kind() == std::io::ErrorKind::NotFound && gone.kind() == std::io::ErrorKind::NotFound => Saved::Unset,
            Ok(entry) if entry.is_dir() => Saved::Damaged(format!("{} is a folder, not a LIST ME switch the node can read", path.display())),
            _ => Saved::Damaged(format!("{} cannot be read ({e})", path.display())),
        },
    }
}

/// Save the switch at `path`: written whole (a temporary file renamed over
/// it, the directory synced), owner-only (private_file.rs).
pub fn save(path: &Path, on: bool, now: u64) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&ListingFile { on, at: now }).map_err(std::io::Error::other)?;
    crate::private_file::write_private(path, &bytes)
}

/// The switch's word that it is on, for the listing's and the knocks'
/// writers (chia_publish.rs): only [`ListMe::listed`] makes one, from a
/// switch that is on when asked, so a writer that takes one was reached
/// through the switch. It is asked anew each tick and never kept: a turn to
/// off holds from the next.
#[derive(Debug)]
pub struct Listed(());

impl Listed {
    /// The word of a switch that is on, for a test of a writer.
    #[cfg(test)]
    pub(crate) fn for_test() -> Self {
        Listed(())
    }
}

/// The fingerprint's `chia_listing`, for the page:
///   - `on`: LIST ME is on for this node's network, by the player's word or
///     the network's default, so its publisher may write the listing and
///     the knocks;
///   - `chosen`: the player turned the switch on this network (`false`: the
///     default stands, or the file cannot be read);
///   - `held`, only when true: `SSF_CHIA_FINDABLE=0` in the node's
///     environment holds the listing off whatever `on` says (the knocks
///     follow `on`);
///   - `damaged`, only when true: the switch's file is there but cannot be
///     read, so it counts as off until it is turned again;
///   - `dish`, only when true: what the switch allows is written from keys
///     of their own that the lobby dish pays for (burner keys,
///     `chia_publish::burners`), so the SSF wallet pays for no listing and
///     no knock, and a coin in it lists nothing. A node from before this
///     field never says it, and on a test network the page then takes the
///     wallet to pay, as it did there.
///
/// It says what the switch says, never whether anything was written: the
/// listing's own readout is `chia_presence`, and with no SSF wallet on no
/// publisher runs whatever this says.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListingView {
    pub on: bool,
    pub chosen: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub damaged: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dish: bool,
}

/// The view of the file as it reads now (`saved`) on `net`, with whether
/// the environment leaves the listing on (`findable`: `SSF_CHIA_FINDABLE`
/// is not `0`). Who pays is not the file's to say: `dish` is the process's
/// ([`ListMe::paid_by_dish`]).
pub fn view_of(net: ChiaNet, saved: &Saved, findable: bool) -> ListingView {
    ListingView { on: saved.on(net), chosen: saved.chosen(), held: !findable, damaged: matches!(saved, Saved::Damaged(_)), dish: false }
}

/// What the page asks of the route: the turn, and for which network and
/// which station node its player confirmed it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ListingAsk<'a> {
    pub on: bool,
    /// `net=`: the network the page showed, by its id ([`ChiaNet::id`]).
    pub net: Option<&'a str>,
    /// `node=`: the node the page showed, by its iroh node id.
    pub node: Option<&'a str>,
}

/// The route's query: `/api/chia/listing?on=0` turns LIST ME off, and
/// `on=1&net=<network id>&node=<iroh node id>` turns it on. Each key at
/// most once, in any order, and no other key.
pub fn listing_asked(target: &str) -> Option<ListingAsk<'_>> {
    let (path, query) = target.split_once('?')?;
    if path != "/api/chia/listing" {
        return None;
    }
    let (mut on, mut net, mut node) = (None, None, None);
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        let taken = match key {
            "on" => on.replace(match value {
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
    Some(ListingAsk { on: on?, net, node })
}

/// The route's refusal for a request from anything but this computer's own
/// game page (chia_wallet_switch::local_page).
pub const PAGE_ONLY_WORDS: &str = "only this computer's own Star Station page can turn LIST ME on or off";

/// The route's refusal for a query it does not know.
pub const BAD_ASK_WORDS: &str = "ask with on=0, or with on=1 and the net= and node= the LIST ME was confirmed for";

/// The route's refusal of an on confirmed for another network than this
/// node runs on.
pub fn other_network_words(net: ChiaNet) -> String {
    format!(
        "LIST ME was not turned on: it was confirmed for another network than the one this station node runs on now ({}). Look at the Network settings again",
        net.name()
    )
}

/// The route's refusal of an on confirmed for another station node.
pub const OTHER_NODE_WORDS: &str =
    "LIST ME was not turned on: it was confirmed for another station node than the one that answers now. Look at the Network settings again";

/// The route's refusal for a build that only reads the chain: it writes no
/// listing and no knock, so it has no switch.
#[cfg_attr(feature = "chia-publish", allow(dead_code))]
pub const UNBUILT_WORDS: &str = "this build of the node only reads the chain, so it has no listing to turn on or off";

/// The route's gate and query: `Ok(on)` for a turn to make, or the
/// refusal's status and body. `local` is chia_wallet_switch::local_page, the
/// wallet switch's gate: an allowed loopback or desktop-app Origin, never a
/// web origin or none, sent to a loopback Host on the API's own port. A
/// forged page that turned the wallet on can still start no write: this
/// switch is behind the same gate, and off where the coins are real.
///
/// An on is the player's word for one network on one station node, so it
/// names both, as the page showed them when its player tapped CONFIRM, and
/// is taken only by that node on that network (`net`, `node_id`: this
/// node's own). A node started on another network at the same port while a
/// confirmation stood open on the page is asked for the network the player
/// read, and refuses. An off names neither and is always taken: it only
/// stops writes, on whichever network this node would make them.
pub fn listing_gate(local: bool, target: &str, net: ChiaNet, node_id: &str) -> Result<bool, (&'static str, serde_json::Value)> {
    let refused = |status: &'static str, error: &str| Err((status, serde_json::json!({ "ok": false, "error": error })));
    if !local {
        return refused("403 Forbidden", PAGE_ONLY_WORDS);
    }
    let Some(ask) = listing_asked(target) else {
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

/// An on's refusal while Chia is off on this computer: the switch would
/// promise writes the node does not make. An off is taken then too.
pub const CHIA_OFF_WORDS: &str = "Chia is off on this computer, so LIST ME cannot be turned on; turn Chia back on first";

/// The startup line for the switch as it read (`saved`) on `net`: what the
/// station writes into the Phone Book there, and where that is changed.
/// `None` on a test network whose switch was never turned: its listing is
/// on as it always was, and the publisher's own lines say the rest.
pub fn start_line(net: ChiaNet, saved: &Saved) -> Option<String> {
    let name = net.name();
    match saved {
        Saved::Unset if default_on(net) => None,
        Saved::Unset => Some(format!(
            "📖 LIST ME: off for {name}, where it starts off. This station writes no Phone Book listing and no knock there until its player turns LIST ME on in the SpacePhone's Network settings."
        )),
        Saved::On => Some(format!(
            "📖 LIST ME: on for {name}. With its SSF wallet on, this station writes its Phone Book listing and its knocks there, until LIST ME is turned off in the SpacePhone's Network settings."
        )),
        Saved::Off => Some(format!(
            "📖 LIST ME: off for {name}. This station writes no Phone Book listing and no knock there until its player turns LIST ME on in the SpacePhone's Network settings."
        )),
        Saved::Damaged(why) => Some(format!(
            "⚠️  LIST ME: {why}. A switch that cannot be read counts as off: this station writes no Phone Book listing and no knock on {name} until LIST ME is turned on again in the SpacePhone's Network settings."
        )),
    }
}

/// The log line of a turn that was taken, on `net`. `held`:
/// `SSF_CHIA_FINDABLE=0` holds the listing off whatever the switch says.
pub fn turned_line(net: ChiaNet, on: bool, held: bool) -> String {
    let name = net.name();
    match (on, held) {
        (true, false) => format!(
            "📖 LIST ME: turned on for {name} in the SpacePhone's Network settings. With its SSF wallet on, this station writes its Phone Book listing and its knocks there from the publisher's next round, and at every start until it is turned off."
        ),
        (true, true) => format!(
            "📖 LIST ME: turned on for {name} in the SpacePhone's Network settings. With its SSF wallet on, this station writes its knocks there from the publisher's next round; SSF_CHIA_FINDABLE=0 in its environment still holds its listing off."
        ),
        (false, _) => format!(
            "📖 LIST ME: turned off for {name} in the SpacePhone's Network settings. This station writes no Phone Book listing and no knock there from now on, and none at any start until it is turned back on. What it wrote before stays on the chain."
        ),
    }
}

/// The answer of one turn of the switch, and what the node says.
#[derive(Clone, Debug, PartialEq)]
pub struct ListingTurn {
    /// The route's status line: 200, or 409 for a refusal or a failed save.
    pub status: &'static str,
    /// `{"ok": true, "listing"}` or `{"ok": false, "error", "listing"}`,
    /// with the switch's view after the turn as `listing` ([`ListingView`]).
    pub body: serde_json::Value,
    /// The log line, if any: none for a refusal.
    pub line: Option<String>,
    /// The line is a failure's, for stderr.
    pub failed: bool,
}

impl ListingTurn {
    fn taken(view: ListingView, line: String) -> Self {
        Self { status: "200 OK", body: serde_json::json!({ "ok": true, "listing": view }), line: Some(line), failed: false }
    }

    fn refused(error: &str, view: ListingView, line: Option<String>) -> Self {
        Self { status: "409 Conflict", body: serde_json::json!({ "ok": false, "error": error, "listing": view }), failed: line.is_some(), line }
    }
}

/// The LIST ME switch of one process, for its network, over its file: the
/// process has one (main.rs, the hub's), and a test makes its own over a
/// file of its own.
pub struct ListMe {
    net: ChiaNet,
    path: PathBuf,
    /// `SSF_CHIA_FINDABLE` is not `0`, as the process read it.
    findable: bool,
    /// Burner keys are on for this run, so the lobby dish pays for what the
    /// switch allows ([`ListMe::paid_by_dish`]).
    dish: bool,
    /// The file as it reads now: the start's, then each turn's. An off whose
    /// save failed is kept here as off for the rest of the run.
    saved: Mutex<Saved>,
}

impl ListMe {
    /// The switch of `net` over `path` (`net.path(LISTING_FILE)` for the
    /// process's), read now, with `findable` for `SSF_CHIA_FINDABLE` not
    /// being `0`. Read whether or not Chia is off on this computer: it is a
    /// setting on this disk, not a read of the chain, and nothing is made
    /// from it.
    pub fn read(net: ChiaNet, path: PathBuf, findable: bool) -> Self {
        let saved = Mutex::new(saved_of(&path));
        Self { net, path, findable, dish: false, saved }
    }

    /// The switch, with who pays for the listing and the knocks it allows:
    /// `dish` when this run writes them from burner keys the lobby dish
    /// funds (the process's is `chia_publish::burners_enabled()`). Every
    /// view says it then ([`ListingView`]'s `dish`), the fingerprint's and
    /// a turn's answer alike, so the Bank never promises a listing for a
    /// coin in a wallet that pays for none.
    pub fn paid_by_dish(mut self, dish: bool) -> Self {
        self.dish = dish;
        self
    }

    /// The view over the file as `saved` reads it, with this run's `dish`.
    fn view_over(&self, saved: &Saved) -> ListingView {
        ListingView { dish: self.dish, ..view_of(self.net, saved, self.findable) }
    }

    /// The switch's word for the writers, when it is on ([`Listed`]): asked
    /// at each tick and each dial, never kept.
    pub fn listed(&self) -> Option<Listed> {
        self.saved.lock().unwrap().on(self.net).then_some(Listed(()))
    }

    /// Whether LIST ME is on now.
    pub fn on(&self) -> bool {
        self.listed().is_some()
    }

    /// The fingerprint's view of the switch now.
    pub fn view(&self) -> ListingView {
        self.view_over(&self.saved.lock().unwrap())
    }

    /// The startup line ([`start_line`]).
    pub fn start_line(&self) -> Option<String> {
        start_line(self.net, &self.saved.lock().unwrap())
    }

    /// One turn of the switch at `now` (unix seconds), with whether Chia is
    /// off on this computer (`chia_off`).
    ///
    /// An on is saved first and holds only once the file reads on: a switch
    /// the disk would not keep is not turned on, since the next start would
    /// read something else. A save can report a failure after the new file
    /// took its name (the folder's sync comes last, private_file.rs), so a
    /// failed save is judged by what the file reads then, which is what the
    /// next start reads: on, the turn is taken and the node's log says the
    /// save was not confirmed; anything else, it is refused. The player is
    /// never told "not turned on" over a file that turns it on at the next
    /// start. It is refused while Chia is off ([`CHIA_OFF_WORDS`]).
    ///
    /// An off holds from this call whatever the disk does: when its save
    /// fails, the switch is off for the rest of the run and the answer says
    /// what the next start will read.
    pub fn turn(&self, on: bool, now: u64, chia_off: bool) -> ListingTurn {
        self.turn_with(on, now, chia_off, save)
    }

    /// [`ListMe::turn`] with the save it makes (a test's can fail after it
    /// wrote the file).
    fn turn_with(&self, on: bool, now: u64, chia_off: bool, save: impl FnOnce(&Path, bool, u64) -> std::io::Result<()>) -> ListingTurn {
        let mut saved = self.saved.lock().unwrap();
        let view = |saved: &Saved| self.view_over(saved);
        if on && chia_off {
            return ListingTurn::refused(CHIA_OFF_WORDS, view(&saved), None);
        }
        let file = self.path.display();
        match (save(&self.path, on, now), on) {
            (Ok(()), _) => {
                *saved = if on { Saved::On } else { Saved::Off };
                ListingTurn::taken(view(&saved), turned_line(self.net, on, !self.findable))
            }
            (Err(e), true) if matches!(saved_of(&self.path), Saved::On) => {
                *saved = Saved::On;
                let mut turn = ListingTurn::taken(view(&saved), turned_line(self.net, true, !self.findable));
                if let Some(line) = turn.line.as_mut() {
                    line.push_str(&format!(
                        "\n⚠️  LIST ME: {file} reads on, but its save was not confirmed ({e}): after a power cut it may read as it did before"
                    ));
                }
                turn
            }
            (Err(e), true) => ListingTurn::refused(
                &format!("LIST ME was not turned on: its switch could not be saved ({e})"),
                view(&saved),
                Some(format!("⚠️  LIST ME: {file} could not be saved ({e}), so it was not turned on")),
            ),
            (Err(e), false) => {
                let next = if saved_of(&self.path).on(self.net) { "on again" } else { "off" };
                *saved = Saved::Off;
                ListingTurn::refused(
                    &format!("LIST ME is off until your station node stops, but its switch could not be saved ({e}): at the node's next start it reads {next}"),
                    view(&saved),
                    Some(format!(
                        "⚠️  LIST ME: turned off for the rest of this run, but {file} could not be saved ({e}); the next start reads it {next}"
                    )),
                )
            }
        }
    }
}

/// The time now, in unix seconds, for the file's `at`.
pub fn unix_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A folder of its own for one test's switch file.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ssf-chia-listing-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_switch_starts_off_where_coins_are_real_and_on_where_they_are_not() {
        // Stage 4 design §4.5 (6): off by default on mainnet; testnet11
        // keeps D4's on by default.
        assert!(default_on(ChiaNet::Testnet11));
        assert!(!default_on(ChiaNet::Mainnet));
        for net in ChiaNet::ALL {
            assert_eq!(Saved::Unset.on(net), net.is_test(), "{net:?}: no file is the network's default");
            assert!(Saved::On.on(net), "{net:?}: the player's on holds on every network");
            assert!(!Saved::Off.on(net), "{net:?}: and so does the player's off");
            assert!(!Saved::Damaged("x".into()).on(net), "{net:?}: a file that cannot be read counts as off");
        }
        assert!(Saved::On.chosen() && Saved::Off.chosen());
        assert!(!Saved::Unset.chosen() && !Saved::Damaged("x".into()).chosen());
    }

    #[test]
    fn the_file_is_read_as_it_stands_and_one_that_cannot_be_read_is_damaged_not_guessed() {
        let dir = temp_dir("read");
        let path = dir.join(LISTING_FILE);
        assert_eq!(saved_of(&path), Saved::Unset, "nothing there");
        save(&path, true, 1_700_000_000).unwrap();
        assert_eq!(saved_of(&path), Saved::On);
        assert_eq!(serde_json::from_slice::<ListingFile>(&std::fs::read(&path).unwrap()).unwrap(), ListingFile { on: true, at: 1_700_000_000 });
        save(&path, false, 1_700_000_100).unwrap();
        assert_eq!(saved_of(&path), Saved::Off);
        // An older or hand-written file without the time still reads.
        std::fs::write(&path, br#"{"on":true}"#).unwrap();
        assert_eq!(saved_of(&path), Saved::On);
        // Only the file itself is left: no temporary beside it.
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, vec![LISTING_FILE.to_string()]);
        for torn in [&b""[..], b"{", b"{\"on\":", b"[]", b"{\"on\":\"yes\"}", b"{\"off\":true}"] {
            std::fs::write(&path, torn).unwrap();
            let Saved::Damaged(why) = saved_of(&path) else { panic!("{:?} read as a switch", String::from_utf8_lossy(torn)) };
            assert!(why.contains(LISTING_FILE) && why.contains("not a LIST ME switch"), "{why}");
        }
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let Saved::Damaged(why) = saved_of(&path) else { panic!("a folder read as a switch") };
        assert!(why.contains("is a folder"), "{why}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_nothing_is_damaged_and_the_saved_switch_is_the_owners_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("link");
        let path = dir.join(LISTING_FILE);
        std::os::unix::fs::symlink(dir.join("nowhere"), &path).unwrap();
        // Read through the link it is missing, which on a test network would
        // be on: the entry itself is there, so it is damaged.
        assert!(matches!(saved_of(&path), Saved::Damaged(_)));
        // A turn writes the switch over the link, not through it.
        save(&path, false, 7).unwrap();
        assert_eq!(saved_of(&path), Saved::Off);
        assert!(!dir.join("nowhere").exists());
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_view_says_what_the_switch_says_on_each_network() {
        for net in ChiaNet::ALL {
            let test = net.is_test();
            assert_eq!(view_of(net, &Saved::Unset, true), ListingView { on: test, chosen: false, held: false, damaged: false, dish: false }, "{net:?}");
            assert_eq!(view_of(net, &Saved::On, true), ListingView { on: true, chosen: true, held: false, damaged: false, dish: false }, "{net:?}");
            assert_eq!(view_of(net, &Saved::Off, true), ListingView { on: false, chosen: true, held: false, damaged: false, dish: false }, "{net:?}");
            assert_eq!(view_of(net, &Saved::Damaged("x".into()), true), ListingView { on: false, chosen: false, held: false, damaged: true, dish: false }, "{net:?}");
            // SSF_CHIA_FINDABLE=0 does not turn the switch: it is said beside it.
            assert_eq!(view_of(net, &Saved::On, false), ListingView { on: true, chosen: true, held: true, damaged: false, dish: false }, "{net:?}");
        }
        // The flags are sent only when true, and an answer without them reads back.
        assert_eq!(serde_json::to_value(view_of(ChiaNet::Mainnet, &Saved::Unset, true)).unwrap(), serde_json::json!({ "on": false, "chosen": false }));
        assert_eq!(
            serde_json::to_value(view_of(ChiaNet::Mainnet, &Saved::Damaged("x".into()), false)).unwrap(),
            serde_json::json!({ "on": false, "chosen": false, "held": true, "damaged": true })
        );
        assert_eq!(
            serde_json::from_value::<ListingView>(serde_json::json!({ "on": true, "chosen": true })).unwrap(),
            ListingView { on: true, chosen: true, held: false, damaged: false, dish: false }
        );
    }

    #[test]
    fn a_switch_whose_writes_the_lobby_dish_pays_for_says_so_in_every_view() {
        // Who pays is the run's, not the file's: no view made from the file
        // alone says `dish`, and the switch says it in the fingerprint's view
        // and in a turn's answer alike, taken or refused, on or off.
        let dir = temp_dir("dish");
        for net in ChiaNet::ALL {
            for saved in [Saved::Unset, Saved::On, Saved::Off, Saved::Damaged("x".into())] {
                assert!(!view_of(net, &saved, true).dish && !view_of(net, &saved, false).dish, "{net:?} {saved:?}");
            }
            let path = dir.join(format!("{}-{LISTING_FILE}", net.id()));
            let wallet = ListMe::read(net, path.clone(), true);
            assert!(!wallet.view().dish, "{net:?}: a switch not told who pays says nothing");
            assert!(serde_json::to_value(wallet.view()).unwrap().get("dish").is_none(), "{net:?}: and the flag is not sent");
            let dish = ListMe::read(net, path.clone(), true).paid_by_dish(true);
            assert_eq!(dish.view(), ListingView { dish: true, ..wallet.view() }, "{net:?}: it changes nothing else");
            assert_eq!(serde_json::to_value(dish.view()).unwrap()["dish"], serde_json::json!(true), "{net:?}");
            let on = dish.turn(true, 1, false);
            assert_eq!(on.body, serde_json::json!({ "ok": true, "listing": { "on": true, "chosen": true, "dish": true } }), "{net:?}");
            let off = dish.turn(false, 2, false);
            assert_eq!(off.body, serde_json::json!({ "ok": true, "listing": { "on": false, "chosen": true, "dish": true } }), "{net:?}");
            let refused = dish.turn(true, 3, true);
            assert_eq!(refused.status, "409 Conflict", "{net:?}");
            assert_eq!(refused.body["listing"], serde_json::json!({ "on": false, "chosen": true, "dish": true }), "{net:?}");
            assert!(!ListMe::read(net, path.clone(), true).paid_by_dish(false).view().dish, "{net:?}: and with burner keys off it is not said");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_route_takes_on_or_off_from_this_computers_page_and_nothing_else() {
        assert_eq!(listing_asked("/api/chia/listing?on=1"), Some(ListingAsk { on: true, net: None, node: None }));
        assert_eq!(listing_asked("/api/chia/listing?on=0"), Some(ListingAsk { on: false, net: None, node: None }));
        assert_eq!(
            listing_asked("/api/chia/listing?on=1&net=mainnet&node=abc"),
            Some(ListingAsk { on: true, net: Some("mainnet"), node: Some("abc") })
        );
        assert_eq!(listing_asked("/api/chia/listing?node=abc&on=0&net="), Some(ListingAsk { on: false, net: Some(""), node: Some("abc") }));
        for bad in [
            "/api/chia/listing",
            "/api/chia/listing?",
            "/api/chia/listing?on=",
            "/api/chia/listing?on=2",
            "/api/chia/listing?on=true",
            "/api/chia/listing?on=1&x=1",
            "/api/chia/listing?on=1&on=0",
            "/api/chia/listing?on=1&net=mainnet&net=testnet11&node=abc",
            "/api/chia/listing?on=1&net=mainnet&node=abc&node=abc",
            "/api/chia/listing?net=mainnet&node=abc",
            "/api/chia/listing?on=1&net",
            "/api/chia/listing?off=1",
            "/api/chia/listing/?on=1",
            "/api/chia/lane?on=1",
            "/api/chia/wallet?on=1",
            "",
        ] {
            assert_eq!(listing_asked(bad), None, "{bad:?}");
        }
        let refused = |status: &'static str, error: &str| Err((status, serde_json::json!({ "ok": false, "error": error })));
        for net in ChiaNet::ALL {
            let on = format!("/api/chia/listing?on=1&net={}&node=abc", net.id());
            assert_eq!(listing_gate(true, &on, net, "abc"), Ok(true), "{net:?}");
            // An off names nothing, and is taken whatever it names.
            assert_eq!(listing_gate(true, "/api/chia/listing?on=0", net, "abc"), Ok(false));
            assert_eq!(listing_gate(true, "/api/chia/listing?on=0&net=nowhere&node=other", net, "abc"), Ok(false));
            // Not this computer's page: refused before the query is read at all.
            for target in [on.as_str(), "/api/chia/listing?on=0", "/api/chia/listing?on=9"] {
                assert_eq!(listing_gate(false, target, net, "abc"), refused("403 Forbidden", PAGE_ONLY_WORDS));
            }
            assert_eq!(listing_gate(true, "/api/chia/listing?on=9", net, "abc"), refused("400 Bad Request", BAD_ASK_WORDS));
        }
    }

    #[test]
    fn an_on_is_taken_only_for_the_network_and_the_node_it_was_confirmed_for() {
        // The page's player read one network's warning and tapped CONFIRM;
        // the node that answers runs on another (started there at the same
        // port meanwhile), or is another station. Neither turns on.
        let refused = |status: &'static str, error: &str| Err((status, serde_json::json!({ "ok": false, "error": error })));
        for net in ChiaNet::ALL {
            for other in ChiaNet::ALL.into_iter().filter(|other| *other != net) {
                let asked = format!("/api/chia/listing?on=1&net={}&node=abc", other.id());
                assert_eq!(listing_gate(true, &asked, net, "abc"), refused("409 Conflict", &other_network_words(net)), "{other:?} asked of {net:?}");
            }
            let here = format!("/api/chia/listing?on=1&net={}", net.id());
            assert_eq!(listing_gate(true, &format!("{here}&node=another"), net, "abc"), refused("409 Conflict", OTHER_NODE_WORDS));
            assert_eq!(listing_gate(true, &format!("{here}&node="), net, "abc"), refused("409 Conflict", OTHER_NODE_WORDS));
            // An on that names no network or no node is no confirmation.
            for bare in ["/api/chia/listing?on=1".to_string(), here.clone(), "/api/chia/listing?on=1&node=abc".to_string()] {
                assert_eq!(listing_gate(true, &bare, net, "abc"), refused("400 Bad Request", BAD_ASK_WORDS), "{bare}");
            }
            // The network is judged first: its words name where the node runs.
            assert_eq!(
                listing_gate(true, "/api/chia/listing?on=1&net=nowhere&node=another", net, "abc"),
                refused("409 Conflict", &other_network_words(net))
            );
            assert!(other_network_words(net).contains(net.name()) && !other_network_words(net).contains('\u{2014}'));
        }
    }

    #[test]
    fn an_on_whose_save_failed_after_the_file_was_written_is_on_and_says_so() {
        // The folder's sync comes after the rename (private_file.rs): the
        // save reports a failure, and the file reads on. The next start
        // would turn LIST ME on, so the player is not told it stayed off.
        let dir = temp_dir("late");
        for net in ChiaNet::ALL {
            let path = dir.join(format!("{}-{LISTING_FILE}", net.id()));
            save(&path, false, 1).unwrap();
            let switch = ListMe::read(net, path.clone(), true);
            assert!(!switch.on());
            let late = |path: &Path, on: bool, now: u64| {
                save(path, on, now)?;
                Err(std::io::Error::other("the folder could not be synced"))
            };
            let on = switch.turn_with(true, 2, false, late);
            assert_eq!(on.status, "200 OK", "{net:?}: {}", on.body);
            assert_eq!(on.body, serde_json::json!({ "ok": true, "listing": { "on": true, "chosen": true } }));
            assert!(switch.on() && switch.listed().is_some(), "{net:?}: on now, as at the next start");
            assert!(ListMe::read(net, path.clone(), true).on(), "{net:?}: the next start reads on");
            let line = on.line.unwrap();
            assert!(line.starts_with(&turned_line(net, true, false)), "{line}");
            assert!(line.contains("reads on, but its save was not confirmed (the folder could not be synced)"), "{line}");
            assert!(!on.failed);
            // A save that failed before the file changed is refused as ever:
            // the file reads off, and so does the next start.
            let off = switch.turn(false, 3, false);
            assert_eq!(off.status, "200 OK");
            let early = |_: &Path, _: bool, _: u64| Err(std::io::Error::other("the disk is full"));
            let refused = switch.turn_with(true, 4, false, early);
            assert_eq!(refused.status, "409 Conflict");
            assert_eq!(refused.body["error"], "LIST ME was not turned on: its switch could not be saved (the disk is full)");
            assert!(!switch.on() && !ListMe::read(net, path.clone(), true).on(), "{net:?}: off now and at the next start");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_turn_is_saved_for_its_network_alone_and_holds_at_once() {
        let dir = temp_dir("turn");
        // One data folder, both networks' files where `ChiaNet::path` puts them.
        let file = |net: ChiaNet| dir.join(net.path(LISTING_FILE));
        std::fs::create_dir_all(file(ChiaNet::Mainnet).parent().unwrap()).unwrap();
        let main = ListMe::read(ChiaNet::Mainnet, file(ChiaNet::Mainnet), true);
        let test = ListMe::read(ChiaNet::Testnet11, file(ChiaNet::Testnet11), true);
        assert!(!main.on() && main.listed().is_none(), "mainnet starts off");
        assert!(test.on() && test.listed().is_some(), "testnet11 starts on");
        assert!(!file(ChiaNet::Mainnet).exists() && !file(ChiaNet::Testnet11).exists(), "reading a switch writes nothing");

        let turned = main.turn(true, 100, false);
        assert_eq!(turned.status, "200 OK");
        assert_eq!(turned.body, serde_json::json!({ "ok": true, "listing": { "on": true, "chosen": true } }));
        assert_eq!(turned.line.as_deref(), Some(turned_line(ChiaNet::Mainnet, true, false).as_str()));
        assert!(!turned.failed);
        assert!(main.on() && main.listed().is_some(), "on from this call");
        assert_eq!(saved_of(&file(ChiaNet::Mainnet)), Saved::On);
        assert!(!file(ChiaNet::Testnet11).exists(), "mainnet's turn wrote nothing for testnet11");
        // The next start reads it.
        assert!(ListMe::read(ChiaNet::Mainnet, file(ChiaNet::Mainnet), true).on());

        let turned = test.turn(false, 200, false);
        assert_eq!(turned.body, serde_json::json!({ "ok": true, "listing": { "on": false, "chosen": true } }));
        assert_eq!(turned.line.as_deref(), Some(turned_line(ChiaNet::Testnet11, false, false).as_str()));
        assert!(!test.on() && test.listed().is_none(), "off from this call");
        assert!(!ListMe::read(ChiaNet::Testnet11, file(ChiaNet::Testnet11), true).on(), "and at the next start");
        assert!(main.on(), "testnet11's turn left mainnet's switch alone");

        // Turned again to what it is: saved again, still a turn that was taken.
        assert_eq!(main.turn(true, 300, false).status, "200 OK");
        assert_eq!(main.turn(false, 400, false).status, "200 OK");
        assert!(!main.on());
        assert_eq!(saved_of(&file(ChiaNet::Mainnet)), Saved::Off);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn while_chia_is_off_an_on_is_refused_and_an_off_is_taken() {
        let dir = temp_dir("chia-off");
        for net in ChiaNet::ALL {
            let path = dir.join(format!("{}-{LISTING_FILE}", net.id()));
            let switch = ListMe::read(net, path.clone(), true);
            let refused = switch.turn(true, 1, true);
            assert_eq!(refused.status, "409 Conflict", "{net:?}");
            assert_eq!(refused.body["error"], CHIA_OFF_WORDS);
            assert_eq!(refused.body["listing"]["on"], net.is_test(), "{net:?}: the switch is as it was");
            assert_eq!(refused.line, None);
            assert!(!path.exists(), "{net:?}: a refused on saves nothing");
            let taken = switch.turn(false, 2, true);
            assert_eq!(taken.status, "200 OK", "{net:?}");
            assert!(!switch.on());
            assert_eq!(saved_of(&path), Saved::Off, "{net:?}: the off holds at a start with Chia back on");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_on_that_cannot_be_saved_is_not_on_and_an_off_that_cannot_be_saved_still_holds() {
        let dir = temp_dir("unsaved");
        // A folder where the file goes: no save can replace it.
        for net in ChiaNet::ALL {
            let path = dir.join(format!("{}-{LISTING_FILE}", net.id()));
            std::fs::create_dir(&path).unwrap();
            let switch = ListMe::read(net, path.clone(), true);
            assert!(!switch.on(), "{net:?}: a folder there counts as off");
            assert_eq!(switch.view(), ListingView { on: false, chosen: false, held: false, damaged: true, dish: false });
            let on = switch.turn(true, 1, false);
            assert_eq!(on.status, "409 Conflict");
            assert!(on.body["error"].as_str().unwrap().starts_with("LIST ME was not turned on: its switch could not be saved ("), "{}", on.body);
            assert!(on.failed && on.line.as_deref().unwrap().contains("so it was not turned on"));
            assert!(!switch.on() && switch.listed().is_none(), "{net:?}: not on");
            assert_eq!(on.body["listing"], serde_json::json!({ "on": false, "chosen": false, "damaged": true }));
        }
        // An off over a switch that is on, whose save fails: off for the run.
        for net in ChiaNet::ALL {
            let home = dir.join(format!("{}-gone", net.id()));
            std::fs::create_dir(&home).unwrap();
            let path = home.join(LISTING_FILE);
            save(&path, true, 1).unwrap();
            let switch = ListMe::read(net, path.clone(), true);
            assert!(switch.on());
            // The file goes and a folder takes its place before the turn.
            std::fs::remove_file(&path).unwrap();
            std::fs::create_dir(&path).unwrap();
            let off = switch.turn(false, 2, false);
            assert_eq!(off.status, "409 Conflict");
            assert!(off.failed);
            let error = off.body["error"].as_str().unwrap();
            assert!(error.starts_with("LIST ME is off until your station node stops, but its switch could not be saved ("), "{error}");
            assert!(error.ends_with("at the node's next start it reads off"), "{error}: a folder reads as off");
            assert!(!switch.on() && switch.listed().is_none(), "{net:?}: off from this call all the same");
            assert_eq!(off.body["listing"], serde_json::json!({ "on": false, "chosen": true }));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_off_that_cannot_be_saved_says_when_the_next_start_reads_on_again() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("readonly");
        // testnet11 with no file reads on; mainnet with a saved on reads on.
        let cases = [(ChiaNet::Testnet11, false), (ChiaNet::Mainnet, true)];
        for (net, saved_on) in cases {
            let home = dir.join(net.id());
            std::fs::create_dir(&home).unwrap();
            let path = home.join(LISTING_FILE);
            if saved_on {
                save(&path, true, 1).unwrap();
            }
            let switch = ListMe::read(net, path.clone(), true);
            assert!(switch.on(), "{net:?}");
            // The folder takes no new file: the save's temporary cannot be made.
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o500)).unwrap();
            let writable = std::fs::write(home.join("probe"), b"x").is_ok();
            let off = switch.turn(false, 2, false);
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700)).unwrap();
            if writable {
                // Run as a user the mode does not hold back (root): the save
                // went through, and there is nothing to say about the next start.
                let _ = std::fs::remove_file(home.join("probe"));
                assert_eq!(off.status, "200 OK", "{net:?}");
                continue;
            }
            assert_eq!(off.status, "409 Conflict", "{net:?}");
            let error = off.body["error"].as_str().unwrap();
            assert!(error.ends_with("at the node's next start it reads on again"), "{net:?}: {error}");
            assert!(!switch.on(), "{net:?}: off for the rest of this run");
            assert!(ListMe::read(net, path.clone(), true).on(), "{net:?}: and on again at the next start, as it said");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_variable_holds_the_listing_beside_the_switch_and_never_turns_it() {
        let dir = temp_dir("held");
        for net in ChiaNet::ALL {
            let path = dir.join(format!("{}-{LISTING_FILE}", net.id()));
            let switch = ListMe::read(net, path, false);
            assert_eq!(switch.on(), net.is_test(), "{net:?}: the switch is the file's and the default's");
            assert!(switch.view().held);
            let turned = switch.turn(true, 1, false);
            assert_eq!(turned.body, serde_json::json!({ "ok": true, "listing": { "on": true, "chosen": true, "held": true } }));
            assert_eq!(turned.line.as_deref(), Some(turned_line(net, true, true).as_str()));
            assert!(turned.line.unwrap().contains("SSF_CHIA_FINDABLE=0 in its environment still holds its listing off"));
            assert!(switch.listed().is_some(), "{net:?}: the knocks follow the switch");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_startup_line_says_what_the_station_writes_and_nothing_new_for_testnet11_as_it_was() {
        assert_eq!(start_line(ChiaNet::Testnet11, &Saved::Unset), None);
        assert_eq!(
            start_line(ChiaNet::Mainnet, &Saved::Unset).as_deref(),
            Some("📖 LIST ME: off for Chia mainnet, where it starts off. This station writes no Phone Book listing and no knock there until its player turns LIST ME on in the SpacePhone's Network settings.")
        );
        for net in ChiaNet::ALL {
            let name = net.name();
            assert_eq!(
                start_line(net, &Saved::On),
                Some(format!("📖 LIST ME: on for {name}. With its SSF wallet on, this station writes its Phone Book listing and its knocks there, until LIST ME is turned off in the SpacePhone's Network settings."))
            );
            assert_eq!(
                start_line(net, &Saved::Off),
                Some(format!("📖 LIST ME: off for {name}. This station writes no Phone Book listing and no knock there until its player turns LIST ME on in the SpacePhone's Network settings."))
            );
            let damaged = start_line(net, &Saved::Damaged("chia_listing.json is not a LIST ME switch the node can read (EOF)".into())).unwrap();
            assert!(damaged.starts_with("⚠️  LIST ME: chia_listing.json is not a LIST ME switch the node can read (EOF). A switch that cannot be read counts as off"), "{damaged}");
            assert!(damaged.contains(name), "{damaged}");
        }
    }

    #[test]
    fn the_turn_lines_promise_a_write_only_with_the_wallet_on() {
        for net in ChiaNet::ALL {
            let on = turned_line(net, true, false);
            assert!(on.contains(net.name()) && on.contains("With its SSF wallet on"), "{on}");
            assert!(on.contains("its Phone Book listing and its knocks"), "{on}");
            let held = turned_line(net, true, true);
            assert!(held.contains("writes its knocks there") && !held.contains("its Phone Book listing and"), "{held}");
            for line in [turned_line(net, false, false), turned_line(net, false, true)] {
                assert!(line.contains("writes no Phone Book listing and no knock there from now on"), "{line}");
                assert!(line.ends_with("What it wrote before stays on the chain."), "{line}");
            }
        }
    }
}
