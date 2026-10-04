/**
 * 🚏📋📡 Departures writes — when a rider's game publishes its ferry to the
 * stops' boards (build notes A6): after the gesture that wrote the route
 * (one snapshot for several writes), the stop the change concerns first and
 * every other stop once it has answered, only the newest snapshot waiting
 * behind a busy room, two retries of an unreachable one, nothing for a room
 * it holds no pass for or once it has left the ship, and each stop's pass
 * kept from the snapshot's taking. And shipRoute tells it about each of this
 * game's own writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { DEPARTURES_RETRY_MS, createDeparturesPublisher } from './departuresWrite';
import type { DeparturesPublisherDeps, DeparturesWriteResult } from './departuresWrite';
import type { DeparturesPublish } from './departuresDoc';
import { holdCheckpoint, startCheckpoint } from './pilotRoute';
import { bindShipDoc, writeFuelLevel } from './shipDoc';
import {
  finishShipRoute,
  onRouteWritten,
  readShipRoute,
  startShipRoute,
  stopShipRoute,
  writeRouteCheckpoint,
  writeShipRoute,
} from './shipRoute';
import type { RouteCheckpoint, RouteStop, RouteWriteNotice, ShipRoute } from './shipRoute';

const SOV = 'planet-sovereign';
const T0 = Date.UTC(2026, 8, 27, 14, 0, 0);
const SHIP = 'ship-room-1';

function stop(i: number, slot: number): RouteStop {
  return {
    stationId: `st-${i}`,
    name: `Stop ${i}`,
    planetId: SOV,
    orbitSlot: slot,
    berth: { roomId: `room-${i}`, farDoor: 'x+', anyGate: true },
    waitSecs: 60,
  };
}

function running(): ShipRoute {
  return {
    stops: [stop(0, 0), stop(1, 1), stop(2, 2)],
    shape: 'loop',
    shipPort: 'x-',
    startedAt: T0,
    startStop: 0,
  };
}

/** A publisher over a fake writer and a hand-driven timer queue. */
function harness(over: Partial<DeparturesPublisherDeps> = {}) {
  let route: ShipRoute | null = running();
  let ckpts: RouteCheckpoint[] = [startCheckpoint(route, { at: T0, pilot: 'person', fuel: 100 })!];
  let ship = SHIP;
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const calls: Array<{ address: string; pub: DeparturesPublish; resolve: (r: DeparturesWriteResult) => void }> = [];
  const p = createDeparturesPublisher({
    shipRoomId: () => ship,
    shipName: () => 'Ferry One',
    capacity: () => 100,
    route: () => route,
    checkpoints: () => ckpts,
    seedFor: (room) => `pass:${room}`,
    write: (address, pub) => new Promise((resolve) => calls.push({ address, pub, resolve })),
    clock: () => T0 + 5000,
    later: (fn, ms) => { timers.push({ fn, ms }); },
    ...over,
  });
  const tick = async (ms?: number) => {
    const due = timers.splice(0, timers.length);
    const keep: typeof due = [];
    for (const t of due) {
      if (ms === undefined ? t.ms === 0 : t.ms <= ms) t.fn();
      else keep.push(t);
    }
    timers.push(...keep);
    await Promise.resolve();
    await Promise.resolve();
  };
  const answer = async (i: number, r: DeparturesWriteResult) => {
    calls[i].resolve(r);
    for (let k = 0; k < 6; k++) await Promise.resolve();
  };
  return {
    p, calls, timers, tick, answer,
    setRoute: (r: ShipRoute | null) => { route = r; },
    setCkpts: (c: RouteCheckpoint[]) => { ckpts = c; },
    setShip: (s: string) => { ship = s; },
  };
}

