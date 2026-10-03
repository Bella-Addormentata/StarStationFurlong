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
import type { DisassemblyJob, DisassemblyTarget } from './disassembly';
import { MAX_CREW, isDisassemblyJob, settleJob } from './disassembly';

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
   *  apart — its job is `job:<target>` in the same map (disassembly.ts).
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
  robotMap = doc.getMap('robot');
  robotMap.observe(() => notify());
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
 *  🔧 Every config write also keeps the disassembly crews true: a robot
 *  joins or leaves a job's crew as its routine, target or STOP/START says,
 *  with the job's progress settled at `now` first (disassembly.ts). */
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

const jobKey = (roomId: string) => `job:${roomId}`;

/** Write (or drop, null) a dock's config and bring every job's crew in line
 *  with it, inside the caller's transaction. A finished job no robot is set
 *  to any more is dropped; an open one stays, its progress kept for later. */
function setConfigIn(map: Y.Map<unknown>, dockId: string, config: RobotConfig | null, now: number): void {
  const wantTarget = config?.routine === 'disassemble' && config.parked !== true ? config.target : undefined;
  for (const job of jobsIn(map)) {
    if (job.finishedAt !== undefined) continue;
    const want = job.roomId === wantTarget;
    if (want === job.crew.includes(dockId)) continue;
    // A full crew takes no one more: the job record would no longer read.
    if (want && job.crew.length >= MAX_CREW) continue;
    const settled = settleJob(job, now);
    const crew = want ? [...settled.crew, dockId] : settled.crew.filter((d) => d !== dockId);
    map.set(jobKey(job.roomId), { ...settled, crew });
  }
  if (config) map.set(`cfg:${dockId}`, config);
  else map.delete(`cfg:${dockId}`);
  const targeted = new Set<string>();
  for (const [key, value] of map.entries()) {
    if (key.startsWith('cfg:') && isRobotConfig(value) && value.routine === 'disassemble' && value.target) targeted.add(value.target);
  }
  for (const job of jobsIn(map)) {
    if (job.finishedAt !== undefined && !targeted.has(job.roomId)) map.delete(jobKey(job.roomId));
  }
}

function jobsIn(map: Y.Map<unknown>): DisassemblyJob[] {
  const out: DisassemblyJob[] = [];
  for (const [key, value] of map.entries()) {
    if (out.length >= MAX_JOBS) break;
    if (!key.startsWith('job:') || !isDisassemblyJob(value) || jobKey(value.roomId) !== key) continue;
    out.push(value);
  }
  return out;
}

/** Every disassembly job in this room, open or finished. */
export function readDisassemblyJobs(): DisassemblyJob[] {
  return jobsIn(ensureMap());
}

/** The job on one module, or null. */
export function readDisassemblyJob(roomId: string): DisassemblyJob | null {
  const v = ensureMap().get(jobKey(roomId));
  return isDisassemblyJob(v) && v.roomId === roomId ? v : null;
}

/** 🔧 Set a dock's robot to take `target` apart: the job is opened if it
 *  has none (or only a finished one), and the robot joins its crew unless it
 *  is parked. Its script and STOP/START state are kept. */
export function assignDisassembly(dockId: string, target: DisassemblyTarget, now = Date.now()): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    const open = readDisassemblyJob(target.roomId);
    if (!open || open.finishedAt !== undefined) {
      const job: DisassemblyJob = { ...target, startedAt: now, doneMs: 0, asOf: now, crew: [] };
      map.set(jobKey(target.roomId), job);
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

/** 🔧 End a job: its labor is done at `at` (the due time, the same on every
 *  client) and the module either came off the station or had already been
 *  disconnected. Its crew goes back to their docks. */
export function finishDisassemblyJob(roomId: string, at: number, outcome: 'removed' | 'detached'): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    const job = readDisassemblyJob(roomId);
    if (!job || job.finishedAt !== undefined) return;
    const done = settleJob(job, at);
    map.set(jobKey(roomId), { ...done, crew: [], finishedAt: at, outcome });
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
