# STUDY — Architecture Distilled v006
*A synthesis pass over [STUDY-Architecture v005](STUDY-Architecture%20v005.md) and its four independent reviews ([GPT‑5.5](../REVIEWS/REVIEW-20260703-ArchitectureV005-GPT55.md), [Gemini 3.1 Pro](../REVIEWS/REVIEW-20260703-ArchitectureV005-Gemini31Pro.md), [Gemini 3.5 Flash](../REVIEWS/REVIEW-20260703-ArchitectureV005-Gemini35Flash.md), [Opus 4.8](../REVIEWS/REVIEW-20260703-ArchitectureV005-Opus48.md)), grounded in fresh primary-source checks (2026‑07‑04, same-day) of the iroh release history, the `wtransport` source tree, and the repository's issues, PRs, and Phase 1/2 execution plans.*

**Date:** 2026-07-04 · **Author:** Claude Fable 5 (GitHub Copilot)

> **Reading this doc:** v005 closed the Runtime Gap (the Cabal/Autobase stack is JS-only; realize the model on Rust crates) and proposed the all-Rust node. The four v005 reviews converged on **four blockers** — UDP‑443 port ownership, the Station‑in‑a‑Box secure-context problem, ticking state written into CRDTs, and market microstructure — plus **two missing subsystems**: trust & safety on takedown-less logs, and voice.
>
> **v006 does five things:**
>
> 1. **Re-verifies the reviews themselves.** Three of their claims are confirmed and adopted; four are corrected or rejected after primary-source checks — including the discovery that the "quinn ALPN demultiplexer" fix two reviews proposed is **infeasible as specified**, because iroh ≥0.97 runs on **noq (n0's own QUIC implementation), not quinn**. Port-split is not a preference; it is the only realistic option (§3.1–3.2).
> 2. **Resolves the four blockers** with decisions, not options: two-socket port plan with verified hot-cert-rotation; Station-in-a-Box rebuilt around the secure-context reality (native-first, baked-cert browser lane); the *derive-don't-tick* data rule with a deterministic simulation contract; and two-tier markets (host-sequenced floor + Chia settlement) (§5, §8).
> 3. **Adds the two missing subsystems**: a Trust & Safety design for immutable, gossiped logs (the one genuinely unsolved problem Opus 4.8 identified) and a phased voice plan (§7, §9).
> 4. **Hardens the novel protocol**: Station Seals v2 with soft/anchored levels, FROST threshold signatures, an explicit fork-resolution rule, and a threat model (§6).
> 5. **Promotes the p2panda risk from footnote to headline** and ships the `SsfLog` insurance spec as code, not contingency prose (§5.4, §12.3) — and reorders the spike list so the **five-crate Android build** runs before any subsystem work (§15).
>
> The sovereign premise is unchanged and non-negotiable: **nothing on the critical path may depend on infrastructure we or our players do not control.** v006 differs from v005 only on *how*, never *whether*.

---

## 1. TL;DR — What v006 Changes vs v005

| Topic | v005 said | v006 verdict |
|-------|-----------|--------------|
| iroh version | `iroh = "0.9x"`, "treat 9-of-10 connectivity as vendor-optimistic pre-1.0" | ✅ **iroh 1.0 GA** (2026‑06‑15; 1.0.1 "Just Boring" 06‑29) — verified on the iroh blog today. Pin `iroh = "1"`; the API-stability commitment, first-party Kotlin/Swift/Python/JS bindings (06‑18), and PQ handshakes materially *de-risk* the consolidation bet (§3.1) |
| UDP 443: `wtransport` + iroh share the port | Implied both listen on 443 | ❌ **Impossible as written, and the reviews' "quinn ALPN demux" fix is also out** — verified: `wtransport` builds its own `quinn::Endpoint`; **iroh ≥0.97 runs noq, n0's own QUIC stack**. Two QUIC implementations cannot share one socket via a quinn-level demux. **Decision: port split** — `wtransport` owns UDP 443; iroh uses its own port + relays (§5.1) |
| Cert rotation mid-session | "staged `current`/`next` hashes" (mechanism unspecified) | ✅ **Verified API**: `wtransport::Endpoint::reload_config(config, rebind=false)` — "refreshing TLS certificates without disrupting existing connections." The ≤14-day rotation story now has a named, shipped mechanism (§3.2, §12.1) |
| Station-in-a-Box: LAN-origin PWA dodges LNA | "one open wrinkle: page-level TLS" | ❌ **Blocker, not wrinkle** (all four reviews; Opus 4.8 §4.4 sharpest): an `http://` LAN origin is **not a secure context** → WebTransport, Service Workers, OPFS, `crypto.subtle` all unavailable. Rebuilt: **native-on-LAN primary**, baked-domain-cert browser lane, local-CA event lane, IWA watch (§5.2) |
| Positions | "positions ride awareness, never the persisted doc" | 🔧 **Sharpened** (Opus 4.8 §4.1): y-protocols Awareness re-broadcasts the *full client state* per update — wrong for 20 Hz movement. **Three-lane rule:** continuous position = raw datagram ticks; *discrete* presence = Awareness; durable state = doc/log (§8.1). Phase 1 wording fixed accordingly |
| Phase 2 orbital `anomaly` "updated each tick" in `Y.Map` | (in the execution plan, not v005 — but v005 didn't catch it) | ❌ **The exact anti-pattern v005 §9 banned**, caught by all four reviews. **Derive-don't-tick:** store orbital *elements* + epoch; compute anomaly from the deterministic clock; station-keeping burns are discrete events (§8.2). Phase 2 plan patched |
| Markets | Order book = gossiped Chia offer files | 🔧 **Two-tier** (Opus 4.8 §4.5, GPT‑5.5 §4.7): offers settle at-most-once but are static-price, ~tens-of-seconds finality, cancel-by-spend, mempool-raceable. **Floor = station market-host matched book (off-chain, cancellable, price-time priority); settlement = Chia offers/vault netting.** Market-host is a role distinct from room-host (§5.3) |
| Station Seals | One seal type, quorum-signed, optional Chia anchor | 🔧 **v2**: **Soft Seals** (frequent, quorum-only, local pruning) vs **Anchored Seals** (Chia singleton memo, canonical checkpoints); **FROST t-of-n aggregate signature** (verified in the iroh ecosystem); explicit fork rule + threat model (§6) |
| p2panda risk | P‑2 footnote: "pre-1.0, pin versions" | 🔧 **Headline risk** (Opus 4.8 §3.2): the README's own banner says *"not yet considered stable for production use."* `SsfLog` fallback is now a **parallel spec with code** (§12.3), not a contingency sentence. Phase 1 stays p2panda-free (firm) |
| Trust & safety | Subjective moderation (mute/block) §7.5 | ➕ **New subsystem** (Opus 4.8 §4.8): immutable logs + QR onboarding + minors = takedown-less content exposure. Co-host refusal, node denylists, room-class capability gating, seals-exclude-denied — a hard gate before UGC ships (§7) |
| Voice | Deferred since v003 | ➕ **Phased plan**: P2 mesh ≤6 + Web Audio spatialization; P3 host-forward SFU-lite + Encoded Transform E2EE; TURN-TLS stays a voice-only lane (§9) |
| Clocks | (implicit NTP assumption) | ➕ Cert windows, capability TTLs, and seals all assume sane clocks; **Chia block height as the coarse decentralized clock**, cert overlap for skew, clock diagnostics in comms-weather (§10.2) |
| Spike order | WT dial matrix first | 🔧 **B‑1 first: do five crates (iroh 1 + p2panda 0.6 + yrs 0.27 + wtransport 0.6 + chia-wallet-sdk) even compile together for desktop + `aarch64-linux-android`, at what APK size?** (Opus 4.8) Everything else waits on that answer (§15) |

Everything else in v005 — the Runtime Gap resolution, the all-Rust node, RoomLog-on-p2panda behind a port, yrs-hosted Yjs, iroh-blobs assets, the storage split, four-axis pruning, capability QR, relay policy, hardware roles — **stands unchanged** and is not relitigated.

---

## 2. Method — Sources & What Was Verified vs Adopted vs Rejected

**Verified first-hand today (2026‑07‑04):**
- **iroh blog** (iroh.computer/blog): 1.0 "Dial Keys, not IPs" (06‑15), 1.0.1 (06‑29), first-party Swift/Kotlin/Python/JS bindings (06‑18), post-quantum key exchange (05‑19), **noq — n0's own QUIC implementation** (03‑19) with custom transports in 0.97 (03‑16), Tor custom transport (01‑27), ESP32 (03‑24 + the 07‑02 smart-fan follow-up), FROST threshold signatures (2024‑10‑21).
- **BiagioFesta/wtransport source**: `ServerConfigBuilder::{with_bind_default, with_bind_address, with_bind_socket}` (pre-existing `UdpSocket` accepted; endpoint still owned by wtransport's `quinn::Endpoint::new`), `Endpoint::reload_config(server_config, rebind)` for zero-downtime cert refresh, dual-stack IPv6 config, and the `quinn` feature exposing `EndpointConfig`/`TransportConfig` — but **no API to adopt a foreign QUIC endpoint**.
- **Repository:** the four v005 reviews; [Phase1-ExecutionPlan.md](../../docs/TDD/03-Implementation/Phase1-ExecutionPlan.md) and [Phase2-ExecutionPlan.md](../../docs/TDD/03-Implementation/Phase2-ExecutionPlan.md) as updated 2026‑07‑04 (confirming the awareness-positions and ticking-anomaly bugs the reviews flagged); Issues #1/#12; the network seams incl. [RoomLog.ts](../../prototypes/0.5.0-core-loop-demo/src/network/RoomLog.ts).

**Verified in the v005 cycle, carried:** MDN WebTransport table (Baseline 2026, LNA row Chrome 147, no `getStats()` on Chromium); p2panda crate inventory + 🚧 stability banner + MIT/Apache-2.0; `yrs::sync` protocol + Awareness semantics (`set_local_state` replaces the whole state — the §8.1 argument); chia-wallet-sdk WASM bindings existence.

**Adopted on reviewer verification (attributed, folded into spikes rather than asserted):** iroh-1.0 version facts beyond the blog (Opus 4.8 §2 table — independently confirmed above); p2panda v0.6.1 / 14-contributor / 2-maintainer profile (Opus 4.8); **chia-wallet-sdk `wasm/` directory ~6 months stale vs. core** (Opus 4.8 §3.4 — per-driver WASM surface is now spike B‑7, not an assumption).

**Rejected after checking (each with the reason):**
1. *"Build a custom QUIC router using `quinn` that ALPN-demuxes UDP 443 to wtransport and iroh"* (Gemini 3.1 Pro Spike #1; Gemini 3.5 Flash §4.4) — **infeasible as specified**: iroh ≥0.97 does not run on quinn; it runs on **noq**. A quinn-level demux cannot hand connections to a noq endpoint. The only theoretical single-socket path is an iroh *custom transport* — research-tier at best, and unnecessary given §5.1.
2. *"Cloudflare Workers convert WSS to iroh QUIC packets"* (Gemini 3.1 Pro §3) — Workers cannot emit raw UDP to arbitrary hosts; and the need is already met by **iroh-relay itself**, which speaks WebSocket/TLS on 443 and is self-hostable. Rejected as redundant and technically wrong.
3. *`verify_merkle_inclusion` browser API "from chia-wallet-sdk-wasm"* (Gemini 3.5 Flash §4.5) — no such verified export; browser trust-minimized chain reads remain **unproven** (v005 P‑9 stands). The *intent* (proof-carrying registry reads) stays as the spike's goal.
4. *".local mDNS domains with Let's Encrypt DNS challenges"* (Gemini 3.1 Pro Spike #3 Fix B) — Let's Encrypt cannot issue for `.local` (reserved mDNS TLD, no public DNS). The *corrected* version — a **real per-box subdomain** (`box42.stationfurlong.example`) with DNS‑01-issued certs cached onto the box — is adopted as the browser lane in §5.2, with its renewal dependency honestly scored.

---

## 3. Verification Ledger — Corrections & Confirmations

### 3.1 ✅ iroh 1.0 — and the noq fact that settles the port question

Verified on the iroh blog today: **1.0 shipped 2026‑06‑15** ("Dial Keys, not IPs"), **1.0.1** on 06‑29, first-party **Kotlin/Swift/Python/JS bindings** on 06‑18. v005's `0.9x` pin and pre-1.0 hedging are stale in the *good* direction — Opus 4.8 §3.1 confirmed. Two further verified facts matter architecturally:

- **noq (2026‑03‑19) is n0's own QUIC implementation**, and iroh 0.97 (03‑16) introduced *custom transports* on top of it. Consequence: iroh and `wtransport` (quinn-based) are **different QUIC stacks**. No shared-socket demux at the quinn layer can serve both — see §5.1.
- The ecosystem extras v005 wanted are real and dated: **post-quantum key exchange** (05‑19), **Tor custom transport** (01‑27), **ESP32 support** (03‑24, with a shipped smart-fan demo 07‑02), **FROST threshold signatures** (blog 2024‑10‑21) — feeding §6, §10, and §14.

### 3.2 ✅ wtransport — socket flexibility and zero-downtime cert rotation, verified in source

From the source tree today: `ServerConfigBuilder` accepts `with_bind_default(port)`, explicit addresses, IPv6 dual-stack config, or a **pre-existing `UdpSocket`** (`with_bind_socket`) — useful for socket options and privileged-port passing, but `Endpoint::server()` always constructs **its own `quinn::Endpoint`**; there is no injection point for a foreign endpoint. And the rotation mechanism v005 hand-waved has a name:

```rust
// verified: wtransport/src/endpoint.rs — "Useful for e.g. refreshing TLS
// certificates without disrupting existing connections."
pub fn reload_config(&self, server_config: ServerConfig, rebind: bool) -> std::io::Result<()>
```

Rotate the ≤14-day identity by building a new `ServerConfig` with the *next* cert and calling `reload_config(cfg, false)`: existing sessions continue, new dials see the new cert, and the registry advertises `current`+`next` hashes across the overlap (§12.1).

### 3.3 ❌ Confirmed blocker: no secure context, no client (Station-in-a-Box)

All four reviews converged; the platform rule is unambiguous: **secure contexts are `https://`, `localhost`, or `file://` — a page served over `http://` from a LAN IP or `.local` name is not one.** Without a secure context there is no WebTransport, no Service Worker, no OPFS, no `crypto.subtle`, no `storage.persist()` — the entire web client, not just first-load polish. v005's "LNA never fires because the page is LAN-served" was a real observation attached to a broken premise: it dodged the permission prompt by giving up the APIs the client is made of. §5.2 rebuilds the design around this.

### 3.4 ❌ Confirmed anti-pattern: 20 Hz movement through Yjs Awareness

Verified in the yrs/y-protocols semantics from the v005 cycle: `Awareness::set_local_state` **replaces the client's whole state object**, and each update fans out the full state to all peers. It is built for discrete presence (name, cursor, status), not a 20 Hz continuous stream — at which rate it re-serializes and re-broadcasts JSON state 20×/s×N peers, defeating the 13-byte hand-packed datagram tick specified in the *same* Phase-1 task. Opus 4.8 §4.1 is adopted as the **three-lane rule** (§8.1), and the Phase 1 plan is patched (§15.2).

### 3.5 ⚠️ Headline risk: p2panda's own words

Carried verification (v005 cycle) + reviewer confirmation (Opus 4.8: v0.6.1, 2026‑05‑22; 14 contributors, 2 dominant; EU-grant cadence): the README banner reads *"not yet considered stable for production use… APIs may still undergo breaking changes."* The **fit** is unchanged and excellent (§3.5 of v005 stands); the **bet** is now stated at its true size: the game's persistence layer would rest on a pre-1.0 research library. Mitigation is structural, not verbal: the `RoomLog` port stays, Phase 1 ships without p2panda, and the `SsfLog` insurance is **specified as code in this document** (§12.3) so the swap is a build-flag, not a rewrite. Pin exact versions, commit `Cargo.lock`, `cargo vendor` for F-Droid.

### 3.6 ⚠️ chia-wallet-sdk WASM lag (review-reported → spike)

Opus 4.8 §3.4: the `wasm/` directory's last commit ~6 months old while core moved 3 weeks ago; crates.io at 0.33.0. The v005 claim "browser WASM bindings exist" stands; the *per-driver* browser surface (Offers, Vaults/MIPS, Bulletin, XCHandles) is **[UNVERIFIED]** and folded into spike B‑7. Node-side Rust use is unaffected. Browsers keep the injected-wallet path as the working default.

### 3.7 ⚠️ Chia timing reality for "live" markets

Chia targets ~18.75 s average block spacing with finality in the tens of seconds; offer cancellation requires spending the offered coin; pending takes are visible in the mempool (raceable). None of this is a defect of the design — it is what *settlement* layers are — but it rules out Chia offers as the **matching engine** for Issue #1's "live call-out markets." §5.3 splits the roles.

### 3.8 ✅ Re-affirmed from the v005 cycle (not relitigated)

Two trust lanes; raw-WT certhash primary (Baseline 2026 incl. Safari 26.4); Chrome 147 LNA gate on WT-to-LAN + Chrome 142 prompt; no `getStats()` on Chromium (own ping/pong probe); yrs hosts y-sync + Awareness natively; p2panda model-fit table; iroh-blobs as the asset lane; storage split + four-axis pruning; capability QR with challenge binding; relay policy; hardware roles; Android Doze/F-Droid caveats; store-and-forward floor.

---

## 4. Review Adjudication — the Four v005 Reviews

| # | Suggestion | Source | Verdict | Where |
|---|-----------|--------|---------|-------|
| 1 | UDP‑443 conflict is blocking; port split for MVP | GPT‑5.5 §4.1 (also G3.1P §2.2, G3.5F §2.1) | **Adopt — and strengthen**: demux rejected on the noq fact; split is the *decision*, not the MVP default | §5.1 |
| 2 | quinn ALPN demultiplexer spike | G3.1P Spike #1, G3.5F §4.4 | **Reject as specified** (iroh runs noq, not quinn); single-socket = iroh-custom-transport research only | §2, §5.1 |
| 3 | Ticking orbital `anomaly` in Yjs = state explosion | all four | **Adopt**: derive-don't-tick rule + deterministic elements schema; Phase 2 patched | §8.2, §15.2 |
| 4 | Deterministic clock/math contract for orbits | GPT‑5.5 §8.1, Opus 4.8 §4.3 | **Adopt**: sim epoch + integer tick + specified float profile | §8.3 |
| 5 | Station-in-a-Box secure-context blocker | all four | **Adopt**: native-first; baked-cert browser lane; local-CA events; IWA watch | §5.2 |
| 6 | `.local` + Let's Encrypt for the box | G3.1P Spike #3B | **Reject → correct**: LE can't issue `.local`; real per-box subdomain + DNS‑01 adopted instead | §2, §5.2 |
| 7 | Two-tier markets; offers ≠ matching engine; market-host role | Opus 4.8 §4.5, GPT‑5.5 §4.7 | **Adopt** in full, incl. TTL/cancel/stale-offer UX and whale rules in the host | §5.3 |
| 8 | p2panda risk to headline; SsfLog in parallel as spec | Opus 4.8 §3.2/§5.1, GPT‑5.5 §4.5 | **Adopt**: SsfLog spec shipped in §12.3; bakeoff spike | §5.4, §12.3 |
| 9 | Positions-through-Awareness anti-pattern | Opus 4.8 §4.1 | **Adopt**: three-lane rule; Phase 1 patched | §8.1, §15.2 |
| 10 | Phase 1 authority contradiction ("no authoritative server" vs signed deltas) | GPT‑5.5 §4.3 | **Adopt**: "node-soft-authoritative for persistent state; client-predicted movement"; capsule claims host-sequenced | §8.4, §15.2 |
| 11 | Yjs chat = demo/session storage behind a `ChatProvider` seam | GPT‑5.5 §4.4 | **Adopt** | §8.4 |
| 12 | Station Seals threat model; soft vs anchored | GPT‑5.5 §4.8, Opus 4.8 §4.7 | **Adopt**: Seals v2 | §6 |
| 13 | FROST threshold sigs for seals + company custody + social recovery | Opus 4.8 §8.2 | **Adopt** (verified in iroh ecosystem) | §6, §10 |
| 14 | Trust & Safety on immutable logs — the unsolved problem | Opus 4.8 §4.8 | **Adopt as new subsystem + hard gate** | §7 |
| 15 | Voice architecture missing | Opus 4.8 §9 | **Adopt**: phased plan | §9 |
| 16 | Clock skew vs ≤14-day certs; Chia height as coarse clock | Opus 4.8 §4.10 | **Adopt** | §10.2 |
| 17 | Topic-secret leakage needs a re-key story | Opus 4.8 §4.9 | **Adopt**: epoch re-key via auth group | §7.4 |
| 18 | SQLite WAL corruption on Android lifecycle kills | G3.1P §2.3 | **Adopt as pitfall + pragma/config spike** | §8.5, P‑17 |
| 19 | Five-crate Android build as spike #1 | Opus 4.8 §4.6/B‑1 | **Adopt — first** | §15 |
| 20 | iroh-WASM/relay sovereignty gates (no default n0 relays; prove before dropping js-libp2p) | GPT‑5.5 §4.6 | **Adopt** (was v005 P‑3/P‑4; now gate-shaped) | §11, §15 |
| 21 | chia-wallet-sdk WASM per-driver audit | Opus 4.8 §3.4/B‑7 | **Adopt** | §3.6, §15 |
| 22 | `ClientHello`/`NodeAck` handshake schema | G3.5F §4.1 | **Adopt** (credited) | §12.2 |
| 23 | Yjs epoch snapshots as RoomLog ops with blob refs (`CrdtEpochSnapshot`) | G3.5F §4.2 | **Adopt** — snapshot bytes to iroh-blobs, hash+frontier into the log | §6.1, §12.3 |
| 24 | BLS/FROST-aggregated quorum seals + fee-surge deferral (anchor daily or on economic events) | G3.5F §4.3 | **Adopt** — folded into Seals v2 cadence | §6.2 |
| 25 | Shared port-mapping (UPnP) coordination across the two sockets | G3.5F §2.1 | **Adopt** | §5.1 |
| 26 | Bridge kit (`ssf-bridge-kit`), IPv6 first-class, captive-portal preflight UX | GPT‑5.5 §5 | **Adopt** | §11 |
| 27 | ECH against SNI-filtering DPI; relay-on-TCP-443 as the hostile-net workhorse | Opus 4.8 §7 | **Adopt** (ECH server-side story = spike) | §11 |
| 28 | IWA + Direct Sockets watch; `scheduler.postTask`; Permissions preflight; Gamepad/WebXR/View Transitions | Opus 4.8 §6, G3.1P §4, GPT‑5.5 §6 | **Adopt opportunistically** | §14 |
| 29 | Solar-system doc sharding | GPT‑5.5 §8.5 | **Adopt** | §8.2 |
| 30 | WebRTC TCP candidates on 443 "bypass TURN entirely" | G3.1P §3 | **Modify**: ICE-TCP direct is real but rarely traverses NAT without the node being reachable; keep TURN-TLS as the voice fallback, note ICE-TCP as an optimization | §9 |
| 31 | Background Sync API for stale-while-revalidate room state | G3.1P §3 | **Adopt opportunistically** (Chromium-only; enhancement) | §14 |
| 32 | Deterministic-replay anti-cheat from signed intents | Opus 4.8 §8.4 | **Adopt (design, Phase 3+)** | §10.3 |

---

## 5. The Four Blockers, Resolved

### 5.1 Port ownership — two sockets, one story (final)

**Decision:** the node runs **two QUIC sockets by design**:

| Socket | Stack | Port | Faces | Rationale |
|---|---|---|---|---|
| Browser pipe | `wtransport` (quinn) | **UDP 443** (public deployments; `4443` in dev) | Browsers via certhash | 443 is the UDP port most likely open (QUIC=HTTP/3); browsers are the constituency that can't fall back to relays cheaply |
| Native swarm | iroh 1.0 (noq) | OS-assigned UDP + self-hosted relays | Nodes, phones-as-nodes, iroh-WASM | iroh's hole-punching + relay fallback makes *its* port number nearly irrelevant; peers that can't reach it use the relay on TCP/443 |

Why not one socket: verified — `wtransport` owns a `quinn::Endpoint` it constructs itself, iroh ≥0.97 runs **noq**; there is no common QUIC layer to demux on (§3.1–3.2). The reviews' instinct (one port that looks like HTTP/3) is preserved where it matters: the *browser-facing* socket sits on 443, and the *relay* (the thing hostile networks actually see for native traffic) sits on TCP/443 with a real cert.

Operational glue (adopting Gemini 3.5 Flash §2.1): one **port-mapping service** in the node handles UPnP/NAT-PMP/PCP for both sockets and reports per-socket reachability; if 443/udp maps but the iroh port doesn't, the registry record advertises `wt` as direct and iroh as relay-first — peers pick accordingly. Both facts live in the registry (`wt`, `addrs`, `relays` fields — unchanged shape from v005 §10).

### 5.2 Station-in-a-Box v2 — secure-context honest

The box remains a headless `ssf-node` + Wi-Fi AP + mDNS. What changes is the **client story**, now ranked by sovereignty with the §3.3 rule applied:

1. **Native-first (primary, fully sovereign):** the box's captive portal serves a plain-HTTP *explainer page only* (no game code — HTTP is fine for a static page) with a QR/link to the **Android APK on the box itself** and desktop installers. Native clients dial the box's node directly — no secure-context rule, no LNA, no PKI. This is the honest answer and the default for dorms/jams.
2. **Browser lane (convenience, bounded PKI):** the box ships with a **real subdomain + DNS‑01-issued cert** (`box-<id>.stationfurlong.example`) baked into the image; the box answers DNS for its own name on the LAN; the PWA is served over genuine HTTPS and everything works — WebTransport, SW, OPFS — *while the cert is valid (≤90 days)*. Renewal happens whenever the box touches the internet. Dependency honestly scored: a project domain + issuance pipeline, same class as the canonical web origin (v004 §5.1's bounded convenience), **not** on the sovereign path.
3. **Event lane:** installed local CA (mkcert-style) for classrooms/LAN parties where one-time ceremony is acceptable.
4. **Watch: Isolated Web Apps** (§14) — a signed `.swbn` bundle would make the browser lane sovereign on Chromium; not shippable today.

An **already-installed PWA** (from the canonical origin, SW-pinned) also works offline at the box via lane 2's origin or its own cached shell — worth stating because it covers the returning player with zero new ceremony.

### 5.3 Markets v2 — the floor and the vault

Two tiers, two trust models, one fiction (Issue #1's exchanges):

- **The Floor (price discovery, fast):** each station market runs a **market-host** — a role *separate from the room-host* (Opus 4.8 §5.5) so a busy exchange doesn't couple to room simulation. Makers/takers submit signed intents; the market-host assigns the total order (price-time priority), matches, and emits **signed receipts** into the market's RoomLog topic. Cancellation is an intent; partial fills are receipts; the book is queryable state derived from the log. Whale rules (Issue #1: purchase caps, strategic-reserve refill curves) are host matching rules — station policy, not global protocol. Anyone can run a competing floor; sovereignty preserved.
- **The Vault (settlement, trustless):** value that crosses custody boundaries — deeds, CAT transfers between strangers, inter-station trades — settles as **Chia offers / vault spends**, netted periodically or per-trade for high value. The chain guarantees at-most-once; the loser of a race fails cleanly (and the floor's receipts make races rare: you take *from the book*, not from the mempool).
- **Offer hygiene** (GPT‑5.5 §4.7): offers carry TTLs in their RoomLog envelope; stale/filled/cancelled states are log messages; the UI never shows an offer without its state. Mempool front-running is confined to tier-2 raw offers — documented, bounded, acceptable there.

### 5.4 RoomLog insurance — p2panda primary, SsfLog specified

Unchanged decision (p2panda behind the `RoomLog` port), upgraded posture: §12.3 ships the **`SsfLog` minimal spec as code** — per-writer Ed25519 hash-chained logs + BLAKE3 payloads + iroh-gossip fan-out + SQLite, ~1–2 kLOC, no p2panda dependency beyond optionally `p2panda-core`'s header type. The **bakeoff spike** (GPT‑5.5 P1‑1) implements the same chat/board workload on both and measures API churn, binary size, Android behavior. Phase 1 remains **firmly** free of both: chat is a session-capped `Y.Array` behind a `ChatProvider` seam (§8.4).

---

## 6. Station Seals v2 — soft/anchored, FROST-signed, threat-modeled

### 6.1 Two seal levels

| | **Soft Seal** | **Anchored Seal** |
|---|---|---|
| Signed by | FROST t-of-n aggregate over the co-host group | same + memo in the room's Chia singleton spend |
| Cadence | frequent (hourly/daily; on host migration) | daily-ish, or on economic events (docking, custody transfer), fee-aware deferral (Gemini 3.5 Flash §4.3) |
| Grants | local pruning behind the frontier; fast-forward hint | canonical checkpoint for months-away peers; fork tiebreak of last resort |
| Cost | zero (gossip) | one small on-chain memo, batched across rooms |

Seal body (unchanged from v005 §7.3, plus the snapshot-blob ref from Gemini 3.5 Flash §4.2): `{room_id, epoch, frontier: [(log, seq)], frontier_hash, yjs_snapshot_blob: blake3 → iroh-blobs, prev_seal, sig: FROST-aggregate}`. **FROST** (verified in the iroh ecosystem, blog 2024‑10‑21) makes the quorum signature *one* aggregate — smaller, and equivocation is resisted at signing time because a signing share used twice for the same epoch is detectable.

### 6.2 The rules (answers to GPT‑5.5 §4.8 / Opus 4.8 §4.7)

- **Quorum:** t-of-n over the room's co-host group (`p2panda-auth` membership at the sealed epoch); n changes only via group ops that are themselves sealed.
- **Fork resolution:** two valid seals at the same epoch → the one referenced by the **Chia anchor** wins; if neither is anchored, lowest `frontier_hash` wins deterministically *pending* the next anchor; equivocating signers are auto-flagged for group removal.
- **Liveness:** if quorum is unreachable for `k` epochs, **pruning pauses** (safety over liveness) — growth is bounded meanwhile by device budgets evicting *blobs*, never log ops; the room owner may re-key the group (§7.4) to restore quorum.
- **Prune-then-need:** ops at-or-before a sealed frontier that were never included are **rejected** (the seal is the inclusion cutoff); a late writer's recourse is re-submission above the frontier. Property test: *prune-safety ⇒ inclusion* (anything the seal covers is either retained-in-summary or reconstructible from the snapshot blob).
- **Freshness:** a client older than `max_ff_age` seals must fetch from an archivist rather than fast-forward blindly.
- **Phasing:** Seals are **Phase 3**; Phase 1–2 rooms retain full logs (small enough), so none of this blocks early sprints.

---

## 7. Trust & Safety by Design (new — the hard gate)

The Cabal model's strength — *nobody can wipe a board* — is also its liability: **there is no global delete**, while the QR flow (Issue #12) makes joining trivially easy and a social game will attract minors. Subjective mute protects a viewer; it does nothing about propagation, seeding liability, or legal orders (Opus 4.8 §4.8). v006 adds four mechanisms, all consistent with sovereignty (no global authority is created — every mechanism is scoped to an *operator's own machine* or a *room's own authority group*):

1. **Co-host refusal = de-facto room takedown.** Flagged content (by content hash) is dropped from the room's co-host replica set, never included in seals, and never re-served. The author's own device keeps their log — nobody's data is destroyed — but propagation inside the room's authority domain stops. Fast path: a `mod-flag` RoomLog op from any moderator-role member triggers immediate co-host drop pending review.
2. **Node-operator denylist.** Every node ships a local content-hash denylist it refuses to store/relay/seed — updatable by the operator independently of any room, subscribable from lists the operator chooses (station default, jurisdiction packs). This is the legal-compliance valve: an operator served with an order can comply unilaterally. It composes with v005's allowlisted-signed-only seeding (§11.2): *seed only what's allowlisted AND not denylisted.*
3. **Room classes on capabilities.** Capability tokens carry a room class — `open-drive-by` (QR joinable, guest-writes rate-limited + held for co-host relay), `member`, `private-capsule` — and an age-gate flag where the station requires it. Drive-by guests post through the host's "guests" log (v005 §7.2), which means **guest content is only ever replicated after a co-host accepted it** — the moderation choke-point exists by construction.
4. **Reports as first-class ops.** A `report` op (content hash + reason) routes to the room's moderator set and optionally the station default list — visible, auditable, prunable like everything else.

**Gate:** a dedicated T&S design note (flows, defaults per room class, list governance, legal review) is a **prerequisite for RoomLog leaving the stub stage** in any public build. This is scheduled work, not aspiration — spike list §15.

### 7.4 Topic re-key (Opus 4.8 §4.9)

A leaked 32-byte topic secret = permanent read/eclipse until re-key. Rule: room secrets are **epochal** — the owner rotates the topic (new secret, announced via an auth-group-encrypted op on the old topic + door/QR refresh); co-hosts bridge both topics for a grace window; the old topic goes silent. PSI-confidential discovery limits *finding* the topic; rotation limits the blast radius of *losing* it.

---

## 8. Data Discipline — derive, don't tick

### 8.1 The three motion lanes (final ruling)

| Lane | Carries | Rate | Persistence |
|---|---|---|---|
| **Datagram ticks** (WT datagrams / iroh datagrams) | continuous position/velocity, 13-byte packed | 20 Hz, only-on-change | none — interpolated and discarded |
| **Awareness** (y-protocols/yrs) | *discrete* presence: joined/left, name, speaking-flag, "typing", AFK | on change (human-rate) | none — in-memory, timeout-cleared |
| **Y.Doc / RoomLog / Chia** | durable state per the v005 §9 split | on mutation | per the split |

Anything that changes continuously is **computed, not synced**: peers receive parameters + events and derive the value locally.

### 8.2 The corrected Phase-2 schema (applied to the plan)

```typescript
interface StationOrbit {
  stationId: string;
  orbitType: 'circular' | 'elliptical' | 'lagrange' | 'free-floating';
  parentBodyId?: string;
  semiMajorAxis?: number;
  eccentricity?: number;          // 0 = circular
  epochTick: number;              // simulation tick at element definition
  anomalyAtEpoch?: number;        // radians at epochTick — set once, never ticked
  meanMotion?: number;            // rad/tick — position derives from (nowTick - epochTick)
  lagrangePoint?: 'L1'|'L2'|'L3'|'L4'|'L5';
  primaryBodyId?: string; secondaryBodyId?: string;
  position?: {x:number,y:number}; // free-floating anchor (static)
  driftPerTick?: {dx:number,dy:number}; // unstable-Lagrange drift RATE (static parameter)
  lastStationKeepingTick?: number; // discrete event — the ONLY field burns mutate
}
```

Same rule for asteroid regen (regen *rate* + `depletedAtTick`, not timers), travel progress (departure tick + speed), power/repair decay, and price curves. **Sharding** (GPT‑5.5 §8.5): a slim `solar-index` doc (stable summaries), per-zone docs (local state), RoomLog topics (durable posts/contracts), Chia (custody) — no monolithic solar doc.

### 8.3 Determinism contract (Opus 4.8 §4.3)

All derived positions compute from a **shared integer simulation tick** (defined epoch, fixed tick length), never wall-clock; orbital math uses a specified profile (f64 with defined rounding, or fixed-point) so two peers render the station in the same place. Tick sync rides the existing ping/pong probe (offset estimation); disputes defer to the room host's tick. Cheap now, painful to retrofit once freighters dock by position.

### 8.4 Phase-1 authority + chat clarifications (applied to the plan)

- *"Node-soft-authoritative for persistent room state; client-predicted for local movement; awareness best-effort."* Capsule claims — the first scarce resource — are **host-sequenced** even in Phase 1 (first-writer-wins by host receipt), so the demo teaches the right model.
- Chat: `Y.Array`, session-capped (~200 messages), behind a **`ChatProvider`** interface (`'yjs-demo' | 'roomlog'`), explicitly disposable. Durable chat is promised only when RoomLog lands (Phase 2 boards/contracts first — GPT‑5.5 §8.3 adopted: RoomLog minimal implementation is a Phase-2 objective, not Phase-3).

### 8.5 SQLite on Android (Gemini 3.1 Pro §2.3)

Android may kill the process mid-WAL-commit. Node config on mobile: `PRAGMA synchronous=FULL`, WAL with checkpoint-on-background (Tauri lifecycle hook flushes + checkpoints when the app backgrounds), and the store's transactionality (p2panda-store's atomic pipeline / our own in SsfLog) treated as required, not optional. Folded into the Android spike.

---

## 9. Voice — a plan instead of a deferral

- **Phase 1:** text only (unchanged).
- **Phase 2 — proximity voice, small rooms:** WebRTC mesh capped at ~6 speakers, SDP brokered over the node pipe (no signaling server — the WT/iroh connection *is* the broker), Web Audio `PannerNode` spatialization keyed to the same positions the ticks carry, push-to-talk default. ICE-TCP candidates on the node's 443 noted as an optimization; **TURN-over-TLS on 443 remains the voice-only fallback lane** (distinct from iroh-relay, which does not carry WebRTC media) — community `turns:` servers listed in the registry, convenience-lane trust class.
- **Phase 3 — bigger rooms:** host-forward SFU-lite on the room host (or a dedicated voice-host role), **WebRTC Encoded Transform** for E2EE so forwarders relay opaque frames; WebCodecs where present.
- Spike early (Opus 4.8 §9): mesh voice is a Phase-2 *pre-work* spike, not a launch-week surprise — it is the "social hangout" pillar's core sensory feature.

---

## 10. Identity, Clocks, Recovery, Anti-cheat

**10.1 Identity (carried):** portable Ed25519 keypair; passkey/OS-keychain wrap where PRF exists; challenge-bound QR capabilities; gossiped revocation sets.

**10.2 Clocks (new — Opus 4.8 §4.10):** ≤14-day certs, capability TTLs, and seal cadence all assume sane clocks; skewed devices (factory-reset phones, offline Pis) will reject valid certs. Mitigations: generous cert overlap (staged `current`/`next` + `reload_config`, §3.2); **Chia block height as the coarse decentralized clock** for seal epochs and capability windows that tolerate ~minute granularity; a "your clock looks wrong" diagnostic in the comms-weather console (compare peer-reported times from the ping probe). NTP is documented as a *convenience* dependency, not a hidden one.

**10.3 Recovery & anti-cheat:** **FROST social recovery** — t-of-n shares across a player's own devices + trusted friends ("recovery council" as diegetic ceremony) — answers the key-loss make-or-break without custodians; the same primitive is company custody (officers' t-of-n over the vault) — one mechanism, two fictions. **Deterministic-replay anti-cheat** (Phase 3+): retain signed movement intents per session; adjudicate suspected cheats by re-simulation against the content-addressed room geometry — cheap, and it reuses the logs we already keep.

---

## 11. Locked Networks — ladder v3 (deltas only)

- **Reframe the workhorse:** for hostile campus networks the realistic first hop is **iroh-relay on TCP/443 with a valid cert** — byte-indistinguishable from HTTPS (Opus 4.8 §7.2). UDP-443 WT is the *happy* path; relay-TCP-443 is the *reliable* one. Docs and defaults reflect that ordering.
- **ECH (Encrypted Client Hello)** so SNI-filtering DPI can't single out relay hostnames — legitimate, standards-track, consistent with the no-covert-evasion rule. Server-side story for a self-hosted relay = spike B‑9.
- **IPv6 first-class** in the reachability matrix (campus IPv6 often beats NATed IPv4).
- **Captive-portal preflight:** detect hijack symptoms, show a comms-setup screen, retry after clearing — network failures must not present as game bugs.
- **`ssf-bridge-kit` deliverable:** iroh-relay + Caddy/TLS + optional coturn (`turns:`) + rate limits + registry-advertise command + one-page guide — "anyone can run the bridge" made true in practice (GPT‑5.5 §5.1).
- **Watch:** IWA + Direct Sockets = browser-as-near-native-peer with no relay (§14). Rejections unchanged: no DoH tunneling, no domain fronting.

---

## 12. Deployment Playbook — updated code

> Repository seams: [NetworkProvider.ts](../../prototypes/0.5.0-core-loop-demo/src/network/NetworkProvider.ts) · [YjsSync.ts](../../prototypes/0.5.0-core-loop-demo/src/network/YjsSync.ts) · [RoomLog.ts](../../prototypes/0.5.0-core-loop-demo/src/network/RoomLog.ts) · [Phase1-ExecutionPlan.md](../../docs/TDD/03-Implementation/Phase1-ExecutionPlan.md) · [Phase2-ExecutionPlan.md](../../docs/TDD/03-Implementation/Phase2-ExecutionPlan.md). Upstream: [n0-computer/iroh](https://github.com/n0-computer/iroh) (1.0) · [p2panda/p2panda](https://github.com/p2panda/p2panda) (0.6) · [y-crdt/y-crdt](https://github.com/y-crdt/y-crdt) (yrs 0.27) · [BiagioFesta/wtransport](https://github.com/BiagioFesta/wtransport) (0.6) · [xch-dev/chia-wallet-sdk](https://github.com/xch-dev/chia-wallet-sdk) (0.33) · semantics reference: [holepunchto/autobase](https://github.com/holepunchto/autobase). Code marked **illustrative** where signatures are simplified; §12.1's rotation call and socket options are the verified APIs from §3.2.

### 12.1 Node: re-pinned deps, two sockets, hot cert rotation

```toml
# ssf-node/Cargo.toml — v006 pins (commit Cargo.lock; `cargo vendor` for F-Droid)
[dependencies]
iroh            = "1"        # 1.0.1+ — GA, API-stability commitment (§3.1)
iroh-blobs      = "1"        # BLAKE3 content-addressed assets
p2panda-core    = "=0.6.1"   # exact-pinned: pre-1.0 (§3.5); RoomLog primary
p2panda-net     = "=0.6.1"
p2panda-store   = "=0.6.1"
p2panda-auth    = "=0.6.1"
yrs             = "0.27"     # y-sync + Awareness in Rust
wtransport      = { version = "0.6", features = ["quinn"] }
chia-wallet-sdk = "0.33"     # node-side; browser WASM surface = spike B-7
frost-ed25519   = "2"        # Station Seals v2 + social recovery (§6, §10.3)
blake3 = "1"; ed25519-dalek = "2"; ciborium = "0.2"; rusqlite = { version = "0.3x", features = ["bundled"] }
```

```rust
// Two sockets by design (§5.1) — illustrative assembly
let wt_socket = std::net::UdpSocket::bind(cfg.wt_bind)?;          // UDP 443 prod / 4443 dev
let wt_cfg = wtransport::ServerConfig::builder()
    .with_bind_socket(wt_socket)                                   // verified API (§3.2)
    .with_identity(identity_current.clone_identity())
    .build();
let wt = wtransport::Endpoint::server(wt_cfg)?;                    // quinn under the hood

let iroh_ep = iroh::Endpoint::builder()                            // noq under the hood
    .secret_key(cfg.node_key.clone())
    .relay_mode(cfg.self_hosted_relays.clone().into())             // NEVER default publics (P-3)
    .bind().await?;                                                // OS-assigned UDP port

// ≤14-day rotation WITHOUT dropping sessions — the verified mechanism (§3.2):
async fn rotate(wt: &wtransport::Endpoint<Server>, next: Identity, registry: &ChiaService) {
    registry.stage_next_hash(next.certificate_chain().as_slice()).await; // publish next
    let cfg = ServerConfig::builder().with_bind_default(0 /*ignored*/)
        .with_identity(next).build();
    wt.reload_config(cfg, /*rebind=*/false).expect("hot cert swap"); // sessions survive
}
```

### 12.2 Session handshake (adopted from Gemini 3.5 Flash §4.1, extended with room class)

```ts
// Stream 0, client → node
interface ClientHello {
  v: 1;
  roomId: string;
  clientPubKey: Uint8Array;        // Ed25519
  capabilityToken: Uint8Array;     // Biscuit-style; carries room class + age flag (§7.3)
  challengeResponse: Uint8Array;   // signature over the QR/invite challenge (§10.1)
}
// node → client
interface NodeAck {
  v: 1;
  status: 'ACCEPTED' | 'DENIED';
  roomClass: 'open-drive-by' | 'member' | 'private-capsule';
  simTick: { epochMs: number; tickHz: number; nowTick: number };  // determinism contract (§8.3)
  latestSeal?: { epoch: number; frontierHash: Uint8Array };       // RoomLog fast-forward anchor
}
```

### 12.3 `SsfLog` — the insurance, specified (not prose)

```rust
/// SsfLog: minimal per-writer signed append-only log. ~1–2 kLOC total.
/// Deliberately a strict subset of the p2panda operation model so RoomLog
/// adapters over either substrate serve identical semantics (§5.4).
pub struct SsfOp {
    pub writer: VerifyingKey,          // Ed25519
    pub seq: u64,                      // strictly increasing per writer
    pub backlink: Option<[u8; 32]>,    // BLAKE3 of previous op header (hash chain)
    pub payload_hash: [u8; 32],        // BLAKE3(body)
    pub timestamp_tick: u64,           // sim tick, not wall clock (§8.3)
    pub kind: OpKind,                  // chat | board-post | mod-flag | report | seal | snapshot-ref…
    pub signature: Signature,          // over all header fields
}
// invariants (property-tested):
//  I1 verify(sig, header) ∧ seq = prev.seq + 1 ∧ backlink = hash(prev)  — fork-evident
//  I2 body available ⇔ payload_hash matches                            — blobs fetch lazily (iroh-blobs)
//  I3 ops ≤ sealed frontier are prunable; frontier_hash retained        — Seals v2 (§6)
// sync: per-topic iroh-gossip announce {writer, head_seq}; range pull over
// a plain iroh bidi stream; store = SQLite (ops table keyed writer+seq).
```

The `RoomLog` port ([RoomLog.ts](../../prototypes/0.5.0-core-loop-demo/src/network/RoomLog.ts) browser-side, a Rust trait node-side) is implemented twice in the bakeoff spike — `p2panda` and `SsfLog` — and the winner is a build flag.

### 12.4 Market host (the Floor, §5.3) — shape of the engine

```rust
enum MarketIntent { Place(Order), Cancel(OrderId), Take(OrderId, Qty) }
struct Receipt { seq: u64, intent_hash: [u8;32], outcome: Outcome, host_sig: Signature }
// Host loop: recv signed intent → validate capability + funds-escrow state
//  → assign monotone seq (price-time priority) → match → emit Receipt into
//  the market RoomLog topic. Settlement worker nets custody-crossing fills
//  into Chia offers/vault spends (tier 2) and posts `settled(receipt_seq, coin_id)`.
// Whale rules (Issue #1) = per-account rate/size caps + strategic-reserve
// refill curve, enforced HERE — station policy, not global protocol.
```

### 12.5 Config: two sockets + T&S lists

```toml
[wt]      bind = "0.0.0.0:443"        # dev: "127.0.0.1:4443" — never privileged in dev (GPT-5.5 §7.2)
          rotate_days = 12            # staged next at day 10; reload_config hot swap
[iroh]    relays = ["https://relay.stationfurlong.example"]   # self-hosted only
          dht = true
[portmap] upnp = true                 # one service maps BOTH sockets (§5.1)
[safety]  denylists = ["file://var/ssf/deny-local.txt", "ssf-list://station-default"]  # §7.2
          seed_policy = "allowlisted-and-not-denied"
[rooms]   class_defaults = { open-drive-by = "guest-held", member = "direct" }         # §7.3
```

### 12.6 What stays from v005 §12

The browser dial with state-vector re-handshake, awareness wiring (now presence-only), the `SsfEnvelope`, `NetworkProvider`/`DurabilityState` ports, node-side signed-envelope verification before `apply_update`, systemd unit, and the Chia snippets — all unchanged; only the datagram tick (not awareness) carries position, per §8.1.

---

## 13. Pitfalls & Gaps Registry v2

| # | Pitfall | Severity | Fix |
|---|---|---|---|
| P‑1…P‑12 | v005 registry | — | Carried unchanged except as amended below |
| P‑2′ | p2panda pre-1.0 → **headline** | **Critical** | Exact pins + `Cargo.lock` + vendor; `SsfLog` spec shipped (§12.3); bakeoff spike; Phase 1 free of both |
| P‑13 | UDP‑443 single-socket impossible (quinn vs noq) | High (was invisible) | Port split decided (§5.1); demux rejected; shared port-mapping service |
| P‑14 | Station-in-a-Box `http://` = no secure context = no client | High | Native-first; baked-cert browser lane; local-CA events; IWA watch (§5.2) |
| P‑15 | Takedown-less immutable logs (CSAM/legal/minors) | **Critical, unsolved-by-design** | §7 mechanisms + T&S design note as a hard gate before UGC ships |
| P‑16 | Clock skew vs ≤14-day certs + TTLs | Medium | Cert overlap + `reload_config`; Chia-height coarse clock; skew diagnostics (§10.2) |
| P‑17 | Android lifecycle vs SQLite WAL | Medium | `synchronous=FULL` + checkpoint-on-background + transactional store (§8.5) |
| P‑18 | Topic-secret leak = permanent read until re-key | Medium | Epochal topic rotation via auth group (§7.4) |
| P‑19 | chia-wallet-sdk WASM lags core (~6 mo) | Medium | Spike B‑7 per-driver audit; injected wallet stays the browser default (§3.6) |
| P‑20 | Awareness misuse for continuous state (recurring trap) | Medium | Three-lane rule written into the plan + code review checklist (§8.1) |
| P‑21 | Market floor host = new trusted role | Medium | Signed receipts (auditable), competing floors allowed, settlement always chain-verifiable (§5.3) |

---

## 14. Outside-the-Box (verified-fact-grounded additions)

1. **ESP32 comms buoys** (iroh-on-ESP32 verified, incl. a shipped demo): ~$5 flashed beacons as physical seed/relay props — Issue #12's "seeders as visible lore" made literal; the low rung of the run-infrastructure ladder below Station-in-a-Box.
2. **Post-quantum handshakes** (verified, iroh 05‑19): flip on at the transport for a decade-scale-unkillable thesis; free marketing for the sovereignty story.
3. **FROST ceremonies as fiction** (§6, §10.3): seal countersigning at the "notary terminal"; company board t-of-n as a diegetic boardroom vote; recovery councils for lost clones.
4. **IWA + Direct Sockets watch** (Chromium): a signed `.swbn` app that speaks iroh QUIC *directly* — simultaneously attacks the web first-load asterisk, the relay dependency, and locked networks. Watch-and-spike; not shippable today.
5. **Offer files as paper + data-mule freighters + archivist/notary professions** — carried from v005 §14, now with §5.3's floor receipts also printable as "trade slips."
6. Quick wins list: `scheduler.postTask`/`yield` for sync-storm frame pacing; Permissions API preflight to sequence camera/LNA/storage prompts diegetically; Gamepad API (HOTAS!); View Transitions for zone hops; Background Sync for stale-while-revalidate registry reads; WebXR noted as a rendering-layer future.

---

## 15. Spikes & Plan Amendments

### 15.1 Spike order (supersedes v005 §15.1)

1. **B‑1 · Five-crate build gate (FIRST):** `ssf-node-hello` linking iroh 1 + p2panda 0.6.1 + yrs 0.27 + wtransport 0.6 + chia-wallet-sdk 0.33 for desktop **and `aarch64-linux-android`**; report MSRV conflicts + APK size vs the ~12 MB Tauri thesis. Everything below waits on this go/no-go.
2. **WT certhash dial matrix** (carried): Chrome/FF/Safari 26.4, IP vs LAN (Chrome 142/147 LNA prompt recorded), UDP 443, IPv6 lane, `reload_config` rotation under live sessions.
3. **RoomLog bakeoff:** same chat/board workload on p2panda vs `SsfLog` (§12.3); 3 co-hosts + flapping phone; pruning behind a fake seal; Android store behavior (P‑17 pragmas).
4. **Seals v2 mini-spec:** FROST t-of-n prototype; equivocation/liveness/prune-then-need property tests; soft→anchored flow on testnet11 with fee-deferral.
5. **yrs⇄Yjs conformance** (carried): sync + Awareness churn + subdocs + v1/v2 update formats + epoch snapshot/restore.
6. **iroh sovereignty gate:** self-hosted-relay-only drill (kill DNS, kill relay, kill DHT — record survivals); **iroh-WASM maturity** vs the 1.0 JS bindings; refuse-public-relays default proven in config.
7. **B‑7 · chia-wallet-sdk WASM audit:** per-driver browser surface (Offers/Vaults/Bulletin/XCHandles) vs current bindings; upstream contribution budget if stale.
8. **Market floor prototype:** matched book + two-taker race + clean loser refund + stale-offer UI on testnet11.
9. **Station-in-a-Box trust decision:** the four §5.2 lanes tested with real phones; pick the playtest default.
10. **Voice mesh pre-work:** 4-way WebRTC mesh brokered over the node pipe + PannerNode spatialization.
11. **ECH relay spike** (B‑9): self-hosted iroh-relay behind ECH vs an SNI-filtering test net.
12. **T&S design note** (§7): flows, room-class defaults, list governance — gate for RoomLog-beyond-stub.

### 15.2 Plan amendments (applied with this study)

Applied now — verified errors, patched surgically:
- **Phase 1 Task 3.2/3.3:** positions move off Awareness onto datagram ticks; Awareness = discrete presence only (§8.1). Authority wording: node-soft-authoritative persistent state; capsule claims host-sequenced (§8.4). Chat marked session-capped demo storage behind `ChatProvider`.
- **Phase 2 Feature 3:** `StationOrbit` re-specified with epoch elements + derived anomaly + event-only mutations (§8.2); station-keeping = discrete events; determinism-contract note; solar-doc sharding note.

Listed for the next docs PR (not yet applied): RoomLog promoted to a Phase‑2 objective (boards/contracts minimal impl); voice-mesh spike into Phase‑2 pre-work; `docs/TDD/BrowserSupportMatrix.md` creation (P‑11, still owed); asset/dependency license audit for F-Droid (GPT‑5.5 §4.11); marking `docs/TDD/01-Architecture.md` + old prototype READMEs as historical.

---

## 16. Final Recommendation

Keep v005's spine — it survived four hostile reviews with its central moves intact. What the reviews changed is the *engineering posture*, and v006 locks it in:

1. **Decide, don't defer, the physical layer:** two QUIC sockets (wtransport-on-443 for browsers, iroh-on-its-own-port for the swarm) — the single-socket dream is dead on the quinn/noq fact, and that's fine: hostile networks were always going to be served by the relay on TCP/443, not by port cosmetics. Rotation is `reload_config`; sovereignty of the relay tier is a config default, not a hope.
2. **Respect the platform's two hard lines:** no secure context, no client (Station-in-a-Box is native-first with a certificated browser lane); no continuous values in synced state, ever (three lanes: ticks, presence, durable — and orbits are *math*, not messages).
3. **Size the bets honestly and buy insurance:** p2panda is the right shape and a real risk — so the fallback is a spec with code, the port makes it swappable, and the five-crate Android build runs before anything else. Markets get the two-tier split so settlement-grade trust never has to pretend to be a matching engine.
4. **Face the unsolved problem before it ships:** takedown-less logs meeting real-world content safety is now a designed subsystem with a hard gate — because a sovereign network that cannot protect its youngest players or its node operators is not sovereign, it is abandoned.

In one line: **v004 proved the browser is ready, v005 proved the node can be built — v006 proves the decisions close: ports chosen, trust lanes honest, data lanes disciplined, seals threat-modeled, safety designed — so the next thing anyone runs is not another study, but spike B‑1.**

---

*Companion to [STUDY-Architecture v005](STUDY-Architecture%20v005.md) and the four v005 reviews. Grounded in Issues [#1](https://github.com/Bella-Addormentata/StarStationFurlong/issues/1) and [#12](https://github.com/Bella-Addormentata/StarStationFurlong/issues/12), the Phase [1](../../docs/TDD/03-Implementation/Phase1-ExecutionPlan.md)/[2](../../docs/TDD/03-Implementation/Phase2-ExecutionPlan.md) execution plans, and same-day primary-source checks of the iroh release history (1.0/1.0.1/noq) and the wtransport source (`with_bind_socket`, `reload_config`). Highest-leverage next step: **spike B‑1 (five-crate Android build)** — it gates every other line of this document.*
