/**
 * 🔒🧪 A FAIR ONLY table's bytes, pinned for the node.
 *
 * The owner's node (ssf-p2p-node house.rs, house_bytes.rs) will read FAIR ONLY
 * checkpoints and write the house's own, so it must compute what the pages
 * compute, byte for byte: the incarnation's name, a record's id, the live
 * session's id, the signed bytes of each record, the bytes a deed offer's
 * maker signs, and the weight that bounds what a record may cost to read.
 * test-vectors/computed-checkpoint-v1.json holds those, made here; this file
 * checks the TypeScript side against it, and house_bytes.rs's tests check the
 * Rust side against the same file.
 *
 * To write it again — only on purpose, when the bytes are meant to change
 * (and the node with them) — run this file with VECTORS_WRITE=1 and review
 * the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import { ckId, faironlyInc, nextSid3, NO_CLOSE, sealCk, sealFin, sealXf, weightOf, xfId } from './computedFairOnly';
import type { CkRec, FairOnlyLetter, FairOnlyName } from './computedFairOnly';
import {
  buyer, changed, ctxOf, DL_HOUSE, hex, house, NAME, offerOf, OPENING_CARRY, owner, P, Q, ROOM, rootOf, signerOf, T, trimOf,
} from './computedFairOnlyKit';
import { signBytes } from './computedFold';
import type { SignedKind } from './computedFold';
import { testIdentity } from './computedTestKit';
import { verifyIdentityStrict } from './keypair';
import { offerSignBytes } from './offerBytes';
import type { TransferOffer } from './offerBytes';

const FILE = new URL('../test-vectors/computed-checkpoint-v1.json', import.meta.url);

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function nameCases() {
  const cases: { letter: FairOnlyLetter; room: string; t: string; name: FairOnlyName }[] = [
    { letter: 'p', room: ROOM, t: T, name: NAME },
    { letter: 'q', room: ROOM, t: T, name: NAME },
    { letter: 'q', room: ROOM, t: 'craps:1', name: NAME },
    { letter: 'p', room: 'room-é-😀', t: 'tablé-😀', name: NAME },
    { letter: 'p', room: ROOM, t: T, name: { ...NAME, ts: 0 } },
    { letter: 'p', room: ROOM, t: T, name: { ...NAME, ts: MAX_SAFE } },
    { letter: 'p', room: ROOM, t: T, name: { ...NAME, rv: 'f2' } },
    { letter: 'p', room: ROOM, t: T, name: { ...NAME, ok: buyer.pub, j: 'fedcba9876543210' } },
    // A room or table id that holds a `|`, the quote that spells one, and what JSON.stringify escapes: the two splits of `a|b|c` differ.
    { letter: 'p', room: 'a|b', t: 'c', name: NAME },
    { letter: 'p', room: 'a', t: 'b|c', name: NAME },
    { letter: 'q', room: 'quote " backslash \\ slash / ctrl \u0001\n\u007f sep \u2028', t: 'tab\t | 😀 "|"', name: NAME },
  ];
  return cases.map((c) => ({ letter: c.letter, room: c.room, t: c.t, ...c.name, inc: faironlyInc(c.letter, c.room, c.t, c.name) }));
}

/** The records of two games, one of each letter, and what the node signs and keys. */
function recordSet() {
  const out: { name: string; kind: 'ck' | 'fin' | 'xf'; ctx: { room: string; t: string; inc: string }; key: string; value: Record<string, unknown> }[] = [];
  const add = (name: string, kind: 'ck' | 'fin' | 'xf', ctx: { room: string; t: string; inc: string }, sealed: { key: string; value: unknown }) =>
    out.push({ name, kind, ctx: { room: ctx.room, t: ctx.t, inc: ctx.inc }, key: sealed.key, value: sealed.value as Record<string, unknown> });

  for (const [letter, ctx] of [['p', P], ['q', Q]] as const) {
    const root = rootOf(ctx, letter);
    const trim = trimOf(ctx, letter);
    const fin = sealFin(ctx, owner.pub, owner.sign);
    const xf = sealXf(ctx, { v: 1, o: offerOf(owner, buyer), u: trim.value.u, k: buyer.pub }, buyer.sign);
    add(`${letter} root`, 'ck', ctx, root);
    add(`${letter} trim`, 'ck', ctx, trim);
    add(`${letter} void trim`, 'ck', ctx, trimOf(ctx, letter, { d: `z:${hex('c', 32)}`, o: undefined }));
    add(`${letter} sweep`, 'ck', ctx, trimOf(ctx, letter, { b: nextSid3(ctx, trim.value), w: 1 }));
    add(`${letter} end`, 'ck', ctx, trimOf(ctx, letter, { b: nextSid3(ctx, trim.value), e: 1, f: fin.value, s: undefined, h: undefined, k: owner.pub, dl: undefined }));
    add(`${letter} adoption`, 'ck', ctx, trimOf(ctx, letter, { k: buyer.pub, dl: undefined, x: [xf.value] }));
    add(`${letter} fin`, 'fin', ctx, fin);
    add(`${letter} transfer`, 'xf', ctx, xf);
  }
  return out;
}

