/**
 * 🚏📋 Departures — what a station room knows about the ferries that call at
 * it (robot pilot routes, build notes A6 and A9 item 7; owner decision
 * 2026-09-27: the departures board is a DISPLAY, a wide variant of the wall
 * computer, and one station can host several ferries).
 *
 * A ferry's route and checkpoints live in the SHIP's room doc (shipRoute.ts),
 * which a station room never has bound. So each ferry MIRRORS them into the
 * `departures` map of every stop's berth room, and a board there works the
 * timetable out from the clock exactly as the riders' games do
 * (pilotRoute.routeFlightAt): a leg on time is news to nobody, and a station
 * game needs no message to show a ferry leave, fly and arrive.
 *
 *   <shipRoomId>:route:<at>                  DepartureRouteEntry: the ferry's
 *                                            name, ship room id, tank
 *                                            capacity, its route as the ship
 *                                            map holds it (copied stops, run
 *                                            fields; NEVER a pass), and when
 *                                            it was published (<at>, whole
 *                                            ms: one key per snapshot)
 *   <shipRoomId>:ckpt:<run>:<legSeq>:<kind>  one checkpoint, the ship map's
 *                                            own key behind the ferry's id
 *
 * ONE KEY PER EVENT, as in the ship map: a lagging publisher can't put an
 * older checkpoint over a newer one (a key it rewrites keeps the newer
 * observation: a hold's newest seenAt, any other entry's newest `at`), and
 * one reader (pilotRoute's own checks and pruning) serves both sides. The
 * route entry is newest-wins: a newer START (a larger run id) always, STOP
 * over not stopped within one run, otherwise the later publish. The READER
 * picks it (departureRouteNewer over every route key of the ferry), and a
 * writer adds its snapshot under its own key and deletes only the keys it
 * saw: two riders publishing at once both land, and every replica picks the
 * same one, so a stale running snapshot can't win a CRDT tie over a STOP.
 * A route that is no longer running (finished after STOP) takes its
 * checkpoints with it, and the board drops the ferry.
 *
 * WHO WRITES. A rider's game, through departuresWrite.ts: a short background
 * session to each stop's berth room (the farDoorWrite.ts pattern), at START
 * and at each checkpoint it writes, the stop concerned first. It needs a pass
 * for that room, like its keeper's DOCK. applyDeparturesPublish below is the
 * whole decision, pure over the far doc. The board itself only reads.
 *
 * BOARD SETTINGS. A second map, `departureBoards`, keyed by the board's
 * furniture item id: { all: true } (a departures hall) or { gate: N } (a
 * gate-side board showing that gate's ferries). Absent reads as the default:
 * the gate in the board's room when there is exactly one, else all gates
 * (resolved by the caller, who knows the room's gates). Owner-written at the
 * board's console.
 *
 * Trust: honest-client reads, like every room value. Every entry is shape-
 * checked (ids bounded to 128 characters, times finite, the route rebuilt by
 * shipRoute's own guard, which drops any field it does not know, a pass
 * included) and a malformed one reads as absent. Readers visit at most 1024
 * keys, keep at most 16 ferries and 64 checkpoints each. An old client never
 * reads either map (degrade, not corrupt).
 *
 * Pure helpers and the decision are pinned by departuresDoc.test.ts; the
 * board's rows by departuresBoard.test.ts.
 */

import * as Y from 'yjs';
import { checkpointsToPrune, isRouteRunning, stopAt } from './pilotRoute';
import {
  MAX_CHECKPOINT_KEYS_SCANNED,
  capCheckpoints,
  checkpointFromWire,
  checkpointKey,
  checkpointToWire,
  parseCheckpointKey,
  routeToWire,
  shipRouteFromWire,
} from './shipRoute';
import type { RouteCheckpoint, ShipRoute } from './shipRoute';
import { isGateNumber } from './doorPolicy';

// ── Shapes and limits ────────────────────────────────────────────────────────

