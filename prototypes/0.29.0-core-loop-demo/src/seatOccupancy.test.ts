/**
 * 🪑 One person per seat — seatOccupancy.ts.
 *
 * Nothing used to stop two players being routed into the same chair. These
 * cases run against the real seat lists (built from real furniture, the way
 * the app builds them), because the claim is read off the same SEATS every
 * client derives from the synced furniture doc:
 *
 *  1. seatClaimedBy — a seated peer's tick names its seat, settled on it or
 *     still sliding in, and never names open water;
 *  2. freeSeatFor — a click on a taken seat goes to a free spot on the same
 *     piece, or nowhere when the piece is full;
 *  3. keepsSeat — when two players sat down at once, the two games never
 *     BOTH keep the seat.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { bindFloorPlan } from './floorPlanDoc';
import { bindDoorLayoutDoc } from './doorLayoutDoc';
import { FURNITURE, OUTDOOR_FURNITURE, type FurnitureItem } from './furniture';
import { rebuildObstacles } from './obstacles';
import { rebakeWalkableGrid } from './pathfinding';
import { SEATS, findSeatAt, rebuildSeats, type Seat } from './seats';
import { freeSeatFor, keepsSeat, seatClaimedBy, type SeatedPeer } from './seatOccupancy';

const ORIGINAL_FURNITURE = [...FURNITURE];

/** Swap the room the way the app does: obstacles → grid → seats. */
const loadRoom = (items: readonly FurnitureItem[]): void => {
  FURNITURE.splice(0, FURNITURE.length, ...items.map((i) => ({ ...i, pos: { ...i.pos } })));
  rebuildObstacles();
  rebakeWalkableGrid();
  rebuildSeats();
};

const ofItem = (itemId: string): Seat[] => SEATS.filter((s) => s.id.startsWith(`${itemId}:`));

/** The tick a peer settled on `s` sends: its sit point and its facing,
 *  wrapped into [0, 2π) the way the u16 yaw arrives. */
