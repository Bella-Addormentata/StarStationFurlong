# Angled Vestibules, Extensions & the Octagon Station — One Coherent Plan (#62)

*Star Station Furlong — flexible vestibules that bend, extensions that stretch, and enough parts to build the concept-art octagon (8 ring rooms + hub) manually, in-game, with today's one-room-at-a-time renderer. Design synthesis, not code.*

Repo root for prototype paths: `prototypes/0.29.0-core-loop-demo/src/`. Line numbers are carried from the three research passes that read the current 0.30.x files in-source this session; anything not source-verified is flagged. This document synthesizes three research lines — **(A)** current-code constraints, **(B)** station-graph model + math, **(C)** parts spec + build UX — and resolves their disagreements explicitly (§1.4, plus inline notes at each decision).

> **Companions:** [module-transform-docking-adapters-plan.md](module-transform-docking-adapters-plan.md) (module = room = Yjs doc; the docking/adapter system this plan extends) · [room-durability-plan.md](room-durability-plan.md) (owner-writes discipline, read-side-validation posture, and the one-doc-at-a-time sync reality this plan must respect) · shipped #64 (`doorsDoc.ts` — the wire this plan rides).

---

## 1. Executive summary

**What #62 asks:** vestibules that can bend at settable angles (per-joint settings panel, including an "adaptive" mode), extension segments that expand/contract the gap between modules, and the parts to assemble the concept art's octagon station. **What the art implies:** the boxy modules stay axis-aligned and *the bellows take the 45° turns*; ring modules alternate orientation (square / diamond); a central hub feeds spokes.

**The approach in one paragraph:** angles live in the connection, never the room. Rooms keep exactly four cardinal doors — untouched — and every bend, stretch, and extension is a property of a door-connection's ordered segment list, stored as **additive optional fields on the existing `DoorRecord`** (v0.30.x readers verified safe). The renderer walks the segment chain from the door face, accumulating a 2D pose, placing bellows/tube meshes along the way, and finally placing the neighbor's gray-box projection at the folded end pose instead of today's hardcoded cardinal 15.2 offset. Transit, pathfinding, camera, and the walk choreography change **zero**: the room swap already fires behind a full-screen fade at a hold point inside the first segment, so connectors stay non-walkable cosmetic space no matter how long the chain gets. No station coordinate frame is required to ship the octagon; a dedicated **station Yjs doc** (global poses + a closed-form solver) is the staged end-state that upgrades adaptive from heading-split to pose-solved and unlocks the whole-station map view and closure validation.

### 1.1 Ground truth today (verified by the constraints pass)

1. **There is no station frame.** One room renders at its own local origin (`world.ts:128-132`; walls at ±6, `world.ts:469-490`); neighbors are single translucent gray boxes at a hardcoded cardinal offset of 15.2 (`docking.ts:789-821`). "The octagon" will only ever exist as 9 Y.Docs plus connection records — which is exactly why every angle must be **stored data**, derivable later by a graph walk, never renderer state.
2. **The vestibule is fixed cosmetics.** `adapter.ts` builds a 3.0-deep, 5-ring straight gangway in one of 4 cardinal placements (`adapter.ts:40-42,133-138`); self-contained 3-function API (`build/setLightState/setOpacity`).
3. **The doors doc is additively extensible by accident of discipline.** `isDoorRecord` typeof-checks only `connectedRoomAddress` + `paired` (`doorsDoc.ts:68-72`); extra fields pass silently; `readAllDoors` iterates only the 4 door ids (`:76-84`). Old clients degrade to today's straight-gangway view and keep working transit.
4. **The avatar never traverses the connector.** Door walkthrough swaps rooms at the ±8.2 hold point behind an opaque fade (`world.ts:1426-1430` → `main.ts:1138-1144`); variable-length chains therefore need no choreography work.
5. **Seeds are unlimited.** PROVISION NEW MODULE already mints room seeds on demand (`main.ts:1179-1187`) — the octagon is buildable the moment parts and angled records exist.

### 1.2 The invariants (say them every time)

- **Rooms stay cardinal; the connector takes the turn.** `DoorId` stays the 4-value union (~160 references untouched); no room ever grows a non-cardinal door. The art agrees.
- **Store part identity and poses; never store derived geometry.** Solver outputs (θ1, θ2, solved lengths) are recomputed deterministically on every client. Stored geometry goes stale the moment anything moves.
- **Wire changes are additive-only.** The two legacy `DoorRecord` fields are always written, never renamed; new state that is station-global goes in the station doc, not room docs.
- **Validate on read, every client, deterministically.** Shape guards, feasibility check, overlap check — identical inputs reject identically on every client. Infeasible geometry fault-renders (red vestibule light, transit blocked); it never crashes and never diverges between clients.
- **Respect one-doc-at-a-time sync.** In-room views are 1-hop, fed by this room's own records. Whole-station views are fed only by the station doc. No cross-doc peeking.

