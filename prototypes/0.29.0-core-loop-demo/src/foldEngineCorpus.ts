/**
 * 🧮🧪 Sessions to fold in two engines (V8 here, QuickJS in the node), and
 * what the first said.
 *
 * The node folds a computed table with the pages' own fold, bundled
 * (foldEntry.ts → ssf-p2p-node/fold/fold.min.js) and run in QuickJS. This
 * module makes the sessions both are given: random but seeded roulette,
 * house-roulette and craps sessions in the style of computedFoldGolden.test.ts
 * (slips with several versions, rival closes, forks, wrong and missing reveals,
 * forfeits, abandons, signatures that fail or are not checked yet, checkpoints
 * with nets and carried state, house joins, reveals and step-downs, junk), and
 * a few made by hand for the values only a node can be handed (floats, nulls,
 * booleans, unsafe integers, unusual strings).
 *
 * Used by foldEngineVectors.test.ts, which writes test-vectors/fold-engine-v1.json
 * (the sessions and what V8 folds each to) and checks the checked-in bundle
 * against the same; house_fold.rs's tests fold the same file in QuickJS.
 */

import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { closeKey, nextSid, recHash, TableFold } from './computedFold';
import type { Checkpoint, CloseRec, FoldCtx, SlipRec } from './computedFold';
import { basisOf, canonFelt, EMPTY_CARRY } from './computedCraps';
import type { CrapsCarry } from './computedCraps';
import { b64url, ComputedKit, fakeIdentity, testHouse, testIdentity } from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import type { CrapsBet, CrapsBetType } from './games/craps';
import type { RouletteBet, RouletteBetType } from './games/roulette';

/** One session to fold: everything the fold is given. */
export interface FoldCase {
  name: string;
  ctx: FoldCtx;
  /** The checkpoint the live session follows (as the doc holds it), or null. */
  cp: Checkpoint | null;
  /** The keys that are the room's houses. */
  houses: string[];
  /** The key pinned for each player, [pid, key] (trust on first use, as the
   *  pages pin: casinoDoc computedPinOf). A slip counts for a felt only if it
   *  is signed by its player's pin; a player with none has no felt. */
  pins: [string, string][];
  /** `fake`: a player's "signature" is sha512 of the signed bytes (a record
   *  signed with fakeIdentity checks out); `real`: ed25519, strict. The
   *  house's records are always real. */
  sigs: 'fake' | 'real';
  /** Records the host answers "not checked yet" for, by record hash. */
  hold: string[];
  /** The live session's records, as [key, value]. */
  records: [string, unknown][];
  /** The same records as a cold start's first slice and then warm batches:
   *  [key] deletes, [key, value] puts. The fold ends where the cold one does. */
  warm: ([string] | [string, unknown])[][];
}

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

const hex = (s: string, n: number): string => bytesToHex(sha256(utf8ToBytes(s))).slice(0, n);

const ROOM = 'room-fold-corpus';
// Names a JS object property or a path segment could trip on, and strings a
// UTF-8 encoder could (astral, full-width, a zero-width joiner, U+2028).
const NAMES = ['alice', 'bob', 'carol', 'dave', 'erin', 'constructor', 'toString', 'p:q', '\u{1F600}a', '！b', 'a‍b', 'x y'];
const PLAIN: RouletteBetType[] = ['red', 'black', 'odd', 'even', 'low', 'high'];
const CRAPS_TYPES: CrapsBetType[] = [
  'pass', 'dontpass', 'come', 'dontcome', 'field', 'place', 'big6', 'big8', 'hard', 'anyseven', 'anycraps', 'two', 'three', 'yo', 'twelve',
  'passodds', 'dontpassodds', 'comeodds', 'dontcomeodds',
];
const POINTS = [4, 5, 6, 8, 9, 10];
export const HOUSE = testHouse('fold-corpus-house');
export const ROGUE = testHouse('fold-corpus-rogue');

