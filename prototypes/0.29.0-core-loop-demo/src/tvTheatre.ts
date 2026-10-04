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
import type { SeekableRange, TvPlayer } from './tvSync';
import {
  countdownText, formatClock, iHoldRemote, isStartOnly, mayPickUpRemote, pickUpRemote,
  readPlayback, readRemote, readTv, remoteLapsed, sourceFileUrl, sourceId, sourceLabel,
  sourceLane, tvPause, tvResume, tvSeek, tvSetVolume, tvStop,
} from './tvDoc';
import type { TvSource } from './tvDoc';
import { registerTvPlayerOfRecord } from './tvSession';
import { acceptMediaOrigin, mediaConsent, mediaOrigin } from './tvConsent';
import { escapeHtml } from './htmlEscape';

// ── YouTube IFrame API ───────────────────────────────────────────────────────

interface YtPlayerLike {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  /** Seconds; 0 until the video's metadata has loaded. */
  getDuration(): number;
  getPlayerState(): number;
  setVolume(volume: number): void;
  destroy(): void;
}
interface YtNamespace {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YtPlayerLike;
}
type WindowWithYt = Window & { YT?: YtNamespace; onYouTubeIframeAPIReady?: () => void };

const YT_API_URL = 'https://www.youtube.com/iframe_api';
/** A player that stays silent this long has failed: the YouTube API script
 *  can load while the nocookie iframe never says ready, and a host can
 *  accept a media request and never deliver metadata nor an error. */
const MEDIA_READY_TIMEOUT_MS = 20_000;
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
  /** The media's length in ms ONLY when the player knows the media to be
   *  finite, else null: the end the holder's headless beat closes the
   *  programme at once this theatre is gone (tvSession). Not the seekable
   *  range's end — for a progressive download from a host without range
   *  support that covers only the buffered prefix, and the room would be
   *  stopped before the file ended — and not a reading from a player that
   *  cannot tell a live stream from a file: a live event's elapsed time
   *  reported as a length would stop the broadcast for everyone. */
  durationMs(): number | null;
}

class YouTubePlayerAdapter implements Adapter {
  readonly canNudge = false;
  readonly canSeek = true;
  readonly hasClock = true;
  private player: YtPlayerLike | null = null;
  private ready = false;
  private state = -1;
  private readonly readyTimer: number;

  /** `autoplay` only when the room is playing at mount time: a countdown or
   *  a paused set must not sound for the 400 ms before the controller's
   *  first tick — the controller starts the player when the record says. */
  constructor(host: HTMLElement, videoId: string, yt: YtNamespace, onFail: (why: string) => void, autoplay = true) {
    const mount = document.createElement('div');
    host.appendChild(mount);
    const playerVars: Record<string, unknown> = {
      autoplay: autoplay ? 1 : 0, playsinline: 1, rel: 0, enablejsapi: 1, modestbranding: 1,
    };
    // Bounded readiness, through the attempt-scoped failure path: an
    // adopted player that never reports ready would otherwise hide the
    // notice, silence the headless beat and offer no RETRY, for good.
    this.readyTimer = window.setTimeout(() => {
      if (!this.ready) onFail("YouTube's player did not become ready");
    }, MEDIA_READY_TIMEOUT_MS);
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
        onReady: () => { this.ready = true; window.clearTimeout(this.readyTimer); },
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
  /** The whole video, once its metadata has said how long it is — for
   *  clamping seeks; on a live event getDuration is the time since it
   *  began, which is also where such a stream can be sought within. */
  seekableRange(): SeekableRange | null {
    try {
      const seconds = this.player?.getDuration() ?? 0;
      return seconds > 0 ? { startMs: 0, endMs: seconds * 1000 } : null;
    } catch { return null; }
  }
  /** Never an end from here: the IFrame API does not say whether a video
   *  is live, and getDuration on a live event is elapsed time — a value
   *  that can repeat between polls before it grows, so no number of equal
   *  readings proves a length. A YouTube programme ends through the
   *  holder's open theatre (the controller sees the ENDED state) or by a
   *  transport action, never by the headless beat. */
  durationMs(): null { return null; }
  setRate(): void { /* YouTube's rate steps are coarse: the controller only seeks */ }
  setVolume(volume: number): void { try { this.player?.setVolume(volume); } catch { /* not ready */ } }
  destroy(): void {
    window.clearTimeout(this.readyTimer);
    try { this.player?.destroy(); } catch { /* already gone */ }
    this.player = null;
  }
}

class HtmlVideoPlayerAdapter implements Adapter {
  readonly canNudge = true;
  readonly hasClock = true;
  /** Only within the ranges the element can seek in: a live stream, or a
   *  host without usable range support, has none — such a source plays
   *  start-only, and the controller never seeks what cannot be sought. */
  get canSeek(): boolean { return this.video.seekable.length > 0; }
  readonly video: HTMLVideoElement;
  /** The browser refused play() without a gesture: the panel shows TAP TO PLAY. */
  blocked = false;
  private readonly readyTimer: number;

