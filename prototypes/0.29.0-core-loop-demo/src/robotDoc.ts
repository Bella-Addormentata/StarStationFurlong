/**
 * 🤖 `robot` map binding — per-dock ROBOT ROUTINE config (#77 Phase C s3).
 *
 * The room doc carries a `robot` Y.Map. Each placed charging-dock's robot has a
 * configured routine (owner-programmed at the dock's console), keyed by the dock
 * item id: `cfg:<dockId>` → { routine }. Whole-value LWW; only the owner writes
 * it (the programming UI gates on canEditRoom). All clients read it so every
 * client runs each dock's robot the same way — behaviour is CONFIGURED, not
 * inferred from room contents.
 *
 * Mirrors the casinoDoc / gamesDoc binding: REBIND PER JOIN from main.ts
 * (bindRobotDoc beside bindCasinoDoc), with an OFFLINE FALLBACK to a page-local
 * doc so a solo owner can still program robots.
 */

import * as Y from 'yjs';
import type { DisassemblyJob, DisassemblyJobRecord, DisassemblyTarget, DisassemblyWork } from './disassembly';
import {
  MAX_CREW, isDisassemblyJobRecord, isDisassemblyWork, jobDueAt, jobFromWork, jobLaborMs, startWork, stopWork,
  workRanOut, workedMs, workingCrew,
} from './disassembly';
import { placedFurnitureIn } from './furnitureDoc';

/** 🚀 'pilot' (robot pilot routes, design §2a): the Ship pilot routine. It holds
 *  no route: it makes the dock's robot ELIGIBLE to be named the ship's robot
 *  captain at the helm (shipPilot.ts), and while a running route names it the
 *  robot walks to the helm and the berth door and announces the timetable.
 *  Offered at the console only in a flight-capable module. An older client
 *  reads a config with an unknown routine as unprogrammed (isRobotConfig
 *  rejects it), so its copy of the robot serves drinks: it degrades, and
 *  nothing it reads is corrupted. */
export type RobotRoutine = 'serve' | 'croupier' | 'idle' | 'custom' | 'coach' | 'dance' | 'pilot' | 'disassemble';

/** 🤖 #77C s4: one bounded step of an owner-authored routine (a chip list, NOT
 *  a DSL). The robot loops the list: walk to a spot, say a line, or pause. */
export type RobotStep =
  | { kind: 'goto'; x: number; z: number }
  | { kind: 'say'; text: string }
  | { kind: 'wait'; secs: number };

/** Hard cap on a custom script (keeps the synced record small + the loop cheap). */
export const MAX_SCRIPT_STEPS = 16;

export interface RobotConfig {
  routine: RobotRoutine;
  /** Only meaningful when routine === 'custom'. */
  script?: RobotStep[];
  /** 🤖 STOP/START (owner request): parked = the robot walks back to its dock and
   *  stands on it, OFF, overriding the routine. START (parked false/absent)
   *  resumes the routine. Independent of `routine` so it survives a routine edit. */
  parked?: boolean;
  /** 🔧 'disassemble' (#192): the room id of the module this robot takes
   *  apart — its job is `job:<target>` in the same map (disassembly.ts), and
   *  this config is what puts the robot in that job's crew (unless parked,
   *  and while its dock is placed in the room's layout).
   *  Absent: no module picked yet, the robot waits on its dock. */
  target?: string;
}

export const ROBOT_ROUTINES: readonly RobotRoutine[] = ['serve', 'croupier', 'idle', 'custom', 'coach', 'dance', 'pilot', 'disassemble'];

/** Human labels for the routine dropdown. */
export const ROUTINE_LABELS: Record<RobotRoutine, string> = {
  serve: 'Serve drinks',
  croupier: 'Table croupier',
  idle: 'Idle at dock',
  custom: 'Custom script',
  coach: '🏋️ Fitness coach',
  dance: '🎉 Party dancer',
  pilot: '🚀 Ship pilot',
  disassemble: '🔧 Disassemble module',
};

let boundDoc: Y.Doc | null = null;
let robotMap: Y.Map<unknown> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (err) {
      console.error('[robot] listener threw during doc notify:', err);
    }
  }
}

function docAlive(): boolean {
  return (
    boundDoc !== null &&
    (boundDoc as { isDestroyed?: boolean }).isDestroyed !== true
  );
}

