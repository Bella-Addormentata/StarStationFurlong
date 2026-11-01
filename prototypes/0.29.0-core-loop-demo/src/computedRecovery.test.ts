/**
 * 🩹 Recovery (PR 6a-1): what a peer deleted or rewound of a computed
 * table, put back by the room's pages (computedTable recoverDuty; casinoDoc
 * heldBase, restoreComputedCheckpoint, reopenComputedSession,
 * giveUpComputed), and the table's cap on players (MAX_TABLE_PIDS).
 *
 * No build deletes a checkpoint or a session with nothing in its place,
 * writes junk over one, or writes an older one back; a modified game can.
 * Each page is its own load of the casino modules (computedPageKit), synced
 * by hand, every clock explicit. The cheat is a page that never runs its
 * tables: its writes are a peer's doc writes, nothing more.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asCheckpoint, canon, nextSid, seedTable } from './computedFold';
import type { Checkpoint } from './computedFold';
import { TAKEN_WAIT_MS } from './casinoDoc';
import {
  loadPage, openRoom, PAGE_CTX as CTX, PAGE_INC as INC, PAGE_TABLE as TABLE, run, send, sync, trimByHand, updatesOf,
  byRank, clockOf, deliver, frame, switchOn,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit, red, testIdentity } from './computedTestKit';
import type { RouletteBet } from './games/roulette';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
const kit = new ComputedKit(CTX);
const SUM = `sum:${TABLE}:${INC}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const viewOf = (p: Page, now: number) => p.table.readComputedRoulette(TABLE, now);
const computedOf = (p: Page) => p.doc.getMap('casinoComputed');
const cpOf = (p: Page): Checkpoint | null => asCheckpoint(computedOf(p).get(SUM));
const sessionsOf = (p: Page): string[] => [...computedOf(p).keys()].filter((k) => k.startsWith(`ses:${TABLE}:${INC}:`)).sort();
const chipsOn = (on: Page, pages: Page[]): number[] => pages.map((q) => on.casino.readChips(q.pid));
const decidedOn = (p: Page, r: number): boolean => foldOf(p).base.u >= r || foldOf(p).rounds.some((v) => v.r === r && v.decided !== null);
const bytesOf = (v: unknown): string => JSON.stringify(v);

function decideRound(pages: Page[], T: number, bets: RouletteBet[][] = pages.map((_, i) => [red(10 + i)])): { r: number; at: number } {
  const r = foldOf(pages[0]).open;
  for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, bets[i], T)).toBe('ok');
  sync(T, ...pages);
  const at = run(pages, T + STEP, T + 60_000, { step: STEP, until: () => pages.every((p) => decidedOn(p, r)) });
  expect(at).toBeLessThanOrEqual(T + 60_000);
  return { r, at };
}

/** Rounds decided and trimmed by hand (a checkpoint signed by `by` at each),
 *  every page on: the time after, and the checkpoints in order. */
function playAndTrim(pages: Page[], T: number, rounds: number): { at: number; cps: Checkpoint[]; values: unknown[] } {
  const cps: Checkpoint[] = [];
  const values: unknown[] = [];
  let at = T;
  for (let i = 0; i < rounds; i++) {
    ({ at } = decideRound(pages, at + STEP));
    trimByHand(pages[0], testIdentity(`trimmer-${i}`));
    sync(at, ...pages);
    cps.push(cpOf(pages[0])!);
    values.push(computedOf(pages[0]).get(SUM));
    at = run(pages, at + STEP, at + 60_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
  }
  return { at, cps, values };
}

/** Every page with a felt on the open round: each one's key takes a turn. */
function feltsDown(pages: Page[], T: number): void {
  for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(5 + i)], T)).toBe('ok');
  sync(T, ...pages);
}

/** The pages in their turn for `duty` on round r, as recoverDuty ranks them. */
function inTurn(pages: Page[], duty: 'restore' | 'open', r: number): Page[] {
  const rank = new Map(pages.map((p) => [p, p.fold.dutyRank(duty, CTX, r, p.pub)]));
  return [...pages].sort((a, b) => (rank.get(a)! < rank.get(b)! ? -1 : 1));
}

/** The first of `pages` in turn for `duty` on round r among the keys the
 *  recovery duty ranks (ComputedRecovery pubs, as page `on` reads them; a
 *  key that is no page's, a checkpoint signer's say, may rank ahead), and
 *  what its turn waits (computedTable turnOf): STAGGER_MS a place, up to
 *  RECOVERY_PLACES, and OUTSIDER_WAIT_MS more for a page whose key isn't
 *  among them. */
function firstInTurn(on: Page, pages: Page[], duty: 'restore' | 'open', r: number): { page: Page; wait: number } {
  const rec = on.casino.computedRecoveries().find((x) => x.t === TABLE && x.inc === INC)!;
  const rank = (k: string): string => on.fold.dutyRank(duty, CTX, r, k);
  const ranked = [...new Set(rec.pubs)].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
  const waits = pages.map((p) => {
    const i = ranked.indexOf(p.pub);
    const idx = i < 0 ? ranked.length : i;
    return Math.min(idx, on.table.RECOVERY_PLACES) * on.table.STAGGER_MS + (idx >= ranked.length ? on.table.OUTSIDER_WAIT_MS : 0);
  });
  const best = Math.min(...waits);
  return { page: pages[waits.indexOf(best)], wait: best };
}

/** The first frame (every STEP from T) at or past T + ms. */
const frameAt = (T: number, ms: number): number => T + Math.ceil(ms / STEP) * STEP;

/** A peer's write on the doc of `cheat` (a page that never runs its tables). */
function cheatWrites(cheat: Page, act: (m: Y.Map<unknown>) => void): void {
  cheat.doc.transact(() => act(computedOf(cheat)));
}

/** Frames of `pages` one at a time (no sync between them in a step), the
 *  cheat's doc synced too; who wrote the checkpoint, and when. */
function watchWrites(pages: Page[], cheat: Page, from: number, to: number, until: () => boolean): { at: number; by: Page[] } {
  const by: Page[] = [];
  for (let T = from; T <= to; T += STEP) {
    sync(T, cheat, ...pages);
    for (const p of pages) {
      const before = computedOf(p).get(SUM);
      const out = updatesOf(p, () => {
        vi.setSystemTime(T + p.skew);
        p.croupier.noteTablesRunning(T + p.skew);
        p.table.tickComputedTables([TABLE], T + p.skew);
      });
      if (out.length > 0 && computedOf(p).get(SUM) !== before) by.push(p);
    }
    sync(T, cheat, ...pages);
    if (until()) return { at: T, by };
  }
  return { at: to + STEP, by };
}

/** A cheat page (recovery off, never framed), synced with `pages`. Its Yjs
 *  client is 99 (`client`): a write of its concurrent with a page's wins. */
async function withCheat(pages: Page[], T: number, client = 99): Promise<Page> {
  const cheat = await loadPage('X', client);
  cheat.casino.setComputedRecoveryForTests(false);
  sync(T, cheat, ...pages);
  return cheat;
}

/** A frame of page p at T: 1 if it wrote the checkpoint while a restore
 *  was in motion on it (an honest trim of the head that stands is none). */
function restoreWrites(p: Page, T: number): number {
  const before = computedOf(p).get(SUM);
  const restoring = p.casino.computedRecoveries().some((x) => x.t === TABLE && x.trigger !== null);
  vi.setSystemTime(T + p.skew);
  p.croupier.noteTablesRunning(T + p.skew);
  p.table.tickComputedTables([TABLE], T + p.skew);
  return restoring && computedOf(p).get(SUM) !== before ? 1 : 0;
}

/** Page p's recovery of the table (casinoDoc computedRecoveries). */
const recoveryOf = (p: Page) => p.casino.computedRecoveries().find((x) => x.t === TABLE && x.inc === INC)!;

/** A forged checkpoint and an empty map for the session it opens, written by
 *  the cheat. */
function forge(cheat: Page, cp: unknown): void {
  cheatWrites(cheat, (m) => {
    m.set(SUM, JSON.parse(JSON.stringify(cp)));
    const key = `ses:${TABLE}:${INC}:${nextSid(CTX, asCheckpoint(cp)!)}`;
    if (!(m.get(key) instanceof Y.Map)) m.set(key, new Y.Map());
  });
}

describe('🩹 a checkpoint deleted, or junk in its place', () => {
  it('is put back at once by the first in turn, byte for byte; every page folds from it meanwhile', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const { at, values } = playAndTrim(pages, T0, 1);
    feltsDown(pages, at + STEP);
    const cheat = await withCheat(pages, at + STEP);
    const chips = chipsOn(pages[0], pages);
    let now = at + STEP;
    let wrote: { page: Page; at: number } | null = null;
    for (const junk of [undefined, { junk: true }]) {
      cheatWrites(cheat, (m) => (junk === undefined ? m.delete(SUM) : m.set(SUM, junk)));
      sync(now + STEP, cheat, ...pages);
      for (const p of pages) {
        expect(p.casino.casinoWhole(TABLE)).toBe(true);
        expect(foldOf(p).base.u).toBe(1);
        expect(chipsOn(p, pages)).toEqual(chips);
      }
      // (At once: no RESTORE_WAIT_MS, only the turn, every page's key in it.)
      const T = now + 2 * STEP;
      const first = firstInTurn(pages[0], pages, 'restore', 1);
      expect(first.page).toBe(inTurn(pages, 'restore', 1)[0]);
      expect(first.wait).toBeLessThan(pages[0].table.OUTSIDER_WAIT_MS);
      const { at: back, by } = watchWrites(pages, cheat, T, T + 40_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[0])));
      // (Junk again: no sooner than JUNK_GAP_MS after that page's last
      // restore.)
      const gap = wrote?.page === first.page ? wrote.at + pages[0].table.JUNK_GAP_MS - T : 0;
      expect(back).toBe(frameAt(T, Math.max(first.wait, gap)));
      expect(by).toEqual([first.page]);
      wrote = { page: first.page, at: back };
      for (const p of pages) {
        expect(canon(computedOf(p).get(SUM))).toBe(canon(values[0]));
        expect(chipsOn(p, pages)).toEqual(chips);
      }
      now = back;
    }
  }, 30_000);

  it('written again every 4 s: each time the head is back within one stagger, and the table plays on', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 1);
    const cheat = await withCheat(pages, at);
    let T = at + STEP;
    let junkAt = T;
    let lastJunk = T;
    const r = foldOf(pages[0]).open;
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T)).toBe('ok');
    sync(T, ...pages);
    const { wait } = firstInTurn(pages[0], pages, 'restore', 1);
    expect(wait).toBeLessThanOrEqual(pages[0].table.STAGGER_MS);
    let junked = 0;
    for (T += STEP; T <= at + 60_000 && !pages.every((p) => decidedOn(p, r)); T += STEP) {
      if (T >= junkAt) {
        cheatWrites(cheat, (m) => m.set(SUM, { junk: T }));
        lastJunk = T;
        junkAt = T + 4_000;
        junked++;
      }
      sync(T, cheat, ...pages);
      for (const p of pages) {
        expect(p.casino.casinoWhole(TABLE)).toBe(true);
        p.croupier.noteTablesRunning(T + p.skew);
        vi.setSystemTime(T + p.skew);
        p.table.tickComputedTables([TABLE], T + p.skew);
      }
      sync(T, cheat, ...pages);
      // Junk from the write until the first in turn's frame, the head after.
      const back = T >= frameAt(lastJunk, wait);
      for (const p of pages) expect(bytesOf(computedOf(p).get(SUM)) === bytesOf(values[0])).toBe(back);
    }
    expect(junked).toBeGreaterThanOrEqual(2);
    // (The round decided through the loop, on the base held all along.)
    for (const p of pages) expect(decidedOn(p, r)).toBe(true);
    expect(chipsOn(pages[0], pages)).toEqual(chipsOn(pages[1], pages));
  }, 30_000);

  it('a page of the build before parks meanwhile, and counts on once it is back', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const old = await loadPage('Old', 3);
    old.casino.setComputedRecoveryForTests(false);
    old.casino.buyInChips(old.pid, 1_000);
    sync(T0, old, ...pages);
    const { at, values } = playAndTrim([...pages, old], T0, 1);
    feltsDown(pages, at + STEP);
    sync(at + STEP, old, ...pages);
    const cheat = await withCheat([...pages, old], at + STEP);
    cheatWrites(cheat, (m) => m.delete(SUM));
    sync(at + 2 * STEP, cheat, old);
    expect(old.casino.casinoWhole(TABLE)).toBe(false);
    const T = at + 3 * STEP;
    watchWrites(pages, cheat, T, T + 10_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[0])));
    sync(T + STEP, cheat, old, ...pages);
    expect(old.casino.casinoWhole(TABLE)).toBe(true);
    expect(chipsOn(old, [...pages, old])).toEqual(chipsOn(pages[0], [...pages, old]));
  }, 30_000);
});

