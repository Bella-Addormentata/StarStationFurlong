/**
 * DEV MENU — TEMPORARY development panel (DEV1, owner request, demo phase).
 *
 * "add a temporary Development menu where players can add items to their
 *  inventory or the world for free at any time. new modules and vestibules
 *  and everything. … eventually this will be phased out. but for now we will
 *  need it for testing." — owner
 *
 * WILL BE REMOVED once the demo phase ends. Removal = delete this file, the
 * `#dev-menu-btn` line in index.html and the initDevMenu() call in main.ts —
 * nothing else in the codebase knows this module exists. To keep that true,
 * runtime furniture spawning REPLICATES World.addLobbyFurniture's per-item
 * registration path here (reaching into World's private collections through
 * a typed cast — the deliberate trade: a temporary module bends, the
 * permanent World API stays clean).
 *
 * Sections (scrollable):
 *  - ITEMS     : [+] per ITEM_DEFS entry → first free slot of the right tray
 *                in the room's storage trunk (local stowage, same store the
 *                trunk UI renders from).
 *  - OUTFITS   : [EQUIP] per OUTFITS entry → main.ts __setOutfit path.
 *  - FURNITURE : [+] per movable kind → spawns a NEW FurnitureItem at the
 *                nearest valid snapped spot to the player (validatePlacement
 *                search, outward), runs the full registration + rebake
 *                pipeline (obstacles → grid → seats → devices → replan), so
 *                the piece collides, paths, sits, focuses and edit-moves
 *                like built-in furniture — and syncs to the room (E4).
 *  - INVENTORY : pieces removed in edit mode (#53 — roomInventory.ts store),
 *                each with a PLACE button that re-spawns through the same
 *                machinery as FURNITURE and pops the inventory entry.
 *  - MODULES   : provision a module seed IF a transit build exposes
 *                window.__ssfProvisionModule (T1 of #30 — not on every
 *                branch); resilient either way.
 *  - VESTIBULE : toggle the PR-A adapter vestibule preview outside the east
 *                door (cosmetic — same as the ?vestibule=east flag).
 *
 * Guard rails: NOT behind a URL flag (owner wants it always available in the
 * demo) but loudly temporary-labeled. Esc closes it (deferring to the phone /
 * device-focus / edit-mode Esc owners); backquote (`) toggles; it never
 * captures WASD (no key handlers beyond those two, buttons blur after click)
 * and opening it does not pause the game. z-index sits BELOW the phone.
 */

import * as THREE from 'three';
import {
  FURNITURE, FURNITURE_DEFS, buildItemGroup, snapItemPos,
  footprintAabb, itemAabb,
} from './furniture';
import type { FurnitureItem, FurnitureKind, Rot } from './furniture';
// 🛰️ Hull space (exterior anchors + stacking) — moved out of furniture.ts.
import { findFreeExteriorSpot } from './hull';
import { validatePlacement, roomEdit } from './editMode';
import type { PlacementContext } from './editMode';
import { writeFurnitureItem } from './furnitureDoc';
import { ROOM_TEMPLATES, applyRoomTemplate, exportCurrentRoomAsTemplate } from './roomTemplates';
import { getDefaultRoomId } from './identity';
import { isDeviceFocusActive } from './deviceFocus';
import { OBSTACLES, rebuildObstacles } from './obstacles';
import {
  computeReachable, rebakeWalkableGrid, GRID_SIZE, worldToCol, worldToRow,
} from './pathfinding';
import { roomHalfExtents } from './floorPlanDoc';
import { SEATS, rebuildSeats } from './seats';
import { DEVICES, rebuildDevices } from './devices';
import type { WallScreenHandle, TrunkLidHandle, GameTableTopHandle, CloneVatHandle } from './devices';
import { DOORS } from './doors';
import {
  ITEM_DEFS, getItemDef, loadTrunkState, saveTrunkState,
  TOOL_SLOT_COUNT, TOTAL_SLOT_COUNT,
} from './items';
import {
  loadRoomInventory, takeFromRoomInventory, ROOM_INVENTORY_EVENT,
} from './roomInventory';
import { OUTFITS } from './outfits';
import {
  partsCount, addParts, armedPreset, setArmedPreset, moduleLedger,
  autoAcceptEnabled, setAutoAccept, northDoorUnlocked, setNorthDoorUnlocked,
  subscribeStationParts, type PresetId,
} from './stationParts';
import { showHint } from './hud';
import type { World } from './world';
import type { Player } from './player';

// ── Palette: dashed AMBER — deliberately unlike any shipped UI ───────────────
const DEV_AMBER = '#FFB300';
const DEV_AMBER_DIM = 'rgba(255, 179, 0, 0.55)';
const DEV_BG = 'rgba(12, 9, 2, 0.94)';
/** Below the phone (#spacephone-container z-index 5000). */
const DEV_Z = 4500;

/** Fixed room structure — everything else in FURNITURE_DEFS is spawnable. */
const NON_SPAWNABLE: ReadonlySet<FurnitureKind> = new Set<FurnitureKind>([
  'fireplace-wall', 'bar-corner', 'wall-computer',
]);

/** 🤖 Friendly dev-menu labels for kinds whose id doesn't read obviously. The
 *  charging dock IS how you place a robot — a placed dock spawns one robot at it
 *  (world.reconcileRobots), so label it so it's findable. */
const KIND_LABELS: Partial<Record<FurnitureKind, string>> = {
  'charging-dock': '🤖 ROBOT DOCK',
  'smiley-bouquet': '😊 SMILEY BOUQUET',
  'rose-bouquet': '🌹 ROSE BOUQUET',
  'purple-bouquet': '💜 PURPLE BOUQUET',
  'lavender-bouquet': '🪻 LAVENDER BOUQUET',
  'birthday-balloons': '🎈 BIRTHDAY BALLOONS',
  'birthday-balloons-wall': '🎈 BALLOONS (WALL-HUNG)',
};

type GetWorld = () => World | null;

