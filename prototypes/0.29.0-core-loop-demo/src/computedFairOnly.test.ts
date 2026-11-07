/**
 * 🔒🧪 FAIR ONLY tables: names, records and bytes (computedFairOnly.ts).
 *
 * Every rule of design §8.2 and §8.3 S0 has a test that makes only it fail:
 * a record is built whole (hashed, keyed and signed) and then changed in one
 * place, so a rejection can only be that rule's.
 */

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { canon, MAX_TABLE_PIDS, nextSid, signBytes } from './computedFold';
import {
  asDeedOffer, asDo, asFin, asXf, ckId, ckKey, doKey, FAIR_ONLY_GAMES, FAIR_ONLY_RV, faironlyInc, finKey, isFairOnlyInc, isKnownRv,
  MAX_CHECKPOINT_BYTES, MAX_OFFER_TEXT, MAX_SMALL_RECORD_BYTES, MAX_TABLE_PID_BYTES, MAX_TRANSFERS, MAX_WEIGHT_DEPTH, nextSid3, NO_CLOSE, OFFER_SKEW_MS, parseFairOnlyKey,
  readCk, sealCk, sealFin, sealXf, weightOf, xfId, xfKey,
} from './computedFairOnly';
import type { CkRec, DeedOffer, FairOnlyLetter, FairOnlyName, XferRec } from './computedFairOnly';
import {
  buyer, changed, ctxOf, delegation, DL_HOUSE, hex, house, houseSigner, NAME, offerOf, OPENING_CARRY, owner, P, Q, ROOM, rootOf, T, trimOf,
} from './computedFairOnlyKit';
import type { FoldCtx } from './computedFold';
import { testIdentity } from './computedTestKit';
import { verifyIdentityStrict } from './keypair';
import { offerSignBytes } from './offerBytes';

/** (The context a record is read at is the room's alone; the specs pass the game's for the reader's sake.) */
const read = (_ctx: FoldCtx, c: { key: string; value: unknown }) => readCk(ROOM, c.key, c.value);

describe('names', () => {
  it('is the letter and 24 hex of the stated hash', () => {
    const pre = `ssf-computed-faironly-inc-v1|p|"${ROOM}"|"${T}"|"f1"|"${NAME.ok}"|"${NAME.j}"|${NAME.ts}`;
    expect(faironlyInc('p', ROOM, T, NAME)).toBe(`p${bytesToHex(sha256(utf8ToBytes(pre))).slice(0, 24)}`);
    expect(P.inc).toMatch(/^p[0-9a-f]{24}$/);
    expect(Q.inc).toMatch(/^q[0-9a-f]{24}$/);
  });

  it('changes with every input', () => {
    const names = new Set<string>([
      P.inc, Q.inc,
      faironlyInc('p', 'room-other', T, NAME),
      faironlyInc('p', ROOM, 'roulette-2', NAME),
      faironlyInc('p', ROOM, T, { ...NAME, rv: 'f2' }),
      faironlyInc('p', ROOM, T, { ...NAME, ok: buyer.pub }),
      faironlyInc('p', ROOM, T, { ...NAME, j: 'fedcba9876543210' }),
      faironlyInc('p', ROOM, T, { ...NAME, ts: NAME.ts + 1 }),
    ]);
    expect(names.size).toBe(8);
  });

  it('does not make one name of two (room, table) pairs that join to the same text', () => {
    const pairs: [string, string][] = [
      ['a|b', 'c'], ['a', 'b|c'], ['a|b|c', ''], ['', 'a|b|c'], ['a"', '|b'], ['a', '"|b'], ['a\\', '"|"b'], ['a\\"|', 'b'], ['a|"', '"|b'],
    ];
    expect(new Set(pairs.map(([room, t]) => faironlyInc('p', room, t, NAME))).size).toBe(pairs.length);
  });

  it('so what one room and table signed or wrote binds to no other, though the signed bytes join alike', () => {
    const ctx1: FoldCtx = { room: 'a|b', t: 'c', inc: faironlyInc('p', 'a|b', 'c', NAME) };
    const ctx2: FoldCtx = { room: 'a', t: 'b|c', inc: faironlyInc('p', 'a', 'b|c', NAME) };
    expect(ctx1.inc).not.toBe(ctx2.inc);
    // A checkpoint of the first is junk in the second, under the key it would have there ...
    const root = rootOf(ctx1, 'p');
    expect(readCk('a|b', root.key, root.value).kind).toBe('ok');
    expect(readCk('a', ckKey('b|c', ctx1.inc, ckId(root.value) as string), root.value)).toEqual({ kind: 'junk' });
    // ... and an end order the owner signed in the first is signed over bytes the second's name makes different.
    const fin1 = sealFin(ctx1, owner.pub, owner.sign).value;
    const fin2 = sealFin(ctx2, owner.pub, owner.sign).value;
    expect(fin1.g).not.toBe(fin2.g);
    expect(verifyIdentityStrict(owner.pub, signBytes('fin', ctx1, fin1), fin1.g)).toBe(true);
    expect(verifyIdentityStrict(owner.pub, signBytes('fin', ctx2, fin1), fin1.g)).toBe(false);
  });

  it('is recognised by its letter and length alone, and only p and q', () => {
    expect(isFairOnlyInc(P.inc) && isFairOnlyInc(Q.inc)).toBe(true);
    for (const bad of ['c0123456789abcdef01234567', 'r0123456789abcdef01234567', 'p0123456789abcdef0123456', 'p0123456789ABCDEF01234567', '', 'p0123456789abcdef012345678', 7, null]) {
      expect(isFairOnlyInc(bad)).toBe(false);
    }
    expect(FAIR_ONLY_GAMES).toEqual({ p: 'roulette', q: 'craps' });
    expect(isKnownRv('f1') && !isKnownRv('f2') && !isKnownRv('')).toBe(true);
  });
});

describe('keys', () => {
  it('build and parse back, with a table id that holds colons', () => {
    const id = hex('1', 32);
    for (const t of ['roulette-1', 'craps:1', 'a:b:c']) {
      const inc = ctxOf('q', t).inc;
      expect(parseFairOnlyKey(ckKey(t, inc, id))).toEqual({ kind: 'ck', t, inc, id });
      expect(parseFairOnlyKey(xfKey(t, inc, id))).toEqual({ kind: 'xf', t, inc, id });
      expect(parseFairOnlyKey(finKey(t, inc))).toEqual({ kind: 'fin', t, inc });
    }
    expect(parseFairOnlyKey(doKey(hex('2', 24)))).toEqual({ kind: 'do', nonce: hex('2', 24) });
  });

  it('refuse any other spelling', () => {
    const inc = P.inc;
    const id = hex('1', 32);
    for (const bad of [
      `ck:${T}:${inc}:${hex('1', 31)}`, `ck:${T}:${inc}:${hex('1', 33)}`, `ck:${T}:${inc}:${hex('A', 32)}`, `ck::${inc}:${id}`, `ck:${T}:c0123456789abcdef01234567:${id}`,
      `ck:${T}:${inc}`, `fin:${T}`, `fin::${inc}`, `fin:${T}:${inc}:${id}`, `xf:${T}:${inc}`, `do:${hex('2', 23)}`, `do:${hex('2', 25)}`, `do:${'G'.repeat(24)}`,
      `sum:${T}:${inc}`, `hs:${T}:${inc}`, `hk:${owner.pub}`, `ses:${T}:${inc}:g`, 'ck:', '', 'ck',
    ]) expect(parseFairOnlyKey(bad), bad).toBeNull();
  });

  it('name only a roulette or a craps incarnation, whatever the record', () => {
    // (c, k, r and d are the other tables' letters; a, P and x were never any.)
    for (const letter of ['c', 'k', 'r', 'd', 'a', 'P', 'x']) {
      for (const key of [`ck:${T}:${letter}${hex('0', 24)}:${hex('1', 32)}`, `xf:${T}:${letter}${hex('0', 24)}:${hex('1', 32)}`, `fin:${T}:${letter}${hex('0', 24)}`]) {
        expect(parseFairOnlyKey(key), key).toBeNull();
      }
    }
    for (const letter of ['p', 'q']) expect(parseFairOnlyKey(`fin:${T}:${letter}${hex('0', 24)}`)).not.toBeNull();
  });

  it('are strings, and anything else is no key rather than a throw', () => {
    for (const bad of [undefined, null, 5, {}, [], ['ck:x'], true]) expect(parseFairOnlyKey(bad as never), String(bad)).toBeNull();
  });
});

