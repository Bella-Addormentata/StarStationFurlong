/**
 * 🧪🔒🏠🏠 Two houses at a FAIR ONLY game, end to end over the simulated
 * network (computedSim.ts; design §8.7 "Two houses", §16.3; PR 6c-5d-1): the
 * room's deed holder runs a node on each of two machines (page E is the
 * holder's second machine: the same key and player, a node of its own), each
 * machine's page delegates its own node's key, and both nodes serve the game.
 *
 * What they show. One house to a round, and in practice one house to a game:
 * the house whose join the first close named reveals it, its reveal carries
 * its commitment for the next round, and so on; the other writes nothing
 * but its beat. The other takes the game when the first steps down (no
 * round lost), or when a round of the first's is voided by a bettor (the
 * first stopped with a round in flight). It does not take over a commitment
 * left between rounds: the table waits for the house that made it (design
 * addendum 1b, limit 4). Split apart with a round in flight, each side plays
 * on with its own house, and the heal keeps one line (the limit the house
 * tables have: TODO.md "Computed casino tables", splits).
 *
 * Each scenario ends in the shared finish (computedFairOnlySimKit): every
 * chip where the honest folds put it, and every checkpoint held to the oracle.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import type { PageSpec } from './computedSim';
import type { SimHouse } from './computedSimHouse';
import { fairOnlyFinish, lines, rouletteFinish } from './computedFairOnlySimKit';

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
/** Pages A to D, and E: the holder's (A's) second machine, with a node of its own and nobody betting at it. */
const room = (): PageSpec[] => [...'ABCD'.split('').map((name) => ({ name })), { name: 'E', pid: 'player-A', identity: 'A', node: true, bot: null }];
afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

/** The house that plays the game now (the one whose reveals decide its rounds) and the other. */
function playing(sim: Sim): { on: SimHouse; idle: SimHouse } {
  const [a, b] = sim.nodes;
  return a.wrote.reveals >= b.wrote.reveals ? { on: a, idle: b } : { on: b, idle: a };
}

/** What the rounds are like on the holder's page: one in flight, or the table quiet. */
function flight(sim: Sim): 'tip' | 'quiet' | 'between' {
  const sp = sim.house;
  sim.enter(sp);
  const res = sp.p.casino.computedFoldOf(ROULETTE);
  if (!res || res.pending) return 'between';
  if (res.tip !== null) return 'tip';
  return res.openCloses.some((c) => c.state !== 'invalid') ? 'between' : 'quiet';
}

/** `fn` once, at the first tick from `from` ms into the run where `when()`. When. */
function once(sim: Sim, from: number, when: () => boolean, fn: () => void): { at: number | null } {
  const out: { at: number | null } = { at: null };
  sim.every(() => {
    if (out.at !== null || sim.elapsed < from || !when()) return;
    out.at = sim.elapsed;
    fn();
  });
  return out;
}

const two = (sim: Sim): string => sim.nodes.map((n) => `${JSON.stringify(n.wrote)} trims ${n.trims}`).join(' / ');

