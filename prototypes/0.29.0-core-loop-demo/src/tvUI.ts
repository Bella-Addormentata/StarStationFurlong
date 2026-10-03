/**
 * 📺 tvUI — the two panels around the smart TV (#186):
 *
 *  - the FOCUSED panel at the set (a DeviceUI, the party props' shell): the
 *    body buttons anyone may press (POWER, VOLUME), WATCH, and the remote —
 *    pick it up, put it down, hand it to someone, or open it on the phone;
 *  - the REMOTE itself, the phone's 📺 TV app: the start screen's source
 *    tiles with their lane badges, the paste box, PLAY NOW / SCHEDULE, the
 *    transport, the history, and HAND TO… — for the TV you hold.
 *
 * Every state change goes through tvDoc; this module renders and asks. Peer
 * strings are escaped before they reach innerHTML (the #116 XSS lesson).
 */

import type { DeviceUI } from './devices';
import {
  formatClock, handRemote, iHoldRemote, isStartOnly, mayPickUpRemote, parseTvSource, pickUpRemote,
  putDownRemote, readPlayback, readRemote, readTv, remoteKey, remoteLapsed, sanitizeSource,
  sourceLabel, sourceLane, subscribeTv, subscribeTvKey, tvDocEpoch, tvKey, tvPause, tvPlay,
  tvResume, tvSchedule, tvSeek, tvSetVolume, tvStop, tvTogglePower, volumeKey,
} from './tvDoc';
import type { TvSource } from './tvDoc';
import { escapeHtml } from './htmlEscape';
import { tvPlayerPositionMs } from './tvSession';
import type { RoomPlayer } from './tvSession';

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
const GREEN = '#2fe6a0';
const WARN = '#ff8a50';
const CYAN = '#00E5FF';

const esc = escapeHtml;

export interface TvDeviceDeps {
  itemId: string;
  /** "WALL TV" / "TV ON THE STAND" — the kind's label. */
  label: string;
  myPub: () => string;
  myName: () => string;
  /** Room-owner gate — the spare remote. */
  canEdit: () => boolean;
  roomPlayers: () => RoomPlayer[];
  openTheatre: () => void;
  /** Open the phone on the 📺 TV app (the remote). */
  openRemote: () => void;
}

const PANEL_CSS = `
  position: absolute; top: 46%; left: 50%; transform: translate(-50%, -50%);
  width: 320px; max-height: 90vh; overflow-y: auto;
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

function smallButton(attr: string, label: string, enabled = true): string {
  return `<button type="button" ${attr} ${enabled ? '' : 'disabled'} style="
    padding:6px 9px; background:rgba(212,168,75,0.12); border:1px solid rgba(212,168,75,${enabled ? 0.4 : 0.15});
    border-radius:6px; color:${enabled ? GOLD : DIM}; font-family:inherit; font-size:10px; font-weight:800;
    cursor:${enabled ? 'pointer' : 'default'}; white-space:nowrap;">${label}</button>`;
}

function laneBadge(lane: string): string {
  const tone = lane === 'SOVEREIGN' ? GREEN : lane === 'PLAYER-RUN' ? CYAN : lane === 'PUBLIC SWARM' ? GOLD_BRIGHT : WARN;
  return `<span style="font-size:8px; letter-spacing:1px; padding:1px 5px; border:1px solid ${tone}; color:${tone}; border-radius:3px; white-space:nowrap;">${esc(lane)}</span>`;
}

function title(text: string, sub: string): string {
  return `<div>
    <div style="font-size:13px; font-weight:800; letter-spacing:1px; color:${GOLD_BRIGHT};">${text}</div>
    <div style="font-size:10px; color:${DIM}; margin-top:3px;">${sub}</div>
  </div>`;
}

/** What the set is doing, in one line, for both panels (plain text: it is
 *  set with textContent, never innerHTML). */
