/**
 * 🧮🧪 The node's copy of the fold, pinned to the pages'.
 *
 * test-vectors/fold-engine-v1.json holds sessions (src/foldEngineCorpus.ts) and
 * what the fold in src/foldEntry.ts gives for each under V8: the result as the
 * node reads it and a hash of every field of the fold's output. This file
 * checks that the checked-in file is what this fold gives, and that the
 * checked-in bundle (ssf-p2p-node/fold/fold.min.js, what the node runs) folds
 * each session to the same bytes when the host is given only what the node's
 * worker gives it. house_fold.rs's tests fold the same file in QuickJS.
 *
 * To write the file again — only on purpose, when the fold is meant to change
 * (and the bundle with it, `npm run build:fold`) — run this file with
 * VECTORS_WRITE=1 and review the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import * as entry from './foldEntry';
import { corpus } from './foldEngineCorpus';
import type { FoldCase } from './foldEngineCorpus';
import { b64url } from './computedTestKit';
import { verifyIdentityStrict } from './keypair';

const FILE = new URL('../test-vectors/fold-engine-v1.json', import.meta.url);
const BUNDLE = new URL('../ssf-p2p-node/fold/fold.min.js', import.meta.url);

/** What the host says of a signature, for this case. */
function checkFor(c: FoldCase): (hash: string, kind: string, pub: string, bytes: Uint8Array, sig: string) => boolean | undefined {
  const hold = new Set(c.hold);
  return (hash, kind, pub, bytes, sig) => {
    if (hold.has(hash)) return undefined;
    if (c.sigs === 'real' || kind === 'hreveal' || kind === 'hcommit') return verifyIdentityStrict(pub, bytes, sig);
    return sig === b64url(sha512(bytes));
  };
}

interface Folded {
  summary: string;
  digest: string;
}

const sha = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/** The case folded cold by foldEntry as this file imports it (V8). */
function foldHere(c: FoldCase): Folded {
  const check = checkFor(c);
  (globalThis as Record<string, unknown>).__ssf_check = (hash: string, kind: string, pub: string, bytes: () => Uint8Array, sig: string) =>
    check(hash, kind, pub, bytes(), sig);
  try {
    entry.open(c.ctx, c.cp, c.houses, c.pins, 'host');
    entry.reset(c.records);
    const summary = entry.result();
    return { summary, digest: sha(entry.digest()) };
  } finally {
    delete (globalThis as Record<string, unknown>).__ssf_check;
  }
}

/** The case folded warm: its records in the case's batches, deletes and re-puts. */
function foldWarm(c: FoldCase): Folded {
  const check = checkFor(c);
  (globalThis as Record<string, unknown>).__ssf_check = (hash: string, kind: string, pub: string, bytes: () => Uint8Array, sig: string) =>
    check(hash, kind, pub, bytes(), sig);
  try {
    entry.open(c.ctx, c.cp, c.houses, c.pins, 'host');
    for (const batch of c.warm) {
      entry.apply(batch.map((e) => [e[0], e.length === 1 ? undefined : e[1]] as const));
      entry.result();
    }
    const summary = entry.result();
    return { summary, digest: sha(entry.digest()) };
  } finally {
    delete (globalThis as Record<string, unknown>).__ssf_check;
  }
}

