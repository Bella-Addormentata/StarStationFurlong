/**
 * 🔎 The spike's probes, re-pinned against computed roulette's rules.
 *
 * The spike (computedTableSpike) was probed for holes before PR 2 was
 * designed. Each probe here replays one of those attacks on the real fold
 * (computedFold.ts) and pins what happens now: four holes are closed, the
 * zero-seed round can't happen, and the post-reveal rewrite stays open as the
 * documented Friendly lever ("A MODIFIED GAME CAN STEER OR REWRITE A ROUND"),
 * bounded by the next checkpoint.
 */

import { describe, expect, it } from 'vitest';
import { dutyRank, pocketOf, recHash } from './computedFold';
import type { ForfeitRec } from './computedFold';
import { black, cachingCheck, ComputedKit, red, straight, TEST_CTX, TestSession, testIdentity } from './computedTestKit';
import type { TestIdentity } from './computedTestKit';
import { payoutFor } from './games/roulette';
import type { RouletteBet } from './games/roulette';

const kit = new ComputedKit();
const sigs = cachingCheck();
const [A, B, C, D] = ['alice', 'bob', 'carol', 'dave'].map((n) => testIdentity(n));
const net = (bets: RouletteBet[], pocket: number): bigint =>
  BigInt(bets.reduce((n, b) => n + payoutFor(b, pocket) - b.amount, 0));
const byRank = (duty: 'forfeit', r: number) => (x: TestIdentity, y: TestIdentity): number =>
  (dutyRank(duty, TEST_CTX, r, x.pub) < dutyRank(duty, TEST_CTX, r, y.pub) ? -1 : 1);

