# Hole punch against GitHub's NAT: a home computer and a GitHub machine, 2026-11-16

> **What this is:** the record of the first link test between a home computer and a machine behind a NAT that gives every destination its own outside port (a GitHub-hosted Actions runner), the case the DHT knock ([#443](https://github.com/Bella-Addormentata/StarStationFurlong/pull/443)) had not met. It also checks the public IPv4 the node now takes from the DHT's votes ([#462](https://github.com/Bella-Addormentata/StarStationFurlong/pull/462)) on a real home router.
>
> **Result:** the knock always arrived. A link came when the home computer's router let it in (run 1), never when neither side's router would (run 1b), and, with the home computer as the guest, only once the guest dialed back to where the holder's opening came from ([#465](https://github.com/Bella-Addormentata/StarStationFurlong/pull/465), runs 2 and 3).
>
> **How to read it:** times are UTC. "Home" is the home computer, "GitHub" the runner. Computer names, IP addresses, invites and room keys are left out; node ids are cut short. Where a statement is an inference and not a log line, it says so.

## 1. The runs, in one table

| # | Holder / guest | Home's router | Code | Result | What the logs show |
|---|---|---|---|---|---|
| 1 | Home / GitHub | Opened a port for the node by itself (UPnP, iroh's port mapper): reachability "port-mapped" | main at `bf2b2efc` (v0.52.0) plus the probe's runner | **Linked** in 1 s, held 12 min | The guest's dial landed on attempt 1. No knock was needed. |
| 1b | Home / GitHub | Port mapper off (probe-only `SSF_NO_PORTMAP=1`), a fresh port: reachability "advertised" | probe `90c6c04e` | **No link** in 12 min | GitHub knocked twice, naming its own port (44452). Home saw the knock at 18:36:43, under a minute after GitHub's first dial, and held two 180 s openings toward that port; nothing came in. GitHub's 8 dials all timed out. |
| 2 | GitHub / Home | Port mapper on: "port-mapped" | probe `7bc53673` | **No link** in 15 min | Home knocked naming its router-mapped port. GitHub's opening dials reached Home 24 times (every 15 s, two holds), but an opening is built never to finish, and Home's 8 dials to GitHub's own port timed out. |
| 3 | GitHub / Home | Port mapper on: "port-mapped" | probe `a72ab22a` (the dial back, now #465) | **Linked** 33 s after the invite was opened, direct, no relay; held all 15 min | Home's knock was stored 7 s after its first dial. GitHub's second opening came in 19:13:00.9; Home logged "opened toward us from …:29731; dialing it back there" and its attempt 2 connected at 19:13:03.9. Port 29731 is in no invite: GitHub's mapping toward Home alone. |

## 2. What it shows

- **GitHub's NAT gives every destination its own outside port.** The knock names the port the node knows (its own, or the one its router mapped), which is not the one GitHub uses toward the other side. So an opening toward a GitHub knocker misses (run 1b), and a dial toward a GitHub holder's own port misses (run 2).
- **Home's router lets in only what it asked for, port by port** (inferred from run 1b: GitHub kept dialing during both 180 s openings, from the port its NAT picked, and nothing got in). With the port mapper off, a home computer behind such a router and a GitHub machine cannot link by the knock, in either direction: the side that must be reached never gets a packet from the right port.
- **A router that opens a port by itself makes the home computer reachable** (runs 1 and 3). Both runs in which it did linked, once the dial back existed.
- **The dial back covers "holder behind a per-destination NAT, guest reachable"**: the holder's opening arrives from its mapping toward the guest, and the guest's dial to that address goes out on the same pair of addresses, which both routers already let through.
- **The DHT's address was right on both machines.** Home's advertised IPv4, 3.0 s after start, was the same as the one its owner forwards by hand. GitHub's advertised IPv4 was the IP its packets came from at Home (run 3's dial-back address had the invite's IP).

## 3. Setup

- **Home:** Windows, a home connection with public IPv4 and IPv6. The installed game kept running beside the test, on its own ports; the test node used UDP 44452 (run 1), 44462 (1b) and 44472 (2, 3), WebTransport 4453 and API 8081, with `SSF_EXTERNAL_ADDRS` removed for that process only, the chain lane and mDNS off, no relay. Windows Firewall allowed the node's executable inbound.
- **GitHub:** a `ubuntu-22.04` hosted runner, node on UDP 44452, the same settings, the workflow on the probe branch `claude/hole-punch-probe` (never to merge). Its log is public, so every address was blanked, and the invite crossed only sealed (RSA-OAEP over a fresh AES-256 key) through the branch `claude/hole-punch-io`.
- **Each side:** the node, the page's dev server on loopback, and `scripts/drill-link.mjs` driving a headless browser as the one player.

Not run: two machines behind per-destination NATs, and a packet capture (no capture tool on either side).
