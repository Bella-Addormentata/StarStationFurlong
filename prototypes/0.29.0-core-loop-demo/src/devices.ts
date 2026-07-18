/**
 * Devices — clickable walk-to-and-focus targets DERIVED from the furniture
 * registry (DeviceTemplates on each FurnitureDef; see furniture.ts), plus the
 * focused DOM UI for the M1 room terminal.
 *
 * D0 of issues #33/#35 (brainstorming/device-focus-and-storage-trunk-plan.md):
 * one mechanic for wall computer, desk computer, map table and storage trunk —
 * click device → walk to its front point → face it → the focus camera eases
 * to a first-person framing (deviceFocus.ts) → DeviceUI mounts → exiting
 * returns to the isometric room view.
 *
 * Every device defines:
 *  - front     : walkable stand-point in front of the device (same
 *                computeFront fallback as seats when the preferred point is
 *                blocked by moved furniture)
 *  - faceAngle : 8-way facing TOWARD the device while standing at `front` —
 *                the OPPOSITE of the seats' back-to-the-chair convention
 *                (atan2(nx, nz): +z=0, +x=π/2, -z=π, -x=-π/2)
 *  - eye/anchor: focus-camera pose — eye position and look target framing
 *                the device's screen / work surface
 *
 * DEVICES keeps its array identity: rebuildDevices() refills it in place so
 * it stays in sync after obstacle/grid rebuilds (same pattern as seats.ts).
 */

import * as THREE from 'three';
import { FURNITURE, buildDeviceList, itemAabb } from './furniture';
import { GRID_SIZE, walkable, worldToCol, worldToRow } from './pathfinding';
import { SolarSystemMap } from './map';
import type { DoorDockingPortSystem, DockingState } from './docking';
import type { DoorId } from './doors';
import {
  getItemDef, loadTrunkState,
  TOOL_SLOT_COUNT, TOTAL_SLOT_COUNT,
} from './items';
import type { ItemDef } from './items';
import { loadSavedOutfitId } from './outfits';
import type { RoomEditPermission } from './editMode';
import {
  initialState, legalMoves, applyMove, chooseBotMove, pieceColor, otherColor,
  RED_KING, BLACK_KING,
} from './games/checkers';
import type { CheckersState, CheckersColor } from './games/checkers';
import {
  initialChessState, legalChessMoves, applyChessMove, chooseChessBotMove,
  chessPieceColor, otherChessColor, inCheck,
  W_PAWN, W_KNIGHT, W_BISHOP, W_ROOK, W_QUEEN, W_KING,
  B_PAWN, B_KNIGHT, B_BISHOP, B_ROOK, B_QUEEN, B_KING,
} from './games/chess';
import type { ChessState, ChessColor } from './games/chess';
import { readGame, writeGame, readTable, clearTable, subscribeGames, readRoomOwner, readPlayerDisplayName } from './games/gamesDoc';
import { getPlayerId } from './identity';

// ── Core interfaces (plan §D0.2) ──────────────────────────────────────────────

export type DeviceKind = 'roomTerminal' | 'deskComputer' | 'mapTable' | 'storageTrunk' | 'gameTable';

/**
 * Hooks the player's device-focus sequence uses to talk to the focus
 * controller. Keeps the Player decoupled from the camera/UI machinery —
 * DeviceFocusController wires the two together via navigateToDevice().
 */
export interface DeviceFocusHooks {
  /** Fired exactly once when the avatar stands at `front` facing the device. */
  onArrived(): void;
  /**
   * Ask the focus controller to let go (WASD / click / re-route while
   * ENGAGED). The controller eases the camera back and then calls
   * player.releaseDevice(), which resumes any pending action.
   */
  requestRelease(): void;
}

export interface DeviceTarget {
  id: string;
  kind: DeviceKind;
  front: { x: number; z: number };
  /** Facing toward the device while standing at `front`. */
  faceAngle: number;
  /** Focus-camera eye position (world space). */
  eye: THREE.Vector3;
  /** Focus-camera look target (world space). */
  anchor: THREE.Vector3;
  /**
   * Optional pre-focus choreography (TR2 of #35 — e.g. the trunk lid swing).
   * Called exactly once when the avatar arrives at `front`; the controller
   * holds in PREPARING (ortho camera still live, room fully visible) and only
   * starts the camera ease + UI mount after `onReady` fires. Derived
   * DeviceTargets are plain data — World augments the trunk's target with
   * this hook at requestDeviceFocus time (the lid handle lives on the built
   * group, not in the registry).
   */
  prepare?(onReady: () => void): void;
  /**
   * Optional release-side choreography — fired once on every release path
   * (ease-back start, PREPARING abort, force-release). Fire-and-forget: the
   * trunk lid closes in parallel with the camera ease (plan §TR2).
   */
  onRelease?(): void;
}

/**
 * Device definition local to the item origin (rot 0) — lives on a
 * FurnitureDef; world-space DeviceTargets are derived by buildDeviceList().
 */
export interface DeviceTemplate {
  kind: DeviceKind;
  /** PREFERRED front (stand-point) offset — same semantics as SeatTemplate. */
  front: { x: number; z: number };
  /** Facing while at front, TOWARD the device, when rot = 0. */
  faceAngle: number;
  /** Local focus-camera eye pose (y is absolute height, x/z rotate with rot). */
  eye: { x: number; y: number; z: number };
  /** Local focus-camera look target. */
  anchor: { x: number; y: number; z: number };
}

/** The DOM UI mounted while a device is FOCUSED (plan §D0.2 controller). */
export interface DeviceUI {
  mount(host: HTMLElement): void;
  unmount(): void;
  /** Driven every frame from the focus controller while FOCUSED. */
  update(dt: number): void;
}

// ── Wall-computer screen types (M1 — shared with the furniture builder) ──────

export interface WallComputerStatus {
  roomName: string;
  peers: number;
  nodeOnline: boolean;
}

/**
 * Handle onto a wall-computer's in-world CanvasTexture screen. The builder
 * (furniture.ts) stows it in the screen mesh's userData.wallScreen; World
 * collects it and drives updateStatus at ~1 Hz + setEngaged around focus.
 */
export interface WallScreenHandle {
  /** Redraw the idle status frame. Called ~1 Hz by World — no internal timer. */
  updateStatus(status: WallComputerStatus): void;
  /** Dim the in-world screen to "TERMINAL IN USE" while a player is focused. */
  setEngaged(engaged: boolean): void;
}

// ── Storage-trunk lid handle (TR2 — shared with the furniture builder) ───────

/**
 * Handle onto a storage trunk's animated lid. The builder (furniture.ts)
 * stows it in the lid slab's userData.trunkLid; World collects it, drives
 * update(dt) every frame (door-slide idiom), and wires openLid/closeLid into
 * the focus choreography via DeviceTarget.prepare/onRelease.
 */
export interface TrunkLidHandle {
  /** Swing the lid open (~100° back). onComplete fires exactly once on arrival. */
  openLid(onComplete?: () => void): void;
  /** Swing the lid closed. onComplete fires exactly once on arrival. */
  closeLid(onComplete?: () => void): void;
  /** Drive from World.update — NOT a detached rAF loop (PR #29's doors). */
  update(deltaTime: number): void;
}

// ── Game-table top handle (#45 v1 — shared with the furniture builder) ───────

/**
 * Handle onto a game table's flippable two-face top (checkerboard / card
 * felt). The builder (furniture.ts) stows it in the top slab's
 * userData.gameTableTop; World collects it, drives update(dt) every frame
 * (the trunk-lid idiom — update-loop tween, completion-signalled, never a
 * detached rAF), and the focused UI's FLIP affordance calls flip().
 */