describe('🩹 a checkpoint rewound, or jumped', () => {
  it('a replay of an older one is put back RESTORE_WAIT_MS on, in turn; meanwhile every page counts the replay', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    feltsDown(pages, at + STEP);
    const cheat = await withCheat(pages, at + STEP);
    const chips = chipsOn(pages[0], pages);
    // The first checkpoint written back, its session too (a cheat's replay).
    cheatWrites(cheat, (m) => {
      m.set(SUM, values[0]);
      m.set(`ses:${TABLE}:${INC}:${nextSid(CTX, asCheckpoint(values[0])!)}`, new Y.Map());
    });
    const T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    for (const p of pages) expect(foldOf(p).base.u).toBe(1);
    // (Every page in turn: their felts on the head's session count, though
    // each counts the replay's empty one meanwhile.)
    const first = firstInTurn(pages[0], pages, 'restore', 2);
    expect(first.page).toBe(inTurn(pages, 'restore', 2)[0]);
    expect(first.wait).toBeLessThan(pages[0].table.OUTSIDER_WAIT_MS);
    const { at: back, by } = watchWrites(pages, cheat, T, T + 40_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1])));
    expect(back).toBe(frameAt(T, pages[0].table.RESTORE_WAIT_MS + first.wait));
    expect(by).toEqual([first.page]);
    for (const p of pages) {
      expect(foldOf(p).base.u).toBe(2);
      expect(chipsOn(p, pages)).toEqual(chips);
    }
  }, 30_000);

  it('one more than MAX_SESSION_ROUNDS past the head on its session is put back; one at MAX_SESSION_ROUNDS, or on another session, is not', async () => {
    const forge = (u: number, b: string): Checkpoint => kit.checkpoint(testIdentity('forger'), b, u, 'f'.repeat(32), {});
    for (const [past, onHead, restored] of [[501, true, true], [500, true, false], [501, false, false], [2 ** 48, false, false]] as const) {
      const pages = await openRoom(['A', 'B'], T0);
      const { at, values } = playAndTrim(pages, T0, 1);
      feltsDown(pages, at + STEP);
      const cheat = await withCheat(pages, at + STEP);
      const head = asCheckpoint(values[0])!;
      const P = forge(head.u + past, onHead ? nextSid(CTX, head) : 'a'.repeat(24));
      cheatWrites(cheat, (m) => {
        m.set(SUM, P);
        m.set(`ses:${TABLE}:${INC}:${nextSid(CTX, P)}`, new Y.Map());
      });
      const T = at + 2 * STEP;
      const { by } = watchWrites(pages, cheat, T, T + 40_000, () => false);
      expect(by.length > 0).toBe(restored);
      for (const p of pages) expect(cpOf(p)!.u).toBe(restored ? head.u : P.u);
    }
  }, 60_000);

  it('never over an end, whatever its round', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    const cheat = await withCheat(pages, at);
    const end = kit.checkpoint(testIdentity('forger'), 'g', 1, 'f'.repeat(32), {}, 1);
    cheatWrites(cheat, (m) => m.set(SUM, end));
    const { by } = watchWrites(pages, cheat, at + STEP, at + 40_000, () => false);
    expect(by).toEqual([]);
    for (const p of pages) {
      expect(cpOf(p)!.e).toBe(1);
      expect(p.casino.isComputedTable(TABLE)).toBe(false);
    }
    expect(values).toHaveLength(2);
  }, 30_000);

  it('an honest trim that lands during the wait cancels the restore, and every round it counted stays counted', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    // (Its client below B's: B's trim, concurrent with its replay, wins.)
    const cheat = await withCheat(pages, at, 0);
    // B, hearing no more of A, plays a round alone.
    const { at: decided } = decideRound([b], at + STEP);
    // The replay reaches A alone, which waits its turn...
    cheatWrites(cheat, (m) => m.set(SUM, values[0]));
    send(decided, cheat, a);
    expect(foldOf(a).base.u).toBe(1);
    const waiting = watchWrites([a], cheat, decided + STEP, decided + 2_000, () => false);
    expect(waiting.by).toEqual([]);
    expect(a.casino.computedRecoveries().find((x) => x.t === TABLE)!.trigger).toBe('rewind');
    // ...and before its wait is out B trims, and the trim reaches it.
    trimByHand(b, testIdentity('honest'));
    const honest = computedOf(b).get(SUM);
    expect(asCheckpoint(honest)!.u).toBe(3);
    const T = waiting.at + STEP;
    send(T, b, a);
    send(T, b, cheat);
    expect(bytesOf(computedOf(a).get(SUM))).toBe(bytesOf(honest));
    expect(a.casino.computedRecoveries().find((x) => x.t === TABLE)!.trigger).toBeNull();
    const { by } = watchWrites([a], cheat, T + STEP, T + 40_000, () => false);
    expect(by).toEqual([]);
    sync(T + 40_000, cheat, a, b);
    for (const p of pages) {
      expect(bytesOf(computedOf(p).get(SUM))).toBe(bytesOf(honest));
      expect(decidedOn(p, 3)).toBe(true);
    }
    expect(chipsOn(a, pages)).toEqual(chipsOn(b, pages));
  }, 60_000);

  it('a replay that wins over an honest trim (both written at once) is put back by the trimmer\'s page to the trim', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    // (Its client above B's: its replay, concurrent with B's trim, wins.)
    const cheat = await withCheat(pages, at);
    const { at: decided } = decideRound([b], at + STEP);
    cheatWrites(cheat, (m) => m.set(SUM, values[0]));
    trimByHand(b, testIdentity('honest'));
    const honest = computedOf(b).get(SUM);
    expect(asCheckpoint(honest)!.u).toBe(3);
    sync(decided + STEP, cheat, a, b);
    for (const p of pages) expect(bytesOf(computedOf(p).get(SUM))).toBe(bytesOf(values[0]));
    const T = decided + 2 * STEP;
    const { at: back, by } = watchWrites(pages, cheat, T, T + 60_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(honest)));
    expect(back).toBeLessThanOrEqual(T + 60_000);
    // B puts back its trim, whatever A (whose head is the round before)
    // put back first; no page sees a war.
    expect(by.at(-1)).toBe(b);
    for (const p of pages) {
      expect(p.table.computedContested(TABLE, back)).toBe(false);
      expect(decidedOn(p, 3)).toBe(true);
    }
    expect(chipsOn(a, pages)).toEqual(chipsOn(b, pages));
  }, 90_000);

  it('three pages restoring at once, none hearing the others, write the same bytes', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const { at, values } = playAndTrim(pages, T0, 1);
    const cheat = await withCheat(pages, at);
    cheatWrites(cheat, (m) => m.delete(SUM));
    for (const p of pages) send(at + STEP, cheat, p);
    // Each alone, past every turn (an outsider's included).
    for (let T = at + 2 * STEP; T <= at + 60_000; T += STEP) {
      for (const p of pages) {
        vi.setSystemTime(T);
        p.croupier.noteTablesRunning(T);
        p.table.tickComputedTables([TABLE], T);
      }
    }
    const written = pages.map((p) => bytesOf(computedOf(p).get(SUM)));
    expect(new Set(written)).toEqual(new Set([bytesOf(values[0])]));
    const docs = pages.map((p) => Y.encodeStateAsUpdate(p.doc));
    expect(docs.length).toBe(3);
  }, 30_000);
});

describe('👂 a session deleted while the page hears nobody', () => {
  it('is neither opened again nor given up on while the room is unheard, and opens OPEN_WAIT_MS after the page hears it again', async () => {
    const pages: Page[] = [];
    for (const [i, name] of ['A', 'B'].entries()) pages.push(await loadPage(name, i + 1, { hears: true }));
    for (const p of pages) {
      clockOf(p, T0);
      p.casino.buyInChips(p.pid, 1_000);
    }
    switchOn(pages[0], TABLE, INC);
    sync(T0, ...pages);
    const [a] = pages;
    feltsDown(pages, T0 + STEP);
    const sid = foldOf(a).base.sid;
    const cheat = await withCheat(pages, T0 + STEP);
    cheatWrites(cheat, (m) => m.delete(`ses:${TABLE}:${INC}:${sid}`));
    let T = T0 + 2 * STEP;
    sync(T, cheat, a);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // Nobody heard (no tick, no update): past OPEN_WAIT_MS and GIVE_UP_MS.
    const deafTo = T + a.table.GIVE_UP_MS + 10_000;
    for (T += STEP; T <= deafTo; T += STEP) {
      run([a], T, T, { step: STEP });
      expect(sessionsOf(a)).toEqual([]);
      expect(a.casino.casinoWhole(TABLE)).toBe(false);
    }
    // The room heard again, every frame: open OPEN_WAIT_MS on, in turn.
    const heardAt = T;
    const { wait } = firstInTurn(a, [a], 'open', 0);
    let back = 0;
    for (; T <= heardAt + 60_000 && back === 0; T += STEP) {
      a.table.noteRoomHeard(clockOf(a, T));
      run([a], T, T, { step: STEP });
      if (sessionsOf(a).includes(`ses:${TABLE}:${INC}:${sid}`)) back = T;
    }
    expect(back).toBeGreaterThanOrEqual(heardAt + a.table.OPEN_WAIT_MS);
    expect(back).toBeLessThanOrEqual(frameAt(heardAt, a.table.OPEN_WAIT_MS + wait) + STEP);
  }, 60_000);
});

describe('🩹 a restore on a doc holding part of an update', () => {
  it('waits while it does, and RESTORE_WAIT_MS again once the doc is whole', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const cheat = await withCheat(pages, at);
    // A replay of the older checkpoint: a rewind of the head.
    cheatWrites(cheat, (m) => m.set(SUM, JSON.parse(JSON.stringify(values[0]))));
    sync(at + STEP, cheat, a, b);
    expect(a.casino.computedRecoveries().find((x) => x.t === TABLE && x.inc === INC)!.trigger).toBe('rewind');
    // Part of an update B sends, the rest held back from A.
    const [, later] = updatesOf(b, () => {
      b.doc.getMap('casino').set('note', 1);
      b.doc.getMap('casino').set('note', 2);
    });
    deliver(at + 2 * STEP, a, [later]);
    let T = at + 3 * STEP;
    for (; T < at + 3 * STEP + 2 * a.table.RESTORE_WAIT_MS; T += STEP) {
      run([a], T, T, { step: STEP });
      expect(canon(computedOf(a).get(SUM))).toBe(canon(values[0]));
    }
    // Whole again: the wait starts afresh.
    sync(T, a, b);
    expect(a.casino.casinoWhole(TABLE)).toBe(true);
    const whole = T;
    let back = 0;
    for (T += STEP; T <= whole + 60_000 && back === 0; T += STEP) {
      run([a], T, T, { step: STEP });
      if (canon(computedOf(a).get(SUM)) === canon(values[1])) back = T;
    }
    expect(back).toBeGreaterThanOrEqual(whole + a.table.RESTORE_WAIT_MS);
  }, 60_000);

  it('a page asleep through the wait waits RESTORE_WAIT_MS again once it is awake again', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const cheat = await withCheat(pages, at);
    cheatWrites(cheat, (m) => m.set(SUM, JSON.parse(JSON.stringify(values[0]))));
    sync(at + STEP, cheat, a, b);
    let T = at + 2 * STEP;
    for (; T < at + 2 * STEP + 2_000; T += STEP) run([a], T, T, { step: STEP });
    // Asleep (no frame) past the wait, then frames again.
    const woke = T + 30_000;
    let back = 0;
    for (T = woke; T <= woke + 60_000 && back === 0; T += STEP) {
      run([a], T, T, { step: STEP });
      if (canon(computedOf(a).get(SUM)) === canon(values[1])) back = T;
    }
    // (Awake once it has waited out a lapse: then the whole wait.)
    expect(back).toBeGreaterThanOrEqual(woke + a.croupier.TABLE_LEASE_LAPSE_MS + a.table.RESTORE_WAIT_MS);
  }, 60_000);
});

describe('🩹 a restore itself', () => {
  it('puts the head and the session it opens back in one write, and writes nothing unless the doc calls for it, the head is the head, and the doc is whole', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const cheat = await withCheat(pages, at);
    const head = (): object => a.casino.computedRecoveries().find((x) => x.t === TABLE && x.inc === INC)!.head!;
    const live = sessionsOf(a);
    expect(live).toHaveLength(1);
    expect(head()).toBe(computedOf(a).get(SUM));
    // The doc holds the head: nothing calls for a restore.
    expect(updatesOf(a, () => expect(a.casino.restoreComputedCheckpoint(TABLE, INC, head())).toBe(false))).toEqual([]);
    // Junk in its place, the session gone too.
    cheatWrites(cheat, (m) => {
      m.set(SUM, { junk: 1 });
      m.delete(live[0]);
    });
    sync(at + STEP, cheat, a, b);
    expect(sessionsOf(a)).toEqual([]);
    // An older checkpoint the page counted is no head of its.
    expect(updatesOf(a, () => expect(a.casino.restoreComputedCheckpoint(TABLE, INC, values[0] as object)).toBe(false))).toEqual([]);
    // Part of an update B sends, the rest held back: nothing.
    const [, later] = updatesOf(b, () => {
      b.doc.getMap('casino').set('note', 1);
      b.doc.getMap('casino').set('note', 2);
    });
    deliver(at + 2 * STEP, a, [later]);
    expect(a.casino.casinoWhole()).toBe(false);
    expect(updatesOf(a, () => expect(a.casino.restoreComputedCheckpoint(TABLE, INC, head())).toBe(false))).toEqual([]);
    // Whole again: one write, the head byte for byte and its session open.
    sync(at + 3 * STEP, a, b);
    expect(a.casino.casinoWhole()).toBe(true);
    const out = updatesOf(a, () => expect(a.casino.restoreComputedCheckpoint(TABLE, INC, head())).toBe(true));
    expect(out).toHaveLength(1);
    expect(bytesOf(computedOf(a).get(SUM))).toBe(bytesOf(values[1]));
    expect(sessionsOf(a)).toEqual(live);
  }, 30_000);
});

describe('🩹 a reopen itself', () => {
  it('opens one empty map for the session the page counts from, only when it is missing and no restore waits', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at } = playAndTrim(pages, T0, 1);
    const cheat = await withCheat(pages, at);
    const live = sessionsOf(a);
    expect(live).toHaveLength(1);
    const before = computedOf(a).get(live[0]);
    // There: nothing.
    expect(updatesOf(a, () => expect(a.casino.reopenComputedSession(TABLE, INC)).toBe(false))).toEqual([]);
    expect(computedOf(a).get(live[0])).toBe(before);
    // Gone, junk over the checkpoint too: a restore waits, and opens it.
    cheatWrites(cheat, (m) => {
      m.delete(live[0]);
      m.set(SUM, { junk: 1 });
    });
    sync(at + STEP, cheat, a, b);
    expect(sessionsOf(a)).toEqual([]);
    expect(updatesOf(a, () => expect(a.casino.reopenComputedSession(TABLE, INC)).toBe(false))).toEqual([]);
    // The checkpoint back (and nothing else): one empty map.
    const head = a.casino.computedRecoveries().find((x) => x.t === TABLE && x.inc === INC)!.head!;
    cheatWrites(cheat, (m) => m.set(SUM, JSON.parse(JSON.stringify(head))));
    sync(at + 2 * STEP, cheat, a, b);
    expect(sessionsOf(a)).toEqual([]);
    const out = updatesOf(a, () => expect(a.casino.reopenComputedSession(TABLE, INC)).toBe(true));
    expect(out).toHaveLength(1);
    expect(sessionsOf(a)).toEqual(live);
    expect(computedOf(a).get(live[0])).toBeInstanceOf(Y.Map);
    // Gone again, the table switched off since: an ended one opens nothing.
    sync(at + 3 * STEP, cheat, a, b);
    b.doc.transact(() => {
      b.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
      b.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    cheatWrites(cheat, (m) => m.delete(live[0]));
    sync(at + 4 * STEP, cheat, a, b);
    expect(sessionsOf(a)).toEqual([]);
    expect(updatesOf(a, () => expect(a.casino.reopenComputedSession(TABLE, INC)).toBe(false))).toEqual([]);
  }, 30_000);

  it('opens nothing for an end, even with the switch written back on to name it', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at } = playAndTrim(pages, T0, 1);
    expect(a.table.switchComputedOff(TABLE, at + STEP)).toBe('ok');
    sync(at + STEP, ...pages);
    expect(asCheckpoint(computedOf(a).get(SUM))!.e).toBe(1);
    expect(sessionsOf(a)).toEqual([]);
    // A peer writes the switch back as it was, the end's gone mark taken away.
    const cheat = await withCheat(pages, at + 2 * STEP);
    cheat.doc.transact(() => {
      cheat.doc.getMap('casino').delete(`gone:${TABLE}:${INC}`);
      cheat.doc.getMap('casino').set(`cfg:computed:${TABLE}`, { v: 1, inc: INC });
    });
    sync(at + 3 * STEP, cheat, a, b);
    expect(a.doc.getMap('casino').has(`gone:${TABLE}:${INC}`)).toBe(false);
    expect(updatesOf(a, () => expect(a.casino.reopenComputedSession(TABLE, INC)).toBe(false))).toEqual([]);
    expect(sessionsOf(a)).toEqual([]);
  }, 30_000);
});

