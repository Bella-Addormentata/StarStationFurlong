/**
 * Shared protocol contracts — the v006 §12.2 seams as compilable code.
 *
 * This file is dependency-free by design: it defines the shapes every network
 * adapter (WebTransport primary, iroh-WASM fallback, offline/sneakernet) must
 * satisfy, plus the 13-byte movement-tick codec from the Phase 1 plan.
 *
 * Architecture references:
 *  - STUDY-Architecture v006 §8.1 (three motion lanes), §12.2 (handshake)
 *  - STUDY-Architecture v005 §12.2 (SsfEnvelope, ports — unchanged per v006 §12.6)
 *  - Phase1-ExecutionPlan Sprint 3 (tasks 3.1–3.4)
 */

// ---------------------------------------------------------------------------
// Envelope — the only message shape on every transport (GPT-5.5 v004 §4.3)
// ---------------------------------------------------------------------------

export type EnvelopeKind =
  | 'tick'       // movement — datagram lane ONLY (v006 §8.1)
  | 'awareness'  // DISCRETE presence only: join/leave, name, typing, speaking
  | 'ysync'      // y-sync bytes (SyncStep1/SyncStep2/Update)
  | 'roomlog'    // append-only social-log ops (Phase 2+; stub in Phase 1)
  | 'asset'      // content-addressed blob requests/chunks
  | 'cap'        // capability handshake (ClientHello / NodeAck)
  | 'ping'       // comms-weather probe — Chrome has no WT getStats() (v006 §3.8)
  | 'pong';

export interface SsfEnvelope {
  v: 1;
  room: string;
  kind: EnvelopeKind;
  seq: number;               // per-sender, per-kind
  author: Uint8Array;        // Ed25519 public key (32 bytes)
  payload: Uint8Array;       // body (y-sync bytes, CBOR/MessagePack op, …)
  sig?: Uint8Array;          // REQUIRED for state-mutating kinds (v005 §12.4)
  iroh_node_id?: string;     // Carry sender's Iroh Node ID for automatic hole-punch back-dialing
  iroh_relay_urls?: string[];
  iroh_direct_addrs?: string[];
}

// ---------------------------------------------------------------------------
// Transport capability ladder (v004 §6.3, carried through v006)
// ---------------------------------------------------------------------------

export type TransportMode =
  | 'direct-unreliable'   // WT datagrams — full gameplay
  | 'direct-reliable'     // WT streams only (UDP datagrams unavailable)
  | 'relayed-unreliable'  // via relay, datagrams survive
  | 'relayed-reliable'    // via relay, reliable only — chat/CRDT/intents, no voice
  | 'store-forward'       // no realtime — boards, contracts, mail
  | 'offline';            // local only — sneakernet/QR export

/** Surfaced diegetically as "station records backed up" (v006 §12.6). */
export interface DurabilityState {
  replicas: number;      // co-hosts holding the latest sealed state
  sealedEpoch: number;   // 0 until Station Seals land (Phase 3)
  pinned: boolean;
}

export interface NetworkStats {
  rttMs: number;
  loss: number;          // 0..1, from the ping/pong probe
}

/** Join string / QR payload: URL + certhash(es) + challenge (v006 §12.2). */
export interface RoomMemberHint {
  irohNodeId: string;
  irohRelayUrls?: string[];
  irohDirectAddrs?: string[];
}

/**
 * Room bootstrap ticket.
 *
 * v1 fields are preserved for compatibility with older links.
 * v2 adds room-key-first identity and member hint lists.
 */
export interface RoomBootstrap {
  v?: 1 | 2;
  roomId: string;
  wtUrl: string;                 // https://<host>:<port>/ssf
  certHashesB64: string[];       // staged current/next SHA-256, base64
  challenge?: Uint8Array;        // room-scoped; answered in ClientHello
  relays?: string[];             // legacy iroh-relay hints (v1)
  irohNodeId?: string;           // legacy single-peer hint (v1)
  irohRelayUrls?: string[];      // legacy single-peer relay hints (v1)
  irohDirectAddrs?: string[];    // legacy single-peer direct addr hints (v1)

  // v2 room-key-first fields
  roomKeyB64?: string;
  memberHints?: RoomMemberHint[];
  issuedAt?: number;
  expiresAt?: number;
  sigB64?: string;
}

