/**
 * 📺 tvTheatre — the DOM half of the TV: the player adapters (the YouTube
 * IFrame API, an HTML <video>, the archive.org embed) and the THEATRE, which
 * plays what the set is showing ON THE SET, in sync with everyone else
 * (tvSync.ts drives the adapter from the room record), with a slim bar at the
 * foot of the window for its notices and controls. Never a popup.
 *
 * WHERE THE PICTURE GOES: a <video> (a file from the node, a link) is handed
 * to the set's screen handle (furniture.ts showVideo), which puts its frames
 * on the in-world screen as a texture. That needs an untainted video: a blob
 * comes from the node with CORS, and a link on another host is only mounted
 * after a CORS check (tvConsent probeRedirect), so both are asked for in CORS
 * mode. An embed's iframe cannot be sampled into a texture at all, so it is
 * laid over the set's screen plane in the DOM (tvScreenLayer.ts).
 *
 * A set in the room that is playing opens the theatre on its own (the room
 * tick, updateTvChip); ✕ on the bar turns the picture off for this viewer
 * until the next programme, and the chip's WATCH brings it back.
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
  sourceLane, tvDocEpoch, tvNow, tvPause, tvResume, tvSeek, tvSetVolume, tvStop,
} from './tvDoc';
import type { TvSource } from './tvDoc';
import { registerTvPlayerOfRecord } from './tvSession';
import {
  acceptMediaOrigin, allowMount, consentRefusal, mayMountNow, mediaConsent, mediaOrigin, needsRedirectProbe, probeRedirect,
  redirectVerdict, TV_MOUNT_BUDGET,
} from './tvConsent';
import { SERVERLESS_ONLY } from './sovereignty';
import { blobLaneReady, blobNodeTag, blobState, blobUrl, fetchBlob, formatBytes, recheckBlob, refreshHolders } from './blobLane';
import type { BlobState } from './blobLane';
import { escapeHtml } from './htmlEscape';
import { attachScreenHost, detachScreenHost, setScreenHostShown } from './tvScreenLayer';
import type { TvScreenHandle } from './devices';

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
  /** The browser refused playVideo() without a gesture: the bar shows TAP TO PLAY. */
  private blocked = false;
  private readonly readyTimer: number;

  /** No `autoplay`: the controller starts the player when the record says,
   *  on its first tick after the player is ready — and only after it has
   *  applied the set's volume. With autoplay the iframe sounded at the
   *  player's own level for the tick before that, a set at volume 0
   *  included; and a countdown or a paused set must not sound at all. */
  constructor(
    host: HTMLElement, videoId: string, yt: YtNamespace, onFail: (why: string) => void,
    private onBlocked: () => void = () => undefined, private onUnblocked: () => void = () => undefined,
  ) {
    const mount = document.createElement('div');
    host.appendChild(mount);
    const playerVars: Record<string, unknown> = {
      autoplay: 0, playsinline: 1, rel: 0, enablejsapi: 1, modestbranding: 1,
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
        onStateChange: (e: { data: number }) => {
          this.state = e.data;
          if (e.data === 1) this.unblock();
        },
        onError: (e: { data: number }) => onFail(`YouTube player error ${e.data}`),
        // The browser held back the controller's playVideo() for want of a
        // gesture (a viewer who walked into a room already playing): the
        // frame takes no pointer and is in no Tab order, so the bar's TAP
        // TO PLAY is the gesture, and its press calls playVideo again.
        onAutoplayBlocked: () => {
          if (this.blocked) return;
          this.blocked = true;
          this.onBlocked();
        },
      },
    });
  }
  private unblock(): void {
    if (!this.blocked) return;
    this.blocked = false;
    this.onUnblocked();
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

  constructor(
    host: HTMLElement, url: string, onFail: (why: string) => void,
    private onBlocked: () => void, private onUnblocked: () => void = () => undefined,
    /** CORS mode: the node's blob route answers only an allowed Origin
     *  (blobLane.ts), and only an untainted video can be the set's texture. */
    crossOrigin = false,
  ) {
    const v = document.createElement('video');
    if (crossOrigin) v.crossOrigin = 'anonymous';
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
    // Sound got through after all (a tap anywhere on the page, the next
    // play()): the TAP TO PLAY notice has nothing left to say.
    v.addEventListener('playing', () => this.unblock());
    host.appendChild(v);
    this.video = v;
  }
  isReady(): boolean { return this.video.readyState >= 1; }
  isPlaying(): boolean { return !this.video.paused && !this.video.ended; }
  isEnded(): boolean { return this.video.ended; }
  private unblock(): void {
    if (!this.blocked) return;
    this.blocked = false;
    this.onUnblocked();
  }
  play(): void {
    const p = this.video.play();
    if (p && typeof p.catch === 'function') {
      p.then(() => this.unblock()).catch((err: unknown) => {
        // Only a refusal for want of a gesture is "blocked". A play() the
        // controller itself interrupted — a pause() while the element was
        // still buffering — rejects with AbortError, and that is no
        // refusal: TAP TO PLAY over a programme deliberately paused would
        // be wrong, and would stay over the picture after the next play.
        if ((err as { name?: unknown } | null)?.name !== 'NotAllowedError') return;
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
    f.title = 'archive.org player'; // the frame's accessible name in the theatre's focus order
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
  /** Where the mounted adapter puts its element: a new one per mount, laid
   *  on the set (an iframe, tvScreenLayer) or parked out of sight (a
   *  <video>, whose frames the set's screen takes). */
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
  /** The set's screen the picture is on while one is mounted. */
  shownOn: TvScreenHandle | null;
  /** The bar's keys (barKeys), removed on close. */
  onKey: (e: KeyboardEvent) => void;
  /** The mount key whose URL the redirect probe (tvConsent probeRedirect)
   *  is out for, '' when none: one probe per programme, and its answer is
   *  read from tvConsent on the tick after it lands. */
  probing: string;
  /** The probe in flight, to abort when its programme is superseded or the
   *  theatre closes: a superseded probe must not run on to its deadline. */
  probeAbort: AbortController | null;
  /** The mount key whose probe spent a unit of the set's mount budget: its
   *  mount, when the verdict allows one, is not counted a second time. */
  budgetedKey: string;
}

let theatre: Theatre | null = null;

export interface TheatreDeps {
  /** A display name for the TV item ("WALL TV", "TV ON THE STAND"). */
  label?: string;
  /** Measured round trip, for the half-transit lead on samples. */
  rttMs?: () => number;
}

/** Where the deps come from when a caller names none: main.ts installs one
 *  builder (the label from the furniture kind, the round trip from the
 *  network provider), so the set's panel, the phone's WATCH and the HUD
 *  chip open the same theatre — one entry point must not run without the
 *  lead the others apply. */
let depsProvider: (itemId: string) => TheatreDeps = () => ({});
export function setTvTheatreDeps(provider: (itemId: string) => TheatreDeps): void {
  depsProvider = provider;
}

/** The set's in-world screen, by item id: World installs one lookup (its
 *  furniture handles), and the picture goes there. */
let screenProvider: (itemId: string) => TvScreenHandle | undefined = () => undefined;
export function setTvScreenProvider(provider: (itemId: string) => TvScreenHandle | undefined): void {
  screenProvider = provider;
}

/** Out of sight, for a <video> whose frames are on the set: kept in the
 *  document so every browser keeps decoding it. */
let parking: HTMLDivElement | null = null;
function parkingLot(): HTMLDivElement {
  if (!parking || !parking.isConnected) {
    parking = document.createElement('div');
    parking.id = 'tv-picture-parking';
    parking.setAttribute('aria-hidden', 'true');
    parking.style.cssText = 'position:fixed; left:0; top:0; width:2px; height:2px; overflow:hidden; opacity:0; pointer-events:none;';
    document.body.appendChild(parking);
  }
  return parking;
}

export function isTvTheatreOpen(itemId?: string): boolean {
  return theatre !== null && (itemId === undefined || theatre.itemId === itemId);
}

export function tvTheatreItemId(): string | null {
  return theatre?.itemId ?? null;
}

export function openTvTheatre(itemId: string, deps: TheatreDeps = depsProvider(itemId)): void {
  // The phone's WATCH slides the phone away without blurring the button:
  // a control left focused offscreen would take the next Space (WATCH
  // again) or, a field, the world's keys. Only a phone already put away:
  // an automatic open never takes focus from a phone in use.
  const phone = document.getElementById('spacephone-container');
  const focused = document.activeElement;
  if (phone && !phone.classList.contains('active') && focused instanceof HTMLElement && phone.contains(focused)) focused.blur();
  if (theatre && theatre.itemId !== itemId) closeTvTheatre();
  if (theatre) return;
  dismissed.delete(itemId); // a WATCH is this viewer asking again
  // The bar: the set's name and programme, the notices (a consent ask,
  // FETCH, TAP TO PLAY), where the room is and the controls. Not a dialog
  // and not modal: the world goes on around it, keys and clicks included.
  const root = document.createElement('div');
  root.id = 'tv-theatre';
  root.setAttribute('role', 'region');
  root.setAttribute('aria-label', 'Television (T: to the controls, Escape: back to the world)');
  // A key typed on the bar is the bar's, past the helm's flight stick too
  // (freeFlightStick): Space on a focused button presses it rather than
  // braking the ship. barKeys keeps such keys from input.ts.
  root.dataset.stickAside = '1';
  root.innerHTML = `
    <div class="tv-theatre-panel">
      <div class="tv-theatre-head"></div>
      <div class="tv-theatre-notice" hidden></div>
      <div class="tv-theatre-status"></div>
      <div class="tv-theatre-controls"></div>
    </div>`;
  // Clicks on the bar stay on it: the world's click handler listens on
  // window and would walk the player or wake a device behind it.
  root.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(root);
  const onKey = (e: KeyboardEvent) => barKeys(root, e, () => (theatre?.root === root ? embedControls(theatre) : []));
  window.addEventListener('keydown', onKey, true);
  theatre = {
    root,
    itemId,
    label: deps.label ?? 'TV',
    screen: document.createElement('div'),
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
    shownOn: null,
    onKey,
    playerFor: -1,
    probing: '',
    probeAbort: null,
    budgetedKey: '',
  };
  const rtt = deps.rttMs ?? (() => 0);
  theatre.timer = window.setInterval(() => theatreTick(rtt), 400);
  theatreTick(rtt);
  updateTvChip([itemId]);
}

/** The bar's keyboard, without making it modal (capture phase on window,
 *  ahead of the world's own listeners). T, from the world, puts focus on
 *  the bar's first control: a consent ask, FETCH or TAP TO PLAY is reached
 *  without a pointer. With focus on the bar, every key stays on it, so the
 *  world's shortcuts (Tab's phone, Enter's quick chat, WASD) neither fire
 *  nor eat a button's own Enter or Space; Tab and Shift+Tab move along the
 *  bar, and Escape hands the keys back to the world. Keyups are never held,
 *  so a key held as focus moved is still released to the world. */
function barKeys(root: HTMLElement, e: KeyboardEvent, extra: () => HTMLElement[] = () => []): void {
  const target = e.target instanceof Node ? e.target : null;
  if (target && root.contains(target)) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      (document.activeElement as HTMLElement | null)?.blur?.();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const focusable = [...theatreFocusable(root), ...extra()];
      if (focusable.length === 0) return;
      const at = focusable.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey
        ? focusable[(at <= 0 ? focusable.length : at) - 1]!
        : focusable[(at + 1) % focusable.length]!;
      next.focus();
    }
    return;
  }
  // T for TV, from the world only: never while typing, with a modifier, or
  // with the phone open (its fields and its own keys).
  if (e.key !== 't' && e.key !== 'T') return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = target instanceof HTMLElement ? target : null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (document.getElementById('spacephone-container')?.classList.contains('active')) return;
  const first = theatreFocusable(root)[0];
  if (!first) return;
  e.preventDefault();
  e.stopPropagation();
  first.focus();
}

/** archive.org's own player, laid on the set: its volume and its controls
 *  are inside its frame (the adapter has no API), so the frame takes the
 *  pointer and comes last in the bar's Tab order. Nothing for other sources. */
function embedControls(t: Theatre): HTMLElement[] {
  return t.player instanceof ArchiveEmbedAdapter ? [...t.screen.querySelectorAll<HTMLElement>('iframe')] : [];
}

/** The bar's controls in order: its buttons and the volume slider. */
function theatreFocusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')];
}

/** The programme this viewer turned off with ✕ (the set, the record's
 *  `started`, and the room's doc it was in — another room may reuse the item
 *  id and the counter): the room tick does not turn it back on by itself. */
const dismissed = new Map<string, { started: number; epoch: number }>();

function isDismissed(itemId: string, started: number): boolean {
  const d = dismissed.get(itemId);
  return d !== undefined && d.started === started && d.epoch === tvDocEpoch();
}

/** Take the picture off the set and the bar down. `byViewer`: the ✕ on the
 *  bar, which keeps this programme off until the next one or a WATCH. */
export function closeTvTheatre(byViewer = false): void {
  if (!theatre) return;
  const t = theatre;
  theatre = null;
  if (byViewer) dismissed.set(t.itemId, { started: readTv(t.itemId).started, epoch: tvDocEpoch() });
  window.clearInterval(t.timer);
  window.removeEventListener('keydown', t.onKey, true);
  const hadFocus = t.root.contains(document.activeElement);
  unmountPlayer(t);
  t.root.remove();
  if (hadFocus) (document.activeElement as HTMLElement | null)?.blur?.();
}

function unmountPlayer(t: Theatre): void {
  t.attempt += 1; // whatever is still being built for the old mount is void
  t.probeAbort?.abort(); // a probe out for the old programme is not waited for
  t.probeAbort = null;
  t.probing = '';
  t.unregister?.();
  t.unregister = null;
  t.controller = null;
  t.player?.destroy();
  t.player = null;
  t.mounted = '';
  // The picture comes off the set, and the host it was in goes.
  t.shownOn?.showVideo(null);
  t.shownOn = null;
  detachScreenHost();
  t.screen.remove();
  t.screen = document.createElement('div');
}

/** What a mounted adapter is keyed by. A start-only embed can neither seek
 *  nor replay, so a new programme START of the same source (PLAY NOW again,
 *  PREVIOUSLY ON) is a new key and gets a fresh iframe; seekable players
 *  follow a replay through the controller instead. */
function mountKey(source: TvSource, started: number): string {
  // A blob is read from this viewer's node: a node that restarted (a new
  // token) or moved port is another mount, so the player is rebuilt on the
  // new URL and a failure on the old node does not stick.
  if (source.kind === 'blob') return `${sourceId(source)}@${blobNodeTag()}`;
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
    // A file the node said it held but could not serve may have been let
    // go since: RETRY asks the node again, and offers FETCH if it is gone.
    if (source.kind === 'blob') recheckBlob(source.hash);
    showNotice(t, `<div>${escapeHtml(why)}</div>
      <div class="tv-theatre-lane">${escapeHtml(sourceLane(source))} LANE — nothing else in the room depends on it</div>
      <button type="button" data-tv-retry="1">RETRY</button>`);
    t.notice.querySelector<HTMLButtonElement>('[data-tv-retry]')?.addEventListener('click', () => {
      t.mounted = '';
    });
  };
  // Where the picture goes: an embed's frame is laid on the set's screen
  // (tvScreenLayer); a <video> is parked out of sight and its frames put on
  // the screen once it is adopted.
  const set = screenProvider(t.itemId) ?? null;
  const textured = asTexture(source);
  if (set && !textured) attachScreenHost(t.screen, set.plane, set.planeW, set.planeH, source.kind === 'archive' && !sourceFileUrl(source));
  else parkingLot().appendChild(t.screen);
  const adopt = (player: Adapter) => {
    if (!live()) {
      player.destroy();
      return;
    }
    hideNotice(t);
    t.player = player;
    if (player instanceof HtmlVideoPlayerAdapter && textured && set) {
      set.showVideo(player.video);
      t.shownOn = set;
    }
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
  // TAP TO PLAY: the browser refused to start the player without a gesture
  // (a <video>'s play() rejected, YouTube's onAutoplayBlocked); the press is
  // the gesture, and it asks the player again.
  const blocked = () => {
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
  };
  const unblocked = () => {
    // The browser let the sound through after all: the notice comes down.
    if (live() && !t.notice.hidden && t.notice.querySelector('[data-tv-tap]')) hideNotice(t);
  };
  if (source.kind === 'youtube') {
    showNotice(t, `<div>REACHING YOUTUBE…</div><div class="tv-theatre-lane">CONVENIENCE LANE</div>`);
    loadYouTubeApi().then(
      (yt) => {
        // The programme moved on (or the theatre closed) while the API
        // loaded: build no iframe for it — adopt() would destroy one, but
        // the constructor had already inserted it and started its load.
        if (!live()) return;
        adopt(new YouTubePlayerAdapter(t.screen, source.videoId, yt, fail, blocked, unblocked));
      },
      (err: Error) => fail(err.message || 'YouTube is unreachable'),
    );
    return;
  }
  const url = source.kind === 'blob' ? blobUrl(source.hash) : sourceFileUrl(source);
  if (url) {
    adopt(new HtmlVideoPlayerAdapter(t.screen, url, fail, blocked, unblocked, textured));
    return;
  }
  if (source.kind === 'archive') {
    adopt(new ArchiveEmbedAdapter(t.screen, source.identifier));
    return;
  }
  fail('The TV cannot play this.');
}

/** Whether `source` plays as a <video> the set's screen can take as a
 *  texture: one fetched in CORS mode from a host known to answer it — a blob
 *  from the node, a link on this page's own origin, or a link on another host
 *  whose CORS check (tvConsent probeRedirect) came through before it was
 *  mounted. Anything else — an embed, archive.org's files, a link on the
 *  node's media origin — is laid on the set in the DOM instead (a CORS-less
 *  video would taint the texture and show nothing). */
function asTexture(source: TvSource): boolean {
  if (source.kind === 'blob') return true;
  if (source.kind !== 'url') return false;
  let sameOrigin = false;
  try { sameOrigin = new URL(source.url, location.href).origin === location.origin; } catch { /* not a URL */ }
  return sameOrigin || needsRedirectProbe(source);
}

function theatreTick(rtt: () => number): void {
  const t = theatre;
  if (!t) return;
  const rec = readTv(t.itemId);
  const on = rec.state !== 'off' && rec.state !== 'home' && rec.source !== null;
  if (!on) {
    // Nothing on (the set off, or its home screen): no picture to show, and
    // the set itself says so. The bar goes; the next programme opens it again.
    closeTvTheatre();
    return;
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
    // A blob plays from this viewer's own node, and only while the page
    // trusts the node's origin (blobLane.ts): the same lapse as a URL on it.
    const consent = rec.source!.kind === 'blob' ? (blobLaneReady() ? 'ok' : 'refuse') : mediaConsent(rec.source!);
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
    if (consent !== 'ok' && rec.source!.kind === 'blob') {
      showBlobNotice(t, rec.source!, null);
    } else if (consent !== 'ok') {
      showConsentNotice(t, rec.source!, consent);
    } else if (rec.source!.kind === 'blob' && t.mounted !== key && t.mounted !== `failed:${key}`) {
      // The file is played once this viewer's node holds all of it; until
      // then the notice says where it is, and FETCH is the viewer's press.
      // No mount budget: the bytes are already on this machine, and the
      // transfer that put them there was asked for by a press.
      const st = blobState(rec.source!.hash);
      if (st.state === 'complete') mountPlayer(t, rec.source!, key, rtt);
      else showBlobNotice(t, rec.source!, st);
    } else if (t.mounted !== key && t.mounted !== `failed:${key}`) {
      // A URL on a host the viewer accepted is asked about before anything
      // fetches it (tvConsent needsRedirectProbe / probeRedirect): a CORS
      // HEAD that follows no redirect. A direct answer mounts; a redirect
      // does not (the <video> would follow it blind, into the viewer's own
      // network for all this page can tell); no answer — a host without
      // CORS, or down — does not either: what could not be asked authorises
      // nothing, and RETRY asks again. One probe per programme. The viewer's
      // own origins, the node and the product lanes are not probed.
      const url = rec.source!.kind === 'url' ? rec.source!.url : '';
      const verdict = url && needsRedirectProbe(rec.source!) ? redirectVerdict(url) : 'direct';
      // Consent per origin bounds nothing cumulative: a modified client
      // could rotate shape-valid sources on this viewer's own node — or
      // query strings on an accepted host — and have every open theatre
      // fetch each in turn without end. So every request this theatre makes
      // on its own, a probe as much as a mount, is counted per set and
      // across every set this viewer is shown — the theatre opens by itself
      // on a set that comes on, so a new set is no new budget (tvConsent
      // mayMountNow); a probe's unit covers the mount its
      // verdict allows (budgetedKey), and past the budget what is on is
      // shown with PLAY — the press is the consent that spends the next.
      if (verdict === null) {
        if (t.probing !== key) {
          if (mayMountNow(t.itemId, tvNow())) {
            t.budgetedKey = key;
            startRedirectProbe(t, url, key);
          } else {
            showMountNotice(t, rec.source!, key);
          }
        }
      } else if (verdict === 'redirects') {
        showRedirectNotice(t, rec.source!, key);
      } else if (t.budgetedKey === key || mayMountNow(t.itemId, tvNow())) {
        t.budgetedKey = '';
        mountPlayer(t, rec.source!, key, rtt);
      } else {
        showMountNotice(t, rec.source!, key);
      }
    }
  }
  // A picture laid on the set in the DOM shows only while the programme
  // plays or pauses, as the set's own video plane does (furniture.ts): a
  // countdown stays the set's card.
  const pbNow = readPlayback(t.itemId).state;
  setScreenHostShown(pbNow === 'playing' || pbNow === 'paused');
  t.controller?.tick();
  renderTheatreChrome(t);
}

/** CHECKING THE LINK… — the probe is out for this programme's URL; the tick
 *  after it lands reads the kept verdict from tvConsent and mounts, or shows
 *  why not. No answer keeps no verdict: that is said here, with RETRY, so
 *  the next tick does not ask again on its own. A probe that comes back for
 *  an earlier programme, or after the theatre closed, changes nothing here;
 *  a kept verdict is kept per URL all the same. */
function startRedirectProbe(t: Theatre, url: string, key: string): void {
  t.probeAbort?.abort(); // a probe still out for an earlier programme
  const abort = new AbortController();
  t.probeAbort = abort;
  t.probing = key;
  let host = url;
  try { host = new URL(url).host; } catch { /* shown as it is */ }
  showNotice(t, `<div>CHECKING THE LINK</div>
    <div class="tv-theatre-lane">asking ${escapeHtml(host)} whether it answers this link itself or sends your browser elsewhere</div>`);
  void probeRedirect(url, undefined, undefined, abort.signal).then((verdict) => {
    if (theatre !== t || t.probing !== key || t.probeAbort !== abort) return;
    t.probeAbort = null;
    t.probing = '';
    if (verdict !== 'unknown') return; // the next tick reads the kept verdict
    t.mounted = `failed:${key}`;
    showNotice(t, `<div>NOT PLAYED HERE</div>
      <div class="tv-theatre-lane">${escapeHtml(host)} did not answer a cross-origin check — no CORS headers, or not reachable — and a link that cannot be asked about is not fetched; a CORS-enabled host, your own origin or this station's node plays here</div>
      <button type="button" data-tv-retry="1">RETRY</button>`);
    t.notice.querySelector<HTMLButtonElement>('[data-tv-retry]')?.addEventListener('click', () => {
      t.mounted = '';
    });
  }, () => {
    if (theatre === t && t.probing === key && t.probeAbort === abort) {
      t.probeAbort = null;
      t.probing = '';
    }
  });
}

/** Why this viewer's node turned the last FETCH down, for the file it was
 *  for (the node's own words: not connected to the holder, no quota). */
let blobAskRefused: { hash: string; why: string } | null = null;

/** 📦 A blob this viewer's node does not hold whole yet: where it is, and
 *  FETCH — the press that asks the viewer's own node to take it from the
 *  node that put it on (blobLane.ts). `st` null: no node to ask. */
function showBlobNotice(t: Theatre, source: Extract<TvSource, { kind: 'blob' }>, st: BlobState | null): void {
  const size = formatBytes(source.size);
  const from = `${source.provider.slice(0, 8)}…`;
  if (st === null) {
    showNotice(t, `<div>📦 ${escapeHtml(sourceLabel(source))} · ${escapeHtml(size)}</div>
      <div class="tv-theatre-lane">SOVEREIGN LANE — a file from a room member's node, played from yours: it needs this station's node (the desktop app) running here</div>`);
    return;
  }
  if (st.state === 'unknown') {
    showNotice(t, '<div>ASKING YOUR NODE…</div><div class="tv-theatre-lane">whether it holds this file yet</div>');
    return;
  }
  if (st.state === 'importing') {
    showNotice(t, '<div>YOUR NODE IS STILL TAKING THE FILE</div><div class="tv-theatre-lane">it plays once it is all in</div>');
    return;
  }
  if (st.state === 'queued' || st.state === 'fetching') {
    const pct = st.size > 0 ? Math.min(100, Math.floor((st.have / st.size) * 100)) : 0;
    showNotice(t, `<div>📦 FETCHING · ${pct}%</div>
      <div class="tv-theatre-lane">${escapeHtml(formatBytes(st.have))} of ${escapeHtml(size)} from ${escapeHtml(from)}, every byte checked against the file's hash — it plays when the last one is in</div>`);
    return;
  }
  // 'none' or 'failed': the button. Its words are constant per programme,
  // so the same ask every tick keeps the button under the finger. Which
  // nodes here kept a copy is asked meanwhile: FETCH names them beside the
  // provider, so it works after the one who shared the file has left.
  void refreshHolders([source.hash]);
  const why = st.state === 'failed' ? st.why || 'no reason given' : blobAskRefused?.hash === source.hash ? blobAskRefused.why : '';
  const failed = why ? `<div class="tv-theatre-lane">the last try stopped: ${escapeHtml(why)}</div>` : '';
  const html = `<div>📦 ${escapeHtml(sourceLabel(source))} · ${escapeHtml(size)}</div>
    <div class="tv-theatre-lane">SOVEREIGN LANE — your node takes it from ${escapeHtml(from)}'s node over the room, never from a server; ${escapeHtml(size)} of your disk, kept until your node needs the room (the files used longest ago go first). Nothing is fetched until you press</div>
    ${failed}
    <button type="button" data-tv-fetch="${escapeHtml(source.hash)}" data-tv-fetch-size="${source.size}" data-tv-fetch-from="${escapeHtml(source.provider)}">📦 FETCH ${escapeHtml(size)}</button>`;
  if (!t.notice.hidden && t.lastNotice === html) return;
  showNotice(t, html);
  t.notice.querySelector<HTMLButtonElement>('[data-tv-fetch]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    // The press is for THE TRANSFER THE BUTTON SHOWED — this file, this
    // size, from this node: a peer may have changed any of them between the
    // render and the click, and the press consents to none of the changes.
    const now = readTv(t.itemId).source;
    if (!now || now.kind !== 'blob' || now.hash !== btn.dataset.tvFetch
      || String(now.size) !== btn.dataset.tvFetchSize || now.provider !== btn.dataset.tvFetchFrom) return;
    btn.disabled = true;
    void fetchBlob(now.hash, now.size, now.provider, now.mime ?? '').then((refused) => {
      // Kept for the notice the next tick draws (a button again, with why).
      blobAskRefused = refused ? { hash: now.hash, why: refused } : null;
      if (refused) btn.disabled = false;
    });
  });
}

