/**
 * 🕹️ Arcade session — the LIVE layer for SHARED cabinet games, between the
 * emulator (arcadeMachine.ts), the tick wire (arcadeNet.ts), the room doc
 * (games/arcade.ts via gamesDoc.ts) and the cabinet's screen.
 *
 * Every computer in the room runs a copy of a shared game:
 *
 *  - the HOST's page (whoever started it) runs the reference copy on its own
 *    clock. Each frame it takes its player's pad and player 2's (the guest's
 *    ticks, or a second pad on the host's computer), runs the frame, and
 *    sends the pad bytes to the room (FRAMES ticks, ~30–60 a second);
 *  - every other page FOLLOWS: it runs the same frames with the same pad
 *    bytes, a few frames behind, and paints them on its cabinet. The guest
 *    is a follower that also sends its pad to the host.
 *
 * A follower that starts late, or loses its place (ticks it can't rebuild,
 * a state check that disagrees), asks for a SAVE STATE with a sync tick; the
 * host writes one into the doc (about 10–20 KB, at most one a second) and
 * the follower continues from it with the pads it has been collecting.
 *
 * Painting is where watching costs something, not the network: the pad bytes
 * are the same few bytes at any distance. So a watcher's cabinet repaints
 * every frame up close, every 3rd frame across the room and every 6th from
 * far away; the page at the cabinet always repaints every frame.
 *
 * Only built-in games run here: the cabinet's one game, the owner's pick
 * (arcadeDoc). While the cabinet UI (arcadeNesCabinet.ts) shows its own
 * screen (the menu, the credits) this layer doesn't paint.
 */

import { ARCADE_GAMES, type ArcadeGame, type CabinetGame } from './arcadeLibrary';
import { ArcadeMachine, NES_FPS } from './arcadeMachine';
import {
  GuestPad, PadLog, PadRuns, decodeSnapshot, encodeSnapshot, frameAdd, frameDiff,
  packArcadeTick, unpackArcadeTick,
} from './arcadeNet';
import {
  freshMatchId, newMatch, randomU16, withGuest, withoutGuest, yieldsMatchId, type ArcadeMatch,
} from './games/arcade';
import { readArcade, readArcadeMatches, readArcadeSnapshot, writeArcade, writeArcadeSnapshot } from './games/gamesDoc';
import { casinoDocEpoch } from './casinoDoc';
import { standbyPicture } from './arcadeStandby';
import { getPlayerId } from './identity';
import type { ArcadeCabinetVisualHandle } from './devices';

// ── Tunables ─────────────────────────────────────────────────────────────────

const FRAME_S = 1 / NES_FPS;
/** Frames the host runs per update at most: a hitch slows the game a moment. */
const HOST_STEP_MAX = 3;
/** A follower more than CATCH_UP_LEAD frames behind runs up to this many per
 *  update until it is back to CATCH_UP_LEAD behind. */
const CATCH_UP_MAX = 8;
const CATCH_UP_LEAD = 4;
/** Frames between state checks (host and followers fingerprint the same ones). */
const CHECK_EVERY = 32;
/** A follower waiting for a save state asks again this often. */
const SYNC_ASK_EVERY_MS = 1500;
/** A follower stuck on a missing frame this long, while later frames keep
 *  arriving, gives up on filling it and asks for a save state. */
const STALL_SYNC_MS = 1000;
/** No FRAMES this long: the host has gone (closed the tab, lost the link). */
const HOST_SILENT_MS = 4000;
/** …and this long: the match is over as far as a watcher's cabinet shows. */
const HOST_GONE_MS = 12000;
/** Frame 0 comes round again every 65536 frames (the u16 clock, ~18
 *  minutes at 60 a second). Only a match younger than this, by its start
 *  time, can be at its first frame; the margin covers clocks that differ. */
const FIRST_FRAME_WITHIN_MS = 10 * 60 * 1000;
/** The guest silent this long: player 2's pad lets go… */
const GUEST_SILENT_MS = 2000;
/** …and this long: the guest closed the tab or lost the link, so the host
 *  frees the stand for someone else. A new guest gets this long to send its
 *  first tick. */
const GUEST_GONE_MS = 6000;
/** The host writes at most one save state this often. */
const SNAPSHOT_MIN_GAP_MS = 1000;
/** A follower whose game didn't load (a network blip) tries again this often. */
const LOAD_RETRY_MS = 10_000;
/** The guest repeats its pad every this many updates, changed or not. */
const GUEST_HEARTBEAT = 4;
/** Watcher repaint by distance (metres): every frame, every 3rd, every 6th. */
const PAINT_NEAR_M = 3.5;
const PAINT_MID_M = 8;

// ── This page ────────────────────────────────────────────────────────────────

/** This page's id in a match record: a player's id is shared by all their
 *  tabs, and only one page may run the reference copy or play the guest. */
const PAGE = mintPage();

