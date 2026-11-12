/**
 * 🤝 Room holders: every computer that holds a room files its node, signed by
 * its player's key; passes name the owner's and the freshest; the list stays
 * the size a reader looks at; one switch keeps a computer off it.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { utf8ToBytes } from '@noble/hashes/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ADDRS_REFRESH_MS,
  HOLDER_NODES_MAP,
  LIST_COMPUTER_KEY,
  MAX_AGE_MS,
  MAX_HOLDERS,
  MAX_HOLDER_HINTS,
  MAX_PRUNE,
  PRUNE_AGE_MS,
  REFRESH_MS,
  bindHolderNodes,
  fileMyHolderNode,
  holderHintsHere,
  holderNodeFromWire,
  holderNodeSignBytes,
  holdersHere,
  listsThisComputer,
  needsRefile,
  ownerPubIn,
  readHolderHints,
  readHolders,
  resetRoomHoldersForTest,
  roomStateIn,
  setListsThisComputer,
  signHolderNode,
  staleHolderKeys,
  subscribeHolderNodes,
  type FilingFacts,
  type HolderSigner,
} from './roomHolders';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

function signer(name: string): HolderSigner {
  const seed = sha256(utf8ToBytes(`ssf-holder-test|${name}`));
  return { pub: b64url(ed.getPublicKey(seed)), sign: (bytes) => b64url(ed.sign(bytes, seed)) };
}

const ROOM = 'room-a';
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600_000;
const ann = signer('ann');
const ben = signer('ben');
const cat = signer('cat');
const node = (c: string) => c.repeat(64);
/** A distinct well-formed node id per number. */
const nodeN = (i: number) => i.toString(16).padStart(64, '0');
const hint = (n: string, extra: { irohRelayUrls?: string[]; irohDirectAddrs?: string[] } = {}) => ({ irohNodeId: n, ...extra });
const entries = (...list: [HolderSigner, unknown][]): [string, unknown][] => list.map(([s, r]) => [s.pub, r]);

describe('the signed record', () => {
  it('reads back as a route for anyone who filed one: no grant is asked for', () => {
    const rec = signHolderNode(ROOM, hint(node('a'), { irohRelayUrls: ['https://relay.example'], irohDirectAddrs: ['203.0.113.5:44442'] }), NOW - 1000, ann)!;
    expect(readHolderHints(entries([ann, rec]), { roomId: ROOM, now: NOW })).toEqual([
      { irohNodeId: node('a'), irohRelayUrls: ['https://relay.example'], irohDirectAddrs: ['203.0.113.5:44442'] },
    ]);
    expect(readHolderHints([], { roomId: ROOM, now: NOW })).toEqual([]);
  });

  it('carries direct addresses only when told to (the owner’s own record)', () => {
    const routes = { irohRelayUrls: ['https://relay.example'], irohDirectAddrs: ['203.0.113.5:44442'] };
    const visitor = signHolderNode(ROOM, hint(node('a'), routes), NOW, ann, false)!;
    expect(visitor.addrs).toBeUndefined();
    expect(visitor.relays).toEqual(['https://relay.example']);
    // Signed without them: adding them back breaks the signature.
    expect(readHolderHints(entries([ann, visitor]), { roomId: ROOM, now: NOW })).toEqual([{ irohNodeId: node('a'), irohRelayUrls: ['https://relay.example'], irohDirectAddrs: undefined }]);
    expect(readHolderHints(entries([ann, { ...visitor, addrs: ['203.0.113.5:44442'] }]), { roomId: ROOM, now: NOW })).toEqual([]);
    expect(signHolderNode(ROOM, hint(node('a'), routes), NOW, ann)!.addrs).toEqual(['203.0.113.5:44442']);
  });

  it('refuses a record filed under another key, copied from another room, or altered', () => {
    const forged = signHolderNode(ROOM, hint(node('b')), NOW - 1000, ben)!;
    const elsewhere = signHolderNode('room-b', hint(node('a')), NOW - 1000, ann)!;
    const genuine = signHolderNode(ROOM, hint(node('a')), NOW - 1000, ann)!;
    const altered = { ...genuine, node: node('c') };
    for (const rec of [forged, elsewhere, altered]) {
      expect(readHolders(entries([ann, rec]), { roomId: ROOM, now: NOW })).toEqual([]);
    }
    expect(readHolders(entries([ann, genuine]), { roomId: ROOM, now: NOW })).toEqual([{ pub: ann.pub, record: genuine }]);
  });

  it('drops a record too old to be a route or stamped ahead, and junk of every shape', () => {
    const read = (rec: unknown) => readHolderHints(entries([ann, rec]), { roomId: ROOM, now: NOW });
    expect(read(signHolderNode(ROOM, hint(node('a')), NOW - MAX_AGE_MS - 1, ann))).toEqual([]);
    expect(read(signHolderNode(ROOM, hint(node('a')), NOW + 60 * 60_000, ann))).toEqual([]);
    expect(read(signHolderNode(ROOM, hint(node('a')), NOW - MAX_AGE_MS + 1000, ann))).toHaveLength(1);
    const good = signHolderNode(ROOM, hint(node('a')), NOW, ann)!;
    for (const bad of [null, 'x', { ...good, v: 2 }, { ...good, node: 'not-hex' }, { ...good, relays: ['x'.repeat(300)] },
      { ...good, addrs: Array(9).fill('1.2.3.4:5') }, { ...good, at: -1 }, { ...good, sig: '' }]) {
      expect(holderNodeFromWire(bad)).toBeNull();
    }
    expect(signHolderNode(ROOM, hint('short'), NOW, ann)).toBeNull();
    // A key no player could have filed under is not read at all.
    expect(readHolders([['', good], ['k'.repeat(65), good]], { roomId: ROOM, now: NOW, verify: () => true })).toEqual([]);
  });

  it('caps and sorts the routes it signs', () => {
    const rec = signHolderNode(ROOM, hint(node('a'), {
      irohRelayUrls: ['https://r5', 'https://r1', 'https://r1', 'https://r2', 'https://r3', 'https://r4'],
      irohDirectAddrs: Array.from({ length: 9 }, (_, i) => `10.0.0.${9 - i}:44442`),
    }), NOW, ann)!;
    expect(rec.relays).toEqual(['https://r1', 'https://r2', 'https://r3', 'https://r4']);
    expect(rec.addrs).toHaveLength(6);
    expect(holderNodeFromWire(rec)).toEqual(rec);
  });

  it('keeps the co-host record’s signed bytes, so an older build’s record still counts', () => {
    const rec = { v: 1 as const, node: node('a'), relays: ['https://r1'], at: NOW };
    expect(new TextDecoder().decode(holderNodeSignBytes(ROOM, 'pub-x', rec))).toBe(
      `{"k":"ssf-cohost-node:v1","roomId":"room-a","pub":"pub-x","node":"${node('a')}","relays":["https://r1"],"addrs":[],"at":${NOW}}`,
    );
    expect(HOLDER_NODES_MAP).toBe('coHostNodes');
  });
});

