/**
 * 🏒 airHockeySession: a table's session belongs to the room doc it began in
 * (#116 review). The registry outlives a room change, and the next room can
 * hold a table with the same id, so nothing transient (remote samples,
 * operator state, sequence counters, engaged input) may carry over to the
 * new room's doc.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// The module publishes a debug handle on `window` when it loads (and
// furniture.ts reads the page's query string).
vi.stubGlobal('window', { location: { search: '' } });

const { bindCasinoDoc } = await import('./casinoDoc');
const { bindGamesDoc, readAirHockey, writeGame } = await import('./games/gamesDoc');
const { getPlayerId } = await import('./identity');
const {
  airHockeyFrame, airHockeySeat, closeAirHockeyTable, registerAirHockeyVisual, routeAirHockeyTick,
  setAirHockeySender,
} = await import('./airHockeySession');
const {
  AH_GOAL_PAUSE_MS, AH_SERVE_DELAY_MS, claimSide, initialAirHockeyState, malletToTick, puckToTick,
  setReady, startIfReady, startPractice, takeSeat,
} = await import('./games/airHockey');

type Session = {
  handle: unknown;
  docEpoch: number;
  remotePuck: { seq: number; [field: string]: unknown } | null;
  puck: { x: number; z: number; vx: number; vz: number };
  remoteMallet: { a: { seq: number; [field: string]: unknown } | null; b: unknown };
  wasOperator: boolean;
  malletSeq: number;
  puckSeq: number;
  puckActive: boolean;
  engaged: unknown;
};
const sessions = (window as unknown as { __ssfAirHockey: { sessions: Map<string, Session> } })
  .__ssfAirHockey.sessions;

const TABLE = 'air-hockey-table-1';
const POSE = { x: 0, z: 0, rot: 0 as const };

function handle() {
  return {
    setMallet: vi.fn(), setPuck: vi.fn(), setScore: vi.fn(), flashGoal: vi.fn(), update: vi.fn(),
    // 🎨 #184: the skin is the builder's business, never the session's —
    // asserted below (the session must not repaint a table under the players).
    setTheme: vi.fn(),
  };
}

/** Join a room: bind both docs to a fresh one, as main.ts does. */
function joinRoom(): void {
  const doc = new Y.Doc();
  bindCasinoDoc(doc);
  bindGamesDoc(doc);
}

/** Give a session the transient state a live match leaves behind. */
function play(st: Session): void {
  st.remotePuck = { x: 0.1, z: 0.2, vx: 1, vz: 0, active: true, at: 1, seq: 9 };
  st.remoteMallet.a = { x: 0, z: -0.5, down: true, at: 1, seq: 7 };
  st.wasOperator = true;
  st.malletSeq = 42;
  st.puckSeq = 17;
}

function expectFresh(st: Session | undefined, h: unknown): void {
  expect(st).toBeDefined();
  expect(st!.handle).toBe(h);
  expect(st!.remotePuck).toBeNull();
  expect(st!.remoteMallet).toEqual({ a: null, b: null });
  expect(st!.wasOperator).toBe(false);
  expect(st!.malletSeq).toBe(0);
  expect(st!.puckSeq).toBe(0);
}

afterEach(() => {
  closeAirHockeyTable(TABLE);
  setAirHockeySender(null);
  vi.useRealTimers();
});

describe('air-hockey sessions across a room change', () => {
  it('keep their match state when the table is rebuilt in the same room', () => {
    joinRoom();
    registerAirHockeyVisual(TABLE, handle(), POSE);
    const st = sessions.get(TABLE)!;
    play(st);
    const rebuilt = handle();
    registerAirHockeyVisual(TABLE, rebuilt, POSE);
    expect(sessions.get(TABLE)).toBe(st);
    expect(st.handle).toBe(rebuilt);
    expect(st.malletSeq).toBe(42);
  });

  it("start afresh when a table with the same id is registered in the next room's doc", () => {
    joinRoom();
    registerAirHockeyVisual(TABLE, handle(), POSE);
    play(sessions.get(TABLE)!);
    joinRoom();
    const built = handle();
    registerAirHockeyVisual(TABLE, built, POSE);
    expectFresh(sessions.get(TABLE), built);
  });

  it("start afresh on the next frame when the next room's reconcile keeps the built table", () => {
    joinRoom();
    const kept = handle();
    registerAirHockeyVisual(TABLE, kept, POSE);
    const before = sessions.get(TABLE)!;
    play(before);
    joinRoom(); // the same id in the new layout: no remove, no register
    airHockeyFrame(0.016);
    const after = sessions.get(TABLE);
    expect(after).not.toBe(before);
    expectFresh(after, kept);
  });

  it("route a peer's tick that arrives before that frame to the fresh session", () => {
    joinRoom();
    registerAirHockeyVisual(TABLE, handle(), POSE);
    play(sessions.get(TABLE)!);
    joinRoom();
    routeAirHockeyTick('peer', malletToTick({ x: 0.1, z: -0.4, down: true, seq: 3 }));
    airHockeyFrame(0.016);
    expect(sessions.get(TABLE)!.remoteMallet.a?.seq).toBe(3);
  });
});