function mintPage(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function arcadePage(): string {
  return PAGE;
}

/** Outbound datagram seam: main.ts wires NetworkProvider.sendTick here. */
let sendTickBuf: ((buf: Uint8Array) => void) | null = null;

export function setArcadeSender(fn: ((buf: Uint8Array) => void) | null): void {
  sendTickBuf = fn;
}

async function defaultFetchRom(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

let fetchRom: (url: string) => Promise<Uint8Array> = defaultFetchRom;
const romCache = new Map<string, Promise<Uint8Array>>();

/** Swap the ROM fetcher (tests); also forgets ROMs already fetched. */
export function setArcadeRomFetcher(fn: ((url: string) => Promise<Uint8Array>) | null): void {
  fetchRom = fn ?? defaultFetchRom;
  romCache.clear();
}

function romFor(game: ArcadeGame): Promise<Uint8Array> {
  let rom = romCache.get(game.id);
  if (!rom) {
    rom = fetchRom(game.romUrl);
    rom.catch(() => romCache.delete(game.id)); // let a later try fetch again
    romCache.set(game.id, rom);
  }
  return rom;
}

// ── Per-cabinet runtime ──────────────────────────────────────────────────────

/** This page's copy of one match. */
interface Copy {
  matchId: number;
  /** The record's host page: with the id and game, which record this runs. */
  hostPage: string;
  game: ArcadeGame;
  role: 'host' | 'follow';
  machine: ArcadeMachine | null;
  rom: Uint8Array | null;
  failed: boolean;
  /** When it failed (Date.now()), for a follower's retry. */
  failedAt: number;
  /** Has a state to run from (booted at frame 0, or restored). */
  started: boolean;
  /** The u16 frame it runs next. */
  next: number;
  acc: number;
  createdAt: number;
  /** Frames run in the latest update (painting reads it). */
  ranNow: number;
  // Host
  /** The match record, held until the ROM is in and it can be written. */
  pending: ArcadeMatch | null;
  runs: PadRuns;
  guestPad: GuestPad;
  /** The guest token guestPad belongs to (0: no guest). */
  guestToken: number;
  lastGuestAt: number;
  syncAsked: boolean;
  snapshotBusy: boolean;
  lastSnapshotAt: number;
  latestCheck: number;
  sendToggle: boolean;
  // Follower
  log: PadLog;
  hostLane: string | null;
  lastFramesAt: number;
  stalledSince: number | null;
  needSync: boolean;
  /** Frame the copy was at when a check failed: only a later state helps. */
  syncFrom: number | null;
  lastSyncAskAt: number;
  restoring: boolean;
  triedSnapshot: Uint8Array | null;
  hostChecks: Map<number, number>;
  myChecks: Map<number, number>;
  // Guest's outgoing pad
  /** The seat token the counts below are for: a new seat starts them over. */
  guestFor: number;
  guestCur: number;
  guestPrev: number;
  guestChanges: number;
  guestSeq: number;
  guestBeat: number;
  /** The pads of the frame it ran last, player 1's first (the cabinet's
   *  sticks and buttons show them). */
  pads: number[];
}

/** The page at the cabinet (the focus UI), if any. */
interface LinkState {
  buttons: number;
  localP2: number;
  audio: ((left: number, right: number) => void) | null;
  sampleRate: number;
  /** The UI is showing its own screen (the menu, the credits). */
  uiScreen: boolean;
  /** Why the last host() failed, for the menu's status line. */
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
  /** What the cabinet shows now, so a still screen is painted once. */
  shown: string | null;
  /** Its sticks and buttons were last set by a game here ('live'), or put
   *  at rest ('rest'), or neither yet (null). */
  controls: 'live' | 'rest' | null;
}

const sessions = new Map<string, CabinetSession>();

/** Register (or re-register after a furniture rebuild) a built cabinet's
 *  screen handle and world position. A running copy survives a handle swap
 *  within one room's doc. */
export function registerArcadeVisual(itemId: string, handle: ArcadeCabinetVisualHandle, pos: { x: number; z: number }): void {
  const existing = sessions.get(itemId);
  if (existing && existing.docEpoch === casinoDocEpoch()) {
    existing.handle = handle;
    existing.pos = pos;
    existing.shown = null;
    existing.controls = null;
    return;
  }
  sessions.set(itemId, freshSession(handle, pos));
}

function freshSession(handle: ArcadeCabinetVisualHandle, pos: { x: number; z: number }): CabinetSession {
  return {
    handle, pos, docEpoch: casinoDocEpoch(), bornAt: Date.now(), copy: null, link: null, paintCount: 0, shown: null,
    controls: null,
  };
}

/** The cabinet's session in the room's current doc (a room change starts it
 *  afresh: nothing carries over to another room's cabinet with the same id,
 *  not even the page at it, whose link re-attaches only in the same room). */
function sessionFor(itemId: string): CabinetSession | null {
  const s = sessions.get(itemId);
  if (!s || s.docEpoch === casinoDocEpoch()) return s ?? null;
  s.copy?.machine?.stop();
  s.copy = null;
  const fresh = freshSession(s.handle, s.pos);
  sessions.set(itemId, fresh);
  return fresh;
}

/** The session still belongs to the bound room doc (an async step that
 *  finishes after a room change must not touch the new room). */
const inBoundRoom = (s: CabinetSession): boolean => s.docEpoch === casinoDocEpoch();

/** The room this page is in (main.ts publishes it), or null before one. */
function roomId(): string | null {
  const id = (globalThis as { __ssfRoomId?: unknown }).__ssfRoomId;
  return typeof id === 'string' ? id : null;
}

/** Drop a removed cabinet's runtime (world.ts removeFurnitureVisuals). A
 *  game this page hosts there ends with it. */
export function closeArcadeCabinet(itemId: string): void {
  const s = sessions.get(itemId);
  if (s?.copy?.role === 'host' && readArcade(itemId)?.hostPage === PAGE) writeArcade(itemId, null);
  s?.copy?.machine?.stop();
  sessions.delete(itemId);
}

function newCopy(
  s: CabinetSession, itemId: string, matchId: number, hostPage: string, game: ArcadeGame, role: 'host' | 'follow',
): Copy {
  s.copy?.machine?.stop();
  const now = Date.now();
  const copy: Copy = {
    matchId, hostPage, game, role,
    machine: null, rom: null, failed: false, failedAt: 0, started: false, next: 0, acc: 0, createdAt: now, ranNow: 0,
    pending: null, runs: new PadRuns(), guestPad: new GuestPad(), guestToken: 0, lastGuestAt: 0,
    syncAsked: false, snapshotBusy: false, lastSnapshotAt: 0, latestCheck: 0, sendToggle: false,
    log: new PadLog(), hostLane: null, lastFramesAt: 0, stalledSince: null, needSync: false,
    syncFrom: null, lastSyncAskAt: 0, restoring: false, triedSnapshot: null,
    hostChecks: new Map(), myChecks: new Map(),
    guestFor: 0, guestCur: 0, guestPrev: 0, guestChanges: 0, guestSeq: 0, guestBeat: 0, pads: [0, 0],
  };
  s.copy = copy;
  s.shown = null;
  /** A host's game that won't load never starts (the menu says why); a
   *  follower's shows it on the cabinet, gives back the second stand if it
   *  had taken it (it can't play), and tries again later (reconcile). */
  const failed = () => {
    copy.failed = true;
    copy.failedAt = Date.now();
    if (role !== 'host') {
      const m = inBoundRoom(s) ? readArcade(itemId) : null;
      if (m && m.guestPage === PAGE && isCopyOf(copy, m)) writeArcade(itemId, withoutGuest(m, PAGE));
      return;
    }
    if (s.link) s.link.error = 'COULD NOT LOAD THAT GAME';
    s.copy = null;
    s.shown = null;
  };
  romFor(game).then(
    (rom) => {
      if (s.copy !== copy || !inBoundRoom(s)) return;
      const machine = new ArcadeMachine({
        sampleRate: s.link?.sampleRate ?? 48000,
        onAudioSample: (l, r) => s.link?.audio?.(l, r),
      });
      if (!machine.load(rom).ok) {
        failed();
        return;
      }
      // Frame 0 of every match is the game's standby screen, the picture
      // the idle cabinet showed: every copy runs the same way there first.
      try {
        machine.toStandby(game.standby);
      } catch {
        failed();
        return;
      }
      copy.rom = rom;
      copy.machine = machine;
      if (role === 'host' && copy.pending) {
        // The reference copy is ready at frame 0: tell the room, under an id
        // no cabinet took while the ROM loaded.
        const taken = idsInUse();
        if (taken.has(copy.pending.id)) copy.pending = { ...copy.pending, id: freshMatchId(taken) };
        copy.matchId = copy.pending.id;
        writeArcade(itemId, copy.pending);
        copy.pending = null;
        copy.started = true;
      }
    },
    () => {
      if (s.copy === copy) failed();
    },
  );
  return copy;
}

const gameById = (id: string): ArcadeGame | undefined => ARCADE_GAMES.find((g) => g.id === id);

/** A follower whose game didn't load, due another try. */
const loadRetryDue = (copy: Copy): boolean =>
  copy.role === 'follow' && copy.failed && Date.now() - copy.failedAt >= LOAD_RETRY_MS;

/** Is `copy` running the record `m`? Ticks carry only the id, but two pages
 *  that claim a cabinet at once can draw the same one: the host page and the
 *  game tell their records apart. */
function isCopyOf(copy: Copy, m: ArcadeMatch): boolean {
  return copy.matchId === m.id && copy.hostPage === m.hostPage && copy.game.id === m.game;
}

/** The ids the room's matches hold, this cabinet's own last one included:
 *  a new game there under its last host's id would look, to a page still
 *  following that one, like the same game, and it would never switch. */
function idsInUse(): Set<number> {
  const taken = new Set<number>();
  for (const m of readArcadeMatches().values()) taken.add(m.id);
  return taken;
}

/** Did another cabinet claim this match's id at the same moment, and keep it? */
function mustYieldId(itemId: string, m: ArcadeMatch): boolean {
  for (const [cabinet, other] of readArcadeMatches()) {
    if (yieldsMatchId({ cabinet: itemId, match: m }, { cabinet, match: other })) return true;
  }
  return false;
}

/** Is the match's host still there, as far as this page can tell? */
function hostSilentFor(s: CabinetSession, copy: Copy | null, now: number): number {
  const heard = Math.max(copy?.lastFramesAt ?? 0, copy?.createdAt ?? 0, s.bornAt);
  return now - heard;
}

/** Bring the page's copy in line with the doc: follow a new match, drop an
 *  ended one, notice that another page took the cabinet over. */
function reconcile(itemId: string, s: CabinetSession, m: ArcadeMatch | null): void {
  const copy = s.copy;
  if (copy?.role === 'host' && copy.pending) return; // ours, not written yet
  if (!m) {
    if (copy) {
      copy.machine?.stop();
      s.copy = null;
      s.shown = null;
    }
    return;
  }
  // The same match (a host's own record, too): two pages that claimed the
  // cabinet at once leave one record, and a copy of the other one, host or
  // follower, starts over on it here, even under the same id.
  if (copy && isCopyOf(copy, m) && !loadRetryDue(copy)) return;
  if (m.hostPage === PAGE) {
    // A record naming this page that it no longer runs (it was reloaded:
    // a new page id, so this can only be a leftover): end it.
    writeArcade(itemId, null);
    return;
  }
  const game = gameById(m.game);
  if (!game) {
    // A game this build doesn't have (a newer client started it): nothing
    // to follow, and the last match's copy must not stand in for it.
    if (copy) {
      copy.machine?.stop();
      s.copy = null;
      s.shown = null;
    }
    return;
  }
  newCopy(s, itemId, m.id, m.hostPage, game, 'follow');
}

// ── Inbound ticks (main.ts, for every arcade tick) ───────────────────────────

function sessionForMatch(matchId: number): [string, CabinetSession] | null {
  for (const [itemId] of sessions) {
    const s = sessionFor(itemId)!;
    if (s.copy?.matchId === matchId) return [itemId, s];
  }
  for (const [itemId] of sessions) {
    const s = sessionFor(itemId)!;
    const m = readArcade(itemId);
    if (m?.id === matchId) {
      reconcile(itemId, s, m);
      if (s.copy?.matchId === matchId) return [itemId, s];
    }
  }
  return null;
}

/** Route one raw 13-byte arcade tick from a peer (`senderId` = its lane). */
export function routeArcadeTick(senderId: string, bytes: Uint8Array): void {
  const t = unpackArcadeTick(bytes);
  if (!t) return;
  const found = sessionForMatch(t.match);
  if (!found) return;
  const [itemId, s] = found;
  const copy = s.copy!;
  const now = Date.now();
  if (t.type === 'frames') {
    if (copy.role === 'host') return; // an echo, or someone else's claim
    // One host lane at a time; a new one takes over once the old falls silent.
    // This keeps a stale tab from fighting the host; it is not a security
    // boundary. Lane ids aren't signed across the mesh and anyone in the
    // room can rewrite the match record, as with every table game's ticks.
    if (copy.hostLane && copy.hostLane !== senderId && now - copy.lastFramesAt < HOST_SILENT_MS) return;
    copy.hostLane = senderId;
    copy.lastFramesAt = now;
    copy.log.addTick(t);
    const at = (frameAdd(t.frame, 1) & ~(CHECK_EVERY - 1)) & 0xffff;
    if (at !== 0) {
      copy.hostChecks.set(at, t.check);
      compareChecks(copy, at);
    }
    return;
  }
  if (t.type === 'guest') {
    if (copy.role !== 'host') return;
    const m = readArcade(itemId);
    if (!m || m.guestToken === 0 || t.token !== m.guestToken) return;
    seatGuest(copy, m, now);
    copy.guestPad.onTick(t);
    copy.lastGuestAt = now;
    return;
  }
  if (copy.role === 'host') copy.syncAsked = true;
}

function compareChecks(copy: Copy, at: number): void {
  const mine = copy.myChecks.get(at);
  const theirs = copy.hostChecks.get(at);
  if (mine === undefined || theirs === undefined) return;
  if (mine !== theirs && !copy.needSync) {
    // This copy has drifted from the host's: start again from a save state.
    copy.needSync = true;
    copy.syncFrom = copy.next;
  }
}

function trimChecks(map: Map<number, number>, next: number): void {
  for (const at of map.keys()) if (frameDiff(next, at) > CHECK_EVERY * 8 || frameDiff(at, next) > CHECK_EVERY * 64) map.delete(at);
}

function send(t: Parameters<typeof packArcadeTick>[0]): void {
  sendTickBuf?.(packArcadeTick(t));
}

// ── The per-frame clock (World.update) ───────────────────────────────────────

/**
 * Advance every cabinet: hosts run their games and send pads, followers run
 * what they have and ask for what they're missing, and screens repaint.
 * `viewer` is the local player's position (watcher repaint distance).
 */
export function arcadeFrame(dt: number, viewer: { x: number; z: number } | null): void {
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
  const now = Date.now();
  for (const itemId of [...sessions.keys()]) {
    const s = sessionFor(itemId)!;
    const m = readArcade(itemId);
    reconcile(itemId, s, m);
    const copy = s.copy;
    if (copy) copy.ranNow = 0;
    try {
      if (copy?.role === 'host') hostFrame(itemId, s, copy, step, now);
      else if (copy && m && isCopyOf(copy, m)) followFrame(itemId, s, copy, m, step, now);
    } catch {
      // The emulator threw mid-frame (a bad save state, a jsnes bug): drop
      // this copy; a follower starts over, a host ends its game.
      if (copy?.role === 'host') {
        if (s.link) s.link.error = 'THE GAME CRASHED';
        writeArcade(itemId, null);
      }
      copy?.machine?.stop();
      s.copy = null;
    }
    showControls(s, m, now);
    paint(s, m, now, viewer);
  }
}

/** The cabinet's sticks and buttons: each player's pad in the frame the game
 *  ran last, and a guest's own as it presses (it comes back from the host a
 *  little late), every frame (the cabinet skips what hasn't changed). At
 *  rest while no game runs here, put there once, so the double-wide's other
 *  session (arcadeNativeSession) can drive them. */
function showControls(s: CabinetSession, m: ArcadeMatch | null, now: number): void {
  const copy = s.copy;
  let pads: number[] = [];
  if (copy?.started && !copy.needSync && (copy.role === 'host' || hostSilentFor(s, copy, now) <= HOST_SILENT_MS)) {
    pads = copy.pads.slice();
    if (copy.role === 'follow' && s.link && m?.guestPage === PAGE) pads[m.hostSeat === 0 ? 1 : 0] = s.link.buttons;
  }
  const live = pads.length > 0;
  if (!live && s.controls === 'rest') return;
  s.controls = live ? 'live' : 'rest';
  s.handle.setControls?.(pads);
}

/** Host: keep the guest pad with whoever holds the seat now. A new holder
 *  counts its changes from none (sendGuestPad) and numbers its ticks its own
 *  way, so it starts from a clean pad, and gets a grace period for its first
 *  tick. */
function seatGuest(copy: Copy, m: ArcadeMatch, now: number): void {
  if (m.guestToken === copy.guestToken) return;
  copy.guestToken = m.guestToken;
  copy.guestPad.reset();
  copy.lastGuestAt = now;
}

function hostFrame(itemId: string, s: CabinetSession, copy: Copy, dt: number, now: number): void {
  const machine = copy.machine;
  if (!machine || !copy.started) return;
  let m = readArcade(itemId);
  if (!m || !isCopyOf(copy, m)) return; // reconcile has it next update
  if (mustYieldId(itemId, m)) {
    // Ticks carry only the id: move to a fresh one. Copies that followed
    // the old id start over (from a save state if they missed the start).
    m = { ...m, id: freshMatchId(idsInUse()) };
    writeArcade(itemId, m);
    copy.matchId = m.id;
    // The guest's copy starts over on the new id, its tick count with it.
    copy.guestPad.reset();
    copy.lastGuestAt = now;
  }
  seatGuest(copy, m, now);
  if (m.guestPage && now - copy.lastGuestAt > GUEST_GONE_MS) {
    m = withoutGuest(m, m.guestPage);
    writeArcade(itemId, m);
    seatGuest(copy, m, now);
  }
  if (now - copy.lastGuestAt > GUEST_SILENT_MS) copy.guestPad.lapse();
  const id = m.id;
  const sendFrames = (): void => {
    const runs = copy.runs.tick();
    if (runs) send({ type: 'frames', match: id, ...runs, check: copy.latestCheck });
  };
  copy.acc += dt;
  while (copy.acc >= FRAME_S && copy.ranNow < HOST_STEP_MAX) {
    const mine = s.link?.buttons ?? 0;
    const other = m.guestToken ? copy.guestPad.next() : (s.link?.localP2 ?? 0);
    const p1 = m.hostSeat === 0 ? mine : other;
    const p2 = m.hostSeat === 0 ? other : mine;
    const pads = p1 | (p2 << 8);
    if (copy.runs.needsTickBefore(pads)) sendFrames(); // or a run goes unsent
    machine.runFrame(p1, p2);
    copy.pads[0] = p1;
    copy.pads[1] = p2;
    copy.runs.record(copy.next, pads);
    copy.next = frameAdd(copy.next, 1);
    if ((copy.next & (CHECK_EVERY - 1)) === 0) copy.latestCheck = machine.check();
    copy.acc -= FRAME_S;
    copy.ranNow++;
  }
  if (copy.acc >= FRAME_S) copy.acc = 0; // behind after the cap: drop it
  if (copy.ranNow > 0) {
    // Every frame while someone plays player 2 remotely (their delay is a
    // round trip), every other frame for watchers alone.
    copy.sendToggle = !copy.sendToggle;
    if (m.guestToken !== 0 || copy.sendToggle) sendFrames();
  }
  if (copy.syncAsked && !copy.snapshotBusy && now - copy.lastSnapshotAt >= SNAPSHOT_MIN_GAP_MS) {
    copy.syncAsked = false;
    void writeSnapshot(itemId, s, copy);
  }
}

async function writeSnapshot(itemId: string, s: CabinetSession, copy: Copy): Promise<void> {
  const machine = copy.machine;
  const state = machine?.saveState();
  const boot = copy.rom ? ArcadeMachine.bootState(copy.rom) : null;
  if (!state || !boot) return;
  const next = copy.next;
  copy.snapshotBusy = true;
  try {
    const data = await encodeSnapshot(state, boot);
    // Still this page's game: a claim that lost the cabinet meanwhile, even
    // under the same id, must not write its state over the winner's.
    const m = readArcade(itemId);
    if (s.copy === copy && inBoundRoom(s) && m && isCopyOf(copy, m)) {
      writeArcadeSnapshot(itemId, { kind: 'arcade-snapshot', id: copy.matchId, next, data });
    }
  } catch {
    /* the next ask tries again */
  } finally {
    copy.snapshotBusy = false;
    copy.lastSnapshotAt = Date.now();
  }
}

function followFrame(itemId: string, s: CabinetSession, copy: Copy, m: ArcadeMatch, dt: number, now: number): void {
  // The guest's heartbeat holds its seat, even while its ROM is loading
  // (not once it failed to: that copy can't play).
  if (m.guestPage === PAGE && !copy.failed) sendGuestPad(s, copy, m);
  const machine = copy.machine;
  if (!machine) return;
  if (hostSilentFor(s, copy, now) > HOST_SILENT_MS) return; // nothing to run until the host is back

  if (!copy.started && !copy.needSync) {
    // Heard the match from its first frame: run it from there, the standby
    // screen. (A frame 0 in an older match is the clock wrapping: that needs
    // a save state.)
    const young = now - m.startedAt < FIRST_FRAME_WITHIN_MS;
    if (young && copy.log.has(0) && copy.log.latest !== null && frameDiff(copy.log.latest, 0) < 4096) copy.started = true;
    else if (copy.log.latest !== null) copy.needSync = true;
  }
  if (copy.needSync) {
    tryRestore(itemId, copy);
    if (now - copy.lastSyncAskAt >= SYNC_ASK_EVERY_MS) {
      copy.lastSyncAskAt = now;
      send({ type: 'sync', match: m.id, nonce: randomU16() });
    }
  }
  if (!copy.started) return;

  const ready = copy.log.run(copy.next, CATCH_UP_MAX + CATCH_UP_LEAD + 1);
  copy.acc += dt;
  let budget = Math.min(HOST_STEP_MAX, Math.floor(copy.acc / FRAME_S));
  if (ready > CATCH_UP_LEAD) budget = Math.max(budget, Math.min(CATCH_UP_MAX, ready - CATCH_UP_LEAD));
  const n = Math.min(budget, ready);
  for (let i = 0; i < n; i++) {
    const pads = copy.log.get(copy.next);
    machine.runFrame(pads & 0xff, pads >> 8);
    copy.pads[0] = pads & 0xff;
    copy.pads[1] = pads >> 8;
    copy.next = frameAdd(copy.next, 1);
    if ((copy.next & (CHECK_EVERY - 1)) === 0 && copy.next !== 0) {
      copy.myChecks.set(copy.next, machine.check());
      compareChecks(copy, copy.next);
    }
  }
  copy.ranNow = n;
  // Waiting on the host: don't bank time to burn through later.
  copy.acc = n < budget ? Math.min(Math.max(0, copy.acc - n * FRAME_S), FRAME_S) : Math.max(0, copy.acc - n * FRAME_S);
  trimChecks(copy.myChecks, copy.next);
  trimChecks(copy.hostChecks, copy.next);

  // Stuck on a frame the host has already passed: it isn't coming.
  const passed = copy.log.latest !== null && frameDiff(copy.log.latest, copy.next) >= 0;
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
  if (copy.restoring || !copy.machine || !copy.rom) return;
  const snap = readArcadeSnapshot(itemId);
  if (!snap || snap.id !== copy.matchId || snap.data === copy.triedSnapshot) return;
  if (copy.syncFrom !== null && frameDiff(snap.next, copy.syncFrom) <= 0) return; // from before the drift
  if (!copy.log.has(snap.next)) return; // can't carry on from it: wait for a newer one
  const boot = ArcadeMachine.bootState(copy.rom);
  if (!boot) return;
  copy.restoring = true;
  copy.triedSnapshot = snap.data;
  decodeSnapshot(snap.data, boot).then(
    (state) => {
      copy.restoring = false;
      if (!copy.machine) return;
      copy.machine.loadState(state);
      copy.next = snap.next;
      copy.started = true;
      copy.acc = 0;
      copy.needSync = false;
      copy.syncFrom = null;
      copy.stalledSince = null;
      copy.myChecks.clear();
    },
    () => {
      copy.restoring = false; // a bad one: wait for the next
    },
  );
}

function sendGuestPad(s: CabinetSession, copy: Copy, m: ArcadeMatch): void {
  if (copy.guestFor !== m.guestToken) {
    // Taken the seat (again): the host counts this seat's changes from none,
    // with nothing held, so a tap whose first tick is lost still replays.
    // The sequence runs on, so the host never mistakes a tick for an old one.
    copy.guestFor = m.guestToken;
    copy.guestCur = 0;
    copy.guestPrev = 0;
    copy.guestChanges = 0;
  }
  const pad = s.link?.buttons ?? 0;
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
    type: 'guest', match: m.id, token: m.guestToken,
    cur: copy.guestCur, prev: copy.guestPrev, changes: copy.guestChanges, seq: copy.guestSeq,
  });
}

