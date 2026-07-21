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

export type RobotRoutine = 'serve' | 'croupier' | 'idle' | 'custom';

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
}

export const ROBOT_ROUTINES: readonly RobotRoutine[] = ['serve', 'croupier', 'idle', 'custom'];

/** Human labels for the routine dropdown. */
export const ROUTINE_LABELS: Record<RobotRoutine, string> = {
  serve: 'Serve drinks',
  croupier: 'Roulette croupier',
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