export function bindRobotDoc(doc: Y.Doc): void {
  boundDoc = doc;
  const map = doc.getMap('robot');
  robotMap = map;
  map.observe(() => notify());
  // 🔧 Edits made elsewhere may have crossed ours: once they arrive, each
  // job's crew is held to its robots' records (reconcileCrews).
  map.observe((event) => {
    if (!event.transaction.local) reconcileCrews(map);
  });
  // 🔧 A charging dock taken out of the layout ends its robot's
  // disassembly work for good (releaseRemovedDocks).
  doc.getMap('furniture').observe((event) => releaseRemovedDocks(map, event));
  notify();
}

/** Bound map, lazily falling back to a page-local doc (offline). */
function ensureMap(): Y.Map<unknown> {
  if (!docAlive() || !robotMap) bindRobotDoc(new Y.Doc());
  return robotMap!;
}

export function subscribeRobot(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Step guard — the script crosses the room-doc trust boundary (peer writes). */
export function isRobotStep(value: unknown): value is RobotStep {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as { kind?: unknown; x?: unknown; z?: unknown; text?: unknown; secs?: unknown };
  if (s.kind === 'goto') return Number.isFinite(s.x) && Number.isFinite(s.z);
  if (s.kind === 'say') return typeof s.text === 'string';
  if (s.kind === 'wait') return Number.isFinite(s.secs) && (s.secs as number) >= 0;
  return false;
}

function isRobotConfig(value: unknown): value is RobotConfig {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<RobotConfig>;
  if (
    typeof c.routine !== 'string' ||
    !(ROBOT_ROUTINES as readonly string[]).includes(c.routine)
  ) {
    return false;
  }
  if (c.script !== undefined) {
    if (!Array.isArray(c.script) || c.script.length > MAX_SCRIPT_STEPS) return false;
    if (!c.script.every(isRobotStep)) return false;
  }
  if (c.parked !== undefined && typeof c.parked !== 'boolean') return false;
  if (c.target !== undefined && (typeof c.target !== 'string' || c.target.length === 0 || c.target.length > 128)) return false;
  return true;
}

/** The dock's configured routine, or null if never programmed (defaults apply). */
export function readRobotConfig(dockId: string): RobotConfig | null {
  const v = ensureMap().get(`cfg:${dockId}`);
  return isRobotConfig(v) ? v : null;
}

/** Owner-only in practice (the programming UI gates on canEditRoom).
 *  🔧 A robot joins or leaves a disassembly job's crew as its routine,
 *  target or STOP/START says; the write starts or stops its clock on the
 *  job at `now` (setConfigIn). */
export function writeRobotConfig(dockId: string, config: RobotConfig, now = Date.now()): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    setConfigIn(map, dockId, config, now);
  });
}

/** Drop a dock's config (its dock was removed): its robot leaves any crew. */
export function clearRobotConfig(dockId: string, now = Date.now()): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    setConfigIn(map, dockId, null, now);
  });
}

// ── 🔧 Disassembly jobs (#192) ───────────────────────────────────────────────

/** Most job records read from one room's map (a peer's junk must not make
 *  every read walk an unbounded list). */
const MAX_JOBS = 64;

/** Most entries one read of the jobs walks, whatever they hold: far more
 *  than a room's docks and jobs, so only a peer's junk reaches it. Each read
 *  is one walk (World reads the jobs twice a second). */
export const MAX_ROBOT_MAP_SCAN = 1024;

const jobKey = (roomId: string) => `job:${roomId}`;

/** A robot's labor record on a module's job: one key per robot per module,
 *  so no two robots' labor ever shares a value (the ids are JSON-quoted, so
 *  no pair of them spells another pair's key). */
const workKey = (roomId: string, dockId: string) => `work:${JSON.stringify([roomId, dockId])}`;

/** What one walk of the map finds. */
interface JobIndex {
  /** The well-formed job records, at most MAX_JOBS. */
  records: DisassemblyJobRecord[];
  /** Each module's robots set to it and not stopped, their docks placed in
   *  the same doc's layout: who may work on it. Each robot's membership
   *  lives in its own config key, so two robots edited at once never
   *  overwrite each other's. */
  active: Map<string, Set<string>>;
  /** Every module some robot is set to, stopped ones included. */
  targeted: Set<string>;
  /** The well-formed robot work records, by module. */
  work: Map<string, DisassemblyWork[]>;
  /** The walk stopped short of the map's end (MAX_ROBOT_MAP_SCAN): a peer's
   *  junk ahead of them could hide any record, so nothing is written from
   *  this index, and no job is opened or ended on it. */
  partial: boolean;
}