/**
 * The private World collections addLobbyFurniture feeds per item — runtime
 * spawning must feed the SAME ones so zoom-hide, light fades, wall-screen
 * ticks, holo spins and trunk-lid drives all pick the new piece up.
 * (Deliberate private reach-through — see module header.)
 */
interface WorldInternals {
  platformGroup: THREE.Group;
  furnitureMeshes: THREE.Mesh[];
  furnitureLights: Array<{ light: THREE.PointLight; targetIntensity: number }>;
  wallScreens: Map<string, WallScreenHandle>;
  holoSpinners: Array<{ mesh: THREE.Mesh; speed: number }>;
  trunkLids: Map<string, TrunkLidHandle>;
  gameTableTops: Map<string, GameTableTopHandle>;
  cloneVats: Map<string, CloneVatHandle>;
}

let getWorld: GetWorld = () => null;
let panel: HTMLDivElement | null = null;
let spawnCounter = 0;

// Vestibule preview state (mirrors main.ts's ?vestibule flag wiring).
let vestibule: THREE.Group | null = null;
let vestibuleZoomTimer: number | null = null;

// ── Small helpers ─────────────────────────────────────────────────────────────

function activeRoomId(): string {
  const id = (window as unknown as { __ssfRoomId?: string }).__ssfRoomId;
  return typeof id === 'string' && id.length > 0 ? id : getDefaultRoomId();
}

/** Same seated-player fallback as editMode.localFloodOrigin. */
function floodOrigin(player: Player): { x: number; z: number } {
  const seatedId = player.getSeatedSeatId();
  if (seatedId) {
    const seat = SEATS.find((s) => s.id === seatedId);
    if (seat) return { x: seat.front.x, z: seat.front.z };
  }
  const pos = player.getPosition();
  return { x: pos.x, z: pos.z };
}

/**
 * Front points currently reachable from the origin that a spawn must keep
 * reachable (same set editMode.collectRequiredReachable guards for moves:
 * seat fronts, enabled door fronts, device fronts).
 */
function collectRequiredReachable(
  origin: { x: number; z: number },
): Array<{ x: number; z: number }> {
  const reachable = computeReachable(OBSTACLES, origin.x, origin.z);
  const isReachable = (p: { x: number; z: number }): boolean => {
    const row = worldToRow(p.z);
    const col = worldToCol(p.x);
    return row >= 0 && row < GRID_SIZE && col >= 0 && col < GRID_SIZE && reachable[row][col];
  };
  const pts: Array<{ x: number; z: number }> = [];
  for (const seat of SEATS) {
    if (isReachable(seat.front)) pts.push({ x: seat.front.x, z: seat.front.z });
  }
  for (const door of DOORS) {
    if (door.enabled && isReachable(door.front)) pts.push({ x: door.front.x, z: door.front.z });
  }
  for (const device of DEVICES) {
    if (isReachable(device.front)) pts.push({ x: device.front.x, z: device.front.z });
  }
  return pts;
}

// ── ITEMS: add to the room trunk's local stowage ─────────────────────────────

function addItemToTrunk(itemDefId: string): void {
  const def = getItemDef(itemDefId);
  if (!def) return;
  const trunk = FURNITURE.find((i) => i.kind === 'storage-trunk');
  if (!trunk) {
    showHint('DEV: no storage trunk in this room.');
    return;
  }
  const roomId = activeRoomId();
  const state = loadTrunkState(roomId, trunk.id);
  const [start, end] = def.kind === 'tool'
    ? [0, TOOL_SLOT_COUNT]
    : [TOOL_SLOT_COUNT, TOTAL_SLOT_COUNT];
  let slot = -1;
  for (let i = start; i < end; i++) {
    if (state.slots[i] === null) { slot = i; break; }
  }
  if (slot === -1) {
    showHint(`DEV: ${def.kind === 'tool' ? 'TOOLS' : 'WARDROBE'} tray is full — trunk can't take ${def.name}.`);
    return;
  }
  state.slots[slot] = def.id;
  saveTrunkState(roomId, trunk.id, state);
  showHint(`DEV: +${def.icon} ${def.name} → storage trunk (slot ${slot + 1}).`);
}

// ── OUTFITS: equip through main.ts's boot path ───────────────────────────────

function equipOutfit(outfitId: string): void {
  const setOutfit = (window as unknown as { __setOutfit?: (id: string) => boolean }).__setOutfit;
  if (typeof setOutfit !== 'function') {
    showHint('DEV: outfit path not ready yet.');
    return;
  }
  const outfit = OUTFITS.find((o) => o.id === outfitId);
  showHint(setOutfit(outfitId)
    ? `DEV: equipped ${outfit?.name ?? outfitId}.`
    : `DEV: could not equip '${outfitId}'.`);
}

// ── FURNITURE: spawn a new registry item at the nearest valid snapped spot ───

function uniqueSpawnId(kind: FurnitureKind, prefix = 'dev'): string {
  let id: string;
  do {
    spawnCounter += 1;
    id = `${prefix}-${kind}-${spawnCounter}`;
  } while (FURNITURE.some((i) => i.id === id));
  return id;
}

/**
 * Would the candidate footprint keep `margin` metres of breathing room from
 * every other obstacle box AND the walkable boundary? The A* grid bakes RAW
 * boxes while the player collides against boxes inflated by PLAYER_R, so a
 * flush spawn can put the new piece's own seat/device front in a
 * grid-walkable but physically impassable seam (the wedge trap documented at
 * furniture.ts's map-table entry). E3's drop gate deliberately allows flush
 * placement (the player chooses those seams consciously); a blind spawner
 * should not create them.
 */
