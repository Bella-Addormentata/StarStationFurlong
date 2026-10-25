/**
 * 🎲 crapsCroupier's manual-table lifecycle (#226), against a real Yjs-backed
 * casino map: who counts as seated, the house's ROLL, the shooter's turn and
 * its timeout, and the one-operator rule that keeps two shareholders from
 * settling the same roll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

// Modules under test hang debug handles on window when they load.
vi.stubGlobal('window', { location: { search: '' } });

const {
  bindCasinoDoc, buyInChips, readCrapsTableState, readDiceThrow, writeCrapsTableState,
  writeDiceThrow, writeMyCrapsBets, writeMySeat,
} = await import('./casinoDoc');
const { setSoleCroupierPredicate } = await import('./croupier');
const {
  CRAPS_SHOOTER_MS, MANUAL_TAKEOVER_MS, markLocalSeat, pressManualRoll, sampleSeats, SEAT_CONFIRM_MS, SEAT_STALE_MS,
  seatedPlayers, tickManualCraps,
} = await import('./crapsCroupier');
const { FURNITURE_DEFS } = await import('./furniture');
const { getPlayerId } = await import('./identity');
type CrapsTableState = import('./games/craps').CrapsTableState;

const T0 = 2_000_000_000;
const ME = getPlayerId();
const BOB = 'player-Bob';
/** A real player stand on the craps table (not the stickman's). */
const STAND = FURNITURE_DEFS['craps-table'].stands!.findIndex((s) => !s.role);

let tableN = 0;
/** A fresh table id per test: the croupier's per-table memory is module-wide. */
const freshTable = (): string => `craps-test-${++tableN}`;

function at(t: number): number {
  vi.setSystemTime(t);
  return t;
}

function seat(tableId: string, pid: string, beat: number): void {
  writeMySeat(tableId, pid, { stand: STAND, angle: 0, at: beat });
}

/** Let the async settle (fairness hashing) run out. */
async function settled(tableId: string): Promise<CrapsTableState | null> {
  for (let i = 0; i < 50; i++) {
    if (readCrapsTableState(tableId)?.phase === 'settled') break;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return readCrapsTableState(tableId);
}

function closing(tableId: string, operator: string, round = 1): CrapsTableState {
  const s: CrapsTableState = {
    kind: 'craps', phase: 'closing', round, point: null, dice: null, result: null,
    resultAt: 0, payouts: null, phaseDeadline: Date.now() + CRAPS_SHOOTER_MS, operator,
  };
  writeCrapsTableState(tableId, s);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(T0);
  bindCasinoDoc(new Y.Doc());
  setSoleCroupierPredicate(() => false); // a manual (venture) room
  buyInChips(BOB, 100);
  buyInChips(ME, 100);
});

afterEach(() => {
  setSoleCroupierPredicate(() => true);
  vi.useRealTimers();
});

describe('who is at the table', () => {
  it('counts a seat once its heartbeat moves, and drops it once it stops', () => {
    const t = freshTable();
    seat(t, BOB, 1);
    expect(seatedPlayers(t, at(T0))).toEqual([]);
    seat(t, BOB, 2);
    expect(seatedPlayers(t, at(T0 + 5_000)).map((p) => p.pid)).toEqual([BOB]);
    expect(seatedPlayers(t, at(T0 + 5_000 + SEAT_STALE_MS))).toEqual([]);
  });

  it("counts this page's own seat at once", () => {
    const t = freshTable();
    seat(t, ME, 1);
    markLocalSeat(t, ME, true);
    expect(seatedPlayers(t, at(T0)).map((p) => p.pid)).toEqual([ME]);
    markLocalSeat(t, ME, false);
  });

  it('a seat seen to move just before the clock went back an hour goes stale a stale time after, not an hour', () => {
    const t = freshTable();
    const HOUR = 3_600_000;
    seat(t, BOB, 1);
    seatedPlayers(t, at(T0 + HOUR));
    seat(t, BOB, 2);
    expect(seatedPlayers(t, at(T0 + HOUR + 1_000)).map((p) => p.pid)).toEqual([BOB]);
    expect(seatedPlayers(t, at(T0 + 2_000)).map((p) => p.pid)).toEqual([BOB]); // the clock went back
    expect(seatedPlayers(t, at(T0 + 2_000 + SEAT_STALE_MS))).toEqual([]);
  });

  it('keeps sampling the seats after the clock went back', () => {
    const t = freshTable();
    const HOUR = 3_600_000;
    seat(t, BOB, 1);
    sampleSeats(t, at(T0 + HOUR));
    seat(t, BOB, 2);
    sampleSeats(t, at(T0 + 2_000)); // the clock went back: this look still counts
    expect(seatedPlayers(t, at(T0 + 2_000 + SEAT_STALE_MS))).toEqual([]); // and nothing moved since
  });

  it('starts over in another room doc', () => {
    const t = freshTable();
    seat(t, BOB, 1);
    seatedPlayers(t, at(T0));
    seat(t, BOB, 2);
    expect(seatedPlayers(t, at(T0 + 1_000))).toHaveLength(1);
    bindCasinoDoc(new Y.Doc());
    seat(t, BOB, 2);
    expect(seatedPlayers(t, at(T0 + 2_000))).toEqual([]);
  });
});

