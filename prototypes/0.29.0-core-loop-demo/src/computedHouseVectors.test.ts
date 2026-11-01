/**
 * 🏠🧪 The house's bytes, pinned for the node.
 *
 * The owner's node (ssf-p2p-node house.rs) reads a house table's records and
 * writes the house's own, so it must compute what the pages compute, byte
 * for byte: canonical JSON, record hashes, the signed bytes of every kind,
 * session ids, close ranks, commitments, and its own key, seeds and
 * signatures. test-vectors/computed-house-v1.json holds those, made here;
 * this file checks the TypeScript side against it, and house.rs's tests
 * check the Rust side against the same file.
 *
 * To write it again — only on purpose, when the bytes are meant to change
 * (and the node with them) — run this file with VECTORS_WRITE=1 and review
 * the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  asCheckpointFor, asClose, asForfeit, asSlipFor, canon, closeKey, dutyRank, houseCommitKey, houseCommitOf, houseRevealKey, nextSid,
  recHash, signBytes, slipCommit,
} from './computedFold';
import { computedCfgInc } from './casinoDoc';
import { MAX_FELT_STAKE } from './computedCraps';
import type { Checkpoint, FoldCtx, HouseCommitRec, HouseRevealRec, SignedKind } from './computedFold';
import {
  asBeat, asDelegation, asFairSetting, beatKey, delegationKey, fairSettingKey, housePubOf, houseSeedOf, houseSign, roomSignBytes,
} from './computedHouse';
import type { BeatRec, DelegationRec, FairSettingRec, RoomKind } from './computedHouse';
import { ComputedKit, testIdentity } from './computedTestKit';
import { verifyIdentityStrict } from './keypair';

const FILE = new URL('../test-vectors/computed-house-v1.json', import.meta.url);

const CTX: FoldCtx = { room: 'room-test', t: 'roulette-1', inc: 'r0123456789abcdef01234567' };
const CRAPS_CTX: FoldCtx = { room: 'room-test', t: 'craps:1', inc: 'd0123456789abcdef01234567' };

/** Node secrets: sha256('ssf-house-vector-node|<name>'). */
const nodeSecret = (name: string): Uint8Array => sha256(utf8ToBytes(`ssf-house-vector-node|${name}`));

function canonCases(): { value: unknown; canon: string | null; hash: string | null }[] {
  const values: unknown[] = [
    'plain', '', 'quote " backslash \\ slash /', 'controls \u0000\u0001\b\t\n\u000b\f\r\u001f\u007f', 'line   sep  ',
    'unicode é ü 😀 ﬀ', 0, 7, -12, 9007199254740991, -9007199254740991, 9007199254740992, 1.5, -0.25, true, null,
    [], [1, 'a', [2, []]], [1, null], {}, { b: 1, a: 2 }, { 'é': 1, z: 2, a: 3, '😀': 4, 'ﬀ': 5, 'Z': 6, '_': 7, '~': 8 },
    { a: { d: [1, 2], c: 'x' }, b: [] }, { a: true }, { a: 1.25 }, { a: [{ b: null }] },
    { r: 3, q: 'g', f: { alice: '0'.repeat(32) }, k: 'K'.repeat(43), g: 'G'.repeat(86) },
  ];
  return values.map((value) => {
    const c = canon(value);
    return { value, canon: c, hash: recHash(value) };
  });
}

/** Felts (a slip's `b`) and whether the fold takes a slip holding each
 *  (asSlipFor): house.rs felt_ok must say the same, or it would reveal a
 *  close no page counts. (Its caps on a felt's length, house.rs tests.) */
