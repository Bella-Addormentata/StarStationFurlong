/**
 * 🎲🧮 Craps in the room's records (PR 3 of "Computed casino tables"): the
 * name, the game read from it, the fold per game, the version check per
 * game, and the checkpoint per game.
 *
 * A computed incarnation's name says its game: `c…` roulette, `k…` craps
 * (computedFold gameOfInc). These specs pin what the name decides: which
 * slip and checkpoint shapes are read, which rules the fold plays, which
 * name the house's switch takes; that a page of PR 2's build reads every
 * craps record as junk, that a removal made on one ends the table on this
 * build's pages, and that the chip sum adds up through a craps hand played
 * from records written by hand: a pass that travels, a place win, a void, a
 * trim mid-point, a forfeit, a seven-out, and the end.
 *
 * The fold specs use computedTestKit's records; the room specs are pages
 * of computedPageKit, synced by hand, their records signed by each page's
 * own key and written straight into the doc, as an honest page's duties
 * will write them (commit 4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { basisOf, canonFelt, diceOf, EMPTY_CARRY, MAX_RIDERS, own } from './computedCraps';
import type { CrapsCarry } from './computedCraps';
import {
  asCheckpoint, asCheckpointFor, asCrapsCheckpoint, asCrapsSlip, asSlip, asSlipFor, crapsGame, foldGameOf, gameOfInc, nextSid,
  recHash, rouletteGame, seedTable, slipKeyFor, TableFold,
} from './computedFold';
import type { Checkpoint, CrapsSlipRec, FoldCtx, FoldResult } from './computedFold';
import { clockOf, frame, loadPage, PAGE_ROOM, sync, switchOn } from './computedPageKit';
import type { Page } from './computedPageKit';
import {
  cachingCheck, ComputedKit, fakeIdentity, red, TEST_CTX, TestSession, testIdentity, trustAll,
} from './computedTestKit';
import type { Built, TestIdentity } from './computedTestKit';
import { canPlaceBet } from './games/craps';
import type { CrapsBet, CrapsBetType } from './games/craps';

vi.stubGlobal('window', { location: { search: '' } });

const KCTX: FoldCtx = { room: 'room-test', t: 'craps-1', inc: 'k0123456789abcdef01234567' };
const kit = new ComputedKit(KCTX);
const rkit = new ComputedKit(TEST_CTX);
const sigs = cachingCheck();
const AMY = testIdentity('amy', 'player-Amy');
const BOB = testIdentity('bob', 'player-Bob');

const bet = (type: CrapsBetType, amount: number, pick?: number): CrapsBet =>
  pick === undefined ? { type, amount } : { type, pick, amount };
const felt = (...bets: CrapsBet[]): CrapsBet[] => canonFelt(bets);
/** A rider's felt in a carry, the way the fold builds one. */
function carryOf(p: number, w: Record<string, CrapsBet[]>, extra: Partial<CrapsCarry> = {}): CrapsCarry {
  const nw: Record<string, CrapsBet[]> = Object.create(null);
  for (const pid of Object.keys(w)) nw[pid] = w[pid];
  return { p, w: nw, ...extra };
}
const fresh = (pid: string): string => basisOf(EMPTY_CARRY, pid);

/** A live craps checkpoint body as a trim signs it (signature in shape only). */
function crapsCp(s: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, b: 'g', u: 1, l: 'ab'.repeat(16), n: { 'player-Amy': '5' }, s, k: 'K'.repeat(43), g: 'G'.repeat(86), ...extra };
}

// ── 🏷 The name ──────────────────────────────────────────────────────────────

