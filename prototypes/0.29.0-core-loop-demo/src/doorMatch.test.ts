/**
 * 🚪🧲 doorMatch — the octagon-closing defects (owner report 2026-09-14):
 * the final vestibule chose the wrong side of the first room, and two
 * vestibules ended up on one door. Both halves are pinned here: the CONNECT
 * matcher (pickFacingDoor / candidateFarDoors) and the arrival chooser.
 */
import { describe, expect, it } from 'vitest';
import {
  CROSSING_BAND,
  WALL_YAW,
  angDiff,
  candidateFarDoors,
  chooseArrivalDoor,
  doorBeingCrossed,
  doorFaceWorld,
  pickFacingDoor,
  type ArrivalDoor,
  type CrossingDoor,
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
    // A shape doorsDoc.isAcceptableDoorKey admits, so the id survives the wire
    // as the published farDoor instead of being stripped on the next read.
    expect(westWall?.id).toBe('d:west-centre');
    expect(westWall?.id.startsWith('d:')).toBe(true);
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

  it('the arrival room\'s own back-pointing record outranks the record\'s id, and its wall when they agree', () => {
    const doors = [door('west', 'x-', 'room-8'), door('south', 'y+', null)];
    // A stale id naming another door never overrides the back record…
    const byId = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8', farDoor: 'south',
    });
    expect(byId).toMatchObject({ id: 'west', tier: 'back' });
    // …and a wall that agrees with it confirms it.
    const byWall = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8', farDoor: 'south', farWall: 'x-',
    });
    expect(byWall).toMatchObject({ id: 'west', tier: 'back' });
    // (A wall that DISAGREES, with a free door on it, means a second link
    // between the same rooms — covered by its own case above.)
  });

  it('a lone back record is not this connection\'s when the record\'s wall says otherwise', () => {
    // Rooms A and B already linked once (B's "west" on x- points back at A);
    // a SECOND link from A arrives whose record names wall y+, mirror not yet
    // written. The lone back door belongs to the first link.
    const doors = [door('west', 'x-', 'room-a'), door('d:two', 'y+', null), door('east', 'x+', null)];
    const second = chooseArrivalDoor(doors, {
      departureDoorId: 'd:a2', departureWall: 'y-', fromRoomId: 'room-a', farWall: 'y+',
    });
    expect(second).toMatchObject({ id: 'd:two', tier: 'far-wall' });
    // Wall agrees (or is unknown): the back record is the connection.
    const first = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-a', farWall: 'x-',
    });
    expect(first).toMatchObject({ id: 'west', tier: 'back' });
    const unknown = chooseArrivalDoor(doors, { departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-a' });
    expect(unknown).toMatchObject({ id: 'west', tier: 'back' });
    // No free door on the named wall: the back record still answers.
    const noFree = chooseArrivalDoor([door('west', 'x-', 'room-a'), door('south', 'y+', 'room-c')], {
      departureDoorId: 'd:a2', departureWall: 'y-', fromRoomId: 'room-a', farWall: 'y+',
    });
    // …flagged: it is another link's door, so no repair may be recorded onto it.
    expect(noFree).toMatchObject({ id: 'west', tier: 'back', conflict: true });
  });

  it('another link\'s back door is never reused while any door is unpaired', () => {
    // The record's wall (y+) has no door at all; the unpaired east door is
    // the honest answer, not the back door that belongs to the first link.
    const doors = [door('west', 'x-', 'room-a'), door('east', 'x+', null)];
    const pick = chooseArrivalDoor(doors, {
      departureDoorId: 'd:a2', departureWall: 'y-', fromRoomId: 'room-a', farWall: 'y+',
    });
    expect(pick).toMatchObject({ id: 'east', conflict: false });
    expect(pick?.tier).not.toBe('back');
  });

  it('same wall, different lateral: the back door 6 m along is another link, not this one', () => {
    // A↔B already uses x- at −3; a second A→B link aims at x- +3 (free).
    const doors = [door('d:m', 'x-', 'room-a', -3), door('d:n', 'x-', null, 3)];
    const second = chooseArrivalDoor(doors, {
      departureDoorId: 'd:a2', departureWall: 'x+', fromRoomId: 'room-a', farWall: 'x-', farLateral: 3,
    });
    expect(second).toMatchObject({ id: 'd:n', tier: 'far-wall' });
    const first = chooseArrivalDoor(doors, {
      departureDoorId: 'd:a1', departureWall: 'x+', fromRoomId: 'room-a', farWall: 'x-', farLateral: -3,
    });
    expect(first).toMatchObject({ id: 'd:m', tier: 'back' });
  });

  it('a back record whose COUNTERPART geometry is not our departure door is another link', () => {
    // B's x-/−3 record points back at A, and says A's side is on y+ — but we
    // left A through x+ (captured exactly). Our record's wall and lateral
    // alone would not tell the two apart (both x-, 0 m apart).
    const back: ArrivalDoor = { ...door('d:m', 'x-', 'room-a', -3), pairedFarWall: 'y+' };
    const doors = [back, door('d:n', 'x-', null, -3)];
    const pick = chooseArrivalDoor(doors, {
      departureDoorId: 'd:a2', departureWall: 'x+', departureLateral: 0, fromRoomId: 'room-a',
      farWall: 'x-', farLateral: -3,
    });
    expect(pick).toMatchObject({ id: 'd:n', tier: 'far-wall' });
    // Counterpart on our wall but 6 m along it: also another door of ours.
    const far: ArrivalDoor = { ...back, pairedFarWall: 'x+', pairedFarLateral: 6 };
    expect(chooseArrivalDoor([far, doors[1]], {
      departureDoorId: 'd:a2', departureWall: 'x+', departureLateral: 0, fromRoomId: 'room-a',
      farWall: 'x-', farLateral: -3,
    })?.id).toBe('d:n');
    // Counterpart matching our departure door: it is this link.
    const same: ArrivalDoor = { ...back, pairedFarWall: 'x+', pairedFarLateral: 0 };
    expect(chooseArrivalDoor([same, doors[1]], {
      departureDoorId: 'd:a2', departureWall: 'x+', departureLateral: 0, fromRoomId: 'room-a',
      farWall: 'x-', farLateral: -3,
    })).toMatchObject({ id: 'd:m', tier: 'back' });
  });

  it('counterpart ids tell links apart only when both are minted d: names', () => {
    const byOther: ArrivalDoor = { ...door('d:m', 'x-', 'room-a'), pairedFarDoor: 'd:other' };
    const open = door('d:n', 'x-', null, 4);
    expect(chooseArrivalDoor([byOther, open], {
      departureDoorId: 'd:mine', departureWall: 'x+', fromRoomId: 'room-a', farWall: 'x-',
    })).toMatchObject({ id: 'd:n', tier: 'far-wall' });
    // A compass name may be a hypothetical's guess: no evidence against.
    const byCompass: ArrivalDoor = { ...door('d:m', 'x-', 'room-a'), pairedFarDoor: 'west' };
    expect(chooseArrivalDoor([byCompass, open], {
      departureDoorId: 'd:mine', departureWall: 'x+', fromRoomId: 'room-a', farWall: 'x-',
    })).toMatchObject({ id: 'd:m', tier: 'back' });
  });

  it('two back records and a THIRD link arriving: a free door on the record\'s wall, not an occupied back door', () => {
    const doors = [door('west', 'x-', 'room-a'), door('east', 'x+', 'room-a'), door('d:three', 'y+', null)];
    const third = chooseArrivalDoor(doors, {
      departureDoorId: 'd:a3', departureWall: 'y-', fromRoomId: 'room-a', farWall: 'y+',
    });
    expect(third).toMatchObject({ id: 'd:three', tier: 'far-wall' });
    // No free door on that wall either: a back record still answers.
    const stuck = chooseArrivalDoor(doors.slice(0, 2), {
      departureDoorId: 'd:a3', departureWall: 'y-', fromRoomId: 'room-a', farWall: 'y+',
    });
    expect(stuck).toMatchObject({ tier: 'back', conflict: true });
  });

  it('double-docked rooms: the tie breaks on the record\'s WALL before its (possibly stale) id', () => {
    // Both back-pointing doors lead to room 8; the record says farDoor "west"
    // (a compass guess) but farWall x- — and this room's "west" sits on y-.
    const doors = [door('west', 'y-', 'room-8'), door('d:x', 'x-', 'room-8')];
    const pick = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8',
      farDoor: 'west', farWall: 'x-', farLateral: 0,
    });
    expect(pick).toMatchObject({ id: 'd:x', tier: 'back' });
    // With no wall on the record the id still breaks the tie, as before.
    const byId = chooseArrivalDoor(doors, {
      departureDoorId: 'east', departureWall: 'x+', fromRoomId: 'room-8', farDoor: 'west',
    });
    expect(byId?.id).toBe('west');
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


