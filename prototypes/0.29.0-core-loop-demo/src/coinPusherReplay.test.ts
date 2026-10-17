/**
 * 🪙 Coin pusher replay tests: every chip has a pose at every moment of a
 * drop — on the board, down the chute, standing, tipping, stepping down,
 * into the tray — and the replay ends on the machine as published.
 */

import { describe, expect, it } from 'vitest';
import {
  CHIP_R, chipsInMachine, currentPusherPhase, initialCoinPusherState, processInsert, PUSHER_PERIOD_MS, simulateBoard,
  type CoinPusherState, type DropTrace, type PusherDropMark, type PusherHole,
} from './games/coinPusher';
import {
  cabinetView, PAY_MS, planDrops, planReplay, reachBelow, replayView, restingView, TIP_MS, type ReplayGeometry,
} from './coinPusherReplay';

const GEOM: ReplayGeometry = { lowerDrop: 0.2, trayDrop: 0.31, level: 0.0088 };

function fill(n: number): CoinPusherState {
  let s = initialCoinPusherState('owner', 0);
  for (let i = 0; i < n; i++) s = processInsert(s, 'p', (i % 3) as PusherHole, (i * 0.37) % 1, i * 7919).state;
  return s;
}

function traced(before: CoinPusherState, hole: PusherHole, phase: number, seed: number) {
  const r = processInsert(before, 'p', hole, phase, seed, true);
  return { r, trace: r.trace as DropTrace };
}

