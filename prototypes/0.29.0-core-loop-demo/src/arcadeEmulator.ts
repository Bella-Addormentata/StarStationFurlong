/**
 * 🕹 arcadeEmulator — the seam between the cabinet and EmulatorJS (#193).
 *
 * EmulatorJS (libretro cores in WASM, GPL-3.0) configures itself from
 * globals, is loaded by ITS loader script, and has no clean teardown — so
 * it runs in an IFRAME of our own (public/arcade/frame.html). Closing the
 * cabinet removes the frame: a complete teardown, every time. Keys typed
 * into the focused frame never reach the world's input (an event does not
 * cross a frame), which is how WASD stays suppressed while at the controls.
 *
 * THE FRAME IS AN OPAQUE ORIGIN, ON EVERY LANE (sandboxed, never
 * allow-same-origin): engine code and ROM data are external inputs — a core
 * is a third party's build, a ROM is whatever a file or a server held, and
 * a core bug a ROM exploits is script in the frame — and a same-origin
 * frame would share this page's DOM, its storage and, in the desktop
 * shells, the IPC bridge; a content-security policy bounds what the frame
 * may LOAD, never what its scripts may reach. So nothing in the frame can
 * name this page: only messages cross (matched to this frame's window);
 * the ROM goes in as bytes this page fetched itself — as the page, under
 * the consent the stage asked — never as a URL the frame would fetch with
 * no origin to its name; and the picture will come OUT the same way for
 * the spectator lane (plan §9: ImageBitmaps the frame posts), never by a
 * reach into its canvas, which an opaque origin forbids. The sandbox
 * allows scripts and pointer lock and nothing else (EMULATOR_SANDBOX).
 *
 * THE FRAME'S NAVIGATIONS ARE ITS EMBEDDER'S TO GOVERN. No policy of the
 * frame's own and no sandbox flag forbids a document leaving for another
 * URL — and once it has left, the policy it left under governs nothing of
 * what arrives, which would run before this page heard of it. So the
 * frame is mounted inside a WALL: a same-origin srcdoc document of this
 * page's own whose one policy is `default-src 'none'; frame-src <the
 * frame's URL, exactly>` (emulatorWallPolicy). A frame-src is checked by
 * the browser on every navigation of the frames a document embeds,
 * whoever starts it, BEFORE the request is dispatched: a frame that tries
 * to leave sends nothing, the wall hears the violation and the frame comes
 * down with the reason. The one navigation the policy allows, to the
 * frame's own path, is caught by its second load and torn down the same
 * way — and the document that arrives runs this page's script alone,
 * receives no config (a frame is configured once), sets no policy and
 * loads nothing; a teardown after a navigation is the belt, never the
 * barrier. The wall carries no script: the frame and this page talk past
 * it, the frame posting to the wall's parent and this page to the frame's
 * window.
 *
 * The emulator's own files come from one of two places, the owner's call
 * per cabinet (arcadeDoc's `data`): THIS STATION's /emulatorjs/data/ —
 * fetched by scripts/fetch-emulatorjs.mjs, never vendored (size), the
 * SOVEREIGN lane — or cdn.emulatorjs.org, the CONVENIENCE lane, which a
 * build offers only with the convenience lanes on (sovereignty.ts; off by
 * default: serverless sources only). Neither is bundled, so a fresh
 * checkout shows NOT PROVISIONED with the command, not a blank screen:
 * probeEmulatorData looks before the frame mounts. The frame sets its own
 * content-security policy on EVERY lane, on receipt of this page's config
 * and before its loader is fetched (emulatorFrameOrigins → frame.html):
 * its own origin, the engine's origin where that is another (the CDN
 * lane) and the viewer's own node, nothing else. Nothing travels in the
 * frame's URL, which is one immutable path the wall names exactly: a
 * query is ignored by frame-src, so a policy chosen by one could be
 * swapped by a self-navigation to the same path. An opaque origin's
 * fetches carry `Origin: null`, so the station serves /emulatorjs/ with
 * Access-Control-Allow-Origin (vite.config.ts for the dev and preview
 * servers; a deployment the same) — the engine and its cores, public
 * files, and nothing else needs it.
 *
 * DOM-free except mountEmulatorFrame; the path and probe maths are tested.
 */

import { ejsCore, gameId, ARCADE_CORES } from './arcadeDoc';
import { readFrameBatch, readFrameHash, readFrameSnapshot } from './arcadeReplay';
import type { ReplayBatch, ReplayHash, ReplaySnapshot } from './arcadeReplay';
import type { ArcadeCore, ArcadeGame, EmulatorData } from './arcadeDoc';
import { convenienceLanesEnabled } from './sovereignty';
import { escapeHtml } from './htmlEscape';

