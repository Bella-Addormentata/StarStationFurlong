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
  formatClock, handRemote, holdsSpareRemote, iHoldRemote, isStartOnly, mayPickUpRemote, parseTvSource, pickUpRemote,
  putDownRemote, readPlayback, readRemote, readTv, remoteKey, remoteLapsed, sanitizeSource,
  sourceLabel, sourceLane, subscribeTv, subscribeTvKey, tvDocEpoch, tvKey, tvPause, tvPlay,
  tvResume, tvRevision, tvSchedule, tvSeek, tvSetVolume, tvStop, tvTogglePower, powerKey, volumeKey,
} from './tvDoc';
import type { TvSource } from './tvDoc';
import { escapeHtml } from './htmlEscape';
import { tvPlayerCanSeek, tvPlayerPositionMs } from './tvSession';
import type { RoomPlayer } from './tvSession';
import { consentRefusal, mediaConsent } from './tvConsent';
import { convenienceLanesEnabled, sourceKindAllowed, SERVERLESS_ONLY } from './sovereignty';
import { isFlightKey } from './freeFlightStick';

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

/** The volume sliders' level, set as a property rather than written into
 *  the panel's HTML: a peer's VOLUME press on the set then moves the knob
 *  without rebuilding the panel under a pointer mid-drag, and a slider the
 *  player is on keeps its own reading until its change lands. */
