/**
 * ♟ Fully-3D chess — the live layer that plays chess ON the table.
 *
 * Retires the chess panel the way checkersSession.ts (#227) retired the
 * checkers popup. While a game table holds a chess game and shows its board
 * face, the focused player gets:
 *  - a transparent capture layer over the 3D view: clicks are raycast from
 *    the focus camera onto the board face (GameTableTopHandle.pickCell) and
 *    run through games/chessTable.ts clickChessCell — take a side by
 *    clicking one of its pieces, then click a piece and its destination;
 *  - move marks painted on the board face for THIS player only (selection,
 *    destinations, movable pieces, hover);
 *  - a one-line status strip at the top of the screen (no panel);
 *  - the ⚙ token on the table, which opens a small options card: seats,
 *    VS BOT, the promotion piece, FORFEIT, FLIP TABLE, RESET TABLE.
 * The pieces themselves are 3D meshes World lays out for everyone from the
 * doc (paintGameTable below), with the last move and a checked king echoed
 * on the wood, so spectators see the same game.
 *
 * Chess is turn-based, so it needs no tick lane: every transition is a
 * whole-value write to the room doc's `games` map (games/gamesDoc.ts), and
 * every repaint is observer-driven. The stored ChessState is unchanged.
 *
 * Mounted by devices.ts createGameTableUI beside the checkers layer; World
 * builds it (this module imports editMode, which devices.ts cannot without
 * an import cycle).
 */

import * as THREE from 'three';
import { applyChessMove, chooseChessBotMove, legalChessMoves } from './games/chess';
import type { ChessColor, ChessPromotion, ChessState } from './games/chess';
import {
  DEFAULT_PROMOTION,
  PROMOTION_CHOICES,
  canResetChessTable,
  canStartChessBot,
  checkSquare,
  chessBoardMarks,
  chessSeatOf,
  chessStandIndexFor,
  chessStatusLine,
  clickChessCell,
  forfeitChess,
  isMyChessTurn,
  pruneChessSelection,
  startChessBot,
} from './games/chessTable';
import { clearTable, readPlayerDisplayName, readTable, subscribeGames, writeGame } from './games/gamesDoc';
import type { BoardGameTableLayer, GameTableTopHandle } from './devices';
import { paintCheckersTable } from './checkersSession';
import { deviceFocus } from './deviceFocus';
import { canEditRoom } from './editMode';
import { escapeHtml } from './htmlEscape';
import { getPlayerId } from './identity';

export interface ChessTableDeps {
  itemId: string;
  top: GameTableTopHandle | null;
  /** Which end this focus looks from (furniture.ts gameTableStands index:
   *  0 = −z, white's end; 1 = +z, black's end). */
  end?: 0 | 1;
  /** Called when the local player takes the side whose end is NOT `end`,
   *  so World can walk them round and look from their own side. */
  onSeatTaken?: () => void;
}

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
/** Bot think-delay (s) — the old panel's value. */
const BOT_DELAY = 0.8;

const PROMO_GLYPH: Record<ChessPromotion, string> = { queen: '♕', rook: '♖', bishop: '♗', knight: '♘' };

/** The local player's promotion piece. Module-level so it survives the
 *  layer being rebuilt per focus; a per-viewer preference, never synced. */
let promotionChoice: ChessPromotion = DEFAULT_PROMOTION;

function readChess(itemId: string): ChessState | null {
  const t = readTable(itemId);
  return t?.kind === 'chess' ? t.state : null;
}

/** Paint a table's board face for everyone from the doc — whichever board
 *  game lives there: chess pieces + echo, else checkers (paintCheckersTable,
 *  which also clears a stale chess set). World and the dev menu call this
 *  for every game table. */
export function paintGameTable(top: GameTableTopHandle, itemId: string): void {
  const s = readChess(itemId);
  if (!s) {
    paintCheckersTable(top, itemId);
    return;
  }
  top.setChess(s.board, s.status === 'playing' ? s.turn : null, { last: s.last, check: checkSquare(s) });
}

