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
      this.#wt = new WebTransport(boot.wtUrl, {
        serverCertificateHashes: hashes
      });

      this.#isActive = true;
      this.#connectedAt = performance.now();
      await this.#wt.ready;
      
      console.log(`⚡ handshake accepted dynamically by yrs Tauri node!`);
      this.#mode = 'direct-unreliable'; // UDP WT active
      
      // 2. Start UDP Datagram reading loop (Task 3.2)
      this.#listenDatagrams();

      // 2b. Read NODE-INITIATED bidirectional streams (🐛 0.16.0 blocker fix):
      // the node forwards remote peers' envelopes (ysync/chat/bridge status) by
      // opening new bi-streams toward the browser — nothing ever read them, so
      // every remote update died at the local node and rooms looked empty.
      this.#listenIncomingStreams();

      // 3. Start RTT Ping/Pong probe loop (Task 3.4 / v006 §3.8 Chrome fallback)
      this.#startPingProbe();

    } catch (err: any) {
      console.error(`⚠️ WebTransport handshaking failed:`, err);
      this.#mode = 'offline';
      this.#isActive = false;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.#isActive = false;
    this.#mode = 'offline';
    this.#connectedAt = 0;
    this.#boot = null;
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
    if (!this.#wt || this.#mode === 'offline') return;
    this.#tickSent++;
    
    // Write raw 13-byte movement tick datagram instantly over UDP
    const writer = this.#wt.datagrams.writable.getWriter();
    writer.write(buf).catch((e: any) => {
      console.warn('Failed to send movement datagram tick:', e);
    });
    writer.releaseLock();
  }

  onTick(handler: (buf: Uint8Array) => void): void {
    this.#tickHandler = handler;
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
        
        // Handle incoming UDP datagrams
        if (value.length === 13) {
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

  async #startPingProbe() {
    while (this.#isActive) {
      if (this.#wt) {
        try {
          this.#pingSent++;
          this.#pingTime = performance.now();
          const pBytes = new TextEncoder().encode('ping');
          const writer = this.#wt.datagrams.writable.getWriter();
          await writer.write(pBytes);
          writer.releaseLock();
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