/** A QuickJS-like realm for the checked-in bundle: nothing but the language, and the host functions the node's worker gives. */
function realmWithBundle(): { fold: (c: FoldCase) => Folded } {
  const sandbox: Record<string, unknown> = {};
  const ctx = vm.createContext(sandbox);
  let current: FoldCase | null = null;
  sandbox.__hostSha256 = (m: string | number[]): number[] => Array.from(sha256(typeof m === 'string' ? utf8ToBytes(m) : Uint8Array.from(m)));
  sandbox.__hostUtf8 = (s: string): number[] => Array.from(utf8ToBytes(s));
  sandbox.__hostCheck = (hash: string, kind: string, pub: string, bytes: number[], sig: string): boolean | undefined =>
    checkFor(current!)(hash, kind, pub, Uint8Array.from(bytes), sig);
  sandbox.__hostDigestOf = (text: string): string => sha(text);
  // The globals QuickJS lacks or the node's host replaces, made as the worker makes them.
  vm.runInContext(
    `delete globalThis.TextEncoder;
     globalThis.TextEncoder = class TextEncoder { encode(s = '') { return new Uint8Array(__hostUtf8(String(s))); } };
     globalThis.__ssf_sha256 = (m) => new Uint8Array(__hostSha256(typeof m === 'string' ? m : Array.from(m)));
     globalThis.__ssf_check = (hash, kind, pub, bytes, sig) => __hostCheck(hash, kind, pub, Array.from(bytes()), sig);`,
    ctx,
  );
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), ctx);
  vm.runInContext(
    `globalThis.__fold = (text) => {
       const c = JSON.parse(text);
       SSFFold.open(c.ctx, c.cp, c.houses, c.pins, 'host');
       SSFFold.reset(c.records);
       const summary = SSFFold.result();
       return JSON.stringify({ summary, digest: __hostDigestOf(SSFFold.digest()) });
     };`,
    ctx,
  );
  const run = sandbox.__fold as (text: string) => string;
  return {
    fold: (c) => {
      current = c;
      return JSON.parse(run(JSON.stringify(c))) as Folded;
    },
  };
}

/** A value as the node is handed it (house_bytes.rs CVal): what canon reads as a record (a string, a safe integer, an array, a plain
 *  object) as it is, and anything else (a float, a boolean, null, an integer past 2^53) as null, which canon refuses just the same. */
function asNode(v: unknown): unknown {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isSafeInteger(v) ? v : null;
  if (Array.isArray(v)) return v.map(asNode);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asNode(x)]));
  return v === undefined ? undefined : null;
}

/** The case with its records as the node is handed them. The file holds THIS: the node folds what it is handed, and a float in a
 *  record is a number in JSON it reads as junk. */
function nodeView(c: FoldCase): FoldCase {
  return {
    ...c,
    cp: asNode(c.cp) as FoldCase['cp'],
    records: c.records.map(([k, v]) => [k, asNode(v)] as [string, unknown]),
    warm: c.warm.map((batch) => batch.map((e) => (e.length === 1 ? e : ([e[0], asNode(e[1])] as [string, unknown])))),
  } as FoldCase;
}

/** A summary without the weights of the whole session: `rawBytes` counts what junk weighs as JSON (a float 1.5, three bytes), which
 *  the node, handed junk as null, does not know. */
const withoutWeight = (summary: string): unknown => {
  const s = JSON.parse(summary) as Record<string, unknown>;
  delete s.rawBytes;
  return s;
};

interface VectorFile {
  version: 1;
  cases: (FoldCase & Folded)[];
}

function written(): VectorFile {
  return {
    version: 1,
    cases: corpus().map(nodeView).map((c) => ({ ...c, ...foldHere(c) })),
  };
}

