/**
 * 🛑🧪 Ingest-parity vectors, pinned for the node.
 *
 * The owner's node (ssf-p2p-node ingest_parity.rs) refuses a v1 Yjs update
 * that every page refuses, on the raw bytes, before it decodes it. Each case
 * here is a v1 update (hex) and the page oracle: `refused = true` iff
 * `Y.applyUpdate(new Y.Doc(), update)` throws under the real yjs/lib0. The
 * node's `pages_refuse` must agree, case for case, except the two structural
 * guards (`depth`, `length`), which refuse some page-accepted nesting/lengths
 * on purpose to keep the node from a stack-overflow / OOM `yrs` can't survive.
 *
 * To write the file again — only on purpose, when the bytes or the oracle are
 * meant to change — run with VECTORS_WRITE=1 and review the diff.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';

// The committed file sits beside the other test vectors; INGEST_VECTORS_OUT
// lets the generator write it to another tree (the vectors are version-pinned
// to yjs/lib0, so they can be produced from any tree on the same pins).
const FILE = process.env.INGEST_VECTORS_OUT
  ? new URL(`file://${process.env.INGEST_VECTORS_OUT}`)
  : new URL('../test-vectors/ingest-parity-v1.json', import.meta.url);
const hex = (u: Uint8Array): string => Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('');

/** Whether a page's lib0/Yjs refuses this v1 update (the oracle). */
function pageRefuses(update: Uint8Array): boolean {
  try {
    Y.applyUpdate(new Y.Doc(), update);
    return false;
  } catch {
    return true;
  }
}

// ── Real updates, built by yjs ───────────────────────────────────────────────

/** encodeStateAsUpdate of a doc after `build` runs on it. A fixed clientID
 *  keeps the bytes deterministic — `new Y.Doc()` picks a random clientID, so
 *  without this the committed vectors would never match a fresh run. */
function built(build: (d: Y.Doc) => void): Uint8Array {
  const d = new Y.Doc();
  d.clientID = 1;
  build(d);
  return Y.encodeStateAsUpdate(d);
}

// ── Crafted updates, assembled with lib0 at the v1 wire format ───────────────

/** numClients=1, numStructs=1, client=1, clock=0, one struct, empty DS. */
function oneStruct(writeStruct: (e: encoding.Encoder) => void): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1); // numClients
  encoding.writeVarUint(e, 1); // numStructs
  encoding.writeVarUint(e, 1); // client
  encoding.writeVarUint(e, 0); // clock
  writeStruct(e);
  encoding.writeVarUint(e, 0); // delete set: 0 clients
  return encoding.toUint8Array(e);
}

/** A root Item carrying content ref `ref` (low 5 bits of info), parent named
 *  `root`, no parentSub, with `writeContent` writing the content body. */
function rootItem(ref: number, writeContent: (e: encoding.Encoder) => void, infoHigh = 0): Uint8Array {
  return oneStruct((e) => {
    encoding.writeUint8(e, (ref & 0x1f) | infoHigh); // info: no origin/right, no parentSub
    encoding.writeVarUint(e, 1); // readParentInfo → hasParentYKey
    encoding.writeVarString(e, 'root'); // parentYKey
    writeContent(e);
  });
}

type Case = { name: string; group: string; update: string; refused: boolean };
const cases: Case[] = [];
function add(name: string, group: string, update: Uint8Array): void {
  cases.push({ name, group, update: hex(update), refused: pageRefuses(update) });
}

// clean — one update per content type a real page emits (all accept)
add('ymap: nested object/array/number/string/bool/null', 'clean', built((d) => {
  const m = d.getMap('m');
  m.set('s', 'hello');
  m.set('n', 7);
  m.set('b', true);
  m.set('z', null);
  m.set('o', { a: 1, b: [2, 3], c: 'x' });
  m.set('arr', [1, 'two', { three: 3 }]);
}));
add('yarray: inserts', 'clean', built((d) => d.getArray('a').insert(0, [1, 'two', { k: 'v' }])));
add('ytext: insert with a format', 'clean', built((d) => {
  const t = d.getText('t');
  t.insert(0, 'bold', { b: true });
  t.insert(4, ' plain');
}));
add('ymap: unicode string', 'clean', built((d) => d.getMap('m').set('k', 'héllo 😀 ﬀ')));

// utf8 — a non-UTF-8 byte in each string position (every page throws)
{
  // ContentString: a YText of "abc" with the 'b' flipped to 0xff.
  const u = built((d) => d.getText('t').insert(0, 'abc'));
  const bad = u.slice();
  const i = bad.indexOf(0x61); // 'a'
  if (i >= 0) bad[i + 1] = 0xff;
  add('contentstring: non-UTF-8', 'utf8', bad);
}
// ContentAny string value: craft a YMap-style ContentAny of one bad string.
add('any string: non-UTF-8', 'utf8', rootItem(8, (e) => {
  encoding.writeVarUint(e, 1); // content any len
  encoding.writeUint8(e, 119); // Any: string
  encoding.writeVarUint(e, 2);
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
}));
// ContentAny object key: a map whose key bytes are not UTF-8.
add('any map key: non-UTF-8', 'utf8', rootItem(8, (e) => {
  encoding.writeVarUint(e, 1); // content any len
  encoding.writeUint8(e, 118); // Any: object
  encoding.writeVarUint(e, 1); // one key
  encoding.writeVarUint(e, 2); // key length
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
  encoding.writeUint8(e, 126); // value: null
}));
// parentSub: a struct with BIT6 set and a non-UTF-8 parentSub.
add('parentSub: non-UTF-8', 'utf8', oneStruct((e) => {
  encoding.writeUint8(e, 0x20 | 4); // BIT6 (parentSub) + content ref 4 (string)
  encoding.writeVarUint(e, 1); // parentInfo → root name
  encoding.writeVarString(e, 'root');
  encoding.writeVarUint(e, 2); // parentSub length
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
  encoding.writeVarString(e, 'v'); // the string content
}));
// A positive UTF-8 ContentString (accepts), as a parity anchor.
add('contentstring: valid UTF-8', 'utf8', built((d) => d.getText('t').insert(0, 'abc')));

