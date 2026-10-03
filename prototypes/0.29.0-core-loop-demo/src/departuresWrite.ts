/**
 * 🚏📋📡 Departures writes — a rider's game tells each stop's board about its
 * ferry (robot pilot routes, build notes A6; owner decisions 2026-09-27:
 * announcements aboard AND on boards, the schedule belongs to the ship).
 *
 * A ferry's route and checkpoints live in the SHIP's room doc. A stop's board
 * lives in the STATION's berth room, which the rider's game does not have
 * bound. So, modeled on farDoorWrite.ts (which carries door records the same
 * way): a short-lived background session to the berth room's doc on the
 * local node, which waits until the replica holds real state (for a room
 * hosted elsewhere, a fresh answer from its live host), applies ONE publish
 * (departuresDoc.applyDeparturesPublish: the ferry's route entry and its
 * checkpoints, one key per event), waits for the node's acknowledgment, and
 * hangs up. It needs a pass for the berth room, as the keeper's DOCK does,
 * and never writes one: the publish carries room and door ids only.
 *
 * WHEN (createDeparturesPublisher). The game that WRITES a route change
 * publishes it: START, each checkpoint (a hold, its renewal, the dock that
 * ends it, a skip, a DEPART, a handover, REFUEL, PAUSE, RESUME), STOP, and
 * the finish after STOP (which takes the ferry off the boards). It hears
 * them from shipRoute.onRouteWritten, waits for the gesture to end (one
 * helm press may write several entries), and sends one snapshot of the whole
 * route and run: the stop the change concerns first, every other stop once
 * that one has answered. ⛽ So does a tank fitted or taken off while the
 * route runs, from the game that edits the ship (tanksChanged): the boards
 * work every leg out with the capacity a snapshot carries. On-time legs
 * publish nothing: every board works the timetable out from the clock.
 *
 * Best effort, like the far dock write: per berth room one session at a
 * time, and only each ferry's NEWEST snapshot waits behind it (a hold
 * renewed every minute never queues up; another ferry this game rode never
 * displaces it). An unreachable room is retried twice, 30 s and
 * then 60 s later, unless newer news replaced it (🔁 a retry that comes due
 * after a newer snapshot was offered to that room is dropped, even when the
 * newer one has already been delivered: re-sending the older one would only
 * spend a session, and a board ranks it below the newer one anyway); 🔢 an
 * older snapshot never replaces newer news offered to a room, so one sent on
 * to the other stops late (its first stop was slow) neither overwrites a
 * finish offered there since nor drops that finish's retry; the
 * finish carries the run it ended (🏁 endedRun), so a board ranks it above
 * any late snapshot of that run; a room this game holds no
 * pass for is skipped (another rider may reach it, and the planet's ship
 * summaries carry the ferry to all-gates boards anyway). Never throws.
 *
 * The session is this file; the decision is departuresDoc.ts (pure over the
 * far doc, pinned by departuresDoc.test.ts); the publisher's scheduling is
 * pinned by departuresWrite.test.ts with a fake writer and clock.
 */

import * as Y from 'yjs';
import { NetworkProvider } from './network/NetworkProvider';
import { YjsSync } from './network/YjsSync';
import type { RoomBootstrap } from './network/protocol';
import { ysyncSigner } from './keypair';
import { roomStateArrived, underWriteDeadline, withTimeout } from './farDoorWrite';
import { applyDeparturesPublish, publishRoomOrder } from './departuresDoc';
import type { DeparturesPublish } from './departuresDoc';
import { isRouteRunning } from './pilotRoute';
import type { RouteCheckpoint, RouteWriteNotice, ShipRoute } from './shipRoute';

// ── The session ──────────────────────────────────────────────────────────────

/** What a publish to one room came to. */
export type DeparturesWriteResult = 'written' | 'unchanged' | 'unreachable' | 'no-address';

/** The same seams farDoorWrite.ts is given (main.ts wires both alike). */
export interface DeparturesWriteDeps {
  decode: (seed: string) => RoomBootstrap | null;
  resolve: (boot: RoomBootstrap) => Promise<RoomBootstrap>;
  hostedHere: (roomId: string) => boolean;
  activeRoomDoc: (roomId: string) => Y.Doc | null;
}

let deps: DeparturesWriteDeps | null = null;

export function initDeparturesWrite(d: DeparturesWriteDeps): void {
  deps = d;
}

