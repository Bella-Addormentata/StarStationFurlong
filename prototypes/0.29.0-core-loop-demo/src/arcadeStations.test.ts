/**
 * 🕹🕹🕹🕹 The double-wide cabinet's stations: the one a player clicks, or
 * has walked up to, is their seat (and so their player number).
 */
import { describe, expect, it } from 'vitest';
import type { StandSlot } from './furniture';
import { WIDE_STAND_AT_M, wideClick, wideStationFor } from './arcadeStations';

/** The four stands a pace in front of a cabinet at the origin, 0.4 m apart. */
const stands: StandSlot[] = [0, 1, 2, 3].map((n) => ({
  id: `wide-1:s${n}`,
  front: { x: (n - 1.5) * 0.4, z: 1.05 },
  faceAngle: Math.PI,
}));
const seat = (s: StandSlot | null) => (s ? Number(s.id.slice(s.id.lastIndexOf(':s') + 2)) : null);
const station = (n: number) => ({ userData: { arcadeStation: n } });
const screen = { userData: {} };

describe('wideClick', () => {
  it("names the station whose part was clicked, and none for the screens", () => {
    expect(wideClick({ x: 0.1, z: 0.3 }, station(2))).toEqual({ x: 0.1, z: 0.3, station: 2 });
    expect(wideClick({ x: 0.1, z: 0.3 }, station(0)).station).toBe(0);
    expect(wideClick({ x: 0.1, z: 0.2 }, screen).station).toBeNull();
  });
});

describe('wideStationFor', () => {
  it("picks the station clicked, wherever the player is", () => {
    const far = { x: -3, z: 4 };
    // Player 4's stick, from far off on the left.
    expect(seat(wideStationFor(stands, stands, far, wideClick({ x: 0.52, z: 0.3 }, station(3))))).toBe(3);
    // Player 2's buttons, while standing at player 1's station.
    expect(seat(wideStationFor(stands, stands, stands[0]!.front, wideClick({ x: -0.16, z: 0.31 }, station(1))))).toBe(1);
    // Player 3's coin door.
    expect(seat(wideStationFor(stands, stands, far, wideClick({ x: 0.2, z: 0.5 }, station(2))))).toBe(2);
  });

  it("picks the station clicked even when its stand was moved to be walkable", () => {
    // Something set down in front of player 2's station pushed its stand out
    // past player 1's: clicking player 2's stick is still player 2.
    const moved = stands.map((s, n) => (n === 1 ? { ...s, front: { x: -0.75, z: 1.5 } } : s));
    expect(seat(wideStationFor(moved, moved, { x: 0, z: 3 }, wideClick({ x: -0.28, z: 0.3 }, station(1))))).toBe(1);
  });

  it('keeps the station the player walked up to when they click the screens', () => {
    for (const n of [0, 1, 2, 3]) {
      const me = { x: stands[n]!.front.x + 0.05, z: stands[n]!.front.z + 0.1 };
      // The screens' far end from this station.
      const click = wideClick({ x: n < 2 ? 0.6 : -0.6, z: 0.2 }, screen);
      expect(seat(wideStationFor(stands, stands, me, click))).toBe(n);
    }
  });

  it('picks the station below the click on the screens from further off', () => {
    const me = { x: -2, z: 3 };
    expect(Math.hypot(me.x - stands[0]!.front.x, me.z - stands[0]!.front.z)).toBeGreaterThan(WIDE_STAND_AT_M);
    expect(seat(wideStationFor(stands, stands, me, wideClick({ x: 0.25, z: 0.2 }, screen)))).toBe(2);
  });

  it('with no click, picks the station nearest the player', () => {
    expect(seat(wideStationFor(stands, stands, { x: 0.7, z: 2 }))).toBe(3);
    expect(seat(wideStationFor(stands, stands, { x: -0.5, z: 1.2 }))).toBe(0);
  });

  it('only ever picks a free station: a taken one clicked gives the free one nearest it', () => {
    const free = [stands[0]!, stands[1]!, stands[3]!]; // player 3 is taken
    expect(seat(wideStationFor(stands, free, { x: 0, z: 3 }, wideClick({ x: 0.18, z: 0.3 }, station(2))))).toBe(1);
    // Walked up to the taken station and clicked the screens: the free one
    // nearest the click, either side.
    expect(seat(wideStationFor(stands, free, stands[2]!.front, wideClick({ x: 0.55, z: 0.2 }, screen)))).toBe(3);
    expect(seat(wideStationFor(stands, free, stands[2]!.front, wideClick({ x: -0.15, z: 0.2 }, screen)))).toBe(1);
    // With no click, the free one nearest them.
    expect(seat(wideStationFor(stands, free, { x: 0.25, z: 1.05 }))).toBe(3);
    expect(wideStationFor(stands, [], { x: 0, z: 1 }, wideClick({ x: 0, z: 0.3 }, station(1)))).toBeNull();
    expect(wideStationFor(stands, [], { x: 0, z: 1 })).toBeNull();
  });
});
