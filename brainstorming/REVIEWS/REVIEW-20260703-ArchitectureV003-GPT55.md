# Review of STUDY-Architecture v003
**Date:** 2026-07-03  
**Evaluator:** GPT-5.5  
**Focus:** Sovereign serverless game mechanics, browser-native transport, locked-network resilience, deployment gaps, and missing spikes

---

## 1. Executive Verdict

v003 is directionally strong. Its central correction is real: `wss://<player-ip>` from a production browser is not a sovereign primary path because the browser will require normal Web PKI trust, and a self-signed player node cannot pass that without a CA/domain system. WebTransport with `serverCertificateHashes` is a legitimate browser-native way to authenticate a short-lived self-signed node certificate by hash, and libp2p WebRTC/WebTransport transports are the right family to study before building custom P2P plumbing.

However, v003 currently over-compresses several separate trust problems into one solution. Certificate-hash-pinned WebTransport can authenticate a WebTransport connection from an already-loaded secure web page. It does not, by itself, solve first loading the web app from a player IP, service-worker installation, passkey portability, browser storage origin fragmentation, WebTorrent tracker/rendezvous, or UDP-blocked university networks.

My recommendation is: keep the v003 spine, but change the deployment model from "the same cert-hash trick makes every browser path sovereign" to a layered model:

1. Native/Tauri installs are the fully sovereign path and can bundle the app directly.
2. The browser client is sovereign after it has a verified app shell, but first-load web distribution still needs a signed/content-addressed bootstrap story.
3. Node transport trust, app update trust, player identity, room authority, relay policy, and ledger settlement must be specified as separate layers with separate failure modes.
4. Locked-network support needs a formal fallback ladder that includes TCP/443 reliable modes, TURN/Circuit Relay reservations, and graceful degraded gameplay, not just QUIC/WebRTC optimism.

---

## 2. Sources Reviewed

Local repository inputs:

- `brainstorming/AI BRAINSTORMING/STUDY-Architecture v003.md`
- `ROADMAP.md`
- `docs/TDD/01-Architecture.md`
- `docs/TDD/03-Implementation/Phase1-ExecutionPlan.md`
- `docs/GDD/02-Core-Gameplay.md`
- `docs/GDD/03-CraftSystem.md`
- `docs/TDD/02-Systems/CoreTechnology.md`
- Prototype network stubs in `prototypes/01-core-loop-demo` and `prototypes/02-ortho-camera-demo`
- Existing review `brainstorming/REVIEWS/REVIEW-20260703-ArchitectureV003-Gemini31Pro.md`

GitHub issue/PR context checked:

- Issue #1: room classes, space truckers, Chia custody, markets, companies, shares
- Issue #10: point-and-click navigation with WASD interrupt
- Issue #12: QR/mobile phone chat and room transfer list
- PR #2: issue #1 ideas placed into gameplay/technology docs
- PR #3: professionalized docs, roadmap, Furlong Station, companies, gig economy, bulletin boards
- PR #4: Phase 1/2 execution plans on the sovereign tech path
- PR #5: core loop demo
- PR #7: orthographic camera/pixelation/8-way snap demo
- PR #9: rigged voxel character demo
- PR #11: A* point-and-click navigation demo

Targeted online checks:

- W3C WebTransport Working Draft (`https://www.w3.org/TR/webtransport/`): certificate hashes, secure context, custom certificate requirements, no certificate-error interstitial for WebTransport, HTTP/2 reliable-only concepts, and security notes.
- MDN WebTransport (`https://developer.mozilla.org/en-US/docs/Web/API/WebTransport`): current browser support, Baseline 2026 status, feature-level support differences, Local Network Access restrictions.
- Chrome WebTransport guide (`https://developer.chrome.com/docs/capabilities/web-apis/webtransport`): WebTransport is client-server, not browser-to-browser P2P; datagrams/streams tradeoffs; feature detection.
- js-libp2p configuration docs (`https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md`): browser transport limits, relay reservations, identify/pubsub dependencies, browser UPnP limitations, connection gating, and resource limits.

---

## 3. What v003 Gets Right

### 3.1 The CA critique is valid

