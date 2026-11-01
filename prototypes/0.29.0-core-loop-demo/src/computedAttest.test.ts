/**
 * 🏛️🧮 The owner-signed checkpoint (PR 6a-2 C2): the deed holder's page
 * vouches for a trim it folded by writing a signed `hs:` over it (D2), and
 * every page puts the best valid one it counted back when a peer takes it
 * away, overwrites it or writes junk (D3), standing down after a run of worse
 * overwrites (B12).
 *
 * Pages as the recovery tests have them (computedPageKit). The owner is
 * pages[0]: its pid is the room's deed holder, and its own key signs the
 * checkpoints. A friendly roulette table (no house), so `hs:` labels it
 * without a house reveal's `d`/`o`. The adversarial refusals of each of D2's
 * seven conditions (B10 among them) are exercised by the forger sim (C4); one
 * — a checkpoint whose nets this page didn't fold — is pinned here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asHouseSumFor, houseSumDigest, nextSid, recHash } from './computedFold';
import type { HouseSum } from './computedFold';
import {
  openRoom, PAGE_CTX as CTX, PAGE_INC as INC, PAGE_TABLE as TABLE, run, sync, trimByHand,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { red, testIdentity } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
const HS = `hs:${TABLE}:${INC}`;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const foldOf = (p: Page) => p.casino.computedFoldOf(TABLE)!;
const top = (p: Page) => p.doc.getMap('casinoComputed');
const readShape = asHouseSumFor({ inc: INC });
const hsOf = (p: Page): HouseSum | null => readShape(top(p).get(HS));
const liveSid = (p: Page): string => nextSid(CTX, p.casino.computedCheckpointOf(TABLE, INC));

/** A room whose deed page pages[0] holds (owner = its pid). */
async function ownerRoom(names: string[]): Promise<Page[]> {
  const pages = await openRoom(names, T0);
  pages[0].doc.transact(() => pages[0].doc.getMap('roomInfo').set('owner', pages[0].pid));
  sync(T0, ...pages);
  return pages;
}

const decidedOn = (p: Page, r: number): boolean => foldOf(p).base.u >= r || foldOf(p).rounds.some((v) => v.r === r && v.decided !== null);
const betting = (p: Page): boolean => p.table.readComputedRoulette(TABLE, Date.now())?.phase === 'betting';

/** Decide the open round on every page (each a red bet). */
function decideRound(pages: Page[], T: number): { r: number; at: number } {
  const r = foldOf(pages[0]).open;
  for (const [i, p] of pages.entries()) expect(p.table.writeComputedSlip(TABLE, [red(10 + i)], T)).toBe('ok');
  sync(T, ...pages);
  const at = run(pages, T + STEP, T + 60_000, { step: STEP, until: () => pages.every((p) => decidedOn(p, r)) });
  expect(at).toBeLessThanOrEqual(T + 60_000);
  return { r, at };
}

/** Decide `rounds` rounds, trimming each by hand (a non-page identity signs
 *  the checkpoint, `nets` overridden on the last when given), every page
 *  synced and run past it so the owner folds the moved session and attests.
 *  Returns the time after. */
function playAndTrim(pages: Page[], T: number, rounds: number, lastNets?: Record<string, bigint>): number {
  let at = T;
  for (let i = 0; i < rounds; i++) {
    ({ at } = decideRound(pages, at + STEP));
    // One more frame so every page (the owner above all) folds the decided
    // round before the trim: D2 vouches only for a round it saw decided.
    at = run(pages, at + STEP, at + STEP, { step: STEP });
    trimByHand(pages[0], testIdentity(`trimmer-${i}`), i === rounds - 1 ? lastNets : undefined);
    sync(at, ...pages);
    at = run(pages, at + STEP, at + 60_000, { step: STEP, until: () => pages.every(betting) });
  }
  return at;
}