export const DEPARTURES_MAP = 'departures';
export const DEPARTURE_BOARDS_MAP = 'departureBoards';
/** Ferries a room keeps (the oldest publish goes first when a new one comes). */
export const MAX_DEPARTURE_FERRIES = 16;
/** Keys a reader visits in the departures map. */
export const MAX_DEPARTURE_KEYS_VISITED = 1024;
/** Keys a writer visits (it must see every key of the ferry it tidies). */
const MAX_WRITE_KEYS_VISITED = 8192;
const MAX_ID_LEN = 128;
const MAX_NAME_LEN = 64;
/** A capacity no ship can carry (TANK_CAPACITY 100 a tank): rejected. */
const MAX_CAPACITY = 1e6;
/** How far ahead of the writer's clock a publish stamp may sit. */
const MAX_PUBLISH_SKEW_MS = 6 * 3600 * 1000;

/** One ferry as a station room knows it. */
export interface DepartureFerry {
  shipRoomId: string;
  /** The ship's room name, as its riders see it. */
  name: string;
  /** The tanks' derived capacity when it was published (the timetable ends a
   *  route where its fuel runs out). */
  capacity: number;
  route: ShipRoute;
  /** The publisher's clock when it was published. */
  at: number;
  /** 🏁 A finished route (no run): the run its finish ended. It outranks
   *  every snapshot of that run whatever the clocks say (departureRouteNewer).
   *  Absent: an older publisher's finish, or a route that never ran. */
  endedRun?: number;
  /** The current run's checkpoints, shape-checked, sorted by stay and kind
   *  (empty when the route is not running). */
  checkpoints: readonly RouteCheckpoint[];
}

/** What a rider's game publishes to one stop's room. */
export interface DeparturesPublish {
  shipRoomId: string;
  name: string;
  capacity: number;
  route: ShipRoute;
  /** The ship map's checkpoints of the current run (none after a finish). */
  checkpoints: readonly RouteCheckpoint[];
  at: number;
  /** 🏁 The finish: the run it ended (shipRoute.RouteWriteNotice.run). */
  endedRun?: number;
}

/** A board's console setting. */
export type BoardSetting = { all: true } | { gate: number };

const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN;
/** A run id (route.startedAt): the ship map's own rule. */
const isRunId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

/** What separates a ferry's id from a route snapshot's stamp in its key. */
const ROUTE_TAG = ':route:';

/** A ship room id a departures key can carry unambiguously. */
export function isDepartureShipId(v: unknown): v is string {
  return isId(v) && !v.includes(':ckpt:') && !v.includes(ROUTE_TAG);
}

// ── Keys ─────────────────────────────────────────────────────────────────────

/** A route snapshot's key: the ferry, then its publish stamp in whole ms. */
export function departureRouteKey(shipRoomId: string, at: number): string {
  return `${shipRoomId}${ROUTE_TAG}${Math.max(0, Math.floor(at))}`;
}

export function departureCheckpointKey(shipRoomId: string, run: number, legSeq: number, kind: RouteCheckpoint['kind']): string {
  return `${shipRoomId}:${checkpointKey(run, legSeq, kind)}`;
}

export type DepartureKey =
  | { ship: string; kind: 'route'; version: number }
  | { ship: string; kind: 'ckpt'; run: number; legSeq: number; ckpt: RouteCheckpoint['kind'] };

/** A departures key, or null (canonical spellings only, as the ship map's). */
export function parseDepartureKey(key: unknown): DepartureKey | null {
  if (typeof key !== 'string' || key.length > MAX_ID_LEN + 80) return null;
  const at = key.indexOf(':ckpt:');
  if (at > 0) {
    const ship = key.slice(0, at);
    const ck = parseCheckpointKey(key.slice(at + 1));
    if (!ck || !isDepartureShipId(ship)) return null;
    return { ship, kind: 'ckpt', run: ck.run, legSeq: ck.legSeq, ckpt: ck.kind };
  }
  const r = key.indexOf(ROUTE_TAG);
  if (r > 0) {
    const ship = key.slice(0, r);
    const v = key.slice(r + ROUTE_TAG.length);
    if (!/^(0|[1-9][0-9]*)$/.test(v) || !Number.isSafeInteger(Number(v)) || !isDepartureShipId(ship)) return null;
    return { ship, kind: 'route', version: Number(v) };
  }
  return null;
}