v003 correctly identifies the hidden dependency in v002: a public HTTPS page cannot simply open `wss://<bare-player-ip>` to a self-signed node. WebSockets do not offer a `serverCertificateHashes` escape hatch, and there is no WebSocket-specific "accept this self-signed certificate" path inside a normal web app.

### 3.2 WebTransport cert hashes are a real sovereign primitive

The WebTransport spec explicitly defines `serverCertificateHashes`. If supported, the user agent can treat the presented server certificate as trusted if its leaf certificate hash matches the supplied SHA-256 hash and the certificate satisfies custom requirements. Those requirements include an X.509v3 certificate, an allowed public key algorithm including ECDSA P-256, current validity, and a total validity period of no more than two weeks.

That is extremely aligned with the Chia registry idea: publish endpoint plus short-lived cert hash, let nodes rotate, and make stale advertisements age out naturally.

### 3.3 The repo is still early enough to change course

The current prototypes are visual/navigation demos with `NetworkProvider.ts` and `YjsSync.ts` still stubbed. The Phase 1 plan still names `simple-peer` and embedded WSS signaling from v002. This is the correct moment to update the Phase 1 networking plan before Sprint 3 implements a path that v003 already knows is not production-safe.

### 3.4 Intent-based movement is a strong gameplay/network convergence

PR #11's point-and-click A* navigation makes v003's move-intent optimization plausible. Sending `MoveIntent` for pathing and streaming ticks only during manual WASD gives the network layer a game-native compression point and gives the host a cleaner validation target.

### 3.5 The player-run-infrastructure fantasy matches the game design

The GDD/ROADMAP center companies, spaceports, capsule hosting, bulletin boards, station logistics, and player-run routes. A network in which players literally run relays, seeders, rooms, registries, and bridge services can become in-world economy rather than invisible infrastructure.

---

## 4. Critical Pitfalls and Corrections

### 4.1 WebTransport cert hashes do not solve first-load web app hosting

This is the biggest correction.

`serverCertificateHashes` applies to the `new WebTransport(url, options)` connection. It does not apply to ordinary page navigation, static asset fetches, Service Worker registration, Web App Manifest installation, or loading `https://<player-ip>:4443/` in the address bar.

Implication: a QR code can safely contain `{ wtEndpoint, certHash, roomToken }` for an already loaded trusted web app. It cannot make a normal browser silently trust a self-signed HTTPS page hosted by a player node.

This affects v003 sections that imply a player node can be a canonical browser SPA mirror at `https://<ip>:4443/`. It can be a canonical app source for Tauri, localhost, LAN/dev, or users willing to click through page-level TLS warnings. It is not a clean production PWA bootstrap for arbitrary phones.

Improvement: split deployment into two independent trust lanes:

- **App shell trust:** how the browser obtains verified HTML/JS/CSS/WASM.
- **Node transport trust:** how that verified app dials a player node.

The cert-hash design solves the second lane, not the first.

### 4.2 Origin-scoped storage conflicts with "any mirror can serve the SPA"

Service Workers, Cache API, IndexedDB, OPFS, WebAuthn/passkeys, permissions, and PWA installation are all origin-scoped. If the app can be served from GitHub Pages, IPFS gateways, player IPs, random seed nodes, and local mirrors, every origin gets a separate app installation, storage partition, keys, permissions, and cache.

This creates several problems:

- A passkey created on `https://furlong.example` will not authenticate `https://203.0.113.7:4443` or `https://gateway.example/ipfs/...` as the same relying party.
- `y-indexeddb` room caches do not automatically follow the player across mirrors.
- OPFS asset caches fragment by origin.
- A malicious or compromised mirror can serve a hostile first-load app before the Service Worker is pinned.
- A Service Worker cannot protect the very first page load that installs it.

Improvement: choose one of these explicit models:

1. **Native-first sovereignty:** Tauri bundles the app and owns the stable app origin. Browser mirrors are convenience-only.
2. **Canonical web origin:** one HTTPS origin is the PWA home. This is not fully sovereign for new users, but previously installed PWAs keep working if the origin disappears. Treat it as a bootstrap convenience, not critical infrastructure.
3. **Signed content-addressed web app:** publish build manifests and asset hashes on Chia/torrent/IPFS, then use a minimal loader to verify the app before activating it. This still needs a first trusted loader origin unless browsers eventually support a practical signed-bundle model.
4. **Local file / local companion spike:** test whether a downloaded single-file app or localhost companion can use the needed secure-context APIs. Do not assume it works until tested across Chrome, Firefox, Safari, iOS, Android, and desktop.

