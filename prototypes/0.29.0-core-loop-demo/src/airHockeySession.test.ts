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
const { bindGamesDoc } = await import('./games/gamesDoc');
const { airHockeyFrame, closeAirHockeyTable, registerAirHockeyVisual, routeAirHockeyTick } = await import('./airHockeySession');
const { malletToTick } = await import('./games/airHockey');

type Session = {
  handle: unknown;
  docEpoch: number;
  remotePuck: unknown;
  remoteMallet: { a: { seq: number; [field: string]: unknown } | null; b: unknown };
  wasOperator: boolean;
  malletSeq: number;
  puckSeq: number;
};
const sessions = (window as unknown as { __ssfAirHockey: { sessions: Map<string, Session> } })
  .__ssfAirHockey.sessions;

const TABLE = 'air-hockey-table-1';
const POSE = { x: 0, z: 0, rot: 0 as const };

function handle() {
  return { setMallet: vi.fn(), setPuck: vi.fn(), setScore: vi.fn(), flashGoal: vi.fn(), update: vi.fn() };
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

afterEach(() => closeAirHockeyTable(TABLE));

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