export interface GameTableTopHandle {
  /**
   * Start a 180° flip (lift, rotate about the long axis, settle). onComplete
   * fires exactly once on arrival. Returns false (no-op) mid-flip.
   */
  flip(onComplete?: () => void): boolean;
  /** True while the flip tween runs. */
  isFlipping(): boolean;
  /** True when the card-felt face is up (checkerboard face down). */
  isCardsUp(): boolean;
  /**
   * Repaint the in-world checkerboard texture from a 64-cell board array
   * (games/checkers.ts codes), or null for the bare board. Lets spectators
   * see the live game without focusing (wall-screen hybrid idiom, §D0.4).
   */
  setBoard(board: number[] | null): void;
  /** Drive from World.update — NOT a detached rAF loop (PR #29's doors). */
  update(deltaTime: number): void;
}

// ── Registry derivation (mirrors seats.ts) ────────────────────────────────────

export const DEVICES: DeviceTarget[] = [];

/** Re-derive DEVICES from the furniture registry + current walkable grid. */
export function rebuildDevices(): void {
  DEVICES.length = 0;
  DEVICES.push(...buildDeviceList(FURNITURE, (x, z) => {
    const row = worldToRow(z);
    const col = worldToCol(x);
    return row >= 0 && row < GRID_SIZE && col >= 0 && col < GRID_SIZE && walkable[row][col];
  }));
}

rebuildDevices();

/** Find a device by its furniture-item id, or null when unknown. */
export function findDevice(id: string): DeviceTarget | null {
  for (const device of DEVICES) {
    if (device.id === id) return device;
  }
  return null;
}

// ── Live status source (permanent home of PR #36's dev-hook wiring) ──────────

/**
 * Read the live room status off the already-rendered HUD/network panel — the
 * same values the ?deviceprops=1 preview hook sampled (room name, peers seen,
 * node status). Honest data only: these rows are driven by the real network
 * loop in main.ts.
 */
export function readLiveRoomStatus(): WallComputerStatus {
  const roomName = (document.getElementById('room-name')
    ?? document.getElementById('room-name-display'))?.textContent?.trim() || 'FURLONG LOBBY';
  const peers = parseInt(document.getElementById('net-peers-seen')?.textContent ?? '', 10) || 0;
  const nodeOnline = (document.getElementById('node-status')?.textContent ?? '').includes('ONLINE');
  return { roomName, peers, nodeOnline };
}

/** Live P2P link status text ('CONNECTED' / 'OFFLINE') from the HUD row. */
function readP2PStatus(): string {
  return document.getElementById('p2p-status')?.textContent?.trim() || 'OFFLINE';
}

// ── M1 room-terminal focused UI ───────────────────────────────────────────────

/** Docking-pane door-state palette (mirrors docking.ts syncLEDStatus). */
function doorStateColor(state: DockingState | null): string {
  if (!state) return '#3E92B8';
  if (state.pairingPending && !state.pairedSuccessfully) return '#FFB300'; // pending amber
  if (state.pairedSuccessfully) return '#00E676';                          // paired green
  if (state.locked) return '#FF1744';                                      // locked red
  return '#00E5FF';                                                        // idle cyan
}

export interface RoomTerminalDeps {
  dockingSystem: DoorDockingPortSystem | null;
  getPlayerPos: () => THREE.Vector3;
  /** Lets World dim the in-world screen to "TERMINAL IN USE" while focused. */
  onEngagedChange?: (engaged: boolean) => void;
  /**
   * EDIT ROOM entry point (#33 M2 amendment of #25 E2 — the HUD pencil never
   * ships; THIS button is the only way into edit mode). `permission` gates
   * the button (disabled + reason when not the owner); `request` must release
   * the device focus first and enter edit mode once the release completes
   * (World wires it to deviceFocus.releaseThen → roomEdit.enter).
   */
  editRoom?: {
    permission: () => RoomEditPermission;
    request: () => void;
  };
}

/** Door port geometry for the wireframe view (docking.ts buildPorts widths). */
const PORT_VIEW: Array<{ id: DoorId; x: number; z: number; w: number; horizontal: boolean; label: string }> = [
  { id: 'north', x: 0, z: -6, w: 1.4, horizontal: true, label: 'N' },
  { id: 'south', x: 0, z: 6, w: 1.4, horizontal: true, label: 'S' },
  { id: 'west', x: -6, z: 0, w: 2.4, horizontal: false, label: 'W' },
  { id: 'east', x: 6, z: 0, w: 2.4, horizontal: false, label: 'E' },
];

/**
 * The wall computer's focused DOM UI (plan §2 M1). Honest data only: room
 * name / peers / node & P2P status are read from the live HUD rows, the
 * top-down wireframe is re-derived from FURNITURE itemAabbs + dockingSystem
 * doorState every refresh (moved furniture and door pairings show up live),
 * the fuel gauge says plainly that no fuel system exists, and the adjacent-
 * module line admits there is no multi-module telemetry yet.
 */