### 4.3 WebAuthn/passkeys are useful, but not as mirror-portable identity

v003's passkey idea is attractive for casual key protection, but WebAuthn credentials are intentionally bound to an RP ID, normally a registrable domain. That does not fit a many-mirror, many-IP deployment without a stable relying-party domain.

Better use cases:

- Use passkeys on a canonical web origin for low-friction login to that origin.
- Use passkeys in Tauri/native as a local OS credential wrapping layer where the app has a stable identity.
- Use passkeys to unlock an app-local key, but keep the actual game identity as a portable, signed keypair with explicit export/recovery.

Do not make passkeys the only recovery path for Chia/game identity until the origin story is settled.

### 4.4 WebTransport is not browser-to-browser P2P

WebTransport is a browser-to-server API. It is excellent for browser-to-player-node. It is not a direct browser-to-browser transport. Browser-to-browser still means WebRTC data/media channels, relayed libp2p circuits, or an application relay.

v003 mostly knows this, but some language around the browser becoming a full citizen should be tempered. Browser nodes can be active participants in pubsub and streams once connected, but they still cannot open arbitrary listening sockets, configure UPnP/NAT-PMP, or act like a native DHT server in the general case.

### 4.5 UDP/QUIC optimism is risky for universities and enterprises

WebTransport over HTTP/3 rides QUIC over UDP. WebRTC direct connectivity also strongly prefers UDP. Many universities, dorm networks, office networks, captive portals, hotel Wi-Fi systems, and some mobile carriers block or degrade UDP/QUIC.

The plan needs a formal fallback mode for:

- UDP blocked, TCP 443 allowed.
- UDP allowed only to specific destinations.
- TLS interception/proxy environments.
- Captive portals.
- IPv6 available but unsolicited inbound blocked.
- Local Network Access restrictions when a public web origin dials a private LAN node.

If the game only has WebTransport/QUIC plus WebRTC-direct, a meaningful fraction of campus players will fail at the first connection.

### 4.6 WebTransport over HTTP/2 reliable-only deserves a spike

The WebTransport spec now models HTTP/2 as a reliable-only fallback path, with `reliability` indicating whether the connection supports unreliable datagrams or only reliable streams. Browser and server support is uneven, but this is exactly the kind of TCP/443 fallback StarStationFurlong should test.

Even if it cannot carry movement datagrams, it can carry:

- Text chat.
- Room presence at low rate.
- CRDT deltas.
- Bulletin board reads/writes.
- Inventory/contract interactions.
- Door-transfer requests.

That is enough to keep Issue #12 phone chat and social presence alive on locked networks.

### 4.7 Browser WebTorrent still needs a rendezvous/tracker story

v003 says infohashes on Chia can replace trackers. That is only partly true.

Chia can tell a client what content exists and where trusted seed nodes claim to be. But browser WebTorrent peers still need a way to discover and negotiate WebRTC data-channel connections. Traditional WebTorrent commonly uses WebSocket trackers for browser peer rendezvous. Native BitTorrent DHT is not directly accessible from browsers.

Possible fixes:

- Do not use browser WebTorrent as the primary asset path. Use content-addressed chunks over WebTransport/libp2p streams from player nodes.
- Let Tauri nodes act as WebTorrent hybrid seeders and WebRTC rendezvous brokers over the already authenticated node pipe.
- Use libp2p content routing and Bitswap-like exchange through player nodes rather than WebTorrent in browsers.
- Keep WebTorrent as an optional asset-sharing adapter, not the canonical browser distribution mechanism.

### 4.8 js-libp2p/gossipsub needs discovery, limits, and roles

Pubsub does not discover peers by itself. The application must provide bootstrap peers, DHT/rendezvous, peer exchange, or explicit relay addresses. Browser libp2p also has bundle-size, CPU, battery, and memory implications, especially for phones.

The plan should define browser roles:

- **Phone leaf:** bare WebTransport streams only; no gossipsub/DHT; chat and door list.
- **Desktop browser participant:** libp2p pubsub with tight limits.
- **Native node:** DHT server, relay, seeder, registry updater, room host.
- **Community seed:** high-bandwidth relay/seeder with explicit policy and monitoring.

