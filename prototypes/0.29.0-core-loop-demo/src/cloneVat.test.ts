// Clone-vat tests (#165): the walk-in chamber, its hourglass mouth, and the
// decant choreography's two ordering promises.
//
// The owner asked for four things. Three of them are checkable here:
//   • the vat sits centred on a 2×2 square and is bigger  → placement + the
//     measured mesh, which must not leave the square it declares;
//   • an hourglass HARD LIMIT the avatar is squeezed through → the real rig,
//     measured, must actually pass the real aperture;
//   • the liquid is SEEN empty before the door opens, and the door is shut
//     before a drop returns → frame-by-frame invariants on the state machine.
// The fourth (the door itself being bigger) follows from the mouth geometry
// and is covered by the aperture-vs-glass assertions.
//
// Both the plate texture and the avatar's face decal paint on a 2D canvas, so
// the node environment needs a canvas shim. It is installed before any build
// call; furniture.ts itself is import-safe without it (only buildCloneVat
// touches the DOM), while voxelCharacter is loaded dynamically after the shim.

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  FURNITURE,
  FURNITURE_DEFS,
  VAT_APERTURE,
  buildItemGroup,
  itemAabb,
} from './furniture';
import type { FurnitureItem } from './furniture';
import { fitVatSqueeze, minApertureHalfWidth, MIN_SQUEEZE } from './vatFit';
import type { CloneVatHandle } from './devices';

// ── Canvas shim ─────────────────────────────────────────────────────────────
// Every 2D-context call is a no-op and every read returns something harmless;
// the geometry under test never reads a pixel back.
const noop = () => undefined;
const ctxStub = new Proxy(
  {
    canvas: null,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    lineCap: '',
    lineJoin: '',
    filter: '',
    globalCompositeOperation: '',
    shadowBlur: 0,
    shadowColor: '',
  } as Record<string, unknown>,
  {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      if (prop === 'measureText') return () => ({ width: 10 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return () => ({ addColorStop: noop });
      return noop;
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  },
);
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ctxStub,
    style: {},
    addEventListener: noop,
  }),
};

// ── Fixtures ────────────────────────────────────────────────────────────────

const DEFAULT_VAT = FURNITURE.find((i) => i.id === 'clone-vat')!;

function vatItem(over: Partial<FurnitureItem> = {}): FurnitureItem {
  return { ...DEFAULT_VAT, pos: { ...DEFAULT_VAT.pos }, ...over };
}

/** Build a vat and dig out the handle the way World does — via a mesh's
 *  userData, which is the one contract furnitureHandles.ts files on. */
function buildVat(item: FurnitureItem = vatItem()): {
  group: THREE.Group;
  handle: CloneVatHandle;
} {
  const group = buildItemGroup(item);
  let handle: CloneVatHandle | undefined;
  group.traverse((obj) => {
    const h = obj.userData.cloneVat as CloneVatHandle | undefined;
    if (h) handle = h;
  });
  expect(handle, 'clone-vat must stow a handle on one of its meshes').toBeTruthy();
  return { group, handle: handle! };
}

/** Is `p` inside a CLOSED mesh? Odd crossing count along +x. Only valid for
 *  solids (the vat's shells are open surfaces), so callers filter first. */
function insideSolid(mesh: THREE.Mesh, p: THREE.Vector3): boolean {
  const mat = mesh.material as THREE.Material;
  const side = mat.side;
  mat.side = THREE.DoubleSide; // a ray may START inside a back face
  const hits = new THREE.Raycaster(
    p.clone(),
    new THREE.Vector3(1, 0, 0),
    0,
    50,
  ).intersectObject(mesh, false);
  mat.side = side;
  return hits.length % 2 === 1;
}

/** Every mesh in a built group, in traversal order. */
function allMeshes(group: THREE.Group): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) out.push(m);
  });
  return out;
}