export function createRoomTerminalUI(deps: RoomTerminalDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let refreshTimer = 0;

  const CANVAS_CSS = 290;   // CSS px (square)
  const CANVAS_RES = 580;   // backing-store px (2x for crisp lines)

  const refresh = () => {
    if (!panel) return;
    const status = readLiveRoomStatus();

    const nameEl = panel.querySelector<HTMLElement>('#device-terminal-room-name');
    if (nameEl) nameEl.textContent = status.roomName.toUpperCase();
    const peersEl = panel.querySelector<HTMLElement>('#device-terminal-peers');
    if (peersEl) peersEl.textContent = String(status.peers);
    const nodeEl = panel.querySelector<HTMLElement>('#device-terminal-node');
    if (nodeEl) {
      nodeEl.textContent = status.nodeOnline ? '● ONLINE' : '● OFFLINE';
      nodeEl.style.color = status.nodeOnline ? '#00E676' : '#FF1744';
    }
    const p2p = readP2PStatus();
    const p2pEl = panel.querySelector<HTMLElement>('#device-terminal-p2p');
    if (p2pEl) {
      p2pEl.textContent = p2p;
      p2pEl.style.color = p2p.includes('CONNECTED') ? '#00E676' : '#FF1744';
    }

    // Adjacent-module line: v1 has no doorPairings/multi-module telemetry —
    // report pairing status honestly (plan M1: 'NO ADJACENT MODULE DATA').
    const adjEl = panel.querySelector<HTMLElement>('#device-terminal-adjacent');
    if (adjEl) {
      const paired = PORT_VIEW
        .filter((p) => deps.dockingSystem?.getDockingState(p.id)?.pairedSuccessfully)
        .map((p) => p.id.toUpperCase());
      adjEl.textContent = paired.length
        ? `PORT ${paired.join(', ')} PAIRED — NO ADJACENT MODULE DATA`
        : 'NO ADJACENT MODULE DATA';
    }

    // EDIT ROOM gate (#33 M2): re-evaluated with every refresh so an owner
    // change (e.g. set via console for the non-owner test path) shows up live.
    const editBtn = panel.querySelector<HTMLButtonElement>('#device-terminal-edit-room');
    const editNote = panel.querySelector<HTMLElement>('#device-terminal-edit-room-note');
    if (editBtn && deps.editRoom) {
      const perm = deps.editRoom.permission();
      editBtn.disabled = !perm.ok;
      editBtn.style.opacity = perm.ok ? '1' : '0.35';
      editBtn.style.cursor = perm.ok ? 'pointer' : 'not-allowed';
      editBtn.title = perm.ok
        ? 'Rearrange this room’s furniture'
        : perm.reason;
      if (editNote) editNote.textContent = perm.ok ? '' : perm.reason;
    }

    drawWireframe();
  };

  const drawWireframe = () => {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const S = CANVAS_RES;
    const PAD = 46;
    const scale = (S - PAD * 2) / 12; // world [-6, 6] → canvas
    const px = (wx: number) => PAD + (wx + 6) * scale;
    const pz = (wz: number) => PAD + (wz + 6) * scale; // north (-z) at top

    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#0A1018';
    ctx.fillRect(0, 0, S, S);

    // Faint 1m grid
    ctx.strokeStyle = 'rgba(62, 146, 184, 0.12)';
    ctx.lineWidth = 1;
    for (let g = -6; g <= 6; g++) {
      ctx.beginPath(); ctx.moveTo(px(g), pz(-6)); ctx.lineTo(px(g), pz(6)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px(-6), pz(g)); ctx.lineTo(px(6), pz(g)); ctx.stroke();
    }

    // Room bounds
    ctx.strokeStyle = '#3E92B8';
    ctx.lineWidth = 3;
    ctx.strokeRect(px(-6), pz(-6), 12 * scale, 12 * scale);

    // Furniture footprints — derived LIVE from the registry so E3/E4 moves
    // show up for free (every non-null itemAabb).
    ctx.lineWidth = 2;
    for (const item of FURNITURE) {
      const box = itemAabb(item);
      if (!box) continue;
      ctx.strokeStyle = 'rgba(212, 168, 75, 0.55)';
      ctx.strokeRect(px(box.x0), pz(box.z0), (box.x1 - box.x0) * scale, (box.z1 - box.z0) * scale);
    }

    // Door ports colored by live docking state
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const port of PORT_VIEW) {
      const state = deps.dockingSystem?.getDockingState(port.id) ?? null;
      ctx.fillStyle = doorStateColor(state);
      const wpx = port.w * scale;
      const thick = 10;
      if (port.horizontal) {
        ctx.fillRect(px(port.x) - wpx / 2, pz(port.z) - thick / 2, wpx, thick);
        ctx.fillText(port.label, px(port.x), pz(port.z) + (port.z < 0 ? 24 : -24));
      } else {
        ctx.fillRect(px(port.x) - thick / 2, pz(port.z) - wpx / 2, thick, wpx);
        ctx.fillText(port.label, px(port.x) + (port.x < 0 ? 24 : -24), pz(port.z));
      }
    }

    // Player position (live)
    const p = deps.getPlayerPos();
    ctx.fillStyle = '#F0C060';
    ctx.beginPath();
    ctx.arc(px(p.x), pz(p.z), 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(62, 146, 184, 0.6)';
    ctx.font = '18px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('MODULE — TOP-DOWN', PAD, S - 16);
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-terminal-pane';
      // Docking-pane palette (docking.ts mountInterfaceControlPanel): gold on
      // dark, monospace. pointer-events re-enabled inside the inert host.
      panel.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 420px;
        max-height: 92vh;
        overflow-y: auto;
        background: rgba(4, 8, 22, 0.95);
        border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px;
        box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        color: #d4a84b;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box;
        pointer-events: auto;
      `;
      panel.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
          <span style="font-size:12px; font-weight:800; color:#F0C060; letter-spacing:1px;">▣ ROOM TERMINAL</span>
          <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
        </div>
        <div id="device-terminal-room-name" style="font-size:16px; font-weight:800; color:#D4A84B; letter-spacing:1.5px;">--</div>
        <div style="display:flex; gap:18px; font-size:11px;">
          <span>PEERS: <span id="device-terminal-peers" style="color:#00E5FF; font-weight:bold;">--</span></span>
          <span>NODE: <span id="device-terminal-node" style="font-weight:bold;">--</span></span>
          <span>P2P: <span id="device-terminal-p2p" style="font-weight:bold;">--</span></span>
        </div>
        <canvas id="device-terminal-map" width="${CANVAS_RES}" height="${CANVAS_RES}"
          style="width:${CANVAS_CSS}px; height:${CANVAS_CSS}px; align-self:center; border:1px solid rgba(62,146,184,0.35); border-radius:6px;"></canvas>
        ${deps.editRoom ? `
        <div style="display:flex; flex-direction:column; gap:3px;">
          <button id="device-terminal-edit-room" style="
            padding: 8px 12px;
            background: rgba(212, 168, 75, 0.10);
            border: 1px solid rgba(212, 168, 75, 0.45);
            border-radius: 6px;
            color: #F0C060;
            font-family: inherit;
            font-size: 12px;
            font-weight: 800;
            letter-spacing: 1.5px;
            cursor: pointer;
          ">EDIT ROOM ✎</button>
          <div id="device-terminal-edit-room-note" style="font-size:9px; color:#4A5560; letter-spacing:0.5px;"></div>
        </div>` : ''}
        <div>
          <div style="font-size:10px; color:#4A5560; letter-spacing:1px; margin-bottom:4px;">FUEL — NO SENSOR FITTED</div>
          <div style="height:12px; border:1px solid rgba(212,168,75,0.22); border-radius:3px; background:repeating-linear-gradient(45deg, rgba(74,85,96,0.25) 0 6px, transparent 6px 12px);"></div>
        </div>
        <div id="device-terminal-adjacent" style="font-size:10px; color:#4A5560; letter-spacing:0.5px;">NO ADJACENT MODULE DATA</div>
        <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">SSF ROOM TERMINAL v1 · honest data only</div>
      `;
      // Input capture (plan §D0.3): clicks inside the device UI never reach
      // the canvas handler — clicks that DO reach it release the focus.
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      canvas = panel.querySelector<HTMLCanvasElement>('#device-terminal-map');
      // EDIT ROOM (#33 M2): release the focus first, THEN enter edit mode —
      // the wired request() is deviceFocus.releaseThen(→ roomEdit.enter).
      const editBtn = panel.querySelector<HTMLButtonElement>('#device-terminal-edit-room');
      if (editBtn && deps.editRoom) {
        const editRoom = deps.editRoom;
        editBtn.addEventListener('click', () => {
          if (!editRoom.permission().ok) return; // gate re-checked at press time
          editRoom.request();
        });
      }
      deps.onEngagedChange?.(true);
      refresh();
    },

    unmount(): void {
      deps.onEngagedChange?.(false);
      panel?.remove();
      panel = null;
      canvas = null;
    },

    update(dt: number): void {
      refreshTimer += dt;
      if (refreshTimer >= 0.25) { // 4 Hz is plenty for status + wireframe
        refreshTimer = 0;
        refresh();
      }
    },
  };
}

// ── M4 map-table focused UI — the solar map, diegetic ────────────────────────

export interface MapTableDeps {
  /** Ask the focus controller to step back (wired to the map's CLOSE button). */
  requestRelease?: () => void;
}

/**
 * ONE SolarSystemMap serves every focus session: its mount() re-parents the
 * existing container on later calls, so canvas, pan/zoom offsets, selection
 * and in-transit travel state survive stepping away from the table. It also
 * keeps the window-level listeners (mousemove/mouseup/resize) single-instance
 * — pre-M4 the standalone overlay held the exact same set for the app's
 * whole lifetime.
 */
let mapTableMap: SolarSystemMap | null = null;

/**
 * The map table's focused DOM UI (plan §2 M4): a gold-framed panel hosting
 * the migrated SolarSystemMap. Pan/zoom/select/travel are container-local in
 * map.ts already; the map's sim tick is driven from update() so it only
 * advances while the table is actually open (pre-M4 it ticked unconditionally
 * from main.ts's animate loop).
 */
