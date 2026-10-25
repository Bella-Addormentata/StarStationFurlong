/**
 * 📡 tvUI — the SpacePhone's IR BLASTER (🧰 TOOLS → 📡 IR BLASTER, #258),
 * the one place the TV is driven from. No panel at the set and no bar on
 * the screen: clicking a TV, or 🎯 AIM and then a click, points the blaster
 * at it, and the phone shows that set's remote —
 *
 *  - the keys: POWER, VOLUME, the D-pad, STOP, LOOP, the viewer's own
 *    AUTO-FETCH switch, and RELOAD for archive.org's player. While a
 *    programme plays, the D-pad's ◀ ▶ go ten seconds back and on, ▲ ▼ set
 *    the volume and OK pauses; while the set is stopped or paused, its own
 *    menu is up (tvMenu.ts), and the arrows move the highlight on the set
 *    and OK picks what is under it;
 *  - what the set asks of this viewer (tvTheatre's notice): a link to
 *    allow, a file to fetch, a tap for sound;
 *  - the link box and SEND: a web address, a magnet link, or an SSF link
 *    (ssfLink.ts), which this page's node fetches from the nodes it names
 *    before the film goes on;
 *  - a file from this computer, a torrent's download, the host's copies
 *    and the room's library, where 🔗 SSF LINK shares a file on this
 *    page's node by its link.
 *
 * Every press makes the little glow at the phone's tip (irBlaster.ts).
 * Every SpacePhone is a remote: nothing to pick up, hold or hand on, and
 * anyone's press controls the set (tvDoc).
 *
 * Every state change goes through tvDoc; this module renders and asks. Peer
 * strings are escaped before they reach innerHTML (the #116 XSS lesson).
 */

import {
  formatClock, isStartOnly, parseTvSource, readCrt, readLibrary, readPlayback, readRemote, readTv, remoteLapsed, sanitizeSource, sourceId, TV_MAX_TITLE,
  sourceLabel, sourceLane, subscribeTv, tvDocEpoch, tvPause, tvPlay,
  tvResume, tvRevision, tvSchedule, tvSeek, tvSetCrt, tvSetLoop, tvSetVolume, tvStop, tvTogglePower,
} from './tvDoc';
import type { TvHistoryEntry, TvLibraryEntry, TvSource, TvTorrentOrigin } from './tvDoc';
import { escapeHtml } from './htmlEscape';
import { tvPlayerCanSeek, tvPlayerPositionMs } from './tvSession';
import { consentRefusal, mediaConsent } from './tvConsent';
import { convenienceLanesEnabled, sourceKindAllowed, SERVERLESS_ONLY } from './sovereignty';
import { isFlightKey } from './freeFlightStick';
import { readyForRoom } from './tvShrink';
import { autoFetchOn, setAutoFetchOn, TV_AUTO_FETCH_DAY, TV_AUTO_FETCH_MAX } from './tvAutoFetch';
import { focusTvEmbed, reloadTvPicture, subscribeTvTheatre, tvTheatreNotice } from './tvTheatre';
import { irBlink } from './irBlaster';
import { tvMenu, tvMenuCellAt, tvMenuMove, tvMenuStep } from './tvMenu';
import type { TvMenuDir, TvMenuView, TvPausedCell } from './tvMenu';
import {
  blobLaneGeneration, blobLaneNodeId, blobLaneReady, blobLaneRoom, blobStateNow, fetchFromLink, forgetBlob, formatBytes, importBlob, nodeHolders, nodeHolds,
  nodeHostCopies, nodeLibrarySpace, nodeReaches, nodeShares, refreshHeldBlobs, refreshHolders, setHostCopies, shareBlob, torrentLaneReady,
} from './blobLane';
import { formatSsfLink, isSsfFilmLink, parseSsfLink } from './ssfLink';
import {
  confirmTorrent, MAX_TORRENT_FILE, refreshTorrentState, startTorrent, startTorrentAgain, startTorrentFile, stopTorrent,
  torrentLine, torrentOrigin, torrentRunning, torrentSource, torrentState,
} from './torrentLane';

const GOLD = '#d4a84b';
const GOLD_BRIGHT = '#F0C060';
const DIM = '#4A5560';
const GREEN = '#2fe6a0';
const WARN = '#ff8a50';
const CYAN = '#00E5FF';

const esc = escapeHtml;

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

/** What the set is doing, in one line (plain text: it is set with
 *  textContent, never innerHTML). */
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
 *  the countdown tick without rebuilding the blaster around them, so keys
 *  stay where a finger is heading and a note stays readable. */
function statusSpan(itemId: string, style = ''): string {
  return `<span data-tv-status="${esc(itemId)}"${style ? ` style="${style}"` : ''}></span>`;
}

function refreshStatus(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-tv-status]').forEach((el) => {
    const text = statusText(el.dataset.tvStatus!);
    if (el.textContent !== text) el.textContent = text;
  });
}

/** Who pressed last, while their page keeps the set's clock: whose press
 *  put the room where it is. Escaped for innerHTML. */
function lastPressLine(itemId: string, myPub: string): string {
  const r = readRemote(itemId);
  if (!r.holder || remoteLapsed(itemId)) return 'Any SpacePhone in the room is its remote.';
  if (r.holder === myPub) return 'You pressed last. Any SpacePhone in the room is its remote.';
  return `${esc(r.name || 'A clone')} pressed last. Any SpacePhone in the room is its remote.`;
}

// ── The blaster: the phone's 📡 IR BLASTER ─────────────────────────────────