describe('the departures publisher', () => {
  it('one snapshot per gesture: the stop concerned first, the rest once it has answered', async () => {
    const h = harness();
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 2 });
    expect(h.calls).toHaveLength(0); // waits for the gesture to end
    await h.tick();
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1']);
    const pub = h.calls[0].pub;
    expect(pub).toMatchObject({ shipRoomId: SHIP, name: 'Ferry One', capacity: 100, at: T0 + 5000 });
    expect(pub.checkpoints.map((e) => e.kind)).toEqual(['start']);
    expect(JSON.stringify(pub)).not.toContain('pass:');
    await h.answer(0, 'written');
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-0', 'pass:room-2']);
  });

  it('a busy room gets only the newest snapshot after it', async () => {
    const h = harness();
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick();
    await h.answer(0, 'written');
    expect(h.calls).toHaveLength(3);
    // room-1 is still busy with the first snapshot; two more gestures land.
    const route = running();
    const s = startCheckpoint(route, { at: T0, pilot: 'person', fuel: 100 })!;
    h.setCkpts([s, holdCheckpoint(route, 1, { at: s.arriveAt + 1000 })]);
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 0 });
    await h.tick();
    await h.answer(3, 'written'); // room-0 took the second
    h.setCkpts([s, holdCheckpoint(route, 1, { at: s.arriveAt + 2000 })]);
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 0 });
    await h.tick();
    await h.answer(4, 'written'); // room-0 took the third
    await h.answer(1, 'written'); // room-1 answers the FIRST snapshot
    const toRoom1 = h.calls.filter((c) => c.address === 'pass:room-1');
    expect(toRoom1).toHaveLength(2);
    expect(toRoom1[1].pub.checkpoints.find((e) => e.kind === 'hold')?.at).toBe(s.arriveAt + 2000);
  });

  it('the stop concerned answers each snapshot first, even while it is busy with an older one', async () => {
    const h = harness();
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick();
    // A second gesture about the same stop while room-1 still works on the first.
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick();
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1']);
    // room-1 answers the first: it takes the second, and the first, stale
    // now, goes no further.
    await h.answer(0, 'written');
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-1']);
    // Only once room-1 has answered the second do the others get it.
    await h.answer(1, 'written');
    expect(h.calls.slice(2).map((c) => c.address).sort()).toEqual(['pass:room-0', 'pass:room-2']);
    expect(h.calls[2].pub).toBe(h.calls[1].pub);
  });

  it('a snapshot a newer one replaced while the stop concerned was busy never goes on to the other stops', async () => {
    const h = harness();
    const route = running();
    const s = startCheckpoint(route, { at: T0, pilot: 'person', fuel: 100 })!;
    const holdAt = (ms: number) => h.setCkpts([s, holdCheckpoint(route, 1, { at: s.arriveAt + ms })]);
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick(); // A goes to room-1
    holdAt(1000);
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick(); // B waits for room-1…
    holdAt(2000);
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick(); // …and C takes its place
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1']);
    await h.answer(0, 'written');
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-1']);
    const c = h.calls[1].pub;
    expect(c.checkpoints.find((e) => e.kind === 'hold')?.at).toBe(s.arriveAt + 2000);
    await h.answer(1, 'written');
    // Only C goes on: B, answered by C's write, starts no session of its own.
    expect(h.calls.slice(2).map((x) => x.address).sort()).toEqual(['pass:room-0', 'pass:room-2']);
    expect(h.calls.slice(2).every((x) => x.pub === c)).toBe(true);
  });

  it('a newer snapshot that went first to another stop overtakes an older one still at its own: the older goes nowhere the newer goes', async () => {
    const h = harness();
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick(); // B goes to room-1 and stays in flight
    const route = running();
    const s = startCheckpoint(route, { at: T0, pilot: 'person', fuel: 100 })!;
    h.setCkpts([s, holdCheckpoint(route, 2, { at: s.arriveAt + 1000 })]);
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 2 });
    await h.tick(); // C, about stop 2, goes straight to room-2
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-2']);
    const b = h.calls[0].pub;
    const c = h.calls[1].pub;
    await h.answer(0, 'written'); // room-1 answers B: C goes everywhere B would
    expect(h.calls).toHaveLength(2);
    await h.answer(1, 'written');
    expect(h.calls.slice(2).map((x) => x.address).sort()).toEqual(['pass:room-0', 'pass:room-1']);
    expect(h.calls.slice(2).every((x) => x.pub === c)).toBe(true);
    expect(h.calls.filter((x) => x.pub === b)).toHaveLength(1);
  });

  it('a newer snapshot for other stops (a new route after the finish) leaves the older one its own stops', async () => {
    const h = harness();
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick(); // B goes to room-1 and stays in flight
    const next: ShipRoute = { ...running(), stops: [stop(3, 3), stop(4, 4)] };
    h.setRoute(next);
    h.setCkpts([startCheckpoint(next, { at: T0 + 1000, pilot: 'person', fuel: 100 })!]);
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick(); // C goes to room-3
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-3']);
    await h.answer(0, 'written');
    // room-1's answer sends B on to the stops only it serves.
    expect(h.calls.slice(2).map((c) => c.address).sort()).toEqual(['pass:room-0', 'pass:room-2']);
    expect(h.calls.slice(2).every((c) => c.pub === h.calls[0].pub)).toBe(true);
  });

  it('retries an unreachable room twice, 30 s then 60 s later, then gives up', async () => {
    const h = harness({ route: () => ({ ...running(), stops: [stop(0, 0), stop(1, 1)] }) });
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick();
    await h.answer(0, 'unreachable');
    await h.answer(1, 'written');
    expect(h.timers.map((t) => t.ms)).toEqual([DEPARTURES_RETRY_MS[0]]);
    await h.tick(DEPARTURES_RETRY_MS[0]);
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-0', 'pass:room-1', 'pass:room-0']);
    await h.answer(2, 'unreachable');
    expect(h.timers.map((t) => t.ms)).toEqual([DEPARTURES_RETRY_MS[1]]);
    await h.tick(DEPARTURES_RETRY_MS[1]);
    await h.answer(3, 'unreachable');
    expect(h.timers).toHaveLength(0);
    expect(h.calls).toHaveLength(4);
    expect(h.p.busyRooms()).toEqual([]);
  });

  it('🔁 a retry that comes due after newer news was delivered is dropped, never re-sent', async () => {
    const h = harness({ route: () => ({ ...running(), stops: [stop(0, 0), stop(1, 1)] }) });
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick();
    await h.answer(0, 'unreachable'); // room-0 missed snapshot A: a retry waits
    await h.answer(1, 'written');
    expect(h.timers.map((t) => t.ms)).toEqual([DEPARTURES_RETRY_MS[0]]);
    const route = running();
    const s = startCheckpoint(route, { at: T0, pilot: 'person', fuel: 100 })!;
    h.setCkpts([s, holdCheckpoint(route, 1, { at: s.arriveAt + 1000 })]);
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 0 }); // snapshot B
    await h.tick();
    await h.answer(2, 'written'); // room-0 took B
    await h.answer(3, 'written');
    const sent = h.calls.length;
    await h.tick(DEPARTURES_RETRY_MS[0]); // A's retry comes due
    expect(h.calls).toHaveLength(sent);
    expect(h.p.busyRooms()).toEqual([]);
  });

  // Copilot (PR 180): a snapshot sent on late, after a newer route left its
  // other stops behind, must not overwrite a finish offered there since.
  it('🔢 an older snapshot sent on late never replaces newer news offered to a stop, nor drops its retry', async () => {
    const h = harness();
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick(); // A (running) goes to room-1 and stays in flight
    const a = h.calls[0].pub;
    const { startedAt: _a, startStop: _b, ...finished } = running();
    h.setRoute(finished);
    h.p.routeWritten({ kind: 'finish', run: T0 });
    await h.tick(); // B (the finish) goes to room-0…
    const b = h.calls[1].pub;
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-0']);
    await h.answer(1, 'written'); // …then on to room-2 (room-1, busy with A, keeps it waiting)
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-0', 'pass:room-2']);
    await h.answer(2, 'unreachable'); // room-2 missed B: a retry waits
    expect(h.timers.map((t) => t.ms)).toEqual([DEPARTURES_RETRY_MS[0]]);
    // START C: a route that calls at none of these stops.
    const next: ShipRoute = { ...running(), stops: [stop(3, 3), stop(4, 4)] };
    h.setRoute(next);
    h.setCkpts([startCheckpoint(next, { at: T0 + 1000, pilot: 'person', fuel: 100 })!]);
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick(); // C goes to room-3
    // room-1 answers A at last: B, waiting there, goes next, and A goes on to
    // no stop B was offered to.
    await h.answer(0, 'written');
    expect(h.calls.filter((c) => c.pub === a)).toHaveLength(1);
    expect(h.calls.filter((c) => c.address === 'pass:room-1').map((c) => c.pub)).toEqual([a, b]);
    // B's retry at room-2 comes due, and is sent.
    const sent = h.calls.length;
    await h.tick(DEPARTURES_RETRY_MS[0]);
    expect(h.calls).toHaveLength(sent + 1);
    expect(h.calls[sent]).toMatchObject({ address: 'pass:room-2' });
    expect(h.calls[sent].pub).toBe(b);
  });

  it('another ferry this game boards never drops the first one’s retry at a shared stop', async () => {
    const h = harness({ route: () => ({ ...running(), stops: [stop(0, 0), stop(1, 1)] }) });
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick();
    await h.answer(0, 'unreachable'); // ferry A missed room-0: a retry waits
    await h.answer(1, 'written');
    h.setShip('ship-room-2'); // the player boards ferry B, which calls there too
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick();
    expect(h.calls[2]).toMatchObject({ address: 'pass:room-0', pub: { shipRoomId: 'ship-room-2' } });
    await h.answer(2, 'written');
    await h.answer(3, 'written');
    await h.tick(DEPARTURES_RETRY_MS[0]); // A's retry comes due, and is sent
    expect(h.calls).toHaveLength(5);
    expect(h.calls[4]).toMatchObject({ address: 'pass:room-0', pub: { shipRoomId: SHIP } });
    await h.answer(4, 'written');
    expect(h.p.busyRooms()).toEqual([]);
  });

  it('skips a room it holds no pass for, and publishes nothing once it has left the ship', async () => {
    const h = harness({ seedFor: (room) => (room === 'room-1' ? undefined : `pass:${room}`) });
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick();
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-0', 'pass:room-2']);
    const g = harness();
    g.p.routeWritten({ kind: 'stop' });
    g.setShip('another-room');
    await g.tick();
    expect(g.calls).toHaveLength(0);
  });

  // Copilot (PR 180): a pass only the ship's ports remember is gone once the
  // rider leaves the ship's room (or the port is retargeted), but a snapshot
  // taken before still reaches every stop it could reach then.
  it('🎫 a pass held as the snapshot was taken still serves its later sends once it is gone; one gained since serves a stop that had none', async () => {
    const held = new Set(['room-0', 'room-1']);
    const h = harness({ seedFor: (room) => (held.has(room) ? `pass:${room}` : undefined) });
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick(); // the snapshot goes to room-1 first, and stays in flight
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1']);
    // The rider walks out of the ferry into room-2: the berths its ports
    // remember go with it, and this game holds its own pass for room-2.
    held.clear();
    held.add('room-2');
    await h.answer(0, 'unreachable'); // room-1 missed it, and so does room-0:
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-0', 'pass:room-2']);
    await h.answer(1, 'unreachable');
    await h.answer(2, 'written');
    await h.tick(DEPARTURES_RETRY_MS[0]); // their retries keep the passes
    expect(h.calls.map((c) => c.address)).toEqual([
      'pass:room-1', 'pass:room-0', 'pass:room-2', 'pass:room-1', 'pass:room-0',
    ]);
    expect(h.calls.every((c) => c.pub === h.calls[0].pub)).toBe(true);
    expect(JSON.stringify(h.calls[0].pub)).not.toContain('pass:');
  });

  // Copilot (PR 180): a pass gained only after the snapshot was taken served
  // its first send, then was gone for the retry (the rider left the ferry, or
  // its port was retargeted), and the stop never heard of it.
  it('🎫 a pass gained since the snapshot was taken still serves its retries once it is gone', async () => {
    const held = new Set(['room-0', 'room-1']);
    const h = harness({ seedFor: (room) => (held.has(room) ? `pass:${room}` : undefined) });
    h.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await h.tick();
    // This game gains a pass for room-2 before the snapshot is sent there…
    held.add('room-2');
    await h.answer(0, 'written');
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-0', 'pass:room-2']);
    await h.answer(1, 'written');
    // …which misses it, and the pass is gone before the retry.
    held.clear();
    await h.answer(2, 'unreachable');
    await h.tick(DEPARTURES_RETRY_MS[0]);
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-1', 'pass:room-0', 'pass:room-2', 'pass:room-2']);
    expect(h.calls[3].pub).toBe(h.calls[2].pub);
  });

  it('⛽ a tank fitted or taken off while the route runs republishes the capacity, from the game that edits the ship', async () => {
    let cap = 100;
    let editor = true;
    const h = harness({ capacity: () => cap, editsShip: () => editor });
    // The check, then the gesture's publish: one timer hop each.
    const settle = async () => { await h.tick(); await h.tick(); };
    // Joining the room: the first reading publishes nothing, nor does a
    // furniture change that leaves the tanks alone.
    h.p.tanksChanged();
    await settle();
    h.p.tanksChanged();
    await settle();
    expect(h.calls).toHaveLength(0);
    cap = 200; // a second tank
    h.p.tanksChanged();
    expect(h.calls).toHaveLength(0); // read once the change has settled
    await settle();
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-0']);
    await h.answer(0, 'written');
    expect(h.calls.map((c) => c.pub.capacity)).toEqual([200, 200, 200]);
    expect(h.calls[0].pub.checkpoints.map((e) => e.kind)).toEqual(['start']);
    for (const i of [1, 2]) await h.answer(i, 'written');
    // A rider's game that does not edit the ship leaves it to the one that does.
    editor = false;
    cap = 100;
    h.p.tanksChanged();
    await settle();
    expect(h.calls).toHaveLength(3);
    // With no run on, no board shows the ferry's legs.
    editor = true;
    h.setRoute({ ...running(), startedAt: undefined, startStop: undefined });
    cap = 300;
    h.p.tanksChanged();
    await settle();
    expect(h.calls).toHaveLength(3);
    // A publish tells the boards the capacity it carries: no second one for it.
    cap = 400;
    h.setRoute(running());
    h.p.routeWritten({ kind: 'start', legSeq: 0 });
    await h.tick();
    await h.answer(3, 'written');
    for (const i of [4, 5]) await h.answer(i, 'written');
    expect(h.calls.slice(3).map((c) => c.pub.capacity)).toEqual([400, 400, 400]);
    h.p.tanksChanged();
    await settle();
    expect(h.calls).toHaveLength(6);
  });

  it('⛽ a page that opens on a running ferry takes the tanks it finds as its first reading', async () => {
    // The first room's furniture was bound before the publisher existed, so
    // no furniture change reached it: the first one it hears is a real fit.
    let cap = 100;
    const h = harness({ capacity: () => cap, editsShip: () => true });
    cap = 200;
    h.p.tanksChanged();
    await h.tick();
    await h.tick();
    expect(h.calls.map((c) => c.address)).toEqual(['pass:room-0']);
    expect(h.calls[0].pub.capacity).toBe(200);
  });

  it('the finish after STOP publishes the route running no more, with no checkpoints', async () => {
    const h = harness();
    const { startedAt: _a, startStop: _b, ...finished } = running();
    h.setRoute(finished);
    h.p.routeWritten({ kind: 'finish', run: T0 });
    await h.tick();
    expect(h.calls[0].address).toBe('pass:room-0');
    expect(h.calls[0].pub.route.startedAt).toBeUndefined();
    expect(h.calls[0].pub.checkpoints).toEqual([]);
    // 🏁 It names the run it ended, so a board ranks it above that run's
    // late snapshots.
    expect(h.calls[0].pub.endedRun).toBe(T0);
    const g = harness();
    g.p.routeWritten({ kind: 'checkpoint', legSeq: 1 });
    await g.tick();
    expect(g.calls[0].pub.endedRun).toBeUndefined();
  });
});