export function createMapTableUI(deps: MapTableDeps = {}): DeviceUI {
  let panel: HTMLDivElement | null = null;

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-maptable-pane';
      // Gold-frame device-pane idiom (device-terminal-pane / docking pane),
      // sized for a map: ~80vw × 78vh. pointer-events re-enabled inside the
      // inert #device-ui-host.
      panel.style.cssText = `
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 80vw;
        height: 78vh;
        background: rgba(4, 8, 22, 0.95);
        border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px;
        box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 14px;
        display: flex;
        flex-direction: column;
        gap: 10px;
        color: #d4a84b;
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box;
        pointer-events: auto;
      `;
      panel.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
          <span style="font-size:12px; font-weight:800; color:#F0C060; letter-spacing:1px;">◉ HOLOTABLE — SOL SYSTEM PLOT</span>
          <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
        </div>
        <div id="device-maptable-body" style="flex:1; position:relative; overflow:hidden; border-radius:8px;"></div>
      `;
      // Input capture (plan §D0.3): clicks inside the device UI never reach
      // the canvas handler — clicks that DO reach it release the focus.
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);

      const body = panel.querySelector<HTMLDivElement>('#device-maptable-body')!;
      if (!mapTableMap) {
        mapTableMap = new SolarSystemMap();
        mapTableMap.mount(body); // panel is in the document — listeners bind live
        mapTableMap.onTravelComplete((destinationId) => {
          // Zone-shard swap stays a console note (the overlay-era phone-chat
          // log lived in main.ts and is retired with the overlay wiring).
          console.log(`[Sharding Node] Swapping direct channel to room zone: ${destinationId}`);
        });
        // The map's own CLOSE button now means "step back from the table".
        document.getElementById('solarmap-close-btn')
          ?.addEventListener('click', () => deps.requestRelease?.());
        // Debug handle (kept from the standalone-overlay era — verification
        // scripts and console poking reach the live instance here).
        (window as unknown as { solarSystemMap: SolarSystemMap }).solarSystemMap = mapTableMap;
      } else {
        mapTableMap.mount(body); // re-parents the existing container
      }
      mapTableMap.show();
    },

    unmount(): void {
      mapTableMap?.hide();
      panel?.remove();
      panel = null;
    },

    update(_dt: number): void {
      // Gate the sim tick to the open table (#33 M4) — orbits, transit
      // progress and the selection pulse only advance while someone watches.
      if (mapTableMap?.isOpen()) mapTableMap.tick();
    },
  };
}

// ── TR2 storage-trunk focused UI ──────────────────────────────────────────────

export interface StorageTrunkUIDeps {
  /** Furniture item id — one localStorage key per (room, trunk). */
  itemId: string;
  /** Stable room id (bootstrap roomId, NOT the editable display name). */
  roomId: string;
  /**
   * TR3 equip path: rig setOutfit + 'ssf-outfit' persistence (+ the S2
   * players-map outfit id once that lane exists). Returns false for unknown
   * outfit ids.
   */
  applyOutfit(outfitId: string): boolean;
}

const TRUNK_GOLD = '#d4a84b';
const TRUNK_GOLD_BRIGHT = '#F0C060';
const TRUNK_DIM = '#4A5560';

/**
 * The storage trunk's focused DOM UI (plan §3 TR2): two stacked trays over
 * the opened 3D trunk — TOOLS grid (8 slots) on top, WARDROBE (4 slots)
 * beneath — rendered from the trunk's local slot state. Clicking a tile opens
 * an inspect card (name + kind + flavor); outfit items add an EQUIP button
 * that routes into the TR3 rig path. LOCAL ONLY, and says so on the panel
 * (`LOCAL STOWAGE — not yet synced`); no cross-trunk transfer, no world drops
 * (deferred by the plan). Styling matches the wall computer's focused UI
 * (gold-on-dark monospace, docking-pane palette).
 */
export function createStorageTrunkUI(deps: StorageTrunkUIDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let selectedSlot = -1;

  const state = () => loadTrunkState(deps.roomId, deps.itemId);

  const tileHtml = (def: ItemDef | null, slot: number): string => {
    const selected = slot === selectedSlot && def;
    const base = `
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      gap:3px; height:64px; border-radius:6px; box-sizing:border-box; padding:4px;
      font-size:8px; letter-spacing:0.4px; text-align:center; user-select:none;
    `;
    if (!def) {
      return `<div data-slot="${slot}" style="${base}
        border:1px dashed rgba(212,168,75,0.16); color:#33404E;">EMPTY</div>`;
    }
    return `<div data-slot="${slot}" class="trunk-tile" style="${base}
      border:1px solid ${selected ? TRUNK_GOLD_BRIGHT : 'rgba(212,168,75,0.35)'};
      background:${selected ? 'rgba(212,168,75,0.16)' : 'rgba(212,168,75,0.05)'};
      color:${TRUNK_GOLD}; cursor:pointer;">
      <span style="font-size:22px; line-height:1;">${def.icon}</span>
      <span>${def.name.toUpperCase()}</span>
    </div>`;
  };

  const inspectHtml = (): string => {
    const slots = state().slots;
    const id = selectedSlot >= 0 ? slots[selectedSlot] : null;
    const def = id ? getItemDef(id) : null;
    if (!def) {
      return `<div style="font-size:10px; color:${TRUNK_DIM}; letter-spacing:0.5px;">
        SELECT AN ITEM TO INSPECT</div>`;
    }
    const equippedId = loadSavedOutfitId() ?? 'default';
    const isEquipped = def.kind === 'outfit' && def.outfit === equippedId;
    const equipRow = def.kind === 'outfit'
      ? (isEquipped
        ? `<span style="font-size:10px; font-weight:800; color:#00E676; letter-spacing:1px;">✓ EQUIPPED</span>`
        : `<button id="trunk-equip-btn" style="
            background:rgba(212,168,75,0.12); color:${TRUNK_GOLD_BRIGHT};
            border:1px solid rgba(212,168,75,0.5); border-radius:4px;
            font-family:inherit; font-size:10px; font-weight:800; letter-spacing:1.5px;
            padding:5px 14px; cursor:pointer;">EQUIP</button>`)
      : '';
    return `
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:26px;">${def.icon}</span>
        <div style="flex:1; min-width:0;">
          <div style="font-size:12px; font-weight:800; color:${TRUNK_GOLD_BRIGHT}; letter-spacing:1px;">${def.name.toUpperCase()}</div>
          <div style="font-size:9px; color:#8FA3B8; letter-spacing:1px;">${def.kind.toUpperCase()}</div>
        </div>
        ${equipRow}
      </div>
      <div style="font-size:10px; color:rgba(212,168,75,0.75); line-height:1.5;">${def.flavor}</div>
    `;
  };

  const render = () => {
    if (!panel) return;
    const slots = state().slots;
    const toolTiles: string[] = [];
    for (let i = 0; i < TOOL_SLOT_COUNT; i++) {
      const id = slots[i];
      toolTiles.push(tileHtml(id ? getItemDef(id) ?? null : null, i));
    }
    const outfitTiles: string[] = [];
    for (let i = TOOL_SLOT_COUNT; i < TOTAL_SLOT_COUNT; i++) {
      const id = slots[i];
      outfitTiles.push(tileHtml(id ? getItemDef(id) ?? null : null, i));
    }
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:${TRUNK_GOLD_BRIGHT}; letter-spacing:1px;">▣ STORAGE TRUNK · ISS-ST04</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      <div style="font-size:9px; color:${TRUNK_DIM}; letter-spacing:1.5px;">LOCAL STOWAGE — not yet synced</div>
      <div>
        <div style="font-size:10px; color:${TRUNK_GOLD}; letter-spacing:2px; margin-bottom:6px;">TOOLS</div>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:6px;">${toolTiles.join('')}</div>
      </div>
      <div>
        <div style="font-size:10px; color:${TRUNK_GOLD}; letter-spacing:2px; margin-bottom:6px;">WARDROBE</div>
        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:6px;">${outfitTiles.join('')}</div>
      </div>
      <div id="trunk-inspect" style="min-height:64px; display:flex; flex-direction:column; gap:8px; justify-content:center;
        border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:10px 12px; background:rgba(10,16,24,0.6);">
        ${inspectHtml()}
      </div>
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">SSF STOWAGE v1 · 8 tool + 4 wardrobe slots</div>
    `;

    // Tile selection → inspect card
    panel.querySelectorAll<HTMLElement>('.trunk-tile').forEach((tile) => {
      tile.addEventListener('click', () => {
        selectedSlot = parseInt(tile.dataset.slot ?? '-1', 10);
        render();
      });
    });
    // EQUIP → TR3 path (rig recolor + accessory + 'ssf-outfit' persistence)
    panel.querySelector<HTMLButtonElement>('#trunk-equip-btn')?.addEventListener('click', () => {
      const id = state().slots[selectedSlot];
      const def = id ? getItemDef(id) : null;
      if (def?.kind === 'outfit' && def.outfit && deps.applyOutfit(def.outfit)) {
        render(); // re-render: EQUIP → ✓ EQUIPPED
      }
    });
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-trunk-pane';
      // Same gold-on-dark monospace shell as the room terminal; nudged above
      // center so the opened 3D trunk stays visible under the downward gaze.
      panel.style.cssText = `
        position: absolute;
        top: 44%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 400px;
        max-height: 86vh;
        overflow-y: auto;
        background: rgba(4, 8, 22, 0.93);
        border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px;
        box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        color: ${TRUNK_GOLD};
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box;
        pointer-events: auto;
      `;
      // Input capture (plan §D0.3): clicks inside the trunk UI never reach
      // the canvas handler — clicks that DO reach it release the focus.
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      selectedSlot = -1;
      render();
    },

    unmount(): void {
      panel?.remove();
      panel = null;
    },

    update(_dt: number): void {
      // Slot state only changes through this UI in v1 (no sync, no drops) —
      // nothing to poll. TR-sync will hang its observer re-render here.
    },
  };
}

// ── #45 v1 game-table focused UI — flippable surface + doc-synced checkers ───

export interface GameTableUIDeps {
  /** Furniture item id — the key into the room doc's `games` map. */
  itemId: string;
  /**
   * Flip/board handle of THIS table's built top (null for tables whose
   * handle was never collected — the FLIP affordance disables itself).
   */
  top: GameTableTopHandle | null;
}

const GT_GOLD = '#d4a84b';
const GT_GOLD_BRIGHT = '#F0C060';
const GT_DIM = '#4A5560';

/** DOM-board palette (mirrors the in-world texture painter in furniture.ts). */
const DOM_SQ_LIGHT = '#EAD9B0';
const DOM_SQ_DARK = '#7A4A28';
const DOM_RED = '#C43C3C';
const DOM_BLACK = '#23252E';

/**
 * The game table's focused DOM UI (#45 v1): FLIP affordance for the two-face
 * top, and the checkers game on face A — seat claiming (first two claimants,
 * keyed by S2 player id), click-to-move with mandatory-capture highlighting,
 * VS BOT single-player, forfeit/reset, live spectator view. ALL game state
 * lives in the room doc's `games` map (games/gamesDoc.ts): every transition
 * is read → pure-engine compute → transacted write, and every repaint is
 * observer-driven — a second tab (or a rejoin) converges from the doc alone.
 *
 * Honest-scope notes baked into the panel: the card face has no games yet
 * (war/poker/solitaire arrive per brainstorming/games-plan.md), and the
 * trivial bot only "thinks" while the RED claimant has the table focused.
 */
export function createGameTableUI(deps: GameTableUIDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let boardCanvas: HTMLCanvasElement | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Selected own-piece cell, or null. Local-only — never written to the doc. */
  let selected: number | null = null;
  let botTimer = 0;
  const myId = getPlayerId();

  const BOARD_CSS = 320;  // CSS px (square)
  const BOARD_RES = 640;  // backing-store px (2x for crisp squares)

  const mySeat = (s: CheckersState): CheckersColor | null =>
    s.players.red === myId ? 'red' : s.players.black === myId ? 'black' : null;

  /** May I interact with the board right now (seat + turn + not the bot's)? */
  const myTurn = (s: CheckersState): boolean => {
    const seat = mySeat(s);
    return s.status === 'playing' && seat !== null && s.turn === seat
      && !(s.bot && s.turn === 'black');
  };

  const seatLabel = (s: CheckersState, color: CheckersColor): string => {
    if (color === 'black' && s.bot) return 'BOT';
    const id = s.players[color];
    if (!id) return 'OPEN';
    const name = readPlayerDisplayName(id).toUpperCase();
    return id === myId ? `${name} (YOU)` : name;
  };

  const statusText = (s: CheckersState): string => {
    if (s.status === 'waiting') return 'WAITING FOR PLAYERS — SIT DOWN TO CLAIM A COLOR';
    if (s.status === 'red-won') return '● RED WINS';
    if (s.status === 'black-won') return '● BLACK WINS';
    const who = s.turn.toUpperCase();
    const yours = myTurn(s) ? ' — YOUR MOVE' : '';
    const chain = s.chain !== null ? ' · MULTI-JUMP: SAME PIECE CONTINUES' : '';
    return `${who} TO MOVE${yours}${chain}`;
  };

  // ── Doc transitions (read → pure engine → transacted write) ────────────────

  const claimSeat = (color: CheckersColor): void => {
    const s = readGame(deps.itemId) ?? initialState();
    if (s.status !== 'waiting') return;            // claims only pre-game (v1)
    if (s.players[color] !== null) return;         // taken (doc LWW settles races)
    if (s.players[otherColor(color)] === myId) return; // one seat per player (v1)
    if (s.bot && color === 'black') return;        // bot holds black
    const players = { ...s.players, [color]: myId };
    const status = players.red && players.black ? 'playing' as const : s.status;
    writeGame(deps.itemId, { ...s, players, status });
  };

  const startBotGame = (): void => {
    const s = readGame(deps.itemId) ?? initialState();
    if (s.status !== 'waiting' || s.players.black !== null) return;
    if (s.players.red !== null && s.players.red !== myId) return; // not alone
    writeGame(deps.itemId, {
      ...s,
      players: { ...s.players, red: myId },
      bot: true,
      status: 'playing',
    });
  };

  const forfeit = (): void => {
    const s = readGame(deps.itemId);
    if (!s || s.status !== 'playing') return;
    const seat = mySeat(s);
    if (!seat) return;
    writeGame(deps.itemId, {
      ...s,
      status: seat === 'red' ? 'black-won' : 'red-won',
      chain: null,
    });
  };

  /** RESET gate: participants or the room owner mid-game; ANYONE once the
   *  game is finished (otherwise departed winners would pin the seats).
   *  Bot games are always resettable (review F5): the bot holds no real seat,
   *  so if the red claimant leaves mid-game no seat-holder remains — without
   *  this an owner-absent room's table is pinned at BLACK (BOT) forever. */
  const canReset = (s: CheckersState | null): boolean => {
    if (!s) return false;
    if (s.status === 'red-won' || s.status === 'black-won') return true;
    if (s.bot) return true;
    return mySeat(s) !== null || readRoomOwner() === myId;
  };

  // (The old per-game reset became clearToPicker — RESET now clears the whole
  // table back to the game menu for BOTH kinds. The LWW caveat still applies:
  // an in-flight opponent move-write may win over the clear; RESET again
  // recovers. canReset above remains the checkers half of canClearTable.)

  // ── Board rendering + click-to-move ────────────────────────────────────────

  const drawBoard = (s: CheckersState | null): void => {
    if (!boardCanvas) return;
    const ctx = boardCanvas.getContext('2d');
    if (!ctx) return;
    const state = s ?? initialState();
    const SQ = BOARD_RES / 8;
    ctx.imageSmoothingEnabled = false;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        ctx.fillStyle = (r + c) % 2 === 1 ? DOM_SQ_DARK : DOM_SQ_LIGHT;
        ctx.fillRect(c * SQ, r * SQ, SQ, SQ);
      }
    }
    const moves = s && myTurn(s) ? legalMoves(s) : [];
    // Selected piece: gold frame; its legal destinations: gold dots.
    if (selected !== null) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = GT_GOLD_BRIGHT;
      ctx.strokeRect((selected % 8) * SQ + 3, Math.floor(selected / 8) * SQ + 3, SQ - 6, SQ - 6);
      for (const m of moves) {
        if (m.from !== selected) continue;
        ctx.beginPath();
        ctx.arc((m.to % 8) * SQ + SQ / 2, Math.floor(m.to / 8) * SQ + SQ / 2, SQ * 0.14, 0, Math.PI * 2);
        ctx.fillStyle = GT_GOLD_BRIGHT;
        ctx.fill();
      }
    }
    for (let idx = 0; idx < 64; idx++) {
      const v = state.board[idx];
      if (v === 0) continue;
      const red = pieceColor(v) === 'red';
      const cx = (idx % 8) * SQ + SQ / 2;
      const cy = Math.floor(idx / 8) * SQ + SQ / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, SQ * 0.36, 0, Math.PI * 2);
      ctx.fillStyle = red ? DOM_RED : DOM_BLACK;
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = red ? '#8E2626' : '#0E0F14';
      ctx.stroke();
      // Movable pieces get a soft halo on your turn (mandatory captures make
      // "why can't I move THIS piece?" a real question — show the answer).
      if (moves.some((m) => m.from === idx)) {
        ctx.beginPath();
        ctx.arc(cx, cy, SQ * 0.44, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(240, 192, 96, 0.65)';
        ctx.stroke();
      }
      if (v === RED_KING || v === BLACK_KING) {
        ctx.fillStyle = GT_GOLD_BRIGHT;
        ctx.font = 'bold 30px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('K', cx, cy + 2);
      }
    }
  };

  const onBoardClick = (e: MouseEvent): void => {
    if (!boardCanvas) return;
    const s = readGame(deps.itemId);
    if (!s || !myTurn(s)) return; // spectators/off-turn: view only
    const rect = boardCanvas.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) / rect.width) * 8);
    const r = Math.floor(((e.clientY - rect.top) / rect.height) * 8);
    if (r < 0 || r > 7 || c < 0 || c > 7) return;
    const idx = r * 8 + c;
    const moves = legalMoves(s);
    if (selected !== null) {
      const move = moves.find((m) => m.from === selected && m.to === idx);
      if (move) {
        const next = applyMove(s, move);
        // Multi-jump: keep the chained piece selected so the continuation
        // reads as one gesture; otherwise clear.
        selected = next.chain;
        writeGame(deps.itemId, next); // observer repaints
        return;
      }
    }
    // (Re)select one of my movable pieces; anything else clears.
    selected = pieceColor(s.board[idx]) === s.turn && moves.some((m) => m.from === idx)
      ? idx : null;
    drawBoard(s); // selection is local — no doc write, repaint directly
  };

  // ── ♟ Chess (#45 — the board face's second game; checkers' sibling) ────────

  let chessSelected: number | null = null;
  let chessBotTimer = 0;

  const myChessSeat = (s: ChessState): ChessColor | null =>
    s.players.white === myId ? 'white' : s.players.black === myId ? 'black' : null;

  const myChessTurn = (s: ChessState): boolean => {
    const seat = myChessSeat(s);
    return s.status === 'playing' && seat !== null && s.turn === seat
      && !(s.bot && s.turn === 'black');
  };

  const chessSeatLabel = (s: ChessState, color: ChessColor): string => {
    if (color === 'black' && s.bot) return 'BOT';
    const id = s.players[color];
    if (!id) return 'OPEN';
    const name = readPlayerDisplayName(id).toUpperCase();
    return id === myId ? `${name} (YOU)` : name;
  };

  const chessStatusText = (s: ChessState): string => {
    if (s.status === 'waiting') return 'WAITING FOR PLAYERS — SIT DOWN TO CLAIM A COLOR';
    if (s.status === 'white-won') return '♔ WHITE WINS — CHECKMATE';
    if (s.status === 'black-won') return '♚ BLACK WINS — CHECKMATE';
    if (s.status === 'draw') return '½–½ DRAW — STALEMATE';
    const who = s.turn.toUpperCase();
    const yours = myChessTurn(s) ? ' — YOUR MOVE' : '';
    const check = inCheck(s.board, s.turn) ? ' · CHECK!' : '';
    return `${who} TO MOVE${yours}${check}`;
  };

  const claimChessSeat = (color: ChessColor): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'chess') return;
    const s = t.state;
    if (s.status !== 'waiting') return;
    if (s.players[color] !== null) return;
    if (s.players[otherChessColor(color)] === myId) return;
    if (s.bot && color === 'black') return;
    const players = { ...s.players, [color]: myId };
    const status = players.white && players.black ? 'playing' as const : s.status;
    writeGame(deps.itemId, { ...s, players, status });
  };

  const startChessBotGame = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'chess') return;
    const s = t.state;
    if (s.status !== 'waiting' || s.players.black !== null) return;
    if (s.players.white !== null && s.players.white !== myId) return;
    writeGame(deps.itemId, { ...s, players: { ...s.players, white: myId }, bot: true, status: 'playing' });
  };

  const chessForfeit = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'chess' || t.state.status !== 'playing') return;
    const seat = myChessSeat(t.state);
    if (!seat) return;
    writeGame(deps.itemId, { ...t.state, status: seat === 'white' ? 'black-won' : 'white-won' });
  };

  /** RESET gate for EITHER game kind (mirror of canReset's reasoning). */
  const canClearTable = (): boolean => {
    const t = readTable(deps.itemId);
    if (!t) return false;
    if (t.kind === 'checkers') return canReset(t.state);
    const s = t.state;
    if (s.status !== 'waiting' && s.status !== 'playing') return true;
    if (s.bot) return true;
    if (s.status === 'waiting') return true; // nobody committed yet
    return myChessSeat(s) !== null || readRoomOwner() === myId;
  };

  /** Clear the table back to the GAME PICKER (both kinds — lets players
   *  switch games; the whole-value LWW caveat from reset() applies). */
  const clearToPicker = (): void => {
    if (!canClearTable()) return;
    selected = null;
    chessSelected = null;
    clearTable(deps.itemId);
  };

  const CHESS_GLYPHS: Record<number, string> = {
    [W_KING]: '♔', [W_QUEEN]: '♕', [W_ROOK]: '♖', [W_BISHOP]: '♗', [W_KNIGHT]: '♘', [W_PAWN]: '♙',
    [B_KING]: '♚', [B_QUEEN]: '♛', [B_ROOK]: '♜', [B_BISHOP]: '♝', [B_KNIGHT]: '♞', [B_PAWN]: '♟',
  };

  const drawChessBoard = (s: ChessState): void => {
    if (!boardCanvas) return;
    const ctx = boardCanvas.getContext('2d');
    if (!ctx) return;
    const SQ = BOARD_RES / 8;
    ctx.imageSmoothingEnabled = true;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        ctx.fillStyle = (r + c) % 2 === 1 ? '#8A6A48' : '#EAD9B0';
        ctx.fillRect(c * SQ, r * SQ, SQ, SQ);
      }
    }
    // Last-move echo (both squares) — reads the opponent's reply at a glance.
    if (s.last) {
      ctx.fillStyle = 'rgba(240, 192, 96, 0.28)';
      for (const sq of [s.last.from, s.last.to]) {
        ctx.fillRect((sq % 8) * SQ, Math.floor(sq / 8) * SQ, SQ, SQ);
      }
    }
    const moves = myChessTurn(s) ? legalChessMoves(s) : [];
    if (chessSelected !== null) {
      ctx.lineWidth = 6;
      ctx.strokeStyle = GT_GOLD_BRIGHT;
      ctx.strokeRect((chessSelected % 8) * SQ + 3, Math.floor(chessSelected / 8) * SQ + 3, SQ - 6, SQ - 6);
      for (const m of moves) {
        if (m.from !== chessSelected) continue;
        ctx.beginPath();
        ctx.arc((m.to % 8) * SQ + SQ / 2, Math.floor(m.to / 8) * SQ + SQ / 2, SQ * 0.13, 0, Math.PI * 2);
        ctx.fillStyle = GT_GOLD_BRIGHT;
        ctx.fill();
      }
    }
    // Check flare under the threatened king.
    if (s.status === 'playing' && inCheck(s.board, s.turn)) {
      const k = s.board.indexOf(s.turn === 'white' ? W_KING : B_KING);
      if (k >= 0) {
        ctx.fillStyle = 'rgba(255, 23, 68, 0.35)';
        ctx.fillRect((k % 8) * SQ, Math.floor(k / 8) * SQ, SQ, SQ);
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `${Math.floor(SQ * 0.78)}px serif`;
    for (let idx = 0; idx < 64; idx++) {
      const v = s.board[idx];
      if (v === 0) continue;
      const cx = (idx % 8) * SQ + SQ / 2;
      const cy = Math.floor(idx / 8) * SQ + SQ / 2 + 4;
      // Halo for movable pieces on your turn (mirrors checkers affordance).
      if (moves.some((m) => m.from === idx)) {
        ctx.beginPath();
        ctx.arc(cx, cy - 4, SQ * 0.42, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(240, 192, 96, 0.6)';
        ctx.stroke();
      }
      // Outline both colors for contrast on both square shades.
      ctx.fillStyle = v > 0 ? '#FFFFFF' : '#16181F';
      ctx.strokeStyle = v > 0 ? '#3A3A3A' : '#C9CDD6';
      ctx.lineWidth = 2;
      ctx.strokeText(CHESS_GLYPHS[v], cx, cy);
      ctx.fillText(CHESS_GLYPHS[v], cx, cy);
    }
  };

  const onChessBoardClick = (e: MouseEvent): void => {
    if (!boardCanvas) return;
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'chess' || !myChessTurn(t.state)) return;
    const s = t.state;
    const rect = boardCanvas.getBoundingClientRect();
    const c = Math.floor(((e.clientX - rect.left) / rect.width) * 8);
    const r = Math.floor(((e.clientY - rect.top) / rect.height) * 8);
    if (r < 0 || r > 7 || c < 0 || c > 7) return;
    const idx = r * 8 + c;
    const moves = legalChessMoves(s);
    if (chessSelected !== null) {
      const move = moves.find((m) => m.from === chessSelected && m.to === idx);
      if (move) {
        chessSelected = null;
        writeGame(deps.itemId, applyChessMove(s, move)); // observer repaints
        return;
      }
    }
    chessSelected = chessPieceColor(s.board[idx]) === s.turn && moves.some((m) => m.from === idx)
      ? idx : null;
    drawChessBoard(s);
  };

  // ── Panel rendering (trunk-UI idiom: re-render + re-attach on change) ──────

  const render = (): void => {
    if (!panel) return;
    const s = readGame(deps.itemId);
    // Prune a stale selection (an opponent/bot move landed, or a reset).
    if (selected !== null
      && (!s || !myTurn(s) || !legalMoves(s).some((m) => m.from === selected))) {
      selected = s?.chain ?? null;
    }
    const cardsUp = deps.top?.isCardsUp() ?? false;
    const flipping = deps.top?.isFlipping() ?? false;
    const surface = flipping ? 'FLIPPING…' : cardsUp ? 'CARD FELT' : 'CHECKERBOARD';

    const btn = (id: string, label: string, disabled: boolean, title = ''): string => `
      <button id="${id}" ${disabled ? 'disabled' : ''} title="${title}" style="
        padding: 6px 10px;
        background: rgba(212, 168, 75, ${disabled ? '0.04' : '0.10'});
        border: 1px solid rgba(212, 168, 75, ${disabled ? '0.18' : '0.45'});
        border-radius: 6px;
        color: ${disabled ? GT_DIM : GT_GOLD_BRIGHT};
        font-family: inherit;
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 1.5px;
        cursor: ${disabled ? 'not-allowed' : 'pointer'};
        opacity: ${disabled ? '0.5' : '1'};
      ">${label}</button>`;

    const seatCell = (color: CheckersColor): string => {
      const state = s ?? initialState();
      const label = seatLabel(state, color);
      const claimable = state.status === 'waiting'
        && state.players[color] === null
        && !(state.bot && color === 'black')
        && state.players[otherColor(color)] !== myId;
      const dot = color === 'red' ? DOM_RED : '#9AA3B2';
      return `
        <div style="flex:1; display:flex; align-items:center; gap:8px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:7px 10px;">
          <span style="width:10px; height:10px; border-radius:50%; background:${dot}; flex:none;"></span>
          <span style="flex:1; font-size:10px; letter-spacing:1px; color:${GT_GOLD};">${color.toUpperCase()} — ${label}</span>
          ${claimable ? btn(`gt-sit-${color}`, 'SIT', false, `Claim ${color}`) : ''}
        </div>`;
    };

    const table = readTable(deps.itemId);

    // Chess: prune a stale selection (opponent/bot moved, or the table reset).
    if (chessSelected !== null
      && (table?.kind !== 'chess' || !myChessTurn(table.state)
        || !legalChessMoves(table.state).some((m) => m.from === chessSelected))) {
      chessSelected = null;
    }

    const boardCursor = (interactive: boolean): string => interactive ? 'pointer' : 'default';
    const canvasHtml = (interactive: boolean): string => `
      <canvas id="gt-board" width="${BOARD_RES}" height="${BOARD_RES}"
        style="width:${BOARD_CSS}px; height:${BOARD_CSS}px; align-self:center; border:1px solid rgba(212,168,75,0.35); border-radius:6px; cursor:${boardCursor(interactive)};"></canvas>`;

    const chessSeatCell = (state: ChessState, color: ChessColor): string => {
      const label = chessSeatLabel(state, color);
      const claimable = state.status === 'waiting'
        && state.players[color] === null
        && !(state.bot && color === 'black')
        && state.players[otherChessColor(color)] !== myId;
      const dot = color === 'white' ? '#EAEAEA' : '#23252E';
      return `
        <div style="flex:1; display:flex; align-items:center; gap:8px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:7px 10px;">
          <span style="width:10px; height:10px; border-radius:50%; background:${dot}; border:1px solid #666; flex:none;"></span>
          <span style="flex:1; font-size:10px; letter-spacing:1px; color:${GT_GOLD};">${color.toUpperCase()} — ${label}</span>
          ${claimable ? btn(`gt-chess-sit-${color}`, 'SIT', false, `Claim ${color}`) : ''}
        </div>`;
    };

    // ── The board face: game picker / checkers / chess ──
    let boardFace: string;
    if (table === null) {
      boardFace = `
        <div style="display:flex; flex-direction:column; gap:10px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:16px 12px;">
          <div style="font-size:11px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1.5px;">CHOOSE A GAME</div>
          <div style="display:flex; gap:10px;">
            ${btn('gt-pick-chess', '♟ CHESS', false, 'Full rules — castling, en passant, checkmate')}
            ${btn('gt-pick-checkers', '⛀ CHECKERS', false, 'American rules, forced captures')}
          </div>
          <div style="font-size:9px; color:rgba(212,168,75,0.5);">Anyone at the table picks; the first two to SIT play. RESET brings this menu back.</div>
        </div>`;
    } else if (table.kind === 'chess') {
      const cs = table.state;
      const showChessBot = cs.status === 'waiting' && cs.players.black === null
        && (cs.players.white === null || cs.players.white === myId);
      const showChessForfeit = cs.status === 'playing' && myChessSeat(cs) !== null;
      boardFace = `
        <div id="gt-status" style="font-size:10px; font-weight:800; letter-spacing:1px; color:${
          cs.status === 'playing' ? GT_GOLD_BRIGHT : cs.status === 'waiting' ? GT_DIM : '#00E676'
        };">${chessStatusText(cs)}</div>
        <div style="display:flex; gap:8px;">
          ${chessSeatCell(cs, 'white')}
          ${chessSeatCell(cs, 'black')}
        </div>
        ${showChessBot ? `<div>${btn('gt-chess-bot', '⚙ VS BOT — PLAY ALONE', false, 'Single-player against a trivial AI')}</div>` : ''}
        ${canvasHtml(myChessTurn(cs))}
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          ${showChessForfeit ? btn('gt-chess-forfeit', 'FORFEIT', false, 'Concede the game') : ''}
          ${btn('gt-reset', 'RESET', !canClearTable(),
            canClearTable() ? 'Clear the table (back to the game menu)' : 'Participants or the room owner reset a live game')}
        </div>`;
    } else {
      const state = table.state;
      const showBot = state.status === 'waiting' && state.players.black === null
        && (state.players.red === null || state.players.red === myId);
      const showForfeit = state.status === 'playing' && mySeat(state) !== null;
      boardFace = `
        <div id="gt-status" style="font-size:10px; font-weight:800; letter-spacing:1px; color:${
          state.status === 'playing' ? GT_GOLD_BRIGHT : state.status === 'waiting' ? GT_DIM : '#00E676'
        };">${statusText(state)}</div>
        <div style="display:flex; gap:8px;">
          ${seatCell('red')}
          ${seatCell('black')}
        </div>
        ${showBot ? `<div>${btn('gt-bot', '⚙ VS BOT — PLAY ALONE', false, 'Start a single-player game against a trivial AI')}</div>` : ''}
        ${canvasHtml(myTurn(state))}
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          ${showForfeit ? btn('gt-forfeit', 'FORFEIT', false, 'Concede the game') : ''}
          ${btn('gt-reset', 'RESET', !canClearTable(),
            canClearTable() ? 'Clear the table (back to the game menu)' : 'Participants or the room owner reset a live game')}
        </div>`;
    }

    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1px;">▦ GAME TABLE</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      <div style="display:flex; align-items:center; gap:10px;">
        <span style="font-size:10px; color:${GT_DIM}; letter-spacing:1.5px;">SURFACE:</span>
        <span style="flex:1; font-size:11px; font-weight:800; color:${GT_GOLD}; letter-spacing:1.5px;">${surface}</span>
        ${btn('gt-flip', '⟲ FLIP TABLE', !deps.top || flipping,
          deps.top ? 'Flip to the other playing surface' : 'This table top is not animatable')}
      </div>
      ${cardsUp ? `
      <div style="display:flex; flex-direction:column; gap:8px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:14px 12px; background:rgba(10,24,14,0.5);">
        <div style="font-size:11px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1.5px;">♠ CARD FELT</div>
        <div style="font-size:10px; color:rgba(212,168,75,0.75); line-height:1.6;">
          NO DECK DEALT — war, two-player poker and solitaire arrive with the
          games roadmap (brainstorming/games-plan.md). Flip back for the board games.
        </div>
      </div>` : boardFace}
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">
        SSF GAME TABLE · chess (full rules, auto-queen) + checkers (American rules) · state synced via room doc · flip is per-player (only you see the other face)
      </div>
    `;

    panel.querySelector<HTMLButtonElement>('#gt-flip')?.addEventListener('click', () => {
      if (!deps.top || deps.top.isFlipping()) return;
      selected = null;
      chessSelected = null;
      deps.top.flip(() => render()); // completion swaps the panel face
      render();                      // immediate: show FLIPPING…
    });
    // Picker.
    panel.querySelector<HTMLButtonElement>('#gt-pick-chess')?.addEventListener('click', () => {
      if (readTable(deps.itemId) === null) writeGame(deps.itemId, initialChessState());
    });
    panel.querySelector<HTMLButtonElement>('#gt-pick-checkers')?.addEventListener('click', () => {
      if (readTable(deps.itemId) === null) writeGame(deps.itemId, initialState());
    });
    // Checkers controls.
    panel.querySelector<HTMLButtonElement>('#gt-sit-red')?.addEventListener('click', () => claimSeat('red'));
    panel.querySelector<HTMLButtonElement>('#gt-sit-black')?.addEventListener('click', () => claimSeat('black'));
    panel.querySelector<HTMLButtonElement>('#gt-bot')?.addEventListener('click', () => startBotGame());
    panel.querySelector<HTMLButtonElement>('#gt-forfeit')?.addEventListener('click', () => forfeit());
    // Chess controls.
    panel.querySelector<HTMLButtonElement>('#gt-chess-sit-white')?.addEventListener('click', () => claimChessSeat('white'));
    panel.querySelector<HTMLButtonElement>('#gt-chess-sit-black')?.addEventListener('click', () => claimChessSeat('black'));
    panel.querySelector<HTMLButtonElement>('#gt-chess-bot')?.addEventListener('click', () => startChessBotGame());
    panel.querySelector<HTMLButtonElement>('#gt-chess-forfeit')?.addEventListener('click', () => chessForfeit());
    // Shared RESET → back to the picker (both kinds).
    panel.querySelector<HTMLButtonElement>('#gt-reset')?.addEventListener('click', () => clearToPicker());
    boardCanvas = panel.querySelector<HTMLCanvasElement>('#gt-board');
    if (table?.kind === 'chess') {
      boardCanvas?.addEventListener('click', onChessBoardClick);
      drawChessBoard(table.state);
    } else {
      boardCanvas?.addEventListener('click', onBoardClick);
      drawBoard(table?.state ?? null);
    }
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-gametable-pane';
      // Gold-on-dark monospace shell (room-terminal idiom), nudged above
      // centre so the 3D tabletop stays visible under the downward gaze.
      panel.style.cssText = `
        position: absolute;
        top: 46%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 420px;
        max-height: 92vh;
        overflow-y: auto;
        background: rgba(4, 8, 22, 0.94);
        border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px;
        box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        color: ${GT_GOLD};
        font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box;
        pointer-events: auto;
      `;
      // Input capture (plan §D0.3): clicks inside the device UI never reach
      // the canvas handler — clicks that DO reach it release the focus.
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      selected = null;
      botTimer = 0;
      // Observer-driven repaint: doc changes (peer moves, claims, resets,
      // rebinds after a rejoin) re-render the whole panel from the doc.
      unsubscribe = subscribeGames(() => render());
      render();
    },

    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      panel?.remove();
      panel = null;
      boardCanvas = null;
    },

    update(dt: number): void {
      // Single-player bot pumps: the human claimant's client plays the bot
      // side with a small think-delay. Runs only while this UI is mounted —
      // the trivial bots sleep when the table is not focused (documented v1).
      const t = readTable(deps.itemId);
      if (t?.kind === 'checkers') {
        const s = t.state;
        if (s.bot && s.status === 'playing' && s.turn === 'black' && s.players.red === myId) {
          botTimer += dt;
          if (botTimer >= 0.7) {
            botTimer = 0;
            const move = chooseBotMove(s);
            if (move) writeGame(deps.itemId, applyMove(s, move));
          }
        } else botTimer = 0;
      } else if (t?.kind === 'chess') {
        const s = t.state;
        if (s.bot && s.status === 'playing' && s.turn === 'black' && s.players.white === myId) {
          chessBotTimer += dt;
          if (chessBotTimer >= 0.8) {
            chessBotTimer = 0;
            const move = chooseChessBotMove(s);
            if (move) writeGame(deps.itemId, applyChessMove(s, move));
          }
        } else chessBotTimer = 0;
      } else {
        botTimer = 0;
        chessBotTimer = 0;
      }
    },
  };
}
