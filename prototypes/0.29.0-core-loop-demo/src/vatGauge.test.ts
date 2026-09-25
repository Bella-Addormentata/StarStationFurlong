// vatGauge.ts tests (#165): the clone vat's hourglass clearance — the avatar
// squeezed to it must NEVER poke outside it (a hard limit, checked here by
// brute-force sampling, independent of the solver's own shortcut), the
// squeeze must ease rather than pop, and the door may only shut once the
// clone is past it. Plus the 2×2 default placement and the one-time
// migration of rooms still holding the old 1×1 default pose.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  AVATAR_SILHOUETTE,
  VAT_DOOR_ARC,
  VAT_DOOR_SWEEP_R,
  VAT_DOOR_TOP_Y,
  VAT_EXIT_ALONG,
  VAT_GLASS_BASE_Y,
  VAT_GLASS_H,
  VAT_GLASS_R,
  VAT_HOLD_ALONG,
  VAT_MIN_SCALE,
  VAT_NECK_H,
  VAT_NECK_HALF_W,
  VAT_PAD_Y,
  VAT_PLINTH_R,
  VAT_Q_LIP,
  VAT_Q_NECK,
  VAT_TANK_H,
  vatDoorClear,
  vatFloorY,
  vatGaugeAt,
  vatSqueezeAt,
} from './vatGauge';
import { FURNITURE, FURNITURE_DEFS, itemAabb, snapItemPos } from './furniture';
import {
  bindFurnitureDoc,
  readAllFurniture,
  relocateLegacyDefaultVat,
} from './furnitureDoc';

const EPS = 1e-9;
/** The walk-out path, root positions every 5 mm. */
function pathSamples(): number[] {
  const out: number[] = [];
  for (let a = VAT_HOLD_ALONG; a < VAT_EXIT_ALONG; a += 0.005) out.push(a);
  out.push(VAT_EXIT_ALONG);
  return out;
}

describe('the gauge is an hourglass', () => {
  it('is narrowest and lowest through the doorway', () => {
    const neck = vatGaugeAt((VAT_Q_NECK + VAT_Q_LIP) / 2);
    expect(neck.halfWidth).toBeCloseTo(VAT_NECK_HALF_W, 9);
    expect(neck.height).toBeCloseTo(VAT_NECK_H, 9);
    // Tank bulb (the vat axis) and room bulb (a metre out) are both roomier.
    const tank = vatGaugeAt(0);
    const room = vatGaugeAt(VAT_Q_LIP + 1);
    for (const bulb of [tank, room]) {
      expect(bulb.halfWidth).toBeGreaterThan(neck.halfWidth);
      expect(bulb.height).toBeGreaterThan(neck.height);
    }
    expect(tank.height).toBeCloseTo(VAT_TANK_H, 9);
  });

  it('only narrows toward the neck and only widens past it', () => {
    let prev = vatGaugeAt(0);
    for (let q = 0.005; q <= VAT_Q_LIP; q += 0.005) {
      const g = vatGaugeAt(q);
      expect(g.halfWidth).toBeLessThanOrEqual(prev.halfWidth + EPS);
      expect(g.height).toBeLessThanOrEqual(prev.height + EPS);
      prev = g;
    }
    for (let q = VAT_Q_LIP; q <= 3; q += 0.005) {
      const g = vatGaugeAt(q);
      expect(g.halfWidth).toBeGreaterThanOrEqual(prev.halfWidth - EPS);
      expect(g.height).toBeGreaterThanOrEqual(prev.height - EPS);
      prev = g;
    }
  });

  it('is continuous (no step for the squeeze to jump across)', () => {
    for (let q = -0.7; q <= 3; q += 0.001) {
      const a = vatGaugeAt(q);
      const b = vatGaugeAt(q + 0.001);
      expect(Math.abs(b.halfWidth - a.halfWidth)).toBeLessThan(0.01);
      expect(Math.abs(b.height - a.height)).toBeLessThan(0.01);
    }
  });

  it('keeps the neck inside the door-edge rails and under the transom', () => {
    // Rails stand on the arc at ±arc/2; the neck stays a clearance inside.
    expect(VAT_NECK_HALF_W).toBeLessThan(VAT_GLASS_R * Math.sin(VAT_DOOR_ARC / 2));
    expect(VAT_PAD_Y + VAT_NECK_H).toBeLessThan(VAT_DOOR_TOP_Y);
    expect(VAT_PAD_Y + VAT_TANK_H).toBeLessThan(VAT_GLASS_BASE_Y + VAT_GLASS_H);
  });
});

