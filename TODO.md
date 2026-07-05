# 📋 StarStationFurlong — TODO

> **How to use this file:** work items live in the sections below, roughly in priority order. When something finishes, **move it to [✅ Done](#-done) with the date** — don't delete it. Deep context for every item lives in [STUDY-Architecture v006](brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) (§ references below) and the [Phase execution plans](docs/TDD/03-Implementation/README.md). Spike numbers = v006 §15.1; pitfall numbers (P‑x) = v006 §13.

---

## 🎯 Now — the critical path (in order)

- [ ] **Trust & Safety design note** (spike #12, P‑15) — flows, room-class defaults, denylist governance, legal review. **Hard gate: RoomLog cannot leave stub / no UGC ships without it** (v006 §7).
- [ ] **Spike #3 · RoomLog substrate bakeoff** — same chat/board workload on p2panda vs `SsfLog` (spec: v006 §12.3); 3 co-hosts + flapping phone; pruning behind a fake seal; Android SQLite behavior (P‑17). Decides the P‑2′ headline bet.

## 🧪 Spike backlog (v006 §15.1 — after the critical path)

- [ ] **#4 · Station Seals v2 mini-spec + prototype** — FROST t-of-n, equivocation/liveness/prune-then-need property tests, soft→anchored flow on testnet11 (Phase 3 protocol, de-risk earlier)
- [ ] **#6 · iroh sovereignty gate** — self-hosted-relay-only drill (kill DNS / relay / DHT, record survival); iroh-WASM fallback-lane maturity vs the 1.0 JS bindings (P‑3, P‑4)
- [ ] **#7 (B‑7) · chia-wallet-sdk WASM audit** — per-driver browser surface (Offers, Vaults/MIPS, Bulletin, XCHandles) vs the ~6-months-stale bindings (P‑19); go/no-go on browser light-verification (P‑9)
- [ ] **#8 · Market floor prototype** — host-sequenced matched book + two-taker race on testnet11: one settles, one fails cleanly, UI shows stale/filled/cancelled (v006 §5.3)
- [ ] **#9 · Station-in-a-Box trust decision** — test the four §5.2 lanes (native-first / baked DNS‑01 cert / local CA / IWA) with real phones; pick the playtest default
- [ ] **#10 · Voice mesh pre-work** — 4-way WebRTC mesh brokered over the node pipe + `PannerNode` spatialization (v006 §9; Phase 2 pre-work)
- [ ] **#11 · ECH relay spike** — self-hosted iroh-relay behind Encrypted Client Hello vs an SNI-filtering test network (v006 §11)

## 🛠️ Phase 1 gameplay work (besides Sprint 3)

- [ ] Sprint 2 — multi-room system, interactable objects, station mini-map ([plan](docs/TDD/03-Implementation/Phase1-ExecutionPlan.md#-sprint-2-room-interaction--station-map-week-3-4))
- [ ] Sprint 4 — chat UI (`ChatProvider`, session-capped demo), onboarding sequence, **host-sequenced** capsule claiming, polish/audio
- [ ] [Issue #8](https://github.com/Bella-Addormentata/StarStationFurlong/issues/8) — character model demo
- [ ] [Issue #12](https://github.com/Bella-Addormentata/StarStationFurlong/issues/12) — QR phone chat: capability skeleton early (challenge-bound QR, zxing-wasm decode), full UI later

## 📐 Design artifacts owed

- [ ] **Market engine spec** — price-time priority, TTLs, cancels, partial fills, whale/strategic-reserve rules (v006 §5.3/§12.4 is a sketch; Issue #1 economics)
- [ ] **F-Droid + asset/dependency license audit** — before art/audio sprawl corners the sovereign-Android distribution (GPT‑5.5 v005 §4.11)
- [ ] **Key-loss / social recovery UX** — FROST recovery-council flow tested with non-technical users; mandatory-export-before-sole-custody onboarding (v006 §10.3)
- [ ] **Topic-secret re-key procedure** — epochal rotation implementation notes (v006 §7.4, P‑18)
- [ ] **Malicious-host / anti-cheat note** — deterministic-replay adjudication from signed intents (v006 §10.3; Phase 3+)

## 🔁 Recurring / process

- [ ] **Hand off v006 + plans to the reviewer panel** for the implementation-readiness pass (impending)
- [ ] **Re-verify [BrowserSupportMatrix.md](docs/TDD/BrowserSupportMatrix.md) before every networking sprint** and stamp the `Checked` column (P‑11 — the LNA row rotted in one day once already)
- [ ] After B‑1: keep `Cargo.lock` committed; consider `cargo vendor` for F-Droid reproducibility (P‑2′)
- [ ] Sprint retrospectives update the Phase plans (per [03-Implementation/README](docs/TDD/03-Implementation/README.md) workflow)

## ⏳ Phase 2 horizon (gated — don't start early)

- [ ] RoomLog minimal for boards/contracts — **gated on spike #3 + the T&S note** ([Phase 2 plan](docs/TDD/03-Implementation/Phase2-ExecutionPlan.md))
- [ ] iroh backbone adoption — gated on B‑1 + spike #6
- [ ] Proximity voice (mesh ≤6) — gated on spike #10
- [ ] Solar-system map with derive-don't-tick orbital schema (already specified in the Phase 2 plan)
- [ ] Chia custody path for modules/deeds (Issue #1 lineage; chia-wallet-sdk vaults)

---

## ✅ Done

*Move finished items here with a date — newest first.*

- **2026‑07‑05** — **v0.6.0 prepared: click-to-sit navigation**: chairs/sofas are clickable sit targets — A* approach to the seat front, back-to-chair turn, scripted sit slide (`sit_chair` rig pose), stand-up-then-resume on WASD or a new destination; 18 seats in shared [seats.ts](prototypes/0.6.0-core-loop-demo/src/seats.ts). Game forked to [0.6.0-core-loop-demo](prototypes/0.6.0-core-loop-demo/) (carrying the bootstrap-networking + Tab-phone work), versions bumped, `RELEASE_FRONTEND` repointed; 0.5.0 folder frozen at the shipped release.
- **2026‑07‑05** — **Network bootstrapping + connection transparency**: "host" language dropped — every node seeds by default (binds 0.0.0.0); panel now has **Bootstrap Link** (mint a `?seed=` from your OWN node fingerprint + reachable address, no prior connection), **Self-Test** (dial your own node from the browser; hairpin caveat surfaced for public addresses), and live rows for **Net Type** (Network Information API, CGNAT hint on cellular), **Address Type** (loopback/LAN/public), **Seeding** (verified/untested/join-only/blocked/restricted). Failed remote dials flag likely UDP/QUIC-filtered networks (campus/office). Interim until Chia peer publishing. ([0.5.0-core-loop-demo](prototypes/0.5.0-core-loop-demo/src/main.ts))
- **2026‑07‑05** — **v0.5.0 shipped**: installers for Windows/macOS/Linux published on the [v0.5.0 release](https://github.com/Bella-Addormentata/StarStationFurlong/releases/tag/v0.5.0). Release pipeline hardened: single shared draft created up-front (stale-draft cleanup), matrix uploads by releaseId (fixes the tauri-action draft-lookup race).
- **2026‑07‑05** — **Version-prefixed prototype folders**: demos renamed to `<release-version>-<name>` — original game frozen at [0.0.1-core-loop-demo](prototypes/0.0.1-core-loop-demo/), [0.0.2-ortho-camera-demo](prototypes/0.0.2-ortho-camera-demo/), [0.0.4-navigation-demo](prototypes/0.0.4-navigation-demo/); the updated (ported) game copied to [0.5.0-core-loop-demo](prototypes/0.5.0-core-loop-demo/) = current release target (`RELEASE_FRONTEND` in [release.yml](.github/workflows/release.yml)). Next release line = copy the folder forward (workflow documented in [prototypes/README.md](prototypes/README.md)).
- **2026‑07‑04** — **v0.5.0: game ported to demo-04 layout & navigation** ([Issue #10](https://github.com/Bella-Addormentata/StarStationFurlong/issues/10) / [PR #11](https://github.com/Bella-Addormentata/StarStationFurlong/pull/11)): [`0.5.0-core-loop-demo`](prototypes/0.5.0-core-loop-demo/) now uses the locked orthographic camera, one-click entry, hybrid WASD + point-and-click A* navigation with the post-review fixes (shared `obstacles.ts`, `hud.ts` module, two-pass waypoint collision), right-wall-free lobby layout, and NPC removed. Versions bumped to 0.5.0; [CHANGELOG.md](CHANGELOG.md) added (v0.5.0 notes include the PR #17 network status info box) and the release workflow now publishes release notes from it.
- **2026‑07‑04** — **Sprint 3 implementation**: Completed the critical path networking implementation from [Phase 1 plan](docs/TDD/03-Implementation/Phase1-ExecutionPlan.md#-sprint-3-multiplayer-networking-week-5-6):
  - **Task 3.1 (`wt_listener.rs`):** Programmed a multi-threaded Rust WebTransport listener using `wtransport` inside [prototypes/0.5.0-core-loop-demo/src-tauri/](prototypes/0.5.0-core-loop-demo/src-tauri/src/wt_listener.rs) with auto-rotating P-256 self-signed ECDSA identities of duration $\le 14$ days, custom multiplexing of reliable channels, and direct UDP datagram frame broadcasting.
  - **Task 3.2 (`NetworkProvider.ts`):** Implemented a browser-side raw WebTransport dialer using standard `new WebTransport(url, { serverCertificateHashes })`, fully conforming to Chromium private LAN dial LNA context rules, carrying ticks over unreliable datagrams, and mapping reliable stream channels.
  - **Task 3.3 (`YjsSync.ts`):** Developed a conforming state-vector re-handshake engine over bidirectional streams using standard Yjs updates and VarInt encoding, ensuring correct yrs state merging on reconnects.
  - **Task 3.4 (Optimizations & Comms HUD):** Programmed client-side predictions, 13-byte packed datagram movement ticks, remote custom player sphere spawns under `world.ts`, and updated `index.html` to integrate real-time RTT / loss Comms Weather metrics from in-flight ping-pong loops.
- **2026‑07‑04** — **Spike #5 · yrs ⇄ Yjs conformance**: Built the conformance WebSocket coordinator and ESM browser harness under [spikes/b5-yrs-yjs-conformance](spikes/b5-yrs-yjs-conformance/README.md). Proved direct wire sync between yrs and Yjs, structural VarInt formats, Read/Write transaction lock constraints, and verified that Awareness must be limited to discrete presence only (avoiding continuous movement state replication).
- **2026‑07‑04** — **Spike #2 · WebTransport certhash dial matrix**: Structured and completed under [spikes/b2-wt-certhash-dial](spikes/b2-wt-certhash-dial/README.md). Built a robust, compilable Axum + `wtransport` server and modern frontend testing harness to prove:
  - **Certhash compliance:** Verified ECDSA P-256 certificate hashing dynamically mapped and supplied automatically over REST endpoints for a zero-downtime, fully automated user experience.
  - **Zero-Downtime Cert Rotation:** Tested and verified the `reload_config(config, false)` API. Hot-swapping certificates on active pipelines keeps existing datagram and stream sessions completely intact while redirecting new dials immediately to the newly generated fingerprint.
  - **Handshake Echo loops:** Programmed and verified UDP datagram echo loops and TCP stream read/write loops, asserting instant packet processing.
  - **LNA constraints:** Mapped behavior against Chromium Local-Network-Access policies, outlining why the primary dial must be initiated from page context (e.g. main thread) prior to background execution under worker threads.
- **2026‑07‑04** — **Spike B‑1 · Five-crate build gate**: Ran [spikes/b1-five-crate-build](spikes/b1-five-crate-build/README.md) on Windows GNU toolchain. Identified a definitive pre-release dependency conflict on `ed25519-dalek` version requirements between `p2panda 0.6.1` (which requires `3.0.0-pre.6`) and `iroh 1.x` (which requires `3.0.0-rc.0`), verifying that these crates cannot compile together in the same binary. This triggers the **NO-GO on p2panda**, activating the architected **SsfLog all-Rust fallback** path (v006 §5.4 / §12.3). The non-p2panda core all-Rust stack (iroh 1.0.1 + yrs 0.27 + wtransport 0.6 + chia-wallet-sdk 0.33) compiles and checks flawlessly on desktop under the GNU toolchain.
- **2026‑07‑04** — Root repo cleanup: README tech list split current-vs-superseded; [docs/API/01-CodeReferences.md](docs/API/01-CodeReferences.md) turned into the real dependency table; TDD implementation README repointed to v006; prototype 02 `simple-peer` purged; ROADMAP networking line updated.
- **2026‑07‑04** — Code scaffolding: [protocol.ts](prototypes/0.5.0-core-loop-demo/src/network/protocol.ts) (v006 contracts as compile-checked TS + working 13-byte tick codec), typed `NetworkProvider`/`YjsSync`/`RoomLog` skeletons, [spike B‑1 project](spikes/b1-five-crate-build/README.md) scaffolded and runnable, `y-protocols`/`y-indexeddb` added, `simple-peer` removed from prototype 01.
- **2026‑07‑04** — Handoff pass on the execution plans: B‑1 + renumbered spikes in Sprint‑3 pre-work, [BrowserSupportMatrix.md](docs/TDD/BrowserSupportMatrix.md) created and wired in, RoomLog promoted to a Phase‑2 objective (T&S-gated), voice-mesh pre-work added, zxing-wasm QR decision recorded, superseded banners on [01-Architecture.md](docs/TDD/01-Architecture.md) + [CoreTechnology.md](docs/TDD/02-Systems/CoreTechnology.md).
- **2026‑07‑04** — **[STUDY-Architecture v006](brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md)**: adjudicated all four v005 reviews; verified iroh 1.0 + the noq fact (port-split ruled final); resolved the four blockers (UDP‑443, Station-in-a-Box secure context, ticking-CRDT state, two-tier markets); added Trust & Safety + voice subsystems; Station Seals v2 threat model; fixed the positions-through-Awareness and orbital-anomaly bugs in the Phase 1/2 plans.
- **2026‑07‑04** — Four independent reviews of v005 received (GPT‑5.5, Gemini 3.1 Pro, Gemini 3.5 Flash, Opus 4.8) in [brainstorming/REVIEWS](brainstorming/REVIEWS/).
- **2026‑07‑04** — **[STUDY-Architecture v005](brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v005.md)**: found the Runtime Gap (Cabal/Autobase stack is JS-only), proposed the all-Rust node (iroh + p2panda + yrs + wtransport + chia-wallet-sdk), Station Seals, Chia-offer markets; Phase 1/2 plans moved off `simple-peer`/WSS-signaler onto WebTransport certhash; `RoomLog.ts` port stub created.
- **2026‑07‑03** — **STUDY-Architecture v004** (platform verification pass: WebTransport Baseline 2026 incl. Safari 26.4, two trust lanes, Tauri-Android sovereign path) + four reviews; v003 (cert-hash pinning discovery) + three reviews.
- **2026‑06‑20** — Prototype [0.0.2-ortho-camera-demo](prototypes/0.0.2-ortho-camera-demo/) (orthographic locked camera) — [Issue #6](https://github.com/Bella-Addormentata/StarStationFurlong/issues/6) closed.
- **2026‑06‑15** — Sprint 1 Tasks 1.1–1.2: Vite + Three.js project init, orthographic scene, cinematic intro, WASD movement, debug HUD ([0.0.1-core-loop-demo](prototypes/0.0.1-core-loop-demo/)).
- **2026‑06‑14** — [Issue #1](https://github.com/Bella-Addormentata/StarStationFurlong/issues/1) ideas (CubeSat room classes, module custody, markets/shares, whale safeguards) researched and integrated into the GDD/TDD — closed.
- **2026‑06 (early)** — Repo professionalization: ROADMAP, GDD/TDD structure, Phase 1–5 execution plans, STUDY-Architecture v002 (the sovereignty-first layered blueprint).
