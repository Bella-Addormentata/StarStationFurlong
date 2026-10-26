/**
 * 🧮👁 A computed table when the author of a record has left (computedTable
 * closeDuty's seed-out timeout, noteWitness and witnessDuty): a peer can
 * delete any record, and the page that wrote it may be gone.
 *
 * A round's close deleted after its seeds went out leaves no page able to
 * close it again: the stand-down lasts ABANDON_MS, then the round closes
 * afresh on fresh seeds. A record a round rests on deleted after its result
 * showed would move chips after the fact: the pages that played it keep a
 * copy and put it back, in turn after its author's, and a page that only
 * watched it trims nothing short of it meanwhile. Each page is its own
 * load of the casino modules (computedPageKit), synced by hand, every clock
 * explicit; keys are fresh each run, so each spec works out who goes first
 * from them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { asClose, asForfeit, asSlip } from './computedFold';
import type { CloseRec, ForfeitRec, SlipRec } from './computedFold';
import {
  byRank, clockOf, deleteIn, deliver, frame, keysIn, loadPage, openRoom, PAGE_CTX as CTX, PAGE_INC as INC,
  PAGE_TABLE as TABLE, putIn, run, signAs, sync, trimByHand, updatesOf,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { black, ComputedKit, red, straight, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import { TABLE_LEASE_LAPSE_MS } from './croupier';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
/** One frame per tick: every frame runs every page's duties. */
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

const room = (names: string[]): Promise<Page[]> => openRoom(names, T0);
const recOf = <T>(p: Page, key: string): T => p.casino.computedSessionForWrite(TABLE)?.get(key) as T;
const closesOf = (p: Page, r: number): CloseRec[] => keysIn(p, 'c', r).map((k) => asClose(recOf(p, k))!);
const forfeitsOf = (p: Page, r: number): ForfeitRec[] => keysIn(p, 'f', r).map((k) => asForfeit(recOf(p, k))!);
const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const phaseOf = (p: Page, now?: number) => p.table.readComputedRoulette(TABLE, now);
const chipsOf = (p: Page, pids: string[]): number[] => pids.map((pid) => p.casino.readChips(pid));
const bytesOf = (p: Page, key: string): string | undefined => JSON.stringify(recOf(p, key));
const revealOf = (p: Page, r: number, pid: string): string => keysIn(p, 'x', r).find((k) => k.startsWith(`x:${r}:${pid}:`))!;
const entries = (recs: Built<unknown>[]): [string, unknown][] => recs.map((s) => [s.key, s.rec]);

/** A duty due at `due` ran on the first tick at or after it. */
function expectAt(at: number, due: number): void {
  expect(at).toBeGreaterThanOrEqual(due);
  expect(at).toBeLessThan(due + STEP);
}

/** Run `pages` from `from` until each shows the round's result, then one
 *  frame more: a page keeps its copies on its first frame after its result
 *  shows (what the last frame's sync brought in, it acts on at its next). */
function settle(pages: Page[], from: number, until = from + 60_000): number {
  const at = run(pages, from, until, { step: STEP, until: () => pages.every((p) => phaseOf(p)?.phase === 'settled') });
  expect(at).toBeLessThan(until);
  run(pages, at + STEP, at + STEP, { step: STEP });
  return at + STEP;
}

/** Test identities as players of the room: each pinned on page p. */
function pinOn(p: Page, ...ids: TestIdentity[]): void {
  p.doc.transact(() => {
    for (const id of ids) p.doc.getMap('players').set(id.pid, { keyB64: id.pub, name: id.pid });
  });
}

/** The first of test players `<name>0` … `<name>63` (player `pid`) that
 *  `fits`, or null. A spec that needs a test player ranked just so against
 *  its pages' keys draws its room again on null: the keys are fresh each
 *  run, and when a page ranks near the end, a walk with no bound can take
 *  tens of thousands of key derivations (seconds past the spec's timeout,
 *  in a loop vitest can't interrupt) before one fits. */
function firstFit(name: string, pid: string, fits: (id: TestIdentity) => boolean): TestIdentity | null {
  for (let i = 0; i < 64; i++) {
    const id = testIdentity(`${name}${i}`, pid);
    if (fits(id)) return id;
  }
  return null;
}

/** Key `pub`'s place among `pubs` for `duty` on round r, as the duties count it. */
function placeOf(p: Page, duty: 'close' | 'forfeit' | 'abandon' | 'trim', r: number, pubs: string[], pub: string): number {
  const ranks = [...new Set(pubs)].map((k) => p.fold.dutyRank(duty, CTX, r, k)).sort();
  return ranks.indexOf(p.fold.dutyRank(duty, CTX, r, pub));
}

/** How many transactions page p made itself (not ones it heard) while `act` ran. */
function localWrites(p: Page, act: () => void): number {
  let n = 0;
  const count = (_u: Uint8Array, _origin: unknown, _doc: Y.Doc, tr: Y.Transaction): void => {
    if (tr.local) n += 1;
  };
  p.doc.on('update', count);
  try {
    act();
  } finally {
    p.doc.off('update', count);
  }
  return n;
}

/** Every page agrees on the cage, and it balances: the house holds what is
 *  on the felts, less what the players' decided nets won. */
function expectConserved(pages: Page[]): void {
  const cage = pages[0].casino.readCageLedger();
  const sum = (m: Map<string, bigint>): bigint => [...m.values()].reduce((x, y) => x + y, 0n);
  for (const p of pages) {
    expect(p.casino.readCageLedger()).toEqual(cage);
    expect(cage.houseNet).toBe(Number(sum(foldOf(p).held) - sum(foldOf(p).nets)));
  }
}

