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
add('yxmltext: insert in a fragment (type ref 6)', 'clean', built((d) => {
  const t = new Y.XmlText();
  d.getXmlFragment('f').insert(0, [t]);
  t.insert(0, 'hi');
}));

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
// parentYKey (the root name): a non-UTF-8 root name.
add('parentYKey (root name): non-UTF-8', 'utf8', oneStruct((e) => {
  encoding.writeUint8(e, 4); // content ref 4 (string), no origin/right/parentSub
  encoding.writeVarUint(e, 1); // parentInfo → root name
  encoding.writeVarUint(e, 2); // parentYKey length
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
  encoding.writeVarString(e, 'v'); // ContentString body
}));
// ContentEmbed (ref 5): readJSON = a var-string the page's TextDecoder rejects.
add('contentembed: non-UTF-8', 'utf8', rootItem(5, (e) => {
  encoding.writeVarUint(e, 2);
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
}));
// ContentFormat (ref 6): a valid key then a non-UTF-8 value.
add('contentformat value: non-UTF-8', 'utf8', rootItem(6, (e) => {
  encoding.writeVarString(e, 'b'); // key
  encoding.writeVarUint(e, 2);
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
}));
// ContentDoc (ref 9): a non-UTF-8 guid (refused before the opts Any).
add('contentdoc guid: non-UTF-8', 'utf8', rootItem(9, (e) => {
  encoding.writeVarUint(e, 2);
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
  encoding.writeUint8(e, 118); // opts: Any object (never reached by the guard)
  encoding.writeVarUint(e, 0);
}));
// ContentType → YXmlElement (type ref 3): a non-UTF-8 element name.
add('yxmlelement name: non-UTF-8', 'utf8', rootItem(7, (e) => {
  encoding.writeVarUint(e, 3); // type ref 3 (YXmlElement) reads a name
  encoding.writeVarUint(e, 2);
  encoding.writeUint8(e, 0xff);
  encoding.writeUint8(e, 0x28);
}));
// A positive UTF-8 ContentString (accepts), as a parity anchor.
add('contentstring: valid UTF-8', 'utf8', built((d) => d.getText('t').insert(0, 'abc')));

// typeref — ContentType (ref 7) with each type ref
for (const [tr, label] of [[0, 'YArray'], [1, 'YMap'], [2, 'YText'], [4, 'YXmlFragment'], [6, 'YXmlText']] as const) {
  add(`typeref ${tr} (${label})`, 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, tr)));
}
add('typeref 3 (YXmlElement, reads a name)', 'typeref', rootItem(7, (e) => {
  encoding.writeVarUint(e, 3);
  encoding.writeVarString(e, 'div');
}));
add('typeref 7 (no reader)', 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, 7)));
add('typeref 9 (SubDoc on yrs, no page reader)', 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, 9)));
add('typeref 15 (no page reader)', 'typeref', rootItem(7, (e) => encoding.writeVarUint(e, 15)));

// desync — a construct yrs consumes a different byte count for than the page
// does (ContentJSON reads len+1 var-strings on yrs vs len on the page; XmlHook
// reads no name on yrs vs a name on the page). The guard refuses these
// (Refuse::Desync) even though a page accepts a well-formed one, because past
// one the walk can no longer keep its cursor aligned with yrs — so an unwalked
// byte could reach the decoder as a string. Parity-exempt, like depth/length.
add('typeref 5 (XmlHook) — refused, yrs reads no name', 'desync', rootItem(7, (e) => {
  encoding.writeVarUint(e, 5);
  encoding.writeVarString(e, 'hook');
}));
add('contentjson: one valid-JSON string — refused', 'desync', rootItem(2, (e) => {
  encoding.writeVarUint(e, 1); // ContentJSON len
  encoding.writeVarString(e, '"x"'); // one JSON string the page parses
}));
add('contentjson cursor-shift crash vector (per Copilot) — refused', 'desync', (() => {
  const pre = Uint8Array.from(Buffer.from('010201000201017201046e756c6c046e756c6c0401017401c2a9', 'hex'));
  const out = new Uint8Array(pre.length + 101 + 1);
  out.set(pre, 0);
  out.fill(0x61, pre.length, pre.length + 101);
  out[pre.length + 101] = 0x00;
  return out;
})());

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

