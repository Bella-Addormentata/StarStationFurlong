/**
 * 🔒🧪 Who holds a FAIR ONLY game, pinned for the node.
 *
 * The owner's node (ssf-p2p-node house_auth.rs) reads a game's records as the
 * pages do and must name the same holder, the same base and the same end
 * order from them: the house signs over the base it reads, and a base no page
 * counts from is a checkpoint nobody takes. test-vectors/computed-authority-v1.json
 * holds what the pages' readers (computedFairOnly.ts readCk, asXf, asFin,
 * parseFairOnlyKey) and resolver (computedFairOnlyAuth.ts resolveGame,
 * tableGame) say of some thousands of records and some hundreds of games,
 * made here; this file checks the TypeScript side against it, and
 * house_auth.rs's tests check the Rust side against the same file.
 *
 * To write it again, only on purpose, when a rule is meant to change (and the
 * node with it), run this file with VECTORS_WRITE=1 and review the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  asFin, asXf, ckId, ckKey, finKey, MAX_SMALL_RECORD_BYTES, MAX_TRANSFERS, nextSid3, NO_CLOSE, OFFER_SKEW_MS, parseFairOnlyKey, readCk, sealFin, sealXf, weightOf, xfId, xfKey,
} from './computedFairOnly';
import type { CkRec, FairOnlyLetter, XferRec } from './computedFairOnly';
import { MAX_CK_CANDIDATES, MAX_FORGED_XFS, resolveGame, sigId, tableGame } from './computedFairOnlyAuth';
import type { AuthEnv, Resolution } from './computedFairOnlyAuth';
import {
  buyer, ctxOf, delegation, DL_HOUSE, fourth, hashOfSigId, hex, house, house2, houseSigner, NAME, offerOf, owner, ROOM, rootOf, stranger, T, third,
  trimOf, xferOf,
} from './computedFairOnlyKit';
import { recHash } from './computedFold';
import type { FoldCtx } from './computedFold';
import { asDelegation } from './computedHouse';
import { verifyIdentityStrict } from './keypair';

const FILE = new URL('../test-vectors/computed-authority-v1.json', import.meta.url);

type Entry = { key: string; value: unknown };

/** A signature that is well formed and good for nothing. */
const BAD_SIG = houseSigner(new Uint8Array([1, 2, 3]));

/** A value as the file holds it, made what it stands for: `{$undefined: true}`
 *  an undefined value, `{$repeat: [s, n]}` the string `s` n times, `{$nets: n}`
 *  the nets of n players, `{$pid: [s, n]}` the net of one player whose id is
 *  `s` n times, `{$padded: [o, n]}` the object `o` with one more field, n
 *  letters long, that is undefined (padding no reader counts and every reader
 *  weighs). (house_auth.rs's tests read the same marks.) */
function realize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(realize);
  if (typeof v !== 'object' || v === null) return v;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if (o.$undefined === true) return undefined;
    if (Array.isArray(o.$repeat)) return (o.$repeat[0] as string).repeat(o.$repeat[1] as number);
    if (typeof o.$nets === 'number') return Object.fromEntries(Array.from({ length: o.$nets }, (_, i) => [`p${i}`, '1']));
    if (Array.isArray(o.$pid)) return { [(o.$pid[0] as string).repeat(o.$pid[1] as number)]: '1' };
    if (Array.isArray(o.$padded)) return { ...(realize(o.$padded[0]) as Record<string, unknown>), ['a'.repeat(o.$padded[1] as number)]: undefined };
  }
  return Object.fromEntries(keys.map((k) => [k, realize(o[k])]));
}

/** What JSON keeps of a value (no undefined field): what the file can hold. */
const stored = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V;

/** `base` with `value` at `path` (dots go into objects); `{$absent: true}` takes the field out. */
function patched(base: unknown, path: string, value: unknown): Record<string, unknown> {
  const out = structuredClone(base) as Record<string, unknown>;
  const parts = path.split('.');
  let at = out;
  for (const p of parts.slice(0, -1)) at = at[p] as Record<string, unknown>;
  const last = parts[parts.length - 1];
  if (typeof value === 'object' && value !== null && (value as Record<string, unknown>).$absent === true) delete at[last];
  else at[last] = realize(value);
  return out;
}

// ── The records of a game, for the readers ───────────────────────────────────

const N2 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const N3 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const N4 = 'cccccccccccccccccccccccc';
const DL_BUYER = delegation(buyer, house2.pub);
const DL_THIRD = delegation(third, house.pub);

/** A transfer and an end order, for a field that holds one (their shape is all a reader of a checkpoint asks). */
const XF_ANY = xferOf(ctxOf('p'), owner, buyer, 3).value;
const FIN_ANY = sealFin(ctxOf('p'), owner.pub, owner.sign).value;

