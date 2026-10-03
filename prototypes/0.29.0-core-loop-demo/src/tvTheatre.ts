/**
 * 📺 tvTheatre — the DOM half of the TV: the player adapters (the YouTube
 * IFrame API, an HTML <video>, the archive.org embed) and the THEATRE, the
 * overlay any room member opens to watch what the set is showing, in sync
 * with everyone else (tvSync.ts drives the adapter from the room record).
 *
 * WHY A PANEL AND NOT THE IN-WORLD SCREEN (plan §3.4): a cross-origin iframe
 * cannot be sampled into a texture, and a cross-origin <video> without CORS
 * headers taints one — but both play fine as DOM. So v1 draws the status,
 * the menu and the countdown on the prop's CanvasTexture (furniture.ts) and
 * plays the picture here. The in-world iframe (CSS3D hole-punch) is spike
 * S1; the node's media proxy later feeds a VideoTexture for files.
 *
 * Sovereignty (plan §3.3): YouTube and archive.org are CONVENIENCE lanes.
 * They are labelled as such on the panel, an unreachable one says so and
 * offers a retry, and nothing else in the room depends on them.
 */

import { TvSyncController } from './tvSync';
import type { TvPlayer } from './tvSync';
import {
  countdownText, formatClock, iHoldRemote, isStartOnly, mayPickUpRemote, pickUpRemote,
  readPlayback, readRemote, readTv, remoteLapsed, sourceFileUrl, sourceId, sourceLabel,
  sourceLane, tvPause, tvResume, tvSeek, tvSetVolume, tvStop,
} from './tvDoc';
import type { TvSource } from './tvDoc';
import { registerTvPlayerOfRecord } from './tvSession';
import { escapeHtml } from './htmlEscape';

// ── YouTube IFrame API ───────────────────────────────────────────────────────

interface YtPlayerLike {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  destroy(): void;
}
interface YtNamespace {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YtPlayerLike;
}
type WindowWithYt = Window & { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };

const YT_API_URL = 'https://www.youtube.com/iframe_api';
let ytLoading: Promise<YtNamespace> | null = null;

/** Load the IFrame API script once. Rejects when it cannot be reached (no
 *  internet, a blocked host) so the panel can say so instead of hanging. */
export function loadYouTubeApi(timeoutMs = 12_000): Promise<YtNamespace> {
  const w = window as WindowWithYt;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (ytLoading) return ytLoading;
  ytLoading = new Promise<YtNamespace>((resolve, reject) => {
    const fail = (why: string) => {
      ytLoading = null;
      reject(new Error(why));
    };
    const timer = window.setTimeout(() => fail('YouTube did not answer'), timeoutMs);
    const previous = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      previous?.();
      if (w.YT?.Player) resolve(w.YT);
      else fail('YouTube API loaded without a player');
    };
    const script = document.createElement('script');
    script.src = YT_API_URL;
    script.async = true;
    script.addEventListener('error', () => {
      window.clearTimeout(timer);
      fail('YouTube is unreachable');
    });
    document.head.appendChild(script);
  });
  return ytLoading;
}

interface Adapter extends TvPlayer {
  destroy(): void;
}

class YouTubePlayerAdapter implements Adapter {
  readonly canNudge = false;
  readonly canSeek = true;
  readonly hasClock = true;
  private player: YtPlayerLike | null = null;
  private ready = false;
  private state = -1;

  constructor(host: HTMLElement, videoId: string, yt: YtNamespace, onFail: (why: string) => void) {
    const mount = document.createElement('div');
    host.appendChild(mount);
    const playerVars: Record<string, unknown> = {
      autoplay: 1, playsinline: 1, rel: 0, enablejsapi: 1, modestbranding: 1,
    };
    // The `origin` guard only makes sense from an http(s) page; a custom
    // scheme (tauri://) must not send one YouTube will refuse.
    if (location.protocol === 'https:' || location.protocol === 'http:') playerVars.origin = location.origin;
    this.player = new yt.Player(mount, {
      videoId,
      host: 'https://www.youtube-nocookie.com',
      width: '100%',
      height: '100%',
      playerVars,
      events: {
        onReady: () => { this.ready = true; },
        onStateChange: (e: { data: number }) => { this.state = e.data; },
        onError: (e: { data: number }) => onFail(`YouTube player error ${e.data}`),
      },
    });
  }
  isReady(): boolean { return this.ready; }
  /** 1 = PLAYING, 3 = BUFFERING: both count as "going". */
  isPlaying(): boolean { return this.state === 1 || this.state === 3; }
  /** 0 = ENDED. */
  isEnded(): boolean { return this.state === 0; }
  play(): void { try { this.player?.playVideo(); } catch { /* not ready */ } }
  pause(): void { try { this.player?.pauseVideo(); } catch { /* not ready */ } }
  seek(ms: number): void { try { this.player?.seekTo(ms / 1000, true); } catch { /* not ready */ } }
  currentMs(): number {
    try { return (this.player?.getCurrentTime() ?? 0) * 1000; } catch { return 0; }
  }
  setRate(): void { /* YouTube's rate steps are coarse: the controller only seeks */ }
  setVolume(volume: number): void { try { this.player?.setVolume(volume); } catch { /* not ready */ } }
  destroy(): void {
    try { this.player?.destroy(); } catch { /* already gone */ }
    this.player = null;
  }
}

