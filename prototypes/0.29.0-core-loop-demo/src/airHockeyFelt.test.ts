/**
 * 🏒 Where the painted goal line actually is (#184).
 *
 * `airHockeyTheme.ts` proves the goal line is a COLOUR every observer can
 * pick out. It says nothing about where that colour is painted, and the
 * geometry is the half of the fix that carries a cost: to keep the mouth
 * legible it is drawn inset into the playfield instead of on top of the
 * boundary stroke, so a player sighting down the paint is sighting short of
 * the plane that actually scores. furniture.ts states that cost in a comment.
 * This file is what makes the statement true, and keeps it true.
 *
 * It is measured, not asserted from a constant. The table is built for real
 * through `buildItemGroup`, against a canvas that records the 2-D calls
 * instead of rasterising them, and the goal lines are then found by MEANING —
 * the horizontal strokes exactly as wide as the goal mouth — rather than by
 * their pixel coordinates. The conversion to metres comes from the felt
 * mesh's own extent and the exported `AH_*` constants, so the numbers here
 * follow a change to the canvas size, the inset, the table's dimensions or
 * the plane geometry rather than having to be hand-updated after one.
 *
 * ⚠️ What it does not check: that the painted felt LOOKS right. These are
 * draw calls, not pixels — a stroke painted in the wrong colour, in the wrong
 * order, or over the top of something else reads the same here. Colour is
 * airHockeyTheme.test.ts's job; this file is only about position.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { buildItemGroup } from './furniture';
import { AH_GOAL_HALF_W, AH_HALF_L, AH_HALF_W, AH_PUCK_R } from './games/airHockey';

const TABLE = 'air-hockey-felt-test';

/** One recorded 2-D call: the method's name and the numbers passed to it. */
interface Op {
  readonly op: string;
  readonly args: readonly number[];
}

/** A canvas element that rasterises nothing and remembers everything. */
interface RecordingCanvas {
  width: number;
  height: number;
  readonly ops: Op[];
  getContext: () => unknown;
}

/**
 * A stand-in canvas whose 2-D context answers every call with `undefined` and
 * appends it to `ops`. Property WRITES (`fillStyle`, `lineWidth`, …) are
 * stored rather than recorded: this file reasons about position only, and a
 * proxy that recorded them too would make the op list harder to read for no
 * gain here.
 */
function recordingCanvas(): RecordingCanvas {
  const ops: Op[] = [];
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target
      ? target[key]
      : (...args: unknown[]) => {
        ops.push({ op: String(key), args: args.filter((a): a is number => typeof a === 'number') });
      }),
    set: (target, key, value) => { target[key] = value; return true; },
  });
  return { width: 0, height: 0, ops, getContext: () => ctx };
}

