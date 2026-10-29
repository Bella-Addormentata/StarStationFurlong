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

type Seg = { v: ComputedRouletteState | ComputedCrapsState; ms: number; moving?: boolean; drawn?: boolean; toss?: import('./computedRobot').CloseToss };
/** Step each view for `ms` at 50 ms a frame, saying every call due. */
function play(segs: Seg[], m = robot.newCallMemory('c1'), start = T): { said: string[]; keys: string[]; m: typeof m; now: number } {
  const said: string[] = [];
  const keys: string[] = [];
  let now = start;
  if (!m.primed) robot.primeCalls(m, segs[0].v);
  for (const s of segs) {
    for (const end = now + s.ms; now < end; now += 50) {
      robot.observeCalls(m, s.v, now);
      const c = robot.nextCall(s.v.kind, s.v, m, { now, moving: s.moving ?? false, drawn: s.drawn ?? false, toss: s.toss ?? null, name });
      if (c) {
        said.push(c.text);
        keys.push(c.key);
        robot.callSaid(m, c);
      }
    }
  }
  return { said, keys, m, now };
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
      const c = robot.nextCall('roulette', shown(5, 17), m, { now, moving: true, drawn: false, toss: null, name });
      if (c) { said.push(now - T); robot.callSaid(m, c); }
    }
    expect(said).toEqual([robot.RESULT_HOLD_MAX_MS]);
  });

  it("at craps calls an earlier roll's correction at once, though the next roll's dice fly", () => {
    const m = Object.assign(robot.newCallMemory('k1'), { primed: true });
    m.called.set(5, '34');
    const closing6 = dice({ phase: 'closing', round: 6, rollKey: '5:25' });
    robot.observeCalls(m, closing6, T);
    const c = robot.nextCall('craps', closing6, m, { now: T, moving: true, drawn: true, toss: null, name });
    expect(c).toMatchObject({ kind: 'result', r: 5, value: '25', text: '🎲 Roll 5 is now 2+5 = 7' });
    // (A roll on show still waits for its dice.)
    const shown5 = roll(2, 5);
    const m2 = Object.assign(robot.newCallMemory('k1'), { primed: true });
    m2.called.set(5, '34');
    robot.observeCalls(m2, shown5, T);
    expect(robot.nextCall('craps', shown5, m2, { now: T, moving: true, drawn: true, toss: null, name })).toBeNull();
  });

  it('on a drawn table waits a frame for the felt, then while the wheel spins', () => {
    const m = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const at: number[] = [];
    const frames: [number, boolean][] = [[T, false], [T + 16, true], [T + 3_000, true], [T + 5_000, false]];
    for (const [now, moving] of frames) {
      robot.observeCalls(m, shown(5, 17), now);
      const c = robot.nextCall('roulette', shown(5, 17), m, { now, moving, drawn: true, toss: null, name });
      if (c) { at.push(now); robot.callSaid(m, c); }
    }
    expect(at).toEqual([T + 5_000]);
    // A felt that takes it with nothing to move (the same decision shown again): the next frame.
    const still = Object.assign(robot.newCallMemory('c1'), { primed: true });
    const got: number[] = [];
    for (const now of [T, T, T + 16, T + 32]) {
      robot.observeCalls(still, shown(5, 4), now);
      const c = robot.nextCall('roulette', shown(5, 4), still, { now, moving: false, drawn: true, toss: null, name });
      if (c) { got.push(now); robot.callSaid(still, c); }
    }
    expect(got).toEqual([T + 16]);
    // Endless motion: 8 seconds.
    const out = play([{ v: shown(5, 17), ms: 9_000, moving: true, drawn: true }], Object.assign(robot.newCallMemory('c1'), { primed: true }));
    expect(out.said).toEqual(['🎡 17 BLACK — house wins']);
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

describe('when a robot comes (built views)', () => {
  const live = (): import('./computedRobot').LiveMemory => ({ hotAt: null, ran: null, at: null });
  const W = T + 18_000;

  it('is in play past no more bets, and betting until the deadline', () => {
    expect(robot.liveStep(live(), wheel({ phase: 'closing' }), false, T)).toBe(2);
    expect(robot.liveStep(live(), dice({ phase: 'closing' }), false, T)).toBe(2);
    expect(robot.liveStep(live(), wheel({ phaseDeadline: W }), false, W - 1)).toBe(2);
    // (Roulette: chips down, a little past the deadline for its close.)
    expect(robot.liveStep(live(), wheel({ phaseDeadline: W }), false, W + robot.COMPUTED_CLOSE_SLACK_MS - 1)).toBe(2);
    expect(robot.liveStep(live(), wheel({ phaseDeadline: W }), false, W + robot.COMPUTED_CLOSE_SLACK_MS)).toBe(0);
    expect(robot.liveStep(live(), dice({ phaseDeadline: W }), false, W)).toBe(0);
    expect(robot.liveStep(live(), wheel({}), false, T)).toBe(0);
  });

  it('counts a result on show only for a round this page saw run', () => {
    const m = live();
    expect(robot.liveStep(m, wheel({ phase: 'settled', result: 4, payouts: {}, spinKey: '5:4' }), false, T)).toBe(0);
    expect(robot.liveStep(m, wheel({ phase: 'closing', round: 5 }), false, T + 1_000)).toBe(2);
    expect(m.ran).toEqual({ inc: 'c1', rounds: [5] });
    expect(robot.liveStep(m, wheel({ phase: 'settled', round: 5, result: 4, payouts: {}, spinKey: '5:4' }), false, T + 20_000)).toBe(2);
    // Round 6 betting on the timer, then round 5 shown again for a rewrite:
    // a round this page saw run, so in play.
    expect(robot.liveStep(m, wheel({ round: 6, phaseDeadline: T + 40_000, spinKey: '5:4' }), false, T + 30_000)).toBe(2);
    expect(m.ran).toEqual({ inc: 'c1', rounds: [5, 6] });
    expect(robot.liveStep(m, wheel({ phase: 'settled', round: 5, result: 7, payouts: {}, spinKey: '5:7' }), false, T + 31_000)).toBe(2);
    // Another incarnation's round 5 is another round.
    expect(robot.liveStep(m, wheel({ inc: 'c2', phase: 'settled', round: 5, result: 4, payouts: {}, spinKey: '5:4' }), false, T + 50_000)).toBe(0);
  });

  it('lingers 10 seconds, then is idle; riders keep a craps table quiet', () => {
    const m = live();
    expect(robot.liveStep(m, wheel({ phase: 'closing' }), false, T)).toBe(2);
    expect(robot.liveStep(m, wheel({}), false, T + robot.COMPUTED_LIVE_LINGER_MS - 1)).toBe(1);
    expect(robot.liveStep(m, wheel({}), false, T + robot.COMPUTED_LIVE_LINGER_MS)).toBe(0);
    expect(robot.liveStep(live(), dice({ riders: 2 }), false, T)).toBe(1);
    expect(robot.liveStep(live(), dice({ riders: 0 }), false, T)).toBe(0);
  });

  it('keeps what was left of the linger when the clock goes back', () => {
    const m = live();
    robot.liveStep(m, wheel({ phase: 'closing' }), false, T + 60_000);
    expect(robot.liveStep(m, wheel({}), false, T)).toBe(1);
    expect(m.hotAt).toBe(T);
    expect(robot.liveStep(m, wheel({}), false, T + robot.COMPUTED_LIVE_LINGER_MS)).toBe(0);
    // A table idle 20 s stays idle across a step back of a minute; one 4 s
    // into its linger keeps the 6 s left.
    const idle = live();
    robot.liveStep(idle, wheel({ phase: 'closing' }), false, T + 40_000);
    expect(robot.liveStep(idle, wheel({}), false, T + 60_000)).toBe(0);
    expect(robot.liveStep(idle, wheel({}), false, T)).toBe(0);
    const warm = live();
    robot.liveStep(warm, wheel({ phase: 'closing' }), false, T + 56_000);
    expect(robot.liveStep(warm, wheel({}), false, T + 60_000)).toBe(1);
    expect(robot.liveStep(warm, wheel({}), false, T)).toBe(1);
    expect(robot.liveStep(warm, wheel({}), false, T + 5_999)).toBe(1);
    expect(robot.liveStep(warm, wheel({}), false, T + 6_000)).toBe(0);
  });

  it('counts nothing of a view not yet checked but someone there and the linger', () => {
    const unchecked = { checked: false, decidedTo: null };
    expect(robot.liveStep(live(), wheel({ phase: 'closing' }), false, T, unchecked)).toBe(0);
    expect(robot.liveStep(live(), dice({ riders: 2 }), false, T, unchecked)).toBe(0);
    expect(robot.liveStep(live(), wheel({ phase: 'closing' }), true, T, unchecked)).toBe(2);
    const m = live();
    robot.liveStep(m, wheel({ phase: 'closing' }), false, T);
    expect(robot.liveStep(m, wheel({ phase: 'closing' }), false, T + 1_000, unchecked)).toBe(1);
    // (Nor does it mark the round as seen run.)
    const n = live();
    robot.liveStep(n, wheel({ phaseDeadline: W }), false, T, unchecked);
    expect(n.ran).toBeNull();
  });

  it("doesn't count a decided round held again for its forfeit's grace as running, unless this page saw it run", () => {
    const decided = { checked: true, decidedTo: 5 };
    expect(robot.liveStep(live(), wheel({ phase: 'closing', round: 5 }), false, T, decided)).toBe(0);
    expect(robot.liveStep(live(), wheel({ phase: 'closing', round: 6 }), false, T, decided)).toBe(2);
    const m = live();
    expect(robot.liveStep(m, wheel({ phase: 'closing', round: 5 }), false, T, { checked: true, decidedTo: 4 })).toBe(2);
    expect(robot.liveStep(m, wheel({ phase: 'closing', round: 5 }), false, T + 1_000, decided)).toBe(2);
    // (A replay marks nothing: its show isn't in play either.)
    const n = live();
    robot.liveStep(n, wheel({ phase: 'closing', round: 5 }), false, T, decided);
    expect(robot.liveStep(n, wheel({ phase: 'settled', round: 5, result: 4, payouts: {}, spinKey: '5:4' }), false, T + 20_000, decided)).toBe(0);
  });

  it('is in play while someone stands there, even with nothing to show', () => {
    expect(robot.liveStep(live(), null, true, T)).toBe(2);
    expect(robot.liveStep(live(), null, false, T)).toBe(0);
    expect(robot.liveStep(live(), wheel({}), true, T)).toBe(2);
  });

  it('counts an avatar within 0.7 m of a player stand, never at the robot\'s own', () => {
    const stands = [{ front: { x: 0, z: 0 } }, { front: { x: 5, z: 0 }, role: 'wheelHead' }];
    expect(robot.someoneAtStands(stands, [{ x: 0.69, z: 0 }])).toBe(true);
    expect(robot.someoneAtStands(stands, [{ x: 0.7, z: 0 }])).toBe(false);
    expect(robot.someoneAtStands(stands, [{ x: 0.4, z: 0.4 }])).toBe(true);
    expect(robot.someoneAtStands(stands, [{ x: 5, z: 0 }])).toBe(false);
    expect(robot.someoneAtStands(stands, [])).toBe(false);
  });
});

describe('which robot works a table', () => {
  const ROUTINES = ['serve', 'croupier', 'idle', 'custom', 'coach', 'dance', 'pilot', 'disassemble'] as const;
  /** world.ts updateCroupier's owner-run robot test, copied (routineOf
   *  given): a players' table's test must match it. */
  const todays = (routine: string, hasDedicated: boolean): boolean =>
    routine !== 'idle' &&
    routine !== 'custom' &&
    routine !== 'coach' &&
    routine !== 'dance' &&
    routine !== 'pilot' &&
    routine !== 'disassemble' &&
    (!hasDedicated || routine === 'croupier');

  it('allows the routines World allows, with and without a dedicated croupier', () => {
    for (const r of ROUTINES) for (const d of [false, true]) expect(robot.mayCroupier(r, d)).toBe(todays(r, d));
  });

  /** world.ts updateCroupier's hand-out before PR 4, copied: the drop and
   *  the fill over the live tables, as a function of what it reads. */
  function todaysHandOut(
    assign: Map<string, string>, keys: readonly string[], pos: Map<string, { x: number; z: number }>,
    liveTableIds: readonly string[], posts: Map<string, { x: number; z: number }>, eligible: (k: string) => boolean,
  ): void {
    const liveIdSet = new Set(liveTableIds);
    for (const [key, tid] of [...assign]) {
      if (!eligible(key) || !liveIdSet.has(tid)) assign.delete(key);
    }
    const takenTables = new Set(assign.values());
    const freeRobots = keys.filter((k) => eligible(k) && !assign.has(k));
    for (const tid of liveTableIds) {
      if (takenTables.has(tid)) continue;
      const post = posts.get(tid)!;
      let bestKey: string | null = null;
      let best = Infinity;
      for (const key of freeRobots) {
        const bp = pos.get(key)!;
        const d = Math.hypot(bp.x - post.x, bp.z - post.z);
        if (d < best) {
          best = d;
          bestKey = key;
        }
      }
      if (bestKey) {
        assign.set(bestKey, tid);
        takenTables.add(tid);
        freeRobots.splice(freeRobots.indexOf(bestKey), 1);
      }
    }
  }

  /** A seeded room: robots and tables on a small grid (ties happen), some
   *  robots unable to work, some tables owner-run with a heartbeat. */
  function randomRoom(seed: number, mixed: boolean) {
    let s = seed >>> 0;
    const rnd = (): number => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
    const cell = (): number => Math.floor(rnd() * 5);
    const robots = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => ({
      key: `r${i}`, x: cell(), z: cell(), owner: rnd() < 0.8, computed: rnd() < 0.8,
    }));
    const tables = Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => {
      const owner = !mixed || rnd() < 0.5;
      return { id: `t${i}`, x: cell(), z: cell(), owner, pull: (owner ? 3 : 2) as 0 | 1 | 2 | 3 };
    });
    /** Frame to frame an owner-run table's heartbeat starts and stops, and
     *  a players' table goes in and out of play (a table keeps its kind). */
    const flip = (t: (typeof tables)[number]): void => {
      t.pull = t.owner ? (t.pull === 3 ? 0 : 3) : ([0, 1, 2].filter((x) => x !== t.pull)[Math.floor(rnd() * 2)] as 0 | 1 | 2);
    };
    return { robots, tables, rnd, flip };
  }

  it('in a room with only owner-run tables, hands out exactly as World did (500 rooms, 6 frames each)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const { robots, tables, rnd, flip } = randomRoom(seed, false);
      const ours = new Map<string, string>();
      const theirs = new Map<string, string>();
      for (let f = 0; f < 6; f++) {
        // Frame to frame tables come and go and robots walk.
        for (const t of tables) if (rnd() < 0.2) flip(t);
        for (const r of robots) if (rnd() < 0.3) { r.x = Math.floor(rnd() * 5); r.z = Math.floor(rnd() * 5); }
        const pulls = tables.filter((t) => t.pull === 3).map((t) => ({ id: t.id, x: t.x, z: t.z, pull: 3 as const }));
        robot.assignCroupiers(ours, robots, pulls);
        todaysHandOut(
          theirs, robots.map((r) => r.key), new Map(robots.map((r) => [r.key, r])), pulls.map((t) => t.id),
          new Map(pulls.map((t) => [t.id, t])), (k) => robots.find((r) => r.key === k)!.owner,
        );
        expect([...ours].sort(), `room ${seed}, frame ${f}`).toEqual([...theirs].sort());
      }
    }
  });

  it('in a room with both kinds, the owner-run tables get what World would give them alone (500 rooms)', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const { robots, tables, rnd, flip } = randomRoom(seed, true);
      const ours = new Map<string, string>();
      const theirs = new Map<string, string>();
      for (let f = 0; f < 6; f++) {
        for (const t of tables) if (rnd() < 0.3) flip(t);
        for (const r of robots) if (rnd() < 0.3) { r.x = Math.floor(rnd() * 5); r.z = Math.floor(rnd() * 5); }
        const pulls = tables.filter((t) => t.pull > 0).map((t) => ({ id: t.id, x: t.x, z: t.z, pull: t.pull as 1 | 2 | 3 }));
        robot.assignCroupiers(ours, robots, pulls);
        const owned = pulls.filter((t) => t.pull === 3);
        todaysHandOut(
          theirs, robots.map((r) => r.key), new Map(robots.map((r) => [r.key, r])), owned.map((t) => t.id),
          new Map(owned.map((t) => [t.id, t])), (k) => robots.find((r) => r.key === k)!.owner,
        );
        const ownedIds = new Set(owned.map((t) => t.id));
        const oursOwned = [...ours].filter(([, tid]) => ownedIds.has(tid)).sort();
        expect(oursOwned, `room ${seed}, frame ${f}`).toEqual([...theirs].sort());
        // Every robot works one table at most, and every table has one robot at most.
        expect(new Set(ours.values()).size).toBe(ours.size);
        // Each robot may work the table it has.
        const pullOf = new Map(pulls.map((t) => [t.id, t.pull]));
        for (const [key, tid] of ours) {
          const r = robots.find((x) => x.key === key)!;
          expect(pullOf.get(tid) === 3 ? r.owner : r.computed).toBe(true);
        }
      }
    }
  });

  const R = (key: string, x: number, over: Partial<import('./computedRobot').RobotAt> = {}) => ({ key, x, z: 0, owner: true, computed: true, ...over });
  const P = (id: string, x: number, pull: 1 | 2 | 3) => ({ id, x, z: 0, pull });

  it('an owner-run table takes the nearest robot, even one at a players\' table, which then takes a free one', () => {
    const assign = new Map([['a', 'players']]);
    robot.assignCroupiers(assign, [R('a', 1), R('b', 9)], [P('owner', 0, 3), P('players', 2, 2)]);
    expect(Object.fromEntries(assign)).toEqual({ a: 'owner', b: 'players' });
  });

  it('a table in play takes a free robot first, then one from a quiet table, never from another in play or an owner-run table', () => {
    const free = new Map([['a', 'quiet']]);
    robot.assignCroupiers(free, [R('a', 1), R('b', 9)], [P('quiet', 1, 1), P('play', 0, 2)]);
    expect(Object.fromEntries(free)).toEqual({ a: 'quiet', b: 'play' });
    const handover = new Map([['a', 'quiet']]);
    robot.assignCroupiers(handover, [R('a', 1)], [P('quiet', 1, 1), P('play', 0, 2)]);
    expect(Object.fromEntries(handover)).toEqual({ a: 'play' });
    const busy = new Map([['a', 'other'], ['b', 'owner']]);
    robot.assignCroupiers(busy, [R('a', 1), R('b', 0)], [P('other', 1, 2), P('owner', 0, 3), P('play', 0, 2)]);
    expect(Object.fromEntries(busy)).toEqual({ a: 'other', b: 'owner' });
  });

  it('quiet tables get only free robots; ties go to the first robot; assignments stick', () => {
    const q = new Map([['a', 'q1']]);
    robot.assignCroupiers(q, [R('a', 1)], [P('q1', 5, 1), P('q2', 1, 1)]);
    expect(Object.fromEntries(q)).toEqual({ a: 'q1' });
    const tie = new Map<string, string>();
    robot.assignCroupiers(tie, [R('b', 1), R('a', -1)], [P('t', 0, 2)]);
    expect(Object.fromEntries(tie)).toEqual({ b: 't' });
    const stick = new Map([['far', 't']]);
    robot.assignCroupiers(stick, [R('near', 0), R('far', 9)], [P('t', 0, 2)]);
    expect(Object.fromEntries(stick)).toEqual({ far: 't' });
  });

  it('lets go of a robot that may no longer work its table, or whose table no longer wants one', () => {
    const a = new Map([['a', 'players'], ['b', 'owner']]);
    robot.assignCroupiers(a, [R('a', 0, { computed: false }), R('b', 0, { owner: false })], [P('players', 0, 2), P('owner', 0, 3)]);
    expect(Object.fromEntries(a)).toEqual({ a: 'owner', b: 'players' });
    const none = new Map([['a', 'players'], ['b', 'owner']]);
    robot.assignCroupiers(none, [R('a', 0, { computed: false, owner: false }), R('b', 0, { owner: false, computed: false })], [P('players', 0, 2), P('owner', 0, 3)]);
    expect(none.size).toBe(0);
    const b = new Map([['a', 'gone']]);
    robot.assignCroupiers(b, [R('a', 0)], []);
    expect(b.size).toBe(0);
  });
});

