# Review of STUDY-Architecture v004
**Date:** 2026-07-03  
**Evaluator:** GPT-5.5  
**Focus:** Sovereign serverless mechanics, desktop/mobile deployment, locked-network resilience, browser capabilities, and Cabal/Hypercore-style shared hosting

---

## 1. Executive Verdict

`STUDY-Architecture v004.md` is a major improvement over v003. It fixes the most important false assumption from v003: WebTransport certificate-hash pinning is a node-transport trust mechanism, not a universal browser app-hosting solution. It also correctly separates app-shell trust, node-transport trust, identity, room authority, relay policy, and settlement. The Android/Tauri addition is especially important: a sideloaded or F-Droid-distributed Android APK gives the project a real sovereign mobile path instead of forcing every phone through a web-first-load dependency.

The plan is now plausible, but several implementation pitfalls remain:

1. The App Manifest Ledger is useful for native clients and post-install web updates, but it cannot protect a brand-new web user from compromised first-load JavaScript.
2. Passkey key wrapping depends on WebAuthn PRF support; standard passkeys only sign challenges.
3. The raw WebTransport primary path means browser clients are not libp2p peers on the primary transport; the Tauri node becomes a protocol bridge and policy engine.
4. Android can be a sovereign client, but it should not be treated as a reliable room host except in a deliberately foreground, charging, opt-in mode.
5. F-Droid is plausible but not automatic. The build must be fully FLOSS, reproducible enough for F-Droid review, and free of auto-downloaded executable updates unless users explicitly opt in.
6. Cabal/Hypercore-style shared hosting is a strong missing idea, but the right adoption is architectural: append-only signed room logs and native seeders. Do not directly depend on the old Cabal stack for core game networking.

Recommendation: accept v004 as the new direction, then add a v005 section for "Room Durability and Shared Hosting" that borrows from Cabal/Hypercore: per-writer append-only logs, native seeding, subjective moderation, and deterministic materialized views. Keep soft host authority for low-latency movement, but make room history and bulletin/chat data multi-host and resilient.

---

## 2. Sources Reviewed

Local repository and planning context:

- `brainstorming/AI BRAINSTORMING/STUDY-Architecture v004.md`
- `brainstorming/REVIEWS/REVIEW-20260703-ArchitectureV004-Gemini31Pro.md`
- `brainstorming/REVIEWS/REVIEW-20260703-ArchitectureV003-GPT55.md`
- `brainstorming/REVIEWS/REVIEW-20260703-ArchitectureV003-Gemini31Pro.md`
- `brainstorming/REVIEWS/REVIEW-20260703-ArchitectureV003-Gemini35Flash.md`
- `ROADMAP.md`
- `docs/TDD/03-Implementation/Phase1-ExecutionPlan.md`
- `docs/TDD/02-Systems/CoreTechnology.md`
- `docs/GDD/02-Core-Gameplay.md`
- Prototype network stubs and README references under `prototypes/01-core-loop-demo` and `prototypes/02-ortho-camera-demo`

GitHub issue/PR context checked:

- Issue #1: rooms, room logistics, companies, spaceports, Chia custody, markets, shares.
- Issue #10: point-and-click/A* navigation, WASD interrupt, pathing constraints.
- Issue #12: QR mobile phone chat, door list, web-vs-app question, seeders, SSL concern, short-lived access keys.
- PR history summarized via the tracker: docs/roadmap professionalization, Phase 1/2 plans, core-loop demo, camera demo, character demo, navigation demo.

Targeted online checks:

- Cabal CLI and `cabal-core`: QR join, headless `--seed`, custom port, replication stream, subjective moderation, AGPL core.
- Hypercore/Hyperswarm/Autobase docs: signed append-only logs, sparse replication, Merkle proofs, topic discovery, encrypted peer connections, multi-writer deterministic views.
- Tauri v2 docs: mobile target prerequisites, Android build/distribution path.
- F-Droid docs: FLOSS inclusion policy, build metadata, source-build expectations, anti-features, APK signing-key verification.
- Android docs: foreground service notification requirements, Doze/App Standby network suspension, battery optimization constraints.
- MDN WebAuthn extensions: PRF extension is the browser mechanism for deriving symmetric keys from passkeys; compatibility is uneven.
- MDN WebRTC protocols and `RTCPeerConnection`: STUN/TURN, relay-only policy, ICE server configuration, SFU/SFM complexity.

---

## 3. What v004 Gets Right

### 3.1 The two-lane trust model is the right correction