describe('a seed out with nobody to close the round', () => {
  /**
   * A and B bet on round r (round 1, or round 2 once a round has played out
   * in full) with test player X, whose seed never comes; the first in line
   * (`gone`) closes, both pages' seeds go out (the round waits on X's), and
   * `gone` leaves before its next frame; at once a griefer deletes its
   * close: the round reads open on `stays`, its seeds out, no close in, and
   * no page holds a copy of the close (the round never showed a result).
   */
  async function stalled(opts: { played?: boolean } = {}) {
    const X = testIdentity('x', 'player-X');
    const pages = await room(['A', 'B']);
    for (const p of pages) pinOn(p, X);
    pages[0].casino.buyInChips(X.pid, 1_000);
    let T = T0;
    let r = 1;
    if (opts.played) {
      for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T)).toBe('ok');
      sync(T, ...pages);
      T = run(pages, T + STEP, T + 60_000, {
        step: STEP, until: () => pages.every((p) => foldOf(p).open === 2 && phaseOf(p)?.phase === 'betting'),
      });
      r = 2;
    }
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(20 + i)], T)).toBe('ok');
    const xs = kit.slip(X, r, [black(7)]);
    putIn(pages[0], [[xs.key, xs.rec]]);
    sync(T, ...pages);
    const [gone, stays] = byRank(pages, 'close', r);
    const closedAt = run(pages, T + STEP, T + 60_000, { step: STEP, until: () => keysIn(stays, 'c', r).length > 0 });
    run(pages, closedAt + STEP, closedAt + STEP, { step: STEP });
    const tip = foldOf(stays).tip!;
    expect(tip.revealed).toEqual([gone.pid, stays.pid].sort());
    const burned = [gone, stays].map((p) => recOf<SlipRec>(stays, `s:${r}:${p.pid}:${tip.frozen[p.pid]}`).c);
    const [key] = keysIn(stays, 'c', r);
    const close = { key, rec: recOf<CloseRec>(stays, key) };
    const at = closedAt + 2 * STEP;
    vi.setSystemTime(at);
    deleteIn(stays, [key]);
    expect(foldOf(stays).tip).toBeNull();
    return { X, xs, gone, stays, r, burned, close, at };
  }

  it('stands down ABANDON_MS from when each page saw it so, then the first in turn closes afresh on fresh seeds; the old close back is no matter', async () => {
    const { X, xs, gone, stays, burned, close, at } = await stalled();
    const { ABANDON_MS, STAGGER_MS } = stays.table;
    // C joins now, on a doc that never held the close, and bets: the round reads open to it.
    const c = await loadPage('C', 3);
    clockOf(c, at);
    c.casino.buyInChips(c.pid, 1_000);
    sync(at, stays, c);
    expect(phaseOf(c, at)).toMatchObject({ phase: 'betting', round: 1 });
    expect(c.table.writeComputedSlip(TABLE, [straight(7, 5)], at)).toBe('ok');
    sync(at, stays, c);
    // Each page first sees the seeds out on its next frame; the first in line
    // among the felts with chips on closes ABANDON_MS on, the other stands down.
    const live = [stays, c];
    const pubs = [gone.pub, stays.pub, X.pub, c.pub];
    const places = live.map((p) => placeOf(p, 'close', 1, pubs, p.pub));
    const closer = live[places.indexOf(Math.min(...places))];
    const closedAt = run(live, at + STEP, at + 90_000, { step: STEP, until: () => keysIn(stays, 'c', 1).length > 0 });
    expectAt(closedAt, at + STEP + ABANDON_MS + Math.min(...places) * STAGGER_MS);
    const [fresh] = closesOf(stays, 1);
    expect(fresh.k).toBe(closer.pub);
    // stays' felt went again under a fresh seed at once; gone's, its seed out, is frozen nowhere.
    const own = asSlip(recOf(stays, `s:1:${stays.pid}:${fresh.f[stays.pid]}`))!;
    expect(own.v).toBe(2);
    expect(burned).not.toContain(own.c);
    expect(fresh.f[gone.pid]).toBeUndefined();
    expect(fresh.f[X.pid]).toBe(xs.hash);
    expect(fresh.f[c.pid]).toBeDefined();
    // Decided on the fresh seeds (X's never comes: a forfeit counts the two).
    const decidedAt = run(live, closedAt + STEP, closedAt + 30_000, {
      step: STEP, until: () => live.every((p) => foldOf(p).rounds[0]?.decided != null),
    });
    const D = foldOf(stays).rounds[0];
    expect(D).toMatchObject({ decided: 'forfeit', counted: [c.pid, stays.pid].sort() });
    expect(D.closeRec).toEqual(fresh);
    expect(foldOf(stays).revealedCommits.has(own.c)).toBe(true);
    for (const p of live) expect(p.casino.readChips(gone.pid)).toBe(1_000);
    expectConserved(live);
    // gone comes back, and puts its close back: a rival of a decided round
    // that nothing decides, the chain keeps the decided one, nothing moves.
    const all = [gone, stays, c];
    const chips = chipsOf(stays, all.map((p) => p.pid));
    run(all, decidedAt + 10_000, decidedAt + 30_000, { step: STEP });
    expect(gone.croupier.tablesWakeCount()).toBe(1);
    expect(keysIn(stays, 'c', 1)).toContain(close.key);
    for (const p of all) {
      expect(foldOf(p).rounds[0].close).toBe(D.close);
      expect(chipsOf(p, all.map((q) => q.pid))).toEqual(chips);
    }
    expectConserved(all);
  });

  it('the seed a fresh close counted goes back, not the burned one of the same player beside it', async () => {
    const { X, gone, stays, at } = await stalled();
    const c = await loadPage('C', 3);
    clockOf(c, at);
    c.casino.buyInChips(c.pid, 1_000);
    sync(at, stays, c);
    expect(c.table.writeComputedSlip(TABLE, [straight(7, 5)], at)).toBe('ok');
    sync(at, stays, c);
    const live = [stays, c];
    const shownAt = settle(live, at + STEP, at + 120_000);
    const D = foldOf(c).rounds[0];
    expect(D.counted).toContain(stays.pid);
    // stays revealed round 1 twice: the burned seed, then the one D counts.
    const slip = recOf<SlipRec>(c, `s:1:${stays.pid}:${D.frozen[stays.pid]}`);
    const seeds = keysIn(c, 'x', 1).filter((k) => k.startsWith(`x:1:${stays.pid}:`));
    expect(seeds).toHaveLength(2);
    const counted = seeds.find((k) => c.fold.slipCommit(CTX, 1, stays.pid, recOf<{ s: string }>(c, k).s) === slip.c)!;
    // stays leaves, and a griefer deletes the seed D counted: c puts it back.
    putBack([c], [counted], shownAt + 1_000, {
      pids: [gone.pid, stays.pid, c.pid, X.pid], pubs: [stays.pub, X.pub, c.pub],
    });
    expect(foldOf(c).rounds[0]).toMatchObject({ close: D.close, decided: D.decided, counted: D.counted, pocket: D.pocket });
  });

  it('a wake starts the wait again', async () => {
    const { X, gone, stays, at } = await stalled();
    const { ABANDON_MS, STAGGER_MS } = stays.table;
    run([stays], at + STEP, at + 20_000, { step: STEP });
    expect(keysIn(stays, 'c', 1)).toEqual([]);
    // It sleeps 7 s; awake again a lapse after its first frame back, it waits from then.
    const woke = at + 27_000;
    const closedAt = run([stays], woke, woke + 90_000, { step: STEP, until: () => keysIn(stays, 'c', 1).length > 0 });
    expect(stays.croupier.tablesWakeCount()).toBe(1);
    const idx = placeOf(stays, 'close', 1, [gone.pub, stays.pub, X.pub], stays.pub);
    expectAt(closedAt, woke + TABLE_LEASE_LAPSE_MS + ABANDON_MS + idx * STAGGER_MS);
  });

  it('a session change starts the wait again', async () => {
    const { X, gone, stays, r, at } = await stalled({ played: true });
    const { ABANDON_MS, STAGGER_MS } = stays.table;
    expect(r).toBe(2);
    run([stays], at + STEP, at + 10_000, { step: STEP });
    // A trim 10 s on: round 1 into a checkpoint, round 2's felts into the next
    // session (gone's among them); a stale page puts gone's seed back in it.
    const x = revealOf(stays, 2, gone.pid);
    const seed = recOf(stays, x);
    const T = at + 10_000;
    vi.setSystemTime(T);
    trimByHand(stays, testIdentity('trimmer'));
    putIn(stays, [[x, seed]]);
    expect(foldOf(stays).base.u).toBe(1);
    const closedAt = run([stays], T + STEP, T + 90_000, { step: STEP, until: () => keysIn(stays, 'c', 2).length > 0 });
    const idx = placeOf(stays, 'close', 2, [gone.pub, stays.pub, X.pub], stays.pub);
    expectAt(closedAt, T + STEP + ABANDON_MS + idx * STAGGER_MS);
  });

  it("each round's wait is its own: one that ended with its round decided doesn't carry over", async () => {
    const { X, stays, close, at } = await stalled();
    const { ABANDON_MS, STAGGER_MS } = stays.table;
    run([stays], at + STEP, at + 5_000, { step: STEP });
    // A stale page puts the close back 5 s on, and X's seed comes: round 1 decided on its seeds.
    const T = at + 5_000;
    vi.setSystemTime(T);
    const xr = kit.reveal(1, X.pid);
    putIn(stays, [[close.key, close.rec], [xr.key, xr.rec]]);
    expect(foldOf(stays).rounds[0].decided).toBe('reveals');
    // Round 2: stays bets, X closes over both at once, stays' seed goes out,
    // and X's close is deleted: stays stands down again, ABANDON_MS from then.
    const open2 = run([stays], T + STEP, T + 30_000, {
      step: STEP, until: () => foldOf(stays).open === 2 && phaseOf(stays)?.phase === 'betting',
    });
    expect(stays.table.writeComputedSlip(TABLE, [red(30)], open2)).toBe('ok');
    const xs2 = kit.slip(X, 2, [black(8)]);
    const c2 = kit.close(X, 2, foldOf(stays).parent, { [stays.pid]: foldOf(stays).felts.get(stays.pid)!.hash, [X.pid]: xs2.hash });
    putIn(stays, entries([xs2, c2]));
    frame(open2 + STEP, stays);
    expect(foldOf(stays).tip!.revealed).toEqual([stays.pid]);
    const T2 = open2 + 2 * STEP;
    vi.setSystemTime(T2);
    deleteIn(stays, [c2.key]);
    const closedAt = run([stays], T2 + STEP, T2 + 90_000, { step: STEP, until: () => keysIn(stays, 'c', 2).length > 0 });
    const idx = placeOf(stays, 'close', 2, [stays.pub, X.pub], stays.pub);
    expectAt(closedAt, T2 + STEP + ABANDON_MS + idx * STAGGER_MS);
  });
});