function clearanceOk(item: FurnitureItem, pos: { x: number; z: number }, margin: number): boolean {
  if (margin <= 0) return true;
  const box = footprintAabb(item.kind, pos, item.rot);
  if (!box) return true; // decorative — never an obstacle, no seams to cause
  const { halfX, halfZ } = roomHalfExtents(); // placement box: 1 m inside walls
  const bX = halfX - 1, bZ = halfZ - 1;        // default 2×2 ⇒ ±5
  if (box.x0 - margin < -bX || box.x1 + margin > bX || box.z0 - margin < -bZ || box.z1 + margin > bZ) {
    return false;
  }
  for (const other of FURNITURE) {
    const ob = itemAabb(other);
    if (!ob) continue;
    if (
      box.x0 - margin < ob.x1 && box.x1 + margin > ob.x0 &&
      box.z0 - margin < ob.z1 && box.z1 + margin > ob.z0
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Search outward from the player over the kind's snap lattice for the first
 * position validatePlacement approves (bounds → overlap → player clearance →
 * connectivity — the exact E3 drop gate). Three nearest-first passes relax a
 * breathing-room preference (1 m keeps derived fronts physically standable —
 * see clearanceOk — then 0.5 m, then flush) so the common spawn lands in open
 * space but a crowded room still fills up before rejecting. Returns null when
 * the room is genuinely full.
 */
function findSpawnSpot(world: World, item: FurnitureItem): { x: number; z: number } | null {
  const player = world.getPlayer();
  const p = player.getPosition();
  const ctx: PlacementContext = {
    playerPositions: [{ x: p.x, z: p.z }, ...world.getRemotePlayerPositions()],
    floodFrom: floodOrigin(player),
    requiredReachable: collectRequiredReachable(floodOrigin(player)),
  };
  // Dedupe raw probe points onto the snap lattice, then try nearest-first.
  // Probe range spans the whole room from any in-bounds player pos (≈2·half);
  // the spawn bound is 0.5 m inside each wall. 🧱 #66 R1 — default 2×2 room
  // keeps the same in-bounds ±5.5 candidate set (wider raw range only adds
  // out-of-bounds probes that the filter drops), so the result is unchanged.
  const { halfX, halfZ } = roomHalfExtents();
  const probeX = Math.ceil(2 * halfX), probeZ = Math.ceil(2 * halfZ);
  const bX = halfX - 0.5, bZ = halfZ - 0.5;
  const seen = new Set<string>();
  const candidates: Array<{ x: number; z: number; d: number }> = [];
  for (let dx = -probeX; dx <= probeX; dx += 0.5) {
    for (let dz = -probeZ; dz <= probeZ; dz += 0.5) {
      const s = snapItemPos(item.kind, item.rot, p.x + dx, p.z + dz);
      if (s.x < -bX || s.x > bX || s.z < -bZ || s.z > bZ) continue;
      const key = `${s.x},${s.z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ x: s.x, z: s.z, d: (s.x - p.x) ** 2 + (s.z - p.z) ** 2 });
    }
  }
  candidates.sort((a, b) => a.d - b.d);
  for (const margin of [1.0, 0.5, 0]) {
    for (const c of candidates) {
      if (!clearanceOk(item, { x: c.x, z: c.z }, margin)) continue;
      if (validatePlacement(item, { x: c.x, z: c.z }, item.rot, ctx).ok) {
        return { x: c.x, z: c.z };
      }
    }
  }
  return null;
}

/**
 * Replicate World.addLobbyFurniture's per-item registration for a runtime
 * spawn, then snap the fade-in to "done": we are post-morph, so materials go
 * straight to their design opacity (userData.baseOpacity ?? 1) and point
 * lights to their fade target.
 */
function registerSpawnedGroup(world: World, item: FurnitureItem): void {
  const w = world as unknown as WorldInternals;
  const group = buildItemGroup(item);
  w.platformGroup.add(group);
  world.furnitureGroups.set(item.id, group);
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      w.furnitureMeshes.push(obj);
      if (obj.userData.wallScreen) {
        w.wallScreens.set(item.id, obj.userData.wallScreen as WallScreenHandle);
      }
      if (typeof obj.userData.holoSpin === 'number') {
        w.holoSpinners.push({ mesh: obj, speed: obj.userData.holoSpin as number });
      }
      if (obj.userData.trunkLid) {
        w.trunkLids.set(item.id, obj.userData.trunkLid as TrunkLidHandle);
      }
      if (obj.userData.gameTableTop) {
        w.gameTableTops.set(item.id, obj.userData.gameTableTop as GameTableTopHandle);
      }
      if (obj.userData.cloneVat) {
        w.cloneVats.set(item.id, obj.userData.cloneVat as CloneVatHandle);
      }
      const mat = obj.material as THREE.Material & { opacity: number };
      if ('opacity' in mat) {
        mat.opacity = (mat.userData.baseOpacity as number | undefined) ?? 1;
      }
      // 📸 same as World's reveal: alpha-tested cutouts render opaque —
      // alphaTest handles the keying without the transparent pass.
      if (mat.alphaTest > 0) mat.transparent = false;
    } else if (obj instanceof THREE.PointLight) {
      const targetIntensity = (obj.userData.targetIntensity as number) ?? 0;
      w.furnitureLights.push({ light: obj, targetIntensity });
      obj.intensity = targetIntensity;
    }
  });
}

/**
 * Registry push + world registration + the exact E3 commit pipeline (order
 * matters: seats AND devices bake world-space fronts/poses off the fresh
 * walkable grid), then replan — shared by the free-spawn (FURNITURE section)
 * and inventory re-place (#53 INVENTORY section) paths.
 */
function commitSpawn(world: World, item: FurnitureItem): void {
  FURNITURE.push(item);
  registerSpawnedGroup(world, item);
  rebuildObstacles();
  rebakeWalkableGrid();
  rebuildSeats();
  rebuildDevices();
  world.getPlayer().onObstaclesChanged();
  world.refreshOutdoorFloor(); // 🏊 a spawned pool hides the outdoor floor
  // 🤖 a placed charging-dock must spawn its robot NOW — the doc-echo reconcile
  // no-ops on this local add, so trigger the robot reconcile explicitly.
  if (item.kind === 'charging-dock') world.refreshRobots();
  // E4 (issue #60): publish the spawned piece so it syncs to everyone. AFTER
  // the local commit — the doc observer's reconcile then no-ops on the echo.
  writeFurnitureItem(item);
  // A live edit session indexed the raycast targets on enter — refresh it so
  // the new piece is immediately selectable/movable.
  if (roomEdit.isEditModeActive()) {
    roomEdit.forceExit();
    roomEdit.enter(world);
  }
}

function spawnFurniture(kind: FurnitureKind): void {
  const world = getWorld();
  if (!world || !world.getClickPlane() || !world.isPlayerActive()) {
    showHint('DEV: enter the room first.');
    return;
  }
  const item: FurnitureItem = {
    id: uniqueSpawnId(kind),
    kind,
    pos: { x: 0, z: 0 },
    rot: 0,
    movable: true,
  };
  // 🚀 Exterior-wall fittings mount on the hull, not the floor: hull.ts
  // searches the walls' outer lattices AND stackable faces (🛰️ a DEV-spawned
  // engine lands on the nearest free wall spot or tank stack automatically).
  const spot: { x: number; z: number; rot?: Rot; mountParent?: string } | null =
    FURNITURE_DEFS[kind].mount === 'exterior-wall'
      ? findFreeExteriorSpot(kind, item, world.getPlayer().getPosition())
      : findSpawnSpot(world, item);
  if (!spot) {
    showHint(`DEV: CAN'T SPAWN ${kind} — no valid spot (room is full).`);
    return;
  }
  item.pos = { x: spot.x, z: spot.z };
  if (spot.rot !== undefined) item.rot = spot.rot;
  if (spot.mountParent !== undefined) item.mountParent = spot.mountParent;
  commitSpawn(world, item);
  showHint(`DEV: spawned ${item.id} at (${item.pos.x}, ${item.pos.z}) — synced to the room (E4).`);
}

// ── INVENTORY: re-place furniture removed to the room inventory (#53) ────────

/**
 * PLACE button on a room-inventory row: re-spawn the stored KIND through the
 * exact spawn machinery above (nearest-valid-spot search, full placement
 * gate) and pop the entry. Ordering is deliberate: the entry is only taken
 * AFTER a spot is secured (a full room keeps the piece safely in inventory),
 * and the take re-checks the row's kind so a stale panel (list changed in
 * another tab / a remove landed while open) refuses rather than popping the
 * wrong entry. A re-placed piece gets a fresh `inv-` id — ids are not stable
 * across remove/re-place until E4 persistence (a removed trunk's stowage key
 * `ssf-trunk:<roomId>:<oldId>` is therefore orphaned; a re-placed trunk
 * seeds fresh contents — the TR-sync slice owns migrating that).
 */
function placeFromInventory(index: number, kind: FurnitureKind): void {
  const world = getWorld();
  if (!world || !world.getClickPlane() || !world.isPlayerActive()) {
    showHint('DEV: enter the room first.');
    return;
  }
  const item: FurnitureItem = {
    id: uniqueSpawnId(kind, 'inv'),
    kind,
    pos: { x: 0, z: 0 },
    rot: 0,
    movable: true,
  };
  // 🚀 Exterior-wall fittings re-mount on the hull (same routing as spawn).
  const spot: { x: number; z: number; rot?: Rot; mountParent?: string } | null =
    FURNITURE_DEFS[kind].mount === 'exterior-wall'
      ? findFreeExteriorSpot(kind, item, world.getPlayer().getPosition())
      : findSpawnSpot(world, item);
  if (!spot) {
    showHint(`DEV: CAN'T PLACE ${kind} — no valid spot (room is full). Kept in inventory.`);
    return;
  }
  if (!takeFromRoomInventory(activeRoomId(), index, kind)) {
    refreshInventoryRows(); // stale row — resync the panel with the store
    showHint('DEV: inventory changed underneath the panel — try again.');
    return;
  }
  item.pos = { x: spot.x, z: spot.z };
  if (spot.rot !== undefined) item.rot = spot.rot;
  if (spot.mountParent !== undefined) item.mountParent = spot.mountParent;
  commitSpawn(world, item);
  showHint(`DEV: placed ${item.id} from room inventory at (${item.pos.x}, ${item.pos.z}).`);
}

// ── MODULES: provision a module seed IF a transit build exposes the handle ───

function provisionModuleAvailable(): boolean {
  return typeof (window as unknown as { __ssfProvisionModule?: unknown }).__ssfProvisionModule === 'function';
}

async function provisionModule(): Promise<void> {
  const fn = (window as unknown as { __ssfProvisionModule?: () => unknown }).__ssfProvisionModule;
  if (typeof fn !== 'function') {
    showHint('DEV: module provisioning requires a transit build (T1 of #30).');
    return;
  }
  try {
    const raw = await Promise.resolve(fn());
    const seed = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!seed) {
      showHint('DEV: module provisioning returned no seed.');
      return;
    }
    // #52: the accept input moved into the phone — paste the seed into the
    // ACCESS app's ENTER WITH PASS field (Tab → 🚪 ACCESS → USE PASS).
    const passInput = document.getElementById('access-pass-input') as HTMLInputElement | null;
    if (passInput) passInput.value = seed;
    try {
      await navigator.clipboard.writeText(seed);
      showHint('DEV: module seed minted — copied to clipboard + the phone ACCESS app.');
    } catch {
      showHint(passInput
        ? 'DEV: module seed minted — pasted into the phone ACCESS app.'
        : 'DEV: module seed minted (clipboard unavailable).');
    }
  } catch (e) {
    console.warn('[devMenu] module provisioning failed:', e);
    showHint('DEV: module provisioning failed — see console.');
  }
}

// 🛰️ #79 P3 DEV: provision a FRESH standalone room (not docked to the current
// one) and beam into it as its OWNER — for authoring a new shared station.
function provisionStationAvailable(): boolean {
  return typeof (window as unknown as { __ssfProvisionStation?: unknown }).__ssfProvisionStation === 'function';
}

async function provisionStation(): Promise<void> {
  const fn = (window as unknown as { __ssfProvisionStation?: () => Promise<boolean> }).__ssfProvisionStation;
  if (typeof fn !== 'function') {
    showHint('DEV: new-station provisioning requires a transit build (T1 of #30).');
    return;
  }
  try {
    const ok = await fn();
    showHint(ok
      ? 'DEV: 🛰️ jumped into a fresh blank room you OWN — author it (add a clone-vat, keep one door), then Copy Invite to share it.'
      : 'DEV: new-station jump failed (busy or offline) — see console.');
  } catch (e) {
    console.warn('[devMenu] new-station provisioning failed:', e);
    showHint('DEV: new-station provisioning failed — see console.');
  }
}

// ── VESTIBULE: toggle the PR-A preview outside the east door ─────────────────

async function toggleVestibule(): Promise<void> {
  const scene = window.gameRenderer?.scene;
  if (!scene) {
    showHint('DEV: renderer not ready yet.');
    return;
  }
  if (vestibule) {
    if (vestibuleZoomTimer !== null) {
      window.clearInterval(vestibuleZoomTimer);
      vestibuleZoomTimer = null;
    }
    scene.remove(vestibule);
    // Free preview geometry/materials (the toggle can cycle many times).
    const disposed = new Set<THREE.BufferGeometry | THREE.Material>();
    vestibule.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry && !disposed.has(mesh.geometry)) {
        disposed.add(mesh.geometry);
        mesh.geometry.dispose();
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (mat && !disposed.has(mat)) {
          disposed.add(mat);
          mat.dispose();
        }
      }
    });
    vestibule = null;
    refreshDynamicRows();
    showHint('DEV: vestibule preview removed.');
    return;
  }
  try {
    const adapter = await import('./adapter');
    vestibule = adapter.buildVestibule('east');
    scene.add(vestibule);
    // Honor the zoom-hide convention (same cadence as main.ts's flag preview).
    vestibuleZoomTimer = window.setInterval(() => {
      const zv = (window as unknown as { multiScaleZoom?: { getLevel?: () => number } }).multiScaleZoom;
      if (vestibule) vestibule.visible = !zv || typeof zv.getLevel !== 'function' || zv.getLevel() < 3;
    }, 250);
    refreshDynamicRows();
    showHint('DEV: vestibule preview spawned outside the east door.');
  } catch (e) {
    console.warn('[devMenu] vestibule preview failed to load:', e);
    showHint('DEV: vestibule preview failed to load.');
  }
}