function sidCases() {
  const trim = trimOf(Q, 'q').value;
  const cps: { ctx: typeof P; cp: Record<string, unknown> }[] = [
    { ctx: P, cp: { b: 'g', u: 0, l: NO_CLOSE, n: {} } },
    { ctx: Q, cp: { b: 'g', u: 0, l: NO_CLOSE, n: {}, s: OPENING_CARRY } },
    { ctx: P, cp: pick(trimOf(P, 'p').value, ['b', 'u', 'l', 'd', 'o', 'n', 'h']) },
    { ctx: Q, cp: pick(trim, ['b', 'u', 'l', 'd', 'o', 'n', 's', 'h']) },
    { ctx: Q, cp: { ...pick(trim, ['b', 'u', 'l', 'd', 'o', 'n', 's', 'h']), w: 2 } },
    { ctx: Q, cp: { ...pick(trim, ['b', 'u', 'l', 'd', 'n']), e: 1 } },
    { ctx: { ...Q, t: 'craps:1' }, cp: pick(trim, ['b', 'u', 'l', 'd', 'o', 'n', 's', 'h']) },
    { ctx: P, cp: { ...pick(trimOf(P, 'p').value, ['b', 'u', 'l', 'd', 'n']), n: { 'é': '1', '😀': '-2', alice: '3' } } },
  ];
  return cps.map((c) => ({ ctx: c.ctx, cp: c.cp, sid: nextSid3(c.ctx, c.cp as never) }));
}

function pick(v: object, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => [k, (v as Record<string, unknown>)[k]]));
}

/** Offers whose names hold what JSON.stringify escapes, and what it doesn't. */
function offerCases() {
  const maker = testIdentity('fo-offer-maker');
  const names = [
    'Dana', '', 'quote " backslash \\ slash /', 'controls \u0000\u0001\b\t\n\u000b\f\r\u001f\u007f', 'line sep ', 'astral 😀 and é and ﬀ', '퟿￿',
  ];
  const base: Omit<TransferOffer, 'sig'> = {
    v: 1, kind: 'transfer-offer', asset: { kind: 'deed', roomId: ROOM, roomName: 'Furlong' }, makerPub: maker.pub, makerName: 'Dana', toPub: buyer.pub,
    price: 0, issuedAt: NAME.ts, expiresAt: NAME.ts + 1000, nonce: '0123456789abcdef01234567',
  };
  const offers: Omit<TransferOffer, 'sig'>[] = [
    ...names.map((n) => ({ ...base, makerName: n, asset: { kind: 'deed' as const, roomId: ROOM, roomName: n } })),
    { ...base, issuedAt: 0, expiresAt: MAX_SAFE },
    { ...base, toPub: undefined },
    { ...base, toPub: undefined, toVentureId: 'venture-1', toVentureName: 'Ünïted 😀 Ventures' },
  ];
  return offers.map((o) => {
    const bytes = offerSignBytes(o);
    return { offer: { ...o, sig: maker.sign(bytes) }, bytes: bytesToHex(bytes) };
  });
}

/** How a vector writes an undefined value, which JSON can't hold: the node reads it as one. */
const UNDEF = { $undefined: true };
function realize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(realize);
  if (v !== null && typeof v === 'object') {
    if ((v as Record<string, unknown>).$undefined === true) return undefined;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, realize(x)]));
  }
  return v;
}

