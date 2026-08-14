/**
 * YjsSync — room-state sync skeleton (Sprint 3–4 implements this).
 *
 * Rules this class enforces (v006 §8.1/§8.4, Phase 1 Task 3.3):
 *  - State-vector re-handshake: SyncStep1 both ways on EVERY (re)connect —
 *    never blind incremental streaming (the node's yrs host answers SyncStep2).
 *  - Awareness = DISCRETE presence only (join/leave, name, typing/speaking).
 *    Positions ride NetworkProvider.sendTick(), never Awareness, never the doc.
 *  - Signed-delta seam: every state-mutating message goes out in an
 *    SsfEnvelope with sig; the node verifies BEFORE applying (v005 §12.4).
 *  - Chat is session-capped demo storage behind ChatProvider ('yjs-demo').
 */
/**
 * YjsSync — room-state sync (Sprint 3 implements this).
 *
 * Rules this class enforces (v006 §8.1/§8.4, Phase 1 Task 3.3):
 *  - State-vector re-handshake: SyncStep1 both ways on EVERY (re)connect —
 *    never blind incremental streaming (the node's yrs host answers SyncStep2).
 *  - Awareness = DISCRETE presence only (join/leave, name, typing/speaking).
 *    Positions ride NetworkProvider.sendTick(), never Awareness, never the doc.
 *  - Signed-delta seam: every state-mutating message goes out in an
 *    SsfEnvelope with sig; the node verifies BEFORE applying (v005 §12.4).
 *  - Chat is session-capped demo storage behind ChatProvider ('yjs-demo').
 */
import * as Y from 'yjs';
import type { ByteDuplex } from './protocol.ts';
import { canonicalSignBytes } from './signBytes';

export interface YjsSyncOptions {
  roomId: string;
  /** Reliable 'ysync' channel from NetworkProvider.openChannel(). */
  channel: ByteDuplex;
  /** Signs the CANONICAL envelope bytes (v‖roomId‖kind‖seq‖payload, see
   *  signBytes.ts) for an outgoing state-mutating envelope — Slice 2. Returns
   *  the raw Ed25519 signature; YjsSync base64s it onto the wire. */
  sign?: (canonicalBytes: Uint8Array) => Promise<Uint8Array>;
  /** Our raw 32-byte identity pubkey, stamped as the envelope author (Slice 2 —
   *  replaces the Phase-1 dummy zero key). Omit to keep the legacy dummy. */
  authorPub?: () => Uint8Array;
  /** Verify-before-apply (Slice 2): checks a raw signature over the canonical
   *  bytes against the author. When present, an inbound envelope that IS signed
   *  but fails verification is DROPPED before it touches the Y.Doc; an UNSIGNED
   *  envelope (legacy client / the local node's own SyncStep2) is still applied. */
  verify?: (authorBytes: Uint8Array, canonicalBytes: Uint8Array, sigBytes: Uint8Array) => boolean;
  /**
   * Source of the iroh dial hints stamped on outgoing envelopes so the node
   * dials THIS room's host. Defaults to the global active provider's boot —
   * correct for the main session. A BACKGROUND prefetch (issue #60 staged
   * room-list) MUST pass its own provider's boot here, or its envelopes carry
   * the active room's hints and the node dials the wrong peer (the prefetch
   * room then never syncs).
   */
  bootRecord?: () => { memberHints?: unknown; irohNodeId?: unknown; irohRelayUrls?: unknown; irohDirectAddrs?: unknown } | null | undefined;
}