describe('🚩 a checkpoint written over again and again', () => {
  it('a page that took a jump as its head drops it once the head it jumped over is back: one restore, and the pages agree', async () => {
    const pages = await openRoom(['A'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 1);
    feltsDown([a], at + STEP);
    const head = asCheckpoint(values[0])!;
    // A jump of A's head, which a page that never counted the head takes.
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, head), head.u + 501, 'f'.repeat(32), {});
    const cheat = await withCheat(pages, at + STEP);
    const fresh = await loadPage('N', 7);
    forge(cheat, J);
    // N joins on the cheat's doc alone, counts the jump as its head, and
    // puts a felt down on it (both pages players: in turn).
    send(at + 2 * STEP, cheat, fresh);
    expect(foldOf(fresh).base.u).toBe(J.u);
    expect(bytesOf(recoveryOf(fresh).head)).toBe(bytesOf(J));
    fresh.casino.buyInChips(fresh.pid, 1_000);
    expect(fresh.table.writeComputedSlip(TABLE, [red(7)], at + 2 * STEP)).toBe('ok');
    let writes = 0;
    const end = at + 3 * STEP + 120_000;
    for (let T = at + 3 * STEP; T <= end; T += STEP) {
      sync(T, cheat, a, fresh);
      for (const p of [a, fresh]) writes += restoreWrites(p, T);
      sync(T, cheat, a, fresh);
    }
    // A put its head back once; N dropped the jump for it, and wrote nothing.
    // (The table played on from the head since: both pages count the same
    // checkpoint, on the head's line.)
    expect(writes).toBe(1);
    const now = cpOf(a)!;
    expect(now.u).toBeGreaterThanOrEqual(head.u);
    expect(now.u).toBeLessThan(J.u);
    for (const p of [a, fresh]) {
      expect(bytesOf(computedOf(p).get(SUM)), p.name).toBe(bytesOf(computedOf(a).get(SUM)));
      expect(recoveryOf(p).trigger, p.name).toBeNull();
      expect(bytesOf(recoveryOf(p).head), p.name).toBe(bytesOf(computedOf(a).get(SUM)));
      expect(p.table.computedContested(TABLE, end), p.name).toBe(false);
      expect(chipsOn(p, [a, fresh]), p.name).toEqual(chipsOn(a, [a, fresh]));
    }
    // The jump written again: N refutes it now as A does, and puts its head
    // back (the checkpoint the table played on to).
    const headNow = bytesOf(computedOf(fresh).get(SUM));
    forge(cheat, J);
    sync(end + STEP, cheat, fresh);
    expect(recoveryOf(fresh).trigger).toBe('jump');
    const back = run([fresh], end + STEP, end + 60_000, { step: STEP, until: () => bytesOf(computedOf(fresh).get(SUM)) === headNow });
    expect(back).toBeLessThanOrEqual(end + 60_000);
  }, 90_000);

  it('taken onto a firm head — a jump a late page cannot classify — gives way when the head it jumped over is restored, not fought forever', async () => {
    // The convergence hole an adversarial review of this PR found: a page that
    // joined after a trim counts only the post-trim head, so it never counted
    // the checkpoint the trim built on. A forged jump over THAT older
    // checkpoint it cannot classify (recoveryTrigger lets it through), and it
    // used to take the jump with the head's already-elapsed firmAt — firm at
    // once — so when a page that DID count the older one restored the head, the
    // late page would not give way and the two restored their heads over each
    // other without end. It must instead take the jump as a fresh load-time
    // take and give way to the honest head coming back.
    const pages = await openRoom(['A'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    feltsDown([a], at + STEP);
    const older = asCheckpoint(values[0])!; // opens the session the head and the jump both build on
    const head = asCheckpoint(values[1])!; // the honest head; the late page counts only this
    // A late page joins on the honest doc, counts the head (never the older
    // checkpoint), and lets the head go firm (> TAKEN_WAIT_MS since it took it).
    const fresh = await loadPage('N', 7);
    send(at + 2 * STEP, a, fresh);
    expect(bytesOf(recoveryOf(fresh).head)).toBe(bytesOf(values[1]));
    expect(foldOf(fresh).base.u).toBe(head.u);
    const firm = at + 2 * STEP + TAKEN_WAIT_MS + STEP;
    // A jump over the older checkpoint, carrying forged nets. The late page
    // cannot classify it (jumpsOver needs a counted checkpoint on the jumped
    // session, which it hasn't); A, which counted the older one, refutes it.
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, older), older.u + 501, 'f'.repeat(32), { [a.pid]: 1_000_000n });
    const cheat = await withCheat(pages, firm);
    forge(cheat, J);
    const end = firm + 120_000;
    for (let T = firm + STEP; T <= end; T += STEP) {
      sync(T, cheat, a, fresh);
      for (const p of [a, fresh]) restoreWrites(p, T);
      sync(T, cheat, a, fresh);
    }
    // The late page gave way: the pages agree on the head's line, no recovery
    // is in motion, nothing flags a contest, and the late page's chips match
    // A's — the forged million never stuck.
    const now = cpOf(a)!;
    expect(now.u).toBeGreaterThanOrEqual(head.u);
    expect(now.u).toBeLessThan(J.u);
    for (const p of [a, fresh]) {
      expect(bytesOf(computedOf(p).get(SUM)), p.name).toBe(bytesOf(computedOf(a).get(SUM)));
      expect(recoveryOf(p).trigger, p.name).toBeNull();
      expect(p.table.computedContested(TABLE, end), p.name).toBe(false);
      expect(chipsOn(p, [a, fresh]), p.name).toEqual(chipsOn(a, [a, fresh]));
    }
  }, 150_000);

  it('a cheat writing a rewind over every restore: the head goes back every time, the card says so from CONTESTED_COUNT in a row, and stops saying so CONTESTED_CALM_MS after the last', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    feltsDown(pages, at + STEP);
    const cheat = await withCheat(pages, at + STEP);
    forge(cheat, values[0]);
    const holdsHead = (p: Page): boolean => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1]);
    const flagged = (T: number): boolean => pages.some((p) => p.table.computedContested(TABLE, T));
    let restores = 0;
    let flaggedAfter = -1;
    let headSince = -1;
    let T = at + 2 * STEP;
    const stop = T + 120_000;
    let lastWrite = T;
    for (; T <= stop; T += STEP) {
      sync(T, cheat, ...pages);
      for (const p of pages) restores += restoreWrites(p, T);
      sync(T, cheat, ...pages);
      if (flaggedAfter < 0 && flagged(T)) flaggedAfter = restores;
      // The cheat writes its replay again a second after the head is back.
      if (!holdsHead(cheat)) headSince = -1;
      else if (headSince < 0) headSince = T;
      else if (T - headSince >= 1_000) {
        forge(cheat, values[0]);
        lastWrite = T;
        headSince = -1;
      }
    }
    expect(restores).toBeGreaterThanOrEqual(10);
    // (Flagged once a page's restores were written over CONTESTED_COUNT times
    // in a row: as many restores at least.)
    expect(flaggedAfter).toBeGreaterThanOrEqual(pages[0].table.CONTESTED_COUNT);
    // The cheat stops: the head goes back once more and stands, and the flag
    // goes CONTESTED_CALM_MS after the last write over a restore.
    const calm = pages[0].table.CONTESTED_CALM_MS;
    let more = 0;
    for (; T <= lastWrite + calm + 10_000; T += STEP) {
      sync(T, cheat, ...pages);
      for (const p of pages) more += restoreWrites(p, T);
      sync(T, cheat, ...pages);
      if (T <= lastWrite + calm - 5_000) expect(flagged(T)).toBe(true);
    }
    expect(more).toBeLessThanOrEqual(1);
    expect(flagged(T)).toBe(false);
    // (The table plays on from the head: the pages agree, on its line.)
    expect(cpOf(pages[0])!.u).toBeGreaterThanOrEqual(asCheckpoint(values[1])!.u);
    for (const p of [cheat, ...pages]) expect(bytesOf(computedOf(p).get(SUM)), p.name).toBe(bytesOf(computedOf(pages[0]).get(SUM)));
    for (const p of pages) {
      expect(recoveryOf(p).trigger, p.name).toBeNull();
      expect(chipsOn(p, pages), p.name).toEqual(chipsOn(pages[0], pages));
    }
  }, 120_000);

  it('writes over a restore further apart than CONTESTED_CALM_MS raise no flag', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    feltsDown(pages, at + STEP);
    const cheat = await withCheat(pages, at + STEP);
    const SLOW = 1_000;
    let T = at + 2 * STEP;
    const restored: number[] = [];
    for (let i = 0; i < 4; i++) {
      forge(cheat, values[0]);
      const from = T;
      let restores = 0;
      for (; T <= from + pages[0].table.CONTESTED_CALM_MS + 15_000; T += SLOW) {
        sync(T, cheat, ...pages);
        for (const p of pages) restores += restoreWrites(p, T);
        sync(T, cheat, ...pages);
        for (const p of pages) expect(p.table.computedContested(TABLE, T), `${p.name} at ${T - at}`).toBe(false);
      }
      restored.push(restores);
      for (const p of pages) expect(recoveryOf(p).trigger, p.name).toBeNull();
    }
    // The head back each time (by both pages in one frame at most: frames a
    // second apart, their turns STAGGER_MS).
    for (const n of restored) expect([1, 2]).toContain(n);
  }, 120_000);

  it('a checkpoint built on a refuted jump\'s session is put back over too, and so is one built on that', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 1);
    feltsDown(pages, at + STEP);
    const chips = chipsOn(pages[0], pages);
    const cheat = await withCheat(pages, at + STEP);
    const head = asCheckpoint(values[0])!;
    const nets = { [pages[0].pid]: 1_000_000n };
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, head), head.u + 501, 'f'.repeat(32), nets);
    forge(cheat, J);
    let T = at + 2 * STEP;
    const holdsHead = (): boolean => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[0]));
    ({ at: T } = watchWrites(pages, cheat, T, T + 40_000, holdsHead));
    expect(holdsHead()).toBe(true);
    // A trim of the jump's session (as a page that counted it writes one: an
    // earlier build's, or one that came while the jump stood), then one of
    // that trim's: each past the head, on no session of a checkpoint the
    // pages counted.
    let built: Checkpoint = J;
    for (const by of ['earlier-build', 'its-trimmer']) {
      const next = kit.checkpoint(testIdentity(by), nextSid(CTX, built), built.u + 1, 'e'.repeat(32), nets);
      forge(cheat, next);
      T += STEP;
      sync(T, cheat, ...pages);
      for (const p of pages) expect(recoveryOf(p).trigger, p.name).toBe('jump');
      const { at: back } = watchWrites(pages, cheat, T, T + 40_000, holdsHead);
      expect(back).toBeLessThanOrEqual(T + 40_000);
      expect(back).toBeGreaterThanOrEqual(T + pages[0].table.RESTORE_WAIT_MS);
      T = back;
      built = next;
    }
    for (const p of pages) expect(chipsOn(p, pages), p.name).toEqual(chips);
  }, 60_000);

  it('a jump over an older checkpoint the page counted is put back, the head having moved on since', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    feltsDown(pages, at + STEP);
    const chips = chipsOn(pages[0], pages);
    const cheat = await withCheat(pages, at + STEP);
    const older = asCheckpoint(values[0])!;
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, older), older.u + 501, 'f'.repeat(32), {});
    forge(cheat, J);
    const T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    for (const p of pages) expect(recoveryOf(p).trigger, p.name).toBe('jump');
    const { at: back } = watchWrites(pages, cheat, T, T + 40_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1])));
    expect(back).toBeLessThanOrEqual(T + 40_000);
    for (const p of pages) expect(chipsOn(p, pages), p.name).toEqual(chips);
  }, 60_000);
});

describe('🩹 what the pages wrote before a rewind', () => {
  it('stays theirs to put back: the head restored, then its session deleted, the round comes back as it was', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    const { r, at: decided } = decideRound(pages, at + STEP);
    // (Its result shown everywhere: the witnesses hold their copies.)
    const shown = run(pages, decided + STEP, decided + 30_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    const sid = foldOf(pages[0]).base.sid;
    const ses = computedOf(pages[0]).get(`ses:${TABLE}:${INC}:${sid}`) as Y.Map<unknown>;
    const kept = new Map([...ses.entries()].filter(([k]) => (/^[csxfz]:/.test(k) && Number(k.split(':')[1]) === r)).map(([k, v]) => [k, bytesOf(v)]));
    expect([...kept.keys()].some((k) => k.startsWith('c:'))).toBe(true);
    const round = foldOf(pages[0]).rounds.find((v) => v.r === r)!;
    const chips = chipsOn(pages[0], pages);
    // The first checkpoint written back, its session too, then put back.
    const cheat = await withCheat(pages, shown + STEP);
    const replaySes = `ses:${TABLE}:${INC}:${nextSid(CTX, asCheckpoint(values[0])!)}`;
    cheatWrites(cheat, (m) => {
      m.set(SUM, values[0]);
      m.set(replaySes, new Y.Map());
    });
    let T = shown + 2 * STEP;
    const { at: back } = watchWrites(pages, cheat, T, T + 40_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1])));
    // (Nothing of the head's session went into the replay's meanwhile.)
    for (const p of pages) expect([...((computedOf(p).get(replaySes) as Y.Map<unknown> | undefined)?.keys() ?? [])]).toEqual([]);
    // Then the head's session deleted, nothing in its place.
    cheatWrites(cheat, (m) => m.delete(`ses:${TABLE}:${INC}:${sid}`));
    T = back + STEP;
    sync(T, cheat, ...pages);
    const live = (p: Page) => computedOf(p).get(`ses:${TABLE}:${INC}:${sid}`) as Y.Map<unknown> | undefined;
    const whole = (p: Page) => [...kept].every(([k, b]) => live(p)?.has(k) === true && bytesOf(live(p)!.get(k)) === b);
    run(pages, T, T + 60_000, { step: STEP, until: () => pages.every(whole) });
    for (const p of pages) {
      expect(whole(p), p.name).toBe(true);
      const v = foldOf(p).rounds.find((x) => x.r === r)!;
      expect([v.close, v.decided], p.name).toEqual([round.close, round.decided]);
      expect(chipsOn(p, pages), p.name).toEqual(chips);
    }
  }, 60_000);
});

