/**
 * 🖼️ Wallpaper on the octagon END WALLS and the ROOM FLOOR (issue 326).
 *
 * The editor used to offer only the 8 barrel strips, and the one it called
 * "Floor" is the basement floor under the deck. These pin the new surfaces
 * end to end: the editor's Surface row reaches them, the room doc keeps their
 * records, the hull paints a whole end wall with tiling UVs, and the room
 * floor gets a covering sized to the room.
 */
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import * as Y from 'yjs';

/** A canvas that draws nothing (the wallpaper art is canvas-painted). */
function fakeCanvas() {
  const ctx = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (target, key) => (key in target ? target[key] : () => undefined),
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
  return { width: 0, height: 0, getContext: () => ctx };
}
vi.stubGlobal('document', { createElement: fakeCanvas });

const {
  WALLPAPER_SURFACES,
  resolveFloorWallpaper,
  resolveWallpaper,
  stepWallpaperSurface,
} = await import('./wallpaper');
const { bindWallpaperLayoutDoc, isWallpaperLayoutRecord, readAllWallpaper, writeWallpaper } = await import(
  './wallpaperLayoutDoc'
);
const { buildOctagonHull } = await import('./octagonHull');
const { SURFACES } = await import('./hullSection');

describe('wallpaper surfaces', () => {
  it('offers the 8 strips, both octagon end walls and the room floor, once each', () => {
    expect(new Set(WALLPAPER_SURFACES).size).toBe(WALLPAPER_SURFACES.length);
    expect([...WALLPAPER_SURFACES].sort()).toEqual([...SURFACES, 'cap-neg', 'cap-pos', 'deck'].sort());
  });

  it('steps the editor row through every surface and wraps both ways', () => {
    const seen: string[] = [];
    let s = WALLPAPER_SURFACES[0];
    for (let i = 0; i < WALLPAPER_SURFACES.length; i++) {
      seen.push(s);
      s = stepWallpaperSurface(s, 1);
    }
    expect(seen).toEqual([...WALLPAPER_SURFACES]);
    expect(s).toBe(WALLPAPER_SURFACES[0]); // wrapped forward
    expect(stepWallpaperSurface(WALLPAPER_SURFACES[0], -1)).toBe(WALLPAPER_SURFACES.at(-1)); // and back
  });

  it('steps past a cupola end (glass takes no covering), even when starting on one', () => {
    const order = WALLPAPER_SURFACES;
    const capNeg = order.indexOf('cap-neg');
    expect(stepWallpaperSurface(order[capNeg - 1], 1, ['cap-neg'])).toBe(order[capNeg + 1]);
    expect(stepWallpaperSurface(order[capNeg + 1], -1, ['cap-neg'])).toBe(order[capNeg - 1]);
    // Both ends glass: one press crosses both.
    expect(stepWallpaperSurface('wall-pos', 1, ['cap-neg', 'cap-pos'])).toBe('deck');
    expect(stepWallpaperSurface('deck', -1, ['cap-neg', 'cap-pos'])).toBe('wall-pos');
    // Sitting on an end that has just turned to glass steps on from there.
    expect(stepWallpaperSurface('cap-neg', 1, ['cap-neg'])).toBe('cap-pos');
    expect(stepWallpaperSurface('cap-neg', -1, ['cap-neg'])).toBe('wall-pos');
  });
});

describe('wallpaperLayout room doc', () => {
  it('keeps coverings on the end walls and the room floor, and clears them with plain', () => {
    const doc = new Y.Doc();
    bindWallpaperLayoutDoc(doc);
    writeWallpaper('cap-neg', 'brick');
    writeWallpaper('deck', 'pool-tile');
    writeWallpaper('wall-pos', 'casino-gold');
    expect(Object.fromEntries(readAllWallpaper())).toEqual({
      'cap-neg': 'brick',
      deck: 'pool-tile',
      'wall-pos': 'casino-gold',
    });
    writeWallpaper('deck', 'plain');
    expect(readAllWallpaper().has('deck')).toBe(false);
    doc.destroy();
  });

  it('accepts the new surfaces from a peer and still drops anything else', () => {
    for (const surface of ['cap-neg', 'cap-pos', 'deck', 'floor']) {
      expect(isWallpaperLayoutRecord({ surface, preset: 'brick' }), surface).toBe(true);
    }
    expect(isWallpaperLayoutRecord({ surface: 'ceiling', preset: 'brick' })).toBe(false);
    expect(isWallpaperLayoutRecord({ surface: 'deck', preset: 'plain' })).toBe(false);
    expect(isWallpaperLayoutRecord({ surface: 'deck', preset: 'marble' })).toBe(false);
  });
});

// A square 12 m room (the default 2 × 2 module): narrow on x, so the end walls
// stand at z = ±6 and span x ∈ [−6, 6]; the walls are 4 m tall.
const ROOM = { halfX: 6, halfZ: 6 };
const CAP_PIECES = ['octagon-cap-wall', 'octagon-cap-roof', 'octagon-cap-basement'];
/** The end pieces above the floor, which the end wall's covering dresses. */
const PAPERED = ['octagon-cap-wall', 'octagon-cap-roof'];

