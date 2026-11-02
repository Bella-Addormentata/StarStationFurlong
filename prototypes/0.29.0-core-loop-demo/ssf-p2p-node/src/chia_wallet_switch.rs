//! 🏦 The SSF wallet switch: the SpacePhone Bank turns the node's Chia wallet
//! on (#335 stage 1; amends #231 D3).
//!
//! Until this switch, a node held a Chia wallet only when it was started with
//! `SSF_CHIA_LANE=1` in its environment, which a player of the desktop app
//! never sees. The switch moved into the game: the Bank's TURN ON (CREATE the
//! first time, when no identity is on disk) loads the wallet, minting its
//! 24-word identity ([`IDENTITY_FILE`]) once, and the node remembers the
//! choice in [`SWITCH_FILE`] beside it, so it is back on at the next start.
//! A raw seed from before the words ([`LEGACY_SEED_FILE`]) is retired when
//! the wallet turns on, and a new wallet made from 24 words takes its place.
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
//! 🏦 BACK UP: while the wallet is on and its words are not marked saved, the
//! Bank shows the 24 words (`POST /api/chia/words`) and records the player's
//! "I saved them" ([`SAVED_FILE`], `POST /api/chia/words/saved?key=`). Only
//! the desktop app's own page may ask ([`app_page`]), or a browser page whose
//! exact origin the operator lists in `SSF_BANK_DEV_PAGES` ([`dev_pages`]).
//! Once saved, the page never shows them again.
//!
//! 🔒 Once saved, the node also locks the identity file with this computer's
//! store where it has one (chia_at_rest.rs: Windows DPAPI), and the
//! fingerprint says how the file keeps its key ([`AtRest`]).
//!
//! Everything a decision rests on is a pure function here, so the startup
//! block, the loopback route and the fingerprint agree and are tested without
//! touching the process environment.

use std::ffi::OsStr;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The Bank's switch, remembered beside the wallet's identity in the node's
/// data folder (its CWD, the same bare-path convention as `iroh_node_id.key`).
pub const SWITCH_FILE: &str = "chia_wallet.json";

/// The wallet's identity: 32 bytes of BIP39 entropy, its 24 words
/// (chia_wallet.rs mints it once; the only rewrite is the lock once its
/// words are saved, chia_at_rest.rs, which keeps the same wallet). Its presence the
/// Bank shows as TURN ON rather than CREATE: that wallet, and its address,
/// come back.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const IDENTITY_FILE: &str = "chia_identity.json";

/// A raw 32-byte seed from before the 24 words. Nothing writes it any more:
/// turning the wallet on archives it (`chia_identity.seed.retired-<unix>`)
/// and makes a new wallet from 24 words.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const LEGACY_SEED_FILE: &str = "chia_identity.seed";

/// The player's "I saved the 24 words", for one key fingerprint (never
/// anything secret). Deleting it brings the Bank's BACK UP back.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const SAVED_FILE: &str = "chia_words_saved.json";

/// The wallet lease's parking (chia_publish.rs), restored when the wallet
/// loads, before anything can spend from it.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const LEASE_FILE: &str = "wallet_lease.json";

/// 🔒 How the identity file keeps its key on disk (its `protect`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AtRest {
    /// In the clear (owner-only on Unix).
    #[default]
    None,
    /// Locked by Windows DPAPI to this Windows account on this PC.
    Dpapi,
}

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
/// owner-only, like every file beside the identity.
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

