/**
 * 📺 tvTheatre — the DOM half of the TV: the player adapters (the YouTube
 * IFrame API, an HTML <video>, the archive.org embed) and the THEATRE, which
 * plays what the set is showing ON THE SET, in sync with everyone else
 * (tvSync.ts drives the adapter from the room record). No bar and no popup
 * (#258): the controls are the SpacePhone's 📡 IR BLASTER (tvUI.ts), and
 * what the set has to ask this viewer — a link to allow, a file to fetch, a
 * tap for sound — is its notice, which the blaster shows when aimed at the
 * set (tvTheatreNotice), while the set's own screen says where to look
 * (tvTheatreHint).
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
 * tick, updateTvPicture), and the picture stays on the set while it plays
 * (#258: nothing turns it off; the set itself shows its menu only when
 * stopped or paused). Aiming the blaster at another set that is on moves
 * the picture there: one set's picture at a time per page.
 *
 * Sovereignty (plan §3.3): YouTube and archive.org are CONVENIENCE lanes.
 * They are labelled as such on the blaster, an unreachable one says so and
 * offers a retry, and nothing else in the room depends on them.
 */

import { lapRemountIsFree, replayNeedsRemount, TvSyncController } from './tvSync';
import type { SeekableRange, TvPlayer } from './tvSync';
import {
  countdownText, isStartOnly, readPlayback, readTv, sourceFileUrl, sourceId, sourceLabel, sourceLane, tvDocEpoch, tvNow,
} from './tvDoc';
import type { TvSource } from './tvDoc';
import { registerTvPlayerOfRecord } from './tvSession';
import {
  acceptMediaOrigin, allowMount, consentRefusal, mayMountNow, mediaConsent, mediaOrigin, needsRedirectProbe, probeRedirect,
  redirectVerdict, TV_MOUNT_BUDGET,
} from './tvConsent';
import { SERVERLESS_ONLY } from './sovereignty';
import {
  blobLaneReady, blobNodeTag, blobState, blobUrl, fetchBlob, formatBytes, freshNodeHolders, recheckBlob, refreshHolders,
} from './blobLane';
import type { BlobState } from './blobLane';
import { escapeHtml } from './htmlEscape';
import { attachScreenHost, detachScreenHost, setScreenHostShown } from './tvScreenLayer';
import type { TvScreenHandle } from './devices';
import {
  autoFetchVerdict, noteAutoFetch, notePressedFetch, TV_AUTO_FETCH_DAY, TV_AUTO_FETCH_MAX, TV_AUTO_FETCH_MIN_CHARGE,
} from './tvAutoFetch';

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
 *  internet, a blocked host) so the blaster can say so instead of hanging. */
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
  /** The browser refused playVideo() without a gesture: the blaster shows TAP TO PLAY. */
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
        // frame takes no pointer and is in no Tab order, so the blaster's
        // TAP TO PLAY is the gesture, and its press calls playVideo again. Said
        // on every refusal, the one after a press included (the press took
        // the notice down); a notice already up stays as it is.
        onAutoplayBlocked: () => {
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
  /** The browser refused play() without a gesture: the blaster shows TAP TO PLAY. */
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
  itemId: string;
  /** Where the mounted adapter puts its element: a new one per mount, laid
   *  on the set (an iframe, tvScreenLayer) or parked out of sight (a
   *  <video>, whose frames the set's screen takes). */
  screen: HTMLDivElement;
  /** What the set asks of this viewer, in the blaster's words and buttons
   *  (tvTheatreNotice): kept out of the document until the blaster, aimed
   *  at this set, takes it in. Its `hidden` is set when there is nothing. */
  notice: HTMLDivElement;
  /** The same, in the few words the set's own screen shows
   *  (tvTheatreHint); '' with nothing to ask. */
  hint: string;
  player: Adapter | null;
  controller: TvSyncController | null;
  /** The programme (the record's `started`) the mounted player is for, as
   *  of this theatre's last tick: tvSession files the player's end under
   *  that programme alone, so a room tick between a source change and the
   *  remount cannot put the old player's length on the new programme. */
  playerFor: number;
  /** The programme (`started`) the adapter was BUILT for: a seekable player
   *  follows a replay and keeps this, one that cannot seek is rebuilt
   *  (tvSync replayNeedsRemount). */
  mountedFor: number;
  /** When the adapter was built (tvNow): a LOOP lap's rebuild of a player
   *  that ran for at least TV_LAP_REMOUNT_MIN_MS is not counted (tvSync). */
  mountedAt: number;
  /** The mount key of what the adapter was built for ('' = nothing mounted):
   *  the sourceId, plus the programme's `started` for a start-only embed. */
  mounted: string;
  /** Bumped on every unmount: an adapter still being built (the YouTube API
   *  loading) for an earlier attempt is thrown away when it arrives. */
  attempt: number;
  timer: number;
  unregister: (() => void) | null;
  lastNotice: string;
  /** The set's screen the picture is on while one is mounted. */
  shownOn: TvScreenHandle | null;
  /** T, from the world: the blaster on this set (tKey), removed on close. */
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
  /** Measured round trip, for the half-transit lead on samples. */
  rttMs?: () => number;
}