describe('the game a name says', () => {
  it('k is craps, anything else roulette; the fold plays by it unless told otherwise', () => {
    expect(gameOfInc(KCTX.inc)).toBe('craps');
    expect(gameOfInc(TEST_CTX.inc)).toBe('roulette');
    expect(foldGameOf(KCTX)).toBe(crapsGame);
    expect(foldGameOf(TEST_CTX)).toBe(rouletteGame);
    // A craps fold plays a roll and carries the pass line on; a roulette one spins.
    const s = kit.crapsSlip(AMY, 1, felt(bet('pass', 10)), fresh(AMY.pid), { t: 1 });
    const craps = new TestSession().put(s, kit.close(AMY, 1, 'g', [s]), kit.reveal(1, AMY.pid)).fold(sigs.check, null, KCTX).result();
    const roll = craps.rounds[0];
    expect(roll.decided).toBe('reveals');
    expect(roll.pocket).toBeNull();
    expect(roll.craps!.dice).toEqual(diceOf(seedTable(KCTX), 1, [kit.seed(AMY.pid, 1)]));
    expect(roll.craps!.sIn).toBe(EMPTY_CARRY);
    expect(craps.carry).toBe(roll.craps!.sOut);
    const r = rkit.slip(AMY, 1, [red(10)]);
    const roulette = new TestSession().put(r, rkit.close(AMY, 1, 'g', [r]), rkit.reveal(1, AMY.pid)).fold(sigs.check).result();
    expect(roulette.rounds[0].craps).toBeUndefined();
    expect(roulette.rounds[0].pocket).toEqual(expect.any(Number));
    expect(roulette.carry).toBeNull();
  });

  it('each game reads only its own slips: the other\'s are junk, under any key', () => {
    const c = kit.crapsSlip(AMY, 1, felt(bet('pass', 10)), fresh(AMY.pid));
    const r = rkit.slip(AMY, 1, [red(10)]);
    expect(asSlipFor(KCTX)(c.rec)).toBe(c.rec);
    expect(slipKeyFor(KCTX)(c.rec)).toBe(c.key);
    expect(c.key).toBe(`s:1:${AMY.pid}:${recHash(c.rec)}`);
    expect(asSlipFor(TEST_CTX)(c.rec)).toBeNull();
    expect(slipKeyFor(TEST_CTX)(c.rec)).toBeNull();
    expect(asSlip(c.rec)).toBeNull();
    expect(asSlipFor(KCTX)(r.rec)).toBeNull();
    expect(slipKeyFor(KCTX)(r.rec)).toBeNull();
    // Indexed by each game's fold: only its own count.
    const both = new TestSession().put(c, r);
    const atK = both.fold(sigs.check, null, KCTX).result();
    const atC = both.fold(sigs.check, null, TEST_CTX).result();
    expect([atK.records, atK.felts.get(AMY.pid)?.hash]).toEqual([1, c.hash]);
    expect([atC.records, atC.felts.get(AMY.pid)?.hash]).toEqual([1, r.hash]);
  });

  it('a craps slip has exactly its fields: a canonical felt, the stamp, a stand 1 to 7, a goodbye of 1', () => {
    const base = kit.crapsSlip(AMY, 2, felt(bet('pass', 10), bet('place', 12, 8)), fresh(AMY.pid), { t: 4 }).rec;
    expect(asCrapsSlip(base)).toBe(base);
    for (const t of [1, 7]) expect(asCrapsSlip({ ...base, t })).not.toBeNull();
    expect(asCrapsSlip({ ...base, t: undefined })).not.toBeNull();
    expect(asCrapsSlip({ ...base, l: 1 })).not.toBeNull();
    expect(asCrapsSlip({ ...base, b: [] })).not.toBeNull(); // everything that may come down, down
    const bad: unknown[] = [
      { ...base, t: 0 }, { ...base, t: 8 }, { ...base, t: 1.5 }, { ...base, t: '1' },
      { ...base, l: 0 }, { ...base, l: 2 }, { ...base, l: true },
      { ...base, o: 'AB'.repeat(16) }, { ...base, o: 'ab'.repeat(15) }, { ...base, o: undefined },
      { ...base, b: [bet('place', 12, 8), bet('pass', 10)] },                 // not in spot order
      { ...base, b: [bet('pass', 5), bet('pass', 5)] },                        // one spot twice
      { ...base, b: [bet('pass', 0)] },
      { ...base, b: [bet('pass', 1e12 + 1)] },
      { ...base, b: [{ type: 'pass', amount: 10, x: 1 }] },
      { ...base, b: [bet('place', 12)] },                                      // place needs its number
      { ...base, b: [bet('field', 12, 3)] },                                   // field has none
      { ...base, b: [{ type: 'red', amount: 10 }] },                           // a roulette bet
      { ...base, e: 1 },
      { ...base, v: 0 },
    ];
    for (const v of bad) expect(asCrapsSlip(v), JSON.stringify(v)?.slice(0, 100)).toBeNull();
  });
});

// ── 🧾 The checkpoint ─────────────────────────────────────────────────────────