Do not make the phone client carry the same libp2p stack as the desktop/native client unless a spike proves it is affordable.

### 4.9 Relay-by-default is an abuse and liability surface

"Every install is infrastructure" is powerful, but relays and seeders can be abused. A player node that accepts arbitrary relay reservations or asset seeding requests can become:

- A bandwidth sink.
- A DDoS reflector or traffic laundering hop.
- A host for illegal or unwanted user content.
- A source of ISP complaints.
- A battery/performance drain.

The default should probably be "contribute safely" rather than "unbounded relay." Required controls:

- Reservation limits.
- Per-room and per-peer quotas.
- Capability-token-gated relay usage.
- Content-address allowlists or deny policies.
- Rate limiting and backpressure.
- User-visible bandwidth caps.
- Relay accounting, maybe turned into in-game compensation.
- Abuse reporting and local blocklists.

### 4.10 The Chia registry is underspecified as a trust root

Publishing cert hashes on Chia is promising, but the browser must verify the record's provenance. A public RPC mirror returning JSON is not equivalent to a light client unless the browser verifies inclusion/proofs and singleton lineage.

Questions to answer:

- What singleton controls the official host registry?
- How does a room/station/company authorize a node to host or relay for it?
- What key signs registry payloads?
- How is key compromise handled?
- How are cert rollovers staged so old and new hashes overlap safely?
- How does a new browser verify singleton history without trusting one RPC server?
- What is the spam and Sybil cost model?
- Can the record fit in memos, or should the chain only store a hash/pointer to a signed off-chain record?

Suggested registry v4 additions:

```json
{
  "v": 4,
  "seq": 42,
  "stationId": "xch1...",
  "roomIds": ["deck:furlong:cantina"],
  "nodePeerId": "12D3Koo...",
  "nodePubKey": "...",
  "protocols": ["ssf-wt/1", "ssf-room/1", "ssf-chat/1"],
  "addrs": ["/ip4/203.0.113.7/udp/443/quic-v1/webtransport/certhash/..."] ,
  "certHashes": { "current": "...", "next": "...", "notAfter": 1767225600 },
  "relayPolicy": { "relay": true, "maxReservations": 32, "maxBytesPerMinute": 50000000 },
  "appBuild": { "version": "0.3.0", "manifestHash": "...", "signature": "..." },
  "ttlHeight": 12345678,
  "prev": "...",
  "sig": "signature by station or node authority"
}
```

### 4.11 The QR phone-chat flow needs narrower tokens

Issue #12's QR flow is one of the best near-term features. But the token in the QR needs to be an attenuated capability, not just a random access key.

It should encode or reference:

- Room ID.
- Allowed topics: chat, door list, maybe avatar presence; not movement authority or wallet actions.
- Expiry.
- Rate limits.
- Optional audience binding to a generated phone key.
- Revocation path.
- Whether the phone can post, read-only, or only reply to nearby speakers.
- Whether the token survives room transitions.

Macaroon-style or Biscuit-style attenuable tokens are worth studying because they let the in-game node mint a broad token and then caveat it down for a phone session.

### 4.12 Yjs document lifecycle is missing

Yjs is a good choice for room state and chat, but persistent Yjs docs grow and need operational policy.

Missing items:

- Snapshot/compaction schedule.
- Garbage collection policy.
- Subdocument boundaries for room, bulletin board, chat, ownership, door list, and ephemeral presence.
- Encryption per room or per board.
- Moderation/tombstone semantics.
- Migration strategy when schemas change.
- What data is recoverable if the room host disappears.
- What data is allowed to settle on-chain and what stays local.

### 4.13 Host-soft-authority needs a dispute and replay model

The room-host model is pragmatic. It still needs:

- Signed client intents with sequence numbers.
- Host-signed authoritative results.
- Deterministic simulation versioning.
- Clock and tick policy.
- Reconnect/replay windows.
- Cheat detection for speed/pathing/collision.
- Host migration if the host leaves.
- A way to distinguish "room owner authority" from "temporary host authority."
- Rules for when on-chain settlement trusts an off-chain host result.