const ctxOf = (letter: 'c' | 'r' | 'k' | 'd'): FoldCtx => ({
  room: ROOM,
  t: letter === 'k' || letter === 'd' ? 'craps-1' : 'roulette-1',
  inc: letter + '0123456789abcdef01234567',
});

/** Warm batches for `records`: a shuffled order, deletes and re-puts. */
function warmOf(records: [string, unknown][], rand: () => number): FoldCase['warm'] {
  const order = shuffled(records, rand);
  const batches: FoldCase['warm'] = [];
  let batch: FoldCase['warm'][number] = [];
  for (const [key, value] of order) {
    batch.push([key, value]);
    if (rand() < 0.2) {
      batch.push([key]);
      batch.push([key, value]);
    }
    if (rand() < 0.3) {
      batches.push(batch);
      batch = [];
    }
  }
  batches.push(batch);
  return batches;
}

interface Draft {
  cp: Checkpoint | null;
  records: [string, unknown][];
  hold: Set<string>;
  pins: [string, string][];
}

/** The pins of a session's players: each one's key, but now and then (from its
 *  own random stream, so the sessions stay as they were) a player the host has
 *  not pinned yet. */
function pinsOf(ids: ReadonlyMap<string, TestIdentity>, seed: number): [string, string][] {
  const rand = rng(7000 + seed);
  return [...ids].filter(() => rand() >= 0.12).map(([p, id]): [string, string] => [p, id.pub]);
}