describe('a craps checkpoint', () => {
  const amyFelt = felt(bet('pass', 10), bet('passodds', 20));
  const honest = carryOf(6, { 'player-Amy': amyFelt }, { h: 'player-Amy', a: 'player-Bob', i: 1 });

  it('carries the state while the table is live, and none once it has ended', () => {
    expect(asCrapsCheckpoint(crapsCp(honest))).not.toBeNull();
    expect(asCrapsCheckpoint(crapsCp(EMPTY_CARRY))).not.toBeNull();
    expect(asCrapsCheckpoint(crapsCp(undefined))).toBeNull();
    expect(asCrapsCheckpoint(crapsCp(undefined, { e: 1 }))).not.toBeNull();
    expect(asCrapsCheckpoint(crapsCp(honest, { e: 1 }))).toBeNull();
    // Roulette's reader refuses a carry, as PR 2's did; each name reads its own.
    expect(asCheckpoint(crapsCp(honest))).toBeNull();
    expect(asCheckpointFor(TEST_CTX)(crapsCp(honest))).toBeNull();
    expect(asCheckpointFor(KCTX)(crapsCp(honest))).not.toBeNull();
    expect(asCheckpointFor(KCTX)(crapsCp(undefined))).toBeNull();
  });

  it('holds the carry to every rule it states', () => {
    const w = (pid: string, f: unknown): Record<string, unknown> => ({ [pid]: f });
    const ok: unknown[] = [
      carryOf(0, {}),
      { p: 4, w: { 'player-Amy': amyFelt } },                                 // a plain w, as the doc gives it
      { p: 6, w: w('constructor', amyFelt), h: 'constructor', i: 1 },       // a built-in name is a player id
      { p: 6, w: {}, h: 'x'.repeat(128), a: 'y'.repeat(128) },
      { p: 10, w: Object.fromEntries(Array.from({ length: MAX_RIDERS }, (_, i) => [`p${i}`, amyFelt])) },
    ];
    for (const s of ok) expect(asCrapsCheckpoint(crapsCp(s)), JSON.stringify(s).slice(0, 100)).not.toBeNull();
    const bad: unknown[] = [
      { p: 3, w: {} }, { p: 7, w: {} }, { p: '6', w: {} }, { p: 6 }, { w: {} }, { p: 6, w: [] }, { p: 6, w: {}, x: 1 },
      { p: 6, w: Object.fromEntries(Array.from({ length: MAX_RIDERS + 1 }, (_, i) => [`p${i}`, amyFelt])) },
      { p: 6, w: w('player-Amy', []) },                                       // a rider has chips down
      { p: 6, w: w('player-Amy', [bet('pass', 5), bet('pass', 5)]) },         // canonical felts only
      { p: 6, w: w('', amyFelt) },
      { p: 6, w: JSON.parse(`{"__proto__": ${JSON.stringify(amyFelt)}}`) },
      { p: 6, w: {}, h: 'x'.repeat(129) }, { p: 6, w: {}, a: 'x'.repeat(129) }, { p: 6, w: {}, h: 7 },
      { p: 6, w: {}, i: 1 }, { p: 6, w: {}, h: 'player-Amy', i: 2 },
    ];
    for (const s of bad) expect(asCrapsCheckpoint(crapsCp(s)), JSON.stringify(s)?.slice(0, 100)).toBeNull();
  });

  it('opens a session whose id covers the carry; a roulette sid is what it was', () => {
    const cp = { b: 'g', u: 1, l: 'ab'.repeat(16), n: {} };
    const a = nextSid(KCTX, { ...cp, s: honest });
    const b = nextSid(KCTX, { ...cp, s: carryOf(6, { 'player-Amy': amyFelt }, { h: 'player-Amy', i: 1 }) });
    expect(a).not.toBe(b);
    expect(nextSid(TEST_CTX, cp)).toBe(nextSid(TEST_CTX, { ...cp, s: undefined }));
  });

  it('every carry a roll makes passes it, through random hands with riders, voids and forfeits', () => {
    const ids = ['ann', 'ben', 'cat'].map((n) => fakeIdentity(n, `player-${n}`));
    const fold = new TableFold(KCTX, trustAll);
    fold.setBase(null);
    let rnd = 7;
    const rand = (n: number): number => { // mulberry32
      rnd = (rnd + 0x6d2b79f5) | 0;
      let x = Math.imul(rnd ^ (rnd >>> 15), 1 | rnd);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) % n;
    };
    const CANDIDATES: [CrapsBetType, number | undefined][] = [
      ['pass', undefined], ['dontpass', undefined], ['come', undefined], ['dontcome', undefined], ['field', undefined],
      ['big6', undefined], ['big8', undefined], ['passodds', undefined], ['dontpassodds', undefined], ['yo', undefined],
      ...[4, 5, 6, 8, 9, 10].map((n): [CrapsBetType, number] => ['place', n]),
      ...[4, 6, 8, 10].map((n): [CrapsBetType, number] => ['hard', n]),
      ...[4, 5, 6, 8, 9, 10].map((n): [CrapsBetType, number] => ['comeodds', n]),
    ];
    let parent = 'g';
    const seen = new Set<string>();
    let voids = 0, forfeits = 0, sevenOuts = 0;
    for (let r = 1; r <= 160; r++) {
      const res = fold.result();
      const S = res.carry as CrapsCarry;
      const point = S.p === 0 ? null : S.p;
      const slips: Built<CrapsSlipRec>[] = [];
      for (const [i, id] of ids.entries()) {
        if (rand(5) === 0) continue; // sits this roll out (a rider rides anyway)
        const C = own(S.w, id.pid);
        const [type, pick] = CANDIDATES[rand(CANDIDATES.length)];
        const next = canPlaceBet(type, point) ? felt(...C, bet(type, 1 + rand(20), pick)) : C;
        slips.push(kit.crapsSlip(id, r, next.length ? next : felt(bet('field', 1)), basisOf(S, id.pid), { t: 1 + i }));
      }
      if (!slips.length) slips.push(kit.crapsSlip(ids[0], r, felt(bet('field', 1)), basisOf(S, ids[0].pid), { t: 1 }));
      const close = kit.close(ids.find((id) => id.pid === slips[0].rec.p)!, r, parent, slips);
      const recs: Built<unknown>[] = [...slips, close];
      const fate = rand(10);
      if (fate === 0) {
        recs.push(kit.abandon(ids[0], r, close.hash));
      } else if (fate === 1 && slips.length > 1) {
        recs.push(kit.reveal(r, slips[0].rec.p), kit.forfeit(ids.find((id) => id.pid === slips[0].rec.p)!, r, close.hash, [slips[0].rec.p]));
      } else {
        for (const s of slips) recs.push(kit.reveal(r, s.rec.p));
      }
      fold.apply(recs.map((b) => [b.key, b.rec] as const));
      const after = fold.result();
      const v = after.rounds.at(-1)!;
      expect(v.r).toBe(r);
      expect(v.decided).not.toBeNull();
      voids += v.decided === 'void' ? 1 : 0;
      forfeits += v.decided === 'forfeit' ? 1 : 0;
      sevenOuts += v.craps!.sevenOut ? 1 : 0;
      const carry = after.carry as CrapsCarry;
      expect(carry).toBe(v.craps!.sOut);
      expect(asCrapsCheckpoint(crapsCp(carry)), `round ${r}`).not.toBeNull();
      seen.add(crapsGame.key(carry));
      parent = close.hash;
    }
    expect(voids).toBeGreaterThan(5);
    expect(forfeits).toBeGreaterThan(5);
    expect(sevenOuts).toBeGreaterThan(5);
    expect(seen.size).toBeGreaterThan(50);
  });
});