/// The route's answer to a turn: its status line and body, with the switch's
/// view after the turn as `wallet` (the Bank reads `ok` and `error`; the view
/// rides along for anything that wants the state without a second request).
pub fn turn_answer(turned: Result<(), String>, wallet: &WalletSwitch) -> (&'static str, serde_json::Value) {
    match turned {
        Ok(()) => ("200 OK", serde_json::json!({ "ok": true, "wallet": wallet })),
        Err(error) => ("409 Conflict", serde_json::json!({ "ok": false, "error": error, "wallet": wallet })),
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
/// Never carries the words, the entropy, the key fingerprint or an old
/// address: only flags.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct WalletSwitch {
    pub state: WalletState,
    /// Ready: the 24-word identity from an earlier run is on disk, so turning
    /// on brings back that wallet and its address rather than minting a new one.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub seed: bool,
    /// Ready, with no identity: a raw seed from before the 24 words is on
    /// disk, and turning on retires it for a new wallet at a new address.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub legacy: bool,
    /// On: it is back on at the node's next start (the switch is remembered,
    /// or `SSF_CHIA_LANE=1` holds it on).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stays: bool,
    /// On: `SSF_CHIA_LANE=1` holds it on, so the Bank cannot turn it off.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub held: bool,
    /// On: the wallet is made from 24 words the node keeps, so the Bank can
    /// back them up. Ready: turning on makes (or loads) a wallet from 24
    /// words, so CREATE can promise them. The capability marker: an older
    /// node never sends it, and its CREATE makes a raw seed.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mnemonic: bool,
    /// On, with `mnemonic`: the player marked these words saved, so the Bank
    /// stops asking and never shows them again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub backed_up: bool,
    /// On: this run's load retired a raw-seed wallet, so the address is new.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub reminted: bool,
    /// On, with `mnemonic`: how the wallet's file keeps its key on disk.
    /// An older node never sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_rest: Option<AtRest>,
    /// On, with the file in the clear: the lock it gets once its words are
    /// saved (the next start retries one that did not land). None when this
    /// computer has no store or `SSF_WALLET_AT_REST=none`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_rest_next: Option<AtRest>,
    /// On: this run locked the file, so copies of the folder made before
    /// still hold the key in the clear.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rewrapped: bool,
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

/// What the node knows of the wallet's files and key for the fingerprint:
/// the files on disk while it is not loaded, the hub's [`WalletMeta`] of the
/// loaded key while it is.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyFacts {
    /// `chia_identity.json` is on disk.
    pub identity_on_disk: bool,
    /// `chia_identity.seed` is on disk.
    pub legacy_on_disk: bool,
    /// The loaded wallet came from the 24-word identity.
    pub mnemonic: bool,
    /// The saved-flag file holds the loaded key's fingerprint.
    pub backed_up: bool,
    /// This run's load retired a raw seed.
    pub reminted: bool,
    /// How the loaded wallet's file keeps its key on disk.
    pub at_rest: AtRest,
    /// The lock a file in the clear gets once its words are saved.
    pub at_rest_next: Option<AtRest>,
    /// This run locked the loaded wallet's file.
    pub rewrapped: bool,
}

/// The fingerprint's view, from the facts the node holds.
pub fn view(built: bool, env: EnvSwitch, loaded: bool, memo: &SwitchMemo, facts: &KeyFacts) -> WalletSwitch {
    let state = if !built {
        WalletState::Unbuilt
    } else if loaded {
        WalletState::On
    } else if env == EnvSwitch::Off {
        WalletState::Off
    } else {
        WalletState::Ready
    };
    let on = state == WalletState::On;
    let ready = state == WalletState::Ready;
    WalletSwitch {
        state,
        seed: ready && facts.identity_on_disk,
        legacy: ready && !facts.identity_on_disk && facts.legacy_on_disk,
        stays: on && (env == EnvSwitch::On || memo.remembered),
        held: on && env == EnvSwitch::On,
        // Every wallet this build turns on comes from 24 words.
        mnemonic: ready || (on && facts.mnemonic),
        backed_up: on && facts.mnemonic && facts.backed_up,
        reminted: on && facts.reminted,
        at_rest: (on && facts.mnemonic).then_some(facts.at_rest),
        at_rest_next: (on && facts.mnemonic && facts.at_rest == AtRest::None).then_some(facts.at_rest_next).flatten(),
        rewrapped: on && facts.mnemonic && facts.rewrapped,
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

/// 🏦 BACK UP: the Bank's two words routes, both `POST` with no body and no
/// custom header (simple requests, no preflight), and deliberately outside
/// `/api/chia/wallet`, so the switch's route never answers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WordsAsk {
    /// `POST /api/chia/words`: show the 24 words of the loaded wallet.
    Reveal,
    /// `POST /api/chia/words/saved?key=<fingerprint>`: the player saved the
    /// words of that key.
    Saved(u32),
}

/// Whether a request target belongs to the words routes (and is answered by
/// them, with a 400 when it asks for nothing they know).
pub fn is_words_target(target: &str) -> bool {
    target == "/api/chia/words" || target.starts_with("/api/chia/words/") || target.starts_with("/api/chia/words?")
}

/// The words route's ask: the reveal with no query, or the saved mark with
/// exactly one `key`, decimal digits only, that fits a u32.
pub fn words_asked(target: &str) -> Option<WordsAsk> {
    if target == "/api/chia/words" {
        return Some(WordsAsk::Reveal);
    }
    let digits = target.strip_prefix("/api/chia/words/saved?key=")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok().map(WordsAsk::Saved)
}

/// The exact origins of browser pages the operator lets show the 24 words
/// (`SSF_BANK_DEV_PAGES`, comma-separated, such as `http://localhost:5173`
/// for `tauri dev` or vite). Unset, only the desktop app's page may.
pub fn dev_pages_of(raw: Option<&OsStr>) -> Vec<String> {
    raw.and_then(OsStr::to_str)
        .map(|s| {
            s.split(',')
                .map(|o| o.trim().trim_end_matches('/'))
                .filter(|o| !o.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// The process's `SSF_BANK_DEV_PAGES`, read once, like `SSF_CHIA_LANE`.
pub fn dev_pages() -> &'static [String] {
    static PAGES: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    PAGES.get_or_init(|| dev_pages_of(std::env::var_os("SSF_BANK_DEV_PAGES").as_deref()))
}

/// Whether a words request comes from the desktop app's own page: stricter
/// than [`local_page`] (whose Host and port rules it keeps), it takes only
/// `tauri://localhost`, `http(s)://tauri.localhost` with no port on Windows
/// (WebView2), or an origin listed exactly (case-blind) in `dev_pages`. A
/// loopback page on another port (another project's dev server, a notebook)
/// never reads the words unless the operator names it.
///
/// Known gaps, accepted for testnet and closed by a native reveal in the
/// desktop host before mainnet: another OS account on this computer shares
/// loopback and can send these headers, and a script in the game page itself
/// passes this check.
pub fn app_page(origin: Option<&str>, host: Option<&str>, port: u16, dev_pages: &[String]) -> bool {
    if !local_page(origin, host, port) {
        return false;
    }
    let Some(origin) = origin.map(str::trim) else {
        return false;
    };
    origin.eq_ignore_ascii_case("tauri://localhost")
        || (cfg!(windows)
            && (origin.eq_ignore_ascii_case("http://tauri.localhost") || origin.eq_ignore_ascii_case("https://tauri.localhost")))
        || dev_pages.iter().any(|d| d.eq_ignore_ascii_case(origin))
}

/// The head of every words-route answer: never cached, never sniffed, and
/// readable only by `allow_origin` (the origin [`app_page`] accepted, or for
/// its refusal the one the API grants), never a wider rule.
pub fn words_reply_head(status: &str, allow_origin: Option<&str>, len: usize) -> String {
    let cors = match allow_origin {
        Some(o) if !o.is_empty() && !o.bytes().any(|b| b.is_ascii_control()) => {
            format!("Access-Control-Allow-Origin: {o}\r\n")
        }
        _ => String::new(),
    };
    format!(
        "HTTP/1.1 {status}\r\n\
         Content-Type: application/json\r\n\
         Cache-Control: no-store\r\n\
         X-Content-Type-Options: nosniff\r\n\
         {cors}Vary: Origin\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\r\n"
    )
}

/// The words routes' refusals, in the Bank's words (a read-only build
/// answers every ask that passes the gate with [`UNBUILT_WORDS`]).
pub const BACKUP_PAGE_ONLY: &str = "only the Star Station app on this computer can show the 24 words \
     (a browser page needs its origin in SSF_BANK_DEV_PAGES in the node's environment)";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const BACKUP_TURNING: &str = "the wallet is turning; tap SHOW again in a moment";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const BACKUP_NOT_ON: &str = "the SSF wallet is not on, so there are no words to show";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const BACKUP_SAVED: &str = "these words were marked saved, so the Bank does not show them again";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const BACKUP_MISMATCH: &str = "the words on disk do not make the wallet in use, so they are not shown";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const BACKUP_KEY_CHANGED: &str = "the wallet changed since these words were shown; tap SHOW again";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const BACKUP_NOT_SHOWN: &str = "tap SHOW first: your node has not shown these words since it started";
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub const BACKUP_UNREADABLE: &str =
    "your node could not read its 24 words from chia_identity.json, so nothing is shown; the node's log says why";
pub const BACKUP_BAD_ASK: &str = "ask /api/chia/words or /api/chia/words/saved?key=<fingerprint>";

/// The saved flag's contents: a key fingerprint, nothing secret.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct SavedFile {
    /// The key fingerprint whose words the player marked saved.
    pub key: u32,
    /// When, unix seconds (for the operator reading it).
    #[serde(default)]
    pub at: u64,
}

/// Whether the player marked the words of `key` saved: `Ok(false)` when
/// there is no flag, or it names another key (a wallet made since), `Err`
/// with the reason when it exists and cannot be read, which the caller
/// counts as not saved and says so.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn saved_for(path: &Path, key: u32) -> Result<bool, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<SavedFile>(&bytes)
            .map(|f| f.key == key)
            .map_err(|e| format!("{} is not a saved flag the node can read ({e})", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{} cannot be read ({e})", path.display())),
    }
}

/// Remember that the words of `key` are saved: written whole, owner-only,
/// like the switch.
#[cfg(feature = "chia-publish")]
pub fn remember_saved(path: &Path, key: u32, now: u64) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(&SavedFile { key, at: now }).map_err(std::io::Error::other)?;
    crate::chia_contact::write_private(path, &bytes)
}

/// 🏦 What the hub keeps beside the loaded wallet key for the Bank (never
/// the words or the entropy): the fingerprint of its words, whether the
/// player marked them saved, whether this run's load retired a raw seed,
/// whether the Bank showed the words since the node started, how the file
/// keeps its key, and whether this run locked it.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WalletMeta {
    pub fingerprint: u32,
    pub backed_up: bool,
    pub reminted: bool,
    pub revealed: bool,
    pub at_rest: AtRest,
    pub rewrapped: bool,
}

/// 🏦 Where one words ask goes, decided against the loaded wallet: an answer
/// now, or the one piece of I/O the route does next. `K` is the loaded
/// wallet key, carried through untouched, so the reveal holds the key its
/// words are checked against.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WordsStep<K> {
    /// A 409 now ([`WordsRefusal::answer`]).
    Refuse(WordsRefusal),
    /// A saved mark already recorded: 200 with the switch's view
    /// ([`saved_answer`]), nothing written.
    SavedIdempotent,
    /// The reveal: read the identity file again, and show its words only
    /// when they make `wallet`, the loaded key, whose words' fingerprint is
    /// `fingerprint` ([`words_match`]).
    ReadFile { wallet: K, fingerprint: u32 },
    /// The saved mark: write the flag for `key`, the loaded key's
    /// fingerprint ([`after_failed_mark`] when the write fails).
    WriteFlag { key: u32 },
}

/// The words asks refused before any I/O, each a 409.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WordsRefusal {
    /// No wallet, and a turn holds the lock (it may be loading one).
    Turning,
    /// No wallet.
    NotOn,
    /// A reveal once the words are marked saved: the page never shows them
    /// again, and the answer says so with `saved: true`.
    AlreadySaved,
    /// A saved mark for another key than the loaded one.
    KeyChanged,
    /// A saved mark before this run showed the words.
    NotShown,
}