/** The values each field of each record is given in turn. */
const ODD: unknown[] = [
  { $absent: true }, { $undefined: true }, 0, 1, 2, 3, -1, 1.5, 36, 37, 2 ** 48, 2 ** 48 + 1, NAME.ts, '', 'g', 'f1', 'f2', 'F1', 'toolongrv',
  hex('a', 24), hex('b', 32), NO_CLOSE, hex('d', 64), NAME.j, `h:${hex('c', 32)}`, `z:${hex('c', 32)}`, `x:${hex('c', 32)}`, [], {}, null, true,
  [3, 4], [7, 1], [3], [0, 4], owner.pub, house.pub, house2.pub, buyer.pub, BAD_SIG, { p: 0, w: {} }, { p: 6, w: {} }, { p: 5, w: {} }, { p: 0, w: {}, i: 1 },
  { alice: '25' }, { alice: '025' }, { alice: 25 }, { alice: '-1', bob: { $undefined: true } }, { $nets: 4000 }, { $nets: 4001 },
  { $pid: ['a', 256] }, { $pid: ['a', 257] }, { $pid: ['😀', 128] }, { $pid: ['😀', 129] },
  DL_HOUSE, DL_BUYER, { ...DL_HOUSE, zz: 1 }, { ...DL_HOUSE, zz: { $repeat: ['a', 9000] } }, { v: 1, k: owner.pub },
  'transfer-offer', 'deed', ROOM, 'another-room', { $repeat: ['a', 256] }, { $repeat: ['a', 257] }, { $repeat: ['😀', 128] }, { $repeat: ['😀', 129] },
  { $repeat: ['a', 9000] }, N3, 'not a nonce', [XF_ANY], [XF_ANY, XF_ANY], Array.from({ length: 9 }, () => XF_ANY), [XF_ANY, FIN_ANY], FIN_ANY,
  { ...FIN_ANY, zz: 1 }, XF_ANY, { alice: `1${'0'.repeat(39)}` }, { alice: `-1${'0'.repeat(39)}` }, { alice: `1${'0'.repeat(40)}` }, { alice: '0' }, { alice: '-0' },
  { $padded: [DL_HOUSE, 8000] }, { $padded: [DL_HOUSE, 9000] }, { $padded: [FIN_ANY, 8000] }, { $padded: [FIN_ANY, 9000] }, [{ $padded: [XF_ANY, 9000] }],
  [{ $padded: [XF_ANY, 7000] }],
];

function ckBases(letter: FairOnlyLetter) {
  const ctx = ctxOf(letter);
  const fin = sealFin(ctx, owner.pub, owner.sign).value;
  const xf1 = xferOf(ctx, owner, buyer, 3).value;
  const xf2 = xferOf(ctx, buyer, third, 6, { nonce: N2 }).value;
  const trim = trimOf(ctx, letter);
  const root = rootOf(ctx, letter);
  const bases: [string, FoldCtx, { value: CkRec }][] = [
    ['root', ctx, root],
    ['trim', ctx, trim],
    ['void trim', ctx, trimOf(ctx, letter, { d: `z:${hex('c', 32)}`, o: undefined })],
    ['sweep', ctx, trimOf(ctx, letter, { b: nextSid3(ctx, trim.value), w: 1 })],
    ['end', ctx, trimOf(ctx, letter, { e: 1, f: fin, s: undefined, h: undefined })],
    ['sweep of the root', ctx, trimOf(ctx, letter, { b: nextSid3(ctx, root.value), u: 0, l: NO_CLOSE, d: undefined, o: undefined, n: {}, h: undefined, w: 1, ...(letter === 'q' ? { s: { p: 0, w: {} } } : {}) })],
    ['end at the root', ctx, trimOf(ctx, letter, { b: nextSid3(ctx, root.value), u: 0, l: NO_CLOSE, d: undefined, o: undefined, n: {}, h: undefined, s: undefined, e: 1, f: fin })],
    ['adoption', ctx, trimOf(ctx, letter, { u: 6, k: house2.pub, dl: DL_BUYER, x: [xf1] })],
    ['second adoption', ctx, trimOf(ctx, letter, { u: 7, k: house.pub, dl: DL_THIRD, x: [xf1, xf2] })],
    ['owner-signed trim', ctx, trimOf(ctx, letter, { k: owner.pub, dl: undefined })],
  ];
  const newer = ctxOf(letter, T, { ...NAME, rv: 'f2' });
  bases.push(['root of a newer rules version', newer, rootOf(newer, letter, { rv: 'f2' })]);
  return bases;
}

const CK_FIELDS = ['v', 'ok', 'j', 'rv', 'ts', 'b', 'u', 'w', 'l', 'd', 'o', 'n', 'e', 'f', 's', 'h', 'dl', 'x', 'k', 'g', 'zz'];
const READ_CODE = { ok: 'o', newer: 'n', junk: 'j' } as const;

/** Each base, and for each field a letter per ODD value: what readCk says of
 *  the base with that value there, keyed again by what it then holds. */
function readCases() {
  return (['p', 'q'] as const).flatMap((letter) => ckBases(letter).map(([name, ctx, base]) => {
    const value = stored(base.value);
    const fields: Record<string, string> = {};
    for (const f of CK_FIELDS) {
      fields[f] = ODD.map((odd) => {
        const v = patched(value, f, odd);
        return READ_CODE[readCk(ROOM, ckKey(ctx.t, ctx.inc, ckId(v) ?? hex('0', 32)), v).kind];
      }).join('');
    }
    const whole = readCk(ROOM, ckKey(ctx.t, ctx.inc, ckId(value) as string), value);
    return { name: `${letter} ${name}`, t: ctx.t, inc: ctx.inc, value, whole: READ_CODE[whole.kind], fields };
  }));
}

/** A whole checkpoint under keys that are not its own. */
function keyCases() {
  const ctx = ctxOf('p');
  const trim = trimOf(ctx, 'p');
  const id = ckId(trim.value) as string;
  const keys = [
    trim.key, ckKey(ctx.t, ctx.inc, hex('0', 32)), ckKey('another', ctx.inc, id), ckKey(ctx.t, ctxOf('q').inc, id), xfKey(ctx.t, ctx.inc, id),
    finKey(ctx.t, ctx.inc), `ck:${ctx.t}:${ctx.inc}:${id.toUpperCase()}`, `ck:${ctx.t}:${ctx.inc}:${id}0`, `ck::${ctx.inc}:${id}`, `${trim.key} `,
    `ck:a:b:${ctx.inc}:${id}`, `ck:${ctx.t}:r${ctx.inc.slice(1)}:${id}`, `ck:${ctx.t}:${ctx.inc}${id}`, `ck:é😀:${ctx.inc}:${id}`, 'ck:', 'xf:', 'fin:', 'do:', '',
    `fin:${ctx.inc}`, `fin::${ctx.inc}`, `fin:a:b:${ctx.inc}`, `fin:${ctx.t}:${ctx.inc}:${id}`, `do:${N2}`, `do:${N2}0`, `do:${N2.toUpperCase()}`, `dox:${N2}`,
    `ck:${ctx.t}:${ctx.inc}:${'é'.repeat(16)}`, `fin:${ctx.t}:p${'é'.repeat(12)}`, `ck:${ctx.t}:${ctx.inc}:é${id.slice(1)}`, `ck:${ctx.t}:${ctx.inc}é${id}`,
    `xf:é:${ctx.inc}:${id}`, `fin:é😀:${ctx.inc}`,
  ];
  return keys.map((key) => ({ key, parsed: parseFairOnlyKey(key), read: READ_CODE[readCk(ROOM, key, trim.value).kind] }));
}

