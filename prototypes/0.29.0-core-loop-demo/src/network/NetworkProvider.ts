/**
 * NetworkProvider — transport port skeleton (Sprint 3 implements this).
 *
 * Primary adapter: raw WebTransport + serverCertificateHashes dial to a
 * player-run Tauri node (v006 §5.1 / Phase 1 Task 3.2). No simple-peer,
 * no signaling — the join string is URL + certhash (+ challenge).
 *
 * Sprint-3 acceptance criteria live in Phase1-ExecutionPlan Task 3.2.
 */
/**
 * NetworkProvider — WebTransport network adapter
 *
 * Implements raw WebTransport dialog with serverCertificateHashes pinning
 * to directly connect browsers to local player-run Tauri nodes (Task 3.2).
 */
import type {
  ByteDuplex,
  DurabilityState,
  EnvelopeKind,
  NetworkProviderPort,
  NetworkStats,
  RoomBootstrap,
  TransportMode,
} from './protocol.ts';
import { TICK_BYTES, ADDRESSED_TICK_BYTES } from './protocol.ts';

export interface NetworkDebugInfo {
  mode: TransportMode;
  isActive: boolean;
  pingSent: number;
  pongRecv: number;
  datagramsRecv: number;
  tickRecv: number;
  tickSent: number;
  openChannels: number;
  connectedForMs: number;
  endpointUrl: string;
}

export class NetworkProvider implements NetworkProviderPort {
  #mode: TransportMode = 'offline';
  #durability: DurabilityState = { replicas: 1, sealedEpoch: 0, pinned: false };
  #stats: NetworkStats = { rttMs: NaN, loss: NaN };
  
  #wt: any = null; // WebTransport instance
  /**
   * The ONE writer on the datagram lane, held for the life of the transport.
   * Movement ticks (every frame) and the RTT probe (every 2 s) both send
   * datagrams, and a WritableStream admits a single writer at a time. Taking
   * and releasing one per send let a tick land while the probe still held the
   * lock across its `await`: getWriter() threw straight out of main.ts's
   * animate() — which calls sendTick BEFORE renderer.render — so that frame was
   * never drawn and the tick was lost. write() calls on one writer just queue,
   * in order, so sharing it needs no coordination at all.
   */
  #datagramWriter: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #tickHandler: ((buf: Uint8Array) => void) | null = null;
  #envelopeHandler: ((env: any) => void) | null = null;
  #isActive = false;

  #pingSent = 0;
  #pongRecv = 0;
  #pingTime = 0;
  #datagramsRecv = 0;
  #tickRecv = 0;
  #tickSent = 0;
  #openChannels = 0;
  #connectedAt = 0;
  #boot: RoomBootstrap | null = null;

