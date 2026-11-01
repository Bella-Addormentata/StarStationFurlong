//! 🏦 The SSF wallet switch: the SpacePhone Bank turns the node's Chia wallet
//! on (#335 stage 1; amends #231 D3).
//!
//! Until this switch, a node held a Chia wallet only when it was started with
//! `SSF_CHIA_LANE=1` in its environment, which a player of the desktop app
//! never sees. The switch moved into the game: the Bank's TURN ON (CREATE the
//! first time, when no seed is on disk) loads the wallet, minting its seed
//! once, and the node remembers the choice in [`SWITCH_FILE`] beside the seed,
//! so it is back on at the next start.
//!
//! The environment still decides first. `SSF_CHIA_LANE=1` holds the wallet on
//! for that run (and is not remembered); any other non-empty value holds it
//! off, and the Bank cannot override that (`SSF_CHIA_LANE=0` is the
//! operator's hard off switch); unset or empty leaves it to the Bank's switch.
//! A node built without `chia-publish` holds no wallet whatever is set.
//!
//! On is hot: the node loads the wallet, restores its lease and starts the
//! publisher without a restart. Off is cold: it is remembered and takes effect
//! at the next start, because the publisher cannot stop in the middle of a
//! run, and spends it already sent are settled by the lease either way.
//!
//! Everything a decision rests on is a pure function here, so the startup
//! block, the loopback route and the fingerprint agree and are tested without
//! touching the process environment.

use std::ffi::OsStr;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The Bank's switch, remembered beside the seed in the node's data folder
/// (its CWD, the same bare-path convention as `chia_identity.seed`).
pub const SWITCH_FILE: &str = "chia_wallet.json";

/// The wallet's seed (chia_wallet.rs mints it), whose presence the Bank shows
/// as TURN ON rather than CREATE: that wallet, and its address, come back.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const SEED_FILE: &str = "chia_identity.seed";

/// The wallet lease's parking (chia_publish.rs), restored when the wallet
/// loads, before anything can spend from it.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const LEASE_FILE: &str = "wallet_lease.json";

/// What the node's environment says about the wallet, read once.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvSwitch {
    /// `SSF_CHIA_LANE` unset or empty: the Bank's switch decides.
    Unset,
    /// `SSF_CHIA_LANE=1`: on for this run, whatever the switch says.
    On,
    /// Any other value: off, and the Bank cannot turn it on.
    Off,
}

/// Classify a raw `SSF_CHIA_LANE` value. Exactly `1` is on, as it always was;
/// anything else that is set (`0`, `true`, a stray space) is off, so nothing
/// that kept a node off before turns it on now.
pub fn env_switch_of(raw: Option<&OsStr>) -> EnvSwitch {
    match raw {
        None => EnvSwitch::Unset,
        Some(v) if v.is_empty() => EnvSwitch::Unset,
        Some(v) if v == OsStr::new("1") => EnvSwitch::On,
        Some(_) => EnvSwitch::Off,
    }
}

/// The process's `SSF_CHIA_LANE`, read once: the startup line, the startup
/// block, the route and the fingerprint all see the same value.
pub fn env_switch() -> EnvSwitch {
    static ENV: std::sync::OnceLock<EnvSwitch> = std::sync::OnceLock::new();
    *ENV.get_or_init(|| env_switch_of(std::env::var_os("SSF_CHIA_LANE").as_deref()))
}

/// Whether the wallet loads when the node starts.
pub fn starts_on(built: bool, env: EnvSwitch, remembered: bool) -> bool {
    built
        && match env {
            EnvSwitch::On => true,
            EnvSwitch::Off => false,
            EnvSwitch::Unset => remembered,
        }
}

/// A build without the `chia-publish` feature.
pub const UNBUILT_WORDS: &str = "this build of the node only reads the chain, so it cannot hold a wallet";
/// `SSF_CHIA_LANE` holds the wallet off.
pub const OFF_WORDS: &str =
    "the SSF wallet is switched off on this node by SSF_CHIA_LANE in its environment; the Bank cannot turn it on";
/// `SSF_CHIA_LANE=1` holds the wallet on.
pub const HELD_WORDS: &str =
    "SSF_CHIA_LANE=1 in the node's environment holds the SSF wallet on; start the node without it to let the Bank turn it off";