For movement, PR #11's A* pathing helps because the host can validate `MoveIntent` against known room geometry. But the plan should specify that room geometry and collision maps are content-addressed and versioned, otherwise clients and hosts may disagree about legal paths.

### 4.14 WebCodecs is not a full SFU plan

WebCodecs and Insertable Streams are useful, but building an SFU-lite is not just forwarding encoded frames. Real SFU work includes RTP/RTCP, congestion control, retransmission, keyframes, NACK/PLI/FIR, audio levels, simulcast/SVC, jitter, and client adaptation.

Recommendation: use WebRTC for media and study a proven native SFU library embedded in player/community nodes, or defer large-room voice. If building in Rust, investigate existing WebRTC/SFU crates before hand-rolling. WebCodecs can still support avatar-video effects, recording, transcoding experiments, and maybe E2EE frame transforms.

### 4.15 The Phase 1 execution plan is now inconsistent with v003

`docs/TDD/03-Implementation/Phase1-ExecutionPlan.md` still names `simple-peer`, embedded WSS signaling, no public STUN/TURN, and v002 as the architecture reference. v003 changes the load-bearing transport assumptions. Before networking implementation begins, Phase 1 should be amended with:

- A WebTransport cert-hash spike.
- A browser WebRTC/direct/libp2p spike.
- A locked-network fallback spike.
- A minimal phone-chat QR spike.
- A revised `NetworkProvider` adapter interface that can support multiple transports and capability-degraded modes.

---

## 5. Locked-Network Strategy

The goal should not be covertly bypassing institutional policy. The goal should be robust, user-consented connectivity across common restrictive networks while respecting local rules. Avoid brittle tricks like domain fronting or stealth tunneling as core design. They tend to violate terms, break suddenly, and create trust problems.

Use a fallback ladder instead.

### Tier 0: Native/local path

- Tauri bundles the app and talks to its Rust node internally.
- Browser UI can talk to `localhost` when a companion node is installed.
- Localhost is the cleanest way to avoid browser Web PKI for the app shell.
- The native node can attempt QUIC, TCP, WebRTC, relay, UPnP/NAT-PMP, IPv6, and future MASQUE-style transports without waiting for browser APIs.

### Tier 1: Direct UDP path

- WebTransport over HTTP/3/QUIC to node on UDP 443 where possible.
- libp2p WebTransport and WebRTC-direct where supported.
- WebRTC media/data direct when ICE succeeds.

### Tier 2: Standard P2P fallback

- Circuit Relay v2 through volunteered native nodes.
- DCUtR/hole punching where it works.
- IPv6 direct attempts where globally routable.
- AutoNAT to decide whether a node may advertise as public.

### Tier 3: TCP 443 reliable fallback

- WebTransport over HTTP/2 reliable-only, if browser/server support is practical.
- WebSocket-over-HTTPS bridge only for non-sovereign convenience or volunteer nodes with real domains.
- TURN-over-TCP on port 443 from player/community relays for WebRTC fallback. Plain `turn:` over TCP may work in more places than UDP; `turns:` may reintroduce certificate naming requirements, so test carefully.
- Degrade movement to lower frequency and disable voice/video if only reliable TCP is available.

### Tier 4: Store-and-forward social mode

When realtime is impossible, keep the game alive with delay-tolerant features:

- Phone chat.
- Bulletin boards.
- Contracts.
- Market browsing.
- Room door list and async travel requests.
- Crafting queues.
- Mail/SpacePhone voicemail.
- Signed CRDT update bundles that can be uploaded later.

This is important because StarStationFurlong is not only an action game. The design already has social hangout, markets, crafting, station work, and bulletin boards. Bad networks should degrade the player into a lower-bandwidth citizen, not eject them entirely.

### Tier 5: Permissioned community bridge nodes

For the most restrictive networks, the community may need a few well-known bridge nodes on normal HTTPS/TCP 443 with CA certificates. That technically reintroduces Web PKI for this convenience path, but it can be non-critical if:

- Anyone can run a bridge.
- Bridges are discovered through Chia and signed records.
- The app authenticates game-level peer/node keys above TLS.
- Bridges cannot forge room state.
- Bridges have no monopoly on identity or settlement.

This is a pragmatic compromise: not every path needs to pass the Sovereignty Test if the critical path still does.

### Tier 6: Future native-only network experiments

