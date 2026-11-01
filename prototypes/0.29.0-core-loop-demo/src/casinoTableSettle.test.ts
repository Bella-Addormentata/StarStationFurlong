/**
 * 💰 An owner-run craps table's settle on screen (casinoTableSession over
 * the stickman's real settle): once the dice are down, the losing chips go
 * to the house and the winners are paid out of it onto their rails, played
 * from the shared settled record and the felt as it played, once a roll; a
 * page that walks up during the show plays none of it, nor of a roll shown
 * again from before it looked. The table's pieces
 * are a fake handle that keeps what it was asked to play.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

vi.stubGlobal('window', { location: { search: '' }, addEventListener: () => undefined, removeEventListener: () => undefined });

const {
  bindCasinoDoc, buyInChips, clearTableKeys, readCrapsTableState, writeCrapsFairnessPref, writeCrapsTableState, writeMyCrapsBets, writeMySeat,
} = await import('./casinoDoc');
const { casinoTablesFrame, crapsRollInPlay, railFor, railWithTakeDown } = await import('./casinoTableSession');
const { closeCrapsBetting, openCrapsBetting, rollAndSettleCraps } = await import('./crapsCroupier');
const { FURNITURE, FURNITURE_DEFS } = await import('./furniture');
const { CRAPS_HOUSE_SPOT } = await import('./games/casinoLayout');
const { getPlayerId } = await import('./identity');
type CasinoTableVisualHandle = import('./casinoTable3d').CasinoTableVisualHandle;
type SettleMoves = import('./casinoTable3d').SettleMoves;
type FeltStack = import('./casinoTable3d').FeltStack;
type CrapsBet = import('./games/craps').CrapsBet;

const HALF_X = 1.43;
const HALF_Z = 0.48;

/** Table pieces that keep the settles they were asked to play and the
 *  felt as last set; the dice always at rest. */
function fakeTable(): { h: CasinoTableVisualHandle; settles: SettleMoves[]; felt: () => readonly FeltStack[] } {
  const settles: SettleMoves[] = [];
  let felt: readonly FeltStack[] = [];
  const h = new Proxy({} as Record<PropertyKey, unknown>, {
    get: (_t, key) => {
      switch (key) {
        case 'game': return 'craps';
        case 'halfX': return HALF_X;
        case 'halfZ': return HALF_Z;
        case 'diceState': return () => 'rest';
        case 'payingMe': return () => false;
        case 'settleChips': return (m: SettleMoves) => { settles.push(m); };
        case 'setFeltChips': return (s: readonly FeltStack[]) => { felt = s; };
        default: return () => undefined;
      }
    },
  }) as unknown as CasinoTableVisualHandle;
  return { h, settles, felt: () => felt };
}

/** The stickman's dice: `faces`, through the RNG backend. */
function rig(faces: [number, number]): void {
  let n = 0;
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(arr: T): T => {
    (arr as unknown as Uint32Array)[0] = faces[n++ % 2] - 1;
    return arr;
  });
}

async function settle(t: string): Promise<void> {
  rollAndSettleCraps(t, readCrapsTableState(t)!.round, readCrapsTableState(t)!.point);
  for (let i = 0; i < 40 && readCrapsTableState(t)?.phase !== 'settled'; i++) await new Promise((r) => setTimeout(r, 0));
  expect(readCrapsTableState(t)?.phase).toBe('settled');
}

const stands = FURNITURE_DEFS['craps-table'].stands!;
const A_STAND = stands.findIndex((s) => !s.role && s.stand.z < 0);
const B_STAND = stands.findIndex((s, i) => !s.role && s.stand.z < 0 && i !== A_STAND);
/** Where a player at stand `i` takes chips onto their rail. */
function railAt(i: number) {
  const st = stands[i].stand;
  const r = railWithTakeDown(railFor(st, HALF_X, HALF_Z), { x: 0, z: 1 }).chips;
  return { x: r.x, z: r.z };
}

let table = '';
let seq = 0;
const me = getPlayerId();
const other = 'player-Other';