export interface TvPhoneDeps {
  /** The room's TVs (smart-tv / tv-stand items) with a label each. */
  tvs: () => Array<{ id: string; label: string }>;
  myPub: () => string;
  myName: () => string;
  /** Put the set's picture up on it (one set's at a time per page). The
   *  phone stays where it is. */
  openTheatre: (itemId: string) => void;
  /** 🎯 AIM: the phone slides down to its tip and the next TV clicked is
   *  the one the blaster drives (irBlaster.ts, main.ts). */
  aim: () => void;
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

/** What the blaster sends, lane by lane: what the link box takes (a
 *  YouTube or archive.org link, a link to a file, a magnet), a FILE from
 *  this computer, and KARAOKE to come. The set's home screen draws the
 *  same shelf (furniture.ts TV_HOME_TILES). */
const TILES: Tile[] = [
  { key: 'youtube', icon: '▶️', label: 'YOUTUBE', lane: 'CONVENIENCE', hint: 'a watch / youtu.be / shorts link, or an 11-character id', live: true },
  { key: 'archive', icon: '🏛️', label: 'ARCHIVE.ORG', lane: 'CONVENIENCE', hint: 'a details/ or download/ link — public-domain films', live: true },
  { key: 'url', icon: '🔗', label: 'URL', lane: 'CONVENIENCE', hint: 'a direct link to an mp4 / webm', live: true },
  { key: 'file', icon: '📁', label: 'FILE', lane: 'SOVEREIGN', hint: 'a video or audio file from this computer — your node hands it to the room, and every viewer gets it by itself (AUTO-FETCH, up to 2 GB) or with FETCH (mp4 / webm play best)', live: true },
  { key: 'magnet', icon: '🧲', label: 'TORRENT', lane: 'PUBLIC SWARM', hint: 'SEND a magnet link above, or choose a .torrent file here — your node shows what is in it, downloads the video you pick from the public swarm, then hands it to the room like a FILE (viewers never join the swarm)', live: true },
  { key: 'karaoke', icon: '🎤', label: 'KARAOKE', lane: 'SOVEREIGN', hint: 'MP3+G, with the mic on the audio lane', live: false },
];

/** What this build offers (sovereignty.ts): the centralized lanes only with
 *  the convenience lanes on — and without them a URL is labelled for what
 *  it plays here, a file on the viewer's own origins. */
function visibleTiles(): Tile[] {
  // 📦 FILE needs the node's blob lane (blobLane.ts): a browser alone has
  // nowhere to put the file for the room to take it from.
  const tiles = TILES.map((t) => t.key === 'file' && !blobLaneReady()
    ? { ...t, live: false, hint: 'needs this station\'s node (the desktop app) running here: the file goes from your node to theirs' }
    // 🧲 TORRENT needs a node built with the torrent lane (torrentLane.ts).
    : t.key === 'magnet' && !torrentLaneReady()
      ? { ...t, live: false, hint: 'needs this station\'s node (the desktop app), built with torrents, running here: it downloads, then hands the file to the room' }
      : t);
  if (convenienceLanesEnabled()) return tiles;
  return tiles.filter((t) => sourceKindAllowed(t.key)).map((t) => t.key === 'url'
    ? { ...t, lane: 'SOVEREIGN', hint: `a link to an mp4 / webm on this station's node or your own origin — ${SERVERLESS_ONLY}` }
    : t);
}

/** 📦 The file chosen to send, kept across repaints (a file input cannot be
 *  given its selection back), until a SEND or a schedule takes it. */
let pickedFile: File | null = null;

/** The blaster's last word (feedback), kept across repaints for a while: a
 *  repaint rebuilds the line, and a press that also repaints (GET AGAIN, 🗑)
 *  must not lose what it said. Said on the line beside the press: under
 *  the link box, the file, the torrent, the host's copies or the library. */
type Feedback = 'link' | 'file' | 'torrent' | 'host' | 'library';
const FEEDBACK_MS = 20_000;
let feedbackNote: { text: string; at: number; where: Feedback } = { text: '', at: 0, where: 'link' };
function feedbackNow(where: Feedback): string {
  return feedbackNote.where === where && feedbackNote.text && Date.now() - feedbackNote.at < FEEDBACK_MS ? feedbackNote.text : '';
}
function feedbackLine(where: Feedback): string {
  return `<div data-tv-feedback="${where}" style="font-size:9.5px; color:rgba(212,168,75,0.8); min-height:12px; line-height:1.4;">${esc(feedbackNow(where))}</div>`;
}

/** What a SEND or a schedule from the blaster puts on: the source, the box
 *  text it was read from, a torrent's origin for GET AGAIN, and the
 *  original this node lets go once the room plays its copy (tvShrink.ts). */
interface Shared {
  source: TvSource;
  text: string;
  torrent?: TvTorrentOrigin;
  drop?: string;
}

/** The chosen FILE being got ready for the room (tvShrink.ts): a SEND
 *  pressed again meanwhile waits for the same film. */
let fileGettingReady: { got: Shared; room: string } | null = null;

/** 🧲 The .torrent file chosen, kept like pickedFile until a START takes
 *  it; and the file picked from the node's list. */
let pickedTorrent: File | null = null;
let torrentPick: { job: number; index: number } | null = null;

// ── 📚 The library on the remote ─────────────────────────────────────────────

export type LibraryFilter = 'all' | 'files' | 'torrents' | 'links';
const LIBRARY_FILTERS: Array<{ key: LibraryFilter; label: string }> = [
  { key: 'all', label: 'ALL' }, { key: 'files', label: '📁 FILES' }, { key: 'torrents', label: '🧲 TORRENTS' }, { key: 'links', label: '🔗 LINKS' },
];
/** Rows the library shows before SHOW MORE, and how many more each press. */
export const LIBRARY_PAGE = 8;
let libraryFilter: LibraryFilter = 'all';
let libraryQuery = '';
let libraryShown = LIBRARY_PAGE;
/** The row whose 🗑 was pressed once: a second press lets the file go. */
let forgetArmed = '';
/** 🔗 The row whose SSF link is shown under it, and the link. */
let linkShown: { key: string; text: string } | null = null;
/** How often a SEND of an SSF link asks the node how its fetch goes. */
const LINK_POLL_MS = 1_000;

/** What a library row is: a file from a node, a torrent's file, or a link. */
export function libraryKind(e: Pick<TvLibraryEntry, 'source' | 'torrent'>): Exclude<LibraryFilter, 'all'> {
  if (e.source.kind !== 'blob') return 'links';
  return e.torrent ? 'torrents' : 'files';
}

/** The library as the remote lists it: the room's entries, joined by this
 *  set's own PREVIOUSLY ON (a record from before the library, or written by
 *  a build without it), newest first, then filtered and searched. */
export function libraryView(entries: TvLibraryEntry[], history: TvHistoryEntry[], filter: LibraryFilter, query: string): TvLibraryEntry[] {
  const byId = new Map<string, TvLibraryEntry>();
  for (const e of entries) byId.set(sourceId(e.source), e);
  for (const h of history) {
    const id = sourceId(h.source);
    if (!byId.has(id)) byId.set(id, { source: h.source, title: h.title, addedAt: h.playedAt, playedAt: h.playedAt, plays: 1 });
  }
  const q = query.trim().toLowerCase();
  return [...byId.values()]
    .filter((e) => filter === 'all' || libraryKind(e) === filter)
    .filter((e) => !q || e.title.toLowerCase().includes(q) || sourceLabel(e.source).toLowerCase().includes(q))
    .sort((a, b) => b.playedAt - a.playedAt);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago" — wall time, a date by nature. */
export function agoText(at: number, now: number): string {
  const s = Math.max(0, Math.floor((now - at) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** Where a library row's file would play from, for this page now:
 *  'copy' — its sharer is gone, but a node here (the room's host, mostly)
 *  kept a copy; 'elsewhere' — no node here has it, but one met in this room
 *  lately (its sharer, or one that kept a copy) said from wherever it is
 *  online now that it does, and a FETCH reaches it there. */
export type Whereabouts = 'mine' | 'lost' | 'theirs' | 'copy' | 'elsewhere' | 'away' | 'unknown';
export function whereabouts(e: TvLibraryEntry): Whereabouts {
  if (e.source.kind !== 'blob') return 'unknown';
  // Nothing is said before the node has answered (no node, or not yet).
  const reach = nodeReaches(e.source.provider);
  const holds = nodeHolds(e.source.hash);
  if (reach === null || holds === null) return 'unknown';
  if (holds) return 'mine';
  const me = blobLaneNodeId();
  if (reach && e.source.provider !== me) return 'theirs';
  const copy = copyHolder(e);
  if (copy !== null) return nodeReaches(copy) ? 'copy' : 'elsewhere';
  if (e.source.provider === me) return 'lost'; // names this node, which no longer holds it (let go, or made room)
  return 'away';
}

/** A node WHERE said holds the row's file whole, other than this one, one
 *  connected here first: the provider a PLAY from the library names when
 *  its sharer is gone. */
function copyHolder(e: TvLibraryEntry): string | null {
  if (e.source.kind !== 'blob') return null;
  const me = blobLaneNodeId();
  const ids = (nodeHolders(e.source.hash) ?? []).filter((id) => id !== me);
  return ids.find((id) => nodeReaches(id) === true) ?? ids[0] ?? null;
}

/** The title a file's name gives the record: the name without its
 *  extension, in the record's bound. */
export function fileTitle(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{1,5}$/, '').slice(0, TV_MAX_TITLE) || 'a file';
}

const SCHEDULE_CHOICES: Array<{ label: string; minutes: number }> = [
  { label: '+5 MIN', minutes: 5 }, { label: '+15 MIN', minutes: 15 }, { label: '+30 MIN', minutes: 30 }, { label: '+1 H', minutes: 60 },
];

let phoneSubscribed = false;
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

/** Which of `count` visible controls a step of ±1 from the one at `here`
 *  lands on, wrapping at both ends; from no control at all (`here` < 0,
 *  focus on the view itself or outside the stops) the first. The one
 *  piece of the traversal that is arithmetic rather than DOM, so vitest
 *  pins it; the key handling itself is plain DOM, verified in the browser
 *  smoke. */
export function tvNavIndex(count: number, here: number, step: number): number {
  if (count <= 0) return -1;
  if (here < 0 || here >= count) return 0;
  return (((here + step) % count) + count) % count;
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
    stops[tvNavIndex(stops.length, here, step)]!.focus();
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
 *  it, so the paste box, else the first control,
 *  takes focus here — or the view itself when there is none to take it. */
export function focusTvApp(host: HTMLElement): void {
  wireTvNav(host);
  const visible = [...host.querySelectorAll<HTMLElement>(NAV_STOPS)].filter((el) => el.offsetParent !== null);
  const first = visible.find((el) => el.matches('[data-tv-paste]')) ?? visible[0];
  (first ?? host).focus({ preventScroll: true });
}

/** The glow at the phone's tip on every press of a blaster key (data-ir),
 *  by pointer or by Enter / Space alike. Wired once per host. */
function wireIrGlow(host: HTMLElement): void {
  if (host.dataset.tvIr) return;
  host.dataset.tvIr = '1';
  host.addEventListener('click', (e) => {
    const key = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-ir]');
    if (key && !key.disabled) irBlink();
  });
}

/** What the set asks of this viewer (tvTheatre's notice) in its slot on the
 *  face aimed at that set: the theatre's own element, its buttons wired,
 *  moved in after every rebuild and kept current by the theatre's tick. */
let noticeUp = false;
function placeNotice(host: HTMLElement): void {
  const slot = host.querySelector<HTMLElement>('[data-tv-set-says]');
  if (!slot) return;
  const notice = tvTheatreNotice(slot.dataset.tvSetSays!);
  if (notice && notice.parentElement !== slot) slot.replaceChildren(notice);
  else if (!notice && slot.childElementCount) slot.replaceChildren();
  // Newly asked, it is brought into view: the player may have scrolled
  // down to the library. Only then: a rebuild that moves it back in, or a
  // fetch's progress, leaves the scroll where the player put it. Never on
  // a phone put away (the view stays active there): scrolling an element
  // off screen would scroll the page under the game. One asked while the
  // phone is away is brought into view when it opens.
  const onScreen = tvAppOnScreen(host);
  if (notice && !noticeUp && onScreen) notice.scrollIntoView({ block: 'nearest' });
  noticeUp = notice !== null && (noticeUp || onScreen);
}

/** Render (and keep rendering) the blaster into its phone view. Called by
 *  main.ts when the view opens; the subscriptions repaint it while it is
 *  the active view. */
export function renderTvPhoneApp(host: HTMLElement, deps: TvPhoneDeps): void {
  wireTvNav(host);
  wireTvStick(host);
  wireIrGlow(host);
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
      // SEND, must not be wiped by a heartbeat or a power write in between
      // (it is cleared by a SEND or a schedule that took it). The
      // caret is restored only when the box itself had the focus.
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && host.contains(active) ? active : null;
      const focusKey = focusKeyOf(inside);
      const pasteBox = host.querySelector<HTMLInputElement>('input[data-tv-paste]');
      const draft = pasteBox && pasteBox.value
        ? { value: pasteBox.value, focused: pasteBox === inside, start: pasteBox.selectionStart, end: pasteBox.selectionEnd }
        : null;
      // The library's search box is drawn from its own state; only where
      // the caret was needs carrying.
      const searching = inside instanceof HTMLInputElement && inside.matches('[data-tv-lib-search]')
        ? { start: inside.selectionStart, end: inside.selectionEnd }
        : null;
      host.innerHTML = html;
      phoneHtml = html;
      wireTvApp(host, d);
      placeNotice(host);
      const pasteAgain = host.querySelector<HTMLInputElement>('input[data-tv-paste]');
      if (draft && pasteAgain) pasteAgain.value = draft.value;
      if (inside) {
        // A greyed-out key takes no focus (the browser would drop it to the
        // page, and ↑/↓ would stop here). An arrow greyed out by its own
        // move, at the edge of the set's menu, hands it to OK beside it;
        // anything else gone or greyed out, to the view.
        const live = (el: HTMLElement | null) => (el && !el.matches(':disabled') ? el : null);
        const again = focusKey ? host.querySelector<HTMLElement>(focusKey) : null;
        const target = live(again) ?? (again?.closest('.ir-pad') ? live(host.querySelector<HTMLElement>('.ir-pad .ir-ok')) : null) ?? host;
        target.focus({ preventScroll: true });
        if (draft?.focused && target === pasteAgain && pasteAgain) {
          try { pasteAgain.setSelectionRange(draft.start, draft.end); } catch { /* not selectable */ }
        }
        if (searching && target instanceof HTMLInputElement) {
          try { target.setSelectionRange(searching.start, searching.end); } catch { /* not selectable */ }
        }
      }
    }
    placeNotice(host);
    refreshStatus(host);
  };
  // One set of subscriptions and one clock for the life of the page: the
  // view element is the same on every open (main.ts's #phone-app-tv), and
  // the paint reads the latest deps through phoneDeps. The theatre's: its
  // notice comes and goes, and the picture moves between sets.
  if (!phoneSubscribed) {
    phoneSubscribed = true;
    subscribeTv(paint);
    subscribeTvTheatre(paint);
    window.setInterval(paint, 1000);
  }
  paint();
}

/** The set the blaster is aimed at, of the room's (a TV clicked, 📡 AIM on
 *  a row); with one set in the room, that one, aimed or not. */
let aimedTvId = '';
export function aimTvRemote(itemId: string): void {
  aimedTvId = itemId;
}

/** Whether the set has something on: aiming at it puts its picture up. */
export function tvHasSomethingOn(itemId: string): boolean {
  const rec = readTv(itemId);
  return rec.source !== null && rec.state !== 'off' && rec.state !== 'home';
}

function renderTvApp(deps: TvPhoneDeps): string {
  const tvs = deps.tvs();
  if (tvs.length === 0) {
    return `<div class="phone-access-section">
      <div class="phone-access-header">📡 IR BLASTER</div>
      <div class="phone-access-note">No TV in this room to aim at. The DEV menu's FURNITURE list spawns a wall TV or a TV on a stand.</div>
    </div>`;
  }
  const me = deps.myPub();
  const aimed = tvs.find((t) => t.id === aimedTvId) ?? (tvs.length === 1 ? tvs[0]! : null);
  const others = tvs.filter((t) => t.id !== aimed?.id);
  const rows = others.length ? `<div class="phone-access-section">
      <div class="phone-access-header">${aimed ? 'OTHER TVS IN THE ROOM' : 'TVS IN THE ROOM'}</div>
      ${others.map((t) => `<div class="phone-access-room-row"><span class="phone-access-room-label">${esc(t.label)}:</span>${statusSpan(t.id, STATUS_ROW_STYLE)}${smallButton(`data-tv-point="${esc(t.id)}" data-ir="1" title="Aim the blaster at ${esc(t.label)}"`, '📡 AIM')}</div>`).join('')}
    </div>` : '';
  if (!aimed) {
    return `<div class="phone-access-section">
      <div class="phone-access-header">📡 IR BLASTER · NOT AIMED</div>
      <div class="phone-access-note">Press 🎯 AIM, then click a TV in the room, or aim at one below.</div>
      <div style="display:flex; gap:6px;">${smallButton('data-tv-aim="1" title="The phone slides down: click a TV"', '🎯 AIM')}</div>
    </div>${rows}`;
  }
  return `${blasterFace(aimed, me)}${rows}${fileBlock(aimed.id)}${torrentSection(aimed.id)}${hostCopiesBlock()}${libraryBlock(aimed.id, readTv(aimed.id).history)}`;
}

/** A key on the blaster: every press glows at the phone's tip (data-ir). */
function irKey(attr: string, label: string, enabled = true, place = ''): string {
  return `<button type="button" class="ir-key${place ? ` ${place}` : ''}" ${attr} data-ir="1" ${enabled ? '' : 'disabled'}>${label}</button>`;
}

/** The schedule chips for what `from` sends: a movie night N minutes out. */
function scheduleKeys(id: string, from: Feedback, enabled = true): string {
  return SCHEDULE_CHOICES.map((c) => irKey(`data-tv-schedule="${c.minutes}" data-tv-from="${from}" data-tv-id="${id}" title="Put it on in ${c.minutes} minutes, with a countdown on the set"`, `🕒 ${c.label}`, enabled)).join('');
}

/** The blaster aimed at a set: what is on, what the set asks, the keys, and
 *  the link box. A start-only source (archive.org's own player) offers no
 *  transport, and a mounted player that cannot seek (a live stream) no
 *  ±10 s: a target the clock's page cannot apply would only be beaten back
 *  over. */
function blasterFace(tv: { id: string; label: string }, me: string): string {
  const rec = readTv(tv.id);
  const pb = readPlayback(tv.id);
  const id = esc(tv.id);
  const on = rec.state !== 'off';
  const showing = tvHasSomethingOn(tv.id);
  const startOnly = rec.source ? isStartOnly(rec.source) : false;
  const seekable = !startOnly && (tvPlayerCanSeek(tv.id) ?? true);
  const moving = pb.state === 'playing' || pb.state === 'paused';
  const canSeek = showing && seekable && moving;
  const canPause = showing && !startOnly && moving;
  const canVolume = on && !startOnly;
  const lane = showing && rec.source ? laneBadge(sourceLane(rec.source)) : '';
  // 📺 LOOK: only a film the set's own screen draws (an embed's frame lies
  // over the set, out of the CRT pass's reach).
  const looks = showing && rec.source !== null && rec.source.kind !== 'youtube' && !startOnly;
  // The set's own menu, when it is up (stopped or paused): the arrows move
  // its highlight for the whole room, and OK picks what is under it.
  const menu = on ? tvMenu(tv.id) : null;
  const step = (dir: TvMenuDir) => menu !== null && tvMenuStep(menu, dir) !== null;
  const takes = [
    ...visibleTiles().filter((t) => t.live && t.key !== 'file').map((t) => ({ icon: t.icon, label: t.label, lane: t.lane })),
    // 🔗 An SSF link: fetched by this page's node, so only with one.
    ...(blobLaneReady() ? [{ icon: '🔗', label: 'SSF LINK', lane: 'SOVEREIGN' }] : []),
  ].map((t) => `<span style="white-space:nowrap;">${t.icon} ${esc(t.label)} ${laneBadge(t.lane)}</span>`).join(' ');
  return `<div class="phone-access-section ir-face">
    <div class="phone-access-header" style="display:flex; gap:6px; align-items:center;">
      <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">📡 AIMED AT: ${esc(tv.label)}</span>
      ${smallButton('data-tv-aim="1" title="Aim at another TV: the phone slides down, then click one"', '🎯 AIM')}
    </div>
    <div class="phone-access-room-row"><span class="phone-access-room-label">ON:</span>${statusSpan(tv.id, STATUS_ROW_STYLE)}${lane}</div>
    <div style="font-size:10px; color:${GOLD_BRIGHT};">${lastPressLine(tv.id, me)}</div>
    <div data-tv-set-says="${id}"></div>
    <div class="ir-keys">
      <div class="ir-row">
        ${irKey(`data-tv-power="${id}" title="${on ? 'Turn the set off' : 'Turn the set on'}"`, on ? '⏻ OFF' : '⏻ ON')}
        ${startOnly ? '<span class="ir-note">volume: in archive.org\'s player</span>' : `${irKey(`data-tv-vol="-10" data-tv-id="${id}" title="Volume down"`, '🔉', canVolume)}
          <span class="ir-level">${rec.volume}%</span>
          ${irKey(`data-tv-vol="10" data-tv-id="${id}" title="Volume up"`, '🔊', canVolume)}`}
      </div>
      ${menu ? `<div class="ir-note" aria-live="polite">ON THE SET: <b style="color:${GOLD_BRIGHT};">${esc(tvMenuCellAt(menu).label)}</b></div>` : ''}
      <div class="ir-pad" role="group" aria-label="D-pad">
        ${menu ? `${irKey(`data-tv-pad="up" data-tv-id="${id}" title="Up on the set's menu"`, '▲', step('up'), 'ir-up')}
        ${irKey(`data-tv-pad="left" data-tv-id="${id}" title="Left on the set's menu"`, '◀', step('left'), 'ir-left')}
        ${irKey(`data-tv-pad="ok" data-tv-id="${id}" title="Pick ${esc(tvMenuCellAt(menu).label)}"`, 'OK', true, 'ir-ok')}
        ${irKey(`data-tv-pad="right" data-tv-id="${id}" title="Right on the set's menu"`, '▶', step('right'), 'ir-right')}
        ${irKey(`data-tv-pad="down" data-tv-id="${id}" title="Down on the set's menu"`, '▼', step('down'), 'ir-down')}`
        : `${irKey(`data-tv-pad="up" data-tv-id="${id}" title="Volume up"`, '▲', canVolume, 'ir-up')}
        ${irKey(`data-tv-pad="left" data-tv-id="${id}" title="Back 10 seconds"`, '◀', canSeek, 'ir-left')}
        ${irKey(`data-tv-pad="ok" data-tv-id="${id}" title="Play or pause"`, 'OK', canPause, 'ir-ok')}
        ${irKey(`data-tv-pad="right" data-tv-id="${id}" title="On 10 seconds"`, '▶', canSeek, 'ir-right')}
        ${irKey(`data-tv-pad="down" data-tv-id="${id}" title="Volume down"`, '▼', canVolume, 'ir-down')}`}
      </div>
      <div class="ir-note">${menu ? '▲ ▼ ◀ ▶ MOVE ON THE SET · OK PICKS' : '◀ ▶ 10 S · ▲ ▼ VOLUME · OK PLAY / PAUSE'}</div>
      <div class="ir-row">
        ${irKey(`data-tv-play-pause="${id}" title="${pb.state === 'paused' ? 'Play' : 'Pause'}"`, pb.state === 'paused' ? '▶ PLAY' : '⏸ PAUSE', canPause)}
        ${irKey(`data-tv-stop="${id}" title="Back to the home screen"`, '⏹ STOP', showing)}
        ${startOnly ? '' : irKey(`data-tv-loop="${id}" aria-pressed="${rec.loop}" title="At the end, start the film over (stays on for the next one)"`, rec.loop ? '🔁 LOOP: ON' : '🔁 LOOP: OFF')}
        ${looks ? irKey(`data-tv-look="${id}" aria-pressed="${readCrt(tv.id)}" title="The set's picture for the room: the arcade's CRT look, or the film as it is"`, readCrt(tv.id) ? '📺 LOOK: CRT' : '📺 LOOK: CLEAN') : ''}
        ${showing && rec.source?.kind === 'blob' ? irKey(`data-tv-autofetch="1" aria-pressed="${autoFetchOn()}" title="Your own switch: take a file shown on a TV without a press, up to ${esc(formatBytes(TV_AUTO_FETCH_MAX))} a file and ${esc(formatBytes(TV_AUTO_FETCH_DAY))} a day"`, autoFetchOn() ? '📦 AUTO-FETCH: ON' : '📦 AUTO-FETCH: OFF') : ''}
        ${startOnly && showing ? irKey(`data-tv-reload="${id}" title="archive.org's player did not load? Reload it"`, '↻ RELOAD') : ''}
        ${startOnly && showing ? irKey(`data-tv-embed-keys="${id}" title="Into archive.org's player, for its volume and controls: Tab moves through them, and Tab past the last comes back here"`, '🎛 ITS CONTROLS') : ''}
      </div>
    </div>
    <div class="phone-access-header" style="margin-top:4px;">SEND TO THE SET</div>
    <input type="text" data-tv-paste="1" placeholder="a web address, a magnet or an SSF link" autocomplete="off" aria-label="A web address, a magnet link or an SSF link to send to the set">
    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${irKey(`data-tv-send="${id}" title="Put it on the set now"`, '📡 SEND')}
      ${scheduleKeys(id, 'link')}
    </div>
    <div class="phone-access-note">${takes}</div>
    ${feedbackLine('link')}
  </div>`;
}

/** 📁 A file from this computer, through this station's node. */
function fileBlock(tvId: string): string {
  const tile = visibleTiles().find((t) => t.key === 'file');
  if (!tile) return '';
  const id = esc(tvId);
  return `<div class="phone-access-section">
    <div class="phone-access-header">📁 A FILE FROM THIS COMPUTER ${laneBadge(tile.lane)}</div>
    <div class="phone-access-note">${esc(tile.hint)}</div>
    ${tile.live ? `<input type="file" data-tv-file="1" accept="video/*,audio/*" aria-label="Choose a file">
      <div style="font-size:9.5px; color:${GOLD_BRIGHT};">${pickedFile ? `CHOSEN: ${esc(pickedFile.name)} · ${esc(formatBytes(pickedFile.size))}` : 'no file chosen yet'}</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${irKey(`data-tv-send-file="${id}" title="Put it on the set now"`, '📡 SEND FILE')}
        ${scheduleKeys(id, 'file')}
      </div>
      ${feedbackLine('file')}` : ''}
  </div>`;
}

/** 🧲 A torrent: SEND a magnet above, or a .torrent file here; its list, its
 *  download, and SEND DOWNLOAD once the file is whole. */
function torrentSection(tvId: string): string {
  const tile = visibleTiles().find((t) => t.key === 'magnet');
  if (!tile) return '';
  const head = `<div class="phone-access-header">🧲 TORRENT ${laneBadge(tile.lane)}</div>
    <div class="phone-access-note">${esc(tile.hint)}</div>`;
  if (!tile.live) return `<div class="phone-access-section">${head}</div>`;
  const id = esc(tvId);
  const done = torrentSource() !== null;
  return `<div class="phone-access-section">
    ${head}
    ${torrentBlock()}
    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${irKey(`data-tv-send-torrent="${id}" title="Put the downloaded file on the set now"`, '📡 SEND DOWNLOAD', done)}
      ${scheduleKeys(id, 'torrent', done)}
    </div>
    ${feedbackLine('torrent')}
  </div>`;
}

/** 🧲 The torrent's own controls: the notice, a .torrent picker, START /
 *  STOP, the file list to confirm, and the node's progress (kept current
 *  by `pollTorrent` without a repaint, while the node is at it). */
function torrentBlock(): string {
  const st = torrentState();
  const running = torrentRunning(st);
  const notice = `<div class="phone-access-note" style="color:${GOLD};">⚠️ BitTorrent shares pieces of the file with other people while it downloads, from this computer's internet address, and stops when the file is whole. Use only what you may share — openly licensed films like Sintel or Big Buck Bunny.</div>`;
  // Polled while the node is at it (or not asked yet), else said once.
  const watched = running || st.state === 'unknown';
  const status = `<div ${watched ? 'data-tv-torrent-status="1"' : ''} style="font-size:9.5px; color:${GOLD_BRIGHT}; min-height:12px; line-height:1.4;">${esc(torrentLine(st, formatBytes))}</div>`;
  if (st.state === 'ready') {
    // LOOK BEFORE YOU DOWNLOAD: the torrent's own names and sizes.
    const chosen = torrentPick?.job === st.job && st.files.some((f) => f.index === torrentPick!.index) ? torrentPick.index : st.pick;
    const pick = st.files.find((f) => f.index === chosen);
    const rows = st.files.map((f) => `<label style="display:flex; gap:6px; align-items:center; font-size:9.5px; color:${f.fits ? GOLD_BRIGHT : DIM}; cursor:pointer;">
        <input type="radio" name="tv-torrent-pick" data-tv-torrent-pick="${f.index}" ${f.index === chosen ? 'checked' : ''} style="width:auto; flex:none; margin:0; padding:0;">
        <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(f.name)}">${esc(f.name)}</span>
        <span style="white-space:nowrap;">${esc(formatBytes(f.size))}${f.fits ? '' : ' · TOO BIG FOR YOUR NODE'}</span>
      </label>`).join('');
    return `${notice}
      <div class="phone-access-header" style="margin-top:2px;">📋 ${esc(st.name || 'THE TORRENT')} — WHAT IS IN IT</div>
      <div style="display:flex; flex-direction:column; gap:4px; max-height:150px; overflow-y:auto;">${rows}</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${smallButton(`data-tv-torrent-confirm="${st.job}" data-tv-torrent-file-index="${pick?.index ?? ''}"`, pick ? `⬇ DOWNLOAD ${esc(formatBytes(pick.size))}` : '⬇ DOWNLOAD', !!pick && pick.fits)}
        ${smallButton('data-tv-torrent-stop="1"', '✖ CANCEL')}
      </div>
      ${status}`;
  }
  return `${notice}
    ${running ? '' : `<div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap; font-size:9.5px; color:${GOLD};">
      <span>a .torrent file:</span>
      <input type="file" data-tv-torrent-file="1" accept=".torrent,application/x-bittorrent" aria-label="Choose a .torrent file" style="max-width:170px;">
    </div>
    ${pickedTorrent ? `<div style="font-size:9.5px; color:${GOLD_BRIGHT};">CHOSEN: ${esc(pickedTorrent.name)} — 🧲 START reads it (its tracker list is dropped)</div>` : ''}`}
    <div style="display:flex; gap:6px; flex-wrap:wrap;">
      ${running ? smallButton('data-tv-torrent-stop="1"', '⏹ STOP DOWNLOAD') : pickedTorrent ? smallButton('data-tv-torrent-start="1"', '🧲 START') : ''}
    </div>
    ${status}`;
}

/** 🏠 This node hosts the room: whether it keeps copies of what is played
 *  here, and the switch. Shown to anyone aiming here, and before the
 *  library has its first row (copies are on from the moment the room is). */
function hostCopiesBlock(): string {
  void refreshHeldBlobs(); // at most every few seconds; the next paint shows it
  const hostCopies = nodeHostCopies();
  if (!hostCopies) return '';
  return `<div class="phone-access-section">
    <div style="display:flex; gap:6px; align-items:center; font-size:8.5px; color:${DIM};">
      <span style="flex:1;">${hostCopies.on
        ? `🏠 You host this room: your node keeps a copy of each file played here, so visitors can still play it after whoever shared it leaves. Up to ${esc(formatBytes(hostCopies.cap))} a file, ${esc(formatBytes(hostCopies.day))} or ${hostCopies.dayFiles} files a day (today so far: ${hostCopies.files} file${hostCopies.files === 1 ? '' : 's'}, ${esc(formatBytes(hostCopies.spent))}).`
        : '🏠 You host this room. Your node keeps no copies of what is played here, so a file goes when whoever shared it leaves.'}</span>
      ${smallButton(`data-tv-host-copies="${hostCopies.on ? '0' : '1'}" title="${hostCopies.on ? 'Stop keeping copies' : 'Keep copies of what is played here'}"`, hostCopies.on ? '🏠 COPIES ON' : '🏠 COPIES OFF')}
    </div>
    ${feedbackLine('host')}
  </div>`;
}

/** 📚 The room's library: what anyone here has played, kept with the room.
 *  Each row says where its file is now — on your node, on the node that
 *  shared it, or away (🧲 GET AGAIN for a torrent's) — and ▶ plays it. */
function libraryBlock(tvId: string, history: TvHistoryEntry[]): string {
  void refreshHeldBlobs(); // at most every few seconds; the next paint shows it
  const all = libraryView(readLibrary(), history, 'all', '');
  if (all.length === 0) {
    return `<div class="phone-access-section">
      <div class="phone-access-header">📚 LIBRARY</div>
      <div class="phone-access-note">Everything played on a TV in this room lands here, and stays with the room after everyone leaves.</div>
    </div>`;
  }
  const rows = libraryView(readLibrary(), history, libraryFilter, libraryQuery);
  const shown = rows.slice(0, libraryShown);
  // Rows whose sharer is not here: ask the room's nodes who kept a copy
  // (at most every half minute a file; the next paint shows the answer).
  void refreshHolders(shown.flatMap((e) => (e.source.kind === 'blob' && !nodeHolds(e.source.hash) && nodeReaches(e.source.provider) !== true ? [e.source.hash] : [])));
  const wall = Date.now();
  const canAgain = torrentLaneReady();
  const list = shown.map((e) => {
    const kind = libraryKind(e);
    const where = whereabouts(e);
    const refused = playRefusal(e.source);
    const id = esc(sourceId(e.source));
    const icon = kind === 'files' ? '📁' : kind === 'torrents' ? '🧲' : '🔗';
    const size = e.source.kind === 'blob' ? ` · ${formatBytes(e.source.size)}` : '';
    const whereText = where === 'mine' ? `<span style="color:${GREEN};">ON YOUR NODE</span>`
      : where === 'theirs' ? `<span style="color:${CYAN};">ITS NODE IS HERE</span>`
      : where === 'copy' ? `<span style="color:${CYAN};">A COPY IS ON A NODE HERE</span>`
      : where === 'elsewhere' ? `<span style="color:${CYAN};">${e.source.kind === 'blob' && copyHolder(e) === e.source.provider ? 'ITS NODE IS ONLINE ELSEWHERE' : 'A COPY IS ONLINE ELSEWHERE'}</span>`
      : where === 'away' ? `<span style="color:${WARN};">${kind === 'torrents' ? 'AWAY — GET IT AGAIN' : 'ITS NODE IS AWAY'}</span>`
      : where === 'lost' ? `<span style="color:${WARN};">${kind === 'torrents' ? 'GONE FROM YOUR NODE — GET IT AGAIN' : 'GONE FROM YOUR NODE — SEND IT AGAIN FROM 📁 A FILE'}</span>`
      : '';
    const again = e.torrent && canAgain && where !== 'mine' && where !== 'copy' && where !== 'elsewhere'
      ? smallButton(`data-tv-lib-again="${id}" data-tv-id="${esc(tvId)}"`, '🧲 GET AGAIN')
      : '';
    const forget = where === 'mine'
      ? smallButton(`data-tv-lib-forget="${id}" data-tv-id="${esc(tvId)}" title="Let your node's copy go (the library keeps the entry)"`, forgetArmed === sourceId(e.source) ? '🗑 REMOVE?' : '🗑')
      : '';
    // 🔗 A file on this node can go out by an SSF link: whoever pastes it
    // gets the file from this node, from any room.
    const shares = e.source.kind === 'blob' && where === 'mine' ? nodeShares(e.source.hash) : null;
    const link = e.source.kind === 'blob' && where === 'mine'
      ? smallButton(`data-tv-lib-link="${id}" data-tv-id="${esc(tvId)}" title="${shares ? 'Show its SSF link again' : 'Share it by an SSF link: whoever pastes it gets the file from your node, in any room'}"`, '🔗 SSF LINK')
      : '';
    const sharedText = shares ? ` · <span style="color:${GREEN};">🔗 SHARED BY LINK</span>` : '';
    const linkPanel = linkShown && linkShown.key === sourceId(e.source) && shares ? `<div style="display:flex; flex-direction:column; gap:3px; padding:2px 0;">
        <input type="text" readonly data-tv-lib-link-text="1" value="${esc(linkShown.text)}" aria-label="The file's SSF link">
        <div style="font-size:8.5px; color:${DIM};">Whoever pastes this in their IR blaster's box and presses 📡 SEND gets the file from your node, every byte checked against its hash, in any room, while your node is online. Until you stop sharing it, your node gives this file to any node that asks with the link, and that node sees your node's address, as a room's members do.</div>
        <div style="display:flex; gap:4px; flex-wrap:wrap;">
          ${smallButton('data-tv-lib-link-copy="1"', '📋 COPY')}
          ${smallButton(`data-tv-lib-unshare="${id}" data-tv-id="${esc(tvId)}" title="Your node gives this file to no one by its link from now on"`, '⏹ STOP SHARING')}
          ${smallButton('data-tv-lib-link-hide="1"', 'HIDE')}
        </div>
      </div>` : '';
    return `<div style="display:flex; flex-direction:column; gap:2px; padding:4px 0; border-top:1px solid rgba(212,168,75,0.1);">
      <div class="phone-access-room-row">
        <span style="color:${GOLD_BRIGHT}; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;" title="${esc(e.title)}">${icon} ${esc(e.title)}</span>
        ${refused ? `<span style="font-size:7px; color:${DIM}; font-weight:800;" title="${esc(refused)}">OFF HERE</span>` : ''}
        ${again}
        ${link}
        ${forget}
        ${smallButton(`data-tv-lib-play="${id}" data-tv-id="${esc(tvId)}"`, '▶')}
      </div>
      <div style="font-size:8.5px; color:${DIM};">${esc(sourceLane(e.source))}${esc(size)} · ${e.plays > 1 ? `played ${e.plays}× · ` : ''}${esc(agoText(e.playedAt, wall))}${whereText ? ' · ' : ''}${whereText}${sharedText}</div>
      ${linkPanel}
    </div>`;
  }).join('');
  const chips = LIBRARY_FILTERS.map((f) => {
    const on = f.key === libraryFilter;
    return `<button type="button" data-tv-lib-filter="${f.key}" style="padding:3px 7px; border-radius:10px; font-family:inherit; font-size:8.5px; font-weight:800; cursor:pointer;
      background:${on ? 'rgba(0,229,255,0.12)' : 'transparent'}; border:1px solid ${on ? CYAN : 'rgba(212,168,75,0.25)'}; color:${on ? CYAN : GOLD};">${f.label}</button>`;
  }).join('');
  const space = nodeLibrarySpace();
  const spaceLine = !space ? ''
    : space.keep
      ? `<div style="font-size:8.5px; color:${DIM};">Your node keeps its files across restarts: ${esc(formatBytes(space.kept))} of ${esc(formatBytes(space.quota))}. When it is full, the ones used longest ago make room.</div>`
      : `<div style="font-size:8.5px; color:${DIM};">Your node lets its files go when it restarts (SSF_BLOB_KEEP=0).</div>`;
  return `<div class="phone-access-section">
    <div class="phone-access-header">📚 LIBRARY · ${all.length}</div>
    ${spaceLine}
    <div style="display:flex; gap:4px; flex-wrap:wrap;">${chips}</div>
    <input type="text" data-tv-lib-search="1" value="${esc(libraryQuery)}" placeholder="find in the library" autocomplete="off" aria-label="Find in the library">
    ${feedbackLine('library')}
    ${list || `<div class="phone-access-note">Nothing here matches.</div>`}
    ${rows.length > shown.length ? smallButton('data-tv-lib-more="1"', `SHOW MORE (${rows.length - shown.length})`) : ''}
  </div>`;
}

/** While the node is at a torrent (or has not said yet), ask it once a
 *  second and write the line in place; repaint when the torrent moves to
 *  another state (the file list arrives, the download starts, the file is
 *  whole). Stops itself once no line is watched. */
let torrentPoll: ReturnType<typeof setInterval> | null = null;
function pollTorrent(host: HTMLElement, deps: TvPhoneDeps): void {
  if (torrentPoll) return;
  void refreshTorrentState();
  torrentPoll = setInterval(() => {
    const el = host.querySelector<HTMLElement>('[data-tv-torrent-status]');
    if (!el || !host.classList.contains('active')) {
      clearInterval(torrentPoll!);
      torrentPoll = null;
      return;
    }
    const before = torrentState();
    void refreshTorrentState().then((st) => {
      const now = host.querySelector<HTMLElement>('[data-tv-torrent-status]');
      if (!now) return;
      const moved = before.state !== st.state
        || (st.state === 'ready' && before.state === 'ready' && (before.id !== st.id || JSON.stringify(before.files) !== JSON.stringify(st.files)));
      if (moved) renderTvPhoneApp(host, deps);
      else now.textContent = torrentLine(st, formatBytes);
    });
  }, 1_000);
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
  const feedback = (text: string, where: Feedback) => {
    feedbackNote = { text, at: Date.now(), where };
    host.querySelectorAll<HTMLElement>('[data-tv-feedback]').forEach((el) => {
      el.textContent = el.dataset.tvFeedback === where ? text : '';
    });
  };
  // 🎯 Aiming: by a click on the set (AIM, main.ts), or at a row here. A set
  // that is on gets the picture as the blaster turns to it.
  // Kept from the phone's own click handler (main.ts), which would read the
  // phone slid away under the press as put away and bring it back up.
  host.querySelectorAll<HTMLButtonElement>('[data-tv-aim]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    deps.aim();
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-point]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvPoint!;
    aimTvRemote(id);
    if (tvHasSomethingOn(id)) deps.openTheatre(id);
    renderTvPhoneApp(host, deps);
  }));

