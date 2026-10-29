/**
 * 🤖🧮 The robot at a players' table on real pages (computedRobot over
 * computedTable): what it calls as each page shows the table, with the
 * room's real records.
 *
 * Each page is its own load of the casino modules (computedPageKit). At
 * roulette page O watches test players X, Y and Z (computedTestKit) whose
 * records a spec writes by hand, so nothing moves a round but what the spec
 * writes; at craps, pages play with their own duties running. A page's
 * robot is asked every frame, as World asks it, and everything it gives is
 * taken as said.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { dutyRank } from './computedFold';
import {
  clockOf, CRAPS_REF, CRAPS_TABLE, crapsBet, crapsPointOn, deleteIn, frame, loadPage, openCrapsRoom, openRoom, PAGE_CTX as CTX,
  PAGE_TABLE as TABLE, putIn, rigRoll, standAt, switchOn, sync,
} from './computedPageKit';
import type { ComputedTableRef } from './computedTable';
import type { Page } from './computedPageKit';
import { ComputedKit, red, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 100;
const kit = new ComputedKit(CTX);
const X = testIdentity('robot-x', 'player-X');
const Y_ = testIdentity('robot-y', 'player-Y');
const Z = testIdentity('robot-z', 'player-Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** Page O, 1,000 chips, the table on, watching X, Y and Z (pinned). */
async function watch(): Promise<Page> {
  const [o] = await openRoom(['O'], T0);
  pinOn(o, X, Y_, Z);
  return o;
}

/** Records into page p's live session, first seen at T. */
function putAt(p: Page, T: number, ...recs: Built<unknown>[]): void {
  clockOf(p, T);
  putIn(p, recs.map((r): [string, unknown] => [r.key, r.rec]));
}

const foldOf = (p: Page, t = TABLE) => p.casino.computedFoldOf(t)!;

interface Ear {
  said: { at: number; text: string; key: string }[];
  /** One frame of the page's robot at T (its level, then its call), the
   *  call it gives taken as said. */
  hear(T: number, moving?: boolean): void;
  /** Frames from `from` to `to` (inclusive). */
  hearFor(from: number, to: number, moving?: boolean): void;
  texts(): string[];
}

function ear(p: Page, game: 'roulette' | 'craps' = 'roulette', t = TABLE): Ear {
  const said: Ear['said'] = [];
  const e: Ear = {
    said,
    hear(T, moving = false) {
      const now = clockOf(p, T);
      p.croupier.noteTablesRunning(now);
      // (World asks the level first, every frame, then the call.)
      p.robot.computedTableLevel(t, game, false, now);
      const c = p.robot.computedTableCall(t, game, now, moving);
      if (!c) return;
      said.push({ at: T, text: c.text, key: c.key });
      p.robot.noteComputedCallSaid(t, c);
    },
    hearFor(from, to, moving = false) {
      for (let T = from; T <= to; T += STEP) e.hear(T, moving);
    },
    texts: () => said.map((s) => s.text),
  };
  return e;
}

const pocketOf = (p: Page, r: number) => foldOf(p).rounds.find((v) => v.r === r)!.pocket!;
const colourOf = (n: number): string => (n === 0 ? 'GREEN' : [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36].includes(n) ? 'RED' : 'BLACK');

/** What page p's records do, by the spec's time. */
type Script = [at: number, act: () => void][];

/** Frames of page p from `from` to `to`: at each, what the script has due
 *  (first seen then), then the robot. */
function play(p: Page, e: Ear, script: Script, from: number, to: number): void {
  for (let T = from; T <= to; T += STEP) {
    for (const [at, act] of script) {
      if (at === T) {
        clockOf(p, T);
        act();
      }
    }
    e.hear(T);
  }
}

/** Round r on page o from T: X's and Y's felts, closed by X 18 s on, both
 *  seeds in 1 s later (the result shows then). */
function roundOf(o: Page, r: number, T: number, ids: TestIdentity[] = [X, Y_]): Script {
  const slips = ids.map((id) => kit.slip(id, r, [red(5)]));
  return [
    [T, () => putIn(o, slips.map((x): [string, unknown] => [x.key, x.rec]))],
    [T + 18_000, () => { const c = kit.close(X, r, foldOf(o).parent, slips); putIn(o, [[c.key, c.rec]]); }],
    [T + 19_000, () => putIn(o, ids.map((id): [string, unknown] => { const x = kit.reveal(r, id.pid); return [x.key, x.rec]; }))],
  ];
}

/** The result call a round settled on page o reads with (paid or not). */
function resultCall(o: Page, r: number): string {
  const D = foldOf(o).rounds.find((v) => v.r === r)!;
  const paid = [...D.payouts].some(([, n]) => n > 0n);
  return `🎡 ${D.pocket} ${colourOf(D.pocket!)} — ${paid ? 'winners paid!' : 'house wins'}`;
}

