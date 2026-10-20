/**
 * 🧭 Robots never walk through furniture or games (owner report 2026-10-20:
 * the drink server walked through the craps table).
 *
 * Two holes let it: a goal under furniture (a table dropped on the patrol
 * route) made A* give up and the robot walk a straight line to it, and
 * routes ran over cells whose centre sits just 0.25 m from a table edge,
 * which a ≈0.35 m-wide robot overlaps. These walk the REAL robot through
 * the real casino and lobby floor plans and measure how close its centre
 * ever gets to any obstacle box.
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  CASINO_FURNITURE, DEFAULT_LOBBY_FURNITURE, FURNITURE, type FurnitureItem,
} from './furniture';
import { OBSTACLES, rebuildObstacles } from './obstacles';
import { rebakeWalkableGrid } from './pathfinding';
import { CASINO_PATROL, LOBBY_PATROL, PoolWaiter } from './poolWaiter';
import { rebuildStands, standsForItem } from './stands';

const ORIGINAL_FURNITURE = [...FURNITURE];

const loadRoom = (items: readonly FurnitureItem[]): void => {
  FURNITURE.splice(0, FURNITURE.length, ...items.map((i) => ({ ...i, pos: { ...i.pos } })));
  rebuildObstacles();
  rebakeWalkableGrid();
  rebuildStands();
};

/** Distance from (x,z) to the nearest obstacle box (negative = inside one). */
const clearance = (x: number, z: number): number => {
  let best = Infinity;
  for (const b of OBSTACLES) {
    const dx = Math.max(b.x0 - x, 0, x - b.x1);
    const dz = Math.max(b.z0 - z, 0, z - b.z1);
    const out = Math.hypot(dx, dz);
    best = Math.min(best, out > 0 ? out : -Math.min(x - b.x0, b.x1 - x, z - b.z0, b.z1 - z));
  }
  return best;
};

/** Run the robot for `secs` (no fox about) and report its closest approach
 *  to furniture plus how far it walked. */
const walk = (bot: PoolWaiter, secs: number): { closest: number; travelled: number } => {
  let closest = Infinity;
  let travelled = 0;
  let last = bot.getPosition();
  const dt = 1 / 30;
  for (let t = 0; t < secs; t += dt) {
    bot.update(dt, null);
    const p = bot.getPosition();
    travelled += Math.hypot(p.x - last.x, p.z - last.z);
    last = p;
    closest = Math.min(closest, clearance(p.x, p.z));
  }
  return { closest, travelled };
};

/** The robot is ≈0.35 m wide each side of its centre. */
const ROBOT_HALF_WIDTH = 0.35;

const craps = (x: number, z: number, rot: 0 | 1): FurnitureItem =>
  ({ id: 'test-craps', kind: 'craps-table', pos: { x, z }, rot }) as FurnitureItem;

afterAll(() => loadRoom(ORIGINAL_FURNITURE));

describe('robot patrols stay clear of furniture', () => {
  it('walks the casino without touching a table', () => {
    loadRoom(CASINO_FURNITURE);
    const r = walk(new PoolWaiter(new THREE.Scene(), CASINO_PATROL), 240);
    expect(r.travelled).toBeGreaterThan(50);
    expect(r.closest).toBeGreaterThan(ROBOT_HALF_WIDTH);
  });

  it('walks round a craps table dropped ON its patrol route instead of through it', () => {
    // Used to walk straight through: centre 0.4 m inside the table.
    loadRoom([...CASINO_FURNITURE, craps(3.5, 0, 1)]);
    const r = walk(new PoolWaiter(new THREE.Scene(), CASINO_PATROL), 240);
    expect(r.travelled).toBeGreaterThan(20);
    expect(r.closest).toBeGreaterThan(ROBOT_HALF_WIDTH);
  });

  it('does not brush a craps table placed beside its route', () => {
    // Used to pass with its centre 0.25 m from the table edge.
    loadRoom([...CASINO_FURNITURE, craps(2.5, 0, 1)]);
    const r = walk(new PoolWaiter(new THREE.Scene(), CASINO_PATROL), 240);
    expect(r.travelled).toBeGreaterThan(20);
    expect(r.closest).toBeGreaterThan(ROBOT_HALF_WIDTH);
  });

  it('walks the lobby without touching furniture', () => {
    loadRoom(DEFAULT_LOBBY_FURNITURE);
    const r = walk(new PoolWaiter(new THREE.Scene(), LOBBY_PATROL), 240);
    expect(r.travelled).toBeGreaterThan(50);
    expect(r.closest).toBeGreaterThan(ROBOT_HALF_WIDTH);
  });
});

describe('robot still reaches posts beside tables', () => {
  it('walks to each casino table croupier post and stands on it', () => {
    loadRoom(CASINO_FURNITURE);
    const tables = CASINO_FURNITURE.filter(
      (i) => i.kind === 'craps-table' || i.kind === 'roulette-table',
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const head = standsForItem(table.id).find((s) => s.role != null);
      expect(head, table.id).toBeTruthy();
      const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL);
      bot.setCroupierPost({ x: head!.front.x, z: head!.front.z, faceAngle: head!.faceAngle });
      const r = walk(bot, 40);
      const p = bot.getPosition();
      expect(Math.hypot(p.x - head!.front.x, p.z - head!.front.z), table.id).toBeLessThan(0.15);
      // Never closer to furniture than the post itself puts it (the stock
      // craps stickman post is 0.2 m from the booth behind it).
      const atPost = clearance(head!.front.x, head!.front.z);
      expect(r.closest, table.id).toBeGreaterThan(Math.min(ROBOT_HALF_WIDTH, atPost) - 0.01);
    }
  });

  it('walks back onto its charging dock', () => {
    loadRoom(CASINO_FURNITURE);
    const dock = CASINO_FURNITURE.find((i) => i.kind === 'charging-dock')!;
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL);
    bot.setDock({ x: dock.pos.x, z: dock.pos.z, faceAngle: 0 });
    walk(bot, 60); // idle with no fox about → heads home
    const p = bot.getPosition();
    expect(Math.hypot(p.x - dock.pos.x, p.z - dock.pos.z)).toBeLessThan(0.15);
  });
});