/** One frame of the decant, as an observer outside the closure sees it. */
interface Frame {
  /** 0 (empty) … 1 (full), recovered from the liquid mesh's own pose. */
  level: number;
  /** 0 (shut) … π (tucked behind the tube). */
  door: number;
}

function sample(group: THREE.Group): Frame {
  const liquid = group.getObjectByName('cloneVatLiquid')!;
  const door = group.getObjectByName('cloneVatDoor')!;
  // applyPose floors the scale at 0.0001 (a zero scale breaks matrix
  // inversion) and hides the mesh instead, so "hidden" IS empty.
  return {
    level: liquid.visible ? liquid.scale.y : 0,
    door: Math.abs(door.rotation.y),
  };
}

/** Run the whole ceremony at 60 Hz and return every frame plus what the
 *  open callback saw. `closeAfter` mimics World: the walk-out finishes, then
 *  closeAndRefill is called. */
function runCycle(
  group: THREE.Group,
  handle: CloneVatHandle,
  opts: { close?: boolean } = {},
): { frames: Frame[]; opens: Frame[] } {
  const DT = 1 / 60;
  const frames: Frame[] = [];
  const opens: Frame[] = [];
  let closed = false;
  handle.beginSpawnCycle(() => opens.push(sample(group)));
  // 10 s is comfortably longer than BEAT+DRAIN+EMPTY+OPEN+CLOSE+REFILL (6.65 s).
  for (let i = 0; i < 600; i++) {
    handle.update(DT);
    frames.push(sample(group));
    if (opts.close !== false && opens.length > 0 && !closed) {
      closed = true;
      handle.closeAndRefill();
    }
  }
  return { frames, opens };
}

// ── The 2×2 chamber ─────────────────────────────────────────────────────────

