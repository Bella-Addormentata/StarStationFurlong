//! ⛓️ The Chia network this node runs on (stage 2 of the mainnet transition
//! plan: the network becomes a setting, testnet11 by default).
//!
//! One value, [`ChiaNet`], decides what used to be hard-coded to testnet11:
//! the address prefix, the AGG_SIG constants a spend is signed with, the
//! folder the per-network state files live in, the node's texts, and whether
//! it is a test network: off one, only the desktop app shows the SSF wallet's
//! 24 words and a new wallet is made only while its channel is on
//! (chia_wallet_switch.rs). It is read once from `SSF_CHIA_NETWORK`
//! ([`selected`]). Unset or empty means [`DEFAULT_NET`], and testnet11 keeps
//! every file name, address, signature and text it had before.
//!
//! Mainnet can be selected only in a build with the `chia-mainnet` feature,
//! a development build: [`net_of`] refuses it otherwise, and release builds
//! leave the feature out. A value the build does not accept stops the node
//! at startup ([`startup`]), so a typo never moves it to another chain. All
//! the mainnet code compiles and is tested in every build anyway, through the
//! pure forms that take the network as an argument, so no test reads the
//! environment.
//!
//! Always compiled: the words rules (chia_wallet_switch.rs) take the
//! network in every build, and the fingerprint carries it.
// A read-only build uses only part of this (no wallet, no address, no words).
#![cfg_attr(not(feature = "chia-publish"), allow(dead_code))]

use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The environment variable that names the network.
pub const NET_ENV: &str = "SSF_CHIA_NETWORK";

/// The network a node runs on when `SSF_CHIA_NETWORK` is unset or empty.
pub const DEFAULT_NET: ChiaNet = ChiaNet::Testnet11;

/// The folder under the node's data root that holds mainnet's own state
/// files. testnet11's stay at the root, where they always were.
pub const MAINNET_DIR: &str = "chia-mainnet";

/// Whether this build may select mainnet: only with the `chia-mainnet`
/// feature, which release builds leave out. [`net_of`] takes it as an
/// argument, so its tests cover both answers in every build.
const MAINNET_BUILT: bool = cfg!(feature = "chia-mainnet");

/// The exit code of a node stopped by a refused `SSF_CHIA_NETWORK`.
pub const EXIT_REFUSED: i32 = 2;

/// A Chia network this node knows.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum ChiaNet {
    /// Chia's test network: free coins (TXCH), the default.
    Testnet11,
    /// Chia's main network: real XCH.
    Mainnet,
}

impl ChiaNet {
    /// Every network, for tests that run over both.
    pub const ALL: [ChiaNet; 2] = [ChiaNet::Testnet11, ChiaNet::Mainnet];

