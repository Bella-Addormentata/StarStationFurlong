/**
 * 🖼️🩹🧪 Wallpaper read-repair tests (#80 S6 walls-migration completeness).
 *
 * Pins the legacy → wallpaper mapping so a room-doc a peer sent from a client
 * that predated df26789 still renders its brick side wall on the hull after
 * upgrade. Also pins the shape-guard boundary (junk / hostile inputs must fail
 * safe, never crash and never fabricate a covering) and the merge precedence
 * that keeps the owner's explicit wallpaper choice authoritative over any
 * derivation guess.
 *
 * Pure module → pure tests: no THREE, no Yjs, no DOM fixtures.
 */

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFurnitureDoc, readAllFurniture, readRawFurnitureValues } from './furnitureDoc';
import type { HullSurface, NarrowAxis } from './hullSection';
import { SURFACES } from './hullSection';
import { WALLPAPER_PRESETS, isWallpaperPreset } from './wallpaper';
import {
  EDGE_MARGIN,
  LEGACY_WALL_KINDS,
  deriveLegacyWallpapers,
  isLegacyWallRecord,
  mergeWithExplicit,
  surfaceForLegacyRecord,
} from './wallpaperDerivation';

// A 12 m × 12 m legacy room: halfX = halfZ = 6, narrowAxis 'x' (tie rule).
const HALF = 6;

describe('isLegacyWallRecord', () => {
  it('accepts a brick-wall with numeric coords', () => {
    expect(
      isLegacyWallRecord({ kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true }),
    ).toBe(true);
  });

  it('accepts a window-wall (the other retired kind)', () => {
    expect(
      isLegacyWallRecord({ kind: 'window-wall', x: 5.8, z: 2, rot: 1, movable: true }),
    ).toBe(true);
  });

  it('rejects a non-legacy kind (bar-corner, wall-computer, etc.)', () => {
    expect(isLegacyWallRecord({ kind: 'bar-corner', x: 0, z: 0 })).toBe(false);
    expect(isLegacyWallRecord({ kind: 'casino-gold-wall', x: 0, z: 0 })).toBe(false);
    // ↑ casino-gold-wall is a decorative attached fixture — the migration must
    //   deliberately IGNORE it (issue #80 permits items attached to the wall).
  });

  it('rejects a non-object', () => {
    expect(isLegacyWallRecord(null)).toBe(false);
    expect(isLegacyWallRecord(undefined)).toBe(false);
    expect(isLegacyWallRecord('brick-wall')).toBe(false);
    expect(isLegacyWallRecord(42)).toBe(false);
  });

  it('rejects records missing coords (fails SAFE — never fabricates)', () => {
    expect(isLegacyWallRecord({ kind: 'brick-wall' })).toBe(false);
    expect(isLegacyWallRecord({ kind: 'brick-wall', x: 0 })).toBe(false);
    expect(isLegacyWallRecord({ kind: 'brick-wall', z: 0 })).toBe(false);
  });

  it('rejects records with non-finite coords (Infinity / NaN / null)', () => {
    expect(isLegacyWallRecord({ kind: 'brick-wall', x: Number.NaN, z: 0 })).toBe(false);
    expect(isLegacyWallRecord({ kind: 'brick-wall', x: 0, z: Infinity })).toBe(false);
    expect(isLegacyWallRecord({ kind: 'brick-wall', x: null, z: 0 })).toBe(false);
    expect(isLegacyWallRecord({ kind: 'brick-wall', x: 0, z: '5' })).toBe(false);
  });

  it('accepts records with extra unrelated fields (forward-compat)', () => {
    // A hostile peer stamping extra keys is not a threat — the guard should
    // not care about fields we do not read.
    expect(
      isLegacyWallRecord({ kind: 'brick-wall', x: -5.8, z: 0, futureField: 'x' }),
    ).toBe(true);
  });

  it('LEGACY_WALL_KINDS contains exactly the retired kinds', () => {
    expect(new Set(LEGACY_WALL_KINDS)).toEqual(new Set(['brick-wall', 'window-wall']));
  });
});

