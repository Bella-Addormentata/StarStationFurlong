// vatGauge.ts tests (#165): the clone vat's hourglass clearance — the avatar
// squeezed to it must NEVER poke outside it (a hard limit, checked here by
// brute-force sampling, independent of the solver's own shortcut), the
// squeeze must ease rather than pop, and the door may only shut once the
// clone is past it. Plus the 2×2 default placement and the one-time
// migration of rooms still holding the old 1×1 default pose.

import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  AVATAR_REACH,
  AVATAR_SILHOUETTE,
  VAT_DOOR_ARC,
  VAT_DOOR_SWEEP_R,
  VAT_DOOR_TOP_Y,
  VAT_EXIT_ALONG,
  VAT_FALLBACK_MIN_R,
  VAT_GLASS_BASE_Y,
  VAT_GLASS_H,
  VAT_GLASS_R,
  VAT_HOLD_ALONG,
  VAT_MIN_RELEASE_ALONG,
  VAT_MIN_SCALE,
  VAT_NECK_H,
  VAT_NECK_HALF_W,
  VAT_PAD_Y,
  VAT_PALLOR_FADE_S,
  VAT_PALLOR_HEX,
  VAT_PLINTH_R,
  VAT_Q_LIP,
  VAT_Q_NECK,
  VAT_TANK_H,
  vatClearOfDoorAt,
  VAT_FOOTPRINT_HALF,
  vatDoorClear,
  vatFallbackRelease,
  vatFloorY,
  vatFreeExitAlong,
  vatFullSizeFitsAt,
  vatGaugeAt,
  vatPallorAt,
  vatPallorHex,
  vatShutDoorReleaseAlong,
  vatSqueezeAt,
  vatStrandedRelease,
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

  it('seals a released clone only once its whole reach is past the door', () => {
    // The reach is the tail tip, whichever way the clone turns.
    expect(AVATAR_REACH).toBeGreaterThan(1.1);
    const clearAt = VAT_DOOR_SWEEP_R + AVATAR_REACH;
    expect(vatClearOfDoorAt(clearAt - 0.01, 1)).toBe(false);
    expect(vatClearOfDoorAt(clearAt + 0.1, 1)).toBe(true);
    // Conservative next to the along-axis test at the normal exit.
    expect(vatDoorClear(VAT_EXIT_ALONG, 1)).toBe(true);
  });

  it('builds a tank that fits its footprint with a leaf that can park behind the shell', () => {
    expect(VAT_GLASS_R).toBeLessThan(VAT_DOOR_SWEEP_R);
    expect(VAT_DOOR_SWEEP_R).toBeLessThan(VAT_PLINTH_R);
    expect(VAT_PLINTH_R + 0.05).toBeLessThanOrEqual(1); // base ring, 2×2 ⇒ ±1 m
    expect(VAT_DOOR_ARC).toBeLessThanOrEqual(Math.PI);
  });
});