/// Why a turn the Bank asked for is refused, or `None` when it may go ahead.
/// Turning off while the environment holds it off only clears the switch,
/// and turning on while it is held on only remembers it: both are allowed.
pub fn turn_refusal(built: bool, env: EnvSwitch, on: bool) -> Option<&'static str> {
    if !built {
        return Some(UNBUILT_WORDS);
    }
    match (env, on) {
        (EnvSwitch::Off, true) => Some(OFF_WORDS),
        (EnvSwitch::On, false) => Some(HELD_WORDS),
        _ => None,
    }
}

/// What the faucet dish says when the node holds no wallet, for `doing`
/// ("take or give", "take a mojo", "give"): where the switch is, or what
/// holds it off.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn no_wallet_words(env: EnvSwitch, doing: &str) -> String {
    match env {
        EnvSwitch::Off => format!(
            "this node's SSF wallet is switched off (SSF_CHIA_LANE in its environment), so it cannot {doing}"
        ),
        _ => format!("this node's SSF wallet is not on yet: turn it on in the SpacePhone's 🏦 BANK to {doing}"),
    }
}

/// The switch file's contents.
#[derive(Serialize, Deserialize, Debug, Default, Clone, PartialEq, Eq)]
pub struct SwitchFile {
    pub on: bool,
    /// When it was last turned, unix seconds (for the operator reading it).
    #[serde(default)]
    pub at: u64,
}

/// What the switch file says: `Ok(false)` when there is none (a node that was
/// never turned on), `Err` with the reason when it exists and cannot be read,
/// so the node starts with the wallet off and says why rather than guessing.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn remembered(path: &Path) -> Result<bool, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<SwitchFile>(&bytes)
            .map(|f| f.on)
            .map_err(|e| format!("{} is not a wallet switch the node can read ({e})", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{} cannot be read ({e})", path.display())),
    }
}

/// Remember the switch: written whole (a temporary file renamed over it),
/// owner-only, like every file beside the seed.
#[cfg(feature = "chia-publish")]
pub fn remember(path: &Path, on: bool, now: u64) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&SwitchFile { on, at: now }).map_err(std::io::Error::other)?;
    crate::chia_contact::write_private(path, &bytes)
}

/// What the switch holds after a save of `target` failed with `err`, and how
/// to say so: read back from the file (`reread`), because a failed save does
/// not show the old value is still there (the replace can land and the
/// directory sync after it fail). Unreadable, the memo keeps `previous` and
/// says it does not know.
pub fn after_failed_save(target: bool, err: &str, reread: Result<bool, String>, previous: bool) -> (bool, String) {
    match reread {
        Ok(now) if now == target => (
            now,
            format!(
                "the switch was written but not confirmed on disk ({err}), so the wallet should {} at the next start",
                if target { "come back on" } else { "stay off" }
            ),
        ),
        Ok(now) => (
            now,
            format!(
                "the switch could not be saved ({err}), so the wallet {} at the next start",
                if now { "comes back on" } else { "starts off" }
            ),
        ),
        Err(read) => (
            previous,
            format!("the switch could not be saved ({err}) or read back ({read}), so whether the wallet is on at the next start is not known"),
        ),
    }
}

/// The switch's state as the Bank reads it.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WalletState {
    /// The node was built without publishing.
    Unbuilt,
    /// `SSF_CHIA_LANE` holds it off.
    Off,
    /// Not on, and the Bank may turn it on.
    Ready,
    /// The wallet is loaded.
    On,
}

/// 🏦 The SSF wallet switch in the loopback fingerprint (`chia_wallet`), for
/// this machine's own Bank app: which state, and the facts its words need.
/// Always compiled, like the fingerprint that carries it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct WalletSwitch {
    pub state: WalletState,
    /// Ready: a seed from an earlier run is on disk, so turning on brings
    /// back that wallet and its address rather than minting a new one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub seed: bool,
    /// On: it is back on at the node's next start (the switch is remembered,
    /// or `SSF_CHIA_LANE=1` holds it on).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stays: bool,
    /// On: `SSF_CHIA_LANE=1` holds it on, so the Bank cannot turn it off.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
    /// Why the last turn failed, in the node's words (Ready or On only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The node's memory of the switch between turns: whether the file says on,
/// and why the last turn (or the load at startup) failed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwitchMemo {
    pub remembered: bool,
    pub error: Option<String>,
}

