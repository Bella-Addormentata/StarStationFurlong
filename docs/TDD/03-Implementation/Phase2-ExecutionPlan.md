# Phase 2: Solar System Map & Modular Expansion - Technical Execution Plan

> **Maps to ROADMAP:** Phase 2 - Exploration & Ownership  
> **Product Goal:** "I can navigate the solar system, discover minable asteroid fields, and snap modules onto my capsule to build a spaceship or expand my station."  
> **Prerequisite:** Phase 1 complete — public lobby, P2P networking, capsule room ownership working  
> **Status:** 🔲 Planned

---

## 🎯 Phase 2 Objectives

- [ ] **Solar System Map** — 2.5D top-down system map showing the star, planets, asteroid belts, and player locations
- [ ] **Map Navigation** — Players can travel between locations (station orbit, asteroid fields, planet approaches)
- [ ] **Station Placement** — Stations can occupy circular/elliptical orbits, Lagrange points (L1–L5), or free-floating positions; placement stored in CRDT
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

## 🛰️ Feature 3: Space Station Placement & Orbital Mechanics

### Station Placement Options

Stations can occupy one of three placement categories, each with its own data model and visual behaviour on the solar system map:

| Placement Type | Description | Examples |
|----------------|-------------|---------|
| **Circular / Elliptical Orbit** | Station locked to a Keplerian orbit around a body | Low planet orbit, asteroid-belt ring |
| **Lagrange Point** | Gravitationally stable co-orbital position relative to two bodies | L4/L5 of a planet–star pair (stable), L1/L2 (unstable — periodic station-keeping required) |
| **Free-Floating** | Not bound to any body; drifts on a manually set trajectory or is anchored at an interstellar waypoint | Deep-space outpost, cross-system relay |

### Lagrange Points

Lagrange points are calculated from the two parent bodies (primary + secondary) at well-known ratios of the orbital radius:

```
L1 — Between primary and secondary (unstable)
L2 — Behind secondary (unstable)
L3 — Opposite secondary across the primary (unstable)
L4 — 60° ahead of secondary in its orbit (stable ✅ recommended for player stations)
L5 — 60° behind secondary in its orbit (stable ✅ recommended for player stations)
```

On the 2D map canvas, L4/L5 positions are derived at runtime from the parent planet's current angle so no additional position data needs to be stored — only the point label and the parent body IDs.

### Orbital Data Schema

All station placements are stored in the solar system's top-level `Y.Map<StationOrbit>` (key = station ID):

```typescript
type OrbitType = 'circular' | 'elliptical' | 'lagrange' | 'free-floating';

interface StationOrbit {
  stationId:     string;       // matches capsule / station entity ID
  orbitType:     OrbitType;

  // Keplerian orbit (circular or elliptical)
  parentBodyId?: string;       // star or planet ID
  semiMajorAxis?: number;      // AU or arbitrary map units
  eccentricity?:  number;      // 0 = circular, 0–1 = elliptical
  inclination?:   number;      // degrees from ecliptic (2D map: always 0)
  anomaly?:       number;      // current true anomaly (radians); updated each tick

  // Lagrange point
  lagrangePoint?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  primaryBodyId?: string;      // e.g. the star
  secondaryBodyId?: string;    // e.g. the planet

  // Free-floating
  position?:     { x: number; y: number }; // fixed map coordinates
  velocity?:     { dx: number; dy: number }; // optional drift vector per tick
}
```

Only the relevant fields for the chosen `orbitType` are populated. The map renderer reads `StationOrbit` to compute the station's canvas position each frame.

### Station-Keeping & Stability

- **Stable Lagrange (L4/L5):** No periodic correction needed; position is computed from the parent planet's angle.
- **Unstable Lagrange (L1/L2/L3):** Station slowly drifts — players must occasionally activate a "station-keeping burn" (consumes fuel from a docked fuel-tank module). Drift accumulates in the CRDT `anomaly` field.
- **Free-floating:** Station holds its `position` until a player triggers a course correction or docking event.

### CRDT Sync

```typescript
// Solar-system-level Yjs doc (shared across all peers in a system)
const solarDoc = new Y.Doc();
const stationOrbits = solarDoc.getMap<StationOrbit>('stationOrbits');

// Place a station at L4 of the first planet
stationOrbits.set('furlong-station', {
  stationId: 'furlong-station',
  orbitType: 'lagrange',
  lagrangePoint: 'L4',
  primaryBodyId: 'sol',
  secondaryBodyId: 'planet-1',
});

// Move a free-floating outpost
stationOrbits.set('deep-relay', {
  stationId: 'deep-relay',
  orbitType: 'free-floating',
  position: { x: 420, y: -310 },
});
```

Because `stationOrbits` is a CRDT `Y.Map`, concurrent placement updates (two players repositioning the same station simultaneously) resolve deterministically without a server.

---

## 🔩 Feature 4: Snap-On Module System

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

## 🏠 Feature 5: Room Editing

Building on the capsule ownership established in Phase 1, owners can now rearrange furniture and place objects:

- Open edit mode with a toolbar (Phase 1 analogue: click a "Edit Room" button)
- Drag-and-drop objects on a grid
- Edits broadcast via Yjs `objects` map — all visitors see changes in real time
- Edit history: Yjs undo manager supports Ctrl+Z
- Owned capsule rooms start with a default layout; player can customise freely

---

## 📊 Performance Targets

- Solar system map render: < 5ms per frame (2D canvas, no WebGL)
- Lagrange point position computation (per-frame, per-station): < 0.1ms
- Asteroid field (50 nodes): stable 60fps in Three.js
- Module snap animation: < 200ms
- Room edit latency (local → peer): < 100ms

---

## ✅ Phase 2 Completion Criteria

- [ ] Solar system map renders with star, planets, asteroid belts, and station position
- [ ] Players can travel between zones; room context switches correctly
- [ ] Stations can be placed in orbits, at Lagrange points, or free-floating; placement persists in `stationOrbits` CRDT map
- [ ] L4/L5 station positions update correctly as parent planet orbits; unstable Lagrange drift accumulates without station-keeping
- [ ] Asteroid nodes deplete on extraction and are CRDT-synced across peers
- [ ] Capsule room owner can place and remove snap-on modules
- [ ] Attaching rocket engine + fuel tank + flight deck flags capsule as spaceship
- [ ] Station snap-on modules (gravity machine, gyroscope) render correctly
- [ ] Room editing works: drag objects, persist via Yjs, undo/redo
- [ ] Sovereignty check: all of the above work on a LAN with no internet access