// ── 🧮 The fold at a craps table ─────────────────────────────────────────────

describe('the fold at a craps table', () => {
  it('lets a close freeze an empty felt, never be signed over one', () => {
    const a = kit.crapsSlip(AMY, 1, felt(bet('pass', 10)), fresh(AMY.pid), { t: 1 });
    const bEmpty = kit.crapsSlip(BOB, 1, [], fresh(BOB.pid), { t: 2 });
    const reveals = [kit.reveal(1, AMY.pid), kit.reveal(1, BOB.pid)];
    const byBob = new TestSession().put(a, bEmpty, kit.close(BOB, 1, 'g', [a, bEmpty]), ...reveals).fold(sigs.check, null, KCTX).result();
    expect(byBob.rounds).toEqual([]);
    expect(byBob.openCloses.map((c) => c.state)).toEqual(['invalid']);
    const byAmy = new TestSession().put(a, bEmpty, kit.close(AMY, 1, 'g', [a, bEmpty]), ...reveals).fold(sigs.check, null, KCTX).result();
    expect(byAmy.rounds[0]).toMatchObject({ present: [AMY.pid, BOB.pid], missing: [], decided: 'reveals' });
  });

  it("hands a trim's carry to the next session: the rolls after it play as they would have", () => {
    // Three rolls in one session…
    const rolls: { slips: Built<CrapsSlipRec>[] }[] = [];
    const one = new TestSession();
    const f1 = new TableFold(KCTX, sigs.check);
    f1.setBase(null);
    let parent = 'g';
    for (let r = 1; r <= 3; r++) {
      const S = f1.result().carry as CrapsCarry;
      const C = own(S.w, AMY.pid);
      const slips = [
        kit.crapsSlip(AMY, r, felt(...C, bet('field', 5)), basisOf(S, AMY.pid), { t: 1 }),
        kit.crapsSlip(BOB, r, felt(bet(S.p ? 'place' : 'pass', 6, S.p ? 6 : undefined)), basisOf(S, BOB.pid), { t: 2 }),
      ];
      const close = kit.close(AMY, r, parent, slips);
      one.put(...slips, close, kit.reveal(r, AMY.pid), kit.reveal(r, BOB.pid));
      f1.reset(one.records.entries());
      rolls.push({ slips });
      parent = close.hash;
    }
    const whole = f1.result();
    expect(whole.rounds.map((v) => v.decided)).toEqual(['reveals', 'reveals', 'reveals']);
    // …and the same, trimmed after the second.
    const two = whole.rounds[1];
    const nets: Record<string, bigint> = {};
    for (const v of whole.rounds.slice(0, 2)) for (const [pid, d] of v.deltas) nets[pid] = (nets[pid] ?? 0n) + d;
    const cp = kit.checkpoint(AMY, 'g', 2, two.close, nets, undefined, two.craps!.sOut);
    expect(asCrapsCheckpoint(cp)).not.toBeNull();
    const sid = kit.sidAfter(cp);
    const s3 = rolls[2].slips;
    const c3 = kit.close(AMY, 3, sid, s3);
    const after = new TestSession().put(...s3, c3, kit.reveal(3, AMY.pid), kit.reveal(3, BOB.pid)).fold(sigs.check, cp, KCTX).result();
    expect(after.base).toMatchObject({ sid, u: 2 });
    expect(after.base.state).toEqual(two.craps!.sOut);
    expect(after.base.state).not.toBe(two.craps!.sOut); // its own copy, `w` with no prototype
    expect(Object.getPrototypeOf((after.base.state as CrapsCarry).w)).toBeNull();
    const [w3, t3] = [whole.rounds[2], after.rounds[0]];
    expect(t3.craps!.dice).toEqual(w3.craps!.dice);
    expect(t3.deltas).toEqual(w3.deltas);
    expect(t3.craps!.sOut).toEqual(w3.craps!.sOut);
    expect(after.nets).toEqual(whole.nets);
    expect(after.held).toEqual(whole.held);
    // A live craps checkpoint with no carry is junk: the fold counts none.
    const { s: _s, ...noCarry } = cp;
    const junk = new TableFold(KCTX, sigs.check);
    junk.setBase(noCarry as Checkpoint);
    expect(junk.result().base).toMatchObject({ sid: 'g', u: 0, state: EMPTY_CARRY });
  });
});