describe('coin pusher replay', () => {
  it('shows the coin on the board, then down the chute, then standing on the table', () => {
    const before = fill(30);
    const { r, trace } = traced(before, 1, 0.2, 77);
    const plan = planReplay(before, trace, GEOM);
    const onBoard = replayView(plan, trace.fallMs / 2);
    expect(onBoard.board?.chipId).toBe(r.chipId);
    expect(onBoard.chute).toBeNull();
    expect(onBoard.table.some((p) => p.chipId === r.chipId)).toBe(false);
    // The rest of the table is as it was.
    expect(onBoard.table).toEqual(restingView(before, GEOM));

    const chute = replayView(plan, (trace.fallMs + trace.landMs) / 2);
    expect(chute.board).toBeNull();
    expect(chute.chute).toMatchObject({ chipId: r.chipId, landX: trace.landX, landU: trace.landU });
    expect(chute.chute!.s).toBeGreaterThan(0);
    expect(chute.chute!.s).toBeLessThan(1);

    const landed = replayView(plan, trace.landMs);
    expect(landed.table.find((p) => p.chipId === r.chipId)).toMatchObject({ tip: 1, x: trace.landX, u: trace.landU });
  });

  it('ends on the machine as published, and says so', () => {
    const before = fill(90);
    const { r, trace } = traced(before, 2, 0.55, 4);
    const plan = planReplay(before, trace, GEOM);
    const end = replayView(plan, plan.endMs);
    expect(end.done).toBe(true);
    expect(end.board).toBeNull();
    expect(end.chute).toBeNull();
    const sort = (ps: { chipId: number }[]) => [...ps].sort((a, b) => a.chipId - b.chipId);
    expect(sort(end.table)).toEqual(sort(restingView(r.state, GEOM)));
    expect(replayView(plan, plan.endMs - 1).done).toBe(false);
  });

  it('draws a pushed coin tipping over, not snapping flat', () => {
    // Land the coin with the bar on its way back, so the bar comes forward
    // and knocks it over during the replay.
    const before = initialCoinPusherState('owner', 0);
    let found: { r: ReturnType<typeof processInsert>; trace: DropTrace } | null = null;
    for (let i = 0; i < 200 && !found; i++) {
      const phase = i / 200;
      const land = (phase + (simulateBoard(1, phase, 9).fallMs + 160) / PUSHER_PERIOD_MS) % 1;
      if (land > 0.6 && land < 0.9) found = traced(before, 1, phase, 9);
    }
    const { r, trace } = found!;
    const plan = planReplay(before, trace, GEOM);
    const tip = plan.transitions.get(r.chipId)!.find((t) => t.kind === 'tip')!;
    expect(tip.t).toBeGreaterThan(trace.landMs);
    const mid = replayView(plan, tip.t + TIP_MS / 2).table.find((p) => p.chipId === r.chipId)!;
    expect(mid.tip).toBeGreaterThan(0);
    expect(mid.tip).toBeLessThan(1);
    const after = replayView(plan, tip.t + TIP_MS).table.find((p) => p.chipId === r.chipId)!;
    expect(after.tip).toBe(0);
    // All the way over, the turned coin stays on top of the deck it stood
    // on and the chip it falls onto, never through them.
    const start = replayView(plan, tip.t).table.find((p) => p.chipId === r.chipId)!;
    const floor = Math.min(start.y - CHIP_R, after.y - GEOM.level / 2);
    for (let k = 0; k <= 20; k++) {
      const p = replayView(plan, tip.t + (TIP_MS * k) / 20).table.find((q) => q.chipId === r.chipId)!;
      expect(p.y - reachBelow(p.tip * Math.PI / 2, GEOM)).toBeGreaterThanOrEqual(floor - 1e-9);
    }
  });

  it('draws a coin knocked over as it lands tipping, not arriving flat', () => {
    // Drop after drop into one hole: a coin left standing is soon landed on.
    let before = initialCoinPusherState('owner', 0);
    let hit: { r: ReturnType<typeof processInsert>; trace: DropTrace } | null = null;
    for (let i = 0; i < 400 && !hit; i++) {
      const t = traced(before, 1, (i * 0.618) % 1, i);
      const first = t.trace.frames[0].upper.find((p) => p.chipIds.includes(t.r.chipId));
      if (!first?.standing) hit = t;
      else before = t.r.state;
    }
    const { r, trace } = hit!;
    const plan = planReplay(before, trace, GEOM);
    const tip = plan.transitions.get(r.chipId)!.find((t) => t.kind === 'tip')!;
    expect(tip.t).toBe(trace.landMs);
    const mid = replayView(plan, trace.landMs + TIP_MS / 2).table.find((p) => p.chipId === r.chipId)!;
    expect(mid.tip).toBeGreaterThan(0);
    expect(mid.tip).toBeLessThan(1);
  });

  it('drops paid chips into the tray, then lets them go', () => {
    let before = fill(120);
    let pay: { r: ReturnType<typeof processInsert>; trace: DropTrace } | null = null;
    for (let seed = 0; seed < 400 && !pay; seed++) {
      const t = traced(before, (seed % 3) as PusherHole, (seed * 0.618) % 1, seed);
      if (t.r.paid > 0) pay = t;
      else before = t.r.state;
    }
    const { r, trace } = pay!;
    const plan = planReplay(before, trace, GEOM);
    const chip = r.paidChipIds[0];
    const out = plan.transitions.get(chip)!.find((t) => t.kind === 'pay')!;
    const falling = replayView(plan, out.t + PAY_MS / 2).table.find((p) => p.chipId === chip)!;
    expect(falling.y).toBeLessThan(-GEOM.lowerDrop);
    expect(replayView(plan, out.t + PAY_MS).table.some((p) => p.chipId === chip)).toBe(false);
    expect(chipsInMachine(r.state)).toBe(chipsInMachine(before) + 1 - r.paid);
  });

  it('replays every drop settled between two frames, each from the one before', () => {
    // Three drops settled in one operator poll, as pusherCroupier writes them.
    const before = fill(40);
    let s = before;
    const at = 50_000;
    const marks: PusherDropMark[] = [];
    for (let i = 0; i < 3; i++) {
      const hole = i as PusherHole;
      const phase = currentPusherPhase(s, at + i);
      const seed = 100 + i;
      const r = processInsert(s, 'p', hole, phase, seed);
      marks.push({ chipId: r.chipId, hole, phase, atMs: at + i, seed });
      s = r.state;
    }
    const after: CoinPusherState = { ...s, recentDrops: marks };
    const plans = planDrops(before, after, GEOM)!;
    expect(plans.map((p) => p.plan.trace.chipId)).toEqual(marks.map((m) => m.chipId));
    for (const p of plans) expect(p.startMs).toBeCloseTo(at, -1);

    // All three coins are on the board at once, none on the table yet.
    const early = cabinetView(plans, at + 50).view!;
    expect(early.boards.map((b) => b.chipId).sort()).toEqual(marks.map((m) => m.chipId));
    expect(early.table.some((p) => marks.some((m) => m.chipId === p.chipId))).toBe(false);

    // Once the last coin lands, the table is the last drop's: it ran on the
    // machine the others left, and it ends on the machine as published.
    const last = plans[2];
    const landed = last.startMs + last.plan.trace.landMs;
    // (Less any coin of an earlier drop still falling: it is drawn there.)
    const atLanding = cabinetView(plans, landed).view!;
    const falling = new Set([...atLanding.boards, ...atLanding.chutes].map((c) => c.chipId));
    expect(atLanding.table).toEqual(
      replayView(last.plan, landed - last.startMs).table.filter((p) => !falling.has(p.chipId)));
    const end = last.startMs + last.plan.endMs;
    expect(cabinetView(plans, end - 1).view).not.toBeNull();
    const done = cabinetView(plans, end);
    expect(done.view).toBeNull();
    expect(done.live).toHaveLength(0);
    const sort = (ps: { chipId: number }[]) => [...ps].sort((a, b) => a.chipId - b.chipId);
    expect(sort(replayView(last.plan, last.plan.endMs).table)).toEqual(sort(restingView(after, GEOM)));
  });

  it("won't replay drops it can't: no seed on a mark, or a gap", () => {
    const before = fill(20);
    const r = processInsert(before, 'p', 1, 0.3, 9);
    const mark = { chipId: r.chipId, hole: 1 as PusherHole, phase: 0.3, atMs: 1_000, seed: 9 };
    expect(planDrops(before, { ...r.state, recentDrops: [mark] }, GEOM)).toHaveLength(1);
    expect(planDrops(before, { ...r.state, recentDrops: [{ chipId: r.chipId, hole: 1 }] }, GEOM)).toBeNull();
    expect(planDrops(fill(19), { ...r.state, recentDrops: [mark] }, GEOM)).toBeNull();
    expect(planDrops(r.state, r.state, GEOM)).toBeNull();
  });
});