Study for Tauri/native nodes, not browser clients:

- MASQUE / CONNECT-UDP style UDP-over-HTTPS relays.
- QUIC-over-TCP or other reliable fallbacks if libraries mature.
- Snowflake-style volunteer bridge discovery, but with explicit user consent and no deception.
- Delay-tolerant gossip over content-addressed bundles.

---

## 6. Browser Features Worth Adding to the Study

v003's browser audit is good. These are additional features or caveats to study.

### 6.1 SharedWorker

v003 mentions BroadcastChannel and Web Locks. Add SharedWorker as the preferred browser multi-tab network coordinator where supported. It can own the single libp2p/WebTransport/Yjs connection and expose a local message bus to tabs.

### 6.2 Storage Buckets API

Use storage buckets to separate eviction policy for:

- App shell.
- Critical identity metadata.
- Room snapshots.
- Asset cache.
- Temporary media.

This gives the app more explicit cleanup semantics than one giant IndexedDB/OPFS pile.

### 6.3 Compression Streams API

Use `CompressionStream` / `DecompressionStream` for signed snapshots, CRDT update bundles, asset manifests, and QR payload compression. It is especially useful for phone-chat bootstrap payloads and offline bundle exchange.

### 6.4 Background Sync, Periodic Background Sync, and Background Fetch

Support varies and permissions are gated, but these can opportunistically flush queued chat/board/contract updates or continue large asset downloads. Treat them as opportunistic quality-of-life features, not core mechanics.

### 6.5 File System Access API

Useful for desktop web and Tauri webview workflows:

- Export/import identity recovery bundles.
- Import room/module packs.
- Modding directories.
- Player-readable station backups.

This also supports a "sneakernet" fallback: players can move signed station snapshots or asset packs by file when the network is hostile.

### 6.6 Web Share Target, protocol handlers, file handlers, launch handler

PWA manifest capabilities can make invites and assets feel native:

- Register `web+ssf:` links for room invites.
- Accept shared screenshots/room packs on mobile.
- Open `.ssfroom` or `.ssfasset` files.
- Route launch URLs into the already-running PWA.

These are not core transport, but they improve the phone-chat and invite experience.

### 6.7 Screen Capture, Picture-in-Picture, Media Capture Transform, AudioWorklet

For SpacePhone:

- AudioWorklet for local voice meters, proximity attenuation, radio filters, and VAD.
- MediaStreamTrackProcessor/Generator or WebRTC encoded transforms for avatar-video effects.
- Picture-in-Picture for a floating SpacePhone call window.
- Screen Capture for in-world terminal sharing or station planning.

### 6.8 Wake Lock, Badging, and Notifications

Phone chat needs Wake Lock to avoid sleeping during active chat. Badging and local notifications can show unread SpacePhone messages while the PWA is open/installed. Avoid Web Push for core mechanics because push still transits browser-vendor push services.

### 6.9 WebRTC and WebTransport stats APIs

Use browser transport stats to build a first-class network diagnostics screen:

- Which transport tier is active.
- RTT/loss/jitter.
- Relay path.
- NAT type estimate.
- Whether UDP is blocked.
- Recommended user action.

This can be diegetic: a station comms console that explains why the player's SpacePhone is in degraded mode.

### 6.10 WebAssembly threads and SharedArrayBuffer require cross-origin isolation

v003 mentions WASM threads/SIMD. Threads and `SharedArrayBuffer` require COOP/COEP headers and cross-origin isolation in browsers. That interacts badly with arbitrary mirrors, IPFS gateways, third-party assets, and user-generated content. Add a deployment spike for cross-origin isolation before assuming WASM threading works in the web client.

### 6.11 Local Network Access restrictions

Modern browsers are adding restrictions around public origins reaching private/local network addresses. If a public PWA tries to dial `https://192.168.x.x` or a local node, it may trigger preflights or permission gates. This directly affects LAN discovery and player-node dialing from a browser web origin. Add it to the WebTransport spike.

---

## 7. Improvements to the Architecture

### 7.1 Rename the core insight

Instead of "Chia becomes the certificate authority," use:

> Chia becomes the signed endpoint and key-discovery registry for game nodes.

That is more precise. WebTransport still uses TLS semantics; Chia does not issue certs. Chia publishes and authenticates the expected node certificate hash and peer identity.