// ── Panel DOM ─────────────────────────────────────────────────────────────────

const ROW_STYLE = `
  display:flex; align-items:center; justify-content:space-between; gap:8px;
  padding:3px 2px; font-size:10px; letter-spacing:0.4px;
`;
const BTN_STYLE = `
  background:rgba(255,179,0,0.10); color:${DEV_AMBER};
  border:1px solid ${DEV_AMBER_DIM}; border-radius:4px;
  font-family:inherit; font-size:10px; font-weight:800; letter-spacing:1px;
  padding:3px 10px; cursor:pointer; flex-shrink:0;
`;
const SECTION_STYLE = `
  font-size:10px; font-weight:800; color:${DEV_AMBER}; letter-spacing:2px;
  border-bottom:1px dashed ${DEV_AMBER_DIM}; padding-bottom:4px;
  margin:10px 0 4px;
`;

function sectionHtml(title: string, note: string | null, rows: string[]): string {
  return `
    <div style="${SECTION_STYLE}">${title}${
      note ? ` <span style="font-weight:400; letter-spacing:0.5px; color:rgba(255,179,0,0.45); text-transform:none;">· ${note}</span>` : ''
    }</div>
    ${rows.join('')}
  `;
}

function buildPanel(): HTMLDivElement {
  const el = document.createElement('div');
  el.id = 'dev-menu-panel';
  el.style.cssText = `
    position: fixed;
    left: 24px;
    bottom: 64px;
    width: 300px;
    max-height: min(66vh, 620px);
    display: none;
    flex-direction: column;
    background: ${DEV_BG};
    border: 2px dashed ${DEV_AMBER};
    border-radius: 10px;
    color: ${DEV_AMBER};
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    z-index: ${DEV_Z};
    box-shadow: 0 10px 48px rgba(0,0,0,0.85);
    box-sizing: border-box;
  `;

  const itemRows = ITEM_DEFS.map((def) => `
    <div style="${ROW_STYLE}">
      <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${def.icon} ${def.name.toUpperCase()} <span style="color:rgba(255,179,0,0.4);">· ${def.kind}</span></span>
      <button type="button" data-dev-action="add-item" data-id="${def.id}" style="${BTN_STYLE}">+</button>
    </div>
  `);

  const outfitRows = OUTFITS.map((o) => `
    <div style="${ROW_STYLE}">
      <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${o.name.toUpperCase()}</span>
      <button type="button" data-dev-action="equip-outfit" data-id="${o.id}" style="${BTN_STYLE}">EQUIP</button>
    </div>
  `);

  const spawnableKinds = (Object.keys(FURNITURE_DEFS) as FurnitureKind[])
    .filter((kind) => !NON_SPAWNABLE.has(kind));
  const furnitureRows = spawnableKinds.map((kind) => `
    <div style="${ROW_STYLE}">
      <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${KIND_LABELS[kind] ?? kind.toUpperCase()}</span>
      <button type="button" data-dev-action="spawn-furniture" data-kind="${kind}" style="${BTN_STYLE}">+</button>
    </div>
  `);

  const moduleRow = `
    <div style="${ROW_STYLE}">
      <span id="dev-module-note" style="min-width:0;">MODULE SEED</span>
      <button type="button" id="dev-module-btn" data-dev-action="provision-module" style="${BTN_STYLE}">+ PROVISION</button>
    </div>
  `;

  // 🛰️ #79 P3: a FRESH standalone room (not docked here) you own, beamed into.
  const stationRow = `
    <div style="${ROW_STYLE}">
      <span id="dev-station-note" style="min-width:0;">🛰️ NEW STATION</span>
      <button type="button" id="dev-station-btn" data-dev-action="provision-station" style="${BTN_STYLE}">+ JUMP</button>
    </div>
  `;

  const vestibuleRow = `
    <div style="${ROW_STYLE}">
      <span>EAST-DOOR VESTIBULE (COSMETIC)</span>
      <button type="button" id="dev-vestibule-btn" data-dev-action="toggle-vestibule" style="${BTN_STYLE}">PREVIEW</button>
    </div>
  `;

  // 🧬 Re-run the clone-vat spawn ceremony (future death flow's entry point).
  const cloneRow = `
    <div style="${ROW_STYLE}">
      <span>CLONE-VAT SPAWN CEREMONY</span>
      <button type="button" data-dev-action="respawn-vat" style="${BTN_STYLE}">RESPAWN</button>
    </div>
  `;

  // 🏗️ Room templates — one-click place a whole authored room (RCT-style), or
  // EXPORT the current layout to the console to seed a new template in code.
  const templateRows = ROOM_TEMPLATES.map((t) => `
    <div style="${ROW_STYLE}">
      <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${t.description}">${t.name.toUpperCase()}</span>
      <button type="button" data-dev-action="place-template" data-template="${t.id}" style="${BTN_STYLE}">PLACE</button>
    </div>
  `);
  templateRows.push(`
    <div style="${ROW_STYLE}">
      <span>SAVE THIS ROOM → CONSOLE</span>
      <button type="button" data-dev-action="export-template" style="${BTN_STYLE}">EXPORT</button>
    </div>
  `);

  el.innerHTML = `
    <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;
      padding:10px 12px 8px; border-bottom:2px dashed ${DEV_AMBER_DIM};">
      <span style="font-size:11px; font-weight:800; letter-spacing:1.5px;">⚠ DEV MENU — temporary, will be removed</span>
      <button type="button" data-dev-action="close" aria-label="Close dev menu" style="${BTN_STYLE} padding:1px 8px;">✕</button>
    </div>
    <div style="overflow-y:auto; padding:4px 12px 12px; min-height:0;">
      <div style="font-size:9px; color:rgba(255,179,0,0.45); letter-spacing:0.5px; padding-top:6px;">
        Free spawns for demo testing · toggle with the DEV button or the \` key · ESC closes
      </div>
      ${sectionHtml('ROOM TEMPLATES', 'one-click place · REPLACES the room', templateRows)}
      ${sectionHtml('ITEMS', 'into the room trunk', itemRows)}
      ${sectionHtml('OUTFITS', null, outfitRows)}
      ${sectionHtml('FURNITURE', 'synced to the room (E4)', furnitureRows)}
      ${sectionHtml('INVENTORY', 'removed furniture · local only', ['<div id="dev-inventory-rows"></div>'])}
      ${sectionHtml('CLONE', 'respawn at the vat (🧬)', [cloneRow])}
      ${sectionHtml('MODULES', null, [moduleRow, stationRow])}
      ${sectionHtml('PARTS', 'station construction (#62)', ['<div id="dev-parts-rows"></div>'])}
      ${sectionHtml('VESTIBULE', null, [vestibuleRow])}
      ${sectionHtml('NAVIGATION', 'lost? beam straight home', [`
        <div style="${ROW_STYLE}">
          <span>🏠 GO HOME <span style="color:rgba(255,179,0,0.5);">· reload into your home station</span></span>
          <button type="button" data-dev-action="go-home" style="${BTN_STYLE}">GO</button>
        </div>
      `])}
    </div>
  `;

  // Panel clicks never reach the canvas click handler (same input-capture
  // rule as the device UIs) — a stray panel click must not release a device
  // focus, commit an edit-mode carry, or count as click-to-enter.
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-dev-action]');
    if (!btn) return;
    btn.blur(); // keep focus off buttons so Space/Enter can't re-trigger them
    switch (btn.dataset.devAction) {
      case 'close': setOpen(false); break;
      case 'go-home':
        // 🏠 Beam home: drop the resume-at-last-location pointer and reload
        // into a CLEAN URL. Stripping query + hash matters as much as the
        // localStorage key: a lingering ?seed= from an earlier link-visit
        // outranks the home fallback in bootstrapNetworking (URL import →
        // last-room → default), so a plain reload() would beam the player
        // right back into the foreign room they are trying to escape.
        try { localStorage.removeItem('ssf-last-room'); } catch { /* private mode */ }
        location.href = location.origin + location.pathname;
        break;
      case 'add-item': addItemToTrunk(btn.dataset.id ?? ''); break;
      case 'equip-outfit': equipOutfit(btn.dataset.id ?? ''); break;
      case 'spawn-furniture': spawnFurniture(btn.dataset.kind as FurnitureKind); break;
      case 'place-template': {
        const w = getWorld();
        if (!w || !w.isPlayerActive()) { showHint('DEV: enter the room first.'); break; }
        // ⚠️ Destructive: one click REPLACES every piece in the room, and one
        // stray click has already wiped a furnished home. Two-click arm/confirm:
        // the first click arms for 3 s (red ⚠), the second click executes.
        if (btn.dataset.armed !== '1') {
          btn.dataset.armed = '1';
          const prevText = btn.textContent;
          const prevCss = btn.style.cssText;
          btn.textContent = '⚠ REPLACE ROOM?';
          btn.style.background = 'rgba(255,23,68,0.18)';
          btn.style.borderColor = 'rgba(255,23,68,0.5)';
          btn.style.color = '#ff8a80';
          window.setTimeout(() => {
            if (btn.dataset.armed !== '1') return; // already executed
            btn.dataset.armed = '';
            btn.textContent = prevText;
            btn.style.cssText = prevCss;
          }, 3000);
          break;
        }
        btn.dataset.armed = '';
        btn.textContent = 'PLACE'; // restore from the armed look (timeout skips executed buttons)
        btn.style.cssText = BTN_STYLE;
        const t = applyRoomTemplate(btn.dataset.template ?? '');
        if (!t) break;
        // Furniture rebuilds via the doc subscription (replaceAllFurniture);
        // now move the doors + walls to the template's layout.
        w.reconcileDoorPlacements();
        w.updateSideWallCoverage();
        showHint(`DEV: 🏗️ placed "${t.name}" — ${t.items.length} pieces.`);
        break;
      }
      case 'export-template': {
        const w = getWorld();
        if (!w || !w.isPlayerActive()) { showHint('DEV: enter the room first.'); break; }
        const n = exportCurrentRoomAsTemplate();
        showHint(`DEV: 🏗️ ${n} pieces logged to the console.`);
        break;
      }
      case 'place-inventory':
        // Rows re-render synchronously on each place; a double-click's second
        // click lands on whatever row shifted up into the same spot and would
        // legitimately place THAT kind too (review F2) — first click only.
        if ((e as MouseEvent).detail > 1) break;
        placeFromInventory(Number(btn.dataset.index), btn.dataset.kind as FurnitureKind);
        break;
      case 'respawn-vat': {
        const w = getWorld();
        if (!w || !w.isPlayerActive()) { showHint('DEV: enter the room first.'); break; }
        showHint(w.respawnAtVat()
          ? 'DEV: 🧬 clone deployed — vat cycle running.'
          : 'DEV: no clone vat in this room — spawn one from FURNITURE first.');
        break;
      }
      case 'provision-module': void provisionModule(); break;
      case 'provision-station': void provisionStation(); break;
      case 'toggle-vestibule': void toggleVestibule(); break;
      // ── #62 P4 PARTS actions ──
      case 'add-flex': addParts('flex', 4); refreshPartsRows(); break;
      case 'add-ext': addParts('ext', 2); refreshPartsRows(); break;
      case 'add-adapter': addParts('adapter', 1); refreshPartsRows(); break;
      case 'arm-preset': {
        const p = btn.dataset.preset as PresetId;
        setArmedPreset(armedPreset() === p ? null : p); // toggle
        refreshPartsRows();
        showHint(armedPreset()
          ? `DEV: ${armedPreset() === 'ring' ? 'RING LINK' : 'HUB SPOKE'} preset armed — opens prefilled in the door keypad.`
          : 'DEV: preset disarmed.');
        break;
      }
      case 'toggle-auto-accept': setAutoAccept(!autoAcceptEnabled()); refreshPartsRows(); break;
      case 'toggle-north-door': {
        setNorthDoorUnlocked(!northDoorUnlocked());
        // Flip the live door flag too (doors.ts reads the store at build; a
        // running session updates in place — fireplace overlap is cosmetic).
        const north = DOORS.find((d) => d.id === 'north');
        if (north) north.enabled = northDoorUnlocked();
        refreshPartsRows();
        showHint(northDoorUnlocked() ? 'DEV: NORTH door enabled (fireplace overlap is cosmetic).' : 'DEV: NORTH door disabled.');
        break;
      }
      case 'copy-seed': {
        const seed = btn.dataset.seed ?? '';
        if (seed) {
          void navigator.clipboard.writeText(seed)
            .then(() => showHint('DEV: module seed copied.'))
            .catch(() => showHint('DEV: clipboard unavailable — seed is in the ledger row title.'));
        }
        break;
      }
    }
  });

  document.body.appendChild(el);
  return el;
}