/** Where the deps come from when a caller names none: main.ts installs one
 *  builder (the round trip from the network provider), so the room tick and
 *  the blaster open the same theatre — one entry point must not run without
 *  the lead the others apply. */
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
  // A phone put away leaves no control focused offscreen: it would take the
  // next Space or, a field, the world's keys. Only a phone already put
  // away: an automatic open never takes focus from a phone in use.
  const phone = document.getElementById('spacephone-container');
  const focused = document.activeElement;
  if (phone && !phone.classList.contains('active') && focused instanceof HTMLElement && phone.contains(focused)) focused.blur();
  if (theatre && theatre.itemId !== itemId) closeTvTheatre();
  if (theatre) return;
  // What the set asks of this viewer is drawn here and shown by the blaster
  // (tvTheatreNotice): no bar, no popup (#258).
  const notice = document.createElement('div');
  notice.className = 'tv-set-says';
  notice.hidden = true;
  // Clicks on it stay on it: the world's click handler listens on window.
  notice.addEventListener('click', (e) => e.stopPropagation());
  const onKey = (e: KeyboardEvent) => tKey(itemId, e);
  window.addEventListener('keydown', onKey, true);
  theatre = {
    itemId,
    screen: document.createElement('div'),
    notice,
    hint: '',
    player: null,
    controller: null,
    mounted: '',
    attempt: 0,
    timer: 0,
    unregister: null,
    lastNotice: '',
    shownOn: null,
    onKey,
    playerFor: -1,
    mountedFor: -1,
    mountedAt: 0,
    probing: '',
    probeAbort: null,
    budgetedKey: '',
  };
  const rtt = deps.rttMs ?? (() => 0);
  theatre.timer = window.setInterval(() => theatreTick(rtt), 400);
  theatreTick(rtt);
  noteTheatre();
}

/** How T opens the blaster on a set (main.ts: the phone on 📡 IR BLASTER,
 *  aimed at it). */
let remoteOpener: (itemId: string) => void = () => undefined;
export function setTvRemoteOpener(fn: (itemId: string) => void): void {
  remoteOpener = fn;
}

/** T for TV, from the world: the blaster, aimed at the set whose picture is
 *  up — its notice (a link to allow, FETCH, a tap for sound) is reached
 *  without a pointer. Never while typing, with a modifier, or with the
 *  phone open (its fields and its own keys). */
function tKey(itemId: string, e: KeyboardEvent): void {
  if (e.key !== 't' && e.key !== 'T') return;
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const el = e.target instanceof HTMLElement ? e.target : null;
  if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
  if (document.getElementById('spacephone-container')?.classList.contains('active')) return;
  e.preventDefault();
  e.stopPropagation();
  remoteOpener(itemId);
}

/** Whoever shows the theatre's notice (the blaster) hears when the theatre
 *  opens, closes or moves to another set, and when its notice changes. */
const theatreListeners = new Set<() => void>();
export function subscribeTvTheatre(fn: () => void): () => void {
  theatreListeners.add(fn);
  return () => { theatreListeners.delete(fn); };
}
function noteTheatre(): void {
  for (const fn of theatreListeners) fn();
}

/** The set's notice for this viewer, while the picture is on `itemId` and
 *  the set has something to ask: a live element, its buttons wired, kept
 *  current by the theatre's tick. The blaster puts it in its own view. */
