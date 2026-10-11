/**
 * 🕹️⚙️ The arcade cabinet's card: what the cabinet runs and who is playing,
 * for anyone who presses a ⚙️ on its kick panel (or ⚙️ on the strip while
 * standing at it). The room's owner gets the same card, editable: pick the
 * one game the cabinet offers (or the whole menu) and reset it, which ends
 * the game running there. The wording follows the craps/roulette table card
 * (casinoTableSession.ts).
 *
 * The model is pure over the room doc (tested); the DOM glue below it is a
 * thin dialog, like the table card.
 */

import { ARCADE_GAMES, LICENSE_LABEL, type ArcadeGame } from './arcadeLibrary';
import type { ArcadeMatch } from './games/arcade';
import {
  readArcade, readArcadeSettings, readPlayerDisplayName, subscribeGames, writeArcade, writeArcadeSettings,
} from './games/gamesDoc';
import { getPlayerId } from './identity';

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#7C8794';

// ── Model (tested) ───────────────────────────────────────────────────────────

export interface ArcadeCardModel {
  title: string;
  owner: boolean;
  /** "YOU RUN THIS CABINET", or what everyone else reads. */
  role: string;
  /** The game the room is playing on it (null: one from a newer version,
   *  which this build doesn't have), and who holds each player. */
  now: { game: ArcadeGame | null; players: Array<{ player: 1 | 2; who: string }> } | null;
  /** The one game the owner set, or null: the whole menu. */
  pinned: ArcadeGame | null;
  /** The bundled games the cabinet's menu offers. */
  offered: readonly ArcadeGame[];
  /** The owner can end the game running there. */
  canReset: boolean;
}

/** The game a cabinet set to `game` offers alone, or null for the menu (an
 *  unset cabinet, or one set to a game this build doesn't have). */
export function pinnedGame(game: string | null | undefined): ArcadeGame | null {
  return (game && ARCADE_GAMES.find((g) => g.id === game)) || null;
}

/** Who holds player 1 and player 2 of a match, in words. */
export function matchPlayers(m: ArcadeMatch, seats: 1 | 2, me: string): Array<{ player: 1 | 2; who: string }> {
  const name = (id: string) => (id === me ? 'YOU' : readPlayerDisplayName(id).toUpperCase());
  const hostPlayer: 1 | 2 = m.hostSeat === 0 ? 1 : 2;
  const other: 1 | 2 = hostPlayer === 1 ? 2 : 1;
  const players = [{ player: hostPlayer, who: name(m.host) }];
  if (m.guest) players.push({ player: other, who: name(m.guest) });
  else if (seats === 2) players.push({ player: other, who: `OPEN · STEP UP TO THE ${other === 1 ? 'LEFT' : 'RIGHT'} STAND` });
  else players.push({ player: other, who: "A SECOND GAMEPAD ON PLAYER 1'S COMPUTER" });
  return players.sort((a, b) => a.player - b.player);
}

export function arcadeCardModel(itemId: string, seats: 1 | 2, owner: boolean, me: string = getPlayerId()): ArcadeCardModel {
  const m = readArcade(itemId);
  const game = m ? ARCADE_GAMES.find((g) => g.id === m.game) : undefined;
  const pinned = pinnedGame(readArcadeSettings(itemId)?.game);
  return {
    title: seats === 2 ? '⚙️ 2-PLAYER ARCADE CABINET' : '⚙️ ARCADE CABINET',
    owner,
    role: owner ? 'YOU RUN THIS CABINET' : 'THE OWNER SETS THIS CABINET · ANYONE CAN LOOK',
    now: m ? { game: game ?? null, players: matchPlayers(m, seats, me) } : null,
    pinned,
    offered: pinned ? [pinned] : ARCADE_GAMES,
    canReset: owner && m !== null,
  };
}

/** The game after `current` in the owner's choice: the whole menu, then each
 *  bundled game in turn. */
export function nextPinned(current: string | null | undefined): string | null {
  const order: Array<string | null> = [null, ...ARCADE_GAMES.map((g) => g.id)];
  const at = order.indexOf(pinnedGame(current)?.id ?? null);
  return order[(at + 1) % order.length];
}

/** An owner's press on the card. Anyone else's changes nothing. Returns a
 *  line to show, or null. */
export function cardAction(itemId: string, act: string, owner: boolean): string | null {
  if (!owner) return null;
  if (act === 'game') {
    const game = nextPinned(readArcadeSettings(itemId)?.game);
    writeArcadeSettings(itemId, { kind: 'arcade-settings', game });
    return null;
  }
  if (act === 'reset') {
    if (!readArcade(itemId)) return null;
    writeArcade(itemId, null);
    return 'THE GAME ENDED · THE CABINET IS FREE';
  }
  return null;
}

