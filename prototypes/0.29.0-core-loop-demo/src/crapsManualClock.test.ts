/**
 * ⏱ A manual craps turn on the operator page (a venture room: no robot) when
 * that page's clock goes back. The stickman throws for a shooter who never
 * does once the turn's deadline comes, a deadline this page wrote on its own
 * clock: one further off than the whole turn is cut back to it
 * (timerOnThisClock), so the throw comes a window (and a wake) after the
 * step, not when the clock comes round. And the wait for this page's stamp
 * as operator to reach the room: a step back of under a second (no wake)
 * takes the stamp back with it, so the wait runs its whole length.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.stubGlobal('window', { location: { search: '' } });

const {
  bindCasinoDoc, buyInChips, readCrapsTableState, readDiceThrow, writeMyCrapsBets, writeMySeat,
} = await import('./casinoDoc');
const {
  setSoleCroupierPredicate, noteTablesRunning, takeTableTurn, TABLE_LEASE_LAPSE_MS, TABLE_LEASE_SETTLE_MS,
} = await import('./croupier');
const {
  CRAPS_SHOOTER_MS, CRAPS_SHOW_MS, MANUAL_TAKEOVER_SETTLE_MS, pressManualRoll, tickAutoStickman, tickManualCraps,
} = await import('./crapsCroupier');
const { FURNITURE_DEFS } = await import('./furniture');

const T0 = 2_000_000_000;
const HOUR = 3_600_000;
const BOB = 'player-Bob';
const STAND = FURNITURE_DEFS['craps-table'].stands!.findIndex((s) => !s.role);

let n = 0;
const freshTable = (): string => `craps-clock-${++n}`;

function at(t: number): number {
  vi.setSystemTime(t);
  return t;
}

/** One World frame on this (manual, editor) page: the tables are marked
 *  running, then the manual turn ticks. */
function frame(tableId: string, t: number): void {
  at(t);
  noteTablesRunning(t);
  tickManualCraps(tableId, t);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  bindCasinoDoc(new Y.Doc());
  setSoleCroupierPredicate(() => false); // a manual (venture) room
  buyInChips(BOB, 100);
});

afterEach(() => {
  setSoleCroupierPredicate(() => true);
  vi.useRealTimers();
});

/** The table closed by this page's ROLL, the dice with Bob (who never throws). */
function rollToBob(t: string): void {
  expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/); // window opens
  writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 5 }]);
  writeMySeat(t, BOB, { stand: STAND, angle: 0, at: 1 });
  frame(t, T0);
  writeMySeat(t, BOB, { stand: STAND, angle: 0, at: 2 });
  frame(t, T0 + 1_200);
  expect(pressManualRoll(t, at(T0 + 1_300))).toBeNull();
  expect(readCrapsTableState(t)).toMatchObject({ phase: 'closing', shooter: BOB });
}

describe("a manual shooter's window on the operator page", () => {
  it('control: with a steady clock the stickman throws as the window ends', () => {
    const t = freshTable();
    rollToBob(t);
    let threwAt = -1;
    for (let now = T0 + 1_400; now <= T0 + 1_300 + CRAPS_SHOOTER_MS + 1_000; now += 100) {
      writeMySeat(t, BOB, { stand: STAND, angle: 0, at: now });
      frame(t, now);
      if (threwAt < 0 && readDiceThrow(t)?.by === 'stickman') threwAt = now - (T0 + 1_300);
    }
    expect(threwAt).toBe(CRAPS_SHOOTER_MS);
  });

  it('times the shooter out a window after the clock went back an hour, not an hour later', async () => {
    const t = freshTable();
    expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/); // window opens
    writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 5 }]);
    writeMySeat(t, BOB, { stand: STAND, angle: 0, at: 1 });
    frame(t, T0);
    writeMySeat(t, BOB, { stand: STAND, angle: 0, at: 2 }); // Bob's heartbeat moves
    frame(t, T0 + 1_200);
    expect(pressManualRoll(t, at(T0 + 1_300))).toBeNull();
    expect(readCrapsTableState(t)).toMatchObject({ phase: 'closing', shooter: BOB });
    // Bob never throws. Five seconds in, this page's clock goes back an hour
    // (a correction, a manual change): a wake, a lapse's hold, and then the
    // turn runs its course on this clock.
    for (let now = T0 + 1_400; now <= T0 + 5_000; now += 100) frame(t, now);
    const back = T0 + 5_100 - HOUR;
    let threwAt = -1;
    for (let now = back; now <= back + CRAPS_SHOOTER_MS + 3 * TABLE_LEASE_LAPSE_MS; now += 100) {
      // Bob's page keeps heartbeating his seat.
      writeMySeat(t, BOB, { stand: STAND, angle: 0, at: now });
      frame(t, now);
      if (threwAt < 0 && readDiceThrow(t)?.by === 'stickman') threwAt = now - back;
    }
    expect(threwAt).toBeGreaterThan(0);
    expect(threwAt).toBeLessThanOrEqual(CRAPS_SHOOTER_MS + TABLE_LEASE_LAPSE_MS + 200);
  });
});

