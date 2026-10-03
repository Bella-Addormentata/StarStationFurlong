/**
 * 🕹 arcadeUI — the panel at the cabinet (a DeviceUI, the TV panel's shell):
 * what is on the cabinet, PLAYER ONE (INSERT COIN · STAND UP · the owner's
 * EJECT), the owner's shelf, and the owner's LOAD A GAME block — a file from
 * their own disk (SOVEREIGN) or a link any player can fetch (CONVENIENCE),
 * the core, and where the emulator's own files come from. The game itself
 * runs in the stage (arcadeStage.ts) that INSERT COIN opens.
 *
 * Every state change goes through arcadeDoc; this module renders and asks.
 * Peer strings are escaped before they reach innerHTML (the #116 lesson).
 * The panel rebuilds only when something other than the clock changed, so a
 * tap never lands on a replaced button (the TV panel's rule).
 */

import type { DeviceUI } from './devices';
import {
  addToShelf, cabinetKey, coreForName, coreLabel, gameLane, iAmP1, insertCoin, maySit, parseRomUrl,
  pickFromShelf, putOnCabinet, readCabinet, readSeat, removeFromShelf, seatKey, seatLapsed,
  setEmulatorData, standUp, subscribeArcadeKey, takeOffCabinet, ARCADE_CORES, ARCADE_MAX_NAME,
  isArcadeCore,
} from './arcadeDoc';
import type { ArcadeCore, ArcadeGame } from './arcadeDoc';
import { rememberLocalRom, romAcceptList, EMULATOR_FETCH_COMMAND } from './arcadeEmulator';
import { escapeHtml } from './htmlEscape';

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
const GREEN = '#2fe6a0';
const WARN = '#ff8a50';
const CYAN = '#00E5FF';

const esc = escapeHtml;

export interface ArcadeDeviceDeps {
  itemId: string;
  myPub: () => string;
  myName: () => string;
  /** Room-owner gate — the shelf, the game, the emulator files, EJECT. */
  canEdit: () => boolean;
  /** INSERT COIN taken with a game on: open the stage (the focus releases first). */
  openStage: () => void;
}

const PANEL_CSS = `
  position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
  width: 340px; max-height: 90vh; overflow-y: auto;
  background: rgba(4, 8, 22, 0.94); border: 1px solid rgba(212, 168, 75, 0.28);
  border-radius: 12px; box-shadow: 0 12px 64px rgba(0,0,0,0.9);
  padding: 18px; display: flex; flex-direction: column; gap: 12px;
  color: ${GOLD}; font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  box-sizing: border-box; pointer-events: auto;
`;

function bigButton(attr: string, label: string, tone: string, enabled = true): string {
  return `<button type="button" ${attr} ${enabled ? '' : 'disabled'} style="
    display:flex; justify-content:center; align-items:center;
    padding:10px 12px; width:100%;
    background:${enabled ? `rgba(${tone},0.14)` : 'rgba(212,168,75,0.05)'};
    border:1px solid ${enabled ? `rgba(${tone},0.75)` : 'rgba(212,168,75,0.2)'};
    border-radius:7px; color:${enabled ? GOLD_BRIGHT : DIM};
    font-family:inherit; font-size:12px; font-weight:800; letter-spacing:0.5px;
    cursor:${enabled ? 'pointer' : 'default'};
  ">${label}</button>`;
}

function smallButton(attr: string, label: string, enabled = true, active = false): string {
  return `<button type="button" ${attr} ${enabled ? '' : 'disabled'} style="
    padding:6px 9px; background:${active ? 'rgba(0,229,255,0.14)' : 'rgba(212,168,75,0.12)'};
    border:1px solid ${active ? CYAN : `rgba(212,168,75,${enabled ? 0.4 : 0.15})`};
    border-radius:6px; color:${enabled ? GOLD : DIM}; font-family:inherit; font-size:10px; font-weight:800;
    cursor:${enabled ? 'pointer' : 'default'}; white-space:nowrap;">${label}</button>`;
}

function laneBadge(lane: string): string {
  const tone = lane === 'SOVEREIGN' ? GREEN : lane === 'PLAYER-RUN' ? CYAN : WARN;
  return `<span style="font-size:8px; letter-spacing:1px; padding:1px 5px; border:1px solid ${tone}; color:${tone}; border-radius:3px; white-space:nowrap;">${esc(lane)}</span>`;
}

