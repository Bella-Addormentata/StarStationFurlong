// Stands in for '@noble/hashes/sha256' inside the fold bundle (see
// build-fold-bundle.mjs): the host's sha256 (globalThis.__ssf_sha256:
// Uint8Array | string -> Uint8Array) when the host gives one, else noble's
// own. Decided once, when the bundle is evaluated. A fold makes about 1.3
// hashes a record; noble's in QuickJS is about 170 times slower than the
// host's.
import { sha256 as nobleSha256, SHA256 } from '@noble/hashes/sha2';

const host = globalThis.__ssf_sha256;
export const sha256 =
  typeof host === 'function' ? Object.assign((m) => host(m), nobleSha256) : nobleSha256;
export { SHA256 };
