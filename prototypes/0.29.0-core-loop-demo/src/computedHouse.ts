/**
 * 🏠 The house's room records (PR 5 of "Computed casino tables").
 *
 * PURE, like computedFold: no Yjs, no Date, no casinoDoc state. The room-wide
 * records a house table's fold doesn't read itself, but casinoDoc does to
 * answer the fold's HouseCheck and the ⚙ card's questions. They sit at the
 * top level of `casinoComputed`, beside the checkpoints (computedFold's
 * session keys never start with these):
 *
 *   hk:<house>   delegation   {v: 1, h, k, g}      by the room's deed holder
 *   hf:<t>       Fair setting {v: 1, m, s, k, g}   by the room's deed holder
 *   hb:<house>   heartbeat    {v: 1, n, k, g}      by the house
 *
 * A DELEGATION says "the node whose house key is `h` is my house in this
 * room", signed by the deed holder's identity key `k`. Only a key so
 * delegated decides a round (computedFold THE HOUSE).
 *
 * The FAIR SETTING of table `t`: `m` 0 = Fair while the house is online, 1 =
 * Friendly (the house adds no seed). `s` orders the owner's choices: the
 * highest one standing wins (fairAfter: of two with one `s`, as two of the
 * owner's pages may sign, the higher recHash), and no record at all means
 * Fair. It is read by
 * the house and the ⚙ card only; the fold never reads it (the house steps
 * down itself when set Friendly).
 *
 * A HEARTBEAT, every HEARTBEAT_MS while the house runs a Fair table in the
 * room, `n` rising (the node's clock): the ⚙ card calls the house online
 * while one is heard, and a page waits less before voiding a Fair round the
 * house has left (computedTable).
 *
 * Signed bytes: sha256(utf8(`ssf-ct-v1|<kind>|<room>|<t>|` + canon(body
 * without g))), kind `hkey`, `hfair` or `hbeat` (none a session record's
 * kind, so no signature is good for both), `t` the table id for a setting
 * and '' otherwise. The room is signed and never stored: a record copied
 * into another room fails there.
 *
 * Also here, the node's own derivations (ssf-p2p-node house.rs), mirrored
 * for the simulation's house and the test vectors: the house key from the
 * node's secret key, and each round's seed.
 */

import * as ed from '@noble/ed25519';
import { blake3 } from '@noble/hashes/blake3';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { canon, hasFields, isPlain, isPub, isSig, recHash } from './computedFold';
import type { FoldCtx } from './computedFold';

// The derivations below sign synchronously (keypair.ts wires the same).
ed.etc.sha512Sync ??= (...m: Uint8Array[]) => sha512(ed.etc.concatBytes(...m));

/** The house writes a heartbeat this often while it runs a Fair table. */
export const HEARTBEAT_MS = 5_000;
/** A house heard within this long is online (three heartbeats). */
export const HOUSE_HEARD_MS = 15_000;

export interface DelegationRec {
  v: 1;
  /** The house key, base64url (43 chars): the `hk:` key's own. */ h: string;
  /** The deed holder's identity key. */ k: string;
  g: string;
}

export interface FairSettingRec {
  v: 1;
  /** 0 = Fair while the house is online, 1 = Friendly. */ m: 0 | 1;
  /** The owner's order of choices (their clock at the choice), ≥ 1. */ s: number;
  /** The deed holder's identity key. */ k: string;
  g: string;
}

export interface BeatRec {
  v: 1;
  /** Rising with every beat (the node's clock), ≥ 1. */ n: number;
  /** The house key: the `hb:` key's own. */ k: string;
  g: string;
}

export type RoomKind = 'hkey' | 'hfair' | 'hbeat';

const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

export function asDelegation(v: unknown): DelegationRec | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'h', 'k', 'g'])) return null;
  return v.v === 1 && isPub(v.h) && isPub(v.k) && isSig(v.g) ? (v as unknown as DelegationRec) : null;
}

export function asFairSetting(v: unknown): FairSettingRec | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'm', 's', 'k', 'g'])) return null;
  return v.v === 1 && (v.m === 0 || v.m === 1) && isCount(v.s) && isPub(v.k) && isSig(v.g)
    ? (v as unknown as FairSettingRec) : null;
}