const NO_DOCKS: ReadonlySet<string> = new Set();

function indexJobs(map: Y.Map<unknown>): JobIndex {
  const records: DisassemblyJobRecord[] = [];
  const active = new Map<string, Set<string>>();
  const targeted = new Set<string>();
  const work = new Map<string, DisassemblyWork[]>();
  // A config can outlive its dock (a layout written without releasing it,
  // until releaseRemovedDocks drops it): only a dock placed in this same
  // room doc's layout has a robot, so only its config counts. A gone one
  // adds no labor; what it did since its last record goes with it, so a
  // job is never ahead of its robots.
  const doc = map.doc;
  const placed = (dockId: string) => doc !== null && placedFurnitureIn(doc, dockId)?.kind === 'charging-dock';
  let scanned = 0;
  let partial = false;
  for (const [key, value] of map.entries()) {
    if (++scanned > MAX_ROBOT_MAP_SCAN) {
      partial = true;
      break;
    }
    if (key.startsWith('job:')) {
      if (records.length < MAX_JOBS && isDisassemblyJobRecord(value) && jobKey(value.roomId) === key) records.push(value);
      continue;
    }
    if (key.startsWith('work:')) {
      if (!isDisassemblyWork(value) || workKey(value.roomId, value.dockId) !== key) continue;
      const list = work.get(value.roomId);
      if (list) list.push(value);
      else work.set(value.roomId, [value]);
      continue;
    }
    if (!key.startsWith('cfg:') || !isRobotConfig(value) || value.routine !== 'disassemble' || !value.target) continue;
    const dockId = key.slice(4);
    if (!placed(dockId)) continue;
    targeted.add(value.target);
    if (value.parked === true) continue;
    const docks = active.get(value.target);
    if (docks) docks.add(dockId);
    else active.set(value.target, new Set([dockId]));
  }
  return { records, active, targeted, work, partial };
}

/** A stored record as a job: its robots' labor folded in, and its crew
 *  (none once it has ended: the robots set to it are back on their docks). */
function asJob(index: JobIndex, record: DisassemblyJobRecord): DisassemblyJob {
  return jobFromWork(record, index.work.get(record.roomId) ?? [], index.active.get(record.roomId) ?? NO_DOCKS);
}

/** The stored record of the job on one module (no labor folded in). */
function readRecordIn(map: Y.Map<unknown>, roomId: string): DisassemblyJobRecord | null {
  const v = map.get(jobKey(roomId));
  return isDisassemblyJobRecord(v) && v.roomId === roomId ? v : null;
}

function readJobIn(map: Y.Map<unknown>, roomId: string): DisassemblyJob | null {
  const record = readRecordIn(map, roomId);
  return record ? asJob(indexJobs(map), record) : null;
}

/** Write (or drop, null) a dock's config inside the caller's transaction.
 *  On each open job, the robot's clock stops if it leaves the crew (the
 *  time since its last record its labor, if it was working, up to when the
 *  job's labor ran out if it did) and starts if it joins. Only its own
 *  record is credited: another robot's labor is never written here, so two
 *  clients editing two robots at once can't credit either with time only
 *  the other saw. The crew is then held to the records (fillCrewIn):
 *  another robot is only ever started or stopped uncredited. A finished job no robot is set to any more is
 *  dropped, and so are the work records no open job counts; an open one
 *  stays, its robots' labor kept for later. */
