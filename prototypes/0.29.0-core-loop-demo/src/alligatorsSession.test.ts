/**
 * 🐊 alligatorsSession (#185): the live layer's authority rules, driven
 * headlessly — the operator lays the eggs on schedule, a landed jaw (its own
 * or a peer's head tick) eats what lies under it through one doc write,
 * spectators render the operator's ball ticks, and a session belongs to the
 * room doc it began in (air hockey's #116 lesson).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// The module publishes a debug handle on `window` when it loads (and
// furniture.ts reads the page's query string).
vi.stubGlobal('window', { location: { search: '' } });

const { bindCasinoDoc } = await import('./casinoDoc');
const { bindGamesDoc, readAlligators, writeGame } = await import('./games/gamesDoc');
const { getPlayerId } = await import('./identity');
const {
  alligatorsFrame, alligatorsPage, alligatorsStatusLine, closeAlligatorsTable,
  registerAlligatorsVisual, routeAlligatorsTick, setAlligatorsSender,
} = await import('./alligatorsSession');
const {
  IA_BITE_DONE_S, IA_LAY_START_MS, IA_LIVE, ballToTick, claimSeat, headToTick,
  initialAlligatorsState, layTimeMs, mouthOf, setReady, startIfReady, startPractice,
} = await import('./games/alligators');
const { unpackTick, tickKind, TICK_KIND_ALLIGATORS } = await import('./network/protocol');

type Ball = { x: number; z: number; vx: number; vz: number };
type Session = {
  handle: unknown;
  docEpoch: number;
  engaged: unknown;
  balls: Ball[];
  inSim: boolean[];
  wasOperator: boolean;
  remoteBalls: unknown[];
  headSeq: number;
};
const sessions = (window as unknown as { __ssfAlligators: { sessions: Map<string, Session> } })
  .__ssfAlligators.sessions;

const TABLE = 'alligators-table-1';
const POSE = { x: 0, z: 0, rot: 0 as const };
const T = 1_800_000_000_000;

function handle() {
  return {
    setHead: vi.fn(), setBall: vi.fn(), setSpin: vi.fn(), setDisplay: vi.fn(),
    layEgg: vi.fn(), update: vi.fn(),
  };
}

function joinRoom(): void {
  const doc = new Y.Doc();
  bindCasinoDoc(doc);
  bindGamesDoc(doc);
}

/** This page sits at `seat`, engaged, with a head at rest. */
function engage(st: Session, seat: number): void {
  st.engaged = {
    seat, pose: { swing: 0, ext: 0 }, aim: 0, biteT: null, lunge: false, landed: false,
    pushes: [], pushSinceClick: 0, locked: true,
  };
}

/** Run frames at 60 fps from the current fake time for `ms`. */
function run(ms: number): void {
  const frames = Math.ceil(ms / (1000 / 60));
  for (let i = 0; i < frames; i++) {
    vi.setSystemTime(Date.now() + 1000 / 60);
    alligatorsFrame(1 / 60);
  }
}

/** A versus round: this page at seat 0, a peer at seat 3. */
function versus(): { st: Session; h: ReturnType<typeof handle> } {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T);
  joinRoom();
  const h = handle();
  registerAlligatorsVisual(TABLE, h, POSE);
  const me = getPlayerId();
  let s = claimSeat(initialAlligatorsState(), 0, me, alligatorsPage())!;
  s = claimSeat(s, 3, 'peer-player', 'peer-page')!;
  s = setReady(setReady(s, 0, me, true)!, 3, 'peer-player', true)!;
  writeGame(TABLE, startIfReady(s, T)!);
  const st = sessions.get(TABLE)!;
  engage(st, 0);
  return { st, h };
}

afterEach(() => {
  closeAlligatorsTable(TABLE);
  setAlligatorsSender(null);
  vi.useRealTimers();
});