/** Records no single field's change makes: each as the file holds it, and what readCk says of it under the key of what it holds. */
function specialCases() {
  const out: { name: string; t: string; inc: string; value: unknown; read: string }[] = [];
  const add = (name: string, ctx: FoldCtx, value: unknown) => {
    const real = realize(value);
    out.push({ name, t: ctx.t, inc: ctx.inc, value, read: READ_CODE[readCk(ROOM, ckKey(ctx.t, ctx.inc, ckId(real) ?? hex('0', 32)), real).kind] });
  };
  const P = ctxOf('p');
  const fin = sealFin(P, owner.pub, owner.sign).value;
  const trim = stored(trimOf(P, 'p').value);
  add('a trim that says it is the root', P, stored(trimOf(P, 'p', { b: 'g', k: owner.pub }).value));
  add('a root that is an end', P, stored(rootOf(P, 'p', { e: 1, f: fin }).value));
  add('a root with a sweep count', P, stored(rootOf(P, 'p', { w: 1 }).value));
  add('an end with a sweep count', P, stored(trimOf(P, 'p', { e: 1, f: fin, h: undefined, w: 1 }).value));
  add('a trim padded under the most a checkpoint weighs', P, { $padded: [trim, 1_000_000] });
  add('a trim padded past it', P, { $padded: [trim, 1_600_000] });
  // The name's inputs, each in a form the name's hash takes and a reader refuses: under a rules version this
  // build doesn't know, so that the name alone is what is read (newer, or junk).
  const names: [string, Record<string, unknown>][] = [
    ['f2', {}], ['f', {}], ['abcdefgh', {}], ['a1b2c3d4', {}], ['abcdefghi', {}], ['F2', {}], ['2f', {}], ['f_', {}], ['', {}], ['fé', {}],
    ['f2', { j: 'ABCDEF0123456789' }], ['f2', { j: '0123456789abcde' }], ['f2', { j: '0123456789abcdef0' }], ['f2', { ts: 0 }], ['f2', { ts: -1 }],
    ['f2', { ok: house.pub }], ['f2', { ok: `${owner.pub}A` }], ['f2', { ok: owner.pub.slice(1) }], ['f2', { ok: `${owner.pub.slice(1)}=` }],
  ];
  for (const [rv, patch] of names) {
    const name = { ...NAME, rv, ...patch };
    const ctx = ctxOf('p', T, name);
    add(`a name of rv ${JSON.stringify(rv)} ${JSON.stringify(patch)}`, ctx, stored({ ...rootOf(ctx, 'p').value, ...name }));
  }
  return out;
}

const XF_FIELDS = ['v', 'o', 'u', 'k', 'g', 'zz', 'o.v', 'o.kind', 'o.asset', 'o.asset.kind', 'o.asset.roomId', 'o.asset.roomName', 'o.asset.zz', 'o.makerPub',
  'o.makerName', 'o.toPub', 'o.price', 'o.issuedAt', 'o.expiresAt', 'o.nonce', 'o.sig', 'o.zz', 'o.toVentureId'];

/** A transfer, an end order and a delegation, each field given each ODD value: 1 where the reader takes it. */
function smallCases() {
  const ctx = ctxOf('p');
  const xf = stored(xferOf(ctx, owner, buyer, 3).value);
  const fin = stored(sealFin(ctx, owner.pub, owner.sign).value);
  const dl = stored(DL_HOUSE);
  const bits = (base: unknown, fields: string[], ok: (v: unknown) => boolean) =>
    Object.fromEntries(fields.map((f) => [f, ODD.map((odd) => (ok(patched(base, f, odd)) ? '1' : '0')).join('')]));
  return {
    xf: { value: xf, fields: bits(xf, XF_FIELDS, (v) => asXf(v, ROOM) !== null) },
    fin: { value: fin, fields: bits(fin, ['v', 'k', 'g', 'zz'], (v) => asFin(v) !== null) },
    dl: { value: dl, fields: bits(dl, ['v', 'h', 'k', 'g', 'zz'], (v) => weightOf(v, MAX_SMALL_RECORD_BYTES) !== null && asDelegation(v) !== null) },
  };
}

// ── Games, for the resolver ──────────────────────────────────────────────────

/** A seeded generator (mulberry32): the same games at every run. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `sealed` with its buyer's signature broken, keyed by what it then holds. */
function forgedXf(ctx: FoldCtx, sealed: { value: XferRec }, patch: Partial<XferRec>): Entry {
  const value = { ...sealed.value, ...patch };
  return { key: xfKey(ctx.t, ctx.inc, xfId(value) as string), value };
}