  constructor(host: HTMLElement, url: string, onFail: (why: string) => void, private onBlocked: () => void) {
    const v = document.createElement('video');
    v.src = url;
    v.playsInline = true;
    v.preload = 'auto';
    v.controls = false;
    v.style.cssText = 'width:100%; height:100%; background:#000; display:block;';
    v.addEventListener('error', () => onFail('This file would not play here (format or host)'));
    // Bounded readiness, through the attempt-scoped failure path: a host can
    // accept the request and never deliver metadata nor an error, which
    // would leave the theatre blank with no RETRY and the holder's headless
    // beat silenced by an adapter that is never ready.
    this.readyTimer = window.setTimeout(() => {
      if (v.readyState < 1) onFail('The file did not start loading (no metadata after 20 s)');
    }, MEDIA_READY_TIMEOUT_MS);
    v.addEventListener('loadedmetadata', () => window.clearTimeout(this.readyTimer), { once: true });
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
  /** The element's own `seekable` ranges, first start to last end: a file's
   *  whole length, a live stream's sliding window (its end may be open);
   *  null before the ranges arrive. */
  seekableRange(): SeekableRange | null {
    const ranges = this.video.seekable;
    if (ranges.length === 0) return null;
    return { startMs: ranges.start(0) * 1000, endMs: ranges.end(ranges.length - 1) * 1000 };
  }
  /** The element's own `duration`: a file's length, Infinity for a live
   *  stream (null here), NaN before the metadata (null). */
  durationMs(): number | null {
    const seconds = this.video.duration;
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  }
  setRate(rate: number): void { this.video.playbackRate = rate; }
  setVolume(volume: number): void { this.video.volume = Math.min(1, Math.max(0, volume / 100)); }
  destroy(): void {
    window.clearTimeout(this.readyTimer);
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
  seekableRange(): null { return null; }
  durationMs(): null { return null; }
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
  /** The programme (the record's `started`) the mounted player is for, as
   *  of this theatre's last tick: tvSession files the player's end under
   *  that programme alone, so a room tick between a source change and the
   *  remount cannot put the old player's length on the new programme. */
  playerFor: number;
  /** The mount key of what the adapter was built for ('' = nothing mounted):
   *  the sourceId, plus the programme's `started` for a start-only embed. */
  mounted: string;
  /** Bumped on every unmount: an adapter still being built (the YouTube API
   *  loading) for an earlier attempt is thrown away when it arrives. */
  attempt: number;
  timer: number;
  unregister: (() => void) | null;
  lastStatus: string;
  lastControls: string;
  lastHead: string;
  lastNotice: string;
  onKey: (e: KeyboardEvent) => void;
  /** What had focus when the theatre opened: focus goes back there on close. */
  opener: HTMLElement | null;
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
  // Modal while it is the topmost overlay: Tab stays inside and clicks go
  // nowhere else, and assistive technology is told the same. The phone
  // opening above it (a hand-over pops it open on the remote) takes the
  // top: theatreTick drops the modal claim while the phone is up, so the
  // remote is not hidden from a screen reader behind a dialog that is no
  // longer the one in front.
  root.setAttribute('aria-modal', 'true');
  root.innerHTML = `
    <div class="tv-theatre-panel">
      <div class="tv-theatre-head"></div>
      <div class="tv-theatre-screen"><div class="tv-theatre-notice" hidden></div></div>
      <div class="tv-theatre-status"></div>
      <div class="tv-theatre-controls"></div>
    </div>`;
  // Clicks inside the panel stay inside it — the world's click handler
  // listens on window and would walk the player or wake a device behind the
  // overlay — and a click on the dark surround closes.
  root.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === root) closeTvTheatre();
  });
  document.body.appendChild(root);
  const onKey = (e: KeyboardEvent) => {
    // The phone open above the theatre (a hand-over pops it open without
    // closing this) owns Tab and Escape: its handlers close it or go home.
    if (phoneIsUp()) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeTvTheatre();
      return;
    }
    // Tab stays inside the dialog (the phone's own Tab shortcut would
    // otherwise swallow it): cycle through the theatre's controls.
    if (e.key === 'Tab') {
      const focusable = theatreFocusable(root);
      if (focusable.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? focusable[(at <= 0 ? focusable.length : at) - 1]!
        : focusable[(at + 1) % focusable.length]!;
      next.focus();
      return;
    }
    // Every other key pressed while the theatre is topmost stays in it, like
    // its clicks — WHATEVER has focus: the world listens on window, and
    // Enter on a focused button would also open the quick chat, WASD walk
    // the clone behind the overlay, Space and E wake whatever the player
    // stands at. Focus is not always in the dialog: nothing (the body), or a
    // button on the phone a hand-over opened above this and Tab then closed
    // — the phone only slides offscreen and leaves its button focused, and
    // a key on that hidden button is still a key pressed over this dialog.
    // The key's own action (the button's click, the slider's step) is
    // untouched, and keyup is never held back, so a key held across the
    // open is still released to the world.
    e.stopPropagation();
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
    attempt: 0,
    timer: 0,
    unregister: null,
    lastStatus: '',
    lastControls: '',
    lastHead: '',
    lastNotice: '',
    onKey,
    opener: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    playerFor: -1,
  };
  // The dialog takes focus (Tab then reaches its controls); it goes back on close.
  root.tabIndex = -1;
  root.focus();
  const rtt = deps.rttMs ?? (() => 0);
  theatre.timer = window.setInterval(() => theatreTick(rtt), 400);
  theatreTick(rtt);
  updateTvChip([itemId]);
}