describe('FAIR ONLY roulette: two houses of one holder', () => {
  it('both up: one house plays every round, and the other writes no more than a join of the first', async () => {
    const sim = await Sim.open({ name: 'fair-only-two-houses', seed: seed(1501), pages: room(), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    const { on, idle } = playing(sim);
    lines.push(`both up: ${two(sim)}; voids ${s.voids}`);
    expect(on.wrote.reveals, sim.label).toBeGreaterThanOrEqual(3);
    expect(idle.wrote.reveals, sim.label).toBe(0);
    expect(idle.wrote.joins, sim.label).toBeLessThanOrEqual(1);
    expect(on.wrote.joins, sim.label).toBe(1);
    expect(idle.trims, sim.label).toBe(0);
    expect(s.voids, sim.label).toBe(0);
  }, TIMEOUT);

  it('the house that does not play stops and starts again: nothing waits for it', async () => {
    const sim = await Sim.open({ name: 'fair-only-two-houses-idle-away', seed: seed(1503), pages: room(), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    let idle: SimHouse | null = null;
    sim.at(60_000, () => { idle = playing(sim).idle; sim.runs(idle, false); });
    sim.at(120_000, () => sim.runs(idle!, true));
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    lines.push(`idle away: ${two(sim)}; voids ${s.voids}`);
    expect(idle!.wrote.reveals, sim.label).toBe(0);
    expect(s.voids, sim.label).toBe(0);
  }, TIMEOUT);

  it('the house that plays stops for good with a round in flight: the bettors void that round, and the other house plays on', async () => {
    const sim = await Sim.open({ name: 'fair-only-two-houses-takeover', seed: seed(1505), pages: room(), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    let was: SimHouse | null = null;
    let before = 0;
    const went = once(sim, 60_000, () => flight(sim) === 'tip', () => { was = playing(sim).on; before = was.wrote.reveals; sim.runs(was, false); });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s);
    lines.push(`takeover: ${two(sim)}; voids ${s.voids}`);
    expect(went.at, sim.label).not.toBeNull();
    const other = sim.nodes.find((n) => n !== was)!;
    expect(was!.wrote.reveals, sim.label).toBe(before);
    expect(s.voids, sim.label).toBe(1);
    expect(other.wrote.reveals, sim.label).toBeGreaterThanOrEqual(2);
    expect(other.trims, sim.label).toBeGreaterThanOrEqual(1);
    expect(s.worstStallMs, `${sim.label} ${sim.worstStall.at}`).toBeLessThanOrEqual(sim.house.p.table.ABANDON_MS + 2 * sim.house.p.table.GRACE_MAX_MS);
  }, TIMEOUT);

  it('the house that plays stops between rounds for 40 s: the table waits for it, the other house up, and plays on when it is back (the limit: no takeover of a commitment)', async () => {
    const sim = await Sim.open({ name: 'fair-only-two-houses-wait', seed: seed(1507), pages: room(), houseNode: true, fairOnly: true });
    // (The bots' usual pace: with nobody to trim it, what they lay on the felt while the table waits stays in the session.)
    let was: SimHouse | null = null;
    const went = once(sim, 60_000, () => flight(sim) === 'quiet', () => { was = playing(sim).on; sim.runs(was, false); });
    let other = 0;
    let atReturn = 0;
    const back = once(sim, 60_000, () => went.at !== null && sim.elapsed >= went.at + 40_000, () => { other = sim.nodes.find((n) => n !== was)!.wrote.reveals; atReturn = was!.wrote.reveals; sim.runs(was!, true); });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true });
    fairOnlyFinish(sim, s);
    lines.push(`wait: ${two(sim)}; voids ${s.voids}; stall ${s.worstStallMs}`);
    expect(back.at, sim.label).not.toBeNull();
    expect(other, sim.label).toBe(0);
    expect(sim.nodes.find((n) => n !== was)!.wrote.reveals, sim.label).toBe(0);
    expect(s.voids, sim.label).toBe(0);
    expect(s.worstStallMs, sim.label).toBeGreaterThanOrEqual(35_000);
    expect(was!.wrote.reveals, sim.label).toBeGreaterThan(atReturn);
  }, TIMEOUT);

  it('the house that plays steps down as its node shuts down: the other house joins the next round (a round is lost only where a close named the commitment as it was stepped down)', async () => {
    const sim = await Sim.open({ name: 'fair-only-two-houses-step-down', seed: seed(1509), pages: room(), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    let was: SimHouse | null = null;
    sim.at(60_000, () => { was = playing(sim).on; was.steppingDown = true; });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    lines.push(`step down: ${two(sim)}; voids ${s.voids}`);
    const other = sim.nodes.find((n) => n !== was)!;
    expect(s.voids, sim.label).toBeLessThanOrEqual(1);
    expect(other.wrote.reveals, sim.label).toBeGreaterThanOrEqual(2);
  }, TIMEOUT);

  it('the room splits for 90 s with a round in flight, a house on each side: the side without the playing house voids that round and its own house plays on; healed, the room is on one line again, and the other line\'s rounds read otherwise on the pages that showed them (the limit: a split with a house on each side)', async () => {
    const sim = await Sim.open({ name: 'fair-only-two-houses-split-mid', seed: seed(1511), pages: room(), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const sides = [['A', 'B'], ['C', 'D', 'E']];
    let was: SimHouse | null = null;
    let other: SimHouse | null = null;
    let apart = { reveals: 0, cks: 0 };
    const went = once(sim, 60_000, () => flight(sim) === 'tip', () => {
      was = playing(sim).on;
      other = sim.nodes.find((n) => n !== was)!;
      expect(other.wrote.reveals, sim.label).toBe(0);
      sim.net.groups = sides;
    });
    const healed = once(sim, 60_000, () => went.at !== null && sim.elapsed >= went.at + 90_000, () => {
      apart = { reveals: other!.wrote.reveals, cks: other!.trims + other!.sweeps };
      sim.net.groups = null;
    });
    await sim.run(RUN_MS);
    // Scoped, as the house tables' split is (computedSim.test.ts 'split with trims'): the higher
    // checkpoint stands, and the other side's rounds since the split are undone or replaced.
    const s = await rouletteFinish(sim, { houseAway: true, flips: ['other branch', 'checkpoint', 'undone', 'rival close', 'void undone'] });
    fairOnlyFinish(sim, s);
    lines.push(`split mid: ${two(sim)}; voids ${s.voids} flips ${JSON.stringify(s.flips)}`);
    expect(healed.at, sim.label).not.toBeNull();
    // Each side had a house that decided rounds while apart.
    expect(apart.reveals, sim.label).toBeGreaterThanOrEqual(1);
    // The pages of one side only read rounds otherwise.
    const flipped = sim.pages.filter((sp) => (s.flips[sp.name] ?? 0) > 0).map((sp) => sp.name);
    expect(flipped.length, sim.label).toBeGreaterThan(0);
    expect(sides.some((side) => flipped.every((n) => side.includes(n))), `${sim.label} ${flipped}`).toBe(true);
  }, TIMEOUT);

  it('the room splits for 40 s between rounds, a house on each side: the side without the playing house waits, or (a close written while it still heard that house) voids one round and plays on; healed, the room is on one line', async () => {
    const sim = await Sim.open({ name: 'fair-only-two-houses-split-quiet', seed: seed(1513), pages: room(), houseNode: true, fairOnly: true, bot: HEAVY_BOT });
    const sides = [['A', 'B'], ['C', 'D', 'E']];
    const went = once(sim, 60_000, () => flight(sim) === 'quiet', () => { sim.net.groups = sides; });
    const healed = once(sim, 60_000, () => went.at !== null && sim.elapsed >= went.at + 40_000, () => { sim.net.groups = null; });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { houseAway: true, flips: ['other branch', 'checkpoint', 'undone', 'rival close', 'void undone'] });
    fairOnlyFinish(sim, s);
    lines.push(`split quiet: ${two(sim)}; voids ${s.voids} flips ${JSON.stringify(s.flips)}`);
    expect(healed.at, sim.label).not.toBeNull();
    const flipped = sim.pages.filter((sp) => (s.flips[sp.name] ?? 0) > 0).map((sp) => sp.name);
    expect(sides.some((side) => flipped.every((n) => side.includes(n))), `${sim.label} ${flipped}`).toBe(true);
  }, TIMEOUT);
});
