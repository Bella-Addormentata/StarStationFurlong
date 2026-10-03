/**
 * 🔧 The Disassemble robot job (#192): labor hours on the orbital clock, a
 * crew that settles the progress whenever it changes, which modules a room's
 * robots may take apart, and a module taken apart leaving every map.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  bindStationAtlasDoc, atlasComponents, dismantleInAtlas, harvestIntoAtlas, isDismantled, noteRoomSeed, pushAtlasToDoc,
  readAtlas, seedAtlasDefaults, visibleAtlas, withSharedAtlasOf, MAX_DISMANTLED, MAX_ENTRIES,
  type AtlasEntry,
} from './stationAtlas';
import {
  disassemblyCandidates, doorsJoinedTo, isDisassemblyJobRecord, isDisassemblyWork, jobAnnouncement, jobDueAt, jobFraction,
  jobFromWork, jobStatusText, laborHoursFor, laborMsFor, removalBlocker, startWork, stopWork, workedMs,
  type CandidateInput, type DisassemblyJob, type DisassemblyJobRecord, type DisassemblyWork,
} from './disassembly';
import {
  assignDisassembly, bindRobotDoc, clearRobotConfig, finishDisassemblyJob, raiseDisassemblyLabor,
  readDisassemblyJob, readDisassemblyJobs, readRobotConfig, startResumesDisassembly, writeRobotConfig, MAX_ROBOT_MAP_SCAN,
} from './robotDoc';
import type { DoorRecord } from './doorsDoc';
import { bindFurnitureDoc, deleteFurnitureItem, replaceAllFurniture, writeFurnitureItem } from './furnitureDoc';

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

  it('runs with its robots, each on its own clock, and never reads the clock backwards', () => {
    const { crew: _crew, ...rec } = job();
    const both = new Set(['d1', 'd2']);
    const d1 = startWork(rec, 'd1', undefined, 0);
    const j = jobFromWork(rec, [d1], both);
    expect(j.crew).toEqual(['d1']);
    expect(workedMs(j, 10 * MIN)).toBe(10 * MIN);
    expect(jobDueAt(j)).toBe(24 * MIN);
    // A second robot from minute 10: the rest goes twice as fast.
    const d2 = startWork(rec, 'd2', undefined, 10 * MIN);
    const two = jobFromWork(rec, [d1, d2], both);
    expect(two).toMatchObject({ doneMs: 10 * MIN, asOf: 10 * MIN, crew: ['d1', 'd2'] });
    expect(jobDueAt(two)).toBe(17 * MIN);
    expect(workedMs(two, 12 * MIN)).toBe(14 * MIN);
    // Never past the total.
    expect(workedMs(two, 99 * MIN)).toBe(24 * MIN);
    expect(jobFraction(two, 99 * MIN)).toBe(1);
    // A clock behind the last record adds nothing, and stops nothing early.
    expect(workedMs(two, 5 * MIN)).toBe(10 * MIN);
    expect(stopWork(d2, 5 * MIN)).toMatchObject({ ms: 0, asOf: 10 * MIN, working: false });
    // A robot no longer set to it (stopped, or its dock gone) works no more.
    expect(jobFromWork(rec, [d1, d2], new Set(['d1'])).crew).toEqual(['d1']);
    // Both stopped at minute 12: paused, each robot's labor its own.
    const paused = jobFromWork(rec, [stopWork(d1, 12 * MIN), stopWork(d2, 12 * MIN)], both);
    expect(paused).toMatchObject({ doneMs: 14 * MIN, asOf: 12 * MIN, crew: [] });
    expect(jobDueAt(paused)).toBeNull();
    expect(workedMs(paused, 50 * MIN)).toBe(14 * MIN);
    // One back at minute 20 picks up where it was.
    const again = startWork(rec, 'd1', stopWork(d1, 12 * MIN), 20 * MIN);
    expect(again).toMatchObject({ ms: 12 * MIN, asOf: 20 * MIN, working: true });
    expect(workedMs(jobFromWork(rec, [again, stopWork(d2, 12 * MIN)], both), 21 * MIN)).toBe(15 * MIN);
    // Its labor all done when its last robot left: still due, as of then.
    const done = jobFromWork(rec, [stopWork(d1, 30 * MIN), stopWork(d2, 30 * MIN)], both);
    expect(done).toMatchObject({ doneMs: 24 * MIN, asOf: 30 * MIN });
    expect(jobDueAt(done)).toBe(30 * MIN);
    // A job opened again on the module counts none of the old one's labor.
    const reopened = { ...rec, startedAt: 40 * MIN, asOf: 40 * MIN };
    expect(jobFromWork(reopened, [stopWork(d1, 30 * MIN)], both).doneMs).toBe(0);
    expect(startWork(reopened, 'd1', stopWork(d1, 30 * MIN), 41 * MIN)).toMatchObject({ ms: 0, startedAt: 40 * MIN });
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

  it('a robot says it is on a job once, then each tenth, and starts over on another', () => {
    const garden = job();
    const start = jobAnnouncement(garden, 0, undefined)!;
    expect(start.text).toBe('🔧 On it: taking GARDEN apart, 24 labor hours.');
    expect(jobAnnouncement(garden, 0.05, start.said)).toBeNull();
    const third = jobAnnouncement(garden, 0.31, start.said)!;
    expect(third.text).toBe('🔧 GARDEN is 30% taken apart.');
    expect(jobAnnouncement(garden, 0.39, third.said)).toBeNull();
    // Set to another module at the same tenth: it starts over there, not
    // silent because the tenth matches.
    const lab = job({ roomId: 'room-c', name: 'LAB', laborHours: 36 });
    expect(jobAnnouncement(lab, 0.3, third.said)?.text).toBe('🔧 On it: taking LAB apart, 30% done.');
    // Likewise a job on the same module opened again.
    expect(jobAnnouncement(job({ startedAt: 40 * MIN }), 0.3, third.said)?.text).toBe('🔧 On it: taking GARDEN apart, 30% done.');
    expect(jobAnnouncement(garden, 1, third.said)?.text).toBe('🔧 GARDEN is 100% taken apart.');
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
    // Ended sooner than sixteen robots could: more were working (robots
    // started on two clients at once), and it stands.
    expect(isDisassemblyJobRecord(rec({ doneMs: 24 * MIN, asOf: MIN, finishedAt: MIN, outcome: 'removed' }))).toBe(true);
  });

  it("reads only well-formed robot work records", () => {
    const work = (over: Partial<DisassemblyWork> = {}): DisassemblyWork => ({
      roomId: 'room-b', dockId: 'd1', startedAt: 0, ms: 5 * MIN, asOf: 10 * MIN, working: true, ...over,
    });
    expect(isDisassemblyWork(work())).toBe(true);
    expect(isDisassemblyWork(work({ working: false }))).toBe(true);
    // No longer at it than the job has been open.
    expect(isDisassemblyWork(work({ ms: 10 * MIN }))).toBe(true);
    expect(isDisassemblyWork(work({ ms: 10 * MIN + 1 }))).toBe(false);
    expect(isDisassemblyWork(work({ startedAt: 11 * MIN, ms: 0 }))).toBe(false);
    expect(isDisassemblyWork(work({ ms: -1 }))).toBe(false);
    expect(isDisassemblyWork(work({ asOf: Infinity }))).toBe(false);
    expect(isDisassemblyWork(work({ dockId: '' }))).toBe(false);
    expect(isDisassemblyWork(work({ working: 'yes' as never }))).toBe(false);
    expect(isDisassemblyWork(null)).toBe(false);
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
    // A module whose layout the atlas doesn't hold (never learned, or
    // evicted): what else it is joined to is unknown.
    doors.set('d:shed', pairing('room-s'));
    expect(removalBlocker(input(doors), 'room-s')).toBe("its layout isn't known yet; step inside it once");
    // A stub (named by a neighbour's door, never seen from inside) is no better.
    harvestIntoAtlas({ roomId: 'room-z', name: 'ZED', doors: [{ doorId: 'n', targetSeed: seed('room-s') }] });
    expect(readAtlas()['room-s']?.doors).toEqual({});
    expect(removalBlocker(input(doors), 'room-s')).toBe("its layout isn't known yet; step inside it once");
    doors.delete('d:shed');
    harvestIntoAtlas({ roomId: 'room-d', name: 'SHED', doors: [{ doorId: 'w', targetSeed: seed('room-a') }] });
    // A harvest without an owner keeps it unknown, even for a module this
    // install minted: its deed may have changed hands since.
    expect(removalBlocker(input(doors), 'room-d')).toBe("its owner isn't known yet; step inside it once");
    // No verified owner (none, or the legacy marker): this room's owner may.
    harvestIntoAtlas({ roomId: 'room-d', name: 'SHED', doors: [{ doorId: 'w', targetSeed: seed('room-a') }], owner: null });
    expect(removalBlocker(input(doors), 'room-d')).toBeNull();
    harvestIntoAtlas({ roomId: 'room-d', name: 'SHED', doors: [{ doorId: 'w', targetSeed: seed('room-a') }], owner: { id: 'Local-Clone' } });
    expect(removalBlocker(input(doors), 'room-d')).toBeNull();
  });

  it('reads a neighbour named like an Object property as a module it knows nothing of', () => {
    const doors = new Map<string, DoorRecord>([['east', pairing('constructor')], ['west', pairing('toString')]]);
    const unknown = "its layout isn't known yet; step inside it once";
    expect(disassemblyCandidates(input(doors)).map((c) => [c.roomId, c.name, c.blocked])).toEqual([
      ['constructor', 'Module', unknown],
      ['toString', 'Module', unknown],
    ]);
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
    // So START on it is a pick of that module (the deed holder's), and
    // STOP, or START on a robot set to no module, is not.
    expect(startResumesDisassembly(readRobotConfig('d1'))).toBe(true);
    expect(startResumesDisassembly({ routine: 'disassemble', target: 'room-b' })).toBe(false);
    expect(startResumesDisassembly({ routine: 'disassemble', parked: true })).toBe(false);
    expect(startResumesDisassembly({ routine: 'serve', parked: true })).toBe(false);
    expect(startResumesDisassembly(null)).toBe(false);
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

  it('a job worked through stays due when its last robot is stopped', () => {
    assignDisassembly('d1', target, 0);
    // Done at minute 24 while the room's owner is away; at minute 30 the
    // robot is stopped. The work stands, and the job still ends when the
    // owner is back.
    writeRobotConfig('d1', { routine: 'disassemble', target: 'room-b', parked: true }, 30 * MIN);
    const j = readDisassemblyJob('room-b')!;
    expect(j).toMatchObject({ crew: [], doneMs: 24 * MIN, asOf: 30 * MIN });
    expect(jobDueAt(j)).toBe(30 * MIN);
    finishDisassemblyJob('room-b', 30 * MIN, 'removed');
    expect(readDisassemblyJob('room-b')).toMatchObject({ finishedAt: 30 * MIN, outcome: 'removed', doneMs: 24 * MIN });
  });

  it('a module re-joined after a finished job starts a fresh one', () => {
    assignDisassembly('d1', target, 0);
    finishDisassemblyJob('room-b', 24 * MIN, 'detached');
    assignDisassembly('d1', target, 40 * MIN);
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d1'], doneMs: 0, startedAt: 40 * MIN });
    expect(readDisassemblyJob('room-b')?.finishedAt).toBeUndefined();
  });

  it('a crew counts at most 16 robots, and one waiting starts when one stops', () => {
    const dock = (i: number) => `d${String(i).padStart(2, '0')}`;
    for (let i = 0; i < 17; i++) assignDisassembly(dock(i), target, 0);
    expect(readDisassemblyJob('room-b')?.crew).toEqual(Array.from({ length: 16 }, (_, i) => dock(i)));
    // One stopped at minute 1: the robot waiting for room starts then,
    // never credited for the minute it waited.
    writeRobotConfig(dock(0), { routine: 'disassemble', target: 'room-b', parked: true }, MIN);
    const j = readDisassemblyJob('room-b')!;
    expect(j.crew).toEqual(Array.from({ length: 16 }, (_, i) => dock(i + 1)));
    expect(workedMs(j, MIN)).toBe(16 * MIN);
    expect(jobDueAt(j)).toBe(1.5 * MIN);
  });

  it('two robots stopped at once on two clients leave the crew, each with its own labor', () => {
    const a = roomWithDocks();
    bindRobotDoc(a);
    assignDisassembly('d1', target, 0);
    assignDisassembly('d2', target, 0);
    expect(readDisassemblyJob('room-b')?.crew).toEqual(['d1', 'd2']);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    // One client stops d1 at minute 1; the other, not having heard of it,
    // stops d2 at minute 12, both robots still working as far as it knows.
    writeRobotConfig('d1', { routine: 'disassemble', target: 'room-b', parked: true }, MIN);
    bindRobotDoc(b);
    writeRobotConfig('d2', { routine: 'disassemble', target: 'room-b', parked: true }, 12 * MIN);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    for (const doc of [a, b]) {
      bindRobotDoc(doc);
      const j = readDisassemblyJob('room-b')!;
      // Nobody works on it any more, and its labor is the thirteen minutes
      // the two robots worked, never two robots for twelve: it is not due
      // early, and it is never due without a robot back on it.
      expect(j.crew).toEqual([]);
      expect(workedMs(j, 60 * MIN)).toBe(13 * MIN);
      expect(jobDueAt(j)).toBeNull();
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
    // (an older client's, or a peer's): it adds no labor from then on, what
    // it did since the last settlement goes with it, and its robot leaves
    // the job for good.
    deleteFurnitureItem('d2');
    const j = readDisassemblyJob('room-b')!;
    expect(j.crew).toEqual(['d1']);
    expect(readRobotConfig('d2')).toBeNull();
    expect(workedMs(j, 10 * MIN)).toBe(10 * MIN);
    expect(jobDueAt(j)).toBe(24 * MIN);
    // The same dock put back later comes back unprogrammed, instead of
    // rejoining the crew as if it had worked all the time it was gone.
    writeFurnitureItem({ id: 'd2', kind: 'charging-dock', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    const back = readDisassemblyJob('room-b')!;
    expect(readRobotConfig('d2')).toBeNull();
    expect(back.crew).toEqual(['d1']);
    expect(workedMs(back, 10 * MIN)).toBe(10 * MIN);
    expect(jobDueAt(back)).toBe(24 * MIN);
  });

  it("a dock a peer's write removes leaves its job on every client", () => {
    const a = roomWithDocks(['d1', 'd2']);
    bindRobotDoc(a);
    assignDisassembly('d1', target, 0);
    assignDisassembly('d2', target, 0);
    // An older client's REMOVE, which doesn't release the robot: a plain
    // delete in its copy of the room doc, sent to this one.
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    b.getMap('furniture').delete('d2');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    expect(readRobotConfig('d2')).toBeNull();
    expect(readDisassemblyJob('room-b')?.crew).toEqual(['d1']);
    // The release reaches the older client too, so a dock it puts back
    // there later starts unprogrammed as well.
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(b.getMap('robot').has('cfg:d2')).toBe(false);
  });

  it('a dock moved, or kept by a layout written whole, stays on its job', () => {
    const doc = roomWithDocks(['d1', 'd2']);
    bindRobotDoc(doc);
    assignDisassembly('d1', target, 0);
    assignDisassembly('d2', target, 0);
    const d1 = { id: 'd1', kind: 'charging-dock', pos: { x: 3, z: 1 }, rot: 1, movable: true } as const;
    const d2 = { id: 'd2', kind: 'charging-dock', pos: { x: 0, z: 0 }, rot: 0, movable: true } as const;
    // Moved across the room, then kept by a layout written whole (each key
    // deleted and set again in one write).
    writeFurnitureItem(d1);
    replaceAllFurniture([d1, d2]);
    expect(readRobotConfig('d1')).toEqual({ routine: 'disassemble', target: 'room-b' });
    expect(readRobotConfig('d2')).toEqual({ routine: 'disassemble', target: 'room-b' });
    expect(readDisassemblyJob('room-b')).toMatchObject({ crew: ['d1', 'd2'], doneMs: 0, asOf: 0 });
    // One that puts something else where a dock was takes its robot off.
    replaceAllFurniture([d1, { ...d2, kind: 'sofa-front' }]);
    expect(readRobotConfig('d2')).toBeNull();
    expect(readDisassemblyJob('room-b')?.crew).toEqual(['d1']);
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
    raiseDisassemblyLabor('room-b', 36);
    const j = readDisassemblyJob('room-b')!;
    expect(j.laborHours).toBe(36);
    expect(workedMs(j, 5 * MIN)).toBe(9 * MIN);
    expect(jobDueAt(j)).toBe(5 * MIN + 13.5 * MIN);
    // Never lowered.
    raiseDisassemblyLabor('room-b', 6);
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

  it('leaves a room or door named like an Object property an ordinary entry', () => {
    // As the stored atlas parses: `__proto__` an own key, room and door alike.
    const atlas = JSON.parse(`{
      "__proto__": {"roomId": "__proto__", "name": "PROTO", "doors": {"east": {"targetSeed": "", "targetRoomId": "room-y"}}, "lastSeen": 1},
      "room-y": {"roomId": "room-y", "name": "Y", "doors": {
        "__proto__": {"targetSeed": "", "targetRoomId": "__proto__"},
        "south": {"targetSeed": "", "targetRoomId": "room-x"}}, "lastSeen": 1},
      "room-x": {"roomId": "room-x", "name": "GONE", "doors": {}, "dismantledAt": 5, "lastSeen": 5}
    }`) as Record<string, AtlasEntry>;
    const seen = visibleAtlas(atlas);
    expect(Object.keys(seen).sort()).toEqual(['__proto__', 'room-y']);
    expect(seen['constructor']).toBeUndefined();
    expect(Object.keys(seen['room-y'].doors)).toEqual(['__proto__']);
    expect(seen['room-y'].doors['__proto__'].targetRoomId).toBe('__proto__');
    expect(atlasComponents(seen).find((c) => c.has('room-y'))?.has('__proto__')).toBe(true);
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

  it('wins a tie with the copy it replaces, at the six-hour ceiling', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const T = 1_000_000;
      const CEILING = T + 6 * 60 * 60 * 1000;
      now.mockReturnValue(T);
      hub();
      // A copy of GARDEN stamped at the bound every reader enforces (a peer
      // six hours ahead) sits in the doc.
      const doc = new Y.Doc();
      doc.getMap('atlas').set('room-b', {
        roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } }, owner: { id: 'p-me' }, updatedAt: CEILING,
      });
      const before = Y.encodeStateAsUpdate(doc);
      bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
      // Taken apart: its stamp can only tie that copy's, and it goes out anyway.
      dismantleInAtlas('room-b', T);
      const shared = doc.getMap('atlas').get('room-b') as { dismantledAt?: number; doors: object; updatedAt: number };
      expect(shared).toMatchObject({ dismantledAt: T, updatedAt: CEILING });
      expect(shared.doors).toEqual({});
      // Another install holding that copy at the same stamp…
      store.clear();
      hub();
      const doc2 = new Y.Doc();
      Y.applyUpdate(doc2, before);
      bindStationAtlasDoc(doc2, { roomId: 'room-a', isPassagePublic: () => false });
      expect(readAtlas()['room-b']?.lastSeen).toBe(CEILING);
      // …reads it as gone in the doc read for its gates, and takes the
      // tombstone when it arrives.
      expect(withSharedAtlasOf(doc, readAtlas(), 'room-b')['room-b']).toBeUndefined();
      Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc));
      expect(readAtlas()['room-b']).toBeUndefined();
      expect(isDismantled('room-b')).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('goes out over a live copy as new as it, without that copy\'s doors', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      hub();
      // A tombstone learned with the module's gates…
      const tomb = new Y.Doc();
      tomb.getMap('atlas').set('room-b', {
        roomId: 'room-b', name: 'GARDEN', doors: {}, gates: { south: 4 }, owner: { id: 'p-me' }, dismantledAt: 1_000_100, updatedAt: 1_000_200,
      });
      bindStationAtlasDoc(tomb, { roomId: 'room-a', isPassagePublic: () => false });
      expect(isDismantled('room-b')).toBe(true);
      expect(tomb.getMap('atlas').get('room-b')).toMatchObject({ updatedAt: 1_000_200 });
      // …meets, in another room's doc, a copy of GARDEN as new as it and
      // with no gates: the tombstone wins, and joins nothing.
      const doc = new Y.Doc();
      doc.getMap('atlas').set('room-b', {
        roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } }, updatedAt: 1_000_200,
      });
      bindStationAtlasDoc(doc, { roomId: 'room-c', isPassagePublic: () => false });
      const shared = doc.getMap('atlas').get('room-b') as { dismantledAt?: number; doors: object };
      expect(shared.dismantledAt).toBe(1_000_100);
      expect(shared.doors).toEqual({});
      expect(isDismantled('room-b')).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('stands in the doc against a live copy of ours as new as it', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      hub();
      const tombstone = {
        roomId: 'room-b', name: 'GARDEN', doors: {}, owner: { id: 'p-me' }, dismantledAt: 1_000_100, updatedAt: 1_000_200,
      };
      const doc = new Y.Doc();
      doc.getMap('atlas').set('room-b', tombstone);
      bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
      expect(isDismantled('room-b')).toBe(true);
      // Another tab of this install, sharing its store, wrote a live copy at
      // the same stamp meanwhile: with doors, then with none but its gates.
      const relive = (over: object) => {
        const stored = JSON.parse(store.get('ssf-station-atlas')!);
        const { dismantledAt: _gone, ...live } = stored['room-b'];
        stored['room-b'] = { ...live, lastSeen: 1_000_200, ...over };
        store.set('ssf-station-atlas', JSON.stringify(stored));
      };
      relive({ doors: { west: { targetSeed: seed('room-a'), targetRoomId: 'room-a' } } });
      pushAtlasToDoc();
      expect(doc.getMap('atlas').get('room-b')).toEqual(tombstone);
      relive({ doors: {}, gates: { south: 4 } });
      pushAtlasToDoc();
      expect(doc.getMap('atlas').get('room-b')).toEqual(tombstone);
    } finally {
      now.mockRestore();
    }
  });

  it('comes back for good once someone stands inside it, even past a tombstone at the six-hour ceiling', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const T = 1_000_000;
      const CEILING = T + 6 * 60 * 60 * 1000;
      now.mockReturnValue(T);
      hub();
      // A peer six hours ahead took GARDEN apart: its tombstone sits in
      // HUB's doc at the bound every reader enforces.
      const D = CEILING - 100;
      const hubDoc = new Y.Doc();
      hubDoc.getMap('atlas').set('room-b', { roomId: 'room-b', name: 'GARDEN', doors: {}, dismantledAt: D, updatedAt: CEILING });
      const before = Y.encodeStateAsUpdate(hubDoc);
      bindStationAtlasDoc(hubDoc, { roomId: 'room-a', isPassagePublic: () => false });
      expect(isDismantled('room-b')).toBe(true);
      // Someone steps into GARDEN by an old pass, its own doc still empty.
      // The harvest of the room they stand in names the tombstone it beats,
      // and can only tie its stamp at the ceiling.
      const garden = new Y.Doc();
      bindStationAtlasDoc(garden, { roomId: 'room-b', isPassagePublic: () => false });
      harvestIntoAtlas({ roomId: 'room-b', name: 'GARDEN', doors: [{ doorId: 'west', targetSeed: seed('room-a') }], owner: { id: 'p-me' } });
      pushAtlasToDoc();
      expect(readAtlas()['room-b']).toMatchObject({ revives: D, lastSeen: CEILING });
      expect(garden.getMap('atlas').get('room-b')).toMatchObject({ revives: D, updatedAt: CEILING });
      // Back in HUB, whose doc still holds the tombstone at that stamp: the
      // module stays, and its copy goes out over the tombstone.
      bindStationAtlasDoc(hubDoc, { roomId: 'room-a', isPassagePublic: () => false });
      expect(readAtlas()['room-b']?.doors).toMatchObject({ west: { targetRoomId: 'room-a' } });
      const shared = hubDoc.getMap('atlas').get('room-b') as { dismantledAt?: number; revives?: number; updatedAt: number };
      expect(shared.dismantledAt).toBeUndefined();
      expect(shared).toMatchObject({ revives: D, updatedAt: CEILING });
      // A doc read for its gates that still holds the tombstone agrees.
      const far = new Y.Doc();
      Y.applyUpdate(far, before);
      expect(withSharedAtlasOf(far, readAtlas(), 'room-b')['room-b']?.doors).toMatchObject({ west: { targetRoomId: 'room-a' } });
      // Another install holding the tombstone at that same stamp takes the
      // copy when it arrives.
      store.clear();
      hub();
      const other = new Y.Doc();
      Y.applyUpdate(other, before);
      bindStationAtlasDoc(other, { roomId: 'room-a', isPassagePublic: () => false });
      expect(isDismantled('room-b')).toBe(true);
      Y.applyUpdate(other, Y.encodeStateAsUpdate(hubDoc));
      expect(isDismantled('room-b')).toBe(false);
      expect(readAtlas()['room-b']).toMatchObject({ revives: D });
      // Taking it apart again still takes it off, and the old copy can't
      // bring it back from that.
      dismantleInAtlas('room-b', T + 5000);
      expect(readAtlas()['room-b']).toBeUndefined();
      bindStationAtlasDoc(hubDoc, { roomId: 'room-a', isPassagePublic: () => false });
      expect(readAtlas()['room-b']).toBeUndefined();
      expect(hubDoc.getMap('atlas').get('room-b')).toMatchObject({ dismantledAt: T + 5000 });
    } finally {
      now.mockRestore();
    }
  });

  it('a seed handed over later does not bring it back', () => {
    hub();
    dismantleInAtlas('room-b', 5);
    noteRoomSeed('room-b', 'GARDEN', seed('room-b'));
    expect(readAtlas()['room-b']).toBeUndefined();
    expect(isDismantled('room-b')).toBe(true);
    expect(isDismantled('room-a')).toBe(false);
    // Still this install's own tombstone, kept for good.
    expect(JSON.parse(store.get('ssf-station-atlas')!)['room-b']).toMatchObject({ dismantledAt: 5, dismantledHere: true });
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

  it('stays gone however many modules are taken apart after, here or elsewhere', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      hub();
      now.mockReturnValue(1_000_500);
      dismantleInAtlas('room-b', 1_000_400);
      // More modules taken apart here since than the pool keeps of others'…
      const more = MAX_DISMANTLED + 6;
      for (let i = 0; i < more; i++) {
        now.mockReturnValue(1_001_000 + i);
        dismantleInAtlas(`mod-${i}`, 1_001_000 + i);
      }
      // …and as many heard of from a room doc.
      const gossip = new Y.Doc();
      for (let i = 0; i < more; i++) {
        gossip.getMap('atlas').set(`far-${i}`, {
          roomId: `far-${i}`, name: `F${i}`, doors: {}, dismantledAt: 1_002_000 + i, updatedAt: 1_002_000 + i,
        });
      }
      now.mockReturnValue(1_003_000);
      bindStationAtlasDoc(gossip, { roomId: 'room-a', isPassagePublic: () => false });
      // Every module this install took apart is still held as gone; the
      // ones heard of fill the pool.
      expect(isDismantled('room-b')).toBe(true);
      for (let i = 0; i < more; i++) expect(isDismantled(`mod-${i}`)).toBe(true);
      const stored = JSON.parse(store.get('ssf-station-atlas')!) as Record<string, { dismantledHere?: true }>;
      expect(Object.keys(stored).filter((rid) => rid.startsWith('far-'))).toHaveLength(MAX_DISMANTLED);
      // Only this install's own are marked, and the mark never goes out.
      expect(Object.keys(stored).filter((rid) => stored[rid].dismantledHere).sort())
        .toEqual(['room-b', ...Array.from({ length: more }, (_, i) => `mod-${i}`)].sort());
      expect(gossip.getMap('atlas').get('room-b')).toMatchObject({ dismantledAt: 1_000_400 });
      expect(gossip.getMap('atlas').get('room-b')).not.toHaveProperty('dismantledHere');
      // A room doc still holding GARDEN from before the job ended.
      const doc = new Y.Doc();
      doc.getMap('atlas').set('room-b', {
        roomId: 'room-b', name: 'GARDEN', doors: { west: { targetRoomId: 'room-a' } }, updatedAt: 1_000_000,
      });
      bindStationAtlasDoc(doc, { roomId: 'room-a', isPassagePublic: () => false });
      expect(readAtlas()['room-b']).toBeUndefined();
      expect(withSharedAtlasOf(doc, readAtlas(), 'room-b')['room-b']).toBeUndefined();
      // Taken apart again elsewhere since (a newer tombstone): still ours to keep.
      gossip.getMap('atlas').set('room-b', { roomId: 'room-b', name: 'GARDEN', doors: {}, dismantledAt: 1_002_900, updatedAt: 1_002_950 });
      bindStationAtlasDoc(gossip, { roomId: 'room-a', isPassagePublic: () => false });
      expect(JSON.parse(store.get('ssf-station-atlas')!)['room-b']).toMatchObject({ dismantledAt: 1_002_900, dismantledHere: true });
    } finally {
      now.mockRestore();
    }
  });
});

// ── Who takes a module apart ─────────────────────────────────────────────────

/**
 * A module off the station can't be put back, so taking one apart is the
 * room's deed holder's (main.ts's authority split), never every venture
 * shareholder's. The gates live in world.ts, devices.ts and main.ts, which
 * these tests cannot run, so they read the source, as roomOwner.test.ts does
 * for #142's: what they catch is a gate widened back to the edit permission.
 */