describe("the craps table's test of running itself", () => {
  it("is the stickman's own (crapsCroupier crapsRunsItself), read from casinoDoc", async () => {
    const { readFileSync } = await import('node:fs');
    const stickman = readFileSync(new URL('./crapsCroupier.ts', import.meta.url), 'utf8');
    const ours = readFileSync(new URL('./computedRobot.ts', import.meta.url), 'utf8');
    expect(stickman).toContain("return isComputedFor(tableId, 'craps') || computedSwitchLost(tableId, 'craps');");
    expect(ours).toContain("game === 'craps' ? isComputedFor(t, 'craps') || computedSwitchLost(t, 'craps')");
    // (And no import of the stickman's module graph.)
    expect(ours).not.toMatch(/from '\.\/crapsCroupier'/);
  });
});

describe("time's up (built views)", () => {
  const WAIT_END = T + 36_000;
  /** Roll 5 in the wait for Ann's throw, until WAIT_END. */
  const waiting = (): ComputedCrapsState => dice({
    inc: 'k1', phase: 'closing', holder: 'player-Ann', shooterInPlay: true, shooterSlip: 'gone', phaseDeadline: WAIT_END,
  });
  const tossed = dice({ inc: 'k1', phase: 'closing', holder: 'player-Ann', shooterInPlay: true });
  const landed = roll(2, 3, { inc: 'k1', holderBefore: 'player-Ann', shooterAfter: 'player-Ann' });
  const primedK = () => Object.assign(robot.newCallMemory('k1'), { primed: true });
  const toss = (at: number, r = 5, inc = 'k1') => ({ inc, r, at });

  it('a wait seen run out, then the stickman\'s toss at the close: time\'s up once, then the dice', () => {
    const out = play([
      { v: waiting(), ms: 1_000 },
      { v: tossed, ms: 1_000, toss: toss(WAIT_END) },
      { v: landed, ms: 1_000, toss: toss(WAIT_END) },
    ], primedK(), WAIT_END - 1_000);
    expect(out.said).toEqual([
      '✋ No more bets — the stickman throws for Ann in 1 second',
      "🎲 Time's up — the stickman throws",
      '🎲 2+3 = 5 — house collects',
    ]);
    expect(out.keys[1]).toBe('k1|5|timesup');
  });

  it('comes before the result when both are due, and not once the result is called', () => {
    const both = play([
      { v: waiting(), ms: 500 },
      { v: landed, ms: 500, toss: toss(WAIT_END) },
    ], primedK(), WAIT_END - 500);
    expect(both.said.slice(1)).toEqual(["🎲 Time's up — the stickman throws", '🎲 2+3 = 5 — house collects']);
    const late = play([
      { v: waiting(), ms: 500 },
      { v: landed, ms: 500 },
      { v: landed, ms: 500, toss: toss(WAIT_END + 500) },
    ], primedK(), WAIT_END - 500);
    expect(late.said.slice(1)).toEqual(['🎲 2+3 = 5 — house collects']);
  });

  it('says nothing for a toss before the wait ended here, of another roll or incarnation, or with no wait seen', () => {
    for (const t of [toss(WAIT_END - 1), toss(WAIT_END, 6), toss(WAIT_END, 5, 'k2')]) {
      const out = play([{ v: waiting(), ms: 1_000 }, { v: tossed, ms: 1_000, toss: t }], primedK(), WAIT_END - 1_000);
      expect(out.said).toEqual(['✋ No more bets — the stickman throws for Ann in 1 second']);
    }
    const unseen = play([{ v: tossed, ms: 1_000, toss: toss(WAIT_END) }], primedK(), WAIT_END);
    expect(unseen.said).toEqual(['✋ No more bets!']);
  });

  it('never at roulette, and a toss shown before priming counts as said', () => {
    const m = robot.newCallMemory('k1');
    robot.primeCalls(m, waiting(), toss(WAIT_END));
    expect(m.timesUp).toBe(5);
    const wheelOut = play([{ v: wheel({ phase: 'closing', round: 5 }), ms: 500, toss: toss(T, 5, 'c1') }], Object.assign(robot.newCallMemory('c1'), { primed: true }));
    expect(wheelOut.said).toEqual(['✋ No more bets!']);
  });
});