describe('vatFreeExitAlong — where a movable vat\'s walk-out can end', () => {
  const R = 0.38; // player collision radius (player.ts PLAYER_R)
  const ROOM = { boundX: 5.5, boundZ: 5.5 }; // default walkable box
  const box = (cx: number, cz: number, hw: number, hd: number) => ({
    x0: cx - hw,
    z0: cz - hd,
    x1: cx + hw,
    z1: cz + hd,
  });

  it('walks the full exit on open floor, ignoring the vat\'s own footprint', () => {
    const own = box(0, 0, 1, 1);
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own], ROOM, R)).toBe(VAT_EXIT_ALONG);
  });

  it('stops inside the walkable box when the vat faces a wall', () => {
    // A 2×2 vat against the south placement edge, door facing the wall.
    const end = vatFreeExitAlong({ x: 0, z: 4 }, 0, [box(0, 4, 1, 1)], ROOM, R)!;
    expect(4 + end).toBeLessThanOrEqual(ROOM.boundZ);
    // Clear of the vat's own collision box, not just past its footprint.
    expect(end).toBeGreaterThanOrEqual(VAT_FOOTPRINT_HALF + R);
    expect(end).toBeLessThan(VAT_EXIT_ALONG);
  });

  it('stops a collision radius short of furniture across the path', () => {
    // Door facing +x (rot 1); a 1×1 item 1.9–2.9 m out along the path.
    const blocker = box(2.4, 0, 0.5, 0.5);
    const end = vatFreeExitAlong({ x: 0, z: 0 }, Math.PI / 2, [box(0, 0, 1, 1), blocker], ROOM, R)!;
    expect(end).toBeLessThanOrEqual(blocker.x0 - R);
    expect(end).toBeGreaterThan(blocker.x0 - R - 0.06);
  });

  it('gives no walk-out end when the doorway itself is blocked', () => {
    // Furniture flush against the door face; or one only just too close.
    const own = box(0, 0, 1, 1);
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, box(0, 1.5, 1, 0.5)], ROOM, R)).toBeNull();
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, box(0, 2.2, 1, 0.5)], ROOM, R)).toBeNull();
  });

  it('then steps the clone out at the nearest free spot, door side first', () => {
    const own = box(0, 0, 1, 1);
    const blocker = box(0, 1.5, 1, 0.5); // x[-1,1] z[1,2] across the door
    const obstacles = [own, blocker];
    const spot = vatFallbackRelease({ x: 0, z: 0 }, 0, obstacles, ROOM, R)!;
    for (const b of obstacles) {
      const inside =
        spot.x > b.x0 - R && spot.x < b.x1 + R && spot.z > b.z0 - R && spot.z < b.z1 + R;
      expect(inside).toBe(false);
    }
    expect(Math.abs(spot.x)).toBeLessThanOrEqual(ROOM.boundX);
    expect(Math.abs(spot.z)).toBeLessThanOrEqual(ROOM.boundZ);
    expect(spot.z).toBeGreaterThan(0); // still on the door's side of the vat
    // Released full-size at once, facing anywhere: its whole reach must clear
    // the vat (plinth ring + tail), not just its collision radius — and so
    // the door can seal straight away.
    const d = Math.hypot(spot.x, spot.z);
    expect(d).toBeGreaterThanOrEqual(VAT_FALLBACK_MIN_R);
    expect(d - AVATAR_REACH).toBeGreaterThan(VAT_PLINTH_R);
    expect(vatClearOfDoorAt(d, 1)).toBe(true);
    // A room with nowhere free gives no spot rather than an overlapping one.
    const full = box(0, 0, 6, 6);
    expect(vatFallbackRelease({ x: 0, z: 0 }, 0, [full], ROOM, R)).toBeNull();
  });

  it('searches the whole room when nothing near the vat is free', () => {
    // Everything but a strip along the east wall (x > 4.5) is covered.
    const cover = { x0: -6, z0: -6, x1: 4.5, z1: 6 };
    const spot = vatFallbackRelease({ x: 0, z: 0 }, 0, [cover], ROOM, R)!;
    expect(spot.x).toBeGreaterThanOrEqual(cover.x1 + R);
    expect(spot.x).toBeLessThanOrEqual(ROOM.boundX);
  });

  it('puts a clone down past the shut door only where its tail clears the sweep', () => {
    const own = box(0, 0, 1, 1);
    // Open floor: the full exit, where the full-size clone is past the door.
    const open = vatShutDoorReleaseAlong({ x: 0, z: 0 }, 0, [own], ROOM, R)!;
    expect(open).toBe(VAT_EXIT_ALONG);
    expect(vatDoorClear(open, 1)).toBe(true);
    // A path cut short at ~1.65 m still ends a walk-out through the open door,
    // but with the door shut the tail would be inside it: no spot here.
    const short = { x0: -1, z0: 2.05, x1: 1, z1: 2.5 };
    const walkEnd = vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, short], ROOM, R)!;
    expect(walkEnd).toBeGreaterThanOrEqual(VAT_MIN_RELEASE_ALONG);
    expect(vatDoorClear(walkEnd, 1)).toBe(false);
    expect(vatShutDoorReleaseAlong({ x: 0, z: 0 }, 0, [own, short], ROOM, R)).toBeNull();
  });

  it('releases a clone whose vat was removed where it stands, or the nearest free spot', () => {
    // The vat is gone from the obstacles: the spot it was held on is free.
    expect(vatStrandedRelease({ x: 0.2, z: 0.1 }, 0, [], ROOM, R)).toEqual({ x: 0.2, z: 0.1 });
    // A peer-written box that overlapped the vat is still there: step out of
    // it to the nearest free spot, never inside it.
    const overlap = box(0, 0, 0.6, 0.6);
    const spot = vatStrandedRelease({ x: 0.2, z: 0.1 }, 0, [overlap], ROOM, R)!;
    const inside =
      spot.x > overlap.x0 - R &&
      spot.x < overlap.x1 + R &&
      spot.z > overlap.z0 - R &&
      spot.z < overlap.z1 + R;
    expect(inside).toBe(false);
    expect(Math.hypot(spot.x - 0.2, spot.z - 0.1)).toBeLessThan(1.5); // nearby
    // Covered but for a strip by the east wall: the whole-room search finds it.
    const cover = { x0: -6, z0: -6, x1: 4.5, z1: 6 };
    const far = vatStrandedRelease({ x: 0, z: 0 }, 0, [cover], ROOM, R)!;
    expect(far.x).toBeGreaterThanOrEqual(cover.x1 + R);
    expect(far.x).toBeLessThanOrEqual(ROOM.boundX);
    // Nowhere free: no spot, so the clone stays held.
    expect(vatStrandedRelease({ x: 0, z: 0 }, 0, [box(0, 0, 6, 6)], ROOM, R)).toBeNull();
  });

  it('only ends a walk-out where the full-size clone clears the vat', () => {
    // Copilot's example: at 1.42 m the full-size ears are still under the
    // transom, so easing back to full size there would cross it.
    expect(vatFullSizeFitsAt(1.42)).toBe(false);
    expect(VAT_MIN_RELEASE_ALONG).toBeGreaterThanOrEqual(VAT_FOOTPRINT_HALF + R);
    expect(VAT_MIN_RELEASE_ALONG).toBeLessThan(VAT_EXIT_ALONG);
    for (let cm = Math.round(VAT_MIN_RELEASE_ALONG * 100); cm <= VAT_EXIT_ALONG * 100; cm++) {
      expect(vatFullSizeFitsAt(cm / 100)).toBe(true);
    }
    // A free stretch that stops just short of the minimum is no end at all…
    const own = box(0, 0, 1, 1);
    const tooClose = { x0: -1, z0: 1.815, x1: 1, z1: 2.5 }; // path free to 1.42
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, tooClose], ROOM, R)).toBeNull();
    // …one just past it is.
    const farEnough = { x0: -1, z0: 1.87, x1: 1, z1: 2.5 }; // path free to 1.47
    const end = vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, farEnough], ROOM, R)!;
    expect(end).toBeGreaterThanOrEqual(VAT_MIN_RELEASE_ALONG);
  });

  it('eases a short exit back to full size without crossing the vat', () => {
    // RELAX lerps from the squeeze at the end to full size in place: every
    // intermediate size must still clear the tank, doorway and transom.
    for (let end = VAT_MIN_RELEASE_ALONG; end <= VAT_EXIT_ALONG + 1e-9; end += 0.05) {
      const from = vatSqueezeAt(end);
      for (let k = 0; k <= 10; k++) {
        const h = from.horizontal + ((1 - from.horizontal) * k) / 10;
        const v = from.vertical + ((1 - from.vertical) * k) / 10;
        for (const slice of AVATAR_SILHOUETTE) {
          for (let j = 0; j <= 4; j++) {
            const q = end + h * (slice.z0 + ((slice.z1 - slice.z0) * j) / 4);
            if (q > VAT_Q_LIP) continue; // out in the room
            const g = vatGaugeAt(q);
            expect(h * slice.halfWidth).toBeLessThanOrEqual(g.halfWidth + EPS);
            expect(v * slice.top).toBeLessThanOrEqual(g.height + EPS);
          }
        }
      }
    }
  });

  it('re-plans from the clone\'s current spot, ignoring what is behind it', () => {
    const own = box(0, 0, 1, 1);
    const behind = { x0: -1, z0: 1.0, x1: 1, z1: 1.2 }; // across the path near the door
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, behind], ROOM, R)).toBeNull();
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, behind], ROOM, R, 1.7)).toBe(VAT_EXIT_ALONG);
    // …and a spot taken right where it stands blocks the rest of the walk.
    const onTop = box(0, 1.7, 0.3, 0.3);
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, onTop], ROOM, R, 1.7)).toBeNull();
  });

  it('scans from where the held clone stands, not the plinth lip', () => {
    // A peer-written 1×1 box centred in the tank is inflated only out to
    // q = 0.88: a scan starting at the lip (0.92) would miss it entirely.
    const own = box(0, 0, 1, 1);
    const inTank = box(0, 0, 0.5, 0.5);
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, inTank], ROOM, R)).toBe(VAT_EXIT_ALONG);
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, inTank], ROOM, R, VAT_HOLD_ALONG)).toBeNull();
  });

  it('skips only the vat\'s own box, not other obstacles overlapping it', () => {
    const own = box(0, 0, 1, 1);
    // Peer-written furniture is untrusted: a box around the vat (or the
    // whole room) must still block the path, not be skipped as "the vat".
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, box(0, 0, 1.2, 1.2)], ROOM, R)).toBeNull();
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own, box(0, 0, 6, 6)], ROOM, R)).toBeNull();
    // …while the vat's own box alone never blocks its own doorway.
    expect(vatFreeExitAlong({ x: 0, z: 0 }, 0, [own], ROOM, R)).toBe(VAT_EXIT_ALONG);
  });

  it('is unobstructed for the default vat in the default lobby', () => {
    const vat = FURNITURE.find((i) => i.id === 'clone-vat')!;
    const boxes = FURNITURE.map((i) => itemAabb(i)).filter((b) => b !== null);
    expect(vatFreeExitAlong(vat.pos, vat.rot * (Math.PI / 2), boxes, ROOM, R)).toBe(VAT_EXIT_ALONG);
  });
});