/**
 * 🚶🚪 #182 — "walk through a door in first person and you can sometimes be
 * placed in the wrong room that doesn't match the station's atlas", and
 * (dorkmo) "phantom doors along walls that dont actually have doors visible.
 * you can walk into a wall with no door and then be taken to another room."
 *
 * One root cause: the crossing test measured depth into the wall as an
 * UNSIGNED distance from the room centre, so every door also answered for its
 * mirror on the opposite wall. These pin both reported symptoms against the
 * real default-room geometry.
 */
describe('🚶 the door the walker is pressed into (#182)', () => {
  // The default room: 2×2 tiles ⇒ half-extents 6 m, walkable to ±5.5
  // (floorPlanDoc.WALL_CLEARANCE), stand points 1.5 m inside the wall
  // (doorLayout.FRONT_INSET), 2 m opening (doorLayout.DOOR_OPENING_WIDTH).
  const BOUNDS = { boundX: 5.5, boundZ: 5.5 };
  const OPENING = 2;

  /** A door on `wall`, `lateral` metres along it from centre. */
  function doorOn(id: string, wall: DoorWall, lateral = 0): CrossingDoor {
    const front =
      wall === 'y-' ? { x: lateral, z: -4.5 }
      : wall === 'y+' ? { x: lateral, z: 4.5 }
      : wall === 'x-' ? { x: -4.5, z: lateral }
      : { x: 4.5, z: lateral };
    return { id, wall, front };
  }

  /** The four cardinals, in the order the live DOORS array holds them. */
  const ROOM: CrossingDoor[] = [
    doorOn('north', 'y-'),
    doorOn('south', 'y+'),
    doorOn('west', 'x-'),
    doorOn('east', 'x+'),
  ];

  const crossing = (doors: CrossingDoor[], x: number, z: number): string | null =>
    doorBeingCrossed(doors, { x, z }, BOUNDS, OPENING)?.id ?? null;

  it('answers for the doorway the body is actually in, on all four walls', () => {
    expect(crossing(ROOM, 0, -5.5)).toBe('north');
    expect(crossing(ROOM, 0, 5.5)).toBe('south');
    expect(crossing(ROOM, -5.5, 0)).toBe('west');
    expect(crossing(ROOM, 5.5, 0)).toBe('east');
  });

  it('does not send an EAST crossing through the west door (the #182 report)', () => {
    // Both sit at lateral 0, so the unsigned test matched west as well — and
    // west is earlier in DOORS, so it transited first and the walker arrived
    // in the WEST neighbour. Walking west worked, which is why the owner saw
    // it only "sometimes".
    const pick = doorBeingCrossed(ROOM, { x: 5.5, z: 0 }, BOUNDS, OPENING);
    expect(pick?.id).toBe('east');
    expect(pick?.wall).toBe('x+');
    // …and the mirror case stays correct rather than flipping the other way.
    expect(crossing(ROOM, -5.5, 0)).toBe('west');
  });

  it('does not send a SOUTH crossing through the north door', () => {
    expect(crossing(ROOM, 0, 5.5)).toBe('south');
    expect(crossing(ROOM, 0, -5.5)).toBe('north');
  });

  it('grows no phantom door on the wall facing a real one (dorkmo)', () => {
    // A room with exactly ONE door. The facing wall is blank — the avatar can
    // press into it, and nothing may happen.
    for (const [wall, blankX, blankZ] of [
      ['y-', 0, 5.5],
      ['y+', 0, -5.5],
      ['x-', 5.5, 0],
      ['x+', -5.5, 0],
    ] as Array<[DoorWall, number, number]>) {
      const solo = [doorOn('d:solo', wall)];
      expect(crossing(solo, blankX, blankZ)).toBeNull();
      // The door itself still works, so this is not simply "nothing matches".
      const own = doorOn('d:solo', wall).front;
      const ownX = wall === 'x-' ? -5.5 : wall === 'x+' ? 5.5 : own.x;
      const ownZ = wall === 'y-' ? -5.5 : wall === 'y+' ? 5.5 : own.z;
      expect(crossing(solo, ownX, ownZ)).toBe('d:solo');
    }
  });

  it('grows no phantom door at a mirrored OFF-CENTRE position either', () => {
    // A free door slid 3 m along the north wall used to arm the same spot on
    // the south wall.
    const solo = [doorOn('d:free', 'y-', 3)];
    expect(crossing(solo, 3, -5.5)).toBe('d:free');
    expect(crossing(solo, 3, 5.5)).toBeNull();
  });

  it('is not tripped by walking ALONG the wall past a door', () => {
    // Pressed to the wall but beyond the opening's half-width.
    expect(crossing(ROOM, 5.5, 1.2)).toBeNull();
    expect(crossing(ROOM, 1.2, 5.5)).toBeNull();
    // The opening's edge is exclusive: half a width out is already wall.
    expect(crossing(ROOM, 5.5, OPENING / 2)).toBeNull();
    expect(crossing(ROOM, 5.5, OPENING / 2 - 0.001)).toBe('east');
  });

  it('is not tripped by ordinary floor short of the wall', () => {
    // The band is the last few centimetres of travel, not a strip of room.
    expect(crossing(ROOM, BOUNDS.boundX - CROSSING_BAND, 0)).toBeNull();
    expect(crossing(ROOM, BOUNDS.boundX - 0.35, 0)).toBeNull();
    expect(crossing(ROOM, BOUNDS.boundX - CROSSING_BAND + 0.01, 0)).toBe('east');
  });

  it('picks the NEARER door where two bands meet at a corner, not the first', () => {
    // MIN_DOOR_GAP keeps two doors on ONE wall 4 m apart, so their bands can
    // never overlap — but it says nothing across a corner. Array order
    // deciding that is exactly how #182 read.
    const corner: CrossingDoor[] = [
      doorOn('on-x', 'x-', -5),
      doorOn('on-y', 'y-', -5),
    ];
    // Deeper into the y- wall ⇒ the y- door, although it is second.
    expect(crossing(corner, -5.5, -5.46)).toBe('on-y');
    // Deeper into the x- wall ⇒ the x- door.
    expect(crossing(corner, -5.46, -5.5)).toBe('on-x');
    // Reversing the array changes nothing.
    expect(crossing([...corner].reverse(), -5.5, -5.46)).toBe('on-y');
    expect(crossing([...corner].reverse(), -5.46, -5.5)).toBe('on-x');
  });

  it('knows nothing of pairing or enablement — that is the caller\'s gate', () => {
    // North is the fireplace-blocked door: never walkable. It is still
    // reported, which is what keeps world.ts honest about re-arming the
    // transit latch only once the body steps clear of EVERY doorway.
    expect(crossing(ROOM, 0, -5.5)).toBe('north');
  });

  it('scales with the room, taking its bounds from the caller', () => {
    // A 4×4 room: half-extents 12, walkable to ±11.5. The stand point stays
    // 1.5 m inside the wall, so only the bound moves.
    const big: CrossingDoor[] = [{ id: 'e', wall: 'x+', front: { x: 10.5, z: 0 } }];
    const bounds = { boundX: 11.5, boundZ: 11.5 };
    expect(doorBeingCrossed(big, { x: 11.5, z: 0 }, bounds, OPENING)?.id).toBe('e');
    // The DEFAULT room's threshold is now ordinary floor, not a crossing.
    expect(doorBeingCrossed(big, { x: 5.5, z: 0 }, bounds, OPENING)).toBeNull();
    // …and the far wall is still blank.
    expect(doorBeingCrossed(big, { x: -11.5, z: 0 }, bounds, OPENING)).toBeNull();
  });

  it('returns null for a doorless room', () => {
    expect(crossing([], 5.5, 0)).toBeNull();
    expect(crossing([], 0, 0)).toBeNull();
  });
});