describe('🩹 a forged checkpoint standing', () => {
  /** Frames of `pages` every STEP from `from` to `to`, the cheat's doc
   *  synced too and `act` run first at each (a cheat's write, say); when
   *  every page first held `value` as the checkpoint (-1: never). */
  function framesUntilBack(pages: Page[], cheat: Page, from: number, to: number, value: unknown, act: (T: number) => void = () => {}): number {
    let back = -1;
    for (let T = from; T <= to; T += STEP) {
      act(T);
      sync(T, cheat, ...pages);
      for (const p of pages) frame(T, p);
      sync(T, cheat, ...pages);
      if (back < 0 && pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(value))) back = T;
    }
    return back;
  }

  it('waits RESTORE_WAIT_MS from the first forgery: a replay and a jump written in turn every 4 s start nothing afresh', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    feltsDown(pages, at + STEP);
    const chips = chipsOn(pages[0], pages);
    const cheat = await withCheat(pages, at + STEP);
    const head = asCheckpoint(values[1])!;
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, head), head.u + 501, 'f'.repeat(32), {});
    const forged: [unknown, string][] = [
      [values[0], `ses:${TABLE}:${INC}:${nextSid(CTX, asCheckpoint(values[0])!)}`],
      [J, `ses:${TABLE}:${INC}:${nextSid(CTX, J)}`],
    ];
    let n = 0;
    const forge = (): void => cheatWrites(cheat, (m) => {
      const [v, ses] = forged[n++ % 2];
      m.set(SUM, v);
      m.set(ses, new Y.Map());
    });
    forge();
    const T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    for (const p of pages) expect(foldOf(p).base.u).toBe(1);
    const first = firstInTurn(pages[0], pages, 'restore', head.u);
    let done = false;
    let chipsBack: number[][] = [];
    const back = framesUntilBack(pages, cheat, T, T + 40_000, values[1], (t) => {
      if (!done && pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1]))) {
        done = true;
        chipsBack = pages.map((p) => chipsOn(p, pages));
      }
      if (!done && t > T && (t - T) % 4_000 === 0) forge();
    });
    expect(n).toBeGreaterThanOrEqual(2);
    expect(back).toBe(frameAt(T, pages[0].table.RESTORE_WAIT_MS + first.wait));
    // (Each felt on the head's session counted again as it was.)
    expect(chipsBack).toEqual(pages.map(() => chips));
    for (const p of pages) expect(bytesOf(computedOf(p).get(SUM))).toBe(bytesOf(values[1]));
  }, 60_000);

  it('what the pages put down on it meanwhile goes once the head is back, and none of it into the head\'s session', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 2);
    const headSid = foldOf(pages[0]).base.sid;
    const chips = chipsOn(pages[0], pages);
    const cheat = await withCheat(pages, at + STEP);
    const replaySid = nextSid(CTX, asCheckpoint(values[0])!);
    cheatWrites(cheat, (m) => {
      m.set(SUM, values[0]);
      m.set(`ses:${TABLE}:${INC}:${replaySid}`, new Y.Map());
    });
    const T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    // Felts on the replay's round, as on every build.
    feltsDown(pages, T);
    for (const p of pages) {
      expect(foldOf(p).base.sid).toBe(replaySid);
      expect(foldOf(p).felts.size).toBe(pages.length);
    }
    const back = framesUntilBack(pages, cheat, T + STEP, T + 40_000, values[1]);
    expect(back).toBeGreaterThan(0);
    for (const p of pages) {
      expect(foldOf(p).base.sid, p.name).toBe(headSid);
      const live = computedOf(p).get(`ses:${TABLE}:${INC}:${headSid}`) as Y.Map<unknown>;
      expect([...live.keys()].filter((k) => /^[a-z]:\d+:/.test(k)), p.name).toEqual([]);
      expect(chipsOn(p, pages), p.name).toEqual(chips);
    }
  }, 60_000);

  it('a round played on it meanwhile goes too: no copy of it goes into the head\'s session', async () => {
    // A felt down at the head's session, then its page gone. The page left
    // put no felt there, so it takes its turn as an outsider, and waits long
    // enough to see a round on the jump closed.
    const pages = await openRoom(['A', 'L'], T0);
    const [a, last] = pages;
    const { at, values } = playAndTrim(pages, T0, 1);
    feltsDown([a], at + STEP);
    const head = asCheckpoint(values[0])!;
    const { page, wait: turn } = firstInTurn(last, [last], 'restore', head.u);
    expect(page).toBe(last);
    const wait = last.table.RESTORE_WAIT_MS + turn;
    expect(wait).toBeGreaterThan(last.table.BET_WINDOW_MS + 2_000);
    const headSid = foldOf(last).base.sid;
    const cheat = await withCheat([last], at + 2 * STEP);
    const J = kit.checkpoint(testIdentity('forger'), headSid, head.u + 501, 'f'.repeat(32), {});
    const jumpSid = nextSid(CTX, J);
    forge(cheat, J);
    const T = at + 3 * STEP;
    sync(T, cheat, last);
    expect(foldOf(last).base.sid).toBe(jumpSid);
    expect(last.table.writeComputedSlip(TABLE, [red(4)], T)).toBe('ok');
    // Its round on the jump closed before its turn comes.
    let closed = -1;
    const back = framesUntilBack([last], cheat, T, T + wait + 10_000, values[0], (t) => {
      if (closed < 0 && foldOf(last).base.sid === jumpSid && foldOf(last).rounds.some((v) => v.r === J.u + 1)) closed = t;
    });
    expect(closed).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(closed);
    run([last], T + wait + 10_000 + STEP, T + wait + 40_000, { step: STEP });
    const live = computedOf(last).get(`ses:${TABLE}:${INC}:${headSid}`) as Y.Map<unknown>;
    expect(foldOf(last).base.sid).toBe(headSid);
    expect([...live.keys()].filter((k) => /^[a-z]:\d+:/.test(k) && Number(k.split(':')[1]) > head.u + 1)).toEqual([]);
  }, 120_000);

  it('a second forgery over the first: the head back, what the pages saw of its session is theirs to put back, a gone page\'s records too', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const [a, b, c] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const { r, at: decided } = decideRound(pages, at + STEP);
    const shown = run(pages, decided + STEP, decided + 30_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    const sid = foldOf(a).base.sid;
    const ses = computedOf(a).get(`ses:${TABLE}:${INC}:${sid}`) as Y.Map<unknown>;
    const kept = new Map([...ses.entries()].filter(([k]) => (/^[csxfz]:/.test(k) && Number(k.split(':')[1]) === r)).map(([k, v]) => [k, bytesOf(v)]));
    expect([...kept.keys()].filter((k) => k.includes(`:${c.pid}:`)).length).toBeGreaterThan(0);
    const round = foldOf(a).rounds.find((v) => v.r === r)!;
    const chips = chipsOn(a, pages);
    // A replay, then 2 s on a jump of the head, then the head put back.
    const cheat = await withCheat(pages, shown + STEP);
    const J = kit.checkpoint(testIdentity('forger'), sid, asCheckpoint(values[1])!.u + 501, 'f'.repeat(32), {});
    cheatWrites(cheat, (m) => {
      m.set(SUM, values[0]);
      m.set(`ses:${TABLE}:${INC}:${nextSid(CTX, asCheckpoint(values[0])!)}`, new Y.Map());
    });
    let T = shown + 2 * STEP;
    const back = framesUntilBack(pages, cheat, T, T + 40_000, values[1], (t) => {
      if (t === T + 2_000) {
        cheatWrites(cheat, (m) => {
          m.set(SUM, J);
          m.set(`ses:${TABLE}:${INC}:${nextSid(CTX, J)}`, new Y.Map());
        });
      }
    });
    expect(back).toBeGreaterThan(T + 2_000);
    // C gone, then the head's session deleted, nothing in its place: A and
    // B open it again and put back their own, and C's from their copies.
    cheatWrites(cheat, (m) => m.delete(`ses:${TABLE}:${INC}:${sid}`));
    T = T + 40_000 + STEP;
    sync(T, cheat, a, b);
    const live = (p: Page) => computedOf(p).get(`ses:${TABLE}:${INC}:${sid}`) as Y.Map<unknown> | undefined;
    const whole = (p: Page) => [...kept].every(([k, v]) => live(p)?.has(k) === true && bytesOf(live(p)!.get(k)) === v);
    expect(whole(a)).toBe(false);
    run([a, b], T, T + 90_000, { step: STEP, until: () => [a, b].every(whole) });
    for (const p of [a, b]) {
      expect(whole(p), p.name).toBe(true);
      const v = foldOf(p).rounds.find((x) => x.r === r)!;
      expect([v.close, v.decided], p.name).toEqual([round.close, round.decided]);
      expect(chipsOn(p, pages), p.name).toEqual(chips);
    }
  }, 120_000);

  it('an extension of the head written meanwhile ends it: every page counts it, and the card says by how much it differs from the rounds the page saw', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const { r, at: decided } = decideRound(pages, at + STEP);
    const shown = run(pages, decided + STEP, decided + 30_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    for (const p of pages) expect(p.table.computedRoundCheck(TABLE, shown)).toMatchObject({ round: r, checkpointDiff: 0 });
    const round = foldOf(a).rounds.find((v) => v.r === r)!;
    let moved = 0n;
    for (const d of round.deltas.values()) moved += d < 0n ? -d : d;
    expect(moved > 0n).toBe(true);
    // An extension of the head to round r whose nets leave r out.
    const E = kit.checkpoint(testIdentity('forger'), foldOf(a).base.sid, r, round.close, Object.fromEntries(foldOf(a).base.n));
    const cheat = await withCheat(pages, shown + STEP);
    cheatWrites(cheat, (m) => {
      m.set(SUM, values[0]);
      m.set(`ses:${TABLE}:${INC}:${nextSid(CTX, asCheckpoint(values[0])!)}`, new Y.Map());
    });
    const T = shown + 2 * STEP;
    const { by } = watchWrites(pages, cheat, T, T + 2_000, () => false);
    expect(by).toEqual([]);
    for (const p of pages) expect(foldOf(p).base.u).toBe(1);
    cheatWrites(cheat, (m) => {
      m.set(SUM, E);
      m.set(`ses:${TABLE}:${INC}:${nextSid(CTX, E)}`, new Y.Map());
    });
    const after = watchWrites(pages, cheat, T + 2_000 + STEP, T + 40_000, () => false);
    expect(after.by).toEqual([]);
    for (const p of pages) {
      expect(foldOf(p).base.u, p.name).toBe(r);
      expect(p.table.computedRoundCheck(TABLE, T + 40_000), p.name).toMatchObject({ round: r, checkpointDiff: Number(moved) });
    }
  }, 60_000);
});

describe('🩹 a session deleted with nothing in its place', () => {
  it('is opened again OPEN_WAIT_MS on, in turn, and the felts on it are put back', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at } = playAndTrim(pages, T0, 1);
    feltsDown(pages, at + STEP);
    const sid = foldOf(pages[0]).base.sid;
    const felts = pages.map((p) => [...foldOf(p).felts.keys()].sort());
    const cheat = await withCheat(pages, at + STEP);
    cheatWrites(cheat, (m) => m.delete(`ses:${TABLE}:${INC}:${sid}`));
    const T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    for (const p of pages) expect(p.casino.casinoWhole(TABLE)).toBe(false);
    const back = run([cheat, ...pages].slice(1), T, T + 60_000, {
      step: STEP, until: () => pages.every((p) => p.casino.casinoWhole(TABLE) && foldOf(p).felts.size === pages.length),
    });
    expect(back).toBeGreaterThanOrEqual(T + pages[0].table.OPEN_WAIT_MS);
    expect(back).toBeLessThan(T + pages[0].table.OPEN_WAIT_MS + 5_000);
    for (const p of pages) {
      expect(sessionsOf(p)).toEqual([`ses:${TABLE}:${INC}:${sid}`]);
      expect([...foldOf(p).felts.keys()].sort()).toEqual(felts[0]);
    }
  }, 30_000);

  it('a map for another session opens nothing: only the base the page counts from is opened', { timeout: 60_000 }, async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at } = playAndTrim(pages, T0, 1);
    const sid = foldOf(pages[0]).base.sid;
    const cheat = await withCheat(pages, at);
    cheatWrites(cheat, (m) => {
      m.delete(`ses:${TABLE}:${INC}:${sid}`);
      m.set(`ses:${TABLE}:${INC}:${'b'.repeat(24)}`, new Y.Map());
    });
    const T = at + STEP;
    sync(T, cheat, ...pages);
    // (No felt down: every page an outsider, OUTSIDER_WAIT_MS more.)
    const { wait } = firstInTurn(pages[0], pages, 'open', 1);
    let other = false;
    const back = run(pages, T, T + 60_000, {
      step: STEP,
      until: () => {
        other ||= pages.some((p) => foldOf(p).base.sid !== sid);
        return pages.every((p) => sessionsOf(p).includes(`ses:${TABLE}:${INC}:${sid}`));
      },
    });
    expect(other).toBe(false);
    expect(back).toBeGreaterThanOrEqual(T + pages[0].table.OPEN_WAIT_MS + wait);
    expect(back).toBeLessThanOrEqual(frameAt(T, pages[0].table.OPEN_WAIT_MS + wait) + STEP);
    sync(back, cheat, ...pages);
    for (const p of pages) {
      expect(foldOf(p).base.sid).toBe(sid);
      expect(sessionsOf(p)).toContain(`ses:${TABLE}:${INC}:${sid}`);
    }
  });
});

describe('⚠ giving up on a deleted session', () => {
  it('of an ended table, GIVE_UP_MS on: the page counts as a page that never saw it, and compaction ends it', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at: decided } = decideRound(pages, T0 + STEP);
    // The table ended (removed), then its session deleted before compaction.
    const cheat = await withCheat(pages, decided);
    a.doc.transact(() => {
      a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
      a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    cheatWrites(cheat, (m) => m.delete(`ses:${TABLE}:${INC}:g`));
    sync(decided + STEP, cheat, ...pages);
    for (const p of pages) expect(p.casino.casinoWhole(TABLE)).toBe(false);
    const fresh = await loadPage('N', 7);
    sync(decided + STEP, cheat, fresh, ...pages);
    const freshChips = chipsOn(fresh, pages);
    const T = decided + 2 * STEP;
    const back = run(pages, T, T + 120_000, { step: STEP, until: () => pages.every((p) => p.casino.casinoWhole(TABLE)) });
    expect(back).toBeGreaterThanOrEqual(T + a.table.GIVE_UP_MS);
    expect(back).toBeLessThan(T + a.table.GIVE_UP_MS + 1_000);
    for (const p of pages) expect(chipsOn(p, pages)).toEqual(freshChips);
    expect(a.casino.computedGaveUp(TABLE)).toBeNull(); // (no switch names it now)
  }, 30_000);

  it('not while the doc holds part of an update', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at: decided } = decideRound(pages, T0 + STEP);
    const cheat = await withCheat(pages, decided);
    a.doc.transact(() => {
      a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
      a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    cheatWrites(cheat, (m) => m.delete(`ses:${TABLE}:${INC}:g`));
    sync(decided + STEP, cheat, ...pages);
    // Part of an update B sends, the rest held back.
    const [first, later] = updatesOf(b, () => {
      b.doc.getMap('casino').set('note', 1);
      b.doc.getMap('casino').set('note', 2);
    });
    expect(first).toBeDefined();
    deliver(decided + STEP, a, [later]);
    const T = decided + 2 * STEP;
    run([a], T, T + a.table.GIVE_UP_MS + 10_000, { step: STEP });
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    // (Nor when asked outright.)
    expect(a.casino.giveUpComputed(TABLE, INC)).toBe(false);
    // Whole again: still lost (nothing was given up meanwhile), and given up
    // GIVE_UP_MS on.
    const whole = T + a.table.GIVE_UP_MS + 10_000 + STEP;
    deliver(whole, a, [first]);
    expect(a.casino.casinoWhole()).toBe(true);
    expect(a.casino.casinoWhole(TABLE)).toBe(false);
    const back = run([a], whole + STEP, whole + 120_000, { step: STEP, until: () => a.casino.casinoWhole(TABLE) });
    expect(back).toBeGreaterThanOrEqual(whole + a.table.GIVE_UP_MS);
    expect(back).toBeLessThan(whole + a.table.GIVE_UP_MS + 1_000);
  }, 60_000);
});