// divergence — bytes a page and yrs decode differently (so no page can hold the
// same bytes as yrs regardless), which the guard refuses to stay aligned with
// the decoder that could crash. Parity-exempt, like depth/length/desync: a page
// may accept these (it walks a different, safe path), the guard must refuse.
// The node-side tests in ingest_parity.rs assert the exact refusal reason.
add('raw dispatch: info 0x20 (GC to a page, Item to yrs) — refused', 'divergence',
  Uint8Array.from(Buffer.from('0101010020010001ff', 'hex')));
add('parentInfo 2^32+1 (==1 as u32 on yrs, !=1 on a page) — refused', 'divergence',
  Uint8Array.from(Buffer.from('01010100048180808010020108066162636465c3a900', 'hex')));
add('overlong signed varint (11 bytes, yrs shifts past the width) — refused', 'divergence', rootItem(8, (e) => {
  encoding.writeVarUint(e, 1); // content any len
  encoding.writeUint8(e, 125); // Any: integer (readVarInt)
  for (let i = 0; i < 10; i++) encoding.writeUint8(e, 0x80); // 10 continuation bytes, payload 0
  encoding.writeUint8(e, 0x00); // 11th byte — the guard refuses here
}));

// varint — the G1 cap. lib0's readVarUint checks `num > MAX_SAFE` ONLY after a
// continuation byte, and returns at the terminating byte without the check — so
// the cap turns on a continuation byte, not on the value alone. Both updates
// below are otherwise COMPLETE (a valid one-struct body + empty DS), so the
// client varint is the only thing in question: the guard must accept the
// boundary one and refuse the over-cap one AS VarTooLarge (not Truncated), and
// removing the G1 check would wrongly accept the over-cap one — the regression
// the node-side test (refuses_oversized_varuint) asserts against.
//
// client = MAX_SAFE (2^53-1), minimal [0xff*7, 0x0f]: the terminating 0x0f
// clears the high bit, so lib0 returns it without the cap check — a real page
// accepts it, and so must the guard (boundary; no over-refusal). A genuine yjs
// update whose only unusual byte is the clientID keeps it unmistakably valid.
add('client id = MAX_SAFE (terminal byte, accepted)', 'varint', (() => {
  const d = new Y.Doc();
  d.clientID = Number.MAX_SAFE_INTEGER;
  d.getText('t').insert(0, 'x');
  return Y.encodeStateAsUpdate(d);
})());
// client one past the cap, [0xff*8, 0x01]: the 8th byte is a CONTINUATION byte
// at which the running value is 2^56-1 > MAX_SAFE, exactly where lib0 throws —
// so the page refuses, and the guard must refuse as VarTooLarge. The struct
// body is present and valid, so a refusal here can only be the cap, never
// truncation.
add('client id over MAX_SAFE (continuation byte)', 'varint', (() => {
  const e = encoding.createEncoder();
  encoding.writeVarUint(e, 1); // numClients
  encoding.writeVarUint(e, 1); // numStructs
  for (const b of [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01]) encoding.writeUint8(e, b); // client, past the cap
  encoding.writeVarUint(e, 0); // clock
  encoding.writeUint8(e, 4 & 0x1f); // info: content ref 4 (ContentString), no origin/right/parentSub
  encoding.writeVarUint(e, 1); // readParentInfo → hasParentYKey
  encoding.writeVarString(e, 'root'); // parentYKey
  encoding.writeVarString(e, 'x'); // ContentString body
  encoding.writeVarUint(e, 0); // delete set: 0 clients
  return encoding.toUint8Array(e);
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