// ── The route entry ──────────────────────────────────────────────────────────

/** The route entry as stored (🏁 `endedRun` only on a route with no run). */
export function departureRouteToWire(f: Pick<DepartureFerry, 'shipRoomId' | 'name' | 'capacity' | 'route' | 'at' | 'endedRun'>): Record<string, unknown> {
  return {
    shipRoomId: f.shipRoomId, name: f.name, capacity: f.capacity, at: f.at, route: routeToWire(f.route),
    ...(f.route.startedAt === undefined && isRunId(f.endedRun) ? { endedRun: f.endedRun } : {}),
  };
}

/** A route entry off the wire under `ship`'s key, cleaned, or null. The route
 *  is rebuilt by shipRoute's own guard (a pass, or any field it does not
 *  know, never survives). */
export function departureRouteFromWire(v: unknown, ship: string): Omit<DepartureFerry, 'checkpoints'> | null {
  if (!isPlainObject(v) || !isDepartureShipId(ship) || v.shipRoomId !== ship) return null;
  if (typeof v.name !== 'string' || v.name.length === 0 || v.name.length > MAX_NAME_LEN) return null;
  if (!(typeof v.capacity === 'number' && Number.isFinite(v.capacity) && v.capacity >= 0 && v.capacity <= MAX_CAPACITY)) return null;
  if (!(typeof v.at === 'number' && Number.isFinite(v.at) && v.at >= 0)) return null;
  const route = shipRouteFromWire(v.route);
  if (!route) return null;
  // 🏁 A bad or misplaced endedRun is dropped, never the entry.
  const endedRun = route.startedAt === undefined && isRunId(v.endedRun) ? v.endedRun : undefined;
  return { shipRoomId: ship, name: v.name, capacity: v.capacity, at: v.at, route, ...(endedRun !== undefined ? { endedRun } : {}) };
}

/** Does route entry `a` replace `b`? 🏁 A finish that names its run beats
 *  every snapshot of that run (and of older ones), and nothing from those
 *  runs beats it back, whatever the publishers' clocks say (a rider's
 *  running snapshot can carry a later `at` than the finish: clock skew, or a
 *  checkpoint written just before the finish reached it); a newer START
 *  beats the finish. Otherwise a newer START always; within one run, STOP
 *  over not stopped; otherwise the later publish (a tie keeps `b`). */
export function departureRouteNewer(
  a: Pick<DepartureFerry, 'route' | 'at' | 'endedRun'>,
  b: Pick<DepartureFerry, 'route' | 'at' | 'endedRun'>,
): boolean {
  const ra = a.route.startedAt;
  const rb = b.route.startedAt;
  const ea = ra === undefined && isRunId(a.endedRun) ? a.endedRun : undefined;
  const eb = rb === undefined && isRunId(b.endedRun) ? b.endedRun : undefined;
  if (ea !== undefined && rb !== undefined) return ea >= rb;
  if (eb !== undefined && ra !== undefined) return ra > eb;
  if (ea !== undefined && eb !== undefined && ea !== eb) return ea > eb;
  if (ra !== undefined && rb !== undefined && ra !== rb) return ra > rb;
  if (ra !== undefined && ra === rb) {
    const sa = a.route.stoppedAt !== undefined;
    const sb = b.route.stoppedAt !== undefined;
    if (sa !== sb) return sa;
  }
  return a.at > b.at;
}

/** Of a ferry's route keys, the one every replica reads: the newest by
 *  departureRouteNewer, a tie to the larger key (replicas iterate in their
 *  own order). */
function newestRouteEntry<T extends { key: string; entry: Omit<DepartureFerry, 'checkpoints'> }>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const c of list) {
    if (!best || departureRouteNewer(c.entry, best.entry)
      || (!departureRouteNewer(best.entry, c.entry) && c.key > best.key)) best = c;
  }
  return best;
}

/** The observation a checkpoint key's value carries: a hold's newest
 *  sighting, any other entry's `at`. A rewrite of one key keeps the newer. */
function observedAt(e: RouteCheckpoint): number {
  return e.kind === 'hold' ? Math.max(e.at, e.seenAt) : e.at;
}

// ── Reading a room's departures (pure over a map) ────────────────────────────

