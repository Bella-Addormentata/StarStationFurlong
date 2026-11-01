/**
 * 🎲 The 3D craps table's chips (#226): however many chips are on the felt,
 * every one renders — a full chip pool grows rather than dropping chips; and
 * the two dice are solid, never sinking into each other.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { DIE_SIZE, diceOverlap, railStacks, type CasinoTableVisualHandle } from './casinoTable3d';
import { railChipCounts } from './chipDisplay';
import { buildItemGroup } from './furniture';

/** A canvas whose 2-D context draws nothing: the felt paints through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
  });
  return { width: 0, height: 0, getContext: () => ctx };
}

function chipsDrawn(group: THREE.Group): number {
  let n = 0;
  group.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) n += (o as THREE.InstancedMesh).count;
  });
  return n;
}

describe('the craps table chips', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
    vi.stubGlobal('window', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders every chip, past the starting pool size', () => {
    const group = buildItemGroup({ id: 'craps-1', kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    let handle: CasinoTableVisualHandle | null = null;
    group.traverse((o) => {
      if (o.userData.casinoTable) handle = o.userData.casinoTable as CasinoTableVisualHandle;
    });
    expect(handle).not.toBeNull();
    const h = handle as unknown as CasinoTableVisualHandle;
    const meshesBefore: THREE.Object3D[] = [];
    group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshesBefore.push(o); });
    // 50 stacks of twenty $1 chips: 1000 chips of one denomination.
    const stacks = Array.from({ length: 50 }, (_, i) => ({
      x: -1.2 + (i % 10) * 0.25, z: -0.3 + Math.floor(i / 10) * 0.15,
      chips: new Array(20).fill(1), dim: false,
    }));
    h.setFeltChips(stacks);
    h.update(0);
    expect(chipsDrawn(group)).toBeGreaterThanOrEqual(1000);
    // The pools grew in place: the very meshes World registered at placement.
    const meshesAfter: THREE.Object3D[] = [];
    group.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) meshesAfter.push(o); });
    expect(meshesAfter).toEqual(meshesBefore);
    // And it settles back once the felt clears.
    h.setFeltChips([]);
    h.update(0);
    expect(chipsDrawn(group)).toBeLessThan(1000);
  });

  it('draws roulette colour chips tinted, and odds lifted onto their flat bet', () => {
    const tops = (group: THREE.Group) => {
      const out: Array<{ y: number; color: THREE.Color }> = [];
      const m = new THREE.Matrix4();
      const p = new THREE.Vector3();
      group.traverse((o) => {
        const mesh = o as THREE.InstancedMesh;
        if (!mesh.isInstancedMesh) return;
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, m);
          p.setFromMatrixPosition(m);
          const color = new THREE.Color();
          mesh.getColorAt(i, color);
          out.push({ y: p.y, color });
        }
      });
      return out;
    };
    const handleOf = (group: THREE.Group) => {
      let handle: CasinoTableVisualHandle | null = null;
      group.traverse((o) => {
        if (o.userData.casinoTable) handle = o.userData.casinoTable as CasinoTableVisualHandle;
      });
      return handle as unknown as CasinoTableVisualHandle;
    };
    const roulette = buildItemGroup({ id: 'roulette-1', kind: 'roulette-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    const r = handleOf(roulette);
    r.setFeltChips([{ x: 0, z: 0, chips: [5], dim: true, color: '#4EA8F2' }]);
    r.update(0);
    const [chip] = tops(roulette);
    expect(chip.color.getHexString()).toBe(new THREE.Color('#4EA8F2').getHexString());

    const craps = buildItemGroup({ id: 'craps-2', kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    const c = handleOf(craps);
    c.setFeltChips([
      { x: 0.8, z: 0.2, chips: [5, 5, 5], dim: false },
      { x: 0.81, z: 0.2, chips: [25], dim: false, lift: 3 },
    ]);
    c.update(0);
    const ys = tops(craps).map((t) => t.y).sort((a, b) => a - b);
    expect(ys).toHaveLength(4);
    // The odds chip sits on top of the three flat chips, not on the felt.
    expect(ys[3] - ys[2]).toBeGreaterThan(0.005);
  });

  it('keeps small chips on a crowded rail', () => {
    const rail = railStacks({ x: 0, z: -0.48, axis: 'x', len: 0.62 }, railChipCounts(123456));
    const denoms = new Set(rail.map((s) => s.denom));
    for (const d of [1, 5, 25, 100]) expect(denoms.has(d), `$${d}`).toBe(true);
    // Still largest first along the rail.
    expect(rail.map((s) => s.denom)).toEqual([...rail.map((s) => s.denom)].sort((a, b) => b - a));
  });
});

describe('the Fair / Friendly plaque', () => {
  it('lies on clear felt: no betting box, the dice spot or the wheel under it', async () => {
    const { fairPlaqueCentre, FAIR_PLAQUE_SIZE } = await import('./casinoTable3d');
    const { CRAPS_DICE_SPOT, CRAPS_LAYOUT, ROULETTE_LAYOUT, ROULETTE_WHEEL } = await import('./games/casinoLayout');
    const { w, h } = FAIR_PLAQUE_SIZE;
    const cases: Array<{ layout: { settings: typeof CRAPS_LAYOUT.settings; felt: typeof CRAPS_LAYOUT.felt; regions: Array<{ rects: typeof CRAPS_LAYOUT.felt[] }> }; at: 'right' | 'front' }> = [
      { layout: CRAPS_LAYOUT, at: 'right' },
      { layout: ROULETTE_LAYOUT, at: 'front' },
    ];
    for (const { layout, at } of cases) {
      const c = fairPlaqueCentre(layout.settings, at);
      const p = { x0: c.x - w / 2, x1: c.x + w / 2, z0: c.z - h / 2, z1: c.z + h / 2 };
      expect(p.x0 > layout.felt.x0 && p.x1 < layout.felt.x1 && p.z0 > layout.felt.z0 && p.z1 < layout.felt.z1).toBe(true);
      for (const rg of layout.regions) {
        for (const r of rg.rects) {
          expect(r.x0 < p.x1 && r.x1 > p.x0 && r.z0 < p.z1 && r.z1 > p.z0).toBe(false);
        }
      }
      // Clear of the ⚙️ itself.
      const g = layout.settings;
      expect(g.x + g.r < p.x0 || g.x - g.r > p.x1 || g.z + g.r < p.z0 || g.z - g.r > p.z1).toBe(true);
    }
    const crapsP = fairPlaqueCentre(CRAPS_LAYOUT.settings, 'right');
    expect(Math.abs(crapsP.x - CRAPS_DICE_SPOT.x)).toBeGreaterThan(w / 2 + 0.03);
    // The roulette plaque's nearest corner stays outside the wheel's surround.
    const rp = fairPlaqueCentre(ROULETTE_LAYOUT.settings, 'front');
    const dx = Math.max(0, Math.abs(rp.x - ROULETTE_WHEEL.x) - w / 2);
    const dz = Math.max(0, Math.abs(rp.z - ROULETTE_WHEEL.z) - h / 2);
    expect(Math.hypot(dx, dz)).toBeGreaterThan(ROULETTE_WHEEL.r + 0.03);
  });
});

describe('the craps dice', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
    vi.stubGlobal('window', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  function crapsTable() {
    const group = buildItemGroup({ id: 'craps-1', kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    let handle: CasinoTableVisualHandle | null = null;
    group.traverse((o) => {
      if (o.userData.casinoTable) handle = o.userData.casinoTable as CasinoTableVisualHandle;
    });
    const dice: THREE.Mesh[] = [];
    group.traverse((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BoxGeometry | undefined;
      if (g?.type === 'BoxGeometry' && Math.abs(g.parameters.width - DIE_SIZE) < 1e-9) dice.push(o as THREE.Mesh);
    });
    expect(dice).toHaveLength(2);
    return { h: handle as unknown as CasinoTableVisualHandle, dice };
  }

  /** How deep the two dice sink into each other (0 = apart or just touching). */
  function depth(dice: THREE.Mesh[]): number {
    const [a, b] = dice;
    return diceOverlap(a.position, a.quaternion, b.position, b.quaternion, DIE_SIZE / 2)?.length() ?? 0;
  }

  it('never overlap in flight, on landing or at rest', () => {
    const { h, dice } = crapsTable();
    let worst = 0;
    for (let seed = 1; seed <= 120; seed++) {
      // Throws from both rails and the stickman, straight and at angles,
      // soft and hard; some straight into the back wall.
      const fromSide = seed % 3 === 0 ? -1 : seed % 3 === 1 ? 1 : 0;
      const from = { x: (seed % 7 - 3) * 0.25, z: fromSide * 0.3 };
      const dir = { x: Math.sin(seed), z: fromSide === 0 ? -1 : -fromSide };
      h.diceThrow(from, dir, (seed % 5) / 4, seed * 2654435761);
      const faces: [number, number] = [1 + (seed % 6), 1 + ((seed * 5) % 6)];
      for (let f = 0; f < 300; f++) {
        if (f === 20) h.diceLand(faces);
        h.update(1 / 60);
        worst = Math.max(worst, depth(dice));
      }
      expect(h.diceState()).toBe('rest');
      // Then the stickman gathers them up and pushes them back out.
      h.diceRestAt({ x: 0, z: 0.3 });
      for (let f = 0; f < 90; f++) { h.update(1 / 60); worst = Math.max(worst, depth(dice)); }
    }
    // A hair of contact within one frame is fine; visibly inside is not.
    expect(worst).toBeLessThan(0.002);
  });

  it('finish a slide when the frame driver asks for it every frame', () => {
    const { h, dice } = crapsTable();
    const to = { x: 0.9, z: -0.3 };
    let f = 0;
    // casinoTablesFrame re-sends the same spot on every frame of the slide.
    for (; f < 120 && h.diceState() === 'rest' && Math.abs(dice[0].position.x + dice[1].position.x - 2 * to.x) > 1e-3; f++) {
      h.diceRestAt(to);
      h.update(1 / 120);
    }
    // A 1.1 s slide at most, so well inside 120 frames at 120 Hz.
    expect(f).toBeLessThan(120);
    expect((dice[0].position.z + dice[1].position.z) / 2).toBeCloseTo(to.z, 3);
  });

  it('a shallow touch in the air moves them only a hair', () => {
    const { h } = crapsTable();
    type Body = { pos: THREE.Vector3; quat: THREE.Quaternion; vel: THREE.Vector3 };
    const pair = (h as unknown as { dice: { bodies: Body[]; collide(bounce: boolean): void } }).dice;
    const [a, b] = pair.bodies;
    // In the air, square to each other, a hair closer than touching along z.
    a.pos.set(0, 1.5, 0); b.pos.set(0, 1.5, DIE_SIZE - 5e-7);
    a.quat.identity(); b.quat.identity();
    a.vel.set(0, 0, 0.5); b.vel.set(0, 0, -0.5);
    pair.collide(true);
    expect(a.pos.distanceTo(new THREE.Vector3(0, 1.5, 0))).toBeLessThan(0.002);
    expect(Math.abs(b.pos.x)).toBeLessThan(1e-6);
    // And the knock is along the contact (z), not sideways.
    expect(Math.abs(a.vel.x)).toBeLessThan(1e-9);
    expect(a.vel.z).toBeLessThan(0);
  });

  it('are solid to the overlap test itself', () => {
    const q = new THREE.Quaternion();
    const half = DIE_SIZE / 2;
    expect(diceOverlap(new THREE.Vector3(0, 0, 0), q, new THREE.Vector3(DIE_SIZE * 1.01, 0, 0), q, half)).toBeNull();
    const hit = diceOverlap(new THREE.Vector3(0, 0, 0), q, new THREE.Vector3(DIE_SIZE * 0.9, 0, 0), q, half)!;
    expect(hit.x).toBeCloseTo(DIE_SIZE * 0.1, 6);
    // Turned 45°, a die's corner reaches further: the same gap now overlaps.
    const turned = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    expect(diceOverlap(new THREE.Vector3(0, 0, 0), turned, new THREE.Vector3(DIE_SIZE * 1.1, 0, 0), q, half)).not.toBeNull();
  });
});

