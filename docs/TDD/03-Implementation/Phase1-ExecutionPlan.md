# Phase 1: First Playable Slice - Technical Execution Plan

> **Maps to ROADMAP:** Phase 1 - Foundation & Prototyping  
> **Product Goal:** "I arrived at Furlong Station. I can explore public rooms, chat with others, and claim my own capsule."  
> **Technical Goal:** Deliver first multiplayer playable prototype in 6-8 weeks using the sovereign tech path  
> **Status:** 🔵 In Progress
> **Architecture Reference:** [STUDY-Architecture v002](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v002.md) — the sovereignty blueprint this plan implements

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
| **Room State / Chat** | Yjs | 13.x | CRDT — offline-first, conflict-free sync over *our own* transport; replaces Zustand + any server-relay |
| **P2P Transport** | simple-peer | 9.x | WebRTC data channels in-browser; stays in the TS layer per Architecture §14 |
| **Serialization** | msgpackr | 1.x | MessagePack for all non-hot-path messages (chat, CRDT updates, interactions) |
| **UI Framework** | Vanilla HTML/CSS | — | Keep Phase 1 simple, can migrate to React later |

### Tauri Client Shell (Rust — the sovereign backbone)

| Category | Technology | Version | Rationale |
|----------|-----------|---------|-----------|
| **App Shell** | Tauri | 2.x | ~12 MB installer; native webview runs the shared TS game core |
| **Async Runtime** | Tokio | 1.x | Powers embedded signaling server and future `libp2p` integration |
| **Embedded Signaler** | axum + tokio-tungstenite | 0.7.x / 0.23.x | ~small Rust file; WSS WebRTC broker running *inside* every Tauri node — no third-party server needed |
| **Native P2P** | rust-libp2p | 0.54.x | QUIC + gossipsub + Kademlia DHT; native swarm needs zero external servers |

> **No Socket.io. No Railway/Render. No public STUN/TURN.** The Tauri node IS the signaling/STUN/relay server. See Architecture STUDY v002 §6 and §9.2.

### Development Tools

- **Editor:** VS Code + recommended extensions
- **Version Control:** Git + GitHub
- **Package Manager:** npm (frontend) + cargo (Rust)
- **Code Standards:** ESLint + Prettier (TS) + clippy (Rust)

---

## 📅 Sprint Breakdown

### 📦 Sprint 1: Local Rendering Foundation (Week 1-2)

**Goal:** Establish development environment, implement single-player basic rendering and movement.

#### Task 1.1: Project Initialization

**Deliverables:**
- Vite project setup with Three.js
- Development server running
- Basic project structure

**File Structure:**
```
prototypes/01-core-loop-demo/
├── src/                          # Shared TS game core (runs in browser + Tauri webview)
│   ├── main.ts                   # Entry point
│   ├── renderer.ts               # Three.js renderer initialization
│   ├── world.ts                  # World/room management
│   ├── player.ts                 # Player entity
│   ├── input.ts                  # Input controls
│   ├── network/
│   │   ├── NetworkProvider.ts    # WebRTC via simple-peer
│   │   └── YjsSync.ts            # Yjs CRDT room-state sync
│   └── utils.ts                  # Utility functions
├── src-tauri/                    # Tauri shell (Rust — the sovereign backbone)
│   ├── src/
│   │   ├── main.rs               # Tauri entry point
│   │   └── signaling.rs          # Embedded WSS WebRTC signaler (~small file)
│   └── Cargo.toml
├── public/
│   └── assets/                   # Textures, sounds
├── package.json
└── vite.config.ts
```

**Acceptance Criteria:**
- [ ] `npm run dev` starts successfully
- [ ] Browser opens to `http://localhost:5173` with default page
- [ ] Code changes trigger auto-refresh

**Estimated Time:** 30 minutes

---

#### Task 1.2: Basic Three.js Scene

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
- [ ] Browser displays black background 3D scene
- [ ] Window resize maintains proper aspect ratio
- [ ] No console errors

**Estimated Time:** 2 hours

---

#### Task 1.3: Create Station Room

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

#### Task 1.4: Player Entity and Movement Control

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
- ✅ Moveable 3D player character
- ✅ One complete station room
- ✅ Basic game loop

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

**Goal:** Implement 2-4 player concurrent online via WebRTC P2P, brokered by the embedded Tauri signaler. No third-party server required.

#### Architecture: Sovereign Networking

> From Architecture STUDY v002 §5-6: the Tauri client is the sovereign backbone. Every player running the native client optionally contributes signaling, STUN reflection, and NAT relay — so the browser client is sovereign-by-proxy, depending only on *a player's* Tauri node, never on a company or third-party service.

```
  Browser (web)                        Player-run TAURI NODE
  ┌─────────────────────┐              ┌──────────────────────────────┐
  │ Three.js + Yjs      │  WebRTC DC   │ Three.js + Yjs               │
  │ simple-peer         │◄────────────►│ simple-peer (in webview)     │
  │                     │              │                              │
  │                     │  WSS signal  │ signaling.rs (embedded WSS)  │
  │                     │◄────────────►│ STUN reflection              │
  └─────────────────────┘              │ NAT relay (app-layer)        │
                                       └──────────────────────────────┘
```

