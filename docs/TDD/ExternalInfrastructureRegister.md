# External Infrastructure Register

> **Purpose:** the one date-stamped list of every outside host, service or network a shipped Star Station Furlong build can contact, with the class each falls in: being removed, exempt, optional, or local. **The principle it serves (Dorkmo, 2026‑10‑12):** the station relies on no central infrastructure such as websites. Rulings it inherits: the serverless-sources ruling of 2026‑10‑04 (the convenience lanes are off by default, [sovereignty.ts](../../prototypes/0.29.0-core-loop-demo/src/sovereignty.ts)) and [#231 D1](https://github.com/Bella-Addormentata/StarStationFurlong/issues/231) of 2026‑10‑11 (peer-protocol chain access, [sovereign plan §14](../../brainstorming/sovereign-treasury-serverless-plan.md)).
>
> **Owner:** whoever touches a row's code. **Rule:** a change that makes a build contact a new host, or changes a row's default, updates this file in the same PR and names the row in the PR description; a row that owes work points at its TODO item. **Re-verify** every row with the commands in §6 before each release and stamp the Checked column.

## 1. The classes

- **Being removed** — a dependency that breaks the principle. The row stays until no shipped code names the host, then moves to §7.
- **Exempt** — central infrastructure the project accepts, each with the condition that makes it acceptable (bootstrap only, build machine only, distribution only) and the sovereign upgrade that would retire it.
- **Optional** — off by default. The row says who turns it on (a build flag, an operator's environment variable, a room owner, a viewer's consent) and what the player sees. A peer's record can never turn a lane on.
- **Local** — not central at all (the LAN, the player's own router, loopback). Listed so nobody mistakes them for third parties.

Paths below are relative to the repository root; line numbers are those of main `97c10988` on 2026‑10‑12.

## 2. Being removed

| Host(s) | What contacts it, and when | Default today | Off switch | Work | Checked |
|---|---|---|---|---|---|
| `testnet11.api.coinset.org` (Chia HTTPS gateway, `chia-sdk-coinset` 0.34.0 `CoinsetClient::testnet11()`) | `ssf-p2p-node`: every chain read and push — the presence reader ([chia_resolve.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/chia_resolve.rs#L321)), the beat watcher ([chia_watch.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/chia_watch.rs#L222), one peak call a minute, hint reads on the block beat), the publisher ([chia_publish.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/chia_publish.rs#L1011)), the faucet dish ([chia_faucet.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/chia_faucet.rs#L433), status every 20 s while its screen is open) and the craps fairness records ([chia_craps_fair.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/chia_craps_fair.rs#L167), [chia_craps_fair.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/chia_craps_fair.rs#L199)): six call sites in five components | On in every build (chain reads are on by default since D3) | `SSF_CHIA_WATCH=0` stops the watcher only; reads and the faucet still use it | [TODO: Remove the coinset.org dependency from the chain lane](../../TODO.md): §14 errata, then S‑0 phase 0 (the chain-access seam), then the peer lane; the gateway client is removed outright, no fallback (Dorkmo, 2026‑10‑12) | 2026‑10‑12 |
| `api.ipify.org`, `checkip.amazonaws.com` (public-IP echo) | `ssf-p2p-node`: an HTTPS GET at startup and every 5 minutes to learn the public IPv4 it advertises in invites ([main.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/main.rs#L709), [main.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/main.rs#L881), [main.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/main.rs#L1055)) | On: an unset `SSF_EXTERNAL_ADDRS` means `auto` (the R1 "as easy as possible" flip of the 0.22 line) | `SSF_EXTERNAL_ADDRS=off`; own hosts with `SSF_IP_ECHO=host1,host2` | [TODO: Retire the public-IP echo websites](../../TODO.md): advertise the address iroh discovered itself (port mapper, QAD-observed), then the hub-observed address of #231 P5 | 2026‑10‑12 |

## 3. Exempt, with the condition that makes each acceptable

| Host(s) | What contacts it, and when | Condition | Off switch | Sovereign upgrade | Checked |
|---|---|---|---|---|---|
| Mainline DHT bootstrap nodes: `router.bittorrent.com:6881`, `dht.transmissionbt.com:6881`, `dht.libtorrent.org:25401`, `relay.pkarr.org:6881` (the defaults of `n0-mainline` 0.5.0) | `ssf-p2p-node` at startup, to join the BitTorrent Mainline DHT where it publishes and resolves node addresses ([main.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/main.rs#L955), `iroh-mainline-address-lookup` 0.4) | Bootstrap only: they introduce the node to the DHT and carry nothing afterwards. The sovereign plan accepts exactly this class ([§6](../../brainstorming/sovereign-treasury-serverless-plan.md)) | `SSF_NO_DHT=1` | Persisted known-good DHT peers; contact nodes advertised through the peer store or a signed contact-card field | 2026‑10‑12 |
| Chia DNS introducers (planned with S‑0) | The node's peer-protocol chain lane, to find full-node peers | The same bootstrap class; `RequestPeers` gossip afterwards; a configured pin is always consulted ([plan §14 (1)](../../brainstorming/sovereign-treasury-serverless-plan.md)) | `SSF_CHIA_PEERS` pins bypass them | Full nodes run by contacts or room members, advertised through the peer store | planned |
| Build-time registries: crates.io, npm, and for the arcade the EmulatorJS GitHub tag plus `cdn.emulatorjs.org` through [scripts/fetch-emulatorjs.mjs](../../prototypes/0.29.0-core-loop-demo/scripts/fetch-emulatorjs.mjs) (pinned `EJS_VERSION`, `EJS_CDN` override) | The build machine only, never a running station: the fetched EmulatorJS lands in `public/emulatorjs/` and is served from the station itself | Pinned versions, absent from a running station's traffic | n/a | `cargo vendor` and F‑Droid reproducibility ([TODO: Recurring / process](../../TODO.md)) | 2026‑10‑12 |
| GitHub (source, CI, Releases) | Distribution of the installers and `ssf-p2p-node.exe` by [release.yml](../../.github/workflows/release.yml). Nothing in a running station contacts GitHub: `tauri.conf.json` has no updater endpoint | Distribution only | n/a | F‑Droid and mirrorable, signed release artifacts ([TODO: F-Droid + license audit](../../TODO.md)) | 2026‑10‑12 |
| The Chia network itself (testnet11 now, mainnet behind the §7 privacy gate) | Full-node peers, once S‑0 lands | A public peer network, not a website; every claim from it carries a §14 (3) trust label | `SSF_CHIA_WATCH=0` | — | 2026‑10‑12 |

## 4. Optional, off by default

| Lane | Hosts | Who turns it on | What the player sees | Checked |
|---|---|---|---|---|
| Convenience lanes: the smart TV's YouTube, archive.org and third-party-server links; the arcade cabinet's EmulatorJS CDN | `www.youtube.com`, `www.youtube-nocookie.com`, `archive.org` ([tvConsent.ts](../../prototypes/0.29.0-core-loop-demo/src/tvConsent.ts#L51)); `cdn.emulatorjs.org` ([arcadeEmulator.ts](../../prototypes/0.29.0-core-loop-demo/src/arcadeEmulator.ts#L75)) | The build first: `VITE_SSF_CONVENIENCE_LANES=1` ([sovereignty.ts](../../prototypes/0.29.0-core-loop-demo/src/sovereignty.ts#L26)); then the room owner, per set or cabinet (the cabinet's default is the station's own copy, [arcadeDoc.ts](../../prototypes/0.29.0-core-loop-demo/src/arcadeDoc.ts#L203)); then, for the TV, each viewer's consent per origin and session ([tvConsent.ts](../../prototypes/0.29.0-core-loop-demo/src/tvConsent.ts)). A peer's record naming a lane this build lacks plays nothing | "this build plays serverless sources only"; a cabinet without the station's own EmulatorJS shows NOT PROVISIONED and the fetch command | 2026‑10‑12 |
| Operator relays | Whatever `SSF_RELAYS` names | The operator, by environment variable ([main.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/main.rs#L944)). None ship by default: iroh is built with `default-features = false` and the `Minimal` preset, which starts with relays disabled and no n0 address lookup (iroh 1.0.1, `Builder::empty()`), so neither n0's relays nor `dns.iroh.link` are ever contacted | The Bridge row names the relay lane | 2026‑10‑12 |
| Own public-IP echo | `SSF_IP_ECHO=host1,host2` | The operator; relevant only until the echo retires (§2) | — | 2026‑10‑12 |
| Explicit advertised addresses | none: a literal `ip:port` | `SSF_EXTERNAL_ADDRS=203.0.113.5:4443` | — | 2026‑10‑12 |
| Chia peer pins (planned with S‑0) | The operator's own full node | `SSF_CHIA_PEERS` | Claims it backs alone carry the trusted-node label | planned |

## 5. Local, not central

| Mechanism | Talks to | Default | Off switch |
|---|---|---|---|
| mDNS address lookup (`iroh-mdns-address-lookup` 0.4) | The LAN | On ([main.rs](../../prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/main.rs#L1170)) | `SSF_NO_MDNS=1` |
| Port mapper (UPnP / NAT‑PMP / PCP, iroh's `portmapper` feature) | The player's own router | On | none |
| The node's HTTP API and WebTransport (`wtUrl`) | Loopback: the browser and its own node | On | — |
| Room sync (Yjs over the mesh), ticks, the hub relay | Room peers | On | — |

## 6. How to re-verify

Run from the repository root; every hit must have a row above.

```sh
# every URL or hostname in the node
grep -n -o -E 'https?://[^" )]+|[a-z0-9-]+[.](org|com|net|io|link|computer)' prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src/*.rs
# the gateway call sites (must be empty once §2's first row has moved to §7)
grep -rn 'CoinsetClient::' prototypes/0.29.0-core-loop-demo/ssf-p2p-node/src
# every external host the browser can reach at runtime
grep -rn -o -E 'https?://[A-Za-z0-9./_-]+' prototypes/0.29.0-core-loop-demo/src --include='*.ts' | grep -v '[.]test[.]ts'
# the desktop shell: no updater endpoint, no remote URLs
grep -n -i 'updater\|endpoints\|https\?://' prototypes/0.29.0-core-loop-demo/src-tauri/tauri.conf.json
# what iroh does when the node configures nothing (expect RelayMode::Disabled, no address lookup)
grep -n -B1 -A3 'pub fn empty()' ~/.cargo/registry/src/*/iroh-1.*/src/endpoint.rs
```

A packet capture of a default node at startup and across one 5-minute re-check is the end-to-end check: after §2 is done it shows DHT bootstrap traffic, mDNS, the router, peers, and nothing else.

## 7. Removed

| Host | Removed in | Note |
|---|---|---|
| — | — | Nothing yet; the two rows of §2 land here when their TODO items close. |
