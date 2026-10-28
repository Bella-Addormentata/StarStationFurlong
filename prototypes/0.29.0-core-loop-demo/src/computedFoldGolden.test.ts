/**
 * 🧮 Computed roulette's fold, pinned to what it gave before craps came in.
 *
 * PR 3 splits the fold by game (computedFold.ts FoldGame): roulette's pocket
 * and payouts move behind the seam, and the walk learns to carry state from
 * round to round for craps. None of that may change one byte of what a
 * roulette table folds to. test-vectors/computed-roulette-golden.json holds a
 * hash of the fold's whole output for 300 random roulette sessions, recorded
 * on the fold as PR 2 merged it (main at e03c1f4): slips with several
 * versions and empty felts, rival closes, forks, closes under a missing or a
 * made-up parent, frozen pids with no slip, wrong and missing reveals,
 * forfeits (some invalid), abandons, records whose signature fails or isn't
 * checked yet, felts pinned to keys (one missing, one wrong), checkpoints
 * (some ended) and junk.
 *
 * To record it again — only on purpose, when roulette's fold is meant to
 * change — run this file with GOLDEN_WRITE=1 and review the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import { closeKey, nextSid, recHash, TableFold } from './computedFold';
import type { Checkpoint, CloseRec, FoldResult, KeyOf, SigCheck, SlipRec } from './computedFold';
import { b64url, ComputedKit, fakeIdentity, snapshot, TEST_CTX } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import type { RouletteBet, RouletteBetType } from './games/roulette';

const FIXTURE = new URL('../test-vectors/computed-roulette-golden.json', import.meta.url);
const SESSIONS = 300;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: readonly T[], rand: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'constructor', 'toString', 'p:q'];
const PLAIN: RouletteBetType[] = ['red', 'black', 'odd', 'even', 'low', 'high'];
const hex = (s: string, n: number): string => bytesToHex(sha256(utf8ToBytes(s))).slice(0, n);

interface Generated {
  cp: Checkpoint | null;
  records: [string, unknown][];
  keyOf?: KeyOf;
  hold: Set<string>;
}

/** One random roulette session: n is the seed. */
function generate(n: number): Generated {
  const rand = rng(1000 + n);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const chance = (p: number): boolean => rand() < p;
  const kit = new ComputedKit(TEST_CTX);
  const names = shuffled(NAMES, rand).slice(0, 2 + Math.floor(rand() * 5));
  const ids = new Map<string, TestIdentity>(names.map((p) => [p, fakeIdentity(`golden-${n}-${p}`, p)]));
  const records: [string, unknown][] = [];
  const hold = new Set<string>();
  const add = (b: Built<unknown>): void => {
    records.push([b.key, b.rec]);
    if (chance(0.03)) hold.add(b.hash);
  };
  const bet = (): RouletteBet => {
    const amount = 1 + Math.floor(rand() * 50);
    const roll = rand();
    if (roll < 0.25) return { type: 'straight', pick: Math.floor(rand() * 37), amount };
    if (roll < 0.35) return { type: 'dozen', pick: Math.floor(rand() * 3), amount };
    if (roll < 0.45) return { type: 'column', pick: Math.floor(rand() * 3), amount };
    return { type: pick(PLAIN), amount };
  };
  const felt = (): RouletteBet[] => (chance(0.1) ? [] : Array.from({ length: 1 + Math.floor(rand() * 4) }, bet));
  /** A copy of a signed record with a signature that fails (the shape still holds). */
  const badSig = <R extends { g: string }>(rec: R): R => ({ ...rec, g: b64url(sha512(utf8ToBytes(`bad-${n}-${rand()}`))) });

  let cp: Checkpoint | null = null;
  if (chance(0.3)) {
    const nets: Record<string, bigint> = {};
    for (const p of names) if (chance(0.6)) nets[p] = BigInt(Math.floor(rand() * 400) - 200);
    const b = chance(0.5) ? 'g' : hex(`golden-sid-${n}`, 24);
    cp = kit.checkpoint(pick([...ids.values()]), b, 1 + Math.floor(rand() * 5), hex(`golden-l-${n}`, 32), nets, chance(0.1) ? 1 : undefined);
  }
  const u = cp ? cp.u : 0;
  const sid = nextSid(TEST_CTX, cp);

  let parents: string[] = [sid];
  const rounds = 1 + Math.floor(rand() * 7);
  for (let r = u + 1; r <= u + rounds; r++) {
    // Slips: up to three versions each; a later one may hold a new seed.
    const slips = new Map<string, Built<SlipRec>[]>();
    for (const p of names) {
      if (!chance(0.85)) continue;
      const id = ids.get(p)!;
      const versions: Built<SlipRec>[] = [];
      const count = 1 + Math.floor(rand() * 3);
      for (let v = 1; v <= count; v++) {
        const seed = chance(0.15) ? kit.seed(p, r, `alt${v}`) : kit.seed(p, r);
        const s = kit.slip(id, r, felt(), { v: chance(0.1) ? 1 : v, seed });
        versions.push(s);
        add(s);
      }
      slips.set(p, versions);
    }
    const writers = [...slips.keys()];
    const closes: Built<CloseRec>[] = [];
    if (writers.length) {
      const nCloses = 1 + (chance(0.3) ? 1 : 0) + (chance(0.1) ? 1 : 0);
      for (let i = 0; i < nCloses; i++) {
        const signer = pick(writers);
        const f: Record<string, string> = {};
        for (const p of writers) if (p === signer || chance(0.7)) f[p] = pick(slips.get(p)!).hash;
        if (chance(0.1)) f.zed = 'f'.repeat(32);
        const q = chance(0.08) ? hex(`golden-q-${n}-${r}-${i}`, 32) : pick(parents);
        let c = kit.close(ids.get(signer)!, r, q, f);
        if (chance(0.05)) {
          const rec = badSig(c.rec);
          c = { key: closeKey(rec)!, hash: recHash(rec)!, rec };
        }
        closes.push(c);
        add(c);
      }
    }
    // Reveals: the right seed for the frozen version, mostly; now and then a wrong one.
    const revealed = new Map<string, Set<string>>();
    for (const c of closes) {
      const got = new Set<string>();
      for (const [p, h] of Object.entries(c.rec.f)) {
        const s = slips.get(p)?.find((x) => x.hash === h);
        if (!s) continue;
        if (chance(0.8)) {
          const seed = [kit.seed(p, r), kit.seed(p, r, 'alt1'), kit.seed(p, r, 'alt2'), kit.seed(p, r, 'alt3')]
            .find((x) => kit.commit(r, p, x) === s.rec.c);
          if (seed) {
            add(kit.reveal(r, p, seed));
            got.add(p);
          }
        }
        if (chance(0.05)) add(kit.reveal(r, p, kit.seed(p, r, 'junk')));
      }
      revealed.set(c.hash, got);
    }
    for (const c of closes) {
      const got = [...(revealed.get(c.hash) ?? [])];
      if (got.length && chance(0.25)) {
        const writer = pick(got);
        const counted = got.filter((p) => p === writer || chance(0.5));
        const others = chance(0.1) ? counted.filter((p) => p !== writer) : counted;
        if (others.length) add(kit.forfeit(ids.get(writer)!, r, c.hash, others));
      }
      if (chance(0.15)) add(kit.abandon(pick([...ids.values()]), r, c.hash));
    }
    if (closes.length) parents = closes.map((c) => c.hash);
  }
  // Junk beside the records.
  if (chance(0.3)) records.push([`s:1:alice:${'0'.repeat(32)}`, { r: 1 }]);
  if (chance(0.2)) records.push([`h:1:${'3'.repeat(32)}`, { house: 1 }]);
  if (chance(0.2)) records.push(['note', 'hello']);

  let keyOf: KeyOf | undefined;
  if (chance(0.5)) {
    const pins = new Map<string, string>([...ids].map(([p, id]) => [p, id.pub]));
    if (chance(0.3)) pins.delete(pick(names));
    if (chance(0.2)) pins.set(pick(names), fakeIdentity(`golden-wrong-${n}`).pub);
    keyOf = (pid) => pins.get(pid);
  }
  return { cp, records, keyOf, hold };
}