/** The SpacePhone is open above everything (a hand-over pops it open on the
 *  remote without closing the theatre): then IT is the topmost overlay. */
function phoneIsUp(): boolean {
  return document.getElementById('spacephone-container')?.classList.contains('active') ?? false;
}

/** The theatre's controls in Tab order: its buttons, the volume slider and
 *  the embedded player itself (an iframe takes focus, and the archive
 *  embed's own controls — its volume among them — live inside it). */
function theatreFocusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), iframe')];
}

export function closeTvTheatre(): void {
  if (!theatre) return;
  const t = theatre;
  theatre = null;
  window.clearInterval(t.timer);
  window.removeEventListener('keydown', t.onKey, true);
  unmountPlayer(t);
  t.root.remove();
  if (t.opener && t.opener.isConnected) t.opener.focus();
}

function unmountPlayer(t: Theatre): void {
  t.attempt += 1; // whatever is still being built for the old mount is void
  t.unregister?.();
  t.unregister = null;
  t.controller = null;
  t.player?.destroy();
  t.player = null;
  t.mounted = '';
  for (const child of [...t.screen.children]) if (child !== t.notice) child.remove();
}

/** What a mounted adapter is keyed by. A start-only embed can neither seek
 *  nor replay, so a new programme START of the same source (PLAY NOW again,
 *  PREVIOUSLY ON) is a new key and gets a fresh iframe; seekable players
 *  follow a replay through the controller instead. */