### 1.3 The recommendation

Ship the octagon on per-room records first — parts renderer, wire extension, posed projections, build UX, then the literal in-game walkthrough (P1–P5, all frontend-only point releases). The station doc, pose solver, and map view follow as S1–S3 and rewrite nothing shipped earlier: the v1 mirror fields are exactly what S1's derivation refreshes. Full ordering in Part 7.

### 1.4 Where the three research lines disagreed — resolutions

| # | Disagreement | Resolution (and where it's argued) |
|---|---|---|
| 1 | **Where the layout lives.** A + C: per-room `DoorRecord` only, station frame deferred. B: station doc as source of truth now. | **Staged hybrid** (§3.1): v1 ships per-room mirrored records (the octagon needs nothing more); S1 adds the station doc as source of truth, demoting the per-room fields to owner-refreshed mirrors. Nothing thrown away. |
| 2 | **Hub wiring.** C: spokes pinwheel +45° from hub cardinal doors into the four *diagonal* rooms (one universal preset). B: spokes run *dead straight* to the four *cardinal* rooms. | **Straight-cardinal wins on math** (§4.4): pose-solving C's pinwheel spoke yields θ1 ≈ 69° (> 60° limit) and 9.96 m of extension (> 7.2 m max) — infeasible. Cost: two presets instead of one. The art-reading discrepancy is filed as a known unknown (§8.1). |
| 3 | **Adaptive semantics.** A: "no locally computable necessary angle without a global frame — store `'auto'` as an inert value." B: full pose solve. C: heading-split from the stored `farYawDeg`. | **C then B** (§4.3): storing the far room's relative yaw makes heading-level adaptive locally computable in v1, dissolving A's objection; S2 upgrades adaptive to the full pose solve. A's inert-`'auto'` idea is dropped; C's `adaptive: boolean` is adopted over A's string union. |
| 4 | **Schema shape.** A: nested `link?: {...}`. B + C: flat optional fields. | **Flat** (§3.2) — two of three, and it keeps the record a single shallow LWW object like today. |
| 5 | **Part dimensions.** B's math used flex 1.5 / ext 3.0 (A suggested reusing the 5-ring vestibule). C: flex rest 2.4 with 7 rings, extensions in 0.6 m bays (2–12). | **C's dimensions adopted** (they were derived against `adapter.ts` visual language, with the bellows-pinch math done). All of B's octagon numbers are **re-derived here** under C's dimensions: R = 23.41, not 21.93 (§4.4). B's closed form and feasibility logic carry over unchanged. |
| 6 | **Bend limits/snap.** B: clamp 45°, snap {0, ±22.5, ±45}. A: 45° steps. C: clamp ±60°, snap 7.5°. | **±60° snap 7.5°** — a superset; 22.5° and 45° stay on-grid; the camera-detent argument only ever constrained *doors*, which stay cardinal. |
| 7 | **Per-segment physical limits in the record** (B: `minLength/maxLength/maxBendDeg` on every segment) vs implicit. | **Code-side parts catalog keyed by `kind`**, with a reserved future `variant` field — per-record limits are redundant while all parts of a kind are identical, and the guard must clamp against the catalog anyway. Also: B's two-extension spoke `[flex, ext, ext, flex]` collapses to a single 11-bay extension under C's bay range (§4.4). |

---

## 2. What the octagon breaks in today's code (and what it doesn't)

The framing corollary first: because the art keeps modules axis-aligned, **most of the "4-door assumption" is a non-issue**. The inventory, distilled from the constraints pass:

| Subsystem | Today | Verdict for #62 |
|---|---|---|
| `DoorId` union, door positions, `DOORS` table (`doors.ts:20,30-35`; `docking.ts:35,87,109-114`) | 4 cardinal doors, fixed positions/rotations | **Untouched.** One connection per door; the octagon needs max 3 per ring room, 4 on the hub — the keyspace holds. |
| Facing fade (`docking.ts:63-68,749-779`) + camera detents (`cameraRig.ts:37`, STEP_RAD = π/4) | Dots cardinal normals against 45°-detent yaw | **Untouched** — doors stay cardinal; octagon bends happen to align with existing detents. |
| `drawAdjacentRoomProjection` (`docking.ts:789-821`) | Cardinal switch; gray box 11.8×4.0×11.8 at hardcoded offset 15.2 | **The real wall.** Replace with an end pose folded from the segment chain (position + accumulated yaw); box gets `rotation.y`; add dispose+redraw on record change (today build-once). Box *size* stays — neighbors are same-size rooms. |
| `buildVestibule` (`adapter.ts:40-42,79,116`) | Fixed INNER 3.0×3.2, DEPTH 3.0, 5 rings, 4 cardinal placements | **Parameterize** into a chain builder (Part 5). Self-contained cosmetics with a stable 3-function API — the easiest extension in the whole set. |
| `resolveArrivalDoor` (`world.ts:1563-1570`) | Hardcoded opposite-cardinal map | **Breaks**: departing east through a 90°-total-bend chain can arrive at the target's *east* door. Prefer the record's `farDoor`, keep opposite-cardinal as legacy fallback. |
| `applyRemotePairing` idempotency (`docking.ts:613`) | Early-returns when address matches | **Breaks silently**: an angle-only edit is swallowed. The check must also diff `segments`/`farDoor`/`farYawDeg`. (Flagged independently by lines A and C.) |
| Walk choreography (`player.ts:123,180,1196-1314`), transit swap (`main.ts:1028-1128`, epoch guard `:91-98`), failure restore (`world.ts:1613-1623`) | Swap at ±8.2 hold point behind fade | **Untouched.** The hold point sits inside the *first* flex of any chain; connectors stay non-walkable. |
| Pathfinding (`pathfinding.ts:21-25,55,240`) | 22×22 single-room grid, hard `|w| > 5.0` boundary | **Untouched, deliberately.** Walkable connectors = per-room grid rebuild + camera work; out of scope (§8.8). |
| Zoom/vestibule visibility + opacity (`world.ts:1535,1538-1551`) | Per-group, geometry-agnostic | **Survive unchanged.** Zoom L3 is already named for a future station view (`zoom.ts:57-64`). |
| Morph teardown (`world.ts:859-874`) | Disposes vestibules, rebuilds docking | **Discipline to keep**: chain groups must live under the same dispose path. |
| North door (`doors.ts` `enabled:false`, gate at `docking.ts:124`) | Disabled — fireplace | **Six of the ten octagon rooms need it** (hub, R2, R3, R4, R6, R7 — §6.3). Dev-phase: an enable toggle; fireplace overlap is cosmetic. Real fix is furniture-layout work, not architecture. |
| Multi-hop previews | Neighbor's pairings live in the neighbor's Y.Doc; sync is one-doc-at-a-time | **Consciously deferred.** 1-hop already delivers the interior payoff: two bellows chains bending away at 45° plus a spoke. The full ring belongs to the station-doc map view (S3). |

---

## 3. The station-graph model

### 3.1 Staging decision — per-room mirror first, station doc as end-state source of truth

