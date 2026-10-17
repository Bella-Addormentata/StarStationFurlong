/**
 * 🪙 Coin pusher replay tests: every chip has a pose at every moment of a
 * drop — on the board, down the chute, standing, tipping, stepping down,
 * into the tray — and the replay ends on the machine as published.
 */

import { describe, expect, it } from 'vitest';
import {
  CHIP_R, CHUTE_MS, chipsInMachine, ENTRY_MS, currentPusherPhase, emptyMachine, PLAT_LOW_FRONT, PLAT_UP_FRONT, pusherFaceX,
  RECENT_DROPS_MAX, initialCoinPusherState, processInsert, PUSHER_PERIOD_MS, simulateBoard,
  type CoinPusherState, type DropTrace, type PusherDropMark, type PusherHole,
} from './games/coinPusher';
import {
  cabinetView, CLOCK_SAMPLES, clockOffset, noteClock, PAY_MS, STEP_MS, planDrops, queueDrops, REPLAY_MAX, planReplay, reachBack, reachBelow, replayView, restingView, TIP_MS, type ReplayGeometry,
} from './coinPusherReplay';

const GEOM: ReplayGeometry = { lowerDrop: 0.2, trayDrop: 0.31, level: 0.0088, barTop: 0.08, boardExitX: -0.04, boardExitY: 0.18 };

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
    // First in through its front slot, flat, to the top of its hole.
    const goingIn = replayView(plan, trace.entryMs / 2);
    expect(goingIn.entry).toMatchObject({ chipId: r.chipId, s: 0.5, u: trace.board[0].u, h: trace.board[0].h });
    expect(goingIn.board).toBeNull();
    expect(goingIn.table.some((p) => p.chipId === r.chipId)).toBe(false);
    expect(trace.board[0].t).toBe(trace.entryMs);

    const onBoard = replayView(plan, (trace.entryMs + trace.fallMs) / 2);
    expect(onBoard.entry).toBeNull();
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
    const coin = landed.table.find((p) => p.chipId === r.chipId)!;
    expect(coin).toMatchObject({ tip: 1, u: trace.landU });
    expect(coin.x).toBeCloseTo(trace.landX, 3);
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
      const land = (phase + (ENTRY_MS + simulateBoard(1, phase, 9).fallMs + CHUTE_MS) / PUSHER_PERIOD_MS) % 1;
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
    const falling = replayView(plan, out.t + PAY_MS * 0.8).table.find((p) => p.chipId === chip)!;
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
    const early = cabinetView(plans, at + ENTRY_MS + 50).view!;
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

  const mod1 = (x: number): number => x - Math.floor(x);

  it("replays a drop on the viewer's own clock, however far it runs from the operator's", () => {
    const before = fill(30);
    const at = 80_000;
    const phase = currentPusherPhase(before, at);
    const r = processInsert(before, 'p', 1, phase, 77);
    const after: CoinPusherState = { ...r.state, recentDrops: [{ chipId: r.chipId, hole: 1, phase, atMs: at, seed: 77 }] };
    // The record reaches each viewer 300 ms after the settle, by the operator's clock.
    for (const skew of [0, -10 * 60_000, 10 * 60_000, 1_234]) {
      const seenAt = at + 300 + skew;
      const samples = noteClock([], before, after, seenAt);
      const [plan] = planDrops(before, after, GEOM, clockOffset(samples))!;
      // In step with the pusher this viewer draws (currentPusherPhase at its own clock)...
      expect(mod1(currentPusherPhase(after, plan.startMs) - phase + 0.5) - 0.5).toBeCloseTo(0, 6);
      // ...within half a sweep of when it arrived, so it plays out instead of
      // waiting minutes at its slot or being over before it's seen.
      expect(Math.abs(seenAt - plan.startMs)).toBeLessThanOrEqual(PUSHER_PERIOD_MS / 2);
      const mid = cabinetView([plan], plan.startMs + ENTRY_MS).view!;
      expect(mid.entries.length + mid.boards.length + mid.chutes.length).toBe(1);
      expect(cabinetView([plan], plan.startMs + plan.plan.endMs).view).toBeNull();
    }
  });

  it('tells the clock offset from the quickest of the last CLOCK_SAMPLES arrivals', () => {
    const before = fill(10);
    const r = processInsert(before, 'p', 0, 0.2, 5);
    const after: CoinPusherState = { ...r.state, recentDrops: [{ chipId: r.chipId, hole: 0, phase: 0.2, atMs: 1_000, seed: 5 }] };
    expect(clockOffset([])).toBe(0);
    let samples = noteClock([], before, after, 61_400);
    // One record noticed late (a tab in the background) doesn't move it.
    samples = noteClock(samples, before, after, 900_000);
    expect(clockOffset(samples)).toBe(60_400);
    // A record with no new drop, or no time on it, adds nothing.
    expect(noteClock(samples, after, after, 5_000)).toEqual(samples);
    expect(noteClock(samples, before, { ...after, recentDrops: [{ chipId: r.chipId, hole: 0 }] }, 5_000)).toEqual(samples);
    // A new operator's clock takes over within CLOCK_SAMPLES records.
    for (let i = 0; i < CLOCK_SAMPLES; i++) samples = noteClock(samples, before, after, 2_000 + i);
    expect(clockOffset(samples)).toBe(1_000);
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

  it('keeps every tipping coin ahead of the bar that pushed it', () => {
    let before = fill(25);
    let tips = 0;
    for (let i = 0; i < 60; i++) {
      const phase = (i * 0.618) % 1;
      const { r, trace } = traced(before, (i % 3) as PusherHole, phase, 300 + i);
      const plan = planReplay(before, trace, GEOM);
      for (const [id, list] of plan.transitions) {
        for (const tr of list) {
          if (tr.kind !== 'tip' || tr.from.lower) continue;
          tips++;
          for (let k = 0; k <= 12; k++) {
            const t = tr.t + (TIP_MS * k) / 12;
            const p = replayView(plan, t).table.find((q) => q.chipId === id);
            if (!p || p.y < -GEOM.level) continue; // stepped down off the upper platform
            const face = pusherFaceX(phase + t / PUSHER_PERIOD_MS);
            expect(p.x - reachBack(p.tip * Math.PI / 2, GEOM)).toBeGreaterThanOrEqual(face - 1e-3);
          }
        }
      }
      before = r.state;
    }
    expect(tips).toBeGreaterThan(5);
  });

  it("won't replay across an empty: those drops ran on an empty machine", () => {
    const before = fill(20);
    const emptied = emptyMachine(before, 'owner').state;
    const r = processInsert(emptied, 'p', 1, 0.3, 9);
    const mark = { chipId: r.chipId, hole: 1 as PusherHole, phase: 0.3, atMs: 1_000, seed: 9 };
    expect(planDrops(before, { ...r.state, recentDrops: [mark] }, GEOM)).toBeNull();
    expect(planDrops(emptied, { ...r.state, recentDrops: [mark] }, GEOM)).toHaveLength(1);
  });

  /** A crowd at the machine: `polls` operator polls `pollMs` apart, each
   *  settling `perPoll` drops, as pusherCroupier writes them. */
  function crowd(start: CoinPusherState, polls: number, perPoll: number, pollMs: number, at: number) {
    const records: { state: CoinPusherState; atMs: number }[] = [];
    let s = start;
    for (let k = 0; k < polls; k++) {
      const atMs = at + k * pollMs;
      for (let j = 0; j < perPoll; j++) {
        const hole = ((k + j) % 3) as PusherHole;
        const phase = currentPusherPhase(s, atMs);
        const seed = 1_000 + k * perPoll + j;
        const r = processInsert(s, 'p', hole, phase, seed);
        s = { ...r.state, recentDrops: [...(s.recentDrops ?? []), { chipId: r.chipId, hole, phase, atMs, seed }].slice(-RECENT_DROPS_MAX) };
      }
      records.push({ state: s, atMs });
    }
    return records;
  }

  it('keeps every coin of a crowd in the air, past the history of drops', () => {
    // Twelve drops in three polls, seen poll by poll: more than the eight
    // marks a record keeps, all on the board at once.
    const start = fill(30);
    const records = crowd(start, 3, 4, 100, 80_000);
    let replays = queueDrops([], start, records[0].state, GEOM);
    for (let k = 1; k < records.length; k++) {
      replays = queueDrops(replays, records[k - 1].state, records[k].state, GEOM);
    }
    expect(replays).toHaveLength(12);
    const view = cabinetView(replays, records[2].atMs + 50).view!;
    expect(view.entries.length + view.boards.length).toBe(12);
    expect(REPLAY_MAX).toBeGreaterThan(RECENT_DROPS_MAX);
  });

  it('never draws a chip inside a platform: off an edge only once clear of it', () => {
    // Every chip of every view of a busy machine's replays, through steps
    // down, payouts and tips at once: wherever its back is still over a
    // deck, its lowest point is on or above that deck.
    const start = fill(120);
    const records = crowd(start, 10, 2, 400, 90_000);
    let replays: ReturnType<typeof queueDrops> = [];
    let prev = start;
    let steps = 0;
    let pays = 0;
    for (const rec of records) {
      replays = queueDrops(replays, prev, rec.state, GEOM);
      prev = rec.state;
      for (const r of replays) {
        for (const list of r.plan.transitions.values()) {
          for (const tr of list) { if (tr.kind === 'step') steps++; if (tr.kind === 'pay') pays++; }
        }
      }
    }
    const all = queueDrops([], start, records[0].state, GEOM)
      .concat(...records.slice(1).map((rec, k) => queueDrops([], records[k].state, rec.state, GEOM)));
    const end = Math.max(...all.map((r) => r.startMs + r.plan.endMs));
    for (let t = records[0].atMs; t <= end; t += 7) {
      const view = cabinetView(all, t).view;
      if (!view) continue;
      for (const p of view.table) {
        const a = p.tip * Math.PI / 2;
        const bottom = p.y - reachBelow(a, GEOM);
        const back = p.x - reachBack(a, GEOM);
        if (back < PLAT_UP_FRONT - 1e-9) expect(bottom).toBeGreaterThanOrEqual(-1e-6);
        if (back < PLAT_LOW_FRONT - 1e-9) expect(bottom).toBeGreaterThanOrEqual(-GEOM.lowerDrop - 1e-6);
      }
    }
    expect(steps).toBeGreaterThan(0);
    expect(pays).toBeGreaterThan(0);
  });

  it('drops the coin off the bar, never through it, on either stroke', () => {
    // Over every part of the sweep: the coin is below the bar's top only
    // with its back in front of the bar's face, and lands where it should.
    const before = fill(20);
    let forward = 0;
    let back = 0;
    for (let i = 0; i < 80; i++) {
      const phase = i / 80;
      const { trace } = traced(before, (i % 3) as PusherHole, phase, 500 + i);
      const landPhase = (phase + trace.landMs / PUSHER_PERIOD_MS) % 1;
      if (landPhase < 0.5) forward++; else back++;
      const plan = planReplay(before, trace, GEOM);
      for (let k = 0; k <= 40; k++) {
        const t = trace.fallMs + ((trace.landMs - trace.fallMs) * k) / 40 - (k === 40 ? 1e-6 : 0);
        const c = replayView(plan, t).chute!;
        const face = pusherFaceX(phase + t / PUSHER_PERIOD_MS);
        if (c.y - CHIP_R < GEOM.barTop - 1e-9) expect(c.x - GEOM.level / 2).toBeGreaterThanOrEqual(face - 1e-9);
      }
      const end = replayView(plan, trace.landMs - 1e-6).chute!;
      expect(end.x).toBeCloseTo(trace.landX, 2);
      expect(end.y).toBeCloseTo(CHIP_R, 3);
    }
    expect(forward).toBeGreaterThan(10);
    expect(back).toBeGreaterThan(10);
  });

  it('keeps the newest landed table while an older drop is still in the air', () => {
    // Two drops settled in turn, the second pressed well before the first
    // (a lagging claim): it lands and plays out while the first coin is
    // still on the board. The table must not go back to the first's.
    const start = fill(40);
    const at = 70_000;
    const marks: PusherDropMark[] = [];
    let s = start;
    for (const [hole, seed] of [[0, 11], [2, 12]] as const) {
      const phase = currentPusherPhase(s, at);
      const r = processInsert(s, 'p', hole, phase, seed);
      marks.push({ chipId: r.chipId, hole, phase, atMs: at, seed });
      s = r.state;
    }
    let replays = queueDrops([], start, { ...s, recentDrops: marks }, GEOM);
    expect(replays).toHaveLength(2);
    const quick = { ...replays[1], startMs: replays[0].startMs - replays[1].plan.endMs - 200 };
    replays = [replays[0], quick];
    const quickEnd = quick.startMs + quick.plan.endMs;
    const slowLand = replays[0].startMs + replays[0].plan.trace.landMs;
    expect(quickEnd).toBeLessThan(slowLand);
    // Feed `live` back frame by frame, as the cabinet does: once the second
    // drop has played out, the table stays its final one until the first
    // coin lands (less that coin, still in the air).
    const slowChip = replays[0].plan.trace.chipId;
    const sort = (ps: { chipId: number }[]) => [...ps].sort((x, y) => x.chipId - y.chipId);
    const finalQuick = sort(replayView(quick.plan, quick.plan.endMs).table).filter((p) => p.chipId !== slowChip);
    let checked = 0;
    for (let t = quickEnd - 50; t < slowLand; t += 37) {
      const { view, live } = cabinetView(replays, t);
      replays = live;
      if (t < quickEnd) continue;
      expect(sort(view!.table)).toEqual(finalQuick);
      checked++;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('queues a later drop even when it has already played out', () => {
    const start = fill(30);
    const at = 60_000;
    const phase = currentPusherPhase(start, at);
    const r = processInsert(start, 'p', 1, phase, 3);
    const next = { ...r.state, recentDrops: [{ chipId: r.chipId, hole: 1 as PusherHole, phase, atMs: at, seed: 3 }] };
    const q = queueDrops([], start, next, GEOM);
    expect(q).toHaveLength(1);
    // Long over: nothing left to draw but the record.
    expect(cabinetView(q, at + 60_000)).toEqual({ view: null, live: [] });
  });

  it('draws a chip paid straight off the upper platform stepping down first', () => {
    // An upper chip that lands on a full lower contact chain can spill
    // through it into the tray inside one substep: gone from the next frame.
    const before = fill(10);
    const { trace } = traced(before, 1, 0.3, 21);
    const chip = 9_999;
    const edge = { x: PLAT_UP_FRONT - 0.005, u: 0.05, count: 1, chipIds: [chip] };
    const t0 = trace.landMs;
    const fake: DropTrace = {
      ...trace,
      frames: [
        { t: t0, upper: [...trace.frames[0].upper, edge], lower: trace.frames[0].lower, paid: [] },
        { t: t0 + 20, upper: trace.frames[0].upper, lower: trace.frames[0].lower, paid: [chip] },
      ],
    };
    const plan = planReplay({ ...before, upper: [...before.upper, edge] }, fake, GEOM);
    const pay = plan.transitions.get(chip)!.find((t) => t.kind === 'pay')!;
    let onLower = false;
    for (let k = 0; k <= 60; k++) {
      const t = pay.t + ((STEP_MS + PAY_MS) * k) / 60;
      const p = replayView(plan, t).table.find((q) => q.chipId === chip);
      if (!p) continue;
      const bottom = p.y - reachBelow(p.tip * Math.PI / 2, GEOM);
      const back = p.x - reachBack(p.tip * Math.PI / 2, GEOM);
      if (back < PLAT_UP_FRONT - 1e-9) expect(bottom).toBeGreaterThanOrEqual(-1e-6);
      if (back < PLAT_LOW_FRONT - 1e-9) expect(bottom).toBeGreaterThanOrEqual(-GEOM.lowerDrop - 1e-6);
      if (Math.abs(bottom + GEOM.lowerDrop) < 1e-6) onLower = true;
    }
    expect(onLower).toBe(true);
    expect(replayView(plan, pay.t + STEP_MS + PAY_MS).table.some((q) => q.chipId === chip)).toBe(false);
    expect(plan.endMs).toBeGreaterThanOrEqual(pay.t + STEP_MS + PAY_MS);
  });
});