function section(label: string, body: string): string {
  return `<div style="border-top:1px solid rgba(212,168,75,0.12); padding-top:10px; display:flex; flex-direction:column; gap:8px;">
    <div style="font-size:9px; color:${DIM}; letter-spacing:1.5px;">${label}</div>
    ${body}
  </div>`;
}

const INPUT_CSS = `width:100%; box-sizing:border-box; background:rgba(0,0,0,0.35); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:${GOLD_BRIGHT}; font-family:inherit; font-size:10px; padding:6px 7px;`;

/** What the cabinet is doing, in one line (plain text, set with textContent). */
function statusText(itemId: string): string {
  const rec = readCabinet(itemId);
  const seat = readSeat(itemId);
  const held = seat.holder !== '' && !seatLapsed(itemId);
  if (!rec.game && rec.shelf.length === 0) return 'nothing on the cabinet';
  const what = rec.game ? rec.game.name : `${rec.shelf.length} game${rec.shelf.length === 1 ? '' : 's'} on the shelf`;
  return held ? `${what} · P1 · ${seat.name || 'a clone'}` : `${what} · INSERT COIN`;
}

function refreshStatus(root: HTMLElement, itemId: string): void {
  const el = root.querySelector<HTMLElement>('[data-arcade-status]');
  if (!el) return;
  const text = statusText(itemId);
  if (el.textContent !== text) el.textContent = text;
}

function showNote(panel: HTMLElement, text: string): void {
  let note = panel.querySelector<HTMLDivElement>('.arcade-note');
  if (!note) {
    note = document.createElement('div');
    note.className = 'arcade-note';
    note.style.cssText = `font-size:10px; color:${WARN}; line-height:1.4;`;
    panel.appendChild(note);
  }
  note.textContent = text;
}

// ── The owner's LOAD A GAME draft, kept across repaints ──────────────────────
// (A File cannot be put back into an <input>, so the panel shows the name.)

let draftFile: File | null = null;
let draftUrl = '';
let draftCore: ArcadeCore | '' = '';

function draftGame(): { game: ArcadeGame; file: File | null } | { error: string } {
  if (draftFile) {
    const core = draftCore || coreForName(draftFile.name);
    if (!core) return { error: 'Pick a core for this file.' };
    return { game: { name: draftFile.name.slice(0, ARCADE_MAX_NAME), core, url: '', size: draftFile.size }, file: draftFile };
  }
  const parsed = parseRomUrl(draftUrl);
  if (!parsed) return { error: draftUrl.trim() ? 'That is not a link the cabinet can fetch.' : 'Pick a file, or paste a link.' };
  const core = draftCore || parsed.core;
  if (!core) return { error: 'Pick a core for this link.' };
  return { game: { name: parsed.name, core, url: parsed.url, size: 0 }, file: null };
}

// ── Render ───────────────────────────────────────────────────────────────────

function gameRow(g: ArcadeGame): string {
  return `<span style="color:${GOLD_BRIGHT}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${esc(g.name)}</span>
    <span style="font-size:9px; color:${DIM}; white-space:nowrap;">${esc(coreLabel(g.core))}</span>
    ${laneBadge(gameLane(g))}`;
}

