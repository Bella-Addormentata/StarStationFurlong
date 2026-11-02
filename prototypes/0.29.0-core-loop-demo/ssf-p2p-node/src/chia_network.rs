//! ⛓️ The Chia network this node runs on (stage 2 of the mainnet transition
//! plan: the network becomes a setting, testnet11 by default).
//!
//! One value, [`ChiaNet`], decides what used to be hard-coded to testnet11:
//! the address prefix, the AGG_SIG constants a spend is signed with, the
//! folder the per-network state files live in, the node's texts and whether
//! the SSF wallet may exist at all. It is read once from `SSF_CHIA_NETWORK`
//! ([`selected`]). Unset or empty means [`DEFAULT_NET`], and testnet11 keeps
//! every file name, address, signature and text it had before.
//!
//! This build cannot select mainnet: [`net_of`] refuses it while the build
//! has no mainnet, and the peer lane still binds testnet11 (chia_chain.rs).
//! All the mainnet code compiles and is tested anyway, through the pure forms
//! that take the network as an argument, so no test reads the environment.
//!
//! Always compiled: the wallet switch's gates (chia_wallet_switch.rs) take
//! the network in every build, and the fingerprint carries it.
// A read-only build uses only part of this (no wallet, no address, no words).
#![cfg_attr(not(feature = "chia-publish"), allow(dead_code))]

use std::ffi::OsStr;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// The environment variable that names the network.
pub const NET_ENV: &str = "SSF_CHIA_NETWORK";

/// The network a node runs on when `SSF_CHIA_NETWORK` is unset or empty.
pub const DEFAULT_NET: ChiaNet = ChiaNet::Testnet11;

/// The folder under the node's data root that holds mainnet's own state
/// files. testnet11's stay at the root, where they always were.
pub const MAINNET_DIR: &str = "chia-mainnet";

/// Whether this build may select mainnet. False until the `chia-mainnet`
/// feature exists; [`net_of`] takes it as an argument, so its tests cover
/// both answers.
const MAINNET_BUILT: bool = false;

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
        match self {
            ChiaNet::Testnet11 => PathBuf::from(name),
            ChiaNet::Mainnet => PathBuf::from(MAINNET_DIR).join(name),
        }
    }

    /// Whether the node may make or load an SSF wallet on this network. Not
    /// on mainnet until the desktop app shows the 24 words itself: the page
    /// reveal was accepted for testnet only.
    pub fn wallet_allowed(self) -> bool {
        match self {
            ChiaNet::Testnet11 => true,
            ChiaNet::Mainnet => false,
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
    let unbuilt = || "This build has no mainnet.".to_string();
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

/// The network the node runs on. A refused `SSF_CHIA_NETWORK` leaves it on
/// [`DEFAULT_NET`] in this build, where testnet11 is the only network it can
/// run on (startup says so once, [`refused_line`]).
pub fn net() -> ChiaNet {
    selected().as_ref().map(|(net, _)| *net).unwrap_or(DEFAULT_NET)
}

/// The fingerprint's view of [`net`].
#[cfg(feature = "chia-read")]
pub fn view() -> NetworkView {
    match selected() {
        Ok((net, source)) => NetworkView::of(*net, *source),
        Err(_) => NetworkView::of(DEFAULT_NET, NetSource::Default),
    }
}

/// The startup line for a refused `SSF_CHIA_NETWORK`, or none.
pub fn refused_line(selected: &Result<(ChiaNet, NetSource), String>) -> Option<String> {
    selected
        .as_ref()
        .err()
        .map(|why| format!("⛓️ Chia network: {why} This node stays on {}.", DEFAULT_NET.name()))
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
        assert!(t.wallet_allowed());
        let m = ChiaNet::Mainnet;
        assert_eq!((m.id(), m.name(), m.prefix(), m.ticker(), m.is_test(), m.port()), ("mainnet", "Chia mainnet", "xch", "XCH", false, 8444));
        assert!(!m.wallet_allowed(), "no SSF wallet on mainnet until the desktop app shows the words itself");
        for net in ChiaNet::ALL {
            let g = net.genesis_hex();
            assert!(g.len() == 64 && g.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "{g}");
        }
        assert_ne!(t.genesis_hex(), m.genesis_hex());
    }

    #[cfg(feature = "chia-read")]
    #[test]
    fn the_genesis_is_the_constants_own() {
        for net in ChiaNet::ALL {
            assert_eq!(hex::encode(net.constants().genesis_challenge), net.genesis_hex(), "{net:?}");
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
        assert_eq!(of(Some("mainnet"), false), Err("This build has no mainnet.".to_string()), "this build cannot select mainnet");
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

    #[test]
    fn a_refused_value_is_said_once_and_the_node_stays_on_the_default() {
        assert_eq!(refused_line(&Ok((ChiaNet::Testnet11, NetSource::Env))), None);
        let line = refused_line(&net_of(Some(OsStr::new("mainnet")), None, false)).unwrap();
        assert_eq!(line, "⛓️ Chia network: This build has no mainnet. This node stays on testnet11.");
        assert!(!line.contains('\u{2014}'), "no em-dashes: {line}");
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