function setConfigIn(map: Y.Map<unknown>, dockId: string, config: RobotConfig | null, now: number): void {
  const prior = map.get(`cfg:${dockId}`);
  const before = indexJobs(map);
  if (config) map.set(`cfg:${dockId}`, config);
  else map.delete(`cfg:${dockId}`);
  const after = indexJobs(map);
  if (before.partial || after.partial) {
    // The walks may have missed any record: none is written from them. Only
    // this robot's own record on a job it leaves or joins stops, uncredited
    // (whether it was in the crew can't be told), so its clock never runs on
    // from a start before. It starts again once the map reads whole.
    stopOwnWorkIn(map, dockId, isRobotConfig(prior) ? prior : null, config);
    return;
  }
  // What no robot needs any more goes first: a finished job no robot is set
  // to, and the work records of a job that ended, is gone or was opened
  // again since.
  for (const record of after.records) {
    if (record.finishedAt !== undefined && !after.targeted.has(record.roomId)) map.delete(jobKey(record.roomId));
  }
  for (const list of after.work.values()) {
    for (const w of list) {
      const record = readRecordIn(map, w.roomId);
      if (record && record.finishedAt === undefined && record.startedAt === w.startedAt) continue;
      map.delete(workKey(w.roomId, w.dockId));
    }
  }
  for (const record of after.records) {
    if (record.finishedAt !== undefined) continue;
    const work = workOf(after, record);
    const active = after.active.get(record.roomId) ?? NO_DOCKS;
    const job = asJob(before, record);
    const wasWorking = job.crew.includes(dockId);
    const mine = work.get(dockId);
    if (mine?.working && !(wasWorking && active.has(dockId))) {
      // Leaving the crew: its clock stops, the time since its last record
      // its labor, though none after the job's labor ran out (it has waited
      // on its dock since). A record that says it works though it wasn't
      // counted (its dock was gone, or edits crossed) stops uncredited, and
      // the robot starts afresh below if it is joining.
      const due = jobDueAt(job);
      const stopped = wasWorking ? stopWork(mine, due === null ? now : Math.min(now, due)) : { ...mine, working: false };
      map.set(workKey(record.roomId, dockId), stopped);
      work.set(dockId, stopped);
    }
    fillCrewIn(map, record, work, active, now);
  }
}

/** The module a config puts its robot to work on, or null (another
 *  routine, none picked yet, or stopped). */
function workingOn(config: RobotConfig | null): string | null {
  return config?.routine === 'disassemble' && config.target && config.parked !== true ? config.target : null;
}

/** On a map that can't be read whole (setConfigIn): the robot's own record
 *  on each job it leaves or joins stops, uncredited, if it says it works.
 *  Read and written by its own key: no other record is touched. */
function stopOwnWorkIn(map: Y.Map<unknown>, dockId: string, from: RobotConfig | null, to: RobotConfig | null): void {
  const was = workingOn(from);
  const next = workingOn(to);
  if (was === next) return;
  for (const roomId of [was, next]) {
    if (!roomId) continue;
    const key = workKey(roomId, dockId);
    const w = map.get(key);
    if (isDisassemblyWork(w) && w.working && workKey(w.roomId, w.dockId) === key) map.set(key, { ...w, working: false });
  }
}

/** One opening of a job's robot work records, by dock. */
function workOf(index: JobIndex, record: DisassemblyJobRecord): Map<string, DisassemblyWork> {
  const work = new Map<string, DisassemblyWork>();
  for (const w of index.work.get(record.roomId) ?? []) if (w.startedAt === record.startedAt) work.set(w.dockId, w);
  return work;
}

/** Hold an open job's crew to its records, inside the caller's transaction
 *  (`work` is updated with what is written). A robot whose record says it
 *  works but that workingCrew leaves out (two clients each started a robot
 *  at once, past MAX_CREW) stops, uncredited: its time was never counted.
 *  A robot set to the job and not stopped that isn't working (it waited for
 *  room, or crossed edits left its record stopped) starts at `now` while
 *  the crew has room, never credited for the wait, unless the job's labor
 *  has run out: then it waits on its dock with the crew until the module
 *  comes off or the job is raised (raiseJobLaborIn). Every client reading
 *  the same records stops and starts the same robots. */
function fillCrewIn(
  map: Y.Map<unknown>,
  record: DisassemblyJobRecord,
  work: Map<string, DisassemblyWork>,
  active: ReadonlySet<string>,
  now: number,
): void {
  const crew = workingCrew(work.values(), active);
  for (const w of [...work.values()]) {
    if (!w.working || !active.has(w.dockId) || crew.has(w.dockId)) continue;
    const stopped = { ...w, working: false };
    map.set(workKey(record.roomId, w.dockId), stopped);
    work.set(w.dockId, stopped);
  }
  if (workedMs(jobFromWork(record, work.values(), active), now) >= jobLaborMs(record)) return;
  let size = crew.size;
  for (const d of [...active].sort()) {
    if (size >= MAX_CREW) break;
    if (crew.has(d)) continue;
    const started = startWork(record, d, work.get(d), now);
    map.set(workKey(record.roomId, d), started);
    work.set(d, started);
    size++;
  }
}

/** 🔧 After edits made elsewhere arrive: each open job's crew held to its
 *  records (fillCrewIn) as of their arrival. Two clients' edits to one
 *  robot can cross so that its config says it works while its record says
 *  it stopped (one stops it while the other writes its config as it was);
 *  it starts now, never credited for the time before, instead of waiting
 *  on its dock until its config is next written. Edits made here hold the
 *  crew as they are written (setConfigIn). */