describe('shipRoute tells the publisher about this game’s own writes', () => {
  let heard: RouteWriteNotice[] = [];
  let off: () => void = () => {};
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    heard = [];
    off = onRouteWritten((n) => heard.push(n));
    bindShipDoc(new Y.Doc());
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { off(); warn.mockRestore(); });

  it('START, a checkpoint (its stay), STOP and the finish; nothing for a refused write', () => {
    const { startedAt: _a, startStop: _b, ...saved } = running();
    expect(writeShipRoute(saved)).toBe(true);
    writeFuelLevel(100, 100);
    const run = startShipRoute({ now: T0, startStop: 0, pilot: 'person', fuel: 100, capacity: 100 })!;
    const route = readShipRoute()!;
    const s = startCheckpoint(route, { at: T0, pilot: 'person', fuel: 100 })!;
    expect(writeRouteCheckpoint(run, holdCheckpoint(route, 1, { at: s.arriveAt + 1000 }), s.arriveAt + 2000)).toBe(true);
    expect(writeRouteCheckpoint(run + 1, holdCheckpoint(route, 1, { at: s.arriveAt + 1000 }), s.arriveAt + 2000)).toBe(false);
    expect(stopShipRoute(s.arriveAt + 3000)).toBe(true);
    expect(finishShipRoute()).toBe(true);
    expect(heard).toEqual([
      { kind: 'start', legSeq: 0 },
      { kind: 'checkpoint', legSeq: 1 },
      { kind: 'stop' },
      { kind: 'finish', run },
    ]);
  });
});