function mountKey(source: TvSource, started: number): string {
  return isStartOnly(source) ? `${sourceId(source)}@${started}` : sourceId(source);
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

/** Build the adapter for `source`; the controller then drives it. Every
 *  callback belongs to THIS attempt: an unmount in between (another source,
 *  a failure, the set going off) voids it, so an adapter arriving late is
 *  destroyed on arrival and never overwrites a live one. */
function mountPlayer(t: Theatre, source: TvSource, key: string, rtt: () => number): void {
  unmountPlayer(t);
  t.mounted = key;
  const token = t.attempt;
  const live = () => theatre === t && t.attempt === token;
  const fail = (why: string) => {
    if (!live()) return;
    unmountPlayer(t);
    t.mounted = `failed:${key}`;
    showNotice(t, `<div>${escapeHtml(why)}</div>
      <div class="tv-theatre-lane">${escapeHtml(sourceLane(source))} LANE — nothing else in the room depends on it</div>
      <button type="button" data-tv-retry="1">RETRY</button>`);
    t.notice.querySelector<HTMLButtonElement>('[data-tv-retry]')?.addEventListener('click', () => {
      t.mounted = '';
    });
  };
  const adopt = (player: Adapter) => {
    if (!live()) {
      player.destroy();
      return;
    }
    hideNotice(t);
    t.player = player;
    const controller = new TvSyncController({ itemId: t.itemId, player, rttMs: rtt });
    t.controller = controller;
    // Only a player with a clock becomes the room's clock; the archive embed
    // reports nothing, so the headless heartbeat (tvSession) keeps beating.
    // The phone's transport asks the controller where the room is: the
    // player's clock once in step, the target a jump is still carrying it
    // to until then (a pause written from where the player still reads
    // would park the room there).
    if (player.hasClock) {
      t.unregister = registerTvPlayerOfRecord(t.itemId, {
        positionMs: () => controller.positionMs(),
        canSeek: () => player.canSeek,
        // The programme this player is for, as this theatre last saw it:
        // an end it reports belongs to that programme and no later one.
        started: () => t.playerFor,
        endMs: () => player.durationMs(),
      });
    }
  };
  if (source.kind === 'youtube') {
    showNotice(t, `<div>REACHING YOUTUBE…</div><div class="tv-theatre-lane">CONVENIENCE LANE</div>`);
    loadYouTubeApi().then(
      (yt) => adopt(new YouTubePlayerAdapter(
        t.screen, source.videoId, yt, fail, readPlayback(t.itemId).state === 'playing',
      )),
      (err: Error) => fail(err.message || 'YouTube is unreachable'),
    );
    return;
  }
  const url = sourceFileUrl(source);
  if (url) {
    adopt(new HtmlVideoPlayerAdapter(t.screen, url, fail, () => {
      if (!live()) return;
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
  // Modal only while topmost: the phone above it is what a screen reader
  // must reach, and a modal dialog beneath would hide it (see openTvTheatre).
  const modal = phoneIsUp() ? 'false' : 'true';
  if (t.root.getAttribute('aria-modal') !== modal) t.root.setAttribute('aria-modal', modal);
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
  } else {
    const key = mountKey(rec.source!, rec.started);
    // This viewer's browser fetches only what this viewer allows
    // (tvConsent): a peer-written URL is asked about first, and one inside
    // a private network is never fetched. Asked of EVERY tick, not only at
    // the mount: the node's origin is trusted only while the node answers
    // as ours (main.ts's fingerprint probe), and a player left mounted
    // after that trust is withdrawn would keep a `src` on a loopback port
    // that whatever binds it next may answer — its later range and
    // reconnection requests would go to a stranger. A source that lost its
    // consent comes down and is asked about again. Whatever was mounted
    // before comes down meanwhile — the old programme is over either way.
    const consent = mediaConsent(rec.source!);
    // A mount that is over — another source, a start-only embed's new
    // start, a consent withdrawn — comes down FIRST, while its registration
    // still names the programme it was mounted for: the unregistration
    // files the player's last end report (tvSession), and filed under the
    // next programme's number a short film's length would stop the live
    // stream that followed it once the theatre closed.
    const stale = t.mounted !== '' && (consent !== 'ok' || (t.mounted !== key && t.mounted !== `failed:${key}`));
    if (stale) unmountPlayer(t);
    // The programme the player is (or is about to be) mounted for — noted
    // here, on the theatre's own tick, so between a source change and this
    // tick the registration still names the OLD programme and tvSession
    // files nothing new under it (a replay of the same seekable source
    // keeps the player and moves it on to the new programme).
    t.playerFor = rec.started;
    if (consent !== 'ok') {
      showConsentNotice(t, rec.source!, consent);
    } else if (t.mounted !== key && t.mounted !== `failed:${key}`) {
      mountPlayer(t, rec.source!, key, rtt);
    }
  }
  t.controller?.tick();
  renderTheatreChrome(t);
}

/** PLAY FROM <host>? — or NOT PLAYED HERE for a host inside a private
 *  network, which no button can override. */
function showConsentNotice(t: Theatre, source: TvSource, consent: 'ask' | 'refuse'): void {
  const origin = mediaOrigin(source) ?? '';
  let host = origin;
  try { host = new URL(origin).host; } catch { /* shown as it is */ }
  if (consent === 'refuse') {
    showNotice(t, `<div>NOT PLAYED HERE</div>
      <div class="tv-theatre-lane">${escapeHtml(host || 'this link')} is inside a private network — nobody in the room can ask your browser to fetch from there</div>`);
    return;
  }
  // The button under the finger stays — the same ask every tick is one ask —
  // but only for the SAME origin: a programme that moves on to another
  // unapproved host gets its own ask, not the old button and its handler.
  const asking = t.notice.hidden ? null : t.notice.querySelector<HTMLButtonElement>('[data-tv-allow]');
  if (asking && asking.dataset.tvAllow === origin) return;
  showNotice(t, `<div>PLAY FROM ${escapeHtml(host)}?</div>
    <div class="tv-theatre-lane">${escapeHtml(sourceLane(source))} LANE — your browser would fetch this from ${escapeHtml(host)}, which could send it anywhere, your own network included; whoever pasted it cannot decide that for you</div>
    <button type="button" data-tv-allow="${escapeHtml(origin)}">▶ PLAY FROM ${escapeHtml(host)}</button>`);
  t.notice.querySelector<HTMLButtonElement>('[data-tv-allow]')?.addEventListener('click', () => {
    acceptMediaOrigin(origin);
    hideNotice(t);
  });
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
  // A mounted player that cannot seek (a live stream, a host without usable
  // ranges) is start-only too, whatever the source kind promised.
  const seekable = !startOnly && (t.player ? t.player.canSeek : true);
  const sync = startOnly || !seekable ? ' · start-time sync only' : '';
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
    mine && seekable && (pb.state === 'playing' || pb.state === 'paused') ? btn('data-tv-back="1"', '⏪ 10s') + btn('data-tv-fwd="1"', '10s ⏩') : '',
    mine && rec.source ? btn('data-tv-stop="1"', '⏹ STOP') : '',
    // archive.org's own player takes no volume from us: the set's level
    // drives every other player; theirs is adjusted inside the frame. And
    // a frame that never loaded gives no sign of it: RELOAD is the retry.
    startOnly
      ? '<span class="tv-theatre-lane">volume: in archive.org\'s player</span>'
      : `<label class="tv-theatre-volume">🔊 <input type="range" min="0" max="100" value="${rec.volume}" data-tv-volume="1" aria-label="Set volume"></label>`,
    startOnly && t.player ? btn('data-tv-reload="1"', '↻ RELOAD PLAYER', "archive.org's player did not load? Reload it") : '',
    !mine && mayPickUpRemote(t.itemId) ? btn('data-tv-pickup="1"', '🎛 PICK UP THE REMOTE') : '',
    !mine && held ? `<span class="tv-theatre-lane">${escapeHtml(remote.name || 'someone')} has the remote</span>` : '',
  ].join('');
  if (controls !== t.lastControls) {
    // A control row rebuilt under the keyboard keeps its place: ⏸ pressed
    // with Enter becomes ▶ in the same slot, and the next Enter must find
    // it — focus dropped to the body would go nowhere (and nowhere is where
    // the world's shortcuts would have taken it, before onKey held them).
    const focused = document.activeElement;
    const slot = focused instanceof HTMLElement && t.controls.contains(focused)
      ? theatreFocusable(t.controls).indexOf(focused) : -1;
    t.controls.innerHTML = controls;
    t.lastControls = controls;
    if (slot >= 0) {
      const rebuilt = theatreFocusable(t.controls);
      (rebuilt[Math.min(slot, rebuilt.length - 1)] ?? t.root).focus();
    }
    const c = t.controls;
    // Where the room is: the controller's word when a player with a clock
    // is mounted (its own clock, or the target a jump is still carrying it
    // to), else the record's.
    const pos = () => (t.controller && t.player?.hasClock ? t.controller.positionMs() : readPlayback(t.itemId).positionMs);
    c.querySelector<HTMLButtonElement>('[data-tv-pause]')?.addEventListener('click', () => { tvPause(t.itemId, pos()); });
    c.querySelector<HTMLButtonElement>('[data-tv-resume]')?.addEventListener('click', () => { tvResume(t.itemId); });
    c.querySelector<HTMLButtonElement>('[data-tv-back]')?.addEventListener('click', () => { tvSeek(t.itemId, Math.max(0, pos() - 10_000)); });
    c.querySelector<HTMLButtonElement>('[data-tv-fwd]')?.addEventListener('click', () => { tvSeek(t.itemId, pos() + 10_000); });
    c.querySelector<HTMLButtonElement>('[data-tv-stop]')?.addEventListener('click', () => { tvStop(t.itemId); });
    c.querySelector<HTMLButtonElement>('[data-tv-pickup]')?.addEventListener('click', () => { pickUpRemote(t.itemId); });
    c.querySelector<HTMLInputElement>('[data-tv-volume]')?.addEventListener('change', (e) => {
      tvSetVolume(t.itemId, Number((e.target as HTMLInputElement).value));
    });
    c.querySelector<HTMLButtonElement>('[data-tv-reload]')?.addEventListener('click', () => { t.mounted = ''; });
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
    chip.addEventListener('click', (e) => {
      e.stopPropagation(); // the world's click handler on window must not see it
      if (chip?.dataset.tv) chipOpen?.(chip.dataset.tv);
    });
    document.body.appendChild(chip);
  }
  chip.dataset.tv = target;
  chip.textContent = label;
}
