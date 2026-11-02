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
import * as Y from 'yjs';
import { asCheckpoint, asHouseSumFor, houseSumDigest, nextSid, recHash } from './computedFold';
import type { HouseSum } from './computedFold';
import {
  clockOf, frame, loadPage, openRoom, PAGE_CTX as CTX, PAGE_INC as INC, PAGE_TABLE as TABLE, run, signAs, switchOn, sync, trimByHand,
} from './computedPageKit';
import type { Page } from './computedPageKit';
import { ComputedKit, red, testIdentity } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

const T0 = 2_000_000_000;
const STEP = 200;
const HS = `hs:${TABLE}:${INC}`;
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
    // The ⚙ card carries the stand-down (PAGES DISAGREE), not just the backoff map.
    expect(b.table.computedCheckpointView(TABLE)?.backedOff).toBe(true);
    expect(readShape(top(b).get(HS))!.k).toBe(stranger.pub);
  });
});

/** Craft an owner-signed hs: with chosen fields. D2's own writer
 *  (writeHouseSum) trusts it and marks it checked, and the label reader never
 *  re-checks a signature — so a crafted `g` is enough to drive every label
 *  row deterministically, apart from the live fold. */
const L_HEX = 'a'.repeat(32); // a shape-valid close hash (isHex32) for crafted checkpoints
function craftHs(owner: string, over: Partial<HouseSum> = {}): HouseSum {
  return { v: 1, b: 'g', u: 1, l: L_HEX, n: { p: '10' }, a: 0, k: owner, g: 'sig', ...over } as HouseSum;
}

describe('🏛️🧮 D — the ⚙ checkpoint label (L-0..L-7 + the deed annotation)', () => {
  it('L-0: no label while the room names no deed holder', async () => {
    const pages = await openRoom(['A', 'B'], T0); // no owner set
    expect(pages[0].casino.checkpointLabelOf(TABLE, INC, 'any-sid', 1)).toBeNull();
  });

  it('L-1: no label for the genesis base (round 0)', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    expect(a.casino.checkpointLabelOf(TABLE, INC, 'any-sid', 0)).toBeNull();
  });

  it('L-2: a signature the page is still checking reads CHECKING…', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    // A validly-signed owner hs: (so the fast path can't reject it out of
    // hand), read with the verify budget spent: its 'hsum' check goes to the
    // slow slice and reads as not-yet (undefined), nothing counted or cached.
    const A = signAs(a, 'hsum', { v: 1, b: 'g', u: 1, l: L_HEX, n: { p: '10' }, a: 0 }, CTX);
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    a.doc.transact(() => top(a).set(HS, A));
    expect(a.casino.bestHouseSum(TABLE, INC)).toBeNull();
    expect(a.casino.checkpointLabelOf(TABLE, INC, 'any-sid', 1)).toBe('CHECKPOINT · ROUND 1 · CHECKING…');
  });

  it('L-3: a checkpoint the owner never signed reads NOT CHECKED BY THE OWNER', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    expect(a.casino.checkpointLabelOf(TABLE, INC, 'any-sid', 1)).toBe('CHECKPOINT · ROUND 1 · NOT CHECKED BY THE OWNER');
  });

  it('L-4: the owner signed this very checkpoint, from the genesis base', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    const A = craftHs(a.pub, { a: 0, u: 1 });
    a.casino.writeHouseSum(TABLE, INC, A);
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(A);
    expect(a.casino.checkpointLabelOf(TABLE, INC, houseSumDigest(CTX, A), 1)).toBe('CHECKPOINT · ROUND 1 · CHECKED BY THE OWNER');
  });

  it('L-5: the owner signed it, but folded every round only from a+1', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    const A = craftHs(a.pub, { a: 2, u: 3 });
    a.casino.writeHouseSum(TABLE, INC, A);
    expect(a.casino.checkpointLabelOf(TABLE, INC, houseSumDigest(CTX, A), 3)).toBe('CHECKPOINT · ROUND 3 · CHECKED BY THE OWNER FROM ROUND 3');
  });

  it('L-6: a later checkpoint than the owner last checked reads NOT CHECKED SINCE', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    a.casino.writeHouseSum(TABLE, INC, craftHs(a.pub, { u: 1 }));
    // The live fold is at round 2, a session A's digest doesn't name.
    expect(a.casino.checkpointLabelOf(TABLE, INC, 'later-sid', 2)).toBe('CHECKPOINT · ROUND 2 · NOT CHECKED SINCE ROUND 1');
  });

  it('L-7: another checkpoint at the round the owner checked flies the flag', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    a.casino.writeHouseSum(TABLE, INC, craftHs(a.pub, { u: 2 }));
    // The same round the owner checked (2), but a different session: a fork.
    expect(a.casino.checkpointLabelOf(TABLE, INC, 'other-sid', 2)).toBe("🚩 THIS ISN'T THE CHECKPOINT THE OWNER CHECKED AT ROUND 2");
  });

  it('B1: a handover seen during the visit is named on the new holder’s checkpoint', async () => {
    const [a, b] = await ownerRoom(['A', 'B']);
    expect(a.casino.houseDeedChanged()).toBe(false);
    // The deed passes from A to B (an established key giving way). The next
    // computed transaction — writeHouseSum's own map.set — counts the change.
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', b.pid));
    const A = craftHs(b.pub, { a: 0, u: 1 }); // the new holder's own check
    a.casino.writeHouseSum(TABLE, INC, A);
    expect(a.casino.houseDeedChanged()).toBe(true);
    expect(a.casino.checkpointLabelOf(TABLE, INC, houseSumDigest(CTX, A), 1))
      .toBe('CHECKPOINT · ROUND 1 · CHECKED BY THE OWNER · THE DEED CHANGED HANDS WHILE YOU WERE HERE');
  });
});

