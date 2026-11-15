/**
 * 🧪🔒🤝 A FAIR ONLY game moves with the room's deed, end to end over the
 * simulated network (computedSim.ts; design §8.7, §8.5 N1; PR 6c-5c-2): the
 * page that holds the deed makes an offer out to another page's key, that
 * page redeems it (offers redeemDeedOffer, which writes the game's transfer:
 * computedTable adoptFairOnlyGames), and the buyer's own node becomes the
 * game's house. The seller's house reveals what is left of the seller's
 * rounds and no more; the buyer's joins from the round after.
 *
 * Each scenario ends in the shared finish (computedFairOnlySimKit): every
 * chip where the honest folds put it, and every checkpoint (the seller's
 * house's, the buyer's adoption, the buyer's house's) held to the oracle.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import type { PageSpec } from './computedSim';
import { fairOnlyFinish, inFlight, lines, pressEnd, rouletteFinish } from './computedFairOnlySimKit';

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
const ROULETTE = 'roulette-1';
const seed = (n: number): number => n + SIM_SEED_OFFSET;
const named = (names: string, extra: Partial<PageSpec> = {}): PageSpec[] => names.split('').map((name) => ({ name, ...extra }));
afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

/** The deed goes to page B once, from `from` ms into the run, at the first tick where `when()`. When it went. */
function handOverAt(sim: Sim, from: number, when: () => boolean, opts: { node?: boolean | 'same' } = {}): { at: number | null; said: { ok: boolean } | null } {
  const out: { at: number | null; said: { ok: boolean } | null } = { at: null, said: null };
  sim.every(async () => {
    if (out.at !== null || sim.elapsed < from || !when()) return;
    out.at = sim.elapsed;
    out.said = await sim.handOver(sim.pages[1], opts);
  });
  return out;
}

/** Whether a round of the game at `t` is in flight as the buyer's page (B) reads it:
 *  a close of the open round the fold took (`tip`), which is what the transfer's
 *  round goes by; or, for a quiet table, none on its page nor on the holder's. */
function flightOnBuyer(sim: Sim, t: string): 'tip' | 'quiet' | 'between' {
  const sp = sim.pages[1];
  sim.enter(sp);
  const res = sp.p.casino.computedFoldOf(t);
  if (!res || res.pending) return 'between';
  if (res.tip !== null) return 'tip';
  return res.openCloses.some((c) => c.state !== 'invalid') || inFlight(sim, t) ? 'between' : 'quiet';
}

/** The game's name at `t`, and who every page up reads as its holder. */
function holders(sim: Sim, t: string): string[] {
  const inc = sim.house.p.casino.computedIncOf(t)!;
  return sim.pages.filter((sp) => sp.mode === 'up').map((sp) => {
    sim.enter(sp);
    return sp.p.casino.computedResolutionOf(t, inc)?.holder ?? 'none';
  });
}