### 7.2 Add an App Manifest Ledger

Create a small signed release manifest:

```json
{
  "app": "StarStationFurlong",
  "version": "0.3.0",
  "createdAt": 1783120000,
  "assets": [
    { "path": "/index.html", "sha256": "..." },
    { "path": "/assets/game.js", "sha256": "..." },
    { "path": "/assets/game.wasm", "sha256": "..." }
  ],
  "entryHash": "...",
  "signer": "dev-or-community-release-key",
  "signature": "..."
}
```

Publish the manifest hash on Chia and distribute the manifest by torrent/IPFS/player nodes. The native app can verify it before updating. The browser path still needs a trusted loader, but this prevents silent app updates from arbitrary mirrors once the app shell is installed.

### 7.3 Define transport capability modes in `NetworkProvider`

The adapter should expose more than "connected". It should report capability:

```ts
type TransportMode =
  | 'direct-unreliable'   // WebTransport/QUIC datagrams or direct WebRTC
  | 'direct-reliable'     // H2 WebTransport/WebSocket-like fallback
  | 'relayed-unreliable'
  | 'relayed-reliable'
  | 'store-forward'
  | 'offline';
```

Then gameplay can degrade deliberately:

- Voice/video only on direct or high-quality relay.
- Movement ticks only on unreliable/direct or low-latency relay.
- Move intents and chat on reliable fallback.
- Bulletin boards/contracts on store-forward.

### 7.4 Make relay operation an in-game profession

This fits the game's company/economy themes. Let players form "comms guilds" or infrastructure companies that run seed/relay nodes and earn in-game reputation, rent discounts, or fees.

This turns a technical cost into a world mechanic:

- Stations advertise relay quality.
- Companies sell premium docking/communications service.
- Bad relay behavior damages reputation.
- Community seed nodes become valuable public infrastructure.

### 7.5 Add signed room geometry and physics versions

For intent-based movement and host validation, every room should have a content-addressed geometry/collision manifest:

- Room mesh/layout hash.
- Walkable grid hash.
- Obstacle AABBs.
- Pathfinding version.
- Physics constants.
- Door graph.
- Host signature.

Clients and hosts should refuse to validate movement if their room manifest hashes differ.

### 7.6 Treat browser clients as capability-limited citizens, not inferior clients

Use roles, not hierarchy:

- Phone browser: chat, door list, contract updates, notifications.
- Desktop browser: social play, room presence, light assets, maybe movement.
- Native Tauri: hosting, relay, seed, wallet, background simulation.
- Headless node: infrastructure company / community seed.

Each role should have a clear product promise and clear failure mode.

---

## 8. Outside-the-Box Ideas

### 8.1 Network routes as game objects

Make the comms graph visible in-world. A station can have a comms room where players see:

- Active relays.
- Room seeders.
- Network weather.
- Degraded links.
- Relay fees.
- Who is hosting the room.

This turns debugging into roleplay and helps players understand why a phone chat or door transfer is slow.

### 8.2 Sneakernet station crates

Allow export/import of signed "station crates" containing room snapshots, asset manifests, bulletin-board updates, and contract bundles. Players could move them by file, QR, USB, or local share. It sounds old-fashioned, but it fits a frontier game and solves some hostile-network cases.

### 8.3 QR dead drops

Issue #12's QR system can generalize beyond phone chat:

- Join room chat.
- Claim temporary guest access.
- Carry a bulletin-board update.
- Transfer a contract acceptance.
- Share a room seed list.
- Move a small CRDT update bundle between devices.

Use animated QR chunks for payloads larger than one QR can hold.

### 8.4 Phone as a cellular sidecar

If a university PC network blocks the game, the player's phone may still have cellular data. The phone client can stay connected to chat, contracts, and door lists while the desktop visual client is degraded/offline. Later, the desktop can reconcile state from the phone via local QR or file bundle.

### 8.5 Delay-tolerant economy

The design already has crafting, markets, contracts, bulletin boards, travel, and station logistics. These can work under intermittent connectivity. Build "bad network gameplay" as asynchronous station work rather than treating it as a total failure.

### 8.6 Station black boxes