describe('the list a room reads', () => {
  const people = Array.from({ length: MAX_HOLDERS + 6 }, (_, i) => signer(`p${i}`));
  /** Person i filed node i, i seconds ago: p0 is the freshest. */
  const crowd = (): [string, unknown][] =>
    people.map((p, i) => [p.pub, signHolderNode(ROOM, hint(nodeN(i + 1)), NOW - i * 1000, p, false)]);

  it('puts the owner’s node first, then the most recently stamped, eight to a pass', () => {
    const owner = people[40];
    const hints = readHolderHints(crowd(), { roomId: ROOM, now: NOW, ownerPub: owner.pub });
    expect(hints).toHaveLength(MAX_HOLDER_HINTS);
    expect(hints.map((h) => h.irohNodeId)).toEqual([nodeN(41), ...Array.from({ length: 7 }, (_, i) => nodeN(i + 1))]);
  });

  it('lists the freshest sixty-four, and checks no more signatures than that', () => {
    let checks = 0;
    const counting = (pub: string, bytes: Uint8Array, sig: string): boolean => {
      checks++;
      const p = people.find((x) => x.pub === pub)!;
      return p.sign(bytes) === sig;
    };
    const all = readHolders(crowd(), { roomId: ROOM, now: NOW, verify: counting });
    expect(all).toHaveLength(MAX_HOLDERS);
    expect(checks).toBe(MAX_HOLDERS);
    expect(all[0].pub).toBe(people[0].pub);
    expect(all.some((h) => h.pub === people[MAX_HOLDERS].pub)).toBe(false);
    // The owner's stays on the list however old its stamp ranks.
    const last = people[people.length - 1];
    expect(readHolders(crowd(), { roomId: ROOM, now: NOW, ownerPub: last.pub })[0].pub).toBe(last.pub);
  });

  it('names a node once, under whoever stamped it last', () => {
    const list = readHolders(entries(
      [ann, signHolderNode(ROOM, hint(node('a')), NOW - 5000, ann)],
      [ben, signHolderNode(ROOM, hint(node('a')), NOW - 1000, ben)],
      [cat, signHolderNode(ROOM, hint(node('c')), NOW - 9000, cat)],
    ), { roomId: ROOM, now: NOW });
    expect(list.map((h) => [h.pub, h.record.node])).toEqual([[ben.pub, node('a')], [cat.pub, node('c')]]);
  });

  it('skips a record that fails its check and still fills the pass from the ones behind it', () => {
    const list = crowd();
    list[0] = [people[0].pub, { ...(list[0][1] as object), node: node('f') }];
    const hints = readHolderHints(list, { roomId: ROOM, now: NOW });
    expect(hints).toHaveLength(MAX_HOLDER_HINTS);
    expect(hints[0].irohNodeId).toBe(nodeN(2));
  });
});

