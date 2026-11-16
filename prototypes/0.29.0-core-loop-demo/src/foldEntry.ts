/**
 * 🧮🦀 The pages' fold, as the owner's node runs it (PR 6b of "Computed casino
 * tables").
 *
 * The node folds a computed table with THIS code, not a port of it: this file
 * is bundled by scripts/build-fold-bundle.mjs into ssf-p2p-node/fold/fold.min.js
 * (checked in; src/foldBundle.test.ts fails when it is stale) and the node's
 * fold worker (house_fold.rs) evaluates it in QuickJS. So there is one fold,
 * and the TypeScript tests of it are the node's tests too.
 *
 * ONE TABLE PER JS CONTEXT: the module keeps one TableFold; the worker keeps a
 * QuickJS context for each table it folds and calls these functions in it.
 *
 * WHAT THE HOST PROVIDES (globals, all optional here so the same module runs
 * under Node in tests):
 *   __ssf_sha256(bytes | string) -> Uint8Array   the bundle's sha256 (scripts/foldShaShim.ts)
 *   __ssf_utf8(string) -> Uint8Array             TextEncoder.encode, lone surrogates as U+FFFD
 *   __ssf_check(hash, kind, pub, bytes, sig)     one signature: true, false, or undefined
 *                                                (not checked yet); `bytes` is a function
 *                                                that makes the signed bytes, called only
 *                                                when the host has no verdict for `hash`
 * and nothing else: no clock, no randomness, no network, no keys. (The keys
 * pinned for the players, and the room's houses, are data the host passes to
 * open/setPins/setHouses: the fold never reads a doc.)
 *
 * WHAT IT RETURNS is plain JSON text (result): never a Map, a Set or a
 * bigint, and nothing keyed by a player's name as a JS property (a name may
 * be `__proto__`), so the host reads it with any JSON parser.
 */

import { TableFold, foldGameOf, houseOnly } from './computedFold';
import type { Checkpoint, FoldCtx, FoldResult, HouseCheck, RoundView, SigCheck, Sid3Input } from './computedFold';

/** The version of the result's shape. */
export const RESULT_VERSION = 1;

/** The rule set each incarnation letter is folded by: `c`/`k` are PR 2–4's
 *  tables (roulette, craps) and `r`/`d` PR 5's house tables. A rule change
 *  gets a NEW id for its letter; an id a build once served is never edited
 *  (the node folds and serves only the ids it names). */
export const FOLD_RULES_ID: Readonly<Record<string, string>> = Object.freeze({ c: 'f1', k: 'f1', r: 'h1', d: 'h1' });

/** The rule set an incarnation is folded by, or null for a letter this build
 *  does not fold. (A FAIR ONLY game's, `p`/`q`, is the rules version its name
 *  binds, which its incarnation id, a hash, does not say: `openFairOnly` is
 *  given it.) */
export function rulesFor(inc: string): string | null {
  const id = FOLD_RULES_ID[inc.charAt(0)];
  return id === undefined ? null : id;
}

/** 🔒 The rules versions of FAIR ONLY games (the `rv` a game's name binds)
 *  this build folds: computedFairOnly's KNOWN_RV, as a spec pins (the bundle
 *  takes nothing from that module, whose imports reach the signing code). A
 *  version is never edited once a build served it; a rule change is a new one. */
export const FAIR_ONLY_RULES: readonly string[] = Object.freeze(['f1']);

/** 🔒 Who is a house of a FAIR ONLY game, for which rounds: `[pub, from, to]`,
 *  a house of every round r with from < r <= to (no `to`: every round after
 *  `from`). One for each delegation of a house by a key that held the game,
 *  from the round that key took the game to the round it gave it away, as the
 *  authority resolver reads them (computedFairOnlyAuth houseBy): the host
 *  resolves the game and checks the delegations, and the fold asks only this. */
export type HouseSpan = readonly [pub: string, from: number, to: number | null];

type HostCheck = (hash: string, kind: string, pub: string, bytes: () => Uint8Array, sig: string) => boolean | undefined;

/** How `open` checks signatures: the host's verdicts (`host`, the node's),
 *  or every signature passes (`all`: for corpora signed with fake keys). */
export type CheckMode = 'host' | 'all';

let fold: TableFold | null = null;
let houses = new Set<string>();
/** 🔒 A FAIR ONLY game's houses by round, and the rules version it is folded
 *  by (null: the table is not a FAIR ONLY game). */
let spans: readonly HouseSpan[] = [];
let fairRv: string | null = null;
/** pid → the key pinned for that player (the host's: trust on first use). */
let pinned = new Map<string, string>();
let last: FoldResult | null = null;