// The 'same' covered state is pinned here; 'unseen' (P1: the page never saw
// round u decided) is pinned in computedView.test.ts. 'split' (P2: the
// checkpoint names another close than the page folded — the forged `l`) arises
// only under a forged close, and is exercised by the forger sim's P2 probe in
// C4 (the honest-test policy, design §16).
describe('🏛️🧮 E — the page’s own comparison (covered)', () => {
  it('a page that folded the trim with the checkpoint’s close reads covered: same', async () => {
    const pages = await ownerRoom(['A', 'B']);
    playAndTrim(pages, T0, 1);
    const v = pages[0].table.computedCheckpointView(TABLE)!;
    expect(v.round).toBe(1);
    expect(v.covered).toBe('same');
    // Its own hs: labels the checkpoint CHECKED, and the comparison agrees.
    expect(v.label).toBe('CHECKPOINT · ROUND 1 · CHECKED BY THE OWNER');
  });
});

// ── 🏛️ F — the owner's checkpoint takes part in restores (design §6.2 F) ──────

/** An owner-signed checkpoint as the `sum:` value a restore of it writes
 *  (B14.1 / casinoDoc cpValueOfHouseSum): its checkpoint fields with its own
 *  k and g, the `a`/`d`/`o` of the hs: left off. */
function cpOfHs(hs: HouseSum): object {
  return {
    v: hs.v, b: hs.b, u: hs.u, l: hs.l, n: hs.n,
    ...(hs.e !== undefined ? { e: hs.e } : {}),
    ...(hs.s !== undefined ? { s: hs.s } : {}),
    ...(hs.h !== undefined ? { h: hs.h } : {}),
    k: hs.k, g: hs.g,
  };
}

/** A cheat page (recovery off, never framed): its writes are a peer's doc
 *  writes, nothing more. Yjs client 99, so a write of its concurrent with a
 *  page's wins. */