  async connect(boot: RoomBootstrap): Promise<void> {
    if (this.#isActive) {
      return;
    }

    console.log(`🔌 Securing connection link to sovereign node: ${boot.wtUrl}`);

    // THIS dial's transport. Everything below that must not outlive the dial —
    // the failure path, the probe loop — is tied to its identity, because
    // `this.#wt` can be replaced while we are still awaiting the handshake.
    let wt: any = null;
    try {
      // Convert base64 cert hashes to Uint8Array as required by WebTransport API
      const hashes = boot.certHashesB64.map(b64 => ({
        algorithm: 'sha-256',
        value: Uint8Array.from(atob(b64), c => c.charCodeAt(0))
      }));

      this.#boot = boot;
      this.#pingSent = 0;
      this.#pongRecv = 0;
      this.#datagramsRecv = 0;
      this.#tickRecv = 0;
      this.#tickSent = 0;
      this.#openChannels = 0;
      // 1. Establish WebTransport (Chrome LNA prompt must be mainthread-bounded)
      // @ts-ignore
      wt = new WebTransport(boot.wtUrl, {
        serverCertificateHashes: hashes
      });
      this.#wt = wt;

      this.#isActive = true;
      this.#connectedAt = performance.now();
      await wt.ready;
      
      console.log(`⚡ handshake accepted dynamically by yrs Tauri node!`);
      this.#mode = 'direct-unreliable'; // UDP WT active

      // The datagram lane's single writer (see #datagramWriter) — taken once,
      // here, before anything can want to send.
      this.#datagramWriter = wt.datagrams.writable.getWriter();
      
      // 2. Start UDP Datagram reading loop (Task 3.2)
      this.#listenDatagrams();

      // 2b. Read NODE-INITIATED bidirectional streams (🐛 0.16.0 blocker fix):
      // the node forwards remote peers' envelopes (ysync/chat/bridge status) by
      // opening new bi-streams toward the browser — nothing ever read them, so
      // every remote update died at the local node and rooms looked empty.
      this.#listenIncomingStreams();

      // 3. Start RTT Ping/Pong probe loop (Task 3.4 / v006 §3.8 Chrome fallback)
      this.#startPingProbe(wt);

      // 4. ChiaHub Slice 3: hand our LOCAL node this room's key + per-room
      // chia-mode flag over a one-shot `cap` stream, so it can derive the room's
      // chia lookup hint and (later) publish/resolve presence. Loopback only; the
      // node drops it entirely unless it was built with the chia-lane feature AND
      // SSF_CHIA_LANE=1. The chia-mode flag is the "advanced chia mesh mode"
      // toggle — sourced from localStorage until the management-computer UI sets it.
      if (boot.roomKeyB64) {
        let chiaMode = false;
        try { chiaMode = localStorage.getItem(`ssf-chia-mode-${boot.roomId}`) === '1'; } catch { /* privacy mode */ }
        void this.sendRoomCap(boot.roomId, boot.roomKeyB64, chiaMode);
      }

    } catch (err: any) {
      console.error(`⚠️ WebTransport handshaking failed:`, err);
      // Only the dial that still OWNS the session may take it offline. A dial
      // abandoned by disconnect() rejects here later (its transport was closed
      // under it) — possibly after a NEWER connect() has come up on this same
      // provider, and resetting the shared state then would silently mute that
      // live session (sendTick no-ops while the mode reads offline).
      if (this.#wt === wt) {
        this.#mode = 'offline';
        this.#isActive = false;
        this.#datagramWriter = null;
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.#isActive = false;
    this.#mode = 'offline';
    this.#connectedAt = 0;
    this.#boot = null;
    // Forget the writer FIRST: a tick sent from here on is a silent no-op, and
    // a write still in flight knows its rejection is expected (see sendTick).
    this.#datagramWriter = null;
    if (this.#wt) {
      try {
        this.#wt.close();
      } catch {}
      this.#wt = null;
    }
  }

  getBootRecord(): RoomBootstrap | null {
    return this.#boot;
  }

  mode(): TransportMode {
    return this.#mode;
  }

  durability(): DurabilityState {
    return this.#durability;
  }

  stats(): NetworkStats {
    return this.#stats;
  }

  sendTick(buf: Uint8Array): void {
    const writer = this.#datagramWriter;
    if (!writer || this.#mode === 'offline') return;
    this.#tickSent++;

    // Write the raw 13-byte movement tick datagram over UDP. Fire-and-forget —
    // this runs inside the render loop, so it is never awaited and must never
    // throw. A rejection that arrives after the transport has gone (disconnect,
    // room swap) is expected rather than news, so it is not logged.
    writer.write(buf).catch((e: any) => {
      if (this.#datagramWriter === writer) {
        console.warn('Failed to send movement datagram tick:', e);
      }
    });
  }

  onTick(handler: (buf: Uint8Array) => void): void {
    this.#tickHandler = handler;
  }

  /** ChiaHub Slice 3: deliver this room's key (+ per-room chia-mode flag) to the
   *  LOCAL node over a one-shot `cap` stream. The node needs the room key to
   *  derive the room's chia lookup hint and seal presence records; it holds the
   *  room's plaintext doc already, so this is loopback-only and exposes nothing
   *  new. Fire-and-forget: the node silently drops it unless it was built with
   *  the chia-lane feature and SSF_CHIA_LANE=1. Same `[u32-LE len][JSON]` framing
   *  the node reads on every browser->node stream. */
  async sendRoomCap(roomId: string, roomKeyB64: string, chiaMode: boolean): Promise<void> {
    if (!this.#wt || this.#mode === 'offline') return;
    try {
      const payloadBytes = new TextEncoder().encode(JSON.stringify({ roomKeyB64, chiaMode }));
      // Small payload (<128 B) — a single btoa is safe. Node decodes with
      // BASE64_STANDARD, which btoa produces.
      const payloadB64 = btoa(String.fromCharCode(...payloadBytes));
      const wire = { v: 1, room: roomId, kind: 'cap', seq: 0, author: '', payload: payloadB64 };
      const jsonBytes = new TextEncoder().encode(JSON.stringify(wire));
      const packet = new Uint8Array(4 + jsonBytes.length);
      new DataView(packet.buffer).setUint32(0, jsonBytes.length, true);
      packet.set(jsonBytes, 4);
      const stream = await this.#wt.createBidirectionalStream();
      const writer = stream.writable.getWriter();
      await writer.write(packet);
      writer.releaseLock();
    } catch (e) {
      console.warn('Failed to send room cap to node:', e);
    }
  }

  /** Re-send the current room's cap with a new chia-mode flag, reusing the boot
   *  this session connected with (so the room key matches exactly). Called by the
   *  management-computer toggle so the change takes effect without a reconnect. */
  async resendRoomCap(chiaMode: boolean): Promise<void> {
    const boot = this.#boot;
    if (boot?.roomKeyB64) {
      await this.sendRoomCap(boot.roomId, boot.roomKeyB64, chiaMode);
    }
  }

  /** Register a handler for envelopes arriving on node-initiated streams
   *  (remote peers' ysync updates, bridge dial-status, future chat lanes). */
  onEnvelope(handler: (env: any) => void): void {
    this.#envelopeHandler = handler;
  }

  /** Accept and drain every bidirectional stream the NODE opens toward us.
   *  Each stream carries u32-LE length-framed JSON SsfEnvelopes (same wire
   *  format as browser→node streams). */
  async #listenIncomingStreams(): Promise<void> {
    if (!this.#wt) return;
    try {
      const reader = this.#wt.incomingBidirectionalStreams.getReader();
      while (this.#isActive) {
        const { value: stream, done } = await reader.read();
        if (done) break;
        this.#openChannels++;
        void this.#drainNodeStream(stream);
      }
    } catch (e) {
      if (this.#isActive) {
        console.warn('Incoming-stream acceptor stopped:', e);
      }
    }
  }

  async #drainNodeStream(stream: { readable: ReadableStream<Uint8Array> }): Promise<void> {
    const reader = stream.readable.getReader();
    let buffer = new Uint8Array(0);
    try {
      while (this.#isActive) {
        const { value, done } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(buffer.length + value.length);
        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;

        while (buffer.length >= 4) {
          const dv = new DataView(buffer.buffer, buffer.byteOffset, 4);
          const len = dv.getUint32(0, true);
          if (buffer.length < 4 + len) break;
          const payloadBytes = buffer.subarray(4, 4 + len);
          buffer = buffer.subarray(4 + len);
          try {
            const envelope = JSON.parse(new TextDecoder().decode(payloadBytes));
            this.#envelopeHandler?.(envelope);
          } catch (e) {
            console.warn('Failed to parse node-initiated envelope:', e);
          }
        }
      }
    } catch (e) {
      if (this.#isActive) {
        console.warn('Node-stream reader ended:', e);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* stream already dead */ }
    }
  }

  async openChannel(_kind: Exclude<EnvelopeKind, 'tick' | 'ping' | 'pong'>): Promise<ByteDuplex> {
    if (!this.#wt) {
      throw new Error('Not connected');
    }
    // Open connection bidirectional stream for ysync / awareness / chat
    const stream = await this.#wt.createBidirectionalStream();
    this.#openChannels++;
    
    const self = this;
    const framedReadable = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = stream.readable.getReader();
        try {
          while (self.#isActive) {
            const { value, done } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (e) {
          controller.error(e);
        } finally {
          reader.releaseLock();
        }
      }
    });

    const framedWritable = new WritableStream<Uint8Array>({
      async write(chunk) {
        const writer = stream.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
      },
      async close() {
        await stream.writable.close();
      }
    });

    return {
      readable: framedReadable,
      writable: framedWritable,
    };
  }

  async #listenDatagrams() {
    const reader = this.#wt.datagrams.readable.getReader();
    try {
      while (this.#isActive) {
        const { value, done } = await reader.read();
        if (done) break;
        this.#datagramsRecv++;
        
        // Handle incoming UDP datagrams.
        // 0.23.0 wire (issue #22): node-delivered ticks are 21 B
        // ([8B sender lane id][13B tick]); bare 13 B ticks still arrive from
        // pre-0.23.0 nodes / the embedded fallback listener.
        if (value.length === ADDRESSED_TICK_BYTES || value.length === TICK_BYTES) {
          this.#tickRecv++;
          // Task 3.2: Forward remote player position ticks
          if (this.#tickHandler) {
            this.#tickHandler(value);
          }
        } else if (value.length === 4 && new TextDecoder().decode(value) === 'pong') {
          // Tick RTT stats response (Task 3.4)
          this.#pongRecv++;
          const rtt = performance.now() - this.#pingTime;
          this.#stats = {
            rttMs: rtt,
            loss: Math.max(0, 1 - this.#pongRecv / this.#pingSent)
          };
        }
      }
    } catch (e) {
      console.warn('Error reading UDP datagrams:', e);
    } finally {
      reader.releaseLock();
    }
  }

  /** `wt` is the transport this loop belongs to: it ends with that transport,
   *  so a quick disconnect → connect cannot leave the previous session's loop
   *  alive and probing (and double-counting) on the new one. */
  async #startPingProbe(wt: unknown) {
    while (this.#isActive && this.#wt === wt) {
      const writer = this.#datagramWriter;
      if (writer) {
        try {
          this.#pingSent++;
          this.#pingTime = performance.now();
          // The shared writer: no lock is taken per send, so awaiting this
          // write can no longer shut a movement tick out (see #datagramWriter).
          await writer.write(new TextEncoder().encode('ping'));
        } catch {}
      }
      // Issue RTT probe once every 2 seconds
      await new Promise(res => setTimeout(res, 2000));
    }
  }

  debugInfo(): NetworkDebugInfo {
    return {
      mode: this.#mode,
      isActive: this.#isActive,
      pingSent: this.#pingSent,
      pongRecv: this.#pongRecv,
      datagramsRecv: this.#datagramsRecv,
      tickRecv: this.#tickRecv,
      tickSent: this.#tickSent,
      openChannels: this.#openChannels,
      connectedForMs: this.#connectedAt > 0 ? performance.now() - this.#connectedAt : 0,
      endpointUrl: this.#boot?.wtUrl ?? '--',
    };
  }
}