impl WordsRefusal {
    /// The refusal's status line and body.
    #[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
    pub fn answer(self) -> (&'static str, serde_json::Value) {
        let refuse = |error: &str| ("409 Conflict", serde_json::json!({ "ok": false, "error": error }));
        match self {
            WordsRefusal::Turning => refuse(BACKUP_TURNING),
            WordsRefusal::NotOn => refuse(BACKUP_NOT_ON),
            WordsRefusal::AlreadySaved => ("409 Conflict", serde_json::json!({ "ok": false, "saved": true, "error": BACKUP_SAVED })),
            WordsRefusal::KeyChanged => refuse(BACKUP_KEY_CHANGED),
            WordsRefusal::NotShown => refuse(BACKUP_NOT_SHOWN),
        }
    }
}

/// 🏦 Where a words ask goes. `loaded` is the wallet key and its meta, or
/// none while no wallet is loaded; `turning` (whether a turn holds the lock)
/// counts only then. A reveal is refused once the words are marked saved and
/// otherwise reads the file. A saved mark checks the key first (a wallet
/// made since the words were shown wins, even over a flag already saved),
/// then answers a mark already recorded as done, and writes the flag only
/// for words this run showed.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn words_step<K>(ask: WordsAsk, loaded: Option<(K, WalletMeta)>, turning: bool) -> WordsStep<K> {
    let Some((wallet, meta)) = loaded else {
        return WordsStep::Refuse(if turning { WordsRefusal::Turning } else { WordsRefusal::NotOn });
    };
    match ask {
        WordsAsk::Reveal if meta.backed_up => WordsStep::Refuse(WordsRefusal::AlreadySaved),
        WordsAsk::Reveal => WordsStep::ReadFile { wallet, fingerprint: meta.fingerprint },
        WordsAsk::Saved(key) if key != meta.fingerprint => WordsStep::Refuse(WordsRefusal::KeyChanged),
        WordsAsk::Saved(_) if meta.backed_up => WordsStep::SavedIdempotent,
        WordsAsk::Saved(_) if !meta.revealed => WordsStep::Refuse(WordsRefusal::NotShown),
        WordsAsk::Saved(key) => WordsStep::WriteFlag { key },
    }
}