describe('air-hockey serves', () => {
  const T = 1_800_000_000_000;
  const longestWait = Math.max(AH_SERVE_DELAY_MS, AH_GOAL_PAUSE_MS);

  /** This page plays side a of a solo practice whose serve deadline a peer's
   *  clock wrote, `aheadMs` ahead of this page's. */
  function practiceScheduledAhead(aheadMs: number): Session {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    joinRoom();
    registerAirHockeyVisual(TABLE, handle(), POSE);
    const me = getPlayerId();
    const claimed = claimSide(initialAirHockeyState(), 'a', me, airHockeySeat())!;
    writeGame(TABLE, startPractice(claimed, 'a', me, T + aheadMs)!);
    const st = sessions.get(TABLE)!;
    st.engaged = { side: 'a', x: 0, z: -0.9, vx: 0, vz: 0, prevX: 0, prevZ: -0.9, down: false, locked: false };
    return st;
  }

  it("fall due on this page's clock, at most the longest serve wait after it first sees them scheduled", () => {
    const st = practiceScheduledAhead(5 * 60_000); // a peer clock five minutes ahead
    airHockeyFrame(0.016); // first sight of the schedule
    expect(st.puckActive).toBe(false);
    vi.setSystemTime(T + longestWait - 1);
    airHockeyFrame(0.016);
    expect(st.puckActive).toBe(false);
    vi.setSystemTime(T + longestWait);
    airHockeyFrame(0.016);
    expect(st.puckActive).toBe(true);
  });

  it('keep a deadline that falls due sooner', () => {
    const st = practiceScheduledAhead(0); // written on this page's clock
    airHockeyFrame(0.016);
    vi.setSystemTime(T + AH_SERVE_DELAY_MS - 1);
    airHockeyFrame(0.016);
    expect(st.puckActive).toBe(false);
    vi.setSystemTime(T + AH_SERVE_DELAY_MS);
    airHockeyFrame(0.016);
    expect(st.puckActive).toBe(true);
  });
});

describe("a player's other pages at one end (#116 review)", () => {
  const T = 1_800_000_000_000;

  /** This player's practice at end a, played from `seat`, with this page
   *  engaged on that end too. */
  function practiceFrom(seat: string): Session {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    joinRoom();
    registerAirHockeyVisual(TABLE, handle(), POSE);
    const me = getPlayerId();
    writeGame(TABLE, startPractice(claimSide(initialAirHockeyState(), 'a', me, seat)!, 'a', me, T)!);
    const st = sessions.get(TABLE)!;
    st.engaged = { side: 'a', x: 0, z: -0.9, vx: 0, vz: 0, prevX: 0, prevZ: -0.9, down: false, locked: false };
    return st;
  }

  function sent(): Uint8Array[] {
    const out: Uint8Array[] = [];
    setAirHockeySender((buf) => out.push(buf));
    return out;
  }

  it('leave the end to the page that plays it: no puck, no ticks, no writes', () => {
    const st = practiceFrom('another-tab');
    const ticks = sent();
    const before = JSON.stringify(readAirHockey(TABLE));
    for (let i = 0; i < 5; i++) {
      vi.setSystemTime(T + AH_SERVE_DELAY_MS + i * 100);
      airHockeyFrame(0.1);
    }
    expect(st.wasOperator).toBe(false);
    expect(st.puckActive).toBe(false);
    expect(ticks).toHaveLength(0);
    expect(JSON.stringify(readAirHockey(TABLE))).toBe(before);
  });

  it('play it once this page takes the seat', () => {
    const st = practiceFrom('another-tab');
    const ticks = sent();
    writeGame(TABLE, takeSeat(readAirHockey(TABLE)!, 'a', getPlayerId(), airHockeySeat())!);
    vi.setSystemTime(T + AH_SERVE_DELAY_MS);
    airHockeyFrame(0.1);
    expect(st.wasOperator).toBe(true);
    expect(st.puckActive).toBe(true);
    expect(ticks.length).toBeGreaterThan(0);
  });

  it("show the mallet of the page that plays this page's end", () => {
    practiceFrom('another-tab');
    routeAirHockeyTick('other-tab', malletToTick({ x: 0.1, z: -0.4, down: true, seq: 3 }));
    expect(sessions.get(TABLE)!.remoteMallet.a?.seq).toBe(3);
  });

  it('ignore an echo of the end this page plays', () => {
    practiceFrom(airHockeySeat());
    routeAirHockeyTick('echo', malletToTick({ x: 0.1, z: -0.4, down: true, seq: 3 }));
    expect(sessions.get(TABLE)!.remoteMallet.a).toBeNull();
  });
});

