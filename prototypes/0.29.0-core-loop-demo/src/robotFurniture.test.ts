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

describe('robot dodging players near furniture', () => {
  it('swerves round a player without brushing the table beside it', () => {
    // The fox stands in the patrol aisle right beside the craps table: the
    // robot's swerve options all run along the table edge.
    loadRoom([craps(0, 2.8, 0)]);
    const bot = new PoolWaiter(new THREE.Scene(), [[-3, 1.75], [3, 1.75]], { x: -3, z: 1.75 });
    let closest = Infinity;
    for (let t = 0; t < 30; t += 1 / 30) {
      bot.setAvatars([{ x: 0, z: 1.25 }]);
      bot.update(1 / 30, null);
      const p = bot.getPosition();
      closest = Math.min(closest, clearance(p.x, p.z));
    }
    expect(closest).toBeGreaterThanOrEqual(0.35 - 1e-6);
  });
});

describe('robot leaves cramped floor without crossing furniture', () => {
  it('walks out of a one-cell gap between two tables along the gap, not across a table', () => {
    // The nearest clear floor by straight-line rings is across the lower
    // table; the robot must walk out of the gap's end instead.
    loadRoom([craps(0, 0, 0), { ...craps(0, 1.5, 0), id: 'test-craps-2' }]);
    const bot = new PoolWaiter(new THREE.Scene(), [[0.25, -3], [0.25, -4]], { x: 0.25, z: 0.75 });
    const r = walk(bot, 30);
    expect(r.travelled).toBeGreaterThan(3);
    expect(r.closest).toBeGreaterThan(0.2); // the gap itself is 0.25 each side
  });

  it('does not hop onto a patrol waypoint right beside a table', () => {
    // (0.25, 0.75) is walkable but only 0.25 m from the table edge: the
    // patrol stops on the clear floor beside it instead.
    loadRoom([craps(0, 0, 0)]);
    const bot = new PoolWaiter(new THREE.Scene(), [[0.25, 0.75], [0.25, 3.5]], { x: 0.25, z: 3.5 });
    const r = walk(bot, 60);
    expect(r.travelled).toBeGreaterThan(3);
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

  it('does not edge down a long narrow aisle to reach a post', () => {
    // Two rows of tables leave a 0.5 m aisle (z 0.5..1.0) 6 m long, too
    // narrow for clear floor. A post in its middle is out of reach: the
    // robot waits on clear floor instead of brushing the tables.
    const t = (id: string, x: number, z: number): FurnitureItem => ({ ...craps(x, z, 0), id });
    loadRoom([t('a', -1.5, 0), t('b', 1.5, 0), t('c', -1.5, 1.5), t('d', 1.5, 1.5)]);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: 3.75 });
    bot.setCroupierPost({ x: 0.25, z: 0.75, faceAngle: 0 });
    const r = walk(bot, 40);
    expect(r.travelled).toBeGreaterThan(0.5);
    expect(r.closest).toBeGreaterThan(ROBOT_HALF_WIDTH);
  });

  it('reaches a post in a narrow aisle from the end with the short approach', () => {
    // Same four tables: the post at (1.25, 0.75) is 2.5 m in from the
    // aisle's east end, though the clear floor nearest it in a straight
    // line is across the tables to the north.
    const t = (id: string, x: number, z: number): FurnitureItem => ({ ...craps(x, z, 0), id });
    loadRoom([t('a', -1.5, 0), t('b', 1.5, 0), t('c', -1.5, 1.5), t('d', 1.5, 1.5)]);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: 3.75 });
    bot.setCroupierPost({ x: 1.25, z: 0.75, faceAngle: 0 });
    const r = walk(bot, 60);
    const p = bot.getPosition();
    expect(Math.hypot(p.x - 1.25, p.z - 0.75)).toBeLessThan(0.15);
    expect(r.closest).toBeGreaterThan(0.2); // the aisle itself is 0.25 each side
  });

  it('stays put when shut in a narrow aisle with no clear floor to reach', () => {
    const t = (id: string, x: number, z: number, rot: 0 | 1): FurnitureItem => ({ ...craps(x, z, rot), id });
    loadRoom([
      t('a', -1.5, 0, 0), t('b', 1.5, 0, 0), t('c', -1.5, 1.5, 0), t('d', 1.5, 1.5, 0),
      t('w', -3.5, 0.75, 1), t('e', 3.5, 0.75, 1),
    ]);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: 0.75 });
    const r = walk(bot, 30);
    expect(r.travelled).toBeLessThan(0.3);
  });

  it('steps off its dock without crossing the table next to it', () => {
    // A robot inside furniture (as on its dock) beside another table: it
    // must step off over open floor, never through the neighbour.
    loadRoom([craps(0, 0, 0), { ...craps(0, 1.0, 0), id: 'test-craps-2' }]);
    const inOwn = (x: number, z: number): boolean => x > -1.5 && x < 1.5 && z > -0.5 && z < 0.5;
    const bot = new PoolWaiter(new THREE.Scene(), [[0.25, -3], [0.25, -4]], { x: 0.25, z: 0.4 });
    let crossedNeighbour = false;
    for (let t = 0; t < 20; t += 1 / 30) {
      bot.update(1 / 30, null);
      const p = bot.getPosition();
      if (!inOwn(p.x, p.z) && clearance(p.x, p.z) < 0) crossedNeighbour = true;
    }
    expect(crossedNeighbour).toBe(false);
    expect(bot.getPosition().z).toBeLessThan(-1); // left by the open south side
  });

  it('stops beside a table covering a scripted goto spot instead of walking into it', () => {
    loadRoom([craps(0, 0, 0)]);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: 3.25 });
    bot.setRoutine('custom');
    bot.setScript([{ kind: 'goto', x: 0.25, z: 0.25 }, { kind: 'goto', x: 0.25, z: 3.25 }]);
    const r = walk(bot, 40);
    expect(r.travelled).toBeGreaterThan(1);
    expect(r.closest).toBeGreaterThan(ROBOT_HALF_WIDTH);
  });

  it('waits beside a table moved over its dock instead of walking into it', () => {
    const dock: FurnitureItem = { id: 'test-dock', kind: 'charging-dock', pos: { x: 0.25, z: 0.25 }, rot: 0 } as FurnitureItem;
    loadRoom([dock, craps(0, 0, 0)]);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: 3.25 });
    bot.setDock({ x: 0.25, z: 0.25, faceAngle: 0 });
    const r = walk(bot, 60);
    expect(r.travelled).toBeGreaterThan(1);
    expect(r.closest).toBeGreaterThan(0);
  });

  it('does not hop onto an off-centre patrol spot that would brush a table', () => {
    // (0.25, 1.99) sits in a robot-clear cell but only 0.31 m from the
    // craps table's edge at z=2.3.
    loadRoom([craps(0, 2.8, 0)]);
    const bot = new PoolWaiter(new THREE.Scene(), [[0.25, 1.99], [0.25, -2]], { x: 0.25, z: -2 });
    const r = walk(bot, 40);
    expect(r.travelled).toBeGreaterThan(1);
    expect(r.closest).toBeGreaterThanOrEqual(ROBOT_HALF_WIDTH - 1e-6);
  });

  it('does not walk into a table covering its dock even when the cell centre is open', () => {
    // The dock at (0.25, 2.45) is inside the table (z 2.3..3.3), but its
    // cell's centre (z=2.25) is walkable floor.
    loadRoom([craps(0, 2.8, 0)]);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: -2 });
    bot.setDock({ x: 0.25, z: 2.45, faceAngle: 0 });
    const r = walk(bot, 60);
    expect(r.travelled).toBeGreaterThan(1);
    expect(r.closest).toBeGreaterThan(0);
  });

  it('steps off its dock off-centre without clipping a neighbouring table corner', () => {
    // From (0.49, 0.49) the nearest off-step is (0.25, 0.75); the straight
    // line there passes (0.43, 0.555), inside the second table even though
    // that cell's centre is open floor.
    const own = craps(0, 0, 0);
    loadRoom([own, { ...craps(0.76, 2, 1), id: 'test-craps-2' }]);
    const ownBox = OBSTACLES.filter((b) => 0.49 > b.x0 && 0.49 < b.x1 && 0.49 > b.z0 && 0.49 < b.z1);
    const inOwn = (x: number, z: number): boolean =>
      ownBox.some((b) => x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1);
    const bot = new PoolWaiter(new THREE.Scene(), [[-3, 3], [-3, -3]], { x: 0.49, z: 0.49 });
    let crossedNeighbour = false;
    for (let t = 0; t < 20; t += 1 / 30) {
      bot.update(1 / 30, null);
      const p = bot.getPosition();
      if (!inOwn(p.x, p.z) && clearance(p.x, p.z) < 0) crossedNeighbour = true;
    }
    expect(crossedNeighbour).toBe(false);
  });

  it('leaves an off-centre spot without clipping the table corner beside it', () => {
    // From (-0.01, -0.11) the first grid waypoint is (-0.75, 0.25): the
    // straight line there cuts the corner of the table at (1.4, 0.4)…
    // unless the robot first steps to its own cell's centre.
    loadRoom([craps(1.4, 0.4, 0), { ...craps(0, -1, 0), id: 'test-craps-2' }]);
    expect(clearance(-0.01, -0.11)).toBeGreaterThan(0);
    const bot = new PoolWaiter(new THREE.Scene(), [[-3, 3], [-3, -3]], { x: -0.01, z: -0.11 });
    const r = walk(bot, 20);
    expect(r.travelled).toBeGreaterThan(1);
    expect(r.closest).toBeGreaterThan(0);
  });

  it('does not clip a table corner on the way to its own cell centre either', () => {
    // From (0.01, 0.31) the line to its cell centre (0.25, 0.25) passes
    // (0.09, 0.29), inside the table at (-1.3, -0.2); a different way out
    // (or standing still) is the only safe choice.
    loadRoom([craps(-1.3, -0.2, 0)]);
    expect(clearance(0.01, 0.31)).toBeGreaterThan(0);
    const bot = new PoolWaiter(new THREE.Scene(), [[-3, 3], [-3, -3]], { x: 0.01, z: 0.31 });
    const r = walk(bot, 20);
    expect(r.closest).toBeGreaterThan(0);
  });

  it('does not walk a straight line to a scripted goto outside the room', () => {
    // (32.25, 0.25) is off the grid; its flattened cell key used to alias a
    // real cell, so the robot walked straight at it through the table.
    loadRoom([craps(3, 0.25, 1)]);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: 0.25 });
    bot.setRoutine('custom');
    bot.setScript([{ kind: 'goto', x: 32.25, z: 0.25 }]);
    const r = walk(bot, 30);
    expect(r.closest).toBeGreaterThan(0);
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