/// 🏦 The reveal's last check, after the identity file was read, under the
/// lock of `meta` (the hub's, for the loaded key): a save that landed while
/// the file was read wins, so the words are not shown once they are marked
/// saved. Otherwise the run counts them as shown, which I SAVED needs.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn reveal_lands(meta: Option<&mut WalletMeta>, fingerprint: u32) -> Result<(), WordsRefusal> {
    match meta {
        None => Err(WordsRefusal::NotOn),
        Some(m) if m.fingerprint != fingerprint => Err(WordsRefusal::KeyChanged),
        Some(m) if m.backed_up => Err(WordsRefusal::AlreadySaved),
        Some(m) => {
            m.revealed = true;
            Ok(())
        }
    }
}

/// Whether the words read back for a reveal make the wallet in use: both
/// the fingerprint and the wallet public key they make (`read_*`) equal the
/// loaded key's (`loaded_*`). Anything else is not shown.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn words_match<P: PartialEq>(read_fingerprint: u32, read_wallet: &P, loaded_fingerprint: u32, loaded_wallet: &P) -> bool {
    read_fingerprint == loaded_fingerprint && read_wallet == loaded_wallet
}

/// The saved route's 200: `ok`, the switch's view after the mark (with
/// `backed_up`), and `note` when the mark was written but not confirmed.
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn saved_answer(wallet: &WalletSwitch, note: Option<&str>) -> (&'static str, serde_json::Value) {
    let mut body = serde_json::json!({ "ok": true, "wallet": wallet });
    if let Some(note) = note {
        body["note"] = note.into();
    }
    ("200 OK", body)
}

/// What a saved mark whose write failed comes to, read back from the flag
/// like [`after_failed_save`] for the switch: a failed save does not show the
/// flag is missing (the replace can land and the directory sync after it
/// fail).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FailedMark {
    /// The flag holds the key: the words count as saved (the route marks
    /// them backed up) and its 200 carries this note.
    Landed { note: String },
    /// It does not, or cannot be read back: a 500 with this error, and the
    /// words stay not saved, so the player can tap I SAVED again.
    Lost { error: String },
}

/// [`FailedMark`] of a flag write that failed with `err`, from the flag read
/// back for the same key (`reread`, [`saved_for`]).
#[cfg_attr(not(feature = "chia-publish"), allow(dead_code))]
pub fn after_failed_mark(err: &str, reread: Result<bool, String>) -> FailedMark {
    match reread {
        Ok(true) => FailedMark::Landed { note: format!("saved, but not confirmed on disk ({err})") },
        Ok(false) | Err(_) => FailedMark::Lost {
            error: format!("the Bank could not record it ({err}); your words are fine, tap I SAVED again"),
        },
    }
}

