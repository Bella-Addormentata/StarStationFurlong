/**
 * 🔧 The Disassemble robot job (#192): labor hours on the orbital clock, a
 * crew that settles the progress whenever it changes, which modules a room's
 * robots may take apart, and a module taken apart leaving every map.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  bindStationAtlasDoc, atlasComponents, dismantleInAtlas, harvestIntoAtlas, isDismantled, noteRoomSeed, readAtlas,
  seedAtlasDefaults, withSharedAtlasOf, MAX_ENTRIES,
} from './stationAtlas';
import {
  disassemblyCandidates, doorsJoinedTo, isDisassemblyJobRecord, jobDueAt, jobFraction, jobStatusText,
  laborHoursFor, laborMsFor, removalBlocker, settleJob, workedMs,
  type CandidateInput, type DisassemblyJob, type DisassemblyJobRecord,
} from './disassembly';
import {
  assignDisassembly, bindRobotDoc, clearRobotConfig, finishDisassemblyJob, raiseDisassemblyLabor,
  readDisassemblyJob, readDisassemblyJobs, readRobotConfig, writeRobotConfig, MAX_ROBOT_MAP_SCAN,
} from './robotDoc';
import type { DoorRecord } from './doorsDoc';
import { bindFurnitureDoc, deleteFurnitureItem, writeFurnitureItem } from './furnitureDoc';

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => { store.clear(); },
};

const seed = (room: string) => `ssf://room#room=${room}`;
const MIN = 60_000;

beforeEach(() => store.clear());

function job(over: Partial<DisassemblyJob> = {}): DisassemblyJob {
  return {
    roomId: 'room-b', name: 'GARDEN', doorId: 'east',
    laborHours: 24, startedAt: 0, doneMs: 0, asOf: 0, crew: [], ...over,
  };
}

describe('labor on the orbital clock', () => {
  it('costs a module by its floor tiles, the default room when its size is unknown', () => {
    expect(laborHoursFor()).toBe(24);
    expect(laborHoursFor({ cols: 3, rows: 2 })).toBe(36);
    expect(laborHoursFor({ cols: 5, rows: 5 })).toBe(150);
    // A size out of range (an old store, a bad write) is costed as the default.
    expect(laborHoursFor({ cols: 40, rows: 40 })).toBe(24);
    expect(laborHoursFor({ cols: 0, rows: 3 })).toBe(24);
    // One labor hour is one real minute of one robot's work (60x).
    expect(laborMsFor(1)).toBe(MIN);
  });

  it('runs with the crew, settles on a change, and never reads the clock backwards', () => {
    const j = job({ crew: ['d1'] });
    expect(workedMs(j, 10 * MIN)).toBe(10 * MIN);
    expect(jobDueAt(j)).toBe(24 * MIN);
    // A second robot from minute 10: the rest goes twice as fast.
    const two = { ...settleJob(j, 10 * MIN), crew: ['d1', 'd2'] };
    expect(two).toMatchObject({ doneMs: 10 * MIN, asOf: 10 * MIN });
    // What a crew change writes is the record alone: the crew is the configs'.
    expect('crew' in settleJob(j, 10 * MIN)).toBe(false);
    expect(jobDueAt(two)).toBe(17 * MIN);
    expect(workedMs(two, 12 * MIN)).toBe(14 * MIN);
    // Never past the total.
    expect(workedMs(two, 99 * MIN)).toBe(24 * MIN);
    expect(jobFraction(two, 99 * MIN)).toBe(1);
    // A clock behind the last writer's changes nothing.
    const { crew: _crew, ...twoRecord } = two;
    expect(settleJob(two, 5 * MIN)).toEqual(twoRecord);
    expect(workedMs(two, 5 * MIN)).toBe(10 * MIN);
    // Nobody on it: paused, no due time.
    expect(jobDueAt({ ...two, crew: [] })).toBeNull();
    expect(workedMs({ ...two, crew: [] }, 50 * MIN)).toBe(10 * MIN);
  });

  it('says where the job stands', () => {
    expect(jobStatusText(job({ crew: ['d1'] }), 6 * MIN)).toBe('25% · 18 labor hours left · 1 robot · about 18 min at this pace');
    expect(jobStatusText(job({ crew: ['d1', 'd2'], doneMs: 12 * MIN }), 0)).toBe('50% · 12 labor hours left · 2 robots · about 6 min at this pace');
    expect(jobStatusText(job(), 0)).toContain('paused');
    expect(jobStatusText(job({ crew: ['d1'] }), 30 * MIN, "it is still joined to POOL")).toBe("Work done, but it can't come off yet: it is still joined to POOL.");
    expect(jobStatusText(job({ crew: ['d1'] }), 30 * MIN)).toBe("Work done; it comes off once the room's owner is here.");
    expect(jobStatusText(job({ finishedAt: 5, outcome: 'removed' }), 0)).toBe('GARDEN was taken apart and is off the station.');
    expect(jobStatusText(job({ finishedAt: 5, outcome: 'detached' }), 0)).toContain('nothing was taken apart');
  });

  it('reads only well-formed job records from the room doc', () => {
    const rec = (over: Partial<DisassemblyJobRecord> = {}): DisassemblyJobRecord => ({
      roomId: 'room-b', name: 'GARDEN', doorId: 'east', laborHours: 24,
      startedAt: 0, doneMs: 10 * MIN, asOf: 10 * MIN, ...over,
    });
    expect(isDisassemblyJobRecord(rec())).toBe(true);
    // Ended: how it ended, with all its labor settled when it did.
    const ended = { doneMs: 24 * MIN, asOf: 24 * MIN, finishedAt: 24 * MIN };
    expect(isDisassemblyJobRecord(rec({ ...ended, outcome: 'removed' }))).toBe(true);
    expect(isDisassemblyJobRecord(rec({ ...ended, outcome: 'detached' }))).toBe(true);
    expect(isDisassemblyJobRecord(rec(ended))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ outcome: 'removed' }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ finishedAt: 10 * MIN, outcome: 'removed' }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ ...ended, finishedAt: 25 * MIN, outcome: 'removed' }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ laborHours: 0 }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ laborHours: Infinity }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ doneMs: -1 }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ outcome: 'exploded' as never }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ name: 'x'.repeat(65) }))).toBe(false);
    expect(isDisassemblyJobRecord(null)).toBe(false);
    // Labor no crew could have done since it started, or past the job's.
    expect(isDisassemblyJobRecord(rec({ asOf: 0, doneMs: 1 }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ startedAt: 10 * MIN, asOf: 5 * MIN, doneMs: 0 }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ asOf: 60 * MIN, doneMs: 25 * MIN }))).toBe(false);
    expect(isDisassemblyJobRecord(rec({ asOf: 1 * MIN, doneMs: 16 * MIN }))).toBe(true);
    expect(isDisassemblyJobRecord(rec({ asOf: 1 * MIN, doneMs: 16 * MIN + 1 }))).toBe(false);
  });
});

// ── Which modules can come off ───────────────────────────────────────────────

const pairing = (room: string, over: Partial<Extract<DoorRecord, { paired: true }>> = {}): DoorRecord => ({
  paired: true, connectedRoomAddress: seed(room), ...over,
});

/** HUB (here) — GARDEN by a gangway (east), LAB by a gangway (west), a ship
 *  docked at the south door, and a north door undocked from SHED. */
