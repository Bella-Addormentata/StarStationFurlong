# Phase 1: First Playable Slice - Technical Execution Plan

> **Maps to ROADMAP:** Phase 1 - Foundation & Prototyping  
> **Product Goal:** "I arrived at Furlong Station. I can explore public rooms, chat with others, and claim my own capsule."  
> **Technical Goal:** Deliver first multiplayer playable prototype in 6-8 weeks using the sovereign tech path  
> **Status:** 🔵 In Progress
> **Architecture Reference:** [STUDY-Architecture v006](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) — the verified sovereignty blueprint this plan implements (supersedes v005/v002; spike-gated items are explicitly marked)

---

## 📑 Table of Contents

- [Technical Objectives](#-technical-objectives)
- [Tech Stack Selection](#️-tech-stack-selection)
- [Sprint Breakdown](#-sprint-breakdown)
  - [Sprint 1: Local Rendering Foundation](#-sprint-1-local-rendering-foundation-week-1-2)
  - [Sprint 2: Room Interaction & Station Map](#-sprint-2-room-interaction--station-map-week-3-4)
  - [Sprint 3: Multiplayer Networking](#-sprint-3-multiplayer-networking-week-5-6)
  - [Sprint 4: Chat, Lobby & Room Ownership](#-sprint-4-chat-lobby--room-ownership-week-7-8)
- [Key Technical Decisions](#-key-technical-decisions)
- [Performance Targets](#-performance-targets)
- [Known Technical Risks](#-known-technical-risks)
- [Phase 1 Completion Criteria](#-phase-1-completion-criteria)

---

## 🎯 Technical Objectives

By end of Phase 1, we must deliver:

- [ ] **3D Rendering** - Smoothly render space station rooms in browser (60fps)
- [ ] **Player Movement** - WASD controls, collision detection, smooth animations
- [ ] **Multiplayer Sync** - Support 2-4 concurrent players with < 150ms latency
- [ ] **Room System** - StarStation public lobby plus at least 2 additional interconnected rooms
- [ ] **Room Navigation** - Door/transition system with station mini-map
- [ ] **Text Chat** - Global and proximity-based chat functionality
- [ ] **Room Ownership** - Players can claim and enter their own private capsule rooms
- [ ] **Capsule Demo** - Show the public station lobby connected to player-owned capsule rooms

---

## 🛠️ Tech Stack Selection

> **Sovereignty constraint:** nothing on the critical path may depend on infrastructure we do not control. Every technology choice below must pass the Sovereignty Test: *"If the dev team disappeared tomorrow, could a player's Tauri node keep the game running?"*

### Shared Game Core (TypeScript, runs in browser and Tauri webview)

| Category | Technology | Version | Rationale |
|----------|-----------|---------|-----------|
| **Build Tool** | Vite | 5.x | Fast dev server, smooth HMR |
| **Rendering Engine** | Three.js | r167+ | Mature WebGL library, rich documentation |
| **Room State / Chat** | Yjs + y-protocols + y-indexeddb | 13.x | CRDT — offline-first, conflict-free sync over *our own* transport; Awareness = **discrete presence only** — positions ride the datagram ticks, never Awareness or the persisted doc (v006 §8.1) |
| **P2P Transport** | **WebTransport (browser API)** | Baseline 2026 | Raw WT + `serverCertificateHashes` dial to a player node — no CA, no signaling; datagrams (ticks) + streams (sync). Replaces `simple-peer` (v005 §6) |
| **Serialization** | msgpackr | 1.x | MessagePack for all non-hot-path messages (chat, CRDT updates, interactions) |
| **UI Framework** | Vanilla HTML/CSS | — | Keep Phase 1 simple, can migrate to React later |

### Tauri Client Shell (Rust — the sovereign backbone)

| Category | Technology | Version | Rationale |
|----------|-----------|---------|-----------|
| **App Shell** | Tauri | 2.x | ~12 MB installer; native webview runs the shared TS game core |
| **Async Runtime** | Tokio | 1.x | Powers the WebTransport listener and future node subsystems |
| **Browser Pipe** | wtransport | 0.6.x | WebTransport server *inside* every Tauri node — self-signed ≤14-day ECDSA cert, hash-pinned by clients; no signaling service at all |
| **CRDT Host** | yrs | 0.2x | Rust port of Yjs (y-sync protocol + Awareness) — the node hosts room docs natively (v005 §3.6) |
| **Native P2P (Phase 2+)** | iroh *(spike-gated)* | 1.x | QUIC hole-punching + self-hosted relays + blobs; replaces the v002 `rust-libp2p` plan pending v006 spikes #1 (five-crate build) and #6 (sovereignty gate). **Own UDP socket — never shares 443 with wtransport (v006 §5.1 port split)** |

> **No Socket.io. No Railway/Render. No STUN/TURN. No signaling server at all.** WebTransport needs no SDP exchange — the browser dials the Tauri node directly and pins its certificate hash. See Architecture STUDY v005 §6 and §12.

### Development Tools

- **Editor:** VS Code + recommended extensions
- **Version Control:** Git + GitHub
- **Package Manager:** npm (frontend) + cargo (Rust)
- **Code Standards:** ESLint + Prettier (TS) + clippy (Rust)

---

## 📅 Sprint Breakdown

### 📦 Sprint 1: Local Rendering Foundation (Week 1-2)

**Goal:** Establish development environment, implement single-player basic rendering and movement.

#### Task 1.1: Project Initialization — ✅ COMPLETED (2026-06-15)

> **Completion notes:** Vite + Three.js prototype running at `prototypes/0.0.1-core-loop-demo/` (the frozen original; the live game continued in `prototypes/0.8.0-core-loop-demo/`). Dev server verified, HMR working, production build passing (`npm run build` clean). Visual prototype includes orthographic camera, Mars-textured station planet with cinematic intro flow, WASD player movement, FPS/position debug HUD, and NASA galaxy background. `src-tauri` scaffold deferred to Sprint 2 (browser-only prototype sufficient for Sprint 1 validation).

**Deliverables:**
- Vite project setup with Three.js
- Development server running
- Basic project structure

**File Structure:**
```
prototypes/0.8.0-core-loop-demo/
├── src/                          # Shared TS game core (runs in browser + Tauri webview)
│   ├── main.ts                   # Entry point
│   ├── renderer.ts               # Three.js renderer initialization
│   ├── world.ts                  # World/room management
│   ├── player.ts                 # Player entity
│   ├── input.ts                  # Input controls
│   ├── network/
│   │   ├── NetworkProvider.ts    # Transport port — raw WebTransport certhash dial (v005 §12.2)
│   │   ├── YjsSync.ts            # Yjs CRDT room-state sync (y-sync + awareness handshake)
│   │   └── RoomLog.ts            # Append-only social-log port (Phase 1: stub seam, v005 §7)
│   └── utils.ts                  # Utility functions
├── src-tauri/                    # Tauri shell (Rust — the sovereign backbone)
│   ├── src/
│   │   ├── main.rs               # Tauri entry point
│   │   └── wt_listener.rs        # wtransport server: certhash TLS, datagram + stream routing
│   └── Cargo.toml
├── public/
│   └── assets/                   # Textures, sounds
├── package.json
└── vite.config.ts
```

**Acceptance Criteria:**
- ✅ `npm run dev` starts successfully
- ✅ Browser opens to `http://localhost:5173` with default page
- ✅ Code changes trigger auto-refresh

**Estimated Time:** 30 minutes

---

#### Task 1.2: Basic Three.js Scene — ✅ COMPLETED (2026-06-15)

**Technical Design:**
- Set up orthographic camera for 2.5D isometric view
- Configure WebGL renderer with anti-aliasing
- Implement lighting system (ambient + directional)
- Handle window resize events

**Camera Configuration:**
- **Type:** OrthographicCamera
- **View Angle:** 45° isometric (looking down)
- **Projection:** Orthographic (no perspective distortion)
- **Frustum Size:** 15 units (adjustable)

**Lighting Design:**
- **Ambient Light:** 0x666666, provides base illumination
- **Directional Light:** 0xffffff 0.8, simulates sun/station lighting
- **Position:** (5, 10, 5) for natural shadows

**Acceptance Criteria:**
- ✅ Browser displays black background 3D scene
- ✅ Window resize maintains proper aspect ratio
- ✅ No console errors

**Estimated Time:** 2 hours

---

#### Task 1.3: Create Station Room — 🔄 IN PROGRESS

**Room Specifications:**
- **Size:** 10x10 meters (adjustable per room type)
- **Components:** Floor, 4 walls, grid helper
- **Materials:** Standard materials with PBR properties
- **Height:** 3 meters wall height

**Visual Design:**
- Floor: Dark gray (0x2a2a2a), slightly reflective
- Walls: Medium gray (0x444444), minimal reflection
- Grid: Helper lines at 1-meter intervals for spatial reference

**Technical Considerations:**
- Use PlaneGeometry for floor (rotated horizontal)
- Use BoxGeometry for walls (thin boxes)
- Add GridHelper for developer reference (removable in production)
- Enable shadow casting/receiving

**Acceptance Criteria:**
- [ ] Display 10x10m room with floor and walls
- [ ] Grid lines visible for spatial awareness
- [ ] Natural lighting effects

**Estimated Time:** 3 hours

---

#### Task 1.4: Player Entity and Movement Control — 🔄 IN PROGRESS

**Player Representation:**
- **Model:** Simple capsule geometry (0.3m radius, 1.0m height)
- **Color:** Green for local player, red for remote players
- **Position:** Y = 0.8m (capsule bottom at ground level)
- **Movement Speed:** 3.0 m/s

**Input System:**
- **Keys:** WASD for movement
- **Additional:** E key for interaction (future use)
- **Movement:** 8-directional with diagonal normalization

**Movement Physics:**
- Calculate velocity from input each frame
- Normalize diagonal movement to prevent speed boost
- Apply deltaTime for frame-rate independence
- Simple AABB collision with room boundaries

**Boundary Handling:**
- Keep player within room bounds (10x10m)
- Leave 0.5m buffer from walls

**Debug HUD:**
- Display FPS (frames per second)
- Display player position (X, Z coordinates)
- Position: Top-left corner, semi-transparent background

**Acceptance Criteria:**
- [ ] WASD controls work smoothly
- [ ] Player doesn't pass through walls
- [ ] FPS counter displays in top-left
- [ ] Stable 60fps on mid-range hardware

**Estimated Time:** 4 hours

---

#### Sprint 1 Summary

**Deliverables:**
- ✅ Complete development environment
- 🔄 Moveable 3D player character
- ✅ One complete station room
- 🔄 Basic game loop

**Demo Milestone:** Record 30-second video showing player movement in room

**Technical Validation:**
- Frame rate: 60fps stable
- Input latency: < 16ms
- Memory usage: < 100MB

**Next Step:** Sprint 2 - Add multi-room navigation and interactable objects

---

### 🏃 Sprint 2: Room Interaction & Station Map (Week 3-4)

**Goal:** Implement the StarStation public lobby layout, room switching, interactable objects, and a station mini-map.

#### Task 2.1: Multi-Room System

**Room Layout Design:**
```
[Capsule Row A] <--Airlock--> [StarStation Lobby] <--Airlock--> [Capsule Row B]
   10x10m (private)              20x20m (public)                  10x10m (private)
                                       |
                               [Corridor / Promenade]
                                    6x24m
```

**Room Specifications:**
- **StarStation Lobby:** Main public gathering space, 20x20m — the heart of the station
- **Corridor / Promenade:** Connecting passage with bulletin boards and signage, 6x24m
- **Capsule Row A/B:** Rows of private capsule rooms accessible off the lobby (placeholder geometry in Phase 1)

**Door System Design:**
- Doors represented as trigger zones (invisible colliders)
- Player proximity detection (< 1.0m)
- UI prompt appears: "Press E to enter [Room Name]"
- Teleport player to destination position

**Room Management:**
- All rooms loaded at startup
- Hide/show rooms based on current active room
- Camera follows player position
- Optimize by only rendering visible room

**Technical Considerations:**
- Use Three.js Groups for each room
- Position rooms in world space (offset along Z-axis)
- Implement room visibility toggle
- Store door connection data in configuration object

**Acceptance Criteria:**
- [ ] Three interconnected rooms created
- [ ] UI prompt shows when near doors
- [ ] E key switches rooms smoothly
- [ ] No frame drops during room transitions

**Estimated Time:** 4 hours

---

#### Task 2.2: Interactable Object System

**Object Types:**
- **Bulletin Board:** Station-wide announcements and player messages
- **Terminal:** Station directory, room map display
- **Airlock / Door Panel:** Controls room transitions and capsule access

**Object Properties:**
- Position (Vector3)
- Type (string identifier)
- Interaction range (default 1.5m)
- Data payload (messages, room links, ownership data)
- Visual feedback (highlight on hover)

**Interaction System:**
- Raycast or proximity detection
- Visual highlight when player in range
- E key triggers interaction
- Callback system for different object types

**Visual Design:**
- **Bulletin Board:** Light gray panel (1.2x0.8x0.1m), emissive display surface
- **Terminal:** Cyan glowing panel (0.5x1.0x0.3m), emissive material
- **Airlock / Door Panel:** Orange panel (0.6x0.8x0.2m), status indicator light

**Acceptance Criteria:**
- [ ] Multiple interactable objects in lobby and corridor
- [ ] Objects highlight when player approaches
- [ ] E key triggers interaction
- [ ] Bulletin board displays a static station notice

**Estimated Time:** 3 hours

---

#### Task 2.3: Station Mini-Map

**Purpose:** Give players spatial awareness of the StarStation layout — which rooms are public, which are private capsules, and where they currently are.

**Mini-Map Design:**
```
┌─────────────────────┐
│  StarStation Map    │
│  ┌─────┐            │
│  │ Cap │            │
│  └──┬──┘            │
│  ┌──┴───────────┐   │
│  │  Lobby  [★] │   │
│  └──┬───────────┘   │
│     │  Promenade    │
│  ┌──┴──┐            │
│  │ Cap │            │
│  └─────┘            │
│  [you are here ●]   │
└─────────────────────┘
```

**Features:**
- Fixed overlay (top-right corner)
- Highlight current room
- Show room type icons (public 🌐 / private capsule 🔒)
- Click a room to see its name and owner (Phase 1: static data)

**Technical Implementation:**
- SVG or Canvas 2D overlay (no Three.js overhead)
- Room registry object maps room IDs to map positions
- Update highlighted room on room transition event

**Acceptance Criteria:**
- [ ] Mini-map visible in top-right corner
- [ ] Current room highlighted on transition
- [ ] Room names shown on hover
- [ ] Public lobby clearly distinguishable from capsule rows

**Estimated Time:** 3 hours

---

#### Sprint 2 Summary

**Deliverables:**
- ✅ StarStation lobby + capsule row rooms
- ✅ Interactable objects (bulletin board, terminal, airlock panels)
- ✅ Station mini-map overlay

**Demo Milestone:** Record walkthrough of lobby → corridor → capsule entrance with mini-map visible

**Technical Validation:**
- Room transitions: < 500ms
- Object interaction: Responsive
- Mini-map: Updates correctly on room change

---

### 🌐 Sprint 3: Multiplayer Networking (Week 5-6)

**Goal:** Implement 2-4 player concurrent online via **raw WebTransport** (datagrams + streams) direct to a player-run Tauri node. No third-party server, no CA, no signaling service.

#### Architecture: Sovereign Networking

> From Architecture STUDY v005 §5–§6 (two trust lanes): the Tauri node is the sovereign backbone. The browser dials the node with `serverCertificateHashes` — trusting a specific self-signed certificate by SHA-256 hash — so *node-transport trust* needs no Web PKI and no SDP/ICE signaling at all. The browser client is sovereign-by-proxy, depending only on *a player's* Tauri node, never on a company or third-party service.

```
  Browser (web)                          Player-run TAURI NODE (room host)
  ┌─────────────────────┐                ┌──────────────────────────────┐
  │ Three.js + Yjs      │  WT datagrams  │ wtransport server (Rust)     │
  │ y-protocols         │◄──────────────►│  ├ ticks / awareness / ping  │
  │ WebTransport API    │  WT streams    │  ├ y-sync doc host (yrs)     │
  │ (certhash dial)     │◄──────────────►│  ├ chat / RoomLog (stub)     │
  └─────────────────────┘                │  └ capability check          │
                                         └──────────────────────────────┘
```

**No Socket.io. No hosted server. No STUN/TURN. No signaling.** Phase 1 uses a baked-in seed address (localhost Tauri node during dev) for first contact; the join string is `URL + certhash`. The Chia on-chain host registry is added in Phase 3+ for production bootstrap.

> **Sprint 3 pre-work (spikes, v006 §15.1):** **B‑1 five-crate build gate** — runs in parallel, gates the Phase-2+ stack (iroh 1 + p2panda 0.6.1 + yrs 0.27 + wtransport 0.6 + chia-wallet-sdk for desktop **and `aarch64-linux-android`**, report APK size); **#2 certhash dial matrix** — Chrome/Firefox/Safari 26.4, IP-literal vs LAN, **UDP 443**, IPv6, the Chrome 142/147 **Local Network Access prompt** on LAN dials, and `reload_config` cert rotation under live sessions; **#5 yrs⇄Yjs conformance** — sync + Awareness churn + update formats. The ping/pong comms probe is an in-sprint implementation detail of Tasks 3.2/3.4 (Chrome has no `WebTransport.getStats()`).
>
> **Sprint 3 also delivers [docs/TDD/BrowserSupportMatrix.md](../BrowserSupportMatrix.md)** — the date-stamped platform table (v006 P‑11: re-verified before every networking sprint; the LNA row flipped within one day of v004).
>
> **Explicitly *not* in Sprint 3 (spike-gated, v006 §5):** the iroh native backbone, the iroh-WASM fallback lane, and p2panda RoomLog — only the `RoomLog.ts` port *stub* is created so the seam exists.

---

#### Task 3.1: WebTransport Listener in the Tauri Node

**Responsibility:** Every Tauri node runs a `wtransport` server that browser clients dial directly. No external service of any kind.

**Implementation (Rust — `src-tauri/src/wt_listener.rs`):**
- `wtransport` server with a **self-signed ECDSA P-256 certificate, ≤ 14-day validity** (WebTransport spec requirement), auto-rotating with staged `current`/`next` hashes via `Endpoint::reload_config(cfg, rebind=false)` — hot swap without dropping sessions (verified API, v006 §3.2)
- Surface the active cert's SHA-256 hash in the Tauri UI and in the join URL/QR payload; join-string format = `URL + certhash + challenge` (v006 §12.2 `ClientHello`); when the phone-join UI lands, QR decoding uses a **bundled WASM decoder (zxing-wasm)** — `BarcodeDetector` is not cross-browser (v004 §6.4 decision)
- Accept session → read `Hello { roomId, capability }` → route **datagrams** (movement ticks, awareness, ping/pong) and **bidi streams** (y-sync, chat) per the `SsfEnvelope` framing (v005 §12.2)
- In-memory room roster — no DB
- Bind `127.0.0.1:4443` for dev; LAN + UDP 443 for the reachability spike

**Acceptance Criteria:**
- [ ] `cargo tauri dev` starts the Tauri app with the WT listener up
- [ ] A browser connects via `new WebTransport(url, { serverCertificateHashes })` with **no CA warning and no interstitial**
- [ ] Datagram and stream echo round-trips verified in the Tauri console
- [ ] Cert rotation produces overlapping `current`/`next` hashes without dropping sessions

**Estimated Time:** 6 hours

---

#### Task 3.2: Browser Dial + Movement Sync (`NetworkProvider`)

**Responsibilities:**
- Implement the `NetworkProvider` port from v005 §12.2: `connect()` (certhash dial), `mode(): TransportMode`, `durability(): DurabilityState`, `stats()`
- Dial with `new WebTransport(url, { serverCertificateHashes })` — Baseline 2026 (Chrome/Edge 100+, Firefox 125+, Safari 26.4+)
- Send local player position ticks over **datagrams** (unreliable)
- Open the reliable bidi stream for sync messages
- Compute RTT/loss from our own `ping`/`pong` datagrams (Chrome does not implement `WebTransport.getStats()` — v005 §3.3)

**Two-lane design:**
| Lane | WT mechanism | Content |
|---------|------|---------|
| `movement` | datagrams (unreliable) | 13-byte hand-packed `DataView` position tick |
| `sync` | bidi stream (reliable, ordered) | `SsfEnvelope`-framed messages (y-sync, chat, interactions) |

**Player Synchronization (three-lane rule, v006 §8.1):**
- Local player: immediate response (client-side prediction)
- Remote players: positions from the **13-byte datagram ticks** at 20 Hz (50 ms), only-on-change, interpolated — **never through Awareness** (Awareness re-broadcasts the full client state per update; it is for discrete presence, not continuous streams)
- Awareness carries **discrete presence only**: join/leave, display name, typing/speaking flags, AFK — at human rates
- Room state (furniture, bulletin boards): Yjs CRDT synced on connect and on change
- `TransportMode` reported to gameplay: `direct-unreliable` normally; `direct-reliable` when datagrams are unavailable (movement ticks over the reliable stream at reduced rate)

**Remote Player Management:**
- Create/destroy remote player entities on awareness join/leave
- Different visual representation (red vs green)
- Room-based scoping (one WT session + one Y.Doc per room)

**Acceptance Criteria:**
- [ ] Two browser tabs connected to one Tauri node see each other move (< 100 ms latency, LAN)
- [ ] Player disconnect removes the remote entity (awareness timeout)
- [ ] No public internet dependency — works on a LAN with no internet access (note the Chrome 142/147 LNA permission prompt on public-origin → LAN dials; make the first dial from page context, not a worker — v005 §3.2)
- [ ] `stats()` reports live RTT/loss from the ping/pong probe

**Estimated Time:** 5 hours

---

#### Task 3.3: Yjs CRDT Room State (`YjsSync`)

**Purpose:** Bulletin boards, furniture placement, and chat history are shared documents — not server-relayed events. Yjs handles merging offline edits; the node hosts the authoritative doc natively via **yrs** (the Rust y-sync implementation, incl. `Awareness` — verified v005 §3.6).

**Yjs document structure:**
```typescript
const roomDoc = new Y.Doc()
// SESSION-CAPPED demo storage behind a ChatProvider seam ('yjs-demo' | 'roomlog');
// durable chat history is promised only when RoomLog lands (v006 §8.4)
const chat    = roomDoc.getArray<ChatMessage>('chat')
const objects = roomDoc.getMap<ObjectState>('objects')  // furniture / interactables
// Positions ride the DATAGRAM TICKS; Awareness = discrete presence ONLY (v006 §8.1)
const awareness = new Awareness(roomDoc)
```

**Sync provider:** custom provider over the WT reliable stream using `y-protocols` — **with the state-vector re-handshake**: on every (re)connect both sides exchange `SyncStep1` (state vectors) so a returning peer receives exactly the missing updates, never a blind incremental stream (v005 §12.3). No third-party signaling or sync server.

**Signed-delta seam:** every state-mutating message rides the `SsfEnvelope` with an Ed25519 signature field; the node verifies **before** applying to the doc (v005 §12.4). Phase 1 may stub key management, but the verify-before-apply seam must exist.

**Acceptance Criteria:**
- [ ] Two peers share the same `chat` array in real time (session-capped at ~200 messages)
- [ ] Capsule ownership state is CRDT-synced across peers
- [ ] Reconnecting peer converges via the state-vector handshake without a full replay
- [ ] Awareness carries presence only; positions arrive via datagrams and are never written to IndexedDB
- [ ] `y-indexeddb` gives instant local load before the first peer connects

**Estimated Time:** 5 hours

---

#### Task 3.4: Network Performance Optimization

**Optimization Strategies:**

1. **Client-Side Prediction**
   - Local player responds immediately; movement needs no round-trip confirmation
   - The node is **soft-authoritative for persistent room state** (signed envelopes verified before apply); awareness is best-effort and non-authoritative — v006 §8.4
   - Reduces perceived input lag

2. **Position Interpolation**
   - Smooth remote player movement
   - Interpolate between received positions
   - Avoid jerky/teleporting appearance

3. **Bandwidth Optimization**
   - 13-byte hand-packed `DataView` for movement ticks (no JSON, no MessagePack on hot path)
   - MessagePack for all other messages (chat, interactions, CRDT sync)
   - Only send position when changed; delta-compress if unchanged

4. **Room-Based Filtering**
   - One WT session + one Yjs doc per room — don't sync unrelated rooms
   - Awareness scoped per room doc

5. **Comms Weather (seed)**
   - Surface the ping/pong RTT/loss in a small HUD indicator — the Phase 3 diegetic "comms weather" console starts here (v005 §3.3)

**Acceptance Criteria:**
- [ ] Network latency < 100 ms (LAN)
- [ ] Movement appears smooth, no stuttering
- [ ] Tauri node CPU usage < 20 % during 4-player session

**Estimated Time:** 3 hours

---

#### Sprint 3 Summary

**Deliverables:**
- ✅ `wtransport` WebTransport listener in the Tauri node (Rust) with rotating certhash identity
- ✅ Browser certhash dial — zero third-party services, zero signaling
- ✅ 2-4 player multiplayer: datagram movement + awareness presence + Yjs room-state sync
- ✅ `NetworkProvider` / `YjsSync` ports implemented; `RoomLog` port stubbed (the v006 seams)
- ✅ [BrowserSupportMatrix.md](../BrowserSupportMatrix.md) verified/updated with this sprint's findings

**Demo Milestone:** Demo with 2 physical devices on a LAN — no internet required

**Technical Validation:**
- Latency: < 100 ms (LAN), < 200 ms (remote)
- Frame rate: 60 fps maintained
- Connection stability: No unexpected disconnects; reconnect converges via state-vector handshake
- Sovereignty check: Disconnect the dev's server — game still connects and plays ✅

---

### 💬 Sprint 4: Chat, Lobby & Room Ownership (Week 7-8)

**Goal:** Add text chat, station onboarding, and the first version of room ownership — players can claim a capsule and others can see it as theirs.

#### Task 4.1: Text Chat System

**UI Design:**
```
┌─────────────────────────────────┐
│ Chat (Global)            [×]    │
├─────────────────────────────────┤
│ Player1: Hello!                  │
│ Player2: Hi there                │
│ [You]: Which capsule did you get?│
│ ...                              │
├─────────────────────────────────┤
│ [Type message...] [Send] [Tab]  │
└─────────────────────────────────┘
```

**Features:**
- Global chat (all players)
- Proximity chat (players within 5m, same room)
- Message history (max 50 messages)
- Tab key switches chat mode

**Chat System Components:**
- Chat UI container (fixed bottom-left)
- Message display area (scrollable)
- Input field + send button
- Mode toggle button (Global/Proximity)

**Sync path:**
- Chat messages are appended to the Yjs `chat` array in the room document (session-capped demo storage behind the `ChatProvider` seam — v006 §8.4)
- Yjs CRDT sync propagates messages to all peers over the WebTransport reliable stream
- No Socket.io server, no hosted relay — session history replays on reconnect; durable history arrives with RoomLog (Phase 2+)

**Message Format:**
- Sender name (colored by mode)
- Message text
- Timestamp (optional)

**Acceptance Criteria:**
- [ ] Multiple players can chat
- [ ] Tab key toggles global/proximity
- [ ] Chat history scrolls properly
- [ ] Messages persist for session

**Estimated Time:** 4 hours

---

#### Task 4.2: Station Onboarding Sequence

**Onboarding Flow:**
```
1. Black screen fade-in, text: "Furlong Station"
2. Player spawns in the StarStation Lobby
3. Brief welcome overlay: "You've arrived at Furlong Station. Explore, chat, and find your capsule."
4. Arrow nudges player toward the Promenade
5. Dismiss overlay to begin exploring freely
```

**Onboarding Components:**
- Fullscreen overlay (semi-transparent black)
- Text display system (typewriter effect optional)
- Begin button to start game
- Fade out transition

**Narrative Elements:**
- Player name/handle assignment
- Station name and sector display
- Welcome message
- Atmospheric text styling

**Technical Implementation:**
- Overlay DOM element
- CSS transitions for fade effects
- Promise-based sequencing
- Remove overlay after completion

**Acceptance Criteria:**
- [ ] Onboarding displays on game start
- [ ] Text is readable and atmospheric
- [ ] Transitions are smooth
- [ ] Player can skip (optional)

**Estimated Time:** 2 hours

---

#### Task 4.3: Room Ownership — Capsule Claiming

**Purpose:** Players can claim one of the capsule rooms off the lobby as their own. Other players see who owns each capsule. This is the foundation for the full ownership and editing system in Phase 2.

**Ownership Model (Phase 1 — CRDT state, host-sequenced claims):**
- Each capsule slot has an `owner` field in the Yjs `objects` map
- Claims are **host-sequenced** (v006 §8.4): pressing E at the door panel sends a signed claim intent; the node accepts the first intent per slot and writes the authoritative result — two racing claimers resolve deterministically, not by CRDT merge luck
- Owner's name displayed above the capsule door
- Owner can enter their capsule; others see a "Private — [Owner]" prompt

**Yjs Data Structure:**
```typescript
// Capsule slot in the station objects map
capsules: Y.Map<CapsuleState>
// CapsuleState { id, owner: string | null, label: string }
```

**UI:**
- Door panel shows: `[Unclaimed — Press E to claim]` or `[Owned by: PlayerName]`
- Owned capsule interior is a basic empty room (full editing deferred to Phase 2)
- Mini-map icons update to show claimed vs unclaimed capsules

**Acceptance Criteria:**
- [ ] Player can claim an unclaimed capsule
- [ ] Claimed capsule shows owner name above door
- [ ] Capsule ownership persists in Yjs CRDT across reconnects
- [ ] Other players see the correct owner in real time

**Estimated Time:** 4 hours

---

#### Task 4.4: Experience Polish

**Polish Items:**

1. **Audio System**
   - Footstep sounds (play on movement)
   - Door open/close sounds
   - Item pickup sound
   - Ambient station hum (looping)

2. **Player Name Tags**
   - Display above player head
   - Show player name
   - Billboard effect (always face camera)
   - Fade with distance

3. **Visual Effects**
   - Shadow improvements (if performance allows)
   - UI animations (fade in/out)
   - Capsule ownership highlight on door panel

4. **Performance Optimization**
   - Profile and identify bottlenecks
   - Optimize draw calls
   - Reduce geometry complexity if needed
   - Target stable 60fps

5. **Mini-Map (Optional)**
   - Small map in corner
   - Show current room layout
   - Player position indicator
   - Other player indicators

**Audio Library:**
- Use Howler.js for sound management
- Preload all sounds at startup
- Volume controls (adjustable)
- Spatial audio for proximity chat (future)

**Acceptance Criteria:**
- [ ] Basic sound effects play correctly
- [ ] Stable 60fps performance
- [ ] Overall experience feels polished
- [ ] No major visual glitches

**Estimated Time:** 6 hours

---

#### Sprint 4 Summary

**Deliverables:**
- ✅ Complete chat system (global + proximity)
- ✅ Station onboarding sequence
- ✅ Capsule room ownership (claim, display owner, persist via Yjs)
- ✅ Audio and polish

**Final Demo:** Live demo showing: players arrive in public lobby, chat, navigate the station, and each claims a capsule room visible to others

**Technical Validation:**
- All systems integrated and working
- No critical bugs
- Performance targets met
- Ready for external testing

---

## 🔧 Key Technical Decisions

### Decision 1: Network Architecture — Raw WebTransport (certhash) vs WebRTC + Signaler vs Socket.io

**Problem:** Which networking solution aligns with both Phase 1 speed and the project's sovereignty requirement?

**Decision:** Raw WebTransport with `serverCertificateHashes`, dialed directly against a player-run Tauri node

> **Supersession trail:** v002 originally selected WebRTC (`simple-peer`) brokered by an embedded WSS signaler. v003 found the certhash mechanism; v004 verified it is **Baseline 2026** (Chrome/Edge 100+, Firefox 125+, **Safari 26.4**); v005 re-verified and locked it (§3.1, §6). WebRTC survives only as the proximity-voice path and a fallback lane — it is no longer the primary transport, and the WSS signaler is deleted from the plan entirely.

**The Sovereignty Test (from Architecture STUDY v002 §3, unchanged):**
> *"If GitHub, Cloudflare, and the dev team all disappeared tomorrow, could a player's Tauri node bootstrap the game?"*

Socket.io requires a hosted server — fails immediately. The v002 WebRTC+signaler passed the test but carried an SDP/ICE dance, a WSS-to-node certificate wrinkle, and 1-2 s connect times. Raw WebTransport passes the test *and* deletes the signaling layer outright.

**Rationale:**
| Criteria | Socket.io + hosted | WebRTC + embedded signaler (v002) | **Raw WT + certhash (v005)** |
|----------|---------------------------|----------------------------------|------------------------------|
| **Sovereignty** | ❌ third-party server | ✅ player-run infra | ✅ player-run infra |
| **Signaling required** | hosted server | WSS broker in node + SDP/ICE | ✅ **none** — dial `URL + hash` |
| **CA / domain needed** | yes | none for DC; wrinkles for WSS | ✅ none — hash-pinned self-signed cert |
| **Browser reach** | all | all | ✅ Baseline 2026 incl. Safari 26.4 |
| **Unreliable lane (ticks)** | ❌ TCP only | ✅ unordered DC | ✅ native QUIC datagrams |
| **Connect time** | fast | ~1-2 s ICE | ✅ 1-RTT QUIC handshake |
| **Alignment with Phase 2+** | ❌ rip out | ⚠️ partial | ✅ grows into iroh backbone + Chia registry (v005 §6) |

**Trade-offs accepted:**
- The node must be UDP-reachable (dorm/corporate UDP blocks → the v006 §11 fallback ladder; UDP 443 masquerade is part of Sprint-3 spike #2). Note the v006 §5.1 ruling: iroh (noq) and wtransport (quinn) are different QUIC stacks — **they never share a socket**; wtransport owns 443
- ≤ 14-day certificates demand rotation automation → staged `current`/`next` hashes + `reload_config` hot swap (v006 §3.2)

**Future Path:**
- Phase 2: LAN mDNS auto-discovery (native); **iroh** backbone + iroh-relay fallback lane *(gated on v006 spikes #1 and #6)*
- Phase 2: RoomLog minimal for boards/contracts *(gated on v006 spike #3 bakeoff + the §7 T&S design note)*
- Phase 3: Chia on-chain host registry as the production bootstrap (no seed list needed)

---

### Decision 2: 2D vs 3D Rendering

**Decision:** Three.js 3D with isometric 2.5D perspective

**Rationale:**
- **Art Cost:** Low - simple geometric shapes suffice
- **Physics:** Simple 2D collision detection
- **Upgradability:** Can expand to full 3D later
- **Performance:** Orthographic camera (no perspective calculations)
- **Style:** Habbo Hotel-like aesthetic, proven in social games

**Camera Configuration:**
- 45° isometric view (looking down)
- Orthographic projection (no distortion)
- Fixed camera angle (Phase 1)
- Future: Allow camera rotation (Phase 2+)

**Benefits:**
- Faster prototyping than full 3D
- Easier to understand spatial layout
- Better performance on low-end devices
- Familiar gameplay for social game players

---

### Decision 3: State Management — Yjs CRDT vs Zustand

**Decision:** Yjs (CRDT) for all shared room state; lightweight local signals for UI-only state

**Rationale:**

| Criteria | Zustand | Yjs CRDT |
|----------|---------|----------|
| **Distributed sync** | ❌ Local only; needs server relay | ✅ Built-in P2P merge, conflict-free |
| **Offline / reconnect** | ❌ State lost on disconnect | ✅ Automatic catchup on reconnect |
| **Chat history** | ❌ Needs server persistence | ✅ `Y.Array` is the persistent log |
| **Furniture / objects** | ❌ Needs authoritative server | ✅ `Y.Map` CRDT, any peer can edit |
| **Sovereignty** | ❌ Implies a sync server | ✅ Syncs over our own transport (WebTransport) |

Zustand is useful for *purely local* UI state (chat panel open/closed, graphics settings). Yjs owns everything that crosses the network.

---

### Decision 4: Vanilla JS vs React for UI

**Decision:** Vanilla HTML/CSS for Phase 1

**Rationale:**
- **Simplicity:** Fewer dependencies, faster startup
- **Learning:** Team familiar with vanilla JS
- **Performance:** No virtual DOM overhead
- **Flexibility:** Can migrate to React/Vue later if needed

**When to Migrate:**
- Phase 3+: If UI becomes complex (inventory, crafting)
- When component reusability becomes important
- If team wants modern framework benefits

---

## 📊 Performance Targets

### Frame Rate
- **Target:** Stable 60 FPS
- **Minimum:** 30 FPS (low-end devices)
- **Test Devices:**
  - High-end: M1 Mac / RTX 3060
  - Mid-range: Intel i5 / GTX 1060
  - Low-end: Integrated GPU laptop

### Network Latency
- **LAN:** < 50ms
- **Local Region:** < 100ms
- **Cross-region:** < 200ms (acceptable)
- **Unacceptable:** > 300ms

### Memory Usage
- **Initial Load:** < 200MB
- **After 1 Hour:** < 500MB
- **Memory Leak:** Growth < 100MB/hour

### Load Times
- **Initial Load:** < 5 seconds (including asset download)
- **Room Switch:** < 500ms
- **Player Join:** < 1 second

### Bandwidth
- **Position Updates:** ~1KB/second per player
- **Chat Messages:** ~0.5KB per message
- **Total:** < 10KB/second for 4-player session

---

## 🐛 Known Technical Risks

### Risk 1: Three.js Performance Bottleneck

**Description:** Multiple players + complex scenes may cause frame drops

**Impact:** High - Directly affects player experience

**Likelihood:** Medium - Depends on device capabilities

**Mitigation:**
1. **Limit Players:** Phase 1 caps at < 10 players per room
2. **Instanced Meshes:** Use for repeated objects (future)
3. **Frustum Culling:** Don't render objects outside view
4. **LOD System:** Lower detail for distant objects (Phase 2+)

**Contingency:** Add graphics quality settings (low/medium/high)

---

### Risk 2: UDP/QUIC Blocked on Restrictive Networks

**Description:** WebTransport rides QUIC/UDP. Some networks (dorms, corporate firewalls, hotel captive portals) drop non-DNS UDP, which blocks the primary transport outright. Additionally, Chrome 142/147+ gates public-origin → LAN dials behind the **Local Network Access permission prompt** (v005 §3.2).

**Impact:** Medium — affects players on restrictive networks

**Likelihood:** Medium on campus/corporate networks; low at home

**Mitigation:**
1. **UDP 443 listener:** many "UDP-blocked" networks still allow UDP/443 (QUIC = HTTP/3) — Sprint-3 spike #2 measures this; IPv6 tested as a first-class lane
2. **`TransportMode` degradation:** report `direct-reliable` / `relayed-*` / `store-forward` so gameplay demotes gracefully instead of failing (v006 §12.6 / v005 §12.2)
3. **LAN mode:** same-network play needs no upstream at all; handle the LNA prompt diegetically ("Extend station comms onto your local network?") and make the first LAN dial from page context, not a worker
4. **Phase 2+ fallback lane:** self-hosted **iroh-relay** on TCP/443 — byte-indistinguishable from HTTPS, the realistic hostile-network workhorse (v006 §11) *(spike-gated)*

**Contingency:** Comms-weather indicator shows degraded mode; guide players to run a Tauri node / Station-in-a-Box for better connectivity

---

### Risk 3: Browser Compatibility

**Description:** Some browsers may not fully support WebGL 2.0

**Impact:** Low - Modern browsers have good support

**Likelihood:** Low - Only affects very old browsers

**Mitigation:**
1. **Graceful Degradation:** Detect WebGL support, show message if unsupported
2. **Target Browsers:** Chrome/Firefox/Safari latest versions
3. **Testing:** Test on multiple browsers regularly

**Contingency:** Display clear error message with browser upgrade instructions

---

### Risk 4: First-Contact Bootstrap (Cold Start)

**Description:** A new player with a fresh install needs to find at least one live Tauri node to connect. If the baked-in seed list is stale, they can't reach the network.

**Impact:** Medium — affects new player onboarding

**Likelihood:** Low during Phase 1 (dev machines always online); increases in production

**Mitigation:**
1. **Seed list:** Ship 3-5 always-on community Tauri node addresses in the build
2. **LAN mDNS:** Tauri nodes on the same LAN discover each other automatically (zero config, Phase 2)
3. **Chia registry (Phase 3+):** On-chain host list is the censorship-proof bootstrap — no stale seed list

**Contingency:** Allow players to manually enter a known Tauri node address + certificate hash (the join-string format from v005 §12.3)

---

### Risk 5: Scope Creep

**Description:** Adding features beyond Phase 1 scope

**Impact:** High - Could delay first playable

**Likelihood:** Medium - Common in game development

**Mitigation:**
1. **Strict Scope:** Refer back to Phase 1 objectives regularly
2. **Feature Backlog:** Save ideas for Phase 2+
3. **Weekly Reviews:** Check progress against timeline

**Contingency:** Cut optional features (mini-map, advanced audio) if behind schedule

---

## ✅ Phase 1 Completion Criteria

### Technical Metrics

- [ ] **Performance:** Stable 60fps on mid-range hardware
- [ ] **Network:** LAN latency < 100ms
- [ ] **Stability:** No memory leaks (1 hour growth < 100MB)
- [ ] **Concurrency:** Support 10+ simultaneous players
- [ ] **Compatibility:** Works on Chrome/Firefox/Safari latest versions

### Functional Metrics

- [ ] **3D Rendering:** Smoothly render station rooms
- [ ] **Movement System:** WASD controls + collision detection
- [ ] **Multi-Room:** StarStation lobby, promenade, and capsule row rooms
- [ ] **Station Map:** Mini-map overlay shows current room and room types
- [ ] **Multiplayer:** 2-4 players can see each other
- [ ] **Chat System:** Global and proximity chat working
- [ ] **Room Ownership:** Players can claim capsule rooms; ownership visible to all
- [ ] **Onboarding:** Lobby entry welcome sequence

### Usability Metrics

- [ ] **External Testing:** 10+ external playtesters successfully enter game
- [ ] **Session Length:** Average playtime > 15 minutes
- [ ] **Social Engagement:** > 50% of players use chat during their session
- [ ] **Crash Rate:** < 5% of players encounter critical bugs

### Feedback Collection

- [ ] **Survey:** Collect at least 10 valid feedback responses
- [ ] **Key Questions:**
  - "Is navigating the station fun and intuitive?"
  - "How was the multiplayer social experience?"
  - "Did you use chat? Was it easy to find?"
  - "Would you want to personalise your capsule room?"
  - "What technical issues did you encounter?"
  - "Would you continue playing?"

### Documentation

- [ ] **Code Comments:** Key systems documented
- [ ] **README:** Setup instructions for new developers
- [ ] **Known Issues:** Document any bugs/limitations
- [ ] **Phase 1 Retrospective:** Document lessons learned

---

## 🎬 Demo Milestones

### Sprint 1 Demo
- **What:** Single player moving in room
- **Format:** 30-second screen recording
- **Showcase:** WASD movement, FPS counter, collision

### Sprint 2 Demo
- **What:** Station layout walkthrough with mini-map
- **Format:** 2-minute video walkthrough
- **Showcase:** Lobby → promenade → capsule entrance, interactable objects, mini-map

### Sprint 3 Demo
- **What:** 2-player simultaneous gameplay
- **Format:** Side-by-side screen recording or live demo
- **Showcase:** Player synchronization, movement, latency

### Sprint 4 Demo (Final)
- **What:** Full social experience — lobby, chat, capsule claiming
- **Format:** Live playtest session with external users
- **Showcase:** Public lobby demo, players chatting, each player claiming a capsule room

---

## 📚 Reference Resources

### Official Documentation
- [Three.js Documentation](https://threejs.org/docs/)
- [Tauri Documentation](https://tauri.app/v2/guide/)
- [Yjs Documentation](https://docs.yjs.dev/)
- [WebTransport API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebTransport)
- [wtransport — Rust WebTransport server](https://github.com/BiagioFesta/wtransport)
- [yrs — Yjs in Rust](https://github.com/y-crdt/y-crdt)
- [Vite Documentation](https://vitejs.dev/)
- [msgpackr Documentation](https://github.com/kriszyp/msgpackr)
- [iroh Documentation](https://docs.iroh.computer/) *(Phase 2+ spike)*
- [p2panda](https://p2panda.org/) *(RoomLog spike)*
- [chia-wallet-sdk](https://github.com/xch-dev/chia-wallet-sdk) *(Phase 3+)*

### Tutorials and Examples
- [Three.js Journey](https://threejs-journey.com/) - Excellent Three.js tutorials
- [Tauri Getting Started](https://tauri.app/v2/guide/create/) - Tauri project setup
- [Yjs Shared Editing](https://docs.yjs.dev/getting-started/a-collaborative-editor) - CRDT intro
- [Using WebTransport (Chrome guide)](https://developer.chrome.com/docs/capabilities/web-apis/webtransport) - datagrams + streams walkthrough
- [Multiplayer Game Architecture](https://www.gabrielgambetta.com/client-server-game-architecture.html)

### Architecture References
- [Architecture STUDY v006](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v006.md) — the verified blueprint this plan implements
- §5 The four blocker resolutions (port split, Station-in-a-Box trust, markets, RoomLog insurance)
- §8 Data discipline — the three motion lanes and derive-don't-tick rule this plan follows
- §12 Deployment playbook — code for the node, handshake, and the `NetworkProvider`/`YjsSync`/`RoomLog` ports
- Historical: [v005](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v005.md) (the all-Rust node study) · [v002](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v002.md) (original WebRTC+signaler plan) · [v004](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v004.md) (platform verification pass)

### Inspiration References
- **Habbo Hotel** - Isometric social game
- **WorkAdventure** - Browser-based office spaces
- **Space Station 13** - Space station survival gameplay

### Technical Articles
- [WebGL Performance Best Practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices)
- [Client-Server Game Architecture](https://gafferongames.com/post/what_every_programmer_needs_to_know_about_game_networking/)
- [Three.js Performance Tips](https://discoverthreejs.com/tips-and-tricks/)
- [WebRTC for the Curious](https://webrtcforthecurious.com/) — NAT traversal, STUN/TURN deep dive

---

##  Notes

**Implementation Location:** All code implementations will be in `/prototypes/0.8.0-core-loop-demo/` (the highest-versioned core-loop folder is always the live game; superseded versions stay frozen, e.g. `/prototypes/0.7.0-core-loop-demo/`)

**Documentation Philosophy:** This plan focuses on WHAT to build and WHY. The HOW (code) lives in the prototype folder.

**Iteration:** This plan will be updated based on Sprint retrospectives and technical discoveries during implementation.