const settledOn = (s: Seat): SeatedPeer => ({
  x: s.sit.x,
  z: s.sit.z,
  facing: ((s.faceAngle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
  elevated: s.sitY > 0.8,
});

/** The tick a peer sends `t` of the way through its slide onto `s`. */
const slidingOnto = (s: Seat, t: number): SeatedPeer => {
  const from = s.path && s.path.length > 0 ? s.path[s.path.length - 1] : s.front;
  return {
    ...settledOn(s),
    x: from.x + (s.sit.x - from.x) * t,
    z: from.z + (s.sit.z - from.z) * t,
  };
};

beforeAll(() => {
  bindFloorPlan(new Y.Doc());
  bindDoorLayoutDoc(new Y.Doc());
});

afterAll(() => loadRoom(ORIGINAL_FURNITURE));

describe('seatClaimedBy — which seat a seated peer is in', () => {
  beforeAll(() => loadRoom(OUTDOOR_FURNITURE));

  it('names the seat a peer has settled on', () => {
    for (const s of ofItem('pool-hot-tub')) {
      expect(seatClaimedBy(SEATS, settledOn(s))?.id).toBe(s.id);
    }
  });

  it('names it from the first frame of the slide, not only once settled', () => {
    // The seated flag is up for the whole slide; a claim that only counted
    // at the sit point would leave the seat looking empty for that long.
    const lounger = SEATS.find((s) => s.lie && s.id.startsWith('pool-main:'))!;
    for (const t of [0.05, 0.3, 0.6, 0.9]) {
      expect(seatClaimedBy(SEATS, slidingOnto(lounger, t))?.id).toBe(lounger.id);
    }
  });

  it('follows the hop into the island tub from the bridge crest', () => {
    const sw = findSeatAt(-0.2, 2.6)!; // the spot the bridge lands at
    expect(sw.path?.length).toBeGreaterThan(0);
    expect(seatClaimedBy(SEATS, slidingOnto(sw, 0.4))?.id).toBe(sw.id);
  });

  it('does not mistake a slide for a seat it is not facing', () => {
    const lounger = SEATS.find((s) => s.lie && s.id.startsWith('pool-main:'))!;
    const peer = slidingOnto(lounger, 0.3);
    expect(seatClaimedBy(SEATS, { ...peer, facing: peer.facing + 1 })).toBeNull();
  });

  it('names nobody while two slides from one shared front cannot be told apart', () => {
    // Two seats facing the same way, approached from the same point (the
    // walkable fallback can hand neighbours one front cell). At the start of
    // the slide the peer is on both; by the end only one.
    const base = SEATS.find((s) => s.lie && s.id.startsWith('pool-main:'))!;
    const a: Seat = { ...base, id: 'pair:0', front: { x: 0, z: 0 }, sit: { x: -0.6, z: -0.8 } };
    const b: Seat = { ...base, id: 'pair:1', front: { x: 0, z: 0 }, sit: { x: 0.6, z: -0.8 } };
    expect(seatClaimedBy([a, b], slidingOnto(a, 0.05))).toBeNull();
    expect(seatClaimedBy([a, b], slidingOnto(a, 0.7))?.id).toBe('pair:0');
    expect(seatClaimedBy([a, b], slidingOnto(b, 0.7))?.id).toBe('pair:1');
  });

  it('never claims open water — any number of swimmers share the pool', () => {
    const water = SEATS.find((s) => s.swim)!;
    expect(seatClaimedBy(SEATS, settledOn(water))).toBeNull();
  });
});

describe('seatClaimedBy — stacked bunks share a sit point', () => {
  beforeAll(() =>
    loadRoom([{ id: 'bunk', kind: 'bunk-bed', pos: { x: 0, z: 0 }, rot: 0, movable: true }]),
  );

  it('tells the top berth from the bottom by the elevated bit', () => {
    const [a, b] = ofItem('bunk');
    const top = a.sitY > b.sitY ? a : b;
    const bottom = top === a ? b : a;
    expect(seatClaimedBy(SEATS, settledOn(top))?.id).toBe(top.id);
    expect(seatClaimedBy(SEATS, settledOn(bottom))?.id).toBe(bottom.id);
  });

  it('offers the other berth when one is taken, and nothing when both are', () => {
    const [a, b] = ofItem('bunk');
    expect(freeSeatFor(SEATS, a, new Set([a.id]))?.id).toBe(b.id);
    expect(freeSeatFor(SEATS, a, new Set([a.id, b.id]))).toBeNull();
  });
});

describe('freeSeatFor — where a click on a taken seat goes', () => {
  beforeAll(() => loadRoom(OUTDOOR_FURNITURE));

  it('sends a click on a free seat to that seat', () => {
    const s = ofItem('pool-hot-tub')[0];
    expect(freeSeatFor(SEATS, s, new Set())).toBe(s);
    expect(freeSeatFor(SEATS, s, new Set(['some-other:0']))).toBe(s);
  });

  it('sends a click on a taken hot-tub spot to another free spot', () => {
    const tub = ofItem('pool-hot-tub');
    const taken = new Set([tub[2].id]);
    const got = freeSeatFor(SEATS, tub[2], taken)!;
    expect(got).not.toBeNull();
    expect(got.id).not.toBe(tub[2].id);
    expect(got.id.startsWith('pool-hot-tub:')).toBe(true);
  });

  it('fills the tub one soaker per spot, then says it is full', () => {
    const tub = ofItem('pool-hot-tub');
    const taken = new Set<string>();
    for (let n = 0; n < tub.length; n++) {
      const got = freeSeatFor(SEATS, tub[0], taken)!;
      expect(taken.has(got.id)).toBe(false);
      taken.add(got.id);
    }
    expect(taken.size).toBe(4);
    expect(freeSeatFor(SEATS, tub[0], taken)).toBeNull();
  });

  it('never trades a full dive board for a lounger on the same pool', () => {
    // The board and the loungers are all seats of the one pool item.
    const board = SEATS.find((s) => s.dive)!;
    expect(board.id.startsWith('pool-main:')).toBe(true);
    expect(freeSeatFor(SEATS, board, new Set([board.id]))).toBeNull();
  });

  it('trades a taken lounger only for another lounger', () => {
    const loungers = SEATS.filter((s) => s.lie && s.id.startsWith('pool-main:'));
    expect(loungers.length).toBeGreaterThan(1);
    const got = freeSeatFor(SEATS, loungers[0], new Set([loungers[0].id]))!;
    expect(got.lie).toBe(true);
    expect(got.id).not.toBe(loungers[0].id);
  });

  it('leaves water seats alone — they are never "taken"', () => {
    const water = SEATS.find((s) => s.swim)!;
    expect(freeSeatFor(SEATS, water, new Set([water.id]))).toBe(water);
  });
});

describe('freeSeatFor — a sofa', () => {
  beforeAll(() =>
    loadRoom([{ id: 'sofa', kind: 'sofa-back', pos: { x: 0, z: 0 }, rot: 0, movable: true }]),
  );

  it('moves a click on a taken cushion to the nearest free one', () => {
    const cushions = ofItem('sofa');
    expect(cushions.length).toBeGreaterThan(1);
    const [first, ...rest] = cushions;
    const got = freeSeatFor(SEATS, first, new Set([first.id]))!;
    const dist = (s: Seat) => Math.hypot(s.sit.x - first.sit.x, s.sit.z - first.sit.z);
    expect(dist(got)).toBe(Math.min(...rest.map(dist)));
  });
});

describe('keepsSeat — two players sat down in one seat at once', () => {
  /** Both games' verdicts for one clash, from their own clocks. */
  const verdicts = (o: {
    tA: number; // when A's claim began (true time, ms)
    tB: number;
    dAB: number; // one-way delay A → B (ms)
    dBA: number;
    seqA: number; // tick counters at the moment of the check
    seqB: number;
    lagA: number; // how many ticks old the counter each side holds is
    lagB: number;
  }) => {
    const a = keepsSeat({
      mineSince: o.tA,
      theirsSince: o.tB + o.dBA,
      mySeq: o.seqA & 0xffff,
      theirSeq: (o.seqB - o.lagB) & 0xffff,
    });
    const b = keepsSeat({
      mineSince: o.tB,
      theirsSince: o.tA + o.dAB,
      mySeq: o.seqB & 0xffff,
      theirSeq: (o.seqA - o.lagA) & 0xffff,
    });
    return { a, b };
  };

  it('keeps the seat for whoever was plainly there first', () => {
    const v = verdicts({ tA: 0, tB: 3000, dAB: 80, dBA: 80, seqA: 100, seqB: 9000, lagA: 2, lagB: 2 });
    expect(v).toEqual({ a: true, b: false });
  });

  it('falls back to the tick counters when the two sat down together', () => {
    const v = verdicts({ tA: 0, tB: 40, dAB: 60, dBA: 60, seqA: 5000, seqB: 1200, lagA: 2, lagB: 2 });
    expect(v).toEqual({ a: true, b: false });
    const w = verdicts({ tA: 0, tB: 40, dAB: 60, dBA: 60, seqA: 1200, seqB: 5000, lagA: 2, lagB: 2 });
    expect(w).toEqual({ a: false, b: true });
  });

  it('reads the counters across their 16-bit wrap', () => {
    // A is 40 ticks ahead, but its counter has wrapped past zero.
    const v = verdicts({ tA: 0, tB: 30, dAB: 50, dBA: 50, seqA: 65536 + 15, seqB: 65511, lagA: 1, lagB: 1 });
    expect(v).toEqual({ a: true, b: false });
  });

  it('stands both up when even the counters cannot tell them apart', () => {
    const v = verdicts({ tA: 0, tB: 20, dAB: 50, dBA: 50, seqA: 3000, seqB: 3004, lagA: 1, lagB: 1 });
    expect(v).toEqual({ a: false, b: false });
  });

  it('never lets both games keep the seat, whatever the timing', () => {
    // Sweep start times, delays up to the 250 ms the bands assume, counter
    // gaps either side of the margin, and positions across the wrap.
    let cases = 0;
    let decided = 0;
    for (const tB of [-3000, -1200, -900, -600, -400, -100, 0, 100, 400, 600, 900, 1200, 3000]) {
      for (const dAB of [0, 50, 125, 250]) {
        for (const dBA of [0, 50, 125, 250]) {
          for (const gap of [-30000, -500, -25, -20, -5, 0, 5, 20, 25, 500, 30000]) {
            for (const base of [0, 32760, 65530]) {
              const lagA = Math.round(dAB / 50) + 1;
              const lagB = Math.round(dBA / 50) + 1;
              const v = verdicts({ tA: 0, tB, dAB, dBA, seqA: base + gap, seqB: base, lagA, lagB });
              expect(v.a && v.b).toBe(false);
              cases++;
              // …and it is not safe merely by standing everyone up. The clash
              // that really happens — both sat down within one delay of each
              // other — has exactly one winner whenever the counters are
              // apart, and so does a claim that is plainly first.
              const together = Math.abs(tB) <= 250 && Math.abs(gap) >= 25;
              const plainlyFirst = Math.abs(tB) >= 1200;
              if (together || plainlyFirst) {
                expect(v.a !== v.b).toBe(true);
                decided++;
              }
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(5000);
    expect(decided).toBeGreaterThan(1000);
  });
});
