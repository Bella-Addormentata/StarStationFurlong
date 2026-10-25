/**
 * 🪑 A round takes at most MAX_TABLE_BETTORS bettors, Fair or RNG: the close
 * freezes who is in it, and a bettor past the cap would sit the round out
 * (roulette) or ride it unresolved (craps). So a newcomer's first bet past
 * the cap doesn't go down; a bettor already on the felt goes on.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.stubGlobal('window', { location: { search: '' } });

const {
  bindCasinoDoc, buyInChips, MAX_TABLE_BETTORS, readAllBets, readAllCrapsBets, readChips, readCrapsTableState,
  readMyBets, readMyCrapsBets, writeCrapsFairnessPref, writeMyBets, writeMyCrapsBets,
} = await import('./casinoDoc');
const { openBetting } = await import('./croupier');
const { closeCrapsBetting, openCrapsBetting, rollAndSettleCraps } = await import('./crapsCroupier');

const players = Array.from({ length: MAX_TABLE_BETTORS + 1 }, (_, i) => `player-${String(i).padStart(2, '0')}`);
const newcomer = players[MAX_TABLE_BETTORS];
const red = [{ type: 'red' as const, amount: 10 }];
const pass = [{ type: 'pass' as const, amount: 10 }];

beforeEach(() => {
  bindCasinoDoc(new Y.Doc());
  for (const pid of players) buyInChips(pid, 100);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a full table', () => {
  for (const mode of ['rng', 'multiparty'] as const) {
    it(`roulette (${mode}): the newcomer past the cap puts nothing down, a bettor on the felt goes on`, () => {
      const t = `roulette-full-${mode}`;
      writeCrapsFairnessPref(t, mode);
      openBetting(t, 1);
      for (const pid of players.slice(0, MAX_TABLE_BETTORS)) writeMyBets(t, pid, 1, red);
      writeMyBets(t, newcomer, 1, red);
      expect(readMyBets(t, newcomer, 1)).toEqual([]);
      expect(readChips(newcomer)).toBe(100);
      writeMyBets(t, players[0], 1, [...red, ...red]);
      expect(readMyBets(t, players[0], 1)).toHaveLength(2);
      // A bettor takes everything down: there is a place.
      writeMyBets(t, players[1], 1, []);
      writeMyBets(t, newcomer, 1, red);
      expect(readMyBets(t, newcomer, 1)).toEqual(red);
      expect(Object.keys(readAllBets(t, 1))).toHaveLength(MAX_TABLE_BETTORS);
    });

    it(`craps (${mode}): the newcomer past the cap waits for a place`, () => {
      const t = `craps-full-${mode}`;
      writeCrapsFairnessPref(t, mode);
      openCrapsBetting(t, 1, null);
      for (const pid of players.slice(0, MAX_TABLE_BETTORS)) writeMyCrapsBets(t, pid, pass);
      writeMyCrapsBets(t, newcomer, pass);
      expect(readMyCrapsBets(t, newcomer)).toEqual([]);
      expect(readChips(newcomer)).toBe(100);
      writeMyCrapsBets(t, players[1], []);
      writeMyCrapsBets(t, newcomer, pass);
      expect(readMyCrapsBets(t, newcomer)).toEqual(pass);
      expect(Object.keys(readAllCrapsBets(t))).toHaveLength(MAX_TABLE_BETTORS);
    });
  }

  it('craps: bets a roll left standing count too', async () => {
    const t = 'craps-full-standing';
    writeCrapsFairnessPref(t, 'rng');
    openCrapsBetting(t, 1, null);
    for (const pid of players.slice(0, MAX_TABLE_BETTORS)) writeMyCrapsBets(t, pid, pass);
    closeCrapsBetting(t, readCrapsTableState(t)!);
    const faces = [2, 2]; // a four: the point, every pass line stands
    let n = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
      (arr as unknown as Uint32Array)[0] = faces[n++ % 2] - 1;
      return arr;
    });
    rollAndSettleCraps(t, 1, null);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readCrapsTableState(t)).toMatchObject({ phase: 'settled', point: 4 });
    openCrapsBetting(t, 2, 4, readCrapsTableState(t));
    expect(Object.keys(readAllCrapsBets(t))).toHaveLength(MAX_TABLE_BETTORS);
    writeMyCrapsBets(t, newcomer, [{ type: 'field', amount: 10 }]);
    expect(readMyCrapsBets(t, newcomer)).toEqual([]);
    expect(readChips(newcomer)).toBe(100);
  });
});
