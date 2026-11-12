/**
 * 🧪🔒 The FAIR ONLY simulations' own checks, tried against a house and a page
 * that do wrong (computedSim.ts; design §16.2, the checkpoint oracle; PR
 * 6c-5a-2). The end to end scenarios (computedFairOnlySim.test.ts) pass with
 * `gameProblems()` empty and no violation: that says something only if a
 * wrong checkpoint is named. Here the simulated house is made to sign one
 * (its `faultTrim`, which changes the body before the cross-check and the
 * signature), the pages count from it as they must (a page takes its house's
 * word for a checkpoint: that is what FAIR ONLY trusts), and the oracle names
 * it. One its own cross-check catches is never signed. A page that writes
 * a checkpoint is a violation. And the oracle's own reading of a doc (its
 * cold fold, from its own base rule) is not moved by an old checkpoint laid
 * back in or by one the house did not sign, as the pages' is not. An end
 * (PR 6c-5b-1) is held as a trim is: the house's with the wrong nets is
 * named, as is one at its base's round that does not hold what the base
 * held; and only the page that holds a game may sign one itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { sealCk, sealFin } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import { delegationKey, houseSign, roomSignBytes } from './computedHouse';
import { PAGE_ROOM } from './computedPageKit';
import { RUN_MS as CRAPS_RUN_MS, T as CRAPS, TIMEOUT as CRAPS_TIMEOUT } from './computedCrapsSimKit';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import type { PageSpec } from './computedSim';
import { inFlight, pressEnd } from './computedFairOnlySimKit';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const RUN_MS = SIM_MINUTES * 60_000;
const TIMEOUT = SIM_LONG ? 1_800_000 : 300_000;
const seed = (n: number): number => n + SIM_SEED_OFFSET;
const named = (names: string): PageSpec[] => names.split('').map((name) => ({ name }));
type Body = Record<string, unknown>;

/** Run until the house has signed a checkpoint `fault` changed and a page
 *  counts from one, then a little longer; false if the run ended first. */
async function runFaulty(sim: Sim, maxMs: number, fault: (body: Body) => Body | null): Promise<boolean> {
  let faulted = 0;
  sim.node!.faultTrim = (body) => {
    const changed = fault(body);
    if (!changed) return body;
    faulted += 1;
    return changed;
  };
  while (sim.elapsed < maxMs && !(faulted > 0 && sim.basesCounted > 0)) await sim.run(2_000);
  await sim.run(4_000);
  await sim.syncAll();
  return faulted > 0 && sim.basesCounted > 0;
}

