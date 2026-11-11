/**
 * 🧪🔒🌐 Cheats against a FAIR ONLY game, played over the simulated network
 * (computedSim.ts; design §16.3, the 6c scenarios; PR 6c-5a-3). The rooms are
 * the steady scenarios' (computedFairOnlySim.test.ts): the owner's page opens
 * the game, the owner's node is its house, honest pages play. One page more
 * does wrong:
 *   - the griefer (B2): a stranger's abandon of every close the moment it is
 *     seen (it counts for nothing), and a frozen bettor's (the house's
 *     reveal outranks it): every round is still the house's;
 *   - junk (B3): 200 KiB laid into the game's session, first while nothing is
 *     decided in it (the house sweeps it, N3s), then again and again (a trim
 *     or a sweep clears each): the table never pauses;
 *   - a made-up frozen slip: a close that freezes a slip nobody wrote; the
 *     house decides the round on the slips there are, and waits
 *     MISSING_WAIT_MS before it trims past it;
 *   - the forger: checkpoints nobody signed, one it signed itself that pays
 *     it, an old one of the house's laid back in, junk over the base's key,
 *     an end it signed, a `gone:` mark, the switch deleted, closes that name
 *     no commitment: no page counts from any of it, and the game plays on.
 *
 * Each ends in the steady scenarios' finish (computedFairOnlySimKit): no
 * violation, every page agrees, the chips add up, every base the house's and
 * honestly reachable (the checkpoint oracle), and the stall budget: with its
 * house up and an honest bettor at the table, no cheat here holds a round up
 * longer than a house table's worst.
 *
 * Not here yet (they need parts not built): 4,001 pids, a flood of junk
 * `ck:` (P7), 5 MiB of junk (the harness holds a doc under 1 MB), the ends,
 * transfers, two houses, the owner rewrite, migration back.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { sealCk, sealFin } from './computedFairOnly';
import type { CkRec } from './computedFairOnly';
import { fairOnlyFinish, lines, rouletteFinish } from './computedFairOnlySimKit';
import type { FoldCtx } from './computedFold';
import { PAGE_ROOM } from './computedPageKit';
import { HEAVY_BOT, Sim, SIM_LONG, SIM_MINUTES, SIM_SEED_OFFSET } from './computedSim';
import type { PageSpec, SimPage } from './computedSim';
import { HOUSE_SWEEP_MIN_MS } from './computedSimHouse';
import { ComputedKit } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';

vi.stubGlobal('window', { location: { search: '' } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
});

const RUN_MS = SIM_MINUTES * 60_000;
const TIMEOUT = SIM_LONG ? 1_800_000 : 300_000;
const T = 'roulette-1';
const seed = (n: number): number => n + SIM_SEED_OFFSET;
const named = (names: string, extra: Partial<PageSpec> = {}): PageSpec[] => names.split('').map((name) => ({ name, ...extra }));
/** computedTable MISSING_WAIT_MS, as the house holds it (computedSimHouse). */
const MISSING_WAIT_MS = 30_000;

/** A page that only writes to its doc: it runs no table of its own. */
function peer(sim: Sim, name: string): SimPage {
  const x = sim.pages.find((sp) => sp.name === name)!;
  x.cheats = true;
  x.beforeFrame = () => false;
  return x;
}

/** Page sp's own key, signing as player `pid` (its own unless given). */
function identityOf(sp: SimPage, pid = sp.pid): TestIdentity {
  return { pid, pub: sp.p.pub, sign: (bytes) => sp.p.keypair.signIdentity(bytes) };
}

/** The game at table T as page sp holds it: its incarnation, its live
 *  session's map and a kit to build records for it (null before it is open
 *  there). */
function gameOn(sp: SimPage): { inc: string; ctx: FoldCtx; ses: Y.Map<unknown>; kit: ComputedKit; top: Y.Map<unknown>; base: { key: string; ck: CkRec } } | null {
  const inc = sp.p.casino.computedIncOf(T);
  const base = inc === null ? undefined : sp.p.casino.computedResolutionOf(T, inc)?.base;
  if (!inc || !base) return null;
  const top = sp.p.doc.getMap<unknown>('casinoComputed');
  const ctx: FoldCtx = { room: PAGE_ROOM, t: T, inc };
  const ses = top.get(`ses:${T}:${inc}:${sp.p.fold.nextSid3(ctx, base.ck)}`);
  return ses instanceof Y.Map ? { inc, ctx, ses: ses as Y.Map<unknown>, kit: new ComputedKit(ctx), top, base } : null;
}

