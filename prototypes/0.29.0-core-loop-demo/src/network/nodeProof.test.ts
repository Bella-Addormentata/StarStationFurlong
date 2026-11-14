/**
 * 🤝 A node's proof that it built a room-sync frame (C3, #332 review): the
 * bytes it signs, the check, and the readiness gate it opens for a room whose
 * owner's game is closed but which other computers that hold it still serve.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { HOLDER_NODES_MAP, MAX_AGE_MS, MAX_HOLDERS, holderNodeOk, holderNodeTrust, holderNodesIn, setLocalHolderNode, signHolderNode, type HolderSigner } from '../roomHolders';
import { NODE_PROOF_SKEW_MS, nodeProofSigner, nodeStateSignBytes } from './nodeProof';
import { YjsSync } from './YjsSync';

ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array): string => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const verify = (pub: Uint8Array, bytes: Uint8Array, sig: Uint8Array): boolean => {
  try { return ed.verify(sig, bytes, pub); } catch { return false; }
};

const ROOM = 'room-k';

/** A node: its iroh-style id (hex of its ed25519 key) and its signer. */
function nodeKey(name: string) {
  const seed = sha256(utf8ToBytes(`ssf-node-test|${name}`));
  return { id: bytesToHex(ed.getPublicKey(seed)), sign: (bytes: Uint8Array) => ed.sign(bytes, seed) };
}

/** A player's identity, as the tabs keep one. */
function identity(name: string): HolderSigner {
  const seed = sha256(utf8ToBytes(`ssf-identity-test|${name}`));
  return { pub: b64url(ed.getPublicKey(seed)), sign: (bytes) => b64url(ed.sign(bytes, seed)) };
}

const varUint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
};

const syncStep2 = (state: Uint8Array): Uint8Array =>
  new Uint8Array([...varUint(0), ...varUint(1), ...varUint(state.length), ...state]);

/** A node's SyncStep2 envelope, proved by `node` at `at` unless told not to. */
function nodeReply(state: Uint8Array, node: ReturnType<typeof nodeKey> | null, at: number, opts: { room?: string; seq?: number; claim?: string } = {}) {
  const payload = syncStep2(state);
  const seq = opts.seq ?? 3;
  const env: Record<string, unknown> = { v: 1, room: ROOM, kind: 'ysync', seq, author: '', payload: b64(payload), sig: null };
  if (node) {
    env.iroh_node_id = opts.claim ?? node.id;
    env.node_proof = { at, sig: b64(node.sign(nodeStateSignBytes(opts.room ?? ROOM, seq, at, payload))) };
  }
  return { env, payload };
}

/** A room doc (an owner, a name) whose owner filed `node` as theirs. */
function roomKeptBy(owner: HolderSigner, node: ReturnType<typeof nodeKey>, now: number): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('roomInfo').set('owner', 'player-1');
  doc.getMap('roomInfo').set('name', 'Kept');
  doc.getMap('players').set('player-1', { keyB64: owner.pub });
  file(doc, owner, node, now - 1000);
  return doc;
}

/** `who` files `node` as theirs in `doc`, stamped `at`. */
function file(doc: Y.Doc, who: HolderSigner, node: ReturnType<typeof nodeKey>, at: number, room = ROOM): void {
  doc.getMap(HOLDER_NODES_MAP).set(who.pub, signHolderNode(room, { irohNodeId: node.id }, at, who, false)!);
}