beforeEach(() => {
  bindCasinoDoc(new Y.Doc());
  table = `craps-settle-${++seq}`;
  FURNITURE.push({ id: table, kind: 'craps-table', pos: { x: 0, z: 0 }, rot: 0, movable: true });
  writeCrapsFairnessPref(table, 'rng');
  for (const pid of [me, other]) buyInChips(pid, 500);
  writeMySeat(table, me, { stand: A_STAND, angle: 0, at: Date.now() });
  writeMySeat(table, other, { stand: B_STAND, angle: 0, at: Date.now() });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const bet = (type: CrapsBet['type'], amount: number, pick?: number): CrapsBet => (pick === undefined ? { type, amount } : { type, pick, amount });

/** Roll 1 with these felts down, the table closed for it. */
function closedWith(felts: Record<string, CrapsBet[]>): void {
  openCrapsBetting(table, 1, null);
  for (const [pid, bets] of Object.entries(felts)) expect(writeMyCrapsBets(table, pid, bets)).toBe(true);
  closeCrapsBetting(table, readCrapsTableState(table)!);
}

describe('💰 the settle on screen at an owner-run craps table', () => {
  it('a natural: the losers go to the house, then my pass line comes back with its winnings out of the house, once', async () => {
    const { h, settles, felt } = fakeTable();
    const frame = () => casinoTablesFrame(1 / 60, new Map([[table, h]]));
    closedWith({ [me]: [bet('pass', 10)], [other]: [bet('dontpass', 5), bet('field', 5)] });
    frame();
    expect(crapsRollInPlay(table)).toBe(true);
    expect(felt()).toHaveLength(3);
    rig([3, 4]);
    await settle(table);
    frame();
    expect(settles).toHaveLength(1);
    const [m] = settles;
    expect(m.house).toEqual(CRAPS_HOUSE_SPOT);
    expect(m.lost.map((s) => [s.pid, s.spot, s.dim])).toEqual([[other, 'dontpass:', true], [other, 'field:', true]]);
    expect(m.back.map((b) => [b.s.pid, b.s.spot, b.to, b.mine])).toEqual([[me, 'pass:', railAt(A_STAND), true]]);
    expect(m.paid).toEqual([{ chips: [5, 5], to: railAt(A_STAND), order: 0, mine: true, dim: false }]);
    // The stacks move off from where the felt drew them.
    const was = m.back[0].s;
    expect(was.chips).toEqual([5, 5]);
    expect(felt()).toEqual([]);
    expect(crapsRollInPlay(table)).toBe(false);
    // Later frames of the same settle play nothing more.
    frame();
    frame();
    expect(settles).toHaveLength(1);
  });

  it('a point set: nothing moves (the line rides); a place bet that comes later is paid where it stands', async () => {
    const { h, settles } = fakeTable();
    const frame = () => casinoTablesFrame(1 / 60, new Map([[table, h]]));
    closedWith({ [me]: [bet('pass', 10)] });
    frame();
    rig([2, 4]);
    await settle(table);
    frame();
    expect(settles).toEqual([]);
    // Roll 2: a place 8 that comes.
    const s1 = readCrapsTableState(table)!;
    openCrapsBetting(table, 2, s1.point, s1);
    expect(writeMyCrapsBets(table, other, [bet('place', 6, 8)])).toBe(true);
    closeCrapsBetting(table, readCrapsTableState(table)!);
    frame();
    rig([4, 4]);
    await settle(table);
    frame();
    expect(settles).toHaveLength(1);
    expect(settles[0].lost).toEqual([]);
    expect(settles[0].back).toEqual([]);
    expect(settles[0].paid).toEqual([{ chips: [5, 1, 1], to: railAt(B_STAND), order: 0, mine: false, dim: true }]);
  });

  it('a roll shown again from before this page looked (the next roll was open when it did) plays none of it, held or not', async () => {
    const { h, settles } = fakeTable();
    const frame = () => casinoTablesFrame(1 / 60, new Map([[table, h]]));
    closedWith({ [me]: [bet('pass', 10)] });
    rig([2, 4]);
    await settle(table);
    const s1 = readCrapsTableState(table)!;
    openCrapsBetting(table, 2, s1.point, s1);
    frame();
    // Roll 1 shown again: held, then a result of it that pays my pass line.
    writeCrapsTableState(table, { ...s1, phase: 'closing', point: null, dice: null, result: null, payouts: null, resultAt: 0 });
    frame();
    writeCrapsTableState(table, { ...s1, point: null, dice: [3, 4], result: 7, payouts: { [me]: 20 }, resultAt: s1.resultAt + 1 });
    frame();
    expect(readCrapsTableState(table)).toMatchObject({ phase: 'settled', round: 1, result: 7 });
    expect(settles).toEqual([]);
  });

  it('the table put back under the same id (its rolls start again at 1): its first roll plays from its own felt, not the old one', async () => {
    const { h, settles } = fakeTable();
    const frame = () => casinoTablesFrame(1 / 60, new Map([[table, h]]));
    closedWith({ [me]: [bet('pass', 10)] });
    frame();
    rig([3, 4]);
    await settle(table);
    frame();
    expect(settles.map((m) => m.back.map((b) => [b.s.pid, b.s.spot]))).toEqual([[[me, 'pass:']]]);
    // Taken away and put back: roll 1 again (a new incarnation), someone
    // else's field bet.
    clearTableKeys(table);
    frame();
    closedWith({ [other]: [bet('field', 5)] });
    frame();
    rig([3, 4]);
    await settle(table);
    frame();
    expect(settles).toHaveLength(2);
    expect(settles[1].lost.map((s) => [s.pid, s.spot, s.chips])).toEqual([[other, 'field:', [5]]]);
    expect(settles[1].back).toEqual([]);
    expect(settles[1].paid).toEqual([]);
  });

  it('a page that first sees the roll already settled (it walked up during the show) plays none of it', async () => {
    const { h, settles } = fakeTable();
    closedWith({ [me]: [bet('field', 10)], [other]: [bet('field', 5)] });
    rig([3, 4]);
    await settle(table);
    casinoTablesFrame(1 / 60, new Map([[table, h]]));
    casinoTablesFrame(1 / 60, new Map([[table, h]]));
    expect(settles).toEqual([]);
  });
});
