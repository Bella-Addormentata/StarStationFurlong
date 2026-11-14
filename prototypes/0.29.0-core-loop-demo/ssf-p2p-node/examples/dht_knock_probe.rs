//! DHT knock probe. A test tool, never part of the game: it lives on the
//! `claude/dht-knock-probe` branch, which is not to be merged.
//!
//! It answers two questions before any DHT knock is built into the node:
//!
//!  1. Can a computer announce the game's own UDP port at a shared meeting
//!     point on the Mainline DHT, and can another computer read it there?
//!  2. Can a holder behind a router open that router toward a knocker it knows
//!     only by address (the DHT gives an address, never a node id), so that
//!     the knocker's own dial, which does name the holder's node id, gets in?
//!
//! Roles (first argument):
//!
//!  - `dht <ip> <first_port> <count>`: a small private DHT of server nodes,
//!    for a lab with no route to the real one.
//!  - `holder <bootstrap|real> <punch|nopunch> <secret_hex|->`: binds the game
//!    port, announces at its door point, polls its knock point and (with
//!    `punch`) sends a dial under a made-up node id to every address it finds
//!    there. It accepts whoever connects.
//!  - `newcomer <bootstrap|real> <holder_id> <secret_hex|-> [wait_secs]`:
//!    binds the game port, reads the holder's address at the door point,
//!    announces at the knock point and dials the holder by its real node id.
//!  - `id <secret_hex>`: prints the node id of a secret, so two machines can
//!    agree on the holder's id from a shared seed.
//!  - `announce <bootstrap|real> <infohash_hex> <port>` and
//!    `peers <bootstrap|real> <infohash_hex> [wait_secs]`: the bare announce
//!    and lookup, for the real DHT.
//!
//! Addresses are printed cut short unless SSF_PROBE_FULL_ADDRS=1 (a lab with
//! made-up addresses sets it; a public runner log never should).