// ── 🏛 PR 2's build ──────────────────────────────────────────────────────────
// Its name readers, copied exactly as they are in the build PR 2 shipped
// (casinoDoc COMPUTED_INC, computedKeyParts and computedCfgInc at e03c1f4):
// a page of that build reads a craps switch, session or checkpoint as no
// computed record at all.

const PR2_COMPUTED_INC = /^c[0-9a-f]{24}$/;
const PR2_COMPUTED_SID = /^(?:g|[0-9a-f]{24})$/;
function pr2KeyParts(key: string): { t: string; inc: string; sid?: string } | null {
  let rest: string;
  let sid: string | undefined;
  if (key.startsWith('ses:')) {
    const cut = key.lastIndexOf(':');
    sid = key.slice(cut + 1);
    if (cut <= 'ses:'.length || !PR2_COMPUTED_SID.test(sid)) return null;
    rest = key.slice('ses:'.length, cut);
  } else if (key.startsWith('sum:')) {
    rest = key.slice('sum:'.length);
  } else {
    return null;
  }
  const cut = rest.lastIndexOf(':');
  const inc = rest.slice(cut + 1);
  return cut > 0 && PR2_COMPUTED_INC.test(inc) ? { t: rest.slice(0, cut), inc, ...(sid !== undefined ? { sid } : {}) } : null;
}
function pr2CfgInc(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const cfg = value as { v?: unknown; inc?: unknown };
  return Object.keys(cfg).length === 2 && cfg.v === 1 && typeof cfg.inc === 'string' && PR2_COMPUTED_INC.test(cfg.inc)
    ? cfg.inc : null;
}

const T0 = 2_000_000_000;
const STEP = 200;
const CRAPS = 'craps-1';

