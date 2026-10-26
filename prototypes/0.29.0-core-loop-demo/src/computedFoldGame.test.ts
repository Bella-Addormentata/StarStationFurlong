/**
 * 🧮 The fold's game seam (computedFold.ts FoldGame): what the walk does for
 * a game that carries state from round to round, shown with a toy game
 * before craps uses it. Roulette's own output is pinned byte for byte by
 * computedFoldGolden.test.ts.
 */

import { describe, expect, it } from 'vitest';
import { rouletteGame, TableFold } from './computedFold';
import type { FoldGame, FoldResult } from './computedFold';
import { cachingCheck, ComputedKit, red, TEST_CTX, TestSession, testIdentity } from './computedTestKit';

const kit = new ComputedKit();
const sigs = cachingCheck();
const A = testIdentity('alice');
const B = testIdentity('bob');
const SID = 'g';

/** A toy game: the state counts the decided rounds before it; each counted
 *  player wins that count; an empty felt may be frozen; a felt holds its
 *  stake plus the state. Counts its plays. */
function toyGame(): FoldGame<number> & { plays: string[] } {
  const plays: string[] = [];
  return {
    plays,
    asSlip: rouletteGame.asSlip,
    asCheckpoint: rouletteGame.asCheckpoint,
    frozenOk: () => true,
    start: () => 0,
    key: (s) => String(s),
    play(_ctx, r, out, P, _M, sIn) {
      plays.push(`${r}@${sIn}`);
      const stakes = new Map<string, bigint>();
      const payouts = new Map<string, bigint>();
      const deltas = new Map<string, bigint>();
      for (const [pid, s] of P) {
        stakes.set(pid, s.stake);
        if (!out.decided) continue;
        const won = out.counted.includes(pid) ? BigInt(sIn) : 0n;
        payouts.set(pid, won);
        deltas.set(pid, won);
      }
      return { pocket: null, stakes, payouts, deltas, sOut: out.decided === 'void' ? sIn : sIn + 1 };
    },
    standing(sIn, felts, stakeOf) {
      const held = new Map<string, bigint>();
      for (const [pid, f] of felts) held.set(pid, stakeOf(f.hash) + BigInt(sIn));
      return held;
    },
  };
}

function foldWith(game: FoldGame<number>, s: TestSession): TableFold {
  const f = new TableFold(TEST_CTX, sigs.check, undefined, game as FoldGame<unknown>);
  f.setBase(null);
  f.reset(s.records.entries());
  return f;
}

/** Rounds 1..n, each with one close by alice over her slip, all revealed. */
function chain(n: number): { session: TestSession; closes: string[] } {
  const session = new TestSession();
  const closes: string[] = [];
  let q = SID;
  for (let r = 1; r <= n; r++) {
    const s = kit.slip(A, r, [red(r)]);
    const c = kit.close(A, r, q, [s]);
    session.put(s, c, kit.reveal(r, 'alice'));
    closes.push(c.hash);
    q = c.hash;
  }
  return { session, closes };
}

describe('a game that carries state', () => {
  it('plays each round on the chain from the state the rounds before it left', () => {
    const game = toyGame();
    const res: FoldResult = foldWith(game, chain(3).session).result();
    expect(res.rounds.map((v) => v.payouts.get('alice'))).toEqual([0n, 1n, 2n]);
    expect(res.carry).toBe(3);
    expect(game.plays).toEqual(['1@0', '2@1', '3@2']);
  });

  it('plays the tip from the last decided state, and the felt holds what the game says', () => {
    const game = toyGame();
    const { session, closes } = chain(2);
    const s3 = kit.slip(A, 3, [red(7)]);
    session.put(s3, kit.close(A, 3, closes[1], [s3]));
    let res = foldWith(game, session).result();
    expect(res.tip?.r).toBe(3);
    expect(res.carry).toBe(2);
    expect(res.held).toEqual(new Map([['alice', 7n]])); // the tip's stakes
    const open = chain(2).session.put(kit.slip(B, 3, [red(4)]));
    res = foldWith(toyGame(), open).result();
    expect(res.tip).toBeNull();
    expect(res.held).toEqual(new Map([['bob', 6n]])); // standing: 4 + the carried 2
  });

  it('never plays a rival branch, and plays again only what changed', () => {
    const game = toyGame();
    const { session, closes } = chain(2);
    // A rival close of round 1 by bob, decided, that nothing builds on.
    const b1 = kit.slip(B, 1, [red(2)]);
    session.put(b1, kit.close(B, 1, SID, [b1]), kit.reveal(1, 'bob'));
    const f = foldWith(game, session);
    f.result();
    expect(game.plays).toEqual(['1@0', '2@1']);
    // Junk changes nothing the plays read: they come from the memo.
    f.apply([['note', 'hello']]);
    f.result();
    expect(game.plays).toEqual(['1@0', '2@1']);
    // A third round plays only itself.
    const s3 = kit.slip(A, 3, [red(1)]);
    f.apply([[s3.key, s3.rec]]);
    const c3 = kit.close(A, 3, closes[1], [s3]);
    f.apply([[c3.key, c3.rec]]);
    const x3 = kit.reveal(3, 'alice');
    f.apply([[x3.key, x3.rec]]);
    expect(f.result().carry).toBe(3);
    expect(game.plays.filter((p) => p.startsWith('1@') || p.startsWith('2@'))).toEqual(['1@0', '2@1']);
  });

  it('a void keeps the state where it was', () => {
    const game = toyGame();
    const { session, closes } = chain(1);
    const s2 = kit.slip(A, 2, [red(2)]);
    const c2 = kit.close(A, 2, closes[0], [s2]);
    session.put(s2, c2, kit.abandon(A, 2, c2.hash));
    const res = foldWith(game, session).result();
    expect(res.rounds.map((v) => v.decided)).toEqual(['reveals', 'void']);
    expect(res.carry).toBe(1);
  });
});

describe('empty felts', () => {
  const a = kit.slip(A, 1, [red(5)]);
  const bEmpty = kit.slip(B, 1, []);

  it('a game may let a close freeze one, and it is then present', () => {
    const session = new TestSession().put(a, bEmpty, kit.close(A, 1, SID, [a, bEmpty]), kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    const toy = foldWith(toyGame(), session).result().rounds[0];
    expect(toy.present).toEqual(['alice', 'bob']);
    expect(toy.decided).toBe('reveals');
    // Roulette keeps today's rule: an empty felt is missing, and blocks the reveals.
    const roulette = session.fold(sigs.check).result().rounds[0];
    expect(roulette.present).toEqual(['alice']);
    expect(roulette.missing).toEqual(['bob']);
    expect(roulette.decided).toBeNull();
  });

  it('no game lets a close be signed over its signer\'s empty felt', () => {
    const session = new TestSession().put(a, bEmpty, kit.close(B, 1, SID, [a, bEmpty]), kit.reveal(1, 'alice'), kit.reveal(1, 'bob'));
    const res = foldWith(toyGame(), session).result();
    expect(res.rounds).toEqual([]);
    expect(res.openCloses.map((c) => c.state)).toEqual(['invalid']);
  });
});
