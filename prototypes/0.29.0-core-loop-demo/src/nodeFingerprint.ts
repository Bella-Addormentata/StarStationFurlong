/**
 * The local node's `/api/fingerprint` answer, checked against the node's own
 * contract before anything is built on it — the WebTransport certificate
 * hash, the reachability row, and (tvConsent.ts) the trust that media from
 * the node's HTTP origin is this machine serving this viewer.
 *
 * The contract (ssf-p2p-node `compute_fingerprint`): `hex` is the SHA-256
 * of the node's certificate, 64 hex digits; `base64` is the SAME 32 bytes
 * in standard base64 (44 characters, one `=`); `port` is the WebTransport
 * port, a u16. The rest is optional (the Tauri fallback listener omits the
 * iroh fields) and is normalised, never required.
 *
 * Why it is checked at all: the node's port is a loopback port like any
 * other, and the page probes 8080 then 8081. A stranger on 8080 answering
 * `{}` must not end the probe before the node on 8081 is tried, and one
 * answering `{ hex: true }` must not pass as the node and have its origin
 * trusted. A matching shape says the answer is a fingerprint, not that the
 * answerer is honest — a service impersonating the node deliberately is
 * out of this check's reach, as it is out of any check's that the page can
 * make from here.
 */

export interface LocalFingerprint {
  hex: string;
  base64: string;
  port: number;
  iroh_node_id?: string;
  iroh_relay_urls?: string[];
  iroh_direct_addrs?: string[];
  /** R1: live reachability classification from the node —
   *  'port-mapped' | 'advertised' | 'cgnat' | 'local-only'.
   *  Optional: the Tauri fallback listener's fingerprint omits it. */
  reachability?: string;
  /** R1: the iroh UDP port ACTUALLY bound (post random-port fallback) —
   *  the port a router forward must target. */
  iroh_port?: number;
}

const HEX_32 = /^[0-9a-f]{64}$/i;
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function isPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535;
}

/** The 32 bytes `base64` carries, or null when it is not 32 bytes of base64. */
function decode32(b64: string): Uint8Array | null {
  if (!BASE64_32.test(b64)) return null;
  try {
    const bin = atob(b64);
    if (bin.length !== 32) return null;
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The answer as a fingerprint, or null when it is not one: not an object,
 *  a `hex` that is not 32 bytes of hex, a `base64` that is not the same 32
 *  bytes, or a `port` that is not a port. */
export function parseNodeFingerprint(body: unknown): LocalFingerprint | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  if (typeof r.hex !== 'string' || !HEX_32.test(r.hex)) return null;
  if (typeof r.base64 !== 'string') return null;
  const bytes = decode32(r.base64);
  if (!bytes) return null;
  const hex = r.hex.toLowerCase();
  for (let i = 0; i < 32; i++) {
    if (bytes[i] !== parseInt(hex.slice(i * 2, i * 2 + 2), 16)) return null;
  }
  if (!isPort(r.port)) return null;
  const fp: LocalFingerprint = { hex, base64: r.base64, port: r.port };
  if (typeof r.iroh_node_id === 'string') fp.iroh_node_id = r.iroh_node_id;
  const relays = stringArray(r.iroh_relay_urls);
  if (relays) fp.iroh_relay_urls = relays;
  const addrs = stringArray(r.iroh_direct_addrs);
  if (addrs) fp.iroh_direct_addrs = addrs;
  if (typeof r.reachability === 'string') fp.reachability = r.reachability;
  if (typeof r.iroh_port === 'number' && Number.isInteger(r.iroh_port) && r.iroh_port >= 0 && r.iroh_port <= 65535) {
    fp.iroh_port = r.iroh_port;
  }
  return fp;
}