// typeref — ContentType (ref 7) with each type ref
for (const [tr, label] of [[0, 'YArray'], [1, 'YMap'], [2, 'YText'], [4, 'YXmlFragment']] as const) {
  add(`typeref ${tr} (${label})`, 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, tr)));
}
add('typeref 3 (YXmlElement, reads a name)', 'typeref', rootItem(7, (e) => {
  encoding.writeVarUint(e, 3);
  encoding.writeVarString(e, 'div');
}));
add('typeref 5 (XmlHook, reads a name — accepted)', 'typeref', rootItem(7, (e) => {
  encoding.writeVarUint(e, 5);
  encoding.writeVarString(e, 'hook');
}));
add('typeref 7 (no reader)', 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, 7)));
add('typeref 9 (SubDoc on yrs, no page reader)', 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, 9)));
add('typeref 15 (no page reader)', 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, 15)));

// contentdoc — ContentDoc (ref 9): guid string then opts Any
add('contentdoc: map opts', 'contentdoc', rootItem(9, (e) => {
  encoding.writeVarString(e, 'guid-1');
  encoding.writeUint8(e, 118); // Any object
  encoding.writeVarUint(e, 0); // empty map
}));
add('contentdoc: null opts', 'contentdoc', rootItem(9, (e) => {
  encoding.writeVarString(e, 'guid-1');
  encoding.writeUint8(e, 126); // Any null
}));
add('contentdoc: undefined opts', 'contentdoc', rootItem(9, (e) => {
  encoding.writeVarString(e, 'guid-1');
  encoding.writeUint8(e, 127); // Any undefined
}));
add('contentdoc: number opts (page reads, no throw)', 'contentdoc', rootItem(9, (e) => {
  encoding.writeVarString(e, 'guid-1');
  encoding.writeUint8(e, 125); // Any integer
  encoding.writeVarInt(e, 5);
}));

// inforef — an Item info byte with bit 0x10 set → content ref 17..25
add('info high-bit: content ref 0x14 (no reader)', 'inforef', oneStruct((e) => {
  encoding.writeUint8(e, 0x14); // info & 0x1f = 20, no reader
  encoding.writeVarUint(e, 1);
  encoding.writeVarString(e, 'root');
  encoding.writeVarUint(e, 1); // some trailing byte
}));

// varint — a client id past MAX_SAFE
add('client id >= 2^53', 'varint', (() => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1); // numClients
  encoding.writeVarUint(e, 1); // numStructs
  encoding.writeVarUint(e, Number.MAX_SAFE_INTEGER); // client — lib0 caps here
  // push one more so the value exceeds MAX_SAFE on the node's u64 walk too:
  // re-encode MAX_SAFE+... is not representable; use a raw over-long varint.
  const head = encoding.toUint8Array(e);
  // Hand-write client = 2^53 (one past MAX_SAFE): 8 groups of 7 bits.
  const big: number[] = [];
  let v = 2 ** 53;
  while (v > 0) { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 0x80; big.push(b); }
  const out = new Uint8Array(2 + big.length + 2);
  out[0] = 1; out[1] = 1; out.set(big, 2); // numClients, numStructs, client
  out[2 + big.length] = 0; out[2 + big.length + 1] = 0; // clock, DS clients
  void head;
  return out;
})());

// depth — nested Any arrays past the node's cap (page accepts; guard refuses)
add('deep any (300 arrays)', 'depth', rootItem(8, (e) => {
  encoding.writeVarUint(e, 1); // content any len
  for (let i = 0; i < 300; i++) { encoding.writeUint8(e, 117); encoding.writeVarUint(e, 1); }
  encoding.writeUint8(e, 126); // null leaf
}));

// length — a declared string length past the bytes remaining
add('string length past the buffer', 'length', oneStruct((e) => {
  encoding.writeUint8(e, 4); // content ref 4 (string)
  encoding.writeVarUint(e, 1);
  encoding.writeVarString(e, 'root');
  encoding.writeVarUint(e, 1_000_000); // declared length, far past what follows
  encoding.writeUint8(e, 0x61);
}));

describe('🛑 ingest-parity vectors', () => {
  it('match the committed file (set VECTORS_WRITE=1 to rewrite)', () => {
    const json = JSON.stringify({ note: 'v1 updates and the page oracle (Y.applyUpdate throws) for ssf-p2p-node ingest_parity.rs', cases }, null, 2) + '\n';
    if (process.env.VECTORS_WRITE) {
      writeFileSync(FILE, json);
    }
    const onDisk = readFileSync(FILE, 'utf8');
    expect(onDisk).toBe(json);
  });

  it('every utf8-negative case is refused by the page', () => {
    for (const c of cases.filter((x) => x.group === 'utf8' && x.name.includes('non-UTF-8'))) {
      expect(c.refused, c.name).toBe(true);
    }
  });

  it('every clean case is accepted by the page', () => {
    for (const c of cases.filter((x) => x.group === 'clean')) {
      expect(c.refused, c.name).toBe(false);
    }
  });
});