function feltCases(): { game: 'roulette' | 'craps'; b: unknown; ok: boolean }[] {
  const e = (type: unknown, amount: unknown, pick?: unknown) => ({ type, amount, ...(pick !== undefined ? { pick } : {}) });
  const roulette: unknown[] = [
    [], [e('red', 5)], [e('red', 25), e('straight', 5, 17)], [e('straight', 5, 0)], [e('straight', 5, 36)], [e('straight', 5, 37)],
    [e('straight', 5, -1)], [e('straight', 5)], [e('straight', 5, 1.5)], [e('dozen', 5, 2)], [e('dozen', 5, 3)], [e('column', 5, 0)],
    [e('red', 5, 1)], [e('red', 0)], [e('red', -5)], [e('red', 1_000_000_000)], [e('red', 1_000_000_001)], [e('red', 1.5)], [e('red', '5')],
    [e('purple', 5)], [e(5, 5)], [{ type: 'red', amount: 5, x: 1 }], [{ type: 'red' }], [null], ['red'], [[]], 'red', {},
  ];
  const craps: unknown[] = [
    [], [e('pass', 10)], [e('field', 5), e('pass', 10)], [e('pass', 10), e('field', 5)], [e('pass', 1), e('pass', 1)],
    [e('place', 5, 4)], [e('place', 5, 7)], [e('place', 5)], [e('place', 5, 10), e('place', 5, 4)], [e('place', 5, 4), e('place', 5, 10)],
    [e('hard', 5, 6)], [e('hard', 5, 5)], [e('come', 5)], [e('come', 5, 5)], [e('come', 5, 7)], [e('come', 5), e('come', 5, 4)],
    [e('come', 5, 4), e('come', 5)], [e('dontcome', 5, 10)], [e('comeodds', 5, 9)], [e('comeodds', 5)], [e('dontcomeodds', 5, 8)],
    [e('pass', 5, 4)], [e('pass', 0)], [e('pass', 1.5)], [e('pass', '5')], [e('pass', MAX_FELT_STAKE)], [e('pass', MAX_FELT_STAKE + 1)],
    [e('field', MAX_FELT_STAKE / 2), e('pass', MAX_FELT_STAKE / 2)], [e('field', MAX_FELT_STAKE / 2), e('pass', MAX_FELT_STAKE / 2 + 1)],
    [e('passodds', 5)], [e('purple', 5)], [e('red', 5)], [{ type: 'pass', amount: 1, x: 1 }], [{ type: 'pass' }], [null], 'pass',
  ];
  const slip = { r: 1, p: 'alice', v: 1, c: 'c'.repeat(64), k: 'K'.repeat(43), g: 'G'.repeat(86) };
  const read = (ctx: FoldCtx, b: unknown) => asSlipFor(ctx)({ ...slip, b, ...(ctx === CRAPS_CTX ? { o: 'a'.repeat(32) } : {}) }) !== null;
  return [
    ...roulette.map((b) => ({ game: 'roulette' as const, b, ok: read(CTX, b) })),
    ...craps.map((b) => ({ game: 'craps' as const, b, ok: read(CRAPS_CTX, b) })),
  ];
}

// ── The readers' verdicts (house.rs checkpoint_ok, forfeit_ids, close_frozen)

const K = 'K'.repeat(43);
const G = 'G'.repeat(86);
const H32 = 'ab'.repeat(16);
const H64 = 'cd'.repeat(32);
/** A players' table of each game: no house commitment there. */
const INC_PLAYERS_ROULETTE = 'c0123456789abcdef01234567';
const INC_PLAYERS_CRAPS = 'k0123456789abcdef01234567';