const READY_TIMEOUT_MS = 10_000;
const HOST_READY_TIMEOUT_MS = 20_000;
const ACK_TIMEOUT_MS = 5_000;
const SESSION_DEADLINE_MS = 60_000;

const queues = new Map<string, Promise<unknown>>();

/**
 * Publish one ferry snapshot to the room `address` names (a pass for it).
 * Serialized per room. Never throws.
 */
export function writeDepartures(address: string, pub: DeparturesPublish): Promise<DeparturesWriteResult> {
  const d = deps;
  if (!d) return Promise.resolve('unreachable');
  const imported = d.decode(address);
  if (!imported) return Promise.resolve('no-address');
  const key = imported.roomId;
  const write = () => {
    // The board's room is the one this game stands in: its bound doc.
    const here = d.activeRoomDoc(imported.roomId);
    if (here) return Promise.resolve(applyDeparturesPublish(here, pub).wrote ? 'written' as const : 'unchanged' as const);
    return underWriteDeadline<DeparturesWriteResult>(
      (mayWrite) => session(d, imported, pub, mayWrite),
      SESSION_DEADLINE_MS,
      () => 'unreachable',
    );
  };
  const prior = queues.get(key) ?? Promise.resolve();
  const run = prior.then(write, write);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run.catch(() => 'unreachable' as const);
}

async function session(
  d: DeparturesWriteDeps,
  imported: RoomBootstrap,
  pub: DeparturesPublish,
  mayWrite: () => boolean,
): Promise<DeparturesWriteResult> {
  let provider: NetworkProvider | null = null;
  let sync: YjsSync | null = null;
  try {
    const boot = await d.resolve(imported);
    provider = new NetworkProvider();
    const p = provider;
    await withTimeout(p.connect(boot), READY_TIMEOUT_MS, 'board room dial');
    const channel = await withTimeout(p.openChannel('ysync'), READY_TIMEOUT_MS, 'board room channel');
    sync = new YjsSync({
      roomId: boot.roomId,
      channel,
      ...ysyncSigner(),
      bootRecord: () => p.getBootRecord(),
    });
    const s = sync;
    p.onEnvelope((env: { kind?: string; room?: string; payload?: string }) => {
      if (env.kind === 'ysync') {
        s.ingestEnvelope(env);
        return;
      }
      if (env.kind === 'bridge' && typeof env.payload === 'string') {
        try {
          if (JSON.parse(atob(env.payload))?.status === 'connected') {
            s.markPeerLinked();
            s.resync();
          }
        } catch {
          /* non-JSON bridge payload */
        }
      }
    });
    await s.start();
    const hostedHere = d.hostedHere(boot.roomId);
    if (!hostedHere) s.markPeerLinked();
    const readyWithin = hostedHere ? READY_TIMEOUT_MS : HOST_READY_TIMEOUT_MS;
    if (!(await roomStateArrived(s, readyWithin, hostedHere))) {
      console.warn(`[departures] ${boot.roomId}: no room state within ${readyWithin} ms`);
      return 'unreachable';
    }
    if (!mayWrite()) return 'unreachable';
    // Read-before-write, as the far dock write: the merge sees the board
    // room's real entries, so a newer one there is kept.
    const since = Y.encodeStateVector(s.doc);
    const { wrote } = applyDeparturesPublish(s.doc, pub);
    if (!wrote) return 'unchanged';
    if (!(await s.confirmOwnWrites(since, ACK_TIMEOUT_MS))) {
      console.warn(`[departures] ${boot.roomId}: the node did not acknowledge the write`);
      return 'unreachable';
    }
    console.log(`🚏 Departures → ${boot.roomId}: ${pub.name} (${pub.checkpoints.length} checkpoints)`);
    return 'written';
  } catch (err) {
    console.warn('[departures] board room session failed:', err);
    return 'unreachable';
  } finally {
    const closing = { sync, provider };
    void closing.sync?.stop().catch(() => undefined);
    void closing.provider?.disconnect().catch(() => undefined);
  }
}

// ── The publisher (which rooms, when) ────────────────────────────────────────

/** Retries of an unreachable room: 30 s, then 60 s. */
export const DEPARTURES_RETRY_MS: readonly number[] = [30_000, 60_000];