describe('cheats against a FAIR ONLY game', () => {
  /** Page sp abandons every close in the game's session the moment it holds it. */
  function abandonsAll(sim: Sim, sp: SimPage): { all: number; frozen: number } {
    const done = { all: 0, frozen: 0 };
    const seen = new Set<string>();
    sim.every(() => {
      const game = gameOn(sp);
      if (!game) return;
      for (const [key, v] of [...game.ses.entries()]) {
        if (!key.startsWith('c:') || seen.has(key)) continue;
        seen.add(key);
        const c = v as { r: number; f?: Record<string, string> };
        const z = game.kit.abandon(identityOf(sp), c.r, key.split(':')[2]);
        sp.p.doc.transact(() => game.ses.set(z.key, z.rec));
        done.all += 1;
        if (c.f && sp.pid in c.f) done.frozen += 1;
      }
    });
    return done;
  }

  it("the griefer, a stranger: it abandons every close the moment it sees it; its abandons count for nothing, no page shows a round void, and the house decides every round", async () => {
    const sim = await Sim.open({
      name: 'fair-only-griefer', seed: seed(1221), houseNode: true, fairOnly: true,
      pages: [...named('ABCD'), { name: 'S', bot: null, honest: false }],
    });
    const done = abandonsAll(sim, peer(sim, 'S'));
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    expect(done.all, sim.label).toBeGreaterThanOrEqual(5);
    expect(done.frozen, sim.label).toBe(0);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(5);
    expect(s.voids, sim.label).toBe(0);
  }, TIMEOUT);

  it("the griefer, a bettor: it abandons every close that froze it, at once; the house reveals all the same and its result stands (a page may show the round void until the reveal reaches it)", async () => {
    const sim = await Sim.open({
      name: 'fair-only-griefer-bettor', seed: seed(1225), houseNode: true, fairOnly: true,
      pages: [...named('ABCD'), { name: 'G', honest: false }],
    });
    const G = sim.pages.find((sp) => sp.name === 'G')!;
    G.cheats = true;
    const done = abandonsAll(sim, G);
    await sim.run(RUN_MS);
    // (A frozen bettor's abandon is one the fold counts, S6 d, until the house's
    // reveal outranks it: a second or two in which a page reads the round void.)
    const s = await rouletteFinish(sim, { flips: ['void undone'] });
    fairOnlyFinish(sim, s);
    expect(done.frozen, sim.label).toBeGreaterThanOrEqual(3);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(5);
    expect(s.voids, sim.label).toBe(0);
  }, TIMEOUT);

  it('junk: 200 KiB in the fresh session is swept inside SWEEP_MIN_MS + 1 s, and 200 KiB more every 25 s is cleared by a trim or a sweep; the table never pauses', async () => {
    const JUNK = 200 * 1024;
    const sim = await Sim.open({
      name: 'fair-only-junk', seed: seed(1222), houseNode: true, fairOnly: true,
      pages: [...named('ABCD'), { name: 'X', bot: null, honest: false }],
    });
    const X = peer(sim, 'X');
    const node = sim.node!;
    let n = 0;
    const dump = (): boolean => {
      const game = gameOn(X);
      if (!game) return false;
      X.p.doc.transact(() => {
        for (let i = 0; i * 1_024 < JUNK; i++) game.ses.set(`junk-${n++}`, 'x'.repeat(1_000));
      });
      return true;
    };
    // The first as soon as the game is open on the cheat's page: nothing is decided in its session yet.
    let first: number | null = null;
    let sweptAt: number | null = null;
    let decidedBefore = -1;
    sim.every(() => {
      if (first === null && dump()) {
        first = sim.elapsed;
        decidedBefore = node.wrote.reveals;
      }
      if (first !== null && sweptAt === null && node.sweeps > 0) sweptAt = sim.elapsed;
    });
    const dumps: { at: number; cleared: number | null }[] = [];
    for (let at = 30_000; at + 30_000 <= RUN_MS; at += 25_000) {
      sim.at(at, () => {
        if (dump()) dumps.push({ at: sim.elapsed, cleared: null });
      });
    }
    // Cleared: no junk left in the live session as an honest page holds it.
    const A = sim.pages[0];
    sim.every(() => {
      const open = dumps.find((d) => d.cleared === null);
      if (!open || sim.elapsed - open.at < 1_000) return;
      const game = gameOn(A);
      if (game && ![...game.ses.keys()].some((k) => k.startsWith('junk-'))) open.cleared = sim.elapsed;
    });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim, { junk: JUNK + 16 * 1024 });
    fairOnlyFinish(sim, s);
    expect(first, sim.label).not.toBeNull();
    expect(decidedBefore, sim.label).toBe(0);
    expect(sweptAt, sim.label).not.toBeNull();
    expect(sweptAt! - first!, sim.label).toBeLessThanOrEqual(HOUSE_SWEEP_MIN_MS + 1_000);
    expect(dumps.length, sim.label).toBeGreaterThanOrEqual(4);
    // Each later dump is gone within a round and its show, or a sweep's wait.
    for (const d of dumps) expect(d.cleared === null ? Infinity : d.cleared - d.at, `${sim.label} dump at ${d.at}`).toBeLessThanOrEqual(45_000);
    expect(node.trims + node.sweeps, sim.label).toBeGreaterThanOrEqual(dumps.length);
    // Every checkpoint the house wrote, the sweeps of the root among them, was counted from and held to the oracle.
    expect(sim.basesCounted, sim.label).toBe(node.trims + node.sweeps);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(5);
    expect(s.voids, sim.label).toBe(0);
  }, TIMEOUT);

  it('a made-up frozen slip: a close that freezes a slip nobody wrote is decided by the house on the slips there are, and the house trims past it only MISSING_WAIT_MS on', async () => {
    const sim = await Sim.open({
      name: 'fair-only-ghost-slip', seed: seed(1223), houseNode: true, fairOnly: true, bot: HEAVY_BOT,
      pages: [...named('ABCD'), { name: 'G', honest: false }],
    });
    const G = sim.pages.find((sp) => sp.name === 'G')!;
    G.cheats = true;
    const A = sim.pages[0];
    const ghosts: { r: number; close: string; decided: number | null; how: string | null; trimmed: number | null }[] = [];
    const due = [25_000, 100_000];
    sim.every(() => {
      // The cheat's close, ahead of the pages' own, once it has a felt down beside two others'.
      if (due.length > 0 && sim.elapsed >= due[0]) {
        const game = gameOn(G);
        const res = G.p.casino.computedFoldOf(T);
        const h = res ? res.required ?? res.joins[0]?.rec.c : undefined;
        if (game && res && h !== undefined && !res.pending && res.tip === null && res.openCloses.length === 0 && res.felts.has(G.pid) && res.felts.size >= 3) {
          const f: Record<string, string> = { 'player-ghost': 'ab'.repeat(16) };
          for (const [pid, slip] of res.felts) f[pid] = slip.key.split(':')[3];
          const c = game.kit.close(identityOf(G), res.open, res.parent, f, h);
          G.p.doc.transact(() => game.ses.set(c.key, c.rec));
          ghosts.push({ r: res.open, close: c.hash, decided: null, how: null, trimmed: null });
          due.shift();
        }
      }
      // As honest page A reads it: when the close was decided and how, and when its base first passed the round.
      const res = A.p.casino.computedFoldOf(T);
      if (!res) return;
      for (const g of ghosts) {
        const v = res.rounds.find((round) => round.close === g.close);
        if (g.decided === null && v?.decided) {
          g.decided = sim.elapsed;
          g.how = v.decided;
        }
        if (g.trimmed === null && res.base.u >= g.r) g.trimmed = sim.elapsed;
      }
      // (Another close of the round decided, better ranked than the cheat's: it tries again at the next.)
      for (const g of [...ghosts]) {
        if (g.decided !== null || !res.rounds.some((round) => round.r === g.r && round.decided && round.close !== g.close) && res.base.u < g.r) continue;
        ghosts.splice(ghosts.indexOf(g), 1);
        due.unshift(sim.elapsed);
      }
    });
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    expect(ghosts, sim.label).toHaveLength(2);
    for (const g of ghosts) {
      expect(g.how, `${sim.label} round ${g.r}`).toBe('house');
      expect(g.trimmed, `${sim.label} round ${g.r}`).not.toBeNull();
      // (A page hears the house's reveal and its trim a network hop after each: a second's slack.)
      expect(g.trimmed! - g.decided!, `${sim.label} round ${g.r}`).toBeGreaterThanOrEqual(MISSING_WAIT_MS - 1_000);
    }
    expect(sim.node!.trims, sim.label).toBeGreaterThanOrEqual(2);
    expect(s.voids, sim.label).toBe(0);
  }, TIMEOUT);

  it("the forger: checkpoints nobody signed and one that pays it, an old one of the house's laid back, junk over the base's key, an end it signed, a gone: mark, the switch deleted, closes that name no commitment: no page counts from any of it", async () => {
    const sim = await Sim.open({
      name: 'fair-only-forger', seed: seed(1224), houseNode: true, fairOnly: true, bot: HEAVY_BOT,
      pages: [...named('ABCD'), { name: 'X', bot: null, honest: false }],
    });
    const X = peer(sim, 'X');
    const honest = sim.pages.filter((sp) => sp.honest);
    const done: Record<string, number> = { unsigned: 0, paysItself: 0, old: 0, over: 0, end: 0, gone: 0, switch: 0, friendly: 0, friendlyFirst: 0, countedBare: 0 };
    const sign = (bytes: Uint8Array): string => X.p.keypair.signIdentity(bytes);
    // The house's first checkpoint, kept for the replay.
    let old: { key: string; ck: CkRec } | null = null;
    // What must be back on every honest page up, and by when.
    const checks: { what: string; due: number; ok: (sp: SimPage) => boolean }[] = [];
    const late: string[] = [];
    sim.every(() => {
      const game = gameOn(X);
      if (game && !old && game.base.ck.u > 0) old = game.base;
      for (const c of [...checks]) {
        if (sim.elapsed < c.due) continue;
        checks.splice(checks.indexOf(c), 1);
        for (const sp of honest.filter((q) => q.mode === 'up')) {
          sim.enter(sp);
          if (!c.ok(sp)) late.push(`${c.what}: not back on ${sp.name} at ${sim.elapsed} ms`);
        }
      }
    });
    // A Friendly close of the open round: its own slip and the felts there are, no commitment named.
    const friendly = ({ ses, kit }: NonNullable<ReturnType<typeof gameOn>>): boolean => {
      const res = X.p.casino.computedFoldOf(T);
      if (!res || res.tip !== null) return false;
      const mine = kit.slip(identityOf(X), res.open, [{ type: 'red', amount: 1 }]);
      const f: Record<string, string> = { [X.pid]: mine.hash };
      for (const [pid, slip] of res.felts) f[pid] = slip.key.split(':')[3];
      const c = kit.close(identityOf(X), res.open, res.parent, f);
      ses.set(mine.key, mine.rec);
      ses.set(c.key, c.rec);
      ses.set(kit.reveal(res.open, X.pid).key, kit.reveal(res.open, X.pid).rec);
      return true;
    };
    // The first at the game's first round, two felts down: no commitment is carried yet, and a house table's
    // round would be the bettors' to decide on such a close.
    sim.every(() => {
      if (done.friendlyFirst > 0) return;
      const game = gameOn(X);
      const res = X.p.casino.computedFoldOf(T);
      if (!game || !res || res.pending || res.required !== null || res.tip !== null || res.felts.size < 2) return;
      X.p.doc.transact(() => {
        if (friendly(game)) done.friendlyFirst += 1;
      });
    });
    // While an honest page's doc holds junk where its base was, the page counts from the base it holds, and
    // its chips add up against the oracle's cold count.
    const bare: string[] = [];
    sim.every(() => {
      for (const key of [...bare]) {
        for (const sp of honest.filter((q) => q.mode === 'up')) {
          const v = sp.p.doc.getMap('casinoComputed').get(key) as { junk?: unknown } | undefined;
          if (v?.junk === undefined) continue;
          sim.enter(sp);
          late.push(...sim.ledgerProblems(sp), ...sim.cageProblems(sp));
          done.countedBare += 1;
          bare.splice(bare.indexOf(key), 1);
          break;
        }
      }
    });
    const cheats: ((game: NonNullable<ReturnType<typeof gameOn>>) => void)[] = [
      // A checkpoint key holding nothing signed.
      ({ top, inc }) => {
        top.set(`ck:${T}:${inc}:${'0'.repeat(32)}`, { v: 1, b: 'g', u: 999, n: { [X.pid]: '1000' } });
        done.unsigned += 1;
      },
      // One round on from the base and a thousand chips to the forger: the house's key named, the forger's signature; and under the forger's own key.
      ({ top, ctx, base }) => {
        const { g: _g, ...body } = base.ck;
        const more = { ...body, u: base.ck.u + 1, n: { ...base.ck.n, [X.pid]: '1000' } };
        const { dl: _dl, ...bare } = more;
        for (const forged of [sealCk(ctx, more, sign), sealCk(ctx, { ...bare, k: X.p.pub }, sign)]) top.set(forged.key, forged.value);
        done.paysItself += 1;
      },
      // An old checkpoint of the house's laid back in, the session it opens with it.
      ({ top, ctx, inc, base }) => {
        if (!old || old.key === base.key) return;
        top.set(old.key, old.ck);
        const sid = X.p.fold.nextSid3(ctx, old.ck);
        if (!(top.get(`ses:${T}:${inc}:${sid}`) instanceof Y.Map)) top.set(`ses:${T}:${inc}:${sid}`, new Y.Map());
        done.old += 1;
      },
      // Junk over the base's own key: the record is back within the pages' put-back.
      ({ top, base }) => {
        top.set(base.key, { junk: sim.elapsed });
        // (With the old one beside it: the doc's best is then a checkpoint the pages are long past.)
        if (old && old.key !== base.key) top.set(old.key, old.ck);
        const { key, ck } = base;
        bare.push(key);
        checks.push({
          what: `junk over ${key} at ${sim.elapsed} ms`, due: sim.elapsed + 10_000,
          // (Back as it was, or the game has moved on to a later checkpoint and the key is the house's to clear.)
          ok: (sp) => JSON.stringify(sp.p.doc.getMap('casinoComputed').get(key)) === JSON.stringify(ck)
            || sp.p.casino.computedResolutionOf(T, sp.p.casino.computedIncOf(T)!)?.base?.key !== key,
        });
        done.over += 1;
      },
      // An end of the game, the forger's own: its end order, and a checkpoint that says ended.
      ({ top, ctx, base }) => {
        const fin = sealFin(ctx, X.p.pub, sign);
        const { g: _g, dl: _dl, h: _h, s: _s, ...body } = base.ck;
        try {
          const ended = sealCk(ctx, { ...body, b: X.p.fold.nextSid3(ctx, base.ck), e: 1, f: fin.value, k: X.p.pub }, sign);
          top.set(ended.key, ended.value);
        } catch {
          top.set(`ck:${T}:${ctx.inc}:${'e'.repeat(32)}`, { ...body, e: 1, f: fin.value, k: X.p.pub });
        }
        done.end += 1;
      },
      // The mark a removal leaves, and the switch deleted.
      ({ inc }) => {
        X.p.doc.getMap('casino').set(`gone:${T}:${inc}`, true);
        done.gone += 1;
      },
      ({ inc }) => {
        X.p.doc.getMap('casino').delete(`cfg:computed:${T}`);
        checks.push({ what: `the switch deleted at ${sim.elapsed} ms`, due: sim.elapsed + 2_000, ok: (sp) => sp.p.casino.computedIncOf(T) === inc });
        done.switch += 1;
      },
      // A Friendly close of the open round, while a commitment is carried.
      (game) => {
        if (friendly(game)) done.friendly += 1;
      },
    ];
    // One cheat every 4 s from 30 s on, each kind in turn.
    for (let at = 30_000, i = 0; at + 20_000 <= RUN_MS; at += 4_000, i++) {
      const cheat = cheats[i % cheats.length];
      sim.at(at, () => {
        const game = gameOn(X);
        if (game) X.p.doc.transact(() => cheat(game));
      });
    }
    await sim.run(RUN_MS);
    const s = await rouletteFinish(sim);
    fairOnlyFinish(sim, s);
    expect(late, sim.label).toEqual([]);
    for (const [kind, n] of Object.entries(done)) expect(n, `${sim.label} ${kind}`).toBeGreaterThan(0);
    expect(s.byHouse, sim.label).toBeGreaterThanOrEqual(5);
    expect(s.voids, sim.label).toBe(0);
    // The forger got nothing a checkpoint of its own said.
    for (const sp of honest.filter((q) => q.mode === 'up')) {
      sim.enter(sp);
      // (Its own red chip, which the honest pages' closes froze like any felt, is the most it moved.)
      expect(Number(sp.p.casino.computedFoldOf(T)?.nets.get(X.pid) ?? 0n), `${sim.label} ${sp.name}`).toBeLessThan(100);
    }
  }, TIMEOUT);
});
