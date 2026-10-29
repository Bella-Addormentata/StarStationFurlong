/**
 * 🤖🧮 computedRobot's pure parts, on views built by hand: the words a
 * players' table's robot says.
 */

import { describe, expect, it, vi } from 'vitest';

// Modules under test hang debug handles on window when they load.
vi.stubGlobal('window', { location: { search: '' } });

const robot = await import('./computedRobot');
const { croupierBeatLine } = await import('./croupier');
const { crapsBeatLine } = await import('./crapsCroupier');
const { PLAYER_NAME_MAX_LENGTH } = await import('./identity');
type ComputedCrapsState = import('./computedTable').ComputedCrapsState;
type ComputedRouletteState = import('./computedTable').ComputedRouletteState;

const T = 2_000_000_000;
const NAMES: Record<string, string> = { 'player-Ann': 'Ann', 'player-Bob': 'Bob' };
const name = (pid: string): string => NAMES[pid] ?? pid;

function wheel(over: Partial<ComputedRouletteState>): ComputedRouletteState {
  return {
    kind: 'roulette', phase: 'betting', round: 5, result: null, resultAt: 0, payouts: null,
    inc: 'c1', spinKey: '', ...over,
  };
}

function dice(over: Partial<ComputedCrapsState>): ComputedCrapsState {
  return {
    kind: 'craps', phase: 'betting', round: 5, point: null, dice: null, result: null, resultAt: 0,
    payouts: null, inc: 'k1', rollKey: '', rollBy: '', shooterInPlay: false, showEnd: 0, riders: 0, ...over,
  };
}

/** A settled roll with the dice `[a, b]`. */
function roll(a: number, b: number, over: Partial<ComputedCrapsState> = {}): ComputedCrapsState {
  return dice({ phase: 'settled', dice: [a, b], result: a + b, rollKey: `5:${a}${b}`, rollBy: 'h', payouts: {}, ...over });
}

describe('speakableName', () => {
  it('collapses spaces and cuts a long name to 24 characters', () => {
    const long = `${'Ann '.repeat(40)}\n\n${'Bob\t'.repeat(40)}`;
    const out = robot.speakableName(long);
    expect(out).toBe('Ann Ann Ann Ann Ann Ann');
    expect(Array.from(out).length).toBeLessThanOrEqual(PLAYER_NAME_MAX_LENGTH);
    expect(robot.speakableName('  A\n\nB   C  ')).toBe('A B C');
  });

  it('drops text-direction overrides, zero-width characters and controls', () => {
    expect(robot.speakableName('‮Ann‬')).toBe('Ann');
    expect(robot.speakableName('A‍n​n⁦')).toBe('Ann');
    expect(robot.speakableName('A\u0007nn\u0000')).toBe('Ann');
    expect(robot.speakableName('﻿Ann­')).toBe('Ann');
  });

  it('never splits an emoji at the 24th character', () => {
    const out = robot.speakableName(`${'x'.repeat(23)}🎲yz`);
    expect(out).toBe(`${'x'.repeat(23)}🎲`);
    expect(out.length).toBe(25);
  });

  it('falls back when nothing speakable is left', () => {
    expect(robot.speakableName('​‍ ‮\n')).toBe('the shooter');
    expect(robot.speakableName('', 'someone')).toBe('someone');
  });
});

describe('the roulette robot', () => {
  it('calls the result in the owner-run words', () => {
    const paid = wheel({ phase: 'settled', result: 17, payouts: { 'player-Ann': 70 }, spinKey: '5:17' });
    expect(robot.resultText(paid, name)).toBe('🎡 17 BLACK — winners paid!');
    expect(robot.resultText(paid, name)).toBe(croupierBeatLine(paid)!.text);
    const zero = wheel({ phase: 'settled', result: 0, payouts: {}, spinKey: '5:0' });
    expect(robot.resultText(zero, name)).toBe('🎡 0 GREEN — house wins');
  });

  it('says a changed result with the round, on show and after it', () => {
    const now = wheel({ phase: 'settled', result: 4, payouts: {}, spinKey: '5:4' });
    expect(robot.rewriteText(now, name)).toBe('🎡 Round 5 is now 4 BLACK — house wins');
    expect(robot.correctionText('roulette', 5, '4')).toBe('🎡 Round 5 is now 4 BLACK');
    expect(robot.correctionText('roulette', 12, '0')).toBe('🎡 Round 12 is now 0 GREEN');
    expect(robot.correctionText('roulette', 12, '32')).toBe('🎡 Round 12 is now 32 RED');
  });

  it('has nothing for a void or an open table', () => {
    expect(robot.resultText(wheel({ phase: 'settled', voided: true, payouts: {} }), name)).toBeNull();
    expect(robot.rewriteText(wheel({ phase: 'settled', voided: true, payouts: {} }), name)).toBeNull();
    expect(robot.resultText(wheel({ phaseDeadline: T }), name)).toBeNull();
    expect(robot.NO_SPIN_CALL).toBe('⚠ No spin — stakes returned');
  });
});

