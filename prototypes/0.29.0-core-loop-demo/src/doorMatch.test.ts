/**
 * 🚪🧲 doorMatch — the octagon-closing defects (owner report 2026-09-14):
 * the final vestibule chose the wrong side of the first room, and two
 * vestibules ended up on one door. Both halves are pinned here: the CONNECT
 * matcher (pickFacingDoor / candidateFarDoors) and the arrival chooser.
 */
import { describe, expect, it } from 'vitest';
import {
  WALL_YAW,
  angDiff,
  candidateFarDoors,
  chooseArrivalDoor,
  doorFaceWorld,
  pickFacingDoor,
  type ArrivalDoor,
  type FarDoorCandidate,
  type ModulePose,
} from './doorMatch';
import type { DoorWall } from './doorLayoutDoc';

/** A chain that ends exactly at `mod`'s `wall` face, pointing straight in,
 *  then perturbed: `offDeg` of heading error and `offM` metres of face error
 *  slid along the wall — the shape of accumulated ring-layout error. */
function arrivalAt(mod: ModulePose, wall: DoorWall, offDeg = 0, offM = 0) {
  const face = doorFaceWorld(mod, wall, 0);
  const along = face.outwardYaw + Math.PI / 2; // tangent of the wall
  return {
    x: face.x + Math.sin(along) * offM,
    z: face.z + Math.cos(along) * offM,
    heading: face.outwardYaw + Math.PI + (offDeg * Math.PI) / 180,
  };
}

const D = (id: string, wall: DoorWall, lateral = 0, extra: Partial<FarDoorCandidate> = {}): FarDoorCandidate =>
  ({ id, wall, lateral, ...extra });

describe('pickFacingDoor — closing the octagon', () => {
  // Room 1 as the ring composes it after seven hops: a diamond module.
  const room1: ModulePose = { x: 30, z: -8, rotY: Math.PI / 4 };

  it('takes the free facing wall, not the occupied adjacent wall, even with 40° of layout error', () => {
    // Room 2's vestibule already lands on the x- wall; the closing link should
    // land on y+, the adjacent wall (90° apart — the ring turns 45° per module).
    const candidates = [D('west', 'x-', 0, { occupied: true }), D('south', 'y+'), D('north', 'y-'), D('east', 'x+')];
    // Angle-only, 40° of error toward x- made x- (50° off) and y+ (40° off)
    // both admissible, and a little more error flipped the pick. Position
    // cannot be fooled that way: the faces are 8.5 m apart.
    const pick = pickFacingDoor(room1, candidates, arrivalAt(room1, 'y+', 40, 0.8));
    expect(pick?.door.id).toBe('south');
    expect(pick?.posErr).toBeLessThan(1);
    expect(pick?.blockedBetter).toBeUndefined();
  });

  it('never returns an occupied door, and reports when one fit better', () => {
    const candidates = [D('west', 'x-', 0, { occupied: true }), D('south', 'y+'), D('east', 'x+')];
    // The chain is aimed squarely at the OCCUPIED x- door.
    const pick = pickFacingDoor(room1, candidates, arrivalAt(room1, 'x-'));
    expect(pick).toBeNull(); // nothing free within reach
    // …and with a free door within tolerance, that one wins but the refusal is explained.
    const near = [...candidates, D('d:free', 'x-', 4)];
    const pick2 = pickFacingDoor(room1, near, arrivalAt(room1, 'x-'));
    expect(pick2?.door.id).toBe('d:free');
    expect(pick2?.blockedBetter?.id).toBe('west');
  });

  it('refuses a chain that would enter a face sideways', () => {
    const candidates = [D('south', 'y+')];
    const pick = pickFacingDoor(room1, candidates, arrivalAt(room1, 'y+', 75));
    expect(pick).toBeNull();
  });

  it('prefers the real door at its lateral over the wall-centre hypothetical', () => {
    const candidates = [D('d:abc', 'y+', 3), D('south', 'y+', 0, { hypothetical: true })];
    const face = doorFaceWorld(room1, 'y+', 3);
    const pick = pickFacingDoor(room1, candidates, {
      x: face.x, z: face.z, heading: face.outwardYaw + Math.PI,
    });
    expect(pick?.door.id).toBe('d:abc');
  });

  it('agrees with the face geometry convention (yaw θ points along (sin θ, cos θ))', () => {
    const mod: ModulePose = { x: 0, z: 0, rotY: 0 };
    expect(doorFaceWorld(mod, 'y+', 0)).toMatchObject({ x: 0, z: 6, outwardYaw: WALL_YAW['y+'] });
    expect(doorFaceWorld(mod, 'x-', 2).x).toBeCloseTo(-6);
    expect(doorFaceWorld(mod, 'x-', 2).z).toBeCloseTo(2);
    const turned: ModulePose = { x: 0, z: 0, rotY: Math.PI / 2 };
    // Rotating by +90° carries the +z face onto +x.
    expect(doorFaceWorld(turned, 'y+', 0).x).toBeCloseTo(6);
    expect(doorFaceWorld(turned, 'y+', 0).z).toBeCloseTo(0);
    expect(angDiff(Math.PI - 0.1, -Math.PI + 0.1)).toBeCloseTo(0.2);
  });
});