describe('🤝 a node’s proof', () => {
  it('signs the bytes the node signs (main.rs node_state_sign_bytes)', () => {
    expect(bytesToHex(nodeStateSignBytes('room-a', 7, 1234, new Uint8Array([0, 1])))).toBe(
      '7373662d6e6f64652d73746174653a76310a313233340a792e371c081e586fe3427f6b24296df18572cec235d7e93d744ad676fa4c423f',
    );
  });

  it('names the node that proved the frame, for this room, sequence and bytes, while fresh', () => {
    const node = nodeKey('holder');
    const now = 1_800_000_000_000;
    const { env, payload } = nodeReply(new Uint8Array([1, 2, 3]), node, now - 1000);
    expect(nodeProofSigner(env, ROOM, payload, now, verify, unb64)).toBe(node.id);
    expect(nodeProofSigner(env, 'room-other', payload, now, verify, unb64)).toBeNull();
    expect(nodeProofSigner({ ...env, seq: 4 }, ROOM, payload, now, verify, unb64)).toBeNull();
    expect(nodeProofSigner(env, ROOM, syncStep2(new Uint8Array([9])), now, verify, unb64)).toBeNull();
    expect(nodeProofSigner(env, ROOM, payload, now + NODE_PROOF_SKEW_MS + 2000, verify, unb64)).toBeNull();
    // Another node's id over this node's signature, and junk.
    expect(nodeProofSigner({ ...env, iroh_node_id: nodeKey('other').id }, ROOM, payload, now, verify, unb64)).toBeNull();
    expect(nodeProofSigner({ ...env, node_proof: { at: now, sig: 'x' } }, ROOM, payload, now, verify, unb64)).toBeNull();
    expect(nodeProofSigner({ ...env, node_proof: undefined }, ROOM, payload, now, verify, unb64)).toBeNull();
  });
});

describe('🤝 the nodes that hold a room', () => {
  it('are everyone’s who filed one under their own key for this room: nobody is picked', () => {
    const now = Date.now();
    const owner = identity('owner');
    const visitor = identity('visitor');
    const other = identity('other');
    const [n1, n2, n3, n4] = [nodeKey('1'), nodeKey('2'), nodeKey('3'), nodeKey('4')];
    const doc = roomKeptBy(owner, n1, now);
    file(doc, visitor, n2, now - 1000);
    // Signed for another room, or by another key than the one it is filed under: nothing.
    file(doc, other, n3, now - 1000, 'room-other');
    doc.getMap(HOLDER_NODES_MAP).set('someone', signHolderNode(ROOM, { irohNodeId: n4.id }, now - 1000, other)!);
    expect([...holderNodesIn(doc, ROOM, now)].sort()).toEqual([n1.id, n2.id].sort());
    expect([...holderNodesIn(doc, 'room-other', now)]).toEqual([n3.id]);
    // A new owner changes nothing: the old owner's computer still holds the room.
    doc.getMap('players').set('player-2', { keyB64: visitor.pub });
    doc.getMap('roomInfo').set('owner', 'player-2');
    expect([...holderNodesIn(doc, ROOM, now)].sort()).toEqual([n1.id, n2.id].sort());
    // The old grant maps are not read: a co-host grant adds nobody.
    doc.getMap('coHosts').set(other.pub, { pub: other.pub, name: 'Co', grantedAt: now - 5000 });
    expect(holderNodesIn(doc, ROOM, now).size).toBe(2);
  });

  it('are every listed holder’s, past the eight a pass carries, and no more than the list', () => {
    const now = Date.now();
    const owner = identity('owner');
    const ownerNode = nodeKey('owner');
    const doc = roomKeptBy(owner, ownerNode, now);
    const nodes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const n = nodeKey(`h-${i}`);
      nodes.push(n.id);
      file(doc, identity(`h-${i}`), n, now - 2000 - i);
    }
    const ten = holderNodesIn(doc, ROOM, now);
    expect(ten.size).toBe(11);
    expect(ten.has(nodes[9])).toBe(true);
    // A crowd: the freshest of the list, and always the owner's.
    for (let i = 10; i < MAX_HOLDERS + 10; i++) {
      const n = nodeKey(`h-${i}`);
      nodes.push(n.id);
      file(doc, identity(`h-${i}`), n, now - 2000 - i);
    }
    const crowd = holderNodesIn(doc, ROOM, now);
    expect(crowd.size).toBe(MAX_HOLDERS);
    expect(crowd.has(ownerNode.id)).toBe(true);
    expect(crowd.has(nodes[0])).toBe(true);
    expect(crowd.has(nodes[nodes.length - 1])).toBe(false);
  });
});