class HtmlVideoPlayerAdapter implements Adapter {
  readonly canNudge = true;
  readonly canSeek = true;
  readonly hasClock = true;
  readonly video: HTMLVideoElement;
  /** The browser refused play() without a gesture: the panel shows TAP TO PLAY. */
  blocked = false;

  constructor(host: HTMLElement, url: string, onFail: (why: string) => void, private onBlocked: () => void) {
    const v = document.createElement('video');
    v.src = url;
    v.playsInline = true;
    v.preload = 'auto';
    v.controls = false;
    v.style.cssText = 'width:100%; height:100%; background:#000; display:block;';
    v.addEventListener('error', () => onFail('This file would not play here (format or host)'));
    host.appendChild(v);
    this.video = v;
  }
  isReady(): boolean { return this.video.readyState >= 1; }
  isPlaying(): boolean { return !this.video.paused && !this.video.ended; }
  isEnded(): boolean { return this.video.ended; }
  play(): void {
    const p = this.video.play();
    if (p && typeof p.catch === 'function') {
      p.then(() => { this.blocked = false; }).catch(() => {
        this.blocked = true;
        this.onBlocked();
      });
    }
  }
  pause(): void { this.video.pause(); }
  seek(ms: number): void { try { this.video.currentTime = ms / 1000; } catch { /* not seekable yet */ } }
  currentMs(): number { return this.video.currentTime * 1000; }
  setRate(rate: number): void { this.video.playbackRate = rate; }
  setVolume(volume: number): void { this.video.volume = Math.min(1, Math.max(0, volume / 100)); }
  destroy(): void {
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.video.remove();
  }
}

/** archive.org's own player: official, no proxy, but a cross-origin iframe
 *  with no API — everyone starts at the shared start, nothing more. */
class ArchiveEmbedAdapter implements Adapter {
  readonly canNudge = false;
  readonly canSeek = false;
  readonly hasClock = false;
  private readonly iframe: HTMLIFrameElement;
  constructor(host: HTMLElement, identifier: string) {
    const f = document.createElement('iframe');
    f.src = `https://archive.org/embed/${encodeURIComponent(identifier)}?autoplay=1`;
    f.allow = 'autoplay; fullscreen';
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.style.cssText = 'width:100%; height:100%; border:0; display:block; background:#000;';
    host.appendChild(f);
    this.iframe = f;
  }
  isReady(): boolean { return true; }
  isPlaying(): boolean { return true; }
  isEnded(): boolean { return false; }
  play(): void { /* the embed autoplays; no API to drive */ }
  pause(): void { /* no API */ }
  seek(): void { /* no API */ }
  currentMs(): number { return 0; }
  setRate(): void { /* no API */ }
  setVolume(): void { /* no API */ }
  destroy(): void { this.iframe.remove(); }
}

// ── The theatre ──────────────────────────────────────────────────────────────

interface Theatre {
  root: HTMLDivElement;
  itemId: string;
  label: string;
  screen: HTMLDivElement;
  notice: HTMLDivElement;
  status: HTMLDivElement;
  controls: HTMLDivElement;
  head: HTMLDivElement;
  player: Adapter | null;
  controller: TvSyncController | null;
  /** sourceId of what the adapter was built for ('' = nothing mounted). */
  mounted: string;
  timer: number;
  unregister: (() => void) | null;
  lastStatus: string;
  lastControls: string;
  lastHead: string;
  lastNotice: string;
  onKey: (e: KeyboardEvent) => void;
}

let theatre: Theatre | null = null;

export interface TheatreDeps {
  /** A display name for the TV item ("WALL TV", "TV ON THE STAND"). */
  label?: string;
  /** Measured round trip, for the half-transit lead on samples. */
  rttMs?: () => number;
}