describe('a page whose frames stalled mid-match (#116 review)', () => {
  const T = 1_800_000_000_000;
  const served = T + AH_SERVE_DELAY_MS;

  /** A versus match this page plays as side a (the default operator), with
   *  its first serve live. */
  function operatingSideA(): Session {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    joinRoom();
    registerAirHockeyVisual(TABLE, handle(), POSE);
    const me = getPlayerId();
    let s = claimSide(initialAirHockeyState(), 'a', me, airHockeySeat())!;
    s = claimSide(s, 'b', 'peer-b', 'seat-b')!;
    s = setReady(setReady(s, 'a', me)!, 'b', 'peer-b')!;
    writeGame(TABLE, startIfReady(s, T)!);
    const st = sessions.get(TABLE)!;
    st.engaged = { side: 'a', x: 0, z: -0.9, vx: 0, vz: 0, prevX: 0, prevZ: -0.9, down: false, locked: false };
    airHockeyFrame(0.016);
    vi.setSystemTime(served);
    airHockeyFrame(0.016);
    return st;
  }

  /** Side b's puck after it took over: in b's half, heading for b's goal. */
  const takeover = { x: 0.3, z: 0.6, heading: Math.PI / 2, speed: 1, active: true, seq: 7 };

  it('keep the puck of the page that took over, and adopt it when frames resume', () => {
    const st = operatingSideA();
    expect(st.wasOperator).toBe(true);
    expect(st.puck.z).toBeLessThan(0); // served into side a's half
    vi.setSystemTime(served + 3000); // three seconds without a frame
    routeAirHockeyTick('peer-b', puckToTick(takeover));
    expect(st.remotePuck?.seq).toBe(7);
    vi.setSystemTime(served + 3050);
    airHockeyFrame(0.05);
    expect(st.wasOperator).toBe(true);
    expect(st.puck.x).toBeCloseTo(0.3, 1);
    expect(st.puck.z).toBeGreaterThan(0.5); // side b's puck, not this page's stale one
  });

  it('still ignore other pucks while its frames run', () => {
    const st = operatingSideA();
    vi.setSystemTime(served + 100);
    routeAirHockeyTick('peer-b', puckToTick(takeover));
    expect(st.remotePuck).toBeNull();
  });

  it('bring the mallet back at rest, so a swing from before the stall strikes nothing', () => {
    const st = operatingSideA();
    const input = st.engaged as { x: number; vx: number; vz: number };
    input.vx = 6; // a swing in progress when the frames stopped
    input.vz = 6;
    vi.setSystemTime(served + 3000); // three seconds without a frame…
    input.x += 0.2; // …while the mallet moved
    airHockeyFrame(0.05);
    expect(input.vx).toBe(0);
    expect(input.vz).toBe(0);
  });
});

describe('a goal and a forfeit falling due in the same frame (#116 review)', () => {
  const T = 1_800_000_000_000;
  const served = T + AH_SERVE_DELAY_MS;

  /** Side a operates a versus match at `scoreA`–0; side b has been silent past
   *  the forfeit timeout, and the puck is about to cross b's goal line. */
  function goalAndForfeitDue(scoreA: number): void {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    joinRoom();
    registerAirHockeyVisual(TABLE, handle(), POSE);
    const me = getPlayerId();
    let s = claimSide(initialAirHockeyState(), 'a', me, airHockeySeat())!;
    s = claimSide(s, 'b', 'peer-b', 'seat-b')!;
    s = setReady(setReady(s, 'a', me)!, 'b', 'peer-b')!;
    writeGame(TABLE, { ...startIfReady(s, T)!, score: { a: scoreA, b: 0 } });
    const st = sessions.get(TABLE)!;
    st.engaged = { side: 'a', x: 0, z: -0.9, vx: 0, vz: 0, prevX: 0, prevZ: -0.9, down: false, locked: false };
    airHockeyFrame(0.016);
    vi.setSystemTime(served);
    airHockeyFrame(0.016);
    (st as unknown as { lastMalletAt: { a: number; b: number } }).lastMalletAt.b = served - 10_500;
    st.puck = { x: 0, z: 1.3, vx: 0, vz: 3 };
    st.puckActive = true;
    vi.setSystemTime(served + 16);
  }

  it('keep the goal: the walkover is written on top of it', () => {
    goalAndForfeitDue(2);
    airHockeyFrame(0.05);
    const s = readAirHockey(TABLE)!;
    expect(s.status).toBe('ended');
    expect(s.winner).toBe('a');
    expect(s.score).toEqual({ a: 3, b: 0 });
  });

  it('leave a match the goal won as the goal left it', () => {
    goalAndForfeitDue(6);
    airHockeyFrame(0.05);
    const s = readAirHockey(TABLE)!;
    expect(s.status).toBe('ended');
    expect(s.winner).toBe('a');
    expect(s.score).toEqual({ a: 7, b: 0 });
  });
});
