/**
 * 🕹️ The standby pictures (#333): each bundled game's own title screen and
 * menu as a picture (public/arcade/standby, written and pinned by
 * arcadeStandby.test.ts), so a cabinet shows its game's standby screen —
 * idle, and when a player steps up — without loading the game. A game
 * started there carries on from that very frame (arcadeNesSession runs every
 * copy to it first), so the picture comes to life where it stands.
 *
 * The page fetches a game's picture the first time something asks for it,
 * once; until it arrives (or where there is no Image, as in the tests)
 * askers get null and draw what they drew before. The sign above the screen
 * takes the game's logo from the same picture (arcadeSigns.ts).
 */

import { ARCADE_GAMES } from './arcadeLibrary';
import { ARCADE_SIGNS } from './arcadeSigns';

/** A picture that failed to load is asked for again after this long. */
const RETRY_MS = 30_000;

interface Entry {
  image: HTMLImageElement;
  ready: boolean;
  failedAt: number | null;
  /** The sign's logo, cut out once the picture is here (null: none). */
  logo: HTMLCanvasElement | null | undefined;
  waiting: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryFor(gameId: string | null | undefined): Entry | null {
  const game = gameId ? ARCADE_GAMES.find((g) => g.id === gameId) : undefined;
  if (!game || typeof Image === 'undefined') return null;
  const old = entries.get(game.id);
  if (old && (old.failedAt === null || Date.now() - old.failedAt < RETRY_MS)) return old;
  // None yet, or one that failed and is due another try (who waited on it
  // still waits).
  const image = new Image();
  const entry: Entry = { image, ready: false, failedAt: null, logo: undefined, waiting: old?.waiting ?? new Set() };
  image.decoding = 'async';
  image.onload = () => {
    entry.ready = true;
    const waiting = [...entry.waiting];
    entry.waiting.clear();
    for (const fn of waiting) fn();
  };
  image.onerror = () => {
    entry.failedAt = Date.now();
  };
  image.src = game.standbyUrl;
  entries.set(game.id, entry);
  return entry;
}

/** A bundled game's standby picture (256×240), or null: not one of the
 *  bundled games, or not here yet (the first ask fetches it). */
export function standbyPicture(gameId: string | null | undefined): HTMLImageElement | null {
  const entry = entryFor(gameId);
  return entry?.ready ? entry.image : null;
}

/**
 * Call `fn` once when `gameId`'s picture arrives (asking for it starts the
 * fetch). Not at all for a game with no picture, or one already here: the
 * asker paints it now. Returns a function that stops waiting.
 */
export function whenStandbyArrives(gameId: string | null | undefined, fn: () => void): () => void {
  const entry = entryFor(gameId);
  if (!entry || entry.ready) return () => undefined;
  entry.waiting.add(fn);
  return () => entry.waiting.delete(fn);
}

/** The game's logo for its sign, cut from its standby picture with the
 *  title screen's backdrop made clear (arcadeSigns: `logo`), or null. */
export function standbyLogo(gameId: string | null | undefined): CanvasImageSource | null {
  const rect = gameId ? ARCADE_SIGNS[gameId]?.logo : undefined;
  const entry = rect ? entryFor(gameId) : null;
  if (!rect || !entry?.ready) return null;
  if (entry.logo === undefined) entry.logo = cutLogo(entry.image, rect);
  return entry.logo;
}

function cutLogo(image: HTMLImageElement, [x, y, w, h]: readonly [number, number, number, number]): HTMLCanvasElement | null {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return null;
    g.drawImage(image, x, y, w, h, 0, 0, w, h);
    const pixels = g.getImageData(0, 0, w, h);
    const d = pixels.data;
    const [r, gr, b] = [d[0], d[1], d[2]];
    for (let i = 0; i < d.length; i += 4) if (d[i] === r && d[i + 1] === gr && d[i + 2] === b) d[i + 3] = 0;
    g.putImageData(pixels, 0, 0);
    return canvas;
  } catch {
    return null; // a canvas the page may not read: the sign writes the name
  }
}