export const EMULATOR_CDN_DATA = 'https://cdn.emulatorjs.org/stable/data/';
export const EMULATOR_FETCH_COMMAND = 'npm run fetch:emulatorjs';
/** The frame's own budget for loader → engine → core → game. */
export const EMULATOR_LOAD_TIMEOUT_MS = 45_000;
/** How long the frame may take to say hello at all (a 404 on frame.html). */
export const EMULATOR_HELLO_TIMEOUT_MS = 15_000;
/** A moment, after the frame loads a second document, for the wall's
 *  violation report to arrive: a browser that refuses a navigation may put
 *  its own blank page in the frame (Chromium does), whose load reaches
 *  the page before the report of the refusal that caused it. */
export const EMULATOR_REFUSAL_GRACE_MS = 150;

function baseUrl(): string {
  const env = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const b = env?.BASE_URL || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

/** Where loader.js, the engine and the cores live, with a trailing slash. */
export function emulatorDataPath(data: EmulatorData, base = baseUrl()): string {
  if (data === 'cdn') return EMULATOR_CDN_DATA;
  return `${base.endsWith('/') ? base : `${base}/`}emulatorjs/data/`;
}

export function emulatorDataLane(data: EmulatorData): 'SOVEREIGN' | 'CONVENIENCE' {
  return data === 'cdn' ? 'CONVENIENCE' : 'SOVEREIGN';
}

export function arcadeFrameUrl(base = baseUrl()): string {
  return `${base.endsWith('/') ? base : `${base}/`}arcade/frame.html`;
}

export type EmulatorProbe = 'ok' | 'missing' | 'unreachable' | 'unknown';

/** Is loader.js where the cabinet expects it? Only a same-origin path is
 *  probed (the station's own files): a cross-origin CDN cannot be read
 *  without its CORS consent, so it is 'unknown' and the loader decides. */
export async function probeEmulatorData(
  path: string,
  fetchFn: typeof fetch = fetch,
  origin = typeof location === 'undefined' ? '' : location.origin,
): Promise<EmulatorProbe> {
  if (/^https?:\/\//i.test(path)) {
    try {
      if (new URL(path).origin !== origin) return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  try {
    const res = await fetchFn(`${path}loader.js`, { cache: 'no-store' });
    if (!res.ok) return res.status >= 500 ? 'unreachable' : 'missing';
    // A dev server's SPA fallback answers 200 with index.html: not the loader.
    const type = res.headers.get('content-type') ?? '';
    return /html/i.test(type) ? 'missing' : 'ok';
  } catch {
    return 'unreachable';
  }
}

export interface EmulatorConfig {
  core: ArcadeCore;
  /** The game's bytes — this page's own fetch of the link, or the player's
   *  file — handed to the frame as a Blob, never as a URL (the header). */
  game: Blob;
  /** The file's name — arcade cores need the romset's name. */
  gameName: string;
  pathToData: string;
  /** 0–1. */
  volume: number;
  /** Engine code from another origin (the CDN lane). The frame is an opaque
   *  origin either way (mountEmulatorFrame); this says WHOSE code runs in
   *  it, which is what the player's consent to hand it their own file is
   *  about (localRomExposureAllowed); the frame's URL is the same path on
   *  every lane, its policy set from the config (emulatorFrameOrigins). */
  isolated: boolean;
  /** Origins beyond the frame's own that its policy lets it fetch from —
   *  the viewer's own node (tvConsent's own media origins); the engine's
   *  own origin is added for the CDN lane (emulatorFrameOrigins). */
  allowOrigins: readonly string[];
  /** Spectating by input replay (arcadeReplay.ts): player one's frame is
   *  the 'source', a spectator's the 'follower'. Absent: no replay hooks. */
  replay?: EmulatorReplayConfig;
}

export interface EmulatorReplayConfig {
  /** 'source': player one's frame, watched; 'follower': a spectator's;
   *  'peer': one seat of a lockstep game (up to four players, every seat
   *  running the game and holding each frame for every seat's buttons). */
  role: 'source' | 'follower' | 'peer';
  /** Hash the state every this many frames (default 60). */
  hashEvery?: number;
  /** A follower out of a stall waits for this many frames of input (12). */
  lead?: number;
  /** The source posts a batch every this many frames (6); a peer posts one
   *  at least this often, and at once with any buttons in it. */
  batchFrames?: number;
  /** A peer's seat, 0–3, and how many seats the cabinet has. Whichever
   *  seat the page names begins an epoch (arcadeLockstep.ts). */
  seat?: number;
  seats?: number;
  /** A peer's input delay: its player's buttons land this many frames
   *  after they are pressed (default 8), the time every other seat has to
   *  hear of them before it must run that frame. */
  delay?: number;
}

/** A follower's report of where it stands. */
export interface ReplayStatus {
  phase: 'waiting' | 'loading' | 'stalled' | 'running' | 'free' | 'lockstep' | 'unsupported';
  /** A lockstep peer's epoch (arcadeLockstep.ts), '' before its first. */
  nonce?: string;
  /** The source frame the follower's state is at. */
  frame?: number;
  /** The latest `through` it holds. */
  through?: number;
  /** Set once, as a save state lands: its frame, the hash after loading,
   *  whether that matched the hash the source sent with it, and how many
   *  iterations the load took to land. */
  loaded?: number;
  hash?: string;
  matches?: boolean;
  tries?: number;
  /** A lockstep peer's waits so far: the times it held a frame for another
   *  seat's buttons, and the iterations it held them (each a frame late). */
  stalls?: number;
  waits?: number;
  /** Main-loop iterations since lockstep began, held or not. */
  iters?: number;
}

/** Whether engine files at `pathToData` come from another origin than the
 *  app — the CDN lane — and must therefore run isolated. */
export function emulatorIsolated(
  pathToData: string,
  origin = typeof location === 'undefined' ? '' : location.origin,
): boolean {
  if (!/^https?:\/\//i.test(pathToData)) return false;
  try {
    return new URL(pathToData).origin !== origin;
  } catch {
    return true;
  }
}

/** An origin as a content-security policy source: http(s), host, port —
 *  no path, no space, quote or semicolon that could end the directive. */
const CSP_ORIGIN = /^https?:\/\/[A-Za-z0-9.\-:[\]]+$/;

/** The http(s) origins the frame's policy admits beyond its own, carried in
 *  the config (frame.html composes the policy from them, on every lane,
 *  before its loader loads): the engine's origin where it is another than
 *  this page's (the CDN lane; the station lane's engine is this page's own
 *  files) and the viewer's own node — reduced to origins here, and checked
 *  again by the frame before they enter its policy. Never this page's own
 *  origin, which the frame names for itself. */
export function emulatorFrameOrigins(
  config: Pick<EmulatorConfig, 'pathToData' | 'allowOrigins'>,
  origin = typeof location === 'undefined' ? '' : location.origin,
): string[] {
  const allow = new Set<string>();
  const add = (candidate: string) => {
    let value = '';
    try {
      value = new URL(candidate).origin;
    } catch { /* not a URL: not an origin */ }
    if (CSP_ORIGIN.test(value) && value !== origin) allow.add(value);
  };
  if (/^https?:\/\//i.test(config.pathToData)) add(config.pathToData);
  for (const o of config.allowOrigins) add(o);
  return [...allow];
}

export type EmulatorEvent =
  | { type: 'frame-ready' }
  | { type: 'ready' }
  | { type: 'started' }
  | { type: 'exit' }
  | { type: 'error'; why: string }
  /** `nonce`: a lockstep peer's epoch (arcadeLockstep.ts); a source posts none. */
  | { type: 'replay-inputs'; batch: ReplayBatch; nonce?: string }
  | { type: 'replay-hash'; hash: ReplayHash; nonce?: string }
  | { type: 'replay-snapshot'; snapshot: ReplaySnapshot; nonce?: string }
  | { type: 'replay-status'; status: ReplayStatus };

/** What the frame may say, and how much. The frame is attacker-controlled
 *  after a core exploit, so a message from it is input from an attacker:
 *  matching the event's source says only WHO is posting. So one shape per
 *  kind — known keys, a short string — and a message of any other shape
 *  brings the frame down at the first word (`malformed`): no game sends
 *  one, a frame that does is exploited or broken, and dropping it would
 *  pay the clone below for every such message up to the budget; and a
 *  budget of messages a second, past which the frame comes down
 *  (`flood`): the page is not the frame's to keep busy. What no handler
 *  can refuse is the structured clone the browser performs BEFORE the
 *  handler runs: one oversized message costs the page its clone once, and
 *  then the frame is gone (plan §9). */
export const FRAME_MESSAGE_BUDGET = 20;
/** A lockstep peer's budget: a batch as often as every frame while its
 *  player presses (60 a second), and room beside them for its hash and
 *  status each second and the messages of its start and its load. */
export const FRAME_MESSAGE_BUDGET_LOCKSTEP = 80;
export const FRAME_MESSAGE_WINDOW_MS = 1_000;
/** Save states the page may have asked a frame for and not yet had. */
export const SNAPSHOT_ASKS_MAX = 4;
export const FRAME_STRING_MAX = 256;

export type FrameMessage =
  | { type: 'arcade-frame-ready' }
  | { type: 'arcade-ready' }
  | { type: 'arcade-started' }
  | { type: 'arcade-exit' }
  | { type: 'arcade-error'; why: string }
  | { type: 'arcade-replay-inputs'; batch: ReplayBatch; nonce?: string }
  | { type: 'arcade-replay-hash'; hash: ReplayHash; nonce?: string }
  | { type: 'arcade-replay-snapshot'; snapshot: ReplaySnapshot; nonce?: string }
  | { type: 'arcade-replay-status'; status: ReplayStatus };

const FRAME_MESSAGE_KEYS: Record<FrameMessage['type'], readonly string[]> = {
  'arcade-frame-ready': ['type'],
  'arcade-ready': ['type'],
  'arcade-started': ['type'],
  'arcade-exit': ['type'],
  'arcade-error': ['type', 'why'],
  'arcade-replay-inputs': ['type', 'nonce', 'from', 'through', 'inputs'],
  'arcade-replay-hash': ['type', 'nonce', 'frame', 'hash'],
  'arcade-replay-snapshot': ['type', 'nonce', 'frame', 'state', 'held', 'hash'],
  'arcade-replay-status': ['type', 'nonce', 'phase', 'frame', 'through', 'loaded', 'hash', 'matches', 'tries', 'stalls', 'waits', 'iters'],
};

/** The replay kinds a frame may post, by the role its config gave it
 *  (arcadeReplay.ts): player one's frame its batches, hashes and save
 *  states; a spectator's its hashes and where it stands; a lockstep peer's
 *  all of them (the save state of the seat that begins an epoch starts it
 *  for the others); any that it cannot replay at all. A frame given no role posts none: from it, or
 *  from the other role, a replay kind is a message no game sends. */
const REPLAY_KINDS: Record<EmulatorReplayConfig['role'], ReadonlySet<string>> = {
  source: new Set(['arcade-replay-inputs', 'arcade-replay-hash', 'arcade-replay-snapshot', 'arcade-replay-status']),
  follower: new Set(['arcade-replay-hash', 'arcade-replay-status']),
  peer: new Set(['arcade-replay-inputs', 'arcade-replay-hash', 'arcade-replay-snapshot', 'arcade-replay-status']),
};

/** The frame's message as one of the shapes above, or null — an unknown
 *  kind, a key the kind does not have, a `why` that is not a string or is
 *  longer than FRAME_STRING_MAX, a replay kind its role does not post or
 *  whose payload arcadeReplay.ts will not read, no object at all: read no
 *  further, and the frame is torn down for it (mountEmulatorFrame,
 *  `malformed`). */
export function frameMessage(data: unknown, replay?: EmulatorReplayConfig['role']): FrameMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  const type = d.type;
  if (typeof type !== 'string' || !Object.prototype.hasOwnProperty.call(FRAME_MESSAGE_KEYS, type)) return null;
  const kind = type as FrameMessage['type'];
  const keys = FRAME_MESSAGE_KEYS[kind];
  for (const k of Object.keys(d)) if (!keys.includes(k)) return null;
  if (kind.startsWith('arcade-replay-') && !(replay && REPLAY_KINDS[replay].has(kind))) return null;
  // A lockstep peer's epoch tag: only a peer posts one, and only a short
  // one (the page's own, echoed: arcadeLockstep.ts).
  if (d.nonce !== undefined && (replay !== 'peer' || !isEpochTag(d.nonce))) return null;
  const tagged = d.nonce !== undefined ? { nonce: d.nonce as string } : {};
  switch (kind) {
    case 'arcade-error': {
      const why = d.why;
      if (typeof why !== 'string' || why.length > FRAME_STRING_MAX) return null;
      return { type: kind, why };
    }
    case 'arcade-replay-inputs': {
      const batch = readFrameBatch(d);
      return batch ? { type: kind, batch, ...tagged } : null;
    }
    case 'arcade-replay-hash': {
      const hash = readFrameHash(d);
      return hash ? { type: kind, hash, ...tagged } : null;
    }
    case 'arcade-replay-snapshot': {
      const snapshot = readFrameSnapshot(d);
      return snapshot ? { type: kind, snapshot, ...tagged } : null;
    }
    case 'arcade-replay-status': {
      const status = readReplayStatus(d);
      return status ? { type: kind, status } : null;
    }
    default:
      return { type: kind };
  }
}

/** An epoch's tag as the page writes it (arcadeLockstep.ts): a few lower-
 *  case letters and digits. The empty tag is a peer's before its first. */
export function isEpochTag(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-z]{0,16}$/.test(v);
}

/** Whether a message from the page asks its frame for a save state: a
 *  source's on request, and a peer's when the page has it begin an epoch
 *  with other seats in it (alone, it just plays). A save state is the one
 *  large message a frame may post, and only in answer to one of these. */
export function asksForSnapshot(message: Record<string, unknown>, replay?: EmulatorReplayConfig): boolean {
  if (message.type === 'arcade-replay-want-snapshot') return replay?.role === 'source';
  if (message.type === 'arcade-replay-begin') return replay?.role === 'peer' && Array.isArray(message.seats) && message.seats.length > 1;
  return false;
}

/** Messages a second from one frame, counted on every message it posts,
 *  shape or no shape: a flood of garbage is a flood. */
export class MessageBudget {
  private readonly stamps: number[] = [];
  constructor(private readonly limit = FRAME_MESSAGE_BUDGET, private readonly windowMs = FRAME_MESSAGE_WINDOW_MS) {}
  /** True while the message fits the budget; false on the one that breaks it. */
  take(now: number): boolean {
    while (this.stamps.length && now - this.stamps[0]! >= this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.limit) return false;
    this.stamps.push(now);
    return true;
  }
}

export interface EmulatorHandle {
  /** The wall in the stage: this page's own document around the frame. */
  readonly wall: HTMLIFrameElement;
  /** The emulator's frame inside the wall, once the wall is up. */
  emulator(): HTMLIFrameElement | null;
  focus(): void;
  /** Post a replay message to the frame (arcadeReplay.ts: the source's
   *  batches and snapshot to a follower, a snapshot request or a press to a
   *  source). Nothing before the frame has said hello. */
  send(message: Record<string, unknown>, transfer?: Transferable[]): void;
  destroy(): void;
}

/** The sandbox every lane's frame runs under: scripts (the engine) and
 *  pointer lock (the mouse as a trackball), nothing else — never
 *  allow-same-origin, which is the wall (the header), and no forms, popups
 *  or downloads either: each is a request to any URL that no policy
 *  directive governs, a popup or a download script-initiated at that, and
 *  the policy's "nothing else" would be hollow with them. (A save state
 *  therefore leaves by postMessage, the page offering the file — a
 *  follow-up; EmulatorJS's own export is a download the sandbox refuses,
 *  and an opaque origin has no storage to keep one in.) What no flag
 *  forbids is the frame navigating ITSELF: that is what the wall's
 *  frame-src governs (emulatorWallPolicy), before a request goes out. */
export const EMULATOR_SANDBOX = 'allow-scripts allow-pointer-lock';

/** The policy of the wall around the frame (the header): the frame may
 *  navigate to its own URL — scheme, host, port and path, exactly; a source
 *  names no query — and nowhere else, and the wall itself loads nothing.
 *  Null when the URL cannot be named as one source (no host, or a character
 *  that would end the directive or start another source): then there is no
 *  frame at all. */
export function emulatorWallPolicy(frameUrl: string, href = typeof location === 'undefined' ? '' : location.href): string | null {
  let u: URL;
  try {
    u = href ? new URL(frameUrl, href) : new URL(frameUrl);
  } catch {
    return null;
  }
  if (!u.host) return null;
  const source = `${u.protocol}//${u.host}${u.pathname}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s,;'"]+$/i.test(source)) return null;
  return `default-src 'none'; frame-src ${source}`;
}

/** A lockstep peer speaks for its own seat only: a batch with another
 *  seat's buttons in it is out of turn (mountEmulatorFrame tears the frame
 *  down as malformed). Any other role, or kind, names no seat to check. */
export function peerOwnSeat(m: FrameMessage, replay?: EmulatorReplayConfig): boolean {
  if (m.type !== 'arcade-replay-inputs' || replay?.role !== 'peer') return true;
  return m.batch.inputs.every((i) => i.player === replay.seat);
}

const REPLAY_PHASES: ReadonlySet<string> = new Set(['waiting', 'loading', 'stalled', 'running', 'free', 'lockstep', 'unsupported']);

/** A follower's status as the frame posts it: every field it carries in
 *  its shape, or none of it (a field out of shape is a malformed message,
 *  frameMessage). */
export function readReplayStatus(data: unknown): ReplayStatus | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.phase !== 'string' || !REPLAY_PHASES.has(d.phase)) return null;
  const out: ReplayStatus = { phase: d.phase as ReplayStatus['phase'] };
  if (d.nonce !== undefined) {
    if (!isEpochTag(d.nonce)) return null;
    out.nonce = d.nonce;
  }
  const int = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= -1 && v <= 0xffff_ffff;
  for (const k of ['frame', 'through', 'loaded'] as const) {
    if (d[k] === undefined) continue;
    if (!int(d[k])) return null;
    out[k] = d[k] as number;
  }
  if (d.hash !== undefined) {
    if (typeof d.hash !== 'string' || !/^[0-9a-f]{1,8}:\d{1,9}$/.test(d.hash)) return null;
    out.hash = d.hash;
  }
  if (d.matches !== undefined) {
    if (typeof d.matches !== 'boolean') return null;
    out.matches = d.matches;
  }
  if (d.tries !== undefined) {
    if (typeof d.tries !== 'number' || !Number.isInteger(d.tries) || d.tries < 0 || d.tries > 1000) return null;
    out.tries = d.tries;
  }
  for (const k of ['stalls', 'waits', 'iters'] as const) {
    if (d[k] === undefined) continue;
    if (!int(d[k]) || (d[k] as number) < 0) return null;
    out[k] = d[k] as number;
  }
  return out;
}

/** The parent side of the frame protocol: the frame says hello, the parent
 *  answers with the config, the frame reports ready / started / exit /
 *  error. Messages are matched to THIS frame's window, nothing else. */
export function mountEmulatorFrame(
  host: HTMLElement,
  config: EmulatorConfig,
  onEvent: (ev: EmulatorEvent) => void,
  frameUrl = arcadeFrameUrl(),
): EmulatorHandle {
  const title = `Furlong Arcade — ${config.gameName}`;
  // A permission a frame delegates it must hold itself: the wall and the
  // frame carry the same list.
  const allow = 'gamepad *; autoplay *; fullscreen *';
  // The wall (the header): a document of this page's own around the frame
  // — same-origin, srcdoc taking this page's origin, so this page reaches
  // into it and nothing in the frame does, an opaque origin being nobody
  // to it — whose one policy is on the frame's navigations.
  const wall = document.createElement('iframe');
  wall.className = 'arcade-frame';
  wall.setAttribute('allow', allow);
  wall.setAttribute('title', title);
  const policy = emulatorWallPolicy(frameUrl);
  let alive = true;
  let configured = false;
  let frame: HTMLIFrameElement | null = null;
  // An opaque origin has no name a target could match: '*' is the only
  // target that reaches it. What bounds who hears the config is the window
  // it is posted to — this frame's, which the wall lets navigate nowhere
  // but to its own URL — and the config carries the game's bytes, which
  // were the frame's to have, and nothing of this page's.
  const target = '*';
  // The frame's messages are input from an attacker (the header on
  // FRAME_MESSAGE_BUDGET): counted before they are read, read into one
  // shape or the frame torn down, each state reported once.
  const budget = new MessageBudget(config.replay?.role === 'peer' ? FRAME_MESSAGE_BUDGET_LOCKSTEP : FRAME_MESSAGE_BUDGET);
  let silenced = false;
  let readySeen = false;
  let startedSeen = false;
  /** Save states the page has asked for and not yet had (a few at most:
   *  asks the frame folds into one leave one or two over, never more). */
  let snapshotsWanted = 0;
  const onMessage = (e: MessageEvent) => {
    if (!alive || silenced || !frame || e.source !== frame.contentWindow) return;
    if (!budget.take(performance.now())) {
      silenced = true;
      onEvent({ type: 'error', why: 'flood' });
      return;
    }
    const m = frameMessage(e.data, config.replay?.role);
    // A save state is the one large message a frame may post, so only in
    // answer to the page's ask (send, asksForSnapshot): one it was not
    // asked for is out of turn.
    if (!m || (m.type === 'arcade-replay-snapshot' && snapshotsWanted === 0) || !peerOwnSeat(m, config.replay)) {
      silenced = true;
      onEvent({ type: 'error', why: 'malformed' });
      return;
    }
    if (m.type === 'arcade-replay-snapshot') snapshotsWanted -= 1;
    switch (m.type) {
      case 'arcade-frame-ready':
        if (configured) return;
        configured = true;
        onEvent({ type: 'frame-ready' });
        frame.contentWindow?.postMessage({
          type: 'arcade-config',
          // EmulatorJS's own name for it (arcadeDoc's ARCADE_CORES).
          core: ejsCore(config.core),
          game: config.game,
          gameName: config.gameName,
          pathToData: config.pathToData,
          // The origins the frame's policy admits beyond its own — set by
          // the frame on receipt, before its loader loads, on every lane.
          allow: emulatorFrameOrigins(config),
          volume: config.volume,
          isolated: config.isolated,
          timeoutMs: EMULATOR_LOAD_TIMEOUT_MS,
          replay: config.replay?.role,
          replayHashEvery: config.replay?.hashEvery,
          replayLead: config.replay?.lead,
          replayBatchFrames: config.replay?.batchFrames,
          replaySeat: config.replay?.seat,
          replaySeats: config.replay?.seats,
          replayDelay: config.replay?.delay,
        }, target);
        break;
      case 'arcade-ready': if (!readySeen) { readySeen = true; onEvent({ type: 'ready' }); } break;
      case 'arcade-started': if (!startedSeen) { startedSeen = true; onEvent({ type: 'started' }); } break;
      case 'arcade-exit': onEvent({ type: 'exit' }); break;
      case 'arcade-error': onEvent({ type: 'error', why: m.why }); break;
      case 'arcade-replay-inputs': onEvent({ type: 'replay-inputs', batch: m.batch, ...(m.nonce !== undefined ? { nonce: m.nonce } : {}) }); break;
      case 'arcade-replay-hash': onEvent({ type: 'replay-hash', hash: m.hash, ...(m.nonce !== undefined ? { nonce: m.nonce } : {}) }); break;
      case 'arcade-replay-snapshot': onEvent({ type: 'replay-snapshot', snapshot: m.snapshot, ...(m.nonce !== undefined ? { nonce: m.nonce } : {}) }); break;
      case 'arcade-replay-status': onEvent({ type: 'replay-status', status: m.status }); break;
      default: break;
    }
  };
  // A frame that loads a SECOND document has navigated — to its own URL,
  // the one the wall's policy allows — and comes down: the belt behind
  // the barrier. The first load is frame.html's own: with src set before
  // the frame is inserted, no load event is fired for the initial
  // about:blank (the HTML standard's iframe load steps), so the count is
  // the test.
  let loads = 0;
  const onLoad = () => {
    loads += 1;
    // Unless the wall reports a refusal first (EMULATOR_REFUSAL_GRACE_MS):
    // then the second document is the browser's own blank page for the
    // navigation it refused, and the reason is the refusal.
    if (loads > 1) window.setTimeout(() => { if (alive) onEvent({ type: 'error', why: 'navigated' }); }, EMULATOR_REFUSAL_GRACE_MS);
  };
  // The wall's policy refused a navigation of the frame: it tried to leave
  // and nothing was sent. Down it comes, with the reason.
  const onViolation = (e: SecurityPolicyViolationEvent) => {
    if (alive && /^frame-src/.test(e.effectiveDirective || e.violatedDirective)) onEvent({ type: 'error', why: 'barred' });
  };
  const onWallLoad = () => {
    if (!alive) return;
    const doc = wall.contentDocument;
    const win = wall.contentWindow;
    // The wall is up once ITS document — the one carrying the policy — has
    // loaded; a load reported for the initial about:blank is not it.
    if (!doc || !win || !doc.body || !doc.querySelector('meta[http-equiv="Content-Security-Policy"]')) return;
    wall.removeEventListener('load', onWallLoad);
    // Sized by the CSSOM: the wall's policy admits no stylesheet and no
    // style attribute, and need not — a property set from here is no load.
    for (const el of [doc.documentElement, doc.body]) {
      el.style.margin = '0';
      el.style.height = '100%';
      el.style.overflow = 'hidden';
      el.style.background = '#000';
    }
    const f = doc.createElement('iframe');
    f.setAttribute('allow', allow);
    f.setAttribute('title', title);
    // An opaque origin, every lane (the header): the code inside — the
    // station's engine or the CDN's, and whatever a ROM makes of a core —
    // cannot read this page, its storage or its DOM, and the desktop
    // shells' IPC is not its to call. Only messages cross, matched to this
    // frame's window above.
    f.setAttribute('sandbox', EMULATOR_SANDBOX);
    f.style.display = 'block';
    f.style.width = '100%';
    f.style.height = '100%';
    f.style.border = '0';
    f.style.background = '#000';
    // One immutable path, no query: the lane and the origins its policy
    // admits reach the frame in the config (frame-src ignores a query, so
    // a policy chosen by one could be swapped by a self-navigation).
    f.src = frameUrl;
    f.addEventListener('load', onLoad);
    doc.addEventListener('securitypolicyviolation', onViolation);
    // Focus that lands on the wall (Tab from the stage's controls) goes on
    // into the frame, where the game's keys belong — by the frame's
    // window: focusing the element alone stops at the wall (focus()).
    win.addEventListener('focus', () => { if (alive) f.contentWindow?.focus(); });
    frame = f;
    doc.body.appendChild(f);
  };
  const hello = window.setTimeout(() => {
    if (alive && !configured) onEvent({ type: 'error', why: 'frame' });
  }, EMULATOR_HELLO_TIMEOUT_MS);
  // The frame posts past the wall, to this window (frame.html's pageWin).
  window.addEventListener('message', onMessage);
  if (policy) {
    wall.addEventListener('load', onWallLoad);
    wall.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(policy)}"><title>${escapeHtml(title)}</title></head><body></body></html>`;
    host.appendChild(wall);
  } else {
    // A frame URL the policy cannot name as one source: no wall, no frame.
    window.setTimeout(() => { if (alive) onEvent({ type: 'error', why: 'frame' }); }, 0);
  }
  return {
    wall,
    emulator: () => frame,
    focus() {
      // The element first, the window last: focusing the element makes the
      // frame the wall's focused element and leaves the keyboard in the
      // wall; focusing the frame's window moves it into the frame, and a
      // later element focus would pull it back out (the cabinet's smoke
      // measured both orders).
      try {
        frame?.focus();
        frame?.contentWindow?.focus();
      } catch { /* detached */ }
    },
    send(message, transfer = []) {
      if (!alive || !configured) return;
      if (asksForSnapshot(message, config.replay)) snapshotsWanted = Math.min(SNAPSHOT_ASKS_MAX, snapshotsWanted + 1);
      frame?.contentWindow?.postMessage(message, target, transfer);
    },
    destroy() {
      alive = false;
      window.clearTimeout(hello);
      window.removeEventListener('message', onMessage);
      wall.removeEventListener('load', onWallLoad);
      try {
        wall.contentDocument?.removeEventListener('securitypolicyviolation', onViolation);
      } catch { /* gone with the wall */ }
      frame?.removeEventListener('load', onLoad);
      wall.remove();
    },
  };
}

/** What the stage tells the player for each failure the frame (or the
 *  probe) reports. */
export function emulatorErrorText(why: string, data: EmulatorData): { title: string; hint: string } {
  if (why === 'loader' || why === 'timeout') {
    return data === 'cdn'
      ? { title: 'CDN.EMULATORJS.ORG DID NOT ANSWER', hint: 'The CONVENIENCE lane is down or blocked here. The owner can switch the cabinet to THIS STATION after fetching the files.' }
      : { title: 'EMULATOR FILES NOT PROVISIONED', hint: `This station has no /emulatorjs/ yet. Run ${EMULATOR_FETCH_COMMAND} in the prototype and rebuild${convenienceLanesEnabled() ? ', or the owner can opt the cabinet into the CDN (CONVENIENCE)' : ''}.` };
  }
  if (why === 'unreachable') return { title: 'THE EMULATOR FILES ARE UNREACHABLE', hint: 'The station answered with an error. Try again in a moment.' };
  if (why === 'frame') return { title: 'THE ARCADE FRAME DID NOT LOAD', hint: 'public/arcade/frame.html is missing from this build.' };
  if (why === 'barred') return { title: 'THE EMULATOR FRAME TRIED TO LEAVE THE CABINET', hint: 'The frame asked for another page. The cabinet\'s policy refused it before any request went out, and the frame was torn down. RETRY reloads it.' };
  if (why === 'navigated') return { title: 'THE EMULATOR FRAME LEFT THE CABINET', hint: 'The frame loaded a second document — its own page again, the only one the cabinet\'s policy allows — so it was torn down. RETRY reloads it.' };
  if (why === 'flood') return { title: 'THE EMULATOR FRAME WOULD NOT STOP TALKING', hint: `The frame posted more than ${FRAME_MESSAGE_BUDGET} messages in a second, which no game needs, so it was torn down. RETRY reloads it.` };
  if (why === 'malformed') return { title: 'THE EMULATOR FRAME SPOKE OUT OF TURN', hint: 'The frame posted a message the cabinet does not know, or one larger than any it takes, which no game needs, so it was torn down. RETRY reloads it.' };
  if (why === 'game') return { title: 'THE GAME DID NOT LOAD', hint: 'The link may be blocked by CORS, the file may not be for this core, or the romset name may not match.' };
  return { title: 'THE CABINET FAULTED', hint: why };
}

// ── The player's own files ───────────────────────────────────────────────────

/** Games whose bytes live on this player's disk (url ''), keyed by gameId:
 *  the owner's pick when they put it on, or the copy another P1 brought.
 *  Page memory only — a File cannot travel in the doc (the blob lane will). */
const localRoms = new Map<string, File>();

export function rememberLocalRom(game: ArcadeGame, file: File): void {
  localRoms.set(gameId(game), file);
}

export function localRomFor(game: ArcadeGame): File | null {
  return localRoms.get(gameId(game)) ?? null;
}

/** The player's consent to hand their own file to engine code from another
 *  origin (the CDN lane). The frame's sandbox keeps that code off this page,
 *  its storage and its DOM — but a File posted into the frame is readable
 *  by whatever runs there, and that code can send it anywhere. So under
 *  the CDN lane a file from the player's disk goes into the frame only
 *  after the player said so, per game and per engine path, for this page's
 *  life. The station's own files are the station's own code: nothing to
 *  consent to. */
const exposedRoms = new Set<string>();
const exposureKey = (game: ArcadeGame, pathToData: string): string => `${pathToData}|${gameId(game)}`;
export function localRomExposureAllowed(
  game: ArcadeGame,
  pathToData: string,
  origin = typeof location === 'undefined' ? '' : location.origin,
): boolean {
  return !emulatorIsolated(pathToData, origin) || exposedRoms.has(exposureKey(game, pathToData));
}
export function allowLocalRomExposure(game: ArcadeGame, pathToData: string): void {
  exposedRoms.add(exposureKey(game, pathToData));
}

/** The accept list for a ROM file input: every extension a core here takes. */
export function romAcceptList(): string {
  return ARCADE_CORES.flatMap((c) => c.exts.map((e) => `.${e}`)).join(',');
}
