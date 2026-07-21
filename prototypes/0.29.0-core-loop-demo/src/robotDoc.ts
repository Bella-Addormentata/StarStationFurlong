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

export type RobotRoutine = 'serve' | 'croupier' | 'idle';

export interface RobotConfig {
  routine: RobotRoutine;
}

export const ROBOT_ROUTINES: readonly RobotRoutine[] = ['serve', 'croupier', 'idle'];

/** Human labels for the routine dropdown. */
export const ROUTINE_LABELS: Record<RobotRoutine, string> = {
  serve: 'Serve drinks',
  croupier: 'Roulette croupier',
  idle: 'Idle at dock',
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
  return (
    typeof c.routine === 'string' &&
    (ROBOT_ROUTINES as readonly string[]).includes(c.routine)
  );
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