describe('the spike\'s probes under the new rules', () => {
  it('a spoofed forfeit writer gets nowhere: the rank comes from the signed k, and k must count itself', () => {
    const ids = [A, B, C, D];
    const slips = ids.map((id) => kit.slip(id, 1, [red(10)]));
    const close = kit.close(A, 1, 'g', slips);
    const session = new TestSession().put(...slips, close, ...ids.map((id) => kit.reveal(1, id.pid)));
    const [first, second, third] = [...ids].sort(byRank('forfeit', 1));
    const dropper = third;
    // The spike's spoof: the dropper's forfeit, claiming the first-in-line
    // writer. Its k is first's, its signature the dropper's: junk.
    const spoof = kit.forfeit(dropper, 1, close.hash, [dropper.pid]);
    const spoofRec: ForfeitRec = { ...spoof.rec, k: first.pub };
    session.raw(`f:1:${recHash(spoofRec)}`, spoofRec);
    // Signed honestly, but by a writer it doesn't count: invalid.
    session.put(kit.forfeit(dropper, 1, close.hash, [first.pid]));
    // second's honest forfeit, counting everyone.
    const honest = kit.forfeit(second, 1, close.hash, ids.map((i) => i.pid));
    session.put(honest);
    let v = session.fold(sigs.check).result().rounds[0];
    expect(v.forfeit?.hash).toBe(honest.hash);
    expect(v.counted).toEqual(['alice', 'bob', 'carol', 'dave']);
    // The dropper's own valid forfeit is lever 2 — it can drop seeds — but it
    // ranks by its own key, behind second, so second's answer stands.
    session.put(kit.forfeit(dropper, 1, close.hash, [dropper.pid]));
    v = session.fold(sigs.check).result().rounds[0];
    expect(v.forfeit?.hash).toBe(honest.hash);
  });

  it('two versions with the same v (two tabs) stake once: one is held, one is frozen', () => {
    const tab1 = [red(80)];
    const tab2 = [black(80)];
    const v1 = kit.slip(A, 1, tab1);
    const v1b = kit.slip(A, 1, tab2); // same v, same seed and commitment, other felt
    const top = v1.hash > v1b.hash ? v1 : v1b;
    const session = new TestSession().put(v1, v1b);
    let res = session.fold(sigs.check).result();
    expect(res.held).toEqual(new Map([['alice', 80n]]));
    expect(res.felts.get('alice')?.hash).toBe(top.hash);
    // A close can freeze one version per pid; the other is never staked.
    const close = kit.close(A, 1, 'g', [top]);
    res = session.put(close, kit.reveal(1, 'alice')).fold(sigs.check).result();
    const pocket = res.rounds[0].pocket!;
    expect([...res.rounds[0].stakes]).toEqual([['alice', 80n]]);
    const delta = net(top === v1 ? tab1 : tab2, pocket);
    expect(res.nets.get('alice') ?? 0n).toBe(delta);
  });

  it('a close naming a slip nobody has does not stall the table: a forfeit decides it, and that pid is unstaked', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const close = kit.close(A, 1, 'g', { alice: a.hash, bob: 'f'.repeat(32) });
    const session = new TestSession().put(a, close, kit.reveal(1, 'alice'));
    let res = session.fold(sigs.check).result();
    expect(res.tip?.missing).toEqual(['bob']);
    session.put(kit.forfeit(A, 1, close.hash, ['alice']));
    res = session.fold(sigs.check).result();
    expect(res.rounds[0].decided).toBe('forfeit');
    expect(res.rounds[0].stakes.has('bob')).toBe(false);
    expect(res.open).toBe(2);
    // Nobody revealed at all? Then an abandon voids it, and the table moves on.
    const lone = kit.slip(B, 1, [red(10)]);
    const stuck = kit.close(B, 1, 'g', { bob: lone.hash, carol: 'e'.repeat(32) });
    const voided = new TestSession().put(lone, stuck, kit.abandon(D, 1, stuck.hash)).fold(sigs.check).result();
    expect(voided.rounds[0].decided).toBe('void');
    expect(voided.open).toBe(2);
  });

  it('a junk reveal does not erase the real one: each sits under its own hash', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const b = kit.slip(B, 1, [red(10)]);
    const close = kit.close(A, 1, 'g', [a, b]);
    const real = kit.reveal(1, 'bob');
    const junk = kit.reveal(1, 'bob', 'ff'.repeat(32));
    const session = new TestSession().put(a, b, close, kit.reveal(1, 'alice'), real, junk);
    const v = session.fold(sigs.check).result().rounds[0];
    expect(v.decided).toBe('reveals');
    expect(v.counted).toEqual(['alice', 'bob']);
    expect(session.records.has(real.key) && session.records.has(junk.key)).toBe(true);
  });

  it('no round is decided on zero seeds: a forfeit must count a revealed writer, or the round is void', () => {
    const a = kit.slip(A, 1, [red(10)]);
    const close = kit.close(A, 1, 'g', [a]);
    const session = new TestSession().put(a, close);
    // The spike's empty forfeit isn't even a record now.
    const empty = { ...kit.forfeit(A, 1, close.hash, ['alice']).rec, n: [] as string[] };
    session.raw(`f:1:${recHash(empty)}`, empty);
    session.put(kit.forfeit(A, 1, close.hash, ['alice'])); // alice never revealed
    let res = session.fold(sigs.check).result();
    expect(res.records).toBe(3);
    expect(res.tip?.decided).toBeNull();
    expect(res.held).toEqual(new Map([['alice', 10n]]));
    session.put(kit.abandon(B, 1, close.hash));
    res = session.fold(sigs.check).result();
    expect(res.rounds[0]).toMatchObject({ decided: 'void', counted: [], pocket: null });
    expect(res.nets.size).toBe(0); // the stake came back
  });

  it('the documented lever: after the reveals, a longer rival chain rewrites the round', () => {
    // Honest round: alice, bob and carol, closed by alice, all revealed.
    const bets = { alice: [red(10)], bob: [black(10)], carol: [red(1)] };
    const sa = kit.slip(A, 1, bets.alice);
    const sb = kit.slip(B, 1, bets.bob);
    const sc = kit.slip(C, 1, bets.carol);
    const honest = kit.close(A, 1, 'g', [sa, sb, sc]);
    const session = new TestSession().put(sa, sb, sc, honest, ...['alice', 'bob', 'carol'].map((p) => kit.reveal(1, p)));
    const before = session.fold(sigs.check).result();
    expect(before.rounds.map((v) => v.close)).toEqual([honest.hash]);
    expect(before.nets.has('bob')).toBe(true);
    // carol now knows every seed. A new version of her own slip (same
    // commitment, so her reveal still opens it) goes straight on the pocket
    // that alice's and her seeds make without bob's; a rival close freezes
    // just those two, decided at once by the reveals already in.
    const steered = pocketOf(TEST_CTX, 1, [kit.seed('alice', 1), kit.seed('carol', 1)]);
    const sc2 = kit.slip(C, 1, [straight(steered, 10)], { v: 2 });
    const rival = kit.close(C, 1, 'g', [sa, sc2]);
    session.put(sc2, rival);
    // Both are one round deep: the closer first in line wins the tie.
    const tieWinner = dutyRank('close', TEST_CTX, 1, A.pub) < dutyRank('close', TEST_CTX, 1, C.pub) ? honest : rival;
    expect(session.fold(sigs.check).result().rounds[0].close).toBe(tieWinner.hash);
    // One solo round on top makes the rival chain the longer one.
    const sc3 = kit.slip(C, 2, [red(1)]);
    session.put(sc3, kit.close(C, 2, rival.hash, [sc3]), kit.reveal(2, 'carol'));
    const after = session.fold(sigs.check).result();
    expect(after.rounds[0].close).toBe(rival.hash);
    expect(after.rounds[0].pocket).toBe(steered);
    expect(after.rounds[0].deltas.get('carol')).toBe(350n); // 35:1 on the pocket she chose
    expect(after.nets.has('bob')).toBe(false); // bob's round is undone: his bet was never staked
  });
});