**No Socket.io. No hosted server. No public STUN.** Phase 1 uses a baked-in seed address (localhost Tauri node during dev) for first contact; Chia on-chain host registry is added in Phase 3+ for production bootstrap.

---

#### Task 3.1: Embed Sovereign Signaling Server in Tauri Node

**Responsibility:** Every Tauri client runs a tiny WebSocket broker that facilitates WebRTC SDP/ICE exchange between peers. No external signaling service.

**Implementation (Rust — `src-tauri/src/signaling.rs`):**
- `axum` WebSocket upgrade handler
- In-memory `HashMap<RoomId, Vec<PeerId>>` — no DB
- Relay SDP `offer`/`answer` and ICE candidates between peers in the same room
- Emit `peer:joined` / `peer:left` events
- Bind on `127.0.0.1:3000` for dev; expose on LAN for other players

**Key Events (over WSS):**
- `join` — browser registers itself for a room
- `offer` / `answer` — relay SDP between two peers
- `ice` — relay ICE candidate
- `peer:joined` / `peer:left` — roster notifications

**Acceptance Criteria:**
- [ ] `cargo tauri dev` starts Tauri app with embedded signaler on port 3000
- [ ] Two browser windows served by the Tauri webview can connect to the signaler
- [ ] Signaler logs SDP relay events in the Tauri console

**Estimated Time:** 4 hours

---

#### Task 3.2: WebRTC P2P via `simple-peer` (Client)

**Responsibilities:**
- Connect to the Tauri-node signaler via WebSocket
- Exchange SDP offer/answer and ICE candidates
- Open a WebRTC data channel per peer pair
- Send local player position ticks (unreliable channel)
- Sync Yjs CRDT state updates (reliable channel)

**Two-channel design:**
| Channel | Mode | Content |
|---------|------|---------|
| `movement` | unreliable, ordered | 13-byte hand-packed `DataView` position tick |
| `sync` | reliable, ordered | MessagePack messages (CRDT updates, chat, interactions) |

**Player Synchronization:**
- Local player: immediate response (client-side prediction)
- Remote players: position updates from WebRTC unreliable channel at 20 Hz
- Room state (furniture, bulletin boards): Yjs CRDT synced on connect and on change
- Update frequency: 50 ms (20 updates/second) on movement channel
- Only send when position changes

**Remote Player Management:**
- Create/destroy remote player entities on `peer:joined` / `peer:left`
- Update positions from WebRTC data channel
- Different visual representation (red vs green)
- Room-based visibility (only connect to peers in the same room)

**Acceptance Criteria:**
- [ ] Two Tauri windows (or browser tabs served by Tauri) can see each other move
- [ ] Movement syncs smoothly (< 100 ms latency, LAN)
- [ ] Player disconnect removes entity correctly
- [ ] No public internet dependency — works on a LAN with no internet access

**Estimated Time:** 5 hours

---

#### Task 3.3: Yjs CRDT Room State

**Purpose:** Bulletin boards, furniture placement, and persistent chat history are shared documents — not server-relayed events. Yjs handles merging offline edits and reconnect sync automatically.

**Yjs document structure:**
```typescript
const roomDoc = new Y.Doc()
const chat    = roomDoc.getArray<ChatMessage>('chat')   // append-only log
const objects = roomDoc.getMap<ObjectState>('objects')  // furniture / interactables
const players = roomDoc.getMap<PlayerPresence>('players') // online presence
```

**Sync provider:** custom `WebrtcProvider`-equivalent that uses the `sync` data channel (reliable) instead of `y-webrtc`'s public signaling server. No third-party signaling.

**Acceptance Criteria:**
- [ ] Two peers share the same `chat` array in real time
- [ ] Capsule ownership state is CRDT-synced across peers
- [ ] Reconnecting peer receives full room state without a server

**Estimated Time:** 4 hours

---

#### Task 3.4: Network Performance Optimization

**Optimization Strategies:**

1. **Client-Side Prediction**
   - Local player responds immediately
   - No round-trip confirmation needed (P2P, no authoritative server in Phase 1)
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
   - WebRTC connections only created between peers in the same room
   - Yjs doc per room — don't sync unrelated rooms

**Acceptance Criteria:**
- [ ] Network latency < 100 ms (LAN)
- [ ] Movement appears smooth, no stuttering
- [ ] Tauri node CPU usage < 20 % during 4-player session

**Estimated Time:** 3 hours

---

#### Sprint 3 Summary

**Deliverables:**
- ✅ Embedded sovereign WebSocket signaler in Tauri node (Rust)
- ✅ WebRTC P2P connections brokered without any third-party service
- ✅ 2-4 player multiplayer with movement and Yjs room-state sync

**Demo Milestone:** Demo with 2 physical devices on a LAN — no internet required

**Technical Validation:**
- Latency: < 100 ms (LAN), < 200 ms (remote)
- Frame rate: 60 fps maintained
- Connection stability: No unexpected disconnects
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