describe("the checkpoint oracle names a house's wrong checkpoint", () => {
  it('nets no honest page folded', async () => {
    const sim = await Sim.open({ name: 'fair-only-wrong-nets', seed: seed(1211), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const hit = await runFaulty(sim, RUN_MS, (body) => {
      const n = body.n as Record<string, string>;
      const pid = Object.keys(n).sort()[0];
      return pid === undefined ? null : { ...body, n: { ...n, [pid]: (BigInt(n[pid]) + 5n).toString() } };
    });
    expect(hit, sim.label).toBe(true);
    expect(sim.node!.crossCheckMismatches, sim.label).toBe(0);
    const problems = sim.gameProblems();
    expect(problems.some((p) => /holding .* the honest pages folded/.test(p)), problems.join('\n')).toBe(true);
    expect(problems.some((p) => /did not sign|no honest page folded decided/.test(p)), problems.join('\n')).toBe(false);
  }, TIMEOUT);

  it('an outcome the round did not have', async () => {
    const sim = await Sim.open({ name: 'fair-only-wrong-pocket', seed: seed(1212), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const hit = await runFaulty(sim, RUN_MS, (body) => (typeof body.o === 'number' ? { ...body, o: (body.o + 1) % 37 } : null));
    expect(hit, sim.label).toBe(true);
    const problems = sim.gameProblems();
    expect(problems.some((p) => /holding .* the honest pages folded/.test(p)), problems.join('\n')).toBe(true);
  }, TIMEOUT);

  it("a close it did not reveal for: the house's own cross-check refuses to sign it, and no page counts from it", async () => {
    const sim = await Sim.open({ name: 'fair-only-wrong-close', seed: seed(1213), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const node = sim.node!;
    node.faultTrim = (body) => ({ ...body, l: 'f'.repeat((body.l as string).length) });
    while (sim.elapsed < RUN_MS && node.crossCheckMismatches < 3) await sim.run(2_000);
    await sim.syncAll();
    expect(node.crossCheckMismatches, sim.label).toBeGreaterThanOrEqual(3);
    expect(node.trims, sim.label).toBe(0);
    expect(sim.houseCheckpoints, sim.label).toBe(0);
    expect(sim.basesCounted, sim.label).toBe(0);
    expect(sim.gameProblems(), sim.label).toEqual([]);
    expect(sim.violations, sim.label).toEqual([]);
  }, TIMEOUT);

  it('craps: a carry the table was not left in', async () => {
    const sim = await Sim.open({ name: 'fair-only-wrong-carry', seed: seed(1214), pages: named('ABCD'), tables: [{ id: CRAPS, game: 'craps' }], houseNode: true, fairOnly: true });
    const hit = await runFaulty(sim, CRAPS_RUN_MS, (body) => {
      const s = body.s as { p: number } | undefined;
      // (A point where there was none, and none where there was one: a carry
      // of no riders reads either way.)
      return s === undefined ? null : { ...body, s: { ...s, p: s.p === 0 ? 4 : s.p === 4 ? 5 : 4 } };
    });
    expect(hit, `${sim.label}: cross-check refusals ${sim.node!.crossCheckMismatches}`).toBe(true);
    const problems = sim.gameProblems();
    expect(problems.some((p) => /handing on/.test(p)), problems.join('\n')).toBe(true);
  }, CRAPS_TIMEOUT);
});

describe('a page that writes a checkpoint', () => {
  it('is a violation, whatever it holds', async () => {
    const sim = await Sim.open({ name: 'fair-only-page-ck', seed: seed(1215), pages: named('ABC'), houseNode: true, fairOnly: true });
    await sim.run(20_000);
    expect(sim.violations, sim.label).toEqual([]);
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    const inc = B.p.casino.computedIncOf('roulette-1')!;
    const top = B.p.doc.getMap<unknown>('casinoComputed');
    top.set(`ck:roulette-1:${inc}:${'0'.repeat(16)}`, { v: 1, b: 'g', k: 'nobody' });
    await sim.run(2_000);
    expect(sim.violations.filter((v) => /B wrote the checkpoint .* which no house signed/.test(v)), sim.violations.join('\n')).toHaveLength(1);
    // Nor may it lay something else under a key the room knows (the opening root's): only the record itself goes back there.
    const [root] = [...top.keys()].filter((k) => k.startsWith(`ck:roulette-1:${inc}:`) && (top.get(k) as { u?: unknown }).u === 0);
    expect(root, sim.label).toBeDefined();
    top.set(root, { ...(top.get(root) as Record<string, unknown>), n: { [B.pid]: '1000' } });
    await sim.run(2_000);
    expect(sim.violations.filter((v) => v.includes(`B wrote the checkpoint ${root} `)), sim.violations.join('\n')).toHaveLength(1);
  }, TIMEOUT);
  it('but a page that puts the opening root back, the opener asleep, is none: any page may (casinoDoc putBackFairOnlyRecords)', async () => {
    const sim = await Sim.open({ name: 'fair-only-root-back', seed: seed(1217), pages: named('ABC'), houseNode: true, fairOnly: true });
    await sim.run(20_000);
    const T = 'roulette-1';
    const C = sim.pages.find((sp) => sp.name === 'C')!;
    // (On until a round has moved chips: the pages' counts rest on the root then.)
    while (sim.elapsed < RUN_MS && (C.p.casino.computedFoldOf(T)?.nets.size ?? 0) === 0) await sim.run(1_000);
    expect(C.p.casino.computedFoldOf(T)?.nets.size ?? 0, sim.label).toBeGreaterThan(0);
    const inc = C.p.casino.computedIncOf(T)!;
    const top = C.p.doc.getMap<unknown>('casinoComputed');
    const roots = [...top.keys()].filter((k) => k.startsWith(`ck:${T}:${inc}:`));
    expect(roots, sim.label).toHaveLength(1);
    expect(sim.houseCheckpoints, sim.label).toBe(0);
    sim.sleep(sim.house, false);
    await sim.run(1_000);
    C.cheats = true;
    C.p.doc.transact(() => top.delete(roots[0]));
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    // While the doc holds no root, a page counts from the one it held, and the oracle's cold count with it.
    await sim.run(500);
    sim.enter(B);
    expect(B.p.doc.getMap('casinoComputed').has(roots[0]), sim.label).toBe(false);
    expect(B.p.casino.computedFoldOf(T)?.nets.size ?? 0, sim.label).toBeGreaterThan(0);
    expect(sim.ledgerProblems(B), sim.label).toEqual([]);
    expect(sim.cageProblems(B), sim.label).toEqual([]);
    await sim.run(10_000);
    await sim.syncAll();
    expect(B.p.doc.getMap('casinoComputed').has(roots[0]), sim.label).toBe(true);
    expect(sim.violations, sim.label).toEqual([]);
  }, TIMEOUT);
});

describe('the checkpoint oracle and a sweep', () => {
  it("a sweep the house's key signed that does not hold what the checkpoint it sweeps held (a thousand chips more to one player) is counted from by the pages, and named", async () => {
    const sim = await Sim.open({ name: 'fair-only-wrong-sweep', seed: seed(1218), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const T = 'roulette-1';
    const A = sim.pages.find((sp) => sp.name === 'A')!;
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    while (sim.elapsed < RUN_MS && sim.node!.trims < 1) await sim.run(2_000);
    sim.heal();
    await sim.quiet(120_000);
    sim.nodeUp = false;
    await sim.syncAll();
    expect(sim.gameProblems(), sim.label).toEqual([]);
    sim.enter(B);
    const inc = B.p.casino.computedIncOf(T)!;
    const real = B.p.casino.computedResolutionOf(T, inc)!.base!.ck;
    expect(real.u, sim.label).toBeGreaterThan(0);
    const ctx = sim.ctxOf(T, inc);
    const { g: _g, ...body } = real;
    const secret = (sim.node as unknown as { secret: Uint8Array }).secret;
    const swept = sealCk(
      ctx, { ...body, b: B.p.fold.nextSid3(ctx, real), w: (real.w ?? 0) + 1, n: { ...real.n, [B.pid]: (BigInt(real.n[B.pid] ?? '0') + 1000n).toString() } },
      (bytes) => houseSign(secret, bytes),
    );
    B.cheats = true;
    B.p.doc.transact(() => B.p.doc.getMap<unknown>('casinoComputed').set(swept.key, swept.value));
    await sim.run(2_000);
    await sim.syncAll();
    sim.enter(A);
    expect(A.p.casino.computedResolutionOf(T, inc)?.base?.key, sim.label).toBe(swept.key);
    const problems = sim.gameProblems();
    expect(problems.some((p) => p.includes(swept.key) && /repeats no checkpoint the room held/.test(p)), problems.join('\n')).toBe(true);
  }, TIMEOUT);
});

describe('the checkpoint oracle and an end', () => {
  const T = 'roulette-1';

  it("the house's end of a game with nets no honest page folded is counted from by the pages, and named", async () => {
    const sim = await Sim.open({ name: 'fair-only-wrong-end', seed: seed(1221), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const node = sim.node!;
    let faulted = 0;
    node.faultTrim = (body) => {
      const n = body.n as Record<string, string>;
      const pid = Object.keys(n).sort()[0];
      if (body.e !== 1 || pid === undefined) return body;
      faulted += 1;
      return { ...body, n: { ...n, [pid]: (BigInt(n[pid]) + 5n).toString() } };
    };
    const end = pressEnd(sim, T, 'roulette', 30_000, () => inFlight(sim, T), true);
    while (sim.elapsed < RUN_MS && node.ends < 1) await sim.run(2_000);
    await sim.run(4_000);
    await sim.syncAll();
    expect(end.said, sim.label).toEqual(['ending']);
    expect([node.ends, faulted, node.crossCheckMismatches], sim.label).toEqual([1, 1, 0]);
    const A = sim.pages.find((sp) => sp.name === 'A')!;
    sim.enter(A);
    expect(A.p.casino.isComputedTable(T), sim.label).toBe(false);
    const problems = sim.gameProblems();
    expect(problems.some((p) => /holding .* the honest pages folded/.test(p)), problems.join('\n')).toBe(true);
    expect(problems.some((p) => /did not sign|no end order/.test(p)), problems.join('\n')).toBe(false);
  }, TIMEOUT);

  it("an end at its base's round that the house's key signed, a thousand chips more to one player in it, is counted from by the pages, and named: it repeats no checkpoint", async () => {
    const sim = await Sim.open({ name: 'fair-only-wrong-end-base', seed: seed(1223), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const A = sim.pages.find((sp) => sp.name === 'A')!;
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    while (sim.elapsed < RUN_MS && sim.node!.trims < 1) await sim.run(2_000);
    sim.heal();
    await sim.quiet(120_000);
    sim.nodeUp = false;
    await sim.syncAll();
    expect(sim.gameProblems(), sim.label).toEqual([]);
    sim.enter(B);
    const inc = B.p.casino.computedIncOf(T)!;
    const real = B.p.casino.computedResolutionOf(T, inc)!.base!.ck;
    expect(real.u, sim.label).toBeGreaterThan(0);
    const ctx = sim.ctxOf(T, inc);
    const { house } = sim;
    sim.enter(house);
    const fin = sealFin(ctx, house.p.pub, house.p.keypair.signIdentity);
    const { g: _g, s: _s, h: _h, w: _w, ...body } = real;
    const secret = (sim.node as unknown as { secret: Uint8Array }).secret;
    const seal = (n: Record<string, string>) => sealCk(ctx, { ...body, b: B.p.fold.nextSid3(ctx, real), n, e: 1, f: fin.value }, (bytes) => houseSign(secret, bytes));
    // (The same end holding what the base holds would be none: the control, below.)
    const wrong = seal({ ...real.n, [B.pid]: (BigInt(real.n[B.pid] ?? '0') + 1000n).toString() });
    B.cheats = true;
    sim.enter(B);
    B.p.doc.transact(() => {
      B.p.doc.getMap<unknown>('casinoComputed').set(fin.key, fin.value);
      B.p.doc.getMap<unknown>('casinoComputed').set(wrong.key, wrong.value);
    });
    await sim.run(2_000);
    await sim.syncAll();
    sim.enter(A);
    expect(A.p.casino.computedResolutionOf(T, inc)?.base?.key, sim.label).toBe(wrong.key);
    const problems = sim.gameProblems();
    expect(problems.some((p) => p.includes(wrong.key) && /a round no honest page folded decided on that close/.test(p)), problems.join('\n')).toBe(true);
  }, TIMEOUT);

  it("…and the same end holding what its base holds is named for nothing", async () => {
    const sim = await Sim.open({ name: 'fair-only-right-end-base', seed: seed(1223), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const A = sim.pages.find((sp) => sp.name === 'A')!;
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    while (sim.elapsed < RUN_MS && sim.node!.trims < 1) await sim.run(2_000);
    sim.heal();
    await sim.quiet(120_000);
    sim.nodeUp = false;
    await sim.syncAll();
    sim.enter(B);
    const inc = B.p.casino.computedIncOf(T)!;
    const real = B.p.casino.computedResolutionOf(T, inc)!.base!.ck;
    const ctx = sim.ctxOf(T, inc);
    const { house } = sim;
    sim.enter(house);
    const fin = sealFin(ctx, house.p.pub, house.p.keypair.signIdentity);
    const { g: _g, s: _s, h: _h, w: _w, ...body } = real;
    const secret = (sim.node as unknown as { secret: Uint8Array }).secret;
    const right = sealCk(ctx, { ...body, b: B.p.fold.nextSid3(ctx, real), e: 1, f: fin.value }, (bytes) => houseSign(secret, bytes));
    B.cheats = true;
    sim.enter(B);
    B.p.doc.transact(() => {
      B.p.doc.getMap<unknown>('casinoComputed').set(fin.key, fin.value);
      B.p.doc.getMap<unknown>('casinoComputed').set(right.key, right.value);
    });
    await sim.run(2_000);
    await sim.syncAll();
    sim.enter(A);
    expect(A.p.casino.computedResolutionOf(T, inc)?.base?.key, sim.label).toBe(right.key);
    expect(sim.gameProblems(), sim.label).toEqual([]);
    expect(sim.basesCounted, sim.label).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);

  it('a page that does not hold the game and signs an end of it writes a checkpoint no house signed: a violation, and no page counts from it', async () => {
    const sim = await Sim.open({ name: 'fair-only-page-end', seed: seed(1225), pages: named('ABC'), houseNode: true, fairOnly: true });
    await sim.run(20_000);
    expect(sim.violations, sim.label).toEqual([]);
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    expect(B, sim.label).not.toBe(sim.house);
    sim.enter(B);
    const inc = B.p.casino.computedIncOf(T)!;
    const real = B.p.casino.computedResolutionOf(T, inc)!.base!.ck;
    const ctx = sim.ctxOf(T, inc);
    const fin = sealFin(ctx, B.p.pub, B.p.keypair.signIdentity);
    const { g: _g, s: _s, h: _h, w: _w, dl: _dl, ...body } = real;
    const end = sealCk(ctx, { ...body, b: B.p.fold.nextSid3(ctx, real), e: 1, f: fin.value, k: B.p.pub }, B.p.keypair.signIdentity);
    B.p.doc.transact(() => B.p.doc.getMap<unknown>('casinoComputed').set(end.key, end.value));
    await sim.run(2_000);
    await sim.syncAll();
    expect(sim.violations.filter((v) => v.includes(`B wrote the checkpoint ${end.key} `) && /which no house signed/.test(v)), sim.violations.join('\n')).toHaveLength(1);
    for (const sp of sim.pages) {
      sim.enter(sp);
      expect(sp.p.casino.computedResolutionOf(T, inc)?.base?.key, `${sim.label} ${sp.name}`).not.toBe(end.key);
      expect(sp.p.casino.isComputedTable(T), `${sim.label} ${sp.name}`).toBe(true);
    }
  }, TIMEOUT);
});

describe("the oracle's own base rule", () => {
  it('does not hold a delegation that came and went with no record of its house in the game: that key is a house while the record is in the doc, and none after', async () => {
    const sim = await Sim.open({ name: 'fair-only-unused-key', seed: seed(1235), pages: named('ABCD'), houseNode: true, fairOnly: true });
    await sim.run(30_000);
    const T = 'roulette-1';
    const D = sim.pages[3];
    const owner = sim.house;
    const top = D.p.doc.getMap<unknown>('casinoComputed');
    const inc = D.p.casino.computedIncOf(T)!;
    const base = (): { houseAt(pub: string, r: number): boolean } | null => (sim as unknown as {
      foBase(sp: typeof D, map: Y.Map<unknown>, ctx: { room: string; t: string; inc: string }): { houseAt(pub: string, r: number): boolean } | null;
    }).foBase(D, top, { room: PAGE_ROOM, t: T, inc });
    // (A key the holder delegates and that writes nothing: page D's own, as good a key as any.)
    const h = D.p.pub;
    const body = { v: 1, h, k: owner.p.pub };
    const dl = { ...body, g: owner.p.keypair.signIdentity(roomSignBytes('hkey', PAGE_ROOM, '', body)) };
    expect(base()?.houseAt(sim.node!.pub, 1), sim.label).toBe(true);
    expect(base()?.houseAt(h, 1), sim.label).toBe(false);
    D.cheats = true;
    D.p.doc.transact(() => top.set(delegationKey(h), dl));
    expect(base()?.houseAt(h, 1), sim.label).toBe(true);
    D.p.doc.transact(() => top.delete(delegationKey(h)));
    expect(base()?.houseAt(h, 1), sim.label).toBe(false);
    expect(base()?.houseAt(sim.node!.pub, 1), sim.label).toBe(true);
  }, TIMEOUT);

  for (const what of ['delegation', 'transfer'] as const) {
    it(what === 'delegation'
      ? "holds the buyer's house's delegation its count uses while the doc has lost the record (as a page does, casinoDoc keepHouses): the rounds that house revealed stay counted"
      : "holds the transfer its chain stands on while the doc has lost the record (as a page does, casinoDoc keepStanding): the game stays the buyer's, and its house's rounds counted", async () => {
      const sim = await Sim.open({ name: `fair-only-lost-${what}`, seed: seed(what === 'delegation' ? 1231 : 1233), pages: named('ABCD'), houseNode: true, fairOnly: true });
      await sim.run(30_000);
      const [, buyer, , D] = sim.pages;
      expect(await sim.handOver(buyer), sim.label).toEqual({ ok: true });
      while (sim.elapsed < RUN_MS && sim.node2!.wrote.reveals === 0) await sim.run(200);
      expect(sim.node2!.wrote.reveals, sim.label).toBeGreaterThan(0);
      // (Its house has signed no checkpoint yet: the record in the room is the only copy.)
      expect(sim.node2!.trims + sim.node2!.sweeps + sim.node2!.ends, sim.label).toBe(0);
      expect(sim.adoptionsWritten, sim.label).toBe(0);
      await sim.run(1_000);
      const top = D.p.doc.getMap<unknown>('casinoComputed');
      const keys = what === 'delegation' ? [delegationKey(sim.node2!.pub)] : [...top.keys()].filter((k) => k.startsWith('xf:'));
      expect(keys, sim.label).toHaveLength(1);
      const [key] = keys;
      expect(top.has(key), sim.label).toBe(true);
      // (The buyer's page asleep: neither it nor its node can put the record back.)
      sim.sleep(buyer, false);
      await sim.run(1_000);
      // The record goes from page D's doc (by its own hand, so the moment is exact: a page that holds it
      // puts it back within the second): the oracle's count of that doc, read at once, stands as it stood.
      sim.enter(D);
      expect(sim.ledgerProblems(D), sim.label).toEqual([]);
      D.cheats = true;
      D.p.doc.transact(() => top.delete(key));
      expect(top.has(key), sim.label).toBe(false);
      expect(sim.ledgerProblems(D), sim.label).toEqual([]);
      expect(sim.cageProblems(D), sim.label).toEqual([]);
      sim.wake(buyer);
      await sim.run(10_000);
      await sim.syncAll();
      expect(top.has(key), sim.label).toBe(true);
      expect(sim.violations, sim.label).toEqual([]);
    }, TIMEOUT);
  }

  it("holds no checkpoint that came and went while the page's doc held part of an update (the page never counted from it), and holds one that was there when the rest came", async () => {
    const sim = await Sim.open({ name: 'fair-only-parked-ck', seed: seed(1219), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const T = 'roulette-1';
    const A = sim.pages.find((sp) => sp.name === 'A')!;
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    while (sim.elapsed < RUN_MS && sim.node!.trims < 1) await sim.run(2_000);
    sim.heal();
    await sim.quiet(120_000);
    sim.nodeUp = false;
    await sim.syncAll();
    sim.enter(A);
    const inc = A.p.casino.computedIncOf(T)!;
    const real = A.p.casino.computedResolutionOf(T, inc)!.base!;
    const ctx = sim.ctxOf(T, inc);
    // A checkpoint that outranks the base (one sweep on) and pays B a thousand chips, under the house's key.
    const { g: _g, ...body } = real.ck;
    const secret = (sim.node as unknown as { secret: Uint8Array }).secret;
    const paying = (chips: bigint) => sealCk(
      ctx, { ...body, b: A.p.fold.nextSid3(ctx, real.ck), w: (real.ck.w ?? 0) + 1, n: { ...real.ck.n, [B.pid]: (BigInt(real.ck.n[B.pid] ?? '0') + chips).toString() } },
      (bytes) => houseSign(secret, bytes),
    );
    const better = paying(1000n);
    // Two writers the room never heard: one whose second update comes before its first (the doc holds part
    // until then), one that writes the checkpoint and deletes it meanwhile.
    const state = Y.encodeStateAsUpdate(A.p.doc);
    const updatesOf = (writes: ((doc: Y.Doc) => void)[]): Uint8Array[] => {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      const out: Uint8Array[] = [];
      doc.on('update', (u: Uint8Array) => out.push(u));
      for (const w of writes) doc.transact(() => w(doc));
      return out;
    };
    const [first, second] = updatesOf([(d) => d.getMap('scratch').set('a', 1), (d) => d.getMap('scratch').set('b', 2)]);
    const [came, went] = updatesOf([(d) => d.getMap('casinoComputed').set(better.key, better.value), (d) => d.getMap('casinoComputed').delete(better.key)]);
    const partial = (): boolean => (A.p.doc.store as unknown as { pendingStructs: unknown }).pendingStructs !== null;
    A.cheats = true;
    Y.applyUpdate(A.p.doc, second);
    expect(partial(), sim.label).toBe(true);
    Y.applyUpdate(A.p.doc, came);
    expect(A.p.doc.getMap('casinoComputed').has(better.key), sim.label).toBe(true);
    Y.applyUpdate(A.p.doc, went);
    expect(partial(), sim.label).toBe(true);
    Y.applyUpdate(A.p.doc, first);
    expect(partial(), sim.label).toBe(false);
    sim.enter(A);
    expect(A.p.casino.computedResolutionOf(T, inc)?.base?.key, sim.label).toBe(real.key);
    expect(sim.ledgerProblems(A), sim.label).toEqual([]);
    expect(sim.cageProblems(A), sim.label).toEqual([]);
    // One still there when the rest comes, and gone in the next write: the page counted from it when the rest
    // came, or had not yet (it checks what came meanwhile when it next counts the game); the oracle with it.
    const [first1, second1] = updatesOf([(d) => d.getMap('scratch').set('e', 1), (d) => d.getMap('scratch').set('f', 2)]);
    // (Another one, which the page has checked no signature of.)
    const other = paying(2000n);
    const [came1, went1] = updatesOf([(d) => d.getMap('casinoComputed').set(other.key, other.value), (d) => d.getMap('casinoComputed').delete(other.key)]);
    Y.applyUpdate(A.p.doc, second1);
    Y.applyUpdate(A.p.doc, came1);
    Y.applyUpdate(A.p.doc, first1);
    expect(partial(), sim.label).toBe(false);
    Y.applyUpdate(A.p.doc, went1);
    sim.enter(A);
    expect(sim.ledgerProblems(A), sim.label).toEqual([]);
    expect(sim.cageProblems(A), sim.label).toEqual([]);
    // …and one still there when the rest of the update comes is counted from when the page next counts the
    // game (at once, or frames on), and held when it goes: the page's count, and the oracle's with it.
    const [first2, second2] = updatesOf([(d) => d.getMap('scratch').set('c', 1), (d) => d.getMap('scratch').set('d', 2)]);
    const [came2] = updatesOf([(d) => d.getMap('casinoComputed').set(better.key, better.value)]);
    Y.applyUpdate(A.p.doc, second2);
    expect(partial(), sim.label).toBe(true);
    Y.applyUpdate(A.p.doc, came2);
    Y.applyUpdate(A.p.doc, first2);
    expect(partial(), sim.label).toBe(false);
    const from = sim.elapsed;
    const counted = (): boolean => (sim.enter(A), A.p.casino.computedResolutionOf(T, inc)?.base?.key === better.key);
    do await sim.run(500); while (sim.elapsed < from + 30_000 && !counted());
    expect(counted(), sim.label).toBe(true);
    A.p.doc.transact(() => A.p.doc.getMap('casinoComputed').delete(better.key));
    expect(A.p.doc.getMap('casinoComputed').has(better.key), sim.label).toBe(false);
    sim.enter(A);
    expect(A.p.casino.computedResolutionOf(T, inc)?.base?.key, sim.label).toBe(better.key);
    expect(sim.ledgerProblems(A), sim.label).toEqual([]);
    expect(sim.cageProblems(A), sim.label).toEqual([]);
  }, TIMEOUT);

  it('reads past an old checkpoint laid back in and a higher one the house did not sign, as the pages do', async () => {
    const sim = await Sim.open({ name: 'fair-only-stray-cks', seed: seed(1216), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const T = 'roulette-1';
    const A = sim.pages.find((sp) => sp.name === 'A')!;
    const B = sim.pages.find((sp) => sp.name === 'B')!;
    const top = B.p.doc.getMap<unknown>('casinoComputed');
    const cks = (): [string, CkRec][] => {
      const inc = B.p.casino.computedIncOf(T);
      return [...top.entries()].filter(([k]) => inc !== null && k.startsWith(`ck:${T}:${inc}:`)).map(([k, v]): [string, CkRec] => [k, v as CkRec])
        .sort((a, b) => a[1].u - b[1].u);
    };
    // The house's first checkpoint, kept from the doc; then on until a later one has replaced it.
    let old: [string, CkRec] | null = null;
    while (sim.elapsed < RUN_MS && !(old && cks().every(([k, ck]) => k !== old![0] && ck.u > old![1].u))) {
      await sim.run(2_000);
      old ??= cks().find(([, ck]) => ck.u > 0) ?? null;
    }
    expect(old, sim.label).not.toBeNull();
    sim.heal();
    await sim.quiet(120_000);
    // (The house away, so no trim of its own clears the strays before they are read.)
    sim.nodeUp = false;
    await sim.syncAll();
    const inc = B.p.casino.computedIncOf(T)!;
    const [realKey, real] = cks()[cks().length - 1];
    expect(real.u, sim.label).toBeGreaterThan(old![1].u);
    // One round past the real base and a thousand chips to page B, the house's key named, signed by page B.
    const { g: _g, ...body } = real;
    const forged = sealCk({ room: sim.ctxOf(T, inc).room, t: T, inc }, { ...body, u: real.u + 1, n: { ...real.n, [B.pid]: (BigInt(real.n[B.pid] ?? '0') + 1000n).toString() } }, (bytes) => B.p.keypair.signIdentity(bytes));
    B.cheats = true;
    B.p.doc.transact(() => {
      top.set(old![0], old![1]);
      top.set(forged.key, forged.value);
    });
    await sim.run(2_000);
    await sim.syncAll();
    const held = A.p.doc.getMap<unknown>('casinoComputed');
    expect(held.has(old![0]) && held.has(forged.key) && held.has(realKey), sim.label).toBe(true);
    sim.enter(A);
    expect(A.p.casino.computedResolutionOf(T, inc)?.base?.key, sim.label).toBe(realKey);
    expect(sim.ledgerProblems(A), sim.label).toEqual([]);
    expect(sim.cageProblems(A), sim.label).toEqual([]);
    expect(sim.gameProblems(), sim.label).toEqual([]);
    expect(sim.violations, sim.label).toEqual([]);
  }, TIMEOUT);
});
