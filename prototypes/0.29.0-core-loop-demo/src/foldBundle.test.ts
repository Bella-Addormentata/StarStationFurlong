/**
 * 🧮🦀 The node's copy of the fold is the pages' fold, and nothing else.
 *
 * ssf-p2p-node/fold/fold.min.js is src/foldEntry.ts (and the pages' computedFold
 * it imports) bundled for QuickJS, checked in so the node's cargo jobs need no
 * Node. These tests fail when it is stale (run `npm run build:fold` and commit
 * it) and when anything in it could give two engines, two machines or two runs
 * different answers: a clock, randomness, locale rules, the transcendental
 * functions, the network, or a way for the fold to reach the host beyond the
 * three it is given.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — a plain ES module with no types, shared with the build script.
import { BUNDLE_PATH, buildFoldBundle } from '../scripts/foldBundle.mjs';

const built = (await buildFoldBundle()) as { text: string; inputs: string[] };

describe('the fold bundle', () => {
  it('is what the source builds to', () => {
    const have = readFileSync(BUNDLE_PATH as string, 'utf8');
    expect(have === built.text, 'ssf-p2p-node/fold/fold.min.js is stale: run `npm run build:fold` and commit it').toBe(true);
  });

  it('holds nothing that differs between engines, machines or runs', () => {
    const forbidden: [string, RegExp][] = [
      ['Intl', /\bIntl\b/],
      ['Date', /\bDate\b/],
      ['Math.random', /Math\.random/],
      ['localeCompare', /localeCompare/],
      ['toLocale…', /toLocale/],
      ['performance', /\bperformance\b/],
      ['a transcendental or trig Math function', /Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|pow|hypot|cbrt|sqrt|fround)\b/],
      ['a timer', /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/],
      ['the network', /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/],
      ['a way to run code from text', /\beval\(|new Function\b|\bimport\(/],
      ['a module loader', /\brequire\(|\bprocess\./],
      ['shared memory', /\b(SharedArrayBuffer|Atomics|WeakRef|FinalizationRegistry)\b/],
    ];
    for (const [what, re] of forbidden) expect(re.test(built.text), `the fold bundle names ${what}`).toBe(false);
  });

  it('reaches the host by exactly the two names it is given, and takes the global object no other way', () => {
    const host = new Set([...built.text.matchAll(/__ssf_[A-Za-z0-9]+/g)].map((m) => m[0]));
    expect([...host].sort()).toEqual(['__ssf_check', '__ssf_sha256']);
    for (const m of built.text.matchAll(/globalThis(.{0,8})/g)) expect(m[1].startsWith('.__ssf_'), `globalThis${m[1]}`).toBe(true);
  });

  it('names crypto only in files the fold never calls it from', () => {
    // games/diceFairness.ts and games/fairDice.ts keep their async browser
    // helpers beside the pure functions the fold imports; the fold calls none
    // of them (and QuickJS has no `crypto`, so a call would throw and the node
    // would fold that table again, never trust it). noble's own two files
    // only look for one, to make random bytes the fold never asks for.
    const allowed = new Set([
      'src/games/diceFairness.ts', 'src/games/fairDice.ts', 'node_modules/@noble/hashes/esm/crypto.js', 'node_modules/@noble/hashes/esm/utils.js',
    ]);
    for (const file of built.inputs) {
      if (allowed.has(file)) continue;
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(/\bcrypto\b/.test(text), `${file} is in the fold bundle and names crypto`).toBe(false);
    }
  });
});