  // ── The keys ──
  // Where the clock's own player is, when one is mounted here: the record's
  // estimate runs on while a player buffers, and a pause written from it
  // would park the room past unplayed footage.
  const pos = (id: string) => tvPlayerPositionMs(id) ?? readPlayback(id).positionMs;
  const volume = (id: string, by: number) => { tvSetVolume(id, readTv(id).volume + by); };
  const playPause = (id: string) => {
    if (readPlayback(id).state === 'paused') tvResume(id);
    else tvPause(id, pos(id));
  };
  host.querySelectorAll<HTMLButtonElement>('[data-tv-power]').forEach((b) => b.addEventListener('click', () => { tvTogglePower(b.dataset.tvPower!); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-vol]').forEach((b) => b.addEventListener('click', () => { volume(b.dataset.tvId!, Number(b.dataset.tvVol)); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-pad]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvId!;
    // As the set is now, not as the face was drawn: a press elsewhere may
    // have put a menu up, or taken it down, since.
    const menu = tvMenu(id);
    if (menu) {
      if (b.dataset.tvPad === 'ok') pickOnSet(id, menu);
      else tvMenuMove(id, b.dataset.tvPad as TvMenuDir);
      return;
    }
    switch (b.dataset.tvPad) {
      case 'up': volume(id, 10); break;
      case 'down': volume(id, -10); break;
      case 'left': tvSeek(id, Math.max(0, pos(id) - 10_000)); break;
      case 'right': tvSeek(id, pos(id) + 10_000); break;
      case 'ok': playPause(id); break;
    }
  }));
  // ▶ PLAY / ⏸ PAUSE under the pad: that, with a menu up or not (OK picks
  // the lit cell, which may be STOP).
  host.querySelectorAll<HTMLButtonElement>('[data-tv-play-pause]').forEach((b) => b.addEventListener('click', () => { playPause(b.dataset.tvPlayPause!); }));
  /** OK on the set's menu: what the highlighted cell stands for. */
  const pickOnSet = (id: string, menu: TvMenuView) => {
    const at = menu.at;
    if (at.startsWith('lib:')) {
      const entry = libraryEntry(id, at.slice(4));
      if (entry) playEntry(id, entry, 'link');
      return;
    }
    if (at.startsWith('tile:')) {
      readyFor(at.slice(5));
      return;
    }
    switch (at as TvPausedCell) {
      case 'play': tvResume(id); break;
      case 'stop': tvStop(id); break;
      case 'back':
      case 'on':
        if (tvPlayerCanSeek(id) === false) feedback('This stream cannot go back or on.', 'link');
        else tvSeek(id, at === 'back' ? Math.max(0, pos(id) - 10_000) : pos(id) + 10_000);
        break;
      case 'start':
        if (tvPlayerCanSeek(id) === false) feedback('This stream cannot go back to its start.', 'link');
        else if (tvSeek(id, 0).ok) tvResume(id);
        break;
      case 'loop': tvSetLoop(id, !readTv(id).loop); break;
    }
  };
  /** OK on a source tile: this blaster made ready for it, the link box (or
   *  the file chooser, for FILE) and what it takes. Nothing is written: the
   *  set stays as it is until a SEND. */
  const readyFor = (kind: string) => {
    const tile = visibleTiles().find((t) => t.key === kind);
    if (!tile) return;
    const chooser = kind === 'file' ? host.querySelector<HTMLInputElement>('[data-tv-file]') : null;
    if (chooser) {
      chooser.click();
      return;
    }
    if (!tile.live || kind === 'file') {
      feedback(`${tile.icon} ${tile.label} ${tile.hint}.`, 'link');
      return;
    }
    const box = liveBox();
    box?.focus({ preventScroll: true });
    box?.scrollIntoView({ block: 'nearest' });
    feedback(`${tile.icon} ${tile.label}: paste it in the box, then 📡 SEND (${kind === 'magnet' ? 'a magnet link' : tile.hint}).`, 'link');
  };
  host.querySelectorAll<HTMLButtonElement>('[data-tv-stop]').forEach((b) => b.addEventListener('click', () => { tvStop(b.dataset.tvStop!); }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-loop]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvLoop!;
    tvSetLoop(id, !readTv(id).loop);
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-look]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvLook!;
    tvSetCrt(id, !readCrt(id));
  }));
  // Every viewer's own switch, for a file from a member's node: no write.
  host.querySelector<HTMLButtonElement>('[data-tv-autofetch]')?.addEventListener('click', () => {
    setAutoFetchOn(!autoFetchOn());
    renderTvPhoneApp(host, deps);
  });
  host.querySelectorAll<HTMLButtonElement>('[data-tv-reload]').forEach((b) => b.addEventListener('click', () => {
    if (!reloadTvPicture(b.dataset.tvReload!)) feedback('The picture is on another TV here: aim at this one first.', 'link');
  }));
  // A keyboard into archive.org's own frame, and back to this key (the view
  // may have been rebuilt meanwhile: the key as it is then).
  host.querySelectorAll<HTMLButtonElement>('[data-tv-embed-keys]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvEmbedKeys!;
    const back = () => { (host.querySelector<HTMLElement>(`[data-tv-embed-keys="${id}"]`) ?? host).focus({ preventScroll: true }); };
    if (!focusTvEmbed(id, back)) feedback('archive.org\'s player is not up on this TV for you yet.', 'link');
  }));

  // ── SEND ──
  const paste = host.querySelector<HTMLInputElement>('[data-tv-paste]');
  paste?.addEventListener('keydown', (e) => {
    // Typing must not walk the fox: a typed key stays here. Tab is the
    // phone's own toggle and goes on to it (every other control in the
    // phone lets it), and keyups are never held back — a W held as the
    // blaster opened and released in this box must reach InputManager, or
    // the clone walks on until the key is pressed again.
    if (e.key === 'Tab') return;
    e.stopPropagation();
    if (e.key === 'Enter') host.querySelector<HTMLButtonElement>('[data-tv-send]')?.click();
  });

  /** The link box's link as a source, with the TEXT it was read from: an
   *  archive lookup can take seconds while the box stays editable, and the
   *  clear that follows a write must take only that text — not a newer
   *  link typed meanwhile and never submitted. */
  const sourceFromLink = async (id: string, gen: number): Promise<Shared | null> => {
    const text = liveBox()?.value ?? '';
    if (isSsfFilmLink(text)) return sourceFromSsfLink(id, gen, text);
    const parsed = parseTvSource(text);
    if (!parsed) {
      feedback(text.trim() ? 'That is not a link the TV can play.' : 'Paste a web address, a magnet or an SSF link first.', 'link');
      return null;
    }
    // What this build would refuse to play is refused here, with the
    // reason, not written into the room for every viewer's theatre to
    // refuse (playRefusal).
    const refused = playRefusal(parsed);
    if (refused) {
      feedback(refused, 'link');
      return null;
    }
    if (parsed.kind === 'archive' && !parsed.file && deps.resolveArchive) {
      feedback('Asking archive.org which file to play…', 'link');
      const epoch = tvDocEpoch();
      // Any programme action meanwhile — the library, STOP or POWER from
      // any blaster — moves the record's revision (`jump`, or the
      // switch's `seq`) and voids this lookup.
      const revision = tvRevision(id);
      let found: { file: string; title: string } | null = null;
      try {
        found = await deps.resolveArchive(parsed.identifier);
      } catch { /* fall through to the embed */ }
      if (gen !== resolveGen || epoch !== tvDocEpoch() || tvRevision(id) !== revision) return null; // overtaken
      if (found) return { source: sanitizeSource({ ...parsed, file: found.file, title: found.title }) ?? parsed, text };
      feedback('No playable file found — using their embed (start-time sync only).', 'link');
    }
    return { source: parsed, text };
  };

  /** 🔗 An SSF link: this page's node takes the file from the nodes the link
   *  names (or has it already), every byte checked against its hash, and
   *  the film goes on from this node, got ready for the room as a FILE is
   *  (readied). Voided as an archive lookup is — by the next attempt from
   *  this blaster, anything that moves the programme meanwhile, the room or
   *  the node changing — while the fetch goes on: a SEND of the same link
   *  then puts it on at once. */
  const sourceFromSsfLink = async (id: string, gen: number, text: string): Promise<Shared | null> => {
    const link = parseSsfLink(text);
    if (!link) {
      feedback('That SSF link is not whole: it needs the file\'s hash, its size and a node that holds it.', 'link');
      return null;
    }
    const me = blobLaneNodeId();
    if (!me) {
      feedback('An SSF link needs this station\'s node (the desktop app) running here: your node takes the file for you.', 'link');
      return null;
    }
    const name = link.title || 'the film';
    const epoch = tvDocEpoch();
    const revision = tvRevision(id);
    const node = blobLaneGeneration();
    const current = () => gen === resolveGen && epoch === tvDocEpoch() && tvRevision(id) === revision;
    feedback(`Asking your node for ${name} (${formatBytes(link.size)}) from the nodes the link names…`, 'link');
    const why = await fetchFromLink(link);
    if (!current()) return null;
    if (why) {
      feedback(`${name}: ${why}`, 'link');
      return null;
    }
    for (;;) {
      const st = await blobStateNow(link.hash);
      if (!current()) return null;
      if (blobLaneGeneration() !== node || !blobLaneNodeId()) {
        feedback(`Your node restarted or went away while it took ${name}. SEND the link again.`, 'link');
        return null;
      }
      if (st.state === 'complete') {
        // A file this node had already, or was taking for another ask, is
        // not checked against the link's size by the fetch: it is here. Its
        // own size goes to the room, never a link's wrong one (the room's
        // viewers take no byte past it).
        if (st.size !== link.size) {
          feedback(`${name}: your node holds that file at ${formatBytes(st.size)}, not the ${formatBytes(link.size)} the link says. The link is wrong: ask for it again.`, 'link');
          return null;
        }
        break;
      }
      if (st.state === 'failed' || st.state === 'none') {
        feedback(`${name} did not come: ${st.state === 'failed' && st.why ? st.why : 'your node let it go'}. The nodes the link names may be offline, or no longer share it: try again later.`, 'link');
        return null;
      }
      if (st.state === 'queued') feedback(`${name} waits its turn on your node…`, 'link');
      else if (st.state === 'fetching') {
        feedback(`Taking ${name} from the link's nodes… ${Math.floor((st.have / Math.max(1, link.size)) * 100)}% of ${formatBytes(link.size)}, each byte checked against its hash`, 'link');
      }
      await new Promise((r) => setTimeout(r, LINK_POLL_MS));
      if (!current()) return null;
    }
    void refreshHeldBlobs();
    const source = sanitizeSource({ kind: 'blob', hash: link.hash, size: link.size, provider: me, mime: link.mime, title: link.title });
    if (source?.kind !== 'blob') return null;
    return readied({ source, text }, id, gen, 'link');
  };

  /** 📁 The chosen file: handed to this page's node, then got ready for the
   *  room (readied). A SEND pressed again while it is being got ready waits
   *  for the same film. */
  const sourceFromChosenFile = async (id: string, gen: number): Promise<Shared | null> => {
    const waiting = !pickedFile && fileGettingReady?.room === blobLaneRoom() ? fileGettingReady : null;
    const got = waiting?.got ?? (await sourceFromFile(id, gen));
    if (!got) return null;
    const mine = waiting ?? { got, room: blobLaneRoom() };
    fileGettingReady = mine;
    try {
      return await readied(got, id, gen, 'file');
    } finally {
      if (fileGettingReady === mine && gen === resolveGen) fileGettingReady = null;
    }
  };

  /** 🧲 SEND DOWNLOAD takes the finished download, never the magnet: the
   *  room record only ever names the blob it became. The library keeps
   *  where it came from, for GET AGAIN; the programme names only the blob. */
  const sourceFromTorrent = async (id: string, gen: number): Promise<Shared | null> => {
    const source = torrentSource();
    if (!source) {
      const st = torrentState();
      feedback(st.state === 'complete'
        ? 'That download was for another room — SEND the magnet again here.'
        : st.state === 'ready'
        ? 'Pick a file from the list and press ⬇ DOWNLOAD first; SEND DOWNLOAD takes it once it is downloaded.'
        : torrentRunning(st)
        ? 'The download is not finished yet — SEND DOWNLOAD puts it on the TV once it is.'
        : 'SEND a magnet link (or choose a .torrent file and press 🧲 START) first.', 'torrent');
      return null;
    }
    return readied({ source, text: '', torrent: torrentOrigin() ?? undefined }, id, gen, 'torrent');
  };

  /** What `from` sends. Every attempt supersedes the lookup before it, a
   *  refused or malformed one included: a SEND of a bad link must not let
   *  an older archive lookup land its film after the refusal was shown. */
  const sourceFrom = (from: Feedback, id: string): Promise<Shared | null> => {
    const gen = ++resolveGen;
    return from === 'file' ? sourceFromChosenFile(id, gen) : from === 'torrent' ? sourceFromTorrent(id, gen) : sourceFromLink(id, gen);
  };

  /** 🗜 A film from this page's node goes to the room as the copy this
   *  machine makes of it first (tvShrink.ts), or as it is where there is
   *  nothing to gain; the blaster says only that it is getting it ready.
   *  Voided like an archive lookup: by the next attempt from this blaster,
   *  anything that moves the programme meanwhile (STOP, POWER, a library
   *  replay, from any blaster), or the room's doc going (a room left, even
   *  one rejoined). The copy is still made, and the next share of the film
   *  plays it at once. */
  const readied = async (got: Shared, id: string, gen: number, where: Feedback): Promise<Shared | null> => {
    if (got.source.kind !== 'blob') return got;
    const name = got.source.title || 'the film';
    const epoch = tvDocEpoch();
    const revision = tvRevision(id);
    const current = () => gen === resolveGen && epoch === tvDocEpoch() && tvRevision(id) === revision;
    const say = (done: number) => {
      if (current()) feedback(`Getting ${name} ready for the room… ${Math.floor(done * 100)}% · it plays once it is ready, while the station stays open`, where);
    };
    say(0);
    const ready = await readyForRoom(got.source, say);
    if (!current()) return null;
    if (!ready) {
      feedback(`${name} could not be got ready: this station's node changed or went away meanwhile. Press SEND again.`, where);
      return null;
    }
    return { ...got, source: ready.source, drop: ready.drop ?? undefined };
  };
  /** The room plays the copy now: its original leaves this node. */
  const dropOriginal = (got: Shared) => {
    if (got.drop) void forgetBlob(got.drop).then(() => refreshHeldBlobs());
  };

  /** 📦 The chosen file, handed to this page's node first: the record can
   *  only name a blob the clock's node already holds. Voided like an
   *  archive lookup by anything that moves the programme meanwhile. */
  const sourceFromFile = async (id: string, gen: number): Promise<{ source: TvSource; text: string } | null> => {
    const file = pickedFile;
    const provider = blobLaneNodeId();
    if (!file) {
      feedback('Choose a file first.', 'file');
      return null;
    }
    if (!provider) {
      feedback('A file needs this station\'s node (the desktop app) running here.', 'file');
      return null;
    }
    const epoch = tvDocEpoch();
    const revision = tvRevision(id);
    feedback(`Handing ${file.name} to your node…`, 'file');
    const got = await importBlob(file, (sent, total) => {
      if (gen === resolveGen) feedback(`Handing ${file.name} to your node… ${total ? Math.floor((sent / total) * 100) : 0}%`, 'file');
    });
    if (gen !== resolveGen || epoch !== tvDocEpoch() || tvRevision(id) !== revision) return null; // overtaken
    if ('error' in got) {
      feedback(got.error, 'file');
      return null;
    }
    const source = sanitizeSource({ kind: 'blob', hash: got.hash, size: got.size, provider, mime: file.type, title: fileTitle(file.name) });
    if (!source) {
      feedback('That file cannot go on the TV.', 'file');
      return null;
    }
    if (pickedFile === file) pickedFile = null;
    return { source, text: '' };
  };

  // 🧲 A magnet in the link box: SEND hands it to the node, which shows the
  // torrent's list under 🧲 TORRENT; nothing downloads before ⬇ DOWNLOAD.
  const sendMagnet = async (text: string) => {
    feedback('Handing the magnet to your node…', 'link');
    const why = await startTorrent(text);
    if (why) {
      feedback(why, 'link');
      return;
    }
    feedback('🧲 Its file list shows under 🧲 TORRENT below, and nothing downloads until you press ⬇ DOWNLOAD.', 'link');
    torrentPick = null;
    takeDraft(text);
    renderTvPhoneApp(host, deps);
  };
  host.querySelector<HTMLButtonElement>('[data-tv-torrent-start]')?.addEventListener('click', async () => {
    const file = pickedTorrent;
    if (!file) return;
    feedback(`Handing ${file.name} to your node…`, 'torrent');
    const why = await startTorrentFile(file);
    if (why) {
      feedback(why, 'torrent');
      return;
    }
    feedback('', 'torrent');
    if (pickedTorrent === file) pickedTorrent = null;
    torrentPick = null;
    renderTvPhoneApp(host, deps);
  });
  host.querySelector<HTMLInputElement>('[data-tv-torrent-file]')?.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0] ?? null;
    if (f && f.size > MAX_TORRENT_FILE) {
      feedback('That is too big for a .torrent file (over 4 MB).', 'torrent');
      return;
    }
    pickedTorrent = f;
    renderTvPhoneApp(host, deps);
  });
  host.querySelectorAll<HTMLInputElement>('[data-tv-torrent-pick]').forEach((r) => r.addEventListener('change', () => {
    const st = torrentState();
    if (st.state === 'ready') torrentPick = { job: st.job, index: Number(r.dataset.tvTorrentPick) };
    renderTvPhoneApp(host, deps);
  }));
  host.querySelector<HTMLButtonElement>('[data-tv-torrent-confirm]')?.addEventListener('click', async (e) => {
    // The list and file this button was drawn for: the node refuses it if
    // another torrent's list is up by now.
    const button = e.currentTarget as HTMLButtonElement;
    const job = Number(button.dataset.tvTorrentConfirm);
    const index = button.dataset.tvTorrentFileIndex ? Number(button.dataset.tvTorrentFileIndex) : null;
    if (index === null) {
      feedback('Pick a file first.', 'torrent');
      return;
    }
    feedback('Asking your node to download it…', 'torrent');
    const why = await confirmTorrent(job, index);
    feedback(why ?? '', 'torrent');
    renderTvPhoneApp(host, deps);
  });
  host.querySelector<HTMLButtonElement>('[data-tv-torrent-stop]')?.addEventListener('click', async () => {
    const why = await stopTorrent();
    if (why) feedback(why, 'torrent');
    renderTvPhoneApp(host, deps);
  });
  if (host.querySelector('[data-tv-torrent-status]')) pollTorrent(host, deps);
  host.querySelector<HTMLInputElement>('[data-tv-file]')?.addEventListener('change', (e) => {
    pickedFile = (e.target as HTMLInputElement).files?.[0] ?? null;
    renderTvPhoneApp(host, deps);
  });

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
    if (!text || !box || box.value !== text) return false;
    box.value = '';
    return true;
  };
  const giveBack = (text: string) => {
    const box = liveBox();
    if (text && box && !box.value) box.value = text;
  };
  const send = (from: Feedback, id: string) => {
    void sourceFrom(from, id).then((got) => {
      if (!got) return;
      const taken = takeDraft(got.text);
      const r = tvPlay(id, got.source, undefined, got.torrent);
      feedback(r.ok ? `Now on: ${sourceLabel(got.source)}` : r.error, from);
      if (!r.ok && taken) giveBack(got.text);
      if (r.ok) {
        dropOriginal(got);
        deps.openTheatre(id);
      }
    });
  };
  host.querySelector<HTMLButtonElement>('[data-tv-send]')?.addEventListener('click', (e) => {
    const id = (e.currentTarget as HTMLButtonElement).dataset.tvSend!;
    const text = liveBox()?.value.trim() ?? '';
    if (text.startsWith('magnet:')) void sendMagnet(text);
    else send('link', id);
  });
  host.querySelector<HTMLButtonElement>('[data-tv-send-file]')?.addEventListener('click', (e) => {
    send('file', (e.currentTarget as HTMLButtonElement).dataset.tvSendFile!);
  });
  host.querySelector<HTMLButtonElement>('[data-tv-send-torrent]')?.addEventListener('click', (e) => {
    send('torrent', (e.currentTarget as HTMLButtonElement).dataset.tvSendTorrent!);
  });
  host.querySelectorAll<HTMLButtonElement>('[data-tv-schedule]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvId!;
    const from = b.dataset.tvFrom as Feedback;
    const minutes = Number(b.dataset.tvSchedule);
    if (from === 'link' && (liveBox()?.value.trim() ?? '').startsWith('magnet:')) {
      feedback('A magnet downloads first: SEND it, then schedule the download under 🧲 TORRENT.', 'link');
      return;
    }
    void sourceFrom(from, id).then((got) => {
      if (!got) return;
      const taken = takeDraft(got.text);
      const r = tvSchedule(id, got.source, Date.now() + minutes * 60_000, undefined, got.torrent);
      feedback(r.ok ? `Scheduled: ${sourceLabel(got.source)} in ${minutes} min` : r.error, from);
      if (!r.ok && taken) giveBack(got.text);
      if (r.ok) dropOriginal(got);
    });
  }));
  // 📚 The library: its filters, its search, and its rows.
  const libraryEntry = (id: string, key: string) => libraryView(readLibrary(), readTv(id).history, 'all', '').find((e) => sourceId(e.source) === key);
  host.querySelectorAll<HTMLButtonElement>('[data-tv-lib-filter]').forEach((b) => b.addEventListener('click', () => {
    libraryFilter = b.dataset.tvLibFilter as LibraryFilter;
    libraryShown = LIBRARY_PAGE;
    renderTvPhoneApp(host, deps);
  }));
  const search = host.querySelector<HTMLInputElement>('[data-tv-lib-search]');
  search?.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') e.stopPropagation(); // typing must not walk the fox (the paste box's rule)
  });
  search?.addEventListener('input', () => {
    libraryQuery = search.value.slice(0, 80);
    libraryShown = LIBRARY_PAGE;
    renderTvPhoneApp(host, deps);
  });
  host.querySelector<HTMLButtonElement>('[data-tv-lib-more]')?.addEventListener('click', () => {
    libraryShown += LIBRARY_PAGE;
    renderTvPhoneApp(host, deps);
  });
  host.querySelectorAll<HTMLButtonElement>('[data-tv-lib-play]').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.tvId!;
    const entry = libraryEntry(id, b.dataset.tvLibPlay!);
    if (entry) playEntry(id, entry, 'library');
  }));
  /** ▶ on a library row, or OK on its title on the set's menu: said on the
   *  line beside the press (`where`). */
  const playEntry = (id: string, entry: TvLibraryEntry, line: Feedback) => {
    // The link box's gate: the library is written by peers and by builds
    // with the convenience lanes on, and an entry this build would refuse
    // to play is said no to here — the programme on stays as it is.
    const refused = playRefusal(entry.source);
    if (refused) {
      feedback(refused, line);
      return;
    }
    // A file your node holds plays from your node: viewers fetch it from
    // you, whoever shared it first. One whose sharer is gone plays from the
    // node here that kept a copy, or from one met here lately that has it
    // where it is online now.
    const where = whereabouts(entry);
    const me = blobLaneNodeId();
    const copy = where === 'copy' || where === 'elsewhere' ? copyHolder(entry) : null;
    const source = entry.source.kind === 'blob' && where === 'mine' && me ? { ...entry.source, provider: me }
      : entry.source.kind === 'blob' && copy ? { ...entry.source, provider: copy }
      : entry.source;
    const r = tvPlay(id, source);
    if (!r.ok) {
      feedback(r.error, line);
      return;
    }
    feedback(where === 'copy'
      ? `Now on: ${entry.title}, from the copy a node here kept.`
      : where === 'elsewhere'
      ? `Now on: ${entry.title}, from a node that was in this room lately and has it where it is online now.`
      : where === 'away' || where === 'lost'
      ? `Now on: ${entry.title}. ${where === 'lost' ? 'Your node no longer has it' : 'Your node cannot reach the node that shared it, here or elsewhere'}: whoever still has it plays it${entry.torrent ? ', and 🧲 GET AGAIN downloads it once more' : ''}.`
      : `Now on: ${entry.title}`, line);
    deps.openTheatre(id);
  };
  host.querySelectorAll<HTMLButtonElement>('[data-tv-host-copies]').forEach((b) => b.addEventListener('click', async () => {
    const on = b.dataset.tvHostCopies === '1';
    const why = await setHostCopies(on);
    feedback(why ?? (on
      ? 'Your node keeps a copy of each file played in this room from now on, while whoever shared it is connected.'
      : 'Your node keeps no more copies for this room. The ones it has stay until you 🗑 them or it needs the room.'), 'host');
    renderTvPhoneApp(host, deps);
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-lib-forget]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.tvLibForget!;
    if (forgetArmed !== key) {
      forgetArmed = key;
      feedback('Press 🗑 again to let your node\'s copy go. The library keeps the entry: ▶ then fetches it from whoever has it.', 'library');
      renderTvPhoneApp(host, deps);
      return;
    }
    forgetArmed = '';
    // The file the entry plays now, not the one its key names: a smaller
    // copy is filed under its original (sourceId), and it is the copy that
    // is on this node.
    const entry = libraryEntry(b.dataset.tvId!, key);
    const hash = entry?.source.kind === 'blob' ? entry.source.hash : '';
    const why = await forgetBlob(hash);
    feedback(why ?? 'Your node let its copy go.', 'library');
    void refreshHeldBlobs();
    renderTvPhoneApp(host, deps);
  }));
  // 🔗 SSF LINK: the file is marked shareable on this page's node, and its
  // link shown under the row (and copied, where the page may write the
  // clipboard). It names this node, then the nodes the link this file came
  // from named.
  host.querySelectorAll<HTMLButtonElement>('[data-tv-lib-link]').forEach((b) => b.addEventListener('click', async () => {
    const key = b.dataset.tvLibLink!;
    const entry = libraryEntry(b.dataset.tvId!, key);
    const me = blobLaneNodeId();
    if (entry?.source.kind !== 'blob' || !me) return;
    const { hash, size, mime } = entry.source;
    const got = await shareBlob(hash, true);
    if ('error' in got) {
      feedback(got.error, 'library');
      return;
    }
    const text = formatSsfLink({ hash, size, title: entry.title, mime: mime ?? '', nodes: [me, ...got.via] });
    linkShown = { key, text };
    const copied = await navigator.clipboard?.writeText(text).then(() => true, () => false) ?? false;
    feedback(copied
      ? `🔗 The SSF link to ${entry.title} is copied: send it to whoever you like. Your node shares the file with anyone who has it.`
      : `🔗 The SSF link to ${entry.title} is below: select it and copy it. Your node shares the file with anyone who has it.`, 'library');
    renderTvPhoneApp(host, deps);
  }));
  host.querySelector<HTMLButtonElement>('[data-tv-lib-link-copy]')?.addEventListener('click', async () => {
    if (!linkShown) return;
    const box = host.querySelector<HTMLInputElement>('[data-tv-lib-link-text]');
    const copied = await navigator.clipboard?.writeText(linkShown.text).then(() => true, () => false) ?? false;
    if (!copied) box?.select();
    feedback(copied ? '🔗 Copied.' : '🔗 This page may not write the clipboard: the link is selected, copy it with the keys.', 'library');
  });
  const linkText = host.querySelector<HTMLInputElement>('[data-tv-lib-link-text]');
  linkText?.addEventListener('focus', () => linkText.select());
  linkText?.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') e.stopPropagation(); // copy keys must not walk the fox (the paste box's rule)
  });
  host.querySelector<HTMLButtonElement>('[data-tv-lib-link-hide]')?.addEventListener('click', () => {
    linkShown = null;
    renderTvPhoneApp(host, deps);
  });
  host.querySelectorAll<HTMLButtonElement>('[data-tv-lib-unshare]').forEach((b) => b.addEventListener('click', async () => {
    const entry = libraryEntry(b.dataset.tvId!, b.dataset.tvLibUnshare!);
    if (entry?.source.kind !== 'blob') return;
    const got = await shareBlob(entry.source.hash, false);
    if ('error' in got) {
      feedback(got.error, 'library');
      return;
    }
    linkShown = null;
    feedback(`🔗 ${entry.title} is shared by its link no more: your node gives it only to the members of the rooms it was played in, as before. A copy someone already took stays theirs.`, 'library');
    renderTvPhoneApp(host, deps);
  }));
  host.querySelectorAll<HTMLButtonElement>('[data-tv-lib-again]').forEach((b) => b.addEventListener('click', async () => {
    const entry = libraryEntry(b.dataset.tvId!, b.dataset.tvLibAgain!);
    if (!entry?.torrent) return;
    feedback(`Asking your node for ${entry.title} again…`, 'library');
    const why = await startTorrentAgain(entry.torrent);
    if (why) {
      feedback(why, 'library');
      return;
    }
    // 🧲 TORRENT shows its file list: nothing downloads before ⬇ DOWNLOAD.
    torrentPick = null;
    feedback(`🧲 Looking up ${entry.title}: its file list shows under 🧲 TORRENT, and nothing downloads until you press ⬇ DOWNLOAD.`, 'library');
    renderTvPhoneApp(host, deps);
  }));
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
