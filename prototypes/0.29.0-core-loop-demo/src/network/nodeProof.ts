/**
 * 🤝 A node's proof that it built a room-sync frame from its own copy of the
 * room (durability C3; #332's late review).
 *
 * Why: a tab counts a remote room as synced (`YjsSync.linkedSynced`, which
 * gates board trims and merges, the route keeper and far-door writes) only on
 * a frame its host's live browser signed. With the owner's game closed, the
 * room's state still comes from nodes that keep it: the owner's, and each
 * co-host's. Their SyncStep2 answers carried no author and no signature, so a
 * visitor's tab waited for a browser that never came. Now a node signs the
 * SyncStep2 it builds for a peer (ssf-p2p-node `node_proof`): its iroh key
 * over a stamp and the frame's canonical bytes. The tab takes it as the
 * room's own state only when the node is one the room's owner or a co-host
 * filed as theirs (coHostNodes.ts `keeperNodesIn`), and the stamp is fresh.
 *
 * What it proves: which node built the frame, for which room, sequence and
 * bytes, and roughly when. Relays can't change it, and a peer can't pass its
 * own frame off as a keeper's. What it doesn't: that the node's copy is
 * complete. That is the same trust a member's signed frame already earns.
 */

import { canonicalSignBytes } from './signBytes';

/** How far a proof's stamp may be from this clock. */
export const NODE_PROOF_SKEW_MS = 10 * 60_000;

const NODE_RE = /^[0-9a-f]{64}$/;

/** The bytes a node signs for a frame (main.rs `node_state_sign_bytes`). */
export function nodeStateSignBytes(roomId: string, seq: number, at: number, payload: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(`ssf-node-state:v1\n${at}\n`);
  const canonical = canonicalSignBytes(1, roomId, 'ysync', seq, payload);
  const out = new Uint8Array(head.length + canonical.length);
  out.set(head, 0);
  out.set(canonical, head.length);
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export interface NodeProofEnvelope {
  seq?: unknown;
  iroh_node_id?: unknown;
  node_proof?: unknown;
}

/** The node that proved this frame, or null: the proof's stamp within
 *  NODE_PROOF_SKEW_MS of `now` and its signature good under the node id the
 *  frame names, over this room's canonical bytes. */
export function nodeProofSigner(
  env: NodeProofEnvelope,
  roomId: string,
  payload: Uint8Array,
  now: number,
  verify: (pub: Uint8Array, bytes: Uint8Array, sig: Uint8Array) => boolean,
  b64ToU8: (s: string) => Uint8Array,
): string | null {
  const node = env.iroh_node_id;
  const proof = env.node_proof as { at?: unknown; sig?: unknown } | null | undefined;
  if (typeof node !== 'string' || !NODE_RE.test(node) || !proof || typeof proof !== 'object') return null;
  const { at, sig } = proof;
  if (!Number.isSafeInteger(at) || Math.abs((at as number) - now) > NODE_PROOF_SKEW_MS) return null;
  if (typeof sig !== 'string' || sig.length === 0 || sig.length > 128) return null;
  if (!Number.isSafeInteger(env.seq)) return null;
  try {
    const sigBytes = b64ToU8(sig);
    if (sigBytes.length !== 64) return null;
    return verify(hexToBytes(node), nodeStateSignBytes(roomId, env.seq as number, at as number, payload), sigBytes) ? node : null;
  } catch {
    return null;
  }
}
