/**
 * 🕹🕹 Native arcade session — the LIVE layer for a cabinet's OWN game
 * (arcadeNativeGames.ts: Lantern Road on the double-wide cabinet), between
 * the game, the tick wire (arcadeNet.ts, the native wire), the room doc
 * (games/nativeArcade.ts via gamesDoc.ts) and the cabinet's screen.
 *
 * The same shape as the NES games' session (arcadeNesSession.ts), with four
 * seats instead of two:
 *
 *  - the HOST's page (whoever started the game) runs the reference copy on
 *    its own clock. Each frame it takes its own pad and each guest's (from
 *    their ticks), runs the frame, and sends the four pads to the room: two
 *    FRAMES ticks, players 1–2 and players 3–4;
 *  - every other page FOLLOWS: it runs the same frames with the same pads,
 *    a few frames behind, and paints them on its cabinet. A guest is a
 *    follower that also sends its pad to the host, from the seat it holds.
 *
 * A seat is held by its own doc key, written by the page that takes it (a
 * stand at the cabinet is a seat: s0 is player 1). The host drops a seat
 * whose page has gone quiet. Whether a seat is held is part of every frame
 * (the PRESENT bit on its pad), so every copy agrees on who is in the game.
 *
 * A follower that starts late or loses its place asks for a SAVE STATE (a
 * sync tick); the host writes the game's state, deflated JSON of a few KB,
 * into the doc, and the follower continues from it with the pads it has
 * been collecting. Copies fingerprint the state every 32 frames, and one
 * that disagrees with the host's asks for a save state too.
 *
 * HIGH SCORES: the host follows each player's go off the game's scores and
 * enters it on the cabinet's table (arcadeDoc `scores:`) when the player
 * steps away, when the game ends, and every SCORES_EVERY_MS meanwhile. A go
 * lasts as long as its player is on the road, so the points from the moment
 * after they let go of the seat count too; someone who takes the seat in
 * that moment waits it out (their pad held back) and starts their own go.
 *
 * The cabinet's screen: the game while one runs, with the cabinet's best
 * score; while none does, the game's own title, taking turns with the
 * high-score table (the cabinet's game is a native one: the reader World
 * installs says so); and the screen is handed back (showAttract) the moment
 * the cabinet's game is something else.
 */

import {
  NATIVE_PRESENT, nativeGameById, nativeGameForMatch, nativeMatchGame, type NativeGame,
} from './arcadeNativeGames';
import {
  ARCADE_WIRE_NATIVE, GuestPad, PadLog, PadRuns, frameAdd, frameDiff, packArcadeTick, pipe, unpackArcadeTick,
  type ArcadeTick,
} from './arcadeNet';
import type { ArcadeLink, SharedPhase, SharedView } from './arcadeNesSession';
import { freshMatchId, randomU16 } from './games/arcade';
import { readHighScores, recordHighScores, type HighScore } from './arcadeDoc';
import {
  readNativeArcade, readNativeArcadeMatches, readNativeSeat, readNativeSnapshot, readPlayerDisplayName, writeNativeArcade,
  writeNativeSeat, writeNativeSnapshot,
} from './games/gamesDoc';
import {
  NATIVE_MAX_SEATS, newNativeMatch, newNativeSeat, seatIsFor, tokenSeat, type NativeMatch, type NativeSeat,
} from './games/nativeArcade';
import { casinoDocEpoch } from './casinoDoc';
import { getPlayerId } from './identity';
import type { ArcadeCabinetVisualHandle } from './devices';

// ── Tunables (arcadeNesSession's, for the same reasons) ──────────────────────

const FPS = 60;
const FRAME_S = 1 / FPS;
const HOST_STEP_MAX = 3;
const CATCH_UP_MAX = 8;
const CATCH_UP_LEAD = 4;
const CHECK_EVERY = 32;
const SYNC_ASK_EVERY_MS = 1500;
const STALL_SYNC_MS = 1000;
const HOST_SILENT_MS = 4000;
const HOST_GONE_MS = 12000;
const FIRST_FRAME_WITHIN_MS = 10 * 60 * 1000;
const GUEST_SILENT_MS = 2000;
const GUEST_GONE_MS = 6000;
const SNAPSHOT_MIN_GAP_MS = 1000;
const GUEST_HEARTBEAT = 4;
const PAINT_NEAR_M = 3.5;
const PAINT_MID_M = 8;
/** The title's PRESS START blinks this often. */
const TITLE_BLINK_MS = 500;
/** The idle cabinet's two pages: the title this long, then the high scores
 *  (once there are any) for the rest of the cycle. */
const ATTRACT_TITLE_MS = 8000;
const ATTRACT_CYCLE_MS = 13000;
/** The host enters the goes still being played this often too, so a host
 *  page that closes mid-game loses no more than this of anyone's score. */
const SCORES_EVERY_MS = 15000;
/** How often a cabinet rereads its high scores for the screen. */
const BOARD_READ_MS = 500;
/** The most JSON a save state may inflate to. */
const MAX_STATE_JSON_BYTES = 1024 * 1024;

// ── This page ────────────────────────────────────────────────────────────────

const PAGE = mintPage();