// ── HTML ─────────────────────────────────────────────────────────────────────

const esc = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const credit = (g: ArcadeGame): string =>
  `${esc(g.author.toUpperCase())} · ${g.year} · ${esc(LICENSE_LABEL[g.license])}`;

const btn = (act: string, label: string, enabled: boolean): string =>
  `<button data-act="${act}" ${enabled ? '' : 'disabled'} style="padding:6px 10px;background:rgba(212,168,75,${enabled ? 0.12 : 0.04});border:1px solid rgba(212,168,75,${enabled ? 0.5 : 0.18});border-radius:6px;color:${enabled ? GOLD_BRIGHT : DIM};font:inherit;font-size:10px;font-weight:800;letter-spacing:1.2px;cursor:${enabled ? 'pointer' : 'not-allowed'};">${esc(label)}</button>`;

const label = (text: string): string => `<span style="font-size:9px;color:${DIM};letter-spacing:1.2px;">${esc(text)}</span>`;

export function arcadeCardHtml(model: ArcadeCardModel, notice: string | null = null): string {
  const rows: string[] = [];
  rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;">
    <span style="font-size:12px;font-weight:900;letter-spacing:1px;color:${GOLD_BRIGHT};">${esc(model.title)}</span>
    <button data-act="close" aria-label="Close the cabinet card" style="background:none;border:none;color:${GOLD};font-size:16px;cursor:pointer;">✕</button></div>`);
  rows.push(`<div style="font-size:9px;color:${DIM};letter-spacing:1px;">${esc(model.role)}</div>`);
  if (notice) rows.push(`<div role="status" style="font-size:9.5px;font-weight:800;color:${GOLD_BRIGHT};">${esc(notice)}</div>`);

  const now = model.now;
  rows.push(`<div style="display:flex;flex-direction:column;gap:4px;border-top:1px solid rgba(212,168,75,0.18);padding-top:8px;">
    ${label('NOW PLAYING')}
    ${now
    ? `${now.game
      ? `<span style="font-size:11px;font-weight:800;color:${GOLD_BRIGHT};">${esc(now.game.title)}</span>
       <span style="font-size:9px;color:${GOLD};">${credit(now.game)}</span>`
      : `<span style="font-size:11px;font-weight:800;color:${GOLD_BRIGHT};">A GAME FROM A NEWER VERSION</span>
       <span style="font-size:9px;color:${GOLD};">UPDATE TO WATCH OR PLAY IT</span>`}
       ${now.players.map((p) => `<span style="font-size:10px;color:${GOLD};">PLAYER ${p.player} · ${esc(p.who)}</span>`).join('')}`
    : `<span style="font-size:10px;color:${GOLD};">NOTHING · STEP UP AND PRESS ENTER TO PLAY</span>`}
    </div>`);

  rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
    ${label('GAMES ON THIS CABINET')}
    ${model.owner
    ? btn('game', model.pinned ? model.pinned.title : 'EVERY BUNDLED GAME', true)
    : `<span style="font-size:10px;color:${GOLD_BRIGHT};">${esc(model.pinned ? model.pinned.title : 'EVERY BUNDLED GAME')}</span>`}
    </div>`);
  rows.push(`<div style="font-size:9px;line-height:1.7;color:${GOLD};">${
    model.offered.map((g) => `<div>${esc(g.title)} — ${credit(g)}</div>`).join('')
  }<div style="color:${DIM};">YOUR OWN CARTRIDGE STAYS ON YOUR DEVICE · CREDITS &amp; LICENSES ARE ON THE MENU</div></div>`);

  if (model.owner) {
    rows.push(`<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
      <span style="font-size:9px;color:${DIM};">RESET ENDS THE GAME RUNNING HERE FOR EVERYONE</span>
      ${btn('reset', 'RESET', model.canReset)}</div>`);
  }

  rows.push(`<div style="font-size:9px;color:#56606C;border-top:1px solid rgba(212,168,75,0.12);padding-top:8px;line-height:1.6;">
    CONTROLS: ARROWS OR WASD MOVE · X IS A · Z IS B · ENTER IS START · SHIFT IS SELECT · GAMEPADS WORK<br>
    ⌫ ENDS YOUR GAME OR HANDS PLAYER 2 BACK · ESC STEPS AWAY</div>`);
  return rows.join('');
}

// ── The dialog ───────────────────────────────────────────────────────────────