function reconcileCrews(map: Y.Map<unknown>): void {
  const doc = map.doc;
  if (!doc) return;
  const index = indexJobs(map);
  if (index.partial) return;
  const open = index.records.filter((r) => r.finishedAt === undefined);
  if (open.length === 0) return;
  const now = Date.now();
  doc.transact(() => {
    for (const record of open) {
      fillCrewIn(map, record, workOf(index, record), index.active.get(record.roomId) ?? NO_DOCKS, now);
    }
  });
}

/**
 * 🔧 A charging dock taken out of the room's layout by a write that didn't
 * release its robot first (an older client's, or a peer's: this build's
 * REMOVE and templates release it): every client in the room sees the
 * removal and drops the dock's Disassemble config, so its robot leaves the
 * job for good. Its labor since its last record goes with it (the crew
 * counts placed docks only), and the same dock put back later comes back
 * unprogrammed, instead of rejoining the crew as if it had worked all the
 * time it was gone. A dock moved, or kept by a write that replaces the
 * layout, never left: it stays on the job. A removal no client of this
 * build saw is caught when one next comes into the room
 * (releaseOrphanedDocks). (A removal and a return made while no client of
 * this build was in the room leave the config as it was.)
 */
function releaseRemovedDocks(map: Y.Map<unknown>, event: Y.YMapEvent<unknown>): void {
  const doc = map.doc;
  if (!doc) return;
  const gone: string[] = [];
  event.changes.keys.forEach((change, dockId) => {
    if (change.action === 'add') return;
    if ((change.oldValue as { kind?: unknown } | null | undefined)?.kind !== 'charging-dock') return;
    if (change.action === 'update' && placedFurnitureIn(doc, dockId)?.kind === 'charging-dock') return;
    const config = map.get(`cfg:${dockId}`);
    if (isRobotConfig(config) && config.routine === 'disassemble') gone.push(dockId);
  });
  if (gone.length === 0) return;
  const now = Date.now();
  doc.transact(() => {
    for (const dockId of gone) setConfigIn(map, dockId, null, now);
  });
}

/**
 * 🔧 The room's state has arrived (main.ts calls this once a visit, when it
 * has): a Disassemble config whose dock is not in the layout lost its dock
 * while no client of this build was there to see it go, so no removal ever
 * released it. Its robot leaves the job for good now, uncredited (the crew
 * never counted it without its dock), so the same dock put back later
 * starts unprogrammed, as after a removal seen (releaseRemovedDocks),
 * instead of its old record crediting all the time it was gone.
 */
export function releaseOrphanedDocks(now = Date.now()): void {
  const map = ensureMap();
  const doc = map.doc;
  if (!doc) return;
  const gone: string[] = [];
  let scanned = 0;
  for (const [key, value] of map.entries()) {
    if (++scanned > MAX_ROBOT_MAP_SCAN) break;
    if (!key.startsWith('cfg:') || !isRobotConfig(value) || value.routine !== 'disassemble') continue;
    const dockId = key.slice(4);
    if (placedFurnitureIn(doc, dockId)?.kind !== 'charging-dock') gone.push(dockId);
  }
  if (gone.length === 0) return;
  doc.transact(() => {
    for (const dockId of gone) setConfigIn(map, dockId, null, now);
  });
}

/** Every disassembly job in this room, open or finished, with its crew. */
export function readDisassemblyJobs(): DisassemblyJob[] {
  const index = indexJobs(ensureMap());
  return index.records.map((r) => asJob(index, r));
}

/** 🔧 readDisassemblyJobs, or null when one walk can't read the whole map
 *  (more entries than MAX_ROBOT_MAP_SCAN, which a peer could have flooded):
 *  any job or robot record could be among those left out, so none is
 *  opened or ended until it reads whole. */
export function readDisassemblyJobsIfComplete(): DisassemblyJob[] | null {
  const index = indexJobs(ensureMap());
  return index.partial ? null : index.records.map((r) => asJob(index, r));
}

/** The job on one module, with its crew, or null. */
export function readDisassemblyJob(roomId: string): DisassemblyJob | null {
  return readJobIn(ensureMap(), roomId);
}

/** 🔧 Would START on this config put its robot back on a module's job: a
 *  stopped Disassemble robot set to one? That is the room's deed holder's
 *  call, like setting it to the module (the console checks both). STOP is
 *  not: it only pauses the job. */