describe('🪑 a table holding MAX_TABLE_PIDS players', () => {
  it('takes no newcomer: the felt is refused, and no honest close freezes one a modified game wrote', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const [a, b, c] = pages;
    const { at: decided } = decideRound([a, b], T0 + STEP, [[red(10)], [red(11)]]);
    // A checkpoint of MAX_TABLE_PIDS players, A and B among them.
    const crowd: Record<string, bigint> = Object.fromEntries(foldOf(a).nets);
    for (const p of [a, b]) crowd[p.pid] ??= 1n;
    for (let i = 0; Object.keys(crowd).length < a.fold.MAX_TABLE_PIDS; i++) crowd[`ghost-${i}`] = 1n;
    trimByHand(a, testIdentity('trim-cap'), crowd);
    sync(decided, ...pages);
    const open = run(pages, decided + STEP, decided + 60_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    expect(c.table.writeComputedSlip(TABLE, [red(5)], open)).toBe('crowded');
    expect(a.table.writeComputedSlip(TABLE, [red(5)], open)).toBe('ok');
    // C's felt written by a game that keeps no cap (a modified one): it is
    // on the table, and the honest pages' close leaves it out.
    c.casino.setComputedRecoveryForTests(false);
    expect(c.table.writeComputedSlip(TABLE, [red(5)], open)).toBe('ok');
    sync(open, ...pages);
    expect(foldOf(a).felts.has(c.pid)).toBe(true);
    const r = foldOf(a).open;
    // C's own page, its cap on again and alone, never closes the round: its
    // player is the newcomer.
    c.casino.setComputedRecoveryForTests(true);
    const alone = run([c], open + STEP, open + 40_000, { step: STEP });
    sync(alone, ...pages);
    const closes = (p: Page): string[] => [...p.casino.computedSessionForWrite(TABLE)!.keys()].filter((k) => k.startsWith(`c:${r}:`));
    expect(closes(a)).toEqual([]);
    run([a, b], alone + STEP, alone + 60_000, { step: STEP, until: () => [a, b].every((p) => decidedOn(p, r)) });
    for (const p of [a, b]) {
      const round = foldOf(p).rounds.find((v) => v.r === r);
      expect(round?.decided).not.toBeNull();
      expect(Object.keys(round!.frozen)).toContain(a.pid);
      expect(Object.keys(round!.frozen)).not.toContain(c.pid);
    }
  }, 120_000);
});

describe('🩹 nothing makes a forged checkpoint final', () => {
  it('a switch-off is refused while a rewind stands, and goes once the head is back, from the head', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const head = asCheckpoint(values[1])!;
    const sid = foldOf(a).base.sid;
    const cheat = await withCheat(pages, at + STEP);
    forge(cheat, values[0]);
    let T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    expect(recoveryOf(a).trigger).toBe('rewind');
    expect(a.table.switchComputedOff(TABLE, T)).toBe('reconnecting');
    expect(bytesOf(computedOf(a).get(SUM))).toBe(bytesOf(values[0]));
    // (No felt down: every page an outsider.)
    const { at: back } = watchWrites(pages, cheat, T, T + 60_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1])));
    expect(back).toBeLessThanOrEqual(T + 60_000);
    T = back + STEP;
    sync(T, cheat, ...pages);
    expect(a.table.switchComputedOff(TABLE, T)).toBe('ok');
    const end = cpOf(a)!;
    expect([end.e, end.b, end.u]).toEqual([1, sid, head.u]);
    expect(end.n).toEqual(head.n);
  }, 90_000);

  it('a switch-off goes at once while junk stands: from the head the page holds, as junk changes nothing', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const head = asCheckpoint(values[1])!;
    const sid = foldOf(a).base.sid;
    const cheat = await withCheat(pages, at + STEP);
    cheatWrites(cheat, (m) => m.set(SUM, { junk: 1 }));
    const T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    expect(recoveryOf(a).trigger).toBe('junk');
    expect(a.casino.computedRestorePending(TABLE)).toBe(false);
    expect(a.table.switchComputedOff(TABLE, T)).toBe('ok');
    const end = cpOf(a)!;
    expect([end.e, end.b, end.u]).toEqual([1, sid, head.u]);
    expect(end.n).toEqual(head.n);
  }, 90_000);

  it('compaction of an ended table waits while a rewind stands, and ends it from the head', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const head = asCheckpoint(values[1])!;
    const sid = foldOf(a).base.sid;
    const cheat = await withCheat(pages, at + STEP);
    // The table removed, its sessions still in the doc; a rewind written
    // before compaction is due.
    a.doc.transact(() => {
      a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
      a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    forge(cheat, values[0]);
    const from = at + 2 * STEP;
    sync(from, cheat, ...pages);
    for (const p of pages) expect(recoveryOf(p).trigger, p.name).toBe('rewind');
    let restored = -1;
    let ended = -1;
    for (let T = from; T <= from + 120_000 && ended < 0; T += STEP) {
      sync(T, cheat, ...pages);
      for (const p of pages) frame(T, p);
      sync(T, cheat, ...pages);
      if (restored < 0 && pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1]))) restored = T;
      if (pages.some((p) => cpOf(p)?.e === 1)) ended = T;
    }
    // (The restore came later than compaction would have: no felt down,
    // every page an outsider.)
    expect(restored).toBeGreaterThan(from + a.table.COMPACT_MS);
    expect(ended).toBeGreaterThan(restored);
    for (const p of pages) {
      const end = cpOf(p)!;
      expect([end.e, end.b, end.u], p.name).toEqual([1, sid, head.u]);
      expect(end.n, p.name).toEqual(head.n);
    }
  }, 150_000);

  it('a jump to the last safe round shows no broken checkpoint while it is put back; a page that never counted the head shows one until then', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at, values } = playAndTrim(pages, T0, 1);
    const head = asCheckpoint(values[0])!;
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, head), Number.MAX_SAFE_INTEGER, 'f'.repeat(32), {});
    const cheat = await withCheat(pages, at + STEP);
    forge(cheat, J);
    const from = at + 2 * STEP;
    sync(from, cheat, ...pages);
    for (const p of pages) {
      expect(recoveryOf(p).trigger, p.name).toBe('jump');
      expect(p.casino.computedCheckpointBroken(TABLE), p.name).toBe(false);
    }
    // A page loaded now counts the jump as its head: nothing it counted
    // refutes it.
    const fresh = await loadPage('N', 7);
    sync(from, cheat, fresh, ...pages);
    expect(recoveryOf(fresh).trigger).toBeNull();
    expect(fresh.casino.computedCheckpointBroken(TABLE)).toBe(true);
    const all = [...pages, fresh];
    let back = -1;
    for (let T = from; T <= from + 60_000 && back < 0; T += STEP) {
      sync(T, cheat, ...all);
      for (const p of pages) frame(T, p);
      sync(T, cheat, ...all);
      if (all.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[0]))) back = T;
    }
    expect(back).toBeGreaterThan(0);
    for (const p of all) {
      expect(recoveryOf(p).trigger, p.name).toBeNull();
      expect(p.casino.computedCheckpointBroken(TABLE), p.name).toBe(false);
    }
  }, 90_000);

  it('an end rewound is put back with no session for it', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    expect(a.table.switchComputedOff(TABLE, at + STEP)).toBe('ok');
    sync(at + STEP, ...pages);
    const end = computedOf(a).get(SUM);
    expect(asCheckpoint(end)!.e).toBe(1);
    for (const p of pages) expect(sessionsOf(p), p.name).toEqual([]);
    // An older checkpoint written back, and no session with it.
    const cheat = await withCheat(pages, at + 2 * STEP);
    cheatWrites(cheat, (m) => m.set(SUM, JSON.parse(JSON.stringify(values[0]))));
    const T = at + 3 * STEP;
    sync(T, cheat, ...pages);
    for (const p of pages) expect(recoveryOf(p).trigger, p.name).toBe('rewind');
    let opened = false;
    const { at: back } = watchWrites(pages, cheat, T, T + 60_000, () => {
      opened ||= [cheat, ...pages].some((p) => sessionsOf(p).length > 0);
      return pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(end));
    });
    expect(back).toBeLessThanOrEqual(T + 60_000);
    expect(opened).toBe(false);
  }, 90_000);
});

describe('🩹 junk written over and over', () => {
  it('is put back no sooner than JUNK_GAP_MS after the page\'s last restore, and never stops being put back', async () => {
    const pages = await openRoom(['A'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 1);
    // (A felt down: A's key in turn. Its round closes no sooner than
    // BET_WINDOW_MS on, after the junk stops.)
    feltsDown(pages, at + STEP);
    const cheat = await withCheat(pages, at + STEP);
    let restores = 0;
    const from = at + 2 * STEP;
    const SPAN = 10_000;
    let T = from;
    for (; T < from + SPAN; T += STEP) {
      cheatWrites(cheat, (m) => m.set(SUM, { junk: T }));
      sync(T, cheat, a);
      restores += restoreWrites(a, T);
      sync(T, cheat, a);
    }
    expect(restores).toBeGreaterThanOrEqual(5);
    expect(restores).toBeLessThanOrEqual(SPAN / a.table.JUNK_GAP_MS + 1);
    // The cheat stops: the head is back within JUNK_GAP_MS, and stands.
    const back = run([cheat, a].slice(1), T, T + 5_000, { step: STEP, until: () => bytesOf(computedOf(a).get(SUM)) === bytesOf(values[0]) });
    expect(back).toBeLessThanOrEqual(T + a.table.JUNK_GAP_MS + STEP);
    expect(recoveryOf(a).trigger).toBeNull();
  }, 60_000);
});

describe('🩹 what a forged checkpoint leaves', () => {
  it('the seed behind a slip put down on it is kept once the head is back: the same forgery may come back', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const cheat = await withCheat(pages, at + STEP);
    forge(cheat, values[0]);
    const T = at + 2 * STEP;
    sync(T, cheat, ...pages);
    feltsDown(pages, T);
    const slip = foldOf(a).felts.get(a.pid)!;
    expect(slip.rec.r).toBe(asCheckpoint(values[0])!.u + 1);
    const ctx = { room: CTX.room, table: seedTable(CTX), round: slip.rec.r, party: a.pid, house: '' };
    expect(a.fair.seedFor(slip.rec.c, ctx)).not.toBeNull();
    const { at: back } = watchWrites(pages, cheat, T + STEP, T + 60_000, () => pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1])));
    expect(back).toBeLessThanOrEqual(T + 60_000);
    run(pages, back + STEP, back + 2_000, { step: STEP });
    expect(foldOf(a).base.u).toBe(asCheckpoint(values[1])!.u);
    expect(a.fair.seedFor(slip.rec.c, ctx)).not.toBeNull();
  }, 90_000);

  for (const rewind of [true, false]) {
    it(`the head's session deleted ${rewind ? 'under a rewind' : 'alone'}: what the page decided meanwhile stays decided, and no slip goes in twice`, async () => {
      // Round 3 by A alone, an idle spell, round 4 by C alone, both shown.
      const pages = await openRoom(['A', 'B', 'C'], T0);
      const [a, , c] = pages;
      const { at, values } = playAndTrim(pages, T0, 2);
      let T = at + STEP;
      const r3 = foldOf(a).open;
      expect(a.table.writeComputedSlip(TABLE, [red(10)], T)).toBe('ok');
      sync(T, ...pages);
      T = run(pages, T + STEP, T + 60_000, { step: STEP, until: () => pages.every((p) => decidedOn(p, r3)) });
      T = run(pages, T + STEP, T + 30_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
      T = run(pages, T + STEP, T + 36_000, { step: STEP });
      const r4 = foldOf(c).open;
      expect(r4).toBe(r3 + 1);
      expect(c.table.writeComputedSlip(TABLE, [red(11)], T)).toBe('ok');
      sync(T, ...pages);
      T = run(pages, T + STEP, T + 60_000, { step: STEP, until: () => pages.every((p) => decidedOn(p, r4)) });
      T = run(pages, T + STEP, T + 30_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
      for (const p of pages) expect(foldOf(p).base.u, p.name).toBe(2);
      const chips = chipsOn(a, pages);
      const cheat = await withCheat(pages, T);
      const headSid = foldOf(a).base.sid;
      cheatWrites(cheat, (m) => {
        if (rewind) {
          m.set(SUM, values[0]);
          m.set(`ses:${TABLE}:${INC}:${nextSid(CTX, asCheckpoint(values[0])!)}`, new Y.Map());
        }
        m.delete(`ses:${TABLE}:${INC}:${headSid}`);
      });
      T += STEP;
      sync(T, cheat, ...pages);
      const most = new Map<string, number>();
      for (const until = T + 60_000; T <= until; T += STEP) {
        sync(T, cheat, ...pages);
        for (const p of pages) {
          frame(T, p);
          const ses = computedOf(p).get(`ses:${TABLE}:${INC}:${headSid}`) as Y.Map<unknown> | undefined;
          const n = ses ? [...ses.keys()].filter((k) => k.startsWith(`s:${r3}:`)).length : 0;
          most.set(p.name, Math.max(most.get(p.name) ?? 0, n));
        }
        sync(T, cheat, ...pages);
      }
      for (const p of pages) {
        expect(decidedOn(p, r4), `${p.name} round ${r4}`).toBe(true);
        expect(chipsOn(p, pages), p.name).toEqual(chips);
        expect(most.get(p.name), `${p.name}: round ${r3}'s slips`).toBeLessThanOrEqual(1);
      }
    }, 180_000);
  }
});