/** Real checks of fakeIdentity signatures (sha512 of the bytes), with some
 *  records held back as not checked yet. */
const checkFor = (hold: Set<string>): SigCheck => (hash, _kind, _pub, bytes, sig) =>
  hold.has(hash) ? undefined : sig === b64url(sha512(bytes()));

const outputOf = (res: FoldResult): string => JSON.stringify({ s: snapshot(res), raw: res.rawBytes });

function cold(g: Generated): FoldResult {
  const f = new TableFold(TEST_CTX, checkFor(g.hold), g.keyOf);
  f.setBase(g.cp);
  f.reset(g.records);
  return f.result();
}

/** What the 300 sessions exercise, so a generator change that stops covering
 *  something shows up beside the hashes. */
function coverage(all: FoldResult[]): Record<string, number> {
  const out: Record<string, number> = { reveals: 0, forfeit: 0, void: 0, tips: 0, pending: 0, ended: 0, missing: 0, invalidCloses: 0, held: 0 };
  for (const res of all) {
    for (const v of res.rounds) if (v.decided) out[v.decided]++;
    for (const v of res.rounds) if (v.missing.length) out.missing++;
    if (res.tip) out.tips++;
    if (res.pending) out.pending++;
    if (res.base.ended) out.ended++;
    if (res.held.size) out.held++;
    out.invalidCloses += res.openCloses.filter((c) => c.state === 'invalid').length;
  }
  return out;
}