// ── The cabinet screen ───────────────────────────────────────────────────────

function paintEvery(s: CabinetSession, viewer: { x: number; z: number } | null): number {
  if (s.link || !viewer) return 1;
  const d = Math.hypot(viewer.x - s.pos.x, viewer.z - s.pos.z);
  return d <= PAINT_NEAR_M ? 1 : d <= PAINT_MID_M ? 3 : 6;
}

function paint(s: CabinetSession, m: ArcadeMatch | null, now: number, viewer: { x: number; z: number } | null): void {
  if (s.link?.uiScreen) {
    s.shown = 'ui';
    return;
  }
  const copy = s.copy;
  const show = (key: string, draw: () => void) => {
    if (s.shown === key) return;
    s.shown = key;
    draw();
  };
  // While its game isn't running here, the cabinet keeps the game's standby
  // picture up (once it has loaded), saying why under it.
  const picture = copy ? standbyPicture(copy.game.id) : null;
  const card = (line: string) =>
    show(`card:${copy?.game.title}:${line}:${picture ? 'standby' : 'words'}`, () => {
      if (picture) s.handle.painter.drawStandby(picture, { centre: line, on: true });
      else s.handle.painter.drawCard(copy?.game.title ?? 'SSF ARCADE', line);
      s.handle.present();
    });
  if (!copy || (copy.role === 'follow' && !m)) {
    show('attract', () => s.handle.showAttract());
    return;
  }
  if (copy.role === 'follow') {
    const silent = hostSilentFor(s, copy, now);
    if (silent > HOST_GONE_MS) return show('attract', () => s.handle.showAttract());
    if (silent > HOST_SILENT_MS) return card('PLAYER 1 LEFT');
  }
  if (copy.failed) return card('COULD NOT LOAD THIS GAME');
  if (!copy.started || !copy.machine) return card(copy.role === 'host' ? 'LOADING…' : 'JOINING…');
  if (copy.ranNow === 0 && s.shown === 'game') return;
  const frame = copy.machine.frameBuffer();
  if (!frame) return;
  s.paintCount++;
  if (s.shown === 'game' && s.paintCount % paintEvery(s, viewer) !== 0) return;
  s.shown = 'game';
  s.handle.painter.drawFrame(frame);
  s.handle.present();
}