export interface DeparturesPublisherDeps {
  /** The ship room this game stands in ('' when none). */
  shipRoomId: () => string;
  /** The ship's name, as its riders see it. */
  shipName: () => string;
  /** The tanks' derived capacity. */
  capacity: () => number;
  route: () => ShipRoute | null;
  checkpoints: () => readonly RouteCheckpoint[];
  /** A pass this game holds for a room, or undefined. */
  seedFor: (roomId: string) => string | undefined;
  write: (address: string, pub: DeparturesPublish) => Promise<DeparturesWriteResult>;
  /** ⛽ Does this game edit the ship's parts (the room's owner: editMode's
   *  gate)? Only it republishes a change of the tanks (tanksChanged), so a
   *  change goes out once, not once per rider. Default: yes. */
  editsShip?: () => boolean;
  clock?: () => number;
  /** setTimeout (tests pass their own). */
  later?: (fn: () => void, ms: number) => void;
}

export interface DeparturesPublisher {
  /** Hear one of this game's route writes (shipRoute.onRouteWritten). */
  routeWritten: (n: RouteWriteNotice) => void;
  /** ⛽ Hear a change to the room's furniture: a tank fitted or taken off
   *  changes the capacity every board works the timetable out with. */
  tanksChanged: () => void;
  /** Rooms with a publish in flight or waiting (tests). */
  busyRooms: () => string[];
}

/** One ferry's news for one berth room (keyed by both: a player who boards
 *  another ferry must not drop the first one's snapshot or its retry). */
interface RoomState {
  room: string;
  /** The newest snapshot of this ferry waiting for this room. */
  waiting: DeparturesPublish | null;
  /** 🔁 The newest snapshot of this ferry ever offered to this room (a retry
   *  of any other is stale). */
  latest: DeparturesPublish | null;
  /** 🔢 Its place in the order this game took its snapshots (0: none yet).
   *  An offer of an older one is dropped. */
  latestSeq: number;
  busy: boolean;
  /** Retries spent on the snapshot now being sent. */
  retries: number;
  /** The offers answered once this room answers the snapshot in `waiting`
   *  (or a newer one that replaced it before it went). */
  waiters: Array<() => void>;
}

/**
 * The publisher main.ts installs once. It snapshots the route after the
 * gesture that wrote it, and sends it to every stop's berth room: the stop
 * the write concerns first, the rest once that one has answered.
 */