/**
 * Every ferry a departures map holds, shape-checked, capped, sorted by ship
 * room id (replicas iterate in their own order). A ferry's checkpoints are
 * its route's current run only.
 */
export function departureFerriesIn(map: Y.Map<unknown>): DepartureFerry[] {
  const candidates = new Map<string, Array<{ key: string; entry: Omit<DepartureFerry, 'checkpoints'> }>>();
  const ckpts = new Map<string, Array<{ run: number; e: RouteCheckpoint }>>();
  let visited = 0;
  for (const [key, value] of map.entries()) {
    if (++visited > MAX_DEPARTURE_KEYS_VISITED) break;
    const k = parseDepartureKey(key);
    if (!k) continue;
    if (k.kind === 'route') {
      const entry = departureRouteFromWire(value, k.ship);
      if (entry) candidates.set(k.ship, [...(candidates.get(k.ship) ?? []), { key, entry }]);
      continue;
    }
    const list = ckpts.get(k.ship) ?? [];
    const e = checkpointFromWire(k.ckpt, k.legSeq, value);
    if (!e) continue;
    list.push({ run: k.run, e });
    ckpts.set(k.ship, list);
  }
  const out: DepartureFerry[] = [];
  for (const ship of [...candidates.keys()].sort()) {
    if (out.length >= MAX_DEPARTURE_FERRIES) break;
    const entry = newestRouteEntry(candidates.get(ship)!)!.entry;
    const run = entry.route.startedAt;
    // The same cap as the ship's own reader, picked by stay (never by this
    // copy's key order), so every board reads a ferry alike.
    const mine = run === undefined
      ? []
      : capCheckpoints((ckpts.get(ship) ?? [])
        .filter(({ run: r, e }) => r === run && e.stationId === entry.route.stops[stopAt(entry.route, e.legSeq)]?.stationId)
        .map(({ e }) => e), MAX_CHECKPOINT_KEYS_SCANNED);
    out.push({ ...entry, checkpoints: mine });
  }
  return out;
}

// ── The publish, applied to a stop's room (pure over its doc) ───────────────

/** A publish cleaned as the far room will store it, or null. */
export function cleanDeparturesPublish(pub: DeparturesPublish, now: number): DeparturesPublish | null {
  if (!isDepartureShipId(pub.shipRoomId)) return null;
  const name = typeof pub.name === 'string' ? pub.name.trim().slice(0, MAX_NAME_LEN) : '';
  const route = shipRouteFromWire(routeToWire(pub.route));
  if (!route) return null;
  if (!(Number.isFinite(pub.capacity) && pub.capacity >= 0 && pub.capacity <= MAX_CAPACITY)) return null;
  if (!(Number.isFinite(pub.at) && pub.at >= 0 && pub.at <= now + MAX_PUBLISH_SKEW_MS)) return null;
  const run = route.startedAt;
  const checkpoints: RouteCheckpoint[] = [];
  if (run !== undefined) {
    for (const e of pub.checkpoints) {
      const clean = checkpointFromWire(e.kind, e.legSeq, checkpointToWire(e));
      if (!clean || clean.stationId !== route.stops[stopAt(route, clean.legSeq)]?.stationId) continue;
      checkpoints.push(clean);
    }
  }
  const endedRun = run === undefined && isRunId(pub.endedRun) ? pub.endedRun : undefined;
  return {
    shipRoomId: pub.shipRoomId, name: name || 'FERRY', capacity: pub.capacity, route, checkpoints, at: pub.at,
    ...(endedRun !== undefined ? { endedRun } : {}),
  };
}

/**
 * Apply one ferry's publish to a stop room's doc: the far writer's whole
 * decision, in ONE transaction. The route entry is replaced when the publish
 * is newer (departureRouteNewer); the checkpoints of the entry's run are
 * merged key by key, a rewritten key keeping the newer observation; the
 * ferry's keys from any other run go, and so do the entries the timetable's
 * own pruning drops (pilotRoute.checkpointsToPrune). A new ferry in a full
 * map evicts the one published longest ago. Returns whether it wrote.
 */
