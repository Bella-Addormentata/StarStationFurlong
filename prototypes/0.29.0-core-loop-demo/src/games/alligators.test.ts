/**
 * Insatiable alligators engine tests — issue #185.
 *
 * Everything here runs in Node with zero DOM/THREE/Yjs (the air-hockey
 * engine tests' contract): the doc-state guard and transitions, the head
 * geometry and blocking, the ball physics (containment, dome, spin, bites),
 * the round schedule, and the kind-3 tick codec.
 */

import { describe, expect, it } from 'vitest';
import {
  IA_BALLS_PER_PLAYER, IA_BALL_MAX_SPEED, IA_BALL_R, IA_BASE_R, IA_HEAD_LEN,
  IA_LAY_START_MS, IA_LIVE, IA_LUNGE, IA_MAX_BALLS, IA_MOUTH_R, IA_SEATS,
  IA_SPIN_EVERY_MS, IA_SPIN_MS, IA_SWING_MAX, IA_TABLE_R,
  ballFromTick, ballToTick, ballsUnderMouth, biteJawOpen, biteLungeExt,
  birdOf, claimSeat, claimedSeats, eggSpawn, headDir, headFromTick, headGap,
  headToTick, initialAlligatorsState, isAlligatorsState, isBallTick,
  isPractice, layTimeMs, mouthOf, nextRound, pivotOf, poseFromMouth,
  releaseSeat, resolveHeadPose, scores, setReady, spinAngle, spinRate,
  startIfReady, startPractice, stepBalls, takeSeat, topSeats, withBites,
  type AlligatorsState, type BallSim,
} from './alligators';
import {
  TICK_KIND_AH_MALLET, TICK_KIND_AH_PUCK, TICK_KIND_ALLIGATORS, TICK_KIND_MOVEMENT,
  packTick, tickKind, unpackTick,
} from '../network/protocol';

/** Deterministic LCG so fuzz failures reproduce (no Math.random in tests). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A table with `n` seats claimed (seats 0..n-1), all ready. */
function seated(n: number): AlligatorsState {
  let s = initialAlligatorsState();
  for (let i = 0; i < n; i++) {
    s = claimSeat(s, i, `p${i}`, `page${i}`)!;
    s = setReady(s, i, `p${i}`, true)!;
  }
  return s;
}