describe('🏛️🧮 D2 — the deed holder vouches for its trims', () => {
  it('writes a signed hs: that checks the live session, by the owner, a = 0 from the genesis base', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a] = pages;
    playAndTrim(pages, T0, 1);

    const hs = hsOf(a);
    expect(hs).not.toBeNull();
    expect(hs!.k).toBe(a.pub);
    expect(hs!.a).toBe(0); // the first trim folds from the base 'g' (u = 0)
    expect(hs!.d).toBeUndefined(); // a friendly table: no house reveal to name
    // "hs checks sum": its digest is the live session this fold opens.
    expect(houseSumDigest(CTX, hs!)).toBe(liveSid(a));
    // The page counts its own as the best it has.
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(hs);
  });

  it('chains a across consecutive trims (still 0 when the owner folded every round itself)', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a] = pages;
    playAndTrim(pages, T0, 2);
    const hs = hsOf(a)!;
    expect(hs.u).toBeGreaterThanOrEqual(2); // two rounds covered
    expect(hs.a).toBe(0); // the owner folded both from the genesis base
    expect(houseSumDigest(CTX, hs)).toBe(liveSid(a));
  });

  it('a page that is not the deed holder signs none of its own', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    sync(Date.now(), a, b);
    // The owner's is the only hs:; b put it back if it went, but never signs
    // one with its own key.
    expect(hsOf(b)!.k).toBe(a.pub);
  });

  it("refuses a checkpoint whose nets it didn't fold (condition 3)", async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a] = pages;
    // A trim that keeps bogus nets: the owner folds the moved session, its
    // checkpointDiff is non-zero, and it vouches for nothing.
    playAndTrim(pages, T0, 1, { [a.pid]: 999_999n });
    expect(hsOf(a)).toBeNull();
    expect(a.casino.bestHouseSum(TABLE, INC)).toBeNull();
  });
});

describe('🏛️🧮 D3 — the best checkpoint is put back', () => {
  it('a peer deletes hs:, a page that counted it puts it back byte for byte', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    sync(Date.now(), a, b);
    const was = top(b).get(HS);
    expect(readShape(was)).not.toBeNull();
    expect(b.casino.bestHouseSum(TABLE, INC)).not.toBeNull();
    b.doc.transact(() => top(b).delete(HS));
    expect(top(b).has(HS)).toBe(false);
    run([b], Date.now() + STEP, Date.now() + 5_000, { step: STEP, until: () => top(b).has(HS) });
    expect(recHash(top(b).get(HS))).toBe(recHash(was));
  });

  it('junk over hs: is overwritten with the best counted', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    sync(Date.now(), a, b);
    const was = top(b).get(HS);
    b.doc.transact(() => top(b).set(HS, { not: 'a checkpoint' }));
    expect(readShape(top(b).get(HS))).toBeNull();
    run([b], Date.now() + STEP, Date.now() + 5_000, { step: STEP, until: () => recHash(top(b).get(HS)) === recHash(was) });
    expect(recHash(top(b).get(HS))).toBe(recHash(was));
  });

  it('stands down after three worse overwrites in a minute (B12)', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    sync(Date.now(), a, b);
    const hs = hsOf(b)!;
    // A stranger's shape-valid hs: that b reads as wrong-authority (no deed
    // holder's key): writing it over b's put-back is an overwrite by worse.
    const stranger = testIdentity('stranger');
    const forge = (): void => {
      const body = { v: 1 as const, b: hs.b, u: hs.u, l: hs.l, n: hs.n, a: hs.a, k: stranger.pub };
      const g = stranger.sign(b.fold.signBytes('hsum', CTX, body));
      b.doc.transact(() => top(b).set(HS, { ...body, g }));
    };
    // Each cycle is one put-back pass (houseDuty runs at most every REPUT_MS):
    // forge over b's put-back, then let one pass count the overwrite.
    let t = Date.now();
    for (let i = 0; i < 3; i++) {
      forge();
      t += 1_200;
      run([b], t, t, { step: STEP });
    }
    // After three overwrites inside the window, b has stood down (the ⚙ card
    // flag is set) and the forged value stays — b no longer fights it.
    expect(b.casino.houseSumBackedOff(TABLE, INC, t)).toBe(true);
    expect(readShape(top(b).get(HS))!.k).toBe(stranger.pub);
  });
});