describe('clone vat — the 2×2 chamber (#165)', () => {
  it('declares a 2×2 footprint and a matching 2×2 stand point', () => {
    const def = FURNITURE_DEFS['clone-vat'];
    expect(def.footprint).toEqual({ w: 2, d: 2 });
    // Same convention as the other 2×2 device (map-table): half a metre clear
    // of the footprint edge, so the panel is reachable without standing in
    // the doorway the clone walks out of.
    expect(def.device?.front).toEqual({ x: 0, z: 1.5 });
    expect(def.functions).toContain('cloneVat');
  });

  it('is centred on the square: even extents put the centre on integers', () => {
    // Parity rule (snapItemPos): an EVEN tile-extent puts the centre on an
    // integer, an odd one at n+0.5. The vat used to be 1×1 at (-4.7, -4.9),
    // which was neither.
    expect(Number.isInteger(DEFAULT_VAT.pos.x)).toBe(true);
    expect(Number.isInteger(DEFAULT_VAT.pos.z)).toBe(true);
    expect(itemAabb(DEFAULT_VAT)).toEqual({ x0: -6, z0: -6, x1: -4, z1: -4 });
  });

  it('keeps every part of the mesh inside its own obstacle, door open or shut', () => {
    // The reason this matters: the obstacle is what the A* grid and collision
    // know about. Anything the mesh puts OUTSIDE the square is scenery the
    // player can walk through — and next to a wall, scenery that pokes out of
    // the wall. Measured rather than asserted against VAT_COLLAR_R, so a new
    // greeble cannot quietly widen the prop.
    const { group, handle } = buildVat(vatItem({ pos: { x: 0, z: 0 } }));
    const measure = () => {
      const box = new THREE.Box3().setFromObject(group);
      return Math.max(
        Math.abs(box.min.x),
        Math.abs(box.max.x),
        Math.abs(box.min.z),
        Math.abs(box.max.z),
      );
    };
    expect(measure()).toBeLessThanOrEqual(1);
    runCycle(group, handle, { close: false }); // leaves the door tucked open
    expect(sample(group).door).toBeGreaterThan(0);
    expect(measure()).toBeLessThanOrEqual(1);
  });

  it('mounts the status decal ON the cap, not through it', () => {
    // A flat plane on a TAPERED cap is buried at the crown and floating at
    // the base — the first cut of this build lost 5% of the decal (a wedge
    // across its top line of text) inside the cap hull. The decal is a shell
    // that matches the taper, so no vertex of it may sit inside any solid it
    // overlaps. Measured, because the failure is invisible to a constant.
    const { group } = buildVat(vatItem({ pos: { x: 0, z: 0 } }));
    group.updateMatrixWorld(true);
    const meshes = allMeshes(group);
    // The decal is the vat's only textured material.
    const decals = meshes.filter(
      (mesh) => (mesh.material as THREE.MeshBasicMaterial).map != null,
    );
    expect(decals).toHaveLength(1);
    const decal = decals[0];
    const decalBox = new THREE.Box3().setFromObject(decal);
    const pos = decal.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    let buried = 0;
    for (const mesh of meshes) {
      if (mesh === decal) continue;
      // Odd-crossing only means anything for a closed solid; the vat's
      // shells, deck and grate are open surfaces. All of them are far from
      // the cap, so a bounds filter is enough to leave only solids here.
      if (!new THREE.Box3().setFromObject(mesh).intersectsBox(decalBox))
        continue;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(decal.matrixWorld);
        if (insideSolid(mesh, v)) buried++;
      }
    }
    expect(buried).toBe(0);
  });

  it('stands on the room floor — no plinth to step over', () => {
    const { group } = buildVat(vatItem({ pos: { x: 0, z: 0 } }));
    const box = new THREE.Box3().setFromObject(group);
    // A walk-in chamber whose floor is the room floor: the avatar's own y=0
    // maps straight onto the aperture's y=0, which is what lets vatFit treat
    // rig heights as aperture heights without an offset.
    expect(box.min.y).toBeGreaterThanOrEqual(0);
    expect(box.min.y).toBeLessThan(0.05);
    // Taller than the old prop and taller than the mouth it contains.
    expect(box.max.y).toBeGreaterThan(VAT_APERTURE.height);
  });

  it('sits flush in the corner without overlapping another default obstacle', () => {
    const mine = itemAabb(DEFAULT_VAT)!;
    for (const other of FURNITURE) {
      if (other.id === DEFAULT_VAT.id) continue;
      const box = itemAabb(other);
      if (!box) continue;
      const overlaps =
        mine.x0 < box.x1 &&
        box.x0 < mine.x1 &&
        mine.z0 < box.z1 &&
        box.z0 < mine.z1;
      expect(overlaps, `clone-vat overlaps ${other.id}`).toBe(false);
    }
  });

  it('clears both door openings', () => {
    // North door spans x[-1,1] on the back wall, west door z[-1,1] on the left
    // wall (doorLayout.ts: DOOR_OPENING_WIDTH = 2, centred). A spawn chamber
    // parked in a doorway would wedge every arrival.
    const box = itemAabb(DEFAULT_VAT)!;
    expect(box.x1).toBeLessThanOrEqual(-1);
    expect(box.z1).toBeLessThanOrEqual(-1);
  });
});

// ── The hourglass mouth ─────────────────────────────────────────────────────