describe('doc state', () => {
  it('starts empty and passes its own guard', () => {
    const s = initialAlligatorsState();
    expect(isAlligatorsState(s)).toBe(true);
    expect(s.players).toHaveLength(IA_SEATS);
    expect(claimedSeats(s)).toEqual([]);
  });

  it('rejects malformed peer writes', () => {
    const good = initialAlligatorsState();
    const bad: unknown[] = [
      null, 3, 'x', { ...good, kind: 'airhockey' },
      { ...good, players: good.players.slice(0, 7) },
      { ...good, ready: [...good.ready.slice(0, 7), 'yes'] },
      { ...good, status: 'paused' },
      { ...good, eaten: [IA_LIVE, 8] },
      { ...good, eaten: [0.5] },
      { ...good, eaten: Array.from({ length: IA_MAX_BALLS + 1 }, () => IA_LIVE) },
      { ...good, startedAt: -1 },
      { ...good, startedAt: 1.5 },
      { ...good, winners: [9] },
      { ...good, players: [...good.players.slice(0, 7), 'x'.repeat(129)] },
    ];
    for (const v of bad) expect(isAlligatorsState(v)).toBe(false);
  });

  it('gives each player one seat, and only an open one', () => {
    let s = initialAlligatorsState();
    s = claimSeat(s, 3, 'alice', 'pa')!;
    expect(s.players[3]).toBe('alice');
    expect(s.seats[3]).toBe('pa');
    expect(claimSeat(s, 4, 'alice', 'pa')).toBeNull(); // one seat each
    expect(claimSeat(s, 3, 'bob', 'pb')).toBeNull();   // taken
    expect(claimSeat(s, 8, 'bob', 'pb')).toBeNull();   // no such seat
    expect(claimSeat(s, 4, 'bob', 'pb')!.players[4]).toBe('bob');
  });

  it('moves a held seat to another page with PLAY HERE', () => {
    const s = claimSeat(initialAlligatorsState(), 2, 'alice', 'tab1')!;
    expect(takeSeat(s, 2, 'alice', 'tab2')!.seats[2]).toBe('tab2');
    expect(takeSeat(s, 2, 'alice', 'tab1')).toBeNull();
    expect(takeSeat(s, 2, 'bob', 'tab2')).toBeNull();
  });

  it('starts a round only with every claimed seat ready, two or more of them', () => {
    let s = claimSeat(initialAlligatorsState(), 0, 'a', 'pa')!;
    s = setReady(s, 0, 'a', true)!;
    expect(startIfReady(s, 1000)).toBeNull(); // alone
    s = claimSeat(s, 5, 'b', 'pb')!;
    expect(startIfReady(s, 1000)).toBeNull(); // b not ready
    s = setReady(s, 5, 'b', true)!;
    const started = startIfReady(s, 1000)!;
    expect(started.status).toBe('playing');
    expect(started.startedAt).toBe(1000);
    expect(started.eaten).toHaveLength(2 * IA_BALLS_PER_PLAYER);
    expect(started.eaten.every((e) => e === IA_LIVE)).toBe(true);
    expect(isAlligatorsState(started)).toBe(true);
  });

  it('scales the balls with the players: 10 each, 80 at a full table', () => {
    for (const n of [2, 5, 8]) {
      expect(startIfReady(seated(n), 1)!.eaten).toHaveLength(n * IA_BALLS_PER_PLAYER);
    }
    expect(IA_MAX_BALLS).toBe(80);
  });

  it('lets a lone claimant practise with 10 balls, and not once a rival sits', () => {
    const solo = claimSeat(initialAlligatorsState(), 1, 'a', 'pa')!;
    const p = startPractice(solo, 1, 'a', 5)!;
    expect(p.eaten).toHaveLength(IA_BALLS_PER_PLAYER);
    expect(isPractice(p)).toBe(true);
    const duo = claimSeat(solo, 2, 'b', 'pb')!;
    expect(startPractice(duo, 1, 'a', 5)).toBeNull();
  });

  it('releases a seat pre-round only', () => {
    const s = seated(2);
    const r = releaseSeat(s, 1, 'p1')!;
    expect(r.players[1]).toBeNull();
    expect(r.seats[1]).toBeNull();
    expect(r.ready[1]).toBe(false);
    expect(releaseSeat(startIfReady(s, 1)!, 1, 'p1')).toBeNull();
  });

  it('records bites, ignores double bites, and ends on the last ball', () => {
    let s = startIfReady(seated(2), 1)!;
    const n = s.eaten.length;
    s = withBites(s, 0, [0, 1, 2])!;
    expect(scores(s)[0]).toBe(3);
    expect(withBites(s, 1, [0, 1])).toBeNull();           // already eaten
    expect(withBites(s, 1, [999, -1, 0.5])).toBeNull();   // nonsense indices
    expect(withBites(s, 4, [3])).toBeNull();              // unclaimed seat
    s = withBites(s, 1, [3, 4, 5, 6])!;
    const rest = Array.from({ length: n - 7 }, (_, i) => i + 7);
    s = withBites(s, 0, rest)!;
    expect(s.status).toBe('ended');
    expect(s.winners).toEqual([0]);
    expect(withBites(s, 0, [0])).toBeNull();
  });

  it('shares a tied win, and a practice round has no winner', () => {
    let s = startIfReady(seated(2), 1)!;
    const half = s.eaten.length / 2;
    s = withBites(s, 0, Array.from({ length: half }, (_, i) => i))!;
    s = withBites(s, 1, Array.from({ length: half }, (_, i) => i + half))!;
    expect(s.winners).toEqual([0, 1]);
    expect(topSeats(s)).toEqual([0, 1]);

    let p = startPractice(claimSeat(initialAlligatorsState(), 0, 'a', 'pa')!, 0, 'a', 1)!;
    p = withBites(p, 0, Array.from({ length: p.eaten.length }, (_, i) => i))!;
    expect(p.status).toBe('ended');
    expect(p.winners).toEqual([]);
  });

  it('PLAY AGAIN keeps the seats and clears the round', () => {
    let s = startIfReady(seated(3), 1)!;
    s = withBites(s, 2, s.eaten.map((_, i) => i))!;
    const again = nextRound(s)!;
    expect(again.status).toBe('waiting');
    expect(again.players).toEqual(s.players);
    expect(again.ready.every((r) => !r)).toBe(true);
    expect(again.eaten).toEqual([]);
    expect(nextRound(again)).toBeNull();
  });
});