/** The records games are made of: checkpoints, transfers, end orders and delegations, by name. */
function poolOf(letter: FairOnlyLetter, big: boolean) {
  const ctx = ctxOf(letter);
  const cks: Record<string, Entry> = {};
  const xfs: Record<string, Entry> = {};
  const fins: Record<string, unknown> = {};
  const fin = (who: typeof owner) => sealFin(ctx, who.pub, who.sign).value;
  fins.owner = fin(owner);
  fins.buyer = fin(buyer);
  fins.third = fin(third);
  fins.stranger = fin(stranger);
  fins.bad = { ...fin(owner), g: BAD_SIG };
  fins.junk = { v: 1, k: owner.pub };

  const xf1 = xferOf(ctx, owner, buyer, 3);
  const xf2 = xferOf(ctx, buyer, third, 6, { nonce: N2 });
  xfs.xf1 = xf1;
  xfs.xf1late = xferOf(ctx, owner, buyer, 5, { nonce: N3 });
  xfs.sameNonce = xferOf(ctx, owner, third, 4);
  xfs.forged = forgedXf(ctx, xferOf(ctx, owner, buyer, 2, { nonce: N4 }), { g: BAD_SIG });
  xfs.forgedOffer = sealXf(ctx, { v: 1, o: { ...offerOf(owner, buyer, { nonce: N4 }), sig: BAD_SIG }, u: 1, k: buyer.pub }, buyer.sign);
  xfs.replay = xferOf(ctx, owner, buyer, 1, { nonce: N3, issuedAt: NAME.ts - OFFER_SKEW_MS - 1 });
  xfs.skewEdge = xferOf(ctx, owner, fourth, 9, { nonce: N3, issuedAt: NAME.ts - OFFER_SKEW_MS });
  xfs.xf2 = xf2;
  xfs.stranger = xferOf(ctx, stranger, fourth, 2, { nonce: N3 });
  xfs.back = xferOf(ctx, buyer, owner, 8, { nonce: N4 });
  xfs.wrongKey = { key: xfKey(ctx.t, ctx.inc, hex('0', 32)), value: xf1.value };
  xfs.otherTable = { key: xfKey('another', ctx.inc, xfId(xf1.value) as string), value: xf1.value };
  xfs.atZero = xferOf(ctx, owner, fourth, 0, { nonce: N2 });
  xfs.reuse = xferOf(ctx, owner, third, 9);
  xfs.otherGame = { key: xfKey(ctx.t, ctxOf(letter === 'p' ? 'q' : 'p').inc, xfId(xf1.value) as string), value: xf1.value };

  const t3 = trimOf(ctx, letter);
  const next3 = nextSid3(ctx, t3.value);
  const e32 = hex('e', 32);
  cks.root = rootOf(ctx, letter);
  cks.t3 = t3;
  cks.t5 = trimOf(ctx, letter, { b: next3, u: 5, l: e32 });
  cks.t5b = trimOf(ctx, letter, { b: next3, u: 5, l: hex('9', 32) });
  cks.sw1 = trimOf(ctx, letter, { b: next3, w: 1 });
  cks.sw2 = trimOf(ctx, letter, { b: nextSid3(ctx, cks.sw1.value as CkRec), w: 2 });
  cks.end3 = trimOf(ctx, letter, { b: next3, e: 1, f: fins.owner, s: undefined, h: undefined });
  cks.end5 = trimOf(ctx, letter, { b: next3, u: 5, l: e32, e: 1, f: fins.owner, s: undefined, h: undefined });
  cks.strangerHouse = trimOf(ctx, letter, { u: 9, l: e32, k: house2.pub, dl: delegation(stranger, house2.pub) });
  const t8 = trimOf(ctx, letter, { u: 8, l: e32 });
  const badSig = { ...t8.value, g: BAD_SIG };
  cks.badSig = { key: ckKey(ctx.t, ctx.inc, ckId(badSig) as string), value: badSig };
  cks.badDl = trimOf(ctx, letter, { u: 8, l: hex('7', 32), dl: { ...DL_HOUSE, g: BAD_SIG } });
  cks.ownerSigned = trimOf(ctx, letter, { u: 4, l: e32, k: owner.pub, dl: undefined });
  cks.endBadFin = trimOf(ctx, letter, { u: 7, l: e32, e: 1, f: fins.bad, s: undefined, h: undefined });
  cks.endStrangerFin = trimOf(ctx, letter, { u: 7, l: hex('6', 32), e: 1, f: fins.stranger, s: undefined, h: undefined });
  cks.b6 = trimOf(ctx, letter, { u: 6, l: e32, k: house2.pub, dl: DL_BUYER, x: [xf1.value] });
  cks.b4 = trimOf(ctx, letter, { u: 4, l: hex('5', 32), k: house2.pub, dl: DL_BUYER, x: [xf1.value] });
  cks.b3 = trimOf(ctx, letter, { l: hex('5', 32), k: house2.pub, dl: DL_BUYER, x: [xf1.value] });
  cks.b2 = trimOf(ctx, letter, { u: 2, l: e32, k: house2.pub, dl: DL_BUYER, x: [xf1.value] });
  cks.b6noX = trimOf(ctx, letter, { u: 6, l: hex('4', 32), k: house2.pub, dl: DL_BUYER });
  cks.b6lateX = trimOf(ctx, letter, { u: 6, l: hex('3', 32), k: house2.pub, dl: DL_BUYER, x: [xfs.xf1late.value] });
  cks.b6forgedX = trimOf(ctx, letter, { u: 6, l: hex('2', 32), k: house2.pub, dl: DL_BUYER, x: [xfs.forged.value] });
  cks.t7third = trimOf(ctx, letter, { u: 7, l: e32, k: house.pub, dl: DL_THIRD, x: [xf1.value, xf2.value] });
  cks.h7 = trimOf(ctx, letter, { u: 7, l: hex('1', 32) });
  cks.endB6 = trimOf(ctx, letter, { u: 6, l: e32, k: house2.pub, dl: DL_BUYER, x: [xf1.value], e: 1, f: fins.buyer, s: undefined, h: undefined });
  cks.endB6ownerFin = trimOf(ctx, letter, { u: 6, l: hex('8', 32), k: house2.pub, dl: DL_BUYER, x: [xf1.value], e: 1, f: fins.owner, s: undefined, h: undefined });
  cks.endB3ownerFin = trimOf(ctx, letter, { l: hex('8', 32), k: house2.pub, dl: DL_BUYER, x: [xf1.value], e: 1, f: fins.owner, s: undefined, h: undefined });
  const junk = { ...t3.value, zz: 1 };
  cks.junk = { key: ckKey(ctx.t, ctx.inc, ckId(junk) as string), value: junk };
  cks.unclaimedX = trimOf(ctx, letter, { u: 2, l: hex('3', 32), x: [xf1.value] });
  cks.wrongKey = { key: ckKey(ctx.t, ctx.inc, hex('0', 32)), value: t8.value };
  if (big) {
    // More checkpoints of one round than a pass looks at, and more forged transfers than one walks past.
    for (let i = 0; i < MAX_CK_CANDIDATES + 4; i++) cks[`c${i}`] = trimOf(ctx, letter, { u: 12, l: hex('f', 30) + i.toString(16).padStart(2, '0') });
    cks.c99 = trimOf(ctx, letter, { b: hex('b', 24), u: 13, l: e32 });
    // (Ones whose signature fails take no place of a pass: under ids that sort among the others'.)
    for (let i = 0; i < 6; i++) {
      const bad = { ...trimOf(ctx, letter, { u: 12, l: hex('e', 30) + i.toString(16).padStart(2, '0') }).value, g: BAD_SIG };
      cks[`c${50 + i}`] = { key: ckKey(ctx.t, ctx.inc, ckId(bad) as string), value: bad };
    }
    // More hand-overs than a game may have: there and back, a round apart.
    for (let i = 0; i < 10; i++) {
      xfs[`f${900 + i}`] = xferOf(ctx, i % 2 ? buyer : owner, i % 2 ? owner : buyer, i + 1, { nonce: (900 + i).toString(16).padStart(24, '0') });
    }
    for (let i = 0; i < MAX_FORGED_XFS + 2; i++) {
      xfs[`f${i}`] = forgedXf(ctx, xferOf(ctx, owner, buyer, 1, { nonce: i.toString(16).padStart(24, '0') }), { g: BAD_SIG });
    }
  }

  const dls: Record<string, unknown> = {
    house: DL_HOUSE, buyer: DL_BUYER, third: DL_THIRD, stranger: delegation(stranger, house.pub), owner2: delegation(owner, house2.pub),
    bad: { ...delegation(owner, house2.pub), g: BAD_SIG }, heavy: { ...DL_HOUSE, zz: 'a'.repeat(9000) }, junk: { v: 1, h: house.pub },
  };
  return {
    cks: Object.fromEntries(Object.entries(cks).map(([n, e]) => [n, stored(e)])),
    xfs: Object.fromEntries(Object.entries(xfs).map(([n, e]) => [n, stored(e)])),
    fins: stored(fins),
    dls: stored(dls),
  };
}