/**
 * Rebuild the INVENTORY section's rows from the live room-inventory store
 * (#53). Called on open, and by the ROOM_INVENTORY_EVENT listener whenever
 * the store mutates (edit-mode remove / PLACE pop) while the panel is open.
 */
function refreshInventoryRows(): void {
  if (!panel) return;
  const holder = panel.querySelector<HTMLElement>('#dev-inventory-rows');
  if (!holder) return;
  const entries = loadRoomInventory(activeRoomId());
  if (entries.length === 0) {
    holder.innerHTML = `
      <div style="${ROW_STYLE}">
        <span style="color:rgba(255,179,0,0.4);">empty — edit mode's ✕ REMOVE (X key) stows furniture here</span>
      </div>
    `;
    return;
  }
  holder.innerHTML = entries.map((entry, i) => `
    <div style="${ROW_STYLE}">
      <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${entry.kind.toUpperCase()}${
        entry.storedAt > 0
          ? ` <span style="color:rgba(255,179,0,0.4);">· ${new Date(entry.storedAt).toLocaleTimeString()}</span>`
          : ''
      }</span>
      <button type="button" data-dev-action="place-inventory" data-index="${i}" data-kind="${entry.kind}" style="${BTN_STYLE}">PLACE</button>
    </div>
  `).join('');
}