async function withCheat(pages: Page[], T: number): Promise<Page> {
  const cheat = await loadPage('X', 99);
  cheat.casino.setComputedRecoveryForTests(false);
  sync(T, cheat, ...pages);
  return cheat;
}

/** Page p's recovery of the table (casinoDoc computedRecoveries). */
const recoveryOf = (p: Page) => p.casino.computedRecoveries().find((x) => x.t === TABLE && x.inc === INC)!;
const sesKey = (sid: string): string => `ses:${TABLE}:${INC}:${sid}`;

describe('🏛️🧮 F — the owner-signed checkpoint takes part in restores', () => {
  it('F1: a late page that counted no chain restores the owner’s checkpoint over an absent one', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    const at = Date.now();
    const A = hsOf(a)!; // the owner's checkpoint for the round-1 trim
    expect(houseSumDigest(CTX, A)).toBe(liveSid(a)); // A checks the live session
    // A peer deletes the checkpoint; a fresh page loads with it already gone,
    // so it counts no chain of its own — only the owner's hs:.
    const cheat = await withCheat(pages, at);
    cheat.doc.transact(() => cheat.doc.getMap('casinoComputed').delete(SUM));
    const c = await loadPage('C', 4);
    sync(at, cheat, a, b, c);
    expect(top(c).has(SUM)).toBe(false);
    // No chain (it never counted a checkpoint), yet the owner's checkpoint
    // puts the restore in motion: 'junk', its target the owner's own bytes.
    expect(recoveryOf(c).trigger).toBe('junk');
    expect(recHash(recoveryOf(c).head)).toBe(recHash(cpOfHs(A)));
    // It writes it back (an outsider: only the owner's key takes a turn).
    const back = run([c], at + STEP, at + 45_000, { step: STEP, until: () => top(c).has(SUM) });
    expect(back).toBeLessThanOrEqual(at + 45_000);
    expect(recHash(top(c).get(SUM))).toBe(recHash(cpOfHs(A)));
    expect(top(c).has(sesKey(houseSumDigest(CTX, A)))).toBe(true);
    expect(recoveryOf(c).trigger).toBeNull();
    // The owner's own page restores the same bytes on the round tie.
    expect(recHash(recoveryOf(a).head)).toBe(recHash(cpOfHs(A)));
  }, 60_000);

  it('F2b: a forged rewind at or below the owner’s round is put back as the owner’s checkpoint', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    let at = playAndTrim(pages, T0, 1);
    const first = top(a).get(SUM); // the round-1 checkpoint P1
    const firstSid = nextSid(CTX, asCheckpoint(first)!);
    at = playAndTrim(pages, at, 1); // round 2: the owner's hs: now covers round 2
    const A = hsOf(a)!;
    expect(A.u).toBe(2);
    // A cheat rewinds the checkpoint to round 1 (a replay below the check).
    const cheat = await withCheat(pages, at);
    cheat.doc.transact(() => {
      const m = cheat.doc.getMap('casinoComputed');
      m.set(SUM, JSON.parse(JSON.stringify(first)));
      if (!(m.get(sesKey(firstSid)) instanceof Y.Map)) m.set(sesKey(firstSid), new Y.Map());
    });
    const c = await loadPage('C', 4);
    sync(at, cheat, a, b, c);
    // The late page never takes the rewind as its head; the owner's round-2
    // checkpoint puts the restore in motion.
    expect(recoveryOf(c).trigger).toBe('rewind');
    expect(c.casino.computedRestorePending(TABLE)).toBe(true);
    expect(recHash(recoveryOf(c).head)).toBe(recHash(cpOfHs(A)));
    const back = run([c], at + STEP, at + 50_000, { step: STEP, until: () => recHash(top(c).get(SUM)) === recHash(cpOfHs(A)) });
    expect(back).toBeLessThanOrEqual(at + 50_000);
    expect(recHash(top(c).get(SUM))).toBe(recHash(cpOfHs(A)));
    expect(top(c).has(sesKey(houseSumDigest(CTX, A)))).toBe(true);
    expect(recoveryOf(c).trigger).toBeNull();
  }, 70_000);

  it('F4: an ended checkpoint turned live again is restored, ended, with no session opened', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a] = pages;
    playAndTrim(pages, T0, 1); // a live round-1 checkpoint, the owner's hs: over it
    // The owner's best checkpoint is an end (e:1) — a round higher, so it wins
    // the order over the round-1 attest. A real signature (never re-checked on
    // a sum:, but read as a valid one once restored). A cheat has left a live
    // checkpoint in the doc: the ended table turned live again.
    const end = signAs(a, 'hsum', { v: 1, b: 'g', u: 2, l: L_HEX, n: { p: '10' }, a: 0, e: 1 }, CTX) as HouseSum;
    a.casino.writeHouseSum(TABLE, INC, end);
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(end);
    expect(recoveryOf(a).trigger).toBe('end');
    expect(a.casino.computedRestorePending(TABLE)).toBe(true);
    expect(recHash(recoveryOf(a).head)).toBe(recHash(cpOfHs(end)));
    const from = Date.now();
    const back = run([a], from + STEP, from + 20_000, { step: STEP, until: () => recHash(top(a).get(SUM)) === recHash(cpOfHs(end)) });
    expect(back).toBeLessThanOrEqual(from + 20_000);
    expect((top(a).get(SUM) as { e?: number }).e).toBe(1);
    // An end opens no session: the restore writes none.
    expect(top(a).has(sesKey(houseSumDigest(CTX, end)))).toBe(false);
    expect(recoveryOf(a).trigger).toBeNull();
  }, 40_000);

  it('B1: a checkpoint by a holder whose handover this page watched takes no part; a fresh page trusts it', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    const P1 = asCheckpoint(top(a).get(SUM))!;
    const p1Value = top(a).get(SUM);
    // The deed passes from A to B during the visit: A and B both watch it.
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', b.pid));
    sync(Date.now(), a, b);
    expect(a.casino.houseDeedChanged()).toBe(true);
    expect(b.casino.houseDeedChanged()).toBe(true);
    // The new holder B signs a checkpoint of the same round-1 trim.
    const A1b = signAs(b, 'hsum', { v: 1, b: P1.b, u: P1.u, l: P1.l, n: P1.n, a: 0 }, CTX) as HouseSum;
    b.casino.writeHouseSum(TABLE, INC, A1b);
    // A peer deletes the checkpoint; a fresh page loads after the handover.
    const cheat = await withCheat(pages, Date.now());
    cheat.doc.transact(() => cheat.doc.getMap('casinoComputed').delete(SUM));
    const c = await loadPage('C', 4);
    sync(Date.now(), cheat, a, b, c);
    // A watched the handover: B's checkpoint takes no part, so A restores its
    // own counted head (the raw trim), not B's checkpoint.
    expect(recoveryOf(a).trigger).toBe('junk');
    expect(recHash(recoveryOf(a).head)).toBe(recHash(p1Value));
    // C loaded after the handover and trusts the deed holder it found: B's
    // checkpoint takes part, and C's restore target is B's bytes.
    expect(recoveryOf(c).trigger).toBe('junk');
    expect(recHash(recoveryOf(c).head)).toBe(recHash(cpOfHs(A1b)));
    expect(recHash(recoveryOf(a).head)).not.toBe(recHash(recoveryOf(c).head));
  }, 40_000);
});