describe('clone vat — the hourglass mouth', () => {
  it('pinches: the waist is narrower than the lobes', () => {
    expect(VAT_APERTURE.waistHalfWidth).toBeLessThan(VAT_APERTURE.lobeHalfWidth);
    expect(VAT_APERTURE.waistAt).toBeGreaterThan(0);
    expect(VAT_APERTURE.waistAt).toBeLessThan(1);
  });

  it('fits inside the glass it is cut out of', () => {
    // asin() in vatMouthHalfAngle would go NaN on a lobe wider than the tube,
    // silently producing a shell with holes.
    expect(VAT_APERTURE.lobeHalfWidth).toBeLessThanOrEqual(
      VAT_APERTURE.doorPlaneRadius,
    );
    expect(VAT_APERTURE.innerRadius).toBeLessThan(VAT_APERTURE.doorPlaneRadius);
    expect(VAT_APERTURE.innerRadius).toBeGreaterThan(0);
  });

  it('leaves the chamber clear: nothing crosses the glass skin', () => {
    // A prop that straddles the tube wall hangs inside the space the avatar
    // occupies. The feed conduits did exactly that in the first cut of this
    // build — 2 cm of orange pipe through the glass — while the comment above
    // them claimed they ran outside it. Sampled at the moment that matters:
    // door open, tank drained, which is when the avatar is in there.
    const { group, handle } = buildVat(vatItem({ pos: { x: 0, z: 0 } }));
    runCycle(group, handle, { close: false });
    group.updateMatrixWorld(true);
    const skin = VAT_APERTURE.doorPlaneRadius;
    const v = new THREE.Vector3();
    const straddlers: string[] = [];
    for (const mesh of allMeshes(group)) {
      if (!mesh.visible) continue; // the drained bath is not in the way
      const pos = mesh.geometry.getAttribute('position');
      let inside = 0;
      let outside = 0;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (v.y < 0.05 || v.y > VAT_APERTURE.height) continue;
        const r = Math.hypot(v.x, v.z);
        if (r < skin - 1e-3) inside++;
        else if (r > skin + 1e-3) outside++;
      }
      if (inside > 0 && outside > 0) straddlers.push(mesh.geometry.type);
    }
    expect(straddlers).toEqual([]);
  });

  it('declares an innerRadius no looser than the tube really is', () => {
    // innerRadius is a HARD LIMIT the squeeze is solved against, so it has to
    // be the real tightest ring — which is not the glass but the two steel
    // edge rails. Measured on the open, drained vat: anything a future greeble
    // hangs inside the tube has to be declared here or this fails.
    const { group, handle } = buildVat(vatItem({ pos: { x: 0, z: 0 } }));
    runCycle(group, handle, { close: false });
    group.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    let tightest = Infinity;
    for (const mesh of allMeshes(group)) {
      if (!mesh.visible) continue;
      const pos = mesh.geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        if (v.y < 0.05 || v.y > VAT_APERTURE.height) continue;
        const r = Math.hypot(v.x, v.z);
        // Only rings COUNT: the deck and grate are floor plates, and they are
        // excluded by the y filter above, not by their radius.
        if (r < VAT_APERTURE.doorPlaneRadius - 1e-9) tightest = Math.min(tightest, r);
      }
    }
    expect(tightest).toBeLessThan(Infinity); // the rails must be in there
    expect(VAT_APERTURE.innerRadius).toBeLessThanOrEqual(tightest);
  });

  it('is no taller than the tube the avatar stands in', () => {
    const { group } = buildVat(vatItem({ pos: { x: 0, z: 0 } }));
    const box = new THREE.Box3().setFromObject(group);
    expect(VAT_APERTURE.height).toBeLessThanOrEqual(box.max.y);
  });

  it('squeezes the REAL rig through, without hitting the MIN_SQUEEZE floor', async () => {
    const { VoxelCharacter } = await import('./voxelCharacter');
    const character = new VoxelCharacter(new THREE.Scene());
    const rig = character.silhouette();
    const fit = fitVatSqueeze(rig, VAT_APERTURE);

    // The fox really is taller and wider than the mouth — if this ever stops
    // being true the squeeze has become decorative and the test below would
    // pass vacuously.
    expect(rig.height).toBeGreaterThan(VAT_APERTURE.height);
    expect(fit.vertical).toBeLessThan(1);
    expect(fit.horizontal).toBeLessThan(1);

    // MIN_SQUEEZE is the "an honest clip beats a deformed fox" backstop. The
    // SHIPPED vat must never need it: hitting the floor would mean the avatar
    // clips the glass it was supposed to be fitted to.
    expect(fit.horizontal).toBeGreaterThan(MIN_SQUEEZE);
    expect(fit.vertical).toBeGreaterThan(MIN_SQUEEZE);

    // And the fit actually passes, band by band, at the heights the bands
    // occupy after the vertical squeeze.
    const EPS = 1e-9;
    expect(rig.height * fit.vertical).toBeLessThanOrEqual(
      VAT_APERTURE.height + EPS,
    );
    for (const band of rig.bands) {
      const limit = minApertureHalfWidth(
        VAT_APERTURE,
        band.y0 * fit.vertical,
        band.y1 * fit.vertical,
      );
      expect(band.halfWidth * fit.horizontal).toBeLessThanOrEqual(limit + EPS);
      expect(band.maxRadius * fit.horizontal).toBeLessThanOrEqual(
        VAT_APERTURE.innerRadius + EPS,
      );
    }
  });

  it('measures the rig from the live meshes and re-measures after an accessory', async () => {
    const { VoxelCharacter } = await import('./voxelCharacter');
    const character = new VoxelCharacter(new THREE.Scene());
    const first = character.silhouette();
    expect(character.silhouette()).toBe(first); // cached, not re-walked
    expect(first.bands.length).toBeGreaterThan(10);
    expect(first.height).toBeGreaterThan(1);
    // Bands are ordered and contiguous — minApertureHalfWidth is handed
    // (y0, y1) pairs and would silently mis-clamp on an inverted band.
    for (const band of first.bands) expect(band.y1).toBeGreaterThan(band.y0);

    // A cap changes the outline the vat has to pass, so the cache MUST drop.
    // Serving the stale measurement would fit the bare fox through the mouth
    // and let the dressed one clip it — the one failure the hard limit exists
    // to rule out. The measurement walks vertices, so added geometry can only
    // grow the maxima, never shrink them.
    character.attachAccessory('cap');
    const capped = character.silhouette();
    expect(capped).not.toBe(first);
    expect(capped.height).toBeGreaterThanOrEqual(first.height - 1e-9);
    expect(capped.bands.length).toBeGreaterThanOrEqual(first.bands.length);

    // removeAccessory is documented as the exact inverse of attach (no drift),
    // so the re-measurement has to land back on the original numbers.
    character.removeAccessory();
    const bare = character.silhouette();
    expect(bare).not.toBe(capped);
    expect(bare.height).toBeCloseTo(first.height, 9);
    expect(bare.bands.length).toBe(first.bands.length);
    for (let i = 0; i < bare.bands.length; i += 1) {
      expect(bare.bands[i].halfWidth).toBeCloseTo(first.bands[i].halfWidth, 9);
      expect(bare.bands[i].maxRadius).toBeCloseTo(first.bands[i].maxRadius, 9);
    }
  });

  it('applies the squeeze below the master group, so the axis cannot drift', async () => {
    const { VoxelCharacter } = await import('./voxelCharacter');
    const character = new VoxelCharacter(new THREE.Scene());
    const before = new THREE.Box3().setFromObject(character.masterGroup);

    character.setSqueeze(0.5, 0.8);
    character.masterGroup.updateMatrixWorld(true);
    const after = new THREE.Box3().setFromObject(character.masterGroup);

    // masterGroup.rotation.y tracks the CONTINUOUS facing angle; only the
    // child visual group carries the 8-way snapped body frame. A scale on the
    // master group would therefore squash along a drifting axis.
    expect(character.masterGroup.scale.x).toBe(1);
    expect(character.masterGroup.scale.y).toBe(1);
    expect(character.masterGroup.scale.z).toBe(1);
    expect(after.max.x - after.min.x).toBeCloseTo(
      (before.max.x - before.min.x) * 0.5,
      6,
    );
    expect(after.max.y).toBeCloseTo(before.max.y * 0.8, 6);
    // Feet stay on the floor: the rig's y=0 is its footprint, so a vertical
    // squeeze shortens from the top rather than sinking the avatar.
    expect(after.min.y).toBeCloseTo(before.min.y * 0.8, 6);

    character.clearSqueeze();
    character.masterGroup.updateMatrixWorld(true);
    const restored = new THREE.Box3().setFromObject(character.masterGroup);
    expect(restored.max.x).toBeCloseTo(before.max.x, 6);
    expect(restored.max.y).toBeCloseTo(before.max.y, 6);
  });
});

