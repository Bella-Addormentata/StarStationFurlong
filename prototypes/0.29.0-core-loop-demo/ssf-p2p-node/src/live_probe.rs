//! LIVE PROBE, never to merge (branch `claude/testnet11-live-check`): the
//! node's own peer lane asked against real full nodes, testnet11's or, in a
//! `chia-mainnet` build started with `SSF_CHIA_NETWORK=mainnet`, mainnet's.
//! Reads only on either: nothing here holds a key or builds a spend, and no
//! wallet file is made. It is run by
//! `.github/workflows/testnet11-live-check.yml` and by nothing else: the test
//! is ignored, so no other run starts it.
//!
//! What it prints is public: block heights, counts of coins at the welcome
//! room's faucet dish (an address every build carries), counts of beacons,
//! and the lane's own lines about the full nodes it reached.

use crate::chia_chain::ChainAccess;
use crate::chia_faucet::{FaucetParams, Unspent};
use chia_protocol::Bytes32;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn say(t0: Instant, line: impl AsRef<str>) {
    println!("PROBE t+{:>4}s {}", t0.elapsed().as_secs(), line.as_ref());
}

/// Ask until an answer comes or `within` has passed. Each new failure text
/// is said once, with the try it came on.
async fn until<T, E, F, Fut>(t0: Instant, what: &str, within: Duration, mut ask: F) -> Option<T>
where
    E: std::fmt::Display,
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let start = Instant::now();
    let mut last = String::new();
    let mut tries = 0u32;
    loop {
        tries += 1;
        match ask().await {
            Ok(v) => {
                say(t0, format!("{what}: ANSWERED on try {tries}, {} s after the first ask", start.elapsed().as_secs()));
                return Some(v);
            }
            Err(e) => {
                let text = format!("{e:#}");
                if text != last {
                    say(t0, format!("{what}: try {tries} failed: {text}"));
                    last = text;
                }
                if start.elapsed() > within {
                    say(t0, format!("{what}: GAVE UP after {tries} tries and {} s", start.elapsed().as_secs()));
                    return None;
                }
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "live: asks real full nodes; the live-check workflow runs it by name"]
async fn live_reads() {
    let t0 = Instant::now();
    let net = crate::chia_network::net();
    say(t0, format!("network: {}", net.name()));
    let carrier = crate::chia_chain::connect_carrier();
    let money = crate::chia_chain::connect();
    let wait = Duration::from_secs(300);

    // 1. The first reachable peer (the presence lane's trust).
    let carrier_peak = until(t0, "carrier peak (first reachable peer)", wait, || carrier.peak_height()).await;
    // 2. Two agreeing peers (the money paths' trust).
    let money_peak = until(t0, "money peak (two agreeing peers)", wait, || money.peak_height()).await;
    if let Some(peak) = money_peak.or(carrier_peak) {
        let era = crate::chia_lane::era_of(peak);
        let into = peak % crate::chia_lane::ERA_BLOCKS;
        say(t0, format!("peak {peak}: edition {era}, {into} blocks in, {} to go", crate::chia_lane::ERA_BLOCKS - into));
    }

    // 3. The welcome room's faucet dish, through each handle.
    let lobby = FaucetParams::lobby(net);
    for (name, handle) in [("money", &money), ("carrier", &carrier)] {
        let listed = until(t0, &format!("lobby dish listing ({name})"), wait, || crate::chia_faucet::records_at(handle, lobby.puzzle_hash())).await;
        let Some((records, partial)) = listed else { continue };
        let unspent = Unspent::of(&records, partial);
        let spent = records.iter().filter(|r| r.spent).count();
        let mojos: u64 = unspent.coins.iter().map(|c| c.coin.amount).sum();
        let peak = money_peak.or(carrier_peak).unwrap_or(0);
        let ready = unspent.coins.iter().filter(|c| c.ready(&lobby, peak)).count();
        let claimable = unspent.coins.iter().filter(|c| c.claimable(&lobby)).count();
        let heights: Vec<u32> = unspent.coins.iter().map(|c| c.confirmed_height).collect();
        say(
            t0,
            format!(
                "lobby dish ({name}): {} records ever, {spent} spent, {} unspent ({claimable} claimable, {ready} ready at peak {peak}), {mojos} mojos unspent, partial listing: {partial}, unspent confirmed at heights {:?}",
                records.len(),
                unspent.coins.len(),
                heights.iter().take(12).collect::<Vec<_>>()
            ),
        );
    }

    // 4. Beacons, this edition and the last, and the raw records under each hint.
    if let Some(peak) = carrier_peak.or(money_peak) {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        match crate::chia_resolve::read_beacons(net, &carrier, peak, now).await {
            Ok(found) => say(t0, format!("beacons a newcomer would read now: {}", found.len())),
            Err(e) => say(t0, format!("beacons: read failed: {e:#}")),
        }
        let era = crate::chia_lane::era_of(peak);
        for e in [era, era.saturating_sub(1)] {
            let hint = Bytes32::new(crate::chia_lane::derive_beacon_hint(net, e));
            match carrier.coin_records_by_hint(hint, None, true, None).await {
                Ok(page) => say(t0, format!("beacon hint of edition {e}: {} records on the first page, truncated: {}", page.records.len(), page.truncated)),
                Err(e2) => say(t0, format!("beacon hint of edition {e}: lookup failed: {e2}")),
            }
        }
    }

    // 5. A hint nobody uses: an empty answer, not an error.
    let nobody = Bytes32::new(*blake3::hash(format!("ssf live probe, a hint nobody uses, {:?}", SystemTime::now()).as_bytes()).as_bytes());
    match carrier.coin_records_by_hint(nobody, None, true, None).await {
        Ok(page) => say(t0, format!("a hint nobody uses: {} records (0 expected), truncated: {}", page.records.len(), page.truncated)),
        Err(e) => say(t0, format!("a hint nobody uses: lookup failed: {e}")),
    }

    // 6. Watch the peak for eight minutes through both handles.
    let watch = Instant::now();
    let (mut asks, mut carrier_fail, mut money_fail, mut behind) = (0u32, 0u32, 0u32, 0u32);
    let (mut first, mut last_seen, mut moves) = (None::<u32>, None::<u32>, 0u32);
    while watch.elapsed() < Duration::from_secs(480) {
        asks += 1;
        let c = carrier.peak_height().await;
        let m = money.peak_height().await;
        match (&c, &m) {
            (Ok(c), Ok(m)) if m + 3 < *c || c + 3 < *m => {
                behind += 1;
                say(t0, format!("the two handles differ: carrier {c}, money {m}"));
            }
            _ => {}
        }
        if let Err(e) = &c {
            carrier_fail += 1;
            say(t0, format!("watch: carrier peak failed: {e}"));
        }
        if let Err(e) = &m {
            money_fail += 1;
            say(t0, format!("watch: money peak failed: {e}"));
        }
        if let Ok(h) = m.or(c) {
            first.get_or_insert(h);
            if last_seen != Some(h) {
                moves += 1;
                last_seen = Some(h);
            }
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
    let secs = watch.elapsed().as_secs();
    match (first, last_seen) {
        (Some(a), Some(b)) if b > a => {
            say(t0, format!("watch: {asks} asks in {secs} s, peak {a} to {b} ({} blocks, {:.1} s a block, seen to move {moves} times)", b - a, secs as f64 / (b - a) as f64))
        }
        (a, b) => say(t0, format!("watch: {asks} asks in {secs} s, peak {a:?} to {b:?}, no movement measured")),
    }
    say(t0, format!("watch: carrier failures {carrier_fail}, money failures {money_fail}, times the handles differed by more than 3 blocks {behind}"));

    say(t0, format!("VERDICT carrier peak: {}, money peak: {}", carrier_peak.is_some(), money_peak.is_some()));
    assert!(carrier_peak.is_some(), "the lane reached no full node");
    assert!(money_peak.is_some(), "the lane found no two agreeing full nodes");
}