// ── 🏛️ C4 — the hs: forger, and the 'split' comparison ───────────────────────

// The forgeries a cheat can write without the owner's key: a wrong-key one
// (its own, claiming the deed holder's), a bad signature under the owner's
// key, and a replay of an older, real owner checkpoint (worse by the order).
// A higher-round owner checkpoint can't be forged (no owner key), so none of
// these unseats the owner's best, nor takes part in a restore (houseSumTakes-
// Part: wrong authority, or never counted; the replay loses the order). D3
// puts the best back; B12's stand-down is pinned above.
describe('🏛️🧮 the hs: forger — D3 keeps the owner’s checkpoint', () => {
  it('a wrong-key hs: (a stranger claiming to be the owner) is overwritten with the owner’s', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    const at = playAndTrim(pages, T0, 1);
    const A = hsOf(a)!;
    const good = top(a).get(HS);
    const stranger = testIdentity('stranger');
    const body = { v: 1 as const, b: A.b, u: A.u, l: A.l, n: A.n, a: 0, k: stranger.pub };
    const forged = { ...body, g: stranger.sign(a.fold.signBytes('hsum', CTX, body)) };
    b.doc.transact(() => top(b).set(HS, forged));
    sync(at, a, b);
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(A); // the stranger never takes part
    const back = run([a, b], at + STEP, at + 8_000, { step: STEP, until: () => [a, b].every((p) => recHash(top(p).get(HS)) === recHash(good)) });
    expect(back).toBeLessThanOrEqual(at + 8_000);
    expect(recHash(top(b).get(HS))).toBe(recHash(good));
  }, 30_000);

  it('a bad-signature hs: under the owner’s key is overwritten', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    const at = playAndTrim(pages, T0, 1);
    const A = hsOf(a)!;
    const good = top(a).get(HS);
    const forged = { ...A, g: 'A'.repeat(86) }; // shape-valid, verification fails
    b.doc.transact(() => top(b).set(HS, forged));
    sync(at, a, b);
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(A);
    const back = run([a, b], at + STEP, at + 8_000, { step: STEP, until: () => [a, b].every((p) => recHash(top(p).get(HS)) === recHash(good)) });
    expect(back).toBeLessThanOrEqual(at + 8_000);
    expect(recHash(top(b).get(HS))).toBe(recHash(good));
  }, 30_000);

  it('a replay of an older owner checkpoint is overwritten by the best counted', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    const at1 = playAndTrim(pages, T0, 1);
    const A1 = top(a).get(HS); // the round-1 checkpoint
    const at2 = playAndTrim(pages, at1, 1);
    const A2 = hsOf(a)!;
    const A2val = top(a).get(HS);
    expect(A2.u).toBe(2);
    b.doc.transact(() => top(b).set(HS, JSON.parse(JSON.stringify(A1)))); // replay the older one
    sync(at2, a, b);
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(A2); // the newer stays the best
    const back = run([a, b], at2 + STEP, at2 + 8_000, { step: STEP, until: () => [a, b].every((p) => recHash(top(p).get(HS)) === recHash(A2val)) });
    expect(back).toBeLessThanOrEqual(at2 + 8_000);
    expect(recHash(top(b).get(HS))).toBe(recHash(A2val));
  }, 30_000);
});