type Pool = ReturnType<typeof poolOf>;
interface GameCase {
  name: string;
  letter: FairOnlyLetter;
  inc: string;
  liveSid?: string;
  cks: string[];
  xfs: string[];
  fins: string[];
  dls: string[];
  hold: string[];
}

const HOUSE_ROUNDS = [0, 1, 3, 4, 5, 6, 7, 9];

/** A doc key, short: its kind and the start of its id. */
const short = (key: string): string => `${key.slice(0, 2)}|${key.slice(-32, -20)}`;

/** What the pages' resolver says of a game, with every signature check it asked for, in order. */
function answer(pool: Pool, c: GameCase) {
  const asked: string[] = [];
  const hold = new Set(c.hold);
  const cache = new Map<string, boolean>();
  const env: AuthEnv = {
    room: ROOM,
    liveSid: c.liveSid,
    sig: (id, pub, bytes, sig) => {
      // (The kind and the start of the hash: what was asked, and in which order. sigIds pins the ids whole.)
      asked.push(`${id.slice(0, id.indexOf('|'))}|${hashOfSigId(id).slice(0, 12)}`);
      if (hold.has(hashOfSigId(id))) return undefined;
      let v = cache.get(id);
      if (v === undefined) cache.set(id, v = verifyIdentityStrict(pub, bytes(), sig));
      return v;
    },
  };
  const res = resolveGame(env, T, c.inc, {
    cks: c.cks.map((n) => [pool.cks[n].key, pool.cks[n].value] as const),
    xfs: c.xfs.map((n) => [pool.xfs[n].key, pool.xfs[n].value] as const),
    fin: c.fins.length > 0 ? pool.fins[c.fins[0]] : undefined,
    fins: c.fins.slice(1).map((n) => pool.fins[n]),
    delegations: c.dls.map((n) => pool.dls[n]),
  });
  const houses = [house.pub, house2.pub].flatMap((pub) => HOUSE_ROUNDS.map((round) => {
    const by = res.houseBy(pub, round);
    return by === undefined ? 'pending' : by === null ? null : by.hash.slice(0, 12);
  }));
  const want = {
    newer: res.newer,
    named: res.name !== null,
    chain: res.chain.map((h) => ({
      k: h.k, from: h.from, step: h.step?.id.slice(0, 12) ?? null, key: h.step?.key === undefined ? null : short(h.step.key), carriers: (h.step?.carriers ?? []).map(short),
    })),
    holder: res.holder,
    base: res.base ? short(res.base.key) : null,
    fin: res.fin ? recHash(res.fin) : null,
    live: res.live,
    unlooked: res.unlooked,
    invalid: res.invalid.map(short),
    pending: res.pending,
    houses,
    asked,
  };
  return { res, want };
}