/** #62 P4: rebuild the PARTS section rows (counts, presets, toggles, ledger). */
function refreshPartsRows(): void {
  const host = panel?.querySelector<HTMLElement>('#dev-parts-rows');
  if (!host) return;
  const preset = armedPreset();
  const onOff = (on: boolean) => on ? 'ON' : 'OFF';
  const ledger = moduleLedger();
  const ledgerRows = ledger.length === 0
    ? `<div style="font-size:9px; color:rgba(255,179,0,0.4); padding:2px 2px 0;">no minted modules yet — PROVISION adds them here</div>`
    : ledger.map((e) => `
        <div style="${ROW_STYLE}">
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${e.seed.replace(/"/g, '&quot;')}">📦 ${e.roomId.toUpperCase()}</span>
          <button type="button" data-dev-action="copy-seed" data-seed="${e.seed.replace(/"/g, '&quot;')}" style="${BTN_STYLE}">COPY</button>
        </div>
      `).join('');
  host.innerHTML = `
    <div style="${ROW_STYLE}">
      <span>🪗 FLEX JOINT <span style="color:rgba(255,179,0,0.5);">× ${partsCount('flex')}</span></span>
      <button type="button" data-dev-action="add-flex" style="${BTN_STYLE}">+4</button>
    </div>
    <div style="${ROW_STYLE}">
      <span>🧵 EXTENSION <span style="color:rgba(255,179,0,0.5);">× ${partsCount('ext')}</span></span>
      <button type="button" data-dev-action="add-ext" style="${BTN_STYLE}">+2</button>
    </div>
    <div style="${ROW_STYLE}">
      <span>🔌 DOCK ADAPTER <span style="color:rgba(255,179,0,0.5);">× ${partsCount('adapter')}</span></span>
      <button type="button" data-dev-action="add-adapter" style="${BTN_STYLE}">+1</button>
    </div>
    <div style="${ROW_STYLE}">
      <span>⭕ RING LINK <span style="color:rgba(255,179,0,0.4);">· flex+22.5 / ext×4 / flex+22.5</span></span>
      <button type="button" data-dev-action="arm-preset" data-preset="ring" style="${BTN_STYLE}${preset === 'ring' ? 'background:rgba(0,230,118,0.18); color:#00e676; border-color:rgba(0,230,118,0.5);' : ''}">${preset === 'ring' ? 'ARMED' : 'ARM'}</button>
    </div>
    <div style="${ROW_STYLE}">
      <span>➰ HUB SPOKE <span style="color:rgba(255,179,0,0.4);">· flex 0 / ext×11 / flex 0</span></span>
      <button type="button" data-dev-action="arm-preset" data-preset="spoke" style="${BTN_STYLE}${preset === 'spoke' ? 'background:rgba(0,230,118,0.18); color:#00e676; border-color:rgba(0,230,118,0.5);' : ''}">${preset === 'spoke' ? 'ARMED' : 'ARM'}</button>
    </div>
    <div style="${ROW_STYLE}">
      <span>🤝 AUTO-ACCEPT MY MODULES</span>
      <button type="button" data-dev-action="toggle-auto-accept" style="${BTN_STYLE}">${onOff(autoAcceptEnabled())}</button>
    </div>
    <div style="${ROW_STYLE}">
      <span>🚪 NORTH DOOR (FIREPLACE)</span>
      <button type="button" data-dev-action="toggle-north-door" style="${BTN_STYLE}">${onOff(northDoorUnlocked())}</button>
    </div>
    <div style="font-size:9px; font-weight:800; color:rgba(255,179,0,0.55); letter-spacing:1px; margin-top:6px;">MODULE LEDGER</div>
    ${ledgerRows}
  `;
}