describe('the operator', () => {
  it('lays each egg when its time comes, and sends the balls on lane kind 3', () => {
    const { st, h } = versus();
    const sent: Uint8Array[] = [];
    setAlligatorsSender((buf) => sent.push(buf));
    alligatorsFrame(1 / 60);
    expect(st.inSim.filter(Boolean)).toHaveLength(0);
    run(layTimeMs(7) + 100);
    expect(st.wasOperator).toBe(true);
    expect(st.inSim.slice(0, 8).every(Boolean)).toBe(true);
    expect(st.inSim[8]).toBe(false);
    expect(h.layEgg).toHaveBeenCalled();
    const kinds = sent.map((b) => tickKind(unpackTick(b).flags));
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.every((k) => k === TICK_KIND_ALLIGATORS)).toBe(true);
  });

  it("eats what lies under its own jaw when it lands — one doc write", () => {
    const { st } = versus();
    run(IA_LAY_START_MS + 200);
    const m = mouthOf(0, { swing: 0, ext: 0 });
    st.balls[0] = { x: m.x, z: m.z, vx: 0, vz: 0 };
    (st.engaged as { biteT: number | null }).biteT = 0;
    run(IA_BITE_DONE_S * 1000);
    const s = readAlligators(TABLE)!;
    expect(s.eaten[0]).toBe(0);
    expect(s.eaten.filter((e) => e !== IA_LIVE)).toHaveLength(1);
  });

  it("eats for a peer whose head tick says its jaw came down", () => {
    const { st } = versus();
    run(IA_LAY_START_MS + 200);
    const m = mouthOf(3, { swing: 0, ext: 0 });
    st.balls[0] = { x: m.x, z: m.z, vx: 0, vz: 0 };
    routeAlligatorsTick('peer', headToTick({ x: m.x, z: m.z, seat: 3, jawDown: false, seq: 1 }));
    routeAlligatorsTick('peer', headToTick({ x: m.x, z: m.z, seat: 3, jawDown: true, seq: 2 }));
    alligatorsFrame(1 / 60);
    expect(readAlligators(TABLE)!.eaten[0]).toBe(3);
    // The jaw held down (more ticks, same bite) eats nothing more.
    st.balls[1] = { x: m.x, z: m.z, vx: 0, vz: 0 };
    routeAlligatorsTick('peer', headToTick({ x: m.x, z: m.z, seat: 3, jawDown: true, seq: 3 }));
    alligatorsFrame(1 / 60);
    expect(readAlligators(TABLE)!.eaten[1]).toBe(IA_LIVE);
  });

  it('keeps its own balls when its frames come back after a stall', () => {
    const { st } = versus();
    run(IA_LAY_START_MS + 300);
    st.balls[0] = { x: 0.1, z: 0.2, vx: 0, vz: 0 };
    alligatorsFrame(1 / 60);
    const before = { ...st.balls[0] };
    vi.setSystemTime(Date.now() + 5000); // a hidden tab: no frames for 5 s
    alligatorsFrame(1 / 60);
    expect(st.wasOperator).toBe(true);
    expect(st.balls[0].x).toBeCloseTo(before.x, 2);
    expect(st.balls[0].z).toBeCloseTo(before.z, 2);
  });

  it('drops peer landings queued while its frames were stalled', () => {
    const { st } = versus();
    run(IA_LAY_START_MS + 300);
    const m = mouthOf(3, { swing: 0, ext: 0 });
    st.balls[0] = { x: m.x, z: m.z, vx: 0, vz: 0 };
    routeAlligatorsTick('peer', headToTick({ x: m.x, z: m.z, seat: 3, jawDown: false, seq: 1 }));
    vi.setSystemTime(Date.now() + 5000); // a hidden tab: ticks still arrive
    routeAlligatorsTick('peer', headToTick({ x: m.x, z: m.z, seat: 3, jawDown: true, seq: 2 }));
    alligatorsFrame(1 / 60);
    expect(readAlligators(TABLE)!.eaten[0]).toBe(IA_LIVE);
  });

  it("adopts the newer operator's ball over its own stale one on takeover", () => {
    const { st } = versus();
    run(IA_LAY_START_MS + 300);
    vi.setSystemTime(Date.now() + 5000);
    routeAlligatorsTick('peer', ballToTick({ x: -0.4, z: 0.3, heading: 0, speed: 0, index: 0, seq: 1 }));
    alligatorsFrame(1 / 60);
    expect(st.balls[0].x).toBeCloseTo(-0.4, 2);
    expect(st.balls[0].z).toBeCloseTo(0.3, 2);
  });

  it('hands the balls to the next seat up when the lower seat goes silent', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    joinRoom();
    registerAlligatorsVisual(TABLE, handle(), POSE);
    const me = getPlayerId();
    let s = claimSeat(initialAlligatorsState(), 1, 'peer-player', 'peer-page')!;
    s = claimSeat(s, 4, me, alligatorsPage())!;
    s = setReady(setReady(s, 1, 'peer-player', true)!, 4, me, true)!;
    writeGame(TABLE, startIfReady(s, T)!);
    const st = sessions.get(TABLE)!;
    engage(st, 4);
    const mouth = mouthOf(1, { swing: 0, ext: 0 });
    // Seat 1's head is live: it operates, not this page.
    for (let i = 0; i < 20; i++) {
      routeAlligatorsTick('peer', headToTick({ x: mouth.x, z: mouth.z, seat: 1, jawDown: false, seq: i + 1 }));
      run(50);
    }
    expect(st.wasOperator).toBe(false);
    run(1200); // seat 1 silent past the takeover grace
    expect(st.wasOperator).toBe(true);
  });
});

