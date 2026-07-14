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
 *                like built-in furniture. LOCAL ONLY until E4 sync.
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
import type { FurnitureItem, FurnitureKind } from './furniture';
import { validatePlacement, roomEdit } from './editMode';
import type { PlacementContext } from './editMode';
import { isDeviceFocusActive } from './deviceFocus';
import { OBSTACLES, rebuildObstacles } from './obstacles';
import {
  computeReachable, rebakeWalkableGrid, GRID_SIZE, worldToCol, worldToRow,
} from './pathfinding';
import { SEATS, rebuildSeats } from './seats';
import { DEVICES, rebuildDevices } from './devices';
import type { WallScreenHandle, TrunkLidHandle } from './devices';
import { DOORS } from './doors';
import {
  ITEM_DEFS, getItemDef, loadTrunkState, saveTrunkState,
  TOOL_SLOT_COUNT, TOTAL_SLOT_COUNT,
} from './items';
import { OUTFITS } from './outfits';
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
  return typeof id === 'string' && id.length > 0 ? id : 'furlong-lobby';
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

function uniqueSpawnId(kind: FurnitureKind): string {
  let id: string;
  do {
    spawnCounter += 1;
    id = `dev-${kind}-${spawnCounter}`;
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
  if (box.x0 - margin < -5 || box.x1 + margin > 5 || box.z0 - margin < -5 || box.z1 + margin > 5) {
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
  const seen = new Set<string>();
  const candidates: Array<{ x: number; z: number; d: number }> = [];
  for (let dx = -11; dx <= 11; dx += 0.5) {
    for (let dz = -11; dz <= 11; dz += 0.5) {
      const s = snapItemPos(item.kind, item.rot, p.x + dx, p.z + dz);
      if (s.x < -5.5 || s.x > 5.5 || s.z < -5.5 || s.z > 5.5) continue;
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
      const mat = obj.material as THREE.Material & { opacity: number };
      if ('opacity' in mat) {
        mat.opacity = (mat.userData.baseOpacity as number | undefined) ?? 1;
      }
    } else if (obj instanceof THREE.PointLight) {
      const targetIntensity = (obj.userData.targetIntensity as number) ?? 0;
      w.furnitureLights.push({ light: obj, targetIntensity });
      obj.intensity = targetIntensity;
    }
  });
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
  const spot = findSpawnSpot(world, item);
  if (!spot) {
    showHint(`DEV: CAN'T SPAWN ${kind} — no valid spot (room is full).`);
    return;
  }
  item.pos = spot;
  FURNITURE.push(item);
  registerSpawnedGroup(world, item);
  // The exact E3 commit pipeline (order matters: seats AND devices bake
  // world-space fronts/poses off the fresh walkable grid), then replan.
  rebuildObstacles();
  rebakeWalkableGrid();
  rebuildSeats();
  rebuildDevices();
  world.getPlayer().onObstaclesChanged();
  // A live edit session indexed the raycast targets on enter — refresh it so
  // the new piece is immediately selectable/movable.
  if (roomEdit.isEditModeActive()) {
    roomEdit.forceExit();
    roomEdit.enter(world);
  }
  showHint(`DEV: spawned ${item.id} at (${item.pos.x}, ${item.pos.z}) — local only until E4 sync.`);
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
    const pairingInput = document.getElementById('network-import-link') as HTMLInputElement | null;
    if (pairingInput) pairingInput.value = seed;
    try {
      await navigator.clipboard.writeText(seed);
      showHint('DEV: module seed minted — copied to clipboard + pairing input.');
    } catch {
      showHint(pairingInput
        ? 'DEV: module seed minted — pasted into the pairing input.'
        : 'DEV: module seed minted (clipboard unavailable).');
    }
  } catch (e) {
    console.warn('[devMenu] module provisioning failed:', e);
    showHint('DEV: module provisioning failed — see console.');
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
      <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${kind.toUpperCase()}</span>
      <button type="button" data-dev-action="spawn-furniture" data-kind="${kind}" style="${BTN_STYLE}">+</button>
    </div>
  `);

  const moduleRow = `
    <div style="${ROW_STYLE}">
      <span id="dev-module-note" style="min-width:0;">MODULE SEED</span>
      <button type="button" id="dev-module-btn" data-dev-action="provision-module" style="${BTN_STYLE}">+ PROVISION</button>
    </div>
  `;

  const vestibuleRow = `
    <div style="${ROW_STYLE}">
      <span>EAST-DOOR VESTIBULE (COSMETIC)</span>
      <button type="button" id="dev-vestibule-btn" data-dev-action="toggle-vestibule" style="${BTN_STYLE}">PREVIEW</button>
    </div>
  `;

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
      ${sectionHtml('ITEMS', 'into the room trunk', itemRows)}
      ${sectionHtml('OUTFITS', null, outfitRows)}
      ${sectionHtml('FURNITURE', 'local only until E4 sync', furnitureRows)}
      ${sectionHtml('MODULES', null, [moduleRow])}
      ${sectionHtml('VESTIBULE', null, [vestibuleRow])}
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
      case 'add-item': addItemToTrunk(btn.dataset.id ?? ''); break;
      case 'equip-outfit': equipOutfit(btn.dataset.id ?? ''); break;
      case 'spawn-furniture': spawnFurniture(btn.dataset.kind as FurnitureKind); break;
      case 'provision-module': void provisionModule(); break;
      case 'toggle-vestibule': void toggleVestibule(); break;
    }
  });

  document.body.appendChild(el);
  return el;
}

/** Rows whose state depends on the live environment (module handle, preview). */
function refreshDynamicRows(): void {
  if (!panel) return;
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