describe('what a doc holds', () => {
  it('is the room’s own state only with an owner and a name on record', () => {
    const doc = new Y.Doc();
    expect(roomStateIn(doc)).toBe(false);
    doc.getMap('roomInfo').set('name', 'Lobby');
    expect(roomStateIn(doc)).toBe(false);
    doc.getMap('roomInfo').set('owner', '');
    expect(roomStateIn(doc)).toBe(false);
    doc.getMap('roomInfo').set('owner', 'player-1');
    expect(roomStateIn(doc)).toBe(true);
    // Holder records alone are not the room.
    const other = new Y.Doc();
    other.getMap(HOLDER_NODES_MAP).set(ann.pub, signHolderNode(ROOM, hint(node('a')), NOW, ann));
    expect(roomStateIn(other)).toBe(false);
  });

  it('names the owner’s key through the players entry, never for the legacy marker', () => {
    const doc = new Y.Doc();
    expect(ownerPubIn(doc)).toBeUndefined();
    doc.getMap('roomInfo').set('owner', 'player-1');
    expect(ownerPubIn(doc)).toBeUndefined();
    doc.getMap('players').set('player-1', { keyB64: ann.pub });
    expect(ownerPubIn(doc)).toBe(ann.pub);
    doc.getMap('players').set('Local-Clone', { keyB64: ben.pub });
    doc.getMap('roomInfo').set('owner', 'Local-Clone');
    expect(ownerPubIn(doc)).toBeUndefined();
  });
});

describe('refiling', () => {
  const at = (t: number, extra: { irohRelayUrls?: string[]; irohDirectAddrs?: string[] } = {}, n = node('a')) => signHolderNode(ROOM, hint(n, extra), t, ann)!;

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

  it('takes addresses off at once when they should no longer ride, and adds them at the hourly pace', () => {
    const withAddrs = at(NOW, { irohDirectAddrs: ['1.1.1.1:1'] });
    const without = at(NOW + 1000);
    expect(needsRefile(withAddrs, without, NOW + 1000)).toBe(true);
    expect(needsRefile(at(NOW), at(NOW + 1000, { irohDirectAddrs: ['1.1.1.1:1'] }), NOW + 1000)).toBe(false);
  });
});

