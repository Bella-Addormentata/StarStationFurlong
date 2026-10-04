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
 * The emulator's own files come from one of two places, the owner's call
 * per cabinet (arcadeDoc's `data`): THIS STATION's /emulatorjs/data/ —
 * fetched by scripts/fetch-emulatorjs.mjs, never vendored (size), the
 * SOVEREIGN lane — or cdn.emulatorjs.org, the CONVENIENCE lane, which a
 * build offers only with the convenience lanes on (sovereignty.ts; off by
 * default: serverless sources only). Neither is bundled, so a fresh
 * checkout shows NOT PROVISIONED with the command, not a blank screen:
 * probeEmulatorData looks before the frame mounts. On the station lane the
 * frame is also handed a content-security policy (emulatorFrameUrl →
 * frame.html): its code reaches this origin and the viewer's own node,
 * nothing else. An opaque origin's fetches carry `Origin: null`, so the
 * station serves /emulatorjs/ with Access-Control-Allow-Origin
 * (vite.config.ts for the dev and preview servers; a deployment the same)
 * — the engine and its cores, public files, and nothing else needs it.
 *
 * DOM-free except mountEmulatorFrame; the path and probe maths are tested.
 */

import { gameId, ARCADE_CORES } from './arcadeDoc';
import type { ArcadeCore, ArcadeGame, EmulatorData } from './arcadeDoc';
import { convenienceLanesEnabled } from './sovereignty';

export const EMULATOR_CDN_DATA = 'https://cdn.emulatorjs.org/stable/data/';
export const EMULATOR_FETCH_COMMAND = 'npm run fetch:emulatorjs';
/** The frame's own budget for loader → engine → core → game. */
export const EMULATOR_LOAD_TIMEOUT_MS = 45_000;
/** How long the frame may take to say hello at all (a 404 on frame.html). */
export const EMULATOR_HELLO_TIMEOUT_MS = 15_000;

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
   *  about (localRomExposureAllowed), and which frame URL it gets. */
  isolated: boolean;
  /** Origins beyond the frame's own that its policy lets it fetch from —
   *  the viewer's own node (tvConsent's own media origins). Station lane
   *  only: the CDN lane's engine comes from the CDN's own origin. */
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

/** The frame's URL for a config. On the station lane the frame is told so,
 *  with the origins its content-security policy may fetch from beyond the
 *  station's own — the viewer's own node — reduced to http(s) origins here
 *  (frame.html checks them again before they enter its policy). The
 *  isolated lane (the CDN, lanes on only) gets the plain URL: its engine
 *  comes from the CDN's origin, and the sandbox, which every lane has, is
 *  its wall. */
export function emulatorFrameUrl(config: Pick<EmulatorConfig, 'isolated' | 'allowOrigins'>, frameUrl = arcadeFrameUrl()): string {
  if (config.isolated) return frameUrl;
  const allow = new Set<string>();
  for (const o of config.allowOrigins) {
    let origin = '';
    try {
      origin = new URL(o).origin;
    } catch { /* not a URL: not an origin */ }
    if (CSP_ORIGIN.test(origin)) allow.add(origin);
  }
  const sep = frameUrl.includes('?') ? '&' : '?';
  return `${frameUrl}${sep}lane=station&allow=${encodeURIComponent([...allow].join(' '))}`;
}

export type EmulatorEvent =
  | { type: 'frame-ready' }
  | { type: 'ready' }
  | { type: 'started' }
  | { type: 'exit' }
  | { type: 'error'; why: string };

export interface EmulatorHandle {
  readonly iframe: HTMLIFrameElement;
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
 *  forbids is the frame navigating ITSELF: mountEmulatorFrame tears it
 *  down at its second load, so one URL's worth is the residual. */
export const EMULATOR_SANDBOX = 'allow-scripts allow-pointer-lock';

/** The parent side of the frame protocol: the frame says hello, the parent
 *  answers with the config, the frame reports ready / started / exit /
 *  error. Messages are matched to THIS frame's window, nothing else. */
export function mountEmulatorFrame(
  host: HTMLElement,
  config: EmulatorConfig,
  onEvent: (ev: EmulatorEvent) => void,
  frameUrl = arcadeFrameUrl(),
): EmulatorHandle {
  const iframe = document.createElement('iframe');
  iframe.className = 'arcade-frame';
  iframe.setAttribute('allow', 'gamepad *; autoplay *; fullscreen *');
  iframe.setAttribute('title', `Furlong Arcade — ${config.gameName}`);
  // An opaque origin, every lane (the header): the code inside — the
  // station's engine or the CDN's, and whatever a ROM makes of a core —
  // cannot read this page, its storage or its DOM, and the desktop shells'
  // IPC is not its to call. Only messages cross, matched to this frame's
  // window below.
  iframe.setAttribute('sandbox', EMULATOR_SANDBOX);
  iframe.src = emulatorFrameUrl(config, frameUrl);
  let alive = true;
  let configured = false;
  // An opaque origin has no name a target could match: '*' is the only
  // target that reaches it. What bounds who hears the config is the window
  // it is posted to — this frame's, which the sandbox lets navigate nothing
  // but itself — and the config carries the game's bytes, which were the
  // frame's to have, and nothing of this page's.
  const target = '*';
  const onMessage = (e: MessageEvent) => {
    if (!alive || e.source !== iframe.contentWindow) return;
    const d = e.data as { type?: unknown; why?: unknown } | null;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return;
    switch (d.type) {
      case 'arcade-frame-ready':
        if (configured) return;
        configured = true;
        onEvent({ type: 'frame-ready' });
        iframe.contentWindow?.postMessage({
          type: 'arcade-config',
          core: config.core,
          game: config.game,
          gameName: config.gameName,
          pathToData: config.pathToData,
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
  window.addEventListener('message', onMessage);
  // A frame that loads a SECOND document has navigated itself away — the
  // one request no sandbox flag forbids (EMULATOR_SANDBOX) — and comes
  // down. The first load is frame.html's own: with src set before the
  // frame is inserted, no load event is fired for the initial about:blank
  // (the HTML standard's iframe load steps), so the count is the test.
  let loads = 0;
  const onLoad = () => {
    loads += 1;
    if (alive && loads > 1) onEvent({ type: 'error', why: 'navigated' });
  };
  iframe.addEventListener('load', onLoad);
  const hello = window.setTimeout(() => {
    if (alive && !configured) onEvent({ type: 'error', why: 'frame' });
  }, EMULATOR_HELLO_TIMEOUT_MS);
  host.appendChild(iframe);
  return {
    iframe,
    focus() {
      try {
        iframe.contentWindow?.focus();
        iframe.focus();
      } catch { /* detached */ }
    },
    destroy() {
      alive = false;
      window.clearTimeout(hello);
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onLoad);
      iframe.remove();
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
  if (why === 'navigated') return { title: 'THE EMULATOR FRAME LEFT THE CABINET', hint: 'The frame navigated away from the emulator, so it was torn down. RETRY reloads it.' };
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
