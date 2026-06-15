# Phase 2: Solar System Map & Modular Expansion - Technical Execution Plan

> **Maps to ROADMAP:** Phase 2 - Exploration & Ownership  
> **Product Goal:** "I can navigate the solar system, discover minable asteroid fields, and snap modules onto my capsule to build a spaceship or expand my station."  
> **Prerequisite:** Phase 1 complete — public lobby, P2P networking, capsule room ownership working  
> **Status:** 🔲 Planned

---

## 🎯 Phase 2 Objectives

- [ ] **Solar System Map** — 2.5D top-down system map showing the star, planets, asteroid belts, and player locations
- [ ] **Map Navigation** — Players can travel between locations (station orbit, asteroid fields, planet approaches)
- [ ] **Minable Resources** — Asteroid fields contain node clusters; players can interact with nodes to collect raw materials
- [ ] **Room Editing** — Capsule owners can place, move, and remove objects in their own capsule room
- [ ] **Snap-On Modules** — Modular components that attach to capsule rooms or station sections to transform or extend them

---

## 🌌 Feature 1: Solar System Map

### Map Design

```
         ☀  (Star)
        / | \
  🪐 P1  🪐 P2  🪐 P3
       |
  🌑 Asteroid Belt
       |
  🛸 Furlong Station (orbit)
```

- Top-down 2D canvas overlay (not Three.js — lightweight)
- Animated travel lines when a player moves between locations
- Click a location to see its name, resources, and occupants
- Zoom in/out with scroll wheel

### Travel System

- Travel between zones takes time (progress indicator or fast-travel toggle in dev mode)
- Players in the same zone are in the same P2P room; crossing zones creates a new room context
- Yjs doc per zone — state is isolated; reconnect replays zone state

---

## ⛏️ Feature 2: Minable Resources

### Asteroid Field Design

- Asteroid fields rendered as clusters of simple icosahedron geometries in Three.js
- Each asteroid node has a `resourceType` (iron, silica, rare-mineral) and a `yield` value stored in the zone's Yjs map
- Players interact (E key) to extract — yield decreases; node disappears when depleted
- Nodes regenerate on a timer (configurable per resource rarity)

### Resource Types (Phase 2)

| Resource | Rarity | Use |
|----------|--------|-----|
| Iron Ore | Common | Basic structures, modules |
| Silica | Common | Panels, viewports |
| Rare Mineral | Rare | Advanced modules, upgrades |

### Resource Sync

- Node yield values stored in zone's `Y.Map<AsteroidState>` — all players see the same depletion
- Extraction events sent over the reliable WebRTC channel (MessagePack)
- No authoritative server needed — CRDT handles concurrent extraction conflicts

---

## 🔩 Feature 3: Snap-On Module System

### Design Principle

> Modules are physical components that snap onto attachment points on capsule rooms or station sections. Attaching the right combination transforms the structure's type and capabilities.

### Capsule → Spaceship Transformation

Snap rocket engines, fuel tanks, and a flight deck onto a standard capsule room to convert it into a flyable spaceship:

| Module | Snap Point | Effect |
|--------|-----------|--------|
| Rocket Engine(s) | Rear attachment | Enables thrust; required for flight |
| Fuel Tank(s) | Side attachment | Determines range / burn time |
| Flight Deck | Front attachment | Adds pilot seat and navigation UI |

When all three required modules are attached → capsule is flagged `type: "spaceship"` and travel speed on the solar system map increases.

### Station → Expanded Station Modules

Station sections (the StarStation itself and player-owned docked stations) have their own attachment points:

| Module | Effect |
|--------|--------|
| Artificial Gravity Machine | Adds gravity-floor visual effect to the attached room |
| Gyroscope Array | Improves station stability; visual spinning gyro prop |
| Docking Bay Extension | Adds extra capsule attachment slots |
| Solar Collector | Generates in-game energy resource over time |

### Technical Implementation

```typescript
// Module snap system in Yjs
const modules = roomDoc.getMap<ModuleState>('modules')
// ModuleState { id, type, attachPoint, ownerId, attachedAt }

// When all required modules are present → compute derived roomType
function deriveRoomType(modules: Map<string, ModuleState>): RoomType { ... }
```

- Attachment points defined per room template (config object)
- Modules rendered as Three.js meshes at the corresponding world-space attachment point
- Snap animation: module glides to attachment point on placement
- Ownership check: only the capsule owner (or station admin) can add/remove modules

---

## 🏠 Feature 4: Room Editing

Building on the capsule ownership established in Phase 1, owners can now rearrange furniture and place objects:

- Open edit mode with a toolbar (Phase 1 analogue: click a "Edit Room" button)
- Drag-and-drop objects on a grid
- Edits broadcast via Yjs `objects` map — all visitors see changes in real time
- Edit history: Yjs undo manager supports Ctrl+Z
- Owned capsule rooms start with a default layout; player can customise freely

---

## 📊 Performance Targets

- Solar system map render: < 5ms per frame (2D canvas, no WebGL)
- Asteroid field (50 nodes): stable 60fps in Three.js
- Module snap animation: < 200ms
- Room edit latency (local → peer): < 100ms

---

## ✅ Phase 2 Completion Criteria

- [ ] Solar system map renders with star, planets, asteroid belts, and station position
- [ ] Players can travel between zones; room context switches correctly
- [ ] Asteroid nodes deplete on extraction and are CRDT-synced across peers
- [ ] Capsule room owner can place and remove snap-on modules
- [ ] Attaching rocket engine + fuel tank + flight deck flags capsule as spaceship
- [ ] Station snap-on modules (gravity machine, gyroscope) render correctly
- [ ] Room editing works: drag objects, persist via Yjs, undo/redo
- [ ] Sovereignty check: all of the above work on a LAN with no internet access