describe('the craps robot', () => {
  it('keeps the owner-run words when the dice stay where they were', () => {
    const paid = roll(3, 5, { payouts: { 'player-Ann': 20 }, holderBefore: 'player-Ann', shooterAfter: 'player-Ann' });
    expect(robot.resultText(paid, name)).toBe('🎲 3+5 = 8 — winners paid!');
    expect(robot.resultText(paid, name)).toBe(crapsBeatLine(paid)!.text);
    const lost = roll(2, 2);
    expect(robot.resultText(lost, name)).toBe('🎲 2+2 = 4 — house collects');
    expect(robot.resultText(lost, name)).toBe(crapsBeatLine(lost)!.text);
  });

  it('says who gets the dice', () => {
    // The stickman's dice go to Ann.
    expect(robot.resultText(roll(5, 6, { payouts: { 'player-Ann': 20 }, shooterAfter: 'player-Ann' }), name))
      .toBe('🎲 5+6 = 11 — winners paid, the dice pass to Ann');
    // Ann's go back to the stickman (she left).
    expect(robot.resultText(roll(1, 2, { holderBefore: 'player-Ann' }), name))
      .toBe('🎲 1+2 = 3 — house collects, the stickman has the dice');
    // Ann sevens out and the dice go to Bob.
    expect(robot.resultText(roll(3, 4, { sevenOut: true, holderBefore: 'player-Ann', shooterAfter: 'player-Bob' }), name))
      .toBe('🎲 3+4 = 7 — seven out, the dice pass to Bob');
    // A lone Ann sevens out and keeps them.
    expect(robot.resultText(roll(3, 4, { sevenOut: true, holderBefore: 'player-Ann', shooterAfter: 'player-Ann' }), name))
      .toBe('🎲 3+4 = 7 — seven out, the dice come back to Ann');
    // Ann sevens out with nobody counted to take them.
    expect(robot.resultText(roll(3, 4, { sevenOut: true, holderBefore: 'player-Ann' }), name))
      .toBe('🎲 3+4 = 7 — seven out, the stickman has the dice');
    // The stickman sevens out with nobody counted before or after: never "come back".
    expect(robot.resultText(roll(3, 4, { sevenOut: true, payouts: { 'player-Bob': 20 } }), name)).toBe('🎲 3+4 = 7 — seven out');
  });

  it('never ends a players\' seven-out in the owner-run "new shooter"', () => {
    for (const over of [
      { holderBefore: 'player-Ann', shooterAfter: 'player-Ann' },
      { holderBefore: 'player-Ann' },
      {},
    ]) {
      expect(robot.resultText(roll(6, 1, { sevenOut: true, ...over }), name)).not.toContain('new shooter');
    }
  });

  it('says a changed roll with the roll, on show and after it', () => {
    expect(robot.rewriteText(roll(2, 2), name)).toBe('🎲 Roll 5 is now 2+2 = 4 — house collects');
    expect(robot.rewriteText(roll(3, 4, { sevenOut: true, holderBefore: 'player-Ann', shooterAfter: 'player-Bob' }), name))
      .toBe('🎲 Roll 5 is now 3+4 = 7 — seven out, the dice pass to Bob');
    expect(robot.correctionText('craps', 5, '22')).toBe('🎲 Roll 5 is now 2+2 = 4');
    expect(robot.correctionText('craps', 9999, '66')).toBe('🎲 Roll 9999 is now 6+6 = 12');
  });

  it('has nothing for a void', () => {
    expect(robot.resultText(dice({ phase: 'settled', voided: true, payouts: {} }), name)).toBeNull();
    expect(robot.NO_ROLL_CALL).toBe('⚠ No roll — every bet stands');
  });

  it('names the shooter in the wait for the throw', () => {
    const wait = (slip: ComputedCrapsState['shooterSlip'], left: number): string | null => robot.waitText(
      dice({ phase: 'closing', holder: 'player-Ann', shooterInPlay: true, shooterSlip: slip, phaseDeadline: T + left }), name, T);
    expect(wait('here', 20_000)).toBe('✋ No more bets — Ann has 20 seconds to throw');
    expect(wait('away', 19_001)).toBe('✋ No more bets — Ann has 20 seconds to throw');
    expect(wait('gone', 20_000)).toBe('✋ No more bets — the stickman throws for Ann in 20 seconds');
    expect(wait('absent', 2_000)).toBe('✋ No more bets — the stickman throws for Ann in 2 seconds');
    expect(wait('none', 1_000)).toBe('✋ No more bets — the stickman throws for Ann in 1 second');
    expect(wait('here', 1)).toBe('✋ No more bets — Ann has 1 second to throw');
    expect(wait('here', 0)).toBe('✋ No more bets — Ann has 1 second to throw');
  });

  it('has no wait line outside the wait', () => {
    expect(robot.waitText(dice({ phase: 'closing', holder: 'player-Ann', phaseDeadline: T }), name, T)).toBeNull();
    expect(robot.waitText(dice({ phase: 'closing', shooterSlip: 'here', phaseDeadline: T + 5_000 }), name, T)).toBeNull();
    expect(robot.waitText(dice({ phase: 'betting', holder: 'player-Ann', shooterSlip: 'here', phaseDeadline: T + 5_000 }), name, T)).toBeNull();
  });
});