export function tvTheatreNotice(itemId: string): HTMLDivElement | null {
  const t = theatre;
  return t && t.itemId === itemId && !t.notice.hidden ? t.notice : null;
}

/** What the set's own screen says about that notice: where to look, in a
 *  few words. '' with nothing to ask, or the picture on another set. */
export function tvTheatreHint(itemId: string): string {
  const t = theatre;
  return t && t.itemId === itemId && !t.notice.hidden ? t.hint : '';
}

/** ↻ RELOAD archive.org's player on `itemId` (a frame that never loaded
 *  gives no sign of it). The old embed comes down first: clearing the key
 *  alone left the iframe and its controller alive behind the PLAY notice
 *  when the replacement had to wait for the mount budget, the old film
 *  still playing. False when the picture is not on that set. */
export function reloadTvPicture(itemId: string): boolean {
  const t = theatre;
  if (!t || t.itemId !== itemId || !t.player) return false;
  unmountPlayer(t);
  return true;
}

/** 🎛 Into archive.org's player on `itemId`, for its volume and its other
 *  controls, which are only inside its frame: focus goes into the frame,
 *  and its own Tab order runs there. A frame from another origin keeps its
 *  keys, Escape included, so the way back is an edge on either side of it:
 *  Tab past its last control, or Shift+Tab past its first, lands on one,
 *  which calls `back` (the blaster puts focus on its key). False with no
 *  archive.org player up on that set. */
export function focusTvEmbed(itemId: string, back: () => void): boolean {
  const t = theatre;
  if (!t || t.itemId !== itemId || !(t.player instanceof ArchiveEmbedAdapter)) return false;
  const frame = t.screen.querySelector('iframe');
  if (!frame) return false;
  embedBack = back;
  // Made once per mount: the host, edges and all, goes with the player.
  if (!t.screen.querySelector('[data-tv-embed-edge]')) {
    for (const where of ['beforebegin', 'afterend'] as const) {
      const edge = document.createElement('span');
      edge.tabIndex = 0;
      edge.dataset.tvEmbedEdge = where;
      edge.setAttribute('aria-label', 'Back to the IR blaster');
      edge.style.cssText = 'position:absolute; width:1px; height:1px; overflow:hidden; opacity:0;';
      edge.addEventListener('focus', () => { embedBack?.(); });
      frame.insertAdjacentElement(where, edge);
    }
  }
  frame.focus();
  return true;
}
/** Where focus goes from an edge of archive.org's frame (focusTvEmbed). */
let embedBack: (() => void) | null = null;

/** Take the picture off the set: the programme is over, the blaster aimed
 *  at another set that is on, the set gone, or the room left. */