describe('the squeezed avatar always fits (hard limit)', () => {
  it('never pokes outside the gauge anywhere along the walk-out', () => {
    const roots = [...pathSamples(), 0, 2.5, 3];
    for (const along of roots) {
      const s = vatSqueezeAt(along);
      expect(s.horizontal).toBeGreaterThan(VAT_MIN_SCALE); // the floor never binds
      for (const slice of AVATAR_SILHOUETTE) {
        for (let k = 0; k <= 10; k++) {
          const z = slice.z0 + ((slice.z1 - slice.z0) * k) / 10;
          const g = vatGaugeAt(along + s.horizontal * z);
          expect(s.horizontal * slice.halfWidth).toBeLessThanOrEqual(g.halfWidth + EPS);
          expect(s.vertical * slice.top).toBeLessThanOrEqual(g.height + EPS);
        }
      }
    }
  });

  it('holds the clone wholly inside the glass', () => {
    const s = vatSqueezeAt(VAT_HOLD_ALONG);
    const tail = VAT_HOLD_ALONG + s.horizontal * AVATAR_SILHOUETTE[0].z0;
    const muzzle =
      VAT_HOLD_ALONG + s.horizontal * AVATAR_SILHOUETTE[AVATAR_SILHOUETTE.length - 1].z1;
    expect(tail).toBeGreaterThan(-VAT_GLASS_R);
    expect(muzzle).toBeLessThan(VAT_GLASS_R);
    const tallest = Math.max(...AVATAR_SILHOUETTE.map((sl) => sl.top));
    expect(VAT_PAD_Y + s.vertical * tallest).toBeLessThan(VAT_GLASS_BASE_Y + VAT_GLASS_H);
  });

  it('squeezes the clone through the doorway and returns it full-size', () => {
    const inDoor = vatSqueezeAt(VAT_Q_NECK + 0.05);
    expect(inDoor.horizontal).toBeLessThan(1);
    expect(inDoor.vertical).toBeLessThan(1);
    expect(vatSqueezeAt(VAT_EXIT_ALONG)).toEqual({ horizontal: 1, vertical: 1 });
  });

  it('eases instead of popping', () => {
    let prev = vatSqueezeAt(VAT_HOLD_ALONG);
    for (const along of pathSamples()) {
      const s = vatSqueezeAt(along);
      // ≤1 % per 5 mm ⇒ ≤ ~3 % per frame at the 1.6 m/s walk-out and 60 fps.
      expect(Math.abs(s.horizontal - prev.horizontal)).toBeLessThan(0.01);
      expect(Math.abs(s.vertical - prev.vertical)).toBeLessThan(0.01);
      prev = s;
    }
  });
});

describe('door, floor and exit along the walk-out', () => {
  it('lets the door shut only once the whole clone is past its sweep', () => {
    expect(vatDoorClear(VAT_HOLD_ALONG, vatSqueezeAt(VAT_HOLD_ALONG).horizontal)).toBe(false);
    for (const along of pathSamples()) {
      const s = vatSqueezeAt(along);
      if (!vatDoorClear(along, s.horizontal)) continue;
      expect(along + s.horizontal * AVATAR_SILHOUETTE[0].z0).toBeGreaterThan(VAT_DOOR_SWEEP_R);
    }
    // The exit is past the sweep at full size, so the seal has fired by then.
    expect(vatDoorClear(VAT_EXIT_ALONG, 1)).toBe(true);
  });

  it('ends the walk just out in the room, past the 2×2 footprint', () => {
    expect(VAT_EXIT_ALONG).toBeGreaterThan(1);
    expect(VAT_EXIT_ALONG).toBeLessThan(2.5);
  });

  it('stands the clone on the pad inside and on the floor outside', () => {
    expect(vatFloorY(VAT_HOLD_ALONG)).toBe(VAT_PAD_Y);
    expect(vatFloorY(VAT_EXIT_ALONG)).toBe(0);
    let prev = VAT_PAD_Y;
    for (const along of pathSamples()) {
      const y = vatFloorY(along);
      expect(y).toBeLessThanOrEqual(prev + EPS);
      prev = y;
    }
  });

  it('builds a tank that fits its footprint with a leaf that can park behind the shell', () => {
    expect(VAT_GLASS_R).toBeLessThan(VAT_DOOR_SWEEP_R);
    expect(VAT_DOOR_SWEEP_R).toBeLessThan(VAT_PLINTH_R);
    expect(VAT_PLINTH_R + 0.05).toBeLessThanOrEqual(1); // base ring, 2×2 ⇒ ±1 m
    expect(VAT_DOOR_ARC).toBeLessThanOrEqual(Math.PI);
  });
});