*(Resolution #1.)* Line B is right that the octagon is inherently global state and that dual-written per-room records will drift without an arbiter; lines A and C are right that the client syncs exactly one doc at a time (`joinRoom`/`leaveRoom` lifecycle, doc destroyed on leave, `main.ts:883-910`) and that a visitor standing in ring-room 3 has that room's doc and nothing else. Both are satisfied by staging:

- **v1 (P-slices):** each room's `DoorRecord` carries its own outward view of the chain; the far room's record is the **mirror** — segments reversed, every `bendDeg` negated, `farYawDeg` negated. Mirroring makes the two rooms' independent renders pairwise-consistent *by construction*, with zero new sync infrastructure. Global closure is **not** validated anywhere in v1 (stated plainly; the symmetric presets close the octagon, hand-edited mismatches are per-room cosmetic — §8.3).
- **S1:** a station Yjs doc (own minted seed — same minting path as rooms, just a doc with no world attached) becomes the single source of truth: room poses + connection records. Per-room fields become derived mirrors, refreshed by each room's owner whenever the station doc changes; on disagreement the station doc wins and the owner's client rewrites the mirror. The map view is the only consumer that needs the station doc itself (fetched lazily when the map opens; a persistent second sync session is a later networking decision, §8.6).

### 3.2 v1 wire format — `DoorRecord` extension (additive, v0.30.x-safe)

```ts
// doorsDoc.ts — extended, never renamed. Verified safe for old readers:
// isDoorRecord (doorsDoc.ts:68-72) typeof-checks ONLY the two legacy fields;
// readAllDoors (:76-84) iterates only the four door ids.

type ConnSegment =
  | { kind: 'flex';
      adaptive: boolean;          // true => bendDeg derived on read (§4.3)
      bendDeg: number;            // -60..+60, UI snap 7.5; + = clockwise
      stretch: number }           // -0.30..+0.45 m, UI snap 0.15; rest length 2.4
  | { kind: 'ext';
      bays: number;               // 2..12, bay = 0.6 m
      skin: 'ribbed' | 'solid' };

interface DoorRecord {
  connectedRoomAddress: string;   // legacy — always written
  paired: boolean;                // legacy — always written
  segments?: ConnSegment[];       // absent => legacy straight 3.0 gangway
  farDoor?: DoorId;               // arrival door in the far room (fixes resolveArrivalDoor)
  farYawDeg?: number;             // far room yaw relative to this room (0 or 45 for now)
  // Reserved for S1; written only once the station doc exists:
  stationId?: string;
  connectionId?: string;
  neighborPose?: { dx: number; dz: number; dyawDeg: number }; // replaces the 15.2 offset exactly
}
```

Physical limits (rest/min/max lengths, max bend) live in a **code-side parts catalog** keyed by `kind`, with a `variant` field reserved for future parts (long extension, wide-bore flex) — resolution #7. Read-side guards in the `isDoorRecord` style: kind/skin whitelisted, numbers finite, values clamped to catalog, segment count ≤ 8; unknown kinds skip the whole chain (render legacy straight gangway, keep transit).

**Mirror write seam** (honest): a room's doors doc is writable only while joined. Two-player flow writes the mirror at pairing-accept, as today. Solo dev flow (auto-accept, §6.1) writes it lazily on the player's first entry to the far room — and the octagon walkthrough transits every link anyway, so mirrors land naturally.

### 3.3 S1 — station doc schema

```ts
// stationDoc.ts (new) — one Yjs doc per station, doc id = minted station seed.
// Y.Map 'meta': schemaVersion: 1, name, founder (claimed with the has('founder')
//   pre-sync race guard from main.ts), createdAt.

interface StationRoomRecord {          // Y.Map 'rooms', key = room address
  address: string;
  pose: { x: number; z: number; yawDeg: number };  // station frame, planar XZ
  owner: string;    // informative; verified against that room's roomInfo.owner on
                    // join — self-signed claims are not ownership (presence-addr posture)
  addedAt: number;  // deterministic tiebreak for overlap resolution
}

interface StationConnectionRecord {    // Y.Map 'connections', key = id
  id: string;       // canonical: two endpoints sorted lexicographically —
                    // `${addrA}#${doorA}--${addrB}#${doorB}` — dedupes the
                    // "both owners docked simultaneously" race by construction
  a: { address: string; door: DoorId };
  b: { address: string; door: DoorId };
  segments: ConnSegment[];             // ordered a -> b
  status: 'proposed' | 'confirmed';    // two-key consent (§3.4)
  proposedBy: string;
  confirmedBy?: string;
}
```

### 3.4 Authority + trust (S1)

CRDTs cannot prevent writes — enforcement is owner-gated UI on the write side plus **mandatory read-side validation**, exactly the shipped `furnitureDoc`/`doorsDoc` discipline:

- **Founder** (`meta.founder`): station meta; may delete (not add) records. Does **not** own member rooms.
- **Membership**: adding a room requires that room's owner; a room owner can always remove their own room (the station references rooms, it never owns them). Read-side, a `StationRoomRecord.owner` mismatch against the room's actual `roomInfo.owner` ghosts that room.
- **Poses**: moved by that room's owner or the founder.
- **Connections — two-key consent**: endpoint A's owner writes `proposed`; endpoint B's owner flips to `confirmed`. Solid rendering + transit only when confirmed; proposed renders ghosted with the amber `cycling` light state. Either endpoint owner deletes. (v1 rides the existing pairing accept flow instead; two-key status arrives with S1.)
- **Read-side guards, every client, every record**: shape guards → §4.2 feasibility → **overlap check** (OBB-vs-OBB over room pairs, 0.5 m margin; the later-`addedAt` room ghosts, tiebreak lexicographic address). Deterministic inputs mean every client rejects identically; nobody can wedge a broken layout into other clients' worlds.

### 3.5 Compatibility with v0.30.x

No data migration. Old clients (i) accept the richer `DoorRecord` because extra optional fields pass the guard untouched, and (ii) never see new map keys. They degrade to a normal pairing: straight 3.0 gangway, gray box at cardinal 15.2, **working transit** (arrival-door falls back to opposite-cardinal — possibly the "wrong" door on a bent chain, cosmetically odd, functionally fine). Rules: never rename/remove the two legacy fields; always write them alongside the new ones; station-global state goes only in the station doc; `meta.schemaVersion: 1` reserves the future bump.

---

## 4. The geometry solve

### 4.1 Conventions

2D in the XZ plane, y-up; vectors `(x, z)`; `signedAngle(u, v) = atan2(u.x*v.z − u.z*v.x, u.x*v.x + u.z*v.z)`. Pick **one** convention everywhere and map to Three.js only at the render boundary (`group.rotation.y = −θ` under this cross product with the scene's current axes). The four existing cardinal cases in `adapter.ts` are the regression check for the mapping (§8.2).

### 4.2 Closed form (S2)

Model a flex of length `f` as: straight `f/2`, hinge θ, straight `f/2`. For a chain `[flex f1, extension(s), flex f2]` from door A (`pA`, outward normal `dA`) to door B (`pB`, outward normal `dB`):

```
d2 = −dB                                   // direction entering room B
Δ  = signedAngle(dA, d2)                   // total turn the chain must absorb
G  = (pB − pA) − (f1/2)·dA − (f2/2)·d2     // the straight mid-run vector
θ1 = signedAngle(dA, G)
θ2 = Δ − θ1
ΣL = |G| − (f1 + f2)/2                     // total extension length
```

Three unknowns, three equations (2 position + 1 heading) — **exactly determined, closed form, no iteration**. Distribute `ΣL` across extension bays; if a clamp binds, absorb the residual into flex stretch (one fixed-point re-pass of `G`; converges immediately since `f` enters only as `f/2`).

**Feasibility, validated on read by every client:** `|θ1|, |θ2| ≤ 60°`; `ΣL` within the chain's bay range after stretch absorption; `|G| > 0`. Infeasible ⇒ the existing `fault` light state (red, via `setVestibuleLightState`) + transit blocked. Never a crash, never divergent geometry between clients.

### 4.3 Adaptive-first, staged; manual as constrained override

*(Resolution #3.)*

- **v1 (no global frame):** required total turn `Θ = wrap180(farYawDeg + localBearing(farDoor) + 180 − localBearing(nearDoor))`; adaptive flexes split `Θ` minus the sum of manually-fixed bends, evenly. With both flexes adaptive and `farYawDeg = 45`, every octagon ring link self-solves to 22.5/22.5 — the default pane state needs zero angle input. Stretch stays manual/aesthetic in v1: without a frame there is no distance constraint, honestly stated.
- **S2 (station frame):** adaptive becomes the full §4.2 pose solve. **Manual becomes a checked override:** poses stay authoritative; the client forward-kinematics the manual chain from door A and compares against door B. Within tolerance (0.05 m, 0.5°) it renders solid; outside, fault light + transit blocked until fixed or flipped to adaptive. Manual UI snaps: bend 7.5° steps clamped ±60°; stretch 0.15 steps; live residual readout colored idle-cyan / cycling-amber / fault-red. (Solver outputs are never snapped — snapping is manual-UI only.)

### 4.4 Worked octagon numbers — re-derived under the parts dimensions

*(Resolutions #2, #5, #8. Line B's derivation used f = 1.5, L = 3.0; the adopted parts have flex rest f = 2.4 and 0.6 m bays, so every number below is recomputed. B's formulas are unchanged.)*

Room width w = 11.8 (half h = 5.9); s = sin 45° ≈ 0.70711; cos 22.5° ≈ 0.92388. Eight ring rooms at `Ck = (R·cos kφ, R·sin kφ)`, φ = 45°, yaw alternating 0° / 45° — square rooms mod 90° means **the art's alternating orientation falls out automatically**.

**Ring links** — every one identical by symmetry: `[flex, ext×4, flex]`, θ1 = θ2 = 22.5° (symmetry satisfies the heading equation for *any* radius; R only sets the extension length):

```
R = [ (L + f)·cos 22.5° + (h + f/2)·(1 + s) ] / s
L = 2.4 (4 bays), f = 2.4  =>  R = 23.41        (was 21.93 under B's dims)
```

Numeric verification of one link (R0 at north, yaw 0, east door → R1 at NE, yaw 45, west door), run through §4.2 this session: `G = (4.435, −1.833)`, `|G| = 4.80`, θ1 = θ2 = 22.5°, `ΣL = 2.40` — exactly the 4-bay extension at rest. The closed form and the ring preset agree to the millimeter.

- Centers: cardinals `(±23.41, 0), (0, ±23.41)` yaw 0; diagonals `(±16.56, ±16.56)` yaw 45.
- Hull-corner clearance between ring neighbors ≈ 2.5 m — **estimate scaled from B's 1.4 m figure at R = 21.93** (neighbor separation grew 16.78 → 17.92 m), not re-derived from hull OBBs. Comfortable either way.

**Hub spokes — straight, to the cardinal rooms** (resolution #2). Δ = 0 ⇒ θ1 = θ2 = 0; straight run `ΣL = R − 2h − 2f = 23.41 − 11.8 − 4.8 = 6.81 m`. One 11-bay extension (6.6 m) + solver stretch +0.105 per flex (well inside +0.45). In v1 the spoke preset is simply `[flex 0 / ext×11 / flex 0]` — the 0.105 becomes real only under S2's solver.

**Why not the pinwheel** (C's proposal, checked numerically this session): hub north door → diagonal R1's south door at R = 23.41 gives `G = (11.54, 4.44)`, θ1 ≈ 69° (> 60° limit), θ2 ≈ −24°, `ΣL = 9.96 m` (> 7.2 m max). Heading-consistent, pose-infeasible — a dogleg, not a gentle S. It would render fine in v1's frameless cosmetics and then fault the moment S2 lands. Don't build data S2 will reject.

---

## 5. The parts

All parts follow `adapter.ts` house style: stacked rectangular ring frames (the existing `addRing` box recipe), fabric boxes, floor plates, and `vestibuleGlow`-named strips throughout — so `setVestibuleLightState` / `setVestibuleOpacity` work unchanged on any chain group, and the zoom/opacity machinery (`world.ts:1535-1551`) needs zero changes.

### 5.1 FLEX JOINT (corrugated bellows, parameterized bend)

Rest length **2.4 m**, stretch −0.30..+0.45; bend ±60° snap 7.5° (octagon uses 22.5°; the art's 45° is reachable in one joint). **7 rings** (denser than the vestibule's 5 — reads as bellows; 6 gaps ⇒ max 10°/gap at full bend, and the 0.08 fabric overlap covers it: inner-edge pinch at 60° ≈ 0.10 m, still positive). The straight vestibule's single long fabric box cannot bend — it becomes 6 short per-gap pieces.

Construction sketch (local frame: entry portal at origin facing +Z, bend yaws about +Y):

```ts
function buildFlexJoint(bendDeg: number, stretch: number): THREE.Group {
  const N = 7, L = 2.4 + stretch;
  const th = THREE.MathUtils.degToRad(bendDeg);
  const frame = (t: number) => ({                       // pose on a constant-curvature arc
    yaw: th * t,
    pos: Math.abs(th) < 1e-4
      ? new THREE.Vector3(0, 0, L * t)                  // straight degenerate case
      : new THREE.Vector3((1 - Math.cos(th * t)) * (L / th), 0, Math.sin(th * t) * (L / th)),
  });
  // rings: addRing recipe built into a posable sub-group, placed at frame(k/(N-1)),
  //        alternating heavy/light dims (3.45/3.65 vs 3.25/3.45), rotation.y = yaw
  // gaps:  left/right/ceiling fabric + floor plate + 2 glow strips per gap, placed at
  //        the midpoint, rotation.y = mean yaw, depth = ring distance + 0.16 overlap
  //        (overlap hides pleat shear)
}
```

No handrails inside the bellows (pure corrugation, per the art). Heavy portal frames (`adapter.ts`'s end frames) only where a flex terminates at a door; mid-chain ends get a light collar ring.

### 5.2 EXTENSION (straight tube, parameterized length)

Length = `bays × 0.6 m`, 2..12 bays (1.2–7.2 m). Same cross-section, straight. Two skins:

- **ribbed** — a ring frame every bay + fabric between: the vestibule look, elongated.
- **solid** (the art's mid-tube) — full-length hull walls in COL_FRAME, thin recessed groove strips (the door-leaf groove trick, `0x1C262E`) every 1.2 m as panel seams, a heavier collar ring every 2.4 m with an amber accent band, full-length floor plate + glow guide strips. Reads as rigid pressurized tube.

### 5.3 HUB — no new module kind

The 4-door room suffices: orientation lives in the connection graph, not the module. A distinct hub look is a later cosmetic (`roomInfo.moduleSkin: 'hub'`, rendered on the gray-box projection as a hemisphere cap + antennae). Notes: north/south doors are the SMALL (1.4 w) openings — the 3.0 w tube swallows them cosmetically, fine for v1 (§8.4). Perf worst case: 3 chains/room × (2 flexes × 7 ring-boxes + extension) — a few hundred boxes, negligible next to the room set (estimate, §8.7).

---

## 6. Build UX — the literal in-game octagon

### 6.1 Dev menu (`devMenu.ts`, new PARTS section — direct clone of the MODULES/VESTIBULE row pattern, `devMenu.ts:411-497`)

- `FLEX JOINT [+]`, `EXTENSION [+]` — localStorage parts counts (roomInventory pattern). Assembly consumes, removal refunds.
- `RING LINK [PRESET]` — arms `[FLEX +22.5 / EXT×4 solid / FLEX +22.5]`; `HUB SPOKE [PRESET]` — arms `[FLEX 0 / EXT×11 solid / FLEX 0]`. Two presets build all 12 links (resolution #2's cost).
- **Minted-seeds ledger with COPY buttons** — today a seed lands in the clipboard once; building 9 docs needs a ledger.
- `AUTO-ACCEPT MY MODULES [toggle]` — pairing requests targeting a seed this client minted complete without a human on the far side. The single biggest walkthrough simplifier (removes 12 hop-accept-hop round trips).
- `NORTH DOOR [enable]` — dev-phase unlock of the fireplace door (needed by 6 of 10 rooms, §6.3); fireplace overlap is cosmetic.

### 6.2 Assembly flow — extend from the docked door

("Lay parts in the world" would require a placement system that contradicts one-room-at-a-time rendering — rejected.) The per-door docking pane (`docking.ts` `mountInterfaceControlPanel`, `:298+`) gains a CONNECTION ASSEMBLY strip above the address input: chain chips `[FLEX +22.5] [EXT ×4 SOLID] [FLEX +22.5]`, `+FLEX` / `+EXT` buttons (consume parts), chip click expands inline settings — FLEX: `BEND [−] −22.5 [+]` / `ADAPTIVE [on/off]` / `STRETCH`; EXT: `BAYS` / `SKIN`; connection-level: `FAR ORIENTATION [0 / 45]` (writes `farYawDeg`). The chain renders live as a ghost (opacity 0.35 via `setVestibuleOpacity`) while unpaired. Then the normal flow: paste seed → INITIATE PAIRING; on accept the record publishes with `segments`, the far side gets the mirror. Post-pairing edits rewrite the record; the doors-doc observer rebuilds the chain + repositions the projection on every client (this is why `applyRemotePairing` must diff `segments`).

### 6.3 The door map

Ring rows from line C (verified against §4.2 for the R0→R1 case); hub rows corrected per resolution #2.

| Link | From (door) | To (door) | Turn | Preset |
|---|---|---|---|---|
| R0 N (yaw 0) → R1 NE (yaw 45) | R0 east | R1 west | +45 | RING |
| R1 → R2 E (yaw 0) | R1 east | R2 north | +45 | RING |
| R2 → R3 SE (yaw 45) | R2 south | R3 north | +45 | RING |
| R3 → R4 S (yaw 0) | R3 south | R4 east | +45 | RING |
| R4 → R5 SW (yaw 45) | R4 west | R5 east | +45 | RING |
| R5 → R6 W (yaw 0) | R5 west | R6 south | +45 | RING |
| R6 → R7 NW (yaw 45) | R6 north | R7 south | +45 | RING |
| R7 → R0 | R7 north | R0 west | +45 | RING |
| HUB → R0 N | hub north | R0 south | 0 | SPOKE |
| HUB → R2 E | hub east | R2 west | 0 | SPOKE |
| HUB → R4 S | hub south | R4 north | 0 | SPOKE |
| HUB → R6 W | hub west | R6 east | 0 | SPOKE |

Sanity checks that make this buildable: no room needs more than its 4 doors (cardinals use 3, diagonals 2, hub 4); every ring link is one preset with the +45-everywhere chirality closing the ring by symmetry; the north door is needed only in {hub, R2, R3, R4, R6, R7} — and R0, your lobby, keeps its fireplace. Each diagonal room keeps two outward doors free; each cardinal keeps one outward face free for windows.

### 6.4 The walkthrough (auto-accept ON, north door enabled, presets armed)

1. Backquote → DEV → PARTS: +24 FLEX, +12 EXTENSION. MODULES: PROVISION ×9 (7 ring + hub + ledger keeps them; R0 is your lobby).
2. In R0: EAST door keypad → RING preset ghost curves right → paste seed 1 → INITIATE. Pairs instantly; R1's gray box appears rotated 45° at the chain's end.
3. Walk through (transit) into R1. On arrival the mirrored record writes; R0's box now sits off your WEST door.
4. Repeat around the ring per the table: R1 east, R2 south, R3 south, R4 west, R5 west, R6 north, R7 north — pairing each fresh seed, walking each link.
5. In R7 the last ring link targets R0's *existing address* (not a fresh seed): NORTH door → RING preset → paste R0's address → INITIATE (auto-accept covers your own room). Walk through — you have circumnavigated home.
6. Hub: phone ACCESS → hub seed → enter the hub. Build 4 spokes from inside with the SPOKE preset: NORTH → R0's address, EAST → R2, SOUTH → R4, WEST → R6. Walk each spoke once to land the mirrors (or just visit over time; mirrors are lazy).
7. Done: 8-room ring, 8 identical bent links, 4 straight spokes, hub — all manual, all in-game.

---

## 7. Dependency-ordered slices

Sized like this repo ships them: one point release each, frontend-only, on the live prototype line. **Ordering note vs the naive "graph doc before angles" ordering:** angled projections and heading-adaptive need only the per-room record (§3.1, §4.3) — so the whole octagon ships before any station doc exists; the S-slices then add global truth without touching the P-slices' output.

| # | Slice | Files | Risk |
|---|---|---|---|
| P1 | **Parts renderer**: `buildFlexJoint` / `buildExtension` / `buildConnectorChain(doorId, segments)` beside `buildVestibule`; transform-cursor fold; parts catalog constants; legacy path intact | `adapter.ts` | Low. Self-contained cosmetics; 3-function API unchanged. Regression: 4 cardinal legacy cases pin the sign convention. |
| P2 | **Wire**: `DoorRecord` optional fields + guards (clamp to catalog, unknown kinds ⇒ legacy render); `applyRemotePairing` idempotency diffs `segments`/`farDoor`/`farYawDeg`; `resolveArrivalDoor` prefers `farDoor`, opposite-cardinal fallback | `doorsDoc.ts`, `docking.ts:613`, `world.ts:1563-1570` | Low-medium. Compat rule: legacy fields always written, never renamed. Two-client test: v0.30.x tab + new tab, same pairing. |
| P3 | **Posed rendering**: `drawAdjacentRoomProjection` end-pose from folded chain (+`rotation.y`, dispose+redraw on record change); `updatePairedVestibules`/`spawnTransitVestibule` build from the record | `docking.ts:789-821`, `world.ts:1445-1553` | Medium. Morph teardown discipline (`world.ts:859-874`); build-once guard becomes rebuild-on-diff. |
| P4 | **Build UX**: PARTS section, two presets, seeds ledger, auto-accept, north-door toggle; docking-pane assembly strip + chips; heading-adaptive compute; mirror write (accept-time + lazy-on-first-entry) | `devMenu.ts`, `docking.ts`, `main.ts` | Medium. Largest UI slice; the mirror seam is the subtle part — test both write paths. |
| P5 | **Octagon end-to-end** (§6.4 as the acceptance script; multi-tab per the testing recipe) | — (fixes only) | Low. This slice is the demo. |
| S1 | **Station doc**: schema + founder claim (race-guarded) + guards + overlap check + two-key consent; owner-refreshed mirrors (station wins); lazy fetch on map open | `stationDoc.ts` (new), `main.ts`, `doorsDoc.ts` | Medium. First second-doc lifecycle; keep it lazy/read-mostly in phase 1. |
| S2 | **Pose solver**: §4.2 closed form, feasibility ⇒ fault light + transit block, manual tolerance check, residual readout | `stationDoc.ts` consumer, `adapter.ts`, `docking.ts` | Medium. Unit-test solver against the four cardinal cases + the verified ring-link numbers (§4.4). |
| S3 | **Station map / zoom-L3 view** fed by a graph walk over the station doc | new view module, `zoom.ts` seam | File separately — camera + rendering scope of its own (already anticipated by `zoom.ts:57-64`). |

P1–P5 alone deliver #62's ask: bendable vestibules, stretchable extensions, per-joint settings with adaptive, and the buildable octagon. S1–S2 make the layout globally true and adaptive globally correct; S3 lets you finally *see* the octagon you built.

---

## 8. Known unknowns

Decision-forcing, not blocking. P1–P5 hold regardless of how these resolve.

1. **The art's hub-spoke reading.** Line C reads the concept art as spokes hitting the *diagonal* modules; the pose math rejects that wiring with these parts (§4.4). If the art must win, the fix is a 45°-rotated-doors hub variant (a real module change) — decide before S2 freezes the layout, not before P1.
2. **Sign-convention lock.** One `signedAngle` convention, one Three.js mapping (`rotation.y = −θ`), mirror negation, and C's "+ = clockwise" UI must all agree. The four cardinal legacy cases + the §4.4 ring-link numbers are the pinning tests; write them in P1, not P3.
3. **Mirror drift policy pre-S1.** Hand-edited mismatched mirrors are invisible in one-room-at-a-time play and only surface in the S3 map. Decide whether v1 shows any indicator ("unconfirmed geometry") or silently tolerates — current lean: tolerate, since S1 makes it structurally impossible.
4. **Small doors.** North/south openings are 1.4 w under a 3.0 w tube — cosmetically swallowed, and the octagon uses north doors in 6 rooms. Revisit a narrow-tube variant (a parts-catalog `variant`, no schema change) if it reads badly in P5.
5. **Fireplace.** The dev north-door toggle is a stopgap; the real fix is furniture-layout work (move the fireplace via the `FURNITURE` registry). Owns no P-slice; schedule when the octagon graduates from dev demo.
6. **Second-doc sync lifecycle (S1/S3).** Lazy fetch-on-map-open vs a persistent second sync session through the local node is a networking decision with staleness policy attached — unmeasured, and deliberately deferred out of the renderer work (both lines A and B agree here).
7. **Perf and pinch are estimates.** "A few hundred boxes" and the 0.10 m fabric pinch at 60° are computed, not measured — check both in P1 with the worst-case 3-chain room.
8. **Walkable connectors + transit polish.** Walking the chain interior (vs teleport-with-fade) needs per-room grid rebuilds and camera work; explicitly out of #62. The stored segment chains are sufficient input for it later — nothing here forecloses it.

---

*Provenance note: all file/line citations are carried from the three research passes (constraints, station model, parts/UX), which read the current 0.30.x files in-source this session; they will drift with edits. The §4.4 octagon numbers (R = 23.41, ring-link check, spoke run, pinwheel infeasibility) were re-derived in this synthesis under the adopted parts dimensions; the ~2.5 m clearance figure is a scaled estimate, not an OBB derivation. Conflict resolutions between the research lines are tabulated in §1.4 and argued inline. This document is design synthesis, not shipped behavior.*