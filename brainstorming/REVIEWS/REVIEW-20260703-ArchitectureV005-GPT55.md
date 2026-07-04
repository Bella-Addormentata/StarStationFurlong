# Review of STUDY-Architecture v005 and Updated Execution Plans
**Date:** 2026-07-04  
**Evaluator:** GPT-5.5  
**Focus:** v005 architecture, Phase 1/2 execution plans, hardware deployments, browser features, locked-network fallback, and proposals for blocking spikes

---

## 1. Executive Verdict

`STUDY-Architecture v005.md` is the strongest architecture version so far. The move from "Cabal/Hypercore as direct dependency" to "Cabal/Autobase model implemented on Rust-native primitives" is the right correction. The all-Rust node direction, with raw WebTransport for the browser pipe, `yrs` for Yjs-compatible hosting, p2panda-style append-only RoomLog, iroh for native P2P/relay/blob transport, and Chia for settlement, is coherent with the sovereignty thesis and the current repository direction.

The updated Phase 1 plan is also a meaningful improvement over the older `simple-peer`/WSS plan. It now gives Sprint 3 a concrete, smaller target: raw WebTransport + `wtransport` + Yjs/yrs sync, with RoomLog and iroh deferred behind explicit spikes.

The plan is not ready to implement blindly. The most important remaining blockers are:

1. **UDP 443 ownership:** `wtransport` and iroh cannot both casually own the same UDP port. v005 needs a port-sharing or port-splitting decision before Phase 2.
2. **Phase 2 CRDT tick state:** `stationOrbits.anomaly` and any ticking/drifting values must not be updated every frame in Yjs.
3. **p2panda maturity:** p2panda is a strong fit but explicitly pre-1.0. RoomLog needs a fallback implementation plan.
4. **iroh-WASM and relay sovereignty:** the fallback lane must not silently depend on n0 public relays, and iroh-WASM must be proven before js-libp2p is fully discarded.
5. **Station Seals are novel protocol:** this is a small but security-critical invention; it needs its own spec and adversarial tests.
6. **Chia offer books are settlement, not matching engines:** they solve double-spend settlement, but not price-time priority, order cancellation UX, or high-frequency station markets.
7. **Station-in-a-Box TLS remains hard:** local PWA hosting still needs an app-shell trust story.

Recommendation: keep v005 as the architecture baseline, but promote the above to P0/P1 gates and update Phase 2 before implementation. The best immediate path is: prove raw WT + yrs in Sprint 3, then spike RoomLog-on-p2panda and iroh adoption in parallel before committing the Phase 2 storage and relay design.

---

## 2. Sources Reviewed

Local repository and planning context:

- `brainstorming/AI BRAINSTORMING/STUDY-Architecture v005.md`
- `docs/TDD/03-Implementation/Phase1-ExecutionPlan.md`
- `docs/TDD/03-Implementation/Phase2-ExecutionPlan.md`
- `brainstorming/REVIEWS/REVIEW-20260703-ArchitectureV005-Gemini31Pro.md`
- v004 reviews from GPT-5.5, Gemini 3.1 Pro, Gemini 3.5 Flash, and Opus 4.8
- `ROADMAP.md`
- `docs/GDD/02-Core-Gameplay.md`
- `docs/TDD/02-Systems/CoreTechnology.md`
- Prototype network stubs and READMEs under `prototypes/01-core-loop-demo` and `prototypes/02-ortho-camera-demo`

GitHub tracker context checked:

- Issue #1: room classes, movable modules, space truckers, Chia custody, companies, markets, shares, whale/market safeguards.
- Issue #10: A*/Theta* navigation, 45-degree movement constraints, WASD interrupt.
- Issue #12: QR mobile phone chat, web-vs-app concern, seeders, Chrome/SSL concern, short-lived access keys.
- PR search confirms eight PRs; tool output summarized but did not list rows. Existing PR context from prior review pass covers docs/roadmap, Phase 1/2, and prototypes 01-04.