function weightCases() {
  const deep = (n: number): unknown => { let v: unknown = 1; for (let i = 0; i < n; i++) v = [v]; return v; };
  const wrap = (inner: unknown, n: number, around: (v: unknown) => unknown): unknown => { let v = inner; for (let i = 0; i < n; i++) v = around(v); return v; };
  const padded = { ...trimOf(Q, 'q').value, pad0: UNDEF, pad1: UNDEF, pad2: UNDEF };
  const values: { value: unknown; cap: number }[] = [
    { value: 'abc', cap: 100 }, { value: '', cap: 100 }, { value: 'é', cap: 100 }, { value: '€uro', cap: 100 }, { value: '😀', cap: 100 },
    { value: 0, cap: 100 }, { value: 12345678901, cap: 100 }, { value: 1.5, cap: 100 }, { value: true, cap: 100 }, { value: null, cap: 100 },
    { value: [], cap: 100 }, { value: {}, cap: 100 }, { value: [1, 'a', [2, []]], cap: 100 }, { value: [1, 2, 3], cap: 100 },
    { value: { ab: 1 }, cap: 100 }, { value: { a: 'x', b: [1] }, cap: 100 }, { value: { 'é': { '😀': ['€'] } }, cap: 100 },
    { value: 'x'.repeat(98), cap: 100 }, { value: 'x'.repeat(99), cap: 100 }, { value: [1, 2, 3], cap: 29 }, { value: [1, 2, 3], cap: 28 },
    { value: { a: 1, b: 2 }, cap: 28 }, { value: { a: 1, b: 2 }, cap: 27 },
    { value: deep(16), cap: 10_000 }, { value: deep(17), cap: 10_000 },
    { value: trimOf(Q, 'q').value, cap: 1_572_864 }, { value: trimOf(Q, 'q').value, cap: 500 },
    // An undefined field weighs its key, 4 and 8, as the node weighs the padding a peer can write so.
    { value: { a: UNDEF }, cap: 15 }, { value: { a: UNDEF }, cap: 14 }, { value: { a: UNDEF, bb: 1 }, cap: 100 }, { value: [UNDEF, 1], cap: 100 },
    { value: { n: { alice: UNDEF }, k: 'x' }, cap: 100 }, { value: padded, cap: 1_572_864 }, { value: padded, cap: weightOf(trimOf(Q, 'q').value, 1_572_864)! + 20 },
    // An undefined field takes no depth (the node charges it where it stands): {a: undefined} in 16 objects is light
    // (127), in 17 its object is past the depth. An undefined member of an array is a member, a level down.
    { value: wrap({ a: UNDEF }, 16, (v) => ({ z: v })), cap: 1_000 }, { value: wrap({ a: UNDEF }, 17, (v) => ({ z: v })), cap: 1_000 },
    { value: wrap([UNDEF], 15, (v) => [v]), cap: 1_000 }, { value: wrap([UNDEF], 16, (v) => [v]), cap: 1_000 },
  ];
  return values.map((c) => {
    // (What the file holds, markers and all, is what is weighed.)
    const stored = JSON.parse(JSON.stringify(c.value));
    return { value: stored, cap: c.cap, weight: weightOf(realize(stored), c.cap) };
  });
}

function build() {
  const records = recordSet().map((r) => ({
    ...r,
    id: r.kind === 'xf' ? xfId(r.value) : r.kind === 'ck' ? ckId(r.value) : null,
    bytes: bytesToHex(signBytes(r.kind as SignedKind, r.ctx, r.value)),
  }));
  return {
    note: 'A FAIR ONLY table\'s bytes, as the pages compute them (src/computedFairOnlyVectors.test.ts writes this with VECTORS_WRITE=1; ssf-p2p-node house_bytes.rs tests read it). names: faironlyInc. records: each a whole page-written record (`ck:` checkpoint, `fin:` end order, `xf:` transfer) at ctx, its key, its id (ckId/xfId; null for a fin), and signBytes (hex) which `k` signed as `g`. sids: nextSid3. offers: the bytes a deed offer\'s maker signs (offerSignBytes, hex) and the offer with that signature; a lone surrogate can\'t be in JSON, and Yjs writes one as U+FFFD, so pages refuse one in an offer\'s text and none is here. weights: weightOf(value, cap), null past the cap or the depth; the node\'s weight() says the same.',
    names: nameCases(),
    records,
    sids: sidCases(),
    offers: offerCases(),
    weights: weightCases(),
  };
}

describe('a FAIR ONLY table\'s bytes (test-vectors/computed-checkpoint-v1.json)', () => {
  const made = build();

  it('match the file', () => {
    const text = `${JSON.stringify(made, null, 2)}\n`;
    if (process.env.VECTORS_WRITE === '1') writeFileSync(FILE, text);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(text));
  });

  it('are records the pages accept', () => {
    for (const r of made.records) {
      expect(r.key.endsWith(r.id ?? `:${r.ctx.inc}`), r.name).toBe(true);
      const sealed = r.kind === 'ck' ? sealCk(r.ctx, { ...r.value, g: undefined } as unknown as Omit<CkRec, 'g'>, signerOf(r.value.k)) : null;
      if (sealed) expect(sealed.key, r.name).toBe(r.key);
      expect(verifyIdentityStrict(r.value.k as string, hexToBytes(r.bytes), r.value.g as string), r.name).toBe(true);
    }
    for (const o of made.offers) expect(verifyIdentityStrict(o.offer.makerPub, hexToBytes(o.bytes), o.offer.sig), o.bytes).toBe(true);
  });

  it('cover the names, the roots, ends and adoptions of both games', () => {
    expect(new Set(made.names.map((n) => n.inc)).size).toBe(made.names.length);
    expect(made.records.map((r) => r.name).sort()).toEqual(
      ['p', 'q'].flatMap((l) => ['root', 'trim', 'void trim', 'sweep', 'end', 'adoption', 'fin', 'transfer'].map((k) => `${l} ${k}`)).sort(),
    );
    expect(new Set(made.sids.map((s) => s.sid)).size).toBe(made.sids.length);
    expect(made.weights.some((w) => w.weight === null) && made.weights.some((w) => w.weight !== null)).toBe(true);
    // The fixed records the Rust tests lean on.
    expect(changed(P, rootOf(P, 'p'), {}).value).toEqual(rootOf(P, 'p').value);
    expect(DL_HOUSE.h).toBe(house.pub);
    expect(ctxOf('p').inc).toBe(made.names[0].inc);
  });
});