function mintPage(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function nativeArcadePage(): string {
  return PAGE;
}

let sendTickBuf: ((buf: Uint8Array) => void) | null = null;

/** Outbound datagram seam: main.ts wires NetworkProvider.sendTick here. */
export function setNativeArcadeSender(fn: ((buf: Uint8Array) => void) | null): void {
  sendTickBuf = fn;
}

/** Which native game a cabinet is set up for (World installs the reader:
 *  the double-wide cabinet's game, if it is one of ours), else null. */
let cabinetGame: (itemId: string) => string | null = () => null;
/** Goes this page has hosted: each one's run id ends with its count. */
let goCount = 0;

export function setNativeCabinetGameReader(fn: ((itemId: string) => string | null) | null): void {
  cabinetGame = fn ?? (() => null);
}

const send = (t: ArcadeTick): void => {
  sendTickBuf?.(packArcadeTick(t, ARCADE_WIRE_NATIVE));
};

// ── Per-cabinet runtime ──────────────────────────────────────────────────────

/** Host: one player's go at a seat, for the cabinet's high scores. */
interface Go {
  run: string;
  /** Whose go it is: the game's player at the seat is theirs until it
   *  leaves the road, whoever holds the seat meanwhile. */
  player: string;
  name: string;
  score: number;
  /** The score last entered on the table. */
  entered: number;
}

/** This page's copy of one match. */
interface Copy {
  matchId: number;
  hostPage: string;
  startedAt: number;
  game: NativeGame;
  role: 'host' | 'follow';
  state: unknown;
  started: boolean;
  /** The u16 frame it runs next. */
  next: number;
  acc: number;
  createdAt: number;
  ranNow: number;
  // Host
  lo: PadRuns;
  hi: PadRuns;
  guestPads: GuestPad[];
  /** The token each seat's GuestPad belongs to (0: nobody there). */
  guestTokens: number[];
  lastGuestAt: number[];
  syncAsked: boolean;
  snapshotBusy: boolean;
  lastSnapshotAt: number;
  latestCheck: number;
  sendToggle: boolean;
  /** Each seat's go now (null: nobody plays it), and when they were last
   *  all entered on the high scores. */
  goes: Array<Go | null>;
  goesEnteredAt: number;
  // Follower
  logLo: PadLog;
  logHi: PadLog;
  hostLane: string | null;
  lastFramesAt: number;
  stalledSince: number | null;
  needSync: boolean;
  syncFrom: number | null;
  lastSyncAskAt: number;
  restoring: boolean;
  triedSnapshot: Uint8Array | null;
  hostChecks: Map<number, number>;
  myChecks: Map<number, number>;
  // A guest's outgoing pad
  guestFor: number;
  guestCur: number;
  guestPrev: number;
  guestChanges: number;
  guestSeq: number;
  guestBeat: number;
}

interface LinkState {
  buttons: number;
  uiScreen: boolean;
  error: string | null;
}

interface CabinetSession {
  handle: ArcadeCabinetVisualHandle;
  pos: { x: number; z: number };
  docEpoch: number;
  bornAt: number;
  copy: Copy | null;
  link: LinkState | null;
  paintCount: number;
  /** What the cabinet shows now ('released': whatever else paints it). */
  shown: string | null;
  /** This session's picture (or its cabinet UI's) is on the screen, and the
   *  screen goes back (showAttract) when the cabinet stops being ours. Kept
   *  apart from `shown`, which a new copy or match resets. */
  holds: boolean;
  /** The cabinet's high scores for the game on screen, as last read. */
  board: { at: number; game: string; lines: HighScore[] } | null;
}

const sessions = new Map<string, CabinetSession>();

/** Register (or re-register after a rebuild) a built cabinet's screen. */
export function registerNativeArcadeVisual(itemId: string, handle: ArcadeCabinetVisualHandle, pos: { x: number; z: number }): void {
  const existing = sessions.get(itemId);
  if (existing && existing.docEpoch === casinoDocEpoch()) {
    if (existing.handle !== handle) existing.holds = false;
    existing.handle = handle;
    existing.pos = pos;
    existing.shown = null;
    return;
  }
  sessions.set(itemId, freshSession(handle, pos));
}

function freshSession(handle: ArcadeCabinetVisualHandle, pos: { x: number; z: number }): CabinetSession {
  return {
    handle, pos, docEpoch: casinoDocEpoch(), bornAt: Date.now(), copy: null, link: null, paintCount: 0, shown: null, holds: false,
    board: null,
  };
}

function sessionFor(itemId: string): CabinetSession | null {
  const s = sessions.get(itemId);
  if (!s || s.docEpoch === casinoDocEpoch()) return s ?? null;
  const fresh = freshSession(s.handle, s.pos);
  fresh.holds = s.holds;
  sessions.set(itemId, fresh);
  return fresh;
}

const inBoundRoom = (s: CabinetSession): boolean => s.docEpoch === casinoDocEpoch();

function roomId(): string | null {
  const id = (globalThis as { __ssfRoomId?: unknown }).__ssfRoomId;
  return typeof id === 'string' ? id : null;
}

/** Drop a removed cabinet's runtime. A game this page hosts there ends. */
export function closeNativeArcadeCabinet(itemId: string): void {
  const s = sessions.get(itemId);
  if (s?.copy?.role === 'host' && readNativeArcade(itemId)?.hostPage === PAGE) writeNativeArcade(itemId, null);
  sessions.delete(itemId);
}

function newCopy(s: CabinetSession, m: NativeMatch, game: NativeGame, role: 'host' | 'follow'): Copy {
  const now = Date.now();
  const copy: Copy = {
    matchId: m.id, hostPage: m.hostPage, startedAt: m.startedAt, game, role,
    state: role === 'host' ? game.create(m.seed) : null, started: role === 'host', next: 0, acc: 0, createdAt: now, ranNow: 0,
    lo: new PadRuns(), hi: new PadRuns(),
    guestPads: Array.from({ length: NATIVE_MAX_SEATS }, () => new GuestPad()),
    guestTokens: new Array<number>(NATIVE_MAX_SEATS).fill(0),
    lastGuestAt: new Array<number>(NATIVE_MAX_SEATS).fill(0),
    syncAsked: false, snapshotBusy: false, lastSnapshotAt: 0, latestCheck: 0, sendToggle: false,
    goes: new Array<Go | null>(NATIVE_MAX_SEATS).fill(null), goesEnteredAt: now,
    logLo: new PadLog(), logHi: new PadLog(), hostLane: null, lastFramesAt: 0, stalledSince: null, needSync: false,
    syncFrom: null, lastSyncAskAt: 0, restoring: false, triedSnapshot: null, hostChecks: new Map(), myChecks: new Map(),
    guestFor: 0, guestCur: 0, guestPrev: 0, guestChanges: 0, guestSeq: 0, guestBeat: 0,
  };
  s.copy = copy;
  s.shown = null;
  return copy;
}

const isCopyOf = (copy: Copy, m: NativeMatch): boolean =>
  copy.matchId === m.id && copy.hostPage === m.hostPage && copy.startedAt === m.startedAt
  && nativeMatchGame(copy.game) === m.game;

function idsInUse(): Set<number> {
  const taken = new Set<number>();
  for (const m of readNativeArcadeMatches().values()) taken.add(m.id);
  return taken;
}

/** Two cabinets claimed one id at once: the later claim (by start time,
 *  then cabinet id) moves. Every page agrees which. */
function mustYieldId(itemId: string, m: NativeMatch): boolean {
  for (const [cabinet, other] of readNativeArcadeMatches()) {
    if (cabinet === itemId || other.id !== m.id) continue;
    if (m.startedAt !== other.startedAt ? m.startedAt > other.startedAt : itemId > cabinet) return true;
  }
  return false;
}

function hostSilentFor(s: CabinetSession, copy: Copy | null, now: number): number {
  return now - Math.max(copy?.lastFramesAt ?? 0, copy?.createdAt ?? 0, s.bornAt);
}

/** The seats held in `m` (by guests: the host's own is in the record),
 *  as the doc says. */
function seatsOf(itemId: string, m: NativeMatch): Array<NativeSeat | null> {
  const out: Array<NativeSeat | null> = [];
  for (let n = 0; n < NATIVE_MAX_SEATS; n++) {
    const seat = n === m.hostSeat || n >= nativeSeats(m) ? null : readNativeSeat(itemId, n);
    out.push(seat && seatIsFor(seat, m) && seat.page !== m.hostPage && tokenSeat(seat.token) === n ? seat : null);
  }
  return out;
}

const nativeSeats = (m: NativeMatch): number => Math.min(NATIVE_MAX_SEATS, nativeGameForMatch(m.game)?.seats ?? 0);

/** The seat this page holds in `m`, or null. */
function mySeatIn(itemId: string, m: NativeMatch): number | null {
  const seats = seatsOf(itemId, m);
  const n = seats.findIndex((seat) => seat?.page === PAGE);
  return n >= 0 ? n : null;
}

/** The cabinet's match as the doc has it, unless it was left behind for a
 *  game the cabinet no longer has (its host gone, the owner changed the
 *  game) or it runs another revision of the game than this page does:
 *  nobody here follows that one. A live host ends its own when its
 *  cabinet UI lets go. */
function matchFor(itemId: string): NativeMatch | null {
  const m = readNativeArcade(itemId);
  if (!m) return null;
  const own = nativeGameById(cabinetGame(itemId));
  return m.hostPage === PAGE || (own && nativeMatchGame(own) === m.game) ? m : null;
}

/** Bring the page's copy in line with the doc. */
function reconcile(itemId: string, s: CabinetSession, m: NativeMatch | null): void {
  const copy = s.copy;
  if (!m) {
    if (copy?.role === 'host') enterGoes(itemId, copy, Date.now(), true); // the owner's RESET
    if (copy) {
      s.copy = null;
      s.shown = null;
    }
    return;
  }
  if (copy && isCopyOf(copy, m)) return;
  if (copy?.role === 'host' && copy.hostPage === m.hostPage && copy.startedAt === m.startedAt
    && nativeMatchGame(copy.game) === m.game) {
    // Our own match under a new id (a yield): carry on.
    copy.matchId = m.id;
    return;
  }
  if (copy?.role === 'host') enterGoes(itemId, copy, Date.now(), true); // replaced
  if (m.hostPage === PAGE) {
    // A record naming this page that it no longer runs (a reload): end it.
    writeNativeArcade(itemId, null);
    return;
  }
  const game = nativeGameForMatch(m.game);
  if (!game) {
    if (copy) {
      s.copy = null;
      s.shown = null;
    }
    return;
  }
  newCopy(s, m, game, 'follow');
}

// ── Inbound ticks (main.ts, for every arcade tick) ───────────────────────────

function sessionForMatch(matchId: number): [string, CabinetSession] | null {
  for (const [itemId] of sessions) {
    const s = sessionFor(itemId)!;
    if (s.copy?.matchId === matchId) return [itemId, s];
  }
  for (const [itemId] of sessions) {
    const s = sessionFor(itemId)!;
    const m = matchFor(itemId);
    if (m?.id === matchId) {
      reconcile(itemId, s, m);
      if (s.copy?.matchId === matchId) return [itemId, s];
    }
  }
  return null;
}

/** Route one raw 13-byte arcade tick from a peer (`senderId` = its lane).
 *  Ticks of the NES wire are not this session's and are dropped here. */
export function routeNativeArcadeTick(senderId: string, bytes: Uint8Array): void {
  const t = unpackArcadeTick(bytes, ARCADE_WIRE_NATIVE);
  if (!t) return;
  const found = sessionForMatch(t.match);
  if (!found) return;
  const [itemId, s] = found;
  const copy = s.copy!;
  const now = Date.now();
  if (t.type === 'frames') {
    if (copy.role === 'host') return;
    // One host lane at a time (see arcadeNesSession: not a security
    // boundary, just a stale tab kept from fighting the host).
    if (copy.hostLane && copy.hostLane !== senderId && now - copy.lastFramesAt < HOST_SILENT_MS) return;
    copy.hostLane = senderId;
    copy.lastFramesAt = now;
    (t.half === 1 ? copy.logHi : copy.logLo).addTick(t);
    const at = (frameAdd(t.frame, 1) & ~(CHECK_EVERY - 1)) & 0xffff;
    if (at !== 0) {
      copy.hostChecks.set(at, t.check);
      compareChecks(copy, at);
    }
    return;
  }
  if (t.type === 'guest') {
    if (copy.role !== 'host') return;
    const m = readNativeArcade(itemId);
    if (!m || !isCopyOf(copy, m)) return;
    // The token names its seat: one guest's ticks never drive another's.
    const n = tokenSeat(t.token);
    if (seatsOf(itemId, m)[n]?.token !== t.token) return;
    seatGuest(copy, n, t.token, now);
    copy.guestPads[n]!.onTick(t);
    copy.lastGuestAt[n] = now;
    return;
  }
  if (copy.role === 'host') copy.syncAsked = true;
}

function compareChecks(copy: Copy, at: number): void {
  const mine = copy.myChecks.get(at);
  const theirs = copy.hostChecks.get(at);
  if (mine === undefined || theirs === undefined) return;
  if (mine !== theirs && !copy.needSync) {
    copy.needSync = true;
    copy.syncFrom = copy.next;
  }
}

function trimChecks(map: Map<number, number>, next: number): void {
  for (const at of map.keys()) if (frameDiff(next, at) > CHECK_EVERY * 8 || frameDiff(at, next) > CHECK_EVERY * 64) map.delete(at);
}

// ── The per-frame clock (World.update) ───────────────────────────────────────

/** Advance every cabinet's own game: hosts run and send pads, followers run
 *  what they have, screens repaint. `viewer` is the local player's spot. */
export function nativeArcadeFrame(dt: number, viewer: { x: number; z: number } | null): void {
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
  const now = Date.now();
  for (const itemId of [...sessions.keys()]) {
    const s = sessionFor(itemId)!;
    const m = matchFor(itemId);
    reconcile(itemId, s, m);
    const copy = s.copy;
    if (copy) copy.ranNow = 0;
    try {
      if (copy?.role === 'host') hostFrame(itemId, s, copy, step, now);
      else if (copy && m && isCopyOf(copy, m)) followFrame(itemId, s, copy, m, step, now);
    } catch (err) {
      // The game threw mid-frame (a bug): drop the copy; a host ends its game.
      console.error('[arcade] the cabinet game stopped:', err);
      if (copy?.role === 'host') {
        if (s.link) s.link.error = 'THE GAME CRASHED';
        writeNativeArcade(itemId, null);
      }
      s.copy = null;
    }
    paint(itemId, s, m, now, viewer);
  }
}

/** Host: keep seat `n`'s pad with whoever holds it now (a new holder starts
 *  from a clean pad, with a grace period for its first tick). */
function seatGuest(copy: Copy, n: number, token: number, now: number): void {
  if (copy.guestTokens[n] === token) return;
  copy.guestTokens[n] = token;
  copy.guestPads[n]!.reset();
  copy.lastGuestAt[n] = now;
}

function hostFrame(itemId: string, s: CabinetSession, copy: Copy, dt: number, now: number): void {
  if (!copy.started) return;
  let m = readNativeArcade(itemId);
  if (!m || !isCopyOf(copy, m)) return;
  if (mustYieldId(itemId, m)) {
    // Ticks carry only the id: move to a fresh one. Copies that followed
    // the old id start over, their guests' tick counts with them.
    m = { ...m, id: freshMatchId(idsInUse()) };
    writeNativeArcade(itemId, m);
    copy.matchId = m.id;
    for (let n = 0; n < NATIVE_MAX_SEATS; n++) {
      copy.guestPads[n]!.reset();
      copy.lastGuestAt[n] = now;
    }
  }
  const seats = seatsOf(itemId, m);
  const held: boolean[] = [];
  for (let n = 0; n < NATIVE_MAX_SEATS; n++) {
    const seat = seats[n];
    if (!seat) {
      copy.guestTokens[n] = 0;
      held.push(n === m.hostSeat);
      continue;
    }
    seatGuest(copy, n, seat.token, now);
    if (now - copy.lastGuestAt[n]! > GUEST_GONE_MS) {
      // Gone (closed the tab, lost the link): the seat is free again.
      writeNativeSeat(itemId, n, null);
      copy.guestTokens[n] = 0;
      held.push(false);
      continue;
    }
    if (now - copy.lastGuestAt[n]! > GUEST_SILENT_MS) copy.guestPads[n]!.lapse();
    held.push(true);
  }
  const guests = held.some((h, n) => h && n !== m!.hostSeat);
  // A seat taken while the last player is still on the road: the newcomer's
  // pad waits until that player has left (in a puff), so they start afresh.
  const handing = seats.map((seat, n) => !!seat && !!copy.goes[n] && copy.goes[n]!.player !== seat.player);
  const id = m.id;
  const hostSeat = m.hostSeat;
  const sendFrames = (): void => {
    const lo = copy.lo.tick();
    const hi = copy.hi.tick();
    if (lo) send({ type: 'frames', match: id, ...lo, check: copy.latestCheck, half: 0 });
    if (hi) send({ type: 'frames', match: id, ...hi, check: copy.latestCheck, half: 1 });
  };
  copy.acc += dt;
  const pads = [0, 0, 0, 0];
  while (copy.acc >= FRAME_S && copy.ranNow < HOST_STEP_MAX) {
    for (let n = 0; n < NATIVE_MAX_SEATS; n++) {
      const pad = n === hostSeat ? (s.link?.buttons ?? 0) : held[n] ? copy.guestPads[n]!.next() : 0;
      pads[n] = held[n] && !handing[n] ? (pad & ~NATIVE_PRESENT & 0xff) | NATIVE_PRESENT : 0;
    }
    const lo = pads[0]! | (pads[1]! << 8);
    const hi = pads[2]! | (pads[3]! << 8);
    if (copy.lo.needsTickBefore(lo) || copy.hi.needsTickBefore(hi)) sendFrames();
    copy.game.step(copy.state, pads);
    copy.lo.record(copy.next, lo);
    copy.hi.record(copy.next, hi);
    copy.next = frameAdd(copy.next, 1);
    if ((copy.next & (CHECK_EVERY - 1)) === 0) copy.latestCheck = copy.game.check(copy.state);
    copy.acc -= FRAME_S;
    copy.ranNow++;
  }
  if (copy.acc >= FRAME_S) copy.acc = 0;
  if (copy.ranNow > 0) {
    copy.sendToggle = !copy.sendToggle;
    if (guests || copy.sendToggle) sendFrames();
    followGoes(itemId, copy, m, seats, now);
  }
  if (copy.syncAsked && !copy.snapshotBusy && now - copy.lastSnapshotAt >= SNAPSHOT_MIN_GAP_MS) {
    copy.syncAsked = false;
    void writeSnapshot(itemId, s, copy);
  }
}

/** Host: follow each seat's go off the game's scores. A go ends when its
 *  player leaves the road (a moment after stepping away) and is entered on
 *  the cabinet's high scores then; the rest are entered every
 *  SCORES_EVERY_MS. */
function followGoes(itemId: string, copy: Copy, m: NativeMatch, seats: ReadonlyArray<NativeSeat | null>, now: number): void {
  const scores = copy.game.scores(copy.state);
  const ended: Go[] = [];
  for (let n = 0; n < NATIVE_MAX_SEATS; n++) {
    const score = scores[n] ?? null;
    let go = copy.goes[n] ?? null;
    if (go && score === null) {
      ended.push(go);
      go = copy.goes[n] = null;
    }
    if (score === null) continue;
    if (!go) {
      const player = n === m.hostSeat ? m.host : seats[n]?.player ?? null;
      if (player === null) continue;
      go = copy.goes[n] = {
        run: `${m.hostPage}:${m.startedAt}:${n}:${++goCount}`, player, name: readPlayerDisplayName(player), score, entered: 0,
      };
    }
    go.score = score;
  }
  enterGoes(itemId, copy, now, now - copy.goesEnteredAt >= SCORES_EVERY_MS, ended);
}

/** Host: enter goes on the cabinet's high scores: those `ended`, and with
 *  `all` every go still being played (a table that doesn't change costs no
 *  write). */
function enterGoes(itemId: string, copy: Copy, now: number, all: boolean, ended: readonly Go[] = []): void {
  const lines: HighScore[] = [];
  for (const go of [...ended, ...(all ? copy.goes : [])]) {
    if (!go || go.score <= go.entered) continue;
    lines.push({ name: go.name, score: go.score, at: now, run: go.run });
    go.entered = go.score;
  }
  if (all) copy.goesEnteredAt = now;
  if (lines.length > 0) recordHighScores(itemId, copy.game.id, lines);
}

async function writeSnapshot(itemId: string, s: CabinetSession, copy: Copy): Promise<void> {
  const next = copy.next;
  const json = new TextEncoder().encode(JSON.stringify(copy.state));
  copy.snapshotBusy = true;
  try {
    const data = await pipe(json, new CompressionStream('deflate'));
    const m = readNativeArcade(itemId);
    if (s.copy === copy && inBoundRoom(s) && m && isCopyOf(copy, m)) {
      writeNativeSnapshot(itemId, { kind: 'arcade-native-snapshot', id: copy.matchId, next, data });
    }
  } catch {
    /* the next ask tries again */
  } finally {
    copy.snapshotBusy = false;
    copy.lastSnapshotAt = Date.now();
  }
}

function followFrame(itemId: string, s: CabinetSession, copy: Copy, m: NativeMatch, dt: number, now: number): void {
  const mine = mySeatIn(itemId, m);
  if (mine !== null) sendGuestPad(s, copy, m, readNativeSeat(itemId, mine)!.token);
  if (hostSilentFor(s, copy, now) > HOST_SILENT_MS) return;

  if (!copy.started && !copy.needSync) {
    // Heard the match from its first frame: start it fresh from the seed.
    const young = now - m.startedAt < FIRST_FRAME_WITHIN_MS;
    const heard = copy.logLo.latest;
    if (young && copy.logLo.has(0) && copy.logHi.has(0) && heard !== null && frameDiff(heard, 0) < 4096) {
      copy.state = copy.game.create(m.seed);
      copy.started = true;
    } else if (heard !== null) {
      copy.needSync = true;
    }
  }
  if (copy.needSync) {
    tryRestore(itemId, copy);
    if (now - copy.lastSyncAskAt >= SYNC_ASK_EVERY_MS) {
      copy.lastSyncAskAt = now;
      send({ type: 'sync', match: m.id, nonce: randomU16() });
    }
  }
  if (!copy.started) return;

  const max = CATCH_UP_MAX + CATCH_UP_LEAD + 1;
  const ready = Math.min(copy.logLo.run(copy.next, max), copy.logHi.run(copy.next, max));
  copy.acc += dt;
  let budget = Math.min(HOST_STEP_MAX, Math.floor(copy.acc / FRAME_S));
  if (ready > CATCH_UP_LEAD) budget = Math.max(budget, Math.min(CATCH_UP_MAX, ready - CATCH_UP_LEAD));
  const n = Math.min(budget, ready);
  const pads = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const lo = copy.logLo.get(copy.next);
    const hi = copy.logHi.get(copy.next);
    pads[0] = lo & 0xff;
    pads[1] = lo >> 8;
    pads[2] = hi & 0xff;
    pads[3] = hi >> 8;
    copy.game.step(copy.state, pads);
    copy.next = frameAdd(copy.next, 1);
    if ((copy.next & (CHECK_EVERY - 1)) === 0 && copy.next !== 0) {
      copy.myChecks.set(copy.next, copy.game.check(copy.state));
      compareChecks(copy, copy.next);
    }
  }
  copy.ranNow = n;
  copy.acc = n < budget ? Math.min(Math.max(0, copy.acc - n * FRAME_S), FRAME_S) : Math.max(0, copy.acc - n * FRAME_S);
  trimChecks(copy.myChecks, copy.next);
  trimChecks(copy.hostChecks, copy.next);

  // Stuck on a frame the host has already passed: it isn't coming.
  const latest = copy.logLo.latest;
  const passed = latest !== null && frameDiff(latest, copy.next) >= 0;
  if (ready === 0 && passed) {
    copy.stalledSince ??= now;
    if (now - copy.stalledSince > STALL_SYNC_MS && !copy.needSync) {
      copy.needSync = true;
      copy.syncFrom = copy.next;
    }
  } else {
    copy.stalledSince = null;
  }
}