// ── The page at the cabinet (arcadeNesCabinet.ts) ───────────────────────────────

export type SharedPhase = 'loading' | 'joining' | 'playing' | 'ended';

/** A shared game on the cabinet, as this page sees it. */
export interface SharedView {
  role: 'host' | 'guest' | 'watcher';
  title: string;
  phase: SharedPhase;
  /** A watcher at a free stand: the player it would play (at a two-player
   *  cabinet, the one the host doesn't), else null. */
  joinAs: number | null;
  /** Player number this page plays (from 1), or null for a watcher. */
  player: number | null;
}

export interface ArcadeLink {
  /** The shared game on this cabinet, or null: the UI shows its own menu. */
  shared(): SharedView | null;
  /** Why starting a game failed last, once (the menu's status line). */
  takeError(): string | null;
  /** Start the cabinet's game here as its host. */
  host(game: CabinetGame): void;
  /** Host: end the game. Guest: hand the seat back. */
  stop(): void;
  /** Take the free seat this page's stand is on, in the running game. */
  join(): void;
  /** This page's pad this frame: the seat it plays, as a pad byte. */
  setButtons(pad: number): void;
  /** Host only: a second pad on this computer plays the other seat while
   *  nobody has joined over the network. */
  setLocalPad2(pad: number): void;
  /** The cabinet's sound while this page is at it. */
  setAudio(sink: ((left: number, right: number) => void) | null, sampleRate: number): void;
  /** The UI is showing its own screen: don't paint over it. */
  setUiScreen(on: boolean): void;
  /** The page left the cabinet: a host's game ends, a guest's seat frees. */
  release(): void;
}