function renderPanel(itemId: string, deps: ArcadeDeviceDeps): string {
  const rec = readCabinet(itemId);
  const seat = readSeat(itemId);
  const mine = iAmP1(itemId);
  const owner = deps.canEdit();
  const held = seat.holder !== '' && !seatLapsed(itemId);
  const game = rec.game;

  const onCabinet = game
    ? `<div style="display:flex; gap:6px; align-items:center; font-size:11px;">${gameRow(game)}</div>`
    : `<div style="font-size:10px; color:${DIM};">nothing — the owner loads a game</div>`;

  const p1Line = mine ? 'You are at the controls.'
    : held ? `${esc(seat.name || 'A clone')} is at the controls.`
      : 'The controls are free.';
  const p1Buttons = [
    mine ? bigButton('data-arcade-stage="1"', '🕹 BACK TO THE CONTROLS', '47,230,160') : '',
    mine ? smallButton('data-arcade-standup="1"', '🪑 STAND UP') : '',
    !mine && maySit(itemId) && game ? bigButton('data-arcade-coin="1"', '🪙 INSERT COIN · PLAY', '212,168,75') : '',
    !mine && maySit(itemId) && !game && rec.shelf.length ? bigButton('data-arcade-coin="1"', '🪙 INSERT COIN · PICK FROM THE SHELF', '212,168,75') : '',
    !mine && held && owner ? smallButton('data-arcade-eject="1"', '⏏ EJECT P1 (OWNER)') : '',
  ].join('');

  const shelf = rec.shelf.length
    ? rec.shelf.map((g, i) => `<div style="display:flex; gap:6px; align-items:center; font-size:11px;">
        ${gameRow(g)}
        ${mine || owner ? smallButton(`data-arcade-pick="${i}"`, '▶ PUT ON') : ''}
        ${owner ? smallButton(`data-arcade-unshelve="${i}"`, '✕') : ''}
      </div>`).join('')
    : `<div style="font-size:10px; color:${DIM};">empty</div>`;

  const cores = `<select data-arcade-core="1" aria-label="Core" style="${INPUT_CSS}">
    <option value="" ${draftCore ? '' : 'selected'}>CORE — picked from the file's extension</option>
    ${ARCADE_CORES.map((c) => `<option value="${c.core}" ${c.core === draftCore ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}
  </select>`;
  const load = owner ? section('LOAD A GAME', `
    <label style="display:flex; flex-direction:column; gap:4px; font-size:10px; color:${GOLD_BRIGHT};">
      <span>📁 YOUR OWN FILE ${laneBadge('SOVEREIGN')}</span>
      <input type="file" data-arcade-file="1" accept="${romAcceptList()}" style="font-size:10px; color:#8fa3b8;">
      ${draftFile ? `<span style="color:${GREEN};">✓ ${esc(draftFile.name)}</span>` : ''}
    </label>
    <label style="display:flex; flex-direction:column; gap:4px; font-size:10px; color:${GOLD_BRIGHT};">
      <span>🔗 A LINK ANY PLAYER CAN FETCH ${laneBadge('CONVENIENCE')}</span>
      <input type="text" data-arcade-url="1" placeholder="https://…/game.nes (CORS-clean)" autocomplete="off" value="${esc(draftUrl)}" style="${INPUT_CSS}">
    </label>
    ${cores}
    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${smallButton('data-arcade-put="1"', '▶ PUT ON THE CABINET')}
      ${smallButton('data-arcade-shelve="1"', '＋ ADD TO THE SHELF')}
      ${game ? smallButton('data-arcade-takeoff="1"', '⏏ TAKE IT OFF') : ''}
    </div>
    <div style="font-size:9px; color:${DIM}; letter-spacing:1.5px; margin-top:4px;">EMULATOR FILES</div>
    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${smallButton('data-arcade-data="station"', `${rec.data === 'station' ? '✓ ' : ''}THIS STATION`, true, rec.data === 'station')} ${laneBadge('SOVEREIGN')}
      ${smallButton('data-arcade-data="cdn"', `${rec.data === 'cdn' ? '✓ ' : ''}cdn.emulatorjs.org`, true, rec.data === 'cdn')} ${laneBadge('CONVENIENCE')}
    </div>
    <div style="font-size:9px; color:${DIM}; line-height:1.4;">This station's own copy (<span style="color:${GREEN};">${esc(EMULATOR_FETCH_COMMAND)}</span>, then rebuild) or the public CDN. A game from your disk is not sent to anyone: each P1 brings their own copy until the blob lane carries it.</div>
  `) : '';

  return `
    <div>
      <div style="font-size:13px; font-weight:800; letter-spacing:1px; color:${GOLD_BRIGHT};">🕹 ARCADE CABINET</div>
      <div style="font-size:10px; color:${DIM}; margin-top:3px;"><span data-arcade-status="1"></span></div>
    </div>
    ${section('ON THE CABINET', onCabinet)}
    ${section('PLAYER ONE', `<div style="font-size:11px; color:${GOLD_BRIGHT}; line-height:1.4;">${p1Line}</div>${p1Buttons}`)}
    ${section('THE SHELF', shelf)}
    ${load}
    <div style="font-size:9px; color:${DIM}; line-height:1.4;">At the controls: arrows + Z X A S · ENTER start · SHIFT select · gamepads plug straight in · ESC stands up.</div>
  `;
}

function wirePanel(panel: HTMLElement, itemId: string, deps: ArcadeDeviceDeps, rerender: () => void): void {
  const note = (text: string) => showNote(panel, text);
  const q = <T extends HTMLElement>(sel: string) => panel.querySelector<T>(sel);
  q<HTMLButtonElement>('[data-arcade-coin]')?.addEventListener('click', () => {
    const r = insertCoin(itemId);
    if (!r.ok) {
      note(r.error);
      return;
    }
    if (readCabinet(itemId).game) deps.openStage();
    else note('Pick a game from the shelf below.');
  });
  q<HTMLButtonElement>('[data-arcade-stage]')?.addEventListener('click', () => deps.openStage());
  q<HTMLButtonElement>('[data-arcade-standup]')?.addEventListener('click', () => { standUp(itemId); });
  q<HTMLButtonElement>('[data-arcade-eject]')?.addEventListener('click', () => {
    const r = standUp(itemId);
    if (!r.ok) note(r.error);
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-pick]').forEach((b) => b.addEventListener('click', () => {
    const r = pickFromShelf(itemId, Number(b.dataset.arcadePick));
    if (!r.ok) {
      note(r.error);
      return;
    }
    if (iAmP1(itemId)) deps.openStage();
  }));
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-unshelve]').forEach((b) => b.addEventListener('click', () => {
    const r = removeFromShelf(itemId, Number(b.dataset.arcadeUnshelve));
    if (!r.ok) note(r.error);
  }));
  q<HTMLButtonElement>('[data-arcade-takeoff]')?.addEventListener('click', () => {
    const r = takeOffCabinet(itemId);
    if (!r.ok) note(r.error);
  });
  panel.querySelectorAll<HTMLButtonElement>('[data-arcade-data]').forEach((b) => b.addEventListener('click', () => {
    const r = setEmulatorData(itemId, b.dataset.arcadeData === 'cdn' ? 'cdn' : 'station');
    if (!r.ok) note(r.error);
  }));

  // The owner's draft.
  q<HTMLInputElement>('[data-arcade-file]')?.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (!file) return;
    draftFile = file;
    draftUrl = '';
    draftCore = coreForName(file.name) ?? draftCore;
    rerender();
  });
  const url = q<HTMLInputElement>('[data-arcade-url]');
  url?.addEventListener('keydown', (e) => { e.stopPropagation(); }); // typing must not walk the fox
  url?.addEventListener('keyup', (e) => { e.stopPropagation(); });
  url?.addEventListener('input', () => {
    draftUrl = url.value;
    if (draftUrl.trim()) draftFile = null;
    const parsed = parseRomUrl(draftUrl);
    const sel = q<HTMLSelectElement>('[data-arcade-core]');
    if (parsed?.core && !draftCore && sel) sel.value = parsed.core; // suggested, not yet chosen
  });
  q<HTMLSelectElement>('[data-arcade-core]')?.addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    draftCore = isArcadeCore(v) ? v : '';
  });
  const commit = (put: boolean) => {
    const sel = q<HTMLSelectElement>('[data-arcade-core]');
    if (sel && !draftCore && isArcadeCore(sel.value)) draftCore = sel.value;
    const d = draftGame();
    if ('error' in d) {
      note(d.error);
      return;
    }
    const r = put ? putOnCabinet(itemId, d.game) : addToShelf(itemId, d.game);
    if (r.ok && d.file) rememberLocalRom(d.game, d.file);
    note(r.ok ? `${put ? 'On the cabinet' : 'On the shelf'}: ${d.game.name}` : r.error);
  };
  q<HTMLButtonElement>('[data-arcade-put]')?.addEventListener('click', () => commit(true));
  q<HTMLButtonElement>('[data-arcade-shelve]')?.addEventListener('click', () => commit(false));
}

// ── The DeviceUI ─────────────────────────────────────────────────────────────

export function createArcadeCabinetUI(deps: ArcadeDeviceDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let clockTimer = 0;
  let lastHtml = '';

  const render = (): void => {
    if (!panel) return;
    const html = renderPanel(deps.itemId, deps);
    if (html !== lastHtml) {
      panel.innerHTML = html;
      lastHtml = html;
      wirePanel(panel, deps.itemId, deps, render);
    }
    refreshStatus(panel, deps.itemId);
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = `device-arcade-${deps.itemId}`;
      panel.style.cssText = PANEL_CSS;
      panel.addEventListener('click', (e) => e.stopPropagation());
      lastHtml = '';
      host.appendChild(panel);
      const subs = [
        subscribeArcadeKey(cabinetKey(deps.itemId), render),
        subscribeArcadeKey(seatKey(deps.itemId), render),
      ];
      unsubscribe = () => { for (const s of subs) s(); };
      // The seat lapses without a write; the status line moves with it.
      clockTimer = window.setInterval(render, 1000);
      render();
    },
    unmount(): void {
      unsubscribe?.();
      unsubscribe = null;
      window.clearInterval(clockTimer);
      panel?.remove();
      panel = null;
    },
    update(): void { /* doc-driven */ },
  };
}