    /// The network's id: its `SSF_CHIA_NETWORK` value, the fingerprint's
    /// `chia_network.id` and the identity file's `net`.
    pub fn id(self) -> &'static str {
        match self {
            ChiaNet::Testnet11 => "testnet11",
            ChiaNet::Mainnet => "mainnet",
        }
    }

    /// The network's name in the node's texts.
    pub fn name(self) -> &'static str {
        match self {
            ChiaNet::Testnet11 => "testnet11",
            ChiaNet::Mainnet => "Chia mainnet",
        }
    }

    /// The bech32m prefix of the network's addresses.
    pub fn prefix(self) -> &'static str {
        match self {
            ChiaNet::Testnet11 => "txch",
            ChiaNet::Mainnet => "xch",
        }
    }

    /// The network's coin, as the texts name it.
    pub fn ticker(self) -> &'static str {
        match self {
            ChiaNet::Testnet11 => "TXCH",
            ChiaNet::Mainnet => "XCH",
        }
    }

    /// A test network, whose coins are worth nothing.
    pub fn is_test(self) -> bool {
        match self {
            ChiaNet::Testnet11 => true,
            ChiaNet::Mainnet => false,
        }
    }

    /// The network's genesis challenge, 64 lowercase hex digits (checked
    /// against the consensus constants in a test).
    pub fn genesis_hex(self) -> &'static str {
        match self {
            ChiaNet::Testnet11 => "37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615",
            ChiaNet::Mainnet => "ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb",
        }
    }

    /// The network's genesis challenge as 32 bytes, in the order its hex
    /// reads ([`genesis_hex`](Self::genesis_hex)): G of the stage 4 design,
    /// which the burner root mixes in on every network (§3.2) and the lane's
    /// network tag appends on mainnet (§3.5, `chia_lane::network_tag`). It is
    /// public, so holding or appending it hides nothing and needs no wipe.
    pub fn genesis(self) -> [u8; 32] {
        let mut g = [0u8; 32];
        hex::decode_to_slice(self.genesis_hex(), &mut g).expect("a genesis challenge is 64 hex digits (each_network_is_pinned)");
        g
    }

    /// The port the network's full nodes listen on.
    pub fn port(self) -> u16 {
        match self {
            ChiaNet::Testnet11 => 58444,
            ChiaNet::Mainnet => 8444,
        }
    }

    /// Where one of the network's own state files lives, relative to the
    /// node's data root: the bare name on testnet11 (the paths it always
    /// had), `chia-mainnet/<name>` on mainnet.
    pub fn path(self, name: &str) -> PathBuf {
        match self.dir() {
            None => PathBuf::from(name),
            Some(dir) => PathBuf::from(dir).join(name),
        }
    }

    /// The folder under the data root that holds the network's own state
    /// files: none on testnet11, `chia-mainnet` on mainnet.
    pub fn dir(self) -> Option<&'static str> {
        match self {
            ChiaNet::Testnet11 => None,
            ChiaNet::Mainnet => Some(MAINNET_DIR),
        }
    }

    /// The network's consensus constants, which the AGG_SIG messages a spend
    /// signs are made from.
    #[cfg(feature = "chia-read")]
    pub fn constants(self) -> &'static chia_consensus::consensus_constants::ConsensusConstants {
        match self {
            ChiaNet::Testnet11 => &chia_sdk_types::TESTNET11_CONSTANTS,
            ChiaNet::Mainnet => &chia_sdk_types::MAINNET_CONSTANTS,
        }
    }
}

/// Where the node's network came from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetSource {
    /// Nothing named one: [`DEFAULT_NET`].
    Default,
    /// `SSF_CHIA_NETWORK`.
    Env,
}

/// ⛓️ The network in the loopback fingerprint (`chia_network`): its id, its
/// genesis challenge and where it came from. The page keeps its own table of
/// prefixes and tickers and uses a row only when the id and the genesis both
/// match, so a node bug or a stranger on the port cannot invent one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct NetworkView {
    pub id: ChiaNet,
    pub genesis: String,
    pub source: NetSource,
}

impl NetworkView {
    pub fn of(net: ChiaNet, source: NetSource) -> Self {
        Self { id: net, genesis: net.genesis_hex().to_string(), source }
    }
}

/// The network for a raw `SSF_CHIA_NETWORK` value, the network the player
/// chose in the game (`remembered`; nothing chooses one yet, so the node
/// always passes none) and whether this build has mainnet.
///
/// Unset or empty leaves it to `remembered`, then [`DEFAULT_NET`]. Otherwise
/// the value must be exactly `testnet11` or `mainnet`: lowercase, untrimmed,
/// no aliases. Anything else is an error, never a fallback, since a typo
/// must not move the node to another chain. Mainnet is refused while the
/// build has none.
pub fn net_of(
    raw: Option<&OsStr>,
    remembered: Option<ChiaNet>,
    mainnet_built: bool,
) -> Result<(ChiaNet, NetSource), String> {
    let unbuilt = || "This build has no mainnet. Build it with --features chia-mainnet.".to_string();
    let (net, source) = match raw {
        Some(v) if !v.is_empty() => {
            let net = ChiaNet::ALL.into_iter().find(|n| v == OsStr::new(n.id())).ok_or_else(|| {
                format!(
                    "{NET_ENV}={} is not a network this node knows. Use testnet11 or mainnet, or leave it unset for testnet11.",
                    v.to_string_lossy()
                )
            })?;
            (net, NetSource::Env)
        }
        // The in-game choice has no source of its own yet: the PR that adds
        // it adds one.
        _ => (remembered.unwrap_or(DEFAULT_NET), NetSource::Default),
    };
    if net == ChiaNet::Mainnet && !mainnet_built {
        return Err(unbuilt());
    }
    Ok((net, source))
}

