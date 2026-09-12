// Regression test for issue #20 audit r4 — chat closure symmetry.
//
// main.ts owns two module-scope closure pointers that indirect boot-time
// subscribers (subscribeBlockList, sharedGroups.observe, the CHAT-app open
// handler) at the per-join sharedChat / groupsMap handles:
//
//   let latestRebuildChatLog: (() => void) | null = null;
//   let latestRefreshChatThreadBar: (() => void) | null = null;
//
// These pointers are read via *IfBound() helpers wrapped in try/catch: a
// null pointer becomes a silent no-op (no crash) and, unfortunately, no
// repaint either. The lifecycle contract is:
//
//   - leaveRoom() nulls BOTH pointers (defensive: the room doc is about to
//     be destroyed; any indirection through them across the room-null gap
//     must not throw against a destroyed doc).
//   - joinRoomAtEpoch() republishes BOTH pointers (so subsequent block-set
//     mutations, group creations, and chat-app opens paint against the
//     fresh doc).
//
// Historic bug (fixed by this branch): joinRoomAtEpoch republished only
// `latestRebuildChatLog`; `latestRefreshChatThreadBar` was assigned once
// inside a one-shot setup path (setupChatThreadBar, reached from the boot
// setupSpacePhoneOverlay) and never in the join binder. Result: after the
// first leaveRoom(), the closure was null forever, so remote group
// creations stopped repainting the chip bar, the initial paint at end-of-
// join carried stale chips from the departure room, and opening CHAT after
// any rejoin skipped the refresh entirely.
//
// This test asserts the SYMMETRY CONTRACT at the source level: every known
// closure pointer is BOTH nulled inside leaveRoom AND republished (assigned
// to a non-null value) inside joinRoomAtEpoch. Reading the source directly
// pins the invariant without booting the full renderer (main.ts wires the
// three.js scene, IndexedDB caches, and the network provider at import
// time, none of which have any bearing on the defect).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MAIN_TS_PATH = resolve(__dirname, 'main.ts');
const MAIN_TS = readFileSync(MAIN_TS_PATH, 'utf8');

/**
 * Extract the full source text of a top-level function by name — from its
 * signature to the matching close brace. The extractor is a small hand-
 * rolled scanner that tracks brace depth while ignoring braces inside
 * single-line comments, multi-line comments, and single-quoted, double-
 * quoted, and backtick-quoted string literals (main.ts uses all three
 * quoting styles). Assumes the signature starts at column 0, which every
 * top-level function in main.ts satisfies (grep-verified before writing
 * this test).
 */
function extractFunctionBody(source: string, name: string): string {
  const sigRe = new RegExp(String.raw`^(?:async\s+)?function\s+${name}\b[^{]*\{`, 'm');
  const match = sigRe.exec(source);
  if (!match) throw new Error(`top-level function ${name} not found in main.ts`);
  const start = match.index;
  let i = match.index + match[0].length; // position AFTER the opening `{`
  let depth = 1;
  type Mode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl';
  let mode: Mode = 'code';
  while (i < source.length && depth > 0) {
    const c = source[i];
    const c2 = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && c2 === '/') { mode = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'sq'; i++; continue; }
      if (c === '"') { mode = 'dq'; i++; continue; }
      if (c === '`') { mode = 'tpl'; i++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    } else if (mode === 'line') {
      if (c === '\n') mode = 'code';
      i++;
    } else if (mode === 'block') {
      if (c === '*' && c2 === '/') { mode = 'code'; i += 2; continue; }
      i++;
    } else if (mode === 'sq') {
      if (c === '\\') { i += 2; continue; }
      if (c === "'") mode = 'code';
      i++;
    } else if (mode === 'dq') {
      if (c === '\\') { i += 2; continue; }
      if (c === '"') mode = 'code';
      i++;
    } else {
      // tpl — template literal. We do not descend into `${...}` sub-
      // expressions because main.ts's chat closures don't appear inside
      // them; a full parser would but that's overkill for this invariant.
      if (c === '\\') { i += 2; continue; }
      if (c === '`') mode = 'code';
      i++;
    }
  }
  if (depth !== 0) throw new Error(`unbalanced braces reading function ${name} in main.ts`);
  return source.slice(start, i);
}