Targeted online checks:

- MDN WebTransport: Baseline 2026, `serverCertificateHashes`, LNA row, `getStats` support, worker availability, `protocol` support.
- Chrome Local Network Access post: permission prompt, public-to-private local requests, worker caveats, mixed-content exemptions, enterprise policy.
- iroh repository/docs excerpts: QUIC, hole punching, `iroh-relay`, protocol router/ALPN, `iroh-blobs`, `iroh-gossip`, licensing, current active releases.
- p2panda repository/site: Rust crates, iroh dependency, p2panda-net, p2panda-core, p2panda-auth, p2panda-encryption, p2panda-store, pre-1.0 stability warning, broadcast-only/offline-first goals.
- y-crdt/y-crdt: Yjs/Yrs compatibility, Awareness support, ywasm/yffi, feature parity table.
- chia-wallet-sdk: Rust SDK, WASM directory, bindings, Chia app scope, license and release state.
- Prior Cabal/Hypercore/Autobase checks from v004 review: Cabal seed/QR/headless mode, Hypercore signed append-only logs, Hyperswarm topic discovery, Autobase deterministic multi-writer views.

---

## 3. What v005 Gets Right

### 3.1 The Runtime Gap correction is real

v005 correctly identifies that Cabal/Hypercore/Autobase are the right conceptual model but the wrong direct implementation for a Rust/Tauri node. Avoiding an embedded Node/Bare runtime is the correct call for desktop size, Android packaging, F-Droid feasibility, security review, and operational simplicity.

### 3.2 p2panda is a plausible Rust-native RoomLog substrate

p2panda maps surprisingly well to the Cabal/Autobase-shaped need: signed per-writer logs, gossip/sync, auth groups, encryption work, SQLite storage, pruning, and iroh integration. The project is explicitly pre-1.0, but as an architecture direction behind a swappable `RoomLog` port, it is a strong fit.

### 3.3 `yrs` is the right way to host Yjs documents in the Rust node

The Yjs/Yrs compatibility story makes the live CRDT lane much cleaner. Browser clients can remain stock Yjs users while the node validates and hosts documents natively. This is exactly the kind of interoperability v005 should prefer: keep the browser ecosystem where it is strongest, and keep the node one Rust runtime.

### 3.4 The updated Phase 1 plan is appropriately narrower than full v005

Phase 1 now wisely keeps iroh and p2panda spike-gated. Sprint 3 targets raw WebTransport, a `wtransport` listener, Yjs/yrs sync conformance, awareness for positions, and a RoomLog seam. That is a sane first executable slice.

### 3.5 The storage split is the correct mental model

The v005 table separating awareness, live spatial state, social/economic logs, blobs, and settlement should become canonical. It prevents the older anti-pattern in `CoreTechnology.md` where Cabal might track positions, and it keeps Chia away from hot state.

### 3.6 Chia offers are a good settlement primitive

Using Chia offer files as gossiped settlement artifacts is a strong idea. It means the game does not need to invent a double-spend-resistant market settlement engine. That said, see the matching-engine warning in section 4.7.

---

## 4. Critical Pitfalls and Errors

### 4.1 UDP 443 port ownership is a blocking design decision

v005 wants `wtransport` on UDP 443 for browser WebTransport and iroh for the native endpoint/relay path. Those are both QUIC-based stacks. Two libraries cannot independently bind `0.0.0.0:443/udp`.

This is not a small deployment detail. It affects locked-network reachability, certificate handling, ALPN routing, metrics, firewall setup, and Station-in-a-Box.

Possible resolutions:

1. **Port split, recommended for Phase 1/early Phase 2:** `wtransport` owns UDP 443; iroh uses another UDP port plus relays. This is simplest and keeps Sprint 3 unblocked.
2. **Single QUIC endpoint with ALPN demux:** one `quinn` endpoint accepts both WebTransport/H3 and iroh ALPNs, then dispatches to handlers. This may require deep integration or upstream changes because `wtransport` and iroh may both want to own endpoint lifecycle.
3. **Ingress proxy/demux process:** one small Rust UDP 443 front process routes QUIC by ALPN/SNI/first flight where possible. Risky; QUIC is intentionally encrypted early.
4. **Only iroh on UDP 443, WebTransport elsewhere:** bad for browser primary path; not recommended.

Proposal: make the P0 spike prove option 1 and investigate option 2. Do not require shared UDP 443 before Phase 1.

### 4.2 Phase 2 stores ticking orbital state in Yjs

`Phase2-ExecutionPlan.md` currently defines `anomaly` as "current true anomaly (radians); updated each tick" in `StationOrbit`. This violates v005's own storage split. Yjs is not for per-frame values. Even if Yjs garbage collection helps, frequent updates create history, tombstones, sync churn, and reconnect cost.

Fix:

Store orbital parameters and an epoch, not the current anomaly.

```ts
interface StationOrbit {
  stationId: string;
  orbitType: OrbitType;
  parentBodyId?: string;
  semiMajorAxis?: number;
  eccentricity?: number;
  inclination?: number;
  epochMs: number;
  anomalyAtEpoch?: number;
  meanMotion?: number;
  driftState?: 'stable' | 'needs-stationkeeping' | 'burning';
  lastStationkeepingBurnMs?: number;
}
```

Clients compute current anomaly from deterministic time and parameters. Station-keeping is a discrete signed event, not a tick stream.

Same rule applies to:

- Travel progress.
- Resource regeneration timers.
- Power/repair decay.
- AI captain route progress.
- Market price curves.

Persist events and parameters; derive time-varying state locally.

### 4.3 Phase 1 has a small authority contradiction

Phase 1 says "No round-trip confirmation needed" and "no authoritative server in Phase 1," but it also introduces signed deltas and a node-side `yrs` host. For public rooms, even in Phase 1, the node should be treated as a soft authority for state mutations that affect others.

Suggested wording:

- Local movement is client-predicted.
- Remote awareness is best-effort and non-authoritative.
- Persistent room state mutations are accepted only after node validation.
- Scarce state, ownership, and capsule claims are host-sequenced even in Phase 1.

Otherwise the first capsule-claim race will teach the wrong lesson.

### 4.4 The `chat` Yjs array is a migration trap

Phase 1 keeps chat in `Y.Array`, with RoomLog later taking over. That is acceptable for the demo, but the plan should mark it as an intentionally disposable prototype path. Otherwise chat history semantics will change mid-project.

Fix:

- Add `ChatStorage = 'yjs-demo' | 'roomlog'` to the plan.
- Cap Phase 1 chat at a short session history.
- Do not promise durable chat until RoomLog exists.
- Design the UI against a `ChatProvider` interface so Yjs demo chat can be swapped for RoomLog without rewriting UX.

### 4.5 p2panda pre-1.0 is a dependency risk, not just a note

p2panda is explicitly under active development and not API-stable. v005 acknowledges this, but the implementation plan should treat it as a gated dependency with a fallback.

Proposal:

- Build a minimal `SsfLog` reference implementation in parallel with p2panda evaluation: Ed25519, BLAKE3, per-writer sequence, backlink, CBOR payload, SQLite store.
- Use p2panda if the spike proves the full stack is stable enough.
- If p2panda APIs churn, use `SsfLog` for Phase 2 and keep p2panda as a future replacement.

This does not undermine v005; it makes the `RoomLog` port real.

### 4.6 iroh-WASM must not become the new hidden third-party dependency

v005 correctly warns against n0 public relays. The browser fallback lane must not ship configured to public n0 relays by default. It also needs proof that iroh-WASM is mature enough for the target browsers and that relay-WebSocket performance is sufficient.

Gate conditions before replacing js-libp2p fallback entirely:

- Self-hosted iroh-relay works on a normal domain over TCP/TLS 443.
- Browser iroh-WASM connects through that relay from Chrome, Firefox, Safari, Android Chrome, and iOS Safari.
- It can carry RoomLog sync and asset metadata under realistic campus Wi-Fi.
- Default config refuses public n0 relays unless developer mode explicitly opts in.

### 4.7 Chia offers are not a full market UX or matching engine

Chia offers solve settlement finality and double-spend. They do not automatically solve:

- Price-time priority.
- Order cancellation propagation.
- Partially filled order UX.
- Market maker spam.
- Front-running and stale offers.
- User confusion when two takers race and one fails.
- Station-local soft credit markets.

Recommendation:

- Use Chia offers for high-value settlement.
- Use station-host sequenced order books for display, prioritization, and soft reservations.
- Treat on-chain settlement as the final truth, not the entire exchange protocol.
- Add explicit offer TTLs, cancellation messages, and stale-offer pruning in RoomLog.

### 4.8 Station Seals need a threat model

Station Seals are a good invention, but a novel one. Before implementation, specify:

- What constitutes quorum.
- How co-hosts are admitted and removed.
- What happens if quorum is unavailable.
- Whether a minority can keep an unsealed branch alive.
- How clients choose between two conflicting seals.
- How Chia anchoring resolves or fails to resolve a fork.
- How often seals occur.
- How old a client can be before it must refuse fast-forward and ask for an archive.

Proposal: define two seal levels:

- **Soft Seal:** co-host quorum only; cheap, frequent, good for pruning local logs.
- **Anchored Seal:** co-host quorum plus Chia singleton memo; slower, used for long-term canonical checkpoints.

### 4.9 Station-in-a-Box still has an app-shell TLS problem

Station-in-a-Box is one of the best outside-the-box ideas in v005, but the PWA app shell is still tricky. A captive portal over HTTP can show onboarding, but secure-context APIs like Service Worker and WebTransport require HTTPS. A self-signed local page still scares browsers unless the user installs a local CA.

Options:

- Use native Android/Tauri and desktop Tauri for full Station-in-a-Box sovereignty.
- Use a local HTTP captive page only to explain how to install/run the native app or open an already-installed PWA.
- Use a project domain with DNS-01 issued certs cached onto boxes before deployment, but admit this adds a renewal dependency.
- Use `.local` plus local CA for events/classrooms where friction is acceptable.
- Track future signed web app/IWA options separately.

Do not imply a Pi can cleanly serve a first-run production PWA over self-signed HTTPS without user ceremony.

### 4.10 Chia browser WASM still does not prove chain freshness

chia-wallet-sdk WASM is useful, but it does not by itself solve trust-minimized chain reads. A browser still needs reliable coin records and proof/freshness semantics.

Keep the three-tier model:

- Native wallet/light client: sovereign.
- Browser proof-verifying client: target, unproven.
- Browser public RPC quorum: convenience with stale-height warnings.

### 4.11 F-Droid and assets need an early audit

The Android path is only as sovereign as its build/distribution story. F-Droid main inclusion requires FLOSS source, acceptable dependencies, and compatible assets. This repo contains generated art and game media direction that may later include licenses incompatible with F-Droid main.

Proposal: create a Phase 1 asset and dependency license audit, before art and audio sprawl.

### 4.12 Docs still contain older conceptual drift

The updated Phase 1 and Phase 2 docs point to v005, but older docs still mention `simple-peer`, WebTorrent, and Cabal-for-positions. `docs/TDD/01-Architecture.md` and some prototype READMEs are now historical and should be clearly marked as superseded or updated.

---

## 5. Locked-Network Strategy Improvements

v005 has the right ladder. These additions make it more operational.

### 5.1 The bridge kit should be a deliverable

Ship a `ssf-bridge-kit` for community relays:

- `iroh-relay` with a known config.
- Caddy or another TLS terminator where needed.
- Optional coturn for WebRTC voice fallback over `turns:443`.
- Rate limits and logs.
- Chia registry advertisement command.
- A one-page "run a comms relay" guide.