v004's split between app-shell trust and node-transport trust is the biggest architectural improvement. `serverCertificateHashes` authenticates a WebTransport session after trusted code is already running. It does not make a bare-IP player node a clean production PWA host. That distinction should stay central.

### 3.2 Raw WebTransport primary, webRTC-direct fallback is the right Rust-compatible interop story

v004 corrects v003's libp2p-over-WebTransport assumption. Given the current Rust libp2p ecosystem, the practical split is:

- Browser primary: raw WebTransport to a Rust `wtransport` server, using StarStationFurlong's own framing and protocol.
- Browser fallback/swarm membership: libp2p webRTC-direct to `rust-libp2p`'s WebRTC transport.
- Native backbone: `rust-libp2p` QUIC/gossipsub/Kademlia/Relay/DCUtR.

This is not as elegant as "one libp2p stack everywhere," but it is buildable.

### 3.3 Android native closes a real sovereignty gap

The Android APK path matters because Issue #12 is explicitly about phones. A Tauri Android client can bundle its code, avoid first-load Web PKI, and use the Rust core directly. This creates a true mobile sovereignty path for Android, with iOS remaining the honest platform asterisk.

### 3.4 Degraded network modes fit the game design

The `TransportMode` ladder aligns well with the roadmap and GDD. StarStationFurlong is not only twitch movement. It has chat, bulletin boards, contracts, crafting queues, markets, station logistics, and map access. Store-and-forward and relayed-reliable modes can still support meaningful play.

### 3.5 Cabal is already in the project's design DNA

`docs/TDD/02-Systems/CoreTechnology.md` explicitly mentions Cabal Club for short-term chat and position tracking, with room chats and bulletin boards. v004 does not fully integrate that older Cabal idea yet. The request to reconsider Cabal/Hypercore is not a tangent; it reconnects the new transport plan to an original design thread.

---

## 4. Remaining Errors and Pitfalls

### 4.1 The App Manifest Ledger cannot secure first-load web JavaScript

v004 is careful to say the manifest ledger does not solve first-load trust, but it still risks sounding stronger than it is. A compromised canonical web origin can serve JavaScript that simply skips the ledger check, lies about the result, or installs a hostile Service Worker. Web clients cannot reliably verify the integrity of the verifier if the verifier is delivered by the compromised channel.

The ledger is strong for:

- Native/Tauri updates, because the verifier is bundled and already trusted.
- Post-install PWA updates, assuming the currently installed Service Worker/verifier was not compromised.
- Multi-mirror consistency checks after initial trust exists.

It is weak for:

- A brand-new web user loading the app for the first time.
- A user whose installed Service Worker was already compromised.

Improvement: v004 should name the web ledger as "post-install update integrity," not "web first-load integrity." For web first-load, the honest answers are a canonical HTTPS origin, a native wrapper, or a future browser-supported signed web bundle model.

### 4.2 Passkey key wrapping depends on WebAuthn PRF

v004 says passkeys wrap/unlock a portable game key. Standard WebAuthn signs challenges; it does not decrypt local data. The browser path for deriving a symmetric wrapping key is the WebAuthn PRF extension.

MDN documents `prf` as the extension that lets a relying party get deterministic PRF outputs from a credential, useful for generating a symmetric key for encryption. Compatibility is uneven: Chrome/Edge/Opera and Safari support meaningful pieces, Firefox support is newer, Firefox for Android lacks the PRF path in the checked table, and Android WebView support is absent in the checked MDN table.

Implication: passkey wrapping must be feature-detected and optional.

Fallbacks:

- OS keychain via Tauri/native.
- User password/passphrase with Argon2id/PBKDF plus explicit backup warnings.
- Hardware wallet / WebHID/WebUSB where available.
- Encrypted recovery file exported through File System Access or native save dialogs.
- QR-based one-time device transfer from an already trusted device.

Do not make passkey PRF the only way to unlock identity on web or Android WebView.

### 4.3 Raw WebTransport creates a bridge, not one unified network

The primary browser path is not a libp2p peer. That means the player's Tauri node must translate between:

- Raw WebTransport streams/datagrams from browser clients.
- Native libp2p gossipsub/DHT/relay messages.
- Room-host validation and Yjs update policy.
- Asset chunk service.
- Capability-token checks.

This can work, but it is a protocol bridge with stateful policy, not a transparent adapter. It creates risks:

- Duplicate message IDs across raw WT and gossipsub paths.
- Loops when a browser-originated message is bridged to gossipsub and returns.
- Inconsistent backpressure between WebTransport streams and gossipsub topics.
- Divergent authorization logic between native and browser paths.
- Harder debugging when a browser client is "connected" but not a true swarm peer.

Improvement: define a single application-level envelope used on both transports:

```ts
type SsfEnvelope = {
  protocol: 'ssf-room/1';
  roomId: string;
  msgId: string;
  parentIds?: string[];
  author: string;
  seq: number;
  capability?: string;
  kind: 'intent' | 'host-result' | 'yjs-update' | 'chat' | 'asset-request' | 'asset-chunk';
  payload: Uint8Array;
  sig: Uint8Array;
}
```

Bridge by envelope, not by ad hoc per-feature translations.

### 4.4 Android native is a client, not a dependable infrastructure node

v004 says relay/seed is off by default on mobile, which is correct. It should go further: Android should not be a default room host either, except for explicitly temporary foreground sessions.

Android Doze/App Standby can suspend network access. Foreground services require visible notifications and should only be used for tasks noticeable to the user. A user switching away from the app can pause the room host, trigger host migration, then return and create split-brain/conflict churn.

Improvement:

- Android may host only in `temporary-host` mode.
- The UI should show "hosting while screen is active" plainly.
- If Android backgrounds for more than a short grace period, it should voluntarily demote itself before peers declare it dead.
- Add a host-migration-thrash test that simulates 5, 15, 60, and 300 second Android background pauses.
- Keep persistent station hosting as desktop/headless by default.

### 4.5 F-Droid is not just "APK distribution"

F-Droid main-repo inclusion requires FLOSS licensing, source availability, buildability, review, and avoidance/disclosure of anti-features. Game projects have extra friction:

- Art/audio assets need redistribution-compatible licenses. Some non-code assets with restrictive terms can block main-repo inclusion or require anti-features.
- The build pipeline must handle Rust, NDK, Node/Vite, and Tauri reproducibly enough for F-Droid's process.
- Auto-updating executable code from the game network can be an F-Droid policy issue unless explicit and opt-in.
- Proprietary analytics, crash reporting, Play Services, or non-free SDKs are not acceptable for main repo.

Improvement: split Android distribution into:

1. Direct signed APK / self-hosted F-Droid repo as the first realistic path.
2. Main f-droid.org as a later compliance/reproducibility project.
3. No network-delivered executable plugin updates in the F-Droid build unless deliberately opt-in and clearly disclosed.

### 4.6 TURN-over-TCP is not always enough; TURN-over-TLS should be explicit

v004's locked-network tier mentions TURN-over-TCP/443. Some institutional DPI systems can still classify/block TURN over TCP. The stronger standard fallback is TURN over TLS on 443 (`turns:`), ideally on a relay hostname with a real certificate.

This does reintroduce Web PKI for the fallback relay, but v004 already allows non-critical convenience bridges. The important thing is to make this explicit:

- `turn:relay.example:443?transport=tcp` is one fallback.
- `turns:relay.example:443?transport=tcp` is the dorm/corporate fallback to test.
- If using `turns`, the certificate/domain requirement belongs to the relay convenience lane, not the sovereign core.

### 4.7 WSS bridge requires a public reachable backend or reverse tunnel

A WSS bridge on a real-domain volunteer node is useful, but only if it can reach the target Tauri node. If the player Tauri node is behind CGNAT or a dorm firewall, the bridge cannot simply forward to the player's private IP.

The realistic pattern is reversed:

- Tauri node opens an outbound persistent connection to a bridge.
- Browser connects to the bridge over WSS/443.
- Bridge multiplexes traffic between the browser and the already-open node connection.

That is essentially a reverse tunnel. It should be specified as such, with relay quotas and capability tokens.

### 4.8 Chia registry light verification is still a hard dependency if Chia is the root

v004 correctly marks in-browser singleton-lineage verification as unproven. This needs to stay near the top of the risk list. If a web client relies on a public RPC mirror without proofs, then a malicious mirror can feed stale or selective registry views. Signatures help, but freshness and completeness still matter.

Improvement: treat the registry read path as three levels:

- Native full/light wallet: sovereign.
- Browser with proof-verifying WASM light client: target but unproven.
- Browser public RPC mirror: convenience only, with multi-mirror quorum and stale-height warnings.

### 4.9 Browser support claims need a maintenance policy

v004 correctly verified current browser support, but browser support tables move. A document saying "Baseline 2026" can become stale like v003 did.

Improvement: keep a small `docs/TDD/BrowserSupportMatrix.md` or equivalent that records:

- Date checked.
- Features checked.
- Minimum browser versions.
- Fallback behavior.
- Who owns re-checking before each networking sprint.

### 4.10 The Phase 1 plan still contradicts v004

This is not v004's fault, but it is a repo pitfall. The execution plan still lists `simple-peer` and embedded WSS signaling. v004 calls for updating it, but until that edit happens, contributors can still implement the obsolete plan.

Recommendation: make Phase 1 amendment the next concrete repo change after this review cycle.

### 4.11 Hardware deployment roles should be stated as product promises

v004 discusses hardware roles, but the plan should turn them into explicit product promises so users and implementers know what each device class is allowed to do.

Recommended role split:

- **Desktop Tauri:** full client, persistent room host, relay, seeder, wallet, local app verifier, station admin console.
- **Headless desktop/server:** community seed, relay, registry advertiser, room-log pinning, bridge service, no rendering.
- **Android Tauri:** sovereign mobile client, SpacePhone, chat, door list, temporary foreground host, wallet-lite; relay/seed off by default.
- **iOS PWA:** convenience phone client, chat, door list, QR join, store-forward actions; no sovereign first-load and no persistent host role.
- **Desktop browser PWA:** social client and light gameplay after first-load trust; no always-on infrastructure role.
- **Bridge node:** explicitly non-critical convenience lane for locked networks; quotas and capability tokens required.

This role table should appear in v004 or the Phase 1 amendment. It prevents mobile clients from accidentally inheriting desktop infrastructure requirements and makes Android's native path valuable without overpromising background hosting.

---

## 5. Cabal/Hypercore-Style Shared Hosting

The user specifically asked for Cabal-style shared Hypercore hosting. This is worth adding to v004, but carefully.

### 5.1 What Cabal/Hypercore gives us

Cabal CLI has several ideas directly relevant to StarStationFurlong:

- Cabal keys can be shared by QR.
- Headless `--seed` mode exists specifically to keep a cabal's data available.
- Custom ports and seeding are part of the operational model.
- Cabal-core exposes live replication streams that can be piped over arbitrary transports.
- Cabal has subjective moderation: each user can have local moderation policy, with shared mod keys for common views.

Modern Hypercore/Hyperswarm/Autobase adds stronger primitives:

- Hypercore is a signed, distributed append-only log with Merkle-tree verification and sparse replication.
- Hyperswarm discovers peers by 32-byte topics and opens encrypted peer connections, with peer limits and relay-through hooks.
- Autobase composes multiple Hypercore writers into deterministic materialized views, with indexers and deterministic `apply` handlers.

These are extremely relevant for room history, chat, bulletin boards, contracts, and station black boxes.

### 5.2 Do not directly depend on Cabal-core for the main architecture

Direct Cabal-core adoption has problems:

- Cabal-core is old JavaScript, not Rust-native.
- Cabal-core is AGPL-3.0, which may force broader licensing obligations than desired if linked/integrated.
- Browser/mobile support would require another gateway layer.
- Cabal's subjective moderation is useful for chat, but not enough for game authority and settlement.
- The project's v004 transport plan is already Rust/Tauri/libp2p/WebTransport oriented.

Recommendation: borrow the Cabal/Hypercore pattern rather than embedding Cabal-core.

### 5.3 Add a RoomLog layer between Yjs and Chia

v004 has hot transport, Yjs materialized state, and Chia settlement. It is missing a durable append-only middle layer.

Proposed layer:

```text
L0 transport       WebTransport / webRTC-direct / libp2p / relay
L1 realtime        signed intents, host results, presence, voice signaling
L2a RoomLog        per-writer append-only signed event logs, seeded by native nodes
L2b materialized   Yjs docs / deterministic views for chat, boards, rooms
L3 settlement      Chia deeds, CATs, escrow, company shares
```

RoomLog uses Hypercore-like semantics whether implemented with Hypercore, Iroh/doc logs, Willow, custom signed logs, or a Rust append-only log:

- Every native node has a writer log.
- Phone/web clients may append via their trusted node or use a small local writer if capable.
- Logs are content-addressed and signed.
- Native/headless seeders pin important room logs.
- Yjs is the live materialized view, but the append-only log is the audit/replay/data-availability source.
- Chia anchors only important roots/snapshots/ownership changes, not every chat/event.

### 5.4 Use Cabal-style hosting by data type, not for all game state

Best fits:

- Room chat.
- Bulletin boards.
- Contracts and classifieds.
- Door/access announcements.
- Station black boxes / host snapshots.
- Asset manifests.
- Local map annotations.
- Company notice boards and shareholder announcements.

Poor fits:

- High-frequency movement ticks.
- Voice/video media.
- Anti-cheat decisions requiring low latency.
- Immediate collision/path validation.

So: use Cabal-style logs for durable social/economy state; keep v004 host-soft-authority for low-latency movement and room simulation.

### 5.5 Shared hosting can reduce host-migration pain

The existing v004 host-migration model still has a single active authority for realtime validation. Cabal-style shared hosting can make that less brittle:

- Multiple native nodes seed the room's append-only logs.
- Several trusted co-hosts validate and countersign host snapshots.
- If the active host disappears, a standby host already has the latest log and snapshot.
- Android backgrounding becomes less damaging because room history continues to replicate through desktop/headless peers.

This is not full consensus for every move. It is better described as "shared data availability plus standby authority." That is easier to build and more consistent with the game.

### 5.6 Subjective moderation is a strong fit for frontier stations

Cabal's subjective moderation model maps nicely to player-run stations:

- Each station can publish a default moderation key/set.
- Companies or friend groups can subscribe to their own moderation views.
- A user can locally mute/block without requiring global consensus.
- Furlong Station can have stricter default public moderation than frontier outposts.

This is a good way to avoid a single global moderation authority while still making public spaces usable.

---

## 6. Locked-Network Improvements

v004's fallback ladder is mostly right. Improvements:

### 6.1 Add TURN-over-TLS to Tier 3

Explicitly test:

- `turn:` over UDP.
- `turn:` over TCP/443.
- `turns:` over TCP/443.
- Relay-only WebRTC policy for hostile networks.

`turns:` requires a real certificate/domain, so it belongs to the convenience lane. But it is often more likely to survive corporate/dorm filtering than raw TURN-over-TCP.

### 6.2 Define reverse WSS bridge, not only forward bridge

For CGNAT/dorm-hosted nodes, the node must dial out to the bridge. The bridge should not be expected to dial into the user's private node. The bridge is a rendezvous/reverse-tunnel service with quotas.

### 6.3 Make local-first LAN play a real fallback

If the internet is hostile but players are co-located:

- Native clients can use mDNS/local discovery.
- Browser clients may use LAN WebTransport with Local Network Access permission where available.
- Android native clients can use local network permissions and the Rust stack.
- QR can carry LAN endpoint plus cert hash.

This supports dorm-room play even when upstream access is poor.

### 6.4 Outside-the-box but policy-safe ideas

- **User-deployed bridge kits:** Provide a one-command recipe for players to run a bridge on their own VPS, home router, or community box. Avoid Cloudflare-only assumptions; include Caddy/Let's Encrypt, coturn, and the StarStation bridge binary.
- **Station relay cooperatives:** Treat relays as public utilities with transparent quotas, uptime, and reputation.
- **Sneakernet CRDT crates:** Export signed update bundles via file/QR/USB for networks that block all realtime paths.
- **Phone cellular sidecar:** If campus Wi-Fi blocks the desktop, the phone app on cellular can carry chat/contracts and later sync with desktop over local QR/file.
- **Captive-portal mode:** Detect captive portals and show a non-game network setup screen rather than failing silently.

Rejected as core design:

- Covert DNS tunneling.
- Domain fronting.
- Stealth protocols intended to hide from network policy.

These are brittle and can violate acceptable-use rules. Keep the architecture resilient, consent-based, and user-deployed.

---

## 7. Additional Browser and Web Platform Features

v004 already includes many browser features. Add or emphasize these:

### 7.1 WebAuthn PRF and largeBlob

PRF is required for passkey-derived wrapping keys. `largeBlob` may be useful for small credential-associated recovery metadata, but support differs across browsers and authenticators. Both require feature detection.

### 7.2 Web Locks plus Page Lifecycle API

For web clients, use Page Lifecycle events (`visibilitychange`, page freeze/resume where exposed) with Web Locks to gracefully demote leadership before a tab freezes.

### 7.3 IndexedDB durability probes

Do not just call `navigator.storage.persist()`. Add a storage diagnostics panel:

- Is storage persisted?
- Estimated quota.
- Last backup date.
- Last successful restore test.
- Whether the identity key is export-backed.

### 7.4 Web Share Target and File Handling

Useful for QR/room invites, station crates, asset bundles, and encrypted identity backups. These are especially relevant to the phone sidecar and sneakernet ideas.

