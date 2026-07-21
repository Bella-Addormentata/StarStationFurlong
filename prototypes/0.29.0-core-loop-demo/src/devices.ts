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
import { FURNITURE, FURNITURE_DEFS, buildDeviceList, itemAabb } from './furniture';
// 🚀 #30 SH1: the helm re-renders its checklist when the furniture doc moves
// (an engine landing while someone reads the status flips the row live).
import { subscribeFurniture as subscribeFurnitureForHelm } from './furnitureDoc';
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
// 🎰 #69 G1/G2: chips + the cage ledger + roulette table state (casino map).
import {
  readChips, buyInChips, cashOutChips, spendChips, creditChips,
  readCageLedger, readTableState,
  readMyBets, writeMyBets, readAllBets, subscribeCasino,
} from './casinoDoc';
import {
  WHEEL_ORDER, pocketColor,
} from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
// 🎰🤖 #77B: the auto-croupier's shared settle/open helpers (the manual SPIN /
// NEW ROUND buttons delegate to the same implementation) + operator liveness.
import { rollAndSettle, openBetting, isCroupierLive } from './croupier';
// 🤖 #77C s3: per-dock robot routine config (the programming console).
import {
  readRobotConfig, writeRobotConfig, subscribeRobot,
  ROBOT_ROUTINES, ROUTINE_LABELS, MAX_SCRIPT_STEPS,
} from './robotDoc';
import type { RobotRoutine, RobotStep } from './robotDoc';
// 🪙 Physical chips (owner request): outside the cashier, balances render as
// countable chip stacks — never as a number. One renderer enforces the rule.
import { chipsFor, drawChips, drawFeltStack } from './chipDisplay';

// ── Core interfaces (plan §D0.2) ──────────────────────────────────────────────

export type DeviceKind = 'roomTerminal' | 'deskComputer' | 'mapTable' | 'storageTrunk' | 'gameTable' | 'helm' | 'cashier' | 'roulette' | 'cloneVat' | 'robotDock';

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

// ── 🧬 Clone-vat handle (owner request — diegetic spawn point) ───────────────

/**
 * Handle onto a clone vat's animated tank: green nutrient liquid that drains
 * and a glass door shell that spins open around the cylinder axis. The
 * builder (furniture.ts) stows it in the tank base's userData.cloneVat;
 * World collects it, drives update(dt) every frame (trunk-lid idiom), and
 * the spawn choreography (World.respawnAtVat) sequences it against the
 * player's scripted walk-out.
 */
