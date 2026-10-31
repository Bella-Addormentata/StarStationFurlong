/**
 * 🤝 Co-host nodes (C3): a co-host's own signed record of its node, read
 * into pass hints only beside the room's grant for that co-host.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { utf8ToBytes } from '@noble/hashes/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ADDRS_REFRESH_MS,
  CO_HOST_NODES_MAP,
  MAX_AGE_MS,
  MAX_CO_HOST_HINTS,
  REFRESH_MS,
  bindCoHostNodes,
  coHostHintsHere,
  coHostNodeFromWire,
  fileMyCoHostNode,
  forgetCoHostNode,
  needsRefile,
  readCoHostHints,
  resetCoHostNodesForTest,
  signCoHostNode,
  type CoHostSigner,
} from './coHostNodes';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function signer(name: string): CoHostSigner {
  const seed = sha256(utf8ToBytes(`ssf-cohost-test|${name}`));
  return { pub: b64url(ed.getPublicKey(seed)), sign: (bytes) => b64url(ed.sign(bytes, seed)) };
}

const ROOM = 'room-a';
const NOW = 1_800_000_000_000;
const ann = signer('ann');
const ben = signer('ben');
const node = (c: string) => c.repeat(64);
const hint = (n: string, extra: { irohRelayUrls?: string[]; irohDirectAddrs?: string[] } = {}) => ({ irohNodeId: n, ...extra });

describe('the signed record', () => {
  it('reads back as a route only beside a grant for the key that signed it', () => {
    const rec = signCoHostNode(ROOM, hint(node('a'), { irohRelayUrls: ['https://relay.example'], irohDirectAddrs: ['203.0.113.5:44442'] }), NOW - 1000, ann)!;
    const records = new Map<string, unknown>([[ann.pub, rec]]);
    const read = (grants: { pub: string; grantedAt: number }[]) => readCoHostHints(grants, (p) => records.get(p), { roomId: ROOM, now: NOW });
    expect(read([{ pub: ann.pub, grantedAt: 1 }])).toEqual([
      { irohNodeId: node('a'), irohRelayUrls: ['https://relay.example'], irohDirectAddrs: ['203.0.113.5:44442'] },
    ]);
    // No grant, no route; a grant with no record, no route.
    expect(read([])).toEqual([]);
    expect(read([{ pub: ben.pub, grantedAt: 1 }])).toEqual([]);
  });

  it('refuses a record filed under another co-host, copied from another room, or altered', () => {
    const forged = signCoHostNode(ROOM, hint(node('b')), NOW - 1000, ben)!;
    const elsewhere = signCoHostNode('room-b', hint(node('a')), NOW - 1000, ann)!;
    const genuine = signCoHostNode(ROOM, hint(node('a')), NOW - 1000, ann)!;
    const altered = { ...genuine, node: node('c') };
    for (const rec of [forged, elsewhere, altered]) {
      expect(readCoHostHints([{ pub: ann.pub, grantedAt: 1 }], () => rec, { roomId: ROOM, now: NOW })).toEqual([]);
    }
  });

  it('drops a record too old to trust or stamped ahead, and junk of every shape', () => {
    const read = (rec: unknown) => readCoHostHints([{ pub: ann.pub, grantedAt: 1 }], () => rec, { roomId: ROOM, now: NOW });
    expect(read(signCoHostNode(ROOM, hint(node('a')), NOW - MAX_AGE_MS - 1, ann))).toEqual([]);
    expect(read(signCoHostNode(ROOM, hint(node('a')), NOW + 60 * 60_000, ann))).toEqual([]);
    expect(read(signCoHostNode(ROOM, hint(node('a')), NOW - MAX_AGE_MS + 1000, ann))).toHaveLength(1);
    const good = signCoHostNode(ROOM, hint(node('a')), NOW, ann)!;
    for (const bad of [null, 'x', { ...good, v: 2 }, { ...good, node: 'not-hex' }, { ...good, relays: ['x'.repeat(300)] },
      { ...good, addrs: Array(9).fill('1.2.3.4:5') }, { ...good, at: -1 }, { ...good, sig: '' }]) {
      expect(coHostNodeFromWire(bad)).toBeNull();
    }
    expect(signCoHostNode(ROOM, hint('short'), NOW, ann)).toBeNull();
  });

  it('lists the longest-standing co-hosts first, one hint per node, at most eight', () => {
    const people = Array.from({ length: MAX_CO_HOST_HINTS + 3 }, (_, i) => signer(`p${i}`));
    const records = new Map<string, unknown>();
    people.forEach((p, i) => records.set(p.pub, signCoHostNode(ROOM, hint(node(i < 2 ? 'f' : (i % 16).toString(16))), NOW, p)));
    // Granted newest first; p0 and p1 run the same node.
    const grants = people.map((p, i) => ({ pub: p.pub, grantedAt: 1000 - i }));
    const out = readCoHostHints(grants, (p) => records.get(p), { roomId: ROOM, now: NOW });
    expect(out).toHaveLength(MAX_CO_HOST_HINTS);
    expect(new Set(out.map((h) => h.irohNodeId)).size).toBe(out.length);
    // The oldest grant (the last person) comes first.
    expect(out[0].irohNodeId).toBe(node('a'));
    // p0 and p1, the newest grants, fall past the cap.
    expect(out.map((h) => h.irohNodeId)).not.toContain(node('f'));
  });

  it('caps and sorts the routes it signs', () => {
    const rec = signCoHostNode(ROOM, hint(node('a'), {
      irohRelayUrls: ['https://r5', 'https://r1', 'https://r1', 'https://r2', 'https://r3', 'https://r4'],
      irohDirectAddrs: Array.from({ length: 9 }, (_, i) => `10.0.0.${9 - i}:44442`),
    }), NOW, ann)!;
    expect(rec.relays).toEqual(['https://r1', 'https://r2', 'https://r3', 'https://r4']);
    expect(rec.addrs).toHaveLength(6);
    expect(coHostNodeFromWire(rec)).toEqual(rec);
  });
});

describe('refiling', () => {
  const at = (t: number, extra: { irohRelayUrls?: string[]; irohDirectAddrs?: string[] } = {}, n = node('a')) => signCoHostNode(ROOM, hint(n, extra), t, ann)!;

  it('rewrites for a new node or relays at once, new addresses at most hourly, and refreshes weekly', () => {
    const stored = at(NOW, { irohDirectAddrs: ['1.1.1.1:1'] });
    expect(needsRefile(null, stored, NOW)).toBe(true);
    expect(needsRefile(stored, at(NOW + 1000, { irohDirectAddrs: ['1.1.1.1:1'] }), NOW + 1000)).toBe(false);
    expect(needsRefile(stored, at(NOW + 1000, { irohDirectAddrs: ['1.1.1.1:1'] }, node('b')), NOW + 1000)).toBe(true);
    expect(needsRefile(stored, at(NOW + 1000, { irohDirectAddrs: ['1.1.1.1:1'], irohRelayUrls: ['https://r'] }), NOW + 1000)).toBe(true);
    expect(needsRefile(stored, at(NOW + 1000, { irohDirectAddrs: ['2.2.2.2:2'] }), NOW + 1000)).toBe(false);
    expect(needsRefile(stored, at(NOW + ADDRS_REFRESH_MS, { irohDirectAddrs: ['2.2.2.2:2'] }), NOW + ADDRS_REFRESH_MS)).toBe(true);
    expect(needsRefile(stored, at(NOW + REFRESH_MS, { irohDirectAddrs: ['1.1.1.1:1'] }), NOW + REFRESH_MS)).toBe(true);
  });
});

describe('the bound store', () => {
  let doc: Y.Doc;
  beforeEach(() => {
    resetCoHostNodesForTest();
    doc = new Y.Doc();
    bindCoHostNodes(doc);
  });
  afterEach(() => resetCoHostNodesForTest());

  it('files a co-host’s node once, keeps it while nothing moved, and reads it beside the grant', () => {
    const grants = [{ pub: ann.pub, grantedAt: 1 }];
    expect(fileMyCoHostNode(ROOM, true, hint(node('a')), NOW, ann)).toBe('filed');
    expect(fileMyCoHostNode(ROOM, true, hint(node('a')), NOW + 5000, ann)).toBe('kept');
    expect(coHostHintsHere(ROOM, grants, NOW)).toEqual([{ irohNodeId: node('a') }]);
    // Records are signed for their room: none count for another.
    expect(coHostHintsHere('room-b', grants, NOW)).toEqual([]);
    // A reinstalled node (a new id) is filed at once.
    expect(fileMyCoHostNode(ROOM, true, hint(node('b')), NOW + 6000, ann)).toBe('filed');
    expect(coHostHintsHere(ROOM, grants, NOW + 6000)).toEqual([{ irohNodeId: node('b') }]);
  });

  it('refiles over a record someone else wrote under the co-host’s key', () => {
    doc.getMap(CO_HOST_NODES_MAP).set(ann.pub, signCoHostNode(ROOM, hint(node('e')), NOW, ben));
    expect(fileMyCoHostNode(ROOM, true, hint(node('a')), NOW, ann)).toBe('filed');
    expect(coHostHintsHere(ROOM, [{ pub: ann.pub, grantedAt: 1 }], NOW)).toEqual([{ irohNodeId: node('a') }]);
  });

  it('takes a former co-host’s record down, and the owner’s revoke takes it too', () => {
    fileMyCoHostNode(ROOM, true, hint(node('a')), NOW, ann);
    expect(fileMyCoHostNode(ROOM, false, hint(node('a')), NOW, ann)).toBe('removed');
    expect(doc.getMap(CO_HOST_NODES_MAP).has(ann.pub)).toBe(false);
    expect(fileMyCoHostNode(ROOM, false, hint(node('a')), NOW, ann)).toBe('kept');
    fileMyCoHostNode(ROOM, true, hint(node('b')), NOW, ben);
    forgetCoHostNode(ben.pub);
    expect(doc.getMap(CO_HOST_NODES_MAP).size).toBe(0);
  });

  it('never lends a genuine record’s cached verdict to an altered copy', () => {
    const grants = [{ pub: ann.pub, grantedAt: 1 }];
    fileMyCoHostNode(ROOM, true, hint(node('a')), NOW, ann);
    expect(coHostHintsHere(ROOM, grants, NOW)).toHaveLength(1);
    const m = doc.getMap(CO_HOST_NODES_MAP);
    m.set(ann.pub, { ...(m.get(ann.pub) as object), node: node('f') });
    expect(coHostHintsHere(ROOM, grants, NOW)).toEqual([]);
  });
});