describe("the house's ROLL", () => {
  it('opens round 1 on a table nobody has run, then slides the dice out under this page', () => {
    const t = freshTable();
    expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/); // bets go down on an open table
    expect(readCrapsTableState(t)).toMatchObject({ phase: 'betting', round: 1 });
    expect(pressManualRoll(t, at(T0))).toBeNull();
    const s = readCrapsTableState(t)!;
    expect(s.phase).toBe('closing');
    expect(s.round).toBe(1);
    expect(typeof s.operator).toBe('string');
    expect(s.shooter).toBeUndefined(); // nobody seated: the stickman throws
  });

  it('waits for a newly seen line bettor, then hands them the dice', () => {
    const t = freshTable();
    expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/); // the window opens first
    writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 5 }]);
    seat(t, BOB, 1);
    expect(pressManualRoll(t, at(T0))).toMatch(/CHECKING WHO IS AT THE TABLE/);
    expect(readCrapsTableState(t)?.phase).toBe('betting');
    seat(t, BOB, 2);
    expect(pressManualRoll(t, at(T0 + 5_000))).toBeNull();
    expect(readCrapsTableState(t)?.shooter).toBe(BOB);
  });

  it('waits for a line bettor first seen just before the clock went back a confirm time, not an hour', () => {
    const t = freshTable();
    const HOUR = 3_600_000;
    expect(pressManualRoll(t, at(T0 + HOUR))).toMatch(/PRESS AGAIN/);
    writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 5 }]);
    seat(t, BOB, 1);
    expect(pressManualRoll(t, at(T0 + HOUR))).toMatch(/CHECKING WHO IS AT THE TABLE/);
    expect(pressManualRoll(t, at(T0 + 1_000))).toMatch(/CHECKING WHO IS AT THE TABLE/); // the clock went back
    expect(pressManualRoll(t, at(T0 + 1_000 + SEAT_CONFIRM_MS))).toBeNull();
    expect(readCrapsTableState(t)?.phase).toBe('closing');
  });

  it('settles the shooter\'s throw on the operator page', async () => {
    const t = freshTable();
    expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/); // the window opens first
    writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 5 }]);
    seat(t, BOB, 1);
    tickManualCraps(t, at(T0));
    seat(t, BOB, 2);
    pressManualRoll(t, at(T0 + 2_000));
    const s = readCrapsTableState(t)!;
    writeDiceThrow(t, { round: s.round, by: BOB, sx: 0, sz: 0, dx: 0, dz: 1, power: 0.5, seed: 7 });
    // Not before the close's stamp has had time to converge: a rival
    // press's close may still win.
    tickManualCraps(t, at(T0 + 3_499));
    expect((await settled(t))?.phase).toBe('closing');
    tickManualCraps(t, at(T0 + 3_500));
    expect((await settled(t))?.phase).toBe('settled');
  });

  it('has the stickman throw when the shooter runs out of time', async () => {
    const t = freshTable();
    expect(pressManualRoll(t, at(T0))).toMatch(/PRESS AGAIN/); // the window opens first
    writeMyCrapsBets(t, BOB, [{ type: 'pass', amount: 5 }]);
    seat(t, BOB, 1);
    tickManualCraps(t, at(T0));
    seat(t, BOB, 2);
    pressManualRoll(t, at(T0 + 2_000));
    tickManualCraps(t, at(T0 + 2_000 + CRAPS_SHOOTER_MS - 1));
    expect(readCrapsTableState(t)?.phase).toBe('closing');
    tickManualCraps(t, at(T0 + 2_000 + CRAPS_SHOOTER_MS));
    expect(readDiceThrow(t)?.by).toBe('stickman');
    expect((await settled(t))?.phase).toBe('settled');
  });
});