describe('surfaceForLegacyRecord', () => {
  const narrowAxis: NarrowAxis = 'x';

  it('picks wall-neg for a west-edge segment (matches old sideWalls[0] rule)', () => {
    // Historical placements from world.ts pre-df26789 (updateSideWallCoverage):
    // any brick/window wall at pos.x < -5 → sideWalls[0]. Threshold here is
    // narrowHalf - EDGE_MARGIN = 4.5, so -5.8 crosses it.
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: -5.8, z: 0 }, HALF, narrowAxis),
    ).toBe<HullSurface>('wall-neg');
  });

  it('picks wall-pos for an east-edge segment (matches old sideWalls[1])', () => {
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: 5.8, z: 0 }, HALF, narrowAxis),
    ).toBe<HullSurface>('wall-pos');
  });

  it('ignores a segment deep in the middle of the room (interior placement)', () => {
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: 0, z: 0 }, HALF, narrowAxis),
    ).toBeNull();
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: 2, z: 3 }, HALF, narrowAxis),
    ).toBeNull();
  });

  it('returns wall-pos exactly at the +threshold edge (>=, not >)', () => {
    const threshold = HALF - EDGE_MARGIN; // 4.5 for a 12×12 room
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: threshold, z: 0 }, HALF, narrowAxis),
    ).toBe<HullSurface>('wall-pos');
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: threshold - 0.01, z: 0 }, HALF, narrowAxis),
    ).toBeNull();
  });

  it('returns wall-neg exactly at the −threshold edge', () => {
    const threshold = HALF - EDGE_MARGIN;
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: -threshold, z: 0 }, HALF, narrowAxis),
    ).toBe<HullSurface>('wall-neg');
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: -threshold + 0.01, z: 0 }, HALF, narrowAxis),
    ).toBeNull();
  });

  it('reads the z coord when narrowAxis is z (resized room future-proofing)', () => {
    // A room widened past 12 on x but kept at 12 on z would flip to narrowAxis='z'.
    // The derivation must follow the extrude axis, not the historical x.
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: 0, z: -5.8 }, HALF, 'z'),
    ).toBe<HullSurface>('wall-neg');
    expect(
      surfaceForLegacyRecord({ kind: 'brick-wall', x: 0, z: 5.8 }, HALF, 'z'),
    ).toBe<HullSurface>('wall-pos');
  });

  it('handles pathological narrowHalf ≤ EDGE_MARGIN (threshold clamps to 0)', () => {
    // If a future resize shrinks the room past 1.5 m half-width, threshold
    // could go negative; the clamp ensures any x coord still picks a side
    // (correct — the whole room IS edge in a tiny module).
    // At a=0 both branches (a <= -0 and a >= 0) are true; the neg branch is
    // evaluated first so wall-neg wins the tie. Deterministic — same on every
    // client — which is what matters at the CRDT trust boundary; the exact
    // outcome for this degenerate case does not.
    expect(surfaceForLegacyRecord({ kind: 'brick-wall', x: 0, z: 0 }, 1, 'x')).toBe(
      'wall-neg',
    );
    // A negative x still picks wall-neg unambiguously.
    expect(surfaceForLegacyRecord({ kind: 'brick-wall', x: -0.5, z: 0 }, 1, 'x')).toBe(
      'wall-neg',
    );
    // A positive x still picks wall-pos unambiguously.
    expect(surfaceForLegacyRecord({ kind: 'brick-wall', x: 0.5, z: 0 }, 1, 'x')).toBe(
      'wall-pos',
    );
  });
});

