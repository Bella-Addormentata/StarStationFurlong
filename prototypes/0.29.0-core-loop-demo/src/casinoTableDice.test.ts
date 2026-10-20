/**
 * 🎲 Where the craps dice wait between rolls: with the stickman through the
 * betting countdown, and pushed over to the shooter only once betting closes
 * (their throw window). Nobody has dice in front of them while bets go down.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.stubGlobal('window', { location: { search: '' }, addEventListener: () => undefined, removeEventListener: () => undefined });

const { bindCasinoDoc, writeCrapsTableState, writeMySeat } = await import('./casinoDoc');
const { casinoTablesFrame } = await import('./casinoTableSession');
const { STICKMAN_DICE_SPOT } = await import('./crapsCroupier');
const { FURNITURE, FURNITURE_DEFS } = await import('./furniture');
type CasinoTableVisualHandle = import('./casinoTable3d').CasinoTableVisualHandle;
type CrapsTableState = import('./games/craps').CrapsTableState;
type FeltPoint = import('./games/casinoLayout').FeltPoint;

const TABLE = 'craps-dice-spot-test';
const SHOOTER = 'player-Shooter';
const STAND = FURNITURE_DEFS['craps-table'].stands!.findIndex((s) => !s.role);

/** A table handle that only remembers where it was last told the dice rest. */
function fakeTable(): { h: CasinoTableVisualHandle; rest: () => FeltPoint | null } {
  let last: FeltPoint | null = null;
  const h = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_t, key) => {
      if (key === 'game') return 'craps';
      if (key === 'diceState') return () => 'rest';
      if (key === 'diceRestAt') return (p: FeltPoint) => { last = p; };
      return () => undefined;
    },
  }) as unknown as CasinoTableVisualHandle;
  return { h, rest: () => last };
}

function state(phase: CrapsTableState['phase'], round: number): CrapsTableState {
  return {
    kind: 'craps', phase, round, point: null, dice: null, result: null, resultAt: 0, payouts: null,
    phaseDeadline: Date.now() + 10_000, shooter: SHOOTER,
  };
}

describe('the craps dice between rolls', () => {
  beforeEach(() => {
    bindCasinoDoc(new Y.Doc());
    if (!FURNITURE.some((i) => i.id === TABLE)) {
      FURNITURE.push({ id: TABLE, kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
    }
    writeMySeat(TABLE, SHOOTER, { stand: STAND, angle: 0, at: Date.now() });
  });

  it('stay with the stickman through the betting countdown', () => {
    const { h, rest } = fakeTable();
    writeCrapsTableState(TABLE, state('betting', 1));
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    expect(rest()).toEqual(STICKMAN_DICE_SPOT);
  });

  it('are pushed to the shooter once betting closes', () => {
    const { h, rest } = fakeTable();
    writeCrapsTableState(TABLE, state('betting', 2));
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    writeCrapsTableState(TABLE, state('closing', 2));
    casinoTablesFrame(1 / 60, new Map([[TABLE, h]]));
    const spot = rest()!;
    expect(spot).not.toEqual(STICKMAN_DICE_SPOT);
    // In front of the shooter's own stand: on its side of the table.
    const stand = FURNITURE_DEFS['craps-table'].stands![STAND].stand;
    expect(Math.sign(spot.z)).toBe(Math.sign(stand.z));
  });
});