describe('ROLL pressed again while the stamp reaches the room (the stickman throws once it has)', () => {
  for (const [what, step] of [['a steady clock (control)', 0], ['a clock that steps back 300 ms', 300]] as const) {
    it(`(${what}) waits the stamp's whole wait before the throw`, () => {
      const t = freshTable();
      expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/);
      writeMyCrapsBets(t, BOB, [{ type: 'field', amount: 5 }]);
      frame(t, T0 + 100);
      expect(pressManualRoll(t, at(T0 + 200))).toBeNull(); // closes, stamps this page
      expect(readCrapsTableState(t)?.phase).toBe('closing');
      expect(pressManualRoll(t, at(T0 + 250))).toBeNull(); // again: throw once converged
      let threwAfter = -1;
      for (let real = T0 + 300; real <= T0 + 5_000 && threwAfter < 0; real += 50) {
        frame(t, real - step); // the step comes 100 ms after the close
        if (readDiceThrow(t)?.by === 'stickman') threwAfter = real - (T0 + 200);
      }
      expect(threwAfter).toBeGreaterThanOrEqual(MANUAL_TAKEOVER_SETTLE_MS);
    });
  }

  it('(pressed again just after the clock steps back 300 ms, before the next frame) waits the stamp out before the throw', () => {
    const t = freshTable();
    expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/);
    writeMyCrapsBets(t, BOB, [{ type: 'field', amount: 5 }]);
    frame(t, T0 + 100);
    expect(pressManualRoll(t, at(T0 + 200))).toBeNull(); // closes, stamps this page
    expect(readCrapsTableState(t)?.phase).toBe('closing');
    expect(pressManualRoll(t, at(T0 + 250 - 300))).toBeNull(); // the press lands first
    expect(readDiceThrow(t)).toBeNull();
    let threwAfter = -1;
    for (let real = T0 + 300; real <= T0 + 5_000 && threwAfter < 0; real += 50) {
      frame(t, real - 300);
      if (readDiceThrow(t)?.by === 'stickman') threwAfter = real - (T0 + 200);
    }
    expect(threwAfter).toBeGreaterThanOrEqual(MANUAL_TAKEOVER_SETTLE_MS - 300);
  });
});

describe('ROLL pressed again on one of the owner\'s pages just before it starts driving the tables', () => {
  /** One World frame on a page of the deed holder's: the driver ticks the
   *  robot, any other page the manual turn. */
  function ownerFrame(tableId: string, t: number): void {
    at(t);
    noteTablesRunning(t);
    if (takeTableTurn(t)) tickAutoStickman(tableId);
    else tickManualCraps(tableId, t, CRAPS_SHOW_MS);
  }

  it('throws once the stamp has reached the room, not at the end of the shooter\'s window', () => {
    setSoleCroupierPredicate(() => true); // the robot's room
    const t = freshTable();
    expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/); // window opens
    writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 5 }]);
    writeMySeat(t, BOB, { stand: STAND, angle: 0, at: 1 });
    ownerFrame(t, T0); // claims the tables' lease: drives once it settles
    writeMySeat(t, BOB, { stand: STAND, angle: 0, at: 2 });
    ownerFrame(t, T0 + 1_200);
    expect(pressManualRoll(t, at(T0 + 1_300))).toBeNull(); // closes, stamps this page
    expect(readCrapsTableState(t)).toMatchObject({ phase: 'closing', shooter: BOB });
    expect(pressManualRoll(t, at(T0 + 1_400))).toBeNull(); // again: throw once converged
    expect(T0 + TABLE_LEASE_SETTLE_MS).toBeLessThan(T0 + 1_300 + MANUAL_TAKEOVER_SETTLE_MS);
    let threwAfter = -1;
    for (let now = T0 + 1_450; now <= T0 + 1_300 + CRAPS_SHOOTER_MS + 1_000 && threwAfter < 0; now += 50) {
      writeMySeat(t, BOB, { stand: STAND, angle: 0, at: now });
      ownerFrame(t, now);
      if (readDiceThrow(t)?.by === 'stickman') threwAfter = now - (T0 + 1_300);
    }
    expect(threwAfter).toBeGreaterThanOrEqual(MANUAL_TAKEOVER_SETTLE_MS);
    expect(threwAfter).toBeLessThan(MANUAL_TAKEOVER_SETTLE_MS + 500);
  });
});