function syncVolumeSliders(root: HTMLElement): void {
  root.querySelectorAll<HTMLInputElement>('input[data-tv-volume]').forEach((i) => {
    if (document.activeElement === i) return;
    const level = String(readTv(i.dataset.tvVolume!).volume);
    if (i.value !== level) i.value = level;
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
    <select data-tv-hand-to="${esc(itemId)}" aria-label="Hand the remote to" title="↑/↓ choose · Tab moves on to HAND TO · Escape leaves the list" style="flex:1; min-width:0; background:rgba(0,0,0,0.35); border:1px solid rgba(212,168,75,0.3); border-radius:5px; color:${GOLD_BRIGHT}; font-family:inherit; font-size:10px; padding:5px 6px;">${options}</select>
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
    const owner = holdsSpareRemote(); // the deed holder: the predicate the write itself checks
    const lane = rec.source ? laneBadge(sourceLane(rec.source)) : '';
    // archive.org's own player takes no volume from the set: its buttons
    // would change the room's number and not the sound.
    const volumeless = rec.source ? isStartOnly(rec.source) : false;
    const html = `
      ${title(`📺 ${esc(deps.label)}`, statusSpan(deps.itemId))}
      <div style="display:flex; gap:6px; align-items:center;">
        ${smallButton('data-tv-power="1"', rec.state === 'off' ? '⏻ POWER ON' : '⏻ POWER OFF')}
        ${volumeless ? `<span style="font-size:9px; color:${DIM};">volume: in archive.org's player</span>` : `${smallButton('data-tv-vol-down="1"', '🔉 −', rec.state !== 'off')}
        <span style="font-size:10px; color:${GOLD_BRIGHT}; min-width:30px; text-align:center;">${rec.volume}%</span>
        ${smallButton('data-tv-vol-up="1"', '🔊 +', rec.state !== 'off')}`}
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
    // Rebuild only when something other than the clock changed — and keep
    // the keyboard player's place across it (the phone app's rule): the
    // control they were on, by its data-tv-* identity, else the panel.
    if (html !== lastHtml) {
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && panel.contains(active) ? active : null;
      const focusKey = focusKeyOf(inside);
      panel.innerHTML = html;
      lastHtml = html;
      if (inside) {
        const again = focusKey ? panel.querySelector<HTMLElement>(focusKey) : null;
        (again ?? panel).focus({ preventScroll: true });
      }
      const note = (text: string) => showNote(panel!, text);
      panel.querySelector<HTMLButtonElement>('[data-tv-power]')?.addEventListener('click', () => { tvTogglePower(deps.itemId); });
      panel.querySelector<HTMLButtonElement>('[data-tv-vol-down]')?.addEventListener('click', () => { tvSetVolume(deps.itemId, readTv(deps.itemId).volume - 10); });
      panel.querySelector<HTMLButtonElement>('[data-tv-vol-up]')?.addEventListener('click', () => { tvSetVolume(deps.itemId, readTv(deps.itemId).volume + 10); });
      panel.querySelector<HTMLButtonElement>('[data-tv-watch]')?.addEventListener('click', () => deps.openTheatre());
      panel.querySelector<HTMLButtonElement>('[data-tv-open-remote]')?.addEventListener('click', () => {
        selectTvRemote(deps.itemId); // this set's remote, not an earlier held one
        deps.openRemote();
      });
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
        subscribeTvKey(powerKey(deps.itemId), render),
      ];
      unsubscribe = () => { for (const s of subs) s(); };
      // The clock and countdown move without a doc write.
      clockTimer = window.setInterval(render, 1000);
      render();
      // By keyboard (the phone app's traversal, wireTvNav): Tab is the
      // phone's toggle and never reaches this panel, so ↑/↓ step through
      // POWER, VOLUME, WATCH and the remote's buttons, Enter and Space press
      // them, and focus lands on the first control as the panel opens —
      // Escape steps back from the set as before (deviceFocus). Mounted is
      // on screen: the overlay is in front of the player while it exists.
      wireTvNav(panel, () => true);
      const first = [...panel.querySelectorAll<HTMLElement>(NAV_STOPS)].find((el) => el.offsetParent !== null);
      (first ?? panel).focus({ preventScroll: true });
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

/** The tiles this build offers (sovereignty.ts): the centralized lanes only
 *  with the convenience lanes on — and without them the URL tile is labelled
 *  for what it plays here, a file on the viewer's own origins. */
function visibleTiles(): Tile[] {
  if (convenienceLanesEnabled()) return TILES;
  return TILES.filter((t) => sourceKindAllowed(t.key)).map((t) => t.key === 'url'
    ? { ...t, lane: 'SOVEREIGN', hint: `paste a link to an mp4 / webm on this station's node or your own origin — ${SERVERLESS_ONLY}` }
    : t);
}

const SCHEDULE_CHOICES: Array<{ label: string; minutes: number }> = [
  { label: '+5 MIN', minutes: 5 }, { label: '+15 MIN', minutes: 15 }, { label: '+30 MIN', minutes: 30 }, { label: '+1 H', minutes: 60 },
];

let phoneSubscribed = false;
let activeTile = '';
let phoneHtml = '';
/** The deps of the latest renderTvPhoneApp call: the one subscribed paint
 *  reads these, so a view reopened with fresh deps repaints with them, not
 *  with the ones the first open happened to capture. */
let phoneDeps: TvPhoneDeps | null = null;

/** The controls ↑/↓ step through, and that focus lands on. */
const NAV_STOPS = 'button:not([disabled]), input, select';

/** A control's identity across repaints: its tag and data-tv-* attributes
 *  (a tile's key, a button's set id, the paste box). '' for anything else. */
function focusKeyOf(el: HTMLElement | null): string {
  if (!el) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(el.dataset)) {
    if (!k.startsWith('tv') || v === undefined) continue;
    const attr = k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    parts.push(`[data-${attr}="${v.replace(/["\\]/g, '\\$&')}"]`);
  }
  return parts.length ? `${el.tagName.toLowerCase()}${parts.join('')}` : '';
}

/** Whether the app is in front of the player: its view active, the phone
 *  up. The phone only slides offscreen, so a control left focused in it
 *  still receives keys — and moving focus between controls nobody can see
 *  is worse than useless (the treasury view's rule). */
function tvAppOnScreen(host: HTMLElement): boolean {
  if (!host.classList.contains('active')) return false;
  const phone = host.closest<HTMLElement>('#spacephone-container');
  return !phone || phone.classList.contains('active');
}

/** The remote by keyboard. Tab is the phone's own open/close toggle (main.ts
 *  preventDefaults every press), so this view carries its own movement
 *  between controls, the treasury view's pattern: ↑/↓ step through the
 *  visible controls, wrapping; Enter and Space press a button natively. A
 *  slider and a select keep the arrows for their own values, so from those
 *  two the way out is Tab / Shift+Tab (next / previous control — the one
 *  place in the phone where Tab is not its toggle, said on the widget's
 *  title) or Escape, which leaves the widget for the view so the next
 *  Escape is the phone's again (the phone's own Escape ignores an INPUT). A
 *  text box keeps its caret keys (←/→, Home, End) — only ↑/↓ leave it.
 *  Wired once per host, in the capture phase: the paste box stops its own
 *  keys from bubbling (typing must not walk the fox), and ↑/↓ must still
 *  move out of it. */