describe('2×2 clone vat in the default layout', () => {
  const vat = FURNITURE.find((i) => i.id === 'clone-vat')!;

  it('has a 2×2 footprint and sits centred on a lattice 2×2 square', () => {
    expect(FURNITURE_DEFS['clone-vat'].footprint).toEqual({ w: 2, d: 2 });
    expect(snapItemPos('clone-vat', vat.rot, vat.pos.x, vat.pos.z)).toEqual(vat.pos);
    const box = itemAabb(vat)!;
    expect(box.x1 - box.x0).toBe(2);
    expect(box.z1 - box.z0).toBe(2);
    expect(Number.isInteger(box.x0) && Number.isInteger(box.z0)).toBe(true);
  });

  it('overlaps no other default obstacle and swallows no default decor', () => {
    const box = itemAabb(vat)!;
    for (const other of FURNITURE) {
      if (other.id === vat.id) continue;
      const ob = itemAabb(other);
      if (ob) {
        const overlaps = box.x0 < ob.x1 && box.x1 > ob.x0 && box.z0 < ob.z1 && box.z1 > ob.z0;
        expect(overlaps, other.id).toBe(false);
      } else {
        const d = Math.hypot(other.pos.x - vat.pos.x, other.pos.z - vat.pos.z);
        expect(d, other.id).toBeGreaterThan(VAT_PLINTH_R + 0.3);
      }
    }
  });
});

describe('relocateLegacyDefaultVat (one-time #165 migration)', () => {
  const vat = FURNITURE.find((i) => i.id === 'clone-vat')!;
  const tree = FURNITURE.find((i) => i.id === 'cherry-tree-back-left')!;
  const rec = (kind: string, x: number, z: number) => ({ kind, x, z, rot: 0, movable: true });

  function roomWith(entries: Record<string, ReturnType<typeof rec>>) {
    const doc = new Y.Doc();
    const map = doc.getMap('furniture');
    for (const [id, r] of Object.entries(entries)) map.set(id, r);
    bindFurnitureDoc(doc);
    return () => readAllFurniture();
  }

  it('moves an unmoved old default vat, and the corner tree, to the new defaults', () => {
    const read = roomWith({
      'clone-vat': rec('clone-vat', -4.7, -4.9),
      'cherry-tree-back-left': rec('cherry-tree', -5.3, -5.3),
    });
    relocateLegacyDefaultVat();
    const after = read();
    expect(after.get('clone-vat')).toMatchObject({ x: vat.pos.x, z: vat.pos.z, rot: vat.rot });
    expect(after.get('cherry-tree-back-left')).toMatchObject({ x: tree.pos.x, z: tree.pos.z });
  });

  it('leaves a vat the owner moved — and so the corner tree — where they are', () => {
    const read = roomWith({
      'clone-vat': rec('clone-vat', 2, 2),
      'cherry-tree-back-left': rec('cherry-tree', -5.3, -5.3),
    });
    relocateLegacyDefaultVat();
    const after = read();
    expect(after.get('clone-vat')).toMatchObject({ x: 2, z: 2 });
    expect(after.get('cherry-tree-back-left')).toMatchObject({ x: -5.3, z: -5.3 });
  });

  it('leaves a tree the owner moved, and is a no-op in a room with no vat', () => {
    const read = roomWith({
      'clone-vat': rec('clone-vat', -4.7, -4.9),
      'cherry-tree-back-left': rec('cherry-tree', 1, 1),
    });
    relocateLegacyDefaultVat();
    expect(read().get('cherry-tree-back-left')).toMatchObject({ x: 1, z: 1 });

    const readEmpty = roomWith({ 'sofa-back': rec('sofa-back', 0, -1.5) });
    relocateLegacyDefaultVat();
    expect([...readEmpty().keys()]).toEqual(['sofa-back']);
  });
});