describe('ids, session ids and signatures', () => {
  const cp = trimOf(P, 'p');

  it('a checkpoint id is the first 32 hex of sha256("ssf-ck-id-v1|" + canon(value))', () => {
    const want = bytesToHex(sha256(utf8ToBytes(`ssf-ck-id-v1|${canon(cp.value)}`))).slice(0, 32);
    expect(ckId(cp.value)).toBe(want);
    expect(cp.key).toBe(ckKey(P.t, P.inc, want));
  });

  it('a checkpoint id changes with any field, g included', () => {
    const base = ckId(cp.value);
    for (const patch of [{ u: 4 }, { n: { alice: '26', bob: '-26' } }, { k: buyer.pub }, { g: 'A'.repeat(86) }, { h: undefined }, { w: 1 }]) {
      expect(ckId({ ...cp.value, ...patch })).not.toBe(base);
    }
    expect(ckId({ ...cp.value, u: 1.5 })).toBeNull();
  });

  it('a transfer id is its own domain', () => {
    const xf = sealXf(P, { v: 1, o: offerOf(owner, buyer), u: 3, k: buyer.pub }, buyer.sign);
    const want = bytesToHex(sha256(utf8ToBytes(`ssf-xf-id-v1|${canon(xf.value)}`))).slice(0, 32);
    expect(xfId(xf.value)).toBe(want);
    expect(xf.key).toBe(xfKey(P.t, P.inc, want));
    expect(ckId(xf.value)).not.toBe(xfId(xf.value));
  });

  it('nextSid3 is the first 24 hex of sha256("ssf-ct-sid-v3|" + canon of the state and the table)', () => {
    const v = cp.value;
    const c = canon({ room: ROOM, t: T, inc: P.inc, b: v.b, u: v.u, l: v.l, d: v.d, o: v.o, n: v.n, h: v.h });
    expect(nextSid3(P, v)).toBe(bytesToHex(sha256(utf8ToBytes(`ssf-ct-sid-v3|${c}`))).slice(0, 24));
  });

  it('nextSid3 changes with the state and the table, and with nothing else', () => {
    const v = trimOf(Q, 'q').value;
    const base = nextSid3(Q, v);
    for (const patch of [{ b: hex('e', 24) }, { u: 4 }, { w: 1 }, { l: hex('e', 32) }, { d: `z:${hex('e', 32)}` }, { o: [4, 3] }, { n: { alice: '1' } }, { e: 1 }, { s: { p: 8, w: {} } }, { h: hex('e', 64) }]) {
      expect(nextSid3(Q, { ...v, ...patch } as CkRec), JSON.stringify(patch)).not.toBe(base);
    }
    expect(nextSid3({ ...Q, room: 'room-other' }, v)).not.toBe(base);
    expect(nextSid3({ ...Q, t: 'craps-2' }, v)).not.toBe(base);
    expect(nextSid3({ ...Q, inc: P.inc }, v)).not.toBe(base);
    // Not the name's inputs, not who signed or how they proved it.
    for (const patch of [{ ok: buyer.pub }, { j: hex('9', 16) }, { rv: 'f2' }, { ts: 5 }, { k: buyer.pub }, { g: 'B'.repeat(86) }, { dl: undefined }, { x: [] }, { f: { v: 1, k: owner.pub, g: 'C'.repeat(86) } }]) {
      expect(nextSid3(Q, { ...v, ...patch } as CkRec), JSON.stringify(patch)).toBe(base);
    }
    // An absent field and an undefined one are the same state.
    expect(nextSid3(Q, { ...v, w: undefined })).toBe(base);
  });

  it('nextSid3 is not the v1 session id, and throws on a state canon refuses', () => {
    const v = trimOf(P, 'p').value;
    expect(nextSid3(P, v)).not.toBe(nextSid(P, v as never));
    expect(() => nextSid3(P, { ...v, u: 1.5 })).toThrow(TypeError);
  });

  it('each kind signs its own bytes, for one table and incarnation only', () => {
    const body = { v: 1 as const, k: owner.pub };
    const kinds = ['ck', 'fin', 'xf'] as const;
    const bytes = kinds.map((k) => bytesToHex(signBytes(k, P, body)));
    expect(new Set(bytes).size).toBe(3);
    const fin = sealFin(P, owner.pub, owner.sign);
    expect(verifyIdentityStrict(owner.pub, signBytes('fin', P, fin.value), fin.value.g)).toBe(true);
    for (const other of [signBytes('ck', P, fin.value), signBytes('xf', P, fin.value), signBytes('fin', Q, fin.value), signBytes('fin', { ...P, room: 'x' }, fin.value), signBytes('fin', { ...P, t: 'x' }, fin.value)]) {
      expect(verifyIdentityStrict(owner.pub, other, fin.value.g)).toBe(false);
    }
    expect(fin.key).toBe(finKey(P.t, P.inc));
    // g is left out of what is signed.
    expect(bytesToHex(signBytes('fin', P, { ...fin.value, g: 'Z' }))).toBe(bytesToHex(signBytes('fin', P, body)));
  });

  it('sealCk signs the whole value but g, with the house key, and keys it by its hash', () => {
    expect(verifyIdentityStrict(house.pub, signBytes('ck', P, cp.value), cp.value.g)).toBe(true);
    expect(cp.key).toBe(ckKey(P.t, P.inc, ckId(cp.value) as string));
    expect(() => sealCk(P, { ...cp.value, u: 1.5 }, houseSigner)).toThrow(TypeError);
    expect(() => sealXf(P, { v: 1, o: { ...offerOf(owner, buyer), issuedAt: 1.5 }, u: 3, k: buyer.pub }, buyer.sign)).toThrow(TypeError);
  });
});

describe('sealing', () => {
  it('leaves the undefined fields of a body out of the record it stores', () => {
    const body = { ...rootOf(P, 'p').value, g: undefined, x: undefined, w: undefined } as unknown as Omit<CkRec, 'g'>;
    const sealed = sealCk(P, body, owner.sign);
    expect(Object.keys(sealed.value)).not.toContain('x');
    expect(Object.keys(sealed.value)).not.toContain('w');
    expect(sealed.key).toBe(rootOf(P, 'p').key);
    expect(Object.values(sealed.value).every((v) => v !== undefined)).toBe(true);
    const xf = sealXf(P, { v: 1, o: offerOf(owner, buyer), u: 3, k: buyer.pub, g: undefined } as unknown as Omit<XferRec, 'g'>, buyer.sign);
    expect(Object.values(xf.value).every((v) => v !== undefined)).toBe(true);
  });
});