describe("PR 2's build and a craps table", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads every craps name as no computed record, while this build's readers take both", async () => {
    const a = await loadPage('A', 1);
    clockOf(a, T0);
    const k = a.casino.computedIncFor(CRAPS, 'craps');
    const c = a.casino.computedIncFor(CRAPS, 'roulette');
    // House tables since PR 5: `d` for craps, `r` for roulette.
    expect(k).toMatch(/^d[0-9a-f]{24}$/);
    expect(c).toMatch(/^r[0-9a-f]{24}$/);
    expect(k.slice(1)).not.toBe(c.slice(1)); // a domain of its own
    expect(a.casino.computedIncFor(CRAPS)).toBe(c); // roulette's by default
    expect(a.casino.computedIncFor(CRAPS, 'craps')).toBe(k); // the same doc, the same name
    // Every name this build gives, of any table: junk to PR 2's readers, and
    // to PR 3–4's (v0.49's), whose names are `c` and `k` only.
    const PR4_COMPUTED_INC = /^[ck][0-9a-f]{24}$/;
    for (let i = 0; i < 200; i++) {
      const t = `craps-${i}`;
      const inc = a.casino.computedIncFor(t, 'craps');
      const roul = a.casino.computedIncFor(t, 'roulette');
      for (const name of [inc, roul]) {
        expect(pr2CfgInc({ v: 1, inc: name })).toBeNull();
        expect(pr2KeyParts(`ses:${t}:${name}:g`)).toBeNull();
        expect(pr2KeyParts(`sum:${t}:${name}`)).toBeNull();
        expect(PR4_COMPUTED_INC.test(name)).toBe(false);
      }
      // (The copies are faithful: they take PR 2's roulette name.)
      const old = `c${roul.slice(1)}`;
      expect(pr2CfgInc({ v: 1, inc: old })).toBe(old);
      expect(pr2KeyParts(`ses:${t}:${old}:g`)).toEqual({ t, inc: old, sid: 'g' });
    }
    // The records under such a name: PR 2's slip and checkpoint readers
    // (asSlip and asCheckpoint, unchanged) refuse them too.
    expect(asSlip(kit.crapsSlip(AMY, 1, felt(bet('pass', 10)), fresh(AMY.pid), { t: 1 }).rec)).toBeNull();
    expect(asCheckpoint(crapsCp(EMPTY_CARRY))).toBeNull();
    // This build reads a craps switch as live.
    switchOn(a, CRAPS, k);
    expect(a.casino.computedIncOf(CRAPS)).toBe(k);
    expect(a.casino.isComputedTable(CRAPS)).toBe(true);
    expect(a.casino.computedFoldOf(CRAPS)!.carry).toEqual(EMPTY_CARRY); // (that page's own module's)
  });

  it("names a craps incarnation past any whose records are left in the doc, as roulette's", async () => {
    const a = await loadPage('A', 1);
    clockOf(a, T0);
    const first = a.casino.computedIncFor(CRAPS, 'craps');
    a.doc.transact(() => a.doc.getMap('casinoComputed').set(`ses:${CRAPS}:${first}:g`, new Y.Map()));
    const second = a.casino.computedIncFor(CRAPS, 'craps');
    expect(second).not.toBe(first);
    expect(second).toMatch(/^d[0-9a-f]{24}$/);
    expect(a.casino.tableIncRemoved(CRAPS, first)).toBe(true);
  });

  it('a removal made on a PR 2 page ends the table here: the felt let go, the nets kept, then compacted', async () => {
    const a = await loadPage('A', 1);
    const b = await loadPage('B', 2);
    for (const p of [a, b]) {
      clockOf(p, T0);
      p.casino.buyInChips(p.pid, 1_000);
    }
    const inc = a.casino.computedIncFor(CRAPS, 'craps');
    switchOn(a, CRAPS, inc);
    sync(T0, a, b);
    // B rolls once (a pass that travels, a field bet lost or won) and puts a
    // place bet up on the next roll.
    const pk = new ComputedKit({ room: PAGE_ROOM, t: CRAPS, inc });
    const B = pageId(b);
    const s1 = pk.crapsSlip(B, 1, felt(bet('pass', 10), bet('field', 5)), fresh(b.pid), { t: 1 });
    putCraps(b, s1, pk.close(B, 1, 'g', [s1]), pk.reveal(1, b.pid));
    sync(T0, a, b);
    const res1 = b.casino.computedFoldOf(CRAPS)!;
    const net = res1.nets.get(b.pid) ?? 0n;
    const S = res1.carry as CrapsCarry;
    const riding = own(S.w, b.pid);
    const up = S.p ? felt(...riding, bet('place', 12, S.p === 6 ? 8 : 6)) : felt(...riding, bet('field', 7));
    putCraps(b, pk.crapsSlip(B, 2, up, basisOf(S, b.pid), { t: 1 }));
    sync(T0, a, b);
    const held = up.reduce((n, x) => n + x.amount, 0);
    for (const p of [a, b]) expect(p.casino.readChips(b.pid)).toBe(1_000 + Number(net) - held);
    // PR 2's clearTableKeys, run on its page: no state up, so it marks the
    // owner-run incarnation a fresh round would take; it reads the switch's
    // craps name as none, so marks nothing of it, and deletes the switch.
    a.doc.transact(() => {
      const m = a.doc.getMap('casino');
      m.set(`gone:${CRAPS}:${a.casino.tableIncFor(CRAPS)}`, 1);
      m.delete(`cfg:computed:${CRAPS}`);
      for (const key of [...m.keys()]) {
        if ([`table:${CRAPS}`, `croupier:${CRAPS}`, `cfg:backend:${CRAPS}`, `cfg:fairness:${CRAPS}`, `throw:${CRAPS}`].includes(key)
          || ['bets', 'seat', 'fseed'].some((x) => key.startsWith(`${x}:${CRAPS}:`))) m.delete(key);
      }
    });
    sync(T0 + STEP, a, b);
    for (const p of [a, b]) {
      expect(p.casino.isComputedTable(CRAPS)).toBe(false);
      expect(p.casino.readChips(b.pid)).toBe(1_000 + Number(net));
      expect(p.casino.computedEndedIncs().map((e) => e.inc)).toEqual([inc]);
    }
    // The pages' frames, the table out of the room, compact it.
    let T = T0 + STEP;
    const gone = (): boolean => [a, b].every((p) => ![...p.doc.getMap('casinoComputed').keys()].some((key) => key.startsWith(`ses:${CRAPS}:`)));
    for (; T <= T0 + 120_000 && !gone(); T += STEP) {
      sync(T, a, b);
      for (const p of [a, b]) frame(T, p, []);
      sync(T, a, b);
    }
    expect(gone()).toBe(true);
    for (const p of [a, b]) {
      const cp = p.doc.getMap('casinoComputed').get(`sum:${CRAPS}:${inc}`) as Checkpoint;
      expect(cp).toMatchObject({ v: 1, e: 1, u: 1 });
      expect(cp.s).toBeUndefined();
      expect(p.casino.computedIncEnded(CRAPS, inc)).toBe(true);
      expect(p.casino.readChips(b.pid)).toBe(1_000 + Number(net));
    }
  });
});