function checkOf(mode: CheckMode): SigCheck {
  if (mode === 'all') return () => true;
  return (hash, kind, pub, bytes, sig) => {
    const host = (globalThis as { __ssf_check?: HostCheck }).__ssf_check;
    // No host to ask is "not checked yet", never a pass.
    return typeof host === 'function' ? host(hash, kind, pub, bytes, sig) : undefined;
  };
}

/** A player's pinned key, as the pages pin it (casinoDoc computedPinOf): a
 *  slip counts for the felt, and so for `held`, only if it is signed by the
 *  key pinned for its player; with none pinned the player has no felt. Closes,
 *  decisions and nets don't read it. */
const keyOf = (pid: string): string | undefined => pinned.get(pid);

/** Start folding a table: its incarnation's name (and so its rules), the
 *  checkpoint its live session follows (or null), the keys that are the
 *  room's houses and the keys pinned for its players, as [pid, key].
 *  Forgets the table folded before. */
export function open(
  ctx: FoldCtx, cp: Checkpoint | null, houseKeys: readonly string[], pins: readonly (readonly [string, string])[], mode: CheckMode = 'host',
): void {
  if (houseOnly(ctx.inc)) throw new TypeError('open: a FAIR ONLY game is opened with openFairOnly');
  houses = new Set(houseKeys);
  pinned = new Map(pins);
  spans = [];
  fairRv = null;
  const houseOk: HouseCheck = (pub) => houses.has(pub);
  fold = new TableFold(ctx, checkOf(mode), keyOf, foldGameOf(ctx), houseOk);
  fold.setBase(cp);
  last = null;
}

/** 🔒 Whether `pub` is a house of round `round`, by the spans. */
const spanned = (pub: string, round: number): boolean =>
  spans.some(([k, from, to]) => k === pub && from < round && (to === null || round <= to));

/** 🔒 Start folding a FAIR ONLY game (`p`/`q`): its name's rules version, the
 *  checkpoint the authority resolver chose as its base (null: none, and the
 *  fold counts nothing), its houses by round and the key pinned for each
 *  player. A rules version this build does not know is refused: the host
 *  folds no such game. Forgets the table folded before. */
export function openFairOnly(
  ctx: FoldCtx, rv: string, cp: Sid3Input | null, houseSpans: readonly HouseSpan[], pins: readonly (readonly [string, string])[], mode: CheckMode = 'host',
): void {
  if (!houseOnly(ctx.inc)) throw new TypeError('openFairOnly: not a FAIR ONLY game');
  if (!FAIR_ONLY_RULES.includes(rv)) throw new TypeError(`openFairOnly: rules version ${rv} is not one this build folds`);
  houses = new Set();
  spans = houseSpans.map(([k, from, to]): HouseSpan => [k, from, to]);
  fairRv = rv;
  pinned = new Map(pins);
  fold = new TableFold(ctx, checkOf(mode), keyOf, foldGameOf(ctx), spanned);
  fold.setFairOnlyBase(cp);
  last = null;
}

function live(): TableFold {
  if (fold === null) throw new Error('foldEntry: no table is open');
  return fold;
}

/** The checkpoint the live session follows changed (null = none). At a FAIR
 *  ONLY game, the base the authority resolver chose. */
export function setBase(cp: Checkpoint | Sid3Input | null): void {
  if (fairRv !== null) live().setFairOnlyBase(cp as Sid3Input | null);
  else live().setBase(cp as Checkpoint | null);
}

/** 🔒 A FAIR ONLY game's houses by round changed: all of them. */
export function setSpans(houseSpans: readonly HouseSpan[]): void {
  if (fairRv === null) throw new TypeError('setSpans: not a FAIR ONLY game');
  spans = houseSpans.map(([k, from, to]): HouseSpan => [k, from, to]);
  live().houseChanged();
}

/** The room's houses changed. */
export function setHouses(houseKeys: readonly string[]): void {
  if (fairRv !== null) throw new TypeError('setHouses: a FAIR ONLY game has spans (setSpans)');
  houses = new Set(houseKeys);
  live().houseChanged();
}

/** The keys pinned for the players changed (one showed up, or the host's
 *  table was replaced): [pid, key], all of them. */
export function setPins(pins: readonly (readonly [string, string])[]): void {
  pinned = new Map(pins);
  live().keysChanged();
}

/** Replace the whole live session: every record of it, as [key, value]. */
export function reset(records: readonly (readonly [string, unknown])[]): void {
  live().reset(records);
}

/** Records of the live session changed: [key, value], a value of undefined
 *  being a deletion. */
export function apply(changes: readonly (readonly [string, unknown])[]): void {
  live().apply(changes);
}

type Pairs = [string, string][];