/// The process's network, read once from `SSF_CHIA_NETWORK`, or why that
/// value is refused.
pub fn selected() -> &'static Result<(ChiaNet, NetSource), String> {
    static SELECTED: std::sync::OnceLock<Result<(ChiaNet, NetSource), String>> = std::sync::OnceLock::new();
    SELECTED.get_or_init(|| net_of(std::env::var_os(NET_ENV).as_deref(), None, MAINNET_BUILT))
}

/// The network the node runs on. A refused `SSF_CHIA_NETWORK` never gets
/// this far: main() stops the node first ([`startup`]), so the default here
/// is only what a caller sees if it asks before that check.
pub fn net() -> ChiaNet {
    selected().as_ref().map(|(net, _)| *net).unwrap_or(DEFAULT_NET)
}

/// The fingerprint's view of [`net`]. Like [`net`], it never sees a refused
/// value in a running node.
#[cfg(feature = "chia-read")]
pub fn view() -> NetworkView {
    match selected() {
        Ok((net, source)) => NetworkView::of(*net, *source),
        Err(_) => NetworkView::of(DEFAULT_NET, NetSource::Default),
    }
}

/// What startup does with the network: `Ok` with the line it prints, or
/// `Err` with the one line it prints before it stops with [`EXIT_REFUSED`].
/// main() calls this first, before it opens a file or binds a socket.
pub fn startup(selected: &Result<(ChiaNet, NetSource), String>) -> Result<String, String> {
    match selected {
        Ok((net, source)) => Ok(network_line(*net, *source)),
        Err(why) => Err(format!("⛓️ Chia network: {why}")),
    }
}

/// The startup line that names the network and where it came from, and, off
/// a test network, that its coins are real.
pub fn network_line(net: ChiaNet, source: NetSource) -> String {
    let from = match source {
        NetSource::Default => "the default",
        NetSource::Env => "set by SSF_CHIA_NETWORK",
    };
    let line = format!("⛓️ Chia network: {} ({from})", net.id());
    if net.is_test() {
        return line;
    }
    format!("{line}. Real {}.", net.ticker())
}

