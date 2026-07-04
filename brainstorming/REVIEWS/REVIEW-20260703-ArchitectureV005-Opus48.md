# Review of STUDY-Architecture v005 (+ Phase 1 / Phase 2 Execution Plans)
**Date:** 2026-07-04
**Evaluator:** Claude Opus 4.8 (GitHub Copilot)
**Focus:** Correctness of v005's load-bearing library claims, node buildability, secure-context and market-latency pitfalls, browser capabilities, locked-network circumvention, trust & safety, and concrete de-risking for the spiked/blocking items.

Companion to [STUDY-Architecture v005](../AI%20BRAINSTORMING/STUDY-Architecture%20v005.md), the [Phase 1](../../docs/TDD/03-Implementation/Phase1-ExecutionPlan.md) and [Phase 2](../../docs/TDD/03-Implementation/Phase2-ExecutionPlan.md) execution plans, and my earlier [v004 review](REVIEW-20260703-ArchitectureV004-Opus48.md). Grounded in Issues [#1](https://github.com/Bella-Addormentata/StarStationFurlong/issues/1) (rooms/companies/markets/blockchain custody) and [#12](https://github.com/Bella-Addormentata/StarStationFurlong/issues/12) (QR phone chat), and primary-source checks dated **2026-07-04**.

---

## 1. Executive Verdict

**v005 is the strongest document in the series and its central move is correct.** The "Runtime Gap" insight — that Cabal/Hypercore/Autobase are JavaScript-only and cannot ship inside a Rust/Tauri node — is real, was genuinely missed by all four v004 reviews (mine included), and the resolution (realize the *model* on Rust-native crates behind a swappable `RoomLog` port) is the right call. I re-verified every load-bearing library claim against primary sources; **most hold, and the plan is buildable as written.**

But the verification discipline v005 preaches must be turned back on v005 itself, and doing so surfaces one stale fact, one understated risk, and several new pitfalls the document's own principles should have caught:

1. **iroh reached 1.0 (now 1.0.1, June 2026)** — v005's `iroh = "0.9x"` pins and "vendor-optimistic, treat as pre-1.0" hedge are already out of date. Good news, but proof the ledger rots (v005's own §3.2 lesson) even for the crates it just picked.
2. **p2panda's own README states the library is "not stable for production use… APIs may still undergo breaking changes."** v005's P-2 acknowledges this but *understates* it: the entire durable-social-state layer — the reason the game persists — would rest on a **pre-1.0, ~2-maintainer, EU-grant-funded research library** (v0.6.1, 501 stars, 14 contributors). This is the single biggest program risk and deserves a louder mitigation than a footnote.
3. **Station-in-a-Box has a secure-context blocker, not a "wrinkle."** A PWA served over `http://` from a LAN IP is **not a secure context**, so WebTransport, OPFS, Service Workers, and `storage.persist()` all silently fail. v005 flags "page-level TLS" as an open item but files it under UX; it is actually load-bearing for the whole LAN-sovereign story (§4.3).
4. **Positions are being written into synced/persisted structures in two places** — Phase 1 routes 20 Hz movement through Yjs **Awareness** and Phase 2 writes orbital `anomaly` into a CRDT `Y.Map` "each tick." Both are the exact anti-pattern v005 §9 and my v004 review §6 warned against. (§4.1, §4.2)
5. **"Live call-out markets" (Issue #1) collide with 18-second Chia finality and mempool front-running.** Chia offer files are a superb *settlement* primitive but a poor *continuous order book*; the plan needs an explicit two-tier market or it will feel broken for the NYSE/CBOE fantasy. (§4.5)

None of these sink the architecture. All are fixable, and §10 proposes concrete de-risking for every blocking/spiked item. **Recommendation: accept v005 as the blueprint, adopt the five corrections in §11, and gate Sprint-3 on the "five crates compile for Android together" spike before anything else.**

---

## 2. Sources & Verification Discipline

Re-checked against primary sources on **2026-07-04** (one day after v005):

| Source | Checked | Result |
|---|---|---|
| github.com/p2panda/p2panda + p2panda.org | crates, license, release, stability banner, contributors | v0.6.1 (2026-05-22); **MIT OR Apache-2.0** ✅; **README: "not yet considered stable for production use"**; 501★, 14 contributors, active (commits 4 days ago); Toolkitty + Dash Chat are real Tauri apps ✅ |
| iroh.computer/blog + docs.iroh.computer | version, browser, relays, discovery, Tor, FROST, ESP32 | **iroh 1.0 (2026-06-15), 1.0.1 (06-29)** — v005's `0.9x` is stale; first-party Swift/Kotlin/Python/JS bindings (06-18); self-host relays ✅; Mainline DHT ✅; Tor custom transport ✅; **runs on ESP32** ✅; PQ handshakes ✅ |
| docs.rs/yrs + crates.io/yrs | `yrs::sync`, Awareness, protocol | **Confirmed** ✅ — `sync::{Awareness, AwarenessUpdate, DefaultProtocol, Message, SyncMessage, Protocol, MessageReader}`; v0.27.2, MIT, 1.88M downloads, maintained by Yjs author (dmonad) + Horusiath. Caveat: "ongoing process of reaching feature compatibility with Yjs" — the conformance spike is genuinely required |
| github.com/xch-dev/chia-wallet-sdk + crates.io | WASM bindings, drivers, maturity | `wasm/`, `napi/`, `pyo3/`, `bindings/` dirs exist ✅; "Solomons Lot sponsored the WASM bindings" ✅; Apache-2.0; **but `wasm/` last touched ~6 months ago while core moved 3 weeks ago** — the browser path may lag the Rust crate (§3.4) |
| MDN WebTransport / Chrome LNA | re-affirm v005 §3.1–3.3 | WebTransport Baseline 2026 ✅; LNA gates WT from Chrome 147 ✅; Chrome has no `WebTransport.getStats()` ✅ — all three v005 platform claims still hold |
| Repo Issues #1, #12 | game intent | v005's market/rooms/QR framing is faithful to both issues ✅ |

Claims I could **not** independently confirm to primary-source standard are tagged **[UNVERIFIED]** and treated as spikes, per v005's own discipline (and my methodology): a plausible mechanism is not a verified one.

---

## 3. Verification Ledger — Errors & Confirmations

### 3.1 ❌ Stale: iroh is 1.0, not `0.9x`

iroh shipped **1.0 on 2026-06-15** and **1.0.1 on 2026-06-29** ("Just Boring" — the stability signal). v005 §6/§12.1 pins `iroh = "0.9x"` and hedges its "9-out-of-10 direct connections" number as "vendor-optimistic, treat as pre-1.0." That hedge is now wrong in the *good* direction: iroh is a 1.0 stack with a public API-stability commitment, first-party Swift/**Kotlin (Android)**/Python/JS bindings (2026-06-18), post-quantum handshakes, and a documented Tor transport. **Fix:** pin `iroh = "1"`, re-run the connectivity number against v005's own locked-network matrix (§10 spike), and note the 1.0 API-stability guarantee materially de-risks the "consolidate on iroh" bet relative to how v005 framed it. This is the rare correction that makes the plan *safer*.

### 3.2 ⚠️ Understated: p2panda is explicitly "not production-ready"

v005 leans the entire durable-social-state layer on p2panda and files the risk under P-2 ("pre-1.0; pin versions; wrap behind `RoomLog`"). The primary source is blunter than v005's phrasing:

> 🚧 "This library is under active development and the APIs are not yet considered stable for production use. Core data types and user-facing APIs may still undergo breaking changes. Stability guarantees will improve with the release of v1.0.0." — p2panda README, verified 2026-07-04.

Combined facts: **v0.6.1**, **14 contributors dominated by two people** (adzialocha, sandreae), **EU-grant-funded research cadence**, and `p2panda-spaces`/`p2panda-encryption` are the *newest and least-settled* crates — which is exactly where v005 puts room E2EE. This is not a footnote-severity risk; it is the program's largest single dependency bet, and it is on the critical path for the game's core promise (persistent social spaces). See §10 P-2 for a concrete insurance plan. **The good news v005 states is real** — the crate *model* maps 1:1 onto the reviews' asks, it is MIT/Apache-2.0, and Toolkitty + Dash Chat prove it runs in shipping Tauri mobile apps. The risk is *stability and bus factor*, not *fit*.

### 3.3 ✅ Confirmed and load-bearing: yrs hosts y-sync + Awareness in Rust

v005's §3.6 is the fact that makes the "one runtime" node real, and it checks out precisely: `yrs::sync` re-exports `Awareness`, `AwarenessUpdate`, `DefaultProtocol`, `Message`, `SyncMessage`, the `Protocol` trait, and `MessageReader`. yrs is maintained by the Yjs author himself, 1.88M downloads, MIT. **Caveat to carry:** crates.io still says "ongoing process of reaching feature compatibility with Yjs," so the browser-Yjs ⇄ node-yrs conformance spike (v005 #5) is not optional — subdoc + awareness-churn + v1/v2 update-format parity must be proven, not assumed.

### 3.4 ⚠️ Nuance: chia-wallet-sdk WASM bindings may lag the Rust crate

The repo confirms `wasm/`, `napi/`, `pyo3/`, and `bindings/` directories and an explicit "Solomons Lot sponsored the WASM bindings" credit — so v005's §3.7 "Rust + browser WASM" claim is directionally true. **But** the `wasm/` directory's last commit is ~6 months old ("Bump to 0.33.0") while the rest of the SDK moved 3 weeks ago, and crates.io `chia-wallet-sdk 0.33.0` is 6 months stale relative to the repo `main`. Implication: the specific drivers v005 name-checks for the *browser* (Vaults/MIPS, Bulletin, XCHandles, Offers) must be verified as **actually exposed through the current WASM binding**, not just present in the Rust core. **[UNVERIFIED]** per-driver WASM surface — fold into the §10 P-9 go/no-go spike. This *reinforces* v005's standing caveat that the browser light-verification path is unproven.

### 3.5 ✅ Confirmed: the Runtime Gap thesis and the ecosystem facts

p2panda "broadcast-only… shortwave, packet radio, BLE, LoRa or a USB stick" (verified verbatim) validates the store-and-forward floor; iroh runs on **ESP32** (verified blog) which I turn into a concrete outside-the-box proposal (§7.1); iroh has a **FROST threshold-signature** history and **Tor custom transport** (both verified), which I turn into improvements for Station Seals and censorship posture. The Autobase-is-JS premise is consistent with everything observed (Holepunch ships JS/Bare; no maintained Rust Autobase exists), so v005's central pivot stands.

---

## 4. Critical Pitfalls (new, beyond v005's own registry)

### 4.1 Movement over Yjs Awareness is a bandwidth/perf anti-pattern

Phase 1 Task 3.2 says "remote players: position updates via **awareness** at 20 Hz." Yjs/`y-protocols` Awareness broadcasts the **entire local client state** on every change and fans it out O(peers); it was designed for *discrete* presence (cursor, name, status), not a 20 Hz continuous position stream. Running movement through it defeats the whole point of the 13-byte hand-packed datagram tick that the *same* task also specifies — the two mechanisms are in tension and the doc never resolves which carries position.

**Fix (and it's the design v005 §9 already implies):** continuous position rides the **raw datagram tick** (unreliable, 13 bytes, client-predicted, interpolated); Awareness carries only **discrete presence** (joined/left, display name, "typing", speaking-flag) at human rates. Write this split explicitly into [YjsSync.ts](../../prototypes/01-core-loop-demo/src/network/YjsSync.ts) and Phase 1 Task 3.2/3.3 so the implementer doesn't wire 20 Hz positions into Awareness by default.

### 4.2 Phase 2 writes orbital position into the persisted CRDT "each tick"

[Phase2-ExecutionPlan.md](../../docs/TDD/03-Implementation/Phase2-ExecutionPlan.md) `StationOrbit.anomaly` is documented as "current true anomaly (radians); **updated each tick**" inside a synced `Y.Map`. That is the identical anti-pattern to putting avatar positions in the persisted doc — a continuously-changing value written into a durable CRDT produces unbounded update history, tombstone bloat, and cross-peer merge churn for a value that is *deterministically computable*.

**Fix:** store only the **static orbital elements** (`orbitType`, `semiMajorAxis`, `eccentricity`, `epoch`, `meanAnomalyAtEpoch`, parent-body IDs) in the CRDT; **compute the live anomaly from `(now − epoch)` each frame** locally. This also fixes a latent determinism bug (see §4.3). Only *station-keeping burns* (discrete events) mutate the CRDT.

### 4.3 Client-side orbital mechanics needs a deterministic clock and math contract

If two peers each compute a station's L4 position or Keplerian anomaly from local floating-point and local wall-clock, they will **visually diverge** (float rounding + clock skew). Phase 2 treats the map position as derived but never specifies a determinism contract.

**Fix:** define a fixed simulation epoch + integer tick, a specified float profile (or fixed-point) for orbital math, and derive all map positions from `tick` — not from `Date.now()`. This is cheap now and painful to retrofit once ships and freight depend on where a station "actually" is.

### 4.4 Station-in-a-Box: `http://` LAN origin is not a secure context (blocker, not wrinkle)

v005 §12.6 is a genuinely great idea, but its "one open wrinkle… page-level TLS for the LAN origin" undersells a hard platform rule: **WebTransport, OPFS, Service Workers, `storage.persist()`, and WebCrypto all require a secure context**, and a page served over `http://192.168.x.x` or `http://box.local` is **not** one (only `https://`, `localhost`, and `file://` qualify). So the captive-portal PWA served over plain HTTP from the box **cannot open a WebTransport session at all**, cannot persist to OPFS, and cannot install a Service Worker — the entire client breaks, not just first-load UX.

**This turns the "LNA never fires because we serve from the LAN" argument into a trap:** you dodge the LNA prompt only by giving up the secure context you need. Concrete resolutions, in order of sovereignty (all belong in the §10 spike):
- **Native/Tauri client on the LAN** — no browser secure-context rule applies; the box's node is dialed directly. This is the honest primary answer and should be stated as such.
- **Ship the box with a real domain + a pre-provisioned cert** the box serves over HTTPS (e.g., a `*.stationfurlong.example` wildcard baked into the image, DNS answered by the box itself for its own name). Reintroduces a bounded PKI dependency but keeps browsers working offline.
- **Local CA the user installs once** (mkcert-style) — good for LAN parties/classrooms, poor for drive-by phones.
- **Isolated Web App** distribution (§6.1) — the emerging clean answer, Chromium-only today.

### 4.5 "Live call-out markets" vs 18-second finality + mempool racing

Issue #1 explicitly wants "dedicated live call-out markets like NYSE or CBOE." v005 §10's "order book = gossiped Chia offer files" is the right *settlement* primitive but a poor *continuous market*:
- **Latency:** Chia targets ~18–52 s to finality. A "live" trading floor cannot settle at that cadence.
- **Static prices:** an offer file is a fixed-price take-it-or-leave-it instrument; a real order book needs continuous bid/ask, partial fills, and cancellation. Cancelling a Chia offer means **spending the coin** (mojo cost + latency).
- **Front-running:** takes are on-chain transactions; a watcher can observe a pending take in the mempool and race it. v005's "chain picks exactly one winner" is true but the *loser wasted a real transaction*, and MEV-style ordering games are possible.

**Fix — two-tier markets, stated explicitly:**
- **Price discovery / "the floor"** = an **off-chain, host-sequenced matched order book** (maker/taker intents in RoomLog, station market-host assigns a total order, signed receipts). Fast, cancellable, supports continuous quotes. This is the NYSE/CBOE feel.
- **Settlement** = periodic netting to Chia (offer files / vault spends) for the value that actually crosses custody boundaries, and raw offer files reserved for high-value P2P/inter-station trades where trustless atomicity matters more than speed.
This preserves sovereignty (the station's own market host is player-run; anyone can run a competing floor) while matching the fiction. It also directly answers Issue #1's whale concern: purchase-rate limits and strategic-reserve refill live in the **market host's** matching rules, not in an unbounded on-chain free-for-all.

### 4.6 Five pre-1.0→1.0 crates must co-compile for `aarch64-linux-android`, reproducibly

The node links iroh 1.0 + p2panda 0.6 + yrs 0.27 + wtransport 0.6 + chia-wallet-sdk 0.33, each with its own MSRV (p2panda MSRV ~1.94–1.96; chia-wallet-sdk 1.81; yrs 2018-edition) and its own release cadence. For the F-Droid **reproducible-build** requirement this compounds: NDK + cargo + five fast-moving trees + a JS/Vite build, all deterministic. There is also an **APK-size** question against the ~12 MB Tauri thesis (iroh + p2panda + yrs + wtransport + chia's BLS/clvm all as native `.so`).

**Fix:** the *first* Sprint-3 spike is not any single subsystem — it is **"do all five crates compile and link together for desktop + `aarch64-linux-android`, and what's the resulting APK size?"** If MSRV/version hell bites, discover it before writing subsystem code, not after. Vendor/lock exact versions (`Cargo.lock` committed; consider `cargo vendor` for F-Droid reproducibility).

### 4.7 Station Seals are novel consensus-adjacent protocol — threat-model them

v005 rightly flags Seals as "the one piece of novel protocol we own" and keeps the message small. But a quorum signature over a log frontier that authorizes **irreversible pruning** is security-critical, and the doc doesn't threat-model it:
- **Equivocation:** a co-host signs two different seals for the same `epoch` (different frontiers). What resolves the fork? (Detectable via the `epoch`+`prev` chain, but the response — slashing? ejection from the auth group? — is unspecified.)
- **Byzantine/again-liveness:** if `quorum` co-hosts go offline mid-rotation, can the room still seal, or does pruning stall (unbounded growth) until they return?
- **Prune-then-need:** a peer prunes behind a seal, then a late writer presents pre-seal operations that were never included. Are they rejected, or does history get rewritten?

**Fix:** adopt **FROST threshold signatures** (already in the iroh ecosystem — verified) so a seal is *one* aggregate signature representing t-of-n, with equivocation caught at signing; specify the fork-resolution rule (lowest-hash frontier wins at a given epoch, anchored by the Chia singleton as the tiebreak of last resort); and write property tests for "prune-safety implies inclusion." Keep Seals Phase-3; Phase-1/2 rooms are small enough to retain full logs.

### 4.8 Immutable, signed, gossiped logs + open QR onboarding + minors = an unsolved trust-&-safety problem

This is the most important thing missing from v005, and it is a direct consequence of its best property. "Nobody can wipe a board; readers just ignore muted authors" (Cabal model) means **there is no global delete**. Combine that with: a broadcast-only substrate that re-seeds signed content, a QR flow (Issue #12) explicitly designed to make it *trivial for anyone with a phone* to join, and a social game that will attract minors — and you have a serious CSAM / illegal-content / harassment exposure with **no takedown primitive by design**. "Subjective local mute" protects an individual's *view*; it does nothing about propagation, seeding liability, or law.

v005's allowlisted-signed-only seeding (§11.2) and per-room co-host authority help, but the plan needs an explicit answer before any UGC ships:
- **De-facto takedown = co-host refusal:** flagged content is dropped from the room's co-host replica set and never sealed, so it stops propagating within that room's authority domain even though the author's own log retains it. Make this a first-class, fast path with content-hash denylists gossiped like revocation sets.
- **Node-operator safety valve:** every node ships a hash-denylist it refuses to store/relay, updatable independent of any room, so operators can comply with legal orders without waiting on consensus.
- **Onboarding gating:** capability tokens can require an age-gate / room-class flag; "open drive-by" rooms and "personal capsule" rooms need different default trust.
- **Study item:** this deserves its own design note, reviewed against real platform-safety obligations, *before* the RoomLog leaves the stub stage.

### 4.9 Gossip-overlay membership vs. topic-secret leakage

p2panda-net's HyParView/PlumTree overlay is joinable by anyone who knows the 32-byte topic secret (the "radio frequency"). p2panda-auth controls *write/seal authority*, but the **transport-level gossip membership** is only as private as the secret. A leaked room secret = permanent read/eclipse capability until re-key, and there's no re-key story in v005.

**Fix:** specify topic-secret rotation (new epoch → new topic, migrate members via the auth group), and note that confidential discovery (PSI) protects *discovery* but not a secret already leaked. Low severity for Phase 1 (rooms are semi-public), rising with private/company rooms.

### 4.10 Clock dependency is invisible but real (and interacts with the ≤14-day cert)

WebTransport `serverCertificateHashes` certs are **time-validated** (≤14-day window, "current time must be within validity"). Capability TTLs, seal cadence, and cert rotation all assume a roughly-correct clock. A device with a skewed clock (common on cheap Android, factory-reset phones, offline Pis) will **reject a valid node cert** or accept an expired capability. NTP is arguably a third-party dependency the sovereignty test would flag.

**Fix:** use **Chia block height as a coarse decentralized clock** for anything that can tolerate ~minute granularity (seal cadence, capability epochs), keep a generous cert-rotation overlap (v005's staged `current`/`next` already helps), and surface "your clock is wrong" diagnostically (the comms-weather console is a natural home). Note NTP as an explicit *convenience* dependency, not a hidden one.

---

## 5. Improvements to the Plan

1. **Elevate the `SsfLog` fallback from "if churn bites" to "built in parallel as a spec."** Given §3.2, write the minimal single-writer-log-on-iroh-gossip spec *now* (it's ~1–2 kLOC on `p2panda-core` — the most stable crate — or pure iroh-gossip + BLAKE3 + Ed25519). Even if you ship p2panda, having the escape hatch specified de-risks the largest dependency. The `RoomLog` port already makes this swap invisible to game code — use it.
2. **Keep Phase 1 entirely p2panda-free (v005 already does this — make it explicit and firm).** Phase 1 needs only WebTransport + yrs/Yjs + a chat `Y.Array`. Do not let RoomLog-on-p2panda creep into the first playable; the `RoomLog.ts` stub is correct.
3. **Adopt iroh 1.0's Kotlin bindings for the Android node** rather than assuming a monolithic Rust `.so` for everything — may simplify the Tauri-Android integration and the §4.6 build story.
4. **Make `DurabilityState` (v005 §12.2) drive a visible "records backed up to N stations" indicator** early — it's cheap, it's the diegetic answer to Issue #1's "rooms saved in blockchain?", and it makes the abstract seal machinery legible to players and testers.
5. **Split the market host role out of the room host** (§4.5) so a station can run a dedicated, higher-trust matching engine without coupling it to per-tick room simulation.
6. **Specify the QR scanner as a bundled WASM decoder** (`zxing-wasm`), reaffirming the v004 finding that `BarcodeDetector` is absent in Firefox and desktop-only in Chrome — Phase 1 currently doesn't name the QR-decode path at all.

---

## 6. Browser Capabilities Not Yet Exploited

### 6.1 Isolated Web Apps (IWA) + Direct Sockets — the strategic one

Chromium's **Isolated Web Apps** ship a *signed, versioned Web Bundle* (`.swbn`) served from an `isolated-app://` origin — which is precisely the "signed content-addressed web app" that GPT-5.5 (v004) and the whole app-shell-trust discussion wanted, and it closes the web-first-load asterisk on Chromium. More importantly, IWAs can use the **Direct Sockets API** (raw `TCPSocket`/`UDPSocket`), which would let an IWA speak **iroh QUIC directly with no relay** — turning the browser from a relay-dependent leaf into a near-native peer. It's Chromium-only and enterprise/kiosk-oriented today, but it is the single most strategically relevant emerging capability for this project: it simultaneously attacks the first-load asterisk, the relay dependency, and the locked-network problem. **Recommend a watch-and-spike.**

### 6.2 Prioritized Task Scheduling (`scheduler.postTask` / `scheduler.yield`)

For the render-vs-worker budget that Gemini 3.5 Flash raised in the v004 cycle, `scheduler.postTask` (Baseline-ish; Chromium + Firefox) lets the client chunk RoomLog verification / snapshot work at explicit priorities and `yield()` back to the compositor, keeping 60 fps under sync storms without hand-rolled `setTimeout` juggling. Cheap win in the network/crypto worker.

### 6.3 Permissions API preflight

The phone flow touches three gated capabilities: **camera** (QR scan), **persistent-storage**, and (Chromium 147+) **Local Network Access**. Query `navigator.permissions` up front to sequence prompts diegetically ("Grant the SpacePhone its camera / local comms") rather than hitting the user with raw browser prompts mid-join.

### 6.4 Others worth a line

- **Gamepad API** — a space-sim hangout wants controller/HOTAS support; nobody has mentioned it. Cheap, on-theme.
- **WebGPU compute** — beyond rendering (v003), use compute for A* pathfinding at scale and the orthographic pixelation post-FX; keep it progressive-enhancement (WebGL2 fallback).
- **WebXR** — walking a station in VR is the obvious endgame flex; note it as a rendering-layer future, not architecture.
- **View Transitions API** — smooth room-to-room transitions (the Phase-2 zone hops) for near-free.
- **`navigator.storage.estimate()` + Storage Buckets** — already implied by v005's pruning; name Storage Buckets as the mechanism for per-class eviction (app shell vs room cache vs assets).

---

## 7. Locked-Down Networks (universities) — better and newer angles

v005's ladder is good. Three additions:

1. **Encrypted Client Hello (ECH) to defeat SNI-based DPI.** The realistic university block against iroh-relay-on-443 is **SNI filtering** (the firewall reads the relay's hostname from the TLS ClientHello and drops it). ECH (shipping in Chrome/Firefox, DNS-assisted via HTTPS RRs) encrypts the SNI so the relay's hostname is invisible to DPI — a **legitimate, standards-track** mitigation that fits v005's "no covert evasion" rule far better than domain fronting (which v005 correctly rejects). **[UNVERIFIED]** exact current server-side ECH story for a self-hosted relay — worth a spike, high payoff.
2. **Lead with the fact that iroh-relay on TCP/443 with a valid cert is byte-indistinguishable from HTTPS.** This, not QUIC/UDP-443, is the workhorse that gets students connected on eduroam/dorm Wi-Fi. Make it Tier-1-for-hostile-nets in the docs, and make "run a relay with a real domain" a one-command story so communities can stand up campus-local relays.
3. **IWA + Direct Sockets (§6.1)** as the future browser path that needs *no* relay at all on networks that permit outbound TCP.

Rejections stay rejected: no DoH tunneling, no domain fronting. The Station-in-a-Box (once §4.4 is solved) remains the ultimate answer for a fully-blocked campus: a LAN that needs no internet.

---

## 8. Outside-the-Box (grounded in verified facts)

1. **ESP32 station beacons (verified: iroh runs on ESP32).** A ~$5 microcontroller flashed as a headless iroh seed/relay that players *physically* place — an in-world "comms relay beacon" or "buoy" that is also real always-on infrastructure. This makes Issue #12's "seeders as visible lore" literal and gives the sneakernet fantasy a cheap hardware anchor. Pairs with Station-in-a-Box as the low end of the "run infrastructure" ladder.
2. **FROST threshold signatures for Station Seals *and* company custody (verified: iroh-ecosystem FROST).** One aggregate signature for a t-of-n co-host quorum (smaller, cleaner seals, equivocation-resistant — §4.7), and the same primitive gives companies (Issue #1) social-recovery multi-sig custody that doubles as a diegetic "board meeting / notary ceremony." Also the answer to the key-loss UX problem (§9).
3. **Post-quantum transport (verified: iroh PQ handshakes)** for a game whose thesis is decade-scale unkillability — flip it on at the transport layer for near-free future-proofing; good marketing for the sovereignty story.
4. **Deterministic replay anti-cheat.** Because movement is host-authoritative over *signed* intents, retain the signed-intent log per session; a suspected cheat is adjudicated by deterministic re-simulation. Ties anti-cheat to the RoomLog you're already building and is far cheaper than per-tick server validation.
5. **Chia offer files as physical, tradeable "contract paper"** (extending v005's idea): a printed/QR'd offer pinned to a physical bulletin board is simultaneously fiction and a working, atomic financial instrument a courier can carry between stations.

---

## 9. Missing / Needs Further Study

| Gap | Why it matters | Suggested owner-study |
|---|---|---|
| **Trust & safety on immutable logs** (§4.8) | No global delete + easy QR onboarding + minors = legal/safety exposure with no takedown by design | A dedicated design note before UGC ships; co-host-refusal + node denylist + age-gated capabilities |
| **Voice architecture** | It's a "social hangout"; proximity voice is core, yet SFU-lite has been deferred since v003 | An early, concrete spike: WebRTC mesh ≤6 + Web Audio spatialization now; host-forward/WebCodecs SFU later; E2EE via Encoded Transform |
| **Key-loss / social recovery UX** | Portable Ed25519 key = lose it, lose identity + assets; the make-or-break onboarding risk | FROST/vault social recovery (§8.2); mandatory export before sole-custody; test with non-technical users |
| **Malicious room-host threat model** | Host-soft-authority means a cheating host can lie about everyone; migration helps but the model is thin | Specify detection (peer cross-checks, signed intents, deterministic replay §8.4) and host-eviction |
| **Economic anti-manipulation** | Issue #1 whale/strategic-reserve; wash trading on the off-chain floor | Market-host matching rules; rate limits; reserve-refill algorithm as an explicit spec |
| **Orbital determinism** (§4.3) | Ships/freight depend on agreed station positions | Fixed-tick, fixed-point/specified-float math contract |
| **Serverless observability** | You can't debug a network you don't run | Opt-in diegetic telemetry; the comms-weather console as the seed |

---

## 10. Blocking / Spiked Items — concrete proposals

| ID | Blocking/spiked item | Proposal to de-risk |
|---|---|---|
| **B-1** | **Five-crate Android build** (§4.6) — *do this first* | A throwaway `ssf-node-hello` that links iroh 1.0 + p2panda 0.6 + yrs 0.27 + wtransport + chia-wallet-sdk, builds for desktop **and `aarch64-linux-android`**, prints versions, and reports APK size. Go/no-go on MSRV + size before subsystem work. |
| **B-2** | **p2panda instability** (§3.2) | Pin exact versions + commit `Cargo.lock` + `cargo vendor`; **write the `SsfLog` fallback spec in the same sprint**; keep Phase 1 p2panda-free; defer `p2panda-spaces` E2EE to a Phase-2 spike (capability-gated transport is enough for Phase-1 chat). |
| **B-3** | **Station-in-a-Box secure context** (§4.4) | Decision spike across four options (native-on-LAN / baked HTTPS cert + self-answered DNS / installed local CA / IWA). Native client on the box is the honest Phase-1 answer; document the browser-on-box path as cert-dependent. |
| **B-4** | **Station Seals protocol** (§4.7) | FROST t-of-n aggregate seal; specified fork-resolution (lowest-frontier-hash, Chia singleton as final tiebreak); property test "prune-safety ⇒ inclusion"; Phase-3 only. |
| **B-5** | **Market latency/finality** (§4.5) | Two-tier: host-sequenced off-chain matched book (price discovery, cancellable) + periodic on-chain settlement/offer files (custody crossings). Prototype the double-take-loser-refunds path on testnet11. |
| **B-6** | **iroh browser/WASM maturity** (v005 P-4) | Gate spike against iroh 1.0 WASM: relay-WS endpoint from Chrome/Firefox/Safari; if not production-ready, browser hostile-net fallback = "WT-only + run a native/box node," and the iroh-WASM lane is desktop-first. |
| **B-7** | **chia-wallet-sdk WASM lag** (§3.4) | Verify per-driver WASM exposure (Offers, Vaults, Bulletin, XCHandles) against the *current* binding; if stale, budget contribution upstream or use `napi`/native on the node and injected-wallet in the browser. Confirms/kills v005 P-9. |
| **B-8** | **yrs ⇄ Yjs conformance** (§3.3) | Browser `y-protocols` ⇄ node `yrs::sync` incl. Awareness churn, subdocs, v1/v2 update formats, epoch snapshot/restore. |
| **B-9** | **ECH for relay SNI** (§7) | Stand up a self-hosted iroh-relay behind ECH; measure whether it survives an SNI-filtering test network. |

---

## 11. Recommended Changes to v005 (the short list)

1. **Re-pin iroh to `1` and drop the pre-1.0 hedging** (§3.1); re-run the connectivity claim against the locked-network matrix.
2. **Promote the p2panda-stability risk from footnote to headline**, and commit to the `SsfLog` fallback spec as parallel insurance, not a contingency (§3.2, §5.1, B-2).
3. **Rewrite Station-in-a-Box around the secure-context reality** — native-on-LAN primary, browser-on-box cert-dependent (§4.4, B-3).
4. **Fix the two positions-in-persisted-state anti-patterns** (Phase 1 Awareness-for-movement; Phase 2 orbital-anomaly-in-CRDT) and add an orbital determinism contract (§4.1–4.3).
5. **Add the two-tier market** and split the market-host role from the room-host (§4.5, §5.5).
6. **Add a Trust-&-Safety design note** as a hard prerequisite for UGC/RoomLog leaving the stub (§4.8) — this is the one genuinely unsolved problem, not just an unbuilt one.
7. Fold in FROST seals, ESP32 beacons, IWA/Direct-Sockets watch, ECH, and the clock-via-block-height note (§6–§8, §4.10).

---

## 12. Final Recommendation

**Accept v005 as the architecture of record.** Its Runtime-Gap correction is the most important insight in the series, its library picks are — with the iroh-1.0 update — verified, permissively licensed, and real, and the Phase-1 plan it produced is genuinely buildable with mature pieces (WebTransport + wtransport + yrs/Yjs). The document also models the right discipline by re-verifying its own platform ledger.

The work now is not more architecture; it is **de-risking the three things that can actually stop implementation** — (1) whether five fast-moving Rust crates build together for Android at acceptable size (B-1), (2) whether the game can lean its persistence on a self-described-not-production-ready library or must ship the `SsfLog` insurance (B-2), and (3) whether the secure-context reality lets the LAN-sovereign and browser-fallback stories work as drawn (B-3, B-6) — plus **one problem the plan hasn't yet faced at all**: takedown-less immutable logs meeting real-world content safety (§4.8).

In one line: **v004 proved the browser is ready; v005 proved the node can be built; this review's job is to prove it can be built *together, safely, and legally* — and to make the five-crate Android build the very next thing anyone runs.**

---

*Verification performed 2026-07-04 against p2panda (github/crates.io, v0.6.1), iroh (iroh.computer, v1.0.1), yrs (docs.rs/crates.io, v0.27.2), chia-wallet-sdk (github/crates.io, v0.33.0), MDN WebTransport, and repo Issues #1/#12. Highest-leverage next step: **spike B-1 (five-crate Android build) before B-2 (SsfLog spec) and B-3 (Station-in-a-Box secure context)** — B-1 gates whether the all-Rust node is even reachable on the target hardware.*