/** The value with the fields of every plain object in name order: the text of
 *  a result must not depend on the order a record's fields came in (a page's
 *  decoder has them in wire order, the node's in a hash map's). A field named
 *  `__proto__` stays a field. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return Object.fromEntries(entries.map(([k, x]) => [k, sorted(x)]));
  }
  return v;
}

const byKey = (a: [string, string], b: [string, string]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** pid → bigint as sorted [pid, decimal] pairs. */
function pairs(m: ReadonlyMap<string, bigint>): Pairs {
  return [...m].map(([pid, v]): [string, string] => [pid, v.toString()]).sort(byKey);
}

function roundOf(v: RoundView, fair: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {
    r: v.r,
    close: v.close,
    decided: v.decided,
    counted: v.counted,
    pocket: v.pocket,
    deltas: pairs(v.deltas),
  };
  if (v.house) out.house = v.house.hash;
  if (v.forfeit) out.forfeit = v.forfeit.hash;
  if (v.abandon) out.abandon = v.abandon.hash;
  if (v.deciderCopies) out.copies = v.deciderCopies;
  if (v.craps) out.dice = v.craps.dice;
  // 🔒 What a FAIR ONLY trim reads besides (the house's N3): the frozen slips a
  // decided round is missing, and a craps roll that ended the hand.
  if (fair) {
    out.missing = v.missing;
    if (v.craps) out.sevenOut = v.craps.sevenOut;
  }
  return out;
}

/** The fold's answer as JSON text: the base, every round of the chosen chain,
 *  the open round, the nets, the carried state and the sizes. */
export function result(): string {
  const res = live().result();
  last = res;
  const base = res.base;
  const fair = fairRv !== null;
  return JSON.stringify({
    v: RESULT_VERSION,
    rules: fair ? fairRv : rulesFor(live().ctx.inc),
    base: { sid: base.sid, u: base.u, l: base.l, n: pairs(base.n), ended: base.ended, h: base.h },
    rounds: res.rounds.map((v) => roundOf(v, fair)),
    tip: res.tip ? res.tip.r : null,
    open: res.open,
    parent: res.parent,
    houseTable: res.houseTable,
    required: res.required,
    joins: res.joins.map((j) => j.hash),
    nets: pairs(res.nets),
    held: pairs(res.held),
    carry: res.carry === undefined ? null : sorted(res.carry),
    pending: res.pending,
    records: res.records,
    bytes: res.bytes,
    rawBytes: res.rawBytes,
    ...(fair ? fairOf(res) : {}),
  });
}

/** 🔒 What a FAIR ONLY game's result says besides (the house's trim and sweep,
 *  design §8.5 N3, N3s, N4): the weight of the records the fold used
 *  (`kept`) and of the open round's felts among them (`feltBytes`); how many
 *  felts the open round has (`felts`: a sweep counts the session's other keys
 *  as junk); the keys of those whose seed is not out, which a trim or a sweep
 *  carries into the session it opens (`carryFelts`, sorted); and the closes of
 *  the open round that are not invalid (`openCloses`, by hash, in the fold's
 *  order): with one in, nobody checkpoints. */
function fairOf(res: FoldResult): Record<string, unknown> {
  const carryFelts: string[] = [];
  for (const s of res.felts.values()) if (!res.revealedCommits.has(s.rec.c)) carryFelts.push(s.key);
  carryFelts.sort();
  return {
    kept: res.keptBytes,
    feltBytes: res.feltBytes,
    felts: res.felts.size,
    carryFelts,
    openCloses: res.openCloses.filter((c) => c.state !== 'invalid').map((c) => c.hash),
  };
}

/** Every field of the last result() as one string: Maps and Sets as tagged
 *  entry lists, bigints as tagged decimals, plain and dictionary objects as
 *  tagged lists of their fields, all in NAME order. Two engines that differ
 *  anywhere differ here, but not for the order a record's fields came in nor
 *  for the order the fold met them: the node reads a map out of Yjs in a hash
 *  map's order, a page in wire order, and no decision turns on either. For
 *  the parity tests; the node never asks. */
export function digest(): string {
  if (last === null) throw new Error('foldEntry: no result yet');
  const byName = (a: [string, unknown], b: [string, unknown]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify(last, (_k, v) => {
    if (typeof v === 'bigint') return '#' + v.toString();
    if (v instanceof Map) return ['M', [...v.entries()].map(([k, x]): [string, unknown] => [String(k), x]).sort(byName)];
    if (v instanceof Set) return ['S', [...v].map(String).sort()];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v);
      if (proto === Object.prototype || proto === null) return ['#O', Object.entries(v as Record<string, unknown>).sort(byName)];
    }
    return v;
  });
}
