// 🚏 Edit mode keeps a running ferry route's last helm, engine and fuel tank
// aboard (routeParts.lastRoutePartTaken): without a helm nobody could STOP it.

import { describe, expect, it } from 'vitest';
import { lastRoutePartTaken, tanksLockedByRoute } from './routeParts';
import type { FurnitureItem } from './furniture';

const item = (id: string, kind: string): FurnitureItem => ({ id, kind, x: 0, z: 0, rot: 0, movable: true } as unknown as FurnitureItem);

describe('a running route’s last flight parts', () => {
  const ship = [item('h1', 'helm-console'), item('e1', 'engine-block'), item('t1', 'fuel-tank'), item('sofa', 'sofa')];

  it('refuses the last helm, engine or tank while the route runs', () => {
    expect(lastRoutePartTaken('h1', ship, new Set(['h1']), true)).toBe('helm');
    expect(lastRoutePartTaken('e1', ship, new Set(['e1']), true)).toBe('engine block');
    // A hull stack taking the tank with it counts too.
    expect(lastRoutePartTaken('e1', ship, new Set(['e1', 't1']), true)).toBe('engine block');
    expect(lastRoutePartTaken('x', ship, new Set(['x', 't1']), true)).toBe('fuel tank');
  });

  it('lets anything else go, a second helm, or anything once the route is stopped', () => {
    expect(lastRoutePartTaken('sofa', ship, new Set(['sofa']), true)).toBeNull();
    expect(lastRoutePartTaken('h1', [...ship, item('h2', 'helm-console')], new Set(['h1']), true)).toBeNull();
    expect(lastRoutePartTaken('h1', ship, new Set(['h1']), false)).toBeNull();
  });
});

// ⛽ Copilot (PR 180, 19th review): the timetable replays every home refill at
// the tanks' capacity now, so a tank fitted or taken off while it flies the
// ship would rewrite fuel the ferry already carried.
describe('the tanks while the timetable flies the ship', () => {
  const ship = [item('h1', 'helm-console'), item('e1', 'engine-block'), item('t1', 'fuel-tank'), item('t2', 'fuel-tank'), item('sofa', 'sofa')];

  it('refuses fitting or taking off a tank while the timetable flies the ship', () => {
    expect(tanksLockedByRoute(ship, ship.filter((i) => i.id !== 't2'), true)).toBe(true);
    expect(tanksLockedByRoute(ship, [...ship, item('t3', 'fuel-tank')], true)).toBe(true);
    // A room template swapping the furniture wholesale counts by the tanks it leaves.
    expect(tanksLockedByRoute(ship, [item('h9', 'helm-console'), item('t9', 'fuel-tank')], true)).toBe(true);
  });

  it('lets the tanks change when paused or stopped, and anything that keeps their number', () => {
    expect(tanksLockedByRoute(ship, ship.filter((i) => i.id !== 't2'), false)).toBe(false);
    expect(tanksLockedByRoute(ship, ship.filter((i) => i.id !== 'sofa'), true)).toBe(false);
    expect(tanksLockedByRoute(ship, [...ship, item('s2', 'sofa')], true)).toBe(false);
    expect(tanksLockedByRoute(ship, [item('h9', 'helm-console'), item('t8', 'fuel-tank'), item('t9', 'fuel-tank')], true)).toBe(false);
  });
});