export function asBeat(v: unknown): BeatRec | null {
  if (!isPlain(v) || !hasFields(v, ['v', 'n', 'k', 'g'])) return null;
  return v.v === 1 && isCount(v.n) && isPub(v.k) && isSig(v.g) ? (v as unknown as BeatRec) : null;
}

/** Whether Fair setting `a` stands over `b`: a higher `s`, or the same `s`
 *  and a higher recHash. Every page and the house (house.rs fair_after)
 *  order them so, so two the owner signed with one number (two pages of
 *  theirs, each a step past the newest it had seen) settle on the same one
 *  everywhere, and no page puts back the one another has set aside. */
export function fairAfter(a: FairSettingRec, b: FairSettingRec): boolean {
  if (a.s !== b.s) return a.s > b.s;
  const ha = recHash(a) ?? '';
  const hb = recHash(b) ?? '';
  return ha > hb;
}

export const delegationKey = (house: string): string => `hk:${house}`;
export const fairSettingKey = (t: string): string => `hf:${t}`;
export const beatKey = (house: string): string => `hb:${house}`;

/** A top-level casinoComputed key's house record kind and what it names (the
 *  house key, or the table), or null for any other key. */
export function houseKeyParts(key: string): { kind: RoomKind; of: string } | null {
  if (key.startsWith('hk:') && isPub(key.slice(3))) return { kind: 'hkey', of: key.slice(3) };
  if (key.startsWith('hb:') && isPub(key.slice(3))) return { kind: 'hbeat', of: key.slice(3) };
  if (key.startsWith('hf:') && key.length > 3) return { kind: 'hfair', of: key.slice(3) };
  return null;
}

/** sha256(utf8(`ssf-ct-v1|<kind>|<room>|<t>|` + canon(body without g))).
 *  Throws on a body canon can't encode, as computedFold signBytes does. */
export function roomSignBytes(kind: RoomKind, room: string, t: string, body: object): Uint8Array {
  const rest: Record<string, unknown> = Object.create(null);
  for (const k of Object.keys(body)) if (k !== 'g') rest[k] = (body as Record<string, unknown>)[k];
  const c = canon(rest);
  if (c === null) throw new TypeError(`roomSignBytes: a ${kind} body must be canonical`);
  return sha256(utf8ToBytes(`ssf-ct-v1|${kind}|${room}|${t}|${c}`));
}

// ── The node's derivations (house.rs), mirrored ─────────────────────────────

/** blake3 derive_key contexts (house.rs uses the same strings). */
export const HOUSE_KEY_CONTEXT = 'ssf-house-key-v1';
export const HOUSE_SEED_KEY_CONTEXT = 'ssf-house-seed-key-v1';

/** The house's ed25519 secret, from the node's 32-byte secret key. */
export function houseSecretOf(nodeSecret: Uint8Array): Uint8Array {
  return blake3(nodeSecret, { context: HOUSE_KEY_CONTEXT });
}

/** The house key (base64url) of a node secret. */
export function housePubOf(nodeSecret: Uint8Array): string {
  return b64url(ed.getPublicKey(houseSecretOf(nodeSecret)));
}

/** The house's seed for round r of a table: blake3 keyed by a key derived
 *  from the node's secret, over `ssf-house-seed-v1|<room>|<t>|<inc>|<r>`. The
 *  same however often or late it is asked (a restart included), and nobody
 *  without the node's secret can tell it from chance. 64 hex. */
export function houseSeedOf(nodeSecret: Uint8Array, ctx: FoldCtx, r: number): string {
  const key = blake3(nodeSecret, { context: HOUSE_SEED_KEY_CONTEXT });
  return bytesToHex(blake3(utf8ToBytes(`ssf-house-seed-v1|${ctx.room}|${ctx.t}|${ctx.inc}|${r}`), { key }));
}

/** A house signature (base64url) over signed bytes, by a node secret. */
export function houseSign(nodeSecret: Uint8Array, bytes: Uint8Array): string {
  return b64url(ed.sign(bytes, houseSecretOf(nodeSecret)));
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
