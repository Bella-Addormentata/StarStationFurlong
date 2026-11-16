//! Probe, never to merge: can the Mainline DHT stand in for the IP-echo websites?
//!
//! The node asks api.ipify.org (then checkip.amazonaws.com) for its public IPv4
//! every 5 minutes. Every DHT node that answers a query may say, in its answer's
//! `ip` field (BEP 42), the address it saw the query come from, and the DHT
//! client counts those as votes (`Info::public_address`). This probe asks:
//!
//!   1. how soon after start the DHT client has an address at all;
//!   2. whether its IP is the one the website gives (asked once, here only,
//!      to compare);
//!   3. whether it stays the same over a few minutes;
//!   4. whether the machine's NAT kept the DHT socket's port (it tells whether
//!      an outside port can be guessed from the local one).
//!
//! No address is printed: only yes or no, counts and seconds. The DHT bootstrap
//! hosts are the four the node already uses (External Infrastructure Register §3).

use std::collections::HashSet;
use std::net::Ipv4Addr;
use std::time::{Duration, Instant};

use n0_mainline::{Dht, Id};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const FIRST_VOTE_WAIT: Duration = Duration::from_secs(60);
const ROUNDS: usize = 24;
const ROUND_GAP: Duration = Duration::from_secs(10);
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let echo = match tokio::time::timeout(Duration::from_secs(10), echo_ipv4("api.ipify.org")).await {
        Ok(Ok(ip)) => Some(ip),
        _ => None,
    };
    println!("website answered: {}", if echo.is_some() { "yes" } else { "no (agreement cannot be checked)" });

    let start = Instant::now();
    let dht = Dht::builder().build()?;

    // 1. The first vote: the client's own bootstrap queries count, so look
    // every 250 ms from the start.
    let mut first: Option<f64> = None;
    while start.elapsed() < FIRST_VOTE_WAIT {
        if dht.info().await?.public_address().is_some() {
            first = Some(start.elapsed().as_secs_f64());
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    match first {
        Some(s) => println!("first DHT address after {s:.1} s"),
        None => println!("no DHT address within {} s", FIRST_VOTE_WAIT.as_secs()),
    }
    println!("bootstrapped: {}", dht.bootstrapped().await?);

    // 2-4. A query every ROUND_GAP for a few minutes, as the knock's lookups
    // would be, and what the client believes after each.
    let (mut same, mut differ, mut unknown, mut kept, mut moved) = (0, 0, 0, 0, 0);
    let mut ips: HashSet<Ipv4Addr> = HashSet::new();
    let mut ports: HashSet<u16> = HashSet::new();
    for round in 1..=ROUNDS {
        let began = Instant::now();
        let closest = tokio::time::timeout(QUERY_TIMEOUT, dht.find_node(Id::random())).await;
        let answered = matches!(&closest, Ok(Ok(nodes)) if !nodes.is_empty());
        let info = dht.info().await?;
        let at = start.elapsed().as_secs_f64();
        match info.public_address() {
            Some(addr) => {
                ips.insert(*addr.ip());
                ports.insert(addr.port());
                let agrees = echo.map(|e| e == *addr.ip());
                match agrees {
                    Some(true) => same += 1,
                    Some(false) => differ += 1,
                    None => {}
                }
                let port_kept = addr.port() == info.local_addr().port();
                if port_kept { kept += 1 } else { moved += 1 }
                println!(
                    "round {round:>2} at {at:>6.1} s: query answered {answered}; DHT address known; same IP as the website: {}; port kept: {port_kept}; firewalled: {}",
                    agrees.map(|b| if b { "yes" } else { "NO" }).unwrap_or("?"),
                    info.firewalled()
                );
            }
            None => {
                unknown += 1;
                println!("round {round:>2} at {at:>6.1} s: query answered {answered}; no DHT address");
            }
        }
        tokio::time::sleep(ROUND_GAP.saturating_sub(began.elapsed())).await;
    }

    println!("---");
    println!("SUMMARY first address: {}", first.map(|s| format!("{s:.1} s")).unwrap_or_else(|| "none".into()));
    println!("SUMMARY rounds with an address: {} of {ROUNDS}", ROUNDS - unknown);
    println!("SUMMARY same IP as the website: {same}, different: {differ}");
    println!("SUMMARY distinct IPs over the run: {}, distinct outside ports: {}", ips.len(), ports.len());
    println!("SUMMARY port kept by the NAT: {kept}, changed: {moved}");
    Ok(())
}

/// The website the node uses today, asked once to compare (plain HTTP/1.0).
async fn echo_ipv4(host: &str) -> anyhow::Result<Ipv4Addr> {
    let mut stream = tokio::net::TcpStream::connect((host, 80)).await?;
    let req = format!("GET / HTTP/1.0\r\nHost: {host}\r\nUser-Agent: probe\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).await?;
    let mut resp = Vec::new();
    stream.take(4096).read_to_end(&mut resp).await?;
    let text = String::from_utf8_lossy(&resp);
    let (_, body) = text.split_once("\r\n\r\n").ok_or_else(|| anyhow::anyhow!("malformed"))?;
    Ok(body.trim().parse()?)
}