export function isTvTheatreOpen(itemId?: string): boolean {
  return theatre !== null && (itemId === undefined || theatre.itemId === itemId);
}

export function tvTheatreItemId(): string | null {
  return theatre?.itemId ?? null;
}

export function openTvTheatre(itemId: string, deps: TheatreDeps = {}): void {
  if (theatre && theatre.itemId !== itemId) closeTvTheatre();
  if (theatre) return;
  const root = document.createElement('div');
  root.id = 'tv-theatre';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Television');
  root.innerHTML = `
    <div class="tv-theatre-panel">
      <div class="tv-theatre-head"></div>
      <div class="tv-theatre-screen"><div class="tv-theatre-notice" hidden></div></div>
      <div class="tv-theatre-status"></div>
      <div class="tv-theatre-controls"></div>
    </div>`;
  // Clicks inside the panel stay inside it; a click on the dark surround closes.
  root.addEventListener('click', (e) => {
    if (e.target === root) closeTvTheatre();
  });
  document.body.appendChild(root);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeTvTheatre();
    }
  };
  window.addEventListener('keydown', onKey, true);
  theatre = {
    root,
    itemId,
    label: deps.label ?? 'TV',
    screen: root.querySelector<HTMLDivElement>('.tv-theatre-screen')!,
    notice: root.querySelector<HTMLDivElement>('.tv-theatre-notice')!,
    status: root.querySelector<HTMLDivElement>('.tv-theatre-status')!,
    controls: root.querySelector<HTMLDivElement>('.tv-theatre-controls')!,
    head: root.querySelector<HTMLDivElement>('.tv-theatre-head')!,
    player: null,
    controller: null,
    mounted: '',
    timer: 0,
    unregister: null,
    lastStatus: '',
    lastControls: '',
    lastHead: '',
    lastNotice: '',
    onKey,
  };
  const rtt = deps.rttMs ?? (() => 0);
  theatre.timer = window.setInterval(() => theatreTick(rtt), 400);
  theatreTick(rtt);
  updateTvChip([itemId]);
}

export function closeTvTheatre(): void {
  if (!theatre) return;
  const t = theatre;
  theatre = null;
  window.clearInterval(t.timer);
  window.removeEventListener('keydown', t.onKey, true);
  unmountPlayer(t);
  t.root.remove();
}

function unmountPlayer(t: Theatre): void {
  t.unregister?.();
  t.unregister = null;
  t.controller = null;
  t.player?.destroy();
  t.player = null;
  t.mounted = '';
  for (const child of [...t.screen.children]) if (child !== t.notice) child.remove();
}

/** Put the notice up; the same words again leave the DOM (and a button in
 *  it, under a finger) alone. */
function showNotice(t: Theatre, html: string): void {
  if (!t.notice.hidden && t.lastNotice === html) return;
  t.notice.innerHTML = html;
  t.lastNotice = html;
  t.notice.hidden = false;
}
function hideNotice(t: Theatre): void {
  t.notice.hidden = true;
  t.notice.innerHTML = '';
  t.lastNotice = '';
}

/** Build the adapter for `source`; the controller then drives it. */
function mountPlayer(t: Theatre, source: TvSource, rtt: () => number): void {
  unmountPlayer(t);
  t.mounted = sourceId(source);
  const fail = (why: string) => {
    if (theatre !== t || t.mounted !== sourceId(source)) return;
    unmountPlayer(t);
    t.mounted = `failed:${sourceId(source)}`;
    showNotice(t, `<div>${escapeHtml(why)}</div>
      <div class="tv-theatre-lane">${escapeHtml(sourceLane(source))} LANE — nothing else in the room depends on it</div>
      <button type="button" data-tv-retry="1">RETRY</button>`);
    t.notice.querySelector<HTMLButtonElement>('[data-tv-retry]')?.addEventListener('click', () => {
      t.mounted = '';
    });
  };
  const adopt = (player: Adapter) => {
    if (theatre !== t || t.mounted !== sourceId(source)) {
      player.destroy();
      return;
    }
    hideNotice(t);
    t.player = player;
    t.controller = new TvSyncController({ itemId: t.itemId, player, rttMs: rtt });
    // Only a player with a clock becomes the room's clock; the archive embed
    // reports nothing, so the headless heartbeat (tvSession) keeps beating.
    if (player.hasClock) t.unregister = registerTvPlayerOfRecord(t.itemId);
  };
  if (source.kind === 'youtube') {
    showNotice(t, `<div>REACHING YOUTUBE…</div><div class="tv-theatre-lane">CONVENIENCE LANE</div>`);
    loadYouTubeApi().then(
      (yt) => adopt(new YouTubePlayerAdapter(t.screen, source.videoId, yt, fail)),
      (err: Error) => fail(err.message || 'YouTube is unreachable'),
    );
    return;
  }
  const url = sourceFileUrl(source);
  if (url) {
    adopt(new HtmlVideoPlayerAdapter(t.screen, url, fail, () => {
      if (theatre !== t) return;
      // The controller retries play() every tick while blocked: the notice
      // (and the button under the finger) that is already up stays up.
      if (!t.notice.hidden && t.notice.querySelector('[data-tv-tap]')) return;
      showNotice(t, `<button type="button" data-tv-tap="1">▶ TAP TO PLAY</button>
        <div class="tv-theatre-lane">your browser wants a tap before sound</div>`);
      t.notice.querySelector<HTMLButtonElement>('[data-tv-tap]')?.addEventListener('click', () => {
        hideNotice(t);
        t.player?.play();
      });
    }));
    return;
  }
  if (source.kind === 'archive') {
    adopt(new ArchiveEmbedAdapter(t.screen, source.identifier));
    return;
  }
  fail('The TV cannot play this.');
}

