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
import {
  canon, closeKey, dutyRank, houseCommitKey, houseCommitOf, houseRevealKey, nextSid, recHash, signBytes, slipCommit,
} from './computedFold';
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
    note: 'Bytes the owner\'s node computes as the pages do (src/computedHouseVectors.test.ts writes this with VECTORS_WRITE=1; ssf-p2p-node house.rs tests read it). canon: computedFold canon (null: junk) and recHash. sessionRecords: page-written slips and closes, their keys, signBytes (hex) and, for a close, dutyRank(\'close\'). houseRecords: the house\'s reveals and join, signed by node "one". roomRecords: computedHouse roomSignBytes. sids: nextSid. commits: slipCommit and houseCommitOf. houses: a node secret, its house key, seeds (houseSeedOf) and an ed25519 signature (deterministic).',
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

  it('give each node its own key and each round its own seed', () => {
    const v = made as { houses: { pub: string; seeds: { seed: string }[] }[] };
    expect(v.houses[0].pub).not.toBe(v.houses[1].pub);
    const seeds = v.houses.flatMap((h) => h.seeds.map((s) => s.seed));
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});