beforeEach(() => {
  vi.stubGlobal('document', { createElement: () => recordingCanvas() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * The felt: the mesh World files the air-hockey handle on, which is the one
 * the playfield texture is mapped to. Found by its handle rather than by its
 * geometry or its position, because that is the mesh the rest of the app
 * treats as the playfield — if the texture ever moved to a different mesh,
 * this should fail rather than quietly measure the old one.
 */
function buildFelt(): { canvas: RecordingCanvas; geometry: THREE.BufferGeometry } {
  const group = buildItemGroup({
    id: TABLE, kind: 'air-hockey-table', pos: { x: 0, z: 0 }, rot: 0, movable: true,
  });
  const felt: THREE.Mesh[] = [];
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh && obj.userData.airHockey) felt.push(obj);
  });
  expect(felt, 'the table filed its air-hockey handle on exactly one mesh').toHaveLength(1);
  const material = felt[0].material as THREE.MeshBasicMaterial;
  const canvas = material.map?.image as RecordingCanvas | undefined;
  if (!canvas?.ops) throw new Error('the felt mesh carries no recorded canvas texture');
  return { canvas, geometry: felt[0].geometry };
}

/**
 * The horizontal strokes exactly as wide as the goal mouth, as a distance in
 * metres from the nearer scoring plane. Identifying them by width is the
 * point: it reads the goal lines out of the op list the way a person would
 * ("the ones spanning the mouth"), so it cannot be satisfied by some other
 * stroke that happens to sit at the same height, and it checks the mouth's
 * width on the way past.
 */
function goalLines(canvas: RecordingCanvas): { px: number[]; metres: number[] } {
  // The felt's texels are NOT square: 512 × 848 is only "≈ the playfield's
  // 1.52 : 2.52 aspect", as furniture.ts puts it, so a pixel is 2.969 mm
  // across and 2.972 mm along. Converting a width with the length scale is
  // off by a part in a thousand — invisible on screen and fatal to an exact
  // match, which is why the two scales are kept apart here.
  const acrossPerPx = (AH_HALF_W * 2) / canvas.width;
  const alongPerPx = (AH_HALF_L * 2) / canvas.height;
  const wanted = (AH_GOAL_HALF_W * 2) / acrossPerPx; // mouth width, in pixels
  const found: number[] = [];
  for (let i = 0; i + 1 < canvas.ops.length; i++) {
    const [from, to] = [canvas.ops[i], canvas.ops[i + 1]];
    if (from.op !== 'moveTo' || to.op !== 'lineTo') continue;
    const [x0, y0] = from.args;
    const [x1, y1] = to.args;
    if (y0 !== y1) continue;                                   // horizontal only
    if (Math.abs(Math.abs(x1 - x0) - wanted) > 1e-6) continue; // mouth-width only
    found.push(y0);
  }
  // Distance to the NEARER end plane: the art is mirror-symmetric, so each
  // line belongs to the end it was drawn against.
  return { px: found, metres: found.map((y) => Math.min(y, canvas.height - y) * alongPerPx) };
}

describe('air-hockey felt geometry', () => {
  it('maps the playfield texture onto exactly the area that scores', () => {
    const { geometry } = buildFelt();
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    // Every figure below converts pixels to metres by assuming the canvas
    // spans the playfield corner to corner. If the plane is ever resized or
    // inset, that assumption dies silently and the measurements become
    // decorative — so it is a check, not a comment.
    //
    // Six places, not more: the vertices live in a Float32Array, so 0.76 is
    // stored as 0.759999990… and no amount of care here recovers the missing
    // bits. The slack is ~1e-8 m — a hundredth of a micron — against a
    // tolerance of 5e-7, which is still far tighter than any real change to
    // the plane's size could slip through.
    expect(box.max.x).toBeCloseTo(AH_HALF_W, 6);
    expect(box.min.x).toBeCloseTo(-AH_HALF_W, 6);
    expect(box.max.z).toBeCloseTo(AH_HALF_L, 6);
    expect(box.min.z).toBeCloseTo(-AH_HALF_L, 6);
  });

  it('paints one goal line per end, mirrored, and no third one', () => {
    const { canvas } = buildFelt();
    const { px, metres } = goalLines(canvas);
    expect(px, 'a goal line per end, found by the mouth width').toHaveLength(2);
    // Mirror symmetry is the whole reason the felt has no orientation to get
    // wrong (the sides are keyed by the coloured bands, not the art), so the
    // two ends must measure the same to the pixel.
    expect(px[0] + px[1]).toBe(canvas.height);
    expect(metres[0]).toBeCloseTo(metres[1], 12);
    // Inboard, not outboard: a line painted past the scoring plane would be
    // off the table.
    for (const y of px) expect(y).toBeGreaterThan(0);
    for (const y of px) expect(y).toBeLessThan(canvas.height);
  });

  it('sits 7.7 cm inboard of the scoring plane — 1.40 puck radii, not one', () => {
    const { canvas } = buildFelt();
    const { metres } = goalLines(canvas);
    const inboard = metres[0];

    // A goal is scored when the puck's centre reaches ±(AH_HALF_L + AH_PUCK_R)
    // — i.e. when the puck has fully crossed z = ±AH_HALF_L, which is the edge
    // of this texture. So the distance from the painted line to the canvas
    // edge IS the distance from the paint to the plane that scores.
    expect(inboard).toBeCloseTo(0.0773, 4);
    expect(inboard / AH_PUCK_R).toBeCloseTo(1.405, 3);

    // 🎯 The regression this test exists for. The comment in furniture.ts
    // used to say "~5.3 cm … roughly one puck radius", which is 18 px
    // converted correctly from the wrong baseline: `goalLineInset` is 18 px
    // from the BOUNDARY STROKE, and the boundary stroke is itself 8 px
    // inboard of the texture edge. The paint is 26 px from the plane, not 18.
    // Keeping the false figure out is worth an assertion because it is the
    // kind of error that reads as fine — the arithmetic is right, the
    // baseline is not.
    expect(inboard / AH_PUCK_R).toBeGreaterThan(1.2);
  });

  it('keeps the 18 px inset measured from the stroke it was measured from', () => {
    const { canvas } = buildFelt();
    const { px } = goalLines(canvas);

    // The boundary: the one strokeRect on the felt. Its offset from the
    // texture edge is the 8 px that the old comment lost.
    const boundary = canvas.ops.filter((o) => o.op === 'strokeRect');
    expect(boundary, 'the felt draws exactly one boundary rectangle').toHaveLength(1);
    const [bx, by, bw, bh] = boundary[0].args;
    expect(bx).toBe(by);                        // same inset on both axes
    expect(bx * 2 + bw).toBe(canvas.width);     // ... and centred
    expect(by * 2 + bh).toBe(canvas.height);

    // `goalLineInset` as the source names it: from the boundary stroke inward.
    const nearer = Math.min(...px);
    expect(nearer - by, 'goalLineInset drifted from the 18 px the comment cites').toBe(18);

    // And the two baselines really are different, which is the trap: quoting
    // the inset as a distance from the scoring plane understates it by a
    // whole boundary offset.
    expect(nearer).toBe(by + 18);
    expect(by).toBeGreaterThan(0);
  });
});