This makes "anyone can run the bridge" true in practice.

### 5.2 TURN/TLS remains needed for voice

iroh-relay helps RoomLog/assets/control traffic. It does not replace WebRTC media relay unless voice/video is also tunneled through another layer. For proximity voice, keep `turns:` over TCP 443 as a separate optional relay path.

### 5.3 Use IPv6 as a first-class path

Universities often have better IPv6 than home networks. The network matrix should explicitly test IPv6 direct reachability, IPv6 firewall behavior, and whether iroh or raw WT succeeds better over IPv6.

### 5.4 Captive portal detection should be user-facing

On hotels/campuses, failures often come from captive portals, not the game. Add a preflight step:

- Detect captive portal / DNS hijack symptoms.
- Show a comms setup screen.
- Retry transport after the portal is cleared.

### 5.5 Policy-safe circumvention only

Keep rejecting covert DNS tunneling and domain fronting as core design. Prefer user-deployed bridges, MASQUE/CONNECT-UDP research, store-and-forward, and Station-in-a-Box.

---

## 6. Additional Browser and Web Platform Features

### 6.1 Isolated Web Apps / signed web app packaging

This is worth watching for the app-shell trust problem. If browser-supported signed packages mature, they may offer a better web-first-load story than a mutable HTTPS origin. Treat as research only; do not depend on it.

### 6.2 Page Lifecycle API

Use `visibilitychange`, page freeze/resume where available, and Web Locks to gracefully lower tick/heartbeat rates and relinquish transient leadership before a tab freezes.

### 6.3 WebRTC Encoded Transform

For proximity voice relayed through TURN/SFU/SFM paths, encoded transforms are more relevant than WebCodecs alone. They allow E2EE media transforms while relays forward opaque frames.

### 6.4 OPFS SyncAccessHandle in Workers

For blobs, station crates, and local RoomLog bundles in the browser, OPFS worker access can reduce main-thread jank. Keep identity keys export-backed; do not trust OPFS alone.

### 6.5 Web Share Target, File Handling, protocol handlers

Use these for:

- Room invites.
- Chia offer files.
- Station crates.
- Encrypted identity backups.
- `web+ssf:` links for phone/desktop handoff.

### 6.6 CompressionStream and structured clone transferables

Use CompressionStream for RoomLog export bundles, station crates, and QR chunk payloads. Use transferables for WT datagram buffers between main thread and workers.

### 6.7 Network Information API, cautiously

Where available, use it only for adaptive UX hints, not decisions that break privacy or exclude players.

### 6.8 WebUSB/WebSerial/WebHID

Good later-phase hardware immersion: physical SpacePhone props, HOTAS controls, LED station panels, hardware wallets. Non-critical and explicit permission only.

### 6.9 WebNN/WebGPU local AI

Later-phase local AI can support station assistants, robotic captains, moderation hints, voice cleanup, and NPC dialogue. Keep all cloud AI off the critical path.

---

## 7. Phase 1 Plan Review

Phase 1 is mostly aligned with v005 and should proceed if these clarifications are made:

1. Keep iroh and p2panda out of Sprint 3 implementation, except for interface stubs and spike branches.
2. Do not bind UDP 443 by default during local dev unless running with sufficient privilege; use `127.0.0.1:4443` and a dedicated reachability spike for UDP 443.
3. Change "no authoritative server" wording to "node-soft-authoritative for persistent room state; client-predicted for local movement."
4. Mark Yjs chat as session/demo storage until RoomLog exists.
5. Add explicit browser support matrix creation to Sprint 3 pre-work.
6. Include QR/phone capability skeleton early, even if UI lands later, because Issue #12 is a near-term product test of the architecture.

---

## 8. Phase 2 Plan Review

Phase 2 needs revision before implementation.

### 8.1 Replace ticking CRDT fields with deterministic simulation