// ── The decant choreography ─────────────────────────────────────────────────

describe('clone vat — decant ordering (#165 ask 4)', () => {
  it('idles full and still until a cycle is asked for', () => {
    const { group, handle } = buildVat();
    for (let i = 0; i < 60; i++) handle.update(1 / 60);
    expect(sample(group)).toEqual({ level: 1, door: 0 });
  });

  it('never moves the door while there is liquid in the tank', () => {
    const { group, handle } = buildVat();
    const { frames } = runCycle(group, handle);
    for (const [i, f] of frames.entries()) {
      if (f.door > 0) {
        expect(f.level, `frame ${i}: door moved on a non-empty tank`).toBe(0);
      }
    }
  });

  it('never lets the liquid rise unless the door is fully shut', () => {
    const { group, handle } = buildVat();
    const { frames } = runCycle(group, handle);
    for (let i = 1; i < frames.length; i++) {
      if (frames[i].level > frames[i - 1].level) {
        expect(frames[i].door, `frame ${i}: refilling through an open door`).toBe(0);
        expect(frames[i - 1].door).toBe(0);
      }
    }
  });

  it('holds the tank visibly empty before the door starts to move', () => {
    // Not decoration: draining straight into the swing let the last frames of
    // liquid overlap the leaf's first, so the tank was never SEEN empty.
    const { group, handle } = buildVat();
    const { frames } = runCycle(group, handle);
    const firstEmpty = frames.findIndex((f) => f.level === 0);
    const firstMove = frames.findIndex((f) => f.door > 0);
    expect(firstEmpty).toBeGreaterThanOrEqual(0);
    expect(firstMove).toBeGreaterThan(firstEmpty);
    // VAT_EMPTY_TIME is 0.35 s ≈ 21 frames at 60 Hz; 10 is a floor that still
    // fails a beat trimmed to nothing but tolerates a deliberate retune.
    expect(firstMove - firstEmpty).toBeGreaterThanOrEqual(10);
  });

  it('calls back exactly once, on an empty tank and a fully open door', () => {
    const { group, handle } = buildVat();
    const { frames, opens } = runCycle(group, handle);
    expect(opens).toHaveLength(1);
    expect(opens[0].level).toBe(0);
    const widest = Math.max(...frames.map((f) => f.door));
    expect(opens[0].door).toBeCloseTo(widest, 9);
    expect(opens[0].door).toBeCloseTo(Math.PI, 9);
  });

  it('comes back to rest full and shut', () => {
    const { group, handle } = buildVat();
    runCycle(group, handle);
    expect(sample(group)).toEqual({ level: 1, door: 0 });
  });

  it('drops a pending open when the cycle is superseded', () => {
    // World aborts a decant when the vat is removed or the avatar beams out.
    // A late onOpen would then walk a player who is no longer being spawned.
    const { group, handle } = buildVat();
    const opens: Frame[] = [];
    handle.beginSpawnCycle(() => opens.push(sample(group)));
    handle.update(1 / 60);
    handle.closeAndRefill();
    for (let i = 0; i < 600; i++) handle.update(1 / 60);
    expect(opens).toHaveLength(0);
    expect(sample(group)).toEqual({ level: 1, door: 0 });
  });

  it('ignores a negative or zero delta rather than running the cycle backwards', () => {
    const { group, handle } = buildVat();
    handle.beginSpawnCycle(noop);
    for (let i = 0; i < 30; i++) handle.update(-1);
    expect(sample(group)).toEqual({ level: 1, door: 0 });
  });
});