/** Every hash a check of this game could be asked about. */
function hashesOf(pool: Pool, c: GameCase): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    const h = v === undefined ? null : recHash(v);
    if (h) out.add(h);
  };
  for (const n of c.cks) {
    const ck = pool.cks[n].value as CkRec;
    add(ck);
    add(ck.dl);
    add(ck.f);
    for (const xf of ck.x ?? []) {
      add(xf);
      add(xf.o);
    }
  }
  for (const n of c.xfs) {
    const xf = pool.xfs[n].value as XferRec;
    add(xf);
    add(xf.o);
  }
  for (const n of c.fins) add(pool.fins[n]);
  for (const n of c.dls) add(pool.dls[n]);
  return [...out].sort();
}

function gameCases(letter: FairOnlyLetter, pool: Pool, count: number, seed: number) {
  const ctx = ctxOf(letter);
  const rand = rng(seed);
  const pick = <V>(list: readonly V[]): V => list[Math.floor(rand() * list.length)];
  const some = (names: string[], p: number): string[] => names.filter(() => rand() < p);
  const shuffled = (names: string[]): string[] => names.map((n) => [rand(), n] as const).sort((a, b) => a[0] - b[0]).map(([, n]) => n);
  const small = (names: string[]) => names.filter((n) => !/^[cf]\d+$/.test(n));
  const ckNames = small(Object.keys(pool.cks));
  const xfNames = small(Object.keys(pool.xfs));
  const base = { letter, inc: ctx.inc };
  const cases: GameCase[] = [
    { ...base, name: 'no record at all', cks: [], xfs: [], fins: [], dls: [], hold: [] },
    { ...base, name: 'the root alone', cks: ['root'], xfs: [], fins: [], dls: [], hold: [] },
    { ...base, name: 'everything', cks: ckNames, xfs: xfNames, fins: Object.keys(pool.fins), dls: Object.keys(pool.dls), hold: [] },
    { ...base, name: 'a hand-over and its buyer\'s end', cks: ['root', 't3', 'b6', 'endB6'], xfs: ['xf1'], fins: ['buyer'], dls: ['house', 'buyer'], hold: [] },
    { ...base, name: 'two hand-overs', cks: ['root', 't3', 'b6', 't7third'], xfs: ['xf1', 'xf2'], fins: ['owner', 'third'], dls: ['house', 'buyer', 'third'], hold: [] },
    { ...base, name: 'there and back', cks: ['root', 't3', 'b6'], xfs: ['xf1', 'back'], fins: ['buyer', 'owner'], dls: ['house', 'buyer'], hold: [] },
    { ...base, name: 'a transfer under another table\'s key', cks: ['root', 't3'], xfs: ['otherTable'], fins: [], dls: [], hold: [] },
    { ...base, name: 'a transfer carried by a record that speaks for its seller', cks: ['root', 'unclaimedX'], xfs: [], fins: [], dls: [], hold: [] },
    { ...base, name: 'a transfer at the round the game opened', cks: ['root'], xfs: ['atZero'], fins: [], dls: [], hold: [] },
    { ...base, name: 'an offer used twice', cks: ['root', 't3'], xfs: ['xf1', 'back', 'reuse'], fins: [], dls: [], hold: [] },
  ];
  for (let i = 0; i < count; i++) {
    const c: GameCase = {
      ...base,
      name: `game ${i}`,
      cks: shuffled([...(rand() < 0.9 ? ['root'] : []), ...some(ckNames.filter((n) => n !== 'root'), 0.1 + 0.4 * rand())]),
      xfs: shuffled(some(xfNames, 0.5 * rand())),
      fins: shuffled(some(Object.keys(pool.fins), 0.3)),
      dls: shuffled(some(Object.keys(pool.dls), 0.5)),
      hold: [],
    };
    if (rand() < 0.3 && c.cks.length > 0) c.liveSid = (pool.cks[pick(c.cks)].value as CkRec).b;
    const hashes = hashesOf(pool, c);
    if (rand() < 0.4 && hashes.length > 0) c.hold = [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(hashes)))].sort();
    cases.push(c);
  }
  if (Object.keys(pool.cks).includes('c0')) {
    const many = Array.from({ length: MAX_CK_CANDIDATES + 4 }, (_, i) => `c${i}`);
    const forged = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);
    const idOf = (n: string) => recHash(pool.cks[n].value) as string;
    const byId = [...many].sort((a, b) => (pool.cks[a].key < pool.cks[b].key ? -1 : 1));
    cases.push(
      { ...base, name: 'more checkpoints of a round than a pass looks at', cks: ['root', ...many], xfs: [], fins: [], dls: [], hold: [] },
      { ...base, name: 'the same, the first put off', cks: ['root', ...many], xfs: [], fins: [], dls: [], hold: [idOf(byId[0])] },
      { ...base, name: 'the same, the last looked at put off', cks: ['root', ...many], xfs: [], fins: [], dls: [], hold: [idOf(byId[MAX_CK_CANDIDATES - 1])] },
      { ...base, name: 'the same, one not looked at put off', cks: ['root', ...many], xfs: [], fins: [], dls: [], hold: [idOf(byId[MAX_CK_CANDIDATES])] },
      { ...base, name: 'the same, with a higher round that closes another session', cks: ['root', ...many, 'c99'], xfs: [], fins: [], dls: [], hold: [], liveSid: hex('a', 24) },
      { ...base, name: 'the same, one of those looked at put off', cks: ['root', ...many, 'c99'], xfs: [], fins: [], dls: [], hold: [idOf(byId[3])], liveSid: hex('a', 24) },
      { ...base, name: 'the same among ones whose signature fails', cks: ['root', ...many, 'c50', 'c51', 'c52', 'c53', 'c54', 'c55'], xfs: [], fins: [], dls: [], hold: [] },
      { ...base, name: 'more hand-overs than a game may have', cks: ['root', 't3'], xfs: Array.from({ length: 10 }, (_, i) => `f${900 + i}`), fins: ['owner', 'buyer'], dls: ['house', 'buyer'], hold: [] },
      { ...base, name: 'the same under a higher round', cks: ['root', ...many, 't3'], xfs: [], fins: [], dls: [], hold: [idOf(byId[2])], liveSid: (pool.cks.t3.value as CkRec).b },
      { ...base, name: 'as many forged transfers as a pass walks past', cks: ['root', 't3', 'b6'], xfs: [...forged(MAX_FORGED_XFS), 'xf1'], fins: [], dls: [], hold: [] },
      { ...base, name: 'one more forged transfer than that', cks: ['root', 't3', 'b6'], xfs: [...forged(MAX_FORGED_XFS + 1), 'xf1'], fins: [], dls: [], hold: [] },
    );
  }
  return cases.map((c) => ({ ...c, want: answer(pool, c).want }));
}