Do not update `anomaly` each tick. Store parameters and event epochs. The same applies to asteroid regeneration and travel progress.

### 8.2 Host-sequence scarce extraction and station placement

The plan already notes rare nodes must be host-sequenced. Extend this to:

- Station placement.
- Module attachment/removal.
- Ownership-sensitive edits.
- Any scarce resource extraction.

Common cosmetic edits can be CRDT. Scarce/economic edits need signed host results.

### 8.3 Add RoomLog to Phase 2 objectives

Phase 2 is the right time to promote RoomLog from stub to minimal implementation for:

- Bulletin boards.
- Chat history.
- Contract postings.
- Station seals.

Do not wait until economy phase; otherwise Phase 2 will deepen Yjs persistence in ways that later need migration.

### 8.4 Clarify module ownership and Chia anchoring

Snap-on modules are a direct continuation of Issue #1's movable room/module custody idea. Phase 2 should define:

- Demo-only CRDT module ownership.
- Later Chia-backed module deed path.
- How a module loaded onto a freighter is represented off-chain and later anchored.

### 8.5 Solar-system doc scope needs sharding

A single solar-system-level Yjs doc can become too large if it holds every station, asteroid, route, market, and map annotation. Add sharding now:

- `solar-index` for stable summaries and discovery.
- Per-zone docs for local resources and players.
- RoomLog topics for durable posts/contracts.
- Chia anchors for station ownership and seals.

---

## 9. Proposals for Blocking and Spiked Items

### P0-1: UDP 443 coexistence decision

Goal: prove whether `wtransport` and iroh can share UDP 443 or must use separate ports.

Plan:

1. Build a minimal `wtransport` server on UDP 443.
2. Build a minimal iroh endpoint on a second port.
3. Attempt a single-port QUIC/ALPN prototype only if library APIs permit endpoint injection.
4. Decide: port split for MVP, shared endpoint later, or no shared endpoint.

Deliverable: a one-page decision with code and packet captures.

Recommended default: port split for MVP.

### P0-2: Deterministic simulation patch for Phase 2

Goal: remove ticking CRDT state.

Plan:

1. Replace `anomaly` tick updates with `epochMs`, orbital params, and deterministic calculation.
2. Define event messages for station-keeping burns.
3. Add tests that a station orbit doc does not grow after one simulated hour.

### P0-3: WT + yrs Sprint 3 executable slice

Goal: prove the core Phase 1 network lane.

Plan:

1. Browser dials `wtransport` with cert hash.
2. Datagrams carry ping and awareness.
3. Stream carries y-sync state-vector handshake.
4. Node validates signed envelope before applying Yjs updates.

No iroh, no p2panda, no Chia.

### P1-1: RoomLog substrate bakeoff

Goal: decide p2panda vs custom `SsfLog` fallback.

Plan:

1. Implement the same chat/bulletin-board log in p2panda and custom `SsfLog`.
2. Test 3 co-hosts, 1 flapping mobile, and pruning behind a fake seal.
3. Compare API churn risk, binary size, performance, and Android build behavior.

### P1-2: iroh relay sovereignty gate

Goal: prove self-hosted iroh relay can replace bespoke WSS bridge for fallback control traffic.

Plan:

1. Run self-hosted relay with no public n0 fallback.
2. Browser iroh-WASM connects through relay.
3. Native iroh connects direct and relayed.
4. Kill relay/DNS/DHT one at a time and record behavior.

### P1-3: Station Seal mini-spec

Goal: make the novel protocol auditable.

Plan:

1. Define exact serialized form.
2. Define quorum selection and conflict resolution.
3. Define soft vs anchored seal.
4. Write adversarial cases: split quorum, stale seal, malicious co-host, missing archive.

### P1-4: Chia offer market UX spike

Goal: prove offer-file market flow is playable.

Plan:

1. Maker posts offer to RoomLog.
2. Two takers race.
3. One settles; one fails cleanly.
4. UI shows stale/filled/cancelled state.
5. Fees and latency are measured.