describe('deriveLegacyWallpapers', () => {
  it('empty input → empty output', () => {
    expect(deriveLegacyWallpapers([], HALF, 'x')).toEqual({});
  });

  it('single brick-wall at west edge → wall-neg gets brick', () => {
    const raw = [{ kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true }];
    expect(deriveLegacyWallpapers(raw, HALF, 'x')).toEqual({ 'wall-neg': 'brick' });
  });

  it('window-wall maps to brick too (same brown-brick base look)', () => {
    // Both retired kinds shared color 0x8a4a3a; the frame IS brick, glass is
    // now the octagon's own windowLayoutDoc + hole cutter.
    const raw = [{ kind: 'window-wall', x: 5.8, z: 0, rot: 0, movable: true }];
    expect(deriveLegacyWallpapers(raw, HALF, 'x')).toEqual({ 'wall-pos': 'brick' });
  });

  it('covers BOTH side walls when segments sit at both edges', () => {
    // A fully brick-walled legacy room (owner painted both sides with segments)
    // must migrate as brick on both wall-neg and wall-pos.
    const raw = [
      { kind: 'brick-wall', x: -5.8, z: -2, rot: 0, movable: true },
      { kind: 'brick-wall', x: -5.8, z: 2, rot: 0, movable: true },
      { kind: 'brick-wall', x: 5.8, z: -2, rot: 0, movable: true },
      { kind: 'window-wall', x: 5.8, z: 2, rot: 0, movable: true },
    ];
    expect(deriveLegacyWallpapers(raw, HALF, 'x')).toEqual({
      'wall-neg': 'brick',
      'wall-pos': 'brick',
    });
  });

  it('multiple segments on the SAME wall collapse to one covering', () => {
    // 3 brick segments along the west edge → wall-neg wears brick ONCE.
    const raw = [
      { kind: 'brick-wall', x: -5.8, z: -3, rot: 0, movable: true },
      { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true },
      { kind: 'brick-wall', x: -5.8, z: 3, rot: 0, movable: true },
    ];
    const out = deriveLegacyWallpapers(raw, HALF, 'x');
    expect(out).toEqual({ 'wall-neg': 'brick' });
    expect(Object.keys(out)).toHaveLength(1);
  });

  it('ignores middle-of-room legacy records (respects the edge threshold)', () => {
    // An owner staging pieces on the floor (not touching a wall) should NOT
    // paint a wall. The old sideWall coverage rule did the same.
    const raw = [
      { kind: 'brick-wall', x: 0, z: 0, rot: 0, movable: true },
      { kind: 'window-wall', x: 2, z: -1, rot: 0, movable: true },
    ];
    expect(deriveLegacyWallpapers(raw, HALF, 'x')).toEqual({});
  });

  it('ignores unknown kinds (a live furniture placement is not a legacy record)', () => {
    // A modern furniture record shares the map — the derivation must skip it.
    const raw = [
      { kind: 'bar-corner', x: -5.8, z: 0, rot: 0, movable: true },
      { kind: 'wall-computer', x: 5.8, z: 0, rot: 0, movable: false },
      { kind: 'casino-gold-wall', x: -5.8, z: 0, rot: 0, movable: true },
    ];
    expect(deriveLegacyWallpapers(raw, HALF, 'x')).toEqual({});
  });

  it('fails SAFE on hostile / malformed peer records (no crash, no fabrication)', () => {
    // Every record here fails the guard — the derivation returns {} instead of
    // throwing, and never seeds a bogus covering from any of them.
    const raw = [
      null,
      undefined,
      'brick-wall',
      42,
      { kind: 'brick-wall' }, // missing coords
      { kind: 'brick-wall', x: 'west', z: 0 }, // wrong type
      { kind: 'brick-wall', x: Number.NaN, z: 0 }, // non-finite
      { kind: 'brick-wall', x: -5.8 /* no z */ },
    ];
    expect(deriveLegacyWallpapers(raw, HALF, 'x')).toEqual({});
  });

  it('respects narrowAxis=z (the extrude axis flips → coord lookup flips)', () => {
    // A future rectangular room narrow-on-z would have its walls at ±narrowHalf
    // on Z. Placements on the historical x-edges are IRRELEVANT there.
    const raw = [
      { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true }, // ignored on z-axis
      { kind: 'brick-wall', x: 0, z: -5.8, rot: 0, movable: true }, // → wall-neg
      { kind: 'window-wall', x: 0, z: 5.8, rot: 0, movable: true }, // → wall-pos
    ];
    expect(deriveLegacyWallpapers(raw, HALF, 'z')).toEqual({
      'wall-neg': 'brick',
      'wall-pos': 'brick',
    });
  });

  it('mixed valid + junk yields ONLY the valid coverings', () => {
    // Real-world defence: a doc holds one legacy record next to noise from
    // a misbehaving peer. Migration must still succeed for the good record.
    const raw = [
      { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true },
      null,
      'garbage',
      { kind: 'brick-wall', x: Number.POSITIVE_INFINITY, z: 0 },
      { kind: 'window-wall', x: 5.8, z: 1, rot: 0, movable: true },
    ];
    expect(deriveLegacyWallpapers(raw, HALF, 'x')).toEqual({
      'wall-neg': 'brick',
      'wall-pos': 'brick',
    });
  });
});