/** Pages `names` (and test players `fakes`, their slips by hand, their seeds
 *  never) bet on round 1; it closes, every page's seed goes out, and every
 *  page shows the result. The round, and when. */
async function shown(names: string[], fakes: TestIdentity[] = []) {
  const pages = await room(names);
  for (const p of pages) pinOn(p, ...fakes);
  for (const id of fakes) pages[0].casino.buyInChips(id.pid, 1_000);
  for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
  const slips = fakes.map((id) => kit.slip(id, 1, [black(7)]));
  if (slips.length) putIn(pages[0], entries(slips));
  sync(T0, ...pages);
  const at = settle(pages, T0 + STEP);
  return { pages, round: foldOf(pages[0]).rounds[0], at };
}

/**
 * A griefer deletes `keys` from the session (or writes junk over them) at
 * T, the pages of `live` running on, the author away: the first of them in
 * turn among the round's bettors (`pubs`, by dutyRank 'forfeit') puts them
 * back byte for byte, REPUT_MS + (1 + its place) × STAGGER_MS after its next
 * frame saw them gone; and every player's chips end where they were.
 */
function putBack(live: Page[], keys: string[], T: number, opts: { pids: string[]; pubs: string[]; junk?: boolean }): void {
  const { REPUT_MS, STAGGER_MS } = live[0].table;
  const bytes = keys.map((k) => bytesOf(live[0], k));
  const chips = live.map((p) => chipsOf(p, opts.pids));
  vi.setSystemTime(T);
  if (opts.junk) putIn(live[0], keys.map((k): [string, unknown] => [k, 'junk']));
  else deleteIn(live[0], keys);
  sync(T, ...live);
  const held = (): boolean => live.every((p) => keys.every((k, i) => bytesOf(p, k) === bytes[i]));
  expect(held()).toBe(false);
  const back = run(live, T + STEP, T + 20_000, { step: STEP, until: held });
  const first = Math.min(...live.map((p) => placeOf(p, 'forfeit', 1, opts.pubs, p.pub)));
  expectAt(back, T + STEP + REPUT_MS + (1 + first) * STAGGER_MS);
  run(live, back + STEP, back + 10_000, { step: STEP });
  for (const [i, p] of live.entries()) expect(chipsOf(p, opts.pids)).toEqual(chips[i]);
}