describe('🤝 whether a proved copy counts as the room', () => {
  it('never while the copy is empty, whoever proved it', () => {
    const now = Date.now();
    const visitor = identity('visitor');
    const n = nodeKey('n');
    // A node that only registered the room: records at most, no owner, no name.
    const doc = new Y.Doc();
    file(doc, visitor, n, now - 1000);
    expect(holderNodesIn(doc, ROOM, now).has(n.id)).toBe(true);
    expect(holderNodeOk(n.id, doc, ROOM, now, visitor.pub)).toBe(false);
    doc.getMap('roomInfo').set('name', 'Half');
    expect(holderNodeOk(n.id, doc, ROOM, now, visitor.pub)).toBe(false);
    doc.getMap('roomInfo').set('owner', 'player-1');
    expect(holderNodeOk(n.id, doc, ROOM, now, visitor.pub)).toBe(true);
  });

  it('from any listed holder’s node, and from no node nobody filed', () => {
    const now = Date.now();
    const owner = identity('owner');
    const visitor = identity('visitor');
    const [n1, n2] = [nodeKey('1'), nodeKey('2')];
    const doc = roomKeptBy(owner, n1, now);
    file(doc, visitor, n2, now - 1000);
    const me = identity('me').pub;
    expect(holderNodeOk(n1.id, doc, ROOM, now, me)).toBe(true);
    expect(holderNodeOk(n2.id, doc, ROOM, now, me)).toBe(true);
    expect(holderNodeOk(nodeKey('3').id, doc, ROOM, now, me)).toBe(false);
    // A record too old to be a route no longer counts for others.
    file(doc, visitor, n2, now - MAX_AGE_MS - 60_000);
    expect(holderNodeOk(n2.id, doc, ROOM, now, me)).toBe(false);
  });

  it('from this machine’s own node for the owner, and for a player whose own record names it', () => {
    const now = Date.now();
    const owner = identity('owner');
    const back = identity('back-after-a-long-while');
    const visitor = identity('visitor');
    const mine = nodeKey('mine');
    const doc = roomKeptBy(owner, nodeKey('owner'), now);
    try {
      // No node known on this machine: nothing.
      setLocalHolderNode(null);
      expect(holderNodeOk(mine.id, doc, ROOM, now, owner.pub)).toBe(false);
      setLocalHolderNode(mine.id);
      // The owner's own node, filed nowhere (a room their machine did not start).
      expect(holderNodeOk(mine.id, doc, ROOM, now, owner.pub)).toBe(true);
      expect(holderNodesIn(doc, ROOM, now).has(mine.id)).toBe(false);
      // A visitor's own node gains nothing: it has no record of theirs to show.
      expect(holderNodeOk(mine.id, doc, ROOM, now, visitor.pub)).toBe(false);
      // A holder back after the route age: their old record is no route for
      // anyone else, and still lets their own node reopen the room for them.
      file(doc, back, mine, now - 3 * MAX_AGE_MS);
      expect(holderNodesIn(doc, ROOM, now).has(mine.id)).toBe(false);
      expect(holderNodeOk(mine.id, doc, ROOM, now, back.pub)).toBe(true);
      expect(holderNodeOk(mine.id, doc, ROOM, now, visitor.pub)).toBe(false);
      // Not for another node than this machine's, a record naming another
      // node, or one somebody else wrote under their key.
      expect(holderNodeOk(nodeKey('other').id, doc, ROOM, now, back.pub)).toBe(false);
      file(doc, back, nodeKey('elsewhere'), now - 3 * MAX_AGE_MS);
      expect(holderNodeOk(mine.id, doc, ROOM, now, back.pub)).toBe(false);
      doc.getMap(HOLDER_NODES_MAP).set(back.pub, signHolderNode(ROOM, { irohNodeId: mine.id }, now - 3 * MAX_AGE_MS, visitor)!);
      expect(holderNodeOk(mine.id, doc, ROOM, now, back.pub)).toBe(false);
      // Not a node id at all: none is kept.
      setLocalHolderNode('not-a-node');
      expect(holderNodeOk(mine.id, doc, ROOM, now, owner.pub)).toBe(false);
    } finally {
      setLocalHolderNode(null);
    }
  });
});