function tryRestore(itemId: string, copy: Copy): void {
  if (copy.restoring) return;
  const snap = readNativeSnapshot(itemId);
  if (!snap || snap.id !== copy.matchId || snap.data === copy.triedSnapshot) return;
  if (copy.syncFrom !== null && frameDiff(snap.next, copy.syncFrom) <= 0) return;
  if (!copy.logLo.has(snap.next) || !copy.logHi.has(snap.next)) return;
  copy.restoring = true;
  copy.triedSnapshot = snap.data;
  pipe(snap.data, new DecompressionStream('deflate'), MAX_STATE_JSON_BYTES).then(
    (json) => {
      copy.restoring = false;
      let state: unknown;
      try {
        state = copy.game.restore(JSON.parse(new TextDecoder().decode(json)));
      } catch {
        state = null;
      }
      if (state === null) return; // not a save state: wait for the next
      copy.state = state;
      copy.next = snap.next;
      copy.started = true;
      copy.acc = 0;
      copy.needSync = false;
      copy.syncFrom = null;
      copy.stalledSince = null;
      copy.myChecks.clear();
    },
    () => {
      copy.restoring = false;
    },
  );
}

function sendGuestPad(s: CabinetSession, copy: Copy, m: NativeMatch, token: number): void {
  if (copy.guestFor !== token) {
    copy.guestFor = token;
    copy.guestCur = 0;
    copy.guestPrev = 0;
    copy.guestChanges = 0;
  }
  const pad = (s.link?.buttons ?? 0) & ~NATIVE_PRESENT & 0xff;
  let due = ++copy.guestBeat >= GUEST_HEARTBEAT;
  if (pad !== copy.guestCur) {
    copy.guestPrev = copy.guestCur;
    copy.guestCur = pad;
    copy.guestChanges = (copy.guestChanges + 1) & 0xff;
    due = true;
  }
  if (!due) return;
  copy.guestBeat = 0;
  copy.guestSeq = frameAdd(copy.guestSeq, 1);
  send({
    type: 'guest', match: m.id, token,
    cur: copy.guestCur, prev: copy.guestPrev, changes: copy.guestChanges, seq: copy.guestSeq,
  });
}

