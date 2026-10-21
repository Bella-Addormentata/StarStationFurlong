mod bprotocol;
mod dht;
mod error;
mod peer_store;
mod persistence;
mod routing_table;
mod utils;

use std::sync::Arc;
use std::time::Duration;

pub use error::{Error, Result};

pub use crate::dht::DhtStats;
pub use crate::dht::{DhtConfig, DhtState, RequestPeersStream};
pub use librqbit_core::hash_id::Id20;
pub use persistence::{DhtPersistenceConfig, PersistentDht, dht_listen_addr};

pub type Dht = Arc<DhtState>;

// How long do we wait for a response from a DHT node.
pub(crate) const RESPONSE_TIMEOUT: Duration = Duration::from_secs(10);
// TODO: Not sure if we should re-query tbh.
pub(crate) const REQUERY_INTERVAL: Duration = Duration::from_secs(60);
// After how long we consider a routing table node questionable.
pub(crate) const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(15 * 60);

pub struct DhtBuilder {}

impl DhtBuilder {
    #[allow(clippy::new_ret_no_self)]
    pub async fn new() -> crate::Result<Dht> {
        DhtState::new().await
    }

    pub async fn with_config(config: DhtConfig<'_>) -> crate::Result<Dht> {
        DhtState::with_config(config).await
    }
}

pub static DHT_BOOTSTRAP: &[&str] = &["dht.transmissionbt.com:6881", "dht.libtorrent.org:25401"];

// ── SSF fork (StarStationFurlong, ssf-p2p-node/vendor/librqbit-dht) ─────────
// See SSF-FORK.md. Two changes to upstream 9.0.1, both from the media plan's
// §6 DHT rows: the node answers no query (client-only), and every packet goes
// to — and is taken from — a global-unicast address or nowhere.

/// No KRPC query is answered while this holds (see `on_received_message`).
pub const CLIENT_ONLY: bool = true;

/// True for an address that is routable on the public internet: not
/// unspecified, loopback, private, shared (CGNAT), link-local, multicast,
/// broadcast, documentation, benchmarking, reserved, or the IPv6 ranges that
/// embed one of those (IPv4-mapped/compatible, NAT64, 6to4, Teredo, ULA). An
/// IPv4-mapped address is judged as the IPv4 address it carries.
pub fn is_global_unicast(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(a) => v4_global(a),
        IpAddr::V6(a) => match a.to_ipv4_mapped() {
            Some(v4) => v4_global(v4),
            None => v6_global(a),
        },
    }
}

fn v4_global(a: std::net::Ipv4Addr) -> bool {
    let [b0, b1, b2, _] = a.octets();
    !(b0 == 0                                   // "this network"
        || b0 == 10                             // private
        || (b0 == 100 && (64..128).contains(&b1)) // shared / CGNAT
        || b0 == 127                            // loopback
        || (b0 == 169 && b1 == 254)             // link-local, cloud metadata
        || (b0 == 172 && (16..32).contains(&b1)) // private
        || (b0 == 192 && b1 == 0 && b2 == 0)    // IETF protocol assignments
        || (b0 == 192 && b1 == 0 && b2 == 2)    // TEST-NET-1
        || (b0 == 192 && b1 == 88 && b2 == 99)  // 6to4 relay anycast
        || (b0 == 192 && b1 == 168)             // private
        || (b0 == 198 && (b1 == 18 || b1 == 19)) // benchmarking
        || (b0 == 198 && b1 == 51 && b2 == 100) // TEST-NET-2
        || (b0 == 203 && b1 == 0 && b2 == 113)  // TEST-NET-3
        || b0 >= 224)                           // multicast, reserved, broadcast
}

fn v6_global(a: std::net::Ipv6Addr) -> bool {
    let s = a.segments();
    // Global unicast is 2000::/3; everything else (::, ::1, IPv4-compatible,
    // 64:ff9b::/96 NAT64, fc00::/7 ULA, fe80::/10, ff00::/8, …) is not.
    (s[0] & 0xe000) == 0x2000
        && !(s[0] == 0x2001 && s[1] < 0x0200)   // 2001::/23 IETF (incl. Teredo)
        && !(s[0] == 0x2001 && s[1] == 0x0db8)  // documentation
        && s[0] != 0x2002                       // 6to4: embeds any IPv4
        && !(s[0] == 0x3fff && s[1] < 0x1000)   // documentation (RFC 9637)
}

#[cfg(test)]
mod ssf_fork_tests {
    use super::is_global_unicast;

    #[test]
    fn only_global_unicast_passes() {
        for ok in ["1.1.1.1", "8.8.4.4", "100.63.0.1", "172.32.0.1", "2606:4700::1111", "::ffff:1.1.1.1"] {
            assert!(is_global_unicast(ok.parse().unwrap()), "{ok}");
        }
        for no in [
            "0.0.0.0", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1",
            "192.168.1.1", "192.0.2.1", "198.18.0.1", "203.0.113.9", "224.0.0.1", "239.192.152.143",
            "255.255.255.255", "::", "::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
            "64:ff9b::a9fe:a9fe", "fc00::1", "fd12::1", "fe80::1", "ff15::efc0:988f",
            "2001:db8::1", "2001::1", "2002:a00:1::1",
        ] {
            assert!(!is_global_unicast(no.parse().unwrap()), "{no}");
        }
    }
}