/** A game of a rules version this build doesn't know. */
function newerCase() {
  const ctx = ctxOf('p', T, { ...NAME, rv: 'f2' });
  const root = stored(rootOf(ctx, 'p', { rv: 'f2' }));
  const res = resolveGame({ room: ROOM, sig: () => true }, T, ctx.inc, { cks: [[root.key, root.value]], xfs: [] });
  return { inc: ctx.inc, key: root.key, value: root.value, newer: res.newer, name: res.name, holder: res.holder, base: res.base?.key ?? null };
}

/** Which of some games a table plays (S9). */
function tableCases(pool: Pool, games: (GameCase & { want: { live: boolean; holder: string | null } })[]) {
  const live = games.filter((g) => g.want.live);
  const byHolder = (k: string) => live.find((g) => g.want.holder === k)?.name;
  const names = [byHolder(owner.pub), byHolder(buyer.pub), byHolder(third.pub), games.find((g) => !g.want.live && g.cks.length > 0)?.name].filter((n): n is string => n !== undefined);
  const sets = [[], [names[0]], names.slice(0, 2), names.slice(0, 3), names, [names[3]], [names[1], names[1]]].map((set) => set.filter((n) => n !== undefined));
  const out: { games: string[]; deedHolder: string | null; switchAt: number | null; want: number | null }[] = [];
  for (const set of sets) {
    for (const deedHolder of [null, owner.pub, buyer.pub, stranger.pub]) {
      for (const switchAt of [null, ...set.keys()]) {
        const rs = set.map((n) => answer(pool, games.find((g) => g.name === n) as GameCase).res);
        // (The games of one table have a name each; here they share one, so each is told apart by where it stands.)
        const marked: Resolution[] = rs.map((r, i) => ({ ...r, inc: `${r.inc[0]}${i.toString(16).padStart(24, '0')}` }));
        const got = tableGame(marked, deedHolder, switchAt === null ? null : marked[switchAt].inc);
        out.push({ games: set, deedHolder, switchAt, want: got ? marked.indexOf(got) : null });
      }
    }
  }
  return out;
}

function build() {
  const p = poolOf('p', true);
  const q = poolOf('q', false);
  const pGames = gameCases('p', p, 150, 0x5eed);
  const qGames = gameCases('q', q, 40, 0xfa12);
  const P = ctxOf('p');
  return {
    note: 'Who holds a FAIR ONLY game, as the pages read it (src/computedFairOnlyAuthVectors.test.ts writes this with VECTORS_WRITE=1; ssf-p2p-node house_auth.rs tests read it). Marks in values: {$undefined:true} an undefined value, {$absent:true} the field taken out, {$repeat:[s,n]} s n times, {$nets:n} the nets of n players, {$pid:[s,n]} the net of one player named s n times, {$padded:[o,n]} the object o with one more field, n letters long, that is undefined. odd: the values each field is given in turn. reads: checkpoints, and per field a letter per odd value for what readCk says of the checkpoint with that value there, keyed again by what it holds (o ok, n newer, j junk). keys: keys as parseFairOnlyKey reads them, and readCk of one whole checkpoint under each. specials: checkpoints no single field\'s change makes, and readCk of each under the key of what it holds. small: a transfer, an end order and a delegation, per field a digit per odd value (1: asXf, asFin, or asDelegation of a value no heavier than a small record, takes it). pools: the records games are made of. games: per game the records it holds by name (the first of fins is the doc\'s, the rest the caller\'s), the session folded now, the hashes whose checks are put off, and what resolveGame says (named: it found the name, which is `name`; a doc key is given as its kind and the start of its id, a transfer\'s id by its start): houses is houseBy for the two houses at rounds 0 1 3 4 5 6 7 9 (the start of the delegation\'s hash, null, or pending), asked every check in the order asked, as its kind and the start of its record\'s hash (sigIds: ids whole). tables: tableGame of the named games, each renamed by its place, the switch naming the one at switchAt; want is the place of the game played.',
    room: ROOM,
    t: T,
    name: NAME,
    houses: [house.pub, house2.pub],
    houseRounds: HOUSE_ROUNDS,
    sigIds: (['ck', 'fin', 'xf', 'offer', 'hkey'] as const).map((kind) => ({ kind, t: T, inc: P.inc, hash: hex('1', 32), id: sigId(kind, T, P.inc, hex('1', 32)) })),
    odd: ODD,
    reads: readCases(),
    keys: keyCases(),
    specials: specialCases(),
    small: smallCases(),
    pools: { p, q },
    games: [...pGames, ...qGames],
    newer: newerCase(),
    tables: tableCases(p, pGames),
  };
}