/// Make the folder that holds `net`'s own state files under `root`, readable
/// by its owner only: 0700 on Unix; elsewhere the platform's default, as the
/// node's private files already are (chia_contact.rs `write_private`). A
/// folder that is already there is tightened again. Nothing on testnet11,
/// whose files stay at the root. Returns the folder it made or kept.
pub fn make_state_dir(net: ChiaNet, root: &Path) -> std::io::Result<Option<PathBuf>> {
    let Some(name) = net.dir() else { return Ok(None) };
    let dir = root.join(name);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && dir.is_dir() => {
                std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
            }
            Err(e) => return Err(e),
        }
    }
    #[cfg(not(unix))]
    std::fs::create_dir_all(&dir)?;
    Ok(Some(dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The one test of literal values: what each network is. Every other
    /// test runs over both networks through the pure forms.
    #[test]
    fn each_network_is_pinned() {
        assert_eq!(DEFAULT_NET, ChiaNet::Testnet11, "testnet11 is the default until stage 5");
        let t = ChiaNet::Testnet11;
        assert_eq!((t.id(), t.name(), t.prefix(), t.ticker(), t.is_test(), t.port()), ("testnet11", "testnet11", "txch", "TXCH", true, 58444));
        let m = ChiaNet::Mainnet;
        assert_eq!((m.id(), m.name(), m.prefix(), m.ticker(), m.is_test(), m.port()), ("mainnet", "Chia mainnet", "xch", "XCH", false, 8444));
        for net in ChiaNet::ALL {
            let g = net.genesis_hex();
            assert!(g.len() == 64 && g.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{g}");
            assert_eq!(hex::encode(net.genesis()), g, "{net:?}: the bytes read as the hex does");
        }
        assert_ne!(t.genesis_hex(), m.genesis_hex());
    }

    #[cfg(feature = "chia-read")]
    #[test]
    fn the_genesis_is_the_constants_own() {
        for net in ChiaNet::ALL {
            assert_eq!(hex::encode(net.constants().genesis_challenge), net.genesis_hex(), "{net:?}");
            assert_eq!(net.genesis(), net.constants().genesis_challenge.to_bytes(), "{net:?}: G is the challenge's own bytes");
        }
    }

    #[test]
    fn the_network_is_exactly_one_of_two_names_or_the_default() {
        let of = |raw: Option<&str>, built: bool| net_of(raw.map(OsStr::new), None, built);
        for built in [false, true] {
            assert_eq!(of(None, built), Ok((ChiaNet::Testnet11, NetSource::Default)));
            assert_eq!(of(Some(""), built), Ok((ChiaNet::Testnet11, NetSource::Default)), "empty is unset");
            assert_eq!(of(Some("testnet11"), built), Ok((ChiaNet::Testnet11, NetSource::Env)));
            for bad in ["Mainnet", " mainnet", "mainnet ", "testnet", "TESTNET11", "testnet10", "xch", "main", "1"] {
                let err = of(Some(bad), built).unwrap_err();
                assert_eq!(
                    err,
                    format!("SSF_CHIA_NETWORK={bad} is not a network this node knows. Use testnet11 or mainnet, or leave it unset for testnet11."),
                    "no aliases, no trimming"
                );
            }
        }
        assert_eq!(of(Some("mainnet"), true), Ok((ChiaNet::Mainnet, NetSource::Env)));
        assert_eq!(
            of(Some("mainnet"), false),
            Err("This build has no mainnet. Build it with --features chia-mainnet.".to_string()),
            "a build without the feature cannot select mainnet"
        );
        // The in-game choice, which nothing makes yet: the environment wins,
        // and mainnet still needs the build.
        assert_eq!(net_of(None, Some(ChiaNet::Mainnet), true), Ok((ChiaNet::Mainnet, NetSource::Default)));
        assert!(net_of(None, Some(ChiaNet::Mainnet), false).is_err());
        assert_eq!(net_of(Some(OsStr::new("testnet11")), Some(ChiaNet::Mainnet), false), Ok((ChiaNet::Testnet11, NetSource::Env)));
    }

    #[cfg(unix)]
    #[test]
    fn a_value_that_is_not_unicode_is_refused_too() {
        use std::os::unix::ffi::OsStrExt;
        assert!(net_of(Some(OsStr::from_bytes(b"main\xffnet")), None, true).is_err());
    }

    /// What this build accepts: mainnet only with the `chia-mainnet`
    /// feature. The table above covers both answers in every build; these
    /// two pin what `selected` passes.
    #[cfg(feature = "chia-mainnet")]
    #[test]
    fn a_mainnet_build_selects_mainnet_by_its_exact_name() {
        let of = |raw: &str| net_of(Some(OsStr::new(raw)), None, MAINNET_BUILT);
        const { assert!(MAINNET_BUILT) };
        assert_eq!(of("mainnet"), Ok((ChiaNet::Mainnet, NetSource::Env)));
        assert_eq!(of("testnet11"), Ok((ChiaNet::Testnet11, NetSource::Env)));
        assert_eq!(net_of(None, None, MAINNET_BUILT), Ok((ChiaNet::Testnet11, NetSource::Default)), "the default stays testnet11");
        for bad in ["Mainnet", " mainnet", "testnet", "xch"] {
            assert!(of(bad).unwrap_err().contains("is not a network this node knows"), "{bad}");
        }
    }

    #[cfg(not(feature = "chia-mainnet"))]
    #[test]
    fn a_build_without_the_feature_refuses_mainnet() {
        const { assert!(!MAINNET_BUILT, "release builds (chia-publish,torrent) and default builds have no mainnet") };
        assert_eq!(
            net_of(Some(OsStr::new("mainnet")), None, MAINNET_BUILT),
            Err("This build has no mainnet. Build it with --features chia-mainnet.".to_string())
        );
        assert_eq!(net_of(Some(OsStr::new("testnet11")), None, MAINNET_BUILT), Ok((ChiaNet::Testnet11, NetSource::Env)));
    }

    #[test]
    fn a_refused_value_stops_the_node_with_one_line() {
        let line = startup(&net_of(Some(OsStr::new("mainnet")), None, false)).unwrap_err();
        assert_eq!(line, "⛓️ Chia network: This build has no mainnet. Build it with --features chia-mainnet.");
        let line = startup(&net_of(Some(OsStr::new("Mainnet")), None, true)).unwrap_err();
        assert_eq!(
            line,
            "⛓️ Chia network: SSF_CHIA_NETWORK=Mainnet is not a network this node knows. Use testnet11 or mainnet, or leave it unset for testnet11."
        );
        assert!(!line.contains('\n') && !line.contains('\u{2014}'), "one line, no em-dashes: {line}");
        assert_eq!(EXIT_REFUSED, 2);
    }

    #[test]
    fn startup_names_the_network_and_where_it_came_from() {
        let line = |net, source| startup(&Ok((net, source))).unwrap();
        assert_eq!(line(ChiaNet::Testnet11, NetSource::Default), "⛓️ Chia network: testnet11 (the default)");
        assert_eq!(line(ChiaNet::Testnet11, NetSource::Env), "⛓️ Chia network: testnet11 (set by SSF_CHIA_NETWORK)");
        // Mainnet makes an SSF wallet now (the desktop app shows its words),
        // so the line no longer says this node holds none there.
        assert_eq!(line(ChiaNet::Mainnet, NetSource::Env), "⛓️ Chia network: mainnet (set by SSF_CHIA_NETWORK). Real XCH.");
        assert_eq!(line(ChiaNet::Mainnet, NetSource::Default), "⛓️ Chia network: mainnet (the default). Real XCH.");
        for net in ChiaNet::ALL {
            for source in [NetSource::Default, NetSource::Env] {
                let l = network_line(net, source);
                assert!(!l.contains('\u{2014}') && !l.contains('\n'), "{l}");
                assert_eq!(l.contains("Real"), !net.is_test(), "{l}");
                assert!(!l.contains("SSF wallet"), "{l}");
            }
        }
    }

    #[test]
    fn mainnets_folder_is_made_owner_only_and_testnet11_makes_none() {
        let root = std::env::temp_dir().join(format!("ssf-net-dir-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(make_state_dir(ChiaNet::Testnet11, &root).unwrap(), None);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0, "testnet11 makes nothing");
        let dir = make_state_dir(ChiaNet::Mainnet, &root).unwrap().unwrap();
        assert_eq!(dir, root.join(MAINNET_DIR));
        assert!(dir.is_dir());
        assert_eq!(root.join(ChiaNet::Mainnet.path("chia_peers.json")).parent(), Some(dir.as_path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&dir), 0o700, "owner-only from the moment it exists");
            // A folder left broader by an earlier tool or run is tightened.
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(make_state_dir(ChiaNet::Mainnet, &root).unwrap(), Some(dir.clone()));
            assert_eq!(mode(&dir), 0o700);
        }
        // A file where the folder should be is an error, never a quiet success.
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(MAINNET_DIR), b"not a folder").unwrap();
        assert!(make_state_dir(ChiaNet::Mainnet, &other).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn per_network_files_are_bare_on_testnet11_and_in_a_folder_on_mainnet() {
        for name in [
            "chia_identity.json",
            "chia_identity.seed",
            "chia_words_saved.json",
            "chia_wallet.json",
            "wallet_lease.json",
            "chia_peers.json",
            "publish_marks.json",
            "beacon_mark.json",
            "knocks.json",
        ] {
            assert_eq!(ChiaNet::Testnet11.path(name), Path::new(name), "testnet11 keeps the path it always had");
            assert_eq!(ChiaNet::Mainnet.path(name), Path::new("chia-mainnet").join(name));
            assert_eq!(ChiaNet::Mainnet.path(name).parent(), Some(Path::new(MAINNET_DIR)));
        }
        assert_eq!((ChiaNet::Testnet11.dir(), ChiaNet::Mainnet.dir()), (None, Some(MAINNET_DIR)));
    }

    #[test]
    fn the_fingerprints_view_carries_the_id_the_genesis_and_the_source() {
        for net in ChiaNet::ALL {
            for source in [NetSource::Default, NetSource::Env] {
                let v = NetworkView::of(net, source);
                let json = serde_json::to_string(&v).unwrap();
                let source_word = if source == NetSource::Env { "env" } else { "default" };
                assert_eq!(json, format!(r#"{{"id":"{}","genesis":"{}","source":"{source_word}"}}"#, net.id(), net.genesis_hex()));
                let back: NetworkView = serde_json::from_str(&json).unwrap();
                assert_eq!(back, v);
            }
        }
        assert!(serde_json::from_str::<ChiaNet>(r#""testnet""#).is_err(), "only the two ids parse");
    }
}