export interface CloneVatHandle {
  /**
   * Snap to the full+closed attract state, hold a short beat, then drain the
   * liquid and spin the glass door open. onOpen fires exactly once when the
   * doorway is clear (the avatar may walk out). Restarts cleanly if called
   * mid-cycle.
   */
  beginSpawnCycle(onOpen: () => void): void;
  /** Spin the door shut, then slowly refill the tank (idle attract state). */
  closeAndRefill(): void;
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
    /** 🛰️ EDIT HULL — same edit mode, camera pulled back + walls dropped so
     *  the OUTSIDE of the module (tanks, engines, stacks) is editable. */
    requestHull: () => void;
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
    const hullBtn = panel.querySelector<HTMLButtonElement>('#device-terminal-edit-hull');
    const editNote = panel.querySelector<HTMLElement>('#device-terminal-edit-room-note');
    if (editBtn && deps.editRoom) {
      const perm = deps.editRoom.permission();
      for (const btn of [editBtn, hullBtn]) {
        if (!btn) continue;
        btn.disabled = !perm.ok;
        btn.style.opacity = perm.ok ? '1' : '0.35';
        btn.style.cursor = perm.ok ? 'pointer' : 'not-allowed';
      }
      editBtn.title = perm.ok ? 'Rearrange this room’s furniture' : perm.reason;
      if (hullBtn) {
        hullBtn.title = perm.ok
          ? 'Mount tanks and engines on the OUTSIDE of the module (stacks too)'
          : perm.reason;
      }
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
          <div style="display:flex; gap:8px;">
            <button id="device-terminal-edit-room" style="
              flex: 1;
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
            <button id="device-terminal-edit-hull" style="
              flex: 1;
              padding: 8px 12px;
              background: rgba(62, 146, 184, 0.10);
              border: 1px solid rgba(62, 146, 184, 0.45);
              border-radius: 6px;
              color: #7FD4FF;
              font-family: inherit;
              font-size: 12px;
              font-weight: 800;
              letter-spacing: 1.5px;
              cursor: pointer;
            ">EDIT HULL 🛰️</button>
          </div>
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
      const hullBtn = panel.querySelector<HTMLButtonElement>('#device-terminal-edit-hull');
      if (editBtn && deps.editRoom) {
        const editRoom = deps.editRoom;
        editBtn.addEventListener('click', () => {
          if (!editRoom.permission().ok) return; // gate re-checked at press time
          editRoom.request();
        });
        hullBtn?.addEventListener('click', () => {
          if (!editRoom.permission().ok) return;
          editRoom.requestHull();
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

// ── 🚀 #30 SH1: the HELM console — ship status, no flight yet ────────────────

/**
 * The helm's focused UI: a SHIP STATUS checklist derived LIVE from the room's
 * furniture (the fittings ARE the requirements — #62's physical-item ruling
 * applied to ships). No doc state of its own in SH1: presence of fittings is
 * already shared truth via the furniture map. Flight controls arrive with the
 * flight slices (spaceship-conversion-plan.md); the panel says so honestly.
 */
export function createHelmUI(): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;

  const render = (): void => {
    if (!panel) return;
    const engines = FURNITURE.filter((i) => FURNITURE_DEFS[i.kind]?.functions?.includes('engine')).length;
    const tanks = FURNITURE.filter((i) => FURNITURE_DEFS[i.kind]?.functions?.includes('fuelTank')).length;
    const check = (ok: boolean) => ok
      ? '<span style="color:#00E676;">✔</span>'
      : '<span style="color:#FF8A80;">✗</span>';
    const row = (label: string, value: string) => `
      <div style="display:flex; justify-content:space-between; gap:10px; padding:5px 0; border-bottom:1px solid rgba(212,168,75,0.10); font-size:11px;">
        <span style="color:rgba(212,168,75,0.75);">${label}</span><span>${value}</span>
      </div>`;
    const ready = engines >= 1 && tanks >= 1;
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:#F0C060; letter-spacing:1px;">🚀 HELM — SHIP STATUS</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      ${row('ENGINES', `${check(engines >= 1)} ${engines} mounted`)}
      ${row('FUEL', `${check(tanks >= 1)} ${tanks} tank${tanks === 1 ? '' : 's'}${tanks > 0 ? ' · FULL' : ' — install a fuel tank'}`)}
      ${row('HELM', `${check(true)} online`)}
      ${row('PROVISIONS', '— <span style="color:rgba(212,168,75,0.45);">galley update coming</span>')}
      ${row('HULL', `${check(true)} sealed`)}
      <div style="margin-top:10px; padding:10px 12px; border:1px solid rgba(212,168,75,0.2); border-radius:8px; font-size:10px; line-height:1.6; color:${ready ? '#00E676' : 'rgba(212,168,75,0.7)'};">
        ${ready
          ? 'ALL SYSTEMS FITTED — this module is spaceworthy. Undocking and flight arrive with the flight update; the station keeps you safely berthed until then.'
          : 'NOT SPACEWORTHY YET — mount at least one ENGINE BLOCK and one FUEL TANK (edit mode places them; DEV menu stocks them for now).'}
      </div>
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px; margin-top:10px;">
        SSF FLIGHT SYSTEMS v0 · status only — controls arrive with the flight update
      </div>
    `;
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-helm-pane';
      panel.style.cssText = `
        position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
        width: 380px; max-height: 88vh; overflow-y: auto;
        background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px; display: flex; flex-direction: column;
        color: #d4a84b; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box; pointer-events: auto;
      `;
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      unsubscribe = subscribeFurnitureForHelm(() => render());
      render();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      panel?.remove();
      panel = null;
    },

    update(): void { /* status is observer-driven; nothing per-frame */ },
  };
}

// ── 🧬 Clone-vat panel — pick where your clone decants (owner request) ───────

export interface CloneVatUIDeps {
  /** Is THIS vat my saved spawn point in this room? */
  isMySpawn: () => boolean;
  /** Would this vat decant me anyway (it's the room's effective spawn vat)? */
  isEffectiveSpawn: () => boolean;
  /** Save / clear this vat as my spawn point. */
  setMySpawn: (on: boolean) => void;
}

/**
 * The clone vat's focused panel: one clear choice — make this tank the place
 * YOUR clone wakes up in this module. Local preference (each visitor picks
 * their own tank); arrivals with no pick decant from the room's first vat.
 */
export function createCloneVatUI(deps: CloneVatUIDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;

  const render = (): void => {
    if (!panel) return;
    const mine = deps.isMySpawn();
    const effective = deps.isEffectiveSpawn();
    const status = mine
      ? '⭐ This is <b>your tank</b> — your clone wakes up here.'
      : effective
        ? 'This is the module\'s <b>first tank</b> — clones with no saved pick (you included) wake up here.'
        : 'Your clone currently wakes up elsewhere in this module.';
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:#F0C060; letter-spacing:1px;">🧬 CLONE VAT</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      <div style="font-size:11px; line-height:1.6; margin-top:10px;">${status}</div>
      <div style="margin-top:12px;">
        <button type="button" id="vat-spawn-toggle" style="display:inline-block; padding:6px 12px; border-radius:8px; font-size:11px; font-weight:700; cursor:pointer; ${mine
          ? 'background:rgba(255,23,68,0.10); border:1px solid rgba(255,23,68,0.35); color:#ff8a80;'
          : 'background:rgba(0,230,118,0.10); border:1px solid rgba(0,230,118,0.35); color:#69f0ae;'}">
          ${mine ? '✗ FORGET THIS TANK' : '⭐ WAKE UP HERE'}
        </button>
      </div>
      <div style="font-size:10px; color:rgba(212,168,75,0.65); line-height:1.6; margin-top:10px;">
        Your pick is saved on this device, per module.${mine || effective
          ? ' Visitors arriving with a room pass decant from a tank too — this is where new clones step out.'
          : ''}
      </div>`;
    panel.querySelector('#vat-spawn-toggle')?.addEventListener('click', () => {
      deps.setMySpawn(!deps.isMySpawn());
      render();
    });
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-clone-vat-pane';
      panel.style.cssText = `
        position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
        width: 320px; max-height: 88vh; overflow-y: auto;
        background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px; display: flex; flex-direction: column;
        color: #d4a84b; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box; pointer-events: auto;
      `;
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      render();
    },
    unmount(): void {
      panel?.remove();
      panel = null;
    },
    update(): void { /* nothing per-frame */ },
  };
}

// ── 🎰 #69 G1: the CASHIER — chips in, chips out, the cage ledger public ─────

export interface CashierUIDeps {
  /** Owner-equivalent predicate (the one-seam ownership gate, via world). */
  isHouse: () => boolean;
}

const CH_GOLD = '#d4a84b';
const CH_GOLD_BRIGHT = '#F0C060';
const CH_DIM = '#4A5560';
const CH_PINK = '#FF2D95';

/**
 * The cashier ATM's focused UI (#69 G1): YOUR CHIPS, buy-in, cash-out, and
 * the cage ledger — issuance is PUBLIC (every player sees issued/outstanding/
 * house net and the floor balances), which is the whole trust model of
 * doc-recorded chips. Plain language only: chips / cashier / the cage —
 * the Registry-anchored upgrade (G4) keeps this exact screen.
 */
export function createCashierUI(deps: CashierUIDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  const myId = getPlayerId();

  const render = (): void => {
    if (!panel) return;
    const chips = readChips(myId);
    const cage = readCageLedger();
    const btn = (id: string, label: string, disabled = false): string => `
      <button id="${id}" ${disabled ? 'disabled' : ''} style="
        flex:1; padding: 8px 6px;
        background: rgba(212, 168, 75, ${disabled ? '0.04' : '0.10'});
        border: 1px solid rgba(212, 168, 75, ${disabled ? '0.18' : '0.45'});
        border-radius: 6px; color: ${disabled ? CH_DIM : CH_GOLD_BRIGHT};
        font-family: inherit; font-size: 10px; font-weight: 800; letter-spacing: 1px;
        cursor: ${disabled ? 'not-allowed' : 'pointer'};
      ">${label}</button>`;
    const floorRows = Object.entries(cage.balances)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([pid, n]) => `
        <div style="display:flex; justify-content:space-between; font-size:10px; padding:2px 0;">
          <span style="color:${CH_GOLD};">${readPlayerDisplayName(pid).toUpperCase()}${pid === myId ? ' (YOU)' : ''}</span>
          <span style="color:${CH_GOLD_BRIGHT};">🪙 ${n}</span>
        </div>`);
    const net = cage.houseNet;
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:${CH_GOLD_BRIGHT}; letter-spacing:1px;">🎰 CASHIER</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      <div style="display:flex; align-items:baseline; gap:10px;">
        <span style="font-size:10px; color:${CH_DIM}; letter-spacing:1.5px;">YOUR CHIPS</span>
        <span style="font-size:26px; font-weight:800; color:${CH_GOLD_BRIGHT};">🪙 ${chips}</span>
      </div>
      <canvas id="cashier-rack" width="680" height="150"
        style="width:340px; height:75px; align-self:flex-start;"></canvas>
      <div>
        <div style="font-size:10px; color:${CH_GOLD}; letter-spacing:2px; margin-bottom:6px;">BUY-IN</div>
        <div style="display:flex; gap:8px;">
          ${btn('cashier-buy-25', '+25')}
          ${btn('cashier-buy-100', '+100')}
          ${btn('cashier-buy-500', '+500')}
        </div>
        <div style="font-size:9px; color:${CH_DIM}; margin-top:5px; line-height:1.5;">
          Test network — the cage advances chips against your Account.
          Real Chia buy-ins arrive with the Registry cashier.
        </div>
      </div>
      <div>
        <div style="font-size:10px; color:${CH_GOLD}; letter-spacing:2px; margin-bottom:6px;">CASH OUT</div>
        <div style="display:flex; gap:8px;">${btn('cashier-cashout', 'RETURN ALL CHIPS TO THE CAGE', chips <= 0)}</div>
      </div>
      <div style="border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:10px 12px; background:rgba(10,16,24,0.6);">
        <div style="font-size:10px; color:${CH_PINK}; letter-spacing:2px; margin-bottom:6px;">THE CAGE — PUBLIC LEDGER</div>
        <div style="display:flex; justify-content:space-between; font-size:10px; padding:2px 0;">
          <span style="color:${CH_DIM};">CHIPS ISSUED</span><span style="color:${CH_GOLD};">${cage.issued}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; padding:2px 0;">
          <span style="color:${CH_DIM};">RETURNED</span><span style="color:${CH_GOLD};">${cage.cashed}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; padding:2px 0;">
          <span style="color:${CH_DIM};">ON THE FLOOR</span><span style="color:${CH_GOLD};">${cage.outstanding}</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:10px; padding:2px 0; border-top:1px solid rgba(212,168,75,0.12); margin-top:3px;">
          <span style="color:${CH_DIM};">HOUSE NET</span>
          <span style="font-weight:800; color:${net >= 0 ? '#00E676' : '#FF8A80'};">${net >= 0 ? '+' : ''}${net}</span>
        </div>
        ${floorRows.length ? `<div style="border-top:1px solid rgba(212,168,75,0.12); margin-top:6px; padding-top:5px;">${floorRows.join('')}</div>` : ''}
      </div>
      ${deps.isHouse() ? `
      <div style="font-size:9.5px; color:${CH_PINK}; letter-spacing:0.5px;">
        ★ YOU ARE THE HOUSE — table games pay from the cage; the ledger above is your book.
      </div>` : ''}
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">
        SSF CASINO CAGE v1 · chips are room records, ledger public · Registry chips later
      </div>
    `;
    panel.querySelector<HTMLButtonElement>('#cashier-buy-25')?.addEventListener('click', () => buyInChips(myId, 25));
    panel.querySelector<HTMLButtonElement>('#cashier-buy-100')?.addEventListener('click', () => buyInChips(myId, 100));
    panel.querySelector<HTMLButtonElement>('#cashier-buy-500')?.addEventListener('click', () => buyInChips(myId, 500));
    panel.querySelector<HTMLButtonElement>('#cashier-cashout')?.addEventListener('click', () => cashOutChips(myId, readChips(myId)));
    // 🪙 The cashier ALSO shows the physical tray (the one place number and
    // chips appear together — it teaches the counting).
    const rack = panel.querySelector<HTMLCanvasElement>('#cashier-rack');
    const rctx = rack?.getContext('2d');
    if (rack && rctx) {
      rctx.setTransform(2, 0, 0, 2, 0, 0);
      rctx.clearRect(0, 0, 340, 75);
      drawChips(rctx, chipsFor(chips), 0, 0, 340, 75, { emptyText: 'THE TRAY IS EMPTY' });
    }
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-cashier-pane';
      panel.style.cssText = `
        position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
        width: 380px; max-height: 90vh; overflow-y: auto;
        background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px; display: flex; flex-direction: column; gap: 12px;
        color: ${CH_GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box; pointer-events: auto;
      `;
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      unsubscribe = subscribeCasino(() => render());
      render();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      panel?.remove();
      panel = null;
    },
    update(): void { /* observer-driven; nothing per-frame */ },
  };
}

// ── 🤖 #77C s3: ROBOT DOCK — program the dock's robot (routine console) ───────

export interface RobotDockUIDeps {
  /** Charging-dock item id — keys this robot's routine in the robot map. */
  itemId: string;
  /** Owner gate — only the room owner may program the robot. */
  canEdit: () => boolean;
}

/** HTML-attribute escape for owner-authored 'say' text (rendered in the editor
 *  on every client's owner view — never trust the value even from a peer). */
function escAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * The charging dock's focused UI (#77C s3/s4): choose the robot's ROUTINE from a
 * short menu — Serve drinks / Roulette croupier / Idle at dock / Custom script —
 * and, for a custom routine, edit a bounded step list (go-to / say / wait) the
 * robot loops. Written to the synced `robot` map (owner-only) so every client
 * runs this dock's robot the same way.
 */
export function createRobotDockUI(deps: RobotDockUIDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;

  const writeScript = (routine: RobotRoutine, script: RobotStep[]): void => {
    writeRobotConfig(deps.itemId, { routine, script });
  };
  const curScript = (): RobotStep[] => readRobotConfig(deps.itemId)?.script ?? [];

  const render = (): void => {
    if (!panel) return;
    const cfg = readRobotConfig(deps.itemId);
    const current = cfg?.routine ?? 'serve';
    const owner = deps.canEdit();
    const routineBtn = (r: RobotRoutine): string => {
      const on = r === current;
      return `<button data-routine="${r}" ${owner ? '' : 'disabled'} style="
        display:flex; justify-content:space-between; align-items:center; gap:8px;
        padding:9px 12px; text-align:left;
        background:${on ? 'rgba(47,230,160,0.14)' : 'rgba(212,168,75,0.06)'};
        border:1px solid ${on ? '#2fe6a0' : 'rgba(212,168,75,0.35)'};
        border-radius:7px; color:${on ? '#2fe6a0' : CH_GOLD};
        font-family:inherit; font-size:11px; font-weight:800; letter-spacing:0.5px;
        cursor:${owner ? 'pointer' : 'default'};
      "><span>${ROUTINE_LABELS[r]}</span><span>${on ? '● ON' : ''}</span></button>`;
    };
    const inp = (idx: number, field: string, val: string, w: string, type = 'text'): string =>
      `<input data-idx="${idx}" data-f="${field}" type="${type}" value="${val}" ${owner ? '' : 'disabled'} style="
        width:${w}; background:rgba(0,0,0,0.35); border:1px solid rgba(212,168,75,0.3);
        border-radius:4px; color:${CH_GOLD_BRIGHT}; font-family:inherit; font-size:10px; padding:3px 5px;">`;
    const stepRow = (step: RobotStep, idx: number): string => {
      const del = owner
        ? `<button data-del="${idx}" title="Remove" style="margin-left:auto; background:none; border:none; color:#FF8A80; font-size:14px; cursor:pointer;">×</button>`
        : '';
      let body: string;
      if (step.kind === 'goto') {
        body = `🚶 GO TO ${inp(idx, 'x', String(step.x), '46px', 'number')} , ${inp(idx, 'z', String(step.z), '46px', 'number')}`;
      } else if (step.kind === 'say') {
        body = `💬 SAY ${inp(idx, 'text', escAttr(step.text), '150px')}`;
      } else {
        body = `⏱ WAIT ${inp(idx, 'secs', String(step.secs), '46px', 'number')} s`;
      }
      return `<div style="display:flex; align-items:center; gap:6px; font-size:10px; color:${CH_GOLD};">${body}${del}</div>`;
    };
    const script = curScript();
    // 🤖 STOP/START (owner request): a big toggle to park the robot on its dock.
    const parked = cfg?.parked === true;
    const parkBtn = `<button data-park="1" ${owner ? '' : 'disabled'} style="
      display:flex; justify-content:center; align-items:center;
      padding:10px 12px; width:100%;
      background:${parked ? 'rgba(47,230,160,0.16)' : 'rgba(255,138,80,0.12)'};
      border:1px solid ${parked ? '#2fe6a0' : '#ff8a50'};
      border-radius:7px; color:${parked ? '#2fe6a0' : '#ff8a50'};
      font-family:inherit; font-size:12px; font-weight:800; letter-spacing:0.5px;
      cursor:${owner ? 'pointer' : 'default'};
    ">${parked ? '▶ START · resume routine' : '⏸ STOP · park at dock'}</button>`;
    const addBtn = (kind: string, label: string): string =>
      `<button data-add="${kind}" style="flex:1; padding:6px; background:rgba(212,168,75,0.08); border:1px solid rgba(212,168,75,0.35); border-radius:6px; color:${CH_GOLD_BRIGHT}; font-family:inherit; font-size:10px; font-weight:800; cursor:pointer;">${label}</button>`;
    const editor =
      current === 'custom'
        ? `
      <div style="font-size:10px; color:${CH_DIM}; letter-spacing:1.5px; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">SCRIPT — loops top to bottom</div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${script.length ? script.map(stepRow).join('') : `<span style="font-size:10px; color:#4A5560;">No steps yet.${owner ? ' Add some below.' : ''}</span>`}
      </div>
      ${owner
          ? script.length < MAX_SCRIPT_STEPS
            ? `<div style="display:flex; gap:6px;">${addBtn('goto', '+ Go to')}${addBtn('say', '+ Say')}${addBtn('wait', '+ Wait')}</div>`
            : `<span style="font-size:9px; color:#4A5560;">Max ${MAX_SCRIPT_STEPS} steps.</span>`
          : ''}`
        : '';
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:${CH_GOLD_BRIGHT}; letter-spacing:1px;">🤖 ROBOT PROGRAM</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      ${parkBtn}
      <div style="font-size:10px; color:${CH_DIM}; letter-spacing:1.5px;">ROUTINE</div>
      <div style="display:flex; flex-direction:column; gap:8px;">
        ${ROBOT_ROUTINES.map(routineBtn).join('')}
      </div>
      ${editor}
      <div style="font-size:9.5px; color:${owner ? CH_PINK : CH_DIM}; letter-spacing:0.5px;">
        ${owner
          ? 'Program this dock&apos;s robot. Custom = a step loop it walks and speaks.'
          : 'Only the room owner can program this robot.'}
      </div>
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">
        SSF ROBOT CONSOLE v1 · one robot per dock · syncs to everyone in the room
      </div>
    `;
    if (!owner) return;
    // 🤖 STOP/START: toggle parked, preserving routine + script.
    panel.querySelector<HTMLButtonElement>('[data-park]')?.addEventListener('click', () => {
      const c = readRobotConfig(deps.itemId);
      writeRobotConfig(deps.itemId, {
        routine: c?.routine ?? 'serve',
        ...(c?.script?.length ? { script: c.script } : {}),
        parked: !(c?.parked === true),
      });
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-routine]').forEach((b) => {
      b.addEventListener('click', () => {
        // Keep any authored script AND the parked state when switching routines.
        const c = readRobotConfig(deps.itemId);
        writeRobotConfig(deps.itemId, {
          routine: b.dataset.routine as RobotRoutine,
          ...(script.length ? { script } : {}),
          ...(c?.parked ? { parked: true } : {}),
        });
      });
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-add]').forEach((b) => {
      b.addEventListener('click', () => {
        const kind = b.dataset.add;
        const step: RobotStep =
          kind === 'goto'
            ? { kind: 'goto', x: 0, z: 0 }
            : kind === 'say'
              ? { kind: 'say', text: 'Hello!' }
              : { kind: 'wait', secs: 2 };
        writeScript('custom', [...curScript(), step].slice(0, MAX_SCRIPT_STEPS));
      });
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-del]').forEach((b) => {
      b.addEventListener('click', () => {
        const i = Number(b.dataset.del);
        writeScript('custom', curScript().filter((_, n) => n !== i));
      });
    });
    panel.querySelectorAll<HTMLInputElement>('[data-idx]').forEach((el) => {
      el.addEventListener('change', () => {
        const i = Number(el.dataset.idx);
        const f = el.dataset.f!;
        const script2 = curScript().map((s, n) => {
          if (n !== i) return s;
          if (f === 'text') return { ...s, text: el.value };
          return { ...s, [f]: Number(el.value) };
        });
        writeScript('custom', script2 as RobotStep[]);
      });
    });
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-robotdock-pane';
      panel.style.cssText = `
        position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
        width: 340px; max-height: 90vh; overflow-y: auto;
        background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px; display: flex; flex-direction: column; gap: 12px;
        color: ${CH_GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box; pointer-events: auto;
      `;
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      unsubscribe = subscribeRobot(() => render());
      render();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      panel?.remove();
      panel = null;
    },
    update(): void {
      /* observer-driven; nothing per-frame */
    },
  };
}

// ── 🎡 #69 G2: ROULETTE — house-banked, croupier spins, chips on the felt ────

export interface RouletteUIDeps {
  /** Furniture item id — keys the table + bet records in the casino map. */
  itemId: string;
  /** Owner-equivalent predicate: the croupier side (house/venture). */
  isHouse: () => boolean;
}

/** Seconds the wheel animates after a settle lands. */
const RL_SPIN_SECS = 4.0;
const RL_GREEN = '#1B6B3A';
const RL_RED = '#C43C3C';
const RL_BLACK = '#23252E';

/** Betting-board hit region (CSS px inside the board canvas). */
interface BoardRegion {
  x: number; y: number; w: number; h: number;
  label: string;
  fill: string | null;
  bet: { type: RouletteBet['type']; pick?: number };
}

const RL_BOARD_W = 344;
const RL_BOARD_H = 440;

/** Single source for drawing AND hit-testing the classic layout. */
function rouletteBoardRegions(): BoardRegion[] {
  const regions: BoardRegion[] = [];
  const GX = 116, GY = 40, CW = 72, CH = 30; // number grid
  regions.push({ x: GX, y: 4, w: CW * 3, h: 32, label: '0', fill: RL_GREEN, bet: { type: 'straight', pick: 0 } });
  for (let n = 1; n <= 36; n++) {
    const r = Math.floor((n - 1) / 3), c = (n - 1) % 3;
    regions.push({
      x: GX + c * CW, y: GY + r * CH, w: CW, h: CH,
      label: String(n),
      fill: pocketColor(n) === 'red' ? RL_RED : RL_BLACK,
      bet: { type: 'straight', pick: n },
    });
  }
  // Dozens beside the grid.
  for (let d = 0; d < 3; d++) {
    regions.push({
      x: 60, y: GY + d * CH * 4, w: 52, h: CH * 4,
      label: ['1st', '2nd', '3rd'][d] + ' 12', fill: null, bet: { type: 'dozen', pick: d },
    });
  }
  // Even-money outermost.
  const even: Array<[string, RouletteBet['type']]> = [
    ['1–18', 'low'], ['EVEN', 'even'], ['RED', 'red'],
    ['BLACK', 'black'], ['ODD', 'odd'], ['19–36', 'high'],
  ];
  even.forEach(([label, type], i) => {
    regions.push({
      x: 4, y: GY + i * CH * 2, w: 52, h: CH * 2,
      label, fill: type === 'red' ? RL_RED : type === 'black' ? RL_BLACK : null,
      bet: { type },
    });
  });
  // Column bets under the grid.
  for (let c = 0; c < 3; c++) {
    regions.push({
      x: GX + c * CW, y: GY + 12 * CH + 4, w: CW, h: 30,
      label: '2:1', fill: null, bet: { type: 'column', pick: c },
    });
  }
  return regions;
}

/**
 * The roulette table's focused UI (#69 G2): a live wheel, the classic betting
 * board (straight numbers + dozens/columns + even-money), chip denominations,
 * and the croupier controls. House-banked: stakes leave your chips when they
 * hit the felt; the croupier (owner-equivalent client — a venture-owned house
 * pays every shareholder's croupier duty the same way) spins, and the settle
 * write carries result + payouts for every client to converge on. Fairness is
 * dev-phase trust (the croupier's client rolls) — commit-reveal is the G5
 * upgrade, and the panel says so honestly.
 */
export function createRouletteUI(deps: RouletteUIDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let wheelCanvas: HTMLCanvasElement | null = null;
  let boardCanvas: HTMLCanvasElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let denom = 5;
  /** Round whose spin animation was already started (never replay history). */
  let animRound = 0;
  /** Animation progress 0..1, or null when idle. */
  let animT: number | null = null;
  /** One-shot notice line (e.g. "not enough chips"), cleared on next render. */
  let flash = '';
  const myId = getPlayerId();
  const regions = rouletteBoardRegions();

  const state = (): RouletteTableState | null => readTableState(deps.itemId);
  const round = (): number => state()?.round ?? 1;
  const phase = (): 'betting' | 'closing' | 'settled' => state()?.phase ?? 'betting';
  const myBets = (): RouletteBet[] => readMyBets(deps.itemId, myId, round());
  /** Betting is CLOSED once the phase leaves 'betting' OR the auto-croupier's
   *  window deadline has passed (a chip must not land after "no more bets"). */
  const bettingOpen = (): boolean => {
    const s = state();
    if ((s?.phase ?? 'betting') !== 'betting') return false;
    return s?.phaseDeadline == null || Date.now() < s.phaseDeadline;
  };

  // ── Bet placement (stakes move at placement time — see module doc) ─────────

  const placeBet = (bet: { type: RouletteBet['type']; pick?: number }): void => {
    if (!bettingOpen() || animT !== null) return;
    if (!spendChips(myId, denom)) {
      flash = 'NOT ENOUGH CHIPS — VISIT THE CASHIER';
      render();
      return;
    }
    writeMyBets(deps.itemId, myId, round(), [...myBets(), { ...bet, amount: denom }]);
  };

  const undoBet = (): void => {
    if (!bettingOpen()) return; // symmetric with placeBet — no take-back past the deadline
    const bets = myBets();
    const last = bets[bets.length - 1];
    if (!last) return;
    creditChips(myId, last.amount);
    writeMyBets(deps.itemId, myId, round(), bets.slice(0, -1));
  };

  const clearBets = (): void => {
    if (!bettingOpen()) return;
    const total = myBets().reduce((sum, b) => sum + b.amount, 0);
    if (total > 0) creditChips(myId, total);
    writeMyBets(deps.itemId, myId, round(), []);
  };

  // ── Croupier: the settle write is the round's single source of truth ───────
  // Manual house controls (venture / legacy rooms with no live robot croupier).
  // They delegate to the SAME settle/open implementation the auto-croupier runs,
  // with no phaseDeadline — the house clicks NEW ROUND rather than a timer.

  const spin = (): void => {
    // Manual settle from betting OR a stranded 'closing' (rescues a table the
    // auto-croupier left mid-spin when its operator dropped off — the button is
    // only shown once the heartbeat goes stale, so there is no double-settle).
    if (!deps.isHouse() || (phase() !== 'betting' && phase() !== 'closing')) return;
    rollAndSettle(deps.itemId, round());
  };

  const newRound = (): void => {
    if (!deps.isHouse() || phase() !== 'settled') return;
    openBetting(deps.itemId, round() + 1);
  };

  // ── Wheel drawing ──────────────────────────────────────────────────────────

  const WHEEL_CSS = 200, WHEEL_RES = 400;

  const drawWheel = (rotation: number): void => {
    if (!wheelCanvas) return;
    const ctx = wheelCanvas.getContext('2d');
    if (!ctx) return;
    const S = WHEEL_RES, C = S / 2, R = S / 2 - 14;
    ctx.clearRect(0, 0, S, S);
    const seg = (Math.PI * 2) / WHEEL_ORDER.length;
    for (let i = 0; i < WHEEL_ORDER.length; i++) {
      // Pocket i is CENTERED at rotation + i·seg, measured from the top.
      const a0 = -Math.PI / 2 + rotation + i * seg - seg / 2;
      const col = pocketColor(WHEEL_ORDER[i]);
      ctx.beginPath();
      ctx.moveTo(C, C);
      ctx.arc(C, C, R, a0, a0 + seg);
      ctx.closePath();
      ctx.fillStyle = col === 'green' ? RL_GREEN : col === 'red' ? RL_RED : RL_BLACK;
      ctx.fill();
      ctx.strokeStyle = 'rgba(212,168,75,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Number label near the rim, upright along the pocket's spoke.
      const mid = a0 + seg / 2;
      ctx.save();
      ctx.translate(C + Math.cos(mid) * (R - 22), C + Math.sin(mid) * (R - 22));
      ctx.rotate(mid + Math.PI / 2);
      ctx.fillStyle = '#F5EFDF';
      ctx.font = 'bold 15px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(WHEEL_ORDER[i]), 0, 0);
      ctx.restore();
    }
    // Hub + rim + top pointer.
    ctx.beginPath(); ctx.arc(C, C, 52, 0, Math.PI * 2);
    ctx.fillStyle = '#4A2F1B'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#D4A84B'; ctx.stroke();
    ctx.beginPath(); ctx.arc(C, C, R + 6, 0, Math.PI * 2);
    ctx.lineWidth = 6; ctx.strokeStyle = '#D4A84B'; ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(C - 12, 2); ctx.lineTo(C + 12, 2); ctx.lineTo(C, 26);
    ctx.closePath();
    ctx.fillStyle = '#F0C060'; ctx.fill();
  };

  /** Wheel rotation that parks `result`'s pocket under the top pointer. */
  const restingRotation = (result: number): number => {
    const idx = Math.max(0, WHEEL_ORDER.indexOf(result));
    return -idx * ((Math.PI * 2) / WHEEL_ORDER.length);
  };

  const drawWheelForNow = (): void => {
    const s = state();
    if (animT !== null && s?.result !== null && s !== null) {
      const ease = 1 - Math.pow(1 - animT, 3); // cubic ease-out
      drawWheel(ease * (Math.PI * 2 * 5 + restingRotation(s.result!)));
    } else {
      drawWheel(s?.phase === 'settled' && s.result !== null ? restingRotation(s.result) : 0);
    }
  };

  // ── Board drawing + clicks ─────────────────────────────────────────────────

  const drawBoard = (): void => {
    if (!boardCanvas) return;
    const ctx = boardCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0); // backing 2x, draw in CSS units
    ctx.clearRect(0, 0, RL_BOARD_W, RL_BOARD_H);
    ctx.fillStyle = '#14532D';
    ctx.fillRect(0, 0, RL_BOARD_W, RL_BOARD_H);
    // 🪙 Physical chips as placed: every bet record is ONE chip of its
    // denomination — the felt shows the actual chips (mine bright, other
    // players' dimmed), never a numeric total. Count them.
    const keyOf = (b: { type: string; pick?: number }) => `${b.type}:${b.pick ?? ''}`;
    const mineChips = new Map<string, number[]>();
    for (const b of myBets()) {
      const k = keyOf(b);
      mineChips.set(k, [...(mineChips.get(k) ?? []), b.amount]);
    }
    const otherChips = new Map<string, number[]>();
    for (const [pid, list] of Object.entries(readAllBets(deps.itemId, round()))) {
      if (pid === myId) continue;
      for (const b of list) {
        const k = keyOf(b);
        otherChips.set(k, [...(otherChips.get(k) ?? []), b.amount]);
      }
    }
    const winning = state()?.phase === 'settled' && animT === null ? state()!.result : null;
    for (const rg of regions) {
      ctx.fillStyle = rg.fill ?? '#1B6B3A';
      ctx.fillRect(rg.x, rg.y, rg.w, rg.h);
      // Winning straight cell flares gold once the wheel has landed.
      if (winning !== null && rg.bet.type === 'straight' && rg.bet.pick === winning) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = '#F0C060';
        ctx.strokeRect(rg.x + 2, rg.y + 2, rg.w - 4, rg.h - 4);
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(240, 224, 180, 0.75)';
        ctx.strokeRect(rg.x, rg.y, rg.w, rg.h);
      }
      ctx.fillStyle = '#F5EFDF';
      ctx.font = `bold ${rg.bet.type === 'straight' && rg.bet.pick !== 0 ? 13 : 11}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(rg.label, rg.x + rg.w / 2, rg.y + rg.h / 2);
      // The region's physical chips: others left (dim), mine right (bright).
      const theirs = otherChips.get(keyOf(rg.bet));
      if (theirs) drawFeltStack(ctx, theirs, rg.x + 2, rg.y + rg.h - 2, true);
      const placed = mineChips.get(keyOf(rg.bet));
      if (placed) {
        const cols = Math.ceil(placed.length / 8);
        drawFeltStack(ctx, placed, rg.x + rg.w - 2 - cols * 17, rg.y + rg.h - 2, false);
      }
    }
  };

  const onBoardClick = (e: MouseEvent): void => {
    if (!boardCanvas) return;
    const rect = boardCanvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * RL_BOARD_W;
    const y = ((e.clientY - rect.top) / rect.height) * RL_BOARD_H;
    const hit = regions.find((rg) => x >= rg.x && x < rg.x + rg.w && y >= rg.y && y < rg.y + rg.h);
    if (hit) placeBet(hit.bet);
  };

  // ── Panel ──────────────────────────────────────────────────────────────────

  /** The status line + colour for the current instant. Recomputed each frame by
   *  update(dt) so the auto-croupier's betting countdown ticks live (the doc
   *  only changes at phase edges). */
  const computeStatus = (): { line: string; color: string } => {
    const s = state();
    const p = phase();
    const staked = myBets().reduce((sum, b) => sum + b.amount, 0);
    // 'No more bets' the instant betting is closed — either the synced 'closing'
    // phase OR the local deadline already passed (before the operator's write).
    if (animT !== null || p === 'closing'
        || (p === 'betting' && s?.phaseDeadline != null && Date.now() >= s.phaseDeadline)) {
      return { line: 'NO MORE BETS — THE WHEEL SPINS…', color: CH_PINK };
    }
    if (p === 'settled' && s?.result != null) {
      // 🪙 Physical-chips rule: the win shows as CHIPS (the YOUR WIN tray),
      // never as a number — the pocket label is the wheel's, not money.
      const won = s.payouts?.[myId] ?? 0;
      const col = pocketColor(s.result).toUpperCase();
      const line = `● ${s.result} ${col}` + (staked > 0 || won > 0
        ? (won > 0 ? ' — YOU WIN' : ' — NO WIN THIS TIME')
        : '');
      return { line, color: won > 0 ? '#00E676' : GT_GOLD_BRIGHT };
    }
    const chips = readChips(myId);
    const remain = s?.phaseDeadline != null
      ? Math.max(0, Math.ceil((s.phaseDeadline - Date.now()) / 1000))
      : null;
    const line = `ROUND ${round()} — PLACE YOUR BETS`
      + (remain != null ? ` · ${remain}s` : '')
      + (chips <= 0 && staked === 0 ? ' · VISIT THE CASHIER FOR CHIPS' : '');
    return { line, color: GT_GOLD_BRIGHT };
  };

  /** Cheap per-frame refresh of just the status text (no full re-render). */
  const syncStatusEl = (): void => {
    const el = panel?.querySelector<HTMLDivElement>('#rl-status');
    if (!el) return;
    const { line, color } = computeStatus();
    el.textContent = line;
    el.style.color = color;
  };

  const render = (): void => {
    if (!panel) return;
    const s = state();
    const p = phase();
    const chips = readChips(myId);
    const bets = myBets();
    const house = deps.isHouse();
    const spinning = animT !== null;
    // 🤖 #77B: a live robot croupier drives the timer + hides the manual house
    // controls; without one (venture / legacy rooms), the house buttons stand.
    const autoRun = isCroupierLive(deps.itemId);
    const { line: statusLine, color: statusColor } = computeStatus();

    const btn = (id: string, label: string, disabled: boolean, title = ''): string => `
      <button id="${id}" ${disabled ? 'disabled' : ''} title="${title}" style="
        padding: 6px 10px;
        background: rgba(212, 168, 75, ${disabled ? '0.04' : '0.10'});
        border: 1px solid rgba(212, 168, 75, ${disabled ? '0.18' : '0.45'});
        border-radius: 6px; color: ${disabled ? GT_DIM : GT_GOLD_BRIGHT};
        font-family: inherit; font-size: 10px; font-weight: 800; letter-spacing: 1.5px;
        cursor: ${disabled ? 'not-allowed' : 'pointer'}; opacity: ${disabled ? '0.5' : '1'};
      ">${label}</button>`;

    const denomBtn = (n: number): string => `
      <button data-denom="${n}" style="
        width: 44px; height: 30px; border-radius: 15px;
        background: ${denom === n ? 'rgba(240,192,96,0.28)' : 'rgba(212,168,75,0.07)'};
        border: 2px solid ${denom === n ? '#F0C060' : 'rgba(212,168,75,0.35)'};
        color: ${denom === n ? '#F0C060' : CH_GOLD};
        font-family: inherit; font-size: 10px; font-weight: 800; cursor: pointer;
      ">${n}</button>`;


    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; border-bottom:1px solid rgba(212,168,75,0.18); padding-bottom:8px;">
        <span style="font-size:12px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1px;">🎡 ROULETTE</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      <div id="rl-status" style="font-size:11px; font-weight:800; letter-spacing:1px; color:${statusColor};">${statusLine}</div>
      ${flash ? `<div style="font-size:10px; font-weight:800; color:#FF8A80; letter-spacing:1px;">${flash}</div>` : ''}
      <div style="display:flex; gap:14px; align-items:center;">
        <canvas id="rl-wheel" width="${WHEEL_RES}" height="${WHEEL_RES}"
          style="width:${WHEEL_CSS}px; height:${WHEEL_CSS}px; flex:none;"></canvas>
        <div style="display:flex; flex-direction:column; gap:6px; min-width:0; flex:1;">
          <div style="font-size:10px; color:${GT_DIM}; letter-spacing:1.5px;">YOUR CHIPS — COUNT THEM</div>
          <canvas id="rl-rack" width="380" height="132" style="width:190px; height:66px;"></canvas>
          <div style="font-size:10px; color:${GT_DIM}; letter-spacing:1.5px;">ON THE FELT</div>
          <canvas id="rl-felt-rack" width="380" height="88" style="width:190px; height:44px;"></canvas>
          ${p === 'settled' && !spinning && (s?.payouts?.[myId] ?? 0) > 0 ? `
          <div style="font-size:10px; color:#00E676; letter-spacing:1.5px;">YOUR WIN</div>
          <canvas id="rl-won" width="380" height="88" style="width:190px; height:44px;"></canvas>` : ''}
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:10px; color:${GT_DIM}; letter-spacing:1.5px;">CHIP:</span>
        ${[1, 5, 25, 100].map(denomBtn).join('')}
        <span style="flex:1;"></span>
        ${btn('rl-undo', 'UNDO', !bettingOpen() || spinning || bets.length === 0, 'Take back the last chip')}
        ${btn('rl-clear', 'CLEAR', !bettingOpen() || spinning || bets.length === 0, 'Take back all your chips')}
      </div>
      <canvas id="rl-board" width="${RL_BOARD_W * 2}" height="${RL_BOARD_H * 2}"
        style="width:${RL_BOARD_W}px; height:${RL_BOARD_H}px; align-self:center; border:1px solid rgba(212,168,75,0.35); border-radius:6px; cursor:${bettingOpen() && !spinning ? 'pointer' : 'default'};"></canvas>
      <div style="display:flex; gap:8px; justify-content:flex-end; align-items:center;">
        ${autoRun
          ? `<span style="font-size:9.5px; color:${CH_GOLD};">🤖 THE ROBO-CROUPIER RUNS THIS TABLE</span>`
          : house
          ? (p === 'settled'
            ? btn('rl-new-round', 'NEW ROUND', spinning, 'Open the felt for the next round')
            : btn('rl-spin', '🎡 SPIN', spinning, 'Close betting and spin the wheel'))
          : `<span style="font-size:9.5px; color:${GT_DIM};">${p === 'settled' && !spinning ? 'WAITING FOR THE CROUPIER TO OPEN THE NEXT ROUND' : 'THE HOUSE SPINS WHEN BETS ARE DOWN'}</span>`}
      </div>
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px; line-height:1.6;">
        SINGLE-ZERO WHEEL · straight pays 35:1 · dozens &amp; columns 2:1 · red/black odd/even 1–18/19–36 1:1
        · house-banked, the croupier's spin settles the round · fair-spin upgrade coming
        · chips are physical at the table — count them; the CASHIER's screen shows the number
      </div>
    `;
    panel.querySelectorAll<HTMLButtonElement>('[data-denom]').forEach((b) => {
      b.addEventListener('click', () => { denom = Number(b.dataset.denom); render(); });
    });
    panel.querySelector<HTMLButtonElement>('#rl-undo')?.addEventListener('click', () => undoBet());
    panel.querySelector<HTMLButtonElement>('#rl-clear')?.addEventListener('click', () => clearBets());
    panel.querySelector<HTMLButtonElement>('#rl-spin')?.addEventListener('click', () => { spin(); });
    panel.querySelector<HTMLButtonElement>('#rl-new-round')?.addEventListener('click', () => newRound());
    wheelCanvas = panel.querySelector<HTMLCanvasElement>('#rl-wheel');
    boardCanvas = panel.querySelector<HTMLCanvasElement>('#rl-board');
    boardCanvas?.addEventListener('click', onBoardClick);
    flash = '';
    drawWheelForNow();
    drawBoard();
    // 🪙 The physical trays (2x backing): rack = full balance decomposed;
    // felt tray = the exact chips placed this round; win tray = the payout.
    const paintTray = (id: string, tray: number[], cssW: number, cssH: number, emptyText?: string) => {
      const cv = panel!.querySelector<HTMLCanvasElement>(`#${id}`);
      const c2 = cv?.getContext('2d');
      if (!cv || !c2) return;
      c2.setTransform(2, 0, 0, 2, 0, 0);
      c2.clearRect(0, 0, cssW, cssH);
      drawChips(c2, tray, 0, 0, cssW, cssH, { emptyText });
    };
    paintTray('rl-rack', chipsFor(chips), 190, 66, 'NO CHIPS — VISIT THE CASHIER');
    paintTray('rl-felt-rack', bets.map((b) => b.amount), 190, 44, 'NOTHING STAKED');
    if (p === 'settled' && !spinning) {
      paintTray('rl-won', chipsFor(s?.payouts?.[myId] ?? 0), 190, 44);
    }
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-roulette-pane';
      panel.style.cssText = `
        position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
        width: 430px; max-height: 94vh; overflow-y: auto;
        background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
        border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
        padding: 18px; display: flex; flex-direction: column; gap: 12px;
        color: ${GT_GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing: border-box; pointer-events: auto;
      `;
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      // Never replay a spin that landed before we walked up.
      const s = state();
      animRound = s?.phase === 'settled' ? s.round : 0;
      animT = null;
      unsubscribe = subscribeCasino(() => {
        // A fresh settle write starts the wheel; everything else just repaints.
        const cur = state();
        if (cur?.phase === 'settled' && cur.round > animRound) {
          animRound = cur.round;
          animT = 0;
        }
        render();
      });
      render();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      panel?.remove();
      panel = null;
      wheelCanvas = null;
      boardCanvas = null;
    },
    update(dt: number): void {
      // 🤖 #77B: tick the auto-croupier's betting/closing countdown live — the
      // doc only changes at phase edges, so the seconds are refreshed here.
      const s = state();
      if (animT === null && s?.phaseDeadline != null && s.phase !== 'settled') {
        syncStatusEl();
      }
      if (animT === null) return;
      animT = Math.min(1, animT + Math.max(0, dt) / RL_SPIN_SECS);
      if (animT >= 1) {
        animT = null;
        render(); // reveal the result banner + winning cell + settled balances
      } else {
        drawWheelForNow();
      }
    },
  };
}