describe('head geometry', () => {
  it('puts every pivot on the rim, seat 0 at local −z, 45° apart', () => {
    const p0 = pivotOf(0);
    expect(p0.x).toBeCloseTo(0);
    expect(p0.z).toBeCloseTo(-IA_TABLE_R);
    for (let i = 0; i < IA_SEATS; i++) {
      const p = pivotOf(i);
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(IA_TABLE_R);
      const q = pivotOf((i + 1) % IA_SEATS);
      expect(Math.hypot(p.x - q.x, p.z - q.z)).toBeCloseTo(2 * IA_TABLE_R * Math.sin(Math.PI / IA_SEATS));
    }
  });

  it('points a resting head at the centre, and +swing toward the seat\'s screen-right', () => {
    const d = headDir(0, 0);
    expect(d.x).toBeCloseTo(0);
    expect(d.z).toBeCloseTo(1);
    // From seat 0 (looking along +z) screen-right is local −x (air hockey's
    // side-a mapping).
    expect(headDir(0, 0.5).x).toBeLessThan(0);
    const m = mouthOf(0, { swing: 0, ext: 0 });
    expect(m.z).toBeCloseTo(-IA_TABLE_R + IA_HEAD_LEN);
  });

  it('round-trips a pose through its mouth position, clamped', () => {
    const rng = makeRng(185);
    for (let i = 0; i < 200; i++) {
      const seat = Math.floor(rng() * IA_SEATS);
      const pose = { swing: (rng() * 2 - 1) * IA_SWING_MAX, ext: rng() * IA_LUNGE };
      const m = mouthOf(seat, pose);
      const back = poseFromMouth(seat, m.x, m.z);
      expect(back.swing).toBeCloseTo(pose.swing, 6);
      expect(back.ext).toBeCloseTo(pose.ext, 6);
    }
    // A peer's out-of-range point clamps into the legal pose.
    const wild = poseFromMouth(0, 50, 50);
    expect(Math.abs(wild.swing)).toBeLessThanOrEqual(IA_SWING_MAX);
    expect(wild.ext).toBeLessThanOrEqual(IA_LUNGE);
    expect(poseFromMouth(0, Number.NaN, 0)).toEqual({ swing: expect.any(Number), ext: expect.any(Number) });
  });

  it('keeps neighbours clear at rest, and they meet when they turn together', () => {
    expect(headGap(0, { swing: 0, ext: 0 }, 1, { swing: 0, ext: 0 })).toBeGreaterThan(0);
    // Seat 1 sits at +x of seat 0, which is seat 0's screen-LEFT: −swing turns
    // toward it; seat 1 turns back toward seat 0 with +swing.
    expect(headGap(0, { swing: -0.9, ext: 0 }, 1, { swing: 0.9, ext: 0 })).toBeLessThan(0);
  });

  it('stops a swing at the neighbour, and lets two locked heads part', () => {
    const others = [{ seat: 1, pose: { swing: 0.6, ext: 0 } }];
    const got = resolveHeadPose(0, { swing: 0, ext: 0 }, { swing: -IA_SWING_MAX, ext: 0 }, others);
    expect(got.swing).toBeLessThan(0);
    expect(got.swing).toBeGreaterThan(-IA_SWING_MAX);
    expect(headGap(0, got, 1, others[0].pose)).toBeGreaterThanOrEqual(-1e-3);
    // Pushing further into it goes nowhere.
    const pushed = resolveHeadPose(0, got, { swing: got.swing - 0.2, ext: 0 }, others);
    expect(pushed.swing).toBeCloseTo(got.swing, 3);
    // Overlapping already (the other moved in on a stale view of us): moving
    // away is allowed, moving further in is not.
    const overlapped = { swing: -0.4, ext: 0 };
    const inside = [{ seat: 1, pose: { swing: 0.5, ext: 0 } }];
    expect(headGap(0, overlapped, 1, inside[0].pose)).toBeLessThan(0);
    expect(resolveHeadPose(0, overlapped, { swing: -0.3, ext: 0 }, inside).swing).toBeCloseTo(-0.3);
    expect(resolveHeadPose(0, overlapped, { swing: -0.5, ext: 0 }, inside).swing).toBeCloseTo(-0.4);
  });

  it('lunges along the swing, and a blocked lunge stops short', () => {
    const free = resolveHeadPose(0, { swing: 0, ext: 0 }, { swing: 0, ext: IA_LUNGE }, []);
    expect(free.ext).toBeCloseTo(IA_LUNGE);
    const blocker = [{ seat: 4, pose: { swing: 0, ext: IA_LUNGE } }]; // straight across
    const met = resolveHeadPose(0, { swing: 0, ext: 0 }, { swing: 0, ext: IA_LUNGE }, blocker);
    expect(met.ext).toBeLessThanOrEqual(IA_LUNGE);
    expect(headGap(0, met, 4, blocker[0].pose)).toBeGreaterThanOrEqual(-1e-3);
  });

  it('runs a bite: open, shut on the table, open again', () => {
    expect(biteJawOpen(0)).toBe(1);
    expect(biteJawOpen(0.15)).toBe(0);
    expect(biteJawOpen(1)).toBe(1);
    expect(biteLungeExt(0.15)).toBeCloseTo(IA_LUNGE);
    expect(biteLungeExt(0.5)).toBe(0);
  });
});

