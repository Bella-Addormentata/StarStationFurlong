//! 📌 This computer's public IPv4, as the Mainline DHT's nodes see it, in
//! place of the IP-echo websites the node asked before (External
//! Infrastructure Register §7).
//!
//! Every DHT node that answers a query may say, in its answer's `ip` field
//! (BEP 42), the address it saw the query come from. The node's DHT client
//! (`n0-mainline`) counts those as votes over each lookup and keeps the
//! address most of a lookup's answers named (`Info::public_address`). The DHT
//! knock's lookups every 30 s keep it fresh; [`advertise`] makes one lookup of
//! its own every [`REFRESH`], for a node whose knock is off. Measured on
//! GitHub's Linux, Windows and macOS machines (2026-11-16, branch
//! `claude/ip-sources-probe`): the first address came 2.1 to 2.6 s after start
//! and named the same IP as the website on 72 reads of 72.
//!
//! What it gives is the IP the DHT's nodes see. The port it comes with is the
//! DHT socket's, not the game's, so the game's own UDP port is advertised with
//! it, as the website's answer was: right behind a router that keeps the port
//! or forwards that one. IPv6 is never asked: a computer's public IPv6 address
//! is on its own network adapter, and iroh lists it.
//!
//! A lie costs as much as a forged website answer did: one address nobody
//! answers at, since a connection is checked by node key. To move an address
//! already advertised, a new IP must be the vote of two reads in a row
//! ([`Votes`]), so one lookup whose answers were mostly a liar's cannot.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

use n0_mainline::{Dht, Id};

use crate::ReachState;

/// How often the vote is read once an address is known (or the first wait is
/// over). A change of IP is advertised two reads after it shows, so within
/// about a minute.
pub(crate) const READ_GAP: Duration = Duration::from_secs(30);
/// How often the vote is read while none has come yet, for [`FIRST_WAIT`].
pub(crate) const FIRST_READ_GAP: Duration = Duration::from_secs(1);
/// How long the vote is read every [`FIRST_READ_GAP`] after start.
pub(crate) const FIRST_WAIT: Duration = Duration::from_secs(60);
/// How often [`advertise`] makes a lookup of its own, so the vote stays fresh
/// with the knock off (the website was asked this often).
pub(crate) const REFRESH: Duration = Duration::from_secs(300);
/// The longest one such lookup is waited for.
const LOOKUP_TIMEOUT: Duration = Duration::from_secs(20);

/// What one read of the vote calls for.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Step {
    /// Nothing changes.
    Keep,
    /// This IP is now the computer's address: advertise it if it is public,
    /// withdraw the old one either way.
    Take(Ipv4Addr),
}

/// The votes read so far. Pure: [`advertise`] hands it each read.
#[derive(Default)]
pub(crate) struct Votes {
    /// The IP taken last.
    current: Option<Ipv4Addr>,
    /// A different IP the last read named, waiting for a second.
    waiting: Option<Ipv4Addr>,
}

impl Votes {
    /// One read of the DHT client's vote. The first IP is taken at once, since
    /// nothing is advertised yet to protect; a different one only when two
    /// reads in a row name it. A read with no vote changes nothing: the DHT
    /// asked nobody since, and the address stands.
    pub(crate) fn read(&mut self, vote: Option<Ipv4Addr>) -> Step {
        let Some(ip) = vote else { return Step::Keep };
        if self.current == Some(ip) {
            self.waiting = None;
            return Step::Keep;
        }
        if self.current.is_none() || self.waiting == Some(ip) {
            self.current = Some(ip);
            self.waiting = None;
            return Step::Take(ip);
        }
        self.waiting = Some(ip);
        Step::Keep
    }
}