describe('💰 the settle’s chip moves on the table', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: fakeCanvas });
    vi.stubGlobal('window', {});
  });
  afterEach(() => vi.unstubAllGlobals());

  const HOUSE = { x: -0.26, z: 0.36 };
  const MY_RAIL = { x: -0.9, z: -0.48 };
  const moves = () => ({
    house: HOUSE,
    lost: [{ x: 0.5, z: -0.2, chips: [25, 5], dim: true, pid: 'b', spot: 'field:' }],
    back: [{ s: { x: -0.3, z: -0.32, chips: [5, 5], dim: false, pid: 'a', spot: 'pass:' }, to: MY_RAIL, order: 0, mine: true }],
    paid: [{ chips: [5, 5], to: MY_RAIL, order: 0, mine: true, dim: false }],
  });

  it('sweeps the losers into the house first, then pays out of it: the payout rises there and lands on the rail with the stake', async () => {
    const { chipRunAt, FELT_Y, settleRuns } = await import('./casinoTable3d');
    const [lost, back, paid] = settleRuns(moves());
    // The loser leaves at once and ends sunk under the house spot.
    const at = (r: typeof lost, t: number) => chipRunAt({ ...r, t });
    expect(at(lost, 0)).toEqual({ x: 0.5, y: FELT_Y + 0.001, z: -0.2 });
    const lostEnd = lost.legs.at(-1)!;
    expect([lostEnd.x, lostEnd.z]).toEqual([HOUSE.x, HOUSE.z]);
    expect(lostEnd.y).toBeLessThan(FELT_Y - 2 * 0.0072);
    // The payout is out of sight in the house until the losers are in…
    const sweptIn = lost.legs[0].s;
    expect(paid.hidden).toBe(true);
    expect(paid.wait).toBeGreaterThan(sweptIn);
    expect(at(paid, paid.wait - 0.01)).toBeNull();
    // …then rises out of it, and slides to my rail.
    const risen = at(paid, paid.wait + paid.legs[0].s);
    expect(risen!.x).toBeCloseTo(HOUSE.x, 6);
    expect(risen!.z).toBeCloseTo(HOUSE.z, 6);
    expect(risen!.y).toBeCloseTo(FELT_Y + 0.001, 6);
    const end = (r: typeof lost) => r.wait + r.legs.reduce((a, l) => a + l.s, 0);
    // The stake waits on the felt, then reaches the rail as the payout does.
    expect(at(back, 0)).toEqual({ x: -0.3, y: FELT_Y + 0.001, z: -0.32 });
    expect(end(back)).toBeCloseTo(end(paid), 6);
    const onRail = at(paid, end(paid) - paid.legs.at(-1)!.s);
    expect([onRail!.x, onRail!.z]).toEqual([MY_RAIL.x, MY_RAIL.z]);
    expect(at(paid, end(paid))).toBeNull();
    // Nothing lost: the pay-out starts almost at once.
    const [quick] = settleRuns({ ...moves(), lost: [], back: [] });
    expect(quick.wait).toBeLessThan(sweptIn);
  });

  it('draws the moving chips, says when mine are on the way, and clears them on a reset', () => {
    const group = buildItemGroup({ id: 'craps-settle', kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    let handle: CasinoTableVisualHandle | null = null;
    group.traverse((o) => {
      if (o.userData.casinoTable) handle = o.userData.casinoTable as CasinoTableVisualHandle;
    });
    const h = handle as unknown as CasinoTableVisualHandle;
    h.settleChips(moves());
    h.update(0);
    // The loser and the stake show at once; the payout is still in the house.
    expect(chipsDrawn(group)).toBe(4);
    expect(h.payingMe()).toBe(true);
    for (let i = 0; i < 60; i++) h.update(1 / 60);
    expect(chipsDrawn(group)).toBe(4);
    for (let i = 0; i < 180; i++) h.update(1 / 60);
    expect(chipsDrawn(group)).toBe(0);
    expect(h.payingMe()).toBe(false);
    h.settleChips(moves());
    h.reset();
    h.update(0);
    expect(h.payingMe()).toBe(false);
    expect(chipsDrawn(group)).toBe(0);
  });

  it('pays out of clear felt in front of the stickman: no betting box, the ⚙️, the FAIR plaque or the dice spot', async () => {
    const { CHIP_RADIUS, CRAPS_DICE_SPOT, CRAPS_HOUSE_SPOT, CRAPS_LAYOUT } = await import('./games/casinoLayout');
    const { fairPlaqueCentre, FAIR_PLAQUE_SIZE } = await import('./casinoTable3d');
    const p = CRAPS_HOUSE_SPOT;
    const r = CHIP_RADIUS;
    const f = CRAPS_LAYOUT.felt;
    expect(p.x - r > f.x0 && p.x + r < f.x1 && p.z - r > f.z0 && p.z + r < f.z1).toBe(true);
    for (const rg of CRAPS_LAYOUT.regions) {
      for (const b of rg.rects) expect(b.x0 < p.x + r && b.x1 > p.x - r && b.z0 < p.z + r && b.z1 > p.z - r, rg.id).toBe(false);
    }
    const g = CRAPS_LAYOUT.settings;
    expect(Math.hypot(p.x - g.x, p.z - g.z)).toBeGreaterThan(g.r + r);
    const c = fairPlaqueCentre(g, 'right');
    expect(Math.abs(p.x - c.x)).toBeGreaterThan(FAIR_PLAQUE_SIZE.w / 2 + r);
    expect(Math.hypot(p.x - CRAPS_DICE_SPOT.x, p.z - CRAPS_DICE_SPOT.z)).toBeGreaterThan(0.2);
    // In front of the stickman: the +z side, by the middle.
    expect(p.z).toBeGreaterThan(0.3);
    expect(Math.abs(p.x)).toBeLessThan(0.35);
  });
});