describe('ball physics', () => {
  const allLive = (n: number) => Array.from({ length: n }, () => true);

  it('keeps every ball on the table and out of the base housings (fuzz)', () => {
    const rng = makeRng(7);
    const balls: BallSim[] = Array.from({ length: IA_MAX_BALLS }, () => {
      const a = rng() * Math.PI * 2;
      const r = rng() * 0.6;
      return { x: Math.cos(a) * r, z: Math.sin(a) * r, vx: (rng() * 2 - 1) * 3, vz: (rng() * 2 - 1) * 3 };
    });
    const live = allLive(balls.length);
    for (let f = 0; f < 600; f++) {
      stepBalls(balls, live, 1 / 60, f % 300 < 90 ? 2.4 : 0);
      for (const b of balls) {
        expect(Number.isFinite(b.x) && Number.isFinite(b.z)).toBe(true);
        expect(Math.hypot(b.x, b.z)).toBeLessThanOrEqual(IA_TABLE_R - IA_BALL_R + 1e-9);
        expect(Math.hypot(b.vx, b.vz)).toBeLessThanOrEqual(IA_BALL_MAX_SPEED + 1e-9);
      }
    }
    // Housings: no ball centre settles inside one (small overlap tolerated
    // from same-substep ball pushes).
    for (const b of balls) {
      for (let i = 0; i < IA_SEATS; i++) {
        const p = pivotOf(i);
        expect(Math.hypot(b.x - p.x, b.z - p.z)).toBeGreaterThan(IA_BASE_R + IA_BALL_R - 0.03);
      }
    }
  });

  it('rolls a ball off the dome\'s centre and lets it come to rest', () => {
    const balls: BallSim[] = [{ x: 0.05, z: 0, vx: 0, vz: 0 }];
    for (let f = 0; f < 60 * 20; f++) stepBalls(balls, [true], 1 / 60);
    expect(Math.hypot(balls[0].x, balls[0].z)).toBeGreaterThan(0.5);
    expect(Math.hypot(balls[0].vx, balls[0].vz)).toBeLessThan(0.2);
  });

  it('drags balls round when the table spins', () => {
    const balls: BallSim[] = [{ x: 0.6, z: 0, vx: 0, vz: 0 }];
    stepBalls(balls, [true], 0.1, 2.4);
    // ω × r at (0.6, 0) points +z for positive ω.
    expect(balls[0].vz).toBeGreaterThan(0.1);
  });

  it('bounces two balls apart, conserving their combined momentum', () => {
    const balls: BallSim[] = [
      { x: -0.2, z: 0, vx: 1, vz: 0 },
      { x: 0.2, z: 0, vx: -1, vz: 0 },
    ];
    for (let f = 0; f < 15; f++) stepBalls(balls, [true, true], 1 / 60);
    expect(balls[0].vx).toBeLessThan(0);
    expect(balls[1].vx).toBeGreaterThan(0);
    expect(balls[1].x - balls[0].x).toBeGreaterThanOrEqual(2 * IA_BALL_R - 1e-6);
  });

  it('skips balls that are not live', () => {
    const balls: BallSim[] = [{ x: 0.3, z: 0, vx: 2, vz: 0 }];
    stepBalls(balls, [false], 0.5);
    expect(balls[0]).toEqual({ x: 0.3, z: 0, vx: 2, vz: 0 });
  });

  it('eats the balls under a mouth, and only those', () => {
    const m = mouthOf(0, { swing: 0, ext: 0 });
    const balls: BallSim[] = [
      { x: m.x, z: m.z, vx: 0, vz: 0 },
      { x: m.x + IA_MOUTH_R * 0.9, z: m.z, vx: 0, vz: 0 },
      { x: m.x + IA_MOUTH_R * 1.2, z: m.z, vx: 0, vz: 0 },
      { x: m.x, z: m.z, vx: 0, vz: 0 },
    ];
    expect(ballsUnderMouth(balls, [true, true, true, false], m.x, m.z)).toEqual([0, 1]);
  });
});