/** NOT PLAYED HERE — the host answered the link with a redirect. Where to,
 *  the browser does not say and this page cannot know; so the link is not
 *  mounted, whoever pasted it. */
function showRedirectNotice(t: Theatre, source: TvSource, key: string): void {
  t.mounted = `failed:${key}`; // nothing to retry: the same URL answers the same way
  let host = source.kind === 'url' ? source.url : '';
  try { host = new URL(host).host; } catch { /* shown as it is */ }
  showNotice(t, `<div>NOT PLAYED HERE</div>
    <div class="tv-theatre-lane">${escapeHtml(host || 'this host')} answers this link with a redirect, and your browser would follow it without saying where — paste the link it redirects to instead</div>`);
}

/** PLAY? — the automatic mounts for the minute are spent, the set's or the
 *  viewer's (tvConsent mayMountNow): what is on is shown, and the press
 *  mounts it. */
function showMountNotice(t: Theatre, source: TvSource, key: string): void {
  // The button under the finger stays — the same ask every tick is one ask —
  // but only for the SAME programme: the next source gets its own.
  const asking = t.notice.hidden ? null : t.notice.querySelector<HTMLButtonElement>('[data-tv-mount]');
  if (asking && asking.dataset.tvMount === key) return;
  showNotice(t, `<div>▶ PLAY ${escapeHtml(sourceLabel(source))}?</div>
    <div class="tv-theatre-lane">the TVs here changed programme more than ${TV_MOUNT_BUDGET} times in a minute — your browser fetches no more on its own until you say so; whoever holds the remote cannot decide that for you</div>
    <button type="button" data-tv-mount="${escapeHtml(key)}">▶ PLAY</button>`);
  t.notice.querySelector<HTMLButtonElement>('[data-tv-mount]')?.addEventListener('click', () => {
    // The press is consent for THE PROGRAMME THE BUTTON NAMED: a peer may
    // have changed it between the render and the click, and the budget must
    // not be opened for whatever is on now. The notice comes down either
    // way; the next tick asks again for what is on.
    const now = readTv(t.itemId);
    const current = now.source ? mountKey(now.source, now.started) : '';
    if (current === key) allowMount(t.itemId);
    hideNotice(t);
  });
}