describe('every call fits the bubble', () => {
  it('stays within 90 characters with a 24-character name and roll 9,999', () => {
    const long = robot.speakableName('W'.repeat(80));
    const named = (): string => long;
    const lines: (string | null)[] = [
      robot.rewriteText(roll(3, 4, { round: 9999, sevenOut: true, holderBefore: 'a', shooterAfter: 'a' }), named),
      robot.rewriteText(roll(3, 4, { round: 9999, sevenOut: true, holderBefore: 'a', shooterAfter: 'b' }), named),
      robot.rewriteText(roll(5, 6, { round: 9999, payouts: { a: 1 }, shooterAfter: 'b' }), named),
      robot.rewriteText(roll(1, 2, { round: 9999, holderBefore: 'a' }), named),
      robot.rewriteText(wheel({ round: 9999, phase: 'settled', result: 36, payouts: { a: 1 } }), named),
      robot.waitText(dice({ phase: 'closing', holder: 'a', shooterSlip: 'gone', phaseDeadline: T + 20_000 }), named, T),
      robot.waitText(dice({ phase: 'closing', holder: 'a', shooterSlip: 'here', phaseDeadline: T + 20_000 }), named, T),
      robot.correctionText('craps', 9999, '66'),
      robot.correctionText('roulette', 9999, '36'),
    ];
    for (const line of lines) {
      expect(line).not.toBeNull();
      expect(line!.length).toBeLessThanOrEqual(90);
    }
  });
});