describe('mergeWithExplicit', () => {
  it('empty explicit → returns derivation unchanged', () => {
    const derived = { 'wall-neg': 'brick' as const };
    expect(mergeWithExplicit(derived, {})).toEqual(derived);
  });

  it('empty derivation → returns explicit unchanged', () => {
    const explicit = { 'wall-pos': 'blue-tile' as const };
    expect(mergeWithExplicit({}, explicit)).toEqual(explicit);
  });

  it('explicit wins on the SAME surface (owner choice > legacy guess)', () => {
    // Owner painted wall-neg with pool-tile after the migration; the legacy
    // brick guess for wall-neg must NOT stomp their choice.
    const derived = { 'wall-neg': 'brick' as const };
    const explicit = { 'wall-neg': 'pool-tile' as const };
    expect(mergeWithExplicit(derived, explicit)).toEqual({ 'wall-neg': 'pool-tile' });
  });

  it('derived and explicit compose on DIFFERENT surfaces (both survive)', () => {
    // Untouched legacy side (wall-neg = brick) + fresh choice on the ridge
    // (ridge = casino-gold). Both appear in the merged result.
    const derived = { 'wall-neg': 'brick' as const };
    const explicit = { ridge: 'casino-gold' as const };
    expect(mergeWithExplicit(derived, explicit)).toEqual({
      'wall-neg': 'brick',
      ridge: 'casino-gold',
    });
  });

  it('does not mutate its inputs (pure)', () => {
    // Both maps must be spread-copied; the world holds references to both
    // sources and mutating either would corrupt subsequent reads.
    const derived = { 'wall-neg': 'brick' as const };
    const explicit = { 'wall-pos': 'blue-tile' as const };
    const derivedBefore = { ...derived };
    const explicitBefore = { ...explicit };
    mergeWithExplicit(derived, explicit);
    expect(derived).toEqual(derivedBefore);
    expect(explicit).toEqual(explicitBefore);
  });
});

// ── Integration: the actual furnitureDoc → derivation seam ───────────────────
//
// These tests bind a fresh Y.Doc to bindFurnitureDoc and exercise the RAW
// reader that world.collectWallpaper() calls, proving the E2E migration path
// works: a peer wrote a legacy record → readAllFurniture drops it (guarded) →
// readRawFurnitureValues surfaces it → deriveLegacyWallpapers picks the right
// hull surface. This is the same sequence a joining client runs when it sees
// an old room-doc from a client that pre-dates df26789.