/** The end-wall meshes standing at z = `z` (every vertex on that plane). */
function capMeshes(hull: ReturnType<typeof buildOctagonHull>, z: number): THREE.Mesh[] {
  return hull.group.children.filter((c): c is THREE.Mesh => {
    const m = c as THREE.Mesh;
    if (!m.isMesh || !CAP_PIECES.includes(m.name)) return false;
    const pos = m.geometry.getAttribute('position');
    for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getZ(i) - z) > 1e-9) return false;
    return true;
  });
}
const mapOf = (m: THREE.Mesh) => (m.material as THREE.MeshStandardMaterial).map;

describe('buildOctagonHull — end-wall coverings', () => {
  it('papers the end above the floor (band and roof gable) and leaves the other end bare', () => {
    const hull = buildOctagonHull(ROOM, {}, { 'cap-neg': 'brick' });
    const painted = capMeshes(hull, -6);
    const bare = capMeshes(hull, 6);
    expect(painted.map((m) => m.name).sort()).toEqual([...CAP_PIECES].sort());
    expect(bare).toHaveLength(3);
    const brick = resolveWallpaper('brick')!.map;
    for (const m of painted) expect(mapOf(m), m.name).toBe(PAPERED.includes(m.name) ? brick : null);
    for (const m of bare) expect(mapOf(m), m.name).toBeNull();
    hull.dispose();
  });

  it('gives every end piece UVs in metres (u = across the end, v = height) so tiles keep their size', () => {
    const hull = buildOctagonHull(ROOM, {}, { 'cap-pos': 'blue-tile' });
    for (const m of capMeshes(hull, 6)) {
      const pos = m.geometry.getAttribute('position');
      const uv = m.geometry.getAttribute('uv');
      expect(uv, `${m.name} has no UVs`).toBeDefined();
      for (let i = 0; i < pos.count; i++) {
        expect(uv.getX(i), m.name).toBeCloseTo(pos.getX(i), 6);
        expect(uv.getY(i), m.name).toBeCloseTo(pos.getY(i), 6);
      }
    }
    hull.dispose();
  });

  it('keeps the covering on an end wall cut open by a door', () => {
    const door = { wall: 'y-' as const, lateral: 0, width: 2, height: 3 };
    const hull = buildOctagonHull(ROOM, {}, { 'cap-neg': 'casino-gold' }, [door]);
    const band = capMeshes(hull, -6).find((m) => m.name === 'octagon-cap-wall')!;
    expect(mapOf(band)).toBe(resolveWallpaper('casino-gold')!.map);
    const pos = band.geometry.getAttribute('position');
    const uv = band.geometry.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      expect(uv.getX(i)).toBeCloseTo(pos.getX(i), 6);
      expect(uv.getY(i)).toBeCloseTo(pos.getY(i), 6);
    }
    hull.dispose();
  });

  it('builds a cupola end as glass and frame, whatever covering its record holds', () => {
    const hull = buildOctagonHull(ROOM, {}, { 'cap-neg': 'brick' }, [], 'y-');
    expect(capMeshes(hull, -6)).toHaveLength(0);
    const frames = hull.group.children.filter((c) => c.name === 'cupola-frame') as THREE.Mesh[];
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(mapOf(f)).toBeNull();
    hull.dispose();
  });

  it('ignores the room-floor record (world.ts paints the floor, not the hull)', () => {
    const hull = buildOctagonHull(ROOM, {}, { deck: 'pool-tile' });
    for (const c of hull.group.children) {
      const m = c as THREE.Mesh;
      if (m.isMesh) expect(mapOf(m), m.name).toBeNull();
    }
    hull.dispose();
  });
});

describe('resolveFloorWallpaper — the room floor', () => {
  it('is null for plain, so the room keeps its own floor', () => {
    expect(resolveFloorWallpaper('plain', 12, 12)).toBeNull();
  });

  it('tiles at the wall scale across the whole room (the floor UVs run 0..1)', () => {
    for (const id of ['blue-tile', 'brick', 'casino-gold', 'pool-tile'] as const) {
      const wall = resolveWallpaper(id)!;
      const floor = resolveFloorWallpaper(id, 12, 20)!;
      expect(floor.map.repeat.x, id).toBeCloseTo(wall.map.repeat.x * 12, 9);
      expect(floor.map.repeat.y, id).toBeCloseTo(wall.map.repeat.y * 20, 9);
      // Its own copy (the wall's repeat is untouched) of the same picture.
      expect(floor.map).not.toBe(wall.map);
      expect(floor.map.source).toBe(wall.map.source);
      expect(wall.map.repeat.x).toBe(wall.map.repeat.y);
      expect([floor.color, floor.roughness, floor.metalness]).toEqual([wall.color, wall.roughness, wall.metalness]);
    }
  });

  it('re-sizes its copy when the room is resized', () => {
    const a = resolveFloorWallpaper('brick', 12, 12)!;
    const b = resolveFloorWallpaper('brick', 6, 24)!;
    const perMetre = resolveWallpaper('brick')!.map.repeat.x;
    expect(b.map).toBe(a.map);
    expect([b.map.repeat.x, b.map.repeat.y]).toEqual([perMetre * 6, perMetre * 24]);
  });
});
