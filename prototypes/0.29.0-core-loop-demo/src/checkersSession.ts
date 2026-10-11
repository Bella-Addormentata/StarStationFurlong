/**
 * 🎲 Fully-3D checkers (#227) — the live layer that plays ON the table.
 *
 * Retires the checkers popup. While a game table holds a checkers game and
 * shows its board face, the focused player gets:
 *  - a transparent capture layer over the 3D view: clicks are raycast from
 *    the focus camera onto the board face (GameTableTopHandle.pickCell) and
 *    run through games/checkersTable.ts clickCell — take a side by clicking
 *    one of its pieces, then click a piece and its destination to move;
 *  - move marks painted on the board face for THIS player only (selection,
 *    destinations, movable pieces, hover);
 *  - a one-line status strip at the top of the screen (no panel);
 *  - the ⚙ token on the table, which opens a small options card: seats,
 *    VS BOT, FORFEIT, FLIP TABLE, RESET TABLE (#226's settings button).
 * The pieces themselves are 3D meshes World lays out for everyone from the
 * doc (the in-world mirror), so spectators see the same game.
 *
 * Checkers is turn-based, so it needs no tick lane: every transition is a
 * whole-value write to the room doc's `games` map (games/gamesDoc.ts), and
 * every repaint is observer-driven.
 *
 * Mounted by devices.ts createGameTableUI, which owns the table's other
 * faces (game picker, chess, card felt) and swaps this layer in and out.
 * World builds it (this module imports editMode, which devices.ts cannot
 * without an import cycle).
 */

import * as THREE from 'three';
import { applyMove, chooseBotMove } from './games/checkers';
import type { CheckersColor, CheckersState } from './games/checkers';
import {
  boardMarks,
  canResetTable,
  canStartBot,
  clickCell,
  forfeit,
  isMyTurn,
  pruneSelection,
  seatOf,
  standIndexFor,
  startBot,
  statusLine,
} from './games/checkersTable';
import { clearTable, readGame, readPlayerDisplayName, subscribeGames, writeGame } from './games/gamesDoc';
import type { GameTableTopHandle } from './devices';
import { deviceFocus } from './deviceFocus';
import { canEditRoom } from './editMode';
import { escapeHtml } from './htmlEscape';
import { getPlayerId } from './identity';

/** What createGameTableUI drives: mount while checkers owns the board face. */
export interface CheckersTableLayer {
  /** Attach the capture layer + HUD. `refresh` asks the owning game-table UI
   *  to re-pick its face (after a flip or a reset leaves checkers). */
  mount(host: HTMLElement, refresh: () => void): void;
  unmount(): void;
  /** Bot pump (runs only while mounted — the documented v1 sleep rule). */
  update(dt: number): void;
  /** The checkers half of the table's RESET gate. */
  canReset(): boolean;
}

export interface CheckersTableDeps {
  itemId: string;
  top: GameTableTopHandle | null;
  /** Which end this focus looks from (furniture.ts gameTableStands index:
   *  0 = −z, red's end; 1 = +z, black's end). */
  end?: 0 | 1;
  /** Called when the local player takes the side whose end is NOT `end`,
   *  so World can walk them round and look from their own side. */
  onSeatTaken?: () => void;
}

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
/** Bot think-delay (s) — the popup's value. */
const BOT_DELAY = 0.7;

/** Paint a table's board face for everyone from the doc: pieces plus the
 *  turn strip. World and the dev menu call this for every game table. */
export function paintCheckersTable(top: GameTableTopHandle, itemId: string): void {
  const s = readGame(itemId);
  top.setBoard(s?.board ?? null, s?.status === 'playing' ? s.turn : null);
}