export function startResumesDisassembly(config: RobotConfig | null | undefined): boolean {
  return config?.parked === true && config.routine === 'disassemble' && !!config.target;
}

/** 🔧 Set a dock's robot to take `target` apart. The job is opened if it has
 *  none (or only a finished one); an open one costed below `target`'s labor
 *  is raised to it (raiseJobLaborIn). The robot joins its crew unless it is
 *  parked. Its script and STOP/START state are kept. Nothing is written
 *  while the map can't be read whole (readDisassemblyJobsIfComplete). */
export function assignDisassembly(dockId: string, target: DisassemblyTarget, now = Date.now()): void {
  const map = ensureMap();
  // A job opened on a map that can't be read whole could be one no walk
  // finds (the console holds the pick then: removalBlocker).
  if (indexJobs(map).partial) return;
  boundDoc!.transact(() => {
    const open = readRecordIn(map, target.roomId);
    if (!open || open.finishedAt !== undefined) {
      const job: DisassemblyJobRecord = { ...target, startedAt: now, doneMs: 0, asOf: now };
      map.set(jobKey(target.roomId), job);
    } else {
      raiseJobLaborIn(map, open, target.laborHours, now);
    }
    const c = readRobotConfig(dockId);
    setConfigIn(map, dockId, {
      routine: 'disassemble',
      target: target.roomId,
      ...(c?.script?.length ? { script: c.script } : {}),
      ...(c?.parked ? { parked: true } : {}),
    }, now);
  });
}

/** The module needs more labor than its open job was costed at: the labor
 *  is worked out by whoever sets a robot to it or ends it, from the
 *  module's size, so a record costed below it (the module was enlarged
 *  since, or the record was written short) is raised. The work its robots
 *  have done stands (it is in their own records); the rest is still to do.
 *  A job whose labor ran out before `now` has its crew's clocks settled at
 *  that time first (workRanOut): the robots waited on their docks since,
 *  and that wait is no labor on the raised job. They start again now, as
 *  the rest of the job begins (fillCrewIn). This writes the crew's records,
 *  so a robot stopped elsewhere at the same moment, before its labor ran
 *  out, may be credited to when it ran out: at most the time the two edits
 *  took to meet, the same on every client. Never lowered. */
function raiseJobLaborIn(map: Y.Map<unknown>, record: DisassemblyJobRecord, laborHours: number, now: number): void {
  if (record.finishedAt !== undefined || record.laborHours >= laborHours) return;
  const index = indexJobs(map);
  if (index.partial) return;
  const work = workOf(index, record);
  const active = index.active.get(record.roomId) ?? NO_DOCKS;
  for (const w of workRanOut(record, work.values(), active, now)) {
    map.set(workKey(record.roomId, w.dockId), w);
    work.set(w.dockId, w);
  }
  const raised = { ...record, laborHours };
  map.set(jobKey(record.roomId), raised);
  fillCrewIn(map, raised, work, active, now);
}

/** 🔧 Raise an open job to the module's labor (raiseJobLaborIn). */
export function raiseDisassemblyLabor(roomId: string, laborHours: number, now = Date.now()): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    const record = readRecordIn(map, roomId);
    if (record) raiseJobLaborIn(map, record, laborHours, now);
  });
}

/** 🔧 End a job: its labor is done at `at` (the due time, the same on every
 *  client) and the module either came off the station or had already been
 *  disconnected. Its crew goes back to their docks (their configs still
 *  point at it, so the console can say how it ended). */
export function finishDisassemblyJob(roomId: string, at: number, outcome: 'removed' | 'detached'): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    const record = readRecordIn(map, roomId);
    if (!record || record.finishedAt !== undefined) return;
    const index = indexJobs(map);
    // All its labor done, settled when it ended (the record guard holds an
    // ended job to that), and its robots' records of it done with.
    const end = Math.max(at, asJob(index, record).asOf);
    map.set(jobKey(roomId), { ...record, doneMs: jobLaborMs(record), asOf: end, finishedAt: end, outcome });
    for (const w of index.work.get(roomId) ?? []) map.delete(workKey(roomId, w.dockId));
  });
}

// Console verification handle (the __ssfCasino precedent). Guarded: the
// module is also imported where there is no window (roomTemplates under
// vitest configures a template's docks through it).
if (typeof window !== 'undefined') {
  (window as unknown as { __ssfRobot: unknown }).__ssfRobot = {
    readRobotConfig,
    writeRobotConfig,
    clearRobotConfig,
    readDisassemblyJobs,
  };
}