describe('the fold the node runs is the pages\'', () => {
  const cases = corpus();

  it('covers the ways a round ends, and the rest', () => {
    const seen: Record<string, number> = {};
    const bump = (k: string): void => {
      seen[k] = (seen[k] ?? 0) + 1;
    };
    for (const c of cases) {
      const s = JSON.parse(foldHere(c).summary) as {
        rounds: { decided: string | null; dice: unknown }[]; tip: number | null; required: string | null; joins: string[]; pending: boolean;
        base: { ended: boolean }; carry: { p?: number } | null; held: unknown[];
      };
      for (const r of s.rounds) bump(r.decided ?? 'undecided');
      if (s.tip !== null) bump('tip');
      if (s.required) bump('required');
      if (s.joins.length) bump('joins');
      if (s.pending) bump('pending');
      if (s.base.ended) bump('ended');
      if (s.carry && s.carry.p) bump('point');
      if (s.held.length) bump('held');
      if (s.rounds.some((r) => r.dice !== undefined && r.dice !== null)) bump('dice');
    }
    for (const k of ['reveals', 'forfeit', 'house', 'void', 'undecided', 'tip', 'required', 'joins', 'pending', 'ended', 'point', 'held', 'dice']) {
      expect(seen[k] ?? 0, `no case reaches ${k}: ${JSON.stringify(seen)}`).toBeGreaterThan(0);
    }
  });

  it("a player's pinned key decides whose version is the felt, and a pin that arrives later is read", () => {
    const c = cases.find((x) => x.name.startsWith('a rogue key') && x.ctx.inc[0] === 'c')!;
    const heldOf = (summary: string): [string, string][] => (JSON.parse(summary) as { held: [string, string][] }).held;
    const check = checkFor(c);
    (globalThis as Record<string, unknown>).__ssf_check = (hash: string, kind: string, pub: string, bytes: () => Uint8Array, sig: string) => check(hash, kind, pub, bytes(), sig);
    try {
      const pinOf = (pid: string): string => c.pins.find((q) => q[0] === pid)![1];
      const rogueKey = (c.records.map((r) => r[1] as { p: string; k: string }).find((r) => r.p === 'alice' && r.k !== pinOf('alice')))!.k;
      // The pins the case carries: alice's own version holds 10, bob's 7; carol (no pin) and mallory hold nothing.
      entry.open(c.ctx, c.cp, c.houses, c.pins, 'host');
      entry.reset(c.records);
      expect(heldOf(entry.result())).toEqual([['alice', '10'], ['bob', '7']]);
      // The rogue key pinned for alice (a page that saw it first): its version is the felt.
      entry.setPins([['alice', rogueKey], ['bob', pinOf('bob')]]);
      expect(heldOf(entry.result())).toEqual([['alice', '999'], ['bob', '7']]);
      // And the pins back: the same answer as the first.
      entry.setPins(c.pins);
      expect(heldOf(entry.result())).toEqual([['alice', '10'], ['bob', '7']]);
      // No pin at all: no felt at all.
      entry.setPins([]);
      expect(heldOf(entry.result())).toEqual([]);
    } finally {
      delete (globalThis as Record<string, unknown>).__ssf_check;
    }
  });

  it('a warm fold ends where the cold one does', () => {
    for (const c of cases) {
      expect(foldWarm(c), c.name).toEqual(foldHere(c));
    }
  });

  it('a node that reads a float or a null as junk decides as the pages do', () => {
    // The pages fold the records as they are; the node, handed junk as null. Everything but what junk weighs agrees.
    for (const c of cases) {
      expect(withoutWeight(foldHere(nodeView(c)).summary), c.name).toEqual(withoutWeight(foldHere(c).summary));
    }
  });

  it('test-vectors/fold-engine-v1.json is what this fold gives', () => {
    const fresh = written();
    if (process.env.VECTORS_WRITE === '1') writeFileSync(FILE, JSON.stringify(fresh, null, 1) + '\n');
    const have = JSON.parse(readFileSync(FILE, 'utf8')) as VectorFile;
    expect(have.version).toBe(1);
    expect(have.cases.length).toBe(fresh.cases.length);
    for (const [i, c] of fresh.cases.entries()) expect(have.cases[i], c.name).toEqual(JSON.parse(JSON.stringify(c)));
  });

  it('the checked-in bundle folds every case to the same bytes as the source', () => {
    const realm = realmWithBundle();
    const have = JSON.parse(readFileSync(FILE, 'utf8')) as VectorFile;
    for (const c of have.cases) {
      const got = realm.fold(c);
      expect(got.digest, `${c.name}: digest`).toBe(c.digest);
      expect(got.summary, `${c.name}: summary`).toBe(c.summary);
    }
  });
});