describe('main.ts · chat closure symmetry (issue #20 audit r4)', () => {
  // The closures whose lifecycle we pin. If new module-scope `latest*`
  // pointers are added to main.ts they should be listed here so the same
  // symmetry contract is enforced. A missed entry here doesn't produce a
  // FALSE PASS: the CLOSURES_IN_SOURCE assertion below cross-checks that
  // no `let latest… : (() => void) | null` slips through the list.
  const CLOSURE_POINTERS = [
    'latestRebuildChatLog',
    'latestRefreshChatThreadBar',
  ] as const;

  const leaveRoomBody = extractFunctionBody(MAIN_TS, 'leaveRoom');
  const joinRoomBody = extractFunctionBody(MAIN_TS, 'joinRoomAtEpoch');

  it('the extractor found the leaveRoom and joinRoomAtEpoch bodies', () => {
    // Sanity: signature lines are the first line of each extract.
    expect(leaveRoomBody.startsWith('async function leaveRoom(')).toBe(true);
    expect(joinRoomBody.startsWith('async function joinRoomAtEpoch(')).toBe(true);
    // The extract must be a plausible function body (opens with `{`, ends
    // with `}`). A too-short extract would silently pass regex checks.
    expect(leaveRoomBody.length).toBeGreaterThan(200);
    expect(joinRoomBody.length).toBeGreaterThan(200);
    expect(leaveRoomBody.trimEnd().endsWith('}')).toBe(true);
    expect(joinRoomBody.trimEnd().endsWith('}')).toBe(true);
  });

  for (const name of CLOSURE_POINTERS) {
    it(`leaveRoom sets ${name} = null`, () => {
      // Exact assignment to the literal `null`. Reading via *IfBound
      // helpers converts a null into a silent no-op — that's the point.
      const re = new RegExp(String.raw`\b${name}\s*=\s*null\s*;`);
      expect(re.test(leaveRoomBody)).toBe(true);
    });

    it(`joinRoomAtEpoch republishes ${name} to a non-null value`, () => {
      // Match `<name> = <something>;` on a line where <something> is NOT
      // the literal `null`. This is the invariant the pre-fix code
      // violated for latestRefreshChatThreadBar: the assignment lived
      // only inside a one-shot setup function reached at boot, not in
      // the join binder, so a leaveRoom→join hop left it null.
      const anyAssign = new RegExp(String.raw`\b${name}\s*=\s*([^\n;]+?);`, 'g');
      const nonNullAssignments: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = anyAssign.exec(joinRoomBody)) !== null) {
        const rhs = m[1].trim();
        if (rhs !== 'null') nonNullAssignments.push(rhs);
      }
      expect(nonNullAssignments.length).toBeGreaterThan(0);
    });
  }

  it('every `let latest… : (() => void) | null` in main.ts is listed above', () => {
    // Cross-check: if a future edit introduces another latest-closure
    // pointer with the same shape but forgets to add it to
    // CLOSURE_POINTERS, this assertion fails so the symmetry check
    // above can't silently miss it. Matches the exact declaration shape
    // main.ts uses today (`let latest<Name>: (() => void) | null = null;`).
    const declRe = /^let (latest[A-Za-z0-9_]+):\s*\(\(\)\s*=>\s*void\)\s*\|\s*null\s*=\s*null\s*;/gm;
    const declared: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = declRe.exec(MAIN_TS)) !== null) {
      declared.push(m[1]);
    }
    // Every declaration must be in our known list (else the symmetry
    // test above did not cover it and the audit could recur).
    const listed = new Set<string>(CLOSURE_POINTERS);
    for (const name of declared) {
      expect(listed.has(name)).toBe(true);
    }
    // And the known list must not name a pointer that isn't actually
    // declared (typo would produce a false pass on the loop above).
    const declaredSet = new Set(declared);
    for (const name of CLOSURE_POINTERS) {
      expect(declaredSet.has(name)).toBe(true);
    }
  });
});