/// The origin a words answer is readable by: once [`app_page`] `passed`,
/// that exact origin and never a wider rule; for its 403, the origin only
/// when the API grants it (`granted`, every route's `cors_origin` rule), so
/// a dev page not yet in `SSF_BANK_DEV_PAGES` reads why.
pub fn words_allow_origin(passed: bool, origin: Option<&str>, granted: bool) -> Option<&str> {
    if passed {
        origin
    } else {
        origin.filter(|_| granted)
    }
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

    /// A switch in `state` with every flag clear.
    fn sw(state: WalletState) -> WalletSwitch {
        WalletSwitch {
            state,
            seed: false,
            legacy: false,
            stays: false,
            held: false,
            mnemonic: false,
            backed_up: false,
            reminted: false,
            at_rest: None,
            at_rest_next: None,
            rewrapped: false,
            error: None,
        }
    }

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
    fn a_turn_answers_ok_or_the_refusal_with_the_switch_as_an_object() {
        let on = WalletSwitch { stays: true, ..sw(WalletState::On) };
        let (status, body) = turn_answer(Ok(()), &on);
        assert_eq!(status, "200 OK");
        assert_eq!(body.to_string(), r#"{"ok":true,"wallet":{"state":"on","stays":true}}"#);
        let off = sw(WalletState::Off);
        let (status, body) = turn_answer(Err(OFF_WORDS.to_string()), &off);
        assert_eq!(status, "409 Conflict");
        assert_eq!(body["ok"], false);
        assert_eq!(body["error"], OFF_WORDS);
        assert_eq!(body["wallet"], serde_json::json!({ "state": "off" }));
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
        let identity = KeyFacts { identity_on_disk: true, ..KeyFacts::default() };
        let none = KeyFacts::default();
        let v = view(false, On, false, &memo(true, Some("x")), &identity);
        assert_eq!(v, sw(WalletState::Unbuilt));
        let v = view(true, Off, false, &memo(true, Some("x")), &identity);
        assert_eq!(v, sw(WalletState::Off));
        let v = view(true, Unset, false, &memo(false, None), &identity);
        assert_eq!(v, WalletSwitch { seed: true, mnemonic: true, ..sw(WalletState::Ready) });
        let v = view(true, Unset, false, &memo(false, Some("disk full")), &none);
        assert_eq!(v.error.as_deref(), Some("disk full"), "a failed turn says why");
        let v = view(true, Unset, true, &memo(true, None), &identity);
        assert_eq!(v, WalletSwitch { stays: true, ..sw(WalletState::On) });
        let v = view(true, Unset, true, &memo(false, None), &identity);
        assert!(!v.stays, "turned off in the Bank: on until the node stops");
        let v = view(true, On, true, &memo(false, None), &identity);
        assert!(v.stays && v.held, "held on by SSF_CHIA_LANE=1");

        let json = serde_json::to_string(&view(true, Unset, false, &memo(false, None), &none)).unwrap();
        assert_eq!(json, r#"{"state":"ready","mnemonic":true}"#, "flags ride only when set; Ready says TURN ON makes 24 words");
        let json = serde_json::to_string(&view(true, On, true, &memo(false, Some("e")), &none)).unwrap();
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

    /// 🏦 The 24-word flags: `seed` and `legacy` only while Ready, the
    /// words' own flags only while On, and `mnemonic` in both (Ready: what
    /// TURN ON makes; On: what is loaded), in the order the Bank's parser reads.
    #[test]
    fn the_words_flags_ride_only_in_the_state_they_describe() {
        use EnvSwitch::*;
        let memo = |remembered| SwitchMemo { remembered, error: None };
        let all = KeyFacts { identity_on_disk: true, legacy_on_disk: true, mnemonic: true, backed_up: true, reminted: true, ..KeyFacts::default() };
        let legacy = KeyFacts { legacy_on_disk: true, ..KeyFacts::default() };

        let json = |v: &WalletSwitch| serde_json::to_string(v).unwrap();
        assert_eq!(json(&view(true, Unset, false, &memo(false), &legacy)), r#"{"state":"ready","legacy":true,"mnemonic":true}"#);
        let v = view(true, Unset, false, &memo(false), &all);
        assert_eq!(json(&v), r#"{"state":"ready","seed":true,"mnemonic":true}"#, "an identity on disk wins: turning on loads it, and retires the raw seed");
        for state in [view(false, Unset, false, &memo(true), &all), view(true, Off, false, &memo(true), &all)] {
            assert_eq!(json(&state), format!(r#"{{"state":"{}"}}"#, if state.state == WalletState::Off { "off" } else { "unbuilt" }));
        }

        let reminted = KeyFacts { mnemonic: true, reminted: true, ..KeyFacts::default() };
        assert_eq!(json(&view(true, Unset, true, &memo(true), &reminted)), r#"{"state":"on","stays":true,"mnemonic":true,"reminted":true,"at_rest":"none"}"#);
        let saved = KeyFacts { mnemonic: true, backed_up: true, ..KeyFacts::default() };
        assert_eq!(json(&view(true, Unset, true, &memo(true), &saved)), r#"{"state":"on","stays":true,"mnemonic":true,"backed_up":true,"at_rest":"none"}"#);
        let v = view(true, On, true, &memo(false), &all);
        assert_eq!(json(&v), r#"{"state":"on","stays":true,"held":true,"mnemonic":true,"backed_up":true,"reminted":true,"at_rest":"none"}"#);
        let v = view(true, Unset, true, &memo(true), &KeyFacts { backed_up: true, ..KeyFacts::default() });
        assert!(!v.backed_up, "backed up means these words, which a wallet not made from them has not");
        assert!(!view(true, Unset, true, &memo(true), &KeyFacts { identity_on_disk: true, legacy_on_disk: true, ..KeyFacts::default() }).seed);

        let back: WalletSwitch = serde_json::from_str(r#"{"state":"on","mnemonic":true}"#).unwrap();
        assert!(back.mnemonic && !back.backed_up);
        let back: WalletSwitch = serde_json::from_str(r#"{"state":"on"}"#).unwrap();
        assert!(!back.mnemonic, "an older node never sends it");
        assert!(!json(&v).contains("words"), "the fingerprint never carries the words, nor a flag named after them");
    }

    /// 🔒 How the file keeps its key rides only while On with the 24 words;
    /// the lock to come only while it is still in the clear.
    #[test]
    fn the_at_rest_flags_ride_only_for_a_loaded_24_word_wallet() {
        use EnvSwitch::*;
        let memo = SwitchMemo { remembered: true, error: None };
        let json = |v: &WalletSwitch| serde_json::to_string(v).unwrap();
        let clear = KeyFacts { mnemonic: true, at_rest_next: Some(AtRest::Dpapi), ..KeyFacts::default() };
        assert_eq!(
            json(&view(true, Unset, true, &memo, &clear)),
            r#"{"state":"on","stays":true,"mnemonic":true,"at_rest":"none","at_rest_next":"dpapi"}"#
        );
        let locked = KeyFacts { mnemonic: true, backed_up: true, at_rest: AtRest::Dpapi, at_rest_next: Some(AtRest::Dpapi), rewrapped: true, ..KeyFacts::default() };
        assert_eq!(
            json(&view(true, Unset, true, &memo, &locked)),
            r#"{"state":"on","stays":true,"mnemonic":true,"backed_up":true,"at_rest":"dpapi","rewrapped":true}"#,
            "a locked file has no lock to come"
        );
        let linux = KeyFacts { mnemonic: true, ..KeyFacts::default() };
        assert_eq!(json(&view(true, Unset, true, &memo, &linux)), r#"{"state":"on","stays":true,"mnemonic":true,"at_rest":"none"}"#);
        // Not loaded, or not from 24 words: nothing to say about its file.
        for v in [view(true, Unset, false, &memo, &locked), view(true, Unset, true, &memo, &KeyFacts { mnemonic: false, ..locked })] {
            assert!(v.at_rest.is_none() && v.at_rest_next.is_none() && !v.rewrapped, "{v:?}");
        }
        let back: WalletSwitch = serde_json::from_str(r#"{"state":"on","mnemonic":true}"#).unwrap();
        assert_eq!(back.at_rest, None, "an older node never sends it");
    }

    #[test]
    fn the_words_routes_take_the_reveal_or_one_key_and_nothing_else() {
        assert_eq!(words_asked("/api/chia/words"), Some(WordsAsk::Reveal));
        assert_eq!(words_asked("/api/chia/words/saved?key=1234567890"), Some(WordsAsk::Saved(1234567890)));
        assert_eq!(words_asked("/api/chia/words/saved?key=0"), Some(WordsAsk::Saved(0)));
        assert_eq!(words_asked("/api/chia/words/saved?key=4294967295"), Some(WordsAsk::Saved(u32::MAX)));
        for bad in [
            "/api/chia/words/",
            "/api/chia/words?",
            "/api/chia/words?x",
            "/api/chia/words?key=1",
            "/api/chia/words/saved",
            "/api/chia/words/saved?",
            "/api/chia/words/saved?key=",
            "/api/chia/words/saved?key=+1",
            "/api/chia/words/saved?key=-1",
            "/api/chia/words/saved?key=4294967296",
            "/api/chia/words/saved?key=1&x=2",
            "/api/chia/words/saved?x=2&key=1",
            "/api/chia/words/saved?key=1&key=2",
            "/api/chia/words/saved?key= 1",
            "/api/chia/words/saved?key=0x1f",
            "/api/chia/words/saved/?key=1",
            "/api/chia/wordsx",
        ] {
            assert_eq!(words_asked(bad), None, "{bad}");
        }
        for ours in ["/api/chia/words", "/api/chia/words/", "/api/chia/words?x", "/api/chia/words/saved?key=1"] {
            assert!(is_words_target(ours), "{ours}");
        }
        for not_ours in ["/api/chia/wordsx", "/api/chia/wallet?on=1", "/api/chia/word"] {
            assert!(!is_words_target(not_ours), "{not_ours}");
        }
    }

    #[test]
    fn the_words_routes_are_not_under_the_switch_path() {
        for target in ["/api/chia/words", "/api/chia/words/saved?key=1"] {
            assert!(!target.starts_with("/api/chia/wallet"), "{target}");
            assert_eq!(turn_asked(target), None, "{target}");
        }
        assert!(!is_words_target("/api/chia/wallet?on=1"));
    }

    #[test]
    fn the_saved_flag_is_for_one_key_and_an_unreadable_one_is_reported() {
        let dir = std::env::temp_dir().join(format!("ssf-words-saved-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(SAVED_FILE);
        assert_eq!(saved_for(&path, 7), Ok(false), "no flag: not saved");
        std::fs::write(&path, br#"{"key":3781984839,"at":1730000000}"#).unwrap();
        assert_eq!(saved_for(&path, 3781984839), Ok(true));
        assert_eq!(saved_for(&path, 1532878573), Ok(false), "a flag for another key: a wallet made since");
        std::fs::write(&path, br#"{"key":"#).unwrap();
        let err = saved_for(&path, 3781984839).unwrap_err();
        assert!(err.contains(SAVED_FILE), "{err}");
        assert!(!saved_for(&path, 3781984839).unwrap_or(false), "the caller counts unreadable as not saved");
        #[cfg(feature = "chia-publish")]
        {
            let switch = dir.join(SWITCH_FILE);
            remember(&switch, true, 1).unwrap();
            remember_saved(&path, 1532878573, 9).unwrap();
            assert_eq!(saved_for(&path, 1532878573), Ok(true), "a torn flag is replaced whole");
            assert_eq!(saved_for(&path, 3781984839), Ok(false));
            assert_eq!(remembered(&switch), Ok(true), "the switch is untouched");
            let mut left: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
            left.sort();
            assert_eq!(left, vec![std::ffi::OsString::from(SWITCH_FILE), std::ffi::OsString::from(SAVED_FILE)]);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_operator_names_exact_dev_pages() {
        assert!(dev_pages_of(None).is_empty());
        assert!(dev_pages_of(Some(OsStr::new(""))).is_empty());
        assert_eq!(dev_pages_of(Some(OsStr::new("http://localhost:5173"))), vec!["http://localhost:5173"]);
        assert_eq!(
            dev_pages_of(Some(OsStr::new(" http://localhost:5173/ , ,http://127.0.0.1:1420"))),
            vec!["http://localhost:5173", "http://127.0.0.1:1420"]
        );
        assert_eq!(dev_pages_of(Some(OsStr::new("1"))), vec!["1"], "the old on-switch names no page, so no page passes");
    }

    #[test]
    fn only_the_desktop_app_or_a_named_dev_page_may_read_the_words() {
        let none: Vec<String> = vec![];
        let dev = dev_pages_of(Some(OsStr::new("http://localhost:5173")));
        let ok = |o: &str, h: &str, pages: &[String]| app_page(Some(o), Some(h), 8080, pages);
        assert!(ok("tauri://localhost", "127.0.0.1:8080", &none), "the desktop app on macOS and Linux");
        assert!(ok("TAURI://LOCALHOST", "localhost:8080", &none));
        assert_eq!(ok("http://tauri.localhost", "127.0.0.1:8080", &none), cfg!(windows), "the desktop app on Windows only");
        assert_eq!(ok("https://tauri.localhost", "127.0.0.1:8080", &none), cfg!(windows));
        assert!(!ok("http://tauri.localhost:8000", "127.0.0.1:8080", &none));

        assert!(!ok("http://localhost:5173", "127.0.0.1:8080", &none), "a loopback page needs the operator's word");
        assert!(ok("http://localhost:5173", "127.0.0.1:8080", &dev), "the named dev page");
        assert!(ok("HTTP://LOCALHOST:5173", "127.0.0.1:8080", &dev), "case-blind");
        assert!(!ok("http://localhost:5174", "127.0.0.1:8080", &dev), "another port's page");
        assert!(!ok("http://127.0.0.1:5173", "127.0.0.1:8080", &dev), "exactly the named origin");
        assert!(!ok("http://localhost:8888", "127.0.0.1:8080", &dev), "a notebook on loopback");

        for pages in [&none, &dev] {
            assert!(!ok("https://example.com", "127.0.0.1:8080", pages), "a website");
            assert!(!ok("null", "127.0.0.1:8080", pages), "a sandboxed or file page");
            assert!(!app_page(None, Some("127.0.0.1:8080"), 8080, pages), "no Origin: a local process");
            assert!(!app_page(Some("tauri://localhost"), None, 8080, pages), "no Host");
            assert!(!ok("tauri://localhost", "rebound.example.com:8080", pages), "a re-bound Host");
            assert!(!ok("tauri://localhost", "127.0.0.1:8081", pages), "another port's API");
            assert!(!ok("http://localhost:5173", "rebound.example.com:8080", pages));
        }
        let web = dev_pages_of(Some(OsStr::new("https://example.com")));
        assert!(!ok("https://example.com", "127.0.0.1:8080", &web), "a web origin never passes, listed or not");
    }

    #[test]
    fn a_words_answer_is_never_cached_and_readable_only_by_the_page_that_asked() {
        let head = words_reply_head("200 OK", Some("tauri://localhost"), 42);
        assert!(head.starts_with("HTTP/1.1 200 OK\r\n"), "{head}");
        for line in [
            "Content-Type: application/json\r\n",
            "Cache-Control: no-store\r\n",
            "X-Content-Type-Options: nosniff\r\n",
            "Access-Control-Allow-Origin: tauri://localhost\r\n",
            "Vary: Origin\r\n",
            "Content-Length: 42\r\n",
            "Connection: close\r\n",
        ] {
            assert!(head.contains(line), "{line:?} in {head}");
        }
        assert!(head.ends_with("\r\n\r\n"));
        assert_eq!(head.matches("Access-Control-Allow-Origin").count(), 1);
        let head = words_reply_head("403 Forbidden", None, 7);
        assert!(!head.contains("Access-Control-Allow-Origin"), "{head}");
        assert!(head.contains("Cache-Control: no-store\r\n") && head.contains("Vary: Origin\r\n"));
        let head = words_reply_head("403 Forbidden", Some("http://x\r\nSet-Cookie: a=b"), 7);
        assert!(!head.contains("Set-Cookie"), "no header can be smuggled: {head}");
    }

    #[test]
    fn the_backup_refusals_name_what_to_do() {
        assert!(BACKUP_PAGE_ONLY.contains("SSF_BANK_DEV_PAGES") && BACKUP_PAGE_ONLY.contains("24 words"));
        assert!(BACKUP_TURNING.contains("SHOW again") && BACKUP_KEY_CHANGED.contains("SHOW again"));
        assert!(BACKUP_NOT_SHOWN.contains("tap SHOW first"));
        for w in [BACKUP_PAGE_ONLY, BACKUP_TURNING, BACKUP_NOT_ON, BACKUP_SAVED, BACKUP_MISMATCH, BACKUP_KEY_CHANGED, BACKUP_NOT_SHOWN, BACKUP_UNREADABLE, BACKUP_BAD_ASK] {
            assert!(!w.contains('"') && !w.contains('\\'), "plain words in a JSON string: {w}");
        }
    }

    /// The loaded wallet's meta for the words-route table: key fingerprint 7.
    fn meta(backed_up: bool, revealed: bool) -> WalletMeta {
        WalletMeta { fingerprint: 7, backed_up, reminted: false, revealed, ..WalletMeta::default() }
    }

    #[test]
    fn with_no_wallet_loaded_a_words_ask_is_turning_or_not_on() {
        for ask in [WordsAsk::Reveal, WordsAsk::Saved(7)] {
            assert_eq!(words_step::<()>(ask, None, true), WordsStep::Refuse(WordsRefusal::Turning), "{ask:?}");
            assert_eq!(words_step::<()>(ask, None, false), WordsStep::Refuse(WordsRefusal::NotOn), "{ask:?}");
        }
        // A turn beside a loaded wallet (KEEP IT ON) is not "turning": the
        // key never changes in a run once loaded.
        assert_eq!(words_step(WordsAsk::Saved(7), Some(((), meta(true, false))), true), WordsStep::SavedIdempotent);
        assert_eq!(words_step(WordsAsk::Reveal, Some(("key", meta(false, false))), true), WordsStep::ReadFile { wallet: "key", fingerprint: 7 });
    }

    #[test]
    fn a_reveal_reads_the_file_until_the_words_are_marked_saved() {
        let step = |m| words_step(WordsAsk::Reveal, Some(("key", m)), false);
        assert_eq!(step(meta(false, false)), WordsStep::ReadFile { wallet: "key", fingerprint: 7 });
        assert_eq!(step(meta(false, true)), WordsStep::ReadFile { wallet: "key", fingerprint: 7 }, "shown again until saved");
        assert_eq!(step(meta(true, false)), WordsStep::Refuse(WordsRefusal::AlreadySaved), "saved: never shown again");
        assert_eq!(step(meta(true, true)), WordsStep::Refuse(WordsRefusal::AlreadySaved));
    }

    /// A save that lands while the reveal reads the file (another tab's I
    /// SAVED) wins: the words are not shown after they are marked saved.
    #[test]
    fn a_reveal_lands_only_while_the_words_are_not_marked_saved() {
        let mut m = meta(false, false);
        assert_eq!(reveal_lands(Some(&mut m), 7), Ok(()));
        assert!(m.revealed, "shown: I SAVED may follow");
        let mut saved = meta(true, false);
        assert_eq!(reveal_lands(Some(&mut saved), 7), Err(WordsRefusal::AlreadySaved));
        assert!(!saved.revealed);
        let mut other = meta(false, false);
        assert_eq!(reveal_lands(Some(&mut other), 8), Err(WordsRefusal::KeyChanged));
        assert!(!other.revealed);
        assert_eq!(reveal_lands(None, 7), Err(WordsRefusal::NotOn));
    }

    #[test]
    fn a_saved_mark_checks_the_key_then_saved_then_shown() {
        use WordsStep::*;
        // (asked key, backed_up, revealed) → step, in the route's order.
        let table = [
            ((8, true, true), Refuse(WordsRefusal::KeyChanged)),
            ((8, true, false), Refuse(WordsRefusal::KeyChanged)),
            ((8, false, true), Refuse(WordsRefusal::KeyChanged)),
            ((8, false, false), Refuse(WordsRefusal::KeyChanged)),
            ((7, true, false), SavedIdempotent),
            ((7, true, true), SavedIdempotent),
            ((7, false, false), Refuse(WordsRefusal::NotShown)),
            ((7, false, true), WriteFlag { key: 7 }),
        ];
        for ((asked, backed_up, revealed), want) in table {
            assert_eq!(
                words_step(WordsAsk::Saved(asked), Some(((), meta(backed_up, revealed))), false),
                want,
                "key {asked}, backed_up {backed_up}, revealed {revealed}"
            );
        }
    }

    #[test]
    fn a_words_refusal_is_a_409_and_only_the_saved_one_says_saved() {
        let cases = [
            (WordsRefusal::Turning, BACKUP_TURNING),
            (WordsRefusal::NotOn, BACKUP_NOT_ON),
            (WordsRefusal::AlreadySaved, BACKUP_SAVED),
            (WordsRefusal::KeyChanged, BACKUP_KEY_CHANGED),
            (WordsRefusal::NotShown, BACKUP_NOT_SHOWN),
        ];
        for (why, error) in cases {
            let (status, body) = why.answer();
            assert_eq!(status, "409 Conflict", "{why:?}");
            if why == WordsRefusal::AlreadySaved {
                assert_eq!(body, serde_json::json!({ "ok": false, "saved": true, "error": error }));
            } else {
                assert_eq!(body, serde_json::json!({ "ok": false, "error": error }), "{why:?}");
            }
        }
    }

    #[test]
    fn a_reveal_shows_only_words_that_make_the_loaded_key() {
        assert!(words_match(7, &"pk", 7, &"pk"));
        assert!(!words_match(8, &"pk", 7, &"pk"), "another fingerprint on disk");
        assert!(!words_match(7, &"other", 7, &"pk"), "the same fingerprint, another wallet key");
        assert!(!words_match(8, &"other", 7, &"pk"));
    }

    #[test]
    fn a_saved_mark_answers_with_the_view_and_a_note_only_when_unconfirmed() {
        let saved = WalletSwitch { stays: true, mnemonic: true, backed_up: true, ..sw(WalletState::On) };
        let (status, body) = saved_answer(&saved, None);
        assert_eq!(status, "200 OK");
        assert_eq!(body, serde_json::json!({ "ok": true, "wallet": { "state": "on", "stays": true, "mnemonic": true, "backed_up": true } }));

        // The write failed but the flag holds the key: a 200, the view with
        // `backed_up`, and the note.
        let FailedMark::Landed { note } = after_failed_mark("dir sync failed", Ok(true)) else {
            panic!("a flag read back with the key is saved");
        };
        assert_eq!(note, "saved, but not confirmed on disk (dir sync failed)");
        let (status, body) = saved_answer(&saved, Some(&note));
        assert_eq!(status, "200 OK");
        assert_eq!(body["ok"], true);
        assert_eq!(body["wallet"]["backed_up"], true);
        assert_eq!(body["note"], note.as_str());
        assert_eq!(body.as_object().unwrap().len(), 3);

        // Not written, or unreadable: the 500, and the words stay not saved.
        let lost = FailedMark::Lost { error: "the Bank could not record it (disk full); your words are fine, tap I SAVED again".into() };
        assert_eq!(after_failed_mark("disk full", Ok(false)), lost, "the flag holds another key or none");
        assert_eq!(after_failed_mark("disk full", Err("unreadable".into())), lost, "unreadable counts as not written");
    }

    #[test]
    fn a_words_answer_is_readable_by_the_page_that_passed_or_the_granted_one_for_its_403() {
        assert_eq!(words_allow_origin(true, Some("tauri://localhost"), true), Some("tauri://localhost"));
        assert_eq!(
            words_allow_origin(true, Some("http://localhost:5173"), false),
            Some("http://localhost:5173"),
            "the exact origin app_page passed, whatever the wider rule says"
        );
        assert_eq!(words_allow_origin(false, Some("http://localhost:5174"), true), Some("http://localhost:5174"), "a 403 a dev page can read");
        assert_eq!(words_allow_origin(false, Some("https://example.com"), false), None, "a 403 a website cannot read");
        assert_eq!(words_allow_origin(false, None, false), None);
        assert_eq!(words_allow_origin(true, None, false), None);
    }
}