Room hosts periodically emit signed snapshots to multiple peers. If a room host disappears, the next host can resume from the latest quorum-known snapshot. This is the P2P version of a save file and should be separate from Chia settlement.

### 8.7 Multi-mirror update quorum

Before activating a new web app update, the client can fetch the signed manifest from multiple mirrors and require matching hashes. This does not solve first-load trust, but it reduces compromised-mirror risk after installation.

### 8.8 Capability-carrying doors

Door links can carry attenuated network capabilities. Walking through a door grants the client the next room's bootstrap token, peer hints, chat permission, and asset manifest. The map becomes both navigation and discovery infrastructure, matching the existing `CoreTechnology.md` idea of map-embedded network data.

---

## 9. Missing Studies and Spikes

Highest priority:

1. **App bootstrap trust spike:** Prove how a brand-new phone loads the web app without relying on a permanent dev-owned web origin. Include Service Worker, PWA install, WebAuthn, OPFS, and first-load compromise analysis.
2. **WebTransport cert-hash spike:** Browser to local/native node and public node; Chrome, Firefox, Safari, iOS, Android; IP literal, DNS name, LAN IP, and Local Network Access restrictions.
3. **Locked-network matrix:** Test home NAT, dorm UDP-blocked Wi-Fi, corporate proxy, hotel captive portal, cellular CGNAT, IPv6-only/IPv6-preferred, and VPN. Record which transport tier works.
4. **HTTP/2 WebTransport / TCP 443 fallback spike:** Determine if reliable-only WebTransport is deployable enough for chat/CRDT fallback.
5. **TURN/TCP and Circuit Relay policy spike:** Player-run relay with reservations, quotas, auth tokens, and abuse limits.
6. **Browser libp2p cost spike:** Bundle size, startup time, CPU, memory, and battery on desktop and phone. Compare full libp2p against bare WebTransport streams.
7. **Chia light-read spike:** Verify singleton records in browser without trusting one public RPC. Document proof requirements and fallback mirrors.
8. **Asset distribution spike:** Compare WebTorrent, libp2p content routing, IPFS/Helia, and custom content-addressed WebTransport chunk service.
9. **Yjs lifecycle spike:** Snapshot, compaction, schema migration, encryption, and moderation for room chat/bulletin boards.
10. **Host authority replay spike:** Signed intents, host validation, movement replay, host migration, and room-geometry hashing.
11. **Phone-chat MVP:** QR payload, narrow capability token, web app load path, WebTransport dial, Yjs chat doc, door list, and degraded network behavior.
12. **Relay economy design:** Decide whether relay/seeding is altruistic, rewarded, paid, reputation-bearing, or station/company-owned.

---

## 10. Recommended Changes to v003

1. Keep WebTransport `serverCertificateHashes` and libp2p WebRTC/WebTransport as the primary spike direction.
2. Replace any claim that player-node HTTPS serving is automatically browser-production-safe with a separate app-bootstrap section.
3. Add an explicit origin model for Service Workers, OPFS, IndexedDB, passkeys, and PWA install.
4. Amend Phase 1 docs before networking implementation begins; the current `simple-peer`/WSS Sprint 3 plan is outdated by v003.
5. Add a locked-network fallback ladder with TCP/443 reliable mode and store-forward mode.
6. Demote browser WebTorrent from canonical asset distribution until rendezvous/tracker problems are solved.
7. Add relay abuse controls and make relay operation opt-in or safely capped by default.
8. Define a signed Chia registry record with proof verification, cert rollover, node authorization, and app build hashes.
9. Add capability tokens for QR phone chat and door traversal.
10. Add data lifecycle specs for Yjs and host-authoritative room state.

---

## 11. Final Recommendation

v003 should be accepted as the new architectural direction, but not as a complete deployment plan yet. Its best idea is not "the browser is fully solved." Its best idea is narrower and stronger: a verified web app can dial self-signed player nodes without Web PKI by using certificate-hash-pinned WebTransport, with Chia providing the signed discovery record.

The next version should make that distinction explicit. Once app bootstrap, origin scope, locked-network fallback, relay abuse, registry verification, and Yjs/host lifecycle are specified, this architecture can become both technically credible and deeply aligned with the game: a frontier where the players do not just inhabit stations, they operate the communications, markets, rooms, relays, and records that make the frontier real.