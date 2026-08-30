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
import {
  readAllDoorLayout, doorOrdinals, doorDisplayName, defaultDoorLayoutRecords,
} from './doorLayoutDoc';
import { physicalDoorPose, DOOR_OPENING_WIDTH } from './doorLayout';
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
// ♠♥♦♣ #45 P3 card felt — three games share the flippable table's card face.
import {
  initialWarState, beginWar, playWarRound,
} from './games/war';
import type { WarSeat, WarState } from './games/war';
import {
  initialSolitaireState, dealSolitaire, applySolitaireMove, legalSolitaireMoves,
  setSolitaireDrawMode,
} from './games/solitaire';
import type { SolitaireMove, SolitaireState, SolitaireDrawMode } from './games/solitaire';
import {
  initialPokerState, beginPoker, applyPokerAction, callAmount, legalActions,
  minBet, minRaiseTo, nextHand, chooseBotAction, readVisiblePokerState,
  pokerForfeit as pokerForfeitState,
} from './games/poker';
import type { PokerSeat, PokerState } from './games/poker';
import {
  isRed, randomSeed, rankOf, suitOf, RANK_GLYPH, SUIT_GLYPH,
} from './games/cards';
import type { Card } from './games/cards';
import { getPlayerId } from './identity';
// 🎰 #69 G1/G2: chips + the cage ledger + roulette table state (casino map).
import {
  readChips, buyInChips, cashOutChips, spendChips, creditChips,
  readCageLedger, readTableState,
  readMyBets, writeMyBets, readAllBets, subscribeCasino,
  readCrapsTableState, readMyCrapsBets, writeMyCrapsBets, readAllCrapsBets,
  readCrapsBackendPref, writeCrapsBackendPref,
  readCrapsFairnessPref, writeCrapsFairnessPref,
  casinoDocEpoch,
  clearSlotPlayRequest,
  readSlotMachineState, readSlotOddsConfig, readSlotReveal,
  writeSlotPlayRequest, writeSlotReveal,
  readSlotFundingConfig, writeSlotFundingConfig, readSlotFundingBalance,
  depositSlotFunding, withdrawSlotFunding, writeSlotOddsConfig,
  // 🃏🎰 #45 wager slice — poker/war chip-escrow operations.
  stampCardWagerConfig, readCardWagerConfig, payCardWager,
  readCardWagerEscrow, scanCardWagerEscrow, activateCardWager,
  settleCardWager, refundCardWager, clearCardWagerKeys,
  readCardWagerAck, ackCardWagerResult, readAgreedCardWagerResult,
} from './casinoDoc';
// 🃏🎰 #45 wager slice — buy-in bounds for UI clamps, the per-kind floor,
// and the shared heads-up result derivation (ack default + settle trigger).
import {
  MAX_CARD_WAGER_BUY_IN, minCardWagerBuyIn, deriveHeadsUpWinner,
} from './games/cardWager';
// 🎲🔗 #69 G5 seam: the pluggable settlement backends (local / optional Chia) —
// the house-only toggle in the craps panel flips the per-table preference.
import { crapsBackend } from './crapsBackend';
// 🎲🔀 The dice-fairness modes (rng / commit-reveal / multiparty / block-beacon) —
// a house-only cycle button flips the per-table mode; settled rolls show a
// verifiable "provably fair" badge.
import {
  FAIRNESS_MODES, getCrapsFairnessMode, verifyTranscript,
} from './games/diceFairness';
import type { FairnessMode } from './games/craps';
import {
  WHEEL_ORDER, pocketColor,
} from './games/roulette';
import type { RouletteBet, RouletteTableState } from './games/roulette';
// 🎲 #69 G3: the craps engine (pure payout math) + its table state.
import { canPlaceBet } from './games/craps';
import type { CrapsBet, CrapsTableState } from './games/craps';
import {
  DEFAULT_PAYTABLE, MAX_SLOT_MULTIPLIER, SLOT_REQUEST_TTL_MS,
  commitSlotSeed, computeRTP, hashSlotPaytable, isSlotOddsConfig, randomSlotSeed,
} from './games/slots';
import type { SlotFundingConfig, SlotPayEntry } from './games/slots';
// 🎰🤖 #77B: the auto-croupier's shared settle/open helpers (the manual SPIN /
// NEW ROUND buttons delegate to the same implementation) + operator liveness.
import { canRunCroupier, rollAndSettle, openBetting, isCroupierLive } from './croupier';
import {
  isManualSlotMachineRunning,
  setManualSlotMachineRunning,
} from './slotCroupier';
// 🎲🤖 #69 G3: the auto-stickman's shared settle/open helpers (manual ROLL /
// NEXT ROLL delegate to the same implementation).
import { rollAndSettleCraps, openCrapsBetting } from './crapsCroupier';
// 🤖 #77C s3: per-dock robot routine config (the programming console).
import {
  readRobotConfig, writeRobotConfig, subscribeRobot,
  ROBOT_ROUTINES, ROUTINE_LABELS, MAX_SCRIPT_STEPS,
} from './robotDoc';
import type { RobotRoutine, RobotStep } from './robotDoc';
import { isRobotVoiceEnabled, setRobotVoiceEnabled } from './robotVoice';
// 🪙 Physical chips (owner request): outside the cashier, balances render as
// countable chip stacks — never as a number. One renderer enforces the rule.
import { chipsFor, drawChips, drawFeltStack } from './chipDisplay';

// ── Core interfaces (plan §D0.2) ──────────────────────────────────────────────

export type DeviceKind = 'roomTerminal' | 'deskComputer' | 'mapTable' | 'storageTrunk' | 'gameTable' | 'helm' | 'cashier' | 'roulette' | 'craps' | 'cloneVat' | 'robotDock' | 'slotMachine';

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

/** In-world slot reels driven from shared machine state for nearby spectators. */
export interface SlotMachineVisualHandle {
  /** Advance drum rotation and reel-face scrolling from World.update. */
  update(deltaTime: number): void;
  /** Reflect the local player's selected chip denomination on the cabinet. */
  setDenomination(amount: number): void;
  /** Show immediate local feedback until the next machine-state transition. */
  showMessage(message: string): void;
  /** Animate the physical axle/arm through one pull-and-return cycle. */
  pullLever(): void;
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

/**
 * 🧭 The wireframe view's door ports, derived LIVE from the room's real door
 * set — id, pose and all. This retired a hard-coded four-cardinal table with
 * N/S/W/E captions (and pre-#91 widths): the room can have any number of
 * doors anywhere now, and compass letters are meaningless once modules render
 * at angles — ports are captioned with the same DOOR NUMBERS every other
 * surface speaks (doorOrdinals), or the door's authored label initial.
 */
function livePortView(): Array<{
  id: string; x: number; z: number; w: number; horizontal: boolean; label: string;
}> {
  // The SAME folded fallback every other surface uses (fold review F3): a
  // synthesized lateral-0 set numbered differently from doorDisplayName's,
  // so the wireframe's captions could disagree with the pane's names.
  const stored = readAllDoorLayout();
  const doors = stored.size
    ? [...stored.values()]
    : [...defaultDoorLayoutRecords().values()];
  const ordinals = doorOrdinals(doors);
  return doors.map((d) => {
    const pose = physicalDoorPose(d.id);
    return {
      id: d.id,
      x: pose.x,
      z: pose.z,
      w: DOOR_OPENING_WIDTH,
      horizontal: pose.wall === 'y-' || pose.wall === 'y+',
      label: String(ordinals.get(d.id) ?? '?'),
    };
  });
}

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
      const paired = livePortView()
        .filter((p) => deps.dockingSystem?.getDockingState(p.id)?.pairedSuccessfully)
        .map((p) => doorDisplayName(p.id));
      adjEl.textContent = paired.length
        ? `${paired.join(', ')} PAIRED — NO ADJACENT MODULE DATA`
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
    for (const port of livePortView()) {
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

  /** RESET gate for EITHER board-game kind (mirror of canReset's reasoning). */
  const canClearTable = (): boolean => {
    const t = readTable(deps.itemId);
    if (!t) return false;
    if (t.kind === 'checkers') return canReset(t.state);
    if (t.kind === 'chess') {
      const s = t.state;
      if (s.status !== 'waiting' && s.status !== 'playing') return true;
      if (s.bot) return true;
      if (s.status === 'waiting') return true;
      return myChessSeat(s) !== null || readRoomOwner() === myId;
    }
    if (t.kind === 'war') {
      const s = t.state;
      if (s.status === 'left-won' || s.status === 'right-won') return true;
      if (s.bot) return true;
      if (s.status === 'waiting') return true;
      return myWarSeat(s) !== null || readRoomOwner() === myId;
    }
    if (t.kind === 'solitaire') {
      const s = t.state;
      if (s.status === 'won') return true;
      if (s.player === null) return true;
      return s.player === myId || readRoomOwner() === myId;
    }
    if (t.kind === 'poker') {
      const s = t.state;
      if (s.status === 'match-over') return true;
      if (s.bot) return true;
      if (s.status === 'waiting') return true;
      return myPokerSeat(s) !== null || readRoomOwner() === myId;
    }
    return false;
  };

  /** Clear the table back to the GAME PICKER (both kinds — lets players
   *  switch games; the whole-value LWW caveat from reset() applies). */
  const clearToPicker = (): void => {
    if (!canClearTable()) return;
    // 🃏🎰 #45 wager slice — a RESET while a wager is active leaves chips
    // stranded in escrow. Refund every held record we can before clearing
    // the table, and (owner-only) wipe the wager config keys. This mirrors
    // the air-hockey escrow-safety discipline on table removal (PR #116).
    const t = readTable(deps.itemId);
    const wagerCfg = readCardWagerConfig(deps.itemId);
    if (wagerCfg && t?.kind === 'poker') {
      // Refund every seat's held record — self-refund works pre-BEGIN;
      // owner-refund works at any stage. refundCardWager is idempotent
      // (missing record returns false without any side effect).
      const seats = [t.state.players.button.id, t.state.players.bigBlind.id];
      for (const pid of seats) {
        if (pid) refundCardWager(myId, deps.itemId, pid);
      }
      // Owner: also wipe the config so the reset is complete. Non-owner
      // reset leaves the config in place — the owner returns to their
      // stranded wager later. (Owner can also cancel from the wager panel.)
      if (myId === wagerCfg.ownerId) clearCardWagerKeys(myId, deps.itemId);
    }
    selected = null;
    chessSelected = null;
    pokerLastSettledAt = null;
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

  // ── ♠♥♦♣ Card felt (#45 P3) — WAR, SOLITAIRE, TWO-PLAYER POKER ────────────
  // The flippable table's card face carries three games sharing one Y-map key
  // (only one kind lives on the table at a time; RESET returns to the picker).
  // Card canvases are separate from the board canvas — each game draws its
  // own layout onto the same DOM slot when the felt is up.

  let cardCanvas: HTMLCanvasElement | null = null;
  // Local UI state (never written to the doc):
  let warBotTimer = 0;
  let pokerBotTimer = 0;
  /** Solitaire click-to-move source: { kind: 'waste' } | { kind: 'foundation'; suit } |
   *  { kind: 'tableau'; pile; index } — null when nothing selected. */
  let solitaireSource: SolitaireClickSource | null = null;
  /** Poker bet-size input value (text) — parsed to int on Bet/Raise. */
  let pokerBetInput = '';
  /** 🃏🎰 #45 wager slice — WAGER MODE buy-in draft (owner-only, pre-stamp).
   *  Empty string until the owner types a buy-in; committed to a config
   *  on the "🎰 ENABLE WAGER" button; then the config becomes the source
   *  of truth and this draft is only used pre-commit. */
  let pokerWagerDraft = '';
  /** Guard: once we've observed match-over and settled once, don't settle
   *  again on subsequent re-renders (the config delete is the primary guard
   *  but the flag prevents even calling the refused-second-settle path). */
  let pokerLastSettledAt: string | null = null;

  // ── WAR helpers ─────────────────────────────────────────────────────────────

  const myWarSeat = (s: WarState): WarSeat | null =>
    s.players.left === myId ? 'left' : s.players.right === myId ? 'right' : null;

  const warSeatLabel = (s: WarState, seat: WarSeat): string => {
    if (seat === 'right' && s.bot) return 'BOT';
    const id = s.players[seat];
    if (!id) return 'OPEN';
    const name = readPlayerDisplayName(id).toUpperCase();
    return id === myId ? `${name} (YOU)` : name;
  };

  const warStatusText = (s: WarState): string => {
    if (s.status === 'waiting') return 'WAITING FOR PLAYERS — SIT DOWN AT LEFT OR RIGHT';
    if (s.status === 'left-won') return `▲ LEFT WINS — ${warSeatLabel(s, 'left')}`;
    if (s.status === 'right-won') return `▲ RIGHT WINS — ${warSeatLabel(s, 'right')}`;
    const lc = s.leftDeck.length; const rc = s.rightDeck.length;
    const war = s.lastRound && s.lastRound.warDepth > 0 ? ` · WAR×${s.lastRound.warDepth}` : '';
    return `L:${lc} · R:${rc}${war}`;
  };

  const claimWarSeat = (seat: WarSeat): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'war') return;
    const s = t.state;
    if (s.status !== 'waiting') return;
    if (s.players[seat] !== null) return;
    const other = seat === 'left' ? 'right' : 'left';
    if (s.players[other] === myId) return; // one seat per player
    if (s.bot && seat === 'right') return; // bot holds right
    const players = { ...s.players, [seat]: myId };
    const bothSeated = players.left && players.right;
    writeGame(deps.itemId, bothSeated
      ? beginWar({ ...s, players })
      : { ...s, players });
  };

