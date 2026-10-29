/**
 * 🤖 The owner-run robot's calls, word for word. World's narration loop says
 * croupierBeatLine / crapsBeatLine at every heartbeat table and dedupes by the
 * key, so these pin what an owner-run table's robot says and when it says it
 * again. A players' table's robot (computedRobot) reuses the same words where
 * they fit, so a change here shows up at both kinds of table.
 */

import { describe, expect, it, vi } from 'vitest';

// Modules under test hang debug handles on window when they load.
vi.stubGlobal('window', { location: { search: '' } });

const { croupierBeatLine } = await import('./croupier');
const { crapsBeatLine } = await import('./crapsCroupier');
type RouletteTableState = import('./games/roulette').RouletteTableState;
type CrapsTableState = import('./games/craps').CrapsTableState;

const T = 2_000_000_000;

function wheel(over: Partial<RouletteTableState>): RouletteTableState {
  return { kind: 'roulette', phase: 'betting', round: 7, result: null, resultAt: 0, payouts: null, ...over };
}

function dice(over: Partial<CrapsTableState>): CrapsTableState {
  return {
    kind: 'craps', phase: 'betting', round: 12, point: null, dice: null, result: null,
    resultAt: 0, payouts: null, ...over,
  };
}

describe('croupierBeatLine (roulette)', () => {
  it('opens a timed window, and says nothing for an untimed one', () => {
    expect(croupierBeatLine(wheel({ phaseDeadline: T }))).toEqual({ key: '7:open', text: '🎲 Place your bets!' });
    expect(croupierBeatLine(wheel({}))).toBeNull();
  });

  it('closes', () => {
    expect(croupierBeatLine(wheel({ phase: 'closing', phaseDeadline: T }))).toEqual({ key: '7:close', text: '✋ No more bets!' });
    expect(croupierBeatLine(wheel({ phase: 'closing' }))).toEqual({ key: '7:close', text: '✋ No more bets!' });
  });

  it('calls the pocket, its colour, and whether anyone was paid', () => {
    const paid = wheel({ phase: 'settled', result: 17, payouts: { 'player-Ann': 70 }, phaseDeadline: T });
    expect(croupierBeatLine(paid)).toEqual({ key: '7:settle', text: '🎡 17 BLACK — winners paid!' });
    expect(croupierBeatLine(wheel({ phase: 'settled', result: 0, payouts: null }))).toEqual({ key: '7:settle', text: '🎡 0 GREEN — house wins' });
    expect(croupierBeatLine(wheel({ phase: 'settled', result: 1, payouts: {} }))).toEqual({ key: '7:settle', text: '🎡 1 RED — house wins' });
  });

  it('says nothing for a void', () => {
    expect(croupierBeatLine(wheel({ phase: 'settled', result: null, voided: true, phaseDeadline: T }))).toBeNull();
  });
});

describe('crapsBeatLine (craps)', () => {
  it('opens a come-out and a point window, and says nothing for an untimed one', () => {
    expect(crapsBeatLine(dice({ phaseDeadline: T }))).toEqual({ key: '12:open', text: '🎲 Coming out — place your bets!' });
    expect(crapsBeatLine(dice({ point: 6, phaseDeadline: T }))).toEqual({ key: '12:open', text: '🎲 The point is 6 — place your bets!' });
    expect(crapsBeatLine(dice({ point: 6 }))).toBeNull();
  });

  it('closes', () => {
    expect(crapsBeatLine(dice({ phase: 'closing', phaseDeadline: T }))).toEqual({ key: '12:close', text: '✋ No more bets!' });
  });

  it('calls the dice, and whether anyone was paid', () => {
    const paid = dice({ phase: 'settled', dice: [3, 5], result: 8, payouts: { 'player-Ann': 20 } });
    expect(crapsBeatLine(paid)).toEqual({ key: '12:settle', text: '🎲 3+5 = 8 — winners paid!' });
    const lost = dice({ phase: 'settled', dice: [1, 1], result: 2, payouts: {} });
    expect(crapsBeatLine(lost)).toEqual({ key: '12:settle', text: '🎲 1+1 = 2 — house collects' });
  });

  it('calls a seven-out the same whoever was paid', () => {
    const out = dice({ phase: 'settled', dice: [3, 4], result: 7, payouts: { 'player-Bob': 20 }, sevenOut: true });
    expect(crapsBeatLine(out)).toEqual({ key: '12:settle', text: '🎲 3+4 = 7 — seven out, new shooter' });
    const natural = dice({ phase: 'settled', dice: [3, 4], result: 7, payouts: { 'player-Bob': 20 } });
    expect(crapsBeatLine(natural)).toEqual({ key: '12:settle', text: '🎲 3+4 = 7 — winners paid!' });
  });

  it('says nothing for a void', () => {
    expect(crapsBeatLine(dice({ phase: 'settled', voided: true, phaseDeadline: T }))).toBeNull();
  });
});