describe('a spectator', () => {
  it("shows the operator's ball ticks, and hides an eaten ball", () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    joinRoom();
    const h = handle();
    registerAlligatorsVisual(TABLE, h, POSE);
    const s = startPractice(claimSeat(initialAlligatorsState(), 2, 'peer-player', 'peer-page')!, 2, 'peer-player', T)!;
    writeGame(TABLE, s);
    alligatorsFrame(1 / 60);
    routeAlligatorsTick('peer', ballToTick({ x: 0.3, z: -0.2, heading: 0, speed: 0, index: 4, seq: 1 }));
    h.setBall.mockClear();
    alligatorsFrame(1 / 60);
    expect(h.setBall).toHaveBeenCalledWith(4, expect.any(Number), expect.any(Number), true);
    writeGame(TABLE, { ...s, eaten: s.eaten.map((e, k) => (k === 4 ? 2 : e)) });
    h.setBall.mockClear();
    alligatorsFrame(1 / 60);
    expect(h.setBall).toHaveBeenCalledWith(4, 0, 0, false);
  });

  it('folds up exactly the claimed heads', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    joinRoom();
    const h = handle();
    registerAlligatorsVisual(TABLE, h, POSE);
    writeGame(TABLE, claimSeat(initialAlligatorsState(), 5, 'someone', 'page')!);
    alligatorsFrame(1 / 60);
    const raised = h.setHead.mock.calls.filter((c) => c[1] === true).map((c) => c[0]);
    expect(raised).toEqual([5]);
    const lit = h.setDisplay.mock.calls.filter((c) => c[2] === true).map((c) => c[0]);
    expect(lit).toEqual([5]);
  });
});

describe('sessions across a room change', () => {
  it("start afresh when the next room's doc is bound", () => {
    const { st } = versus();
    run(IA_LAY_START_MS + 500);
    expect(st.wasOperator).toBe(true);
    joinRoom();
    alligatorsFrame(1 / 60);
    const after = sessions.get(TABLE)!;
    expect(after).not.toBe(st);
    expect(after.engaged).toBeNull();
    expect(after.balls).toEqual([]);
    expect(after.headSeq).toBe(0);
  });
});

describe('the status line', () => {
  it('walks a round from seating to the winner', () => {
    expect(alligatorsStatusLine(null, 0)).toBe('TAKE A SEAT TO PLAY');
    const one = claimSeat(initialAlligatorsState(), 0, 'a', 'pa')!;
    expect(alligatorsStatusLine(one, 0)).toMatch(/WAITING FOR PLAYERS/);
    const two = claimSeat(one, 1, 'b', 'pb')!;
    expect(alligatorsStatusLine(two, 0)).toBe('READY UP TO START');
    const live = startIfReady(setReady(setReady(two, 0, 'a', true)!, 1, 'b', true)!, 1)!;
    expect(alligatorsStatusLine(live, 0)).toMatch(/LAYING/);
    expect(alligatorsStatusLine(live, 5000)).toBe('20 BALLS LEFT');
    expect(alligatorsStatusLine(live, 10_500)).toBe('THE TABLE SPINS!');
    const won = { ...live, status: 'ended' as const, winners: [1] };
    expect(alligatorsStatusLine(won, 0)).toBe('ORANGE WINS');
  });
});