export function closeTvTheatre(): void {
  if (!theatre) return;
  const t = theatre;
  theatre = null;
  window.clearInterval(t.timer);
  window.removeEventListener('keydown', t.onKey, true);
  unmountPlayer(t);
  // Its notice leaves the blaster with it; the blaster's own view keeps the
  // focus a button in it had.
  const hadFocus = t.notice.contains(document.activeElement);
  const view = t.notice.closest<HTMLElement>('.phone-app-view');
  t.notice.remove();
  if (hadFocus) view?.focus({ preventScroll: true });
  noteTheatre();
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
export function mountKey(source: TvSource, started: number): string {
  // A blob is read from this viewer's node: a node that restarted (a new
  // token) or moved port is another mount, so the player is rebuilt on the
  // new URL and a failure on the old node does not stick. And by the file
  // itself, not its programme (sourceId): a smaller copy is the same
  // programme as its original (`was`), but another file to read.
  if (source.kind === 'blob') return `blob:${source.hash}@${blobNodeTag()}`;
  return isStartOnly(source) ? `${sourceId(source)}@${started}` : sourceId(source);
}

/** Where the set's screen sends a viewer it asks something of. */
const LOOK = 'SEE YOUR SPACEPHONE (T)';

/** Put the notice up, with the words the set's own screen shows for it;
 *  the same words again leave the DOM (and a button in it, under a finger)
 *  alone. */
function showNotice(t: Theatre, html: string, hint: string): void {
  if (!t.notice.hidden && t.lastNotice === html && t.hint === hint) return;
  const shown = !t.notice.hidden;
  t.notice.innerHTML = html;
  t.lastNotice = html;
  t.hint = hint;
  t.notice.hidden = false;
  if (!shown) noteTheatre();
}
function hideNotice(t: Theatre): void {
  const shown = !t.notice.hidden;
  t.notice.hidden = true;
  t.notice.innerHTML = '';
  t.lastNotice = '';
  t.hint = '';
  if (shown) noteTheatre();
}

/** Build the adapter for `source`; the controller then drives it. Every
 *  callback belongs to THIS attempt: an unmount in between (another source,
 *  a failure, the set going off) voids it, so an adapter arriving late is
 *  destroyed on arrival and never overwrites a live one. */
function mountPlayer(t: Theatre, source: TvSource, key: string, rtt: () => number): void {
  unmountPlayer(t);
  t.mounted = key;
  t.mountedFor = t.playerFor; // this tick's programme (theatreTick notes it before mounting)
  t.mountedAt = tvNow();
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
      <button type="button" data-tv-retry="1">RETRY</button>`, `COULD NOT PLAY · ${LOOK}`);
    t.notice.querySelector<HTMLButtonElement>('[data-tv-retry]')?.addEventListener('click', () => {
      t.mounted = '';
    });
  };
  // Where the picture goes: an embed's frame is laid on the set's screen
  // (tvScreenLayer); a <video> is parked out of sight and its frames put on
  // the screen once it is adopted.
  const set = screenProvider(t.itemId) ?? null;
  const textured = playsAsTexture(source);
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
    const controller = new TvSyncController({
      itemId: t.itemId, player, rttMs: rtt,
      // A LOOP lap this player followed as it ended (tvSync followLap): the
      // registration below names the lap at once, not at the next tick.
      onLapFollowed: (started) => { if (live() && t.controller === controller) t.playerFor = started; },
    });
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
      <div class="tv-theatre-lane">your browser wants a tap before sound</div>`, `TAP TO PLAY · ${LOOK}`);
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
    showNotice(t, `<div>REACHING YOUTUBE…</div><div class="tv-theatre-lane">CONVENIENCE LANE</div>`, 'REACHING YOUTUBE…');
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
 *  video would taint the texture and show nothing). The blaster offers
 *  📺 LOOK only for these: the CRT pass cannot reach a picture in the DOM. */