export function createDeparturesPublisher(d: DeparturesPublisherDeps): DeparturesPublisher {
  const clock = d.clock ?? Date.now;
  const later = d.later ?? ((fn, ms) => { setTimeout(fn, ms); });
  /** Per (berth room, ferry): writeDepartures still runs one session per
   *  room at a time. */
  const rooms = new Map<string, RoomState>();
  let pending: { ship: string; legSeq: number | null; endedRun?: number } | null = null;
  /** ⛽ Per ferry, the capacity this game last saw (or published). */
  const tanksSeen = new Map<string, number>();
  /** Per ferry, its newest snapshot and every room it goes to. */
  const newest = new Map<string, { pub: DeparturesPublish; rooms: ReadonlySet<string> }>();
  /** 🔢 Snapshots taken so far: each one's place in their order. Not their
   *  `at`: two snapshots can be taken in the same millisecond. */
  let taken = 0;

  const stateOf = (room: string, ship: string): RoomState => {
    const key = `${room}\n${ship}`;
    let st = rooms.get(key);
    if (!st) {
      st = { room, waiting: null, latest: null, latestSeq: 0, busy: false, retries: 0, waiters: [] };
      rooms.set(key, st);
    }
    return st;
  };

  /** Send what waits for this room from this ferry, and answer its offers
   *  once the room has answered it. */
  const pump = async (st: RoomState): Promise<void> => {
    const room = st.room;
    if (st.busy || !st.waiting) return;
    const pub = st.waiting;
    st.waiting = null;
    const answered = st.waiters;
    st.waiters = [];
    const done = () => { for (const w of answered) w(); };
    let seed: string | undefined;
    try {
      seed = d.seedFor(room);
    } catch {
      seed = undefined;
    }
    if (!seed) {
      st.retries = 0;
      done();
      return;
    }
    st.busy = true;
    let result: DeparturesWriteResult = 'unreachable';
    try {
      result = await d.write(seed, pub);
    } catch {
      result = 'unreachable';
    }
    st.busy = false;
    done();
    if (result === 'unreachable' && !st.waiting && st.retries < DEPARTURES_RETRY_MS.length) {
      const wait = DEPARTURES_RETRY_MS[st.retries];
      st.retries++;
      later(() => {
        // 🔁 Newer news was offered meanwhile (and sent, or waiting): this
        // snapshot is stale, whatever became of the newer one.
        if (st.latest !== pub) return;
        if (!st.waiting) st.waiting = pub;
        void pump(st);
      }, wait);
      return;
    }
    st.retries = 0;
    if (st.waiting) void pump(st);
  };

  /** Offer a snapshot (the `seq`th taken) to a room. Resolves once the room
   *  has answered it (or a newer snapshot that replaced it while the room was
   *  busy), never sooner: a busy room answers its current write first. 🔢 An
   *  older snapshot than one already offered there goes nowhere, and resolves
   *  at once: it would replace newer news, and drop that news's retry. */
  const offer = (room: string, pub: DeparturesPublish, seq: number): Promise<void> => {
    const st = stateOf(room, pub.shipRoomId);
    if (seq <= st.latestSeq) return Promise.resolve();
    st.waiting = pub;
    st.latest = pub;
    st.latestSeq = seq;
    st.retries = 0;
    const answered = new Promise<void>((resolve) => { st.waiters.push(resolve); });
    void pump(st);
    return answered;
  };

  const flush = (): void => {
    const p = pending;
    pending = null;
    if (!p) return;
    const ship = d.shipRoomId();
    // The player left the ship's room before the gesture ended: the doc now
    // bound is another room's.
    if (!ship || ship !== p.ship) return;
    const route = d.route();
    if (!route) return;
    const capacity = d.capacity();
    tanksSeen.set(ship, capacity);
    const pub: DeparturesPublish = {
      shipRoomId: ship,
      name: d.shipName(),
      capacity,
      route,
      checkpoints: isRouteRunning(route) ? [...d.checkpoints()] : [],
      at: clock(),
      // 🏁 The finish names the run it ended (only while no run follows it).
      ...(p.endedRun !== undefined && route.startedAt === undefined ? { endedRun: p.endedRun } : {}),
    };
    const order = publishRoomOrder(route, p.legSeq);
    if (order.length === 0) return;
    const [first, ...rest] = order;
    const seq = ++taken;
    newest.set(ship, { pub, rooms: new Set(order) });
    void offer(first, pub, seq).then(() => {
      // A snapshot a newer one replaced at the first room, or overtook while
      // it was sent, goes on to none of the newer one's rooms: that one goes
      // there in its place (a finish still reaches the stops only its route
      // served).
      const n = newest.get(ship);
      for (const room of rest) {
        if (n && n.pub !== pub && n.rooms.has(room)) continue;
        void offer(room, pub, seq);
      }
    });
  };

  /** Publish once the gesture has ended: several writes in one gesture
   *  send one snapshot, and the first that names a stay names the stop. */
  const want = (ship: string, legSeq: number | null, ended?: number): void => {
    if (pending && pending.ship === ship) {
      if (pending.legSeq === null && legSeq !== null) pending.legSeq = legSeq;
      if (ended !== undefined) pending.endedRun = ended;
      return;
    }
    pending = { ship, legSeq, ...(ended !== undefined ? { endedRun: ended } : {}) };
    later(flush, 0);
  };

  /** ⛽ The boards hold the capacity of the last publish, and a board works
   *  every leg out with it (where the fuel runs out, the home refill). A
   *  running route's timetable follows the tanks fitted now, so when they
   *  change, the game that edits the ship sends a snapshot with the new
   *  capacity. Read once the change has settled (every furniture listener
   *  has run); the first reading of a ferry is only noted. */
  const checkTanks = (): void => {
    const ship = d.shipRoomId();
    if (!ship) return;
    const capacity = d.capacity();
    const seen = tanksSeen.get(ship);
    tanksSeen.set(ship, capacity);
    if (seen === undefined || seen === capacity) return;
    if (!isRouteRunning(d.route()) || !(d.editsShip?.() ?? true)) return;
    want(ship, null);
  };
  // The room this page opened on was bound before this publisher existed,
  // and no furniture change will say so: its tanks now are its first
  // reading, so the first fit or removal after is a change.
  {
    const ship = d.shipRoomId();
    if (ship) tanksSeen.set(ship, d.capacity());
  }

  return {
    routeWritten: (n) => {
      const ship = d.shipRoomId();
      if (!ship) return;
      want(ship, n.legSeq ?? null, n.kind === 'finish' && n.run !== undefined ? n.run : undefined);
    },
    tanksChanged: () => later(checkTanks, 0),
    busyRooms: () => [...new Set([...rooms.values()].filter((st) => st.busy || st.waiting !== null).map((st) => st.room))],
  };
}
