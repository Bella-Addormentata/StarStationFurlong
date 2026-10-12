// 🚏 Edit mode keeps a helm, engine and fuel tank aboard while a ferry route
// runs, the same one of each in every game (routeParts.routeKeptParts):
// without a helm nobody could STOP it.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { keptRoutePartTaken, routeKeptParts, routePortTaken, tanksLockedByRoute, templateSwapLockedByRoute } from './routeParts';
import type { FurnitureItem } from './furniture';

const item = (id: string, kind: string): FurnitureItem => ({ id, kind, x: 0, z: 0, rot: 0, movable: true } as unknown as FurnitureItem);

/** A game's furniture as its own copy of the room's doc has it. */
const itemsIn = (doc: Y.Doc): FurnitureItem[] =>
  [...doc.getMap<{ kind: string }>('furniture').entries()].map(([id, r]) => item(id, r.kind));

/** A game for each of `n` people in a room holding `parts` (id → kind). */
function gamesWith(n: number, parts: Record<string, string>): Y.Doc[] {
  const room = new Y.Doc();
  for (const [id, kind] of Object.entries(parts)) room.getMap('furniture').set(id, { kind, x: 0, z: 0, rot: 0, movable: true });
  return Array.from({ length: n }, () => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(room));
    return doc;
  });
}

/** In one game, unaware of the others, remove each of `ids` that edit mode
 *  lets go while the route runs, one after another. */
function removeWhatMayGo(doc: Y.Doc, ids: readonly string[]): void {
  const furniture = doc.getMap('furniture');
  for (const id of ids) {
    if (furniture.has(id) && keptRoutePartTaken(id, itemsIn(doc), new Set([id]), true) === null) furniture.delete(id);
  }
}

/** Every game hears every other's writes. */
function merge(docs: readonly Y.Doc[]): void {
  const updates = docs.map((d) => Y.encodeStateAsUpdate(d));
  for (const d of docs) for (const u of updates) Y.applyUpdate(d, u);
}

describe('a running route’s flight parts', () => {
  const ship = [item('h1', 'helm-console'), item('e1', 'engine-block'), item('t1', 'fuel-tank'), item('sofa', 'sofa')];

  it('refuses the last helm, engine or tank while the route runs', () => {
    expect(keptRoutePartTaken('h1', ship, new Set(['h1']), true)).toEqual({ name: 'helm', others: false });
    expect(keptRoutePartTaken('e1', ship, new Set(['e1']), true)).toEqual({ name: 'engine block', others: false });
    // A hull stack taking the tank with it counts too.
    expect(keptRoutePartTaken('e1', ship, new Set(['e1', 't1']), true)).toEqual({ name: 'engine block', others: false });
    expect(keptRoutePartTaken('x', ship, new Set(['x', 't1']), true)).toEqual({ name: 'fuel tank', others: false });
  });

  it('keeps the same one of each kind in every game, the smallest id, and lets the others go', () => {
    const more = [...ship, item('h2', 'helm-console'), item('e0', 'engine-block')];
    expect(routeKeptParts(more)).toEqual(new Map([['helm', 'h1'], ['engine block', 'e0'], ['fuel tank', 't1']]));
    expect(keptRoutePartTaken('h1', more, new Set(['h1']), true)).toEqual({ name: 'helm', others: true });
    expect(keptRoutePartTaken('h2', more, new Set(['h2']), true)).toBeNull();
    expect(keptRoutePartTaken('e1', more, new Set(['e1']), true)).toBeNull();
    expect(keptRoutePartTaken('e0', more, new Set(['e0']), true)).toEqual({ name: 'engine block', others: true });
  });

  it('lets anything else go, or anything once the route is stopped', () => {
    expect(keptRoutePartTaken('sofa', ship, new Set(['sofa']), true)).toBeNull();
    expect(keptRoutePartTaken('h1', ship, new Set(['h1']), false)).toBeNull();
  });

  // Copilot (PR 180, 31st review): each game checked its own copy of the
  // room, so two people each removing a different helm (each seeing the
  // other's still aboard) took both once their writes merged, and the
  // running ferry lost STOP and RESUME. Engines and tanks alike.
  it('keeps a helm, engine and tank aboard whatever games remove at once, once their writes merge', () => {
    const kinds = ['helm-console', 'engine-block', 'fuel-tank'];
    // Two games, each removing a different one of two helms.
    const [a, b] = gamesWith(2, { h1: 'helm-console', h2: 'helm-console' });
    removeWhatMayGo(a, ['h1']);
    removeWhatMayGo(b, ['h2']);
    merge([a, b]);
    expect(itemsIn(a).map((i) => i.id)).toEqual(['h1']);
    // Three games, three of each kind, each removing everything it may in its
    // own order.
    const parts: Record<string, string> = {};
    for (const kind of kinds) for (const n of [1, 2, 3]) parts[`${kind}-${n}`] = kind;
    const ids = Object.keys(parts);
    const games = gamesWith(3, parts);
    removeWhatMayGo(games[0], ids);
    removeWhatMayGo(games[1], [...ids].reverse());
    removeWhatMayGo(games[2], ['helm-console-2', 'fuel-tank-3', 'engine-block-1', 'helm-console-1', 'fuel-tank-1', 'engine-block-3']);
    merge(games);
    for (const g of games) expect(new Set(itemsIn(g).map((i) => i.kind))).toEqual(new Set(kinds));
    // A helm fitted meanwhile with a smaller id is kept from then on: the one
    // it replaces may go, and still one stays.
    const [c, d] = gamesWith(2, { h1: 'helm-console', h2: 'helm-console' });
    c.getMap('furniture').set('h0', { kind: 'helm-console', x: 1, z: 0, rot: 0, movable: true });
    removeWhatMayGo(c, ['h1', 'h2']);
    removeWhatMayGo(d, ['h1', 'h2']);
    merge([c, d]);
    expect(itemsIn(c).map((i) => i.id)).toEqual(['h0']);
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

// 🚪 Copilot (PR 180, 21st review): in flight the route's ship port is
// unpaired, so edit mode's paired-door refusal let it be removed, and the
// ferry could then dock nowhere.
describe('the route’s ship port', () => {
  it('stays while the route runs (paused included), and only that door', () => {
    expect(routePortTaken('x-', { shipPort: 'x-', startedAt: 1000 })).toBe(true);
    expect(routePortTaken('d:7', { shipPort: 'x-', startedAt: 1000 })).toBe(false);
  });

  it('may go once the route is stopped, or with no route', () => {
    expect(routePortTaken('x-', { shipPort: 'x-' })).toBe(false);
    expect(routePortTaken('x-', null)).toBe(false);
  });
});

// 🏗️ Copilot (PR 180, 24th review): paused, the tanks may change, so the
// DEV menu's PLACE got past the tank lock, and its template replaced the
// last helm, engine, tank and the robot captain's dock all at once.
describe("the DEV menu's PLACE", () => {
  it('is refused while the route runs, paused or not', () => {
    expect(templateSwapLockedByRoute({ startedAt: 1000 })).toBe(true);
  });

  it('may swap the room once the route is stopped, or with no route', () => {
    expect(templateSwapLockedByRoute({})).toBe(false);
    expect(templateSwapLockedByRoute(null)).toBe(false);
  });
});
