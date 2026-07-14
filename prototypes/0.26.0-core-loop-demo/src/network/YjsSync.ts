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

export interface YjsSyncOptions {
  roomId: string;
  /** Reliable 'ysync' channel from NetworkProvider.openChannel(). */
  channel: ByteDuplex;
  /** Signs outgoing state-mutating envelopes (stubbed key mgmt is OK in Phase 1;
   *  the verify-before-apply seam must exist — Phase 1 Task 3.3). */
  sign?: (payload: Uint8Array) => Promise<Uint8Array>;
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

export class YjsSync {
  readonly doc: Y.Doc;
  #active = false;
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #seq = 1;

  constructor(private readonly opts: YjsSyncOptions) {
    this.doc = new Y.Doc();
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
  ingestEnvelope(wireEnvelope: { kind?: string; room?: string; payload?: string }): void {
    if (!this.#active) return;
    if (wireEnvelope.kind !== 'ysync' || typeof wireEnvelope.payload !== 'string') return;
    if (wireEnvelope.room && wireEnvelope.room !== this.opts.roomId) return;
    try {
      this.#processInboundYsync(b64ToU8(wireEnvelope.payload));
    } catch (e) {
      console.warn('YjsSync failed ingesting bridged envelope:', e);
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
  }

  async #sendUpdateMessage(update: Uint8Array) {
    if (!this.#writer) return;

    // messageType (0 = Sync), syncSubtype (2 = Update), then update bytes
    const payload = this.#packYSyncPayload(0, 2, update);

    await this.#emitEnvelope('ysync', payload);
  }

  async #emitEnvelope(_kind: string, payload: Uint8Array) {
    if (!this.#writer) return;

    // Carry iroh dial hints from the active bootstrap ticket so the local node
    // can construct EndpointAddr with relay/direct hints for outbound dialing.
    const provider = (window as any).networkProvider as { getBootRecord?: () => any } | undefined;
    const boot = provider?.getBootRecord?.();

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

    let sigStr: string | undefined = undefined;
    if (this.opts.sign) {
      const sigData = await this.opts.sign(payload);
      sigStr = u8ToB64(sigData);
    }

    const wireEnvelope = {
      v: 1,
      room: this.opts.roomId,
      kind: 'ysync',
      seq: this.#seq++,
      author: u8ToB64(new Uint8Array(32)), // dummy key for Phase 1
      payload: u8ToB64(payload),
      sig: sigStr,
      iroh_node_id: primaryHint?.irohNodeId,
      iroh_relay_urls: primaryHint?.irohRelayUrls,
      iroh_direct_addrs: primaryHint?.irohDirectAddrs,
    };

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
            this.#processInboundYsync(b64ToU8(wireEnvelope.payload));
          }
        }
      }
    } catch (e) {
      console.warn('YjsSync reader loop error:', e);
    } finally {
      reader.releaseLock();
    }
  }

  #processInboundYsync(payload: Uint8Array) {
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
      console.log(`✅ YjsSync Handshake Complete for Y.Doc room replica!`);
    }
  }
}
