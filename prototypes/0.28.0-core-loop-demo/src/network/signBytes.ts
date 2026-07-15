/**
 * 🔏 Canonical envelope sign-bytes (keyed-identity Slice 2 — the sign seam core)
 *
 * What gets signed for a state-mutating ysync envelope. Binds v ‖ roomId ‖ kind
 * ‖ seq ‖ payload under a domain tag, so a signature:
 *   - can't be replayed into a DIFFERENT room (roomId bound) — closes the gap
 *     where the old `opts.sign(payload)` covered the payload ONLY;
 *   - can't be replayed as a different message KIND (kind bound);
 *   - is pinned to its sequence position (seq bound).
 * The fields are newline-separated after a versioned domain tag; roomId/kind
 * never contain newlines (room ids are `furlong-lobby` / `dm-<hex>`, kind is a
 * fixed token), so the encoding is unambiguous. blake3 gives a fixed 32-byte
 * digest to sign (Ed25519 would hash internally anyway; blake3 matches the
 * node's chia_lane canonicalization and keeps the signed object small).
 */

import { blake3 } from '@noble/hashes/blake3';

export function canonicalSignBytes(
  v: number,
  roomId: string,
  kind: string,
  seq: number,
  payload: Uint8Array,
): Uint8Array {
  const header = new TextEncoder().encode(`ssf-env:v1\n${v}\n${roomId}\n${kind}\n${seq}\n`);
  const buf = new Uint8Array(header.length + payload.length);
  buf.set(header, 0);
  buf.set(payload, header.length);
  return blake3(buf);
}