// ── The cabinet screen ───────────────────────────────────────────────────────

function paintEvery(s: CabinetSession, viewer: { x: number; z: number } | null): number {
  if (s.link || !viewer) return 1;
  const d = Math.hypot(viewer.x - s.pos.x, viewer.z - s.pos.z);
  return d <= PAINT_NEAR_M ? 1 : d <= PAINT_MID_M ? 3 : 6;
}

function paint(itemId: string, s: CabinetSession, m: NativeMatch | null, now: number, viewer: { x: number; z: number } | null): void {
  const own = nativeGameById(cabinetGame(itemId));
  const show = (key: string, draw: () => void) => {
    if (s.shown === key) return;
    s.shown = key;
    draw();
  };
  if (!own && !s.copy) {
    // Not one of ours: hand the screen back once, then leave it alone.
    if (s.holds) s.handle.showAttract();
    s.holds = false;
    s.shown = 'released';
    return;
  }
  if (s.link?.uiScreen) {
    // The cabinet UI at this page paints its menu on the screen.
    s.holds = true;
    s.shown = 'ui';
    return;
  }
  const copy = s.copy;
  const game = copy?.game ?? own!;
  const picture = (key: string, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) =>
    show(key, () => {
      s.handle.setPictureLines?.(game.lines[0], game.lines[1]);
      s.handle.painter.drawWith(draw);
      s.handle.present();
      s.holds = true;
    });
  const title = (line: string, idle = false) => {
    const blink = Math.floor(now / TITLE_BLINK_MS) % 2 === 0;
    const board = idle ? boardOf(itemId, s, game, now) : [];
    if (board.length > 0 && now % ATTRACT_CYCLE_MS >= ATTRACT_TITLE_MS) {
      const key = board.map((l) => `${l.score}:${l.name}`).join('|');
      return picture(`scores:${game.id}:${line}:${blink}:${key}`,
        (ctx, w, h) => game.paintScores(ctx, board, line, blink, w, h));
    }
    picture(`title:${game.id}:${line}:${blink}`, (ctx, w, h) => game.paintTitle(ctx, line, blink, w, h));
  };
  if (!copy || (copy.role === 'follow' && !m)) return title('STEP UP AND PRESS START', true);
  if (copy.role === 'follow') {
    const silent = hostSilentFor(s, copy, now);
    if (silent > HOST_GONE_MS) return title('STEP UP AND PRESS START', true);
    if (silent > HOST_SILENT_MS) return title('THE HOST LEFT THE GAME');
  }
  if (!copy.started) return title('JOINING…');
  if (copy.ranNow === 0 && s.shown === 'game') return;
  s.paintCount++;
  if (s.shown === 'game' && s.paintCount % paintEvery(s, viewer) !== 0) return;
  s.shown = 'game';
  s.handle.setPictureLines?.(game.lines[0], game.lines[1]);
  const hud = { hi: boardOf(itemId, s, game, now)[0]?.score ?? 0 };
  s.handle.painter.drawWith((ctx, w, h) => game.paint(ctx, copy.state, w, h, hud));
  s.handle.present();
  s.holds = true;
}

