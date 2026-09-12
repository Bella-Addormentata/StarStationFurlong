/**
 * Air hockey engine tests — issue #115.
 *
 * Everything here runs in Node with zero DOM/THREE/Yjs: the doc-state guard
 * and transitions, the substep puck physics (containment, goals, mallet
 * strikes), and the 13-byte tick codec including the kind-0 movement-tick
 * compatibility rule that protects every pre-#115 sender.
 */

import { describe, expect, it } from 'vitest';
import {
  AH_GOAL_HALF_W,
  AH_GOAL_PAUSE_MS,
  AH_GOALS_TO_WIN,
  AH_HALF_L,
  AH_HALF_W,
  AH_MALLET_R,
  AH_PUCK_MAX_SPEED,
  AH_PUCK_R,
  claimSide,
  clampMallet,
  initialAirHockeyState,
  isAirHockeyState,
  isVersus,
  malletFromTick,
  malletToTick,
  puckFromTick,
  puckToTick,
  releaseSide,
  servePosition,
  setReady,
  setUnready,
  startIfReady,
  startPractice,
  stepPuck,
  withForfeit,
  withGoal,
  type AirHockeyState,
  type MalletInput,
  type PuckSim,
} from './airHockey';
import {
  TICK_KIND_AH_MALLET,
  TICK_KIND_AH_PUCK,
  TICK_KIND_MOVEMENT,
  packTick,
  packTickKind,
  tickKind,
  unpackTick,
} from '../network/protocol';