export interface ArcadeCardDeps {
  itemId: string;
  seats: 1 | 2;
  /** May change the cabinet's settings (canEditRoom). */
  isOwner: () => boolean;
  /** The card closed (✕, Esc, or a room change). */
  onClose?: () => void;
}

export interface ArcadeCard {
  readonly itemId: string;
  readonly el: HTMLElement;
  close(): void;
}

const roomNow = (): unknown => (globalThis as { __ssfRoomId?: unknown }).__ssfRoomId;

/** Player names and who may edit the room live outside the games map: an
 *  open card looks again this often (and repaints only if it changed). */
const CARD_REFRESH_MS = 1000;

/**
 * Open the card in `host`: `fixed` over the room view (below its rotate and
 * zoom buttons), `absolute` inside a focus UI. It follows the room doc while it is open, and closes itself if
 * the page moves to another room.
 */
export function openArcadeCard(host: HTMLElement, deps: ArcadeCardDeps, placement: 'fixed' | 'absolute'): ArcadeCard {
  const room = roomNow();
  let notice: string | null = null;
  let open = true;
  const el = document.createElement('div');
  el.id = 'arcade-card';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Arcade cabinet card');
  el.style.cssText = `
    position:${placement}; top:${placement === 'fixed' ? 128 : 76}px; right:24px; width:340px; max-width:calc(100vw - 32px); max-height:80vh; overflow-y:auto;
    background:rgba(4,8,22,0.94); border:1px solid rgba(212,168,75,0.3); border-radius:10px;
    box-shadow:0 10px 48px rgba(0,0,0,0.85); padding:14px; display:flex; flex-direction:column; gap:10px;
    font-family:'SF Mono','Monaco','Consolas',monospace; color:${GOLD}; pointer-events:auto; box-sizing:border-box; z-index:40;`;

  let shown = '';
  const render = (): void => {
    if (!open) return;
    if (roomNow() !== room) return close();
    const html = arcadeCardHtml(arcadeCardModel(deps.itemId, deps.seats, deps.isOwner()), notice);
    if (html === shown) return;
    shown = html;
    // Re-rendered on room-doc changes: keep keyboard focus on the same
    // control across it.
    const active = (document.activeElement as HTMLElement | null)?.closest?.('[data-act]');
    const focused = active && el.contains(active) ? (active as HTMLElement).dataset.act : null;
    el.innerHTML = html;
    if (focused) el.querySelector<HTMLElement>(`[data-act="${focused}"]`)?.focus();
  };

  const close = (): void => {
    if (!open) return;
    open = false;
    unsubscribe();
    clearInterval(refresh);
    el.remove();
    deps.onClose?.();
  };

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'close') return close();
    if (roomNow() !== room) return close();
    notice = cardAction(deps.itemId, act, deps.isOwner());
    render();
  });
  el.addEventListener('keydown', (e) => {
    // Keys stay with the card: Tab moves between its buttons (the room's
    // Tab would open the phone instead), and Esc closes the card, not the
    // cabinet or the room view behind it.
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  // Keep presses on the card from walking the player or releasing a focus.
  for (const ev of ['mousedown', 'mouseup', 'pointerdown', 'pointerup'] as const) {
    el.addEventListener(ev, (e) => e.stopPropagation());
  }

  // Someone else's change to the cabinet: an earlier press's notice (THE
  // GAME ENDED) no longer holds. A press's own write lands here first, and
  // its notice is set after.
  const unsubscribe = subscribeGames(() => {
    notice = null;
    render();
  });
  const refresh = setInterval(render, CARD_REFRESH_MS);
  host.appendChild(el);
  render();
  // Into the dialog: its Esc closes it, and a screen reader follows focus.
  el.querySelector<HTMLElement>('button')?.focus();
  return { itemId: deps.itemId, el, close };
}

/** The one card open over the room view (a ⚙️ on a kick panel). */
let roomCard: ArcadeCard | null = null;

/** A ⚙️ on a cabinet's kick panel: its card over the room view, replacing
 *  any other cabinet's. */
export function showArcadeCard(deps: ArcadeCardDeps): void {
  roomCard?.close();
  const card = openArcadeCard(document.body, {
    ...deps,
    onClose: () => {
      if (roomCard === card) roomCard = null;
      deps.onClose?.();
    },
  }, 'fixed');
  roomCard = card;
}

/** Close the room view's card (only if it is `itemId`'s, when given): a
 *  removed cabinet's card goes with it, and another game's ⚙️ card replaces it. */
export function closeArcadeCardFor(itemId?: string): void {
  if (roomCard && (itemId === undefined || roomCard.itemId === itemId)) roomCard.close();
}