describe('🏛️🧮 E — a checkpoint naming another close reads covered: split', () => {
  it('a forged `l` for a round this page saw decided reads split, not a silent 0', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a] = pages;
    const { at } = decideRound(pages, T0 + STEP); // round 1 decided, every page folds its close
    // A couple of frames so the fold the table last noted (st.lastRes, what
    // the next move compares against) is the one that saw round 1 decided,
    // not the close-before-reveals fold the run stopped on.
    const settled = run(pages, at + STEP, at + 3 * STEP, { step: STEP });
    const res1 = a.casino.computedFoldOf(TABLE)!;
    const real = res1.rounds.find((v) => v.r === 1)!.close;
    const forgedClose = real === L_HEX ? 'b'.repeat(32) : L_HEX; // any other shape-valid close
    const kit = new ComputedKit(CTX);
    const cp = kit.checkpoint(testIdentity('cheat'), res1.base.sid, 1, forgedClose, Object.fromEntries(res1.nets));
    const sid = kit.sidAfter(cp);
    // A cheat trims round 1 with a close this page never saw.
    a.doc.transact(() => {
      const m = top(a);
      m.set(SUM, cp);
      for (const k of [...m.keys()]) if (k.startsWith(`ses:${TABLE}:${INC}:`)) m.delete(k);
      m.set(sesKey(sid), new Y.Map());
    });
    run([a], settled + STEP, settled + STEP, { step: STEP });
    const v = a.table.computedCheckpointView(TABLE)!;
    expect(v.round).toBe(1);
    expect(v.covered).toBe('split');
  }, 30_000);
});