function u8ToB64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToU8(b64: string): Uint8Array {
  const binaryString = atob(b64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/** Constant-length byte equality (both are 32-byte pubkeys in practice). */
function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class YjsSync {
  readonly doc: Y.Doc;
  /**
   * Resolves once the node's INITIAL state response (the first SyncStep2) has
   * been applied — i.e. this replica has converged with whatever the node
   * holds for the room. Distinct from start() (which only SENDS SyncStep1):
   * callers that must not act on the empty pre-sync replica await this. Used
   * by the E4 furniture seed so it never re-publishes defaults over a room
   * that already has a synced layout (issue #60 review). Never rejects; if the
   * node never answers it simply never resolves (callers gate side effects on
   * it, so "no sync" degrades to "no action", which is safe).
   */
  readonly whenServerSynced: Promise<void>;
  #resolveServerSynced!: () => void;
  #serverSynced = false;
  #active = false;

  /** 🛰️ Resolves once the doc has applied a frame (SyncStep2 OR Update) from
   *  the LINKED HOST — correlated by a VERIFIED signature, not timing, not a
   *  bare author field. The plain `whenServerSynced` fires on the FIRST
   *  SyncStep2, which commonly lands before the P2P host dial and carries an
   *  empty replica. Worse, the post-link `resync()` is ALSO answered by the
   *  local node from its own (still possibly empty) replica. The node's frame
   *  is UNSIGNED (it holds no identity key); the host browser SIGNS every frame
   *  it emits (YjsSync.#emitEnvelope). So this gate opens only on a post-link
   *  frame whose signature cryptographically verified against a non-self author
   *  — proof the bytes came from the host's live replica, not the node's, and
   *  not a forgery carrying an unsigned nonzero author. Update frames count too:
   *  a node-served room's host pushes its state as a signed Update. Never
   *  rejects; if no verified host frame arrives (ownerless room / solo station)
   *  the caller's timeout is the fallback, which is safe. */
  readonly whenLinkedSynced: Promise<void>;
  #resolveLinkedSynced!: () => void;
  #linkedSynced = false;
  #peerLinked = false;

  /** True once the node's initial SyncStep2 has applied (the promise above,
   *  as a synchronous probe — Tier A's backfill logic reads it). */
  get serverSynced(): boolean {
    return this.#serverSynced;
  }

  /** True once a VERIFIED host frame (SyncStep2 or Update) has applied — the
   *  synchronous probe form of `whenLinkedSynced`. */
  get linkedSynced(): boolean {
    return this.#linkedSynced;
  }

  /** Record that the P2P bridge to the room host has linked (called from the
   *  bridge `connected` handler, alongside `resync()`). From this point we watch
   *  for the host's OWN SyncStep2 — a SIGNED one — to open the readiness gate.
   *  The local node answers every SyncStep1 from its own (possibly empty)
   *  replica with an UNSIGNED frame, so an unsigned SyncStep2 is never enough. */
  markPeerLinked(): void {
    this.#peerLinked = true;
  }
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #seq = 1;

  constructor(private readonly opts: YjsSyncOptions) {
    this.doc = new Y.Doc();
    this.whenServerSynced = new Promise<void>((resolve) => {
      this.#resolveServerSynced = resolve;
    });
    this.whenLinkedSynced = new Promise<void>((resolve) => {
      this.#resolveLinkedSynced = resolve;
    });
  }

  /** Kick off the y-sync state machine over the reliable channel:
   *  write SyncStep1(doc state vector), answer inbound SyncStep1/2/Update. */
  async start(): Promise<void> {
    if (this.#active) return;
    this.#active = true;

    this.#writer = this.opts.channel.writable.getWriter();

    // 1. Send initial SyncStep1 state vector (Task 3.3)
    this.#sendSyncStep1();

    // 2. Start reactive ydoc mutation update pipeline (Task 3.3)
    this.doc.on('update', (update, origin) => {
      if (origin === 'server-origin') return; // avoid infinite loop
      this.#sendUpdateMessage(update);
    });

    // 3. Start reader loop in background
    this.#readIncoming();
  }

  /** Re-issue the opening SyncStep1 handshake AFTER start(). The initial
   *  SyncStep1 (start(), step 1) is a one-shot: it fires the instant the local
   *  WebTransport is up, which is BEFORE the node's P2P dial to the room host
   *  finishes. At that moment the node's neighbor set is empty, so the frame is
   *  relayed to nobody and the host never answers with SyncStep2. The host's
   *  room state (roster, roomInfo.name, furniture) is STATIC — it only ships in
   *  reply to a SyncStep1 — so it never transfers, while the continuous tick
   *  lane (movement) still flows. Re-issuing SyncStep1 once the node reports a
   *  peer LINKED (bridge `connected`) reaches the now-present host and pulls its
   *  full state. Safe to call repeatedly: a SyncStep1 is idempotent. */
  resync(): void {
    if (!this.#active || !this.#writer) return;
    void this.#sendSyncStep1();
  }

  async stop(): Promise<void> {
    this.#active = false;
    if (this.#writer) {
      try {
        await this.#writer.close();
      } catch {}
    }
    this.doc.destroy();
  }

  /** Feed an envelope that arrived on a NODE-INITIATED stream (remote peers'
   *  updates bridged through the local node) into the y-sync state machine.
   *  0.16.0 dead-ended these — see NetworkProvider.#listenIncomingStreams. */
  ingestEnvelope(wireEnvelope: { v?: number; kind?: string; room?: string; seq?: number; author?: string; payload?: string; sig?: string }): void {
    if (!this.#active) return;
    if (wireEnvelope.kind !== 'ysync' || typeof wireEnvelope.payload !== 'string') return;
    if (wireEnvelope.room && wireEnvelope.room !== this.opts.roomId) return;
    const ver = this.#verifyEnvelope(wireEnvelope);
    if (ver === null) return; // Slice 2: drop signed-but-invalid
    try {
      this.#processInboundYsync(
        b64ToU8(wireEnvelope.payload),
        this.#envelopeAuthor(wireEnvelope),
        ver.verified,
      );
    } catch (e) {
      console.warn('YjsSync failed ingesting bridged envelope:', e);
    }
  }

  /** Slice 2 verify-before-apply. Returns NULL when the envelope must be
   *  DROPPED (a signed envelope whose signature fails); otherwise a
   *  `verified` flag: true only when a real signature was cryptographically
   *  checked against its author — the caller may then TRUST that author as a
   *  host identity. An unsigned/legacy/local-node envelope is allowed through
   *  but `verified` is FALSE, so a forged nonzero author with a MISSING sig can
   *  never be mistaken for the host (PR #108 review). */
  #verifyEnvelope(env: { v?: number; kind?: string; seq?: number; author?: string; payload?: string; sig?: string }): { verified: boolean } | null {
    if (!this.opts.verify) return { verified: false }; // legacy/prefetch: applied, never trusted as host
    if (typeof env.sig !== 'string' || typeof env.author !== 'string' || typeof env.payload !== 'string') return { verified: false }; // unsigned → allow, but not host-proof
    let authorBytes: Uint8Array;
    try { authorBytes = b64ToU8(env.author); } catch { return { verified: false }; }
    // A 32-byte all-zero author is the Phase-1 dummy → treat as unsigned/legacy.
    if (authorBytes.length !== 32 || authorBytes.every((b) => b === 0)) return { verified: false };
    try {
      const payload = b64ToU8(env.payload);
      const canonical = canonicalSignBytes(env.v ?? 1, this.opts.roomId, env.kind ?? 'ysync', env.seq ?? 0, payload);
      const ok = this.opts.verify(authorBytes, canonical, b64ToU8(env.sig));
      if (!ok) console.warn(`[YjsSync] dropped envelope with INVALID signature (room ${this.opts.roomId}, seq ${env.seq})`);
      return ok ? { verified: true } : null; // signed+valid ⇒ trusted author; signed+invalid ⇒ drop
    } catch (e) {
      console.warn('[YjsSync] verify error, dropping envelope:', e);
      return null;
    }
  }

  async #sendSyncStep1() {
    if (!this.#writer) return;

    // Build standard Yjs SyncStep1 binary message
    // messageType (0 = Sync), syncSubtype (0 = SyncStep1), then state vector bytes
    const sv = Y.encodeStateVector(this.doc);

    // Simple y-sync format payload
    const payload = this.#packYSyncPayload(0, 0, sv);

    await this.#emitEnvelope('ysync', payload);
    console.log(`📤 YjsSync -> SyncStep1 state vector handshake dispatched over WebTransport`);

    // Half-handshake fix (two local tabs never synced): the node answers our
    // SyncStep1 from ITS replica but never sends its own SyncStep1 back, so
    // nothing ever asked US for our state — after a node restart its replica
    // stayed empty and every sibling tab's handshake got an empty diff
    // forever. Push our full state as a standard Update alongside the
    // handshake: the node merges it (idempotent CRDT), sibling tabs get it
    // via the node's local fan-out, and the mesh relay carries it outward —
    // which also re-arms the node's served replica (C2 durability) after a
    // restart. Skipped for an empty doc (a fresh guest has nothing to offer).
    const baseline = Y.encodeStateAsUpdate(this.doc);
    if (baseline.length > 2) {
      await this.#sendUpdateMessage(baseline);
      console.log(`📤 YjsSync -> baseline state pushed to the node replica (${baseline.length}B)`);
    }
  }

  async #sendUpdateMessage(update: Uint8Array) {
    if (!this.#writer) return;

    // messageType (0 = Sync), syncSubtype (2 = Update), then update bytes
    const payload = this.#packYSyncPayload(0, 2, update);

    await this.#emitEnvelope('ysync', payload);
  }

  async #emitEnvelope(_kind: string, payload: Uint8Array) {
    if (!this.#writer) return;

    // Carry iroh dial hints from THIS sync's bootstrap so the local node can
    // construct EndpointAddr with relay/direct hints for outbound dialing.
    // A background prefetch supplies its own room's boot via opts.bootRecord;
    // the main session omits it and falls back to the global active provider.
    let boot = this.opts.bootRecord?.();
    if (!boot) {
      const provider = (window as any).networkProvider as { getBootRecord?: () => any } | undefined;
      boot = provider?.getBootRecord?.();
    }

    const memberHints = Array.isArray(boot?.memberHints)
      ? boot.memberHints.filter((hint: any) => typeof hint?.irohNodeId === 'string' && hint.irohNodeId.length > 0)
      : [];
    const primaryHint = memberHints[0] ?? (boot?.irohNodeId
      ? {
          irohNodeId: boot.irohNodeId,
          irohRelayUrls: Array.isArray(boot.irohRelayUrls) ? boot.irohRelayUrls : undefined,
          irohDirectAddrs: Array.isArray(boot.irohDirectAddrs) ? boot.irohDirectAddrs : undefined,
        }
      : undefined);

    // Slice 2: capture seq BEFORE signing so the canonical bytes and the wire
    // envelope agree; sign the canonical v‖room‖kind‖seq‖payload (not payload
    // alone) and stamp our REAL pubkey author.
    const v = 1;
    const seq = this.#seq++;
    let sigStr: string | undefined = undefined;
    if (this.opts.sign) {
      const canonical = canonicalSignBytes(v, this.opts.roomId, 'ysync', seq, payload);
      const sigData = await this.opts.sign(canonical);
      sigStr = u8ToB64(sigData);
    }
    const authorBytes = this.opts.authorPub?.() ?? new Uint8Array(32); // dummy if unwired

    const wireEnvelope: Record<string, unknown> = {
      v,
      room: this.opts.roomId,
      kind: 'ysync',
      seq,
      author: u8ToB64(authorBytes),
      payload: u8ToB64(payload),
      sig: sigStr,
      iroh_node_id: primaryHint?.irohNodeId,
      iroh_relay_urls: primaryHint?.irohRelayUrls,
      iroh_direct_addrs: primaryHint?.irohDirectAddrs,
    };
    // M4: carry the FULL roster's dial hints (was primaryHint / memberHints[0]
    // only, a single point of dial failure) so the node bootstrap-dials EVERY
    // reachable member — any live one bootstraps us, then transitive gossip
    // meshes the rest.
    if (memberHints.length > 0) {
      wireEnvelope.iroh_member_hints = memberHints.map((h: any) => ({
        irohNodeId: h.irohNodeId,
        irohRelayUrls: Array.isArray(h.irohRelayUrls) ? h.irohRelayUrls : undefined,
        irohDirectAddrs: Array.isArray(h.irohDirectAddrs) ? h.irohDirectAddrs : undefined,
      }));
    }
    // M3: bootstrap dials are room co-members, so tag them ROOM tier (advisory
    // ordering — the node's hard gate is sig-Valid). Friend/direct tiers flow via
    // the DM dial path where the browser holds the identity↔node mapping.
    if (primaryHint) {
      wireEnvelope.trust_tier = 2;
    }

    const jsonBytes = new TextEncoder().encode(JSON.stringify(wireEnvelope));
    const lenBytes = new Uint8Array(4);
    const dv = new DataView(lenBytes.buffer);
    dv.setUint32(0, jsonBytes.byteLength, true);

    const packet = new Uint8Array(4 + jsonBytes.byteLength);
    packet.set(lenBytes, 0);
    packet.set(jsonBytes, 4);

    try {
      await this.#writer.write(packet);
    } catch (e) {
      console.warn('YjsSync failed to write envelope to WT stream:', e);
    }
  }

  #packYSyncPayload(type: number, subtype: number, data: Uint8Array): Uint8Array {
    // Basic VarInt encoder for type and subtype
    const writeVarUint = (val: number): number[] => {
      const buf: number[] = [];
      let num = val;
      while (num >= 0x80) {
        buf.push((num & 0x7f) | 0x80);
        num >>>= 7;
      }
      buf.push(num & 0x7f);
      return buf;
    };

    const typeBytes = writeVarUint(type);
    const subtypeBytes = writeVarUint(subtype);
    const lengthBytes = writeVarUint(data.length);

    const res = new Uint8Array(typeBytes.length + subtypeBytes.length + lengthBytes.length + data.length);
    let offset = 0;
    res.set(typeBytes, offset); offset += typeBytes.length;
    res.set(subtypeBytes, offset); offset += subtypeBytes.length;
    res.set(lengthBytes, offset); offset += lengthBytes.length;
    res.set(data, offset);
    return res;
  }

  async #readIncoming() {
    const reader = this.opts.channel.readable.getReader();
    let buffer = new Uint8Array(0);

    try {
      while (this.#active) {
        const { value, done } = await reader.read();
        if (done) break;

        // Append read chunk to local parser buffer
        const newBuf = new Uint8Array(buffer.length + value.length);
        newBuf.set(buffer, 0);
        newBuf.set(value, buffer.length);
        buffer = newBuf;

        // Parse u32 framed packets
        while (buffer.length >= 4) {
          const dv = new DataView(buffer.buffer, buffer.byteOffset, 4);
          const len = dv.getUint32(0, true);

          if (buffer.length < 4 + len) {
            break; // need more data
          }

          const payloadBytes = buffer.subarray(4, 4 + len);
          buffer = buffer.subarray(4 + len);

          // Decode SsfEnvelope from base64 representation on the wire safely
          const wireEnvelope = JSON.parse(new TextDecoder().decode(payloadBytes));

          if (wireEnvelope.kind === 'ysync') {
            const ver = this.#verifyEnvelope(wireEnvelope);
            if (ver !== null) {
              this.#processInboundYsync(
                b64ToU8(wireEnvelope.payload),
                this.#envelopeAuthor(wireEnvelope),
                ver.verified,
              );
            }
          }
        }
      }
    } catch (e) {
      console.warn('YjsSync reader loop error:', e);
    } finally {
      reader.releaseLock();
    }
  }

  /** Decode an envelope's author pubkey bytes, or null when absent/dummy —
   *  the local node holds no identity key, so ITS SyncStep2 always decodes to
   *  null here; the host browser's frames carry its real (signed) pubkey. */
  #envelopeAuthor(env: { author?: string }): Uint8Array | null {
    if (typeof env.author !== 'string') return null;
    let bytes: Uint8Array;
    try { bytes = b64ToU8(env.author); } catch { return null; }
    if (bytes.length !== 32 || bytes.every((b) => b === 0)) return null;
    return bytes;
  }

  #processInboundYsync(payload: Uint8Array, author: Uint8Array | null = null, verified = false) {
    let cursor = 0;

    const readVarUint = (): number => {
      let value = 0;
      let shift = 0;
      while (cursor < payload.length) {
        const byte = payload[cursor++];
        value |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) {
          break;
        }
        shift += 7;
      }
      return value;
    };

    const type = readVarUint();
    if (type !== 0) return; // not structured y-sync type

    const subtype = readVarUint();
    const len = readVarUint();
    const data = payload.subarray(cursor, cursor + len);

    if (subtype === 0) {
      // Received SyncStep1 (state vector). Generate SyncStep2 with missing diff blocks
      const ourUpdate = Y.encodeStateAsUpdate(this.doc, data);
      
      const responsePayload = this.#packYSyncPayload(0, 1, ourUpdate);
      this.#emitEnvelope('ysync', responsePayload);
      console.log(`📤 YjsSync -> SyncStep2 difference blocks sent to hrs Tauri node`);

    } else if (subtype === 1 || subtype === 2) {
      // Received SyncStep2 or Update
      Y.applyUpdate(this.doc, data, 'server-origin');
      // The first SyncStep2 (initial state) marks convergence with the node.
      if (subtype === 1 && !this.#serverSynced) {
        this.#serverSynced = true;
        this.#resolveServerSynced();
      }
      // 🛰️ The readiness gate opens only on a frame from the LINKED HOST —
      // correlated by a VERIFIED signature, not timing, not a bare author field.
      // The local node also answers the post-link resync() from its own
      // (possibly still-empty) replica, and its frame is UNSIGNED; a forged
      // envelope can carry a nonzero author with NO signature and pass the old
      // check. Requiring `verified` (a real signature that passed
      // #verifyEnvelope) proves the bytes came from the host's live replica.
      // Both SyncStep2 AND Update count: a node-served ownerless room may never
      // send a signed SyncStep2, but its host pushes the room state as a signed
      // Update — accepting either is what lets those rooms converge at all.
      const fromHost =
        verified &&
        author !== null &&
        !bytesEq(author, this.opts.authorPub?.() ?? new Uint8Array(32));
      if ((subtype === 1 || subtype === 2) && this.#peerLinked && fromHost && !this.#linkedSynced) {
        this.#linkedSynced = true;
        this.#resolveLinkedSynced();
      }
      console.log(`✅ YjsSync Handshake Complete for Y.Doc room replica!`);
    }
  }
}
