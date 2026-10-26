/**
 * 👂🧮 A page that can't hear the room doesn't forfeit for it
 * (roomHearing.ts, computedTable forfeitDuty and answerDuty), and a page
 * missing a seed asks the room for it before its grace runs out
 * (computedTable askDuty, casinoDoc askRoomForMissing).
 *
 * A forfeit beats a full set of reveals (pr2-verdict.md Q4), so one written
 * by a page whose link stalled right after a close — no seeds, no ticks, its
 * frames still running — rewrites a round every other page showed, as its
 * link comes back. A page hears the room by the ticks every page in it
 * sends (main.ts's onTick tells its tables: noteRoomHeard) and by the
 * updates its doc applies (casinoDoc tells them); a page that went deaf
 * after the close came in, or is deaf now, leaves the forfeit to the others
 * and to the abandon. A page whose hearing nothing wired (these specs'
 * default, offline practice) hears the room always.
 *
 * Pages as in computedDuties.test.ts (computedPageKit): each its own load of
 * the casino modules, synced by hand, every clock explicit. Here a spec
 * tells a page each moment it hears the room (hear), and keeps from it what
 * it shouldn't hear (no sync).
 */

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asForfeit } from './computedFold';
import type { ForfeitRec } from './computedFold';
import {
  byRank, clockOf, deliver, frame, keysIn, loadPage, PAGE_CTX as CTX, PAGE_ROOM, PAGE_TABLE as TABLE, putIn, run, signAs, switchOn,
  sync,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
const kit = new ComputedKit(CTX);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** By page: when its doc asked the room for what it is missing (bindCasinoDoc's resync). */
const asks = new Map<Page, number[]>();

/** Pages for `names`, 1,000 chips each, the table switched on, all synced;
 *  with `hears`, listening to the room as main.ts has them listen. */
async function room(names: string[], opts: { hears?: boolean } = {}): Promise<Page[]> {
  const pages: Page[] = [];
  for (const [i, name] of names.entries()) {
    const mine: number[] = [];
    const p = await loadPage(name, i + 1, { hears: opts.hears, resync: () => mine.push(Date.now()) });
    asks.set(p, mine);
    pages.push(p);
  }
  for (const p of pages) {
    clockOf(p, T0);
    p.casino.buyInChips(p.pid, 1_000);
  }
  switchOn(pages[0]);
  sync(T0, ...pages);
  return pages;
}

function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** Page p hears the room at the spec's time T (a tick: main.ts onTick). */
const hear = (p: Page, T: number): void => p.table.noteRoomHeard(clockOf(p, T));

/** Round 1 closed on `names`' pages, with test players' felts on it too;
 *  with `hears`, every page hearing the room all the while (but from
 *  `deaf[0]` to `deaf[1]` ms after the felts went down, with it). */
async function closed(names: string[], fakes: TestIdentity[] = [], opts: { hears?: boolean; deaf?: [number, number] } = {}) {
  const pages = await room(names, opts);
  for (const p of pages) pinOn(p, ...fakes);
  for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
  const slips = fakes.map((id) => kit.slip(id, 1, [black(7)]));
  if (slips.length) putIn(pages[0], slips.map((s): [string, unknown] => [s.key, s.rec]));
  sync(T0, ...pages);
  let at = T0 + STEP;
  for (; at <= T0 + 70_000; at += STEP) {
    const deaf = opts.deaf && at >= T0 + opts.deaf[0] && at < T0 + opts.deaf[1];
    if (opts.hears && !deaf) for (const p of pages) hear(p, at);
    run(pages, at, at, { step: STEP });
    if (pages.every((p) => keysIn(p, 'c', 1).length > 0)) break;
  }
  sync(at, ...pages);
  return { pages, slips, closedAt: at };
}

function revealFake(p: Page, id: TestIdentity, T: number, r = 1): void {
  vi.setSystemTime(T + p.skew);
  const x = kit.reveal(r, id.pid);
  putIn(p, [[x.key, x.rec]]);
}

const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)!.get(key) as T;
const forfeitsOf = (p: Page, r: number): ForfeitRec[] => keysIn(p, 'f', r).map((k) => asForfeit(recOf(p, k))!);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const stampOf = (p: Page, key: string): number => p.casino.computedSeenAt(TABLE, key)!;
const closeKeyOn = (p: Page, r = 1): string => keysIn(p, 'c', r)[0];

/** This page's place for the forfeit of round r among `pubs`. */
function forfeitPlace(p: Page, r: number, pubs: string[]): number {
  return pubs.map((k) => p.fold.dutyRank('forfeit', CTX, r, k)).sort().indexOf(p.fold.dutyRank('forfeit', CTX, r, p.pub));
}

function expectAt(at: number, due: number): void {
  expect(at).toBeGreaterThanOrEqual(due);
  expect(at).toBeLessThan(due + STEP);
}

describe('hearing the room (roomHearing.ts)', () => {
  it('hears always while nothing wired it; once wired, only from a note on, with no silence over HEARD_GAP_MS since `since`', async () => {
    vi.resetModules();
    const h = await import('./roomHearing');
    expect(h.heardThrough(0, 1_000)).toBe(true);
    h.listenToRoom();
    // Never heard anyone: not hearing.
    expect(h.heardThrough(0, 1_000)).toBe(false);
    h.noteRoomHeard(1_000);
    h.noteRoomHeard(1_200);
    expect(h.heardThrough(1_000, 1_300)).toBe(true);
    // (Hearing began at 1,000: nothing before it was heard.)
    expect(h.heardThrough(999, 1_300)).toBe(false);
    // Silent for 2.1 s: deaf now, and from the next note hearing afresh.
    expect(h.heardThrough(1_000, 1_200 + h.HEARD_GAP_MS)).toBe(true);
    expect(h.heardThrough(1_000, 1_201 + h.HEARD_GAP_MS)).toBe(false);
    h.noteRoomHeard(3_300);
    expect(h.heardThrough(1_000, 3_400)).toBe(false);
    expect(h.heardThrough(3_300, 3_400)).toBe(true);
    // A clock gone back: deaf until a note after the step, and hearing from it.
    expect(h.heardThrough(3_300, 2_000)).toBe(false);
    h.noteRoomHeard(2_100);
    expect(h.heardThrough(2_100, 2_200)).toBe(true);
    expect(h.heardThrough(2_000, 2_200)).toBe(false);
    // A doc bound afresh: deaf until the next note.
    h.forgetRoomHeard();
    expect(h.heardThrough(0, 2_300)).toBe(false);
    h.noteRoomHeard(2_400);
    expect(h.heardThrough(2_400, 2_500)).toBe(true);
  });

  it('a clock gone back stays deaf as it comes round again, with no note between: seen by a look at the hearing, by a read of the clock, or landing inside the gap', async () => {
    vi.resetModules();
    const h = await import('./roomHearing');
    h.listenToRoom();
    for (let t = 1_000; t <= 5_000; t += 50) h.noteRoomHeard(t);
    expect(h.heardThrough(1_000, 5_100)).toBe(true);
    // Back 3 s, the hearing looked at then; the clock round to 5,100 again,
    // no note since: deaf.
    expect(h.heardThrough(1_000, 2_100)).toBe(false);
    expect(h.heardThrough(1_000, 5_100)).toBe(false);
    expect(h.heardThrough(5_100, 5_200)).toBe(false);
    // Hearing from the next note on.
    h.noteRoomHeard(5_300);
    expect(h.heardThrough(5_300, 5_400)).toBe(true);
    expect(h.heardThrough(5_200, 5_400)).toBe(false);
    // Back again, seen only by a frame's read of the clock: deaf as it comes round.
    h.noteClockRead(2_000);
    expect(h.heardThrough(5_300, 5_400)).toBe(false);
    // Deaf since a note at 6,000 (looked at 9,000), the clock back to 7,500:
    // within HEARD_GAP_MS of that note, but after the room went quiet.
    h.noteRoomHeard(6_000);
    expect(h.heardThrough(6_000, 9_000)).toBe(false);
    expect(h.heardThrough(6_000, 7_500)).toBe(false);
    // A read at the same time as the last is no step.
    h.noteRoomHeard(7_600);
    h.noteClockRead(7_600);
    expect(h.heardThrough(7_600, 7_600)).toBe(true);
  });

  it('a note is a read of the clock too: a step a note is the first to see, or one after notes alone, wipes what was heard; one under HEARING_CLOCK_SLACK_MS is none, but a silence under way counts on through it', async () => {
    vi.resetModules();
    const h = await import('./roomHearing');
    h.listenToRoom();
    for (let t = 1_000; t <= 5_000; t += 50) h.noteRoomHeard(t);
    // Back 2 s, a note the first to see it: hearing from that note only.
    h.noteRoomHeard(3_000);
    expect(h.heardThrough(1_000, 3_000)).toBe(false);
    expect(h.heardThrough(3_000, 3_000)).toBe(true);
    for (let t = 3_050; t <= 5_000; t += 50) h.noteRoomHeard(t);
    expect(h.heardThrough(3_000, 6_900)).toBe(true);
    // Back 1.9 s from that look, the next note a second on, at 6,000 (after
    // the last note, within HEARD_GAP_MS of it): the 2.9 s silence was a
    // deaf spell.
    h.noteRoomHeard(6_000);
    expect(h.heardThrough(3_000, 6_100)).toBe(false);
    expect(h.heardThrough(6_000, 6_100)).toBe(true);
    // Notes alone for a minute (a hidden tab, still hearing), then back 30 s
    // and cut off: deaf, and still as the clock comes round.
    for (let t = 6_050; t <= 66_000; t += 50) h.noteRoomHeard(t);
    expect(h.heardThrough(6_000, 36_500)).toBe(false);
    expect(h.heardThrough(6_000, 66_900)).toBe(false);
    // A step back of a few ms between a read and the next tick (a time
    // sync's correction) is none: a minute's hearing stands.
    for (let t = 67_000; t <= 130_000; t += 50) h.noteRoomHeard(t);
    const latest = 130_010;
    h.noteClockRead(latest);
    h.noteRoomHeard(latest - 5);
    expect(h.heardThrough(latest - 60_000, latest)).toBe(true);
    // But a silence under way counts on through such corrections: the last
    // time heard moves back with each. Cut off from here, the clock read
    // every 10 ms and put back to 249 ms behind its last read each time it
    // passes latest + 2,000, for a minute: deaf once 2 s and a few frames
    // have gone, and from then on.
    const SLACK = h.HEARING_CLOCK_SLACK_MS;
    let clock = latest;
    for (let real = 10; real <= 60_000; real += 10) {
      clock += 10;
      if (clock > latest + 2_000) clock -= 10 + SLACK - 1;
      const heard = h.heardThrough(latest - 60_000, clock);
      if (real <= 2_000 - 5) expect(heard).toBe(true);
      if (real >= 2_200) expect(heard).toBe(false);
    }
    // One step, seen at the next read: hearing overstated by that moment only.
    h.noteRoomHeard(200_000);
    expect(h.heardThrough(200_000, 202_000)).toBe(true);
    expect(h.heardThrough(200_000, 202_000 - SLACK + 1)).toBe(true);
    expect(h.heardThrough(200_000, 202_000 + 1)).toBe(false);
    // HEARING_CLOCK_SLACK_MS back is a step.
    h.noteRoomHeard(300_000);
    h.noteClockRead(300_000 - SLACK + 1);
    expect(h.heardThrough(300_000, 300_000)).toBe(true);
    h.noteClockRead(300_000 - SLACK);
    expect(h.heardThrough(300_000, 300_000)).toBe(false);
  });

  it("is told of every frame's read of the clock (computedTable tickComputedTables): a step back seen there, though no duty looks at the hearing", async () => {
    const [a] = await room(['A'], { hears: true });
    // (The page's own load of the module: nothing was loaded since.)
    const h = await import('./roomHearing');
    const T = T0 + 10_000;
    for (let t = T - 3_000; t <= T; t += STEP) hear(a, t);
    expect(h.heardThrough(T - 3_000, clockOf(a, T))).toBe(true);
    // Cut off, a frame with no tables (no duty looks) as the clock goes 5 s
    // back, and the clock round again past the last note: deaf.
    a.skew -= 5_000;
    frame(T + STEP, a, []);
    expect(h.heardThrough(T - 3_000, clockOf(a, T + 5_000 + STEP))).toBe(false);
  });

  it("is told of every update the bound doc applies from the room, not of this page's own writes", async () => {
    const [a] = await room(['A'], { hears: true });
    // (The page's own load of the module: nothing was loaded since.)
    const h = await import('./roomHearing');
    const T = T0 + 10_000;
    clockOf(a, T);
    // Its own write: nothing heard.
    a.casino.writeMySeat(TABLE, a.pid, { stand: 1, angle: 0, at: T });
    expect(h.heardThrough(T, T)).toBe(false);
    // Another page's update.
    const other = new Y.Doc();
    other.clientID = 77;
    const ups: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => { ups.push(u); });
    other.transact(() => other.getMap('casino').set('seat:x', 1));
    deliver(T + 100, a, ups);
    expect(h.heardThrough(T + 100, T + 200)).toBe(true);
    // An update that changes nothing (all of it held already) is no sign of the room.
    deliver(T + 3_000, a, ups);
    expect(h.heardThrough(T + 100, T + 3_000)).toBe(false);
  });
});