/// For as long as the node runs: read the DHT client's vote and advertise it,
/// with `port`, as this computer's public address, through the endpoint's own
/// external addresses. Passes, listings, beacons, cards and knock replies read
/// the endpoint's live addresses each time, so they follow.
pub(crate) async fn advertise(dht: Dht, ep: iroh::Endpoint, reach: Arc<ReachState>, port: u16) {
    let started = Instant::now();
    let mut votes = Votes::default();
    let mut announced: Option<SocketAddr> = None;
    let mut taken = false;
    let mut said_waiting = false;
    let mut looked = Instant::now();
    loop {
        if looked.elapsed() >= REFRESH {
            let _ = tokio::time::timeout(LOOKUP_TIMEOUT, dht.find_node(Id::random())).await;
            looked = Instant::now();
        }
        let vote = match dht.info().await {
            Ok(info) => info.public_address().map(|addr| *addr.ip()),
            Err(_) => {
                eprintln!("⚠️ Public IPv4: the node's DHT client stopped; the address advertised now stays until the node restarts");
                return;
            }
        };
        if let Step::Take(ip) = votes.read(vote) {
            taken = true;
            if let Some(old) = announced.take() {
                let _ = ep.remove_external_addr(&old).await;
                // Deliberately NOT removed from self_advertised: iroh's live
                // snapshot can report the old addr for a beat after
                // remove_external_addr, and a fingerprint request in that
                // window would misclassify it as "port-mapped" (green). Stale
                // set entries can only ever UNDERSTATE (R1 review L1).
                println!("🔄 Public IP changed — un-advertised stale external address {old}");
            }
            if crate::ipv4_is_public(ip) {
                reach.cgnat_detected.store(false, Ordering::Relaxed);
                let addr = SocketAddr::from((ip, port));
                ep.add_external_addr(addr).await;
                reach.self_advertised.lock().unwrap().insert(addr);
                announced = Some(addr);
                println!(
                    "📌 External address advertised: {addr}, where the DHT's nodes see this computer ({:.1} s after start; no website is asked) — the router must forward UDP {port} here, or keep it",
                    started.elapsed().as_secs_f64()
                );
            } else {
                // Never advertise a CGNAT or private address (unchanged since
                // 0.22.0); the fingerprint says so ("cgnat").
                reach.cgnat_detected.store(true, Ordering::Relaxed);
                eprintln!("⚠️ The DHT's nodes see this computer at the non-public address {ip} (CGNAT, or a DHT inside a private network) — refusing to advertise it; a router port-forward cannot make you reachable from there");
            }
        }
        let first_wait = !taken && started.elapsed() < FIRST_WAIT;
        if !taken && !first_wait && !said_waiting {
            said_waiting = true;
            println!(
                "📌 No DHT answer has named this computer's public IPv4 yet ({} s after start); still reading every {} s",
                started.elapsed().as_secs(),
                READ_GAP.as_secs()
            );
        }
        tokio::time::sleep(if first_wait { FIRST_READ_GAP } else { READ_GAP }).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 7);
    const B: Ipv4Addr = Ipv4Addr::new(198, 51, 100, 9);

    #[test]
    fn the_first_vote_is_taken_at_once() {
        let mut votes = Votes::default();
        assert_eq!(votes.read(Some(A)), Step::Take(A));
        assert_eq!(votes.read(Some(A)), Step::Keep);
    }

    #[test]
    fn no_vote_changes_nothing() {
        let mut votes = Votes::default();
        assert_eq!(votes.read(None), Step::Keep);
        assert_eq!(votes.read(Some(A)), Step::Take(A));
        assert_eq!(votes.read(None), Step::Keep);
        assert_eq!(votes.read(Some(A)), Step::Keep);
    }

    #[test]
    fn a_new_ip_needs_two_reads_in_a_row() {
        let mut votes = Votes::default();
        assert_eq!(votes.read(Some(A)), Step::Take(A));
        assert_eq!(votes.read(Some(B)), Step::Keep);
        assert_eq!(votes.read(Some(B)), Step::Take(B));
        assert_eq!(votes.read(Some(B)), Step::Keep);
    }

    #[test]
    fn one_stray_read_moves_nothing() {
        let mut votes = Votes::default();
        assert_eq!(votes.read(Some(A)), Step::Take(A));
        for _ in 0..5 {
            assert_eq!(votes.read(Some(B)), Step::Keep);
            assert_eq!(votes.read(Some(A)), Step::Keep);
        }
    }

    #[test]
    fn a_read_with_no_vote_does_not_break_the_pair() {
        // The two reads in a row are two that named an IP: a read in between
        // that named none (the DHT asked nobody since) neither counts nor
        // starts the wait over.
        let mut votes = Votes::default();
        assert_eq!(votes.read(Some(A)), Step::Take(A));
        assert_eq!(votes.read(Some(B)), Step::Keep);
        assert_eq!(votes.read(None), Step::Keep);
        assert_eq!(votes.read(Some(B)), Step::Take(B));
    }

    #[test]
    fn the_wait_starts_over_on_a_third_ip() {
        let c = Ipv4Addr::new(192, 0, 2, 44);
        let mut votes = Votes::default();
        assert_eq!(votes.read(Some(A)), Step::Take(A));
        assert_eq!(votes.read(Some(B)), Step::Keep);
        assert_eq!(votes.read(Some(c)), Step::Keep);
        assert_eq!(votes.read(Some(B)), Step::Keep);
        assert_eq!(votes.read(Some(B)), Step::Take(B));
    }

    #[test]
    fn a_non_public_vote_is_taken_for_the_caller_to_refuse() {
        // The caller withdraws what it advertised and says CGNAT; the next
        // public IP then needs its two reads like any change.
        let shared = Ipv4Addr::new(100, 64, 3, 2);
        let mut votes = Votes::default();
        assert_eq!(votes.read(Some(shared)), Step::Take(shared));
        assert!(!crate::ipv4_is_public(shared));
        assert_eq!(votes.read(Some(A)), Step::Keep);
        assert_eq!(votes.read(Some(A)), Step::Take(A));
    }

    /// The node's source, read as text, with the needles joined from pieces
    /// so this file never holds them whole.
    fn main_rs() -> &'static str {
        include_str!("main.rs")
    }

    #[test]
    fn the_node_asks_no_ip_echo_website() {
        let src = main_rs();
        for needle in [["ip", "ify"].concat(), ["check", "ip"].concat(), ["SSF_IP", "_ECHO"].concat(), ["(host, ", "80)"].concat()] {
            assert!(!src.contains(&needle), "main.rs still holds {needle:?}");
        }
        let knock = include_str!("dht_knock.rs");
        for needle in [["ip", "ify"].concat(), ["check", "ip"].concat()] {
            assert!(!knock.contains(&needle), "dht_knock.rs holds {needle:?}");
        }
    }

    #[test]
    fn auto_advertises_the_dht_vote_on_the_shared_client() {
        let src = main_rs();
        let spawn = ["tokio::spawn(public_v4::", "advertise(dht.clone(), iroh_endpoint.clone(), reach.clone(), port))"].concat();
        assert!(src.contains(&spawn), "the auto entries spawn public_v4::advertise on the node's DHT client");
        let knock = ["dht_knock::KnockDht::", "on(dht.clone())"].concat();
        assert!(src.contains(&knock), "the knock runs on the same client");
        let build = ["let own_dht: Option<n0_mainline::Dht> = if !dht_", "on {"].concat();
        assert!(src.contains(&build), "the node's DHT client is built whenever the DHT is on");
    }
}
