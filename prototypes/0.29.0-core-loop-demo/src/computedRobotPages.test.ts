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
  clockOf, CRAPS_REF, CRAPS_TABLE, crapsBet, deleteIn, frame, keysIn, loadPage, openCrapsRoom, openRoom, PAGE_CTX as CTX,
  PAGE_TABLE as TABLE, putIn, rigRoll, run, standAt, switchOn, sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit, red, straight, testIdentity } from './computedTestKit';
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
  /** One frame of the page's robot at T: the call it gives, taken as said. */
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
    // (Only the script writes: the robot's frames between its steps don't.)
    for (let T = T0 + 1_100; T <= T0 + 40_000; T += STEP) {
      const due = script.filter(([at]) => at === T);
      for (const [, act] of due) { clockOf(o, T); act(); }
      const before = Y.encodeStateVector(o.doc);
      e.hear(T);
      expect(Y.encodeStateVector(o.doc)).toEqual(before);
    }
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