function theatreTick(rtt: () => number): void {
  const t = theatre;
  if (!t) return;
  const rec = readTv(t.itemId);
  const on = rec.state !== 'off' && rec.state !== 'home' && rec.source !== null;
  if (!on) {
    if (t.mounted) unmountPlayer(t);
    showNotice(t, rec.state === 'off'
      ? '<div>THE SET IS OFF</div><div class="tv-theatre-lane">press POWER on the TV, or pick up the remote</div>'
      : '<div>FURLONG TV</div><div class="tv-theatre-lane">nothing on — the remote picks a programme</div>');
  } else if (isStartOnly(rec.source!) && readPlayback(t.itemId).state !== 'playing') {
    // archive.org's own player autoplays and can neither pause nor seek: it
    // goes up only while the room is playing. A countdown or a pause is
    // words here, no iframe — else WATCH during a countdown would start the
    // film early, and reopening a paused one would start it over.
    if (t.mounted) unmountPlayer(t);
    const pb = readPlayback(t.itemId);
    showNotice(t, pb.state === 'scheduled'
      ? `<div>${countdownText(pb.countdownMs)}</div><div class="tv-theatre-lane">archive.org's player starts at T0 — start-time sync only</div>`
      : '<div>❚❚ PAUSED</div><div class="tv-theatre-lane">archive.org\'s player has no pause: it starts from the top when the film resumes</div>');
  } else if (t.mounted !== sourceId(rec.source!) && t.mounted !== `failed:${sourceId(rec.source!)}`) {
    mountPlayer(t, rec.source!, rtt);
  }
  t.controller?.tick();
  renderTheatreChrome(t);
}

