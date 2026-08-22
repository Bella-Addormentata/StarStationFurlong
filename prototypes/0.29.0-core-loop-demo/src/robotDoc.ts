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
import {
  MAX_SCRIPT_STEPS,
  isRobotStep,
  isWheelTiming,
  type RobotStep,
  type WheelTiming,
} from './robotScript';

// 🤖📜 The RobotStep type and its shape-guard live in robotScript.ts — that's
// the engine-pure module the render layer + tests share. Re-exported here so
// existing importers of `./robotDoc` keep working without churn.
export { MAX_SCRIPT_STEPS, isRobotStep, isWheelTiming };
export type { RobotStep, WheelTiming };

export type RobotRoutine = 'serve' | 'croupier' | 'idle' | 'custom';

export interface RobotConfig {
  routine: RobotRoutine;
  /** Only meaningful when routine === 'custom'. */
  script?: RobotStep[];
  /** 🤖 STOP/START (owner request): parked = the robot walks back to its dock and
   *  stands on it, OFF, overriding the routine. START (parked false/absent)
   *  resumes the routine. Independent of `routine` so it survives a routine edit. */
  parked?: boolean;
  /** 🎰⏱️ #77C: owner-programmable roulette pacing. When set on ANY dock's
   *  config, croupier duty uses these timings in place of its defaults (validated
   *  to safe bounds so a hostile peer can't strand the wheel spinning). */
  wheelTiming?: WheelTiming;
}

export const ROBOT_ROUTINES: readonly RobotRoutine[] = ['serve', 'croupier', 'idle', 'custom'];

/** Human labels for the routine dropdown. */
export const ROUTINE_LABELS: Record<RobotRoutine, string> = {
  serve: 'Serve drinks',
  croupier: 'Table croupier',
  idle: 'Idle at dock',
  custom: 'Custom script',
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
  if (c.wheelTiming !== undefined && !isWheelTiming(c.wheelTiming)) return false;
  return true;
}

/** The dock's configured routine, or null if never programmed (defaults apply). */
export function readRobotConfig(dockId: string): RobotConfig | null {
  const v = ensureMap().get(`cfg:${dockId}`);
  return isRobotConfig(v) ? v : null;
}

/** Owner-only in practice (the programming UI gates on canEditRoom). */
export function writeRobotConfig(dockId: string, config: RobotConfig): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.set(`cfg:${dockId}`, config);
  });
}

/** Drop a dock's config (its dock was removed). */
export function clearRobotConfig(dockId: string): void {
  const map = ensureMap();
  boundDoc!.transact(() => {
    map.delete(`cfg:${dockId}`);
  });
}

// Console verification handle (the __ssfCasino precedent).
(window as unknown as { __ssfRobot: unknown }).__ssfRobot = {
  readRobotConfig,
  writeRobotConfig,
  clearRobotConfig,
};