function hub(): Map<string, DoorRecord> {
  harvestIntoAtlas({
    roomId: 'room-a', name: 'HUB',
    doors: [
      { doorId: 'east', targetSeed: seed('room-b'), transient: false },
      { doorId: 'west', targetSeed: seed('room-c'), transient: false },
      { doorId: 'south', targetSeed: seed('ship-1'), transient: true },
    ],
    owner: { id: 'p-me' },
  });
  harvestIntoAtlas({
    roomId: 'room-b', name: 'GARDEN', dims: { cols: 3, rows: 2 },
    doors: [{ doorId: 'west', targetSeed: seed('room-a'), transient: false }],
    owner: { id: 'p-me' },
  });
  harvestIntoAtlas({
    roomId: 'room-c', name: 'LAB',
    doors: [{ doorId: 'east', targetSeed: seed('room-a'), transient: false }],
    owner: { id: 'p-sam', name: 'Sam' },
  });
  return new Map<string, DoorRecord>([
    ['east', pairing('room-b')],
    ['west', pairing('room-c')],
    ['south', pairing('ship-1', { transient: true })],
    ['north', { paired: false, retiredAddress: seed('shed') }],
    ['d:dock', pairing('ship-2', { segments: [{ kind: 'dock' }, { kind: 'dock' }] as never })],
  ]);
}