describe('🤝 a room whose owner’s game is closed', () => {
  async function visit(reply: Record<string, unknown>, opts: { linked?: boolean } = {}) {
    let toClient!: ReadableStreamDefaultController<Uint8Array>;
    const channel = {
      readable: new ReadableStream<Uint8Array>({ start: (c) => { toClient = c; } }),
      writable: new WritableStream<Uint8Array>(),
    };
    const sync = new YjsSync({ roomId: ROOM, channel, bootRecord: () => ({}), verify, ...holderNodeTrust });
    await sync.start();
    if (opts.linked !== false) sync.markPeerLinked();
    const json = new TextEncoder().encode(JSON.stringify(reply));
    const frame = new Uint8Array(4 + json.length);
    new DataView(frame.buffer).setUint32(0, json.length, true);
    frame.set(json, 4);
    toClient.enqueue(frame);
    await sync.whenServerSynced;
    const result = { linked: sync.linkedSynced, name: sync.doc.getMap('roomInfo').get('name') };
    await sync.stop();
    toClient.close();
    return result;
  }

  it('counts as synced from the node its owner filed, the record arriving in that very frame', async () => {
    const owner = identity('owner');
    const node = nodeKey('owner-node');
    const now = Date.now();
    const state = Y.encodeStateAsUpdate(roomKeptBy(owner, node, now));
    expect(await visit(nodeReply(state, node, now).env)).toEqual({ linked: true, name: 'Kept' });
  });

  it('and from any other computer that holds it, with nobody having picked that computer', async () => {
    const owner = identity('owner');
    const visitor = identity('earlier-visitor');
    const theirs = nodeKey('earlier-visitor-node');
    const now = Date.now();
    const doc = roomKeptBy(owner, nodeKey('owner-node'), now);
    file(doc, visitor, theirs, now - 1000);
    expect(await visit(nodeReply(Y.encodeStateAsUpdate(doc), theirs, now).env)).toEqual({ linked: true, name: 'Kept' });
  });

  it('not from a node nobody filed, an unproved or stale frame, or before the link', async () => {
    const owner = identity('owner');
    const node = nodeKey('owner-node');
    const now = Date.now();
    const state = Y.encodeStateAsUpdate(roomKeptBy(owner, node, now));
    expect((await visit(nodeReply(state, nodeKey('visitor-node'), now).env)).linked).toBe(false);
    expect((await visit(nodeReply(state, null, now).env)).linked).toBe(false);
    expect((await visit(nodeReply(state, node, now - NODE_PROOF_SKEW_MS - 60_000).env)).linked).toBe(false);
    expect((await visit(nodeReply(state, node, now).env, { linked: false })).linked).toBe(false);
  });

  it('not from a filed node whose copy is empty (a computer still waiting for the room itself)', async () => {
    const waiting = identity('waiting');
    const node = nodeKey('waiting-node');
    const now = Date.now();
    const empty = new Y.Doc();
    file(empty, waiting, node, now - 1000);
    expect((await visit(nodeReply(Y.encodeStateAsUpdate(empty), node, now).env)).linked).toBe(false);
    // A node with nothing at all proves its empty reply too.
    expect((await visit(nodeReply(Y.encodeStateAsUpdate(new Y.Doc()), node, now).env)).linked).toBe(false);
  });
});