describe('what a filer clears', () => {
  const ok = () => true;
  const rec = (who: HolderSigner, i: number, at: number) => signHolderNode(ROOM, hint(nodeN(i + 1)), at, who, false);
  const stale = (list: [string, unknown][], keep: string[] = [], verify: (p: string, b: Uint8Array, s: string) => boolean = ok) =>
    staleHolderKeys(list, { roomId: ROOM, now: NOW, keep: new Set(keep), verify });

  it('is junk and records twice the route age old, never what a slower clock still reads', () => {
    const list = entries(
      [ann, rec(ann, 0, NOW - 1000)],
      [ben, rec(ben, 1, NOW - MAX_AGE_MS - DAY)], // no longer a route, not yet cleared
      [cat, rec(cat, 2, NOW - PRUNE_AGE_MS - 1)],
    );
    list.push(['junk', { v: 9 }], ['k'.repeat(65), rec(ann, 3, NOW)]);
    expect(stale(list).sort()).toEqual([cat.pub, 'junk', 'k'.repeat(65)].sort());
  });

  it('is never the filer’s own record or the owner’s, however old or odd', () => {
    const list = entries([ann, rec(ann, 0, NOW - PRUNE_AGE_MS - DAY)], [ben, { v: 9 }], [cat, rec(cat, 2, NOW - PRUNE_AGE_MS - DAY)]);
    expect(stale(list, [ann.pub, ben.pub])).toEqual([cat.pub]);
  });

  it('is whatever lies past the freshest sixty-four, the least recent first, sixteen at a time', () => {
    const people = Array.from({ length: MAX_HOLDERS + 30 }, (_, i) => signer(`q${i}`));
    const list = people.map((p, i): [string, unknown] => [p.pub, rec(p, i, NOW - i * 1000)]);
    const me = people[0].pub;
    const cleared = stale(list, [me]);
    expect(cleared).toHaveLength(MAX_PRUNE);
    // people[0] is kept, so 63 others stay: people[1..63]. The least recent goes first.
    expect(cleared[0]).toBe(people[people.length - 1].pub);
    expect(cleared).not.toContain(people[MAX_HOLDERS - 1].pub);
    // A list of exactly sixty-four loses nobody.
    expect(stale(list.slice(0, MAX_HOLDERS), [me])).toEqual([]);
  });

  it('ranks a stamp from ahead of this clock last: it is a route for nobody yet', () => {
    const people = Array.from({ length: MAX_HOLDERS + 1 }, (_, i) => signer(`r${i}`));
    const list = people.map((p, i): [string, unknown] => [p.pub, rec(p, i, i === 5 ? NOW + DAY : NOW - i * 1000)]);
    // One too many: the one cut is the stamp from ahead, not the oldest honest one.
    expect(stale(list, [people[0].pub])).toEqual([people[5].pub]);
  });

  it('is a record whose signature is not its key’s, among the ones a reader checks', () => {
    const forged = signHolderNode(ROOM, hint(node('b')), NOW - 1000, ben)!;
    const old = { ...signHolderNode(ROOM, hint(node('c')), NOW - MAX_AGE_MS - DAY, ben)!, node: node('d') };
    const list = entries([ann, forged], [cat, old]);
    // Default verify: the real check. The old altered record is no route, so nobody checks it.
    expect(staleHolderKeys(list, { roomId: ROOM, now: NOW, keep: new Set() })).toEqual([ann.pub]);
  });
});

describe('the switch', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it('is on until the player turns it off, and on again leaves nothing behind', () => {
    const s = store();
    expect(listsThisComputer(s)).toBe(true);
    setListsThisComputer(s, false);
    expect(s.m.get(LIST_COMPUTER_KEY)).toBe('0');
    expect(listsThisComputer(s)).toBe(false);
    setListsThisComputer(s, true);
    expect(s.m.has(LIST_COMPUTER_KEY)).toBe(false);
    expect(listsThisComputer(s)).toBe(true);
  });

  it('reads as on where storage is closed, and setting it there does not throw', () => {
    const closed = { getItem: () => { throw new Error('closed'); }, setItem: () => { throw new Error('closed'); }, removeItem: () => { throw new Error('closed'); } };
    expect(listsThisComputer(closed)).toBe(true);
    expect(listsThisComputer(null)).toBe(true);
    expect(() => setListsThisComputer(closed, false)).not.toThrow();
    expect(() => setListsThisComputer(undefined, false)).not.toThrow();
  });
});

