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
import type { DisassemblyJob, DisassemblyJobRecord, DisassemblyTarget } from './disassembly';
import { MAX_CREW, isDisassemblyJobRecord, jobLaborMs, settleJob } from './disassembly';
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
 *  target or STOP/START says; every config write settles the progress of
 *  each job whose crew it changes, at `now` (disassembly.ts). */
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

/** What one walk of the map finds. */
interface JobIndex {
  /** The well-formed job records, at most MAX_JOBS. */
  records: DisassemblyJobRecord[];
  /** Each module's crew: the docks whose configs set their robots to it and
   *  not stopped, sorted (the same on every client), at most MAX_CREW. Each
   *  robot's membership lives in its own config key, so two robots edited
   *  at once never overwrite each other's (a crew stored in the job record
   *  would be one value, and Yjs keeps one of two concurrent writes). */
  crews: Map<string, string[]>;
  /** Every module some robot is set to, stopped ones included. */
  targeted: Set<string>;
}

function indexJobs(map: Y.Map<unknown>): JobIndex {
  const records: DisassemblyJobRecord[] = [];
  const crews = new Map<string, string[]>();
  const targeted = new Set<string>();
  // A config can outlive its dock (a layout written without releasing it,
  // until releaseRemovedDocks drops it): only a dock placed in this same
  // room doc's layout has a robot, so only its config counts. A gone one
  // adds no labor; what it did since the last settlement goes with it, so a
  // job is never ahead of its robots.
  const doc = map.doc;
  const placed = (dockId: string) => doc !== null && placedFurnitureIn(doc, dockId)?.kind === 'charging-dock';
  let scanned = 0;
  for (const [key, value] of map.entries()) {
    if (++scanned > MAX_ROBOT_MAP_SCAN) break;
    if (key.startsWith('job:')) {
      if (records.length < MAX_JOBS && isDisassemblyJobRecord(value) && jobKey(value.roomId) === key) records.push(value);
      continue;
    }
    if (!key.startsWith('cfg:') || !isRobotConfig(value) || value.routine !== 'disassemble' || !value.target) continue;
    const dockId = key.slice(4);
    if (!placed(dockId)) continue;
    targeted.add(value.target);
    if (value.parked === true) continue;
    const crew = crews.get(value.target);
    if (crew) crew.push(dockId);
    else crews.set(value.target, [dockId]);
  }
  for (const [roomId, crew] of crews) crews.set(roomId, crew.sort().slice(0, MAX_CREW));
  return { records, crews, targeted };
}

/** A stored record as a job, its crew from the index (none once it has
 *  ended: the robots set to it are back on their docks). */
function asJob(index: JobIndex, record: DisassemblyJobRecord): DisassemblyJob {
  return { ...record, crew: record.finishedAt !== undefined ? [] : [...(index.crews.get(record.roomId) ?? [])] };
}

function readJobIn(map: Y.Map<unknown>, roomId: string): DisassemblyJob | null {
  const v = map.get(jobKey(roomId));
  return isDisassemblyJobRecord(v) && v.roomId === roomId ? asJob(indexJobs(map), v) : null;
}

const sameCrew = (a: string[], b: string[]) => a.length === b.length && a.every((d, i) => d === b[i]);

/** Write (or drop, null) a dock's config inside the caller's transaction.
 *  Each open job whose crew that changes is settled at `now` with the crew
 *  it had, so the labor so far is kept. A finished job no robot is set to
 *  any more is dropped; an open one stays, its progress kept for later. */
function setConfigIn(map: Y.Map<unknown>, dockId: string, config: RobotConfig | null, now: number): void {
  const before = indexJobs(map);
  if (config) map.set(`cfg:${dockId}`, config);
  else map.delete(`cfg:${dockId}`);
  const after = indexJobs(map);
  for (const record of before.records) {
    if (record.finishedAt !== undefined) continue;
    const job = asJob(before, record);
    if (sameCrew(job.crew, after.crews.get(record.roomId) ?? [])) continue;
    map.set(jobKey(record.roomId), settleJob(job, now));
  }
  for (const record of after.records) {
    if (record.finishedAt !== undefined && !after.targeted.has(record.roomId)) map.delete(jobKey(record.roomId));
  }
}

/**
 * 🔧 A charging dock taken out of the room's layout by a write that didn't
 * release its robot first (an older client's, or a peer's: this build's
 * REMOVE and templates release it): every client in the room sees the
 * removal and drops the dock's Disassemble config, so its robot leaves the
 * job for good. Its labor since the last settlement goes with it (the crew
 * counts placed docks only), and the same dock put back later comes back
 * unprogrammed, instead of rejoining the crew as if it had worked all the
 * time it was gone. A dock moved, or kept by a write that replaces the
 * layout, never left: it stays on the job. (A removal and a return made
 * while no client of this build was in the room leave the config as it was.)
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

/** Every disassembly job in this room, open or finished, with its crew. */
export function readDisassemblyJobs(): DisassemblyJob[] {
  const index = indexJobs(ensureMap());
  return index.records.map((r) => asJob(index, r));
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
 *  parked. Its script and STOP/START state are kept. */
export function assignDisassembly(dockId: string, target: DisassemblyTarget, now = Date.now()): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    const open = readJobIn(map, target.roomId);
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
 *  since, or the record was written short) is raised. The work done so far
 *  is settled at `now` and stands; the rest is still to do. Never lowered. */
function raiseJobLaborIn(map: Y.Map<unknown>, job: DisassemblyJob, laborHours: number, now: number): void {
  if (job.finishedAt !== undefined || job.laborHours >= laborHours) return;
  map.set(jobKey(job.roomId), { ...settleJob(job, now), laborHours });
}

/** 🔧 Raise an open job to the module's labor (raiseJobLaborIn). */
export function raiseDisassemblyLabor(roomId: string, laborHours: number, now = Date.now()): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    const job = readJobIn(map, roomId);
    if (job) raiseJobLaborIn(map, job, laborHours, now);
  });
}

/** 🔧 End a job: its labor is done at `at` (the due time, the same on every
 *  client) and the module either came off the station or had already been
 *  disconnected. Its crew goes back to their docks (their configs still
 *  point at it, so the console can say how it ended). */
export function finishDisassemblyJob(roomId: string, at: number, outcome: 'removed' | 'detached'): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    const job = readJobIn(map, roomId);
    if (!job || job.finishedAt !== undefined) return;
    // All its labor done, settled when it ended (the record guard holds an
    // ended job to that).
    const { crew: _crew, ...record } = job;
    const end = Math.max(at, job.asOf);
    map.set(jobKey(roomId), { ...record, doneMs: jobLaborMs(job), asOf: end, finishedAt: end, outcome });
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