/// The fingerprint's view, from the facts the node holds.
pub fn view(built: bool, env: EnvSwitch, loaded: bool, memo: &SwitchMemo, seed_on_disk: bool) -> WalletSwitch {
    let state = if !built {
        WalletState::Unbuilt
    } else if loaded {
        WalletState::On
    } else if env == EnvSwitch::Off {
        WalletState::Off
    } else {
        WalletState::Ready
    };
    WalletSwitch {
        state,
        seed: state == WalletState::Ready && seed_on_disk,
        stays: state == WalletState::On && (env == EnvSwitch::On || memo.remembered),
        held: state == WalletState::On && env == EnvSwitch::On,
        error: matches!(state, WalletState::Ready | WalletState::On).then(|| memo.error.clone()).flatten(),
    }
}

/// The route's query: `on=1` turns the wallet on, `on=0` off, nothing else.
pub fn turn_asked(target: &str) -> Option<bool> {
    let (path, query) = target.split_once('?')?;
    if path != "/api/chia/wallet" {
        return None;
    }
    match query {
        "on=1" => Some(true),
        "on=0" => Some(false),
        _ => None,
    }
}

/// Whether a request to turn the wallet comes from this machine's own game
/// page. Its Origin must be a loopback page or the desktop app's WebView,
/// never a web origin `SSF_ALLOWED_ORIGINS` lets read the API, and never
/// missing (a local process may read the fingerprint, but turning a wallet on
/// is the player's tap). Its Host must be a loopback name on the API's own
/// port: a page that re-bound its own domain to 127.0.0.1 sends that domain.
pub fn local_page(origin: Option<&str>, host: Option<&str>, port: u16) -> bool {
    let (Some(origin), Some(host)) = (origin, host) else {
        return false;
    };
    let origin = origin.trim();
    let page_ok = if origin.eq_ignore_ascii_case("tauri://localhost") {
        true
    } else {
        // Browsers send the scheme in lower case; read it case-blind anyway.
        let after = |scheme: &str| {
            origin
                .get(..scheme.len())
                .filter(|p| p.eq_ignore_ascii_case(scheme))
                .map(|_| &origin[scheme.len()..])
        };
        let rest = after("http://").or_else(|| after("https://")).unwrap_or("");
        // An Origin is scheme://host[:port], with no path. `tauri.localhost`
        // is the desktop app's page only on Windows, where WebView2 serves it
        // with no port; elsewhere the app is `tauri://localhost`, and a
        // browser that sends `tauri.localhost` to DNS could be answered with
        // any site, so the name is not taken there.
        match loopback_host_port(rest) {
            Some((name, port)) => {
                (cfg!(windows) && port.is_none() && name.eq_ignore_ascii_case("tauri.localhost")) || is_loopback_name(name)
            }
            None => false,
        }
    };
    let host_ok = match loopback_host_port(host.trim()) {
        Some((name, Some(p))) => is_loopback_name(name) && p == port,
        _ => false,
    };
    page_ok && host_ok
}

fn is_loopback_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("localhost") || name == "127.0.0.1" || name == "::1"
}

