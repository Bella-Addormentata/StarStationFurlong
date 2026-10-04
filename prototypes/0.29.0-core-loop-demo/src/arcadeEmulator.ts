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

import { gameId, ARCADE_CORES } from './arcadeDoc';
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
  | { type: 'error'; why: string };

export interface EmulatorHandle {
  /** The wall in the stage: this page's own document around the frame. */
  readonly wall: HTMLIFrameElement;
  /** The emulator's frame inside the wall, once the wall is up. */
  emulator(): HTMLIFrameElement | null;
  focus(): void;
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
  const onMessage = (e: MessageEvent) => {
    if (!alive || !frame || e.source !== frame.contentWindow) return;
    const d = e.data as { type?: unknown; why?: unknown } | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    switch (d.type) {
      case 'arcade-frame-ready':
        if (configured) return;
        configured = true;
        onEvent({ type: 'frame-ready' });
        frame.contentWindow?.postMessage({
          type: 'arcade-config',
          core: config.core,
          game: config.game,
          gameName: config.gameName,
          pathToData: config.pathToData,
          // The origins the frame's policy admits beyond its own — set by
          // the frame on receipt, before its loader loads, on every lane.
          allow: emulatorFrameOrigins(config),
          volume: config.volume,
          isolated: config.isolated,
          timeoutMs: EMULATOR_LOAD_TIMEOUT_MS,
        }, target);
        break;
      case 'arcade-ready': onEvent({ type: 'ready' }); break;
      case 'arcade-started': onEvent({ type: 'started' }); break;
      case 'arcade-exit': onEvent({ type: 'exit' }); break;
      case 'arcade-error': onEvent({ type: 'error', why: typeof d.why === 'string' ? d.why : 'unknown' }); break;
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