describe('the forfeit, on a page that may not hear the room', () => {
  const X = testIdentity('x', 'player-X'); // never reveals

  it('a page hearing the room throughout forfeits as before: at the end of the grace, in its turn', async () => {
    const { pages, slips, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    let wrote = -1;
    for (let T = closedAt + STEP; T <= closeSeen + 25_000 && wrote < 0; T += STEP) {
      hear(a, T);
      frame(T, a);
      if (keysIn(a, 'f', 1).length) wrote = T;
    }
    expectAt(wrote, closeSeen + a.table.REVEAL_GRACE_MS + forfeitPlace(a, 1, [a.pub, ...slips.map((s) => s.rec.k)]) * a.table.STAGGER_MS);
    expect(forfeitsOf(a, 1).map((f) => f.n)).toEqual([[a.pid]]);
  });

  it('a page nothing wired (offline, a spec) forfeits as before, hearing nothing', async () => {
    const { pages, slips, closedAt } = await closed(['A'], [X]);
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    const wrote = run(pages, closedAt + STEP, closeSeen + 25_000, { step: STEP, until: () => keysIn(a, 'f', 1).length > 0 });
    expectAt(wrote, closeSeen + a.table.REVEAL_GRACE_MS + forfeitPlace(a, 1, [a.pub, ...slips.map((s) => s.rec.k)]) * a.table.STAGGER_MS);
  });

  it('a deaf page (nothing heard for over HEARD_GAP_MS) writes none at its due time, nor once it hears again; it forfeits the next close as before', async () => {
    const { pages, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    // It heard the room until a second after the close, then nothing (its
    // link stalled), its frames running.
    for (let T = closedAt + STEP; T <= closeSeen + 20_000; T += STEP) {
      if (T <= closeSeen + 1_000) hear(a, T);
      frame(T, a);
    }
    expect(keysIn(a, 'f', 1)).toEqual([]);
    expect(foldOf(a).tip?.revealed).toEqual([a.pid]);
    // Hearing again: still none for that close, which it was deaf for; the
    // abandon voids it, and no forfeit of the void follows (any forfeit
    // would beat it).
    let T = closeSeen + 20_000;
    for (; T <= closeSeen + 50_000; T += STEP) {
      hear(a, T);
      frame(T, a);
    }
    expect(keysIn(a, 'f', 1)).toEqual([]);
    expect(foldOf(a).rounds[0].decided).toBe('void');
    // The next round, X's felt on it again, A hearing throughout: its
    // forfeit at the end of the grace, in its turn.
    for (; a.table.readComputedRoulette(TABLE, clockOf(a, T))?.phase !== 'betting'; T += STEP) {
      hear(a, T);
      frame(T, a);
    }
    expect(a.table.writeComputedSlip(TABLE, [red(12)], clockOf(a, T))).toBe('ok');
    const xs = kit.slip(X, 2, [black(7)]);
    putIn(a, [[xs.key, xs.rec]]);
    for (; keysIn(a, 'c', 2).length === 0 && T <= closeSeen + 120_000; T += STEP) {
      hear(a, T);
      frame(T, a);
    }
    const closeSeen2 = stampOf(a, closeKeyOn(a, 2));
    let wrote = -1;
    for (; T <= closeSeen2 + 25_000 && wrote < 0; T += STEP) {
      hear(a, T);
      frame(T, a);
      if (keysIn(a, 'f', 2).length) wrote = T;
    }
    expectAt(wrote, closeSeen2 + a.table.REVEAL_GRACE_MS + forfeitPlace(a, 2, [a.pub, xs.rec.k]) * a.table.STAGGER_MS);
    expect(forfeitsOf(a, 2).map((f) => f.n)).toEqual([[a.pid]]);
  });

  it('a page that went deaf after the close came in, and heard again before its due time, writes none for that close', async () => {
    const { pages, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    // Deaf from 0.4 s to 3 s after the close (2.6 s: more than HEARD_GAP_MS).
    for (let T = closedAt + STEP; T <= closeSeen + 25_000; T += STEP) {
      if (T <= closeSeen + 400 || T >= closeSeen + 3_000) hear(a, T);
      frame(T, a);
    }
    expect(keysIn(a, 'f', 1)).toEqual([]);
    expect(foldOf(a).tip?.revealed).toEqual([a.pid]);
  });

  it("a deaf spell that ended less than a lapse before the close came: no forfeit for it (what came in time of it may have come with the room's catch-up)", async () => {
    // Deaf 10-17.5 s into the betting window; the close 18 s in, 0.5 s or so
    // after hearing came back.
    const { pages, closedAt } = await closed(['A'], [X], { hears: true, deaf: [10_000, 17_500] });
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    expect(closeSeen - (T0 + 17_500)).toBeLessThan(a.croupier.TABLE_LEASE_LAPSE_MS);
    for (let T = closedAt + STEP; T <= closeSeen + 25_000; T += STEP) {
      hear(a, T);
      frame(T, a);
    }
    expect(keysIn(a, 'f', 1)).toEqual([]);
    expect(foldOf(a).tip?.revealed).toEqual([a.pid]);
  });

  it('a casino doc bound afresh (the same room joined again) hears nothing until its next note: closes it found came before it', async () => {
    const { pages, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    for (let T = closedAt + STEP; T <= closedAt + 1_000; T += STEP) {
      hear(a, T);
      frame(T, a);
    }
    expect(foldOf(a).tip?.revealed).toEqual([a.pid]);
    // main.ts joining the room again: a fresh doc, the room's state in it.
    const T1 = closedAt + 1_000;
    clockOf(a, T1);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(a.doc));
    a.casino.bindCasinoDoc(doc, PAGE_ROOM);
    // Heard from the next tick on, every tick: the close came (to this
    // binding) before its first note.
    for (let T = T1 + STEP; T <= T1 + 25_000; T += STEP) {
      hear(a, T);
      frame(T, a);
    }
    expect(keysIn(a, 'f', 1)).toEqual([]);
    expect(a.casino.computedFoldOf(TABLE)!.tip?.revealed).toEqual([a.pid]);
  });

  it('answers no forfeit after a deaf spell since the close came, or one that ended less than a lapse before it; hearing throughout, it answers as before', async () => {
    const Z = testIdentity('z', 'player-Z'); // reveals after the dropper's forfeit, inside the grace
    for (const [deaf, before] of [[false, false], [true, false], [false, true]]) {
      // (`before`: every page deaf 10-17.5 s into the betting window, the
      // close 18 s in.)
      const { pages, closedAt } = await closed(['A', 'B'], [X, Z], { hears: true, ...(before ? { deaf: [10_000, 17_500] as [number, number] } : {}) });
      const [better, worse] = byRank(pages, 'forfeit', 1);
      run(pages, closedAt + STEP, closedAt + STEP, { step: STEP });
      const closeSeen = stampOf(better, closeKeyOn(better));
      expect(foldOf(better).tip!.revealed).toEqual([better.pid, worse.pid].sort());
      // Better hears the room, but for 0.4-3 s after the close when `deaf`.
      for (let T = closedAt + 2 * STEP; T < closeSeen + 3_900; T += STEP) {
        for (const p of pages) if (p !== better || !deaf || T <= closeSeen + 400 || T >= closeSeen + 3_000) hear(p, T);
        for (const p of pages) frame(T, p);
      }
      // The worse-ranked page's forfeit, counting itself alone, early.
      const drop = signAs(worse, 'forfeit', { r: 1, x: foldOf(worse).tip!.close, n: [worse.pid] });
      vi.setSystemTime(closeSeen + 3_900);
      putIn(worse, [[worse.fold.forfeitKey(drop)!, drop]]);
      sync(closeSeen + 3_900, ...pages);
      for (const p of pages) revealFake(p, Z, closeSeen + 3_950);
      let answered = -1;
      for (let T = closeSeen + 4_000; T <= closeSeen + 20_000 && answered < 0; T += STEP) {
        sync(T, ...pages);
        for (const p of pages) {
          hear(p, T);
          frame(T, p);
        }
        sync(T, ...pages);
        if (forfeitsOf(better, 1).some((f) => f.k === better.pub)) answered = T;
      }
      if (deaf || before) {
        expect(answered).toBe(-1);
        expect(foldOf(better).rounds[0].counted).toEqual([worse.pid]);
      } else {
        expectAt(answered, closeSeen + 5_450);
        expect(foldOf(better).rounds[0].counted).toEqual([better.pid, worse.pid, Z.pid].sort());
      }
    }
  });
});

describe('the seed of a page back from a sleep', () => {
  /** Round 1 closed on A and B, neither seed out yet; then A frames on alone
   *  for `ms` (B asleep, its doc too), hearing nobody. */
  async function asleep(ms: number) {
    const { pages, closedAt } = await closed(['A', 'B'], [], { hears: true });
    const [a, b] = pages;
    expect(keysIn(b, 'x', 1).filter((k) => k.startsWith(`x:1:${b.pid}:`))).toEqual([]);
    let T = closedAt + STEP;
    for (; T <= closedAt + ms; T += STEP) frame(T, a);
    return { a, b, T, closeSeen: stampOf(b, closeKeyOn(b)) };
  }
  const seedOf = (p: Page): string[] => keysIn(p, 'x', 1).filter((k) => k.startsWith(`x:1:${p.pid}:`));

  it("holds back the seed of a round ABANDON_MS old while it waits out the lapse after its wake: the void it hadn't heard of stands", async () => {
    const { a, b, T: woke } = await asleep(45_000);
    // A heard nobody: no forfeit, the abandon voided it.
    expect(foldOf(a).rounds[0].decided).toBe('void');
    expect(keysIn(a, 'f', 1)).toEqual([]);
    // B's first frames, the void not in yet: no seed.
    let T = woke;
    for (; T < woke + 1_000; T += STEP) frame(T, b);
    expect(seedOf(b)).toEqual([]);
    // The void comes in; past the lapse, the void holds the seed of a close
    // this page didn't watch come in (voidHolds).
    for (; T <= woke + 20_000; T += STEP) {
      sync(T, a, b);
      hear(a, T);
      hear(b, T);
      frame(T, a);
      frame(T, b);
    }
    sync(T, a, b);
    expect(seedOf(b)).toEqual([]);
    expect(foldOf(a).rounds[0].decided).toBe('void');
    expect(foldOf(b).rounds[0].decided).toBe('void');
  });

  it('a seed for a younger close goes in its first frame back hearing the room, before the lapse is over', async () => {
    const { a, b, T: woke, closeSeen } = await asleep(20_000);
    expect(woke - closeSeen).toBeLessThan(a.table.ABANDON_MS - 1_000);
    hear(b, woke);
    frame(woke, b);
    expect(b.croupier.tablesAwake(clockOf(b, woke))).toBe(false);
    expect(seedOf(b)).toHaveLength(1);
    sync(woke, a, b);
    expect(foldOf(a).rounds[0].decided).toBe('reveals');
  });

  it("holds back even a younger close's seed while it hears nobody after its wake (its link not back yet): it would land who knows when", async () => {
    const { a, b, T: woke } = await asleep(22_000);
    // B's link comes back 12 s after its wake: past A's abandon.
    let T = woke;
    for (; T < woke + 12_000; T += STEP) {
      frame(T, a);
      frame(T, b);
    }
    expect(seedOf(b)).toEqual([]);
    expect(foldOf(a).rounds[0].decided).toBe('void');
    // Back: the void comes in with the room, and holds the seed (voidHolds).
    for (; T <= woke + 30_000; T += STEP) {
      sync(T, a, b);
      hear(a, T);
      hear(b, T);
      frame(T, a);
      frame(T, b);
    }
    sync(T, a, b);
    expect(seedOf(b)).toEqual([]);
    expect(foldOf(a).rounds[0].decided).toBe('void');
    expect(foldOf(b).rounds[0].decided).toBe('void');
  });

  it("an older close's seed waits, past the lapse, until it has heard the room for as long again: a link back late brings the void late", async () => {
    const { a, b, T: woke } = await asleep(45_000);
    expect(foldOf(a).rounds[0].decided).toBe('void');
    // The lapse over, B still hears nobody (its link back 10 s after its
    // wake): no seed.
    let T = woke;
    for (; T < woke + 10_000; T += STEP) frame(T, b);
    expect(b.croupier.tablesAwake(clockOf(b, T))).toBe(true);
    expect(seedOf(b)).toEqual([]);
    // Ticks first, the doc's catching up 3 s behind them: still none.
    const back = T;
    for (; T < back + 3_000; T += STEP) {
      hear(b, T);
      frame(T, b);
    }
    expect(seedOf(b)).toEqual([]);
    for (; T <= back + 20_000; T += STEP) {
      sync(T, a, b);
      hear(a, T);
      hear(b, T);
      frame(T, a);
      frame(T, b);
    }
    sync(T, a, b);
    expect(seedOf(b)).toEqual([]);
    expect(foldOf(a).rounds[0].decided).toBe('void');
    expect(foldOf(b).rounds[0].decided).toBe('void');
  });

  it("holds back its seed for a void that came with the close, in the room's catch-up as its link came back: it didn't watch that close come in", async () => {
    // (computedSim's two-page-away found it, SIM_SEED=3000: B asleep before
    // the close, awake hearing nobody past the lapse, then the close, A's
    // seed and A's void all at once, the close stamped after the lapse.)
    const [a, b] = await room(['A', 'B'], { hears: true });
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(20)], T0)).toBe('ok');
    sync(T0, a, b);
    // B asleep a second in, its doc too: A closes, reveals, and hearing
    // nobody, voids it 30 s on.
    for (let T = T0 + STEP; T <= T0 + 1_000; T += STEP) {
      hear(a, T);
      hear(b, T);
      run([a, b], T, T, { step: STEP });
    }
    const voidAt = run([a], T0 + 1_000 + STEP, T0 + 70_000, { step: STEP, until: () => keysIn(a, 'z', 1).length > 0 });
    expect(foldOf(a).rounds[0].decided).toBe('void');
    expect(keysIn(a, 'f', 1)).toEqual([]);
    // B wakes, its link back 10 s later (past the lapse), the room's
    // catch-up with it.
    const woke = voidAt + 1_000;
    let T = woke;
    for (; T < woke + 10_000; T += STEP) frame(T, b);
    expect(keysIn(b, 'c', 1)).toEqual([]);
    for (; T <= woke + 30_000; T += STEP) {
      sync(T, a, b);
      hear(a, T);
      hear(b, T);
      frame(T, a);
      frame(T, b);
    }
    sync(T, a, b);
    expect(stampOf(b, closeKeyOn(b))).toBeGreaterThanOrEqual(woke + b.croupier.TABLE_LEASE_LAPSE_MS);
    expect(keysIn(b, 'x', 1).filter((k) => k.startsWith(`x:1:${b.pid}:`))).toEqual([]);
    expect(foldOf(a).rounds[0].decided).toBe('void');
    expect(foldOf(b).rounds[0].decided).toBe('void');
  });

  it('a round only its own player bets in: back from a sleep, its seed goes at once, hearing nobody (a room of one)', async () => {
    const { pages, closedAt } = await closed(['A'], [], { hears: true });
    const [a] = pages;
    expect(seedOf(a)).toEqual([]);
    const woke = closedAt + 20_000;
    frame(woke, a);
    expect(a.croupier.tablesAwake(clockOf(a, woke))).toBe(false);
    expect(seedOf(a)).toHaveLength(1);
    expect(foldOf(a).rounds[0].decided).toBe('reveals');
  });

  it("a round nobody voided gets the older close's seed once the page has heard the room for the lapse", async () => {
    const { a, b, T: woke } = await asleep(29_500);
    // (A's abandon not yet due: the round still undecided on both.)
    expect(foldOf(a).rounds[0].decided).toBeNull();
    let T = woke;
    let wrote = -1;
    for (; T <= woke + 15_000 && wrote < 0; T += STEP) {
      hear(b, T);
      frame(T, b);
      if (seedOf(b).length) wrote = T;
    }
    expectAt(wrote, woke + b.croupier.TABLE_LEASE_LAPSE_MS);
  });
});