function renderTheatreChrome(t: Theatre): void {
  const rec = readTv(t.itemId);
  const remote = readRemote(t.itemId);
  const held = remote.holder !== '' && !remoteLapsed(t.itemId);
  const mine = iHoldRemote(t.itemId);
  const pb = readPlayback(t.itemId);
  const title = rec.source ? sourceLabel(rec.source) : 'FURLONG TV';
  const lane = rec.source ? sourceLane(rec.source) : '';
  const head = `<span class="tv-theatre-title">📺 ${escapeHtml(t.label)} · ${escapeHtml(title)}</span>
    ${lane ? `<span class="tv-lane-badge tv-lane-${lane.toLowerCase().replace(/[^a-z]/g, '-')}">${lane}</span>` : ''}
    <button type="button" class="tv-theatre-close" data-tv-close="1" aria-label="Close">✕</button>`;
  if (head !== t.lastHead) {
    t.head.innerHTML = head;
    t.lastHead = head;
    t.head.querySelector<HTMLButtonElement>('[data-tv-close]')?.addEventListener('click', () => closeTvTheatre());
  }
  const startOnly = rec.source ? isStartOnly(rec.source) : false;
  const sync = startOnly ? ' · start-time sync only' : '';
  const who = held ? `REMOTE · ${escapeHtml(remote.name || 'a clone')}` : 'REMOTE ON THE SET';
  const where = pb.state === 'scheduled' ? countdownText(pb.countdownMs)
    : pb.state === 'paused' ? `PAUSED · ${formatClock(pb.positionMs)}`
    : pb.state === 'playing' ? `● ${formatClock(pb.positionMs)}` : '';
  const status = `${who}${where ? ` · ${where}` : ''}${sync}`;
  if (status !== t.lastStatus) {
    t.status.textContent = status;
    t.lastStatus = status;
  }
  const btn = (attr: string, label: string, title = '') =>
    `<button type="button" ${attr} ${title ? `title="${escapeHtml(title)}"` : ''}>${label}</button>`;
  // A start-only source offers no transport: the embed cannot pause or seek.
  const controls = [
    mine && !startOnly && pb.state === 'playing' ? btn('data-tv-pause="1"', '⏸') : '',
    mine && !startOnly && pb.state === 'paused' ? btn('data-tv-resume="1"', '▶') : '',
    mine && !startOnly && (pb.state === 'playing' || pb.state === 'paused') ? btn('data-tv-back="1"', '⏪ 10s') + btn('data-tv-fwd="1"', '10s ⏩') : '',
    mine && rec.source ? btn('data-tv-stop="1"', '⏹ STOP') : '',
    `<label class="tv-theatre-volume">🔊 <input type="range" min="0" max="100" value="${rec.volume}" data-tv-volume="1" aria-label="Set volume"></label>`,
    !mine && mayPickUpRemote(t.itemId) ? btn('data-tv-pickup="1"', '🎛 PICK UP THE REMOTE') : '',
    !mine && held ? `<span class="tv-theatre-lane">${escapeHtml(remote.name || 'someone')} has the remote</span>` : '',
  ].join('');
  if (controls !== t.lastControls) {
    t.controls.innerHTML = controls;
    t.lastControls = controls;
    const c = t.controls;
    // Where the room is: the player's own clock when it has one, else the record's.
    const pos = () => (t.player && t.player.hasClock ? t.player.currentMs() : readPlayback(t.itemId).positionMs);
    c.querySelector<HTMLButtonElement>('[data-tv-pause]')?.addEventListener('click', () => { tvPause(t.itemId, pos()); });
    c.querySelector<HTMLButtonElement>('[data-tv-resume]')?.addEventListener('click', () => { tvResume(t.itemId); });
    c.querySelector<HTMLButtonElement>('[data-tv-back]')?.addEventListener('click', () => { tvSeek(t.itemId, Math.max(0, pos() - 10_000)); });
    c.querySelector<HTMLButtonElement>('[data-tv-fwd]')?.addEventListener('click', () => { tvSeek(t.itemId, pos() + 10_000); });
    c.querySelector<HTMLButtonElement>('[data-tv-stop]')?.addEventListener('click', () => { tvStop(t.itemId); });
    c.querySelector<HTMLButtonElement>('[data-tv-pickup]')?.addEventListener('click', () => { pickUpRemote(t.itemId); });
    c.querySelector<HTMLInputElement>('[data-tv-volume]')?.addEventListener('change', (e) => {
      tvSetVolume(t.itemId, Number((e.target as HTMLInputElement).value));
    });
  }
}

// ── The HUD chip: "something is on" ──────────────────────────────────────────

let chip: HTMLButtonElement | null = null;
/** `<itemId>|<label>` of what the chip shows: two sets with the same words
 *  are still two sets, and WATCH must open the one still playing. */
let chipKey = '';
let chipOpen: ((itemId: string) => void) | null = null;

/** Register how the chip opens the theatre (main.ts supplies the deps). */
export function setTvChipOpener(fn: (itemId: string) => void): void {
  chipOpen = fn;
}

/** Driven at ~2 Hz by World with the room's TV ids: shows a WATCH chip while
 *  a TV has something on and the theatre is closed. */
export function updateTvChip(itemIds: readonly string[]): void {
  let label = '';
  let target = '';
  if (!theatre) {
    for (const id of itemIds) {
      const rec = readTv(id);
      if (!rec.source || rec.state === 'off' || rec.state === 'home') continue;
      const pb = readPlayback(id);
      const what = sourceLabel(rec.source).toUpperCase();
      label = pb.state === 'scheduled'
        ? `📺 ${what} · ${countdownText(pb.countdownMs)} · WATCH`
        : pb.state === 'paused' ? `📺 ${what} · PAUSED · WATCH` : `📺 NOW ON: ${what} · WATCH`;
      target = id;
      break;
    }
  }
  const key = label ? `${target}|${label}` : '';
  if (key === chipKey) return;
  chipKey = key;
  if (!label) {
    chip?.remove();
    chip = null;
    return;
  }
  if (!chip) {
    chip = document.createElement('button');
    chip.type = 'button';
    chip.id = 'tv-chip';
    chip.addEventListener('click', () => {
      if (chip?.dataset.tv) chipOpen?.(chip.dataset.tv);
    });
    document.body.appendChild(chip);
  }
  chip.dataset.tv = target;
  chip.textContent = label;
}