  const startWarBot = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'war') return;
    const s = t.state;
    if (s.status !== 'waiting' || s.players.right !== null) return;
    if (s.players.left !== null && s.players.left !== myId) return;
    writeGame(deps.itemId, beginWar({
      ...s,
      players: { ...s.players, left: myId },
      bot: true,
    }));
  };

  const warForfeit = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'war' || t.state.status !== 'playing') return;
    const seat = myWarSeat(t.state);
    if (!seat) return;
    writeGame(deps.itemId, {
      ...t.state,
      status: seat === 'left' ? 'right-won' : 'left-won',
    });
  };

  const warPlayRound = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'war' || t.state.status !== 'playing') return;
    // Either seat may click PLAY (deterministic engine — race collapses to
    // one identical successor state under LWW). Spectators can't play.
    if (myWarSeat(t.state) === null && !t.state.bot) return;
    writeGame(deps.itemId, playWarRound(t.state));
  };

  // ── SOLITAIRE helpers (single-player) ───────────────────────────────────────

  type SolitaireClickSource =
    | { kind: 'waste' }
    | { kind: 'foundation'; suit: number }
    | { kind: 'tableau'; pile: number; index: number };

  const mySolitairePlayer = (s: SolitaireState): boolean => s.player === myId;

  const solitaireStatusText = (s: SolitaireState): string => {
    if (s.status === 'waiting') return 'WAITING — CLAIM THE SEAT AND DEAL';
    if (s.status === 'won') return '★ SOLVED — CLICK RESET FOR A FRESH DEAL';
    return `MOVES: ${s.moves} · REDEALS: ${s.redeals}`;
  };

  const claimSolitaireSeat = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'solitaire') return;
    const s = t.state;
    if (s.status !== 'waiting') return;
    if (s.player !== null && s.player !== myId) return;
    writeGame(deps.itemId, dealSolitaire({ ...s, player: myId }));
  };

  const doSolitaireMove = (move: SolitaireMove): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'solitaire') return;
    if (!mySolitairePlayer(t.state)) return;
    const next = applySolitaireMove(t.state, move);
    if (next === t.state) return; // illegal — no doc write
    writeGame(deps.itemId, next);
  };

  // Draw-mode setter: only valid while the felt is in 'waiting' status
  // (before the first deal). setSolitaireDrawMode returns the same state
  // reference when the change is illegal, so the guard below skips the
  // pointless doc write. Enables the round-3 turn-3 draw mode alongside the
  // classic draw-1 (games-plan.md marks Klondike as single-player, so the
  // player is free to pick their variant per-session).
  const doSetSolitaireDrawMode = (drawMode: SolitaireDrawMode): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'solitaire') return;
    const next = setSolitaireDrawMode(t.state, drawMode);
    if (next === t.state) return;
    writeGame(deps.itemId, next);
  };

  // Undo helper: applies a bounded-history 'undo' move (see solitaire.ts
  // MAX_UNDO_HISTORY). Silent no-op when history is empty — the UI gates
  // the button on undoHistory.length > 0 so this rarely fires spuriously.
  const doSolitaireUndo = (): void => {
    doSolitaireMove({ type: 'undo' });
  };

  // ── POKER helpers (2-player NL Hold'em) ─────────────────────────────────────

  const myPokerSeat = (s: PokerState): PokerSeat | null =>
    s.players.button.id === myId ? 'button'
      : s.players.bigBlind.id === myId ? 'bigBlind' : null;

  const myPokerTurn = (s: PokerState): boolean => {
    const seat = myPokerSeat(s);
    return s.status === 'playing' && seat !== null && s.toAct === seat;
  };

  const pokerSeatLabel = (s: PokerState, seat: PokerSeat): string => {
    // The BOT identity travels with a `null` id (see poker.ts:172 comment
    // "a seat with a null id is a BOT"). Pre-round-3 this label hard-coded
    // `bigBlind` as the bot seat — correct only for hand #1, since dealHand
    // rotates the button/BB assignment on hand ≥ 2 (poker.ts:201). After
    // rotation the human's seat still showed their name, but the bot's seat
    // (now BUTTON) was displayed as OPEN — the pump kept firing because
    // dealHand only rotates the assignment, not the underlying id, but the
    // UI became a lie.
    const id = s.players[seat].id;
    if (id === null && s.bot) return 'BOT';
    if (!id) return 'OPEN';
    const name = readPlayerDisplayName(id).toUpperCase();
    return id === myId ? `${name} (YOU)` : name;
  };

  const pokerStatusText = (s: PokerState): string => {
    if (s.status === 'waiting') return 'WAITING FOR PLAYERS — SIT AT BUTTON OR BIG BLIND';
    if (s.status === 'match-over') return `▲ MATCH OVER — ${
      s.players.button.stack > 0 ? pokerSeatLabel(s, 'button') : pokerSeatLabel(s, 'bigBlind')
    } TAKES THE STACK`;
    if (s.status === 'hand-over') {
      const w = s.lastShowdown?.winner;
      if (w === 'split') return `HAND OVER — SPLIT POT (${s.lastShowdown?.pot ?? 0})`;
      if (w) return `HAND OVER — ${pokerSeatLabel(s, w).toUpperCase()} WINS (${s.lastShowdown?.pot ?? 0})`;
      return 'HAND OVER';
    }
    const streetLabel = s.street.toUpperCase();
    const toAct = s.toAct ? ` · ${s.toAct === 'button' ? 'BUTTON' : 'BB'} TO ACT` : '';
    const yours = myPokerTurn(s) ? ' — YOUR TURN' : '';
    return `${streetLabel} · POT ${s.pot}${toAct}${yours}`;
  };

  const claimPokerSeat = (seat: PokerSeat): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker') return;
    const s = t.state;
    if (s.status !== 'waiting') return;
    if (s.players[seat].id !== null) return;
    const other = seat === 'button' ? 'bigBlind' : 'button';
    if (s.players[other].id === myId) return; // one seat per player
    if (s.bot && seat === 'bigBlind') return;
    // Claim only — the game starts when BOTH seats are claimed via BEGIN.
    const players = {
      button: { ...s.players.button },
      bigBlind: { ...s.players.bigBlind },
    };
    players[seat] = { ...players[seat], id: myId };
    writeGame(deps.itemId, { ...s, players });
  };

  const beginPokerMatch = (bot: boolean): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker') return;
    const s = t.state;
    if (s.status !== 'waiting') return;
    const buttonId = s.players.button.id ?? (bot ? myId : null);
    const bigBlindId = bot ? null : s.players.bigBlind.id;
    if (!bot && (!buttonId || !bigBlindId)) return;
    if (bot && buttonId !== myId) return; // solo start: I sit at button
    // 🃏🎰 #45 WAGER MODE: if this table has an active wager config, both
    // seats must have paid their buy-in, the wager owner (only) starts the
    // match by ACTIVATING the wager (stamps startedAt → locks self-refund)
    // and the buy-in becomes the STARTING STACK. Free-play (no config) is
    // bit-identical to today's path (startingStack: 1000).
    const wager = readCardWagerConfig(deps.itemId);
    let startingStack = 1000;
    if (wager) {
      // Kind-table binding + engine-floor guard: a 'war' config planted on
      // the poker felt (peer write; stamp can't produce it through this UI)
      // must not gate-keep or fund a poker match, and a legacy config under
      // the 20-chip floor would seat stacks LARGER than the escrow
      // (beginPoker clamps up to 2×bigBlind). Both refuse the start; the
      // owner cancels/re-stamps a conforming wager instead.
      if (wager.kind !== 'poker' || wager.buyIn < minCardWagerBuyIn('poker')) return;
      // Wager mode disallows the trivial bot (there's no counter-party
      // paying in on the other seat). Owner must clear the wager first
      // if they want to play against the bot.
      if (bot) return;
      // Both seats must have paid.
      if (buttonId === null || bigBlindId === null) return;
      if (!readCardWagerEscrow(deps.itemId, buttonId)) return;
      if (!readCardWagerEscrow(deps.itemId, bigBlindId)) return;
      // Only the wager owner can start the match (single-writer for
      // startedAt stamp; matches settleCardWager's owner-only rule).
      if (myId !== wager.ownerId) return;
      if (!activateCardWager(myId, deps.itemId, Date.now())) return;
      startingStack = wager.buyIn;
    }
    writeGame(deps.itemId, beginPoker(s, {
      button: buttonId, bigBlind: bigBlindId, bot, startingStack,
    }));
  };

  /**
   * 🃏🎰 #45 wager slice — owner stamps a WAGER config for the poker
   * table. Refuses on non-integer or out-of-range buy-in; refuses when
   * a wager is already stamped by a different owner (single-writer for
   * the config key). Idempotent for the same owner (repeat calls are
   * fine; the stampCardWagerConfig helper accepts a same-owner update).
   */
  const enablePokerWager = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker' || t.state.status !== 'waiting') return;
    const buyIn = Number.parseInt(pokerWagerDraft, 10);
    // Poker floor is 20 (= 2×bigBlind), not the absolute 1 — the engine
    // posts blinds from the buy-in stack; stampCardWagerConfig enforces
    // the same floor doc-side, this refusal just keeps the UI honest.
    if (!Number.isInteger(buyIn) || buyIn < minCardWagerBuyIn('poker')
      || buyIn > MAX_CARD_WAGER_BUY_IN) return;
    stampCardWagerConfig(myId, deps.itemId, 'poker', buyIn, Date.now());
    pokerWagerDraft = '';
  };

  /**
   * 🃏🎰 #45 wager slice — I pay MY buy-in into escrow. Own-key write —
   * casinoDoc refuses when actor !== payer. Idempotent under crash-retry.
   */
  const payPokerWager = (): void => {
    payCardWager(myId, deps.itemId, myId, Date.now());
  };

  /**
   * 🃏🎰 #45 wager slice — cancel/refund path. Before BEGIN, any payer
   * can self-refund. The owner can refund BOTH players (abandonment) and
   * then clear the wager keys. Called from the "CANCEL WAGER" button.
   */
  const cancelPokerWager = (): void => {
    const wager = readCardWagerConfig(deps.itemId);
    if (!wager) return;
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker') return;
    // Refund by ESCROW RECORD, not by seat id — a hostile peer can raw-
    // write a seat id to null, and a seat-id loop would then SKIP that
    // player's held record while the owner-path clearCardWagerKeys below
    // deletes it, burning the payer's chips. Scanning the records refunds
    // every holder this actor may refund (self pre-BEGIN; owner any time —
    // refundCardWager enforces that matrix), whatever the seats claim.
    for (const r of scanCardWagerEscrow(deps.itemId)) {
      refundCardWager(myId, deps.itemId, r.playerId);
    }
    // Owner-only: wipe the config so the felt is back to free-play mode.
    if (myId === wager.ownerId) clearCardWagerKeys(myId, deps.itemId);
  };

  /**
   * 🃏🎰 #45 wager slice — owner settles once BOTH payers confirmed.
   * The winner is still derived deterministically from final stacks
   * (deriveHeadsUpWinner), but derivation alone trusts the shared
   * PokerState — a hostile peer can write a forged terminal state and
   * steer an HONEST owner into paying the pot to the wrong seat. The ack
   * gate closes that: `readAgreedCardWagerResult` returns non-null only
   * when both players who PAID escrow have countersigned an identical
   * result for THIS match (matchStartedAt echo), so a forged state
   * without the victim's signature sits unsettled until the owner
   * cancels & refunds via cancelPokerWager.
   *
   * NOT defended: a malicious OWNER — the owner is the doc's money
   * author by design; arbitrating the owner themselves is the
   * chia-gaming referee's job (issue #45), out of scope for this slice.
   *
   * Called from the poker-panel render pass. `pokerLastSettledAt` keys
   * on (table, matchStartedAt, result) so a re-render doesn't re-attempt
   * the same settlement while a fresh match settles cleanly; every
   * settle failure mode is a stable precondition (or active tampering),
   * so attempt-once-per-sig loses nothing — owner cancel is the valve.
   */
  const maybeSettleWager = (s: PokerState): void => {
    if (s.status !== 'match-over') return;
    const wager = readCardWagerConfig(deps.itemId);
    if (!wager) { pokerLastSettledAt = null; return; }
    if (wager.startedAt === null) return;
    if (myId !== wager.ownerId) return;
    // Ack gate: both payers must agree on one fresh result. Until then
    // there is nothing an honest owner is willing to pay out.
    const agreed = readAgreedCardWagerResult(deps.itemId);
    if (agreed === null) return;
    const sig = `${deps.itemId}:${wager.startedAt}:${agreed}`;
    if (pokerLastSettledAt === sig) return;
    pokerLastSettledAt = sig;
    settleCardWager(myId, deps.itemId, agreed);
  };

  /**
   * 🃏🎰 #45 ack slice — the local payer confirms the result they can SEE.
   * The confirmed value is engine-derived (deriveHeadsUpWinner over the
   * terminal stacks), never free-form: a pick-your-own-winner control
   * would let a griefing payer "confirm" a wrong result and wedge the
   * table into permanent dispute. Re-acking is allowed (own-key LWW
   * overwrite in ackCardWagerResult) so a stale ack self-heals if the
   * derived result changes under doc repair. A player who never confirms
   * can't be forced — the owner's CANCEL WAGER refunds both escrows, so
   * nobody's chips are hostage to a sulking loser.
   */
  const ackPokerResult = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker' || t.state.status !== 'match-over') return;
    const derived = deriveHeadsUpWinner(
      t.state.players.button, t.state.players.bigBlind);
    if (derived === null) return;
    ackCardWagerResult(myId, deps.itemId, derived, Date.now());
  };

  const pokerForfeit = (): void => {
    // In poker, "forfeit" means concede the current hand (fold if you can);
    // if the hand isn't yours to act, this is a no-op (the button already
    // handles that case via the FOLD action). This exists so a player who
    // rage-quits during a bot game can end the match cleanly. The transition
    // itself is a pure function in `games/poker.ts` (`pokerForfeitState`):
    //   · awards the live pot to the opponent (fold-equivalent) — the
    //     previous inline implementation forgot this step and left SB+BB
    //     chips stranded in the terminal state (audit finding #3),
    //   · transfers residual stack to the opponent,
    //   · sets match-over/complete and records `lastShowdown`.
    // Idempotent on non-playing states so a doc race between two writers
    // still converges cleanly via LWW.
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker' || t.state.status !== 'playing') return;
    const seat = myPokerSeat(t.state);
    if (!seat) return;
    writeGame(deps.itemId, pokerForfeitState(t.state, seat));
  };

  const doPokerAction = (kind: 'fold' | 'check' | 'call' | 'bet' | 'raise'): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker') return;
    const seat = myPokerSeat(t.state);
    if (!seat || !myPokerTurn(t.state)) return;
    if (kind === 'fold' || kind === 'check' || kind === 'call') {
      const next = applyPokerAction(t.state, { seat, kind });
      if (next !== t.state) writeGame(deps.itemId, next);
      return;
    }
    const amount = Number.parseInt(pokerBetInput, 10);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const next = applyPokerAction(t.state, { seat, kind, amount });
    if (next === t.state) return;
    pokerBetInput = '';
    writeGame(deps.itemId, next);
  };

  const advancePokerHand = (): void => {
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'poker') return;
    if (t.state.status !== 'hand-over') return;
    if (myPokerSeat(t.state) === null && !t.state.bot) return;
    // Rotate seed per hand for a fresh shuffle (deterministic per-peer).
    writeGame(deps.itemId, nextHand(t.state, (t.state.seed + 1) | 0 || randomSeed()));
  };

  // ── Card drawing primitives (shared across the three card games) ────────────

  const CARD_W = 44; // canvas px
  const CARD_H = 62;
  const CARD_GAP = 6;

  /** Paint a card face (or facedown back) at (x, y). Backing store units. */
  const paintCard = (
    ctx: CanvasRenderingContext2D, x: number, y: number, card: Card | null, faceUp: boolean,
  ): void => {
    ctx.save();
    ctx.fillStyle = '#F5EEDF';
    ctx.strokeStyle = '#1B1B22';
    ctx.lineWidth = 1.5;
    // Rounded rect body.
    const r = 6;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + CARD_W - r, y);
    ctx.quadraticCurveTo(x + CARD_W, y, x + CARD_W, y + r);
    ctx.lineTo(x + CARD_W, y + CARD_H - r);
    ctx.quadraticCurveTo(x + CARD_W, y + CARD_H, x + CARD_W - r, y + CARD_H);
    ctx.lineTo(x + r, y + CARD_H);
    ctx.quadraticCurveTo(x, y + CARD_H, x, y + CARD_H - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    if (faceUp && card !== null) {
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = isRed(card) ? '#C6162E' : '#151519';
      ctx.font = 'bold 14px "SF Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(RANK_GLYPH[rankOf(card)], x + 5, y + 4);
      ctx.font = '14px serif';
      ctx.fillText(SUIT_GLYPH[suitOf(card)], x + 5, y + 22);
      // Mirror in bottom-right for classic look.
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.font = 'bold 14px "SF Mono", monospace';
      ctx.fillText(RANK_GLYPH[rankOf(card)], x + CARD_W - 5, y + CARD_H - 22);
      ctx.font = '14px serif';
      ctx.fillText(SUIT_GLYPH[suitOf(card)], x + CARD_W - 5, y + CARD_H - 4);
    } else {
      // Facedown: dark bordered rectangle with a subtle pattern.
      ctx.fillStyle = '#3E5A72';
      ctx.fill();
      ctx.strokeStyle = '#0A1622';
      ctx.stroke();
      ctx.strokeStyle = 'rgba(212, 168, 75, 0.4)';
      ctx.strokeRect(x + 4, y + 4, CARD_W - 8, CARD_H - 8);
    }
    ctx.restore();
  };

  /** Small empty-slot outline (for foundation targets, empty tableau piles). */
  const paintSlot = (ctx: CanvasRenderingContext2D, x: number, y: number, label = ''): void => {
    ctx.save();
    ctx.strokeStyle = 'rgba(212, 168, 75, 0.4)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x, y, CARD_W, CARD_H);
    if (label) {
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(212, 168, 75, 0.5)';
      ctx.font = '10px "SF Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + CARD_W / 2, y + CARD_H / 2);
    }
    ctx.restore();
  };

  const drawWarBoard = (s: WarState): void => {
    if (!cardCanvas) return;
    const ctx = cardCanvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, cardCanvas.width, cardCanvas.height);
    // Backdrop.
    ctx.fillStyle = '#0C2216';
    ctx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);
    ctx.fillStyle = GT_GOLD;
    ctx.font = 'bold 12px "SF Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('LEFT', cardCanvas.width / 4, 16);
    ctx.fillText('RIGHT', (cardCanvas.width * 3) / 4, 16);
    // Draw the two decks (facedown stacks) with count.
    const deckY = 30;
    const leftX = cardCanvas.width / 4 - CARD_W / 2;
    const rightX = (cardCanvas.width * 3) / 4 - CARD_W / 2;
    if (s.leftDeck.length > 0) paintCard(ctx, leftX, deckY, null, false);
    else paintSlot(ctx, leftX, deckY, 'EMPTY');
    if (s.rightDeck.length > 0) paintCard(ctx, rightX, deckY, null, false);
    else paintSlot(ctx, rightX, deckY, 'EMPTY');
    ctx.fillStyle = GT_GOLD;
    ctx.font = '11px "SF Mono", monospace';
    ctx.fillText(`${s.leftDeck.length}`, cardCanvas.width / 4, deckY + CARD_H + 12);
    ctx.fillText(`${s.rightDeck.length}`, (cardCanvas.width * 3) / 4, deckY + CARD_H + 12);
    // Draw last-round reveal beneath.
    const revealY = deckY + CARD_H + 26;
    if (s.lastRound) {
      const rr = s.lastRound;
      // Face-down burn to the left of each up card (compact indicator).
      const drawSide = (cards: Card[], burn: Card[], baseX: number): void => {
        let offset = 0;
        for (const b of burn) {
          void b;
          paintCard(ctx, baseX - CARD_W + offset, revealY, null, false);
          offset += 8;
        }
        // The up-card(s) — most recent last, offset to the right of burn.
        let ux = baseX + offset - CARD_W;
        for (const up of cards) {
          paintCard(ctx, ux, revealY, up, true);
          ux += CARD_W + 4;
        }
      };
      drawSide(rr.leftUp, rr.leftDown, cardCanvas.width / 4);
      drawSide(rr.rightUp, rr.rightDown, (cardCanvas.width * 3) / 4);
      if (rr.winner) {
        ctx.fillStyle = GT_GOLD_BRIGHT;
        ctx.font = 'bold 12px "SF Mono", monospace';
        ctx.fillText(rr.winner === 'left' ? '◀ LEFT WINS' : 'RIGHT WINS ▶',
          cardCanvas.width / 2, revealY + CARD_H + 14);
      }
    } else if (s.status === 'playing') {
      ctx.fillStyle = 'rgba(212, 168, 75, 0.6)';
      ctx.font = '11px "SF Mono", monospace';
      ctx.fillText('CLICK PLAY ROUND TO REVEAL', cardCanvas.width / 2, revealY + CARD_H / 2);
    }
  };

  const drawSolitaireBoard = (s: SolitaireState): void => {
    if (!cardCanvas) return;
    const ctx = cardCanvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, cardCanvas.width, cardCanvas.height);
    ctx.fillStyle = '#0C2216';
    ctx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);
    // Layout: top row = stock, waste, foundations x4. Bottom = 7 tableau piles.
    const topY = 10;
    const stockX = 10;
    const wasteX = stockX + CARD_W + CARD_GAP;
    // Stock.
    if (s.stock.length > 0) paintCard(ctx, stockX, topY, null, false);
    else paintSlot(ctx, stockX, topY, s.waste.length > 0 ? '↺' : '—');
    ctx.fillStyle = GT_GOLD;
    ctx.font = '10px "SF Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${s.stock.length}`, stockX + CARD_W / 2, topY + CARD_H + 10);
    // Waste — show top card only (draw-one rule).
    if (s.waste.length > 0) paintCard(ctx, wasteX, topY, s.waste[s.waste.length - 1], true);
    else paintSlot(ctx, wasteX, topY, 'W');
    // Foundations (right side).
    const foundStartX = cardCanvas.width - 4 * (CARD_W + CARD_GAP) - 4;
    for (let suit = 0; suit < 4; suit++) {
      const fx = foundStartX + suit * (CARD_W + CARD_GAP);
      const found = s.foundations[suit];
      if (found.length > 0) paintCard(ctx, fx, topY, found[found.length - 1], true);
      else paintSlot(ctx, fx, topY, SUIT_GLYPH[suit]);
    }
    // Tableau row: 7 piles.
    const tabY = topY + CARD_H + 22;
    const totalW = 7 * CARD_W + 6 * CARD_GAP;
    const tabStartX = Math.max(10, (cardCanvas.width - totalW) / 2);
    const rowStep = 18; // vertical staggering per card
    for (let p = 0; p < 7; p++) {
      const px = tabStartX + p * (CARD_W + CARD_GAP);
      const pile = s.tableau[p];
      if (pile.length === 0) {
        paintSlot(ctx, px, tabY, '');
        continue;
      }
      for (let i = 0; i < pile.length; i++) {
        paintCard(ctx, px, tabY + i * rowStep, pile[i].card, pile[i].faceUp);
      }
    }
    // Selection highlight.
    if (solitaireSource) {
      ctx.strokeStyle = GT_GOLD_BRIGHT;
      ctx.lineWidth = 2.5;
      if (solitaireSource.kind === 'waste' && s.waste.length > 0) {
        ctx.strokeRect(wasteX - 2, topY - 2, CARD_W + 4, CARD_H + 4);
      } else if (solitaireSource.kind === 'foundation') {
        const fx = foundStartX + solitaireSource.suit * (CARD_W + CARD_GAP);
        ctx.strokeRect(fx - 2, topY - 2, CARD_W + 4, CARD_H + 4);
      } else if (solitaireSource.kind === 'tableau') {
        const px = tabStartX + solitaireSource.pile * (CARD_W + CARD_GAP);
        const py = tabY + solitaireSource.index * rowStep;
        const pile = s.tableau[solitaireSource.pile];
        const runLen = pile.length - solitaireSource.index;
        const height = CARD_H + (runLen - 1) * rowStep;
        ctx.strokeRect(px - 2, py - 2, CARD_W + 4, height + 4);
      }
    }
  };

  const onSolitaireCanvasClick = (e: MouseEvent): void => {
    if (!cardCanvas) return;
    const t = readTable(deps.itemId);
    if (!t || t.kind !== 'solitaire' || !mySolitairePlayer(t.state)) return;
    const s = t.state;
    if (s.status !== 'playing') return;
    const rect = cardCanvas.getBoundingClientRect();
    const scaleX = cardCanvas.width / rect.width;
    const scaleY = cardCanvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const topY = 10;
    const stockX = 10;
    const wasteX = stockX + CARD_W + CARD_GAP;
    const foundStartX = cardCanvas.width - 4 * (CARD_W + CARD_GAP) - 4;
    const tabY = topY + CARD_H + 22;
    const totalW = 7 * CARD_W + 6 * CARD_GAP;
    const tabStartX = Math.max(10, (cardCanvas.width - totalW) / 2);
    const rowStep = 18;

    // Hit test — identify what was clicked.
    const inRect = (rx: number, ry: number, rw: number, rh: number): boolean =>
      x >= rx && x <= rx + rw && y >= ry && y <= ry + rh;

    // Stock click → draw.
    if (inRect(stockX, topY, CARD_W, CARD_H)) {
      solitaireSource = null;
      doSolitaireMove({ type: 'draw' });
      return;
    }
    // Waste click.
    if (inRect(wasteX, topY, CARD_W, CARD_H) && s.waste.length > 0) {
      if (solitaireSource?.kind === 'waste') { solitaireSource = null; return; }
      solitaireSource = { kind: 'waste' };
      return;
    }
    // Foundation clicks.
    for (let suit = 0; suit < 4; suit++) {
      const fx = foundStartX + suit * (CARD_W + CARD_GAP);
      if (inRect(fx, topY, CARD_W, CARD_H)) {
        if (solitaireSource?.kind === 'waste') {
          doSolitaireMove({ type: 'waste-to-foundation' });
          solitaireSource = null;
          return;
        }
        if (solitaireSource?.kind === 'tableau') {
          doSolitaireMove({ type: 'tableau-to-foundation', from: solitaireSource.pile });
          solitaireSource = null;
          return;
        }
        // Select this foundation as source.
        if (s.foundations[suit].length > 0) {
          solitaireSource = { kind: 'foundation', suit };
        } else {
          solitaireSource = null;
        }
        return;
      }
    }
    // Tableau piles.
    for (let p = 0; p < 7; p++) {
      const px = tabStartX + p * (CARD_W + CARD_GAP);
      const pile = s.tableau[p];
      // The empty slot still gets a hit box.
      if (pile.length === 0) {
        if (inRect(px, tabY, CARD_W, CARD_H)) {
          if (solitaireSource?.kind === 'waste') {
            doSolitaireMove({ type: 'waste-to-tableau', to: p });
            solitaireSource = null;
            return;
          }
          if (solitaireSource?.kind === 'foundation') {
            doSolitaireMove({ type: 'foundation-to-tableau', suit: solitaireSource.suit, to: p });
            solitaireSource = null;
            return;
          }
          if (solitaireSource?.kind === 'tableau') {
            doSolitaireMove({
              type: 'tableau-to-tableau',
              from: solitaireSource.pile,
              fromIndex: solitaireSource.index,
              to: p,
            });
            solitaireSource = null;
            return;
          }
          return;
        }
        continue;
      }
      // Walk the pile from bottom to top (last card on top wins hit priority).
      for (let i = pile.length - 1; i >= 0; i--) {
        const cy = tabY + i * rowStep;
        // Only the TOP card gets the full height; interior cards get rowStep vis area.
        const isTop = i === pile.length - 1;
        const hitH = isTop ? CARD_H : rowStep;
        if (inRect(px, cy, CARD_W, hitH)) {
          // Only face-up cards may become a source.
          if (!pile[i].faceUp) return;
          // If source is set and we clicked a valid destination (the top of another pile),
          // this branch is handled above by "destination pile" — here `p` is the target.
          if (solitaireSource?.kind === 'waste' && isTop) {
            doSolitaireMove({ type: 'waste-to-tableau', to: p });
            solitaireSource = null;
            return;
          }
          if (solitaireSource?.kind === 'foundation' && isTop) {
            doSolitaireMove({ type: 'foundation-to-tableau', suit: solitaireSource.suit, to: p });
            solitaireSource = null;
            return;
          }
          if (solitaireSource?.kind === 'tableau' && solitaireSource.pile !== p && isTop) {
            doSolitaireMove({
              type: 'tableau-to-tableau',
              from: solitaireSource.pile,
              fromIndex: solitaireSource.index,
              to: p,
            });
            solitaireSource = null;
            return;
          }
          // Otherwise (re)select this face-up run head.
          solitaireSource = { kind: 'tableau', pile: p, index: i };
          return;
        }
      }
    }
    // Missed everything — clear selection.
    solitaireSource = null;
  };

  const drawPokerBoard = (s: PokerState): void => {
    if (!cardCanvas) return;
    const ctx = cardCanvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, cardCanvas.width, cardCanvas.height);
    ctx.fillStyle = '#0C2216';
    ctx.fillRect(0, 0, cardCanvas.width, cardCanvas.height);
    // Community row (centre).
    const communityY = 66;
    const totalCW = 5 * CARD_W + 4 * CARD_GAP;
    const communityX0 = (cardCanvas.width - totalCW) / 2;
    for (let i = 0; i < 5; i++) {
      const cx = communityX0 + i * (CARD_W + CARD_GAP);
      if (i < s.community.length) paintCard(ctx, cx, communityY, s.community[i], true);
      else paintSlot(ctx, cx, communityY, '');
    }
    // Pot indicator.
    ctx.fillStyle = GT_GOLD_BRIGHT;
    ctx.font = 'bold 12px "SF Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`POT ${s.pot}`, cardCanvas.width / 2, communityY - 6);
    // Player rows: BB at top, BUTTON at bottom.
    const viewer = readVisiblePokerState(s, myId);
    const paintPlayer = (
      p: typeof viewer.players.button, label: string, y: number, seatIsToAct: boolean,
    ): void => {
      const x0 = 10;
      // Hole cards.
      if (p.holeCards) {
        paintCard(ctx, x0, y, p.holeCards[0], true);
        paintCard(ctx, x0 + CARD_W + CARD_GAP, y, p.holeCards[1], true);
      } else {
        paintCard(ctx, x0, y, null, false);
        paintCard(ctx, x0 + CARD_W + CARD_GAP, y, null, false);
      }
      // Label + stack.
      ctx.textAlign = 'left';
      ctx.fillStyle = seatIsToAct ? GT_GOLD_BRIGHT : GT_GOLD;
      ctx.font = 'bold 12px "SF Mono", monospace';
      ctx.fillText(label, x0 + 2 * CARD_W + CARD_GAP + 12, y + 16);
      ctx.fillStyle = GT_GOLD;
      ctx.font = '11px "SF Mono", monospace';
      ctx.fillText(`STACK ${p.stack}`, x0 + 2 * CARD_W + CARD_GAP + 12, y + 32);
      ctx.fillText(`BET ${p.streetBet}`, x0 + 2 * CARD_W + CARD_GAP + 12, y + 48);
      if (p.folded) {
        ctx.fillStyle = '#FF8A80';
        ctx.fillText('FOLDED', x0 + 2 * CARD_W + CARD_GAP + 12, y - 4);
      } else if (p.allIn) {
        ctx.fillStyle = '#F0C060';
        ctx.fillText('ALL-IN', x0 + 2 * CARD_W + CARD_GAP + 12, y - 4);
      }
    };
    // BB on top, button on bottom (heads-up visual convention: dealer at bottom).
    paintPlayer(viewer.players.bigBlind, `BIG BLIND — ${pokerSeatLabel(s, 'bigBlind')}`,
      10, s.toAct === 'bigBlind');
    paintPlayer(viewer.players.button, `BUTTON (SB) — ${pokerSeatLabel(s, 'button')}`,
      communityY + CARD_H + 12, s.toAct === 'button');
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
    // "Flip to play X" mismatched-face hint used when the current table game
    // lives on the opposite surface.
    const flipHint = (game: string): string => `
      <div style="display:flex; flex-direction:column; gap:10px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:16px 12px; background:rgba(10,24,14,0.5);">
        <div style="font-size:11px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1.5px;">${game.toUpperCase()} IS ON THE OTHER FACE</div>
        <div style="font-size:10px; color:rgba(212,168,75,0.75); line-height:1.6;">
          Flip the table to keep playing, or RESET to clear it and pick a new game on this face.
        </div>
        <div style="display:flex; gap:8px;">
          ${btn('gt-reset', 'RESET', !canClearTable(),
            canClearTable() ? 'Clear the table back to the picker' : 'Participants or the room owner reset a live game')}
        </div>
      </div>`;

    let boardFace: string;
    if (table === null) {
      boardFace = `
        <div style="display:flex; flex-direction:column; gap:10px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:16px 12px;">
          <div style="font-size:11px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1.5px;">CHOOSE A GAME</div>
          <div style="display:flex; gap:10px;">
            ${btn('gt-pick-chess', '♟ CHESS', false, 'Full rules — castling, en passant, checkmate')}
            ${btn('gt-pick-checkers', '⛀ CHECKERS', false, 'American rules, forced captures')}
          </div>
          <div style="font-size:9px; color:rgba(212,168,75,0.5);">Anyone at the table picks; the first two to SIT play. RESET brings this menu back. Flip for the card felt.</div>
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
    } else if (table.kind === 'checkers') {
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
    } else {
      // A card-felt game (war/solitaire/poker) is on the OPPOSITE face.
      const label = table.kind === 'war' ? 'WAR'
        : table.kind === 'solitaire' ? 'SOLITAIRE'
        : 'POKER';
      boardFace = flipHint(label);
    }

    // ── The card face: picker / war / solitaire / poker ──
    const cardCanvasHtml = (interactive: boolean): string => `
      <canvas id="gt-card-canvas" width="400" height="240"
        style="width:400px; height:240px; align-self:center; border:1px solid rgba(212,168,75,0.35); border-radius:6px; cursor:${interactive ? 'pointer' : 'default'};"></canvas>`;
    const cardSeatCell = (
      idSuffix: string, name: string, dot: string, claimable: boolean, hint: string,
    ): string => `
      <div style="flex:1; display:flex; align-items:center; gap:8px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:7px 10px;">
        <span style="width:10px; height:10px; border-radius:50%; background:${dot}; flex:none;"></span>
        <span style="flex:1; font-size:10px; letter-spacing:1px; color:${GT_GOLD};">${name}</span>
        ${claimable ? btn(idSuffix, 'SIT', false, hint) : ''}
      </div>`;

    let cardFace: string;
    if (table === null) {
      cardFace = `
        <div style="display:flex; flex-direction:column; gap:10px; border:1px solid rgba(212,168,75,0.18); border-radius:6px; padding:16px 12px;">
          <div style="font-size:11px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1.5px;">♠ CARD FELT — PICK A GAME</div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            ${btn('gt-pick-war', '⚔ WAR (2P)', false, 'Two-player war — top-card duels')}
            ${btn('gt-pick-solitaire', '★ SOLITAIRE', false, 'Single-player Klondike (draw three, draw-one toggle available)')}
            ${btn('gt-pick-poker', '♠ POKER (2P)', false, 'Heads-up NL Texas Hold\'em')}
          </div>
          <div style="font-size:9px; color:rgba(212,168,75,0.5); line-height:1.5;">
            v1 caveat: the card felt syncs cards through the ROOM DOC, so a
            determined spectator inspecting the doc could read hole cards.
            Full hidden-hand play (commit-reveal) arrives with the wallet-
            integrated slice — see brainstorming/games-plan.md.
            <br /><br />
            <strong style="color:rgba(230,120,120,0.85);">Adversarial fairness:</strong>
            each client shuffles independently using a deterministic seed
            written into the doc — so a peer who observes the SEED before
            posting can pre-compute the whole hand order. Trusted-node play
            only in v1; competitive/wagered play blocks on the same
            commit-reveal work as hidden-hand poker (see games-plan.md).
          </div>
        </div>`;
    } else if (table.kind === 'war') {
      const w = table.state;
      const showBot = w.status === 'waiting' && w.players.right === null
        && (w.players.left === null || w.players.left === myId);
      const showForfeit = w.status === 'playing' && myWarSeat(w) !== null;
      const canPlay = w.status === 'playing' && (myWarSeat(w) !== null || w.bot);
      cardFace = `
        <div id="gt-card-status" style="font-size:10px; font-weight:800; letter-spacing:1px; color:${
          w.status === 'playing' ? GT_GOLD_BRIGHT : w.status === 'waiting' ? GT_DIM : '#00E676'
        };">${warStatusText(w)}</div>
        <div style="display:flex; gap:8px;">
          ${cardSeatCell('gt-war-sit-left', `LEFT — ${warSeatLabel(w, 'left')}`,
            '#F0C060',
            w.status === 'waiting' && w.players.left === null && w.players.right !== myId,
            'Claim LEFT')}
          ${cardSeatCell('gt-war-sit-right', `RIGHT — ${warSeatLabel(w, 'right')}`,
            '#9AA3B2',
            w.status === 'waiting' && w.players.right === null && !w.bot && w.players.left !== myId,
            'Claim RIGHT')}
        </div>
        ${showBot ? `<div>${btn('gt-war-bot', '⚙ VS BOT — PLAY ALONE', false, 'Single-player war against a trivial AI')}</div>` : ''}
        ${cardCanvasHtml(false)}
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          ${canPlay ? btn('gt-war-play', '▶ PLAY ROUND', false, 'Reveal both top cards and resolve') : ''}
          ${showForfeit ? btn('gt-war-forfeit', 'FORFEIT', false, 'Concede the match') : ''}
          ${btn('gt-reset', 'RESET', !canClearTable(),
            canClearTable() ? 'Clear the table (back to the game menu)' : 'Participants or the room owner reset')}
        </div>`;
    } else if (table.kind === 'solitaire') {
      const s = table.state;
      const claimable = s.status === 'waiting' && (s.player === null || s.player === myId);
      const legal = mySolitairePlayer(s) ? legalSolitaireMoves(s).length : 0;
      const isMine = mySolitairePlayer(s);
      // Draw-mode toggle is only actionable pre-deal (waiting status). After
      // dealing, the mode is locked (setSolitaireDrawMode rejects changes
      // while playing so a mid-hand switch can't corrupt the stock/waste
      // draw count). Show it as a static label when playing.
      const drawModeToggle = s.status === 'waiting'
        ? `
        <div style="display:flex; gap:6px; align-items:center;">
          <span style="font-size:9px; color:${GT_DIM}; letter-spacing:1px;">DRAW:</span>
          ${btn('gt-sol-draw-1', 'DRAW ONE',
            s.drawMode === 1,
            'Klondike draw-one variant (turn one card at a time)')}
          ${btn('gt-sol-draw-3', 'DRAW THREE',
            s.drawMode === 3,
            'Klondike draw-three variant (turn three cards at a time; classic default)')}
        </div>`
        : `<div style="font-size:9px; color:${GT_DIM}; letter-spacing:1px;">DRAW ${s.drawMode === 1 ? 'ONE' : 'THREE'} · locked for this deal</div>`;
      // Undo button: only offered mid-play, only when there IS a snapshot
      // to restore. The engine caps undoHistory at MAX_UNDO_HISTORY (128)
      // and each snapshot elides its own history to keep the doc shape
      // bounded across long sessions.
      const canUndo = isMine && s.status === 'playing' && s.undoHistory.length > 0;
      cardFace = `
        <div id="gt-card-status" style="font-size:10px; font-weight:800; letter-spacing:1px; color:${
          s.status === 'playing' ? GT_GOLD_BRIGHT : s.status === 'waiting' ? GT_DIM : '#00E676'
        };">${solitaireStatusText(s)}</div>
        <div style="display:flex; gap:8px;">
          ${cardSeatCell('gt-sol-sit', `PLAYER — ${s.player
            ? (s.player === myId ? `${readPlayerDisplayName(s.player).toUpperCase()} (YOU)` : readPlayerDisplayName(s.player).toUpperCase())
            : 'OPEN'}`, '#F0C060', claimable, 'Claim the seat and deal')}
        </div>
        ${drawModeToggle}
        ${cardCanvasHtml(mySolitairePlayer(s) && s.status === 'playing')}
        <div style="display:flex; gap:8px; justify-content:space-between; align-items:center;">
          <div style="font-size:9px; color:rgba(212,168,75,0.5);">${
            mySolitairePlayer(s) && s.status === 'playing'
              ? `${legal} legal moves · click a card, then click a destination`
              : ''
          }</div>
          <div style="display:flex; gap:8px;">
            ${isMine && s.status === 'playing' ? btn('gt-sol-undo', `↶ UNDO (${s.undoHistory.length})`,
              !canUndo,
              canUndo ? `Restore the previous state (${s.undoHistory.length} snapshot${s.undoHistory.length === 1 ? '' : 's'} available)` : 'No moves to undo yet') : ''}
            ${btn('gt-reset', 'RESET', !canClearTable(),
              canClearTable() ? 'Clear the table (back to the game menu)' : 'Participants or the room owner reset')}
          </div>
        </div>`;
    } else if (table.kind === 'poker') {
      const p = table.state;
      // 🃏🎰 #45 wager slice — active WAGER config for this table (null =
      // free-play mode, bit-identical to today's behavior). The presence
      // of a config turns on wager UI (buy-in badge, PAY button, POT).
      const wagerCfg = readCardWagerConfig(deps.itemId);
      const myEscrow = wagerCfg ? readCardWagerEscrow(deps.itemId, myId) : null;
      const buttonEscrow = wagerCfg && p.players.button.id
        ? readCardWagerEscrow(deps.itemId, p.players.button.id) : null;
      const bbEscrow = wagerCfg && p.players.bigBlind.id
        ? readCardWagerEscrow(deps.itemId, p.players.bigBlind.id) : null;
      const bothPaid = !!buttonEscrow && !!bbEscrow;
      const isWagerOwner = wagerCfg?.ownerId === myId;
      // Owner settles on match-over ONLY once both payers countersigned
      // the result (ack gate inside maybeSettleWager) — idempotent
      // (config gone after settle → future renders no-op).
      maybeSettleWager(p);
      // 🃏🎰 #45 ack slice — match-over confirmation state. `derivedResult`
      // is the engine's own answer (null outside a live-wager match-over,
      // or on a mangled terminal state); each payer countersigns it via
      // the CONFIRM RESULT button rendered below.
      const matchOverWager = p.status === 'match-over' && !!wagerCfg
        && wagerCfg.startedAt !== null;
      // A payer's ack counts (for display AND effectively for the gate)
      // only when key-bound, kind-bound, and fresh for THIS match —
      // mirrors readAgreedCardWagerResult's acceptance rule so the badge
      // never shows CONFIRMED for an ack that settle would refuse.
      const freshAckWinner = (pid: string | null): string | null => {
        if (!wagerCfg || wagerCfg.startedAt === null || !pid) return null;
        const a = readCardWagerAck(deps.itemId, pid);
        return a && a.playerId === pid && a.kind === wagerCfg.kind
          && a.matchStartedAt === wagerCfg.startedAt ? a.winnerId : null;
      };
      const derivedResult = matchOverWager
        ? deriveHeadsUpWinner(p.players.button, p.players.bigBlind) : null;
      const buttonAckW = matchOverWager ? freshAckWinner(p.players.button.id) : null;
      const bbAckW = matchOverWager ? freshAckWinner(p.players.bigBlind.id) : null;
      const myAckW = matchOverWager ? freshAckWinner(myId) : null;
      const ackDisputed = buttonAckW !== null && bbAckW !== null
        && buttonAckW !== bbAckW;
      const derivedLabel = derivedResult === null ? ''
        : derivedResult === 'split' ? 'SPLIT POT'
          : derivedResult === myId ? 'YOU WIN'
            : `${readPlayerDisplayName(derivedResult).toUpperCase()} WINS`;
      const showBot = p.status === 'waiting' && p.players.bigBlind.id === null
        && (p.players.button.id === null || p.players.button.id === myId)
        && !wagerCfg; // wager mode disables the trivial bot (no counter-party)
      const bothClaimed = p.players.button.id !== null && p.players.bigBlind.id !== null;
      // Wager mode requires BOTH players to have paid before BEGIN unlocks.
      const beginUnlocked = wagerCfg ? (bothClaimed && bothPaid && isWagerOwner) : bothClaimed;
      const showBegin = p.status === 'waiting' && beginUnlocked;
      // Forfeit is only sensible mid-hand — post-round-3 fix. Between hands
      // (status === 'hand-over') the winner is decided, the seat's stack is
      // stable, and pressing "FORFEIT" would gift chips it had every right
      // to keep or reject on 'nextHand'. The Copilot review flagged this as
      // a stack-integrity bug: a rage-forfeit at hand-over hopped a decision
      // point (start next hand vs. leave) and directly transferred chips.
      const showForfeit = p.status === 'playing' && myPokerSeat(p) !== null;
      const showNextHand = p.status === 'hand-over' && (myPokerSeat(p) !== null || p.bot);
      const seat = myPokerSeat(p);
      const inTurn = seat !== null && myPokerTurn(p);
      const legal = inTurn ? legalActions(p, seat!) : [];
      const toCall = seat !== null ? callAmount(p, seat) : 0;
      const minB = minBet(p);
      const minR = seat !== null ? minRaiseTo(p, seat) : 0;
      // 🃏🎰 #45 wager panel HTML — only rendered while the table is in
      // waiting phase (owner sets up wager) or before settle. The plain-
      // language rule bans token/channel jargon: WAGER / BUY-IN / POT.
      const canEnableWager = p.status === 'waiting' && !wagerCfg;
      const potChips = wagerCfg ? (wagerCfg.buyIn * 2) : 0;
      const wagerPanel = wagerCfg ? `
        <div style="font-size:10px; font-weight:800; letter-spacing:1px; color:${GT_GOLD_BRIGHT}; background:rgba(70,40,10,0.35); padding:8px 10px; border:1px solid rgba(212,168,75,0.35); border-radius:4px;">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span>🎰 WAGER MODE — BUY-IN ${wagerCfg.buyIn} chips</span>
            <span style="color:${GT_GOLD};">POT ${potChips}</span>
          </div>
          <div style="margin-top:6px; display:flex; gap:6px; align-items:center; font-size:9px; color:${GT_DIM};">
            <span>BUTTON: ${buttonEscrow ? '<span style="color:#00E676;">PAID</span>' : 'PENDING'}</span>
            <span>·</span>
            <span>BIG BLIND: ${bbEscrow ? '<span style="color:#00E676;">PAID</span>' : 'PENDING'}</span>
            ${wagerCfg.startedAt !== null ? '<span>· <span style="color:#F0C060;">MATCH LIVE</span></span>' : ''}
          </div>
          ${matchOverWager ? `
          <div style="margin-top:6px; display:flex; gap:6px; align-items:center; font-size:9px; color:${GT_DIM};">
            <span>RESULT — ${derivedResult === null ? '<span style="color:#FF8A80;">UNREADABLE</span>' : derivedLabel}</span>
            <span>·</span>
            <span>BUTTON: ${buttonAckW !== null ? '<span style="color:#00E676;">CONFIRMED</span>' : 'UNCONFIRMED'}</span>
            <span>·</span>
            <span>BIG BLIND: ${bbAckW !== null ? '<span style="color:#00E676;">CONFIRMED</span>' : 'UNCONFIRMED'}</span>
          </div>
          ${ackDisputed ? `<div style="margin-top:4px; font-size:9px; color:#FF8A80;">⚠ CONFIRMATIONS DISAGREE — re-confirm after the table syncs, or the owner can cancel and refund both buy-ins.</div>` : ''}` : ''}
          <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
            ${p.status === 'waiting' && !myEscrow && (p.players.button.id === myId || p.players.bigBlind.id === myId)
              ? btn('gt-poker-wager-pay', `PAY BUY-IN (${wagerCfg.buyIn})`, readChips(myId) < wagerCfg.buyIn,
                readChips(myId) < wagerCfg.buyIn ? `Need ${wagerCfg.buyIn} chips (you have ${readChips(myId)})` : 'Escrow your buy-in')
              : ''}
            ${matchOverWager && derivedResult !== null && myEscrow
              ? (myAckW === derivedResult
                ? '<span style="color:#00E676; font-size:9px; align-self:center;">✔ YOU CONFIRMED</span>'
                : btn('gt-poker-wager-confirm', `CONFIRM RESULT — ${derivedLabel}`, false,
                  'Countersign the result you see; the pot pays out once both players confirm'))
              : ''}
            ${p.status === 'waiting' && wagerCfg.startedAt === null
              ? btn('gt-poker-wager-cancel', 'CANCEL WAGER',
                !(isWagerOwner || (myEscrow !== null)),
                isWagerOwner ? 'Refund all payers and clear the wager' : (myEscrow ? 'Refund your own buy-in' : 'Only the owner or a payer can cancel'))
              : ''}
            ${matchOverWager
              ? btn('gt-poker-wager-cancel', 'CANCEL — REFUND BOTH', !isWagerOwner,
                isWagerOwner ? 'Refund both buy-ins instead of settling (dispute / walk-away valve)'
                  : 'Owner-only once a match has started')
              : ''}
          </div>
        </div>` : (canEnableWager ? `
        <div style="font-size:10px; letter-spacing:1px; color:${GT_DIM}; background:rgba(4,8,22,0.5); padding:6px 8px; border:1px dashed rgba(212,168,75,0.25); border-radius:4px;">
          <div style="display:flex; gap:6px; align-items:center;">
            <span style="color:${GT_GOLD};">🎰 WAGER MODE (optional)</span>
            <input id="gt-poker-wager-buyin" type="number" min="${minCardWagerBuyIn('poker')}" max="${MAX_CARD_WAGER_BUY_IN}"
              value="${pokerWagerDraft}" placeholder="buy-in"
              style="width:80px; padding:4px 6px; background:rgba(4,8,22,0.8); border:1px solid rgba(212,168,75,0.35); border-radius:3px; color:${GT_GOLD_BRIGHT}; font-family:inherit; font-size:10px;" />
            ${btn('gt-poker-wager-enable', 'ENABLE WAGER', false,
              'Escrow chips for a winner-takes-pot match')}
          </div>
          <div style="margin-top:4px; font-size:8px; color:rgba(212,168,75,0.5);">
            Leave OFF for today's free-play (no chip transfer). Wager mode is heads-up only (no bot).
          </div>
        </div>` : '');
      cardFace = `
        <div id="gt-card-status" style="font-size:10px; font-weight:800; letter-spacing:1px; color:${
          p.status === 'playing' ? GT_GOLD_BRIGHT : p.status === 'waiting' ? GT_DIM : '#00E676'
        };">${pokerStatusText(p)}</div>
        <div style="font-size:9px; color:rgba(230,120,120,0.75); background:rgba(90,20,20,0.25); padding:6px 8px; border-radius:4px; line-height:1.4;">
          ⚠ HOLE CARDS ARE TECHNICALLY PUBLIC in this v1 — the doc that syncs
          the hand is visible to any peer inspecting it. Commit-reveal / chia-
          gaming integration is a later slice.
        </div>
        ${wagerPanel}
        <div style="display:flex; gap:8px;">
          ${cardSeatCell('gt-poker-sit-button', `BUTTON — ${pokerSeatLabel(p, 'button')}`,
            '#F0C060',
            p.status === 'waiting' && p.players.button.id === null && p.players.bigBlind.id !== myId,
            'Claim BUTTON (small blind)')}
          ${cardSeatCell('gt-poker-sit-bb', `BIG BLIND — ${pokerSeatLabel(p, 'bigBlind')}`,
            '#9AA3B2',
            p.status === 'waiting' && p.players.bigBlind.id === null && !p.bot && p.players.button.id !== myId,
            'Claim BIG BLIND')}
        </div>
        ${showBot ? `<div>${btn('gt-poker-bot', '⚙ VS BOT — PLAY ALONE', false, 'Heads-up against a trivial AI')}</div>` : ''}
        ${showBegin ? `<div>${btn('gt-poker-begin', '▶ BEGIN MATCH', false,
          wagerCfg
            ? `Deal hand #1 with ${wagerCfg.buyIn}-chip stacks (wager active)`
            : 'Deal hand #1 with 1000-chip starting stacks')}</div>` : ''}
        ${cardCanvasHtml(false)}
        ${inTurn ? `
          <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
            ${legal.includes('fold') ? btn('gt-poker-fold', 'FOLD', false, 'Concede this hand') : ''}
            ${legal.includes('check') ? btn('gt-poker-check', 'CHECK', false, 'Pass (no bet to call)') : ''}
            ${legal.includes('call') ? btn('gt-poker-call', `CALL ${toCall}`, false, `Match the current bet (${toCall})`) : ''}
            ${legal.includes('bet') || legal.includes('raise') ? `
              <input id="gt-poker-amt" type="number" min="${legal.includes('bet') ? minB : minR}"
                value="${pokerBetInput || (legal.includes('bet') ? String(minB) : String(minR))}"
                style="width:70px; padding:5px 8px; background:rgba(4,8,22,0.8); border:1px solid rgba(212,168,75,0.35); border-radius:4px; color:${GT_GOLD_BRIGHT}; font-family:inherit; font-size:11px;"
                placeholder="chips" />
              ${legal.includes('bet') ? btn('gt-poker-bet', `BET (min ${minB})`, false, 'Open the betting on this street') : ''}
              ${legal.includes('raise') ? btn('gt-poker-raise', `RAISE TO (min ${minR})`, false, 'Increase the current bet') : ''}
            ` : ''}
          </div>` : ''}
        <div style="display:flex; gap:8px; justify-content:flex-end;">
          ${showNextHand ? btn('gt-poker-next', '▶ NEXT HAND', false, 'Rotate button and deal') : ''}
          ${showForfeit ? btn('gt-poker-forfeit', 'FORFEIT', false, 'Concede the match') : ''}
          ${btn('gt-reset', 'RESET', !canClearTable(),
            canClearTable() ? 'Clear the table (back to the game menu)' : 'Participants or the room owner reset')}
        </div>`;
    } else {
      // A board-face game (checkers/chess) is on the OPPOSITE face.
      const label = 'BOARD GAME';
      cardFace = flipHint(label);
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
      ${cardsUp ? cardFace : boardFace}
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px;">
        SSF GAME TABLE · board face: chess + checkers · card face: war, solitaire, heads-up poker · state synced via room doc · flip is per-player (only you see the other face)
      </div>
    `;

    panel.querySelector<HTMLButtonElement>('#gt-flip')?.addEventListener('click', () => {
      if (!deps.top || deps.top.isFlipping()) return;
      selected = null;
      chessSelected = null;
      solitaireSource = null;
      deps.top.flip(() => render()); // completion swaps the panel face
      render();                      // immediate: show FLIPPING…
    });
    // Board-face picker.
    panel.querySelector<HTMLButtonElement>('#gt-pick-chess')?.addEventListener('click', () => {
      if (readTable(deps.itemId) === null) writeGame(deps.itemId, initialChessState());
    });
    panel.querySelector<HTMLButtonElement>('#gt-pick-checkers')?.addEventListener('click', () => {
      if (readTable(deps.itemId) === null) writeGame(deps.itemId, initialState());
    });
    // Card-face picker.
    panel.querySelector<HTMLButtonElement>('#gt-pick-war')?.addEventListener('click', () => {
      if (readTable(deps.itemId) === null) writeGame(deps.itemId, initialWarState(randomSeed()));
    });
    panel.querySelector<HTMLButtonElement>('#gt-pick-solitaire')?.addEventListener('click', () => {
      if (readTable(deps.itemId) === null) writeGame(deps.itemId, initialSolitaireState(randomSeed()));
    });
    panel.querySelector<HTMLButtonElement>('#gt-pick-poker')?.addEventListener('click', () => {
      if (readTable(deps.itemId) === null) writeGame(deps.itemId, initialPokerState(randomSeed()));
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
    // War controls.
    panel.querySelector<HTMLButtonElement>('#gt-war-sit-left')?.addEventListener('click', () => claimWarSeat('left'));
    panel.querySelector<HTMLButtonElement>('#gt-war-sit-right')?.addEventListener('click', () => claimWarSeat('right'));
    panel.querySelector<HTMLButtonElement>('#gt-war-bot')?.addEventListener('click', () => startWarBot());
    panel.querySelector<HTMLButtonElement>('#gt-war-play')?.addEventListener('click', () => warPlayRound());
    panel.querySelector<HTMLButtonElement>('#gt-war-forfeit')?.addEventListener('click', () => warForfeit());
    // Solitaire controls.
    panel.querySelector<HTMLButtonElement>('#gt-sol-sit')?.addEventListener('click', () => claimSolitaireSeat());
    panel.querySelector<HTMLButtonElement>('#gt-sol-draw-1')?.addEventListener('click', () => doSetSolitaireDrawMode(1));
    panel.querySelector<HTMLButtonElement>('#gt-sol-draw-3')?.addEventListener('click', () => doSetSolitaireDrawMode(3));
    panel.querySelector<HTMLButtonElement>('#gt-sol-undo')?.addEventListener('click', () => doSolitaireUndo());
    // Poker controls.
    panel.querySelector<HTMLButtonElement>('#gt-poker-sit-button')?.addEventListener('click', () => claimPokerSeat('button'));
    panel.querySelector<HTMLButtonElement>('#gt-poker-sit-bb')?.addEventListener('click', () => claimPokerSeat('bigBlind'));
    panel.querySelector<HTMLButtonElement>('#gt-poker-bot')?.addEventListener('click', () => beginPokerMatch(true));
    panel.querySelector<HTMLButtonElement>('#gt-poker-begin')?.addEventListener('click', () => beginPokerMatch(false));
    panel.querySelector<HTMLButtonElement>('#gt-poker-fold')?.addEventListener('click', () => doPokerAction('fold'));
    panel.querySelector<HTMLButtonElement>('#gt-poker-check')?.addEventListener('click', () => doPokerAction('check'));
    panel.querySelector<HTMLButtonElement>('#gt-poker-call')?.addEventListener('click', () => doPokerAction('call'));
    panel.querySelector<HTMLButtonElement>('#gt-poker-bet')?.addEventListener('click', () => doPokerAction('bet'));
    panel.querySelector<HTMLButtonElement>('#gt-poker-raise')?.addEventListener('click', () => doPokerAction('raise'));
    panel.querySelector<HTMLButtonElement>('#gt-poker-next')?.addEventListener('click', () => advancePokerHand());
    panel.querySelector<HTMLButtonElement>('#gt-poker-forfeit')?.addEventListener('click', () => pokerForfeit());
    // 🃏🎰 #45 wager controls (draft input + enable/pay/cancel buttons).
    const wagerBuyInInput = panel.querySelector<HTMLInputElement>('#gt-poker-wager-buyin');
    if (wagerBuyInInput) {
      wagerBuyInInput.addEventListener('input', () => { pokerWagerDraft = wagerBuyInInput.value; });
    }
    panel.querySelector<HTMLButtonElement>('#gt-poker-wager-enable')?.addEventListener('click', () => enablePokerWager());
    panel.querySelector<HTMLButtonElement>('#gt-poker-wager-pay')?.addEventListener('click', () => payPokerWager());
    panel.querySelector<HTMLButtonElement>('#gt-poker-wager-cancel')?.addEventListener('click', () => cancelPokerWager());
    panel.querySelector<HTMLButtonElement>('#gt-poker-wager-confirm')?.addEventListener('click', () => ackPokerResult());
    const amtInput = panel.querySelector<HTMLInputElement>('#gt-poker-amt');
    if (amtInput) {
      // Store the bet-input value so re-renders don't wipe the user's typing.
      amtInput.addEventListener('input', () => { pokerBetInput = amtInput.value; });
      // A re-render right after typing sets the value from `pokerBetInput`;
      // preserve caret position by not re-focusing here.
    }
    // Shared RESET → back to the picker (all kinds).
    panel.querySelector<HTMLButtonElement>('#gt-reset')?.addEventListener('click', () => clearToPicker());
    // Board-face canvas (checkers / chess).
    boardCanvas = panel.querySelector<HTMLCanvasElement>('#gt-board');
    if (table?.kind === 'chess') {
      boardCanvas?.addEventListener('click', onChessBoardClick);
      drawChessBoard(table.state);
    } else if (table?.kind === 'checkers' || table === null) {
      boardCanvas?.addEventListener('click', onBoardClick);
      drawBoard(table?.state ?? null);
    }
    // Card-face canvas (war / solitaire / poker).
    cardCanvas = panel.querySelector<HTMLCanvasElement>('#gt-card-canvas');
    if (cardCanvas) {
      if (table?.kind === 'war') drawWarBoard(table.state);
      else if (table?.kind === 'solitaire') {
        cardCanvas.addEventListener('click', onSolitaireCanvasClick);
        drawSolitaireBoard(table.state);
      } else if (table?.kind === 'poker') drawPokerBoard(table.state);
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
      warBotTimer = 0;
      pokerBotTimer = 0;
      solitaireSource = null;
      pokerBetInput = '';
      // Observer-driven repaint: doc changes (peer moves, claims, resets,
      // rebinds after a rejoin) re-render the whole panel from the doc.
      // 🃏🎰 #45 wager slice — wager config + escrow records live in the
      // CASINO map, so a wager-mode poker table also needs a casino-map
      // subscription (PAY by peer, or owner refund, re-paints the panel).
      const unsubGames = subscribeGames(() => render());
      const unsubCasino = subscribeCasino(() => render());
      unsubscribe = () => { unsubGames(); unsubCasino(); };
      render();
    },

    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      panel?.remove();
      panel = null;
      boardCanvas = null;
      cardCanvas = null;
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
      } else if (t?.kind === 'war') {
        // War bot: the LEFT claimant's client auto-plays rounds against the
        // trivial "always play" bot at RIGHT. The bot's advantage is nil —
        // this is just so the human doesn't have to click PLAY every round
        // during a solo demo. Human vs human runs on manual PLAY clicks.
        const s = t.state;
        if (s.bot && s.status === 'playing' && s.players.left === myId
            && s.leftDeck.length > 0 && s.rightDeck.length > 0) {
          warBotTimer += dt;
          if (warBotTimer >= 0.5) {
            warBotTimer = 0;
            writeGame(deps.itemId, playWarRound(s));
          }
        } else warBotTimer = 0;
      } else if (t?.kind === 'poker') {
        // Poker bot: the human claimant's client acts on the bot's behalf
        // when it's the bot's turn. The bot is identified by a `null` id
        // (mirrors checkers/chess conventions — see pokerSeatLabel).
        // Pre-round-3 this hard-coded `'bigBlind'` as the bot seat AND
        // required the human to be at BUTTON, so it stopped firing once
        // dealHand rotated the seats on hand ≥ 2 — no client pumped, the
        // bot froze mid-match, RESET was the only recovery.
        const s = t.state;
        const botSeat: PokerSeat | null =
          s.players.button.id === null && s.players.bigBlind.id === myId ? 'button'
          : s.players.bigBlind.id === null && s.players.button.id === myId ? 'bigBlind'
          : null;
        if (s.bot && s.status === 'playing' && botSeat !== null && s.toAct === botSeat) {
          pokerBotTimer += dt;
          if (pokerBotTimer >= 0.9) {
            pokerBotTimer = 0;
            const action = chooseBotAction(s, botSeat);
            if (action) {
              const next = applyPokerAction(s, action);
              if (next !== s) writeGame(deps.itemId, next);
            }
          }
        } else pokerBotTimer = 0;
      } else {
        botTimer = 0;
        chessBotTimer = 0;
        warBotTimer = 0;
        pokerBotTimer = 0;
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
 * short menu — Serve drinks / Table croupier / Idle at dock / Custom script —
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
    // 🔊 Robot VOICE — a LOCAL listener preference (this device's speakers),
    // so it sits OUTSIDE the owner gate: guests toggle their own. One fixed
    // style — see robotVoice.ts.
    const voiceOn = isRobotVoiceEnabled();
    const voiceBtn = `<button data-voice="1" style="
      display:flex; justify-content:space-between; align-items:center; gap:8px;
      padding:9px 12px; text-align:left;
      background:${voiceOn ? 'rgba(47,230,160,0.14)' : 'rgba(212,168,75,0.06)'};
      border:1px solid ${voiceOn ? '#2fe6a0' : 'rgba(212,168,75,0.35)'};
      border-radius:7px; color:${voiceOn ? '#2fe6a0' : CH_GOLD};
      font-family:inherit; font-size:11px; font-weight:800; letter-spacing:0.5px;
      cursor:pointer;
    "><span>${voiceOn ? '🔊 VOICE ON' : '🔇 VOICE OFF'}</span><span style="font-size:9px; color:rgba(212,168,75,0.5);">this device</span></button>`;
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
      <div style="font-size:10px; color:${CH_DIM}; letter-spacing:1.5px;">VOICE</div>
      ${voiceBtn}
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
    // 🔊 VOICE toggles for EVERYONE (local speakers, not the synced config) —
    // wired before the owner gate below. Local change → re-render by hand
    // (the subscribeRobot observer only fires on doc writes).
    panel.querySelector<HTMLButtonElement>('[data-voice]')?.addEventListener('click', () => {
      setRobotVoiceEnabled(!isRobotVoiceEnabled());
      render();
    });
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

// ══════════════════════════════════════════════════════════════════════════════
// 🎰 Slot machine (#109)
// ══════════════════════════════════════════════════════════════════════════════

export interface SlotMachineUIDeps {
  itemId: string;
  isHouse: () => boolean;
  onDenominationChange?: (amount: number) => void;
  onMessage?: (message: string) => void;
}

export type SlotMachineCabinetControl = 'denomination' | 'pull';

interface ActiveSlotMachineSession {
  selectDenomination(amount: number): void;
  pull(): void;
}

const activeSlotMachineSessions = new Map<string, ActiveSlotMachineSession>();

/** Route a focused cabinet mesh action into its headless play session. */
export function operateActiveSlotMachine(
  itemId: string,
  control: SlotMachineCabinetControl,
  value?: number,
): boolean {
  const session = activeSlotMachineSessions.get(itemId);
  if (!session) return false;
  if (control === 'denomination') {
    if (value === undefined) return false;
    session.selectDenomination(value);
  } else {
    session.pull();
  }
  return true;
}

interface PendingSlotPlay {
  docEpoch: number;
  machineId: string;
  playerId: string;
  requestId: string;
  seed: string;
  expiryTimer: number;
}

const pendingSlotPlays = new Map<string, PendingSlotPlay>();

function pendingSlotKey(machineId: string, playerId: string): string {
  return `${machineId}\0${playerId}`;
}

export function clearPendingSlotPlays(machineId: string): void {
  for (const [key, pending] of pendingSlotPlays) {
    if (pending.machineId === machineId) deletePendingSlotPlay(key);
  }
}

function deletePendingSlotPlay(key: string): void {
  const pending = pendingSlotPlays.get(key);
  if (pending?.expiryTimer) window.clearTimeout(pending.expiryTimer);
  pendingSlotPlays.delete(key);
}

function cancelUnacceptedSlotPlay(key: string, pending: PendingSlotPlay): void {
  if (pendingSlotPlays.get(key) !== pending) return;
  const state = readSlotMachineState(pending.machineId);
  if (state?.phase === 'spinning' && state.requestId === pending.requestId) return;
  clearSlotPlayRequest(pending.machineId, pending.playerId);
  deletePendingSlotPlay(key);
}

function revealPendingSlot(pending: PendingSlotPlay): void {
  const key = pendingSlotKey(pending.machineId, pending.playerId);
  if (pending.docEpoch !== casinoDocEpoch()) {
    deletePendingSlotPlay(key);
    return;
  }
  const state = readSlotMachineState(pending.machineId);
  if (state?.phase === 'settled' && state.requestId === pending.requestId) {
    deletePendingSlotPlay(key);
    return;
  }
  const houseCommit = state?.fairness?.commits?.[1];
  if (state?.phase !== 'spinning'
    || state.player !== pending.playerId
    || state.requestId !== pending.requestId
    || !houseCommit) return;

  const published = readSlotReveal(pending.machineId, pending.playerId);
  if (published?.requestId === pending.requestId
    && published.seed === pending.seed
    && published.houseCommit === houseCommit) {
    return;
  }

  writeSlotReveal(pending.machineId, pending.playerId, {
    requestId: pending.requestId,
    seed: pending.seed,
    houseCommit,
  });
}

subscribeCasino(() => {
  for (const pending of pendingSlotPlays.values()) {
    revealPendingSlot(pending);
  }
});

export function createSlotMachineUI(
  deps: SlotMachineUIDeps,
  serviceMode = false,
): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let denom = 5;
  let flash = '';
  let paytableFingerprint = '';
  let paytableRtp = 0;
  let renderedPaytable = '';
  let renderedPaytableForHouse = false;
  const myId = getPlayerId();

  const fundingConfig = (): SlotFundingConfig => {
    const stored = readSlotFundingConfig(deps.itemId);
    if (stored) return stored;
    const roomOwner = readRoomOwner();
    return {
      mode: 'owner',
      ownerId: deps.isHouse() ? myId : roomOwner && roomOwner !== 'Local-Clone' ? roomOwner : myId,
    };
  };

  const clonePaytable = (paytable: readonly SlotPayEntry[]): SlotPayEntry[] =>
    paytable.map((entry) => ({
      ...entry,
      symbols: [...entry.symbols] as SlotPayEntry['symbols'],
    }));

  const pullLever = async (): Promise<void> => {
    const current = readSlotMachineState(deps.itemId);
    const key = pendingSlotKey(deps.itemId, myId);
    if (current?.phase === 'spinning' || pendingSlotPlays.has(key)) {
      deps.onMessage?.('BUSY');
      return;
    }
    if (readSlotFundingConfig(deps.itemId)?.mode === 'shared') {
      flash = 'SHARED BANKROLL NEEDS AN AUTHORITATIVE SETTLEMENT SERVICE';
      deps.onMessage?.('SHARED OFF');
      render();
      return;
    }
    if (!readSlotFundingConfig(deps.itemId)) {
      flash = 'HOUSE SETUP REQUIRED';
      deps.onMessage?.('HOUSE SETUP');
      render();
      return;
    }
    if (readChips(myId) < denom) {
      flash = 'NOT ENOUGH CHIPS — VISIT THE CASHIER';
      deps.onMessage?.('NO CHIPS');
      render();
      return;
    }
    const seed = randomSlotSeed();
    const requestedAt = Date.now();
    const requestId = `${requestedAt.toString(36)}-${crypto.randomUUID()}`;
    const pending: PendingSlotPlay = {
      docEpoch: casinoDocEpoch(),
      machineId: deps.itemId,
      playerId: myId,
      requestId,
      seed,
      expiryTimer: 0,
    };
    pendingSlotPlays.set(key, pending);
    pending.expiryTimer = window.setTimeout(
      () => cancelUnacceptedSlotPlay(key, pending),
      SLOT_REQUEST_TTL_MS,
    );
    try {
      const displayedPaytable = readSlotOddsConfig(deps.itemId)?.paytable ?? DEFAULT_PAYTABLE;
      const [playerCommit, paytableHash] = await Promise.all([
        commitSlotSeed(seed),
        hashSlotPaytable(displayedPaytable),
      ]);
      if (pendingSlotPlays.get(key) !== pending) return;
      writeSlotPlayRequest(deps.itemId, {
        requestId,
        player: myId,
        bet: denom,
        requestedAt,
        playerCommit,
        paytableHash,
      });
      deps.onMessage?.('WAIT');
    } catch (error) {
      deletePendingSlotPlay(key);
      deps.onMessage?.('ERROR');
      throw error;
    }
    render();
  };

  const selectDenomination = (amount: number): void => {
    if (![1, 5, 25, 100].includes(amount)) return;
    denom = amount;
    deps.onDenominationChange?.(amount);
    render();
  };

  const cabinetSession: ActiveSlotMachineSession = {
    selectDenomination,
    pull(): void {
      pullLever().catch((err) => console.error('[slots] request failed:', err));
    },
  };

  const renderPaytable = (paytable: readonly SlotPayEntry[], house: boolean): void => {
    if (!panel) return;
    const rows = panel.querySelector<HTMLElement>('#sl-paytable');
    if (!rows) return;
    const fingerprint = JSON.stringify(paytable);
    if (fingerprint === renderedPaytable && house === renderedPaytableForHouse) return;
    renderedPaytable = fingerprint;
    renderedPaytableForHouse = house;
    rows.replaceChildren(...paytable.slice(0, 10).map((entry, index) => {
      const row = document.createElement('div');
      row.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:4px;min-height:20px;';
      const label = document.createElement('span');
      label.textContent = entry.label;
      row.appendChild(label);
      if (house) {
        const controls = document.createElement('span');
        controls.style.cssText = 'display:flex;align-items:center;gap:4px;';
        const minus = document.createElement('button');
        minus.type = 'button';
        minus.dataset.slotPayIndex = String(index);
        minus.dataset.slotPayDelta = '-1';
        minus.textContent = '−';
        const value = document.createElement('b');
        value.textContent = `${entry.multiplier}×`;
        const plus = document.createElement('button');
        plus.type = 'button';
        plus.dataset.slotPayIndex = String(index);
        plus.dataset.slotPayDelta = '1';
        plus.textContent = '+';
        for (const button of [minus, plus]) {
          button.style.cssText =
            `width:20px;height:20px;padding:0;background:rgba(212,168,75,.08);border:1px solid ${GT_DIM};color:${GT_GOLD};cursor:pointer;`;
        }
        controls.append(minus, value, plus);
        row.appendChild(controls);
      } else {
        const value = document.createElement('b');
        value.textContent = `${entry.multiplier}×`;
        row.appendChild(value);
      }
      return row;
    }));
  };

  const adjustPaytable = (index: number, delta: number): void => {
    if (!deps.isHouse() || !Number.isInteger(index) || !Number.isInteger(delta)) return;
    if (readSlotMachineState(deps.itemId)?.phase === 'spinning') {
      flash = 'ODDS ARE LOCKED DURING A SPIN';
      render();
      return;
    }
    const next = clonePaytable(readSlotOddsConfig(deps.itemId)?.paytable ?? DEFAULT_PAYTABLE);
    const entry = next[index];
    if (!entry) return;
    entry.multiplier = Math.max(0, Math.min(MAX_SLOT_MULTIPLIER, entry.multiplier + delta));
    const config = { paytable: next };
    if (!isSlotOddsConfig(config)) {
      flash = 'INVALID PAYTABLE';
      render();
      return;
    }
    writeSlotOddsConfig(deps.itemId, config);
  };

  const cycleFunding = (): void => {
    if (!deps.isHouse()) return;
    if (readSlotMachineState(deps.itemId)?.phase === 'spinning') {
      flash = 'FUNDING IS LOCKED DURING A SPIN';
      render();
      return;
    }
    const order: SlotFundingConfig['mode'][] = ['owner', 'machine'];
    const current = fundingConfig();
    const mode = order[(order.indexOf(current.mode) + 1) % order.length];
    writeSlotFundingConfig(deps.itemId, { mode, ownerId: myId });
  };

  const moveFunding = (direction: 'deposit' | 'withdraw'): void => {
    if (!deps.isHouse()) return;
    if (readSlotMachineState(deps.itemId)?.phase === 'spinning') {
      flash = 'BANKROLL TRANSFERS ARE LOCKED DURING A SPIN';
      render();
      return;
    }
    const ok = direction === 'deposit'
      ? depositSlotFunding(deps.itemId, myId, 100)
      : withdrawSlotFunding(deps.itemId, myId, 100);
    if (!ok) {
      flash = direction === 'deposit'
        ? 'DEPOSIT NEEDS 100 OWNER CHIPS'
        : 'WITHDRAW NEEDS 100 BANKROLL CHIPS';
      render();
    }
  };

  const render = (): void => {
    if (!panel) return;
    const state = readSlotMachineState(deps.itemId);
    const paytable = readSlotOddsConfig(deps.itemId)?.paytable ?? DEFAULT_PAYTABLE;
    const fingerprint = JSON.stringify(paytable);
    if (fingerprint !== paytableFingerprint) {
      paytableFingerprint = fingerprint;
      paytableRtp = computeRTP(paytable);
    }
    panel.querySelector<HTMLElement>('#sl-rtp')!.textContent =
      `THEORETICAL RTP ${paytableRtp.toFixed(2)}%`;
    panel.querySelector<HTMLElement>('#sl-service-status')!.textContent = flash;
    const house = deps.isHouse();
    renderPaytable(paytable, house);
    const owner = panel.querySelector<HTMLElement>('#sl-owner');
    if (owner) owner.style.display = house ? 'flex' : 'none';
    if (house) {
      const manual = panel.querySelector<HTMLButtonElement>('#sl-manual-croupier');
      if (manual) {
        manual.style.display = canRunCroupier() ? 'none' : '';
        const operator = readSlotFundingConfig(deps.itemId)?.ownerId === myId;
        const running = isManualSlotMachineRunning(deps.itemId, myId);
        manual.disabled = !operator || (running && state?.phase === 'spinning');
        manual.textContent = !operator
          ? 'MANUAL CROUPIER · BANKROLL OWNER ONLY'
          : running
            ? 'STOP MANUAL CROUPIER'
            : 'RUN MANUAL CROUPIER';
      }
      const funding = fundingConfig();
      const modeLabel: Record<SlotFundingConfig['mode'], string> = {
        owner: 'OWNER WALLET',
        machine: 'THIS MACHINE',
        shared: 'SHARED MACHINES',
      };
      const mode = panel.querySelector<HTMLButtonElement>('#sl-funding-mode');
      if (mode) mode.textContent = `SOURCE · ${modeLabel[funding.mode]}`;
      const balance = panel.querySelector<HTMLElement>('#sl-funding-balance');
      if (balance) {
        balance.textContent =
          `AVAILABLE BANKROLL: ${readSlotFundingBalance(deps.itemId, funding)} CHIPS`;
      }
      const transfer = funding.mode === 'machine';
      const deposit = panel.querySelector<HTMLButtonElement>('#sl-fund-deposit');
      const withdraw = panel.querySelector<HTMLButtonElement>('#sl-fund-withdraw');
      if (deposit) deposit.style.display = transfer ? '' : 'none';
      if (withdraw) withdraw.style.display = transfer ? '' : 'none';
    }
    flash = '';
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (serviceMode || event.repeat) return;
    const target = event.target;
    if (target instanceof Element
      && target.closest('button, input, textarea, select, a, [contenteditable="true"]')) return;
    const denominationByKey: Record<string, number> = {
      Digit1: 1, Numpad1: 1,
      Digit2: 5, Numpad2: 5,
      Digit3: 25, Numpad3: 25,
      Digit4: 100, Numpad4: 100,
    };
    const amount = denominationByKey[event.code];
    if (amount !== undefined) {
      event.preventDefault();
      selectDenomination(amount);
      return;
    }
    if (event.code !== 'Space') return;
    event.preventDefault();
    pullLever().catch((err) => console.error('[slots] request failed:', err));
  };

  return {
    mount(host: HTMLElement): void {
      if (deps.isHouse() && !readSlotFundingConfig(deps.itemId)) {
        writeSlotFundingConfig(deps.itemId, { mode: 'owner', ownerId: myId });
      }
      if (!serviceMode) {
        activeSlotMachineSessions.set(deps.itemId, cabinetSession);
        deps.onDenominationChange?.(denom);
        window.addEventListener('keydown', onKeyDown);
        return;
      }
      panel = document.createElement('div');
      panel.id = 'device-slot-machine-pane';
      panel.style.cssText = `
        position:absolute; top:48%; left:50%; transform:translate(-50%,-50%);
        width:390px; max-height:90vh; overflow-y:auto; box-sizing:border-box;
        padding:18px; display:flex; flex-direction:column; gap:12px;
        background:rgba(4,8,22,0.95); border:1px solid rgba(212,168,75,0.35);
        border-radius:12px; color:${GT_GOLD}; font-family:'SF Mono','Consolas',monospace;
        pointer-events:auto; box-shadow:0 12px 64px rgba(0,0,0,0.9);
      `;
      panel.innerHTML = `
        <div style="font-size:13px;font-weight:800;color:${GT_GOLD_BRIGHT};letter-spacing:2px;">🎰 SLOT MACHINE SERVICE</div>
        <div id="sl-service-status" style="min-height:14px;text-align:center;font-size:9px;font-weight:800;color:${GT_GOLD_BRIGHT};"></div>
        <div id="sl-rtp" style="font-size:9px;color:${GT_DIM};"></div>
        <div id="sl-paytable" style="display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;font-size:9px;color:#E8ECF2;"></div>
        <div id="sl-owner" style="display:none;flex-direction:column;gap:7px;padding-top:9px;border-top:1px solid rgba(212,168,75,.2);">
          <div style="font-size:9px;font-weight:800;letter-spacing:1px;">★ OWNER CONTROLS</div>
          <button id="sl-manual-croupier" style="padding:7px;background:rgba(0,192,96,.08);border:1px solid #00A060;color:#8FFFC0;font:800 9px inherit;cursor:pointer;">RUN MANUAL CROUPIER</button>
          <button id="sl-funding-mode" style="padding:7px;background:rgba(212,168,75,.08);border:1px solid #D4A84B;color:#F0C060;font:800 9px inherit;cursor:pointer;"></button>
          <div id="sl-funding-balance" style="font-size:9px;color:#E8ECF2;"></div>
          <div style="display:flex;gap:6px;">
            <button id="sl-fund-deposit" style="flex:1;padding:6px;background:rgba(0,230,118,.08);border:1px solid #00A060;color:#8FFFC0;font:800 9px inherit;cursor:pointer;">DEPOSIT 100</button>
            <button id="sl-fund-withdraw" style="flex:1;padding:6px;background:rgba(255,179,0,.08);border:1px solid #B07800;color:#FFD782;font:800 9px inherit;cursor:pointer;">WITHDRAW 100</button>
          </div>
          <button id="sl-reset-odds" style="padding:6px;background:transparent;border:1px solid ${GT_DIM};color:${GT_GOLD};font:800 9px inherit;cursor:pointer;">RESTORE DEFAULT ODDS</button>
          <div style="font-size:8px;color:${GT_DIM};">−/+ edits persist for this machine. Maximum liability is reserved before every spin.</div>
        </div>
        <div style="font-size:8px;color:${GT_DIM};text-align:center;">CLICK OUTSIDE THIS PANEL TO RETURN TO THE CABINET</div>
      `;
      panel.addEventListener('click', (event) => event.stopPropagation());
      panel.querySelector<HTMLElement>('#sl-paytable')!.addEventListener('click', (event) => {
        const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-slot-pay-index]');
        if (!button) return;
        adjustPaytable(Number(button.dataset.slotPayIndex), Number(button.dataset.slotPayDelta));
      });
      panel.querySelector<HTMLButtonElement>('#sl-funding-mode')!
        .addEventListener('click', cycleFunding);
      panel.querySelector<HTMLButtonElement>('#sl-manual-croupier')!
        .addEventListener('click', () => {
          if (!deps.isHouse() || canRunCroupier()) return;
          const running = isManualSlotMachineRunning(deps.itemId, myId);
          if (!setManualSlotMachineRunning(deps.itemId, myId, !running)) {
            flash = 'CROUPIER CONTROL IS BUSY OR AN ACTIVE WAGER MUST FINISH';
          }
          render();
        });
      panel.querySelector<HTMLButtonElement>('#sl-fund-deposit')!
        .addEventListener('click', () => moveFunding('deposit'));
      panel.querySelector<HTMLButtonElement>('#sl-fund-withdraw')!
        .addEventListener('click', () => moveFunding('withdraw'));
      panel.querySelector<HTMLButtonElement>('#sl-reset-odds')!
        .addEventListener('click', () => {
          if (!deps.isHouse() || readSlotMachineState(deps.itemId)?.phase === 'spinning') return;
          writeSlotOddsConfig(deps.itemId, { paytable: clonePaytable(DEFAULT_PAYTABLE) });
        });
      host.appendChild(panel);
      unsubscribe = subscribeCasino(render);
      render();
    },
    unmount(): void {
      if (activeSlotMachineSessions.get(deps.itemId) === cabinetSession) {
        const key = pendingSlotKey(deps.itemId, myId);
        const pending = pendingSlotPlays.get(key);
        if (pending) cancelUnacceptedSlotPlay(key, pending);
        activeSlotMachineSessions.delete(deps.itemId);
      }
      unsubscribe?.();
      unsubscribe = null;
      window.removeEventListener('keydown', onKeyDown);
      panel?.remove();
      panel = null;
    },
    update(_dt: number): void {},
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 🎲 Craps table (#69 G3)
// ══════════════════════════════════════════════════════════════════════════════

export interface CrapsUIDeps {
  /** Furniture item id — keys the table + bet records in the casino map. */
  itemId: string;
  /** Owner-equivalent predicate: the stickman side (house/venture). */
  isHouse: () => boolean;
}

/** Seconds the dice tumble after a settle lands. */
const CR_ROLL_SECS = 1.6;
const CR_BOARD_W = 360;
const CR_BOARD_H = 186;
const CR_GREEN = '#1B6B3A';
const CR_RED = '#7A1E1E';

interface CrapsRegion {
  x: number; y: number; w: number; h: number;
  label: string;
  fill: string | null;
  bet: { type: CrapsBet['type']; pick?: number };
}

/** Single source for drawing AND hit-testing the craps felt (CSS px). */
function crapsBoardRegions(): CrapsRegion[] {
  const r: CrapsRegion[] = [];
  r.push({ x: 6, y: 6, w: 232, h: 34, label: 'PASS LINE · 1:1', fill: null, bet: { type: 'pass' } });
  r.push({ x: 242, y: 6, w: 112, h: 34, label: "DON'T PASS", fill: CR_RED, bet: { type: 'dontpass' } });
  r.push({ x: 6, y: 44, w: 348, h: 44, label: 'FIELD · 2 3 4 9 10 11 12 · 2 & 12 DOUBLE', fill: null, bet: { type: 'field' } });
  [4, 5, 6, 8, 9, 10].forEach((n, i) => {
    r.push({
      x: 6 + i * 58, y: 92, w: 54, h: 46,
      label: String(n),
      fill: CR_GREEN,
      bet: { type: 'place', pick: n },
    });
  });
  r.push({ x: 6, y: 144, w: 170, h: 34, label: 'ANY 7 · 4:1', fill: null, bet: { type: 'anyseven' } });
  r.push({ x: 184, y: 144, w: 170, h: 34, label: 'ANY CRAPS · 7:1', fill: null, bet: { type: 'anycraps' } });
  return r;
}

/** Pip offsets (unit square −1..1) for a die face 1–6. */
const DIE_PIPS: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [[-0.5, -0.5], [0.5, 0.5]],
  3: [[-0.5, -0.5], [0, 0], [0.5, 0.5]],
  4: [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]],
  5: [[-0.5, -0.5], [0.5, -0.5], [0, 0], [-0.5, 0.5], [0.5, 0.5]],
  6: [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0], [0.5, 0], [-0.5, 0.5], [0.5, 0.5]],
};