describe('FAIR ONLY roulette: the game moves with the deed, and the buyer\'s house plays on', () => {
  for (const mid of [false, true]) {
    it(mid
      ? 'handed over with a round in flight: the seller\'s house reveals that round and nothing after, and the buyer\'s joins from the next'
      : 'handed over on a quiet table: the seller\'s house writes nothing more, the round that names its commitment is voided, once, and the buyer\'s house plays on', async () => {
      const sim = await Sim.open({ name: `fair-only-hand-over-${mid ? 'mid' : 'quiet'}`, seed: seed(mid ? 1403 : 1401), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
      const went = handOverAt(sim, 60_000, () => flightOnBuyer(sim, ROULETTE) === (mid ? 'tip' : 'quiet'));
      let before: { joins: number; reveals: number } | null = null;
      sim.every(() => { if (went.at === null) before = { joins: sim.node!.wrote.joins, reveals: sim.node!.wrote.reveals }; });
      await sim.run(RUN_MS);
      // (The table waits out the one round nobody can reveal: the bettors' abandon.)
      const s = await rouletteFinish(sim, { houseAway: true });
      fairOnlyFinish(sim, s);
      expect(went.said, sim.label).toEqual({ ok: true });
      const buyer = sim.pages[1];
      expect(holders(sim, ROULETTE), sim.label).toEqual(sim.pages.filter((sp) => sp.mode === 'up').map(() => buyer.p.pub));
      // The seller's house: the round in flight, if any, and nothing after. The buyer's decided rounds.
      expect(sim.node!.wrote.joins, sim.label).toBe(before!.joins);
      expect(sim.node!.wrote.reveals - before!.reveals, sim.label).toBe(mid ? 1 : 0);
      expect(sim.node!.wrote.stepDowns, sim.label).toBe(0);
      expect(sim.node2!.wrote.reveals, sim.label).toBeGreaterThanOrEqual(2);
      expect(sim.node2!.trims, sim.label).toBeGreaterThanOrEqual(1);
      // (At most the one: the round on the commitment the seller's house's last reveal carried.)
      if (mid) expect(s.voids, sim.label).toBeLessThanOrEqual(1);
      else expect(s.voids, sim.label).toBe(1);
      expect(s.worstStallMs, `${sim.label} ${sim.worstStall.at}`).toBeLessThanOrEqual(buyer.p.table.ABANDON_MS + 2 * buyer.p.table.GRACE_MAX_MS);
    }, TIMEOUT);
  }

  it('the seller\'s house away as the game is handed over with a round in flight: the bettors void that round, and the buyer\'s house plays on', async () => {
    const sim = await Sim.open({ name: 'fair-only-hand-over-away', seed: seed(1405), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    let down = false;
    sim.every(() => {
      if (down || sim.elapsed < 60_000 || !inFlight(sim, ROULETTE)) return;
      sim.nodeUp = false;
      down = true;
    });
    const went = handOverAt(sim, 60_000, () => down && flightOnBuyer(sim, ROULETTE) === 'tip');
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s);
    expect(went.said, sim.label).toEqual({ ok: true });
    const buyer = sim.pages[1];
    expect(holders(sim, ROULETTE), sim.label).toEqual(sim.pages.filter((sp) => sp.mode === 'up').map(() => buyer.p.pub));
    expect(s.voids, sim.label).toBe(1);
    expect(sim.node2!.wrote.reveals, sim.label).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);
});

describe('FAIR ONLY roulette: the seller\'s node goes with the room', () => {
  for (const mid of [false, true]) {
    it(`handed over ${mid ? 'with a round in flight' : 'on a quiet table'} to a buyer who runs the seller's node (one house key, delegated by each in turn): no round is lost, and the node plays on for the buyer`, async () => {
      const sim = await Sim.open({ name: `fair-only-hand-over-same-${mid ? 'mid' : 'quiet'}`, seed: seed(mid ? 1413 : 1411), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
      const went = handOverAt(sim, 60_000, () => flightOnBuyer(sim, ROULETTE) === (mid ? 'tip' : 'quiet'), { node: 'same' });
      let before: { joins: number; reveals: number; cks: number } | null = null;
      sim.every(() => { if (went.at === null) before = { joins: sim.node!.wrote.joins, reveals: sim.node!.wrote.reveals, cks: sim.node!.trims + sim.node!.sweeps }; });
      await sim.run(RUN_MS);
      const s = await rouletteFinish(sim);
      fairOnlyFinish(sim, s);
      expect(went.said, sim.label).toEqual({ ok: true });
      const buyer = sim.pages[1];
      expect(holders(sim, ROULETTE), sim.label).toEqual(sim.pages.filter((sp) => sp.mode === 'up').map(() => buyer.p.pub));
      expect(sim.node2, sim.label).toBe(sim.node);
      // The commitment its last reveal for the seller carried is its own, and the buyer delegates it: the round on it is played.
      expect(s.voids, sim.label).toBe(0);
      if (!mid) expect(sim.node!.wrote.joins, sim.label).toBe(before!.joins);
      expect(sim.node!.wrote.reveals, sim.label).toBeGreaterThanOrEqual(before!.reveals + 2);
      expect(sim.node!.trims + sim.node!.sweeps, sim.label).toBeGreaterThan(before!.cks);
      expect(sim.adoptionsWritten + sim.node!.trims, sim.label).toBeGreaterThan(0);
    }, TIMEOUT);
  }
});

describe('FAIR ONLY roulette: the buyer ends the game it took', () => {
  it('a buyer with no house: the table waits, and the buyer\'s page ends the game, its own end at the round it holds the game from', async () => {
    const sim = await Sim.open({ name: 'fair-only-hand-over-no-house', seed: seed(1407), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const went = handOverAt(sim, 60_000, () => flightOnBuyer(sim, ROULETTE) === 'quiet', { node: false });
    const end = pressEnd(sim, ROULETTE, 'roulette', 120_000, () => went.at !== null, false, () => sim.pages[1]);
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s, [ROULETTE]);
    expect(went.said, sim.label).toEqual({ ok: true });
    expect(sim.node2, sim.label).toBeNull();
    expect(end.said[end.said.length - 1], sim.label).toBe('ok');
    expect(end.over, sim.label).not.toBeNull();
    expect(sim.ownerEndsWritten, sim.label).toBe(1);
    expect(sim.node!.ends, sim.label).toBe(0);
  }, TIMEOUT);

  it('a buyer with its house, pressed while a round is in flight: the end order alone, the buyer\'s house decides the round, and its end counts it', async () => {
    const sim = await Sim.open({ name: 'fair-only-hand-over-end-mid', seed: seed(1409), pages: named('ABCD'), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const went = handOverAt(sim, 60_000, () => flightOnBuyer(sim, ROULETTE) === 'quiet');
    // (Pressed at a round the buyer's house joined: past the one that names the seller's house's commitment.)
    const end = pressEnd(sim, ROULETTE, 'roulette', 120_000, () => went.at !== null && (sim.node2?.wrote.reveals ?? 0) >= 1 && flightOnBuyer(sim, ROULETTE) === 'tip', true, () => sim.pages[1]);
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s, [ROULETTE]);
    expect(end.said, sim.label).toEqual(['ending']);
    expect(end.over, sim.label).not.toBeNull();
    expect(sim.node2!.ends, sim.label).toBe(1);
    expect(sim.node!.ends + sim.ownerEndsWritten, sim.label).toBe(0);
  }, TIMEOUT);
});