function statusText(itemId: string): string {
  const rec = readTv(itemId);
  const pb = readPlayback(itemId);
  if (rec.state === 'off') return 'off';
  if (!rec.source || rec.state === 'home') return 'on — the home screen';
  const what = sourceLabel(rec.source);
  if (pb.state === 'scheduled') return `${what} · ${pb.countdownMs > 0 ? `starts in ${formatClock(pb.countdownMs)}` : 'starting…'}`;
  if (pb.state === 'paused') return `${what} · paused at ${formatClock(pb.positionMs)}`;
  return `${what} · ${formatClock(pb.positionMs)}`;
}

const STATUS_ROW_STYLE = `color:${GOLD_BRIGHT}; min-width:0; overflow:hidden; text-overflow:ellipsis;`;

/** The status gets a span of its own, filled by refreshStatus: the clock and
 *  the countdown tick without rebuilding the panel around them, so buttons
 *  stay where a finger is heading, a name chosen in HAND TO stays chosen, a
 *  volume drag is not cut short and a note stays readable. */
function statusSpan(itemId: string, style = ''): string {
  return `<span data-tv-status="${esc(itemId)}"${style ? ` style="${style}"` : ''}></span>`;
}

function refreshStatus(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-tv-status]').forEach((el) => {
    const text = statusText(el.dataset.tvStatus!);
    if (el.textContent !== text) el.textContent = text;
  });
}

function remoteLine(itemId: string, myPub: string): string {
  const r = readRemote(itemId);
  if (!r.holder || remoteLapsed(itemId)) return 'The remote is on the set.';
  if (r.holder === myPub) return 'You are holding the remote.';
  return `${esc(r.name || 'A clone')} is holding the remote.`;
}

/** HAND TO… for ONE set: the select and the button carry its id, so a phone
 *  showing one remote while holding two hands over only the one on show. */
function handToBlock(deps: { myPub: () => string; roomPlayers: () => RoomPlayer[] }, itemId: string): string {
  const others = deps.roomPlayers().filter((p) => p.pub && p.pub !== deps.myPub());
  if (others.length === 0) {
    return `<div style="font-size:9px; color:${DIM};">Nobody else in the room to hand it to.</div>`;
  }
  const options = others
    .map((p) => `<option value="${esc(p.pub)}">${esc(p.name || p.pub.slice(0, 8))}</option>`)
    .join('');
  return `<div style="display:flex; gap:6px; align-items:center;">
    <select data-tv-hand-to="${esc(itemId)}" aria-label="Hand the remote to" style="flex:1; min-width:0; background:rgba(0,0,0,0.35); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:${GOLD_BRIGHT}; font-family:inherit; font-size:10px; padding:5px 6px;">${options}</select>
    ${smallButton(`data-tv-hand="${esc(itemId)}"`, '🤝 HAND TO')}
  </div>
  <div style="font-size:9px; color:${DIM}; line-height:1.4;">Everyone this room has seen. A remote handed to someone who has left comes back to the set on its own after 8 s.</div>`;
}

/** Wire every HAND TO block in `root` to the set its button names. */
function wireHandOver(root: HTMLElement, note: (text: string) => void): void {
  root.querySelectorAll<HTMLButtonElement>('[data-tv-hand]').forEach((b) => b.addEventListener('click', () => {
    const itemId = b.dataset.tvHand!;
    const sel = root.querySelector<HTMLSelectElement>(`[data-tv-hand-to="${CSS.escape(itemId)}"]`);
    if (!sel) return;
    const name = sel.options[sel.selectedIndex]?.textContent ?? '';
    const r = handRemote(itemId, sel.value, name);
    if (!r.ok) note(r.error);
  }));
}