export function applyDeparturesPublish(doc: Y.Doc, input: DeparturesPublish, now = Date.now()): { wrote: boolean } {
  if ((doc as { isDestroyed?: boolean }).isDestroyed) return { wrote: false };
  const pub = cleanDeparturesPublish(input, now);
  if (!pub) return { wrote: false };
  const map = doc.getMap<unknown>(DEPARTURES_MAP);
  const ship = pub.shipRoomId;

  // Every key of this ferry (and, for the cap, every other ferry's route
  // keys, its newest entry's stamp).
  const mineKeys: Array<{ key: string; k: Extract<DepartureKey, { kind: 'ckpt' }> }> = [];
  const mineRoutes: Array<{ key: string; entry: Omit<DepartureFerry, 'checkpoints'> }> = [];
  const mineRouteKeys: string[] = [];
  const otherRoutes = new Map<string, { at: number; keys: string[] }>();
  let visited = 0;
  for (const key of map.keys()) {
    if (++visited > MAX_WRITE_KEYS_VISITED) break;
    const k = parseDepartureKey(key);
    if (!k) continue;
    if (k.kind === 'ckpt' && k.ship === ship) mineKeys.push({ key, k });
    if (k.kind !== 'route') continue;
    const e = departureRouteFromWire(map.get(key), k.ship);
    if (k.ship === ship) {
      mineRouteKeys.push(key);
      if (e) mineRoutes.push({ key, entry: e });
      continue;
    }
    const o = otherRoutes.get(k.ship) ?? { at: Number.NEGATIVE_INFINITY, keys: [] };
    o.keys.push(key);
    if (e) o.at = Math.max(o.at, e.at);
    otherRoutes.set(k.ship, o);
  }
  const newest = newestRouteEntry(mineRoutes);
  const existing = newest?.entry ?? null;
  const takes = !existing || departureRouteNewer(pub, existing);
  const kept = takes ? pub : existing!;
  const keepKey = takes ? departureRouteKey(ship, pub.at) : newest!.key;
  const run = kept.route.startedAt;
  const others = [...otherRoutes].map(([s2, o]) => ({ ship: s2, ...o }));

  let wrote = false;
  const set = (key: string, value: unknown) => {
    if (JSON.stringify(map.get(key)) === JSON.stringify(value)) return;
    map.set(key, value);
    wrote = true;
  };
  const del = (key: string) => {
    if (!map.has(key)) return;
    map.delete(key);
    wrote = true;
  };

  doc.transact(() => {
    if (takes) set(keepKey, departureRouteToWire(pub));
    // Only the keys this writer saw: a snapshot another rider is writing
    // right now lands beside the kept one, and readers pick between them.
    for (const key of mineRouteKeys) if (key !== keepKey) del(key);
    // Other runs' keys go (and every key once the route stops running).
    const current = new Map<string, RouteCheckpoint>();
    for (const { key, k } of mineKeys) {
      if (run === undefined || k.run !== run) { del(key); continue; }
      const e = checkpointFromWire(k.ckpt, k.legSeq, map.get(key));
      if (e) current.set(key, e); else del(key);
    }
    // This run's entries, one key per event, the newer observation kept.
    if (run !== undefined && pub.route.startedAt === run) {
      for (const e of pub.checkpoints) {
        const key = departureCheckpointKey(ship, run, e.legSeq, e.kind);
        const old = current.get(key);
        if (old && observedAt(old) >= observedAt(e)) continue;
        set(key, checkpointToWire(e));
        current.set(key, e);
      }
    }
    // The timetable's own pruning, over what the room now holds.
    if (run !== undefined) {
      const byEntry = new Map<RouteCheckpoint, string>();
      for (const [key, e] of current) byEntry.set(e, key);
      for (const e of checkpointsToPrune(kept.route, [...current.values()], now)) {
        const key = byEntry.get(e);
        if (key) del(key);
      }
    }
    // A full room lets the ferry published longest ago go.
    if (!existing && takes && others.length >= MAX_DEPARTURE_FERRIES) {
      others.sort((a, b) => a.at - b.at || (a.ship < b.ship ? -1 : 1));
      for (const gone of others.slice(0, others.length - MAX_DEPARTURE_FERRIES + 1)) {
        for (const key of gone.keys) del(key);
        let n = 0;
        for (const key of [...map.keys()]) {
          if (++n > MAX_WRITE_KEYS_VISITED) break;
          const k = parseDepartureKey(key);
          if (k && k.kind === 'ckpt' && k.ship === gone.ship) del(key);
        }
      }
    }
  });
  return { wrote };
}

