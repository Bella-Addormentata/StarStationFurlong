/**
 * 🤝 A node's proof that it built a room-sync frame (C3, #332 review): the
 * bytes it signs, the check, and the readiness gate it opens for a room whose
 * owner's game is closed but whose keepers' nodes still serve it.
 */
import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { CO_HOST_NODES_MAP, keeperNodeTrust, keeperNodesIn, signCoHostNode, type CoHostSigner } from '../coHostNodes';
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
function identity(name: string): CoHostSigner {
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

/** A room doc whose owner filed `node` as theirs. */
function roomKeptBy(owner: CoHostSigner, node: ReturnType<typeof nodeKey>, now: number): Y.Doc {
  const doc = new Y.Doc();
  doc.getMap('roomInfo').set('owner', 'player-1');
  doc.getMap('roomInfo').set('name', 'Kept');
  doc.getMap('players').set('player-1', { keyB64: owner.pub });
  const record = signCoHostNode(ROOM, { irohNodeId: node.id }, now - 1000, owner)!;
  doc.getMap(CO_HOST_NODES_MAP).set(owner.pub, record);
  return doc;
}

describe('🤝 a node’s proof', () => {
  it('signs the bytes the node signs (main.rs node_state_sign_bytes)', () => {
    expect(bytesToHex(nodeStateSignBytes('room-a', 7, 1234, new Uint8Array([0, 1])))).toBe(
      '7373662d6e6f64652d73746174653a76310a313233340a792e371c081e586fe3427f6b24296df18572cec235d7e93d744ad676fa4c423f',
    );
  });

  it('names the node that proved the frame, for this room, sequence and bytes, while fresh', () => {
    const node = nodeKey('keeper');
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

describe('🤝 the nodes that keep a room', () => {
  it('are the owner’s and the co-hosts’, each filed under its own key for this room', () => {
    const now = Date.now();
    const owner = identity('owner');
    const coHost = identity('co-host');
    const stranger = identity('stranger');
    const [n1, n2, n3] = [nodeKey('1'), nodeKey('2'), nodeKey('3')];
    const doc = roomKeptBy(owner, n1, now);
    doc.getMap('coHosts').set(coHost.pub, { pub: coHost.pub, name: 'Co', grantedAt: now - 5000 });
    doc.getMap(CO_HOST_NODES_MAP).set(coHost.pub, signCoHostNode(ROOM, { irohNodeId: n2.id }, now - 1000, coHost)!);
    // A stranger's record counts for nothing, nor one signed for another room.
    doc.getMap(CO_HOST_NODES_MAP).set(stranger.pub, signCoHostNode(ROOM, { irohNodeId: n3.id }, now - 1000, stranger)!);
    expect([...keeperNodesIn(doc, ROOM, now)].sort()).toEqual([n1.id, n2.id].sort());
    expect(keeperNodesIn(doc, 'room-other', now).size).toBe(0);
    // A new owner: the old owner's record no longer counts.
    doc.getMap('players').set('player-2', { keyB64: stranger.pub });
    doc.getMap('roomInfo').set('owner', 'player-2');
    expect([...keeperNodesIn(doc, ROOM, now)].sort()).toEqual([n2.id, n3.id].sort());
    // The legacy marker names no player, so no owner.
    doc.getMap('roomInfo').set('owner', 'Local-Clone');
    expect([...keeperNodesIn(doc, ROOM, now)]).toEqual([n2.id]);
  });
});

describe('🤝 a room whose owner’s game is closed', () => {
  async function visit(reply: Record<string, unknown>, opts: { linked?: boolean } = {}) {
    let toClient!: ReadableStreamDefaultController<Uint8Array>;
    const channel = {
      readable: new ReadableStream<Uint8Array>({ start: (c) => { toClient = c; } }),
      writable: new WritableStream<Uint8Array>(),
    };
    const sync = new YjsSync({ roomId: ROOM, channel, bootRecord: () => ({}), verify, ...keeperNodeTrust });
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

  it('not from another node, an unproved or stale frame, or before the link', async () => {
    const owner = identity('owner');
    const node = nodeKey('owner-node');
    const now = Date.now();
    const state = Y.encodeStateAsUpdate(roomKeptBy(owner, node, now));
    expect((await visit(nodeReply(state, nodeKey('visitor-node'), now).env)).linked).toBe(false);
    expect((await visit(nodeReply(state, null, now).env)).linked).toBe(false);
    expect((await visit(nodeReply(state, node, now - NODE_PROOF_SKEW_MS - 60_000).env)).linked).toBe(false);
    expect((await visit(nodeReply(state, node, now).env, { linked: false })).linked).toBe(false);
  });
});