const input = (doors: Map<string, DoorRecord>, over: Partial<CandidateInput> = {}): CandidateInput => ({
  atlas: readAtlas(), hereRoomId: 'room-a', doors, playerId: 'p-me', welcomeRoomId: 'room-a', ...over,
});

describe('what a room can take apart', () => {
  it('lists the modules joined by a gangway, never a docked ship or an undocked door', () => {
    const list = disassemblyCandidates(input(hub()));
    expect(list.map((c) => [c.roomId, c.doorId, c.laborHours, c.blocked])).toEqual([
      ['room-b', 'east', 36, null],
      ['room-c', 'west', 24, 'it belongs to Sam'],
    ]);
  });

  it('keeps the welcome room, and asks to see inside a module whose owner is unknown', () => {
    const doors = hub();
    expect(removalBlocker(input(doors, { welcomeRoomId: 'room-b' }), 'room-b')).toBe("it is the station's welcome room");
    // A module this install minted but whose layout the atlas doesn't hold
    // (never learned, or evicted): what else it is joined to is unknown.
    doors.set('d:shed', pairing('room-s'));
    const minted = (r: string) => r === 'room-s';
    expect(removalBlocker(input(doors, { minted }), 'room-s')).toBe("its layout isn't known yet; step inside it once");
    // A stub (named by a neighbour's door, never seen from inside) is no better.
    harvestIntoAtlas({ roomId: 'room-z', name: 'ZED', doors: [{ doorId: 'n', targetSeed: seed('room-s') }] });
    expect(readAtlas()['room-s']?.doors).toEqual({});
    expect(removalBlocker(input(doors, { minted }), 'room-s')).toBe("its layout isn't known yet; step inside it once");
    doors.delete('d:shed');
    harvestIntoAtlas({ roomId: 'room-d', name: 'SHED', doors: [{ doorId: 'w', targetSeed: seed('room-a') }] });
    // A harvest without an owner keeps it unknown.
    expect(removalBlocker(input(doors), 'room-d')).toBe("its owner isn't known yet; step inside it once");
    // …unless this install minted it.
    expect(removalBlocker(input(doors, { minted: (r) => r === 'room-d' }), 'room-d')).toBeNull();
    // No verified owner (none, or the legacy marker): this room's owner may.
    harvestIntoAtlas({ roomId: 'room-d', name: 'SHED', doors: [{ doorId: 'w', targetSeed: seed('room-a') }], owner: null });
    expect(removalBlocker(input(doors), 'room-d')).toBeNull();
    harvestIntoAtlas({ roomId: 'room-d', name: 'SHED', doors: [{ doorId: 'w', targetSeed: seed('room-a') }], owner: { id: 'Local-Clone' } });
    expect(removalBlocker(input(doors), 'room-d')).toBeNull();
  });

  it('takes apart a module seen from inside with no doors of its own', () => {
    const doors = hub();
    // HUB's record is the only one of its gangway to SHED (a pairing may be
    // recorded on one side only).
    harvestIntoAtlas({
      roomId: 'room-a', name: 'HUB',
      doors: [
        { doorId: 'east', targetSeed: seed('room-b'), transient: false },
        { doorId: 'west', targetSeed: seed('room-c'), transient: false },
        { doorId: 'south', targetSeed: seed('ship-1'), transient: true },
        { doorId: 'up', targetSeed: seed('room-s'), transient: false },
      ],
      owner: { id: 'p-me' },
    });
    doors.set('up', pairing('room-s'));
    // Named only by that door, SHED is a stub: what else it joins is unknown.
    expect(removalBlocker(input(doors), 'room-s')).toBe("its layout isn't known yet; step inside it once");
    // Seen from inside, it records no doors: known, and it hangs off HUB alone.
    harvestIntoAtlas({ roomId: 'room-s', name: 'SHED', doors: [], owner: { id: 'p-me' } });
    expect(readAtlas()['room-s']?.doors).toEqual({});
    expect(removalBlocker(input(doors), 'room-s')).toBeNull();
    expect(disassemblyCandidates(input(doors)).find((c) => c.roomId === 'room-s')?.blocked).toBeNull();
  });

  it('takes apart only a module that hangs off this room alone', () => {
    const doors = hub();
    // GARDEN gains a gangway to POOL: taking it apart would cut POOL off.
    harvestIntoAtlas({
      roomId: 'room-b', name: 'GARDEN',
      doors: [
        { doorId: 'west', targetSeed: seed('room-a'), transient: false },
        { doorId: 'north', targetSeed: seed('room-p'), transient: false },
      ],
      owner: { id: 'p-me' },
    });
    harvestIntoAtlas({ roomId: 'room-p', name: 'POOL', doors: [] });
    expect(removalBlocker(input(doors), 'room-b')).toBe('it is still joined to POOL');
    // A pairing only the far room recorded counts too.
    harvestIntoAtlas({ roomId: 'room-b', name: 'GARDEN', doors: [{ doorId: 'west', targetSeed: seed('room-a') }], owner: { id: 'p-me' } });
    harvestIntoAtlas({ roomId: 'room-p', name: 'POOL', doors: [{ doorId: 's', targetSeed: seed('room-b'), transient: false }] });
    expect(removalBlocker(input(doors), 'room-b')).toBe('it is still joined to POOL');
    // A ship docked at it.
    harvestIntoAtlas({ roomId: 'room-p', name: 'POOL', doors: [] });
    harvestIntoAtlas({
      roomId: 'room-b', name: 'GARDEN',
      doors: [
        { doorId: 'west', targetSeed: seed('room-a'), transient: false },
        { doorId: 'south', targetSeed: seed('ship-9'), transient: true },
      ],
      owner: { id: 'p-me' },
    });
    expect(removalBlocker(input(doors), 'room-b')).toBe('a ship is docked at it');
  });

  it('seals every door of this room joined to the module', () => {
    const doors = hub();
    doors.set('d:2', pairing('room-b'));
    expect(doorsJoinedTo(input(doors), 'room-b')).toEqual([
      { doorId: 'd:2', address: seed('room-b') },
      { doorId: 'east', address: seed('room-b') },
    ]);
    expect(disassemblyCandidates(input(doors))[0].doorIds).toEqual(['d:2', 'east']);
    expect(doorsJoinedTo(input(doors), 'ship-1')).toEqual([]);
  });
});