export function createCheckersTableLayer(deps: CheckersTableDeps): CheckersTableLayer {
  const myId = getPlayerId();
  let capture: HTMLDivElement | null = null;
  let strip: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let refreshOwner: (() => void) | null = null;
  let selected: number | null = null;
  let hover: number | null = null;
  let settingsOpen = false;
  let botTimer = 0;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const state = (): CheckersState | null => readGame(deps.itemId);

  /** Write a transition; when it seats me at the other end, hand off to
   *  World to walk me round (my own pieces nearest, #227). */
  const commit = (next: CheckersState): void => {
    const before = state();
    writeGame(deps.itemId, next);
    const seat = seatOf(next, myId);
    if (seat && (!before || seatOf(before, myId) !== seat)
      && deps.end !== undefined && standIndexFor(seat) !== deps.end) {
      deps.onSeatTaken?.();
    }
  };
  const mayEdit = (): boolean => canEditRoom().ok;
  const canReset = (): boolean => canResetTable(state(), myId, mayEdit());

  /** Aim the raycaster from the live (focus) camera through a pointer. */
  const aim = (e: MouseEvent): boolean => {
    const cam = window.gameRenderer?.camera;
    if (!cam) return false;
    const el = window.gameRenderer?.renderer?.domElement;
    const rect = el?.getBoundingClientRect() ?? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    if (rect.width <= 0 || rect.height <= 0) return false;
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    return true;
  };

  const paintMarks = (): void => {
    deps.top?.setMarks(boardMarks(state(), myId, selected, hover));
  };

  const seatName = (s: CheckersState, color: CheckersColor): string => {
    if (color === 'black' && s.bot) return 'BOT';
    const id = s.players[color];
    if (!id) return 'OPEN';
    const name = escapeHtml(readPlayerDisplayName(id).toUpperCase());
    return id === myId ? `${name} (YOU)` : name;
  };

  const button = (id: string, label: string, enabled: boolean, title: string): string => `
    <button data-act="${id}" ${enabled ? '' : 'disabled'} title="${title}" style="
      padding: 7px 10px; border-radius: 6px; font: inherit; font-size: 10px;
      font-weight: 800; letter-spacing: 1.5px;
      background: rgba(212, 168, 75, ${enabled ? '0.12' : '0.04'});
      border: 1px solid rgba(212, 168, 75, ${enabled ? '0.5' : '0.18'});
      color: ${enabled ? GOLD_BRIGHT : DIM};
      cursor: ${enabled ? 'pointer' : 'not-allowed'};
    ">${label}</button>`;

  const render = (): void => {
    if (!strip || !card) return;
    const s = state();
    selected = pruneSelection(s, myId, selected);
    paintMarks();
    const live = s?.status === 'playing';
    const over = s?.status === 'red-won' || s?.status === 'black-won';
    strip.innerHTML = `
      <div style="font-size:12px; font-weight:800; letter-spacing:1.5px; color:${
        over ? '#00E676' : live ? GOLD_BRIGHT : GOLD
      };">${statusLine(s, myId)}</div>
      <div style="font-size:9px; letter-spacing:1px; color:rgba(212,168,75,0.6); margin-top:4px;">
        ${s ? `RED — ${seatName(s, 'red')} · BLACK — ${seatName(s, 'black')} · ` : ''}⚙ ON THE TABLE FOR OPTIONS · ESC TO STEP BACK
      </div>`;

    card.style.display = settingsOpen ? 'flex' : 'none';
    if (!settingsOpen || !s) return;
    const seat = seatOf(s, myId);
    const resetOk = canReset();
    const flipping = deps.top?.isFlipping() ?? true;
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <span style="font-size:11px; font-weight:800; letter-spacing:1.5px; color:${GOLD_BRIGHT};">⚙ CHECKERS TABLE</span>
        ${button('close', '✕', true, 'Close options')}
      </div>
      <div style="font-size:10px; line-height:1.8; letter-spacing:1px;">
        <div><span style="color:#C43C3C;">●</span> RED — ${seatName(s, 'red')}</div>
        <div><span style="color:#9AA3B2;">●</span> BLACK — ${seatName(s, 'black')}</div>
        <div style="color:rgba(212,168,75,0.55);">American rules · captures are forced · black moves first</div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">
        ${canStartBot(s, myId) ? button('bot', '⚙ VS BOT', true, 'Play red against a simple bot') : ''}
        ${live && seat ? button('forfeit', 'FORFEIT', true, 'Concede the game') : ''}
        ${button('flip', '⟲ FLIP TABLE', !!deps.top && !flipping, 'Turn the top over to the card felt')}
        ${button('reset', 'RESET TABLE', resetOk,
          resetOk ? 'Clear the table back to the game menu' : 'Players at the table or anyone who can edit this room can reset a live game')}
      </div>`;
  };

  const act = (what: string): void => {
    const s = state();
    if (what === 'close') settingsOpen = false;
    else if (what === 'bot' || what === 'forfeit') {
      // Both hand the game back to the board, so the card gets out of the way.
      const next = !s ? null : what === 'bot' ? startBot(s, myId) : forfeit(s, myId);
      settingsOpen = false;
      if (next) {
        commit(next); // observer renders
        return;
      }
    } else if (what === 'flip') {
      if (!deps.top || deps.top.isFlipping()) return;
      settingsOpen = false;
      selected = null;
      deps.top.setMarks(null);
      // Keep the owner's refresh: hiding this layer (next line) unmounts it,
      // which drops refreshOwner before the flip lands.
      const refresh = refreshOwner;
      deps.top.flip(() => refresh?.());
      refresh?.(); // the owner hides this layer while the top swings
      return;
    } else if (what === 'reset') {
      if (!canReset()) return;
      settingsOpen = false;
      selected = null;
      clearTable(deps.itemId); // observer: the owner swaps to the game menu
      return;
    }
    render();
  };

  const onMove = (e: PointerEvent): void => {
    if (!capture || !deps.top || !aim(e)) return;
    const onGear = deps.top.pickSettings(ray);
    const cell = onGear ? null : deps.top.pickCell(ray);
    if (cell !== hover) {
      hover = cell;
      paintMarks();
    }
    const marks = boardMarks(state(), myId, selected, hover);
    capture.style.cursor = onGear || marks.hover !== null ? 'pointer' : 'default';
  };

  const onClick = (e: MouseEvent): void => {
    e.stopPropagation();
    if (!deps.top || !aim(e)) return;
    if (deps.top.pickSettings(ray)) {
      settingsOpen = !settingsOpen;
      render();
      return;
    }
    const cell = deps.top.pickCell(ray);
    if (cell === null) {
      // Off the board: close the options first, else step back from the
      // table (the canvas click-away every focused device honours).
      if (settingsOpen) {
        settingsOpen = false;
        render();
      } else {
        deviceFocus.release();
      }
      return;
    }
    const result = clickCell(state(), myId, selected, cell);
    selected = result.selected;
    if (result.write) commit(result.write); // observer renders
    else render();
  };

  return {
    mount(host: HTMLElement, refresh: () => void): void {
      refreshOwner = refresh;
      selected = null;
      hover = null;
      settingsOpen = false;
      botTimer = 0;
      capture = document.createElement('div');
      capture.id = 'checkers3d-capture';
      capture.style.cssText = 'position:absolute; inset:0; pointer-events:auto; background:transparent;';
      capture.addEventListener('click', onClick);
      capture.addEventListener('pointermove', onMove);
      capture.addEventListener('pointerleave', () => {
        hover = null;
        paintMarks();
      });

      const shell = `
        position:absolute; left:50%; transform:translateX(-50%);
        background:rgba(4, 8, 22, 0.88); border:1px solid rgba(212, 168, 75, 0.28);
        border-radius:10px; box-shadow:0 8px 40px rgba(0,0,0,0.7);
        color:${GOLD}; font-family:'SF Mono', 'Monaco', 'Consolas', monospace;
        box-sizing:border-box; pointer-events:auto;`;
      strip = document.createElement('div');
      strip.id = 'checkers3d-status';
      strip.style.cssText = `${shell} top:16px; padding:10px 18px; text-align:center; max-width:calc(100vw - 32px);`;
      strip.addEventListener('click', (e) => e.stopPropagation());
      card = document.createElement('div');
      card.id = 'checkers3d-options';
      card.style.cssText = `${shell} bottom:24px; width:min(360px, calc(100vw - 32px)); padding:14px; flex-direction:column; gap:12px; display:none;`;
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
        if (b && !b.disabled) act(b.dataset.act ?? '');
      });
      host.append(capture, strip, card);
      unsubscribe = subscribeGames(() => render());
      render();
    },

    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      capture?.remove();
      strip?.remove();
      card?.remove();
      capture = strip = card = null;
      refreshOwner = null;
      selected = null;
      hover = null;
      deps.top?.setMarks(null);
    },

    update(dt: number): void {
      // The red claimant's client plays the bot's black side.
      const s = state();
      if (s && s.bot && s.status === 'playing' && s.turn === 'black' && s.players.red === myId && !isMyTurn(s, myId)) {
        botTimer += dt;
        if (botTimer >= BOT_DELAY) {
          botTimer = 0;
          const move = chooseBotMove(s);
          if (move) writeGame(deps.itemId, applyMove(s, move));
        }
      } else botTimer = 0;
    },

    canReset,
  };
}