/** Rows whose state depends on the live environment (module handle, preview). */
function refreshDynamicRows(): void {
  if (!panel) return;
  refreshInventoryRows();
  refreshPartsRows();
  const moduleBtn = panel.querySelector<HTMLButtonElement>('#dev-module-btn');
  const moduleNote = panel.querySelector<HTMLElement>('#dev-module-note');
  if (moduleBtn && moduleNote) {
    const available = provisionModuleAvailable();
    moduleBtn.disabled = !available;
    moduleBtn.style.opacity = available ? '1' : '0.35';
    moduleBtn.style.cursor = available ? 'pointer' : 'not-allowed';
    moduleNote.innerHTML = available
      ? 'MODULE SEED'
      : 'MODULE SEED <span style="color:rgba(255,179,0,0.4);">· requires transit build</span>';
  }
  const stationBtn = panel.querySelector<HTMLButtonElement>('#dev-station-btn');
  const stationNote = panel.querySelector<HTMLElement>('#dev-station-note');
  if (stationBtn && stationNote) {
    const available = provisionStationAvailable();
    stationBtn.disabled = !available;
    stationBtn.style.opacity = available ? '1' : '0.35';
    stationBtn.style.cursor = available ? 'pointer' : 'not-allowed';
    stationNote.innerHTML = available
      ? '🛰️ NEW STATION'
      : '🛰️ NEW STATION <span style="color:rgba(255,179,0,0.4);">· requires transit build</span>';
  }
  const vestibuleBtn = panel.querySelector<HTMLButtonElement>('#dev-vestibule-btn');
  if (vestibuleBtn) vestibuleBtn.textContent = vestibule ? 'REMOVE' : 'PREVIEW';
}

