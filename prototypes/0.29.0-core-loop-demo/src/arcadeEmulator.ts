/**
 * 🕹 arcadeEmulator — the seam between the cabinet and EmulatorJS (#193).
 *
 * EmulatorJS (libretro cores in WASM, GPL-3.0) configures itself from
 * globals, is loaded by ITS loader script, and has no clean teardown — so
 * it runs in a same-origin IFRAME of our own (public/arcade/frame.html).
 * Closing the cabinet removes the frame: a complete teardown, every time.
 * Keys typed into the focused frame never reach the world's input (an
 * event does not cross a frame), which is how WASD stays suppressed while
 * at the controls. The frame is same-origin, so the emulator's canvas stays
 * reachable for the spectator lane later (plan §9).
 *
 * The emulator's own files come from one of two places, the owner's call
 * per cabinet (arcadeDoc's `data`): THIS STATION's /emulatorjs/data/ —
 * fetched by scripts/fetch-emulatorjs.mjs, never vendored (size), the
 * SOVEREIGN lane — or cdn.emulatorjs.org, the CONVENIENCE lane. Neither is
 * bundled, so a fresh checkout shows NOT PROVISIONED with the command, not
 * a blank screen: probeEmulatorData looks before the frame mounts.
 *
 * DOM-free except mountEmulatorFrame; the path and probe maths are tested.
 */

import { gameId, ARCADE_CORES } from './arcadeDoc';
import type { ArcadeCore, ArcadeGame, EmulatorData } from './arcadeDoc';

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
  /** An http(s) URL, or '' with `file` set (the player's own disk). */
  gameUrl: string;
  file: File | null;
  /** The file's name — arcade cores need the romset's name. */
  gameName: string;
  pathToData: string;
  /** 0–1. */
  volume: number;
  /** Engine code from another origin (the CDN lane) runs in a sandboxed
   *  frame with an OPAQUE origin: it may run scripts, but it never touches
   *  the app's origin, its storage or the parent page. The station's own
   *  files are trusted and keep the same origin (so the canvas stays
   *  reachable for the spectator lane). */
  isolated: boolean;
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
  /** The emulator's canvas inside the frame (same origin), once it runs. */
  canvas(): HTMLCanvasElement | null;
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
  const iframe = document.createElement('iframe');
  iframe.className = 'arcade-frame';
  iframe.setAttribute('allow', 'gamepad *; autoplay *; fullscreen *');
  iframe.setAttribute('title', `Furlong Arcade — ${config.gameName}`);
  // The CDN lane: no allow-same-origin, so the frame is an opaque origin —
  // CDN code runs, and cannot read this page, its storage or its DOM. Only
  // messages cross (and they are matched to this frame's window below).
  if (config.isolated) iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-pointer-lock allow-popups');
  iframe.src = frameUrl;
  let alive = true;
  let configured = false;
  const origin = window.location.origin;
  // An opaque-origin frame can only be addressed with '*' (its origin reads "null").
  const target = !config.isolated && origin && origin !== 'null' ? origin : '*';
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
          gameUrl: config.gameUrl,
          file: config.file,
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
      iframe.remove();
    },
    canvas() {
      try {
        return iframe.contentDocument?.querySelector('canvas') ?? null;
      } catch {
        return null;
      }
    },
  };
}

/** What the stage tells the player for each failure the frame (or the
 *  probe) reports. */
export function emulatorErrorText(why: string, data: EmulatorData): { title: string; hint: string } {
  if (why === 'loader' || why === 'timeout') {
    return data === 'cdn'
      ? { title: 'CDN.EMULATORJS.ORG DID NOT ANSWER', hint: 'The CONVENIENCE lane is down or blocked here. The owner can switch the cabinet to THIS STATION after fetching the files.' }
      : { title: 'EMULATOR FILES NOT PROVISIONED', hint: `This station has no /emulatorjs/ yet. Run ${EMULATOR_FETCH_COMMAND} in the prototype and rebuild, or the owner can opt the cabinet into the CDN (CONVENIENCE).` };
  }
  if (why === 'unreachable') return { title: 'THE EMULATOR FILES ARE UNREACHABLE', hint: 'The station answered with an error. Try again in a moment.' };
  if (why === 'frame') return { title: 'THE ARCADE FRAME DID NOT LOAD', hint: 'public/arcade/frame.html is missing from this build.' };
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
 *  life. The station's own files run with the app and need no consent. */
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