describe('who holds a FAIR ONLY game (test-vectors/computed-authority-v1.json)', () => {
  const made = build();

  it('matches the file', () => {
    // One record, one game to a line: the file is some hundreds of each.
    const rows = (list: unknown[]) => `[\n${list.map((x) => `  ${JSON.stringify(x)}`).join(',\n')}\n ]`;
    const table = (o: Record<string, unknown>) => `{\n${Object.entries(o).map(([k, v]) => `   ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n  }`;
    const pool = (o: Record<string, Record<string, unknown>>) => `{\n${Object.entries(o).map(([k, v]) => `  ${JSON.stringify(k)}: ${table(v)}`).join(',\n')}\n }`;
    const parts = Object.entries(made).map(([k, v]) => {
      const body = k === 'pools' ? `{\n${Object.entries(v as Record<string, Record<string, Record<string, unknown>>>).map(([l, o]) => ` ${JSON.stringify(l)}: ${pool(o)}`).join(',\n')}\n }`
        : Array.isArray(v) && k !== 'houses' && k !== 'houseRounds' ? rows(v) : JSON.stringify(v);
      return ` ${JSON.stringify(k)}: ${body}`;
    });
    const text = `{\n${parts.join(',\n')}\n}\n`;
    if (process.env.VECTORS_WRITE === '1') writeFileSync(FILE, text);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(text));
  });

  it('reads every base whole, and each field both ways', () => {
    for (const r of made.reads) {
      expect(r.whole, r.name).toBe(r.name.includes('newer') ? 'n' : 'o');
      // No field takes every value (of a newer rules version only the name is read).
      for (const [f, codes] of Object.entries(r.fields)) {
        if (!r.name.includes('newer') || ['ok', 'j', 'rv', 'ts'].includes(f)) expect(codes.includes('j'), `${r.name} ${f}`).toBe(true);
      }
    }
    const taken = (f: string) => new Set(made.reads.filter((r) => !r.name.includes('newer')).flatMap((r) => [...r.fields[f]].map((c, i) => (c === 'o' ? i : -1))));
    for (const f of ['u', 'w', 'l', 'd', 'o', 'n', 's', 'h', 'dl', 'x', 'b', 'k']) expect(taken(f).size, f).toBeGreaterThan(2);
    expect(made.keys.filter((k) => k.parsed !== null).length).toBeGreaterThan(4);
    expect(made.keys.filter((k) => k.read === 'o').length).toBe(1);
    for (const s of Object.values(made.small)) for (const bits of Object.values(s.fields)) expect(bits.includes('0')).toBe(true);
    expect(made.small.xf.fields['o.makerName'].includes('1') && made.small.xf.fields.u.includes('1')).toBe(true);
  });

  it('holds games of every kind the resolver tells apart', () => {
    const g = made.games;
    const count = (f: (w: (typeof g)[number]['want']) => boolean) => g.filter((c) => f(c.want)).length;
    expect(g.length).toBeGreaterThan(190);
    expect(count((w) => w.base === null && w.named)).toBeGreaterThan(3);
    expect(count((w) => !w.named)).toBeGreaterThan(1);
    expect(count((w) => w.pending)).toBeGreaterThan(20);
    expect(count((w) => w.unlooked)).toBeGreaterThan(1);
    expect(count((w) => w.invalid.length > 0)).toBeGreaterThan(40);
    expect(count((w) => w.fin !== null && w.live)).toBeGreaterThan(10);
    expect(count((w) => w.fin !== null && !w.live)).toBeGreaterThan(10);
    expect(count((w) => w.base !== null && !w.live)).toBeGreaterThan(20);
    for (const n of [1, 2, 3]) expect(count((w) => w.chain.length === n), `chain of ${n}`).toBeGreaterThan(5);
    expect(count((w) => w.chain.some((h) => h.key === null && h.step !== null))).toBeGreaterThan(3);
    expect(count((w) => w.chain.some((h) => h.carriers.length > 0))).toBeGreaterThan(10);
    expect(count((w) => w.houses.includes('pending'))).toBeGreaterThan(3);
    expect(count((w) => w.houses.some((h) => h !== null && h !== 'pending'))).toBeGreaterThan(100);
    expect(g.filter((c) => c.liveSid !== undefined).length).toBeGreaterThan(40);
    expect(made.newer).toMatchObject({ newer: true, name: null, holder: null, base: null });
    expect(new Set(made.tables.map((t) => t.want)).size).toBeGreaterThan(3);
    // The scripted ones say what their names say.
    const named = (name: string) => g.find((c) => c.name === name)?.want;
    expect(named('as many forged transfers as a pass walks past')).toMatchObject({ pending: false, holder: buyer.pub });
    expect(named('one more forged transfer than that')).toMatchObject({ pending: true, holder: owner.pub });
    expect(named('more checkpoints of a round than a pass looks at')).toMatchObject({ unlooked: false, pending: false });
    expect(named('the same, one not looked at put off')).toMatchObject({ unlooked: false, pending: false });
    expect(named('the same, the first put off')).toMatchObject({ pending: true });
    expect(named('the same, with a higher round that closes another session')).toMatchObject({ unlooked: true, pending: false });
    expect(named('the same, one of those looked at put off')).toMatchObject({ unlooked: true, pending: true });
    expect(named('the same among ones whose signature fails')?.invalid.length).toBeGreaterThan(0);
    expect(named('more hand-overs than a game may have')?.chain.length).toBe(MAX_TRANSFERS + 1);
    expect(named('a transfer under another table\'s key')?.chain.length).toBe(1);
    expect(named('a transfer carried by a record that speaks for its seller')?.chain.length).toBe(1);
    expect(named('a transfer at the round the game opened')?.chain.length).toBe(2);
    expect(named('an offer used twice')?.chain.map((h) => h.k)).toEqual([owner.pub, buyer.pub, owner.pub]);
    expect(made.tables.some((t) => t.games.length === 2 && t.games[0] === t.games[1] && t.want === 1)).toBe(true);
    const special = (name: string) => made.specials.find((c) => c.name.startsWith(name))?.read;
    expect([special('a trim padded under'), special('a trim padded past'), special('a trim that says'), special('a root that is an end')]).toEqual(['o', 'j', 'j', 'j']);
    expect(made.specials.filter((c) => c.read === 'n').length).toBeGreaterThan(4);
    expect(made.specials.filter((c) => c.name.startsWith('a name') && c.read === 'j').length).toBeGreaterThan(8);
  });
});