function isOpen(): boolean {
  return panel !== null && panel.style.display !== 'none';
}

function setOpen(open: boolean): void {
  if (!panel) panel = buildPanel();
  panel.style.display = open ? 'flex' : 'none';
  if (open) refreshDynamicRows();
}

// ── Wiring: DEV button + backquote toggle + Esc close ────────────────────────

/**
 * The single entry point (called once from main.ts init). `getWorldRef`
 * defers World access to click time — the menu outlives any one World.
 */
export function initDevMenu(getWorldRef: GetWorld): void {
  getWorld = getWorldRef;

  // #62 P4: keep the PARTS rows live while the panel is open (the ledger grows
  // when provisioning from the docking pane; counts change as chips consume).
  subscribeStationParts(() => { if (isOpen()) refreshPartsRows(); });

  // North-door unlock survives reloads — re-assert the live flag at init.
  if (northDoorUnlocked()) {
    const north = DOORS.find((d) => d.id === 'north');
    if (north) north.enabled = true;
  }

  const btn = document.getElementById('dev-menu-btn');
  if (btn) {
    btn.style.cssText = `
      position: fixed;
      left: 24px;
      bottom: 24px;
      z-index: ${DEV_Z};
      background: ${DEV_BG};
      color: ${DEV_AMBER};
      border: 2px dashed ${DEV_AMBER};
      border-radius: 8px;
      font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 2px;
      padding: 6px 12px;
      cursor: pointer;
    `;
    btn.addEventListener('click', (e) => {
      // Never let the DEV toggle double as click-to-enter / canvas click.
      e.stopPropagation();
      (btn as HTMLElement).blur();
      setOpen(!isOpen());
    });
  }

  // #53: keep the INVENTORY rows honest while the panel is open — the store
  // mutates from OUTSIDE the panel too (edit mode's ✕ REMOVE / X key).
  window.addEventListener(ROOM_INVENTORY_EVENT, () => {
    if (isOpen()) refreshInventoryRows();
  });

  window.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
      return; // typing ` or Esc in an input never drives the dev menu
    }
    if (e.code === 'Backquote') {
      e.preventDefault();
      setOpen(!isOpen());
      return;
    }
    if (e.key === 'Escape' && isOpen()) {
      // Defer to the established Esc owners (phone > device focus > edit
      // mode all have their own handlers); only a "plain" Esc closes us.
      if (document.getElementById('spacephone-container')?.classList.contains('active')) return;
      if (roomEdit.isEditModeActive()) return;
      if (isDeviceFocusActive()) return;
      setOpen(false);
    }
  });

  console.log('🛠️ DEV menu ready (temporary — DEV1, will be removed)');
}
