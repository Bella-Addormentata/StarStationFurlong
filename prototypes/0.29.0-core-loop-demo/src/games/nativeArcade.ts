/**
 * 🕹🕹 A cabinet's OWN game in the room doc (the `games` map, gamesDoc.ts):
 * the records for a game written for the double-wide cabinet itself
 * (arcadeNativeGames.ts), not a ROM. Pure: what the records hold and the
 * checks on them; arcadeNativeSession.ts does the reading and writing.
 *
 * The NES games' records (games/arcade.ts) seat two players in one record.
 * Four players can't share one: every key is last-writer-wins, so three
 * guests taking seats at once would write over each other. So each seat is
 * its own key, written by the page that takes it, and the match record is
 * the host's alone:
 *
 *   <cabinet>                   → NativeMatch     the host's: game, seed, seat
 *   <cabinet>#native-seat-<n>   → NativeSeat      a guest's, seats 0–3
 *   <cabinet>#native-snapshot   → NativeSnapshot  the host's latest save
 *
 * A seat names the match it was taken in by its host page and start time
 * (not its id, which can change mid-match when two cabinets draw the same
 * one): a seat left over from an earlier match counts for nothing.
 *
 * The game itself never touches the doc: its pads ride the tick lane
 * (arcadeNet.ts, the native wire).
 */

import { MAX_SNAPSHOT_BYTES, randomU16 } from './arcade';

export interface NativeMatch {
  kind: 'arcade-native';
  /** Tags this match's ticks: 1–65535. */
  id: number;
  /** The game's own seed: every copy starts from the same state. */
  seed: number;
  /** The game and its rules' revision (arcadeNativeGames nativeMatchGame). */
  game: string;
  /** The host's player id, and the page running the reference copy. */
  host: string;
  hostPage: string;
  /** The seat the host plays (0 = player 1). */
  hostSeat: number;
  startedAt: number;
}

export interface NativeSeat {
  kind: 'arcade-native-seat';
  /** The match it was taken in: its host page and start time. */
  hostPage: string;
  startedAt: number;
  player: string;
  page: string;
  /** The guest's ticks carry this, so a stale page can't drive the seat.
   *  Its low two bits are the seat (seatToken): two seats never share one. */
  token: number;
}

export interface NativeSnapshot {
  kind: 'arcade-native-snapshot';
  id: number;
  /** The u16 frame the state continues at (the next frame to run). */
  next: number;
  data: Uint8Array;
}

/** The most seats a cabinet's own game has. */
export const NATIVE_MAX_SEATS = 4;

export const nativeSeatKey = (cabinetId: string, seat: number): string => `${cabinetId}#native-seat-${seat}`;
export const nativeSnapshotKey = (cabinetId: string): string => `${cabinetId}#native-snapshot`;

const isU16 = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 0xffff;
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isSeat = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) < NATIVE_MAX_SEATS;

export function isNativeMatch(v: unknown): v is NativeMatch {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return m.kind === 'arcade-native'
    && isU16(m.id) && m.id !== 0
    && Number.isInteger(m.seed) && Math.abs(m.seed as number) <= 0x7fffffff
    && isStr(m.game) && isStr(m.host) && isStr(m.hostPage)
    && isSeat(m.hostSeat) && isTime(m.startedAt);
}

export function isNativeSeat(v: unknown): v is NativeSeat {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return s.kind === 'arcade-native-seat'
    && isStr(s.hostPage) && isTime(s.startedAt) && isStr(s.player) && isStr(s.page)
    && isU16(s.token) && s.token !== 0;
}

export function isNativeSnapshot(v: unknown): v is NativeSnapshot {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return s.kind === 'arcade-native-snapshot'
    && isU16(s.id) && s.id !== 0
    && isU16(s.next)
    && s.data instanceof Uint8Array && s.data.byteLength > 0 && s.data.byteLength <= MAX_SNAPSHOT_BYTES;
}

/** Was this seat taken in this match (not an earlier one on the cabinet)? */
export function seatIsFor(seat: NativeSeat, m: NativeMatch): boolean {
  return seat.hostPage === m.hostPage && seat.startedAt === m.startedAt;
}

export function newNativeMatch(args: {
  id: number;
  game: string;
  host: string;
  hostPage: string;
  hostSeat: number;
  now: number;
  random?: () => number;
}): NativeMatch {
  const random = args.random ?? Math.random;
  return {
    kind: 'arcade-native',
    id: args.id,
    seed: Math.floor(random() * 0x7fffffff),
    game: args.game,
    host: args.host,
    hostPage: args.hostPage,
    hostSeat: Math.max(0, Math.min(NATIVE_MAX_SEATS - 1, Math.floor(args.hostSeat))),
    startedAt: args.now,
  };
}

/** A fresh token for seat `seat`: random above, the seat in the low two
 *  bits, so a guest's tick names its seat and no two seats' tokens match. */
export function seatToken(seat: number, random: () => number = Math.random): number {
  return ((randomU16(random) & 0x3fff || 1) << 2) | (seat & (NATIVE_MAX_SEATS - 1));
}

/** The seat a guest's token names. */
export const tokenSeat = (token: number): number => token & (NATIVE_MAX_SEATS - 1);

/** A guest's seat `seat` in `m`, with a fresh token. */
export function newNativeSeat(m: NativeMatch, seat: number, player: string, page: string, random?: () => number): NativeSeat {
  return {
    kind: 'arcade-native-seat', hostPage: m.hostPage, startedAt: m.startedAt, player, page, token: seatToken(seat, random),
  };
}
