/**
 * ⏱ A manual craps turn on the operator page (a venture room: no robot) when
 * that page's clock goes back. The stickman throws for a shooter who never
 * does once the turn's deadline comes, a deadline this page wrote on its own
 * clock: one further off than the whole turn is cut back to it
 * (timerOnThisClock), so the throw comes a window (and a wake) after the
 * step, not when the clock comes round.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.stubGlobal('window', { location: { search: '' } });

const {
  bindCasinoDoc, buyInChips, readCrapsTableState, readDiceThrow, writeMyCrapsBets, writeMySeat,
} = await import('./casinoDoc');
const { setSoleCroupierPredicate, noteTablesRunning, TABLE_LEASE_LAPSE_MS } = await import('./croupier');
const { CRAPS_SHOOTER_MS, pressManualRoll, tickManualCraps } = await import('./crapsCroupier');
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