// ── 🏛️ Review follow-ups (PR 6a-2): ends, waiting on a check, notify, F1, retry ─

describe('🏛️🧮 D2 — the owner vouches for an end it writes from a finalization path', () => {
  it('switching the table off writes an owner-signed end (e:1) that checks the ended checkpoint', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a] = pages;
    const { at } = decideRound(pages, T0 + STEP); // round 1 decided, not trimmed
    const settled = run(pages, at + STEP, at + 60_000, { step: STEP, until: () => pages.every(betting) });
    expect(a.table.switchComputedOff(TABLE, settled)).toBe('ok');
    const hs = hsOf(a);
    expect(hs).not.toBeNull();
    expect(hs!.e).toBe(1); // an end
    expect(hs!.k).toBe(a.pub); // the owner signed it
    expect(hs!.u).toBe(1); // the round the end kept
    // The hs: checks the very end checkpoint the switch-off wrote: nextSid
    // leaves k and g out, so the end's sum: and its hs: share a digest.
    const end = asCheckpoint(top(a).get(SUM))!;
    expect(end.e).toBe(1);
    expect(houseSumDigest(CTX, hs!)).toBe(nextSid(CTX, end));
  }, 70_000);
});

describe('🏛️🧮 D3 — a newer attestation still being checked is not overwritten', () => {
  it('leaves a newer pending hs: alone rather than putting the older best over it', async () => {
    const [a] = await ownerRoom(['A', 'B']);
    const A1 = craftHs(a.pub, { u: 1 }); // this page's current best (counted, checked)
    a.casino.writeHouseSum(TABLE, INC, A1);
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(A1);
    // A newer, validly-signed owner checkpoint lands, but the verify budget is
    // spent — its 'hsum' check is still pending (houseSumOk → undefined).
    const A2 = signAs(a, 'hsum', { v: 1, b: 'g', u: 2, l: L_HEX, n: { p: '10' }, a: 0 }, CTX) as HouseSum;
    a.casino.setComputedVerifyForTests({ now: () => 0, budgetMs: 0 });
    a.doc.transact(() => top(a).set(HS, A2));
    expect(a.casino.bestHouseSum(TABLE, INC)).toEqual(A1); // A2 not counted yet
    // D3 must leave the newer pending A2 for the recheck, not overwrite with A1.
    a.casino.putBackHouseRecords(Date.now());
    expect(recHash(top(a).get(HS))).toBe(recHash(A2));
  });
});

describe('🏛️🧮 an hs: change wakes the ⚙ card’s listeners, with no refold', () => {
  it('putting the owner’s hs: back tells the computed-view listeners', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    sync(Date.now(), a, b);
    let told = 0;
    b.casino.subscribeCasinoKey(`computed:${TABLE}`, () => { told += 1; });
    // Delete b's hs: (a no-op for the label count: it's gone); the put-back that
    // rewrites it is an hs:-only change, and the listener is told of it.
    b.doc.transact(() => top(b).delete(HS));
    run([b], Date.now() + STEP, Date.now() + 5_000, { step: STEP, until: () => top(b).has(HS) });
    expect(top(b).has(HS)).toBe(true);
    expect(told).toBeGreaterThan(0);
  });
});