export function playsAsTexture(source: TvSource): boolean {
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
    // the set itself says so. The picture goes; the next programme puts it
    // up again.
    closeTvTheatre();
    return;
  } else if (isStartOnly(rec.source!) && readPlayback(t.itemId).state !== 'playing') {
    // archive.org's own player autoplays and can neither pause nor seek: it
    // goes up only while the room is playing. A countdown or a pause is
    // words here, no iframe — else a picture put up during a countdown
    // would start the film early, and one put up on a pause would start it
    // over.
    if (t.mounted) unmountPlayer(t);
    const pb = readPlayback(t.itemId);
    showNotice(t, pb.state === 'scheduled'
      ? `<div>${countdownText(pb.countdownMs)}</div><div class="tv-theatre-lane">archive.org's player starts at T0 — start-time sync only</div>`
      : '<div>❚❚ PAUSED</div><div class="tv-theatre-lane">archive.org\'s player has no pause: it starts from the top when the film resumes</div>', '');
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
    // …and so does a player that ran out and cannot seek back to follow a
    // new start of the same source (a replay, a LOOP lap): rebuilt, it
    // plays from the top.
    const lap = t.mounted === key && t.player !== null && replayNeedsRemount(t.player, t.mountedFor, rec.started);
    const stale = t.mounted !== '' && (consent !== 'ok' || (t.mounted !== key && t.mounted !== `failed:${key}`) || lap);
    if (stale) unmountPlayer(t);
    // That rebuild comes no faster than the clip runs here, so it is not
    // the churn the mount budget counts (tvSync lapRemountIsFree).
    if (lap && consent === 'ok' && lapRemountIsFree(t.mountedAt, tvNow())) t.budgetedKey = key;
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
      // then the notice says where it is, and the node is asked for it by
      // AUTO-FETCH within the viewer's cap, budget and switch, else by the
      // viewer's FETCH. No mount budget: the bytes are already on this
      // machine, and the transfer that put them there was bounded by those.
      const st = blobState(rec.source!.hash);
      if (st.state === 'complete') mountPlayer(t, rec.source!, key, rtt);
      else {
        autoFetch(rec.source!, st);
        showBlobNotice(t, rec.source!, st);
      }
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
  // plays: a countdown stays the set's card, and a pause is the set's own
  // menu (tvMenu.ts), drawn on the set, which the DOM layer would cover. A
  // notice up (TAP TO PLAY) takes it down too, so the card shows the set's
  // word for it.
  setScreenHostShown(readPlayback(t.itemId).state === 'playing' && t.notice.hidden);
  t.controller?.tick();
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
    <div class="tv-theatre-lane">asking ${escapeHtml(host)} whether it answers this link itself or sends your browser elsewhere</div>`, 'CHECKING THE LINK…');
  void probeRedirect(url, undefined, undefined, abort.signal).then((verdict) => {
    if (theatre !== t || t.probing !== key || t.probeAbort !== abort) return;
    t.probeAbort = null;
    t.probing = '';
    if (verdict !== 'unknown') return; // the next tick reads the kept verdict
    t.mounted = `failed:${key}`;
    showNotice(t, `<div>NOT PLAYED HERE</div>
      <div class="tv-theatre-lane">${escapeHtml(host)} did not answer a cross-origin check — no CORS headers, or not reachable — and a link that cannot be asked about is not fetched; a CORS-enabled host, your own origin or this station's node plays here</div>
      <button type="button" data-tv-retry="1">RETRY</button>`, `NOT PLAYED HERE · ${LOOK}`);
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

/** The file AUTO-FETCH last asked for: no second is asked for while it is
 *  still on its way. */
let autoFetching: string | null = null;
/** Its ask is still out to the node (the transfer's state says nothing yet). */
let autoFetchAsking = false;
/** The file whose transfer FETCHING calls AUTO-FETCH's: the one it asked
 *  for, until a press asks for it again (a retry is the viewer's own). */
let autoFetchLabel: string | null = null;
/** When this page began waiting for WHERE's answer on the file on the set,
 *  in this room (each room's WHERE is its own, and so is its wait). */
let autoFetchWhere: { hash: string; epoch: number; since: number } | null = null;
/** How long AUTO-FETCH waits for WHERE before asking the provider alone. */
const AUTO_FETCH_WHERE_WAIT_MS = 5_000;

/** 📦 AUTO-FETCH (tvAutoFetch): a file this viewer's node has never been
 *  asked for ('none') is asked for without a press, within the viewer's cap,
 *  budget and switch, once per file per page. A transfer that failed keeps
 *  its FETCH button and its reason, and one still unknown waits for the
 *  node's answer.
 *
 *  One at a time: none while the last ask is out, nor while the file it
 *  asked for is anything but done with (complete, failed, or not taken).
 *  And not before WHERE has said lately which of the room's connected nodes
 *  hold it (an answer due to be asked again is no answer for now), or a few
 *  seconds have passed without one: the one ask names
 *  them (fetchBlob), so a newcomer whose provider has left still takes the
 *  file from the room's host or a viewer who has it. */
function autoFetch(source: Extract<TvSource, { kind: 'blob' }>, st: BlobState): void {
  if (st.state !== 'none' || autoFetchAsking) return;
  if (autoFetching !== null && autoFetching !== source.hash) {
    const prev = blobState(autoFetching).state;
    if (prev !== 'complete' && prev !== 'failed' && prev !== 'none') return;
  }
  if (autoFetchVerdict(source.hash, source.size) !== 'go') return;
  if (freshNodeHolders(source.hash) === null) {
    void refreshHolders([source.hash]);
    const now = tvNow();
    const epoch = tvDocEpoch();
    if (autoFetchWhere?.hash !== source.hash || autoFetchWhere.epoch !== epoch) autoFetchWhere = { hash: source.hash, epoch, since: now };
    if (now - autoFetchWhere.since < AUTO_FETCH_WHERE_WAIT_MS) return;
  }
  noteAutoFetch(source.hash, source.size);
  autoFetching = source.hash;
  autoFetchLabel = source.hash;
  autoFetchAsking = true;
  void fetchBlob(source.hash, source.size, source.provider, source.mime ?? '').then((refused) => {
    // Kept for the notice the next tick draws: FETCH, with why. And the
    // node asked again what it holds: an answer lost on its way back may
    // hide a transfer the node did start, and the gate above waits for
    // the node's word on it, not the 'none' read before the ask.
    blobAskRefused = refused ? { hash: source.hash, why: refused } : null;
    if (refused) recheckBlob(source.hash);
  }).finally(() => { autoFetchAsking = false; });
}

/** 📦 A blob this viewer's node does not hold whole yet: where it is, and
 *  FETCH — the press that asks the viewer's own node to take it from the
 *  node that put it on (blobLane.ts). `st` null: no node to ask. */
function showBlobNotice(t: Theatre, source: Extract<TvSource, { kind: 'blob' }>, st: BlobState | null): void {
  const size = formatBytes(source.size);
  const from = `${source.provider.slice(0, 8)}…`;
  if (st === null) {
    showNotice(t, `<div>📦 ${escapeHtml(sourceLabel(source))} · ${escapeHtml(size)}</div>
      <div class="tv-theatre-lane">SOVEREIGN LANE — a file from a room member's node, played from yours: it needs this station's node (the desktop app) running here</div>`, `NEEDS YOUR NODE · ${LOOK}`);
    return;
  }
  if (st.state === 'unknown') {
    showNotice(t, '<div>ASKING YOUR NODE…</div><div class="tv-theatre-lane">whether it holds this file yet</div>', 'ASKING YOUR NODE…');
    return;
  }
  if (st.state === 'importing') {
    showNotice(t, '<div>YOUR NODE IS STILL TAKING THE FILE</div><div class="tv-theatre-lane">it plays once it is all in</div>', 'YOUR NODE IS TAKING IT…');
    return;
  }
  if (st.state === 'queued' || st.state === 'fetching') {
    const pct = st.size > 0 ? Math.min(100, Math.floor((st.have / st.size) * 100)) : 0;
    showNotice(t, `<div>📦 FETCHING · ${pct}%${autoFetchLabel === source.hash ? ' · AUTO-FETCH' : ''}</div>
      <div class="tv-theatre-lane">${escapeHtml(formatBytes(st.have))} of ${escapeHtml(size)} from ${escapeHtml(from)}, every byte checked against the file's hash — it plays when the last one is in</div>`, `FETCHING · ${pct}%`);
    return;
  }
  // 'none' or 'failed': the button. Its words are constant per programme,
  // so the same ask every tick keeps the button under the finger. Which
  // nodes here kept a copy is asked meanwhile: FETCH names them beside the
  // provider, so it works after the one who shared the file has left.
  void refreshHolders([source.hash]);
  const why = st.state === 'failed' ? st.why || 'no reason given' : blobAskRefused?.hash === source.hash ? blobAskRefused.why : '';
  const failed = why ? `<div class="tv-theatre-lane">the last try stopped: ${escapeHtml(why)}</div>` : '';
  // Why AUTO-FETCH has not taken it, or that it is asking: its ask is out
  // until the node answers (FETCHING, or a refusal with why). One it may
  // still make waits for WHERE or for the file before it; a transfer that
  // failed is the press's to try again (autoFetch takes only 'none').
  const verdict = autoFetchVerdict(source.hash, source.size);
  const asking = autoFetching === source.hash && autoFetchAsking;
  const wait = asking ? 'AUTO-FETCH is asking your node for it'
    : verdict === 'go' && st.state === 'none' && !why ? 'AUTO-FETCH asks your node for it next'
    : verdict === 'go' ? 'nothing more is fetched until you press'
    : verdict === 'off' ? 'AUTO-FETCH is off: nothing is fetched until you press'
    : verdict === 'big' ? `it is bigger than the ${formatBytes(TV_AUTO_FETCH_MAX)} AUTO-FETCH takes by itself: nothing is fetched until you press`
    : verdict === 'day' ? `AUTO-FETCH has used today's ${formatBytes(TV_AUTO_FETCH_DAY)} (each file counts at least ${formatBytes(TV_AUTO_FETCH_MIN_CHARGE)}): nothing more is fetched until you press`
    : 'nothing more is fetched until you press';
  const html = `<div>📦 ${escapeHtml(sourceLabel(source))} · ${escapeHtml(size)}</div>
    <div class="tv-theatre-lane">SOVEREIGN LANE — your node takes it from ${escapeHtml(from)}'s node or another that has it, here or met in this room lately, never from a server; ${escapeHtml(size)} of your disk, kept until your node needs the room (the files used longest ago go first). ${escapeHtml(wait)}</div>
    ${failed}
    <button type="button" data-tv-fetch="${escapeHtml(source.hash)}" data-tv-fetch-size="${source.size}" data-tv-fetch-from="${escapeHtml(source.provider)}">📦 FETCH ${escapeHtml(size)}</button>`;
  if (!t.notice.hidden && t.lastNotice === html) return;
  showNotice(t, html, `NOT FETCHED YET · ${LOOK}`);
  t.notice.querySelector<HTMLButtonElement>('[data-tv-fetch]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    // The press is for THE TRANSFER THE BUTTON SHOWED — this file, this
    // size, from this node: a peer may have changed any of them between the
    // render and the click, and the press consents to none of the changes.
    const now = readTv(t.itemId).source;
    if (!now || now.kind !== 'blob' || now.hash !== btn.dataset.tvFetch
      || String(now.size) !== btn.dataset.tvFetchSize || now.provider !== btn.dataset.tvFetchFrom) return;
    btn.disabled = true;
    notePressedFetch(now.hash); // AUTO-FETCH asks for it no more from here, whenever its WHERE lands
    if (autoFetchLabel === now.hash) autoFetchLabel = null; // and this transfer is the press's
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
    <div class="tv-theatre-lane">${escapeHtml(host || 'this host')} answers this link with a redirect, and your browser would follow it without saying where — paste the link it redirects to instead</div>`, `NOT PLAYED HERE · ${LOOK}`);
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
    <button type="button" data-tv-mount="${escapeHtml(key)}">▶ PLAY</button>`, `PLAY IT? · ${LOOK}`);
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
      <div class="tv-theatre-lane">the ${escapeHtml(sourceLane(source))} lane is off — ${escapeHtml(SERVERLESS_ONLY)}: a file on your own origin or this station's node, and the lanes to come</div>`, 'NOT IN THIS BUILD');
    } else if (why === 'server-off') {
      showNotice(t, `<div>NOT IN THIS BUILD</div>
      <div class="tv-theatre-lane">${escapeHtml(host || 'this link')} is another server — ${escapeHtml(SERVERLESS_ONLY)}: a link on your own origin or this station's node plays here</div>`, 'NOT IN THIS BUILD');
    } else if (why === 'node-stale') {
      // The node's origin, but the node has not answered a fingerprint probe
      // within its trust lifetime (tvConsent TV_NODE_TRUST_MS): whatever is
      // on that port now is not known to be the node. The next probe that
      // the node answers renews the trust and the theatre mounts on its own.
      showNotice(t, `<div>WAITING FOR THE NODE</div>
      <div class="tv-theatre-lane">${escapeHtml(host || 'this link')} is this station's node, but it has not answered lately — the picture returns when it does</div>`, 'WAITING FOR THE NODE…');
    } else {
      showNotice(t, `<div>NOT PLAYED HERE</div>
      <div class="tv-theatre-lane">${escapeHtml(host || 'this link')} is inside a private network — nobody in the room can ask your browser to fetch from there</div>`, 'NOT PLAYED HERE');
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
    <button type="button" data-tv-allow="${escapeHtml(origin)}">▶ PLAY FROM ${escapeHtml(host)}</button>`, `ALLOW IT? · ${LOOK}`);
  t.notice.querySelector<HTMLButtonElement>('[data-tv-allow]')?.addEventListener('click', () => {
    acceptMediaOrigin(origin);
    hideNotice(t);
  });
}

// ── The picture on a set that is on ─────────────────────────────────────────

let pictureOpen: ((itemId: string) => void) | null = null;

/** Register how a set's picture is put up (main.ts supplies the deps). */
export function setTvPictureOpener(fn: (itemId: string) => void): void {
  pictureOpen = fn;
}

/** Driven at ~2 Hz by World with the room's TV ids: with no picture up, the
 *  first set that has something on gets it (#258: nothing to press, and
 *  nothing on screen around it). */
export function updateTvPicture(itemIds: readonly string[]): void {
  if (theatre || !pictureOpen) return;
  for (const id of itemIds) {
    const rec = readTv(id);
    if (!rec.source || rec.state === 'off' || rec.state === 'home') continue;
    pictureOpen(id);
    if (theatre) return;
  }
}