describe('fresh-clone pallor', () => {
  it('starts fully pale and eases back to full colour over ~30 s', () => {
    expect(VAT_PALLOR_FADE_S).toBe(30);
    expect(vatPallorAt(0)).toBe(1);
    expect(vatPallorAt(VAT_PALLOR_FADE_S / 2)).toBeCloseTo(0.5, 9);
    expect(vatPallorAt(VAT_PALLOR_FADE_S)).toBe(0);
    expect(vatPallorAt(VAT_PALLOR_FADE_S + 5)).toBe(0);
    let prev = 1;
    for (let t = 0; t <= VAT_PALLOR_FADE_S; t += 0.25) {
      const k = vatPallorAt(t);
      expect(k).toBeLessThanOrEqual(prev + EPS);
      expect(prev - k).toBeLessThan(0.02); // slow: no visible step per frame
      prev = k;
    }
  });

  it('blends a colour to the almost-white grey and back exactly', () => {
    const fur = 0xe07a2c; // the fox's orange
    expect(vatPallorHex(fur, 0)).toBe(fur);
    expect(vatPallorHex(fur, 1)).toBe(VAT_PALLOR_HEX);
    // Almost white, but grey: light and near-neutral.
    const r = (VAT_PALLOR_HEX >> 16) & 0xff;
    const g = (VAT_PALLOR_HEX >> 8) & 0xff;
    const b = VAT_PALLOR_HEX & 0xff;
    expect(Math.min(r, g, b)).toBeGreaterThan(0xd0);
    expect(Math.max(r, g, b)).toBeLessThan(0xf5);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0x10);
    // Halfway sits between the two on every channel.
    const mid = vatPallorHex(fur, 0.5);
    for (const shift of [16, 8, 0]) {
      const c = (mid >> shift) & 0xff;
      const lo = Math.min((fur >> shift) & 0xff, (VAT_PALLOR_HEX >> shift) & 0xff);
      const hi = Math.max((fur >> shift) & 0xff, (VAT_PALLOR_HEX >> shift) & 0xff);
      expect(c).toBeGreaterThanOrEqual(lo);
      expect(c).toBeLessThanOrEqual(hi);
    }
  });
});

describe('2×2 clone vat in the default layout', () => {
  const vat = FURNITURE.find((i) => i.id === 'clone-vat')!;

  it('has a 2×2 footprint and sits centred on a lattice 2×2 square', () => {
    expect(FURNITURE_DEFS['clone-vat'].footprint).toEqual({
      w: 2 * VAT_FOOTPRINT_HALF,
      d: 2 * VAT_FOOTPRINT_HALF,
    });
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