export function createChessTableLayer(deps: ChessTableDeps): BoardGameTableLayer {
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

  const state = (): ChessState | null => readChess(deps.itemId);

  /** Write a transition; when it seats me at the other end, hand off to
   *  World to walk me round (my own pieces nearest). */
  const commit = (next: ChessState): void => {
    const before = state();
    writeGame(deps.itemId, next);
    const seat = chessSeatOf(next, myId);
    if (seat && (!before || chessSeatOf(before, myId) !== seat)
      && deps.end !== undefined && chessStandIndexFor(seat) !== deps.end) {
      deps.onSeatTaken?.();
    }
  };
  const mayEdit = (): boolean => canEditRoom().ok;
  const canReset = (): boolean => canResetChessTable(state(), myId, mayEdit());

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
    deps.top?.setMarks(chessBoardMarks(state(), myId, selected, hover));
  };

  const seatName = (s: ChessState, color: ChessColor): string => {
    if (color === 'black' && s.bot) return 'BOT';
    const id = s.players[color];
    if (!id) return 'OPEN';
    const name = escapeHtml(readPlayerDisplayName(id).toUpperCase());
    return id === myId ? `${name} (YOU)` : name;
  };

  const button = (id: string, label: string, enabled: boolean, title: string, toggled?: boolean): string => {
    const on = toggled === true;
    // Only the promotion choices are toggles; actions get no pressed state.
    const pressed = toggled === undefined ? '' : `aria-pressed="${on}"`;
    return `
    <button data-act="${id}" ${enabled ? '' : 'disabled'} title="${title}" ${pressed} style="
      padding: 7px 10px; border-radius: 6px; font: inherit; font-size: 10px;
      font-weight: 800; letter-spacing: 1.5px;
      background: rgba(212, 168, 75, ${on ? '0.32' : enabled ? '0.12' : '0.04'});
      border: 1px solid rgba(212, 168, 75, ${on ? '0.9' : enabled ? '0.5' : '0.18'});
      color: ${enabled ? GOLD_BRIGHT : DIM};
      cursor: ${enabled ? 'pointer' : 'not-allowed'};
    ">${label}</button>`;
  };

  /** True when the selected piece has a promoting move — the strip then
   *  says what the pawn will become. */
  const promotionPending = (s: ChessState | null): boolean =>
    !!s && selected !== null && isMyChessTurn(s, myId)
    && legalChessMoves(s).some((m) => m.from === selected && m.special === 'promote');

  const render = (): void => {
    if (!strip || !card) return;
    const s = state();
    selected = pruneChessSelection(s, myId, selected);
    paintMarks();
    const live = s?.status === 'playing';
    const over = !!s && !live && s.status !== 'waiting';
    const promo = promotionPending(s)
      ? ` · PAWN PROMOTES TO ${promotionChoice.toUpperCase()} (⚙ TO CHANGE)` : '';
    strip.innerHTML = `
      <div style="font-size:12px; font-weight:800; letter-spacing:1.5px; color:${
        over ? '#00E676' : live ? GOLD_BRIGHT : GOLD
      };">${chessStatusLine(s, myId)}${promo}</div>
      <div style="font-size:9px; letter-spacing:1px; color:rgba(212,168,75,0.6); margin-top:4px;">
        ${s ? `WHITE — ${seatName(s, 'white')} · BLACK — ${seatName(s, 'black')} · ` : ''}⚙ ON THE TABLE FOR OPTIONS · ESC TO STEP BACK
      </div>
      <div style="margin-top:6px;">${button('options', settingsOpen ? '✕ CLOSE OPTIONS' : '⚙ OPTIONS', true, 'Table options (same as the ⚙ on the table)')}</div>`;

    card.style.display = settingsOpen ? 'flex' : 'none';
    if (!settingsOpen || !s) return;
    const seat = chessSeatOf(s, myId);
    const resetOk = canReset();
    const flipping = deps.top?.isFlipping() ?? true;
    const promoButtons = PROMOTION_CHOICES.map((p) =>
      button(`promo-${p}`, `${PROMO_GLYPH[p]} ${p.toUpperCase()}`, true, `Promote pawns to a ${p}`, p === promotionChoice),
    ).join('');
    // A remote move re-renders the card: keep keyboard focus on the same button.
    const focusedAct = card.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset?.act : undefined;
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline;">
        <span style="font-size:11px; font-weight:800; letter-spacing:1.5px; color:${GOLD_BRIGHT};">⚙ CHESS TABLE</span>
        ${button('close', '✕', true, 'Close options')}
      </div>
      <div style="font-size:10px; line-height:1.8; letter-spacing:1px;">
        <div><span style="color:#ECE3CC;">●</span> WHITE — ${seatName(s, 'white')}</div>
        <div><span style="color:#9AA3B2;">●</span> BLACK — ${seatName(s, 'black')}</div>
        <div style="color:rgba(212,168,75,0.55);">Full rules · castle by moving the king two squares · white moves first</div>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <div style="font-size:9px; letter-spacing:1.5px; color:rgba(212,168,75,0.7);">PAWNS PROMOTE TO</div>
        <div style="display:flex; flex-wrap:wrap; gap:6px;">${promoButtons}</div>
      </div>
      <div style="display:flex; flex-wrap:wrap; gap:8px;">
        ${canStartChessBot(s, myId) ? button('bot', '⚙ VS BOT', true, 'Play white against a simple bot') : ''}
        ${live && seat ? button('forfeit', 'FORFEIT', true, 'Concede the game') : ''}
        ${button('flip', '⟲ FLIP TABLE', !!deps.top && !flipping, 'Turn the top over to the card felt')}
        ${button('reset', 'RESET TABLE', resetOk,
          resetOk ? 'Clear the table back to the game menu' : 'Players at the table or anyone who can edit this room can reset a live game')}
      </div>`;
    if (focusedAct) {
      (card.querySelector<HTMLButtonElement>(`button[data-act="${focusedAct}"]:not([disabled])`)
        ?? card.querySelector<HTMLButtonElement>('button:not([disabled])'))?.focus();
    }
  };

  const act = (what: string): void => {
    const s = state();
    if (what === 'close') settingsOpen = false;
    else if (what === 'options') {
      // Keyboard route to the ⚙ token: open the card and move focus into it.
      settingsOpen = !settingsOpen;
      render();
      if (settingsOpen) card?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
      return;
    } else if (what.startsWith('promo-')) {
      const p = what.slice('promo-'.length) as ChessPromotion;
      if (PROMOTION_CHOICES.includes(p)) promotionChoice = p;
      // The card is rebuilt: keep keyboard focus on the chosen piece.
      render();
      card?.querySelector<HTMLButtonElement>(`button[data-act="promo-${promotionChoice}"]`)?.focus();
      return;
    } else if (what === 'bot' || what === 'forfeit') {
      // Both hand the game back to the board, so the card gets out of the way.
      const next = !s ? null : what === 'bot' ? startChessBot(s, myId) : forfeitChess(s, myId);
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
    const marks = chessBoardMarks(state(), myId, selected, hover);
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
    const result = clickChessCell(state(), myId, selected, cell, promotionChoice);
    selected = result.selected;
    if (result.write) commit(result.write); // observer renders
    else render();
  };

  const onCardClick = (e: MouseEvent): void => {
    e.stopPropagation();
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (b && !b.disabled) act(b.dataset.act ?? '');
  };

  return {
    mount(host: HTMLElement, refresh: () => void): void {
      refreshOwner = refresh;
      selected = null;
      hover = null;
      settingsOpen = false;
      botTimer = 0;
      capture = document.createElement('div');
      capture.id = 'chess3d-capture';
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
      strip.id = 'chess3d-status';
      strip.style.cssText = `${shell} top:16px; padding:10px 18px; text-align:center; max-width:calc(100vw - 32px);`;
      strip.addEventListener('click', onCardClick);
      card = document.createElement('div');
      card.id = 'chess3d-options';
      card.style.cssText = `${shell} bottom:24px; width:min(380px, calc(100vw - 32px)); padding:14px; flex-direction:column; gap:12px; display:none;`;
      card.addEventListener('click', onCardClick);
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
      // The white claimant's client plays the bot's black side.
      const s = state();
      if (s && s.bot && s.status === 'playing' && s.turn === 'black' && s.players.white === myId) {
        botTimer += dt;
        if (botTimer >= BOT_DELAY) {
          botTimer = 0;
          const move = chooseChessBotMove(s);
          if (move) writeGame(deps.itemId, applyChessMove(s, move)); // bot promotes to a queen
        }
      } else botTimer = 0;
    },

    canReset,
  };
}