function wireTvNav(host: HTMLElement, onScreen: () => boolean = () => tvAppOnScreen(host)): void {
  if (host.dataset.tvNav) return;
  host.dataset.tvNav = '1';
  host.setAttribute('tabindex', '-1'); // focusable by script, never a tab stop
  const move = (e: KeyboardEvent, from: HTMLElement | null, step: number) => {
    const stops = [...host.querySelectorAll<HTMLElement>(NAV_STOPS)].filter((el) => el.offsetParent !== null);
    if (stops.length === 0) return;
    e.preventDefault();
    e.stopPropagation(); // a move inside the remote is not a key for the world, nor the phone's Tab
    const here = from ? stops.indexOf(from.closest<HTMLElement>(NAV_STOPS) as HTMLElement) : -1;
    // An explicit step scrolls the control into view: the remote overflows
    // the phone's viewport (history, several sets), the arrow's own scroll
    // is prevented above, and a control focused offscreen cannot be seen.
    // preventScroll is for the repaint's focus restoration, which must not
    // jolt the view (renderTvPhoneApp).
    stops[here < 0 ? 0 : (here + step + stops.length) % stops.length]!.focus();
  };
  host.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!onScreen()) return;
    const target = e.target instanceof HTMLElement ? e.target : null;
    const widget = target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && target.type === 'range');
    if (widget && e.key === 'Tab') {
      move(e, target, e.shiftKey ? -1 : 1);
      return;
    }
    if (widget && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      host.focus({ preventScroll: true });
      return;
    }
    if (e.shiftKey || widget || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return;
    move(e, target, e.key === 'ArrowDown' ? 1 : -1);
  }, true);
}

/** The helm's flight stick and this app share the arrows and Space: when the
 *  stick is taken, its capture listener runs before this view's and would
 *  swallow the arrows that step through the remote and the Space that
 *  presses its buttons — the ship turned or braked instead. The app marks
 *  its host `data-stick-aside` (freeFlightStick): a key whose TARGET is
 *  inside the app passes the stick by, like a key typed in a text field,
 *  while a key pressed with focus elsewhere — the pilot clicked back on the
 *  world with the phone still up — is still the stick's, so flying never
 *  walks the pilot away from the helm. The other half of that promise is
 *  this app's: a flight key it receives must not bubble on to input.ts and
 *  the camera rig (the stick no longer stops it), so the bubble listener
 *  below holds every flight key the app's controls were given, after the
 *  control's own action (the button's click, the slider's step) has had it.
 *  Tab and Escape are not flight keys and stay the phone's. The mark and
 *  the hold go together, and both only while the app is on screen. */
function wireTvStick(host: HTMLElement): void {
  if (host.dataset.tvStick) return;
  host.dataset.tvStick = '1';
  // The mark is carried only while the app is ON SCREEN: the phone slides
  // offscreen and leaves a focused control behind, and a key on that hidden
  // control must be the stick's again — with the mark still there the stick
  // stood aside while this app, not on screen, held nothing back, and W
  // reached the world. Visibility is watched (the container's class and the
  // view's), since the phone closes by many paths; closing the phone also
  // blurs its controls (main.ts), belt and braces.
  const sync = () => {
    if (tvAppOnScreen(host)) host.dataset.stickAside = '1';
    else delete host.dataset.stickAside;
  };
  const observer = new MutationObserver(sync);
  observer.observe(host, { attributes: true, attributeFilter: ['class'] });
  const phone = host.closest<HTMLElement>('#spacephone-container');
  if (phone) observer.observe(phone, { attributes: true, attributeFilter: ['class'] });
  sync();
  host.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (tvAppOnScreen(host) && isFlightKey(e.code)) e.stopPropagation();
  });
}

/** Land keyboard focus in the app as it opens (main.ts): Tab cannot reach
 *  it, so the paste box when the remote is held, else the first control,
 *  takes focus here — or the view itself when there is none to take it. */