describe('the deed takes a module apart (source scan)', () => {
  const source = (file: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), 'utf8');
  const between = (text: string, from: string, to: string): string => {
    const start = text.indexOf(from);
    expect(start, `${from} not found`).toBeGreaterThan(-1);
    const end = text.indexOf(to, start + from.length);
    expect(end, `${to} not found after ${from}`).toBeGreaterThan(start);
    return text.slice(start, end);
  };

  it("ends a job on the deed holder's game", () => {
    const body = between(source('world.ts'), 'private updateDisassembly(', 'private finishDisassembly(');
    expect(body).toContain('holdsRoomDeed()');
    expect(body).not.toContain('canEditRoom');
  });

  it('sets a robot to a module for the deed holder alone, checked again at the click', () => {
    const devices = source('devices.ts');
    expect(devices).toContain('const mayTakeApart = (): boolean => deps.canEdit() && (deps.holdsDeed?.() ?? true);');
    const wire = between(devices, 'const wireDisassemblyPicks = ', 'const redrawDisassembly = ');
    const click = wire.indexOf("addEventListener('click'");
    expect(click).toBeGreaterThan(-1);
    const recheck = wire.indexOf('mayTakeApart()', click);
    expect(recheck).toBeGreaterThan(click);
    expect(recheck).toBeLessThan(wire.indexOf('assignDisassembly(', click));
    expect(between(source('world.ts'), 'createRobotDockUI({', '});')).toContain('holdsDeed: () => holdsRoomDeed()');
  });

  it('puts a stopped robot back on its module for the deed holder alone, checked again at the click', () => {
    const devices = source('devices.ts');
    expect(devices).toContain('const parkUsable = owner && (!startResumesDisassembly(cfg) || mayTakeApart());');
    expect(devices).toContain("<button data-park=\"1\" ${parkUsable ? '' : 'disabled'}");
    const park = between(devices, "panel.querySelector<HTMLButtonElement>('[data-park]')", 'wireDisassemblyPicks();');
    const recheck = park.indexOf('if (startResumesDisassembly(c) && !mayTakeApart())');
    expect(recheck).toBeGreaterThan(-1);
    expect(recheck).toBeLessThan(park.indexOf('writeRobotConfig('));
  });

  it("never takes having minted a module for owning it", () => {
    const input = between(source('world.ts'), 'private disassemblyInput(', '\n  }');
    expect(input).toContain('playerId: getPlayerId()');
    expect(input).not.toContain('ledgerHasRoom');
  });

  it('is the raw deed check, refused while a leave is under way', () => {
    const gate = between(source('main.ts'), 'setRoomDeedCheck(() => {', '\n  });');
    expect(gate).toContain('currentRoomDeedIsMine()');
    expect(gate).not.toContain('isLocalPlayerRoomOwner');
    const leaving = gate.indexOf('if (roomLeavesUnderWay > 0) return false;');
    expect(leaving).toBeGreaterThan(-1);
    expect(leaving).toBeLessThan(gate.indexOf('if (!yjsSync)'));
  });
});