describe('a roulette round on a real page', () => {
  it('opens, closes and calls the result once each, and writes nothing to the room', async () => {
    const o = await watch();
    const e = ear(o);
    e.hearFor(T0, T0 + 1_000);
    expect(e.said).toEqual([]);
    const sv = Y.encodeStateVector(o.doc);
    const script = roundOf(o, 1, T0 + 1_100);
    // (Only the script writes: the robot's frames between its steps don't,
    // not even a delete, which moves no state vector: no transaction at all.)
    let robotWrites = 0;
    const count = (): void => {
      robotWrites += 1;
    };
    for (let T = T0 + 1_100; T <= T0 + 40_000; T += STEP) {
      const due = script.filter(([at]) => at === T);
      for (const [, act] of due) { clockOf(o, T); act(); }
      o.doc.on('beforeTransaction', count);
      try {
        e.hear(T);
      } finally {
        o.doc.off('beforeTransaction', count);
      }
    }
    expect(robotWrites).toBe(0);
    expect(Y.encodeStateVector(o.doc)).not.toEqual(sv);
    expect(e.texts()).toEqual(['🎲 Place your bets!', '✋ No more bets!', resultCall(o, 1)]);
    expect(e.said.map((x) => x.at)).toEqual([T0 + 1_100, T0 + 19_100, T0 + 20_100]);
  });

  it('says nothing before the records are whole, then opens the window still running', async () => {
    const o = await watch();
    const e = ear(o);
    putAt(o, T0, kit.slip(X, 1, [red(5)]));
    const rest = partOfAnUpdate(o);
    e.hearFor(T0, T0 + 3_000);
    expect(e.said).toEqual([]);
    Y.applyUpdate(o.doc, rest);
    e.hearFor(T0 + 3_100, T0 + 4_000);
    expect(e.texts()).toEqual(['🎲 Place your bets!']);
  });

  it('a page that loads during the last result\'s show says nothing old, then calls the next round', async () => {
    const o = await watch();
    const e0 = ear(o);
    play(o, e0, roundOf(o, 1, T0), T0, T0 + 21_000);
    expect(e0.said).toHaveLength(3);
    const p = await loadPage('P', 2);
    const load = T0 + 21_000;
    sync(load, o, p);
    const e = ear(p);
    e.hearFor(load, load + p.table.SHOW_MS + 2_000);
    expect(p.table.readComputedRoulette(TABLE, load)).toMatchObject({ phase: 'settled', round: 1 });
    expect(e.said).toEqual([]);
    const next = load + p.table.SHOW_MS + 3_000;
    putAt(o, next, kit.slip(X, 2, [red(5)]));
    sync(next, o, p);
    e.hearFor(next, next + 1_000);
    expect(e.texts()).toEqual(['🎲 Place your bets!']);
  });

  it('after a sleep the re-show is silent, but a result changed meanwhile is called', async () => {
    const o = await watch();
    const e = ear(o);
    const slips = [X, Y_, Z].map((id) => kit.slip(id, 1, [red(5)]));
    const closeSeen = T0 + 18_000;
    const [better, worse] = [X, Y_].sort((a, b) => (dutyRank('forfeit', CTX, 1, a.pub) < dutyRank('forfeit', CTX, 1, b.pub) ? -1 : 1));
    let closeHash = '';
    play(o, e, [
      [T0, () => putIn(o, slips.map((x): [string, unknown] => [x.key, x.rec]))],
      [closeSeen, () => { const c = kit.close(X, 1, foldOf(o).parent, slips); closeHash = c.hash; putIn(o, [[c.key, c.rec]]); }],
      [closeSeen + 500, () => putIn(o, [X, Y_].map((id): [string, unknown] => { const x = kit.reveal(1, id.pid); return [x.key, x.rec]; }))],
      [closeSeen + 4_000, () => { const f = kit.forfeit(worse, 1, closeHash, [worse.pid]); putIn(o, [[f.key, f.rec]]); }],
    ], T0, closeSeen + 6_000);
    expect(e.texts()).toEqual(['🎲 Place your bets!', '✋ No more bets!', resultCall(o, 1)]);
    // Asleep 20 s, unchanged: on the wake round 1 is held for its forfeit's
    // grace again, then its result shows again, all unsaid.
    const wake = closeSeen + 26_000;
    const phases = new Set<string>();
    for (let T = wake; T <= wake + 8_000; T += STEP) {
      e.hear(T);
      const v = o.table.readComputedRoulette(TABLE, T)!;
      phases.add(`${v.phase}:${v.round}`);
    }
    expect(o.croupier.tablesWakeCount()).toBe(1);
    expect([...phases]).toEqual(['closing:1', 'settled:1']);
    expect(e.said).toHaveLength(3);
    // Asleep again, and the better forfeit comes meanwhile: the new pocket is called.
    const first = pocketOf(o, 1);
    clockOf(o, wake + 5_000);
    const f = kit.forfeit(better, 1, closeHash, [X.pid, Y_.pid]);
    putIn(o, [[f.key, f.rec]]);
    expect(pocketOf(o, 1)).not.toBe(first);
    const wake2 = wake + 30_000;
    e.hearFor(wake2, wake2 + 8_000);
    expect(o.croupier.tablesWakeCount()).toBe(2);
    expect(e.texts().slice(3)).toEqual([resultCall(o, 1).replace('🎡 ', '🎡 Round 1 is now ')]);
  });

  it('a sleep while the wheel still spins: the result is called as it stops after the wake, not before', async () => {
    const o = await watch();
    const e = ear(o);
    const script = roundOf(o, 1, T0);
    const shows = T0 + 19_000;
    play(o, e, script, T0, shows - STEP);
    expect(e.texts()).toEqual(['🎲 Place your bets!', '✋ No more bets!']);
    // The seeds come and the wheel spins for the pocket; 2 s in, the tab is
    // hidden 7 s, and the wheel spins on for 2 s when it comes back.
    for (const [at, act] of script) if (at === shows) { clockOf(o, shows); act(); }
    e.hearFor(shows, shows + 2_000, true);
    const wake = shows + 9_000;
    e.hearFor(wake, wake + 2_000, true);
    expect(o.croupier.tablesWakeCount()).toBe(1);
    expect(e.said).toHaveLength(2);
    e.hearFor(wake + 2_100, wake + 3_000);
    expect(e.texts().slice(2)).toEqual([resultCall(o, 1)]);
    expect(e.said[2].at).toBe(wake + 2_100);
  });

  /** Round 1 on page o, every frame heard: X, Y and Z bet, X closes, X's
   *  and Y's seeds come, and the forfeit of whichever of X and Y ranks
   *  worse decides it 4 s after the close (Z's seed never came). */
  function forfeited(o: Page, e: Ear): { closeSeen: number } {
    const slips = [X, Y_, Z].map((id) => kit.slip(id, 1, [red(5)]));
    const closeSeen = T0 + 18_000;
    const worse = [X, Y_].sort((a, b) => (dutyRank('forfeit', CTX, 1, a.pub) < dutyRank('forfeit', CTX, 1, b.pub) ? -1 : 1))[1];
    let closeHash = '';
    play(o, e, [
      [T0, () => putIn(o, slips.map((x): [string, unknown] => [x.key, x.rec]))],
      [closeSeen, () => { const c = kit.close(X, 1, foldOf(o).parent, slips); closeHash = c.hash; putIn(o, [[c.key, c.rec]]); }],
      [closeSeen + 500, () => putIn(o, [X, Y_].map((id): [string, unknown] => { const x = kit.reveal(1, id.pid); return [x.key, x.rec]; }))],
      [closeSeen + 4_000, () => { const f = kit.forfeit(worse, 1, closeHash, [worse.pid]); putIn(o, [[f.key, f.rec]]); }],
    ], T0, closeSeen + 6_000);
    expect(e.texts()).toEqual(['🎲 Place your bets!', '✋ No more bets!', resultCall(o, 1)]);
    return { closeSeen };
  }

  /** Frames of page p's robot from `from` to `to`: what it says, and every
   *  level and phase it shows, in order. */
  function watchFrom(p: Page, e: Ear, from: number, to: number): { levels: number[]; phases: string[] } {
    const levels: number[] = [];
    const phases: string[] = [];
    for (let T = from; T <= to; T += STEP) {
      const now = clockOf(p, T);
      p.croupier.noteTablesRunning(now);
      const l = p.robot.computedTableLevel(TABLE, 'roulette', false, now);
      if (levels.at(-1) !== l) levels.push(l);
      const c = p.robot.computedTableCall(TABLE, 'roulette', now);
      if (c) {
        e.said.push({ at: T, text: c.text, key: c.key });
        p.robot.noteComputedCallSaid(TABLE, c);
      }
      const v = p.table.readComputedRoulette(TABLE, T);
      const ph = v ? `${v.phase}:${v.round}` : 'none';
      if (phases.at(-1) !== ph) phases.push(ph);
    }
    return { levels, phases };
  }

  it("a page that loads as the last round, a forfeit's, is held again for its grace stays idle and says nothing: neither no more bets nor the old result", async () => {
    const o = await watch();
    const { closeSeen } = forfeited(o, ear(o));
    const p = await loadPage('P', 2);
    const load = closeSeen + 30_000;
    sync(load, o, p);
    const e = ear(p);
    const seen = watchFrom(p, e, load, load + 8_000 + p.table.SHOW_MS);
    expect(seen.phases.slice(0, 2)).toEqual(['closing:1', 'settled:1']);
    expect(seen.levels).toEqual([0]);
    expect(e.said).toEqual([]);
  });

  it("a page that wakes after the next round opened shows the last round held again: no second no more bets, and idle", async () => {
    const o = await watch();
    const e = ear(o);
    const { closeSeen } = forfeited(o, e);
    // Round 2 opens (X's felt) and runs on this page a while; then the page
    // sleeps past the lapse and wakes before round 2's deadline.
    const open = closeSeen + 6_000 + o.table.SHOW_MS;
    e.hearFor(closeSeen + 6_000 + STEP, open - STEP);
    putAt(o, open, kit.slip(X, 2, [red(5)]));
    e.hearFor(open, open + 2_000);
    expect(e.texts().slice(3)).toEqual(['🎲 Place your bets!']);
    const wake = open + 9_000;
    const seen = watchFrom(o, e, wake, wake + 8_000);
    expect(o.croupier.tablesWakeCount()).toBe(1);
    expect(seen.phases[0]).toBe('closing:1');
    expect(e.texts().slice(4).filter((x) => x.startsWith('✋'))).toEqual([]);
    expect(e.texts().slice(4).filter((x) => x.startsWith('🎡'))).toEqual([]);
    // (Lingering from round 2's window, then idle through round 1's hold and
    // show: never in play for it.)
    expect(seen.levels).toEqual([1, 0]);
  });

  it('calls a rewritten round again, and again when it is rewritten back', async () => {
    const o = await watch();
    const e = ear(o);
    const slips = [X, Y_, Z].map((id) => kit.slip(id, 1, [red(5)]));
    const closeSeen = T0 + 18_000;
    const [better, worse] = [X, Y_].sort((a, b) => (dutyRank('forfeit', CTX, 1, a.pub) < dutyRank('forfeit', CTX, 1, b.pub) ? -1 : 1));
    let closeHash = '';
    let betterKey = '';
    play(o, e, [
      [T0, () => putIn(o, slips.map((x): [string, unknown] => [x.key, x.rec]))],
      [closeSeen, () => { const c = kit.close(X, 1, foldOf(o).parent, slips); closeHash = c.hash; putIn(o, [[c.key, c.rec]]); }],
      [closeSeen + 500, () => putIn(o, [X, Y_].map((id): [string, unknown] => { const x = kit.reveal(1, id.pid); return [x.key, x.rec]; }))],
      [closeSeen + 4_000, () => { const f = kit.forfeit(worse, 1, closeHash, [worse.pid]); putIn(o, [[f.key, f.rec]]); }],
    ], T0, closeSeen + 5_500);
    const first = pocketOf(o, 1);
    expect(e.texts()).toEqual(['🎲 Place your bets!', '✋ No more bets!', resultCall(o, 1)]);
    play(o, e, [
      [closeSeen + 5_600, () => { const f = kit.forfeit(better, 1, closeHash, [X.pid, Y_.pid]); betterKey = f.key; putIn(o, [[f.key, f.rec]]); }],
    ], closeSeen + 5_600, closeSeen + 6_000);
    expect(pocketOf(o, 1)).not.toBe(first);
    expect(e.texts().slice(3)).toEqual([resultCall(o, 1).replace('🎡 ', '🎡 Round 1 is now ')]);
    play(o, e, [[closeSeen + 6_100, () => deleteIn(o, [betterKey])]], closeSeen + 6_100, closeSeen + 6_500);
    expect(pocketOf(o, 1)).toBe(first);
    expect(e.texts().slice(4)).toEqual([resultCall(o, 1).replace('🎡 ', '🎡 Round 1 is now ')]);
  });

  it('a switch off and on starts afresh: the new incarnation\'s round 1 is called', async () => {
    const o = await watch();
    const e = ear(o);
    play(o, e, roundOf(o, 1, T0), T0, T0 + 21_000);
    expect(e.said).toHaveLength(3);
    const inc2 = 'c' + '6b'.repeat(12);
    const kit2 = new ComputedKit({ ...CTX, inc: inc2 });
    const slips = [X, Y_].map((id) => kit2.slip(id, 1, [red(5)]));
    const at = T0 + 22_000;
    play(o, e, [
      [at, () => switchOn(o, TABLE, inc2)],
      [at + 1_000, () => putIn(o, slips.map((x): [string, unknown] => [x.key, x.rec]))],
    ], at, at + 2_000);
    expect(e.texts().slice(3)).toEqual(['🎲 Place your bets!']);
    expect(e.said[3].key).toBe(`${inc2}|1|open|${at + 1_000 + o.table.BET_WINDOW_MS}`);
  });

  it("an earlier build's heartbeat and its table state change no call, against a twin page with neither", async () => {
    const o = await watch();
    const twin = await watch();
    const eo = ear(o);
    const ew = ear(twin);
    const slips = [X, Y_].map((id) => kit.slip(id, 1, [red(5)]));
    const both = (act: (p: Page) => void) => () => { act(o); act(twin); };
    const script: Script = [
      [T0 + 500, both((p) => putIn(p, slips.map((x): [string, unknown] => [x.key, x.rec])))],
      [T0 + 18_500, both((p) => { const c = kit.close(X, 1, foldOf(p).parent, slips); putIn(p, [[c.key, c.rec]]); })],
      [T0 + 19_500, both((p) => putIn(p, [X, Y_].map((id): [string, unknown] => { const x = kit.reveal(1, id.pid); return [x.key, x.rec]; })))],
    ];
    for (let T = T0; T <= T0 + 32_000; T += STEP) {
      for (const [at, act] of script) if (at === T) { clockOf(o, T); act(); }
      if (T % 3_000 === 0) {
        // The earlier build's lease holder: its heartbeat and its own round.
        clockOf(o, T);
        o.casino.writeCroupierBeat(TABLE, T);
        o.casino.writeTableState(TABLE, { kind: 'roulette', phase: 'settled', round: 9, result: 3, resultAt: T, payouts: {}, phaseDeadline: T + 9_000 });
        expect(o.croupier.isCroupierLive(TABLE)).toBe(true);
      }
      eo.hear(T);
      ew.hear(T);
    }
    expect(eo.texts()).toEqual(ew.texts());
    expect(eo.texts()).toHaveLength(3);
  });
});