export function focusTvApp(host: HTMLElement): void {
  wireTvNav(host);
  const visible = [...host.querySelectorAll<HTMLElement>(NAV_STOPS)].filter((el) => el.offsetParent !== null);
  const first = visible.find((el) => el.matches('[data-tv-paste]')) ?? visible[0];
  (first ?? host).focus({ preventScroll: true });
}

/** Render (and keep rendering) the TV app into its phone view. Called by
 *  main.ts when the view opens; the subscription repaints it while it is the
 *  active view. */
export function renderTvPhoneApp(host: HTMLElement, deps: TvPhoneDeps): void {
  wireTvNav(host);
  wireTvStick(host);
  phoneDeps = deps;
  const paint = () => {
    if (!host.classList.contains('active')) return;
    const d = phoneDeps ?? deps;
    const html = renderTvApp(d);
    // Rebuild only when something other than the clock changed (the status
    // spans tick in place); the clocks move on the timer without a write.
    if (html !== phoneHtml || host.childElementCount === 0) {
      // Keep the player's place across a peer-driven repaint: the control
      // they had focus on, by its data-tv-* identity (a keyboard player
      // stepping through the remote must not be thrown out of it on every
      // heartbeat — and when that control is gone, the view itself keeps
      // the focus, so ↑/↓ still work), and what they have PASTED — whether
      // or not the box has focus: a link pasted, then the finger moved to
      // PLAY or a tile, must not be wiped by a heartbeat or a power write
      // in between (it is cleared by a PLAY or SCHEDULE that took it). The
      // caret is restored only when the box itself had the focus.
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && host.contains(active) ? active : null;
      const focusKey = focusKeyOf(inside);
      const pasteBox = host.querySelector<HTMLInputElement>('input[data-tv-paste]');
      const draft = pasteBox && pasteBox.value
        ? { value: pasteBox.value, focused: pasteBox === inside, start: pasteBox.selectionStart, end: pasteBox.selectionEnd }
        : null;
      host.innerHTML = html;
      phoneHtml = html;
      wireTvApp(host, d);
      const pasteAgain = host.querySelector<HTMLInputElement>('input[data-tv-paste]');
      if (draft && pasteAgain) pasteAgain.value = draft.value;
      if (inside) {
        const again = focusKey ? host.querySelector<HTMLElement>(focusKey) : null;
        (again ?? host).focus({ preventScroll: true });
        if (draft?.focused && again === pasteAgain && pasteAgain) {
          try { pasteAgain.setSelectionRange(draft.start, draft.end); } catch { /* not selectable */ }
        }
      }
    }
    refreshStatus(host);
    syncVolumeSliders(host);
  };
  // One subscription and one clock for the life of the page: the view
  // element is the same on every open (main.ts's #phone-app-tv), and the
  // paint reads the latest deps through phoneDeps.
  if (!phoneSubscribed) {
    phoneSubscribed = true;
    subscribeTv(paint);
    window.setInterval(paint, 1000);
  }
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
  const owner = holdsSpareRemote();
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
  const offered = visibleTiles();
  if (!offered.some((t) => t.key === activeTile)) activeTile = offered[0]!.key;
  const tiles = offered.map((t) => {
    const on = t.key === activeTile;
    return `<button type="button" data-tv-tile="${t.key}" ${t.live ? '' : 'disabled'} title="${esc(t.hint)}" style="
      display:flex; flex-direction:column; align-items:center; gap:3px; padding:8px 4px;
      background:${on ? 'rgba(0,229,255,0.12)' : 'rgba(10,14,34,0.9)'}; border:1px solid ${on ? CYAN : 'rgba(212,168,75,0.18)'};
      border-radius:10px; color:${t.live ? GOLD_BRIGHT : DIM}; font-family:inherit; font-size:8.5px; font-weight:800; cursor:${t.live ? 'pointer' : 'default'};">
      <span style="font-size:16px;">${t.icon}</span><span>${t.label}</span>${laneBadge(t.lane)}${t.live ? '' : `<span style="font-size:7px; color:${DIM};">NOT YET PROVISIONED</span>`}
    </button>`;
  }).join('');
  const tile = offered.find((t) => t.key === activeTile) ?? offered[0]!;
  // A start-only source (archive.org's own player) offers no transport, and
  // a mounted player that cannot seek (a live stream) offers no ±10 s: a
  // target the holder cannot apply would only be beaten back over.
  const startOnly = rec.source ? isStartOnly(rec.source) : false;
  const seekable = !startOnly && (tvPlayerCanSeek(tv.id) ?? true);
  const transport = rec.source && rec.state !== 'off' && rec.state !== 'home'
    ? `<div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
        ${!startOnly && pb.state === 'playing' ? smallButton(`data-tv-pause="${esc(tv.id)}"`, '⏸') : ''}
        ${!startOnly && pb.state === 'paused' ? smallButton(`data-tv-resume="${esc(tv.id)}"`, '▶') : ''}
        ${seekable && (pb.state === 'playing' || pb.state === 'paused') ? smallButton(`data-tv-back="${esc(tv.id)}"`, '⏪ 10s') + smallButton(`data-tv-fwd="${esc(tv.id)}"`, '10s ⏩') : ''}
        ${startOnly ? `<span style="font-size:9px; color:${DIM};">start-time sync only — their player has no pause, seek or volume from here</span>` : ''}
        ${smallButton(`data-tv-stop="${esc(tv.id)}"`, '⏹ STOP')}
        ${startOnly ? '' : `<label style="display:flex; align-items:center; gap:4px; font-size:10px; color:${GOLD};">🔊<input type="range" min="0" max="100" data-tv-volume="${esc(tv.id)}" aria-label="Set volume" title="↑/↓ or ←/→ set the volume · Tab moves on · Escape leaves the slider" style="width:70px;"></label>`}
      </div>`
    : '';
  const history = rec.history.length
    ? `<div class="phone-access-header" style="margin-top:4px;">PREVIOUSLY ON</div>
       ${rec.history.slice(0, 8).map((h, i) => {
         // An entry this build would refuse (playRefusal) is marked; its ▶
         // still answers, with the reason, as the paste box does.
         const off = playRefusal(h.source);
         return `<div class="phone-access-room-row">
         <span style="color:${GOLD_BRIGHT}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;">${esc(h.title)}</span>
         ${laneBadge(sourceLane(h.source))}
         ${off ? `<span style="font-size:7px; color:${DIM}; font-weight:800;" title="${esc(off)}">OFF HERE</span>` : ''}
         ${smallButton(`data-tv-history="${i}" data-tv-id="${esc(tv.id)}"`, '▶')}
       </div>`;
       }).join('')}`
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

/** Why THIS build would refuse to play `source` — the words for the feedback
 *  line — or null when it may play here. Asked before any write from the
 *  remote (PLAY NOW, a schedule, PREVIOUSLY ON alike): a source a peer wrote
 *  into the history, or a build with the convenience lanes on did, is not
 *  written back as the programme for every viewer's theatre to refuse — the
 *  programme on stays as it is. Serverless only (sovereignty.ts): a lane
 *  this build does not offer, a link on another server, a host inside a
 *  private network, a non-link. A public host with the lanes on is not
 *  refused here: the theatre asks the viewer (tvConsent). */
export function playRefusal(source: TvSource): string | null {
  if (!sourceKindAllowed(source.kind)) return `${source.kind === 'youtube' ? 'YouTube' : 'archive.org'} is off here — ${SERVERLESS_ONLY}.`;
  if (source.kind !== 'url' || mediaConsent(source) !== 'refuse') return null;
  const why = consentRefusal(source);
  return why === 'server-off'
    ? `That link is on another server — ${SERVERLESS_ONLY}: a link on this station's node or your own origin plays here.`
    : why === 'node-stale'
      ? 'That link is on this station\'s node, but the node has not answered lately: it plays once the node is back.'
      : why === 'private'
        ? 'That host is inside a private network: nobody in the room can ask a browser to fetch from there.'
        : 'That is not a link the TV can play.';
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
    // Typing must not walk the fox: a typed key stays here. Tab is the
    // phone's own toggle and goes on to it (every other control in the
    // phone lets it), and keyups are never held back — a W held as the
    // remote opened and released in this box must reach InputManager, or
    // the clone walks on until the key is pressed again.
    if (e.key === 'Tab') return;
    e.stopPropagation();
    if (e.key === 'Enter') host.querySelector<HTMLButtonElement>('[data-tv-play]')?.click();
  });

  /** The box's link as a source, with the TEXT it was read from: an archive
   *  lookup can take seconds while the box stays editable, and the clear
   *  that follows a write must take only that text — not a newer link typed
   *  meanwhile and never submitted. */
  const sourceFromBox = async (id: string): Promise<{ source: TvSource; text: string } | null> => {
    const text = paste?.value ?? '';
    const parsed = parseTvSource(text);
    if (!parsed) {
      feedback(text.trim() ? 'That is not a link the TV can play.' : 'Paste a link first.');
      return null;
    }
    // What this build would refuse to play is refused here, with the
    // reason, not written into the room for every viewer's theatre to
    // refuse (playRefusal).
    const refused = playRefusal(parsed);
    if (refused) {
      feedback(refused);
      return null;
    }
    const gen = ++resolveGen;
    if (parsed.kind === 'archive' && !parsed.file && deps.resolveArchive) {
      feedback('Asking archive.org which file to play…');
      const epoch = tvDocEpoch();
      // Any programme action meanwhile — PREVIOUSLY ON, STOP or POWER from
      // this panel, the set's panel or the theatre — moves the record's
      // revision (`jump`, or the switch's `seq`) and voids this lookup.
      const revision = tvRevision(id);
      let found: { file: string; title: string } | null = null;
      try {
        found = await deps.resolveArchive(parsed.identifier);
      } catch { /* fall through to the embed */ }
      if (gen !== resolveGen || epoch !== tvDocEpoch() || tvRevision(id) !== revision) return null; // overtaken
      if (found) return { source: sanitizeSource({ ...parsed, file: found.file, title: found.title }) ?? parsed, text };
      feedback('No playable file found — using their embed (start-time sync only).');
    }
    return { source: parsed, text };
  };

  // The box is cleared BEFORE the write that takes its link: the write
  // notifies the phone synchronously, the repaint may rebuild the box and
  // carry its draft into the replacement, and clearing the detached old box
  // after that would leave the consumed link showing. So: take the text
  // (the box read live, not the one wired here — a repaint during the
  // archive lookup may have replaced it), clear, write, and give the text
  // back to whatever box is mounted when the write is refused.
  const liveBox = () => host.querySelector<HTMLInputElement>('input[data-tv-paste]');
  /** Clear the box of the text that was submitted — and only that: a newer
   *  link typed during the lookup stays. Says whether it was taken. */
  const takeDraft = (text: string): boolean => {
    const box = liveBox();
    if (!box || box.value !== text) return false;
    box.value = '';
    return true;
  };
  const giveBack = (text: string) => {
    const box = liveBox();
    if (box && !box.value) box.value = text;
  };
  host.querySelector<HTMLButtonElement>('[data-tv-play]')?.addEventListener('click', () => {
    const id = host.querySelector<HTMLButtonElement>('[data-tv-play]')!.dataset.tvPlay!;
    void sourceFromBox(id).then((got) => {
      if (!got) return;
      const taken = takeDraft(got.text);
      const r = tvPlay(id, got.source);
      feedback(r.ok ? `Now on: ${sourceLabel(got.source)}` : r.error);
      if (!r.ok && taken) giveBack(got.text);
      if (r.ok) deps.openTheatre(id);
    });
  });
  host.querySelectorAll<HTMLButtonElement>('[data-tv-schedule]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvId!;
    const minutes = Number(b.dataset.tvSchedule);
    void sourceFromBox(id).then((got) => {
      if (!got) return;
      const taken = takeDraft(got.text);
      const r = tvSchedule(id, got.source, Date.now() + minutes * 60_000);
      feedback(r.ok ? `Scheduled: ${sourceLabel(got.source)} in ${minutes} min` : r.error);
      if (!r.ok && taken) giveBack(got.text);
    });
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-history]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvId!;
    const entry = readTv(id).history[Number(b.dataset.tvHistory)];
    if (!entry) return;
    // The paste box's gate: the history is written by peers and by builds
    // with the convenience lanes on, and an entry this build would refuse
    // to play is said no to here — the programme on stays as it is.
    const refused = playRefusal(entry.source);
    if (refused) {
      feedback(refused);
      return;
    }
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