/** Deterministic LCG so fuzz failures reproduce (no Math.random in tests). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const raisedMallet: MalletInput = { x: 0, z: -0.5, vx: 0, vz: 0, down: false };

describe('isAirHockeyState guard', () => {
  it('accepts the initial state and a mid-game state', () => {
    expect(isAirHockeyState(initialAirHockeyState())).toBe(true);
    const s: AirHockeyState = {
      ...initialAirHockeyState(),
      players: { a: 'p1', b: 'p2' },
      ready: { a: true, b: true },
      paid: { a: 25, b: 25 },
      score: { a: 3, b: 6 },
      status: 'playing',
      servingSide: 'b',
      serveAt: 1755600000000,
      startedAt: 1755599990000,
    };
    expect(isAirHockeyState(s)).toBe(true);
  });

  it('rejects non-objects and wrong kinds', () => {
    expect(isAirHockeyState(null)).toBe(false);
    expect(isAirHockeyState(undefined)).toBe(false);
    expect(isAirHockeyState(42)).toBe(false);
    expect(isAirHockeyState('airhockey')).toBe(false);
    expect(isAirHockeyState({ kind: 'chess' })).toBe(false);
    expect(isAirHockeyState({ ...initialAirHockeyState(), kind: 'checkers' })).toBe(false);
  });

  it('rejects peer-writable field corruption (fractions, negatives, unsafe ints)', () => {
    const base = initialAirHockeyState();
    expect(isAirHockeyState({ ...base, paid: { a: 1.5, b: 0 } })).toBe(false);
    expect(isAirHockeyState({ ...base, score: { a: -1, b: 0 } })).toBe(false);
    expect(isAirHockeyState({ ...base, score: { a: Number.MAX_SAFE_INTEGER + 2, b: 0 } })).toBe(false);
    expect(isAirHockeyState({ ...base, serveAt: Number.NaN })).toBe(false);
    expect(isAirHockeyState({ ...base, startedAt: -5 })).toBe(false);
    expect(isAirHockeyState({ ...base, status: 'paused' })).toBe(false);
    expect(isAirHockeyState({ ...base, servingSide: 'c' })).toBe(false);
    expect(isAirHockeyState({ ...base, winner: 'draw' })).toBe(false);
    expect(isAirHockeyState({ ...base, players: { a: '', b: null } })).toBe(false);
    expect(isAirHockeyState({ ...base, players: { a: 'x'.repeat(129), b: null } })).toBe(false);
    expect(isAirHockeyState({ ...base, players: null })).toBe(false);
    expect(isAirHockeyState({ ...base, ready: { a: 1, b: false } })).toBe(false);
  });
});

describe('claim / ready lifecycle', () => {
  it('claims an open side, refuses a taken side and double-siding', () => {
    const s0 = initialAirHockeyState();
    const s1 = claimSide(s0, 'a', 'p1');
    expect(s1?.players.a).toBe('p1');
    expect(claimSide(s1!, 'a', 'p2')).toBeNull();       // taken
    expect(claimSide(s1!, 'b', 'p1')).toBeNull();       // one side per player
    expect(claimSide(s1!, 'a', 'p1')).toBeNull();       // already mine — no-op
    const s2 = claimSide(s1!, 'b', 'p2');
    expect(s2?.players).toEqual({ a: 'p1', b: 'p2' });
  });

  it('release clears the claim plus ready and paid, only pre-game and only by owner', () => {
    let s = claimSide(initialAirHockeyState(), 'a', 'p1')!;
    s = setReady(s, 'a', 'p1', 10)!;
    expect(releaseSide(s, 'a', 'p2')).toBeNull();
    const released = releaseSide(s, 'a', 'p1')!;
    expect(released.players.a).toBeNull();
    expect(released.ready.a).toBe(false);
    expect(released.paid.a).toBe(0);
  });

  it('ready records the fee; unready clears it; both gate on claimant + status', () => {
    let s = claimSide(initialAirHockeyState(), 'a', 'p1')!;
    expect(setReady(s, 'a', 'p2', 0)).toBeNull();       // not the claimant
    expect(setReady(s, 'a', 'p1', 2.5)).toBeNull();     // fractional fee
    expect(setReady(s, 'a', 'p1', -1)).toBeNull();      // negative fee
    s = setReady(s, 'a', 'p1', 25)!;
    expect(s.ready.a).toBe(true);
    expect(s.paid.a).toBe(25);
    expect(setReady(s, 'a', 'p1', 25)).toBeNull();      // already ready
    const un = setUnready(s, 'a', 'p1')!;
    expect(un.ready.a).toBe(false);
    expect(un.paid.a).toBe(0);
  });

  it('startIfReady fires only with both sides claimed AND ready, and resets score', () => {
    let s = claimSide(initialAirHockeyState(), 'a', 'p1')!;
    s = setReady(s, 'a', 'p1', 0)!;
    expect(startIfReady(s, 1000)).toBeNull();           // b missing
    s = claimSide(s, 'b', 'p2')!;
    expect(startIfReady(s, 1000)).toBeNull();           // b not ready
    s = setReady(s, 'b', 'p2', 0)!;
    const playing = startIfReady({ ...s, score: { a: 3, b: 1 } }, 1000)!;
    expect(playing.status).toBe('playing');
    expect(playing.score).toEqual({ a: 0, b: 0 });
    expect(playing.startedAt).toBe(1000);
    expect(playing.serveAt).toBeGreaterThan(1000);
    expect(startIfReady(playing, 2000)).toBeNull();     // already playing
  });

  it('practice starts solo only, and versus takes priority once b is claimed', () => {
    let s = claimSide(initialAirHockeyState(), 'a', 'p1')!;
    const practice = startPractice(s, 'a', 'p1', 5, 500)!;
    expect(practice.status).toBe('playing');
    expect(practice.paid.a).toBe(5);
    expect(isVersus(practice)).toBe(false);
    s = claimSide(s, 'b', 'p2')!;
    expect(startPractice(s, 'a', 'p1', 5, 500)).toBeNull();
  });
});

describe('goals, wins, forfeits', () => {
  function playingVersus(): AirHockeyState {
    let s = claimSide(initialAirHockeyState(), 'a', 'p1')!;
    s = claimSide(s, 'b', 'p2')!;
    s = setReady(s, 'a', 'p1', 0)!;
    s = setReady(s, 'b', 'p2', 0)!;
    return startIfReady(s, 1000)!;
  }

  it('a goal credits the scorer and serves to the side scored on', () => {
    const s = withGoal(playingVersus(), 'a', 5000)!;
    expect(s.score).toEqual({ a: 0, b: 1 });
    expect(s.servingSide).toBe('a');
    expect(s.serveAt).toBe(5000 + AH_GOAL_PAUSE_MS);
    expect(s.status).toBe('playing');
    expect(withGoal({ ...s, status: 'ended' }, 'a', 6000)).toBeNull();
  });

  it(`the match ends at ${AH_GOALS_TO_WIN} goals in versus`, () => {
    let s = playingVersus();
    for (let i = 0; i < AH_GOALS_TO_WIN; i++) {
      expect(s.status).toBe('playing');
      s = withGoal(s, 'a', 5000 + i)!;
    }
    expect(s.status).toBe('ended');
    expect(s.winner).toBe('b');
    expect(s.score.b).toBe(AH_GOALS_TO_WIN);
    expect(s.serveAt).toBe(0);
  });

  it('practice never ends on score', () => {
    const solo = claimSide(initialAirHockeyState(), 'a', 'p1')!;
    let s = startPractice(solo, 'a', 'p1', 0, 500)!;
    for (let i = 0; i < AH_GOALS_TO_WIN + 3; i++) s = withGoal(s, 'b', 1000 + i)!;
    expect(s.status).toBe('playing');
    expect(s.winner).toBeNull();
    expect(s.score.a).toBe(AH_GOALS_TO_WIN + 3);
  });

  it('forfeit ends a versus match immediately, and only a versus match', () => {
    const s = withForfeit(playingVersus(), 'a')!;
    expect(s.status).toBe('ended');
    expect(s.winner).toBe('a');
    const solo = startPractice(claimSide(initialAirHockeyState(), 'a', 'p1')!, 'a', 'p1', 0, 1)!;
    expect(withForfeit(solo, 'a')).toBeNull();
  });

  it('serves from the receiving half in versus, centre in practice', () => {
    const versus = playingVersus();
    expect(servePosition({ ...versus, servingSide: 'a' }).z).toBeLessThan(0);
    expect(servePosition({ ...versus, servingSide: 'b' }).z).toBeGreaterThan(0);
    const solo = startPractice(claimSide(initialAirHockeyState(), 'a', 'p1')!, 'a', 'p1', 0, 1)!;
    expect(servePosition(solo)).toEqual({ x: 0, z: 0 });
  });
});

describe('mallet clamp', () => {
  it('keeps each mallet inside the rails and strictly in its own half', () => {
    const a = clampMallet('a', 99, 99);
    expect(a.x).toBeCloseTo(AH_HALF_W - AH_MALLET_R, 6);
    expect(a.z).toBeCloseTo(-AH_MALLET_R, 6);           // may not cross centre
    const a2 = clampMallet('a', -99, -99);
    expect(a2.x).toBeCloseTo(-(AH_HALF_W - AH_MALLET_R), 6);
    expect(a2.z).toBeCloseTo(-(AH_HALF_L - AH_MALLET_R), 6);
    const b = clampMallet('b', 0, -99);
    expect(b.z).toBeCloseTo(AH_MALLET_R, 6);
    const inside = clampMallet('b', 0.2, 0.9);
    expect(inside).toEqual({ x: 0.2, z: 0.9 });
  });
});

describe('puck physics', () => {
  it('fuzz: the puck never escapes the table sideways or through a rail', () => {
    const rng = makeRng(115);
    for (let trial = 0; trial < 40; trial++) {
      const sim: PuckSim = {
        x: (rng() * 2 - 1) * (AH_HALF_W - AH_PUCK_R),
        z: (rng() * 2 - 1) * (AH_HALF_L - AH_PUCK_R),
        vx: (rng() * 2 - 1) * AH_PUCK_MAX_SPEED,
        vz: (rng() * 2 - 1) * AH_PUCK_MAX_SPEED,
      };
      for (let frame = 0; frame < 300; frame++) {       // 5 s at 60 fps
        const goal = stepPuck(sim, [raisedMallet], 1 / 60);
        expect(Math.abs(sim.x)).toBeLessThanOrEqual(AH_HALF_W - AH_PUCK_R + 1e-9);
        // z may legitimately pass the end line inside the goal mouth; it is
        // bounded by the score threshold plus one substep of travel.
        expect(Math.abs(sim.z)).toBeLessThanOrEqual(AH_HALF_L + AH_PUCK_R + 0.05);
        if (goal !== null) break;                       // scored — sim over
      }
    }
  });

  it('side rails reflect and dissipate; end rails outside the mouth reflect', () => {
    const side: PuckSim = { x: 0.5, z: 0, vx: 4, vz: 0 };
    stepPuck(side, [], 0.2);
    expect(side.vx).toBeLessThan(0);
    expect(Math.abs(side.vx)).toBeLessThan(4);          // restitution + friction
    const end: PuckSim = { x: 0.5, z: 1.0, vx: 0, vz: 4 }; // x outside mouth
    const goal = stepPuck(end, [], 0.3);
    expect(goal).toBeNull();
    expect(end.vz).toBeLessThan(0);
  });

  it('a shot inside the mouth scores once fully past the line', () => {
    const sim: PuckSim = { x: 0.1, z: 1.0, vx: 0, vz: 3 };
    let goal: ReturnType<typeof stepPuck> = null;
    for (let i = 0; i < 60 && goal === null; i++) goal = stepPuck(sim, [], 1 / 60);
    expect(goal).toBe('b');
    expect(Math.abs(sim.x)).toBeLessThan(AH_GOAL_HALF_W);
    const other: PuckSim = { x: -0.1, z: -1.0, vx: 0, vz: -3 };
    goal = null;
    for (let i = 0; i < 60 && goal === null; i++) goal = stepPuck(other, [], 1 / 60);
    expect(goal).toBe('a');
  });

  it('friction decays speed exponentially between contacts', () => {
    const sim: PuckSim = { x: 0, z: 0, vx: 0.2, vz: 0 };
    stepPuck(sim, [], 2);
    const speed = Math.hypot(sim.vx, sim.vz);
    expect(speed).toBeGreaterThan(0.1);                 // ≈ 0.2·e^(−0.56)
    expect(speed).toBeLessThan(0.13);
  });

  it('a moving DOWN mallet launches a resting puck; a raised one is a ghost', () => {
    const strike: MalletInput = { x: 0, z: -0.62, vx: 0, vz: 3, down: true };
    const sim: PuckSim = { x: 0, z: -0.5, vx: 0, vz: 0 };
    stepPuck(sim, [strike], 1 / 240);
    expect(sim.vz).toBeGreaterThan(2);                  // ≈ (1+e)·v·n
    expect(Math.hypot(sim.vx, sim.vz)).toBeLessThanOrEqual(AH_PUCK_MAX_SPEED + 1e-9);
    const ghost: PuckSim = { x: 0, z: -0.5, vx: 0, vz: 0 };
    stepPuck(ghost, [{ ...strike, down: false }], 1 / 240);
    expect(ghost.vx).toBe(0);
    expect(ghost.vz).toBe(0);
  });

  it('a stationary down mallet blocks: the puck bounces off it', () => {
    const block: MalletInput = { x: 0, z: -0.8, vx: 0, vz: 0, down: true };
    const sim: PuckSim = { x: 0, z: -0.5, vx: 0, vz: -2 };
    stepPuck(sim, [block], 0.3);
    expect(sim.vz).toBeGreaterThan(0);
    // Ejected outside the contact circle, not swallowed.
    expect(Math.hypot(sim.x - block.x, sim.z - block.z))
      .toBeGreaterThanOrEqual(AH_PUCK_R + AH_MALLET_R - 1e-9);
  });

  it('coincident centres eject without NaN', () => {
    const overlap: MalletInput = { x: 0.2, z: -0.6, vx: 0, vz: 0, down: true };
    const sim: PuckSim = { x: 0.2, z: -0.6, vx: 0, vz: 0 };
    stepPuck(sim, [overlap], 1 / 240);
    expect(Number.isFinite(sim.x)).toBe(true);
    expect(Number.isFinite(sim.z)).toBe(true);
    expect(Math.hypot(sim.x - overlap.x, sim.z - overlap.z))
      .toBeGreaterThanOrEqual(AH_PUCK_R + AH_MALLET_R - 1e-9);
  });

  it('a back-rail mallet press cannot park the puck on the goal line — it scores', () => {
    // Mallet clamped to its own back rail with the puck overlapped: ejection
    // lands the centre at ±(AH_HALF_L + AH_PUCK_R) with zero velocity, which
    // a strict goal test left parked there until the stuck-puck watchdog.
    for (const side of ['a', 'b'] as const) {
      const back = clampMallet(side, 0, side === 'a' ? -AH_HALF_L : AH_HALF_L);
      const press: MalletInput = { ...back, vx: 0, vz: 0, down: true };
      const sim: PuckSim = {
        x: 0,
        z: back.z + (side === 'a' ? -0.01 : 0.01), // eject normal points goalward
        vx: 0,
        vz: 0,
      };
      let goal: ReturnType<typeof stepPuck> = null;
      for (let i = 0; i < 240 && goal === null; i++) goal = stepPuck(sim, [press], 1 / 240);
      expect(goal).toBe(side);
    }
  });

  it('ejection from a rail-clamped mallet never lands the puck outside the rails', () => {
    // Pinned against the +x rail, the radii-sum push would land the centre
    // ~0.11 m beyond the side rail for a substep; post-eject containment
    // keeps every rendered position legal.
    const pin = clampMallet('b', AH_HALF_W, 0.5);
    const press: MalletInput = { ...pin, vx: 0, vz: 0, down: true };
    const sim: PuckSim = { x: pin.x + 0.01, z: pin.z, vx: 0, vz: 0 };
    stepPuck(sim, [press], 1 / 240);
    expect(sim.x).toBeLessThanOrEqual(AH_HALF_W - AH_PUCK_R + 1e-12);
    // Corner pin: both axes overshoot; x clamps out of the goal mouth, so the
    // end line is solid there and z must contain too (no goal, no escape).
    const corner = clampMallet('b', AH_HALF_W, AH_HALF_L);
    const cornerPress: MalletInput = { ...corner, vx: 0, vz: 0, down: true };
    const diag: PuckSim = { x: corner.x + 0.01, z: corner.z + 0.01, vx: 0, vz: 0 };
    expect(stepPuck(diag, [cornerPress], 1 / 240)).toBeNull();
    expect(diag.x).toBeLessThanOrEqual(AH_HALF_W - AH_PUCK_R + 1e-12);
    expect(diag.z).toBeLessThanOrEqual(AH_HALF_L - AH_PUCK_R + 1e-12);
  });
});

describe('tick codec (13-byte lane, kind bits 6–7)', () => {
  it('kind constants round-trip through pack/tickKind for all four values', () => {
    for (const kind of [0, 1, 2, 3]) {
      expect(tickKind(packTickKind(kind))).toBe(kind);
    }
  });

  it('every movement tick (all six pose bits set) still reads as kind 0', () => {
    const wire = packTick({ flags: 0b0011_1111, x: 1, z: 2, yaw: 1, seq: 3 });
    expect(tickKind(unpackTick(wire).flags)).toBe(TICK_KIND_MOVEMENT);
  });

  it('mallet ticks survive the wire: kind, down bit, world coords, seq wrap', () => {
    const wire = packTick(malletToTick({ x: 12.34, z: -45.6, down: true, seq: 70000 }));
    const tick = unpackTick(wire);
    expect(tickKind(tick.flags)).toBe(TICK_KIND_AH_MALLET);
    const m = malletFromTick(tick);
    expect(m.down).toBe(true);
    expect(m.x).toBeCloseTo(12.34, 3);
    expect(m.z).toBeCloseTo(-45.6, 3);
    expect(m.seq).toBe(70000 & 0xffff);
    const up = malletFromTick(unpackTick(packTick(malletToTick({ x: 0, z: 0, down: false, seq: 1 }))));
    expect(up.down).toBe(false);
  });

  it('puck ticks survive the wire: kind, active bit, quantized speed, heading', () => {
    const wire = packTick(puckToTick({
      x: -3.25, z: 8.5, heading: -1.2, speed: 3.3, active: true, seq: 9,
    }));
    const tick = unpackTick(wire);
    expect(tickKind(tick.flags)).toBe(TICK_KIND_AH_PUCK);
    const p = puckFromTick(tick);
    expect(p.active).toBe(true);
    expect(p.x).toBeCloseTo(-3.25, 3);
    expect(p.z).toBeCloseTo(8.5, 3);
    expect(Math.abs(p.speed - 3.3)).toBeLessThanOrEqual(AH_PUCK_MAX_SPEED / 31 / 2 + 1e-6);
    expect(p.heading).toBeCloseTo(((-1.2 % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI), 3);
    const held = puckFromTick(unpackTick(packTick(puckToTick({
      x: 0, z: 0, heading: 0, speed: 0, active: false, seq: 0,
    }))));
    expect(held.active).toBe(false);
    expect(held.speed).toBe(0);
  });

  it('speed quantization clamps out-of-range values instead of wrapping', () => {
    const over = puckFromTick(puckToTick({
      x: 0, z: 0, heading: 0, speed: 99, active: true, seq: 0,
    }));
    expect(over.speed).toBeCloseTo(AH_PUCK_MAX_SPEED, 6);
    const under = puckFromTick(puckToTick({
      x: 0, z: 0, heading: 0, speed: -5, active: true, seq: 0,
    }));
    expect(under.speed).toBe(0);
  });
});