describe('a craps roll on real pages', () => {
  it('calls the come-out, no more bets and the dice, and who gets them, on every page alike', async () => {
    const pages = await openCrapsRoom(['A', 'B'], T0);
    const [a, b] = pages;
    standAt(a, 1);
    standAt(b, 3);
    rigRoll([a, b], 1, 6);
    expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
    expect(crapsBet(b, [{ type: 'pass', amount: 5 }], T0)).toBe('ok');
    sync(T0, ...pages);
    const ears = pages.map((p) => ear(p, 'craps', CRAPS_TABLE));
    for (let T = T0; T <= T0 + 30_000; T += STEP) {
      sync(T, ...pages);
      for (const p of pages) frame(T, p, [CRAPS_REF]);
      sync(T, ...pages);
      for (const e of ears) e.hear(T);
    }
    const [ea, eb] = ears;
    expect(ea.texts()).toEqual(eb.texts());
    const v = a.table.readComputedCraps(CRAPS_TABLE)!;
    expect(ea.texts().slice(0, 2)).toEqual(['🎲 Coming out — place your bets!', '✋ No more bets!']);
    // The point is on: the pass line rides, and the dice go to the first stand.
    expect(ea.texts()[2]).toMatch(new RegExp(`^🎲 \\d\\+\\d = 6 — house collects, the dice pass to ${v.holder === a.pid ? 'player-A' : 'player-B'}$`));
    expect(ea.texts()[3]).toBe('🎲 The point is 6 — place your bets!');
  });
});