/**
 * Attach the focused page to a cabinet. `seat` is the stand it stands at
 * (0 = player 1's), `seats` how many stands the cabinet has.
 */
export function linkArcade(itemId: string, seat: 0 | 1, seats: 1 | 2): ArcadeLink {
  const link: LinkState = { buttons: 0, localP2: 0, audio: null, sampleRate: 48000, uiScreen: true, error: null };
  /** The room and doc the page stepped up in. Focus can outlive a room
   *  change: in another room this link reads and writes nothing; the same
   *  room rejoined (a new doc) picks the cabinet up again. */
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
      if (copy?.role === 'host') {
        if (copy.failed) return null;
        return {
          role: 'host', title: copy.game.title, phase: copy.started ? 'playing' : 'loading', joinAs: null,
          player: seat === 0 || seats === 1 ? 1 : 2,
        };
      }
      const m = readArcade(itemId);
      if (!m || !copy || !isCopyOf(copy, m)) return null;
      const silent = hostSilentFor(s, copy, Date.now());
      if (silent > HOST_GONE_MS) return null; // gone: the cabinet is free
      const phase: SharedPhase = silent > HOST_SILENT_MS ? 'ended' : copy.started && !copy.needSync ? 'playing' : 'joining';
      if (m.guestPage === PAGE) {
        return { role: 'guest', title: copy.game.title, phase, joinAs: null, player: m.hostSeat === 0 ? 2 : 1 };
      }
      return {
        role: 'watcher', title: copy.game.title, phase,
        joinAs: seats === 2 && m.guestPage === null && seat !== m.hostSeat && phase !== 'ended' && !copy.failed
          ? (m.hostSeat === 0 ? 2 : 1)
          : null,
        player: null,
      };
    },

    takeError(): string | null {
      const e = link.error;
      link.error = null;
      return e;
    },

    host(entry: CabinetGame): void {
      const s = session();
      const game = gameById(entry.id);
      if (!s || !game) return;
      const hostSeat: 0 | 1 = seats === 2 ? seat : 0;
      const copy = newCopy(s, itemId, 0, PAGE, game, 'host');
      const match = newMatch({
        game: game.id, host: getPlayerId(), hostPage: PAGE, hostSeat, now: Date.now(), taken: idsInUse(),
      });
      copy.matchId = match.id;
      copy.pending = match;
      link.error = null;
    },

    stop(): void {
      const s = session();
      if (!s) return;
      const copy = s.copy;
      const m = readArcade(itemId);
      if (copy?.role === 'host') {
        copy.machine?.stop();
        s.copy = null;
        s.shown = null;
        if (m && m.hostPage === PAGE) writeArcade(itemId, null);
        return;
      }
      if (m && m.guestPage === PAGE) writeArcade(itemId, withoutGuest(m, PAGE));
    },

    join(): void {
      const s = session();
      if (!s || s.copy?.failed) return; // a game this page couldn't load: nothing to play
      const m = readArcade(itemId);
      if (!m || seats !== 2 || seat === m.hostSeat) return;
      const next = withGuest(m, getPlayerId(), PAGE);
      if (next && next !== m) writeArcade(itemId, next);
    },

    setButtons(pad: number): void {
      link.buttons = pad & 0xff;
    },

    setLocalPad2(pad: number): void {
      link.localP2 = pad & 0xff;
    },

    setAudio(sink, sampleRate): void {
      link.audio = sink;
      link.sampleRate = sampleRate;
      session()?.copy?.machine?.setSampleRate(sampleRate);
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
      link.audio = null;
      link.buttons = 0;
    },
  };
  return api;
}

// ── Tests and debugging ──────────────────────────────────────────────────────

/** This page's copy of the cabinet's shared game: its role and game, the frame it
 *  runs next, and whether it is running yet. */
export function arcadeCopyInfo(
  itemId: string,
): { role: 'host' | 'follow'; game: string; next: number; started: boolean } | null {
  const copy = sessions.get(itemId)?.copy;
  return copy ? { role: copy.role, game: copy.game.id, next: copy.next, started: copy.started && !copy.needSync } : null;
}

/** Forget every cabinet (tests). */
export function resetArcadeSessions(): void {
  for (const s of sessions.values()) s.copy?.machine?.stop();
  sessions.clear();
}