### P1-5: Station-in-a-Box TLS/app-shell spike

Goal: decide how a fresh phone loads the app from a Pi.

Plan:

1. Captive portal HTTP explainer.
2. Already-installed PWA path.
3. Native Android APK path.
4. Local CA path for events.
5. DNS-01 cached cert path.

Deliverable: choose one recommended UX for playtests.

### P1-6: F-Droid and asset audit

Goal: avoid painting the Android path into a packaging corner.

Plan:

1. Audit current and planned dependencies.
2. Decide asset license rules.
3. Verify no auto-downloaded executable modules in F-Droid build.
4. Build a minimal Tauri Android APK in a clean environment.

---

## 10. Outside-the-Box Ideas

### 10.1 Station-in-a-Box as onboarding hardware

Turn the architecture into a physical demo kit: Pi, Wi-Fi AP, local station, QR join, preloaded room logs, and local assets. This is useful for classrooms, conventions, dorms, and internet outages.

### 10.2 SpacePhone as a network instrument

Use topic secrets like radio frequencies. Doors, maps, and station terminals reveal frequencies. The phone UI literally tunes into nearby room logs and comms channels.

### 10.3 Data cargo as gameplay

RoomLog bundles can be carried by ships. Remote stations receive contracts, mail, offers, and map updates when data couriers dock. This turns store-and-forward networking into a frontier logistics mechanic.

### 10.4 Archivist and notary professions

Players can run archivist nodes that pin old RoomLogs and notary nodes that countersign Station Seals. This makes infrastructure visible and valuable without centralizing it.

### 10.5 Offer files as physical paper

Chia offers can be represented as in-world contracts: QR codes on bulletin boards, printed tickets, shipping manifests, stock certificates, station deeds.

### 10.6 Emergency low-tech mode

If realtime fails, keep a player in a low-tech mode: printed maps, bulletin boards, contract pickup/dropoff, crafting queues, local chat, and sneakernet sync.

---

## 11. Recommended Amendments

### Architecture v005

1. Add a port ownership section for UDP 443.
2. Add a p2panda fallback plan with custom `SsfLog`.
3. Split Station Seals into soft and anchored seals.
4. Clarify iroh-WASM is fallback and must be self-hosted relay only by default.
5. Add an explicit market UX layer above Chia offers.
6. Add Station-in-a-Box app-shell trust options.
7. Add Chia browser proof-verification as still unresolved despite wallet SDK WASM.

### Phase 1 execution plan

1. Clarify node-soft-authoritative persistent state.
2. Mark Yjs chat as demo/session storage.
3. Add BrowserSupportMatrix as a Sprint 3 deliverable.
4. Keep UDP 443 as a spike, not default dev bind.

### Phase 2 execution plan

1. Remove ticking `anomaly` updates from Yjs.
2. Shard solar-system state.
3. Move RoomLog from future concept into Phase 2 for boards/contracts/chat.
4. Host-sequence scarce resources, module attachment, station placement, and ownership changes.
5. Add Chia custody path for modules and room transfer history as a later step.

---

## 12. Final Recommendation

v005 should remain the new architecture baseline. It solves the Runtime Gap, simplifies the native node, and gives the project a plausible path from browser prototype to sovereign desktop/mobile infrastructure.

The immediate engineering bar should be higher than "start coding the full stack." First prove the small executable core: raw WebTransport certhash dial, ping/awareness datagrams, y-sync with `yrs`, and signed-envelope validation. In parallel, de-risk the two new architectural bets: p2panda RoomLog and iroh relay/fallback. Then patch Phase 2 so it follows v005's storage rules instead of accidentally putting tick simulation back into Yjs.

The plan is exciting because it is no longer just a pile of decentralization nouns. It has seams, fallbacks, and product roles. The remaining work is to turn the unproven seams into measured spikes and to keep the docs ruthless about what is demo state, what is durable state, and what is settlement state.