describe('one operator per turn', () => {
  it("leaves another page's turn alone, however late by its deadline", () => {
    const t = freshTable();
    closing(t, 'someone-else:tab');
    tickManualCraps(t, at(T0 + CRAPS_SHOOTER_MS * 3));
    expect(readCrapsTableState(t)?.phase).toBe('closing');
    expect(readDiceThrow(t)).toBeNull();
  });

  it('refuses a takeover until this page has watched the turn sit long enough', () => {
    const t = freshTable();
    closing(t, 'someone-else:tab');
    tickManualCraps(t, at(T0)); // this page starts watching the turn now
    expect(pressManualRoll(t, at(T0 + MANUAL_TAKEOVER_MS - 1))).toMatch(/ANOTHER HOUSE MEMBER/);
    expect(readCrapsTableState(t)?.operator).toBe('someone-else:tab');
  });

  it('takes an abandoned turn over, and settles only once its stamp has had time to converge', async () => {
    const t = freshTable();
    closing(t, 'someone-else:tab');
    tickManualCraps(t, at(T0));
    expect(pressManualRoll(t, at(T0 + MANUAL_TAKEOVER_MS))).toBeNull();
    const mine = readCrapsTableState(t)!.operator;
    expect(mine).not.toBe('someone-else:tab');
    tickManualCraps(t, at(T0 + MANUAL_TAKEOVER_MS + 500));
    expect(readDiceThrow(t)).toBeNull();
    tickManualCraps(t, at(T0 + MANUAL_TAKEOVER_MS + 1_500));
    expect(readDiceThrow(t)?.by).toBe('stickman');
    expect((await settled(t))?.phase).toBe('settled');
  });

  it('takes an abandoned turn over a full watch after the clock went back an hour, not an hour later', () => {
    const t = freshTable();
    closing(t, 'someone-else:tab');
    tickManualCraps(t, at(T0 + 3_600_000)); // this page starts watching the turn
    tickManualCraps(t, at(T0 + 1_000)); // the clock goes back: the watch starts again
    expect(pressManualRoll(t, at(T0 + 1_000 + MANUAL_TAKEOVER_MS - 1))).toMatch(/ANOTHER HOUSE MEMBER/);
    expect(pressManualRoll(t, at(T0 + 1_000 + MANUAL_TAKEOVER_MS))).toBeNull();
  });

  it('settles a turn it took over without waiting for a clock gone back to come round', async () => {
    const t = freshTable();
    closing(t, 'someone-else:tab');
    tickManualCraps(t, at(T0 + 3_600_000));
    expect(pressManualRoll(t, at(T0 + 3_600_000 + MANUAL_TAKEOVER_MS))).toBeNull();
    tickManualCraps(t, at(T0 + 5_000)); // the clock went back an hour since
    expect(readDiceThrow(t)?.by).toBe('stickman');
    expect((await settled(t))?.phase).toBe('settled');
  });

  it('stands down when a rival takeover wins the stamp', () => {
    const t = freshTable();
    closing(t, 'someone-else:tab');
    tickManualCraps(t, at(T0));
    pressManualRoll(t, at(T0 + MANUAL_TAKEOVER_MS));
    // The rival's write lands last: it operates, this page doesn't.
    writeCrapsTableState(t, { ...readCrapsTableState(t)!, operator: 'rival:tab' });
    tickManualCraps(t, at(T0 + MANUAL_TAKEOVER_MS + 5_000));
    expect(readDiceThrow(t)).toBeNull();
    expect(readCrapsTableState(t)?.phase).toBe('closing');
  });

  it('does not carry a takeover into another room doc', () => {
    const t = freshTable();
    closing(t, 'someone-else:tab');
    tickManualCraps(t, at(T0));
    pressManualRoll(t, at(T0 + MANUAL_TAKEOVER_MS));
    const mine = readCrapsTableState(t)!.operator!;
    bindCasinoDoc(new Y.Doc());
    // Same table id and round in the new room, and (by chance) this page's
    // stamp: the old takeover's settle-at-once must not apply.
    closing(t, mine);
    tickManualCraps(t, at(T0 + MANUAL_TAKEOVER_MS + 2_000));
    expect(readDiceThrow(t)).toBeNull();
    expect(readCrapsTableState(t)?.phase).toBe('closing');
  });
});