describe('each call once (built views, frame by frame)', () => {
  type Seg = { v: ComputedRouletteState | ComputedCrapsState; ms: number; moving?: boolean };
  /** Step each view for `ms` at 50 ms a frame, saying every call due. */
  function play(segs: Seg[], m = robot.newCallMemory('c1'), start = T): { said: string[]; keys: string[]; m: typeof m; now: number } {
    const said: string[] = [];
    const keys: string[] = [];
    let now = start;
    if (!m.primed) robot.primeCalls(m, segs[0].v);
    for (const s of segs) {
      for (const end = now + s.ms; now < end; now += 50) {
        robot.observeCalls(m, s.v, now);
        const c = robot.nextCall(s.v.kind, s.v, m, { now, moving: s.moving ?? false, name });
        if (c) {
          said.push(c.text);
          keys.push(c.key);
          robot.callSaid(m, c);
        }
      }
    }
    return { said, keys, m, now };
  }
  const W = T + 18_000;
  const open = (r: number, d: number | undefined, key = ''): ComputedRouletteState =>
    wheel({ round: r, ...(d !== undefined ? { phaseDeadline: d } : {}), spinKey: key });
  const closing = (r: number, key = ''): ComputedRouletteState => wheel({ phase: 'closing', round: r, spinKey: key });
  const shown = (r: number, pocket: number, paid = false): ComputedRouletteState =>
    wheel({ phase: 'settled', round: r, result: pocket, payouts: paid ? { 'player-Ann': 36 } : {}, spinKey: `${r}:${pocket}`, phaseDeadline: T });
  const voided = (r: number): ComputedRouletteState => wheel({ phase: 'settled', round: r, voided: true, payouts: {}, spinKey: '' });

  it('a full round gives open, close and result once each over 300 frames', () => {
    const out = play([
      { v: open(5, undefined, '4:9'), ms: 2_000 },
      { v: open(5, W, '4:9'), ms: 5_000 },
      { v: closing(5, '4:9'), ms: 3_000 },
      { v: shown(5, 17, true), ms: 5_000 },
    ], robot.newCallMemory('c1'));
    expect(out.said).toEqual(['🎲 Place your bets!', '✋ No more bets!', '🎡 17 BLACK — winners paid!']);
    expect(out.keys).toEqual([`c1|5|open|${W}`, 'c1|5|close|' + W, 'c1|5|result|17']);
  });

  it('calls A, then B, then A again: three results', () => {
    const out = play([
      { v: shown(5, 17), ms: 1_000 },
      { v: shown(5, 4), ms: 1_000 },
      { v: shown(5, 17), ms: 1_000 },
    ], Object.assign(robot.newCallMemory('c1'), { primed: true }));
    expect(out.said).toEqual(['🎡 17 BLACK — house wins', '🎡 Round 5 is now 4 BLACK — house wins', '🎡 Round 5 is now 17 BLACK — house wins']);
  });

  it('corrects a result changed after its show, once', () => {
    const m = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const out = play([
      { v: shown(5, 17), ms: 1_000 },
      { v: open(6, W, '5:17'), ms: 1_000 },
      { v: open(6, W, '5:4'), ms: 2_000 },
    ], m);
    expect(out.said).toEqual(['🎡 17 BLACK — house wins', '🎲 Place your bets!', '🎡 Round 5 is now 4 BLACK']);
  });

  it('says nothing of a round first seen after its show', () => {
    const m = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const out = play([{ v: closing(6, '5:17'), ms: 1_000 }, { v: open(7, W, '5:17'), ms: 500 }], m);
    expect(out.said).toEqual(['✋ No more bets!', '🎲 Place your bets!']);
    expect(m.called.get(5)).toBe('17');
  });

  it('is silent for a re-show after a sleep or an undo, and for a new decision on the same dice', () => {
    const m = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const out = play([
      { v: shown(5, 17), ms: 1_000 },
      { v: open(6, W, '5:17'), ms: 500 },
      { v: shown(5, 17), ms: 1_000 }, // the undo takes round 6 back; round 5 shows again
    ], m);
    expect(out.said).toEqual(['🎡 17 BLACK — house wins', '🎲 Place your bets!']);
    const k = robot.newCallMemory('k1');
    k.primed = true;
    const craps = play([
      { v: roll(3, 5, { inc: 'k1', rollBy: 'close-a' }), ms: 1_000 },
      { v: roll(3, 5, { inc: 'k1', rollBy: 'forfeit-b' }), ms: 1_000 },
    ], k);
    expect(craps.said).toEqual(['🎲 3+5 = 8 — house collects']);
  });

  it('calls a void once, and a void turned into a result, and back', () => {
    const m = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const out = play([
      { v: voided(5), ms: 1_000 },
      { v: shown(5, 17), ms: 1_000 },
      { v: voided(5), ms: 1_000 },
    ], m);
    expect(out.said).toEqual(['⚠ No spin — stakes returned', '🎡 Round 5 is now 17 BLACK — house wins', '⚠ No spin — stakes returned']);
    const k = Object.assign(robot.newCallMemory('k1'), { primed: true });
    expect(play([{ v: dice({ inc: 'k1', phase: 'settled', voided: true, payouts: {} }), ms: 1_000 }], k).said)
      .toEqual(['⚠ No roll — every bet stands']);
  });

  it("a forfeit's hold, then its result: one close and one result", () => {
    const m = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const out = play([
      { v: open(5, W, '4:9'), ms: 500 },
      { v: closing(5, '4:9'), ms: 1_000 },
      { v: closing(5, ''), ms: 3_000 }, // the grace holds the result
      { v: shown(5, 2), ms: 1_000 },
    ], m);
    expect(out.said).toEqual(['🎲 Place your bets!', '✋ No more bets!', '🎡 2 BLACK — house wins']);
  });

  it('opens a window again once it ran out, and closes once', () => {
    const W2 = W + 30_000;
    const out = play([
      { v: open(5, W, '4:9'), ms: 500 },
      { v: open(5, undefined, '4:9'), ms: 500 }, // ran out with every chip taken down
      { v: open(5, W2, '4:9'), ms: 500 },
      { v: closing(5, '4:9'), ms: 500 },
    ], Object.assign(robot.newCallMemory('c1'), { primed: true }), W - 500);
    expect(out.said).toEqual(['🎲 Place your bets!', '🎲 Place your bets!', '✋ No more bets!']);
    expect(out.keys[2]).toBe(`c1|5|close|${W2}`);
  });

  it('stays quiet for a flap back to the same window, and for a deadline that moves', () => {
    const out = play([
      { v: open(5, W, '4:9'), ms: 500 },
      { v: open(5, W + 2_000, '4:9'), ms: 500 }, // a late re-show pushed it back
      { v: closing(5, '4:9'), ms: 500 },
      { v: open(5, W + 2_000, '4:9'), ms: 500 }, // an invalid close, taken back
      { v: closing(5, '4:9'), ms: 500 },
    ], Object.assign(robot.newCallMemory('c1'), { primed: true }));
    expect(out.said).toEqual(['🎲 Place your bets!', '✋ No more bets!']);
  });

  it('never says place your bets at or after the deadline', () => {
    const out = play([{ v: open(5, T + 100, '4:9'), ms: 1_000 }], Object.assign(robot.newCallMemory('c1'), { primed: true }), T + 100);
    expect(out.said).toEqual([]);
  });

  it('holds the result while the wheel spins, at most 8 seconds', () => {
    const still = play([
      { v: shown(5, 17), ms: 5_000, moving: true },
      { v: shown(5, 17), ms: 1_000 },
    ], Object.assign(robot.newCallMemory('c1'), { primed: true }));
    expect(still.said).toEqual(['🎡 17 BLACK — house wins']);
    const m = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const said: number[] = [];
    for (let now = T; now < T + 9_000; now += 50) {
      robot.observeCalls(m, shown(5, 17), now);
      const c = robot.nextCall('roulette', shown(5, 17), m, { now, moving: true, name });
      if (c) { said.push(now - T); robot.callSaid(m, c); }
    }
    expect(said).toEqual([robot.RESULT_HOLD_MAX_MS]);
  });

  it('drops a first call whose show ends while it is held, and closes during a hold', () => {
    const out = play([
      { v: shown(5, 17), ms: 2_000, moving: true },
      { v: closing(6, '5:17'), ms: 1_000, moving: true },
      { v: closing(6, '5:17'), ms: 1_000 },
    ], Object.assign(robot.newCallMemory('c1'), { primed: true }));
    expect(out.said).toEqual(['✋ No more bets!']);
  });

  it('primes mid-show and mid-close with nothing old, then speaks the next round', () => {
    const mid = play([{ v: shown(5, 17), ms: 2_000 }, { v: open(6, W, '5:17'), ms: 500 }]);
    expect(mid.said).toEqual(['🎲 Place your bets!']);
    const close = play([{ v: closing(6, '5:17'), ms: 1_000 }, { v: shown(6, 3), ms: 500 }]);
    expect(close.said).toEqual(['✋ No more bets!', '🎡 3 RED — house wins']);
    const gone = play([{ v: voided(5), ms: 1_000 }]);
    expect(gone.said).toEqual([]);
  });
});