/** The cabinet's high scores for `game`, reread at most every BOARD_READ_MS. */
function boardOf(itemId: string, s: CabinetSession, game: NativeGame, now: number): HighScore[] {
  const b = s.board;
  if (b && b.game === game.id && now - b.at < BOARD_READ_MS) return b.lines;
  const lines = readHighScores(itemId, game.id);
  s.board = { at: now, game: game.id, lines };
  return lines;
}

// ── The page at the cabinet (arcadeNesCabinet.ts's UI, this link) ───────────

/**
 * Attach the focused page to a cabinet's own game, at stand `seat` (0 =
 * player 1's), or null at the cabinet's front with no stand free (it can
 * watch, and start a game as player 1 if none runs).
 */
export function linkNativeArcade(itemId: string, seat: number | null): ArcadeLink {
  const link: LinkState = { buttons: 0, uiScreen: true, error: null };
  const room = roomId();
  let epoch = casinoDocEpoch();
  const session = () => {
    if (casinoDocEpoch() !== epoch) {
      if (roomId() !== room) return null;
      epoch = casinoDocEpoch();
    }
    const s = sessionFor(itemId);
    if (s && s.link !== link) s.link = link;
    return s;
  };
  session();

  const api: ArcadeLink = {
    shared(): SharedView | null {
      const s = session();
      if (!s) return null;
      const copy = s.copy;
      const m = matchFor(itemId);
      if (copy?.role === 'host') {
        return { role: 'host', title: copy.game.title, phase: 'playing', joinAs: null, player: (m?.hostSeat ?? 0) + 1 };
      }
      if (!m || !copy || !isCopyOf(copy, m)) return null;
      const silent = hostSilentFor(s, copy, Date.now());
      if (silent > HOST_GONE_MS) return null;
      const phase: SharedPhase = silent > HOST_SILENT_MS ? 'ended' : copy.started && !copy.needSync ? 'playing' : 'joining';
      const mine = mySeatIn(itemId, m);
      if (mine !== null) return { role: 'guest', title: copy.game.title, phase, joinAs: null, player: mine + 1 };
      const free = seat !== null && seat < nativeSeats(m) && seat !== m.hostSeat && seatsOf(itemId, m)[seat] === null;
      return { role: 'watcher', title: copy.game.title, phase, joinAs: free && phase !== 'ended' ? seat + 1 : null, player: null };
    },

    takeError(): string | null {
      const e = link.error;
      link.error = null;
      return e;
    },

    host(game): void {
      const s = session();
      const native = nativeGameById(game.id);
      if (!s || !native) return;
      const m = newNativeMatch({
        id: freshMatchId(idsInUse()), game: nativeMatchGame(native), host: getPlayerId(), hostPage: PAGE,
        hostSeat: seat ?? 0, now: Date.now(),
      });
      newCopy(s, m, native, 'host');
      writeNativeArcade(itemId, m);
      link.error = null;
    },

    stop(): void {
      const s = session();
      if (!s) return;
      const m = readNativeArcade(itemId);
      if (s.copy?.role === 'host') {
        enterGoes(itemId, s.copy, Date.now(), true);
        s.copy = null;
        s.shown = null;
        if (m && m.hostPage === PAGE) writeNativeArcade(itemId, null);
        return;
      }
      const mine = m ? mySeatIn(itemId, m) : null;
      if (mine !== null) writeNativeSeat(itemId, mine, null);
    },

    join(): void {
      const s = session();
      const m = matchFor(itemId);
      if (!s || !m || seat === null || seat === m.hostSeat || seat >= nativeSeats(m)) return;
      if (mySeatIn(itemId, m) !== null) return;
      if (seatsOf(itemId, m)[seat] !== null) return; // someone else's
      writeNativeSeat(itemId, seat, newNativeSeat(m, seat, getPlayerId(), PAGE));
    },

    setButtons(pad: number): void {
      link.buttons = pad & 0xff;
    },

    setLocalPad2(): void {
      // One player per page at the double-wide cabinet: a second pad on
      // this computer plays nobody (yet).
    },

    setAudio(): void {
      // The cabinet's own games are silent for now.
    },

    setUiScreen(on: boolean): void {
      const s = session();
      if (link.uiScreen !== on && s) s.shown = null;
      link.uiScreen = on;
    },

    release(): void {
      api.stop();
      const s = sessions.get(itemId);
      if (s && s.link === link) {
        s.link = null;
        s.shown = null;
      }
      link.buttons = 0;
    },
  };
  return api;
}