describe('candidateFarDoors — one vestibule per door', () => {
  it('keeps occupied doors (flagged) and offers no hypothetical on a wall centre a known door sits near', () => {
    const out = candidateFarDoors([
      { id: 'd:a', wall: 'x-', lateral: 0, occupied: true },
      { id: 'd:b', wall: 'y+', lateral: 5, occupied: true }, // far end of the wall: centre still open
      { id: 'd:c', occupied: false }, // no geometry: cannot be placed, contributes nothing
    ]);
    const ids = out.map((d) => d.id);
    expect(ids).toContain('d:a');
    expect(out.find((d) => d.id === 'd:a')?.occupied).toBe(true);
    expect(ids).not.toContain('west'); // x- centre is taken
    expect(ids).toContain('south'); // y+ centre is 5 m from d:b — allowed
    expect(ids).toContain('north');
    expect(ids).toContain('east');
    expect(ids).not.toContain('d:c');
  });

  it('a cardinal berth living off its legacy wall does not collide with the hypothetical id', () => {
    const out = candidateFarDoors([{ id: 'west', wall: 'y-', lateral: 0, occupied: true }]);
    const westWall = out.find((d) => d.wall === 'x-');
    expect(westWall?.hypothetical).toBe(true);
    expect(westWall?.id).toBe('west@centre');
  });
});

describe('chooseArrivalDoor — the traveler comes in through the right door', () => {
  const door = (id: string, wall: DoorWall, pairedTo: string | null, lateral = 0, enabled = true): ArrivalDoor =>
    ({ id, wall, lateral, enabled, cardinal: ['north', 'south', 'east', 'west'].includes(id), pairedTo });

  it('the record\'s WALL beats a stale compass id that this room hangs elsewhere', () => {
    // Room 1: id "west" sits on the y- wall (pairs layout) and is paired to
    // room 2; the closing record from room 8 says farDoor "west", farWall x-.
    const doors = [door('west', 'y-', 'room-2'), door('d:ring', 'x-', null), door('south', 'y+', null)];
    const pick = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8',
      farDoor: 'west', farWall: 'x-', farLateral: 0,
    });
    expect(pick).toMatchObject({ id: 'd:ring', tier: 'far-wall', conflict: false });
  });

  it('never lands on a door paired to a DIFFERENT room while a free door exists', () => {
    const doors = [door('west', 'x-', 'room-2'), door('south', 'y+', null), door('east', 'x+', null)];
    // farDoor names the occupied door and no wall is known.
    const pick = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8', farDoor: 'west',
    });
    expect(pick?.id).not.toBe('west');
    expect(pick?.conflict).toBe(false);
  });

  it('the arrival room\'s own back-pointing record is the highest truth', () => {
    const doors = [door('west', 'x-', 'room-8'), door('south', 'y+', null)];
    const pick = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8',
      farDoor: 'south', farWall: 'y+',
    });
    expect(pick).toMatchObject({ id: 'west', tier: 'back' });
  });

  it('a door paired to the room we came from is free for us', () => {
    const doors = [door('west', 'x-', 'room-8')];
    const pick = chooseArrivalDoor(doors, { departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8' });
    expect(pick?.id).toBe('west');
  });

  it('with an unknown origin, paired doors are not treated as occupied (legacy behaviour)', () => {
    const doors = [door('west', 'x-', 'room-2')];
    const pick = chooseArrivalDoor(doors, { departureDoorId: 'east', departureWall: 'x+' });
    expect(pick).toMatchObject({ id: 'west', conflict: false });
  });

  it('nearest lateral on the far wall, cardinal breaking ties', () => {
    const doors = [door('d:far', 'x-', null, 4), door('d:near', 'x-', null, -1), door('west', 'x-', null, 0)];
    const pick = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'r', farWall: 'x-', farLateral: -0.8,
    });
    expect(pick?.id).toBe('d:near');
    // Dead heat (both 0.5 m off): the cardinal wins, never map order.
    const tie = chooseArrivalDoor(doors.slice(1), {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'r', farWall: 'x-', farLateral: -0.5,
    });
    expect(tie?.id).toBe('west');
  });

  it('falls through facing-wall and id-opposite when the record says nothing', () => {
    const doors = [door('west', 'x-', 'room-2'), door('d:x', 'x-', null), door('south', 'y+', null)];
    expect(chooseArrivalDoor(doors, { departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'r' }))
      .toMatchObject({ id: 'd:x', tier: 'facing-wall' });
    const noFacing = [door('north', 'y-', null), door('south', 'y+', null)];
    expect(chooseArrivalDoor(noFacing, { departureDoorId: 'north', departureWall: 'x-', fromRoomId: 'r' }))
      .toMatchObject({ id: 'south', tier: 'id-opposite' });
  });

  it('when every door is taken, still answers — and says it is a conflict', () => {
    const doors = [door('west', 'x-', 'room-2'), door('east', 'x+', 'room-3')];
    const pick = chooseArrivalDoor(doors, { departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8' });
    expect(pick).toMatchObject({ id: 'east', tier: 'fallback', conflict: true });
    expect(chooseArrivalDoor([], { departureDoorId: 'east' })).toBeNull();
  });

  it('a disabled door is never chosen while an enabled one exists', () => {
    const doors = [door('north', 'y-', null, 0, false), door('south', 'y+', null)];
    const pick = chooseArrivalDoor(doors, { departureDoorId: 'south', departureWall: 'y+', fromRoomId: 'r' });
    expect(pick?.id).toBe('south');
  });
});