describe("roulette's fold output is what PR 2 recorded", () => {
  const generated = Array.from({ length: SESSIONS }, (_, n) => generate(n));
  const results = generated.map(cold);
  const hashes = results.map((res) => hex(outputOf(res), 64));

  if (process.env.GOLDEN_WRITE === '1') {
    writeFileSync(FIXTURE, `${JSON.stringify({ recordedOn: 'e03c1f4', sessions: SESSIONS, coverage: coverage(results), hashes }, null, 1)}\n`);
  }
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { sessions: number; coverage: Record<string, number>; hashes: string[] };

  it('covers every way a round ends, and the rest', () => {
    const cov = coverage(results);
    expect(cov).toEqual(fixture.coverage);
    for (const k of ['reveals', 'forfeit', 'void', 'tips', 'pending', 'ended', 'missing', 'invalidCloses', 'held']) {
      expect(cov[k], k).toBeGreaterThan(0);
    }
  });

  it('300 random sessions fold to the same bytes as before', () => {
    expect(fixture.sessions).toBe(SESSIONS);
    const diff = hashes.map((h, i) => (h === fixture.hashes[i] ? -1 : i)).filter((i) => i >= 0);
    expect(diff, 'sessions whose output changed').toEqual([]);
  });

  it('a warm fold, fed in a random order with deletes and re-puts, ends where the cold one does', () => {
    for (let n = 0; n < SESSIONS; n += 7) {
      const g = generated[n];
      const rand = rng(5000 + n);
      const f = new TableFold(TEST_CTX, checkFor(g.hold), g.keyOf);
      f.setBase(g.cp);
      const order = shuffled(g.records, rand);
      for (const [key, value] of order) {
        f.apply([[key, value]]);
        if (rand() < 0.2) {
          f.apply([[key, undefined]]);
          f.result();
          f.apply([[key, value]]);
        }
        if (rand() < 0.3) f.result();
      }
      expect(outputOf(f.result()), `session ${n}`).toBe(outputOf(results[n]));
    }
  });
});