describe('the idle trim, on a page that may not hear the room', () => {
  const X = testIdentity('x', 'player-X'); // reveals in time

  /** Round 1 decided on A by every seed (X's put in a step after the close),
   *  A hearing the room all the while; the time of X's seed, the last record. */
  async function decided() {
    const { pages, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    const last = closedAt + STEP;
    revealFake(a, X, last);
    let T = last;
    for (; T <= closedAt + 10_000 && !foldOf(a).rounds[0]?.decided; T += STEP) {
      hear(a, T);
      frame(T, a);
    }
    expect(foldOf(a).rounds[0].decided).toBe('reveals');
    expect(foldOf(a).base.u).toBe(0);
    return { a, T, last };
  }

  /** The first time A's session reads trimmed to round 1, framing from T to
   *  `to`, hearing the room where `hears` says so; -1 if never. */
  function trimmedAt(a: Page, T: number, to: number, hears: (T: number) => boolean): number {
    for (; T <= to; T += STEP) {
      if (hears(T)) hear(a, T);
      frame(T, a);
      if (foldOf(a).base.u >= 1) return T;
    }
    return -1;
  }

  it('trims a minute idle hearing the room throughout, as before', async () => {
    const { a, T, last } = await decided();
    const at = trimmedAt(a, T, last + 3 * a.table.IDLE_MS, () => true);
    expect(at).toBeGreaterThanOrEqual(last + a.table.IDLE_MS);
    expect(at).toBeLessThan(last + a.table.IDLE_MS + 2 * a.table.STAGGER_MS);
  });

  it("trims nothing on idle while it hears nobody (its link stalled: the quiet is its own, and its checkpoint, the only one, would void every round the room decided meanwhile); once it has heard the room for a minute, it does", async () => {
    const { a, T, last } = await decided();
    // Deaf from a second after the round decided, for four minutes: past
    // IDLE_MS and the fallback's TRIM_FALLBACK_MS both.
    const deafFrom = T + 1_000;
    const back = deafFrom + 4 * 60_000;
    expect(back - last).toBeGreaterThan(a.table.TRIM_FALLBACK_MS);
    expect(trimmedAt(a, T, back - STEP, (t) => t < deafFrom)).toBe(-1);
    // Hearing again: the room's quiet counts from then.
    const at = trimmedAt(a, back, back + 3 * a.table.IDLE_MS, () => true);
    expect(at).toBeGreaterThanOrEqual(back + a.table.IDLE_MS);
    expect(at).toBeLessThan(back + a.table.IDLE_MS + 2 * a.table.STAGGER_MS);
  });

  it('trims nothing on idle as its clock comes round again after going back, cut off since just before the step (what it heard before is no hearing now); once it has heard the room for a minute, it does', async () => {
    const { a, T, last } = await decided();
    // 50 s idle hearing the room (a trim 10 s off, hearing a minute and
    // more), cut off, and a second on its clock goes back 70 s.
    const deafFrom = last + 50_000;
    expect(deafFrom - a.table.IDLE_MS).toBeGreaterThan(T0 + STEP);
    const stepAt = deafFrom + 1_000;
    expect(trimmedAt(a, T, stepAt, (t) => t < deafFrom)).toBe(-1);
    a.skew -= 70_000;
    // Its clock comes round to the last time it heard the room 70 s on, and
    // passes it, the page cut off all the while.
    const back = deafFrom + 4 * 60_000;
    expect(trimmedAt(a, stepAt + STEP, back - STEP, () => false)).toBe(-1);
    // Hearing again: the room's quiet counts from then.
    const at = trimmedAt(a, back, back + 3 * a.table.IDLE_MS, () => true);
    expect(at).toBeGreaterThanOrEqual(back + a.table.IDLE_MS);
    expect(at).toBeLessThan(back + a.table.IDLE_MS + 2 * a.table.STAGGER_MS);
  });

  it('a page nothing wired trims a minute idle as before, hearing nothing', async () => {
    const { pages, closedAt } = await closed(['A'], [X]);
    const [a] = pages;
    const last = closedAt + STEP;
    revealFake(a, X, last);
    const at = trimmedAt(a, last, last + 3 * a.table.IDLE_MS, () => false);
    expect(at).toBeGreaterThanOrEqual(last + a.table.IDLE_MS);
    expect(at).toBeLessThan(last + a.table.IDLE_MS + 2 * a.table.STAGGER_MS);
  });
});

describe('asking the room for a missing seed', () => {
  const X = testIdentity('x', 'player-X'); // never reveals
  const ASK_AT = 4_000 - 1_500;

  it(`asks once per close, ${ASK_AT} ms after it came, with a seed still missing: deaf, its round undecided for 30 s, it asks no more`, async () => {
    const { pages, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    expect(a.table.REVEAL_GRACE_MS - 1_500).toBe(ASK_AT);
    const from = asks.get(a)!.length;
    for (let T = closedAt + STEP; T <= closeSeen + 29_000; T += STEP) frame(T, a);
    expect(foldOf(a).tip).not.toBeNull();
    const mine = asks.get(a)!.slice(from);
    expect(mine).toHaveLength(1);
    expectAt(mine[0], closeSeen + ASK_AT);
  });

  it('asks nothing once every seed is in', async () => {
    const { pages, closedAt } = await closed(['A', 'B']);
    const [a, b] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    const from = asks.get(a)!.length;
    // B's seed 2.3 s after the close, A's at once.
    for (let T = closedAt + STEP; T <= closeSeen + 20_000; T += STEP) {
      if (T >= closeSeen + 2_300) {
        sync(T, a, b);
        frame(T, b);
        sync(T, a, b);
      }
      frame(T, a);
    }
    expect(foldOf(a).rounds[0].decided).toBe('reveals');
    expect(asks.get(a)!.slice(from)).toEqual([]);
  });

  it("shares casinoDoc's rate limit: held by casinoWhole's ask a second after the close, it asks once that lapses", async () => {
    const { pages, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    const from = asks.get(a)!.length;
    // Another page's two updates, the later first: A's doc holds part of one
    // from 1 s after the close (casinoWhole asks), whole again at 1.6 s.
    const other = new Y.Doc();
    other.clientID = 77;
    const ups: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => { ups.push(u); });
    other.transact(() => other.getMap('casino').set('seat:x', 1));
    other.transact(() => other.getMap('casino').set('seat:x', 2));
    for (let T = closedAt + STEP; T <= closeSeen + 12_000; T += STEP) {
      if (T === closeSeen + 1_000) deliver(T, a, [ups[1]]);
      if (T === closeSeen + 1_600) deliver(T, a, [ups[0]]);
      frame(T, a);
    }
    const mine = asks.get(a)!.slice(from);
    expect(mine).toHaveLength(2);
    expectAt(mine[0], closeSeen + 1_000);
    // (Not at 2.5 s: the room was asked 1.5 s before.)
    expectAt(mine[1], closeSeen + 1_000 + 5_000);
  });

  it("is not held back by casinoWhole's ask from before the close came: that one brought none of its seeds", async () => {
    // (A first in turn to close, its key drawn again until so: the close
    // comes at the window's end, not a turn later.)
    let a: Page;
    do [a] = await room(['A'], { hears: true });
    while (a.fold.dutyRank('close', CTX, 1, a.pub) > a.fold.dutyRank('close', CTX, 1, X.pub));
    pinOn(a, X);
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const xs = kit.slip(X, 1, [black(7)]);
    putIn(a, [[xs.key, xs.rec]]);
    const from = asks.get(a)!.length;
    const other = new Y.Doc();
    other.clientID = 77;
    const ups: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => { ups.push(u); });
    other.transact(() => other.getMap('casino').set('seat:x', 1));
    other.transact(() => other.getMap('casino').set('seat:x', 2));
    // A's doc holds part of another page's update in the betting window's
    // last second (casinoWhole asks), whole again a step on; then the close.
    let partialAt = -1;
    let T = T0 + STEP;
    for (; keysIn(a, 'c', 1).length === 0 && T <= T0 + 70_000; T += STEP) {
      const view = a.table.readComputedRoulette(TABLE, clockOf(a, T));
      if (partialAt < 0 && view?.phase === 'betting' && view.phaseDeadline !== undefined && view.phaseDeadline - T <= 1_000) {
        deliver(T, a, [ups[1]]);
        partialAt = T;
      } else if (partialAt >= 0 && T === partialAt + STEP) {
        deliver(T, a, [ups[0]]);
      }
      frame(T, a);
    }
    const closeSeen = stampOf(a, closeKeyOn(a));
    for (; T <= closeSeen + 6_000; T += STEP) frame(T, a);
    const mine = asks.get(a)!.slice(from);
    expect(mine).toHaveLength(2);
    expectAt(mine[0], partialAt);
    // (Before the close, and less than 5 s before the duty's ask.)
    expect(mine[0]).toBeLessThan(closeSeen);
    expect(closeSeen + ASK_AT - mine[0]).toBeLessThan(5_000);
    expectAt(mine[1], closeSeen + ASK_AT);
  });

  it("and casinoWhole's own ask waits out the rate limit after the duty's: one ask serves both", async () => {
    const { pages, closedAt } = await closed(['A'], [X], { hears: true });
    const [a] = pages;
    const closeSeen = stampOf(a, closeKeyOn(a));
    const from = asks.get(a)!.length;
    const other = new Y.Doc();
    other.clientID = 77;
    const ups: Uint8Array[] = [];
    other.on('update', (u: Uint8Array) => { ups.push(u); });
    other.transact(() => other.getMap('casino').set('seat:x', 1));
    other.transact(() => other.getMap('casino').set('seat:x', 2));
    for (let T = closedAt + STEP; T <= closeSeen + 20_000; T += STEP) {
      if (T === closeSeen + 3_000) deliver(T, a, [ups[1]]);
      if (T === closeSeen + 10_000) deliver(T, a, [ups[0]]);
      frame(T, a);
    }
    const mine = asks.get(a)!.slice(from);
    expect(mine).toHaveLength(2);
    expectAt(mine[0], closeSeen + ASK_AT);
    // (The doc held part of an update from 3 s: casinoWhole asks again only
    // once the duty's ask is 5 s old.)
    expectAt(mine[1], closeSeen + ASK_AT + 5_000);
    // (Whole again from 10 s, the round still undecided: the duty asks
    // nothing more for that close.)
    expect(foldOf(a).tip).not.toBeNull();
  });
});

describe('main.ts', () => {
  it('turns the gate on at startup, and tells it of every tick another page sends, on any lane, once its framing is known', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/import \{ listenToRoom, noteRoomHeard \} from "\.\/roomHearing";/);
    // (At the top level, once: not inside a room's join.)
    expect(main).toMatch(/\nlistenToRoom\(\);\n/);
    const start = main.indexOf('networkProvider.onTick((buf) => {');
    expect(start).toBeGreaterThan(-1);
    const body = main.slice(start, main.indexOf('\n  });', start));
    const heard = body.indexOf('noteRoomHeard();');
    expect(heard).toBeGreaterThan(body.indexOf('return; // unknown datagram framing'));
    // (Before the lanes part: an arcade or air-hockey tick is the room heard too.)
    expect(heard).toBeLessThan(body.indexOf('isArcadeTickFlags(tick.flags)'));
    expect(heard).toBeLessThan(body.indexOf('tickKind(tick.flags) !== TICK_KIND_MOVEMENT'));
  });
});