describe('integration: furnitureDoc → wallpaper derivation', () => {
  /** Bind a fresh Y.Doc so each test starts on a clean furniture map. */
  function bindFreshFurnitureDoc(): Y.Doc {
    const doc = new Y.Doc();
    bindFurnitureDoc(doc);
    return doc;
  }

  it('readRawFurnitureValues surfaces legacy records that readAllFurniture drops', () => {
    // The core migration invariant: readAllFurniture is guarded by FURNITURE_DEFS
    // and MUST drop retired kinds (legacy records must never end up as visible
    // 3D fixtures again). readRawFurnitureValues bypasses that guard so the
    // derivation can still see them.
    const doc = bindFreshFurnitureDoc();
    const map = doc.getMap('furniture');
    doc.transact(() => {
      map.set('legacy-1', { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true });
      map.set('legacy-2', { kind: 'window-wall', x: 5.8, z: 2, rot: 0, movable: true });
    });

    // Guarded reader: nothing survives (unknown FURNITURE_DEFS kind).
    expect(readAllFurniture().size).toBe(0);

    // Raw reader: both records survive.
    const raw = readRawFurnitureValues();
    expect(raw).toHaveLength(2);
    expect(raw.every(isLegacyWallRecord)).toBe(true);
  });

  it('legacy-only room-doc derives brick on both side walls', () => {
    // A room where the owner had painted BOTH side walls with brick / window
    // segments (typical pre-migration lobby). Post-upgrade, both walls must
    // still show brick — the migration hallmark.
    const doc = bindFreshFurnitureDoc();
    const map = doc.getMap('furniture');
    doc.transact(() => {
      map.set('w1', { kind: 'brick-wall', x: -5.8, z: -2, rot: 0, movable: true });
      map.set('w2', { kind: 'brick-wall', x: -5.8, z: 2, rot: 0, movable: true });
      map.set('e1', { kind: 'window-wall', x: 5.8, z: -2, rot: 0, movable: true });
      map.set('e2', { kind: 'window-wall', x: 5.8, z: 2, rot: 0, movable: true });
    });
    const derived = deriveLegacyWallpapers(readRawFurnitureValues(), HALF, 'x');
    expect(derived).toEqual({ 'wall-neg': 'brick', 'wall-pos': 'brick' });
  });

  it('legacy + modern records coexist: only the legacy ones drive derivation', () => {
    // Real docs mix: legacy wall segments plus a modern bar-corner and the
    // wall-computer. The derivation must scan past the modern records without
    // fabricating any covering from them.
    const doc = bindFreshFurnitureDoc();
    const map = doc.getMap('furniture');
    doc.transact(() => {
      map.set('bar', { kind: 'bar-corner', x: 4, z: 4, rot: 0, movable: true });
      map.set('term', { kind: 'wall-computer', x: 5.8, z: 0, rot: 0, movable: false });
      map.set('brick', { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true });
    });
    const derived = deriveLegacyWallpapers(readRawFurnitureValues(), HALF, 'x');
    expect(derived).toEqual({ 'wall-neg': 'brick' });
  });

  it('a doc with no legacy records derives nothing (empty implicit set)', () => {
    // Fresh rooms have no legacy records at all; the derivation must return
    // {} so nothing overrides the plain hull colour.
    const doc = bindFreshFurnitureDoc();
    const map = doc.getMap('furniture');
    doc.transact(() => {
      map.set('bar', { kind: 'bar-corner', x: 4, z: 4, rot: 0, movable: true });
    });
    const derived = deriveLegacyWallpapers(readRawFurnitureValues(), HALF, 'x');
    expect(derived).toEqual({});
  });

  it('every derived preset survives isWallpaperPreset (target reachability)', () => {
    // A derivation that returned a preset id NOT in WALLPAPER_PRESETS would
    // silently fail at render time (resolveWallpaper(id) falls back to
    // `plain`). Pin the invariant: every preset the derivation can emit
    // MUST pass the wallpaper doc's own guard. Retiring `brick` from the
    // preset list without updating the derivation would fail this test.
    const doc = bindFreshFurnitureDoc();
    const map = doc.getMap('furniture');
    doc.transact(() => {
      map.set('a', { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true });
      map.set('b', { kind: 'window-wall', x: 5.8, z: 0, rot: 0, movable: true });
    });
    const derived = deriveLegacyWallpapers(readRawFurnitureValues(), HALF, 'x');
    for (const preset of Object.values(derived)) {
      expect(isWallpaperPreset(preset)).toBe(true);
      expect(WALLPAPER_PRESETS).toContain(preset);
    }
  });

  it('every derived HULL SURFACE key is a real one (window/door pipeline is untouched)', () => {
    // Surfaces the derivation emits go straight into the HullWallpapers map
    // buildOctagonHull uses; a mis-typed key (e.g. "wall-neg-side") would
    // silently paint nothing. Also pins the door/window guarantee: the only
    // surfaces the migration ever paints are the vertical side walls — not
    // the roof, not the basement, not the floor — so the window / door hole
    // pipelines (on their OWN strips) are architecturally out of scope of
    // the migration.
    const doc = bindFreshFurnitureDoc();
    const map = doc.getMap('furniture');
    doc.transact(() => {
      // Cover BOTH walls at once so both keys appear in the assertion.
      map.set('w', { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true });
      map.set('e', { kind: 'window-wall', x: 5.8, z: 0, rot: 0, movable: true });
    });
    const derived = deriveLegacyWallpapers(readRawFurnitureValues(), HALF, 'x');
    const emittedSurfaces = Object.keys(derived) as HullSurface[];
    for (const surface of emittedSurfaces) {
      expect(SURFACES).toContain(surface);
    }
    // The migration only ever paints the two SIDE walls — never a roof or
    // basement surface — no matter how many legacy records the doc holds.
    const sideWallsOnly = new Set<HullSurface>(['wall-neg', 'wall-pos']);
    for (const surface of emittedSurfaces) {
      expect(sideWallsOnly.has(surface)).toBe(true);
    }
  });

  it('mergeWithExplicit still lets an owner cover the brick with new paint', () => {
    // The completeness of the migration means legacy design survives BY
    // DEFAULT but the owner keeps agency: painting a wall via the editor
    // authoritatively wins on that surface.
    const doc = bindFreshFurnitureDoc();
    const map = doc.getMap('furniture');
    doc.transact(() => {
      map.set('brick', { kind: 'brick-wall', x: -5.8, z: 0, rot: 0, movable: true });
    });
    const derived = deriveLegacyWallpapers(readRawFurnitureValues(), HALF, 'x');
    // Owner picked pool-tile on wall-neg via the wallpaper editor.
    const explicit: Partial<Record<HullSurface, 'pool-tile'>> = {
      'wall-neg': 'pool-tile',
    };
    expect(mergeWithExplicit(derived, explicit)).toEqual({ 'wall-neg': 'pool-tile' });
  });
});
