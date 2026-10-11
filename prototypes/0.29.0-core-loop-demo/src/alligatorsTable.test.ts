/**
 * 🐊 The insatiable-alligators table as built (#185). Placement and
 * collision only know a piece's footprint, so every mesh must stay inside the
 * table's 3×3 (air hockey's #116 lesson) — heads lunged or stowed, displays
 * and birds included. The stands ring the table one per seat, and the handle
 * folds a head up only when asked.
 *
 * The table is built for real (buildItemGroup), with a stand-in canvas for
 * the felt and the displays.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { buildItemGroup, FURNITURE_DEFS } = await import('./furniture');
const { IA_LUNGE, IA_MAX_BALLS, IA_SEATS, IA_SWING_MAX, IA_TABLE_R, seatAngle } = await import('./games/alligators');
type Handle = import('./devices').AlligatorsVisualHandle;

function buildTable(): { group: THREE.Group; handle: Handle } {
  const group = buildItemGroup({ id: 'alligators-table-1', kind: 'alligators-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  let handle: Handle | null = null;
  group.traverse((obj) => {
    if (obj.userData.alligators) handle = obj.userData.alligators as Handle;
  });
  return { group, handle: handle! };
}

function meshesOutside(group: THREE.Group): string[] {
  const { w, d } = FURNITURE_DEFS['alligators-table'].footprint!;
  group.updateMatrixWorld(true);
  const outside: string[] = [];
  group.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const box = new THREE.Box3().setFromObject(obj);
    if (box.min.x < -w / 2 - 1e-9 || box.max.x > w / 2 + 1e-9
      || box.min.z < -d / 2 - 1e-9 || box.max.z > d / 2 + 1e-9) {
      outside.push(`${obj.geometry.type} x ${box.min.x.toFixed(2)}…${box.max.x.toFixed(2)}, z ${box.min.z.toFixed(2)}…${box.max.z.toFixed(2)}`);
    }
  });
  return outside;
}

describe('the alligators table as built', () => {
  it('hands the session its handle', () => {
    expect(buildTable().handle).toBeTruthy();
  });

  it('keeps every mesh inside its 3×3 footprint, stowed or raised, swung and lunged', () => {
    const { group, handle } = buildTable();
    expect(meshesOutside(group)).toEqual([]);
    for (const swing of [-IA_SWING_MAX, 0, IA_SWING_MAX]) {
      for (let seat = 0; seat < IA_SEATS; seat++) handle.setHead(seat, true, swing, IA_LUNGE, 1);
      handle.update(5);
      expect(meshesOutside(group)).toEqual([]);
    }
  });

  it('folds a head up only when its seat is claimed, and hides it stowed', () => {
    const { group, handle } = buildTable();
    // A head's fold group: the one under each hinge, built pitched down
    // under the table (the stowed pose).
    const folds: THREE.Object3D[] = [];
    group.traverse((obj) => {
      if (obj instanceof THREE.Group && obj.parent?.parent === group && obj.rotation.x > 1) folds.push(obj);
    });
    expect(folds).toHaveLength(IA_SEATS);
    expect(folds.every((f) => !f.visible)).toBe(true);
    handle.setHead(2, true, 0, 0, 1);
    handle.update(2);
    expect(folds.filter((f) => f.visible)).toHaveLength(1);
    handle.setHead(2, false, 0, 0, 1);
    handle.update(5);
    expect(folds.every((f) => !f.visible)).toBe(true);
  });

  it('holds a ball for every ball a round can have, all on the table when shown', () => {
    const { group, handle } = buildTable();
    for (let k = 0; k < IA_MAX_BALLS; k++) handle.setBall(k, 0.5, 0.5, true);
    let shown = 0;
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh && obj.geometry.type === 'SphereGeometry' && obj.visible
        && obj.position.x === 0.5 && obj.position.z === 0.5) shown += 1;
    });
    expect(shown).toBe(IA_MAX_BALLS);
  });

  it('rings the table with one stand per seat, each facing the centre', () => {
    const stands = FURNITURE_DEFS['alligators-table'].stands!;
    expect(stands).toHaveLength(IA_SEATS);
    stands.forEach((t, seat) => {
      const r = Math.hypot(t.stand.x, t.stand.z);
      expect(r).toBeGreaterThan(IA_TABLE_R + 0.5);
      // On the seat's own outward ray…
      const a = seatAngle(seat);
      expect(Math.atan2(t.stand.z, t.stand.x)).toBeCloseTo(Math.atan2(Math.sin(a), Math.cos(a)), 2);
      // …outside the footprint on its far axis, and facing in (atan2(nx, nz)).
      expect(Math.max(Math.abs(t.stand.x), Math.abs(t.stand.z))).toBeCloseTo(1.9, 3);
      expect(t.faceAngle).toBeCloseTo(Math.atan2(-t.stand.x / r, -t.stand.z / r), 2);
    });
  });
});