describe('a witness', () => {
  it('puts back the close of a round it played, its author gone', async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const witness = pages.find((p) => p.pub !== round.closeRec.k)!;
    putBack([witness], [`c:1:${round.close}`], at + 1_000, { pids: pages.map((p) => p.pid), pubs: pages.map((p) => p.pub) });
    expect(foldOf(witness).rounds[0]).toMatchObject({ close: round.close, decided: 'reveals', pocket: round.pocket });
  });

  it("puts back a departed bettor's frozen slip, and forfeits nothing meanwhile", async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const witness = pages.find((p) => p.pub === round.closeRec.k)!;
    const gone = pages.find((p) => p !== witness)!;
    putBack([witness], [`s:1:${gone.pid}:${round.frozen[gone.pid]}`], at + 1_000, {
      pids: pages.map((p) => p.pid), pubs: pages.map((p) => p.pub),
    });
    expect(foldOf(witness).rounds[0]).toMatchObject({ decided: 'reveals', counted: round.counted, pocket: round.pocket });
    expect(keysIn(witness, 'f', 1)).toEqual([]);
  });

  it("puts back a departed bettor's counted seed", async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const witness = pages.find((p) => p.pub === round.closeRec.k)!;
    const gone = pages.find((p) => p !== witness)!;
    putBack([witness], [revealOf(witness, 1, gone.pid)], at + 1_000, { pids: pages.map((p) => p.pid), pubs: pages.map((p) => p.pub) });
    expect(foldOf(witness).rounds[0]).toMatchObject({ decided: 'reveals', counted: round.counted, pocket: round.pocket });
  });

  it('puts back the forfeit that decided it', async () => {
    const X = testIdentity('x', 'player-X'); // never reveals
    const { pages, round, at } = await shown(['A', 'B'], [X]);
    expect(round.decided).toBe('forfeit');
    const witness = pages.find((p) => p.pub !== round.forfeit!.rec.k)!;
    putBack([witness], [`f:1:${round.forfeit!.hash}`], at + 1_000, {
      pids: [...pages.map((p) => p.pid), X.pid], pubs: [...pages.map((p) => p.pub), X.pub],
    });
    expect(foldOf(witness).rounds[0]).toMatchObject({ decided: 'forfeit', counted: round.counted, pocket: round.pocket });
    expect(forfeitsOf(witness, 1)).toEqual([round.forfeit!.rec]);
  });

  it('puts back the abandon that voided it', async () => {
    const X = testIdentity('x', 'player-X');
    const [a, b] = await room(['A', 'B']);
    for (const p of [a, b]) pinOn(p, X);
    a.casino.buyInChips(X.pid, 1_000);
    // B's felt, signed by its key on a seed its page doesn't hold (its seed
    // store gone, as after a reload): it can't reveal it, nor forfeit.
    const bs = signAs(b, 'slip', { r: 1, p: b.pid, v: 1, b: [red(10)], c: kit.commit(1, b.pid, kit.seed(b.pid, 1)) });
    const bsKey = b.fold.slipKey(bs)!;
    const xs = kit.slip(X, 1, [black(7)]);
    putIn(b, [[bsKey, bs], [xs.key, xs.rec]]);
    // A only watches, seated: it may void the round.
    a.casino.writeMySeat(TABLE, a.pid, { stand: 2, angle: 1, at: 1 });
    sync(T0, a, b);
    const close = kit.close(X, 1, foldOf(b).parent, { [b.pid]: bsKey.split(':')[3], [X.pid]: xs.hash });
    putIn(b, [[close.key, close.rec]]);
    sync(T0, a, b);
    const at = settle([a, b], T0 + STEP, T0 + 90_000);
    const round = foldOf(b).rounds[0];
    expect(round.decided).toBe('void');
    expect(round.abandon!.rec.k).toBe(a.pub);
    putBack([b], [`z:1:${round.abandon!.hash}`], at + 1_000, { pids: [a.pid, b.pid, X.pid], pubs: [b.pub, X.pub] });
    expect(foldOf(b).rounds[0]).toMatchObject({ decided: 'void', abandon: { hash: round.abandon!.hash } });
  });

  it('replaces junk written over a record it counted', async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const witness = pages.find((p) => p.pub !== round.closeRec.k)!;
    putBack([witness], [`c:1:${round.close}`], at + 1_000, { pids: pages.map((p) => p.pid), pubs: pages.map((p) => p.pub), junk: true });
    expect(foldOf(witness).rounds[0]).toMatchObject({ close: round.close, decided: 'reveals' });
  });

  it('leaves its author to go first: the author back within REPUT_MS, the witness writes nothing', async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const { REPUT_MS } = pages[0].table;
    const witness = pages.find((p) => p.pub === round.closeRec.k)!;
    const author = pages.find((p) => p !== witness)!;
    const key = `s:1:${author.pid}:${round.frozen[author.pid]}`;
    const bytes = bytesOf(witness, key);
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(witness, [key]);
    sync(T, ...pages);
    let back = -1;
    let writes = 0;
    for (let t = T + STEP; t <= T + 10_000; t += STEP) {
      sync(t, ...pages);
      writes += localWrites(witness, () => frame(t, witness));
      frame(t, author);
      sync(t, ...pages);
      if (back < 0 && bytesOf(witness, key) === bytes) back = t;
    }
    expect(back).toBeGreaterThan(T);
    expect(back).toBeLessThanOrEqual(T + REPUT_MS);
    expect(writes).toBe(0);
    expect(foldOf(witness).rounds[0]).toMatchObject({ decided: 'reveals', counted: round.counted });
  });

  it('takes turns: the second in line stands down once the first one’s copy is in', async () => {
    const { pages, round, at } = await shown(['A', 'B', 'C']);
    const { REPUT_MS, STAGGER_MS } = pages[0].table;
    const [gone, ...live] = pages;
    const pubs = pages.map((p) => p.pub);
    const [first, second] = [...live].sort((x, y) => placeOf(x, 'forfeit', 1, pubs, x.pub) - placeOf(y, 'forfeit', 1, pubs, y.pub));
    const key = revealOf(first, 1, gone.pid);
    const bytes = bytesOf(first, key);
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(first, [key]);
    sync(T, ...live);
    const writes = new Map(live.map((p) => [p, 0]));
    let back = -1;
    for (let t = T + STEP; t <= T + 15_000; t += STEP) {
      sync(t, ...live);
      for (const p of live) writes.set(p, writes.get(p)! + localWrites(p, () => frame(t, p)));
      sync(t, ...live);
      if (back < 0 && live.every((p) => bytesOf(p, key) === bytes)) back = t;
    }
    expectAt(back, T + STEP + REPUT_MS + (1 + placeOf(first, 'forfeit', 1, pubs, first.pub)) * STAGGER_MS);
    expect(writes.get(first)).toBe(1);
    expect(writes.get(second)).toBe(0);
    for (const p of live) expect(foldOf(p).rounds[0]).toMatchObject({ decided: 'reveals', counted: round.counted });
  });

  it('writes nothing for a round it did not play', async () => {
    const pages = await room(['A', 'B', 'W']);
    const [a, b, w] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(11)], T0)).toBe('ok');
    sync(T0, ...pages);
    const at = settle(pages, T0 + STEP);
    // A and B leave; a griefer deletes A's seed: W saw it counted, but played no part.
    const key = revealOf(w, 1, a.pid);
    vi.setSystemTime(at + 1_000);
    deleteIn(w, [key]);
    let writes = 0;
    for (let t = at + 1_000 + STEP; t <= at + 15_000; t += STEP) writes += localWrites(w, () => frame(t, w));
    expect(writes).toBe(0);
    expect(keysIn(w, 'x', 1)).not.toContain(key);
  });

  it('writes nothing once a trim has made the round final: its copies go with it', async () => {
    const { pages, at } = await shown(['A', 'B']);
    const T = at + 1_000;
    vi.setSystemTime(T);
    trimByHand(pages[0], testIdentity('trimmer'));
    sync(T, ...pages);
    expect(foldOf(pages[1]).base.u).toBe(1);
    let writes = 0;
    for (let t = T + STEP; t <= T + 15_000; t += STEP) {
      sync(t, ...pages);
      for (const p of pages) writes += localWrites(p, () => frame(t, p));
      sync(t, ...pages);
    }
    expect(writes).toBe(0);
    for (const p of pages) for (const kind of ['s', 'c', 'x']) expect(keysIn(p, kind, 1)).toEqual([]);
  });

  it('writes nothing on a doc holding part of an update; once whole, in its turn from then', async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const { REPUT_MS, STAGGER_MS } = pages[0].table;
    const [gone, w] = pages;
    // Two writes of gone's just before it left; w hears the later only.
    const [early, late] = updatesOf(gone, () => {
      gone.doc.getMap('casino').set(`seat:${TABLE}:${gone.pid}`, { stand: 0, angle: 0, at: 1 });
      gone.doc.getMap('casino').set(`seat:${TABLE}:${gone.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    deliver(at, w, [late]);
    const key = revealOf(w, 1, gone.pid);
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(w, [key]);
    for (let t = T + STEP; t <= T + 10_000; t += STEP) frame(t, w);
    expect(keysIn(w, 'x', 1)).not.toContain(key);
    deliver(T + 10_000, w, [early]);
    const back = run([w], T + 10_000 + STEP, T + 30_000, { step: STEP, until: () => keysIn(w, 'x', 1).includes(key) });
    const idx = placeOf(w, 'forfeit', 1, pages.map((p) => p.pub), w.pub);
    expectAt(back, T + 10_000 + STEP + REPUT_MS + (1 + idx) * STAGGER_MS);
    expect(foldOf(w).rounds[0]).toMatchObject({ decided: 'reveals', counted: round.counted });
  });

  it('writes nothing on a doc that holds part of an update by its turn; at once when whole again', async () => {
    const { pages, at } = await shown(['A', 'B']);
    const [gone, w] = pages;
    const [early, late] = updatesOf(gone, () => {
      gone.doc.getMap('casino').set(`seat:${TABLE}:${gone.pid}`, { stand: 0, angle: 0, at: 1 });
      gone.doc.getMap('casino').set(`seat:${TABLE}:${gone.pid}`, { stand: 1, angle: 0, at: 2 });
    });
    const key = revealOf(w, 1, gone.pid);
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(w, [key]);
    // w sees it gone on a whole doc; then hears only the later of gone's two
    // writes, before its turn comes.
    frame(T + STEP, w);
    deliver(T + STEP, w, [late]);
    for (let t = T + 2 * STEP; t <= T + 10_000; t += STEP) frame(t, w);
    expect(keysIn(w, 'x', 1)).not.toContain(key);
    deliver(T + 10_000, w, [early]);
    const back = run([w], T + 10_000 + STEP, T + 30_000, { step: STEP, until: () => keysIn(w, 'x', 1).includes(key) });
    expectAt(back, T + 10_000 + STEP);
  });

  it('writes nothing asleep: a wait that spanned a sleep starts again once awake', async () => {
    const { pages, at } = await shown(['A', 'B']);
    const { REPUT_MS, STAGGER_MS } = pages[0].table;
    const [gone, w] = pages;
    const key = revealOf(w, 1, gone.pid);
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(w, [key]);
    // w sees it gone, then sleeps before its turn.
    run([w], T + STEP, T + 1_000, { step: STEP });
    expect(keysIn(w, 'x', 1)).not.toContain(key);
    const woke = T + 8_000;
    const back = run([w], woke, woke + 30_000, { step: STEP, until: () => keysIn(w, 'x', 1).includes(key) });
    expect(w.croupier.tablesWakeCount()).toBe(1);
    const idx = placeOf(w, 'forfeit', 1, pages.map((p) => p.pub), w.pub);
    expectAt(back, woke + TABLE_LEASE_LAPSE_MS + REPUT_MS + (1 + idx) * STAGGER_MS);
  });

  it('marks what it puts back as checked: a session map a peer replaced comes back whole, nothing of it checked again', async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const [gone, w] = pages;
    const pids = pages.map((p) => p.pid);
    const chips = chipsOf(w, pids);
    const checked: string[] = [];
    w.casino.setComputedVerifyForTests({ verify: (pub) => { checked.push(pub); return true; }, now: () => 0 });
    const T = at + 1_000;
    vi.setSystemTime(T);
    w.doc.transact(() => w.doc.getMap('casinoComputed').set(`ses:${TABLE}:${INC}:g`, new Y.Map()));
    expect(foldOf(w).rounds).toEqual([]);
    run([w], T + STEP, T + 15_000, { step: STEP });
    expect(foldOf(w).rounds[0]).toMatchObject({ close: round.close, decided: 'reveals', counted: round.counted });
    expect(bytesOf(w, `c:1:${round.close}`)).toBe(JSON.stringify(round.closeRec));
    expect(keysIn(w, 'x', 1)).toContain(revealOf(w, 1, gone.pid));
    expect(chipsOf(w, pids)).toEqual(chips);
    expect(checked).toEqual([]);
  });

  it('forfeits nothing and answers nothing of a round it showed while what decided it is gone', async () => {
    // Test players: A wrote the deciding forfeit and has left; W wrote a
    // forfeit that dropped seeds, ranked after A and B (B would answer it);
    // X never reveals. (B's page drawn again while no W fits.)
    const A = testIdentity('a', 'player-A');
    let b: Page;
    let W: TestIdentity | null;
    do {
      [b] = await room(['B']);
      const rank = (k: string): string => b.fold.dutyRank('forfeit', CTX, 1, k);
      W = firstFit('w', 'player-W', (id) => rank(id.pub) > rank(A.pub) && rank(id.pub) > rank(b.pub));
    } while (!W);
    const X = testIdentity('x', 'player-X');
    pinOn(b, A, W, X);
    for (const id of [A, W, X]) b.casino.buyInChips(id.pid, 1_000);
    expect(b.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    const own = foldOf(b).felts.get(b.pid)!;
    const [sa, sw, sx] = [A, W, X].map((id) => kit.slip(id, 1, [black(5)]));
    const close = kit.close(A, 1, foldOf(b).parent, { [b.pid]: own.hash, [A.pid]: sa.hash, [W.pid]: sw.hash, [X.pid]: sx.hash });
    vi.setSystemTime(T0 + 1_000);
    putIn(b, entries([sa, sw, sx, close]));
    frame(T0 + 1_000 + STEP, b);
    vi.setSystemTime(T0 + 1_400);
    putIn(b, entries([kit.reveal(1, A.pid), kit.reveal(1, W.pid)]));
    const F = kit.forfeit(A, 1, close.hash, [A.pid, b.pid, W.pid]);
    const F2 = kit.forfeit(W, 1, close.hash, [W.pid]);
    vi.setSystemTime(T0 + 3_000);
    putIn(b, entries([F]));
    vi.setSystemTime(T0 + 3_500);
    putIn(b, entries([F2]));
    const at = settle([b], T0 + 3_600, T0 + 30_000);
    expect(foldOf(b).rounds[0]).toMatchObject({ decided: 'forfeit', forfeit: { hash: F.hash } });
    const pids = [b.pid, A.pid, W.pid, X.pid];
    putBack([b], [F.key], at + 1_000, { pids, pubs: [b.pub, A.pub, W.pub, X.pub] });
    expect(foldOf(b).rounds[0]).toMatchObject({ decided: 'forfeit', forfeit: { hash: F.hash } });
    expect(forfeitsOf(b, 1).filter((f) => f.k === b.pub)).toEqual([]);
  });

  it('voids nothing of a round it showed while it waits its turn, though the delete comes ABANDON_MS after the close', async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const { ABANDON_MS, REPUT_MS, STAGGER_MS } = pages[0].table;
    const witness = pages.find((p) => p.pub === round.closeRec.k)!;
    const gone = pages.find((p) => p !== witness)!;
    const pids = pages.map((p) => p.pid);
    const chips = chipsOf(witness, pids);
    // The witness runs on alone; ABANDON_MS on (before any idle trim) a
    // griefer deletes gone's frozen slip: the round reads undecided, its
    // abandon long due.
    const T = at + ABANDON_MS;
    run([witness], at + STEP, T - STEP, { step: STEP });
    expect(foldOf(witness).base.u).toBe(0);
    const key = `s:1:${gone.pid}:${round.frozen[gone.pid]}`;
    const bytes = bytesOf(witness, key);
    vi.setSystemTime(T);
    deleteIn(witness, [key]);
    expect(foldOf(witness).tip).not.toBeNull();
    const ses = witness.casino.computedSessionForWrite(TABLE)!;
    const wrote: string[] = [];
    const mark = (e: Y.YMapEvent<unknown>, tr: Y.Transaction): void => {
      if (tr.local) wrote.push(...e.keysChanged);
    };
    ses.observe(mark);
    const phases = new Set<string>();
    let back = -1;
    for (let t = T + STEP; t <= T + 10_000; t += STEP) {
      frame(t, witness);
      const v = phaseOf(witness, t)!;
      phases.add(`${v.phase}${v.voided ? ':void' : ''}`);
      if (back < 0 && bytesOf(witness, key) === bytes) back = t;
    }
    ses.unobserve(mark);
    expectAt(back, T + STEP + REPUT_MS + (1 + placeOf(witness, 'forfeit', 1, pages.map((p) => p.pub), witness.pub)) * STAGGER_MS);
    // Only the put-back: no abandon, the result never read void.
    expect(wrote).toEqual([key]);
    expect(keysIn(witness, 'z', 1)).toEqual([]);
    expect(phases.has('settled:void')).toBe(false);
    expect(foldOf(witness).rounds[0]).toMatchObject({ close: round.close, decided: 'reveals', pocket: round.pocket });
    expect(chipsOf(witness, pids)).toEqual(chips);
  });

  it("puts back a departed bettor's frozen slip deleted while a forfeit's result waits to show, and voids nothing meanwhile", async () => {
    // W alone with test players: A bets, reveals and leaves; G bets and never
    // reveals. W ranks first to forfeit, so its forfeit's result waits a
    // second past the grace (the forfeit's hold).
    let found: { w: Page; A: TestIdentity; G: TestIdentity } | null = null;
    while (!found) {
      const [w] = await room(['W']);
      const rank = (k: string): string => w.fold.dutyRank('forfeit', CTX, 1, k);
      const after = (name: string, pid: string): TestIdentity | undefined => {
        for (let i = 0; i < 20; i++) {
          const id = testIdentity(`${name}${i}`, pid);
          if (rank(id.pub) > rank(w.pub)) return id;
        }
        return undefined;
      };
      const A = after('a', 'player-A');
      const G = after('g', 'player-G');
      if (A && G) found = { w, A, G };
    }
    const { w, A, G } = found;
    const { ABANDON_MS } = w.table;
    pinOn(w, A, G);
    w.casino.buyInChips(A.pid, 1_000);
    w.casino.buyInChips(G.pid, 1_000);
    expect(w.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    putIn(w, entries([kit.slip(A, 1, [black(50)]), kit.slip(G, 1, [red(30)])]));
    // W closes in its turn; A's seed comes with W's.
    const closedAt = run([w], T0 + STEP, T0 + 60_000, { step: STEP, until: () => keysIn(w, 'c', 1).length > 0 });
    vi.setSystemTime(closedAt + 100);
    putIn(w, entries([kit.reveal(1, A.pid)]));
    // W forfeits G at the end of the grace: decided, A and W counted, the
    // chips moved, the result still held.
    const decidedAt = run([w], closedAt + STEP, closedAt + 30_000, { step: STEP, until: () => foldOf(w).rounds[0]?.decided != null });
    const D = foldOf(w).rounds[0];
    expect(D).toMatchObject({ decided: 'forfeit', counted: [A.pid, w.pid].sort() });
    expect(phaseOf(w, decidedAt)?.phase).toBe('closing');
    // G deletes A's frozen slip: W's forfeit no longer stands (A isn't in the
    // round), W writes no other, and only an abandon could decide it; W puts
    // the slip back in its turn, and the round reads as it was.
    const pids = [A.pid, w.pid, G.pid];
    putBack([w], [`s:1:${A.pid}:${D.frozen[A.pid]}`], decidedAt + STEP, { pids, pubs: [A.pub, w.pub, G.pub] });
    const chips = chipsOf(w, pids);
    run([w], decidedAt + 10_000, closedAt + ABANDON_MS + 10_000, { step: STEP });
    expect(foldOf(w).rounds[0]).toMatchObject({ close: D.close, decided: 'forfeit', counted: D.counted, pocket: D.pocket });
    expect(keysIn(w, 'z', 1)).toEqual([]);
    expect(forfeitsOf(w, 1)).toHaveLength(1);
    expect(chipsOf(w, pids)).toEqual(chips);
  });

  it('holds a trim back while a record a round rests on is gone: the round goes into the checkpoint as it was', async () => {
    const pages = await room(['A', 'B']);
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const open2 = run(pages, T0 + STEP, T0 + 60_000, {
      step: STEP, until: () => pages.every((p) => foldOf(p).open === 2 && phaseOf(p)?.phase === 'betting'),
    });
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [black(20 + i)], open2)).toBe('ok');
    sync(open2, ...pages);
    const at = settle(pages, open2 + STEP);
    const r2 = foldOf(pages[0]).rounds[1];
    const w = pages.find((p) => p.pub !== r2.closeRec.k)!;
    const pids = pages.map((p) => p.pid);
    const chips = chipsOf(w, pids);
    // Round 2's closer is gone; a griefer deletes its close and makes the
    // session heavy in one go: round 1 would do for a checkpoint.
    const T = at + 1_000;
    vi.setSystemTime(T);
    const ses = w.casino.computedSessionForWrite(TABLE)!;
    w.doc.transact(() => {
      ses.delete(`c:2:${r2.close}`);
      ses.set('junk', 'x'.repeat(w.table.TRIM_BYTES));
    });
    expect(foldOf(w).rounds.map((v) => v.r)).toEqual([1]);
    const trimmed = run([w], T + STEP, T + 30_000, { step: STEP, until: () => foldOf(w).base.u > 0 });
    expect(trimmed).toBeLessThan(T + 30_000);
    expect(foldOf(w).base).toMatchObject({ u: 2, l: r2.close });
    expect(chipsOf(w, pids)).toEqual(chips);
  });
});

describe("a witness's copies", () => {
  it('go once their round lost to a rival chain outright, nothing of it missing: nothing of it comes back', async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const w = pages.find((p) => p.pub !== round.closeRec.k)!;
    // A rival chain two rounds long, by test player Y alone, outgrows round 1's close.
    const Y = testIdentity('y', 'player-Y');
    pinOn(w, Y);
    w.casino.buyInChips(Y.pid, 1_000);
    const y1 = kit.slip(Y, 1, [red(3)]);
    const c1 = kit.close(Y, 1, foldOf(w).base.sid, [y1]);
    const y2 = kit.slip(Y, 2, [red(4)]);
    const c2 = kit.close(Y, 2, c1.hash, [y2]);
    const T = at + 1_000;
    vi.setSystemTime(T);
    putIn(w, entries([y1, c1, kit.reveal(1, Y.pid), y2, c2, kit.reveal(2, Y.pid)]));
    expect(foldOf(w).rounds.map((v) => v.close)).toEqual([c1.hash, c2.hash]);
    run([w], T + STEP, T + 2_000, { step: STEP });
    // The old close's author is gone, and a griefer deletes it.
    vi.setSystemTime(T + 2_000);
    deleteIn(w, [`c:1:${round.close}`]);
    let writes = 0;
    for (let t = T + 2_000 + STEP; t <= T + 15_000; t += STEP) writes += localWrites(w, () => frame(t, w));
    expect(writes).toBe(0);
    expect(keysIn(w, 'c', 1)).toEqual([c1.key]);
  });

  it('put a record two rival rounds rest on back once', async () => {
    // A rival close of round 1 by test player Y, ranked ahead, freezing the
    // same two slips and its own: decided on the same seeds and Y's, it takes
    // the chain. Y in turn after w, so w's turn is one for both rounds. (The
    // room drawn again while no Y fits.)
    let drawn: Awaited<ReturnType<typeof shown>>;
    let w: Page;
    let Y: TestIdentity | null;
    do {
      drawn = await shown(['A', 'B']);
      const { pages, round } = drawn;
      w = pages.find((p) => p.pub !== round.closeRec.k)!;
      const rank = (duty: 'close' | 'forfeit', k: string): string => w.fold.dutyRank(duty, CTX, 1, k);
      Y = firstFit('y', 'player-Y', (id) => rank('close', id.pub) < rank('close', round.closeRec.k) && rank('forfeit', id.pub) > rank('forfeit', w.pub));
    } while (!Y);
    const { pages, round, at } = drawn;
    const gone = pages.find((p) => p !== w)!;
    pinOn(w, Y);
    w.casino.buyInChips(Y.pid, 1_000);
    const y1 = kit.slip(Y, 1, [red(3)]);
    const rival = kit.close(Y, 1, foldOf(w).base.sid, { ...round.frozen, [Y.pid]: y1.hash });
    const T = at + 1_000;
    vi.setSystemTime(T);
    // As it comes, a griefer deletes round 1's close (its author gone): w
    // keeps its copies of both rounds, the old one's close missing.
    putIn(w, entries([y1, rival, kit.reveal(1, Y.pid)]));
    deleteIn(w, [`c:1:${round.close}`]);
    expect(foldOf(w).rounds.map((v) => [v.close, v.decided])).toEqual([[rival.hash, 'reveals']]);
    frame(T + STEP, w);
    // And gone's frozen slip a moment later, which both rest on: each record
    // goes back once, the slip for both rounds in one write.
    const key = `s:1:${gone.pid}:${round.frozen[gone.pid]}`;
    const bytes = bytesOf(w, key);
    vi.setSystemTime(T + 2 * STEP);
    deleteIn(w, [key]);
    let writes = 0;
    for (let t = T + 3 * STEP; t <= T + 15_000; t += STEP) writes += localWrites(w, () => frame(t, w));
    expect(writes).toBe(2);
    expect(bytesOf(w, key)).toBe(bytes);
    expect(keysIn(w, 'c', 1)).toContain(`c:1:${round.close}`);
    expect(foldOf(w).rounds.map((v) => [v.close, v.decided])).toEqual([[rival.hash, 'reveals']]);
  });

  it("go once all that's missing is this page's own, a felt its re-put lets go of: it stays gone, and the trim comes", async () => {
    const { pages, round, at } = await shown(['A', 'B']);
    const [w, gone] = pages;
    const Y = testIdentity('y', 'player-Y');
    pinOn(w, Y);
    w.casino.buyInChips(Y.pid, 1_000);
    const y1 = kit.slip(Y, 1, [red(3)]);
    const c1 = kit.close(Y, 1, foldOf(w).base.sid, [y1]);
    const y2 = kit.slip(Y, 2, [red(4)]);
    const c2 = kit.close(Y, 2, c1.hash, [y2]);
    const own = `s:1:${w.pid}:${round.frozen[w.pid]}`;
    const theirs = `s:1:${gone.pid}:${round.frozen[gone.pid]}`;
    const bytes = bytesOf(w, theirs);
    // A griefer deletes both frozen slips of round 1 as a rival chain comes
    // in: gone's goes back (w's copy), but w's own, a burned felt now off
    // the chain, is its re-put's to let go of, and stays gone.
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(w, [own, theirs]);
    putIn(w, entries([y1, c1, kit.reveal(1, Y.pid), y2, c2, kit.reveal(2, Y.pid)]));
    expect(foldOf(w).rounds.map((v) => v.close)).toEqual([c1.hash, c2.hash]);
    let writes = 0;
    for (let t = T + STEP; t <= T + 15_000; t += STEP) writes += localWrites(w, () => frame(t, w));
    expect(writes).toBe(1);
    expect(bytesOf(w, theirs)).toBe(bytes);
    expect(keysIn(w, 's', 1)).not.toContain(own);
    // Its copies gone, nothing holds the trim back: it comes after the
    // fallback's wait (w played no part in the rival chain).
    const trimmed = run([w], T + 15_000 + STEP, T + 300_000, { step: 1_000, until: () => foldOf(w).base.u > 0 });
    expect(trimmed).toBeLessThan(T + 300_000);
    expect(foldOf(w).base).toMatchObject({ u: 2, l: c2.hash });
  });

  it('stay while anything it keeps is missing: a round off the chain because of a delete comes back whole', async () => {
    // A closes both rounds and leaves; W plays both. A rival close of round
    // 1 by test player Y, ranked ahead of A's. (Drawn again till both hold.)
    let pages: Page[];
    let Y: TestIdentity | null = null;
    do {
      pages = await room(['A', 'W']);
      if (byRank(pages, 'close', 1)[0] !== pages[0] || byRank(pages, 'close', 2)[0] !== pages[0]) continue;
      const rank = (k: string): string => pages[1].fold.dutyRank('close', CTX, 1, k);
      Y = firstFit('y', 'player-Y', (id) => rank(id.pub) < rank(pages[0].pub));
    } while (!Y);
    const [a, w] = pages;
    for (const p of pages) pinOn(p, Y);
    a.casino.buyInChips(Y.pid, 1_000);
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const open2 = run(pages, T0 + STEP, T0 + 60_000, {
      step: STEP, until: () => pages.every((p) => foldOf(p).open === 2 && phaseOf(p)?.phase === 'betting'),
    });
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [black(20 + i)], open2)).toBe('ok');
    sync(open2, ...pages);
    const at = settle(pages, open2 + STEP);
    const [r1, r2] = foldOf(w).rounds;
    expect([r1.closeRec.k, r2.closeRec.k]).toEqual([a.pub, a.pub]);
    const y1 = kit.slip(Y, 1, [red(3)]);
    const rival = kit.close(Y, 1, foldOf(w).base.sid, [y1]);
    vi.setSystemTime(at);
    putIn(w, entries([y1, rival, kit.reveal(1, Y.pid)]));
    expect(foldOf(w).rounds.map((v) => v.close)).toEqual([r1.close, r2.close]);
    const pids = [a.pid, w.pid, Y.pid];
    const chips = chipsOf(w, pids);
    // A gone, a griefer deletes round 2's close: the rival, ranked first, takes round 1.
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(w, [`c:2:${r2.close}`]);
    expect(foldOf(w).rounds.map((v) => v.close)).toEqual([rival.hash]);
    frame(T + STEP, w);
    // And round 1's close a moment later.
    vi.setSystemTime(T + 2 * STEP);
    deleteIn(w, [`c:1:${r1.close}`]);
    run([w], T + 2 * STEP, T + 20_000, { step: STEP });
    expect(foldOf(w).rounds.map((v) => v.close)).toEqual([r1.close, r2.close]);
    expect(chipsOf(w, pids)).toEqual(chips);
  });

  it('stay for a round off the chain because a round before it is gone, which this page did not play', async () => {
    // A plays both rounds and leaves; B plays round 1, W round 2.
    const pages = await room(['A', 'B', 'W']);
    const [a, b, w] = pages;
    expect(a.table.writeComputedSlip(TABLE, [red(10)], T0)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [red(11)], T0)).toBe('ok');
    sync(T0, ...pages);
    const open2 = run(pages, T0 + STEP, T0 + 60_000, {
      step: STEP, until: () => pages.every((p) => foldOf(p).open === 2 && phaseOf(p)?.phase === 'betting'),
    });
    expect(a.table.writeComputedSlip(TABLE, [black(20)], open2)).toBe('ok');
    expect(w.table.writeComputedSlip(TABLE, [black(21)], open2)).toBe('ok');
    sync(open2, ...pages);
    const at = settle(pages, open2 + STEP);
    const [r1, r2] = foldOf(w).rounds;
    const live = [b, w];
    const pids = pages.map((p) => p.pid);
    const chips = chipsOf(w, pids);
    // A gone, a griefer deletes round 1's close (B puts it back: W keeps no
    // copy of it), then A's frozen slip of round 2 (W's to put back).
    const T = at + 1_000;
    vi.setSystemTime(T);
    deleteIn(w, [`c:1:${r1.close}`]);
    sync(T, ...live);
    run(live, T + STEP, T + STEP, { step: STEP });
    vi.setSystemTime(T + 2 * STEP);
    deleteIn(w, [`s:2:${a.pid}:${r2.frozen[a.pid]}`]);
    run(live, T + 2 * STEP, T + 25_000, { step: STEP });
    for (const p of live) {
      expect(foldOf(p).rounds.map((v) => [v.close, v.decided])).toEqual([[r1.close, 'reveals'], [r2.close, 'reveals']]);
      expect(chipsOf(p, pids)).toEqual(chips);
    }
  });
});

describe('a round a delete took off the chain, seen played', () => {
  /** A, B and W play round 1; A and B round 2, W watching; every page shows
   *  round 2's result. Then round 2's closer is gone, and a griefer deletes
   *  its close (and with `own`, the witness's frozen slip of it) and makes
   *  the session heavy in one go: to W, round 1 would do for a checkpoint
   *  (it played it), and W keeps no copy of round 2. */
  async function cut(opts: { own?: boolean } = {}) {
    const pages = await room(['A', 'B', 'W']);
    const [a, b, w] = pages;
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const open2 = run(pages, T0 + STEP, T0 + 60_000, {
      step: STEP, until: () => pages.every((p) => foldOf(p).open === 2 && phaseOf(p)?.phase === 'betting'),
    });
    const pids = pages.map((p) => p.pid);
    const afterRound1 = chipsOf(w, pids);
    expect(a.table.writeComputedSlip(TABLE, [black(20)], open2)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(21)], open2)).toBe('ok');
    sync(open2, ...pages);
    const at = settle(pages, open2 + STEP);
    const r2 = foldOf(w).rounds[1];
    expect(r2.decided).toBe('reveals');
    const witness = [a, b].find((p) => p.pub !== r2.closeRec.k)!;
    const live = [witness, w];
    const chips = live.map((p) => chipsOf(p, pids));
    const T = at + 1_000;
    vi.setSystemTime(T);
    const ses = w.casino.computedSessionForWrite(TABLE)!;
    w.doc.transact(() => {
      ses.delete(`c:2:${r2.close}`);
      if (opts.own) ses.delete(`s:2:${witness.pid}:${r2.frozen[witness.pid]}`);
      ses.set('junk', 'x'.repeat(w.table.TRIM_BYTES));
    });
    sync(T, ...live);
    expect(foldOf(w).rounds.map((v) => v.r)).toEqual([1]);
    return { w, witness, live, pids, r2, chips, afterRound1, T };
  }

  it("is trimmed past by no page that only watched it while its witness puts it back: it goes into the checkpoint as it was", async () => {
    const { w, live, pids, r2, chips, T } = await cut();
    const trimmed = run(live, T + STEP, T + 30_000, { step: STEP, until: () => live.every((p) => foldOf(p).base.u > 0) });
    expect(trimmed).toBeLessThan(T + w.table.MISSING_WAIT_MS);
    for (const [i, p] of live.entries()) {
      expect(foldOf(p).base).toMatchObject({ u: 2, l: r2.close });
      expect(chipsOf(p, pids)).toEqual(chips[i]);
    }
  });

  it("is trimmed past MISSING_WAIT_MS on, its witness away; the witness, back, lets go of what it wrote of it: its felt isn't played again", async () => {
    const { w, witness, live, pids, afterRound1, T } = await cut();
    // The witness sees the round go (it holds its trim back), then is away
    // before its turn comes; W, alone, waits for the round to come back.
    run(live, T + STEP, T + STEP, { step: STEP });
    const trimmed = run([w], T + 2 * STEP, T + 60_000, { step: STEP, until: () => foldOf(w).base.u > 0 });
    expectAt(trimmed, T + STEP + w.table.MISSING_WAIT_MS);
    expect(foldOf(w).base.u).toBe(1);
    // Back, the witness hears the trim: round 2 is void, its stakes back,
    // and nothing of it goes into the new session.
    sync(trimmed, ...live);
    expect(foldOf(witness).base.u).toBe(1);
    const wrote: string[] = [];
    witness.casino.computedSessionForWrite(TABLE)!.observe((e, tr) => {
      if (tr.local) wrote.push(...e.keysChanged);
    });
    run(live, trimmed + STEP, trimmed + 30_000, { step: STEP });
    expect(witness.croupier.tablesWakeCount()).toBe(1);
    expect(wrote.filter((k) => k.startsWith('s:2:') || k.startsWith('x:2:'))).toEqual([]);
    for (const p of live) {
      expect(keysIn(p, 's', 2)).toEqual([]);
      expect(chipsOf(p, pids)).toEqual(afterRound1);
    }
    expectConserved(live);
    // Round 2, open in the new session, is the witness's to play as any
    // round: a seed of its out (for a close a peer deleted) goes again under
    // a fresh one.
    const X = testIdentity('x', 'player-X');
    pinOn(witness, X);
    witness.casino.buyInChips(X.pid, 1_000);
    const t2 = trimmed + 30_000 + STEP;
    expect(witness.table.writeComputedSlip(TABLE, [red(5)], t2)).toBe('ok');
    const felt = foldOf(witness).felts.get(witness.pid)!;
    const xs = kit.slip(X, 2, [black(5)]);
    const close = kit.close(X, 2, foldOf(witness).parent, { [witness.pid]: felt.hash, [X.pid]: xs.hash });
    putIn(witness, entries([xs, close]));
    frame(t2 + STEP, witness);
    expect(foldOf(witness).tip!.revealed).toEqual([witness.pid]);
    deleteIn(witness, [close.key]);
    frame(t2 + 2 * STEP, witness);
    const again = foldOf(witness).felts.get(witness.pid)!.rec;
    expect(again).toMatchObject({ r: 2, v: felt.rec.v + 1, b: [red(5)] });
    expect(again.c).not.toBe(felt.rec.c);
  });

  it("its witness puts back the close, then its own frozen felt as it was: no fresh felt of the round meanwhile", async () => {
    const { witness, live, pids, r2, chips, T } = await cut({ own: true });
    const own = `s:2:${witness.pid}:${r2.frozen[witness.pid]}`;
    // (Round 2 reads open meanwhile, the witness's felt of it gone and its
    // seed out: what the re-put does for a felt still to be played.)
    const felts = new Set<string>();
    let trimmed = -1;
    for (let t = T + STEP; t <= T + 15_000 && trimmed < 0; t += STEP) {
      run(live, t, t, { step: STEP });
      for (const k of keysIn(witness, 's', 2)) if (k.includes(witness.pid)) felts.add(k);
      if (live.every((p) => foldOf(p).base.u > 0)) trimmed = t;
    }
    expect(trimmed).toBeGreaterThan(0);
    expect([...felts]).toEqual([own]);
    for (const [i, p] of live.entries()) {
      expect(foldOf(p).base).toMatchObject({ u: 2, l: r2.close });
      expect(chipsOf(p, pids)).toEqual(chips[i]);
    }
  });

  it('is voided by no page that only watched it while a seed it rests on is gone, its abandon long due: its witnesses put the seed back', async () => {
    // (computedSim's cheats scenario found it: a page that didn't play a
    // round voided it at once when a peer deleted one of its seeds, ABANDON_MS
    // past its close; it read void and back on every page, and the abandon
    // stayed in the session to void it again at the next delete.)
    const pages = await room(['A', 'B', 'W']);
    const [a, b, w] = pages;
    for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T0)).toBe('ok');
    sync(T0, ...pages);
    const open2 = run(pages, T0 + STEP, T0 + 60_000, {
      step: STEP, until: () => pages.every((p) => foldOf(p).open === 2 && phaseOf(p)?.phase === 'betting'),
    });
    expect(a.table.writeComputedSlip(TABLE, [black(20)], open2)).toBe('ok');
    expect(b.table.writeComputedSlip(TABLE, [black(21)], open2)).toBe('ok');
    sync(open2, ...pages);
    const at = settle(pages, open2 + STEP);
    const r2 = foldOf(w).rounds[1];
    expect(r2.decided).toBe('reveals');
    const pids = pages.map((p) => p.pid);
    const chips = chipsOf(w, pids);
    // ABANDON_MS on (before any idle trim) a griefer deletes A's seed of
    // round 2, A and B away for 5 s: to W the round reads undecided again.
    const T = at + w.table.ABANDON_MS;
    run(pages, at + STEP, T - STEP, { step: STEP });
    expect(foldOf(w).base.u).toBe(0);
    const key = revealOf(w, 2, a.pid);
    vi.setSystemTime(T);
    deleteIn(w, [key]);
    sync(T, ...pages);
    expect(foldOf(w).tip?.r).toBe(2);
    run([w], T + STEP, T + 5_000, { step: STEP });
    expect(keysIn(w, 'z', 2)).toEqual([]);
    // Back, A puts its seed back: round 2 as every page showed it.
    run(pages, T + 5_000 + STEP, T + 15_000, { step: STEP });
    for (const p of pages) {
      expect(keysIn(p, 'z', 2)).toEqual([]);
      expect(foldOf(p).rounds[1]).toMatchObject({ close: r2.close, decided: 'reveals', pocket: r2.pocket });
      expect(chipsOf(p, pids)).toEqual(chips);
    }
  });

  it("a wake starts a watcher's wait again", async () => {
    const { w, live, T } = await cut();
    run(live, T + STEP, T + STEP, { step: STEP });
    // The witness is away; W waits 10 s, sleeps 7 s, and waits afresh from
    // its wake (once awake, a lapse on).
    run([w], T + 2 * STEP, T + 10_000, { step: STEP });
    const woke = T + 17_000;
    const trimmed = run([w], woke, woke + 60_000, { step: STEP, until: () => foldOf(w).base.u > 0 });
    expect(w.croupier.tablesWakeCount()).toBe(1);
    expectAt(trimmed, woke + TABLE_LEASE_LAPSE_MS + w.table.MISSING_WAIT_MS);
    expect(foldOf(w).base.u).toBe(1);
  });
});