/** Player ids `p0`, `p1`, … */
const pids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, '0')}`);
/** `n` copies of `ch`. */
const rep = (ch: string, n: number): string => Array.from({ length: n }, () => ch).join('');

/** Checkpoints, and whether the pages take each (asCheckpointFor): the
 *  house must read the same ones, or it works in a session no page counts
 *  (or misses the one they do). */
function checkpointCases(): { inc: string; value: unknown; ok: boolean }[] {
  const base = { v: 1, b: 'g', u: 12, l: H32, n: { alice: '-35', bob: '120' }, k: K, g: G };
  const pass = [{ type: 'pass', amount: 10 }];
  const carry = { p: 6, w: { alice: pass }, h: 'alice', i: 1 };
  const live = (s: unknown) => ({ ...base, s });
  const riders = (n: number) => Object.fromEntries(pids(n).map((p) => [p, pass]));
  const roulette: unknown[] = [
    base, { ...base, e: 1 }, { ...base, h: H64 }, { ...base, e: 1, h: H64 }, { ...base, h: 'cd' }, { ...base, s: carry }, { ...base, v: 2 },
    { ...base, b: 'x' }, { ...base, b: '0123456789abcdef01234567' }, { ...base, u: 0 }, { ...base, u: 1.5 }, { ...base, l: 'ab' },
    { ...base, e: 2 }, { ...base, x: 1 }, { ...base, k: 'K' }, { ...base, g: 'G' },
    { ...base, n: {} }, { ...base, n: { alice: '0' } }, { ...base, n: { alice: '-0' } }, { ...base, n: { alice: '007' } },
    { ...base, n: { alice: 35 } }, { ...base, n: { alice: `1${'0'.repeat(39)}` } }, { ...base, n: { alice: `1${'0'.repeat(40)}` } },
    { ...base, n: { '': '5' } }, { ...base, n: { [rep('x', 256)]: '5' } }, { ...base, n: { [rep('x', 257)]: '5' } },
    { ...base, n: { [rep('😀', 128)]: '5' } }, { ...base, n: { [rep('😀', 129)]: '5' } }, { ...base, n: [] }, { ...base, n: 'alice' },
  ];
  const craps: unknown[] = [
    live(carry), live({ p: 0, w: {} }), { ...base, e: 1 }, { ...base, e: 1, s: carry }, base, live({ ...carry, h: undefined, i: undefined }),
    live({ ...carry, p: 7 }), live({ ...carry, p: '6' }), live({ ...carry, p: 6.5 }), live({ ...carry, p: 10 }), live({ ...carry, p: 3 }),
    live({ ...carry, w: { alice: [] } }), live({ ...carry, w: { alice: [{ type: 'pass', amount: 10 }, { type: 'field', amount: 5 }] } }),
    live({ ...carry, w: { alice: [{ type: 'field', amount: 5 }, { type: 'pass', amount: 10 }] } }),
    live({ ...carry, w: { alice: [{ type: 'pass', amount: 10, x: 1 }] } }), live({ ...carry, w: { alice: [{ type: 'red', amount: 10 }] } }),
    live({ ...carry, w: { alice: 'pass' } }), live({ ...carry, w: riders(31) }), live({ ...carry, w: riders(32) }),
    live({ ...carry, w: { '': pass } }), live({ ...carry, w: [] }), live({ p: 6, h: 'alice' }), live({ ...carry, w: { [rep('😀', 128)]: pass } }),
    live({ ...carry, h: rep('x', 128) }), live({ ...carry, h: rep('x', 129) }), live({ ...carry, h: rep('😀', 64) }),
    live({ ...carry, h: rep('😀', 65) }), live({ ...carry, h: '' }), live({ ...carry, h: 5 }), live({ ...carry, a: 'bob' }),
    live({ ...carry, a: rep('x', 129) }), live({ ...carry, a: rep('😀', 65) }), live({ ...carry, h: undefined }), live({ ...carry, i: 2 }),
    live({ ...carry, i: 0 }), live({ ...carry, q: 1 }), live('pass'), live([]), live({ p: 6 }), { ...live(carry), h: H64 },
  ];
  const at = (inc: string, values: unknown[]) => values.map((value) => ({ inc, value, ok: asCheckpointFor({ inc })(value) !== null }));
  return [
    ...at(CTX.inc, roulette),
    ...at(INC_PLAYERS_ROULETTE, [base, { ...base, h: H64 }, { ...base, e: 1 }]),
    ...at(CRAPS_CTX.inc, craps),
    ...at(INC_PLAYERS_CRAPS, [live(carry), { ...live(carry), h: H64 }, { ...base, e: 1 }]),
  ];
}

/** Forfeits whose fields are all good but `n`, and whether the pages take
 *  each (asForfeit): the ids strictly ascending as JS compares strings. */
function forfeitCases(): { value: unknown; ok: boolean }[] {
  const ns: unknown[] = [
    ['alice', 'bob'], ['bob', 'alice'], ['alice', 'alice'], [], ['alice'], pids(31), pids(32), ['Z', 'a'], ['a', 'Z'], ['é', 'z'], ['z', 'é'],
    // An astral pid against one in U+E000–U+FFFF: UTF-16 order is not code point (or UTF-8 byte) order.
    ['😀', '\uE000'], ['\uE000', '😀'], ['😀', '\uFFFD'], ['\uFFFD', '😀'], ['\uD7FF', '😀'], ['😀', '\uD7FF'], ['😀', '😁'],
    [''], ['__proto__'], [5], ['alice', null], 'alice', [rep('x', 257)],
  ];
  return ns.map((n) => {
    const value = { r: 3, x: H32, n, k: K, g: G };
    return { value, ok: asForfeit(value) !== null };
  });
}

/** Closes whose fields are all good but `f` (asClose). */
function closeCases(): { value: unknown; ok: boolean }[] {
  const fs: unknown[] = [
    { alice: H32 }, {}, Object.fromEntries(pids(31).map((p) => [p, H32])), Object.fromEntries(pids(32).map((p) => [p, H32])),
    { alice: 'ab' }, { alice: 5 }, { '': H32 }, [H32], { [rep('😀', 128)]: H32 }, { [rep('😀', 129)]: H32 },
  ];
  return fs.map((f) => {
    const value = { r: 3, q: 'g', f, k: K, g: G };
    return { value, ok: asClose(value) !== null };
  });
}

/** A value with an own field `__proto__` (as JSON.parse makes one; an
 *  object literal would set the prototype instead). */
const withProto = (o: Record<string, unknown>, proto: unknown): Record<string, unknown> =>
  Object.defineProperty({ ...o }, '__proto__', { value: proto, enumerable: true, writable: true, configurable: true });

type YjsKind = 'checkpoint' | 'close' | 'canon' | 'switch';
interface YjsCase {
  name: string; kind: YjsKind; inc: string; update: string; proto: boolean; unclear: boolean; refused: boolean;
  unknown: boolean; ok: boolean | null; canon: string | null; hash: string | null;
}

/** Whether `v` holds an own `__proto__` field anywhere. */
const holdsProto = (v: unknown): boolean => typeof v === 'object' && v !== null
  && ((!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '__proto__')) || Object.values(v).some(holdsProto));

/** Whether `v` holds an own `__proto__` field anywhere that is no object
 *  (null or a primitive): a page that meets it keeps no field, as the house
 *  reads it, unless the update held another `__proto__` field before it, an
 *  object, which the node, keeping one entry per key, can't see
 *  (house_bytes.rs Clarity::Proto). */
const holdsUnclear = (v: unknown): boolean => typeof v === 'object' && v !== null
  && ((!Array.isArray(v) && Object.prototype.hasOwnProperty.call(v, '__proto__')
    && (() => { const p = (v as Record<string, unknown>)['__proto__']; return p === null || typeof p !== 'object'; })())
    || Object.values(v).some(holdsUnclear));

/** `update` with each only written `from` (a key's bytes) turned into
 *  its `to`, as long. */
function renameAll(update: Uint8Array, renames: [string, string][]): Uint8Array {
  return renames.reduce((u, [from, to]) => rename(u, from, to), update);
}

/** `update` with the only written `from` (a key's bytes) turned into `to`,
 *  as long. */
function rename(update: Uint8Array, from: string, to: string): Uint8Array {
  const [a, b] = [new TextEncoder().encode(from), new TextEncoder().encode(to)];
  if (a.length !== b.length) throw new Error(`${from} → ${to}: not as long`);
  const hits = update.reduce<number[]>((at, _, i) => (a.every((x, j) => update[i + j] === x) ? [...at, i] : at), []);
  if (hits.length !== 1) throw new Error(`${from}: ${hits.length} times in the update`);
  const out = update.slice();
  out.set(b, hits[0]);
  return out;
}

/** `update` with the byte after the first `find` (a written string's
 *  bytes) set to 0xff, which no UTF-8 string holds. */
function spoil(update: Uint8Array, find: string): Uint8Array {
  const needle = new TextEncoder().encode(find);
  const at = update.findIndex((_, i) => needle.every((b, j) => update[i + j] === b));
  if (at < 0 || update.slice(at + 1).findIndex((_, i) => needle.every((b, j) => update[at + 1 + i + j] === b)) >= 0) {
    throw new Error(`${find}: not once in the update`);
  }
  const out = update.slice();
  out[at + 1] = 0xff;
  return out;
}

/** Values a peer can put in the doc but no JSON can hold: undefined
 *  entries, own `__proto__` fields and strings that aren't UTF-8. Each as
 *  the Yjs update that writes it (from client 1, so the bytes are the same
 *  each run), and what a page that received it reads: the reader's verdict,
 *  canon and recHash. The writer's own page reads the value as written;
 *  every other page reads what lib0 decodes (a `__proto__` field set as
 *  `o.__proto__ = v`), or refuses the whole update (a string that isn't
 *  UTF-8). The house reads each as a page that receives it does
 *  (house_bytes.rs CVal::from_any), and knows which a page may read
 *  otherwise (Clarity): one holding a `__proto__` field that is no object
 *  (a field of that name before it, an object, as in the update renamed
 *  into one, leaves a page junk) or one a page refuses. And the ones a page
 *  may read otherwise entirely (`unknown`): a typed array the update made
 *  the prototype before a key it keeps from being a field (dropped, or the
 *  update refused), which the node, keeping one entry per key, can't see. A
 *  switch with a `__proto__` field is one the node serves nothing under:
 *  a page counts it an own key or not as the update had it. */
function yjsCases(): YjsCase[] {
  const base = { v: 1, b: 'g', u: 12, l: H32, n: { alice: '-35' }, k: K, g: G };
  const pass = [{ type: 'pass', amount: 10 }];
  const carry = (w: unknown) => ({ ...base, s: { p: 6, w } });
  const close = (f: unknown) => ({ r: 3, q: 'g', f, k: K, g: G });
  const frozen = { alice: H32 };
  const toProto: [string, string] = ['aaaaaaaaa', '__proto__'];
  const sw = { v: 1, inc: CTX.inc };
  const cases: [string, YjsKind, string, unknown, string?, [string, string][]?, boolean?][] = [
    ['a checkpoint', 'checkpoint', CTX.inc, base],
    ['a net that is no UTF-8', 'checkpoint', CTX.inc, base, '-35'],
    ['a pid that is no UTF-8', 'checkpoint', CTX.inc, base, 'alice'],
    ['a net undefined', 'checkpoint', CTX.inc, { ...base, n: { alice: '-35', bob: undefined } }],
    ['a net named __proto__, a string', 'checkpoint', CTX.inc, { ...base, n: withProto({ alice: '-35' }, '5') }],
    ['a net named __proto__, an object', 'checkpoint', CTX.inc, { ...base, n: withProto({ alice: '-35' }, { x: '1' }) }],
    ['a net named __proto__, null', 'checkpoint', CTX.inc, { ...base, n: withProto({ alice: '-35' }, null) }],
    ['a net named __proto__, undefined', 'checkpoint', CTX.inc, { ...base, n: withProto({ alice: '-35' }, undefined) }],
    ['a field named __proto__, a string', 'checkpoint', CTX.inc, withProto(base, 'x')],
    ['a field named __proto__, an array', 'checkpoint', CTX.inc, withProto(base, ['x'])],
    ['a field undefined', 'checkpoint', CTX.inc, { ...base, e: undefined, x: undefined }],
    ['a frozen slip undefined', 'close', CTX.inc, close({ alice: H32, bob: undefined })],
    ['a frozen slip named __proto__, a string', 'close', CTX.inc, close(withProto({ alice: H32 }, H32))],
    ['a rider undefined', 'checkpoint', CRAPS_CTX.inc, carry({ alice: pass, bob: undefined })],
    ['a rider named __proto__, a felt', 'checkpoint', CRAPS_CTX.inc, carry(withProto({ alice: pass }, pass))],
    ['a rider named __proto__, a string', 'checkpoint', CRAPS_CTX.inc, carry(withProto({ alice: pass }, 'x'))],
    ['a felt entry with a field named __proto__', 'checkpoint', CRAPS_CTX.inc, carry({ alice: [withProto({ type: 'pass', amount: 10 }, 1)] })],
    ['a canon value named __proto__, a map', 'canon', '', withProto({ a: 1 }, { b: 2 })],
    ['a canon value named __proto__, a number', 'canon', '', withProto({ a: 1 }, 2)],
    ['an array entry undefined', 'canon', '', { a: [1, undefined] }],
    ['a field named __proto__ twice, an array then a string', 'checkpoint', CTX.inc, withProto({ ...base, aaaaaaaaa: ['x'] }, 'x'), undefined, [toProto]],
    ['a net named __proto__ twice, an object then undefined', 'checkpoint', CTX.inc, { ...base, n: withProto({ alice: '-35', aaaaaaaaa: { x: '1' } }, undefined) }, undefined, [toProto]],
    // A typed array as the prototype: a numeric key past its end is dropped,
    // and a later `__proto__: null` leaves a plain object without it.
    ['a close with __proto__ a buffer, a numeric field, then null', 'close', CTX.inc,
      withProto({ aaaaaaaaa: new Uint8Array(0), zqzqz: 'x', ...close(frozen) }, null), undefined, [toProto, ['zqzqz', '77777']], true],
    // …and writing one of its getters throws: the update is refused, and a
    // page keeps what was under the key before.
    ['a close with __proto__ a buffer, a length, then an object', 'close', CTX.inc,
      withProto({ aaaaaaaaa: new Uint8Array(0), length: 1, ...close(frozen) }, {}), undefined, [toProto], true],
    ['a close with __proto__ a buffer, a byteLength, then null', 'close', CTX.inc,
      withProto({ aaaaaaaaa: new Uint8Array(0), byteLength: 1, ...close(frozen) }, null), undefined, [toProto], true],
    // A `__proto__: null` takes the setter away: the next `__proto__` is a field.
    ['a close with __proto__ null, then a string', 'close', CTX.inc, withProto({ ...close(frozen), aaaaaaaaa: null }, 'x'), undefined, [toProto]],
    ['a switch', 'switch', '', sw],
    ['a switch with __proto__ an object', 'switch', '', withProto(sw, {})],
    ['a switch with __proto__ a string', 'switch', '', withProto(sw, 'x')],
    ['a switch with __proto__ null, then a string', 'switch', '', withProto({ ...sw, aaaaaaaaa: null }, 'x'), undefined, [toProto]],
    ['a switch with __proto__ null, then undefined', 'switch', '', withProto({ ...sw, aaaaaaaaa: null }, undefined), undefined, [toProto]],
  ];
  return cases.map(([name, kind, inc, value, spoilAt, renames, unknown]) => {
    const doc = new Y.Doc();
    doc.clientID = 1;
    doc.getMap('m').set('v', value);
    const written = Y.encodeStateAsUpdate(doc);
    const update = spoilAt !== undefined ? spoil(written, spoilAt) : renames ? renameAll(written, renames) : written;
    const page = new Y.Doc();
    let refused = false;
    try {
      Y.applyUpdate(page, update);
    } catch {
      refused = true;
    }
    const read = page.getMap('m').get('v');
    const ok = refused || kind === 'canon' ? null
      : kind === 'checkpoint' ? asCheckpointFor({ inc })(read) !== null
      : kind === 'switch' ? computedCfgInc(read) === CTX.inc : asClose(read) !== null;
    return {
      name, kind, inc, update: bytesToHex(update), proto: holdsProto(value) || renames !== undefined,
      unclear: holdsUnclear(value), refused, unknown: refused || unknown === true,
      ok, canon: refused ? null : canon(read), hash: refused ? null : recHash(read),
    };
  });
}

function build(): Record<string, unknown> {
  const kit = new ComputedKit(CTX);
  const crapsKit = new ComputedKit(CRAPS_CTX);
  const alice = testIdentity('alice');
  const bob = testIdentity('bob');
  const owner = testIdentity('owner');

  // Session records a page writes, signed by test identities: the node
  // checks slips' and closes' signatures (and ranks closes).
  const s1 = kit.slip(alice, 4, [{ type: 'red', amount: 25 }, { type: 'straight', pick: 17, amount: 5 }]);
  const s2 = kit.slip(bob, 4, [{ type: 'black', amount: 10 }], { v: 3 });
  const cs = crapsKit.crapsSlip(alice, 9, [{ type: 'pass', amount: 10 }], 'a'.repeat(32), { t: 3 });
  const house = housePubOf(nodeSecret('one'));
  const seed4 = houseSeedOf(nodeSecret('one'), CTX, 4);
  const h4 = houseCommitOf(CTX, 4, seed4);
  const c1 = kit.close(alice, 4, 'g', [s1, s2]);
  const fairBody = { r: 4, q: 'g', f: { alice: s1.hash, bob: s2.hash }, h: h4, k: alice.pub };
  const c2 = { ...fairBody, g: alice.sign(signBytes('close', CTX, fairBody)) };
  const c2key = closeKey(c2)!;
  const sessionRecords: { kind: SignedKind; ctx: FoldCtx; key: string; value: unknown; bytes: string; rank?: string }[] = [];
  const push = (kind: SignedKind, ctx: FoldCtx, key: string, value: { k: string; r: number }): void => {
    sessionRecords.push({
      kind, ctx, key, value, bytes: bytesToHex(signBytes(kind, ctx, value)),
      ...(kind === 'close' ? { rank: dutyRank('close', ctx, value.r, value.k) } : {}),
    });
  };
  push('slip', CTX, s1.key, s1.rec);
  push('slip', CTX, s2.key, s2.rec);
  push('slip', CRAPS_CTX, cs.key, cs.rec);
  push('close', CTX, c1.key, c1.rec);
  push('close', CTX, c2key, c2);

  // The house's own records, signed by the node's derived key.
  const secret = nodeSecret('one');
  const sign = <T extends { k: string }>(kind: SignedKind, body: T): T & { g: string } =>
    ({ ...body, g: houseSign(secret, signBytes(kind, CTX, body)) });
  const seed5 = houseSeedOf(secret, CTX, 5);
  const reveal: HouseRevealRec = sign('hreveal', {
    r: 4, s: seed4, x: [c2key.slice(-32)].sort(), n: [s1.hash, s2.hash].sort(), c: houseCommitOf(CTX, 5, seed5), k: house,
  });
  const stepDown: HouseRevealRec = sign('hreveal', { r: 5, s: seed5, x: [], n: [], k: house });
  const join: HouseCommitRec = sign('hcommit', { r: 6, c: houseCommitOf(CTX, 6, houseSeedOf(secret, CTX, 6)), k: house });
  const houseRecords = [
    { kind: 'hreveal', key: houseRevealKey(reveal), value: reveal, bytes: bytesToHex(signBytes('hreveal', CTX, reveal)) },
    { kind: 'hreveal', key: houseRevealKey(stepDown), value: stepDown, bytes: bytesToHex(signBytes('hreveal', CTX, stepDown)) },
    { kind: 'hcommit', key: houseCommitKey(join), value: join, bytes: bytesToHex(signBytes('hcommit', CTX, join)) },
  ];

  // The room records: the owner's delegation and setting, the house's beat.
  const roomSigned = <T extends object>(kind: RoomKind, t: string, body: T, by: (b: Uint8Array) => string): T & { g: string } =>
    ({ ...body, g: by(roomSignBytes(kind, CTX.room, t, body)) });
  const delegation: DelegationRec = roomSigned('hkey', '', { v: 1 as const, h: house, k: owner.pub }, (b) => owner.sign(b));
  const setting: FairSettingRec = roomSigned('hfair', CTX.t, { v: 1 as const, m: 1 as const, s: 1730000000000, k: owner.pub }, (b) => owner.sign(b));
  const beat: BeatRec = roomSigned('hbeat', '', { v: 1 as const, n: 1730000000123, k: house }, (b) => houseSign(secret, b));
  const roomRecords = [
    { kind: 'hkey', t: '', key: delegationKey(house), value: delegation, bytes: bytesToHex(roomSignBytes('hkey', CTX.room, '', delegation)) },
    { kind: 'hfair', t: CTX.t, key: fairSettingKey(CTX.t), value: setting, bytes: bytesToHex(roomSignBytes('hfair', CTX.room, CTX.t, setting)) },
    { kind: 'hbeat', t: '', key: beatKey(house), value: beat, bytes: bytesToHex(roomSignBytes('hbeat', CTX.room, '', beat)) },
  ];

  // Session ids, with a house commitment and a craps carry.
  const cp = (extra: Partial<Checkpoint>): Pick<Checkpoint, 'b' | 'u' | 'l' | 'n' | 'e' | 's' | 'h'> =>
    ({ b: 'g', u: 12, l: c1.hash, n: { alice: '-35', bob: '120' }, ...extra });
  const sids = [
    { ctx: CTX, cp: null },
    { ctx: CTX, cp: cp({}) },
    { ctx: CTX, cp: cp({ h: h4 }) },
    { ctx: CTX, cp: cp({ e: 1 }) },
    { ctx: CRAPS_CTX, cp: cp({ s: { p: 6, w: { alice: [{ type: 'pass', amount: 10 }] }, h: 'alice', i: 1 }, h: h4 }) },
  ].map((x) => ({ ...x, sid: nextSid(x.ctx, x.cp) }));

  const houses = ['one', 'two'].map((name) => {
    const sec = nodeSecret(name);
    const msg = sha256(utf8ToBytes(`ssf-house-vector-msg|${name}`));
    return {
      nodeSecret: bytesToHex(sec),
      pub: housePubOf(sec),
      seeds: [1, 4, 1000].map((r) => ({ ctx: CTX, r, seed: houseSeedOf(sec, CTX, r) }))
        .concat([{ ctx: CRAPS_CTX, r: 9, seed: houseSeedOf(sec, CRAPS_CTX, 9) }]),
      sign: { bytes: bytesToHex(msg), sig: houseSign(sec, msg) },
    };
  });

  return {
    note: 'Bytes the owner\'s node computes as the pages do (src/computedHouseVectors.test.ts writes this with VECTORS_WRITE=1; ssf-p2p-node house.rs tests read it). canon: computedFold canon (null: junk) and recHash. sessionRecords: page-written slips and closes, their keys, signBytes (hex) and, for a close, dutyRank(\'close\'). houseRecords: the house\'s reveals and join, signed by node "one". roomRecords: computedHouse roomSignBytes. sids: nextSid. commits: slipCommit and houseCommitOf. houses: a node secret, its house key, seeds (houseSeedOf) and an ed25519 signature (deterministic). felts: a slip\'s felt `b` and whether the fold takes a slip holding it (asSlipFor; house.rs felt_ok). checkpoints: whether the fold takes each (asCheckpointFor at incarnation `inc`; house.rs checkpoint_ok). forfeits and closes: records good but for `n` (asForfeit; house.rs forfeit_ids) and `f` (asClose; house.rs close_frozen). yjs: values no JSON holds (undefined entries, own `__proto__` fields, strings that are no UTF-8), each as the Yjs update writing it to map `m` key `v`, whether it holds a `__proto__` field (`proto`), one that is no object (`unclear`: the house reads it as a page receiving that one field does, and knows a page may read junk), and whether a page refuses the update (`refused`), and what a page receiving it reads: its reader\'s verdict `ok` (null for kind canon or a refused update), canon and recHash. The house reads the rest as the pages do.',
    canon: canonCases(),
    sessionRecords,
    houseRecords,
    roomRecords,
    sids,
    commits: [
      { ctx: CTX, r: 4, party: 'alice', seed: kit.seed('alice', 4), commit: slipCommit(CTX, 4, 'alice', kit.seed('alice', 4)) },
      { ctx: CTX, r: 4, party: '', seed: seed4, commit: h4 },
      { ctx: CRAPS_CTX, r: 9, party: '', seed: seed4, commit: houseCommitOf(CRAPS_CTX, 9, seed4) },
    ],
    houses,
    felts: feltCases(),
    checkpoints: checkpointCases(),
    forfeits: forfeitCases(),
    closes: closeCases(),
    yjs: yjsCases(),
  };
}

describe('the house\'s bytes (test-vectors/computed-house-v1.json)', () => {
  const made = build();

  it('match the file', () => {
    const text = `${JSON.stringify(made, null, 2)}\n`;
    if (process.env.VECTORS_WRITE === '1') writeFileSync(FILE, text);
    expect(JSON.parse(readFileSync(FILE, 'utf8'))).toEqual(JSON.parse(text));
  });

  it('are records the pages accept', () => {
    const v = made as {
      sessionRecords: { kind: SignedKind; key: string; value: { k: string; g: string }; bytes: string }[];
      houseRecords: { key: string | null; value: { k: string; g: string }; bytes: string }[];
      roomRecords: { kind: RoomKind; key: string; value: unknown; bytes: string }[];
      houses: { nodeSecret: string; pub: string; sign: { bytes: string; sig: string } }[];
    };
    for (const r of [...v.sessionRecords, ...v.houseRecords]) {
      expect(r.key).not.toBeNull();
      expect(r.key!.endsWith(recHash(r.value)!)).toBe(true);
      expect(verifyIdentityStrict(r.value.k, hexToBytes(r.bytes), r.value.g)).toBe(true);
    }
    const shapes = { hkey: asDelegation, hfair: asFairSetting, hbeat: asBeat } as const;
    for (const r of v.roomRecords) {
      const rec = shapes[r.kind](r.value) as { k: string; g: string } | null;
      expect(rec).not.toBeNull();
      expect(verifyIdentityStrict(rec!.k, hexToBytes(r.bytes), rec!.g)).toBe(true);
    }
    for (const h of v.houses) expect(verifyIdentityStrict(h.pub, hexToBytes(h.sign.bytes), h.sign.sig)).toBe(true);
  });

  it('pin what a page that received each odd value reads', () => {
    // What lib0 does with them: an undefined entry stays (and Object.keys
    // lists it); a `__proto__` field is set as `o.__proto__ = v`, so an
    // object there leaves a value that is no plain object, and anything else
    // leaves no field; a string that isn't UTF-8 refuses the whole update.
    // house.rs CVal::from_any reads each as a page receiving it does, and
    // hb::clarity marks the ones a page may read otherwise: a `__proto__`
    // field that is no object (another before it, an object, leaves junk,
    // and the node keeps only the last), or a refused update.
    const yjs = made.yjs as YjsCase[];
    const verdicts = Object.fromEntries(yjs.map((c) => [c.name, c.refused ? 'refused' : c.kind === 'canon' ? c.canon : c.ok]));
    expect(verdicts).toEqual({
      'a checkpoint': true,
      'a net that is no UTF-8': 'refused',
      'a pid that is no UTF-8': 'refused',
      'a net undefined': false,
      'a net named __proto__, a string': true,
      'a net named __proto__, an object': false,
      'a net named __proto__, null': true,
      'a net named __proto__, undefined': true,
      'a field named __proto__, a string': true,
      'a field named __proto__, an array': false,
      'a field undefined': true,
      'a frozen slip undefined': false,
      'a frozen slip named __proto__, a string': true,
      'a rider undefined': false,
      'a rider named __proto__, a felt': false,
      'a rider named __proto__, a string': true,
      'a felt entry with a field named __proto__': true,
      'a canon value named __proto__, a map': null,
      'a canon value named __proto__, a number': '{"a":1}',
      'an array entry undefined': null,
      'a field named __proto__ twice, an array then a string': false,
      'a net named __proto__ twice, an object then undefined': false,
      'a close with __proto__ a buffer, a numeric field, then null': true,
      'a close with __proto__ a buffer, a length, then an object': 'refused',
      'a close with __proto__ a buffer, a byteLength, then null': 'refused',
      'a close with __proto__ null, then a string': false,
      'a switch': true,
      'a switch with __proto__ an object': true,
      'a switch with __proto__ a string': true,
      'a switch with __proto__ null, then a string': false,
      'a switch with __proto__ null, then undefined': false,
    });
    // The page reads the close past the buffer as the close itself: junk
    // to the node, it would let the house reveal over a rival's close.
    const dropped = yjs.find((c) => c.name === 'a close with __proto__ a buffer, a numeric field, then null')!;
    expect(dropped.canon).toBe(canon({ r: 3, q: 'g', f: { alice: H32 }, k: K, g: G }));
    expect(dropped.ok).toBe(true);
    expect(yjs.filter((c) => c.unknown && !c.refused).map((c) => c.name)).toEqual(['a close with __proto__ a buffer, a numeric field, then null']);
    expect(yjs.filter((c) => c.proto).map((c) => c.name)).toEqual(yjs.filter((c) => c.name.includes('__proto__')).map((c) => c.name));
    expect(yjs.filter((c) => c.unclear).map((c) => c.name)).toEqual([
      'a net named __proto__, a string', 'a net named __proto__, null', 'a net named __proto__, undefined',
      'a field named __proto__, a string', 'a frozen slip named __proto__, a string', 'a rider named __proto__, a string',
      'a felt entry with a field named __proto__', 'a canon value named __proto__, a number',
      'a field named __proto__ twice, an array then a string', 'a net named __proto__ twice, an object then undefined',
      'a close with __proto__ a buffer, a numeric field, then null', 'a close with __proto__ a buffer, a byteLength, then null',
      'a close with __proto__ null, then a string',
      'a switch with __proto__ a string', 'a switch with __proto__ null, then a string', 'a switch with __proto__ null, then undefined',
    ]);
    // The pages compare pids by UTF-16 code units: an astral one sorts
    // below U+E000–U+FFFF, which byte (or code point) order puts it above.
    const forfeits = made.forfeits as { value: { n: unknown }; ok: boolean }[];
    const ok = (n: string[]) => forfeits.find((f) => JSON.stringify(f.value.n) === JSON.stringify(n))?.ok;
    expect([ok(['😀', '\uE000']), ok(['\uE000', '😀'])]).toEqual([true, false]);
  });

  it('give each node its own key and each round its own seed', () => {
    const v = made as { houses: { pub: string; seeds: { seed: string }[] }[] };
    expect(v.houses[0].pub).not.toBe(v.houses[1].pub);
    const seeds = v.houses.flatMap((h) => h.seeds.map((s) => s.seed));
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});