describe('the bound store', () => {
  let doc: Y.Doc;
  const holder: FilingFacts = { listed: true, holds: true, owner: false };
  const records = () => doc.getMap(HOLDER_NODES_MAP);
  beforeEach(() => {
    resetRoomHoldersForTest();
    doc = new Y.Doc();
    bindHolderNodes(doc);
  });
  afterEach(() => resetRoomHoldersForTest());

  it('files nothing until the room’s state has reached this game', () => {
    expect(fileMyHolderNode(ROOM, { ...holder, holds: false }, hint(node('a')), NOW, ann)).toBe('kept');
    expect(records().size).toBe(0);
    expect(fileMyHolderNode(ROOM, holder, null, NOW, ann)).toBe('kept');
    expect(records().size).toBe(0);
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW, ann)).toBe('filed');
    expect(holderHintsHere(ROOM, undefined, NOW)).toEqual([{ irohNodeId: node('a'), irohRelayUrls: undefined, irohDirectAddrs: undefined }]);
  });

  it('files a holder’s node once, keeps it while nothing moved, and refiles a new node at once', () => {
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW, ann)).toBe('filed');
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW + 5000, ann)).toBe('kept');
    // Records are signed for their room: none count for another.
    expect(holdersHere('room-b', undefined, NOW)).toEqual([]);
    expect(fileMyHolderNode(ROOM, holder, hint(node('b')), NOW + 6000, ann)).toBe('filed');
    expect(holdersHere(ROOM, undefined, NOW + 6000).map((h) => h.record.node)).toEqual([node('b')]);
  });

  it('leaves a visitor’s direct addresses out, and carries the owner’s', () => {
    const routes = { irohRelayUrls: ['https://relay.example'], irohDirectAddrs: ['203.0.113.5:44442'] };
    fileMyHolderNode(ROOM, holder, hint(node('a'), routes), NOW, ann);
    fileMyHolderNode(ROOM, { ...holder, owner: true, ownerPub: ben.pub }, hint(node('b'), routes), NOW, ben);
    const stored = (who: HolderSigner) => holderNodeFromWire(records().get(who.pub))!;
    expect(stored(ann).addrs).toBeUndefined();
    expect(stored(ann).relays).toEqual(['https://relay.example']);
    expect(stored(ben).addrs).toEqual(['203.0.113.5:44442']);
    // The owner's leads the pass.
    expect(holderHintsHere(ROOM, ben.pub, NOW).map((h) => h.irohNodeId)).toEqual([node('b'), node('a')]);
  });

  it('refiles over a record someone else wrote under the holder’s key', () => {
    records().set(ann.pub, signHolderNode(ROOM, hint(node('e')), NOW, ben));
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW, ann)).toBe('filed');
    expect(holdersHere(ROOM, undefined, NOW).map((h) => h.record.node)).toEqual([node('a')]);
  });

  it('takes the record down when the player switches listing off, and files afresh when on again', () => {
    fileMyHolderNode(ROOM, holder, hint(node('a')), NOW, ann);
    expect(fileMyHolderNode(ROOM, { ...holder, listed: false }, hint(node('a')), NOW, ann)).toBe('removed');
    expect(records().has(ann.pub)).toBe(false);
    expect(fileMyHolderNode(ROOM, { ...holder, listed: false }, hint(node('a')), NOW, ann)).toBe('kept');
    // Off, a game that does not hold the room yet still takes an old record down.
    records().set(ann.pub, signHolderNode(ROOM, hint(node('a')), NOW, ann));
    expect(fileMyHolderNode(ROOM, { listed: false, holds: false, owner: false }, null, NOW, ann)).toBe('removed');
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW + 1000, ann)).toBe('filed');
  });

  it('does not file again in a visit where a full list cleared its record, and does in the next', () => {
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW, ann)).toBe('filed');
    records().delete(ann.pub); // another filer's clearing arrived
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW + 1000, ann)).toBe('kept');
    expect(records().has(ann.pub)).toBe(false);
    bindHolderNodes(doc); // the next visit
    expect(fileMyHolderNode(ROOM, holder, hint(node('a')), NOW + 2000, ann)).toBe('filed');
  });

  it('clears stale records as it files, never the owner’s', () => {
    records().set('junk', { v: 9 });
    records().set(cat.pub, signHolderNode(ROOM, hint(node('c')), NOW - PRUNE_AGE_MS - DAY, cat));
    records().set(ben.pub, signHolderNode(ROOM, hint(node('b')), NOW - PRUNE_AGE_MS - DAY, ben));
    expect(fileMyHolderNode(ROOM, { ...holder, ownerPub: ben.pub }, hint(node('a')), NOW, ann)).toBe('filed');
    expect([...records().keys()].sort()).toEqual([ann.pub, ben.pub].sort());
    // Nothing moved: a later look files nothing and so clears nothing.
    records().set('junk', { v: 9 });
    expect(fileMyHolderNode(ROOM, { ...holder, ownerPub: ben.pub }, hint(node('a')), NOW + 1000, ann)).toBe('kept');
    expect(records().has('junk')).toBe(true);
  });

  it('never lends a genuine record’s cached verdict to an altered copy', () => {
    fileMyHolderNode(ROOM, holder, hint(node('a')), NOW, ann);
    expect(holdersHere(ROOM, undefined, NOW)).toHaveLength(1);
    const m = records();
    m.set(ann.pub, { ...(m.get(ann.pub) as object), node: node('f') });
    expect(holdersHere(ROOM, undefined, NOW)).toEqual([]);
  });

  it('tells its listeners when the records change, and nothing after the doc is gone', () => {
    let calls = 0;
    const stop = subscribeHolderNodes(() => { calls++; });
    fileMyHolderNode(ROOM, holder, hint(node('a')), NOW, ann);
    expect(calls).toBe(1);
    stop();
    fileMyHolderNode(ROOM, holder, hint(node('b')), NOW + 1000, ann);
    expect(calls).toBe(1);
    doc.destroy();
    expect(fileMyHolderNode(ROOM, holder, hint(node('c')), NOW + 2000, ann)).toBe('kept');
    expect(holdersHere(ROOM, undefined, NOW)).toEqual([]);
  });
});