/** A roulette session at `ctx` (c… or r…): the golden style. */
function roulette(n: number, ctx: FoldCtx, maxRounds: number, maxNames: number): Draft {
  const rand = rng(1000 + n);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const chance = (p: number): boolean => rand() < p;
  const house = ctx.inc[0] === 'r';
  const kit = new ComputedKit(ctx);
  const names = shuffled(NAMES, rand).slice(0, 2 + Math.floor(rand() * (maxNames - 1)));
  const ids = new Map<string, TestIdentity>(names.map((p) => [p, fakeIdentity(`corpus-${n}-${p}`, p)]));
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
  const felt = (): RouletteBet[] => (chance(0.1) ? [] : Array.from({ length: 1 + Math.floor(rand() * 3) }, bet));
  const badSig = <R extends { g: string }>(rec: R): R => ({ ...rec, g: b64url(sha512(utf8ToBytes(`bad-${n}-${rand()}`))) });

  let cp: Checkpoint | null = null;
  if (chance(0.3)) {
    const nets: Record<string, bigint> = {};
    for (const p of names) if (chance(0.6)) nets[p] = BigInt(Math.floor(rand() * 400) - 200);
    const b = chance(0.5) ? 'g' : hex(`corpus-sid-${n}`, 24);
    const h = house && chance(0.5) ? kit.houseCommit(HOUSE, 2) : undefined;
    cp = kit.checkpoint(pick([...ids.values()]), b, 1 + Math.floor(rand() * 5), hex(`corpus-l-${n}`, 32), nets, chance(0.1) ? 1 : undefined, undefined, h);
  }
  const u = cp ? cp.u : 0;
  let parents: string[] = [nextSid(ctx, cp)];
  let required: string | null = cp?.h ?? null;
  const rounds = 1 + Math.floor(rand() * maxRounds);
  for (let r = u + 1; r <= u + rounds; r++) {
    const slips = new Map<string, Built<SlipRec>[]>();
    for (const p of names) {
      if (!chance(0.85)) continue;
      const id = ids.get(p)!;
      const versions: Built<SlipRec>[] = [];
      const count = 1 + Math.floor(rand() * 2);
      for (let v = 1; v <= count; v++) {
        const seed = chance(0.15) ? kit.seed(p, r, `alt${v}`) : kit.seed(p, r);
        const s = kit.slip(id, r, felt(), { v: chance(0.1) ? 1 : v, seed });
        versions.push(s);
        add(s);
      }
      slips.set(p, versions);
    }
    // At a house table the house joins a joinable round, or a close names what is required.
    let hc: string | undefined;
    if (house && chance(0.75)) {
      if (required) hc = required;
      else {
        const j = kit.houseJoin(HOUSE, r);
        add(j);
        hc = j.rec.c;
      }
      if (chance(0.05)) add(kit.houseJoin(ROGUE, r));
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
        const q = chance(0.08) ? hex(`corpus-q-${n}-${r}-${i}`, 32) : pick(parents);
        let c = kit.close(ids.get(signer)!, r, q, f, hc !== undefined && chance(0.9) ? hc : undefined);
        if (chance(0.05)) {
          const rec = badSig(c.rec);
          c = { key: closeKey(rec)!, hash: recHash(rec)!, rec };
        }
        closes.push(c);
        add(c);
      }
    }
    const revealed = new Map<string, Set<string>>();
    for (const c of closes) {
      const got = new Set<string>();
      for (const [p, h] of Object.entries(c.rec.f)) {
        const s = slips.get(p)?.find((x) => x.hash === h);
        if (!s) continue;
        if (chance(0.8)) {
          const seed = [kit.seed(p, r), kit.seed(p, r, 'alt1'), kit.seed(p, r, 'alt2')].find((x) => kit.commit(r, p, x) === s.rec.c);
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
    // The house reveals the lowest-hash close naming its commitment, or steps down.
    required = null;
    if (house) {
      const mine = closes.filter((c) => c.rec.h && c.rec.h === hc).sort((a, b) => (a.hash < b.hash ? -1 : 1));
      if (mine.length && chance(0.85)) {
        const carryNext = chance(0.85);
        const frozen = Object.values(mine[0].rec.f);
        add(kit.houseReveal(HOUSE, r, [mine[0].hash], chance(0.9) ? frozen : frozen.slice(1), carryNext ? {} : { c: null }));
        if (carryNext) required = kit.houseCommit(HOUSE, r + 1);
      } else if (chance(0.1)) add(kit.stepDown(HOUSE, r));
    }
    if (closes.length) parents = closes.map((c) => c.hash);
  }
  if (chance(0.3)) records.push([`s:1:alice:${'0'.repeat(32)}`, { r: 1 }]);
  if (chance(0.2)) records.push([`h:1:${'3'.repeat(32)}`, { house: 1 }]);
  if (chance(0.2)) records.push(['note', 'hello']);
  return { cp, records, hold, pins: pinsOf(ids, 1000 + n) };
}

/** A craps session at `ctx` (k… or d…): riders, points, carried state. */
function craps(n: number, ctx: FoldCtx, maxRounds: number, maxNames: number): Draft {
  const rand = rng(77000 + n);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const chance = (p: number): boolean => rand() < p;
  const kit = new ComputedKit(ctx);
  const house = ctx.inc[0] === 'd';
  const names = shuffled(NAMES, rand).slice(0, 2 + Math.floor(rand() * (maxNames - 1)));
  const ids = new Map<string, TestIdentity>(names.map((p) => [p, fakeIdentity(`corpus-craps-${n}-${p}`, p)]));
  const records: [string, unknown][] = [];
  const hold = new Set<string>();
  const add = (b: Built<unknown>): void => {
    records.push([b.key, b.rec]);
    if (chance(0.03)) hold.add(b.hash);
  };
  const bet = (): CrapsBet => {
    const type = pick(CRAPS_TYPES);
    const amount = 1 + Math.floor(rand() * 60);
    if (type === 'place' || type === 'comeodds' || type === 'dontcomeodds') return { type, pick: pick(POINTS), amount };
    if (type === 'hard') return { type, pick: pick([4, 6, 8, 10]), amount };
    if ((type === 'come' || type === 'dontcome') && chance(0.3)) return { type, pick: pick(POINTS), amount };
    return { type, amount };
  };
  let cp: Checkpoint | null = null;
  if (chance(0.3)) {
    const nets: Record<string, bigint> = {};
    for (const p of names) if (chance(0.6)) nets[p] = BigInt(Math.floor(rand() * 4000) - 2000);
    const ended = chance(0.1);
    let s: CrapsCarry | undefined;
    if (!ended) {
      const w: Record<string, CrapsBet[]> = {};
      const p = chance(0.5) ? 0 : pick(POINTS);
      for (const pid of names) {
        if (chance(0.4)) {
          w[pid] = canonFelt([{ type: p ? 'pass' : 'place', ...(p ? {} : { pick: pick(POINTS) }), amount: 5 + Math.floor(rand() * 20) } as CrapsBet]);
        }
      }
      s = { p, w };
      if (chance(0.6)) {
        s.h = pick(names);
        if (chance(0.5)) s.i = 1;
      }
      if (chance(0.3)) s.a = pick(names);
    }
    const cpH = house && !ended && chance(0.5) ? kit.houseCommit(HOUSE, 2 + Math.floor(rand() * 3)) : undefined;
    cp = kit.checkpoint(
      pick([...ids.values()]), chance(0.5) ? 'g' : hex(`corpus-craps-sid-${n}`, 24), 1 + Math.floor(rand() * 3), hex(`corpus-craps-l-${n}`, 32), nets,
      ended ? 1 : undefined, s, cpH,
    );
  }
  // The carry a round plays from is the fold's own, so the generator folds as it goes.
  const carryNow = (): CrapsCarry => {
    const probe = new Probe(ctx, cp, records, hold);
    return probe.carry();
  };
  const u = cp ? cp.u : 0;
  let parents: string[] = [nextSid(ctx, cp)];
  let required: string | null = cp?.h ?? null;
  let carry: CrapsCarry = carryNow();
  const rounds = 1 + Math.floor(rand() * maxRounds);
  for (let r = u + 1; r <= u + rounds; r++) {
    const slips = new Map<string, Built<SlipRec>[]>();
    for (const p of names) {
      if (!chance(0.85)) continue;
      const id = ids.get(p)!;
      const versions: Built<SlipRec>[] = [];
      const count = 1 + Math.floor(rand() * 2);
      for (let v = 1; v <= count; v++) {
        const riding = Object.prototype.hasOwnProperty.call(carry.w, p) ? carry.w[p] : [];
        const extra = Array.from({ length: Math.floor(rand() * 3) }, bet);
        const b = chance(0.1) ? [] : canonFelt(chance(0.8) ? [...riding, ...extra] : extra);
        const o = chance(0.92) ? basisOf(carry, p) : hex(`corpus-basis-${n}-${r}-${p}`, 32);
        const seed = chance(0.15) ? kit.seed(p, r, `alt${v}`) : kit.seed(p, r);
        const s = kit.crapsSlip(id, r, b, o, {
          v: chance(0.1) ? 1 : v, seed, ...(chance(0.2) ? { t: 1 + Math.floor(rand() * 7) } : {}), ...(chance(0.05) ? { l: 1 as const } : {}),
        });
        versions.push(s as unknown as Built<SlipRec>);
        add(s);
      }
      slips.set(p, versions);
    }
    let hc: string | undefined;
    if (house && chance(0.75)) {
      if (required) hc = required;
      else {
        const j = kit.houseJoin(HOUSE, r);
        add(j);
        hc = j.rec.c;
      }
      if (chance(0.05)) add(kit.houseJoin(ROGUE, r));
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
        const q = chance(0.08) ? hex(`corpus-craps-q-${n}-${r}-${i}`, 32) : pick(parents);
        const c = kit.close(ids.get(signer)!, r, q, f, hc !== undefined && chance(0.9) ? hc : undefined);
        closes.push(c);
        add(c);
      }
    }
    for (const c of closes) {
      const got: string[] = [];
      for (const [p, h] of Object.entries(c.rec.f)) {
        const s = slips.get(p)?.find((x) => x.hash === h);
        if (!s) continue;
        if (chance(0.8)) {
          const seed = [kit.seed(p, r), kit.seed(p, r, 'alt1'), kit.seed(p, r, 'alt2')].find((x) => kit.commit(r, p, x) === s.rec.c);
          if (seed) {
            add(kit.reveal(r, p, seed));
            got.push(p);
          }
        }
      }
      if (got.length && chance(0.25)) {
        const writer = pick(got);
        add(kit.forfeit(ids.get(writer)!, r, c.hash, got.filter((p) => p === writer || chance(0.5))));
      }
      if (chance(0.12)) add(kit.abandon(pick([...ids.values()]), r, c.hash));
    }
    required = null;
    if (house) {
      const mine = closes.filter((c) => c.rec.h && c.rec.h === hc).sort((a, b) => (a.hash < b.hash ? -1 : 1));
      if (mine.length && chance(0.85)) {
        const c = mine[0];
        const present = Object.values(c.rec.f).filter((h) => [...slips.values()].some((vs) => vs.some((s) => s.hash === h)));
        const carryNext = chance(0.85);
        add(kit.houseReveal(HOUSE, r, [c.hash], chance(0.9) ? present : present.slice(1), carryNext ? {} : { c: null }));
        if (carryNext) required = kit.houseCommit(HOUSE, r + 1);
      } else if (chance(0.1)) add(kit.stepDown(HOUSE, r));
    }
    if (closes.length) parents = closes.map((c) => c.hash);
    carry = carryNow();
  }
  if (chance(0.2)) records.push(['note', 'hello']);
  return { cp, records, hold, pins: pinsOf(ids, 2000 + n) };
}

/** The fold of what a generator has made so far, for the carry the next round plays from. */
class Probe {
  private readonly res;
  constructor(ctx: FoldCtx, cp: Checkpoint | null, records: [string, unknown][], hold: Set<string>) {
    const f = new TableFold(ctx, (hash) => (hold.has(hash) ? undefined : true), undefined, undefined, (pub) => pub === HOUSE.pub);
    f.setBase(cp);
    f.reset(records);
    this.res = f.result();
  }
  carry(): CrapsCarry {
    return (this.res.carry as CrapsCarry | null) ?? EMPTY_CARRY;
  }
}

function caseOf(name: string, ctx: FoldCtx, d: Draft, seed: number): FoldCase {
  return {
    name,
    ctx,
    cp: d.cp,
    houses: [HOUSE.pub],
    pins: d.pins,
    sigs: 'fake',
    hold: [...d.hold].sort(),
    records: d.records,
    warm: warmOf(d.records, rng(5000 + seed)),
  };
}

// ── By hand: what only a node is handed ──

/** A real, signed round at a house roulette table: slips, a close naming the house's join, the house's reveal. */
function realSigned(): FoldCase {
  const ctx = ctxOf('r');
  const kit = new ComputedKit(ctx);
  const [alice, bob] = [testIdentity('corpus-alice', 'alice'), testIdentity('corpus-bob', 'bob')];
  const a1 = kit.slip(alice, 1, [{ type: 'red', amount: 5 }]);
  const b1 = kit.slip(bob, 1, [{ type: 'straight', pick: 17, amount: 2 }]);
  const join = kit.houseJoin(HOUSE, 1);
  const c1 = kit.close(alice, 1, kit.sidAfter(null), [a1, b1], join.rec.c);
  const reveal = kit.houseReveal(HOUSE, 1, [c1.hash], [a1.hash, b1.hash]);
  const records: [string, unknown][] = [a1, b1, join, c1, kit.reveal(1, 'alice'), kit.reveal(1, 'bob'), reveal].map((b) => [b.key, b.rec]);
  // A forged player's slip (alice's, signed by bob) and a rogue house's join.
  const forged = { ...a1.rec, g: b1.rec.g, v: 2 };
  records.push([`s:1:alice:${recHash(forged)!}`, forged]);
  records.push([kit.houseJoin(ROGUE, 1).key, kit.houseJoin(ROGUE, 1).rec]);
  return { name: 'real signatures, one round decided by the house', ctx, cp: null, houses: [HOUSE.pub], pins: [['alice', alice.pub], ['bob', bob.pub]], sigs: 'real', hold: [], records, warm: warmOf(records, rng(1)) };
}

/** Values a Yjs doc can hold that a record must not: the fold's guards judge them. */
function oddities(): FoldCase {
  const ctx = ctxOf('r');
  const kit = new ComputedKit(ctx);
  const alice = fakeIdentity('corpus-odd-alice', 'alice');
  const s1 = kit.slip(alice, 1, [{ type: 'red', amount: 5 }]);
  const c1 = kit.close(alice, 1, kit.sidAfter(null), [s1]);
  const records: [string, unknown][] = [[s1.key, s1.rec], [c1.key, c1.rec], [kit.reveal(1, 'alice').key, kit.reveal(1, 'alice').rec]];
  const bad = (key: string, value: unknown): void => {
    records.push([key, value]);
  };
  const withField = <R extends object>(rec: R, field: string, value: unknown): R => ({ ...rec, [field]: value });
  // A float, a null, a boolean, an unsafe integer, an array with a hole's worth of null, a nested object, in each place a record has a field.
  bad(`s:1:alice:${'1'.repeat(32)}`, withField(s1.rec, 'v', 1.5));
  bad(`s:1:alice:${'2'.repeat(32)}`, withField(s1.rec, 'v', null));
  bad(`s:1:alice:${'3'.repeat(32)}`, withField(s1.rec, 'b', [{ type: 'red', amount: true }]));
  bad(`s:1:alice:${'4'.repeat(32)}`, withField(s1.rec, 'r', 9007199254740993));
  bad(`c:1:${'5'.repeat(32)}`, withField(c1.rec, 'f', { alice: null }));
  bad(`c:1:${'6'.repeat(32)}`, withField(c1.rec, 'q', ['g', null]));
  bad(`x:1:alice:${'7'.repeat(32)}`, { r: 1, p: 'alice', s: 'ab', extra: { deep: [1, 2, { deeper: false }] } });
  bad('note', { a: { b: { c: null } } });
  bad('empty', {});
  bad('list', []);
  bad(`h:1:${'8'.repeat(32)}`, { r: 1, s: 'a'.repeat(64), x: [], n: [], k: HOUSE.pub, g: 'A'.repeat(86) });
  // Strings the signed bytes and the canon see as UTF-8: astral, full-width, a joiner, U+2028, U+FFFD.
  const odd = ['\u{1F600}', '！', 'a‍b', 'x y', '�', 'é', '\u0000', '"\\/'];
  for (const [i, name] of odd.entries()) {
    const id = fakeIdentity(`corpus-odd-${i}`, name);
    const s = kit.slip(id, 1, [{ type: 'black', amount: 1 + i }]);
    records.push([s.key, s.rec]);
    records.push([kit.reveal(1, name).key, kit.reveal(1, name).rec]);
  }
  const pins: [string, string][] = [['alice', alice.pub], ...odd.map((name, i): [string, string] => [name, fakeIdentity(`corpus-odd-${i}`, name).pub])];
  const f = Object.fromEntries(odd.map((name, i) => [name, recHash(kit.slip(fakeIdentity(`corpus-odd-${i}`, name), 1, [{ type: 'black', amount: 1 + i }]).rec)!]));
  const c2 = kit.close(alice, 1, kit.sidAfter(null), { alice: s1.hash, ...f });
  records.push([c2.key, c2.rec]);
  return { name: 'values only a node is handed', ctx, cp: null, houses: [HOUSE.pub], pins, sigs: 'fake', hold: [], records, warm: warmOf(records, rng(2)) };
}

/** Pins at work: alice and bob have bet, mallory writes a higher version of alice's felt under HER OWN key, and carol, whose key
 *  the host has not pinned, has bet too. The felt is alice's pinned version, not mallory's 999; carol holds nothing. */
function rogue(letter: 'c' | 'r'): FoldCase {
  const ctx = ctxOf(letter);
  const kit = new ComputedKit(ctx);
  const [alice, bob, carol, mallory] = [
    fakeIdentity(`corpus-rogue-${letter}-alice`, 'alice'), fakeIdentity(`corpus-rogue-${letter}-bob`, 'bob'),
    fakeIdentity(`corpus-rogue-${letter}-carol`, 'carol'), fakeIdentity(`corpus-rogue-${letter}-mallory`, 'mallory'),
  ];
  const a1 = kit.slip(alice, 1, [{ type: 'red', amount: 10 }]);
  const b1 = kit.slip(bob, 1, [{ type: 'black', amount: 7 }]);
  const c1 = kit.slip(carol, 1, [{ type: 'odd', amount: 3 }]);
  const forged = kit.slip(mallory, 1, [{ type: 'red', amount: 999 }], { v: 2, p: 'alice' });
  const records: [string, unknown][] = [a1, b1, c1, forged].map((b) => [b.key, b.rec]);
  return {
    name: `a rogue key writes a felt under another player's name (${letter})`, ctx, cp: null, houses: [HOUSE.pub],
    pins: [['alice', alice.pub], ['bob', bob.pub]], sigs: 'fake', hold: [], records, warm: warmOf(records, rng(4)),
  };
}

/** A table whose incarnation has ended (the checkpoint says so): the session counts nothing, the nets are the checkpoint's. */
function ended(letter: 'c' | 'k'): FoldCase {
  const ctx = ctxOf(letter);
  const kit = new ComputedKit(ctx);
  const alice = fakeIdentity('corpus-end-alice', 'alice');
  const cp = kit.checkpoint(alice, 'g', 3, hex('corpus-end-l', 32), { alice: 40n, bob: -40n }, 1);
  const sid = nextSid(ctx, cp);
  const slip = letter === 'k' ? kit.crapsSlip(alice, 4, [{ type: 'field', amount: 5 }], basisOf(EMPTY_CARRY, 'alice')) : kit.slip(alice, 4, [{ type: 'red', amount: 5 }]);
  const close = kit.close(alice, 4, sid, [slip as unknown as Built<SlipRec>]);
  const records: [string, unknown][] = [[slip.key, slip.rec], [close.key, close.rec], [kit.reveal(4, 'alice').key, kit.reveal(4, 'alice').rec]];
  return {
    name: `ended ${letter}`, ctx, cp, houses: [HOUSE.pub], pins: [['alice', alice.pub]], sigs: 'fake', hold: [], records, warm: warmOf(records, rng(3)),
  };
}

/** The corpus: [size knobs] sessions of each family, then the hand-made ones. */
export function corpus(opts: { roulette?: number; house?: number; craps?: number; rounds?: number; names?: number } = {}): FoldCase[] {
  const { roulette: nr = 6, house: nh = 6, craps: nc = 8, rounds = 4, names = 4 } = opts;
  const out: FoldCase[] = [];
  for (let n = 0; n < nr; n++) out.push(caseOf(`roulette ${n}`, ctxOf('c'), roulette(n, ctxOf('c'), rounds, names), n));
  for (let n = 0; n < nh; n++) out.push(caseOf(`house roulette ${n}`, ctxOf('r'), roulette(100 + n, ctxOf('r'), rounds, names), 100 + n));
  for (let n = 0; n < nc; n++) {
    const letter = n % 2 ? 'd' : 'k';
    out.push(caseOf(`${letter === 'd' ? 'house craps' : 'craps'} ${n}`, ctxOf(letter), craps(n, ctxOf(letter), rounds, names), 200 + n));
  }
  out.push(realSigned(), oddities(), rogue('c'), rogue('r'), ended('c'), ended('k'));
  return out;
}