describe('🩹 a page of the build before, beside a restore', () => {
  /** A page named so that it isn't first in turn to close round r beside
   *  `pages` (a closer of the build before freezes its own felt, whose seed
   *  it forgot: documented). */
  async function notFirstToClose(pages: Page[], r: number): Promise<Page> {
    for (let i = 0; ; i++) {
      const p = await loadPage(i === 0 ? 'Old' : `Old${i}`, 3);
      if (byRank([...pages, p], 'close', r)[0] !== p) return p;
    }
  }

  for (const off of [true, false]) {
    it(`a replay put back: the felt it put down on the head's session (recovery ${off ? 'off' : 'on'}) never forfeits its stake`, async () => {
      const pages = await openRoom(['A', 'B'], T0);
      const old = await notFirstToClose(pages, 3);
      old.casino.setComputedRecoveryForTests(!off);
      old.casino.buyInChips(old.pid, 1_000);
      sync(T0, old, ...pages);
      const all = [...pages, old];
      const values: unknown[] = [];
      let at = T0;
      for (let i = 0; i < 2; i++) {
        ({ at } = decideRound(all, at + STEP));
        trimByHand(pages[0], testIdentity(`trimmer-${i}`));
        sync(at, ...all);
        values.push(computedOf(pages[0]).get(SUM));
        at = run(all, at + STEP, at + 60_000, { step: STEP, until: () => all.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
      }
      const r = foldOf(old).open;
      expect(r).toBe(3);
      feltsDown(all, at + STEP);
      const cheat = await withCheat(all, at + STEP);
      forge(cheat, values[0]);
      let T = at + 2 * STEP;
      sync(T, cheat, ...all);
      T = run(all, T, T + 40_000, { step: STEP, until: () => all.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1])) });
      sync(T, cheat, ...all);
      expect(asCheckpoint(computedOf(old).get(SUM))!.u).toBe(2);
      const end = run(all, T + STEP, T + 120_000, { step: STEP, until: () => all.every((p) => decidedOn(p, r)) });
      expect(end).toBeLessThanOrEqual(T + 120_000);
      for (const p of all) {
        const round = foldOf(p).rounds.find((v) => v.r === r) ?? null;
        expect(round?.decided, p.name).not.toBeNull();
        // Counted, or never frozen: its stake back.
        expect(!round!.present.includes(old.pid) || round!.counted.includes(old.pid), `${p.name}: ${round!.decided}`).toBe(true);
        if (!round!.counted.includes(old.pid)) expect(round!.deltas.get(old.pid) ?? 0n, p.name).toBe(0n);
      }
    }, 180_000);

    it(`two honest trims at once, the lower winning (recovery ${off ? 'off' : 'on'} on the other build's page): its felt never forfeits its stake`, async () => {
      const [a, b] = await openRoom(['A', 'B'], T0);
      const old = await notFirstToClose([a, b], 3);
      old.casino.setComputedRecoveryForTests(!off);
      old.casino.buyInChips(old.pid, 1_000);
      sync(T0, old, a, b);
      const all = [a, b, old];
      let T = decideRound(all, T0 + STEP).at;
      T = run(all, T + STEP, T + 60_000, { step: STEP, until: () => all.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
      // Round 2's felts down; a lagging trimmer Z sees that much and no more.
      feltsDown(all, T);
      const z = await loadPage('Z', 50);
      z.casino.setComputedRecoveryForTests(false);
      sync(T, z, ...all);
      T = run(all, T + STEP, T + 60_000, { step: STEP, until: () => all.every((p) => decidedOn(p, 2)) });
      T = run(all, T + STEP, T + 60_000, { step: STEP, until: () => all.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
      feltsDown(all, T);
      // A's trim at round 2 and Z's at round 1 at once: Z's client is
      // higher, so Z's wins in the doc.
      trimByHand(a, testIdentity('trimmer-A'));
      trimByHand(z, testIdentity('trimmer-Z'));
      const head = computedOf(a).get(SUM);
      T += STEP;
      sync(T, z, ...all);
      expect(asCheckpoint(computedOf(old).get(SUM))!.u).toBe(1);
      T = run(all, T, T + 60_000, { step: STEP, until: () => all.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(head)) });
      const end = run(all, T + STEP, T + 120_000, { step: STEP, until: () => all.every((p) => decidedOn(p, 3)) });
      expect(end).toBeLessThanOrEqual(T + 120_000);
      for (const p of all) {
        const round = foldOf(p).rounds.find((v) => v.r === 3) ?? null;
        expect(round?.decided, p.name).not.toBeNull();
        expect(!round!.present.includes(old.pid) || round!.counted.includes(old.pid), `${p.name}: ${round!.decided}`).toBe(true);
        if (!round!.counted.includes(old.pid)) expect(round!.deltas.get(old.pid) ?? 0n, p.name).toBe(0n);
      }
    }, 180_000);
  }
});

describe('🩹 a checkpoint whose session the page never saw', () => {
  it('is opened OPEN_WAIT_MS on, in turn, by a page that never counted from it', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const { at } = playAndTrim(pages, T0, 1);
    const sid = foldOf(pages[0]).base.sid;
    const cheat = await withCheat(pages, at);
    cheatWrites(cheat, (m) => m.delete(`ses:${TABLE}:${INC}:${sid}`));
    // A page loaded now, on the cheat's doc alone (A and B gone): the
    // checkpoint, and no session for it.
    const fresh = await loadPage('N', 7);
    const T = at + STEP;
    send(T, cheat, fresh);
    expect(foldOf(fresh).base.sid).toBe(sid);
    expect(recoveryOf(fresh).sessionMissing).toBe(true);
    expect(recoveryOf(fresh).lost).toBe(false);
    const { wait } = firstInTurn(fresh, [fresh], 'open', 1);
    const back = run([fresh], T, T + 60_000, { step: STEP, until: () => sessionsOf(fresh).includes(`ses:${TABLE}:${INC}:${sid}`) });
    expect(back).toBeGreaterThanOrEqual(T + fresh.table.OPEN_WAIT_MS + wait);
    expect(back).toBeLessThanOrEqual(frameAt(T, fresh.table.OPEN_WAIT_MS + wait) + STEP);
  }, 90_000);
});

describe('no page signs a checkpoint again in place', () => {
  it('names the checkpoint key only to read it, and to write it in a trim, an end and a restore', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const writers: string[] = [];
    const other: string[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || /Sim|Kit/.test(f)) continue;
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      // Every place the source names the key's prefix, in any quotes.
      for (const m of src.matchAll(/['"`]sum:/g)) {
        const at = m.index!;
        const line = src.slice(src.lastIndexOf('\n', at) + 1, at);
        if (/^\s*(\*|\/\/)/.test(line)) continue;
        const fn = [...src.slice(0, at).matchAll(/function (\w+)/g)].at(-1)?.[1];
        if (/\.set\($/.test(line)) writers.push(`${f}:${fn}`);
        else if (!/(\.get\(|\.has\(|\.startsWith\(|\.slice\()$/.test(line)) other.push(`${f}:${fn}: ${line.trim()}`);
      }
    }
    expect(writers.sort()).toEqual([
      'casinoDoc.ts:finalizeComputed', 'casinoDoc.ts:restoreComputedCheckpoint', 'casinoDoc.ts:writeCheckpointAndTrim',
    ]);
    // (A key built anywhere else, in a variable or a helper, would be a
    // write this can't see.)
    expect(other).toEqual([]);
  });
});

describe('🧪 adopt: what a page that drops a jump refutes, and compaction behind a forgery', () => {
  /** Frames of `pages` (the cheat's doc synced too) every STEP from `from`
   *  to `to`, or until `until` holds after one; the restores written while
   *  one was in motion (restoreWrites), and the time it stopped. */
  function adopt_frames(pages: Page[], cheat: Page, from: number, to: number, until: () => boolean = () => false): { at: number; writes: number } {
    let writes = 0;
    for (let T = from; T <= to; T += STEP) {
      sync(T, cheat, ...pages);
      for (const p of pages) writes += restoreWrites(p, T);
      sync(T, cheat, ...pages);
      if (until()) return { at: T, writes };
    }
    return { at: to + STEP, writes };
  }

  it('a page that took a jump and a trim of it as its head refutes both sessions once it drops them: a checkpoint built on either is put back by it too, and no page fights over the head', async () => {
    const pages = await openRoom(['A'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 1);
    feltsDown([a], at + STEP);
    const head = asCheckpoint(values[0])!;
    // A jump of A's head, then a trim of the jump's session (as a page that
    // counted the jump writes one): A refutes both as they come; N, loaded
    // while they stood, takes each as its head in turn.
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, head), head.u + 501, 'f'.repeat(32), {});
    const J1 = kit.checkpoint(testIdentity('earlier-build'), nextSid(CTX, J), J.u + 1, 'e'.repeat(32), {});
    const cheat = await withCheat(pages, at + STEP);
    const fresh = await loadPage('N', 7);
    const both = [a, fresh];
    let T = at + 2 * STEP;
    for (const cp of [J, J1]) {
      forge(cheat, cp);
      sync(T, cheat, a);
      send(T, cheat, fresh);
      expect(recoveryOf(a).trigger).toBe('jump');
      expect(recoveryOf(fresh).trigger).toBeNull();
      expect(bytesOf(recoveryOf(fresh).head)).toBe(bytesOf(cp));
      T += STEP;
    }
    // A puts its head back; N drops the jump and its trim for it (adoption).
    const agree = (): boolean => both.every((p) => recoveryOf(p).trigger === null
      && bytesOf(computedOf(p).get(SUM)) === bytesOf(computedOf(a).get(SUM))
      && bytesOf(recoveryOf(p).head) === bytesOf(computedOf(a).get(SUM)));
    let { at: now, writes } = adopt_frames(both, cheat, T, T + 40_000, () => agree() && bytesOf(computedOf(a).get(SUM)) === bytesOf(values[0]));
    expect(now).toBeLessThanOrEqual(T + 40_000);
    expect(writes).toBe(1);
    // A checkpoint built on the trim's session, then one on the jump's own:
    // past the head, on no session of a checkpoint left in N's chain. N
    // refuted both sessions as it dropped them, so each is a jump on N as it
    // is on A, and the head goes back once, every page agreeing.
    for (const [b, u] of [[nextSid(CTX, J1), J1.u + 1], [nextSid(CTX, J), J.u + 2]] as const) {
      const X = kit.checkpoint(testIdentity('forger'), b, u, 'd'.repeat(32), {});
      now += STEP;
      forge(cheat, X);
      send(now, cheat, fresh);
      expect(recoveryOf(fresh).trigger, `N on ${b === nextSid(CTX, J) ? "the jump's" : "the trim's"} session`).toBe('jump');
      sync(now, cheat, a);
      expect(recoveryOf(a).trigger).toBe('jump');
      ({ at: now, writes } = adopt_frames(both, cheat, now + STEP, now + 40_000));
      expect(writes).toBe(1);
      expect(agree()).toBe(true);
      const cp = cpOf(a)!;
      expect(cp.u).toBeGreaterThanOrEqual(head.u);
      expect(cp.u).toBeLessThan(J.u);
      for (const p of both) expect(p.table.computedContested(TABLE, now), p.name).toBe(false);
    }
  }, 90_000);

  it('compaction an ended table would reach before the restore (felts on the rewind put its first in turn COMPACT_MS on) waits for the head, and ends it from there', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const head = asCheckpoint(values[1])!;
    const sid = foldOf(a).base.sid;
    const cheat = await withCheat(pages, at + STEP);
    // A replay, felts put down on it (as on every build), then the table
    // removed, its sessions still in the doc.
    forge(cheat, values[0]);
    sync(at + 2 * STEP, cheat, ...pages);
    feltsDown(pages, at + 2 * STEP);
    const replaySid = nextSid(CTX, asCheckpoint(values[0])!);
    for (const p of pages) {
      expect(foldOf(p).base.sid, p.name).toBe(replaySid);
      expect(foldOf(p).felts.size, p.name).toBe(pages.length);
    }
    const from = at + 3 * STEP;
    a.doc.transact(() => {
      a.doc.getMap('casino').set(`gone:${TABLE}:${INC}`, 1);
      a.doc.getMap('casino').delete(`cfg:computed:${TABLE}`);
    });
    sync(from, cheat, ...pages);
    for (const p of pages) expect(recoveryOf(p).trigger, p.name).toBe('rewind');
    // (Every page an outsider to the restore, no felt down on the head's
    // session; every page in turn for compaction, its felt on the replay's.)
    const { wait } = firstInTurn(a, pages, 'restore', head.u);
    expect(wait).toBeGreaterThanOrEqual(a.table.OUTSIDER_WAIT_MS);
    const compactDue = from + a.table.COMPACT_MS + (pages.length - 1) * a.table.STAGGER_MS;
    expect(compactDue).toBeLessThan(from + a.table.RESTORE_WAIT_MS + wait);
    let restored = -1;
    let ended = -1;
    for (let T = from; T <= from + 120_000 && ended < 0; T += STEP) {
      sync(T, cheat, ...pages);
      for (const p of pages) frame(T, p);
      sync(T, cheat, ...pages);
      if (restored < 0 && pages.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[1]))) restored = T;
      if (pages.some((p) => cpOf(p)?.e === 1)) ended = T;
    }
    expect(ended).toBeGreaterThan(0);
    for (const p of pages) {
      const end = cpOf(p)!;
      expect([end.e, end.b, end.u], p.name).toEqual([1, sid, head.u]);
      expect(end.n, p.name).toEqual(head.n);
    }
    expect(restored).toBe(frameAt(from, a.table.RESTORE_WAIT_MS + wait));
    expect(restored).toBeGreaterThan(compactDue);
    expect(ended).toBeGreaterThan(restored);
  }, 150_000);
});

describe('🧪 doubt: the slips a page of the build before let go, each rule alone', () => {
  // (casinoDoc noteDoubted has two rules: a move past the round after the
  // new base doubts the open felts it went past, and the head back after a
  // rewind or a jump doubts every felt of its session. The tests above meet
  // both at once; each of these meets one alone.)

  /** Two pages of this build, the first of them in turn to close round r
   *  first; and a page of the build before (recovery off, 1,000 chips)
   *  behind it in that turn (a closer of that build freezes its own felt,
   *  whose seed it forgot: documented). */
  async function doubt_room(r: number): Promise<{ closer: Page; other: Page; old: Page }> {
    const [closer, other] = byRank(await openRoom(['A', 'B'], T0), 'close', r);
    for (let i = 0; ; i++) {
      const old = await loadPage(i === 0 ? 'Old' : `Old${i}`, 3);
      if (byRank([closer, old], 'close', r)[0] !== closer) continue;
      old.casino.setComputedRecoveryForTests(false);
      old.casino.buyInChips(old.pid, 1_000);
      sync(T0, old, closer, other);
      return { closer, other, old };
    }
  }

  /** Round r as page p's fold reads it, decided: the page of the build
   *  before's stake on it back (its chips as `chips`, as before it put its
   *  felt down), and the close `closer`'s, freezing `frozen` alone. */
  function doubt_expectBack(p: Page, r: number, old: Page, chips: number, closer: Page, frozen: Page[]): void {
    const round = foldOf(p).rounds.find((v) => v.r === r) ?? null;
    expect(round?.decided, `${p.name}: round ${r}`).not.toBeNull();
    expect(p.casino.readChips(old.pid), `${p.name}: round ${r} ${round!.decided}`).toBe(chips);
    expect(round!.deltas.get(old.pid) ?? 0n, p.name).toBe(0n);
    expect(round!.closeRec.k, p.name).toBe(closer.pub);
    expect(Object.keys(round!.frozen).sort(), p.name).toEqual(frozen.map((q) => q.pid).sort());
  }

  it('a move with no forgery (two honest trims at once, the lower winning, on a page that never counted the higher): its close freezes none of the slips the move went past', async () => {
    const { closer: b, other: a, old } = await doubt_room(3);
    const all = [a, b, old];
    let T = decideRound(all, T0 + STEP).at;
    T = run(all, T + STEP, T + 60_000, { step: STEP, until: () => all.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    // Round 2's felts down; a lagging trimmer Z sees that much and no more.
    feltsDown(all, T);
    const z = await loadPage('Z', 50);
    z.casino.setComputedRecoveryForTests(false);
    sync(T, z, ...all);
    T = run(all, T + STEP, T + 60_000, { step: STEP, until: () => all.every((p) => decidedOn(p, 2)) });
    T = run(all, T + STEP, T + 60_000, { step: STEP, until: () => all.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    // Round 3's felts: the closer b's and the other build's only (a, with
    // none, closes nothing of it).
    const chips = chipsOn(a, all);
    for (const p of [b, old]) expect(p.table.writeComputedSlip(TABLE, [red(5)], T)).toBe('ok');
    sync(T, ...all);
    const slip = foldOf(b).felts.get(old.pid)!;
    expect(slip.rec.r).toBe(3);
    // a's trim at round 2 and Z's at round 1 at once: Z's wins in the doc.
    // b counted no checkpoint before them: Z's is its first, no rewind (and
    // a's its next, no jump), so the move from round 3 open to a base of 1
    // is all that doubts the other build's slip on b.
    trimByHand(a, testIdentity('trimmer-A'));
    trimByHand(z, testIdentity('trimmer-Z'));
    const head = computedOf(a).get(SUM);
    T += STEP;
    sync(T, z, ...all);
    for (const p of all) expect(asCheckpoint(computedOf(p).get(SUM))!.u, p.name).toBe(1);
    expect(recoveryOf(a).trigger).toBe('rewind');
    let forged = false;
    T = run(all, T, T + 60_000, {
      step: STEP,
      until: () => {
        forged ||= recoveryOf(b).trigger !== null;
        return all.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(head));
      },
    });
    expect(forged).toBe(false);
    // a's head back, the other build's felt on it as it was.
    for (const p of all) expect(foldOf(p).felts.get(old.pid)?.hash, p.name).toBe(slip.hash);
    const end = run(all, T + STEP, T + 120_000, { step: STEP, until: () => all.every((p) => decidedOn(p, 3)) });
    expect(end).toBeLessThanOrEqual(T + 120_000);
    for (const p of all) doubt_expectBack(p, 3, old, chips[2], b, [b]);
  }, 90_000);

  it('the head back after a jump (no move past an open round): its close freezes none of the other build\'s slips its session holds', async () => {
    const { closer, other, old } = await doubt_room(2);
    const all = [closer, other, old];
    const { at, values } = playAndTrim(all, T0, 1);
    expect(foldOf(old).open).toBe(2);
    const chips = chipsOn(closer, all);
    feltsDown(all, at + STEP);
    const slip = foldOf(closer).felts.get(old.pid)!;
    // A jump on the head's session, one past MAX_SESSION_ROUNDS: the open
    // round (2) is below the round after the jump's base, so the move to it
    // doubts nothing (nor the move back: the jump's session holds no felt);
    // the other build's page forgets its seed.
    const cheat = await withCheat(all, at + STEP);
    const head = asCheckpoint(values[0])!;
    const jump = kit.checkpoint(testIdentity('forger'), nextSid(CTX, head), head.u + closer.fold.MAX_SESSION_ROUNDS + 1, 'f'.repeat(32), {});
    forge(cheat, jump);
    let T = at + 2 * STEP;
    sync(T, cheat, ...all);
    for (const p of all) expect(foldOf(p).base.u, p.name).toBe(jump.u);
    for (const p of [closer, other]) {
      expect(recoveryOf(p).trigger, p.name).toBe('jump');
      expect(p.casino.computedSlipDoubted(TABLE, slip.hash), p.name).toBe(false);
    }
    T = run(all, T, T + 40_000, { step: STEP, until: () => all.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(values[0])) });
    sync(T, cheat, ...all);
    for (const p of all) expect(foldOf(p).felts.get(old.pid)?.hash, p.name).toBe(slip.hash);
    const end = run(all, T + STEP, T + 120_000, { step: STEP, until: () => all.every((p) => decidedOn(p, 2)) });
    expect(end).toBeLessThanOrEqual(T + 120_000);
    // (Every felt of the head's session doubted: the other page's of this
    // build too, its stake back as well.)
    for (const p of all) doubt_expectBack(p, 2, old, chips[2], closer, [closer]);
  }, 90_000);
});

describe('🧪 turns: who takes a turn at a restore, and how long it waits', () => {
  it('a felt with nothing on it takes no turn: a page that only saw it empty ranks the head\'s staked felts and its signer, and waits as many places', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const [a, b, c] = pages;
    const { at, values } = playAndTrim(pages, T0, 1);
    const head = asCheckpoint(values[0])!;
    const { STAGGER_MS, OUTSIDER_WAIT_MS, RECOVERY_PLACES } = a.table;
    // On the head's session: C's chips stay down; B puts chips down and
    // takes them back before A hears of either, so A counts B's felt only
    // as it ends, empty. A puts nothing down: an outsider, it waits one
    // stagger a ranked key, so a key more or less shows in its timing.
    const T = at + STEP;
    expect(c.table.writeComputedSlip(TABLE, [red(5)], T)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(6)], T)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [], T + 2 * STEP)).toBe('ok');
    expect(foldOf(b).felts.get(b.pid)?.rec.b).toEqual([]);
    sync(T + 2 * STEP, a, b, c);
    expect(foldOf(a).base.sid).toBe(nextSid(CTX, head));
    expect(foldOf(a).felts.get(b.pid)?.rec.b).toEqual([]);
    expect(foldOf(a).felts.get(c.pid)?.rec.b.length).toBe(1);
    const ranked = [c.pub, head.k].sort();
    expect(recoveryOf(a).pubs).toEqual(ranked);
    // The checkpoint deleted (B and C gone: A alone runs its tables). While
    // it is gone only the head's side is ranked: C's staked felt and the
    // head's signer, never B's empty one.
    const cheat = await withCheat(pages, T + 2 * STEP);
    cheatWrites(cheat, (m) => m.delete(SUM));
    sync(T + 3 * STEP, cheat, a);
    expect(recoveryOf(a).trigger).toBe('junk');
    expect(recoveryOf(a).pubs).toEqual(ranked);
    expect(recoveryOf(a).pubs).not.toContain(b.pub);
    const from = T + 4 * STEP;
    const { at: back, by } = watchWrites([a], cheat, from, from + 60_000, () => bytesOf(computedOf(a).get(SUM)) === bytesOf(values[0]));
    expect(by).toEqual([a]);
    expect(ranked.length).toBeLessThan(RECOVERY_PLACES);
    expect(back).toBe(frameAt(from, ranked.length * STAGGER_MS + OUTSIDER_WAIT_MS));
  }, 60_000);

  it('no page waits more than RECOVERY_PLACES places: behind more staked felts than that, an outsider waits RECOVERY_PLACES staggers and OUTSIDER_WAIT_MS', async () => {
    const pages = await openRoom(['A'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 1);
    const head = asCheckpoint(values[0])!;
    const { STAGGER_MS, OUTSIDER_WAIT_MS, RECOVERY_PLACES } = a.table;
    // Players whose pages are away put chips down on the head's session:
    // RECOVERY_PLACES + 4 of them, A not among them.
    const bettors = Array.from({ length: RECOVERY_PLACES + 4 }, (_, i) => testIdentity(`turns-bettor-${i}`));
    const r = foldOf(a).open;
    const T = at + STEP;
    clockOf(a, T);
    a.doc.transact(() => {
      for (const id of bettors) a.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
    });
    const ses = a.casino.computedSessionForWrite(TABLE)!;
    a.doc.transact(() => {
      for (const id of bettors) {
        const s = kit.slip(id, r, [red(5)]);
        ses.set(s.key, s.rec);
      }
    });
    expect(foldOf(a).base.sid).toBe(nextSid(CTX, head));
    expect([...foldOf(a).felts.keys()].sort()).toEqual(bettors.map((id) => id.pid).sort());
    // The checkpoint deleted: every bettor's key and the head's signer are
    // ranked, RECOVERY_PLACES + 5 places ahead of A.
    const cheat = await withCheat(pages, T);
    cheatWrites(cheat, (m) => m.delete(SUM));
    sync(T + STEP, cheat, a);
    expect(recoveryOf(a).trigger).toBe('junk');
    expect(recoveryOf(a).pubs).toEqual([...bettors.map((id) => id.pub), head.k].sort());
    expect(recoveryOf(a).pubs.length).toBeGreaterThan(RECOVERY_PLACES);
    const from = T + 2 * STEP;
    const { at: back, by } = watchWrites([a], cheat, from, from + 60_000, () => bytesOf(computedOf(a).get(SUM)) === bytesOf(values[0]));
    expect(by).toEqual([a]);
    expect(back).toBe(frameAt(from, RECOVERY_PLACES * STAGGER_MS + OUTSIDER_WAIT_MS));
  }, 60_000);
});

describe('🧪 turns: a page\'s restores written over, in a row or after a calm', () => {
  it('a calm of more than CONTESTED_CALM_MS between writes over a restore starts the count again: two, a calm, two raise no flag; a third in a row does', async () => {
    const pages = await openRoom(['A'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    // (No felt down: no round to decide, so no trim moves the head meanwhile,
    // and each of A's restores stays its last until the next write over it.
    // A alone runs its tables: every restore is its own.)
    const cheat = await withCheat(pages, at);
    const { CONTESTED_CALM_MS, CONTESTED_COUNT } = a.table;
    expect(CONTESTED_COUNT).toBe(3);
    const holdsHead = (): boolean => bytesOf(computedOf(a).get(SUM)) === bytesOf(values[1]);
    let T = at + STEP;
    let writes = 0;
    // One frame of A's, the cheat's doc synced: whether A is flagged after it.
    const tick = (): boolean => {
      sync(T, cheat, a);
      writes += restoreWrites(a, T);
      sync(T, cheat, a);
      const flagged = a.table.computedContested(TABLE, T);
      T += STEP;
      return flagged;
    };
    // A rewind written (the first frame A sees it at: when it counts as a
    // write over A's last restore), then frames until A has the head back:
    // whether A was flagged in each.
    const rewind = (): { seenAt: number; flags: boolean[] } => {
      forge(cheat, values[0]);
      const seenAt = T;
      const flags: boolean[] = [];
      const end = T + 60_000;
      while (T <= end) {
        flags.push(tick());
        if (holdsHead()) return { seenAt, flags };
      }
      throw new Error('the head never came back');
    };
    const runs: boolean[][] = [];
    // Five rewinds in turn, each the frame after the head is back (written
    // over: 0, then 1 and 2 in a row)…
    let last = { seenAt: T, flags: [] as boolean[] };
    for (let i = 0; i < 3; i++) runs.push((last = rewind()).flags);
    // …a calm of more than CONTESTED_CALM_MS since the last write over a
    // restore, the head standing, no write…
    const before = writes;
    while (T <= last.seenAt + CONTESTED_CALM_MS + 5_000) runs.push([tick()]);
    expect(writes).toBe(before);
    expect(holdsHead()).toBe(true);
    // …then three more in a row: 1 (the count starts again), 2, 3.
    const after: boolean[][] = [];
    for (let i = 0; i < 3; i++) after.push(rewind().flags);
    expect(writes).toBe(6);
    expect(runs.flat()).not.toContain(true);
    expect(after[0]).not.toContain(true);
    expect(after[1]).not.toContain(true);
    // (Flagged from the frame the third write over in a row is seen, until
    // the head is back and on.)
    expect(after[2].every((f) => f)).toBe(true);
    expect(a.table.computedContested(TABLE, T)).toBe(true);
    expect(recoveryOf(a).trigger).toBeNull();
  }, 90_000);
});

describe('🧪 forged: a second forgery over the first', () => {
  /** Frames of `on` every STEP from `from` to `to`, synced with the cheat;
   *  `act` first at each (a cheat's write). When every one of them first
   *  held `value` as the checkpoint (-1: never). */
  function forged_framesUntilBack(on: Page[], cheat: Page, from: number, to: number, value: unknown, act: (T: number) => void): number {
    let back = -1;
    for (let T = from; T <= to; T += STEP) {
      act(T);
      sync(T, cheat, ...on);
      for (const p of on) frame(T, p);
      sync(T, cheat, ...on);
      if (back < 0 && on.every((p) => bytesOf(computedOf(p).get(SUM)) === bytesOf(value))) back = T;
    }
    return back;
  }

  it('the head\'s session deleted with a jump written over a replay: once the head is back, a gone page\'s records go back from the witnesses\' copies', async () => {
    const pages = await openRoom(['A', 'B', 'C'], T0);
    const [a, b, c] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const { r, at: decided } = decideRound(pages, at + STEP);
    // (Its result shown everywhere: A and B hold their witness copies.)
    const shown = run(pages, decided + STEP, decided + 30_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    const sid = foldOf(a).base.sid;
    const headSes = `ses:${TABLE}:${INC}:${sid}`;
    const ses = computedOf(a).get(headSes) as Y.Map<unknown>;
    const kept = new Map([...ses.entries()].filter(([k]) => (/^[csxfz]:/.test(k) && Number(k.split(':')[1]) === r)).map(([k, v]) => [k, bytesOf(v)]));
    const ofC = [...kept.keys()].filter((k) => k.includes(`:${c.pid}:`));
    expect(ofC.length).toBeGreaterThan(0);
    const round = foldOf(a).rounds.find((v) => v.r === r)!;
    const chips = chipsOn(a, pages);
    // C gone. A replay; 2 s on, a jump of the head written over it, the
    // head's session deleted with it, nothing in its place.
    const cheat = await withCheat(pages, shown + STEP);
    const J = kit.checkpoint(testIdentity('forger'), sid, asCheckpoint(values[1])!.u + 501, 'f'.repeat(32), {});
    forge(cheat, values[0]);
    const T = shown + 2 * STEP;
    const back = forged_framesUntilBack([a, b], cheat, T, T + 40_000, values[1], (t) => {
      if (t !== T + 2_000) return;
      forge(cheat, J);
      cheatWrites(cheat, (m) => m.delete(headSes));
    });
    expect(back).toBeGreaterThan(T + 2_000);
    // The restore opened the head's session again, empty: A and B put back
    // their own, and C's from their copies, kept through both forgeries.
    const live = (p: Page) => computedOf(p).get(headSes) as Y.Map<unknown> | undefined;
    const held = (p: Page, keys: Iterable<string>) => [...keys].filter((k) => live(p)?.has(k) === true && bytesOf(live(p)!.get(k)) === kept.get(k));
    const U = T + 40_000 + STEP;
    run([a, b], U, U + 60_000, { step: STEP, until: () => [a, b].every((p) => held(p, kept.keys()).length === kept.size) });
    for (const p of [a, b]) {
      expect(held(p, ofC), `${p.name}: C's records`).toEqual(ofC);
      expect(held(p, kept.keys()), p.name).toEqual([...kept.keys()]);
      const v = foldOf(p).rounds.find((x) => x.r === r)!;
      expect([v.close, v.decided], p.name).toEqual([round.close, round.decided]);
      expect(chipsOn(p, pages), p.name).toEqual(chips);
    }
  }, 90_000);
});

describe('🧪 since: what a page put down on a forged checkpoint\'s session, once the table moves on from the forgery', () => {
  /** A page P that took a jump as its head (it loaded while the cheat's
   *  jump J over A's head H stood: chain [J]), framed a while on it with the
   *  cheat's doc alone, past TAKEN_WAIT_MS (so a rewind of it is one it
   *  puts back, not one it gives way to); and H's value, as the doc held
   *  it. */
  async function since_tookJump(): Promise<{ p: Page; cheat: Page; H: unknown; T: number }> {
    const [a] = await openRoom(['A'], T0);
    const { at, values } = playAndTrim([a], T0, 1);
    const H = asCheckpoint(values[0])!;
    const cheat = await withCheat([a], at + STEP);
    forge(cheat, kit.checkpoint(testIdentity('forger'), nextSid(CTX, H), H.u + 501, 'f'.repeat(32), {}));
    const p = await loadPage('P', 5);
    p.casino.buyInChips(p.pid, 1_000);
    const T = at + 2 * STEP;
    sync(T, cheat, p);
    expect(cpOf(p)!.u).toBe(H.u + 501);
    expect(recoveryOf(p).trigger).toBeNull();
    const { at: after } = watchWrites([p], cheat, T + STEP, T + p.casino.TAKEN_WAIT_MS + 1_000, () => false);
    return { p, cheat, H: values[0], T: after };
  }

  /** The slip keys (round r's, any round's when left out) in the session
   *  page p counts from (computedPageKit keysIn). */
  const since_slips = (p: Page, r?: number): string[] => {
    const ses = p.casino.computedSessionForWrite(TABLE);
    const prefix = r === undefined ? 's:' : `s:${r}:`;
    return ses ? [...ses.keys()].filter((k) => k.startsWith(prefix)).sort() : [];
  };

  /** A checkpoint the cheat writes, on a session no page counted (`b`), at
   *  round u: below P's jump head, so a rewind to P. */
  const since_forged = (b: string, u: number): Checkpoint => kit.checkpoint(testIdentity('forger'), b, u, 'f'.repeat(32), {});

  /** Page p's felt on the open round of the session it counts from, written
   *  now: its key. */
  function since_felt(p: Page, T: number, chips: number): string {
    const r = foldOf(p).open;
    expect(p.table.writeComputedSlip(TABLE, [red(chips)], T)).toBe('ok');
    const keys = since_slips(p, r).filter((k) => k.startsWith(`s:${r}:${p.pid}:`));
    expect(keys).toHaveLength(1);
    return keys[0];
  }

  /** H back, then `F` again with its session missing page P's felt `gone`
   *  (null: as it is): two updates P takes one after the other, with no
   *  frame between (the chain adopts H, then counts F as an honest move
   *  past it: a checkpoint on another session, past the head). */
  function since_backThenForged(p: Page, cheat: Page, T: number, H: unknown, F: Checkpoint, gone: string | null): void {
    cheatWrites(cheat, (m) => m.set(SUM, JSON.parse(JSON.stringify(H))));
    send(T, cheat, p);
    cheatWrites(cheat, (m) => {
      m.set(SUM, JSON.parse(JSON.stringify(F)));
      if (gone !== null) (m.get(`ses:${TABLE}:${INC}:${nextSid(CTX, F)}`) as Y.Map<unknown>).delete(gone);
    });
    send(T, cheat, p);
    expect(bytesOf(cpOf(p))).toBe(bytesOf(F));
    expect(recoveryOf(p).trigger).toBeNull();
  }

  it('the forged session itself comes to stand: the felt the page put down on it since stays its own, put back after a delete and counted', async () => {
    const { p, cheat, H, T: t0 } = await since_tookJump();
    const F = since_forged('a'.repeat(24), asCheckpoint(H)!.u + 100);
    forge(cheat, F);
    let T = t0 + STEP;
    sync(T, cheat, p);
    expect(recoveryOf(p).trigger).toBe('rewind');
    expect(foldOf(p).base.sid).toBe(nextSid(CTX, F));
    const k = since_felt(p, T, 10);
    // (Well inside its restore's wait: P's key is no head-side one.)
    const waiting = watchWrites([p], cheat, T + STEP, T + 2_000, () => false);
    expect(waiting.by).toEqual([]);
    expect(recoveryOf(p).trigger).toBe('rewind');
    T = waiting.at + STEP;
    since_backThenForged(p, cheat, T, H, F, k);
    expect(since_slips(p, F.u + 1)).toEqual([]);
    run([p], T + STEP, T + 3_000, { step: STEP });
    expect(foldOf(p).base.sid).toBe(nextSid(CTX, F));
    expect(since_slips(p, F.u + 1)).toEqual([k]);
    expect(foldOf(p).felts.get(p.pid)?.key).toBe(k);
  }, 60_000);

  it('two forgeries in turn, the second comes to stand: the felt put down on it stays the page\'s, and none of the first\'s goes into it', async () => {
    const { p, cheat, H, T: t0 } = await since_tookJump();
    const u = asCheckpoint(H)!.u;
    const F1 = since_forged('b'.repeat(24), u + 50);
    const F2 = since_forged('a'.repeat(24), u + 100);
    forge(cheat, F1);
    let T = t0 + STEP;
    sync(T, cheat, p);
    expect(foldOf(p).base.sid).toBe(nextSid(CTX, F1));
    const k1 = since_felt(p, T, 10);
    let w = watchWrites([p], cheat, T + STEP, T + 1_000, () => false);
    forge(cheat, F2);
    T = w.at + STEP;
    sync(T, cheat, p);
    expect(recoveryOf(p).trigger).toBe('rewind');
    expect(foldOf(p).base.sid).toBe(nextSid(CTX, F2));
    const k2 = since_felt(p, T, 12);
    w = watchWrites([p], cheat, T + STEP, T + 1_000, () => false);
    expect(w.by).toEqual([]);
    T = w.at + STEP;
    since_backThenForged(p, cheat, T, H, F2, null);
    run([p], T + STEP, T + 3_000, { step: STEP });
    expect(foldOf(p).base.sid).toBe(nextSid(CTX, F2));
    expect(since_slips(p, F1.u + 1)).toEqual([]);
    expect(since_slips(p, F2.u + 1)).toEqual([k2]);
    expect(foldOf(p).felts.get(p.pid)?.key).toBe(k2);
    expect(k1).not.toBe(k2);
  }, 60_000);

  it('the table moves on to another session (an extension of the head): what the pages put down on the forged session goes, none of it into the new one', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const { r, at: decided } = decideRound(pages, at + STEP);
    const shown = run(pages, decided + STEP, decided + 30_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    const round = foldOf(a).rounds.find((v) => v.r === r)!;
    const E = kit.checkpoint(testIdentity('trimmer-E'), foldOf(a).base.sid, r, round.close, Object.fromEntries(foldOf(a).nets));
    const chips = chipsOn(a, pages);
    const cheat = await withCheat(pages, shown + STEP);
    const F = asCheckpoint(values[0])!;
    forge(cheat, values[0]);
    let T = shown + 2 * STEP;
    sync(T, cheat, ...pages);
    for (const p of pages) {
      expect(recoveryOf(p).trigger).toBe('rewind');
      expect(foldOf(p).base.sid).toBe(nextSid(CTX, F));
    }
    // Felts on the replay's open round, as on every build.
    feltsDown(pages, T);
    for (const p of pages) expect(since_slips(p, F.u + 1)).toHaveLength(pages.length);
    const waiting = watchWrites(pages, cheat, T + STEP, T + 2_000, () => false);
    expect(waiting.by).toEqual([]);
    // The extension lands: neither the head's session nor the replay's.
    forge(cheat, E);
    T = waiting.at + STEP;
    const after = watchWrites(pages, cheat, T, T + 5_000, () => false);
    expect(after.by).toEqual([]);
    for (const p of pages) {
      expect(foldOf(p).base.sid, p.name).toBe(nextSid(CTX, E));
      expect(recoveryOf(p).trigger, p.name).toBeNull();
      expect(since_slips(p), p.name).toEqual([]);
      expect(chipsOn(p, pages), p.name).toEqual(chips);
    }
  }, 60_000);
});

describe('🩹 a page that took its head at load', () => {
  /** Every page and the cheat, a frame each, STEP apart from T to `end`:
   *  each page's restores of the checkpoint (restoreWrites). */
  function framesFor(pages: Page[], cheat: Page, T: number, end: number): Map<Page, number> {
    const writes = new Map(pages.map((p) => [p, 0]));
    for (; T <= end; T += STEP) {
      sync(T, cheat, ...pages);
      for (const p of pages) writes.set(p, writes.get(p)! + restoreWrites(p, T));
      sync(T, cheat, ...pages);
    }
    return writes;
  }

  it('waits longer than the longest wait of a restore by a page that counted the head', async () => {
    const [a] = await openRoom(['A'], T0);
    expect(a.casino.TAKEN_WAIT_MS).toBeGreaterThan(a.table.RESTORE_WAIT_MS + a.table.RECOVERY_PLACES * a.table.STAGGER_MS + a.table.OUTSIDER_WAIT_MS);
  });

  // A and B counted every checkpoint; N loads while a peer's jump over the
  // first of them stands, so N's head is the jump. The head A and B put
  // back reads to N as a rewind of its head, built on another session than
  // any N counted: N gives way to it rather than put its own back over it,
  // whatever the depth of the head past the checkpoint the jump went over.
  it.each([2, 3])('gives way to the head the pages that counted it put back over a jump it took at load, the head %i checkpoints in: one restore, and no page writes after it', async (depth) => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at, values } = playAndTrim(pages, T0, depth);
    feltsDown(pages, at + STEP);
    const over = asCheckpoint(values[0])!;
    const head = asCheckpoint(values[depth - 1])!;
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, over), over.u + 501, 'f'.repeat(32), {});
    expect(J.u).toBeGreaterThan(head.u);
    const cheat = await withCheat(pages, at + STEP);
    const fresh = await loadPage('N', 7);
    forge(cheat, J);
    send(at + 2 * STEP, cheat, fresh);
    expect(bytesOf(recoveryOf(fresh).head)).toBe(bytesOf(J));
    // N a player on the jump's session: its key is the first in its turns.
    fresh.casino.buyInChips(fresh.pid, 1_000);
    expect(fresh.table.writeComputedSlip(TABLE, [red(7)], at + 2 * STEP)).toBe('ok');
    const end = at + 3 * STEP + 120_000;
    const writes = framesFor([a, b, fresh], cheat, at + 3 * STEP, end);
    expect(writes.get(a)! + writes.get(b)!).toBe(1);
    expect(writes.get(fresh)).toBe(0);
    // (The table played on from the head since: every page counts the same
    // checkpoint, on the head's line.)
    const now = cpOf(a)!;
    expect(now.u).toBeGreaterThanOrEqual(head.u);
    expect(now.u).toBeLessThan(J.u);
    for (const p of [a, b, fresh]) {
      expect(bytesOf(computedOf(p).get(SUM)), p.name).toBe(bytesOf(computedOf(a).get(SUM)));
      expect(recoveryOf(p).trigger, p.name).toBeNull();
      expect(bytesOf(recoveryOf(p).head), p.name).toBe(bytesOf(computedOf(a).get(SUM)));
      expect(p.table.computedContested(TABLE, end), p.name).toBe(false);
    }
  }, 90_000);

  it('gives way again when the jump it gave way over is written again, though it is long past TAKEN_WAIT_MS', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    const [a, b] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    feltsDown(pages, at + STEP);
    const over = asCheckpoint(values[0])!;
    const J = kit.checkpoint(testIdentity('forger'), nextSid(CTX, over), over.u + 501, 'f'.repeat(32), {});
    const cheat = await withCheat(pages, at + STEP);
    const fresh = await loadPage('N', 7);
    forge(cheat, J);
    send(at + 2 * STEP, cheat, fresh);
    fresh.casino.buyInChips(fresh.pid, 1_000);
    expect(fresh.table.writeComputedSlip(TABLE, [red(7)], at + 2 * STEP)).toBe('ok');
    let T = at + 3 * STEP + 2 * fresh.casino.TAKEN_WAIT_MS;
    framesFor([a, b, fresh], cheat, at + 3 * STEP, T);
    const line = bytesOf(computedOf(a).get(SUM));
    expect(bytesOf(computedOf(fresh).get(SUM))).toBe(line);
    expect(asCheckpoint(computedOf(a).get(SUM))!.u).toBeLessThan(J.u);
    forge(cheat, J);
    send(T + STEP, cheat, fresh);
    T += 2 * STEP;
    const writes = framesFor([a, b, fresh], cheat, T, T + 120_000);
    expect(writes.get(a)! + writes.get(b)!).toBe(1);
    expect(writes.get(fresh)).toBe(0);
    for (const p of [a, b, fresh]) {
      expect(bytesOf(computedOf(p).get(SUM)), p.name).toBe(bytesOf(computedOf(a).get(SUM)));
      expect(asCheckpoint(computedOf(p).get(SUM))!.u, p.name).toBeLessThan(J.u);
      expect(p.table.computedContested(TABLE, T + 120_000), p.name).toBe(false);
    }
  }, 120_000);

  it('puts its head back over a replay of the checkpoint its head was built on, the moment it loads', async () => {
    const pages = await openRoom(['A'], T0);
    const [a] = pages;
    const { at, values } = playAndTrim(pages, T0, 2);
    const cheat = await withCheat(pages, at + STEP);
    // N alone with the cheat: what it does is its own.
    const fresh = await loadPage('N', 7);
    send(at + STEP, cheat, fresh);
    expect(bytesOf(recoveryOf(fresh).head)).toBe(bytesOf(values[1]));
    forge(cheat, values[0]);
    send(at + 2 * STEP, cheat, fresh);
    expect(recoveryOf(fresh).trigger).toBe('rewind');
    const writes = framesFor([fresh], cheat, at + 3 * STEP, at + 3 * STEP + 60_000);
    expect(writes.get(fresh)).toBe(1);
    expect(bytesOf(computedOf(fresh).get(SUM))).toBe(bytesOf(values[1]));
    void a;
  }, 90_000);

  it('a page there since the table opened puts its first checkpoint back over a rewind at once: it saw that checkpoint come', async () => {
    const pages = await openRoom(['A', 'B'], T0);
    let { at } = decideRound(pages, T0 + STEP);
    at = run(pages, at + STEP, at + 60_000, { step: STEP, until: () => pages.every((p) => viewOf(p, Date.now())?.phase === 'betting') });
    ({ at } = decideRound(pages, at + STEP));
    trimByHand(pages[0], testIdentity('trimmer'));
    sync(at, ...pages);
    const first = cpOf(pages[0])!;
    const value = computedOf(pages[0]).get(SUM);
    expect(first.b).toBe('g');
    // (Felts on its session: the pages take turns.)
    feltsDown(pages, at + STEP);
    const cheat = await withCheat(pages, at + STEP);
    const R = kit.checkpoint(testIdentity('forger'), 'g', first.u - 1, 'f'.repeat(32), {});
    forge(cheat, R);
    sync(at + 2 * STEP, cheat, ...pages);
    for (const p of pages) expect(recoveryOf(p).trigger, p.name).toBe('rewind');
    const writes = framesFor(pages, cheat, at + 3 * STEP, at + 3 * STEP + 60_000);
    expect([...writes.values()].reduce((x, y) => x + y, 0)).toBe(1);
    for (const p of pages) expect(bytesOf(computedOf(p).get(SUM)), p.name).toBe(bytesOf(value));
  }, 90_000);

  // N alone with the cheat (A gone): a replay of a checkpoint older than the
  // one N's head was built on. Within TAKEN_WAIT_MS of loading N gives way
  // (a page that counted the head would have put it back by then); past
  // it, N puts its head back.
  it.each([false, true])('a replay older than its head\'s base: given way to within TAKEN_WAIT_MS of loading, put back past it (past %s)', async (past) => {
    const pages = await openRoom(['A'], T0);
    const { at, values } = playAndTrim(pages, T0, 3);
    const cheat = await withCheat(pages, at + STEP);
    const fresh = await loadPage('N', 7);
    send(at + STEP, cheat, fresh);
    let T = at + 2 * STEP;
    if (past) T = run([fresh], T, T + fresh.casino.TAKEN_WAIT_MS + STEP, { step: STEP }) + STEP;
    forge(cheat, values[0]);
    send(T, cheat, fresh);
    expect(recoveryOf(fresh).trigger).toBe(past ? 'rewind' : null);
    const writes = framesFor([fresh], cheat, T + STEP, T + STEP + 60_000);
    expect(writes.get(fresh)).toBe(past ? 1 : 0);
    expect(bytesOf(computedOf(fresh).get(SUM))).toBe(bytesOf(values[past ? 2 : 0]));
  }, 90_000);
});