/** The focused panel's remote buttons (one set: the buttons are unqualified). */
function wireRemoteActions(panel: HTMLElement, itemId: string, note: (text: string) => void): void {
  panel.querySelector<HTMLButtonElement>('[data-tv-pickup]')?.addEventListener('click', () => {
    const r = pickUpRemote(itemId);
    if (!r.ok) note(r.error);
  });
  panel.querySelector<HTMLButtonElement>('[data-tv-putdown]')?.addEventListener('click', () => {
    const r = putDownRemote(itemId);
    if (!r.ok) note(r.error);
  });
  wireHandOver(panel, note);
}

function showNote(panel: HTMLElement, text: string): void {
  let note = panel.querySelector<HTMLDivElement>('.tv-note');
  if (!note) {
    note = document.createElement('div');
    note.className = 'tv-note';
    note.style.cssText = `font-size:10px; color:${WARN}; line-height:1.4;`;
    panel.appendChild(note);
  }
  note.textContent = text;
}

// ── The focused panel at the set ─────────────────────────────────────────────

export function createSmartTvUI(deps: TvDeviceDeps): DeviceUI {
  let panel: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;
  let clockTimer = 0;
  let lastHtml = '';

  const render = (): void => {
    if (!panel) return;
    const rec = readTv(deps.itemId);
    const me = deps.myPub();
    const mine = iHoldRemote(deps.itemId);
    const mayPick = !mine && mayPickUpRemote(deps.itemId);
    const owner = deps.canEdit();
    const lane = rec.source ? laneBadge(sourceLane(rec.source)) : '';
    const html = `
      ${title(`📺 ${esc(deps.label)}`, statusSpan(deps.itemId))}
      <div style="display:flex; gap:6px; align-items:center;">
        ${smallButton('data-tv-power="1"', rec.state === 'off' ? '⏻ POWER ON' : '⏻ POWER OFF')}
        ${smallButton('data-tv-vol-down="1"', '🔉 −', rec.state !== 'off')}
        <span style="font-size:10px; color:${GOLD_BRIGHT}; min-width:30px; text-align:center;">${rec.volume}%</span>
        ${smallButton('data-tv-vol-up="1"', '🔊 +', rec.state !== 'off')}
        ${lane}
      </div>
      <div style="font-size:9px; color:${DIM}; line-height:1.4;">The set's own buttons — no remote needed.</div>
      ${bigButton('data-tv-watch="1"', '▶ WATCH', '47,230,160', rec.state !== 'off')}
      <div style="border-top:1px solid rgba(212,168,75,0.12); padding-top:10px; display:flex; flex-direction:column; gap:8px;">
        <div style="font-size:9px; color:${DIM}; letter-spacing:1.5px;">THE REMOTE</div>
        <div style="font-size:11px; color:${GOLD_BRIGHT}; line-height:1.4;">${remoteLine(deps.itemId, me)}</div>
        ${mine ? bigButton('data-tv-open-remote="1"', '📱 OPEN THE REMOTE', '0,229,255') : ''}
        ${mayPick ? bigButton('data-tv-pickup="1"', '🎛 PICK UP THE REMOTE', '212,168,75') : ''}
        ${mine || (owner && readRemote(deps.itemId).holder) ? bigButton('data-tv-putdown="1"', mine ? '🪑 PUT IT DOWN' : '🪑 TAKE IT BACK (OWNER)', '212,168,75') : ''}
        ${mine || owner ? handToBlock(deps, deps.itemId) : ''}
      </div>
    `;
    // Rebuild only when something other than the clock changed.
    if (html !== lastHtml) {
      panel.innerHTML = html;
      lastHtml = html;
      const note = (text: string) => showNote(panel!, text);
      panel.querySelector<HTMLButtonElement>('[data-tv-power]')?.addEventListener('click', () => { tvTogglePower(deps.itemId); });
      panel.querySelector<HTMLButtonElement>('[data-tv-vol-down]')?.addEventListener('click', () => { tvSetVolume(deps.itemId, readTv(deps.itemId).volume - 10); });
      panel.querySelector<HTMLButtonElement>('[data-tv-vol-up]')?.addEventListener('click', () => { tvSetVolume(deps.itemId, readTv(deps.itemId).volume + 10); });
      panel.querySelector<HTMLButtonElement>('[data-tv-watch]')?.addEventListener('click', () => deps.openTheatre());
      panel.querySelector<HTMLButtonElement>('[data-tv-open-remote]')?.addEventListener('click', () => deps.openRemote());
      wireRemoteActions(panel, deps.itemId, note);
    }
    refreshStatus(panel);
  };

  return {
    mount(host: HTMLElement): void {
      panel = document.createElement('div');
      panel.id = `device-tv-${deps.itemId}`;
      panel.style.cssText = PANEL_CSS;
      lastHtml = '';
      panel.addEventListener('click', (e) => e.stopPropagation());
      host.appendChild(panel);
      const subs = [
        subscribeTvKey(tvKey(deps.itemId), render),
        subscribeTvKey(remoteKey(deps.itemId), render),
        subscribeTvKey(volumeKey(deps.itemId), render),
      ];
      unsubscribe = () => { for (const s of subs) s(); };
      // The clock and countdown move without a doc write.
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

// ── The remote: the phone's 📺 TV app ────────────────────────────────────────

export interface TvPhoneDeps {
  /** The room's TVs (smart-tv / tv-stand items) with a label each. */
  tvs: () => Array<{ id: string; label: string }>;
  myPub: () => string;
  myName: () => string;
  canEdit: () => boolean;
  roomPlayers: () => RoomPlayer[];
  openTheatre: (itemId: string) => void;
  /** Resolve an archive.org item to a playable file + title (the metadata
   *  API), or null when that is not possible here — the embed then plays. */
  resolveArchive?: (identifier: string) => Promise<{ file: string; title: string } | null>;
}

interface Tile {
  key: string;
  icon: string;
  label: string;
  lane: string;
  hint: string;
  /** false ⇒ shown dimmed: "NOT YET PROVISIONED" (plan §3.3's later tiles). */
  live: boolean;
}

const TILES: Tile[] = [
  { key: 'youtube', icon: '▶️', label: 'YOUTUBE', lane: 'CONVENIENCE', hint: 'paste a watch / youtu.be / shorts link, or an 11-character id', live: true },
  { key: 'archive', icon: '🏛️', label: 'ARCHIVE.ORG', lane: 'CONVENIENCE', hint: 'paste a details/ or download/ link — public-domain films', live: true },
  { key: 'url', icon: '🔗', label: 'URL', lane: 'CONVENIENCE', hint: 'paste a direct link to an mp4 / webm', live: true },
  { key: 'file', icon: '📁', label: 'FILE', lane: 'SOVEREIGN', hint: 'your own file, over the room (blob lane)', live: false },
  { key: 'magnet', icon: '🧲', label: 'TORRENT', lane: 'PUBLIC SWARM', hint: 'a magnet or .torrent, fetched by the host node', live: false },
  { key: 'karaoke', icon: '🎤', label: 'KARAOKE', lane: 'SOVEREIGN', hint: 'MP3+G, with the mic on the audio lane', live: false },
];

const SCHEDULE_CHOICES: Array<{ label: string; minutes: number }> = [
  { label: '+5 MIN', minutes: 5 }, { label: '+15 MIN', minutes: 15 }, { label: '+30 MIN', minutes: 30 }, { label: '+1 H', minutes: 60 },
];

let phoneSubscribed = false;
let activeTile = 'youtube';
let phoneClockTimer = 0;
let phoneHtml = '';

/** Render (and keep rendering) the TV app into its phone view. Called by
 *  main.ts when the view opens; the subscription repaints it while it is the
 *  active view. */
export function renderTvPhoneApp(host: HTMLElement, deps: TvPhoneDeps): void {
  const paint = () => {
    if (!host.classList.contains('active')) return;
    const html = renderTvApp(deps);
    // Rebuild only when something other than the clock changed (the status
    // spans tick in place); the clocks move on the timer without a write.
    if (html !== phoneHtml || host.childElementCount === 0) {
      // Keep what the player is TYPING across a peer-driven repaint — the
      // paste box only (a focused volume slider is an input too, and its
      // number must not land in the box).
      const active = document.activeElement as HTMLInputElement | null;
      const draft = active && active.matches('input[data-tv-paste]') && host.contains(active)
        ? { value: active.value, start: active.selectionStart, end: active.selectionEnd }
        : null;
      host.innerHTML = html;
      phoneHtml = html;
      wireTvApp(host, deps);
      if (draft) {
        const again = host.querySelector<HTMLInputElement>('[data-tv-paste]');
        if (again) {
          again.value = draft.value;
          again.focus();
          try { again.setSelectionRange(draft.start, draft.end); } catch { /* not selectable */ }
        }
      }
    }
    refreshStatus(host);
  };
  if (!phoneSubscribed) {
    phoneSubscribed = true;
    subscribeTv(paint);
    phoneClockTimer = window.setInterval(paint, 1000);
  }
  void phoneClockTimer;
  paint();
}

/** The set whose remote the phone shows when it holds more than one (a
 *  pick-up, a hand-over received, USE THIS REMOTE on another held set). */
let selectedTvId = '';
export function selectTvRemote(itemId: string): void {
  selectedTvId = itemId;
}

function renderTvApp(deps: TvPhoneDeps): string {
  const tvs = deps.tvs();
  if (tvs.length === 0) {
    return `<div class="phone-access-section">
      <div class="phone-access-header">📺 TV REMOTE</div>
      <div class="phone-access-note">No TV in this room. The DEV menu's FURNITURE list spawns a wall TV or a TV on a stand.</div>
    </div>`;
  }
  const me = deps.myPub();
  // The remote on show: the one this phone chose, else the first held, else
  // the first set. A second held remote is a row below with USE.
  const heldAll = tvs.filter((t) => iHoldRemote(t.id));
  const current = heldAll.find((t) => t.id === selectedTvId) ?? heldAll[0]
    ?? tvs.find((t) => t.id === selectedTvId) ?? tvs[0]!;
  const others = tvs.filter((t) => t.id !== current.id);
  return `
    ${renderRemoteSection(current, deps, me)}
    ${others.length ? `<div class="phone-access-section">
      <div class="phone-access-header">OTHER TVS IN THE ROOM</div>
      ${others.map((t) => `<div class="phone-access-room-row"><span class="phone-access-room-label">${esc(t.label)}:</span>${statusSpan(t.id, STATUS_ROW_STYLE)}${smallButton(`data-tv-watch="${esc(t.id)}"`, '▶')}${iHoldRemote(t.id) ? smallButton(`data-tv-select="${esc(t.id)}"`, '🎛 USE') : mayPickUpRemote(t.id) ? smallButton(`data-tv-pickup="${esc(t.id)}"`, '🎛') : ''}</div>`).join('')}
    </div>` : ''}
  `;
}

function renderRemoteSection(tv: { id: string; label: string }, deps: TvPhoneDeps, me: string): string {
  const rec = readTv(tv.id);
  const mine = iHoldRemote(tv.id);
  const owner = deps.canEdit();
  const pb = readPlayback(tv.id);
  const head = `<div class="phone-access-section">
    <div class="phone-access-header">📺 ${esc(tv.label)} — REMOTE</div>
    <div class="phone-access-room-row"><span class="phone-access-room-label">ON:</span>${statusSpan(tv.id, STATUS_ROW_STYLE)}</div>
    <div style="font-size:10px; color:${GOLD_BRIGHT};">${remoteLine(tv.id, me)}</div>
    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${smallButton(`data-tv-watch="${esc(tv.id)}"`, '▶ WATCH', rec.state !== 'off')}
      ${smallButton(`data-tv-power="${esc(tv.id)}"`, rec.state === 'off' ? '⏻ ON' : '⏻ OFF')}
      ${!mine && mayPickUpRemote(tv.id) ? smallButton(`data-tv-pickup="${esc(tv.id)}"`, '🎛 PICK UP') : ''}
      ${mine ? smallButton(`data-tv-putdown="${esc(tv.id)}"`, '🪑 PUT DOWN') : ''}
      ${!mine && owner && readRemote(tv.id).holder ? smallButton(`data-tv-putdown="${esc(tv.id)}"`, '🪑 TAKE BACK (OWNER)') : ''}
    </div>
  </div>`;
  if (!mine) {
    return `${head}<div class="phone-access-section">
      <div class="phone-access-note">Pick up the remote to choose what plays. Anyone standing at the set can press its power and volume buttons.</div>
    </div>`;
  }
  const tiles = TILES.map((t) => {
    const on = t.key === activeTile;
    return `<button type="button" data-tv-tile="${t.key}" ${t.live ? '' : 'disabled'} title="${esc(t.hint)}" style="
      display:flex; flex-direction:column; align-items:center; gap:3px; padding:8px 4px;
      background:${on ? 'rgba(0,229,255,0.12)' : 'rgba(10,14,34,0.9)'}; border:1px solid ${on ? CYAN : 'rgba(212,168,75,0.18)'};
      border-radius:10px; color:${t.live ? GOLD_BRIGHT : DIM}; font-family:inherit; font-size:8.5px; font-weight:800; cursor:${t.live ? 'pointer' : 'default'};">
      <span style="font-size:16px;">${t.icon}</span><span>${t.label}</span>${laneBadge(t.lane)}${t.live ? '' : `<span style="font-size:7px; color:${DIM};">NOT YET PROVISIONED</span>`}
    </button>`;
  }).join('');
  const tile = TILES.find((t) => t.key === activeTile) ?? TILES[0]!;
  // A start-only source (archive.org's own player) offers no transport.
  const startOnly = rec.source ? isStartOnly(rec.source) : false;
  const transport = rec.source && rec.state !== 'off' && rec.state !== 'home'
    ? `<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        ${!startOnly && pb.state === 'playing' ? smallButton(`data-tv-pause="${esc(tv.id)}"`, '⏸') : ''}
        ${!startOnly && pb.state === 'paused' ? smallButton(`data-tv-resume="${esc(tv.id)}"`, '▶') : ''}
        ${!startOnly && (pb.state === 'playing' || pb.state === 'paused') ? smallButton(`data-tv-back="${esc(tv.id)}"`, '⏪ 10s') + smallButton(`data-tv-fwd="${esc(tv.id)}"`, '10s ⏩') : ''}
        ${startOnly ? `<span style="font-size:9px; color:${DIM};">start-time sync only — their player has no pause, seek or volume from here</span>` : ''}
        ${smallButton(`data-tv-stop="${esc(tv.id)}"`, '⏹ STOP')}
        ${startOnly ? '' : `<label style="display:flex; align-items:center; gap:4px; font-size:10px; color:${GOLD};">🔊<input type="range" min="0" max="100" value="${rec.volume}" data-tv-volume="${esc(tv.id)}" aria-label="Set volume" style="width:70px;"></label>`}
      </div>`
    : '';
  const history = rec.history.length
    ? `<div class="phone-access-header" style="margin-top:4px;">PREVIOUSLY ON</div>
       ${rec.history.slice(0, 8).map((h, i) => `<div class="phone-access-room-row">
         <span style="color:${GOLD_BRIGHT}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${esc(h.title)}</span>
         ${laneBadge(sourceLane(h.source))}
         ${smallButton(`data-tv-history="${i}" data-tv-id="${esc(tv.id)}"`, '▶')}
       </div>`).join('')}`
    : '';
  return `${head}
    <div class="phone-access-section">
      <div class="phone-access-header">SOURCES</div>
      <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:6px;">${tiles}</div>
      <div class="phone-access-note">${esc(tile.hint)}</div>
      <input type="text" data-tv-paste="1" placeholder="${esc(tile.key === 'youtube' ? 'https://www.youtube.com/watch?v=…' : tile.key === 'archive' ? 'https://archive.org/details/…' : 'https://…/film.mp4')}" autocomplete="off" aria-label="Paste a link">
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${smallButton(`data-tv-play="${esc(tv.id)}"`, '▶ PLAY NOW')}
        ${SCHEDULE_CHOICES.map((c) => smallButton(`data-tv-schedule="${c.minutes}" data-tv-id="${esc(tv.id)}"`, `🕒 ${c.label}`)).join('')}
      </div>
      <div id="tv-app-feedback" style="font-size:9.5px; color:rgba(212,168,75,0.8); min-height:12px; line-height:1.4;"></div>
      ${transport}
      ${history}
    </div>
    <div class="phone-access-section">
      <div class="phone-access-header">HAND THE REMOTE TO…</div>
      ${handToBlock(deps, tv.id)}
    </div>`;
}

/** The archive metadata lookups in flight: a result is applied only when it
 *  is still the newest ask, in the same room (a slow answer to an earlier
 *  PLAY NOW must not replace a newer programme, or land in the next room). */
let resolveGen = 0;

function wireTvApp(host: HTMLElement, deps: TvPhoneDeps): void {
  const feedback = (text: string) => {
    const el = host.querySelector<HTMLElement>('#tv-app-feedback');
    if (el) el.textContent = text;
  };
  host.querySelectorAll<HTMLButtonElement>('[data-tv-watch]').forEach((b) => b.addEventListener('click', () => deps.openTheatre(b.dataset.tvWatch!)));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-power]').forEach((b) => b.addEventListener('click', () => { tvTogglePower(b.dataset.tvPower!); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-pickup]').forEach((b) => b.addEventListener('click', () => {
    const r = pickUpRemote(b.dataset.tvPickup!);
    if (r.ok) selectedTvId = b.dataset.tvPickup!;
    else feedback(r.error);
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-select]').forEach((b) => b.addEventListener('click', () => {
    selectedTvId = b.dataset.tvSelect!;
    renderTvPhoneApp(host, deps);
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-putdown]').forEach((b) => b.addEventListener('click', () => {
    const r = putDownRemote(b.dataset.tvPutdown!);
    if (!r.ok) feedback(r.error);
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-tile]').forEach((b) => b.addEventListener('click', () => {
    activeTile = b.dataset.tvTile!;
    renderTvPhoneApp(host, deps);
  }));
  const paste = host.querySelector<HTMLInputElement>('[data-tv-paste]');
  paste?.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing must not walk the fox
    if (e.key === 'Enter') host.querySelector<HTMLButtonElement>('[data-tv-play]')?.click();
  });
  paste?.addEventListener('keyup', (e) => e.stopPropagation());

  const sourceFromBox = async (id: string): Promise<TvSource | null> => {
    const text = paste?.value ?? '';
    const parsed = parseTvSource(text);
    if (!parsed) {
      feedback(text.trim() ? 'That is not a link the TV can play.' : 'Paste a link first.');
      return null;
    }
    const gen = ++resolveGen;
    if (parsed.kind === 'archive' && !parsed.file && deps.resolveArchive) {
      feedback('Asking archive.org which file to play…');
      const epoch = tvDocEpoch();
      // Any programme action meanwhile — PREVIOUSLY ON, STOP or POWER from
      // this panel, the set's panel or the theatre — bumps the record's
      // `jump` and voids this lookup.
      const jump = readTv(id).jump;
      let found: { file: string; title: string } | null = null;
      try {
        found = await deps.resolveArchive(parsed.identifier);
      } catch { /* fall through to the embed */ }
      if (gen !== resolveGen || epoch !== tvDocEpoch() || readTv(id).jump !== jump) return null; // overtaken
      if (found) return sanitizeSource({ ...parsed, file: found.file, title: found.title }) ?? parsed;
      feedback('No playable file found — using their embed (start-time sync only).');
    }
    return parsed;
  };

  host.querySelector<HTMLButtonElement>('[data-tv-play]')?.addEventListener('click', () => {
    const id = host.querySelector<HTMLButtonElement>('[data-tv-play]')!.dataset.tvPlay!;
    void sourceFromBox(id).then((src) => {
      if (!src) return;
      const r = tvPlay(id, src);
      feedback(r.ok ? `Now on: ${sourceLabel(src)}` : r.error);
      if (r.ok) deps.openTheatre(id);
    });
  });
  host.querySelectorAll<HTMLButtonElement>('[data-tv-schedule]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvId!;
    const minutes = Number(b.dataset.tvSchedule);
    void sourceFromBox(id).then((src) => {
      if (!src) return;
      const r = tvSchedule(id, src, Date.now() + minutes * 60_000);
      feedback(r.ok ? `Scheduled: ${sourceLabel(src)} in ${minutes} min` : r.error);
    });
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-history]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvId!;
    const entry = readTv(id).history[Number(b.dataset.tvHistory)];
    if (!entry) return;
    const r = tvPlay(id, entry.source);
    feedback(r.ok ? `Now on: ${entry.title}` : r.error);
  }));
  // Where the holder's own player is, when one is mounted here: the record's
  // estimate runs on while a player buffers, and a pause written from it
  // would park the room past unplayed footage.
  const pos = (id: string) => tvPlayerPositionMs(id) ?? readPlayback(id).positionMs;
  host.querySelectorAll<HTMLButtonElement>('[data-tv-pause]').forEach((b) => b.addEventListener('click', () => { tvPause(b.dataset.tvPause!, pos(b.dataset.tvPause!)); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-resume]').forEach((b) => b.addEventListener('click', () => { tvResume(b.dataset.tvResume!); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-back]').forEach((b) => b.addEventListener('click', () => { tvSeek(b.dataset.tvBack!, Math.max(0, pos(b.dataset.tvBack!) - 10_000)); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-fwd]').forEach((b) => b.addEventListener('click', () => { tvSeek(b.dataset.tvFwd!, pos(b.dataset.tvFwd!) + 10_000); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-stop]').forEach((b) => b.addEventListener('click', () => { tvStop(b.dataset.tvStop!); }));
  host.querySelectorAll<HTMLInputElement>('[data-tv-volume]').forEach((i) => i.addEventListener('change', () => { tvSetVolume(i.dataset.tvVolume!, Number(i.value)); }));
  // PICK UP / PUT DOWN are wired by set id above; HAND TO… names its set too.
  wireHandOver(host, feedback);
}

/**
 * archive.org's metadata API, no key: pick the h.264 mp4, else the 512Kb
 * MPEG4, else any mp4 — and the item's title. Null when the item has no
 * playable file (the embed then plays). Times out rather than hang.
 */
export async function resolveArchiveFile(identifier: string, timeoutMs = 8_000): Promise<{ file: string; title: string } | null> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`, { signal: ctl.signal });
    if (!res.ok) return null;
    const meta = (await res.json()) as { files?: Array<{ name?: string; format?: string }>; metadata?: { title?: string } };
    const files = Array.isArray(meta.files) ? meta.files : [];
    const byFormat = (f: string) => files.find((x) => x.format === f && typeof x.name === 'string')?.name ?? '';
    const file = byFormat('h.264') || byFormat('512Kb MPEG4')
      || files.find((x) => typeof x.name === 'string' && /\.mp4$/i.test(x.name))?.name || '';
    if (!file) return null;
    const title = typeof meta.metadata?.title === 'string' ? meta.metadata.title : identifier;
    return { file, title };
  } finally {
    window.clearTimeout(timer);
  }
}
