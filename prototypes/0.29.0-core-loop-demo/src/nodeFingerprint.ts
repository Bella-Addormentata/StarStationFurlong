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
  /** #231 P6b: whether the node hands out its contact card at all (a durable
   *  contact key and `SSF_CHIA_SHARE_CARD` not `0`). Absent from older nodes,
   *  which `nodeSharesCard` (roomCap.ts) reads as sharing. */
  share_card?: boolean;
  /** ⛓️🏦 The node's testnet11 receive address (`txch1…`) while it has a
   *  wallet loaded (the publish build with `SSF_CHIA_LANE=1`): where TXCH is
   *  sent to fund the node's chain writes. Shown by the Bank app with COPY
   *  and a QR code; absent from read-only nodes and older ones. Kept only
   *  when it has the shape of a testnet11 address (`isTestnetAddress`). */
  chia_address?: string;
  /** 📖 How the node's Phone Book listing stands (its per-node presence
   *  record on Chia, #231 P6a), for the top bar's icon (phoneBook.ts): green
   *  when the current addresses are listed, grey when an older listing has
   *  gone stale. Present only while the node publishes presence (the publish
   *  build with a wallet, a durable contact key and `SSF_CHIA_FINDABLE` not
   *  `0`) and has ticked once; kept only in the node's shape
   *  (`parseChiaPresence`). */
  chia_presence?: ChiaPresence;
  /** 📦 This launch's blob-lane token (64 hex): what the node's `/blob` and
   *  `/api/blob/` routes ask for beside an allowed Origin (blobLane.ts).
   *  Absent while the node runs without the lane, and from older nodes. */
  blob_cap?: string;
  /** 🧲 The node was built with the `torrent` feature and its blob lane is
   *  running: the TV's TORRENT tile can hand it a magnet (torrentLane.ts). */
  torrent?: boolean;
}

/** 📖 The four looks of the phone book: this edition's listing confirmed
 *  with the current addresses (`listed`), out but not yet read back (`sent`),
 *  a listing of ours that is stale (`outdated`: an older edition, other
 *  addresses, no chain peak to judge by), none of ours (`unlisted`). */
export type ChiaPresenceState = 'listed' | 'sent' | 'outdated' | 'unlisted';

/** The node's readout (`ChiaPresence` in ssf-p2p-node main.rs): `era` is the
 *  current edition by the agreed peak (0 while none is agreed), `listed_era`
 *  and `last_at` describe the listing on record (0 when there is none),
 *  `confirmed` says the chain showed it back, `current` that it names this
 *  edition and these addresses, `public_addrs` how many the node would list
 *  now, and `error` is the last failed attempt's text when there is one. */
export interface ChiaPresence {
  state: ChiaPresenceState;
  era: number;
  listed_era: number;
  last_at: number;
  confirmed: boolean;
  current: boolean;
  public_addrs: number;
  error?: string;
}

const PRESENCE_STATES: ReadonlySet<string> = new Set<ChiaPresenceState>(['listed', 'sent', 'outdated', 'unlisted']);

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** The node's `chia_presence` in its own shape, or undefined for anything
 *  else: an unknown state, a count that is not a non-negative integer, a flag
 *  that is not a boolean, or an error that is not a string. A readout the
 *  page cannot trust is no readout: the icon stays hidden rather than guess. */
export function parseChiaPresence(v: unknown): ChiaPresence | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (typeof r.state !== 'string' || !PRESENCE_STATES.has(r.state)) return undefined;
  if (!isCount(r.era) || !isCount(r.listed_era) || !isCount(r.last_at) || !isCount(r.public_addrs)) return undefined;
  if (typeof r.confirmed !== 'boolean' || typeof r.current !== 'boolean') return undefined;
  if (r.error !== undefined && typeof r.error !== 'string') return undefined;
  const p: ChiaPresence = {
    state: r.state as ChiaPresenceState,
    era: r.era,
    listed_era: r.listed_era,
    last_at: r.last_at,
    confirmed: r.confirmed,
    current: r.current,
    public_addrs: r.public_addrs,
  };
  if (typeof r.error === 'string') p.error = r.error;
  return p;
}

/** A testnet11 standard-puzzle address: the `txch` prefix, the bech32m
 *  separator and 58 bech32 characters (52 for 32 bytes of puzzle hash, 6 of
 *  checksum). The character set is bech32's (no `1`, `b`, `i`, `o`); the
 *  checksum itself is the node's to verify, this is the shape check that
 *  keeps a stray string out of the Bank app's QR. */
const TESTNET_ADDRESS = /^txch1[02-9ac-hj-np-z]{58}$/;

export function isTestnetAddress(v: unknown): v is string {
  return typeof v === 'string' && TESTNET_ADDRESS.test(v);
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
  if (typeof r.share_card === 'boolean') fp.share_card = r.share_card;
  if (isTestnetAddress(r.chia_address)) fp.chia_address = r.chia_address;
  const presence = parseChiaPresence(r.chia_presence);
  if (presence) fp.chia_presence = presence;
  if (typeof r.blob_cap === 'string' && /^[0-9a-f]{64}$/.test(r.blob_cap)) fp.blob_cap = r.blob_cap;
  if (r.torrent === true) fp.torrent = true;
  return fp;
}