export interface ByteDuplex {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Ports (hexagonal seams — implementations are Sprint-3 work)
// ---------------------------------------------------------------------------

export interface NetworkProviderPort {
  /** Certhash dial → fallback ladder. Must be called from page context first
   *  on Chromium ≥142 when dialing a LAN address (LNA prompt — v006 §3.8). */
  connect(boot: RoomBootstrap): Promise<void>;
  disconnect(): Promise<void>;
  mode(): TransportMode;
  durability(): DurabilityState;
  stats(): NetworkStats;
  /** Fire-and-forget movement tick — datagram lane, never awareness. */
  sendTick(buf: Uint8Array): void;
  onTick(handler: (buf: Uint8Array) => void): void;
  /** Reliable framed sub-channel for a given envelope kind. */
  openChannel(kind: Exclude<EnvelopeKind, 'tick' | 'ping' | 'pong'>): Promise<ByteDuplex>;
}

/** Append-only social-log port — p2panda-shaped, SsfLog-compatible (v006 §5.4). */
export interface RoomLogPort {
  append(kind: string, body: Uint8Array): Promise<OpId>;
  subscribe(from?: SealRef): AsyncIterable<RoomLogOp>;
  moderation(): ModerationView;
  sealHead(): Promise<SealRef | undefined>;
}

export type OpId = string; // BLAKE3 hex of the op header

export interface RoomLogOp {
  id: OpId;
  writer: Uint8Array;       // Ed25519 public key
  seq: number;
  kind: string;             // chat | board-post | mod-flag | report | …
  body: Uint8Array;
  timestampTick: number;    // simulation tick, not wall clock (v006 §8.3)
}

export interface SealRef {
  epoch: number;
  frontierHashB64: string;
}

export interface ModerationView {
  mute(writer: Uint8Array): void;
  unmute(writer: Uint8Array): void;
  isMuted(writer: Uint8Array): boolean;
}

/** Chat storage seam — Phase 1 ships 'yjs-demo' (session-capped); RoomLog
 *  swaps in behind this interface without UI changes (v006 §8.4). */
export interface ChatProvider {
  readonly backend: 'yjs-demo' | 'roomlog';
  send(text: string): Promise<void>;
  onMessage(handler: (msg: ChatMessage) => void): void;
  history(limit?: number): ChatMessage[];
}

export interface ChatMessage {
  authorName: string;
  text: string;
  atTick: number;
  scope: 'global' | 'proximity';
}

// ---------------------------------------------------------------------------
// Movement tick codec — the 13-byte hand-packed DataView from the Phase 1 plan
// (Task 3.2 / 3.4: no JSON, no MessagePack on the hot path).
// Layout (little-endian) — adjustable in Sprint 3, budget is fixed at 13 bytes:
//   [0]      u8   flags (bit0: moving, bit1: seated [#63], rest reserved)
//   [1..5)   f32  x
//   [5..9)   f32  z
//   [9..11)  u16  yaw    (radians × 10430.378 → 0..65535 wraps 2π)
//   [11..13) u16  seq    (wrapping per-sender tick counter)
// ---------------------------------------------------------------------------

export const TICK_BYTES = 13;
const YAW_SCALE = 65535 / (2 * Math.PI);

export interface MovementTick {
  flags: number;
  x: number;
  z: number;
  yaw: number;   // radians, [0, 2π)
  seq: number;
}

export function packTick(t: MovementTick, out?: Uint8Array): Uint8Array {
  const buf = out ?? new Uint8Array(TICK_BYTES);
  const dv = new DataView(buf.buffer, buf.byteOffset, TICK_BYTES);
  dv.setUint8(0, t.flags & 0xff);
  dv.setFloat32(1, t.x, true);
  dv.setFloat32(5, t.z, true);
  dv.setUint16(9, Math.round(((t.yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) * YAW_SCALE) & 0xffff, true);
  dv.setUint16(11, t.seq & 0xffff, true);
  return buf;
}

export function unpackTick(buf: Uint8Array): MovementTick {
  if (buf.byteLength < TICK_BYTES) {
    throw new RangeError(`movement tick must be ${TICK_BYTES} bytes, got ${buf.byteLength}`);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, TICK_BYTES);
  return {
    flags: dv.getUint8(0),
    x: dv.getFloat32(1, true),
    z: dv.getFloat32(5, true),
    yaw: dv.getUint16(9, true) / YAW_SCALE,
    seq: dv.getUint16(11, true),
  };
}

// ---------------------------------------------------------------------------
// Addressed movement tick — 0.23.0 wire, node→browser leg (issue #22).
//
// The browser still SENDS the bare 13-byte tick (it has no global identity);
// the local node knows who each lane belongs to and prefixes every tick it
// DELIVERS with an 8-byte sender lane id:
//   [0..8)   sender lane id — blake3(node id ‖ tab addr) truncated to 8 bytes
//   [8..21)  the 13-byte movement tick above
// Before this, receivers fabricated peer identity from the tick's own wrapping
// seq counter (`peer-${seq % 4}`), so every remote player aliased into the
// same four render slots and a 3rd joiner "captured" the 2nd player's avatar.
// ---------------------------------------------------------------------------

export const SENDER_ID_BYTES = 8;
export const ADDRESSED_TICK_BYTES = SENDER_ID_BYTES + TICK_BYTES; // 21

export interface AddressedTick {
  /** Lowercase hex of the 8-byte sender lane id — stable per tab session. */
  senderId: string;
  tick: MovementTick;
}

export function unpackAddressedTick(buf: Uint8Array): AddressedTick {
  if (buf.byteLength < ADDRESSED_TICK_BYTES) {
    throw new RangeError(`addressed movement tick must be ${ADDRESSED_TICK_BYTES} bytes, got ${buf.byteLength}`);
  }
  let senderId = '';
  for (let i = 0; i < SENDER_ID_BYTES; i++) {
    senderId += buf[i].toString(16).padStart(2, '0');
  }
  return { senderId, tick: unpackTick(buf.subarray(SENDER_ID_BYTES)) };
}