/** PLAY FROM <host>? — or NOT PLAYED HERE for a host inside a private
 *  network, which no button can override. */
function showConsentNotice(t: Theatre, source: TvSource, consent: 'ask' | 'refuse'): void {
  const origin = mediaOrigin(source) ?? '';
  let host = origin;
  try { host = new URL(origin).host; } catch { /* shown as it is */ }
  if (consent === 'refuse') {
    // Why, in the words of the gate: a lane this build does not offer, a
    // link on another server in a serverless-only build, or a private host
    // (sovereignty.ts, tvConsent.ts).
    const why = consentRefusal(source);
    if (why === 'lane-off') {
      showNotice(t, `<div>NOT IN THIS BUILD</div>
      <div class="tv-theatre-lane">the ${escapeHtml(sourceLane(source))} lane is off — ${escapeHtml(SERVERLESS_ONLY)}: a file on your own origin or this station's node, and the lanes to come</div>`);
    } else if (why === 'server-off') {
      showNotice(t, `<div>NOT IN THIS BUILD</div>
      <div class="tv-theatre-lane">${escapeHtml(host || 'this link')} is another server — ${escapeHtml(SERVERLESS_ONLY)}: a link on your own origin or this station's node plays here</div>`);
    } else if (why === 'node-stale') {
      // The node's origin, but the node has not answered a fingerprint probe
      // within its trust lifetime (tvConsent TV_NODE_TRUST_MS): whatever is
      // on that port now is not known to be the node. The next probe that
      // the node answers renews the trust and the theatre mounts on its own.
      showNotice(t, `<div>WAITING FOR THE NODE</div>
      <div class="tv-theatre-lane">${escapeHtml(host || 'this link')} is this station's node, but it has not answered lately — the picture returns when it does</div>`);
    } else {
      showNotice(t, `<div>NOT PLAYED HERE</div>
      <div class="tv-theatre-lane">${escapeHtml(host || 'this link')} is inside a private network — nobody in the room can ask your browser to fetch from there</div>`);
    }
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
    <button type="button" class="tv-theatre-close" data-tv-close="1" aria-label="Turn the picture off" title="Turn the picture off (WATCH brings it back)">✕</button>`;
  if (head !== t.lastHead) {
    t.head.innerHTML = head;
    t.lastHead = head;
    t.head.querySelector<HTMLButtonElement>('[data-tv-close]')?.addEventListener('click', () => closeTvTheatre(true));
  }
  const startOnly = rec.source ? isStartOnly(rec.source) : false;
  // A mounted player that cannot seek (a live stream, a host without usable
  // ranges) is start-only too, whatever the source kind promised.
  const seekable = !startOnly && (t.player ? t.player.canSeek : true);
  const sync = startOnly || !seekable ? ' · start-time sync only' : '';
  // Plain text, set with textContent below: the raw shape-checked name, never
  // an escaped one (an escaped `&` would show as `&amp;`).
  const who = held ? `REMOTE · ${remote.name || 'a clone'}` : 'REMOTE ON THE SET';
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
      : '<label class="tv-theatre-volume">🔊 <input type="range" min="0" max="100" data-tv-volume="1" aria-label="Set volume"></label>',
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
    // RELOAD takes the old embed down first (unmountPlayer clears the key):
    // clearing the key alone left the iframe and its controller alive
    // behind the PLAY notice when the replacement had to wait for the
    // mount budget, the old film still playing.
    c.querySelector<HTMLButtonElement>('[data-tv-reload]')?.addEventListener('click', () => { unmountPlayer(t); });
  }
  // The slider's level is a property, not part of the row's HTML: a peer's
  // VOLUME press on the set moves the knob without rebuilding the row under
  // a pointer mid-drag, and a slider the player is on keeps its own reading
  // until its change lands.
  const slider = t.controls.querySelector<HTMLInputElement>('[data-tv-volume]');
  if (slider && document.activeElement !== slider) {
    const level = String(rec.volume);
    if (slider.value !== level) slider.value = level;
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

/** Driven at ~2 Hz by World with the room's TV ids: opens the theatre on a
 *  set that has something on, or, when this viewer turned it off, shows a
 *  WATCH chip while the theatre is closed. */
export function updateTvChip(itemIds: readonly string[]): void {
  let label = '';
  let target = '';
  if (!theatre) {
    // A set in the room with something on shows it: the theatre opens by
    // itself on the first such set, putting the picture on it, unless this
    // viewer turned that set's programme off (✕) — a dismissal per set,
    // gone with the programme or a WATCH. Otherwise the chip offers WATCH.
    for (const id of itemIds) {
      const rec = readTv(id);
      if (!rec.source || rec.state === 'off' || rec.state === 'home') continue;
      if (chipOpen && !isDismissed(id, rec.started)) {
        chipOpen(id);
        if (theatre) return;
      }
      if (target) continue;
      const pb = readPlayback(id);
      const what = sourceLabel(rec.source).toUpperCase();
      label = pb.state === 'scheduled'
        ? `📺 ${what} · ${countdownText(pb.countdownMs)} · WATCH`
        : pb.state === 'paused' ? `📺 ${what} · PAUSED · WATCH` : `📺 NOW ON: ${what} · WATCH`;
      target = id;
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