**Server-Side:**
- Chat messages are appended to the Yjs `chat` array in the room document
- Yjs CRDT sync propagates messages to all peers over the WebRTC reliable channel
- No Socket.io server, no hosted relay — history persists in the CRDT and is replayed on reconnect

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

**Ownership Model (Phase 1 — local/CRDT only):**
- Each capsule slot has an `owner` field in the Yjs `objects` map
- A player can claim an unclaimed capsule by pressing E at its door panel
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

### Decision 1: Network Architecture — Sovereign WebRTC vs Socket.io

**Problem:** Which networking solution aligns with both Phase 1 speed and the project's sovereignty requirement?

**Decision:** WebRTC P2P brokered by an embedded Tauri signaling server

**The Sovereignty Test (from Architecture STUDY v002 §3):**
> *"If GitHub, Cloudflare, and the dev team all disappeared tomorrow, could a player's Tauri node bootstrap the game?"*

Socket.io requires a hosted server on Railway/Render — a third party we do not control. It fails the Sovereignty Test immediately. The embedded Tauri signaler passes it: the infrastructure is the player base.

**Rationale:**
| Criteria | Socket.io + Railway/Render | WebRTC + Embedded Tauri Signaler |
|----------|---------------------------|----------------------------------|
| **Sovereignty** | ❌ Fails — third-party server | ✅ Passes — player-run infra |
| **Implementation Speed** | ✅ 1-2 days | ✅ 1-2 days (signaler is ~small Rust file) |
| **Debugging** | ✅ Simple message inspection | ✅ Tauri console + `simple-peer` event log |
| **P2P Scale** | ❌ Server bottleneck | ✅ Mesh up to ~12-15 peers; host authority beyond |
| **Offline / LAN play** | ❌ Requires internet + server | ✅ Works on LAN with zero internet |
| **Cost** | ⚠️ Requires free/paid hosting | ✅ Zero infra cost |
| **Alignment with Phase 2+** | ❌ Must be ripped out | ✅ Grows into Chia registry + libp2p DHT |

**Trade-offs accepted:**
- WebRTC NAT traversal adds complexity → mitigated by baked-in seed list and Tauri-embedded STUN reflection
- `simple-peer` ICE negotiation takes ~1-2 s on first connect → acceptable for Phase 1

**Future Path:**
- Phase 2: LAN-local Tauri nodes auto-discover via mDNS (zero config)
- Phase 3: Chia on-chain host registry as the production bootstrap (no seed list needed)
- Phase 4+: `rust-libp2p` QUIC + gossipsub replaces signaler for native swarm

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
| **Sovereignty** | ❌ Implies a sync server | ✅ Syncs over our own WebRTC transport |

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

### Risk 2: WebRTC NAT Traversal Failures

**Description:** Some network configurations (symmetric NAT, corporate firewalls) can block WebRTC peer-to-peer connections even with STUN

**Impact:** Medium — affects players on restrictive networks

**Likelihood:** Low-Medium — most home/mobile networks work fine with STUN

**Mitigation:**
1. **Embedded Tauri STUN:** Tauri node reflects ICE candidates itself — no Google STUN dependency
2. **App-Layer Relay:** Tauri node acts as relay of last resort for peers that can't connect directly
3. **Baked-in seed list:** Multiple community Tauri nodes in the build reduce single-point failure

**Contingency:** Display connection quality indicator; guide players to run a Tauri node for better connectivity

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

**Contingency:** Allow players to manually enter a known Tauri node address

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
- [simple-peer Documentation](https://github.com/feross/simple-peer)
- [Vite Documentation](https://vitejs.dev/)
- [rust-libp2p Documentation](https://docs.rs/libp2p/latest/libp2p/)
- [msgpackr Documentation](https://github.com/kriszyp/msgpackr)

### Tutorials and Examples
- [Three.js Journey](https://threejs-journey.com/) - Excellent Three.js tutorials
- [Tauri Getting Started](https://tauri.app/v2/guide/create/) - Tauri project setup
- [Yjs Shared Editing](https://docs.yjs.dev/getting-started/a-collaborative-editor) - CRDT intro
- [simple-peer Examples](https://github.com/feross/simple-peer/tree/master/example) - WebRTC data channels
- [Multiplayer Game Architecture](https://www.gabrielgambetta.com/client-server-game-architecture.html)

### Architecture References
- [Architecture STUDY v002](../../../brainstorming/AI%20BRAINSTORMING/STUDY-Architecture%20v002.md) — the sovereign tech path this plan implements
- §5 "Web-First, Tauri-Best" delivery model
- §6 Sovereign Discovery & Signaling Layer
- §9.2 The sovereign signaler (embedded Rust WSS broker)

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

**Implementation Location:** All code implementations will be in `/prototypes/01-core-loop-demo/`

**Documentation Philosophy:** This plan focuses on WHAT to build and WHY. The HOW (code) lives in the prototype folder.

**Iteration:** This plan will be updated based on Sprint retrospectives and technical discoveries during implementation.