// ── The crew in the room doc ─────────────────────────────────────────────────

const target = { roomId: 'room-b', name: 'GARDEN', doorId: 'east', laborHours: 24 };

/** The docks the tests set robots on: d1–d3 and d00–d16. */
const DOCKS = ['d1', 'd2', 'd3', ...Array.from({ length: 17 }, (_, i) => `d${String(i).padStart(2, '0')}`)];

/** A room doc with these charging docks placed in its layout (a robot works
 *  only from a placed dock), bound as the room's layout. */
function roomWithDocks(ids: readonly string[] = DOCKS): Y.Doc {
  const doc = new Y.Doc();
  bindFurnitureDoc(doc);
  for (const id of ids) writeFurnitureItem({ id, kind: 'charging-dock', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  return doc;
}

describe('the job in the robot map', () => {
  beforeEach(() => bindRobotDoc(roomWithDocks()));

  it('opens a job, and every crew change settles it first', () => {
    assignDisassembly('d1', target, 0);
    expect(readRobotConfig('d1')).toEqual({ routine: 'disassemble', target: 'room-b' });
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d1'], doneMs: 0, asOf: 0, startedAt: 0 });
    // A second robot at minute 4.
    assignDisassembly('d2', target, 4 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d1', 'd2'], doneMs: 4 * MIN, asOf: 4 * MIN });
    // STOP parks d1 at minute 6: it leaves the crew, its target kept.
    writeRobotConfig('d1', { routine: 'disassemble', target: 'room-b', parked: true }, 6 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d2'], doneMs: 8 * MIN, asOf: 6 * MIN });
    // START puts it back.
    writeRobotConfig('d1', { routine: 'disassemble', target: 'room-b' }, 7 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d1', 'd2'], doneMs: 9 * MIN });
    // d2 is set to serve drinks, and d1's dock is removed: the work is kept.
    writeRobotConfig('d2', { routine: 'serve' }, 8 * MIN);
    clearRobotConfig('d1', 9 * MIN);
    const paused = readDisassemblyJob('room-b')!;
    expect(paused).toMatchObject({ crew: [], doneMs: 12 * MIN, asOf: 9 * MIN });
    expect(workedMs(paused, 60 * MIN)).toBe(12 * MIN);
    // Back on it later: it picks up where it was.
    assignDisassembly('d2', target, 30 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d2'], doneMs: 12 * MIN, asOf: 30 * MIN });
  });

  it('a parked robot set to a module joins the crew only when started', () => {
    writeRobotConfig('d1', { routine: 'idle', parked: true }, 0);
    assignDisassembly('d1', target, 0);
    expect(readRobotConfig('d1')).toEqual({ routine: 'disassemble', target: 'room-b', parked: true });
    expect(readDisassemblyJob('room-b')?.crew).toEqual([]);
  });

  it('moving a robot to another module moves its labor', () => {
    assignDisassembly('d1', target, 0);
    assignDisassembly('d1', { ...target, roomId: 'room-c', name: 'LAB', doorId: 'west' }, 5 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: [], doneMs: 5 * MIN });
    expect(readDisassemblyJob('room-c')).toMatchObject({ crew: ['d1'], doneMs: 0, asOf: 5 * MIN });
  });

  it('ends a job once, and drops it when no robot is set to it any more', () => {
    assignDisassembly('d1', target, 0);
    finishDisassemblyJob('room-b', 24 * MIN, 'removed');
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: [], finishedAt: 24 * MIN, outcome: 'removed', doneMs: 24 * MIN });
    // A second client ending it again changes nothing.
    finishDisassemblyJob('room-b', 25 * MIN, 'detached');
    expect(readDisassemblyJob('room-b')).toMatchObject({ finishedAt: 24 * MIN, outcome: 'removed' });
    // The robot still points at it, so the console can say it is done…
    expect(readDisassemblyJobs()).toHaveLength(1);
    // …until it is set to something else.
    writeRobotConfig('d1', { routine: 'idle' }, 30 * MIN);
    expect(readDisassemblyJobs()).toHaveLength(0);
  });

  it('a module re-joined after a finished job starts a fresh one', () => {
    assignDisassembly('d1', target, 0);
    finishDisassemblyJob('room-b', 24 * MIN, 'detached');
    assignDisassembly('d1', target, 40 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d1'], doneMs: 0, startedAt: 40 * MIN });
    expect(readDisassemblyJob('room-b')?.finishedAt).toBeUndefined();
  });

  it('a crew counts at most 16 robots', () => {
    for (let i = 0; i < 17; i++) assignDisassembly(`d${String(i).padStart(2, '0')}`, target, 0);
    expect(readDisassemblyJob('room-b')?.crew).toEqual(Array.from({ length: 16 }, (_, i) => `d${String(i).padStart(2, '0')}`));
  });

  it('two robots stopped at once on two clients both leave the crew', () => {
    const a = roomWithDocks();
    bindRobotDoc(a);
    assignDisassembly('d1', target, 0);
    assignDisassembly('d2', target, 0);
    expect(readDisassemblyJob('room-b')?.crew).toEqual(['d1', 'd2']);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // Each client stops one robot at minute 6, before hearing of the other.
    writeRobotConfig('d1', { routine: 'disassemble', target: 'room-b', parked: true }, 6 * MIN);
    bindRobotDoc(b);
    writeRobotConfig('d2', { routine: 'disassemble', target: 'room-b', parked: true }, 6 * MIN);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const doc of [a, b]) {
      bindRobotDoc(doc);
      const j = readDisassemblyJob('room-b')!;
      // Whichever settlement won, nobody works on it any more: no stale
      // crew keeps the labor running, and it is never due.
      expect(j.crew).toEqual([]);
      expect(jobDueAt(j)).toBeNull();
      expect(workedMs(j, 60 * MIN)).toBe(workedMs(j, 7 * MIN));
    }
  });

  it('reads every job and its crew in one bounded walk of the map', () => {
    const doc = roomWithDocks();
    bindRobotDoc(doc);
    const lab = { ...target, roomId: 'room-c', name: 'LAB', doorId: 'west' };
    assignDisassembly('d1', target, 0);
    assignDisassembly('d2', lab, 0);
    assignDisassembly('d3', lab, 0);
    // A peer's junk after them: robots set to modules no job is open on.
    const map = doc.getMap('robot');
    doc.transact(() => {
      for (let i = 0; i < 3 * MAX_ROBOT_MAP_SCAN; i++) map.set(`cfg:junk-${i}`, { routine: 'disassemble', target: `junk-${i}` });
    });
    const walk = map.entries.bind(map);
    let walked = 0;
    const entries = vi.spyOn(map, 'entries').mockImplementation(function* () {
      for (const e of walk()) {
        walked++;
        yield e;
      }
    });
    expect(readDisassemblyJobs().map((j) => [j.roomId, j.crew])).toEqual([['room-b', ['d1']], ['room-c', ['d2', 'd3']]]);
    expect(entries).toHaveBeenCalledTimes(1);
    expect(walked).toBeLessThanOrEqual(MAX_ROBOT_MAP_SCAN + 1);
    entries.mockRestore();
  });

  it('counts only robots whose docks are placed in the room\'s layout', () => {
    const doc = roomWithDocks(['d1', 'd2']);
    bindRobotDoc(doc);
    assignDisassembly('d1', target, 0);
    assignDisassembly('d2', target, 0);
    assignDisassembly('d3', target, 0);
    // d3's dock isn't in the layout: no robot stands there to work.
    expect(readDisassemblyJob('room-b')?.crew).toEqual(['d1', 'd2']);
    // d2's dock leaves the layout by a write that didn't release its robot
    // (a peer's): its config stays, but it adds no labor from then on, and
    // what it did since the last settlement goes with it.
    deleteFurnitureItem('d2');
    const j = readDisassemblyJob('room-b')!;
    expect(j.crew).toEqual(['d1']);
    expect(readRobotConfig('d2')).toMatchObject({ routine: 'disassemble', target: 'room-b' });
    expect(workedMs(j, 10 * MIN)).toBe(10 * MIN);
    expect(jobDueAt(j)).toBe(24 * MIN);
  });

  it('raises an open job costed below the module, keeping the work done', () => {
    assignDisassembly('d1', { ...target, laborHours: 1 }, 0);
    expect(readDisassemblyJob('room-b')?.laborHours).toBe(1);
    // The console costs the module from its size: a short record is raised,
    // its one labor hour done standing and the rest still to do.
    assignDisassembly('d2', target, 1 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({
      laborHours: 24, doneMs: 1 * MIN, asOf: 1 * MIN, startedAt: 0, crew: ['d1', 'd2'],
    });
    // The module grew when the end is checked: likewise.
    raiseDisassemblyLabor('room-b', 36, 5 * MIN);
    const j = readDisassemblyJob('room-b')!;
    expect(j).toMatchObject({ laborHours: 36, doneMs: 9 * MIN, asOf: 5 * MIN });
    expect(jobDueAt(j)).toBe(5 * MIN + 13.5 * MIN);
    // Never lowered.
    raiseDisassemblyLabor('room-b', 6, 6 * MIN);
    assignDisassembly('d3', target, 6 * MIN);
    expect(readDisassemblyJob('room-b')?.laborHours).toBe(36);
  });
});

// ── Off the station and out of every map ─────────────────────────────────────

describe('a module taken apart', () => {
  it('leaves the maps, its doors with it, and the station shrinks', () => {
    hub();
    expect(atlasComponents(readAtlas()).find((c) => c.has('room-a'))?.has('room-b')).toBe(true);
    dismantleInAtlas('room-b', 1000);
    const atlas = readAtlas();
    expect(atlas['room-b']).toBeUndefined();
    // GARDEN's stale record of the gangway is gone too, and HUB's door to it.
    expect(Object.values(atlas['room-a'].doors).map((d) => d.targetRoomId)).not.toContain('room-b');
    expect(atlasComponents(atlas).some((c) => c.has('room-b'))).toBe(false);
    // The bundled default station never brings it back.
    expect(seedAtlasDefaults([{ roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } } }])).toBe(0);
    expect(readAtlas()['room-b']).toBeUndefined();
  });

  it('travels through the shared atlas, and older gossip cannot bring it back', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      hub();
      const doc = new Y.Doc();
      bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
      // An older copy of GARDEN, doors and all, sits in the doc.
      const before = doc.getMap('atlas').get('room-b') as { updatedAt: number };
      expect(before.updatedAt).toBe(1_000_000);
      now.mockReturnValue(1_000_500);
      dismantleInAtlas('room-b', 1_000_400);
      const shared = doc.getMap('atlas').get('room-b') as { dismantledAt?: number; doors: object; updatedAt: number };
      expect(shared).toMatchObject({ dismantledAt: 1_000_400, doors: {} });
      expect(shared.updatedAt).toBeGreaterThan(before.updatedAt);
      // Another install learns it from the doc.
      store.clear();
      harvestIntoAtlas({ roomId: 'room-a', name: 'HUB', doors: [{ doorId: 'east', targetSeed: seed('room-b') }] });
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
      bindStationAtlasDoc(doc2, { roomId: 'room-a', isPassagePublic: () => false });
      expect(readAtlas()['room-b']).toBeUndefined();
      // A stale copy gossiped afterwards (stamped before the job ended).
      doc2.getMap('atlas').set('room-b', { roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } }, updatedAt: 1_000_100 });
      expect(readAtlas()['room-b']).toBeUndefined();
      // Someone standing inside it later is first-hand proof it is there.
      now.mockReturnValue(1_002_000);
      harvestIntoAtlas({ roomId: 'room-b', name: 'GARDEN', doors: [{ doorId: 'west', targetSeed: seed('room-a') }], owner: { id: 'p-me' } });
      expect(readAtlas()['room-b']).toBeDefined();
    } finally {
      now.mockRestore();
    }
  });

  it('reads as gone in a far room doc read for its gates', () => {
    hub();
    const doc = new Y.Doc();
    // A doc still holding GARDEN from before, with a gate.
    doc.getMap('atlas').set('room-b', {
      roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } }, gates: { south: 4 }, updatedAt: 1,
    });
    dismantleInAtlas('room-b', 5);
    const merged = withSharedAtlasOf(doc, readAtlas(), 'room-a');
    expect(merged['room-b']).toBeUndefined();
    expect(Object.values(merged['room-a'].doors).map((d) => d.targetRoomId)).not.toContain('room-b');
    // Read from the module itself: the old copy is still gone…
    expect(withSharedAtlasOf(doc, readAtlas(), 'room-b')['room-b']).toBeUndefined();
    // …and a copy written after the job ended (someone stood inside it since)
    // brings it back, as the pull from the doc would.
    doc.getMap('atlas').set('room-b', {
      roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } }, updatedAt: Date.now() + 1000,
    });
    expect(withSharedAtlasOf(doc, readAtlas(), 'room-b')['room-b']?.doors).toMatchObject({ west: { targetRoomId: 'room-a' } });
  });

  it('a seed handed over later does not bring it back', () => {
    hub();
    dismantleInAtlas('room-b', 5);
    noteRoomSeed('room-b', 'GARDEN', seed('room-b'));
    expect(readAtlas()['room-b']).toBeUndefined();
    expect(isDismantled('room-b')).toBe(true);
    expect(isDismantled('room-a')).toBe(false);
  });

  it('stays gone however many rooms are visited after', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      hub();
      now.mockReturnValue(1_000_500);
      dismantleInAtlas('room-b', 1_000_400);
      // More first-hand rooms than the atlas keeps.
      for (let i = 0; i < MAX_ENTRIES + 6; i++) {
        now.mockReturnValue(1_001_000 + i);
        harvestIntoAtlas({ roomId: `walk-${i}`, name: `W${i}`, doors: [] });
      }
      expect(isDismantled('room-b')).toBe(true);
      // A room doc still holding GARDEN from before the job ended.
      const doc = new Y.Doc();
      doc.getMap('atlas').set('room-b', {
        roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } }, updatedAt: 1_000_000,
      });
      bindStationAtlasDoc(doc, { roomId: 'walk-0', isPassagePublic: () => false });
      expect(readAtlas()['room-b']).toBeUndefined();
      expect(withSharedAtlasOf(doc, readAtlas(), 'room-b')['room-b']).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });
});