/** Draw one white die with black pips, centred at (cx,cy), side `s`. */
function drawDie(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, value: number, tilt = 0): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  const r = s * 0.18;
  ctx.fillStyle = '#F4EFE2';
  ctx.strokeStyle = '#C9BE9E';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-s / 2 + r, -s / 2);
  ctx.arcTo(s / 2, -s / 2, s / 2, s / 2, r);
  ctx.arcTo(s / 2, s / 2, -s / 2, s / 2, r);
  ctx.arcTo(-s / 2, s / 2, -s / 2, -s / 2, r);
  ctx.arcTo(-s / 2, -s / 2, s / 2, -s / 2, r);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#23252E';
  const pipR = s * 0.09;
  for (const [px, py] of DIE_PIPS[value] ?? []) {
    ctx.beginPath();
    ctx.arc(px * s * 0.56, py * s * 0.56, pipR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * The craps table's focused UI (#69 G3): the two dice, the classic felt (pass /
 * don't pass / field / place 4-5-6-8-9-10 / any 7 / any craps), the ON/OFF point
 * puck, chip denominations, and the stickman controls. House-banked, exactly
 * like roulette: stakes leave your chips when they hit the felt; the stickman
 * (owner-equivalent client, or their robot) throws, and the settle write carries
 * the dice + payouts + the pruned felt for every client to converge on. Craps
 * carries state across rolls — a pass line rides its point, a place bet stays
 * working — so a bet you placed on a PRIOR window is locked (only what you put
 * down THIS window is yours to take back). Fairness is dev-phase trust; the
 * commit-reveal upgrade is G5 and the panel says so.
 */
export function createCrapsUI(deps: CrapsUIDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let diceCanvas: HTMLCanvasElement | null = null;
  let boardCanvas: HTMLCanvasElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let denom = 5;
  /** Round whose dice tumble was already started (never replay history). */
  let animRound = 0;
  /** Animation progress 0..1, or null when idle. */
  let animT: number | null = null;
  /** One-shot notice line, cleared on next render. */
  let flash = '';
  /** Bets I placed in the CURRENT betting window — the only ones UNDO/CLEAR may
   *  take back (standing pass/place bets from prior rolls are contract-locked). */
  let addedThisWindow: CrapsBet[] = [];
  let windowRound = 0;
  /** round → transcript verdict, so re-renders stamp the badge from cache
   *  instead of re-hashing the whole transcript every time (#87 review). */
  const verifiedVerdicts = new Map<number, boolean>();
  const myId = getPlayerId();
  const regions = crapsBoardRegions();

  const state = (): CrapsTableState | null => readCrapsTableState(deps.itemId);
  const phase = (): 'betting' | 'closing' | 'settled' => state()?.phase ?? 'betting';
  const point = (): number | null => state()?.point ?? null;
  const round = (): number => state()?.round ?? 1;
  const myBets = (): CrapsBet[] => readMyCrapsBets(deps.itemId, myId);
  const bettingOpen = (): boolean => {
    const s = state();
    if ((s?.phase ?? 'betting') !== 'betting') return false;
    return s?.phaseDeadline == null || Date.now() < s.phaseDeadline;
  };

  /** Reset the "mine this window" tracker whenever the betting window turns over
   *  (a new round after a settle) so contract bets from the last roll lock. */
  const syncWindow = (): void => {
    const r = round();
    if (r !== windowRound) {
      windowRound = r;
      addedThisWindow = [];
    }
  };

  // ── Bet placement (stakes move at placement time — see module doc) ─────────

  const placeBet = (bet: { type: CrapsBet['type']; pick?: number }): void => {
    if (!bettingOpen() || animT !== null) return;
    if (!canPlaceBet(bet.type, point())) {
      flash = 'THE LINE IS CLOSED — A POINT IS ON';
      render();
      return;
    }
    if (!spendChips(myId, denom)) {
      flash = 'NOT ENOUGH CHIPS — VISIT THE CASHIER';
      render();
      return;
    }
    const full: CrapsBet = { ...bet, amount: denom };
    writeMyCrapsBets(deps.itemId, myId, [...myBets(), full]);
    addedThisWindow.push(full);
  };

  const undoBet = (): void => {
    if (!bettingOpen() || addedThisWindow.length === 0) return;
    const bets = myBets();
    const last = bets[bets.length - 1];
    if (!last) return;
    creditChips(myId, last.amount);
    writeMyCrapsBets(deps.itemId, myId, bets.slice(0, -1));
    addedThisWindow.pop();
  };

  const clearBets = (): void => {
    if (!bettingOpen() || addedThisWindow.length === 0) return;
    const n = addedThisWindow.length;
    const refund = addedThisWindow.reduce((sum, b) => sum + b.amount, 0);
    if (refund > 0) creditChips(myId, refund);
    const bets = myBets();
    writeMyCrapsBets(deps.itemId, myId, bets.slice(0, Math.max(0, bets.length - n)));
    addedThisWindow = [];
  };

  // ── Stickman: the settle write is the roll's single source of truth ────────
  // Manual house controls (venture / legacy rooms with no live robot stickman)
  // delegate to the SAME settle/open the auto-stickman runs, with no deadline.

  const roll = (): void => {
    if (!deps.isHouse() || (phase() !== 'betting' && phase() !== 'closing')) return;
    rollAndSettleCraps(deps.itemId, round(), point());
  };

  const nextRoll = (): void => {
    if (!deps.isHouse() || phase() !== 'settled') return;
    openCrapsBetting(deps.itemId, round() + 1, point());
  };

  // ── Dice + puck drawing ────────────────────────────────────────────────────

  const DICE_W = 168, DICE_H = 84;

  const drawDiceForNow = (): void => {
    if (!diceCanvas) return;
    const ctx = diceCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0); // 2x backing, draw in CSS units
    ctx.clearRect(0, 0, DICE_W, DICE_H);
    const s = state();
    const tumbling = animT !== null;
    let d1 = 1, d2 = 1;
    if (tumbling) {
      d1 = 1 + Math.floor(Math.random() * 6);
      d2 = 1 + Math.floor(Math.random() * 6);
    } else if (s?.phase === 'settled' && s.dice) {
      [d1, d2] = s.dice;
    } else {
      // Idle / come-out with no roll yet — show a neutral pair of aces.
      d1 = d2 = 1;
    }
    const tilt = tumbling ? (Math.random() - 0.5) * 0.6 : 0;
    drawDie(ctx, 38, 42, 52, d1, tilt);
    drawDie(ctx, 100, 42, 52, d2, tumbling ? (Math.random() - 0.5) * 0.6 : 0);
    // ON/OFF point puck at the right.
    const pt = s?.point ?? null;
    const px = 148, py = 42, pr = 17;
    ctx.beginPath();
    ctx.arc(px, py, pr, 0, Math.PI * 2);
    ctx.fillStyle = pt != null ? '#F4EFE2' : '#12161F';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = pt != null ? '#00E676' : '#4A5560';
    ctx.stroke();
    ctx.fillStyle = pt != null ? '#12321E' : '#8894A2';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pt != null ? 'ON' : 'OFF', px, pt != null ? py - 4 : py);
    if (pt != null) {
      ctx.font = 'bold 13px monospace';
      ctx.fillText(String(pt), px, py + 6);
    }
  };

  // ── Board drawing + clicks ─────────────────────────────────────────────────

  const drawBoard = (): void => {
    if (!boardCanvas) return;
    const ctx = boardCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, CR_BOARD_W, CR_BOARD_H);
    ctx.fillStyle = '#14532D';
    ctx.fillRect(0, 0, CR_BOARD_W, CR_BOARD_H);
    const keyOf = (b: { type: string; pick?: number }) => `${b.type}:${b.pick ?? ''}`;
    const mineChips = new Map<string, number[]>();
    for (const b of myBets()) {
      const k = keyOf(b);
      mineChips.set(k, [...(mineChips.get(k) ?? []), b.amount]);
    }
    const otherChips = new Map<string, number[]>();
    for (const [pid, list] of Object.entries(readAllCrapsBets(deps.itemId))) {
      if (pid === myId) continue;
      for (const b of list) {
        const k = keyOf(b);
        otherChips.set(k, [...(otherChips.get(k) ?? []), b.amount]);
      }
    }
    // The rolled number flares once the dice have landed (informative even to a
    // spectator): the matching place box + the field when it hit.
    const settled = state()?.phase === 'settled' && animT === null;
    const rolled = settled ? state()!.result : null;
    const fieldSet = new Set([2, 3, 4, 9, 10, 11, 12]);
    for (const rg of regions) {
      ctx.fillStyle = rg.fill ?? '#1B6B3A';
      ctx.fillRect(rg.x, rg.y, rg.w, rg.h);
      const flare = rolled != null && (
        (rg.bet.type === 'place' && rg.bet.pick === rolled) ||
        (rg.bet.type === 'field' && fieldSet.has(rolled)) ||
        (rg.bet.type === 'anyseven' && rolled === 7) ||
        (rg.bet.type === 'anycraps' && (rolled === 2 || rolled === 3 || rolled === 12))
      );
      if (flare) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#F0C060';
        ctx.strokeRect(rg.x + 1.5, rg.y + 1.5, rg.w - 3, rg.h - 3);
      } else {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(240, 224, 180, 0.75)';
        ctx.strokeRect(rg.x, rg.y, rg.w, rg.h);
      }
      ctx.fillStyle = '#F5EFDF';
      ctx.font = `bold ${rg.bet.type === 'place' ? 17 : 10}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const cy = rg.bet.type === 'place' ? rg.y + 16 : rg.y + rg.h / 2;
      ctx.fillText(rg.label, rg.x + rg.w / 2, cy);
      if (rg.bet.type === 'place') {
        ctx.font = '7px monospace';
        ctx.fillStyle = 'rgba(240,224,180,0.7)';
        ctx.fillText(
          rg.bet.pick === 6 || rg.bet.pick === 8 ? '7:6' : rg.bet.pick === 5 || rg.bet.pick === 9 ? '7:5' : '9:5',
          rg.x + rg.w / 2, rg.y + 32,
        );
      }
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
    const x = ((e.clientX - rect.left) / rect.width) * CR_BOARD_W;
    const y = ((e.clientY - rect.top) / rect.height) * CR_BOARD_H;
    const hit = regions.find((rg) => x >= rg.x && x < rg.x + rg.w && y >= rg.y && y < rg.y + rg.h);
    if (hit) placeBet(hit.bet);
  };

  // ── Status line ────────────────────────────────────────────────────────────

  const computeStatus = (): { line: string; color: string } => {
    const s = state();
    const p = phase();
    const staked = myBets().reduce((sum, b) => sum + b.amount, 0);
    if (animT !== null || p === 'closing'
        || (p === 'betting' && s?.phaseDeadline != null && Date.now() >= s.phaseDeadline)) {
      return { line: 'NO MORE BETS — THE DICE ARE OUT…', color: CH_PINK };
    }
    if (p === 'settled' && s?.dice != null && s.result != null) {
      const won = s.payouts?.[myId] ?? 0;
      // s.sevenOut = a point-phase 7 (hand over); a come-out 7 is a natural (win),
      // not a seven-out, though both leave the post-roll point null.
      const line = `● ${s.dice[0]}+${s.dice[1]} = ${s.result}`
        + (s.sevenOut ? ' — SEVEN OUT' : '')
        + (staked > 0 || won > 0 ? (won > 0 ? ' — YOU WIN' : '') : '');
      return { line, color: won > 0 ? '#00E676' : GT_GOLD_BRIGHT };
    }
    const chips = readChips(myId);
    const remain = s?.phaseDeadline != null
      ? Math.max(0, Math.ceil((s.phaseDeadline - Date.now()) / 1000))
      : null;
    const pt = point();
    const head = pt == null ? 'COME OUT — PLACE YOUR BETS' : `POINT IS ${pt} — PLACE YOUR BETS`;
    const line = head
      + (remain != null ? ` · ${remain}s` : '')
      + (chips <= 0 && staked === 0 ? ' · VISIT THE CASHIER FOR CHIPS' : '');
    return { line, color: GT_GOLD_BRIGHT };
  };

  const syncStatusEl = (): void => {
    const el = panel?.querySelector<HTMLDivElement>('#cr-status');
    if (!el) return;
    const { line, color } = computeStatus();
    el.textContent = line;
    el.style.color = color;
  };

  const render = (): void => {
    if (!panel) return;
    syncWindow();
    const s = state();
    const p = phase();
    const chips = readChips(myId);
    const bets = myBets();
    const house = deps.isHouse();
    const rolling = animT !== null;
    const autoRun = isCroupierLive(deps.itemId);
    // 🎲🔗 #69 G5 seam: the house-only settlement toggle (local / optional Chia).
    const backendPref = readCrapsBackendPref(deps.itemId);
    const backendObj = crapsBackend(backendPref);
    const backendReady = backendObj.isAvailable();
    // 🎲🔀 The house-only fairness-mode toggle (rng / commit-reveal / multiparty /
    // block-beacon), per-table override or the global default.
    const fairnessMode = readCrapsFairnessPref(deps.itemId) ?? getCrapsFairnessMode();
    const fairInfo = FAIRNESS_MODES[fairnessMode];
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
        <span style="font-size:12px; font-weight:800; color:${GT_GOLD_BRIGHT}; letter-spacing:1px;">🎲 CRAPS</span>
        <span style="font-size:9px; color:rgba(212,168,75,0.5);">ESC / WASD / CLICK AWAY TO STEP BACK</span>
      </div>
      <div id="cr-status" style="font-size:11px; font-weight:800; letter-spacing:1px; color:${statusColor};">${statusLine}</div>
      ${flash ? `<div style="font-size:10px; font-weight:800; color:#FF8A80; letter-spacing:1px;">${flash}</div>` : ''}
      <div style="display:flex; gap:14px; align-items:flex-start;">
        <div style="display:flex; flex-direction:column; gap:6px; flex:none;">
          <canvas id="cr-dice" width="${DICE_W * 2}" height="${DICE_H * 2}"
            style="width:${DICE_W}px; height:${DICE_H}px; background:rgba(0,0,0,0.25); border-radius:8px;"></canvas>
        </div>
        <div style="display:flex; flex-direction:column; gap:6px; min-width:0; flex:1;">
          <div style="font-size:10px; color:${GT_DIM}; letter-spacing:1.5px;">YOUR CHIPS — COUNT THEM</div>
          <canvas id="cr-rack" width="380" height="132" style="width:190px; height:66px;"></canvas>
          <div style="font-size:10px; color:${GT_DIM}; letter-spacing:1.5px;">ON THE FELT</div>
          <canvas id="cr-felt-rack" width="380" height="88" style="width:190px; height:44px;"></canvas>
          ${p === 'settled' && !rolling && (s?.payouts?.[myId] ?? 0) > 0 ? `
          <div style="font-size:10px; color:#00E676; letter-spacing:1.5px;">YOUR WIN</div>
          <canvas id="cr-won" width="380" height="88" style="width:190px; height:44px;"></canvas>` : ''}
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:8px;">
        <span style="font-size:10px; color:${GT_DIM}; letter-spacing:1.5px;">CHIP:</span>
        ${[1, 5, 25, 100].map(denomBtn).join('')}
        <span style="flex:1;"></span>
        ${btn('cr-undo', 'UNDO', !bettingOpen() || rolling || addedThisWindow.length === 0, 'Take back the last chip you placed this window')}
        ${btn('cr-clear', 'CLEAR', !bettingOpen() || rolling || addedThisWindow.length === 0, 'Take back every chip you placed this window')}
      </div>
      <canvas id="cr-board" width="${CR_BOARD_W * 2}" height="${CR_BOARD_H * 2}"
        style="width:${CR_BOARD_W}px; height:${CR_BOARD_H}px; align-self:center; border:1px solid rgba(212,168,75,0.35); border-radius:6px; cursor:${bettingOpen() && !rolling ? 'pointer' : 'default'};"></canvas>
      <div style="display:flex; gap:8px; justify-content:flex-end; align-items:center;">
        ${autoRun
          ? `<span style="font-size:9.5px; color:${CH_GOLD};">🤖 THE ROBO-STICKMAN RUNS THIS TABLE</span>`
          : house
          ? (p === 'settled'
            ? btn('cr-next', 'NEXT ROLL', rolling, 'Open the felt for the next roll')
            : btn('cr-roll', '🎲 ROLL', rolling, 'Close betting and throw the dice'))
          : `<span style="font-size:9.5px; color:${GT_DIM};">${p === 'settled' && !rolling ? 'WAITING FOR THE STICKMAN TO OPEN THE NEXT ROLL' : 'THE HOUSE THROWS WHEN BETS ARE DOWN'}</span>`}
      </div>
      ${house ? `
      <div style="display:flex; gap:8px; justify-content:space-between; align-items:center;">
        <span style="font-size:9px; color:${GT_DIM}; letter-spacing:1.5px;">SETTLEMENT · HOUSE</span>
        <button id="cr-backend" title="How this table settles: LOCAL play chips, or the optional Chia gaming backend (per-player↔house state channels sharing one fair dice). Off by default; the in-world game is identical either way. Selecting Chia before it is wired keeps playing on LOCAL." style="
          padding:4px 9px; background:rgba(212,168,75,0.08); border:1px solid rgba(212,168,75,${backendPref === 'chia' ? '0.55' : '0.4'});
          border-radius:6px; color:${backendPref === 'chia' && !backendReady ? '#FFC107' : GT_GOLD_BRIGHT};
          font-family:inherit; font-size:9px; font-weight:800; letter-spacing:1px; cursor:pointer;">
          ${backendObj.label.toUpperCase()}${backendPref === 'chia' && !backendReady ? ' · FALLS BACK TO LOCAL' : ''}
        </button>
      </div>
      <div style="display:flex; gap:8px; justify-content:space-between; align-items:center;">
        <span style="font-size:9px; color:${GT_DIM}; letter-spacing:1.5px;">FAIRNESS · HOUSE</span>
        <button id="cr-fairness" title="${fairInfo.blurb}${fairInfo.needsSecondParty || fairInfo.needsChain ? ' — DEV: entropy/beacon simulated locally until the network/chain half is wired' : ''}" style="
          padding:4px 9px; background:rgba(212,168,75,0.08); border:1px solid rgba(212,168,75,${fairnessMode === 'rng' ? '0.4' : '0.55'});
          border-radius:6px; color:${fairnessMode === 'rng' ? GT_GOLD_BRIGHT : '#7CF5B0'};
          font-family:inherit; font-size:9px; font-weight:800; letter-spacing:1px; cursor:pointer;">
          ${fairInfo.label.toUpperCase()}${fairInfo.instant ? '' : ' · ~1 BLOCK'}
        </button>
      </div>` : ''}
      ${p === 'settled' && !rolling && s?.fairness ? `
      <div id="cr-fair-badge" style="font-size:9px; color:#7CF5B0; letter-spacing:1px;">
        🔒 provably fair · ${(s.fairness.mode as string).toUpperCase()}${s.fairness.simulated ? ' (dev-simulated)' : ''} · verifying…
      </div>` : ''}
      <div style="font-size:9px; color:#33404E; border-top:1px solid rgba(212,168,75,0.12); padding-top:8px; line-height:1.6;">
        BANK CRAPS · pass/don't-pass 1:1 (come-out only) · field 1:1, 2 &amp; 12 pay 2:1 · place 4/10 9:5, 5/9 7:5, 6/8 7:6
        · any 7 4:1 · any craps 7:1 · place bets ride until a 7, the pass line rides its point
        · house-banked, the stickman's throw settles the roll · fair-dice upgrade coming
        · chips are physical at the table — count them; the CASHIER's screen shows the number
      </div>
    `;
    panel.querySelectorAll<HTMLButtonElement>('[data-denom]').forEach((b) => {
      b.addEventListener('click', () => { denom = Number(b.dataset.denom); render(); });
    });
    panel.querySelector<HTMLButtonElement>('#cr-undo')?.addEventListener('click', () => undoBet());
    panel.querySelector<HTMLButtonElement>('#cr-clear')?.addEventListener('click', () => clearBets());
    panel.querySelector<HTMLButtonElement>('#cr-roll')?.addEventListener('click', () => { roll(); });
    panel.querySelector<HTMLButtonElement>('#cr-next')?.addEventListener('click', () => nextRoll());
    panel.querySelector<HTMLButtonElement>('#cr-fairness')?.addEventListener('click', () => {
      if (!deps.isHouse()) return;
      const order: FairnessMode[] = ['rng', 'commit-reveal', 'multiparty', 'block-beacon'];
      const next = order[(order.indexOf(fairnessMode) + 1) % order.length];
      writeCrapsFairnessPref(deps.itemId, next);
      render();
    });
    // 🔒 Verify a settled roll's transcript and stamp the badge (async — anyone
    // can re-derive the dice from the public transcript). The verdict is cached
    // per round, and the stamp re-queries the LIVE badge and re-checks the
    // round (#87 review): render() replaces panel.innerHTML, so a node captured
    // before the await would be detached — and a slow promise from round N must
    // never stamp round N+1's badge.
    if (p === 'settled' && !rolling && s?.fairness && s.dice) {
      const dice = s.dice;
      const fx = s.fairness;
      const forRound = s.round;
      const stamp = (ok: boolean): void => {
        if (!panel || round() !== forRound) return;
        const badge = panel.querySelector<HTMLDivElement>('#cr-fair-badge');
        if (!badge) return;
        badge.textContent = `🔒 provably fair · ${(fx.mode as string).toUpperCase()}`
          + (fx.simulated ? ' (dev-simulated)' : '')
          + (ok ? ' · ✓ verified' : ' · ✗ FAILED');
        badge.style.color = ok ? '#7CF5B0' : '#FF8A80';
      };
      const cached = verifiedVerdicts.get(forRound);
      if (cached !== undefined) {
        stamp(cached);
      } else {
        verifyTranscript(fx, deps.itemId, forRound, dice).then((ok) => {
          if (verifiedVerdicts.size > 32) verifiedVerdicts.clear(); // old rounds never re-render
          verifiedVerdicts.set(forRound, ok);
          stamp(ok);
        });
      }
    }
    panel.querySelector<HTMLButtonElement>('#cr-backend')?.addEventListener('click', () => {
      if (!deps.isHouse()) return;
      writeCrapsBackendPref(deps.itemId, backendPref === 'chia' ? 'local' : 'chia');
      render();
    });
    diceCanvas = panel.querySelector<HTMLCanvasElement>('#cr-dice');
    boardCanvas = panel.querySelector<HTMLCanvasElement>('#cr-board');
    boardCanvas?.addEventListener('click', onBoardClick);
    flash = '';
    drawDiceForNow();
    drawBoard();
    const paintTray = (id: string, tray: number[], cssW: number, cssH: number, emptyText?: string) => {
      const cv = panel!.querySelector<HTMLCanvasElement>(`#${id}`);
      const c2 = cv?.getContext('2d');
      if (!cv || !c2) return;
      c2.setTransform(2, 0, 0, 2, 0, 0);
      c2.clearRect(0, 0, cssW, cssH);
      drawChips(c2, tray, 0, 0, cssW, cssH, { emptyText });
    };
    paintTray('cr-rack', chipsFor(chips), 190, 66, 'NO CHIPS — VISIT THE CASHIER');
    paintTray('cr-felt-rack', bets.map((b) => b.amount), 190, 44, 'NOTHING ON THE FELT');
    if (p === 'settled' && !rolling) {
      paintTray('cr-won', chipsFor(s?.payouts?.[myId] ?? 0), 190, 44);
    }
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = 'device-craps-pane';
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
      // Never replay a throw that landed before we walked up.
      const s = state();
      animRound = s?.phase === 'settled' ? s.round : 0;
      windowRound = s?.round ?? 0;
      animT = null;
      unsubscribe = subscribeCasino(() => {
        // A fresh settle write starts the dice tumble; everything else repaints.
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
      diceCanvas = null;
      boardCanvas = null;
    },
    update(dt: number): void {
      const s = state();
      if (animT === null && s?.phaseDeadline != null && s.phase !== 'settled') {
        syncStatusEl();
      }
      if (animT === null) return;
      animT = Math.min(1, animT + Math.max(0, dt) / CR_ROLL_SECS);
      if (animT >= 1) {
        animT = null;
        render(); // reveal the dice + payouts + settled balances
      } else {
        drawDiceForNow(); // tumble
      }
    },
  };
}