describe('weightOf', () => {
  it('weighs a string by its UTF-8 bytes and quotes, anything else scalar 8', () => {
    expect(weightOf('abc', 100)).toBe(5);
    expect(weightOf('', 100)).toBe(2);
    expect(weightOf('é', 100)).toBe(4);
    expect(weightOf('€', 100)).toBe(5);
    expect(weightOf('😀', 100)).toBe(6);
    expect(weightOf('\ud800', 100)).toBe(5);
    for (const x of [0, 1.5, -3, true, null, undefined, 10n]) expect(weightOf(x, 100)).toBe(8);
  });

  it('weighs an array its brackets and a comma a member, an object its braces and for each field the key and 4', () => {
    expect(weightOf([], 100)).toBe(2);
    expect(weightOf([1, 2, 3], 100)).toBe(2 + 3 + 24);
    expect(weightOf({}, 100)).toBe(2);
    expect(weightOf({ ab: 1 }, 100)).toBe(2 + (2 + 4) + 8);
    expect(weightOf({ a: 'x', b: [1] }, 100)).toBe(2 + (1 + 4) + 3 + (1 + 4) + (2 + 1 + 8));
    expect(weightOf(new Uint8Array(5), 100)).toBe(7);
  });

  it('weighs an undefined field like any other, as the node weighs the padding a peer can write', () => {
    expect(weightOf({ a: undefined }, 100)).toBe(2 + (1 + 4) + 8);
    expect(weightOf({ a: undefined, b: 1 }, 100)).toBe(2 + (1 + 4) + 8 + (1 + 4) + 8);
    expect(weightOf([undefined, 1], 100)).toBe(2 + (1 + 8) + (1 + 8));
    expect(weightOf({ a: undefined }, 15)).toBe(15);
    expect(weightOf({ a: undefined }, 14)).toBeNull();
  });

  it('charges an undefined field where it stands, so it takes no depth, and visits an undefined member of an array one level down', () => {
    // {a: undefined} inside 16 objects is 15 and 7 for each wrapper, and light: the node does not visit the field.
    let inObjects: unknown = { a: undefined };
    for (let i = 0; i < MAX_WEIGHT_DEPTH; i++) inObjects = { z: inObjects };
    expect(weightOf(inObjects, 1_000)).toBe(15 + 7 * MAX_WEIGHT_DEPTH);
    expect(weightOf({ z: inObjects }, 1_000)).toBeNull(); // (the inner object itself is now too deep)
    // [undefined] inside 15 arrays has its member on the last level there is; one more and it is a level past.
    let inArrays: unknown = [undefined];
    for (let i = 0; i < MAX_WEIGHT_DEPTH - 1; i++) inArrays = [inArrays];
    expect(weightOf(inArrays, 1_000)).toBe(11 + 3 * (MAX_WEIGHT_DEPTH - 1));
    expect(weightOf([inArrays], 1_000)).toBeNull();
    // It counts against the cap at the field, the whole 8 of it.
    expect(weightOf({ a: { b: undefined } }, 2 + 5 + 2 + 5 + 8)).toBe(22);
    expect(weightOf({ a: { b: undefined } }, 2 + 5 + 2 + 5 + 7)).toBeNull();
  });

  it('is not got round by padding with undefined fields, however many', () => {
    const pad: Record<string, unknown> = {};
    for (let i = 0; i < 300_000; i++) pad[`k${i}`] = undefined;
    const t0 = Date.now();
    expect(weightOf(pad, MAX_CHECKPOINT_BYTES)).toBeNull();
    expect(weightOf({ x: pad, y: [pad] }, MAX_CHECKPOINT_BYTES)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('gives up at the cap, and at a depth no record has', () => {
    expect(weightOf('x'.repeat(98), 100)).toBe(100);
    expect(weightOf('x'.repeat(99), 100)).toBeNull();
    expect(weightOf(new Array(200).fill(0), 100)).toBeNull();
    expect(weightOf({ ['k'.repeat(200)]: 1 }, 100)).toBeNull();
    expect(weightOf(new Uint8Array(200), 100)).toBeNull();
    let deep: unknown = 1;
    for (let i = 0; i < MAX_WEIGHT_DEPTH; i++) deep = [deep];
    expect(weightOf(deep, 10_000)).not.toBeNull();
    expect(weightOf([deep], 10_000)).toBeNull();
  });

  it('measures a huge value for about the cap, not its size', () => {
    const big = 'é'.repeat(5_000_000);
    const t0 = Date.now();
    expect(weightOf(big, 1_000)).toBeNull();
    expect(weightOf(new Array(5_000_000).fill(1), 1_000)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe('the constants', () => {
  it('are the ones the node twin and design §8.9 name: a change to one is a change to what is junk', () => {
    expect({
      FAIR_ONLY_RV, MAX_CHECKPOINT_BYTES, MAX_SMALL_RECORD_BYTES, MAX_TABLE_PID_BYTES, MAX_TRANSFERS, OFFER_SKEW_MS, MAX_OFFER_TEXT, MAX_WEIGHT_DEPTH,
      NO_CLOSE,
    }).toEqual({
      FAIR_ONLY_RV: 'f1', MAX_CHECKPOINT_BYTES: 1_572_864, MAX_SMALL_RECORD_BYTES: 8_192, MAX_TABLE_PID_BYTES: 1_000_000, MAX_TRANSFERS: 8,
      OFFER_SKEW_MS: 600_000, MAX_OFFER_TEXT: 256, MAX_WEIGHT_DEPTH: 16, NO_CLOSE: '0'.repeat(32),
    });
  });
});

describe('fins, offers, transfers', () => {
  const fin = sealFin(P, owner.pub, owner.sign).value;

  it('a fin is {v, k, g} and nothing else', () => {
    expect(asFin(fin)).toEqual(fin);
    for (const bad of [{ ...fin, v: 2 }, { ...fin, k: 'short' }, { ...fin, g: 'short' }, { ...fin, r: 4 }, { v: 1, k: fin.k }, [], null, 'x', { ...fin, k: undefined }]) {
      expect(asFin(bad)).toBeNull();
    }
  });

  const offer = offerOf(owner, buyer);

  it('a deed offer made out to a person for this room is read', () => {
    expect(asDeedOffer(offer, ROOM)).toEqual(offer);
    expect(asDeedOffer({ ...offer, toVentureId: undefined, toVentureName: undefined }, ROOM)).toEqual(offer);
  });

  it('every other shape of offer is refused', () => {
    const bad: Record<string, unknown>[] = [
      { v: 2 }, { kind: 'x' }, { asset: { kind: 'shares', ventureId: 'v', ventureName: 'n', officeRoomId: 'o', count: 1 } },
      { asset: { kind: 'deed', roomId: 'room-other', roomName: 'n' } }, { asset: { kind: 'deed', roomId: ROOM } },
      { asset: { kind: 'deed', roomId: ROOM, roomName: 'n', extra: 1 } }, { asset: { kind: 'deed', roomId: ROOM, roomName: 'x'.repeat(MAX_OFFER_TEXT + 1) } },
      { asset: { kind: 'company', roomId: ROOM, roomName: 'n' } }, { asset: null }, { asset: 'deed' }, { asset: 7 }, { asset: [] },
      { makerPub: 'short' }, { makerName: 'x'.repeat(MAX_OFFER_TEXT + 1) }, { makerName: 7 }, { toPub: undefined }, { toPub: 'short' },
      { toVentureId: 'company' }, { toVentureName: 'company' }, { price: 1 }, { price: 0.5 }, { price: -0 + 1e21 },
      { issuedAt: 1.5 }, { issuedAt: -1 }, { issuedAt: Number.MAX_SAFE_INTEGER + 1 }, { expiresAt: NaN }, { expiresAt: Infinity }, { expiresAt: '5' },
      { nonce: hex('0', 23) }, { nonce: hex('G', 24) }, { nonce: hex('A', 24) }, { sig: 'short' }, { extra: 1 },
    ];
    for (const patch of bad) {
      const o = { ...offer, ...patch };
      for (const k of Object.keys(patch)) if (patch[k] === undefined) delete (o as Record<string, unknown>)[k];
      expect(asDeedOffer(o, ROOM), JSON.stringify(patch)).toBeNull();
    }
    expect(asDeedOffer(null, ROOM)).toBeNull();
    expect(asDeedOffer([], ROOM)).toBeNull();
  });

  it('refuses text with an unpaired surrogate, and reads a pair as the character it is', () => {
    for (const text of ['\ud800', 'a\ud800b', '\udc00', 'a\udc00', '\udc00\ud800', '\ud83d', 'x\ud83dy', '😀\ud83d', '\ud83d😀\ude00', '\udbff', '\udfff', 'a\udfff']) {
      expect(asDeedOffer({ ...offer, makerName: text }, ROOM), JSON.stringify(text)).toBeNull();
      expect(asDeedOffer({ ...offer, asset: { ...offer.asset, roomName: text } }, ROOM), JSON.stringify(text)).toBeNull();
    }
    for (const text of ['😀', 'a😀b', '😀', '퟿', '', '􏿿', '𐀀', '😀😀']) {
      expect(asDeedOffer({ ...offer, makerName: text }, ROOM), JSON.stringify(text)).not.toBeNull();
      expect(asDeedOffer({ ...offer, asset: { ...offer.asset, roomName: text } }, ROOM), JSON.stringify(text)).not.toBeNull();
    }
    // (Wherever the offer is read: in a transfer, or kept under its nonce.)
    const lone = { ...offer, makerName: 'a\ud800' };
    expect(asXf(sealXf(P, { v: 1, o: lone, u: 3, k: buyer.pub }, buyer.sign).value, ROOM)).toBeNull();
    expect(asDo(doKey(offer.nonce), lone, ROOM)).toBeNull();
  });

  it('refuses it because Yjs writes strings as UTF-8: a peer reads U+FFFD, and the maker\'s signature fails there', () => {
    const bad = offerOf(owner, buyer, { makerName: 'Ma\ud800ker' });
    expect(verifyIdentityStrict(owner.pub, offerSignBytes(bad), bad.sig)).toBe(true); // (it holds where it was written)
    const a = new Y.Doc();
    a.getMap('m').set('o', bad);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const got = b.getMap('m').get('o') as DeedOffer;
    expect(got.makerName).toBe('Ma�ker');
    expect(verifyIdentityStrict(owner.pub, offerSignBytes(got), got.sig)).toBe(false);
    // So the page that wrote it does not read it either, and agrees with every peer.
    expect(asDeedOffer(bad, ROOM)).toBeNull();
    expect(asDeedOffer(got, ROOM)).not.toBeNull();
  });

  it('a transfer is {v, o, u, k, g} with the offer made out to k', () => {
    const xf = sealXf(P, { v: 1, o: offer, u: 3, k: buyer.pub }, buyer.sign).value;
    expect(asXf(xf, ROOM)).toEqual(xf);
    expect(asXf({ ...xf, u: 0 }, ROOM)).not.toBeNull();
    for (const bad of [
      { ...xf, v: 2 }, { ...xf, u: -1 }, { ...xf, u: 1.5 }, { ...xf, u: 2 ** 48 + 1 }, { ...xf, k: owner.pub }, { ...xf, k: 'short' }, { ...xf, g: 'short' }, { ...xf, extra: 1 },
      { ...xf, o: { ...offer, toPub: owner.pub } }, { ...xf, o: { ...offer, asset: { kind: 'deed', roomId: 'room-other', roomName: 'n' } } }, { ...xf, o: undefined },
    ]) expect(asXf(bad, ROOM)).toBeNull();
    expect(asXf(xf, 'room-other')).toBeNull();
    for (const bad of [null, undefined, 'x', 7, [], [xf]]) expect(asXf(bad, ROOM), String(bad)).toBeNull();
  });

  /** `v` with `n` fields that are undefined: no reader counts them, and canon (so an id and a signature) leaves them out. */
  const pad = <V extends object>(v: V, n: number): V => ({ ...v, ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`pad${i}`, undefined])) });

  it('weighs a transfer, an offer or an end order before it reads a field: padded past the small-record cap it is junk, and a little padding is the same record', () => {
    const xf = sealXf(P, { v: 1, o: offer, u: 3, k: buyer.pub }, buyer.sign).value;
    const many = 2_000;
    for (const [what, clean, read] of [
      ['an end order', fin, (v: unknown) => asFin(v)],
      ['an offer', offer, (v: unknown) => asDeedOffer(v, ROOM)],
      ['a transfer', xf, (v: unknown) => asXf(v, ROOM)],
      ['a do: record', offer, (v: unknown) => asDo(doKey(offer.nonce), v, ROOM)],
    ] as const) {
      expect(canon(pad(clean, many)), `${what}: the same record to canon`).toBe(canon(clean));
      expect(weightOf(pad(clean, many), MAX_SMALL_RECORD_BYTES), what).toBeNull();
      expect(read(clean), `${what}, clean`).not.toBeNull();
      expect(read(pad(clean, 3)), `${what}, a little padding`).not.toBeNull();
      expect(read(pad(clean, many)), `${what}, past the cap`).toBeNull();
    }
    // the padding is the weighed total of the record, wherever it sits
    expect(asXf({ ...xf, o: pad(offer, many) }, ROOM), 'inside the offer of a transfer').toBeNull();
    expect(asXf({ ...xf, o: { ...offer, asset: pad(offer.asset, many) } }, ROOM), 'inside its asset').toBeNull();
    // ... and the cap is where the weight is: the most fields that fit are read, one more is junk
    let lo = 0;
    let hi = many;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (weightOf(pad(fin, mid), MAX_SMALL_RECORD_BYTES) === null) hi = mid - 1;
      else lo = mid;
    }
    expect(lo, 'the search found the edge').toBeGreaterThan(100);
    expect(lo).toBeLessThan(many);
    expect(asFin(pad(fin, lo)), 'the most that fit').not.toBeNull();
    expect(asFin(pad(fin, lo + 1)), 'one more').toBeNull();
  });

  it('never refuses an honest one: the heaviest a transfer can be weighs under 3 kB', () => {
    const longRoom = 'room-' + 'x'.repeat(200);
    const kanji = '漢'.repeat(MAX_OFFER_TEXT); // 256 units of 3 bytes
    const o = offerOf(owner, buyer, { makerName: kanji, asset: { kind: 'deed', roomId: longRoom, roomName: kanji } });
    const xf = sealXf(P, { v: 1, o, u: 2 ** 48, k: buyer.pub }, buyer.sign).value;
    const weight = weightOf(xf, MAX_SMALL_RECORD_BYTES) as number;
    expect(weight).toBeGreaterThan(1_500); // (two names of 768 bytes)
    expect(weight).toBeLessThan(3_000);
    expect(weight * 2, 'with room to spare').toBeLessThan(MAX_SMALL_RECORD_BYTES);
    expect(asXf(xf, longRoom)).not.toBeNull();
  });

  it('a do: record is a deed offer kept under its own nonce', () => {
    expect(asDo(doKey(offer.nonce), offer, ROOM)).toEqual(offer);
    expect(asDo(doKey(hex('9', 24)), offer, ROOM)).toBeNull();
    expect(asDo(`sum:${T}:${P.inc}`, offer, ROOM)).toBeNull();
    expect(asDo(doKey(offer.nonce), { ...offer, price: 1 }, ROOM)).toBeNull();
    expect(asDo(doKey(offer.nonce), offer, 'room-other')).toBeNull();
  });
});

describe('reading a checkpoint (S0)', () => {
  const roots = { p: rootOf(P, 'p'), q: rootOf(Q, 'q') };
  const trims = { p: trimOf(P, 'p'), q: trimOf(Q, 'q') };

  it('reads the opening root, a house trim, a void trim', () => {
    for (const [letter, ctx] of [['p', P], ['q', Q]] as const) {
      const root = read(ctx, roots[letter]);
      expect(root).toMatchObject({ kind: 'ok', t: T, inc: ctx.inc, letter, ck: roots[letter].value });
      const trim = read(ctx, trims[letter]);
      expect(trim).toMatchObject({ kind: 'ok', letter, ck: trims[letter].value });
      const voided = trimOf(ctx, letter, { d: `z:${hex('c', 32)}`, o: undefined });
      expect(read(ctx, voided).kind).toBe('ok');
    }
  });

  it('reads a sweep of the root, a sweep after a round, an end of the root, an end after a round, an adoption', () => {
    for (const [letter, ctx] of [['p', P], ['q', Q]] as const) {
      const root = roots[letter].value;
      const trim = trims[letter].value;
      const fin = sealFin(ctx, owner.pub, owner.sign).value;
      const rootSweep = rootOf(ctx, letter, { b: nextSid3(ctx, root), w: 1, dl: DL_HOUSE, k: house.pub });
      // (a sweep is the house's: signed by it, not the root's owner)
      const sweepRoot = changed(ctx, rootSweep, { k: house.pub, dl: DL_HOUSE });
      expect(read(ctx, sweepRoot).kind, 'sweep of the root').toBe('ok');
      expect(read(ctx, trimOf(ctx, letter, { b: nextSid3(ctx, trim), w: 1 })).kind, 'sweep').toBe('ok');
      const endRoot = changed(ctx, rootOf(ctx, letter), { b: nextSid3(ctx, root), e: 1, f: fin, k: owner.pub, dl: undefined, s: undefined });
      expect(read(ctx, endRoot).kind, 'end of the root').toBe('ok');
      const end = trimOf(ctx, letter, { b: nextSid3(ctx, trim), e: 1, f: fin, s: undefined, h: undefined, k: owner.pub, dl: undefined });
      expect(read(ctx, end).kind, 'end').toBe('ok');
      const xf = sealXf(ctx, { v: 1, o: offerOf(owner, buyer), u: trim.u, k: buyer.pub }, buyer.sign).value;
      const adoption = trimOf(ctx, letter, { k: buyer.pub, dl: undefined, x: [xf] });
      expect(read(ctx, adoption).kind, 'adoption').toBe('ok');
    }
  });

  it('refuses a key that is not a checkpoint key, and a value that is no plain object', () => {
    const { key, value } = trims.p;
    for (const bad of [finKey(T, P.inc), xfKey(T, P.inc, hex('1', 32)), doKey(hex('1', 24)), `sum:${T}:${P.inc}`, `ck:${T}:${P.inc}`, '']) {
      expect(readCk(ROOM, bad, value), bad).toEqual({ kind: 'junk' });
    }
    for (const bad of [null, 7, 'x', [], [value], new Map()]) expect(readCk(ROOM, key, bad)).toEqual({ kind: 'junk' });
  });

  it('is junk when its id is not the hash of its value, or the key sits under another table, incarnation or room', () => {
    const { key, value } = trims.p;
    expect(readCk(ROOM, ckKey(T, P.inc, hex('f', 32)), value).kind).toBe('junk');
    expect(readCk(ROOM, key, { ...value, n: { alice: '26', bob: '-26' } }).kind).toBe('junk');
    expect(readCk(ROOM, key, { ...value, g: 'A'.repeat(86) }).kind).toBe('junk');
    expect(readCk(ROOM, ckKey('roulette-2', P.inc, ckId(value) as string), value).kind).toBe('junk');
    expect(readCk(ROOM, ckKey(T, Q.inc, ckId(value) as string), value).kind).toBe('junk');
    expect(readCk('room-other', key, value).kind).toBe('junk');
  });

  it('is junk when the name is not the hash of the record\'s ok, j, rv, ts', () => {
    for (const patch of [{ ok: buyer.pub }, { j: hex('9', 16) }, { ts: NAME.ts + 1 }]) {
      const c = changed(P, trims.p, patch);
      expect(readCk(ROOM, c.key, c.value), JSON.stringify(patch)).toEqual({ kind: 'junk' });
    }
    // A record cannot claim another authority for the same name: the owner's
    // root, re-signed by a stranger who made itself `ok`, belongs to another name.
    const stranger = testIdentity('fo-stranger');
    const forged = changed(P, roots.p, { ok: stranger.pub, k: stranger.pub, dl: delegation(stranger, house.pub) });
    expect(readCk(ROOM, forged.key, forged.value).kind).toBe('junk');
    const own = { ...NAME, ok: stranger.pub };
    const sctx = { room: ROOM, t: T, inc: faironlyInc('p', ROOM, T, own) };
    const sbody = { v: 1, ok: stranger.pub, j: own.j, rv: own.rv, ts: own.ts, b: 'g', u: 0, l: NO_CLOSE, n: {}, dl: delegation(stranger, house.pub), k: stranger.pub };
    expect(readCk(ROOM, sealCk(sctx, sbody as unknown as Omit<CkRec, 'g'>, stranger.sign).key, sealCk(sctx, sbody as unknown as Omit<CkRec, 'g'>, stranger.sign).value).kind).toBe('ok');
  });

  it('a rules version this build does not know reads as newer, if the name still holds', () => {
    const name2 = { ...NAME, rv: 'f2' };
    const ctx2 = ctxOf('p', T, name2);
    const root2 = sealCk(ctx2, { ...roots.p.value, rv: 'f2', g: undefined } as unknown as Omit<CkRec, 'g'>, owner.sign);
    expect(readCk(ROOM, root2.key, root2.value)).toEqual({ kind: 'newer', t: T, inc: ctx2.inc, rv: 'f2' });
    // ... even for a record that has fields this build knows nothing of,
    expect(readCk(ROOM, ckKey(T, ctx2.inc, hex('0', 32)), { ...root2.value, brandNew: 1 }).kind).toBe('newer');
    // ... but not when the name does not hold, or the rest of the name is no name.
    expect(readCk(ROOM, ckKey(T, P.inc, hex('0', 32)), root2.value).kind).toBe('junk');
    expect(readCk(ROOM, root2.key, { ...root2.value, j: 'nope' }).kind).toBe('junk');
    expect(readCk(ROOM, root2.key, { ...root2.value, rv: 'F2!' }).kind).toBe('junk');
  });

  it('is junk when a name input is of no form, though the name is the hash of exactly what the record says', () => {
    // A writer who owns the name can make a key that matches any inputs; only their form can refuse these.
    // (Inputs canon refuses, such as a float, can't even be keyed to match.)
    const withName = (letter: FairOnlyLetter, inputs: Record<string, unknown>) => {
      const ctx: FoldCtx = { room: ROOM, t: T, inc: faironlyInc(letter, ROOM, T, { ...NAME, ...inputs } as FairOnlyName) };
      return { ctx, c: trimOf(ctx, letter, inputs) };
    };
    for (const letter of ['p', 'q'] as const) {
      const control = withName(letter, {});
      expect(read(control.ctx, control.c).kind, 'the unchanged name').toBe('ok');
      const bad: Record<string, unknown[]> = {
        ok: ['short', '', 5, 'A'.repeat(42) + '+', 'A'.repeat(44)],
        j: [5, '', 'xyz', hex('a', 15), hex('a', 17), hex('A', 16), `${hex('a', 15)}g`, [NAME.j]],
        rv: [7, '', 'F1', '1f', 'f1 ', 'f'.repeat(9), 'f-1', ['f1']],
        ts: [-1, '17'],
      };
      for (const [field, values] of Object.entries(bad)) {
        for (const value of values) {
          const { ctx, c } = withName(letter, { [field]: value });
          expect(read(ctx, c), `${letter} ${field} ${JSON.stringify(value)}`).toEqual({ kind: 'junk' });
        }
      }
    }
    // ... and the longest rules version and a zero start are fine.
    for (const inputs of [{ rv: 'f'.repeat(8) }, { rv: 'a1b2c3d4' }, { ts: 0 }, { ts: Number.MAX_SAFE_INTEGER }]) {
      const { ctx, c } = withName('p', inputs);
      expect(read(ctx, c).kind, JSON.stringify(inputs)).toMatch(/^(ok|newer)$/);
    }
  });

  it('weighs a record before it reads its rules version, so no newer record is a heavy thing to hold', () => {
    const ctx2 = ctxOf('p', T, { ...NAME, rv: 'f2' });
    const root2 = sealCk(ctx2, { ...roots.p.value, rv: 'f2', g: undefined } as unknown as Omit<CkRec, 'g'>, owner.sign);
    expect(readCk(ROOM, root2.key, root2.value).kind).toBe('newer');
    expect(readCk(ROOM, root2.key, { ...root2.value, pad: 'x'.repeat(MAX_CHECKPOINT_BYTES) })).toEqual({ kind: 'junk' });
  });

  it('refuses a value past the weight cap without hashing it', () => {
    const { key, value } = trims.p;
    const heavy = { ...value, pad: 'x'.repeat(MAX_CHECKPOINT_BYTES) };
    expect(readCk(ROOM, key, heavy)).toEqual({ kind: 'junk' });
  });

  it('weighs the padding of undefined fields, so a record padded past the cap is junk, and a little of it is the same record', () => {
    const { key, value } = trims.p;
    const padded = { ...value, pad0: undefined, pad1: undefined };
    expect(ckId(padded), 'canon leaves them out: the same record').toBe(ckId(value));
    expect(readCk(ROOM, key, padded).kind).toBe('ok');
    const fat: Record<string, unknown> = { ...value };
    for (let i = 0; i < 100_000; i++) fat[`pad${i}`] = undefined;
    expect(ckId(fat)).toBe(ckId(value));
    expect(readCk(ROOM, key, fat)).toEqual({ kind: 'junk' });
  });

  /** A craps game at the most the fold lets one be: `n` players, the fullest carry, and 8 transfers of the longest names. */
  const fullest = (pids: string[]) => {
    const room = 'r'.repeat(200);
    const ctx: FoldCtx = { room, t: T, inc: faironlyInc('q', room, T, NAME) };
    const n: Record<string, string> = {};
    for (const pid of pids) n[pid] = `-${'9'.repeat(39)}`;
    // The carry: 31 riders (long ids) with a felt on each of the 49 spots, the most chips a felt holds.
    const spots = [
      ...['pass', 'dontpass', 'come', 'dontcome', 'field', 'big6', 'big8', 'anyseven', 'anycraps', 'two', 'three', 'yo', 'twelve', 'passodds', 'dontpassodds'].map((type) => ({ type })),
      ...[4, 5, 6, 8, 9, 10].flatMap((pick) => ['place', 'comeodds', 'dontcomeodds', 'come', 'dontcome'].map((type) => ({ type, pick }))),
      ...[4, 6, 8, 10].map((pick) => ({ type: 'hard', pick })),
    ];
    const key = (b: { type: string; pick?: number }) => `${b.type}:${(b as { pick?: number }).pick ?? ''}`;
    const felt = spots.map((b) => ({ ...b, amount: 20_000_000_000 })).sort((a, b) => (key(a) < key(b) ? -1 : 1));
    const w: Record<string, unknown> = {};
    for (let i = 0; i < 31; i++) w[`${i}`.padStart(2, '0') + '漢'.repeat(127)] = felt;
    const xfs = Array.from({ length: MAX_TRANSFERS }, (_, i) => sealXf(ctx, {
      v: 1, k: buyer.pub, u: 3,
      o: offerOf(owner, buyer, { asset: { kind: 'deed', roomId: room, roomName: '漢'.repeat(MAX_OFFER_TEXT) }, makerName: '漢'.repeat(MAX_OFFER_TEXT), nonce: `${i}`.padStart(24, '0') }),
    }, buyer.sign).value);
    const c = trimOf(ctx, 'q', { n, s: { p: 6, w, h: 'p'.repeat(128), a: 'a'.repeat(128) }, x: xfs, k: buyer.pub, dl: undefined });
    return { room, c, weight: weightOf(c.value, Number.MAX_SAFE_INTEGER) as number };
  };
  const bytesOf = (s: string) => utf8ToBytes(s).length;

  it('is no heavier than the cap at the most the fold lets a game be: players whose ids total MAX_TABLE_PID_BYTES, riders, 8 transfers', () => {
    // 4,000 players of 250 bytes of ids (the most players), and as many 256-unit ids of 3-byte characters as the bytes allow (the longest ids).
    const many = Array.from({ length: MAX_TABLE_PIDS }, (_, i) => String(i).padStart(4, '0') + '漢'.repeat(82));
    expect(many.reduce((sum, pid) => sum + bytesOf(pid), 0)).toBe(MAX_TABLE_PID_BYTES);
    const longest = Array.from({ length: Math.floor(MAX_TABLE_PID_BYTES / 768) }, (_, i) => String.fromCharCode(0x4e00 + i) + '漢'.repeat(255));
    expect(longest.every((pid) => pid.length === 256 && bytesOf(pid) === 768)).toBe(true);
    for (const pids of [many, longest]) {
      const { room, c, weight } = fullest(pids);
      expect(weight).toBeGreaterThan(1_100_000);
      expect(weight).toBeLessThan(1_400_000);
      expect(weight).toBeLessThan(MAX_CHECKPOINT_BYTES);
      expect(readCk(room, c.key, c.value).kind).toBe('ok');
    }
  });

  it('is past the cap with ids past that, which is why the fold limits their bytes', () => {
    // 4,000 players of 256 characters of 3 bytes: what the fold's count alone would allow.
    const wide = Array.from({ length: MAX_TABLE_PIDS }, (_, i) => String.fromCharCode(0x4e00 + i) + '漢'.repeat(255));
    const { room, c, weight } = fullest(wide);
    expect(weight).toBeGreaterThan(MAX_CHECKPOINT_BYTES);
    expect(readCk(room, c.key, c.value)).toEqual({ kind: 'junk' });
  });

  /** One rule at a time: `patch` laid over a good record of `letter` (and the
   *  record unchanged is read, so the refusal is the patch's). */
  const refuses = (letter: FairOnlyLetter, why: string, patch: Record<string, unknown>, base: 'trim' | 'root' = 'trim'): void => {
    const ctx = letter === 'p' ? P : Q;
    const good = base === 'trim' ? trims[letter] : roots[letter];
    expect(read(ctx, good).kind, `${why}: the unchanged record`).toBe('ok');
    const c = changed(ctx, good, patch);
    expect(read(ctx, c), why).toEqual({ kind: 'junk' });
  };

  it('refuses a wrong format, an unknown field, a bad key or signature', () => {
    refuses('p', 'v 2', { v: 2 });
    refuses('p', 'unknown field', { extra: 1 });
    refuses('p', 'k short', { k: 'short' });
    refuses('p', 'g short', { g: 'short' });
    refuses('p', 'a field undefined is absent, so a required one cannot be', { n: undefined });
  });

  it('refuses a round that is not a safe integer in range', () => {
    for (const u of [-1, 1.5, NaN, Infinity, 2 ** 48 + 1, '3', null]) refuses('p', `u ${String(u)}`, { u });
    expect(read(P, changed(P, trims.p, { u: 2 ** 48 })).kind).toBe('ok');
  });

  it('b is g only on the root, else a session id', () => {
    refuses('p', 'b g after a round', { b: 'g' });
    refuses('p', 'b g after a round, signed as a root is', { b: 'g', k: owner.pub, dl: DL_HOUSE });
    refuses('p', 'b short', { b: hex('a', 23) });
    refuses('p', 'b upper', { b: hex('A', 24) });
    refuses('p', 'b 32 hex', { b: hex('a', 32) });
    refuses('p', 'root with a session id', { b: hex('a', 24) }, 'root');
    refuses('p', 'u > 0 on the root', { u: 1 }, 'root');
  });

  it('l is the no-close value at u = 0 and a close after', () => {
    refuses('p', 'no close after a round', { l: NO_CLOSE });
    refuses('p', 'l short', { l: hex('b', 31) });
    refuses('p', 'a close at the root', { l: hex('b', 32) }, 'root');
  });

  it('d is there exactly after a round, and says a house reveal or an abandon', () => {
    refuses('p', 'no d after a round', { d: undefined, o: undefined });
    refuses('p', 'd at the root', { d: `h:${hex('c', 32)}` }, 'root');
    for (const d of [`r`, `r:${hex('c', 32)}`, `f:${hex('c', 32)}`, `h:${hex('c', 31)}`, `H:${hex('c', 32)}`, `h:${hex('C', 32)}`, hex('c', 32), `h${hex('c', 32)}`, 5]) refuses('p', `d ${String(d)}`, { d, o: undefined });
  });

  it('o is a pocket or the dice, only after a house reveal', () => {
    refuses('p', 'o without d... (an abandon)', { d: `z:${hex('c', 32)}` });
    for (const o of [-1, 37, 1.5, '17', [17], [1, 2], null]) refuses('p', `roulette o ${JSON.stringify(o)}`, { o });
    for (const o of [0, 7, [0, 3], [3, 7], [3, 4, 5], [3], 1.5, [3, 4.5]]) refuses('q', `craps o ${JSON.stringify(o)}`, { o });
    refuses('q', 'craps o a number', { o: 4 });
    expect(read(P, changed(P, trims.p, { o: 0 })).kind).toBe('ok');
    expect(read(P, changed(P, trims.p, { o: 36 })).kind).toBe('ok');
    expect(read(Q, changed(Q, trims.q, { o: [1, 6] })).kind).toBe('ok');
    expect(read(P, changed(P, trims.p, { o: undefined })).kind).toBe('ok');
  });

  it('n is nets by player, none before a round, at most 4,000 players', () => {
    refuses('p', 'n an array', { n: [] });
    refuses('p', 'n zero net', { n: { alice: '0' } });
    refuses('p', 'n leading zero', { n: { alice: '05' } });
    refuses('p', 'n a number', { n: { alice: 5 } });
    refuses('p', 'n 41 digits', { n: { alice: '1'.repeat(41) } });
    refuses('p', 'n empty pid', { n: { '': '5' } });
    refuses('p', 'n pid too long', { n: { ['a'.repeat(257)]: '5' } });
    refuses('p', 'n at the root', { n: { alice: '5' } }, 'root');
    const many: Record<string, string> = {};
    for (let i = 0; i < 4_001; i++) many[`p${i}`] = '1';
    refuses('p', '4,001 players', { n: many });
    delete many.p0;
    expect(read(P, changed(P, trims.p, { n: many })).kind).toBe('ok');
  });

  it('w counts sweeps from 1, and an end has none', () => {
    for (const w of [0, -1, 1.5, '1', null]) refuses('p', `w ${String(w)}`, { w });
    expect(read(P, changed(P, trims.p, { w: 7 })).kind).toBe('ok');
    refuses('p', 'w on the root', { w: 1 }, 'root');
  });

  it('e is 1 or absent; a live record is not made one by another value', () => {
    for (const e of [0, 2, -1, true, false, null, '1', [1]]) refuses('p', `live record with e ${JSON.stringify(e)}`, { e });
  });

  it('a root is never an end, and an authority\'s key has the form of a key', () => {
    const fin = sealFin(P, owner.pub, owner.sign).value;
    refuses('p', 'a root that is an end', { e: 1, f: fin }, 'root');
    const qfin = sealFin(Q, owner.pub, owner.sign).value;
    refuses('q', 'a craps root that is an end', { e: 1, f: qfin, s: undefined }, 'root');
    const xf = sealXf(P, { v: 1, o: offerOf(owner, buyer), u: 3, k: buyer.pub }, buyer.sign).value;
    const end = trimOf(P, 'p', { e: 1, f: fin, h: undefined, k: owner.pub, dl: undefined });
    const adoption = trimOf(P, 'p', { k: buyer.pub, dl: undefined, x: [xf] });
    for (const good of [end, adoption]) {
      expect(read(P, good).kind).toBe('ok');
      for (const k of ['short', '', 5, null, 'A'.repeat(42) + '+']) expect(read(P, changed(P, good, { k })), `k ${JSON.stringify(k)}`).toEqual({ kind: 'junk' });
    }
  });

  it('an end carries the end order, and no craps carry, commitment or sweep', () => {
    const fin = sealFin(P, owner.pub, owner.sign).value;
    const end = trimOf(P, 'p', { e: 1, f: fin, h: undefined, k: owner.pub, dl: undefined });
    expect(read(P, end).kind).toBe('ok');
    const refusesEnd = (why: string, patch: Record<string, unknown>) => expect(read(P, changed(P, end, patch)), why).toEqual({ kind: 'junk' });
    refusesEnd('e 2', { e: 2 });
    refusesEnd('e true', { e: true });
    refusesEnd('e without f', { f: undefined });
    refusesEnd('f short', { f: { ...fin, k: 'short' } });
    refusesEnd('f extra field', { f: { ...fin, r: 4 } });
    refusesEnd('end with h', { h: hex('d', 64) });
    refusesEnd('end with w', { w: 1 });
    refusesEnd('end with s', { s: OPENING_CARRY });
    refuses('p', 'f without e', { f: fin });
    const qfin = sealFin(Q, owner.pub, owner.sign).value;
    const qend = trimOf(Q, 'q', { e: 1, f: qfin, h: undefined, s: undefined, k: owner.pub, dl: undefined });
    expect(read(Q, qend).kind).toBe('ok');
    expect(read(Q, changed(Q, qend, { s: { p: 6, w: {} } })), 'craps end with s').toEqual({ kind: 'junk' });
  });

  it('a craps game carries its roll state while live, a roulette game never does', () => {
    refuses('q', 'craps live without s', { s: undefined });
    for (const s of [{ p: 7, w: {} }, { p: 6 }, { p: 6, w: [] }, { p: 6, w: {}, extra: 1 }, 'x', null, [], { p: 6, w: { alice: [] } }]) refuses('q', `craps s ${JSON.stringify(s)}`, { s });
    refuses('p', 'roulette with s', { s: OPENING_CARRY });
    expect(read(Q, changed(Q, trims.q, { s: { p: 0, w: {} } })).kind).toBe('ok');
  });

  it('a player or a rider named by an unpaired surrogate is refused, a pair is a character', () => {
    // Yjs writes strings as UTF-8, so a peer reads U+FFFD where the page that wrote the record holds the
    // surrogate, and the record's id and signature fail there (the next spec shows it).
    const lone = ['\ud800', 'al\ud800ice', '\udc00', 'a\udc00', '\udc00\ud800', '😀\ud83d', '\ud83d😀\ude00', '\udbff', '\udfff', 'a\udfff'];
    for (const pid of lone) {
      for (const letter of ['p', 'q'] as const) refuses(letter, `a net for ${JSON.stringify(pid)}`, { n: { [pid]: '25', bob: '-25' } });
    }
    for (const pid of ['😀', 'a😀b', '퟿', '𐀀', '😀😀']) {
      for (const [letter, ctx] of [['p', P], ['q', Q]] as const) {
        expect(read(ctx, changed(ctx, trims[letter], { n: { [pid]: '25', bob: '-25' } })).kind, JSON.stringify(pid)).toBe('ok');
      }
    }
    // The craps carry names players too: its riders, the shooter and the last shooter.
    const pass = [{ type: 'pass', amount: 1 }];
    const carry = (patch: Record<string, unknown>) => ({ p: 6, w: { alice: pass }, h: 'alice', a: 'bob', ...patch });
    expect(read(Q, changed(Q, trims.q, { s: carry({}) })).kind, 'the carry unchanged').toBe('ok');
    for (const pid of lone) {
      refuses('q', `a rider ${JSON.stringify(pid)}`, { s: carry({ w: { [pid]: pass } }) });
      refuses('q', `a shooter ${JSON.stringify(pid)}`, { s: carry({ h: pid }) });
      refuses('q', `a last shooter ${JSON.stringify(pid)}`, { s: carry({ a: pid }) });
    }
    for (const pid of ['😀', 'a😀b']) {
      expect(read(Q, changed(Q, trims.q, { s: carry({ w: { [pid]: pass }, h: pid, a: pid }) })).kind, JSON.stringify(pid)).toBe('ok');
    }
  });

  it('refuses it because a peer reads U+FFFD there and the record\'s id and signature fail', () => {
    // What the page that wrote the record holds: it is whole where it was made.
    const bad = trimOf(P, 'p', { n: { 'al\ud800ice': '25', bob: '-25' } });
    expect(bad.key).toBe(ckKey(T, P.inc, ckId(bad.value) as string));
    expect(verifyIdentityStrict(house.pub, signBytes('ck', P, bad.value), bad.value.g)).toBe(true);
    const a = new Y.Doc();
    a.getMap('m').set('v', bad.value);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const got = b.getMap('m').get('v') as CkRec;
    expect(Object.keys(got.n)).toEqual(['al�ice', 'bob']);
    // ... but not on the peer: another id, and the house's signature does not cover what it reads.
    expect(ckId(got)).not.toBe(ckId(bad.value));
    expect(verifyIdentityStrict(house.pub, signBytes('ck', P, got), got.g)).toBe(false);
    // So every peer reads it as junk, and now so does the page that wrote it: they agree.
    expect(readCk(ROOM, bad.key, got)).toEqual({ kind: 'junk' });
    expect(readCk(ROOM, bad.key, bad.value)).toEqual({ kind: 'junk' });
  });

  it('a field left undefined is no field in the opening carry or the nets, as in the record\'s id', () => {
    for (const s of [{ p: 0, w: {}, h: undefined }, { p: 0, w: {}, a: undefined, i: undefined }]) {
      const c = changed(Q, roots.q, { s });
      expect(ckId(c.value), 'the root\'s own id').toBe(ckId(roots.q.value));
      expect(read(Q, c).kind, JSON.stringify(s)).toBe('ok');
    }
    // (a rider whose felt is undefined is a rider, and no felt: that is isCarry's, as at every table)
    refuses('q', 'a rider with no felt', { s: { p: 0, w: { alice: undefined } } }, 'root');
    for (const [letter, ctx, root] of [['p', P, roots.p], ['q', Q, roots.q]] as const) {
      const c = changed(ctx, root, { n: { alice: undefined } });
      expect(ckId(c.value)).toBe(ckId(root.value));
      expect(read(ctx, c).kind, `${letter} root with a net left undefined`).toBe('ok');
      expect(read(ctx, changed(ctx, trims[letter], { n: { alice: undefined } })).kind, `${letter} trim with the only net left undefined`).toBe('ok');
    }
    refuses('p', 'a net of no form among the undefined', { n: { alice: undefined, bob: '0' } });
  });

  it('the opening state is the opening carry, and no commitment yet', () => {
    refuses('q', 'root with a point', { s: { p: 6, w: {} } }, 'root');
    refuses('q', 'root with riders', { s: { p: 0, w: { alice: [{ type: 'pass', amount: 1 }] } } }, 'root');
    refuses('q', 'root with h in the carry', { s: { p: 0, w: {}, h: 'alice' } }, 'root');
    refuses('p', 'root with h', { h: hex('d', 64) }, 'root');
    refuses('p', 'h short', { h: hex('d', 63) });
    refuses('p', 'h upper', { h: hex('D', 64) });
  });

  it('dl names the signer as a house after the root, and the owner\'s house on it', () => {
    refuses('p', 'dl by the signer, for another house', { dl: delegation(owner, buyer.pub) });
    refuses('p', 'dl malformed', { dl: { ...DL_HOUSE, h: 'short' } });
    refuses('p', 'dl extra field', { dl: { ...DL_HOUSE, extra: 1 } });
    refuses('p', 'dl not an object', { dl: 'x' });
    refuses('p', 'root without dl', { dl: undefined }, 'root');
    refuses('p', 'root dl by someone else', { dl: delegation(buyer, house.pub) }, 'root');
    refuses('p', 'root signed by another key', { k: buyer.pub }, 'root');
    expect(read(P, changed(P, trims.p, { dl: undefined })).kind, 'no dl: an authority signs').toBe('ok');
    // (a delegation is a few short fields: padded past the small-record cap it is junk, wherever the checkpoint carries it)
    const padded = { ...DL_HOUSE, ...Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`pad${i}`, undefined])) };
    expect(read(P, changed(P, trims.p, { dl: { ...DL_HOUSE, pad0: undefined } })).kind, 'a little padding is the same delegation').toBe('ok');
    expect(weightOf(padded, MAX_SMALL_RECORD_BYTES)).toBeNull();
    refuses('p', 'dl padded past the small-record cap', { dl: padded });
  });

  it('x is a chain of at most 8 whole transfers, and the root has none', () => {
    const xf = sealXf(P, { v: 1, o: offerOf(owner, buyer), u: 3, k: buyer.pub }, buyer.sign).value;
    const xfs = (n: number): XferRec[] => Array.from({ length: n }, (_, i) => sealXf(P, { v: 1, o: offerOf(owner, buyer, { nonce: `${i}`.padStart(24, '0') }), u: 3, k: buyer.pub }, buyer.sign).value);
    expect(read(P, changed(P, trims.p, { x: [xf] })).kind).toBe('ok');
    expect(read(P, changed(P, trims.p, { x: xfs(MAX_TRANSFERS) })).kind).toBe('ok');
    refuses('p', `${MAX_TRANSFERS + 1} transfers`, { x: xfs(MAX_TRANSFERS + 1) });
    refuses('p', 'no transfers', { x: [] });
    refuses('p', 'x an object', { x: xf });
    refuses('p', 'x entry with an offer to someone else', { x: [{ ...xf, k: owner.pub }] });
    refuses('p', 'x entry for another room', { x: [{ ...xf, o: { ...xf.o, asset: { kind: 'deed', roomId: 'room-other', roomName: 'n' } } }] });
    refuses('p', 'x entry junk', { x: [{ ...xf, u: -1 }] });
    refuses('p', 'x entry padded past the small-record cap', { x: [{ ...xf, ...Object.fromEntries(Array.from({ length: 2_000 }, (_, i) => [`pad${i}`, undefined])) }] });
    refuses('p', 'x on the root', { x: [xf] }, 'root');
  });

  it('after the root at u = 0 only a sweep or an end is a checkpoint', () => {
    const plain = changed(P, roots.p, { b: nextSid3(P, roots.p.value), k: house.pub });
    expect(read(P, plain), 'a second root-like record').toEqual({ kind: 'junk' });
    expect(read(P, changed(P, roots.p, { b: nextSid3(P, roots.p.value), k: house.pub, w: 1 })).kind).toBe('ok');
    const fin = sealFin(P, owner.pub, owner.sign).value;
    expect(read(P, changed(P, roots.p, { b: nextSid3(P, roots.p.value), e: 1, f: fin, dl: undefined })).kind).toBe('ok');
  });

  it('a record of a game is read at that game\'s letter only', () => {
    // a craps checkpoint (with s) under a roulette name, and the reverse
    const asP = changed(P, trims.q, { s: trims.q.value.s });
    expect(readCk(ROOM, asP.key, asP.value)).toEqual({ kind: 'junk' });
    const asQ = changed(Q, trims.p, {});
    expect(readCk(ROOM, asQ.key, asQ.value)).toEqual({ kind: 'junk' });
  });
});
