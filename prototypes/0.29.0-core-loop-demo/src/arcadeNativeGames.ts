/**
 * 🕹🕹 The arcade's OWN games: written for SSF in TypeScript, not ROMs, so
 * they draw straight onto a cabinet's screen at whatever shape it is (the
 * double-wide cabinet's two tubes make one 8:3 screen) and seat as many
 * players as the cabinet has panels. Each is a pure, deterministic game
 * (create, step on the pads, fingerprint, restore from a save) and a
 * painter; arcadeNativeSession.ts runs it for the room the way
 * arcadeNesSession.ts runs a ROM: only pad bytes travel.
 *
 * They are the app's own code, under the app's licence, so the cabinet's
 * credits pages (the bundled ROMs' licences) don't list them.
 */

import {
  LR_REV, LR_SEATS, LR_VIEW_H, LR_VIEW_W, checkLanternRoad, createLanternRoad, restoreLanternRoad, stepLanternRoad,
  type LrState,
} from './games/lanternRoad';
import { paintLanternRoad, paintLanternRoadScores, paintLanternRoadTitle } from './lanternRoadPaint';

/** What the session lays over a game's own picture. */
export interface NativeHud {
  /** The best score on the cabinet's table for this game (0: none yet). */
  hi: number;
}

/** A line of the cabinet's high-score table, as the attract screen shows it. */
export interface NativeBoardLine {
  name: string;
  score: number;
}

export interface NativeGame<S = unknown> {
  /** Stable id: what a cabinet's record names (arcadeDoc `bundled`). */
  id: string;
  /** The rules' revision: a match names its game by both (nativeMatchGame). */
  rev: number;
  title: string;
  /** One line for the cabinet menu: what you do. */
  blurb: string;
  /** One line for the cabinet menu: which buttons. */
  controls: string;
  /** Seats: one per control panel it is played from. */
  seats: number;
  /** The picture in game pixels: the tube draws a scanline per row. */
  lines: readonly [number, number];
  /** The game at its first frame. Every copy gets the same seed. */
  create(seed: number): S;
  /** One frame on every seat's pad (seat 0 first). Mutates the state. */
  step(state: S, pads: readonly number[]): void;
  /** A 6-bit fingerprint: copies in step compare these. */
  check(state: S): number;
  /** A save state as a peer sent it (JSON), or null if it isn't one. */
  restore(raw: unknown): S | null;
  /** Each seat's score now, or null once nobody plays it (the seat's PRESENT
   *  bit out a while): the host enters them on the cabinet's high scores,
   *  and holds a newcomer's pad back until the seat's last player is gone. */
  scores(state: S): ReadonlyArray<number | null>;
  /** Draw the state onto the screen canvas, `w`×`h`. */
  paint(ctx: CanvasRenderingContext2D, state: S, w: number, h: number, hud?: NativeHud): void;
  /** The idle cabinet: the title, and `line` while `blink` is on. */
  paintTitle(ctx: CanvasRenderingContext2D, line: string, blink: boolean, w: number, h: number): void;
  /** The idle cabinet's other page: the high-score table, best first. */
  paintScores(
    ctx: CanvasRenderingContext2D, board: readonly NativeBoardLine[], line: string, blink: boolean, w: number, h: number,
  ): void;
}

const LANTERN_ROAD: NativeGame<LrState> = {
  id: 'lantern-road',
  rev: LR_REV,
  title: 'LANTERN ROAD',
  blurb: 'Up to four friends walk the night street to the shrine.',
  controls: 'WASD/ARROWS WALK · M/X JUMP · N/Z STAFF · DOWN+JUMP DROP',
  seats: LR_SEATS,
  lines: [LR_VIEW_W, LR_VIEW_H],
  create: createLanternRoad,
  step: stepLanternRoad,
  check: checkLanternRoad,
  restore: restoreLanternRoad,
  scores: (s) => s.players.map((p) => (p.on ? p.score : null)),
  paint: paintLanternRoad,
  paintTitle: paintLanternRoadTitle,
  paintScores: paintLanternRoadScores,
};

export const NATIVE_GAMES: readonly NativeGame[] = [LANTERN_ROAD as unknown as NativeGame];

export function nativeGameById(id: string | null | undefined): NativeGame | null {
  return (id && NATIVE_GAMES.find((g) => g.id === id)) || null;
}

/** What a match record names its game by: the id and the rules' revision.
 *  A page on another revision (an old tab, or one that loaded an update)
 *  can't run the same frames or load the host's saves, so it never follows
 *  or takes a seat in that match: to it, the cabinet is free. */
export const nativeMatchGame = (game: NativeGame): string => `${game.id}@${game.rev}`;

/** The game a match record names, if this page runs that revision of it. */
export function nativeGameForMatch(name: string): NativeGame | null {
  return NATIVE_GAMES.find((g) => nativeMatchGame(g) === name) ?? null;
}

/** Pad bit the session sets on every seat somebody holds (SELECT's bit:
 *  a native game never reads SELECT as a button). */
export const NATIVE_PRESENT = 1 << 2;