/**
 * The berth rooms a publish goes to, in order: the stop the event concerns
 * first (the stay's stop; START's stop), then every other stop's, each once.
 * `legSeq` null: the route's first stop leads.
 */
export function publishRoomOrder(route: ShipRoute, legSeq: number | null): string[] {
  const out: string[] = [];
  const add = (roomId: string | undefined) => {
    if (roomId && !out.includes(roomId)) out.push(roomId);
  };
  if (route.stops.length > 0) {
    const first = legSeq === null || !isRouteRunning(route)
      ? (route.startStop ?? 0)
      : stopAt(route, legSeq);
    add(route.stops[first]?.berth.roomId);
  }
  for (const s of route.stops) add(s.berth.roomId);
  return out;
}

// ── Board settings ───────────────────────────────────────────────────────────

export function boardSettingFromWire(v: unknown): BoardSetting | null {
  if (!isPlainObject(v)) return null;
  if (v.all === true && v.gate === undefined) return { all: true };
  if (v.all === undefined && isGateNumber(v.gate)) return { gate: v.gate as number };
  return null;
}

/** The gate a board shows: its setting, else the room's one gate, else all
 *  (null). */
export function boardGate(setting: BoardSetting | null, roomGates: readonly number[]): number | null {
  if (setting && 'gate' in setting) return setting.gate;
  if (setting && 'all' in setting) return null;
  const distinct = [...new Set(roomGates)];
  return distinct.length === 1 ? distinct[0] : null;
}

// ── The binding (the room the player stands in) ──────────────────────────────

let boundDoc: Y.Doc | null = null;
let depMap: Y.Map<unknown> | null = null;
let boardMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();
let version = 0;

function notify(): void {
  version++;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[departures] listener threw during doc notify:', err);
    }
  }
}

function docAlive(): boolean {
  return boundDoc !== null && !(boundDoc as { isDestroyed?: boolean }).isDestroyed
    && depMap !== null && boardMap !== null;
}

/** Bind the room doc: main.ts's T0 seam, beside bindRobotDoc. */
export function bindDeparturesDoc(doc: Y.Doc): void {
  boundDoc = doc;
  depMap = doc.getMap(DEPARTURES_MAP);
  boardMap = doc.getMap(DEPARTURE_BOARDS_MAP);
  depMap.observe(() => notify());
  boardMap.observe(() => notify());
  notify();
}

export function subscribeDepartures(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The same objects come back until the map changes, so a board's timetable
// walk cache (pilotRoute.RouteWalkCache) recognises them.
let snap: { version: number; doc: Y.Doc | null; ferries: DepartureFerry[] } | null = null;

/** The ferries this room's departures map holds. */
export function readDepartureFerries(): readonly DepartureFerry[] {
  if (!docAlive()) return [];
  if (snap && snap.version === version && snap.doc === boundDoc) return snap.ferries;
  snap = { version, doc: boundDoc, ferries: departureFerriesIn(depMap!) };
  return snap.ferries;
}

/** A board's console setting, or null (the default). */
export function readBoardSetting(itemId: string): BoardSetting | null {
  if (!docAlive() || !isId(itemId)) return null;
  return boardSettingFromWire(boardMap!.get(itemId));
}

/** Save a board's setting (null: back to the default). Owner-gated at the
 *  caller (the board's console). Returns whether it wrote. */
export function writeBoardSetting(itemId: string, setting: BoardSetting | null): boolean {
  if (!docAlive() || !isId(itemId)) return false;
  if (setting !== null && !boardSettingFromWire(setting)) return false;
  boundDoc!.transact(() => {
    if (setting === null) boardMap!.delete(itemId);
    else boardMap!.set(itemId, 'gate' in setting ? { gate: setting.gate } : { all: true });
  });
  return true;
}