/**
 * Each stand's seat in the cabinet's game, for the page walking up to it:
 * this page's, somebody else's, or free. Every stand is free while no game
 * runs, or once its host has gone quiet for good.
 */
export function nativeSeatStatus(itemId: string): Array<'mine' | 'taken' | 'free'> {
  const out: Array<'mine' | 'taken' | 'free'> = new Array(NATIVE_MAX_SEATS).fill('free');
  const m = matchFor(itemId);
  const s = sessionFor(itemId);
  if (!m || (m.hostPage !== PAGE && s && hostSilentFor(s, s.copy, Date.now()) > HOST_GONE_MS)) return out;
  const seats = seatsOf(itemId, m);
  for (let n = 0; n < NATIVE_MAX_SEATS; n++) {
    const page = n === m.hostSeat ? m.hostPage : seats[n]?.page;
    out[n] = n >= nativeSeats(m) ? 'taken' : page === undefined ? 'free' : page === PAGE ? 'mine' : 'taken';
  }
  return out;
}

// ── Tests and debugging ──────────────────────────────────────────────────────

/** This page's copy of the cabinet's own game: role, frame next, running. */
export function nativeArcadeCopyInfo(
  itemId: string,
): { role: 'host' | 'follow'; game: string; next: number; started: boolean; state: unknown } | null {
  const copy = sessions.get(itemId)?.copy;
  return copy
    ? { role: copy.role, game: copy.game.id, next: copy.next, started: copy.started && !copy.needSync, state: copy.state }
    : null;
}

/** Forget every cabinet (tests). */
export function resetNativeArcadeSessions(): void {
  sessions.clear();
}