describe('when a robot comes, on real pages', () => {
  /** Page p's level for table t at T, nobody standing there unless `there`. */
  /** Page p's level at T, then its call heard (World asks both every frame:
   *  a level counts the table's rounds once its calls are primed). */
  const level = (p: Page, T: number, game: 'roulette' | 'craps' = 'roulette', t = TABLE, there = false) => {
    const now = clockOf(p, T);
    p.croupier.noteTablesRunning(now);
    const l = p.robot.computedTableLevel(t, game, there, now);
    const c = p.robot.computedTableCall(t, game, now);
    if (c) p.robot.noteComputedCallSaid(t, c);
    return l;
  };

  it('a round seen run is in play through its show, then lingers 10 seconds', async () => {
    const o = await watch();
    const e = ear(o);
    const levels: [number, number][] = [];
    const script = roundOf(o, 1, T0 + 1_000);
    for (let T = T0; T <= T0 + 45_000; T += STEP) {
      for (const [at, act] of script) if (at === T) { clockOf(o, T); act(); }
      e.hear(T);
      const l = level(o, T);
      if (levels.at(-1)?.[1] !== l) levels.push([T, l]);
    }
    const showEnd = T0 + 20_000 + o.table.SHOW_MS;
    // (In play last on the show's last frame.)
    expect(levels).toEqual([[T0, 0], [T0 + 1_000, 2], [showEnd, 1], [showEnd - STEP + o.robot.COMPUTED_LIVE_LINGER_MS, 0]]);
  });

  /** Page p's level at every frame from `from` to `to`, as [time, level]
   *  at each change. */
  const levelsFor = (p: Page, from: number, to: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let T = from; T <= to; T += STEP) {
      const l = level(p, T);
      if (out.at(-1)?.[1] !== l) out.push([T, l]);
    }
    return out;
  };

  it("a stuck round (its only bettor gone before the close) is in play until a little past the deadline, then quiet 10 seconds, then idle", async () => {
    const o = await watch();
    putAt(o, T0, kit.slip(X, 1, [red(5)]));
    const deadline = T0 + o.table.BET_WINDOW_MS;
    const slack = deadline + o.robot.COMPUTED_CLOSE_SLACK_MS;
    // (Its first frame counts the table: idle until then.)
    expect(levelsFor(o, T0, slack + 20_000)).toEqual([[T0, 0], [T0 + STEP, 2], [slack, 1], [slack - STEP + o.robot.COMPUTED_LIVE_LINGER_MS, 0]]);
    expect(o.table.readComputedRoulette(TABLE, slack + 20_000)).toMatchObject({ phase: 'betting', round: 1, phaseDeadline: deadline });
  });

  it('a page that loads during a show stays idle: the result shown again is no round it saw run', async () => {
    const o = await watch();
    const e0 = ear(o);
    play(o, e0, roundOf(o, 1, T0), T0, T0 + 20_000);
    expect(level(o, T0 + 20_000)).toBe(2);
    const p = await loadPage('P', 2);
    sync(T0 + 21_000, o, p);
    expect(p.table.readComputedRoulette(TABLE, T0 + 21_000)).toMatchObject({ phase: 'settled', round: 1 });
    expect(levelsFor(p, T0 + 21_000, T0 + 21_000 + p.table.SHOW_MS + 1_000)).toEqual([[T0 + 21_000, 0]]);
    // The same after a wake on a page that had seen it run.
    const wake = T0 + 60_000;
    expect(level(o, wake)).toBe(0);
    expect(o.croupier.tablesWakeCount()).toBe(1);
    expect(o.table.readComputedRoulette(TABLE, wake)).toMatchObject({ phase: 'settled', round: 1 });
    expect(levelsFor(o, wake, wake + o.table.SHOW_MS)).toEqual([[wake, 0]]);
  });

  it('a heartbeat (an earlier build, or a lost switch) moves no level, and the table still runs itself', async () => {
    const o = await watch();
    const twin = await watch();
    for (const p of [o, twin]) putAt(p, T0, kit.slip(X, 1, [red(5)]));
    for (let T = T0; T <= T0 + 40_000; T += 1_000) {
      if (T % 3_000 === 0) {
        clockOf(o, T);
        o.casino.writeCroupierBeat(TABLE, T);
      }
      expect(o.robot.tableRunsItself(TABLE, 'roulette')).toBe(true);
      expect(level(o, T)).toBe(level(twin, T));
    }
    // The switch lost under a live incarnation: still the players', at both games.
    clockOf(o, T0 + 41_000);
    o.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    o.casino.writeCroupierBeat(TABLE, T0 + 41_000);
    expect(o.casino.computedSwitchLost(TABLE)).toBe(true);
    expect(o.croupier.isCroupierLive(TABLE)).toBe(true);
    expect(o.robot.tableRunsItself(TABLE, 'roulette')).toBe(true);
    expect(level(o, T0 + 41_000)).toBe(0);
    expect(level(o, T0 + 41_000, 'roulette', TABLE, true)).toBe(2);
    const { pages: [a] } = await crapsPointOn(['A'], [1], T0 + 50_000);
    clockOf(a, T0 + 120_000);
    a.doc.getMap('casino').delete(`cfg:computed:${CRAPS_TABLE}`);
    a.casino.writeCroupierBeat(CRAPS_TABLE, T0 + 120_000);
    expect(a.robot.tableRunsItself(CRAPS_TABLE, 'craps')).toBe(true);
  });

  it('bets riding on a craps table keep it quiet, with nobody there and no window', async () => {
    const { pages, showEnd } = await crapsPointOn(['A', 'B'], [1, 3], T0);
    const [a] = pages;
    const after = showEnd + 20_000;
    const v = a.table.readComputedCraps(CRAPS_TABLE, after)!;
    expect(v).toMatchObject({ phase: 'betting', point: 6, riders: 2 });
    expect(v.phaseDeadline).toBeUndefined();
    // (Its first frame counts the table: idle until then.)
    expect(level(a, after - STEP, 'craps', CRAPS_TABLE)).toBe(0);
    expect(level(a, after, 'craps', CRAPS_TABLE)).toBe(1);
    expect(level(a, after + 60_000, 'craps', CRAPS_TABLE)).toBe(1);
  });

  it('never reads seat records', async () => {
    const o = await watch();
    const twin = await watch();
    clockOf(o, T0);
    o.casino.writeMySeat(TABLE, X.pid, { stand: 1, angle: 0, at: T0 });
    for (let T = T0; T <= T0 + 20_000; T += 1_000) expect(level(o, T)).toBe(level(twin, T));
  });
});

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('what the robot reads changes nothing a table runs on', () => {
  /** Page p's frame at T as World runs it: the duties, then the robot's
   *  level and call at the table (the call taken as said). */
  const worldFrame = (p: Page, T: number, ref: ComputedTableRef): void => {
    frame(T, p, [ref]);
    const t = typeof ref === 'string' ? ref : ref.id;
    const game = typeof ref === 'string' ? 'roulette' : ref.game;
    const now = clockOf(p, T);
    p.robot.computedTableLevel(t, game, false, now);
    const c = p.robot.computedTableCall(t, game, now);
    if (c) p.robot.noteComputedCallSaid(t, c);
  };

  /** A peer's write over table t's switch: another game's name `forged`,
   *  with its session (what the house's switch-on writes). */
  const forge = (b: Page, T: number, t: string, forged: string): void => {
    clockOf(b, T);
    b.doc.transact(() => {
      b.doc.getMap('casino').set(`cfg:computed:${t}`, { v: 1, inc: forged });
      b.doc.getMap('casinoComputed').set(`ses:${t}:${forged}:g`, new Y.Map());
    });
  };

  for (const game of ['craps', 'roulette'] as const) {
    it(`a ${game} table's switch written over with the other game's name and its session, then deleted: the page puts back its own incarnation, never the other game's`, async () => {
      const craps = game === 'craps';
      const t = craps ? CRAPS_TABLE : TABLE;
      const ref: ComputedTableRef = craps ? CRAPS_REF : TABLE;
      const pages = craps ? await openCrapsRoom(['A', 'B'], T0) : await openRoom(['A', 'B'], T0);
      const [a, b] = pages;
      if (craps) {
        standAt(a, 1);
        expect(crapsBet(a, [{ type: 'pass', amount: 10 }], T0)).toBe('ok');
      } else {
        clockOf(a, T0);
        expect(a.table.writeComputedSlip(t, [red(5)], T0)).toBe('ok');
      }
      sync(T0, ...pages);
      const inc = a.casino.computedIncOf(t)!;
      for (let T = T0; T <= T0 + 1_000; T += STEP) worldFrame(a, T, ref);
      // (The duties stand down while the switch names the other game: no
      // per-frame read makes a state for it, the robot's included.)
      const forged = (craps ? 'c' : 'k') + '12'.repeat(12);
      forge(b, T0 + 1_100, t, forged);
      sync(T0 + 1_100, a, b);
      expect(a.robot.tableRunsItself(t, game)).toBe(true);
      for (let T = T0 + 1_200; T <= T0 + 3_000; T += STEP) worldFrame(a, T, ref);
      expect(a.casino.computedIncOf(t)).toBe(forged);
      clockOf(b, T0 + 3_100);
      b.doc.getMap('casino').delete(`cfg:computed:${t}`);
      sync(T0 + 3_100, a, b);
      for (let T = T0 + 3_200; T <= T0 + 5_000; T += STEP) worldFrame(a, T, ref);
      expect(a.casino.computedIncOf(t)).toBe(inc);
      expect(a.casino.isComputedFor(t, game)).toBe(true);
    }, 30_000);
  }

  it('counts nothing while a record waits for its check: no level from what shows, and no call, until it is checked', async () => {
    const o = await watch();
    const heard: [number, number, string | null][] = [];
    const hear = (T: number): void => {
      const now = clockOf(o, T);
      o.croupier.noteTablesRunning(now);
      const l = o.robot.computedTableLevel(TABLE, 'roulette', false, now);
      const c = o.robot.computedTableCall(TABLE, 'roulette', now);
      if (c) o.robot.noteComputedCallSaid(TABLE, c);
      heard.push([T, l, c?.text ?? null]);
    };
    for (let T = T0; T <= T0 + 500; T += STEP) hear(T);
    // X's felt comes and is checked; Y's comes with it and waits for its check.
    putAt(o, T0 + 600, kit.slip(X, 1, [red(5)]));
    o.casino.setComputedVerifyForTests({ budgetMs: 0 });
    putAt(o, T0 + 600, kit.slip(Y_, 1, [red(5)]));
    expect(o.table.readComputedRoulette(TABLE, T0 + 600)).toMatchObject({ phase: 'betting', round: 1, phaseDeadline: T0 + 600 + o.table.BET_WINDOW_MS });
    expect(o.casino.computedSettled(TABLE)).toBe(false);
    for (let T = T0 + 600; T <= T0 + 1_000; T += STEP) hear(T);
    expect(heard.filter(([, l, c]) => l !== 0 || c !== null)).toEqual([]);
    // Checked a moment later: in play, and the window opens.
    o.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(o.casino.computedSettled(TABLE)).toBe(true);
    hear(T0 + 1_100);
    expect(heard.at(-1)).toEqual([T0 + 1_100, 2, '🎲 Place your bets!']);
  });

  it('a wake keeps no level in play from before it while a record waits for its check', async () => {
    const o = await watch();
    const levels: [number, number][] = [];
    const hear = (T: number): void => {
      const now = clockOf(o, T);
      o.croupier.noteTablesRunning(now);
      const l = o.robot.computedTableLevel(TABLE, 'roulette', false, now);
      const c = o.robot.computedTableCall(TABLE, 'roulette', now);
      if (c) o.robot.noteComputedCallSaid(TABLE, c);
      levels.push([T, l]);
    };
    const script = roundOf(o, 1, T0);
    for (let T = T0; T <= T0 + 21_000; T += STEP) {
      for (const [at, act] of script) if (at === T) { clockOf(o, T); act(); }
      hear(T);
    }
    expect(levels.at(-1)).toEqual([T0 + 21_000, 2]);
    // Hidden 30 s; a felt for round 2 comes meanwhile, and its check waits
    // for the frames the tab runs once it is back.
    const wake = T0 + 51_000;
    o.casino.setComputedVerifyForTests({ budgetMs: 0 });
    putAt(o, wake, kit.slip(Z, 2, [red(5)]));
    expect(o.casino.computedSettled(TABLE)).toBe(false);
    const mark = levels.length;
    for (let T = wake; T <= wake + 1_000; T += STEP) hear(T);
    expect(o.croupier.tablesWakeCount()).toBe(1);
    expect(levels.slice(mark).filter(([, l]) => l !== 0)).toEqual([]);
    o.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(o.casino.computedSettled(TABLE)).toBe(true);
  });

  it('a round in play keeps its level while a record that came since waits for its check, and gets no call meanwhile', async () => {
    const o = await watch();
    const heard: [number, number, string | null][] = [];
    const hear = (T: number): void => {
      const now = clockOf(o, T);
      o.croupier.noteTablesRunning(now);
      const l = o.robot.computedTableLevel(TABLE, 'roulette', false, now);
      const c = o.robot.computedTableCall(TABLE, 'roulette', now);
      if (c) o.robot.noteComputedCallSaid(TABLE, c);
      heard.push([T, l, c?.text ?? null]);
    };
    putAt(o, T0, kit.slip(X, 1, [red(5)]));
    for (let T = T0; T <= T0 + 1_000; T += STEP) hear(T);
    expect(heard.at(-1)?.[1]).toBe(2);
    expect(heard.flatMap(([, , c]) => (c ? [c] : []))).toEqual(['🎲 Place your bets!']);
    // Y's felt comes and waits for its check (a catch-up's checks take a few
    // frames): still in play, so no other table takes its robot.
    o.casino.setComputedVerifyForTests({ budgetMs: 0 });
    putAt(o, T0 + 1_100, kit.slip(Y_, 1, [red(5)]));
    expect(o.casino.computedSettled(TABLE)).toBe(false);
    const mark = heard.length;
    for (let T = T0 + 1_100; T <= T0 + 3_000; T += STEP) hear(T);
    expect(heard.slice(mark).filter(([, l, c]) => l !== 2 || c !== null)).toEqual([]);
    o.casino.setComputedVerifyForTests({ now: () => 0 });
    await flush();
    expect(o.casino.computedSettled(TABLE)).toBe(true);
    hear(T0 + 3_100);
    expect(heard.at(-1)).toEqual([T0 + 3_100, 2, null]);
  });
});

/** Part of an update page p's doc holds and can't apply yet (the update it
 *  builds on hasn't come): casinoWhole reads false until `rest` is applied. */
function partOfAnUpdate(p: Page): Uint8Array {
  const other = new Y.Doc();
  const updates: Uint8Array[] = [];
  other.on('update', (u: Uint8Array) => updates.push(u));
  other.getMap('elsewhere').set('a', 1);
  other.getMap('elsewhere').set('b', 2);
  Y.applyUpdate(p.doc, updates[1]);
  return updates[0];
}