/// `name[:port]` or `[v6][:port]`, refusing anything with a path, user info or
/// a port that is not a number.
fn loopback_host_port(s: &str) -> Option<(&str, Option<u16>)> {
    if s.is_empty() || s.contains(['/', '@', '?', '#', ' ']) {
        return None;
    }
    let (name, port) = if let Some(v6) = s.strip_prefix('[') {
        let (name, after) = v6.split_once(']')?;
        match after {
            "" => (name, None),
            p => (name, Some(p.strip_prefix(':')?)),
        }
    } else {
        match s.split_once(':') {
            Some((name, p)) => (name, Some(p)),
            None => (s, None),
        }
    };
    let port = match port {
        Some(p) => Some(p.parse::<u16>().ok()?),
        None => None,
    };
    Some((name, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_environment_classifies_as_it_did_and_unset_leaves_it_to_the_bank() {
        assert_eq!(env_switch_of(None), EnvSwitch::Unset);
        assert_eq!(env_switch_of(Some(OsStr::new(""))), EnvSwitch::Unset);
        assert_eq!(env_switch_of(Some(OsStr::new("1"))), EnvSwitch::On);
        for off in ["0", "true", "yes", " 1", "1 ", "on", "2"] {
            assert_eq!(env_switch_of(Some(OsStr::new(off))), EnvSwitch::Off, "{off:?} kept a node off before, and still does");
        }
    }

    #[test]
    fn the_wallet_starts_with_the_node_when_the_environment_or_the_switch_says_so() {
        use EnvSwitch::*;
        assert!(starts_on(true, On, false), "SSF_CHIA_LANE=1 needs no switch");
        assert!(starts_on(true, Unset, true), "the Bank's switch, remembered");
        assert!(!starts_on(true, Unset, false), "never turned on");
        assert!(!starts_on(true, Off, true), "SSF_CHIA_LANE=0 overrides the switch");
        assert!(!starts_on(false, On, true), "a read-only build never loads a wallet");
    }

    #[test]
    fn a_turn_is_refused_only_against_the_build_or_the_environment() {
        use EnvSwitch::*;
        assert_eq!(turn_refusal(true, Unset, true), None);
        assert_eq!(turn_refusal(true, Unset, false), None);
        assert_eq!(turn_refusal(true, Off, true), Some(OFF_WORDS));
        assert_eq!(turn_refusal(true, Off, false), None, "clearing the switch under a hard off is harmless");
        assert_eq!(turn_refusal(true, On, true), None, "remembering while held on is harmless");
        assert_eq!(turn_refusal(true, On, false), Some(HELD_WORDS));
        assert_eq!(turn_refusal(false, Unset, true), Some(UNBUILT_WORDS));
        assert_eq!(turn_refusal(false, Unset, false), Some(UNBUILT_WORDS));
    }

    #[test]
    fn the_dish_points_at_the_bank_unless_the_environment_holds_the_wallet_off() {
        let ready = no_wallet_words(EnvSwitch::Unset, "take or give");
        assert!(ready.contains("🏦 BANK") && ready.ends_with("to take or give"), "{ready}");
        assert!(!ready.contains("SSF_CHIA_LANE"), "a player is not told about environment variables: {ready}");
        let off = no_wallet_words(EnvSwitch::Off, "give");
        assert!(off.contains("SSF_CHIA_LANE") && off.ends_with("cannot give"), "{off}");
        assert!(!off.contains("BANK"), "the Bank cannot help under a hard off: {off}");
    }

    #[test]
    fn the_switch_file_is_remembered_and_an_unreadable_one_is_reported_not_guessed() {
        let dir = std::env::temp_dir().join(format!("ssf-wallet-switch-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SWITCH_FILE);
        assert_eq!(remembered(&path), Ok(false), "no file: never turned on");
        std::fs::write(&path, br#"{"on":true,"at":1730000000}"#).unwrap();
        assert_eq!(remembered(&path), Ok(true));
        std::fs::write(&path, br#"{"on":false}"#).unwrap();
        assert_eq!(remembered(&path), Ok(false), "`at` is optional");
        std::fs::write(&path, b"{\"on\":tr").unwrap();
        let err = remembered(&path).unwrap_err();
        assert!(err.contains(SWITCH_FILE), "{err}");
        #[cfg(feature = "chia-publish")]
        {
            remember(&path, true, 7).unwrap();
            assert_eq!(remembered(&path), Ok(true), "a torn file is replaced whole");
            remember(&path, false, 8).unwrap();
            assert_eq!(remembered(&path), Ok(false));
            let left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert_eq!(left, vec![std::ffi::OsString::from(SWITCH_FILE)], "no temporary file left behind");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_save_reports_what_the_file_holds_not_what_was_asked() {
        let (on, why) = after_failed_save(true, "dir sync failed", Ok(true), false);
        assert!(on && why.contains("not confirmed") && why.contains("come back on"), "{why}");
        let (on, why) = after_failed_save(true, "disk full", Ok(false), false);
        assert!(!on && why.contains("starts off"), "{why}");
        let (on, why) = after_failed_save(false, "disk full", Ok(true), true);
        assert!(on && why.contains("comes back on"), "an off that did not land leaves it on: {why}");
        let (on, why) = after_failed_save(false, "dir sync failed", Ok(false), true);
        assert!(!on && why.contains("stay off"), "{why}");
        let (on, why) = after_failed_save(true, "disk full", Err("unreadable".into()), true);
        assert!(on && why.contains("not known"), "unreadable keeps the memo: {why}");
        assert!(!after_failed_save(true, "x", Err("y".into()), false).0);
    }

    #[test]
    fn the_bank_reads_one_state_and_only_the_facts_that_state_needs() {
        use EnvSwitch::*;
        let memo = |remembered, error: Option<&str>| SwitchMemo { remembered, error: error.map(str::to_string) };
        let v = view(false, On, false, &memo(true, Some("x")), true);
        assert_eq!(v, WalletSwitch { state: WalletState::Unbuilt, seed: false, stays: false, held: false, error: None });
        let v = view(true, Off, false, &memo(true, Some("x")), true);
        assert_eq!(v, WalletSwitch { state: WalletState::Off, seed: false, stays: false, held: false, error: None });
        let v = view(true, Unset, false, &memo(false, None), true);
        assert_eq!(v, WalletSwitch { state: WalletState::Ready, seed: true, stays: false, held: false, error: None });
        let v = view(true, Unset, false, &memo(false, Some("disk full")), false);
        assert_eq!(v.error.as_deref(), Some("disk full"), "a failed turn says why");
        let v = view(true, Unset, true, &memo(true, None), true);
        assert_eq!(v, WalletSwitch { state: WalletState::On, seed: false, stays: true, held: false, error: None });
        let v = view(true, Unset, true, &memo(false, None), true);
        assert!(!v.stays, "turned off in the Bank: on until the node stops");
        let v = view(true, On, true, &memo(false, None), true);
        assert!(v.stays && v.held, "held on by SSF_CHIA_LANE=1");

        let json = serde_json::to_string(&view(true, Unset, false, &memo(false, None), false)).unwrap();
        assert_eq!(json, r#"{"state":"ready"}"#, "flags ride only when set");
        let json = serde_json::to_string(&view(true, On, true, &memo(false, Some("e")), false)).unwrap();
        assert_eq!(json, r#"{"state":"on","stays":true,"held":true,"error":"e"}"#);
        let back: WalletSwitch = serde_json::from_str(r#"{"state":"unbuilt"}"#).unwrap();
        assert_eq!(back.state, WalletState::Unbuilt);
    }

    #[test]
    fn the_route_takes_on_or_off_and_nothing_else() {
        assert_eq!(turn_asked("/api/chia/wallet?on=1"), Some(true));
        assert_eq!(turn_asked("/api/chia/wallet?on=0"), Some(false));
        for bad in ["/api/chia/wallet", "/api/chia/wallet?", "/api/chia/wallet?on=true", "/api/chia/wallet?on=1&x=2", "/api/chia/walletx?on=1", "/api/chia/wallet/?on=1"] {
            assert_eq!(turn_asked(bad), None, "{bad}");
        }
    }

    #[test]
    fn only_this_machines_own_page_on_a_loopback_host_may_turn_the_wallet() {
        let ok = |o: &str, h: &str| local_page(Some(o), Some(h), 8080);
        assert!(ok("http://localhost:5173", "127.0.0.1:8080"), "the dev server");
        assert!(ok("http://127.0.0.1:4173", "127.0.0.1:8080"));
        assert!(ok("http://[::1]:5173", "[::1]:8080"));
        assert!(ok("tauri://localhost", "127.0.0.1:8080"), "the desktop app on macOS and Linux");
        // The desktop app on Windows, and only there: elsewhere the name is a
        // DNS answer, not the app.
        assert_eq!(ok("http://tauri.localhost", "127.0.0.1:8080"), cfg!(windows), "the desktop app on Windows");
        assert_eq!(ok("https://tauri.localhost", "localhost:8080"), cfg!(windows));
        assert!(!ok("http://tauri.localhost:8000", "127.0.0.1:8080"), "WebView2 serves the app with no port");
        assert!(ok("HTTP://LOCALHOST:5173", "LocalHost:8080"), "names are case-blind");

        assert!(!local_page(None, Some("127.0.0.1:8080"), 8080), "no Origin: a local process, not the player's tap");
        assert!(!local_page(Some("http://localhost:5173"), None, 8080), "no Host");
        assert!(!ok("https://example.com", "127.0.0.1:8080"), "a website, even one SSF_ALLOWED_ORIGINS lets read the API");
        assert!(!ok("http://localhost.example.com", "127.0.0.1:8080"));
        assert!(!ok("http://127.0.0.1.example.com:80", "127.0.0.1:8080"));
        assert!(!ok("null", "127.0.0.1:8080"), "a sandboxed or file page");
        assert!(!ok("http://localhost:5173/path", "127.0.0.1:8080"));
        assert!(!ok("http://user@localhost:5173", "127.0.0.1:8080"));
        assert!(!ok("http://localhost:5173", "rebound.example.com:8080"), "a page that re-bound its own name to 127.0.0.1");
        assert!(!ok("http://localhost:5173", "127.0.0.1:8081"), "another port's API");
        assert!(!ok("http://localhost:5173", "127.0.0.1"), "a Host without the port");
        assert!(!ok("http://localhost:5173", "127.0.0.1:80x"));
        assert!(!ok("http://localhost:5173", "[::1]"));
        assert!(local_page(Some("http://localhost:5173"), Some("127.0.0.1:8081"), 8081), "the API on its second port");
    }
}