describe('🏛️🧮 F1 reaches an incarnation known only by the owner’s hs:', () => {
  it('a late page whose incarnation lost every sum:/ses: still restores the owner’s checkpoint', async () => {
    const pages = await ownerRoom(['A', 'B']);
    const [a, b] = pages;
    playAndTrim(pages, T0, 1);
    const at = Date.now();
    const A = hsOf(a)!;
    // A peer deletes the checkpoint AND every session: the incarnation has only
    // the owner's hs: left. A fresh page loads with nothing else to track it by.
    const cheat = await withCheat(pages, at);
    cheat.doc.transact(() => {
      const m = cheat.doc.getMap('casinoComputed');
      for (const k of [...m.keys()]) if (k === SUM || k.startsWith(`ses:${TABLE}:${INC}:`)) m.delete(k);
    });
    const c = await loadPage('C', 4);
    sync(at, cheat, a, b, c);
    expect(top(c).has(SUM)).toBe(false);
    expect([...top(c).keys()].some((k) => k.startsWith(`ses:${TABLE}:${INC}:`))).toBe(false);
    expect(hsOf(c)).not.toBeNull();
    // Tracked off the hs: alone, F1 puts the owner's checkpoint (and the session
    // it opens) back — without the incarnation registered, recovery never runs.
    expect(recoveryOf(c).trigger).toBe('junk');
    const back = run([c], at + STEP, at + 45_000, { step: STEP, until: () => top(c).has(SUM) });
    expect(back).toBeLessThanOrEqual(at + 45_000);
    expect(recHash(top(c).get(SUM))).toBe(recHash(cpOfHs(A)));
    expect(top(c).has(sesKey(houseSumDigest(CTX, A)))).toBe(true);
  }, 60_000);
});

describe('🏛️🧮 a trim held off by the hearing gate is vouched for once it reopens', () => {
  it('stashes the trim while the gate is shut, then attests when hearing has lasted a minute', async () => {
    // Hearing wired (as main.ts wires it), so attestDuty's IDLE_MS gate is real.
    const a = await loadPage('A', 1, { hears: true });
    const b = await loadPage('B', 2, { hears: true });
    const pages = [a, b];
    for (const p of pages) { clockOf(p, T0); p.casino.buyInChips(p.pid, 1_000); }
    switchOn(a);
    a.doc.transact(() => a.doc.getMap('roomInfo').set('owner', a.pid));
    sync(T0, a, b);
    const { at } = decideRound(pages, T0 + STEP); // round 1 decided (a hears b throughout)
    const t = run(pages, at + STEP, at + STEP, { step: STEP });
    // The owner folds a trim while its hearing hasn't yet lasted IDLE_MS: the
    // gate holds the attestation off (kept to retry), so no hs: is written.
    trimByHand(a, testIdentity('trimmer'));
    // The owner folds the trim with its hearing already lapsed (a few seconds
    // of silence, no notes): the gate holds the attestation off, kept to retry.
    let T = t + STEP;
    for (; T <= t + 4_000; T += STEP) frame(T, a);
    expect(hsOf(a)).toBeNull();
    // From here the owner hears the room unbroken (a note every frame). The gate
    // opens exactly IDLE_MS after hearing begins afresh; until then no hs:, and
    // the next fold after it opens retries the held-off trim.
    const heardFrom = T;
    let wrote = -1;
    for (; T <= heardFrom + 63_000; T += STEP) {
      a.table.noteRoomHeard(clockOf(a, T)); // unbroken hearing, no silence
      frame(T, a);
      if (T < heardFrom + 55_000) expect(hsOf(a)).toBeNull(); // held off for ~a minute
      if (hsOf(a)) { wrote = T; break; }
    }
    expect(wrote).toBeGreaterThan(heardFrom + 58_000); // only after ~a minute of unbroken hearing
    expect(houseSumDigest(CTX, hsOf(a)!)).toBe(liveSid(a));
  }, 60_000);
});