### 7.5 WebRTC insertable streams and dependency descriptors

For encrypted proximity voice/video over relays, WebRTC encoded transforms are more relevant than raw WebCodecs. For SFU/SFM-style forwarding, dependency descriptors and simulcast/SVC support matter. v004 should avoid framing SFU-lite as a WebCodecs-only problem.

### 7.6 WebNN, WebGPU compute, and local AI as optional later features

Local AI can support NPC dialogue, noise suppression, moderation assistance, and station assistant terminals. Treat WebNN as exploratory because support and model distribution are still moving targets; WebGPU/WASM fallback may be more practical early.

### 7.7 WebUSB/WebSerial/WebHID for hardware wallets and props

Useful for hardware wallets, custom SpacePhone props, LED station panels, or flight controls. Keep permission prompts explicit and non-critical.

---

## 8. Missing Studies and Spikes

Add these to v004's spike list:

1. **Web first-load threat model:** Document exactly what the App Manifest Ledger can and cannot protect. Include compromised canonical origin, compromised Service Worker, and first-load/new-user scenarios.
2. **WebAuthn PRF key-wrap spike:** Test Chrome, Edge, Firefox, Safari, iOS Safari, Android Chrome, Android Firefox, Android WebView, and Tauri webviews. Define fallback key wrapping.
3. **Raw WT to libp2p bridge spike:** One Tauri node receives a raw WT `MoveIntent`, wraps it in the common envelope, publishes to gossipsub, receives it back, and proves no loops/duplicates.
4. **Android lifecycle host-thrash test:** Simulate app switch, screen off, Doze, App Standby, foreground service, charging, and Wi-Fi/cellular changes.
5. **F-Droid feasibility spike:** Build a minimal Tauri Android APK in a clean reproducible environment; list non-free asset and auto-update issues.
6. **Cabal/Hypercore RoomLog spike:** Implement chat/bulletin board as append-only per-writer logs with two desktop seeders and one mobile client reconnecting after a pause. Compare Hypercore/Autobase, Iroh, Willow, and a custom Rust log.
7. **Subjective moderation spike:** Model station defaults plus user-local mutes/blocks. Decide how Furlong Station and private stations differ.
8. **TURN/TLS and reverse-WSS bridge matrix:** Test campus/corporate/hotel/cellular networks with `turn`, `turns`, reverse WebSocket bridge, and relay-only WebRTC.
9. **Room authority split:** Define which events need active host validation and which can be leaderless RoomLog entries.
10. **Asset licensing and F-Droid packaging audit:** Ensure art/audio/assets and build tooling do not block F-Droid inclusion.
11. **Chia registry proof spike:** Keep as top risk. Browser public RPC without proof remains convenience only.
12. **Data retention policy:** Chat, bulletin boards, contracts, station snapshots, moderation events, and movement logs should have distinct retention/compaction rules.

---

## 9. Recommended v004 Amendments

1. Add a section called **RoomLog / Shared Hosting** between Yjs and Chia.
2. Reword App Manifest Ledger as post-install/update integrity, not first-load web integrity.
3. Add WebAuthn PRF as a prerequisite for passkey key wrapping, with fallbacks.
4. Treat Android as a sovereign client and temporary foreground host, not persistent infrastructure.
5. Add F-Droid compliance and reproducibility as an explicit deployment spike.
6. Define a common StarStation envelope shared by raw WebTransport and libp2p transports.
7. Add TURN-over-TLS and reverse-WSS bridge patterns to the locked-network ladder.
8. Incorporate Cabal subjective moderation for station/community moderation views.
9. Demote full consensus movement validation; use co-host logs for durability and standby authority, not every tick.
10. Update Phase 1 docs immediately so contributors do not implement the obsolete `simple-peer`/WSS design.

---

## 10. Final Recommendation

v004 should remain the new architecture baseline. Its major corrections are sound: raw WebTransport as the primary browser-to-node pipe, webRTC-direct as the Rust-compatible libp2p fallback, Android native as the sovereign mobile path, and separate trust lanes for app shell and node transport.

The next improvement should be a durability layer inspired by Cabal/Hypercore: signed append-only room logs, native/headless seeders, subjective moderation, and deterministic materialized views. This layer would make StarStationFurlong feel more like a resilient frontier network and less like a set of temporary host sessions.

In short: keep v004's transport and deployment corrections, add Cabal-style shared room persistence, and be stricter about verifier trust, passkey PRF, Android lifecycle, F-Droid compliance, and protocol bridge complexity before Sprint 3 networking starts.