describe("the stickman's toss swings a posted robot's arm", () => {
  /** The robot's right arm and its swing left (private: the pose is all a
   *  player sees of it). */
  const swingOf = (bot: PoolWaiter): { arm: number; left: number } => {
    const b = bot as unknown as { armR: THREE.Group; tossLeft: number };
    return { arm: b.armR.rotation.x, left: b.tossLeft };
  };
  const DT = 1 / 30;
  /** Frames for `secs`, the post re-sent each one as World sends it (a fresh
   *  object); the arm's lowest angle seen. */
  const stand = (bot: PoolWaiter, post: { x: number; z: number; faceAngle: number } | null, secs: number): number => {
    let lowest = Infinity;
    for (let t = 0; t < secs; t += DT) {
      bot.setCroupierPost(post && { ...post });
      bot.update(DT, null);
      lowest = Math.min(lowest, swingOf(bot).arm);
    }
    return lowest;
  };
  const postAt = (table: FurnitureItem): { x: number; z: number; faceAngle: number } => {
    const head = standsForItem(table.id).find((s) => s.role != null)!;
    return { x: head.front.x, z: head.front.z, faceAngle: head.faceAngle };
  };

  it('swings only once it stands its post, out and back to rest in 0.6 s, the post re-sent every frame', () => {
    loadRoom(CASINO_FURNITURE);
    const post = postAt(CASINO_FURNITURE.find((i) => i.kind === 'craps-table')!);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL);
    stand(bot, post, DT);
    expect(bot.atCroupierPost()).toBe(false);
    bot.tossGesture();
    expect(swingOf(bot).left).toBe(0);
    stand(bot, post, 40);
    expect(bot.atCroupierPost()).toBe(true);
    expect(swingOf(bot).arm).toBe(0);
    bot.tossGesture();
    expect(swingOf(bot).left).toBeCloseTo(0.6);
    const lowest = stand(bot, post, 0.5);
    expect(lowest).toBeLessThan(-1.2);
    expect(swingOf(bot).left).toBeGreaterThan(0);
    stand(bot, post, 0.2);
    expect(swingOf(bot)).toEqual({ arm: 0, left: 0 });
  });

  it('never swings while walking its last steps to the post, inside 0.2 m of it', () => {
    loadRoom(CASINO_FURNITURE);
    const post = postAt(CASINO_FURNITURE.find((i) => i.kind === 'craps-table')!);
    const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL);
    const near: boolean[] = [];
    for (let t = 0; t < 40 && near.length < 10; t += DT) {
      stand(bot, post, DT);
      const p = bot.getPosition();
      const away = Math.hypot(p.x - post.x, p.z - post.z);
      if (away <= 0.12) break;
      if (away <= 0.2) {
        bot.tossGesture();
        near.push(bot.atCroupierPost() || swingOf(bot).left > 0);
      }
    }
    expect(near.length).toBeGreaterThan(0);
    expect(near.every((x) => !x)).toBe(true);
  });

  it('a cleared or moved post mid-swing puts the arm back', () => {
    loadRoom(CASINO_FURNITURE);
    const post = postAt(CASINO_FURNITURE.find((i) => i.kind === 'craps-table')!);
    for (const next of [null, { ...post, x: post.x + 1 }]) {
      const bot = new PoolWaiter(new THREE.Scene(), CASINO_PATROL);
      stand(bot, post, 40);
      bot.tossGesture();
      stand(bot, post, 0.2);
      expect(swingOf(bot).arm).toBeLessThan(-0.5);
      bot.setCroupierPost(next);
      expect(swingOf(bot)).toEqual({ arm: 0, left: 0 });
      expect(bot.atCroupierPost()).toBe(false);
    }
  });

  it('never swings with no post, parked, or stopped short of a post it cannot reach', () => {
    loadRoom(CASINO_FURNITURE);
    const post = postAt(CASINO_FURNITURE.find((i) => i.kind === 'craps-table')!);
    const idle = new PoolWaiter(new THREE.Scene(), CASINO_PATROL);
    stand(idle, null, 1);
    idle.tossGesture();
    expect(swingOf(idle).left).toBe(0);
    const parked = new PoolWaiter(new THREE.Scene(), CASINO_PATROL);
    stand(parked, post, 40);
    expect(parked.atCroupierPost()).toBe(true);
    parked.tossGesture();
    parked.setParked(true);
    expect(swingOf(parked)).toEqual({ arm: 0, left: 0 });
    parked.tossGesture();
    expect(parked.atCroupierPost()).toBe(false);
    expect(swingOf(parked).left).toBe(0);
    // The narrow aisle of 'does not edge down a long narrow aisle': the
    // robot waits on clear floor, short of the post.
    const t = (id: string, x: number, z: number): FurnitureItem => ({ ...craps(x, z, 0), id });
    loadRoom([t('a', -1.5, 0), t('b', 1.5, 0), t('c', -1.5, 1.5), t('d', 1.5, 1.5)]);
    const short = new PoolWaiter(new THREE.Scene(), CASINO_PATROL, { x: 0.25, z: 3.75 });
    stand(short, { x: 0.25, z: 0.75, faceAngle: 0 }, 40);
    const p = short.getPosition();
    expect(Math.hypot(p.x - 0.25, p.z - 0.75)).toBeGreaterThan(0.2);
    short.tossGesture();
    expect(short.atCroupierPost()).toBe(false);
    expect(swingOf(short).left).toBe(0);
  });
});