use std::collections::BTreeSet;
use std::net::{SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use iroh::endpoint::presets::Minimal;
use iroh::{Endpoint, EndpointAddr, PublicKey, SecretKey};
use n0_future::StreamExt;
use n0_mainline::{Dht, DhtBuilder, Id};
use sha2::{Digest, Sha256};

const ALPN: &[u8] = b"ssf-knock-probe";
/// The game's pinned UDP port (main.rs DEFAULT_IROH_PORT).
const GAME_PORT: u16 = 44442;

fn port_from_env() -> u16 {
    std::env::var("SSF_PROBE_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(GAME_PORT)
}

fn secs_from_env(name: &str, default: u64) -> Duration {
    Duration::from_secs(std::env::var(name).ok().and_then(|p| p.parse().ok()).unwrap_or(default))
}

/// An address for the log: whole in a lab, cut short anywhere public.
fn show(addr: impl Into<SocketAddr>) -> String {
    let addr: SocketAddr = addr.into();
    if std::env::var("SSF_PROBE_FULL_ADDRS").ok().as_deref() == Some("1") {
        return addr.to_string();
    }
    match addr {
        SocketAddr::V4(_) => format!("v4:{}", addr.port()),
        SocketAddr::V6(_) => format!("v6:{}", addr.port()),
    }
}

fn short(id: &PublicKey) -> String {
    id.to_string().chars().take(10).collect()
}

/// A meeting point: 20 bytes worked out from a tag and the holder's node id.
fn meeting_point(tag: &str, holder: &PublicKey) -> Id {
    let mut h = Sha256::new();
    h.update(b"ssf-dht-knock-probe/v1/");
    h.update(tag.as_bytes());
    h.update(holder.as_bytes());
    let digest = h.finalize();
    Id::from_bytes(&digest[..20]).expect("20 bytes")
}

fn secret_from_arg(arg: &str) -> Result<SecretKey> {
    if arg == "-" {
        return Ok(SecretKey::generate());
    }
    let bytes = hex::decode(arg).context("secret must be 64 hex digits or -")?;
    let bytes: [u8; 32] = bytes.try_into().map_err(|_| anyhow!("secret must be 32 bytes"))?;
    Ok(SecretKey::from_bytes(&bytes))
}

fn dht_client(bootstrap: &str) -> Result<Dht> {
    let mut b = DhtBuilder::default();
    if bootstrap != "real" {
        b.bootstrap(&[bootstrap]);
    }
    Ok(b.build()?)
}

async fn wait_bootstrapped(dht: &Dht, label: &str, t0: Instant) -> Result<()> {
    let ok = dht.bootstrapped().await.map_err(|_| anyhow!("dht actor gone"))?;
    let info = dht.info().await.map_err(|_| anyhow!("dht actor gone"))?;
    println!(
        "[{label}] t={:.1}s dht bootstrapped={ok} table={} firewalled={} public={} local_port={}",
        t0.elapsed().as_secs_f32(),
        info.routing_table_size(),
        info.firewalled(),
        info.public_address().map(show).unwrap_or_else(|| "unknown".into()),
        info.local_addr().port(),
    );
    Ok(())
}

async fn lookup(dht: &Dht, point: Id) -> Result<BTreeSet<SocketAddrV4>> {
    let mut found = BTreeSet::new();
    let mut stream = dht.get_peers(point).await.map_err(|_| anyhow!("dht actor gone"))?;
    while let Some(batch) = stream.next().await {
        found.extend(batch);
    }
    Ok(found)
}

async fn bind_game(secret: SecretKey) -> Result<Endpoint> {
    let port = port_from_env();
    let ep = Endpoint::builder(Minimal)
        .secret_key(secret)
        .alpns(vec![ALPN.to_vec()])
        .bind_addr(format!("0.0.0.0:{port}"))?
        .bind()
        .await?;
    Ok(ep)
}

/// Accept whoever connects, answer one ping, and say who it was. Runs on both
/// sides: the holder to take the knocker's dial, the newcomer because the real
/// node accepts too, and the holder's made-up-id dial lands on it.
async fn accept_loop(label: &'static str, ep: Endpoint, t0: Instant, exit_on_link: bool) {
    loop {
        let Some(incoming) = ep.accept().await else { return };
        let from = incoming.remote_addr();
        let accepting = match incoming.accept() {
            Ok(a) => a,
            Err(e) => {
                println!("[{label}] t={:.1}s inbound from {from:?} refused: {e}", t0.elapsed().as_secs_f32());
                continue;
            }
        };
        tokio::spawn(async move {
            match accepting.await {
                Ok(conn) => {
                    let who = conn.remote_id();
                    println!(
                        "[{label}] t={:.1}s LINKED-IN from node {} (id learned from the handshake)",
                        t0.elapsed().as_secs_f32(),
                        short(&who)
                    );
                    if let Ok((mut send, mut recv)) = conn.accept_bi().await {
                        let got = recv.read_to_end(64).await.unwrap_or_default();
                        let _ = send.write_all(b"pong").await;
                        let _ = send.finish();
                        println!("[{label}] t={:.1}s got {:?}, sent pong", t0.elapsed().as_secs_f32(), String::from_utf8_lossy(&got));
                    }
                    conn.closed().await;
                    if exit_on_link {
                        println!("[{label}] done");
                        std::process::exit(0);
                    }
                }
                Err(e) => {
                    let text = e.to_string();
                    let text: String = text.chars().take(90).collect();
                    println!("[{label}] t={:.1}s inbound handshake did not finish: {text}", t0.elapsed().as_secs_f32());
                }
            }
        });
    }
}

async fn run_dht(ip: &str, first_port: u16, count: u16) -> Result<()> {
    let mut nodes = Vec::new();
    for i in 0..count {
        let mut b = DhtBuilder::default();
        b.server_mode().port(first_port + i);
        if i == 0 {
            b.no_bootstrap();
        } else {
            b.bootstrap(&[format!("{ip}:{first_port}")]);
        }
        nodes.push(b.build()?);
    }
    for n in &nodes {
        let _ = n.bootstrapped().await;
    }
    println!("[dht] {count} server nodes up at {ip}:{first_port}..");
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

async fn run_holder(bootstrap: &str, punch: bool, secret: SecretKey) -> Result<()> {
    let t0 = Instant::now();
    let me = secret.public();
    let ep = bind_game(secret).await?;
    // Whole in a lab (its script reads this line to brief the newcomer); a
    // public log gets the short form, like every other id here.
    if std::env::var("SSF_PROBE_FULL_ADDRS").ok().as_deref() == Some("1") {
        println!("ID {me}");
    } else {
        println!("[holder] node {}", short(&me));
    }
    let door = meeting_point("door", &me);
    let knock = meeting_point("knock", &me);
    let dht = dht_client(bootstrap)?;
    wait_bootstrapped(&dht, "holder", t0).await?;

    tokio::spawn(accept_loop("holder", ep.clone(), t0, std::env::var("SSF_PROBE_STAY").is_err()));

    // The door point: "this holder is on now, at this address and port".
    let announce_every = secs_from_env("SSF_PROBE_ANNOUNCE_SECS", 20);
    {
        let dht = dht.clone();
        tokio::spawn(async move {
            loop {
                let started = Instant::now();
                match dht.announce_peer(door, Some(port_from_env())).await {
                    Ok(_) => println!("[holder] t={:.1}s announced at the door point in {:.1}s", t0.elapsed().as_secs_f32(), started.elapsed().as_secs_f32()),
                    Err(e) => println!("[holder] t={:.1}s door announce failed: {e}", t0.elapsed().as_secs_f32()),
                }
                tokio::time::sleep(announce_every).await;
            }
        });
    }

    // The knock point: whoever announced there wants in. The DHT gives an
    // address and a port, never a node id.
    let poll_every = secs_from_env("SSF_PROBE_POLL_SECS", 5);
    let life = secs_from_env("SSF_PROBE_LIFE_SECS", 240);
    let mut seen: BTreeSet<SocketAddrV4> = BTreeSet::new();
    while t0.elapsed() < life {
        let started = Instant::now();
        let found = lookup(&dht, knock).await?;
        for addr in &found {
            if seen.insert(*addr) {
                println!(
                    "[holder] t={:.1}s knock point lists {} (lookup took {:.1}s)",
                    t0.elapsed().as_secs_f32(),
                    show(*addr),
                    started.elapsed().as_secs_f32()
                );
            }
            if punch {
                // A dial under a made-up node id: it can never finish, and it
                // does not need to. Its first packets leave from the game port
                // toward the knocker, which is what opens this side's router.
                let ep = ep.clone();
                let target = EndpointAddr::new(SecretKey::generate().public()).with_ip_addr(SocketAddr::V4(*addr));
                let shown = show(*addr);
                tokio::spawn(async move {
                    let res = tokio::time::timeout(Duration::from_secs(4), ep.connect(target, ALPN)).await;
                    let how = match res {
                        Err(_) => "no answer in 4 s".to_string(),
                        Ok(Err(e)) => e.to_string().chars().take(70).collect(),
                        Ok(Ok(_)) => "CONNECTED under a made-up id (must never happen)".to_string(),
                    };
                    println!("[holder] t={:.1}s opening dial to {shown} ended: {how}", t0.elapsed().as_secs_f32());
                });
            }
        }
        tokio::time::sleep(poll_every).await;
    }
    println!("[holder] life over, nobody linked");
    std::process::exit(1);
}

async fn run_newcomer(bootstrap: &str, holder: PublicKey, secret: SecretKey, wait: Duration) -> Result<()> {
    let t0 = Instant::now();
    let me = secret.public();
    let ep = bind_game(secret).await?;
    println!("[newcomer] node {} looking for holder {}", short(&me), short(&holder));
    let door = meeting_point("door", &holder);
    let knock = meeting_point("knock", &holder);
    let dht = dht_client(bootstrap)?;
    wait_bootstrapped(&dht, "newcomer", t0).await?;
    tokio::spawn(accept_loop("newcomer", ep.clone(), t0, false));

    // 1. Where is the holder now? Its door point says.
    let mut holder_addrs: BTreeSet<SocketAddrV4> = BTreeSet::new();
    if let Ok(fixed) = std::env::var("SSF_PROBE_HOLDER_ADDR") {
        holder_addrs.insert(fixed.parse().context("SSF_PROBE_HOLDER_ADDR")?);
    }
    while holder_addrs.is_empty() && t0.elapsed() < wait {
        let started = Instant::now();
        holder_addrs = lookup(&dht, door).await?;
        if holder_addrs.is_empty() {
            tokio::time::sleep(Duration::from_secs(2)).await;
        } else {
            println!(
                "[newcomer] t={:.1}s door point lists {} address(es): {} (lookup took {:.1}s)",
                t0.elapsed().as_secs_f32(),
                holder_addrs.len(),
                holder_addrs.iter().map(|a| show(*a)).collect::<Vec<_>>().join(", "),
                started.elapsed().as_secs_f32()
            );
        }
    }
    if holder_addrs.is_empty() {
        println!("[newcomer] NO LINK: the door point stayed empty for {}s", wait.as_secs());
        std::process::exit(1);
    }

    // 2. Knock: announce the game port at the knock point, and keep it fresh.
    {
        let dht = dht.clone();
        let announce_every = secs_from_env("SSF_PROBE_ANNOUNCE_SECS", 20);
        tokio::spawn(async move {
            loop {
                let started = Instant::now();
                match dht.announce_peer(knock, Some(port_from_env())).await {
                    Ok(_) => println!("[newcomer] t={:.1}s announced at the knock point in {:.1}s", t0.elapsed().as_secs_f32(), started.elapsed().as_secs_f32()),
                    Err(e) => println!("[newcomer] t={:.1}s knock announce failed: {e}", t0.elapsed().as_secs_f32()),
                }
                tokio::time::sleep(announce_every).await;
            }
        });
    }

    // 3. Dial the holder by its real node id until it answers. A lab can hold
    //    the first dial back, so the holder's opening dial is the first packet
    //    between the two routers instead of this side's.
    let hold_back = secs_from_env("SSF_PROBE_DIAL_DELAY_SECS", 0);
    if !hold_back.is_zero() {
        println!("[newcomer] t={:.1}s holding the first dial back {}s", t0.elapsed().as_secs_f32(), hold_back.as_secs());
        tokio::time::sleep(hold_back).await;
    }
    let mut attempt = 0u32;
    while t0.elapsed() < wait {
        attempt += 1;
        let mut target = EndpointAddr::new(holder);
        for a in &holder_addrs {
            target = target.with_ip_addr(SocketAddr::V4(*a));
        }
        match tokio::time::timeout(Duration::from_secs(5), ep.connect(target, ALPN)).await {
            Ok(Ok(conn)) => {
                println!("[newcomer] t={:.1}s LINKED-OUT to the holder on attempt {attempt}", t0.elapsed().as_secs_f32());
                let (mut send, mut recv) = conn.open_bi().await?;
                send.write_all(b"ping").await?;
                send.finish()?;
                let got = recv.read_to_end(64).await?;
                println!("[newcomer] t={:.1}s holder answered {:?}", t0.elapsed().as_secs_f32(), String::from_utf8_lossy(&got));
                conn.close(0u32.into(), b"done");
                ep.close().await;
                std::process::exit(0);
            }
            Ok(Err(e)) => {
                let text: String = e.to_string().chars().take(70).collect();
                println!("[newcomer] t={:.1}s attempt {attempt} failed: {text}", t0.elapsed().as_secs_f32());
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
            Err(_) => println!("[newcomer] t={:.1}s attempt {attempt}: no answer in 5 s", t0.elapsed().as_secs_f32()),
        }
    }
    println!("[newcomer] NO LINK after {}s and {attempt} attempts", wait.as_secs());
    std::process::exit(1);
}

async fn run_announce(bootstrap: &str, point: Id, port: u16) -> Result<()> {
    let t0 = Instant::now();
    let dht = dht_client(bootstrap)?;
    wait_bootstrapped(&dht, "announce", t0).await?;
    let started = Instant::now();
    match dht.announce_peer(point, Some(port)).await {
        Ok(_) => println!("[announce] t={:.1}s announced port {port} in {:.1}s", t0.elapsed().as_secs_f32(), started.elapsed().as_secs_f32()),
        Err(e) => println!("[announce] t={:.1}s FAILED: {e}", t0.elapsed().as_secs_f32()),
    }
    // Stay up, re-announcing, so a second machine has time to look.
    let life = secs_from_env("SSF_PROBE_LIFE_SECS", 120);
    while t0.elapsed() < life {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let _ = dht.announce_peer(point, Some(port)).await;
    }
    Ok(())
}

async fn run_peers(bootstrap: &str, point: Id, wait: Duration, want_port: Option<u16>) -> Result<()> {
    let t0 = Instant::now();
    let dht = dht_client(bootstrap)?;
    wait_bootstrapped(&dht, "peers", t0).await?;
    let mut round = 0;
    while t0.elapsed() < wait {
        round += 1;
        let started = Instant::now();
        let found = lookup(&dht, point).await?;
        println!(
            "[peers] t={:.1}s round {round}: {} address(es) in {:.1}s: {}",
            t0.elapsed().as_secs_f32(),
            found.len(),
            started.elapsed().as_secs_f32(),
            found.iter().map(|a| show(*a)).collect::<Vec<_>>().join(", ")
        );
        if let Some(port) = want_port {
            if found.iter().any(|a| a.port() == port) {
                println!("[peers] FOUND an address with the announced port {port}");
                return Ok(());
            }
        } else if !found.is_empty() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    println!("[peers] NOT FOUND within {}s", wait.as_secs());
    std::process::exit(1);
}

fn point_from_hex(arg: &str) -> Result<Id> {
    let bytes = hex::decode(arg).context("infohash must be 40 hex digits")?;
    Id::from_bytes(&bytes).map_err(|_| anyhow!("infohash must be 20 bytes"))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| args.get(i).map(String::as_str).ok_or_else(|| anyhow!("missing argument {i}; see the file header"));
    match arg(0)? {
        "dht" => run_dht(arg(1)?, arg(2)?.parse()?, arg(3)?.parse()?).await,
        "id" => {
            println!("{}", secret_from_arg(arg(1)?)?.public());
            Ok(())
        }
        "holder" => run_holder(arg(1)?, arg(2)? == "punch", secret_from_arg(arg(3)?)?).await,
        "newcomer" => {
            let holder: PublicKey = arg(2)?.parse().map_err(|_| anyhow!("holder id does not parse"))?;
            let wait = Duration::from_secs(args.get(4).and_then(|s| s.parse().ok()).unwrap_or(90));
            run_newcomer(arg(1)?, holder, secret_from_arg(arg(3)?)?, wait).await
        }
        "announce" => run_announce(arg(1)?, point_from_hex(arg(2)?)?, arg(3)?.parse()?).await,
        "peers" => {
            let wait = Duration::from_secs(args.get(3).and_then(|s| s.parse().ok()).unwrap_or(120));
            let want_port = args.get(4).and_then(|s| s.parse().ok());
            run_peers(arg(1)?, point_from_hex(arg(2)?)?, wait, want_port).await
        }
        other => Err(anyhow!("unknown role {other}; see the file header")),
    }
}