/** A page as a kit identity: its pid, its key, its signature. */
function pageId(p: Page): TestIdentity {
  return { pid: p.pid, pub: p.pub, sign: (bytes) => p.keypair.signIdentity(bytes) };
}

/** Records into the craps table's live session on page p, one transaction. */
function putCraps(p: Page, ...recs: Built<unknown>[]): void {
  const ses = p.casino.computedSessionForWrite(CRAPS);
  if (!ses) throw new Error(`${p.name}: ${CRAPS} has no live session`);
  p.doc.transact(() => {
    for (const r of recs) ses.set(r.key, r.rec);
  });
}

// ── 🪙 Chips through a hand ──────────────────────────────────────────────────

describe('the chip sum through a craps hand', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('adds up across a travelling pass, a place win, a void, a trim, a forfeit, a seven-out and the end', async () => {
    const a = await loadPage('Amy', 1);
    const b = await loadPage('Bob', 2);
    for (const p of [a, b]) {
      clockOf(p, T0);
      p.casino.buyInChips(p.pid, 200);
    }
    const inc = a.casino.computedIncFor(CRAPS, 'craps');
    const ctx: FoldCtx = { room: PAGE_ROOM, t: CRAPS, inc };
    const pk = new ComputedKit(ctx);
    const [A, B] = [pageId(a), pageId(b)];
    switchOn(a, CRAPS, inc);
    sync(T0, a, b);
    /** Both pages agree: Amy's chips, Bob's, and the cage's books. */
    const chips = (amy: number, bob: number): void => {
      sync(T0, a, b);
      for (const p of [a, b]) {
        expect([p.casino.readChips(a.pid), p.casino.readChips(b.pid)], p.name).toEqual([amy, bob]);
        const cage = p.casino.readCageLedger();
        expect(cage.issued).toBe(400);
        expect(cage.outstanding).toBe(amy + bob);
        expect(cage.houseNet).toBe(400 - amy - bob);
      }
    };
    const fold = (): FoldResult => a.casino.computedFoldOf(CRAPS)!;
    const carry = (): CrapsCarry => fold().carry as CrapsCarry;
    /** Seeds for round r (the first id's tried until the dice come to `sum`). */
    const seedsTo = (r: number, ids: TestIdentity[], sum: number): string[] => {
      for (let tag = 0; ; tag++) {
        const seeds = ids.map((id, i) => pk.seed(id.pid, r, i === 0 ? `t${tag}` : ''));
        const [d1, d2] = diceOf(seedTable(ctx), r, seeds);
        if (d1 + d2 === sum) return seeds;
      }
    };
    chips(200, 200);

    // 1. Come-out: Amy's pass line, Bob's don't pass and a field bet. A 6:
    //    the point is 6, both line bets travel, the field bet loses.
    let [sa, sb] = seedsTo(1, [A, B], 6);
    const a1 = pk.crapsSlip(A, 1, felt(bet('pass', 10)), fresh(a.pid), { t: 1, seed: sa });
    const b1 = pk.crapsSlip(B, 1, felt(bet('dontpass', 5), bet('field', 3)), fresh(b.pid), { t: 3, seed: sb });
    putCraps(a, a1);
    putCraps(b, b1);
    chips(190, 192);
    const c1 = pk.close(A, 1, 'g', [a1, b1]);
    putCraps(a, c1, pk.reveal(1, a.pid, sa));
    putCraps(b, pk.reveal(1, b.pid, sb));
    chips(190, 192);
    expect(carry()).toMatchObject({ p: 6 });
    expect({ ...carry().w }).toEqual({ [a.pid]: felt(bet('pass', 10)), [b.pid]: felt(bet('dontpass', 5)) });

    // 2. Amy places the 8; Bob writes nothing, his don't pass rides. An 8:
    //    the place bet wins 14 and stays up.
    [sa] = seedsTo(2, [A], 8);
    const a2 = pk.crapsSlip(A, 2, felt(bet('pass', 10), bet('place', 12, 8)), basisOf(carry(), a.pid), { t: 1, seed: sa });
    putCraps(a, a2);
    chips(178, 192);
    const c2 = pk.close(A, 2, c1.hash, [a2]);
    putCraps(a, c2, pk.reveal(2, a.pid, sa));
    chips(192, 192);
    expect(fold().rounds[1].craps!.credited.get(a.pid)).toBe(14n);

    // 3. Amy backs her pass line with odds; the roll is abandoned (a void):
    //    nothing moves, and her odds ride on with the rest.
    const a3 = pk.crapsSlip(A, 3, felt(bet('pass', 10), bet('passodds', 10), bet('place', 12, 8)), basisOf(carry(), a.pid), { t: 1 });
    putCraps(a, a3);
    chips(182, 192);
    const c3 = pk.close(A, 3, c2.hash, [a3]);
    putCraps(a, c3);
    chips(182, 192);
    putCraps(b, pk.abandon(B, 3, c3.hash));
    chips(182, 192);
    expect(fold().rounds[2].decided).toBe('void');
    const S3 = carry();
    expect(S3.p).toBe(6);
    expect({ ...S3.w }).toEqual({ [a.pid]: a3.rec.b, [b.pid]: felt(bet('dontpass', 5)) });

    // A trim mid-point: the carry goes into the checkpoint; nothing moves.
    const cp = pk.checkpoint(A, 'g', 3, c3.hash, Object.fromEntries(fold().nets), undefined, S3);
    const sid = pk.sidAfter(cp);
    a.doc.transact(() => {
      const m = a.doc.getMap('casinoComputed');
      m.set(`sum:${CRAPS}:${inc}`, cp);
      for (const key of [...m.keys()]) if (key.startsWith(`ses:${CRAPS}:${inc}:`)) m.delete(key);
      m.set(`ses:${CRAPS}:${inc}:${sid}`, new Y.Map());
    });
    chips(182, 192);
    for (const p of [a, b]) {
      const res = p.casino.computedFoldOf(CRAPS)!;
      expect(res.base).toMatchObject({ sid, u: 3 });
      expect(res.carry).toEqual(S3);
    }

    // 4. Both add a field bet; Amy's seed alone comes in, so she forfeits
    //    Bob. A 9: Amy's field bet wins; Bob plays only what was already
    //    down (his don't pass stays) and loses the 2 he added.
    [sa] = seedsTo(4, [A], 9);
    const S = carry();
    const a4 = pk.crapsSlip(A, 4, felt(...S.w[a.pid], bet('field', 5)), basisOf(S, a.pid), { t: 1, seed: sa });
    const b4 = pk.crapsSlip(B, 4, felt(...S.w[b.pid], bet('field', 2)), basisOf(S, b.pid), { t: 3 });
    putCraps(a, a4);
    putCraps(b, b4);
    chips(177, 190);
    const c4 = pk.close(A, 4, sid, [a4, b4]);
    putCraps(a, c4, pk.reveal(4, a.pid, sa));
    chips(177, 190);
    putCraps(a, pk.forfeit(A, 4, c4.hash, [a.pid]));
    chips(187, 190);
    const r4 = fold().rounds[0];
    expect(r4).toMatchObject({ r: 4, decided: 'forfeit', counted: [a.pid] });
    expect(r4.craps!.lost.get(b.pid)).toBe(2n);
    expect(r4.deltas.get(b.pid)).toBe(-2n);

    // 5. Amy rides her felt as it stands; a 7: a seven-out. Her pass line,
    //    odds and place bet lose; Bob's don't pass, riding, wins.
    [sa] = seedsTo(5, [A], 7);
    const a5 = pk.crapsSlip(A, 5, carry().w[a.pid], basisOf(carry(), a.pid), { t: 1, seed: sa });
    putCraps(a, a5, pk.close(A, 5, c4.hash, [a5]), pk.reveal(5, a.pid, sa));
    chips(187, 200);
    const r5 = fold().rounds[1];
    expect(r5.craps).toMatchObject({ sevenOut: true, pointBefore: 6, pointAfter: null });
    expect(r5.deltas).toEqual(new Map([[a.pid, -32n], [b.pid, 5n]]));
    expect(carry()).toMatchObject({ p: 0 });
    expect(Object.keys(carry().w)).toEqual([]);

    // 6. A new come-out's felts go down, and the table ends (removed here):
    //    what was down comes back; what the table won and lost stands.
    const a6 = pk.crapsSlip(A, 6, felt(bet('pass', 20)), basisOf(carry(), a.pid), { t: 1 });
    const b6 = pk.crapsSlip(B, 6, felt(bet('field', 4)), basisOf(carry(), b.pid), { t: 3 });
    putCraps(a, a6);
    putCraps(b, b6);
    chips(167, 196);
    clockOf(a, T0);
    a.croupier.closeTable(CRAPS, 'local');
    chips(187, 200);
    for (const p of [a, b]) {
      expect(p.casino.isComputedTable(CRAPS)).toBe(false);
      expect(p.casino.computedIncEnded(CRAPS, inc)).toBe(true);
    }
  });
});
