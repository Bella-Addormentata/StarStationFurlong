/**
 * 🦊🦊 #345: foxes standing side by side squish to fit, each taking half the
 * space between them, on that side only (foxSquish.ts), and the fox rig
 * draws it (VoxelCharacter.squishTo).
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { FOX_HALF_WIDTH_M } from './sightline';
import { FOX_BESIDE_DEPTH_M, FOX_SQUISH_MIN, foxSquish, type FoxSquish } from './foxSquish';

/** A canvas whose 2-D context draws nothing: the fox's face paints through one. */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'measureText') return () => ({ width: 40 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop: () => undefined });
      if (key === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => undefined;
    },
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return { width: 0, height: 0, style: {}, getContext: () => ctx };
}
vi.stubGlobal('document', { createElement: fakeCanvas });
vi.stubGlobal('window', { location: { search: '' } });
const { VoxelCharacter } = await import('./voxelCharacter');

const at = (x: number, z = 0, y = 0) => ({ x, y, z });
/** Facing π (toward −z, like players at an arcade cabinet faced from +z),
 *  a fox's own +x is world −x. */
const SCREENS = Math.PI;

/** Where a fox at world x, facing SCREENS, is drawn across world x. */
function span(x: number, s: FoxSquish): [number, number] {
  const middle = x - s.shift; // its +x is world −x
  return [middle - s.width * FOX_HALF_WIDTH_M, middle + s.width * FOX_HALF_WIDTH_M];
}

/** Squish each of a row of foxes at `xs`, all facing SCREENS, by the rest. */
function row(xs: number[]): FoxSquish[] {
  return xs.map((x, i) => foxSquish(at(x), SCREENS, xs.filter((_, j) => j !== i).map((o) => at(o))));
}

describe('foxSquish', () => {
  it('leaves a fox on its own, or with nobody beside it, at full size', () => {
    expect(foxSquish(at(0), SCREENS, [])).toEqual({ width: 1, shift: 0 });
    // Further off than two half-foxes: no need.
    expect(foxSquish(at(0), SCREENS, [at(2 * FOX_HALF_WIDTH_M + 0.01)])).toEqual({ width: 1, shift: 0 });
    // In front or behind, not beside: squishing would not part them.
    expect(foxSquish(at(0), SCREENS, [at(0.5, FOX_BESIDE_DEPTH_M + 0.01)])).toEqual({ width: 1, shift: 0 });
    expect(foxSquish(at(0), SCREENS, [at(0.05, 0.6)])).toEqual({ width: 1, shift: 0 });
    // On the top bunk above it.
    expect(foxSquish(at(0), SCREENS, [at(0.6, 0, 1.6)])).toEqual({ width: 1, shift: 0 });
  });

  it('squishes two side by side on the side they meet, each leaning away into its free side', () => {
    const [a, b] = row([-0.5, 0.5]);
    expect(a!.width).toBeLessThan(1);
    expect(b!.width).toBeCloseTo(a!.width, 9);
    // Leaning away: a (on the left) toward −x, b toward +x.
    expect(span(-0.5, a!)[0] + span(-0.5, a!)[1]).toBeLessThan(-1);
    expect(span(0.5, b!)[0] + span(0.5, b!)[1]).toBeGreaterThan(1);
    // Their free sides stay where a full-size fox's would be.
    expect(span(-0.5, a!)[0]).toBeCloseTo(-0.5 - FOX_HALF_WIDTH_M, 9);
    expect(span(0.5, b!)[1]).toBeCloseTo(0.5 + FOX_HALF_WIDTH_M, 9);
    // And they meet half way, no longer one on top of the other.
    expect(span(-0.5, a!)[1]).toBeCloseTo(0, 9);
    expect(span(0.5, b!)[0]).toBeCloseTo(0, 9);
  });

  it('squishes a fox between two from both sides, in the middle of its space', () => {
    const [, mid] = row([-1, 0, 1]);
    expect(mid!.shift).toBeCloseTo(0, 9);
    expect(mid!.width).toBeCloseTo(1 / (2 * FOX_HALF_WIDTH_M), 9);
  });

  it('fits four at the double-wide cabinet a metre apart without any of them on another', () => {
    const xs = [-1.5, -0.5, 0.5, 1.5];
    const squished = row(xs);
    const spans = xs.map((x, i) => span(x, squished[i]!));
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1] - 1e-9);
    // The middle two from both sides, the end two only on the inside.
    expect(squished[1]!.width).toBeLessThan(squished[0]!.width);
    expect(squished[0]!.shift).toBeGreaterThan(0);
    expect(squished[3]!.shift).toBeLessThan(0);
  });

  it('is turned with the fox: an end player turned in to the screens leans away from the one beside it', () => {
    // Player 1 at the left end, turned an eighth in (facing 3π/4), player 2
    // a metre to their right facing the screens.
    const p1 = foxSquish(at(-1.5, 1.2), (3 * Math.PI) / 4, [at(-0.5, 1.2)]);
    expect(p1.width).toBeLessThan(1);
    // Its own +x at 3π/4 is (−0.71, −0.71) across the floor: away from player 2.
    expect(p1.shift).toBeGreaterThan(0);
  });

  it('never squishes a fox to less than FOX_SQUISH_MIN, however tight', () => {
    const tight = row([-0.4, 0, 0.4]);
    expect(tight[1]!.width).toBe(FOX_SQUISH_MIN);
    for (const s of tight) expect(s.width).toBeGreaterThanOrEqual(FOX_SQUISH_MIN);
  });
});

