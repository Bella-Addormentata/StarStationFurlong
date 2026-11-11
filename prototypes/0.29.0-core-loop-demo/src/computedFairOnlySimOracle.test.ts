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
 * back in or by one the house did not sign, as the pages' is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sealCk } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import { RUN_MS as CRAPS_RUN_MS, T as CRAPS, TIMEOUT as CRAPS_TIMEOUT } from './computedCrapsSimKit';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import type { PageSpec } from './computedSim';

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
    B.p.doc.getMap('casinoComputed').set(`ck:roulette-1:${inc}:${'0'.repeat(16)}`, { v: 1, b: 'g', k: 'nobody' });
    await sim.run(2_000);
    expect(sim.violations.some((v) => /B wrote the checkpoint .* which no house signed/.test(v)), sim.violations.join('\n')).toBe(true);
  }, TIMEOUT);
});

describe("the oracle's own base rule", () => {
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
