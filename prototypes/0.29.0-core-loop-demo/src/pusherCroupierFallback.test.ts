/**
 * 🪙 The coin-pusher operator never clears a drop request without an answer
 * (#137 review). A drop that throws, or one the settle rejects, is answered
 * as jammed and moves nothing. Neither happens for a guarded request, so the
 * engine here is swapped for one that misbehaves, to reach them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

const engine = vi.hoisted(() => ({ fault: 'throws' as 'throws' | 'is rejected by the settle' }));

vi.mock('./games/coinPusher', async (importOriginal) => {
  const real = await importOriginal<typeof import('./games/coinPusher')>();
  return {
    ...real,
    processInsert: (...args: Parameters<typeof real.processInsert>) => {
      if (engine.fault === 'throws') throw new Error('a drop that fails');
      const played = real.processInsert(...args);
      // Two chips in for one drop: a transition the settle must reject.
      return { ...played, state: { ...played.state, totalInserted: played.state.totalInserted + 1 } };
    },
  };
});

const { bindCasinoDoc, buyInChips, readChips, readCoinPusherRequest, readCoinPusherResult, readCoinPusherState, writeCoinPusherRequest, writeCoinPusherState } = await import('./casinoDoc');
const { initialCoinPusherState } = await import('./games/coinPusher');
const { operateCoinPusher } = await import('./pusherCroupier');

const MACHINE = 'pusher-1';
const OPERATOR = 'operator';
const PLAYER = 'player-Bob';
const NOW = 1_000_000;

beforeEach(() => {
  bindCasinoDoc(new Y.Doc());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a drop the operator cannot play', () => {
  it.each(['throws', 'is rejected by the settle'] as const)('is answered as jammed when it %s', (fault) => {
    engine.fault = fault;
    writeCoinPusherState(MACHINE, initialCoinPusherState(OPERATOR, 0));
    const before = readCoinPusherState(MACHINE);
    buyInChips(PLAYER, 3);
    writeCoinPusherRequest(MACHINE, { requestId: 'r1', player: PLAYER, hole: 1, phase: 0.5, requestedAt: NOW - 100 });
    operateCoinPusher(MACHINE, OPERATOR, NOW, () => 7);
    expect(readCoinPusherResult(MACHINE, PLAYER)).toEqual({
      kind: 'refused', requestId: 'r1', reason: 'jammed', atMs: NOW,
    });
    expect(readCoinPusherRequest(MACHINE, PLAYER)).toBeNull();
    expect(readChips(PLAYER)).toBe(3);
    expect(readCoinPusherState(MACHINE)).toEqual(before);
    expect(console.error).toHaveBeenCalledOnce();
  });
});