describe('the fox rig, squished', () => {
  /** A rig whose clock ticks 20 ms a frame. */
  function rig(facing: number) {
    const r = new VoxelCharacter(new THREE.Scene());
    (r as unknown as { clock: { getDelta: () => number; getElapsedTime: () => number } }).clock = {
      getDelta: () => 0.02,
      getElapsedTime: () => 0,
    };
    r.setState('idle', facing);
    return r;
  }
  /** Where the rig is drawn across world x (a fox's across, facing π). */
  const across = (r: InstanceType<typeof VoxelCharacter>) => {
    r.masterGroup.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(r.masterGroup);
    return [box.min.x, box.max.x];
  };

  it('eases to the width and shift it is given, across the way it is drawn, and back out', () => {
    const r = rig(Math.PI);
    r.update();
    const [full0, full1] = across(r);
    r.squishTo(0.6, 0.2);
    r.update();
    const [step0, step1] = across(r);
    expect(step1 - step0).toBeLessThan(full1 - full0);
    expect(step1 - step0).toBeGreaterThan(0.6 * (full1 - full0));
    for (let i = 0; i < 60; i++) r.update();
    const [s0, s1] = across(r);
    expect(s1 - s0).toBeCloseTo(0.6 * (full1 - full0), 2);
    // Facing π its +x is world −x: shifted 0.2 m that way.
    expect((s0 + s1) / 2).toBeCloseTo((full0 + full1) / 2 - 0.2, 2);
    // Where the fox stands never moves.
    expect(r.masterGroup.position.x).toBe(0);
    expect(r.masterGroup.scale.x).toBe(1);
    r.squishTo(1, 0);
    for (let i = 0; i < 60; i++) r.update();
    const [b0, b1] = across(r);
    expect(b1 - b0).toBeCloseTo(full1 - full0, 2);
    expect((b0 + b1) / 2).toBeCloseTo((full0 + full1) / 2, 2);
  });

  it('shifts along the snapped way it is drawn when its facing is between two of the eight', () => {
    // Drawn facing π, though its facing is a little off it.
    const r = rig(Math.PI + 0.2);
    expect(r.getFacing()).toBeCloseTo(Math.PI, 9);
    r.update();
    const [full0, full1] = across(r);
    r.squishTo(1, 0.3);
    for (let i = 0; i < 60; i++) r.update();
    const [s0, s1] = across(r);
    expect((s0 + s1) / 2).toBeCloseTo((full0 + full1) / 2 - 0.3, 2);
    expect(s1 - s0).toBeCloseTo(full1 - full0, 2);
  });
});