describe('round schedule', () => {
  it('lays eggs in waves from every bird in turn', () => {
    expect(layTimeMs(0)).toBe(IA_LAY_START_MS);
    expect(birdOf(0)).toBe(0);
    expect(birdOf(9)).toBe(1);
    for (let k = 1; k < IA_MAX_BALLS; k++) expect(layTimeMs(k)).toBeGreaterThan(layTimeMs(k - 1));
  });

  it('lays each egg inside the rim, rolling inward, the same on every client', () => {
    for (let k = 0; k < IA_MAX_BALLS; k++) {
      const e = eggSpawn(k, 123456);
      expect(Math.hypot(e.x, e.z)).toBeLessThan(IA_TABLE_R - IA_BALL_R);
      expect(e.x * e.vx + e.z * e.vz).toBeLessThan(0); // heading in
      expect(eggSpawn(k, 123456)).toEqual(e);
    }
    // Clear of both neighbouring housings.
    for (let k = 0; k < IA_SEATS; k++) {
      const e = eggSpawn(k, 1);
      for (let i = 0; i < IA_SEATS; i++) {
        const p = pivotOf(i);
        expect(Math.hypot(e.x - p.x, e.z - p.z)).toBeGreaterThan(IA_BASE_R + IA_BALL_R);
      }
    }
  });

  it('spins briefly every 10 s, alternating, and never winds up', () => {
    expect(spinRate(5000)).toBe(0);
    expect(spinRate(IA_SPIN_EVERY_MS + IA_SPIN_MS / 2)).toBeGreaterThan(0);
    expect(spinRate(2 * IA_SPIN_EVERY_MS + IA_SPIN_MS / 2)).toBeLessThan(0);
    expect(spinRate(IA_SPIN_EVERY_MS + IA_SPIN_MS + 1)).toBe(0);
    expect(spinAngle(IA_SPIN_EVERY_MS - 1)).toBe(0);
    const afterOne = spinAngle(IA_SPIN_EVERY_MS + IA_SPIN_MS);
    expect(afterOne).toBeGreaterThan(0);
    expect(spinAngle(2 * IA_SPIN_EVERY_MS - 1)).toBeCloseTo(afterOne);
    expect(spinAngle(2 * IA_SPIN_EVERY_MS + IA_SPIN_MS)).toBeCloseTo(0);
    // The angle is the integral of the rate.
    let integral = 0;
    for (let t = 0; t < 3 * IA_SPIN_EVERY_MS; t += 1) integral += spinRate(t + 0.5) / 1000;
    expect(spinAngle(3 * IA_SPIN_EVERY_MS)).toBeCloseTo(integral, 3);
  });
});

describe('tick codec (lane kind 3)', () => {
  it('round-trips a head tick through the 13-byte wire', () => {
    for (let seat = 0; seat < IA_SEATS; seat++) {
      for (const jawDown of [false, true]) {
        const wire = unpackTick(packTick(headToTick({ x: 3.25, z: -7.5, seat, jawDown, seq: 70000 })));
        expect(tickKind(wire.flags)).toBe(TICK_KIND_ALLIGATORS);
        expect(isBallTick(wire)).toBe(false);
        const h = headFromTick(wire);
        expect(h).toEqual({ x: 3.25, z: -7.5, seat, jawDown, seq: 70000 & 0xffff });
      }
    }
  });

  it('round-trips a ball tick, index and counter sharing the seq field', () => {
    for (const index of [0, 1, 41, IA_MAX_BALLS - 1]) {
      const wire = unpackTick(packTick(ballToTick({
        x: -1.5, z: 2.25, heading: 1.25, speed: 1.5, index, seq: 600,
      })));
      expect(tickKind(wire.flags)).toBe(TICK_KIND_ALLIGATORS);
      expect(isBallTick(wire)).toBe(true);
      const b = ballFromTick(wire);
      expect(b.index).toBe(index);
      expect(b.seq).toBe(600 & 0x1ff);
      expect(b.x).toBe(-1.5);
      expect(b.z).toBe(2.25);
      expect(b.heading).toBeCloseTo(1.25, 3);
      expect(b.speed).toBeCloseTo(1.5, 0);
    }
  });

  it('stays clear of the movement and air-hockey kinds', () => {
    expect(new Set([TICK_KIND_MOVEMENT, TICK_KIND_AH_MALLET, TICK_KIND_AH_PUCK, TICK_KIND_ALLIGATORS]).size).toBe(4);
    const t = headToTick({ x: 0, z: 0, seat: 7, jawDown: true, seq: 1 });
    expect(tickKind(t.flags)).not.toBe(TICK_KIND_MOVEMENT);
  });
});
